import { ProcessCapability } from "./process-capability.js";
import { CapabilityRegistry } from "./registry.js";

function minimalEnvironment(): NodeJS.ProcessEnv {
  const keys = ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const;
  const environment: NodeJS.ProcessEnv = {};

  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  return environment;
}

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();

  registry.register(
    new ProcessCapability({
      key: "node",
      description:
        "Node.js executable. During this spike only --version and -p process.platform are permitted.",
      executable: process.execPath,
      allowedArgVectors: [
        ["--version"],
        ["-p", "process.platform"],
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
      environment: minimalEnvironment(),
    }),
  );

  return registry;
}
