const DEFAULT_JOB_RESULT_RETENTION_MS =
  30 * 60_000;

type JobHintKind = "terminal" | "persisted";

export class WorkerJobAffinityHints {
  readonly #terminal = new Map<string, string>();
  readonly #persisted = new Map<string, string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #retentionMs: number;

  constructor(retentionMs?: number) {
    this.#retentionMs =
      retentionMs ?? DEFAULT_JOB_RESULT_RETENTION_MS;
  }

  get retentionMs(): number {
    return this.#retentionMs;
  }

  terminalMatches(
    resourceKey: string,
    workerId: string,
  ): boolean {
    return this.#terminal.get(resourceKey) === workerId;
  }

  persistedMatches(
    resourceKey: string,
    workerId: string,
  ): boolean {
    return this.#persisted.get(resourceKey) === workerId;
  }

  setTerminal(
    resourceKey: string,
    workerId: string,
  ): void {
    this.#set(
      this.#terminal,
      "terminal",
      resourceKey,
      workerId,
    );
  }

  setPersisted(
    resourceKey: string,
    workerId: string,
  ): void {
    this.#set(
      this.#persisted,
      "persisted",
      resourceKey,
      workerId,
    );
  }

  clearTerminal(resourceKey: string): void {
    this.#delete(
      this.#terminal,
      "terminal",
      resourceKey,
    );
  }

  clearPersisted(resourceKey: string): void {
    this.#delete(
      this.#persisted,
      "persisted",
      resourceKey,
    );
  }

  clear(resourceKey: string): void {
    this.clearTerminal(resourceKey);
    this.clearPersisted(resourceKey);
  }

  removeWorker(workerId: string): void {
    for (const [resourceKey, hintedWorkerId] of
      this.#terminal
    ) {
      if (hintedWorkerId === workerId) {
        this.clearTerminal(resourceKey);
      }
    }

    for (const [resourceKey, hintedWorkerId] of
      this.#persisted
    ) {
      if (hintedWorkerId === workerId) {
        this.clearPersisted(resourceKey);
      }
    }
  }

  close(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#terminal.clear();
    this.#persisted.clear();
  }

  #timerKey(
    kind: JobHintKind,
    resourceKey: string,
  ): string {
    return `${kind}:${resourceKey}`;
  }

  #set(
    map: Map<string, string>,
    kind: JobHintKind,
    resourceKey: string,
    workerId: string,
  ): void {
    this.#delete(map, kind, resourceKey);
    map.set(resourceKey, workerId);

    const timerKey =
      this.#timerKey(kind, resourceKey);
    const timer = setTimeout(() => {
      this.#timers.delete(timerKey);
      if (map.get(resourceKey) === workerId) {
        map.delete(resourceKey);
      }
    }, this.#retentionMs);

    this.#timers.set(timerKey, timer);
  }

  #delete(
    map: Map<string, string>,
    kind: JobHintKind,
    resourceKey: string,
  ): void {
    map.delete(resourceKey);

    const timerKey =
      this.#timerKey(kind, resourceKey);
    const timer = this.#timers.get(timerKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(timerKey);
    }
  }
}
