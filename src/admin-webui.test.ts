import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import {
  ADMIN_DASHBOARD_CSS,
  ADMIN_DASHBOARD_HTML,
  ADMIN_DASHBOARD_JS,
} from "./admin-webui.js";

test("Dashboard assets contain the expected local WebUI shell", () => {
  assert.match(ADMIN_DASHBOARD_HTML, /Junius 控制台/u);
  assert.match(
    ADMIN_DASHBOARD_HTML,
    /rel="icon" href="data:,"/u,
  );
  assert.match(ADMIN_DASHBOARD_HTML, /C:\\Users\\\.\.\.\\Project/u);
  assert.match(ADMIN_DASHBOARD_CSS, /\.sidebar/u);
  assert.match(ADMIN_DASHBOARD_JS, /fetch\(path/u);
  assert.doesNotMatch(
    ADMIN_DASHBOARD_HTML,
    /data-view="permissions"/u,
  );
  assert.doesNotMatch(
    ADMIN_DASHBOARD_HTML,
    /id="view-permissions"/u,
  );
  assert.match(
    ADMIN_DASHBOARD_JS,
    /data-workspace-permission-form/u,
  );
  assert.match(
    ADMIN_DASHBOARD_JS,
    /仅允许这组参数/u,
  );
  assert.match(
    ADMIN_DASHBOARD_JS,
    /允许此前缀参数/u,
  );
  assert.match(
    ADMIN_DASHBOARD_HTML,
    /job-history-summary/u,
  );
  assert.match(
    ADMIN_DASHBOARD_JS,
    /无限保留（未启用自动清理）/u,
  );
});

test("Dashboard JavaScript is syntactically valid", () => {
  assert.doesNotThrow(() => new Script(ADMIN_DASHBOARD_JS));
});
