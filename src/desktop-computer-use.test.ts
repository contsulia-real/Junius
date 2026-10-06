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
  if (
    process.env.JUNIUS_TEST_DESKTOP_INTERRUPT_COMMAND ===
    request.command
  ) {
    return {
      ok: false,
      code: "user_interrupted",
      message: "Desktop operation interrupted by user pressing Escape."
    };
  }

  if (
    process.env.JUNIUS_TEST_DESKTOP_FAIL_COMMAND ===
    request.command
  ) {
    return {
      ok: false,
      code: "test_failure",
      message: "forced desktop helper failure"
    };
  }

  if (request.command === "windows") {
    return {
      ok: true,
      result: {
        helperPid: process.pid,
        pythonEnvironment: {
          PYTHONPATH: process.env.PYTHONPATH ?? null,
          PYTHONHOME: process.env.PYTHONHOME ?? null,
          PYTHONSTARTUP: process.env.PYTHONSTARTUP ?? null,
          PYTHONINSPECT: process.env.PYTHONINSPECT ?? null,
          PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? null,
          PYTHONUTF8: process.env.PYTHONUTF8 ?? null
        },
        windows: []
      }
    };
  }

  if (
    request.command === "screenshot" ||
    (
      request.command === "action_batch" &&
      request.screenshot_after === true
    )
  ) {
    return {
      ok: true,
      result: {
        helperPid: process.pid,
        ...(request.command === "action_batch"
          ? {
              received: request,
              actions: request.actions ?? [],
              actionCount: request.actions?.length ?? 0
            }
          : {}),
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

async function beginAuthorizedControl(
  service: DesktopComputerUseService,
  session = "desktop",
): Promise<void> {
  await service.run({
    session,
    command:
      "control_begin",
    explicitUserAuthorization:
      true,
  });
}

test("desktop surfaces Escape interruption as user_interrupted", async () => {
  const f = await fixture({
    environment: {
      JUNIUS_TEST_DESKTOP_INTERRUPT_COMMAND:
        "wait",
    },
  });

  try {
    await beginAuthorizedControl(
      f.service,
    );
    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "wait",
        durationMs: 5_000,
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "user_interrupted",
    );
  } finally {
    await f.dispose();
  }
});

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
      PYTHONIOENCODING:
        "cp1252",
      PYTHONUTF8: "0",
    },
  });

  try {
    await beginAuthorizedControl(
      f.service,
    );

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
          PYTHONIOENCODING:
            string | null;
          PYTHONUTF8:
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
        PYTHONIOENCODING:
          "utf-8",
        PYTHONUTF8: "1",
      },
    );
  } finally {
    await f.dispose();
  }
});

test("desktop screenshot separates MCP image data from metadata", async () => {
  const f = await fixture();
  try {
    await beginAuthorizedControl(
      f.service,
    );

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

test("desktop exposes bounded screenshot and input primitives", async () => {
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

    await beginAuthorizedControl(
      f.service,
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
        session: "desktop",
        handle: 42,
        x: 10,
        y: 20,
      },
    );
  } finally {
    await f.dispose();
  }
});

test("desktop drag, wait, and mixed action batches are bounded primitives", async () => {
  const f = await fixture();

  try {
    await beginAuthorizedControl(
      f.service,
    );

    const drag =
      await f.service.run({
        session: "desktop",
        command: "drag",
        handle: 42,
        x: 10,
        y: 20,
        toX: 30,
        toY: 40,
        durationMs: 250,
      });

    assert.deepEqual(
      (
        drag.result as {
          received: unknown;
        }
      ).received,
      {
        command: "drag",
        session: "desktop",
        handle: 42,
        x: 10,
        y: 20,
        to_x: 30,
        to_y: 40,
        duration_ms: 250,
      },
    );

    const waited =
      await f.service.run({
        session: "desktop",
        command: "wait",
        durationMs: 25,
      });

    assert.deepEqual(
      (
        waited.result as {
          received: unknown;
        }
      ).received,
      {
        command: "wait",
        session: "desktop",
        duration_ms: 25,
      },
    );

    const batch =
      await f.service.run({
        session: "desktop",
        command: "action_batch",
        actions: [
          {
            action: "mouse_click",
            handle: 42,
            x: 5,
            y: 6,
          },
          {
            action: "wait",
            durationMs: 10,
          },
          {
            action: "key_press",
            key: "enter",
          },
          {
            action: "drag",
            handle: 42,
            x: 1,
            y: 2,
            toX: 3,
            toY: 4,
            durationMs: 100,
          },
        ],
        screenshotAfter: true,
        screenshotHandle: 42,
      });

    assert.equal(
      batch.image?.mimeType,
      "image/jpeg",
    );
    const batchResult =
      batch.result as {
        received: {
          actions: unknown[];
          screenshot_after: boolean;
          screenshot_handle: number;
        };
        actionCount: number;
        region: unknown;
      };
    assert.equal(
      batchResult.actionCount,
      4,
    );
    assert.equal(
      batchResult.received
        .screenshot_after,
      true,
    );
    assert.equal(
      batchResult.received
        .screenshot_handle,
      42,
    );
    assert.deepEqual(
      batchResult.received
        .actions[1],
      {
        action: "wait",
        duration_ms: 10,
      },
    );
    assert.deepEqual(
      batchResult.received
        .actions[3],
      {
        action: "drag",
        handle: 42,
        x: 1,
        y: 2,
        to_x: 3,
        to_y: 4,
        duration_ms: 100,
      },
    );

    await assert.rejects(
      f.service.run({
        session: "desktop",
        command: "wait",
        durationMs: 30_001,
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
        command: "action_batch",
        actions: [
          {
            action: "wait",
            durationMs: 20_000,
          },
          {
            action: "wait",
            durationMs: 20_000,
          },
        ],
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

test("desktop key macros and clipboard text are bounded primitives", async () => {
  const f = await fixture();

  try {
    await beginAuthorizedControl(
      f.service,
    );

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
        session: "desktop",
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
        session: "desktop",
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
        session: "desktop",
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

test("desktop requires an explicitly authorized control lifecycle before observation or input", async () => {
  const f = await fixture();

  try {
    assert.equal(
      f.service.state()
        .helperRunning,
      false,
    );

    for (const command of [
      "windows",
      "screenshot",
      "clipboard_read",
    ] as const) {
      await assert.rejects(
        f.service.run({
          session:
            "privacy",
          command,
        }),
        (error: unknown) =>
          error instanceof
            DesktopComputerUseError &&
          error.code ===
            "authorization_required",
      );
      assert.equal(
        f.service.state()
          .helperRunning,
        false,
      );
    }

    await assert.rejects(
      f.service.run({
        session:
          "privacy",
        command:
          "control_begin",
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "authorization_required",
    );
    assert.equal(
      f.service.state()
        .helperRunning,
      false,
    );

    const inactiveEnd =
      await f.service.run({
        session:
          "cleanup-only",
        command:
          "control_end",
      });
    assert.deepEqual(
      inactiveEnd.result,
      {
        active: false,
        session:
          "cleanup-only",
      },
    );
    assert.equal(
      f.service.state()
        .helperRunning,
      false,
    );

    const begun =
      await f.service.run({
        session:
          "privacy",
        command:
          "control_begin",
        explicitUserAuthorization:
          true,
      });
    assert.deepEqual(
      (
        begun.result as {
          received: unknown;
        }
      ).received,
      {
        command:
          "control_begin",
        session:
          "privacy",
      },
      "Authorization assertion must not be forwarded into the Python helper protocol.",
    );

    await assert.rejects(
      f.service.run({
        session:
          "privacy",
        command:
          "screenshot",
        explicitUserAuthorization:
          true,
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "authorization_not_allowed",
    );

    await f.service.run({
      session:
        "privacy",
      command:
        "windows",
    });

    await assert.rejects(
      f.service.run({
        session:
          "other-session",
        command:
          "screenshot",
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "authorization_required",
    );

    await f.service.run({
      session:
        "privacy",
      command:
        "control_end",
    });

    await assert.rejects(
      f.service.run({
        session:
          "privacy",
        command:
          "screenshot",
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "authorization_required",
    );
  } finally {
    await f.dispose();
  }
});

test("desktop revokes authorization even when control_end cleanup fails", async () => {
  const f = await fixture({
    environment: {
      JUNIUS_TEST_DESKTOP_FAIL_COMMAND:
        "control_end",
    },
  });

  try {
    await beginAuthorizedControl(
      f.service,
      "privacy-failed-end",
    );

    await assert.rejects(
      f.service.run({
        session:
          "privacy-failed-end",
        command:
          "control_end",
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "helper_failed",
    );

    await assert.rejects(
      f.service.run({
        session:
          "privacy-failed-end",
        command:
          "screenshot",
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code ===
          "authorization_required",
    );
  } finally {
    await f.dispose();
  }
});

test("desktop lazily starts and reuses one persistent helper process across actions", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.service.state()
        .helperRunning,
      false,
    );

    await beginAuthorizedControl(
      f.service,
    );

    assert.equal(
      f.service.state()
        .helperRunning,
      true,
    );

    const first =
      await f.service.run({
        session: "desktop",
        command: "windows",
      });

    assert.equal(
      f.service.state()
        .helperReady,
      true,
    );
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

test("desktop real Python helper supports screenshot-only perception when explicitly authorized", async (t) => {
  if (
    process.env
      .JUNIUS_DESKTOP_LIVE_TEST_AUTHORIZED !==
    "1"
  ) {
    t.skip(
      "Live Desktop access requires explicit opt-in via JUNIUS_DESKTOP_LIVE_TEST_AUTHORIZED=1.",
    );
    return;
  }

  const service =
    new DesktopComputerUseService();

  try {
    if (!service.available) {
      t.skip(
        "Junius desktop Python environment is not installed.",
      );
      return;
    }

    const control =
      await service.run({
        session:
          "integration",
        command: "control_begin",
        explicitUserAuthorization:
          true,
      });
    assert.deepEqual(
      control.result,
      {
        active: true,
        session: "integration",
      },
    );

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
    const batch =
      await service.run({
        session:
          "integration",
        command:
          "action_batch",
        actions: [
          {
            action: "wait",
            durationMs: 5,
          },
        ],
        screenshotAfter: true,
      });
    assert.equal(
      batch.image?.mimeType,
      "image/jpeg",
    );
    assert.equal(
      (
        batch.result as {
          actionCount?: number;
        }
      ).actionCount,
      1,
    );

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

    const bannerTitles = [
      "ChatGPT 正通过 Junius 操作电脑",
      "ChatGPT is controlling your computer through Junius",
    ];
    const bannerTitle =
      bannerTitles.find((title) =>
        indicatorWindows.has(title),
      );

    assert.notEqual(
      bannerTitle,
      undefined,
      "Expected visible localized top-center desktop activity banner.",
    );

    assert.notEqual(
      screenshotRegion,
      undefined,
    );

    const banner =
      bannerTitle === undefined
        ? undefined
        : indicatorWindows.get(
            bannerTitle,
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
          window.rect?.top ===
            screenTop + 12 &&
          window.rect?.bottom ===
            screenBottom - 12,
      );
    const rightGlow =
      glowWindows.find(
        (window) =>
          window.rect?.right === screenRight &&
          window.rect?.top ===
            screenTop + 12 &&
          window.rect?.bottom ===
            screenBottom - 12,
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
      (screenshotRegion?.height ?? 0) - 24,
    );
    assert.equal(
      rightGlow?.rect?.right,
      screenRight,
    );
    assert.equal(
      rightGlow?.rect?.height,
      (screenshotRegion?.height ?? 0) - 24,
    );

    const ended =
      await service.run({
        session:
          "integration",
        command: "control_end",
      });
    assert.deepEqual(
      ended.result,
      {
        active: false,
        session: "integration",
      },
    );

    await assert.rejects(
      service.run({
        session:
          "integration",
        command: "windows",
      }),
      (error: unknown) =>
        error instanceof
          DesktopComputerUseError &&
        error.code === "helper_failed" &&
        error.message.includes(
          "control_begin",
        ),
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
      service.state().available,
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
