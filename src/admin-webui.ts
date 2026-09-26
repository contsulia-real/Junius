export const ADMIN_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Junius Dashboard</title>
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">J</div>
        <div>
          <strong>Junius</strong>
          <span>Local Agent</span>
        </div>
      </div>
      <nav>
        <button data-view="overview" class="nav-item active">Overview</button>
        <button data-view="workspaces" class="nav-item">Workspaces</button>
        <button data-view="permissions" class="nav-item">Permissions</button>
        <button data-view="capabilities" class="nav-item">Capabilities</button>
        <button data-view="jobs" class="nav-item">Jobs</button>
        <button data-view="browser" class="nav-item">Browser</button>
      </nav>
      <div class="local-only">Local only · 127.0.0.1</div>
    </aside>

    <main>
      <header class="topbar">
        <div>
          <h1 id="page-title">Overview</h1>
          <p id="page-subtitle">Local Agent status and controls</p>
        </div>
        <button id="refresh" class="button secondary">Refresh</button>
      </header>

      <div id="notice" class="notice hidden"></div>

      <section id="view-overview" class="view active">
        <div id="summary" class="summary-grid"></div>
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>Current state</h2>
              <p>Runtime state exposed by the local Junius admin service.</p>
            </div>
          </div>
          <div id="overview-details" class="detail-grid"></div>
        </div>
      </section>

      <section id="view-workspaces" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>Workspaces</h2>
              <p>Register project roots available to Workspace-scoped capabilities.</p>
            </div>
          </div>
          <form id="workspace-form" class="form-row">
            <label>
              <span>ID</span>
              <input id="workspace-id" required maxlength="64" placeholder="weave">
            </label>
            <label class="grow">
              <span>Root path</span>
              <input id="workspace-root" required placeholder="C:\\Users\\...\\Project">
            </label>
            <button class="button" type="submit">Add workspace</button>
          </form>
          <div id="workspace-list" class="stack"></div>
        </div>
      </section>

      <section id="view-permissions" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>Permissions</h2>
              <p>Workspace capability grants remain argument-scoped.</p>
            </div>
          </div>
          <form id="permission-form" class="form-row">
            <label>
              <span>Workspace</span>
              <select id="permission-workspace"></select>
            </label>
            <label>
              <span>Capability</span>
              <select id="permission-capability"></select>
            </label>
            <label>
              <span>Mode</span>
              <select id="permission-mode">
                <option value="exact">exact</option>
                <option value="prefix">prefix</option>
              </select>
            </label>
            <label class="grow">
              <span>Arguments</span>
              <input id="permission-args" placeholder='run check'>
            </label>
            <button class="button" type="submit">Add rule</button>
          </form>
          <p class="hint">Arguments use shell-like quoting only for this form; Junius still stores and executes an argument vector, never a raw shell command.</p>
          <div id="permission-list" class="stack"></div>
        </div>
      </section>

      <section id="view-capabilities" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>Capabilities</h2>
              <p>Machine-level process capabilities currently registered in Junius.</p>
            </div>
          </div>
          <div id="capability-list" class="stack"></div>
        </div>
      </section>

      <section id="view-jobs" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>Jobs</h2>
              <p>Process-local background jobs managed by Junius.</p>
            </div>
          </div>
          <div id="job-list" class="stack"></div>
        </div>
        <div id="job-output-panel" class="panel hidden">
          <div class="panel-heading">
            <div>
              <h2 id="job-output-title">Job output</h2>
              <p>Captured stdout and stderr.</p>
            </div>
            <button id="close-output" class="button secondary">Close</button>
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
              <h2>Browser</h2>
              <p>Local playwright-cli adapter status.</p>
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

  var titles = {
    overview: ["Overview", "Local Agent status and controls"],
    workspaces: ["Workspaces", "Registered local project roots"],
    permissions: ["Permissions", "Argument-scoped capability grants"],
    capabilities: ["Capabilities", "Machine-level registered capabilities"],
    jobs: ["Jobs", "Background process lifecycle"],
    browser: ["Browser", "Local playwright-cli adapter"]
  };

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
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }

  function renderSummary() {
    var running = data.jobs.filter(function (job) { return job.status === "running"; }).length;
    var cards = [
      [data.workspaces.length, "Workspaces"],
      [data.registeredCapabilities.length, "Process capabilities"],
      [running, "Running jobs"],
      [data.browser.available ? "Ready" : "Missing", "Browser"]
    ];
    document.getElementById("summary").innerHTML = cards.map(function (card) {
      return '<div class="summary-card"><div class="value">' + esc(card[0]) +
        '</div><div class="label">' + esc(card[1]) + '</div></div>';
    }).join("");

    document.getElementById("overview-details").innerHTML =
      '<div class="detail"><div class="key">Admin endpoint</div><div class="value">' +
      esc(location.origin) + '</div></div>' +
      '<div class="detail"><div class="key">Browser adapter</div><div class="value">' +
      badge(data.browser.available ? "available" : "unavailable") + '</div></div>' +
      '<div class="detail"><div class="key">Browser state</div><div class="value">' +
      esc(data.browser.statePath) + '</div></div>' +
      '<div class="detail"><div class="key">MCP exposure</div><div class="value">Admin WebUI is local-only</div></div>';
  }

  function renderWorkspaces() {
    var node = document.getElementById("workspace-list");
    if (data.workspaces.length === 0) {
      node.innerHTML = '<div class="empty">No Workspaces registered.</div>';
      return;
    }

    node.innerHTML = data.workspaces.map(function (workspace) {
      return '<div class="item"><div class="item-main">' +
        '<div class="item-title">' + esc(workspace.id) + '</div>' +
        '<div class="item-meta">' + esc(workspace.rootPath) + '</div>' +
        '<div class="item-meta">' + workspace.grants.length + ' capability grant(s)</div>' +
        '</div><div class="item-actions">' +
        '<button class="button danger" data-remove-workspace="' + esc(workspace.id) + '">Remove</button>' +
        '</div></div>';
    }).join("");
  }

  function renderCapabilities() {
    var node = document.getElementById("capability-list");
    if (data.registeredCapabilities.length === 0) {
      node.innerHTML = '<div class="empty">No process capabilities registered.</div>';
      return;
    }

    node.innerHTML = data.registeredCapabilities.map(function (capability) {
      return '<div class="item"><div class="item-main">' +
        '<div class="item-title">' + esc(capability.key) + '</div>' +
        '<div class="item-meta">' + esc(capability.description) + '</div>' +
        '</div>' + badge("available") + '</div>';
    }).join("");
  }

  function renderPermissionSelectors() {
    var workspaceSelect = document.getElementById("permission-workspace");
    var capabilitySelect = document.getElementById("permission-capability");

    var oldWorkspace = workspaceSelect.value;
    var oldCapability = capabilitySelect.value;

    workspaceSelect.innerHTML = data.workspaces.map(function (workspace) {
      return '<option value="' + esc(workspace.id) + '">' + esc(workspace.id) + '</option>';
    }).join("");

    capabilitySelect.innerHTML = data.registeredCapabilities.map(function (capability) {
      return '<option value="' + esc(capability.key) + '">' + esc(capability.key) + '</option>';
    }).join("");

    if (data.workspaces.some(function (w) { return w.id === oldWorkspace; })) {
      workspaceSelect.value = oldWorkspace;
    }
    if (data.registeredCapabilities.some(function (c) { return c.key === oldCapability; })) {
      capabilitySelect.value = oldCapability;
    }
  }

  function renderPermissions() {
    renderPermissionSelectors();
    var node = document.getElementById("permission-list");
    var rows = [];

    data.workspaces.forEach(function (workspace) {
      workspace.grants.forEach(function (grant) {
        var rules = grant.arguments.map(function (rule, index) {
          var args = rule.args.map(function (arg) { return JSON.stringify(arg); }).join(" ");
          return '<div class="rule">' +
            '<span class="badge">' + esc(rule.mode) + '</span>' +
            '<code>' + esc(args || "(no args)") + '</code>' +
            '<button class="button secondary" data-remove-rule="' + esc(workspace.id) +
            '" data-capability="' + esc(grant.key) + '" data-rule-index="' + index + '">Remove rule</button>' +
            '</div>';
        }).join("");

        rows.push('<div class="item"><div class="item-main">' +
          '<div class="item-title">' + esc(workspace.id) + ' · ' + esc(grant.key) + '</div>' +
          rules +
          '</div><div class="item-actions">' +
          '<button class="button danger" data-revoke="' + esc(workspace.id) +
          '" data-capability="' + esc(grant.key) + '">Revoke capability</button>' +
          '</div></div>');
      });
    });

    node.innerHTML = rows.length ? rows.join("") : '<div class="empty">No capability grants configured.</div>';
  }

  function renderJobs() {
    var node = document.getElementById("job-list");
    if (data.jobs.length === 0) {
      node.innerHTML = '<div class="empty">No jobs in this Junius process.</div>';
      return;
    }

    node.innerHTML = data.jobs.map(function (job) {
      var actions = '<button class="button secondary" data-view-job="' + esc(job.id) + '">Output</button>';
      if (job.status === "running") {
        actions += '<button class="button danger" data-cancel-job="' + esc(job.id) + '">Cancel</button>';
      }

      return '<div class="item"><div class="item-main">' +
        '<div class="item-title">' + esc(job.key) + ' · ' + esc(job.workspace) + '</div>' +
        '<div class="item-meta">' + esc(job.id) + '</div>' +
        '<div class="item-meta">Started ' + esc(job.startedAt) +
        (job.exitCode === undefined ? "" : " · exit " + esc(job.exitCode)) + '</div>' +
        '</div><div class="item-actions">' + badge(job.status) + actions + '</div></div>';
    }).join("");
  }

  function renderBrowser() {
    document.getElementById("browser-details").innerHTML =
      '<div class="detail"><div class="key">playwright-cli</div><div class="value">' +
      badge(data.browser.available ? "available" : "unavailable") + '</div></div>' +
      '<div class="detail"><div class="key">Runtime state directory</div><div class="value">' +
      esc(data.browser.statePath) + '</div></div>' +
      '<div class="detail"><div class="key">Default visibility</div><div class="value">headed</div></div>' +
      '<div class="detail"><div class="key">Default profile mode</div><div class="value">persistent</div></div>';
  }

  function render() {
    renderSummary();
    renderWorkspaces();
    renderPermissions();
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

    if (quote !== null) throw new Error("Unclosed quote in arguments.");
    if (escaped) current += "\\";
    if (current.length) result.push(current);
    return result;
  }

  function workspaceById(id) {
    return data.workspaces.find(function (workspace) { return workspace.id === id; });
  }

  async function addPermissionRule(event) {
    event.preventDefault();
    var workspaceId = document.getElementById("permission-workspace").value;
    var key = document.getElementById("permission-capability").value;
    var mode = document.getElementById("permission-mode").value;
    var args = parseArgs(document.getElementById("permission-args").value);

    if (!workspaceId || !key) throw new Error("Workspace and capability are required.");
    if (mode === "prefix" && args.length === 0) throw new Error("prefix requires at least one argument.");

    var workspace = workspaceById(workspaceId);
    var existing = workspace.grants.find(function (grant) { return grant.key === key; });
    var rules = existing ? existing.arguments.slice() : [];
    rules.push({ mode: mode, args: args });

    await api("/workspaces/" + encodeURIComponent(workspaceId) + "/grants/" + encodeURIComponent(key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: rules })
    });

    document.getElementById("permission-args").value = "";
    await refresh();
    showNotice("Permission rule added.");
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

    await refresh();
    showNotice("Permission rule removed.");
  }

  async function loadJobOutput(id) {
    var stdout = await api("/jobs/" + encodeURIComponent(id) + "/output?stream=stdout");
    var stderr = await api("/jobs/" + encodeURIComponent(id) + "/output?stream=stderr");
    document.getElementById("job-output-title").textContent = "Job output · " + id;
    document.getElementById("job-stdout").textContent = stdout.output.content || "";
    document.getElementById("job-stderr").textContent = stderr.output.content || "";
    document.getElementById("job-output-panel").classList.remove("hidden");
  }

  document.querySelectorAll(".nav-item").forEach(function (node) {
    node.addEventListener("click", function () { setView(node.dataset.view); });
  });

  document.getElementById("refresh").addEventListener("click", function () {
    refresh().then(function () { showNotice("State refreshed."); }).catch(function (error) { showNotice(error.message, true); });
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
      showNotice("Workspace added.");
    }).catch(function (error) {
      showNotice(error.message, true);
    });
  });

  document.getElementById("permission-form").addEventListener("submit", function (event) {
    addPermissionRule(event).catch(function (error) { showNotice(error.message, true); });
  });

  document.getElementById("close-output").addEventListener("click", function () {
    document.getElementById("job-output-panel").classList.add("hidden");
  });

  document.addEventListener("click", function (event) {
    var target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.removeWorkspace) {
      if (!confirm("Remove Workspace " + target.dataset.removeWorkspace + "?")) return;
      api("/workspaces/" + encodeURIComponent(target.dataset.removeWorkspace), { method: "DELETE" })
        .then(refresh)
        .then(function () { showNotice("Workspace removed."); })
        .catch(function (error) { showNotice(error.message, true); });
      return;
    }

    if (target.dataset.revoke) {
      if (!confirm("Revoke " + target.dataset.capability + " from " + target.dataset.revoke + "?")) return;
      api("/workspaces/" + encodeURIComponent(target.dataset.revoke) + "/grants/" + encodeURIComponent(target.dataset.capability), { method: "DELETE" })
        .then(refresh)
        .then(function () { showNotice("Capability revoked."); })
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
        .then(function () { showNotice("Job cancellation requested."); })
        .catch(function (error) { showNotice(error.message, true); });
      return;
    }

    if (target.dataset.viewJob) {
      loadJobOutput(target.dataset.viewJob).catch(function (error) { showNotice(error.message, true); });
    }
  });

  refresh().catch(function (error) {
    showNotice("Failed to load Junius state: " + error.message, true);
  });
})();
`;
