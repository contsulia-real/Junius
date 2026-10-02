import assert from "node:assert/strict";
import {
  createServer,
} from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyApplication,
  installNodeDependencies,
  migrateLegacyPromptOverrides,
  validateInstalledApp,
} from "./install-application.mjs";
import {
  windowsInstallPaths,
  windowsRunValue,
  windowsStartupPowerShell,
} from "./install-paths.mjs";
import {
  supportedPythonVersion,
} from "./install-python.mjs";
import {
  startInstalledJunius,
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
      paths.promptRoot,
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\prompts",
    );
    assert.equal(
      paths.startupScript,
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\start-junius.ps1",
    );
    assert.equal(
      paths.legacyStartupScript,
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\start-junius.vbs",
    );
    assert.equal(
      paths.venvRoot,
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\.venv",
    );
  },
);

test(
  "installer migrates legacy app prompts before replacing packaged defaults",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-prompt-migration-",
        ),
      );
    const packageRoot =
      join(root, "package");
    const appRoot =
      join(root, "app");
    const promptRoot =
      join(root, "prompts");

    try {
      await mkdir(
        join(
          packageRoot,
          "prompts",
        ),
        { recursive: true },
      );
      await mkdir(
        join(
          appRoot,
          "prompts",
        ),
        { recursive: true },
      );
      await mkdir(
        promptRoot,
        { recursive: true },
      );

      await writeFile(
        join(
          packageRoot,
          "prompts",
          "engineering.md",
        ),
        "# new default\n",
        "utf8",
      );
      await writeFile(
        join(
          appRoot,
          "prompts",
          "engineering.md",
        ),
        "# legacy custom\n",
        "utf8",
      );
      await writeFile(
        join(
          appRoot,
          "prompts",
          "core.md",
        ),
        "# legacy core\n",
        "utf8",
      );
      await writeFile(
        join(
          promptRoot,
          "core.md",
        ),
        "# existing override\n",
        "utf8",
      );

      assert.deepEqual(
        await migrateLegacyPromptOverrides(
          appRoot,
          promptRoot,
        ),
        ["engineering.md"],
      );

      await copyApplication(
        packageRoot,
        appRoot,
      );

      assert.equal(
        await readFile(
          join(
            appRoot,
            "prompts",
            "engineering.md",
          ),
          "utf8",
        ),
        "# new default\n",
      );
      assert.equal(
        await readFile(
          join(
            promptRoot,
            "engineering.md",
          ),
          "utf8",
        ),
        "# legacy custom\n",
      );
      assert.equal(
        await readFile(
          join(
            promptRoot,
            "core.md",
          ),
          "utf8",
        ),
        "# existing override\n",
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
  "compiled release upgrade invalidates legacy source bootstrap runtime",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-compiled-upgrade-",
        ),
      );
    const packageRoot =
      join(root, "package");
    const appRoot =
      join(root, "app");
    const legacyRuntime =
      join(
        appRoot,
        ".junius",
        "runtime",
      );

    try {
      await mkdir(
        join(
          packageRoot,
          "runtime",
          "src",
        ),
        { recursive: true },
      );
      await writeFile(
        join(
          packageRoot,
          "runtime",
          "src",
          "host.js",
        ),
        "export {};\n",
        "utf8",
      );
      await mkdir(
        join(appRoot, "src"),
        { recursive: true },
      );
      await writeFile(
        join(
          appRoot,
          "src",
          "host.ts",
        ),
        "export {};\n",
        "utf8",
      );
      await mkdir(
        legacyRuntime,
        { recursive: true },
      );
      await writeFile(
        join(
          legacyRuntime,
          "legacy-marker.txt",
        ),
        "legacy\n",
        "utf8",
      );

      await copyApplication(
        packageRoot,
        appRoot,
      );

      await assert.rejects(
        readFile(
          join(
            legacyRuntime,
            "legacy-marker.txt",
          ),
          "utf8",
        ),
        /ENOENT/u,
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
  "compiled release upgrade preserves compatible compiled bootstrap runtime",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-compiled-runtime-preserve-",
        ),
      );
    const packageRoot =
      join(root, "package");
    const appRoot =
      join(root, "app");
    const runtimeMarker =
      join(
        appRoot,
        ".junius",
        "runtime",
        "current.json",
      );

    try {
      await mkdir(
        join(
          packageRoot,
          "runtime",
          "src",
        ),
        { recursive: true },
      );
      await writeFile(
        join(
          packageRoot,
          "runtime",
          "src",
          "host.js",
        ),
        "export {};\n",
        "utf8",
      );
      await mkdir(
        join(
          appRoot,
          ".junius",
          "runtime",
        ),
        { recursive: true },
      );
      await writeFile(
        runtimeMarker,
        "{\"version\":1}\n",
        "utf8",
      );

      await copyApplication(
        packageRoot,
        appRoot,
      );

      assert.equal(
        await readFile(
          runtimeMarker,
          "utf8",
        ),
        "{\"version\":1}\n",
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
          "0.0.4-alpha-ChatGPT",
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
            "0.0.4-alpha-ChatGPT",
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
  "installer installs runtime dependencies and omits development dependencies",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-install-deps-",
        ),
      );
    const runtimeFixture =
      join(
        root,
        "runtime-fixture",
      );
    const developmentFixture =
      join(
        root,
        "development-fixture",
      );

    try {
      for (
        const [
          directory,
          name,
        ] of [
          [
            runtimeFixture,
            "junius-runtime-fixture",
          ],
          [
            developmentFixture,
            "junius-development-fixture",
          ],
        ]
      ) {
        await mkdir(
          directory,
          {
            recursive: true,
          },
        );
        await writeFile(
          join(
            directory,
            "package.json",
          ),
          JSON.stringify({
            name,
            version: "1.0.0",
          }),
          "utf8",
        );
      }

      await writeFile(
        join(
          root,
          "package.json",
        ),
        JSON.stringify({
          name:
            "junius-install-probe",
          version: "1.0.0",
          dependencies: {
            "junius-runtime-fixture":
              "file:./runtime-fixture",
          },
          devDependencies: {
            "junius-development-fixture":
              "file:./development-fixture",
          },
        }),
        "utf8",
      );

      await installNodeDependencies(
        process.execPath,
        root,
      );

      assert.equal(
        JSON.parse(
          await readFile(
            join(
              root,
              "node_modules",
              "junius-runtime-fixture",
              "package.json",
            ),
            "utf8",
          ),
        ).name,
        "junius-runtime-fixture",
      );

      await assert.rejects(
        readFile(
          join(
            root,
            "node_modules",
            "junius-development-fixture",
            "package.json",
          ),
          "utf8",
        ),
        (error) =>
          error?.code ===
          "ENOENT",
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
  "installed compiled validation is isolated from inherited Junius runtime state",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-validation-env-",
        ),
      );
    const runtimeRoot =
      join(
        root,
        "runtime",
      );

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
      await mkdir(
        join(
          runtimeRoot,
          "src",
        ),
        {
          recursive: true,
        },
      );
      await mkdir(
        join(root, "bin"),
        {
          recursive: true,
        },
      );
      await mkdir(
        join(root, "scripts"),
        {
          recursive: true,
        },
      );

      await writeFile(
        join(
          runtimeRoot,
          "package.json",
        ),
        JSON.stringify({
          name: "junius",
          version: "1.0.0",
          private: true,
          type: "module",
        }),
        "utf8",
      );
      await writeFile(
        join(
          runtimeRoot,
          "src",
          "host.js",
        ),
        "export {};\n",
        "utf8",
      );
      await writeFile(
        join(
          runtimeRoot,
          "src",
          "worker-entry.js",
        ),
        "export {};\n",
        "utf8",
      );
      await writeFile(
        join(
          runtimeRoot,
          "src",
          "mcp-server.js",
        ),
        [
          "const expected = process.env.EXPECTED_APP_ROOT;",
          "if (process.env.JUNIUS_PROJECT_ROOT !== expected) process.exit(9);",
          "if (process.env.JUNIUS_RUNTIME_ROOT !== undefined) process.exit(8);",
          "export {};",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(
          root,
          "scripts",
          "validate-installed-runtime.mjs",
        ),
        await readFile(
          join(
            process.cwd(),
            "scripts",
            "validate-installed-runtime.mjs",
          ),
          "utf8",
        ),
        "utf8",
      );
      await writeFile(
        join(
          root,
          "bin",
          "junius.mjs",
        ),
        "process.exit(0);\n",
        "utf8",
      );

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
  "installer immediate start launches Node directly and waits for Host health",
  async () => {
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
              pid: 4343,
              activeWorkerId:
                "direct-start-worker",
              releaseId:
                "direct-start-release",
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

    await new Promise(
      (resolvePromise) =>
        server.close(
          resolvePromise,
        ),
    );

    const calls = [];
    let unrefCalled = false;

    try {
      const result =
        await startInstalledJunius(
          {
            nodeExecutable:
              "C:\\Program Files\\nodejs\\node.exe",
            launcherPath:
              "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\scripts\\host-launcher.mjs",
            appRoot:
              "C:\\Users\\Demo\\AppData\\Local\\Junius\\app",
          },
          {
            port:
              address.port,
            timeoutMs: 2_000,
            spawnProcess: (
              executable,
              args,
              options,
            ) => {
              calls.push({
                executable,
                args,
                options,
              });
              server.listen(
                address.port,
                "127.0.0.1",
              );
              return {
                once() {},
                unref() {
                  unrefCalled =
                    true;
                },
              };
            },
          },
        );

      assert.deepEqual(
        result,
        {
          alreadyRunning:
            false,
        },
      );
      assert.equal(
        unrefCalled,
        true,
      );
      assert.deepEqual(
        calls,
        [
          {
            executable:
              "C:\\Program Files\\nodejs\\node.exe",
            args: [
              "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\scripts\\host-launcher.mjs",
            ],
            options: {
              cwd:
                "C:\\Users\\Demo\\AppData\\Local\\Junius\\app",
              detached: true,
              windowsHide: true,
              stdio: "ignore",
            },
          },
        ],
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
  "installer startup uses hidden PowerShell without VBScript",
  () => {
    const script =
      windowsStartupPowerShell(
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\scripts\\host-launcher.mjs",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\app",
      );

    assert.match(
      script,
      /ProcessStartInfo/u,
    );
    assert.match(
      script,
      /CreateNoWindow = \$true/u,
    );
    assert.match(
      script,
      /node\.exe/u,
    );
    assert.match(
      script,
      /host-launcher\.mjs/u,
    );
    assert.doesNotMatch(
      script,
      /WScript/u,
    );

    assert.equal(
      windowsRunValue(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\start-junius.ps1",
      ),
      '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\Demo\\AppData\\Local\\Junius\\start-junius.ps1"',
    );
  },
);
