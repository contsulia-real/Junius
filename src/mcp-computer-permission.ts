import { createHash, randomUUID } from "node:crypto";

export type ComputerTool = "browser" | "desktop";
export const COMPUTER_DECISIONS = ["允许本轮", "允许本会话", "拒绝本轮", "拒绝本会话"] as const;
export type ComputerDecision = (typeof COMPUTER_DECISIONS)[number];
interface Pending {
  nonce: string;
  turnId: string;
  tool: ComputerTool;
  purpose: string;
  createdAt: number;
}
interface Scope {
  readonly chatAllow: Set<ComputerTool>;
  readonly chatDeny: Set<ComputerTool>;
  readonly turnAllow: Set<ComputerTool>;
  readonly turnDeny: Set<ComputerTool>;
  readonly nextTurnAllow: Set<ComputerTool>;
  readonly sessions: Map<ComputerTool, Set<string>>;
  pending?: Pending;
}
function scope(): Scope {
  return { chatAllow: new Set(), chatDeny: new Set(), turnAllow: new Set(),
    turnDeny: new Set(), nextTurnAllow: new Set(), sessions: new Map() };
}
const REQUEST_TTL_MS = 5 * 60_000;

export class ComputerPermissionManager {
  readonly #scopes = new Map<string, Scope>();
  #get(chat: string): Scope {
    let state = this.#scopes.get(chat);
    if (!state) { state = scope(); this.#scopes.set(chat, state); }
    return state;
  }
  beginTurn(chat: string): void {
    const state = this.#get(chat);
    state.turnAllow.clear();
    state.turnDeny.clear();
    for (const tool of state.nextTurnAllow) state.turnAllow.add(tool);
    state.nextTurnAllow.clear();
  }
  session(chat: string, name: string): string {
    const hash = createHash("sha256").update(chat + "\0" + name).digest("hex").slice(0, 32);
    return hash + "-" + name.slice(0, 30);
  }
  authorize(chat: string, turnId: string, tool: ComputerTool, purpose: string): "allowed" | "denied" | "pending" {
    const state = this.#get(chat);
    if (state.chatDeny.has(tool) || state.turnDeny.has(tool)) return "denied";
    if (state.chatAllow.has(tool) || state.turnAllow.has(tool)) return "allowed";
    if (state.pending?.turnId !== turnId || state.pending.tool !== tool) {
      state.pending = { nonce: randomUUID(), turnId, tool, purpose, createdAt: Date.now() };
    }
    return "pending";
  }
  pending(chat: string): (Pending & { status: "pending" }) | undefined {
    const state = this.#scopes.get(chat);
    const pending = state?.pending;
    if (!pending) return undefined;
    if (Date.now() - pending.createdAt > REQUEST_TTL_MS) {
      state!.pending = undefined;
      return undefined;
    }
    return { ...pending, status: "pending" };
  }
  pendingByNonce(nonce: string): ({ chat: string } & Pending) | undefined {
    for (const chat of this.#scopes.keys()) {
      const pending = this.pending(chat);
      if (pending?.nonce === nonce) return { chat, ...pending };
    }
    return undefined;
  }
  decideByNonce(nonce: string, decision: ComputerDecision, chat?: string): boolean {
    const pending = this.pendingByNonce(nonce);
    return pending !== undefined &&
      (chat === undefined || pending.chat === chat) &&
      this.decide(pending.chat, nonce, decision);
  }
  decide(chat: string, nonce: string, decision: ComputerDecision): boolean {
    const state = this.#scopes.get(chat);
    const pending = this.pending(chat);
    if (!state || !pending || pending.nonce !== nonce || !COMPUTER_DECISIONS.includes(decision)) return false;
    state.pending = undefined;
    const tool = pending.tool;
    switch (decision) {
      case "允许本会话": state.chatAllow.add(tool); break;
      case "允许本轮": state.nextTurnAllow.add(tool); break;
      case "拒绝本会话": state.chatDeny.add(tool); break;
      case "拒绝本轮": state.turnDeny.add(tool); break;
    }
    return true;
  }
  track(chat: string, tool: ComputerTool, session: string): void {
    const state = this.#get(chat);
    let names = state.sessions.get(tool);
    if (!names) { names = new Set(); state.sessions.set(tool, names); }
    names.add(session);
  }
  isTracked(chat: string, tool: ComputerTool, session: string): boolean {
    return this.#scopes.get(chat)?.sessions.get(tool)?.has(session) ?? false;
  }
  untrack(chat: string, tool: ComputerTool, session: string): void {
    this.#scopes.get(chat)?.sessions.get(tool)?.delete(session);
  }
  interrupt(chat: string, tool: ComputerTool): void {
    const state = this.#get(chat);
    state.turnAllow.delete(tool);
    state.nextTurnAllow.delete(tool);
    state.chatAllow.delete(tool);
    state.turnDeny.add(tool);
    state.pending = undefined;
  }
  endTurn(chat: string): ReadonlyMap<ComputerTool, readonly string[]> {
    const state = this.#scopes.get(chat);
    if (!state) return new Map();
    const closing = new Map<ComputerTool, readonly string[]>();
    for (const [tool, sessions] of state.sessions) {
      if (tool === "desktop" || !state.chatAllow.has(tool)) {
        closing.set(tool, [...sessions]);
        sessions.clear();
      }
    }
    state.turnAllow.clear();
    state.turnDeny.clear();
    // Keep pending approval until its short expiry: the user may click after the model finishes this turn.
    return closing;
  }
  endChat(chat: string): ReadonlyMap<ComputerTool, readonly string[]> {
    const state = this.#scopes.get(chat);
    if (!state) return new Map();
    const closing = new Map<ComputerTool, readonly string[]>(
      [...state.sessions].map(([tool, names]) => [tool, [...names]]),
    );
    this.#scopes.delete(chat);
    return closing;
  }
}

export async function closeComputerSessions(
  closing: ReadonlyMap<ComputerTool, readonly string[]>,
  browser: import("./playwright-cli.js").PlaywrightCliService,
  desktop: import("./desktop-computer-use.js").DesktopComputerUseService,
): Promise<void> {
  await Promise.allSettled(
    [...closing].flatMap(([tool, sessions]) =>
      sessions.map((session) => tool === "browser"
        ? browser.run(session, "close", []).then(() => undefined)
        : desktop.run({ session, command: "control_end" }).then(() => undefined)),
    ),
  );
}
