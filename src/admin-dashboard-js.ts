import { ADMIN_DASHBOARD_JS_ACTIONS } from "./admin-dashboard-js-actions.js";
import { ADMIN_DASHBOARD_JS_BASE } from "./admin-dashboard-js-base.js";
import { ADMIN_DASHBOARD_JS_CAPABILITY_EDITOR } from "./admin-dashboard-js-capability-editor.js";
import { ADMIN_DASHBOARD_JS_RENDER } from "./admin-dashboard-js-render.js";

export const ADMIN_DASHBOARD_JS =
  ADMIN_DASHBOARD_JS_BASE +
  ADMIN_DASHBOARD_JS_RENDER +
  ADMIN_DASHBOARD_JS_CAPABILITY_EDITOR +
  ADMIN_DASHBOARD_JS_ACTIONS;
