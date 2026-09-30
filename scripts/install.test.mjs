import assert from "node:assert/strict";
import {
  createServer,
} from "node:http";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyApplication,
  installNodeDependencies,
  validateInstalledApp,
} from "./install-application.mjs";
import {
  windowsInstallPaths,
  windowsRunValue,
  windowsStartupVbs,
} from "./install-paths.mjs";
import {
  supportedPythonVersion,
} from "./install-python.mjs";
import {
  stopInstalledJunius,
} from "./install-windows-host.mjs";
import {
  assertWindowsPlatform,
  WINDOWS_ONLY_MESSAGE,
} from "./windows-only.mjs";

test(
  "Junius rejects every non-Windows platform",
  () => {
    assert.doesNotThrow(
      () => assertWindowsPlatform("win32"),
    );

    for (const platform of [
      "linux",
      "darwin",
      "freebsd",
    ]) {
      assert.throws(
        () => assertWindowsPlatform(platform),
        new Error(
          WINDOWS_ONLY_MESSAGE,
        ),
      );
    }
  },
);

test(
  "installer accepts Python 3.10 or newer",
  () => {
    assert.equal(
      supportedPythonVersion(
        [3, 10, 0],
      ),
      true,
    );
    assert.equal(
      supportedPythonVersion(
        [3, 13, 1],
      ),
      true,
    );
    assert.equal(
      supportedPythonVersion(
        [3, 9, 9],
      ),
      false,
    );
    assert.equal(
      supportedPythonVersion(
        [2, 7, 18],
      ),
      false,
    );
  },
);

test(
  "installer uses LOCALAPPDATA for persistent Windows installation",
  () => {
    const paths =
      windowsInstallPaths({
        LOCALAPPDATA:
          "C:\\Users\\Demo\\AppData\\Local",
      });

    assert.equal(
      paths.root,
      "C:\\Users\\Demo\\AppData\\Local\\Junius",
    );
    assert.equal(
      paths.appRoot,
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\app",
    );
    assert.equal(
      paths.venvRoot,
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\.venv",
    );
  },
);

test(
  "installer materializes the published install lock as npm shrinkwrap",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-install-lock-",
        ),
      );
    const packageRoot =
      join(
        root,
        "package",
      );
    const appRoot =
      join(
        root,
        "app",
      );
    const lockText =
      JSON.stringify({
        name: "junius",
        version:
          "0.0.3-alpha-ChatGPT",
        lockfileVersion: 3,
        packages: {},
      });

    try {
      await mkdir(
        packageRoot,
        { recursive: true },
      );
      await writeFile(
        join(
          packageRoot,
          "package.json",
        ),
        JSON.stringify({
          name: "junius",
          version:
            "0.0.3-alpha-ChatGPT",
        }),
        "utf8",
      );
      await writeFile(
        join(
          packageRoot,
          "install-lock.json",
        ),
        lockText,
        "utf8",
      );
      await writeFile(
        join(
          packageRoot,
          "AGENTS.md",
        ),
        "# repository instructions\n",
        "utf8",
      );
      await writeFile(
        join(
          packageRoot,
          "icon.svg",
        ),
        "<svg aria-label=\"Junius\" />\n",
        "utf8",
      );
      await writeFile(
        join(
          packageRoot,
          "install.ps1",
        ),
        "# update bootstrap\n",
        "utf8",
      );
      await mkdir(
        join(
          packageRoot,
          "prompts",
        ),
        { recursive: true },
      );
      await writeFile(
        join(
          packageRoot,
          "prompts",
          "core.md",
        ),
        "# custom core\n",
        "utf8",
      );

      await copyApplication(
        packageRoot,
        appRoot,
      );

      const {
        readFile,
      } =
        await import(
          "node:fs/promises"
        );

      assert.equal(
        await readFile(
          join(
            appRoot,
            "install-lock.json",
          ),
          "utf8",
        ),
        lockText,
      );
      assert.equal(
        await readFile(
          join(
            appRoot,
            "npm-shrinkwrap.json",
          ),
          "utf8",
        ),
        lockText,
      );
      assert.equal(
        await readFile(
          join(
            appRoot,
            "prompts",
            "core.md",
          ),
          "utf8",
        ),
        "# custom core\n",
      );
      assert.equal(
        await readFile(
          join(
            appRoot,
            "AGENTS.md",
          ),
          "utf8",
        ),
        "# repository instructions\n",
      );
      assert.equal(
        await readFile(
          join(
            appRoot,
            "icon.svg",
          ),
          "utf8",
        ),
        "<svg aria-label=\"Junius\" />\n",
      );
      assert.equal(
        await readFile(
          join(
            appRoot,
            "install.ps1",
          ),
          "utf8",
        ),
        "# update bootstrap\n",
      );
    } finally {
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

test(
  "installer includes dev dependencies even under production npm settings",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-install-deps-",
        ),
      );
    const fixture =
      join(
        root,
        "fixture",
      );

    const previousNodeEnv =
      process.env.NODE_ENV;
    const previousOmit =
      process.env.npm_config_omit;

    try {
      await mkdir(
        fixture,
        { recursive: true },
      );
      await writeFile(
        join(
          fixture,
          "package.json",
        ),
        JSON.stringify({
          name:
            "junius-install-fixture",
          version: "1.0.0",
        }),
        "utf8",
      );
      await writeFile(
        join(
          root,
          "package.json",
        ),
        JSON.stringify({
          name:
            "junius-install-probe",
          version: "1.0.0",
          devDependencies: {
            "junius-install-fixture":
              "file:./fixture",
          },
        }),
        "utf8",
      );

      process.env.NODE_ENV =
        "production";
      process.env.npm_config_omit =
        "dev";

      await installNodeDependencies(
        process.execPath,
        root,
      );

      const installed =
        await import(
          "node:fs/promises"
        ).then(
          ({ stat }) =>
            stat(
              join(
                root,
                "node_modules",
                "junius-install-fixture",
                "package.json",
              ),
            ),
        );

      assert.equal(
        installed.isFile(),
        true,
      );
    } finally {
      if (
        previousNodeEnv ===
        undefined
      ) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV =
          previousNodeEnv;
      }

      if (
        previousOmit ===
        undefined
      ) {
        delete process.env
          .npm_config_omit;
      } else {
        process.env
          .npm_config_omit =
          previousOmit;
      }

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

test(
  "installed validation is isolated from inherited Junius runtime state",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-validation-env-",
        ),
      );
    const npmCli = join(
      root,
      "npm-cli.js",
    );

    const previousNpmExecPath =
      process.env.npm_execpath;
    const previousProjectRoot =
      process.env
        .JUNIUS_PROJECT_ROOT;
    const previousRuntimeRoot =
      process.env
        .JUNIUS_RUNTIME_ROOT;
    const previousExpectedRoot =
      process.env
        .EXPECTED_APP_ROOT;

    try {
      await writeFile(
        npmCli,
        [
          'const expected = process.env.EXPECTED_APP_ROOT;',
          'if (process.env.JUNIUS_PROJECT_ROOT !== expected) process.exit(9);',
          'if (process.env.JUNIUS_RUNTIME_ROOT !== undefined) process.exit(8);',
          'if (process.argv.slice(2).join(" ") !== "run check") process.exit(7);',
          '',
        ].join("\n"),
        "utf8",
      );

      process.env.npm_execpath =
        npmCli;
      process.env
        .JUNIUS_PROJECT_ROOT =
        "C:\\wrong\\project";
      process.env
        .JUNIUS_RUNTIME_ROOT =
        "C:\\wrong\\runtime";
      process.env
        .EXPECTED_APP_ROOT =
        root;

      await validateInstalledApp(
        process.execPath,
        root,
      );
    } finally {
      if (
        previousNpmExecPath ===
        undefined
      ) {
        delete process.env
          .npm_execpath;
      } else {
        process.env.npm_execpath =
          previousNpmExecPath;
      }

      if (
        previousProjectRoot ===
        undefined
      ) {
        delete process.env
          .JUNIUS_PROJECT_ROOT;
      } else {
        process.env
          .JUNIUS_PROJECT_ROOT =
          previousProjectRoot;
      }

      if (
        previousRuntimeRoot ===
        undefined
      ) {
        delete process.env
          .JUNIUS_RUNTIME_ROOT;
      } else {
        process.env
          .JUNIUS_RUNTIME_ROOT =
          previousRuntimeRoot;
      }

      if (
        previousExpectedRoot ===
        undefined
      ) {
        delete process.env
          .EXPECTED_APP_ROOT;
      } else {
        process.env
          .EXPECTED_APP_ROOT =
          previousExpectedRoot;
      }

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

test(
  "installer stops an existing healthy Host before restart",
  async () => {
    const expectedPid = 4242;
    const server =
      createServer(
        (_request, response) => {
          response.writeHead(
            200,
            {
              "content-type":
                "application/json",
            },
          );
          response.end(
            JSON.stringify({
              ok: true,
              pid: expectedPid,
              activeWorkerId:
                "test-worker",
              releaseId:
                "test-release",
            }),
          );
        },
      );

    await new Promise(
      (resolvePromise) => {
        server.listen(
          0,
          "127.0.0.1",
          resolvePromise,
        );
      },
    );

    const address =
      server.address();

    assert.equal(
      typeof address,
      "object",
    );
    assert.notEqual(
      address,
      null,
    );

    let stoppedPid;

    try {
      const result =
        await stopInstalledJunius({
          port: address.port,
          timeoutMs: 2_000,
          stopProcessTree:
            async (pid) => {
              stoppedPid = pid;
              await new Promise(
                (
                  resolvePromise,
                  rejectPromise,
                ) => {
                  server.close(
                    (error) => {
                      if (error) {
                        rejectPromise(
                          error,
                        );
                        return;
                      }
                      resolvePromise();
                    },
                  );
                },
              );
            },
        });

      assert.deepEqual(
        result,
        {
          wasRunning: true,
          pid: expectedPid,
        },
      );
      assert.equal(
        stoppedPid,
        expectedPid,
      );
    } finally {
      if (
        server.listening
      ) {
        await new Promise(
          (resolvePromise) =>
            server.close(
              resolvePromise,
            ),
        );
      }
    }
  },
);

test(
  "installer startup reuses the selected Node executable and hides the Host",
  () => {
    const script =
      windowsStartupVbs(
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\scripts\\host-launcher.mjs",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\app",
      );

    assert.match(
      script,
      /node\.exe/u,
    );
    assert.match(
      script,
      /host-launcher\.mjs/u,
    );
    assert.match(
      script,
      /, 0, False/u,
    );

    assert.equal(
      windowsRunValue(
        "C:\\Windows\\System32\\wscript.exe",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\start-junius.vbs",
      ),
      '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\Users\\Demo\\AppData\\Local\\Junius\\start-junius.vbs"',
    );
  },
);
