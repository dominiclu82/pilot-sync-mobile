import express from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { config } from 'dotenv';
import { OUTPUT_DIR, ROOT, loadCredentials } from './config.js';
import { generateICSHeadless } from './generate-ics-headless.js';
import { syncICS, SyncResult } from './upload-ics.js';
import { getSpaStyles } from './spa/styles.js';
import { getSpaHtmlBody } from './spa/html-body.js';
import { getSpaCoreJs } from './spa/js-core.js';
import { getSpaWeatherJs } from './spa/js-weather.js';
import { getSpaDutyTimeJs } from './spa/js-duty-time.js';
import { getSpaGateInfoJs } from './spa/js-gate-info.js';
import { getSpaPaJs } from './spa/js-pa.js';
import { getSpaAirportDataJs } from './spa/js-airport-data.js';
import { getSpaCalendarJs } from './spa/js-calendar-wrap.js';
import { getSpaLiveRadarJs } from './spa/js-live-radar.js';
import { getSpaFr24RadarJs } from './spa/js-fr24-radar.js';
import { getSpaBriefingCardJs } from './spa/js-briefing-card.js';
import { getSpaCrewRestJs } from './spa/js-crew-rest.js';
import { getSpaSubtabReorderJs } from './spa/js-subtab-reorder.js';
import FR24Pkg from 'flightradarapi';


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

// ── PKCE store ───────────────────────────────────────────────────────────────
const _pkceStore = new Map<string, { codeVerifier: string; expires: number }>();
function _pkceCleanup() {
  const now = Date.now();
  for (const [k, v] of _pkceStore) if (now > v.expires) _pkceStore.delete(k);
}
function _pkceGenerate() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  return { codeVerifier, codeChallenge, state };
}

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

app.get('/', (_req, res) => { res.redirect('/main'); });

app.get('/main', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(getSPAHtml());
});

app.get('/share', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(getSPAHtml(undefined, ['sync']));
});

// ── Privacy Policy & Terms ───────────────────────────────────────────────────
const _legalPageStyle = `
  body{background:#111;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:24px;max-width:720px;margin:0 auto;line-height:1.7;font-size:15px}
  h1{color:#60b0ff;font-size:1.4em;margin-bottom:4px}
  h2{color:#88c8ff;font-size:1.1em;margin-top:28px}
  p,li{color:#ccc}
  .zh{color:#999;font-size:.92em}
  a{color:#60b0ff}
  .updated{font-size:.8em;color:#888;margin-bottom:24px}
`;

app.get('/faq', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CrewSync – FAQ 隱私與安全</title><style>${_legalPageStyle}
  .q{color:#60b0ff;font-weight:700;margin-top:24px;font-size:1em}
  .a{margin-top:6px}
  .a-zh{color:#999;font-size:.92em;margin-top:4px}
</style></head><body>
<h1>🔒 Privacy &amp; Security FAQ 隱私與安全</h1>
<div class="updated">Last updated 最後更新: 2026-03-11</div>

<div class="q">Are My Credentials Safe? 你的帳號密碼安全嗎？</div>
<div class="a">Your employee ID and password are only used for a few seconds during sync to log into the roster system. Once complete, the server discards them immediately. Your employee ID is stored locally in your browser for convenience; your password is never stored.</div>
<div class="a-zh">安全。你輸入的員工編號和密碼只會在同步的那幾秒鐘內使用，用來登入班表系統擷取資料。同步完成後，伺服器立即丟棄，不留任何紀錄。你的員工編號會存在你自己的瀏覽器裡（方便下次自動填入），密碼則完全不儲存，由瀏覽器的密碼管理器自行處理。</div>

<div class="q">What Does Google Authorization Do? Google 日曆授權做了什麼？</div>
<div class="a">One thing only: writing your roster into your Google Calendar. We do not read, modify, or share any existing data in your calendar. The authorization token is stored only in your browser and is never uploaded to the server.</div>
<div class="a-zh">只做一件事：把你的班表寫進你的 Google 日曆。我們不會讀取、修改或分享你日曆裡的任何現有資料。授權產生的令牌只存在你自己的瀏覽器裡，不會上傳到伺服器。</div>

<div class="q">Is This Tool Free? 這個工具收費嗎？</div>
<div class="a">Completely free. This tool is independently developed solely to help crew members sync their roster — no commercial purpose whatsoever.</div>
<div class="a-zh">完全免費。本工具由個人開發者獨立開發，純粹為了方便機組人員同步班表，沒有任何商業目的。</div>

<div class="q">Disclaimer 免責聲明</div>
<div class="a">The developer has taken reasonable measures to ensure data security. However, this is not an official company application. Please assess the risks before use; if you have any privacy concerns, do not use this tool.</div>
<div class="a-zh">開發者已盡合理努力確保資料安全，但本工具並非公司官方應用程式。使用前請自行評估風險；若對隱私有任何疑慮，請勿使用。</div>

<div style="margin-top:36px;font-size:.85em;display:flex;gap:16px">
  <a href="/privacy">Privacy Policy 隱私權政策</a>
  <a href="/terms">Terms of Service 服務條款</a>
</div>
</body></html>`);
});

app.get('/privacy', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CrewSync – Privacy Policy 隱私權政策</title><style>${_legalPageStyle}</style></head><body>
<h1>Privacy Policy 隱私權政策</h1>
<div class="updated">Last updated 最後更新: 2026-03-13</div>

<h2>Overview 概述</h2>
<p>CrewSync is a flight operations toolkit for airline crew members. We respect your privacy and are committed to protecting your personal data.</p>
<p class="zh">CrewSync 是一款航空組員飛行操作工具。我們尊重您的隱私，並致力於保護您的個人資料。</p>

<h2>1. Data Accessed 存取的資料</h2>
<p>With your explicit authorization via Google OAuth 2.0, CrewSync accesses your Google Calendar to read existing events and write flight roster events. The specific scope used is <code>https://www.googleapis.com/auth/calendar</code> (read and write access to Google Calendar).</p>
<p class="zh">經您透過 Google OAuth 2.0 明確授權，CrewSync 存取您的 Google 日曆以讀取現有事件及寫入飛行班表事件。使用的權限範圍為 <code>calendar</code>（Google 日曆讀寫權限）。</p>

<h2>2. Data Usage 資料使用方式</h2>
<ul>
  <li>CrewSync uses your Google Calendar data <strong>solely</strong> to synchronize your flight roster: reading existing calendar events to avoid duplicate entries, and creating/updating calendar events based on your crew roster.</li>
  <li class="zh">CrewSync <strong>僅</strong>將您的 Google 日曆資料用於同步飛行班表：讀取現有事件以避免重複建立，並根據您的組員班表新增或更新日曆事件。</li>
  <li>CrewSync does <strong>not</strong> use your data for advertising, analytics, or any purpose other than the roster synchronization feature you initiated.</li>
  <li class="zh">CrewSync <strong>不會</strong>將您的資料用於廣告、分析或班表同步以外的任何用途。</li>
</ul>
<p><strong>Google API Services User Data Policy Compliance:</strong> CrewSync's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<p class="zh"><strong>符合 Google API 服務使用者資料政策：</strong>CrewSync 對於從 Google API 收到的資訊的使用和轉移，將遵守 <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Google API 服務使用者資料政策</a>，包括其中的「受限使用」要求。</p>

<h2>3. Data Sharing 資料分享</h2>
<ul>
  <li>CrewSync does <strong>not</strong> sell, share, or transfer your Google user data to any third party.</li>
  <li class="zh">CrewSync <strong>不會</strong>出售、分享或轉移您的 Google 使用者資料給任何第三方。</li>
  <li>No Google user data is used for advertising or shared with data brokers.</li>
  <li class="zh">不會將 Google 使用者資料用於廣告或提供給資料仲介。</li>
</ul>

<h2>4. Data Storage &amp; Protection 資料儲存與保護</h2>
<ul>
  <li>All user data (roster, settings, OAuth tokens) is stored <strong>locally on your device</strong> using browser localStorage. CrewSync does <strong>not</strong> store any personal data on its servers.</li>
  <li class="zh">所有使用者資料（班表、設定、OAuth token）皆透過瀏覽器 localStorage <strong>儲存在您的裝置上</strong>。CrewSync <strong>不會</strong>在伺服器上儲存任何個人資料。</li>
  <li>OAuth tokens are stored only in your browser's localStorage and are never transmitted to or stored on our servers.</li>
  <li class="zh">OAuth token 僅儲存於您瀏覽器的 localStorage，絕不會傳輸至或儲存於我們的伺服器。</li>
  <li>Data protection measures: all communication uses HTTPS encryption; OAuth 2.0 with PKCE (S256) is used for secure authorization; the server acts only as a proxy and does not retain any user data.</li>
  <li class="zh">資料保護措施：所有通訊使用 HTTPS 加密；OAuth 2.0 搭配 PKCE (S256) 進行安全授權；伺服器僅作為代理，不保留任何使用者資料。</li>
</ul>

<h2>5. Data Retention &amp; Deletion 資料保留與刪除</h2>
<ul>
  <li>Since all data is stored locally in your browser, you have full control over data retention. Data is retained only as long as it remains in your browser's localStorage.</li>
  <li class="zh">由於所有資料皆儲存在您的瀏覽器本機，您對資料保留擁有完全控制權。資料僅在您瀏覽器的 localStorage 中保留。</li>
  <li>To delete all CrewSync data: clear your browser's localStorage for the CrewSync site, or use the app's built-in "Reset" functions.</li>
  <li class="zh">刪除所有 CrewSync 資料：清除瀏覽器中 CrewSync 網站的 localStorage，或使用 app 內建的「重設」功能。</li>
  <li>To revoke Google Calendar access: visit your <a href="https://myaccount.google.com/permissions" target="_blank">Google Account permissions</a> and remove CrewSync. This immediately revokes all access to your Google Calendar data.</li>
  <li class="zh">撤銷 Google 日曆存取權：前往 <a href="https://myaccount.google.com/permissions" target="_blank">Google 帳戶權限設定</a> 移除 CrewSync，即可立即撤銷所有 Google 日曆資料的存取權。</li>
</ul>

<h2>Third-Party Services 第三方服務</h2>
<ul>
  <li><strong>Google Calendar API：</strong>Used solely for roster synchronization as authorized by you.</li>
  <li class="zh">僅用於您授權的班表同步功能。</li>
  <li><strong>Aviation weather APIs：</strong>CrewSync fetches METAR/TAF data from public aviation weather services. No personal data is sent in these requests.</li>
  <li class="zh">CrewSync 從公開的航空氣象服務取得 METAR/TAF 資料，這些請求不包含任何個人資料。</li>
</ul>

<h2>Contact 聯繫方式</h2>
<p>If you have questions about this privacy policy, please contact us via <a href="https://github.com/dominiclu82/pilot-sync-mobile/issues" target="_blank">GitHub Issues</a>.</p>
<p class="zh">如有任何關於本隱私權政策的問題，請透過 <a href="https://github.com/dominiclu82/pilot-sync-mobile/issues" target="_blank">GitHub Issues</a> 聯繫我們。</p>

<div style="margin-top:36px;font-size:.85em;display:flex;gap:16px">
  <a href="/faq">FAQ 隱私與安全問答</a>
  <a href="/terms">Terms of Service 服務條款</a>
</div>
</body></html>`);
});

app.get('/terms', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CrewSync – Terms of Service 服務條款</title><style>${_legalPageStyle}</style></head><body>
<h1>Terms of Service 服務條款</h1>
<div class="updated">Last updated 最後更新: 2026-03-11</div>

<h2>Acceptance 接受條款</h2>
<p>By using CrewSync, you agree to these terms. If you do not agree, please do not use the service.</p>
<p class="zh">使用 CrewSync 即表示您同意本條款。若不同意，請勿使用本服務。</p>

<h2>Description of Service 服務說明</h2>
<p>CrewSync is a free flight operations toolkit that provides roster synchronization, weather briefing, crew rest calculation, and related aviation utilities for pilots.</p>
<p class="zh">CrewSync 是一款免費的飛行操作工具，提供班表同步、天氣簡報、輪休計算及相關航空工具。</p>

<h2>Use at Your Own Risk 風險自負</h2>
<p>CrewSync is provided as a supplementary tool only. All information (weather, duty time calculations, crew rest schedules, etc.) is for <strong>reference purposes only</strong> and must not be used as the sole basis for operational decisions. Always refer to official sources and company procedures.</p>
<p class="zh">CrewSync 僅為輔助工具。所有資訊（天氣、工時計算、輪休排程等）<strong>僅供參考</strong>，不得作為操作決策的唯一依據。請務必參照官方資料及公司程序。</p>

<h2>No Warranty 無擔保</h2>
<p>CrewSync is provided "as is" without warranty of any kind. We do not guarantee the accuracy, completeness, or availability of any data or functionality.</p>
<p class="zh">CrewSync 以「現況」提供，不附帶任何擔保。我們不保證任何資料或功能的準確性、完整性或可用性。</p>

<h2>Google Calendar Integration Google 日曆整合</h2>
<p>CrewSync accesses your Google Calendar only with your explicit consent via Google OAuth. You may revoke this access at any time.</p>
<p class="zh">CrewSync 僅在您透過 Google OAuth 明確同意後存取您的 Google 日曆。您可以隨時撤銷此授權。</p>

<h2>Limitation of Liability 責任限制</h2>
<p>CrewSync and its developers shall not be liable for any damages arising from the use of this service.</p>
<p class="zh">CrewSync 及其開發者對因使用本服務而產生的任何損害不承擔責任。</p>

<h2>Changes 條款變更</h2>
<p>We may update these terms from time to time. Continued use of CrewSync after changes constitutes acceptance of the updated terms.</p>
<p class="zh">我們可能不定期更新本條款。條款變更後繼續使用 CrewSync 即視為接受更新後的條款。</p>

<h2>Contact 聯繫方式</h2>
<p>Questions about these terms can be directed to <a href="https://github.com/dominiclu82/pilot-sync-mobile/issues" target="_blank">GitHub Issues</a>.</p>
<p class="zh">如有任何關於本條款的問題，請透過 <a href="https://github.com/dominiclu82/pilot-sync-mobile/issues" target="_blank">GitHub Issues</a> 聯繫我們。</p>

<div style="margin-top:36px;font-size:.85em;display:flex;gap:16px">
  <a href="/faq">FAQ 隱私與安全問答</a>
  <a href="/privacy">Privacy Policy 隱私權政策</a>
</div>
</body></html>`);
});

const _viewTabMap: Record<string, string> = { sync: 'sync', ops: 'briefing', fr24: 'fr24', gate: 'gate' };
for (const [route, tab] of Object.entries(_viewTabMap)) {
  app.get('/' + route, (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(getSPAHtml(tab));
  });
}

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
    start_url: '/main',
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
    _pkceCleanup();
    const { codeVerifier, codeChallenge, state } = _pkceGenerate();
    _pkceStore.set(state, { codeVerifier, expires: Date.now() + 5 * 60 * 1000 });
    const creds = loadCredentials();
    const client = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret, REDIRECT_URI);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      scope: ['https://www.googleapis.com/auth/calendar'],
      code_challenge: codeChallenge,
      code_challenge_method: 'S256' as any,
      state,
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
const CACHE = 'crewsync-v2';
const SHELL = ['/', '/main', '/share'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
const _offlinePage = '<html><body style="background:#111;color:#aaa;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Offline</h2><p>Please connect to the internet and reload.</p></div></body></html>';
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (url.includes('/api/fids')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then(r => r || new Response('', {status:503}))));
    return;
  }
  if (url.includes('/api/metar')) {
    e.respondWith(fetch(e.request).then(r => {
      const clone = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || new Response('', {status:503}))));
    return;
  }
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => {
      caches.open(CACHE).then(c => c.put(e.request, r.clone()));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/main').then(r2 => r2 || new Response(_offlinePage, {headers:{'Content-Type':'text/html'}})))));
    return;
  }
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

// ── FIDS proxy ──────────────────────────────────────────────────────────────
app.get('/api/fids', async (req, res) => {
  try {
    let odate = req.query.date as string || '';
    if (!odate || !/^\d{4}\/\d{2}\/\d{2}$/.test(odate)) {
      const now = new Date();
      const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      odate = tw.getUTCFullYear() + '/' +
        String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
        String(tw.getUTCDate()).padStart(2, '0');
    }

    const base = {
      ODate: odate, OTimeOpen: null, OTimeClose: null,
      BNO: null, AState: '', language: 'ch', keyword: ''
    };
    const hdrs: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://www.taoyuan-airport.com',
      'Referer': 'https://www.taoyuan-airport.com/flight_arrival'
    };
    const ep = 'https://www.taoyuan-airport.com/api/api/flight/a_flight';

    const [dR, aR] = await Promise.all([
      fetch(ep, { method: 'POST', headers: hdrs, body: JSON.stringify({ ...base, AState: 'D' }) }),
      fetch(ep, { method: 'POST', headers: hdrs, body: JSON.stringify({ ...base, AState: 'A' }) })
    ]);

    if (!dR.ok || !aR.ok) {
      console.error(`FIDS proxy upstream error: dep=${dR.status} arr=${aR.status}`);
      res.status(502).json({ error: `upstream ${dR.status}/${aR.status}` });
      return;
    }

    const dep = await dR.json();
    const arr = await aR.json();
    res.json({ dep, arr, date: odate });
  } catch (e: any) {
    console.error('FIDS proxy error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── OpenSky Network proxy (OAuth2) ────────────────────────────────────────────
let _oskyCache: { ts: number; data: any; remaining: number | null } = { ts: 0, data: null, remaining: null };
let _oskyToken: { token: string; expires: number } = { token: '', expires: 0 };

async function _oskyGetToken(): Promise<string> {
  const now = Date.now();
  if (_oskyToken.token && now < _oskyToken.expires - 60000) return _oskyToken.token;
  const cid = process.env.OPENSKY_CLIENT_ID;
  const csec = process.env.OPENSKY_CLIENT_SECRET;
  if (!cid || !csec) return '';
  try {
    const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(csec)}`
    });
    if (!r.ok) { console.error('OpenSky token error:', r.status); return ''; }
    const d = await r.json();
    _oskyToken = { token: d.access_token, expires: now + (d.expires_in || 1800) * 1000 };
    return _oskyToken.token;
  } catch (e: any) { console.error('OpenSky token fetch error:', e.message); return ''; }
}

app.get('/api/opensky', async (req, res) => {
  try {
    const now = Date.now();
    // server-side 8s cache (slightly less than 10s refresh interval)
    if (_oskyCache.data && now - _oskyCache.ts < 8000) {
      res.json({ ..._oskyCache.data, _remaining: _oskyCache.remaining });
      return;
    }
    let url = 'https://opensky-network.org/api/states/all';
    const { lamin, lomin, lamax, lomax } = req.query;
    const params: string[] = [];
    if (lamin) params.push(`lamin=${lamin}`);
    if (lomin) params.push(`lomin=${lomin}`);
    if (lamax) params.push(`lamax=${lamax}`);
    if (lomax) params.push(`lomax=${lomax}`);
    if (params.length) url += '?' + params.join('&');
    const headers: Record<string, string> = { 'User-Agent': 'CrewSync/1.0' };
    const token = await _oskyGetToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(url, { headers });
    const remaining = r.headers.get('x-rate-limit-remaining');
    const remainNum = remaining != null ? parseInt(remaining, 10) : null;
    if (!r.ok) {
      if (r.status === 429) {
        const retryAfter = r.headers.get('x-rate-limit-retry-after-seconds');
        res.status(429).json({ error: 'rate_limit', retryAfter: retryAfter ? parseInt(retryAfter, 10) : null, _remaining: 0 });
        return;
      }
      res.status(502).json({ error: `OpenSky returned ${r.status}` });
      return;
    }
    const data = await r.json();
    _oskyCache = { ts: now, data, remaining: remainNum };
    res.json({ ...data, _remaining: remainNum });
  } catch (e: any) {
    console.error('OpenSky proxy error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── FR24 proxy ───────────────────────────────────────────────────────────────
const _fr24Api = new FR24Pkg.FlightRadar24API();
let _fr24Cache: { ts: number; bounds: string; data: any } = { ts: 0, bounds: '', data: null };

app.get('/api/fr24', async (req, res) => {
  try {
    const now = Date.now();
    // bounds format: "latN,latS,lonW,lonE"
    const b = req.query.bounds as string || '';
    if (_fr24Cache.data && now - _fr24Cache.ts < 8000 && _fr24Cache.bounds === b) {
      res.json(_fr24Cache.data);
      return;
    }
    const flights = await _fr24Api.getFlights(null, b || null);
    const result = flights.map((f: any) => ({
      id: f.id || '',
      cs: (f.callsign || '').trim(),
      lat: f.latitude,
      lon: f.longitude,
      alt: f.altitude,
      hdg: f.heading,
      spd: f.groundSpeed,
      vs: f.verticalSpeed,
      sq: f.squawk || '',
      icao24: f.icao24bit || '',
      reg: f.registration || '',
      type: f.aircraftCode || '',
      from: f.originAirportIata || '',
      to: f.destinationAirportIata || '',
      num: f.number || '',
      gnd: f.onGround ? 1 : 0
    }));
    const data = { flights: result, time: Math.floor(now / 1000) };
    _fr24Cache = { ts: now, bounds: b, data };
    res.json(data);
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('Cloudflare') || msg.includes('unexpected')) {
      res.status(429).json({ error: 'rate_limit' });
    } else {
      console.error('FR24 proxy error:', msg);
      res.status(502).json({ error: msg });
    }
  }
});

app.get('/api/fr24/detail', async (req, res) => {
  try {
    const flightId = req.query.id as string;
    if (!flightId) { res.status(400).json({ error: 'missing id' }); return; }
    const details = await _fr24Api.getFlightDetails({ id: flightId } as any);
    res.json(details || {});
  } catch (e: any) {
    console.error('FR24 detail error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── FR24 detail background cache (gate info) ────────────────────────────────
const _fr24DetailCache: { flights: Record<string, any>; updatedAt: number } = { flights: {}, updatedAt: 0 };
let _fr24DetailRefreshing = false;

const _fr24AirlineConf: Record<string, { icao: string; iata: string }> = {
  JX: { icao: 'SJX', iata: 'JX' },
  BR: { icao: 'EVA', iata: 'BR' },
  CI: { icao: 'CAL', iata: 'CI' }
};

async function _fr24RefreshDetails(): Promise<void> {
  if (_fr24DetailRefreshing) return;
  _fr24DetailRefreshing = true;
  console.log('[FR24-Detail] Starting refresh...');
  try {
    // Get all flights (no bounds = worldwide)
    const flights = await _fr24Api.getFlights(null, null);
    // Filter JX/BR/CI flights
    const targets: { id: string; cs: string; num: string; from: string; to: string }[] = [];
    for (const f of flights) {
      const cs = ((f as any).callsign || '').trim();
      const num = (f as any).number || '';
      const id = (f as any).id || '';
      if (!id || !cs) continue;
      for (const al of Object.keys(_fr24AirlineConf)) {
        const conf = _fr24AirlineConf[al];
        if (cs.startsWith(conf.icao)) {
          targets.push({ id, cs, num, from: (f as any).originAirportIata || '', to: (f as any).destinationAirportIata || '' });
          break;
        }
      }
    }
    console.log('[FR24-Detail] Found', targets.length, 'flights:', targets.map(t => t.num || t.cs).join(', '));

    const newFlights: Record<string, any> = {};
    for (const t of targets) {
      try {
        const detail = await _fr24Api.getFlightDetails({ id: t.id } as any);
        if (!detail) continue;
        const airport = (detail as any).airport || {};
        const orig = airport.origin || {};
        const dest = airport.destination || {};
        const origInfo = orig.info || {};
        const destInfo = dest.info || {};
        const origCode = orig.code || {};
        const destCode = dest.code || {};
        // Convert callsign (SJX012) to IATA fno (JX12)
        let fno = t.num || t.cs;
        for (const al of Object.keys(_fr24AirlineConf)) {
          const conf = _fr24AirlineConf[al];
          if (fno.startsWith(conf.icao)) {
            fno = fno.replace(new RegExp('^' + conf.icao + '0*'), conf.iata);
            break;
          }
        }
        // Remove leading zeros from number part: JX012 → JX12
        fno = fno.replace(/^([A-Z]{2})0+(\d)/, '$1$2');
        const timeInfo = (detail as any).time || {};
        const sched = timeInfo.scheduled || {};
        const real = timeInfo.real || {};
        newFlights[fno] = {
          fno,
          origin: { iata: origCode.iata || t.from || '', gate: origInfo.gate || '', terminal: origInfo.terminal || '' },
          destination: { iata: destCode.iata || t.to || '', gate: destInfo.gate || '', terminal: destInfo.terminal || '' },
          scheduledDep: sched.departure ? new Date(sched.departure * 1000).toISOString() : '',
          actualDep: real.departure ? new Date(real.departure * 1000).toISOString() : '',
          scheduledArr: sched.arrival ? new Date(sched.arrival * 1000).toISOString() : '',
          actualArr: real.arrival ? new Date(real.arrival * 1000).toISOString() : '',
          status: ''
        };
      } catch (e: any) {
        console.error('[FR24-Detail] Error fetching', t.num || t.cs, ':', e.message);
      }
      await new Promise(ok => setTimeout(ok, 300));
    }

    _fr24DetailCache.flights = newFlights;
    _fr24DetailCache.updatedAt = Date.now();
    console.log('[FR24-Detail] Cache updated:', Object.keys(newFlights).length, 'flights');
  } catch (e: any) {
    console.error('[FR24-Detail] Refresh error:', e.message);
  } finally {
    _fr24DetailRefreshing = false;
  }
}

// Background refresh: immediately + every 5 minutes
setTimeout(() => _fr24RefreshDetails(), 8000);
setInterval(() => _fr24RefreshDetails(), 5 * 60 * 1000);

app.get('/api/fids-fr24', (_req, res) => {
  if (!_fr24DetailCache.updatedAt) {
    _fr24RefreshDetails();
    return res.json({ flights: {}, updatedAt: null, count: 0, refreshing: true });
  }
  res.json({
    flights: _fr24DetailCache.flights,
    updatedAt: new Date(_fr24DetailCache.updatedAt).toISOString(),
    count: Object.keys(_fr24DetailCache.flights).length
  });
});

// ── FR24 flight schedule (by flight number) ─────────────────────────────────
const _fr24SchedCache: Record<string, { data: any[]; ts: number }> = {};
const _FR24_SCHED_TTL = 5 * 60 * 1000; // 5 分鐘快取

app.get('/api/fr24-schedule', async (req, res) => {
  const fno = ((req.query.fno as string) || '').trim().toUpperCase();
  if (!fno) return res.json({ flights: [] });

  const cached = _fr24SchedCache[fno];
  if (cached && Date.now() - cached.ts < _FR24_SCHED_TTL) {
    return res.json({ flights: cached.data });
  }

  try {
    const url = `https://api.flightradar24.com/common/v1/flight/list.json?query=${encodeURIComponent(fno)}&fetchBy=flight&page=1&limit=10&token=`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
    });
    const json: any = await resp.json();
    const entries: any[] = json?.result?.response?.data || [];
    const flights = entries.map((f: any) => ({
      origin: f.airport?.origin?.code?.iata || '',
      destination: f.airport?.destination?.code?.iata || '',
      scheduledDep: f.time?.scheduled?.departure || null,
      scheduledArr: f.time?.scheduled?.arrival || null,
      actualDep: f.time?.real?.departure || null,
      actualArr: f.time?.real?.arrival || null,
      status: f.status?.text || ''
    }));
    _fr24SchedCache[fno] = { data: flights, ts: Date.now() };
    res.json({ flights });
  } catch (e: any) {
    console.error('[FR24-Schedule]', fno, e.message);
    if (cached) return res.json({ flights: cached.data });
    res.json({ flights: [] });
  }
});

// ── FlightAware background cache ─────────────────────────────────────────────
const _faBase = Buffer.from('aHR0cHM6Ly93d3cuZmxpZ2h0YXdhcmUuY29tL2xpdmUvZmxpZ2h0Lw==', 'base64').toString();
const _faHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };

interface FaCacheEntry {
  flights: Record<string, FaFlightData>;
  updatedAt: number;
}
interface FaFlightData {
  fno: string;
  origin: { iata: string; gate: string; terminal: string };
  destination: { iata: string; gate: string; terminal: string };
  scheduledDep: string;
  actualDep: string;
  scheduledArr: string;
  actualArr: string;
  status: string;
}

const _faAirlineConf: Record<string, { icao: string; iata: string }> = {
  JX: { icao: 'SJX', iata: 'JX' },
  BR: { icao: 'EVA', iata: 'BR' },
  CI: { icao: 'CAL', iata: 'CI' }
};
const _faCaches: Record<string, FaCacheEntry> = {};
const _faRefreshing: Record<string, boolean> = {};

function _parseFaPage(html: string, icaoPrefix: string, iataPrefix: string): FaFlightData[] {
  const m = html.match(/trackpollBootstrap\s*=\s*(\{[\s\S]*?\});\s*(?:var\s|<\/script>)/);
  if (!m) return [];
  let data: any;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const results: FaFlightData[] = [];
  const flights = data?.flights || {};
  for (const id of Object.keys(flights)) {
    const logs = flights[id]?.activityLog?.flights || [];
    for (const f of logs) {
      const orig = f.origin || {};
      const dest = f.destination || {};
      const iataOrig = orig.iata || orig.altIdent || '';
      const iataDest = dest.iata || dest.altIdent || '';
      // Convert ICAO ident (SJX12) to IATA (JX12)
      const displayIdent = f.displayIdent || id.split('-')[0] || '';
      const fno = displayIdent.replace(new RegExp('^' + icaoPrefix), iataPrefix);
      results.push({
        fno,
        origin: { iata: iataOrig, gate: orig.gate || '', terminal: orig.terminal || '' },
        destination: { iata: iataDest, gate: dest.gate || '', terminal: dest.terminal || '' },
        scheduledDep: f.gateDepartureTimes?.scheduled ? new Date(f.gateDepartureTimes.scheduled * 1000).toISOString() : '',
        actualDep: f.gateDepartureTimes?.actual ? new Date(f.gateDepartureTimes.actual * 1000).toISOString() : '',
        scheduledArr: f.gateArrivalTimes?.scheduled ? new Date(f.gateArrivalTimes.scheduled * 1000).toISOString() : '',
        actualArr: f.gateArrivalTimes?.actual ? new Date(f.gateArrivalTimes.actual * 1000).toISOString() : '',
        status: f.flightStatus || (f.cancelled ? 'Cancelled' : '')
      });
    }
  }
  return results;
}

async function _faFetchFlight(icaoIdent: string, icaoPrefix: string, iataPrefix: string): Promise<FaFlightData[]> {
  try {
    const r = await fetch(_faBase + icaoIdent, { headers: _faHeaders });
    if (!r.ok) return [];
    const html = await r.text();
    return _parseFaPage(html, icaoPrefix, iataPrefix);
  } catch { return []; }
}

async function _faRefreshAirline(airline: string): Promise<void> {
  const conf = _faAirlineConf[airline];
  if (!conf) return;
  if (_faRefreshing[airline]) return;
  _faRefreshing[airline] = true;
  console.log('[FA] Starting refresh for', airline, '...');
  try {
    // Get fleet page for active flights
    const fleetBase = Buffer.from('aHR0cHM6Ly93d3cuZmxpZ2h0YXdhcmUuY29tL2xpdmUvZmxlZXQv', 'base64').toString();
    const fleetUrl = fleetBase + conf.icao;
    const r = await fetch(fleetUrl, { headers: _faHeaders });
    if (!r.ok) { console.error('[FA]', airline, 'fleet page error:', r.status); return; }
    const html = await r.text();

    // Extract flight idents from fleet page
    const identSet = new Set<string>();
    const identRe = new RegExp(conf.icao + '\\d+', 'g');
    const identMatches = html.matchAll(identRe);
    for (const im of identMatches) identSet.add(im[0]);

    // Also add scheduled flights from TPE FIDS if available
    try {
      const tpeBase = 'https://www.taoyuan-airport.com/api/api/flight/a_flight';
      const now = new Date();
      const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const odate = tw.getUTCFullYear() + '/' +
        String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
        String(tw.getUTCDate()).padStart(2, '0');
      const hdrs: Record<string, string> = {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.taoyuan-airport.com',
        'Referer': 'https://www.taoyuan-airport.com/flight_arrival'
      };
      const base = { ODate: odate, OTimeOpen: null, OTimeClose: null, BNO: null, AState: '', language: 'ch', keyword: '' };
      const [dR, aR] = await Promise.all([
        fetch(tpeBase, { method: 'POST', headers: hdrs, body: JSON.stringify({ ...base, AState: 'D' }) }),
        fetch(tpeBase, { method: 'POST', headers: hdrs, body: JSON.stringify({ ...base, AState: 'A' }) })
      ]);
      if (dR.ok && aR.ok) {
        const dep = await dR.json();
        const arr = await aR.json();
        for (const f of [...(dep || []), ...(arr || [])]) {
          if (f.ACode?.trim() === airline) {
            const num = (f.FlightNo || '').replace(/\s/g, '');
            if (num) identSet.add(conf.icao + num);
          }
        }
      }
    } catch {}

    console.log('[FA]', airline, 'found', identSet.size, 'flights:', [...identSet].join(', '));

    // Today's date range (Taiwan time, with 6h buffer on each side)
    const now = Date.now();
    const tw = new Date(now + 8 * 60 * 60 * 1000);
    const todayStart = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
    const rangeStart = todayStart.getTime() - 6 * 60 * 60 * 1000;
    const rangeEnd = todayStart.getTime() + 30 * 60 * 60 * 1000;

    // Fetch each flight page (with delay to avoid rate limiting)
    const newFlights: Record<string, FaFlightData> = {};
    for (const ident of identSet) {
      const entries = await _faFetchFlight(ident, conf.icao, conf.iata);
      for (const entry of entries) {
        const key = entry.fno;
        if (!key) continue;
        const depTime = entry.scheduledDep ? new Date(entry.scheduledDep).getTime() : 0;
        const arrTime = entry.scheduledArr ? new Date(entry.scheduledArr).getTime() : 0;
        const refTime = depTime || arrTime;
        if (refTime && (refTime < rangeStart || refTime > rangeEnd)) continue;
        if (!newFlights[key] || entry.origin.gate || entry.destination.gate) {
          newFlights[key] = entry;
        }
      }
      await new Promise(ok => setTimeout(ok, 500));
    }

    _faCaches[airline] = { flights: newFlights, updatedAt: Date.now() };
    console.log('[FA]', airline, 'cache updated:', Object.keys(newFlights).length, 'flights');
  } catch (e: any) {
    console.error('[FA]', airline, 'refresh error:', e.message);
  } finally {
    _faRefreshing[airline] = false;
  }
}

// Background refresh: JX only, immediately + every 5 minutes
setTimeout(() => _faRefreshAirline('JX'), 5000);
setInterval(() => _faRefreshAirline('JX'), 5 * 60 * 1000);

app.get('/api/fids-fa', (req, res) => {
  const airline = (typeof req.query.airline === 'string' ? req.query.airline : 'JX').toUpperCase();
  if (!_faAirlineConf[airline]) {
    return res.json({ flights: {}, updatedAt: null, count: 0 });
  }
  const cache = _faCaches[airline];
  if (!cache || !cache.updatedAt) {
    _faRefreshAirline(airline);
    return res.json({ flights: {}, updatedAt: null, count: 0, refreshing: true });
  }
  // BR/CI: trigger background refresh if cache > 10 minutes old
  if (airline !== 'JX' && Date.now() - cache.updatedAt > 10 * 60 * 1000) {
    _faRefreshAirline(airline);
  }
  res.json({
    flights: cache.flights,
    updatedAt: cache.updatedAt ? new Date(cache.updatedAt).toISOString() : null,
    count: Object.keys(cache.flights).length
  });
});

async function oauthCallback(req: express.Request, res: express.Response) {
  const { code, state } = req.query;
  if (!code) { res.status(400).send('Missing code'); return; }
  const pkceEntry = state ? _pkceStore.get(state as string) : undefined;
  if (pkceEntry) _pkceStore.delete(state as string);
  try {
    const creds = loadCredentials();
    const client = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret, REDIRECT_URI);
    const { tokens } = await client.getToken(
      pkceEntry ? { code: code as string, codeVerifier: pkceEntry.codeVerifier } as any : (code as string)
    );
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

app.get('/api/calendar-events', async (req, res) => {
  try {
    const { refreshToken, start, end } = req.query as Record<string, string>;
    if (!refreshToken || !start || !end) {
      res.status(400).json({ error: 'Missing refreshToken, start, or end' });
      return;
    }
    const creds = loadCredentials();
    const oauth2 = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret);
    oauth2.setCredentials({ refresh_token: refreshToken });

    const calendar = google.calendar({ version: 'v3', auth: oauth2 });
    const calInfo = await calendar.calendarList.get({ calendarId: 'primary' });
    const defaultReminderMins = ((calInfo.data.defaultReminders || []) as Array<{method?: string; minutes?: number}>)
      .map((r: {minutes?: number}) => r.minutes ?? 0).sort((a: number, b: number) => a - b);

    const resp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const events = (resp.data.items || []).map(ev => ({
      id: ev.id,
      title: ev.summary || '(No title)',
      start: ev.start?.dateTime || ev.start?.date || '',
      end: ev.end?.dateTime || ev.end?.date || '',
      allDay: !ev.start?.dateTime,
      color: ev.colorId || null,
      location: ev.location || '',
      description: ev.description || '',
      reminders: ev.reminders?.useDefault
        ? defaultReminderMins
        : (ev.reminders?.overrides || []).map(r => r.minutes ?? 0).sort((a, b) => a - b),
    }));

    const withLoc = events.filter(e => e.location);
    if (withLoc.length) console.log('[Calendar] Events with location:', withLoc.map(e => e.title + ' @ ' + e.location));
    res.json({ events });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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
function getSPAHtml(singleTab?: string, hideTabs?: string[]): string {
  let viewScript = '';
  if (singleTab) {
    viewScript = `
<script>
document.addEventListener('DOMContentLoaded', function() {
  var tab = '${singleTab}';
  var btn = document.getElementById('tabBtn-' + (tab === 'briefing' ? 'briefing' : tab));
  if (btn) switchTab(tab, btn);
  var bar = document.querySelector('.tab-bar');
  if (bar) bar.style.display = 'none';
  document.body.style.paddingBottom = '0';
});
</script>`;
  } else if (hideTabs && hideTabs.length > 0) {
    viewScript = `
<script>
document.addEventListener('DOMContentLoaded', function() {
  var hide = ${JSON.stringify(hideTabs)};
  hide.forEach(function(t) {
    var panel = document.getElementById('tab-' + t);
    if (panel) { panel.style.display = 'none'; panel.classList.remove('tab-active'); }
    var btn = document.getElementById('tabBtn-' + t);
    if (btn) btn.style.display = 'none';
  });
  var firstBtn = document.querySelector('.tab-btn:not([style*="display: none"])');
  if (firstBtn && !document.querySelector('.tab-btn.tab-active:not([style*="display: none"])')) {
    firstBtn.click();
  }
});
</script>`;
  }
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
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css"/>
<title>CrewSync</title>
<meta name="google-site-verification" content="Fq2L0COUDj6prZMQ2jsTL5T1ZSRF_nmQoPzmbOlOras" />
<style>
${getSpaStyles()}
</style>
</head>
<body>
${getSpaHtmlBody()}
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>
<script>
${getSpaCoreJs()}
${getSpaAirportDataJs()}
${getSpaWeatherJs()}
${getSpaDutyTimeJs()}
${getSpaGateInfoJs()}
${getSpaPaJs()}
${getSpaCalendarJs()}
${getSpaLiveRadarJs()}
${getSpaFr24RadarJs()}
${getSpaBriefingCardJs()}
${getSpaCrewRestJs()}
${getSpaSubtabReorderJs()}
</script>${viewScript}
</body>
</html>`;
}
