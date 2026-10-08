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
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import {
  join,
} from "node:path";
import {
  tmpdir,
} from "node:os";
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
import {
  extractReleaseChangelog,
} from "./release-notes.mjs";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function freeLoopbackPort() {
  const server =
    createServer();

  server.listen(
    0,
    "127.0.0.1",
  );
  await once(
    server,
    "listening",
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

  const port =
    address.port;

  server.close();
  await once(
    server,
    "close",
  );

  return port;
}

test(
  "release notes contain only the matching changelog section body",
  async () => {
    assert.equal(
      extractReleaseChangelog(
        [
          "# Changelog",
          "",
          "## Unreleased",
          "",
          "- Next",
          "",
          "## 0.0.5-alpha",
          "",
          "- First change",
          "- Second change",
          "",
          "## 0.0.4-alpha-ChatGPT",
          "",
          "- Older",
          "",
        ].join("\n"),
        "0.0.5-alpha",
      ),
      "- First change\n- Second change",
    );

    assert.throws(
      () =>
        extractReleaseChangelog(
          "# Changelog\n\n## Unreleased\n\n- Next\n",
          "0.0.5-alpha",
        ),
      /release_changelog_section_missing/u,
    );

    const workflow =
      await readFile(
        join(
          process.cwd(),
          ".github",
          "workflows",
          "release.yml",
        ),
        "utf8",
      );
    assert.match(
      workflow,
      /npm run release:notes/u,
    );
    assert.match(
      workflow,
      /--notes-file "dist\/release-notes\.md"/u,
    );
    assert.doesNotMatch(
      workflow,
      /--generate-notes/u,
    );
    assert.match(
      workflow,
      /gh release upload "\$env:GITHUB_REF_NAME" @assets --clobber/u,
    );
    assert.match(
      workflow,
      /gh release view "\$env:GITHUB_REF_NAME" --json databaseId,tagName/u,
    );
    assert.doesNotMatch(
      workflow,
      /releases\?per_page=100/u,
    );

    const changelog =
      await readFile(
        join(
          process.cwd(),
          "CHANGELOG.md",
        ),
        "utf8",
      );
    assert.match(
      changelog,
      /^## Unreleased$/mu,
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
    assert.doesNotMatch(
      packageJson.version,
      /chatgpt/iu,
      "new Junius version identifiers must not contain the ChatGPT brand",
    );
  },
);

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
              options.cwd ??
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
  "CHANGELOG.md",
  "icon.svg",
  "install.ps1",
  "install-lock.json",
  "requirements-desktop.txt",
  "bin/junius.mjs",
  "scripts/host-launcher.mjs",
  "scripts/host-bootstrap.mjs",
  "scripts/host-bootstrap-paths.mjs",
  "scripts/host-bootstrap-source.mjs",
  "scripts/host-bootstrap-check.mjs",
  "scripts/host-bootstrap-releases.mjs",
  "scripts/host-bootstrap-host.mjs",
  "scripts/install.mjs",
  "scripts/install-cli.mjs",
  "scripts/install-paths.mjs",
  "scripts/install-process.mjs",
  "scripts/install-python.mjs",
  "scripts/install-application.mjs",
  "scripts/install-windows-host.mjs",
  "scripts/restart.mjs",
  "scripts/update.mjs",
  "scripts/validate-installed-runtime.mjs",
  "scripts/windows-only.mjs",
  "runtime/package.json",
  "runtime/src/host.js",
  "runtime/src/worker-entry.js",
  "runtime/src/job-bootstrap.mjs",
  "runtime/src/windows-job-guardian.ps1",
  "runtime/python/desktop_helper.py",
  "runtime/python/desktop_helper_common.py",
  "runtime/python/desktop_windows.py",
  "runtime/python/desktop_clipboard.py",
  "runtime/python/desktop_input.py",
  "runtime/python/user_interrupt.py",
  "runtime/prompts/core.md",
  "runtime/prompts/engineering.md",
  "runtime/prompts/desktop.md",
  "runtime/prompts/browser.md",
  "runtime/ui/observability-panel.html",
  "runtime/scripts/install-paths.mjs",
  "runtime/scripts/install-process.mjs",
  "runtime/scripts/update.mjs",
  "runtime/scripts/windows-only.mjs",
  "python/desktop_helper.py",
  "python/desktop_helper_common.py",
  "python/desktop_windows.py",
  "python/desktop_clipboard.py",
  "python/desktop_input.py",
  "python/user_interrupt.py",
  "prompts/core.md",
  "prompts/engineering.md",
  "prompts/desktop.md",
  "prompts/browser.md",
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
    assert.deepEqual(
      packageJson.os,
      ["win32"],
      "Junius package metadata must reject every non-Windows operating system",
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

    assert.equal(
      installScript.includes(
        "junius.cmd",
      ),
      true,
      "PowerShell bootstrap must repair the Junius command shim",
    );
    assert.equal(
      installScript.includes(
        "[Environment]::SetEnvironmentVariable(\"Path\", $userPath, \"User\")",
      ),
      true,
      "PowerShell bootstrap must persist the Junius bin directory on the user PATH",
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
        "npm run check:release",
      ),
      true,
    );
    assert.equal(
      ci.includes(
        "npm run release:build",
      ),
      true,
    );
    assert.equal(
      packageJson.scripts
        ?.check,
      "node scripts/source-validation.mjs begin && npm run check:bootstrap && npm run typecheck && npm run test:runtime && node scripts/source-validation.mjs commit",
      "installed runtime validation must not require source-only release tests",
    );
    assert.equal(
      packageJson.scripts
        ?.[
          "check:release"
        ],
      "npm run test:release",
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

    assert.throws(
      () =>
        validatePackedFiles([
          ...requiredPackFiles,
          {
            path:
              "src/source.ts",
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
    const tempRoot =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-release-test-",
        ),
      );
    const dist =
      join(
        tempRoot,
        "dist",
      );

    await buildRelease({
      distRoot: dist,
    });

    const extractedRoot =
      join(
        tempRoot,
        "extracted",
      );
    await mkdir(
      extractedRoot,
      {
        recursive: true,
      },
    );
    const extraction =
      await runProcess(
        "tar.exe",
        [
          "-xzf",
          join(
            dist,
            "junius-windows.tgz",
          ),
          "-C",
          extractedRoot,
        ],
      );
    assert.equal(
      extraction.exitCode,
      0,
      extraction.stderr +
        extraction.stdout,
    );

    const packedRoot =
      join(
        extractedRoot,
        "package",
      );
    const packedPackage =
      JSON.parse(
        await readFile(
          join(
            packedRoot,
            "package.json",
          ),
          "utf8",
        ),
      );
    const packedLock =
      JSON.parse(
        await readFile(
          join(
            packedRoot,
            "install-lock.json",
          ),
          "utf8",
        ),
      );

    assert.equal(
      packedPackage
        .devDependencies,
      undefined,
    );
    assert.equal(
      packedLock
        .packages[""]
        .devDependencies,
      undefined,
    );
    assert.equal(
      await exists(
        join(
          packedRoot,
          "runtime",
          "src",
          "host.js",
        ),
      ),
      true,
    );
    assert.equal(
      await exists(
        join(
          packedRoot,
          "runtime",
          "src",
          "worker-entry.js",
        ),
      ),
      true,
    );
    for (
      const sourceOnlyPath of [
        "AGENTS.md",
        "tsconfig.json",
        "tsconfig.runtime.json",
        "src",
        join(
          "scripts",
          "build-runtime.mjs",
        ),
      ]
    ) {
      assert.equal(
        await exists(
          join(
            packedRoot,
            sourceOnlyPath,
          ),
        ),
        false,
        "release shipped source-only path: " +
          sourceOnlyPath,
      );
    }

    const dependencyInstall =
      await runProcess(
        "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          "npm install --omit=dev --no-audit --no-fund",
        ],
        {
          cwd: packedRoot,
        },
      );
    assert.equal(
      dependencyInstall
        .exitCode,
      0,
      dependencyInstall.stderr +
        dependencyInstall.stdout,
    );
    assert.equal(
      await exists(
        join(
          packedRoot,
          "node_modules",
          "tsx",
        ),
      ),
      false,
    );
    assert.equal(
      await exists(
        join(
          packedRoot,
          "node_modules",
          "typescript",
        ),
      ),
      false,
    );

    const compiledPort =
      await freeLoopbackPort();
    const compiledStartup =
      await runProcess(
        process.execPath,
        [
          join(
            packedRoot,
            "scripts",
            "host-launcher.mjs",
          ),
        ],
        {
          cwd: packedRoot,
          env: {
            ...process.env,
            JUNIUS_PROJECT_ROOT:
              packedRoot,
            JUNIUS_RUNTIME_ROOT:
              join(
                tempRoot,
                "compiled-runtime-state",
              ),
            JUNIUS_MCP_PORT:
              String(
                compiledPort,
              ),
            JUNIUS_BOOTSTRAP_TEST_EXIT_AFTER_HEALTH:
              "1",
          },
        },
      );
    assert.equal(
      compiledStartup.exitCode,
      0,
      compiledStartup.stderr +
        compiledStartup.stdout,
    );
    const compiledRuntimeRoot =
      join(
        tempRoot,
        "compiled-runtime-state",
      );
    const compiledCurrent =
      JSON.parse(
        await readFile(
          join(
            compiledRuntimeRoot,
            "current.json",
          ),
          "utf8",
        ),
      );
    assert.equal(
      typeof compiledCurrent.releaseId,
      "string",
    );
    assert.equal(
      await exists(
        join(
          compiledRuntimeRoot,
          "releases",
          compiledCurrent.releaseId,
          "runtime",
          "src",
          "host.js",
        ),
      ),
      true,
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

          if (request.url === "/contsulia-real/Junius/releases.atom") {
            response.writeHead(200, { "content-type": "application/atom+xml" });
            response.end([
              '<?xml version="1.0" encoding="UTF-8"?>',
              '<feed xmlns="http://www.w3.org/2005/Atom">',
              '<entry><updated>2026-10-08T14:38:03Z</updated><link rel="alternate" href="' +
                origin + '/contsulia-real/Junius/releases/tag/' + tag + '"/></entry>',
              '<entry><updated>2024-01-01T00:00:00Z</updated><link rel="alternate" href="' +
                origin + '/contsulia-real/Junius/releases/tag/v0.0.1-alpha"/></entry>',
              '</feed>',
            ].join(""));
            return;
          }
          if (request.url === "/contsulia-real/Empty/releases.atom") {
            response.writeHead(200, { "content-type": "application/atom+xml" });
            response.end('<feed xmlns="http://www.w3.org/2005/Atom"/>');
            return;
          }

          if (
            request.url ===
            "/repos/contsulia-real/Junius/releases/4242"
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
                id: 4242,
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
                {
                  tag_name:
                    "v0.0.1-alpha-ChatGPT",
                  draft: false,
                  prerelease: true,
                  published_at:
                    new Date(
                      Date.now() -
                        86_400_000,
                    )
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
              "/api/assets/junius-windows.tgz" ||
            request.url ===
              "/contsulia-real/Junius/releases/download/" + tag + "/junius-windows.tgz"
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
              "/api/assets/SHA256SUMS.txt" ||
            request.url ===
              "/contsulia-real/Junius/releases/download/" + tag + "/SHA256SUMS.txt"
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

      const updateCheck =
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
            "-CheckOnly",
            "-CurrentVersion",
            "0.0.2-alpha-ChatGPT",
            "-Json",
          ],
        );

      assert.equal(
        updateCheck.exitCode,
        0,
        updateCheck.stderr +
          updateCheck.stdout,
      );
      assert.deepEqual(
        JSON.parse(
          updateCheck
            .stdout
            .trim(),
        ),
        {
          currentVersion:
            "0.0.2-alpha-ChatGPT",
          latestVersion:
            packageJson.version,
          releaseTag: tag,
          updateAvailable:
            true,
        },
      );

      const downgradeCheck =
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
            "-CheckOnly",
            "-CurrentVersion",
            "1.0.0-alpha",
            "-Json",
          ],
        );

      assert.equal(
        downgradeCheck.exitCode,
        0,
        downgradeCheck.stderr +
          downgradeCheck.stdout,
      );
      assert.equal(
        JSON.parse(
          downgradeCheck
            .stdout
            .trim(),
        ).updateAvailable,
        false,
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

      const feedBase = "http://127.0.0.1:" + address.port;
      const feedCheck = await runProcess("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(process.cwd(), "install.ps1"),
        "-ReleaseBaseUrl", feedBase,
        "-CheckOnly", "-CurrentVersion", "0.0.2-alpha", "-Json",
      ], { env: { ...process.env, GITHUB_TOKEN: "" } });
      assert.equal(feedCheck.exitCode, 0, feedCheck.stderr + feedCheck.stdout);
      assert.equal(JSON.parse(feedCheck.stdout.trim()).releaseTag, tag);

      const feedVerify = await runProcess("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(process.cwd(), "install.ps1"),
        "-ReleaseBaseUrl", feedBase, "-VerifyOnly",
      ], { env: { ...process.env, GITHUB_TOKEN: "" } });
      assert.equal(feedVerify.exitCode, 0, feedVerify.stderr + feedVerify.stdout);
      assert.match(feedVerify.stdout, /Verified SHA-256:/u);

      const pinnedVerify = await runProcess("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(process.cwd(), "install.ps1"),
        "-ReleaseBaseUrl", feedBase, "-Version", packageJson.version, "-VerifyOnly",
      ], { env: { ...process.env, GITHUB_TOKEN: "" } });
      assert.equal(pinnedVerify.exitCode, 0, pinnedVerify.stderr + pinnedVerify.stdout);
      assert.match(pinnedVerify.stdout, /Verified SHA-256:/u);

      const emptyFeed = await runProcess("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(process.cwd(), "install.ps1"),
        "-ReleaseBaseUrl", feedBase, "-Repository", "contsulia-real/Empty",
        "-CheckOnly", "-CurrentVersion", "0.0.2-alpha",
      ], { env: { ...process.env, GITHUB_TOKEN: "" } });
      assert.notEqual(emptyFeed.exitCode, 0);
      assert.match(emptyFeed.stderr, /No published Junius GitHub Release/u);

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
            "-ReleaseId",
            "4242",
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
        tempRoot,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
