import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

function run(
  executable,
  args,
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
            PROJECT_ROOT,
          env:
            process.env,
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
                "runtime_build_failed:\n" +
                  stderr +
                  stdout,
              ),
            );
            return;
          }

          resolvePromise();
        },
      );
    },
  );
}

function runtimePackage(
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
    license:
      sourcePackage.license,
    engines:
      sourcePackage.engines,
    os:
      sourcePackage.os,
    type: "module",
  };
}

export async function buildRuntime(
  options = {},
) {
  const outputRoot =
    resolve(
      options.outputRoot ??
        join(
          PROJECT_ROOT,
          "runtime",
        ),
    );
  const sourcePackage =
    options.packageJson ??
    JSON.parse(
      await readFile(
        join(
          PROJECT_ROOT,
          "package.json",
        ),
        "utf8",
      ),
    );

  await rm(
    outputRoot,
    {
      recursive: true,
      force: true,
    },
  );
  await mkdir(
    outputRoot,
    {
      recursive: true,
    },
  );

  const tscPath =
    join(
      PROJECT_ROOT,
      "node_modules",
      "typescript",
      "bin",
      "tsc",
    );

  await run(
    process.execPath,
    [
      tscPath,
      "--project",
      join(
        PROJECT_ROOT,
        "tsconfig.runtime.json",
      ),
      "--outDir",
      join(
        outputRoot,
        "src",
      ),
    ],
  );

  for (
    const file of [
      "job-bootstrap.mjs",
      "windows-job-guardian.ps1",
    ]
  ) {
    await mkdir(
      join(
        outputRoot,
        "src",
      ),
      {
        recursive: true,
      },
    );
    await cp(
      join(
        PROJECT_ROOT,
        "src",
        file,
      ),
      join(
        outputRoot,
        "src",
        file,
      ),
      {
        force: true,
      },
    );
  }

  for (
    const directory of [
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
        outputRoot,
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
      outputRoot,
      "scripts",
    ),
    {
      recursive: true,
    },
  );

  for (
    const file of [
      "install-paths.mjs",
      "install-process.mjs",
      "update.mjs",
      "windows-only.mjs",
    ]
  ) {
    await cp(
      join(
        PROJECT_ROOT,
        "scripts",
        file,
      ),
      join(
        outputRoot,
        "scripts",
        file,
      ),
      {
        force: true,
      },
    );
  }

  await writeFile(
    join(
      outputRoot,
      "package.json",
    ),
    JSON.stringify(
      runtimePackage(
        sourcePackage,
      ),
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return {
    outputRoot,
    hostPath:
      join(
        outputRoot,
        "src",
        "host.js",
      ),
    workerPath:
      join(
        outputRoot,
        "src",
        "worker-entry.js",
      ),
  };
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
  buildRuntime().catch(
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
