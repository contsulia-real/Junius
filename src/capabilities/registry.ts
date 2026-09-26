import type { Capability } from "./types.js";

const CAPABILITY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class CapabilityRegistry {
  readonly #capabilities = new Map<string, Capability>();

  register(capability: Capability): void {
    if (!CAPABILITY_KEY_PATTERN.test(capability.key)) {
      throw new Error(`Invalid capability key: ${capability.key}`);
    }

    if (this.#capabilities.has(capability.key)) {
      throw new Error(`Capability key already registered: ${capability.key}`);
    }

    this.#capabilities.set(capability.key, capability);
  }

  get(key: string): Capability | undefined {
    return this.#capabilities.get(key);
  }

  has(key: string): boolean {
    return this.#capabilities.has(key);
  }

  list(): readonly Capability[] {
    return [...this.#capabilities.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
  }
}
