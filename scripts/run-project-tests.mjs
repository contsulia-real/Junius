import {
  readdir,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import {
  spawn,
} from "node:child_process";
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

async function collectTests(
  directory,
) {
  const entries =
    await readdir(
      directory,
      {
        withFileTypes: true,
      },
    );

  const tests = [];

  for (
    const entry of entries
  ) {
    const path =
      join(
        directory,
        entry.name,
      );

    if (
      entry.isDirectory()
    ) {
      tests.push(
        ...await collectTests(
          path,
        ),
      );
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(
        ".test.ts",
      )
    ) {
      tests.push(path);
    }
  }

  return tests;
}

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
          stdio:
            "inherit",
        },
      );

      child.once(
        "error",
        rejectPromise,
      );
      child.once(
        "close",
        (
          exitCode,
          signal,
        ) => {
          if (
            exitCode !== 0
          ) {
            rejectPromise(
              new Error(
                "project_tests_failed: exit=" +
                  String(
                    exitCode,
                  ) +
                  " signal=" +
                  String(
                    signal,
                  ),
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

const tests =
  await collectTests(
    join(
      PROJECT_ROOT,
      "src",
    ),
  );

tests.sort();

if (tests.length === 0) {
  throw new Error(
    "no_project_tests_found",
  );
}

await run(
  process.execPath,
  [
    join(
      PROJECT_ROOT,
      "node_modules",
      "tsx",
      "dist",
      "cli.mjs",
    ),
    "--test",
    "--test-concurrency=4",
    ...tests,
  ],
);
