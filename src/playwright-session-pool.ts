export interface PlaywrightSessionToken {
  lastUsedAt: number;
  inFlight: number;
  timer?: NodeJS.Timeout;
}

export interface PlaywrightSessionPoolOptions {
  readonly idleMs: number;
  readonly maxSessions: number;
  readonly closeSession: (session: string) => Promise<void>;
  readonly isClosing: () => boolean;
}

export class PlaywrightSessionPool {
  readonly #sessions =
    new Map<string, PlaywrightSessionToken>();
  readonly #pendingCleanup =
    new Set<Promise<void>>();
  readonly #idleMs: number;
  readonly #maxSessions: number;
  readonly #closeSession: (
    session: string,
  ) => Promise<void>;
  readonly #isClosing: () => boolean;
  #cleanupError: string | undefined;

  constructor(options: PlaywrightSessionPoolOptions) {
    this.#idleMs = options.idleMs;
    this.#maxSessions = options.maxSessions;
    this.#closeSession = options.closeSession;
    this.#isClosing = options.isClosing;
  }

  get count(): number {
    return this.#sessions.size;
  }

  get idleMs(): number {
    return this.#idleMs;
  }

  get maxSessions(): number {
    return this.#maxSessions;
  }

  get cleanupError(): string | undefined {
    return this.#cleanupError;
  }

  async cleanupIdle(): Promise<void> {
    for (const [session, state] of [
      ...this.#sessions.entries(),
    ]) {
      if (state.inFlight === 0) {
        this.#startCleanup(session, state);
      }
    }

    await Promise.allSettled([
      ...this.#pendingCleanup,
    ]);
  }

  prepareClose(
    session: string,
  ): PlaywrightSessionToken | undefined {
    const state = this.#sessions.get(session);
    if (state?.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    return state;
  }

  completeClose(session: string): void {
    this.#forget(session);
  }

  restoreAfterClose(
    session: string,
    state: PlaywrightSessionToken | undefined,
  ): void {
    if (
      state === undefined ||
      this.#isClosing() ||
      this.#sessions.get(session) !== state ||
      state.inFlight > 0 ||
      state.timer !== undefined
    ) {
      return;
    }

    this.#armTimer(session, state);
  }

  beginActivity(session: string): void {
    let state = this.#sessions.get(session);
    if (state === undefined) {
      state = {
        lastUsedAt: Date.now(),
        inFlight: 0,
      };
      this.#sessions.set(session, state);
    }

    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    state.inFlight += 1;
    state.lastUsedAt = Date.now();
  }

  endActivity(
    session: string,
    enabled: boolean,
  ): void {
    const state = this.#sessions.get(session);
    if (state === undefined) return;

    state.inFlight = Math.max(0, state.inFlight - 1);
    state.lastUsedAt = Date.now();

    if (this.#isClosing() || state.inFlight > 0) {
      return;
    }

    if (!enabled) {
      this.#startCleanup(session, state);
      return;
    }

    this.#armTimer(session, state);
    this.#enforceLimit();
  }

  async beginShutdown(): Promise<readonly string[]> {
    for (const state of this.#sessions.values()) {
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }

    await Promise.allSettled([
      ...this.#pendingCleanup,
    ]);

    return [...this.#sessions.keys()];
  }

  clear(): void {
    for (const session of [...this.#sessions.keys()]) {
      this.#forget(session);
    }
  }

  #forget(session: string): void {
    const state = this.#sessions.get(session);
    if (state?.timer !== undefined) {
      clearTimeout(state.timer);
    }
    this.#sessions.delete(session);
  }

  #armTimer(
    session: string,
    state: PlaywrightSessionToken,
  ): void {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.#startCleanup(session, state);
    }, this.#idleMs);
  }

  #enforceLimit(): void {
    const overflow =
      this.#sessions.size - this.#maxSessions;
    if (overflow <= 0) return;

    const candidates = [...this.#sessions.entries()]
      .filter(([, state]) => state.inFlight === 0)
      .sort(
        (left, right) =>
          left[1].lastUsedAt - right[1].lastUsedAt,
      )
      .slice(0, overflow);

    for (const [session, state] of candidates) {
      this.#startCleanup(session, state);
    }
  }

  #startCleanup(
    session: string,
    state: PlaywrightSessionToken,
  ): void {
    if (
      this.#isClosing() ||
      this.#sessions.get(session) !== state ||
      state.inFlight > 0
    ) {
      return;
    }

    this.#forget(session);

    const task = this.#closeDetachedSession(
      session,
      state,
    );
    this.#pendingCleanup.add(task);
    void task.finally(() => {
      this.#pendingCleanup.delete(task);
    });
  }

  async #closeDetachedSession(
    session: string,
    state: PlaywrightSessionToken,
  ): Promise<void> {
    try {
      await this.#closeSession(session);
      this.#cleanupError = undefined;
    } catch (error) {
      this.#cleanupError =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        !this.#isClosing() &&
        !this.#sessions.has(session) &&
        this.#sessions.size < this.#maxSessions
      ) {
        state.inFlight = 0;
        state.lastUsedAt = Date.now();
        state.timer = undefined;
        this.#sessions.set(session, state);
        this.#armTimer(session, state);
      }
    }
  }
}
