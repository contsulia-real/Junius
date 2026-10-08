import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  McpObservabilityPersistence,
  type SessionObservabilityMetadata,
} from "./mcp-observability-persistence.js";

export type ObservedToolCallStatus =
  | "running"
  | "succeeded"
  | "failed";

export interface ObservedToolDescriptor {
  readonly name: string;
  readonly title?: string;
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

export interface ObservedSkillUse {
  readonly name: string;
  readonly scope?: string;
  readonly workspace?: string;
  readonly path?: string;
  readonly usedAt: string;
  readonly callId: string;
}

export type ObservedTurnEventKind =
  | "turn_started"
  | "tool_started"
  | "tool_succeeded"
  | "tool_failed"
  | "skill_used"
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
  readonly skill?: string;
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
  readonly skills:
    readonly ObservedSkillUse[];
  readonly events:
    readonly ObservedTurnEvent[];
}

export interface McpObservabilitySnapshot {
  readonly session?:
    SessionObservabilityMetadata;
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
  locale?: string,
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

  const language =
    locale ??
    Intl.DateTimeFormat()
      .resolvedOptions()
      .locale;

  return title.length > 0
    ? title
    : language
        .toLowerCase()
        .startsWith("zh")
      ? "（空白输入）"
      : "(empty input)";
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

interface MutableObservedSkillUse {
  name: string;
  scope?: string;
  workspace?: string;
  path?: string;
  usedAt: string;
  sequence: number;
  callId: string;
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
  skills:
    MutableObservedSkillUse[];
}

export interface McpObservabilityStoreOptions {
  readonly rootPath?: string;
}

export class McpObservabilityStore {
  readonly #persistence?:
    McpObservabilityPersistence;
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

  readonly #sessionMetadata =
    new Map<
      string,
      SessionObservabilityMetadata
    >();

  #sequence = 0;

  constructor(
    options:
      McpObservabilityStoreOptions = {},
  ) {
    if (
      options.rootPath !==
      undefined
    ) {
      this.#persistence =
        new McpObservabilityPersistence(
          options.rootPath,
        );
    }
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  #sessionKey(
    sessionId?: string,
  ): string {
    return sessionId ?? "";
  }

  ensureSession(
    sessionId: string,
  ): SessionObservabilityMetadata {
    const known =
      this.#sessionMetadata.get(
        sessionId,
      );

    if (known !== undefined) {
      return known;
    }

    const persisted =
      this.#persistence?.read(
        sessionId,
      );

    const metadata =
      persisted === undefined
        ? this.#persistence?.ensure(
            sessionId,
            this.#snapshotFromMemory(
              sessionId,
            ),
          ) ?? {
            createdAt:
              new Date().toISOString(),
            updatedAt:
              new Date().toISOString(),
          }
        : {
            createdAt:
              persisted.createdAt,
            updatedAt:
              persisted.updatedAt,
          };

    this.#sessionMetadata.set(
      sessionId,
      metadata,
    );

    return metadata;
  }

  deleteSession(
    sessionId: string,
  ): void {
    const turnIds =
      new Set(
        this.#turns
          .filter(
            (turn) =>
              turn.sessionId ===
              sessionId,
          )
          .map((turn) =>
            turn.id,
          ),
      );

    for (let index =
      this.#turns.length - 1;
      index >= 0;
      index -= 1) {
      if (
        this.#turns[index]
          ?.sessionId ===
        sessionId
      ) {
        this.#turns.splice(
          index,
          1,
        );
      }
    }

    for (
      const turnId of
      turnIds
    ) {
      this.#turnsById.delete(
        turnId,
      );
    }

    for (
      const [callId, call] of
      this.#callsById
    ) {
      if (
        turnIds.has(
          call.turnId,
        )
      ) {
        this.#callsById.delete(
          callId,
        );
      }
    }

    this.#activeTurnBySession.delete(
      sessionId,
    );
    this.#testWindowCloseRevisions.delete(
      sessionId,
    );
    this.#sessionMetadata.delete(
      sessionId,
    );
    this.#persistence?.delete(
      sessionId,
    );
  }

  #persistSession(
    sessionId: string,
  ): void {
    if (
      this.#persistence ===
      undefined
    ) {
      return;
    }

    const metadata =
      this.#persistence.write(
        sessionId,
        this.#mergedSnapshot(
          sessionId,
        ),
      );

    this.#sessionMetadata.set(
      sessionId,
      metadata,
    );
  }

  requestTestWindowClose(
    sessionId: string,
  ): number {
    const revision =
      this.testWindowCloseRevision(
        sessionId,
      ) + 1;

    this.#testWindowCloseRevisions.set(
      sessionId,
      revision,
    );
    this.ensureSession(
      sessionId,
    );
    this.#persistSession(
      sessionId,
    );

    return revision;
  }

  testWindowCloseRevision(
    sessionId?: string,
  ): number {
    if (sessionId === undefined) {
      return 0;
    }

    return Math.max(
      this
        .#testWindowCloseRevisions
        .get(sessionId) ?? 0,
      this.#persistence
        ?.read(sessionId)
        ?.snapshot
        .testWindowCloseRevision ??
        0,
    );
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

  #pruneTurns(
    sessionId?: string,
  ): void {
    while (
      this.#turns.filter(
        (turn) =>
          turn.sessionId ===
          sessionId,
      ).length >
      MAX_TURNS
    ) {
      const index =
        this.#turns.findIndex(
          (turn) =>
            turn.sessionId ===
              sessionId &&
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
        skills: [],
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
    this.#pruneTurns(
      sessionId,
    );

    return turn;
  }

  beginTurn(
    sessionId: string,
    parts:
      readonly TurnPromptPart[],
    locale?: string,
  ): string {
    this.ensureSession(
      sessionId,
    );

    const turn =
      this.#createTurn(
        sessionId,
        renderTurnTitle(
          parts,
          locale,
        ),
        Date.now(),
      );

    this.#persistSession(
      sessionId,
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
    this.#persistSession(
      sessionId,
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

  activeTurnId(sessionId: string): string | undefined {
    return this.#activeTurn(sessionId)?.id;
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
    sessionId: string,
  ): string {
    const startedAtMs =
      Date.now();
    const turn =
      this.#activeTurn(
        sessionId,
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
    this.#persistSession(
      sessionId,
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
    result?: unknown,
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

    const turn =
      this.#turnsById.get(
        call.turnId,
      );

    if (
      status === "succeeded" &&
      turn !== undefined &&
      call.tool === "read_skill"
    ) {
      const input =
        metaRecord(call.input);
      let name =
        stringIdentity(
          input.name,
        );
      let scope =
        stringIdentity(
          input.scope,
        );
      let path =
        stringIdentity(
          input.path,
        );
      const workspace =
        stringIdentity(
          input.workspace,
        );

      const content =
        (
          result as {
            content?: unknown;
          } | undefined
        )?.content;

      if (Array.isArray(content)) {
        const text =
          content.find(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              (item as {
                type?: unknown;
              }).type === "text" &&
              typeof (
                item as {
                  text?: unknown;
                }
              ).text === "string",
          ) as
            | {
                text: string;
              }
            | undefined;

        if (text !== undefined) {
          try {
            const parsed =
              JSON.parse(
                text.text,
              ) as {
                skill?: {
                  name?: unknown;
                  scope?: unknown;
                  path?: unknown;
                };
              };

            name =
              stringIdentity(
                parsed.skill?.name,
              ) ?? name;
            scope =
              stringIdentity(
                parsed.skill?.scope,
              ) ?? scope;
            path =
              stringIdentity(
                parsed.skill?.path,
              ) ?? path;
          } catch {
            // The read itself succeeded; input metadata is still sufficient.
          }
        }
      }

      if (name !== undefined) {
        turn.skills.push({
          name,
          ...(scope === undefined
            ? {}
            : { scope }),
          ...(workspace ===
          undefined
            ? {}
            : { workspace }),
          ...(path === undefined
            ? {}
            : { path }),
          usedAt:
            call.completedAt as string,
          sequence:
            this.#nextSequence(),
          callId:
            call.id,
        });
      }
    }

    if (
      turn?.sessionId !==
      undefined
    ) {
      this.#persistSession(
        turn.sessionId,
      );
    }
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

    for (
      const skill of
      turn.skills
    ) {
      events.push({
        kind:
          "skill_used",
        at:
          skill.usedAt,
        sequence:
          skill.sequence,
        callId:
          skill.callId,
        skill:
          skill.name,
      });
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
      skills:
        turn.skills.map(
          (skill) => ({
            name:
              skill.name,
            ...(skill.scope ===
            undefined
              ? {}
              : {
                  scope:
                    skill.scope,
                }),
            ...(skill.workspace ===
            undefined
              ? {}
              : {
                  workspace:
                    skill.workspace,
                }),
            ...(skill.path ===
            undefined
              ? {}
              : {
                  path:
                    skill.path,
                }),
            usedAt:
              skill.usedAt,
            callId:
              skill.callId,
          }),
        ),
      events:
        this.#turnEvents(turn),
    };
  }

  #snapshotFromMemory(
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
    const session =
      sessionId === undefined
        ? undefined
        : this.#sessionMetadata.get(
            sessionId,
          );

    return {
      ...(session === undefined
        ? {}
        : { session }),
      turns,
      sessionIdentityAvailable:
        sessionId !== undefined,
      testWindowCloseRevision:
        this.testWindowCloseRevision(
          sessionId,
        ),
    };
  }

  #mergedSnapshot(
    sessionId: string,
  ): McpObservabilitySnapshot {
    const memory =
      this.#snapshotFromMemory(
        sessionId,
      );
    const persisted =
      this.#persistence?.read(
        sessionId,
      );
    const turnsById =
      new Map<
        string,
        ObservedTurn
      >();

    for (
      const turn of
      persisted?.snapshot.turns ??
      []
    ) {
      turnsById.set(
        turn.id,
        turn,
      );
    }

    for (
      const turn of
      memory.turns
    ) {
      turnsById.set(
        turn.id,
        turn,
      );
    }

    const metadata =
      this.#sessionMetadata.get(
        sessionId,
      ) ??
      (persisted === undefined
        ? undefined
        : {
            createdAt:
              persisted.createdAt,
            updatedAt:
              persisted.updatedAt,
          });

    return {
      ...(metadata === undefined
        ? {}
        : {
            session:
              metadata,
          }),
      turns:
        [...turnsById.values()]
          .sort(
            (left, right) =>
              Date.parse(
                right.startedAt,
              ) -
              Date.parse(
                left.startedAt,
              ),
          )
          .slice(
            0,
            MAX_TURNS,
          ),
      sessionIdentityAvailable:
        true,
      testWindowCloseRevision:
        Math.max(
          memory
            .testWindowCloseRevision,
          persisted
            ?.snapshot
            .testWindowCloseRevision ??
            0,
        ),
    };
  }

  snapshot(
    sessionId?: string,
  ): McpObservabilitySnapshot {
    if (sessionId === undefined) {
      return this
        .#snapshotFromMemory();
    }

    this.ensureSession(
      sessionId,
    );

    return this.#mergedSnapshot(
      sessionId,
    );
  }
}
