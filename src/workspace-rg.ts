import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import {
  delimiter,
  isAbsolute,
  join,
  relative,
} from "node:path";
import { terminateProcessTree } from "./process-termination.js";
import { WorkspaceFileError } from "./workspace-file-error.js";
import type { WorkspacePathResolver } from "./workspace-path-resolver.js";

const RG_TIMEOUT_MS = 15_000;
const RG_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function resolveRgExecutable(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const names =
    process.platform === "win32"
      ? ["rg.exe", "rg"]
      : ["rg"];
  const pathValue =
    environment.PATH ??
    environment.Path ??
    environment.path ??
    "";

  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!entry) continue;

    for (const name of names) {
      const candidate = join(entry, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching.
      }
    }
  }

  return undefined;
}

export interface RgMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly submatches: readonly {
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }[];
}

function parseRgJson(
  output: string,
  workspaceRoot: string,
  maxResults: number,
): readonly RgMatch[] {
  const matches: RgMatch[] = [];

  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (
      typeof event !== "object" ||
      event === null ||
      !("type" in event) ||
      event.type !== "match" ||
      !("data" in event) ||
      typeof event.data !== "object" ||
      event.data === null
    ) {
      continue;
    }

    const data = event.data as {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: {
        start?: number;
        end?: number;
        match?: { text?: string };
      }[];
    };

    const pathText = data.path?.text;
    const lineNumber = data.line_number;
    if (typeof pathText !== "string" || typeof lineNumber !== "number") {
      continue;
    }

    matches.push({
      path: isAbsolute(pathText)
        ? relative(workspaceRoot, pathText)
        : pathText,
      line: lineNumber,
      text: (data.lines?.text ?? "").replace(/\r?\n$/u, ""),
      submatches: (data.submatches ?? []).flatMap((match) =>
        typeof match.start === "number" &&
        typeof match.end === "number" &&
        typeof match.match?.text === "string"
          ? [{
              start: match.start,
              end: match.end,
              text: match.match.text,
            }]
          : [],
      ),
    });

    if (matches.length >= maxResults) {
      break;
    }
  }

  return matches;
}

export async function runRg(
  resolver: WorkspacePathResolver,
  options: {
    readonly query: string;
    readonly path: string;
    readonly globs: readonly string[];
    readonly caseSensitive: boolean;
    readonly fixedStrings: boolean;
    readonly hidden: boolean;
    readonly maxResults: number;
  },
): Promise<readonly RgMatch[]> {
  const executable = resolveRgExecutable();
  if (executable === undefined) {
    throw new WorkspaceFileError(
      "rg_not_available",
      "ripgrep (rg) was not found on PATH.",
    );
  }

  const target = await resolver.existing(options.path);
  const args = [
    "--json",
    "--color=never",
    "--no-config",
  ];

  if (!options.caseSensitive) args.push("-i");
  if (options.fixedStrings) args.push("-F");
  if (options.hidden) args.push("--hidden");

  for (const glob of [
    ...options.globs,
    ...resolver.exclusionGlobs(),
  ]) {
    args.push("-g", glob);
  }

  args.push("--", options.query, target.path);

  const result = await new Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly outputLimit: boolean;
  }>((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd: resolver.rootPath,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RIPGREP_CONFIG_PATH: "",
      },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let outputLimit = false;
    let settled = false;

    const timer = setTimeout(() => {
      void terminateProcessTree(child);
    }, RG_TIMEOUT_MS);

    const append = (targetChunks: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > RG_MAX_OUTPUT_BYTES) {
        if (!outputLimit) {
          outputLimit = true;
          void terminateProcessTree(child);
        }
        return;
      }
      targetChunks.push(buffer);
    };

    child.stdout.on("data", (chunk: Buffer | string) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append(stderr, chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        outputLimit,
      });
    });

    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputLimit,
      });
    });
  });

  if (result.outputLimit) {
    throw new WorkspaceFileError(
      "rg_failed",
      `rg output exceeded ${RG_MAX_OUTPUT_BYTES} bytes.`,
    );
  }

  // ripgrep uses 1 for "no matches".
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new WorkspaceFileError(
      "rg_failed",
      result.stderr || `rg exited with code ${String(result.exitCode)}.`,
    );
  }

  return parseRgJson(result.stdout, resolver.rootPath, options.maxResults);
}
