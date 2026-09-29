import {
  createHash,
} from "node:crypto";
import {
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
      "install.ps1",
      "install-lock.json",
      "bin/junius.mjs",
      "scripts/install.mjs",
      "scripts/install-core.mjs",
      "src/mcp-server.ts",
      "python/desktop_helper.py",
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
    /(?:^|\/)(?:node_modules|\.venv|\.junius|__pycache__|\.playwright-cli)(?:\/|$)|\.pyc$/u;

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

export async function buildRelease() {
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
    DIST_ROOT,
    {
      recursive: true,
      force: true,
    },
  );
  const packRoot =
    join(
      DIST_ROOT,
      ".pack",
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
      DIST_ROOT,
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
      DIST_ROOT,
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
      DIST_ROOT,
      "SHA256SUMS.txt",
    ),
    checksums.join("\n") +
      "\n",
    "utf8",
  );

  await writeFile(
    join(
      DIST_ROOT,
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

  await rm(
    packRoot,
    {
      recursive: true,
      force: true,
    },
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
