import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";

const VALIDATION_VERSION = 1;
const PENDING_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;
const projectRoot = process.cwd();
const runtimeRoot = resolve(
  process.env.JUNIUS_RUNTIME_ROOT ??
    join(projectRoot, ".junius", "runtime"),
);
const pendingRoot = join(
  runtimeRoot,
  "source-validation.pending",
);
const legacyPendingPath = join(
  runtimeRoot,
  "source-validation.pending.json",
);
const validatedPath = join(
  runtimeRoot,
  "source-validation.json",
);

function transactionKey() {
  const explicit =
    process.env
      .JUNIUS_SOURCE_VALIDATION_TRANSACTION
      ?.trim();

  const raw =
    explicit && explicit.length > 0
      ? explicit
      : `ppid-${process.ppid}`;

  return raw.replace(
    /[^A-Za-z0-9._-]/gu,
    "_",
  );
}

function pendingPath() {
  return join(
    pendingRoot,
    transactionKey() + ".json",
  );
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root, relativeRoot = "") {
  const directory = join(root, relativeRoot);
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const relativePath = relativeRoot
      ? join(relativeRoot, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      if (
        entry.name ===
        "__pycache__"
      ) {
        continue;
      }

      files.push(...await walkFiles(root, relativePath));
      continue;
    }

    if (
      entry.isFile() &&
      !entry.name.endsWith(
        ".pyc",
      )
    ) {
      files.push(relativePath);
    }
  }

  return files;
}

async function fingerprintSource(root) {
  const hash = createHash("sha256");
  const sources = [];

  for (const directory of ["src", "python", "prompts"]) {
    if (!(await exists(join(root, directory)))) continue;

    const files = await walkFiles(join(root, directory));
    for (const file of files) {
      sources.push(join(directory, file));
    }
  }

  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "install-lock.json",
    "tsconfig.json",
    join("scripts", "host-bootstrap.mjs"),
    join("scripts", "host-launcher.mjs"),
    join("scripts", "source-validation.mjs"),
  ]) {
    if (await exists(join(root, file))) {
      sources.push(file);
    }
  }

  sources.sort((left, right) =>
    left.localeCompare(right, "en"),
  );

  for (const relativePath of sources) {
    const data = await readFile(join(root, relativePath));
    hash.update(relativePath.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(data);
    hash.update("\0");
  }

  return hash.digest("hex");
}

function environmentStamp(fingerprint) {
  return {
    version: VALIDATION_VERSION,
    fingerprint,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath =
    path + "." + randomUUID() + ".tmp";
  await writeFile(
    temporaryPath,
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
  await rename(temporaryPath, path);
}

async function prunePendingTransactions() {
  let entries;
  try {
    entries = await readdir(
      pendingRoot,
      { withFileTypes: true },
    );
  } catch {
    return;
  }

  const cutoff =
    Date.now() - PENDING_MAX_AGE_MS;

  await Promise.allSettled(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".json"),
      )
      .map(async (entry) => {
        const path = join(
          pendingRoot,
          entry.name,
        );

        let startedAt;
        try {
          const pending = JSON.parse(
            await readFile(path, "utf8"),
          );
          startedAt = Date.parse(
            pending?.startedAt ?? "",
          );
        } catch {
          startedAt = Number.NaN;
        }

        if (
          !Number.isFinite(startedAt) ||
          startedAt < cutoff
        ) {
          await rm(path, { force: true });
        }
      }),
  );
}

async function begin() {
  const fingerprint =
    await fingerprintSource(projectRoot);

  await prunePendingTransactions();
  await rm(
    legacyPendingPath,
    { force: true },
  );

  await writeJsonAtomic(
    pendingPath(),
    {
      ...environmentStamp(fingerprint),
      transactionId: randomUUID(),
      transactionKey:
        transactionKey(),
      startedAt:
        new Date().toISOString(),
    },
  );
}

async function commit() {
  const path = pendingPath();

  let pending;
  try {
    pending = JSON.parse(
      await readFile(path, "utf8"),
    );
  } catch {
    await rm(path, { force: true });
    throw new Error(
      "source_validation_begin_missing",
    );
  }

  const fingerprint =
    await fingerprintSource(projectRoot);
  const expected = environmentStamp(fingerprint);

  if (
    pending?.version !== expected.version ||
    pending?.fingerprint !== expected.fingerprint ||
    pending?.nodeVersion !== expected.nodeVersion ||
    pending?.platform !== expected.platform ||
    pending?.arch !== expected.arch
  ) {
    await rm(path, { force: true });
    throw new Error(
      "source_changed_during_full_validation",
    );
  }

  await writeJsonAtomic(validatedPath, {
    ...expected,
    validatedAt: new Date().toISOString(),
  });
  await rm(path, { force: true });
}

const command = process.argv[2];
if (command === "begin") {
  await begin();
} else if (command === "commit") {
  await commit();
} else {
  throw new Error(
    "usage: node scripts/source-validation.mjs begin|commit",
  );
}
