export const ADMIN_DASHBOARD_JS_RENDER_JOBS = String.raw`  function formatByteCount(value) {
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

`;
