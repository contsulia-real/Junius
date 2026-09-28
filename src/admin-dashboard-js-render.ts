import { ADMIN_DASHBOARD_JS_RENDER_SUMMARY } from "./admin-dashboard-js-render-summary.js";
import { ADMIN_DASHBOARD_JS_RENDER_WORKSPACES } from "./admin-dashboard-js-render-workspaces.js";
import { ADMIN_DASHBOARD_JS_RENDER_CAPABILITIES } from "./admin-dashboard-js-render-capabilities.js";
import { ADMIN_DASHBOARD_JS_RENDER_JOBS } from "./admin-dashboard-js-render-jobs.js";
import { ADMIN_DASHBOARD_JS_RENDER_AUDIT } from "./admin-dashboard-js-render-audit.js";
import { ADMIN_DASHBOARD_JS_RENDER_COMPUTER } from "./admin-dashboard-js-render-computer.js";
import { ADMIN_DASHBOARD_JS_RENDER_ROOT } from "./admin-dashboard-js-render-root.js";

export const ADMIN_DASHBOARD_JS_RENDER =
  ADMIN_DASHBOARD_JS_RENDER_SUMMARY +
  ADMIN_DASHBOARD_JS_RENDER_WORKSPACES +
  ADMIN_DASHBOARD_JS_RENDER_CAPABILITIES +
  ADMIN_DASHBOARD_JS_RENDER_JOBS +
  ADMIN_DASHBOARD_JS_RENDER_AUDIT +
  ADMIN_DASHBOARD_JS_RENDER_COMPUTER +
  ADMIN_DASHBOARD_JS_RENDER_ROOT;
