export const ADMIN_DASHBOARD_CSS = `
:root {
  color-scheme: light dark;
  --bg: #0f1115;
  --sidebar: #151821;
  --panel: #181c25;
  --panel-2: #202531;
  --border: #2a3140;
  --text: #f3f5f7;
  --muted: #9da7b5;
  --accent: #7ea2ff;
  --danger: #ff7272;
  --success: #6ed6a0;
  --warning: #f2c66d;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); min-height: 100vh; }
button, input, select { font: inherit; }
.shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; }
.sidebar { background: var(--sidebar); border-right: 1px solid var(--border); padding: 24px 16px; display: flex; flex-direction: column; gap: 28px; }
.brand { display: flex; align-items: center; gap: 12px; padding: 0 8px; }
.brand-mark { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 11px; background: var(--accent); color: #10131a; font-weight: 800; }
.brand strong, .brand span { display: block; }
.brand span { color: var(--muted); font-size: 12px; margin-top: 2px; }
nav { display: grid; gap: 6px; }
.nav-item { border: 0; background: transparent; color: var(--muted); text-align: left; padding: 10px 12px; border-radius: 9px; cursor: pointer; }
.nav-item:hover, .nav-item.active { background: var(--panel-2); color: var(--text); }
.local-only { margin-top: auto; color: var(--muted); font-size: 12px; padding: 0 8px; }
main { padding: 28px 34px 48px; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 4px; font-size: 28px; }
h2 { margin-bottom: 5px; font-size: 18px; }
h3 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.topbar p, .panel-heading p { color: var(--muted); margin-bottom: 0; }
.view { display: none; }
.view.active { display: block; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px,1fr)); gap: 14px; margin-bottom: 18px; }
.summary-card, .panel, .item { border: 1px solid var(--border); background: var(--panel); border-radius: 13px; }
.summary-card { padding: 18px; }
.summary-card .value { font-size: 28px; font-weight: 700; }
.summary-card .label { color: var(--muted); font-size: 13px; margin-top: 6px; }
.panel { padding: 20px; margin-bottom: 18px; }
.panel-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 18px; }
.stack { display: grid; gap: 10px; }
.item { padding: 14px 16px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; background: var(--panel-2); }
.item-main { min-width: 0; }
.item-title { font-weight: 650; overflow-wrap: anywhere; }
.item-meta { color: var(--muted); font-size: 13px; margin-top: 5px; overflow-wrap: anywhere; }
.item-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.workspace-card { display: block; padding: 0; overflow: hidden; }
.workspace-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px; }
.workspace-settings { border-top: 1px solid var(--border); padding: 16px; background: #151a22; }
.workspace-settings h3 { margin-bottom: 10px; color: var(--text); text-transform: none; letter-spacing: 0; font-size: 14px; }
.workspace-settings-copy { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
.grant-list { display: grid; gap: 10px; margin-bottom: 16px; }
.grant-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--panel-2); }
.grant-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.grant-title { font-weight: 650; }
.grant-status { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.rule-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.rule-copy { min-width: 0; }
.rule-label { color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.rule-command { display: inline-block; max-width: 100%; overflow-wrap: anywhere; background: #11151c; border-radius: 7px; padding: 6px 8px; }
.workspace-permission-form { margin-top: 4px; }
.button { border: 1px solid transparent; border-radius: 9px; padding: 9px 12px; background: var(--accent); color: #10131a; cursor: pointer; font-weight: 650; white-space: nowrap; }
.button.secondary { color: var(--text); background: var(--panel-2); border-color: var(--border); }
.button.danger { color: #fff; background: #792f38; border-color: #9c3d48; }
.button:disabled { opacity: .45; cursor: not-allowed; }
.form-row { display: flex; gap: 10px; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; }
.form-row label { display: grid; gap: 6px; min-width: 140px; }
.form-row label.grow { flex: 1; min-width: 240px; }
label span { color: var(--muted); font-size: 12px; }
input, select { width: 100%; border: 1px solid var(--border); border-radius: 9px; padding: 9px 10px; background: #11151c; color: var(--text); outline: none; }
input:focus, select:focus { border-color: var(--accent); }
.hint { color: var(--muted); font-size: 12px; margin: -8px 0 16px; }
.detail-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
.detail { padding: 14px; border-radius: 10px; background: var(--panel-2); }
.detail .key { color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.detail .value { overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; font-size: 12px; background: #2a3140; }
.badge.success { color: var(--success); }
.badge.warning { color: var(--warning); }
.badge.danger { color: var(--danger); }
.rule { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.rule code { color: var(--text); background: #11151c; border-radius: 7px; padding: 5px 7px; overflow-wrap: anywhere; }
.notice { padding: 11px 13px; border-radius: 9px; margin-bottom: 16px; background: #26334d; color: #cbd8ff; }
.notice.error { background: #4d252b; color: #ffc5c5; }
.hidden { display: none !important; }
.output-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
pre { min-height: 180px; max-height: 460px; overflow: auto; white-space: pre-wrap; background: #0c0f14; border: 1px solid var(--border); border-radius: 10px; padding: 12px; color: #d9e1ea; }
.empty { color: var(--muted); padding: 18px 2px; }
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar { position: static; padding: 14px; gap: 14px; }
  .brand, .local-only { display: none; }
  nav { display: flex; overflow-x: auto; }
  .nav-item { white-space: nowrap; }
  main { padding: 20px 16px 36px; }
  .summary-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .detail-grid, .output-grid { grid-template-columns: 1fr; }
}
`;
