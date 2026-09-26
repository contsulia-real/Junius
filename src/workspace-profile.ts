export class WorkspaceProfile {
  readonly rootPath: string;
  readonly #allowedKeys = new Set<string>();

  constructor(rootPath: string, initialAllowedKeys: readonly string[] = []) {
    this.rootPath = rootPath;

    for (const key of initialAllowedKeys) {
      this.#allowedKeys.add(key);
    }
  }

  isAllowed(key: string): boolean {
    return this.#allowedKeys.has(key);
  }

  allow(key: string): void {
    this.#allowedKeys.add(key);
  }

  deny(key: string): void {
    this.#allowedKeys.delete(key);
  }

  setOnly(key: string): void {
    this.#allowedKeys.clear();
    this.#allowedKeys.add(key);
  }

  allowedKeys(): readonly string[] {
    return [...this.#allowedKeys].sort();
  }
}
