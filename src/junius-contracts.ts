import {
  createHash,
} from "node:crypto";
import {
  readDefaultJuniusPrompt,
  readJuniusPrompt,
  type JuniusPromptName,
} from "./junius-prompt-store.js";

export const JUNIUS_CONTRACT_MODES = [
  "engineering",
  "desktop",
  "browser",
] as const;

export type JuniusContractMode =
  (typeof JUNIUS_CONTRACT_MODES)[number];

export const JUNIUS_CORE_CONTRACT =
  readDefaultJuniusPrompt(
    "core",
  ).text;

export const JUNIUS_ENGINEERING_CONTRACT =
  readDefaultJuniusPrompt(
    "engineering",
  ).text;

export const JUNIUS_DESKTOP_CONTRACT =
  readDefaultJuniusPrompt(
    "desktop",
  ).text;

export const JUNIUS_BROWSER_CONTRACT =
  readDefaultJuniusPrompt(
    "browser",
  ).text;

const JUNIUS_SOURCE_TEST_INSTANCE_NOTICE = `# JUNIUS SOURCE TEST INSTANCE

This connection is a source-tree test instance of Junius.

Use it only when the current user request explicitly asks to test, exercise, validate, or debug the Junius source build. For ordinary Junius work, use the installed Junius connection.

Do not select this source-test connection merely because a task concerns the Junius repository.
`;

export function isJuniusDevelopmentInstance(
  environment:
    NodeJS.ProcessEnv =
    process.env,
): boolean {
  return environment
    .JUNIUS_INSTANCE_ROLE ===
    "development";
}

export function resolveJuniusCoreContract(
  environment:
    NodeJS.ProcessEnv =
    process.env,
): string {
  const core =
    readJuniusPrompt(
      "core",
      environment,
    ).text;

  if (
    !isJuniusDevelopmentInstance(
      environment,
    )
  ) {
    return core;
  }

  return (
    JUNIUS_SOURCE_TEST_INSTANCE_NOTICE +
    "\n" +
    core
  );
}

const CONTRACT_PROMPTS:
  Readonly<
    Record<
      JuniusContractMode,
      JuniusPromptName
    >
  > = {
    engineering: "engineering",
    desktop: "desktop",
    browser: "browser",
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
  environment:
    NodeJS.ProcessEnv =
    process.env,
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
        readJuniusPrompt(
          CONTRACT_PROMPTS[
            mode
          ],
          environment,
        ).text;

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
