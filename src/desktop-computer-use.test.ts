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
  DesktopComputerUseError,
  DesktopComputerUseService,
} from "./desktop-computer-use.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "junius-desktop-"));
  const helper = join(root, "fake-helper.js");

  await writeFile(
    helper,
    `
function responseFor(request) {
  if (request.command === "inspect") {
    return {
      ok: true,
      result: {
        handle: request.handle,
        helperPid: process.pid,
        truncated: false,
        elements: [
          {
            path: [],
            name: "Window",
            controlType: "Window",
            automationId: "",
            className: "Window",
            rect: { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 },
            enabled: true,
            visible: true
          },
          {
            path: [0],
            name: "OK",
            controlType: "Button",
            automationId: "ok",
            className: "Button",
            rect: { left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30 },
            enabled: true,
            visible: true
          }
        ]
      }
    };
  }

  if (request.command === "screenshot") {
    return {
      ok: true,
      result: {
        helperPid: process.pid,
        image: {
          mimeType: "image/jpeg",
          data: "ZmFrZS1pbWFnZQ=="
        },
        region: {
          left: 0,
          top: 0,
          width: 800,
          height: 600
        }
      }
    };
  }

  return {
    ok: true,
    result: {
      helperPid: process.pid,
      received: request
    }
  };
}

function writeEnvelope(id, request) {
  process.stdout.write(
    JSON.stringify({
      id,
      ...responseFor(request)
    }) + "\\n"
  );
}

if (process.argv.includes("--server")) {
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

      const envelope = JSON.parse(line);
      writeEnvelope(envelope.id, envelope.request);
    }
  });
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    process.stdout.write(
      JSON.stringify(responseFor(JSON.parse(input)))
    );
  });
}
`,
    "utf8",
  );

  const service = new DesktopComputerUseService({
    helperPath: helper,
    pythonExecutable: process.execPath,
    platform: "win32",
  });

  return {
    root,
    service,
    async dispose() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("desktop inspect creates session-local element refs", async () => {
  const f = await fixture();
  try {
    const result = await f.service.run({
      session: "desktop",
      command: "inspect",
      handle: 42,
      depth: 3,
    });

    const body = result.result as {
      handle: number;
      elements: {
        ref: string;
        name: string;
        path?: unknown;
      }[];
    };

    assert.equal(body.handle, 42);
    assert.deepEqual(
      body.elements.map((element) => ({
        ref: element.ref,
        name: element.name,
        path: element.path,
      })),
      [
        { ref: "d1", name: "Window", path: undefined },
        { ref: "d2", name: "OK", path: undefined },
      ],
    );

    const invoked = await f.service.run({
      session: "desktop",
      command: "invoke",
      ref: "d2",
    });

    assert.deepEqual(
      (invoked.result as { received: unknown }).received,
      {
        command: "invoke",
        handle: 42,
        path: [0],
      },
    );
  } finally {
    await f.dispose();
  }
});

test("desktop refs are scoped to the named session", async () => {
  const f = await fixture();
  try {
    await f.service.run({
      session: "first",
      command: "inspect",
      handle: 42,
    });

    await assert.rejects(
      f.service.run({
        session: "second",
        command: "invoke",
        ref: "d1",
      }),
      (error: unknown) =>
        error instanceof DesktopComputerUseError &&
        error.code === "desktop_ref_not_found",
    );
  } finally {
    await f.dispose();
  }
});

test("desktop screenshot separates MCP image data from metadata", async () => {
  const f = await fixture();
  try {
    const result = await f.service.run({
      session: "desktop",
      command: "screenshot",
      handle: 42,
    });

    assert.deepEqual(result.image, {
      mimeType: "image/jpeg",
      data: "ZmFrZS1pbWFnZQ==",
    });

    const body = result.result as {
      helperPid: number;
      region: {
        left: number;
        top: number;
        width: number;
        height: number;
      };
    };

    assert.equal(typeof body.helperPid, "number");
    assert.deepEqual(body.region, {
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    });
  } finally {
    await f.dispose();
  }
});

test("desktop adapter rejects unknown refs before launching helper", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "focus",
        ref: "d99",
      }),
      (error: unknown) =>
        error instanceof DesktopComputerUseError &&
        error.code === "desktop_ref_not_found",
    );

    assert.equal(f.service.state().helperRunning, false);
  } finally {
    await f.dispose();
  }
});

test("desktop adapter validates command-specific arguments", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "mouse_click",
        x: 10,
      }),
      (error: unknown) =>
        error instanceof DesktopComputerUseError &&
        error.code === "arguments_not_allowed",
    );
  } finally {
    await f.dispose();
  }
});

test("desktop rejects execution when machine capability is disabled", async () => {
  const f = await fixture();
  try {
    f.service.setEnabled(false);

    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "windows",
      }),
      (error: unknown) =>
        error instanceof DesktopComputerUseError &&
        error.code === "desktop_disabled",
    );

    assert.equal(f.service.state().enabled, false);
    assert.equal(f.service.state().active, false);
    assert.equal(f.service.state().helperRunning, false);
  } finally {
    await f.dispose();
  }
});

test("desktop reuses one persistent helper process across actions", async () => {
  const f = await fixture();
  try {
    const first = await f.service.run({
      session: "desktop",
      command: "windows",
    });
    const second = await f.service.run({
      session: "desktop",
      command: "key_press",
      key: "esc",
    });

    const firstPid = (
      first.result as { helperPid: number }
    ).helperPid;
    const secondPid = (
      second.result as { helperPid: number }
    ).helperPid;

    assert.equal(firstPid, secondPid);
    assert.equal(f.service.state().helperRunning, true);
  } finally {
    await f.dispose();
  }
});

test("desktop resolves the project-local virtualenv Python", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-desktop-venv-"),
  );
  const helper = join(root, "python", "desktop_helper.py");
  const pythonExecutable =
    process.platform === "win32"
      ? join(root, ".venv", "Scripts", "python.exe")
      : join(root, ".venv", "bin", "python");

  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "python"), { recursive: true });
    await mkdir(join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin"), {
      recursive: true,
    });
    await writeFile(helper, "# helper\n", "utf8");
    await writeFile(pythonExecutable, "fake", "utf8");

    const service = new DesktopComputerUseService({
      environment: {
        PATH: "",
      },
      helperPath: helper,
      platform: "win32",
    });

    try {
      assert.equal(
        service.state().pythonExecutable,
        pythonExecutable,
      );
      assert.equal(service.available, true);
    } finally {
      await service.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop real Python helper can enumerate Windows repeatedly when installed", async (t) => {
  const service = new DesktopComputerUseService();

  try {
    if (!service.available) {
      t.skip("Junius desktop Python environment is not installed.");
      return;
    }

    const first = await service.run({
      session: "integration",
      command: "windows",
    });
    const second = await service.run({
      session: "integration",
      command: "windows",
    });

    const firstResult = first.result as {
      windows?: unknown;
    };
    const secondResult = second.result as {
      windows?: unknown;
    };

    assert.equal(Array.isArray(firstResult.windows), true);
    assert.equal(Array.isArray(secondResult.windows), true);
    assert.equal(service.state().active, true);
    assert.equal(service.state().helperRunning, true);
  } finally {
    await service.close();
  }
});
