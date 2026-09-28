export const ADMIN_DASHBOARD_JS_ACTIONS = String.raw`  function parseArgs(text) {
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

  initializeCapabilityEditor();

  document.getElementById("capability-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.target;

    var payload;
    try {
      payload = {
        key: form.elements.key.value.trim(),
        description: form.elements.description.value.trim(),
        executable: form.elements.executable.value.trim(),
        fixedArgs: parseArgs(form.elements.fixedArgs.value),
        argumentPolicy: readCapabilityPolicyRows(),
        environmentPolicy: readCapabilityEnvironmentPolicy(form),
        timeoutMs: Number(form.elements.timeoutMs.value),
        maxOutputBytes: Number(form.elements.maxOutputBytes.value)
      };
    } catch (error) {
      showNotice(error.message, true);
      return;
    }

    api("/capabilities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function () {
      resetCapabilityForm();
      return refresh();
    }).then(function () {
      showNotice("自定义机器能力已保存。");
    }).catch(function (error) {
      showNotice(error.message, true);
    });
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

    if (target.dataset.editCapability) {
      editCapability(target.dataset.editCapability);
      return;
    }

    if (target.dataset.deleteCapability) {
      var customKey = target.dataset.deleteCapability;
      if (!confirm("确定删除自定义机器能力 " + customKey + " 吗？已有工作区授权会保留为失效规则。")) return;

      api("/capabilities/" + encodeURIComponent(customKey), {
        method: "DELETE"
      })
        .then(function () {
          resetCapabilityForm();
          return refresh();
        })
        .then(function () {
          showNotice("自定义机器能力 " + customKey + " 已删除。");
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
