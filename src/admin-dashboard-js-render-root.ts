export const ADMIN_DASHBOARD_JS_RENDER_ROOT = String.raw`  function render() {
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
