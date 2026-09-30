import { spawn } from "node:child_process";
import {
  readFile,
  stat,
} from "node:fs/promises";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import {
  MAX_CHECK_OUTPUT_CHARS,
  projectRoot,
} from "./host-bootstrap-paths.mjs";

function appendBounded(
  current,
  chunk,
) {
  const next =
    current + chunk.toString();
  return next.length <=
    MAX_CHECK_OUTPUT_CHARS
    ? next
    : next.slice(
        next.length -
          MAX_CHECK_OUTPUT_CHARS,
      );
}

async function fileExists(
  path,
) {
  try {
    return (
      await stat(path)
    ).isFile();
  } catch {
    return false;
  }
}

async function targetFromWindowsCmdShim(
  shimPath,
) {
  if (
    process.platform !==
      "win32" ||
    extname(
      shimPath,
    ).toLowerCase() !==
      ".cmd"
  ) {
    return undefined;
  }

  try {
    const text =
      await readFile(
        shimPath,
        "utf8",
      );
    const match =
      text.match(
        /["']?([^"'\r\n]*npm-cli\.js)["']?/iu,
      );

    if (
      match?.[1] ===
      undefined
    ) {
      return undefined;
    }

    const expanded =
      match[1]
        .replaceAll(
          "%dp0%",
          dirname(
            shimPath,
          ) + "\\",
        )
        .replaceAll(
          "%~dp0",
          dirname(
            shimPath,
          ) + "\\",
        );

    return isAbsolute(
      expanded,
    )
      ? resolve(expanded)
      : resolve(
          dirname(shimPath),
          expanded,
        );
  } catch {
    return undefined;
  }
}

async function isPortableExecutable(
  path,
) {
  try {
    const data =
      await readFile(path);
    return (
      data.byteLength >= 2 &&
      data[0] === 0x4d &&
      data[1] === 0x5a
    );
  } catch {
    return false;
  }
}

async function launcherForPackageManagerCandidate(
  candidate,
) {
  const extension =
    extname(
      candidate,
    ).toLowerCase();

  if (
    extension === ".exe" ||
    await isPortableExecutable(
      candidate,
    )
  ) {
    return {
      executable:
        candidate,
      fixedArgs: [],
    };
  }

  if (
    [
      ".js",
      ".cjs",
      ".mjs",
    ].includes(
      extension,
    )
  ) {
    return {
      executable:
        process.execPath,
      fixedArgs: [
        candidate,
      ],
    };
  }

  return undefined;
}

async function npmInvocation() {
  const candidates = [];

  if (
    typeof process.env
      .npm_execpath ===
      "string" &&
    /npm-cli\.js$/iu.test(
      process.env
        .npm_execpath,
    )
  ) {
    candidates.push(
      process.env
        .npm_execpath,
    );
  }

  candidates.push(
    join(
      dirname(
        process.execPath,
      ),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  );

  for (
    const candidate of
    candidates
  ) {
    if (
      await fileExists(
        candidate,
      )
    ) {
      return {
        executable:
          process.execPath,
        fixedArgs: [
          candidate,
        ],
      };
    }
  }

  const names =
    process.platform ===
    "win32"
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

  for (
    const rawEntry of
    (
      process.env.PATH ??
      process.env.Path ??
      process.env.path ??
      ""
    ).split(
      delimiter,
    )
  ) {
    const entry =
      rawEntry
        .trim()
        .replace(
          /^"(.*)"$/u,
          "$1",
        );

    if (!entry) {
      continue;
    }

    for (
      const name of
      names
    ) {
      const candidate =
        join(
          entry,
          name,
        );

      if (
        !await fileExists(
          candidate,
        )
      ) {
        continue;
      }

      const direct =
        await launcherForPackageManagerCandidate(
          candidate,
        );
      if (
        direct !==
        undefined
      ) {
        return direct;
      }

      const shimTarget =
        await targetFromWindowsCmdShim(
          candidate,
        );

      if (
        shimTarget !==
          undefined &&
        await fileExists(
          shimTarget,
        )
      ) {
        const shimLauncher =
          await launcherForPackageManagerCandidate(
            shimTarget,
          );

        if (
          shimLauncher !==
          undefined
        ) {
          return shimLauncher;
        }
      }
    }
  }

  throw new Error(
    "bootstrap_npm_unavailable: npm was not found for the current Node installation.",
  );
}

export async function runCheck() {
  const startedAt =
    performance.now();

  let launcher;
  try {
    launcher =
      await npmInvocation();
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr:
        String(error),
      durationMs:
        Math.round(
          performance.now() -
            startedAt,
        ),
    };
  }

  return new Promise(
    (resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = spawn(
        launcher.executable,
        [
          ...launcher.fixedArgs,
          "run",
          "check",
        ],
        {
          cwd: projectRoot,
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

      const finish = (
        result,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise({
          ...result,
          stdout,
          stderr,
          durationMs:
            Math.round(
              performance.now() -
                startedAt,
            ),
        });
      };

      child.stdout.on(
        "data",
        (chunk) => {
          stdout =
            appendBounded(
              stdout,
              chunk,
            );
        },
      );
      child.stderr.on(
        "data",
        (chunk) => {
          stderr =
            appendBounded(
              stderr,
              chunk,
            );
        },
      );
      child.once(
        "error",
        (error) => {
          stderr =
            appendBounded(
              stderr,
              String(error),
            );
          finish({
            ok: false,
            exitCode: null,
            signal: null,
          });
        },
      );
      child.once(
        "close",
        (
          exitCode,
          signal,
        ) => {
          finish({
            ok:
              exitCode ===
              0,
            exitCode,
            signal,
          });
        },
      );
    },
  );
}
