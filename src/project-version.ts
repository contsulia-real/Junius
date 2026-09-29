import { readFileSync } from "node:fs";

interface ProjectPackage {
  readonly version?: unknown;
  readonly juniusVersion?: unknown;
}

function loadProjectVersion(): string {
  const packagePath = new URL(
    "../package.json",
    import.meta.url,
  );
  const parsed = JSON.parse(
    readFileSync(packagePath, "utf8"),
  ) as ProjectPackage;
  const version =
    typeof parsed.juniusVersion === "string" &&
    parsed.juniusVersion.length > 0
      ? parsed.juniusVersion
      : parsed.version;

  if (
    typeof version !== "string" ||
    version.length === 0
  ) {
    throw new Error(
      "Junius package.json must define a non-empty juniusVersion or version.",
    );
  }

  return version;
}

export const JUNIUS_VERSION =
  loadProjectVersion();
