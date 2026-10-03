import {
  createHash,
  randomUUID,
} from "node:crypto";

export type ObservedToolCallStatus =
  | "running"
  | "succeeded"
  | "failed";

export interface ObservedToolDescriptor {
  readonly name: string;
  readonly title?: string;
}

export interface OpenAiRequestIdentity {
  readonly sessionId?: string;
  readonly requestMetaKeys:
    readonly string[];
}

export type TurnPromptPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "file";
    };

export interface ObservedToolCall {
  readonly id: string;
  readonly tool: string;
  readonly input: unknown;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly status:
    ObservedToolCallStatus;
}

export interface ObservedTurnToolGroup {
  readonly name: string;
  readonly title?: string;
  readonly count: number;
  readonly calls:
    readonly ObservedToolCall[];
}

export type ObservedTurnEventKind =
  | "turn_started"
  | "tool_started"
  | "tool_succeeded"
  | "tool_failed"
  | "turn_completed";

export interface ObservedTurnEvent {
  readonly kind:
    ObservedTurnEventKind;
  readonly at: string;
  readonly sequence: number;
  readonly tool?: string;
  readonly callId?: string;
  readonly input?: unknown;
  readonly durationMs?: number;
}

export interface ObservedTurn {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status:
    | "active"
    | "completed";
  readonly totalCalls: number;
  readonly tools:
    readonly ObservedTurnToolGroup[];
  readonly events:
    readonly ObservedTurnEvent[];
}

export interface McpObservabilitySnapshot {
  readonly turns:
    readonly ObservedTurn[];
  readonly sessionIdentityAvailable:
    boolean;
  readonly testWindowCloseRevision:
    number;
}

const MAX_TURNS = 200;
const MAX_INPUT_STRING = 4_096;
const MAX_INPUT_ARRAY = 48;
const MAX_INPUT_KEYS = 64;
const MAX_INPUT_DEPTH = 8;

const OPENAI_SESSION_KEY =
  "openai/session";

function metaRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value as Readonly<
    Record<string, unknown>
  >;
}

function stringIdentity(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512
  ) {
    return undefined;
  }

  return value;
}

export function extractOpenAiRequestIdentity(
  metadata: unknown,
): OpenAiRequestIdentity {
  const record =
    metaRecord(metadata);
  const requestMetaKeys =
    Object.keys(record).sort();

  const sessionId =
    stringIdentity(
      record[
        OPENAI_SESSION_KEY
      ],
    );

  return {
    ...(sessionId === undefined
      ? {}
      : { sessionId }),
    requestMetaKeys,
  };
}

function compactWhitespace(
  value: string,
): string {
  return value
    .replace(/\s+/gu, " ")
    .trim();
}

export function renderTurnTitle(
  parts:
    readonly TurnPromptPart[],
): string {
  const title =
    compactWhitespace(
      parts
        .map((part) =>
          part.type === "file"
            ? "[File]"
            : part.text,
        )
        .filter(
          (part) =>
            part.length > 0,
        )
        .join(" "),
    );

  return title.length > 0
    ? title
    : "（空白输入）";
}

function longStringSummary(
  value: string,
): Readonly<Record<string, unknown>> {
  const digest =
    createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16);

  return {
    preview:
      value.slice(
        0,
        MAX_INPUT_STRING,
      ),
    length:
      value.length,
    sha256:
      digest,
    truncated:
      true,
  };
}

function summarizeInput(
  value: unknown,
  depth = 0,
): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return value.length >
      MAX_INPUT_STRING
      ? longStringSummary(value)
      : value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined") {
    return "[undefined]";
  }

  if (
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }

  if (depth >= MAX_INPUT_DEPTH) {
    return "[max depth]";
  }

  if (Array.isArray(value)) {
    const visible =
      value
        .slice(
          0,
          MAX_INPUT_ARRAY,
        )
        .map((item) =>
          summarizeInput(
            item,
            depth + 1,
          ),
        );

    if (
      value.length >
      MAX_INPUT_ARRAY
    ) {
      visible.push({
        truncatedItems:
          value.length -
          MAX_INPUT_ARRAY,
      });
    }

    return visible;
  }

  const record =
    metaRecord(value);
  const entries =
    Object.entries(record);
  const visible =
    entries.slice(
      0,
      MAX_INPUT_KEYS,
    );
  const result:
    Record<string, unknown> = {};

  for (
    const [key, item] of visible
  ) {
    result[key] =
      summarizeInput(
        item,
        depth + 1,
      );
  }

  if (
    entries.length >
    MAX_INPUT_KEYS
  ) {
    result.__truncatedKeys =
      entries.length -
      MAX_INPUT_KEYS;
  }

  return result;
}

interface MutableObservedToolCall {
  id: string;
  tool: string;
  input: unknown;
  startedAt: string;
  startedAtMs: number;
  startedSequence: number;
  completedAt?: string;
  completedAtMs?: number;
  completedSequence?: number;
  durationMs?: number;
  status:
    ObservedToolCallStatus;
  turnId: string;
}

interface MutableObservedTurn {
  id: string;
  sessionId?: string;
  title: string;
  startedAt: string;
  startedAtMs: number;
  startedSequence: number;
  completedAt?: string;
  completedAtMs?: number;
  completedSequence?: number;
  calls:
    MutableObservedToolCall[];
}

export class McpObservabilityStore {
  readonly #tools =
    new Map<
      string,
      ObservedToolDescriptor
    >();

  readonly #turns:
    MutableObservedTurn[] = [];

  readonly #turnsById =
    new Map<
      string,
      MutableObservedTurn
    >();

  readonly #activeTurnBySession =
    new Map<string, string>();

  readonly #callsById =
    new Map<
      string,
      MutableObservedToolCall
    >();

  readonly #testWindowCloseRevisions =
    new Map<string, number>();

  #sequence = 0;

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  #sessionKey(
    sessionId?: string,
  ): string {
    return sessionId ?? "";
  }

  requestTestWindowClose(
    sessionId: string,
  ): number {
    const revision =
      (this.#testWindowCloseRevisions
        .get(sessionId) ?? 0) + 1;

    this.#testWindowCloseRevisions.set(
      sessionId,
      revision,
    );

    return revision;
  }

  testWindowCloseRevision(
    sessionId?: string,
  ): number {
    if (sessionId === undefined) {
      return 0;
    }

    return this
      .#testWindowCloseRevisions
      .get(sessionId) ?? 0;
  }

  replaceToolCatalog(
    tools:
      readonly ObservedToolDescriptor[],
  ): void {
    this.#tools.clear();

    for (const tool of tools) {
      this.#tools.set(
        tool.name,
        {
          name:
            tool.name,
          ...(tool.title ===
          undefined
            ? {}
            : {
                title:
                  tool.title,
              }),
        },
      );
    }
  }

  #completeTurn(
    turn:
      MutableObservedTurn,
    completedAtMs:
      number,
  ): void {
    if (
      turn.completedAtMs !==
      undefined
    ) {
      return;
    }

    turn.completedAtMs =
      completedAtMs;
    turn.completedAt =
      new Date(
        completedAtMs,
      ).toISOString();
    turn.completedSequence =
      this.#nextSequence();

    const key =
      this.#sessionKey(
        turn.sessionId,
      );

    if (
      this.#activeTurnBySession
        .get(key) === turn.id
    ) {
      this
        .#activeTurnBySession
        .delete(key);
    }
  }

  #pruneTurns(): void {
    while (
      this.#turns.length >
      MAX_TURNS
    ) {
      const index =
        this.#turns.findIndex(
          (turn) =>
            turn.completedAtMs !==
            undefined,
        );

      if (index < 0) {
        return;
      }

      const [removed] =
        this.#turns.splice(
          index,
          1,
        );

      if (removed === undefined) {
        return;
      }

      this.#turnsById.delete(
        removed.id,
      );

      for (
        const call of
        removed.calls
      ) {
        this.#callsById.delete(
          call.id,
        );
      }
    }
  }

  #createTurn(
    sessionId:
      string | undefined,
    title: string,
    startedAtMs:
      number,
  ): MutableObservedTurn {
    const key =
      this.#sessionKey(
        sessionId,
      );
    const activeId =
      this.#activeTurnBySession
        .get(key);

    if (
      activeId !== undefined
    ) {
      const active =
        this.#turnsById.get(
          activeId,
        );

      if (active !== undefined) {
        this.#completeTurn(
          active,
          startedAtMs,
        );
      }
    }

    const turn:
      MutableObservedTurn = {
        id:
          randomUUID(),
        ...(sessionId ===
        undefined
          ? {}
          : { sessionId }),
        title,
        startedAt:
          new Date(
            startedAtMs,
          ).toISOString(),
        startedAtMs,
        startedSequence:
          this.#nextSequence(),
        calls: [],
      };

    this.#turns.push(turn);
    this.#turnsById.set(
      turn.id,
      turn,
    );
    this.#activeTurnBySession.set(
      key,
      turn.id,
    );
    this.#pruneTurns();

    return turn;
  }

  beginTurn(
    sessionId: string,
    parts:
      readonly TurnPromptPart[],
  ): string {
    const turn =
      this.#createTurn(
        sessionId,
        renderTurnTitle(parts),
        Date.now(),
      );

    return turn.id;
  }

  endTurn(
    sessionId: string,
  ): string | undefined {
    const activeId =
      this.#activeTurnBySession
        .get(
          this.#sessionKey(
            sessionId,
          ),
        );

    if (activeId === undefined) {
      return undefined;
    }

    const turn =
      this.#turnsById.get(
        activeId,
      );

    if (turn === undefined) {
      return undefined;
    }

    this.#completeTurn(
      turn,
      Date.now(),
    );

    return turn.id;
  }

  #activeTurn(
    sessionId?: string,
  ): MutableObservedTurn | undefined {
    const id =
      this.#activeTurnBySession
        .get(
          this.#sessionKey(
            sessionId,
          ),
        );

    return id === undefined
      ? undefined
      : this.#turnsById.get(id);
  }

  hasActiveTurn(
    sessionId?: string,
  ): boolean {
    return this.#activeTurn(
      sessionId,
    ) !== undefined;
  }

  beginToolCall(
    tool: string,
    input: unknown,
    metadata?: unknown,
  ): string {
    const identity =
      extractOpenAiRequestIdentity(
        metadata,
      );
    const startedAtMs =
      Date.now();
    const turn =
      this.#activeTurn(
        identity.sessionId,
      );

    if (turn === undefined) {
      throw new Error(
        "junius_turn_not_started",
      );
    }

    const id =
      randomUUID();

    const call:
      MutableObservedToolCall = {
        id,
        tool,
        input:
          summarizeInput(input),
        startedAt:
          new Date(
            startedAtMs,
          ).toISOString(),
        startedAtMs,
        startedSequence:
          this.#nextSequence(),
        status:
          "running",
        turnId:
          turn.id,
      };

    turn.calls.push(call);
    this.#callsById.set(
      id,
      call,
    );

    return id;
  }

  finishToolCall(
    id: string,
    status:
      Exclude<
        ObservedToolCallStatus,
        "running"
      >,
  ): void {
    const call =
      this.#callsById.get(id);

    if (
      call === undefined ||
      call.status !== "running"
    ) {
      return;
    }

    const completedAtMs =
      Date.now();

    call.status =
      status;
    call.completedAtMs =
      completedAtMs;
    call.completedAt =
      new Date(
        completedAtMs,
      ).toISOString();
    call.completedSequence =
      this.#nextSequence();
    call.durationMs =
      Math.max(
        0,
        completedAtMs -
          call.startedAtMs,
      );
  }

  #snapshotCall(
    call:
      MutableObservedToolCall,
  ): ObservedToolCall {
    return {
      id:
        call.id,
      tool:
        call.tool,
      input:
        call.input,
      startedAt:
        call.startedAt,
      ...(call.completedAt ===
      undefined
        ? {}
        : {
            completedAt:
              call.completedAt,
          }),
      ...(call.durationMs ===
      undefined
        ? {}
        : {
            durationMs:
              call.durationMs,
          }),
      status:
        call.status,
    };
  }

  #turnEvents(
    turn:
      MutableObservedTurn,
  ): readonly ObservedTurnEvent[] {
    const events:
      ObservedTurnEvent[] = [
        {
          kind:
            "turn_started",
          at:
            turn.startedAt,
          sequence:
            turn.startedSequence,
        },
      ];

    for (const call of turn.calls) {
      events.push({
        kind:
          "tool_started",
        at:
          call.startedAt,
        sequence:
          call.startedSequence,
        tool:
          call.tool,
        callId:
          call.id,
        input:
          call.input,
      });

      if (
        call.completedAt !==
          undefined &&
        call.completedSequence !==
          undefined
      ) {
        events.push({
          kind:
            call.status ===
            "failed"
              ? "tool_failed"
              : "tool_succeeded",
          at:
            call.completedAt,
          sequence:
            call.completedSequence,
          tool:
            call.tool,
          callId:
            call.id,
          ...(call.durationMs ===
          undefined
            ? {}
            : {
                durationMs:
                  call.durationMs,
              }),
        });
      }
    }

    if (
      turn.completedAt !==
        undefined &&
      turn.completedSequence !==
        undefined
    ) {
      events.push({
        kind:
          "turn_completed",
        at:
          turn.completedAt,
        sequence:
          turn.completedSequence,
      });
    }

    return events.sort(
      (left, right) =>
        left.sequence -
        right.sequence,
    );
  }

  #snapshotTurn(
    turn:
      MutableObservedTurn,
  ): ObservedTurn {
    const groups =
      new Map<
        string,
        MutableObservedToolCall[]
      >();

    for (const call of turn.calls) {
      const calls =
        groups.get(call.tool) ??
        [];

      calls.push(call);
      groups.set(
        call.tool,
        calls,
      );
    }

    const tools =
      [...groups.entries()]
        .map(
          (
            [name, calls],
          ): ObservedTurnToolGroup => {
            const descriptor =
              this.#tools.get(name);

            return {
              name,
              ...(descriptor?.title ===
              undefined
                ? {}
                : {
                    title:
                      descriptor.title,
                  }),
              count:
                calls.length,
              calls:
                calls.map((call) =>
                  this.#snapshotCall(
                    call,
                  ),
                ),
            };
          },
        );

    return {
      id:
        turn.id,
      title:
        turn.title,
      startedAt:
        turn.startedAt,
      ...(turn.completedAt ===
      undefined
        ? {}
        : {
            completedAt:
              turn.completedAt,
          }),
      status:
        turn.completedAt ===
        undefined
          ? "active"
          : "completed",
      totalCalls:
        turn.calls.length,
      tools,
      events:
        this.#turnEvents(turn),
    };
  }

  snapshot(
    sessionId?: string,
  ): McpObservabilitySnapshot {
    const turns =
      this.#turns
        .filter(
          (turn) =>
            turn.sessionId ===
              sessionId &&
            turn.calls.length > 0,
        )
        .map((turn) =>
          this.#snapshotTurn(
            turn,
          ),
        )
        .reverse();

    return {
      turns,
      sessionIdentityAvailable:
        sessionId !== undefined,
      testWindowCloseRevision:
        this.testWindowCloseRevision(
          sessionId,
        ),
    };
  }
}
