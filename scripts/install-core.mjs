import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON_PROBE =
  "import json,sys; print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3])}))";

export function packageRootFromImportMeta(
  importMetaUrl,
) {
  return resolve(
    dirname(
      fileURLToPath(importMetaUrl),
    ),
    "..",
  );
}

export function windowsInstallPaths(
  environment = process.env,
) {
  const localAppData =
    environment.LOCALAPPDATA ??
    join(
      homedir(),
      "AppData",
      "Local",
    );
  const root = join(
    localAppData,
    "Junius",
  );

  return {
    root,
    appRoot: join(root, "app"),
    startupScript: join(
      root,
      "start-junius.vbs",
    ),
    venvRoot: join(
      root,
      "app",
      ".venv",
    ),
  };
}

export function supportedPythonVersion(
  version,
) {
  return (
    Array.isArray(version) &&
    version.length >= 2 &&
    Number.isInteger(version[0]) &&
    Number.isInteger(version[1]) &&
    (
      version[0] > 3 ||
      (
        version[0] === 3 &&
        version[1] >= 10
      )
    )
  );
}

export function vbsString(value) {
  return String(value)
    .replaceAll('"', '""');
}

export function windowsStartupVbs(
  nodeExecutable,
  launcherPath,
  appRoot,
) {
  const command =
    `"${nodeExecutable}" "${launcherPath}"`;

  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${vbsString(appRoot)}"`,
    `shell.Run "${vbsString(command)}", 0, False`,
    "",
  ].join("\r\n");
}

export function windowsRunValue(
  wscriptExecutable,
  startupScript,
) {
  return (
    `"${wscriptExecutable}" //B //Nologo "${startupScript}"`
  );
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(path) {
  try {
    return (
      await stat(path)
    ).isFile();
  } catch {
    return false;
  }
}

export async function runProcess(
  executable,
  args,
  options = {},
) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      executable,
      args,
      {
        cwd: options.cwd,
        env:
          options.env ??
          process.env,
        shell: false,
        windowsHide: true,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    );

    const finish = (
      result,
    ) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        ...result,
        stdout,
        stderr,
      });
    };

    child.stdout.setEncoding(
      "utf8",
    );
    child.stderr.setEncoding(
      "utf8",
    );
    child.stdout.on(
      "data",
      (chunk) => {
        stdout += chunk;
      },
    );
    child.stderr.on(
      "data",
      (chunk) => {
        stderr += chunk;
      },
    );
    child.once(
      "error",
      (error) => {
        finish({
          ok: false,
          exitCode: null,
          signal: null,
          error,
        });
      },
    );
    child.once(
      "close",
      (
        exitCode,
        signal,
      ) => {
        finish({
          ok:
            exitCode === 0,
          exitCode,
          signal,
        });
      },
    );
  });
}

function lastNonEmptyLine(
  value,
) {
  return value
    .split(/\r?\n/u)
    .map((line) =>
      line.trim(),
    )
    .filter(Boolean)
    .at(-1);
}

async function probePythonCandidate(
  executable,
  prefixArgs,
) {
  const probe =
    await runProcess(
      executable,
      [
        ...prefixArgs,
        "-c",
        PYTHON_PROBE,
      ],
    );

  if (!probe.ok) {
    return undefined;
  }

  const line =
    lastNonEmptyLine(
      probe.stdout,
    );
  if (line === undefined) {
    return undefined;
  }

  try {
    const parsed =
      JSON.parse(line);
    if (
      typeof parsed
        .executable !==
        "string" ||
      !supportedPythonVersion(
        parsed.version,
      )
    ) {
      return undefined;
    }

    const executablePath =
      resolve(
        parsed.executable,
      );
    if (
      !await isFile(
        executablePath,
      )
    ) {
      return undefined;
    }

    return {
      executable:
        executablePath,
      version:
        parsed.version,
    };
  } catch {
    return undefined;
  }
}

export async function findExistingPython() {
  const candidates =
    process.platform ===
    "win32"
      ? [
          {
            executable:
              "py.exe",
            prefixArgs: [
              "-3",
            ],
          },
          {
            executable:
              "python.exe",
            prefixArgs: [],
          },
          {
            executable:
              "python3.exe",
            prefixArgs: [],
          },
        ]
      : [
          {
            executable:
              "python3",
            prefixArgs: [],
          },
          {
            executable:
              "python",
            prefixArgs: [],
          },
        ];

  for (
    const candidate of
    candidates
  ) {
    const resolved =
      await probePythonCandidate(
        candidate.executable,
        candidate.prefixArgs,
      );
    if (
      resolved !==
      undefined
    ) {
      return resolved;
    }
  }

  return undefined;
}

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
  "python",
  "scripts",
  "src",
];

const COPY_FILES = [
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

async function assertProcess(
  label,
  executable,
  args,
  options,
) {
  const result =
    await runProcess(
      executable,
      args,
      options,
    );

  if (!result.ok) {
    const detail = [
      result.stderr.trim(),
      result.stdout.trim(),
    ]
      .filter(Boolean)
      .join("\n");

    throw new Error(
      `${label} failed` +
      (
        detail
          ? `:\n${detail}`
          : "."
      ),
    );
  }

  return result;
}

export async function ensureVenv(
  systemPython,
  appRoot,
) {
  const venvPython =
    process.platform ===
    "win32"
      ? join(
          appRoot,
          ".venv",
          "Scripts",
          "python.exe",
        )
      : join(
          appRoot,
          ".venv",
          "bin",
          "python",
        );

  if (
    await isFile(
      venvPython,
    )
  ) {
    const probe =
      await runProcess(
        venvPython,
        ["--version"],
      );
    if (probe.ok) {
      return venvPython;
    }

    await rm(
      join(
        appRoot,
        ".venv",
      ),
      {
        recursive: true,
        force: true,
      },
    );
  }

  await assertProcess(
    "Python venv creation",
    systemPython,
    [
      "-m",
      "venv",
      join(
        appRoot,
        ".venv",
      ),
    ],
    {
      cwd: appRoot,
    },
  );

  if (
    !await isFile(
      venvPython,
    )
  ) {
    throw new Error(
      "Python venv was created without a usable interpreter.",
    );
  }

  return venvPython;
}

export async function installPythonRequirements(
  venvPython,
  appRoot,
) {
  await assertProcess(
    "Python dependency installation",
    venvPython,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "-r",
      join(
        appRoot,
        "requirements-desktop.txt",
      ),
    ],
    {
      cwd: appRoot,
    },
  );
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

export async function writeWindowsStartup(
  paths,
  nodeExecutable,
) {
  const systemRoot =
    process.env.SystemRoot ??
    process.env.SYSTEMROOT ??
    "C:\\Windows";
  const wscript =
    join(
      systemRoot,
      "System32",
      "wscript.exe",
    );
  const reg =
    join(
      systemRoot,
      "System32",
      "reg.exe",
    );
  const launcherPath =
    join(
      paths.appRoot,
      "scripts",
      "host-launcher.mjs",
    );

  const script =
    windowsStartupVbs(
      nodeExecutable,
      launcherPath,
      paths.appRoot,
    );

  await mkdir(
    paths.root,
    { recursive: true },
  );
  await writeFile(
    paths.startupScript,
    script,
    "utf8",
  );

  await assertProcess(
    "Windows startup registration",
    reg,
    [
      "ADD",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "Junius",
      "/t",
      "REG_SZ",
      "/d",
      windowsRunValue(
        wscript,
        paths.startupScript,
      ),
      "/f",
    ],
  );

  return {
    wscript,
    launcherPath,
  };
}

export async function readHostHealth(
  port = 8787,
) {
  try {
    const response =
      await fetch(
        `http://127.0.0.1:${port}/__junius/host-health`,
        {
          signal:
            AbortSignal.timeout(
              750,
            ),
        },
      );
    if (!response.ok) {
      return undefined;
    }

    const body =
      await response.json();

    if (
      body?.ok !== true ||
      typeof body
        .activeWorkerId !==
        "string" ||
      !Number.isSafeInteger(
        body.pid,
      ) ||
      body.pid <= 0
    ) {
      return undefined;
    }

    return {
      pid: body.pid,
      activeWorkerId:
        body.activeWorkerId,
      releaseId:
        typeof body.releaseId ===
        "string"
          ? body.releaseId
          : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function hostHealthy(
  port = 8787,
) {
  return (
    await readHostHealth(
      port,
    )
  ) !== undefined;
}

async function stopWindowsProcessTree(
  pid,
) {
  const systemRoot =
    process.env.SystemRoot ??
    process.env.SYSTEMROOT ??
    "C:\\Windows";
  const taskkill =
    join(
      systemRoot,
      "System32",
      "taskkill.exe",
    );

  await assertProcess(
    "Junius Host restart",
    taskkill,
    [
      "/PID",
      String(pid),
      "/T",
      "/F",
    ],
  );
}

export async function stopInstalledJunius(
  options = {},
) {
  const port =
    options.port ?? 8787;
  const timeoutMs =
    options.timeoutMs ??
    15_000;
  const stopProcessTree =
    options.stopProcessTree ??
    stopWindowsProcessTree;

  const health =
    await readHostHealth(
      port,
    );

  if (health === undefined) {
    return {
      wasRunning: false,
    };
  }

  await stopProcessTree(
    health.pid,
  );

  const deadline =
    Date.now() + timeoutMs;

  while (
    Date.now() <
    deadline
  ) {
    if (
      await readHostHealth(
        port,
      ) === undefined
    ) {
      return {
        wasRunning: true,
        pid: health.pid,
      };
    }

    await new Promise(
      (resolvePromise) =>
        setTimeout(
          resolvePromise,
          100,
        ),
    );
  }

  throw new Error(
    "Existing Junius Host did not stop before restart.",
  );
}

export async function startInstalledJunius(
  startup,
  timeoutMs =
    120_000,
) {
  if (
    await hostHealthy()
  ) {
    return {
      alreadyRunning: true,
    };
  }

  const child = spawn(
    startup.wscript,
    [
      "//B",
      "//Nologo",
      startup.startupScript,
    ],
    {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.unref();

  const deadline =
    Date.now() + timeoutMs;

  while (
    Date.now() <
    deadline
  ) {
    if (
      await hostHealthy()
    ) {
      return {
        alreadyRunning: false,
      };
    }

    await new Promise(
      (resolvePromise) =>
        setTimeout(
          resolvePromise,
          250,
        ),
    );
  }

  throw new Error(
    "Junius did not become healthy after installation.",
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
