export const ADMIN_DASHBOARD_JS_RENDER_COMPUTER = String.raw`  function renderBrowser() {
    document.getElementById("browser-details").innerHTML =
      '<div class="detail"><div class="key">playwright-cli</div><div class="value">' +
      badge(data.browser.active ? "available" : "unavailable") + '</div></div>' +
      '<div class="detail"><div class="key">机器级开关</div><div class="value">' +
      (data.browser.enabled ? "已启用" : "已禁用") + '</div></div>' +
      '<div class="detail"><div class="key">运行状态目录</div><div class="value">' +
      esc(data.browser.statePath) + '</div></div>' +
      '<div class="detail"><div class="key">命令传输</div><div class="value">' +
      (data.browser.transport === "broker" ? "常驻 Broker" : "单次进程 fallback") + '</div></div>' +
      '<div class="detail"><div class="key">Broker 进程</div><div class="value">' +
      (data.browser.brokerRunning ? "常驻运行中" : (data.browser.transport === "broker" ? "待首次调用" : "未启用")) + '</div></div>' +
      '<div class="detail"><div class="key">活动 Session</div><div class="value">' +
      esc(data.browser.sessionCount || 0) + ' / ' + esc(data.browser.maxSessions || 0) + '</div></div>' +
      '<div class="detail"><div class="key">Session 空闲回收</div><div class="value">' +
      esc(data.browser.sessionIdleMs || 0) + ' ms</div></div>' +
      (data.browser.sessionCleanupError
        ? '<div class="detail"><div class="key">Session 清理错误</div><div class="value">' + esc(data.browser.sessionCleanupError) + '</div></div>'
        : '') +
      '<div class="detail"><div class="key">默认窗口模式</div><div class="value">可见窗口（headed）</div></div>' +
      '<div class="detail"><div class="key">默认 Profile 模式</div><div class="value">持久化（persistent）</div></div>';
  }

  function renderDesktop() {
    document.getElementById("desktop-details").innerHTML =
      '<div class="detail"><div class="key">Computer Use</div><div class="value">' +
      badge(data.desktop.active ? "available" : "unavailable") + '</div></div>' +
      '<div class="detail"><div class="key">机器级开关</div><div class="value">' +
      (data.desktop.enabled ? "已启用" : "已禁用") + '</div></div>' +
      '<div class="detail"><div class="key">Python</div><div class="value">' +
      esc(data.desktop.pythonExecutable || "未解析") + '</div></div>' +
      '<div class="detail"><div class="key">Helper</div><div class="value">' +
      esc(data.desktop.helperPath) + '</div></div>' +
      '<div class="detail"><div class="key">Helper 进程</div><div class="value">' +
      (data.desktop.helperReady ? "已预热" : (data.desktop.helperRunning ? "预热中" : "等待预热")) + '</div></div>' +
      '<div class="detail"><div class="key">控制路径</div><div class="value">Screenshot + Coordinate Mouse / Keyboard</div></div>';
  }

`;
