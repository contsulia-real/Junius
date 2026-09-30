import {
  existsSync,
  readFileSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export type HostWatchedArea =
  | "src"
  | "python"
  | "prompts"
  | "root"
  | "scripts";

export type SourceChangeDisposition =
  | "ignore"
  | "reload-worker"
  | "restart-host";

const ROOT_CONTROL_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);

const SCRIPT_CONTROL_FILES = new Set([
  "host-bootstrap.mjs",
  "host-bootstrap-paths.mjs",
  "host-bootstrap-source.mjs",
  "host-bootstrap-check.mjs",
  "host-bootstrap-releases.mjs",
  "host-bootstrap-host.mjs",
  "host-launcher.mjs",
  "windows-only.mjs",
  "windows-only.d.mts",
  "source-validation.mjs",
]);

function pathInside(
  root: string,
  candidate: string,
): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel)
    )
  );
}

function normalizedRelative(
  root: string,
  path: string,
): string {
  return relative(root, path).replaceAll("\\", "/");
}

function importedSpecifiers(
  source: string,
): readonly string[] {
  const values = new Set<string>();
  const patterns = [
    /\bfrom\s*["'](\.[^"']+)["']/gu,
    /\bimport\s*["'](\.[^"']+)["']/gu,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/gu,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (value !== undefined) {
        values.add(value);
      }
    }
  }

  return [...values];
}

function sourceCandidate(
  importer: string,
  specifier: string,
): string | undefined {
  const raw = resolve(dirname(importer), specifier);
  const extension = extname(raw);

  const candidates =
    extension === ".js"
      ? [raw.slice(0, -3) + ".ts"]
      : extension === ".mjs"
        ? [raw.slice(0, -4) + ".mts"]
        : extension === ".cjs"
          ? [raw.slice(0, -4) + ".cts"]
          : extension === ""
            ? [
                raw + ".ts",
                raw + ".tsx",
                resolve(raw, "index.ts"),
              ]
            : [raw];

  return candidates.find((candidate) =>
    existsSync(candidate),
  );
}

export function hostSourceDependencies(
  srcRoot: string,
  entryRelative = "host.ts",
): ReadonlySet<string> {
  const canonicalRoot = resolve(srcRoot);
  const entry = resolve(canonicalRoot, entryRelative);
  const pending = [entry];
  const visited = new Set<string>();
  const dependencies = new Set<string>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      visited.has(current) ||
      !pathInside(canonicalRoot, current) ||
      !existsSync(current)
    ) {
      continue;
    }

    visited.add(current);
    dependencies.add(
      normalizedRelative(canonicalRoot, current),
    );

    let source: string;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue;
    }

    for (const specifier of importedSpecifiers(source)) {
      const candidate = sourceCandidate(
        current,
        specifier,
      );
      if (
        candidate !== undefined &&
        pathInside(canonicalRoot, candidate)
      ) {
        pending.push(candidate);
      }
    }
  }

  return dependencies;
}

export function sourceChangeDisposition(
  srcRoot: string,
  area: HostWatchedArea,
  relativePath: string | undefined,
): SourceChangeDisposition {
  if (relativePath === undefined) {
    return (
      area === "python" ||
      area === "prompts"
    )
      ? "reload-worker"
      : "restart-host";
  }

  const normalized =
    relativePath.replaceAll("\\", "/");

  if (
    area === "src" &&
    normalized.endsWith(".test.ts")
  ) {
    return "ignore";
  }

  if (area === "root") {
    return ROOT_CONTROL_FILES.has(normalized)
      ? "restart-host"
      : "ignore";
  }

  if (area === "scripts") {
    return SCRIPT_CONTROL_FILES.has(normalized)
      ? "restart-host"
      : "ignore";
  }

  if (area === "python") {
    return normalized.endsWith(".py")
      ? "reload-worker"
      : "ignore";
  }

  if (area === "prompts") {
    return normalized.endsWith(".md")
      ? "reload-worker"
      : "ignore";
  }

  if (!normalized.endsWith(".ts")) {
    return "ignore";
  }

  return hostSourceDependencies(srcRoot).has(
    normalized,
  )
    ? "restart-host"
    : "reload-worker";
}
