import assert from "node:assert/strict";
import test from "node:test";
import {
  observabilitySessionId,
  withMcpSessionContext,
} from "./mcp-session-context.js";

test("observabilitySessionId prefers the transport session", () => {
  const resolved =
    withMcpSessionContext(
      "mcp-session-a",
      () =>
        observabilitySessionId({
          "openai/session":
            "chat-session-a",
        }),
    );

  assert.equal(
    resolved,
    "mcp-session-a",
  );
});

test("observabilitySessionId falls back to the ChatGPT conversation session", () => {
  const resolved =
    withMcpSessionContext(
      undefined,
      () =>
        observabilitySessionId({
          "openai/session":
            "chat-session-a",
        }),
    );

  assert.equal(
    resolved,
    "openai:chat-session-a",
  );
});

test("observabilitySessionId rejects missing and invalid session metadata", () => {
  const resolved =
    withMcpSessionContext(
      undefined,
      () =>
        observabilitySessionId({
          "openai/session": "",
        }),
    );

  assert.equal(
    resolved,
    undefined,
  );
});
