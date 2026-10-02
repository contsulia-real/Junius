import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
} from "node:fs/promises";
import {
  dirname,
  join,
} from "node:path";
import {
  SOURCE_CONTROL_FILES,
  projectRoot,
} from "./host-bootstrap-paths.mjs";

export async function exists(
  path,
) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(
  root,
  relativeRoot = "",
) {
  const directory =
    join(root, relativeRoot);
  const entries =
    await readdir(
      directory,
      {
        withFileTypes: true,
      },
    );
  const files = [];

  for (const entry of entries) {
    const relativePath =
      relativeRoot
        ? join(
            relativeRoot,
            entry.name,
          )
        : entry.name;

    if (entry.isDirectory()) {
      if (
        entry.name ===
        "__pycache__"
      ) {
        continue;
      }

      files.push(
        ...await walkFiles(
          root,
          relativePath,
        ),
      );
      continue;
    }

    if (
      entry.isFile() &&
      !entry.name.endsWith(
        ".pyc",
      )
    ) {
      files.push(
        relativePath,
      );
    }
  }

  return files;
}

export async function fingerprintSource(
  root,
) {
  const hash =
    createHash("sha256");
  const sources = [];

  for (
    const directory of [
      "src",
      "python",
      "prompts",
      "runtime",
    ]
  ) {
    if (
      !await exists(
        join(root, directory),
      )
    ) {
      continue;
    }

    const files =
      await walkFiles(
        join(root, directory),
      );
    for (const file of files) {
      sources.push(
        join(directory, file),
      );
    }
  }

  for (
    const file of
    SOURCE_CONTROL_FILES
  ) {
    if (
      await exists(
        join(root, file),
      )
    ) {
      sources.push(file);
    }
  }

  sources.sort(
    (left, right) =>
      left.localeCompare(
        right,
        "en",
      ),
  );

  for (
    const relativePath of
    sources
  ) {
    const data =
      await readFile(
        join(
          root,
          relativePath,
        ),
      );
    hash.update(
      relativePath.replaceAll(
        "\\",
        "/",
      ),
    );
    hash.update("\0");
    hash.update(data);
    hash.update("\0");
  }

  return hash.digest("hex");
}

export async function copySnapshot(
  destination,
) {
  await mkdir(
    destination,
    { recursive: true },
  );

  for (
    const directory of [
      "src",
      "python",
      "prompts",
      "runtime",
    ]
  ) {
    const sourceRoot =
      join(
        projectRoot,
        directory,
      );
    if (
      await exists(
        sourceRoot,
      )
    ) {
      await cp(
        sourceRoot,
        join(
          destination,
          directory,
        ),
        {
          recursive: true,
          force: true,
        },
      );
    }
  }

  for (
    const file of
    SOURCE_CONTROL_FILES
  ) {
    const sourcePath =
      join(
        projectRoot,
        file,
      );
    if (
      await exists(
        sourcePath,
      )
    ) {
      const target =
        join(
          destination,
          file,
        );
      await mkdir(
        dirname(target),
        {
          recursive: true,
        },
      );
      await cp(
        sourcePath,
        target,
        {
          force: true,
        },
      );
    }
  }

  const projectNodeModules =
    join(
      projectRoot,
      "node_modules",
    );

  if (
    await exists(
      projectNodeModules,
    )
  ) {
    await symlink(
      projectNodeModules,
      join(
        destination,
        "node_modules",
      ),
      process.platform ===
      "win32"
        ? "junction"
        : "dir",
    );
  }
}
