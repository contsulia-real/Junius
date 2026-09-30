import {
  mkdir,
  rm,
} from "node:fs/promises";
import {
  projectRoot,
  runtimeRoot,
} from "./host-bootstrap-paths.mjs";
import {
  fingerprintSource,
} from "./host-bootstrap-source.mjs";
import {
  prepareValidatedRelease,
  promoteValidatedBootstrap,
  pruneReleases,
  readCurrentRelease,
  writeCurrentRelease,
} from "./host-bootstrap-releases.mjs";
import {
  finishStartedHost,
  forwardSignal,
  startRelease,
  stopChild,
} from "./host-bootstrap-host.mjs";

async function main() {
  await mkdir(
    runtimeRoot,
    { recursive: true },
  );

  const current =
    await readCurrentRelease();
  const liveFingerprint =
    await fingerprintSource(
      projectRoot,
    );

  const forceValidation =
    process.env
      .JUNIUS_BOOTSTRAP_TEST_FORCE_VALIDATE ===
    "1";

  if (
    !forceValidation &&
    current !== undefined &&
    current.fingerprint ===
      liveFingerprint
  ) {
    console.error(
      `[bootstrap] source matches validated release ${current.releaseId}`,
    );

    const child =
      await startRelease(
        current,
      );
    await finishStartedHost(
      child,
    );
    return;
  }

  console.error(
    "[bootstrap] source changed; creating validated release candidate.",
  );

  const prepared =
    await prepareValidatedRelease(
      !forceValidation,
    );

  if (prepared.ok) {
    let child;

    try {
      child =
        await startRelease(
          prepared.release,
        );
      await promoteValidatedBootstrap();
      await writeCurrentRelease(
        prepared.release,
      );
      await pruneReleases(
        prepared.release
          .releaseId,
      );

      console.error(
        `[bootstrap] promoted validated release ${prepared.release.releaseId} after ${prepared.check.durationMs} ms ${prepared.check.cached === true ? "cached " : ""}check.`,
      );

      await finishStartedHost(
        child,
      );
      return;
    } catch (error) {
      if (
        child !==
        undefined
      ) {
        await stopChild(
          child,
        );
      }

      await rm(
        prepared.release
          .releaseRoot,
        {
          recursive: true,
          force: true,
        },
      ).catch(
        () => {},
      );

      console.error(
        "[bootstrap] candidate release failed to start: " +
          String(error),
      );
    }
  } else {
    console.error(
      "[bootstrap] candidate rejected: " +
        prepared.reason,
    );

    if (
      prepared.check
        ?.stderr
    ) {
      console.error(
        prepared.check
          .stderr,
      );
    }
  }

  const fallback =
    await readCurrentRelease();

  if (
    fallback ===
    undefined
  ) {
    throw new Error(
      "no_last_known_good_release_available",
    );
  }

  console.error(
    `[bootstrap] falling back to last-known-good release ${fallback.releaseId}`,
  );

  const fallbackChild =
    await startRelease(
      fallback,
    );
  await finishStartedHost(
    fallbackChild,
  );
}

for (
  const signal of [
    "SIGINT",
    "SIGTERM",
  ]
) {
  process.once(
    signal,
    () => {
      forwardSignal(
        signal,
      );
    },
  );
}

main().catch(
  (error) => {
    console.error(
      "[bootstrap] fatal: " +
        String(error),
    );
    process.exitCode = 1;
  },
);
