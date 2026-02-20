import express from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { OUTPUT_DIR, ROOT, loadCredentials } from './config.js';
import { generateICSHeadless } from './generate-ics-headless.js';
import { syncICS, SyncResult } from './upload-ics.js';

config({ path: path.join(ROOT, '.env') });

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Determine redirect URI: env var > BASE_URL-derived > credentials.json
const _creds = loadCredentials();
const REDIRECT_URI: string = process.env.REDIRECT_URI
  || (process.env.BASE_URL ? `${process.env.BASE_URL}/api/oauth2callback` : _creds.web.redirect_uris[0]);
const _ru = new URL(REDIRECT_URI);
const REDIRECT_PORT = parseInt(_ru.port) || (REDIRECT_URI.startsWith('https') ? 443 : 80);
const REDIRECT_PATH = _ru.pathname;

// ── Job state ────────────────────────────────────────────────────────────────

interface SyncJob {
  status: 'running' | 'done' | 'error';
  logs: string[];
  result?: SyncResult;
  newRefreshToken?: string;
  error?: string;
  startedAt: Date;
  icsPath: string;
}

const jobs = new Map<string, SyncJob>();

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.startedAt.getTime() < cutoff) {
      try { if (fs.existsSync(job.icsPath)) fs.unlinkSync(job.icsPath); } catch {}
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── Server ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getSPAHtml());
});

app.get('/icon.svg', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="38" fill="#1e2740"/>
  <text x="96" y="145" text-anchor="middle" font-size="115"
    font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">✈️</text>
</svg>`);
});

app.get('/manifest.json', (_req, res) => {
  res.json({
    name: 'CrewSync',
    short_name: 'CrewSync',
    description: 'Crew Roster → Google Calendar',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0e1a',
    theme_color: '#1e2740',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  });
});

app.get('/oauth/url', (_req, res) => {
  try {
    const creds = loadCredentials();
    const client = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret, REDIRECT_URI);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      scope: ['https://www.googleapis.com/auth/calendar'],
    });
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get(REDIRECT_PATH, oauthCallback);
app.get('/api/oauth2callback', oauthCallback); // 雲端路徑
app.get('/oauth/callback', oauthCallback);     // 本機 fallback

// ── METAR proxy ────────────────────────────────────────────────────────────────
app.get('/api/metar', async (req, res) => {
  try {
    const { ids, hours } = req.query;
    const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&format=raw&hours=${hours || 1}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (e: any) {
    res.status(502).send('');
  }
});

// ── Pacific HF proxy ──────────────────────────────────────────────────────────
app.get('/api/pacific-hf', async (_req, res) => {
  try {
    const r = await fetch('https://radio.arinc.net/pacific/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' }
    });
    let html = await r.text();
    // 注入 base tag 讓相對路徑可以正確載入
    html = html.replace(/<head>/i, '<head><base href="https://radio.arinc.net/">');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e: any) {
    res.status(502).send(`<p style="font-family:sans-serif;padding:20px;color:red">無法載入 Pacific HF 資料：${e.message}</p>`);
  }
});

async function oauthCallback(req: express.Request, res: express.Response) {
  const { code } = req.query;
  if (!code) { res.status(400).send('Missing code'); return; }
  try {
    const creds = loadCredentials();
    const client = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret, REDIRECT_URI);
    const { tokens } = await client.getToken(code as string);
    const rt = tokens.refresh_token ?? '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0a0e1a;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style>
</head><body>
<div><p style="font-size:2.5em">✅</p><p>授權完成！<br>正在關閉視窗...</p></div>
<script>
  try { window.opener && window.opener.postMessage({ type:'oauth_done', refreshToken:${JSON.stringify(rt)} }, '*'); } catch(e){}
  setTimeout(() => window.close(), 1000);
</script></body></html>`);
  } catch (err: any) {
    res.status(500).send(`<p>授權失敗：${err.message}</p>`);
  }
}

app.get('/debug/screenshot', (_req, res) => {
  // 找最新的 debug 截圖
  try {
    if (!fs.existsSync(OUTPUT_DIR)) { res.status(404).send('No screenshot'); return; }
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('-debug.png'))
      .map(f => ({ f, t: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) { res.status(404).send('No screenshot yet. Run a sync first.'); return; }
    res.sendFile(path.join(OUTPUT_DIR, files[0].f));
  } catch (err: any) { res.status(500).send(err.message); }
});

app.post('/sync', async (req, res) => {
  const { year, month, jxUsername, jxPassword, refreshToken, calendarId } = req.body;
  if (!year || !month || !jxUsername || !jxPassword || !refreshToken || !calendarId) {
    res.status(400).json({ error: '缺少必要參數' });
    return;
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const jobId = randomUUID();
  const icsPath = path.join(OUTPUT_DIR, `roster-${jobId}.ics`);
  const job: SyncJob = { status: 'running', logs: [], startedAt: new Date(), icsPath };
  jobs.set(jobId, job);

  const onLog = (msg: string) => { job.logs.push(msg); };

  (async () => {
    try {
      await generateICSHeadless(Number(year), Number(month), { username: jxUsername, password: jxPassword }, icsPath, onLog);
      const { result, newRefreshToken } = await syncICS({ refreshToken, calendarId, icsPath, onLog });
      job.result = result;
      if (newRefreshToken) job.newRefreshToken = newRefreshToken;
      job.status = 'done';
    } catch (err: any) {
      job.error = err.message;
      job.status = 'error';
      onLog(`❌ 錯誤：${err.message}`);
    } finally {
      try { if (fs.existsSync(icsPath)) fs.unlinkSync(icsPath); } catch {}
    }
  })();

  res.json({ jobId });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: '找不到此工作' }); return; }
  res.json({ status: job.status, logs: job.logs, result: job.result, newRefreshToken: job.newRefreshToken, error: job.error });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 CrewSync 伺服器啟動：${BASE_URL}`);
});

// If the registered redirect URI is on a different port, start a second mini-server for it
if (REDIRECT_PORT && REDIRECT_PORT !== Number(PORT)) {
  const callbackApp = express();
  callbackApp.get(REDIRECT_PATH, oauthCallback);
  callbackApp.listen(REDIRECT_PORT, '0.0.0.0', () => {
    console.log(`🔑 OAuth callback 監聽：${REDIRECT_URI}`);
  });
}

// ── SPA HTML ─────────────────────────────────────────────────────────────────

function getSPAHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,minimum-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="CrewSync">
<meta name="theme-color" content="#0a0e1a">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<title>CrewSync</title>
<style>
html{overscroll-behavior:none}
html::before{content:'';position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);background:var(--bg);z-index:9999}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0a0e1a;--surface:#141927;--card:#1e2740;
  --accent:#3b82f6;--accent-light:#60a5fa;
  --text:#e2e8f0;--muted:#94a3b8;--dim:#475569;
  --success:#22c55e;--error:#ef4444;
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
  --success:#15803d;--error:#dc2626
}
.briefing-subtabs{position:sticky;top:env(safe-area-inset-top,0px);z-index:100;background:var(--bg);display:flex;border-bottom:1.5px solid var(--dim);padding:0 16px;margin-bottom:0}
.briefing-subtab{flex:1;padding:10px 4px;font-size:.84em;font-weight:700;background:none;
  border:none;border-bottom:2.5px solid transparent;color:var(--muted);cursor:pointer;
  transition:color .2s,border-color .2s;margin-bottom:-1.5px;-webkit-appearance:none}
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
  #briefing-datis.active{height:calc(100dvh - 150px - env(safe-area-inset-top,0px));overflow:hidden;
    display:flex;flex-direction:column}
  .wx-fixed-header{position:static;flex-shrink:0}
  .wx-split{flex-direction:row;overflow:hidden;flex:1}
  .wx-list-pane{width:280px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--dim);border-bottom:none}
  .wx-detail-pane{flex:1;overflow-y:auto}}
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
</style>
</head>
<body>

<!-- ══ Tab: 同步 ═════════════════════════════════════════════════════ -->
<div id="tab-sync">

<!-- ══ Main（含帳號 + 月份，一個畫面搞定）══════════════════════════════ -->
<div id="screen-main" class="screen active">
  <div class="logo">
    <span class="logo-icon">✈️</span>
    <div class="logo-title">CrewSync</div>
    <div class="logo-sub">Crew Roster → Google Calendar</div>
  </div>

  <div class="card">
    <!-- Google auth group -->
    <div class="auth-group">
      <div id="google-badge" class="google-badge" style="padding:0">
        <div class="dot dot-no" id="google-dot"></div>
        <div id="google-badge-text" style="flex:1;color:var(--muted)">尚未授權 Google 日曆（第一次需要）</div>
        <button class="btn btn-secondary btn-sm" id="google-auth-btn"
          onclick="doGoogleAuth()" style="width:auto;padding:6px 12px;font-size:.82em">授權</button>
      </div>
      <details class="how-to" style="background:var(--surface);border-radius:8px">
        <summary>🔐 首次授權出現警告？</summary>
        <div class="how-to-body">
          <div class="how-to-os">
            Google 會顯示「這個應用程式未經驗證」的警告畫面，這是正常的：<br><br>
            1. 點左下角「<b>進階</b>」<br>
            2. 點「<b>前往 crew-sync.onrender.com（不安全）</b>」<br>
            3. 點「<b>繼續</b>」完成授權
          </div>
        </div>
      </details>
    </div>
    <div id="cred-error" class="alert alert-error" style="display:none"></div>

    <form id="cred-form" autocomplete="on" onsubmit="submitCredentials(event)">
      <div class="field">
        <label>班表帳號</label>
        <input type="text" id="jx-user" name="username"
          autocomplete="username" inputmode="numeric" placeholder="員工編號" required>
      </div>
      <div class="field" style="margin-top:10px">
        <label>班表密碼</label>
        <input type="password" id="jx-pass" name="password"
          autocomplete="current-password" placeholder="班表登入密碼">
      </div>
      <hr class="sep" style="margin:4px 0">
      <div style="font-weight:600;font-size:.9em">同步月份</div>
      <div class="month-row">
        <div class="field">
          <label>年</label>
          <select id="sync-year"></select>
        </div>
        <div class="field">
          <label>月</label>
          <select id="sync-month"></select>
        </div>
      </div>
      <div style="height:4px"></div>
      <button type="submit" class="btn btn-primary">🚀 開始同步</button>
    </form>
  </div>

  <details class="how-to">
    <summary>📲 如何加入主畫面？</summary>
    <div class="how-to-body">
      <div class="how-to-os">
        <strong>🍎 iPhone / iPad（Safari）</strong>
        1. 點底部 <b>分享</b> 按鈕（方框加箭頭）<br>
        2. 向下滑，點「<b>加入主畫面</b>」<br>
        3. 右上角點「<b>新增</b>」
      </div>
      <div class="how-to-os">
        <strong>🤖 Android（Chrome）</strong>
        1. 點右上角 <b>⋮</b> 選單<br>
        2. 點「<b>新增至主畫面</b>」或「<b>安裝應用程式</b>」<br>
        3. 點「<b>新增</b>」
      </div>
    </div>
  </details>

  <div style="text-align:center">
    <button class="link-btn" onclick="showSettings()">⚙️ 設定</button>
  </div>
</div>

<!-- ══ Syncing ════════════════════════════════════════════════════════════ -->
<div id="screen-syncing" class="screen">
  <div class="logo">
    <span class="logo-icon">✈️</span>
    <div class="logo-title">CrewSync</div>
  </div>
  <div class="card">
    <div style="display:flex;align-items:center;gap:12px">
      <div class="spinner"></div>
      <div id="sync-status-text" style="font-size:.9em;color:var(--muted)">正在同步...</div>
    </div>
    <div id="sync-log" class="log-box">等待開始...</div>
  </div>
</div>

<!-- ══ Done ══════════════════════════════════════════════════════════════ -->
<div id="screen-done" class="screen">
  <div class="logo">
    <span class="logo-icon">✈️</span>
    <div class="logo-title">CrewSync</div>
  </div>
  <div class="card">
    <div id="done-title" style="font-weight:700;font-size:1.1em;text-align:center"></div>
    <div id="done-stats" class="stats"></div>
    <div id="done-log" class="log-box" style="max-height:25vh"></div>
    <button class="btn btn-secondary" onclick="showMain()">← 返回</button>
  </div>
</div>

<!-- ══ Settings ══════════════════════════════════════════════════════════ -->
<div id="screen-settings" class="screen">
  <div class="logo">
    <span class="logo-icon">⚙️</span>
    <div class="logo-title">設定</div>
  </div>
  <div class="card">
    <div style="font-weight:600;font-size:.9em;color:var(--muted)">Google 日曆授權狀態</div>
    <div id="settings-google-badge" class="google-badge">
      <div class="dot" id="settings-google-dot"></div>
      <div id="settings-google-text" style="flex:1;color:var(--muted)"></div>
    </div>
    <button class="btn btn-secondary btn-sm" onclick="doGoogleAuthFromSettings()">🔄 重新授權 Google 日曆</button>
    <hr class="sep">
    <div id="settings-msg" class="alert" style="display:none"></div>
    <button class="btn btn-danger btn-sm" onclick="clearSavedData()">🗑️ 清除已儲存的資料</button>
    <button class="btn btn-secondary" onclick="showMain()">← 返回</button>
  </div>
</div>

</div><!-- end tab-sync -->

<!-- ══ Tab: A350簡報箱 ══════════════════════════════════════════════ -->
<div id="tab-briefing" class="tab-active">

  <!-- 子 Tab Bar -->
  <div class="briefing-subtabs">
    <button class="briefing-subtab" id="subtabBtn-tools" onclick="switchBriefingTab('tools',this)">🗺️ 工具連結</button>
    <button class="briefing-subtab active" id="subtabBtn-datis" onclick="switchBriefingTab('datis',this)">⛅ Airport WX</button>
  </div>

  <!-- ── 工具連結 panel ── -->
  <div id="briefing-tools" class="briefing-panel">
    <div class="briefing-section">
      <div class="tool-grid">
        <a class="tool-link-btn" href="https://flight-plan-editor.weathernews.com/flight_plan_editor/#login" target="_blank">☁️ Weathernews Flight Plan</a>
        <a class="tool-link-btn" href="https://pilotstarspace.starlux-airlines.com/#/" target="_blank">🌟 SJX Pilot Space</a>
        <a class="tool-link-btn" href="https://elb.starlux-airlines.com/elb/#/dashboard/fleet" target="_blank">🧰 STARLUX ELB Fleet</a>
        <a class="tool-link-btn" href="https://tono2.net" target="_blank" onclick="return loadTool(event,this)">🇯🇵 Tono2 航空氣象</a>
        <a class="tool-link-btn" href="https://sjx.lido.aero/lido/las/login.jsp?DESMON_RESULT_PAGE=https://sjx.lido.aero/briefing&DESMON_CODE=LAS_001&DESMON_LANG=null" target="_blank">📋 LIDO Briefing</a>
        <a class="tool-link-btn" href="https://www.skyinfo.jp" target="_blank" onclick="return loadTool(event,this)">🇯🇵 日本NOTAM地圖</a>
        <a class="tool-link-btn" href="https://app.cwa.gov.tw/web/obsmap/typhoon.html" target="_blank" onclick="return loadTool(event,this)">🌀 颱風路徑圖</a>
        <a class="tool-link-btn" href="https://gpsjam.org/" target="_blank" onclick="return loadTool(event,this)">🛰️ GPS干擾區域</a>
        <a class="tool-link-btn" href="https://radio.arinc.net/pacific/" target="_blank" onclick="return openHF(event)">📻 Pacific HF 查詢</a>
      </div>
      <!-- 內嵌 iframe -->
      <div id="tool-frame-wrap" style="display:none;margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span id="tool-frame-title" style="font-weight:700;font-size:.9em;color:var(--text)"></span>
          <div style="display:flex;gap:10px;align-items:center">
            <a id="tool-frame-external" href="#" target="_blank" style="font-size:.8em;color:var(--accent);text-decoration:none">↗ 新分頁</a>
            <button onclick="closeTool()" style="background:none;border:none;color:var(--muted);font-size:1.1em;cursor:pointer;padding:0 4px">✕</button>
          </div>
        </div>
        <iframe id="tool-frame" src="" style="width:100%;height:65vh;border:none;border-radius:12px;background:var(--surface)"></iframe>
      </div>
    </div>
  </div>

  <!-- ── ⛅ 航路氣象 / D-ATIS panel ── -->
  <div id="briefing-datis" class="briefing-panel active">
    <div class="wx-fixed-header">
      <div class="wx-routes">
        <button class="wx-route-btn active" onclick="selectWxRegion('taiwan',this)">台灣</button>
        <button class="wx-route-btn" onclick="selectWxRegion('hkmacao',this)">港澳</button>
        <button class="wx-route-btn" onclick="selectWxRegion('japan',this)">日本</button>
        <button class="wx-route-btn" onclick="selectWxRegion('korea',this)">韓國</button>
        <button class="wx-route-btn" onclick="selectWxRegion('philippines',this)">菲律賓</button>
        <button class="wx-route-btn" onclick="selectWxRegion('thailand',this)">泰國</button>
        <button class="wx-route-btn" onclick="selectWxRegion('vietnam',this)">越南柬埔寨</button>
        <button class="wx-route-btn" onclick="selectWxRegion('seasia',this)">星馬印</button>
        <button class="wx-route-btn" onclick="selectWxRegion('usa',this)">美國</button>
        <button class="wx-route-btn" onclick="selectWxRegion('pacific',this)">阿拉斯加太平洋</button>
        <button class="wx-route-btn" onclick="selectWxRegion('canada',this)">加拿大</button>
        <button class="wx-route-btn" onclick="selectWxRegion('europe',this)">歐洲</button>
      </div>
      <div style="background:rgba(245,158,11,.08);border-bottom:1px solid rgba(245,158,11,.25);padding:5px 14px;font-size:.72em;color:#f59e0b;display:flex;align-items:center;gap:6px">
        <span>⚠</span><span>Non-operational use only. Data may not reflect current conditions.</span>
      </div>
    </div>
    <div class="wx-split">
      <div class="wx-list-pane" id="wx-list-pane">
        <div class="wx-loading-msg">載入氣象資料中...</div>
      </div>
      <div class="wx-detail-pane" id="wx-detail-pane">
        <div class="wx-empty"><span class="wx-hint-desktop">← 點選左側機場</span><span class="wx-hint-mobile">↑ 點選上方機場</span><br>查看 METAR · TAF · ATIS</div>
      </div>
    </div>
  </div>

</div><!-- end tab-briefing -->

<!-- ══ Pacific HF 全螢幕 Overlay ════════════════════════════════════ -->
<div id="hf-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:500;background:#fff;flex-direction:column">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top,0px) + 8px) 16px 8px;background:#1e293b;border-bottom:1px solid #334155;flex-shrink:0">
    <span style="font-weight:700;font-size:.95em;color:#e2e8f0">📻 Pacific HF 查詢</span>
    <div style="display:flex;gap:14px;align-items:center">
      <a href="https://radio.arinc.net/pacific/" target="_blank" style="font-size:.82em;color:#7dd3fc;text-decoration:none">↗ 新分頁</a>
      <button onclick="closeHF()" style="background:none;border:none;color:#94a3b8;font-size:1.3em;cursor:pointer;padding:0 2px;line-height:1">✕</button>
    </div>
  </div>
  <iframe id="hf-iframe" src="" style="flex:1;border:none;width:100%"></iframe>
</div>

<!-- ══ Tab Bar ═══════════════════════════════════════════════════════ -->
<div class="tab-bar">
  <button class="tab-btn" id="tabBtn-sync" onclick="switchTab('sync',this)">
    <span class="tab-btn-icon">✈️</span>班表同步
  </button>
  <button class="tab-btn tab-active" id="tabBtn-briefing" onclick="switchTab('briefing',this)">
    <span class="tab-btn-icon">📦</span>A350簡報箱
  </button>
  <button class="tab-btn" id="tabBtn-theme" onclick="toggleTheme()">
    <span class="tab-btn-icon" id="theme-icon">☀️</span><span id="theme-label">日間</span>
    <span style="font-size:.55em;color:var(--dim);line-height:1;opacity:.7">V2.1</span>
  </button>
</div>

<script>
// ── State ────────────────────────────────────────────────────────────────────
let refreshToken = localStorage.getItem('crewsync_rt') || '';
let currentJobId = null;
let pollTimer = null;
let pendingSyncParams = null;

// ── Screen ───────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Init / Main ──────────────────────────────────────────────────────────────
function showMain() {
  const now = new Date();
  const yr = document.getElementById('sync-year');
  const mo = document.getElementById('sync-month');
  yr.innerHTML = '';
  for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
    yr.innerHTML += '<option value="' + y + '"' + (y === now.getFullYear() ? ' selected' : '') + '>' + y + ' 年</option>';
  }
  mo.innerHTML = '';
  ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'].forEach((m, i) => {
    mo.innerHTML += '<option value="' + (i+1) + '"' + (i+1 === now.getMonth()+1 ? ' selected' : '') + '>' + m + '</option>';
  });
  // Pre-fill saved values
  document.getElementById('jx-user').value = localStorage.getItem('crewsync_user') || '';
  document.getElementById('cred-error').style.display = 'none';
  updateGoogleBadge();
  showScreen('screen-main');
}

function updateGoogleBadge() {
  const hasToken = !!refreshToken;
  const dot  = document.getElementById('google-dot');
  const text = document.getElementById('google-badge-text');
  const btn  = document.getElementById('google-auth-btn');
  dot.className  = 'dot ' + (hasToken ? 'dot-ok' : 'dot-no');
  text.textContent = hasToken ? '✅ 已授權 Google 日曆' : '尚未授權 Google 日曆（首次需要）';
  text.style.color = hasToken ? 'var(--success)' : 'var(--muted)';
  btn.textContent  = hasToken ? '重新授權' : '授權';
}

async function doGoogleAuth() {
  const btn = document.getElementById('google-auth-btn');
  btn.disabled = true; btn.textContent = '等待中...';
  try {
    const res = await fetch('/oauth/url');
    const { url, error } = await res.json();
    if (error) throw new Error(error);
    const popup = window.open(url, 'google-oauth', 'width=500,height=650,left=50,top=50');
    if (!popup) throw new Error('請允許此網頁開啟彈出視窗後再試');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('授權逾時，請重試')), 120000);
      function onMsg(e) {
        if (e.data && e.data.type === 'oauth_done') {
          clearTimeout(timer); window.removeEventListener('message', onMsg);
          if (!e.data.refreshToken) reject(new Error('未收到授權碼，請重試'));
          else { refreshToken = e.data.refreshToken; localStorage.setItem('crewsync_rt', refreshToken); resolve(); }
        }
      }
      window.addEventListener('message', onMsg);
    });
    updateGoogleBadge();
    // If we were waiting for auth to proceed with sync, continue
    if (pendingSyncParams) {
      const p = pendingSyncParams; pendingSyncParams = null;
      startSyncJob(p);
    }
  } catch (err) {
    document.getElementById('cred-error').textContent = err.message;
    document.getElementById('cred-error').style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = refreshToken ? '重新授權' : '授權';
  }
}

function showSettings() {
  updateSettingsPage();
  showScreen('screen-settings');
}

async function doGoogleAuthFromSettings() {
  const msgEl = document.getElementById('settings-msg');
  msgEl.className = 'alert alert-info'; msgEl.style.display = ''; msgEl.textContent = '等待 Google 授權...';
  try {
    const res = await fetch('/oauth/url');
    const { url, error } = await res.json();
    if (error) throw new Error(error);
    const popup = window.open(url, 'google-oauth', 'width=500,height=650,left=50,top=50');
    if (!popup) throw new Error('請允許此網頁開啟彈出視窗後再試');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('授權逾時')), 120000);
      function onMsg(e) {
        if (e.data && e.data.type === 'oauth_done') {
          clearTimeout(timer); window.removeEventListener('message', onMsg);
          if (!e.data.refreshToken) reject(new Error('未收到授權碼'));
          else { refreshToken = e.data.refreshToken; localStorage.setItem('crewsync_rt', refreshToken); resolve(); }
        }
      }
      window.addEventListener('message', onMsg);
    });
    msgEl.className = 'alert alert-success'; msgEl.textContent = '✅ 重新授權成功！';
    updateSettingsPage();
  } catch (err) {
    msgEl.className = 'alert alert-error'; msgEl.textContent = err.message;
  }
}

function updateSettingsPage() {
  const hasToken = !!refreshToken;
  document.getElementById('settings-google-dot').className = 'dot ' + (hasToken ? 'dot-ok' : 'dot-no');
  document.getElementById('settings-google-text').textContent = hasToken ? '已授權 Google 日曆' : '尚未授權';
  document.getElementById('settings-google-text').style.color = hasToken ? 'var(--success)' : 'var(--muted)';
}

function clearSavedData() {
  if (!confirm('確定要清除所有儲存的資料嗎？')) return;
  localStorage.removeItem('crewsync_rt');
  localStorage.removeItem('crewsync_user');
  refreshToken = '';
  const el = document.getElementById('settings-msg');
  el.className = 'alert alert-success'; el.style.display = ''; el.textContent = '✅ 資料已清除';
  updateSettingsPage();
}

// ── Submit credentials & sync ────────────────────────────────────────────────
function submitCredentials(e) {
  e.preventDefault();
  document.getElementById('cred-error').style.display = 'none';

  const jxUser = document.getElementById('jx-user').value.trim();
  const jxPass = document.getElementById('jx-pass').value;

  if (!jxUser || !jxPass) {
    document.getElementById('cred-error').textContent = '請填入員工編號和密碼';
    document.getElementById('cred-error').style.display = '';
    return;
  }

  // 儲存帳號供下次預填（密碼由瀏覽器密碼管理器處理）
  localStorage.setItem('crewsync_user', jxUser);

  const year  = parseInt(document.getElementById('sync-year').value);
  const month = parseInt(document.getElementById('sync-month').value);
  const params = { year, month, jxUsername: jxUser, jxPassword: jxPass, calendarId: 'primary' };

  if (!refreshToken) {
    // Need Google auth first
    pendingSyncParams = params;
    document.getElementById('cred-error').textContent = '請先點擊上方「授權」按鈕完成 Google 日曆授權';
    document.getElementById('cred-error').style.display = '';
    return;
  }

  startSyncJob(params);
}

async function startSyncJob(params) {
  const { year, month, jxUsername, jxPassword, calendarId } = params;
  document.getElementById('sync-log').textContent = '準備中...';
  document.getElementById('sync-status-text').textContent = '正在同步 ' + year + '年' + month + '月...';
  showScreen('screen-syncing');

  try {
    const res = await fetch('/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month, jxUsername, jxPassword, refreshToken, calendarId }),
    });
    const { jobId, error } = await res.json();
    if (error) throw new Error(error);
    currentJobId = jobId;
    pollStatus();
  } catch (err) {
    showDone(false, [], null, err.message);
  }
}

function pollStatus() {
  if (!currentJobId) return;
  pollTimer = setInterval(async () => {
    try {
      const data = await fetch('/status/' + currentJobId).then(r => r.json());
      const logEl = document.getElementById('sync-log');
      logEl.textContent = data.logs.join('\\n') || '等待中...';
      logEl.scrollTop = logEl.scrollHeight;
      if (data.status === 'done' || data.status === 'error') {
        clearInterval(pollTimer); pollTimer = null;
        if (data.newRefreshToken) {
          refreshToken = data.newRefreshToken;
          localStorage.setItem('crewsync_rt', refreshToken);
        }
        showDone(data.status === 'done', data.logs, data.result, data.error);
      }
    } catch (err) {
      clearInterval(pollTimer); pollTimer = null;
      showDone(false, [], null, '網路錯誤：' + err.message);
    }
  }, 2000);
}

function showDone(success, logs, result, error) {
  const titleEl = document.getElementById('done-title');
  const statsEl = document.getElementById('done-stats');
  titleEl.textContent = success ? '✅ 同步完成！' : '❌ 同步失敗';
  titleEl.style.color = success ? 'var(--success)' : 'var(--error)';
  if (success && result) {
    statsEl.innerHTML =
      mkStat(result.addedCount,'新增') + mkStat(result.updatedCount,'更新') +
      mkStat(result.deletedCount,'刪除') + mkStat(result.totalCount,'總計');
  } else {
    statsEl.innerHTML = error ? '<div class="alert alert-error" style="width:100%">' + error + '</div>' : '';
  }
  document.getElementById('done-log').textContent = logs.join('\\n') || '';
  showScreen('screen-done');
}

function mkStat(n, label) {
  return '<div class="stat-item"><div class="stat-num">' + n + '</div><div class="stat-lbl">' + label + '</div></div>';
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab, btn) {
  document.getElementById('tab-sync').classList.remove('tab-active');
  document.getElementById('tab-briefing').classList.remove('tab-active');
  document.getElementById('tab-sync').style.display = '';
  document.getElementById('tab-briefing').style.display = '';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
  document.getElementById('tab-' + tab).classList.add('tab-active');
  btn.classList.add('tab-active');
  window.scrollTo(0, 0);
}

// ── D-ATIS ────────────────────────────────────────────────────────────────────
var currentAtisUrl = '';
var currentAtisIcao = '';

function switchDatisRegion(region, tab) {
  document.querySelectorAll('.datis-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  document.querySelectorAll('.datis-btn').forEach(btn => {
    if (region === 'all' || btn.dataset.region === region) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  });
}

function openDatisLink(url, btn) {
  document.querySelectorAll('.datis-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  const icao = btn.textContent.trim().substring(0, 4);
  currentAtisUrl = url;
  currentAtisIcao = icao;
  const display = document.getElementById('datisDisplay');
  const label = document.getElementById('datisLabel');
  const content = document.getElementById('datisContent');
  label.textContent = btn.querySelector('span') ? icao + ' ' + btn.querySelector('span').textContent : icao;
  content.innerHTML = '<div class="atis-loading">載入中...</div>';
  display.style.display = 'block';
  fetchAtisData(url, icao, content);
  display.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function reloadCurrentAtis() {
  if (currentAtisUrl) {
    const content = document.getElementById('datisContent');
    content.innerHTML = '<div class="atis-loading">重新載入中...</div>';
    fetchAtisData(currentAtisUrl, currentAtisIcao, content);
  }
}

function fetchAtisData(url, icao, container) {
  const corsProxy = 'https://api.codetabs.com/v1/proxy/?quest=';
  const metarUrl = 'https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=raw&hours=12';
  const tafUrl = 'https://aviationweather.gov/api/data/taf?ids=' + icao + '&format=raw';
  const atisPromise = fetch(corsProxy + encodeURIComponent(url))
    .then(r => { if (!r.ok) throw new Error(); return r.text(); })
    .then(html => parseAtisHtml(html))
    .catch(() => []);
  const metarPromise = fetch(corsProxy + encodeURIComponent(metarUrl))
    .then(r => { if (!r.ok) throw new Error(); return r.text(); })
    .then(t => t.trim()).catch(() => '');
  const tafPromise = fetch(corsProxy + encodeURIComponent(tafUrl))
    .then(r => { if (!r.ok) throw new Error(); return r.text(); })
    .then(t => t.trim()).catch(() => '');
  Promise.all([atisPromise, metarPromise, tafPromise]).then(([atisSections, metarText, tafText]) => {
    const atisOnly = atisSections.filter(s => {
      const t = s.title.toLowerCase();
      return !t.includes('metar') && !t.includes('taf');
    });
    const noData = '<span style="color:var(--muted);font-style:italic">無資料</span>';
    let cards = '';
    if (atisOnly.length > 0) {
      cards += atisOnly.map(s =>
        '<div class="atis-card"><div class="atis-card-title">' + s.title + '</div><pre>' + s.text + '</pre></div>'
      ).join('');
    } else {
      cards += '<div class="atis-card"><div class="atis-card-title">📻 ATIS</div><pre>' + noData + '</pre></div>';
    }
    const latestMetar = metarText ? metarText.split('\\n')[0] : '';
    cards += '<div class="atis-card"><div class="atis-card-title">🌤️ METAR</div><pre>' + (latestMetar || noData) + '</pre></div>';
    cards += '<div class="atis-card"><div class="atis-card-title">📅 TAF</div><pre>' + (tafText || noData) + '</pre></div>';
    container.innerHTML = cards;
  });
}

function parseAtisHtml(html) {
  const results = [];
  const titlePattern = /<h5[^>]*class="card-title"[^>]*>([\\s\\S]*?)<\\/h5>/gi;
  const atisPattern = /<div[^>]*class="atis"[^>]*>([\\s\\S]*?)<\\/div>/gi;
  const titles = [];
  const atisTexts = [];
  let m;
  while ((m = titlePattern.exec(html)) !== null) titles.push(m[1].trim().replace(/<[^>]*>/g, ''));
  while ((m = atisPattern.exec(html)) !== null) {
    let text = m[1].replace(/&#xA;/g,'\\n').replace(/&#xD;/g,'').replace(/&#x9;/g,'  ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,'').trim();
    atisTexts.push(text);
  }
  for (let i = 0; i < atisTexts.length; i++) {
    const title = titles[i] || (i === 0 ? 'ATIS' : 'Info ' + (i + 1));
    const icon = title.toLowerCase().includes('arrival') ? '🛬' :
                 title.toLowerCase().includes('departure') ? '🛫' :
                 title.toLowerCase().includes('atis') ? '📻' : 'ℹ️';
    results.push({ title: icon + ' ' + title, text: atisTexts[i] });
  }
  return results;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  if (html.dataset.theme === 'light') {
    // 目前日間 → 切換回夜間
    delete html.dataset.theme;
    icon.textContent = '☀️'; label.textContent = '日間';  // 夜間模式下顯示「切到日間」
    localStorage.setItem('crewsync_theme', 'dark');
  } else {
    // 目前夜間 → 切換到日間
    html.dataset.theme = 'light';
    icon.textContent = '🌙'; label.textContent = '夜間';  // 日間模式下顯示「切到夜間」
    localStorage.setItem('crewsync_theme', 'light');
  }
}
(function() {
  if (localStorage.getItem('crewsync_theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
    document.getElementById('theme-icon').textContent = '🌙';
    document.getElementById('theme-label').textContent = '夜間';
  }
  // 預設夜間模式 → 初始 HTML 已顯示 ☀️ 日間，不需額外處理
})();

// ── Briefing sub-tab ──────────────────────────────────────────────────────────
function switchBriefingTab(panel, btn) {
  document.querySelectorAll('.briefing-subtab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.briefing-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('briefing-' + panel).classList.add('active');
  if (panel === 'datis' && !wxLoaded) { wxLoaded = true; loadWxRegion(wxCurrentRegion); }
}

// ── 工具連結內嵌 iframe ────────────────────────────────────────────────────────
function loadTool(e, anchor, mode) {
  e.preventDefault();
  const externalUrl = anchor.href;
  const iframeUrl = mode === 'pacific-hf' ? '/api/pacific-hf' : externalUrl;
  const title = anchor.textContent.trim();
  const wrap = document.getElementById('tool-frame-wrap');
  document.getElementById('tool-frame').src = iframeUrl;
  document.getElementById('tool-frame-title').textContent = title;
  document.getElementById('tool-frame-external').href = externalUrl;
  wrap.style.display = 'block';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return false;
}
function closeTool() {
  document.getElementById('tool-frame-wrap').style.display = 'none';
  document.getElementById('tool-frame').src = '';
}
function openHF(e) {
  e.preventDefault();
  const overlay = document.getElementById('hf-overlay');
  document.getElementById('hf-iframe').src = '/api/pacific-hf';
  overlay.style.display = 'flex';
  return false;
}
function closeHF() {
  document.getElementById('hf-overlay').style.display = 'none';
  document.getElementById('hf-iframe').src = '';
}

// ── 航路氣象 ──────────────────────────────────────────────────────────────────
var WX_AIRPORTS = {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'},{icao:'RCSS',name:'松山',cls:'as'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'rs'},{icao:'VMMC',name:'澳門',cls:'r'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'r'},{icao:'RJCC',name:'新千歲',cls:'r'},{icao:'RJFF',name:'福岡',cls:'rs'},{icao:'RJSS',name:'仙台',cls:'r'},{icao:'ROAH',name:'那霸',cls:'r'},{icao:'RJTT',name:'羽田',cls:'a'}],
  korea:       [{icao:'RKPC',name:'濟州',cls:'a'},{icao:'RKPK',name:'釜山',cls:'as'},{icao:'RKSI',name:'仁川',cls:'a'}],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'r'},{icao:'RPLL',name:'馬尼拉',cls:'r'},{icao:'RPVM',name:'宿霧',cls:'r'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'a'}],
  vietnam:     [{icao:'VVNB',name:'河內',cls:'r'},{icao:'VVPQ',name:'富國',cls:'r'},{icao:'VVTS',name:'胡志明',cls:'r'},{icao:'VDPP',name:'金邊',cls:'a'},{icao:'VVCR',name:'芽莊',cls:'a'},{icao:'VVDN',name:'峴港',cls:'a'}],
  seasia:      [{icao:'WIII',name:'雅加達',cls:'r'},{icao:'WSSS',name:'新加坡',cls:'r'},{icao:'WADD',name:'峇里島',cls:'a'},{icao:'WARR',name:'泗水',cls:'a'},{icao:'WBGG',name:'古晉',cls:'a'},{icao:'WMKK',name:'吉隆坡',cls:'a'},{icao:'WMKP',name:'檳城',cls:'a'}],
  usa:         [{icao:'KLAX',name:'洛杉磯',cls:'r'},{icao:'KONT',name:'安大略',cls:'rs'},{icao:'KPHX',name:'鳳凰城',cls:'r'},{icao:'KSEA',name:'西雅圖',cls:'r'},{icao:'KSFO',name:'舊金山',cls:'rs'},{icao:'KLAS',name:'拉斯維加斯',cls:'a'},{icao:'KOAK',name:'奧克蘭',cls:'a'},{icao:'KPDX',name:'波特蘭',cls:'a'},{icao:'KSMF',name:'沙加緬度',cls:'a'},{icao:'KTUS',name:'土森',cls:'a'}],
  pacific:     [{icao:'PACD',name:'Cold Bay',cls:'a'},{icao:'PAFA',name:'費爾班克斯',cls:'a'},{icao:'PAKN',name:'King Salmon',cls:'a'},{icao:'PANC',name:'安克拉治',cls:'a'},{icao:'PASY',name:'Shemya',cls:'a'},{icao:'PGSN',name:'塞班',cls:'a'},{icao:'PGUM',name:'關島',cls:'a'},{icao:'PHNL',name:'檀香山',cls:'a'},{icao:'PMDY',name:'中途島',cls:'a'},{icao:'PWAK',name:'威克島',cls:'a'}],
  canada:      [{icao:'CYVR',name:'溫哥華',cls:'a'}],
  europe:      [{icao:'LKPR',name:'布拉格',cls:'r'},{icao:'EDDB',name:'柏林',cls:'a'},{icao:'EDDM',name:'慕尼黑',cls:'a'},{icao:'EPWA',name:'華沙',cls:'a'},{icao:'LOWL',name:'林茲',cls:'a'},{icao:'LOWW',name:'維也納',cls:'a'}],
};

var wxCurrentRegion = 'taiwan';
var wxMetarMap = {};      // icao -> parsed metar object (cleared when region changes)
var wxMetarRawMap = {};   // icao -> string[] of 6h METAR lines
var wxMetarShowAll = {};  // icao -> bool (true = show all 6h, false = latest 1)
var wxDetailCache = {};   // icao -> rendered HTML string (persists across airport switches)
var wxSelectedIcao = '';
var wxSelectedName = '';
var wxLoaded = false;

function wxCalcCat(m) {
  if (!m) return 'UNKN';
  var sky = m.sky || [];
  var ceilings = sky.filter(function(s) { return s.cover === 'BKN' || s.cover === 'OVC' || s.cover === 'OVX'; });
  var ceiling = ceilings.length > 0 ? Math.min.apply(null, ceilings.map(function(s) { return Number(s.base) || 0; })) : 99999;
  var vis = parseFloat(String(m.visib || '10+').replace('+','')) || 10;
  if (ceiling < 500 || vis < 1) return 'LIFR';
  if (ceiling < 1000 || vis < 3) return 'IFR';
  if (ceiling < 3000 || vis < 5) return 'MVFR';
  return 'VFR';
}

function wxFmtWind(m) {
  if (!m || m.wspd === undefined || m.wspd === null) return '--';
  if (m.wspd === 0) return 'Calm';
  var dir = (m.wdir === 'VRB') ? 'VRB' : (String(m.wdir || 0).padStart(3,'0') + '\\u00b0');
  var gst = m.wgst ? '/G' + m.wgst : '';
  return dir + '\\u00a0' + m.wspd + 'kt' + gst;
}

function wxFmtVis(m) {
  if (!m || m.visib === undefined) return '--';
  var v = String(m.visib);
  return (v === '10+' ? '>10' : v) + 'SM';
}

function wxFmtTemp(m) {
  if (!m || m.temp === undefined || m.temp === null) return '--';
  return m.temp + '\\u00b0C';
}

function selectWxRegion(region, btn) {
  wxCurrentRegion = region;
  wxSelectedIcao = '';
  wxSelectedName = '';
  document.querySelectorAll('.wx-route-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  document.getElementById('wx-detail-pane').innerHTML = '<div class="wx-empty"><span class="wx-hint-desktop">\\u2190 點選左側機場</span><span class="wx-hint-mobile">\\u2191 點選上方機場</span><br>查看 METAR \\u00b7 TAF \\u00b7 ATIS</div>';
  loadWxRegion(region);
}

function parseMetarLine(raw) {
  if (!raw || !raw.trim()) return null;
  var s = raw.trim();
  var result = {};
  // Wind: 36008KT, 36008G20KT, VRB03KT, 00000KT
  var wm = s.match(/\\b(\\d{3}|VRB)(\\d{2,3})(G(\\d{2,3}))?KT\\b/);
  if (wm) {
    result.wdir = wm[1] === 'VRB' ? 'VRB' : parseInt(wm[1]);
    result.wspd = parseInt(wm[2]);
    if (wm[4]) result.wgst = parseInt(wm[4]);
  }
  // CAVOK
  if (/\\bCAVOK\\b/.test(s)) { result.visib = '10+'; result.sky = []; return result; }
  // Visibility SM (US/Canada): 10SM, 6SM, 1/2SM, M1/4SM
  var vSM = s.match(/\\b(M?[\\d]+(?:\\/\\d+)?)\\s*SM\\b/);
  if (vSM) {
    var vStr = vSM[1].replace('M','');
    var vVal = vStr.indexOf('/') >= 0
      ? parseInt(vStr.split('/')[0]) / parseInt(vStr.split('/')[1])
      : parseFloat(vStr);
    result.visib = vVal >= 10 ? '10+' : String(Math.round(vVal * 10) / 10);
  } else {
    // Visibility meters (ICAO): 9999, 0800, 3000
    var vM = s.match(/\\b(\\d{4})\\b/);
    if (vM) {
      var meters = parseInt(vM[1]);
      result.visib = meters >= 9000 ? '10+' : String(Math.round(meters / 160.934) / 10);
    }
  }
  // Sky conditions
  result.sky = [];
  var skyRe = /(BKN|OVC|FEW|SCT)(\\d{3})/g;
  var m2;
  while ((m2 = skyRe.exec(s)) !== null) {
    result.sky.push({ cover: m2[1], base: parseInt(m2[2]) * 100 });
  }
  // VV (vertical visibility): treat as OVC
  var vv = s.match(/\\bVV(\\d{3})\\b/);
  if (vv) result.sky.push({ cover: 'OVC', base: parseInt(vv[1]) * 100 });
  // Temperature: 15/11 or M01/M05
  var tm = s.match(/\\b(M?\\d{2})\\/(M?\\d{2})\\b/);
  if (tm) result.temp = tm[1].charAt(0) === 'M' ? -parseInt(tm[1].slice(1)) : parseInt(tm[1]);
  return result;
}

function loadWxRegion(region) {
  var airports = WX_AIRPORTS[region] || [];
  wxMetarMap = {};
  renderWxList(airports, region);
  var icaos = airports.map(function(a) { return a.icao; }).join(',');
  fetch('/api/metar?ids=' + icaos + '&hours=1')
    .then(function(r) { return r.ok ? r.text() : ''; })
    .then(function(text) {
      wxMetarMap = {};
      text.split('\\n').forEach(function(line) {
        line = line.trim();
        if (!line) return;
        var stripped = line.replace(/^(METAR|SPECI)\\s+/, '');
        var icao = stripped.split(' ')[0].toUpperCase();
        if (/^[A-Z]{4}$/.test(icao)) wxMetarMap[icao] = parseMetarLine(stripped);
      });
      renderWxList(airports, region);
    })
    .catch(function() { renderWxList(airports, region); });
}

function renderWxList(airports, region) {
  var ts = new Date().toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'});
  var hdr = '<div class="wx-list-hdr"><span class="wx-list-ts">METAR ' + ts + '</span>'
    + '<button class="wx-refresh-btn" onclick="loadWxRegion(\\'' + region + '\\')">\\u21ba</button></div>';
  var cards = airports.map(function(a) {
    var m = wxMetarMap[a.icao];
    var cat = wxCalcCat(m);
    var cardCls = 'wx-card-' + (a.cls || 'r');
    var sel = (a.icao === wxSelectedIcao) ? ' selected' : '';
    return '<div class="wx-card ' + cardCls + sel + '" onclick="selectWxAirport(\\'' + a.icao + '\\',\\'' + a.name + '\\',this)">'
      + '<div class="wx-row">'
      + '<div class="wx-cat cat-' + cat + '">' + cat + '</div>'
      + '<div class="wx-icao-col">' + a.icao + '</div>'
      + '<div class="wx-name-col"><div class="wx-aname">' + a.name + '</div>'
      + '<div class="wx-wind">' + wxFmtWind(m) + '</div></div>'
      + '<div class="wx-mini">' + wxFmtVis(m) + '<br>' + wxFmtTemp(m) + '</div>'
      + '</div></div>';
  }).join('');
  var bx = 'display:inline-block;width:14px;height:12px;border-radius:2px;vertical-align:middle;margin-right:4px';
  var legend = '<div class="wx-legend">'
    + '<span style="' + bx + ';border:2px solid var(--accent)"></span>Regular&nbsp;&nbsp;'
    + '<span style="' + bx + ';border:2px dashed var(--accent);opacity:.8"></span>Alternate&nbsp;&nbsp;'
    + '<span style="color:#b45309;font-weight:700">Special</span>'
    + '</div>'
    + '<details class="wx-flt-def">'
    + '<summary>&#9656; Flight Category Definition</summary>'
    + '<div class="wx-flt-def-body">'
    + '<div style="color:var(--muted);font-style:italic;font-size:.95em">FAA Flight Category (used by aviationweather.gov)</div>'
    + '<div><span class="wx-cat cat-VFR">VFR</span> Ceiling &ge; 3000 ft AGL &amp; Vis &ge; 5 SM &mdash; VMC</div>'
    + '<div><span class="wx-cat cat-MVFR">MVFR</span> Ceiling 1000&ndash;2999 ft AGL or Vis 3&ndash;4 SM &mdash; Marginal VMC</div>'
    + '<div><span class="wx-cat cat-IFR">IFR</span> Ceiling 500&ndash;999 ft AGL or Vis 1&ndash;2 SM &mdash; IMC</div>'
    + '<div><span class="wx-cat cat-LIFR">LIFR</span> Ceiling &lt; 500 ft AGL or Vis &lt; 1 SM &mdash; Low IMC</div>'
    + '<div><span class="wx-cat cat-UNKN">UNKN</span> No METAR data available</div>'
    + '<div style="margin-top:2px;font-style:italic;font-size:.95em">ICAO standard uses VMC / IMC only. VFR/MVFR &#8776; VMC; IFR/LIFR &#8776; IMC.</div>'
    + '</div></details>';
  document.getElementById('wx-list-pane').innerHTML = hdr + cards + legend;
}

function selectWxAirport(icao, name, rowEl) {
  document.querySelectorAll('.wx-card').forEach(function(r) { r.classList.remove('selected'); });
  rowEl.classList.add('selected');
  wxSelectedIcao = icao;
  wxSelectedName = name;
  var m = wxMetarMap[icao];
  var cat = wxCalcCat(m);
  var detailPane = document.getElementById('wx-detail-pane');
  detailPane.innerHTML = '<div class="wx-detail-hdr">'
    + '<div class="wx-detail-title">' + icao + '\\u3000' + name + '</div>'
    + '<div class="wx-cat cat-' + cat + '">' + cat + '</div>'
    + '<button class="wx-refresh-btn" style="margin-left:4px" onclick="refreshWxDetail(\\'' + icao + '\\',\\'' + name + '\\')">\\u21ba 更新</button>'
    + '</div>'
    + '<div id="wx-detail-content">'
    + (wxDetailCache[icao] ? wxDetailCache[icao] : '<div class="atis-loading">載入詳細資料...</div>')
    + '</div>';
  if (!wxDetailCache[icao]) fetchWxDetail(icao, name);
  if (window.innerWidth < 640) detailPane.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function refreshWxDetail(icao, name) {
  delete wxDetailCache[icao];
  var content = document.getElementById('wx-detail-content');
  if (content) content.innerHTML = '<div class="atis-loading">重新載入...</div>';
  fetchWxDetail(icao, name);
}

function buildMetarCard(icao) {
  var lines = wxMetarRawMap[icao] || [];
  var showAll = !!wxMetarShowAll[icao];
  var noData = '<span style="color:var(--muted);font-style:italic">\\u7121\\u8cc7\\u6599</span>';
  var displayText = lines.length === 0 ? noData : (showAll ? lines.join('\\n\\n') : lines[0]);
  var toggleBtns = lines.length > 1
    ? '<div style="display:flex;gap:4px;margin-left:auto">'
      + '<button onclick="setMetarMode(\\'' + icao + '\\',false)" class="metar-mode-btn' + (!showAll ? ' active' : '') + '">\\u6700\\u65b0</button>'
      + '<button onclick="setMetarMode(\\'' + icao + '\\',true)" class="metar-mode-btn' + (showAll ? ' active' : '') + '">6\\u5c0f\\u6642</button>'
      + '</div>'
    : '';
  return '<div class="atis-card"><div class="atis-card-title" style="display:flex;align-items:center">\\ud83c\\udf24\\ufe0f METAR'
    + toggleBtns + '</div><pre>' + displayText + '</pre></div>';
}

function setMetarMode(icao, showAll) {
  wxMetarShowAll[icao] = showAll;
  delete wxDetailCache[icao];
  if (wxSelectedIcao !== icao) return;
  var content = document.getElementById('wx-detail-content');
  if (!content) return;
  var firstCard = content.querySelector('.atis-card');
  if (firstCard) {
    var tmp = document.createElement('div');
    tmp.innerHTML = buildMetarCard(icao);
    content.replaceChild(tmp.firstChild, firstCard);
  }
}

function fetchWxDetail(icao, name) {
  var proxy = 'https://api.codetabs.com/v1/proxy/?quest=';
  var metarP = fetch('/api/metar?ids=' + icao + '&hours=6')
    .then(function(r) { return r.ok ? r.text() : ''; })
    .then(function(t) {
      var lines = t.trim().split('\\n').filter(function(l) { return l.trim(); });
      return lines.map(function(l) { return l.replace(/^(METAR|SPECI)\\s+/, '').trim(); }).filter(function(l) { return l.length > 0; });
    }).catch(function() { return []; });
  var tafP = fetch(proxy + encodeURIComponent('https://aviationweather.gov/api/data/taf?ids=' + icao + '&format=raw'))
    .then(function(r) { return r.ok ? r.text() : ''; }).then(function(t) { return t.trim(); }).catch(function() { return ''; });
  var atisP = fetch(proxy + encodeURIComponent('https://atis.guru/atis/' + icao))
    .then(function(r) { return r.ok ? r.text() : ''; }).then(parseAtisHtml).catch(function() { return []; });
  Promise.all([metarP, tafP, atisP]).then(function(res) {
    var metarLines = res[0], tafText = res[1], atisSections = res[2];
    var content = document.getElementById('wx-detail-content');
    if (!content || wxSelectedIcao !== icao) return;
    var noData = '<span style="color:var(--muted);font-style:italic">\\u7121\\u8cc7\\u6599</span>';
    wxMetarRawMap[icao] = metarLines;
    if (wxMetarShowAll[icao] === undefined) wxMetarShowAll[icao] = false;
    var cards = buildMetarCard(icao);
    cards += '<div class="atis-card"><div class="atis-card-title">\\ud83d\\udcc5 TAF</div><pre>' + (tafText || noData) + '</pre></div>';
    var atisOnly = atisSections.filter(function(s) {
      var t = s.title.toLowerCase(); return !t.includes('metar') && !t.includes('taf');
    });
    if (atisOnly.length > 0) {
      cards += atisOnly.map(function(s) {
        return '<div class="atis-card"><div class="atis-card-title">' + s.title + '</div><pre>' + s.text + '</pre></div>';
      }).join('');
    } else {
      cards += '<div class="atis-card"><div class="atis-card-title">\\ud83d\\udcfb ATIS</div><pre>' + noData + '</pre></div>';
    }
    wxDetailCache[icao] = cards;
    content.innerHTML = cards;
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
showMain();
// 預設顯示簡報箱 datis 分頁 → 立即載入初始天氣資料
wxLoaded = true; loadWxRegion(wxCurrentRegion);
</script>
</body>
</html>`;
}
