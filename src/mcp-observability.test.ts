import assert from "node:assert/strict";
import test from "node:test";
import {
  McpObservabilityStore,
  extractOpenAiRequestIdentity,
} from "./mcp-observability.js";

test("McpObservabilityStore scopes calls by ChatGPT session and groups explicit turns", () => {
  const store = new McpObservabilityStore();

  store.replaceToolCatalog([
    {
      name: "run_command",
      title: "Run Local Command",
    },
    {
      name: "git_snapshot",
      title: "Git Snapshot",
    },
  ]);

  const first = store.beginToolCall(
    "run_command",
    {
      "openai/session": "conversation-a",
      "openai/turn": "turn-1",
      "openai/locale": "zh-CN",
    },
  );
  store.finishToolCall(first, "succeeded");

  const second = store.beginToolCall(
    "run_command",
    {
      "openai/session": "conversation-a",
      "openai/turn": "turn-1",
    },
  );
  store.finishToolCall(second, "succeeded");

  const third = store.beginToolCall(
    "git_snapshot",
    {
      "openai/session": "conversation-a",
      "openai/turn": "turn-2",
    },
  );
  store.finishToolCall(third, "failed");

  const otherConversation = store.beginToolCall(
    "run_command",
    {
      "openai/session": "conversation-b",
      "openai/turn": "turn-9",
    },
  );
  store.finishToolCall(
    otherConversation,
    "succeeded",
  );

  const snapshot = store.snapshot(
    "conversation-a",
  );

  assert.deepEqual(
    snapshot.tools.map((tool) => tool.name),
    [
      "git_snapshot",
      "run_command",
    ],
  );
  assert.equal(
    snapshot.turnIdentityAvailable,
    true,
  );
  assert.deepEqual(
    snapshot.turns.map((turn) => ({
      id: turn.id,
      totalCalls: turn.totalCalls,
      tools: turn.tools,
    })),
    [
      {
        id: "turn-2",
        totalCalls: 1,
        tools: [
          {
            name: "git_snapshot",
            count: 1,
          },
        ],
      },
      {
        id: "turn-1",
        totalCalls: 2,
        tools: [
          {
            name: "run_command",
            count: 2,
          },
        ],
      },
    ],
  );
  assert.equal(
    snapshot.calls.length,
    3,
  );
  assert.deepEqual(
    snapshot.observedRequestMetaKeys,
    [
      "openai/locale",
      "openai/session",
      "openai/turn",
    ],
  );
});

test("McpObservabilityStore does not invent a turn when ChatGPT only supplies a session", () => {
  const store = new McpObservabilityStore();

  const call = store.beginToolCall(
    "run_command",
    {
      "openai/session": "conversation-a",
      "some/private/value": "do-not-store",
    },
  );
  store.finishToolCall(
    call,
    "succeeded",
  );

  const otherSession =
    store.beginToolCall(
      "git_snapshot",
      {
        "openai/session":
          "conversation-b",
      },
    );
  store.finishToolCall(
    otherSession,
    "succeeded",
  );

  const snapshot = store.snapshot(
    "conversation-a",
  );

  assert.equal(
    snapshot.turnIdentityAvailable,
    false,
  );
  assert.deepEqual(
    snapshot.turns,
    [],
  );
  assert.equal(
    snapshot.ungroupedCalls,
    1,
  );
  assert.deepEqual(
    snapshot.observedRequestMetaKeys,
    [
      "openai/session",
      "some/private/value",
    ],
  );
  assert.equal(
    JSON.stringify(snapshot)
      .includes("do-not-store"),
    false,
  );

  assert.equal(
    store.snapshot()
      .calls.length,
    0,
  );
});

test("extractOpenAiRequestIdentity accepts explicit OpenAI turn-id spellings only", () => {
  assert.deepEqual(
    extractOpenAiRequestIdentity({
      "openai/session": "conversation-a",
      "openai/turn_id": "turn-3",
      "openai/userAgent": "ChatGPT",
    }),
    {
      sessionId: "conversation-a",
      turnId: "turn-3",
      turnMetaKey: "openai/turn_id",
      requestMetaKeys: [
        "openai/session",
        "openai/turn_id",
        "openai/userAgent",
      ],
    },
  );

  assert.deepEqual(
    extractOpenAiRequestIdentity({
      "openai/session": "conversation-a",
      "openai/message_id": "message-1",
    }),
    {
      sessionId: "conversation-a",
      requestMetaKeys: [
        "openai/message_id",
        "openai/session",
      ],
    },
  );
});


test("Junius test window close revisions are conversation-scoped", () => {
  const store =
    new McpObservabilityStore();

  assert.equal(
    store.testWindowCloseRevision(
      "conversation-a",
    ),
    0,
  );
  assert.equal(
    store.snapshot(
      "conversation-a",
    ).testWindowCloseRevision,
    0,
  );

  assert.equal(
    store.requestTestWindowClose(
      "conversation-a",
    ),
    1,
  );
  assert.equal(
    store.snapshot(
      "conversation-a",
    ).testWindowCloseRevision,
    1,
  );
  assert.equal(
    store.snapshot(
      "conversation-b",
    ).testWindowCloseRevision,
    0,
  );

  assert.equal(
    store.requestTestWindowClose(
      "conversation-a",
    ),
    2,
  );
  assert.equal(
    store.snapshot(
      "conversation-a",
    ).testWindowCloseRevision,
    2,
  );
});
