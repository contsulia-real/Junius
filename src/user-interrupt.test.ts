import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDesktopPythonExecutable } from "./desktop-computer-use-launcher.js";
import {
  DEFAULT_USER_INTERRUPT_HELPER_PATH,
  EscapeInterruptService,
} from "./user-interrupt.js";

test(
  "escape interrupt helper ignores injected Escape events",
  () => {
    const setupPython =
      process.env.pythonLocation ===
      undefined
        ? undefined
        : join(
            process.env.pythonLocation,
            "python.exe",
          );
    const python =
      setupPython !== undefined &&
      existsSync(setupPython)
        ? setupPython
        : resolveDesktopPythonExecutable(
            DEFAULT_USER_INTERRUPT_HELPER_PATH,
            process.env,
          );
    assert.notEqual(
      python,
      undefined,
    );

    const result = spawnSync(
      python!,
      [
        DEFAULT_USER_INTERRUPT_HELPER_PATH,
        "--self-test",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout,
    );
  },
);

test(
  "escape interrupt service aborts every active computer-use lease",
  async () => {
    const root = await mkdtemp(
      join(
        tmpdir(),
        "junius-user-interrupt-",
      ),
    );
    const helperPath = join(
      root,
      "fake-interrupt-helper.js",
    );

    await writeFile(
      helperPath,
      [
        "process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n');",
        "setTimeout(() => {",
        "  process.stdout.write(JSON.stringify({ event: 'escape' }) + '\\n');",
        "}, 50);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const service =
      new EscapeInterruptService({
        platform: "win32",
        pythonExecutable:
          process.execPath,
        helperPath,
      });

    try {
      const first = await service.arm();
      const second = await service.arm();

      await Promise.race([
        Promise.all([
          new Promise<void>(
            (resolvePromise) =>
              first.signal.addEventListener(
                "abort",
                () =>
                  resolvePromise(),
                { once: true },
              ),
          ),
          new Promise<void>(
            (resolvePromise) =>
              second.signal.addEventListener(
                "abort",
                () =>
                  resolvePromise(),
                { once: true },
              ),
          ),
        ]),
        new Promise<never>(
          (_resolve, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    "escape_interrupt_timeout",
                  ),
                ),
              2_000,
            ),
        ),
      ]);

      assert.equal(
        first.signal.aborted,
        true,
      );
      assert.equal(
        second.signal.aborted,
        true,
      );

      first.release();
      second.release();
    } finally {
      await service.close();
      await rm(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
