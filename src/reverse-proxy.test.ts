import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  createServer,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { proxyToActiveWorker } from "./reverse-proxy.js";
import type { SourceCheckResult } from "./source-check.js";
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
}> {
  const child = new EventEmitter() as unknown as ChildProcess;
  let exited = false;

  const server = createServer(async (req, res) => {
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
    res.end(toolResult(payload));
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

test("reverse proxy uses desktop inspect as the ref-affinity migration boundary", async () => {
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
          command: "inspect",
          handle: 1,
        })
      ).worker,
      "worker-a",
    );

    await supervisor.reload("promote-worker-b");

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "focus",
          ref: "d1",
        })
      ).worker,
      "worker-a",
    );

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "inspect",
          handle: 2,
        })
      ).worker,
      "worker-b",
    );

    assert.equal(
      (
        await callTool(origin, "desktop", {
          session: "desktop-a",
          command: "focus",
          ref: "d1",
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
