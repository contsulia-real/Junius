import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import {
  resolve,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";

export const JUNIUS_CONTRACT_MODES = [
  "engineering",
  "desktop",
  "browser",
] as const;

export type JuniusContractMode =
  (typeof JUNIUS_CONTRACT_MODES)[number];

function readContract(
  filename: string,
): string {
  const releasePath =
    fileURLToPath(
      new URL(
        `../prompts/${filename}`,
        import.meta.url,
      ),
    );

  if (existsSync(releasePath)) {
    return readFileSync(
      releasePath,
      "utf8",
    );
  }

  // Migration bridge for last-known-good bootstraps created
  // before prompt files became part of validated release snapshots.
  const projectRoot =
    process.env
      .JUNIUS_PROJECT_ROOT
      ?.trim();

  if (projectRoot !== undefined && projectRoot.length > 0) {
    const livePath = resolve(
      projectRoot,
      "prompts",
      filename,
    );

    if (existsSync(livePath)) {
      return readFileSync(
        livePath,
        "utf8",
      );
    }
  }

  return readFileSync(
    releasePath,
    "utf8",
  );
}

export const JUNIUS_CORE_CONTRACT =
  readContract("core.md");

export const JUNIUS_ENGINEERING_CONTRACT =
  readContract("engineering.md");

export const JUNIUS_DESKTOP_CONTRACT =
  readContract("desktop.md");

export const JUNIUS_BROWSER_CONTRACT =
  readContract("browser.md");

const CONTRACTS: Readonly<
  Record<
    JuniusContractMode,
    string
  >
> = {
  engineering:
    JUNIUS_ENGINEERING_CONTRACT,
  desktop:
    JUNIUS_DESKTOP_CONTRACT,
  browser:
    JUNIUS_BROWSER_CONTRACT,
};

export interface JuniusLoadedContract {
  readonly mode:
    JuniusContractMode;
  readonly digest: string;
  readonly text: string;
}

export function loadJuniusContracts(
  modes:
    readonly JuniusContractMode[],
): readonly JuniusLoadedContract[] {
  const seen =
    new Set<
      JuniusContractMode
    >();

  return modes
    .filter((mode) => {
      if (seen.has(mode)) {
        return false;
      }
      seen.add(mode);
      return true;
    })
    .map((mode) => {
      const text =
        CONTRACTS[mode];
      return {
        mode,
        digest:
          createHash("sha256")
            .update(
              text,
              "utf8",
            )
            .digest("hex"),
        text,
      };
    });
}
