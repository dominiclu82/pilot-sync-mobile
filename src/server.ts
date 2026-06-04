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
import { getSpaOvertimeJs } from './spa/js-overtime.ts';
import { getSpaSubtabReorderJs } from './spa/js-subtab-reorder.js';
import { getSpaRosterGridJs } from './spa/js-roster-grid.js';
import { getAirportDbJs } from './spa/js-airport-db.js';
import { getSpaRunwayMapJs } from './spa/js-runway-map.js';
import { getSpaFriendsJs } from './spa/js-friends.js';
import { getSpaGroupsJs } from './spa/js-groups.js';
import { morningRouter, startMorningCron } from './morning.js';
import { pilotLogRouter } from './pilot-log/routes.js';
import { requireAuth, AuthedRequest } from './pilot-log/auth.js';
import { isOwnerUserId } from './pilot-log/beta.js';
import { startPilotLogSnapshotCron } from './pilot-log/schema.js';
import { portfolioRouter, startPortfolio } from './portfolio/routes.js';
import FR24Pkg from 'flightradarapi';
import pg from 'pg';


config({ path: path.join(ROOT, '.env') });

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Database ─────────────────────────────────────────────────────────────────
const _pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } })
  : null;

async function _dbInit() {
  if (!_pool) return;
  try {
    await _pool.query(`
      CREATE TABLE IF NOT EXISTS cs_users (
        email TEXT PRIMARY KEY,
        name TEXT,
        employee_id TEXT,
        rank TEXT CHECK (rank IN ('CAP','SFO','FO')),
        sharing BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cs_rosters (
        id SERIAL PRIMARY KEY,
        employee_id TEXT NOT NULL,
        month TEXT NOT NULL,
        roster_data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, month)
      );
      -- V8.0.41：完整班表（含組員）私有表，給 Pilot Log app 直接帶班表用。
      -- 跟 cs_rosters（分享用、剃組員）刻意分開：這份不分享、不剃組員、只給本人 import。
      CREATE TABLE IF NOT EXISTS cs_rosters_full (
        id SERIAL PRIMARY KEY,
        employee_id TEXT NOT NULL,
        month TEXT NOT NULL,
        roster_data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, month)
      );
    `);
    // Add columns if not exist (for existing tables)
    await _pool.query(`ALTER TABLE cs_users ADD COLUMN IF NOT EXISTS employee_id TEXT`).catch(() => {});
    await _pool.query(`ALTER TABLE cs_users ADD COLUMN IF NOT EXISTS picture TEXT`).catch(() => {});
    await _pool.query(`ALTER TABLE cs_rosters ADD COLUMN IF NOT EXISTS employee_id TEXT`).catch(() => {});
    await _pool.query(`ALTER TABLE cs_users ADD COLUMN IF NOT EXISTS nickname TEXT`).catch(() => {});
    await _pool.query(`ALTER TABLE cs_users ADD COLUMN IF NOT EXISTS fleet TEXT`).catch(() => {});
    await _pool.query(`ALTER TABLE cs_users ADD COLUMN IF NOT EXISTS rank TEXT`).catch(() => {});
    // ── Groups tables ──
    await _pool.query(`
      CREATE TABLE IF NOT EXISTS cs_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('preset','custom')),
        created_by TEXT,
        invite_code TEXT UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cs_group_members (
        group_id TEXT NOT NULL REFERENCES cs_groups(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (group_id, employee_id)
      );
      CREATE TABLE IF NOT EXISTS cs_group_invites (
        id SERIAL PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES cs_groups(id) ON DELETE CASCADE,
        target_eid TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(group_id, target_eid)
      );
    `);
    // Seed preset groups (idempotent)
    const presets = [
      { id: 'preset_all', name: 'All' },
      // Flight Crew（6 個）
      { id: 'preset_A321_CAP', name: 'A321 CAP' }, { id: 'preset_A321_SFOFO', name: 'A321 SFO/FO' },
      { id: 'preset_A330_CAP', name: 'A330 CAP' }, { id: 'preset_A330_SFOFO', name: 'A330 SFO/FO' },
      { id: 'preset_A350_CAP', name: 'A350 CAP' }, { id: 'preset_A350_SFOFO', name: 'A350 SFO/FO' },
      // Cabin Crew（3 個）
      { id: 'preset_CC_SPPR', name: 'SP/PR' }, { id: 'preset_CC_SC', name: 'SC' }, { id: 'preset_CC_CCPC', name: 'CC/PC' },
    ];
    for (const g of presets) {
      await _pool.query(
        `INSERT INTO cs_groups (id, name, type) VALUES ($1, $2, 'preset') ON CONFLICT DO NOTHING`,
        [g.id, g.name]
      );
    }
    // Denylist cleanup：只刪明確列出的 legacy preset id，未來新增 preset 不會被誤殺。
    // CASCADE 會連帶清掉這些舊群組的會員與邀請紀錄。冪等：沒有孤兒就 no-op。
    // 之後若有 preset 要 retire，把 id 加進這個陣列即可。
    const legacyPresetIds = [
      // SFO/FO 合併前的孤兒（合併成 preset_{fleet}_SFOFO）
      'preset_A321_SFO', 'preset_A321_FO',
      'preset_A330_SFO', 'preset_A330_FO',
      'preset_A350_SFO', 'preset_A350_FO',
    ];
    try {
      const cleanup = await _pool.query(
        `DELETE FROM cs_groups WHERE type = 'preset' AND id = ANY($1::text[])`,
        [legacyPresetIds]
      );
      if (cleanup.rowCount && cleanup.rowCount > 0) {
        console.log(`🧹 Removed ${cleanup.rowCount} legacy preset group(s)`);
      }
    } catch (e: any) {
      console.warn('Preset cleanup skipped:', e.message);
    }
    // ── Briefings（使用者的航班 briefing snapshot，可查歷史）──
    await _pool.query(`
      CREATE TABLE IF NOT EXISTS crewsync_briefings (
        employee_id TEXT NOT NULL,
        flight_no TEXT NOT NULL,
        flight_date DATE NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (employee_id, flight_no, flight_date)
      );
    `);
    console.log('✅ Database connected & tables ready');
  } catch (e: any) {
    console.error('❌ Database init error:', e.message);
  }
}
_dbInit();

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
  status: 'queued' | 'running' | 'done' | 'error';
  logs: string[];
  result?: SyncResult;
  newRefreshToken?: string;
  employeeId?: string;
  crewName?: string;
  rosterData?: any[];
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

// Morning Report PWA (獨立模組，掛在 /morning 底下)
app.use(morningRouter);

// Pilot Log（獨立子系統，掛在 /api/pilot-log 底下；前端 inline 在 SPA HTML）
app.use(pilotLogRouter);

// Portfolio module（獨立子系統，掛在 /api/portfolio 底下；前端 PWA 在 phase 1.C 加）
app.use(portfolioRouter);

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

// ── App 入口頁（給 LINE 社群置頂用：一頁拿到三個 App + 加到主畫面教學）────────────────
app.get('/apps', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const apps = [
    { icon: '🛬', name: 'CrewSync', href: '/main', cn: '班表同步 · 機場天氣 · 跑道圖 · 即時雷達', en: 'Roster · Weather · Runway maps · Live radar' },
    { icon: '📒', name: 'Pilot Log', href: '/pilot-log', cn: '電子飛行紀錄 · 自動帶班表 · 統計分析', en: 'Electronic logbook · roster import · analytics' },
    { icon: '📰', name: '今日 Today', href: '/morning', cn: '新聞 · 天氣 · 投資速覽', en: 'News · Weather · Portfolio' },
  ];
  const cards = apps.map(a =>
    `<a class="app" href="${a.href}">
       <div class="ico">${a.icon}</div>
       <div class="meta"><div class="nm">${a.name}</div><div class="dz">${a.cn}</div><div class="dz en">${a.en}</div></div>
       <div class="go">開啟 ›</div>
     </a>`).join('');
  res.send(`<!DOCTYPE html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Apps</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:#0a0e1a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans TC",sans-serif; line-height:1.5; }
  .wrap { max-width:560px; margin:0 auto; padding:28px 18px 40px; }
  h1 { font-size:1.5em; margin:8px 0 2px; }
  .sub { color:#94a3b8; font-size:.86em; margin-bottom:22px; }
  .app { display:flex; align-items:center; gap:14px; background:#111827; border:1px solid #1f2a3d; border-radius:14px; padding:16px; margin-bottom:12px; text-decoration:none; color:inherit; transition:border-color .15s,transform .1s; }
  .app:active { transform:scale(.985); }
  .app:hover { border-color:#3b82f6; }
  .ico { font-size:2.1em; width:52px; height:52px; display:flex; align-items:center; justify-content:center; background:#0a0e1a; border-radius:12px; flex-shrink:0; }
  .meta { flex:1; min-width:0; }
  .nm { font-weight:800; font-size:1.08em; }
  .dz { color:#94a3b8; font-size:.78em; }
  .dz.en { color:#64748b; font-size:.72em; }
  .go { color:#3b82f6; font-weight:700; font-size:.85em; flex-shrink:0; }
  .install { margin-top:26px; background:#111827; border:1px solid #1f2a3d; border-radius:14px; padding:16px 18px; }
  .install h2 { font-size:.95em; margin:0 0 10px; color:#e2e8f0; }
  .install p { margin:6px 0; font-size:.84em; color:#cbd5e1; }
  .install b { color:#fff; }
  .tag { display:inline-block; background:#0a0e1a; border:1px solid #1f2a3d; border-radius:6px; padding:1px 7px; font-size:.92em; margin-right:4px; }
  .foot { text-align:center; color:#475569; font-size:.74em; margin-top:24px; }
</style></head><body><div class="wrap">
  <div class="sub" style="margin-top:6px">點開任一 App，再「加到主畫面」就能像獨立 App 一樣使用。<br><span style="color:#64748b">Tap an app, then add it to your Home Screen.</span></div>
  <div style="background:#2a1e08;border:1px solid #92590e;color:#fcd34d;border-radius:12px;padding:11px 14px;font-size:.8em;margin:0 0 18px;line-height:1.55">⚠️ 目前介面針對 <b>iPhone / iPad</b> 最佳化，<b>Android 裝置畫面可能會跑版</b>，建議用 iPhone / iPad 開啟。<br><span style="color:#a8a29e">Optimized for iPhone / iPad — layout may break on Android. Please use an iPhone / iPad.</span></div>
  ${cards}
  <a class="app" href="https://line.me/ti/g2/ArAw4k1D9vXEAMtBsButFLzSFjXzEvFXfKHQ2A?utm_source=invitation" target="_blank" rel="noopener" style="border-color:#16a34a66">
    <div class="ico">💬</div>
    <div class="meta"><div class="nm">加入社群</div><div class="dz">回報 Bug · 提建議 · 可匿名留言</div><div class="dz en">Join the community · report bugs (anonymous OK)</div></div>
    <div class="go" style="color:#22c55e">加入 ›</div>
  </a>
  <div class="install">
    <h2>📲 加到主畫面 · Add to Home Screen</h2>
    <p><span class="tag">iPhone</span><b>Safari</b> 開啟 → 點底部 <b>分享 ⬆️</b> → <b>加入主畫面</b></p>
    <p><span class="tag">Android</span><b>Chrome</b> 開啟 → 右上 <b>⋮</b> → <b>安裝應用程式 / 加到主畫面</b></p>
  </div>
  <div class="foot">oops.h-peak.com</div>
</div></body></html>`);
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
<div class="a">It writes your roster into your Google Calendar and reads existing events to avoid duplicates and display your calendar. We will not modify or share any non-roster data in your calendar. The authorization token is stored only in your browser and is never uploaded to our server.</div>
<div class="a-zh">把你的班表寫進你的 Google 日曆，並讀取現有事件以避免重複建立及顯示行事曆。我們不會修改或分享你日曆裡的任何非班表資料。授權產生的令牌只存在你自己的瀏覽器裡，不會上傳到伺服器。</div>

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
  <li>CrewSync uses your Google Calendar data <strong>solely</strong> to synchronize your flight roster: reading existing calendar events to avoid duplicate entries, and creating/updating calendar events based on your crew roster.<br><span class="zh">CrewSync <strong>僅</strong>將您的 Google 日曆資料用於同步飛行班表：讀取現有事件以避免重複建立，並根據您的組員班表新增或更新日曆事件。</span></li>
  <li>CrewSync does <strong>not</strong> use your data for advertising, analytics, or any purpose other than the roster synchronization feature you initiated.<br><span class="zh">CrewSync <strong>不會</strong>將您的資料用於廣告、分析或班表同步以外的任何用途。</span></li>
</ul>
<p><strong>Google API Services User Data Policy Compliance:</strong> CrewSync's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<p class="zh"><strong>符合 Google API 服務使用者資料政策：</strong>CrewSync 對於從 Google API 收到的資訊的使用和轉移，將遵守 <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Google API 服務使用者資料政策</a>，包括其中的「受限使用」要求。</p>

<h2>3. Data Sharing 資料分享</h2>
<ul>
  <li>CrewSync does <strong>not</strong> sell, share, or transfer your Google user data to any third party.<br><span class="zh">CrewSync <strong>不會</strong>出售、分享或轉移您的 Google 使用者資料給任何第三方。</span></li>
  <li>No Google user data is used for advertising or shared with data brokers.<br><span class="zh">不會將 Google 使用者資料用於廣告或提供給資料仲介。</span></li>
</ul>

<h2>4. Data Storage &amp; Protection 資料儲存與保護</h2>
<ul>
  <li>All user data (roster, settings, OAuth tokens) is stored <strong>locally on your device</strong> using browser localStorage. CrewSync does <strong>not</strong> store any personal data on its servers.<br><span class="zh">所有使用者資料（班表、設定、OAuth token）皆透過瀏覽器 localStorage <strong>儲存在您的裝置上</strong>。CrewSync <strong>不會</strong>在伺服器上儲存任何個人資料。</span></li>
  <li>OAuth tokens are stored only in your browser's localStorage and are never transmitted to or stored on our servers.<br><span class="zh">OAuth token 僅儲存於您瀏覽器的 localStorage，絕不會傳輸至或儲存於我們的伺服器。</span></li>
  <li>Data protection measures: all communication uses HTTPS encryption; OAuth 2.0 with PKCE (S256) is used for secure authorization; the server acts only as a proxy and does not retain any user data.<br><span class="zh">資料保護措施：所有通訊使用 HTTPS 加密；OAuth 2.0 搭配 PKCE (S256) 進行安全授權；伺服器僅作為代理，不保留任何使用者資料。</span></li>
</ul>

<h2>5. Data Retention &amp; Deletion 資料保留與刪除</h2>
<ul>
  <li>Since all data is stored locally in your browser, you have full control over data retention. Data is retained only as long as it remains in your browser's localStorage.<br><span class="zh">由於所有資料皆儲存在您的瀏覽器本機，您對資料保留擁有完全控制權。資料僅在您瀏覽器的 localStorage 中保留。</span></li>
  <li>To delete all CrewSync data: clear your browser's localStorage for the CrewSync site, or use the app's built-in "Reset" functions.<br><span class="zh">刪除所有 CrewSync 資料：清除瀏覽器中 CrewSync 網站的 localStorage，或使用 app 內建的「重設」功能。</span></li>
  <li>To revoke Google Calendar access: visit your <a href="https://myaccount.google.com/permissions" target="_blank">Google Account permissions</a> and remove CrewSync. This immediately revokes all access to your Google Calendar data.<br><span class="zh">撤銷 Google 日曆存取權：前往 <a href="https://myaccount.google.com/permissions" target="_blank">Google 帳戶權限設定</a> 移除 CrewSync，即可立即撤銷所有 Google 日曆資料的存取權。</span></li>
</ul>

<h2>Third-Party Services 第三方服務</h2>
<table style="width:100%;border-collapse:collapse;font-size:.95em;margin-bottom:12px">
<tr style="border-bottom:2px solid #555"><th style="text-align:left;padding:8px">服務 Service</th><th style="text-align:left;padding:8px">用途 Purpose</th></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>Google Calendar API</strong></td><td style="padding:8px">班表同步（需使用者授權）<br>Roster synchronization (user-authorized)</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>Aviation Weather APIs</strong></td><td style="padding:8px">METAR/TAF 航空氣象<br>Aviation weather data</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>atis.guru</strong></td><td style="padding:8px">D-ATIS 資料<br>D-ATIS data</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>CodeTabs CORS Proxy</strong></td><td style="padding:8px">前端跨域代理<br>Frontend cross-origin proxy</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>OpenSky Network API</strong></td><td style="padding:8px">Live Radar 即時航機位置<br>Live aircraft positions</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>FlightRadar24 (unofficial)</strong></td><td style="padding:8px">FR24 航班追蹤<br>Flight tracking data</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>FlightAware (unofficial)</strong></td><td style="padding:8px">FR24 航班起訖地補充<br>Flight origin/destination supplement</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>Taoyuan Airport FIDS API</strong></td><td style="padding:8px">Gate Info 航班資訊顯示<br>Flight information display</td></tr>
</table>
<p>Google Calendar API accesses calendar data with user authorization (see "Data Usage" above). No personal data is sent in any other third-party requests.<br><span class="zh">Google Calendar API 經使用者授權後存取日曆資料，詳見上方「資料使用方式」。其餘第三方服務請求均不包含任何個人資料。</span></p>

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
  <defs>
    <linearGradient id="cs-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0F1B3C"/>
      <stop offset="60%" stop-color="#1E2F5C"/>
      <stop offset="100%" stop-color="#3A5488"/>
    </linearGradient>
  </defs>
  <rect width="192" height="192" fill="url(#cs-bg)"/>
  <circle cx="25" cy="30" r="1" fill="#fff" opacity="0.8"/>
  <circle cx="160" cy="25" r="1.2" fill="#fff" opacity="0.9"/>
  <circle cx="170" cy="60" r="0.8" fill="#fff" opacity="0.6"/>
  <circle cx="30" cy="75" r="0.8" fill="#fff" opacity="0.7"/>
  <circle cx="155" cy="90" r="1" fill="#fff" opacity="0.8"/>
  <circle cx="15" cy="110" r="0.8" fill="#fff" opacity="0.5"/>
  <circle cx="60" cy="45" r="0.8" fill="#fff" opacity="0.6"/>
  <circle cx="130" cy="50" r="0.8" fill="#fff" opacity="0.7"/>
  <ellipse cx="40" cy="165" rx="38" ry="8" fill="#6E8EC0" opacity="0.6"/>
  <ellipse cx="100" cy="172" rx="50" ry="10" fill="#8AA6D0" opacity="0.7"/>
  <ellipse cx="155" cy="168" rx="35" ry="8" fill="#6E8EC0" opacity="0.6"/>
  <ellipse cx="70" cy="178" rx="30" ry="6" fill="#5A7BA8" opacity="0.5"/>
  <text x="96" y="135" text-anchor="middle" font-size="105"
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
      scope: ['https://www.googleapis.com/auth/calendar', 'openid', 'email', 'profile'],
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

// ── Briefing Room 平面圖 ──────────────────────────────────────────────────────
app.get('/briefing-room', (_req, res) => {
  const p = path.resolve(process.cwd(), 'src', 'spa', 'briefing-room.jpg');
  res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 天快取
  res.sendFile(p, (err) => {
    if (err) res.status(404).send('briefing room image not found');
  });
});

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

app.get('/api/taf', async (req, res) => {
  try {
    const { ids } = req.query;
    const url = `https://aviationweather.gov/api/data/taf?ids=${ids}&format=raw`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (e: any) {
    res.status(502).send('');
  }
});

// ── Service Worker ────────────────────────────────────────────────────────────
// V8.0.29 fix: cache name 從 html-body.js 動態抓當前 V8.0.X，每次推版自動 invalidate 舊 cache
// 原本寫死 'crewsync-v8026' → 每次 deploy 同 cache name → SW activate handler
// `delete keys !== CACHE` 不會清自己 → PWA 永遠看 cached shell V8.0.26 不更新
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  const verMatch = getSpaHtmlBody().match(/V\d+\.\d+\.\d+/);
  const cacheVer = verMatch ? verMatch[0].replace('V', 'v').replace(/\./g, '') : 'vunknown';
  res.send(`
const CACHE = 'crewsync-${cacheVer}';
const SHELL = ['/', '/main', '/share'];
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(SHELL.map(url =>
      fetch(url, {cache:'no-store'}).then(r => c.put(url, r))
    )))
  );
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE && k!=='plapt-maps').map(k=>caches.delete(k)))));
  self.clients.claim();
});
const _offlinePage = '<html><body style="background:#111;color:#aaa;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Offline</h2><p>Please connect to the internet and reload.</p></div></body></html>';
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/')) return;
  // 衛星圖（Esri）→ 永久快取 plapt-maps（cache-first）：跟 Pilot Log 用同一個 cache + 同網址，
  // 直接命中已預抓的 37 星宇機場底圖；CrewSync 看過的其他機場也順手存起來，下次/離線秒出。activate 不清這個 cache。
  if (u.hostname === 'server.arcgisonline.com') {
    e.respondWith(caches.open('plapt-maps').then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; }))));
    return;
  }
  e.respondWith(
    fetch(e.request).then(r => {
      caches.open(CACHE).then(c => c.put(e.request, r.clone()));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || new Response(_offlinePage, {headers:{'Content-Type':'text/html'}})))
  );
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
    // Save user email to database (decode id_token, no extra scope needed)
    if (_pool && tokens.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString());
        const email = payload.email || '';
        const name = payload.name || '';
        const picture = payload.picture || '';
        if (email) {
          await _pool.query(
            `INSERT INTO cs_users (email, name, picture) VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET name = $2, picture = $3, updated_at = NOW()`,
            [email, name, picture]
          );
          console.log(`[DB] User saved: ${email}`);
        }
      } catch (dbErr: any) {
        console.error('[DB] Save user error:', dbErr.message);
      }
    }
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

// ── Database admin endpoints ──────────────────────────────────────────────────
// V8.0.45：拿掉「密碼寫在網址」(?pw=) 的舊機制，改成 owner Google 登入後才看得到
// （比照 /tower：Bearer token + isOwnerUserId）。一般用戶/外洩網址都拿不到。
// 註：完整三 App 用戶總覽已整合進 /tower，這支端點保留作為 CrewSync 單獨查詢。
app.get('/api/users', requireAuth, async (req: AuthedRequest, res) => {
  if (!(await isOwnerUserId(req.pilotUserId || ''))) return res.status(403).json({ error: 'not_owner' });
  if (!_pool) return res.json({ error: 'No database' });
  try {
    const r = await _pool.query('SELECT email, name, rank, sharing, created_at, updated_at FROM cs_users ORDER BY created_at DESC');
    res.json({ count: r.rows.length, users: r.rows });
  } catch (e: any) {
    res.json({ error: e.message });
  }
});

// ── Roster data API ──────────────────────────────────────────────────────────
app.get('/api/roster-data', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, month } = req.query;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    const q = month
      ? await _pool.query('SELECT month, roster_data, updated_at FROM cs_rosters WHERE employee_id = $1 AND month = $2', [eid, month])
      : await _pool.query('SELECT month, roster_data, updated_at FROM cs_rosters WHERE employee_id = $1 ORDER BY month DESC LIMIT 3', [eid]);
    // Get crew pictures from cs_users (match by employee_id)
    const picQ = await _pool.query('SELECT employee_id, picture, name FROM cs_users WHERE employee_id IS NOT NULL AND picture IS NOT NULL');
    const picMap: Record<string, { picture: string; name: string }> = {};
    for (const r of picQ.rows) picMap[r.employee_id] = { picture: r.picture, name: r.name };
    res.json({ rosters: q.rows, pictures: picMap });
  } catch (e: any) {
    res.json({ error: e.message });
  }
});

// ── Friends sharing API ──────────────────────────────────────────────────────
// 上傳分享班表
app.post('/api/roster-share', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, month, duties, crewName, nickname, fleet, rank, updateInfoOnly } = req.body;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    // Add fleet/rank columns if needed
    await _pool.query(`ALTER TABLE cs_users ADD COLUMN IF NOT EXISTS fleet TEXT`).catch(() => {});
    await _pool.query(`ALTER TABLE cs_users ADD COLUMN IF NOT EXISTS rank TEXT`).catch(() => {});

    if (updateInfoOnly) {
      // 只更新機隊/職級/名稱，不上傳班表
      await _pool.query(
        `UPDATE cs_users SET fleet = COALESCE($2, fleet), rank = COALESCE($3, rank),
         nickname = CASE WHEN $4 = '' THEN nickname ELSE COALESCE(NULLIF($4, ''), nickname) END,
         updated_at = NOW() WHERE employee_id = $1`,
        [eid, fleet || null, rank || null, nickname || '']
      );
      return res.json({ ok: true });
    }

    if (!month || !duties) return res.status(400).json({ error: 'Missing month or duties' });
    // 剔除 crew 名單（隱私保護），只保留航班資訊
    const cleanDuties = (Array.isArray(duties) ? duties : []).map((d: any) => ({
      duty: d.duty, reportTime: d.reportTime, endTime: d.endTime,
      flights: (d.flights || []).map((f: any) => ({
        flightNo: f.flightNo, origin: f.origin, dest: f.dest,
        depTime: f.depTime, arrTime: f.arrTime, date: f.date
      }))
    }));
    await _pool.query(
      `INSERT INTO cs_rosters (employee_id, month, roster_data, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (employee_id, month) DO UPDATE SET roster_data = $3, updated_at = NOW()`,
      [eid, month, JSON.stringify(cleanDuties)]
    );
    // 更新已連結的 cs_users（同步時已用 Google email 精確連結 employee_id）
    const upd = await _pool.query(
      `UPDATE cs_users SET sharing = true,
       fleet = COALESCE($2, fleet), rank = COALESCE($3, rank),
       nickname = CASE WHEN $4 = '' THEN NULL ELSE COALESCE(NULLIF($4, ''), nickname) END,
       updated_at = NOW()
       WHERE employee_id = $1`,
      [eid, fleet || null, rank || null, nickname || '']
    );
    if (upd.rowCount === 0) {
      // 找不到已連結的記錄 → 使用者可能還沒重新同步過，無法確認身份
      return res.json({ error: '請先重新同步班表，讓系統連結你的 Google 帳號 Please re-sync your roster first' });
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.json({ error: e.message });
  }
});

// 撤銷分享
app.delete('/api/roster-share', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid } = req.body;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    await _pool.query('DELETE FROM cs_rosters WHERE employee_id = $1', [eid]);
    await _pool.query('UPDATE cs_users SET sharing = false WHERE employee_id = $1', [eid]);
    res.json({ ok: true });
  } catch (e: any) {
    res.json({ error: e.message });
  }
});

// 拉班表（支援群組篩選）
app.get('/api/roster-friends', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { month, eid, group } = req.query;
  if (!month) return res.status(400).json({ error: 'Missing month' });
  try {
    let q;
    if (group && group !== 'all' && eid) {
      // 篩選特定群組的成員班表
      q = await _pool.query(
        `SELECT DISTINCT r.employee_id, r.roster_data FROM cs_rosters r
         INNER JOIN cs_users u ON r.employee_id = u.employee_id
         INNER JOIN cs_group_members gm ON r.employee_id = gm.employee_id
         WHERE u.sharing = true AND r.month = $1 AND gm.group_id = $2`,
        [month, group]
      );
    } else if (eid && group !== 'all') {
      // 預設：只顯示跟我同群組的人
      q = await _pool.query(
        `SELECT DISTINCT r.employee_id, r.roster_data FROM cs_rosters r
         INNER JOIN cs_users u ON r.employee_id = u.employee_id
         INNER JOIN cs_group_members gm ON r.employee_id = gm.employee_id
         WHERE u.sharing = true AND r.month = $1
           AND gm.group_id IN (SELECT group_id FROM cs_group_members WHERE employee_id = $2)`,
        [month, eid]
      );
    } else {
      // All：所有分享的人（原始行為）
      q = await _pool.query(
        `SELECT DISTINCT r.employee_id, r.roster_data FROM cs_rosters r
         INNER JOIN cs_users u ON r.employee_id = u.employee_id
         WHERE u.sharing = true AND r.month = $1`,
        [month]
      );
    }
    // Get user info (name, picture, nickname)
    // 拿所有有 employee_id 的記錄（不只 sharing=true），合併 picture
    const uq = await _pool.query(
      `SELECT employee_id, name, picture, nickname, fleet, rank, sharing FROM cs_users WHERE employee_id IS NOT NULL ORDER BY picture IS NOT NULL DESC, updated_at DESC`
    );
    const userMap: Record<string, { name: string; picture: string; nickname: string; fleet: string; rank: string }> = {};
    for (const u of uq.rows) {
      if (!userMap[u.employee_id]) {
        userMap[u.employee_id] = { name: u.name || '', picture: u.picture || '', nickname: u.nickname || '', fleet: u.fleet || '', rank: u.rank || '' };
      } else {
        // 合併：優先有 picture 的記錄
        if (u.picture && !userMap[u.employee_id].picture) userMap[u.employee_id].picture = u.picture;
        if (u.nickname && !userMap[u.employee_id].nickname) userMap[u.employee_id].nickname = u.nickname;
        if (u.fleet && !userMap[u.employee_id].fleet) userMap[u.employee_id].fleet = u.fleet;
        if (u.rank && !userMap[u.employee_id].rank) userMap[u.employee_id].rank = u.rank;
      }
    }

    const friends = q.rows.map(r => ({
      eid: r.employee_id,
      name: userMap[r.employee_id]?.name || r.employee_id,
      picture: userMap[r.employee_id]?.picture || '',
      nickname: userMap[r.employee_id]?.nickname || '',
      fleet: userMap[r.employee_id]?.fleet || '',
      rank: userMap[r.employee_id]?.rank || '',
      duties: r.roster_data
    }));
    res.json({ friends });
  } catch (e: any) {
    res.json({ error: e.message });
  }
});

// ── Groups API ───────────────────────────────────────────────────────────────

// 取得所有群組 + 加入狀態 + 待處理邀請數
app.get('/api/groups', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const eid = req.query.eid as string;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    // 所有預設群組
    const presetQ = await _pool.query(`SELECT id, name FROM cs_groups WHERE type = 'preset' ORDER BY id`);
    // 使用者加入的群組 ID
    const memberQ = await _pool.query(`SELECT group_id FROM cs_group_members WHERE employee_id = $1`, [eid]);
    const joinedSet = new Set(memberQ.rows.map((r: any) => r.group_id));
    // 使用者的自訂群組（已加入的）
    const customQ = await _pool.query(
      `SELECT g.id, g.name, g.invite_code, g.created_by,
        (SELECT COUNT(*) FROM cs_group_members m WHERE m.group_id = g.id) AS member_count
       FROM cs_groups g INNER JOIN cs_group_members m ON g.id = m.group_id
       WHERE g.type = 'custom' AND m.employee_id = $1
       ORDER BY g.created_at DESC`, [eid]
    );
    // 待處理邀請數
    const invQ = await _pool.query(
      `SELECT COUNT(*) AS cnt FROM cs_group_invites WHERE target_eid = $1 AND status = 'pending'`, [eid]
    );
    res.json({
      presets: presetQ.rows.map((g: any) => ({ id: g.id, name: g.name, joined: joinedSet.has(g.id) })),
      custom: customQ.rows.map((g: any) => ({ id: g.id, name: g.name, inviteCode: g.invite_code, createdBy: g.created_by, memberCount: +g.member_count })),
      pendingInvites: +invQ.rows[0].cnt
    });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 建立自訂群組
app.post('/api/groups', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, name } = req.body;
  if (!eid || !name) return res.status(400).json({ error: 'Missing eid or name' });
  try {
    // 產生 4 碼邀請碼（重試避免碰撞）
    let code = '';
    for (let i = 0; i < 10; i++) {
      code = randomBytes(2).toString('hex').toUpperCase().slice(0, 4);
      const dup = await _pool.query(`SELECT 1 FROM cs_groups WHERE invite_code = $1`, [code]);
      if (dup.rowCount === 0) break;
    }
    const id = 'custom_' + code;
    await _pool.query(
      `INSERT INTO cs_groups (id, name, type, created_by, invite_code) VALUES ($1, $2, 'custom', $3, $4)`,
      [id, name.trim(), eid, code]
    );
    // 建立者自動加入
    await _pool.query(`INSERT INTO cs_group_members (group_id, employee_id) VALUES ($1, $2)`, [id, eid]);
    res.json({ ok: true, group: { id, name: name.trim(), inviteCode: code, createdBy: eid, memberCount: 1 } });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 刪除自訂群組（僅建立者）
app.delete('/api/groups/:id', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid } = req.body;
  const gid = req.params.id;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    const g = await _pool.query(`SELECT created_by FROM cs_groups WHERE id = $1 AND type = 'custom'`, [gid]);
    if (g.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    if (g.rows[0].created_by !== eid) return res.status(403).json({ error: 'Only creator can delete' });
    await _pool.query(`DELETE FROM cs_groups WHERE id = $1`, [gid]); // CASCADE deletes members + invites
    res.json({ ok: true });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 加入預設群組
app.post('/api/groups/join', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, groupId } = req.body;
  if (!eid || !groupId) return res.status(400).json({ error: 'Missing eid or groupId' });
  try {
    await _pool.query(
      `INSERT INTO cs_group_members (group_id, employee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [groupId, eid]
    );
    res.json({ ok: true });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 用邀請碼加入自訂群組
app.post('/api/groups/join-code', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, inviteCode } = req.body;
  if (!eid || !inviteCode) return res.status(400).json({ error: 'Missing eid or inviteCode' });
  try {
    const g = await _pool.query(`SELECT id, name FROM cs_groups WHERE invite_code = $1`, [inviteCode.toUpperCase().trim()]);
    if (g.rowCount === 0) return res.status(404).json({ error: '找不到此邀請碼 Invite code not found' });
    await _pool.query(
      `INSERT INTO cs_group_members (group_id, employee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [g.rows[0].id, eid]
    );
    // 自動開啟分享
    await _pool.query(`UPDATE cs_users SET sharing = true, updated_at = NOW() WHERE employee_id = $1 AND sharing = false`, [eid]);
    res.json({ ok: true, group: { id: g.rows[0].id, name: g.rows[0].name } });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 退出群組
app.post('/api/groups/leave', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, groupId } = req.body;
  if (!eid || !groupId) return res.status(400).json({ error: 'Missing eid or groupId' });
  try {
    await _pool.query(`DELETE FROM cs_group_members WHERE group_id = $1 AND employee_id = $2`, [groupId, eid]);
    // 自動刪除 0 人的自訂群組
    if (groupId.startsWith('custom_')) {
      const cnt = await _pool.query(`SELECT COUNT(*) AS c FROM cs_group_members WHERE group_id = $1`, [groupId]);
      if (+cnt.rows[0].c === 0) {
        await _pool.query(`DELETE FROM cs_groups WHERE id = $1`, [groupId]);
      }
    }
    // 退出後如果不在任何群組了 → 關閉 sharing + 刪除班表資料
    const remaining = await _pool.query(`SELECT COUNT(*) AS c FROM cs_group_members WHERE employee_id = $1`, [eid]);
    if (+remaining.rows[0].c === 0) {
      await _pool.query(`UPDATE cs_users SET sharing = false WHERE employee_id = $1`, [eid]);
      await _pool.query(`DELETE FROM cs_rosters WHERE employee_id = $1`, [eid]);
    }
    res.json({ ok: true });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 邀請人（輸入員工編號）
app.post('/api/groups/invite', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, groupId, targetEid } = req.body;
  if (!eid || !groupId || !targetEid) return res.status(400).json({ error: 'Missing fields' });
  try {
    // 確認邀請者是成員
    const mem = await _pool.query(`SELECT 1 FROM cs_group_members WHERE group_id = $1 AND employee_id = $2`, [groupId, eid]);
    if (mem.rowCount === 0) return res.status(403).json({ error: '你不是此群組成員 Not a member' });
    // 確認目標存在
    const usr = await _pool.query(`SELECT 1 FROM cs_users WHERE employee_id = $1`, [targetEid]);
    if (usr.rowCount === 0) return res.status(404).json({ error: '找不到此員工編號 Employee not found' });
    // 確認目標尚未加入
    const already = await _pool.query(`SELECT 1 FROM cs_group_members WHERE group_id = $1 AND employee_id = $2`, [groupId, targetEid]);
    if (already.rowCount! > 0) return res.json({ ok: true, note: '已經是成員 Already a member' });
    // 建立邀請
    await _pool.query(
      `INSERT INTO cs_group_invites (group_id, target_eid, invited_by) VALUES ($1, $2, $3)
       ON CONFLICT (group_id, target_eid) DO UPDATE SET status = 'pending', invited_by = $3, created_at = NOW()`,
      [groupId, targetEid, eid]
    );
    res.json({ ok: true });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 取得待處理邀請
app.get('/api/groups/invites', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const eid = req.query.eid as string;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    const q = await _pool.query(
      `SELECT i.id, i.group_id, g.name AS group_name, i.invited_by,
        COALESCE(u.nickname, u.name, i.invited_by) AS inviter_name
       FROM cs_group_invites i
       INNER JOIN cs_groups g ON i.group_id = g.id
       LEFT JOIN cs_users u ON i.invited_by = u.employee_id
       WHERE i.target_eid = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC`, [eid]
    );
    res.json({ invites: q.rows });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 接受邀請
app.post('/api/groups/invites/:id/accept', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid } = req.body;
  const invId = req.params.id;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    const inv = await _pool.query(`SELECT group_id, target_eid FROM cs_group_invites WHERE id = $1 AND status = 'pending'`, [invId]);
    if (inv.rowCount === 0) return res.status(404).json({ error: 'Invite not found' });
    if (inv.rows[0].target_eid !== eid) return res.status(403).json({ error: 'Not your invite' });
    await _pool.query(`UPDATE cs_group_invites SET status = 'accepted' WHERE id = $1`, [invId]);
    await _pool.query(
      `INSERT INTO cs_group_members (group_id, employee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [inv.rows[0].group_id, eid]
    );
    // 自動開啟分享
    await _pool.query(`UPDATE cs_users SET sharing = true, updated_at = NOW() WHERE employee_id = $1 AND sharing = false`, [eid]);
    res.json({ ok: true });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 拒絕邀請
app.post('/api/groups/invites/:id/decline', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid } = req.body;
  const invId = req.params.id;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    const inv = await _pool.query(`SELECT target_eid FROM cs_group_invites WHERE id = $1 AND status = 'pending'`, [invId]);
    if (inv.rowCount === 0) return res.status(404).json({ error: 'Invite not found' });
    if (inv.rows[0].target_eid !== eid) return res.status(403).json({ error: 'Not your invite' });
    await _pool.query(`UPDATE cs_group_invites SET status = 'declined' WHERE id = $1`, [invId]);
    res.json({ ok: true });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 取得群組成員
app.get('/api/groups/:id/members', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const gid = req.params.id;
  try {
    const q = await _pool.query(
      `SELECT m.employee_id, COALESCE(u.nickname, u.name, m.employee_id) AS name, u.fleet, u.rank
       FROM cs_group_members m
       LEFT JOIN cs_users u ON m.employee_id = u.employee_id
       WHERE m.group_id = $1
       ORDER BY m.joined_at`, [gid]
    );
    res.json({ members: q.rows });
  } catch (e: any) { res.json({ error: e.message }); }
});

// ── End Groups API ───────────────────────────────────────────────────────────

app.get('/api/db-test', async (_req, res) => {
  if (!_pool) return res.json({ ok: false, error: 'No DATABASE_URL' });
  try {
    const r = await _pool.query('SELECT NOW() as time, current_database() as db');
    res.json({ ok: true, time: r.rows[0].time, db: r.rows[0].db });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
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

// ── Sync queue（同時只允許一個 Puppeteer）────────────────────────────────────
interface QueueEntry {
  jobId: string;
  params: { year: number; month: number; jxUsername: string; jxPassword: string; refreshToken: string; calendarId: string };
}
const _syncQueue: QueueEntry[] = [];
let _syncRunning = false;

function _syncNext() {
  if (_syncRunning || _syncQueue.length === 0) return;
  _syncRunning = true;
  const entry = _syncQueue.shift()!;
  const { jobId, params } = entry;
  const { year, month, jxUsername, jxPassword, refreshToken, calendarId } = params;

  const icsPath = path.join(OUTPUT_DIR, `roster-${jobId}.ics`);
  const job = jobs.get(jobId);
  if (!job) { _syncRunning = false; _syncNext(); return; }
  job.status = 'running';
  job.icsPath = icsPath;

  const onLog = (msg: string) => { job.logs.push(msg); };

  (async () => {
    try {
      const rosterResult = await generateICSHeadless(Number(year), Number(month), { username: jxUsername, password: jxPassword }, icsPath, onLog, jobId);
      const { result, newRefreshToken } = await syncICS({ refreshToken, calendarId, icsPath, onLog });
      job.result = result;
      if (newRefreshToken) job.newRefreshToken = newRefreshToken;
      // Partial vs full：有 duty 又標 partial 的話，狀態改為 'partial'
      if (rosterResult.partial) {
        job.status = 'partial';
        (job as any).partialReason = rosterResult.errorSummary;
        (job as any).debugFiles = rosterResult.debugFiles || [];
        onLog(`⚠️ 部分成功（${rosterResult.duties.length} 筆）：${rosterResult.errorSummary || 'unknown'}`);
      } else {
        job.status = 'done';
      }

      // Save employee ID + roster data to job for frontend
      const eid = rosterResult.employeeId || jxUsername;
      job.employeeId = eid;
      job.crewName = rosterResult.crewName || '';
      job.rosterData = rosterResult.duties;
      if (_pool && eid) {
        try {
          const monthKey = `${year}-${String(month).padStart(2, '0')}`;
          // 用 refresh token 查 Google email，精確連結 employee_id
          try {
            const creds = loadCredentials();
            const oauth2 = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret);
            oauth2.setCredentials({ refresh_token: refreshToken });
            const tokenInfo = await oauth2.getTokenInfo(
              (await oauth2.getAccessToken()).token!
            );
            const googleEmail = tokenInfo.email;
            if (googleEmail) {
              const crewNameVal = rosterResult.crewName || null;
              await _pool.query(
                `UPDATE cs_users SET employee_id = $1, name = COALESCE($3, name), updated_at = NOW() WHERE email = $2`,
                [eid, googleEmail, crewNameVal]
              );
              onLog(`🔗 已連結 Google 帳號: ${googleEmail}` + (crewNameVal ? ` (${crewNameVal})` : ''));
            }
          } catch (linkErr: any) {
            onLog(`⚠️ Google 帳號連結失敗: ${linkErr.message}`);
          }
          // 如果使用者有開啟分享，自動上傳 DB
          const sharingQ = await _pool.query('SELECT sharing FROM cs_users WHERE employee_id = $1', [eid]);
          if (sharingQ.rows.length > 0 && sharingQ.rows[0].sharing) {
            const monthKey2 = `${year}-${String(month).padStart(2, '0')}`;
            await _pool.query(
              `INSERT INTO cs_rosters (employee_id, month, roster_data, updated_at) VALUES ($1, $2, $3, NOW())
               ON CONFLICT (employee_id, month) DO UPDATE SET roster_data = $3, updated_at = NOW()`,
              [eid, monthKey2, JSON.stringify((rosterResult.duties || []).map((d: any) => ({
                duty: d.duty, reportTime: d.reportTime, endTime: d.endTime,
                flights: (d.flights || []).map((f: any) => ({
                  flightNo: f.flightNo, origin: f.origin, dest: f.dest,
                  depTime: f.depTime, arrTime: f.arrTime, date: f.date
                }))
              })))]
            );
            onLog('📤 班表已自動分享至 Friends');
          }
          // V8.0.41：無條件把「完整班表（含組員）」存一份到私有表 cs_rosters_full。
          // 跟分享無關（不看 sharing 旗標、不剃組員、不會出現在 Friends/群組）；
          // 純給本人在 Pilot Log app 按 Import Roster 時直接撈 —— 解 iOS 兩個獨立 PWA 不共用 localStorage。
          await _pool.query(
            `INSERT INTO cs_rosters_full (employee_id, month, roster_data, updated_at) VALUES ($1, $2, $3, NOW())
             ON CONFLICT (employee_id, month) DO UPDATE SET roster_data = $3, updated_at = NOW()`,
            [eid, monthKey, JSON.stringify(rosterResult.duties || [])]
          );
        } catch (dbErr: any) {
          onLog(`⚠️ 資料庫儲存失敗: ${dbErr.message}`);
        }
      }
    } catch (err: any) {
      job.error = err.message;
      job.status = 'error';
      onLog(`❌ 錯誤：${err.message}`);
    } finally {
      try { if (fs.existsSync(icsPath)) fs.unlinkSync(icsPath); } catch {}
      _syncRunning = false;
      _syncNext();
    }
  })();
}

app.post('/sync', async (req, res) => {
  const { year, month, jxUsername, jxPassword, refreshToken, calendarId } = req.body;
  if (!year || !month || !jxUsername || !jxPassword || !refreshToken || !calendarId) {
    res.status(400).json({ error: '缺少必要參數' });
    return;
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const jobId = randomUUID();
  const job: SyncJob = { status: 'queued' as any, logs: [], startedAt: new Date(), icsPath: '' };
  jobs.set(jobId, job);

  const queuePos = _syncQueue.length + (_syncRunning ? 1 : 0);
  _syncQueue.push({ jobId, params: { year: Number(year), month: Number(month), jxUsername, jxPassword, refreshToken, calendarId } });
  job.logs.push(queuePos > 0 ? `⏳ 排隊中，前面有 ${queuePos} 人（預估等待 ${queuePos * 60} 秒）` : '🚀 開始同步...');
  _syncNext();

  res.json({ jobId, queue: queuePos });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: '找不到此工作' }); return; }
  // 計算排隊位置
  const queuePos = _syncQueue.findIndex(e => e.jobId === req.params.jobId);
  const ahead = queuePos >= 0 ? queuePos + (_syncRunning ? 1 : 0) : 0;
  res.json({
    status: job.status, logs: job.logs, result: job.result, newRefreshToken: job.newRefreshToken,
    employeeId: job.employeeId, crewName: job.crewName, rosterData: job.rosterData,
    error: job.error, queue: ahead,
    partialReason: (job as any).partialReason,
    debugFiles: (job as any).debugFiles,
  });
});

// ── Sync debug screenshots download (eid 比對) ─────────────────────────
app.get('/api/sync-debug/:syncId/:file', (req, res) => {
  const { syncId, file } = req.params;
  const qEid = String(req.query.eid || '');
  const job = jobs.get(syncId);
  if (!job) return res.status(404).send('job not found');
  if (!qEid || job.employeeId !== qEid) return res.status(403).send('forbidden');
  // 防 path traversal
  if (!/^[\w.\-]+\.png$/.test(file)) return res.status(400).send('invalid file');
  const full = path.join('/tmp', 'sync-debug', syncId, file);
  res.sendFile(full, (err) => { if (err) res.status(404).send('not found'); });
});

// 啟動時清理 /tmp/sync-debug 超過 24h 的 session 目錄
(function cleanupSyncDebug() {
  try {
    const root = path.join('/tmp', 'sync-debug');
    if (!require('fs').existsSync(root)) return;
    const dirs = require('fs').readdirSync(root);
    const now = Date.now();
    const CUTOFF = 24 * 3600 * 1000;
    for (const d of dirs) {
      const p = path.join(root, d);
      try {
        const st = require('fs').statSync(p);
        if (now - st.mtimeMs > CUTOFF) {
          require('fs').rmSync(p, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
})();

// ── Briefings CRUD ────────────────────────────────────────────────────────
// POST /api/briefing — upsert（eid + flight_no + flight_date）
app.post('/api/briefing', async (req, res) => {
  if (!_pool) return res.status(503).json({ error: 'No database' });
  const { eid, flight_no, flight_date, data } = req.body || {};
  if (!eid || !flight_no || !flight_date) return res.status(400).json({ error: 'Missing eid/flight_no/flight_date' });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Missing data' });
  try {
    await _pool.query(
      `INSERT INTO crewsync_briefings (employee_id, flight_no, flight_date, data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (employee_id, flight_no, flight_date)
       DO UPDATE SET data = $4, updated_at = NOW()`,
      [String(eid), String(flight_no).toUpperCase(), String(flight_date), JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/briefing?eid=&flight_no=&flight_date= — 取回單筆
app.get('/api/briefing', async (req, res) => {
  if (!_pool) return res.status(503).json({ error: 'No database' });
  const { eid, flight_no, flight_date } = req.query;
  if (!eid || !flight_no || !flight_date) return res.status(400).json({ error: 'Missing eid/flight_no/flight_date' });
  try {
    const q = await _pool.query(
      'SELECT data, updated_at FROM crewsync_briefings WHERE employee_id = $1 AND flight_no = $2 AND flight_date = $3',
      [String(eid), String(flight_no).toUpperCase(), String(flight_date)]
    );
    if (q.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, data: q.rows[0].data, updated_at: q.rows[0].updated_at });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/briefing/list?eid=&limit=50 — 使用者的 briefing 歷史列表
app.get('/api/briefing/list', async (req, res) => {
  if (!_pool) return res.status(503).json({ error: 'No database' });
  const { eid } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  try {
    const q = await _pool.query(
      `SELECT flight_no, flight_date::text, updated_at,
              data->>'brief-origin' AS orig,
              data->>'brief-dest' AS dest
       FROM crewsync_briefings
       WHERE employee_id = $1 ORDER BY flight_date DESC, flight_no ASC LIMIT $2`,
      [String(eid), limit]
    );
    res.json({ ok: true, items: q.rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/briefing — 刪除單筆（eid + flight_no + flight_date）
app.delete('/api/briefing', async (req, res) => {
  if (!_pool) return res.status(503).json({ error: 'No database' });
  const { eid, flight_no, flight_date } = req.body || {};
  if (!eid || !flight_no || !flight_date) return res.status(400).json({ error: 'Missing eid/flight_no/flight_date' });
  try {
    const q = await _pool.query(
      'DELETE FROM crewsync_briefings WHERE employee_id = $1 AND flight_no = $2 AND flight_date = $3 RETURNING flight_no',
      [String(eid), String(flight_no).toUpperCase(), String(flight_date)]
    );
    res.json({ ok: true, deleted: q.rows.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 CrewSync 伺服器啟動：${BASE_URL}`);
  // 啟動晨報 cron（每分鐘檢查是否到 06:30 台北時間）
  startMorningCron();
  // Portfolio module：建表 + 一次性 holdings → transactions migration（idempotent）
  startPortfolio().catch(e => console.error('[portfolio] startPortfolio failed:', e));
  // Pilot Log：DB 用量快照排程（伺服器每天自動記一筆，不靠任何人開後台）
  startPilotLogSnapshotCron();
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
${getSpaOvertimeJs()}
${getSpaSubtabReorderJs()}
${getAirportDbJs()}
${getSpaRunwayMapJs()}
${getSpaRosterGridJs()}
${getSpaFriendsJs()}
${getSpaGroupsJs()}
</script>${viewScript}
</body>
</html>`;
}
