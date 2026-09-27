import type { SourceCheckResult } from "./source-check.js";
import type { ManagedWorker } from "./worker-process.js";

export type ReloadCandidateResult =
  | {
      readonly ok: true;
      readonly candidate: ManagedWorker;
      readonly check: SourceCheckResult;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly check?: SourceCheckResult;
    };

export interface ReloadCandidateOptions {
  readonly canPromote: () => boolean;
  readonly validate: () => Promise<SourceCheckResult>;
  readonly spawnWorker: () => Promise<ManagedWorker>;
  readonly reloadWorkerConfiguration: (
    worker: ManagedWorker,
  ) => Promise<void>;
  readonly configurationEpoch: () => number;
}

export async function prepareReloadCandidate(
  options: ReloadCandidateOptions,
): Promise<ReloadCandidateResult> {
  if (!options.canPromote()) {
    return {
      ok: false,
      reason: "candidate_promotion_blocked",
    };
  }

  let check: SourceCheckResult;
  try {
    check = await options.validate();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `source_check_failed: ${message}`,
    };
  }

  if (!check.ok) {
    return {
      ok: false,
      reason:
        `source_check_failed: exit=${String(check.exitCode)} ` +
        `signal=${String(check.signal)}`,
      check,
    };
  }

  if (!options.canPromote()) {
    return {
      ok: false,
      reason: "candidate_promotion_blocked",
      check,
    };
  }

  const configurationEpochBeforeSpawn =
    options.configurationEpoch();

  let candidate: ManagedWorker;
  try {
    candidate = await options.spawnWorker();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `candidate_startup_failed: ${message}`,
      check,
    };
  }

  if (!options.canPromote()) {
    await candidate.close().catch(() => {});
    return {
      ok: false,
      reason: "candidate_promotion_blocked",
      check,
    };
  }

  if (
    configurationEpochBeforeSpawn !==
    options.configurationEpoch()
  ) {
    try {
      let observedEpoch: number;
      do {
        observedEpoch = options.configurationEpoch();
        await options.reloadWorkerConfiguration(candidate);
      } while (
        observedEpoch !== options.configurationEpoch()
      );
    } catch (error) {
      await candidate.close().catch(() => {});
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason:
          `candidate_configuration_sync_failed: ${message}`,
        check,
      };
    }
  }

  return {
    ok: true,
    candidate,
    check,
  };
}
