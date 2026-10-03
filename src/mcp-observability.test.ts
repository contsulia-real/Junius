import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import {
  join,
} from "node:path";
import {
  tmpdir,
} from "node:os";
import test from "node:test";
import {
  McpObservabilityStore,
  renderTurnTitle,
} from "./mcp-observability.js";

test("renderTurnTitle keeps user text and renders every file input as [File]", () => {
  assert.equal(
    renderTurnTitle([
      {
        type: "text",
        text:
          "比较这几个文件\n并告诉我差异",
      },
      {
        type: "file",
      },
      {
        type: "file",
      },
      {
        type: "file",
      },
    ]),
    "比较这几个文件 并告诉我差异 [File] [File] [File]",
  );
});

test("McpObservabilityStore owns turn boundaries, groups tools, preserves call differences, and orders events", () => {
  const store =
    new McpObservabilityStore();

  store.replaceToolCatalog([
    {
      name: "run_command",
      title:
        "Run Command",
    },
    {
      name:
        "git_snapshot",
      title:
        "Git Snapshot",
    },
  ]);

  store.beginTurn(
    "conversation-a",
    [
      {
        type: "text",
        text:
          "检查项目然后比较两个输入",
      },
      {
        type: "file",
      },
      {
        type: "file",
      },
    ],
  );

  const first =
    store.beginToolCall(
      "run_command",
      {
        executable:
          "git",
        args: [
          "status",
        ],
      },
      "conversation-a",
    );
  store.finishToolCall(
    first,
    "succeeded",
  );

  const second =
    store.beginToolCall(
      "run_command",
      {
        executable:
          "git",
        args: [
          "diff",
          "--stat",
        ],
      },
      "conversation-a",
    );
  store.finishToolCall(
    second,
    "failed",
  );

  const third =
    store.beginToolCall(
      "git_snapshot",
      {
        recent_commits: 5,
      },
      "conversation-a",
    );
  store.finishToolCall(
    third,
    "succeeded",
  );

  store.endTurn(
    "conversation-a",
  );

  store.beginTurn(
    "conversation-b",
    [
      {
        type: "text",
        text: "别的会话",
      },
    ],
  );
  const other =
    store.beginToolCall(
      "run_command",
      {
        executable:
          "echo",
      },
      "conversation-b",
    );
  store.finishToolCall(
    other,
    "succeeded",
  );
  store.endTurn(
    "conversation-b",
  );

  const snapshot =
    store.snapshot(
      "conversation-a",
    );

  assert.equal(
    snapshot.turns.length,
    1,
  );

  const turn =
    snapshot.turns[0];
  assert.ok(turn);

  assert.equal(
    turn.title,
    "检查项目然后比较两个输入 [File] [File]",
  );
  assert.equal(
    turn.status,
    "completed",
  );
  assert.equal(
    turn.totalCalls,
    3,
  );
  assert.deepEqual(
    turn.tools.map(
      (tool) => ({
        name:
          tool.name,
        title:
          tool.title,
        count:
          tool.count,
      }),
    ),
    [
      {
        name:
          "run_command",
        title:
          "Run Command",
        count: 2,
      },
      {
        name:
          "git_snapshot",
        title:
          "Git Snapshot",
        count: 1,
      },
    ],
  );

  const runCommand =
    turn.tools[0];
  assert.ok(runCommand);

  assert.deepEqual(
    runCommand.calls.map(
      (call) =>
        call.input,
    ),
    [
      {
        executable:
          "git",
        args: [
          "status",
        ],
      },
      {
        executable:
          "git",
        args: [
          "diff",
          "--stat",
        ],
      },
    ],
  );

  assert.deepEqual(
    turn.events.map(
      (event) =>
        event.kind,
    ),
    [
      "turn_started",
      "tool_started",
      "tool_succeeded",
      "tool_started",
      "tool_failed",
      "tool_started",
      "tool_succeeded",
      "turn_completed",
    ],
  );

  assert.deepEqual(
    [...turn.events]
      .map(
        (event) =>
          event.sequence,
      ),
    [...turn.events]
      .map(
        (event) =>
          event.sequence,
      )
      .sort(
        (left, right) =>
          left - right,
      ),
  );
});

test("McpObservabilityStore rejects tool calls before an explicit turn begins", () => {
  const store =
    new McpObservabilityStore();

  assert.throws(
    () =>
      store.beginToolCall(
        "run_command",
        {
          executable:
            "git",
        },
        "conversation-a",
      ),
    /junius_turn_not_started/u,
  );

  assert.deepEqual(
    store.snapshot(
      "conversation-a",
    ).turns,
    [],
  );
});

test("beginTurn closes an unfinished prior turn in the same conversation", () => {
  const store =
    new McpObservabilityStore();

  store.beginTurn(
    "conversation-a",
    [
      {
        type: "text",
        text: "第一轮",
      },
    ],
  );
  const first =
    store.beginToolCall(
      "run_command",
      {},
      "conversation-a",
    );
  store.finishToolCall(
    first,
    "succeeded",
  );

  store.beginTurn(
    "conversation-a",
    [
      {
        type: "text",
        text: "第二轮",
      },
    ],
  );
  const second =
    store.beginToolCall(
      "git_snapshot",
      {},
      "conversation-a",
    );
  store.finishToolCall(
    second,
    "succeeded",
  );

  const turns =
    store.snapshot(
      "conversation-a",
    ).turns;

  assert.equal(
    turns[0]?.title,
    "第二轮",
  );
  assert.equal(
    turns[0]?.status,
    "active",
  );
  assert.equal(
    turns[1]?.title,
    "第一轮",
  );
  assert.equal(
    turns[1]?.status,
    "completed",
  );
});

test("Junius test window close revisions remain MCP-session-scoped", () => {
  const store =
    new McpObservabilityStore();

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
});


test("McpObservabilityStore persists MCP-session history, records successful Skill use, and deletes with the session", () => {
  const root =
    mkdtempSync(
      join(
        tmpdir(),
        "junius-observability-",
      ),
    );

  try {
    const first =
      new McpObservabilityStore({
        rootPath: root,
      });

    first.replaceToolCatalog([
      {
        name: "read_skill",
        title: "Read Skill",
      },
    ]);

    first.ensureSession(
      "session-a",
    );
    first.beginTurn(
      "session-a",
      [
        {
          type: "text",
          text: "修这个代码",
        },
      ],
    );

    const callId =
      first.beginToolCall(
        "read_skill",
        {
          name: "ponytail",
          scope: "global",
        },
        "session-a",
      );

    first.finishToolCall(
      callId,
      "succeeded",
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              skill: {
                name: "ponytail",
                scope: "global",
                path: "SKILL.md",
              },
            }),
          },
        ],
      },
    );
    first.endTurn(
      "session-a",
    );

    assert.equal(
      readdirSync(root).length,
      1,
    );

    const second =
      new McpObservabilityStore({
        rootPath: root,
      });
    const restored =
      second.snapshot(
        "session-a",
      );
    const turn =
      restored.turns[0];

    assert.ok(
      restored.session,
    );
    assert.ok(turn);
    assert.deepEqual(
      turn.skills,
      [
        {
          name: "ponytail",
          scope: "global",
          path: "SKILL.md",
          usedAt:
            turn.skills[0]
              ?.usedAt,
          callId,
        },
      ],
    );
    assert.equal(
      turn.events.some(
        (event) =>
          event.kind ===
            "skill_used" &&
          event.skill ===
            "ponytail",
      ),
      true,
    );

    second.deleteSession(
      "session-a",
    );

    assert.deepEqual(
      readdirSync(root),
      [],
    );
  } finally {
    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});
