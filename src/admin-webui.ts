export const ADMIN_DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Junius 控制台</title>
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">J</div>
        <div>
          <strong>Junius</strong>
          <span>本地代理</span>
        </div>
      </div>
      <nav>
        <button data-view="overview" class="nav-item active">概览</button>
        <button data-view="workspaces" class="nav-item">工作区</button>
        <button data-view="capabilities" class="nav-item">能力</button>
        <button data-view="jobs" class="nav-item">后台任务</button>
        <button data-view="browser" class="nav-item">浏览器</button>
      </nav>
      <div class="local-only">仅本机 · 127.0.0.1</div>
    </aside>

    <main>
      <header class="topbar">
        <div>
          <h1 id="page-title">概览</h1>
          <p id="page-subtitle">Junius 本地代理状态与管理</p>
        </div>
        <button id="refresh" class="button secondary">刷新</button>
      </header>

      <div id="notice" class="notice hidden"></div>

      <section id="view-overview" class="view active">
        <div id="summary" class="summary-grid"></div>
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>当前状态</h2>
              <p>Junius 本地管理服务当前暴露的运行状态。</p>
            </div>
          </div>
          <div id="overview-details" class="detail-grid"></div>
        </div>
      </section>

      <section id="view-workspaces" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>工作区</h2>
              <p>管理本地项目根目录，以及每个工作区自己的能力授权。</p>
            </div>
          </div>
          <form id="workspace-form" class="form-row">
            <label>
              <span>ID</span>
              <input id="workspace-id" required maxlength="64" placeholder="weave">
            </label>
            <label class="grow">
              <span>根目录</span>
              <input id="workspace-root" required placeholder="C:\\Users\\...\\Project">
            </label>
            <button class="button" type="submit">添加工作区</button>
          </form>
          <div id="workspace-list" class="stack"></div>
        </div>
      </section>

      <section id="view-capabilities" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>能力</h2>
              <p>管理 Junius 已知的机器级能力、启用状态与运行元数据。</p>
            </div>
          </div>
          <div id="capability-list" class="stack"></div>
        </div>
      </section>

      <section id="view-jobs" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>后台任务</h2>
              <p>由 Junius 当前进程管理的后台任务。</p>
            </div>
          </div>
          <div id="job-list" class="stack"></div>
        </div>
        <div id="job-output-panel" class="panel hidden">
          <div class="panel-heading">
            <div>
              <h2 id="job-output-title">任务输出</h2>
              <p>捕获的标准输出和标准错误。</p>
            </div>
            <button id="close-output" class="button secondary">关闭</button>
          </div>
          <div class="output-grid">
            <div>
              <h3>stdout</h3>
              <pre id="job-stdout"></pre>
            </div>
            <div>
              <h3>stderr</h3>
              <pre id="job-stderr"></pre>
            </div>
          </div>
        </div>
      </section>

      <section id="view-browser" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>浏览器</h2>
              <p>本地 playwright-cli 适配器状态。</p>
            </div>
          </div>
          <div id="browser-details" class="detail-grid"></div>
        </div>
      </section>
    </main>
  </div>
  <script src="/dashboard.js" defer></script>
</body>
</html>`;

export const ADMIN_DASHBOARD_CSS = `
:root {
  color-scheme: light dark;
  --bg: #0f1115;
  --sidebar: #151821;
  --panel: #181c25;
  --panel-2: #202531;
  --border: #2a3140;
  --text: #f3f5f7;
  --muted: #9da7b5;
  --accent: #7ea2ff;
  --danger: #ff7272;
  --success: #6ed6a0;
  --warning: #f2c66d;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); min-height: 100vh; }
button, input, select { font: inherit; }
.shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; }
.sidebar { background: var(--sidebar); border-right: 1px solid var(--border); padding: 24px 16px; display: flex; flex-direction: column; gap: 28px; }
.brand { display: flex; align-items: center; gap: 12px; padding: 0 8px; }
.brand-mark { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 11px; background: var(--accent); color: #10131a; font-weight: 800; }
.brand strong, .brand span { display: block; }
.brand span { color: var(--muted); font-size: 12px; margin-top: 2px; }
nav { display: grid; gap: 6px; }
.nav-item { border: 0; background: transparent; color: var(--muted); text-align: left; padding: 10px 12px; border-radius: 9px; cursor: pointer; }
.nav-item:hover, .nav-item.active { background: var(--panel-2); color: var(--text); }
.local-only { margin-top: auto; color: var(--muted); font-size: 12px; padding: 0 8px; }
main { padding: 28px 34px 48px; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 4px; font-size: 28px; }
h2 { margin-bottom: 5px; font-size: 18px; }
h3 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.topbar p, .panel-heading p { color: var(--muted); margin-bottom: 0; }
.view { display: none; }
.view.active { display: block; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 14px; margin-bottom: 18px; }
.summary-card, .panel, .item { border: 1px solid var(--border); background: var(--panel); border-radius: 13px; }
.summary-card { padding: 18px; }
.summary-card .value { font-size: 28px; font-weight: 700; }
.summary-card .label { color: var(--muted); font-size: 13px; margin-top: 6px; }
.panel { padding: 20px; margin-bottom: 18px; }
.panel-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 18px; }
.stack { display: grid; gap: 10px; }
.item { padding: 14px 16px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; background: var(--panel-2); }
.item-main { min-width: 0; }
.item-title { font-weight: 650; overflow-wrap: anywhere; }
.item-meta { color: var(--muted); font-size: 13px; margin-top: 5px; overflow-wrap: anywhere; }
.item-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.workspace-card { display: block; padding: 0; overflow: hidden; }
.workspace-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px; }
.workspace-settings { border-top: 1px solid var(--border); padding: 16px; background: #151a22; }
.workspace-settings h3 { margin-bottom: 10px; color: var(--text); text-transform: none; letter-spacing: 0; font-size: 14px; }
.workspace-settings-copy { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
.grant-list { display: grid; gap: 10px; margin-bottom: 16px; }
.grant-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--panel-2); }
.grant-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.grant-title { font-weight: 650; }
.grant-status { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.rule-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.rule-copy { min-width: 0; }
.rule-label { color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.rule-command { display: inline-block; max-width: 100%; overflow-wrap: anywhere; background: #11151c; border-radius: 7px; padding: 6px 8px; }
.workspace-permission-form { margin-top: 4px; }
.button { border: 1px solid transparent; border-radius: 9px; padding: 9px 12px; background: var(--accent); color: #10131a; cursor: pointer; font-weight: 650; white-space: nowrap; }
.button.secondary { color: var(--text); background: var(--panel-2); border-color: var(--border); }
.button.danger { color: #fff; background: #792f38; border-color: #9c3d48; }
.button:disabled { opacity: .45; cursor: not-allowed; }
.form-row { display: flex; gap: 10px; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; }
.form-row label { display: grid; gap: 6px; min-width: 140px; }
.form-row label.grow { flex: 1; min-width: 240px; }
label span { color: var(--muted); font-size: 12px; }
input, select { width: 100%; border: 1px solid var(--border); border-radius: 9px; padding: 9px 10px; background: #11151c; color: var(--text); outline: none; }
input:focus, select:focus { border-color: var(--accent); }
.hint { color: var(--muted); font-size: 12px; margin: -8px 0 16px; }
.detail-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
.detail { padding: 14px; border-radius: 10px; background: var(--panel-2); }
.detail .key { color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.detail .value { overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; font-size: 12px; background: #2a3140; }
.badge.success { color: var(--success); }
.badge.warning { color: var(--warning); }
.badge.danger { color: var(--danger); }
.rule { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.rule code { color: var(--text); background: #11151c; border-radius: 7px; padding: 5px 7px; overflow-wrap: anywhere; }
.notice { padding: 11px 13px; border-radius: 9px; margin-bottom: 16px; background: #26334d; color: #cbd8ff; }
.notice.error { background: #4d252b; color: #ffc5c5; }
.hidden { display: none !important; }
.output-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
pre { min-height: 180px; max-height: 460px; overflow: auto; white-space: pre-wrap; background: #0c0f14; border: 1px solid var(--border); border-radius: 10px; padding: 12px; color: #d9e1ea; }
.empty { color: var(--muted); padding: 18px 2px; }
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar { position: static; padding: 14px; gap: 14px; }
  .brand, .local-only { display: none; }
  nav { display: flex; overflow-x: auto; }
  .nav-item { white-space: nowrap; }
  main { padding: 20px 16px 36px; }
  .summary-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .detail-grid, .output-grid { grid-template-columns: 1fr; }
}
`;

export const ADMIN_DASHBOARD_JS = String.raw`
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
    browser: ["浏览器", "本地 playwright-cli 适配器"]
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
    var response = await fetch(path, options || {});
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

  function renderSummary() {
    var running = data.jobs.filter(function (job) { return job.status === "running"; }).length;
    var cards = [
      [data.workspaces.length, "工作区"],
      [data.machineCapabilities.filter(function (capability) { return capability.active; }).length, "已激活机器能力"],
      [running, "运行中任务"],
      [data.browser.available ? "就绪" : "缺失", "浏览器"]
    ];
    document.getElementById("summary").innerHTML = cards.map(function (card) {
      return '<div class="summary-card"><div class="value">' + esc(card[0]) +
        '</div><div class="label">' + esc(card[1]) + '</div></div>';
    }).join("");

    document.getElementById("overview-details").innerHTML =
      '<div class="detail"><div class="key">管理地址</div><div class="value">' +
      esc(location.origin) + '</div></div>' +
      '<div class="detail"><div class="key">浏览器适配器</div><div class="value">' +
      badge(data.browser.available ? "available" : "unavailable") + '</div></div>' +
      '<div class="detail"><div class="key">浏览器状态目录</div><div class="value">' +
      esc(data.browser.statePath) + '</div></div>' +
      '<div class="detail"><div class="key">MCP 暴露范围</div><div class="value">管理 WebUI 仅限本机访问</div></div>';
  }

  function formatArgument(arg) {
    if (arg === "") return '""';
    return /\s|["\\]/.test(arg) ? JSON.stringify(arg) : arg;
  }

  function rulePresentation(capabilityKey, rule) {
    var args = rule.args.map(formatArgument);
    var command = [capabilityKey].concat(args).join(" ");
    if (rule.mode === "prefix") {
      command += " …";
    }

    return {
      label: rule.mode === "exact"
        ? "仅允许这组参数"
        : "允许此前缀参数",
      command: command
    };
  }

  function machineCapabilityFor(key) {
    return (data.machineCapabilities || []).find(function (capability) {
      return capability.key === key;
    });
  }

  function grantStatusHtml(key) {
    var capability = machineCapabilityFor(key);
    if (!capability) {
      return '<span class="badge warning">未知机器能力</span>';
    }

    var parts = [];
    if (!capability.enabled) {
      parts.push('<span class="badge danger">机器级已禁用</span>');
    } else if (!capability.available) {
      parts.push('<span class="badge danger">当前不可用</span>');
    } else if (capability.active) {
      parts.push('<span class="badge success">当前可执行</span>');
    } else {
      parts.push('<span class="badge warning">当前未激活</span>');
    }
    return parts.join(" ");
  }

  function capabilityOptions() {
    return data.registeredCapabilities.map(function (capability) {
      return '<option value="' + esc(capability.key) + '">' +
        esc(capability.key) + '</option>';
    }).join("");
  }

  function renderWorkspaceGrants(workspace) {
    if (workspace.grants.length === 0) {
      return '<div class="empty">尚未给这个工作区授权任何进程能力。</div>';
    }

    return '<div class="grant-list">' + workspace.grants.map(function (grant) {
      var rules = grant.arguments.map(function (rule, index) {
        var presentation = rulePresentation(grant.key, rule);
        return '<div class="rule-row">' +
          '<div class="rule-copy">' +
            '<div class="rule-label">' + esc(presentation.label) +
              ' <span class="badge">' + esc(rule.mode) + '</span></div>' +
            '<code class="rule-command">' + esc(presentation.command) + '</code>' +
          '</div>' +
          '<button class="button secondary" data-remove-rule="' + esc(workspace.id) +
            '" data-capability="' + esc(grant.key) +
            '" data-rule-index="' + index + '">删除规则</button>' +
        '</div>';
      }).join("");

      return '<div class="grant-card">' +
        '<div class="grant-header">' +
          '<div>' +
            '<div class="grant-title">' + esc(grant.key) + '</div>' +
            '<div class="grant-status">' + grantStatusHtml(grant.key) + '</div>' +
          '</div>' +
          '<button class="button danger" data-revoke="' + esc(workspace.id) +
            '" data-capability="' + esc(grant.key) + '">撤销此能力</button>' +
        '</div>' +
        rules +
      '</div>';
    }).join("") + '</div>';
  }

  function renderWorkspacePermissionForm(workspace) {
    var options = capabilityOptions();
    if (!options) {
      return '<div class="empty">当前没有可授权的已激活机器能力。</div>';
    }

    return '<form class="form-row workspace-permission-form" data-workspace-permission-form="' +
      esc(workspace.id) + '">' +
      '<label><span>能力</span><select name="capability">' + options + '</select></label>' +
      '<label><span>允许范围</span><select name="mode">' +
        '<option value="exact">仅允许这组参数</option>' +
        '<option value="prefix">允许此前缀参数</option>' +
      '</select></label>' +
      '<label class="grow"><span>参数</span>' +
        '<input name="args" placeholder="例如：run check">' +
      '</label>' +
      '<button class="button" type="submit">添加授权</button>' +
    '</form>' +
    '<p class="hint">参数输入支持引号分组；界面展示成命令形式便于阅读，底层仍保存参数向量，不会执行原始 Shell 字符串。</p>';
  }

  function renderWorkspaces() {
    var node = document.getElementById("workspace-list");
    if (data.workspaces.length === 0) {
      node.innerHTML = '<div class="empty">尚未注册工作区。</div>';
      return;
    }

    node.innerHTML = data.workspaces.map(function (workspace) {
      var isOpen = openWorkspaceSettings[workspace.id] === true;
      return '<div class="item workspace-card">' +
        '<div class="workspace-header">' +
          '<div class="item-main">' +
            '<div class="item-title">' + esc(workspace.id) + '</div>' +
            '<div class="item-meta">' + esc(workspace.rootPath) + '</div>' +
            '<div class="item-meta">' + workspace.grants.length + ' 项能力授权</div>' +
          '</div>' +
          '<div class="item-actions">' +
            '<button class="button secondary" data-workspace-settings="' +
              esc(workspace.id) + '">' + (isOpen ? '收起设置' : '设置') + '</button>' +
            '<button class="button danger" data-remove-workspace="' +
              esc(workspace.id) + '">删除工作区</button>' +
          '</div>' +
        '</div>' +
        '<div class="workspace-settings ' + (isOpen ? '' : 'hidden') + '">' +
          '<h3>能力授权</h3>' +
          '<p class="workspace-settings-copy">这些授权只属于工作区 ' +
            esc(workspace.id) + '。机器级能力必须同时处于可用和启用状态，授权才会生效。</p>' +
          renderWorkspaceGrants(workspace) +
          '<h3>添加授权</h3>' +
          renderWorkspacePermissionForm(workspace) +
        '</div>' +
      '</div>';
    }).join("");
  }

  function renderCapabilities() {
    var node = document.getElementById("capability-list");
    if (!data.machineCapabilities || data.machineCapabilities.length === 0) {
      node.innerHTML = '<div class="empty">尚无可管理的机器级能力。</div>';
      return;
    }

    node.innerHTML = data.machineCapabilities.map(function (capability) {
      var launcher = capability.launcher
        ? [capability.launcher.executable].concat(capability.launcher.fixedArgs || []).join(" ")
        : "未解析";
      var policy = (capability.policy || []).map(function (rule) {
        return '<code>' + esc(rule) + '</code>';
      }).join(" ");
      var users = data.workspaces
        .filter(function (workspace) {
          return workspace.grants.some(function (grant) {
            return grant.key === capability.key;
          });
        })
        .map(function (workspace) { return workspace.id; });

      return '<div class="item"><div class="item-main">' +
        '<div class="item-title">' + esc(capability.key) + '</div>' +
        '<div class="item-meta">' + esc(capability.description) + '</div>' +
        '<div class="item-meta">状态：' +
        (capability.enabled ? '<span class="badge success">已启用</span>' : '<span class="badge danger">已禁用</span>') +
        ' ' + (capability.available ? '<span class="badge success">可用</span>' : '<span class="badge danger">不可用</span>') +
        ' ' + (capability.active ? '<span class="badge success">已激活</span>' : '<span class="badge">未激活</span>') +
        '</div>' +
        '<div class="item-meta">启动器：' + esc(launcher) + '</div>' +
        '<div class="item-meta">机器策略：<span class="rule">' + (policy || '<code>无</code>') + '</span></div>' +
        '<div class="item-meta">工作区授权：' + esc(users.length ? users.join(", ") : "无") + '</div>' +
        '</div><div class="item-actions">' +
        '<button class="button ' + (capability.enabled ? 'danger' : '') +
        '" data-toggle-capability="' + esc(capability.key) +
        '" data-enabled="' + String(capability.enabled) + '">' +
        (capability.enabled ? '禁用' : '启用') +
        '</button></div></div>';
    }).join("");
  }

  function renderJobs() {
    var node = document.getElementById("job-list");
    if (data.jobs.length === 0) {
      node.innerHTML = '<div class="empty">当前 Junius 进程中没有后台任务。</div>';
      return;
    }

    node.innerHTML = data.jobs.map(function (job) {
      var actions = '<button class="button secondary" data-view-job="' + esc(job.id) + '">查看输出</button>';
      if (job.status === "running") {
        actions += '<button class="button danger" data-cancel-job="' + esc(job.id) + '">取消</button>';
      }

      return '<div class="item"><div class="item-main">' +
        '<div class="item-title">' + esc(job.key) + ' · ' + esc(job.workspace) + '</div>' +
        '<div class="item-meta">' + esc(job.id) + '</div>' +
        '<div class="item-meta">开始时间：' + esc(job.startedAt) +
        (job.exitCode === undefined ? "" : " · 退出码 " + esc(job.exitCode)) + '</div>' +
        '</div><div class="item-actions">' + badge(job.status) + actions + '</div></div>';
    }).join("");
  }

  function renderBrowser() {
    document.getElementById("browser-details").innerHTML =
      '<div class="detail"><div class="key">playwright-cli</div><div class="value">' +
      badge(data.browser.available ? "available" : "unavailable") + '</div></div>' +
      '<div class="detail"><div class="key">运行状态目录</div><div class="value">' +
      esc(data.browser.statePath) + '</div></div>' +
      '<div class="detail"><div class="key">默认窗口模式</div><div class="value">可见窗口（headed）</div></div>' +
      '<div class="detail"><div class="key">默认 Profile 模式</div><div class="value">持久化（persistent）</div></div>';
  }

  function render() {
    renderSummary();
    renderWorkspaces();
    renderCapabilities();
    renderJobs();
    renderBrowser();
  }

  async function refresh() {
    data = await api("/state");
    render();
  }

  function parseArgs(text) {
    var result = [];
    var current = "";
    var quote = null;
    var escaped = false;

    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (quote !== null) {
        if (ch === quote) {
          quote = null;
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) {
        if (current.length) {
          result.push(current);
          current = "";
        }
        continue;
      }
      current += ch;
    }

    if (quote !== null) throw new Error("参数中存在未闭合的引号。");
    if (escaped) current += "\\";
    if (current.length) result.push(current);
    return result;
  }

  function workspaceById(id) {
    return data.workspaces.find(function (workspace) { return workspace.id === id; });
  }

  async function addPermissionRule(form) {
    var workspaceId = form.dataset.workspacePermissionForm;
    var key = form.elements.capability.value;
    var mode = form.elements.mode.value;
    var args = parseArgs(form.elements.args.value);

    if (!workspaceId || !key) {
      throw new Error("必须选择工作区和能力。");
    }
    if (mode === "prefix" && args.length === 0) {
      throw new Error("“允许此前缀参数”至少需要一个参数。");
    }

    var workspace = workspaceById(workspaceId);
    var existing = workspace.grants.find(function (grant) {
      return grant.key === key;
    });
    var rules = existing ? existing.arguments.slice() : [];
    rules.push({ mode: mode, args: args });

    await api(
      "/workspaces/" + encodeURIComponent(workspaceId) +
      "/grants/" + encodeURIComponent(key),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: rules })
      }
    );

    openWorkspaceSettings[workspaceId] = true;
    form.elements.args.value = "";
    await refresh();
    showNotice("工作区授权已添加。");
  }

  async function removePermissionRule(workspaceId, key, index) {
    var workspace = workspaceById(workspaceId);
    var grant = workspace.grants.find(function (item) { return item.key === key; });
    if (!grant) return;

    var rules = grant.arguments.filter(function (_, ruleIndex) { return ruleIndex !== index; });
    var path = "/workspaces/" + encodeURIComponent(workspaceId) + "/grants/" + encodeURIComponent(key);

    if (rules.length === 0) {
      await api(path, { method: "DELETE" });
    } else {
      await api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: rules })
      });
    }

    openWorkspaceSettings[workspaceId] = true;
    await refresh();
    showNotice("工作区授权规则已删除。");
  }

  async function loadJobOutput(id) {
    var stdout = await api("/jobs/" + encodeURIComponent(id) + "/output?stream=stdout");
    var stderr = await api("/jobs/" + encodeURIComponent(id) + "/output?stream=stderr");
    document.getElementById("job-output-title").textContent = "任务输出 · " + id;
    document.getElementById("job-stdout").textContent = stdout.output.content || "";
    document.getElementById("job-stderr").textContent = stderr.output.content || "";
    document.getElementById("job-output-panel").classList.remove("hidden");
  }

  document.querySelectorAll(".nav-item").forEach(function (node) {
    node.addEventListener("click", function () { setView(node.dataset.view); });
  });

  document.getElementById("refresh").addEventListener("click", function () {
    refresh().then(function () { showNotice("状态已刷新。"); }).catch(function (error) { showNotice(error.message, true); });
  });

  document.getElementById("workspace-form").addEventListener("submit", function (event) {
    event.preventDefault();
    api("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: document.getElementById("workspace-id").value,
        rootPath: document.getElementById("workspace-root").value
      })
    }).then(function () {
      event.target.reset();
      return refresh();
    }).then(function () {
      showNotice("工作区已添加。");
    }).catch(function (error) {
      showNotice(error.message, true);
    });
  });

  document.addEventListener("submit", function (event) {
    var form = event.target.closest("[data-workspace-permission-form]");
    if (!form) return;

    event.preventDefault();
    addPermissionRule(form).catch(function (error) {
      showNotice(error.message, true);
    });
  });

  document.getElementById("close-output").addEventListener("click", function () {
    document.getElementById("job-output-panel").classList.add("hidden");
  });

  document.addEventListener("click", function (event) {
    var target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.workspaceSettings) {
      var workspaceId = target.dataset.workspaceSettings;
      openWorkspaceSettings[workspaceId] =
        openWorkspaceSettings[workspaceId] !== true;
      renderWorkspaces();
      return;
    }

    if (target.dataset.toggleCapability) {
      var key = target.dataset.toggleCapability;
      var currentlyEnabled = target.dataset.enabled === "true";
      var nextEnabled = !currentlyEnabled;

      if (
        currentlyEnabled &&
        !confirm("确定禁用机器级能力 " + key + " 吗？已有工作区授权会保留，但该能力将无法执行。")
      ) {
        return;
      }

      api("/capabilities/" + encodeURIComponent(key), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled })
      })
        .then(refresh)
        .then(function () {
          showNotice("机器级能力 " + key + (nextEnabled ? " 已启用。" : " 已禁用。"));
        })
        .catch(function (error) { showNotice(error.message, true); });
      return;
    }

    if (target.dataset.removeWorkspace) {
      if (!confirm("确定删除工作区 " + target.dataset.removeWorkspace + " 吗？")) return;
      api("/workspaces/" + encodeURIComponent(target.dataset.removeWorkspace), { method: "DELETE" })
        .then(refresh)
        .then(function () { showNotice("工作区已删除。"); })
        .catch(function (error) { showNotice(error.message, true); });
      return;
    }

    if (target.dataset.revoke) {
      if (!confirm("确定撤销工作区 " + target.dataset.revoke + " 的 " + target.dataset.capability + " 能力授权吗？")) return;
      api("/workspaces/" + encodeURIComponent(target.dataset.revoke) + "/grants/" + encodeURIComponent(target.dataset.capability), { method: "DELETE" })
        .then(function () {
          openWorkspaceSettings[target.dataset.revoke] = true;
          return refresh();
        })
        .then(function () { showNotice("工作区能力授权已撤销。"); })
        .catch(function (error) { showNotice(error.message, true); });
      return;
    }

    if (target.dataset.removeRule) {
      removePermissionRule(
        target.dataset.removeRule,
        target.dataset.capability,
        Number(target.dataset.ruleIndex)
      ).catch(function (error) { showNotice(error.message, true); });
      return;
    }

    if (target.dataset.cancelJob) {
      api("/jobs/" + encodeURIComponent(target.dataset.cancelJob) + "/cancel", { method: "POST" })
        .then(refresh)
        .then(function () { showNotice("已请求取消后台任务。"); })
        .catch(function (error) { showNotice(error.message, true); });
      return;
    }

    if (target.dataset.viewJob) {
      loadJobOutput(target.dataset.viewJob).catch(function (error) { showNotice(error.message, true); });
    }
  });

  refresh().catch(function (error) {
    showNotice("加载 Junius 状态失败：" + error.message, true);
  });
})();
`;
