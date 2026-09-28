export const ADMIN_DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Junius 控制台</title>
  <link rel="icon" href="data:,">
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
        <button data-view="activity" class="nav-item">活动记录</button>
        <button data-view="browser" class="nav-item">浏览器</button>
        <button data-view="desktop" class="nav-item">桌面</button>
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
          <form id="capability-form" class="capability-form">
            <div class="form-row">
              <label>
                <span>Key</span>
                <input name="key" required maxlength="64" placeholder="python">
              </label>
              <label class="grow">
                <span>描述</span>
                <input name="description" required maxlength="1024" placeholder="Python interpreter">
              </label>
            </div>

            <div class="form-row">
              <label class="grow">
                <span>可执行文件（绝对路径）</span>
                <div class="inline-control">
                  <input name="executable" required placeholder="C:\\Python313\\python.exe">
                  <button id="capability-executable-discover" class="button secondary" type="button">从 PATH 查找</button>
                </div>
                <div id="capability-executable-results" class="picker-results hidden"></div>
              </label>
              <label class="grow">
                <span>固定参数</span>
                <input name="fixedArgs" placeholder="-I">
              </label>
            </div>

            <div class="capability-section">
              <div class="section-heading">
                <div>
                  <strong>机器参数策略</strong>
                  <span>每条规则独立选择 exact 或 prefix；Workspace 授权仍必须是这些规则的子集。</span>
                </div>
                <button id="capability-policy-add" class="button secondary" type="button">添加规则</button>
              </div>
              <div id="capability-policy-list" class="editor-list"></div>
            </div>

            <details class="capability-section advanced-section">
              <summary>环境变量、Audit 与运行限制</summary>
              <div class="form-row advanced-grid">
                <label>
                  <span>环境继承</span>
                  <select id="capability-environment-inherit" name="environmentInherit">
                    <option value="none">不继承</option>
                    <option value="allowlist">仅允许名单</option>
                    <option value="all">继承全部</option>
                  </select>
                </label>
                <label class="grow">
                  <span>允许继承的变量名</span>
                  <input name="environmentAllowNames" placeholder="PATH, SystemRoot, TEMP">
                </label>
                <label class="grow">
                  <span>禁止继承的变量名</span>
                  <input name="environmentDenyNames" placeholder="NODE_OPTIONS, SSH_ASKPASS">
                </label>
                <label class="grow">
                  <span>禁止继承的变量名前缀</span>
                  <input name="environmentDenyPrefixes" placeholder="GIT_, AWS_">
                </label>
                <label>
                  <span>超时 ms</span>
                  <input name="timeoutMs" type="number" min="100" max="600000" value="15000">
                </label>
                <label>
                  <span>最大输出 bytes</span>
                  <input name="maxOutputBytes" type="number" min="1024" max="16777216" value="65536">
                </label>
                <label>
                  <span>Audit 参数记录</span>
                  <select id="capability-audit-arguments" name="auditArguments">
                    <option value="full">记录参数</option>
                    <option value="redact_all">全部脱敏</option>
                    <option value="redact_selected">指定索引脱敏</option>
                  </select>
                </label>
                <label class="grow">
                  <span>脱敏参数索引（0-based）</span>
                  <input name="auditRedactIndexes" placeholder="例如：1, 3">
                </label>
              </div>

              <div class="section-heading compact-heading">
                <div>
                  <strong>显式环境变量</strong>
                  <span>这些值会覆盖继承值；不会经过 Shell 展开。</span>
                </div>
                <button id="capability-environment-add" class="button secondary" type="button">添加变量</button>
              </div>
              <div id="capability-environment-set" class="editor-list"></div>
            </details>

            <div class="form-actions">
              <button class="button" type="submit">保存自定义能力</button>
              <button id="capability-form-reset" class="button secondary" type="button">清空</button>
            </div>
          </form>
          <p class="hint">自定义能力始终以 shell:false 直接启动；新建能力默认不继承 Host 环境。旧 v2 自定义能力迁移时保留原有“继承全部”行为。</p>
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
          <div id="job-history-summary" class="detail-grid"></div>
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

      <section id="view-activity" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>活动记录</h2>
              <p>统一查看 Junius 最近执行过的操作与配置变更；敏感正文不会写入 Audit。</p>
            </div>
          </div>
          <div class="audit-toolbar">
            <label class="audit-search">
              <span>搜索</span>
              <input id="audit-search" type="search" placeholder="操作、对象、摘要、metadata…">
            </label>
            <label>
              <span>Workspace</span>
              <select id="audit-workspace">
                <option value="">全部</option>
              </select>
            </label>
            <label>
              <span>类别</span>
              <select id="audit-category">
                <option value="">全部</option>
                <option value="command">命令</option>
                <option value="job">后台任务</option>
                <option value="workspace">工作区文件</option>
                <option value="browser">浏览器</option>
                <option value="desktop">桌面</option>
                <option value="configuration">配置</option>
              </select>
            </label>
            <label>
              <span>状态</span>
              <select id="audit-status">
                <option value="">全部</option>
                <option value="started">已开始</option>
                <option value="succeeded">成功</option>
                <option value="failed">失败</option>
                <option value="cancelled">已取消</option>
              </select>
            </label>
            <button id="audit-clear-filters" class="button secondary" type="button">清除筛选</button>
          </div>
          <div id="audit-summary" class="detail-grid"></div>
          <div id="audit-list" class="stack audit-list"></div>
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

      <section id="view-desktop" class="view">
        <div class="panel">
          <div class="panel-heading">
            <div>
              <h2>桌面</h2>
              <p>Windows Computer Use 的 Python helper 状态。</p>
            </div>
          </div>
          <div id="desktop-details" class="detail-grid"></div>
        </div>
      </section>
    </main>
  </div>
  <script src="/dashboard.js" defer></script>
</body>
</html>`;
