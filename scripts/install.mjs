import {
  copyApplication,
  ensureVenv,
  findExistingPython,
  installNodeDependencies,
  installPythonRequirements,
  packageRootFromImportMeta,
  startInstalledJunius,
  stopInstalledJunius,
  validateInstalledApp,
  windowsInstallPaths,
  writeWindowsStartup,
} from "./install-core.mjs";

function versionText(
  version,
) {
  return version.join(".");
}

export async function installJunius() {
  if (
    process.platform !==
    "win32"
  ) {
    throw new Error(
      "Junius one-command installation currently supports Windows only.",
    );
  }

  const packageRoot =
    packageRootFromImportMeta(
      import.meta.url,
    );
  const paths =
    windowsInstallPaths();

  console.log(
    "Junius installer",
  );
  console.log(
    "Using Node: " +
      process.execPath,
  );

  const python =
    await findExistingPython();

  if (
    python === undefined
  ) {
    throw new Error(
      "Python 3.10 or newer is required for Junius Desktop Computer Use. Install Python and rerun this command.",
    );
  }

  console.log(
    "Using Python: " +
      python.executable +
      " (" +
      versionText(
        python.version,
      ) +
      ")",
  );
  console.log(
    "Installing to: " +
      paths.appRoot,
  );

  await copyApplication(
    packageRoot,
    paths.appRoot,
  );

  await installNodeDependencies(
    process.execPath,
    paths.appRoot,
  );

  const venvPython =
    await ensureVenv(
      python.executable,
      paths.appRoot,
    );

  await installPythonRequirements(
    venvPython,
    paths.appRoot,
  );

  await validateInstalledApp(
    process.execPath,
    paths.appRoot,
  );

  const startup =
    await writeWindowsStartup(
      paths,
      process.execPath,
    );

  const runningInsideJunius =
    process.env
      .JUNIUS_PROJECT_ROOT !==
    undefined;

  let restarted = false;

  if (!runningInsideJunius) {
    const stopped =
      await stopInstalledJunius();
    restarted =
      stopped.wasRunning;
  }

  const started =
    await startInstalledJunius({
      ...startup,
      startupScript:
        paths.startupScript,
    });

  console.log("");
  console.log(
    runningInsideJunius &&
      started.alreadyRunning
      ? "Junius files were updated, but the current Junius process cannot restart itself from inside its own tool call. Restart Junius to activate the installed update."
      : restarted
        ? "Junius restarted successfully with the installed version."
        : started.alreadyRunning
          ? "Junius is already running."
          : "Junius started successfully.",
  );
  console.log(
    "MCP: http://127.0.0.1:8787/mcp",
  );
  console.log(
    "Health: http://127.0.0.1:8787/__junius/host-health",
  );
  console.log(
    "Junius will start automatically when this Windows user signs in.",
  );
}
