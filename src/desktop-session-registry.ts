export interface DesktopElementRef {
  readonly handle: number;
  readonly path: readonly number[];
}

export interface DesktopSessionState {
  readonly refs: Map<string, DesktopElementRef>;
  nextRef: number;
  lastUsedAt: number;
}

export class DesktopSessionRegistry {
  readonly #sessions =
    new Map<string, DesktopSessionState>();
  readonly #idleMs: number;
  readonly #maxSessions: number;

  constructor(
    idleMs: number,
    maxSessions: number,
  ) {
    this.#idleMs = idleMs;
    this.#maxSessions = maxSessions;
  }

  get count(): number {
    this.#pruneExpired();
    return this.#sessions.size;
  }

  session(name: string): DesktopSessionState {
    const now = Date.now();
    this.#pruneExpired(now);

    let state = this.#sessions.get(name);

    if (state === undefined) {
      while (this.#sessions.size >= this.#maxSessions) {
        let oldestName: string | undefined;
        let oldestUsedAt = Number.POSITIVE_INFINITY;

        for (const [candidateName, candidate] of
          this.#sessions
        ) {
          if (candidate.lastUsedAt < oldestUsedAt) {
            oldestUsedAt = candidate.lastUsedAt;
            oldestName = candidateName;
          }
        }

        if (oldestName === undefined) break;
        this.#sessions.delete(oldestName);
      }

      state = {
        refs: new Map(),
        nextRef: 1,
        lastUsedAt: now,
      };
      this.#sessions.set(name, state);
    } else {
      state.lastUsedAt = now;
    }

    return state;
  }

  clear(): void {
    this.#sessions.clear();
  }

  #pruneExpired(now = Date.now()): void {
    for (const [name, session] of this.#sessions) {
      if (
        now - session.lastUsedAt >=
        this.#idleMs
      ) {
        this.#sessions.delete(name);
      }
    }
  }
}
