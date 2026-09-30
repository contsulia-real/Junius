import { spawn } from "node:child_process";
import {
  access,
  mkdir,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertWindowsPlatform,
} from "./windows-only.mjs";

assertWindowsPlatform();

const developmentMode =
  process.argv
    .slice(2)
    .includes("--dev");

const projectRoot = resolve(
  process.env.JUNIUS_PROJECT_ROOT ??
    dirname(
      dirname(
        fileURLToPath(import.meta.url),
      ),
    ),
);
const runtimeRoot = resolve(
  process.env.JUNIUS_RUNTIME_ROOT ??
    join(projectRoot, ".junius", "runtime"),
);
const stableBootstrapPath = join(
  runtimeRoot,
  "bootstrap",
  "host-bootstrap.mjs",
);
const liveBootstrapPath = join(
  projectRoot,
  "scripts",
  "host-bootstrap.mjs",
);

const childEnvironment = {
  ...process.env,
  JUNIUS_PROJECT_ROOT:
    projectRoot,
  ...(
    developmentMode
      ? {
          JUNIUS_MCP_PORT:
            "18787",
          JUNIUS_INSTANCE_ROLE:
            "development",
        }
      : {}
  ),
};

let activeBootstrap;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(runtimeRoot, { recursive: true });

  if (developmentMode) {
    console.error(
      "[launcher] Junius source-test instance on http://127.0.0.1:18787.",
    );
  }

  const bootstrapPath =
    await exists(stableBootstrapPath)
      ? stableBootstrapPath
      : liveBootstrapPath;

  console.error(
    bootstrapPath === stableBootstrapPath
      ? "[launcher] using validated bootstrap."
      : "[launcher] no validated bootstrap yet; using live bootstrap.",
  );

  const child = spawn(
    process.execPath,
    [bootstrapPath],
    {
      cwd: projectRoot,
      env:
        childEnvironment,
      stdio: "inherit",
      windowsHide: false,
    },
  );

  activeBootstrap = child;

  const exit = await new Promise((resolvePromise) => {
    child.once("error", (error) => {
      console.error(
        "[launcher] bootstrap spawn failed: " +
          String(error),
      );
      resolvePromise({
        code: 1,
        signal: null,
      });
    });

    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });

  process.exitCode = exit.code ?? 0;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (
      activeBootstrap !== undefined &&
      activeBootstrap.exitCode === null &&
      activeBootstrap.signalCode === null
    ) {
      try {
        activeBootstrap.kill(signal);
      } catch {
        activeBootstrap.kill();
      }
    }
  });
}

main().catch((error) => {
  console.error("[launcher] fatal: " + String(error));
  process.exitCode = 1;
});
