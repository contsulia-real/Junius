import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SkillError,
  SkillService,
} from "./skill-service.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";
import { WorkspaceRegistryService } from "./workspace-registry.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";
import { WorkspaceFilesService } from "./workspace-files.js";

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "junius-skill-"),
  );
  const workspaceRoot = join(root, "workspace");
  const globalRoot = join(root, "user", ".agents", "skills");
  await mkdir(workspaceRoot, { recursive: true });

  const manager = new WorkspaceManager([
    {
      id: "demo",
      profile: new WorkspaceProfile(workspaceRoot),
    },
  ]);
  const registry = new WorkspaceRegistryService(
    manager,
    new WorkspaceStateStore(join(root, "workspaces.json")),
  );
  const files = new WorkspaceFilesService(manager);
  const service = new SkillService(
    registry,
    files,
    {
      globalSkillsRoot: globalRoot,
    },
  );

  return {
    root,
    workspaceRoot,
    globalRoot,
    service,
    files,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body = "# Instructions\n",
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    [
      "---",
      "name: " + name,
      "description: " + description,
      "---",
      "",
      body,
    ].join("\n"),
    "utf8",
  );
}

test("workspace skills override global skills with the same name", async () => {
  const f = await fixture();
  try {
    await writeSkill(
      join(f.globalRoot, "shared"),
      "shared",
      "global version",
    );
    await writeSkill(
      join(f.workspaceRoot, ".agents", "skills", "shared"),
      "shared",
      "workspace version",
    );
    await writeSkill(
      join(f.globalRoot, "global-only"),
      "global-only",
      "only global",
    );

    const listed = await f.service.list("demo");
    const shared = listed.skills.filter(
      (skill) => skill.name === "shared",
    );
    assert.equal(shared.length, 2);
    assert.equal(
      shared.find((skill) => skill.scope === "workspace")?.effective,
      true,
    );
    assert.equal(
      shared.find((skill) => skill.scope === "global")?.effective,
      false,
    );

    const read = await f.service.read({
      workspace: "demo",
      name: "shared",
    });
    assert.equal(read.scope, "workspace");
    assert.match(read.content, /workspace version/u);
  } finally {
    await f.dispose();
  }
});

test("readSkill reads supporting text and rejects traversal", async () => {
  const f = await fixture();
  try {
    const skillRoot = join(f.globalRoot, "docs");
    await writeSkill(skillRoot, "docs", "docs skill");
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await writeFile(
      join(skillRoot, "references", "guide.md"),
      "guide\n",
      "utf8",
    );

    const supporting = await f.service.read({
      name: "docs",
      scope: "global",
      path: "references/guide.md",
    });
    assert.equal(supporting.content, "guide\n");

    await assert.rejects(
      f.service.read({
        name: "docs",
        scope: "global",
        path: "../outside.txt",
      }),
      (error: unknown) =>
        error instanceof SkillError &&
        error.code === "path_outside_skill",
    );
  } finally {
    await f.dispose();
  }
});

test("installSkill installs a local directory globally and into a workspace", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "source-skill");
    await writeSkill(source, "sample", "sample description");
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(
      join(source, "scripts", "check.ps1"),
      "Write-Output ok\n",
      "utf8",
    );

    const globalInstall = await f.service.install({
      source,
      scope: "global",
    });
    assert.equal(globalInstall.name, "sample");
    assert.equal(globalInstall.scope, "global");

    const workspaceInstall = await f.service.install({
      source,
      scope: "workspace",
      workspace: "demo",
    });
    assert.equal(workspaceInstall.scope, "workspace");
    assert.equal(
      await readFile(
        join(
          f.workspaceRoot,
          ".agents",
          "skills",
          "sample",
          "scripts",
          "check.ps1",
        ),
        "utf8",
      ),
      "Write-Output ok\n",
    );
  } finally {
    await f.dispose();
  }
});

test("installSkill refuses an existing target unless replace is explicit", async () => {
  const f = await fixture();
  try {
    const first = join(f.root, "first");
    const second = join(f.root, "second");
    await writeSkill(first, "sample", "first");
    await mkdir(join(first, "scripts"), { recursive: true });
    await writeFile(
      join(first, "scripts", "old.ps1"),
      "old\n",
      "utf8",
    );
    await writeSkill(second, "sample", "second");

    await f.service.install({
      source: first,
      scope: "global",
    });

    await assert.rejects(
      f.service.install({
        source: second,
        scope: "global",
      }),
      (error: unknown) =>
        error instanceof SkillError &&
        error.code === "skill_already_exists",
    );

    await f.service.install({
      source: second,
      scope: "global",
      replace: true,
    });

    const read = await f.service.read({
      name: "sample",
      scope: "global",
    });
    assert.match(read.content, /description: second/u);
    await assert.rejects(
      readFile(
        join(
          f.globalRoot,
          "sample",
          "scripts",
          "old.ps1",
        ),
        "utf8",
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT",
    );
  } finally {
    await f.dispose();
  }
});

test("removeSkill uses explicit scope and reveals the shadowed global skill", async () => {
  const f = await fixture();
  try {
    await writeSkill(
      join(f.globalRoot, "shared"),
      "shared",
      "global",
    );
    await writeSkill(
      join(f.workspaceRoot, ".agents", "skills", "shared"),
      "shared",
      "workspace",
    );

    const removed = await f.service.remove({
      name: "shared",
      scope: "workspace",
      workspace: "demo",
    });

    assert.equal(removed.removed.scope, "workspace");
    assert.equal(removed.effectiveAfter?.scope, "global");
    assert.equal(
      (
        await f.service.read({
          workspace: "demo",
          name: "shared",
        })
      ).scope,
      "global",
    );
  } finally {
    await f.dispose();
  }
});

test("installSkill accepts a local zip archive", async () => {
  const f = await fixture();
  try {
    const archiveSource = join(f.root, "zip-source");
    const archive = join(f.root, "skill.zip");
    await writeSkill(
      join(archiveSource, "zip-skill"),
      "zip-skill",
      "from zip",
    );
    execFileSync(
      "tar.exe",
      [
        "-a",
        "-cf",
        archive,
        "-C",
        archiveSource,
        ".",
      ],
      { windowsHide: true },
    );

    const installed = await f.service.install({
      source: archive,
      scope: "global",
    });

    assert.equal(installed.name, "zip-skill");
    assert.match(
      (
        await f.service.read({
          name: "zip-skill",
          scope: "global",
        })
      ).content,
      /from zip/u,
    );
  } finally {
    await f.dispose();
  }
});

test("workspace skill installation requires the current AGENTS digest", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.workspaceRoot, "AGENTS.md"),
      "# Workspace instructions\n",
      "utf8",
    );
    const source = join(f.root, "gated-source");
    await writeSkill(source, "gated", "gated skill");

    await assert.rejects(
      f.service.install({
        source,
        scope: "workspace",
        workspace: "demo",
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "agents_ack_required",
    );

    assert.equal(
      (await f.service.list("demo")).skills.some(
        (skill) => skill.name === "gated",
      ),
      false,
    );

    const instructions =
      await f.files.agentInstructionsForPaths(
        "demo",
        [".agents/skills/gated/SKILL.md"],
      );

    const installed = await f.service.install({
      source,
      scope: "workspace",
      workspace: "demo",
      agentsDigest: instructions.digest,
    });
    await writeFile(
      join(f.workspaceRoot, "AGENTS.md"),
      "# Updated workspace instructions\n",
      "utf8",
    );

    await assert.rejects(
      f.service.remove({
        name: "gated",
        scope: "workspace",
        workspace: "demo",
        agentsDigest: instructions.digest,
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "agents_ack_required",
    );
    assert.equal(
      (await f.service.read({
        workspace: "demo",
        name: "gated",
      })).scope,
      "workspace",
    );

    const updatedInstructions =
      await f.files.agentInstructionsForPaths(
        "demo",
        [".agents/skills/gated/SKILL.md"],
      );
    const removed = await f.service.remove({
      name: "gated",
      scope: "workspace",
      workspace: "demo",
      agentsDigest: updatedInstructions.digest,
    });
    assert.equal(removed.removed.scope, "workspace");
    assert.equal(installed.name, "gated");
  } finally {
    await f.dispose();
  }
});

test("installSkill accepts a remote HTTP archive", async () => {
  const f = await fixture();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const archiveSource = join(f.root, "archive-source");
    const archive = join(f.root, "remote.tar");
    await writeSkill(
      join(archiveSource, "remote"),
      "remote",
      "from http",
    );
    execFileSync(
      "tar.exe",
      [
        "-cf",
        archive,
        "-C",
        archiveSource,
        ".",
      ],
      { windowsHide: true },
    );

    const bytes = await readFile(archive);
    server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/x-tar",
        "content-length": String(bytes.length),
      });
      response.end(bytes);
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const installed = await f.service.install({
      source: `http://127.0.0.1:${address.port}/skill.tar`,
      scope: "global",
    });

    assert.equal(installed.name, "remote");
    assert.match(
      (
        await f.service.read({
          name: "remote",
          scope: "global",
        })
      ).content,
      /from http/u,
    );
  } finally {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await f.dispose();
  }
});

test("installSkill accepts a GitHub tree URL directly from Chat", async () => {
  const f = await fixture();
  try {
    const archiveSource = join(f.root, "github-source");
    const archive = join(f.root, "github.tar");
    await writeSkill(
      join(archiveSource, "owner-repo-deadbeef", "skills", "demo"),
      "github-demo",
      "from github",
    );
    execFileSync(
      "tar.exe",
      ["-cf", archive, "-C", archiveSource, "."],
      { windowsHide: true },
    );
    const archiveBytes = await readFile(archive);

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return new Response(
          JSON.stringify({ default_branch: "main" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "https://api.github.com/repos/owner/repo/commits/main") {
        return new Response(
          JSON.stringify({ sha: "deadbeef" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (
        url ===
        "https://api.github.com/repos/owner/repo/tarball/main"
      ) {
        return new Response(archiveBytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const service = new SkillService(
      new WorkspaceRegistryService(
        new WorkspaceManager([
          {
            id: "demo",
            profile: new WorkspaceProfile(f.workspaceRoot),
          },
        ]),
        new WorkspaceStateStore(join(f.root, "other-workspaces.json")),
      ),
      new WorkspaceFilesService(
        new WorkspaceManager([
          {
            id: "demo",
            profile: new WorkspaceProfile(f.workspaceRoot),
          },
        ]),
      ),
      {
        globalSkillsRoot: f.globalRoot,
        fetchImpl,
      },
    );

    const installed = await service.install({
      source: "https://github.com/owner/repo/tree/main/skills/demo",
      scope: "global",
    });
    assert.equal(installed.name, "github-demo");
    await service.remove({
      name: "github-demo",
      scope: "global",
    });
    const installedFromRepositoryRoot =
      await service.install({
        source: "https://github.com/owner/repo",
        scope: "global",
      });
    assert.equal(
      installedFromRepositoryRoot.name,
      "github-demo",
    );
  } finally {
    await f.dispose();
  }
});

test("installSkill reports multiple candidates instead of guessing", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "many");
    await writeSkill(join(source, "one"), "one", "one");
    await writeSkill(join(source, "two"), "two", "two");

    await assert.rejects(
      f.service.install({
        source,
        scope: "global",
      }),
      (error: unknown) =>
        error instanceof SkillError &&
        error.code === "multiple_skills_found" &&
        Array.isArray(error.details?.candidates),
    );
  } finally {
    await f.dispose();
  }
});
