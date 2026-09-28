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

async function configurationAwareWorker(
  id: string,
  shared: { allowed: boolean },
): Promise<{
  worker: ManagedWorker;
  server: Server;
  reload(): void;
  allowed(): boolean;
}> {
  const child = new EventEmitter() as unknown as ChildProcess;
  let exited = false;
  let localAllowed = shared.allowed;

  const server = createServer(async (req, res) => {
    if (req.url === "/mcp") {
      if (req.headers["mcp-session-id"] === undefined) {
        res.setHeader("mcp-session-id", "session-a");
      }
      res.setHeader("content-type", "text/plain");
      res.end(localAllowed ? "allowed" : "denied");
      return;
    }

    if (
      req.method === "POST" &&
      req.url === "/workspaces/demo/grants/pnpm"
    ) {
      for await (const _chunk of req) {
        // Consume the proxied request body.
      }
      shared.allowed = false;
      localAllowed = false;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 404;
    res.end();
  });
  const port = await listen(server);

  return {
    server,
    reload() {
      localAllowed = shared.allowed;
    },
    allowed: () => localAllowed,
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

async function machineConfigurationAwareWorker(
  id: string,
  shared: {
    browser: boolean;
    desktop: boolean;
  },
): Promise<{
  worker: ManagedWorker;
  server: Server;
  reload(): void;
  enabled(
    capability: "browser" | "desktop",
  ): boolean;
}> {
  const child =
    new EventEmitter() as unknown as ChildProcess;
  let exited = false;
  let local = { ...shared };

  const server = createServer(async (req, res) => {
    if (
      req.url === "/mcp" &&
      req.method === "POST"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk),
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
      const capability =
        name === "playwright_cli"
          ? "browser"
          : name === "desktop"
            ? "desktop"
            : undefined;

      const payload =
        capability === undefined
          ? { ok: true, worker: id }
          : {
              ok: local[capability],
              worker: id,
              capability,
              enabled: local[capability],
            };

      res.setHeader(
        "content-type",
        "application/json",
      );
      res.end(toolResult(payload));
      return;
    }

    const capabilityMatch =
      /^\/capabilities\/(browser|desktop)$/u.exec(
        req.url ?? "",
      );
    if (
      req.method === "POST" &&
      capabilityMatch !== null
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk),
        );
      }
      const body = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as { enabled?: unknown };
      const capability =
        capabilityMatch[1] as
          | "browser"
          | "desktop";

      if (typeof body.enabled !== "boolean") {
        res.statusCode = 400;
        res.end();
        return;
      }

      shared[capability] = body.enabled;
      local[capability] = body.enabled;
      res.setHeader(
        "content-type",
        "application/json",
      );
      res.end(
        JSON.stringify({
          ok: true,
          capability,
          enabled: body.enabled,
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end();
  });
  const port = await listen(server);

  return {
    server,
    reload() {
      local = { ...shared };
    },
    enabled: (capability) => local[capability],
    worker: {
      id,
      child,
      pid: id === "worker-a" ? 101 : 202,
      mcpPort: port,
      adminPort: port,
      internalToken:
        `token-${id}-012345678901234567890123456789`,
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

async function statelessToolWorker(
  id: string,
): Promise<{
  worker: ManagedWorker;
  server: Server;
  receivedWorkerTokens: string[];
}> {
  const child = new EventEmitter() as unknown as ChildProcess;
  let exited = false;
  const receivedWorkerTokens: string[] = [];

  const server = createServer(async (req, res) => {
    const workerToken =
      req.headers[WORKER_AUTH_HEADER];
    if (typeof workerToken === "string") {
      receivedWorkerTokens.push(workerToken);
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
    }

    res.setHeader("content-type", "application/json");
    res.setHeader("x-junius-worker-duration-ms", "7");
    res.end(toolResult(payload));
  });
  const port = await listen(server);

  return {
    server,
    receivedWorkerTokens,
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
): Promise<Record<string, unknown>> {
  const response = await fetch(origin + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
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

test("admin configuration mutation synchronizes a retiring MCP session before success", async () => {
  const shared = { allowed: true };
  const first = await configurationAwareWorker("worker-a", shared);
  const second = await configurationAwareWorker("worker-b", shared);
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => queue.shift()!,
    reloadWorkerConfiguration: async (worker) => {
      if (worker.id === first.worker.id) first.reload();
      if (worker.id === second.worker.id) second.reload();
    },
  });

  const mcpProxy = createServer((req, res) => {
    proxyToActiveWorker(req, res, supervisor, "mcp");
  });
  const adminProxy = createServer((req, res) => {
    proxyToActiveWorker(req, res, supervisor, "admin");
  });

  try {
    await supervisor.startInitial();
    const mcpPort = await listen(mcpProxy);
    const adminPort = await listen(adminProxy);
    const mcpOrigin = `http://127.0.0.1:${mcpPort}`;
    const adminOrigin = `http://127.0.0.1:${adminPort}`;

    const initial = await fetch(mcpOrigin + "/mcp");
    assert.equal(await initial.text(), "allowed");
    assert.equal(
      initial.headers.get("mcp-session-id"),
      "session-a",
    );

    await supervisor.reload("promote-worker-b");

    const staleBeforeMutation = await fetch(mcpOrigin + "/mcp", {
      headers: { "mcp-session-id": "session-a" },
    });
    assert.equal(await staleBeforeMutation.text(), "allowed");
    assert.equal(first.allowed(), true);

    const mutation = await fetch(
      adminOrigin + "/workspaces/demo/grants/pnpm",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: [] }),
      },
    );
    assert.equal(mutation.status, 200);
    assert.deepEqual(await mutation.json(), { ok: true });
    assert.equal(first.allowed(), false);

    const oldSessionAfterMutation = await fetch(
      mcpOrigin + "/mcp",
      {
        headers: { "mcp-session-id": "session-a" },
      },
    );
    assert.equal(
      await oldSessionAfterMutation.text(),
      "denied",
    );
  } finally {
    await Promise.allSettled([
      closeServer(mcpProxy),
      closeServer(adminProxy),
      supervisor.close(),
      closeServer(first.server),
      closeServer(second.server),
    ]);
  }
});

test("admin browser disable synchronizes a retiring browser-affinity worker before success", async () => {
  const shared = {
    browser: true,
    desktop: true,
  };
  const first =
    await machineConfigurationAwareWorker(
      "worker-a",
      shared,
    );
  const second =
    await machineConfigurationAwareWorker(
      "worker-b",
      shared,
    );
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => successfulCheck(),
    spawnWorker: async () => queue.shift()!,
    reloadWorkerConfiguration: async (worker) => {
      if (worker.id === first.worker.id) {
        first.reload();
      }
      if (worker.id === second.worker.id) {
        second.reload();
      }
    },
  });

  const mcpProxy = createServer((req, res) => {
    proxyToActiveWorker(
      req,
      res,
      supervisor,
      "mcp",
    );
  });
  const adminProxy = createServer((req, res) => {
    proxyToActiveWorker(
      req,
      res,
      supervisor,
      "admin",
    );
  });

  try {
    await supervisor.startInitial();
    const mcpPort = await listen(mcpProxy);
    const adminPort = await listen(adminProxy);
    const mcpOrigin =
      `http://127.0.0.1:${mcpPort}`;
    const adminOrigin =
      `http://127.0.0.1:${adminPort}`;

    const opened = await callTool(
      mcpOrigin,
      "playwright_cli",
      {
        session: "browser-a",
        command: "open",
        args: [],
      },
    );
    assert.equal(opened.worker, "worker-a");
    assert.equal(opened.enabled, true);

    await supervisor.reload("promote-worker-b");

    const pinnedBeforeDisable = await callTool(
      mcpOrigin,
      "playwright_cli",
      {
        session: "browser-a",
        command: "snapshot",
        args: [],
      },
    );
    assert.equal(
      pinnedBeforeDisable.worker,
      "worker-a",
    );
    assert.equal(
      pinnedBeforeDisable.enabled,
      true,
    );

    const mutation = await fetch(
      adminOrigin + "/capabilities/browser",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: false,
        }),
      },
    );
    assert.equal(mutation.status, 200);
    assert.equal(
      first.enabled("browser"),
      false,
    );

    const pinnedAfterDisable = await callTool(
      mcpOrigin,
      "playwright_cli",
      {
        session: "browser-a",
        command: "snapshot",
        args: [],
      },
    );
    assert.equal(
      pinnedAfterDisable.worker,
      "worker-a",
    );
    assert.equal(
      pinnedAfterDisable.enabled,
      false,
    );
  } finally {
    await Promise.allSettled([
      closeServer(mcpProxy),
      closeServer(adminProxy),
      supervisor.close(),
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

