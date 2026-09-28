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
          <form id="capability-form" class="form-row">
            <label>
              <span>Key</span>
              <input name="key" required maxlength="64" placeholder="python">
            </label>
            <label class="grow">
              <span>描述</span>
              <input name="description" required maxlength="1024" placeholder="Python interpreter">
            </label>
            <label class="grow">
              <span>可执行文件（绝对路径）</span>
              <input name="executable" required placeholder="C:\\Python313\\python.exe">
            </label>
            <label class="grow">
              <span>固定参数</span>
              <input name="fixedArgs" placeholder="-I">
            </label>
            <label>
              <span>超时 ms</span>
              <input name="timeoutMs" type="number" min="100" max="600000" value="15000">
            </label>
            <label>
              <span>最大输出 bytes</span>
              <input name="maxOutputBytes" type="number" min="1024" max="16777216" value="65536">
            </label>
            <label class="grow">
              <span>机器参数策略（每行 exact 或 prefix）</span>
              <textarea name="argumentPolicy" required rows="4" placeholder="exact --version&#10;prefix -m"></textarea>
            </label>
            <button class="button" type="submit">保存自定义能力</button>
            <button id="capability-form-reset" class="button secondary" type="button">清空</button>
          </form>
          <p class="hint">自定义能力始终以 shell:false 直接启动；Workspace 还需要单独授权，且授权必须是机器参数策略的子集。</p>
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
