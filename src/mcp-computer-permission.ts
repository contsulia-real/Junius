import { createHash, randomUUID } from "node:crypto";
import { acceptedContent, inputRequired, type InputRequiredResult, type ServerContext } from "@modelcontextprotocol/server";

export type ComputerTool = "browser" | "desktop";
type Decision = "允许本轮" | "允许本会话" | "拒绝本轮" | "拒绝本会话";
interface Pending { readonly nonce: string; readonly turnId: string; readonly tool: ComputerTool }
interface Scope {
  readonly chatAllow: Set<ComputerTool>;
  readonly chatDeny: Set<ComputerTool>;
  readonly turnAllow: Set<ComputerTool>;
  readonly turnDeny: Set<ComputerTool>;
  readonly sessions: Map<ComputerTool, Set<string>>;
  pending?: Pending;
}
function scope(): Scope {
  return { chatAllow: new Set(), chatDeny: new Set(), turnAllow: new Set(), turnDeny: new Set(), sessions: new Map() };
}

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
    state.pending = undefined;
  }

  // A named device session must never be shared by different Chats.
  session(chat: string, name: string): string {
    const hash = createHash("sha256").update(chat + "\0" + name).digest("hex").slice(0, 32);
    return hash + "-" + name.slice(0, 30);
  }

  authorize(chat: string, turnId: string, tool: ComputerTool, purpose: string, context: ServerContext): boolean | InputRequiredResult {
    const state = this.#get(chat);
    if (state.chatDeny.has(tool) || state.turnDeny.has(tool)) return false;
    if (state.chatAllow.has(tool) || state.turnAllow.has(tool)) return true;

    const pending = state.pending;
    if (pending?.turnId === turnId && pending.tool === tool && context.mcpReq.requestState() === pending.nonce) {
      state.pending = undefined;
      const content = acceptedContent<{ decision: Decision }>(context.mcpReq.inputResponses, "permission");
      switch (content?.decision) {
        case "允许本轮": state.turnAllow.add(tool); return true;
        case "允许本会话": state.chatAllow.add(tool); return true;
        case "拒绝本会话": state.chatDeny.add(tool); return false;
        default: state.turnDeny.add(tool); return false;
      }
    }

    // Responses without a matching pending server nonce never confer permission.
    const nonce = randomUUID();
    state.pending = { nonce, turnId, tool };
    const toolName = tool === "browser" ? "Playwright 浏览器" : "Computer Use 桌面";
    const exposure = tool === "browser"
      ? "可能读取已登录网页和操作浏览器。"
      : "可能查看屏幕、窗口和剪贴板，并操作键盘鼠标。";
    return inputRequired({
      requestState: nonce,
      inputRequests: {
        permission: inputRequired.elicit({
          message: `Junius 请求使用${toolName}。用途：${purpose.slice(0, 350)}。${exposure}请选择授权范围：`,
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string", title: "授权选择",
                enum: ["允许本轮", "允许本会话", "拒绝本轮", "拒绝本会话"],
              },
            },
            required: ["decision"],
          },
        }),
      },
    });
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
    state.chatAllow.delete(tool);
    state.turnDeny.add(tool);
    state.pending = undefined;
  }
  endTurn(chat: string): ReadonlyMap<ComputerTool, readonly string[]> {
    const state = this.#scopes.get(chat);
    if (!state) return new Map();
    const closing = new Map<ComputerTool, readonly string[]>();
    for (const [tool, sessions] of state.sessions) {
      // Desktop control ends after every turn, even when Chat permission persists.
      if (tool === "desktop" || !state.chatAllow.has(tool)) {
        closing.set(tool, [...sessions]);
        sessions.clear();
      }
    }
    state.turnAllow.clear();
    state.turnDeny.clear();
    state.pending = undefined;
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
