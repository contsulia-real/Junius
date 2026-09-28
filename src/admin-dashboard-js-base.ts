export const ADMIN_DASHBOARD_JS_BASE = String.raw`
(function () {
  "use strict";

  var data = null;
  var currentView = "overview";
  var openWorkspaceSettings = Object.create(null);

  var titles = {
    overview: ["概览", "Junius 本地代理状态与管理"],
    workspaces: ["工作区", "项目根目录与工作区授权"],
    capabilities: ["能力", "机器级已注册能力"],
    jobs: ["后台任务", "后台进程生命周期"],
    activity: ["活动记录", "统一执行与配置审计"],
    browser: ["浏览器", "本地 playwright-cli 适配器"],
    desktop: ["桌面", "Windows Computer Use"]
  };

  var statusLabels = {
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
    available: "可用",
    unavailable: "不可用"
  };

  function statusLabel(status) {
    return statusLabels[status] || status;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showNotice(message, error) {
    var node = document.getElementById("notice");
    node.textContent = message;
    node.classList.remove("hidden", "error");
    if (error) node.classList.add("error");
    window.setTimeout(function () {
      node.classList.add("hidden");
    }, 4000);
  }

  async function api(path, options) {
    var requestOptions = Object.assign({}, options || {});
    var method = String(requestOptions.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      requestOptions.headers = Object.assign(
        {},
        requestOptions.headers || {},
        { "x-junius-admin-token": data && data.adminToken ? data.adminToken : "" }
      );
    }

    var response = await fetch(path, requestOptions);
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(body.error || body.message || ("HTTP " + response.status));
    }
    return body;
  }

  function setView(view) {
    currentView = view;
    document.querySelectorAll(".view").forEach(function (node) {
      node.classList.toggle("active", node.id === "view-" + view);
    });
    document.querySelectorAll(".nav-item").forEach(function (node) {
      node.classList.toggle("active", node.dataset.view === view);
    });
    document.getElementById("page-title").textContent = titles[view][0];
    document.getElementById("page-subtitle").textContent = titles[view][1];
  }

  function badge(status) {
    var cls = "warning";
    if (status === "succeeded" || status === "available") cls = "success";
    if (status === "failed" || status === "cancelled" || status === "unavailable") cls = "danger";
    return '<span class="badge ' + cls + '">' + esc(statusLabel(status)) + '</span>';
  }

`;
