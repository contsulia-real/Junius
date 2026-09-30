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
process.stdout.write(JSON.stringify({
  id: 0,
  ok: true,
  exitCode: 0,
  stdout: "",
  stderr: ""
}) + "\\n");

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
    await client.prewarm();
    assert.equal(client.running, true);
    assert.equal(client.ready, true);

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

test("Playwright CLI broker aborts an active request without disabling future broker startup", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-browser-broker-interrupt-",
    ),
  );
  const brokerPath = join(
    root,
    "fake-broker.js",
  );
  const cliEntryPath = join(
    root,
    "fake-cli.js",
  );

  await writeFile(
    cliEntryPath,
    "",
    "utf8",
  );
  await writeFile(
    brokerPath,
    `
process.stdout.write(JSON.stringify({
  id: 0,
  ok: true,
  exitCode: 0,
  stdout: "",
  stderr: ""
}) + "\\n");
process.stdin.resume();
`,
    "utf8",
  );

  const client =
    new PlaywrightCliBrokerClient({
      cliEntryPath,
      brokerPath,
      environment:
        process.env,
      nodeExecutable:
        process.execPath,
    });

  try {
    await client.prewarm();
    const controller =
      new AbortController();
    const pending = client.run(
      [
        "-s=test",
        "snapshot",
      ],
      root,
      controller.signal,
    );
    setTimeout(
      () =>
        controller.abort(),
      50,
    );

    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code ===
          "broker_interrupted",
    );
    assert.equal(
      client.available,
      true,
    );
    assert.equal(
      client.running,
      false,
    );
  } finally {
    await client.close();
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("Playwright CLI broker recovers after a runtime crash", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-browser-broker-recover-"),
  );
  const brokerPath = join(root, "fake-broker.js");
  const cliEntryPath = join(root, "fake-cli.js");
  const markerPath = join(root, "crashed-once");

  await writeFile(cliEntryPath, "", "utf8");
  await writeFile(
    brokerPath,
    `
const fs = require("node:fs");
const marker = ${JSON.stringify(markerPath)};

process.stdout.write(JSON.stringify({
  id: 0,
  ok: true,
  exitCode: 0,
  stdout: "",
  stderr: ""
}) + "\\n");

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
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "1");
      process.exit(1);
    }

    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: true,
      exitCode: 0,
      stdout: "recovered",
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
    await client.prewarm();

    await assert.rejects(
      client.run(["-s=test", "snapshot"], root),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("exited with code 1"),
    );

    assert.equal(client.available, true);
    assert.equal(client.running, false);

    const recovered = await client.run(
      ["-s=test", "tab-list"],
      root,
    );

    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.stdout, "recovered");
    assert.equal(client.running, true);
    assert.equal(client.ready, true);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
