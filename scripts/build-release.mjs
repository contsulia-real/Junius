import {
  createHash,
} from "node:crypto";
import {
  cp,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  spawn,
} from "node:child_process";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";
import {
  buildRuntime,
} from "./build-runtime.mjs";

const SCRIPT_PATH =
  fileURLToPath(
    import.meta.url,
  );
const PROJECT_ROOT =
  resolve(
    dirname(SCRIPT_PATH),
    "..",
  );
const DIST_ROOT =
  join(
    PROJECT_ROOT,
    "dist",
  );

function run(
  executable,
  args,
  options = {},
) {
  return new Promise(
    (
      resolvePromise,
      rejectPromise,
    ) => {
      const child = spawn(
        executable,
        args,
        {
          cwd:
            options.cwd ??
            PROJECT_ROOT,
          env: process.env,
          shell: false,
          windowsHide: true,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding(
        "utf8",
      );
      child.stderr.setEncoding(
        "utf8",
      );
      child.stdout.on(
        "data",
        (chunk) => {
          stdout += chunk;
        },
      );
      child.stderr.on(
        "data",
        (chunk) => {
          stderr += chunk;
        },
      );
      child.once(
        "error",
        rejectPromise,
      );
      child.once(
        "close",
        (exitCode) => {
          if (exitCode !== 0) {
            rejectPromise(
              new Error(
                "process_failed: " +
                  executable +
                  " " +
                  args.join(" ") +
                  "\n" +
                  stderr +
                  stdout,
              ),
            );
            return;
          }

          resolvePromise({
            stdout,
            stderr,
          });
        },
      );
    },
  );
}

function npmInvocation() {
  if (
    typeof process.env
      .npm_execpath ===
      "string" &&
    process.env.npm_execpath
      .endsWith("npm-cli.js")
  ) {
    return {
      executable:
        process.execPath,
      prefixArgs: [
        process.env
          .npm_execpath,
      ],
    };
  }

  if (
    process.platform ===
    "win32"
  ) {
    return {
      executable:
        process.env.ComSpec ??
        process.env.COMSPEC ??
        "cmd.exe",
      prefixArgs: [
        "/d",
        "/s",
        "/c",
        "npm",
      ],
    };
  }

  return {
    executable: "npm",
    prefixArgs: [],
  };
}

function parsedPackResult(
  stdout,
) {
  const parsed =
    JSON.parse(stdout);

  if (
    Array.isArray(parsed)
  ) {
    return parsed[0];
  }

  if (
    parsed !== null &&
    typeof parsed ===
      "object"
  ) {
    if (
      parsed.junius !==
      undefined
    ) {
      return parsed.junius;
    }

    return Object.values(
      parsed,
    )[0];
  }

  return undefined;
}

export function validatePackedFiles(
  files,
) {
  const paths =
    new Set(
      files.map(
        (entry) =>
          entry.path,
      ),
    );

  for (
    const required of [
      "package.json",
      "CHANGELOG.md",
      "icon.svg",
      "install.ps1",
      "install-lock.json",
      "requirements-desktop.txt",
      "bin/junius.mjs",
      "scripts/host-launcher.mjs",
      "scripts/host-bootstrap.mjs",
      "scripts/host-bootstrap-paths.mjs",
      "scripts/host-bootstrap-source.mjs",
      "scripts/host-bootstrap-check.mjs",
      "scripts/host-bootstrap-releases.mjs",
      "scripts/host-bootstrap-host.mjs",
      "scripts/install.mjs",
      "scripts/install-cli.mjs",
      "scripts/install-paths.mjs",
      "scripts/install-process.mjs",
      "scripts/install-python.mjs",
      "scripts/install-application.mjs",
      "scripts/install-windows-host.mjs",
      "scripts/restart.mjs",
      "scripts/update.mjs",
      "scripts/validate-installed-runtime.mjs",
      "scripts/windows-only.mjs",
      "runtime/package.json",
      "runtime/src/host.js",
      "runtime/src/worker-entry.js",
      "runtime/src/job-bootstrap.mjs",
      "runtime/src/windows-job-guardian.ps1",
      "runtime/python/desktop_helper.py",
      "runtime/python/desktop_helper_common.py",
      "runtime/python/desktop_windows.py",
      "runtime/python/desktop_clipboard.py",
      "runtime/python/desktop_input.py",
      "runtime/python/user_interrupt.py",
      "runtime/prompts/core.md",
      "runtime/prompts/engineering.md",
      "runtime/prompts/desktop.md",
      "runtime/prompts/browser.md",
      "runtime/ui/observability-panel.html",
      "runtime/scripts/install-paths.mjs",
      "runtime/scripts/install-process.mjs",
      "runtime/scripts/update.mjs",
      "runtime/scripts/windows-only.mjs",
      "python/desktop_helper.py",
      "python/desktop_helper_common.py",
      "python/desktop_windows.py",
      "python/desktop_clipboard.py",
      "python/desktop_input.py",
      "python/user_interrupt.py",
      "prompts/core.md",
      "prompts/engineering.md",
      "prompts/desktop.md",
      "prompts/browser.md",
    ]
  ) {
    if (
      !paths.has(required)
    ) {
      throw new Error(
        "release_missing_file: " +
          required,
      );
    }
  }

  const forbidden =
    /(?:^|\/)(?:node_modules|\.venv|\.junius|__pycache__|\.playwright-cli)(?:\/|$)|\.pyc$|\.(?:ts|tsx|mts|cts)$/u;

  const bad =
    [...paths].filter(
      (path) =>
        forbidden.test(path),
    );

  if (bad.length > 0) {
    throw new Error(
      "release_contains_forbidden_files: " +
        bad.join(", "),
    );
  }
}

function normalizedRecord(
  value,
) {
  if (value === undefined) {
    return {};
  }

  if (
    value === null ||
    typeof value !==
      "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "release_install_lock_invalid_record",
    );
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(
        ([left], [right]) =>
          left.localeCompare(
            right,
          ),
      ),
  );
}

export function validateInstallLock(
  packageJson,
  installLock,
) {
  const root =
    installLock
      ?.packages?.[""];

  if (
    root === undefined ||
    installLock.name !==
      packageJson.name ||
    installLock.version !==
      packageJson.version ||
    root.name !==
      packageJson.name ||
    root.version !==
      packageJson.version
  ) {
    throw new Error(
      "release_install_lock_identity_mismatch",
    );
  }

  for (
    const field of [
      "dependencies",
      "devDependencies",
    ]
  ) {
    const expected =
      normalizedRecord(
        packageJson[field],
      );
    const actual =
      normalizedRecord(
        root[field],
      );

    if (
      JSON.stringify(
        expected,
      ) !==
      JSON.stringify(
        actual,
      )
    ) {
      throw new Error(
        "release_install_lock_dependency_mismatch: " +
          field,
      );
    }
  }
}

function productionPackage(
  sourcePackage,
) {
  return {
    name:
      sourcePackage.name,
    version:
      sourcePackage.version,
    private: true,
    description:
      sourcePackage.description,
    bin:
      sourcePackage.bin,
    license:
      sourcePackage.license,
    repository:
      sourcePackage.repository,
    bugs:
      sourcePackage.bugs,
    homepage:
      sourcePackage.homepage,
    engines:
      sourcePackage.engines,
    os:
      sourcePackage.os,
    type: "module",
    scripts: {
      check:
        "node scripts/validate-installed-runtime.mjs runtime",
    },
    dependencies:
      sourcePackage.dependencies,
  };
}

function productionInstallLock(
  sourceLock,
) {
  const lock =
    structuredClone(
      sourceLock,
    );
  const root =
    lock.packages?.[""];

  if (
    root === undefined
  ) {
    throw new Error(
      "release_install_lock_root_missing",
    );
  }

  delete root.devDependencies;

  for (
    const [
      path,
      value,
    ] of Object.entries(
      lock.packages,
    )
  ) {
    if (
      path !== "" &&
      value?.dev === true
    ) {
      delete lock.packages[
        path
      ];
    }
  }

  return lock;
}

async function copyReleaseScaffold(
  installRoot,
) {
  for (
    const directory of [
      "bin",
      "python",
      "prompts",
    ]
  ) {
    await cp(
      join(
        PROJECT_ROOT,
        directory,
      ),
      join(
        installRoot,
        directory,
      ),
      {
        recursive: true,
        force: true,
      },
    );
  }

  await mkdir(
    join(
      installRoot,
      "scripts",
    ),
    {
      recursive: true,
    },
  );

  for (
    const file of [
      "host-launcher.mjs",
      "host-bootstrap.mjs",
      "host-bootstrap-paths.mjs",
      "host-bootstrap-source.mjs",
      "host-bootstrap-check.mjs",
      "host-bootstrap-releases.mjs",
      "host-bootstrap-host.mjs",
      "install.mjs",
      "install-cli.mjs",
      "install-paths.mjs",
      "install-process.mjs",
      "install-python.mjs",
      "install-application.mjs",
      "install-windows-host.mjs",
      "restart.mjs",
      "update.mjs",
      "validate-installed-runtime.mjs",
      "windows-only.mjs",
    ]
  ) {
    await copyFile(
      join(
        PROJECT_ROOT,
        "scripts",
        file,
      ),
      join(
        installRoot,
        "scripts",
        file,
      ),
    );
  }

  for (
    const file of [
      "CHANGELOG.md",
      "icon.svg",
      "install.ps1",
      "LICENSE",
      "README.md",
      "README.zh-CN.md",
      "requirements-desktop.txt",
      "SECURITY.md",
    ]
  ) {
    await copyFile(
      join(
        PROJECT_ROOT,
        file,
      ),
      join(
        installRoot,
        file,
      ),
    );
  }
}

export function checksumLine(
  hash,
  filename,
) {
  return (
    hash.toLowerCase() +
    "  " +
    filename
  );
}

async function sha256(
  path,
) {
  return createHash(
    "sha256",
  )
    .update(
      await readFile(path),
    )
    .digest("hex");
}

export async function buildRelease(
  options = {},
) {
  const distRoot =
    options.distRoot ??
    DIST_ROOT;
  const packageJson =
    JSON.parse(
      await readFile(
        join(
          PROJECT_ROOT,
          "package.json",
        ),
        "utf8",
      ),
    );
  const installLock =
    JSON.parse(
      await readFile(
        join(
          PROJECT_ROOT,
          "install-lock.json",
        ),
        "utf8",
      ),
    );

  validateInstallLock(
    packageJson,
    installLock,
  );

  await rm(
    distRoot,
    {
      recursive: true,
      force: true,
    },
  );
  await mkdir(
    distRoot,
    {
      recursive: true,
    },
  );

  const installRoot =
    join(
      distRoot,
      ".install",
    );
  const packRoot =
    join(
      distRoot,
      ".pack",
    );

  try {
    await mkdir(
      installRoot,
      {
        recursive: true,
      },
    );
    await copyReleaseScaffold(
      installRoot,
    );
    await buildRuntime({
      outputRoot:
        join(
          installRoot,
          "runtime",
        ),
      packageJson,
    });

    const releasePackage =
      productionPackage(
        packageJson,
      );
    const releaseLock =
      productionInstallLock(
        installLock,
      );

    await writeFile(
      join(
        installRoot,
        "package.json",
      ),
      JSON.stringify(
        releasePackage,
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await writeFile(
      join(
        installRoot,
        "install-lock.json",
      ),
      JSON.stringify(
        releaseLock,
        null,
        2,
      ) + "\n",
      "utf8",
    );

    validateInstallLock(
      releasePackage,
      releaseLock,
    );

    await mkdir(
      packRoot,
      {
        recursive: true,
      },
    );

    const npm =
      npmInvocation();
    const packed =
      await run(
        npm.executable,
        [
          ...npm.prefixArgs,
          "pack",
          installRoot,
          "--json",
          "--pack-destination",
          packRoot,
        ],
      );

    const pack =
      parsedPackResult(
        packed.stdout,
      );
    if (
      pack === undefined ||
      !Array.isArray(
        pack.files,
      ) ||
      typeof pack.filename !==
        "string"
    ) {
      throw new Error(
        "invalid_npm_pack_result",
      );
    }

    validatePackedFiles(
      pack.files,
    );

    const packagePath =
      join(
        distRoot,
        "junius-windows.tgz",
      );
    await rename(
      join(
        packRoot,
        pack.filename,
      ),
      packagePath,
    );

    const installScript =
      join(
        distRoot,
        "install.ps1",
      );
    await copyFile(
      join(
        PROJECT_ROOT,
        "install.ps1",
      ),
      installScript,
    );

    const checksums = [
      checksumLine(
        await sha256(
          packagePath,
        ),
        "junius-windows.tgz",
      ),
      checksumLine(
        await sha256(
          installScript,
        ),
        "install.ps1",
      ),
    ];

    await writeFile(
      join(
        distRoot,
        "SHA256SUMS.txt",
      ),
      checksums.join("\n") +
        "\n",
      "utf8",
    );

    await writeFile(
      join(
        distRoot,
        "release.json",
      ),
      JSON.stringify(
        {
          version:
            packageJson.version,
          package:
            "junius-windows.tgz",
          checksums:
            "SHA256SUMS.txt",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    console.log(
      JSON.stringify({
        ok: true,
        version:
          packageJson.version,
        assets: [
          "junius-windows.tgz",
          "SHA256SUMS.txt",
          "install.ps1",
          "release.json",
        ],
      }),
    );
  } finally {
    await Promise.allSettled([
      rm(
        installRoot,
        {
          recursive: true,
          force: true,
        },
      ),
      rm(
        packRoot,
        {
          recursive: true,
          force: true,
        },
      ),
    ]);
  }
}

const invokedPath =
  process.argv[1] ===
  undefined
    ? undefined
    : resolve(
        process.argv[1],
      );

if (
  invokedPath ===
  SCRIPT_PATH
) {
  buildRelease().catch(
    (error) => {
      console.error(
        error instanceof Error
          ? error.stack ??
              error.message
          : String(error),
      );
      process.exitCode = 1;
    },
  );
}
