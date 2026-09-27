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
