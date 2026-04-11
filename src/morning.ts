// Morning Report PWA — 獨立掛載於 CrewSync 底下的每日晨報
// 所有 /morning、/api/morning-* 路由都收在這裡
// server.ts 只需要 import 並 app.use(morningRouter)

import express from 'express';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ROOT } from './config.js';
import { buildMorningReport } from './morning-builder.js';

export const MORNING_VERSION = 'V1.1.1';
const MORNING_CACHE = 'morning-v1-1-1';

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
      await pool.query(
        `INSERT INTO morning_reports (user_id, date, data, generated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, date)
         DO UPDATE SET data = EXCLUDED.data, generated_at = NOW()`,
        [userId, date, JSON.stringify(data)]
      );
      console.log('[morning] saved to Postgres:', userId, date);
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
interface UserPrefs {
  wx?: Array<{ name: string; lat: number; lon: number }>;  // [{name,lat,lon},...]
  tw?: string[];  // 股票代號
  us?: string[];
  fx?: string[];  // 貨幣對 'USD/TWD'
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
    stocks_tw: {},
    stocks_us: {},
    fx: {},
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
  res.setHeader('Cache-Control', 'no-store');
  res.send(getMorningHtml());
});

// ─── /morning/manifest.json ──────────────────────────────────────────
morningRouter.get('/morning/manifest.json', (_req, res) => {
  res.json({
    name: '晨報 Morning Report',
    short_name: '晨報',
    description: '每日天氣、股市、匯率、新聞一眼看完',
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

// ─── /morning/icon.svg — 破曉藍金 ────────────────────────────────────
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

// 從 request 取得 userId（X-User-Id header）
function reqUserId(req: express.Request): string | null {
  const raw = req.header('X-User-Id') || req.query.uid;
  return normalizeUserId(Array.isArray(raw) ? String(raw[0]) : (raw as string | undefined));
}

// ─── /api/morning-report?date=YYYY-MM-DD ─────────────────────────────
morningRouter.get('/api/morning-report', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
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

// ─── /api/morning-report/dates — 歷史日期列表 ─────────────────────────
morningRouter.get('/api/morning-report/dates', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
    const dates = await getAllDates(userId);
    res.json({ dates });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg, dates: [] });
  }
});

// ─── POST /api/morning-prefs — 使用者儲存/更新自己的設定 ────────────
morningRouter.post('/api/morning-prefs', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
    const body = req.body || {};
    const prefs: UserPrefs = {
      wx: Array.isArray(body.wx) ? body.wx.filter((w: any) => w && w.name && typeof w.lat === 'number' && typeof w.lon === 'number') : [],
      tw: Array.isArray(body.tw) ? body.tw.filter((c: any) => typeof c === 'string') : [],
      us: Array.isArray(body.us) ? body.us.filter((c: any) => typeof c === 'string') : [],
      fx: Array.isArray(body.fx) ? body.fx.filter((c: any) => typeof c === 'string') : [],
    };
    const saved = await savePrefs(userId, prefs);
    if (!saved) return res.status(503).json({ error: 'save_failed' });
    res.json({ ok: true, userId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

// ─── GET /api/morning-prefs — 使用者取回自己的設定（跨裝置同步用） ────
morningRouter.get('/api/morning-prefs', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(400).json({ error: 'missing_or_invalid_user_id' });
    const prefs = await getPrefs(userId);
    if (!prefs) return res.status(404).json({ error: 'no_prefs' });
    res.json(prefs);
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
      <stop offset="0%" stop-color="#2C3E5A"/>
      <stop offset="60%" stop-color="#3E5B7E"/>
      <stop offset="100%" stop-color="#F4A261"/>
    </linearGradient>
    <radialGradient id="sun" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFF4C2"/>
      <stop offset="100%" stop-color="#F4C430"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="210" r="85" fill="url(#sun)"/>
  <circle cx="256" cy="210" r="115" fill="#F4C430" opacity="0.2"/>
  <g transform="translate(256 320) rotate(-12)">
    <rect x="-155" y="-42" width="310" height="84" rx="6" fill="#FDFCF5"/>
    <ellipse cx="-155" cy="0" rx="10" ry="42" fill="#D8CEB0"/>
    <ellipse cx="-155" cy="0" rx="5" ry="28" fill="#BFB292"/>
    <ellipse cx="155" cy="0" rx="10" ry="42" fill="#D8CEB0"/>
    <ellipse cx="155" cy="0" rx="5" ry="28" fill="#BFB292"/>
    <rect x="-120" y="-25" width="240" height="8" rx="4" fill="#1F2D3D"/>
    <rect x="-120" y="-8"  width="210" height="5" rx="2.5" fill="#6B7A8F"/>
    <rect x="-120" y="4"   width="230" height="5" rx="2.5" fill="#6B7A8F"/>
    <rect x="-120" y="16"  width="180" height="5" rx="2.5" fill="#6B7A8F"/>
    <rect x="-20" y="-48" width="16" height="96" rx="3" fill="#E76F51" opacity="0.9"/>
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
<meta name="apple-mobile-web-app-title" content="晨報">
<meta name="theme-color" content="#1E2740">
<title>晨報 Morning Report</title>
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
body {
  margin: 0; padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans TC', sans-serif;
  font-size: 1rem;
  line-height: 1.5;
  min-height: 100vh;
  padding-bottom: env(safe-area-inset-bottom);
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
  padding: 12px 14px 10px;
  font-size: .95em;
  font-weight: 700;
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--border);
}
.sec-h .icon { font-size: 1.1em; margin-right: 6px; }
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
.sec-b { padding: 6px 0; }

/* Weather */
.wx-loc {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.wx-loc:last-child { border-bottom: none; }
.wx-loc-name { font-size: .88em; color: var(--muted); margin-bottom: 4px; }
.wx-loc-main {
  display: flex; align-items: center; gap: 14px;
}
.wx-icon { font-size: 2.4em; line-height: 1; }
.wx-temp { font-size: 1.8em; font-weight: 700; font-variant-numeric: tabular-nums; }
.wx-detail { flex: 1; font-size: .78em; color: var(--muted); }
.wx-detail div { line-height: 1.5; }
.wx-forecast {
  display: flex; gap: 6px; margin-top: 8px; overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.wx-forecast::-webkit-scrollbar { display: none; }
.wx-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--muted);
  font-size: .82em;
  line-height: 1.6;
}
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
.row a { color: var(--text); display: flex; align-items: center; justify-content: space-between; width: 100%; }
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

<div class="top-stack">
  <div class="hdr">
    <div style="min-width:0;flex:1">
      <div class="hdr-title">
        <span class="emoji">🌅</span><span id="hdr-user-title">晨報</span>
        <span class="ver" onclick="showAbout()">${MORNING_VERSION}</span>
      </div>
      <div class="hdr-date" id="hdr-date">—</div>
    </div>
    <div class="hdr-btns">
      <div class="hdr-btn-font" title="字型大小">
        <button id="btn-font-up">A+</button>
        <button id="btn-font-dn">A−</button>
      </div>
      <button class="hdr-btn" id="btn-theme" title="日/夜">🌙</button>
      <button class="hdr-btn" id="btn-date" title="歷史">📅</button>
      <button class="hdr-btn" id="btn-refresh" title="重新整理">↻</button>
    </div>
  </div>

  <nav class="nav" id="nav">
    <button class="nav-btn" data-target="sec-wx">🌤️ 天氣</button>
    <button class="nav-btn" data-target="sec-stw">📈 台股</button>
    <button class="nav-btn" data-target="sec-sus">🇺🇸 美股</button>
    <button class="nav-btn" data-target="sec-ntw">🇹🇼 台灣新聞</button>
    <button class="nav-btn" data-target="sec-nww">🌍 世界新聞</button>
  </nav>
</div>

<div id="root">
  <div class="loading">載入中 Loading…</div>
</div>

<!-- About modal -->
<div class="modal-wrap" id="about-wrap" onclick="if(event.target===this)hideAbout()">
  <div class="modal">
    <button class="close" onclick="hideAbout()">✕</button>
    <h3>🌅 晨報 Morning Report</h3>
    <div style="font-size:.8em;color:var(--muted);margin-bottom:10px">
      每日天氣、股市、匯率、新聞<br>
      Daily weather, stocks, FX, news digest
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
    <div class="changelog-v">${MORNING_VERSION}</div>
    <div class="changelog-txt">
      大幅重構為多使用者架構（暱稱當 user_id）：Postgres schema 擴充 morning_reports 加 user_id 欄位、PK 改 (user_id, date)、新增 morning_prefs 表；前端首次開 /morning 跳出暱稱輸入 modal 存 localStorage，重裝或換裝置用同名找回歷史；所有 /api/morning-* 改 per-user（X-User-Id header 必備，缺失回 400）；新端點 POST/GET /api/morning-prefs；設定存檔自動上傳並觸發該使用者重建；Builder 支援 multi-user，cron 06:30 iterate 所有使用者 prefs、計算 union 批次抓、分發給各使用者；設定頁底部加「切換使用者」按鈕；header 標題顯示為「暱稱 的晨報」；runBuildUser 加 waitForLock 避免 race；版次前綴 M→V；新增 test/smoke-m.ts 含 JS parse 檢查；補回 V1.0.3 changelog 在 V1.1.0 推版被誤刪；移除本地 JSON 檔 fallback（多使用者下會洩漏共享資料）。<br>
      Major refactor to multi-user architecture (nickname as user_id): Postgres schema expands morning_reports with user_id column and composite PK, new morning_prefs table; nickname modal on first visit, recoverable via same name across reinstalls/devices; all /api/morning-* now per-user via X-User-Id header; new POST/GET /api/morning-prefs endpoints; settings save auto-uploads and triggers per-user rebuild; builder supports multi-user with cron iterating all users, computing union, batch fetching and distributing; switch-user button in settings; header shows personalized "[nickname]'s Morning Report"; runBuildUser waits for lock to avoid races; version prefix M→V; new test/smoke-m.ts with inline JS parse check; restored V1.0.3 changelog; removed local JSON fallback (leaked shared data in multi-user mode).
    </div>
    <div class="changelog-v old">V1.1.0</div>
    <div class="changelog-txt">
      晨報升級為真實資料每日自動更新：新增 src/morning-builder.ts 整合 5 個資料源（Open-Meteo 145+ 地點天氣 / cnyes JSON API 台美股 / 台銀 CSV 匯率含交叉盤自動計算 / Google News RSS / Google Translate），資料存 Postgres morning_reports 表（本地 JSON fallback）。內建 cron 每分鐘檢查：06:30 台北時間那一分鐘強制重建（06:30 是正式版），06:31+ 只在今天缺資料時重試；伺服器啟動時立即檢查補跑錯過的 06:30。⟳ 按鈕升級為「聰明重抓」：真的觸發重建、30 分鐘節流、建構中鎖定。新增 POST /api/morning-report/refresh 端點。所有 API 路由改 async。部分失敗容錯。新增 🛫 國際機場 7 大類 76 個機場（依據 CrewSync Airport WX Ops Spec C-6 清單），天氣地點從 69 擴增至 145。設定頁分類改為收合式（天氣 10 類 / 台股 4 類 / 美股 4 類 / 匯率 3 類），預設收合、有勾選項自動展開、顯示 N/M 計數。修正 nav bar 點擊捲動時 section header 被 nav 壓住的 bug（V1.0.3 帶入）：scroll-margin-top 改用動態測量的 --top-stack-h 變數。<br>
      Morning Report upgraded to real data with daily auto-refresh via built-in cron at 06:30 Asia/Taipei; Postgres storage; smart refresh button with 30-min throttle; new POST /api/morning-report/refresh; all routes async; partial-failure tolerant; added International Airports category with 76 airports (from Ops Spec C-6), weather locations expanded from 69 to 145; settings categories now collapsible with auto-expand for selected and N/M counts; fixed nav scroll header hidden bug.
    </div>
    <div class="changelog-v old">V1.0.3</div>
    <div class="changelog-txt">
      設定改為分散式：右上角統一 ⚙️ 移除，天氣/台股/美股/匯率每個 section 標題右邊各自有獨立 ⚙️，點哪區就只開那區的設定（修正匯率要拉很下面的問題）；台股加內建勾選清單（半導體/電子/金融/傳產航運 4 類約 30 支）；美股加內建勾選清單（科技/ETF/金融/消費 4 類約 30 支）；匯率改支援跨幣種不限對台幣（對台幣/主要貨幣對/交叉盤 3 類約 25 對，舊版 ['USD','JPY'] 自動遷移）；天氣預設調整為台北 + 桃園龜山；台股預設調整為 2330 + 3231；修正假資料「台北福華」→「台北」。<br>
      Per-section settings: unified top-right ⚙️ removed, each section now has its own ⚙️ (fixes scrolling past weather to reach FX); built-in presets for TW/US stocks and FX with cross-currency pair support; default tweaks; placeholder data name fix.
    </div>
    <div class="changelog-v old">V1.0.2</div>
    <div class="changelog-txt">
      A+/A− 字型按鈕間距拉開，改回兩顆獨立上下排列；修正 nav bar 橫向捲動時回彈反彈效果（overscroll-behavior-x: contain）、整頁防 iOS 橡皮筋反彈（overscroll-behavior: none）。<br>
      A+/A− font buttons spaced apart, restored as two separate stacked buttons; fix nav bar horizontal overscroll bounce, disable iOS rubber-band bounce on full page.
    </div>
    <div class="changelog-v old">V1.0.1</div>
    <div class="changelog-txt">
      天氣地點設定改成勾選式：內建 3 大類共 68 個預設點位（🇹🇼 台灣城市 23 個 / 🏞️ 台灣景點 17 個 / 🌏 國際城市 33 個，含蘇黎世、布拉格、鳳凰城），保留手動輸入經緯度功能，總上限 10 個地點；Header 按鈕列在手機過寬修正：A+/A− 合併為上下複合按鈕省一格、整列緊湊化；Nav bar 在手機被推走修正：header 與 nav 改為同一 sticky 容器一起釘頂。<br>
      Weather location setting switched to checkbox UI with 68 built-in presets, manual lat/lon input retained, max 10 total; Fix header button row overflowing on mobile; Fix nav bar being pushed off on mobile.
    </div>
    <div class="changelog-v old">V1.0.0</div>
    <div class="changelog-txt">
      晨報首次上線：每日天氣（4 地點、風向箭頭、knot 風速）、台股/美股（連 cnyes 頁面）、匯率（對台幣）、台灣新聞（Google News RSS，同來源最多 2 條，🇹🇼 國旗圖示）、世界新聞（英文原文 + 繁中翻譯）、PWA 安裝（獨立 icon/manifest/SW）、快速導覽列、月曆歷史檢視（金色高亮有資料日期）、日/夜模式、字型放大縮小、設定頁自選追蹤項目。<br>
      Morning Report first release: daily weather (4 locations with wind arrow + knots), TW/US stocks, FX, TW+World news, installable PWA, quick-nav bar, calendar history, day/night theme, font scaling, customizable watchlists.
    </div>
  </div>
</div>

<!-- Settings modal (per-section) -->
<div class="modal-wrap" id="set-wrap" onclick="if(event.target===this)hideSet()">
  <div class="modal">
    <button class="close" onclick="hideSet()">✕</button>
    <h3 id="set-title">⚙️ 設定 Settings</h3>
    <div style="font-size:.75em;color:var(--muted);margin-bottom:12px">
      設定會存在這個裝置的瀏覽器裡，換裝置或清快取會重置。
    </div>

    <div class="set-sec" data-section="wx">
      <h4>🌤️ 天氣地點</h4>
      <p>勾選預設或手動輸入，最多 10 個</p>
      <div class="wx-counter" id="wx-counter">已選 0 / 10</div>
      <div id="wx-presets"></div>
      <div style="margin-top:14px">
        <p style="margin-top:0">手動加地點（一行一個，格式：<code>名稱,緯度,經度</code>）</p>
        <textarea id="set-wx-custom" placeholder="自選地點,24.99,121.31"></textarea>
      </div>
    </div>

    <div class="set-sec" data-section="tw">
      <h4>📈 台股</h4>
      <p>勾選預設或手動輸入代號，最多 20 支</p>
      <div class="wx-counter" id="tw-counter">已選 0 / 20</div>
      <div id="tw-presets"></div>
      <div style="margin-top:14px">
        <p style="margin-top:0">手動加代號（用逗號分隔，例如 4968,3515）</p>
        <textarea id="set-tw-custom" placeholder="4968,3515"></textarea>
      </div>
    </div>

    <div class="set-sec" data-section="us">
      <h4>🇺🇸 美股</h4>
      <p>勾選預設或手動輸入代號，最多 20 支</p>
      <div class="wx-counter" id="us-counter">已選 0 / 20</div>
      <div id="us-presets"></div>
      <div style="margin-top:14px">
        <p style="margin-top:0">手動加代號（用逗號分隔，例如 GME,AMC）</p>
        <textarea id="set-us-custom" placeholder="GME,AMC"></textarea>
      </div>
    </div>

    <div class="set-sec" data-section="fx">
      <h4>💱 匯率</h4>
      <p>勾選常用貨幣對（不限對台幣），最多 15 個</p>
      <div class="wx-counter" id="fx-counter">已選 0 / 15</div>
      <div id="fx-presets"></div>
      <div style="margin-top:14px">
        <p style="margin-top:0">手動加貨幣對（用逗號分隔，例如 CHF/TWD,USD/THB）</p>
        <textarea id="set-fx-custom" placeholder="CHF/TWD,USD/THB"></textarea>
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
    <h3 style="margin-bottom:6px">🌅 晨報</h3>
    <div style="font-size:.85em;color:var(--muted);margin-bottom:14px;line-height:1.6">
      幫你的晨報取個名字<br>
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
    <h3>📅 歷史晨報</h3>
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
  wxPresets: 'morning_wx_presets',  // array of preset IDs
  wxCustom: 'morning_wx_custom',    // array of {name,lat,lon}
  wxLegacy: 'morning_wx_locs',      // 舊版相容：{name,lat,lon}[]
  tw: 'morning_tw_stocks',
  us: 'morning_us_stocks',
  fx: 'morning_fx_currencies',
};

function getUid() {
  try { return localStorage.getItem(LS.uid) || ''; } catch (e) { return ''; }
}
function setUid(uid) {
  try { localStorage.setItem(LS.uid, uid); } catch (e) {}
  updateHdrTitle();
}

function updateHdrTitle() {
  const el = document.getElementById('hdr-user-title');
  if (!el) return;
  const uid = getUid();
  el.textContent = uid ? (uid + ' 的晨報') : '晨報';
}

// Wrapped fetch that always adds X-User-Id header
function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  const uid = getUid();
  if (uid) opts.headers['X-User-Id'] = uid;
  return fetch(url, opts);
}

// 天氣預設地點清單（分 3 類）
// 每筆：[id, name, lat, lon]
const WX_PRESETS = {
  '🇹🇼 台灣城市': [
    ['tw-taipei', '台北', 25.03, 121.56],
    ['tw-xinbei', '新北', 24.98, 121.54],
    ['tw-keelung', '基隆', 25.13, 121.74],
    ['tw-taoyuan', '桃園', 24.99, 121.31],
    ['tw-bade', '桃園八德', 24.93, 121.28],
    ['tw-guishan', '桃園龜山', 25.04, 121.35],
    ['tw-dayuan', '桃園大園', 25.07, 121.21],
    ['tw-hsinchu', '新竹', 24.81, 120.97],
    ['tw-zhubei', '新竹竹北', 24.83, 121.00],
    ['tw-miaoli', '苗栗', 24.56, 120.82],
    ['tw-taichung', '台中', 24.14, 120.68],
    ['tw-changhua', '彰化', 24.08, 120.54],
    ['tw-nantou', '南投', 23.91, 120.68],
    ['tw-yunlin', '雲林', 23.71, 120.54],
    ['tw-chiayi', '嘉義', 23.48, 120.45],
    ['tw-tainan', '台南', 22.99, 120.22],
    ['tw-kaohsiung', '高雄', 22.63, 120.30],
    ['tw-pingtung', '屏東', 22.67, 120.49],
    ['tw-yilan', '宜蘭', 24.76, 121.75],
    ['tw-hualien', '花蓮', 23.98, 121.61],
    ['tw-taitung', '台東', 22.76, 121.14],
    ['tw-penghu', '澎湖(馬公)', 23.57, 119.58],
    ['tw-kinmen', '金門', 24.45, 118.32],
    ['tw-matsu', '馬祖(南竿)', 26.15, 119.95],
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
  '🌏 國際城市': [
    ['in-tyo', '東京 TYO', 35.68, 139.69],
    ['in-osa', '大阪 OSA', 34.69, 135.50],
    ['in-spk', '札幌 SPK', 43.06, 141.35],
    ['in-fuk', '福岡 FUK', 33.59, 130.40],
    ['in-oki', '沖繩 OKA', 26.21, 127.68],
    ['in-sel', '首爾 SEL', 37.57, 126.98],
    ['in-pus', '釜山 PUS', 35.18, 129.08],
    ['in-bjs', '北京 BJS', 39.90, 116.41],
    ['in-sha', '上海 SHA', 31.23, 121.47],
    ['in-can', '廣州 CAN', 23.13, 113.26],
    ['in-hkg', '香港 HKG', 22.32, 114.17],
    ['in-mfm', '澳門 MFM', 22.20, 113.54],
    ['in-sin', '新加坡 SIN', 1.35, 103.82],
    ['in-bkk', '曼谷 BKK', 13.75, 100.50],
    ['in-kul', '吉隆坡 KUL', 3.14, 101.69],
    ['in-han', '河內 HAN', 21.03, 105.83],
    ['in-sgn', '胡志明 SGN', 10.82, 106.63],
    ['in-mnl', '馬尼拉 MNL', 14.60, 120.98],
    ['in-dps', '峇里島 DPS', -8.65, 115.22],
    ['in-syd', '雪梨 SYD', -33.87, 151.21],
    ['in-mel', '墨爾本 MEL', -37.81, 144.96],
    ['in-lax', '洛杉磯 LAX', 34.05, -118.24],
    ['in-sfo', '舊金山 SFO', 37.77, -122.42],
    ['in-sea', '西雅圖 SEA', 47.60, -122.33],
    ['in-nyc', '紐約 NYC', 40.71, -74.01],
    ['in-yvr', '溫哥華 YVR', 49.28, -123.12],
    ['in-lhr', '倫敦 LON', 51.51, -0.13],
    ['in-par', '巴黎 PAR', 48.86, 2.35],
    ['in-fra', '法蘭克福 FRA', 50.11, 8.68],
    ['in-ams', '阿姆斯特丹 AMS', 52.37, 4.90],
    ['in-zrh', '蘇黎世 ZRH', 47.37, 8.55],
    ['in-prg', '布拉格 PRG', 50.08, 14.44],
    ['in-phx', '鳳凰城 PHX', 33.45, -112.07],
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
  '🛫 歐洲/加拿大機場': [
    ['ap-LKPR', 'LKPR 布拉格', 50.101, 14.264],
    ['ap-EDDB', 'EDDB 柏林布蘭登堡', 52.366, 13.503],
    ['ap-EDDM', 'EDDM 慕尼黑', 48.354, 11.786],
    ['ap-EPWA', 'EPWA 華沙蕭邦', 52.166, 20.967],
    ['ap-LOWL', 'LOWL 林茲', 48.233, 14.188],
    ['ap-LOWW', 'LOWW 維也納', 48.110, 16.570],
    ['ap-CYVR', 'CYVR 溫哥華', 49.195, -123.184],
  ],
};
const WX_PRESET_MAP = {};
Object.values(WX_PRESETS).forEach(arr => arr.forEach(p => { WX_PRESET_MAP[p[0]] = { id: p[0], name: p[1], lat: p[2], lon: p[3] }; }));
const WX_MAX = 10;

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

const TW_MAX = 20;
const US_MAX = 20;
const FX_MAX = 15;

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
    if (out.length >= WX_MAX) return out;
  }
  for (const c of custom) {
    if (c && c.name && typeof c.lat === 'number' && typeof c.lon === 'number') out.push(c);
    if (out.length >= WX_MAX) return out;
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
  const twRows = userTw.map(code => renderStock(code, 'tw', (data.stocks_tw || {})[code])).join('') || emptyRow();
  const usRows = userUs.map(code => renderStock(code, 'us', (data.stocks_us || {})[code])).join('') || emptyRow();
  const fxRows = userFx.map(c => renderFx(c, (data.fx || {})[c])).join('') || emptyRow();
  const twNews = (data.news_tw || []).slice(0, 10).map(renderNews).join('') || emptyNews();
  const wwNews = (data.news_world || []).slice(0, 10).map(renderNewsWorld).join('') || emptyNews();

  const setBtn = (sec) => \`<button class="sec-set-btn" title="設定" onclick="showSet('\${sec}')">⚙️</button>\`;
  root.innerHTML = \`
    <div class="sec" id="sec-wx"><div class="sec-h"><span><span class="icon">🌤️</span>天氣 Weather</span>\${setBtn('wx')}</div><div class="sec-b">\${wxBlocks || emptyRow()}</div></div>
    <div class="sec" id="sec-stw"><div class="sec-h"><span><span class="icon">📈</span>台股 TW Stocks</span>\${setBtn('tw')}</div><div class="sec-b">\${twRows}</div></div>
    <div class="sec" id="sec-sus"><div class="sec-h"><span><span class="icon">🇺🇸</span>美股 US Stocks</span>\${setBtn('us')}</div><div class="sec-b">\${usRows}</div></div>
    <div class="sec" id="sec-fx"><div class="sec-h"><span><span class="icon">💱</span>匯率 FX (vs TWD)</span>\${setBtn('fx')}</div><div class="sec-b">\${fxRows}</div></div>
    <div class="sec" id="sec-ntw"><div class="sec-h"><span><span class="icon">🇹🇼</span>台灣新聞 TW News</span></div><div class="sec-b">\${twNews}</div></div>
    <div class="sec" id="sec-nww"><div class="sec-h"><span><span class="icon">🌍</span>世界新聞 World News</span></div><div class="sec-b">\${wwNews}</div></div>
  \`;
  setupNavActive();
}

function setupNavActive() {
  const btns = document.querySelectorAll('.nav-btn');
  const secs = ['sec-wx','sec-stw','sec-sus','sec-ntw','sec-nww'].map(id => document.getElementById(id));
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
  return \`
    <div class="wx-loc">
      <div class="wx-loc-name">\${w.name || '—'}</div>
      <div class="wx-loc-main">
        <div class="wx-icon">\${wxEmoji(w.code)}</div>
        <div class="wx-temp">\${fmtT(w.temp)}</div>
        <div class="wx-detail">
          <div>體感 \${fmtT(w.feels)} · 濕度 \${fmtN(w.humidity)}%</div>
          <div>風 \${windArrow}\${windDirLabel} \${fmtN(w.wind)} kt · UV \${fmtN(w.uv)}</div>
          <div>🌅 \${w.sunrise || '—'} · 🌇 \${w.sunset || '—'}</div>
        </div>
      </div>
      <div class="wx-forecast">\${forecast}</div>
    </div>
  \`;
}

function renderStock(code, market, s) {
  const base = market === 'tw' ? 'https://www.cnyes.com/twstock/' : 'https://invest.cnyes.com/usstock/detail/';
  if (!s) {
    return \`<div class="row"><a href="\${base}\${code}" target="_blank"><div class="row-l"><div class="n">\${code}</div><div class="c">—</div></div><div class="row-r flat">—</div></a></div>\`;
  }
  const cls = chgClass(s.change);
  return \`
    <div class="row">
      <a href="\${base}\${code}" target="_blank">
        <div class="row-l">
          <div class="n">\${s.name || code}</div>
          <div class="c">\${code}</div>
        </div>
        <div class="row-r">
          <div class="p">\${fmtNum(s.price, 2)}</div>
          <div class="ch \${cls}">\${chgSign(s.change)} \${fmtNum(Math.abs(s.change), 2)} (\${pct(s.changePct)})</div>
        </div>
      </a>
    </div>
  \`;
}

function renderFx(pair, v) {
  if (!v) {
    return \`<div class="row"><div class="row-l"><div class="n">\${pair}</div><div class="c">—</div></div><div class="row-r flat">—</div></div>\`;
  }
  const isTwd = pair.endsWith('/TWD');
  const sub = isTwd && v.cashSell != null
    ? ('現金賣出 ' + fmtNum(v.cashSell, 4))
    : (v.change != null ? (pct(v.changePct) + ' (' + (v.change > 0 ? '+' : '') + fmtNum(v.change, 4) + ')') : '即期');
  return \`
    <div class="row">
      <div class="row-l">
        <div class="n">\${pair}</div>
        <div class="c">\${sub}</div>
      </div>
      <div class="row-r">
        <div class="p">\${fmtNum(v.rate, 4)}</div>
      </div>
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
function renderNewsWorld(n) {
  return \`
    <div class="news">
      <a href="\${n.url}" target="_blank" rel="noopener">
        <div class="news-t">\${escapeHtml(n.title_zh || n.title)}</div>
        \${n.title_zh && n.title ? '<div class="news-en">' + escapeHtml(n.title) + '</div>' : ''}
        <div class="news-meta"><span>\${escapeHtml(n.source || '')}</span><span>\${n.time || ''}</span></div>
      </a>
    </div>
  \`;
}
function emptyRow() { return '<div class="row flat" style="justify-content:center;color:var(--muted)">（尚無資料）</div>'; }
function emptyNews() { return '<div class="news" style="color:var(--muted);font-size:.82em">（尚無資料）</div>'; }
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadAndRender(date) {
  try {
    document.getElementById('root').innerHTML = '<div class="loading">載入中 Loading…</div>';
    const data = await fetchReport(date);
    renderReport(data);
  } catch (e) {
    document.getElementById('root').innerHTML = '<div class="error">載入失敗：' + e.message + '<br><br>晨報資料尚未產生，請稍後再試。</div>';
  }
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
  for (const cat of Object.keys(WX_PRESETS)) {
    const items = WX_PRESETS[cat];
    const sel = items.filter(p => _wxSelectedIds.includes(p[0])).length;
    const k = catKey('wx', cat);
    // 首次開啟時：有勾選 → 展開；沒勾 → 收合
    if (_catExpanded[k] === undefined) _catExpanded[k] = sel > 0;
    const expCls = _catExpanded[k] ? ' expanded' : '';
    html += '<div class="wx-cat' + expCls + '" data-cat="' + cat + '">'
      + '<div class="wx-cat-title"><span>' + cat + '</span>'
      + '<span><span class="cnt">' + sel + ' / ' + items.length + '</span> <span class="arrow">▶</span></span>'
      + '</div><div class="wx-chk-grid">';
    for (const p of items) {
      const [id, name] = p;
      const checked = _wxSelectedIds.includes(id);
      html += '<label class="wx-chk ' + (checked ? 'checked' : '') + '" data-id="' + id + '">'
        + '<input type="checkbox"' + (checked ? ' checked' : '') + '>'
        + '<span>' + name + '</span></label>';
    }
    html += '</div></div>';
  }
  wrap.innerHTML = html;
  // Category title click → toggle expand
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
        if (_wxSelectedIds.length + countWxCustomValid() >= WX_MAX) {
          alert('最多只能選 ' + WX_MAX + ' 個地點');
          return;
        }
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
  el.textContent = '已選 ' + total + ' / ' + WX_MAX;
  el.classList.toggle('full', total >= WX_MAX);
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
        if (_twSelected.length + countCsv('set-tw-custom') >= TW_MAX) {
          alert('最多只能選 ' + TW_MAX + ' 支台股');
          return;
        }
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
  el.textContent = '已選 ' + total + ' / ' + TW_MAX;
  el.classList.toggle('full', total >= TW_MAX);
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
        if (_usSelected.length + countCsv('set-us-custom') >= US_MAX) {
          alert('最多只能選 ' + US_MAX + ' 支美股');
          return;
        }
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
  el.textContent = '已選 ' + total + ' / ' + US_MAX;
  el.classList.toggle('full', total >= US_MAX);
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
        if (_fxSelected.length + countCsv('set-fx-custom') >= FX_MAX) {
          alert('最多只能選 ' + FX_MAX + ' 個匯率');
          return;
        }
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
  el.textContent = '已選 ' + total + ' / ' + FX_MAX;
  el.classList.toggle('full', total >= FX_MAX);
}

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
  const serverPrefs = { wx: wxAllLocs, tw: twAll, us: usAll, fx: fxAll };
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

// ── Theme (day/night) ────────────────────────────────────────────
function applyTheme() {
  const t = localStorage.getItem('morning_theme') || 'dark';
  const icon = document.getElementById('btn-theme');
  if (t === 'light') {
    document.documentElement.dataset.theme = 'light';
    if (icon) icon.textContent = '🌙';
  } else {
    delete document.documentElement.dataset.theme;
    if (icon) icon.textContent = '☀️';
  }
}
function toggleTheme() {
  const cur = localStorage.getItem('morning_theme') || 'dark';
  localStorage.setItem('morning_theme', cur === 'light' ? 'dark' : 'light');
  applyTheme();
}
applyTheme();

// ── Font scale ───────────────────────────────────────────────────
let _fontScale = 0;
try { const s = parseInt(localStorage.getItem('morning_font_scale') || '0'); if (!isNaN(s)) _fontScale = s; } catch (e) {}
function applyFontScale() {
  // 基準 15px，每級 +/- 1.2px (≈8%)
  const px = 15 * (1 + _fontScale * 0.08);
  document.documentElement.style.fontSize = px + 'px';
}
function bumpFont(dir) {
  _fontScale = Math.max(-2, Math.min(8, _fontScale + dir));
  try { localStorage.setItem('morning_font_scale', String(_fontScale)); } catch (e) {}
  applyFontScale();
  setTimeout(updateHdrH, 50);
}
applyFontScale();

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
document.getElementById('btn-theme').addEventListener('click', toggleTheme);
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

// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/morning/sw.js', { scope: '/morning/' }).catch(e => console.warn('SW register failed', e));
}

// Nickname modal wiring
document.getElementById('nick-submit').addEventListener('click', submitNickname);
document.getElementById('nick-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNickname();
});

// Initial load: check if uid exists; if not, show onboarding modal
updateHdrTitle();
if (!getUid()) {
  showNickModal();
} else {
  loadAndRender();
}
`;
}
