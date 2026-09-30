import {
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  packageRootFromImportMeta,
  windowsInstallPaths,
} from "./install-paths.mjs";
import {
  isFile as defaultIsFile,
  runProcess as defaultRunProcess,
} from "./install-process.mjs";
import {
  assertWindowsPlatform,
} from "./windows-only.mjs";

function updaterError(
  label,
  result,
) {
  const detail = [
    result.stderr?.trim(),
    result.stdout?.trim(),
  ]
    .filter(Boolean)
    .join("\n");

  return new Error(
    label +
      " failed" +
      (
        detail.length > 0
          ? ":\n" + detail
          : "."
      ),
  );
}

async function packageVersion(
  packageRoot,
) {
  const parsed =
    JSON.parse(
      await readFile(
        join(
          packageRoot,
          "package.json",
        ),
        "utf8",
      ),
    );

  if (
    typeof parsed.version !==
      "string" ||
    parsed.version.length === 0
  ) {
    throw new Error(
      "Junius package.json must define a non-empty version.",
    );
  }

  return parsed.version;
}

function powershellExecutable(
  environment,
) {
  const systemRoot =
    environment.SystemRoot ??
    environment.SYSTEMROOT;

  if (
    typeof systemRoot ===
      "string" &&
    systemRoot.length > 0
  ) {
    return join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }

  return "powershell.exe";
}

async function resolveBootstrapPath(
  packageRoot,
  environment,
  isFile,
) {
  const installed =
    join(
      windowsInstallPaths(
        environment,
      ).appRoot,
      "install.ps1",
    );

  if (
    environment
      .JUNIUS_PROJECT_ROOT !==
      undefined &&
    await isFile(installed)
  ) {
    return installed;
  }

  const packaged =
    join(
      packageRoot,
      "install.ps1",
    );

  if (
    await isFile(packaged)
  ) {
    return packaged;
  }

  throw new Error(
    "Junius update bootstrap install.ps1 was not found in the installed app or current package.",
  );
}

function parseCheckOutput(
  stdout,
) {
  const lines =
    stdout
      .split(/\r?\n/u)
      .map(
        (line) =>
          line.trim(),
      )
      .filter(Boolean);

  let parsed;

  for (
    let index =
      lines.length - 1;
    index >= 0;
    index -= 1
  ) {
    try {
      parsed =
        JSON.parse(
          lines[index],
        );
      break;
    } catch {
      // Ignore non-JSON PowerShell output.
    }
  }

  if (
    parsed === undefined ||
    typeof parsed !==
      "object" ||
    parsed === null ||
    typeof parsed
      .currentVersion !==
      "string" ||
    typeof parsed
      .latestVersion !==
      "string" ||
    typeof parsed
      .releaseTag !==
      "string" ||
    typeof parsed
      .updateAvailable !==
      "boolean"
  ) {
    throw new Error(
      "Junius update check returned an invalid response.",
    );
  }

  return {
    currentVersion:
      parsed.currentVersion,
    latestVersion:
      parsed.latestVersion,
    releaseTag:
      parsed.releaseTag,
    updateAvailable:
      parsed.updateAvailable,
  };
}

export async function checkJuniusUpdate(
  options = {},
) {
  const platform =
    options.platform ??
    process.platform;
  assertWindowsPlatform(
    platform,
  );

  const environment =
    options.environment ??
    process.env;
  const root =
    options.packageRoot ??
    packageRootFromImportMeta(
      import.meta.url,
    );
  const currentVersion =
    options.currentVersion ??
    await packageVersion(root);
  const runProcess =
    options.runProcess ??
    defaultRunProcess;
  const isFile =
    options.isFile ??
    defaultIsFile;
  const script =
    options.bootstrapPath ??
    await resolveBootstrapPath(
      root,
      environment,
      isFile,
    );

  const result =
    await runProcess(
      powershellExecutable(
        environment,
      ),
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-CheckOnly",
        "-CurrentVersion",
        currentVersion,
        "-Json",
      ],
      {
        env: environment,
      },
    );

  if (!result.ok) {
    throw updaterError(
      "Junius update check",
      result,
    );
  }

  return parseCheckOutput(
    result.stdout,
  );
}

export async function updateJunius(
  options = {},
) {
  const platform =
    options.platform ??
    process.platform;
  assertWindowsPlatform(
    platform,
  );

  const environment =
    options.environment ??
    process.env;

  if (
    environment
      .JUNIUS_INSTANCE_ROLE ===
    "development"
  ) {
    throw new Error(
      "The source-test Junius connection cannot update the installed Junius copy. Use the installed Junius connection or run the installed CLI.",
    );
  }

  const root =
    options.packageRoot ??
    packageRootFromImportMeta(
      import.meta.url,
    );
  const currentVersion =
    options.currentVersion ??
    await packageVersion(root);
  const runProcess =
    options.runProcess ??
    defaultRunProcess;
  const isFile =
    options.isFile ??
    defaultIsFile;
  const script =
    options.bootstrapPath ??
    await resolveBootstrapPath(
      root,
      environment,
      isFile,
    );

  const check =
    await checkJuniusUpdate({
      platform,
      environment,
      packageRoot: root,
      currentVersion,
      bootstrapPath:
        script,
      runProcess,
    });

  if (!check.updateAvailable) {
    return {
      ...check,
      updated: false,
      restartRequired:
        false,
      installerOutput: "",
    };
  }

  const result =
    await runProcess(
      powershellExecutable(
        environment,
      ),
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Version",
        check.latestVersion,
      ],
      {
        env: environment,
      },
    );

  if (!result.ok) {
    throw updaterError(
      "Junius update",
      result,
    );
  }

  return {
    ...check,
    updated: true,
    restartRequired:
      environment
        .JUNIUS_PROJECT_ROOT !==
      undefined,
    installerOutput:
      result.stdout.trim(),
  };
}
