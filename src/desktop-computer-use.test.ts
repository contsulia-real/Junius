import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DesktopComputerUseError,
  DesktopComputerUseService,
} from "./desktop-computer-use.js";

async function fixture(
  serviceOptions: ConstructorParameters<
    typeof DesktopComputerUseService
  >[0] = {},
) {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-desktop-",
    ),
  );
  const helper = join(
    root,
    "fake-helper.js",
  );

  await writeFile(
    helper,
    `
function responseFor(request) {
  if (request.command === "windows") {
    return {
      ok: true,
      result: {
        helperPid: process.pid,
        pythonEnvironment: {
          PYTHONPATH: process.env.PYTHONPATH ?? null,
          PYTHONHOME: process.env.PYTHONHOME ?? null,
          PYTHONSTARTUP: process.env.PYTHONSTARTUP ?? null,
          PYTHONINSPECT: process.env.PYTHONINSPECT ?? null
        },
        windows: []
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
  process.stdout.write(
    JSON.stringify({
      id: 0,
      ok: true,
      result: { ready: true }
    }) + "\\n"
  );

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
      writeEnvelope(
        envelope.id,
        envelope.request
      );
    }
  });
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    process.stdout.write(
      JSON.stringify(
        responseFor(
          JSON.parse(input)
        )
      )
    );
  });
}
`,
    "utf8",
  );

  const service =
    new DesktopComputerUseService({
      ...serviceOptions,
      helperPath: helper,
      pythonExecutable:
        process.execPath,
      platform: "win32",
    });

  return {
    root,
    service,
    async dispose() {
      await service.close();
      await rm(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    },
  };
}

test("desktop helper strips inherited Python preload environment", async () => {
  const f = await fixture({
    environment: {
      PYTHONPATH:
        "C:\\evil\\modules",
      pythonhome:
        "C:\\evil\\python",
      PYTHONSTARTUP:
        "C:\\evil\\startup.py",
      pythoninspect: "1",
    },
  });

  try {
    const result =
      await f.service.run({
        session: "desktop",
        command: "windows",
      });

    const body =
      result.result as {
        pythonEnvironment: {
          PYTHONPATH:
            string | null;
          PYTHONHOME:
            string | null;
          PYTHONSTARTUP:
            string | null;
          PYTHONINSPECT:
            string | null;
        };
      };

    assert.deepEqual(
      body.pythonEnvironment,
      {
        PYTHONPATH: null,
        PYTHONHOME: null,
        PYTHONSTARTUP: null,
        PYTHONINSPECT: null,
      },
    );
  } finally {
    await f.dispose();
  }
});

test("desktop screenshot separates MCP image data from metadata", async () => {
  const f = await fixture();
  try {
    const result =
      await f.service.run({
        session: "desktop",
        command: "screenshot",
        handle: 42,
      });

    assert.deepEqual(
      result.image,
      {
        mimeType: "image/jpeg",
        data: "ZmFrZS1pbWFnZQ==",
      },
    );

    assert.deepEqual(
      result.result,
      {
        helperPid:
          (
            result.result as {
              helperPid: number;
            }
          ).helperPid,
        region: {
          left: 0,
          top: 0,
          width: 800,
          height: 600,
        },
      },
    );
  } finally {
    await f.dispose();
  }
});

test("desktop exposes only screenshot and coordinate keyboard/mouse commands", async () => {
  const f = await fixture();

  try {
    await assert.rejects(
      f.service.run({
        session: "desktop",
        command:
          "inspect" as never,
        handle: 42,
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "command_not_allowed",
    );

    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "mouse_click",
        x: 10,
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "arguments_not_allowed",
    );

    const action =
      await f.service.run({
        session: "desktop",
        command: "mouse_click",
        handle: 42,
        x: 10,
        y: 20,
      });

    assert.deepEqual(
      (
        action.result as {
          received: unknown;
        }
      ).received,
      {
        command: "mouse_click",
        handle: 42,
        x: 10,
        y: 20,
      },
    );
  } finally {
    await f.dispose();
  }
});

test("desktop key macros and clipboard text are bounded primitives", async () => {
  const f = await fixture();

  try {
    const macro =
      await f.service.run({
        session: "desktop",
        command: "key_macro",
        steps: [
          {
            action: "key_down",
            key: "ctrl",
          },
          {
            action: "key_press",
            key: "v",
          },
          {
            action: "key_up",
            key: "ctrl",
          },
        ],
      });

    assert.deepEqual(
      (
        macro.result as {
          received: unknown;
        }
      ).received,
      {
        command: "key_macro",
        steps: [
          {
            action: "key_down",
            key: "ctrl",
          },
          {
            action: "key_press",
            key: "v",
          },
          {
            action: "key_up",
            key: "ctrl",
          },
        ],
      },
    );

    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "key_macro",
        steps: [],
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "arguments_not_allowed",
    );

    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "key_macro",
        steps: Array.from(
          { length: 129 },
          () => ({
            action:
              "key_press" as const,
            key: "a",
          }),
        ),
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "arguments_not_allowed",
    );

    const write =
      await f.service.run({
        session: "desktop",
        command: "clipboard_write",
        text: "你好，Junius 👋",
      });
    assert.deepEqual(
      (
        write.result as {
          received: unknown;
        }
      ).received,
      {
        command: "clipboard_write",
        text: "你好，Junius 👋",
      },
    );

    const read =
      await f.service.run({
        session: "desktop",
        command: "clipboard_read",
      });
    assert.deepEqual(
      (
        read.result as {
          received: unknown;
        }
      ).received,
      {
        command: "clipboard_read",
      },
    );

    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "clipboard_write",
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "arguments_not_allowed",
    );
  } finally {
    await f.dispose();
  }
});

test("desktop disable stops helper and supports re-enable", async () => {
  const f = await fixture();

  try {
    await f.service.run({
      session: "desktop",
      command: "windows",
    });
    assert.equal(
      f.service.state()
        .helperRunning,
      true,
    );

    await f.service.setEnabled(
      false,
    );
    assert.equal(
      f.service.state().enabled,
      false,
    );
    assert.equal(
      f.service.state()
        .helperRunning,
      false,
    );

    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "windows",
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "desktop_disabled",
    );

    await f.service.setEnabled(
      true,
    );
    const resumed =
      await f.service.run({
        session: "desktop",
        command: "windows",
      });
    assert.equal(
      resumed.command,
      "windows",
    );
  } finally {
    await f.dispose();
  }
});

test("desktop prewarms and reuses one persistent helper process across screenshot-era actions", async () => {
  const f = await fixture();
  try {
    await f.service.prewarm();
    assert.equal(
      f.service.state()
        .helperReady,
      true,
    );

    const first =
      await f.service.run({
        session: "desktop",
        command: "windows",
      });
    const second =
      await f.service.run({
        session: "desktop",
        command: "key_press",
        key: "esc",
      });

    const firstPid =
      (
        first.result as {
          helperPid: number;
        }
      ).helperPid;
    const secondPid =
      (
        second.result as {
          helperPid: number;
        }
      ).helperPid;

    assert.equal(
      firstPid,
      secondPid,
    );
  } finally {
    await f.dispose();
  }
});

test("desktop resolves project-root virtualenv Python for live and release helpers", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-desktop-venv-",
    ),
  );
  const liveHelper = join(
    root,
    "python",
    "desktop_helper.py",
  );
  const releaseHelper = join(
    root,
    ".junius",
    "runtime",
    "releases",
    "release-a",
    "python",
    "desktop_helper.py",
  );
  const pythonExecutable =
    process.platform ===
    "win32"
      ? join(
          root,
          ".venv",
          "Scripts",
          "python.exe",
        )
      : join(
          root,
          ".venv",
          "bin",
          "python",
        );

  try {
    const { mkdir } =
      await import(
        "node:fs/promises"
      );
    await mkdir(
      dirname(liveHelper),
      {
        recursive: true,
      },
    );
    await mkdir(
      dirname(releaseHelper),
      {
        recursive: true,
      },
    );
    await mkdir(
      dirname(
        pythonExecutable,
      ),
      {
        recursive: true,
      },
    );
    await writeFile(
      liveHelper,
      "# helper\n",
      "utf8",
    );
    await writeFile(
      releaseHelper,
      "# helper\n",
      "utf8",
    );
    await writeFile(
      pythonExecutable,
      "fake",
      "utf8",
    );

    for (const helperPath of [
      liveHelper,
      releaseHelper,
    ]) {
      const service =
        new DesktopComputerUseService({
          environment: {
            PATH: "",
            JUNIUS_PROJECT_ROOT:
              root,
          },
          helperPath,
          platform: "win32",
        });

      try {
        assert.equal(
          service.state()
            .pythonExecutable,
          pythonExecutable,
        );
        assert.equal(
          service.available,
          true,
        );
      } finally {
        await service.close();
      }
    }
  } finally {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("desktop real Python helper supports screenshot-only perception when installed", async (t) => {
  const service =
    new DesktopComputerUseService();

  try {
    if (!service.available) {
      t.skip(
        "Junius desktop Python environment is not installed.",
      );
      return;
    }

    const windows =
      await service.run({
        session:
          "integration",
        command: "windows",
      });
    const screenshot =
      await service.run({
        session:
          "integration",
        command:
          "screenshot",
      });

    const listedWindows =
      (
        windows.result as {
          windows?: Array<{
            title?: string;
            className?: string;
            visible?: boolean;
            rect?: {
              left: number;
              top: number;
              right: number;
              bottom: number;
              width: number;
              height: number;
            };
          }>;
        }
      ).windows;
    const screenshotRegion =
      (
        screenshot.result as {
          region?: {
            left: number;
            top: number;
            width: number;
            height: number;
          };
        }
      ).region;

    assert.equal(
      Array.isArray(listedWindows),
      true,
    );

    const indicatorWindows =
      new Map(
        listedWindows
          ?.filter(
            (window) =>
              window.visible === true &&
              window.title !== undefined,
          )
          .map(
            (window) => [
              window.title as string,
              window,
            ],
          ) ?? [],
      );

    assert.equal(
      indicatorWindows.has(
        "ChatGPT 正通过 Junius 操作电脑",
      ),
      true,
      "Expected visible top-center desktop activity banner.",
    );

    assert.notEqual(
      screenshotRegion,
      undefined,
    );

    const banner =
      indicatorWindows.get(
        "ChatGPT 正通过 Junius 操作电脑",
      );

    const glowWindows =
      listedWindows?.filter(
        (window) =>
          window.visible === true &&
          window.className ===
            "JuniusDesktopActivityIndicatorWindow",
      ) ?? [];

    assert.equal(
      glowWindows.length,
      4,
      "Expected four visible desktop activity edge-glow windows.",
    );

    assert.notEqual(banner?.rect, undefined);

    const screenLeft =
      screenshotRegion?.left ?? 0;
    const screenTop =
      screenshotRegion?.top ?? 0;
    const screenRight =
      screenLeft +
      (screenshotRegion?.width ?? 0);
    const screenBottom =
      screenTop +
      (screenshotRegion?.height ?? 0);

    const topGlow =
      glowWindows.find(
        (window) =>
          window.rect?.left === screenLeft &&
          window.rect?.top === screenTop &&
          window.rect?.right === screenRight,
      );
    const bottomGlow =
      glowWindows.find(
        (window) =>
          window.rect?.left === screenLeft &&
          window.rect?.right === screenRight &&
          window.rect?.bottom === screenBottom,
      );
    const leftGlow =
      glowWindows.find(
        (window) =>
          window.rect?.left === screenLeft &&
          window.rect?.top === screenTop &&
          window.rect?.bottom === screenBottom,
      );
    const rightGlow =
      glowWindows.find(
        (window) =>
          window.rect?.right === screenRight &&
          window.rect?.top === screenTop &&
          window.rect?.bottom === screenBottom,
      );

    assert.notEqual(topGlow?.rect, undefined);
    assert.notEqual(bottomGlow?.rect, undefined);
    assert.notEqual(leftGlow?.rect, undefined);
    assert.notEqual(rightGlow?.rect, undefined);

    const screenCenterX =
      screenLeft +
      (screenshotRegion?.width ?? 0) / 2;
    const bannerCenterX =
      ((banner?.rect?.left ?? 0) +
        (banner?.rect?.right ?? 0)) /
      2;

    assert.equal(
      Math.abs(
        screenCenterX - bannerCenterX,
      ) <= 1,
      true,
    );
    assert.equal(
      banner?.rect?.top,
      (screenshotRegion?.top ?? 0) + 16,
    );

    assert.equal(
      topGlow?.rect?.left,
      screenLeft,
    );
    assert.equal(
      topGlow?.rect?.top,
      screenTop,
    );
    assert.equal(
      topGlow?.rect?.right,
      screenRight,
    );
    assert.equal(
      bottomGlow?.rect?.bottom,
      screenBottom,
    );
    assert.equal(
      leftGlow?.rect?.left,
      screenLeft,
    );
    assert.equal(
      leftGlow?.rect?.height,
      screenshotRegion?.height,
    );
    assert.equal(
      rightGlow?.rect?.right,
      screenRight,
    );
    assert.equal(
      rightGlow?.rect?.height,
      screenshotRegion?.height,
    );

    assert.equal(
      screenshot.image
        ?.mimeType,
      "image/jpeg",
    );
    assert.equal(
      typeof screenshot.image
        ?.data,
      "string",
    );
    assert.equal(
      service.state().active,
      true,
    );
    assert.equal(
      service.state()
        .helperRunning,
      true,
    );
  } finally {
    await service.close();
  }
});
