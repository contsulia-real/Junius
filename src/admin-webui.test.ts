import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import {
  ADMIN_DASHBOARD_CSS,
  ADMIN_DASHBOARD_HTML,
  ADMIN_DASHBOARD_JS,
} from "./admin-webui.js";

test("Dashboard assets contain the expected local WebUI shell", () => {
  assert.match(ADMIN_DASHBOARD_HTML, /Junius Dashboard/u);
  assert.match(ADMIN_DASHBOARD_HTML, /C:\\Users\\\.\.\.\\Project/u);
  assert.match(ADMIN_DASHBOARD_CSS, /\.sidebar/u);
  assert.match(ADMIN_DASHBOARD_JS, /fetch\(path/u);
});

test("Dashboard JavaScript is syntactically valid", () => {
  assert.doesNotThrow(() => new Script(ADMIN_DASHBOARD_JS));
});
