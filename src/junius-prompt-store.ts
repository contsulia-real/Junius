import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export const JUNIUS_PROMPT_NAMES = [
  "core",
  "engineering",
  "desktop",
  "browser",
] as const;

export type JuniusPromptName =
  (typeof JUNIUS_PROMPT_NAMES)[number];

export type JuniusPromptSource =
  "custom" | "default";

const PROMPT_FILENAMES:
  Readonly<
    Record<
      JuniusPromptName,
      string
    >
  > = {
    core: "core.md",
    engineering: "engineering.md",
    desktop: "desktop.md",
    browser: "browser.md",
  };

export interface JuniusPrompt {
  readonly name: JuniusPromptName;
  readonly filename: string;
  readonly source: JuniusPromptSource;
  readonly path: string;
  readonly text: string;
}

export function resolveJuniusPromptRoot(
  environment:
    NodeJS.ProcessEnv =
    process.env,
): string {
  const configuredLocalAppData =
    environment.LOCALAPPDATA
      ?.trim();
  const localAppData =
    configuredLocalAppData !==
      undefined &&
    configuredLocalAppData.length >
      0
      ? configuredLocalAppData
      : join(
          homedir(),
          "AppData",
          "Local",
        );

  return resolve(
    localAppData,
    "Junius",
    "prompts",
  );
}

function packagedPromptPath(
  name: JuniusPromptName,
): string {
  return fileURLToPath(
    new URL(
      `../prompts/${PROMPT_FILENAMES[name]}`,
      import.meta.url,
    ),
  );
}

function defaultPromptPath(
  name: JuniusPromptName,
  environment:
    NodeJS.ProcessEnv =
    process.env,
): string {
  const releasePath =
    packagedPromptPath(name);

  if (existsSync(releasePath)) {
    return releasePath;
  }

  const projectRoot =
    environment
      .JUNIUS_PROJECT_ROOT
      ?.trim();

  if (
    projectRoot !== undefined &&
    projectRoot.length > 0
  ) {
    const livePath = resolve(
      projectRoot,
      "prompts",
      PROMPT_FILENAMES[name],
    );

    if (existsSync(livePath)) {
      return livePath;
    }
  }

  return releasePath;
}

export function readDefaultJuniusPrompt(
  name: JuniusPromptName,
  environment:
    NodeJS.ProcessEnv =
    process.env,
): JuniusPrompt {
  const path = defaultPromptPath(
    name,
    environment,
  );

  return {
    name,
    filename:
      PROMPT_FILENAMES[name],
    source: "default",
    path,
    text: readFileSync(
      path,
      "utf8",
    ),
  };
}

export function readJuniusPrompt(
  name: JuniusPromptName,
  environment:
    NodeJS.ProcessEnv =
    process.env,
): JuniusPrompt {
  const filename =
    PROMPT_FILENAMES[name];
  const customPath = join(
    resolveJuniusPromptRoot(
      environment,
    ),
    filename,
  );

  if (existsSync(customPath)) {
    return {
      name,
      filename,
      source: "custom",
      path: customPath,
      text: readFileSync(
        customPath,
        "utf8",
      ),
    };
  }

  return readDefaultJuniusPrompt(
    name,
    environment,
  );
}

export function setJuniusPrompt(
  name: JuniusPromptName,
  text: string,
  environment:
    NodeJS.ProcessEnv =
    process.env,
): JuniusPrompt {
  const root =
    resolveJuniusPromptRoot(
      environment,
    );
  mkdirSync(
    root,
    { recursive: true },
  );

  const path = join(
    root,
    PROMPT_FILENAMES[name],
  );
  writeFileSync(
    path,
    text,
    "utf8",
  );

  return {
    name,
    filename:
      PROMPT_FILENAMES[name],
    source: "custom",
    path,
    text,
  };
}

export function resetJuniusPrompt(
  name: JuniusPromptName,
  environment:
    NodeJS.ProcessEnv =
    process.env,
): JuniusPrompt {
  rmSync(
    join(
      resolveJuniusPromptRoot(
        environment,
      ),
      PROMPT_FILENAMES[name],
    ),
    { force: true },
  );

  return readDefaultJuniusPrompt(
    name,
    environment,
  );
}
