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
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);

  if (request.command === "inspect") {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: {
        handle: request.handle,
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
    }));
    return;
  }

  if (request.command === "screenshot") {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: {
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
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    result: { received: request }
  }));
});
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

    assert.deepEqual(invoked.result, {
      received: {
        command: "invoke",
        handle: 42,
        path: [0],
      },
    });
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
    assert.deepEqual(result.result, {
      region: {
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      },
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
