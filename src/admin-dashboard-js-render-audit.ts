export const ADMIN_DASHBOARD_JS_RENDER_AUDIT = String.raw`
  function auditCategoryLabel(category) {
    return ({
      command: "命令",
      job: "后台任务",
      workspace: "工作区文件",
      browser: "浏览器",
      desktop: "桌面",
      configuration: "配置"
    })[category] || category;
  }

  function formatAuditMetadata(metadata) {
    if (!metadata) return "";
    var parts = [];
    Object.keys(metadata).forEach(function (key) {
      var value = metadata[key];
      if (Array.isArray(value)) {
        if (value.length) {
          parts.push(key + ": " + value.join(" · "));
        }
        return;
      }
      if (value !== "" && value !== undefined && value !== null) {
        parts.push(key + ": " + String(value));
      }
    });
    return parts.join(" · ");
  }

  function renderAudit() {
    var stats = data.auditStats || {
      entries: 0,
      retention: {
        maxEntries: 1000,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000
      }
    };
    var retention = stats.retention || {};
    var days = retention.maxAgeMs
      ? Math.round(retention.maxAgeMs / (24 * 60 * 60 * 1000))
      : 0;

    document.getElementById("audit-summary").innerHTML =
      '<div class="detail"><div class="key">已保留事件</div><div class="value">' +
      esc(stats.entries || 0) + '</div></div>' +
      '<div class="detail"><div class="key">最多保留</div><div class="value">' +
      esc(retention.maxEntries || 0) + ' 条</div></div>' +
      '<div class="detail"><div class="key">最长保留</div><div class="value">' +
      esc(days) + ' 天</div></div>';

    var node = document.getElementById("audit-list");
    var events = data.audit || [];
    if (!events.length) {
      node.innerHTML = '<div class="empty">还没有 Audit 事件。</div>';
      return;
    }

    node.innerHTML = events.map(function (event) {
      var scope = [];
      if (event.workspace) scope.push("Workspace " + event.workspace);
      if (event.subject) scope.push(event.subject);
      var meta = formatAuditMetadata(event.metadata);
      var timing = event.timestamp || "";
      if (event.durationMs !== undefined) {
        timing += " · " + event.durationMs + " ms";
      }

      return '<div class="item audit-item"><div class="item-main">' +
        '<div class="item-title">' +
        esc(auditCategoryLabel(event.category)) +
        ' · ' + esc(event.action) + '</div>' +
        (scope.length
          ? '<div class="item-meta">' + esc(scope.join(" · ")) + '</div>'
          : '') +
        (event.summary
          ? '<div class="item-meta">' + esc(event.summary) + '</div>'
          : '') +
        (meta
          ? '<div class="item-meta audit-meta">' + esc(meta) + '</div>'
          : '') +
        '<div class="item-meta">' + esc(timing) + '</div>' +
        '</div><div class="item-actions">' +
        badge(event.status) +
        '</div></div>';
    }).join("");
  }

`;
