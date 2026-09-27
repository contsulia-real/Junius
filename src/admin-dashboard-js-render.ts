export const ADMIN_DASHBOARD_JS_RENDER = String.raw`  function renderSummary() {
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
    return data.machineCapabilities
      .filter(function (capability) { return capability.scope === "workspace"; })
      .map(function (capability) {
        return '<option value="' + esc(capability.key) + '">' +
          esc(capability.key) +
          (capability.enabled && capability.available ? "" : "（当前不可执行）") +
          '</option>';
      }).join("");
  }

  function grantValidityHtml(rule) {
    if (rule.valid !== false) return "";
    var labels = {
      machine_capability_not_known: "未知机器能力",
      capability_not_workspace_scoped: "不是工作区能力",
      arguments_outside_machine_policy: "超出机器策略"
    };
    return ' <span class="badge danger">当前无效：' +
      esc(labels[rule.reason] || rule.reason || "不兼容") + '</span>';
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
              ' <span class="badge">' + esc(rule.mode) + '</span>' +
              grantValidityHtml(rule) + '</div>' +
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
      return '<div class="empty">当前没有可配置的工作区能力。</div>';
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

      var scopeLabel = capability.scope === "workspace"
        ? "工作区作用域"
        : "机器作用域";

      return '<div class="item"><div class="item-main">' +
        '<div class="item-title">' + esc(capability.key) +
        ' <span class="badge">' + esc(scopeLabel) + '</span></div>' +
        '<div class="item-meta">' + esc(capability.description) + '</div>' +
        '<div class="item-meta">状态：' +
        (capability.enabled ? '<span class="badge success">已启用</span>' : '<span class="badge danger">已禁用</span>') +
        ' ' + (capability.available ? '<span class="badge success">可用</span>' : '<span class="badge danger">不可用</span>') +
        ' ' + (capability.active ? '<span class="badge success">已激活</span>' : '<span class="badge">未激活</span>') +
        '</div>' +
        '<div class="item-meta">启动器：' + esc(launcher) + '</div>' +
        '<div class="item-meta">机器策略：<span class="rule">' + (policy || '<code>无</code>') + '</span></div>' +
        '<div class="item-meta">' +
        (capability.scope === "workspace"
          ? "工作区授权：" + esc(users.length ? users.join(", ") : "无")
          : "授权方式：机器级启用状态，不使用工作区授权") +
        '</div>' +
        '</div><div class="item-actions">' +
        '<button class="button ' + (capability.enabled ? 'danger' : '') +
        '" data-toggle-capability="' + esc(capability.key) +
        '" data-enabled="' + String(capability.enabled) + '">' +
        (capability.enabled ? '禁用' : '启用') +
        '</button></div></div>';
    }).join("");
  }

  function formatByteCount(value) {
    var bytes = Number(value || 0);
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GiB";
  }

  function renderJobs() {
    var history = data.jobHistory || {
      entries: 0,
      capturedBytes: 0,
      retention: {}
    };
    var retention = history.retention || {};
    var retentionText = "无限保留（未启用自动清理）";
    if (
      retention.maxEntries !== undefined ||
      retention.maxAgeMs !== undefined
    ) {
      var rules = [];
      if (retention.maxEntries !== undefined) {
        rules.push("最多 " + retention.maxEntries + " 条");
      }
      if (retention.maxAgeMs !== undefined) {
        rules.push("最长 " + retention.maxAgeMs + " ms");
      }
      retentionText = rules.join(" · ");
    }

    document.getElementById("job-history-summary").innerHTML =
      '<div class="detail"><div class="key">历史任务</div><div class="value">' +
      esc(history.entries) + '</div></div>' +
      '<div class="detail"><div class="key">捕获输出</div><div class="value">' +
      esc(formatByteCount(history.capturedBytes)) + '</div></div>' +
      '<div class="detail"><div class="key">保留策略</div><div class="value">' +
      esc(retentionText) + '</div></div>';

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
      '<div class="detail"><div class="key">自动化路径</div><div class="value">UI Automation + Screenshot / Mouse / Keyboard</div></div>';
  }

  function render() {
    renderSummary();
    renderWorkspaces();
    renderCapabilities();
    renderJobs();
    renderBrowser();
    renderDesktop();
  }

  async function refresh() {
    data = await api("/state");
    render();
  }

`;
