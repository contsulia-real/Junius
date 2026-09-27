import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessCapability } from "./process-capability.js";

test("ProcessCapability uses shell:false execution with allowed arguments", async () => {
  const capability = new ProcessCapability({
    key: "node",
    description: "test node",
    executable: process.execPath,
    allowedArgVectors: [["--version"]],
    timeoutMs: 5_000,
  });

  const result = await capability.execute(["--version"], {
    cwd: process.cwd(),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.stdout.trim(), /^v\d+\./);
  }
});

test("ProcessCapability rejects arguments outside its policy", async () => {
  const capability = new ProcessCapability({
    key: "node",
    description: "test node",
    executable: process.execPath,
    allowedArgVectors: [["--version"]],
  });

  const result = await capability.execute(
    ["-e", "console.log('should not run')"],
    { cwd: process.cwd() },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "arguments_not_allowed");
  }
});


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function descendantFixture() {
  const root = await mkdtemp(
    join(tmpdir(), "junius-process-tree-"),
  );
  const childPath = join(root, "child.cjs");
  const parentPath = join(root, "parent.cjs");
  const heartbeatPath = join(root, "heartbeat.txt");

  await writeFile(
    childPath,
    `
const fs = require("node:fs");
const heartbeat = process.argv[2];
fs.writeFileSync(heartbeat, "start", "utf8");
setInterval(() => {
  fs.appendFileSync(heartbeat, ".", "utf8");
}, 25);
`,
    "utf8",
  );

  await writeFile(
    parentPath,
    `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const childPath = process.argv[2];
const heartbeat = process.argv[3];
const mode = process.argv[4];
spawn(process.execPath, [childPath, heartbeat], {
  stdio: "ignore",
});
const poll = setInterval(() => {
  if (!fs.existsSync(heartbeat)) return;
  clearInterval(poll);
  if (mode === "overflow") {
    setTimeout(() => {
      process.stdout.write("x".repeat(16 * 1024));
    }, 100);
  }
}, 10);
setInterval(() => {}, 1_000);
`,
    "utf8",
  );

  return {
    root,
    childPath,
    parentPath,
    heartbeatPath,
  };
}

async function assertHeartbeatStopped(
  heartbeatPath: string,
): Promise<void> {
  const before = await readFile(heartbeatPath, "utf8");
  await delay(250);
  const after = await readFile(heartbeatPath, "utf8");
  assert.equal(after, before);
}

test("ProcessCapability timeout terminates descendant processes on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows process-tree semantics only.");
    return;
  }

  const f = await descendantFixture();

  try {
    const args = [
      f.parentPath,
      f.childPath,
      f.heartbeatPath,
      "timeout",
    ];
    const capability = new ProcessCapability({
      key: "tree-timeout",
      description: "test timeout tree termination",
      executable: process.execPath,
      allowedArgVectors: [args],
      timeoutMs: 1_000,
    });

    const result = await capability.execute(args, {
      cwd: f.root,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "process_timeout");
    }
    await assertHeartbeatStopped(f.heartbeatPath);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ProcessCapability output limit terminates descendant processes on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows process-tree semantics only.");
    return;
  }

  const f = await descendantFixture();

  try {
    const args = [
      f.parentPath,
      f.childPath,
      f.heartbeatPath,
      "overflow",
    ];
    const capability = new ProcessCapability({
      key: "tree-output-limit",
      description: "test output tree termination",
      executable: process.execPath,
      allowedArgVectors: [args],
      timeoutMs: 5_000,
      maxOutputBytes: 128,
    });

    const result = await capability.execute(args, {
      cwd: f.root,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "output_limit");
    }
    await assertHeartbeatStopped(f.heartbeatPath);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ProcessCapability supports context-dependent fixed args", () => {
  const capability = new ProcessCapability({
    key: "context-fixed-args",
    description: "test context fixed args",
    executable: process.execPath,
    fixedArgs: ["--no-warnings"],
    fixedArgsForExecution: (_args, context) => [
      "-e",
      `process.stdout.write(${JSON.stringify(
        context.cwd,
      )})`,
    ],
    allowedArgVectors: [[]],
  });

  const prepared = capability.prepareProcess([], {
    cwd: process.cwd(),
  });

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.deepEqual(prepared.process.args, [
      "--no-warnings",
      "-e",
      `process.stdout.write(${JSON.stringify(
        process.cwd(),
      )})`,
    ]);
  }
});

test("ProcessCapability supports fixed launcher args and predicate policy", async () => {
  const capability = new ProcessCapability({
    key: "node-expression",
    description: "test fixed args",
    executable: process.execPath,
    fixedArgs: ["-p"],
    argumentPolicy: (args) =>
      args.length === 1 && args[0] === "process.platform",
    timeoutMs: 5_000,
  });

  const result = await capability.execute(["process.platform"], {
    cwd: process.cwd(),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.stdout.trim(), process.platform);
  }
});
