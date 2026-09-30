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

const COPY_DIRECTORIES = [
  "bin",
  "prompts",
  "python",
  "scripts",
  "src",
];

const COPY_FILES = [
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
  "install-lock.json",
  "requirements-desktop.txt",
  "tsconfig.json",
];

export async function copyApplication(
  packageRoot,
  appRoot,
) {
  await mkdir(
    appRoot,
    { recursive: true },
  );

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
        "--include=dev",
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
        "npm install --include=dev --no-audit --no-fund",
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
      "--include=dev",
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
  const npmCli =
    await resolveNpmCli(
      nodeExecutable,
    );

  if (
    npmCli !== undefined
  ) {
    await assertProcess(
      "Junius validation",
      nodeExecutable,
      [
        npmCli,
        "run",
        "check",
      ],
      {
        cwd: appRoot,
        env: environment,
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
      "Junius validation",
      join(
        systemRoot,
        "System32",
        "cmd.exe",
      ),
      [
        "/d",
        "/s",
        "/c",
        "npm run check",
      ],
      {
        cwd: appRoot,
        env: environment,
      },
    );
    return;
  }

  await assertProcess(
    "Junius validation",
    "npm",
    [
      "run",
      "check",
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
