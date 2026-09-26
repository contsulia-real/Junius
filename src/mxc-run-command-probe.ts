import { createDefaultCapabilityRegistry } from "./capabilities/default-registry.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

if (process.platform !== "win32") {
  throw new Error("The MXC run_command probe must run on Windows.");
}

const registry = createDefaultCapabilityRegistry();
const profile = new WorkspaceProfile(process.cwd(), [
  {
    key: "node",
    arguments: [
      { mode: "exact", args: ["--version"] },
      { mode: "exact", args: ["-p", "process.platform"] },
      {
        mode: "exact",
        args: ["-e", "console.log('should not run')"],
      },
    ],
  },
]);
const manager = new WorkspaceManager([
  { id: "probe", profile },
]);
const service = new RunCommandService(registry, manager);

const version = await service.run("probe", "node", ["--version"]);
const platform = await service.run(
  "probe",
  "node",
  ["-p", "process.platform"],
);
const deniedArgs = await service.run("probe", "node", [
  "-e",
  "console.log('should not run')",
]);

console.log(
  JSON.stringify(
    {
      probeExecuted: true,
      sdk: "@microsoft/mxc-sdk@0.8.0",
      version,
      platform,
      deniedArgs,
      conclusions: {
        runCommandVersionWorks:
          version.ok &&
          /^v\d+\./u.test(version.execution.stdout.trim()),
        runCommandPlatformWorks:
          platform.ok &&
          platform.execution.stdout.trim() === "win32",
        argumentPolicyStillEnforced:
          !deniedArgs.ok &&
          deniedArgs.code === "arguments_not_allowed",
      },
    },
    null,
    2,
  ),
);
