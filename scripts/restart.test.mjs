import assert from "node:assert/strict";
import test from "node:test";
import {
  restartJunius,
} from "./restart.mjs";

test("restartJunius stops the current Host and starts the installed launcher", async () => {
  const calls = [];
  const health = [
    {
      pid: 111,
      activeWorkerId: "worker-old",
      releaseId: "release-old",
    },
    {
      pid: 222,
      activeWorkerId: "worker-new",
      releaseId: "release-new",
    },
  ];

  const result = await restartJunius({
    platform: "win32",
    environment: {
      LOCALAPPDATA:
        "C:\\Users\\Demo\\AppData\\Local",
    },
    nodeExecutable:
      "C:\\Program Files\\nodejs\\node.exe",
    readHostHealth: async () =>
      health.shift(),
    stopInstalledJunius:
      async (options) => {
        calls.push([
          "stop",
          options.port,
        ]);
        return {
          wasRunning: true,
          pid: 111,
        };
      },
    startInstalledJunius:
      async (startup, options) => {
        calls.push([
          "start",
          startup,
          options.port,
        ]);
        return {
          alreadyRunning: false,
        };
      },
  });

  assert.equal(
    result.restarted,
    true,
  );
  assert.equal(
    result.previousPid,
    111,
  );
  assert.equal(
    result.pid,
    222,
  );
  assert.deepEqual(
    calls,
    [
      ["stop", 8787],
      [
        "start",
        {
          nodeExecutable:
            "C:\\Program Files\\nodejs\\node.exe",
          launcherPath:
            "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\scripts\\host-launcher.mjs",
          appRoot:
            "C:\\Users\\Demo\\AppData\\Local\\Junius\\app",
        },
        8787,
      ],
    ],
  );
});

test("restartJunius starts Junius when the Host is not currently running", async () => {
  let stopped = false;

  const result = await restartJunius({
    platform: "win32",
    environment: {
      LOCALAPPDATA:
        "C:\\Users\\Demo\\AppData\\Local",
    },
    nodeExecutable:
      "C:\\node.exe",
    readHostHealth: (() => {
      let call = 0;
      return async () => {
        call += 1;
        return call === 1
          ? undefined
          : {
              pid: 333,
              activeWorkerId:
                "worker-started",
              releaseId:
                "release-started",
            };
      };
    })(),
    stopInstalledJunius:
      async () => {
        stopped = true;
        return {
          wasRunning: false,
        };
      },
    startInstalledJunius:
      async () => ({
        alreadyRunning: false,
      }),
  });

  assert.equal(stopped, true);
  assert.equal(
    result.restarted,
    false,
  );
  assert.equal(
    result.previousPid,
    undefined,
  );
  assert.equal(
    result.pid,
    333,
  );
});
