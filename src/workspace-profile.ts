export type WorkspaceArgumentGrant =
  | {
      readonly mode: "exact";
      readonly args: readonly string[];
    }
  | {
      readonly mode: "prefix";
      readonly args: readonly string[];
    };

export interface WorkspaceCapabilityGrant {
  readonly key: string;
  readonly arguments: readonly WorkspaceArgumentGrant[];
}

function matchesGrant(
  args: readonly string[],
  grant: WorkspaceArgumentGrant,
): boolean {
  if (grant.mode === "exact") {
    return (
      args.length === grant.args.length &&
      args.every((value, index) => value === grant.args[index])
    );
  }

  return (
    grant.args.length <= args.length &&
    grant.args.every((value, index) => value === args[index])
  );
}

function cloneGrant(
  grant: WorkspaceCapabilityGrant,
): WorkspaceCapabilityGrant {
  return {
    key: grant.key,
    arguments: grant.arguments.map((rule) => ({
      mode: rule.mode,
      args: [...rule.args],
    })),
  };
}

export class WorkspaceProfile {
  readonly rootPath: string;
  readonly #grants = new Map<string, WorkspaceCapabilityGrant>();

  constructor(
    rootPath: string,
    initialGrants: readonly WorkspaceCapabilityGrant[] = [],
  ) {
    this.rootPath = rootPath;

    for (const grant of initialGrants) {
      this.setGrant(grant);
    }
  }

  hasCapabilityGrant(key: string): boolean {
    return this.#grants.has(key);
  }

  isInvocationAllowed(
    key: string,
    args: readonly string[],
  ): boolean {
    const grant = this.#grants.get(key);
    if (grant === undefined) {
      return false;
    }

    return grant.arguments.some((rule) => matchesGrant(args, rule));
  }

  setGrant(grant: WorkspaceCapabilityGrant): void {
    if (grant.arguments.length === 0) {
      this.#grants.delete(grant.key);
      return;
    }

    this.#grants.set(grant.key, cloneGrant(grant));
  }

  revoke(key: string): void {
    this.#grants.delete(key);
  }

  grants(): readonly WorkspaceCapabilityGrant[] {
    return [...this.#grants.values()]
      .map(cloneGrant)
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}
