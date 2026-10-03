import assert from "node:assert/strict";
import test from "node:test";
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
  JUNIUS_TEST_WINDOW_OPEN_TOOL,
  attachMcpObservability,
} from "./mcp-observability-server.js";
import {
  PANEL_RESOURCE_URI,
  registerMcpObservabilityPanel,
} from "./mcp-observability-panel.js";

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
    /testWindowOpen/u,
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

test("MCP observability automatically records ordinary tools and excludes panel plumbing", async () => {
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
      title: "Ordinary Tool",
    },
    async () => ({
      content: [],
    }),
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
  await view.executeToolHandler(
    view._registeredTools
      .ordinary_tool,
    {},
    fakeContext({
      "openai/session":
        "conversation-1",
      "openai/turn_id":
        "turn-1",
    }),
  );

  const ordinarySnapshot =
    store.snapshot(
      "conversation-1",
    );

  assert.deepEqual(
    ordinarySnapshot.tools,
    [
      {
        name: "close_junius_test_window",
        title: "关闭 Junius 测试窗口",
      },
      {
        name: "open_junius_test_window",
        title: "打开 Junius 测试窗口",
      },
      {
        name: "ordinary_tool",
        title: "Ordinary Tool",
      },
    ],
  );
  assert.equal(
    ordinarySnapshot.calls.length,
    1,
  );
  assert.equal(
    ordinarySnapshot.calls[0]
      ?.tool,
    "ordinary_tool",
  );

  const panelResult =
    await view.executeToolHandler(
      view._registeredTools[
        JUNIUS_PANEL_TOOL
      ],
      {},
      fakeContext({
        "openai/session":
          "conversation-1",
        "openai/turn_id":
          "turn-1",
      }),
    ) as {
      structuredContent?: {
        calls?: readonly unknown[];
      };
    };

  assert.equal(
    panelResult
      .structuredContent
      ?.calls
      ?.length,
    1,
  );
  assert.equal(
    store.snapshot(
      "conversation-1",
    ).calls.length,
    1,
  );
});


test("Junius test window controls require a ChatGPT session and gate the panel", async () => {
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
  const openTool =
    view._registeredTools[
      JUNIUS_TEST_WINDOW_OPEN_TOOL
    ];
  const closeTool =
    view._registeredTools[
      JUNIUS_TEST_WINDOW_CLOSE_TOOL
    ];
  const panelTool =
    view._registeredTools[
      JUNIUS_PANEL_TOOL
    ];

  assert.ok(openTool);
  assert.ok(closeTool);
  assert.ok(panelTool);

  assert.deepEqual(
    (
      openTool._meta?.ui as
        | {
            visibility?:
              readonly string[];
          }
        | undefined
    )?.visibility,
    [
      "model",
    ],
  );
  assert.deepEqual(
    (
      closeTool._meta?.ui as
        | {
            visibility?:
              readonly string[];
          }
        | undefined
    )?.visibility,
    [
      "model",
    ],
  );

  const unauthorizedPanel =
    await view.executeToolHandler(
      panelTool,
      {},
      fakeContext({
        "openai/session":
          "conversation-1",
      }),
    ) as {
      structuredContent?: {
        testWindowOpen?: boolean;
      };
    };

  assert.equal(
    unauthorizedPanel
      .structuredContent
      ?.testWindowOpen,
    false,
  );

  const missingSession =
    await view.executeToolHandler(
      openTool,
      {},
      fakeContext(),
    ) as {
      isError?: boolean;
    };
  assert.equal(
    missingSession.isError,
    true,
  );

  const opened =
    await view.executeToolHandler(
      openTool,
      {},
      fakeContext({
        "openai/session":
          "conversation-1",
      }),
    ) as {
      structuredContent?: {
        testWindowOpen?: boolean;
      };
    };
  assert.equal(
    opened.structuredContent
      ?.testWindowOpen,
    true,
  );
  assert.equal(
    store.isTestWindowOpen(
      "conversation-1",
    ),
    true,
  );
  assert.equal(
    store.isTestWindowOpen(
      "conversation-2",
    ),
    false,
  );

  const authorizedPanel =
    await view.executeToolHandler(
      panelTool,
      {},
      fakeContext({
        "openai/session":
          "conversation-1",
      }),
    ) as {
      structuredContent?: {
        testWindowOpen?: boolean;
      };
    };
  assert.equal(
    authorizedPanel
      .structuredContent
      ?.testWindowOpen,
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
        testWindowOpen?: boolean;
      };
    };
  assert.equal(
    closed.structuredContent
      ?.testWindowOpen,
    false,
  );
  assert.equal(
    store.isTestWindowOpen(
      "conversation-1",
    ),
    false,
  );
});
