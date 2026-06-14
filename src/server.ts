import express from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { Agent as UndiciAgent } from 'undici';
import { io as _ioClient } from 'socket.io-client';   // ATIS 即時 feed（airframes 全量 socket.io firehose）
import { fetchNopNetworkEvents } from './atfm-nop.js';
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
import { getSpaAtfmJs } from './spa/js-atfm.js';
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
import { pilotLogRouter, PILOT_LOG_VERSION } from './pilot-log/routes.js';
import { APP_VERSION } from './version.js';
import { requireAuth, AuthedRequest, verifyAccessToken, signEmailToken, verifyEmailToken } from './pilot-log/auth.js';
import { isOwnerUserId, getFounderLevel, getFounderLevelByEmail } from './pilot-log/beta.js';
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
      -- ATIS airframes 用量持久化（重啟不歸零）：rate 快照(單列) + 每日誰用
      CREATE TABLE IF NOT EXISTS cs_atis_rate (
        id INTEGER PRIMARY KEY,
        lim INTEGER, remaining INTEGER, reset_at BIGINT, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cs_atis_who (
        day TEXT NOT NULL, who TEXT NOT NULL, icao TEXT NOT NULL DEFAULT '',
        cnt INTEGER NOT NULL DEFAULT 0, last_at TIMESTAMPTZ,
        PRIMARY KEY (day, who, icao)
      );
      -- 歐洲 NOP 配方(cookie + url/body/permutation)持久化:Render 重啟自動載回 → 不用人工重新點火,歐洲不因部署熄燈
      CREATE TABLE IF NOT EXISTS cs_nop_recipe (
        id INTEGER PRIMARY KEY,
        recipe JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- ATIS 累積庫(V9.4.22):背景輪詢把每站每類「最新有效」D-ATIS 存這裡,重啟從 DB 載回 → 跟 coffee 同機制(撈到就 hold、不因滾出 airframes 視窗而消失)
      CREATE TABLE IF NOT EXISTS cs_atis_store (
        airport TEXT NOT NULL, kind TEXT NOT NULL,
        issue_at TIMESTAMPTZ, received_at TIMESTAMPTZ,
        text TEXT, src TEXT, text_hash TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (airport, kind)
      );
    `);
    // V8.0.60：cs_atis_who 加 icao（記「誰查了哪個機場」）。舊表(PK day,who)要遷移：加欄、改主鍵。
    // ⚠ 不可刪舊列！舊聚合列 icao='' 保留(顯示時當「未分機場」)，避免清掉歷史用量。
    await _pool.query(`ALTER TABLE cs_atis_who ADD COLUMN IF NOT EXISTS icao TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await _pool.query(`ALTER TABLE cs_atis_who DROP CONSTRAINT IF EXISTS cs_atis_who_pkey`).catch(() => {});
    await _pool.query(`ALTER TABLE cs_atis_who ADD PRIMARY KEY (day, who, icao)`).catch(() => {});
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
_dbInit().then(() => { _atisLoadState(); _nopLoadState(); _atisStoreLoad().then(() => { _atisStartPoller(); _atisStartLiveFeed(); }); });   // 建表後從 DB 載回 ATIS 用量 + 歐洲 NOP cookie + ATIS 累積庫（重啟不歸零、不熄燈），載回後啟動背景輪詢 + 即時 feed

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
  // ⚠ 不可用 no-store：iOS WebKit 會連 CacheStorage 也拒存 → PWA 離線殼永遠存不進去、指示器卡「準備離線中」、飛航模式打不開（codex 診斷）。
  //   no-cache 仍每次跟 server revalidate（線上一定拿最新版、不卡舊版），但允許存離線副本。
  res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
  res.send(getSPAHtml());
});

app.get('/share', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');  // 同 /main：no-store 在 iOS 會擋 CacheStorage
  res.send(getSPAHtml(undefined, ['sync']));
});

// ── App 入口頁（給 LINE 社群置頂用：一頁拿到三個 App + 加到主畫面教學）────────────────
app.get('/apps', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');  // 同 /main：no-store 在 iOS 會擋 CacheStorage（這頁要能離線precache 自己）
  // 版號自動抓（改版自動跟著變，不用手動更新這頁）：CrewSync 從 html-body 抓首個 V8.0.x；其餘用常數。
  const csVer = (getSpaHtmlBody().match(/V\d+\.\d+\.\d+/) || [''])[0];
  const apps = [
    { icon: '🛬', name: 'CrewSync', ver: csVer, href: '/main', cn: '班表同步 · 機場天氣 · 跑道圖 · ATFM', en: 'Roster · Weather · Runway maps · ATFM' },
    { icon: '📒', name: 'Pilot Log', ver: PILOT_LOG_VERSION, href: '/pilot-log', cn: '電子飛行紀錄 · 班表匯入 · 統計分析', en: 'Electronic logbook · roster import · analytics' },
    { icon: '📰', name: '今日 Today', ver: APP_VERSION, href: '/morning', cn: '新聞 · 天氣 · 投資速覽', en: 'News · Weather · Portfolio' },
  ];
  const cards = apps.map(a =>
    `<a class="app" href="${a.href}">
       <div class="ico">${a.icon}</div>
       <div class="meta"><div class="nm">${a.name}${a.ver ? ` <span class="ver">${a.ver}</span>` : ''}</div><div class="dz">${a.cn}</div><div class="dz en">${a.en}</div><div class="off" id="off-${a.href.slice(1)}">⏳ 準備離線中…</div></div>
       <div class="go">開啟 ›</div>
     </a>`).join('');
  // 離線就緒偵測:檢查「該 app 新版快取」裡有沒有它的啟動頁 → 有就 ✅(代表新版真的存好、可離線)。
  // ⚠ 今日 /morning 是由 root SW 預存進 crewsync 快取(它自己 SW scope /morning/ 管不到啟動頁)→ 查 crewsync 快取。
  const _csCacheName = 'crewsync-' + (csVer ? csVer.replace('V', 'v').replace(/\./g, '') : 'unknown');
  const _offMap = [
    { slug: 'main', url: '/main', cache: _csCacheName },
    { slug: 'pilot-log', url: '/pilot-log', cache: 'pilotlog-v' + PILOT_LOG_VERSION.replace('V', '').replace(/\./g, '-') },
    { slug: 'morning', url: '/morning', cache: _csCacheName },
  ];
  res.send(`<!DOCTYPE html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Apps</title>
<link rel="manifest" href="/apps/manifest.json">
<link rel="icon" href="/apps/icon.svg">
<link rel="apple-touch-icon" href="/apps/icon.svg">
<meta name="theme-color" content="#0B1428">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Tools">
<meta name="mobile-web-app-capable" content="yes">
<!-- 蓋「從 /apps 入口進來」的章：三個 app 靠這個 + standalone 判斷才顯示 ⊞ 回 Tools 鈕 -->
<script>try{sessionStorage.setItem('cs_via_apps','1')}catch(e){}</script>
<!-- 只裝入口頁也能全部離線:上線開一次入口 → 一次叫醒三個 app 的 SW，各自預快取自己的 shell（離線看最後一次資料）。各 app 也保留自己頁面的註冊（分開裝照樣有）。
     ⚠ scope 必須與各 app 自己頁面的註冊「完全一致」:CrewSync=預設(/)、pilot-log=/pilot-log(該 sw route 有設 Service-Worker-Allowed)、morning=/morning/(尾斜線)。不一致會註冊失敗或重複。 -->
<script>if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').catch(function(){});
  navigator.serviceWorker.register('/pilot-log/sw.js',{scope:'/pilot-log'}).catch(function(){});
  navigator.serviceWorker.register('/morning/sw.js',{scope:'/morning/'}).catch(function(){});
}</script>
<!-- 離線就緒指示:每秒查「該 app 新版快取」裡有沒有它的啟動頁,有就 ✅(代表新版存好、可離線)。每張卡各自顯示。 -->
<script>(function(){
  var M = ${JSON.stringify(_offMap)};
  // 本頁自己把每個 app 的啟動頁抓下來存進它的快取（本頁「寫」就是「讀」的同一個快取，最可靠）。各 app SW 仍照常服務離線。
  // ⚠ 關鍵：啟動頁 HTML 不可再用 no-store（iOS WebKit 會連 CacheStorage 也拒存）→ 已改 no-cache。這裡「存完立刻 match 驗證」，存不進就明白標失敗、不再假裝「準備中」卡死（codex 診斷）。
  function el(s){ return document.getElementById('off-' + s); }
  function setOk(e){ e.setAttribute('data-st','ok'); e.textContent='\\u2705 \\u96e2\\u7dda\\u5c31\\u7dd2'; e.className='off ok'; }
  function setErr(e){ e.setAttribute('data-st','err'); e.textContent='\\u26a0\\ufe0f \\u96e2\\u7dda\\u5feb\\u53d6\\u672a\\u6210'; e.className='off err'; }
  if(!('caches' in window)){ M.forEach(function(a){ var e=el(a.slug); if(e) setErr(e); }); return; }
  function warm(a){
    var e = el(a.slug); if(!e || e.getAttribute('data-st')==='ok') return Promise.resolve();
    var req = new Request(a.url);
    return caches.open(a.cache).then(function(c){
      return c.match(req).then(function(hit){
        if (hit) { setOk(e); return; }
        return fetch(req, {cache:'no-store'}).then(function(r){
          if (!(r && r.ok && !r.redirected)) return;
          return c.put(req, r).then(function(){ return c.match(req); }).then(function(h2){ if (h2) setOk(e); });   // 存完立刻驗證
        });
      });
    }).catch(function(err){ if(window.console) console.error('offline precache failed', a.slug, err); });
  }
  var tries = 0;
  function round(){
    tries++;
    Promise.all(M.map(warm)).then(function(){
      var allOk = M.every(function(a){ var e=el(a.slug); return e && e.getAttribute('data-st')==='ok'; });
      if (allOk) { clearInterval(T); return; }
      if (tries >= 6) {   // ~12s 還沒成 → 把還沒成的明白標「未成」，不要永遠假裝準備中
        clearInterval(T);
        M.forEach(function(a){ var e=el(a.slug); if(e && e.getAttribute('data-st')!=='ok') setErr(e); });
      }
    });
  }
  var T = setInterval(round, 2000); round();
})();</script>
<!-- 入口一鍵更新「今日」資料：連網開 /apps 時，順手把今日的最新報告抓下來、存進今日讀的同一個 localStorage 鑰（同源），
     之後離線開今日就有「剛更新的」資料，不必先進今日一次。Pilot Log 自己已有本機資料、CrewSync 自有快取，這裡只補今日。 -->
<script>(function(){
  if (!navigator.onLine) return;
  var uid = ''; try { uid = localStorage.getItem('morning_uid') || ''; } catch(e){}
  var h = {}; if (uid) h['X-User-Id'] = encodeURIComponent(uid);
  fetch('/api/morning-report', { headers: h, cache:'no-store' })
    .then(function(r){ if(!r || !r.ok) return null; return r.json(); })
    .then(function(j){ if(!j || j.error) return; try { localStorage.setItem('morning_last_report_' + uid, JSON.stringify({ data: j, savedAt: Date.now() })); } catch(e){} })
    .catch(function(){});
})();</script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  /* 狀態列那塊鋪不透明底（同 CrewSync）：透明狀態列下捲動內容不透到狀態列區。 */
  html::before { content:''; position:fixed; top:0; left:0; right:0; height:env(safe-area-inset-top,0px); background:#0a0e1a; z-index:9999; pointer-events:none; }
  body { margin:0; background:#0a0e1a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans TC",sans-serif; line-height:1.5; padding-top:env(safe-area-inset-top); }
  .wrap { max-width:560px; margin:0 auto; padding:28px 18px calc(40px + env(safe-area-inset-bottom)); }
  h1 { font-size:1.5em; margin:8px 0 2px; }
  .sub { color:#94a3b8; font-size:.86em; margin-bottom:22px; }
  .app { display:flex; align-items:center; gap:14px; background:#111827; border:1px solid #1f2a3d; border-radius:14px; padding:16px; margin-bottom:12px; text-decoration:none; color:inherit; transition:border-color .15s,transform .1s; }
  .app:active { transform:scale(.985); }
  .app:hover { border-color:#3b82f6; }
  .ico { font-size:2.1em; width:52px; height:52px; display:flex; align-items:center; justify-content:center; background:#0a0e1a; border-radius:12px; flex-shrink:0; }
  .meta { flex:1; min-width:0; }
  .nm { font-weight:800; font-size:1.08em; }
  .ver { font-size:.6em; font-weight:600; color:#64748b; vertical-align:middle; margin-left:5px; letter-spacing:.3px; }
  .dz { color:#94a3b8; font-size:.78em; }
  .dz.en { color:#64748b; font-size:.72em; }
  .off { font-size:.72em; margin-top:4px; color:#64748b; display:flex; align-items:center; gap:4px; }
  .off.ok { color:#22c55e; }
  .off.err { color:#f59e0b; }
  .go { color:#3b82f6; font-weight:700; font-size:.85em; flex-shrink:0; }
  .install { margin-top:26px; background:#111827; border:1px solid #1f2a3d; border-radius:14px; padding:16px 18px; }
  .install h2 { font-size:.95em; margin:0 0 10px; color:#e2e8f0; }
  .install p { margin:6px 0; font-size:.84em; color:#cbd5e1; }
  .install b { color:#fff; }
  .tag { display:inline-block; background:#0a0e1a; border:1px solid #1f2a3d; border-radius:6px; padding:1px 7px; font-size:.92em; margin-right:4px; }
  .foot { text-align:center; color:#475569; font-size:.74em; margin-top:24px; }
</style></head><body><div class="wrap">
  <div class="sub" style="margin-top:6px">把這個 Tools 入口、或點進任一個 App，都能「加到主畫面」像獨立 App 一樣開。<br><span style="color:#64748b">Add this Tools hub — or any app inside — to your Home Screen and use it like a standalone app.</span></div>
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

// /apps PWA 圖示 + manifest —— 讓「加到主畫面」有專屬 App 啟動器圖示（2×2 彩色方塊）。
const APPS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0B1428"/><rect x="116" y="116" width="124" height="124" rx="30" fill="#3b82f6"/><rect x="272" y="116" width="124" height="124" rx="30" fill="#10b981"/><rect x="116" y="272" width="124" height="124" rx="30" fill="#f59e0b"/><rect x="272" y="272" width="124" height="124" rx="30" fill="#a855f7"/></svg>`;
app.get('/apps/icon.svg', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(APPS_ICON_SVG);
});
app.get('/apps/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: 'Tools', short_name: 'Tools',
    description: 'CrewSync · Pilot Log · 今日 Today',
    // scope 用 '/' 而非 '/apps'：讓這顆「入口 PWA」點進三個 app（/main、/pilot-log、/morning）時
    // 仍留在 standalone 視窗內當啟動器（scope:'/apps' 會把 app 連結踢去瀏覽器，破壞「一次進三個 app」）。
    start_url: '/apps', scope: '/', display: 'standalone',
    background_color: '#0a0e1a', theme_color: '#0B1428',
    icons: [{ src: '/apps/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
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
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>ACARS / D-ATIS sources</strong></td><td style="padding:8px">D-ATIS 即時資訊（ACARS）<br>Real-time D-ATIS (ACARS)<br><span style="opacity:.7;font-size:.9em">D-ATIS 即時資料由 <a href="https://info.coffeeteaorme.vip/" target="_blank" rel="noopener" style="color:#5b9bd5">CoffeeTeaorMe</a> 提供（另以 ACARS 社群資料備援）。<br>Real-time D-ATIS courtesy of <a href="https://info.coffeeteaorme.vip/" target="_blank" rel="noopener" style="color:#5b9bd5">CoffeeTeaorMe</a> (with ACARS community data as fallback).</span></td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>CodeTabs CORS Proxy</strong></td><td style="padding:8px">前端跨域代理<br>Frontend cross-origin proxy</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>FlightRadar24 (unofficial)</strong></td><td style="padding:8px">Gate Info 航班資訊補充<br>Gate Info flight data supplement</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>FlightAware (unofficial)</strong></td><td style="padding:8px">Gate Info 航班起訖地補充<br>Gate Info origin/destination supplement</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>Airport FIDS APIs</strong></td><td style="padding:8px">Gate Info 各站航班/登機門資訊（TPE / NRT / SIN / SFO / CTS / HKD）<br>Flight &amp; gate information (multiple airports)</td></tr>
<tr style="border-bottom:1px solid #333"><td style="padding:8px"><strong>Regional ATFM authorities</strong></td><td style="padding:8px">ATFM 流量管制狀態（亞太多地區）<br>Air traffic flow management (ATFM) status</td></tr>
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

const _viewTabMap: Record<string, string> = { sync: 'sync', ops: 'briefing', gate: 'gate' };   // fr24 已移除(見下方導回 /main)
for (const [route, tab] of Object.entries(_viewTabMap)) {
  app.get('/' + route, (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(getSPAHtml(tab));
  });
}
// FR24 分頁已移除 → 舊書籤/分享連結 /fr24 導回主頁(否則 getSPAHtml('fr24') 找不到按鈕會壞，codex P2）
app.get('/fr24', (_req, res) => res.redirect('/main'));

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

// ── ATIS：airframes 匿名 /v1（ACARS）為主源 + atis.guru(allorigins) 前端備援 ───────────────
// V9.4.18 大改：改用 airframes 匿名 /v1 端點（免 key、免額度、限速 60/分、全用戶可用，帶瀏覽器 UA 過 Cloudflare）。
//   美國 K/P → 官方 FAA(atis.info) 權威主源 → 退 airframes；非美 → airframes 匿名。查無 → {fallback} → 前端走 atis.guru。
//   單機場開啟：ARR/DEP 各專打挑最新（裸查缺 DEP 再補打）；區域一鍵更新(bulk=1)：裸查 1 次/場暖 60 分快取。
//   來源 src（航班號/註冊號，學 coffee）+ time 隨 sections 回前端標示。自我節流 56/分（_afAllow）。
// TODO（V9.4.18 遺留、留著不刪＝符專案規範）：下面整套「airframes 付費 key 額度 + founder/owner 身份閘門
//   + cs_atis_rate/cs_atis_who + _atisFetchCoffee/_COFFEE_REF」匿名化後已停用 —— _atisUpdateRate / _atisAllowed
//   / _atisRemainingNow / _atisRecordWho / AIRFRAMES_KEY / ATIS_OWNER_RESERVE 成孤兒（無人呼叫）。
//   /api/atis-usage、/api/atis-level、getAtisUsage、_atisAuthLevel、_atisLoadState 仍掛著（Tower 後台讀，現恆為空）。
//   日後確認 Tower 不需要後可整段移除。
const AIRFRAMES_KEY = process.env.AIRFRAMES_KEY || '';
const ATIS_TTL = 60 * 60 * 1000;          // 快取 60 分（ATIS 大約一小時更新一次）
// airframes 免費額度（單一池 500/天）。owner（站長）可用到剩 0；其他 founder 只能用到「剩 RESERVE」就停，
// 把最後這些保留給 owner。真實用量「直接讀 airframes 回應的 x-ratelimit-* 標頭」最準 —— 重啟、外部用量都不會錯，不自己數。
const ATIS_OWNER_RESERVE = 50;
const _atisCache = new Map<string, { sections: { title: string; text: string; src?: string; time?: string }[]; time: number; source: string }>();
let _atisRate: { limit: number; remaining: number; reset: number; updated: number } | null = null;

// 從 airframes 回應標頭更新真實額度（+ 持久化到 DB，重啟不歸零）
function _atisUpdateRate(r: any) {
  const lim = parseInt(r.headers.get('x-ratelimit-limit') || '', 10);
  const rem = parseInt(r.headers.get('x-ratelimit-remaining') || '', 10);
  const rst = parseInt(r.headers.get('x-ratelimit-reset') || '', 10);
  if (isNaN(lim) || isNaN(rem)) return;
  _atisRate = { limit: lim, remaining: rem, reset: isNaN(rst) ? 0 : rst, updated: Date.now() };
  if (_pool) _pool.query(
    `INSERT INTO cs_atis_rate (id,lim,remaining,reset_at,updated_at) VALUES (1,$1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE SET lim=$1,remaining=$2,reset_at=$3,updated_at=NOW()`,
    [lim, rem, _atisRate.reset]
  ).catch(() => {});
}
// 有效剩餘額度：過了 UTC 重置就當滿額（顯示 getAtisUsage 與判斷 _atisAllowed 用同一套，避免不一致 codex P2）。
function _atisRemainingNow(): number | null {
  if (!_atisRate) return null;
  if (_atisRate.reset > 0 && _atisRate.reset * 1000 < Date.now()) return _atisRate.limit;   // 過了重置 → 滿額
  return _atisRate.remaining;
}
// owner 用到剩 0、founder 用到剩 RESERVE 就停。_atisRate 還不知道（剛重啟、沒打過）→ 樂觀放行。
function _atisAllowed(level: 'owner' | 'founder'): boolean {
  const rem = _atisRemainingNow();
  if (rem == null) return true;
  const floor = level === 'owner' ? 0 : ATIS_OWNER_RESERVE;
  return rem > floor;
}
// 給 Tower 後台讀「真實 airframes 額度」（總數來自 airframes 標頭）。誰用的清單改由 /api/atis-usage 從 DB 撈（一致、原子）。
// ⚠ 不主動打 airframes（會扣額度）→ 真實總數要等有人真的用過 ATIS 才有值（_atisRate==null 時 known:false）。
export function getAtisUsage() {
  const rem = _atisRemainingNow();
  if (rem == null) return { known: false, limit: 500, founderCap: 500 - ATIS_OWNER_RESERVE, cachedAirports: _atisCache.size };
  return {
    known: true,
    limit: _atisRate!.limit,
    remaining: rem,
    used: Math.max(0, _atisRate!.limit - rem),
    founderCap: _atisRate!.limit - ATIS_OWNER_RESERVE,
    resetAt: _atisRate!.reset,
    cachedAirports: _atisCache.size,
  };
}

// founder 判定（名單上的人才走 airframes）：驗 token → userId/email → 查名單，連 email(who) 一起回（記「誰扣額度」用）。
// 結果快取 10 分，避免每次抓 ATIS 都打 DB。
type AtisLevel = 'owner' | 'founder' | 'none';
type AtisAuth = { level: AtisLevel; who: string };
const _founderCache = new Map<string, { auth: AtisAuth; time: number }>();
async function _authCached(key: string, compute: () => Promise<{ level: AtisLevel; email: string }>): Promise<AtisAuth> {
  const c = _founderCache.get(key);
  if (c && Date.now() - c.time < 10 * 60 * 1000) return c.auth;
  const r = await compute().catch(() => ({ level: 'none' as AtisLevel, email: '' }));
  const auth: AtisAuth = { level: r.level, who: r.email };
  _founderCache.set(key, { auth, time: Date.now() });
  return auth;
}
// 兩種登入都認：Pilot Log（pilotlog_at → userId）或 CrewSync 班表同步（email 身份證）。取較高等級、回 who。
async function _atisAuthLevel(plToken: string, csIdt: string): Promise<AtisAuth> {
  let res: AtisAuth = { level: 'none', who: '' };
  const payload = plToken ? verifyAccessToken(plToken) : null;
  if (payload && payload.sub) res = await _authCached('u:' + payload.sub, () => getFounderLevel(payload.sub));
  if (res.level === 'owner') return res;
  const email = csIdt ? verifyEmailToken(csIdt) : null;
  if (email) {
    const e = await _authCached('e:' + email, () => getFounderLevelByEmail(email));
    if (e.level === 'owner') return e;
    if (e.level === 'founder') res = e;   // 升級為 founder（連 who）
  }
  return res;
}

// ATIS 通行閘：只有「同步過班表」的真組員（或站方 founder/owner）能取站長爬出來的 ATIS。
// 同步成功才會把 email 連上 employee_id（server.ts 同步 link 處），故 employee_id IS NOT NULL == 已驗證組員。
// 無 DB → fail-closed（鎖死）；dev/smoke 用 ATIS_GATE_OFF=1 放行。
async function _atisGateOk(plToken: string, csIdt: string): Promise<boolean> {
  if (process.env.ATIS_GATE_OFF === '1') return true;
  if (!_pool) return false;                              // 無 DB → fail-closed
  const emails: string[] = [];
  try {
    const a = await _atisAuthLevel(plToken, csIdt);
    if (a.level === 'owner' || a.level === 'founder') return true;   // 站方不受鎖
    // _atisAuthLevel 會把 plToken 解出的 email 放進 who（連非 founder 也帶）→ 收進候選，
    //   讓「只用 Pilot Log 登入、沒帶 csIdt」的已同步組員也驗得過（codex P1：別把這種人誤鎖）。
    if (a.who) emails.push(a.who);
  } catch { /* 判定失敗就往下走班表驗證 */ }
  const email = csIdt ? verifyEmailToken(csIdt) : null;   // 班表同步登入身份證（email）
  if (email) emails.push(email);
  if (!emails.length) return false;
  try {
    // 任一已驗證 email 是「同步過班表」（employee_id 有值）→ 放行。email 全來自簽章驗過的 token，外人偽造不來。
    const q = await _pool.query('SELECT 1 FROM cs_users WHERE email = ANY($1) AND employee_id IS NOT NULL', [emails]);
    return (q.rowCount || 0) > 0;
  } catch { return false; }
}

// 回傳「呼叫者用簽章 token 證明自己擁有的 employee_id」，無法證明→null。
// email（來自 csIdt 或 plToken，皆簽章驗過）→ cs_users 連結的員編。外人偽造不來。
async function _verifiedEid(plToken: string, csIdt: string): Promise<string | null> {
  if (!_pool) return null;
  const emails: string[] = [];
  try { const a = await _atisAuthLevel(plToken, csIdt); if (a.who) emails.push(a.who); } catch { /* 失敗就只靠 csIdt */ }
  const em = csIdt ? verifyEmailToken(csIdt) : null;
  if (em) emails.push(em);
  if (!emails.length) return null;
  try {
    const q = await _pool.query('SELECT employee_id FROM cs_users WHERE email = ANY($1) AND employee_id IS NOT NULL LIMIT 1', [emails]);
    return q.rows[0] && q.rows[0].employee_id ? String(q.rows[0].employee_id) : null;
  } catch { return null; }
}

// 寫入授權：只能動「自己的」員編。回傳通過驗證的 eid（==claimed），不符/無法證明→null。
// WRITE_AUTHZ_OFF=1 跳過驗證（dev/緊急回退用，回 claimed 不檢查）。
async function _writeAuthzEid(req: any, claimedEid: any): Promise<string | null> {
  const claimed = claimedEid == null ? '' : String(claimedEid);
  if (process.env.WRITE_AUTHZ_OFF === '1') return claimed || null;
  const mine = await _verifiedEid(String(req.headers['x-pl-at'] || ''), String(req.headers['x-cs-idt'] || ''));
  if (!mine) return null;                          // 無法證明身份 → 拒
  if (claimed && claimed !== mine) return null;    // 想動別人的員編 → 拒（防冒名）
  return mine;
}

// 「誰觸發了 airframes 呼叫」計數 → 原子寫進 DB（cnt = cnt + 2），重啟不歸零、不會競態覆蓋（codex P2）。
// 不存記憶體；顯示一律即時從 DB 撈（/api/atis-usage），避免記憶體/DB 不一致。只算實際打 airframes（快取命中不算）。
function _atisRecordWho(who: string, level: AtisLevel, icao: string) {
  if (!_pool) return;
  const d = new Date().toISOString().slice(0, 10);
  const id = who || (level === 'owner' ? '(owner)' : '(unknown)');
  _pool.query(
    `INSERT INTO cs_atis_who (day,who,icao,cnt,last_at) VALUES ($1,$2,$3,2,NOW())
     ON CONFLICT (day,who,icao) DO UPDATE SET cnt = cs_atis_who.cnt + 2, last_at = NOW()`,
    [d, id, icao]
  ).catch(() => {});   // 一次抓 ARR+DEP = +2；原子遞增。記「誰查了哪個機場」
}

// 啟動時從 DB 載回 rate 快照（過了重置時間就當滿額）。誰用的不載記憶體（一律即時從 DB 撈）。
async function _atisLoadState() {
  if (!_pool) return;
  try {
    const rr = await _pool.query(`SELECT lim,remaining,reset_at FROM cs_atis_rate WHERE id=1`);
    if (rr.rows.length) {
      const row = rr.rows[0];
      const reset = Number(row.reset_at) || 0;
      const remaining = (reset && reset * 1000 < Date.now()) ? row.lim : row.remaining;   // 過了重置→已歸零→當滿額
      _atisRate = { limit: row.lim, remaining, reset, updated: Date.now() };
    }
  } catch { /* 載入失敗就用空的，不擋啟動 */ }
}

// 啟動時從 DB 載回歐洲 NOP 配方(cookie)。Render 重啟只要 1-2 分鐘、cookie session 閒置 timeout ~10-12 分 → 載回通常還活著,保活直接續命,歐洲不熄燈、不用人工點火。
async function _nopLoadState() {
  if (!_pool) return;
  try {
    const rr = await _pool.query(`SELECT recipe FROM cs_nop_recipe WHERE id=1`);
    const rec = rr.rows[0] && rr.rows[0].recipe;
    if (rec && rec.cookie) {
      _nopRecipe = rec;
      console.log('[NOP] recipe loaded from DB, cookie', String(rec.cookie).length);
      _atfmEu(true).catch(() => { });   // 啟動就用載回的 cookie 抓一次 → 歐洲立刻亮,不等下一輪保活
    }
  } catch { /* 載入失敗不擋啟動 */ }
}

// TODO（2026-06-12）：舊 _atisFetchCoffee（讀 m.message、無 issueAt、未授權時停用）已被下方新版取代
//   —— 站長正式授權後改用 rawMessage + realIssueAt 挑現行 + issueAt 併庫。保留此註解備查。

// ── airframes 匿名 /v1（V9.4.18 起改用，免 key、限速 60/分、帶瀏覽器 UA 過 Cloudflare）──────
// 來源解析：airframes 把「飛機↔即時航班」對得上時，flight 是物件(含 flightIata/designator+number)→ 取航班號(BR772)；
//   對不上 → 退取飛機註冊號 tail(B-18723)。⚠ station 欄含志工接收站個資(用戶名/IP/座標)，絕不取用。
function _atisSrcOf(m: any): string {
  const f = m && m.flight;
  const raw = (f && typeof f === 'object')
    ? String(f.flightIata || f.flight || f.flightIcao || ((f.designator || '') + (f.number != null ? f.number : '')) || '')
    : String((typeof f === 'string' && f.trim() ? f : (m && m.tail)) || '');   // 優先航班號(BR6089)、沒有才退機尾號(B-16782)→ 比照 coffee「顯示哪班航機」
  return raw.trim().replace(/[^A-Za-z0-9\- ]/g, '').slice(0, 12);   // 只留安全字元（外部 API 來的，防 HTML 注入）+ 限長
}
// ISO 時間 → "2026-06-08 15:41Z"（UTC，給前端標「Time」用）
function _atisFmtTime(iso: any): string {
  const t = Date.parse(String(iso || ''));
  if (!t) return '';
  const d = new Date(t);
  if (d.getUTCFullYear() < 2000) return '';   // 防呆：誤把 "1556"(HHMM) 之類當西元年份的，視為無效
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + 'Z';
}
// 真實發布時刻：從訊息內文（字母後 HHMMZ / METAR DDHHMM / NA 的 ATIS-HHMMZ）+ 收到時間推算。挑現行、排序、庫自我校正都用這支。
//   ① 字母後 HHMM = 發布時分；有 METAR 用 METAR 的「日」，無 METAR 用收到日（發布晚於收到=前一天）。
//   ② 無字母但 ATIS 後接 HHMMZ（宵禁 NOT AVAILABLE）→ 用那 HHMM（昨晚 NA 今天被回放，不可退用收到時間、否則蓋掉現行字母）。
//   ③ 都解不出 → 收到時間。⚠ 不因「太舊」丟掉，照算真實時刻、舊也誠實標。
function _atisRealIssueAt(m: any): number {
  const t = String((m && m.text) || '');
  const ing = Date.parse(String((m && m.timestamp) || '')) || Date.now();
  const d = new Date(ing);
  const lm = t.match(/ATIS\s+[A-Z]\s+(\d{2})(\d{2})Z/);
  const mm = t.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  const dd = mm ? parseInt(mm[1], 10) : 0;
  if (lm) {
    const hh = parseInt(lm[1], 10), mi = parseInt(lm[2], 10);
    if (mm && dd >= 1 && dd <= 31) {
      const mh = parseInt(mm[2], 10), mmin = parseInt(mm[3], 10);
      let ts = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dd, hh, mi);
      if (ts > ing + 6 * 3600000) ts = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, dd, hh, mi);
      if ((mh * 60 + mmin) - (hh * 60 + mi) > 12 * 60) ts += 86400000;
      return ts;
    }
    let issue = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mi);
    if (issue > ing + 5 * 60000) issue -= 86400000;
    return issue;
  }
  const nm = t.match(/ATIS\s+(\d{2})(\d{2})Z/);   // 無字母、ATIS 後直接 HHMMZ（宵禁 NA）
  if (nm) {
    const hh = parseInt(nm[1], 10), mi = parseInt(nm[2], 10);
    let issue = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mi);
    if (issue > ing + 5 * 60000) issue -= 86400000;
    return issue;
  }
  if (mm && dd >= 1 && dd <= 31) {
    let ts = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dd, parseInt(mm[2], 10), parseInt(mm[3], 10));
    if (ts > ing + 6 * 3600000) ts = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, dd, parseInt(mm[2], 10), parseInt(mm[3], 10));
    return ts;
  }
  return ing;
}
// ATIS 是否「完整」：含 QNH/高度表撥定（QNH/Q####/A####）→ 是完整的；被截在前半身（如停在 RWY... 還沒到天氣）就沒有。
//   用「內容本身」判完整度，比「前綴比對」robust：不怕不同來源(coffee/airframes)換行空白格式不同（V9.4.37 前綴法在此破功、截斷版仍勝出）。
function _atisHasQNH(t: string): boolean { return /\bQNH\b|\bQ\d{4}\b|\bA\d{4}\b|ALTIMETER/i.test(String(t || '')); }
// 去結尾 ACARS frame 尾碼（4 位 hex）。只在「含 hex 字母 A-F」或「自成一行(換行後)」才砍 →
//   避免誤砍合法的 4 位數 QNH / 高度表(如 1013、2992，純數字、無 frame 時可能是內容結尾，codex P1 飛安)。
//   實際 frame 多含字母(C455/817C/9F00/770F/C83B) 或自成一行(換行C455)，這條都涵蓋；純數字 frame(罕見)寧可留著也不砍掉 QNH。
//   ⚠ 只砍「含 hex 字母 A-F」或「自成一行(換行後)」的 4 碼 → 絕不砍純數字結尾（可能是 QNH 1013 / 能見度 8000 / RVR 1200 等
//   合法內容；airframes 訊息沒有 frame 尾碼，結尾純數字一定是內容，codex P1 飛安）。coffee 的純數字 frame 在 _atisFetchCoffee 處理。
function _atisStripFrame(s: string): string {
  return String(s == null ? '' : s).replace(/([\r\n]\s*)?([0-9A-Fa-f]{4})\s*$/, (m, nl, code) => (nl || /[A-Fa-f]/.test(code)) ? '' : m);
}
// 比「完整度」用的乾淨長度：去路由前綴 + 去結尾 frame 尾碼 + 收斂空白 → 不被雜訊(尾碼/換行/來源格式差異)影響長度比較。
//   否則「去尾碼後的乾淨版」會比「沒去尾碼的舊版」短 → 被當成不完整而退回舊版（尾碼又冒出來，V9.4.38 踩過）。
function _atisBodyLen(t: string): number {
  return _atisStripFrame(String(t || '').replace(/^\/[^/]*\//, '')).replace(/\s+/g, ' ').trim().length;
}
// 判斷一則文字「是不是某機場某類別的真 ATIS」（pickKind 比對 + 庫存自癒共用）：必須「ICAO + ARR/DEP + ATIS」整組（或合併場 ICAO + ATIS + 字母 / NOT AVAILABLE）。
//   ⚠ 不可只 includes('DEP ATIS')：公司飛行計畫(OFP) ACARS 有空白「DEP ATIS」表單欄位 + 夾帶備降場 ICAO（如 LOWW）→ 鬆比對會把整封 OFP 當 ATIS（LOWW 踩過）。
//   綁定 icao（沒帶才退 [A-Z]{4} 通用）→ 別場 ATIS 也不會冒充本場。
function _atisTextIsKind(text: string, icao: string | undefined, kind: 'ARR' | 'DEP' | 'ATIS'): boolean {
  const ico = (icao || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = /^[A-Z]{4}$/.test(ico) ? ico : '[A-Z]{4}';
  const t = String(text || '');
  if (kind === 'ATIS') {
    if (/\b[A-Z]{4}\s+(?:ARR|DEP)\s+ATIS\b/.test(t)) return false;   // 真正的 ARR/DEP 專用 → 不歸合併
    return new RegExp('\\b' + p + '\\s+ATIS\\s+[A-Z]\\b').test(t) || new RegExp('\\b' + p + '\\s+ATIS\\b[\\s\\S]{0,15}NOT\\s+AVAIL', 'i').test(t);
  }
  return new RegExp('\\b' + p + '\\s+' + kind + '\\s+ATIS\\b').test(t);
}
// 從一批 airframes 訊息挑某 kind(ARR/DEP)的「現行」那則 → {title,text,src,time}
function _atisPickKind(msgs: any[], kind: 'ARR' | 'DEP' | 'ATIS', icao?: string): { title: string; text: string; src: string; time: string; issueAt: number; receivedAt: number; hash: string } | null {
  const tag = kind === 'ATIS' ? 'ATIS' : kind + ' ATIS';   // 'ATIS' = 合併 ATIS（歐洲等不分 ARR/DEP 的場，格式 "ICAO ATIS X"）
  // ⚠ 不可濾掉「ATIS NOT AVAILABLE」：那是合法狀態（如 RJAA 宵禁、夜間無航班→無 D-ATIS），該照實顯示給飛行員。
  //   它沒有字母碼，issueScore 解不出發布時刻 → 退用收到時間排序（curfew 訊息「收到當下即有效」，這樣才比得贏舊的、也會被白天恢復的字母 ATIS 蓋過）。
  const matches = msgs.filter((m) => _atisTextIsKind(String((m && m.text) || ''), icao, kind));   // 必須「ICAO+種類+ATIS」整組（見 _atisTextIsKind）
  if (!matches.length) return null;
  // 挑「真實發布時刻最新」的那則（realIssueAt 抽成 _atisRealIssueAt 共用）。⚠ 永不變空：只要有 matches 就一定回一則。
  const future = Date.now() + 15 * 60000;   // 合成時刻不可能在未來：壞訊息（letter+METAR 湊出未來時戳）不可冒充現行（容 15 分時鐘誤差，codex P1）。
  let best: any = null, bestScore = -Infinity;
  // 挑「發布最新」；同發布時刻：挑「完整(有 QNH)」優先於「被截斷(無 QNH)」——完整版永遠勝過截斷版，不管誰先收到；
  //   同樣完整(或同樣截斷) → 挑收到較新那則（同時刻修正版/刷新顯示時間，不誤殺合法短修正）。
  for (const m of matches) {
    const s = _atisRealIssueAt(m); if (s > future) continue;
    if (!best || s > bestScore) { best = m; bestScore = s; continue; }
    if (s === bestScore) {
      const mt = String((m && m.text) || ''), bt = String((best && best.text) || '');
      const mFull = _atisHasQNH(mt), bFull = _atisHasQNH(bt);
      const mRecv = Date.parse(String(m && m.timestamp)) || 0, bRecv = Date.parse(String(best && best.timestamp)) || 0;
      // 完整度優先(有 QNH > 無)；同完整度挑「乾淨body最長=最完整」(處理 QNH 之後才被截斷的 frag，codex)；長度也相同才比收到時間。
      const mLen = _atisBodyLen(mt), bLen = _atisBodyLen(bt);
      const take = mFull !== bFull ? mFull : (mLen !== bLen ? mLen > bLen : mRecv > bRecv);
      if (take) best = m;
    }
  }
  if (!best) {   // 全是未來時戳（極少壞訊息）→ never-blank 保底：挑「收到最新」那則、用收到時間當分數，仍不變空。
    best = matches.reduce((a, b) => ((Date.parse(String(b && b.timestamp)) || 0) > (Date.parse(String(a && a.timestamp)) || 0) ? b : a), matches[0]);
    bestScore = Date.parse(String(best && best.timestamp)) || Date.now();
  }
  const text = _atisStripFrame(String((best && best.text) || '').replace(/^\/[^/]*\//, ''))   // 去路由前綴 + 結尾 frame 尾碼（N9F00/.C83B/APP.817C/換行C455；保留純數字 QNH）
    .trim();
  if (!text) return null;
  const receivedAt = Date.parse(String((best && best.timestamp) || '')) || Date.now();
  // time 顯示「收到時間」（哪班機在什麼時候讀回的）→ 比照 coffee 的標法（Source: 機號 / Time: 收到時刻）。
  //   排序/挑現行仍用發布時刻 issueAt（不被回放騙），只有「顯示的時間」用收到時間。
  return { title: tag, text, src: _atisSrcOf(best), time: _atisFmtTime(new Date(receivedAt).toISOString()), issueAt: bestScore, receivedAt, hash: _atisHash(text) };
}
// airframes 匿名限速 60/分（整台 server 共用一個 IP）→ 自我節流到 56/分；bucket 不足就退前端 fallback，不白打成 429。
let _afBucket = 56, _afBucketReset = 0;
function _afAllow(n: number): boolean {
  const now = Date.now();
  if (now >= _afBucketReset) { _afBucket = 56; _afBucketReset = now + 60000; }
  if (_afBucket < n) return false;
  _afBucket -= n;
  return true;
}
// ── 衛星站「整串 A9」抓法（V9.4.30，codex 破解的正解）──────────────────────────
//   關鍵：airframes 的 `text=<ICAO>` 機場文字搜尋索引爛、回舊的；正解是「抓某個 JAERO/L-band 衛星站的整串 A9
//   （station_ids=...&labels=A9&timeframe=...，端點是 /messages 不是 /v1/messages），再本地過濾出各機場」。
//   一台 APAC L-band 站就涵蓋整個衛星波束的幾十個機場（RCTP/RJTT/VHHH/RKSS/VTBS/越南/印度/中東…），且比 text= 新很多。
//   ⚠ 仍追不平 coffee（coffee 的源涵蓋到更多「靠近機場讀現行 ATIS」的飛機，airframes 衛星站收到的多是 en-route 回放舊字母）；
//     但這條讓我們比原本的 text= 新一截。station id 來自 airframes /stations，可能變動 → 設成 env 可不改 code 更新。
//   多波束覆蓋（每站分開查、各吃 100、合併）：APAC=亞洲、EMEA=歐洲/中東/非洲/印度、IOR=印度洋、AMER=美洲。
//   ⚠ 仍非 coffee 完整源：coffee 多看到「別顆衛星上零星讀目標機場的飛機」(實證 RJAA letter O 走 GES:D0、airframes 任何站都沒有)，那段追不到；但主要區域都涵蓋。
//   ⚠ 衛星站常掛/不活躍(間歇 404、無 A9) → 不寫死，改「候選池按波束 + 每 30 分健康檢查、只留此刻有回 A9 的活站」，美洲一活躍就自動補上。
const _AF_SAT_CANDIDATES: string[][] = [
  ['14799901', '15254012'],                 // APAC 亞太：TBG-LBAND-APAC, JP-RJTY-LBAND
  ['237322626', '237344145', '14918702'],    // EMEA 歐洲/中東/非洲/印度：EDDF-SAT, EGBB-25E, EGGD-25E
  ['237339412'],                             // IOR 印度洋/澳洲：YBBN-84E
  ['15254214', '14920420', '14918698'],      // AMER 美洲/大西洋：PC-KAMW9-98W, PC-KAMW2-98W, EGGD-54W
];
const _afStaticStations = (process.env.ATIS_SAT_STATIONS || '').trim();   // env 有設 → 手動釘住這些站、不跑健康檢查（除錯/微調用）
let _afActiveStations: string[] = _afStaticStations ? _afStaticStations.split(',').map((s) => s.trim()).filter(Boolean)
  : ['14799901', '15254012', '237322626', '237339412'];   // 開機預設（健康檢查跑完會更新成此刻真正活躍的）
// 健康檢查：逐個候選站打一次，留「有回 A9 ATIS」的 → 更新活躍清單。每 30 分跑一次（便宜、自動避開掛站/補上活站）。
async function _atisSatHealthCheck() {
  if (_afStaticStations) return;   // env 釘住 → 尊重手動設定，不動
  const active: string[] = [];
  for (const st of _AF_SAT_CANDIDATES.flat()) {
    // ⚠ airframes /messages 間歇性 404（API 不穩、非站台真的掛）→ 404 就重試最多 3 次，避免把好站誤判成死站
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!_afAllow(1)) break;
      try {
        const r = await fetch('https://api.airframes.io/messages?station_ids=' + st + '&labels=A9&timeframe=last-2-hours', { headers: { 'User-Agent': _FIDS_UA } });
        if (r.status === 404) { await new Promise((res) => setTimeout(res, 400)); continue; }   // 間歇 404 → 等一下重試
        if (!r.ok) break;                                                                         // 其他錯 → 放棄這站
        const a = await r.json() as any;
        const arr: any[] = Array.isArray(a) ? a : ((a && (a.messages || a.data)) || []);
        if (arr.some((m) => /\bATIS\b/.test(String((m && (m.text || m.message)) || '')))) active.push(st);   // 有 A9 → 活躍
        break;   // 拿到 200（不管有沒有 A9）→ 不再重試
      } catch { break; }
    }
  }
  if (active.length) { _afActiveStations = active; console.log('[ATIS] sat stations active:', active.join(',')); }
}
async function _afQuery(q: string): Promise<any[]> {
  // V9.4.x：加 labels=A9（ACARS ATIS label，coffee 站長提供）→ 只回 ATIS 那層、不被其他 ACARS 稀釋。
  //   實測 text=<ICAO>&labels=A9 仍以 text 限縮在該機場、且 100 則 ATIS 涵蓋約 9-10 小時（混合查只有 ~12% 是 ATIS、
  //   現行 ATIS 幾分鐘就滾出視窗）。→ 即時查就很新，大幅減少漏抓。labels 用「複數」才生效（label 單數會被忽略）。
  const url = 'https://api.airframes.io/v1/messages?text=' + encodeURIComponent(q) + '&labels=A9&perPage=100';
  const r = await fetch(url, { headers: { 'User-Agent': _FIDS_UA } });
  if (!r.ok) throw new Error('airframes ' + r.status);   // 429/5xx → 讓上層走 fallback
  const a = await r.json() as any;
  // 實測 /v1/messages 回「裸陣列」→ 直接用。防禦：萬一哪天 airframes 改成物件外包，試常見鍵抽出陣列（codex 誤報為「一定是 wrapper」，
  //   實證目前是裸陣列；此分支現在不會觸發，純為未來 API 變動保底）。
  if (Array.isArray(a)) return a;
  const arr = a && (a.messages || a.data || a.results || a.items);
  return Array.isArray(arr) ? arr : [];
}
// 抓某機場 ARR+DEP D-ATIS。bulk=true（一鍵更新）→ 只裸查 1 次省限速；單機場開啟 → 裸查沒撈到 DEP 時再專打 DEP 補一次。
async function _atisFetchAirframes(icao: string, bulk: boolean) {
  const base = await _afQuery(icao);                       // 裸查：回最近 100 則（ARR/DEP 混在一起）
  let arr = _atisPickKind(base, 'ARR', icao);
  let dep = _atisPickKind(base, 'DEP', icao);
  // 單機場開啟：裸查若漏掉 ARR 或 DEP（繁忙場被其他訊息擠出 100 視窗、安靜場稀疏）→ 各自專打補抓，
  //   每類用自己的 100 視窗，不會互相稀釋（codex P1：原本只補 DEP，繁忙場 ARR 也可能掉）。
  if (!bulk && !arr) {
    try { if (_afAllow(1)) arr = _atisPickKind(await _afQuery(icao + ' ARR ATIS'), 'ARR', icao); } catch { /* 補抓失敗就算了 */ }
  }
  if (!bulk && !dep) {
    try { if (_afAllow(1)) dep = _atisPickKind(await _afQuery(icao + ' DEP ATIS'), 'DEP', icao); } catch { /* 補抓失敗就算了 */ }
  }
  // 合併 ATIS（歐洲等不分 ARR/DEP 的場）：只有「完全沒有 ARR/DEP」時才試，避免分場誤抓。
  let combined = (!arr && !dep) ? _atisPickKind(base, 'ATIS', icao) : null;
  if (!bulk && !arr && !dep && !combined) {
    try { if (_afAllow(1)) combined = _atisPickKind(await _afQuery(icao + ' ATIS'), 'ATIS', icao); } catch { /* 補抓失敗就算了 */ }
  }
  const sections = [arr, dep, combined].filter(Boolean) as { title: string; text: string; src: string; time: string }[];
  return sections.length ? sections : null;
}

// ── coffee（coffeeteaorme.vip）：站長 2026-06-12 正式授權、白名單綁 oops.h-peak.com origin（主源）──
//   比 airframes 密、更接近現行（他自己也爬 ACARS + 私人接收機）。爬蟲型 API：每次 5-20s、回最新 100 筆、需自行濾現行。
//   server 端帶 Origin/Referer 即過白名單（實證 200 + CORS allow-origin 回我們網域）。非營利助組員，站長同意免費。
async function _atisFetchCoffee(icao: string) {
  const headers = { 'Origin': 'https://oops.h-peak.com', 'Referer': 'https://oops.h-peak.com/', 'User-Agent': _FIDS_UA, 'Accept': 'application/json' };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 25000);   // 爬蟲型最久 ~20s，留 25s 逾時
  let j: any;
  try {
    const r = await fetch('https://api.coffeeteaorme.vip/api/atis?text=' + encodeURIComponent(icao), { headers, signal: ctrl.signal });
    if (!r.ok) return null;   // 非 200（白名單/掛站）→ 回 null，上層走 airframes 備援
    j = await r.json();
  } catch { return null; } finally { clearTimeout(to); }
  const data: any[] = (j && Array.isArray(j.data)) ? j.data : [];
  if (!data.length) return null;
  // rawMessage 形如 "AES:.. GES:50 N REG /TPECAYA.TI2/RCTP ARR ATIS T\n1130Z..." → 砍 AES/GES/rego/路由前綴，從「ICAO (ARR/DEP) ATIS」起留到尾
  const records = data.map((d) => {
    const raw = String((d && d.rawMessage) || '');
    const m = raw.match(/[A-Z]{4}\s+(?:ARR\s+|DEP\s+)?ATIS\b[\s\S]*/);
    // coffee rawMessage 結尾一定有 ACARS frame 尾碼（4 hex，可能黏字尾/句點/換行後，如 N9F00、.1702、換行0DEE）→ 這裡砍掉。
    //   coffee 結構保證 frame 在最後一段、砍「最後 4 hex」安全（含純數字 frame 也沒問題，真實內容值在 frame 之前不受影響）。
    const text = (m ? m[0] : raw).replace(/\s*[0-9A-Fa-f]{4}\s*$/, '');
    return { text, timestamp: String((d && d.timestamp) || '').trim().replace(' ', 'T') + 'Z', flight: (d && d.flight) || '', tail: (d && d.rego) || '' };
  });
  const arr = _atisPickKind(records, 'ARR', icao);
  const dep = _atisPickKind(records, 'DEP', icao);
  const combined = (!arr && !dep) ? _atisPickKind(records, 'ATIS', icao) : null;   // 歐洲等不分 ARR/DEP
  const sections = [arr, dep, combined].filter(Boolean) as { title: string; text: string; src: string; time: string; issueAt: number; receivedAt: number; hash: string }[];
  return sections.length ? sections : null;
}
// 把一組 sections 併進累積庫（升級才覆蓋）→ coffee/airframes 共用，最新的自然勝出。回傳有沒有更新。
function _atisMergeSections(icao: string, sections: any[] | null): boolean {
  if (!sections) return false;
  let any = false;
  for (const s of sections) {
    const kind = s.title === 'DEP ATIS' ? 'DEP' : s.title === 'ARR ATIS' ? 'ARR' : s.title === 'ATIS' ? 'ATIS' : null;
    if (kind && typeof s.issueAt === 'number' && _atisStoreMerge(icao, kind, s)) { _atisStorePersist(icao, kind); any = true; }
  }
  return any;
}
// coffee 撈取節流：站長是人情爬蟲、每次冷打 5-20s 觸發他爬一輪 → 同一場一段時間內不重複打（ATIS ~30 分才換）。
const _COFFEE_COOLDOWN = 15 * 60000;       // 成功(有回資料) → 15 分鐘內不重撈
const _COFFEE_FAIL_COOLDOWN = 60000;       // 失敗(逾時/掛/空) → 只壓 1 分鐘，暫時掛點別鎖死 15 分（codex P2），但也不狂打
const _coffeeNext = new Map<string, number>();   // 各場「下次可撈 coffee」的時間
function _coffeeFresh(icao: string): boolean { return Date.now() < (_coffeeNext.get(icao) || 0); }   // 還在冷卻內 → 不重撈
async function _coffeePull(icao: string): Promise<boolean> {   // 撈 coffee→併庫。回「有沒有真的拉到更新的」(給 fresh 判斷要不要退 airframes)。
  let got = false, improved = false;
  try { const cs = await _atisFetchCoffee(icao); if (cs) { got = true; improved = _atisMergeSections(icao, cs); } } catch { got = false; }
  // 撈完才起算冷卻：有回資料(got，不管有沒有更新) → 正常 15 分；失敗/空 → 只 1 分，暫時掛點不鎖死、但也不狂打站長
  _coffeeNext.set(icao, Date.now() + (got ? _COFFEE_COOLDOWN : _COFFEE_FAIL_COOLDOWN));
  return improved;
}

// 衛星站整串 A9 → 涵蓋整個衛星波束的幾十場，本地分機場挑現行、塞進累積庫。回傳更新筆數。
//   比 text=<ICAO> 逐站查新很多。⚠ 關鍵：「每次查詢」上限 100 則、且同波束多站合查會「重複洗掉一半」→
//   必須「每站分開查、各吃自己的 100 則」再合併，覆蓋才滿（實證：兩站合查日本場消失、單站才有）。
async function _atisFetchStationFeed(): Promise<number> {
  const stations = _afActiveStations;   // 健康檢查維護的「此刻活躍」清單（env 釘住時即手動清單）
  // 分機場累積（跨站合併同機場的訊息，再挑現行）。正規化 text：/messages 文字在 text、少數在 message。
  const byApt = new Map<string, any[]>();
  for (const st of stations) {
    if (!_afAllow(1)) break;   // 額度不足 → 停，下一輪再補剩下的站
    try {
      const url = 'https://api.airframes.io/messages?station_ids=' + st + '&labels=A9&timeframe=last-2-hours';
      const r = await fetch(url, { headers: { 'User-Agent': _FIDS_UA } });
      if (!r.ok) continue;   // 間歇 404（airframes API 偶發）/ 壞站 → 跳過這站，不中斷其他站
      const a = await r.json() as any;
      const arr: any[] = Array.isArray(a) ? a : ((a && (a.messages || a.data || a.results || a.items)) || []);
      for (const m of arr) {
        if (!m) continue;
        m.text = String(m.text || m.message || '');
        const mt = m.text.match(/\b([A-Z]{4})\s+(?:ARR|DEP)?\s*ATIS/);
        if (!mt) continue;
        const ic = mt[1];
        if (ic[0] === 'K' || ic[0] === 'P') continue;   // 美國/太平洋 → 官方 FAA，不收進 acars 庫
        let list = byApt.get(ic); if (!list) { list = []; byApt.set(ic, list); }
        list.push(m);
      }
    } catch { /* 單站失敗跳過，不影響其他站 */ }
  }
  let updates = 0;
  for (const [ic, msgs] of byApt) {
    for (const kind of ['ARR', 'DEP', 'ATIS'] as const) {
      const p = _atisPickKind(msgs, kind, ic);
      if (p && typeof p.issueAt === 'number' && _atisStoreMerge(ic, kind, p)) { _atisStorePersist(ic, kind); updates++; }
    }
  }
  return updates;
}

// 按 ACARS DSP 路由前綴跨「所有站」查（codex 破解）：text=/<DSP>.TI2/ 一個請求撈該區所有機場、從每一台收到的站
//   → 哪台站（含英國/IRDM/任何站）剛好收到現行那則都涵蓋，比「只查固定幾台衛星站」完整很多（實證 RJAA 現行 letter 是英國站 SS-EGBB 收到的，固定站查法漏掉）。
//   DSP→機場是穩定對應（從 feed 撈出 48 個，這裡放亞洲+主要全球；env ATIS_DSP_PREFIXES 可調）。仍用發布時刻挑現行、塞同一累積庫。
const _AF_DSP_PREFIXES: string[] = (process.env.ATIS_DSP_PREFIXES
  || 'FUKDLYA,TPECAYA,HKGATYA,ICNDLXA,SELATYA,SINCAYA,BJSATYA,BOMCDYA,HANATXA,ATSLYXA,AUHADYA,DOHATYA,JEDATYA,LONATXA,CDGATYA,MADAAYA,ATISAXS,ISTATYA')
  .split(',').map((s) => s.trim()).filter(Boolean);
async function _atisFetchRoutingFeed(): Promise<number> {
  const byApt = new Map<string, any[]>();
  for (const dsp of _AF_DSP_PREFIXES) {
    if (!_afAllow(1)) break;   // 額度不足 → 停，保留 bucket 給 /api/atis 與其他輪詢（不一次燒光，codex P2）
    let arr: any[] = [];
    try {
      // ⚠ 一定要 labels=A9：DSP 前綴在忙場(LONATXA/TPECAYA)會混進非 ATIS 流量、把現行 ATIS 擠出 100 視窗 → _atisPickKind 撈不到(codex P1)
      const url = 'https://api.airframes.io/messages?text=' + encodeURIComponent('/' + dsp + '.TI2/') + '&labels=A9&timeframe=last-2-hours';
      const r = await fetch(url, { headers: { 'User-Agent': _FIDS_UA } });
      if (!r.ok) continue;   // 間歇 404 → 跳過這前綴、下一輪(60s)再補；不重試，避免燒爆共用 bucket(codex P2)
      const a = await r.json() as any;
      arr = Array.isArray(a) ? a : ((a && (a.messages || a.data || a.results || a.items)) || []);
    } catch { continue; }
    for (const m of arr) {
      if (!m) continue;
      m.text = String(m.text || m.message || '');
      const mt = m.text.match(/\b([A-Z]{4})\s+(?:ARR|DEP)?\s*ATIS/);
      if (!mt) continue;
      const ic = mt[1];
      if (ic[0] === 'K' || ic[0] === 'P') continue;   // 美國/太平洋 → 官方 FAA
      let list = byApt.get(ic); if (!list) { list = []; byApt.set(ic, list); }
      list.push(m);
    }
  }
  let updates = 0;
  for (const [ic, msgs] of byApt) {
    for (const kind of ['ARR', 'DEP', 'ATIS'] as const) {
      const p = _atisPickKind(msgs, kind, ic);
      if (p && typeof p.issueAt === 'number' && _atisStoreMerge(ic, kind, p)) { _atisStorePersist(ic, kind); updates++; }
    }
  }
  return updates;
}

// 美國 D-ATIS：官方 FAA 源（經 atis.info，CORS*、免 key、免額度）。只有有 D-ATIS 的大場才有（關島等小場沒有 → 404）。
async function _atisFetchUsFaa(icao: string) {
  const r = await fetch('https://atis.info/api/' + icao);
  if (!r.ok) return null;   // 404 = 該場沒 D-ATIS → 上層往下退 airframes/備案
  const a = await r.json() as any[];
  if (!Array.isArray(a) || !a.length) return null;
  return a.map((o: any) => {
    const t = String(o.type || '').toLowerCase();
    const title = t === 'arr' ? 'ARR ATIS' : t === 'dep' ? 'DEP ATIS' : 'ATIS';
    // 來源固定標 FAA（官方）；atis.info 的 time 是 HHMM（無日期）→ 格式化成 "1556Z"，沒有就留空（只顯示 Source: FAA）
    const z = String(o.time || '').trim();
    const time = /^\d{3,4}$/.test(z) ? z.padStart(4, '0') + 'Z' : '';
    return { title, text: String(o.datis || '').trim(), src: 'FAA', time };
  }).filter((s: any) => s.text);
}

// ── ATIS 累積庫 + 背景輪詢（V9.4.22：追平 coffee 新鮮度）──────────────────────────
// 為何要這套：airframes 即時搜尋只回最近 ~100 則，新 ATIS 幾分鐘就滾出視窗、即時查撈不到（實證翻 5 頁 500 筆都撈不到 4hr 前那筆）。
// coffee 之所以比較新，就是「頻繁輪詢 + 把每站每類最新有效 ATIS 存起來 hold 住」。我們照做：背景輪詢→存庫→/api/atis 先吃庫。
type AtisEntry = { text: string; src: string; issueAt: number; receivedAt: number; hash: string; updatedAt: number };
const _atisStore = new Map<string, { ARR?: AtisEntry; DEP?: AtisEntry; ATIS?: AtisEntry }>();   // key=ICAO；ATIS=合併場（歐洲等）。記憶體鏡像，背景輪詢維護、重啟從 DB 載回
function _atisHash(s: string): string {   // djb2，給「同發布時刻但內文改了（修正版 ATIS）」判斷用
  let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
// 併入庫：只在「更新」時覆蓋（發布較新 / 同發布但更完整 / 一樣完整但收到較新 / 內文改了）；回傳是否有實際更新。
function _atisStoreMerge(icao: string, kind: 'ARR' | 'DEP' | 'ATIS', p: { text: string; src: string; issueAt: number; receivedAt: number; hash: string }): boolean {
  const cur = _atisStore.get(icao) || {};
  const old = cur[kind];
  let newer: boolean;
  if (!old || p.issueAt > old.issueAt) newer = true;                  // 發布較新 → 一定取代
  else if (p.issueAt === old.issueAt) {
    // 同發布時刻：完整(有 QNH)永遠勝過截斷(無 QNH)，半截不准蓋完整、收到較晚的半截也不行（V9.4.37 前綴法在此破功）；
    //   同樣完整度 → 收到較新/內文有變才取代（修正版 + 刷新顯示時間，不誤殺合法短修正）。
    const pFull = _atisHasQNH(p.text), oFull = _atisHasQNH(old.text);
    if (pFull !== oFull) newer = pFull;                                          // 完整(有 QNH)勝截斷
    else {
      const pLen = _atisBodyLen(p.text), oLen = _atisBodyLen(old.text);          // 比「乾淨body長度」(去尾碼/空白) → 去尾碼後的乾淨版不會被舊的含尾碼版擋掉
      if (pLen !== oLen) newer = pLen > oLen;                                     // 同完整度 → 最完整(乾淨最長)勝，QNH 後被截的 frag 不准蓋完整版（codex）
      else newer = p.receivedAt > old.receivedAt || (p.receivedAt === old.receivedAt && p.hash !== old.hash);   // 乾淨長度相同 → 收到較新/內文有變才更新（刷新時間、同筆重收）
    }
  } else newer = false;
  if (!newer) { if (old) old.updatedAt = Date.now(); return false; }   // 沒更新（同一筆又看到）→ 不動 receivedAt（保「首見時間」，跟 coffee 一致）
  cur[kind] = { text: p.text, src: p.src, issueAt: p.issueAt, receivedAt: p.receivedAt, hash: p.hash, updatedAt: Date.now() };
  _atisStore.set(icao, cur);
  return true;
}
function _atisStorePersist(icao: string, kind: 'ARR' | 'DEP' | 'ATIS') {   // 寫回 DB（只在有更新時呼叫 → 寫入量很小）
  if (!_pool) return;
  const v = _atisStore.get(icao) && _atisStore.get(icao)![kind]; if (!v) return;
  _pool.query(
    `INSERT INTO cs_atis_store (airport,kind,issue_at,received_at,text,src,text_hash,updated_at)
     VALUES ($1,$2,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,$7,NOW())
     ON CONFLICT (airport,kind) DO UPDATE SET issue_at=EXCLUDED.issue_at, received_at=EXCLUDED.received_at,
       text=EXCLUDED.text, src=EXCLUDED.src, text_hash=EXCLUDED.text_hash, updated_at=NOW()`,
    [icao, kind, v.issueAt, v.receivedAt, v.text, v.src, v.hash]
  ).catch(() => { /* 寫 DB 失敗不影響記憶體服務 */ });
}
// 從庫取某站的 ARR/DEP 段落（服務用形狀）；太舊（>18h）不當現行。time 顯示「收到時間」與 coffee 一致。
// ⚠ 不濾「NOT AVAILABLE」：那是合法宵禁狀態（RJAA 等夜間無航班→無 D-ATIS），照實顯示。
function _atisStoreSections(icao: string): { title: string; text: string; src: string; time: string }[] | null {
  const e = _atisStore.get(icao); if (!e) return null;
  const now = Date.now(); const out: { title: string; text: string; src: string; time: string }[] = [];
  for (const kind of ['ARR', 'DEP', 'ATIS'] as const) {
    const v = e[kind]; if (!v) continue;
    if (!_atisTextIsKind(v.text, icao, kind)) continue;   // 自癒：庫裡若是舊版誤存的非 ATIS（如 OFP）→ 不端出來給飛行員
    if (now - v.issueAt > 36 * 3600000) continue;   // 超過 36hr 才不顯示（放寬到容許隔夜舊資料：使用者寧可看舊的、也不要空白）
    // time 顯示「真實發布時刻 issueAt」(不是收到時間 receivedAt) → 舊資料誠實標舊，不再「昨天的卻標今天下午收到」的誤導。
    out.push({ title: kind === 'ATIS' ? 'ATIS' : kind + ' ATIS', text: v.text, src: v.src, time: _atisFmtTime(new Date(v.receivedAt).toISOString()) });
  }
  return out.length ? out : null;
}
async function _atisStoreLoad() {   // 開機從 DB 載回累積庫 → Render 重啟/部署不歸零（跟 coffee 一樣留得住）
  if (!_pool) return;
  try {
    const rr = await _pool.query(
      `SELECT airport, kind, EXTRACT(EPOCH FROM issue_at)*1000 AS issue_ms,
              EXTRACT(EPOCH FROM received_at)*1000 AS recv_ms, text, src, text_hash FROM cs_atis_store`);
    const healed: [string, 'ARR' | 'DEP' | 'ATIS'][] = [];
    for (const r of rr.rows) {
      if (!r.text || (r.kind !== 'ARR' && r.kind !== 'DEP' && r.kind !== 'ATIS')) continue;
      if (!_atisTextIsKind(r.text, r.airport, r.kind as 'ARR' | 'DEP' | 'ATIS')) continue;   // 自癒：DB 舊版誤存的非 ATIS（OFP 等）→ 不載回記憶體；之後真 ATIS 進來會 upsert 蓋掉那筆
      const cur = _atisStore.get(r.airport) || {};
      const entry = { text: r.text, src: r.src || '', issueAt: Number(r.issue_ms) || 0, receivedAt: Number(r.recv_ms) || 0, hash: r.text_hash || '', updatedAt: Date.now() };
      // self-heal：用最新 realIssueAt 重算 DB 載回的 issueAt → 修正舊版「NA 回放被算成收到時間」的污染筆（否則現行字母蓋不過、庫卡死，RJAA 2026-06-12 踩過）
      if (entry.receivedAt > 0) {
        const fixed = _atisRealIssueAt({ text: entry.text, timestamp: new Date(entry.receivedAt).toISOString() });
        if (fixed > 0 && Math.abs(fixed - entry.issueAt) > 60000) { entry.issueAt = fixed; healed.push([r.airport, r.kind]); }
      }
      cur[r.kind as 'ARR' | 'DEP' | 'ATIS'] = entry;
      _atisStore.set(r.airport, cur);
    }
    console.log('[ATIS] store loaded:', _atisStore.size, 'airports' + (healed.length ? ' (self-healed ' + healed.length + ' issueAt)' : ''));
    for (const [ap, k] of healed) _atisStorePersist(ap, k);   // 把校正後的 issueAt 寫回 DB（只有被修的少數筆，量很小）
  } catch { /* 載入失敗不擋啟動，走即時查保底 */ }
}
// 背景輪詢：快層（台灣+主要 hub 7 站，~90s 全掃，deep=廣查+缺項精準查雙管）、慢層（其餘非美國 WX 站，連續慢掃 ~5 分一圈，只廣查）。
// 雙管比只用精準查更不會漏（codex 指正：當下 ATIS 可能只在廣查露臉）；但只給重點站雙管、其餘廣查，免得 60 站全觸發精準查吃爆額度（codex review）。
// ⚠ 額度安全（實測確認）：airframes 匿名源「只有 60/分、每 60 秒重置、無每日上限」（舊 500/天是已退役的 keyed API，別被舊註解誤導）。
//   輪詢穩態遠低於 60/分桶；/api/atis 走「庫優先」、使用者幾乎不打 airframes → 背景輪詢不會餓死即時查、也沒有每日額度可被燒完。
//   ⚠ 刻意不做「連續沒撈到就降頻」：那會對「正好一直撈不到的問題站(RJAA/RJTT)」幫倒忙——越該勤勞接、反而越懶（codex 指正）。額度夠，全部站每圈都認真輪。
const _ATIS_FAST = ['RCTP', 'RJAA', 'RJBB', 'RJCC', 'VHHH', 'WSSS', 'VTBS'];   // 使用者指定常飛重點站（桃園/成田/關西/新千歲/香港/樟宜/曼谷）→ 快層雙管；其餘 WX 站走慢層廣查
let _atisPollStarted = false;
const _atisSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function _atisPollOne(icao: string, deep: boolean) {
  if (!_afAllow(1)) return;   // 額度不足（使用者即時查在用）→ 讓出，下一圈再補（broad query 先佔 1；缺項精準查在 _atisFetchAirframes 內自行再佔）
  try {
    // deep（快層 7 站）→ 廣查+缺項精準查雙管，接到機率最高；非 deep（慢層 ~53 小場）→ 只廣查 1 次省額度
    //   （codex：別整批 60 站都觸發精準查，會把 2-3 倍流量塞進 60/分桶。重點站雙管、其餘廣查，兩全。）
    const sections = await _atisFetchAirframes(icao, !deep) as any[] | null;
    if (!sections) return;
    for (const s of sections) {
      const kind = s.title === 'DEP ATIS' ? 'DEP' : s.title === 'ARR ATIS' ? 'ARR' : s.title === 'ATIS' ? 'ATIS' : null;
      if (kind && typeof s.issueAt === 'number' && _atisStoreMerge(icao, kind, s)) _atisStorePersist(icao, kind);
    }
  } catch { /* 單站失敗略過，不中斷整圈 */ }
}
function _atisStartPoller() {
  if (_atisPollStarted || !_pool) return;   // 沒 DB → 不啟動（無處存）；/api/atis 自動退即時查
  _atisPollStarted = true;
  let all: string[] = [];
  try { all = [...new Set([...getSpaAirportDataJs().matchAll(/icao:'([A-Z]{4})'/g)].map((m) => m[1]))]; } catch { /* 解析失敗就只輪快層 */ }
  const nonUs = all.filter((ic) => ic[0] !== 'K' && ic[0] !== 'P');   // 美國/太平洋走官方 FAA、不輪詢 airframes
  const fast = _ATIS_FAST.filter((ic) => nonUs.length === 0 || nonUs.includes(ic));
  const slow = nonUs.filter((ic) => !fast.includes(ic));
  console.log('[ATIS] poller start: fast', fast.length, 'slow', slow.length);
  // 衛星站健康檢查：每 30 分偵測哪些衛星站此刻活躍（有回 A9）→ 自動避開掛站、補上活站
  setInterval(() => { _atisSatHealthCheck().catch(() => { }); }, 30 * 60000);
  setTimeout(() => { _atisSatHealthCheck().catch(() => { }); }, 500);   // 開機先測一次
  // 衛星站整串 A9：每站分開查、各吃 100、合併進庫 → 涵蓋多波束幾十場、比 text= 新 → 每 60s 跑一次（當主力）
  const runStationFeed = async () => { try { const n = await _atisFetchStationFeed(); if (n) console.log('[ATIS] station-feed updates', n); } catch { /* 失敗就靠下面逐站輪詢保底 */ } };
  setInterval(() => { runStationFeed(); }, 60000);
  setTimeout(() => { runStationFeed(); }, 3000);   // 開機 3s 先跑一次（等健康檢查先更新活躍站）
  // 路由前綴跨全站查（codex 破解，主力升級）：哪台站收到現行 ATIS 都涵蓋 → 追平機率大增 → 每 60s 跑一次（_afAllow 自我節流，額度不足自動跳過）
  const runRoutingFeed = async () => { try { const n = await _atisFetchRoutingFeed(); if (n) console.log('[ATIS] routing-feed updates', n); } catch { /* 失敗靠 station-feed / 逐站輪詢保底 */ } };
  setInterval(() => { runRoutingFeed(); }, 60000);
  setTimeout(() => { runRoutingFeed(); }, 6000);   // 開機 6s 先跑一次（錯開 station-feed）
  const runFast = async () => { for (const ic of fast) { await _atisPollOne(ic, true); await _atisSleep(800); } };   // 快層 deep（雙管，補衛星站沒覆蓋到的場）
  setInterval(() => { runFast().catch(() => { }); }, 90000);   // 快層每 90s
  // coffee 主源（站長授權）：重點站逐站輪（爬蟲型 5-20s/站，逐站不並發、不壓站長）；最新的 merge 自動勝過 airframes。
  let _coffeeBusy = false;
  const runCoffee = async () => {
    if (_coffeeBusy) return;   // 上一輪還沒跑完 → 跳過，不疊（單站可能拖到 20s）
    _coffeeBusy = true;
    try { for (const ic of fast) { try { await _coffeePull(ic); } catch { /* 單站失敗略過 */ } await _atisSleep(600); } } finally { _coffeeBusy = false; }
  };
  setInterval(() => { runCoffee(); }, 15 * 60000);   // 主源每 15 分鐘輪一圈重點站（ATIS ~30 分才換、手動刷新可即時拉 → 不用更勤、尊重站長爬蟲）
  setTimeout(() => { runCoffee(); }, 1500);          // 開機就先跑（主源優先於 airframes）
  if (slow.length) {   // 慢層：連續慢掃，整圈 ~5 分（每站間隔 = 300000/站數，最少 2s），只廣查省額度
    let si = 0;
    const gap = Math.max(2000, Math.floor(300000 / slow.length));
    setInterval(() => { _atisPollOne(slow[si++ % slow.length], false).catch(() => { }); }, gap);
  }
  setTimeout(() => { runFast().catch(() => { }); }, 3000);   // 開機 3s 先跑一輪快層，不等第一個 90s
}

// ── ATIS 即時 feed：airframes 全量 socket.io firehose（wss://ws.airframes.io，免 key、送空 token 即連）──
//   REST 搜尋只索引一部分（忙場/衛星 ATIS 會滾出視窗 → RJAA DEP 卡舊）；live feed 是「全部」，邊收邊濾 A9 邊累積。
//   這就是 coffee 的真正機制（站長講了 A9 label、沒講這條 feed）：吃整片 firehose、只撈 A9、塞進同一套累積庫。
//   負擔：只是「收→看 label→丟」，A9 超稀疏（實測 243 筆/35s 才 1 筆 ATIS），CPU/記憶體極輕；inbound Render 不計費。
let _atisLiveStarted = false;
function _atisStartLiveFeed() {
  if (_atisLiveStarted) return;   // 不限 DB：記憶體庫(_atisStoreMerge)沒 DB 也能跑、即時服務照樣鮮；_atisStorePersist 自身有 !_pool 守衛、沒 DB 就跳過落地
  _atisLiveStarted = true;
  let lastLog = 0, a9seen = 0, updates = 0;
  const sock = _ioClient('https://ws.airframes.io', {
    transports: ['websocket'],
    auth: { token: '' },
    reconnection: true, reconnectionDelay: 3000, reconnectionDelayMax: 30000,
  });
  sock.on('connect', () => console.log('[ATIS] live feed connected', sock.id));
  sock.on('disconnect', (r: any) => console.log('[ATIS] live feed disconnect:', r));
  sock.on('connect_error', () => { /* 自動重連，不洗 log */ });
  sock.on('message', (m: any) => {
    try {
      const wrap = (m && m.acars && typeof m.acars === 'object') ? m.acars : null;   // 有些 socket payload 把內容包在 m.acars
      const label = (m && m.label) || (wrap && wrap.label) || '';
      if (label !== 'A9') return;   // 只要 ATIS 那層，其餘 firehose 直接丟
      const base = wrap ? { ...m, ...wrap } : m;   // 只有 A9 才攤平（text/timestamp/flight 都升到頂層給 _atisPickKind 用）；firehose 其餘不付這成本
      const text = String(base.text || '');
      if (!text) return;
      // 認機場 + 種類（ARR/DEP/合併 ATIS）
      let icao = '', kind: 'ARR' | 'DEP' | 'ATIS' | '' = '';
      const ad = text.match(/\b([A-Z]{4})\s+(ARR|DEP)\s+ATIS\b/);
      if (ad) { icao = ad[1]; kind = ad[2] as 'ARR' | 'DEP'; }
      else { const cb = text.match(/\b([A-Z]{4})\s+ATIS\b/); if (cb) { icao = cb[1]; kind = 'ATIS'; } }   // 合併 ATIS（含無字母碼的 NOT AVAILABLE）；ARR/DEP 已先在上面攔掉
      if (!icao || !kind) return;
      if (icao[0] === 'K' || icao[0] === 'P') return;   // 美國/太平洋走官方 FAA，不收進 acars 庫
      a9seen++;
      const p = _atisPickKind([base], kind, icao);   // 沿用 REST 那套解析（realIssueAt/src/hash），單筆也適用
      if (p && typeof p.issueAt === 'number' && _atisStoreMerge(icao, kind, p)) { _atisStorePersist(icao, kind); updates++; }
      const now = Date.now();
      if (now - lastLog > 600000) { console.log('[ATIS] live feed: A9 seen', a9seen, 'store updates', updates); lastLog = now; }
    } catch { /* 單筆壞訊息略過，不中斷 feed */ }
  });
}

app.get('/api/atis', async (req, res) => {
  const icao = String(req.query.icao || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) return res.status(400).json({ error: 'bad icao' });
  const fresh = req.query.fresh === '1';
  const bulk = req.query.bulk === '1';
  // 1. 美國機場（K/P 開頭）→ 官方 FAA 源 atis.info 為「權威主源」（免費、CORS*、不佔 airframes）。FAA 沒有(關島等)或掛 → 往下退 airframes。
  if (icao[0] === 'K' || icao[0] === 'P') {
    if (!fresh) {
      const c = _atisCache.get(icao);
      if (c && Date.now() - c.time < ATIS_TTL) return res.json({ sections: c.sections, source: c.source, cached: true });
    }
    let us: { title: string; text: string; src?: string; time?: string }[] | null = null;
    try { us = await _atisFetchUsFaa(icao); } catch (e: any) { /* atis.info 掛 → 退 airframes */ }
    if (us && us.length) {
      _atisCache.set(icao, { sections: us, time: Date.now(), source: 'faa' });
      return res.json({ sections: us, source: 'faa' });
    }
  }
  // 1.5 非美 ATIS（站長爬出來的資料）→ 只開放給「同步過班表」的真組員（或站方）。北美 K/P 走 FAA 公開源不鎖。
  if (icao[0] !== 'K' && icao[0] !== 'P') {
    if (!(await _atisGateOk(String(req.headers['x-pl-at'] || ''), String(req.headers['x-cs-idt'] || '')))) {
      return res.status(403).json({ error: 'not_verified', locked: true });
    }
  }
  // 2. fresh=1 且單機場（手動刷新）→ 立刻輪詢這站刷新累積庫，再走庫。
  //    merge 只「升級」（發布較新才覆蓋），所以這次即時查就算撈到較舊的，也不會蓋掉累積庫裡較新的那筆（codex P1：fresh 要能刷新，但不能退化）。
  //    區域一鍵刷新(bulk)不在此即時打：那批由背景輪詢維護的庫已夠新，避免一次噴一堆 airframes。
  if (fresh && !bulk) {
    // coffee 主源先撈（手動一律打、不看冷卻，並更新冷卻時間）；只有「真的拉到更新的」才算數，否則仍退 airframes 保底，
    //   避免「coffee 回了但不比庫新 → 跳過 airframes → 刷新卻沒真的更新」(codex 前一輪 P1)。merge 只升級，多打 airframes 也不會退化。
    let improved = false;
    if (icao[0] !== 'K' && icao[0] !== 'P') improved = await _coffeePull(icao);   // 非美 → coffee 主源（美國到這代表 FAA 已失敗 → 走 airframes）
    if (!improved) { try { await _atisPollOne(icao, true); } catch { /* 刷新失敗就用庫裡現有的 */ } }
  }
  // 2.5 非美、非手動：開場聰明撈 coffee（主源）。庫 15 分內撈過 → 直接給、不重複打他；
  //     有舊的 → 秒回舊的 + 背景撈最新暖庫（不卡使用者，下次就新）；從沒撈過 → 等一次(5-20s)拿真資料、不給空白。
  if (!fresh && !bulk && icao[0] !== 'K' && icao[0] !== 'P' && !_coffeeFresh(icao)) {
    const st0 = _atisStoreSections(icao);
    // 「完整」＝每段都有 QNH（天氣/氣壓那後半段在），或是「NOT AVAILABLE」這種合法宵禁/夜間短狀態（本來就沒 QNH，別逼它等 coffee，codex P2）。
    //   香港等場 airframes 常只給到前一個 frame（半截、缺 QNH 又不是 NA）→ 這種別當「有舊的」秒回半截給飛行員，要等一次 coffee 拿完整版。
    const complete = Array.isArray(st0) && st0.length > 0 && st0.every((s: any) => {
      const t = String((s && s.text) || '');
      return _atisHasQNH(t) || /NOT\s+AVAIL|UNAVAILABLE|NO\s+ATIS|NO\s+DATA/i.test(t);
    });
    if (complete) { _coffeePull(icao); }                                       // 有完整舊的 → 背景撈，不擋回應
    else { try { await _coffeePull(icao); } catch { /* 撈不到 → 往下走 airframes 保底 */ } }   // 沒有/半截 → 等一次拿完整
  }
  // 3. 非美：先吃背景累積庫（輪詢維護，最新鮮、跟 coffee 同機制）→ 命中直接回，不打 airframes。
  const stored = _atisStoreSections(icao);
  if (stored) return res.json({ sections: stored, source: 'acars' });
  // 4. 庫裡還沒有（冷啟未及輪、非 WX 清單機場、或無 DB 部署）→ 先看 60 分快取（無 DB／輪詢未啟動時靠這層省額度，codex P1），再即時撈保底。
  if (!fresh) {
    const c = _atisCache.get(icao);
    if (c && Date.now() - c.time < ATIS_TTL) return res.json({ sections: c.sections, source: c.source, cached: true });
  }
  if (!_afAllow(1)) return res.json({ fallback: true });   // bucket 不足 → 退前端 fallback(atis.guru)
  try {
    const sections = await _atisFetchAirframes(icao, bulk) as any[];
    if (!sections) return res.json({ fallback: true });
    for (const s of sections) {   // 即時撈到的也存庫，下次就走庫
      const kind = s.title === 'DEP ATIS' ? 'DEP' : s.title === 'ARR ATIS' ? 'ARR' : s.title === 'ATIS' ? 'ATIS' : null;
      if (kind && typeof s.issueAt === 'number' && _atisStoreMerge(icao, kind, s)) _atisStorePersist(icao, kind);
    }
    const clean = sections.map((s) => ({ title: s.title, text: s.text, src: s.src, time: s.time }));
    _atisCache.set(icao, { sections: clean, time: Date.now(), source: 'acars' });   // 設快取（無 DB 部署靠它避免重打）
    return res.json({ sections: clean, source: 'acars' });
  } catch (e: any) {
    return res.json({ fallback: true });
  }
});

// 只回「目前帳號身份」(owner/founder/none),不抓任何 ATIS、不扣額度。前端用來決定要不要顯示「換來源」鈕(綁當前帳號,免跨帳號繼承)。
app.get('/api/atis-level', async (req, res) => {
  const auth = await _atisAuthLevel(String(req.headers['x-pl-at'] || ''), String(req.headers['x-cs-idt'] || ''));
  res.json({ level: auth.level });
});

// Tower 後台讀「今日 airframes 用量」（owner 池 / founder 池）。只給 owner。
app.get('/api/atis-usage', requireAuth, async (req: AuthedRequest, res) => {
  if (!(await isOwnerUserId(req.pilotUserId || ''))) return res.status(403).json({ error: 'not_owner' });
  const usage: any = getAtisUsage();
  usage.who = [];
  // 今日誰用 + 歷史（保留全部、給 ATIS 分頁看）：一律從 DB 撈，跟計數一致（codex P2）。
  if (_pool) {
    try {
      const day = new Date().toISOString().slice(0, 10);
      // 今日：誰、查了哪個機場、幾次（前端依 who 分組顯示）
      const today = await _pool.query(
        `SELECT who, icao, cnt AS count, last_at AS last FROM cs_atis_who WHERE day=$1 ORDER BY who, cnt DESC`, [day]);
      usage.who = today.rows;
      usage.todayUsers = new Set(today.rows.map((r: any) => r.who)).size;   // 今日不重複人數(卡片用)
      // 歷史：每人累計、每人每機場累計、每日總量、各機場熱度
      const byUser = await _pool.query(
        `SELECT who, SUM(cnt)::int AS total, MAX(last_at) AS last FROM cs_atis_who GROUP BY who ORDER BY total DESC LIMIT 100`);
      const byUserAirport = await _pool.query(
        `SELECT who, icao, SUM(cnt)::int AS total FROM cs_atis_who WHERE icao <> '' GROUP BY who, icao ORDER BY who, total DESC`);
      const byDay = await _pool.query(
        `SELECT day, SUM(cnt)::int AS total, COUNT(DISTINCT who)::int AS users FROM cs_atis_who GROUP BY day ORDER BY day DESC LIMIT 60`);
      const byAirport = await _pool.query(
        `SELECT icao, SUM(cnt)::int AS total FROM cs_atis_who WHERE icao <> '' GROUP BY icao ORDER BY total DESC LIMIT 100`);
      usage.history = { byUser: byUser.rows, byUserAirport: byUserAirport.rows, byDay: byDay.rows, byAirport: byAirport.rows };
    } catch { usage.history = { byUser: [], byDay: [] }; }
  }
  res.json(usage);
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
// 預快取:入口 /apps + 今日 /morning。morning 自己的 SW scope 是 '/morning/'、管不到啟動頁 '/morning'(codex P2)→ 由 root SW(scope '/')預存+服務它離線。
// /pilot-log 不放這:它自己的 SW(scope '/pilot-log')涵蓋得到、會自己預存,放這反而重複(更精確的 scope 會贏)。
// ⚠ 不放 '/':它 302 轉址到 /main，fetch 拿到的是 redirected response，cache.put 會丟錯 → 整個 Promise.all 掛掉 → install 失敗 → 三個 app 全卡「準備離線中」。離線啟動用 /main，'/'用不到。
const SHELL = ['/main', '/share', '/apps', '/morning'];
self.addEventListener('install', e => {
  e.waitUntil(
    // 每個 url 各自 catch：任一個抓失敗(冷啟/網路/轉址)都不拖垮其他，能存多少先存多少（離線就緒不被單點失敗卡死）。
    caches.open(CACHE).then(c => Promise.all(SHELL.map(url =>
      fetch(url, {cache:'no-store'}).then(r => { if (r && r.ok && !r.redirected) return c.put(url, r); }).catch(()=>{})
    )))
  );
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  // ⚠ 只刪「自己的舊 crewsync 快取」(版本汰換)，絕不碰別 app 的(pilotlog-*/morning-*)或 plapt-maps/plcdn —— 否則 /apps 一次叫醒三個 SW 時會把剛預存好的子 app 快取砍掉(codex P1)。
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k.indexOf('crewsync-')===0 && k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
const _offlinePage = '<html><body style="background:#111;color:#aaa;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Offline</h2><p>Please connect to the internet and reload.</p></div></body></html>';
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/')) return;
  // ATIS 走瀏覽器端代理(allorigins)抓 atis.guru：時效性資料 + 跨域 GET，不可快取（否則 SW 會存成舊的、且 cache 一直長）→ 直接走網路。
  if (u.hostname === 'api.allorigins.win' || u.hostname === 'atis.guru') return;
  // 衛星圖（Esri）→ 永久快取 plapt-maps（stale-while-revalidate）：跟 Pilot Log 用同一個 cache + 同網址。
  // 有快取「先秒出」（看不到空白、離線也行），同時背景重抓更新 → 萬一舊版存進壞圖磚（opaque 分不出好壞），
  // 下次背景重抓會蓋掉自我痊癒（codex P1：activate 保留 plapt-maps，純 cache-first 會讓壞快取永遠卡住）。
  // 圖磚有 HTTP 快取標頭，背景重抓多半走瀏覽器 HTTP 快取、不真的吃網路；離線時 fetch 失敗就退回 hit。
  if (u.hostname === 'server.arcgisonline.com') {
    e.respondWith(caches.open('plapt-maps').then(c => c.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(e.request, r.clone()).catch(()=>{}); return r; }).catch(() => hit);
      if (hit) e.waitUntil(net);  // 命中先回 hit，但用 waitUntil 撐住背景重抓+寫快取，否則 SW 可能被提前關掉、痊癒失效（codex P2）
      return hit || net;
    })));
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
// 外站(非桃園)資料來源 → 正規化成「前端最終 row 格式」，桌子(表格)不變、只換資料。
const _FIDS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 北海道機場公司統一 API：免 key 靜態 JSON、含 GateNo。slug=API 代號、code/name=顯示。
const _FIDS_PORTS: Record<string, { slug: string; code: string; name: string; tz: number }> = {
  cts: { slug: 'new-chitose', code: 'CTS', name: '新千歲', tz: 9 },  // 北海道 UTC+9
  hkd: { slug: 'hakodate', code: 'HKD', name: '函館', tz: 9 }
};
// 任意時區的「當地日期」字串（offsetHours=該地 UTC 偏移；dayShift 天位移）
function _localDateStr(offsetHours: number, dayShift = 0): string {
  const d = new Date(Date.now() + offsetHours * 3600 * 1000 + dayShift * 86400 * 1000);
  return d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0');
}
// 部分場站航班號用 ICAO 三字碼(TTW/JAL)，統一轉成 IATA 兩字碼(IT/JL)，比照桃園
const _ICAO2IATA: Record<string, string> = {
  TTW: 'IT', EVA: 'BR', CAL: 'CI', SJX: 'JX', UIA: 'B7', MDA: 'AE', CPA: 'CX', CRK: 'HX',
  JAL: 'JL', ANA: 'NH', ADO: 'HD', JJP: 'GK', APJ: 'MM', SKY: 'BC', SNJ: '6J', FDA: 'JH',
  AAR: 'OZ', JJA: '7C', JNA: 'LJ', ESR: 'ZE', ABL: 'BX', KAL: 'KE', CES: 'MU', CSN: 'CZ',
  CQH: '9C', DKH: 'HO', CHH: 'HU', CSZ: 'ZH'
};
function _hkdFno(flight: any): string {
  const f = String(flight || '').replace(/\s/g, '');
  const m = f.match(/^([A-Za-z]{2,3})(\d.*)$/);
  if (!m) return f;
  const pre = m[1].toUpperCase();
  return (pre.length === 3 && _ICAO2IATA[pre]) ? _ICAO2IATA[pre] + m[2] : f;
}
function _twDateStr(offsetDays = 0): string { return _localDateStr(8, offsetDays); }
// 一筆北海道航班 → 桃園同款 row（沒有的欄位留空字串，前端顯示「—」）
function _hkdRow(f: any, port: { code: string; name: string }): any | null {
  const airs: any[] = Array.isArray(f.Airline) ? f.Airline : [];
  const op = airs.find(a => a && a.SharingfltDiv === 0) || airs[0];
  if (!op) return null;
  const rawFno = String(op.Flight || '').replace(/\s/g, '').toUpperCase();
  const fno = _hkdFno(op.Flight);
  if (!fno) return null;
  const altFno = (rawFno && rawFno !== fno.toUpperCase()) ? rawFno : '';
  const otherCode = op.AreaCode || '';
  const otherName = op.AreaName || op.AreaTranName || otherCode || '';
  const gate = (f.GateNo == null ? '' : String(f.GateNo)).trim();
  const st = (f.ST == null ? '' : String(f.ST)).trim();
  const et = (f.ET_AT == null ? '' : String(f.ET_AT)).trim();
  const base = { fno, altFno, checkin: '', depTerminal: '', arrTerminal: '', carousel: '' };
  if (f.DA === 'D') {
    // 出發：本站 → 對方站；gate/std/atd 有值
    return { ...base, origin: port.code, originCode: port.code, originName: port.name,
      dest: otherCode, destCode: otherCode, destName: otherName,
      gate, std: st, atd: et, sta: '', ata: '', parking: '' };
  }
  // 到達：對方站 → 本站；比照桃園，到達 gate 放 parking 欄；sta/ata 有值
  return { ...base, origin: otherCode, originCode: otherCode, originName: otherName,
    dest: port.code, destCode: port.code, destName: port.name,
    gate: '', std: '', atd: '', sta: st, ata: et, parking: gate };
}
async function _fidsOutstation(port: { slug: string; code: string; name: string; tz: number }, reqDate: string, res: any) {
  try {
    // 北海道只有 today / yesterday 兩檔。用「機場當地時區」(port.tz, 北海道 UTC+9)判日期，
    // 避免台北(UTC+8) 23:00-24:00 那一小時機場已跨日卻還給到前一天的板。
    const apToday = _localDateStr(port.tz, 0), apYest = _localDateStr(port.tz, -1);
    const twToday = _twDateStr(0), twYest = _twDateStr(-1);
    let when = '';
    // 「今天」視角(前端送台北今天 / 機場今天 / 空) → 一律給機場當前的 today.json
    if (!reqDate || reqDate === twToday || reqDate === apToday) when = 'today';
    else if (reqDate === twYest || reqDate === apYest) when = 'yesterday';
    if (!when) { res.json({ rows: [], date: reqDate || apToday, airport: port.code }); return; }
    // 回傳「機場當地日期」當 label：服務的是 today.json/yesterday.json，標籤要跟著機場的日子走
    const respDate = (when === 'today') ? apToday : apYest;
    const base = `https://www.hokkaido-airports.com/api/v1/${port.slug}/static/fis`;
    const getJ = async (u: string) => { const r = await fetch(u, { headers: { 'User-Agent': _FIDS_UA } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
    const [intlR, domR] = await Promise.allSettled([
      getJ(`${base}/international/${when}.json`),
      getJ(`${base}/domestic/${when}.json`)
    ]);
    // 兩支 feed 都掛才當上游故障(比照桃園 dep/arr 都失敗才 502)；一支活就給資料
    if (intlR.status === 'rejected' && domR.status === 'rejected') {
      console.error('FIDS outstation upstream error:', port.code, (intlR.reason || {}).message, (domR.reason || {}).message);
      res.status(502).json({ error: 'upstream unavailable' });
      return;
    }
    const _items = (d: any): any[] => Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : []);
    const intl = intlR.status === 'fulfilled' ? intlR.value : [];
    const dom = domR.status === 'fulfilled' ? domR.value : [];
    const flat = [..._items(intl), ..._items(dom)];
    const rows = flat.map(f => _hkdRow(f, port)).filter(Boolean);
    res.json({ rows, date: respDate, airport: port.code });
  } catch (e: any) {
    console.error('FIDS outstation error:', e.message);
    res.status(502).json({ error: e.message });
  }
}

// ── 客製外站 adapter（NRT/SIN/SFO，各家 API 長相不同、各寫一支，輸出統一 row）──────
// 北海道是統一 API 走 _fidsOutstation；這三站各自端點/格式不同，正規化成同款 row 後前端表格不變。
type _FidsPort = { code: string; name: string; tz: number };
// 任意時區「當地日期」字串（YYYY-MM-DD，給各站 API 帶日期/篩日期用）
function _localDateDash(offsetHours: number, dayShift = 0): string {
  const d = new Date(Date.now() + offsetHours * 3600 * 1000 + dayShift * 86400 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
// ISO("2026-06-08T05:54:00-07:00") 或 "2026-06-08 21:35" → "HH:MM"（時區偏移段的 : 不會誤抓，因前面要 T 或空白）
function _hhmm(s: any): string { const m = String(s == null ? '' : s).match(/(?:T|\s)(\d{2}:\d{2})/); return m ? m[1] : ''; }
// 統一航班號：去空白、ICAO 三字碼→IATA 兩字碼、去數字前導零（AY0074→AY74、JX0805→JX805），跟桃園不留 padding 一致
function _outFno(raw: any): string {
  const f = String(raw == null ? '' : raw).replace(/\s/g, '').toUpperCase();
  const m = f.match(/^([A-Z]{2,3})0*(\d+[A-Z]?)$/);
  if (!m) return f;
  let pre = m[1];
  if (pre.length === 3 && _ICAO2IATA[pre]) pre = _ICAO2IATA[pre];
  return pre + m[2];
}
// 一筆正規化 row（沿用北海道 _hkdRow 慣例：到達 gate 放 parking 欄，沒有的欄位空字串→前端顯示「—」）
function _outRow(port: _FidsPort, dir: 'D' | 'A', x: any): any {
  const base = {
    fno: x.fno, altFno: x.altFno || '', checkin: x.checkin || '',
    depTerminal: dir === 'D' ? (x.terminal || '') : '', arrTerminal: dir === 'A' ? (x.terminal || '') : '',
    carousel: x.carousel || ''
  };
  if (dir === 'D') {
    return {
      ...base, origin: port.code, originCode: port.code, originName: port.name,
      dest: x.other, destCode: x.other, destName: x.otherName || x.other,
      gate: x.gate || '', std: x.schedT || '', atd: x.actT || '', sta: '', ata: '', parking: ''
    };
  }
  return {
    ...base, origin: x.other, originCode: x.other, originName: x.otherName || x.other,
    dest: port.code, destCode: port.code, destName: port.name,
    gate: '', std: '', atd: '', sta: x.schedT || '', ata: x.actT || '', parking: x.gate || ''
  };
}

// NRT 成田（GET BFF JSON，免 key）。只回未飛的班（滾動窗）。國際線（JX 等皆國際）。
function _nrtRow(f: any, port: _FidsPort, dir: 'D' | 'A'): any | null {
  const raw = String(f.displayFlightCode || f.flightCode || '').replace(/\s/g, '').toUpperCase();
  const fno = _outFno(raw);
  if (!fno) return null;
  const ap = (f.airport && f.airport.original) || {};
  const other = String(ap['3LetterCode'] || '').toUpperCase();
  const otherName = ap.name || other;
  const gate = (f.gate && f.gate[0] && f.gate[0].gateNo != null) ? String(f.gate[0].gateNo).trim() : '';
  let checkin = '';
  const ci = f.checkInCounterOrArrivalLobby;
  if (dir === 'D' && ci && Array.isArray(ci.nameOfCheckInOrArrival) && ci.nameOfCheckInOrArrival[0]) checkin = String(ci.nameOfCheckInOrArrival[0].name || '');
  const altFno = (raw && raw !== fno.toUpperCase()) ? raw : '';
  return _outRow(port, dir, { fno, altFno, other, otherName, gate, schedT: String(f.scheduledTime || '').trim(), actT: '', terminal: String(f.displayTerminal || '').trim(), checkin, carousel: '' });
}
async function _fidsNrt(port: _FidsPort, dash: string, label: string): Promise<{ rows: any[]; date: string }> {
  const getPage = async (da: 'D' | 'A', page: number): Promise<any> => {
    const u = `https://www.narita-airport.jp/api/bff/searchFlight/?locale=en&domInter=I&flightDepArr=${da}&date=${dash}&page=${page}&size=200`;
    const r = await fetch(u, { headers: { 'User-Agent': _FIDS_UA, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const collect = async (da: 'D' | 'A'): Promise<any[]> => {
    let out: any[] = [], page = 0, more = true;
    while (more && page < 5) {
      const j = await getPage(da, page);
      out = out.concat((j && j.flights && j.flights.data) || []);
      more = !!(j && j.flights && j.flights.hasNextPage);
      page++;
    }
    return out;
  };
  const [dep, arr] = await Promise.all([collect('D'), collect('A')]);
  const rows: any[] = [];
  for (const f of dep) { const r = _nrtRow(f, port, 'D'); if (r) rows.push(r); }
  for (const f of arr) { const r = _nrtRow(f, port, 'A'); if (r) rows.push(r); }
  return { rows, date: label };
}

// SIN 樟宜（AppSync GraphQL）。x-api-key 從 departures 頁面動態抓（會輪替、不寫死），快取 10 分。
let _sinKey: { key: string; ts: number } = { key: 'da2-umfoldhfsnhh7e3zgbtyr3p6um', ts: 0 };
async function _sinApiKey(): Promise<string> {
  if (_sinKey.key && Date.now() - _sinKey.ts < 600000) return _sinKey.key;
  try {
    const t = await (await fetch('https://www.changiairport.com/en/flights/departures.html', { headers: { 'User-Agent': _FIDS_UA } })).text();
    const m = t.match(/da2-[a-z0-9]{26}/i);
    if (m) _sinKey = { key: m[0], ts: Date.now() };
  } catch { /* 抓不到就沿用上次/預設 key */ }
  return _sinKey.key;
}
function _sinRow(f: any, port: _FidsPort, dir: 'D' | 'A'): any | null {
  const raw = String(f.flight_number || '').replace(/\s/g, '').toUpperCase();
  const fno = _outFno(raw);
  if (!fno) return null;
  const ad = f.airport_details || {};
  const other = String(ad.code || f.airport || '').toUpperCase();
  const otherName = ad.name || other;
  const gate = String(f.display_gate || f.current_gate || '').trim();
  const sched = String(f.scheduled_time || '').trim();
  const eta = _hhmm(f.estimated_timestamp);
  const act = _hhmm(f.actual_timestamp) || ((eta && eta !== sched) ? eta : '');
  const altFno = (raw && raw !== fno.toUpperCase()) ? raw : '';
  // terminal 不填：origin_dep_terminal 是「出發地機場的航廈」不是樟宜本站的，填了會誤導；樟宜本站航廈無乾淨欄位
  return _outRow(port, dir, {
    fno, altFno, other, otherName, gate, schedT: sched, actT: act,
    terminal: '',
    checkin: dir === 'D' ? String(f.check_in_row || '') : '',
    carousel: dir === 'A' ? String(f.display_belt || '') : ''
  });
}
async function _fidsSin(port: _FidsPort, dash: string, label: string): Promise<{ rows: any[]; date: string }> {
  const apiKey = await _sinApiKey();
  const FIELDS = 'flight_number airline airport airport_details { code name } current_gate display_gate display_belt check_in_row origin_dep_terminal scheduled_time estimated_timestamp actual_timestamp scheduled_date direction';
  // ⚠ Changi 的 scheduled_date 是「起始日」不是過濾：會一路回未來幾天的班（日期遞增）。
  // 必須自己只留當天、且一旦翻到隔天之後就停（否則前端 ±2hr 只比 HH:MM 會把明天的班當今天）。
  const fetchDir = async (dir: 'DEP' | 'ARR'): Promise<any[]> => {
    let out: any[] = [], token: string | null = null, page = 0;
    while (page < 12) {
      const args = `direction: "${dir}", scheduled_date: "${dash}"` + (token ? `, next_token: "${token}"` : '');
      const q = `query { getFlights(${args}) { flights { ${FIELDS} } next_token } }`;
      const r = await fetch('https://ca-appsync.lz.changiairport.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Origin': 'https://www.changiairport.com', 'Referer': 'https://www.changiairport.com/', 'User-Agent': _FIDS_UA },
        body: JSON.stringify({ query: q })
      });
      const j = await r.json();
      const gf = j && j.data && j.data.getFlights;
      if (!gf) break;
      let passedDay = false;
      for (const f of (gf.flights || [])) {
        const sd = String(f.scheduled_date || '');
        if (sd === dash) out.push(f);
        else if (sd > dash) passedDay = true;   // 已排到隔天之後 → 當天的都收完了
      }
      token = gf.next_token || null;
      page++;
      if (!token || passedDay) break;
    }
    return out;
  };
  const [dep, arr] = await Promise.all([fetchDir('DEP'), fetchDir('ARR')]);
  const rows: any[] = [];
  for (const f of dep) { const r = _sinRow(f, port, 'D'); if (r) rows.push(r); }
  for (const f of arr) { const r = _sinRow(f, port, 'A'); if (r) rows.push(r); }
  return { rows, date: label };
}

// SFO（GET JSON，免 key）。一次回多日 arr+dep，server 端依日期篩。
function _sfoRow(f: any, port: _FidsPort): any | null {
  const dir: 'D' | 'A' = (String(f.flight_kind || '').toUpperCase()[0] === 'D') ? 'D' : 'A';
  const al = f.airline || {};
  if (!al.iata_code) return null;
  const raw = (String(al.iata_code) + String(f.flight_number || '')).replace(/\s/g, '').toUpperCase();
  const fno = _outFno(raw);
  if (!fno) return null;
  const ap = f.airport || {};
  const other = String(ap.iata_code || '').toUpperCase();
  const otherName = ap.airport_city || ap.airport_name || other;
  const gate = (f.gate && f.gate.gate_number) ? String(f.gate.gate_number).trim() : '';
  const sched = _hhmm(f.scheduled_in_off_block_time);
  const act = _hhmm(f.actual_in_off_block_time) || _hhmm(f.estimated_in_off_block_time);
  const term = (f.terminal && f.terminal.terminal_code) ? String(f.terminal.terminal_code) : '';
  const car = (f.baggage_carousel && f.baggage_carousel.carousel_name) ? String(f.baggage_carousel.carousel_name) : '';
  return _outRow(port, dir, { fno, altFno: '', other, otherName, gate, schedT: sched, actT: act, terminal: term, checkin: '', carousel: dir === 'A' ? car : '' });
}
async function _fidsSfo(port: _FidsPort, dash: string, label: string): Promise<{ rows: any[]; date: string }> {
  const r = await fetch('https://www.flysfo.com/flysfo/api/flight-status', { headers: { 'User-Agent': _FIDS_UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j: any = await r.json();
  const arr: any[] = Array.isArray(j) ? j : (j.data || j.flights || []);
  // ⚠ SFO 把同一架實體班依每個掛牌航司拆成多筆（同 aircraft_mvmt_id）。
  // 機組要看實體班 + 操作航司的真航班號 → 按 mvmt 去重，優先留 callsign 對得上自家 ICAO 的那筆（操作方）。
  const byMvmt = new Map<string, any>();
  const loose: any[] = [];
  for (const f of arr) {
    if (String(f.scheduled_date || '') !== dash) continue;
    const id = f.aircraft_mvmt_id;
    if (id == null) { loose.push(f); continue; }
    const key = String(id);
    const prev = byMvmt.get(key);
    if (!prev) { byMvmt.set(key, f); continue; }
    const isOper = (g: any) => { const ic = String((g.airline || {}).icao_code || '').toUpperCase(); const cs = String(g.callsign || '').toUpperCase(); return ic && cs.startsWith(ic); };
    if (isOper(f) && !isOper(prev)) byMvmt.set(key, f);   // 操作方優先；都不是就保留先到的
  }
  const rows: any[] = [];
  for (const f of [...byMvmt.values(), ...loose]) { const row = _sfoRow(f, port); if (row) rows.push(row); }
  return { rows, date: label };
}

// 用 IANA 時區算「現在」與 UTC 的時差（小時），DST 自動正確（SFO 夏 -7/冬 -8 等）
function _ianaOffsetHours(tz: string): number {
  const now = new Date();
  const parts: any = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now)) parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +(parts.hour === '24' ? 0 : parts.hour), +parts.minute);
  return Math.round((asUTC - now.getTime()) / 3600000);
}
// iana 有給就用它動態算偏移（DST 安全）；沒給就用固定 tz（日本+9、星+8 無 DST）
const _FIDS_BESPOKE: Record<string, _FidsPort & { iana?: string; adapter: (p: _FidsPort, dash: string, label: string) => Promise<{ rows: any[]; date: string }> }> = {
  nrt: { code: 'NRT', name: '成田', tz: 9, adapter: _fidsNrt },
  sin: { code: 'SIN', name: '樟宜', tz: 8, adapter: _fidsSin },
  sfo: { code: 'SFO', name: '舊金山', tz: -7, iana: 'America/Los_Angeles', adapter: _fidsSfo }   // 夏 PDT-7 / 冬 PST-8，動態算
};
const _fidsOutCache: Record<string, { ts: number; data: any }> = {};
async function _fidsBespoke(src: string, reqDate: string, res: any) {
  const ent = _FIDS_BESPOKE[src];
  const tz = ent.iana ? _ianaOffsetHours(ent.iana) : ent.tz;
  const port: _FidsPort = { code: ent.code, name: ent.name, tz };
  // 外站只服務 today / yesterday（比照北海道）；其餘日期回空
  const apToday = _localDateStr(tz, 0), apYest = _localDateStr(tz, -1);
  const twToday = _twDateStr(0), twYest = _twDateStr(-1);
  let shift = 0;
  if (reqDate === apYest || reqDate === twYest) shift = -1;
  else if (reqDate && reqDate !== apToday && reqDate !== twToday) { res.json({ rows: [], date: reqDate, airport: ent.code }); return; }
  const dash = _localDateDash(tz, shift);
  const label = _localDateStr(tz, shift);
  const ck = src + '|' + dash;
  const cached = _fidsOutCache[ck];
  if (cached && Date.now() - cached.ts < 60000) { res.json(cached.data); return; }
  try {
    const { rows, date } = await ent.adapter(port, dash, label);
    const data = { rows, date, airport: ent.code };
    _fidsOutCache[ck] = { ts: Date.now(), data };
    res.json(data);
  } catch (e: any) {
    console.error('FIDS bespoke error:', ent.code, e.message);
    if (cached) { res.json(cached.data); return; }   // 上游暫時掛掉→退回上次成功的舊資料
    res.status(502).json({ error: e.message });
  }
}

app.get('/api/fids', async (req, res) => {
  // 外站分流：?airport=nrt|sin|sfo → 客製 adapter；cts|hkd → 北海道統一來源；無/tpe → 維持桃園原邏輯
  const apParam = String(req.query.airport || '').toLowerCase();
  if (apParam && _FIDS_BESPOKE[apParam]) {
    await _fidsBespoke(apParam, String(req.query.date || ''), res);
    return;
  }
  if (apParam && apParam !== 'tpe' && _FIDS_PORTS[apParam]) {
    await _fidsOutstation(_FIDS_PORTS[apParam], String(req.query.date || ''), res);
    return;
  }
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

// ── ATFM (流量管制) 多地區可插拔 ─────────────────────────────────────────────
// 各官方源正規化成共同 shape {measures[], ctot[]}。命名中性藏來源。公開源:
//   tw=台灣ANWS / hk,mo=香港atfmc / th=泰國aerothai / apac=香港cross-border地圖(全亞洲管制概況)
const _atfmCache: Record<string, { ts: number; data: any }> = {};
let _atfmMapCache: { ts: number; data: any } | null = null;
const _ATFM_TTL = 30000;
function _atfmStrip(s: any): string {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]*>/g, '')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/(\s*\/\s*){2,}/g, ' / ').replace(/\s+/g, ' ').trim();
}
async function _atfmJson(url: string, opts?: any): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 6000);  // 任一上游卡住最多 6 秒就放掉，不拖垮整頁
  try {
    const r = await fetch(url, { headers: { 'User-Agent': _FIDS_UA, 'Accept': 'application/json,*/*' }, ...(opts || {}), signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const _atfmHkT = (s: any): string => { const x = String(s || ''); return x.length >= 12 ? x.slice(6, 8) + '/' + x.slice(8, 12) : x; };
const _atfmIsoT = (s: any): string => { const m = String(s || '').match(/\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return m ? m[2] + '/' + m[3] + m[4] : ''; };
function _atfmType(s: string): string {
  const u = s.toUpperCase();
  if (/GROUND STOP/.test(u)) return 'GROUND STOP';
  if (/GDP|GROUND DELAY/.test(u)) return 'GDP';
  if (/LVL|LEVEL|FL\d/.test(u)) return 'LVL RESTRICTION';
  if (/MDI|MINIMUM DEP/.test(u)) return 'MDI';
  if (/FLOW/.test(u)) return 'FLOW CONTROL';
  if (/MEASURE/.test(u)) return 'ATFM MEASURE';
  return 'NOTICE';
}
// 香港 cross-border 地圖(全亞洲) → 每機場狀態 {ICAO:{color,text,type}}。color: green/amber/red(灰由前端判=不在圖內)
async function _atfmMapStatus(): Promise<Record<string, any>> {
  if (_atfmMapCache && Date.now() - _atfmMapCache.ts < _ATFM_TTL) return _atfmMapCache.data;
  const r = await fetch('https://www.atfmc.gov.hk/public/map?refresh=1', { headers: { 'User-Agent': _FIDS_UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  const st: Record<string, any> = {};
  const rank: Record<string, number> = { green: 0, amber: 1, red: 2 };
  for (const m of html.matchAll(/title=(["'])([\s\S]{6,400}?)\1/gi)) {
    const clean = _atfmStrip(m[2]);
    const mm = clean.match(/^([A-Z]{4})\s*[:：]\s*(.+)$/);
    if (!mm) continue;
    const ic = mm[1], text = mm[2].trim(), u = text.toUpperCase();
    let color: string;
    if (/NO ATFM MEASURE|NO MEASURE|NO RESTRICTION|NO ACTIVE/.test(u)) color = 'green';
    else if (/NOT AVAILABLE|NO DATA|UNAVAILABLE/.test(u)) continue;  // 拿不到資料 → 不收(前端顯示灰)
    else if (/GROUND STOP/.test(u)) color = 'red';
    else if (/GDP|GROUND DELAY|ATFM MEASURE|FLOW|MDI|RESTRICT|CLOSURE|DELAY/.test(u)) color = 'amber';
    else color = 'green';
    if (!st[ic] || rank[color] > rank[st[ic].color]) st[ic] = { color, text, type: _atfmType(clean) };
  }
  _atfmMapCache = { ts: Date.now(), data: st };
  return st;
}
// 措施清單(只 amber/red) → 各區公告用
async function _atfmMap(): Promise<any[]> {
  const st = await _atfmMapStatus();
  return Object.keys(st).filter(ic => st[ic].color !== 'green').map(ic => ({ airport: ic, text: st[ic].text, type: st[ic].type }));
}
// 未來潛在北美航點(長榮/華航現飛、我們尚未列入 Ops Spec)：JFK 紐約/IAH 休士頓/DFW 達拉斯/ORD 芝加哥/IAD 華府杜勒斯/YYZ 多倫多
// 美國的吃 FAA 即時狀態,加拿大 YYZ 無 ATFM 源→灰點(no data)
const _atfmExtraIcaos = ['KJFK', 'KIAH', 'KDFW', 'KORD', 'KIAD', 'CYYZ'];
// Ops Spec 機場 + 座標(airport-data.js 的 ICAO ∩ airport-db.js 座標)，啟動算一次快取
let _atfmOpsCache: any[] | null = null;
function _atfmOps(): any[] {
  if (_atfmOpsCache) return _atfmOpsCache;
  try {
    const icaos = [...new Set([...[...getSpaAirportDataJs().matchAll(/icao:'([A-Z]{4})'/g)].map(m => m[1]), ..._atfmExtraIcaos])];
    const db = getAirportDbJs();
    const out: any[] = [];
    for (const ic of icaos) {
      const m = db.match(new RegExp('"' + ic + '","([^"]*)","[^"]*","[^"]*","[^"]*",(-?[\\d.]+),(-?[\\d.]+)'));
      if (m) out.push({ icao: ic, iata: m[1], lat: parseFloat(m[2]), lon: parseFloat(m[3]) });
    }
    _atfmOpsCache = out;
  } catch { _atfmOpsCache = []; }
  return _atfmOpsCache;
}
async function _atfmTw(): Promise<any> {
  const [info, ct] = await Promise.allSettled([
    _atfmJson('https://atfm.anws.gov.tw/upload_file/dy_info.json?' + Date.now()),
    _atfmJson('https://atfm.anws.gov.tw/upload_file/atfm_ALL.json?' + Date.now())
  ]);
  const measures = (info.status === 'fulfilled' ? (info.value.data || []) : []).map((r: any) => ({ type: _atfmStrip(r[2]) || 'NOTICE', text: _atfmStrip(r[3]), airport: '', time: _atfmStrip(r[1]) }));
  const ctot = (ct.status === 'fulfilled' ? (ct.value.data || []) : []).map((r: any) => {
    const adep = _atfmStrip(r[7]), ades = _atfmStrip(r[8]);
    return { acid: _atfmStrip(r[1]), adep, ades, cobt: _atfmStrip(r[2]), ctot: _atfmStrip(r[3]), ctotNew: _atfmStrip(r[5] || r[4] || ''), win: _atfmStrip(r[6]), status: _atfmStrip(r[9]), dir: /^RC/.test(adep) ? 'DEP' : (/^RC/.test(ades) ? 'ARR' : '') };
  });
  return { region: 'tw', measures, ctot, hasCtot: true };
}
async function _atfmHk(port: string, region: string): Promise<any> {
  const base = 'https://www.atfmc.gov.hk/schedule';
  const [o, i] = await Promise.allSettled([_atfmJson(`${base}/outbound/port/${port}`), _atfmJson(`${base}/inbound/port/${port}`)]);
  const mk = (j: any, dir: string) => (j && j.data ? j.data : []).filter((r: any) => r.expired !== 'Y').map((r: any) => ({ acid: _atfmStrip(r.acid), optr: _atfmStrip(r.optr), adep: _atfmStrip(r.adep), ades: _atfmStrip(r.ades), cobt: _atfmHkT(r.eobt), ctot: _atfmHkT(r.ctot), ctotNew: '', win: '', status: '', dir }));
  const ctot = [...mk(o.status === 'fulfilled' ? o.value : null, 'DEP'), ...mk(i.status === 'fulfilled' ? i.value : null, 'ARR')];
  let measures: any[] = []; try { measures = (await _atfmMap()).filter(m => m.airport === port.toUpperCase()); } catch { }
  return { region, measures, ctot, hasCtot: true };
}
async function _atfmTh(): Promise<any> {
  let ctot: any[] = [];
  try {
    const j = await _atfmJson('https://atfm.aerothai.aero/CTOTDistributor/QueryCtotflights', { method: 'POST', headers: { 'User-Agent': _FIDS_UA, 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: '{}' });
    ctot = (j.ctotFlights || []).map((f: any) => { const fl = f.flight || {}; const adep = _atfmStrip(fl.airportDeparture), ades = _atfmStrip(fl.airportArrival); return { acid: _atfmStrip(fl.callsign), adep, ades, cobt: _atfmIsoT(fl.cobt || fl.eobt), ctot: _atfmIsoT(fl.ctot || fl.etot), ctotNew: '', win: '', status: _atfmStrip(f.measureString), dir: /^VT/.test(adep) ? 'DEP' : (/^VT/.test(ades) ? 'ARR' : '') }; });
  } catch { }
  let measures: any[] = []; try { measures = (await _atfmMap()).filter(m => /^VT/.test(m.airport)); } catch { }
  return { region: 'th', measures, ctot, hasCtot: true };
}
// 越南 Hanoi ATFMU(自己的源)：憑證壞→跳驗證。getTop=機場流量限制 / dayFlights=當日逐班(取有CTOT且越南起飛)
const _atfmVnAgent = new UndiciAgent({ connect: { rejectUnauthorized: false } });
let _atfmVnCache: { ts: number; data: any } | null = null;
async function _atfmVn(): Promise<any> {
  if (_atfmVnCache && Date.now() - _atfmVnCache.ts < _ATFM_TTL) return _atfmVnCache.data;
  const opt: any = { dispatcher: _atfmVnAgent, headers: { 'User-Agent': _FIDS_UA, 'Accept': 'application/json' } };
  const [topR, dfR] = await Promise.allSettled([
    fetch('https://atfm.vn/ctotGenerator/rest/getTop/', opt).then(r => r.json()),
    fetch('https://atfm.vn/ctotGenerator/rest/dayFlights/', opt).then(r => r.json())
  ]);
  const top = topR.status === 'fulfilled' && Array.isArray(topR.value) ? topR.value : [];
  const df = dfR.status === 'fulfilled' && Array.isArray(dfR.value) ? dfR.value : [];
  const now = Date.now();
  const status: Record<string, any> = {}; const measures: any[] = [];
  const hm = (ms: number) => { const d = new Date(ms); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
  for (const t of top) {
    const ic = _atfmStrip(t.airport); if (!ic) continue;
    const end = t.endRecovery || t.endRestriction || 0;
    if (end && end < now) continue;  // 已恢復的不顯示
    const txt = 'Flow ' + t.normalFlow + '→' + t.restrictionFlow + '/h' + (t.beginRestriction ? ' ' + hm(t.beginRestriction) + '-' + hm(end) + 'Z' : '');
    status[ic] = { color: 'amber', text: txt, type: 'GDP' };
    measures.push({ airport: ic, text: txt, type: 'GDP', time: '' });
  }
  const fmt = (s: any) => { const x = String(s == null ? '' : s).trim(); return /^\d{4}$/.test(x) ? x.slice(0, 2) + ':' + x.slice(2) : x; };
  const ctot = df.filter((f: any) => f.ctot && /^VV/.test(String(f.fromAirp || ''))).map((f: any) => ({
    acid: _atfmStrip(f.flightnbr), adep: _atfmStrip(f.fromAirp), ades: _atfmStrip(f.toAirp),
    cobt: fmt(f.eobt), ctot: fmt(f.ctot), ctotNew: '', win: '', status: '', dir: 'DEP'
  }));
  const data = { region: 'vn', status, measures, ctot, hasCtot: true };
  _atfmVnCache = { ts: Date.now(), data };
  return data;
}
// 歐洲 EUROCONTROL NOP 網路事件(機場關閉/罷工/維修/軍事/天氣/容量)。cookie 由 GitHub Action 鑄好 POST 進來。
// 不是逐班 CTOT(歐洲不公開),是「為什麼受影響」的事件原因 → 有事件的機場上色 + 列清單。
let _nopRecipe: { cookie: string; url?: string; body?: string; permutation?: string } = { cookie: '' };
let _atfmEuCache: { ts: number; data: any } | null = null;
let _atfmEuLast: { ts: number; data: any } | null = null;   // 最後一次「成功抓到」的歐洲快照,抓不到時續用(stale 安全網,1 小時內)
// 歐洲網路事件分三級(2026-06-07 用真資料校準):大多事件其實是施工/設施告示,不影響流量,降級 info 不搶眼。
// 🔴 紅=整場關閉/地面停止;🟡 黃=真影響流量(關跑道/天氣/罷工/軍事/流量管制);🔵 info=資訊告示(施工/維護/程序/設施)。
// 順序重要:先抓真嚴重的,設施維護放最後;抓不到關鍵字的未知事件保守當黃(寧可多提醒不漏真管制)。
function _atfmEuClassify(text: string): { color: string; type: string } {
  const u = (text || '').toUpperCase();
  // 🔴 整場關閉 / 地面停止(只認整場,塔台/跑道不算)。含 NOTAM 縮寫 CLSD + AD/ARP;前向比對(機場詞在前)避免誤抓「closure of RWY…aerodrome」跑道關
  if (/(AERODROME|AIRPORT|FIELD|\bAD\b|\bARP\b)[^.]{0,16}(CLOS|CLSD)|GROUND STOP/.test(u)) return { color: 'red', type: 'CLOSURE' };
  // 🟡 真影響流量
  if (/STRIKE|INDUSTRIAL ACTION/.test(u)) return { color: 'amber', type: 'STRIKE' };
  if (/FIRING|MILITARY|DANGER AREA|MISSILE|\bEXERCISE\b/.test(u)) return { color: 'amber', type: 'MILITARY' };
  if (/WEATHER|\bFOG\b|SNOW|\bSTORM|THUNDER|\bLVP\b|LOW VIS|DE-?ICING/.test(u)) return { color: 'amber', type: 'WEATHER' };
  if (/(RWY|RUNWAY)[^.]{0,30}(CLOS|CLSD)|(CLOS|CLSD)[^.]{0,30}(RWY|RUNWAY)/.test(u)) return { color: 'amber', type: 'FLOW' };   // 跑道關閉=黃(機場還開)
  if (/GDP|GROUND DELAY|REGULATION|CAPACITY|\bFLOW\b|\bSLOT\b|\bMDI\b|RESTRICT|ATFM|STAFFING|REDUCED FLOW/.test(u)) return { color: 'amber', type: 'FLOW' };
  // 🔵 資訊告示 / 設施 / 程序,不影響流量 → 降級
  if (/CONSTRUCT|REFURBISH|RENOVAT|RESURFAC|REPARATION|REPAIR|\bWORKS?\b|OBRAS|MAINTEN|TAXIWAY|TAXILANE|TWY|APRON|PARKING|\bSTANDS?\b|FREQUENC|CLEARANCE|\bDCL\b|LIGHTING|NAVAID|\bILS\b|\bDME\b|PAINT|SURVEY|INSPECT|SIGNAGE|PROCEDURE|TERMINAL|BUILDING|EXPANSION|CONFIGURAT|AODB|A-CDM/.test(u)) return { color: 'info', type: 'INFO' };
  // 其餘未知 → 保守當黃
  return { color: 'amber', type: 'EVENT' };
}
async function _atfmEu(force = false): Promise<any> {
  if (!force && _atfmEuCache && Date.now() - _atfmEuCache.ts < 600000) return _atfmEuCache.data;  // 10 分快取(保活 force 跳過讀取但不清舊)
  let events: { icaos: string[]; texts: string[] }[] = [];
  let ok = false;
  try { events = await fetchNopNetworkEvents(_nopRecipe); ok = !!_nopRecipe.cookie; } catch { }   // 沒 cookie(冷啟動)別當成功快取空的;等 cookie 到再抓
  // 即時優先:抓不到(cookie 過期/沒 cookie)時,續用 1 小時內上次成功的資料,不熄燈(歐洲事件慢變,稍舊仍有效)
  if (!ok && _atfmEuLast && Date.now() - _atfmEuLast.ts < 3600000) return _atfmEuLast.data;
  const db = getAirportDbJs();
  const status: Record<string, any> = {}; const airports: any[] = []; const measures: any[] = [];
  const _euRank: Record<string, number> = { info: 0, amber: 1, red: 2 };
  // 綠燈底圖清單:歐洲主要樞紐 + JX 確定/候選航點。⭐LKPR 布拉格=確定;LEBL/LSZH/EFHK=候選;其餘為亞洲航司常用大樞紐。
  // base=true 代表「在我們清單內」→ 前端 Key 模式只顯示這些;清單外的事件機場 base=false,只在 Events 模式顯示。
  const EU_BASE = ['LKPR', 'LEBL', 'LSZH', 'EFHK', 'EGLL', 'EGKK', 'LFPG', 'EDDF', 'EDDM', 'EHAM', 'LOWW', 'LIMC', 'LIRF', 'LEMD', 'LTFM', 'EBBR', 'EKCH', 'ESSA', 'ENGM', 'EIDW', 'LPPT'];
  for (const ev of events) {
    const text = ev.texts.filter(t => t.length > 4).sort((a, b) => b.length - a.length)[0] || ev.texts[0] || 'Network event';
    const { color, type } = _atfmEuClassify(text);
    for (const ic of ev.icaos) {                                       // 一事件可能影響多機場 → 全展開
      if (db.indexOf('"' + ic + '","') < 0) continue;                  // 不在機場庫(濾假碼 IRAQ/NICE)
      const ex = status[ic];
      if (ex && _euRank[ex.color] >= _euRank[color]) continue;          // 同機場多事件:已收同級或更嚴重 → 不蓋(嚴重者勝)
      const m = db.match(new RegExp('"' + ic + '","([^"]*)","[^"]*","[^"]*","[^"]*",(-?[\\d.]+),(-?[\\d.]+)'));
      if (!m) continue;
      status[ic] = { color, text, type };
      const ai = airports.find(a => a.icao === ic);
      if (ai) { ai.color = color; ai.text = text; ai.type = type; }    // 升級覆蓋已畫的點
      else airports.push({ icao: ic, lat: parseFloat(m[2]), lon: parseFloat(m[3]), color, text, type, base: EU_BASE.indexOf(ic) >= 0 });
    }
  }
  // 措施清單只列真影響流量的(紅/黃);info 資訊告示只在地圖可點選、不進清單,避免洗版
  for (const ic in status) {
    if (status[ic].color !== 'info') measures.push({ airport: ic, text: status[ic].text, type: status[ic].type, time: '' });
  }
  // 綠燈底圖:抓取成功時,清單內沒事件的機場塗綠(代表「確實查過 NOP、此刻無管制」);有事件的上面已收(黃/紅/info),
  // status[ic] 已存在會跳過 → 事件蓋過綠。讓歐洲看起來像正常狀態圖(一片綠、出事才跳黃紅)。base:true=固定底圖、Key 模式也顯示。
  if (ok) {
    for (const ic of EU_BASE) {
      if (status[ic] || db.indexOf('"' + ic + '","') < 0) continue;   // 已有事件(蓋過) / 不在機場庫
      const m = db.match(new RegExp('"' + ic + '","([^"]*)","[^"]*","[^"]*","[^"]*",(-?[\\d.]+),(-?[\\d.]+)'));
      if (!m) continue;
      status[ic] = { color: 'green', text: 'No active ATFM event', type: '' };
      airports.push({ icao: ic, lat: parseFloat(m[2]), lon: parseFloat(m[3]), color: 'green', text: 'No active ATFM event', type: '', base: true });
    }
  }
  const _tw = new Date(Date.now() + 8 * 3600 * 1000);
  const data: any = { region: 'eu', status, airports, measures, ctot: [], hasCtot: false, updated: String(_tw.getUTCHours()).padStart(2, '0') + ':' + String(_tw.getUTCMinutes()).padStart(2, '0') };
  if (ok) { _atfmEuCache = { ts: Date.now(), data }; _atfmEuLast = { ts: Date.now(), data }; }   // 成功:更新快取 + 留作 stale 安全網(updated=抓取當下,stale 時顯示真實舊時間不誤導)
  return data;
}
// NOP session 是「閒置型」、timeout 約 10-12 分(2026-06-07 受控實驗:3分ping撐過18分、12分ping約15分死)。
// → 每 4 分用現有 cookie 主動打一次 NOP 保活(壓在 timeout 之下),session 就永遠維持、永遠即時,不必等不可靠的 GitHub 排程。
setInterval(() => { if (_nopRecipe.cookie) _atfmEu(true).catch(() => { }); }, 4 * 60 * 1000);   // force=強制抓(製造活動),失敗保留舊快取不清
// 美國 FAA NAS Status(公開JSON):每機場 groundStop/groundDelay/airportClosure。回 {status:{IATA:{color,text,type}}, measures}
let _atfmFaaCache: { ts: number; data: any } | null = null;
async function _atfmFaa(): Promise<any> {
  if (_atfmFaaCache && Date.now() - _atfmFaaCache.ts < _ATFM_TTL) return _atfmFaaCache.data;
  const status: Record<string, any> = {}; const measures: any[] = [];
  try {
    const arr = await _atfmJson('https://nasstatus.faa.gov/api/airport-events');
    (Array.isArray(arr) ? arr : []).forEach((a: any) => {
      const id = a.airportId; if (!id) return;
      let color = '', type = '', ev: any = null;
      if (a.airportClosure) { color = 'red'; type = 'CLOSURE'; ev = a.airportClosure; }
      else if (a.groundStop) { color = 'red'; type = 'GROUND STOP'; ev = a.groundStop; }
      else if (a.groundDelay) { color = 'amber'; type = 'GDP'; ev = a.groundDelay; }
      else if (a.freeForm) { color = 'amber'; type = 'ATFM MEASURE'; ev = a.freeForm; }
      if (!ev) return;
      const text = _atfmStrip(ev.simpleText || ev.text || '');
      status[id] = { color, text, type };
      measures.push({ airport: id, text, type });
    });
  } catch { }
  _atfmFaaCache = { ts: Date.now(), data: { status, measures } };
  return _atfmFaaCache.data;
}
// 從香港 cross-border 圖取某地區機場的「狀態」(無逐班CTOT)：日韓等自己不發CTOT的用這個
async function _atfmMapRegion(region: string, re: RegExp): Promise<any> {
  const st = await _atfmMapStatus();
  const measures = Object.keys(st).filter(ic => re.test(ic) && st[ic].color !== 'green').map(ic => ({ airport: ic, text: st[ic].text, type: st[ic].type }));
  return { region, measures, ctot: [], hasCtot: false };
}
app.get('/api/atfm', async (req, res) => {
  const region = String(req.query.region || 'tw').toLowerCase();
  const cached = _atfmCache[region];
  if (cached && Date.now() - cached.ts < _ATFM_TTL) { res.json(cached.data); return; }
  try {
    let data: any;
    if (region === 'all' || region === 'apac') {
      const [st, faa, twD, hkD, moD, thD, vnD, euD] = await Promise.all([
        _atfmMapStatus(), _atfmFaa(),
        _atfmTw().catch(() => ({ ctot: [] })), _atfmHk('vhhh', 'hk').catch(() => ({ ctot: [] })),
        _atfmHk('vmmc', 'mo').catch(() => ({ ctot: [] })), _atfmTh().catch(() => ({ ctot: [] })),
        _atfmVn().catch(() => ({ ctot: [], status: {} })), _atfmEu().catch(() => ({ airports: [] }))
      ]);
      const vnSt = (vnD as any).status || {};
      const db = getAirportDbJs();
      // base:true=在我們清單(各區 Ops Spec)→ 前端 Key 模式固定顯示。清單外的事件機場 base:false,只在 Events 模式顯示。
      const airports = _atfmOps().map((a: any) => {
        const s = st[a.icao] || vnSt[a.icao] || (a.iata && faa.status[a.iata]);
        let color = 'grey', text = '', type = '';
        if (s) { color = s.color; text = s.text; type = s.type; }
        else if (/^K/.test(a.icao)) { color = 'green'; }  // FAA 監控的美國本土機場,無事件=正常
        return { icao: a.icao, lat: a.lat, lon: a.lon, color, text, type, base: true };
      });
      // 歐洲(NOP 網路事件)併進來:有些歐洲機場(LKPR/EDDM/EDDB/EPWA/LOWL/LOWW)也在 Ops Spec → 去重覆蓋,別產生「紅點但點了 No data」的重複
      // 覆蓋時不動 base(Ops Spec 維持 base:true);清單外的歐洲事件機場帶 base:false(來自 _atfmEu)
      for (const ea of ((euD as any).airports || [])) {
        const ex = airports.find((a: any) => a.icao === ea.icao);
        if (ex) { ex.color = ea.color; ex.text = ea.text; ex.type = ea.type; }
        else airports.push(ea);
      }
      // 美國:清單外、FAA 正在管制的機場(KATL/KORD…)補進來當 base:false → Events 模式才顯示。
      // FAA status 以 IATA 為鍵。用 IATA 反查 db(第二欄就是 IATA)拿到 ICAO + 座標 → 涵蓋阿拉斯加 PANC/夏威夷 PHNL 等非 K 開頭場(不寫死 K+IATA)。
      const opsIata = new Set(_atfmOps().map((a: any) => a.iata).filter(Boolean));
      for (const iata in faa.status) {
        if (opsIata.has(iata)) continue;                                 // 已在清單(上面已上色)
        if (!/^[A-Z0-9]{3}$/.test(iata)) continue;                       // 防 regex 注入 / 非標準碼
        const m = db.match(new RegExp('"([A-Z]{4})","' + iata + '","[^"]*","[^"]*","[^"]*",(-?[\\d.]+),(-?[\\d.]+)'));
        if (!m) continue;                                                // db 查無此 IATA 座標 → 略過
        const icao = m[1];
        if (airports.find((a: any) => a.icao === icao)) continue;
        const s = faa.status[iata];
        airports.push({ icao, lat: parseFloat(m[2]), lon: parseFloat(m[3]), color: s.color, text: s.text, type: s.type, base: false });
      }
      // 台/港/澳/泰/越逐班 CTOT 一次合併,前端點機場時依 adep/ades 過濾
      // 跨境航班(如台灣→香港)兩邊源都會列出 → 去重
      const _seen = new Set<string>();
      const ctot = ([] as any[]).concat(
        (twD as any).ctot || [], (hkD as any).ctot || [], (moD as any).ctot || [], (thD as any).ctot || [], (vnD as any).ctot || []
      ).filter((c: any) => {
        // 鍵含 CTOT 時間(取數字):只有班號+航線+時間全同才併(跨源同一班);同航線不同班次時間不同→保留,不誤藏
        const k = (c.acid || '') + '|' + (c.adep || '') + '|' + (c.ades || '') + '|' + String(c.ctot || '').replace(/\D/g, '');
        if (_seen.has(k)) return false; _seen.add(k); return true;
      });
      data = { region: 'all', airports, ctot, hasCtot: false };
    }
    else if (region === 'tw') data = await _atfmTw();
    else if (region === 'hk') data = await _atfmHk('vhhh', 'hk');
    else if (region === 'mo') data = await _atfmHk('vmmc', 'mo');
    else if (region === 'th') data = await _atfmTh();
    else if (region === 'vn') data = await _atfmVn();
    else if (region === 'eu') data = await _atfmEu();
    else if (region === 'us') { const faa = await _atfmFaa(); data = { region: 'us', measures: faa.measures, ctot: [], hasCtot: false }; }
    else if (region === 'jp') data = await _atfmMapRegion('jp', /^RJ|^RO/);
    else if (region === 'kr') data = await _atfmMapRegion('kr', /^RK/);
    else { res.status(400).json({ error: 'unknown region' }); return; }
    const tw = new Date(Date.now() + 8 * 3600 * 1000);
    if (!data.updated) data.updated = String(tw.getUTCHours()).padStart(2, '0') + ':' + String(tw.getUTCMinutes()).padStart(2, '0');   // 歐洲 stale 續用時自帶抓取時間,別覆蓋成現在(避免舊資料假裝剛更新)
    _atfmCache[region] = { ts: Date.now(), data };
    res.json(data);
  } catch (e: any) {
    console.error('ATFM error:', region, e.message);
    if (cached) { res.json(cached.data); return; }  // 上游暫時失敗 → 退回上次成功的(雖過期)，不讓畫面空白
    res.status(502).json({ error: e.message });
  }
});

// NOP cookie 投遞口:GitHub Action 鑄好瀏覽器 cookie 後 POST 進來(token 防護)。存記憶體,重啟後等下次鑄。
app.post('/api/nop-refresh', (req, res) => {
  const secret = process.env.NOP_REFRESH_SECRET;
  if (!secret || req.query.token !== secret) { res.status(403).json({ error: 'forbidden' }); return; }
  const b = req.body || {};
  const cookie = String(b.cookie || '').trim();
  if (!cookie) { res.status(400).json({ error: 'no cookie' }); return; }
  // 自癒配方:鑄造端從 live portal 抓的當下 url/body/permutation 一起存(歐洲改版自動跟上);沒給就用寫死 fallback
  _nopRecipe = { cookie, url: b.url ? String(b.url) : undefined, body: b.body ? String(b.body) : undefined, permutation: b.permutation ? String(b.permutation) : undefined };
  _atfmEuCache = null;   // 換新配方 → 下次強制重抓
  delete _atfmCache['eu']; delete _atfmCache['all']; delete _atfmCache['apac'];   // 清外層快取,立即生效不卡 30 秒
  if (_pool) _pool.query(                                                          // 存進 DB → Render 重啟自動載回,不用人工重新點火
    `INSERT INTO cs_nop_recipe (id,recipe,updated_at) VALUES (1,$1,NOW())
     ON CONFLICT (id) DO UPDATE SET recipe=$1, updated_at=NOW()`,
    [JSON.stringify(_nopRecipe)]
  ).catch(() => {});
  console.log('[NOP] recipe refreshed, cookie', cookie.length, 'url', b.url ? 'live' : 'fallback');
  res.json({ ok: true });
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

// FR24 clickhandler 直抓(flightradarapi 1.4 送的 header 被 FR24 403;帶瀏覽器 header + version 就通)
// 含航跡 trail[]、起訖機場、時刻。30s 快取 + 失敗退舊 + 自動清理避免記憶體膨脹(trail 每筆~200KB)
const _FR24_CH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const _fr24ChCache: Record<string, { ts: number; data: any }> = {};
async function _fr24Clickhandler(id: string): Promise<any> {
  const c = _fr24ChCache[id];
  if (c && Date.now() - c.ts < 30000) return c.data;
  try {
    const r = await fetch('https://data-live.flightradar24.com/clickhandler/?flight=' + encodeURIComponent(id) + '&version=1.5',
      { headers: { 'User-Agent': _FR24_CH_UA, 'Accept': 'application/json', 'Referer': 'https://www.flightradar24.com/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    _fr24ChCache[id] = { ts: Date.now(), data };
    const now = Date.now();
    if (Object.keys(_fr24ChCache).length > 60) for (const k in _fr24ChCache) if (now - _fr24ChCache[k].ts > 60000) delete _fr24ChCache[k];
    return data;
  } catch (e) {
    if (c) return c.data;  // 上游失敗退回上次成功的
    throw e;
  }
}
app.get('/api/fr24/detail', async (req, res) => {
  try {
    const flightId = req.query.id as string;
    if (!flightId) { res.status(400).json({ error: 'missing id' }); return; }
    const details = await _fr24Clickhandler(flightId);
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
        const detail = await _fr24Clickhandler(t.id);
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
    // 解出 email（存 DB + 簽一張 CrewSync ATIS 身份證）
    let csEmail = '';
    if (tokens.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString());
        csEmail = payload.email || '';
        const name = payload.name || '';
        const picture = payload.picture || '';
        if (_pool && csEmail) {
          await _pool.query(
            `INSERT INTO cs_users (email, name, picture) VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET name = $2, picture = $3, updated_at = NOW()`,
            [csEmail, name, picture]
          );
          console.log(`[DB] User saved: ${csEmail}`);
        }
      } catch (dbErr: any) {
        console.error('[DB] Save user error:', dbErr.message);
      }
    }
    // CrewSync 班表同步登入沒有 pilot_users → 簽一張 email 身份證，前端存著、抓 ATIS 時帶上判斷 founder。
    const csIdt = csEmail ? signEmailToken(csEmail) : '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0a0e1a;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style>
</head><body>
<div><p style="font-size:2.5em">✅</p><p>授權完成！<br>正在關閉視窗...</p></div>
<script>
  try { window.opener && window.opener.postMessage({ type:'oauth_done', refreshToken:${JSON.stringify(rt)}, idt:${JSON.stringify(csIdt)} }, '*'); } catch(e){}
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

// 用「員編」遠端查某使用者最近一次「登入失敗當下的登入頁截圖」（同步是 server 端跑，失敗證據留在 server）。
//   使用者回報問題時只要給員編，管理員開 /debug/sync?eid=<員編> 就看得到，不用使用者傳截圖。
app.get('/debug/sync', (req, res) => {
  // ⚠ owner 專用：必須帶正確 ?k=<SYNC_DEBUG_KEY>(env)。沒設 key → 整個停用(fail closed)。
  //   否則任何人猜員編就能撈別人的登入失敗截圖(含員編+內部頁面)——codex P1。
  const key = process.env.SYNC_DEBUG_KEY || '';
  if (!key || String(req.query.k || '') !== key) return res.status(403).send('forbidden');
  const eid = String(req.query.eid || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!eid) return res.status(400).send('用法：/debug/sync?eid=員編&k=金鑰');
  try {
    const f = path.join(OUTPUT_DIR, `syncfail-${eid}.png`);
    if (!fs.existsSync(f)) return res.status(404).send(`查無員編 ${eid} 的登入失敗截圖（可能未發生過、或檔案已被清理）。`);
    res.sendFile(f);
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
// 簡易記憶體流量限制器（防暴力猜/快速枚舉）。key 內含 IP，超過 max/視窗就擋；對正常用戶無感。
const _rl = new Map<string, { n: number; reset: number }>();
function _rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const e = _rl.get(key);
  if (!e || now > e.reset) {
    _rl.set(key, { n: 1, reset: now + windowMs });
    // 防止 Map 隨「每個曾出現過的 IP」無限長大（網路掃描會塞爆）→ 變大時順手清掉過期 entry（codex P2）。
    if (_rl.size > 5000) { for (const [k, v] of _rl) if (now > v.reset) _rl.delete(k); }
    return true;
  }
  if (e.n >= max) return false;
  e.n++;
  return true;
}

app.get('/api/roster-data', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, month } = req.query;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  // 回傳分享者班表+照片 → 加流量限制擋工號枚舉批撈（正常用戶看朋友頁只查幾次，60/分綽綽有餘）。
  if (!_rateLimit('rdata:' + (req.ip || req.socket.remoteAddress || '?'), 60, 60000)) {
    return res.status(429).json({ error: '請稍後再試 Too many requests' });
  }
  try {
    // 只有「開啟分享」的人其班表才可被查（與 roster-friends 一致）。退出所有群組/關閉分享者即使資料還在，
    //   也不會被 /api/roster-data 用 eid 撈出來（codex P1：補上 leave 不再刪資料後的隱私缺口）。
    const shareChk = await _pool.query('SELECT 1 FROM cs_users WHERE employee_id = $1 AND sharing = true', [eid]);
    if (shareChk.rowCount === 0) return res.json({ rosters: [], pictures: {} });
    const q = month
      ? await _pool.query('SELECT month, roster_data, updated_at FROM cs_rosters WHERE employee_id = $1 AND month = $2', [eid, month])
      : await _pool.query('SELECT month, roster_data, updated_at FROM cs_rosters WHERE employee_id = $1 ORDER BY month DESC LIMIT 3', [eid]);
    // 只回「這份班表裡實際出現的組員」的照片，而不是整張 cs_users（原本無條件回全體姓名/員編/照片＝一次撈走通訊錄）。
    const needIds = new Set<string>([String(eid)]);
    const collectIds = (o: any) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (const x of o) collectIds(x); return; }
      for (const k in o) {
        if ((k === 'staffId' || k === 'employee_id' || k === 'employeeId' || k === 'eid') && o[k]) needIds.add(String(o[k]));
        else collectIds(o[k]);
      }
    };
    for (const r of q.rows) collectIds(r.roster_data);
    const picMap: Record<string, { picture: string; name: string }> = {};
    const picQ = await _pool.query(
      'SELECT employee_id, picture, name FROM cs_users WHERE employee_id = ANY($1) AND picture IS NOT NULL',
      [Array.from(needIds)]
    );
    for (const r of picQ.rows) picMap[r.employee_id] = { picture: r.picture, name: r.name };
    res.json({ rosters: q.rows, pictures: picMap });
  } catch (e: any) {
    res.json({ error: 'query failed' });
  }
});

// ── Friends sharing API ──────────────────────────────────────────────────────
// 上傳分享班表
app.post('/api/roster-share', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, month, duties, crewName, nickname, fleet, rank, updateInfoOnly } = req.body;
  if (!eid) return res.status(400).json({ error: 'Missing eid' });
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: '請先重新同步班表驗證身份 Please re-sync to verify identity', authz: true });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: '請先重新同步班表驗證身份 Please re-sync to verify identity', authz: true });
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
  // 批量回傳分享者資料 → 加流量限制擋快速枚舉（正常用戶打開朋友頁只查幾次，60/分綽綽有餘）。
  if (!_rateLimit('friends:' + (req.ip || req.socket.remoteAddress || '?'), 60, 60000)) {
    return res.status(429).json({ error: '請稍後再試 Too many requests' });
  }
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
    res.json({ error: 'query failed' });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
  try {
    // 產生 8 碼邀請碼（重試避免碰撞）。舊的 4 碼群組碼照常能用；新碼提高 entropy 防暴力猜。
    let code = '';
    for (let i = 0; i < 10; i++) {
      code = randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
  // 防暴力猜邀請碼：每 IP 每分鐘最多 10 次嘗試（正常用戶輸一次就中，無感）。
  if (!_rateLimit('joincode:' + (req.ip || req.socket.remoteAddress || '?'), 10, 60000)) {
    return res.status(429).json({ error: '嘗試太頻繁，請稍後再試 Too many attempts' });
  }
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
  try {
    await _pool.query(`DELETE FROM cs_group_members WHERE group_id = $1 AND employee_id = $2`, [groupId, eid]);
    // 自動刪除 0 人的自訂群組
    if (groupId.startsWith('custom_')) {
      const cnt = await _pool.query(`SELECT COUNT(*) AS c FROM cs_group_members WHERE group_id = $1`, [groupId]);
      if (+cnt.rows[0].c === 0) {
        await _pool.query(`DELETE FROM cs_groups WHERE id = $1`, [groupId]);
      }
    }
    // 退出後如果不在任何群組了 → 關閉 sharing（不再對外顯示）。
    // ⚠ 不再「刪除班表資料」：原本會 DELETE cs_rosters，但那只靠 eid、任何人知道你員編就能觸發把你班表刪光（破壞性濫用）。
    //    改成只關 sharing、保留資料（sharing=false 時 roster-friends 本來就不會顯示）；要真的清資料應由本人專屬動作做。
    const remaining = await _pool.query(`SELECT COUNT(*) AS c FROM cs_group_members WHERE employee_id = $1`, [eid]);
    if (+remaining.rows[0].c === 0) {
      await _pool.query(`UPDATE cs_users SET sharing = false WHERE employee_id = $1`, [eid]);
    }
    res.json({ ok: true });
  } catch (e: any) { res.json({ error: e.message }); }
});

// 邀請人（輸入員工編號）
app.post('/api/groups/invite', async (req, res) => {
  if (!_pool) return res.json({ error: 'No database' });
  const { eid, groupId, targetEid } = req.body;
  if (!eid || !groupId || !targetEid) return res.status(400).json({ error: 'Missing fields' });
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
  // 健康檢查：只回 DB 是否可連線，不洩漏資料庫名稱／內部錯誤訊息給外部。
  if (!_pool) return res.json({ ok: false });
  try {
    await _pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

app.get('/api/calendar-events', async (req, res) => {
  try {
    const { start, end } = req.query as Record<string, string>;
    // refresh token 改從 header 帶（別進 URL/access log）；舊前端仍可走 query，過渡期相容。
    const refreshToken = String(req.headers['x-refresh-token'] || (req.query.refreshToken as string) || '');
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
      // 注意：完整成功的 'done' 不在這裡設 —— 延到 employee_id 連結（下方 UPDATE）完成後才設，
      //   否則前端一看到 done 立刻打 ATIS，員編還沒連上 → 吃短暫 403（gate 競態）。
      if (rosterResult.partial) {
        job.status = 'partial';
        (job as any).partialReason = rosterResult.errorSummary;
        (job as any).debugFiles = rosterResult.debugFiles || [];
        onLog(`⚠️ 部分成功（${rosterResult.duties.length} 筆）：${rosterResult.errorSummary || 'unknown'}`);
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
      // employee_id 連結（上方 UPDATE）已完成 → 現在才放 done，前端打 ATIS 必能過 gate（partial 不動）。
      if (!rosterResult.partial) job.status = 'done';
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
  if (!(await _writeAuthzEid(req, eid))) return res.status(403).json({ error: 'not_verified', authz: true });
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
${getSpaAtfmJs()}
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
