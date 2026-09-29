#!/usr/bin/env node
import {
  installJunius,
} from "../scripts/install.mjs";

function usage() {
  console.log(
    [
      "Junius",
      "",
      "Usage:",
      "  junius install",
      "",
      "One-command install:",
      "  npx --yes junius@latest install",
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
} else {
  console.error(
    "Unknown Junius command: " +
      command,
  );
  usage();
  process.exitCode = 1;
}
