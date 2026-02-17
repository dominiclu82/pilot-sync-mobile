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
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="CrewSync">
<meta name="theme-color" content="#0a0e1a">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<title>CrewSync</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0a0e1a;--surface:#141927;--card:#1e2740;
  --accent:#3b82f6;--accent-light:#60a5fa;
  --text:#e2e8f0;--muted:#94a3b8;--dim:#475569;
  --success:#22c55e;--error:#ef4444;
  --radius:14px;--safe-bottom:env(safe-area-inset-bottom,0px)
}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:20px 16px calc(20px + var(--safe-bottom));overflow-x:hidden}
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
details.how-to{background:var(--card);border-radius:var(--radius);overflow:hidden}
details.how-to summary{padding:12px 16px;cursor:pointer;font-size:.84em;color:var(--muted);
  display:flex;align-items:center;gap:6px;list-style:none;user-select:none}
details.how-to summary::-webkit-details-marker{display:none}
details.how-to summary::after{content:'›';margin-left:auto;font-size:1.1em;transition:transform .2s}
details.how-to[open] summary::after{transform:rotate(90deg)}
.how-to-body{padding:0 16px 14px;display:flex;flex-direction:column;gap:12px}
.how-to-os{font-size:.82em;line-height:1.7}
.how-to-os strong{color:var(--text);display:block;margin-bottom:2px}
</style>
</head>
<body>

<!-- ══ Main（含帳號 + 月份，一個畫面搞定）══════════════════════════════ -->
<div id="screen-main" class="screen active">
  <div class="logo">
    <span class="logo-icon">✈️</span>
    <div class="logo-title">CrewSync</div>
    <div class="logo-sub">Crew Roster → Google Calendar</div>
  </div>

  <div class="card">
    <!-- Google auth status -->
    <div id="google-badge" class="google-badge">
      <div class="dot dot-no" id="google-dot"></div>
      <div id="google-badge-text" style="flex:1;color:var(--muted)">尚未授權 Google 日曆（第一次需要）</div>
      <button class="btn btn-secondary btn-sm" id="google-auth-btn"
        onclick="doGoogleAuth()" style="width:auto;padding:6px 12px;font-size:.82em">授權</button>
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
    <summary>🔐 首次授權 Google 出現警告？</summary>
    <div class="how-to-body">
      <div class="how-to-os">
        Google 會顯示「這個應用程式未經驗證」的警告畫面，這是正常的。請依以下步驟繼續：<br><br>
        1. 點左下角「<b>進階</b>」<br>
        2. 點「<b>前往 crew-sync.onrender.com（不安全）</b>」<br>
        3. 點「<b>繼續</b>」完成授權
      </div>
    </div>
  </details>

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

// ── Boot ─────────────────────────────────────────────────────────────────────
showMain();
</script>
</body>
</html>`;
}
