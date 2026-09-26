import { MxcProcessCapability } from "./mxc-process-capability.js";
import { CapabilityRegistry } from "./registry.js";

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();

  registry.register(
    new MxcProcessCapability({
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
    }),
  );

  return registry;
}
