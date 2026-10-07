import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  TunnelHealthMonitor,
} from "./tunnel-health.js";

async function listen(
  server: Server,
): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (
    server.address() as AddressInfo
  ).port;
}

async function closeServer(
  server: Server,
): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("TunnelHealthMonitor reads detailed tunnel health", async () => {
  const server = createServer((req, res) => {
    assert.equal(
      req.url,
      "/health?details=true",
    );
    res.setHeader(
      "content-type",
      "application/json",
    );
    res.end(
      JSON.stringify({
        live: true,
        ready: true,
        snapshot_at:
          "2026-10-07T10:11:37.955Z",
        runtime: {
          lifecycle: "running",
        },
        components: {
          dispatcher: {
            details: {
              failures: 2,
              timeouts: 1,
            },
          },
          "response-delivery": {
            details: {
              retries: 3,
              terminal_failures: 0,
            },
          },
        },
      }),
    );
  });

  try {
    const port = await listen(server);
    const url =
      `http://127.0.0.1:${port}/health?details=true`;
    const monitor =
      new TunnelHealthMonitor(
        [url],
        60_000,
      );
    const health =
      await monitor.refresh();

    assert.equal(health.reachable, true);
    assert.equal(health.live, true);
    assert.equal(health.ready, true);
    assert.equal(
      health.lifecycle,
      "running",
    );
    assert.equal(
      health.dispatcherFailures,
      2,
    );
    assert.equal(
      health.responseDeliveryRetries,
      3,
    );
    assert.equal(health.url, url);
  } finally {
    await closeServer(server);
  }
});

test("TunnelHealthMonitor falls back to the next configured health URL", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/unhealthy") {
      res.statusCode = 503;
      res.end();
      return;
    }

    if (
      req.url ===
      "/health?details=true"
    ) {
      res.setHeader(
        "content-type",
        "application/json",
      );
      res.end(
        JSON.stringify({
          live: true,
          ready: true,
          runtime: {
            lifecycle: "running",
          },
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  try {
    const port = await listen(server);
    const healthyUrl =
      `http://127.0.0.1:${port}/health?details=true`;
    const monitor =
      new TunnelHealthMonitor(
        [
          `http://127.0.0.1:${port}/unhealthy`,
          healthyUrl,
        ],
        60_000,
      );
    const health =
      await monitor.refresh();

    assert.equal(health.reachable, true);
    assert.equal(health.live, true);
    assert.equal(health.ready, true);
    assert.equal(
      health.url,
      healthyUrl,
    );
  } finally {
    await closeServer(server);
  }
});
