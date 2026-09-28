import { lstat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceFileError } from "./workspace-file-error.js";

export function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertRelativeWorkspacePath(input: string): string {
  if (input.includes("\0") || isAbsolute(input)) {
    throw new WorkspaceFileError("invalid_path", `Invalid Workspace-relative path: ${input}`);
  }

  const normalized = input.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "..")) {
    throw new WorkspaceFileError("invalid_path", `Path traversal is not allowed: ${input}`);
  }

  return segments.length === 0 ? "." : segments.join("/");
}

export function pathSegments(
  relativePath: string,
): readonly string[] {
  return relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
}

function assertWorkspaceControlPathAllowed(
  relativePath: string,
): void {
  const segments = pathSegments(relativePath);
  const [first] = segments;

  if (first?.toLowerCase() === ".junius") {
    throw new WorkspaceFileError(
      "invalid_path",
      `Junius runtime/control state is reserved: ${relativePath}`,
    );
  }

  if (
    segments.some(
      (segment) => segment.toLowerCase() === ".git",
    )
  ) {
    throw new WorkspaceFileError(
      "invalid_path",
      `Git metadata is reserved for the Git capability: ${relativePath}`,
    );
  }
}

function assertWritableWorkspacePath(
  relativePath: string,
): void {
  const segments = pathSegments(relativePath);

  if (
    segments.some(
      (segment) => segment.toLowerCase() === ".git",
    )
  ) {
    throw new WorkspaceFileError(
      "invalid_path",
      `Writing Git metadata directly is not allowed: ${relativePath}`,
    );
  }
}

async function findExistingAncestor(path: string): Promise<string> {
  let current = path;

  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new WorkspaceFileError("path_not_found", `No existing ancestor for: ${path}`);
    }
    current = parent;
  }
}

export class WorkspacePathResolver {
  readonly rootPath: string;
  readonly canonicalRootPath: string;
  readonly protectedPaths: readonly string[];

  constructor(
    rootPath: string,
    protectedPaths: readonly string[] = [],
  ) {
    this.rootPath = resolve(rootPath);
    try {
      this.canonicalRootPath =
        realpathSync(this.rootPath);
    } catch {
      this.canonicalRootPath =
        this.rootPath;
    }

    const normalized = new Set<string>();
    for (const path of protectedPaths) {
      const lexical = resolve(path);
      normalized.add(lexical);
      try {
        normalized.add(realpathSync(lexical));
      } catch {
        // Missing protected paths remain guarded lexically.
      }
    }
    this.protectedPaths = [...normalized];
  }

  isProtectedPath(candidate: string): boolean {
    const resolvedCandidate = resolve(candidate);
    const comparableCandidate =
      process.platform === "win32"
        ? resolvedCandidate.toLowerCase()
        : resolvedCandidate;

    for (const protectedPath of this.protectedPaths) {
      const comparableRoot =
        process.platform === "win32"
          ? protectedPath.toLowerCase()
          : protectedPath;

      if (
        pathInside(
          comparableRoot,
          comparableCandidate,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  assertNotProtected(candidate: string): void {
    if (this.isProtectedPath(candidate)) {
      throw new WorkspaceFileError(
        "invalid_path",
        `Junius protected state is not accessible through Workspace files: ${candidate}`,
      );
    }
  }

  exclusionGlobs(): readonly string[] {
    const globs = [
      "!.junius",
      "!.junius/**",
      "!.git",
      "!.git/**",
      "!**/.git",
      "!**/.git/**",
    ];

    for (const protectedPath of this.protectedPaths) {
      const comparisonRoot =
        pathInside(
          this.rootPath,
          protectedPath,
        )
          ? this.rootPath
          : pathInside(
                this.canonicalRootPath,
                protectedPath,
              )
            ? this.canonicalRootPath
            : undefined;

      if (comparisonRoot === undefined) {
        continue;
      }

      const rel = relative(
        comparisonRoot,
        protectedPath,
      ).replaceAll("\\", "/");
      if (!rel || rel === ".") {
        continue;
      }

      globs.push(`!${rel}`, `!${rel}/**`);
    }

    return globs;
  }

  async existing(input: string): Promise<{
    readonly path: string;
    readonly relativePath: string;
  }> {
    const relativePath = assertRelativeWorkspacePath(input);
    assertWorkspaceControlPathAllowed(relativePath);
    const lexical = resolve(this.rootPath, relativePath);

    if (!pathInside(this.rootPath, lexical)) {
      throw new WorkspaceFileError("path_outside_workspace", input);
    }
    this.assertNotProtected(lexical);

    let canonical: string;
    try {
      canonical = realpathSync(lexical);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new WorkspaceFileError("path_not_found", input);
      }
      throw error;
    }

    if (
      !pathInside(
        this.canonicalRootPath,
        canonical,
      )
    ) {
      throw new WorkspaceFileError("path_outside_workspace", input);
    }

    this.assertNotProtected(canonical);
    const canonicalRelative =
      relative(
        this.canonicalRootPath,
        canonical,
      ) || ".";
    assertWorkspaceControlPathAllowed(canonicalRelative);

    return {
      path: canonical,
      relativePath: canonicalRelative,
    };
  }

  async writable(input: string): Promise<{
    readonly path: string;
    readonly relativePath: string;
    readonly exists: boolean;
  }> {
    const relativePath = assertRelativeWorkspacePath(input);
    assertWorkspaceControlPathAllowed(relativePath);
    assertWritableWorkspacePath(relativePath);
    const lexical = resolve(this.rootPath, relativePath);

    if (!pathInside(this.rootPath, lexical)) {
      throw new WorkspaceFileError("path_outside_workspace", input);
    }
    this.assertNotProtected(lexical);

    try {
      const canonical = realpathSync(lexical);
      if (
        !pathInside(
          this.canonicalRootPath,
          canonical,
        )
      ) {
        throw new WorkspaceFileError("path_outside_workspace", input);
      }

      this.assertNotProtected(canonical);
      assertWorkspaceControlPathAllowed(
        relative(
          this.canonicalRootPath,
          canonical,
        ) || ".",
      );

      const info = await lstat(lexical);
      if (info.isSymbolicLink()) {
        throw new WorkspaceFileError(
          "invalid_path",
          `Writing through a symbolic link is not allowed: ${input}`,
        );
      }

      return {
        path: lexical,
        relativePath,
        exists: true,
      };
    } catch (error) {
      if (
        error instanceof WorkspaceFileError ||
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }

    const ancestor = await findExistingAncestor(dirname(lexical));
    const canonicalAncestor = realpathSync(ancestor);
    if (
      !pathInside(
        this.canonicalRootPath,
        canonicalAncestor,
      )
    ) {
      throw new WorkspaceFileError("path_outside_workspace", input);
    }

    this.assertNotProtected(canonicalAncestor);
    assertWorkspaceControlPathAllowed(
      relative(
        this.canonicalRootPath,
        canonicalAncestor,
      ) || ".",
    );

    return {
      path: lexical,
      relativePath,
      exists: false,
    };
  }
}

export function getResolver(
  manager: WorkspaceManager,
  workspace: string,
  protectedPaths: readonly string[] = [],
): WorkspacePathResolver {
  const profile = manager.get(workspace);
  if (profile === undefined) {
    throw new WorkspaceFileError(
      "workspace_not_registered",
      `Workspace is not registered: ${workspace}`,
    );
  }

  return new WorkspacePathResolver(
    profile.rootPath,
    protectedPaths,
  );
}
