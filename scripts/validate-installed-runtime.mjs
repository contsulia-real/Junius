import { spawn } from "node:child_process";
import {
  readFile,
} from "node:fs/promises";
import {
  join,
  resolve,
} from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";

function runNode(
  args,
  cwd,
) {
  return new Promise(
    (
      resolvePromise,
      rejectPromise,
    ) => {
      const child = spawn(
        process.execPath,
        args,
        {
          cwd,
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
                "compiled_runtime_validation_failed:\n" +
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

export async function validateInstalledRuntime(
  root = process.cwd(),
) {
  const runtimeRoot =
    resolve(root);
  const packageJson =
    JSON.parse(
      await readFile(
        join(
          runtimeRoot,
          "package.json",
        ),
        "utf8",
      ),
    );

  if (
    packageJson
      .devDependencies !==
    undefined
  ) {
    throw new Error(
      "compiled_runtime_contains_dev_dependencies",
    );
  }

  for (
    const entry of [
      "src/host.js",
      "src/worker-entry.js",
    ]
  ) {
    await runNode(
      [
        "--check",
        entry,
      ],
      runtimeRoot,
    );
  }

  const mcpServerUrl =
    pathToFileURL(
      join(
        runtimeRoot,
        "src",
        "mcp-server.js",
      ),
    ).href;

  await runNode(
    [
      "--input-type=module",
      "--eval",
      "await import(" +
        JSON.stringify(
          mcpServerUrl,
        ) +
        ")",
    ],
    runtimeRoot,
  );
}

const SCRIPT_PATH =
  fileURLToPath(
    import.meta.url,
  );
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
  validateInstalledRuntime(
    process.argv[2] ??
      process.cwd(),
  ).catch(
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
