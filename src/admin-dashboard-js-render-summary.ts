export const ADMIN_DASHBOARD_JS_RENDER_SUMMARY = String.raw`  function renderSummary() {
    var running = data.jobs.filter(function (job) { return job.status === "running"; }).length;
    var cards = [
      [data.workspaces.length, "工作区"],
      [data.machineCapabilities.filter(function (capability) { return capability.active; }).length, "已激活机器能力"],
      [running, "运行中任务"],
      [data.browser.active ? "已启用" : (data.browser.available ? "已禁用" : "缺失"), "浏览器"],
      [data.desktop.active ? "已启用" : (data.desktop.available ? "已禁用" : "缺失"), "桌面"]
    ];
    document.getElementById("summary").innerHTML = cards.map(function (card) {
      return '<div class="summary-card"><div class="value">' + esc(card[0]) +
        '</div><div class="label">' + esc(card[1]) + '</div></div>';
    }).join("");

    document.getElementById("overview-details").innerHTML =
      '<div class="detail"><div class="key">管理地址</div><div class="value">' +
      esc(location.origin) + '</div></div>' +
      '<div class="detail"><div class="key">浏览器适配器</div><div class="value">' +
      badge(data.browser.active ? "available" : "unavailable") + '</div></div>' +
      '<div class="detail"><div class="key">浏览器状态目录</div><div class="value">' +
      esc(data.browser.statePath) + '</div></div>' +
      '<div class="detail"><div class="key">桌面 Computer Use</div><div class="value">' +
      badge(data.desktop.active ? "available" : "unavailable") + '</div></div>' +
      '<div class="detail"><div class="key">MCP 暴露范围</div><div class="value">管理 WebUI 仅限本机访问</div></div>';
  }

`;
