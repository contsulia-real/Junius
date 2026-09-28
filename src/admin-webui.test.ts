import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { ADMIN_DASHBOARD_JS } from "./admin-webui.js";

test("Dashboard JavaScript is syntactically valid", () => {
  assert.doesNotThrow(() => new Script(ADMIN_DASHBOARD_JS));
});
