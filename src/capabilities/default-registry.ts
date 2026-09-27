import {
  createNodeCapability,
  resolveNodeExecutable,
} from "./node-capability.js";
import { createPnpmCapability } from "./pnpm-capability.js";
import { CapabilityRegistry } from "./registry.js";

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();

  const nodeExecutable = resolveNodeExecutable();
  const node =
    nodeExecutable === undefined
      ? undefined
      : createNodeCapability({
          executable: nodeExecutable,
          fixedArgs: [],
        });

  if (node !== undefined) {
    registry.register(node);
  }

  const pnpm = createPnpmCapability();
  if (pnpm !== undefined) {
    registry.register(pnpm);
  }

  return registry;
}
