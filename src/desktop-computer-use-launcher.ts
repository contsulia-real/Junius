import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_DESKTOP_HELPER_PATH = fileURLToPath(
  new URL("../python/desktop_helper.py", import.meta.url),
);

function localPythonCandidate(
  helperPath: string,
  environment: NodeJS.ProcessEnv,
): string {
  const root =
    environment.JUNIUS_PROJECT_ROOT ??
    dirname(dirname(helperPath));

  if (process.platform === "win32") {
    return join(root, ".venv", "Scripts", "python.exe");
  }

  return join(root, ".venv", "bin", "python");
}

export function resolveDesktopPythonExecutable(
  helperPath: string,
  environment: NodeJS.ProcessEnv,
  explicit?: string,
): string | undefined {
  const candidate =
    explicit ??
    localPythonCandidate(helperPath, environment);

  return existsSync(candidate)
    ? resolve(candidate)
    : undefined;
}


