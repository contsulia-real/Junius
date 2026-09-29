import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
} from "node:child_process";
import {
  createServer,
} from "node:http";
import {
  access,
  readFile,
  rm,
} from "node:fs/promises";
import {
  join,
} from "node:path";
import {
  once,
} from "node:events";
import test from "node:test";
import {
  buildRelease,
  checksumLine,
  validateInstallLock,
  validatePackedFiles,
} from "./build-release.mjs";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runProcess(
  executable,
  args,
  options = {},
) {
  return new Promise(
    (
      resolvePromise,
      rejectPromise,
    ) => {
      const child =
        spawn(
          executable,
          args,
          {
            cwd:
              process.cwd(),
            env:
              options.env ??
              process.env,
            windowsHide:
              true,
            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
          },
        );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding(
        "utf8",
      );
      child.stderr.setEncoding(
        "utf8",
      );
      child.stdout.on(
        "data",
        (chunk) => {
          stdout += chunk;
        },
      );
      child.stderr.on(
        "data",
        (chunk) => {
          stderr += chunk;
        },
      );
      child.once(
        "error",
        rejectPromise,
      );
      child.once(
        "close",
        (exitCode) => {
          resolvePromise({
            exitCode,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}

const requiredPackFiles = [
  "package.json",
  "install.ps1",
  "install-lock.json",
  "bin/junius.mjs",
  "scripts/install.mjs",
  "scripts/install-core.mjs",
  "src/mcp-server.ts",
  "python/desktop_helper.py",
].map(
  (path) => ({
    path,
  }),
);

test(
  "GitHub Releases is the public distribution surface",
  async () => {
    const root = process.cwd();
    assert.equal(
      await exists(
        join(
          root,
          "install.ps1",
        ),
      ),
      true,
      "missing root install.ps1",
    );
    assert.equal(
      await exists(
        join(
          root,
          ".github",
          "workflows",
          "release.yml",
        ),
      ),
      true,
      "missing GitHub release workflow",
    );

    const packageJson =
      JSON.parse(
        await readFile(
          join(
            root,
            "package.json",
          ),
          "utf8",
        ),
      );
    assert.equal(
      packageJson.private,
      true,
      "package must be private so npm publish cannot become the public distribution path",
    );
    assert.equal(
      "publishConfig" in
        packageJson,
      false,
      "npm publishConfig must not remain on the public distribution path",
    );
    assert.equal(
      packageJson.scripts
        ?.prepublishOnly,
      "node scripts/block-npm-publish.mjs",
      "npm publish must be explicitly blocked",
    );

    const installScript =
      await readFile(
        join(
          root,
          "install.ps1",
        ),
        "utf8",
      );
    assert.equal(
      installScript.includes(
        "Remove-Item Env:GITHUB_TOKEN",
      ),
      true,
      "GitHub download token must not be inherited by installed Junius",
    );

    const readme =
      await readFile(
        join(
          root,
          "README.md",
        ),
        "utf8",
      );
    assert.equal(
      readme.includes(
        "raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1",
      ),
      true,
    );
    assert.equal(
      readme.includes(
        "npx --yes junius@latest install",
      ),
      false,
    );

    const ci =
      await readFile(
        join(
          root,
          ".github",
          "workflows",
          "ci.yml",
        ),
        "utf8",
      );
    assert.equal(
      ci.includes(
        "npm publish",
      ),
      false,
    );
    assert.equal(
      ci.includes(
        "npm run release:build",
      ),
      true,
    );
  },
);

test(
  "release pack validation requires installer inputs and rejects runtime debris",
  () => {
    assert.doesNotThrow(
      () =>
        validatePackedFiles(
          requiredPackFiles,
        ),
    );

    assert.throws(
      () =>
        validatePackedFiles([
          ...requiredPackFiles,
          {
            path:
              "node_modules/example/index.js",
          },
        ]),
      /release_contains_forbidden_files/u,
    );
  },
);

test(
  "release install lock matches package identity and direct dependencies",
  async () => {
    const packageJson =
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "package.json",
          ),
          "utf8",
        ),
      );
    const installLock =
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "install-lock.json",
          ),
          "utf8",
        ),
      );

    assert.doesNotThrow(
      () =>
        validateInstallLock(
          packageJson,
          installLock,
        ),
    );

    assert.throws(
      () =>
        validateInstallLock(
          {
            ...packageJson,
            version:
              "99.0.0-test",
          },
          installLock,
        ),
      /release_install_lock_identity_mismatch/u,
    );

    assert.throws(
      () =>
        validateInstallLock(
          {
            ...packageJson,
            dependencies: {
              ...packageJson.dependencies,
              zod: "0.0.0",
            },
          },
          installLock,
        ),
      /release_install_lock_dependency_mismatch/u,
    );
  },
);

test(
  "release checksum format is stable",
  () => {
    assert.equal(
      checksumLine(
        "ABCDEF",
        "junius-windows.tgz",
      ),
      "abcdef  junius-windows.tgz",
    );
  },
);

test(
  "PowerShell bootstrap parses without syntax errors",
  {
    skip:
      process.platform !==
      "win32",
  },
  () => {
    const command = [
      "$tokens=$null",
      "$errors=$null",
      "[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path '.\\install.ps1'),[ref]$tokens,[ref]$errors) | Out-Null",
      "if($errors.Count -gt 0){$errors | ForEach-Object { Write-Error $_ }; exit 1}",
    ].join("; ");

    const result =
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          command,
        ],
        {
          cwd:
            process.cwd(),
          encoding:
            "utf8",
        },
      );

    assert.equal(
      result.status,
      0,
      result.stderr ||
        result.stdout,
    );
  },
);

test(
  "PowerShell bootstrap verifies a GitHub-style release before installation",
  {
    skip:
      process.platform !==
      "win32",
  },
  async () => {
    await buildRelease();

    const dist = join(
      process.cwd(),
      "dist",
    );
    const packageData =
      await readFile(
        join(
          dist,
          "junius-windows.tgz",
        ),
      );
    const checksumData =
      await readFile(
        join(
          dist,
          "SHA256SUMS.txt",
        ),
      );
    const packageJson =
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "package.json",
          ),
          "utf8",
        ),
      );
    const tag =
      "v" +
      packageJson.version;

    const server =
      createServer(
        (
          request,
          response,
        ) => {
          const origin =
            "http://127.0.0.1:" +
            server.address().port;
          const releasePath =
            "/repos/contsulia-real/Junius/releases/tags/" +
            encodeURIComponent(
              tag,
            );
          const assets = [
            {
              name:
                "junius-windows.tgz",
              url:
                origin +
                "/api/assets/junius-windows.tgz",
              browser_download_url:
                origin +
                "/assets/junius-windows.tgz",
            },
            {
              name:
                "SHA256SUMS.txt",
              url:
                origin +
                "/api/assets/SHA256SUMS.txt",
              browser_download_url:
                origin +
                "/assets/SHA256SUMS.txt",
            },
          ];

          if (
            request.url ===
            releasePath
          ) {
            response.writeHead(
              200,
              {
                "content-type":
                  "application/json",
              },
            );
            response.end(
              JSON.stringify({
                tag_name: tag,
                draft: true,
                prerelease: true,
                published_at:
                  new Date()
                    .toISOString(),
                assets,
              }),
            );
            return;
          }

          if (
            request.url ===
            "/repos/contsulia-real/Junius/releases?per_page=50"
          ) {
            response.writeHead(
              200,
              {
                "content-type":
                  "application/json",
              },
            );
            response.end(
              JSON.stringify([
                {
                  tag_name: tag,
                  draft: false,
                  prerelease: true,
                  published_at:
                    new Date()
                      .toISOString(),
                  assets,
                },
              ]),
            );
            return;
          }

          if (
            request.url ===
              "/assets/junius-windows.tgz" ||
            request.url ===
              "/api/assets/junius-windows.tgz"
          ) {
            response.writeHead(
              200,
              {
                "content-type":
                  "application/gzip",
              },
            );
            response.end(
              packageData,
            );
            return;
          }

          if (
            request.url ===
              "/assets/SHA256SUMS.txt" ||
            request.url ===
              "/api/assets/SHA256SUMS.txt"
          ) {
            response.writeHead(
              200,
              {
                "content-type":
                  "text/plain",
              },
            );
            response.end(
              checksumData,
            );
            return;
          }

          response.writeHead(
            404,
          );
          response.end();
        },
      );

    server.listen(
      0,
      "127.0.0.1",
    );
    await once(
      server,
      "listening",
    );

    try {
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

      const publicResult =
        await runProcess(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(
              process.cwd(),
              "install.ps1",
            ),
            "-ApiBaseUrl",
            "http://127.0.0.1:" +
              address.port,
            "-VerifyOnly",
          ],
        );

      assert.equal(
        publicResult.exitCode,
        0,
        publicResult.stderr +
          publicResult.stdout,
      );
      assert.match(
        publicResult.stdout,
        /Verified SHA-256:/u,
      );
      assert.match(
        publicResult.stdout,
        /verification completed without installation/u,
      );

      const draftResult =
        await runProcess(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(
              process.cwd(),
              "install.ps1",
            ),
            "-Version",
            tag,
            "-ApiBaseUrl",
            "http://127.0.0.1:" +
              address.port,
            "-VerifyOnly",
          ],
          {
            env: {
              ...process.env,
              GITHUB_TOKEN:
                "test-token",
            },
          },
        );

      assert.equal(
        draftResult.exitCode,
        0,
        draftResult.stderr +
          draftResult.stdout,
      );
      assert.match(
        draftResult.stdout,
        /Verified SHA-256:/u,
      );
    } finally {
      server.close();
      await once(
        server,
        "close",
      );
      await rm(
        dist,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
