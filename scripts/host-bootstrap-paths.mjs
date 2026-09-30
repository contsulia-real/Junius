import {
  join,
  resolve,
} from "node:path";

export const KEEP_RELEASES = 3;
export const MAX_CHECK_OUTPUT_CHARS =
  1024 * 1024;
export const HEALTH_TIMEOUT_MS =
  20_000;
export const SNAPSHOT_RETRIES = 3;

export const projectRoot = resolve(
  process.env.JUNIUS_PROJECT_ROOT ??
    process.cwd(),
);
export const runtimeRoot = resolve(
  process.env.JUNIUS_RUNTIME_ROOT ??
    join(
      projectRoot,
      ".junius",
      "runtime",
    ),
);
export const releasesRoot =
  join(runtimeRoot, "releases");
export const stagingRoot =
  join(runtimeRoot, "staging");
export const currentPath =
  join(runtimeRoot, "current.json");
export const sourceValidationPath =
  join(
    runtimeRoot,
    "source-validation.json",
  );
export const stableBootstrapRoot =
  join(
    runtimeRoot,
    "bootstrap",
  );
export const stableBootstrapPath =
  join(
    stableBootstrapRoot,
    "host-bootstrap.mjs",
  );

export const STABLE_BOOTSTRAP_FILES = [
  "host-bootstrap-paths.mjs",
  "host-bootstrap-source.mjs",
  "host-bootstrap-check.mjs",
  "host-bootstrap-releases.mjs",
  "host-bootstrap-host.mjs",
  "host-bootstrap.mjs",
];

export const SOURCE_CONTROL_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "install-lock.json",
  "tsconfig.json",
  ...STABLE_BOOTSTRAP_FILES.map(
    (file) => join("scripts", file),
  ),
  join(
    "scripts",
    "host-launcher.mjs",
  ),
  join(
    "scripts",
    "source-validation.mjs",
  ),
];
