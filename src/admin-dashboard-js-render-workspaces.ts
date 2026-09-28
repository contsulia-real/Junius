export const ADMIN_DASHBOARD_JS_RENDER_WORKSPACES = String.raw`  function formatArgument(arg) {
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

`;
