import { readFileSync } from "node:fs";

interface ProjectPackage {
  readonly version?: unknown;
}

function loadProjectVersion(): string {
  const packagePath = new URL(
    "../package.json",
    import.meta.url,
  );
  const parsed = JSON.parse(
    readFileSync(packagePath, "utf8"),
  ) as ProjectPackage;

  if (
    typeof parsed.version !== "string" ||
    parsed.version.length === 0
  ) {
    throw new Error(
      "Junius package.json must define a non-empty version.",
    );
  }

  return parsed.version;
}

export const JUNIUS_VERSION =
  loadProjectVersion();
