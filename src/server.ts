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

// ── Service Worker ────────────────────────────────────────────────────────────
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
const CACHE = 'crewsync-v1';
const SHELL = ['/'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (url.includes('/api/metar')) {
    e.respondWith(fetch(e.request).then(r => {
      const clone = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(cached => {
    const net = fetch(e.request).then(r => {
      caches.open(CACHE).then(c => c.put(e.request, r.clone()));
      return r;
    });
    return cached || net;
  }));
});
`);
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
  html,body{overflow:hidden;height:100dvh}
  #tab-sync.tab-active{height:calc(100dvh - calc(56px + env(safe-area-inset-bottom,0px)));
    min-height:unset;overflow-y:auto}
  #tab-briefing.tab-active{display:flex;flex-direction:column;
    height:calc(100dvh - calc(56px + env(safe-area-inset-bottom,0px)));
    min-height:unset;overflow:hidden;padding:0}
  .briefing-subtabs{position:static;flex-shrink:0}
  .briefing-subtab{flex:1}
  .briefing-panel.active{display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0}
  #briefing-tools.active{overflow-y:auto;padding:16px 16px 0}
  #briefing-datis.active{display:flex;flex-direction:column;overflow:hidden}
  #briefing-hf.active{overflow:hidden;padding:0;height:auto}
  #briefing-coldtemp.active{overflow-y:auto;padding:0}
  #briefing-duty.active{overflow:hidden;padding:0}
  .wx-fixed-header{position:static;flex-shrink:0}
  .wx-split{flex-direction:row;overflow:hidden;flex:1}
  .wx-list-pane{width:280px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--dim);border-bottom:none}
  .wx-detail-pane{flex:1;overflow-y:auto}}
#briefing-hf.active{padding:0;display:flex;flex-direction:column;
  height:calc(100dvh - calc(56px + env(safe-area-inset-bottom,0px)) - 40px)}
#hf-panel-iframe{flex:1;min-height:0}
.ct-panel{padding:16px;overflow-y:auto}
.ct-form{background:var(--card);border-radius:var(--radius);padding:16px;margin-bottom:16px}
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
.ct-table{border-collapse:collapse;font-size:.75em;width:100%;min-width:420px}
.ct-table th,.ct-table td{padding:5px 8px;text-align:right;border:1px solid var(--dim)}
.ct-table th{background:var(--surface);color:var(--muted);font-weight:700}
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
.dt-lock-sub{font-size:.75em;color:var(--dim);margin-bottom:18px}
.dt-lock-input{width:100%;padding:12px;text-align:center;font-size:1.2em;letter-spacing:.2em;background:var(--surface);border:1.5px solid var(--dim);border-radius:10px;color:var(--text);margin-bottom:12px;box-sizing:border-box}
.dt-lock-btn{width:100%;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-size:.95em;font-weight:800;cursor:pointer}
.dt-lock-err{font-size:.78em;color:#ef4444;margin-top:8px;min-height:1.2em}
.dt-config{background:var(--card);border-bottom:1px solid var(--dim);padding:10px 14px 8px}
.dt-section-title{font-size:.68em;font-weight:800;color:var(--dim);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
.dt-crew-row{display:flex;gap:5px;margin-bottom:8px}
.dt-crew-btn{flex:1;padding:8px 4px;border-radius:8px;font-size:.78em;font-weight:700;border:1.5px solid var(--dim);background:none;color:var(--dim);cursor:pointer;line-height:1.3;text-align:center}
.dt-crew-btn.active{border-color:var(--accent);background:var(--accent);color:#fff}
.dt-opt-row{display:flex;align-items:center;gap:12px;margin-bottom:6px;flex-wrap:wrap}
.dt-chk-label{display:flex;align-items:center;gap:5px;font-size:.78em;color:var(--text);cursor:pointer}
.dt-chk-label input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;flex-shrink:0}
.dt-tz-select{background:var(--surface);border:1.5px solid var(--dim);border-radius:7px;color:var(--text);font-size:.78em;padding:4px 6px;max-width:160px}
.dt-mode-row{display:flex;gap:0;margin-bottom:0;border-radius:8px;overflow:hidden;border:1.5px solid var(--dim)}
.dt-mode-btn{flex:1;padding:7px;font-size:.8em;font-weight:700;border:none;background:none;color:var(--dim);cursor:pointer}
.dt-mode-btn.active{background:var(--accent);color:#fff}
.dt-body{padding:10px 14px 4px}
.dt-field{margin-bottom:10px}
.dt-field-label{font-size:.72em;font-weight:700;color:var(--dim);margin-bottom:4px}
.dt-time-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.dt-date-box{padding:7px 5px;background:var(--surface);border:1.5px solid var(--dim);border-radius:8px;color:var(--text);font-size:.85em;font-weight:600;width:48px;text-align:center}
.dt-time-box{width:40px;padding:7px 3px;text-align:center;font-size:.92em;font-weight:700;background:var(--surface);border:1.5px solid var(--dim);border-radius:8px;color:var(--text)}
.dt-sep{font-weight:700;color:var(--dim)}
.dt-tag{font-size:.68em;color:var(--dim);padding:2px 5px;border:1px solid var(--dim);border-radius:4px;white-space:nowrap}
.dt-calc-btn{width:100%;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-size:1em;font-weight:800;cursor:pointer;margin:8px 0 4px;letter-spacing:.03em}
.dt-results-wrap{padding:8px 14px 16px}
.dt-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.dt-card{background:var(--surface);border-radius:12px;padding:10px 12px;border-left:3px solid var(--dim)}
.dt-card.ok{border-left-color:#22c55e}.dt-card.warn{border-left-color:#f59e0b}.dt-card.err{border-left-color:#ef4444}
.dt-card-label{font-size:.63em;font-weight:700;color:var(--dim);margin-bottom:2px}
.dt-card-actual{font-size:1.25em;font-weight:800;line-height:1.1;color:var(--text)}
.dt-card-max{font-size:.67em;color:var(--dim);margin-top:2px}
.dt-card.ok .dt-card-actual{color:#22c55e}.dt-card.warn .dt-card-actual{color:#f59e0b}.dt-card.err .dt-card-actual{color:#ef4444}
.dt-rest-card{grid-column:1/-1;background:var(--surface);border-radius:12px;padding:10px 12px;border-left:3px solid var(--dim)}
.dt-rest-card.ok{border-left-color:#22c55e}.dt-rest-card.warn .dt-card-actual{color:#f59e0b}.dt-rest-card.err .dt-card-actual{color:#ef4444}
.dt-rest-card.ok .dt-card-actual{color:#22c55e}
.dt-wocl-box{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35);border-radius:10px;padding:8px 12px;margin-bottom:8px;font-size:.75em;color:#f59e0b;line-height:1.5}
.dt-tl2{background:var(--surface);border-radius:10px;padding:12px;margin-bottom:8px;overflow-x:auto}
.dt-tl2-title{font-size:.63em;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.dt-tl2-canvas{position:relative;min-width:280px}
.dt-tl2-track{position:relative;height:28px;margin-bottom:3px}
.dt-tl2-track-sm{position:relative;height:11px;margin-bottom:3px}
.dt-tl2-seg{position:absolute;top:0;height:100%;border-radius:4px;display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:4px}
.dt-tl2-lbl{font-size:.67em;font-weight:700;color:#fff;padding:0 6px;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.5);pointer-events:none}
.dt-tl2-fdp{background:#22c55e}
.dt-tl2-maxfdp{background:repeating-linear-gradient(-45deg,#3b82f6 0,#3b82f6 7px,#93c5fd 7px,#93c5fd 14px)}
.dt-tl2-minrest{background:repeating-linear-gradient(-45deg,#f59e0b 0,#f59e0b 7px,#fcd34d 7px,#fcd34d 14px)}
.dt-tl2-rest{background:#374151}
.dt-tl2-wocl{position:absolute;top:0;background:rgba(167,139,250,.25);pointer-events:none;z-index:1}
.dt-tl2-vline{position:absolute;top:0;width:0;border-left:1.5px dashed rgba(148,163,184,.5);pointer-events:none;z-index:2}
.dt-tl2-ticks{position:relative;height:44px;min-width:280px;margin-top:4px}
.dt-tl2-tick{position:absolute;transform:translateX(-50%);text-align:center;font-size:.58em;color:var(--dim);line-height:1.35;white-space:nowrap}
.dt-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.dt-leg-item{display:flex;align-items:center;gap:4px;font-size:.62em;color:var(--dim)}
.dt-leg-box{width:11px;height:9px;border-radius:2px;flex-shrink:0}
.dt-ext-note{font-size:.72em;color:#a78bfa;margin-bottom:6px;padding:0 14px}
.dt-notice{font-size:.65em;color:var(--dim);text-align:center;padding:6px 0 14px}
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
    <button class="briefing-subtab" id="subtabBtn-hf" onclick="switchBriefingTab('hf',this)">📻 Pacific HF</button>
    <button class="briefing-subtab" id="subtabBtn-coldtemp" onclick="switchBriefingTab('coldtemp',this)">❄️ 低溫修正</button>
    <button class="briefing-subtab" id="subtabBtn-duty" onclick="switchBriefingTab('duty',this)">⏱️ Duty Time</button>
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

  <!-- ── 🌡️ Cold Temperature Altitude Correction panel ── -->
  <div id="briefing-coldtemp" class="briefing-panel">
    <div class="ct-panel">
      <div class="ct-form">
        <!-- 機場標高 + OAT -->
        <div class="ct-inputs">
          <div class="ct-input-group">
            <label>機場標高 Airport Elevation (ft)</label>
            <input type="text" id="ct-elev" placeholder="e.g. 108" inputmode="text">
          </div>
          <div class="ct-input-group">
            <label>OAT (°C)</label>
            <input type="text" id="ct-oat" placeholder="e.g. −20" inputmode="text">
          </div>
        </div>
        <!-- 高度輸入卡片格 -->
        <div class="ct-grid">
          <div class="ct-card">
            <div class="ct-card-label">FAF</div>
            <input class="ct-card-input" type="number" id="ct-a0" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r0">—</div>
          </div>
          <div class="ct-card">
            <div class="ct-card-label">DA / MDA</div>
            <input class="ct-card-input" type="number" id="ct-a1" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r1">—</div>
          </div>
          <div class="ct-card">
            <div class="ct-card-label">Missed Apch</div>
            <input class="ct-card-input" type="number" id="ct-a2" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r2">—</div>
          </div>
          <div class="ct-card">
            <input class="ct-label-inp" type="text" id="ct-l3" placeholder="自訂名稱">
            <input class="ct-card-input" type="number" id="ct-a3" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r3">—</div>
          </div>
          <div class="ct-card">
            <input class="ct-label-inp" type="text" id="ct-l4" placeholder="自訂名稱">
            <input class="ct-card-input" type="number" id="ct-a4" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r4">—</div>
          </div>
          <div class="ct-card">
            <input class="ct-label-inp" type="text" id="ct-l5" placeholder="自訂名稱">
            <input class="ct-card-input" type="number" id="ct-a5" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r5">—</div>
          </div>
        </div>
        <button class="ct-calc-btn" onclick="calcColdTemp()">計算修正量</button>
        <div id="ct-no-corr" class="ct-no-corr" style="display:none">✅ OAT ≥ 0°C，無需低溫修正</div>
      </div>
      <div class="ct-table-wrap">
        <h3>ICAO Doc 8168 Cold Temperature Error Table（修正量 ft）</h3>
        <table class="ct-table" id="ct-table">
          <thead><tr>
            <th>HAA (ft) ↓ / OAT (°C) →</th>
            <th>0°</th><th>−10°</th><th>−20°</th><th>−30°</th><th>−40°</th><th>−50°</th>
          </tr></thead>
          <tbody id="ct-tbody"></tbody>
        </table>
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

  <!-- ── 📻 Pacific HF panel ── -->
  <div id="briefing-hf" class="briefing-panel">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid var(--dim);flex-shrink:0">
      <span style="font-size:.85em;font-weight:700;color:var(--text)">📻 Pacific HF 查詢</span>
      <a href="https://radio.arinc.net/pacific/" target="_blank" style="font-size:.78em;color:var(--accent);text-decoration:none">↗ 新分頁</a>
    </div>
    <iframe id="hf-panel-iframe" src="" style="flex:1;border:none;width:100%;min-height:400px"></iframe>
  </div>

  <!-- ── ⏱️ Duty Time panel ── -->
  <div id="briefing-duty" class="briefing-panel" style="position:relative">

    <!-- 密碼鎖 -->
    <div class="dt-lock-overlay" id="dt-lock-overlay">
      <div class="dt-lock-card">
        <div class="dt-lock-icon">🔒</div>
        <div class="dt-lock-title">Duty Time Calculator</div>
        <div class="dt-lock-sub">請輸入密碼以繼續</div>
        <input class="dt-lock-input" type="password" id="dt-lock-pw" placeholder="••••••••" maxlength="16"
          onkeydown="if(event.key==='Enter')dtUnlock()">
        <button class="dt-lock-btn" onclick="dtUnlock()">解鎖</button>
        <div class="dt-lock-err" id="dt-lock-err"></div>
      </div>
    </div>

    <div class="dt-wrap" style="flex:1">

      <!-- Config -->
      <div class="dt-config">
        <div class="dt-section-title">機組配置</div>
        <div class="dt-crew-row">
          <button class="dt-crew-btn active" data-crew="2" onclick="dtSelectCrew(this)">Single<br>2P</button>
          <button class="dt-crew-btn" data-crew="3" onclick="dtSelectCrew(this)">Multiple<br>3P</button>
          <button class="dt-crew-btn" data-crew="4" onclick="dtSelectCrew(this)">Double<br>4P</button>
        </div>
        <div class="dt-opt-row">
          <label class="dt-chk-label" id="dt-c1-row" style="display:none">
            <input type="checkbox" id="dt-c1"> Class 1 Bunk
          </label>
          <label class="dt-chk-label" id="dt-disc-row" style="display:none">
            <input type="checkbox" id="dt-disc"> PIC Discretion (+2h)
          </label>
        </div>
        <div class="dt-opt-row" style="margin-bottom:4px">
          <span style="font-size:.72em;color:var(--dim);flex-shrink:0">時區</span>
          <select class="dt-tz-select" id="dt-tz">
            <option value="taipei" selected>台北 UTC+8</option>
            <option value="tokyo">東京 UTC+9</option>
            <option value="bangkok">曼谷 UTC+7</option>
            <option value="prague">布拉格 UTC+1/+2★</option>
            <option value="la">洛杉磯 UTC−8/−7★</option>
            <option value="phoenix">鳳凰城 UTC−7</option>
          </select>
        </div>
      </div>

      <!-- Mode -->
      <div class="dt-body" style="padding-bottom:0">
        <div class="dt-mode-row">
          <button class="dt-mode-btn active" id="dt-mode-home" onclick="dtSetMode('home')">🏠 Home Base</button>
          <button class="dt-mode-btn" id="dt-mode-out" onclick="dtSetMode('out')">✈️ Outstation</button>
        </div>
      </div>

      <!-- Inputs -->
      <div class="dt-body">

        <!-- FDP Start -->
        <div class="dt-field">
          <div class="dt-field-label">FDP Start (UTC) — Report Time</div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-s-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-s-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-s-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- FDP End -->
        <div class="dt-field">
          <div class="dt-field-label">FDP End (UTC) — Block In / Release</div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-e-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-e-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-e-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- Flight Time -->
        <div class="dt-field">
          <div class="dt-field-label">Flight Time (Block Time)</div>
          <div class="dt-time-row">
            <input class="dt-time-box" type="text" id="dt-ft-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-ft-m" placeholder="MM" maxlength="2" inputmode="numeric">
          </div>
        </div>

        <!-- Home Base: Next Report -->
        <div class="dt-field" id="dt-next-section">
          <div class="dt-field-label">Next Duty Report (UTC) — 選填</div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-n-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-n-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-n-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- Outstation: Hotel Check-in / Check-out -->
        <div class="dt-field" id="dt-hotel-section" style="display:none">
          <div class="dt-field-label">Hotel Check-in (UTC)</div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-ci-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-ci-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-ci-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
          <div class="dt-field-label" style="margin-top:8px">Hotel Check-out (UTC)</div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-co-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-co-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-co-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <button class="dt-calc-btn" onclick="dtCalculate()">計算</button>
      </div>

      <!-- Results -->
      <div id="dt-results-area" style="display:none">
        <div id="dt-ext-note" class="dt-ext-note" style="display:none"></div>
        <div class="dt-results-wrap">
          <div class="dt-cards">
            <div class="dt-card" id="dt-card-fdp">
              <div class="dt-card-label">Actual FDP</div>
              <div class="dt-card-actual" id="dt-r-fdp">—</div>
              <div class="dt-card-max" id="dt-r-fdp-max"></div>
            </div>
            <div class="dt-card" id="dt-card-ft">
              <div class="dt-card-label">Flight Time</div>
              <div class="dt-card-actual" id="dt-r-ft">—</div>
              <div class="dt-card-max" id="dt-r-ft-max"></div>
            </div>
            <div class="dt-rest-card" id="dt-card-rest">
              <div class="dt-card-label">Actual Rest</div>
              <div class="dt-card-actual" id="dt-r-rest">—</div>
              <div class="dt-card-max" id="dt-r-rest-min"></div>
            </div>
          </div>

          <!-- WOCL -->
          <div id="dt-wocl-box" class="dt-wocl-box" style="display:none">
            <strong>⚠ WOCL (02:00–05:00 LT)</strong><br>
            <span id="dt-wocl-msg"></span>
          </div>

          <!-- Timeline -->
          <div class="dt-tl2">
            <div class="dt-tl2-title">Visual Timeline</div>
            <div class="dt-tl2-canvas" id="dt-tl2-canvas">
              <div class="dt-tl2-wocl"  id="dt-tl2-wocl"  style="display:none"></div>
              <div class="dt-tl2-vline" id="dt-tl2-vl-s"></div>
              <div class="dt-tl2-vline" id="dt-tl2-vl-e"></div>
              <div class="dt-tl2-vline" id="dt-tl2-vl-n" style="display:none"></div>
              <!-- FDP (thin) -->
              <div class="dt-tl2-track-sm">
                <div class="dt-tl2-seg dt-tl2-fdp" id="dt-tl2-fdp"></div>
              </div>
              <!-- Max FDP -->
              <div class="dt-tl2-track">
                <div class="dt-tl2-seg dt-tl2-maxfdp" id="dt-tl2-maxfdp">
                  <span class="dt-tl2-lbl" id="dt-tl2-maxfdp-lbl"></span>
                </div>
              </div>
              <!-- Min Rest -->
              <div class="dt-tl2-track">
                <div class="dt-tl2-seg dt-tl2-minrest" id="dt-tl2-minrest">
                  <span class="dt-tl2-lbl" id="dt-tl2-minrest-lbl"></span>
                </div>
              </div>
              <!-- Actual Rest -->
              <div class="dt-tl2-track" id="dt-tl2-rest-row" style="display:none">
                <div class="dt-tl2-seg dt-tl2-rest" id="dt-tl2-rest">
                  <span class="dt-tl2-lbl" id="dt-tl2-rest-lbl"></span>
                </div>
              </div>
              <!-- Tick labels -->
              <div class="dt-tl2-ticks" id="dt-tl2-ticks"></div>
            </div>
            <div class="dt-legend">
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:#22c55e"></div>FDP</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:repeating-linear-gradient(-45deg,#3b82f6 0,#3b82f6 4px,#93c5fd 4px,#93c5fd 8px)"></div>Max FDP</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:repeating-linear-gradient(-45deg,#f59e0b 0,#f59e0b 4px,#fcd34d 4px,#fcd34d 8px)"></div>Min Rest</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:#374151"></div>Rest</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:rgba(167,139,250,.4)"></div>WOCL</div>
            </div>
          </div>

          <div class="dt-notice">⚠ Non-operational reference only · CAR 07-02A · 請以公司手冊為準</div>
        </div>
      </div>

      <!-- Placeholder before calc -->
      <div id="dt-placeholder" style="padding:32px 14px;text-align:center;color:var(--dim);font-size:.82em">
        輸入 FDP 時間後按「計算」
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
    <span style="font-size:.55em;color:var(--dim);line-height:1;opacity:.7">V3.0</span>
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

// ── Cold Temperature Altitude Correction ──────────────────────────────────────
(function initColdTempTable() {
  const CT_ROWS = [200,300,400,500,600,700,800,900,1000,1500,2000,3000,4000,5000,6000,7000,8000,9000,10000];
  const CT_VALS = [
    [20,20,30,40,50,60],
    [20,30,40,50,70,80],
    [30,40,50,70,90,100],
    [30,50,70,90,110,130],
    [40,60,80,100,130,150],
    [40,70,90,120,150,180],
    [50,80,100,140,170,210],
    [50,90,120,150,190,230],
    [60,100,130,170,210,260],
    [90,140,190,250,310,380],
    [120,180,250,320,400,490],
    [170,260,360,470,580,710],
    [220,340,470,610,760,920],
    [270,420,570,740,920,1120],
    [320,490,670,870,1080,1310],
    [370,570,780,1010,1250,1510],
    [420,640,880,1140,1410,1710],
    [460,710,980,1260,1570,1900],
    [510,780,1070,1390,1720,2090]
  ];
  const tbody = document.getElementById('ct-tbody');
  CT_ROWS.forEach(function(haa, i) {
    const tr = document.createElement('tr');
    tr.id = 'ct-row-' + i;
    const td0 = document.createElement('td');
    td0.textContent = haa >= 1000 ? haa.toLocaleString() : haa;
    tr.appendChild(td0);
    CT_VALS[i].forEach(function(v, j) {
      const td = document.createElement('td');
      td.id = 'ct-cell-' + i + '-' + j;
      td.textContent = v.toLocaleString();
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  window._CT_ROWS = CT_ROWS;
  window._CT_VALS = CT_VALS;
})();

function ctInterp(alt, elev, oat) {
  const CT_TEMPS = [0,-10,-20,-30,-40,-50];
  const CT_ROWS  = window._CT_ROWS;
  const CT_VALS  = window._CT_VALS;
  const haa  = alt - elev;
  const haaC = Math.max(CT_ROWS[0], Math.min(CT_ROWS[CT_ROWS.length-1], haa));
  const oatC = Math.max(-50, Math.min(0, oat));
  let ri = CT_ROWS.length - 2;
  for (let i = 0; i < CT_ROWS.length - 1; i++) {
    if (haaC <= CT_ROWS[i+1]) { ri = i; break; }
  }
  const haaFrac = (haaC - CT_ROWS[ri]) / (CT_ROWS[ri+1] - CT_ROWS[ri]);
  let ti = CT_TEMPS.length - 2;
  for (let i = 0; i < CT_TEMPS.length - 1; i++) {
    if (oatC >= CT_TEMPS[i+1]) { ti = i; break; }
  }
  const oatFrac = (CT_TEMPS[ti] - oatC) / (CT_TEMPS[ti] - CT_TEMPS[ti+1]);
  const v00 = CT_VALS[ri][ti], v01 = CT_VALS[ri][ti+1];
  const v10 = CT_VALS[ri+1][ti], v11 = CT_VALS[ri+1][ti+1];
  const corr = v00*(1-haaFrac)*(1-oatFrac) + v01*(1-haaFrac)*oatFrac
             + v10*haaFrac*(1-oatFrac)      + v11*haaFrac*oatFrac;
  return { corr: Math.round(corr/10)*10, ri: ri, ti: ti };
}

function calcColdTemp() {
  const elev   = parseFloat(document.getElementById('ct-elev').value);
  const oat    = parseFloat(document.getElementById('ct-oat').value);
  const noCorr = document.getElementById('ct-no-corr');
  if (isNaN(elev) || isNaN(oat)) return;
  // Reset
  document.querySelectorAll('.ct-hi').forEach(function(el) { el.classList.remove('ct-hi'); });
  noCorr.style.display = 'none';
  for (var i = 0; i < 6; i++) {
    var rs = document.getElementById('ct-r'+i);
    if (rs) { rs.textContent = '—'; rs.className = 'ct-card-result empty'; }
  }
  if (oat >= 0) { noCorr.style.display = 'block'; return; }
  var highlighted = {};
  for (var idx = 0; idx < 6; idx++) {
    var inp = document.getElementById('ct-a'+idx);
    var res = document.getElementById('ct-r'+idx);
    if (!inp || !res) continue;
    var alt = parseFloat(inp.value);
    if (isNaN(alt)) continue;
    var r = ctInterp(alt, elev, oat);
    var corrAlt = Math.round((alt + r.corr) / 10) * 10;
    res.innerHTML = '+' + r.corr.toLocaleString() + ' ft<br>' + corrAlt.toLocaleString() + ' ft';
    res.className = 'ct-card-result';
    // Highlight table cells (track unique cells)
    [[r.ri,r.ti],[r.ri,r.ti+1],[r.ri+1,r.ti],[r.ri+1,r.ti+1]].forEach(function(p) {
      var key = p[0]+'-'+p[1];
      if (!highlighted[key]) {
        var el = document.getElementById('ct-cell-'+key);
        if (el) { el.classList.add('ct-hi'); highlighted[key] = true; }
      }
    });
  }
}

// ── Briefing sub-tab ──────────────────────────────────────────────────────────
function switchBriefingTab(panel, btn) {
  document.querySelectorAll('.briefing-subtab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.briefing-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('briefing-' + panel).classList.add('active');
  if (panel === 'datis' && !wxLoaded) { wxLoaded = true; loadWxRegion(wxCurrentRegion); }
  if (panel === 'hf') {
    var ifr = document.getElementById('hf-panel-iframe');
    if (ifr && !ifr.getAttribute('src')) ifr.src = '/api/pacific-hf';
  }
  if (panel === 'duty' && !dtUnlocked) {
    document.getElementById('dt-lock-overlay').style.display = 'flex';
    setTimeout(function(){ document.getElementById('dt-lock-pw').focus(); }, 100);
  }
}

// ── Duty Time 密碼鎖 ──────────────────────────────────────────────────────────
var dtUnlocked = false;
function dtUnlock() {
  var pw = document.getElementById('dt-lock-pw').value;
  if (pw === '12345678') {
    dtUnlocked = true;
    document.getElementById('dt-lock-overlay').style.display = 'none';
    document.getElementById('dt-lock-pw').value = '';
    document.getElementById('dt-lock-err').textContent = '';
  } else {
    document.getElementById('dt-lock-err').textContent = '密碼錯誤，請再試一次';
    document.getElementById('dt-lock-pw').value = '';
    document.getElementById('dt-lock-pw').focus();
  }
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
var wxCacheTime = null;   // timestamp of last successful fetch (ms)
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
  // Observation time: DDHHMMZ
  var om = s.match(/\\b(\\d{2})(\\d{2})(\\d{2})Z\\b/);
  if (om) { result.obsDay = parseInt(om[1]); result.obsHour = parseInt(om[2]); result.obsMin = parseInt(om[3]); }
  return result;
}

function wxMinsAgo(m) {
  if (!m || m.obsDay === undefined) return null;
  var now = new Date();
  var obs = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), m.obsDay, m.obsHour, m.obsMin));
  if (obs > now) obs.setUTCMonth(obs.getUTCMonth() - 1);
  return Math.round((now - obs) / 60000);
}

function loadWxRegion(region) {
  var airports = WX_AIRPORTS[region] || [];
  // 嘗試從 localStorage 讀取快取
  try {
    var cached = localStorage.getItem('crewsync_metar_' + region);
    if (cached) {
      var c = JSON.parse(cached);
      wxMetarMap = c.data || {};
      wxCacheTime = c.time || null;
    } else { wxMetarMap = {}; wxCacheTime = null; }
  } catch(e) { wxMetarMap = {}; wxCacheTime = null; }
  renderWxList(airports, region);
  var icaos = airports.map(function(a) { return a.icao; }).join(',');
  fetch('/api/metar?ids=' + icaos + '&hours=1')
    .then(function(r) { return r.ok ? r.text() : Promise.reject(); })
    .then(function(text) {
      wxMetarMap = {};
      text.split('\\n').forEach(function(line) {
        line = line.trim();
        if (!line) return;
        var stripped = line.replace(/^(METAR|SPECI)\\s+/, '');
        var icao = stripped.split(' ')[0].toUpperCase();
        if (/^[A-Z]{4}$/.test(icao)) wxMetarMap[icao] = parseMetarLine(stripped);
      });
      wxCacheTime = Date.now();
      try { localStorage.setItem('crewsync_metar_' + region, JSON.stringify({data: wxMetarMap, time: wxCacheTime})); } catch(e) {}
      renderWxList(airports, region);
    })
    .catch(function() { renderWxList(airports, region); });
}

function renderWxList(airports, region) {
  var ts = wxCacheTime ? new Date(wxCacheTime).toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'}) : '—';
  var cacheAge = wxCacheTime ? Math.round((Date.now() - wxCacheTime) / 60000) : null;
  var cacheNote = cacheAge !== null && cacheAge > 5 ? ' <span style="color:#f59e0b;font-size:.85em">(' + cacheAge + 'm ago)</span>' : '';
  var hdr = '<div class="wx-list-hdr"><span class="wx-list-ts">METAR ' + ts + cacheNote + '</span>'
    + '<button class="wx-refresh-btn" onclick="loadWxRegion(\\'' + region + '\\')">\\u21ba</button></div>';
  var cards = airports.map(function(a) {
    var m = wxMetarMap[a.icao];
    var cat = wxCalcCat(m);
    var cardCls = 'wx-card-' + (a.cls || 'r');
    var sel = (a.icao === wxSelectedIcao) ? ' selected' : '';
    var mins = wxMinsAgo(m);
    var ageClass = mins > 90 ? ' stale' : mins > 60 ? ' warn' : '';
    var ageText = mins > 90 ? 'expired' : mins + 'm';
    var ageHtml = mins !== null ? '<div class="wx-obs-age' + ageClass + '">' + ageText + '</div>' : '';
    return '<div class="wx-card ' + cardCls + sel + '" onclick="selectWxAirport(\\'' + a.icao + '\\',\\'' + a.name + '\\',this)">'
      + '<div class="wx-row">'
      + '<div class="wx-cat cat-' + cat + '">' + cat + '</div>'
      + '<div class="wx-icao-col">' + a.icao + '</div>'
      + '<div class="wx-name-col"><div class="wx-aname">' + a.name + '</div>'
      + '<div class="wx-wind">' + wxFmtWind(m) + '</div></div>'
      + '<div style="text-align:right;flex-shrink:0"><div class="wx-mini">' + wxFmtVis(m) + '<br>' + wxFmtTemp(m) + '</div>' + ageHtml + '</div>'
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

// ── Duty Time Calculator ──────────────────────────────────────────────────────
var DT_MAX_FDP = {2:14*60, 3:18*60, 4:24*60};
var DT_MAX_FT  = {2:{noC1:10*60,c1:10*60}, 3:{noC1:12*60,c1:16*60}, 4:{noC1:12*60,c1:18*60}};
var dtMode = 'home';

function dtGetTzOffset(tzId) {
  var now = new Date();
  var yr  = now.getUTCFullYear();
  function nthSun(y, mo, n) { // mo: 0-indexed
    var d = new Date(Date.UTC(y, mo, 1));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCDate(d.getUTCDate() + (n-1)*7); return d;
  }
  function lastSun(y, mo) {
    var d = new Date(Date.UTC(y, mo+1, 0));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() - 1); return d;
  }
  if (tzId === 'la')     { var s=nthSun(yr,2,2),e=nthSun(yr,10,1); return (now>=s&&now<e)?-7:-8; }
  if (tzId === 'prague') { var s=lastSun(yr,2),e=lastSun(yr,9);    return (now>=s&&now<e)?2:1;   }
  return {taipei:8,tokyo:9,bangkok:7,phoenix:-7}[tzId] ?? 8;
}

function dtFmtH(m) { // "HH:MM" for timeline labels
  var h=Math.floor(m/60), mm=m%60;
  return h+':'+(mm<10?'0':'')+mm;
}

function dtRenderTimeline(startMin, endMin, maxFdp, restStart, restEnd, minRest, tz) {
  var actFdp = endMin - startMin;
  var spanEnd = restEnd !== null
    ? Math.max(startMin + maxFdp, restEnd) + 30
    : startMin + maxFdp + minRest + 60;
  var span = spanEnd - startMin;

  function pL(m)   { return (Math.max(0,Math.min(100,(m-startMin)/span*100))).toFixed(2)+'%'; }
  function pW(dur) { return (Math.max(0,Math.min(100,dur/span*100))).toFixed(2)+'%'; }
  function setSeg(id, lm, wm) {
    var el=document.getElementById(id); el.style.left=pL(lm); el.style.width=pW(wm);
  }
  function setH(id, h) { document.getElementById(id).style.height = h; }

  // Update vline heights to span all rows
  var canvas = document.getElementById('dt-tl2-canvas');
  var vlineH = canvas.clientHeight + 'px';
  ['dt-tl2-vl-s','dt-tl2-vl-e','dt-tl2-vl-n'].forEach(function(id){
    document.getElementById(id).style.height = vlineH;
  });

  // Segments
  setSeg('dt-tl2-fdp',     startMin, actFdp);
  setSeg('dt-tl2-maxfdp',  startMin, maxFdp);
  document.getElementById('dt-tl2-maxfdp-lbl').textContent = 'Max '+dtFmtH(maxFdp);
  setSeg('dt-tl2-minrest', endMin,   minRest);
  document.getElementById('dt-tl2-minrest-lbl').textContent = 'Min Req '+dtFmtH(minRest);

  if (restEnd !== null) {
    setSeg('dt-tl2-rest', restStart, restEnd - restStart);
    document.getElementById('dt-tl2-rest-lbl').textContent = 'Rest '+dtFmtH(restEnd - restStart);
    document.getElementById('dt-tl2-rest-row').style.display = '';
  } else {
    document.getElementById('dt-tl2-rest-row').style.display = 'none';
  }

  // Vlines
  document.getElementById('dt-tl2-vl-s').style.left = pL(startMin);
  document.getElementById('dt-tl2-vl-e').style.left = pL(endMin);
  if (restEnd !== null) {
    document.getElementById('dt-tl2-vl-n').style.left = pL(restEnd);
    document.getElementById('dt-tl2-vl-n').style.display = '';
  } else {
    document.getElementById('dt-tl2-vl-n').style.display = 'none';
  }

  // WOCL band — find first occurrence within span
  var woclBase = ((2*60 - tz*60) % 1440 + 1440) % 1440;
  var wBand = document.getElementById('dt-tl2-wocl'), woclShown = false;
  for (var d=0; d<3; d++) {
    var ws = woclBase + d*1440, we = ws + 3*60;
    if (ws < spanEnd && we > startMin) {
      wBand.style.left = pL(ws); wBand.style.width = pW(3*60);
      wBand.style.height = '100%'; wBand.style.display = '';
      woclShown = true; break;
    }
  }
  if (!woclShown) wBand.style.display = 'none';

  // Tick labels
  function fmtUTC(m) {
    var t=((m%1440)+1440)%1440, h=Math.floor(t/60), mm=t%60;
    return (h<10?'0':'')+h+':'+(mm<10?'0':'')+mm+'Z';
  }
  function fmtDayUTC(m) {
    var day = Math.floor((startMin + (m - startMin)) / 1440);
    var now = new Date(); var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day);
    return (d.getDate()<10?'0':'')+d.getDate()+'/'+(d.getMonth()+1<10?'0':'')+(d.getMonth()+1);
  }
  var html = '';
  html += '<div class="dt-tl2-tick" style="left:'+pL(startMin)+'">Start<br>'+fmtUTC(startMin)+'</div>';
  html += '<div class="dt-tl2-tick" style="left:'+pL(endMin)+'">Rst Start<br>(FDP End)</div>';
  if (woclShown) {
    var woclMid = woclBase + (woclBase < startMin ? 1440 : 0) + 90;
    if (woclMid > startMin && woclMid < spanEnd)
      html += '<div class="dt-tl2-tick" style="left:'+pL(woclMid)+'">WOCL</div>';
  }
  if (restEnd !== null)
    html += '<div class="dt-tl2-tick" style="left:'+pL(restEnd)+'">Next Rpt<br>'+fmtUTC(restEnd)+'</div>';
  document.getElementById('dt-tl2-ticks').innerHTML = html;
}

function dtMinRest(crew, ftMin) {
  var ft = ftMin / 60;
  if (crew === 2) return ft <= 8 ? 10*60 : 18*60;
  if (crew === 3) return ft <= 8 ? 10*60 : ft <= 12 ? 18*60 : 24*60;
  return ft <= 8 ? 10*60 : ft <= 16 ? 18*60 : 22*60;
}

function dtFmtHM(m) {
  if (m < 0) m = 0;
  var h = Math.floor(m/60); var mm = m%60;
  return h + 'h ' + (mm<10?'0':'') + mm + 'm';
}

function dtFmtUTC(m) {
  var t = ((m%1440)+1440)%1440;
  var h = Math.floor(t/60); var mm = t%60;
  return (h<10?'0':'') + h + ':' + (mm<10?'0':'') + mm + 'Z';
}

function dtDayMin(dayId, hId, mId) {
  var d = parseInt(document.getElementById(dayId).value);
  var h = parseInt(document.getElementById(hId).value);
  var m = parseInt(document.getElementById(mId).value);
  if (isNaN(h) || isNaN(m)) return null;
  var base = isNaN(d) ? 0 : d * 1440;
  return base + h*60 + m;
}

function dtSelectCrew(btn) {
  document.querySelectorAll('.dt-crew-btn').forEach(function(b){b.classList.remove('active');});
  btn.classList.add('active');
  var crew = parseInt(btn.dataset.crew);
  document.getElementById('dt-c1-row').style.display   = crew >= 3 ? 'flex' : 'none';
  document.getElementById('dt-disc-row').style.display = crew === 3 ? 'flex' : 'none';
  if (crew !== 3) document.getElementById('dt-disc').checked = false;
  if (crew < 3)   document.getElementById('dt-c1').checked  = false;
}

function dtSetMode(mode) {
  dtMode = mode;
  document.getElementById('dt-mode-home').classList.toggle('active', mode==='home');
  document.getElementById('dt-mode-out').classList.toggle('active',  mode==='out');
  document.getElementById('dt-next-section').style.display  = mode==='home' ? 'block' : 'none';
  document.getElementById('dt-hotel-section').style.display = mode==='out'  ? 'block' : 'none';
}

function dtCardState(cardId, ok) {
  var el = document.getElementById(cardId);
  el.classList.remove('ok','warn','err');
  el.classList.add(ok === true ? 'ok' : ok === false ? 'err' : '');
}

function dtWoclCheck(startMin, endMin, tzOffset) {
  // WOCL = 02:00–05:00 local = (02:00 - tzOffset) UTC
  var woclStart = (2*60 - tzOffset*60 + 1440*3) % 1440;
  var woclEnd   = (5*60 - tzOffset*60 + 1440*3) % 1440;
  // Check if FDP window overlaps WOCL (simple daily check)
  var s = startMin % 1440, e = endMin % 1440;
  function overlaps(a1,a2,b1,b2) {
    if (b1 < b2) return a1 < b2 && a2 > b1;
    return a1 < b2 || a2 > b1; // wraps midnight
  }
  if (woclStart < woclEnd) return overlaps(s, e, woclStart, woclEnd);
  return s < woclEnd || e > woclStart;
}

function dtCalculate() {
  var crew  = parseInt(document.querySelector('.dt-crew-btn.active').dataset.crew);
  var hasC1 = document.getElementById('dt-c1').checked;
  var disc  = crew===3 && document.getElementById('dt-disc').checked;
  var tz    = dtGetTzOffset(document.getElementById('dt-tz').value);

  var startMin = dtDayMin('dt-s-day','dt-s-h','dt-s-m');
  var endMin   = dtDayMin('dt-e-day','dt-e-h','dt-e-m');
  var ftMin    = (parseInt(document.getElementById('dt-ft-h').value)||0)*60 +
                 (parseInt(document.getElementById('dt-ft-m').value)||0);

  if (startMin === null || endMin === null) {
    alert('請輸入 FDP Start 和 FDP End 時間');
    return;
  }

  // If end < start (crossed midnight), add 1 day
  if (endMin <= startMin) endMin += 1440;

  var maxFdp  = DT_MAX_FDP[crew] + (disc ? 2*60 : 0);
  var maxFt   = hasC1 ? DT_MAX_FT[crew].c1 : DT_MAX_FT[crew].noC1;
  var actFdp  = endMin - startMin;
  var minRest = dtMinRest(crew, ftMin);

  // Rest calculation
  var restStart = null, restEnd = null, actRest = null;
  if (dtMode === 'home') {
    var nxtMin = dtDayMin('dt-n-day','dt-n-h','dt-n-m');
    if (nxtMin !== null) {
      restStart = endMin; restEnd = nxtMin;
      if (restEnd <= restStart) restEnd += 1440;
      actRest = restEnd - restStart;
    }
  } else {
    var ciMin = dtDayMin('dt-ci-day','dt-ci-h','dt-ci-m');
    var coMin = dtDayMin('dt-co-day','dt-co-h','dt-co-m');
    if (ciMin !== null && coMin !== null) {
      restStart = ciMin; restEnd = coMin;
      if (restEnd <= restStart) restEnd += 1440;
      actRest = restEnd - restStart;
    }
  }

  // FDP card
  var fdpOk = actFdp <= maxFdp;
  document.getElementById('dt-r-fdp').textContent     = dtFmtHM(actFdp);
  document.getElementById('dt-r-fdp-max').textContent = 'Max: ' + dtFmtHM(maxFdp) + (disc ? ' (incl. PIC disc.)' : '');
  dtCardState('dt-card-fdp', fdpOk);

  // FT card
  var ftOk = ftMin === 0 ? null : ftMin <= maxFt;
  document.getElementById('dt-r-ft').textContent     = ftMin > 0 ? dtFmtHM(ftMin) : '—';
  document.getElementById('dt-r-ft-max').textContent = 'Max: ' + dtFmtHM(maxFt) + (hasC1 ? ' (C1)' : '');
  dtCardState('dt-card-ft', ftOk);

  // Rest card
  if (actRest !== null) {
    var restOk = actRest >= minRest;
    document.getElementById('dt-r-rest').textContent     = dtFmtHM(actRest) + (restOk ? ' ✓' : ' ✗');
    document.getElementById('dt-r-rest-min').textContent = 'Min: ' + dtFmtHM(minRest);
    dtCardState('dt-card-rest', restOk);
    document.getElementById('dt-card-rest').style.display = '';
  } else {
    document.getElementById('dt-r-rest').textContent     = '—';
    document.getElementById('dt-r-rest-min').textContent = 'Min required: ' + dtFmtHM(minRest);
    dtCardState('dt-card-rest', null);
  }

  // Ext note
  var extNote = document.getElementById('dt-ext-note');
  if (disc) { extNote.textContent = '🟣 PIC Discretion applied: +2h to Max FDP'; extNote.style.display='block'; }
  else extNote.style.display = 'none';

  // WOCL
  var woclHit = dtWoclCheck(startMin, endMin, tz);
  var woclBox = document.getElementById('dt-wocl-box');
  if (woclHit) {
    document.getElementById('dt-wocl-msg').textContent = 'FDP 觸碰 WOCL 時段。連續2天需34h休息，連續3天需54h休息。例外：每次WOCL後有14h休息則免除。';
    woclBox.style.display = 'block';
  } else {
    woclBox.style.display = 'none';
  }

  // Timeline
  dtRenderTimeline(startMin, endMin, maxFdp, restStart, restEnd, minRest, tz);

  document.getElementById('dt-results-area').style.display = 'block';
  document.getElementById('dt-placeholder').style.display  = 'none';
}

// ── Boot ─────────────────────────────────────────────────────────────────────
showMain();
// 預設顯示簡報箱 datis 分頁 → 立即載入初始天氣資料
wxLoaded = true; loadWxRegion(wxCurrentRegion);
// ── Service Worker 註冊 ───────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function(){});
}
</script>
</body>
</html>`;
}
