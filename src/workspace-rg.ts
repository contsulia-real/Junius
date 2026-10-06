import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import {
  delimiter,
  isAbsolute,
  join,
  relative,
} from "node:path";
import { terminateProcessTree } from "./process-termination.js";
import { WorkspaceFileError } from "./workspace-file-error.js";
import { pathSegments, type WorkspacePathResolver } from "./workspace-path-resolver.js";

const RG_TIMEOUT_MS = 15_000;
const RG_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function resolveExecutable(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): string | undefined {
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

type SearchBackend =
  | { readonly kind: "rg"; readonly executable: string }
  | { readonly kind: "pwsh"; readonly executable: string }
  | { readonly kind: "cmd"; readonly executable: string };

function resolveSearchBackend(
  environment: NodeJS.ProcessEnv,
): SearchBackend | undefined {
  const rg = resolveExecutable(
    process.platform === "win32"
      ? ["rg.exe", "rg"]
      : ["rg"],
    environment,
  );
  if (rg !== undefined) {
    return { kind: "rg", executable: rg };
  }

  if (process.platform !== "win32") {
    return undefined;
  }

  const pwsh = resolveExecutable(
    ["pwsh.exe", "pwsh"],
    environment,
  );
  if (pwsh !== undefined) {
    return { kind: "pwsh", executable: pwsh };
  }

  const comSpec =
    environment.ComSpec ??
    environment.COMSPEC;
  if (typeof comSpec === "string" && comSpec.length > 0) {
    try {
      accessSync(comSpec, constants.X_OK);
      return { kind: "cmd", executable: comSpec };
    } catch {
      // Fall through to PATH lookup.
    }
  }

  const cmd = resolveExecutable(
    ["cmd.exe", "cmd"],
    environment,
  );
  return cmd === undefined
    ? undefined
    : { kind: "cmd", executable: cmd };
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

interface RunRgOptions {
  readonly query: string;
  readonly path: string;
  readonly globs: readonly string[];
  readonly caseSensitive: boolean;
  readonly fixedStrings: boolean;
  readonly hidden: boolean;
  readonly maxResults: number;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputLimit: boolean;
  readonly timedOut: boolean;
}

async function captureProcess(
  executable: string,
  args: readonly string[],
  resolver: WorkspacePathResolver,
  environment: NodeJS.ProcessEnv,
  input?: string,
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, [...args], {
      cwd: resolver.rootPath,
      shell: false,
      windowsHide: true,
      stdio: input === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...environment,
      },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let outputLimit = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
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

    child.stdout?.on("data", (chunk: Buffer | string) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append(stderr, chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        outputLimit,
        timedOut,
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
        timedOut,
      });
    });

    if (input !== undefined && child.stdin !== null) {
      child.stdin.end(input, "utf8");
    }
  });
}

function assertFallbackResult(
  result: ProcessResult,
  backend: "pwsh" | "cmd",
  acceptedExitCodes: readonly number[],
): void {
  if (result.outputLimit) {
    throw new WorkspaceFileError(
      "rg_failed",
      "rg " + backend + " fallback output exceeded " +
        String(RG_MAX_OUTPUT_BYTES) + " bytes.",
    );
  }
  if (result.timedOut) {
    throw new WorkspaceFileError(
      "rg_failed",
      "rg " + backend + " fallback exceeded " +
        String(RG_TIMEOUT_MS) + " ms.",
    );
  }
  if (
    result.exitCode === null ||
    !acceptedExitCodes.includes(result.exitCode)
  ) {
    throw new WorkspaceFileError(
      "rg_failed",
      result.stderr ||
        "rg " + backend + " fallback exited with code " +
          String(result.exitCode) + ".",
    );
  }
}

function globToRegExp(rawGlob: string): RegExp {
  const glob = rawGlob
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/^\//u, "");

  let regexSource = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";

    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          regexSource += "(?:.*/)?";
        } else {
          regexSource += ".*";
        }
      } else {
        regexSource += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regexSource += "[^/]";
      continue;
    }

    regexSource += /[\\^$.*+?()[\]{}|]/u.test(char)
      ? "\\" + char
      : char;
  }

  const prefix =
    glob.includes("/")
      ? ""
      : "(?:.*/)?";

  return new RegExp(
    "^" + prefix + regexSource + "$",
    process.platform === "win32" ? "iu" : "u",
  );
}

function matchesUserGlobs(
  relativePath: string,
  globs: readonly string[],
): boolean {
  if (globs.length === 0) return true;

  const normalized = relativePath.replaceAll("\\", "/");
  const hasInclude = globs.some((glob) => !glob.startsWith("!"));
  let included = !hasInclude;

  for (const rawGlob of globs) {
    const excluded = rawGlob.startsWith("!");
    const glob = excluded ? rawGlob.slice(1) : rawGlob;
    if (glob.length > 0 && globToRegExp(glob).test(normalized)) {
      included = !excluded;
    }
  }

  return included;
}

function isReservedPath(
  resolver: WorkspacePathResolver,
  fullPath: string,
  relativePath: string,
): boolean {
  const segments = pathSegments(relativePath);
  return (
    segments[0]?.toLowerCase() === ".junius" ||
    segments.some((segment) => segment.toLowerCase() === ".git") ||
    resolver.isProtectedPath(fullPath)
  );
}

function isHiddenPath(relativePath: string): boolean {
  return pathSegments(relativePath).some((segment) => segment.startsWith("."));
}

async function fallbackFiles(
  resolver: WorkspacePathResolver,
  targetPath: string,
  options: RunRgOptions,
): Promise<readonly string[]> {
  const targetInfo = await stat(targetPath);
  const files: string[] = [];

  const add = (fullPath: string, explicit: boolean) => {
    const rel = relative(resolver.canonicalRootPath, fullPath);
    if (
      isReservedPath(resolver, fullPath, rel) ||
      (!explicit && !options.hidden && isHiddenPath(rel)) ||
      !matchesUserGlobs(rel, options.globs)
    ) {
      return;
    }
    files.push(fullPath);
  };

  if (targetInfo.isFile()) {
    add(targetPath, true);
    return files;
  }
  if (!targetInfo.isDirectory()) {
    return files;
  }

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const rel = relative(resolver.canonicalRootPath, fullPath);

      if (
        isReservedPath(resolver, fullPath, rel) ||
        (!options.hidden && entry.name.startsWith("."))
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        add(fullPath, false);
      }
    }
  };

  await visit(targetPath);
  return files;
}

function byteOffset(value: string, characterOffset: number): number {
  return Buffer.byteLength(value.slice(0, characterOffset), "utf8");
}

function lineSubmatches(
  text: string,
  options: RunRgOptions,
): readonly RgMatch["submatches"][number][] {
  if (options.fixedStrings) {
    const needle = options.caseSensitive
      ? options.query
      : options.query.toLocaleLowerCase();
    const haystack = options.caseSensitive
      ? text
      : text.toLocaleLowerCase();
    const matches: { start: number; end: number; text: string }[] = [];

    if (needle.length === 0) return matches;
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      const end = index + options.query.length;
      matches.push({
        start: byteOffset(text, index),
        end: byteOffset(text, end),
        text: text.slice(index, end),
      });
      from = end;
    }
    return matches;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(
      options.query,
      options.caseSensitive ? "gu" : "giu",
    );
  } catch (error) {
    throw new WorkspaceFileError(
      "rg_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const matches: { start: number; end: number; text: string }[] = [];
  for (;;) {
    const match = regex.exec(text);
    if (match === null) break;
    const value = match[0] ?? "";
    const end = match.index + value.length;
    matches.push({
      start: byteOffset(text, match.index),
      end: byteOffset(text, end),
      text: value,
    });
    if (value.length === 0) regex.lastIndex += 1;
  }
  return matches;
}

function fallbackMatch(
  pathText: string,
  line: number,
  lineText: string,
  resolver: WorkspacePathResolver,
  options: RunRgOptions,
): RgMatch | undefined {
  const submatches = lineSubmatches(lineText, options);
  if (submatches.length === 0) return undefined;

  return {
    path: relative(resolver.canonicalRootPath, pathText)
      .replaceAll("\\", "/"),
    line,
    text: lineText,
    submatches,
  };
}

async function runRipgrep(
  backend: Extract<SearchBackend, { readonly kind: "rg" }>,
  resolver: WorkspacePathResolver,
  targetPath: string,
  options: RunRgOptions,
  environment: NodeJS.ProcessEnv,
): Promise<readonly RgMatch[]> {
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

  args.push("--", options.query, targetPath);

  const result = await captureProcess(
    backend.executable,
    args,
    resolver,
    {
      ...environment,
      RIPGREP_CONFIG_PATH: "",
    },
  );

  if (result.outputLimit) {
    throw new WorkspaceFileError(
      "rg_failed",
      "rg output exceeded " + String(RG_MAX_OUTPUT_BYTES) + " bytes.",
    );
  }
  if (result.timedOut) {
    throw new WorkspaceFileError(
      "rg_failed",
      "rg exceeded " + String(RG_TIMEOUT_MS) + " ms.",
    );
  }

  // ripgrep uses 1 for "no matches".
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new WorkspaceFileError(
      "rg_failed",
      result.stderr ||
        "rg exited with code " + String(result.exitCode) + ".",
    );
  }

  return parseRgJson(
    result.stdout,
    resolver.rootPath,
    options.maxResults,
  );
}

const POWERSHELL_SEARCH_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$params = @{ Path = @($request.files); Pattern = [string]$request.query; AllMatches = $true; ErrorAction = "SilentlyContinue" }',
  'if ([bool]$request.fixedStrings) { $params.SimpleMatch = $true }',
  'if ([bool]$request.caseSensitive) { $params.CaseSensitive = $true }',
  '$count = 0',
  'Select-String @params | ForEach-Object {',
  '  [Console]::Out.WriteLine((@{ path = [string]$_.Path; line = [int]$_.LineNumber; text = [string]$_.Line } | ConvertTo-Json -Compress))',
  '  $count += 1',
  '  if ($count -ge [int]$request.maxResults) { break }',
  '}',
].join("; ");

async function runPowerShellFallback(
  backend: Extract<SearchBackend, { readonly kind: "pwsh" }>,
  resolver: WorkspacePathResolver,
  files: readonly string[],
  options: RunRgOptions,
  environment: NodeJS.ProcessEnv,
): Promise<readonly RgMatch[]> {
  if (files.length === 0) return [];

  const result = await captureProcess(
    backend.executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SEARCH_SCRIPT],
    resolver,
    environment,
    JSON.stringify({
      files,
      query: options.query,
      fixedStrings: options.fixedStrings,
      caseSensitive: options.caseSensitive,
      maxResults: options.maxResults,
    }),
  );
  assertFallbackResult(result, "pwsh", [0]);

  const matches: RgMatch[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null) continue;

    const value = row as { path?: unknown; line?: unknown; text?: unknown };
    if (
      typeof value.path !== "string" ||
      typeof value.line !== "number" ||
      typeof value.text !== "string"
    ) {
      continue;
    }

    const match = fallbackMatch(
      value.path,
      value.line,
      value.text,
      resolver,
      options,
    );
    if (match !== undefined) matches.push(match);
    if (matches.length >= options.maxResults) break;
  }
  return matches;
}

async function runCmdFallback(
  backend: Extract<SearchBackend, { readonly kind: "cmd" }>,
  resolver: WorkspacePathResolver,
  files: readonly string[],
  options: RunRgOptions,
  environment: NodeJS.ProcessEnv,
): Promise<readonly RgMatch[]> {
  const matches: RgMatch[] = [];

  for (const file of files) {
    const result = await captureProcess(
      backend.executable,
      [
        "/d",
        "/c",
        "type",
        file,
      ],
      resolver,
      environment,
    );
    assertFallbackResult(result, "cmd", [0]);

    const lines = result.stdout.split(/\r?\n/u);
    if (
      lines.at(-1) === "" &&
      /\r?\n$/u.test(result.stdout)
    ) {
      lines.pop();
    }

    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? "";
      const match = fallbackMatch(
        file,
        index + 1,
        lineText,
        resolver,
        options,
      );
      if (match !== undefined) matches.push(match);
      if (matches.length >= options.maxResults) {
        return matches;
      }
    }
  }

  return matches;
}

export async function runRg(
  resolver: WorkspacePathResolver,
  options: RunRgOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly RgMatch[]> {
  const backend = resolveSearchBackend(environment);
  if (backend === undefined) {
    throw new WorkspaceFileError(
      "rg_not_available",
      "No Workspace text-search backend is available. Expected rg, pwsh, or cmd.",
    );
  }

  const target = await resolver.existing(options.path);

  if (backend.kind === "rg") {
    return runRipgrep(
      backend,
      resolver,
      target.path,
      options,
      environment,
    );
  }

  const files = await fallbackFiles(
    resolver,
    target.path,
    options,
  );

  if (backend.kind === "pwsh") {
    return runPowerShellFallback(
      backend,
      resolver,
      files,
      options,
      environment,
    );
  }

  return runCmdFallback(
    backend,
    resolver,
    files,
    options,
    environment,
  );
}
