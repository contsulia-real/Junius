import { createHash } from "node:crypto";

export type ComputerTool = "browser" | "desktop";
type Scope = {
  sessions: Map<ComputerTool, Set<string>>;
  interrupted: Set<ComputerTool>;
};

export class ComputerSessionManager {
  readonly #scopes = new Map<string, Scope>();
  #get(chat: string): Scope {
    let state = this.#scopes.get(chat);
    if (!state) {
      state = { sessions: new Map(), interrupted: new Set() };
      this.#scopes.set(chat, state);
    }
    return state;
  }
  beginTurn(chat: string): void {
    this.#get(chat).interrupted.clear();
  }
  session(chat: string, name: string): string {
    const hash = createHash("sha256").update(chat + "\0" + name).digest("hex").slice(0, 32);
    return hash + "-" + name.slice(0, 30);
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
    this.#get(chat).interrupted.add(tool);
  }
  wasInterrupted(chat: string, tool: ComputerTool): boolean {
    return this.#scopes.get(chat)?.interrupted.has(tool) ?? false;
  }
  endTurn(chat: string): ReadonlyMap<ComputerTool, readonly string[]> {
    const state = this.#scopes.get(chat);
    if (!state) return new Map();
    const desktop = state.sessions.get("desktop");
    const closing = new Map<ComputerTool, readonly string[]>();
    if (desktop && desktop.size > 0) {
      closing.set("desktop", [...desktop]);
      desktop.clear();
    }
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
