import { ProcessCapability } from "./process-capability.js";
import { createPnpmCapability } from "./pnpm-capability.js";
import { CapabilityRegistry } from "./registry.js";

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();

  registry.register(
    new ProcessCapability({
      key: "node",
      description:
        "Node.js executable. Only --version and -p process.platform are permitted.",
      executable: process.execPath,
      allowedArgVectors: [
        ["--version"],
        ["-p", "process.platform"],
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    }),
  );

  const pnpm = createPnpmCapability();
  if (pnpm !== undefined) {
    registry.register(pnpm);
  }

  return registry;
}
