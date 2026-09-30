#!/usr/bin/env node
import {
  installJunius,
} from "../scripts/install.mjs";
import {
  checkJuniusUpdate,
  updateJunius,
} from "../scripts/update.mjs";
import {
  assertWindowsPlatform,
} from "../scripts/windows-only.mjs";

assertWindowsPlatform();

function usage() {
  console.log(
    [
      "Junius",
      "",
      "Usage:",
      "  junius install",
      "  junius update",
      "  junius update --check",
      "",
      "One-command install:",
      "  irm https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1 | iex",
    ].join("\n"),
  );
}

const command =
  process.argv[2];

if (
  command === undefined ||
  command === "--help" ||
  command === "-h"
) {
  usage();
} else if (
  command === "install"
) {
  installJunius().catch(
    (error) => {
      console.error(
        "Junius installation failed: " +
          (
            error instanceof
            Error
              ? error.message
              : String(error)
          ),
      );
      process.exitCode = 1;
    },
  );
} else if (
  command === "update"
) {
  const updateArg =
    process.argv[3];
  const extraArg =
    process.argv[4];

  if (
    (
      updateArg !==
        undefined &&
      updateArg !==
        "--check"
    ) ||
    extraArg !== undefined
  ) {
    console.error(
      "Usage: junius update [--check]",
    );
    process.exitCode = 1;
  } else if (
    updateArg ===
    "--check"
  ) {
    checkJuniusUpdate()
      .then((result) => {
        console.log(
          result.updateAvailable
            ? "Update available: " +
                result.currentVersion +
                " -> " +
                result.latestVersion
            : "Junius is up to date (" +
                result.currentVersion +
                ").",
        );
      })
      .catch((error) => {
        console.error(
          "Junius update check failed: " +
            (
              error instanceof
              Error
                ? error.message
                : String(error)
            ),
        );
        process.exitCode = 1;
      });
  } else {
    console.log(
      "Checking for Junius updates...",
    );
    updateJunius()
      .then((result) => {
        if (!result.updated) {
          console.log(
            "Junius is up to date (" +
              result.currentVersion +
              ").",
          );
          return;
        }

        if (
          result.installerOutput
            .length > 0
        ) {
          console.log(
            result.installerOutput,
          );
        }
        console.log(
          "Updated Junius to " +
            result.latestVersion +
            ".",
        );
        if (
          result.restartRequired
        ) {
          console.log(
            "Restart Junius to activate the update.",
          );
        }
      })
      .catch((error) => {
        console.error(
          "Junius update failed: " +
            (
              error instanceof
              Error
                ? error.message
                : String(error)
            ),
        );
        process.exitCode = 1;
      });
  }
} else {
  console.error(
    "Unknown Junius command: " +
      command,
  );
  usage();
  process.exitCode = 1;
}
