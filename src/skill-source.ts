import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import {
  executePreparedProcess,
} from "./process-executor.js";
import { SkillError } from "./skill-errors.js";

const MAX_REMOTE_BYTES =
  128 * 1024 * 1024;
const MAX_ARCHIVE_LIST_BYTES =
  8 * 1024 * 1024;
const ARCHIVE_TIMEOUT_MS =
  60_000;

export interface MaterializedSkillSource {
  readonly rootPath: string;
  readonly suggestedSubpath?: string;
  cleanup(): Promise<void>;
}

export interface SkillSourceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly environment?:
    NodeJS.ProcessEnv;
  readonly tempRoot?: string;
}

function remoteUrl(
  source: string,
): URL | undefined {
  if (
    !/^https?:\/\//iu.test(
      source,
    )
  ) {
    return undefined;
  }

  try {
    const parsed =
      new URL(source);
    if (
      parsed.protocol !==
        "http:" &&
      parsed.protocol !==
        "https:"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    throw new SkillError(
      "invalid_source",
      `Invalid remote skill source URL: ${source}`,
    );
  }
}

function githubHeaders(
  environment:
    NodeJS.ProcessEnv,
): HeadersInit {
  const token =
    environment.GITHUB_TOKEN ??
    environment.GH_TOKEN;

  return {
    accept:
      "application/vnd.github+json",
    "user-agent":
      "Junius",
    ...(token
      ? {
          authorization:
            `Bearer ${token}`,
        }
      : {}),
  };
}

async function githubJson(
  fetchImpl: typeof fetch,
  environment:
    NodeJS.ProcessEnv,
  url: string,
  allowNotFound = false,
): Promise<
  | Record<string, unknown>
  | undefined
> {
  const response =
    await fetchImpl(url, {
      headers:
        githubHeaders(
          environment,
        ),
      redirect: "follow",
    });

  if (
    allowNotFound &&
    response.status === 404
  ) {
    return undefined;
  }

  if (!response.ok) {
    throw new SkillError(
      "remote_fetch_failed",
      `GitHub request failed with HTTP ${response.status}: ${url}`,
    );
  }

  let value: unknown;
  try {
    value =
      await response.json();
  } catch {
    throw new SkillError(
      "remote_fetch_failed",
      `GitHub returned invalid JSON: ${url}`,
    );
  }

  if (
    typeof value !==
      "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new SkillError(
      "remote_fetch_failed",
      `GitHub returned an unexpected response: ${url}`,
    );
  }

  return value as
    Record<string, unknown>;
}

async function downloadToFile(
  fetchImpl: typeof fetch,
  environment:
    NodeJS.ProcessEnv,
  url: string,
  target: string,
  github = false,
): Promise<void> {
  const response =
    await fetchImpl(url, {
      headers: github
        ? githubHeaders(
            environment,
          )
        : {
            "user-agent":
              "Junius",
          },
      redirect: "follow",
    });

  if (!response.ok) {
    throw new SkillError(
      "remote_fetch_failed",
      `Remote skill source failed with HTTP ${response.status}: ${url}`,
    );
  }

  const declared =
    response.headers.get(
      "content-length",
    );
  if (
    declared !== null &&
    Number(declared) >
      MAX_REMOTE_BYTES
  ) {
    throw new SkillError(
      "remote_fetch_failed",
      `Remote skill source exceeds ${MAX_REMOTE_BYTES} bytes.`,
    );
  }

  if (
    response.body === null
  ) {
    throw new SkillError(
      "remote_fetch_failed",
      `Remote skill source returned no body: ${url}`,
    );
  }

  const handle =
    await open(target, "wx");
  let total = 0;

  try {
    const reader =
      response.body.getReader();
    for (;;) {
      const { value, done } =
        await reader.read();
      if (done) break;
      if (value === undefined) {
        continue;
      }

      total += value.byteLength;
      if (
        total >
        MAX_REMOTE_BYTES
      ) {
        await reader.cancel();
        throw new SkillError(
          "remote_fetch_failed",
          `Remote skill source exceeds ${MAX_REMOTE_BYTES} bytes.`,
        );
      }

      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
}

function tarExecutable(
  environment:
    NodeJS.ProcessEnv,
): string {
  const systemRoot =
    environment.SystemRoot ??
    environment.SYSTEMROOT ??
    process.env.SystemRoot ??
    process.env.SYSTEMROOT;

  return systemRoot
    ? join(
        systemRoot,
        "System32",
        "tar.exe",
      )
    : "tar.exe";
}

function assertArchiveEntry(
  entry: string,
): void {
  const normalized =
    entry
      .replaceAll("\\", "/")
      .replace(/^\.\//u, "");

  if (
    normalized.length === 0 ||
    normalized === "."
  ) {
    return;
  }

  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(
      normalized,
    ) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment === "..",
      )
  ) {
    throw new SkillError(
      "archive_extract_failed",
      `Archive contains an unsafe path: ${entry}`,
    );
  }
}

async function runTar(
  environment:
    NodeJS.ProcessEnv,
  args: readonly string[],
  cwd: string,
  outputLimit =
    MAX_ARCHIVE_LIST_BYTES,
): Promise<string> {
  const result =
    await executePreparedProcess(
      {
        executable:
          tarExecutable(
            environment,
          ),
        args,
        cwd,
        env: {
          ...process.env,
          ...environment,
        },
        windowsHide: true,
      },
      ARCHIVE_TIMEOUT_MS,
      outputLimit,
    );

  if (!result.ok) {
    throw new SkillError(
      "archive_extract_failed",
      [
        result.message,
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

async function extractArchive(
  archivePath: string,
  tempRoot: string,
  environment:
    NodeJS.ProcessEnv,
): Promise<string> {
  const destination =
    join(
      tempRoot,
      "extracted",
    );
  await mkdir(
    destination,
    { recursive: true },
  );

  const listing =
    await runTar(
      environment,
      ["-tf", archivePath],
      tempRoot,
    );

  for (
    const line of
    listing.split(/\r?\n/u)
  ) {
    if (line.length > 0) {
      assertArchiveEntry(line);
    }
  }

  const verboseListing =
    await runTar(
      environment,
      ["-tvf", archivePath],
      tempRoot,
    );

  for (
    const line of
    verboseListing.split(/\r?\n/u)
  ) {
    if (
      line.startsWith("l") ||
      line.startsWith("h")
    ) {
      throw new SkillError(
        "archive_extract_failed",
        "Skill archives may not contain symbolic or hard links.",
      );
    }
  }

  await runTar(
    environment,
    [
      "-xf",
      archivePath,
      "-C",
      destination,
    ],
    tempRoot,
    2 * 1024 * 1024,
  );

  return destination;
}

async function oneArchiveRoot(
  extracted: string,
): Promise<string> {
  const entries =
    await readdir(
      extracted,
      {
        withFileTypes: true,
      },
    );

  if (
    entries.length === 1 &&
    entries[0]?.isDirectory()
  ) {
    return join(
      extracted,
      entries[0].name,
    );
  }

  return extracted;
}

function decodedSegments(
  pathname: string,
): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(
          segment,
        );
      } catch {
        throw new SkillError(
          "invalid_source",
          "GitHub URL contains an invalid escaped path segment.",
        );
      }
    });
}

interface GithubSource {
  readonly owner: string;
  readonly repo: string;
  readonly route:
    | "root"
    | "tree"
    | "blob";
  readonly remainder:
    readonly string[];
}

function parseGithubSource(
  url: URL,
): GithubSource | undefined {
  if (
    url.hostname.toLowerCase() !==
      "github.com" &&
    url.hostname.toLowerCase() !==
      "www.github.com"
  ) {
    return undefined;
  }

  const segments =
    decodedSegments(
      url.pathname,
    );
  if (
    segments.length < 2
  ) {
    return undefined;
  }

  const owner =
    segments[0] ?? "";
  const repo =
    (segments[1] ?? "")
      .replace(/\.git$/u, "");
  const action =
    segments[2];

  if (
    !owner ||
    !repo
  ) {
    return undefined;
  }

  if (
    action === undefined
  ) {
    return {
      owner,
      repo,
      route: "root",
      remainder: [],
    };
  }

  if (
    action !== "tree" &&
    action !== "blob"
  ) {
    return undefined;
  }

  return {
    owner,
    repo,
    route: action,
    remainder:
      segments.slice(3),
  };
}

async function resolveGithubRef(
  fetchImpl: typeof fetch,
  environment:
    NodeJS.ProcessEnv,
  source: GithubSource,
): Promise<{
  readonly ref: string;
  readonly subpath?: string;
}> {
  const base =
    `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;

  if (
    source.route ===
    "root"
  ) {
    const metadata =
      await githubJson(
        fetchImpl,
        environment,
        base,
      );
    const branch =
      metadata?.default_branch;
    if (
      typeof branch !==
        "string" ||
      branch.length === 0
    ) {
      throw new SkillError(
        "remote_fetch_failed",
        "GitHub repository did not report a default branch.",
      );
    }
    return {
      ref: branch,
    };
  }

  if (
    source.remainder.length <
    1
  ) {
    throw new SkillError(
      "invalid_source",
      "GitHub tree/blob URL must include a ref.",
    );
  }

  for (
    let count =
      source.remainder.length;
    count >= 1;
    count -= 1
  ) {
    const candidate =
      source.remainder
        .slice(0, count)
        .join("/");
    const commit =
      await githubJson(
        fetchImpl,
        environment,
        base +
          "/commits/" +
          encodeURIComponent(
            candidate,
          ),
        true,
      );

    if (
      commit === undefined
    ) {
      continue;
    }

    const remaining =
      source.remainder
        .slice(count);

    if (
      source.route ===
      "blob"
    ) {
      if (
        remaining.length < 1
      ) {
        throw new SkillError(
          "invalid_source",
          "GitHub blob URL must identify a file inside the repository.",
        );
      }
      remaining.pop();
    }

    return {
      ref: candidate,
      ...(remaining.length === 0
        ? {}
        : {
            subpath:
              remaining.join("/"),
          }),
    };
  }

  throw new SkillError(
    "invalid_source",
    "Could not resolve the GitHub ref from the supplied URL.",
  );
}

function combineSubpaths(
  first?: string,
  second?: string,
): string | undefined {
  const values =
    [first, second]
      .filter(
        (value): value is string =>
          value !== undefined &&
          value.trim().length > 0,
      );

  if (
    values.length === 0
  ) {
    return undefined;
  }

  const joined =
    values
      .join("/")
      .replaceAll("\\", "/");
  const segments =
    joined
      .split("/")
      .filter(Boolean);

  if (
    isAbsolute(joined) ||
    segments.some(
      (segment) =>
        segment === "..",
    )
  ) {
    throw new SkillError(
      "invalid_source",
      `Invalid source subpath: ${joined}`,
    );
  }

  return segments.join("/");
}

export async function materializeSkillSource(
  source: string,
  options:
    SkillSourceOptions = {},
  sourceBasePath?: string,
  requestedSubpath?: string,
): Promise<MaterializedSkillSource> {
  const fetchImpl =
    options.fetchImpl ?? fetch;
  const environment =
    options.environment ??
    process.env;
  const baseTemp =
    options.tempRoot ??
    tmpdir();

  const url =
    remoteUrl(source);

  if (url === undefined) {
    const local =
      isAbsolute(source)
        ? resolve(source)
        : sourceBasePath
          ? resolve(
              sourceBasePath,
              source,
            )
          : undefined;

    if (
      local === undefined
    ) {
      throw new SkillError(
        "invalid_source",
        "Relative local skill sources require source_workspace.",
      );
    }

    let info;
    try {
      info =
        await lstat(local);
    } catch {
      throw new SkillError(
        "invalid_source",
        `Local skill source does not exist: ${source}`,
      );
    }

    if (
      info.isDirectory()
    ) {
      return {
        rootPath: local,
        suggestedSubpath:
          combineSubpaths(
            undefined,
            requestedSubpath,
          ),
        async cleanup() {},
      };
    }

    if (!info.isFile()) {
      throw new SkillError(
        "invalid_source",
        `Local skill source must be a directory or archive file: ${source}`,
      );
    }

    const temp =
      await mkdtemp(
        join(
          baseTemp,
          "junius-skill-source-",
        ),
      );
    try {
      const extracted =
        await extractArchive(
          local,
          temp,
          environment,
        );
      return {
        rootPath:
          await oneArchiveRoot(
            extracted,
          ),
        suggestedSubpath:
          combineSubpaths(
            undefined,
            requestedSubpath,
          ),
        async cleanup() {
          await rm(
            temp,
            {
              recursive: true,
              force: true,
            },
          );
        },
      };
    } catch (error) {
      await rm(
        temp,
        {
          recursive: true,
          force: true,
        },
      );
      throw error;
    }
  }

  const temp =
    await mkdtemp(
      join(
        baseTemp,
        "junius-skill-source-",
      ),
    );

  try {
    const github =
      parseGithubSource(url);
    let downloadUrl =
      url.toString();
    let githubArchive =
      false;
    let urlSubpath:
      string | undefined;

    if (
      github !== undefined
    ) {
      const resolved =
        await resolveGithubRef(
          fetchImpl,
          environment,
          github,
        );
      downloadUrl =
        `https://api.github.com/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}/tarball/${encodeURIComponent(resolved.ref)}`;
      githubArchive = true;
      urlSubpath =
        resolved.subpath;
    }

    const archive =
      join(
        temp,
        "source-" +
          randomUUID() +
          ".archive",
      );
    await downloadToFile(
      fetchImpl,
      environment,
      downloadUrl,
      archive,
      githubArchive,
    );

    const extracted =
      await extractArchive(
        archive,
        temp,
        environment,
      );

    return {
      rootPath:
        githubArchive
          ? await oneArchiveRoot(
              extracted,
            )
          : extracted,
      suggestedSubpath:
        combineSubpaths(
          urlSubpath,
          requestedSubpath,
        ),
      async cleanup() {
        await rm(
          temp,
          {
            recursive: true,
            force: true,
          },
        );
      },
    };
  } catch (error) {
    await rm(
      temp,
      {
        recursive: true,
        force: true,
      },
    );
    throw error;
  }
}
