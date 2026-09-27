import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PlaywrightCliBrokerClient,
} from "./playwright-cli-broker-client.js";

test("Playwright CLI broker client reuses one persistent process", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-browser-broker-"),
  );
  const brokerPath = join(root, "fake-broker.js");
  const cliEntryPath = join(root, "fake-cli.js");

  await writeFile(cliEntryPath, "", "utf8");
  await writeFile(
    brokerPath,
    `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;

    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;

    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({
        pid: process.pid,
        args: request.args,
        cwd: request.cwd
      }),
      stderr: ""
    }) + "\\n");
  }
});
`,
    "utf8",
  );

  const client = new PlaywrightCliBrokerClient({
    cliEntryPath,
    brokerPath,
    environment: process.env,
    nodeExecutable: process.execPath,
  });

  try {
    const first = await client.run(
      ["-s=test", "snapshot"],
      root,
    );
    const second = await client.run(
      ["-s=test", "tab-list"],
      root,
    );

    const firstPayload = JSON.parse(first.stdout) as {
      pid: number;
      args: string[];
    };
    const secondPayload = JSON.parse(second.stdout) as {
      pid: number;
      args: string[];
    };

    assert.equal(firstPayload.pid, secondPayload.pid);
    assert.deepEqual(firstPayload.args, [
      "-s=test",
      "snapshot",
    ]);
    assert.deepEqual(secondPayload.args, [
      "-s=test",
      "tab-list",
    ]);
    assert.equal(client.running, true);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(client.running, false);
});
