// Morning Report PWA — 獨立掛載於 CrewSync 底下的每日晨報
// 所有 /morning、/api/morning-* 路由都收在這裡
// server.ts 只需要 import 並 app.use(morningRouter)

import express from 'express';
import fs from 'fs';
import path from 'path';
import { ROOT } from './config.js';

export const MORNING_VERSION = 'M1.0.0';
const MORNING_CACHE = 'morning-v1';

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

// 找出最新一份資料檔
function latestDataDate() {
  ensureDataDir();
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    return files.length > 0 ? files[0].replace('.json', '') : null;
  } catch (e) {
    return null;
  }
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

// ─── /api/morning-report?date=YYYY-MM-DD ─────────────────────────────
morningRouter.get('/api/morning-report', (req, res) => {
  try {
    ensureDataDir();
    let date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      date = latestDataDate() || todayTaipei();
    }
    const file = path.join(DATA_DIR, `${date}.json`);
    if (!fs.existsSync(file)) {
      // fallback 最新一份
      const latest = latestDataDate();
      if (latest && latest !== date) {
        const fallback = path.join(DATA_DIR, `${latest}.json`);
        const data = JSON.parse(fs.readFileSync(fallback, 'utf-8'));
        return res.json({ ...data, _requestedDate: date, _actualDate: latest, _fallback: true });
      }
      return res.status(404).json({ error: 'no_data', date });
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    res.json({ ...data, _requestedDate: date, _actualDate: date });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

// ─── /api/morning-report/dates — 歷史日期列表 ─────────────────────────
morningRouter.get('/api/morning-report/dates', (_req, res) => {
  try {
    ensureDataDir();
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
    res.json({ dates: files });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg, dates: [] });
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
html { font-size: 15px; }
body {
  margin: 0; padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans TC', sans-serif;
  font-size: 1rem;
  line-height: 1.5;
  min-height: 100vh;
  padding-bottom: env(safe-area-inset-bottom);
}
a { color: var(--accent); text-decoration: none; }
a:active { opacity: 0.6; }

/* Header */
.hdr {
  position: sticky; top: 0; z-index: 50;
  background: linear-gradient(180deg, var(--hdr-grad-1) 0%, var(--hdr-grad-2) 100%);
  padding: calc(env(safe-area-inset-top) + 14px) 16px 12px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
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
.hdr-btns { display: flex; gap: 8px; }
.hdr-btn {
  background: rgba(255,255,255,0.08);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 10px;
  border-radius: 8px;
  font-size: .82em;
  cursor: pointer;
}
.hdr-btn:active { opacity: 0.7; }

/* Nav bar (fixed under header) */
.nav {
  position: sticky;
  top: var(--hdr-h, 0);
  z-index: 45;
  background: var(--nav-bg);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  overflow-x: auto;
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
  scroll-margin-top: 120px;
}
.sec-h {
  padding: 12px 14px 10px;
  font-size: .95em;
  font-weight: 700;
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--border);
}
.sec-h .icon { font-size: 1.1em; margin-right: 6px; }
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

<div class="hdr">
  <div>
    <div class="hdr-title">
      <span class="emoji">🌅</span>晨報
      <span class="ver" onclick="showAbout()">${MORNING_VERSION}</span>
    </div>
    <div class="hdr-date" id="hdr-date">—</div>
  </div>
  <div class="hdr-btns">
    <button class="hdr-btn" id="btn-font-dn" title="字型縮小">A−</button>
    <button class="hdr-btn" id="btn-font-up" title="字型放大">A+</button>
    <button class="hdr-btn" id="btn-theme" title="日/夜">🌙</button>
    <button class="hdr-btn" id="btn-date" title="歷史">📅</button>
    <button class="hdr-btn" id="btn-set" title="設定">⚙️</button>
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
      晨報首次上線：每日天氣（4 地點、風向箭頭、knot 風速）、台股/美股（連 cnyes 頁面）、匯率（對台幣）、台灣新聞（Google News RSS，同來源最多 2 條，🇹🇼 國旗圖示）、世界新聞（英文原文 + 繁中翻譯）、PWA 安裝（獨立 icon/manifest/SW）、快速導覽列、月曆歷史檢視（金色高亮有資料日期）、日/夜模式、字型放大縮小、設定頁自選追蹤項目。⚠️ 目前資料為 placeholder（除新聞外），GitHub Actions 爬蟲尚未部署。<br>
      Morning Report first release: daily weather (4 locations with wind arrow + knots), TW/US stocks linked to cnyes, FX rates vs TWD, TW news via Google News RSS (max 2 per source, 🇹🇼 flag icon), world news with EN original + zh-TW translation, installable PWA (independent icon/manifest/SW), quick-nav bar, month calendar history (available dates highlighted in gold), day/night theme, font scaling, customizable watchlists. ⚠️ Data is placeholder (except news); GitHub Actions crawler not yet deployed.
    </div>
  </div>
</div>

<!-- Settings modal -->
<div class="modal-wrap" id="set-wrap" onclick="if(event.target===this)hideSet()">
  <div class="modal">
    <button class="close" onclick="hideSet()">✕</button>
    <h3>⚙️ 設定 Settings</h3>
    <div style="font-size:.75em;color:var(--muted);margin-bottom:12px">
      設定會存在這個裝置的瀏覽器裡，換裝置或清快取會重置。
    </div>

    <div class="set-sec">
      <h4>🌤️ 天氣地點</h4>
      <p>一行一個地點，格式：<code>名稱,緯度,經度</code>（留空用預設）</p>
      <textarea id="set-wx" placeholder="台北福華,25.04,121.55"></textarea>
    </div>

    <div class="set-sec">
      <h4>📈 台股代號</h4>
      <p>用逗號分隔（例如 2330,1773,3231）</p>
      <textarea id="set-tw" placeholder="1773,2330,3231,5392,6919,7827"></textarea>
    </div>

    <div class="set-sec">
      <h4>🇺🇸 美股代號</h4>
      <p>用逗號分隔（例如 NVDA,TSLA,VOO）</p>
      <textarea id="set-us" placeholder="NVDA,TSLA,VST,VT,VOO,QQQ"></textarea>
    </div>

    <div class="set-sec">
      <h4>💱 匯率幣別（對台幣）</h4>
      <p>用逗號分隔（例如 USD,JPY,EUR）</p>
      <textarea id="set-fx" placeholder="USD,JPY,EUR,SGD,CNY"></textarea>
    </div>

    <button class="set-btn" onclick="saveSettings()">儲存並重新載入</button>
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
  wx: 'morning_wx_locs',
  tw: 'morning_tw_stocks',
  us: 'morning_us_stocks',
  fx: 'morning_fx_currencies',
};
const DEFAULTS = {
  wx: [
    { name: '台北福華', lat: 25.04, lon: 121.55 },
    { name: '桃園八德', lat: 24.93, lon: 121.28 },
    { name: '桃園龜山', lat: 25.04, lon: 121.35 },
    { name: '新竹竹北', lat: 24.83, lon: 121.00 },
  ],
  tw: ['1773','2330','3231','5392','6919','7827'],
  us: ['NVDA','TSLA','VST','VT','VOO','QQQ'],
  fx: ['USD','JPY','EUR','SGD','CNY'],
};

function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem(LS[key]);
    if (!v) return fallback;
    return JSON.parse(v);
  } catch (e) { return fallback; }
}
function saveSetting(key, val) {
  try { localStorage.setItem(LS[key], JSON.stringify(val)); } catch (e) {}
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
  const r = await fetch('/api/morning-report' + q);
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

  const wxBlocks = (data.weather || []).map(w => renderWx(w)).join('');
  const twRows = userTw.map(code => renderStock(code, 'tw', (data.stocks_tw || {})[code])).join('') || emptyRow();
  const usRows = userUs.map(code => renderStock(code, 'us', (data.stocks_us || {})[code])).join('') || emptyRow();
  const fxRows = userFx.map(c => renderFx(c, (data.fx || {})[c])).join('') || emptyRow();
  const twNews = (data.news_tw || []).slice(0, 10).map(renderNews).join('') || emptyNews();
  const wwNews = (data.news_world || []).slice(0, 10).map(renderNewsWorld).join('') || emptyNews();

  root.innerHTML = \`
    <div class="sec" id="sec-wx"><div class="sec-h"><span><span class="icon">🌤️</span>天氣 Weather</span></div><div class="sec-b">\${wxBlocks || emptyRow()}</div></div>
    <div class="sec" id="sec-stw"><div class="sec-h"><span><span class="icon">📈</span>台股 TW Stocks</span></div><div class="sec-b">\${twRows}</div></div>
    <div class="sec" id="sec-sus"><div class="sec-h"><span><span class="icon">🇺🇸</span>美股 US Stocks</span></div><div class="sec-b">\${usRows}</div></div>
    <div class="sec" id="sec-fx"><div class="sec-h"><span><span class="icon">💱</span>匯率 FX (vs TWD)</span></div><div class="sec-b">\${fxRows}</div></div>
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
  const forecast = (w.forecast || []).slice(0, 7).map(f => \`
    <div class="wx-day">
      <div class="d">\${f.day || '—'}</div>
      <div class="i">\${wxEmoji(f.code)}</div>
      <div class="t">\${Math.round(f.tmax)}° / \${Math.round(f.tmin)}°</div>
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
        <div class="wx-temp">\${Math.round(w.temp)}°</div>
        <div class="wx-detail">
          <div>體感 \${Math.round(w.feels)}° · 濕度 \${w.humidity ?? '—'}%</div>
          <div>風 \${windArrow}\${windDirLabel} \${w.wind ?? '—'} kt · UV \${w.uv ?? '—'}</div>
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

function renderFx(code, v) {
  if (!v) {
    return \`<div class="row"><div class="row-l"><div class="n">\${code}</div><div class="c">—</div></div><div class="row-r flat">—</div></div>\`;
  }
  return \`
    <div class="row">
      <div class="row-l">
        <div class="n">\${code}/TWD</div>
        <div class="c">現金賣出 \${fmtNum(v.cashSell, 4)}</div>
      </div>
      <div class="row-r">
        <div class="p">\${fmtNum(v.rate, 4)}</div>
        <div class="ch flat">即期</div>
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

// Settings modal
function showSet() {
  const wx = loadSetting('wx', DEFAULTS.wx);
  document.getElementById('set-wx').value = wx.map(w => \`\${w.name},\${w.lat},\${w.lon}\`).join('\\n');
  document.getElementById('set-tw').value = loadSetting('tw', DEFAULTS.tw).join(',');
  document.getElementById('set-us').value = loadSetting('us', DEFAULTS.us).join(',');
  document.getElementById('set-fx').value = loadSetting('fx', DEFAULTS.fx).join(',');
  document.getElementById('set-wrap').classList.add('show');
}
function hideSet() { document.getElementById('set-wrap').classList.remove('show'); }
function saveSettings() {
  const wxLines = document.getElementById('set-wx').value.trim().split(/\\n/).map(l => l.trim()).filter(Boolean);
  const wx = wxLines.map(line => {
    const [name, lat, lon] = line.split(',').map(s => s.trim());
    return { name, lat: parseFloat(lat), lon: parseFloat(lon) };
  }).filter(w => w.name && !isNaN(w.lat) && !isNaN(w.lon));
  if (wx.length > 0) saveSetting('wx', wx); else localStorage.removeItem(LS.wx);
  const parseList = v => v.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const tw = parseList(document.getElementById('set-tw').value);
  const us = parseList(document.getElementById('set-us').value);
  const fx = parseList(document.getElementById('set-fx').value);
  if (tw.length > 0) saveSetting('tw', tw); else localStorage.removeItem(LS.tw);
  if (us.length > 0) saveSetting('us', us); else localStorage.removeItem(LS.us);
  if (fx.length > 0) saveSetting('fx', fx); else localStorage.removeItem(LS.fx);
  hideSet();
  loadAndRender();
}
window.saveSettings = saveSettings;
window.hideSet = hideSet;

// Date picker (calendar view)
let _availableDates = new Set();
let _currentDisplayedDate = null;  // 目前顯示的那份 report 的日期
let _calMonth = null; // { year, month (0-indexed) }

async function showDate() {
  document.getElementById('date-wrap').classList.add('show');
  try {
    const r = await fetch('/api/morning-report/dates');
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

// Event bindings
document.getElementById('btn-refresh').addEventListener('click', () => loadAndRender());
document.getElementById('btn-set').addEventListener('click', showSet);
document.getElementById('btn-date').addEventListener('click', showDate);
document.getElementById('btn-theme').addEventListener('click', toggleTheme);
document.getElementById('btn-font-up').addEventListener('click', () => bumpFont(1));
document.getElementById('btn-font-dn').addEventListener('click', () => bumpFont(-1));
document.getElementById('cal-prev').addEventListener('click', () => calNav(-1));
document.getElementById('cal-next').addEventListener('click', () => calNav(1));

// Nav bar click → scroll to section
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-target');
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// Measure header height for sticky nav top offset
function updateHdrH() {
  const h = document.querySelector('.hdr');
  if (h) document.documentElement.style.setProperty('--hdr-h', h.offsetHeight + 'px');
}
updateHdrH();
window.addEventListener('resize', updateHdrH);

// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/morning/sw.js', { scope: '/morning/' }).catch(e => console.warn('SW register failed', e));
}

// Initial load
loadAndRender();
`;
}
