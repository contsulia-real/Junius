import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceProfile } from "./workspace-profile.js";

test("WorkspaceProfile supports exact and prefix argument grants", () => {
  const profile = new WorkspaceProfile("C:\\workspace", [
    {
      key: "pnpm",
      arguments: [
        { mode: "exact", args: ["--version"] },
        { mode: "prefix", args: ["run", "check"] },
      ],
    },
  ]);

  assert.equal(profile.hasCapabilityGrant("pnpm"), true);
  assert.equal(profile.isInvocationAllowed("pnpm", ["--version"]), true);
  assert.equal(profile.isInvocationAllowed("pnpm", ["run", "check"]), true);
  assert.equal(
    profile.isInvocationAllowed("pnpm", [
      "run",
      "check",
      "--",
      "--fix",
    ]),
    true,
  );
  assert.equal(profile.isInvocationAllowed("pnpm", ["run", "build"]), false);
  assert.equal(profile.isInvocationAllowed("node", ["--version"]), false);
});

test("WorkspaceProfile returns copies of grants", () => {
  const profile = new WorkspaceProfile("C:\\workspace");
  profile.setGrant({
    key: "node",
    arguments: [{ mode: "exact", args: ["--version"] }],
  });

  const grants = profile.grants();
  assert.deepEqual(grants, [
    {
      key: "node",
      arguments: [
        {
          mode: "exact",
          args: ["--version"],
        },
      ],
    },
  ]);

  (grants[0]!.arguments[0]!.args as string[])
    .push("mutated");

  assert.deepEqual(profile.grants(), [
    {
      key: "node",
      arguments: [
        {
          mode: "exact",
          args: ["--version"],
        },
      ],
    },
  ]);
});
