import { rm } from "node:fs/promises";
import {
  join,
  resolve,
} from "node:path";
import {
  assertProcess,
  isFile,
  runProcess,
} from "./install-process.mjs";

const PYTHON_PROBE =
  "import json,sys; print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3])}))";

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
