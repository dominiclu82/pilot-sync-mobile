// Morning Report PWA — 獨立掛載於 CrewSync 底下的每日晨報
// 所有 /morning、/api/morning-* 路由都收在這裡
// server.ts 只需要 import 並 app.use(morningRouter)

import express from 'express';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { ROOT } from './config.js';
import { buildMorningReport, fetchSection } from './morning-builder.js';
import { listUserSymbols } from './portfolio/queries.js';
import { APP_VERSION } from './version.js';
import { renderAppChangelog } from './app-changelog.js';

// V2.0.0: 統一版號 — 跟 Portfolio 共用 APP_VERSION。MORNING_VERSION alias 保留向後相容
export const MORNING_VERSION = APP_VERSION;
const MORNING_CACHE = 'morning-v2-0-17';

// ─── Postgres ────────────────────────────────────────────────────────
let _pgPool: pg.Pool | null = null;
let _pgReady = false;
function getPool() {
  if (!_pgPool && process.env.DATABASE_URL) {
    _pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return _pgPool;
}
export { getPool };

/** V1.0.15: 給 portfolio fx endpoint 用 — 讀 latest morning_reports 內 cached USD/TWD rate
 *  跟下方匯率 card 同源，user 不會看到 banner / fx card 數字不一致 */
export async function getCachedUsdTwdFromMorningReport(): Promise<number | null> {
  try {
    const pool = getPool();
    if (!pool) return null;
    const { rows } = await pool.query(
      `SELECT data FROM morning_reports ORDER BY date DESC, generated_at DESC LIMIT 1`
    );
    if (rows.length === 0) return null;
    const data: any = rows[0].data;
    const rate = data?.fx?.['USD/TWD']?.rate;
    return (typeof rate === 'number' && rate > 0) ? rate : null;
  } catch {
    return null;
  }
}

async function ensurePgTables() {
  if (_pgReady) return true;
  const pool = getPool();
  if (!pool) return false;
  try {
    // morning_reports：先建表（新 schema），若舊表存在則加上 user_id 欄位
    await pool.query(`
      CREATE TABLE IF NOT EXISTS morning_reports (
        user_id TEXT NOT NULL DEFAULT '__legacy',
        date DATE NOT NULL,
        data JSONB NOT NULL,
        generated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, date)
      );
    `);
    // Migration: 舊表沒 user_id 欄位 → 加上 (ALTER 安全，若欄位已存在無動作)
    await pool.query(`ALTER TABLE morning_reports ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '__legacy'`).catch(() => {});
    // 若原本 PK 只有 date，需要重建 PK 包含 user_id（會失敗若 PK 正確）
    try {
      await pool.query(`ALTER TABLE morning_reports DROP CONSTRAINT IF EXISTS morning_reports_pkey`);
      await pool.query(`ALTER TABLE morning_reports ADD PRIMARY KEY (user_id, date)`);
    } catch (e) { /* 已經是正確 PK 就忽略 */ }

    // morning_prefs：每個使用者一筆
    await pool.query(`
      CREATE TABLE IF NOT EXISTS morning_prefs (
        user_id TEXT PRIMARY KEY,
        prefs JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Migration: 加上 last_seen_at 追蹤使用者實際開 app 的時間
    await pool.query(`ALTER TABLE morning_prefs ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`).catch(() => {});

    // V2.0.03 一次性清理：晨報不再保留歷史，每位使用者只留最新一筆。
    // self-join 刪除「同 user 有更新一筆 b 比 a 新」的 a；已只剩 1 筆者不受影響（idempotent）。
    // morning_prefs（使用者天氣 / 選股設定）是另一張表，完全不動。
    try {
      const cleanup = await pool.query(`
        DELETE FROM morning_reports a USING morning_reports b
         WHERE a.user_id = b.user_id AND a.date < b.date
      `);
      if (cleanup.rowCount && cleanup.rowCount > 0) {
        console.log('[morning] history cleanup: deleted ' + cleanup.rowCount + ' old report rows (kept latest per user)');
      }
    } catch (e) {
      console.warn('[morning] history cleanup failed:', e instanceof Error ? e.message : String(e));
    }

    _pgReady = true;
    return true;
  } catch (e) {
    console.warn('[morning] ensurePgTables failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ─── 每個使用者的資料讀寫 ────────────────────────────────────────────
// 取得指定使用者某日的快照（多使用者模式，不使用共享檔案 fallback）
async function getReportByDate(userId: string, date: string) {
  const pool = getPool();
  if (pool && await ensurePgTables()) {
    try {
      const r = await pool.query(
        'SELECT data FROM morning_reports WHERE user_id = $1 AND date = $2',
        [userId, date]
      );
      if (r.rows.length > 0) return r.rows[0].data;
    } catch (e) {
      console.warn('[morning] getReportByDate db error:', e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function getLatestDate(userId: string) {
  const pool = getPool();
  if (pool && await ensurePgTables()) {
    try {
      const r = await pool.query(
        'SELECT date::text FROM morning_reports WHERE user_id = $1 ORDER BY date DESC LIMIT 1',
        [userId]
      );
      if (r.rows.length > 0) return r.rows[0].date;
    } catch (e) {}
  }
  return null;
}

async function getAllDates(userId: string): Promise<string[]> {
  const pool = getPool();
  if (pool && await ensurePgTables()) {
    try {
      const r = await pool.query(
        'SELECT date::text FROM morning_reports WHERE user_id = $1 ORDER BY date DESC',
        [userId]
      );
      return r.rows.map((row: any) => row.date);
    } catch (e) {}
  }
  return [];
}

async function saveReport(userId: string, date: string, data: any) {
  const pool = getPool();
  if (pool && await ensurePgTables()) {
    try {
      // V2.0.03：晨報不再保留歷史 — 每位使用者最多 1 筆（最新那份）。
      // upsert 完之後把同 user 其他日期的舊報告刪掉，避免無限累積（DB 第一名肥大來源）。
      await pool.query(
        `INSERT INTO morning_reports (user_id, date, data, generated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, date)
         DO UPDATE SET data = EXCLUDED.data, generated_at = NOW()`,
        [userId, date, JSON.stringify(data)]
      );
      await pool.query(`DELETE FROM morning_reports WHERE user_id = $1 AND date <> $2`, [userId, date]);
      console.log('[morning] saved to Postgres (kept latest only):', userId, date);
      return true;
    } catch (e) {
      console.warn('[morning] saveReport db error:', e instanceof Error ? e.message : String(e));
    }
  }
  ensureDataDir();
  try {
    fs.writeFileSync(path.join(DATA_DIR, `${date}.json`), JSON.stringify(data, null, 2), 'utf-8');
    console.log('[morning] saved to local JSON:', date);
    return true;
  } catch (e) {
    console.warn('[morning] saveReport local error:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ─── 使用者偏好讀寫 (morning_prefs) ──────────────────────────────────
interface HoldingMap { [code: string]: { qty: number; cost: number } }
interface UserPrefs {
  wx?: Array<{ name: string; lat: number; lon: number }>;  // [{name,lat,lon},...]
  tw?: string[];  // 股票代號
  us?: string[];
  fx?: string[];  // 貨幣對 'USD/TWD'
  tw_holdings?: HoldingMap;  // 台股持倉 { code: { qty, cost } }
  us_holdings?: HoldingMap;  // 美股持倉
  fx_decimals?: number;  // 匯率換算結果小數位數 0/2/4（跨裝置同步的顯示偏好）
}

async function getPrefs(userId: string): Promise<UserPrefs | null> {
  const pool = getPool();
  if (pool && await ensurePgTables()) {
    try {
      const r = await pool.query('SELECT prefs FROM morning_prefs WHERE user_id = $1', [userId]);
      if (r.rows.length > 0) return r.rows[0].prefs;
    } catch (e) {
      console.warn('[morning] getPrefs db error:', e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function savePrefs(userId: string, prefs: UserPrefs): Promise<boolean> {
  const pool = getPool();
  if (pool && await ensurePgTables()) {
    try {
      await pool.query(
        `INSERT INTO morning_prefs (user_id, prefs, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = NOW()`,
        [userId, JSON.stringify(prefs)]
      );
      return true;
    } catch (e) {
      console.warn('[morning] savePrefs db error:', e instanceof Error ? e.message : String(e));
    }
  }
  return false;
}

// 觸發 last_seen_at 更新（使用者開 app 時呼叫）
async function touchLastSeen(userId: string) {
  const pool = getPool();
  if (!pool || !(await ensurePgTables())) return;
  try {
    await pool.query('UPDATE morning_prefs SET last_seen_at = NOW() WHERE user_id = $1', [userId]);
  } catch (e) {
    // 沒建 row 就略過，等使用者第一次存 prefs 後才會有 row
  }
}

async function getAllUserPrefs(): Promise<Array<{ userId: string; prefs: UserPrefs }>> {
  const pool = getPool();
  if (pool && await ensurePgTables()) {
    try {
      const r = await pool.query('SELECT user_id, prefs FROM morning_prefs');
      return r.rows.map((row: any) => ({ userId: row.user_id, prefs: row.prefs }));
    } catch (e) {
      console.warn('[morning] getAllUserPrefs error:', e instanceof Error ? e.message : String(e));
    }
  }
  return [];
}

// 正規化 userId：trim、限制長度；空字串/過長 → null
function normalizeUserId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (t.length < 2 || t.length > 20) return null;
  if (t.startsWith('__')) return null;  // 保留 __legacy 等系統前綴
  return t;
}

// ─── 建構鎖 ──────────────────────────────────────────────────────────
let _buildInProgress = false;
let _lastBuildAt = 0;  // Unix ms，cron 內部用來決定 retry backoff

// 給某個使用者的 prefs 抓資料並存成該使用者的當日快照
async function buildForUser(userId: string, prefs: UserPrefs) {
  const report = await buildMorningReport({
    wxLocs: prefs.wx || [],
    twCodes: prefs.tw || [],
    usCodes: prefs.us || [],
    fxPairs: prefs.fx || [],
  });
  await saveReport(userId, report.date, report);
  return report;
}

// 從 union 快照中擷取某使用者要的子集
function extractUserSubset(unionReport: any, prefs: UserPrefs) {
  const subset: any = {
    date: unionReport.date,
    generated_at: unionReport.generated_at,
    weather: [],
    weather_fetched_at: unionReport.weather_fetched_at,
    stocks_tw: {},
    stocks_tw_fetched_at: unionReport.stocks_tw_fetched_at,
    stocks_us: {},
    stocks_us_fetched_at: unionReport.stocks_us_fetched_at,
    fx: {},
    fx_fetched_at: unionReport.fx_fetched_at,
    news_tw: unionReport.news_tw || [],
    news_world: unionReport.news_world || [],
    build_errors: unionReport.build_errors,
  };
  // 依 prefs.wx 的順序挑出
  const wxByName: any = {};
  (unionReport.weather || []).forEach((w: any) => { if (w && w.name) wxByName[w.name] = w; });
  for (const loc of (prefs.wx || [])) {
    if (wxByName[loc.name]) subset.weather.push(wxByName[loc.name]);
  }
  for (const code of (prefs.tw || [])) {
    if (unionReport.stocks_tw && unionReport.stocks_tw[code]) subset.stocks_tw[code] = unionReport.stocks_tw[code];
  }
  for (const code of (prefs.us || [])) {
    if (unionReport.stocks_us && unionReport.stocks_us[code]) subset.stocks_us[code] = unionReport.stocks_us[code];
  }
  for (const pair of (prefs.fx || [])) {
    if (unionReport.fx && unionReport.fx[pair]) subset.fx[pair] = unionReport.fx[pair];
  }
  return subset;
}

// 等 _buildInProgress 釋放，最多等 15 秒（避免 503 與 cron 衝突）
async function waitForLock(maxMs = 15000) {
  const start = Date.now();
  while (_buildInProgress) {
    if (Date.now() - start > maxMs) return false;
    await new Promise(r => setTimeout(r, 200));
  }
  return true;
}

// 單一使用者模式：抓該使用者的 prefs 重建
async function runBuildUser(userId: string) {
  if (!await waitForLock()) return { ok: false, reason: 'lock_timeout' };
  _buildInProgress = true;
  try {
    const prefs = await getPrefs(userId);
    if (!prefs) return { ok: false, reason: 'no_prefs' };
    const report = await buildForUser(userId, prefs);
    _lastBuildAt = Date.now();
    return { ok: true, date: report.date, errors: (report as any).build_errors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[morning] runBuildUser error:', userId, msg);
    return { ok: false, reason: 'error', error: msg };
  } finally {
    _buildInProgress = false;
  }
}

// 全站模式（cron 每日呼叫）：取 union 抓一次、分發給所有使用者
async function runBuildAll() {
  if (_buildInProgress) return { ok: false, reason: 'already_running' };
  _buildInProgress = true;
  try {
    const allPrefs = await getAllUserPrefs();
    if (allPrefs.length === 0) {
      console.log('[morning] runBuildAll: no users with prefs, skipping');
      _lastBuildAt = Date.now();
      return { ok: true, users: 0 };
    }
    // V1.3.15: augment each user's tw/us with portfolio holdings symbols
    // 晨報 stocks section 自動 include user 在 portfolio 持倉的 symbol，
    // 即便 user 沒手動加進自選 list (user 反映「沒選到的庫存,你不能幫使用者新增嗎」)
    for (const userEntry of allPrefs) {
      try {
        const portSymbols = await listUserSymbols(userEntry.userId);
        const portTw = portSymbols.filter(s => s.market === 'TW').map(s => s.symbol);
        const portUs = portSymbols.filter(s => s.market === 'US').map(s => s.symbol);
        if (portTw.length > 0 || portUs.length > 0) {
          userEntry.prefs.tw = Array.from(new Set([...(userEntry.prefs.tw || []), ...portTw]));
          userEntry.prefs.us = Array.from(new Set([...(userEntry.prefs.us || []), ...portUs]));
        }
      } catch (e) { /* silent — fallback to prefs only */ }
    }
    // 計算 union
    const wxMap = new Map<string, { name: string; lat: number; lon: number }>();
    const twSet = new Set<string>();
    const usSet = new Set<string>();
    const fxSet = new Set<string>();
    for (const { prefs } of allPrefs) {
      (prefs.wx || []).forEach(w => wxMap.set(`${w.name}|${w.lat}|${w.lon}`, w));
      (prefs.tw || []).forEach(c => twSet.add(c));
      (prefs.us || []).forEach(c => usSet.add(c));
      (prefs.fx || []).forEach(p => fxSet.add(p));
    }
    console.log(`[morning] runBuildAll: ${allPrefs.length} users, union wx=${wxMap.size} tw=${twSet.size} us=${usSet.size} fx=${fxSet.size}`);
    // 防呆：union 全空（可能是 prefs 被誤洗）→ 不跑 build、不標記，等下個 tick 或使用者觸發 recovery
    if (wxMap.size === 0 && twSet.size === 0 && usSet.size === 0 && fxSet.size === 0) {
      console.warn('[morning] runBuildAll: union is empty across all users, skipping build (prefs may be wiped)');
      return { ok: false, reason: 'empty_union' };
    }
    // 一次抓 union
    const unionReport = await buildMorningReport({
      wxLocs: Array.from(wxMap.values()),
      twCodes: Array.from(twSet),
      usCodes: Array.from(usSet),
      fxPairs: Array.from(fxSet),
    });
    // 分發給每個使用者
    for (const { userId, prefs } of allPrefs) {
      const subset = extractUserSubset(unionReport, prefs);
      await saveReport(userId, unionReport.date, subset);
    }
    _lastBuildAt = Date.now();
    return { ok: true, date: unionReport.date, users: allPrefs.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[morning] runBuildAll error:', msg);
    return { ok: false, reason: 'error', error: msg };
  } finally {
    _buildInProgress = false;
  }
}

// ─── Cron 排程 ───────────────────────────────────────────────────────
// 每分鐘檢查：如果現在 > 06:30 台北時間且今天還沒資料，去跑
function taipeiNow() {
  const now = new Date();
  return new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
}
function taipeiDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

let _cronStarted = false;
let _cronLastRunDate = '';  // 最後一次「官方每日觸發」跑的日期，用來確保每天正式版只跑一次
async function cronTick() {
  const tpe = taipeiNow();
  const hour = tpe.getHours();
  const minute = tpe.getMinutes();
  const today = taipeiDateStr(tpe);

  // 早於 06:30 → 完全不做任何事
  if (hour < 6 || (hour === 6 && minute < 30)) return;

  // 今天還沒跑過 → 跑全站建構（所有使用者）
  if (_cronLastRunDate !== today) {
    // 5 分鐘失敗退避（只限有跑過的情況）
    if (_cronLastRunDate && Date.now() - _lastBuildAt < 5 * 60 * 1000) return;
    console.log('[morning] cron daily trigger (build all users)', today);
    const result = await runBuildAll();
    if (result.ok) {
      _cronLastRunDate = today;
    } else {
      // 失敗就不標記，下個 tick（1 分鐘後）會再試（有 5 分鐘退避）
      console.warn('[morning] cron runBuildAll failed:', result);
    }
  }
}

export function startMorningCron() {
  if (_cronStarted) return;
  _cronStarted = true;

  // 啟動時立刻跑一次 cronTick（補跑錯過的 06:30）
  (async () => {
    try {
      const tpe = taipeiNow();
      const pastCutoff = tpe.getHours() > 6 || (tpe.getHours() === 6 && tpe.getMinutes() >= 30);
      if (pastCutoff) {
        console.log('[morning] startup: running cronTick for recovery');
        await cronTick();
      } else {
        console.log('[morning] startup: before 06:30, cron will wait');
      }
    } catch (e) {
      console.warn('[morning] startup recovery error:', e instanceof Error ? e.message : String(e));
    }
  })();

  // 之後每分鐘檢查
  setInterval(() => { cronTick().catch(e => console.warn('[morning] cron tick error:', e)); }, 60 * 1000);
  console.log('[morning] cron started');
}

const DATA_DIR = path.join(ROOT, 'data', 'morning');

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

// 取得台北時區的今天日期 YYYY-MM-DD
function todayTaipei() {
  const now = new Date();
  const tpe = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  const y = tpe.getFullYear();
  const m = String(tpe.getMonth() + 1).padStart(2, '0');
  const d = String(tpe.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const morningRouter = express.Router();

// ─── /morning — SPA 主頁 ──────────────────────────────────────────────
morningRouter.get('/morning', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // no-store 在 iOS WebKit 會擋 CacheStorage（離線殼存不進去）→ 改 no-cache：仍每次 revalidate 拿最新版，但可存離線副本（codex 診斷）。
  res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
  res.send(getMorningHtml());
});

// ─── /morning/manifest.json ──────────────────────────────────────────
morningRouter.get('/morning/manifest.json', (_req, res) => {
  res.json({
    name: '今日 Today',
    short_name: '今日',
    description: '天氣、股市、匯率、新聞一眼看完',
    start_url: '/morning',
    scope: '/morning/',
    display: 'standalone',
    background_color: '#0B1428',
    theme_color: '#1E2740',
    icons: [
      { src: '/morning/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  });
});

// ─── /morning/icon.svg — 今日報紙 + 金色行情線 ───────────────────────
morningRouter.get('/morning/icon.svg', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(MORNING_ICON_SVG);
});

// ─── /morning/sw.js — 獨立 Service Worker ────────────────────────────
morningRouter.get('/morning/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/morning/');
  res.send(`
const CACHE = '${MORNING_CACHE}';
const SHELL = ['/morning', '/morning/manifest.json', '/morning/icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(SHELL.map(url =>
      fetch(url, {cache:'no-store'}).then(r => c.put(url, r)).catch(()=>{})
    )))
  );
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k.startsWith('morning-') && k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  // 只處理 /morning/ 範圍
  if (!u.pathname.startsWith('/morning') && !u.pathname.startsWith('/api/morning')) return;
  // API 走網路優先、失敗用 cache
  if (u.pathname.startsWith('/api/morning')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{});
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // 頁面資源走 cache 優先、背景更新
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(r => {
        caches.open(CACHE).then(c => c.put(e.request, r.clone())).catch(()=>{});
        return r;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
`);
});

// 從 request 取得 userId（X-User-Id header 或 ?uid= query param）
// header 值是 URL-encoded（因為非 ASCII 暱稱不能直接放 header）
function reqUserId(req: express.Request): string | null {
  const raw = req.header('X-User-Id') || req.query.uid;
  const str = Array.isArray(raw) ? String(raw[0]) : (raw as string | undefined);
  if (!str) return null;
  let decoded = str;
  try { decoded = decodeURIComponent(str); } catch (e) { /* 不是 encoded 就原樣用 */ }
  return normalizeUserId(decoded);
}

// ─── /api/morning-report?date=YYYY-MM-DD ─────────────────────────────
morningRouter.get('/api/morning-report', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
    // 記錄 last_seen_at（fire-and-forget，不影響主流程）
    touchLastSeen(userId).catch(() => {});
    let date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      date = (await getLatestDate(userId)) || todayTaipei();
    }
    const data = await getReportByDate(userId, date);
    if (!data) {
      const latest = await getLatestDate(userId);
      if (latest && latest !== date) {
        const fallbackData = await getReportByDate(userId, latest);
        if (fallbackData) {
          return res.json({ ...fallbackData, _requestedDate: date, _actualDate: latest, _fallback: true });
        }
      }
      return res.status(404).json({ error: 'no_data', date });
    }
    res.json({ ...data, _requestedDate: date, _actualDate: date });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

// ─── /api/morning-report/dates — V2.0.03：歷史功能已移除（每位 user 只留最新一份）
// 端點保留向後相容，永遠回空陣列，避免舊版前端撞 404。
morningRouter.get('/api/morning-report/dates', async (_req, res) => {
  res.json({ dates: [] });
});

// ─── POST /api/morning-prefs — 使用者儲存/更新自己的設定（merge 模式，只更新 body 裡有的欄位） ────────────
morningRouter.post('/api/morning-prefs', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
    const body = req.body || {};
    // 先讀出現有的 prefs，再 merge（避免部分更新誤覆蓋其他欄位）
    const existing: any = (await getPrefs(userId)) || {};
    const merged: any = { ...existing };
    if (Array.isArray(body.wx)) merged.wx = body.wx.filter((w: any) => w && w.name && typeof w.lat === 'number' && typeof w.lon === 'number');
    if (Array.isArray(body.tw)) merged.tw = body.tw.filter((c: any) => typeof c === 'string');
    if (Array.isArray(body.us)) merged.us = body.us.filter((c: any) => typeof c === 'string');
    if (Array.isArray(body.fx)) merged.fx = body.fx.filter((c: any) => typeof c === 'string');
    if (Array.isArray(body.secOrder)) merged.secOrder = body.secOrder.filter((s: any) => typeof s === 'string');
    if (Array.isArray(body.newsCatOrder)) merged.newsCatOrder = body.newsCatOrder.filter((s: any) => typeof s === 'string');
    // Holdings：物件 { code: { qty:number, cost:number } }
    const cleanHoldings = (h: any) => {
      if (!h || typeof h !== 'object') return null;
      const out: any = {};
      for (const k of Object.keys(h)) {
        const v = h[k];
        if (v && typeof v === 'object') {
          const qty = Number(v.qty);
          const cost = Number(v.cost);
          if (!isNaN(qty) && !isNaN(cost)) out[String(k)] = { qty, cost };
        }
      }
      return out;
    };
    if (body.tw_holdings !== undefined) {
      const c = cleanHoldings(body.tw_holdings);
      if (c) merged.tw_holdings = c;
    }
    if (body.us_holdings !== undefined) {
      const c = cleanHoldings(body.us_holdings);
      if (c) merged.us_holdings = c;
    }
    if (body.fx_decimals !== undefined) {
      const d = Number(body.fx_decimals);
      if ([0, 2, 4].includes(d)) merged.fx_decimals = d;
    }
    const saved = await savePrefs(userId, merged);
    if (!saved) return res.status(503).json({ error: 'save_failed' });
    res.json({ ok: true, userId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

// ─── GET /api/morning-prefs — 使用者取回自己的設定（跨裝置同步用） ────
// V1.3.16: prefs.tw / prefs.us 在 return 前 union user portfolio holdings symbols,
// 這樣 frontend render stocks section iterate 自然 include 持倉 (即便沒手動加自選)
morningRouter.get('/api/morning-prefs', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
    const prefs = await getPrefs(userId);
    if (!prefs) return res.status(404).json({ error: 'no_prefs' });
    // Augment with portfolio symbols (silent fallback on error)
    try {
      const portSymbols = await listUserSymbols(userId);
      const portTw = portSymbols.filter(s => s.market === 'TW').map(s => s.symbol);
      const portUs = portSymbols.filter(s => s.market === 'US').map(s => s.symbol);
      if (portTw.length > 0) prefs.tw = Array.from(new Set([...(prefs.tw || []), ...portTw]));
      if (portUs.length > 0) prefs.us = Array.from(new Set([...(prefs.us || []), ...portUs]));
    } catch (e) { /* silent */ }
    res.json(prefs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

// ─── GET /api/morning-reader — 雙語閱讀器（抓原文 → 擷取正文 → 逐段翻譯） ────
const _readerCache = new Map<string, { data: any; at: number }>();
const READER_CACHE_TTL = 60 * 60 * 1000;  // 1 小時快取

async function translateParagraph(text: string): Promise<string> {
  if (!text || text.trim().length === 0) return '';
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return (data[0] as any[]).map((seg: any) => seg[0]).join('');
    }
    return '';
  } catch (e) { return ''; }
}

morningRouter.get('/api/morning-reader', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: 'missing url' });

    // Check cache
    const cached = _readerCache.get(rawUrl);
    if (cached && Date.now() - cached.at < READER_CACHE_TTL) {
      return res.json(cached.data);
    }

    // Fetch the article (follow redirects — Google News URLs redirect to actual article)
    const articleRes = await fetch(rawUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
      redirect: 'follow',
    });
    if (!articleRes.ok) return res.status(502).json({ error: 'fetch_failed', status: articleRes.status });
    const html = await articleRes.text();

    // Parse with JSDOM + Readability to extract article content
    const dom = new JSDOM(html, { url: articleRes.url || rawUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article || !article.textContent) {
      return res.status(422).json({ error: 'cannot_extract', message: '無法擷取文章正文' });
    }

    // 用 HTML content 的 <p> tag 分段（比 textContent 的 \n 更精確）
    const contentHtml = article.content || '';
    const pTagRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    const rawParagraphs: string[] = [];
    let pMatch;
    while ((pMatch = pTagRegex.exec(contentHtml)) !== null) {
      // 去掉 HTML tag，只留文字
      const text = pMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text.length > 30) rawParagraphs.push(text);  // 太短的跳過（caption、byline）
    }
    // 如果 <p> 分段太少，fallback 到 textContent 的 \n 分段
    if (rawParagraphs.length < 3 && article.textContent) {
      rawParagraphs.length = 0;
      article.textContent.split(/\n+/).forEach((line: string) => {
        const t = line.replace(/\s+/g, ' ').trim();
        if (t.length > 30) rawParagraphs.push(t);
      });
    }

    // 批次翻譯：用分隔符號合併多段一次翻、再拆回來（50 段 → 3-5 次 call，快 10 倍）
    const BATCH_SEP = ' ||| ';
    const BATCH_SIZE = 15;  // 每批最多 15 段（避免超過 Google Translate 字數限制）
    const paragraphs: Array<{ en: string; zh: string }> = [];
    for (let i = 0; i < rawParagraphs.length; i += BATCH_SIZE) {
      const batch = rawParagraphs.slice(i, i + BATCH_SIZE);
      const combined = batch.join(BATCH_SEP);
      const translatedCombined = await translateParagraph(combined);
      const translatedParts = translatedCombined.split(/\s*\|\|\|\s*/);
      for (let j = 0; j < batch.length; j++) {
        paragraphs.push({
          en: batch[j],
          zh: (translatedParts[j] || '').trim() || '（翻譯失敗）',
        });
      }
    }

    // Translate title
    const titleZh = await translateParagraph(article.title || '');

    const result = {
      title: article.title || '',
      title_zh: titleZh,
      source: articleRes.url || rawUrl,
      paragraphs,
      excerpt: article.excerpt || '',
    };

    // Cache
    _readerCache.set(rawUrl, { data: result, at: Date.now() });
    // Cleanup old cache entries
    if (_readerCache.size > 100) {
      const now = Date.now();
      for (const [k, v] of _readerCache) {
        if (now - v.at > READER_CACHE_TTL) _readerCache.delete(k);
      }
    }

    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

// ─── POST /api/morning-report/refresh — 手動觸發重建（只重建該使用者） ────
morningRouter.post('/api/morning-report/refresh', async (req, res) => {
  const userId = reqUserId(req);
  if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
  // 如果沒 prefs（新使用者第一次），先用 body 初始化一份 prefs 再 build
  const body = req.body || {};
  const hasInitPrefs = body && (Array.isArray(body.wx) || Array.isArray(body.tw) || Array.isArray(body.us) || Array.isArray(body.fx));
  if (hasInitPrefs) {
    const prefs: UserPrefs = {
      wx: Array.isArray(body.wx) ? body.wx.filter((w: any) => w && w.name && typeof w.lat === 'number' && typeof w.lon === 'number') : [],
      tw: Array.isArray(body.tw) ? body.tw.filter((c: any) => typeof c === 'string') : [],
      us: Array.isArray(body.us) ? body.us.filter((c: any) => typeof c === 'string') : [],
      fx: Array.isArray(body.fx) ? body.fx.filter((c: any) => typeof c === 'string') : [],
    };
    await savePrefs(userId, prefs);
  }
  const result = await runBuildUser(userId);
  if (result.ok) {
    res.json({ ok: true, date: result.date, errors: result.errors });
  } else {
    res.status(503).json(result);
  }
});

// ─── POST /api/morning-report/refresh-partial — 只重抓指定區塊 ────
// body: { section: 'weather'|'stocks_tw'|'stocks_us'|'fx' }
morningRouter.post('/api/morning-report/refresh-partial', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
    const section = String((req.body && req.body.section) || '');
    if (!['weather', 'stocks_tw', 'stocks_us', 'fx'].includes(section)) {
      return res.status(400).json({ error: 'invalid_section' });
    }
    const prefs = await getPrefs(userId);
    if (!prefs) return res.status(404).json({ error: 'no_prefs' });
    const today = todayTaipei();
    const existing = (await getReportByDate(userId, today)) || {};
    // 天氣改由前端「手機自己抓」（繞開 Render 共用 IP 的 Open-Meteo 限流）：
    // 若 body 帶 data 陣列 → 伺服器只負責存、不再自己 call Open-Meteo。
    const clientData = req.body && req.body.data;
    let value: any;
    if (section === 'weather' && Array.isArray(clientData)
        && clientData.length <= 300
        && clientData.every((w: any) => w && typeof w.name === 'string')) {
      value = clientData;
    } else {
      // 其餘區塊（股票/匯率）+ 天氣沒帶 data 的退路：照舊伺服器抓
      const opts: any = {};
      if (section === 'weather') opts.wxLocs = prefs.wx || [];
      if (section === 'stocks_tw') opts.twCodes = prefs.tw || [];
      if (section === 'stocks_us') opts.usCodes = prefs.us || [];
      if (section === 'fx') opts.fxPairs = prefs.fx || [];
      value = await fetchSection(section, opts);
    }
    const nowIso = new Date().toISOString();
    const merged: any = { ...existing, date: today, generated_at: nowIso };
    merged[section] = value;
    merged[section + '_fetched_at'] = nowIso;
    await saveReport(userId, today, merged);
    res.json({ ok: true, section, date: today });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[morning] refresh-partial error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ─── /api/morning-translate?q=... — Google Translate 免費代理 ─────────
morningRouter.get('/api/morning-translate', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const tl = String(req.query.tl || 'zh-TW');
    if (!q) return res.json({ translated: '' });
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const translated = Array.isArray(data) && Array.isArray(data[0])
      ? data[0].map((seg) => seg[0]).join('')
      : q;
    res.json({ translated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.json({ translated: String(req.query.q || ''), error: msg });
  }
});

// ════════════════════════════════════════════════════════════════════
// SVG Icon — 破曉藍金（報紙捲軸 + 太陽）
// ════════════════════════════════════════════════════════════════════
const MORNING_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0B1428"/>
      <stop offset="100%" stop-color="#1E2740"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="rotate(-3 256 256)">
    <rect x="132" y="120" width="248" height="290" rx="14" fill="#FDFCF5"/>
    <text x="256" y="180" text-anchor="middle" font-family="Georgia,'Noto Serif TC',serif" font-weight="800" font-size="56" fill="#1F2D3D">今日</text>
    <rect x="156" y="198" width="200" height="4" fill="#1F2D3D"/>
    <rect x="156" y="216" width="92" height="5" rx="2" fill="#9AA7B8"/>
    <rect x="156" y="228" width="92" height="5" rx="2" fill="#9AA7B8"/>
    <rect x="156" y="240" width="70" height="5" rx="2" fill="#9AA7B8"/>
    <rect x="264" y="216" width="92" height="5" rx="2" fill="#9AA7B8"/>
    <rect x="264" y="228" width="92" height="5" rx="2" fill="#9AA7B8"/>
    <rect x="264" y="240" width="74" height="5" rx="2" fill="#9AA7B8"/>
    <rect x="156" y="262" width="200" height="130" rx="6" fill="#0B1428"/>
    <polyline points="168,360 200,338 230,348 262,308 296,322 330,276 344,288" fill="none" stroke="#F4C430" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="344" cy="288" r="8" fill="#F4C430"/>
  </g>
</svg>`;

// ════════════════════════════════════════════════════════════════════
// Morning SPA HTML（單檔內聯，跟 CrewSync 同風格）
// ════════════════════════════════════════════════════════════════════
function getMorningHtml() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="今日">
<meta name="theme-color" content="#1E2740">
<title>今日 Today</title>
<link rel="manifest" href="/morning/manifest.json">
<link rel="icon" href="/morning/icon.svg">
<link rel="apple-touch-icon" href="/morning/icon.svg">
<style>
:root {
  --bg: #0B1428;
  --bg2: #111c36;
  --card: #1a2540;
  --card2: #243252;
  --text: #e8ecf5;
  --muted: #8a96b0;
  --accent: #F4C430;
  --accent2: #F4A261;
  --up: #ff5555;
  --down: #2ecc71;
  --border: rgba(255,255,255,0.08);
  --hdr-grad-1: #1E2740;
  --hdr-grad-2: #141c33;
  --nav-bg: rgba(15,22,45,0.92);
}
[data-theme="light"] {
  --bg: #f5f7fa;
  --bg2: #ffffff;
  --card: #ffffff;
  --card2: #f0f3f8;
  --text: #1a2540;
  --muted: #6b7a8f;
  --accent: #c97e15;
  --accent2: #e76f51;
  --up: #d63031;
  --down: #00a65e;
  --border: rgba(0,0,0,0.1);
  --hdr-grad-1: #ffe9c9;
  --hdr-grad-2: #ffd59e;
  --nav-bg: rgba(255,255,255,0.92);
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html { font-size: 15px; overscroll-behavior: none; }
/* 狀態列那塊鋪不透明底（同 CrewSync）：透明狀態列下捲動內容不透到狀態列區。 */
html::before { content:''; position:fixed; top:0; left:0; right:0; height:env(safe-area-inset-top,0px); background:var(--bg); z-index:9999; pointer-events:none; }
body {
  margin: 0; padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans TC', sans-serif;
  font-size: 1rem;
  line-height: 1.5;
  min-height: 100vh;
  padding-bottom: env(safe-area-inset-bottom);
  overflow-x: hidden;            /* 比照 CrewSync：擋住橫向捲動，避免 modal/長字串造成空白橫滑 */
  overscroll-behavior: none;
}
a { color: var(--accent); text-decoration: none; }
a:active { opacity: 0.6; }

/* Sticky stack (header + nav move together) */
.top-stack {
  position: sticky;
  top: 0;
  z-index: 50;
}

/* Header */
.hdr {
  background: linear-gradient(180deg, var(--hdr-grad-1) 0%, var(--hdr-grad-2) 100%);
  padding: calc(env(safe-area-inset-top) + 10px) 12px 8px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.hdr-title { font-size: 1.15em; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.hdr-title .emoji { font-size: 1.2em; }
.hdr-title .ver {
  font-size: .55em;
  font-weight: 600;
  color: var(--accent);
  background: rgba(244,196,48,0.12);
  border: 1px solid rgba(244,196,48,0.3);
  padding: 2px 7px;
  border-radius: 8px;
  cursor: pointer;
  letter-spacing: .02em;
}
.hdr-title .ver:active { opacity: .7; }
.hdr-date { font-size: .85em; color: var(--muted); font-variant-numeric: tabular-nums; }
.hdr-btns { display: flex; gap: 6px; flex-shrink: 0; }
.hdr-btn {
  background: rgba(255,255,255,0.08);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 9px;
  border-radius: 8px;
  font-size: .82em;
  cursor: pointer;
  min-width: 34px;
  line-height: 1.1;
}
.hdr-btn:active { opacity: 0.7; }

/* Compound font-scale button (A+/A- stacked, separated) */
.hdr-btn-font {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.hdr-btn-font button {
  background: rgba(255,255,255,0.08);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 3px 8px;
  font-size: .62em;
  font-weight: 700;
  cursor: pointer;
  line-height: 1.1;
  min-width: 30px;
  border-radius: 6px;
}
.hdr-btn-font button:active { opacity: 0.7; }
/* V2.4.xx 日夜：直立分段膠囊（☀️上/🌙下），浮標純 CSS 隨 [data-theme] 上下滑＝現況 */
.theme-seg{position:relative;display:inline-flex;flex-direction:column;width:30px;height:40px;padding:3px;border-radius:14px;background:var(--card);border:1px solid var(--border);cursor:pointer;flex:0 0 auto;margin-right:4px}
.theme-seg-knob{position:absolute;left:3px;right:3px;top:3px;height:calc(50% - 3px);border-radius:12px;background:var(--accent);transition:transform .22s ease;pointer-events:none;transform:translateY(100%)}
[data-theme="light"] .theme-seg-knob{transform:translateY(0)}
.theme-seg-opt{position:relative;z-index:1;flex:1;display:flex;align-items:center;justify-content:center;background:none;border:0;padding:0;font-size:.92em;line-height:1;cursor:pointer}

/* Nav bar (fixed under header) */
.nav {
  background: var(--nav-bg);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.nav::-webkit-scrollbar { display: none; }
.nav-btn {
  flex: 0 0 auto;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 12px;
  border-radius: 20px;
  font-size: .78em;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background .15s, border-color .15s;
}
.nav-btn:active { opacity: .6; }
.nav-btn.active {
  background: rgba(244,196,48,0.15);
  border-color: rgba(244,196,48,0.5);
  color: var(--accent);
}
.nav-btn.nav-dragging {
  opacity: 0.5;
  transform: scale(1.1);
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.nav-btn.nav-drag-over {
  border-left: 3px solid var(--accent);
}

/* Section card */
.sec {
  margin: 14px 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  scroll-margin-top: calc(var(--top-stack-h, 120px) + 8px);
}
.sec-h {
  padding: 10px 10px 8px 6px;
  font-size: .95em;
  font-weight: 700;
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--border);
  user-select: none;
  gap: 6px;
}
.sec-h .icon { font-size: 1.1em; margin-right: 4px; }
.sec-h .sec-left { display: flex; align-items: center; flex: 1; min-width: 0; cursor: pointer; }
.sec-h .sec-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

/* Drag handle */
.sec-drag {
  cursor: grab;
  color: var(--muted);
  font-size: 1.1em;
  padding: 4px 6px;
  line-height: 1;
  opacity: 0.5;
  touch-action: none;
}
.sec-drag:active { cursor: grabbing; opacity: 1; }

/* 主畫面 item-level drag（wx/tw/us/fx 各自可拖移排序） */
.item-drag {
  cursor: grab;
  color: var(--muted);
  font-size: 1em;
  padding: 2px 6px 2px 0;
  line-height: 1;
  opacity: 0.45;
  touch-action: none;
  user-select: none;
  flex-shrink: 0;
}
.item-drag:active { cursor: grabbing; opacity: 1; }
.wx-loc.item-dragging,
.row.item-dragging { opacity: 0.5; border: 2px dashed var(--accent); }
.wx-loc.item-drag-over,
.row.item-drag-over { border-top: 3px solid var(--accent); }
/* .row 現在多了 ≡，要調整 flex 以容納 */
.row { position: relative; }
.row > .item-drag { align-self: center; }

/* Collapse toggle */
.sec-collapse-arrow {
  font-size: .7em;
  color: var(--muted);
  transition: transform 0.15s;
  margin-left: 4px;
}
.sec.collapsed .sec-collapse-arrow { transform: rotate(-90deg); }
.sec.collapsed .sec-b { display: none; }

/* Dragging state */
.sec.dragging {
  opacity: 0.5;
  border: 2px dashed var(--accent);
}
.sec.drag-over {
  border-top: 3px solid var(--accent);
}

.sec-set-btn {
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border);
  color: var(--muted);
  width: 30px;
  height: 26px;
  border-radius: 7px;
  cursor: pointer;
  font-size: .9em;
  line-height: 1;
  padding: 0;
}
.sec-set-btn:active { opacity: 0.6; }

/* 每區塊右側顯示資料更新時間 */
.sec-time {
  font-size: .68em;
  color: var(--muted);
  margin-right: 6px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  align-self: center;
}
.sec-b { padding: 6px 0; }

/* Weather（收合版：r1 + r2 永遠顯示，r3 展開後才顯示） */
.wx-loc {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}
.wx-loc:last-child { border-bottom: none; }
.wx-r1 {
  display: flex; align-items: center; gap: 8px;
  font-size: .88em;
  cursor: pointer;
  user-select: none;
  flex-wrap: wrap;
}
.wx-r1 .name { font-weight: 600; color: var(--text); flex-shrink: 0; }
.wx-r1 .ic { font-size: 1.2em; line-height: 1; flex-shrink: 0; }
.wx-r1 .tmp { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); flex-shrink: 0; }
.wx-r1 .fl { color: var(--muted); font-size: .9em; flex-shrink: 0; }
.wx-r1 .sun { color: var(--muted); font-size: .88em; margin-left: auto; flex-shrink: 0; }
.wx-r1 .tog {
  color: var(--muted); font-size: .8em; margin-left: 6px;
  transition: transform .2s;
  flex-shrink: 0;
}
.wx-loc.expanded .wx-r1 .tog { transform: rotate(180deg); }
.wx-r2 {
  display: flex; gap: 10px; flex-wrap: wrap;
  font-size: .78em; color: var(--muted);
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}
.wx-r2 span { display: inline-flex; align-items: center; gap: 3px; }
/* AQI / PM2.5 EPA 色階 */
.aq-1 { color: #00e400; }  /* 良好 */
.aq-2 { color: #ffff00; }  /* 普通 */
.aq-3 { color: #ff7e00; }  /* 敏感族不健康 */
.aq-4 { color: #ff0000; }  /* 不健康 */
.aq-5 { color: #8f3f97; }  /* 非常不健康 */
.aq-6 { color: #7e0023; }  /* 危害 */
[data-theme="light"] .aq-1 { color: #00b800; }
[data-theme="light"] .aq-2 { color: #c9a800; }
.wx-forecast {
  display: none; gap: 6px; margin-top: 8px; overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.wx-loc.expanded .wx-forecast { display: flex; }
.wx-forecast::-webkit-scrollbar { display: none; }
.wx-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--muted);
  font-size: .82em;
  line-height: 1.6;
}

/* Bilingual reader */
.news-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.news-reader-btn {
  background: rgba(244,196,48,0.12);
  border: 1px solid rgba(244,196,48,0.3);
  color: var(--accent);
  padding: 3px 8px;
  border-radius: 6px;
  font-size: .7em;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.news-reader-btn:active { opacity: .6; }

.reader-wrap {
  display: none;
  position: fixed;
  inset: 0;
  background: var(--bg);
  z-index: 200;
  flex-direction: column;
  overflow: hidden;
}
.reader-wrap.show { display: flex; }
.reader-hdr {
  padding: calc(env(safe-area-inset-top) + 10px) 14px 10px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.reader-back {
  background: rgba(255,255,255,0.08);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: .85em;
  cursor: pointer;
}
.reader-back:active { opacity: .6; }
.reader-title {
  flex: 1;
  min-width: 0;
  font-size: .85em;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reader-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 16px 14px;
  padding-bottom: calc(env(safe-area-inset-bottom) + 20px);
}
.reader-para-en {
  font-size: .92em;
  line-height: 1.7;
  color: var(--text);
  margin-bottom: 6px;
}
.reader-para-zh {
  font-size: .88em;
  line-height: 1.6;
  color: var(--accent);
  margin-bottom: 18px;
  padding-left: 10px;
  border-left: 2px solid var(--accent);
  opacity: 0.85;
}
.reader-loading {
  padding: 40px 20px;
  text-align: center;
  color: var(--muted);
  font-size: .88em;
}
.reader-error {
  padding: 20px;
  color: #ff8a8a;
  font-size: .82em;
}
.reader-source {
  font-size: .72em;
  color: var(--muted);
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.reader-source a { color: var(--accent); }
.wx-day {
  flex: 0 0 auto;
  min-width: 52px;
  text-align: center;
  font-size: .72em;
  color: var(--muted);
  padding: 4px 0;
}
.wx-day .d { color: var(--text); font-weight: 600; }
.wx-day .i { font-size: 1.5em; line-height: 1.2; }
.wx-day .t { font-variant-numeric: tabular-nums; }

/* Stocks & FX */
.row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: .9em;
}
.row:last-child { border-bottom: none; }
.row a { color: var(--text); }
.row a.n { color: var(--accent); text-decoration: none; align-self: flex-start; display: inline-block; }
.row a.n:hover { text-decoration: underline; }
.row > .row-l { flex: 1; min-width: 0; }
.row > .row-r { flex: 0 0 auto; margin-left: 8px; }
/* 持倉 sub-row：單獨一行放在該股票列下方，左對齊（不搶股價位置） */
.row > .row-hold-sub {
  flex-basis: 100%;
  margin-top: 4px;
  padding: 4px 0 0 22px;
  font-size: .8em;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  border-top: 1px dashed var(--border);
}
.row > .row-hold-sub b { color: var(--text); font-weight: 700; margin: 0 2px; }
.row > .row-hold-sub b.up { color: var(--up); }
.row > .row-hold-sub b.down { color: var(--down); }
.row > .row-hold-sub b.flat { color: var(--text); }
.row > .row-hold-sub .lbl { color: var(--muted); font-weight: 400; font-size: .92em; }
.row > .row-hold-sub .hold-x {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: .7em;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  margin-left: 6px;
  vertical-align: middle;
}
.row > .row-hold-sub .hold-x:active { background: rgba(255,100,100,0.12); color: #ff8a8a; }
/* 區塊頂端加總：跟每列 row-hold-sub 一致的樣式（左對齊、同一種 inline 表達方式） */
.stock-summary {
  padding: 10px 14px 10px 36px;
  border-bottom: 1px solid var(--border);
  background: rgba(255,255,255,0.02);
  font-size: .85em;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  position: relative;
}
.stock-summary::before {
  content: '';
  position: absolute;
  left: 14px;
  top: 0; bottom: 0;
}
.stock-summary .lbl { color: var(--muted); font-weight: 400; font-size: .92em; }
.stock-summary b { color: var(--text); font-weight: 700; margin: 0 2px; }
.stock-summary b.up { color: var(--up); }
.stock-summary b.down { color: var(--down); }
.stock-summary b.flat { color: var(--text); }
/* 點列展開持倉編輯 panel */
.row.stock-row { flex-wrap: wrap; cursor: pointer; }
.row > .stock-expand {
  flex-basis: 100%;
  display: none;
  padding: 10px 4px 2px;
  margin-top: 6px;
  border-top: 1px dashed var(--border);
  cursor: default;
}
.row.stock-row.expanded > .stock-expand { display: block; }
.se-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}
.se-grid label {
  display: flex;
  flex-direction: column;
  font-size: .7em;
  color: var(--muted);
  gap: 2px;
}
.se-grid input {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 8px;
  border-radius: 6px;
  font-size: .92em;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
}
.se-grid input::-webkit-outer-spin-button,
.se-grid input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.se-clear {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: .74em;
  cursor: pointer;
}
.se-clear:active { background: rgba(255,100,100,0.12); color: #ff8a8a; }

/* Cross-PWA tab navbar + 功能按鈕同 row (V1.3.12) */
/* V1.3.18: Bottom fixed tab navbar + function keys (跟 CrewSync 同 pattern) */
.tab-nav {
  position: fixed; bottom: 0; left: 0; right: 0;
  display: flex; align-items: stretch; gap: 8px;
  background: var(--bg2); border-top: 1px solid var(--border);
  z-index: 30; padding: 0 8px;  /* 低於 .modal-wrap (z-index 100)，modal 開時 nav 被蓋住 */
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.tab-links { display: flex; flex: 1; min-width: 0; }
.tab-links a {
  flex: 1; text-align: center; padding: 12px 6px;
  color: var(--muted); text-decoration: none;
  font-weight: 600; font-size: .92em;
  border-top: 2px solid transparent;
  transition: color .15s, border-color .15s;
}
.tab-links a.active {
  color: var(--text);
  border-top-color: var(--accent);
}
.tab-links a:active { background: rgba(255,255,255,0.06); }
.tab-controls {
  display: flex; gap: 8px; align-items: center; flex-shrink: 0;
  padding: 6px 4px;
}

/* V1.3.18: 為 bottom fixed navbar 留 body padding (top safe-area 已在 .hdr 處理) */
/* V1.3.19: 禁 iOS 橡皮筋 overscroll */
html, body { overscroll-behavior: none; }
body { padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px)); }
.hdr-actions-top { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }

/* 投資組合 summary banner (V1.3.11) — Nav 下方 sticky-ish 顯示總未實現損益 */
.portfolio-summary {
  background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
  margin: 8px 12px; padding: 10px 14px;
  display: flex; align-items: center; gap: 10px; cursor: pointer;
  font-size: .9em;
}
.portfolio-summary:active { opacity: 0.7; }
.portfolio-summary .ps-icon { font-size: 1.1em; }
.portfolio-summary .ps-main { display: flex; flex: 1; min-width: 0; flex-direction: row; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
.portfolio-summary .ps-label { color: var(--muted); }
.portfolio-summary .ps-value { font-weight: 700; margin-left: auto; font-variant-numeric: tabular-nums; }
.portfolio-summary .ps-value.ps-up { color: #ef4444; }    /* 台股慣例：漲紅 */
.portfolio-summary .ps-value.ps-down { color: #22c55e; }  /* 跌綠 */
.portfolio-summary .ps-fx-note { color: var(--muted); font-size: .78em; flex-basis: 100%; }
.portfolio-summary .ps-fx-note:empty { display: none; }
.portfolio-summary .ps-arrow { color: var(--muted); font-size: 1.1em; }

/* 設定 modal 裡的持倉表格 */
.holdings-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: .82em;
}
.holdings-table .ht-row {
  display: grid;
  grid-template-columns: 1.3fr 1fr 1fr 28px;
  gap: 8px;
  align-items: center;
}
.holdings-table .ht-head {
  font-size: .7em;
  color: var(--muted);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.holdings-table .ht-code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.holdings-table input {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 4px 6px;
  border-radius: 6px;
  font-size: .92em;
  font-variant-numeric: tabular-nums;
  width: 100%;
  -moz-appearance: textfield;
}
.holdings-table input::-webkit-outer-spin-button,
.holdings-table input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.holdings-table .ht-x {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: .8em;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.holdings-table .ht-empty {
  font-size: .76em;
  color: var(--muted);
  padding: 8px 0;
  text-align: center;
}
.danger-btn {
  background: none;
  border: 1px solid #ff8a8a;
  color: #ff8a8a;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: .84em;
  cursor: pointer;
  margin-top: 10px;
  width: 100%;
}
.danger-btn:active { background: rgba(255,100,100,0.12); }

/* FX 計算機（每列） */
.fx-row { flex-wrap: wrap; }
.fx-calc {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  font-size: .82em;
  font-variant-numeric: tabular-nums;
  flex-wrap: wrap;
}
.fx-calc input {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 4px 6px;
  border-radius: 6px;
  font-size: .9em;
  width: 80px;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
}
.fx-calc input::-webkit-outer-spin-button,
.fx-calc input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.fx-calc .fx-ccy { color: var(--muted); font-weight: 600; min-width: 32px; }
.fx-calc .fx-dir {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  width: 26px;
  height: 26px;
  border-radius: 50%;
  font-size: .9em;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.fx-calc .fx-dir:active { background: rgba(244,196,48,0.12); color: var(--accent); }
.fx-calc .fx-result { flex: 1; font-weight: 600; color: var(--accent); min-width: 60px; }
.fx-calc .fx-x {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: .78em;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.fx-calc .fx-x:active { background: rgba(255,100,100,0.12); color: #ff8a8a; }
.row-l { display: flex; flex-direction: column; }
.row-l .n { font-weight: 600; }
.row-l .c { font-size: .78em; color: var(--muted); font-variant-numeric: tabular-nums; }
.row-r { text-align: right; font-variant-numeric: tabular-nums; }
.row-r .p { font-weight: 600; }
.row-r .ch { font-size: .78em; }
.up { color: var(--up); }
.down { color: var(--down); }
.flat { color: var(--muted); }

/* News */
.news {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.news:last-child { border-bottom: none; }
.news a { color: var(--text); }
.news-t { font-size: .9em; line-height: 1.4; font-weight: 500; }
.news-meta { font-size: .72em; color: var(--muted); margin-top: 4px; display: flex; gap: 8px; }
.news-en { font-size: .72em; color: var(--muted); margin-top: 4px; font-style: italic; }

/* News categories (collapsible) */
.news-cat {
  border-bottom: 1px solid var(--border);
}
.news-cat:last-child { border-bottom: none; }
.news-cat-title {
  padding: 10px 10px 10px 6px;
  font-size: .9em;
  font-weight: 700;
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
  gap: 6px;
}
.news-cat-title:active { opacity: .7; }
.news-cat-title .nc-left { display: flex; align-items: center; flex: 1; gap: 6px; }
.news-cat.collapsed .sec-collapse-arrow { transform: rotate(-90deg); }
.news-cat.collapsed .news-cat-body { display: none; }
.news-cat.nc-dragging { opacity: 0.5; border: 2px dashed var(--accent); }
.news-cat.nc-drag-over { border-top: 3px solid var(--accent); }

.loading {
  padding: 40px 20px;
  text-align: center;
  color: var(--muted);
  font-size: .88em;
}
.error {
  padding: 12px 14px;
  color: #ff8a8a;
  font-size: .82em;
}
.offline-banner {
  background: #f59e0b;
  color: #1a1205;
  font-weight: 700;
  font-size: .78em;
  text-align: center;
  padding: 7px 12px;
  border-radius: 8px;
  margin: 0 0 12px;
}


/* About modal */
.modal-wrap {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  z-index: 100;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.modal-wrap.show { display: flex; }
.modal {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px;
  max-width: 420px;
  width: 100%;
  max-height: 80vh;
  overflow-y: auto;
  overflow-x: hidden;            /* 擋住內部橫滑（純防禦，body 已有 overflow-x:hidden） */
  overflow-wrap: break-word;     /* 長英文/code/URL 不再撐爆寬度 */
  -webkit-overflow-scrolling: touch;
}
.modal h3 { margin: 0 0 10px; font-size: 1.05em; }
.modal .close {
  float: right;
  background: none; border: none;
  color: var(--muted);
  font-size: 1.3em;
  cursor: pointer;
}
.changelog-v {
  font-size: .82em;
  font-weight: 700;
  margin-top: 10px;
  margin-bottom: 4px;
  color: var(--accent);
}
.changelog-v.old { color: var(--muted); }
.changelog-txt {
  font-size: .76em;
  color: var(--muted);
  line-height: 1.5;
  margin-bottom: 8px;
}

/* Calendar */
.cal-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.cal-nav {
  background: rgba(255,255,255,0.08);
  border: 1px solid var(--border);
  color: var(--text);
  width: 32px; height: 32px;
  border-radius: 8px;
  font-size: 1em;
  cursor: pointer;
}
.cal-nav:active { opacity: .6; }
.cal-title { font-weight: 700; font-size: 1em; }
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.cal-dow {
  text-align: center;
  font-size: .72em;
  color: var(--muted);
  padding: 4px 0;
  font-weight: 600;
}
.cal-day {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: .85em;
  border: 1px solid transparent;
  position: relative;
}
.cal-day.empty { visibility: hidden; }
.cal-day.has-data {
  background: rgba(244,196,48,0.12);
  border-color: rgba(244,196,48,0.35);
  color: var(--accent);
  font-weight: 700;
  cursor: pointer;
}
.cal-day.has-data:active { opacity: .6; }
.cal-day.today {
  box-shadow: inset 0 0 0 2px var(--accent2);
}
.cal-day.current {
  background: var(--accent);
  color: #1F2D3D;
  border-color: var(--accent);
}
.cal-day.no-data {
  color: var(--muted);
  opacity: .35;
}

/* Settings modal */
.set-sec { margin-bottom: 14px; }
.set-sec h4 {
  margin: 0 0 6px;
  font-size: .88em;
  color: var(--text);
}
.set-sec p { margin: 0 0 6px; font-size: .75em; color: var(--muted); }
.set-sec textarea {
  width: 100%;
  background: var(--bg2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 8px;
  font-size: .85em;
  font-family: inherit;
  resize: vertical;
  min-height: 60px;
}
.wx-cat {
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.wx-cat-title {
  font-size: .82em;
  font-weight: 700;
  color: var(--accent);
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255,255,255,0.03);
}
.wx-cat-title:active { opacity: .7; }
.wx-cat-title .arrow {
  transition: transform 0.15s;
  font-size: .8em;
  color: var(--muted);
}
.wx-cat.expanded .wx-cat-title .arrow {
  transform: rotate(90deg);
}
.wx-cat-title .cnt {
  font-size: .82em;
  color: var(--muted);
  font-weight: 500;
}
.wx-cat .wx-chk-grid {
  display: none;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  padding: 8px 10px;
}
.wx-cat.expanded .wx-chk-grid {
  display: grid;
}

/* 三層架構：region → county → district */
.wx-region {
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.wx-region-title {
  font-size: .88em;
  font-weight: 700;
  color: var(--accent);
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255,255,255,0.03);
}
.wx-region-title:active { opacity: .7; }
.wx-region-title .arrow { transition: transform 0.15s; font-size: .8em; color: var(--muted); }
.wx-region.expanded .wx-region-title .arrow { transform: rotate(90deg); }
.wx-region .wx-region-body { display: none; padding: 0 6px 6px; }
.wx-region.expanded .wx-region-body { display: block; }

/* Super-region（最外層，例如「台灣」） */
.wx-super {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.wx-super-title {
  font-size: .95em;
  font-weight: 700;
  color: var(--accent);
  padding: 12px 14px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255,255,255,0.03);
}
.wx-super-title:active { opacity: .7; }
.wx-super-title .arrow { transition: transform 0.15s; font-size: .8em; color: var(--muted); }
.wx-super.expanded .wx-super-title .arrow { transform: rotate(90deg); }
.wx-super .wx-super-body { display: none; padding: 4px 6px 8px; }
.wx-super.expanded .wx-super-body { display: block; }
.wx-chk {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: .78em;
  cursor: pointer;
  user-select: none;
}
.wx-chk input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}
.wx-chk.checked {
  background: rgba(244,196,48,0.14);
  border-color: rgba(244,196,48,0.45);
  color: var(--accent);
  font-weight: 600;
}
.wx-chk.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.wx-counter {
  font-size: .76em;
  color: var(--muted);
  margin-bottom: 6px;
}
.wx-counter.full { color: var(--accent2); font-weight: 600; }

.set-btn {
  background: var(--accent);
  color: #1F2D3D;
  border: none;
  border-radius: 10px;
  padding: 10px 16px;
  font-weight: 700;
  font-size: .9em;
  cursor: pointer;
  width: 100%;
}
.set-btn:active { opacity: 0.8; }

@media (min-width: 700px) {
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    margin: 14px 12px;
  }
  .grid-2 > .sec { margin: 0; border-radius: 0; }
  .grid-2 > .sec:first-child { border-radius: 14px 0 0 14px; border-right: none; }
  .grid-2 > .sec:last-child { border-radius: 0 14px 14px 0; }
}
</style>
</head>
<body>

<!-- Bottom fixed tab navbar (V1.3.18: 比照 CrewSync 移到底部) -->
<nav class="tab-nav">
  <div class="tab-links">
    <a href="/morning" class="active">📰 今日</a>
    <a href="/portfolio">📈 投資組合</a>
  </div>
  <div class="tab-controls">
    <a href="/apps" id="cs-apps-home" aria-label="Tools" title="回 Tools" style="display:none;align-items:center;justify-content:center;text-decoration:none;padding:0 4px"><svg width="20" height="20" viewBox="0 0 24 24"><rect x="2" y="2" width="9" height="9" rx="2.5" fill="#3b82f6"/><rect x="13" y="2" width="9" height="9" rx="2.5" fill="#10b981"/><rect x="2" y="13" width="9" height="9" rx="2.5" fill="#f59e0b"/><rect x="13" y="13" width="9" height="9" rx="2.5" fill="#a855f7"/></svg></a>
    <div class="theme-seg" title="日 / 夜">
      <span class="theme-seg-knob"></span>
      <button class="theme-seg-opt" type="button" onclick="setMorningTheme('light')" aria-label="日間 Day">☀️</button>
      <button class="theme-seg-opt" type="button" onclick="setMorningTheme('dark')" aria-label="夜間 Night">🌙</button>
    </div>
    <div class="hdr-btn-font" title="字型大小">
      <button id="btn-font-up">A+</button>
      <button id="btn-font-dn">A−</button>
    </div>
    <span onclick="showAbout()" style="cursor:pointer;font-size:.62em;color:var(--muted);text-decoration:underline;text-underline-offset:2px;white-space:nowrap">${MORNING_VERSION}</span>
  </div>
</nav>
<!-- ⊞ 回 Apps：只在「從 /apps 入口進來 + 裝成 PWA」時顯示 -->
<script>(function(){try{var s=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone;if(s&&localStorage.getItem('cs_via_apps')==='1'){var b=document.getElementById('cs-apps-home');if(b)b.style.display='inline-flex';}}catch(e){}})();</script>

<div class="top-stack">
  <div class="hdr">
    <div style="min-width:0;flex:1">
      <div class="hdr-title">
        <span class="emoji">📰</span><span id="hdr-user-title" onclick="changeUid()" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">今日</span>
        <!-- 版號已移到底部設定區（右下角，三個 app 一致） -->
      </div>
      <div class="hdr-date" id="hdr-date">—</div>
    </div>
    <div class="hdr-actions-top">
      <!-- V2.0.03：歷史功能已移除（每位 user 只留最新一份晨報），日曆按鈕拿掉 — DOM 移除，
           date-picker modal / 相關 JS 留著是 dead code，標 TODO 不刪以免動到其他綁定的 listener；
           openDatePicker() / 日期清單 fetch 仍可運行但永遠回空。 -->
      <!-- TODO(V2.0.03)：date-picker modal + JS（openDatePicker / 月曆渲染）目前未綁，可安全清除 -->
      <button class="hdr-btn" id="btn-date" title="歷史" style="display:none">📅</button>
      <button class="hdr-btn" id="btn-refresh" title="重新整理">↻</button>
    </div>
  </div>

  <nav class="nav" id="nav">
    <button class="nav-btn" data-target="sec-wx">🌤️ 天氣</button>
    <button class="nav-btn" data-target="sec-stw">📈 台股</button>
    <button class="nav-btn" data-target="sec-sus">🇺🇸 美股</button>
    <button class="nav-btn" data-target="sec-fx">💱 匯率</button>
    <button class="nav-btn" data-target="sec-ntw">🇹🇼 台灣新聞</button>
    <button class="nav-btn" data-target="sec-nww">🌍 世界新聞</button>
  </nav>
</div>

<!-- 投資組合 summary banner (V1.3.11; V1.3.17 加 fx note) -->
<div id="portfolio-summary" class="portfolio-summary" onclick="location.href='/portfolio'" hidden>
  <span class="ps-icon">💼</span>
  <div class="ps-main">
    <span class="ps-label">投資未實現損益</span>
    <span class="ps-value" id="ps-value">—</span>
    <span class="ps-fx-note" id="ps-fx-note"></span>
  </div>
  <span class="ps-arrow">→</span>
</div>

<div id="root">
  <div class="loading">載入中 Loading…</div>
</div>

<!-- About modal -->
<div class="modal-wrap" id="about-wrap" onclick="if(event.target===this)hideAbout()">
  <div class="modal">
    <button class="close" onclick="hideAbout()">✕</button>
    <h3>📰 今日 Today</h3>
    <div style="font-size:.8em;color:var(--muted);margin-bottom:10px">
      天氣、股市、匯率、新聞，一眼看完<br>
      Weather, stocks, FX &amp; news at a glance
    </div>
    <div style="font-size:.75em;color:var(--muted);line-height:1.6">
      資料來源 Sources:<br>
      • 天氣 Weather — Open-Meteo<br>
      • 匯率 FX — 台銀 Bank of Taiwan<br>
      • 台/美股 Stocks — 鉅亨網 cnyes<br>
      • 新聞 News — Multi-source<br>
      • 翻譯 Translate — Google Translate
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:12px 0">
    ${renderAppChangelog()}
  </div>
</div>

<!-- Settings modal (per-section) -->
<div class="modal-wrap" id="set-wrap" onclick="if(event.target===this)hideSet()">
  <div class="modal">
    <button class="close" onclick="hideSet()">✕</button>
    <h3 id="set-title">⚙️ 設定 Settings</h3>
    <div style="font-size:.75em;color:var(--muted);margin-bottom:12px">
      設定會綁定你的暱稱存在伺服器，跨裝置自動同步（用同一暱稱在其他裝置開就會拉到你的選擇）。
    </div>

    <div class="set-sec" data-section="wx">
      <h4>🌤️ 天氣地點</h4>
      <p>勾選預設或手動輸入，建議 &lt; 30 個（絕對上限 500）</p>
      <div class="wx-counter" id="wx-counter">已選 0 / 10</div>
      <div id="wx-presets"></div>
      <div style="margin-top:14px">
        <p style="margin-top:0">手動加地點（一行一個，格式：<code>名稱,緯度,經度</code>）</p>
        <textarea id="set-wx-custom" placeholder="自選地點,24.99,121.31"></textarea>
      </div>
    </div>

    <div class="set-sec" data-section="tw">
      <h4>📈 台股</h4>
      <p>勾選預設或手動輸入代號（建議 &lt; 30 支）</p>
      <div class="wx-counter" id="tw-counter">已選 0</div>
      <div id="tw-presets"></div>
      <div style="margin-top:14px">
        <p style="margin-top:0">手動加代號（用逗號分隔，例如 4968,3515）</p>
        <textarea id="set-tw-custom" placeholder="4968,3515"></textarea>
      </div>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <p style="margin-top:0">💼 持倉</p>
        <p style="font-size:.85em;color:var(--muted);line-height:1.5">
          持倉編輯已搬到「投資組合」 PWA。在那邊加交易，總損益自動顯示在今日頂部，<br>
          這邊 settings 不再 key qty / 成本。
        </p>
        <button type="button" onclick="location.href='/portfolio'">→ 去投資組合</button>
      </div>
    </div>

    <div class="set-sec" data-section="us">
      <h4>🇺🇸 美股</h4>
      <p>勾選預設或手動輸入代號（建議 &lt; 30 支）</p>
      <div class="wx-counter" id="us-counter">已選 0</div>
      <div id="us-presets"></div>
      <div style="margin-top:14px">
        <p style="margin-top:0">手動加代號（用逗號分隔，例如 GME,AMC）</p>
        <textarea id="set-us-custom" placeholder="GME,AMC"></textarea>
      </div>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <p style="margin-top:0">💼 持倉</p>
        <p style="font-size:.85em;color:var(--muted);line-height:1.5">
          持倉編輯已搬到「投資組合」 PWA。在那邊加交易，總損益自動顯示在今日頂部，<br>
          這邊 settings 不再 key qty / 成本。
        </p>
        <button type="button" onclick="location.href='/portfolio'">→ 去投資組合</button>
      </div>
    </div>

    <div class="set-sec" data-section="fx">
      <h4>💱 匯率</h4>
      <p>勾選常用貨幣對（不限對台幣，建議 &lt; 20 個）</p>
      <div class="wx-counter" id="fx-counter">已選 0</div>
      <div id="fx-presets"></div>
      <div style="margin-top:14px">
        <p style="margin-top:0">手動加貨幣對（用逗號分隔，例如 CHF/TWD,USD/THB）</p>
        <textarea id="set-fx-custom" placeholder="CHF/TWD,USD/THB"></textarea>
      </div>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <label style="display:flex;align-items:center;gap:8px;font-size:.82em;color:var(--muted);margin-bottom:10px">
          換算結果小數位數
          <select id="set-fx-decimals" onchange="onFxDecimalsChange(event)" style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:6px;font-size:.9em">
            <option value="0">0（整數）</option>
            <option value="2">2 位</option>
            <option value="4">4 位</option>
          </select>
          <span style="font-size:.72em">（跨裝置同步）</span>
        </label>
        <button type="button" class="danger-btn" onclick="clearAllFx()">🗑️ 清除全部匯率換算數字</button>
      </div>
    </div>

    <button class="set-btn" onclick="saveSettings()">儲存並重新載入</button>
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);text-align:center">
      <div style="font-size:.72em;color:var(--muted);margin-bottom:6px">目前使用者：<span id="set-current-uid" style="color:var(--accent);font-weight:600">—</span></div>
      <button type="button" onclick="switchUser()" style="background:none;border:none;color:var(--muted);font-size:.76em;text-decoration:underline;cursor:pointer;padding:4px 8px">👤 切換使用者</button>
    </div>
  </div>
</div>

<!-- Nickname onboarding modal -->
<div class="modal-wrap" id="nick-wrap" style="display:none">
  <div class="modal" style="max-width:360px">
    <h3 style="margin-bottom:6px">📰 今日</h3>
    <div style="font-size:.85em;color:var(--muted);margin-bottom:14px;line-height:1.6">
      先取個暱稱<br>
      <span style="font-size:.85em">（重灌或換裝置時用同一個名字就能找回歷史）</span>
    </div>
    <input id="nick-input" type="text" maxlength="20" placeholder="你的暱稱 (2-20 字)" autocomplete="off"
      style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:12px 14px;font-size:1em;font-family:inherit;margin-bottom:6px">
    <div id="nick-hint" style="font-size:.72em;color:var(--muted);min-height:1.2em;margin-bottom:10px"></div>
    <button class="set-btn" id="nick-submit">開始</button>
  </div>
</div>

<!-- Date picker modal (calendar view) -->
<div class="modal-wrap" id="date-wrap" onclick="if(event.target===this)hideDate()">
  <div class="modal">
    <button class="close" onclick="hideDate()">✕</button>
    <h3>📅 歷史</h3>
    <div class="cal-hdr">
      <button class="cal-nav" id="cal-prev">◀</button>
      <div class="cal-title" id="cal-title">—</div>
      <button class="cal-nav" id="cal-next">▶</button>
    </div>
    <div class="cal-grid" id="cal-grid"></div>
    <div style="margin-top:10px;font-size:.72em;color:var(--muted);text-align:center">
      金色 = 有資料可點 · 外框 = 今天 · 填滿 = 目前顯示
    </div>
  </div>
</div>

<!-- AQI / PM2.5 色階說明 modal -->
<div class="modal-wrap" id="aqi-legend-wrap" onclick="if(event.target===this)hideAqiLegend()">
  <div class="modal">
    <button class="close" onclick="hideAqiLegend()">✕</button>
    <h3>🌫️ 空氣品質色階說明</h3>
    <div style="font-size:.82em;line-height:1.8;color:var(--muted)">
      <div style="margin-bottom:8px">顏色依據 <strong>美國 EPA</strong> 標準分級（數字越高越不健康）：</div>
      <table style="width:100%;border-collapse:collapse;font-size:.9em;font-variant-numeric:tabular-nums">
        <thead>
          <tr style="border-bottom:1px solid var(--border);color:var(--text);font-weight:600">
            <th style="text-align:left;padding:6px 4px">等級</th>
            <th style="text-align:right;padding:6px 4px">AQI</th>
            <th style="text-align:right;padding:6px 4px">PM2.5</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 4px"><span class="aq-1">● 良好</span></td><td style="text-align:right;padding:6px 4px" class="aq-1">0–50</td><td style="text-align:right;padding:6px 4px" class="aq-1">0–12</td></tr>
          <tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 4px"><span class="aq-2">● 普通</span></td><td style="text-align:right;padding:6px 4px" class="aq-2">51–100</td><td style="text-align:right;padding:6px 4px" class="aq-2">12–35</td></tr>
          <tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 4px"><span class="aq-3">● 敏感族不健康</span></td><td style="text-align:right;padding:6px 4px" class="aq-3">101–150</td><td style="text-align:right;padding:6px 4px" class="aq-3">35–55</td></tr>
          <tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 4px"><span class="aq-4">● 不健康</span></td><td style="text-align:right;padding:6px 4px" class="aq-4">151–200</td><td style="text-align:right;padding:6px 4px" class="aq-4">55–150</td></tr>
          <tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 4px"><span class="aq-5">● 非常不健康</span></td><td style="text-align:right;padding:6px 4px" class="aq-5">201–300</td><td style="text-align:right;padding:6px 4px" class="aq-5">150–250</td></tr>
          <tr><td style="padding:6px 4px"><span class="aq-6">● 危害</span></td><td style="text-align:right;padding:6px 4px" class="aq-6">301+</td><td style="text-align:right;padding:6px 4px" class="aq-6">250+</td></tr>
        </tbody>
      </table>
      <div style="margin-top:10px;font-size:.78em">PM2.5 單位為 μg/m³（微克/立方公尺）。資料來源：Open-Meteo Air Quality API。</div>
    </div>
  </div>
</div>

<!-- Bilingual reader overlay -->
<div class="reader-wrap" id="reader-wrap">
  <div class="reader-hdr">
    <button class="reader-back" id="reader-back">← 返回</button>
    <div class="reader-title" id="reader-title">—</div>
  </div>
  <div class="reader-body" id="reader-body">
    <div class="reader-loading">載入中…</div>
  </div>
</div>

<script>
${getMorningClientJs()}
</script>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════════
// 前端 JS — 渲染邏輯、設定頁、歷史日期、SW 註冊
// ════════════════════════════════════════════════════════════════════
function getMorningClientJs() {
  return `
const LS = {
  uid: 'morning_uid',
  wxPresets: 'morning_wx_presets',
  wxCustom: 'morning_wx_custom',
  wxLegacy: 'morning_wx_locs',
  tw: 'morning_tw_stocks',
  us: 'morning_us_stocks',
  fx: 'morning_fx_currencies',
  secOrder: 'morning_sec_order',
  secCollapsed: 'morning_sec_collapsed',
  newsCatOrder: 'morning_news_cat_order', // 台灣新聞分類順序
  wxExpanded: 'morning_wx_expanded', // 天氣地點展開狀態（陣列：展開的 location name）
  twHoldings: 'morning_tw_holdings', // { code: { qty, cost } }
  usHoldings: 'morning_us_holdings',
  fxInputs: 'morning_fx_inputs',    // 只存本機：{ pair: amount }
  fxDirections: 'morning_fx_directions', // 只存本機：{ pair: 'ltr'|'rtl' }
  fxDecimals: 'morning_fx_decimals', // 跨裝置同步：0 / 2 / 4
  stockExpanded: 'morning_stock_expanded', // 主畫面哪幾支股票展開（陣列，market:code）
};

function getUid() {
  try { return localStorage.getItem(LS.uid) || ''; } catch (e) { return ''; }
}
function setUid(uid) {
  try { localStorage.setItem(LS.uid, uid); } catch (e) {}
  updateHdrTitle();
}

// V1.3.19: hdr 點暱稱改 uid (對齊投資組合 changeUid 功能 - 跨 PWA 共用)
// User 明確要求保留本地自選快取，且資料跟著 uid 走 (跨裝置 sync via server)
async function changeUid() {
  const cur = getUid();
  const v = prompt('輸入你的暱稱（今日跟投資組合共用）：', cur);
  if (v === null) return;
  const trimmed = v.trim();
  if (!trimmed || trimmed === cur) return;
  setUid(trimmed);
  // 對齊 submitNickname first-run 邏輯: 抓 server prefs；新 uid 沒 prefs → 用當前
  // local prefs (即原 uid 的 watchlist) 當 seed POST 上去 build 初始 report，
  // 達成 user 要求「保留快取 + 個人資料跟隨暱稱」
  try {
    const r = await apiFetch('/api/morning-prefs');
    if (r.ok) {
      if (typeof syncPrefsFromServer === 'function') await syncPrefsFromServer();
    } else if (r.status === 404) {
      // 只 404 算新 uid (server 確認沒這 user)，其他 status (5xx/network) 不該誤判
      // 否則 transient backend 失敗會 overwrite target uid 的 server prefs
      const wxPresetIds = loadSetting('wxPresets', DEFAULTS.wxPresets);
      const wxCustom = loadSetting('wxCustom', DEFAULTS.wxCustom);
      const tw = loadSetting('tw', DEFAULTS.tw);
      const us = loadSetting('us', DEFAULTS.us);
      const fx = loadSetting('fx', DEFAULTS.fx);
      const wxLocs = [];
      for (const id of wxPresetIds) {
        if (WX_PRESET_MAP[id]) wxLocs.push({ name: WX_PRESET_MAP[id].name, lat: WX_PRESET_MAP[id].lat, lon: WX_PRESET_MAP[id].lon });
      }
      for (const c of wxCustom) wxLocs.push(c);
      const initPrefs = { wx: wxLocs, tw, us, fx };
      try {
        await apiFetch('/api/morning-report/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(initPrefs),
        });
      } catch (e) { console.warn('changeUid first build failed', e); }
    }
  } catch (e) {}
  if (typeof loadAndRender === 'function') await loadAndRender();
}
window.changeUid = changeUid;

function updateHdrTitle() {
  const el = document.getElementById('hdr-user-title');
  if (!el) return;
  const uid = getUid();
  // V1.3.13: 拿掉「的晨報」字樣 (navbar 已標 module 名)，只顯示暱稱
  el.textContent = uid || '請設暱稱';
}

// Wrapped fetch that always adds X-User-Id header
// 非 ASCII 暱稱（例如中文）在 iOS Safari 不能直接放 HTTP header，會丟 TypeError
// 解法：encodeURIComponent 送 header，後端 decodeURIComponent 收
function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  const uid = getUid();
  if (uid) opts.headers['X-User-Id'] = encodeURIComponent(uid);
  return fetch(url, opts);
}

// 天氣預設地點清單（分 3 類）
// 每筆：[id, name, lat, lon]
const WX_PRESETS = {
  '🇹🇼 台北市': [
    ['tw-tp-songshan', '松山區', 25.06, 121.55],
    ['tw-tp-xinyi', '信義區', 25.03, 121.57],
    ['tw-tp-daan', '大安區', 25.03, 121.54],
    ['tw-tp-zhongzheng', '中正區', 25.03, 121.52],
    ['tw-tp-wanhua', '萬華區', 25.04, 121.50],
    ['tw-tp-datong', '大同區', 25.06, 121.51],
    ['tw-tp-zhongshan', '中山區', 25.07, 121.53],
    ['tw-tp-neihu', '內湖區', 25.08, 121.59],
    ['tw-tp-nangang', '南港區', 25.05, 121.61],
    ['tw-tp-shilin', '士林區', 25.09, 121.52],
    ['tw-tp-beitou', '北投區', 25.13, 121.50],
    ['tw-tp-wenshan', '文山區', 24.99, 121.57],
  ],
  '🇹🇼 新北市': [
    ['tw-nt-banqiao', '板橋區', 25.01, 121.46],
    ['tw-nt-sanchong', '三重區', 25.06, 121.49],
    ['tw-nt-zhonghe', '中和區', 24.99, 121.49],
    ['tw-nt-yonghe', '永和區', 25.01, 121.51],
    ['tw-nt-xinzhuang', '新莊區', 25.04, 121.44],
    ['tw-nt-xindian', '新店區', 24.97, 121.54],
    ['tw-nt-tucheng', '土城區', 24.97, 121.44],
    ['tw-nt-luzhou', '蘆洲區', 25.08, 121.47],
    ['tw-nt-xizhi', '汐止區', 25.07, 121.64],
    ['tw-nt-shulin', '樹林區', 24.99, 121.41],
    ['tw-nt-yingge', '鶯歌區', 24.96, 121.35],
    ['tw-nt-sanxia', '三峽區', 24.93, 121.37],
    ['tw-nt-tamsui', '淡水區', 25.17, 121.44],
    ['tw-nt-ruifang', '瑞芳區', 25.11, 121.81],
    ['tw-nt-wugu', '五股區', 25.08, 121.44],
    ['tw-nt-taishan', '泰山區', 25.06, 121.43],
    ['tw-nt-linkou', '林口區', 25.08, 121.39],
    ['tw-nt-shenkeng', '深坑區', 25.00, 121.62],
    ['tw-nt-shiding', '石碇區', 24.99, 121.66],
    ['tw-nt-pinglin', '坪林區', 24.94, 121.71],
    ['tw-nt-sanzhi', '三芝區', 25.21, 121.50],
    ['tw-nt-shimen', '石門區', 25.24, 121.57],
    ['tw-nt-bali', '八里區', 25.13, 121.40],
    ['tw-nt-pingxi', '平溪區', 25.03, 121.74],
    ['tw-nt-shuangxi', '雙溪區', 25.03, 121.87],
    ['tw-nt-gongliao', '貢寮區', 25.02, 121.91],
    ['tw-nt-jinshan', '金山區', 25.22, 121.64],
    ['tw-nt-wanli', '萬里區', 25.18, 121.69],
    ['tw-nt-wulai', '烏來區', 24.87, 121.55],
  ],
  '🇹🇼 桃園市': [
    ['tw-ty-taoyuan', '桃園區', 24.99, 121.31],
    ['tw-ty-zhongli', '中壢區', 24.97, 121.23],
    ['tw-ty-bade', '八德區', 24.93, 121.28],
    ['tw-ty-guishan', '龜山區', 25.04, 121.35],
    ['tw-ty-dayuan', '大園區', 25.07, 121.21],
    ['tw-ty-daxi', '大溪區', 24.88, 121.29],
    ['tw-ty-yangmei', '楊梅區', 24.91, 121.15],
    ['tw-ty-luzhu', '蘆竹區', 25.05, 121.28],
    ['tw-ty-pingzhen', '平鎮區', 24.94, 121.22],
    ['tw-ty-longtan', '龍潭區', 24.86, 121.22],
    ['tw-ty-guanyin', '觀音區', 25.03, 121.12],
    ['tw-ty-xinwu', '新屋區', 24.97, 121.11],
    ['tw-ty-fuxing', '復興區', 24.82, 121.35],
  ],
  '🇹🇼 台中市': [
    ['tw-tc-central', '中區', 24.14, 120.68],
    ['tw-tc-east', '東區', 24.14, 120.70],
    ['tw-tc-south', '南區', 24.13, 120.68],
    ['tw-tc-west', '西區', 24.14, 120.67],
    ['tw-tc-north', '北區', 24.16, 120.68],
    ['tw-tc-beitun', '北屯區', 24.18, 120.69],
    ['tw-tc-xitun', '西屯區', 24.18, 120.64],
    ['tw-tc-nantun', '南屯區', 24.14, 120.64],
    ['tw-tc-taiping', '太平區', 24.13, 120.72],
    ['tw-tc-dali', '大里區', 24.10, 120.68],
    ['tw-tc-wufeng', '霧峰區', 24.06, 120.70],
    ['tw-tc-fengyuan', '豐原區', 24.25, 120.72],
    ['tw-tc-houli', '后里區', 24.31, 120.71],
    ['tw-tc-tanzi', '潭子區', 24.21, 120.71],
    ['tw-tc-daya', '大雅區', 24.22, 120.65],
    ['tw-tc-shengang', '神岡區', 24.26, 120.66],
    ['tw-tc-shalu', '沙鹿區', 24.23, 120.57],
    ['tw-tc-longjing', '龍井區', 24.19, 120.55],
    ['tw-tc-wuqi', '梧棲區', 24.26, 120.53],
    ['tw-tc-qingshui', '清水區', 24.27, 120.56],
    ['tw-tc-dajia', '大甲區', 24.35, 120.62],
    ['tw-tc-waipu', '外埔區', 24.33, 120.65],
    ['tw-tc-dadu', '大肚區', 24.15, 120.54],
    ['tw-tc-heping', '和平區', 24.18, 121.00],
    ['tw-tc-dongshi', '東勢區', 24.26, 120.83],
    ['tw-tc-shigang', '石岡區', 24.28, 120.78],
    ['tw-tc-xinshe', '新社區', 24.23, 120.81],
  ],
  '🇹🇼 台南市': [
    ['tw-tn-central', '中西區', 22.99, 120.20],
    ['tw-tn-east', '東區', 22.98, 120.22],
    ['tw-tn-south', '南區', 22.96, 120.20],
    ['tw-tn-north', '北區', 23.00, 120.21],
    ['tw-tn-anping', '安平區', 22.99, 120.17],
    ['tw-tn-annan', '安南區', 23.05, 120.18],
    ['tw-tn-yongkang', '永康區', 23.03, 120.25],
    ['tw-tn-rende', '仁德區', 22.97, 120.25],
    ['tw-tn-guiren', '歸仁區', 22.97, 120.29],
    ['tw-tn-xinhua', '新化區', 23.04, 120.32],
    ['tw-tn-shanhua', '善化區', 23.13, 120.30],
    ['tw-tn-xinying', '新營區', 23.31, 120.32],
    ['tw-tn-yanshui', '鹽水區', 23.32, 120.27],
    ['tw-tn-baihe', '白河區', 23.35, 120.42],
    ['tw-tn-madou', '麻豆區', 23.18, 120.25],
    ['tw-tn-jiali', '佳里區', 23.17, 120.18],
    ['tw-tn-xuejia', '學甲區', 23.25, 120.18],
    ['tw-tn-houbi', '後壁區', 23.37, 120.36],
    ['tw-tn-liuying', '柳營區', 23.28, 120.35],
    ['tw-tn-guanmiao', '關廟區', 22.96, 120.33],
  ],
  '🇹🇼 高雄市': [
    ['tw-ks-xinxing', '新興區', 22.63, 120.30],
    ['tw-ks-lingya', '苓雅區', 22.62, 120.32],
    ['tw-ks-qianjin', '前金區', 22.63, 120.29],
    ['tw-ks-yancheng', '鹽埕區', 22.63, 120.28],
    ['tw-ks-gushan', '鼓山區', 22.65, 120.27],
    ['tw-ks-qijin', '旗津區', 22.61, 120.27],
    ['tw-ks-qianzhen', '前鎮區', 22.59, 120.33],
    ['tw-ks-sanmin', '三民區', 22.65, 120.30],
    ['tw-ks-zuoying', '左營區', 22.69, 120.29],
    ['tw-ks-nanzi', '楠梓區', 22.73, 120.32],
    ['tw-ks-xiaogang', '小港區', 22.56, 120.35],
    ['tw-ks-fengshan', '鳳山區', 22.63, 120.36],
    ['tw-ks-daliao', '大寮區', 22.60, 120.40],
    ['tw-ks-linyuan', '林園區', 22.51, 120.40],
    ['tw-ks-niaosong', '鳥松區', 22.65, 120.37],
    ['tw-ks-dashe', '大社區', 22.73, 120.35],
    ['tw-ks-renwu', '仁武區', 22.70, 120.35],
    ['tw-ks-dashu', '大樹區', 22.72, 120.43],
    ['tw-ks-gangshan', '岡山區', 22.79, 120.30],
    ['tw-ks-qiaotou', '橋頭區', 22.76, 120.30],
    ['tw-ks-yanchao', '燕巢區', 22.79, 120.36],
    ['tw-ks-tianliao', '田寮區', 22.87, 120.36],
    ['tw-ks-hunei', '湖內區', 22.91, 120.22],
    ['tw-ks-luzhu', '路竹區', 22.86, 120.26],
    ['tw-ks-alian', '阿蓮區', 22.88, 120.33],
    ['tw-ks-meinong', '美濃區', 22.90, 120.55],
    ['tw-ks-qishan', '旗山區', 22.89, 120.48],
    ['tw-ks-liugui', '六龜區', 22.99, 120.63],
    ['tw-ks-maolin', '茂林區', 22.89, 120.68],
    ['tw-ks-taoyuan-ks', '桃源區', 23.16, 120.76],
    ['tw-ks-namaxia', '那瑪夏區', 23.28, 120.71],
  ],
  '🇹🇼 基隆市': [
    ['tw-kl-renai', '仁愛區', 25.13, 121.74],
    ['tw-kl-xinyi', '信義區', 25.13, 121.77],
    ['tw-kl-zhongzheng', '中正區', 25.14, 121.73],
    ['tw-kl-zhongshan', '中山區', 25.15, 121.73],
    ['tw-kl-anle', '安樂區', 25.13, 121.72],
    ['tw-kl-qidu', '七堵區', 25.10, 121.71],
    ['tw-kl-nuannuan', '暖暖區', 25.10, 121.74],
  ],
  '🇹🇼 新竹市': [
    ['tw-hcc-east', '東區', 24.80, 120.98],
    ['tw-hcc-north', '北區', 24.82, 120.97],
    ['tw-hcc-xiangshan', '香山區', 24.77, 120.93],
  ],
  '🇹🇼 新竹縣': [
    ['tw-hc-zhubei', '竹北市', 24.83, 121.00],
    ['tw-hc-hukou', '湖口鄉', 24.90, 121.04],
    ['tw-hc-zhudong', '竹東鎮', 24.73, 121.09],
    ['tw-hc-xinfeng', '新豐鄉', 24.90, 120.98],
    ['tw-hc-guanxi', '關西鎮', 24.79, 121.18],
    ['tw-hc-xinpu', '新埔鎮', 24.83, 121.08],
    ['tw-hc-baoshan', '寶山鄉', 24.76, 120.99],
    ['tw-hc-emei', '峨眉鄉', 24.69, 121.01],
    ['tw-hc-beipu', '北埔鄉', 24.70, 121.06],
    ['tw-hc-hengshan', '橫山鄉', 24.72, 121.12],
    ['tw-hc-qionglin', '芎林鄉', 24.77, 121.08],
    ['tw-hc-jianshi', '尖石鄉', 24.71, 121.20],
    ['tw-hc-wufeng', '五峰鄉', 24.63, 121.10],
  ],
  '🇹🇼 苗栗縣': [
    ['tw-ml-miaoli', '苗栗市', 24.56, 120.82],
    ['tw-ml-toufen', '頭份市', 24.69, 120.90],
    ['tw-ml-zhunan', '竹南鎮', 24.69, 120.87],
    ['tw-ml-houlong', '後龍鎮', 24.63, 120.79],
    ['tw-ml-tongxiao', '通霄鎮', 24.49, 120.68],
    ['tw-ml-yuanli', '苑裡鎮', 24.44, 120.66],
    ['tw-ml-dahu', '大湖鄉', 24.42, 120.86],
    ['tw-ml-gongguan', '公館鄉', 24.50, 120.83],
    ['tw-ml-sanyi', '三義鄉', 24.41, 120.76],
    ['tw-ml-nanzhuang', '南庄鄉', 24.60, 121.00],
    ['tw-ml-zaoqiao', '造橋鄉', 24.64, 120.86],
    ['tw-ml-touwu', '頭屋鄉', 24.58, 120.85],
  ],
  '🇹🇼 彰化縣': [
    ['tw-ch-changhua', '彰化市', 24.08, 120.54],
    ['tw-ch-yuanlin', '員林市', 23.96, 120.57],
    ['tw-ch-lukang', '鹿港鎮', 24.06, 120.43],
    ['tw-ch-hemei', '和美鎮', 24.11, 120.50],
    ['tw-ch-beidou', '北斗鎮', 23.87, 120.52],
    ['tw-ch-xihu', '溪湖鎮', 23.96, 120.48],
    ['tw-ch-tianzhong', '田中鎮', 23.86, 120.58],
    ['tw-ch-erlin', '二林鎮', 23.90, 120.37],
    ['tw-ch-huatan', '花壇鄉', 24.03, 120.54],
    ['tw-ch-shengang', '伸港鄉', 24.15, 120.48],
    ['tw-ch-fenyuan', '芬園鄉', 24.01, 120.63],
  ],
  '🇹🇼 南投縣': [
    ['tw-nt-nantouc', '南投市', 23.91, 120.68],
    ['tw-nt-caotun', '草屯鎮', 23.97, 120.68],
    ['tw-nt-puli', '埔里鎮', 23.96, 120.97],
    ['tw-nt-zhushan', '竹山鎮', 23.66, 120.67],
    ['tw-nt-jiji', '集集鎮', 23.83, 120.69],
    ['tw-nt-nantou-yc', '魚池鄉', 23.90, 120.94],
    ['tw-nt-lugu', '鹿谷鄉', 23.75, 120.75],
    ['tw-nt-ren-ai', '仁愛鄉', 24.02, 121.13],
    ['tw-nt-xinyi', '信義鄉', 23.72, 120.86],
  ],
  '🇹🇼 雲林縣': [
    ['tw-yl-douliou', '斗六市', 23.71, 120.54],
    ['tw-yl-huwei', '虎尾鎮', 23.71, 120.43],
    ['tw-yl-douliu', '斗南鎮', 23.68, 120.48],
    ['tw-yl-beigang', '北港鎮', 23.57, 120.30],
    ['tw-yl-xiluo', '西螺鎮', 23.80, 120.47],
    ['tw-yl-tuku', '土庫鎮', 23.68, 120.39],
    ['tw-yl-mailiao', '麥寮鄉', 23.75, 120.25],
    ['tw-yl-lunbei', '崙背鄉', 23.76, 120.35],
    ['tw-yl-gukeng', '古坑鄉', 23.64, 120.56],
  ],
  '🇹🇼 嘉義市': [
    ['tw-cyc-east', '東區', 23.48, 120.46],
    ['tw-cyc-west', '西區', 23.48, 120.43],
  ],
  '🇹🇼 嘉義縣': [
    ['tw-cy-taibao', '太保市', 23.46, 120.33],
    ['tw-cy-puzi', '朴子市', 23.46, 120.25],
    ['tw-cy-minxiong', '民雄鄉', 23.55, 120.43],
    ['tw-cy-dalin', '大林鎮', 23.60, 120.47],
    ['tw-cy-shuishang', '水上鄉', 23.43, 120.40],
    ['tw-cy-zhongpu', '中埔鄉', 23.42, 120.52],
    ['tw-cy-zhuqi', '竹崎鄉', 23.52, 120.55],
    ['tw-cy-fanlu', '番路鄉', 23.47, 120.56],
    ['tw-cy-meishan', '梅山鄉', 23.59, 120.56],
    ['tw-cy-xingang', '新港鄉', 23.56, 120.35],
    ['tw-cy-budai', '布袋鎮', 23.38, 120.17],
    ['tw-cy-dongshi-cy', '東石鄉', 23.46, 120.15],
    ['tw-cy-yizhu', '義竹鄉', 23.36, 120.24],
  ],
  '🇹🇼 屏東縣': [
    ['tw-pt-pingtung', '屏東市', 22.67, 120.49],
    ['tw-pt-chaozhou', '潮州鎮', 22.55, 120.54],
    ['tw-pt-donggang', '東港鎮', 22.47, 120.45],
    ['tw-pt-hengchun', '恆春鎮', 22.00, 120.75],
    ['tw-pt-wandan', '萬丹鄉', 22.59, 120.48],
    ['tw-pt-changzhi', '長治鄉', 22.68, 120.53],
    ['tw-pt-neipu', '內埔鄉', 22.61, 120.57],
    ['tw-pt-yanpu', '鹽埔鄉', 22.75, 120.57],
    ['tw-pt-fangliao', '枋寮鄉', 22.37, 120.59],
    ['tw-pt-manjhou', '滿州鄉', 22.02, 120.83],
    ['tw-pt-liuqiu', '琉球鄉(小琉球)', 22.34, 120.37],
  ],
  '🇹🇼 宜蘭縣': [
    ['tw-il-yilan', '宜蘭市', 24.76, 121.75],
    ['tw-il-luodong', '羅東鎮', 24.68, 121.77],
    ['tw-il-suao', '蘇澳鎮', 24.60, 121.84],
    ['tw-il-toucheng', '頭城鎮', 24.86, 121.82],
    ['tw-il-jiaoxi', '礁溪鄉', 24.83, 121.77],
    ['tw-il-zhuangwei', '壯圍鄉', 24.75, 121.78],
    ['tw-il-wujie', '五結鄉', 24.69, 121.80],
    ['tw-il-dongshan', '冬山鄉', 24.64, 121.79],
    ['tw-il-sanxing', '三星鄉', 24.67, 121.66],
    ['tw-il-datong', '大同鄉', 24.68, 121.53],
    ['tw-il-nanao', '南澳鄉', 24.46, 121.80],
  ],
  '🇹🇼 花蓮縣': [
    ['tw-hl-hualien', '花蓮市', 23.98, 121.61],
    ['tw-hl-jian', '吉安鄉', 23.96, 121.57],
    ['tw-hl-xincheng', '新城鄉', 24.04, 121.60],
    ['tw-hl-shoufeng', '壽豐鄉', 23.87, 121.51],
    ['tw-hl-fenglin', '鳳林鎮', 23.75, 121.45],
    ['tw-hl-guangfu', '光復鄉', 23.67, 121.42],
    ['tw-hl-ruisui', '瑞穗鄉', 23.50, 121.38],
    ['tw-hl-yuli', '玉里鎮', 23.33, 121.31],
    ['tw-hl-fuli', '富里鄉', 23.18, 121.25],
    ['tw-hl-xiulin', '秀林鄉', 24.12, 121.53],
  ],
  '🇹🇼 台東縣': [
    ['tw-tt-taitung', '台東市', 22.76, 121.14],
    ['tw-tt-chenggong', '成功鎮', 23.10, 121.38],
    ['tw-tt-guanshan', '關山鎮', 23.05, 121.16],
    ['tw-tt-beinan', '卑南鄉', 22.79, 121.10],
    ['tw-tt-taimali', '太麻里鄉', 22.62, 121.01],
    ['tw-tt-dawu', '大武鄉', 22.34, 120.89],
    ['tw-tt-donghe', '東河鄉', 22.97, 121.30],
    ['tw-tt-luye', '鹿野鄉', 22.91, 121.14],
    ['tw-tt-chishang', '池上鄉', 23.12, 121.22],
    ['tw-tt-ludao', '綠島', 22.67, 121.49],
    ['tw-tt-lanyu', '蘭嶼', 22.05, 121.55],
  ],
  '🇹🇼 澎湖縣': [
    ['tw-ph-magong', '馬公市', 23.57, 119.58],
    ['tw-ph-huxi', '湖西鄉', 23.59, 119.66],
    ['tw-ph-baisha', '白沙鄉', 23.66, 119.60],
    ['tw-ph-xiyu', '西嶼鄉', 23.60, 119.51],
    ['tw-ph-wangan', '望安鄉', 23.37, 119.50],
    ['tw-ph-qimei', '七美鄉', 23.21, 119.43],
  ],
  '🇹🇼 金門縣': [
    ['tw-km-jincheng', '金城鎮', 24.43, 118.32],
    ['tw-km-jinhu', '金湖鎮', 24.45, 118.40],
    ['tw-km-jinsha', '金沙鎮', 24.47, 118.40],
    ['tw-km-jinning', '金寧鄉', 24.46, 118.33],
    ['tw-km-lieyu', '烈嶼鄉(小金門)', 24.43, 118.24],
  ],
  '🇹🇼 馬祖(連江縣)': [
    ['tw-lj-nangan', '南竿鄉', 26.15, 119.95],
    ['tw-lj-beigan', '北竿鄉', 26.22, 120.00],
    ['tw-lj-dongyin', '東引鄉', 26.37, 120.49],
    ['tw-lj-juguang', '莒光鄉', 25.97, 119.94],
  ],
  '🏞️ 台灣景點': [
    ['at-sunmoon', '日月潭', 23.86, 120.91],
    ['at-alishan', '阿里山', 23.51, 120.80],
    ['at-yushan', '玉山', 23.47, 120.95],
    ['at-hehuan', '合歡山', 24.14, 121.27],
    ['at-yangmingshan', '陽明山', 25.17, 121.55],
    ['at-kenting', '墾丁', 21.95, 120.79],
    ['at-taroko', '太魯閣', 24.15, 121.49],
    ['at-jiufen', '九份', 25.11, 121.85],
    ['at-qingjing', '清境農場', 24.05, 121.17],
    ['at-wuling', '武陵農場', 24.37, 121.30],
    ['at-lalashan', '拉拉山', 24.69, 121.43],
    ['at-xitou', '溪頭', 23.67, 120.80],
    ['at-dasyueshan', '大雪山', 24.26, 121.00],
    ['at-aowanda', '奧萬大', 24.03, 121.18],
    ['at-fulong', '福隆', 25.02, 121.94],
    ['at-greenisland', '綠島', 22.67, 121.49],
    ['at-lanyu', '蘭嶼', 22.05, 121.55],
  ],
  '🌏 日本': [
    ['in-tyo', '東京', 35.68, 139.69],
    ['in-osa', '大阪', 34.69, 135.50],
    ['in-spk', '札幌', 43.06, 141.35],
    ['in-fuk', '福岡', 33.59, 130.40],
    ['in-ngo', '名古屋', 35.18, 136.91],
    ['in-sdj', '仙台', 38.27, 140.87],
    ['in-kmj', '熊本', 32.79, 130.74],
    ['in-kgn', '鹿兒島', 31.60, 130.55],
    ['in-nah', '那霸(沖繩)', 26.21, 127.68],
    ['in-kbe', '神戶', 34.69, 135.20],
    ['in-hir', '廣島', 34.40, 132.46],
    ['in-kij', '新潟', 37.92, 139.04],
  ],
  '🌏 韓國': [
    ['in-sel', '首爾', 37.57, 126.98],
    ['in-pus', '釜山', 35.18, 129.08],
  ],
  '🌏 中國大陸': [
    ['in-bjs', '北京', 39.90, 116.41],
    ['in-sha', '上海', 31.23, 121.47],
    ['in-can', '廣州', 23.13, 113.26],
  ],
  '🌏 港澳': [
    ['in-hkg', '香港', 22.32, 114.17],
    ['in-mfm', '澳門', 22.20, 113.54],
  ],
  '🌏 東南亞': [
    ['in-sin', '新加坡', 1.35, 103.82],
    ['in-bkk', '曼谷', 13.75, 100.50],
    ['in-kul', '吉隆坡', 3.14, 101.69],
    ['in-han', '河內', 21.03, 105.83],
    ['in-sgn', '胡志明市', 10.82, 106.63],
    ['in-mnl', '馬尼拉', 14.60, 120.98],
    ['in-dps', '峇里島', -8.65, 115.22],
  ],
  '🌏 大洋洲': [
    ['in-syd', '雪梨', -33.87, 151.21],
    ['in-mel', '墨爾本', -37.81, 144.96],
  ],
  '🌏 美國': [
    ['in-nyc', '紐約', 40.71, -74.01],
    ['in-lax', '洛杉磯', 34.05, -118.24],
    ['in-sfo', '舊金山', 37.77, -122.42],
    ['in-chi', '芝加哥', 41.88, -87.63],
    ['in-hou', '休士頓', 29.76, -95.37],
    ['in-dfw', '達拉斯', 32.78, -96.80],
    ['in-atl', '亞特蘭大', 33.75, -84.39],
    ['in-mia', '邁阿密', 25.76, -80.19],
    ['in-bos', '波士頓', 42.36, -71.06],
    ['in-sea', '西雅圖', 47.60, -122.33],
    ['in-den', '丹佛', 39.74, -104.99],
    ['in-phx', '鳳凰城', 33.45, -112.07],
    ['in-lv', '拉斯維加斯', 36.17, -115.14],
    ['in-dc', '華盛頓 DC', 38.91, -77.04],
    ['in-msp', '明尼亞波利斯', 44.98, -93.27],
    ['in-det', '底特律', 42.33, -83.05],
    ['in-pdx', '波特蘭', 45.52, -122.68],
    ['in-sd', '聖地牙哥', 32.72, -117.16],
    ['in-orl', '奧蘭多', 28.54, -81.38],
    ['in-hnl', '檀香山', 21.31, -157.86],
  ],
  '🌏 加拿大': [
    ['in-yvr', '溫哥華', 49.28, -123.12],
    ['in-yyz', '多倫多', 43.65, -79.38],
    ['in-yul', '蒙特婁', 45.50, -73.57],
    ['in-yyc', '卡加利', 51.05, -114.07],
    ['in-yow', '渥太華', 45.42, -75.70],
  ],
  '🌏 墨西哥': [
    ['in-mex', '墨西哥城', 19.43, -99.13],
    ['in-cun', '坎昆', 21.16, -86.85],
  ],
  '🌏 中南美洲': [
    ['in-gru', '聖保羅(巴西)', -23.55, -46.63],
    ['in-gig', '里約熱內盧(巴西)', -22.91, -43.17],
    ['in-bog', '波哥大(哥倫比亞)', 4.71, -74.07],
    ['in-lim', '利馬(秘魯)', -12.05, -77.04],
    ['in-scl', '聖地牙哥(智利)', -33.45, -70.67],
    ['in-eze', '布宜諾斯艾利斯(阿根廷)', -34.60, -58.38],
    ['in-pan', '巴拿馬城(巴拿馬)', 8.98, -79.52],
    ['in-hav', '哈瓦那(古巴)', 23.11, -82.37],
  ],
  '🌏 歐洲': [
    ['in-lhr', '倫敦(英國)', 51.51, -0.13],
    ['in-par', '巴黎(法國)', 48.86, 2.35],
    ['in-fra', '法蘭克福(德國)', 50.11, 8.68],
    ['in-ber', '柏林(德國)', 52.52, 13.41],
    ['in-muc', '慕尼黑(德國)', 48.14, 11.58],
    ['in-ams', '阿姆斯特丹(荷蘭)', 52.37, 4.90],
    ['in-zrh', '蘇黎世(瑞士)', 47.37, 8.55],
    ['in-prg', '布拉格(捷克)', 50.08, 14.44],
    ['in-mad', '馬德里(西班牙)', 40.42, -3.70],
    ['in-bcn', '巴塞隆納(西班牙)', 41.39, 2.17],
    ['in-rom', '羅馬(義大利)', 41.90, 12.50],
    ['in-mil', '米蘭(義大利)', 45.46, 9.19],
    ['in-vie', '維也納(奧地利)', 48.21, 16.37],
    ['in-waw', '華沙(波蘭)', 52.23, 21.01],
    ['in-bru', '布魯塞爾(比利時)', 50.85, 4.35],
    ['in-cph', '哥本哈根(丹麥)', 55.68, 12.57],
    ['in-sto', '斯德哥爾摩(瑞典)', 59.33, 18.07],
    ['in-hel', '赫爾辛基(芬蘭)', 60.17, 24.94],
    ['in-osl', '奧斯陸(挪威)', 59.91, 10.75],
    ['in-lis', '里斯本(葡萄牙)', 38.72, -9.14],
    ['in-ath', '雅典(希臘)', 37.98, 23.73],
    ['in-ist', '伊斯坦堡(土耳其)', 41.01, 28.98],
    ['in-mow', '莫斯科(俄羅斯)', 55.76, 37.62],
    ['in-dub', '都柏林(愛爾蘭)', 53.35, -6.26],
  ],
  '🌏 中東/非洲': [
    ['in-dxb', '杜拜(阿聯)', 25.20, 55.27],
    ['in-doh', '杜哈(卡達)', 25.29, 51.53],
    ['in-ruh', '利雅德(沙烏地)', 24.69, 46.72],
    ['in-tlv', '特拉維夫(以色列)', 32.08, 34.78],
    ['in-cai', '開羅(埃及)', 30.04, 31.24],
    ['in-jnb', '約翰尼斯堡(南非)', -26.20, 28.05],
    ['in-cpt', '開普敦(南非)', -33.92, 18.42],
    ['in-nbo', '奈洛比(肯亞)', -1.29, 36.82],
  ],
  '🌏 南亞': [
    ['in-del', '新德里(印度)', 28.61, 77.21],
    ['in-bom', '孟買(印度)', 19.08, 72.88],
    ['in-dac', '達卡(孟加拉)', 23.81, 90.41],
    ['in-cmb', '可倫坡(斯里蘭卡)', 6.93, 79.85],
  ],
  '🛫 港澳/菲律賓/越柬機場': [
    ['ap-VHHH', 'VHHH 香港赤鱲角', 22.309, 113.914],
    ['ap-VMMC', 'VMMC 澳門', 22.149, 113.592],
    ['ap-RPLC', 'RPLC 克拉克', 15.186, 120.560],
    ['ap-RPLL', 'RPLL 馬尼拉', 14.508, 121.019],
    ['ap-RPMD', 'RPMD 達沃', 7.125, 125.646],
    ['ap-RPVM', 'RPVM 宿霧', 10.307, 123.978],
    ['ap-VVNB', 'VVNB 河內內排', 21.221, 105.807],
    ['ap-VVPQ', 'VVPQ 富國', 10.227, 103.967],
    ['ap-VVTS', 'VVTS 胡志明', 10.819, 106.652],
    ['ap-VDPP', 'VDPP 金邊', 11.547, 104.844],
    ['ap-VVCR', 'VVCR 芽莊', 12.227, 109.192],
    ['ap-VVDN', 'VVDN 峴港', 16.044, 108.199],
  ],
  '🛫 日本機場': [
    ['ap-RJAA', 'RJAA 成田', 35.764, 140.386],
    ['ap-RJBB', 'RJBB 關西', 34.427, 135.244],
    ['ap-RJBE', 'RJBE 神戶', 34.633, 135.224],
    ['ap-RJCC', 'RJCC 新千歲', 42.775, 141.692],
    ['ap-RJCH', 'RJCH 函館', 41.770, 140.822],
    ['ap-RJFF', 'RJFF 福岡', 33.585, 130.451],
    ['ap-RJFK', 'RJFK 鹿兒島', 31.804, 130.719],
    ['ap-RJFT', 'RJFT 熊本', 32.837, 130.855],
    ['ap-RJFU', 'RJFU 長崎', 32.917, 129.914],
    ['ap-RJGG', 'RJGG 中部', 34.858, 136.805],
    ['ap-RJNK', 'RJNK 小松', 36.395, 136.407],
    ['ap-RJOS', 'RJOS 德島', 34.133, 134.607],
    ['ap-RJOT', 'RJOT 高松', 34.214, 134.016],
    ['ap-RJSN', 'RJSN 新潟', 37.956, 139.121],
    ['ap-RJSS', 'RJSS 仙台', 38.140, 140.917],
    ['ap-RJTT', 'RJTT 羽田', 35.552, 139.780],
    ['ap-ROAH', 'ROAH 那霸', 26.196, 127.646],
    ['ap-ROIG', 'ROIG 石垣', 24.397, 124.245],
    ['ap-RORS', 'RORS 下地島', 24.827, 125.145],
  ],
  '🛫 韓國機場': [
    ['ap-RKPC', 'RKPC 濟州', 33.511, 126.493],
    ['ap-RKPK', 'RKPK 釜山', 35.180, 128.938],
    ['ap-RKSI', 'RKSI 仁川', 37.463, 126.440],
    ['ap-RKSS', 'RKSS 金浦', 37.558, 126.790],
    ['ap-RKTN', 'RKTN 大邱', 35.894, 128.659],
  ],
  '🛫 東南亞機場 (泰馬印新)': [
    ['ap-VTBS', 'VTBS 素萬那普', 13.690, 100.750],
    ['ap-VTBD', 'VTBD 廊曼', 13.912, 100.606],
    ['ap-VTBU', 'VTBU 烏達保', 12.680, 101.005],
    ['ap-VTCC', 'VTCC 清邁', 18.766, 98.963],
    ['ap-VTSP', 'VTSP 普吉', 8.113, 98.317],
    ['ap-WSSS', 'WSSS 新加坡樟宜', 1.364, 103.991],
    ['ap-WMKK', 'WMKK 吉隆坡', 2.746, 101.707],
    ['ap-WMKP', 'WMKP 檳城', 5.297, 100.277],
    ['ap-WBGG', 'WBGG 古晉', 1.485, 110.347],
    ['ap-WIII', 'WIII 雅加達蘇卡諾', -6.126, 106.656],
    ['ap-WARR', 'WARR 泗水朱安達', -7.379, 112.787],
    ['ap-WADD', 'WADD 峇里島', -8.748, 115.167],
  ],
  '🛫 美國機場': [
    ['ap-KLAX', 'KLAX 洛杉磯', 33.942, -118.408],
    ['ap-KSFO', 'KSFO 舊金山', 37.619, -122.375],
    ['ap-KSEA', 'KSEA 西雅圖', 47.449, -122.309],
    ['ap-KPHX', 'KPHX 鳳凰城', 33.434, -112.012],
    ['ap-KLAS', 'KLAS 拉斯維加斯', 36.080, -115.152],
    ['ap-KONT', 'KONT 安大略', 34.056, -117.601],
    ['ap-KOAK', 'KOAK 奧克蘭', 37.721, -122.221],
    ['ap-KPDX', 'KPDX 波特蘭', 45.589, -122.595],
    ['ap-KSMF', 'KSMF 沙加緬度', 38.695, -121.591],
    ['ap-KTUS', 'KTUS 土森', 32.116, -110.941],
  ],
  '🛫 太平洋機場': [
    ['ap-PHNL', 'PHNL 檀香山', 21.319, -157.922],
    ['ap-PANC', 'PANC 安克拉治', 61.174, -149.998],
    ['ap-PAFA', 'PAFA 費爾班克斯', 64.815, -147.856],
    ['ap-PGUM', 'PGUM 關島', 13.484, 144.800],
    ['ap-PGSN', 'PGSN 塞班', 15.119, 145.729],
    ['ap-PTRO', 'PTRO 帛琉', 7.367, 134.544],
    ['ap-PACD', 'PACD Cold Bay', 55.206, -162.725],
    ['ap-PAKN', 'PAKN King Salmon', 58.677, -156.649],
    ['ap-PASY', 'PASY Shemya', 52.712, 174.114],
    ['ap-PMDY', 'PMDY 中途島', 28.212, -177.381],
    ['ap-PWAK', 'PWAK 威克島', 19.281, 166.638],
  ],
  '🛫 加拿大機場': [
    ['ap-CYVR', 'CYVR 溫哥華', 49.195, -123.184],
  ],
  '🛫 歐洲機場': [
    ['ap-LKPR', 'LKPR 布拉格', 50.101, 14.264],
    ['ap-EDDB', 'EDDB 柏林布蘭登堡', 52.366, 13.503],
    ['ap-EDDM', 'EDDM 慕尼黑', 48.354, 11.786],
    ['ap-EPWA', 'EPWA 華沙蕭邦', 52.166, 20.967],
    ['ap-LOWL', 'LOWL 林茲', 48.233, 14.188],
    ['ap-LOWW', 'LOWW 維也納', 48.110, 16.570],
  ],
};
const WX_PRESET_MAP = {};
Object.values(WX_PRESETS).forEach(arr => arr.forEach(p => { WX_PRESET_MAP[p[0]] = { id: p[0], name: p[1], lat: p[2], lon: p[3] }; }));
// 沒有絕對上限（使用者自己的選擇），只有 soft warning 超過 N 提示
const WX_SOFT_WARN = 30;

// 三層架構：區域 → 縣市(WX_PRESETS key) → 行政區(checkbox)
// 台灣的 region 先包在「台灣」super-region 底下
const WX_TAIWAN_REGIONS = ['北北基', '桃竹苗', '中彰投', '雲嘉南', '高高屏', '宜花東', '外島', '台灣景點'];

// 順序：台灣全部 → 國際城市 → 國際機場
const WX_REGIONS = {
  // ── 台灣 ──
  '北北基': ['🇹🇼 台北市', '🇹🇼 新北市', '🇹🇼 基隆市'],
  '桃竹苗': ['🇹🇼 桃園市', '🇹🇼 新竹市', '🇹🇼 新竹縣', '🇹🇼 苗栗縣'],
  '中彰投': ['🇹🇼 台中市', '🇹🇼 彰化縣', '🇹🇼 南投縣'],
  '雲嘉南': ['🇹🇼 雲林縣', '🇹🇼 嘉義市', '🇹🇼 嘉義縣', '🇹🇼 台南市'],
  '高高屏': ['🇹🇼 高雄市', '🇹🇼 屏東縣'],
  '宜花東': ['🇹🇼 宜蘭縣', '🇹🇼 花蓮縣', '🇹🇼 台東縣'],
  '外島': ['🇹🇼 澎湖縣', '🇹🇼 金門縣', '🇹🇼 馬祖(連江縣)'],
  // ── 台灣景點（放在台灣底下） ──
  '台灣景點': ['🏞️ 台灣景點'],
  // ── 國際城市 ──
  '東北亞城市': ['🌏 日本', '🌏 韓國', '🌏 中國大陸', '🌏 港澳'],
  '東南亞城市': ['🌏 東南亞'],
  '南亞城市': ['🌏 南亞'],
  '大洋洲城市': ['🌏 大洋洲'],
  '中東/非洲城市': ['🌏 中東/非洲'],
  '歐洲城市': ['🌏 歐洲'],
  '北美城市': ['🌏 美國', '🌏 加拿大'],
  '中南美洲城市': ['🌏 墨西哥', '🌏 中南美洲'],
  // ── 國際機場（全部在一個 region 底下再分區） ──
  '國際機場': ['🛫 日本機場', '🛫 韓國機場', '🛫 港澳/菲律賓/越柬機場', '🛫 東南亞機場 (泰馬印新)', '🛫 美國機場', '🛫 加拿大機場', '🛫 太平洋機場', '🛫 歐洲機場'],
};

// 台股預設清單（代號 + 名稱）
const TW_PRESETS = {
  '半導體': [
    ['2330','台積電'],['2454','聯發科'],['2303','聯電'],['2408','南亞科'],
    ['2379','瑞昱'],['3034','聯詠'],['3443','創意'],['3661','世芯-KY'],
    ['3711','日月光投控'],['6488','環球晶'],['8046','南電'],
  ],
  '電子': [
    ['2317','鴻海'],['2308','台達電'],['2382','廣達'],['2357','華碩'],
    ['2353','宏碁'],['2376','技嘉'],['2356','英業達'],['3231','緯創'],
    ['2324','仁寶'],['2412','中華電'],['2409','友達'],
  ],
  '金融': [
    ['2881','富邦金'],['2882','國泰金'],['2884','玉山金'],['2886','兆豐金'],
    ['2891','中信金'],['2892','第一金'],['5880','合庫金'],
  ],
  '傳產/航運': [
    ['1216','統一'],['1301','台塑'],['1303','南亞'],['2002','中鋼'],
    ['2603','長榮'],['2609','陽明'],['2610','華航'],['2618','長榮航'],['2912','統一超'],
  ],
};
const TW_PRESET_SET = new Set();
Object.values(TW_PRESETS).forEach(arr => arr.forEach(p => TW_PRESET_SET.add(p[0])));
const TW_PRESET_NAMES = {};
Object.values(TW_PRESETS).forEach(arr => arr.forEach(p => { TW_PRESET_NAMES[p[0]] = p[1]; }));

// 美股預設清單
const US_PRESETS = {
  '科技': [
    ['AAPL','Apple'],['MSFT','Microsoft'],['GOOGL','Alphabet'],['META','Meta'],
    ['AMZN','Amazon'],['NVDA','NVIDIA'],['TSLA','Tesla'],['AMD','AMD'],
    ['INTC','Intel'],['TSM','TSMC ADR'],['ORCL','Oracle'],['CRM','Salesforce'],
    ['ADBE','Adobe'],['NFLX','Netflix'],
  ],
  'ETF': [
    ['VOO','S&P 500'],['VT','Total World'],['VTI','Total US'],['QQQ','Nasdaq 100'],
    ['SPY','S&P 500'],['DIA','Dow 30'],['IWM','Russell 2000'],['SCHD','Dividend'],
  ],
  '金融': [
    ['BRK.B','Berkshire'],['JPM','JPMorgan'],['V','Visa'],['MA','Mastercard'],
    ['BAC','Bank of America'],['WFC','Wells Fargo'],['GS','Goldman Sachs'],
  ],
  '消費/其他': [
    ['DIS','Disney'],['NKE','Nike'],['COST','Costco'],['VST','Vistra'],
    ['KO','Coca-Cola'],['PEP','PepsiCo'],['MCD','McDonalds'],
  ],
};
const US_PRESET_SET = new Set();
Object.values(US_PRESETS).forEach(arr => arr.forEach(p => US_PRESET_SET.add(p[0])));
const US_PRESET_NAMES = {};
Object.values(US_PRESETS).forEach(arr => arr.forEach(p => { US_PRESET_NAMES[p[0]] = p[1]; }));

// 匯率預設清單（貨幣對）
const FX_PRESETS = {
  '對台幣': [
    'USD/TWD','JPY/TWD','EUR/TWD','CNY/TWD','HKD/TWD',
    'SGD/TWD','GBP/TWD','AUD/TWD','CAD/TWD','KRW/TWD','THB/TWD',
  ],
  '主要貨幣對': [
    'EUR/USD','USD/JPY','GBP/USD','USD/CHF','USD/CNY',
    'USD/HKD','USD/SGD','AUD/USD','NZD/USD','USD/CAD',
  ],
  '交叉盤': [
    'EUR/JPY','GBP/JPY','EUR/GBP','AUD/JPY',
  ],
};
const FX_PRESET_SET = new Set();
Object.values(FX_PRESETS).forEach(arr => arr.forEach(p => FX_PRESET_SET.add(p)));

// 沒絕對上限，soft warning 閾值
const TW_SOFT_WARN = 30;
const US_SOFT_WARN = 30;
const FX_SOFT_WARN = 20;

const DEFAULTS = {
  wxPresets: ['tw-taipei', 'tw-guishan'],
  wxCustom: [],
  tw: ['2330','3231'],
  us: ['NVDA','TSLA','VST','VT','VOO','QQQ'],
  fx: ['USD/TWD','JPY/TWD','EUR/TWD','SGD/TWD','CNY/TWD'],
};

function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem(LS[key]);
    if (!v) return fallback;
    let parsed = JSON.parse(v);
    // 舊版 fx 相容：['USD','JPY',...] → ['USD/TWD','JPY/TWD',...]
    if (key === 'fx' && Array.isArray(parsed)) {
      parsed = parsed.map(x => (typeof x === 'string' && !x.includes('/')) ? (x + '/TWD') : x);
    }
    return parsed;
  } catch (e) { return fallback; }
}
function saveSetting(key, val) {
  try { localStorage.setItem(LS[key], JSON.stringify(val)); } catch (e) {}
}

// 取得目前要顯示的天氣地點（合併 presets + custom，並保留排序、套上限）
function getActiveWxLocs() {
  // 舊版相容：若 legacy 存在，轉成 custom 並清掉 legacy
  try {
    const legacy = localStorage.getItem(LS.wxLegacy);
    if (legacy) {
      const arr = JSON.parse(legacy);
      if (Array.isArray(arr) && arr.length > 0) {
        saveSetting('wxCustom', arr);
        localStorage.removeItem(LS.wxLegacy);
      }
    }
  } catch (e) {}
  const presetIds = loadSetting('wxPresets', DEFAULTS.wxPresets);
  const custom = loadSetting('wxCustom', DEFAULTS.wxCustom);
  const out = [];
  for (const id of presetIds) {
    if (WX_PRESET_MAP[id]) out.push(WX_PRESET_MAP[id]);
  }
  for (const c of custom) {
    if (c && c.name && typeof c.lat === 'number' && typeof c.lon === 'number') out.push(c);
  }
  return out;
}

function fmtNum(n, dec) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function pct(p) {
  if (p == null || isNaN(p)) return '—';
  const s = p > 0 ? '+' : '';
  return s + Number(p).toFixed(2) + '%';
}
function chgClass(c) {
  if (c == null || c === 0) return 'flat';
  return c > 0 ? 'up' : 'down';
}
function chgSign(c) {
  if (c > 0) return '▲';
  if (c < 0) return '▼';
  return '·';
}

// 天氣展開狀態（每個地點獨立）
function getWxExpandedSet() {
  try {
    const raw = localStorage.getItem(LS.wxExpanded);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { return new Set(); }
}
function isWxExpanded(name) {
  return getWxExpandedSet().has(String(name || ''));
}
function toggleWx(name) {
  const s = getWxExpandedSet();
  const key = String(name || '');
  if (s.has(key)) s.delete(key); else s.add(key);
  try { localStorage.setItem(LS.wxExpanded, JSON.stringify(Array.from(s))); } catch (e) {}
  // 直接切 DOM class，不用 re-render
  document.querySelectorAll('.wx-loc').forEach(el => {
    if (el.getAttribute('data-wxname') === key) el.classList.toggle('expanded');
  });
}
window.toggleWx = toggleWx;

// ── Stock row expand / holding input ──────────────────────────────
function toggleStockRow(el) {
  if (!el) return;
  el.classList.toggle('expanded');
  // 展開時自動 focus 第一個 input，方便直接打字
  if (el.classList.contains('expanded')) {
    const firstInput = el.querySelector('.stock-expand input');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
  }
}
window.toggleStockRow = toggleStockRow;
function onHoldingInputBlur(e) {
  const inp = e.target;
  const row = inp.closest('.stock-row');
  if (!row) return;
  // 延遲一點判斷，避免 tab/click 去下一個 input 時誤收合
  setTimeout(() => {
    const active = document.activeElement;
    const panel = row.querySelector('.stock-expand');
    if (panel && panel.contains(active)) return;  // focus 還在同 panel 內
    row.classList.remove('expanded');
  }, 150);
}
window.onHoldingInputBlur = onHoldingInputBlur;
let _holdingSaveTimer = null;
function onHoldingInput(e) {
  const inp = e.target;
  const market = inp.getAttribute('data-market');
  const code = inp.getAttribute('data-code');
  const field = inp.getAttribute('data-field');
  const key = market === 'tw' ? 'twHoldings' : 'usHoldings';
  const map = loadSetting(key, {}) || {};
  const cur = map[code] || { qty: 0, cost: 0 };
  const val = Number(inp.value);
  if (isNaN(val)) return;
  cur[field] = val;
  map[code] = cur;
  saveSetting(key, map);
  // 更新這列的 row-hold 顯示（不 re-render 整個區塊，避免失焦）
  updateStockRowHoldingInline(market, code);
  // Debounce POST server
  if (_holdingSaveTimer) clearTimeout(_holdingSaveTimer);
  _holdingSaveTimer = setTimeout(() => {
    const body = {};
    body[market === 'tw' ? 'tw_holdings' : 'us_holdings'] = loadSetting(key, {});
    postPrefsPartial(body);
  }, 500);
}
window.onHoldingInput = onHoldingInput;
function clearHolding(market, code) {
  const key = market === 'tw' ? 'twHoldings' : 'usHoldings';
  const map = loadSetting(key, {}) || {};
  delete map[code];
  saveSetting(key, map);
  // 把該列 input 清空 + 更新 row-hold
  document.querySelectorAll('.stock-expand input[data-market="' + market + '"][data-code="' + code + '"]').forEach(inp => { inp.value = ''; });
  updateStockRowHoldingInline(market, code);
  const body = {};
  body[market === 'tw' ? 'tw_holdings' : 'us_holdings'] = map;
  postPrefsPartial(body);
}
window.clearHolding = clearHolding;
function updateStockRowHoldingInline(market, code) {
  const row = document.querySelector('.stock-row[data-market="' + market + '"][data-code="' + code + '"]');
  if (!row) return;
  const holdings = getMarketHoldings(market);
  const h = holdings[code];
  const priceEl = row.querySelector('.row-r .p');
  const price = priceEl ? Number(String(priceEl.textContent).replace(/,/g, '')) : NaN;
  let existing = row.querySelector('.row-hold-sub');
  if (!h || !h.qty) {
    if (existing) existing.remove();
    updateStockSummaryInline(market);
    return;
  }
  const resetBtn = '<button class="hold-x" onclick="event.stopPropagation();clearHolding(\\'' + market + '\\',\\'' + code + '\\')" title="清除此筆持倉">✕</button>';
  let html;
  if (!isFinite(price)) {
    html = '<span class="lbl">市值</span> — · <span class="lbl">持倉</span> ' + h.qty + ' ' + resetBtn;
  } else {
    const mv = price * h.qty;
    const plAbs = (price - Number(h.cost)) * h.qty;
    const plPct = h.cost > 0 ? ((price - h.cost) / h.cost) * 100 : 0;
    const pcls = plAbs > 0 ? 'up' : (plAbs < 0 ? 'down' : 'flat');
    const psign = plAbs >= 0 ? '+' : '';
    html = '<span class="lbl">市值</span> <b>' + Math.round(mv).toLocaleString() + '</b>'
      + ' · <span class="lbl">損益</span> <b class="' + pcls + '">' + psign + Math.round(plAbs).toLocaleString() + ' (' + psign + plPct.toFixed(2) + '%)</b>'
      + ' ' + resetBtn;
  }
  if (!existing) {
    existing = document.createElement('div');
    existing.className = 'row-hold-sub';
    const expand = row.querySelector('.stock-expand');
    row.insertBefore(existing, expand);
  }
  existing.innerHTML = html;
  updateStockSummaryInline(market);
}
// 更新區塊頂端加總
function updateStockSummaryInline(market) {
  const secId = market === 'tw' ? 'sec-stw' : 'sec-sus';
  const sec = document.getElementById(secId);
  if (!sec) return;
  const body = sec.querySelector('.sec-b');
  if (!body) return;
  const holdings = getMarketHoldings(market);
  // 掃該區塊每一列：從 data-code 抓、讀現價從 row-r .p
  const rows = body.querySelectorAll('.stock-row');
  let totalMv = 0, totalCost = 0, totalPl = 0, hasAny = false;
  rows.forEach(r => {
    const code = r.getAttribute('data-code');
    const h = holdings[code];
    if (!h || !h.qty) return;
    const priceEl = r.querySelector('.row-r .p');
    const price = priceEl ? Number(String(priceEl.textContent).replace(/,/g, '')) : NaN;
    if (!isFinite(price)) return;
    hasAny = true;
    totalMv += price * h.qty;
    totalCost += Number(h.cost) * h.qty;
    totalPl += (price - Number(h.cost)) * h.qty;
  });
  let summary = body.querySelector('.stock-summary');
  if (!hasAny) {
    if (summary) summary.remove();
    return;
  }
  const pct = totalCost > 0 ? (totalPl / totalCost) * 100 : 0;
  const cls = totalPl > 0 ? 'up' : (totalPl < 0 ? 'down' : 'flat');
  const sign = totalPl >= 0 ? '+' : '';
  const html = '💰 <span class="lbl">總市值</span> <b>' + Math.round(totalMv).toLocaleString() + '</b>'
    + ' · <span class="lbl">總損益</span> <b class="' + cls + '">' + sign + Math.round(totalPl).toLocaleString() + ' (' + sign + pct.toFixed(2) + '%)</b>';
  if (!summary) {
    summary = document.createElement('div');
    summary.className = 'stock-summary';
    body.insertBefore(summary, body.firstChild);
  }
  summary.innerHTML = html;
}
// 全區清除該市場所有持倉
function clearAllHoldings(market) {
  if (!confirm('確定清除全部' + (market === 'tw' ? '台股' : '美股') + '持倉？')) return;
  const key = market === 'tw' ? 'twHoldings' : 'usHoldings';
  saveSetting(key, {});
  // 清所有 input 值 + 移除 sub-row
  const secId = market === 'tw' ? 'sec-stw' : 'sec-sus';
  const sec = document.getElementById(secId);
  if (sec) {
    sec.querySelectorAll('.stock-expand input').forEach(inp => {
      if (inp.getAttribute('data-market') === market) inp.value = '';
    });
    sec.querySelectorAll('.row-hold-sub').forEach(el => el.remove());
    const summary = sec.querySelector('.stock-summary');
    if (summary) summary.remove();
  }
  // 設定 modal 的表格也重繪
  renderHoldingsTable(market);
  const body = {};
  body[market === 'tw' ? 'tw_holdings' : 'us_holdings'] = {};
  postPrefsPartial(body);
}
window.clearAllHoldings = clearAllHoldings;

// ── FX calculator (本機 localStorage 儲存) ────────────────────────
function onFxInput(e) {
  const inp = e.target;
  const pair = inp.getAttribute('data-pair');
  if (!pair) return;
  const map = loadSetting('fxInputs', {}) || {};
  const v = inp.value.trim();
  if (v === '') delete map[pair]; else map[pair] = Number(v);
  saveSetting('fxInputs', map);
  updateFxResultInline(pair);
}
window.onFxInput = onFxInput;
function flipFxDir(pair) {
  const map = loadSetting('fxDirections', {}) || {};
  map[pair] = (map[pair] === 'rtl') ? 'ltr' : 'rtl';
  saveSetting('fxDirections', map);
  // 重新渲染該列
  const row = document.querySelector('.fx-row[data-pair="' + pair + '"]');
  if (row) {
    const cal = row.querySelector('.fx-calc');
    if (cal) {
      const ccys = cal.querySelectorAll('.fx-ccy');
      if (ccys.length >= 2) {
        const left = ccys[0].textContent;
        const right = ccys[1].textContent;
        ccys[0].textContent = right;
        ccys[1].textContent = left;
      }
    }
  }
  updateFxResultInline(pair);
}
window.flipFxDir = flipFxDir;
function clearFxInput(pair) {
  const map = loadSetting('fxInputs', {}) || {};
  delete map[pair];
  saveSetting('fxInputs', map);
  const row = document.querySelector('.fx-row[data-pair="' + pair + '"]');
  if (row) {
    const inp = row.querySelector('.fx-calc input');
    if (inp) inp.value = '';
  }
  updateFxResultInline(pair);
}
window.clearFxInput = clearFxInput;
function applyFxDecimals(val) {
  if (![0, 2, 4].includes(val)) return;
  saveSetting('fxDecimals', val);
  document.querySelectorAll('.fx-row').forEach(row => {
    const pair = row.getAttribute('data-pair');
    if (pair) updateFxResultInline(pair);
  });
  // 更新 header 按鈕 label
  const btn = document.querySelector('.sec-fx-dec');
  if (btn) btn.textContent = '.' + val;
  // 更新 modal 下拉
  const sel = document.getElementById('set-fx-decimals');
  if (sel) sel.value = String(val);
  postPrefsPartial({ fx_decimals: val });
}
function onFxDecimalsChange(e) {
  applyFxDecimals(Number(e.target.value));
}
window.onFxDecimalsChange = onFxDecimalsChange;
function cycleFxDecimals() {
  const cur = Number(loadSetting('fxDecimals', 0)) || 0;
  const next = cur === 0 ? 2 : (cur === 2 ? 4 : 0);
  applyFxDecimals(next);
}
window.cycleFxDecimals = cycleFxDecimals;

function clearAllFx() {
  if (!confirm('確定清除全部匯率換算的輸入數字？')) return;
  saveSetting('fxInputs', {});
  document.querySelectorAll('.fx-row').forEach(row => {
    const inp = row.querySelector('.fx-calc input');
    if (inp) inp.value = '';
    const pair = row.getAttribute('data-pair');
    updateFxResultInline(pair);
  });
}
window.clearAllFx = clearAllFx;
function updateFxResultInline(pair) {
  const row = document.querySelector('.fx-row[data-pair="' + pair + '"]');
  if (!row) return;
  const calc = row.querySelector('.fx-calc');
  if (!calc) return;
  const inp = calc.querySelector('input');
  const rateEl = row.querySelector('.row-r .p');
  const rate = rateEl ? Number(String(rateEl.textContent).replace(/,/g, '')) : NaN;
  const amt = inp ? Number(inp.value) : NaN;
  const resEl = calc.querySelector('.fx-result');
  if (!resEl) return;
  if (!isFinite(rate) || !isFinite(amt) || inp.value === '') { resEl.textContent = '—'; return; }
  const dirMap = loadSetting('fxDirections', {}) || {};
  const dir = dirMap[pair] === 'rtl' ? 'rtl' : 'ltr';
  const r = dir === 'ltr' ? (amt * rate) : (amt / rate);
  const fxDec = Number(loadSetting('fxDecimals', 0)) || 0;
  resEl.textContent = r.toLocaleString('en-US', { minimumFractionDigits: fxDec, maximumFractionDigits: fxDec });
}

function showAqiLegend() {
  const el = document.getElementById('aqi-legend-wrap');
  if (el) el.classList.add('show');
}
function hideAqiLegend() {
  const el = document.getElementById('aqi-legend-wrap');
  if (el) el.classList.remove('show');
}
window.showAqiLegend = showAqiLegend;
window.hideAqiLegend = hideAqiLegend;

// 天氣代碼 → emoji（WMO weather code）
function wxEmoji(code) {
  if (code == null) return '❓';
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌦️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  if (code <= 86) return '🌨️';
  if (code <= 99) return '⛈️';
  return '🌤️';
}

async function fetchReport(date) {
  const q = date ? ('?date=' + date) : '';
  const r = await apiFetch('/api/morning-report' + q);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function renderReport(data) {
  const root = document.getElementById('root');
  const hdrDate = document.getElementById('hdr-date');
  const d = data._actualDate || data.date || '—';
  _currentDisplayedDate = data._actualDate || data.date || null;
  hdrDate.textContent = d + (data._fallback ? ' (今日資料未更新，顯示最近一份)' : '');

  const userTw = loadSetting('tw', DEFAULTS.tw);
  const userUs = loadSetting('us', DEFAULTS.us);
  const userFx = loadSetting('fx', DEFAULTS.fx);

  const activeWx = getActiveWxLocs();
  const wxByName = {};
  (data.weather || []).forEach(w => { if (w && w.name) wxByName[w.name] = w; });
  const wxBlocks = activeWx.length === 0
    ? '<div class="wx-empty">尚未選擇天氣地點，請點標題右邊的 ⚙️<br>No weather locations selected. Tap ⚙️ next to the title.</div>'
    : activeWx.map(loc => {
        const w = wxByName[loc.name] || { name: loc.name, temp: null, feels: null, humidity: null, wind: null, windDir: null, uv: null, code: null, sunrise: '—', sunset: '—', forecast: [] };
        return renderWx(w);
      }).join('');
  const twSummary = renderStockSummary('tw', userTw, data.stocks_tw || {});
  const usSummary = renderStockSummary('us', userUs, data.stocks_us || {});
  const twRows = twSummary + (userTw.map(code => renderStock(code, 'tw', (data.stocks_tw || {})[code])).join('') || emptyRow());
  const usRows = usSummary + (userUs.map(code => renderStock(code, 'us', (data.stocks_us || {})[code])).join('') || emptyRow());
  const fxRows = userFx.map(c => renderFx(c, (data.fx || {})[c])).join('') || emptyRow();
  // 台灣新聞：支援舊格式（陣列）+ 新格式（分類物件）
  let twNews = '';
  const twNewsData = data.news_tw || {};
  if (Array.isArray(twNewsData)) {
    // 舊格式 fallback
    twNews = twNewsData.slice(0, 10).map(renderNews).join('') || emptyNews();
  } else {
    // 新格式：分類物件 { 熱門: [...], 娛樂: [...], ... }
    const defaultCatOrder = ['熱門','娛樂','股市','國際','天氣','玩樂','理財','電影','時尚','健康'];
    const savedCatOrder = loadSetting('newsCatOrder', null);
    const allCats = Object.keys(twNewsData);
    const catOrder = savedCatOrder ? savedCatOrder.filter(c => allCats.includes(c)) : defaultCatOrder.filter(c => allCats.includes(c));
    allCats.forEach(c => { if (!catOrder.includes(c)) catOrder.push(c); });
    if (catOrder.length === 0) {
      twNews = emptyNews();
    } else {
      twNews = '<div id="tw-news-cats">' + catOrder.map(cat => {
        const items = twNewsData[cat] || [];
        if (items.length === 0) return '';
        const ck = 'tw-news-' + cat;
        const collapsed = loadSetting('secCollapsed', {});
        const isCollapsed = collapsed[ck] !== false;
        return '<div class="news-cat' + (isCollapsed ? ' collapsed' : '') + '" data-newscat="' + cat + '">'
          + '<div class="news-cat-title">'
          + '<div class="nc-left">'
          + '<span class="sec-drag nc-drag" title="拖移排序">≡</span>'
          + '<span onclick="toggleNewsCat(\\'' + cat + '\\')">' + cat + ' <span style="font-size:.8em;color:var(--muted)">(' + items.length + ')</span></span>'
          + '</div>'
          + '<span class="sec-collapse-arrow" onclick="toggleNewsCat(\\'' + cat + '\\')">▼</span></div>'
          + '<div class="news-cat-body">' + items.map(renderNews).join('') + '</div></div>';
      }).join('') + '</div>';
    }
  }
  const wwNews = (data.news_world || []).slice(0, 10).map(renderNewsWorld).join('') || emptyNews();

  const setBtn = (sec) => \`<button class="sec-set-btn" title="設定" onclick="showSet('\${sec}')">⚙️</button>\`;
  const refreshBtn = (sec) => \`<button class="sec-set-btn" title="重新抓取此區塊" onclick="refreshPartial('\${sec}')">🔄</button>\`;
  const fxDecBtn = () => {
    const d = Number(loadSetting('fxDecimals', 0)) || 0;
    return \`<button class="sec-set-btn sec-fx-dec" title="切換小數位數（0 / 2 / 4）" onclick="cycleFxDecimals()">.\${d}</button>\`;
  };
  // M/D HH:MM（台北時區）
  const fmtFetchedAt = (iso) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      // 台北 = UTC+8，用 UTC 時間 + 8 小時抓台北時間欄位
      const tpe = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
      const m = tpe.getMonth() + 1;
      const day = tpe.getDate();
      const hh = String(tpe.getHours()).padStart(2, '0');
      const mm = String(tpe.getMinutes()).padStart(2, '0');
      return m + '/' + day + ' ' + hh + ':' + mm;
    } catch (e) { return ''; }
  };
  const timeSpan = (iso) => {
    const s = fmtFetchedAt(iso);
    // 永遠 render span（即使空的），方便 refreshPartial 後 JS 能 updated
    return \`<span class="sec-time" title="資料更新時間">\${s}</span>\`;
  };
  const secOrder = loadSetting('secOrder', ['sec-wx','sec-stw','sec-sus','sec-fx','sec-ntw','sec-nww']);
  const secDefs = {
    'sec-wx':  { icon: '🌤️', label: '天氣 Weather', body: wxBlocks || emptyRow(), set: timeSpan(data.weather_fetched_at) + refreshBtn('weather') + setBtn('wx') },
    'sec-stw': { icon: '📈', label: '台股 TW Stocks', body: twRows, set: timeSpan(data.stocks_tw_fetched_at) + refreshBtn('stocks_tw') + setBtn('tw') },
    'sec-sus': { icon: '🇺🇸', label: '美股 US Stocks', body: usRows, set: timeSpan(data.stocks_us_fetched_at) + refreshBtn('stocks_us') + setBtn('us') },
    'sec-fx':  { icon: '💱', label: '匯率 FX', body: fxRows, set: timeSpan(data.fx_fetched_at) + fxDecBtn() + refreshBtn('fx') + setBtn('fx') },
    'sec-ntw': { icon: '🇹🇼', label: '台灣新聞 TW News', body: twNews, set: '' },
    'sec-nww': { icon: '🌍', label: '世界新聞 World News', body: wwNews, set: '' },
  };
  const collapsed = loadSetting('secCollapsed', {});
  root.innerHTML = secOrder.map(id => {
    const s = secDefs[id];
    if (!s) return '';
    const cls = collapsed[id] ? ' collapsed' : '';
    return \`<div class="sec\${cls}" id="\${id}" draggable="false">
      <div class="sec-h">
        <span class="sec-drag" title="拖移排序">≡</span>
        <div class="sec-left" data-collapse="\${id}">
          <span class="icon">\${s.icon}</span>\${s.label}
          <span class="sec-collapse-arrow">▼</span>
        </div>
        <div class="sec-right">\${s.set}</div>
      </div>
      <div class="sec-b">\${s.body}</div>
    </div>\`;
  }).join('');
  setupNavActive();
  setupSectionCollapse();
  setupSectionDrag();
  updateNavOrder();
  setupNavDrag();
  setupNewsCatDrag();
  // 主畫面自選項目拖移排序（天氣/台股/美股/匯率）
  setupItemDrag('#sec-wx .sec-b', '.wx-loc', 'wx');
  setupItemDrag('#sec-stw .sec-b', '.row', 'tw');
  setupItemDrag('#sec-sus .sec-b', '.row', 'us');
  setupItemDrag('#sec-fx .sec-b', '.row', 'fx');
}

// ── 主畫面 item-level drag（長按 ≡ 把手拖移，跟 section 相同手感） ──
function setupItemDrag(containerSelector, itemSelector, section) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  let dragItem = null;
  let placeholder = null;
  function items() { return Array.from(container.querySelectorAll(itemSelector)); }
  function saveOrder() {
    const order = items().map(el => el.getAttribute('data-itemkey')).filter(Boolean);
    saveItemOrder(section, order);
  }
  container.querySelectorAll('.item-drag').forEach(handle => {
    const item = handle.closest(itemSelector);
    if (!item) return;
    // Mouse
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragItem = item;
      item.classList.add('item-dragging');
      const onMove = (ev) => {
        const y = ev.clientY;
        const its = items();
        let target = null;
        for (const s of its) {
          if (s === dragItem) continue;
          const r = s.getBoundingClientRect();
          if (y < r.top + r.height / 2) { target = s; break; }
        }
        its.forEach(s => s.classList.remove('item-drag-over'));
        if (target) target.classList.add('item-drag-over');
        placeholder = target;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        items().forEach(s => s.classList.remove('item-drag-over'));
        if (dragItem) dragItem.classList.remove('item-dragging');
        if (placeholder && dragItem) {
          container.insertBefore(dragItem, placeholder);
          saveOrder();
        }
        dragItem = null;
        placeholder = null;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // Touch
    handle.addEventListener('touchstart', (e) => {
      dragItem = item;
      item.classList.add('item-dragging');
      const onMove = (ev) => {
        ev.preventDefault();
        const touch = ev.touches[0];
        const y = touch.clientY;
        const its = items();
        let target = null;
        for (const s of its) {
          if (s === dragItem) continue;
          const r = s.getBoundingClientRect();
          if (y < r.top + r.height / 2) { target = s; break; }
        }
        its.forEach(s => s.classList.remove('item-drag-over'));
        if (target) target.classList.add('item-drag-over');
        placeholder = target;
      };
      const onEnd = () => {
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        items().forEach(s => s.classList.remove('item-drag-over'));
        if (dragItem) dragItem.classList.remove('item-dragging');
        if (placeholder && dragItem) {
          container.insertBefore(dragItem, placeholder);
          saveOrder();
        }
        dragItem = null;
        placeholder = null;
      };
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    }, { passive: true });
  });
}

function saveItemOrder(section, orderedKeys) {
  if (!orderedKeys || orderedKeys.length === 0) return;
  if (section === 'wx') {
    // orderedKeys = location names；拆回 wxPresets（ID 序列）+ wxCustom（物件序列）
    const nameToId = {};
    const nameToLatLon = {};
    Object.values(WX_PRESETS).forEach(arr => arr.forEach(p => { nameToId[p[1]] = p[0]; nameToLatLon[p[1]] = { lat: p[2], lon: p[3] }; }));
    const oldCustom = loadSetting('wxCustom', []);
    const customByName = {};
    oldCustom.forEach(c => { if (c && c.name) customByName[c.name] = c; });
    const newPresetIds = [];
    const newCustom = [];
    const flat = [];
    for (const name of orderedKeys) {
      if (nameToId[name]) {
        newPresetIds.push(nameToId[name]);
        flat.push({ name, lat: nameToLatLon[name].lat, lon: nameToLatLon[name].lon });
      } else if (customByName[name]) {
        newCustom.push(customByName[name]);
        flat.push(customByName[name]);
      }
    }
    saveSetting('wxPresets', newPresetIds);
    saveSetting('wxCustom', newCustom);
    postPrefsPartial({ wx: flat });
  } else if (section === 'tw') {
    saveSetting('tw', orderedKeys);
    postPrefsPartial({ tw: orderedKeys });
  } else if (section === 'us') {
    saveSetting('us', orderedKeys);
    postPrefsPartial({ us: orderedKeys });
  } else if (section === 'fx') {
    saveSetting('fx', orderedKeys);
    postPrefsPartial({ fx: orderedKeys });
  }
}
function postPrefsPartial(body) {
  try {
    apiFetch('/api/morning-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch (e) {}
}

// ── Section collapse ─────────────────────────────────────────────
function setupSectionCollapse() {
  document.querySelectorAll('.sec-left[data-collapse]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-collapse');
      const sec = document.getElementById(id);
      if (!sec) return;
      sec.classList.toggle('collapsed');
      // Save state
      const collapsed = loadSetting('secCollapsed', {});
      collapsed[id] = sec.classList.contains('collapsed');
      saveSetting('secCollapsed', collapsed);
    });
  });
}

// ── Section drag-to-reorder (touch + mouse) ──────────────────────
function setupSectionDrag() {
  const root = document.getElementById('root');
  if (!root) return;
  let dragId = null;
  let placeholder = null;

  function getSections() { return Array.from(root.querySelectorAll('.sec')); }

  function saveOrder() {
    const order = getSections().map(s => s.id);
    saveSetting('secOrder', order);
    // Also sync to server prefs
    try {
      apiFetch('/api/morning-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secOrder: order }),
      }).catch(() => {});
    } catch (e) {}
    updateNavOrder();
  }

  // Mouse drag
  root.querySelectorAll('.sec-drag').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const sec = handle.closest('.sec');
      if (!sec) return;
      dragId = sec.id;
      sec.classList.add('dragging');
      const onMove = (ev) => {
        const secs = getSections();
        const y = ev.clientY;
        let target = null;
        for (const s of secs) {
          if (s.id === dragId) continue;
          const r = s.getBoundingClientRect();
          if (y < r.top + r.height / 2) { target = s; break; }
        }
        secs.forEach(s => s.classList.remove('drag-over'));
        if (target) target.classList.add('drag-over');
        placeholder = target;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const sec2 = document.getElementById(dragId);
        if (sec2) sec2.classList.remove('dragging');
        getSections().forEach(s => s.classList.remove('drag-over'));
        if (placeholder && dragId) {
          root.insertBefore(document.getElementById(dragId), placeholder);
          saveOrder();
        }
        dragId = null;
        placeholder = null;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Touch drag
    handle.addEventListener('touchstart', (e) => {
      const sec = handle.closest('.sec');
      if (!sec) return;
      dragId = sec.id;
      sec.classList.add('dragging');
      const onMove = (ev) => {
        ev.preventDefault();
        const touch = ev.touches[0];
        const y = touch.clientY;
        const secs = getSections();
        let target = null;
        for (const s of secs) {
          if (s.id === dragId) continue;
          const r = s.getBoundingClientRect();
          if (y < r.top + r.height / 2) { target = s; break; }
        }
        secs.forEach(s => s.classList.remove('drag-over'));
        if (target) target.classList.add('drag-over');
        placeholder = target;
      };
      const onEnd = () => {
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        const sec2 = document.getElementById(dragId);
        if (sec2) sec2.classList.remove('dragging');
        getSections().forEach(s => s.classList.remove('drag-over'));
        if (placeholder && dragId) {
          root.insertBefore(document.getElementById(dragId), placeholder);
          saveOrder();
        }
        dragId = null;
        placeholder = null;
      };
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    }, { passive: true });
  });
}

// ── Nav bar follows section order ─────────────────────────────────
function updateNavOrder() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const order = loadSetting('secOrder', ['sec-wx','sec-stw','sec-sus','sec-fx','sec-ntw','sec-nww']);
  const buttons = Array.from(nav.querySelectorAll('.nav-btn'));
  const btnMap = {};
  buttons.forEach(b => { btnMap[b.getAttribute('data-target')] = b; });
  order.forEach(id => {
    if (btnMap[id]) nav.appendChild(btnMap[id]);
  });
}

// ── Nav bar drag-to-reorder (長按 300ms 進入拖移) ─────────────────
function setupNavDrag() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  let longPressTimer = null;
  let dragBtn = null;

  function getNavBtns() { return Array.from(nav.querySelectorAll('.nav-btn')); }

  function saveNavOrder() {
    const order = getNavBtns().map(b => b.getAttribute('data-target'));
    saveSetting('secOrder', order);
    // Reorder sections in DOM to match
    const root = document.getElementById('root');
    if (root) {
      order.forEach(id => {
        const sec = document.getElementById(id);
        if (sec) root.appendChild(sec);
      });
    }
    // Sync to server
    try {
      apiFetch('/api/morning-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secOrder: order }),
      }).catch(() => {});
    } catch (e) {}
  }

  nav.querySelectorAll('.nav-btn').forEach(btn => {
    // Touch: long press to start drag
    btn.addEventListener('touchstart', (e) => {
      longPressTimer = setTimeout(() => {
        dragBtn = btn;
        btn.classList.add('nav-dragging');
        // Disable nav scroll during drag
        nav.style.overflowX = 'hidden';
      }, 300);
    }, { passive: true });

    btn.addEventListener('touchmove', (e) => {
      if (!dragBtn) { clearTimeout(longPressTimer); return; }
      e.preventDefault();
      const touch = e.touches[0];
      const x = touch.clientX;
      const btns = getNavBtns();
      btns.forEach(b => b.classList.remove('nav-drag-over'));
      for (const b of btns) {
        if (b === dragBtn) continue;
        const r = b.getBoundingClientRect();
        if (x < r.left + r.width / 2) {
          b.classList.add('nav-drag-over');
          break;
        }
      }
    }, { passive: false });

    btn.addEventListener('touchend', () => {
      clearTimeout(longPressTimer);
      if (!dragBtn) return;
      const btns = getNavBtns();
      const target = btns.find(b => b.classList.contains('nav-drag-over'));
      btns.forEach(b => b.classList.remove('nav-drag-over'));
      dragBtn.classList.remove('nav-dragging');
      nav.style.overflowX = '';
      if (target) {
        nav.insertBefore(dragBtn, target);
        saveNavOrder();
      }
      dragBtn = null;
    });

    btn.addEventListener('touchcancel', () => {
      clearTimeout(longPressTimer);
      if (dragBtn) {
        dragBtn.classList.remove('nav-dragging');
        nav.style.overflowX = '';
      }
      getNavBtns().forEach(b => b.classList.remove('nav-drag-over'));
      dragBtn = null;
    });

    // Mouse: mousedown to start drag
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragBtn = btn;
      btn.classList.add('nav-dragging');
      const onMove = (ev) => {
        const x = ev.clientX;
        const btns = getNavBtns();
        btns.forEach(b => b.classList.remove('nav-drag-over'));
        for (const b of btns) {
          if (b === dragBtn) continue;
          const r = b.getBoundingClientRect();
          if (x < r.left + r.width / 2) {
            b.classList.add('nav-drag-over');
            break;
          }
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const btns = getNavBtns();
        const target = btns.find(b => b.classList.contains('nav-drag-over'));
        btns.forEach(b => b.classList.remove('nav-drag-over'));
        dragBtn.classList.remove('nav-dragging');
        if (target) {
          nav.insertBefore(dragBtn, target);
          saveNavOrder();
        }
        dragBtn = null;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

function setupNavActive() {
  const btns = document.querySelectorAll('.nav-btn');
  const secs = ['sec-wx','sec-stw','sec-sus','sec-fx','sec-ntw','sec-nww'].map(id => document.getElementById(id));
  if (!secs[0]) return;
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const id = e.target.id;
        btns.forEach(b => b.classList.toggle('active', b.getAttribute('data-target') === id));
      }
    });
  }, { rootMargin: '-40% 0px -50% 0px' });
  secs.forEach(s => s && obs.observe(s));
}

function aqiClass(aqi) {
  if (aqi == null) return '';
  if (aqi <= 50) return 'aq-1';
  if (aqi <= 100) return 'aq-2';
  if (aqi <= 150) return 'aq-3';
  if (aqi <= 200) return 'aq-4';
  if (aqi <= 300) return 'aq-5';
  return 'aq-6';
}
function pm25Class(pm) {
  if (pm == null) return '';
  if (pm <= 12) return 'aq-1';
  if (pm <= 35) return 'aq-2';
  if (pm <= 55) return 'aq-3';
  if (pm <= 150) return 'aq-4';
  if (pm <= 250) return 'aq-5';
  return 'aq-6';
}
function renderWx(w) {
  const fmtT = v => (v == null || isNaN(v)) ? '—' : Math.round(v) + '°';
  const fmtN = v => (v == null || isNaN(v)) ? '—' : v;
  const forecast = (w.forecast || []).slice(0, 7).map(f => \`
    <div class="wx-day">
      <div class="d">\${f.day || '—'}</div>
      <div class="i">\${wxEmoji(f.code)}</div>
      <div class="t">\${fmtT(f.tmax)} / \${fmtT(f.tmin)}</div>
    </div>
  \`).join('');
  const windArrow = (w.windDir != null)
    ? \`<span style="display:inline-block;transform:rotate(\${(w.windDir + 180) % 360}deg);font-size:1.1em;line-height:1;color:var(--accent)">↑</span>\`
    : '';
  const windDirLabel = (w.windDir != null) ? \` \${w.windDir}°\` : '';
  const expanded = isWxExpanded(w.name) ? 'expanded' : '';
  const safeName = String(w.name || '').replace(/'/g, "\\\\'");
  const aqiHtml = (w.aqi != null)
    ? \`<span onclick="event.stopPropagation();showAqiLegend()" style="cursor:pointer">🌫️ AQI <b class="\${aqiClass(w.aqi)}">\${w.aqi}</b></span>\`
    : '';
  const pm25Html = (w.pm25 != null)
    ? \`<span onclick="event.stopPropagation();showAqiLegend()" style="cursor:pointer">PM2.5 <b class="\${pm25Class(w.pm25)}">\${w.pm25}</b></span>\`
    : '';
  return \`
    <div class="wx-loc \${expanded}" data-wxname="\${safeName}" data-itemkey="\${safeName}">
      <div class="wx-r1" onclick="toggleWx('\${safeName}')">
        <span class="item-drag" title="拖移" onclick="event.stopPropagation()">≡</span>
        <span class="name">\${w.name || '—'}</span>
        <span class="ic">\${wxEmoji(w.code)}</span>
        <span class="tmp">\${fmtT(w.temp)}</span>
        <span class="fl">體感 \${fmtT(w.feels)}</span>
        <span class="sun">🌅 \${w.sunrise || '—'} · 🌇 \${w.sunset || '—'}</span>
        <span class="tog">▼</span>
      </div>
      <div class="wx-r2">
        <span>💧 \${fmtN(w.humidity)}%</span>
        <span>💨 \${windArrow}\${windDirLabel} \${fmtN(w.wind)} kt</span>
        <span>UV \${fmtN(w.uv)}</span>
        \${aqiHtml}
        \${pm25Html}
      </div>
      <div class="wx-forecast">\${forecast}</div>
    </div>
  \`;
}

function renderStock(code, market, s) {
  const base = market === 'tw' ? 'https://www.cnyes.com/twstock/' : 'https://invest.cnyes.com/usstock/detail/';
  const holdings = getMarketHoldings(market);
  const h = holdings && holdings[code];
  // 展開狀態不再持久化，每次 render 都從收合開始（輸入完會自動收合）
  const expandCls = '';
  if (!s) {
    return \`<div class="row stock-row\${expandCls}" data-itemkey="\${code}" data-market="\${market}" data-code="\${code}" onclick="toggleStockRow(this)">\`
      + '<span class="item-drag" title="拖移" onclick="event.stopPropagation()">≡</span>'
      + \`<div class="row-l"><a class="n" href="\${base}\${code}" target="_blank" onclick="event.stopPropagation()">\${code}</a><div class="c">—</div></div>\`
      + '<div class="row-r flat">—</div>'
      + renderStockHoldingCell(market, code, null, h)
      + renderStockExpand(market, code, h)
      + '</div>';
  }
  const cls = chgClass(s.change);
  return \`
    <div class="row stock-row\${expandCls}" data-itemkey="\${code}" data-market="\${market}" data-code="\${code}" onclick="toggleStockRow(this)">
      <span class="item-drag" title="拖移" onclick="event.stopPropagation()">≡</span>
      <div class="row-l">
        <a class="n" href="\${base}\${code}" target="_blank" onclick="event.stopPropagation()">\${s.name || code}</a>
        <div class="c">\${code}</div>
      </div>
      <div class="row-r">
        <div class="p">\${fmtNum(s.price, 2)}</div>
        <div class="ch \${cls}">\${chgSign(s.change)} \${fmtNum(Math.abs(s.change), 2)} (\${pct(s.changePct)})</div>
      </div>
      \${renderStockHoldingCell(market, code, s, h)}
      \${renderStockExpand(market, code, h)}
    </div>
  \`;
}

function renderStockHoldingCell(market, code, s, h) {
  if (!h || !h.qty) return '';
  const resetBtn = \`<button class="hold-x" onclick="event.stopPropagation();clearHolding('\${market}','\${code}')" title="清除此筆持倉">✕</button>\`;
  const price = s ? Number(s.price) : NaN;
  if (!isFinite(price)) {
    return \`<div class="row-hold-sub">
      <span class="lbl">市值</span> — · <span class="lbl">持倉</span> \${h.qty} \${resetBtn}
    </div>\`;
  }
  const mv = price * h.qty;
  const plAbs = (price - Number(h.cost)) * h.qty;
  const plPct = h.cost > 0 ? ((price - h.cost) / h.cost) * 100 : 0;
  const pcls = chgClass(plAbs);
  const psign = plAbs >= 0 ? '+' : '';
  return \`<div class="row-hold-sub">
    <span class="lbl">市值</span> <b>\${fmtNum(mv, 0)}</b>
    · <span class="lbl">損益</span> <b class="\${pcls}">\${psign}\${fmtNum(plAbs, 0)} (\${psign}\${plPct.toFixed(2)}%)</b>
    \${resetBtn}
  </div>\`;
}

// 股票區塊頂端加總（只有任何持倉時才顯示）
function renderStockSummary(market, codes, stocksMap) {
  const holdings = getMarketHoldings(market);
  let totalMv = 0, totalCost = 0, totalPl = 0;
  let hasAny = false;
  for (const code of codes) {
    const h = holdings[code];
    if (!h || !h.qty) continue;
    const s = stocksMap[code];
    const price = s ? Number(s.price) : NaN;
    if (!isFinite(price)) continue;
    hasAny = true;
    totalMv += price * h.qty;
    totalCost += Number(h.cost) * h.qty;
    totalPl += (price - Number(h.cost)) * h.qty;
  }
  if (!hasAny) return '';
  const pct = totalCost > 0 ? (totalPl / totalCost) * 100 : 0;
  const cls = chgClass(totalPl);
  const sign = totalPl >= 0 ? '+' : '';
  return \`<div class="stock-summary">
    💰 <span class="lbl">總市值</span> <b>\${fmtNum(totalMv, 0)}</b>
    · <span class="lbl">總損益</span> <b class="\${cls}">\${sign}\${fmtNum(totalPl, 0)} (\${sign}\${pct.toFixed(2)}%)</b>
  </div>\`;
}

function renderStockExpand(market, code, h) {
  const qty = h && h.qty != null ? h.qty : '';
  const cost = h && h.cost != null ? h.cost : '';
  return \`<div class="stock-expand" onclick="event.stopPropagation()">
    <div class="se-grid">
      <label>股數<input type="number" step="1" min="0" value="\${qty}" data-field="qty" data-market="\${market}" data-code="\${code}" oninput="onHoldingInput(event)" onblur="onHoldingInputBlur(event)"></label>
      <label>成本<input type="number" step="0.0001" min="0" value="\${cost}" data-field="cost" data-market="\${market}" data-code="\${code}" oninput="onHoldingInput(event)" onblur="onHoldingInputBlur(event)"></label>
    </div>
    <button class="se-clear" onclick="clearHolding('\${market}','\${code}')">清除此筆持倉</button>
  </div>\`;
}

function renderFx(pair, v) {
  const parts = pair.split('/');
  const left = parts[0] || '';
  const right = parts[1] || '';
  const fxInputs = loadSetting('fxInputs', {}) || {};
  const fxDirs = loadSetting('fxDirections', {}) || {};
  const amount = fxInputs[pair] != null ? fxInputs[pair] : '';
  const dir = fxDirs[pair] === 'rtl' ? 'rtl' : 'ltr';  // 預設 left→right
  const rateNum = v && isFinite(Number(v.rate)) ? Number(v.rate) : null;
  // 結果計算，小數位數可在設定裡調（0/2/4，跨裝置同步）
  const fxDec = Number(loadSetting('fxDecimals', 0)) || 0;
  let resultStr = '';
  if (amount !== '' && !isNaN(Number(amount)) && rateNum != null) {
    const a = Number(amount);
    const r = dir === 'ltr' ? (a * rateNum) : (a / rateNum);
    resultStr = r.toLocaleString('en-US', { minimumFractionDigits: fxDec, maximumFractionDigits: fxDec });
  }
  const srcCcy = dir === 'ltr' ? left : right;
  const dstCcy = dir === 'ltr' ? right : left;
  const calcHtml = \`<div class="fx-calc" onclick="event.stopPropagation()">
    <input type="number" step="any" placeholder="金額" value="\${amount}" data-pair="\${pair}" oninput="onFxInput(event)">
    <span class="fx-ccy">\${srcCcy}</span>
    <button class="fx-dir" onclick="flipFxDir('\${pair}')" title="切換方向">⇄</button>
    <span class="fx-ccy">\${dstCcy}</span>
    <span class="fx-result">\${resultStr || '—'}</span>
    <button class="fx-x" onclick="clearFxInput('\${pair}')" title="清除此列">✕</button>
  </div>\`;
  if (!v) {
    return \`<div class="row fx-row" data-itemkey="\${pair}" data-pair="\${pair}"><span class="item-drag" title="拖移" onclick="event.stopPropagation()">≡</span><div class="row-l"><div class="n">\${pair}</div><div class="c">—</div></div><div class="row-r flat">—</div>\${calcHtml}</div>\`;
  }
  const isTwd = pair.endsWith('/TWD');
  const sub = isTwd && v.cashSell != null
    ? ('現金賣出 ' + fmtNum(v.cashSell, 4))
    : (v.change != null ? (pct(v.changePct) + ' (' + (v.change > 0 ? '+' : '') + fmtNum(v.change, 4) + ')') : '即期');
  return \`
    <div class="row fx-row" data-itemkey="\${pair}" data-pair="\${pair}">
      <span class="item-drag" title="拖移" onclick="event.stopPropagation()">≡</span>
      <div class="row-l">
        <div class="n">\${pair}</div>
        <div class="c">\${sub}</div>
      </div>
      <div class="row-r">
        <div class="p">\${fmtNum(v.rate, 4)}</div>
      </div>
      \${calcHtml}
    </div>
  \`;
}

function renderNews(n) {
  return \`
    <div class="news">
      <a href="\${n.url}" target="_blank" rel="noopener">
        <div class="news-t">\${escapeHtml(n.title)}</div>
        <div class="news-meta"><span>\${escapeHtml(n.source || '')}</span><span>\${n.time || ''}</span></div>
      </a>
    </div>
  \`;
}
const PAYWALL_SOURCES = ['NYT', 'WSJ', 'The New York Times', 'Wall Street Journal'];
function renderNewsWorld(n) {
  const encodedUrl = encodeURIComponent(n.url || '');
  const isPaywall = PAYWALL_SOURCES.some(s => (n.source || '').includes(s));
  const readerBtn = isPaywall
    ? '<span style="font-size:.7em;color:var(--muted)">🔒 此來源無法翻譯</span>'
    : '<button class="news-reader-btn" onclick="event.preventDefault();event.stopPropagation();openReader(\\'' + encodedUrl + '\\')">📖 雙語閱讀</button>';
  return \`
    <div class="news">
      <a href="\${n.url}" target="_blank" rel="noopener">
        <div class="news-t">\${escapeHtml(n.title_zh || n.title)}</div>
        \${n.title_zh && n.title ? '<div class="news-en">' + escapeHtml(n.title) + '</div>' : ''}
        <div class="news-meta"><span>\${escapeHtml(n.source || '')}</span><span>\${n.time || ''}</span></div>
      </a>
      <div class="news-actions">\${readerBtn}</div>
    </div>
  \`;
}
function emptyRow() { return '<div class="row flat" style="justify-content:center;color:var(--muted)">（尚無資料）</div>'; }
function emptyNews() { return '<div class="news" style="color:var(--muted);font-size:.82em">（尚無資料）</div>'; }
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 離線快取：抓成功存一份到 localStorage（按 user 分鑰），失敗（離線）就讀這份顯示，跟 Pilot Log 一樣。
function _morningCacheKey() { try { return 'morning_last_report_' + (getUid() || ''); } catch (e) { return 'morning_last_report_'; } }
function saveReportCache(data) {
  try { localStorage.setItem(_morningCacheKey(), JSON.stringify({ data: data, savedAt: Date.now() })); } catch (e) {}
}
function loadReportCache() {
  try { var raw = localStorage.getItem(_morningCacheKey()); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function showOfflineBanner(savedAt) {
  var when = '';
  try { var d = new Date(savedAt); when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); } catch (e) {}
  var html = '<div class="offline-banner">📡 OFFLINE — 顯示上次快取的資料' + (when ? '（' + when + '）' : '') + ' · Showing last cached data</div>';
  var root = document.getElementById('root');
  if (root) root.insertAdjacentHTML('afterbegin', html);
}

// 統一渲染：任何 renderReport 都包這層 try，渲染出錯就顯示明確錯誤、絕不留空白頁（含舊格式快取，codex P2）。成功回 true。
function safeRender(data) {
  try { renderReport(data); return true; }
  catch (e) {
    document.getElementById('root').innerHTML = '<div class="error">顯示失敗 Render error：' + (e && e.message || e) + '</div>';
    return false;
  }
}

async function loadAndRender(date) {
  document.getElementById('root').innerHTML = '<div class="loading">載入中 Loading…</div>';
  let data;
  try {
    data = await fetchReport(date);
  } catch (e) {
    // 只「抓資料」失敗走這裡。只在真的離線/連不到、且看今日(預設)時才退回快取；HTTP 4xx/5xx（伺服器有回應，如今日報告還沒產生）照實顯示、不遮蓋（codex P2）。
    // 網路層失敗：navigator.onLine=false，或 fetch reject（Safari 離線丟 TypeError「Load failed」）。HTTP 錯誤是 throw new Error('HTTP ..')，name='Error'。
    const networkDown = !navigator.onLine || (e && e.name === 'TypeError');
    const cached = (!date && networkDown) ? loadReportCache() : null;
    if (cached && cached.data) {
      if (safeRender(cached.data)) showOfflineBanner(cached.savedAt);   // 舊格式快取渲染失敗 → 顯示錯誤、不掛橫條、不空白
    } else {
      document.getElementById('root').innerHTML = '<div class="error">載入失敗：' + e.message + '<br><br>今日資料尚未產生，請稍後再試。</div>';
    }
    return;
  }
  // 抓成功 → 渲染（出錯照實報，不被當離線遮掉）；渲染成功且看今日才存快取（歷史日不覆蓋，codex P1）。
  if (safeRender(data) && !date) saveReportCache(data);
}

// About modal
function showAbout() { document.getElementById('about-wrap').classList.add('show'); }
function hideAbout() { document.getElementById('about-wrap').classList.remove('show'); }
window.showAbout = showAbout;
window.hideAbout = hideAbout;

// Settings modal (per-section)
let _wxSelectedIds = [];
let _twSelected = [];
let _usSelected = [];
let _fxSelected = [];

const SET_TITLES = {
  wx: '🌤️ 天氣地點設定',
  tw: '📈 台股設定',
  us: '🇺🇸 美股設定',
  fx: '💱 匯率設定',
  all: '⚙️ 設定 Settings',
};

function showSet(section) {
  section = section || 'all';
  // Update current uid display
  const uidEl = document.getElementById('set-current-uid');
  if (uidEl) uidEl.textContent = getUid() || '—';
  // Load current values into modal
  _wxSelectedIds = [...loadSetting('wxPresets', DEFAULTS.wxPresets)];
  const customWx = loadSetting('wxCustom', DEFAULTS.wxCustom);
  document.getElementById('set-wx-custom').value = customWx.map(w => \`\${w.name},\${w.lat},\${w.lon}\`).join('\\n');

  const twList = loadSetting('tw', DEFAULTS.tw);
  _twSelected = twList.filter(c => TW_PRESET_SET.has(c));
  const twCustom = twList.filter(c => !TW_PRESET_SET.has(c));
  document.getElementById('set-tw-custom').value = twCustom.join(',');

  const usList = loadSetting('us', DEFAULTS.us);
  _usSelected = usList.filter(c => US_PRESET_SET.has(c));
  const usCustom = usList.filter(c => !US_PRESET_SET.has(c));
  document.getElementById('set-us-custom').value = usCustom.join(',');

  const fxList = loadSetting('fx', DEFAULTS.fx);
  _fxSelected = fxList.filter(c => FX_PRESET_SET.has(c));
  const fxCustom = fxList.filter(c => !FX_PRESET_SET.has(c));
  document.getElementById('set-fx-custom').value = fxCustom.join(',');
  const fxDecSel = document.getElementById('set-fx-decimals');
  if (fxDecSel) fxDecSel.value = String(Number(loadSetting('fxDecimals', 0)) || 0);

  // Render preset grids
  renderWxPresets();
  renderTwPresets();
  renderUsPresets();
  renderFxPresets();

  // Show/hide sections based on requested section
  document.querySelectorAll('.set-sec').forEach(el => {
    const s = el.getAttribute('data-section');
    el.style.display = (section === 'all' || s === section) ? '' : 'none';
  });
  document.getElementById('set-title').textContent = SET_TITLES[section] || SET_TITLES.all;

  document.getElementById('set-wrap').classList.add('show');
}
window.showSet = showSet;

function hideSet() { document.getElementById('set-wrap').classList.remove('show'); }

// ── Weather ──
function countWxCustomValid() {
  const txt = document.getElementById('set-wx-custom').value || '';
  return txt.trim().split(/\\n/).map(l => l.trim()).filter(Boolean).filter(line => {
    const p = line.split(',');
    return p.length >= 3 && p[0].trim() && !isNaN(parseFloat(p[1])) && !isNaN(parseFloat(p[2]));
  }).length;
}
// 收合狀態：開 modal 時依勾選情況決定（有勾選的展開，沒勾的收合），session 期間記憶使用者手動切換
const _catExpanded = {};
function catKey(section, cat) { return section + ':' + cat; }
function toggleCat(section, cat) {
  const k = catKey(section, cat);
  _catExpanded[k] = !_catExpanded[k];
  return _catExpanded[k];
}

function renderWxPresets() {
  const wrap = document.getElementById('wx-presets');
  let html = '';

  // Helper: 渲染 checkbox grid 內容
  function renderItems(items) {
    let h = '';
    for (const p of items) {
      const [id, name] = p;
      const checked = _wxSelectedIds.includes(id);
      h += '<label class="wx-chk ' + (checked ? 'checked' : '') + '" data-id="' + id + '">'
        + '<input type="checkbox"' + (checked ? ' checked' : '') + '>'
        + '<span>' + name + '</span></label>';
    }
    return h;
  }

  // Helper: 渲染一個 category（縣市層）
  function renderCat(cat, displayName) {
    const items = WX_PRESETS[cat] || [];
    if (items.length === 0) return '';
    const sel = items.filter(p => _wxSelectedIds.includes(p[0])).length;
    const k = catKey('wx', cat);
    if (_catExpanded[k] === undefined) _catExpanded[k] = sel > 0;
    const expCls = _catExpanded[k] ? ' expanded' : '';
    return '<div class="wx-cat' + expCls + '" data-cat="' + cat + '">'
      + '<div class="wx-cat-title"><span>' + displayName + '</span>'
      + '<span><span class="cnt">' + sel + '/' + items.length + '</span> <span class="arrow">▶</span></span>'
      + '</div><div class="wx-chk-grid">' + renderItems(items) + '</div></div>';
  }

  // Helper: 渲染一個 region（區域層）
  function renderRegion(region) {
    const catNames = WX_REGIONS[region];
    if (!catNames) return '';
    const isSingle = catNames.length === 1;
    let regionSel = 0, regionTotal = 0;
    catNames.forEach(cn => { const items = WX_PRESETS[cn] || []; regionTotal += items.length; regionSel += items.filter(p => _wxSelectedIds.includes(p[0])).length; });
    if (isSingle) {
      // 只有一個 sub-category → flat，用 region 名稱
      return renderCat(catNames[0], region);
    }
    const rk = catKey('wx-r', region);
    if (_catExpanded[rk] === undefined) _catExpanded[rk] = regionSel > 0;
    const rExpCls = _catExpanded[rk] ? ' expanded' : '';
    let h = '<div class="wx-region' + rExpCls + '" data-region="' + region + '">'
      + '<div class="wx-region-title"><span>' + region + '</span>'
      + '<span><span class="cnt">' + regionSel + '/' + regionTotal + '</span> <span class="arrow">▶</span></span>'
      + '</div><div class="wx-region-body">';
    for (const cat of catNames) {
      const shortName = cat.includes(' ') ? cat.substring(cat.indexOf(' ') + 1) : cat;
      h += renderCat(cat, shortName);
    }
    h += '</div></div>';
    return h;
  }

  // ── 台灣 super-region ──
  const twRegions = WX_TAIWAN_REGIONS;
  let twSel = 0, twTotal = 0;
  twRegions.forEach(r => {
    (WX_REGIONS[r] || []).forEach(cn => { const items = WX_PRESETS[cn] || []; twTotal += items.length; twSel += items.filter(p => _wxSelectedIds.includes(p[0])).length; });
  });
  const twk = catKey('wx-s', 'taiwan');
  if (_catExpanded[twk] === undefined) _catExpanded[twk] = twSel > 0;
  const twExpCls = _catExpanded[twk] ? ' expanded' : '';
  html += '<div class="wx-super' + twExpCls + '" data-super="taiwan">'
    + '<div class="wx-super-title"><span>🇹🇼 台灣</span>'
    + '<span><span class="cnt">' + twSel + '/' + twTotal + '</span> <span class="arrow">▶</span></span>'
    + '</div><div class="wx-super-body">';
  for (const r of twRegions) html += renderRegion(r);
  html += '</div></div>';

  // ── 其他 regions（國際城市 + 機場，不在 WX_TAIWAN_REGIONS 裡的） ──
  const twSet = new Set(twRegions);
  for (const region of Object.keys(WX_REGIONS)) {
    if (twSet.has(region)) continue;
    html += renderRegion(region);
  }

  wrap.innerHTML = html;
  // Super-region title click
  wrap.querySelectorAll('.wx-super-title').forEach(el => {
    el.addEventListener('click', () => {
      const s = el.parentElement.getAttribute('data-super');
      toggleCat('wx-s', s);
      el.parentElement.classList.toggle('expanded');
    });
  });
  // Region title click
  wrap.querySelectorAll('.wx-region-title').forEach(el => {
    el.addEventListener('click', () => {
      const region = el.parentElement.getAttribute('data-region');
      toggleCat('wx-r', region);
      el.parentElement.classList.toggle('expanded');
    });
  });
  // Category title click
  wrap.querySelectorAll('.wx-cat-title').forEach(el => {
    el.addEventListener('click', () => {
      const cat = el.parentElement.getAttribute('data-cat');
      toggleCat('wx', cat);
      el.parentElement.classList.toggle('expanded');
    });
  });
  // Checkbox click
  wrap.querySelectorAll('.wx-chk').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = el.getAttribute('data-id');
      const idx = _wxSelectedIds.indexOf(id);
      if (idx >= 0) {
        _wxSelectedIds.splice(idx, 1);
      } else {
        _wxSelectedIds.push(id);
      }
      renderWxPresets();
      updateWxCounter();
    });
  });
  updateWxCounter();
}
function updateWxCounter() {
  const total = _wxSelectedIds.length + countWxCustomValid();
  const el = document.getElementById('wx-counter');
  el.textContent = '已選 ' + total;
  el.classList.toggle('full', total >= WX_SOFT_WARN);
  // 動態 soft warning（在 counter 下方）
  let warn = document.getElementById('wx-soft-warn');
  if (!warn) {
    warn = document.createElement('div');
    warn.id = 'wx-soft-warn';
    warn.style.cssText = 'font-size:.72em;color:#f59e0b;margin:4px 0 8px;line-height:1.4;display:none';
    el.parentNode.insertBefore(warn, el.nextSibling);
  }
  if (total >= WX_SOFT_WARN) {
    warn.style.display = 'block';
    warn.textContent = '⚠️ 已選 ' + total + ' 個地點，載入時間會變長（建議 < ' + WX_SOFT_WARN + '）';
  } else {
    warn.style.display = 'none';
  }
}

// ── Stocks / FX shared helpers ──
function parseCsvList(txt) {
  return (txt || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}
function countCsv(id) {
  return parseCsvList(document.getElementById(id).value).length;
}

function renderTwPresets() {
  const wrap = document.getElementById('tw-presets');
  let html = '';
  for (const cat of Object.keys(TW_PRESETS)) {
    const items = TW_PRESETS[cat];
    const sel = items.filter(p => _twSelected.includes(p[0])).length;
    const k = catKey('tw', cat);
    if (_catExpanded[k] === undefined) _catExpanded[k] = sel > 0;
    const expCls = _catExpanded[k] ? ' expanded' : '';
    html += '<div class="wx-cat' + expCls + '" data-cat="' + cat + '">'
      + '<div class="wx-cat-title"><span>' + cat + '</span>'
      + '<span><span class="cnt">' + sel + ' / ' + items.length + '</span> <span class="arrow">▶</span></span>'
      + '</div><div class="wx-chk-grid">';
    for (const p of items) {
      const code = p[0], name = p[1];
      const checked = _twSelected.includes(code);
      html += '<label class="wx-chk ' + (checked ? 'checked' : '') + '" data-code="' + code + '">'
        + '<input type="checkbox"' + (checked ? ' checked' : '') + '>'
        + '<span>' + code + ' ' + name + '</span></label>';
    }
    html += '</div></div>';
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.wx-cat-title').forEach(el => {
    el.addEventListener('click', () => {
      const cat = el.parentElement.getAttribute('data-cat');
      toggleCat('tw', cat);
      el.parentElement.classList.toggle('expanded');
    });
  });
  wrap.querySelectorAll('.wx-chk').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = el.getAttribute('data-code');
      const idx = _twSelected.indexOf(code);
      if (idx >= 0) {
        _twSelected.splice(idx, 1);
      } else {
        _twSelected.push(code);
      }
      renderTwPresets();
      updateTwCounter();
    });
  });
  updateTwCounter();
}
function updateTwCounter() {
  const total = _twSelected.length + countCsv('set-tw-custom');
  const el = document.getElementById('tw-counter');
  el.textContent = '已選 ' + total;
  el.classList.toggle('full', total >= TW_SOFT_WARN);
  let warn = document.getElementById('tw-soft-warn');
  if (!warn) {
    warn = document.createElement('div');
    warn.id = 'tw-soft-warn';
    warn.style.cssText = 'font-size:.72em;color:#f59e0b;margin:4px 0 8px;line-height:1.4;display:none';
    el.parentNode.insertBefore(warn, el.nextSibling);
  }
  if (total >= TW_SOFT_WARN) {
    warn.style.display = 'block';
    warn.textContent = '⚠️ 已選 ' + total + ' 支台股，載入時間會變長（建議 < ' + TW_SOFT_WARN + '）';
  } else {
    warn.style.display = 'none';
  }
  renderHoldingsTable('tw');
}

function renderUsPresets() {
  const wrap = document.getElementById('us-presets');
  let html = '';
  for (const cat of Object.keys(US_PRESETS)) {
    const items = US_PRESETS[cat];
    const sel = items.filter(p => _usSelected.includes(p[0])).length;
    const k = catKey('us', cat);
    if (_catExpanded[k] === undefined) _catExpanded[k] = sel > 0;
    const expCls = _catExpanded[k] ? ' expanded' : '';
    html += '<div class="wx-cat' + expCls + '" data-cat="' + cat + '">'
      + '<div class="wx-cat-title"><span>' + cat + '</span>'
      + '<span><span class="cnt">' + sel + ' / ' + items.length + '</span> <span class="arrow">▶</span></span>'
      + '</div><div class="wx-chk-grid">';
    for (const p of items) {
      const code = p[0], name = p[1];
      const checked = _usSelected.includes(code);
      html += '<label class="wx-chk ' + (checked ? 'checked' : '') + '" data-code="' + code + '">'
        + '<input type="checkbox"' + (checked ? ' checked' : '') + '>'
        + '<span>' + code + ' ' + name + '</span></label>';
    }
    html += '</div></div>';
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.wx-cat-title').forEach(el => {
    el.addEventListener('click', () => {
      const cat = el.parentElement.getAttribute('data-cat');
      toggleCat('us', cat);
      el.parentElement.classList.toggle('expanded');
    });
  });
  wrap.querySelectorAll('.wx-chk').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = el.getAttribute('data-code');
      const idx = _usSelected.indexOf(code);
      if (idx >= 0) {
        _usSelected.splice(idx, 1);
      } else {
        _usSelected.push(code);
      }
      renderUsPresets();
      updateUsCounter();
    });
  });
  updateUsCounter();
}
function updateUsCounter() {
  const total = _usSelected.length + countCsv('set-us-custom');
  const el = document.getElementById('us-counter');
  el.textContent = '已選 ' + total;
  el.classList.toggle('full', total >= US_SOFT_WARN);
  let warn = document.getElementById('us-soft-warn');
  if (!warn) {
    warn = document.createElement('div');
    warn.id = 'us-soft-warn';
    warn.style.cssText = 'font-size:.72em;color:#f59e0b;margin:4px 0 8px;line-height:1.4;display:none';
    el.parentNode.insertBefore(warn, el.nextSibling);
  }
  if (total >= US_SOFT_WARN) {
    warn.style.display = 'block';
    warn.textContent = '⚠️ 已選 ' + total + ' 支美股，載入時間會變長（建議 < ' + US_SOFT_WARN + '）';
  } else {
    warn.style.display = 'none';
  }
  renderHoldingsTable('us');
}

function renderFxPresets() {
  const wrap = document.getElementById('fx-presets');
  let html = '';
  for (const cat of Object.keys(FX_PRESETS)) {
    const items = FX_PRESETS[cat];
    const sel = items.filter(p => _fxSelected.includes(p)).length;
    const k = catKey('fx', cat);
    if (_catExpanded[k] === undefined) _catExpanded[k] = sel > 0;
    const expCls = _catExpanded[k] ? ' expanded' : '';
    html += '<div class="wx-cat' + expCls + '" data-cat="' + cat + '">'
      + '<div class="wx-cat-title"><span>' + cat + '</span>'
      + '<span><span class="cnt">' + sel + ' / ' + items.length + '</span> <span class="arrow">▶</span></span>'
      + '</div><div class="wx-chk-grid">';
    for (const pair of items) {
      const checked = _fxSelected.includes(pair);
      html += '<label class="wx-chk ' + (checked ? 'checked' : '') + '" data-code="' + pair + '">'
        + '<input type="checkbox"' + (checked ? ' checked' : '') + '>'
        + '<span>' + pair + '</span></label>';
    }
    html += '</div></div>';
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.wx-cat-title').forEach(el => {
    el.addEventListener('click', () => {
      const cat = el.parentElement.getAttribute('data-cat');
      toggleCat('fx', cat);
      el.parentElement.classList.toggle('expanded');
    });
  });
  wrap.querySelectorAll('.wx-chk').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pair = el.getAttribute('data-code');
      const idx = _fxSelected.indexOf(pair);
      if (idx >= 0) {
        _fxSelected.splice(idx, 1);
      } else {
        _fxSelected.push(pair);
      }
      renderFxPresets();
      updateFxCounter();
    });
  });
  updateFxCounter();
}
function updateFxCounter() {
  const total = _fxSelected.length + countCsv('set-fx-custom');
  const el = document.getElementById('fx-counter');
  el.textContent = '已選 ' + total;
  el.classList.toggle('full', total >= FX_SOFT_WARN);
  let warn = document.getElementById('fx-soft-warn');
  if (!warn) {
    warn = document.createElement('div');
    warn.id = 'fx-soft-warn';
    warn.style.cssText = 'font-size:.72em;color:#f59e0b;margin:4px 0 8px;line-height:1.4;display:none';
    el.parentNode.insertBefore(warn, el.nextSibling);
  }
  if (total >= FX_SOFT_WARN) {
    warn.style.display = 'block';
    warn.textContent = '⚠️ 已選 ' + total + ' 個匯率，載入時間會變長（建議 < ' + FX_SOFT_WARN + '）';
  } else {
    warn.style.display = 'none';
  }
}

// ── 設定 modal：持倉表格 ────────────────────────────────────────
function getHoldingSelectedCodes(section) {
  // 用當前 modal 裡的選擇 + 自訂 csv（尚未 save，但 UI 同步）
  const selected = section === 'tw' ? _twSelected : _usSelected;
  const customEl = document.getElementById('set-' + section + '-custom');
  const customCodes = customEl ? parseCsvList(customEl.value) : [];
  // 去重（preset 與 custom 可能 overlap）
  const seen = new Set();
  const out = [];
  for (const c of [...selected, ...customCodes]) {
    if (!seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out;
}
function renderHoldingsTable(section) {
  const wrap = document.getElementById(section + '-holdings-table');
  if (!wrap) return;
  const codes = getHoldingSelectedCodes(section);
  const key = section === 'tw' ? 'twHoldings' : 'usHoldings';
  const map = loadSetting(key, {}) || {};
  if (codes.length === 0) {
    wrap.innerHTML = '<div class="ht-empty">（尚未選擇任何股票）</div>';
    return;
  }
  // 用 preset 查名稱
  const presetMap = section === 'tw' ? TW_PRESETS : US_PRESETS;
  const nameByCode = {};
  Object.values(presetMap).forEach(arr => arr.forEach(p => { nameByCode[p[0]] = p[1]; }));
  let html = '<div class="ht-row ht-head"><div>代號 / 名稱</div><div style="text-align:right">股數</div><div style="text-align:right">成本</div><div></div></div>';
  for (const code of codes) {
    const h = map[code] || { qty: '', cost: '' };
    const label = (nameByCode[code] ? (code + ' ' + nameByCode[code]) : code).replace(/"/g, '&quot;');
    html += '<div class="ht-row" data-code="' + code + '">'
      + '<div class="ht-code" title="' + label + '">' + label + '</div>'
      + '<input type="number" step="1" min="0" value="' + (h.qty === 0 ? 0 : (h.qty || '')) + '" data-field="qty" data-market="' + section + '" data-code="' + code + '" oninput="onHoldingTableInput(event)">'
      + '<input type="number" step="0.0001" min="0" value="' + (h.cost === 0 ? 0 : (h.cost || '')) + '" data-field="cost" data-market="' + section + '" data-code="' + code + '" oninput="onHoldingTableInput(event)">'
      + '<button class="ht-x" onclick="clearHoldingTableRow(\\'' + section + '\\',\\'' + code + '\\')" title="清除此筆">✕</button>'
      + '</div>';
  }
  wrap.innerHTML = html;
}
let _holdingTableTimer = null;
function onHoldingTableInput(e) {
  const inp = e.target;
  const market = inp.getAttribute('data-market');
  const code = inp.getAttribute('data-code');
  const field = inp.getAttribute('data-field');
  const key = market === 'tw' ? 'twHoldings' : 'usHoldings';
  const map = loadSetting(key, {}) || {};
  const cur = map[code] || { qty: 0, cost: 0 };
  const val = Number(inp.value);
  if (isNaN(val)) return;
  cur[field] = val;
  map[code] = cur;
  saveSetting(key, map);
  if (_holdingTableTimer) clearTimeout(_holdingTableTimer);
  _holdingTableTimer = setTimeout(() => {
    const body = {};
    body[market === 'tw' ? 'tw_holdings' : 'us_holdings'] = loadSetting(key, {});
    postPrefsPartial(body);
  }, 500);
}
window.onHoldingTableInput = onHoldingTableInput;
function clearHoldingTableRow(market, code) {
  const key = market === 'tw' ? 'twHoldings' : 'usHoldings';
  const map = loadSetting(key, {}) || {};
  delete map[code];
  saveSetting(key, map);
  renderHoldingsTable(market);
  const body = {};
  body[market === 'tw' ? 'tw_holdings' : 'us_holdings'] = map;
  postPrefsPartial(body);
}
window.clearHoldingTableRow = clearHoldingTableRow;

async function saveSettings() {
  // Weather
  saveSetting('wxPresets', _wxSelectedIds);
  const wxLines = document.getElementById('set-wx-custom').value.trim().split(/\\n/).map(l => l.trim()).filter(Boolean);
  const wxCustom = wxLines.map(line => {
    const [name, lat, lon] = line.split(',').map(s => s.trim());
    return { name, lat: parseFloat(lat), lon: parseFloat(lon) };
  }).filter(w => w.name && !isNaN(w.lat) && !isNaN(w.lon));
  saveSetting('wxCustom', wxCustom);
  // Stocks / FX: merge preset + custom into single array
  const twCustom = parseCsvList(document.getElementById('set-tw-custom').value);
  const usCustom = parseCsvList(document.getElementById('set-us-custom').value);
  const fxCustom = parseCsvList(document.getElementById('set-fx-custom').value);
  const twAll = [..._twSelected, ...twCustom];
  const usAll = [..._usSelected, ...usCustom];
  const fxAll = [..._fxSelected, ...fxCustom];
  if (twAll.length > 0) saveSetting('tw', twAll); else localStorage.removeItem(LS.tw);
  if (usAll.length > 0) saveSetting('us', usAll); else localStorage.removeItem(LS.us);
  if (fxAll.length > 0) saveSetting('fx', fxAll); else localStorage.removeItem(LS.fx);
  // 上傳 prefs 到伺服器（組成 per-user prefs 格式）
  const wxAllLocs = [];
  for (const id of _wxSelectedIds) {
    if (WX_PRESET_MAP[id]) wxAllLocs.push({ name: WX_PRESET_MAP[id].name, lat: WX_PRESET_MAP[id].lat, lon: WX_PRESET_MAP[id].lon });
  }
  for (const c of wxCustom) wxAllLocs.push(c);
  const curSecOrder = loadSetting('secOrder', null);
  const curNewsCatOrder = loadSetting('newsCatOrder', null);
  const serverPrefs = { wx: wxAllLocs, tw: twAll, us: usAll, fx: fxAll, secOrder: curSecOrder, newsCatOrder: curNewsCatOrder };
  try {
    await apiFetch('/api/morning-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverPrefs),
    });
  } catch (e) { console.warn('save prefs failed', e); }
  hideSet();
  // 儲存完後觸發重建（只重建自己的）
  await smartRefresh();
}
window.saveSettings = saveSettings;
window.hideSet = hideSet;

// ── Nickname onboarding ──────────────────────────────────────────
function showNickModal() {
  const wrap = document.getElementById('nick-wrap');
  wrap.style.display = 'flex';
  wrap.classList.add('show');
  const input = document.getElementById('nick-input');
  const hint = document.getElementById('nick-hint');
  hint.textContent = '';
  input.value = '';
  setTimeout(() => input.focus(), 100);
}
function hideNickModal() {
  const wrap = document.getElementById('nick-wrap');
  wrap.style.display = 'none';
  wrap.classList.remove('show');
}
async function submitNickname() {
  const input = document.getElementById('nick-input');
  const hint = document.getElementById('nick-hint');
  const val = (input.value || '').trim();
  if (val.length < 2) { hint.textContent = '至少 2 個字'; return; }
  if (val.length > 20) { hint.textContent = '最多 20 個字'; return; }
  if (val.startsWith('__')) { hint.textContent = '不能用 __ 開頭'; return; }
  setUid(val);
  hint.textContent = '初始化中…';
  // 先取伺服器上有沒有這個使用者的 prefs（重裝找回用）
  let serverPrefs = null;
  try {
    const r = await apiFetch('/api/morning-prefs');
    if (r.ok) serverPrefs = await r.json();
  } catch (e) {}
  if (serverPrefs) {
    // 把伺服器上的 prefs 同步回 localStorage
    if (serverPrefs.wx) {
      // 把 server 的 wx 拆成 presets 和 custom
      const presets = [];
      const custom = [];
      const presetByName = {};
      Object.values(WX_PRESETS).forEach(arr => arr.forEach(p => { presetByName[p[1]] = p[0]; }));
      for (const w of serverPrefs.wx) {
        if (presetByName[w.name]) presets.push(presetByName[w.name]);
        else custom.push(w);
      }
      saveSetting('wxPresets', presets);
      saveSetting('wxCustom', custom);
    }
    if (serverPrefs.tw) saveSetting('tw', serverPrefs.tw);
    if (serverPrefs.us) saveSetting('us', serverPrefs.us);
    if (serverPrefs.fx) saveSetting('fx', serverPrefs.fx);
    hideNickModal();
    await loadAndRender();
  } else {
    // 新使用者：用當前 localStorage 狀態（含預設）build 一份 prefs 送上去並觸發首次 build
    const wxPresetIds = loadSetting('wxPresets', DEFAULTS.wxPresets);
    const wxCustom = loadSetting('wxCustom', DEFAULTS.wxCustom);
    const tw = loadSetting('tw', DEFAULTS.tw);
    const us = loadSetting('us', DEFAULTS.us);
    const fx = loadSetting('fx', DEFAULTS.fx);
    const wxLocs = [];
    for (const id of wxPresetIds) {
      if (WX_PRESET_MAP[id]) wxLocs.push({ name: WX_PRESET_MAP[id].name, lat: WX_PRESET_MAP[id].lat, lon: WX_PRESET_MAP[id].lon });
    }
    for (const c of wxCustom) wxLocs.push(c);
    const initPrefs = { wx: wxLocs, tw, us, fx };
    try {
      // 用 refresh endpoint 送初始 prefs，伺服器會存下並立刻 build 一份
      await apiFetch('/api/morning-report/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initPrefs),
      });
    } catch (e) { console.warn('first build failed', e); }
    hideNickModal();
    await loadAndRender();
  }
}
function switchUser() {
  if (!confirm('要清除目前暱稱嗎？\\n你還可以用同名重新輸入來找回歷史。')) return;
  try { localStorage.removeItem(LS.uid); } catch (e) {}
  hideSet();
  showNickModal();
}
window.switchUser = switchUser;

// Date picker (calendar view)
let _availableDates = new Set();
let _currentDisplayedDate = null;  // 目前顯示的那份 report 的日期
let _calMonth = null; // { year, month (0-indexed) }

async function showDate() {
  document.getElementById('date-wrap').classList.add('show');
  try {
    const r = await apiFetch('/api/morning-report/dates');
    const j = await r.json();
    _availableDates = new Set(j.dates || []);
    // 初始月份：若有 currentDisplayedDate 用它，否則用最新一筆、再否則今天
    let base;
    if (_currentDisplayedDate) base = new Date(_currentDisplayedDate + 'T00:00:00');
    else if (j.dates && j.dates[0]) base = new Date(j.dates[0] + 'T00:00:00');
    else base = new Date();
    _calMonth = { year: base.getFullYear(), month: base.getMonth() };
    renderCalendar();
  } catch (e) {
    document.getElementById('cal-grid').innerHTML = '<div class="error">' + e.message + '</div>';
  }
}
function hideDate() { document.getElementById('date-wrap').classList.remove('show'); }
function pickDate(d) { hideDate(); loadAndRender(d); }
window.pickDate = pickDate;
window.hideDate = hideDate;

function renderCalendar() {
  if (!_calMonth) return;
  const { year, month } = _calMonth;
  const title = document.getElementById('cal-title');
  title.textContent = year + ' / ' + String(month + 1).padStart(2, '0');

  const grid = document.getElementById('cal-grid');
  const dowNames = ['日','一','二','三','四','五','六'];
  let html = dowNames.map(n => '<div class="cal-dow">' + n + '</div>').join('');

  const firstDay = new Date(year, month, 1).getDay();  // 0 = Sunday
  const lastDate = new Date(year, month + 1, 0).getDate();
  // 今天的日期字串（台北時區由伺服器回傳已有，這裡用本地即可）
  const tz = new Date();
  const todayStr = tz.getFullYear() + '-' + String(tz.getMonth()+1).padStart(2,'0') + '-' + String(tz.getDate()).padStart(2,'0');

  // 前導空格
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';
  for (let d = 1; d <= lastDate; d++) {
    const dateStr = year + '-' + String(month+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    const has = _availableDates.has(dateStr);
    const isToday = dateStr === todayStr;
    const isCurrent = dateStr === _currentDisplayedDate;
    const classes = ['cal-day'];
    if (has) classes.push('has-data');
    else classes.push('no-data');
    if (isToday) classes.push('today');
    if (isCurrent) classes.push('current');
    const onclick = has ? (' onclick="pickDate(\\'' + dateStr + '\\')"') : '';
    html += '<div class="' + classes.join(' ') + '"' + onclick + '>' + d + '</div>';
  }
  grid.innerHTML = html;
}

function calNav(delta) {
  if (!_calMonth) return;
  let y = _calMonth.year;
  let m = _calMonth.month + delta;
  while (m < 0) { m += 12; y--; }
  while (m > 11) { m -= 12; y++; }
  _calMonth = { year: y, month: m };
  renderCalendar();
}

// ── Theme (day/night) — V1.3.19: 三 PWA 共用 localStorage 'crewsync_theme'
function readThemeKey() {
  // Same origin: 也 fallback portfolio_theme (user 若只在另一 PWA 設過要 preserve)
  try {
    return localStorage.getItem('crewsync_theme')
      || localStorage.getItem('morning_theme')
      || localStorage.getItem('portfolio_theme')
      || 'dark';
  } catch { return 'dark'; }
}
function applyTheme() {
  const t = readThemeKey();
  if (t === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
}
// V2.4.xx 直立膠囊：直接設目標模式（浮標純 CSS 顯示現況，不再寫 icon）
function setMorningTheme(mode) {
  try { localStorage.setItem('crewsync_theme', mode === 'light' ? 'light' : 'dark'); } catch {}
  applyTheme();
}
function toggleTheme() {
  setMorningTheme(readThemeKey() === 'light' ? 'dark' : 'light');
}
applyTheme();

// ── Font scale ───────────────────────────────────────────────────
// V1.3.18: 20-step font scale; V1.3.19: shared key 'crewsync_font_scale' 跨 PWA + portfolio fallback
let _fontScale = 0;
try {
  const raw = localStorage.getItem('crewsync_font_scale')
    ?? localStorage.getItem('morning_font_scale')
    ?? localStorage.getItem('portfolio_font_scale');
  const s = parseInt(raw || '0');
  if (!isNaN(s) && s >= -2 && s <= 17) _fontScale = s;
} catch (e) {}
function applyFontScale() {
  // 基準 15px，每級 +/- 1.2px (≈8%)
  const px = 15 * (1 + _fontScale * 0.08);
  document.documentElement.style.fontSize = px + 'px';
}
function bumpFont(dir) {
  _fontScale = Math.max(-2, Math.min(17, _fontScale + dir));
  try { localStorage.setItem('crewsync_font_scale', String(_fontScale)); } catch (e) {}
  applyFontScale();
  setTimeout(updateHdrH, 50);
}
applyFontScale();

// ── Portfolio holdings cache (V1.3.14) ──────────────────────────────────────
// 晨報主畫面 stocks card render 過去用 localStorage 'morning_tw_holdings'
// 抓持倉資料。改成 fetch /api/portfolio/holdings 一次 + populate 這個 cache，
// 4 處 render 程式碼用 getMarketHoldings(market) 拿回相同格式 { qty, cost }。
// localStorage holdings 已 deprecate (V1.3.11 拿掉 settings UI)。
let _portfolioHoldings = {};  // key 'TW:2330' / 'US:AAPL' → { qty, cost (= avgCost) }

function getMarketHoldings(market) {
  const mk = market === 'tw' ? 'TW' : 'US';
  const out = {};
  for (const key in _portfolioHoldings) {
    if (key.indexOf(mk + ':') === 0) {
      out[key.slice(mk.length + 1)] = _portfolioHoldings[key];
    }
  }
  return out;
}

// ── Portfolio summary banner (V1.3.11) ──────────────────────────────────────
// 從 /api/portfolio/holdings + /api/portfolio/quotes 算總未實現損益，
// 顯示在 nav 下方 banner。沒持倉就 hide。Click 整 banner 跳 /portfolio。
async function loadPortfolioSummary() {
  const banner = document.getElementById('portfolio-summary');
  if (!banner) return;
  const uid = getUid();
  if (!uid) { banner.hidden = true; return; }
  try {
    const r = await fetch('/api/portfolio/holdings', {
      headers: { 'X-User-Id': encodeURIComponent(uid) },
    });
    if (!r.ok) { banner.hidden = true; return; }
    const j = await r.json();
    const holdings = j.holdings || [];
    // V1.3.14: populate cache，stocks card render 用
    _portfolioHoldings = {};
    for (const h of holdings) {
      _portfolioHoldings[h.market + ':' + h.symbol] = { qty: h.qty, cost: h.avgCost };
    }
    if (holdings.length === 0) { banner.hidden = true; return; }

    // 抓 quotes batch
    const tw = holdings.filter(h => h.market === 'TW').map(h => h.symbol);
    const us = holdings.filter(h => h.market === 'US').map(h => h.symbol);
    const params = new URLSearchParams();
    if (tw.length) params.set('tw', tw.join(','));
    if (us.length) params.set('us', us.join(','));
    const qr = await fetch('/api/portfolio/quotes?' + params);
    const quotes = qr.ok ? ((await qr.json()).quotes || {}) : {};

    // V1.3.17: 美股換匯成 TWD 再加總 (user 反映 bug: 數字直接相加沒換匯)
    let fxUsdTwd = 32;  // fallback if fetch fail
    try {
      const fxR = await fetch('/api/portfolio/fx?pair=USD/TWD');
      if (fxR.ok) {
        const fxJ = await fxR.json();
        if (typeof fxJ.rate === 'number' && fxJ.rate > 0) fxUsdTwd = fxJ.rate;
      }
    } catch {}

    let totalCost = 0;
    let totalValue = 0;
    for (const h of holdings) {
      const q = quotes[h.market + ':' + h.symbol] || {};
      const price = typeof q.price === 'number' ? q.price : h.avgCost;
      const fx = h.market === 'US' ? fxUsdTwd : 1;
      totalCost += h.costBasis * fx;
      totalValue += h.qty * price * fx;
    }
    const pnl = totalValue - totalCost;
    const pct = totalCost > 0 ? (pnl / totalCost * 100) : 0;
    const valueEl = document.getElementById('ps-value');
    valueEl.className = 'ps-value ' + (pnl > 0 ? 'ps-up' : pnl < 0 ? 'ps-down' : '');
    const sign = pnl > 0 ? '+' : '';
    const fmtNum = (n) => Math.round(n).toLocaleString();
    valueEl.textContent = sign + fmtNum(pnl) + ' (' + sign + pct.toFixed(1) + '%)';
    // 標註用了 USD/TWD 即期 rate 換匯，提示這是 approximation (不含買進當時 FX gain since purchase)
    const hasUs = holdings.some(h => h.market === 'US');
    const hasTw = holdings.some(h => h.market === 'TW');
    const noteEl = document.getElementById('ps-fx-note');
    if (noteEl) {
      // 釐清：這個數字是「台股＋美股」合計（美股換成台幣再加總），不是只算美股。
      // 之前只寫「美股部位 × USD/TWD 換算」害 user 以為台股沒被算進去。
      noteEl.textContent = (hasTw && hasUs)
        ? '台股＋美股合計，美股以 USD/TWD ' + fxUsdTwd.toFixed(2) + ' 換算成台幣'
        : hasUs ? '美股以 USD/TWD ' + fxUsdTwd.toFixed(2) + ' 換算成台幣'
        : hasTw ? '台股合計'
        : '';
    }
    banner.hidden = false;
  } catch (e) {
    banner.hidden = true;
  }
}
// 載入後 trigger 一次 (page load); refresh 時也 trigger
loadPortfolioSummary();

// 手機自己抓天氣：瀏覽器直連 Open-Meteo，繞開 Render 共用 IP 的 429 限流。
// 回傳格式跟伺服器端 fetchWeather 完全一致（renderWx 不必改）。
// 注意：瀏覽器不能自訂 User-Agent header（會被擋/觸發 preflight），所以這裡 fetch 不帶 header。
async function fetchAirQualityClient(locs) {
  if (!locs || locs.length === 0) return [];
  try {
    const lats = locs.map(l => l.lat).join(',');
    const lons = locs.map(l => l.lon).join(',');
    const params = new URLSearchParams({
      latitude: lats, longitude: lons, current: 'us_aqi,pm2_5', timezone: 'Asia/Taipei',
    });
    const r = await fetch('https://air-quality-api.open-meteo.com/v1/air-quality?' + params.toString());
    if (!r.ok) return locs.map(() => ({ aqi: null, pm25: null }));
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [data];
    return locs.map((_, i) => {
      const d = arr[i];
      if (!d || !d.current) return { aqi: null, pm25: null };
      return {
        aqi: d.current.us_aqi != null ? Math.round(d.current.us_aqi) : null,
        pm25: d.current.pm2_5 != null ? Math.round(d.current.pm2_5) : null,
      };
    });
  } catch (e) {
    return locs.map(() => ({ aqi: null, pm25: null }));
  }
}

async function fetchWeatherClient(locs) {
  if (!locs || locs.length === 0) return [];
  const lats = locs.map(l => l.lat).join(',');
  const lons = locs.map(l => l.lon).join(',');
  const fParams = new URLSearchParams({
    latitude: lats, longitude: lons,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max',
    wind_speed_unit: 'kn', timezone: 'Asia/Taipei', forecast_days: '7',
  });
  const fUrl = 'https://api.open-meteo.com/v1/forecast?' + fParams.toString();
  // 8 秒 timeout + 1 次 retry（比照伺服器端容錯）
  let r = null, lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    try {
      r = await fetch(fUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) throw new Error('open-meteo HTTP ' + r.status);
      break;
    } catch (e) {
      clearTimeout(tid); lastErr = e; r = null;
      if (attempt < 1) await new Promise(res => setTimeout(res, 1500));
    }
  }
  if (!r) throw lastErr || new Error('open-meteo fetch failed');
  const airArr = await fetchAirQualityClient(locs).catch(() => locs.map(() => ({ aqi: null, pm25: null })));
  const data = await r.json();
  const arr = Array.isArray(data) ? data : [data];
  return locs.map((loc, i) => {
    const d = arr[i];
    const air = airArr[i] || { aqi: null, pm25: null };
    if (!d || !d.current) return { name: loc.name, aqi: air.aqi, pm25: air.pm25, _error: 'no_data' };
    const c = d.current;
    const daily = d.daily || {};
    const forecast = [];
    const nDays = Math.min(7, (daily.time || []).length);
    for (let j = 0; j < nDays; j++) {
      const dateStr = daily.time[j];
      let label;
      if (j === 0) label = '今';
      else if (j === 1) label = '明';
      else {
        const parts = String(dateStr).split('-').map(Number);
        const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
        label = ['日','一','二','三','四','五','六'][dt.getUTCDay()];
      }
      forecast.push({
        day: label,
        code: daily.weather_code ? daily.weather_code[j] : null,
        tmax: daily.temperature_2m_max ? daily.temperature_2m_max[j] : null,
        tmin: daily.temperature_2m_min ? daily.temperature_2m_min[j] : null,
      });
    }
    const hm = (iso) => iso ? iso.split('T')[1] : '—';
    return {
      name: loc.name,
      temp: c.temperature_2m,
      feels: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      wind: c.wind_speed_10m != null ? Math.round(c.wind_speed_10m) : null,
      windDir: c.wind_direction_10m != null ? Math.round(c.wind_direction_10m) : null,
      uv: daily.uv_index_max ? Math.round(daily.uv_index_max[0]) : null,
      code: c.weather_code,
      sunrise: hm((daily.sunrise || [])[0] || ''),
      sunset: hm((daily.sunset || [])[0] || ''),
      aqi: air.aqi,
      pm25: air.pm25,
      forecast,
    };
  });
}

// 🔄 個別區塊重抓（只換該區塊 DOM，保留捲動位置跟其他區塊）
async function refreshPartial(section) {
  const secIdMap = { weather: 'sec-wx', stocks_tw: 'sec-stw', stocks_us: 'sec-sus', fx: 'sec-fx' };
  const secId = secIdMap[section];
  const secEl = document.getElementById(secId);
  const btn = secEl ? secEl.querySelector('.sec-set-btn[title="重新抓取此區塊"]') : null;
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    let data;
    if (section === 'weather') {
      // 天氣改成「手機自己抓」：瀏覽器直連 Open-Meteo（繞開 Render 共用 IP 的 429）。
      try {
        const locs = getActiveWxLocs();
        const weather = await fetchWeatherClient(locs);
        const nowIso = new Date().toISOString();
        data = { weather, weather_fetched_at: nowIso };
        // 存回伺服器（只存、不再 call Open-Meteo）→ 重開/換裝置仍在。
        // keepalive：使用者抓完馬上重開/關頁時，瀏覽器仍會把這個存檔請求送完（codex P2）。
        apiFetch('/api/morning-report/refresh-partial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({ section: 'weather', data: weather }),
        }).catch(() => {});   // 存檔失敗不影響畫面（畫面已用剛抓到的資料渲染）
      } catch (clientErr) {
        // 手機直抓失敗（網路過濾 / 隱私工具 / 暫時性錯誤）→ 退回伺服器抓，保留舊行為當後路（codex P1）。
        const r = await apiFetch('/api/morning-report/refresh-partial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ section: 'weather' }),
        });
        const j = await r.json();
        if (!r.ok) {
          alert('重抓失敗：' + (j.error || '未知錯誤'));
          return;
        }
        data = await fetchReport();
      }
    } else {
      const r = await apiFetch('/api/morning-report/refresh-partial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section }),
      });
      const j = await r.json();
      if (!r.ok) {
        alert('重抓失敗：' + (j.error || '未知錯誤'));
        return;
      }
      // 只抓回整份 report，只換該區塊 body，不動其他區塊 → 捲動位置不變
      data = await fetchReport();
    }
    const secBody = secEl ? secEl.querySelector('.sec-b') : null;
    if (!secBody) return;
    // 順便更新該 section 的時間戳
    const timeEl = secEl.querySelector('.sec-time');
    const tsField = section + '_fetched_at';
    if (timeEl && data[tsField]) {
      try {
        const d = new Date(data[tsField]);
        const tpe = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
        const m = tpe.getMonth() + 1, day = tpe.getDate();
        const hh = String(tpe.getHours()).padStart(2, '0');
        const mm = String(tpe.getMinutes()).padStart(2, '0');
        timeEl.textContent = m + '/' + day + ' ' + hh + ':' + mm;
      } catch (e) {}
    }
    if (section === 'weather') {
      const activeWx = getActiveWxLocs();
      const wxByName = {};
      (data.weather || []).forEach(w => { if (w && w.name) wxByName[w.name] = w; });
      const html = activeWx.length === 0
        ? '<div class="wx-empty">尚未選擇天氣地點，請點標題右邊的 ⚙️<br>No weather locations selected. Tap ⚙️ next to the title.</div>'
        : activeWx.map(loc => renderWx(wxByName[loc.name] || { name: loc.name, temp: null, feels: null, humidity: null, wind: null, windDir: null, uv: null, code: null, sunrise: '—', sunset: '—', forecast: [] })).join('');
      secBody.innerHTML = html;
      setupItemDrag('#sec-wx .sec-b', '.wx-loc', 'wx');
    } else if (section === 'stocks_tw') {
      const userTw = loadSetting('tw', DEFAULTS.tw);
      const summary = renderStockSummary('tw', userTw, data.stocks_tw || {});
      const rows = userTw.map(code => renderStock(code, 'tw', (data.stocks_tw || {})[code])).join('') || emptyRow();
      secBody.innerHTML = summary + rows;
      setupItemDrag('#sec-stw .sec-b', '.row', 'tw');
    } else if (section === 'stocks_us') {
      const userUs = loadSetting('us', DEFAULTS.us);
      const summary = renderStockSummary('us', userUs, data.stocks_us || {});
      const rows = userUs.map(code => renderStock(code, 'us', (data.stocks_us || {})[code])).join('') || emptyRow();
      secBody.innerHTML = summary + rows;
      setupItemDrag('#sec-sus .sec-b', '.row', 'us');
    } else if (section === 'fx') {
      const userFx = loadSetting('fx', DEFAULTS.fx);
      const rows = userFx.map(c => renderFx(c, (data.fx || {})[c])).join('') || emptyRow();
      secBody.innerHTML = rows;
      setupItemDrag('#sec-fx .sec-b', '.row', 'fx');
    }
  } catch (e) {
    alert('連線失敗：' + e.message);
  } finally {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}
window.refreshPartial = refreshPartial;

// ↻ Refresh button → 真的重新抓所有資料，無節流
async function smartRefresh() {
  const btn = document.getElementById('btn-refresh');
  const origText = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const r = await apiFetch('/api/morning-report/refresh', { method: 'POST' });
    const j = await r.json();
    if (r.ok) {
      await loadAndRender();
    } else if (j.reason === 'already_running') {
      alert('正在重新抓資料中，請稍候');
      await loadAndRender();
    } else {
      alert('重新抓取失敗：' + (j.error || j.reason || '未知錯誤'));
      await loadAndRender();
    }
  } catch (e) {
    alert('連線失敗：' + e.message);
    await loadAndRender();
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

// Event bindings
document.getElementById('btn-refresh').addEventListener('click', smartRefresh);
document.getElementById('btn-date').addEventListener('click', showDate);
// V2.4.xx 日夜改直立膠囊（onclick=setMorningTheme），不再需要 btn-theme 監聽
document.getElementById('btn-font-up').addEventListener('click', () => bumpFont(1));
document.getElementById('btn-font-dn').addEventListener('click', () => bumpFont(-1));
document.getElementById('cal-prev').addEventListener('click', () => calNav(-1));
document.getElementById('cal-next').addEventListener('click', () => calNav(1));
document.getElementById('set-wx-custom').addEventListener('input', updateWxCounter);
document.getElementById('set-tw-custom').addEventListener('input', updateTwCounter);
document.getElementById('set-us-custom').addEventListener('input', updateUsCounter);
document.getElementById('set-fx-custom').addEventListener('input', updateFxCounter);

// Nav bar click → scroll to section
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-target');
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// Measure top-stack (header + nav) height for sticky + scroll-margin-top offset
function updateHdrH() {
  const h = document.querySelector('.hdr');
  if (h) document.documentElement.style.setProperty('--hdr-h', h.offsetHeight + 'px');
  const ts = document.querySelector('.top-stack');
  if (ts) document.documentElement.style.setProperty('--top-stack-h', ts.offsetHeight + 'px');
}
updateHdrH();
window.addEventListener('resize', updateHdrH);
// Measure again after initial render + fonts load
setTimeout(updateHdrH, 100);
setTimeout(updateHdrH, 500);

// ── News category collapse ───────────────────────────────────────
function toggleNewsCat(cat) {
  const el = document.querySelector('.news-cat[data-newscat="' + cat + '"]');
  if (!el) return;
  el.classList.toggle('collapsed');
  const collapsed = loadSetting('secCollapsed', {});
  collapsed['tw-news-' + cat] = el.classList.contains('collapsed');
  saveSetting('secCollapsed', collapsed);
}
window.toggleNewsCat = toggleNewsCat;

// ── News category drag-to-reorder ────────────────────────────────
function setupNewsCatDrag() {
  const wrap = document.getElementById('tw-news-cats');
  if (!wrap) return;
  let dragCat = null;
  let placeholder = null;

  function getCats() { return Array.from(wrap.querySelectorAll('.news-cat')); }
  function saveNewsCatOrder() {
    const order = getCats().map(c => c.getAttribute('data-newscat'));
    saveSetting('newsCatOrder', order);
    try {
      apiFetch('/api/morning-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newsCatOrder: order }),
      }).catch(() => {});
    } catch (e) {}
  }

  wrap.querySelectorAll('.nc-drag').forEach(handle => {
    // Touch
    handle.addEventListener('touchstart', (e) => {
      const cat = handle.closest('.news-cat');
      if (!cat) return;
      dragCat = cat;
      cat.classList.add('nc-dragging');
    }, { passive: true });
    handle.addEventListener('touchmove', (e) => {
      if (!dragCat) return;
      e.preventDefault();
      const y = e.touches[0].clientY;
      const cats = getCats();
      cats.forEach(c => c.classList.remove('nc-drag-over'));
      for (const c of cats) {
        if (c === dragCat) continue;
        const r = c.getBoundingClientRect();
        if (y < r.top + r.height / 2) { c.classList.add('nc-drag-over'); placeholder = c; break; }
      }
    }, { passive: false });
    handle.addEventListener('touchend', () => {
      if (!dragCat) return;
      dragCat.classList.remove('nc-dragging');
      getCats().forEach(c => c.classList.remove('nc-drag-over'));
      if (placeholder) { wrap.insertBefore(dragCat, placeholder); saveNewsCatOrder(); }
      dragCat = null; placeholder = null;
    });

    // Mouse
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const cat = handle.closest('.news-cat');
      if (!cat) return;
      dragCat = cat;
      cat.classList.add('nc-dragging');
      const onMove = (ev) => {
        const y = ev.clientY;
        const cats = getCats();
        cats.forEach(c => c.classList.remove('nc-drag-over'));
        for (const c of cats) {
          if (c === dragCat) continue;
          const r = c.getBoundingClientRect();
          if (y < r.top + r.height / 2) { c.classList.add('nc-drag-over'); placeholder = c; break; }
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragCat) dragCat.classList.remove('nc-dragging');
        getCats().forEach(c => c.classList.remove('nc-drag-over'));
        if (placeholder && dragCat) { wrap.insertBefore(dragCat, placeholder); saveNewsCatOrder(); }
        dragCat = null; placeholder = null;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ── Bilingual Reader ─────────────────────────────────────────────
async function openReader(encodedUrl) {
  const url = decodeURIComponent(encodedUrl);
  const wrap = document.getElementById('reader-wrap');
  const title = document.getElementById('reader-title');
  const body = document.getElementById('reader-body');
  wrap.classList.add('show');
  title.textContent = '載入中…';
  body.innerHTML = '<div class="reader-loading">正在擷取文章並翻譯，約需 10-30 秒…</div>';
  try {
    const r = await apiFetch('/api/morning-reader?url=' + encodeURIComponent(url));
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || err.error || 'HTTP ' + r.status);
    }
    const data = await r.json();
    title.textContent = data.title_zh || data.title || '—';
    let html = '';
    // Title bilingual
    if (data.title) {
      html += '<div class="reader-para-en" style="font-size:1.1em;font-weight:700;margin-bottom:4px">' + escapeHtml(data.title) + '</div>';
      if (data.title_zh) html += '<div class="reader-para-zh" style="font-size:1em;font-weight:700;margin-bottom:20px">' + escapeHtml(data.title_zh) + '</div>';
    }
    // Paragraphs
    for (const p of (data.paragraphs || [])) {
      html += '<div class="reader-para-en">' + escapeHtml(p.en) + '</div>';
      html += '<div class="reader-para-zh">' + escapeHtml(p.zh || '（翻譯失敗）') + '</div>';
    }
    // Source link
    html += '<div class="reader-source">原文 Original: <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(data.source || url) + '</a></div>';
    body.innerHTML = html;
  } catch (e) {
    // Fallback：用 Google Translate 連結
    const gtUrl = 'https://translate.google.com/translate?sl=en&tl=zh-TW&u=' + encodeURIComponent(url);
    body.innerHTML = '<div class="reader-error">'
      + '此來源不支援逐段雙語閱讀，已為您準備 Google 翻譯版本。<br><br>'
      + '<a href="' + gtUrl + '" target="_blank" rel="noopener" style="color:var(--accent);font-size:1.1em;font-weight:700">📖 Google 翻譯版 →</a><br><br>'
      + '<a href="' + url + '" target="_blank" rel="noopener" style="color:var(--muted);font-size:.85em">或直接開啟英文原文 →</a>'
      + '</div>';
  }
}
function closeReader() {
  document.getElementById('reader-wrap').classList.remove('show');
}
window.openReader = openReader;
document.getElementById('reader-back').addEventListener('click', closeReader);

// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/morning/sw.js', { scope: '/morning/' }).catch(e => console.warn('SW register failed', e));
}

// Nickname modal wiring
document.getElementById('nick-submit').addEventListener('click', submitNickname);
document.getElementById('nick-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNickname();
});

// 每次開 app 自動同步 server 上最新的 prefs → localStorage（跨裝置同步）
async function syncPrefsFromServer() {
  try {
    const r = await apiFetch('/api/morning-prefs');
    if (!r.ok) return;
    const serverPrefs = await r.json();
    if (!serverPrefs) return;
    // wx：反向對應 server 的 {name,lat,lon} → preset ID + custom
    // ⚠️ 只在 server 回非空陣列時才覆蓋本機（避免 server 端 bug 造成的空陣列洗掉本機自選）
    if (Array.isArray(serverPrefs.wx) && serverPrefs.wx.length > 0) {
      const presetByName = {};
      Object.values(WX_PRESETS).forEach(arr => arr.forEach(p => { presetByName[p[1]] = p[0]; }));
      const presets = [];
      const custom = [];
      for (const w of serverPrefs.wx) {
        if (presetByName[w.name]) presets.push(presetByName[w.name]);
        else custom.push(w);
      }
      saveSetting('wxPresets', presets);
      saveSetting('wxCustom', custom);
    }
    if (Array.isArray(serverPrefs.tw) && serverPrefs.tw.length > 0) saveSetting('tw', serverPrefs.tw);
    if (Array.isArray(serverPrefs.us) && serverPrefs.us.length > 0) saveSetting('us', serverPrefs.us);
    if (Array.isArray(serverPrefs.fx) && serverPrefs.fx.length > 0) saveSetting('fx', serverPrefs.fx);
    // 排序欄位：只要是陣列就同步（不像 wx/tw/us/fx 有誤洗疑慮）
    if (Array.isArray(serverPrefs.secOrder)) saveSetting('secOrder', serverPrefs.secOrder);
    if (Array.isArray(serverPrefs.newsCatOrder)) saveSetting('newsCatOrder', serverPrefs.newsCatOrder);
    // Holdings：物件，只要是 object 就同步
    if (serverPrefs.tw_holdings && typeof serverPrefs.tw_holdings === 'object') saveSetting('twHoldings', serverPrefs.tw_holdings);
    if (serverPrefs.us_holdings && typeof serverPrefs.us_holdings === 'object') saveSetting('usHoldings', serverPrefs.us_holdings);
    if (typeof serverPrefs.fx_decimals === 'number' && [0, 2, 4].includes(serverPrefs.fx_decimals)) saveSetting('fxDecimals', serverPrefs.fx_decimals);

    // 自動還原：如果 server 四大自選全空，但該使用者有歷史報告，從最近一份非空快照反推清單寫回
    const wiped = (!serverPrefs.wx || serverPrefs.wx.length === 0)
               && (!serverPrefs.tw || serverPrefs.tw.length === 0)
               && (!serverPrefs.us || serverPrefs.us.length === 0)
               && (!serverPrefs.fx || serverPrefs.fx.length === 0);
    if (wiped) {
      await tryAutoRecoverPrefs(serverPrefs);
    }
  } catch (e) { /* 靜默失敗，不影響正常載入 */ }
}

// 從最近一份非空 morning report 反推出 wx/tw/us/fx 清單，寫回 server + localStorage
async function tryAutoRecoverPrefs(existingServerPrefs) {
  try {
    const dr = await apiFetch('/api/morning-report/dates');
    if (!dr.ok) return;
    const dj = await dr.json();
    const dates = Array.isArray(dj.dates) ? dj.dates : [];
    if (dates.length === 0) return;
    // 建 name → preset 反查
    const presetByName = {};
    Object.values(WX_PRESETS).forEach(arr => arr.forEach(p => { presetByName[p[1]] = { id: p[0], lat: p[2], lon: p[3] }; }));
    // 依日期由新到舊掃，找第一份有 weather/stocks/fx 的報告
    for (const date of dates) {
      const rr = await apiFetch('/api/morning-report?date=' + encodeURIComponent(date));
      if (!rr.ok) continue;
      const data = await rr.json();
      const weather = Array.isArray(data.weather) ? data.weather : [];
      const tw = data.stocks_tw ? Object.keys(data.stocks_tw) : [];
      const us = data.stocks_us ? Object.keys(data.stocks_us) : [];
      const fx = data.fx ? Object.keys(data.fx) : [];
      if (weather.length === 0 && tw.length === 0 && us.length === 0 && fx.length === 0) continue;
      // 反推 wx：用 name 對應 preset 拿 lat/lon（非 preset 的自訂點無從還原，略過）
      const wxPresetIds = [];
      const wxLocs = [];
      for (const w of weather) {
        const p = presetByName[w && w.name];
        if (p) { wxPresetIds.push(p.id); wxLocs.push({ name: w.name, lat: p.lat, lon: p.lon }); }
      }
      // 寫回 server（merge 模式，不影響 secOrder/newsCatOrder）
      try {
        await apiFetch('/api/morning-prefs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wx: wxLocs, tw, us, fx }),
        });
      } catch (e) {}
      // 寫回 localStorage
      saveSetting('wxPresets', wxPresetIds);
      // 不覆寫 wxCustom（自訂點無從還原）
      saveSetting('tw', tw);
      saveSetting('us', us);
      saveSetting('fx', fx);
      console.log('[morning] auto-recovered prefs from report', date, { wx: wxLocs.length, tw: tw.length, us: us.length, fx: fx.length });
      try { alert('偵測到你的自選被意外清空，已從 ' + date + ' 的歷史快照自動還原。'); } catch (e) {}
      return;
    }
  } catch (e) { /* silent */ }
}

// Initial load: check if uid exists; if not, show onboarding modal
updateHdrTitle();
if (!getUid()) {
  showNickModal();
} else {
  // 有 uid → 先同步 prefs 再載入
  syncPrefsFromServer().then(() => loadAndRender());
}
`;
}
