import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  createServer,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import {
  HostLatencyTraceStore,
  proxyToActiveWorker,
} from "./reverse-proxy.js";
import type { SourceCheckResult } from "./source-check.js";
import { WORKER_AUTH_HEADER } from "./worker-auth.js";
import type { ManagedWorker } from "./worker-process.js";
import { WorkerSupervisor } from "./worker-supervisor.js";

function successfulCheck(): SourceCheckResult {
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
  };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function targetWorker(
  id: string,
): Promise<{
  worker: ManagedWorker;
  server: Server;
}> {
  const child = new EventEmitter() as unknown as ChildProcess;
  let exited = false;

  const server = createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.headers["mcp-session-id"] === undefined) {
      res.setHeader("mcp-session-id", "session-a");
    }

    res.setHeader("content-type", "text/plain");
    res.end(id);
  });
  const port = await listen(server);

  return {
    server,
    worker: {
      id,
      child,
      pid: id === "worker-a" ? 101 : 202,
      mcpPort: port,
      adminPort: port,
      internalToken: `token-${id}-012345678901234567890123456789`,
      startedAt: new Date().toISOString(),
      stdout: () => "",
      stderr: () => "",
      exited: () => exited,
      async close() {
        if (exited) return;
        exited = true;
        await closeServer(server);
        child.emit("exit", 0, null);
      },
    },
  };
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  });
}

function toolResult(payload: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload),
        },
      ],
    },
  });
}

function toolErrorResult(payload: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(payload),
        },
      ],
    },
  });
}

async function statelessToolWorker(
  id: string,
): Promise<{
  worker: ManagedWorker;
  server: Server;
  receivedWorkerTokens: string[];
  configurationReloads(): number;
}> {
  const child = new EventEmitter() as unknown as ChildProcess;
  let exited = false;
  let reloads = 0;
  const receivedWorkerTokens: string[] = [];

  const server = createServer(async (req, res) => {
    const workerToken =
      req.headers[WORKER_AUTH_HEADER];
    if (typeof workerToken === "string") {
      receivedWorkerTokens.push(workerToken);
    }

    if (
      req.url === "/__junius/config-reload" &&
      req.method === "POST"
    ) {
      reloads += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        workerId: id,
      }));
      return;
    }

    if (req.url !== "/mcp" || req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    }

    const request = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as {
      params?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    };
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};

    let payload: unknown = {
      ok: true,
      worker: id,
    };

    if (name === "start_job") {
      payload = {
        ok: true,
        job: {
          id: "job-1",
          worker: id,
        },
        ...(args.oversized === true
          ? {
              padding: "x".repeat(
                1024 * 1024 + 1024,
              ),
            }
          : {}),
      };
    }

    if (name === "playwright_cli") {
      payload = {
        ok: true,
        worker: id,
        session: args.session ?? "junius",
        command: args.command,
      };
    }

    if (name === "desktop") {
      payload = {
        ok: true,
        worker: id,
        session: args.session ?? "junius",
        command: args.command,
      };

      if (
        args.command === "control_end" &&
        args.fail === true
      ) {
        res.setHeader("content-type", "application/json");
        res.setHeader("x-junius-worker-duration-ms", "7");
        res.end(
          toolErrorResult({
            ok: false,
            worker: id,
            session: args.session ?? "junius",
            command: args.command,
          }),
        );
        return;
      }
    }

    res.setHeader("content-type", "application/json");
    res.setHeader("x-junius-worker-duration-ms", "7");
    res.end(toolResult(payload));
  });
  const port = await listen(server);

  return {
    server,
    receivedWorkerTokens,
    configurationReloads: () => reloads,
    worker: {
      id,
      child,
      pid: id === "worker-a" ? 101 : 202,
      mcpPort: port,
      adminPort: port,
      internalToken: `token-${id}-012345678901234567890123456789`,
      startedAt: new Date().toISOString(),
      stdout: () => "",
      stderr: () => "",
      exited: () => exited,
      async close() {
        if (exited) return;
        exited = true;
        await closeServer(server);
        child.emit("exit", 0, null);
      },
    },
  };
}

async function callTool(
  origin: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(origin + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: toolCall(name, args),
  });
  assert.equal(response.status, 200);

  const message = await response.json() as {
    result?: {
      content?: {
        type?: string;
        text?: string;
      }[];
    };
  };
  const text = message.result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text!) as Record<string, unknown>;
}

test("HostLatencyTraceStore keeps the newest bounded traces", () => {
  const traces = new HostLatencyTraceStore(2);

  for (const traceId of ["a", "b", "c"]) {
    traces.record({
      traceId,
      statusCode: 200,
      hostTotalMs: 1,
      completedAt: "2026-09-27T00:00:00.000Z",
    });
  }

  assert.deepEqual(
    traces.list().map((trace) => trace.traceId),
    ["c", "b"],
  );
});

test("reverse proxy records layered modern MCP latency", async () => {
  const target = await statelessToolWorker("worker-a");
  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => target.worker,
  });
  const traces = new HostLatencyTraceStore(8);
  const proxy = createServer((req, res) => {
    proxyToActiveWorker(
      req,
      res,
      supervisor,
      "mcp",
      traces,
    );
  });

  try {
    await supervisor.startInitial();
    const proxyPort = await listen(proxy);
    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WORKER_AUTH_HEADER]:
            "forged-client-token",
        },
        body: toolCall("list_workspaces", {}),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(
      typeof response.headers.get("x-junius-trace-id"),
      "string",
    );
    await response.text();

    assert.deepEqual(
      target.receivedWorkerTokens,
      [target.worker.internalToken],
    );

    const [trace] = traces.list();
    assert.equal(trace?.tool, "list_workspaces");
    assert.equal(trace?.workerId, "worker-a");
    assert.equal(trace?.statusCode, 200);
    assert.equal(trace?.workerDurationMs, 7);
    assert.equal(
      typeof trace?.proxyOverheadMs,
      "number",
    );
    assert.equal(
      typeof trace?.hostTotalMs,
      "number",
    );
  } finally {
    await closeServer(proxy);
    await supervisor.close();
    await closeServer(target.server);
  }
});

test("Workspace MCP mutations synchronize retiring Workers before returning", async () => {
  const first = await statelessToolWorker("worker-a");
  const second = await statelessToolWorker("worker-b");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => queue.shift()!,
  });

  const proxy = createServer((req, res) => {
    proxyToActiveWorker(
      req,
      res,
      supervisor,
      "mcp",
    );
  });

  try {
    await supervisor.startInitial();
    await supervisor.reload("promote-worker-b");

    const proxyPort = await listen(proxy);
    const origin =
      `http://127.0.0.1:${proxyPort}`;

    const created = await callTool(
      origin,
      "create_workspace",
      {
        id: "new-workspace",
        root_path: "C:\\Project",
      },
    );

    assert.equal(
      created.worker,
      "worker-b",
    );
    assert.equal(
      first.configurationReloads(),
      1,
    );
    assert.equal(
      second.configurationReloads(),
      0,
    );

    const deleted = await callTool(
      origin,
      "delete_workspace",
      {
        id: "new-workspace",
      },
      {
        "mcp-session-id":
          "legacy-session",
      },
    );

    assert.equal(
      deleted.worker,
      "worker-b",
    );
    assert.equal(
      first.configurationReloads(),
      2,
    );
  } finally {
    await closeServer(proxy);
    await supervisor.close();
    await Promise.allSettled([
      closeServer(first.server),
      closeServer(second.server),
    ]);
  }
});

test("reverse proxy rejects oversized sessionful MCP request bodies", async () => {
  const child = new EventEmitter() as unknown as ChildProcess;
  let exited = false;
  let receivedBytes = 0;

  const server = createServer((req, res) => {
    req.on("data", (chunk: Buffer | string) => {
      receivedBytes += Buffer.byteLength(chunk);
    });
    req.on("end", () => {
      res.statusCode = 200;
      res.end("ok");
    });
    req.on("aborted", () => {
      // Expected when the Host enforces the request limit.
    });
  });
  const port = await listen(server);

  const worker: ManagedWorker = {
    id: "worker-a",
    child,
    pid: 101,
    mcpPort: port,
    adminPort: port,
    internalToken:
      "token-worker-a-012345678901234567890123456789",
    startedAt: new Date().toISOString(),
    stdout: () => "",
    stderr: () => "",
    exited: () => exited,
    async close() {
      if (exited) return;
      exited = true;
      await closeServer(server);
      child.emit("exit", 0, null);
    },
  };

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => worker,
  });

  const proxy = createServer((req, res) => {
    proxyToActiveWorker(
      req,
      res,
      supervisor,
      "mcp",
    );
  });

  try {
    await supervisor.startInitial();
    const proxyPort = await listen(proxy);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "mcp-session-id": "session-a",
        },
        body: Buffer.alloc(
          16 * 1024 * 1024 + 1,
          0x61,
        ),
      },
    );

    assert.equal(response.status, 413);
    assert.deepEqual(
      await response.json(),
      {
        error: "mcp_request_too_large",
      },
    );
    assert.equal(
      receivedBytes < 16 * 1024 * 1024 + 1,
      true,
    );
  } finally {
    await closeServer(proxy);
    await supervisor.close();
    await closeServer(server);
  }
});

test("reverse proxy keeps existing MCP session on retiring worker after promotion", async () => {
  const first = await targetWorker("worker-a");
  const second = await targetWorker("worker-b");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => queue.shift()!,
  });

  const proxy = createServer((req, res) => {
    proxyToActiveWorker(req, res, supervisor, "mcp");
  });

  try {
    await supervisor.startInitial();
    const proxyPort = await listen(proxy);
    const origin = `http://127.0.0.1:${proxyPort}`;

    const firstResponse = await fetch(origin + "/mcp");
    assert.equal(await firstResponse.text(), "worker-a");
    assert.equal(
      firstResponse.headers.get("mcp-session-id"),
      "session-a",
    );

    const promoted = await supervisor.reload("test");
    assert.equal(promoted.promoted, true);

    const existingSession = await fetch(origin + "/mcp", {
      headers: {
        "mcp-session-id": "session-a",
      },
    });
    assert.equal(
      await existingSession.text(),
      "worker-a",
    );

    const newSession = await fetch(origin + "/mcp");
    assert.equal(await newSession.text(), "worker-b");
  } finally {
    await closeServer(proxy);
    await supervisor.close();
    await Promise.allSettled([
      closeServer(first.server),
      closeServer(second.server),
    ]);
  }
});

test("reverse proxy bounds captured start_job responses", async () => {
  const target = await statelessToolWorker("worker-a");

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    validate: async () => successfulCheck(),
    spawnWorker: async () => target.worker,
  });

  const proxy = createServer((req, res) => {
    proxyToActiveWorker(req, res, supervisor, "mcp");
  });

  try {
    await supervisor.startInitial();
    const proxyPort = await listen(proxy);
    const origin =
      "http://127.0.0.1:" + String(proxyPort);

    const response = await fetch(origin + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: toolCall("start_job", {
        oversized: true,
      }),
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "worker_response_too_large",
    });
    assert.deepEqual(
      supervisor.state().resourceBindings,
      [],
    );
  } finally {
    await Promise.allSettled([
      closeServer(proxy),
      supervisor.close(),
    ]);
  }
});

test("reverse proxy keeps job operations on the worker that created the job", async () => {
  const first = await statelessToolWorker("worker-a");
  const second = await statelessToolWorker("worker-b");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => queue.shift()!,
  });

  const proxy = createServer((req, res) => {
    proxyToActiveWorker(req, res, supervisor, "mcp");
  });

  try {
    await supervisor.startInitial();
    const proxyPort = await listen(proxy);
    const origin = `http://127.0.0.1:${proxyPort}`;

    const started = await callTool(
      origin,
      "start_job",
      {
        workspace: "demo",
        key: "pnpm",
        args: ["run", "check"],
      },
    );
    assert.equal(
      (started.job as { worker?: string }).worker,
      "worker-a",
    );

    await supervisor.reload("promote-worker-b");

    const waited = await callTool(
      origin,
      "wait_job",
      {
        job: "job-1",
        timeout_ms: 1,
      },
    );
    assert.equal(waited.worker, "worker-a");

    const unrelated = await callTool(
      origin,
      "get_job",
      {
        job: "unknown-job",
      },
    );
    assert.equal(unrelated.worker, "worker-b");
  } finally {
    await closeServer(proxy);
    await supervisor.close();
    await Promise.allSettled([
      closeServer(first.server),
      closeServer(second.server),
    ]);
  }
});

test("reverse proxy keeps desktop control affinity across promotion until successful control_end", async () => {
  const first = await statelessToolWorker("worker-a");
  const second = await statelessToolWorker("worker-b");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => queue.shift()!,
  });

  const proxy = createServer((req, res) => {
    proxyToActiveWorker(req, res, supervisor, "mcp");
  });

  try {
    await supervisor.startInitial();
    const proxyPort = await listen(proxy);
    const origin = `http://127.0.0.1:${proxyPort}`;

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "control_begin",
        })
      ).worker,
      "worker-a",
    );

    assert.equal(
      supervisor.state().resourceBindings.some(
        (binding) =>
          binding.key === "desktop:desktop-a" &&
          binding.workerId === "worker-a" &&
          binding.expiresAt === undefined,
      ),
      true,
    );

    await supervisor.reload("promote-worker-b");

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "screenshot",
        })
      ).worker,
      "worker-a",
    );

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "control_end",
          fail: true,
        })
      ).worker,
      "worker-a",
    );

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "screenshot",
        })
      ).worker,
      "worker-a",
    );

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "control_end",
        })
      ).worker,
      "worker-a",
    );

    assert.equal(
      supervisor.state().resourceBindings.some(
        (binding) =>
          binding.key === "desktop:desktop-a",
      ),
      false,
    );

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "screenshot",
        })
      ).worker,
      "worker-b",
    );
  } finally {
    await closeServer(proxy);
    await supervisor.close();
    await Promise.allSettled([
      closeServer(first.server),
      closeServer(second.server),
    ]);
  }
});

test("reverse proxy keeps browser session affinity until close", async () => {
  const first = await statelessToolWorker("worker-a");
  const second = await statelessToolWorker("worker-b");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => queue.shift()!,
  });

  const proxy = createServer((req, res) => {
    proxyToActiveWorker(req, res, supervisor, "mcp");
  });

  try {
    await supervisor.startInitial();
    const proxyPort = await listen(proxy);
    const origin = `http://127.0.0.1:${proxyPort}`;

    assert.equal(
      (
        await callTool(origin, "playwright_cli", {
          session: "browser-a",
          command: "open",
          args: [],
        })
      ).worker,
      "worker-a",
    );

    await supervisor.reload("promote-worker-b");

    assert.equal(
      (
        await callTool(origin, "playwright_cli", {
          session: "browser-a",
          command: "snapshot",
          args: [],
        })
      ).worker,
      "worker-a",
    );

    assert.equal(
      (
        await callTool(origin, "playwright_cli", {
          session: "browser-a",
          command: "close",
          args: [],
        })
      ).worker,
      "worker-a",
    );

    assert.equal(
      (
        await callTool(origin, "playwright_cli", {
          session: "browser-a",
          command: "snapshot",
          args: [],
        })
      ).worker,
      "worker-b",
    );
  } finally {
    await closeServer(proxy);
    await supervisor.close();
    await Promise.allSettled([
      closeServer(first.server),
      closeServer(second.server),
    ]);
  }
});

