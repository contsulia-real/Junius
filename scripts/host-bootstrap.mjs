import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

const KEEP_RELEASES = 3;
const MAX_CHECK_OUTPUT_CHARS = 1024 * 1024;
const HEALTH_TIMEOUT_MS = 20_000;
const SNAPSHOT_RETRIES = 3;

const projectRoot = resolve(
  process.env.JUNIUS_PROJECT_ROOT ??
    process.cwd(),
);
const runtimeRoot = resolve(
  process.env.JUNIUS_RUNTIME_ROOT ??
    join(projectRoot, ".junius", "runtime"),
);
const releasesRoot = join(runtimeRoot, "releases");
const stagingRoot = join(runtimeRoot, "staging");
const currentPath = join(runtimeRoot, "current.json");
const sourceValidationPath = join(
  runtimeRoot,
  "source-validation.json",
);
const stableBootstrapRoot = join(
  runtimeRoot,
  "bootstrap",
);
const stableBootstrapPath = join(
  stableBootstrapRoot,
  "host-bootstrap.mjs",
);
const liveBootstrapPath = join(
  projectRoot,
  "scripts",
  "host-bootstrap.mjs",
);

let activeHost;

function appendBounded(current, chunk) {
  const next = current + chunk.toString();
  return next.length <= MAX_CHECK_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_CHECK_OUTPUT_CHARS);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root, relativeRoot = "") {
  const directory = join(root, relativeRoot);
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const relativePath = relativeRoot
      ? join(relativeRoot, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, relativePath));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

async function fingerprintSource(root) {
  const hash = createHash("sha256");
  const sources = [];

  for (const directory of ["src", "python"]) {
    if (!(await exists(join(root, directory)))) continue;

    const files = await walkFiles(join(root, directory));
    for (const file of files) {
      sources.push(join(directory, file));
    }
  }

  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    join("scripts", "host-bootstrap.mjs"),
    join("scripts", "host-launcher.mjs"),
    join("scripts", "source-validation.mjs"),
  ]) {
    if (await exists(join(root, file))) {
      sources.push(file);
    }
  }

  sources.sort((left, right) =>
    left.localeCompare(right, "en"),
  );

  for (const relativePath of sources) {
    const data = await readFile(join(root, relativePath));
    hash.update(relativePath.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(data);
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function copySnapshot(destination) {
  await mkdir(destination, { recursive: true });

  for (const directory of ["src", "python"]) {
    const source = join(projectRoot, directory);
    if (await exists(source)) {
      await cp(source, join(destination, directory), {
        recursive: true,
        force: true,
      });
    }
  }

  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    join("scripts", "host-bootstrap.mjs"),
    join("scripts", "host-launcher.mjs"),
    join("scripts", "source-validation.mjs"),
  ]) {
    const source = join(projectRoot, file);
    if (await exists(source)) {
      const target = join(destination, file);
      await mkdir(dirname(target), {
        recursive: true,
      });
      await cp(source, target, {
        force: true,
      });
    }
  }

  const projectNodeModules = join(
    projectRoot,
    "node_modules",
  );

  if (await exists(projectNodeModules)) {
    await symlink(
      projectNodeModules,
      join(destination, "node_modules"),
      process.platform === "win32"
        ? "junction"
        : "dir",
    );
  }
}

function environmentPath(environment) {
  return (
    environment.PATH ??
    environment.Path ??
    environment.path ??
    ""
  );
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function targetFromWindowsCmdShim(shimPath) {
  if (
    process.platform !== "win32" ||
    extname(shimPath).toLowerCase() !== ".cmd"
  ) {
    return undefined;
  }

  try {
    const text = await readFile(shimPath, "utf8");
    const match = text.match(
      /["']?([^"'\r\n]*npm-cli\.js)["']?/iu,
    );

    if (match?.[1] === undefined) {
      return undefined;
    }

    const expanded = match[1]
      .replaceAll("%dp0%", dirname(shimPath) + "\\")
      .replaceAll("%~dp0", dirname(shimPath) + "\\");

    return isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(dirname(shimPath), expanded);
  } catch {
    return undefined;
  }
}

async function isPortableExecutable(path) {
  try {
    const data = await readFile(path);
    return (
      data.byteLength >= 2 &&
      data[0] === 0x4d &&
      data[1] === 0x5a
    );
  } catch {
    return false;
  }
}

async function launcherForPackageManagerCandidate(candidate) {
  const extension = extname(candidate).toLowerCase();

  if (
    extension === ".exe" ||
    await isPortableExecutable(candidate)
  ) {
    return {
      executable: candidate,
      fixedArgs: [],
    };
  }

  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return {
      executable: process.execPath,
      fixedArgs: [candidate],
    };
  }

  return undefined;
}

async function npmInvocation() {
  const candidates = [];

  if (
    typeof process.env.npm_execpath === "string" &&
    /npm-cli\.js$/iu.test(process.env.npm_execpath)
  ) {
    candidates.push(process.env.npm_execpath);
  }

  candidates.push(
    join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  );

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return {
        executable: process.execPath,
        fixedArgs: [candidate],
      };
    }
  }

  const names =
    process.platform === "win32"
      ? [
          "npm.exe",
          "npm",
          "npm.cmd",
          "npm-cli.js",
        ]
      : [
          "npm",
          "npm-cli.js",
        ];

  for (const rawEntry of environmentPath(process.env).split(delimiter)) {
    const entry = rawEntry
      .trim()
      .replace(/^"(.*)"$/u, "$1");

    if (!entry) continue;

    for (const name of names) {
      const candidate = join(entry, name);

      if (!(await fileExists(candidate))) {
        continue;
      }

      const direct =
        await launcherForPackageManagerCandidate(candidate);
      if (direct !== undefined) {
        return direct;
      }

      const shimTarget =
        await targetFromWindowsCmdShim(candidate);

      if (
        shimTarget !== undefined &&
        await fileExists(shimTarget)
      ) {
        const shimLauncher =
          await launcherForPackageManagerCandidate(shimTarget);

        if (shimLauncher !== undefined) {
          return shimLauncher;
        }
      }
    }
  }

  throw new Error(
    "bootstrap_npm_unavailable: npm was not found for the current Node installation.",
  );
}

async function runCheck() {
  const startedAt = performance.now();

  let launcher;
  try {
    launcher = await npmInvocation();
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: String(error),
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      launcher.executable,
      [...launcher.fixedArgs, "run", "check"],
      {
        cwd: projectRoot,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        ...result,
        stdout,
        stderr,
        durationMs: Math.round(
          performance.now() - startedAt,
        ),
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      stderr = appendBounded(stderr, String(error));
      finish({
        ok: false,
        exitCode: null,
        signal: null,
      });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        ok: exitCode === 0,
        exitCode,
        signal,
      });
    });
  });
}

async function readCurrentRelease() {
  try {
    const parsed = JSON.parse(
      await readFile(currentPath, "utf8"),
    );

    if (
      parsed?.version !== 1 ||
      typeof parsed.releaseId !== "string" ||
      typeof parsed.fingerprint !== "string"
    ) {
      return undefined;
    }

    const releaseRoot = join(
      releasesRoot,
      parsed.releaseId,
    );
    const hostPath = join(releaseRoot, "src", "host.ts");

    if (!(await exists(hostPath))) {
      return undefined;
    }

    return {
      releaseId: parsed.releaseId,
      fingerprint: parsed.fingerprint,
      createdAt:
        typeof parsed.createdAt === "string"
          ? parsed.createdAt
          : undefined,
      releaseRoot,
      hostPath,
    };
  } catch {
    return undefined;
  }
}

async function readReusableSourceValidation(
  fingerprint,
) {
  try {
    const parsed = JSON.parse(
      await readFile(sourceValidationPath, "utf8"),
    );

    if (
      parsed?.version !== 1 ||
      parsed.fingerprint !== fingerprint ||
      parsed.nodeVersion !== process.version ||
      parsed.platform !== process.platform ||
      parsed.arch !== process.arch ||
      typeof parsed.validatedAt !== "string"
    ) {
      return undefined;
    }

    return {
      validatedAt: parsed.validatedAt,
    };
  } catch {
    return undefined;
  }
}

async function promoteValidatedBootstrap() {
  await mkdir(stableBootstrapRoot, {
    recursive: true,
  });

  const temporaryPath =
    stableBootstrapPath +
    "." +
    randomUUID() +
    ".tmp";

  await cp(
    liveBootstrapPath,
    temporaryPath,
    { force: true },
  );
  await rename(
    temporaryPath,
    stableBootstrapPath,
  );
}

async function writeCurrentRelease(release) {
  await mkdir(runtimeRoot, { recursive: true });

  const temporaryPath =
    currentPath + "." + randomUUID() + ".tmp";

  await writeFile(
    temporaryPath,
    JSON.stringify(
      {
        version: 1,
        releaseId: release.releaseId,
        fingerprint: release.fingerprint,
        createdAt: release.createdAt,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await rename(temporaryPath, currentPath);
}

async function pruneReleases(currentReleaseId) {
  let entries;

  try {
    entries = await readdir(releasesRoot, {
      withFileTypes: true,
    });
  } catch {
    return;
  }

  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const path = join(releasesRoot, entry.name);

    try {
      candidates.push({
        id: entry.name,
        path,
        modifiedAt: (await stat(path)).mtimeMs,
      });
    } catch {
      // Ignore entries that disappeared concurrently.
    }
  }

  candidates.sort(
    (left, right) => right.modifiedAt - left.modifiedAt,
  );

  const keep = new Set(
    candidates
      .slice(0, KEEP_RELEASES)
      .map((entry) => entry.id),
  );
  keep.add(currentReleaseId);

  await Promise.allSettled(
    candidates
      .filter((entry) => !keep.has(entry.id))
      .map((entry) =>
        rm(entry.path, {
          recursive: true,
          force: true,
        }),
      ),
  );
}

async function prepareValidatedRelease(
  allowCachedValidation = true,
) {
  await mkdir(releasesRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  for (
    let attempt = 1;
    attempt <= SNAPSHOT_RETRIES;
    attempt += 1
  ) {
    const fingerprintBefore =
      await fingerprintSource(projectRoot);
    const stageRoot = join(
      stagingRoot,
      randomUUID(),
    );

    try {
      await copySnapshot(stageRoot);

      const stagedFingerprint =
        await fingerprintSource(stageRoot);

      if (stagedFingerprint !== fingerprintBefore) {
        console.error(
          "[bootstrap] source changed while snapshotting; retrying.",
        );
        continue;
      }

      const cachedValidation =
        allowCachedValidation
          ? await readReusableSourceValidation(
              fingerprintBefore,
            )
          : undefined;
      const check =
        cachedValidation === undefined
          ? await runCheck()
          : {
              ok: true,
              exitCode: 0,
              signal: null,
              stdout: "",
              stderr: "",
              durationMs: 0,
              cached: true,
            };

      if (cachedValidation !== undefined) {
        console.error(
          "[bootstrap] reusing full source validation " +
          `from ${cachedValidation.validatedAt}.`,
        );
      }

      if (!check.ok) {
        return {
          ok: false,
          reason:
            "source_check_failed: " +
            `exit=${String(check.exitCode)} signal=${String(check.signal)}`,
          check,
        };
      }

      const fingerprintAfter =
        await fingerprintSource(projectRoot);

      if (fingerprintAfter !== fingerprintBefore) {
        console.error(
          "[bootstrap] source changed during validation; retrying.",
        );
        continue;
      }

      const releaseId =
        `${Date.now()}-${fingerprintBefore.slice(0, 12)}`;
      const releaseRoot = join(
        releasesRoot,
        releaseId,
      );
      const createdAt = new Date().toISOString();

      await writeFile(
        join(stageRoot, ".release.json"),
        JSON.stringify(
          {
            version: 1,
            releaseId,
            fingerprint: fingerprintBefore,
            createdAt,
            checkDurationMs: check.durationMs,
            checkCached: check.cached === true,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await rename(stageRoot, releaseRoot);

      return {
        ok: true,
        release: {
          releaseId,
          fingerprint: fingerprintBefore,
          createdAt,
          releaseRoot,
          hostPath: join(
            releaseRoot,
            "src",
            "host.ts",
          ),
        },
        check,
      };
    } finally {
      await rm(stageRoot, {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }

  return {
    ok: false,
    reason:
      "source_changed_during_validation: retry limit reached",
  };
}

function spawnHost(release) {
  return spawn(
    process.execPath,
    ["--import", "tsx", release.hostPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        JUNIUS_PROJECT_ROOT: projectRoot,
        JUNIUS_RELEASE_ID: release.releaseId,
        JUNIUS_RELEASE_ROOT: release.releaseRoot,
      },
      stdio: "inherit",
      windowsHide: false,
    },
  );
}

async function waitForHostHealth(child, releaseId) {
  const port = Number(
    process.env.JUNIUS_CONTROL_PORT ?? "8788",
  );
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    if (
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw new Error(
        `host_exited_before_health: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
      );
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/__junius/host-health`,
      );

      if (response.ok) {
        const body = await response.json();

        if (
          body?.ok === true &&
          typeof body.activeWorkerId === "string" &&
          body.releaseId === releaseId
        ) {
          return;
        }
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, 100),
    );
  }

  throw new Error(
    "host_health_timeout: " + String(lastError ?? ""),
  );
}

async function stopChild(child) {
  if (
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }

  child.kill("SIGTERM");

  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 3_000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });

  if (
    child.exitCode === null &&
    child.signalCode === null
  ) {
    child.kill("SIGKILL");
  }
}

async function waitForChild(child) {
  if (
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    process.exitCode = child.exitCode ?? 0;
    return;
  }

  const result = await new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });

  process.exitCode = result.code ?? 0;
}

async function startRelease(release) {
  console.error(
    `[bootstrap] starting release ${release.releaseId}`,
  );

  const child = spawnHost(release);
  activeHost = child;

  await waitForHostHealth(
    child,
    release.releaseId,
  );

  return child;
}

async function finishStartedHost(child) {
  if (
    process.env.JUNIUS_BOOTSTRAP_TEST_EXIT_AFTER_HEALTH ===
    "1"
  ) {
    await stopChild(child);
    return;
  }

  await waitForChild(child);
}

async function main() {
  await mkdir(runtimeRoot, { recursive: true });

  const current = await readCurrentRelease();
  const liveFingerprint =
    await fingerprintSource(projectRoot);

  const forceValidation =
    process.env.JUNIUS_BOOTSTRAP_TEST_FORCE_VALIDATE ===
    "1";

  if (
    !forceValidation &&
    current !== undefined &&
    current.fingerprint === liveFingerprint
  ) {
    console.error(
      `[bootstrap] source matches validated release ${current.releaseId}`,
    );

    const child = await startRelease(current);
    await finishStartedHost(child);
    return;
  }

  console.error(
    "[bootstrap] source changed; creating validated release candidate.",
  );

  const prepared = await prepareValidatedRelease(
    !forceValidation,
  );

  if (prepared.ok) {
    let child;

    try {
      child = await startRelease(prepared.release);
      await promoteValidatedBootstrap();
      await writeCurrentRelease(prepared.release);
      await pruneReleases(prepared.release.releaseId);

      console.error(
        `[bootstrap] promoted validated release ${prepared.release.releaseId} after ${prepared.check.durationMs} ms ${prepared.check.cached === true ? "cached " : ""}check.`,
      );

      await finishStartedHost(child);
      return;
    } catch (error) {
      if (child !== undefined) {
        await stopChild(child);
      }

      await rm(prepared.release.releaseRoot, {
        recursive: true,
        force: true,
      }).catch(() => {});

      console.error(
        "[bootstrap] candidate release failed to start: " +
          String(error),
      );
    }
  } else {
    console.error(
      "[bootstrap] candidate rejected: " +
        prepared.reason,
    );

    if (prepared.check?.stderr) {
      console.error(prepared.check.stderr);
    }
  }

  const fallback = await readCurrentRelease();

  if (fallback === undefined) {
    throw new Error(
      "no_last_known_good_release_available",
    );
  }

  console.error(
    `[bootstrap] falling back to last-known-good release ${fallback.releaseId}`,
  );

  const fallbackChild = await startRelease(fallback);
  await finishStartedHost(fallbackChild);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (
      activeHost !== undefined &&
      activeHost.exitCode === null &&
      activeHost.signalCode === null
    ) {
      try {
        activeHost.kill(signal);
      } catch {
        activeHost.kill();
      }
    }
  });
}

main().catch((error) => {
  console.error(
    "[bootstrap] fatal: " + String(error),
  );
  process.exitCode = 1;
});
