export const ADMIN_DASHBOARD_JS_RENDER_CAPABILITIES = String.raw`  function renderCapabilities() {
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
        ' <span class="badge">' + esc(scopeLabel) + '</span>' +
        (capability.custom ? ' <span class="badge warning">自定义</span>' : '') +
        '</div>' +
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
        '</button>' +
        (capability.custom
          ? '<button class="button secondary" data-edit-capability="' + esc(capability.key) + '">编辑</button>' +
            '<button class="button danger" data-delete-capability="' + esc(capability.key) + '">删除</button>'
          : '') +
        '</div></div>';
    }).join("");
  }

`;
