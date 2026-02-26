export function getSpaStyles(): string {
  return `
html{overscroll-behavior:none}
html::before{content:'';position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);background:var(--bg);z-index:9999}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0a0e1a;--surface:#141927;--card:#1e2740;
  --accent:#3b82f6;--accent-light:#60a5fa;
  --text:#e2e8f0;--muted:#94a3b8;--dim:#475569;
  --success:#22c55e;--error:#ef4444;--sort:#4ade80;
  --radius:14px;--safe-bottom:env(safe-area-inset-bottom,0px)
}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  min-height:100dvh;overflow-x:hidden;padding-bottom:calc(56px + env(safe-area-inset-bottom,0px));padding-top:env(safe-area-inset-top,0px);
  overscroll-behavior:none}
#tab-sync{display:none;flex-direction:column;align-items:center;justify-content:center;
  min-height:calc(100dvh - 56px);padding:20px 16px calc(20px + var(--safe-bottom))}
#tab-sync.tab-active{display:flex}
#tab-briefing{display:none;min-height:calc(100dvh - 56px);padding:0 0 calc(20px + var(--safe-bottom))}
#tab-briefing.tab-active{display:block}
.tab-bar{position:fixed;bottom:0;left:0;right:0;height:calc(56px + env(safe-area-inset-bottom,0px));background:var(--card);
  border-top:1px solid var(--dim);display:flex;z-index:200;
  padding-bottom:env(safe-area-inset-bottom,0px)}
.tab-btn{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:2px;border:none;background:none;color:var(--muted);font-size:.7em;font-weight:600;
  cursor:pointer;transition:color .15s;-webkit-appearance:none}
.tab-btn.tab-active{color:var(--accent)}
.tab-btn-icon{font-size:1.5em;line-height:1}
.tab-util{cursor:default;gap:1px}
.tab-util-row{display:flex;gap:6px;align-items:center;justify-content:center}
.tab-util-btn{background:none;border:none;color:var(--muted);font-size:1em;font-weight:600;
  cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:1px;padding:0;-webkit-appearance:none}
.tab-util-btn span{font-size:1.3em;line-height:1}
.install-overlay{position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.6);
  display:flex;align-items:center;justify-content:center;padding:24px}
.install-card{background:var(--card);border-radius:16px;padding:28px 24px;width:100%;
  max-width:320px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.25)}
.install-steps{font-size:.88em;color:var(--text);line-height:1.8;text-align:left;margin-bottom:18px}
.install-close-btn{width:100%;padding:12px;border-radius:10px;border:none;background:var(--accent);
  color:#fff;font-size:.95em;font-weight:700;cursor:pointer;-webkit-appearance:none}
.briefing-section{background:var(--card);border-radius:var(--radius);padding:16px;margin-bottom:16px}
.briefing-section h2{font-size:1em;font-weight:700;margin:0 0 12px;color:var(--text);display:flex;align-items:center;gap:6px}
.datis-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.datis-tab{padding:4px 12px;font-size:.78em;background:none;border:1.5px solid var(--dim);
  border-radius:16px;color:var(--muted);font-weight:500;cursor:pointer;transition:all .2s;margin:0}
.datis-tab:hover{border-color:var(--accent);color:var(--accent)}
.datis-tab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.datis-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:8px}
.datis-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:8px 4px;border-radius:10px;border:2px solid var(--accent);background:none;
  color:var(--text);font-size:.82em;font-weight:700;cursor:pointer;transition:all .2s;
  margin:0;line-height:1.3}
.datis-btn span{font-size:.8em;font-weight:400;color:var(--muted);margin-top:2px}
.datis-btn:hover,.datis-btn.selected{background:var(--accent);color:#fff}
.datis-btn:hover span,.datis-btn.selected span{color:rgba(255,255,255,.85)}
.datis-btn.a{border-style:dashed;opacity:.75}
.datis-btn.a:hover,.datis-btn.a.selected{opacity:1}
.datis-btn.s{border:2px solid #b45309}
.datis-btn.a.s{border:2px dashed #b45309}
.datis-btn.s:hover,.datis-btn.s.selected{background:#b45309}
.datis-btn.s:hover span,.datis-btn.s.selected span{color:rgba(255,255,255,.85)}
.datis-btn.hidden{display:none}
.atis-card{background:var(--surface);border:1px solid var(--dim);border-radius:10px;padding:.8em 1em;margin-bottom:.8em}
.atis-card-title{font-weight:700;font-size:.9em;color:var(--accent-light);margin-bottom:.4em}
.atis-card pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:'Courier New',monospace;font-size:.85em;line-height:1.5;color:var(--text)}
.atis-loading{text-align:center;padding:2em;color:var(--muted)}
.screen{display:none;width:100%;max-width:420px;animation:fadeIn .2s ease}
.screen.active{display:flex;flex-direction:column;gap:20px}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.logo{text-align:center;padding:8px 0}
.logo-icon{font-size:2.4em;display:block;margin-bottom:4px}
.logo-title{font-size:1.4em;font-weight:700;letter-spacing:.5px;color:var(--accent-light)}
.logo-sub{font-size:.82em;color:var(--muted);margin-top:2px}
.card{background:var(--card);border-radius:var(--radius);padding:20px;display:flex;flex-direction:column;gap:14px}
label{font-size:.82em;color:var(--muted);font-weight:500;display:block;margin-bottom:4px}
input,select{width:100%;background:var(--surface);border:1.5px solid var(--dim);border-radius:10px;
  padding:12px 14px;color:var(--text);font-size:1em;outline:none;transition:border .2s;
  -webkit-appearance:none;appearance:none}
input:focus,select:focus{border-color:var(--accent)}
.field{display:flex;flex-direction:column}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;
  width:100%;padding:14px;border:none;border-radius:10px;font-size:1em;font-weight:600;
  cursor:pointer;transition:opacity .15s,transform .1s;-webkit-appearance:none}
.btn:active{opacity:.8;transform:scale(.98)}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.btn-primary{background:var(--accent);color:#fff}
.btn-secondary{background:var(--surface);color:var(--text);border:1.5px solid var(--dim)}
.btn-success{background:var(--success);color:#fff}
.btn-danger{background:#7f1d1d;color:#fca5a5;border:1px solid #991b1b}
.btn-sm{padding:10px;font-size:.9em}
.month-row{display:flex;gap:10px}
.month-row .field{flex:1}
.log-box{background:var(--surface);border-radius:10px;padding:14px;
  font-family:monospace;font-size:.78em;line-height:1.6;max-height:40vh;
  overflow-y:auto;color:var(--muted);white-space:pre-wrap;word-break:break-all}
.stats{display:flex;gap:10px;text-align:center}
.stat-item{flex:1;background:var(--surface);border-radius:10px;padding:12px 6px}
.stat-num{font-size:1.6em;font-weight:700;color:var(--accent-light)}
.stat-lbl{font-size:.72em;color:var(--muted);margin-top:2px}
.spinner{width:36px;height:36px;border:3px solid var(--dim);border-top-color:var(--accent);
  border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.alert{padding:12px 14px;border-radius:10px;font-size:.88em;line-height:1.5}
.alert-error{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5}
.alert-success{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:#86efac}
.alert-info{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.3);color:#93c5fd}
.link-btn{background:none;border:none;color:var(--muted);font-size:.84em;cursor:pointer;
  text-decoration:underline;padding:4px;text-align:center;width:100%}
.sep{border:none;border-top:1px solid var(--dim);margin:0}
.google-badge{display:flex;align-items:center;gap:8px;padding:10px 14px;
  background:var(--surface);border-radius:10px;font-size:.88em}
.google-badge .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-ok{background:var(--success)}
.dot-no{background:#f59e0b}
.auth-group{border:1px solid var(--dim);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
details.how-to{background:var(--card);border-radius:var(--radius);overflow:hidden}
details.how-to summary{padding:12px 16px;cursor:pointer;font-size:.84em;color:var(--muted);
  display:flex;align-items:center;gap:6px;list-style:none;user-select:none}
details.how-to summary::-webkit-details-marker{display:none}
details.how-to summary::after{content:'›';margin-left:auto;font-size:1.1em;transition:transform .2s}
details.how-to[open] summary::after{transform:rotate(90deg)}
.how-to-body{padding:0 16px 14px;display:flex;flex-direction:column;gap:12px}
.how-to-os{font-size:.82em;line-height:1.7}
.how-to-os strong{color:var(--text);display:block;margin-bottom:2px}
[data-theme="light"]{
  --bg:#f1f5f9;--surface:#ffffff;--card:#dbeafe;
  --accent:#2563eb;--accent-light:#3b82f6;
  --text:#1e293b;--muted:#64748b;--dim:#cbd5e1;
  --success:#15803d;--error:#dc2626;--sort:#16a34a
}
.briefing-subtabs{position:sticky;top:env(safe-area-inset-top,0px);z-index:100;background:var(--bg);display:flex;border-bottom:1.5px solid var(--dim);padding:0 8px;margin-bottom:0;
  overflow-x:auto;-webkit-overflow-scrolling:touch}
.briefing-subtabs::-webkit-scrollbar{display:none}
.briefing-subtab{flex-shrink:0;padding:10px 12px;font-size:.84em;font-weight:700;background:none;
  border:none;border-bottom:2.5px solid transparent;color:var(--muted);cursor:pointer;
  transition:color .2s,border-color .2s;margin-bottom:-1.5px;-webkit-appearance:none;white-space:nowrap}
.briefing-subtab.active{color:var(--accent);border-bottom-color:var(--accent)}
.briefing-panel{display:none}
.briefing-panel.active{display:block;padding:16px 16px 0}
.tool-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:4px}
.tool-link-btn{display:flex;align-items:center;justify-content:center;
  padding:10px 8px;background:var(--accent);color:#fff;border-radius:10px;
  text-decoration:none;font-weight:600;font-size:.82em;text-align:center;
  transition:opacity .15s;line-height:1.3}
.tool-link-btn:active{opacity:.7}
/* ── 航路氣象 ────────────────────────────────────────────────────── */
.wx-routes{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px 8px;border-bottom:1px solid var(--dim)}
.wx-route-btn{padding:4px 10px;font-size:.76em;background:none;border:1.5px solid var(--dim);
  border-radius:14px;color:var(--muted);font-weight:500;cursor:pointer;transition:all .2s;margin:0;-webkit-appearance:none}
.wx-route-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
#briefing-datis.active{display:flex!important;flex-direction:column;padding:0!important}
.wx-fixed-header{position:sticky;top:calc(env(safe-area-inset-top,0px) + 38px);z-index:90;background:var(--bg)}
.wx-split{display:flex;flex-direction:column;flex:1}
.wx-list-pane{border-bottom:1px solid var(--dim)}
.wx-detail-pane{padding:16px}
.wx-card{margin:5px 10px 0;border-radius:10px;cursor:pointer;overflow:hidden;-webkit-tap-highlight-color:transparent}
.wx-card-r {border:2px solid var(--accent)}
.wx-card-a {border:2px dashed var(--accent);opacity:.8}
.wx-card-rs{border:2px solid #b45309}
.wx-card-as{border:2px dashed #b45309;opacity:.8}
.wx-card:active,.wx-card.selected{opacity:1;background:rgba(255,255,255,.06)}
.wx-legend{display:flex;gap:10px;flex-wrap:wrap;padding:8px 10px 10px;font-size:.71em;color:var(--muted);margin-top:2px}
.wx-hint-mobile{display:none}
@media(max-width:639px){.wx-hint-desktop{display:none}.wx-hint-mobile{display:inline}}
@media(min-width:640px){
  /* ── 預設：可捲動 ── */
  .briefing-subtabs{position:sticky;top:0;z-index:100;flex-shrink:0}
  .briefing-subtab{flex:1}
  .briefing-panel.active{padding:0}
  /* ── 需要固定高度的 tab：datis 分割面板、HF iframe ── */
  html:has(#tab-briefing.tab-active #briefing-datis.active),html:has(#tab-briefing.tab-active #briefing-hf.active),
  html:has(#tab-sync.tab-active),html:has(#tab-gate.tab-active){overflow:hidden;height:100dvh}
  html:has(#tab-briefing.tab-active #briefing-datis.active) body,html:has(#tab-briefing.tab-active #briefing-hf.active) body,
  html:has(#tab-sync.tab-active) body,html:has(#tab-gate.tab-active) body{overflow:hidden;height:100dvh}
  html:has(#tab-briefing.tab-active #briefing-datis.active) #tab-briefing.tab-active,
  html:has(#tab-briefing.tab-active #briefing-hf.active) #tab-briefing.tab-active{
    display:flex;flex-direction:column;
    height:calc(100dvh - calc(56px + env(safe-area-inset-bottom,0px)));
    min-height:unset;overflow:hidden;padding:0}
  #tab-sync.tab-active{height:calc(100dvh - calc(56px + env(safe-area-inset-bottom,0px)));
    min-height:unset;overflow-y:auto}
  #briefing-datis.active{display:flex;flex-direction:column;flex:1;overflow:hidden}
  #briefing-hf.active{display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0}
  .wx-fixed-header{position:static;flex-shrink:0}
  .wx-split{flex-direction:row;overflow:hidden;flex:1}
  .wx-list-pane{width:280px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--dim);border-bottom:none}
  .wx-detail-pane{flex:1;overflow-y:auto}
  /* ── 桌面版表格加大 ── */
  .dt-ref-table{font-size:.95em}
  .dt-ref-table th,.dt-ref-table td{padding:10px 14px}
}
#briefing-hf.active{padding:0;display:flex;flex-direction:column;
  height:calc(100dvh - calc(56px + env(safe-area-inset-bottom,0px)) - 40px)}
#hf-panel-iframe{flex:1;min-height:0}
.ct-panel{padding:16px;overflow-y:auto}
.ct-form{background:var(--card);border-radius:var(--radius);padding:16px;margin-bottom:16px}
@media(orientation:landscape) and (min-width:640px){
.ct-panel{display:flex;gap:12px;align-items:stretch;padding:8px 12px;
  height:calc(100dvh - 56px - env(safe-area-inset-bottom,0px) - 40px);overflow:hidden}
.ct-form{flex:0 0 auto;min-width:0;margin-bottom:0;
  display:flex;flex-direction:column;overflow:hidden}
.ct-form .ct-inputs{flex-shrink:0}
.ct-form .ct-grid{flex:1;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:1fr 1fr;gap:6px;margin-bottom:8px}
.ct-form .ct-calc-btn{flex-shrink:0}
.ct-table-wrap{flex:1;min-width:0;margin-bottom:0;
  display:flex;flex-direction:column;overflow:hidden}
.ct-table-wrap h3{flex-shrink:0}
.ct-table{flex:1}
.ct-table tbody{display:flex;flex-direction:column;height:100%}
.ct-table tbody tr{flex:1;display:flex}
.ct-table tbody td{flex:1;display:flex;align-items:center;justify-content:flex-end}
.ct-table tbody td:first-child{justify-content:flex-start}
.ct-table thead tr{display:flex}
.ct-table thead th{flex:1;display:flex;align-items:center;justify-content:flex-end}
.ct-table thead th:first-child{justify-content:flex-start}
}
.ct-inputs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.ct-input-group label{font-size:.72em;color:var(--muted);font-weight:600;display:block;margin-bottom:3px}
.ct-input-group input{width:100%;padding:7px 10px;background:var(--surface);border:1.5px solid var(--dim);
  border-radius:9px;color:var(--text);font-size:.9em;outline:none;-webkit-appearance:none}
.ct-input-group input:focus{border-color:var(--accent)}
.ct-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.ct-card{background:var(--surface);border-radius:10px;padding:8px 6px;display:flex;flex-direction:column;align-items:stretch;gap:4px}
.ct-card-label{font-size:.72em;font-weight:700;color:var(--accent-light);text-align:center;height:1.4em;display:flex;align-items:center;justify-content:center}
.ct-card-input{width:100%;padding:6px 4px;background:var(--card);border:1.5px solid var(--dim);
  border-radius:7px;color:var(--text);font-size:.88em;outline:none;text-align:center;-webkit-appearance:none}
.ct-card-input:focus{border-color:var(--accent)}
.ct-label-inp{width:100%;padding:4px 6px;background:var(--card);border:1.5px solid var(--dim);
  border-radius:7px;color:var(--muted);font-size:.72em;outline:none;text-align:center;-webkit-appearance:none}
.ct-label-inp:focus{border-color:var(--accent)}
.ct-card-result{font-size:.7em;font-weight:700;color:var(--accent-light);text-align:center;min-height:2.2em;line-height:1.4}
.ct-card-result.empty{color:var(--dim);font-weight:400}
.ct-calc-btn{width:100%;padding:12px;background:var(--accent);border:none;border-radius:10px;
  color:#fff;font-size:1em;font-weight:700;cursor:pointer;-webkit-appearance:none}
.ct-table-wrap{background:var(--card);border-radius:var(--radius);padding:16px;margin-bottom:16px;overflow-x:auto}
.ct-table-wrap h3{font-size:.85em;font-weight:700;color:var(--muted);margin-bottom:10px}
.ct-table{border-collapse:collapse;font-size:.75em;min-width:420px}
.ct-table th,.ct-table td{padding:5px 8px;text-align:right;border:1px solid var(--dim)}
.ct-table th{background:var(--surface);color:var(--muted);font-weight:700}
.ct-table th:first-child,.ct-table td:first-child{white-space:nowrap;width:1px}
.ct-table td:first-child{font-weight:700;color:var(--text);text-align:left;background:var(--surface)}
.ct-table td.ct-hi{background:rgba(59,130,246,.25);color:#fff;font-weight:700}
.ct-no-corr{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:10px;
  padding:12px 16px;color:#4ade80;font-size:.9em;font-weight:600;margin-top:12px;text-align:center}
/* ── Duty Time ── */
.dt-wrap{display:flex;flex-direction:column;overflow-y:auto;-webkit-overflow-scrolling:touch}
.dt-lock-overlay{position:absolute;inset:0;z-index:50;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:24px}
.dt-lock-card{background:var(--card);border-radius:16px;padding:28px 24px;width:100%;max-width:320px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.25)}
.dt-lock-icon{font-size:2.5em;margin-bottom:10px}
.dt-lock-title{font-size:1em;font-weight:800;color:var(--text);margin-bottom:4px}
.dt-lock-sub{font-size:.75em;color:var(--muted);margin-bottom:18px}
.dt-lock-input{width:100%;padding:12px;text-align:center;font-size:1.2em;letter-spacing:.2em;background:var(--surface);border:1.5px solid var(--dim);border-radius:10px;color:var(--text);margin-bottom:12px;box-sizing:border-box}
.dt-lock-btn{width:100%;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-size:.95em;font-weight:800;cursor:pointer}
.dt-lock-err{font-size:.78em;color:#ef4444;margin-top:8px;min-height:1.2em}
.dt-config{background:var(--card);border-bottom:1px solid var(--dim);padding:10px 14px 8px}
.dt-section-title{font-size:.68em;font-weight:800;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
.dt-crew-row{display:flex;gap:5px;margin-bottom:8px}
.dt-crew-btn{flex:1;padding:8px 4px;border-radius:8px;font-size:.78em;font-weight:700;border:1.5px solid var(--dim);background:none;color:var(--muted);cursor:pointer;line-height:1.3;text-align:center}
.dt-crew-btn.active{border-color:var(--accent);background:var(--accent);color:#fff}
.dt-opt-row{display:flex;align-items:center;gap:12px;margin-bottom:6px;flex-wrap:wrap}
.dt-chk-label{display:flex;align-items:center;gap:5px;font-size:.78em;color:var(--text);cursor:pointer}
.dt-chk-label input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;flex-shrink:0}
.dt-tz-select{background:var(--surface);border:1.5px solid var(--dim);border-radius:7px;color:var(--text);font-size:.78em;padding:4px 6px;max-width:160px}
.dt-mode-row{display:flex;gap:0;margin-bottom:0;border-radius:8px;overflow:hidden;border:1.5px solid var(--dim)}
.dt-mode-btn{flex:1;padding:7px;font-size:.8em;font-weight:700;border:none;background:none;color:var(--muted);cursor:pointer}
.dt-mode-btn.active{background:var(--accent);color:#fff}
.dt-body{padding:10px 14px 4px}
.dt-field{margin-bottom:10px}
.dt-field-label{font-size:.72em;font-weight:700;color:var(--muted);margin-bottom:4px}
.dt-time-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.dt-date-box{padding:7px 5px;background:var(--surface);border:1.5px solid var(--dim);border-radius:8px;color:var(--text);font-size:.85em;font-weight:600;width:48px;text-align:center}
.dt-time-box{width:40px;padding:7px 3px;text-align:center;font-size:.92em;font-weight:700;background:var(--surface);border:1.5px solid var(--dim);border-radius:8px;color:var(--text)}
.dt-sep{font-weight:700;color:var(--muted)}
.dt-tag{font-size:.68em;color:var(--muted);padding:2px 5px;border:1px solid var(--dim);border-radius:4px;white-space:nowrap}
.dt-calc-btn{width:100%;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-size:1em;font-weight:800;cursor:pointer;margin:8px 0 4px;letter-spacing:.03em}
.dt-results-wrap{padding:8px 14px 16px}
.dt-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.dt-card{background:var(--surface);border-radius:12px;padding:10px 12px;border-left:3px solid var(--dim)}
.dt-card.ok{border-left-color:#22c55e}.dt-card.warn{border-left-color:#f59e0b}.dt-card.err{border-left-color:#ef4444}
.dt-card-label{font-size:.63em;font-weight:700;color:var(--muted);margin-bottom:2px}
.dt-card-actual{font-size:1.25em;font-weight:800;line-height:1.1;color:var(--text)}
.dt-card-max{font-size:.67em;color:var(--muted);margin-top:2px}
.dt-card.ok .dt-card-actual{color:#22c55e}.dt-card.warn .dt-card-actual{color:#f59e0b}.dt-card.err .dt-card-actual{color:#ef4444}
.dt-rest-card{grid-column:1/-1;background:var(--surface);border-radius:12px;padding:10px 12px;border-left:3px solid var(--dim)}
.dt-rest-card.ok{border-left-color:#22c55e}.dt-rest-card.warn .dt-card-actual{color:#f59e0b}.dt-rest-card.err .dt-card-actual{color:#ef4444}
.dt-rest-card.ok .dt-card-actual{color:#22c55e}
.dt-wocl-box{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35);border-radius:10px;padding:8px 12px;margin-bottom:8px;font-size:.75em;color:#f59e0b;line-height:1.5}
.dt-tl2{background:var(--surface);border-radius:10px;padding:12px;margin-bottom:8px}
.dt-tl2-title{font-size:.63em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.dt-tl2-bars{position:relative;min-width:280px;width:100%;padding-bottom:2px;box-sizing:border-box}
.dt-tl2-track{position:relative;height:28px;margin-bottom:3px;width:100%}
.dt-tl2-track-sm{position:relative;height:11px;margin-bottom:3px}
.dt-tl2-seg{position:absolute;top:0;height:100%;border-radius:4px;display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:4px}
.dt-tl2-lbl{font-size:.67em;font-weight:700;color:#fff;padding:0 6px;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.5);pointer-events:none}
.dt-deadline-row{display:flex;gap:10px;margin-bottom:14px}
.dt-deadline-card{flex:1;background:var(--card);border-radius:12px;padding:14px 10px;text-align:center;border:2px solid rgba(59,130,246,.35)}
.dt-deadline-label{font-size:.7em;color:var(--muted);margin-bottom:6px;letter-spacing:.03em}
.dt-deadline-time{font-size:1.65em;font-weight:700;color:#60a5fa;font-variant-numeric:tabular-nums;letter-spacing:.04em}
.dt-deadline-dur{font-size:.72em;color:var(--muted);margin-top:4px}
.dt-ref-toggle{background:var(--card);border-radius:10px;padding:10px 14px;font-size:.8em;color:var(--muted);cursor:pointer;display:flex;justify-content:space-between;align-items:center;margin:6px 14px 2px;user-select:none}
.dt-ref-toggle:active{opacity:.7}
.dt-ref-panel{margin:0 14px 8px;background:var(--card);border-radius:10px;padding:14px;overflow-x:auto;display:none}
.dt-ref-title{font-weight:700;font-size:.85em;margin-bottom:2px;color:var(--fg)}
.dt-ref-sub{color:var(--muted);font-size:.78em;margin-bottom:8px}
.dt-ref-table{border-collapse:collapse;min-width:400px;width:100%;font-size:.75em}
.dt-ref-table th,.dt-ref-table td{border:1px solid rgba(148,163,184,.2);padding:5px 6px;text-align:center;vertical-align:middle;color:var(--fg)}
.dt-ref-table th{background:rgba(59,130,246,.15);color:#93c5fd;font-weight:600}
.dt-ref-table td.dt-ref-lbl{text-align:left;color:var(--muted);white-space:nowrap;font-size:.9em}
.dt-ref-note{margin-top:10px;color:var(--muted);font-size:.78em;line-height:1.65}
.dt-ref-note b{color:var(--fg)}
.dt-tl2-fdp{background:#22c55e}
.dt-tl2-maxfdp{background:repeating-linear-gradient(-45deg,#3b82f6 0,#3b82f6 7px,#93c5fd 7px,#93c5fd 14px)}
.dt-tl2-minrest{background:repeating-linear-gradient(-45deg,#f59e0b 0,#f59e0b 7px,#fcd34d 7px,#fcd34d 14px)}
.dt-tl2-rest{background:#374151}
.dt-tl2-wocl{position:absolute;top:0;bottom:0;background:rgba(167,139,250,.25);pointer-events:none;z-index:1}
.dt-tl2-vline{position:absolute;top:0;bottom:0;width:0;border-left:1.5px dashed rgba(148,163,184,.5);pointer-events:none;z-index:2}
.dt-tl2-ticks{position:relative;height:44px;min-width:280px;margin-top:4px}
.dt-tl2-tick{position:absolute;transform:translateX(-50%);text-align:center;font-size:.58em;color:var(--muted);line-height:1.35;white-space:nowrap}
.dt-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.dt-leg-item{display:flex;align-items:center;gap:4px;font-size:.62em;color:var(--muted)}
.dt-leg-box{width:11px;height:9px;border-radius:2px;flex-shrink:0}
.dt-ext-note{font-size:.72em;color:#a78bfa;margin-bottom:6px;padding:0 14px}
.dt-notice{font-size:.65em;color:var(--muted);text-align:center;padding:6px 0 14px}
.dt-ok{color:#22c55e}.dt-warn{color:#f59e0b}.dt-err{color:#ef4444}
.wx-row{display:flex;align-items:center;padding:9px 12px;gap:9px}
.wx-cat{font-size:.67em;font-weight:800;padding:2px 5px;border-radius:4px;
  flex-shrink:0;min-width:38px;text-align:center;letter-spacing:.3px}
.cat-VFR{background:#14532d;color:#86efac}
.cat-MVFR{background:#1e3a8a;color:#93c5fd}
.cat-IFR{background:#7f1d1d;color:#fca5a5}
.cat-LIFR{background:#581c87;color:#e9d5ff}
.cat-UNKN{background:var(--surface);color:var(--dim);border:1px solid var(--dim)}
.wx-icao-col{font-weight:700;font-size:.87em;flex-shrink:0;width:40px}
.wx-name-col{flex:1;min-width:0}
.wx-aname{font-size:.76em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wx-wind{font-size:.71em;color:var(--text);font-family:'Courier New',monospace;margin-top:1px}
.wx-mini{font-size:.71em;color:var(--muted);text-align:right;line-height:1.5;flex-shrink:0}
.wx-obs-age{font-size:.65em;color:var(--dim);text-align:right;margin-top:1px}
.wx-obs-age.warn{color:#f59e0b}
.wx-obs-age.stale{color:#ef4444}
.wx-list-hdr{display:flex;align-items:center;padding:6px 14px;border-bottom:1px solid var(--dim);
  background:var(--surface);position:sticky;top:0;z-index:10}
.wx-list-ts{font-size:.72em;color:var(--muted);flex:1}
.wx-refresh-btn{background:none;border:none;color:var(--accent);font-size:.82em;cursor:pointer;padding:4px 6px}
.wx-empty{text-align:center;padding:40px 20px;color:var(--muted);font-size:.88em;line-height:2}
.wx-detail-hdr{display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--dim)}
.wx-detail-title{font-weight:700;font-size:1em;color:var(--accent-light);flex:1}
.wx-loading-msg{text-align:center;padding:24px;color:var(--muted);font-size:.88em}
.metar-mode-btn{background:none;border:1px solid var(--dim);color:var(--muted);font-size:.72em;padding:2px 8px;border-radius:6px;cursor:pointer;-webkit-appearance:none}
.metar-mode-btn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.wx-flt-def{margin:0 10px 8px;font-size:.71em}
.wx-flt-def>summary{cursor:pointer;padding:3px 0;color:var(--accent);font-weight:600;user-select:none;list-style:none;-webkit-appearance:none}
.wx-flt-def>summary::-webkit-details-marker{display:none}
.wx-flt-def-body{margin-top:6px;display:flex;flex-direction:column;gap:5px;color:var(--muted);padding-bottom:2px}
.wx-flt-def-body>div{display:flex;align-items:center;gap:8px;line-height:1.4}
/* ── Gate Info ── */
#tab-gate{display:none;position:relative}
#tab-gate.tab-active{display:flex;flex-direction:column;
  height:calc(100dvh - calc(56px + env(safe-area-inset-bottom,0px)))}
#gate-content{display:flex;flex:1;flex-direction:column;min-height:0}
.gi-header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
  border-bottom:1px solid var(--dim);background:var(--bg);flex-shrink:0}
.gi-header-left{display:flex;flex-direction:column;gap:2px}
.gi-title{font-weight:700;font-size:.95em;color:var(--text)}
.gi-date{font-size:.72em;color:var(--muted)}
.gi-date-nav{display:flex;align-items:center;gap:6px}
.gi-nav-btn{background:none;border:1px solid var(--dim);color:var(--muted);border-radius:6px;
  padding:2px 8px;font-size:.72em;cursor:pointer;-webkit-appearance:none;line-height:1.4}
.gi-nav-btn:active{opacity:.6}
.gi-nav-btn:disabled{opacity:.25;cursor:default}
.gi-today-btn{color:var(--accent);border-color:var(--accent)}
.gi-refresh-btn{background:var(--accent);color:#fff;border:none;border-radius:8px;
  padding:8px 14px;font-size:.82em;font-weight:600;cursor:pointer;white-space:nowrap;-webkit-appearance:none}
.gi-refresh-btn:active{opacity:.7}
.gi-search-bar{display:flex;align-items:center;gap:0;padding:10px 14px;
  border-bottom:1px solid rgba(148,163,184,.1);flex-shrink:0}
.gi-search-label{font-size:.65em;color:var(--muted);margin-right:8px;white-space:nowrap}
.gi-search-input{flex:0;width:120px;padding:7px 12px;background:var(--surface);border:1.5px solid var(--dim);
  border-radius:8px;color:var(--text);font-size:.88em;outline:none;
  font-weight:600;-webkit-appearance:none}
.gi-search-input::placeholder{color:var(--dim);font-weight:400;font-size:.85em}
.gi-search-input:focus{border-color:var(--accent)}
.gi-status{text-align:center;padding:32px 16px;color:var(--muted);font-size:.88em}
.gi-table-wrap{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;min-height:0;overscroll-behavior:none}
.gi-table{table-layout:fixed;border-collapse:collapse;font-size:.75em;width:100%;min-width:900px}
.gi-table thead{position:sticky;top:0;z-index:5;background:var(--surface)}
.gi-table th{background:var(--surface);color:var(--muted);font-weight:700;padding:8px 6px;
  text-align:center;border-bottom:2px solid var(--dim);white-space:nowrap;font-size:.85em}
.gi-pinned-wrap{flex-shrink:0;overflow-x:auto;-webkit-overflow-scrolling:touch;max-height:35vh;overflow-y:auto;
  border-bottom:3px solid var(--accent);overscroll-behavior:none}
.gi-pinned-header-bar{background:rgba(59,130,246,.15);color:var(--accent-light);font-size:.72em;font-weight:700;
  text-align:center;padding:5px 6px;position:sticky;left:0;min-width:900px}
.gi-pinned-wrap .gi-table td{background:rgba(59,130,246,.06);border-bottom:1px solid rgba(148,163,184,.15)}
.gi-pinned-wrap .gi-sticky-col{background:rgba(59,130,246,.06)}
.gi-sortable{cursor:pointer;user-select:none;color:var(--sort)}
.gi-sortable:hover{opacity:.8}
.gi-sortable::after{content:'△▽';margin-left:3px;font-size:.55em;opacity:.7;letter-spacing:-2px}
.gi-sort-asc::after{content:'▲▽';opacity:1;color:var(--accent-light)}
.gi-sort-desc::after{content:'△▼';opacity:1;color:var(--accent-light)}
.gi-table td{padding:6px 6px;text-align:center;border-bottom:1px solid rgba(148,163,184,.15);
  white-space:nowrap;color:var(--text);overflow:hidden;text-overflow:ellipsis}
.gi-table tbody tr:hover{background:rgba(59,130,246,.08)}
.gi-fno{font-weight:700;color:var(--accent-light)!important}
.gi-sticky-col{position:sticky;left:0;z-index:3;background:var(--surface)}
.gi-table tbody .gi-sticky-col{background:var(--bg)}
.gi-separator td{height:12px;border-bottom:2px solid var(--accent);background:none}
.gi-test-header td{background:#f59e0b22;color:#f59e0b;font-size:.75em;font-weight:700;text-align:center;padding:6px}
.gi-test-row{background:#f59e0b11}
.gi-test-row td{color:#f59e0b;font-size:.82em}
.gi-hide-time .gi-time-col{display:none}
.gi-header-btns{display:flex;gap:8px;align-items:center}
.gi-time-btn{background:none;color:var(--muted);border:1.5px solid var(--dim);border-radius:8px;
  padding:8px 12px;font-size:.82em;font-weight:600;cursor:pointer;white-space:nowrap;-webkit-appearance:none}
.gi-time-btn-on{border-color:var(--accent);color:var(--accent)}
.gi-notice-inline{font-size:.62em;color:var(--muted);margin-top:1px}
.privacy-card{background:var(--card);border-radius:16px;padding:24px 20px;width:100%;
  max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.25);max-height:85vh;display:flex;flex-direction:column}
.privacy-body{text-align:left;overflow-y:auto;margin-bottom:14px;flex:1;min-height:0}
.privacy-q{font-weight:700;font-size:.85em;color:var(--accent-light);margin:14px 0 6px;line-height:1.4}
.privacy-q:first-child{margin-top:0}
.privacy-a{font-size:.78em;color:var(--text);line-height:1.65;margin-bottom:4px}
`;
}
