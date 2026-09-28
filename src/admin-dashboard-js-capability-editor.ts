export const ADMIN_DASHBOARD_JS_CAPABILITY_EDITOR = String.raw`
  function formatArg(arg) {
    return /\s/.test(arg)
      ? JSON.stringify(arg)
      : arg;
  }

  function addCapabilityPolicyRow(mode, args) {
    var list = document.getElementById("capability-policy-list");
    var row = document.createElement("div");
    row.className = "editor-row capability-policy-row";
    row.innerHTML =
      '<select data-policy-mode aria-label="策略类型">' +
        '<option value="exact">仅允许这组参数</option>' +
        '<option value="prefix">允许此前缀参数</option>' +
      '</select>' +
      '<input data-policy-args aria-label="策略参数" placeholder="例如：--version">' +
      '<button class="button secondary" type="button" data-remove-policy-rule>删除</button>';
    row.querySelector("[data-policy-mode]").value =
      mode || "exact";
    row.querySelector("[data-policy-args]").value =
      (args || []).map(formatArg).join(" ");
    list.appendChild(row);
  }

  function renderCapabilityPolicyRows(rules) {
    var list = document.getElementById("capability-policy-list");
    list.innerHTML = "";
    (rules || []).forEach(function (rule) {
      addCapabilityPolicyRow(rule.mode, rule.args);
    });
    if (!list.children.length) {
      addCapabilityPolicyRow("exact", []);
    }
  }

  function readCapabilityPolicyRows() {
    var rows = Array.from(
      document.querySelectorAll(".capability-policy-row")
    );
    if (!rows.length) {
      throw new Error("至少需要一条机器参数策略。");
    }

    return rows.map(function (row) {
      var mode = row.querySelector("[data-policy-mode]").value;
      var args = parseArgs(
        row.querySelector("[data-policy-args]").value
      );
      if (mode === "prefix" && args.length === 0) {
        throw new Error("prefix 策略至少需要一个参数。");
      }
      return { mode: mode, args: args };
    });
  }

  function parseEnvironmentNames(value) {
    var seen = Object.create(null);
    return String(value || "")
      .split(/[\s,]+/)
      .map(function (name) { return name.trim(); })
      .filter(Boolean)
      .filter(function (name) {
        var normalized = name.toUpperCase();
        if (seen[normalized]) return false;
        seen[normalized] = true;
        return true;
      });
  }

  function addEnvironmentRow(name, value) {
    var list = document.getElementById("capability-environment-set");
    var row = document.createElement("div");
    row.className = "editor-row capability-environment-row";
    row.innerHTML =
      '<input data-env-name aria-label="环境变量名" placeholder="NAME">' +
      '<input data-env-value aria-label="环境变量值" placeholder="value">' +
      '<button class="button secondary" type="button" data-remove-env-var>删除</button>';
    row.querySelector("[data-env-name]").value = name || "";
    row.querySelector("[data-env-value]").value = value || "";
    list.appendChild(row);
  }

  function readEnvironmentOverrides() {
    var result = {};
    var seen = Object.create(null);
    document.querySelectorAll(".capability-environment-row")
      .forEach(function (row) {
        var name = row.querySelector("[data-env-name]").value.trim();
        var value = row.querySelector("[data-env-value]").value;
        if (!name) return;
        var normalized = name.toUpperCase();
        if (seen[normalized]) {
          throw new Error("环境变量名不能重复：" + name);
        }
        seen[normalized] = true;
        result[name] = value;
      });
    return result;
  }

  function renderEnvironmentOverrides(values) {
    var list = document.getElementById("capability-environment-set");
    list.innerHTML = "";
    Object.keys(values || {}).sort().forEach(function (name) {
      addEnvironmentRow(name, values[name]);
    });
  }

  function readCapabilityEnvironmentPolicy(form) {
    return {
      inherit: form.elements.environmentInherit.value,
      allowNames: parseEnvironmentNames(
        form.elements.environmentAllowNames.value
      ),
      denyNames: parseEnvironmentNames(
        form.elements.environmentDenyNames.value
      ),
      denyPrefixes: parseEnvironmentNames(
        form.elements.environmentDenyPrefixes.value
      ),
      set: readEnvironmentOverrides()
    };
  }

  function syncEnvironmentControls() {
    var form = document.getElementById("capability-form");
    var allowlist =
      form.elements.environmentInherit.value === "allowlist";
    form.elements.environmentAllowNames.disabled = !allowlist;
  }

  function readCapabilityAuditPolicy(form) {
    var mode = form.elements.auditArguments.value;
    var indexes = String(
      form.elements.auditRedactIndexes.value || ""
    )
      .split(/[\s,]+/)
      .map(function (value) { return value.trim(); })
      .filter(Boolean)
      .map(function (value) {
        var index = Number(value);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index > 127
        ) {
          throw new Error("Audit 脱敏索引必须是 0-127 的整数。");
        }
        return index;
      })
      .filter(function (value, index, values) {
        return values.indexOf(value) === index;
      });

    return {
      arguments: mode,
      redactIndexes:
        mode === "redact_selected"
          ? indexes
          : []
    };
  }

  function syncAuditControls() {
    var form = document.getElementById("capability-form");
    form.elements.auditRedactIndexes.disabled =
      form.elements.auditArguments.value !== "redact_selected";
  }

  function renderExecutableCandidates(items) {
    var node = document.getElementById("capability-executable-results");
    if (!items || !items.length) {
      node.innerHTML = '<div class="empty compact">PATH 中没有匹配的可执行文件。</div>';
      node.classList.remove("hidden");
      return;
    }

    node.innerHTML = items.map(function (item) {
      return '<button type="button" class="picker-option" data-executable-path="' +
        esc(item.path) + '">' +
        '<strong>' + esc(item.name) + '</strong>' +
        '<span>' + esc(item.path) + '</span>' +
      '</button>';
    }).join("");
    node.classList.remove("hidden");
  }

  async function discoverExecutables() {
    var form = document.getElementById("capability-form");
    var value = form.elements.executable.value.trim();
    var parts = value.split(/[\\/]/);
    var query = parts[parts.length - 1] || value;
    var response = await api(
      "/capabilities/executables?q=" +
      encodeURIComponent(query) +
      "&limit=30"
    );
    renderExecutableCandidates(response.executables || []);
  }

  function resetCapabilityForm() {
    var form = document.getElementById("capability-form");
    form.reset();
    form.elements.key.readOnly = false;
    form.elements.timeoutMs.value = "15000";
    form.elements.maxOutputBytes.value = "65536";
    form.elements.environmentInherit.value = "none";
    form.elements.environmentAllowNames.value = "";
    form.elements.environmentDenyNames.value = "";
    form.elements.environmentDenyPrefixes.value = "";
    form.elements.auditArguments.value = "full";
    form.elements.auditRedactIndexes.value = "";
    renderCapabilityPolicyRows([
      { mode: "exact", args: [] }
    ]);
    renderEnvironmentOverrides({});
    syncEnvironmentControls();
    syncAuditControls();
    document.getElementById(
      "capability-executable-results"
    ).classList.add("hidden");
  }

  function editCapability(key) {
    var capability = data.machineCapabilities.find(function (item) {
      return item.key === key;
    });
    if (!capability || !capability.custom || !capability.definition) {
      return;
    }

    var form = document.getElementById("capability-form");
    var definition = capability.definition;
    var environment = definition.environmentPolicy || {
      inherit: "all",
      allowNames: [],
      denyNames: [],
      denyPrefixes: [],
      set: {}
    };
    var auditPolicy = definition.auditPolicy || {
      arguments: "full",
      redactIndexes: []
    };

    form.elements.key.value = definition.key;
    form.elements.key.readOnly = true;
    form.elements.description.value = definition.description;
    form.elements.executable.value = definition.executable;
    form.elements.fixedArgs.value =
      (definition.fixedArgs || []).map(formatArg).join(" ");
    form.elements.timeoutMs.value = String(definition.timeoutMs);
    form.elements.maxOutputBytes.value =
      String(definition.maxOutputBytes);
    form.elements.environmentInherit.value = environment.inherit;
    form.elements.environmentAllowNames.value =
      (environment.allowNames || []).join(", ");
    form.elements.environmentDenyNames.value =
      (environment.denyNames || []).join(", ");
    form.elements.environmentDenyPrefixes.value =
      (environment.denyPrefixes || []).join(", ");
    form.elements.auditArguments.value =
      auditPolicy.arguments || "full";
    form.elements.auditRedactIndexes.value =
      (auditPolicy.redactIndexes || []).join(", ");

    renderCapabilityPolicyRows(definition.argumentPolicy || []);
    renderEnvironmentOverrides(environment.set || {});
    syncEnvironmentControls();
    syncAuditControls();
    document.getElementById(
      "capability-executable-results"
    ).classList.add("hidden");
    form.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }

  function initializeCapabilityEditor() {
    resetCapabilityForm();

    document.getElementById(
      "capability-form-reset"
    ).addEventListener(
      "click",
      resetCapabilityForm
    );

    document.getElementById(
      "capability-policy-add"
    ).addEventListener("click", function () {
      addCapabilityPolicyRow("exact", []);
    });

    document.getElementById(
      "capability-environment-add"
    ).addEventListener("click", function () {
      addEnvironmentRow("", "");
    });

    document.getElementById(
      "capability-executable-discover"
    ).addEventListener("click", function () {
      discoverExecutables().catch(function (error) {
        showNotice(error.message, true);
      });
    });

    document.getElementById(
      "capability-environment-inherit"
    ).addEventListener(
      "change",
      syncEnvironmentControls
    );

    document.getElementById(
      "capability-audit-arguments"
    ).addEventListener(
      "change",
      syncAuditControls
    );

    document.addEventListener("click", function (event) {
      var removePolicy =
        event.target.closest("[data-remove-policy-rule]");
      if (removePolicy) {
        removePolicy.closest(".capability-policy-row").remove();
        if (!document.querySelector(".capability-policy-row")) {
          addCapabilityPolicyRow("exact", []);
        }
        return;
      }

      var removeEnvironment =
        event.target.closest("[data-remove-env-var]");
      if (removeEnvironment) {
        removeEnvironment.closest(".capability-environment-row").remove();
        return;
      }

      var executable =
        event.target.closest("[data-executable-path]");
      if (executable) {
        document.getElementById("capability-form")
          .elements.executable.value =
            executable.dataset.executablePath;
        document.getElementById(
          "capability-executable-results"
        ).classList.add("hidden");
      }
    });
  }

`;
