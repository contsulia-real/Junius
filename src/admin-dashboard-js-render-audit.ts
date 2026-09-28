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

  function auditSearchText(event) {
    var values = [
      event.id,
      event.timestamp,
      event.category,
      auditCategoryLabel(event.category),
      event.action,
      event.status,
      statusLabel(event.status),
      event.workspace,
      event.subject,
      event.summary,
      formatAuditMetadata(event.metadata)
    ];
    return values
      .filter(function (value) {
        return value !== undefined && value !== null;
      })
      .join("\n")
      .toLowerCase();
  }

  function auditFilterValues() {
    return {
      search: document.getElementById("audit-search").value.trim().toLowerCase(),
      workspace: document.getElementById("audit-workspace").value,
      category: document.getElementById("audit-category").value,
      status: document.getElementById("audit-status").value
    };
  }

  function syncAuditWorkspaceOptions(events) {
    var select = document.getElementById("audit-workspace");
    var current = select.value;
    var workspaces = Array.from(new Set(
      events
        .map(function (event) { return event.workspace || ""; })
        .filter(Boolean)
    )).sort();

    select.innerHTML =
      '<option value="">全部</option>' +
      '<option value="__none__">无 Workspace</option>' +
      workspaces.map(function (workspace) {
        return '<option value="' + esc(workspace) + '">' +
          esc(workspace) +
          '</option>';
      }).join("");

    if (
      current === "__none__" ||
      workspaces.indexOf(current) >= 0
    ) {
      select.value = current;
    }
  }

  function auditEventMatches(event, filters) {
    if (
      filters.workspace &&
      (
        filters.workspace === "__none__"
          ? Boolean(event.workspace)
          : event.workspace !== filters.workspace
      )
    ) {
      return false;
    }

    if (
      filters.category &&
      event.category !== filters.category
    ) {
      return false;
    }

    if (
      filters.status &&
      event.status !== filters.status
    ) {
      return false;
    }

    if (
      filters.search &&
      auditSearchText(event).indexOf(filters.search) < 0
    ) {
      return false;
    }

    return true;
  }

  function auditDetailRows(event) {
    var rows = [
      ["Event ID", event.id],
      ["时间", event.timestamp],
      ["类别", auditCategoryLabel(event.category)],
      ["操作", event.action],
      ["状态", statusLabel(event.status)],
      ["Workspace", event.workspace || "—"],
      ["对象", event.subject || "—"],
      ["耗时", event.durationMs === undefined ? "—" : event.durationMs + " ms"]
    ];

    return rows.map(function (row) {
      return '<div class="audit-detail-row">' +
        '<div class="audit-detail-key">' + esc(row[0]) + '</div>' +
        '<div class="audit-detail-value">' + esc(row[1]) + '</div>' +
      '</div>';
    }).join("");
  }

  function renderAuditEvent(event) {
    var scope = [];
    if (event.workspace) scope.push("Workspace " + event.workspace);
    if (event.subject) scope.push(event.subject);

    var timing = event.timestamp || "";
    if (event.durationMs !== undefined) {
      timing += " · " + event.durationMs + " ms";
    }

    var metadata = event.metadata
      ? JSON.stringify(event.metadata, null, 2)
      : "";

    return '<details class="item audit-item">' +
      '<summary class="audit-item-summary">' +
        '<div class="item-main">' +
          '<div class="item-title">' +
            esc(auditCategoryLabel(event.category)) +
            ' · ' +
            esc(event.action) +
          '</div>' +
          (scope.length
            ? '<div class="item-meta">' +
                esc(scope.join(" · ")) +
              '</div>'
            : '') +
          (event.summary
            ? '<div class="item-meta">' +
                esc(event.summary) +
              '</div>'
            : '') +
          '<div class="item-meta">' + esc(timing) + '</div>' +
        '</div>' +
        '<div class="item-actions">' +
          badge(event.status) +
          '<span class="audit-expand-hint">详情</span>' +
        '</div>' +
      '</summary>' +
      '<div class="audit-detail-panel">' +
        '<div class="audit-detail-grid">' +
          auditDetailRows(event) +
        '</div>' +
        (metadata
          ? '<div class="audit-metadata-block">' +
              '<div class="audit-detail-key">Metadata</div>' +
              '<pre class="audit-metadata-json">' +
                esc(metadata) +
              '</pre>' +
            '</div>'
          : '') +
      '</div>' +
    '</details>';
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

    var events = data.audit || [];
    syncAuditWorkspaceOptions(events);

    var filters = auditFilterValues();
    var filtered = events.filter(function (event) {
      return auditEventMatches(event, filters);
    });

    document.getElementById("audit-summary").innerHTML =
      '<div class="detail"><div class="key">当前匹配</div><div class="value">' +
      esc(filtered.length) + ' / ' + esc(events.length) + '</div></div>' +
      '<div class="detail"><div class="key">已保留事件</div><div class="value">' +
      esc(stats.entries || 0) + '</div></div>' +
      '<div class="detail"><div class="key">最多保留</div><div class="value">' +
      esc(retention.maxEntries || 0) + ' 条</div></div>' +
      '<div class="detail"><div class="key">最长保留</div><div class="value">' +
      esc(days) + ' 天</div></div>';

    var node = document.getElementById("audit-list");

    if (!events.length) {
      node.innerHTML =
        '<div class="empty">还没有 Audit 事件。</div>';
      return;
    }

    if (!filtered.length) {
      node.innerHTML =
        '<div class="empty">没有符合当前筛选条件的 Audit 事件。</div>';
      return;
    }

    node.innerHTML =
      filtered.map(renderAuditEvent).join("");
  }

`;
