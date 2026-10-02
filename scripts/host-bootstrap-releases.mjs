import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  KEEP_RELEASES,
  SNAPSHOT_RETRIES,
  STABLE_BOOTSTRAP_FILES,
  currentPath,
  projectRoot,
  releasesRoot,
  runtimeRoot,
  sourceValidationPath,
  stableBootstrapRoot,
  stagingRoot,
} from "./host-bootstrap-paths.mjs";
import {
  runCheck,
} from "./host-bootstrap-check.mjs";
import {
  copySnapshot,
  exists,
  fingerprintSource,
} from "./host-bootstrap-source.mjs";

async function releaseRuntime(
  releaseRoot,
) {
  const compiledHostPath =
    join(
      releaseRoot,
      "runtime",
      "src",
      "host.js",
    );
  const compiledWorkerPath =
    join(
      releaseRoot,
      "runtime",
      "src",
      "worker-entry.js",
    );

  if (
    await exists(
      compiledHostPath,
    ) &&
    await exists(
      compiledWorkerPath,
    )
  ) {
    return {
      hostPath:
        compiledHostPath,
      workerPath:
        compiledWorkerPath,
      compiled: true,
    };
  }

  const sourceHostPath =
    join(
      releaseRoot,
      "src",
      "host.ts",
    );
  const sourceWorkerPath =
    join(
      releaseRoot,
      "src",
      "worker-entry.ts",
    );

  if (
    await exists(
      sourceHostPath,
    ) &&
    await exists(
      sourceWorkerPath,
    )
  ) {
    return {
      hostPath:
        sourceHostPath,
      workerPath:
        sourceWorkerPath,
      compiled: false,
    };
  }

  return undefined;
}

export async function readCurrentRelease() {
  try {
    const parsed =
      JSON.parse(
        await readFile(
          currentPath,
          "utf8",
        ),
      );

    if (
      parsed?.version !== 1 ||
      typeof parsed
        .releaseId !==
        "string" ||
      typeof parsed
        .fingerprint !==
        "string"
    ) {
      return undefined;
    }

    const releaseRoot =
      join(
        releasesRoot,
        parsed.releaseId,
      );
    const runtime =
      await releaseRuntime(
        releaseRoot,
      );

    if (
      runtime === undefined
    ) {
      return undefined;
    }

    return {
      releaseId:
        parsed.releaseId,
      fingerprint:
        parsed.fingerprint,
      createdAt:
        typeof parsed
          .createdAt ===
          "string"
          ? parsed.createdAt
          : undefined,
      releaseRoot,
      ...runtime,
    };
  } catch {
    return undefined;
  }
}

async function readReusableSourceValidation(
  fingerprint,
) {
  try {
    const parsed =
      JSON.parse(
        await readFile(
          sourceValidationPath,
          "utf8",
        ),
      );

    if (
      parsed?.version !== 1 ||
      parsed.fingerprint !==
        fingerprint ||
      parsed.nodeVersion !==
        process.version ||
      parsed.platform !==
        process.platform ||
      parsed.arch !==
        process.arch ||
      typeof parsed
        .validatedAt !==
        "string"
    ) {
      return undefined;
    }

    return {
      validatedAt:
        parsed.validatedAt,
    };
  } catch {
    return undefined;
  }
}

async function copyStableBootstrapFile(
  file,
) {
  const source =
    join(
      projectRoot,
      "scripts",
      file,
    );
  const target =
    join(
      stableBootstrapRoot,
      file,
    );
  const temporary =
    target +
    "." +
    randomUUID() +
    ".tmp";

  await cp(
    source,
    temporary,
    { force: true },
  );
  await rename(
    temporary,
    target,
  );
}

export async function promoteValidatedBootstrap() {
  await mkdir(
    stableBootstrapRoot,
    {
      recursive: true,
    },
  );

  const companions =
    STABLE_BOOTSTRAP_FILES
      .filter(
        (file) =>
          file !==
          "host-bootstrap.mjs",
      );

  for (
    const file of
    companions
  ) {
    await copyStableBootstrapFile(
      file,
    );
  }

  await copyStableBootstrapFile(
    "host-bootstrap.mjs",
  );
}

export async function writeCurrentRelease(
  release,
) {
  await mkdir(
    runtimeRoot,
    {
      recursive: true,
    },
  );

  const temporaryPath =
    currentPath +
    "." +
    randomUUID() +
    ".tmp";

  await writeFile(
    temporaryPath,
    JSON.stringify(
      {
        version: 1,
        releaseId:
          release.releaseId,
        fingerprint:
          release.fingerprint,
        createdAt:
          release.createdAt,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await rename(
    temporaryPath,
    currentPath,
  );
}

export async function pruneReleases(
  currentReleaseId,
) {
  let entries;

  try {
    entries =
      await readdir(
        releasesRoot,
        {
          withFileTypes: true,
        },
      );
  } catch {
    return;
  }

  const candidates = [];

  for (
    const entry of
    entries
  ) {
    if (
      !entry.isDirectory()
    ) {
      continue;
    }

    const path =
      join(
        releasesRoot,
        entry.name,
      );

    try {
      candidates.push({
        id: entry.name,
        path,
        modifiedAt:
          (
            await stat(path)
          ).mtimeMs,
      });
    } catch {
      // Ignore entries that disappeared concurrently.
    }
  }

  candidates.sort(
    (left, right) =>
      right.modifiedAt -
      left.modifiedAt,
  );

  const keep =
    new Set(
      candidates
        .slice(
          0,
          KEEP_RELEASES,
        )
        .map(
          (entry) =>
            entry.id,
        ),
    );
  keep.add(
    currentReleaseId,
  );

  await Promise.allSettled(
    candidates
      .filter(
        (entry) =>
          !keep.has(
            entry.id,
          ),
      )
      .map(
        (entry) =>
          rm(
            entry.path,
            {
              recursive: true,
              force: true,
            },
          ),
      ),
  );
}

export async function prepareValidatedRelease(
  allowCachedValidation = true,
) {
  await mkdir(
    releasesRoot,
    { recursive: true },
  );
  await mkdir(
    stagingRoot,
    { recursive: true },
  );

  for (
    let attempt = 1;
    attempt <=
      SNAPSHOT_RETRIES;
    attempt += 1
  ) {
    const fingerprintBefore =
      await fingerprintSource(
        projectRoot,
      );
    const stageRoot =
      join(
        stagingRoot,
        randomUUID(),
      );

    try {
      await copySnapshot(
        stageRoot,
      );

      const stagedFingerprint =
        await fingerprintSource(
          stageRoot,
        );

      if (
        stagedFingerprint !==
        fingerprintBefore
      ) {
        console.error(
          "[bootstrap] source changed while snapshotting; retrying.",
        );
        continue;
      }

      const cachedValidation =
        allowCachedValidation
          ? await readReusableSourceValidation(
              fingerprintBefore,
            )
          : undefined;
      const check =
        cachedValidation ===
        undefined
          ? await runCheck()
          : {
              ok: true,
              exitCode: 0,
              signal: null,
              stdout: "",
              stderr: "",
              durationMs: 0,
              cached: true,
            };

      if (
        cachedValidation !==
        undefined
      ) {
        console.error(
          "[bootstrap] reusing full source validation " +
          `from ${cachedValidation.validatedAt}.`,
        );
      }

      if (!check.ok) {
        return {
          ok: false,
          reason:
            "source_check_failed: " +
            `exit=${String(check.exitCode)} signal=${String(check.signal)}`,
          check,
        };
      }

      const fingerprintAfter =
        await fingerprintSource(
          projectRoot,
        );

      if (
        fingerprintAfter !==
        fingerprintBefore
      ) {
        console.error(
          "[bootstrap] source changed during validation; retrying.",
        );
        continue;
      }

      const releaseId =
        `${Date.now()}-${fingerprintBefore.slice(0, 12)}`;
      const releaseRoot =
        join(
          releasesRoot,
          releaseId,
        );
      const createdAt =
        new Date()
          .toISOString();

      await writeFile(
        join(
          stageRoot,
          ".release.json",
        ),
        JSON.stringify(
          {
            version: 1,
            releaseId,
            fingerprint:
              fingerprintBefore,
            createdAt,
            checkDurationMs:
              check.durationMs,
            checkCached:
              check.cached ===
              true,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await rename(
        stageRoot,
        releaseRoot,
      );

      const runtime =
        await releaseRuntime(
          releaseRoot,
        );
      if (
        runtime === undefined
      ) {
        throw new Error(
          "validated_release_runtime_missing",
        );
      }

      return {
        ok: true,
        release: {
          releaseId,
          fingerprint:
            fingerprintBefore,
          createdAt,
          releaseRoot,
          ...runtime,
        },
        check,
      };
    } finally {
      await rm(
        stageRoot,
        {
          recursive: true,
          force: true,
        },
      ).catch(
        () => {},
      );
    }
  }

  return {
    ok: false,
    reason:
      "source_changed_during_validation: retry limit reached",
  };
}
