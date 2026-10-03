import { randomUUID } from "node:crypto";

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
  readonly turnId?: string;
  readonly turnMetaKey?: string;
  readonly requestMetaKeys:
    readonly string[];
}

export interface ObservedToolCall {
  readonly id: string;
  readonly tool: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly status:
    ObservedToolCallStatus;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly turnMetaKey?: string;
  readonly requestMetaKeys:
    readonly string[];
}

export interface ObservedTurnToolCount {
  readonly name: string;
  readonly count: number;
}

export interface ObservedTurnSummary {
  readonly id: string;
  readonly turnMetaKey?: string;
  readonly startedAt: string;
  readonly lastCallAt: string;
  readonly totalCalls: number;
  readonly tools:
    readonly ObservedTurnToolCount[];
}

export interface McpObservabilitySnapshot {
  readonly tools:
    readonly ObservedToolDescriptor[];
  readonly calls:
    readonly ObservedToolCall[];
  readonly turns:
    readonly ObservedTurnSummary[];
  readonly ungroupedCalls: number;
  readonly turnIdentityAvailable:
    boolean;
  readonly sessionIdentityAvailable:
    boolean;
  readonly testWindowOpen:
    boolean;
  readonly observedRequestMetaKeys:
    readonly string[];
}

const MAX_RECENT_CALLS = 1_000;

const OPENAI_SESSION_KEY =
  "openai/session";

const OPENAI_TURN_KEY =
  /^openai\/turn(?:[_-]?id)?$/iu;

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

  let turnId:
    string | undefined;
  let turnMetaKey:
    string | undefined;

  for (const key of requestMetaKeys) {
    if (
      !OPENAI_TURN_KEY.test(
        key,
      )
    ) {
      continue;
    }

    const candidate =
      stringIdentity(
        record[key],
      );
    if (
      candidate === undefined
    ) {
      continue;
    }

    turnId = candidate;
    turnMetaKey = key;
    break;
  }

  return {
    ...(sessionId === undefined
      ? {}
      : { sessionId }),
    ...(turnId === undefined
      ? {}
      : {
          turnId,
          turnMetaKey,
        }),
    requestMetaKeys,
  };
}

interface MutableObservedToolCall {
  id: string;
  tool: string;
  startedAt: string;
  startedAtMs: number;
  completedAt?: string;
  durationMs?: number;
  status: ObservedToolCallStatus;
  sessionId?: string;
  turnId?: string;
  turnMetaKey?: string;
  requestMetaKeys:
    readonly string[];
}

export class McpObservabilityStore {
  readonly #tools =
    new Map<
      string,
      ObservedToolDescriptor
    >();

  readonly #calls:
    MutableObservedToolCall[] = [];

  readonly #callsById =
    new Map<
      string,
      MutableObservedToolCall
    >();

  readonly #openTestWindowSessions =
    new Set<string>();

  setTestWindowOpen(
    sessionId: string,
    open: boolean,
  ): void {
    if (open) {
      this.#openTestWindowSessions.add(
        sessionId,
      );
      return;
    }

    this.#openTestWindowSessions.delete(
      sessionId,
    );
  }

  isTestWindowOpen(
    sessionId?: string,
  ): boolean {
    if (sessionId === undefined) {
      return false;
    }

    return this
      .#openTestWindowSessions
      .has(sessionId);
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
          name: tool.name,
          ...(tool.title === undefined
            ? {}
            : {
                title:
                  tool.title,
              }),
        },
      );
    }
  }

  beginToolCall(
    tool: string,
    metadata?: unknown,
  ): string {
    const identity =
      extractOpenAiRequestIdentity(
        metadata,
      );
    const startedAtMs =
      Date.now();
    const id = randomUUID();

    const call:
      MutableObservedToolCall = {
        id,
        tool,
        startedAt:
          new Date(
            startedAtMs,
          ).toISOString(),
        startedAtMs,
        status: "running",
        ...identity,
      };

    this.#calls.push(call);
    this.#callsById.set(
      id,
      call,
    );

    while (
      this.#calls.length >
      MAX_RECENT_CALLS
    ) {
      const removed =
        this.#calls.shift();
      if (removed !== undefined) {
        this.#callsById.delete(
          removed.id,
        );
      }
    }

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
    call.status = status;
    call.completedAt =
      new Date(
        completedAtMs,
      ).toISOString();
    call.durationMs =
      Math.max(
        0,
        completedAtMs -
          call.startedAtMs,
      );
  }

  snapshot(
    sessionId?: string,
  ): McpObservabilitySnapshot {
    const visibleCalls =
      this.#calls
        .filter(
          (call) =>
            call.sessionId ===
              sessionId,
        )
        .map(
          (
            call,
          ): ObservedToolCall => ({
            id: call.id,
            tool: call.tool,
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
            ...(call.sessionId ===
            undefined
              ? {}
              : {
                  sessionId:
                    call.sessionId,
                }),
            ...(call.turnId ===
            undefined
              ? {}
              : {
                  turnId:
                    call.turnId,
                  turnMetaKey:
                    call.turnMetaKey,
                }),
            requestMetaKeys:
              call.requestMetaKeys,
          }),
        )
        .reverse();

    const turns =
      new Map<
        string,
        {
          id: string;
          turnMetaKey?:
            string;
          startedAt: string;
          lastCallAt: string;
          tools:
            Map<string, number>;
          totalCalls: number;
        }
      >();

    const metaKeys =
      new Set<string>();
    let ungroupedCalls = 0;

    for (const call of visibleCalls) {
      for (
        const key of
        call.requestMetaKeys
      ) {
        metaKeys.add(key);
      }

      if (
        call.turnId === undefined
      ) {
        ungroupedCalls += 1;
        continue;
      }

      let turn =
        turns.get(
          call.turnId,
        );
      if (turn === undefined) {
        turn = {
          id: call.turnId,
          ...(call.turnMetaKey ===
          undefined
            ? {}
            : {
                turnMetaKey:
                  call.turnMetaKey,
              }),
          startedAt:
            call.startedAt,
          lastCallAt:
            call.startedAt,
          tools:
            new Map(),
          totalCalls: 0,
        };
        turns.set(
          call.turnId,
          turn,
        );
      }

      if (
        call.startedAt <
        turn.startedAt
      ) {
        turn.startedAt =
          call.startedAt;
      }
      if (
        call.startedAt >
        turn.lastCallAt
      ) {
        turn.lastCallAt =
          call.startedAt;
      }

      turn.totalCalls += 1;
      turn.tools.set(
        call.tool,
        (
          turn.tools.get(
            call.tool,
          ) ?? 0
        ) + 1,
      );
    }

    const turnSummaries =
      [...turns.values()]
        .map(
          (
            turn,
          ): ObservedTurnSummary => ({
            id: turn.id,
            ...(turn.turnMetaKey ===
            undefined
              ? {}
              : {
                  turnMetaKey:
                    turn.turnMetaKey,
                }),
            startedAt:
              turn.startedAt,
            lastCallAt:
              turn.lastCallAt,
            totalCalls:
              turn.totalCalls,
            tools:
              [...turn.tools.entries()]
                .map(
                  ([name, count]) => ({
                    name,
                    count,
                  }),
                )
                .sort(
                  (left, right) =>
                    left.name.localeCompare(
                      right.name,
                    ),
                ),
          }),
        )
        .sort(
          (left, right) =>
            right.lastCallAt
              .localeCompare(
                left.lastCallAt,
              ),
        );

    return {
      tools:
        [...this.#tools.values()]
          .sort(
            (left, right) =>
              left.name.localeCompare(
                right.name,
              ),
          ),
      calls: visibleCalls,
      turns: turnSummaries,
      ungroupedCalls,
      turnIdentityAvailable:
        turnSummaries.length > 0,
      sessionIdentityAvailable:
        sessionId !== undefined,
      testWindowOpen:
        this.isTestWindowOpen(sessionId),
      observedRequestMetaKeys:
        [...metaKeys].sort(),
    };
  }
}
