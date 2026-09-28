import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createGitCapability,
  isAllowedGitArgs,
  resolveGitLauncher,
} from "./git-capability.js";

test("git capability policy allows bounded development commands and rejects destructive shapes", () => {
  const allowed: readonly (readonly string[])[] = [
    ["--version"],
    ["init"],
    ["init", "-b", "main"],
    ["status", "--short", "--branch"],
    ["add", "-A"],
    ["add", "--", "src/index.ts"],
    ["commit", "-m", "Sync local Junius"],
    ["config", "--get", "user.name"],
    ["config", "--local", "user.name", "Why23"],
    ["config", "--local", "user.email", "why23@example.invalid"],
    ["branch", "--show-current"],
    ["branch", "-M", "main"],
    ["remote", "-v"],
    ["remote", "add", "origin", "https://github.com/owner/repo.git"],
    ["remote", "set-url", "origin", "git@github.com:owner/repo.git"],
    ["remote", "get-url", "origin"],
    ["fetch", "origin"],
    ["push", "--force", "--set-upstream", "origin", "main"],
    ["rev-parse", "--is-inside-work-tree"],
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "HEAD"],
    ["diff", "--cached", "--stat"],
    ["log", "--oneline", "-n", "20"],
    ["ls-files"],
  ];

  for (const args of allowed) {
    assert.equal(
      isAllowedGitArgs(args),
      true,
      `expected git args to be allowed: ${JSON.stringify(args)}`,
    );
  }

    const rejected: readonly (readonly string[])[] = [
      ["clean", "-fdx"],
      ["reset", "--hard", "HEAD"],
      ["checkout", "--", "."],
      ["config", "--local", "alias.pwn", "!powershell"],
      ["remote", "add", "origin", "-dangerous"],
      ["push", "--mirror", "origin"],
      ["push", "--delete", "origin", "main"],
      ["add", "-f", "."],
      ["commit", "--amend", "--no-edit"],
    ];
  
    for (const args of rejected) {
      assert.equal(
        isAllowedGitArgs(args),
        false,
        `expected git args to be rejected: ${JSON.stringify(args)}`,
      );
    }
});


async function writeGitConfig(
  root: string,
  content: string,
): Promise<void> {
  await mkdir(join(root, ".git"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".git", "config"),
    content,
    "utf8",
  );
}

function testGitCapability() {
  return createGitCapability({
    executable:
      process.platform === "win32"
        ? "C:\\Windows\\System32\\where.exe"
        : "/usr/bin/true",
    fixedArgs: [],
  })!;
}

test("git preflight accepts self-contained safe repository config", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-git-safe-"),
  );

  try {
    await writeGitConfig(
      root,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tfilemode = false",
        "\tbare = false",
        "\tlogallrefupdates = true",
        "\tignorecase = true",
        "[remote \"origin\"]",
        "\turl = https://github.com/owner/repo.git",
        "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        "[branch \"main\"]",
        "\tremote = origin",
        "\tmerge = refs/heads/main",
        "\tvscode-merge-base = origin/main",
        "",
      ].join("\n"),
    );

    const capability = testGitCapability();
    for (const args of [
      ["status", "--short"],
      ["fetch", "origin"],
      ["push", "--force", "origin", "main"],
    ] as const) {
      const prepared = capability.prepareProcess(
        args,
        { cwd: root },
      );
      assert.equal(
        prepared.ok,
        true,
        JSON.stringify(prepared),
      );
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("git preflight rejects executable repository-local config", async () => {
  const dangerous = [
    [
      "[credential]",
      "\thelper = !powershell -NoProfile -Command calc",
    ],
    [
      "[core]",
      "\tsshCommand = powershell -Command calc",
    ],
    [
      "[filter \"evil\"]",
      "\tprocess = powershell -Command calc",
    ],
    [
      "[include]",
      "\tpath = ../outside-config",
    ],
  ] as const;

  for (const lines of dangerous) {
    const root = await mkdtemp(
      join(tmpdir(), "junius-git-unsafe-"),
    );

    try {
      await writeGitConfig(
        root,
        [
          "[core]",
          "\trepositoryformatversion = 0",
          ...lines,
          "",
        ].join("\n"),
      );

      const prepared =
        testGitCapability().prepareProcess(
          ["status", "--short"],
          { cwd: root },
        );

      assert.equal(prepared.ok, false);
      if (!prepared.ok) {
        assert.equal(
          prepared.execution.code,
          "unsafe_repository_config",
        );
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  }
});

test("git preflight rejects repository metadata outside Workspace root", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-git-boundary-"),
  );
  const outside = await mkdtemp(
    join(tmpdir(), "junius-git-outside-"),
  );

  try {
    await writeGitConfig(
      outside,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "",
      ].join("\n"),
    );

    await symlink(
      join(outside, ".git"),
      join(root, ".git"),
      process.platform === "win32"
        ? "junction"
        : "dir",
    );

    const prepared =
      testGitCapability().prepareProcess(
        ["status", "--short"],
        { cwd: root },
      );
    assert.equal(prepared.ok, false);
    if (!prepared.ok) {
      assert.equal(
        prepared.execution.code,
        "unsafe_repository_config",
      );
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
    await rm(outside, {
      recursive: true,
      force: true,
    });
  }
});

test("git capability uses bounded Windows HTTPS transport settings", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-git-https-"),
  );
  const installRoot = join(root, "Git");
  const gitExecutable = join(
    installRoot,
    "cmd",
    "git.exe",
  );
  const credentialHelper = join(
    installRoot,
    "mingw64",
    "bin",
    "git-credential-manager.exe",
  );
  const repository = join(root, "repo");

  try {
    await mkdir(dirname(gitExecutable), {
      recursive: true,
    });
    await mkdir(dirname(credentialHelper), {
      recursive: true,
    });
    await Promise.all([
      writeFile(gitExecutable, "fake", "utf8"),
      writeFile(
        credentialHelper,
        "fake",
        "utf8",
      ),
    ]);
    await writeGitConfig(
      repository,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "[remote \"origin\"]",
        "\turl = https://github.com/example/repo.git",
        "",
      ].join("\n"),
    );

    const capability = createGitCapability(
      {
        executable: gitExecutable,
        fixedArgs: [],
      },
      {},
    )!;
    const prepared = capability.prepareProcess(
      ["push", "origin", "main"],
      { cwd: repository },
    );

    assert.equal(prepared.ok, true);
    if (prepared.ok && process.platform === "win32") {
      assert.equal(
        prepared.process.args.includes(
          "http.sslBackend=openssl",
        ),
        true,
      );
      assert.equal(
        prepared.process.args.includes(
          "credential.helper=" +
            credentialHelper.replaceAll(
              "\\",
              "/",
            ),
        ),
        true,
      );
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("git preflight rejects unsafe configured fetch and push URLs", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-git-remote-"),
  );

  try {
    await writeGitConfig(
      root,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "[remote \"origin\"]",
        "\turl = ext::powershell -Command calc",
        "",
      ].join("\n"),
    );

    const capability = testGitCapability();
    for (const args of [
      ["fetch", "origin"],
      ["push", "origin", "main"],
    ] as const) {
      const prepared = capability.prepareProcess(
        args,
        { cwd: root },
      );
      assert.equal(prepared.ok, false);
      if (!prepared.ok) {
        assert.equal(
          prepared.execution.code,
          "unsafe_repository_config",
        );
      }
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("git preflight does not borrow a parent repository", async () => {
  const parent = await mkdtemp(
    join(tmpdir(), "junius-git-parent-"),
  );
  const child = join(parent, "child");

  try {
    await writeGitConfig(
      parent,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "",
      ].join("\n"),
    );
    await mkdir(child, { recursive: true });

    const capability = testGitCapability();

    const status = capability.prepareProcess(
      ["status", "--short"],
      { cwd: child },
    );
    assert.equal(status.ok, false);

    const init = capability.prepareProcess(
      ["init", "-b", "main"],
      { cwd: child },
    );
    assert.equal(init.ok, true);
  } finally {
    await rm(parent, {
      recursive: true,
      force: true,
    });
  }
});

test("git capability inherits only global identity while local identity wins", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-git-identity-"),
  );
  const fakeGit = join(root, "fake-git.cjs");

  try {
    await writeFile(
      fakeGit,
      [
        "const args = process.argv.slice(2);",
        "if (args.join(' ') === 'config --global --get user.name') { process.stdout.write('Global User\\n'); process.exit(0); }",
        "if (args.join(' ') === 'config --global --get user.email') { process.stdout.write('global@example.com\\n'); process.exit(0); }",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeGitConfig(
      root,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "",
      ].join("\n"),
    );

    const capability = createGitCapability(
      {
        executable: process.execPath,
        fixedArgs: [fakeGit],
      },
      {
        ...process.env,
        GIT_CONFIG_GLOBAL: "attacker-config",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0:
          "!powershell -Command calc",
      },
    )!;

    const inherited =
      capability.prepareProcess(
        ["status", "--short"],
        { cwd: root },
      );
    assert.equal(inherited.ok, true);
    if (inherited.ok) {
      assert.equal(
        inherited.process.args.includes(
          "user.name=Global User",
        ),
        true,
      );
      assert.equal(
        inherited.process.args.includes(
          "user.email=global@example.com",
        ),
        true,
      );
      assert.equal(
        inherited.process.env.GIT_CONFIG_GLOBAL,
        process.platform === "win32"
          ? "NUL"
          : "/dev/null",
      );
      assert.equal(
        inherited.process.env.GIT_CONFIG_COUNT,
        undefined,
      );
    }

    await writeGitConfig(
      root,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "[user]",
        "\tname = Local User",
        "\temail = local@example.com",
        "",
      ].join("\n"),
    );

    const local =
      capability.prepareProcess(
        ["status", "--short"],
        { cwd: root },
      );
    assert.equal(local.ok, true);
    if (local.ok) {
      assert.equal(
        local.process.args.includes(
          "user.name=Local User",
        ),
        true,
      );
      assert.equal(
        local.process.args.includes(
          "user.email=local@example.com",
        ),
        true,
      );
      assert.equal(
        local.process.args.includes(
          "user.name=Global User",
        ),
        false,
      );
      assert.equal(
        local.process.args.includes(
          "user.email=global@example.com",
        ),
        false,
      );
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("git capability isolates system and global executable config", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-git-config-env-"),
  );

  try {
    await writeGitConfig(
      root,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "",
      ].join("\n"),
    );

    const capability = createGitCapability(
      {
        executable:
          process.platform === "win32"
            ? "C:\\Windows\\System32\\where.exe"
            : "/usr/bin/true",
        fixedArgs: [],
      },
      {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_CONFIG_GLOBAL: "attacker-config",
        GIT_ATTR_NOSYSTEM: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "!powershell -Command calc",
        GIT_SSH_COMMAND: "powershell -Command calc",
        GIT_EXTERNAL_DIFF: "powershell -Command calc",
        SSH_ASKPASS: "C:\\evil\\askpass.exe",
        SSH_ASKPASS_REQUIRE: "force",
        git_config_count: "1",
        git_config_key_0: "core.sshCommand",
        git_config_value_0: "powershell -Command calc",
        ssh_askpass: "C:\\evil\\lower-askpass.exe",
      },
    )!;

    const prepared = capability.prepareProcess(
      ["status", "--short"],
      { cwd: root },
    );

    assert.equal(prepared.ok, true);
    if (prepared.ok) {
      assert.equal(
        prepared.process.env.GIT_CONFIG_NOSYSTEM,
        "1",
      );
      assert.equal(
        prepared.process.env.GIT_CONFIG_GLOBAL,
        process.platform === "win32"
          ? "NUL"
          : "/dev/null",
      );
      assert.equal(
        prepared.process.env.GIT_ATTR_NOSYSTEM,
        "1",
      );
      assert.equal(
        prepared.process.env.GIT_TERMINAL_PROMPT,
        "0",
      );
      assert.equal(
        prepared.process.env.GIT_CONFIG_COUNT,
        undefined,
      );
      assert.equal(
        prepared.process.env.GIT_CONFIG_KEY_0,
        undefined,
      );
      assert.equal(
        prepared.process.env.GIT_CONFIG_VALUE_0,
        undefined,
      );
      assert.equal(
        prepared.process.env.GIT_SSH_COMMAND,
        undefined,
      );
      assert.equal(
        prepared.process.env.GIT_EXTERNAL_DIFF,
        undefined,
      );
      assert.equal(
        prepared.process.env.SSH_ASKPASS,
        undefined,
      );
      assert.equal(
        prepared.process.env.SSH_ASKPASS_REQUIRE,
        undefined,
      );
      assert.equal(
        prepared.process.env.git_config_count,
        undefined,
      );
      assert.equal(
        prepared.process.env.git_config_key_0,
        undefined,
      );
      assert.equal(
        prepared.process.env.git_config_value_0,
        undefined,
      );
      assert.equal(
        prepared.process.env.ssh_askpass,
        undefined,
      );
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("git launcher follows PATH order", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-git-"));
  const first = join(root, "first");
  const second = join(root, "second");

  try {
    const { mkdir } = await import("node:fs/promises");
    await Promise.all([
      mkdir(first, { recursive: true }),
      mkdir(second, { recursive: true }),
    ]);

    const fileName =
      process.platform === "win32"
        ? "git.exe"
        : "git";

    const firstExecutable = join(first, fileName);
    const secondExecutable = join(second, fileName);

    await writeFile(firstExecutable, "first", "utf8");
    await writeFile(secondExecutable, "second", "utf8");

    assert.deepEqual(
      resolveGitLauncher({
        PATH: [first, second].join(
          process.platform === "win32" ? ";" : ":",
        ),
      }),
      {
        executable: firstExecutable,
        fixedArgs: [],
      },
    );

    assert.deepEqual(
      resolveGitLauncher({
        PATH: [second, first].join(
          process.platform === "win32" ? ";" : ":",
        ),
      }),
      {
        executable: secondExecutable,
        fixedArgs: [],
      },
    );

    assert.equal(
      createGitCapability({
        executable: firstExecutable,
        fixedArgs: [],
      })?.key,
      "git",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
