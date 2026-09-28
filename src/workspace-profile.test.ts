import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceProfile } from "./workspace-profile.js";

test(
  "WorkspaceProfile contains only the Workspace root",
  () => {
    const profile =
      new WorkspaceProfile(
        "C:\\workspace",
      );

    assert.equal(
      profile.rootPath,
      "C:\\workspace",
    );
    assert.deepEqual(
      Object.keys(profile),
      ["rootPath"],
    );
  },
);
