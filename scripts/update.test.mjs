import assert from "node:assert/strict";
import test from "node:test";
import {
  checkJuniusUpdate,
  updateJunius,
} from "./update.mjs";

function successfulRunner(
  stdout,
  calls,
) {
  return async (
    executable,
    args,
  ) => {
    calls.push({
      executable,
      args,
    });
    return {
      ok: true,
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
    };
  };
}

test(
  "update check reports the latest release without installing",
  async () => {
    const calls = [];
    const result =
      await checkJuniusUpdate({
        currentVersion:
          "0.0.3-alpha-ChatGPT",
        packageRoot:
          "C:\\Junius",
        platform: "win32",
        isFile:
          async () => true,
        runProcess:
          successfulRunner(
            JSON.stringify({
              currentVersion:
                "0.0.3-alpha-ChatGPT",
              latestVersion:
                "0.0.4-alpha-ChatGPT",
              releaseTag:
                "v0.0.4-alpha-ChatGPT",
              updateAvailable:
                true,
            }) + "\r\n",
            calls,
          ),
      });

    assert.deepEqual(
      result,
      {
        currentVersion:
          "0.0.3-alpha-ChatGPT",
        latestVersion:
          "0.0.4-alpha-ChatGPT",
        releaseTag:
          "v0.0.4-alpha-ChatGPT",
        updateAvailable: true,
      },
    );
    assert.equal(
      calls.length,
      1,
    );
    assert.equal(
      calls[0].args.includes(
        "-CheckOnly",
      ),
      true,
    );
    assert.equal(
      calls[0].args.includes(
        "-Json",
      ),
      true,
    );
  },
);

test(
  "update skips installation when the current version is latest",
  async () => {
    const calls = [];
    const result =
      await updateJunius({
        currentVersion:
          "0.0.3-alpha-ChatGPT",
        packageRoot:
          "C:\\Junius",
        platform: "win32",
        environment: {},
        isFile:
          async () => true,
        runProcess:
          successfulRunner(
            JSON.stringify({
              currentVersion:
                "0.0.3-alpha-ChatGPT",
              latestVersion:
                "0.0.3-alpha-ChatGPT",
              releaseTag:
                "v0.0.3-alpha-ChatGPT",
              updateAvailable:
                false,
            }) + "\r\n",
            calls,
          ),
      });

    assert.equal(
      result.updated,
      false,
    );
    assert.equal(
      result.restartRequired,
      false,
    );
    assert.equal(
      calls.length,
      1,
    );
  },
);

test(
  "update installs the exact checked release and reports MCP restart requirement",
  async () => {
    const calls = [];
    const outputs = [
      JSON.stringify({
        currentVersion:
          "0.0.3-alpha-ChatGPT",
        latestVersion:
          "0.0.4-alpha-ChatGPT",
        releaseTag:
          "v0.0.4-alpha-ChatGPT",
        updateAvailable: true,
      }) + "\r\n",
      "installed\r\n",
    ];
    const runner =
      async (
        executable,
        args,
      ) => {
        calls.push({
          executable,
          args,
        });
        return {
          ok: true,
          exitCode: 0,
          signal: null,
          stdout:
            outputs.shift(),
          stderr: "",
        };
      };

    const result =
      await updateJunius({
        currentVersion:
          "0.0.3-alpha-ChatGPT",
        packageRoot:
          "C:\\Junius",
        platform: "win32",
        environment: {
          JUNIUS_PROJECT_ROOT:
            "C:\\Installed",
          LOCALAPPDATA:
            "C:\\Users\\Demo\\AppData\\Local",
        },
        isFile:
          async (path) =>
            path ===
            "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\install.ps1",
        runProcess: runner,
      });

    assert.equal(
      result.updated,
      true,
    );
    assert.equal(
      result.restartRequired,
      true,
    );
    assert.equal(
      calls.length,
      2,
    );

    const checkArgs =
      calls[0].args;
    const checkFileIndex =
      checkArgs.indexOf(
        "-File",
      );
    assert.equal(
      checkArgs[
        checkFileIndex + 1
      ],
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\install.ps1",
    );

    const installArgs =
      calls[1].args;
    const versionIndex =
      installArgs.indexOf(
        "-Version",
      );
    assert.equal(
      installArgs[
        versionIndex + 1
      ],
      "0.0.4-alpha-ChatGPT",
    );
  },
);

test(
  "development Junius cannot run the production updater",
  async () => {
    await assert.rejects(
      updateJunius({
        currentVersion:
          "0.0.3-alpha-ChatGPT",
        packageRoot:
          "C:\\Junius",
        platform: "win32",
        environment: {
          JUNIUS_INSTANCE_ROLE:
            "development",
        },
        isFile:
          async () => true,
        runProcess:
          async () => {
            assert.fail(
              "runner must not execute",
            );
          },
      }),
      /Junius Dev/u,
    );
  },
);
