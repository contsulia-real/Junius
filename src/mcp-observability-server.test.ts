import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  McpServer,
  type RegisteredTool,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  McpObservabilityStore,
} from "./mcp-observability.js";
import {
  JUNIUS_PANEL_SNAPSHOT_TOOL,
  JUNIUS_PANEL_TOOL,
  JUNIUS_TEST_WINDOW_CLOSE_TOOL,
  attachMcpObservability,
} from "./mcp-observability-server.js";
import {
  PANEL_RESOURCE_URI,
  registerMcpObservabilityPanel,
} from "./mcp-observability-panel.js";
import {
  JUNIUS_TURN_BEGIN_TOOL,
  JUNIUS_TURN_END_TOOL,
  registerMcpTurnTools,
} from "./mcp-turn-tools.js";

interface ServerInternals {
  readonly _registeredTools:
    Record<string, RegisteredTool>;
  readonly _registeredResources:
    Record<
      string,
      {
        readonly metadata?:
          Record<string, unknown>;
        readonly readCallback:
          (
            uri: URL,
            extra: unknown,
          ) =>
            | Promise<{
                contents:
                  readonly {
                    uri: string;
                    mimeType?: string;
                    text?: string;
                  }[];
              }>
            | {
                contents:
                  readonly {
                    uri: string;
                    mimeType?: string;
                    text?: string;
                  }[];
              };
      }
    >;
  executeToolHandler(
    tool: RegisteredTool,
    args: unknown,
    context: ServerContext,
  ): Promise<unknown>;
}

function internals(
  server: McpServer,
): ServerInternals {
  return server as unknown as
    ServerInternals;
}

function fakeContext(
  metadata:
    Record<string, unknown> = {},
): ServerContext {
  return {
    mcpReq: {
      id: 1,
      method: "tools/call",
      _meta: metadata,
    },
  } as unknown as ServerContext;
}

test("Junius observability panel registers a ChatGPT thread entrypoint and app-only helpers", async () => {
  const server =
    new McpServer({
      name: "Junius Test",
      version: "0",
    });
  const store =
    new McpObservabilityStore();

  registerMcpObservabilityPanel(
    server,
    store,
  );

  const view =
    internals(server);
  const panel =
    view._registeredTools[
      JUNIUS_PANEL_TOOL
    ];
  const snapshot =
    view._registeredTools[
      JUNIUS_PANEL_SNAPSHOT_TOOL
    ];

  assert.ok(panel);
  assert.ok(snapshot);
  assert.deepEqual(
    panel._meta?.["openai/ui"],
    {
      entrypoints: [
        {
          type: "thread",
        },
      ],
    },
  );
  assert.deepEqual(
    (
      panel._meta?.ui as
        | {
            visibility?:
              readonly string[];
          }
        | undefined
    )?.visibility,
    [
      "model",
      "app",
    ],
  );
  assert.deepEqual(
    (
      snapshot._meta?.ui as
        | {
            visibility?:
              readonly string[];
          }
        | undefined
    )?.visibility,
    [
      "app",
    ],
  );
  assert.equal(
    (
      snapshot._meta?.ui as
        | {
            resourceUri?: unknown;
          }
        | undefined
    )?.resourceUri,
    undefined,
  );

  const resource =
    view._registeredResources[
      PANEL_RESOURCE_URI
    ];
  assert.ok(resource);

  const resourceResult =
    await resource.readCallback(
      new URL(
        PANEL_RESOURCE_URI,
      ),
      {},
    );
  const content =
    resourceResult.contents[0];

  assert.equal(
    content?.mimeType,
    "text/html;profile=mcp-app",
  );
  assert.match(
    content?.text ?? "",
    /data-tab="tools"/u,
  );
  assert.match(
    content?.text ?? "",
    /data-tab="logs"/u,
  );
  assert.match(
    content?.text ?? "",
    /ui\/initialize/u,
  );
  assert.match(
    content?.text ?? "",
    /tools\/call/u,
  );
  assert.match(
    content?.text ?? "",
    /ui\/resource-teardown/u,
  );
  assert.match(
    content?.text ?? "",
    /requestClose/u,
  );
  assert.match(
    content?.text ?? "",
    /testWindowCloseRevision/u,
  );
  assert.match(
    content?.text ?? "",
    /tool-accordion/u,
  );
  assert.doesNotMatch(
    content?.text ?? "",
    /最近调用/u,
  );

  const script =
    (content?.text ?? "")
      .match(
        /<script>([\s\S]*?)<\/script>/u,
      )?.[1];
  assert.ok(script);
  assert.doesNotThrow(
    () => new Function(script),
  );
});

test("MCP observability records ordinary tools inside Junius-owned turns and excludes turn plumbing", async () => {
  const server =
    new McpServer({
      name: "Junius Test",
      version: "0",
    });
  const store =
    new McpObservabilityStore();

  server.registerTool(
    "ordinary_tool",
    {
      title:
        "Ordinary Tool",
      inputSchema: {
        value:
          z.string(),
      },
    },
    async () => ({
      content: [],
    }),
  );

  registerMcpTurnTools(
    server,
    store,
  );
  registerMcpObservabilityPanel(
    server,
    store,
  );
  attachMcpObservability(
    server,
    store,
  );

  const view =
    internals(server);
  const context =
    fakeContext({
      "openai/session":
        "conversation-1",
    });

  await view.executeToolHandler(
    view._registeredTools[
      JUNIUS_TURN_BEGIN_TOOL
    ],
    {
      parts: [
        {
          type: "text",
          text:
            "对比这两个文件",
        },
        {
          type: "file",
        },
        {
          type: "file",
        },
      ],
    },
    context,
  );

  await view.executeToolHandler(
    view._registeredTools
      .ordinary_tool,
    {
      value: "first",
    },
    context,
  );

  await view.executeToolHandler(
    view._registeredTools
      .ordinary_tool,
    {
      value: "second",
    },
    context,
  );

  await view.executeToolHandler(
    view._registeredTools[
      JUNIUS_TURN_END_TOOL
    ],
    {},
    context,
  );

  const snapshot =
    store.snapshot(
      "conversation-1",
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
    "对比这两个文件 [File] [File]",
  );
  assert.equal(
    turn.totalCalls,
    2,
  );
  assert.equal(
    turn.tools.length,
    1,
  );
  assert.equal(
    turn.tools[0]?.name,
    "ordinary_tool",
  );
  assert.deepEqual(
    turn.tools[0]?.calls.map(
      (call) => call.input,
    ),
    [
      {
        value: "first",
      },
      {
        value: "second",
      },
    ],
  );
  assert.deepEqual(
    turn.events.map(
      (event) => event.kind,
    ),
    [
      "turn_started",
      "tool_started",
      "tool_succeeded",
      "tool_started",
      "tool_succeeded",
      "turn_completed",
    ],
  );

  const panelResult =
    await view.executeToolHandler(
      view._registeredTools[
        JUNIUS_PANEL_TOOL
      ],
      {},
      context,
    ) as {
      structuredContent?: {
        turns?: readonly {
          title?: string;
        }[];
      };
    };

  assert.equal(
    panelResult
      .structuredContent
      ?.turns?.[0]
      ?.title,
    "对比这两个文件 [File] [File]",
  );
});

test("Junius panel opens without authorization and close signals are conversation-scoped", async () => {
  const server =
    new McpServer({
      name: "Junius Test",
      version: "0",
    });
  const store =
    new McpObservabilityStore();

  registerMcpObservabilityPanel(
    server,
    store,
  );

  const view =
    internals(server);
  const closeTool =
    view._registeredTools[
      JUNIUS_TEST_WINDOW_CLOSE_TOOL
    ];
  const panelTool =
    view._registeredTools[
      JUNIUS_PANEL_TOOL
    ];

  assert.ok(closeTool);
  assert.ok(panelTool);

  const manuallyOpened =
    await view.executeToolHandler(
      panelTool,
      {},
      fakeContext({
        "openai/session":
          "conversation-1",
      }),
    ) as {
      structuredContent?: {
        testWindowCloseRevision?: number;
      };
    };

  assert.equal(
    manuallyOpened
      .structuredContent
      ?.testWindowCloseRevision,
    0,
  );

  const missingSession =
    await view.executeToolHandler(
      closeTool,
      {},
      fakeContext(),
    ) as {
      isError?: boolean;
    };
  assert.equal(
    missingSession.isError,
    true,
  );

  const closed =
    await view.executeToolHandler(
      closeTool,
      {},
      fakeContext({
        "openai/session":
          "conversation-1",
      }),
    ) as {
      structuredContent?: {
        testWindowCloseRevision?: number;
      };
    };

  assert.equal(
    closed.structuredContent
      ?.testWindowCloseRevision,
    1,
  );
  assert.equal(
    store.testWindowCloseRevision(
      "conversation-1",
    ),
    1,
  );
  assert.equal(
    store.testWindowCloseRevision(
      "conversation-2",
    ),
    0,
  );

  const reopened =
    await view.executeToolHandler(
      panelTool,
      {},
      fakeContext({
        "openai/session":
          "conversation-1",
      }),
    ) as {
      structuredContent?: {
        testWindowCloseRevision?: number;
      };
    };

  assert.equal(
    reopened
      .structuredContent
      ?.testWindowCloseRevision,
    1,
  );
});
