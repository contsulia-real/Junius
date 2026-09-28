import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  join,
} from "node:path";
import { pathToFileURL } from "node:url";

export type Program = (options?: {
  embedderVersion?: string;
}) => Promise<void>;

function readPackageVersion(
  packageJsonPath: string,
): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    ) as {
      version?: unknown;
    };

    return typeof parsed.version === "string"
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}

function requiredCoreVersion(
  cliEntryPath: string,
): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(
        join(dirname(cliEntryPath), "package.json"),
        "utf8",
      ),
    ) as {
      dependencies?: Record<string, unknown>;
    };
    const value = parsed.dependencies?.["playwright-core"];

    if (typeof value !== "string") {
      return undefined;
    }

    return /^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function pnpmGlobalVersionRoot(
  entryPath: string,
): string | undefined {
  let current = dirname(entryPath);

  for (;;) {
    const parent = dirname(current);
    if (parent === current) return undefined;

    if (
      /^v\d+$/u.test(basename(current)) &&
      basename(parent).toLowerCase() === "global"
    ) {
      return current;
    }

    current = parent;
  }
}

function discoverPnpmGlobalProgram(
  cliEntryPath: string,
  moduleSpecifier: string,
): string | undefined {
  const prefix = "playwright-core/";
  if (!moduleSpecifier.startsWith(prefix)) {
    return undefined;
  }

  const versionRoot = pnpmGlobalVersionRoot(cliEntryPath);
  if (versionRoot === undefined) {
    return undefined;
  }

  const requiredVersion = requiredCoreVersion(cliEntryPath);
  const relativeModule =
    moduleSpecifier.slice(prefix.length) + ".js";
  const candidates: {
    readonly path: string;
    readonly version?: string;
  }[] = [];

  let entries;
  try {
    entries = readdirSync(versionRoot, {
      withFileTypes: true,
    });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const coreRoot = join(
      versionRoot,
      entry.name,
      "node_modules",
      "playwright-core",
    );
    const programPath = join(coreRoot, relativeModule);

    if (!existsSync(programPath)) continue;

    candidates.push({
      path: programPath,
      version: readPackageVersion(
        join(coreRoot, "package.json"),
      ),
    });
  }

  if (requiredVersion !== undefined) {
    return candidates.find(
      (candidate) => candidate.version === requiredVersion,
    )?.path;
  }

  return candidates.length === 1
    ? candidates[0]!.path
    : undefined;
}

export async function loadProgram(): Promise<Program> {
  const cliEntryPath =
    process.env.JUNIUS_PLAYWRIGHT_CLI_ENTRY;
  if (!cliEntryPath) {
    throw new Error(
      "JUNIUS_PLAYWRIGHT_CLI_ENTRY is required.",
    );
  }

  const resolvedCliEntryPath = realpathSync(cliEntryPath);
  const source = readFileSync(resolvedCliEntryPath, "utf8");
  const match = source.match(
    /\{\s*program\s*\}\s*=\s*require\(["']([^"']+)["']\)/u,
  );

  if (match?.[1] === undefined) {
    throw new Error(
      "Unable to discover the playwright-cli program module from the installed CLI entry.",
    );
  }

  let programPath: string | undefined;

  if (match[1].startsWith("playwright-core/")) {
    const packageRoot = dirname(resolvedCliEntryPath);
    const nodeModulesRoot = dirname(dirname(packageRoot));
    const directPath = join(
      nodeModulesRoot,
      "playwright-core",
      match[1].slice("playwright-core/".length) + ".js",
    );

    if (existsSync(directPath)) {
      programPath = directPath;
    }
  }

  if (programPath === undefined) {
    try {
      programPath = createRequire(
        resolvedCliEntryPath,
      ).resolve(match[1]);
    } catch {
      programPath = discoverPnpmGlobalProgram(
        resolvedCliEntryPath,
        match[1],
      );
    }
  }

  if (programPath === undefined) {
    const matchIndex = match.index ?? 0;
    const bootstrap = source
      .slice(0, matchIndex)
      .replaceAll("\r", "")
      .slice(-6000);
    let cliVersion = "unknown";

    try {
      const cliPackage = JSON.parse(
        readFileSync(
          join(
            dirname(resolvedCliEntryPath),
            "package.json",
          ),
          "utf8",
        ),
      ) as { version?: unknown };
      if (typeof cliPackage.version === "string") {
        cliVersion = cliPackage.version;
      }
    } catch {
      // Keep diagnostic best-effort.
    }

    throw new Error(
      `Unable to locate the installed Playwright program module: ${match[1]}\n@playwright/cli version: ${cliVersion}\nCLI bootstrap before require:\n${bootstrap}`,
    );
  }

  const module = await import(pathToFileURL(programPath).href) as {
    program?: unknown;
  };

  if (typeof module.program !== "function") {
    throw new Error(
      "playwright-core cli-client program export is unavailable.",
    );
  }

  return module.program as Program;
}
