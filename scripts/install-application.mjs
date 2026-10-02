import {
  cp,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import {
  assertProcess,
  exists,
  isFile,
} from "./install-process.mjs";

export async function resolveNpmCli(
  nodeExecutable =
    process.execPath,
  environment =
    process.env,
) {
  const candidates = [];

  if (
    typeof environment
      .npm_execpath ===
      "string" &&
    /npm-cli\.js$/iu.test(
      environment.npm_execpath,
    )
  ) {
    candidates.push(
      environment.npm_execpath,
    );
  }

  candidates.push(
    join(
      dirname(
        nodeExecutable,
      ),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  );

  for (
    const candidate of
    candidates
  ) {
    if (
      await isFile(candidate)
    ) {
      return resolve(
        candidate,
      );
    }
  }

  return undefined;
}

const PROMPT_FILES = [
  "core.md",
  "engineering.md",
  "desktop.md",
  "browser.md",
];

const COPY_DIRECTORIES = [
  "bin",
  "prompts",
  "python",
  "scripts",
  "runtime",
];

const COPY_FILES = [
  "CHANGELOG.md",
  "icon.svg",
  "install.ps1",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "package.json",
  "install-lock.json",
  "requirements-desktop.txt",
];

const STALE_SOURCE_PATHS = [
  "src",
  "AGENTS.md",
  "tsconfig.json",
  "tsconfig.runtime.json",
];

export async function migrateLegacyPromptOverrides(
  appRoot,
  promptRoot,
) {
  const legacyPromptRoot =
    join(
      appRoot,
      "prompts",
    );

  if (
    !await exists(
      legacyPromptRoot,
    )
  ) {
    return [];
  }

  await mkdir(
    promptRoot,
    { recursive: true },
  );

  const migrated = [];

  for (
    const file of
    PROMPT_FILES
  ) {
    const source = join(
      legacyPromptRoot,
      file,
    );
    const target = join(
      promptRoot,
      file,
    );

    if (
      !await isFile(source) ||
      await exists(target)
    ) {
      continue;
    }

    await cp(
      source,
      target,
      { force: false },
    );
    migrated.push(file);
  }

  return migrated;
}

export async function copyApplication(
  packageRoot,
  appRoot,
) {
  await mkdir(
    appRoot,
    { recursive: true },
  );

  const compiledRelease =
    await isFile(
      join(
        packageRoot,
        "runtime",
        "src",
        "host.js",
      ),
    );
  const legacySourceInstall =
    await isFile(
      join(
        appRoot,
        "src",
        "host.ts",
      ),
    );

  if (
    compiledRelease &&
    legacySourceInstall
  ) {
    await rm(
      join(
        appRoot,
        ".junius",
        "runtime",
      ),
      {
        recursive: true,
        force: true,
      },
    );
  }

  for (
    const stalePath of
    STALE_SOURCE_PATHS
  ) {
    await rm(
      join(
        appRoot,
        stalePath,
      ),
      {
        recursive: true,
        force: true,
      },
    );
  }

  for (
    const directory of
    COPY_DIRECTORIES
  ) {
    const source =
      join(
        packageRoot,
        directory,
      );
    if (
      !await exists(source)
    ) {
      continue;
    }

    const target =
      join(
        appRoot,
        directory,
      );
    await rm(
      target,
      {
        recursive: true,
        force: true,
      },
    );
    await cp(
      source,
      target,
      {
        recursive: true,
        force: true,
      },
    );
  }

  for (
    const file of
    COPY_FILES
  ) {
    const source =
      join(
        packageRoot,
        file,
      );
    if (
      !await exists(source)
    ) {
      continue;
    }

    await cp(
      source,
      join(
        appRoot,
        file,
      ),
      {
        force: true,
      },
    );
  }

  const installLock =
    join(
      packageRoot,
      "install-lock.json",
    );
  if (
    await exists(
      installLock,
    )
  ) {
    await cp(
      installLock,
      join(
        appRoot,
        "npm-shrinkwrap.json",
      ),
      {
        force: true,
      },
    );
  }
}

export async function installNodeDependencies(
  nodeExecutable,
  appRoot,
) {
  const npmCli =
    await resolveNpmCli(
      nodeExecutable,
    );

  if (
    npmCli !== undefined
  ) {
    await assertProcess(
      "Node dependency installation",
      nodeExecutable,
      [
        npmCli,
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: appRoot,
      },
    );
    return;
  }

  if (
    process.platform ===
    "win32"
  ) {
    const systemRoot =
      process.env.SystemRoot ??
      process.env.SYSTEMROOT ??
      "C:\\Windows";
    await assertProcess(
      "Node dependency installation",
      join(
        systemRoot,
        "System32",
        "cmd.exe",
      ),
      [
        "/d",
        "/s",
        "/c",
        "npm install --omit=dev --no-audit --no-fund",
      ],
      {
        cwd: appRoot,
      },
    );
    return;
  }

  await assertProcess(
    "Node dependency installation",
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: appRoot,
    },
  );
}

function installedValidationEnvironment(
  appRoot,
) {
  const environment = {};

  for (
    const [key, value] of
    Object.entries(
      process.env,
    )
  ) {
    if (
      key
        .toUpperCase()
        .startsWith(
          "JUNIUS_",
        )
    ) {
      continue;
    }

    environment[key] =
      value;
  }

  environment
    .JUNIUS_PROJECT_ROOT =
    appRoot;

  return environment;
}

export async function validateInstalledApp(
  nodeExecutable,
  appRoot,
) {
  const environment =
    installedValidationEnvironment(
      appRoot,
    );

  await assertProcess(
    "Junius compiled runtime validation",
    nodeExecutable,
    [
      "scripts/validate-installed-runtime.mjs",
      "runtime",
    ],
    {
      cwd: appRoot,
      env: environment,
    },
  );

  await assertProcess(
    "Junius CLI validation",
    nodeExecutable,
    [
      "bin/junius.mjs",
      "--help",
    ],
    {
      cwd: appRoot,
      env: environment,
    },
  );
}

export async function readInstalledPackage(
  appRoot,
) {
  return JSON.parse(
    await readFile(
      join(
        appRoot,
        "package.json",
      ),
      "utf8",
    ),
  );
}
