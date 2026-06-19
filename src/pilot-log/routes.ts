// Pilot Log v1 — REST API
// 路由前綴: /api/pilot-log
//
// Public:
//   POST   /api/pilot-log/auth/login          { idToken }   → { accessToken, refreshToken, ... }
//                                              + Set-Cookie: plrt (HttpOnly, Secure, 90d, path=/api/pilot-log/auth)
//   POST   /api/pilot-log/auth/refresh        cookie plrt OR { refreshToken } → 同上 (rotated, 新 cookie)
//   POST   /api/pilot-log/auth/logout         cookie plrt OR { refreshToken } → revoke + clear cookie
//
// Authed (Authorization: Bearer <accessToken>):
//   GET    /api/pilot-log/me
//   DELETE /api/pilot-log/account             (Apple 5.1.1(v) compliance — 永久刪除帳號 + CASCADE 全部資料)
//   GET    /api/pilot-log/entries?status=&from=&to=&limit=&offset=
//   GET    /api/pilot-log/entries/:id
//   POST   /api/pilot-log/entries             (manual entry)
//   PUT    /api/pilot-log/entries/:id         (edit / confirm draft)
//   DELETE /api/pilot-log/entries/:id
//   POST   /api/pilot-log/import/logten-flights      (text/plain body)
//   POST   /api/pilot-log/import/logten-aircraft         (text/plain body) — tail registry
//   POST   /api/pilot-log/import/logten-addressbook      (text/plain body) — V1.0.09 crew
//   POST   /api/pilot-log/import/logten-aircraft-types   (text/plain body) — V1.0.11 type catalog
//   GET    /api/pilot-log/aircraft-types                                    — V1.0.11
//   GET    /api/pilot-log/crew                                              — V1.0.11 crew list
//   GET    /api/pilot-log/aircraft
//   POST   /api/pilot-log/aircraft            (manual add，V1.0.10)
//   GET    /api/pilot-log/stats
//   GET    /api/pilot-log/quick-suggest        (常用 tail/type/airport/crew)

import express from 'express';
import { randomUUID } from 'crypto';
import {
  loginWithGoogle,
  rotateRefreshToken,
  revokeRefreshToken,
  requireAuth,
  verifyGoogleIdToken,
  AuthedRequest,
} from './auth.js';
import {
  getSlots, applyApplicant, listApplicants, addFriend, removeApplicant, isOwnerUserId,
} from './beta.js';
import { getPool, ensureTables, PILOT_LOG_TABLES, insertDbSizeSnapshotIfDue } from './schema.js';
import { importLogtenFlights, importLogtenAircraft } from './import-logten.js';
import { importWader } from './import-wader.js';
import { importLogatp } from './import-logatp.js';
import { importLogtenAddressBook } from './import-addressbook.js';
import { importLogtenAircraftTypes } from './import-aircraft-types.js';
import { renderCommunityLink } from '../app-changelog.js';
import { importRoster, upsertCrewContact } from './import-roster.js';
import { getTotals, getRollingTotals, getByAircraftType, getOpeningBalance, getSimTotals } from './stats.js';
import { tailLookup } from './tw-fleet.js';            // V2.3.07：duty-backfill 公司判斷（機尾範圍推）
import { normAirportKey } from './airport-codes.js';   // V2.3.07：duty 規則機場比對（IATA/ICAO 正規化）
import { CREW_SLOT_IDS, CREW_DISPLAY_MODES, type CrewDisplayMode } from './crew-slots.js';
import { loadCredentials } from '../config.js';
import { getSpaPilotLogJs } from '../spa/js-pilot-log.js';
import { getAirportDbJs } from '../spa/js-airport-db.js';

// ── 版本（比照 CrewSync / Morning：每次推版必更新；SW cache 名稱跟著走） ────
// 本機 preview build 會暫時加 -tNN 後綴方便對版；推正式版前拿掉只留乾淨版號。
export const PILOT_LOG_VERSION = 'V2.4.22';
const PILOT_LOG_CACHE = 'pilotlog-v2-4-22';

export const pilotLogRouter = express.Router();

// 接受最多 5MB 的純文字（LogTen 匯出檔，幾年的資料夠用）
pilotLogRouter.use('/api/pilot-log/import', express.text({ type: '*/*', limit: '5mb' }));

// ── Standalone page (/pilot-log) ─────────────────────────────────────────────
// 初期獨立於 main SPA，等核心 flow 都測穩再決定要不要整合到 tab bar。
// 永久保留此路由：深連結 / debug / 獨立測試用。
export function _renderPilotLogHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0e1a">
<link rel="manifest" href="/pilot-log/manifest.json">
<link rel="icon" href="/pilot-log/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/pilot-log/icon.svg">
<title>Pilot Log ${PILOT_LOG_VERSION}</title>
<style>
/* 夜間（預設）+ 日間主題：沿用 CrewSync / 晨報 的 data-theme + CSS var pattern。
   結構色全走 var()，狀態色（綠/琥珀/紅/藍）兩主題共用，淺色一樣讀得清楚。 */
:root {
  --bg: #0a0e1a;
  --card: #1a1f2e;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --border: #334155;
  --accent: #3b82f6;
  --input-bg: #0a0e1a;
  --bar-bg: rgba(255,255,255,.05);
  --bar-bg-soft: rgba(255,255,255,.03);
  --shadow: 0 -1px 0 var(--border);
}
[data-theme="light"] {
  --bg: #f1f5f9;
  --card: #ffffff;
  --text: #0f172a;
  --muted: #64748b;
  --border: #cbd5e1;
  --accent: #2563eb;
  --input-bg: #ffffff;
  --bar-bg: rgba(15,23,42,.05);
  --bar-bg-soft: rgba(15,23,42,.03);
  --shadow: 0 -1px 0 var(--border);
}
* { box-sizing: border-box; }
html { font-size: 15px; overscroll-behavior: none; }   /* V2.2.08：關掉視窗回彈（所有分頁）；body 也有，雙保險 */
/* 狀態列那塊鋪不透明底（同 CrewSync）：透明狀態列(Tools 入口/PWA)下，捲動內容才不會透到狀態列區。 */
html::before { content:''; position:fixed; top:0; left:0; right:0; height:env(safe-area-inset-top,0px); background:var(--bg); z-index:9999; pointer-events:none; }
body {
  margin: 0; padding: 0;
  background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 1rem;
  min-height: 100vh;
  padding-top: env(safe-area-inset-top);
  /* 讓出底部 tab bar 高度，內容不被擋住 */
  padding-bottom: calc(58px + env(safe-area-inset-bottom));
  overflow-x: hidden;            /* 擋橫滑（同 CrewSync / Morning 修法） */
  overscroll-behavior: none;
  transition: background .2s, color .2s;
}

/* ── 底部主功能列（對齊 CrewSync）─────────────────────────────────────────── */
.pl-tab-bar {
  position: fixed; bottom: 0; left: 0; right: 0;
  height: calc(56px + env(safe-area-inset-bottom));
  background: var(--card);
  border-top: 1px solid var(--border);
  display: flex; z-index: 200;
  padding-bottom: env(safe-area-inset-bottom);
  overflow-x: auto; overflow-y: hidden;
  -webkit-overflow-scrolling: touch; scrollbar-width: none;
}
.pl-tab-bar::-webkit-scrollbar { display: none; }
.pl-tab-btn {
  flex: 1 1 0; min-width: 64px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; border: none; background: none; color: var(--muted);
  font-size: .7em; font-weight: 600; cursor: pointer;
  transition: color .15s; -webkit-appearance: none; padding: 0 6px; white-space: nowrap;
}
.pl-tab-btn.pl-tab-active { color: var(--accent); }
.pl-tab-icon { font-size: 1.5em; line-height: 1; }
/* 功能鍵區：自然寬度（不吃 flex:1），靠右；三組之間留 18px 舒適間距、不致誤觸。
   主功能三顆 flex:1 會把這區推到最右，iPad 全寬時一樣貼右邊。 */
.pl-tab-util {
  flex: 0 0 auto; cursor: default;
  flex-direction: row; align-items: center; justify-content: flex-end;
  gap: 18px; padding: 0 12px 0 6px;
}
.pl-util-btn {
  background: none; border: none; color: var(--muted);
  font-size: 1.3em; line-height: 1; cursor: pointer; padding: 2px;
  -webkit-appearance: none;
}
.pl-font-wrap {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
}
.pl-font-btn {
  font-weight: 700; border: 1px solid var(--border); border-radius: 4px;
  background: none; color: var(--muted); cursor: pointer; -webkit-appearance: none;
  line-height: 1; padding: 2px 6px;
}
.pl-font-btn-lg { font-size: .95em; }
.pl-font-btn-sm { font-size: .68em; }
.pl-ver-tag {
  font-size: .82em; color: var(--muted); opacity: .8;
  cursor: pointer; text-decoration: underline; line-height: 1;
}

/* ── Logbook 分割視窗（向 LogTen Pro iPad 看齊）─────────────────────────────
   寬螢幕(>=768px)：左列表 + 右明細並排，右側 sticky+獨立 scroll；
   窄螢幕(iPhone)：detail-pane 藏起來，點一筆走 _plOpenEditor 全螢幕（維持原行為）。*/
.pl-split { display: flex; flex-direction: column; gap: 10px; }
.pl-list-pane { min-width: 0; }
.pl-detail-pane { min-width: 0; }
@media (min-width: 768px) {
  .pl-split { flex-direction: row; align-items: flex-start; gap: 14px; }
  .pl-list-pane { flex: 1 1 0; }
  .pl-detail-pane {
    flex: 1.25 1 0;
    /* #7：列表頂部現在 sticky，編輯器要黏在「標題高度之下」才不會被蓋住、捲不到最上面 */
    /* V2.4.11：工具列 .pl-topstack sticky 在 env(safe-area-inset-top)，所以面板 top 必須也含 safe-area —— */
    /*   否則捲動後面板黏的位置比工具列實際底部高了一個 safe-area，標題鑽到工具列後面拉不回來（iPad 實測）。 */
    position: sticky; top: calc(env(safe-area-inset-top) + var(--pl-head-h, 0px) + 8px);
    /* top 往下移了多少，max-height 就扣多少，否則底部超出視窗被切掉（codex P2） */
    max-height: calc(100dvh - 84px - env(safe-area-inset-top) - var(--pl-head-h, 0px) - env(safe-area-inset-bottom));
    overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: none;
    background: var(--card); border-radius: 12px;
    border: 1px solid var(--border);
  }
}
@media (max-width: 767px) {
  .pl-detail-pane { display: none; }
}
.pl-detail-empty {
  color: var(--muted); text-align: center;
  padding: 60px 20px; font-size: .85em; line-height: 1.6;
}
/* Logbook 列被選中時的外框（只 iPad 看得到，因為窄螢幕點下去直接全螢幕，沒有 highlight 需求） */
.pl-row { transition: outline-color .12s; outline: 2px solid transparent; outline-offset: -2px; }
.pl-row.pl-row-sel { outline-color: var(--accent); }
/* V2.4.12：同步中連線圖示的轉圈動畫 */
@keyframes pl-spin { to { transform: rotate(360deg); } }
.pl-spin { display: inline-block; animation: pl-spin 1s linear infinite; }

/* About modal — 比照 Morning，加 overflow-x:hidden + overflow-wrap:break-word */
.pl-modal-wrap {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,.7); z-index: 300;
  align-items: center; justify-content: center;
  padding: 20px;
}
.pl-modal-wrap.show { display: flex; }
.pl-modal {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 14px; padding: 18px;
  max-width: 420px; width: 100%;
  max-height: 80vh; overflow-y: auto; overflow-x: hidden;
  overflow-wrap: break-word;
  -webkit-overflow-scrolling: touch;
}
.pl-modal h3 { margin: 0 0 10px; font-size: 1.05em; }
.pl-modal .close {
  float: right; background: none; border: none;
  color: var(--muted); font-size: 1.3em; cursor: pointer;
}
.pl-cl-v {
  font-size: .82em; font-weight: 700;
  margin-top: 12px; margin-bottom: 4px;
  color: var(--accent);
}
.pl-cl-v.old { color: var(--muted); }
.pl-cl-txt {
  font-size: .76em; color: var(--muted);
  line-height: 1.6; margin-bottom: 8px;
}

@media print {
  .pl-tab-bar, .pl-modal-wrap, .pl-offline-bar { display: none !important; }
  body { padding-bottom: 0; }
}

/* V1.2：頂部 OFFLINE 提示條（網路掛掉、使用 IDB 快取資料時顯示） */
.pl-offline-bar {
  display: none; position: fixed;
  top: env(safe-area-inset-top);
  left: 0; right: 0; z-index: 250;
  background: #f59e0b; color: #1a1f2e;
  font-size: .68em; font-weight: 700; text-align: center;
  padding: 5px 12px; line-height: 1.35;
  letter-spacing: .2px;
}
.pl-offline-bar.show { display: block; }
body.pl-offline { padding-top: calc(env(safe-area-inset-top) + var(--pl-banner-h, 28px)); }
/* V2.2.08：各分頁頂部固定（option B）。包住每頁標題列；負 margin 把背景拉到該頁外層 padding(10px 14px)
   的邊緣，sticky 時整條背景滿版、不透出底下捲動的內容。各頁外層 padding 一致為 10px 14px。 */
.pl-stickhead { position: sticky; top: env(safe-area-inset-top); z-index: 40; background: var(--bg);
                margin: -10px -14px 8px; padding: 10px 14px 8px;
                will-change: transform; -webkit-backface-visibility: hidden; }   /* iOS：放獨立合成層，捲動時 sticky 不消失/被內容蓋住 */
/* 寬版 Airports 三欄：鎖 body 不捲(只在這頁,靠 #pl-apt-listcol 存在判斷),避免右欄空白拖動外溢把頁首頂上去；三欄各自內捲 */
body:has(#pl-apt-listcol) { overflow: hidden; height: 100dvh; }
/* 離線時頂部固定工具列要黏在 OFFLINE 橫幅「下方」，否則橫幅(z-250)會蓋住按鈕。
   --pl-banner-h 由 JS 量實際橫幅高度（窄螢幕/大字會換行變更高，不能寫死 28px）。!important 蓋過 inline/class top:0。 */
body.pl-offline .pl-topstack, body.pl-offline .pl-stickhead { top: calc(env(safe-area-inset-top) + var(--pl-banner-h, 28px)) !important; }
/* 沉浸式地圖 #pl-map-full 是 inline style top:0（外部 CSS 蓋不過 inline）→ 離線時由 JS
   _plApplyOfflineMapShift() 直接設 inline top，依實際 OFFLINE 橫幅高度把地圖+控制項一起下移讓開。 */
</style>
<script>
/* 早期套用主題 + 字級，避免 FOUC（在 content render 前先讀 localStorage） */
(function(){
  try {
    if (localStorage.getItem('pilotlog_theme') === 'light') {
      document.documentElement.dataset.theme = 'light';
    }
    var s = parseInt(localStorage.getItem('pilotlog_font_scale'), 10);
    if (s >= -2 && s <= 17 && s !== 0) {
      document.documentElement.style.fontSize = (100 + s * 8) + '%';
    }
  } catch(e){}
})();
</script>
</head>
<body>
<div id="pl-offline-bar" class="pl-offline-bar">📡 OFFLINE — 顯示上次快取的資料 · Showing last cached data</div>
<main>
  <div id="pilotlog-content"></div>
</main>

<!-- ══ 底部主功能列（Analyze / Logbook / Report + 功能鍵）══════════════════ -->
<div class="pl-tab-bar" id="pl-tab-bar">
  <button class="pl-tab-btn" id="plTabBtn-analyze" onclick="switchPlTab('analyze',this)">
    <span class="pl-tab-icon">📊</span>Analyze
  </button>
  <button class="pl-tab-btn pl-tab-active" id="plTabBtn-logbook" onclick="switchPlTab('logbook',this)">
    <span class="pl-tab-icon">📒</span>Logbook
  </button>
  <button class="pl-tab-btn" id="plTabBtn-map" onclick="switchPlTab('map',this)">
    <span class="pl-tab-icon">🗺️</span>Map
  </button>
  <button class="pl-tab-btn" id="plTabBtn-report" onclick="switchPlTab('report',this)">
    <span class="pl-tab-icon">📄</span>Report
  </button>
  <a href="/apps" id="cs-apps-home" class="pl-util-btn" aria-label="Tools" title="回 Tools" style="display:none;flex:0 0 auto;align-self:center;text-decoration:none;padding:0 8px"><svg width="20" height="20" viewBox="0 0 24 24"><rect x="2" y="2" width="9" height="9" rx="2.5" fill="#3b82f6"/><rect x="13" y="2" width="9" height="9" rx="2.5" fill="#10b981"/><rect x="2" y="13" width="9" height="9" rx="2.5" fill="#f59e0b"/><rect x="13" y="13" width="9" height="9" rx="2.5" fill="#a855f7"/></svg></a>
  <div class="pl-tab-btn pl-tab-util">
    <button class="pl-util-btn" id="pl-theme-btn" onclick="_plToggleTheme()"><span id="pl-theme-icon">☀️</span></button>
    <div class="pl-font-wrap">
      <button class="pl-font-btn pl-font-btn-lg" onclick="_plAdjustFontSize(1)">A+</button>
      <button class="pl-font-btn pl-font-btn-sm" onclick="_plAdjustFontSize(-1)">A-</button>
    </div>
    <span class="pl-ver-tag" onclick="plShowAbout()">${PILOT_LOG_VERSION}</span>
  </div>
</div>
<!-- ⊞ 回 Apps：只在「從 /apps 入口進來 + 裝成 PWA」時顯示 -->
<script>(function(){try{var s=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone;if(s&&localStorage.getItem('cs_via_apps')==='1'){var b=document.getElementById('cs-apps-home');if(b)b.style.display='inline-flex';}}catch(e){}})();</script>

<!-- About modal — 點底部版號開啟 -->
<div class="pl-modal-wrap" id="pl-about-wrap" onclick="if(event.target===this)plHideAbout()">
  <div class="pl-modal">
    <button class="close" onclick="plHideAbout()">✕</button>
    <h3>📒 Pilot Log</h3>
    <div style="font-size:.8em;color:var(--muted);margin-bottom:10px">
      飛行記錄本，跨裝置、永久保存、絕不過期<br>
      Pilot logbook — cross-device, permanent storage, never expires
    </div>
    <div style="font-size:.75em;color:var(--muted);line-height:1.6">
      ${'認證 Auth — Google sign-in (JWT 1h + refresh 90d)<br>儲存 Storage — PostgreSQL (cross-device sync)<br>匯入 Import — LogTen Pro 6 dynamic Tab + Aircraft (UTF-8)'}
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:12px 0">
    ${_renderPilotLogChangelog()}
    <hr style="border:none;border-top:1px solid var(--border);margin:14px 0 10px">
    <!-- Danger Zone: Apple App Store 5.1.1(v) compliance — in-app account delete -->
    <div style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);border-radius:8px;padding:12px">
      <div style="font-weight:700;color:#ef4444;font-size:.82em;margin-bottom:6px">⚠️ Danger Zone</div>
      <div style="font-size:.7em;color:var(--muted);line-height:1.5;margin-bottom:8px">
        永久刪除帳號與全部飛行記錄、機尾資料、會話。此動作無法復原。<br>
        Permanently delete account, all flight records, aircraft data, and sessions. This cannot be undone.
      </div>
      <button onclick="_plDeleteAccount()" style="background:#dc2626;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.76em;font-weight:700;cursor:pointer">🗑️ Delete Account</button>
    </div>
  </div>
</div>

<script>
function plShowAbout(){ document.getElementById('pl-about-wrap').classList.add('show'); }
function plHideAbout(){ document.getElementById('pl-about-wrap').classList.remove('show'); }

// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/pilot-log/sw.js', { scope: '/pilot-log' }).catch(function(){});
}

window._PL_VER = '${PILOT_LOG_VERSION}';   // V1.3.38：給 airport-db.js 做版本化網址用（避免 7 天快取卡舊資料）
${getSpaPilotLogJs()}

document.addEventListener('DOMContentLoaded', function(){ pilotLogInit(); });
if (document.readyState !== 'loading') pilotLogInit();
</script>
</body>
</html>`;
}

// ── Changelog（中英對照、新版疊加在最上、舊版全部保留）─────────────────────
// 規則同 CrewSync / Morning：每次推版必更新內容，舊版不刪。
function _renderPilotLogChangelog(): string {
  return `
    ${renderCommunityLink()}
    <div class="pl-cl-v">${PILOT_LOG_VERSION}</div>
    <div class="pl-cl-txt">
      <b>📕 調整 logbook PDF 排版。</b><br>
      <b>📕 Adjusted logbook PDF layout.</b>
    </div>
    <div class="pl-cl-v old">V2.4.21</div>
    <div class="pl-cl-txt">
      <b>📕 調整 logbook PDF 排版。</b><br>
      <b>📕 Adjusted logbook PDF layout.</b>
    </div>
    <div class="pl-cl-v old">V2.4.20</div>
    <div class="pl-cl-txt">
      <b>📕 調整 logbook PDF 排版。</b><br>
      <b>📕 Adjusted logbook PDF layout.</b>
    </div>
    <div class="pl-cl-v old">V2.4.19</div>
    <div class="pl-cl-txt">
      <b>📕 調整 logbook PDF 排版。</b><br>
      <b>📕 Adjusted logbook PDF layout.</b>
    </div>
    <div class="pl-cl-v old">V2.4.18</div>
    <div class="pl-cl-txt">
      <b>🔧 編輯器標題列重整：釘在頂端、動作收進 ⋯ 選單（新增 Next Leg、Duplicate）。</b><br>
      <b>🔧 Editor header revamped: pinned to top, actions in a ⋯ menu (added Next Leg & Duplicate).</b>
    </div>
    <div class="pl-cl-v old">V2.4.17</div>
    <div class="pl-cl-txt">
      <b>🐛 修正畫面顯示。</b><br>
      <b>🐛 Display fix.</b>
    </div>
    <div class="pl-cl-v old">V2.4.16</div>
    <div class="pl-cl-txt">
      <b>🔧 重新排版、改進快取、提升使用體驗。</b><br>
      <b>🔧 Re-laid out, improved caching, smoother experience.</b>
    </div>
    <div class="pl-cl-v old">V2.4.15</div>
    <div class="pl-cl-txt">
      <b>⏱️ Analyze 新增 Currency：90 天起飛/落地 recency（最近 3 次 + 到期日），可展開日/夜，點開看是哪幾班。</b><br>
      <b>⏱️ New Currency in Analyze: 90-day takeoff/landing recency (last 3 + expiry), expandable day/night, tap to see the flights.</b>
    </div>
    <div class="pl-cl-v old">V2.4.14</div>
    <div class="pl-cl-txt">
      <b>✍️ 改成 LogTen 式自動儲存：拿掉 Save 鈕，編輯就存、關閉時自動存檔。</b><br>
      <b>✍️ LogTen-style auto-save: Save button removed — edits save as you type and when you close.</b>
    </div>
    <div class="pl-cl-v old">V2.4.13</div>
    <div class="pl-cl-txt">
      <b>🧹 精簡歷史更新摘要（每版一句），載入更快。</b><br>
      <b>🧹 Condensed past changelog entries (one line each) for faster loading.</b>
    </div>
    <div class="pl-cl-v old">V2.4.12</div>
    <div class="pl-cl-txt">
      <b>🔌 新增連線狀態圖示（可點手動同步），On Duty／Off Duty 補當地時間。</b><br>
      <b>🔌 New connection-status icon (tap to sync); On Duty / Off Duty now show local time.</b>
    </div>
    <div class="pl-cl-v old">V2.4.11</div>
    <div class="pl-cl-txt">
      <b>🛠️ iPad 編輯器標題定位真正修好（補 safe-area），捲動後不再卡工具列後面。</b><br>
      <b>🛠️ iPad editor header positioning properly fixed (safe-area) — no longer hidden behind the toolbar after scrolling.</b>
    </div>
    <div class="pl-cl-v old">V2.4.10</div>
    <div class="pl-cl-txt">
      <b>🛠️ iPad：編輯器標題改面板內 sticky 釘住。</b><br>
      <b>🛠️ iPad: editor header pinned within the detail pane.</b>
    </div>
    <div class="pl-cl-v old">V2.4.09</div>
    <div class="pl-cl-txt">
      <b>🕒 SIM／地面勤務的 Schedule 也顯示當地時間（TPE）。</b><br>
      <b>🕒 SIM / ground-duty schedule times now show local time (TPE) too.</b>
    </div>
    <div class="pl-cl-v old">V2.4.08</div>
    <div class="pl-cl-txt">
      <b>🖥️ 班表可選擇帶入模擬機／地面勤務，SIM 自動帶報到與時數，待命永不匯。</b><br>
      <b>🖥️ Roster import can now include simulator / ground duties — SIM auto-fills report time and hours; standby is never imported.</b>
    </div>
    <div class="pl-cl-v old">V2.4.07</div>
    <div class="pl-cl-txt">
      <b>✨ 重匯班表邏輯改進。</b><br>
      <b>✨ Roster re-import logic improved.</b>
    </div>
    <div class="pl-cl-v old">V2.4.06</div>
    <div class="pl-cl-txt">
      <b>✨ 組員拖拉介面微調，更直覺。</b><br>
      <b>✨ Crew drag-reorder UI refinement.</b>
    </div>
    <div class="pl-cl-v old">V2.4.05</div>
    <div class="pl-cl-txt">
      <b>✨ 組員操作優化：可拖拉換位、搜尋更聰明、一鍵從航班重建通訊錄。</b><br>
      <b>✨ Crew workflow improvements: drag to reorder, smarter search, one-tap address-book rebuild.</b>
    </div>
    <div class="pl-cl-v old">V2.4.04</div>
    <div class="pl-cl-txt">
      <b>✨ 操作優化：組員輸入更順手、可一鍵建回程與對調 PIC/SIC。</b><br>
      <b>✨ Workflow improvements: smoother crew entry, one-tap return flight & PIC/SIC swap.</b>
    </div>
    <div class="pl-cl-v old">V2.4.03</div>
    <div class="pl-cl-txt">
      <b>⏱️ 新增 FDP Duty 上限：依操作飛行員人數顯示「Limit HHMM」、超時轉紅，當天來回自動串成一段計算。</b><br>
      <b>⏱️ New FDP duty limit: shows "Limit HHMM" based on operating pilots (turns red if exceeded); same-day turnarounds are treated as one duty.</b>
    </div>
    <div class="pl-cl-v old">V2.4.02</div>
    <div class="pl-cl-txt">
      <b>🛠️ 修正 Logbook PDF 含中文時產不出來的問題。</b><br>
      <b>🛠️ Fixed Logbook PDF failing to generate when it contains Chinese.</b>
    </div>
    <div class="pl-cl-v old">V2.4.01</div>
    <div class="pl-cl-txt">
      <b>📕 新增 Logbook PDF 產出：可選地區格式（通用／EASA／FAA／ICAO），支援中文真文字。</b><br>
      <b>📕 New Logbook PDF export — pick a regional format (Generic / EASA / FAA / ICAO), with real selectable Chinese text.</b>
    </div>
    <div class="pl-cl-v old">V2.3.07</div>
    <div class="pl-cl-txt">
      <b>⏰ 新增報到時間規則：On Duty 自動帶 STD − N 分（依公司×機場），可一鍵回填舊航班。</b><br>
      <b>⏰ Report-time rules: On Duty auto-fills as STD − N min by company × airport, with one-tap backfill for past flights.</b>
    </div>
    <div class="pl-cl-v old">V2.3.06</div>
    <div class="pl-cl-txt">
      <b>🔎 「—」未知機型群組可點開補資料，沒機尾的航班改用班號字頭歸公司。</b><br>
      <b>🔎 The "—" unknown-type group is now tappable to fix data; tail-less flights fall back to flight-number prefix for company grouping.</b>
    </div>
    <div class="pl-cl-v old">V2.3.05</div>
    <div class="pl-cl-txt">
      <b>🛠️ 修班表殘餘重複、Total Duty 預設 0 拿掉讓自動計算生效、客艙組員改預設收合。</b><br>
      <b>🛠️ Fixed leftover roster duplicates, removed Total Duty's default 0 so auto-calc works, cabin crew now collapsed by default.</b>
    </div>
    <div class="pl-cl-v old">V2.3.04</div>
    <div class="pl-cl-txt">
      <b>🛠️ 修班表匯入重複建檔（重匯自動合併）、空服員帶入、Duty Time 自動計算與 iPad 排版。</b><br>
      <b>🛠️ Fixed duplicate flights on roster import (re-import auto-merges), cabin crew fill-in, duty-time auto-calc, and iPad layout.</b>
    </div>
    <div class="pl-cl-v old">V2.3.03</div>
    <div class="pl-cl-txt">
      <b>🏷️ Analyze 公司歸類更準：認得長榮退役機隊，機尾有無「-」都通。</b><br>
      <b>🏷️ Analyze company grouping improved: EVA retired fleets recognized, tails match with or without the dash.</b>
    </div>
    <div class="pl-cl-v old">V2.3.02</div>
    <div class="pl-cl-txt">
      <b>🗑️ 新增「勾選刪除」：多選航班一次刪（鎖定的會跳過）。</b><br>
      <b>🗑️ Added multi-select delete in the logbook — check flights and delete in one go (locked ones skipped).</b>
    </div>
    <div class="pl-cl-v old">V2.3.01</div>
    <div class="pl-cl-txt">
      <b>🛠️ 修正匯入大檔被 8 秒逾時中斷與間歇 500：逾時放寬到 2 分鐘並防重複按。</b><br>
      <b>🛠️ Fixed large imports aborting at the 8s timeout and intermittent 500s — raised timeout to 2 min and blocked double-tap.</b>
    </div>
    <div class="pl-cl-v old">V2.3.0</div>
    <div class="pl-cl-txt">
      <b>🧑‍✈️ 組員大升級（飛航組加 Relief／Observer、客艙最多 20 格、欄位可自訂），並修好沒帶班號不計時數。</b><br>
      <b>🧑‍✈️ Crew upgrade (Relief/Observer, up to 20 cabin slots, renameable labels); fixed flights without a flight number not counting toward hours.</b>
    </div>
    <div class="pl-cl-v old">V2.2.27</div>
    <div class="pl-cl-txt">
      <b>📥 匯入解析失敗的航班不再丟棄，改收成「待補強」讓你補完後自動轉已完成。</b><br>
      <b>📥 Import: flights that fail to parse are no longer dropped — kept as "needs-completion" entries to finish, then auto-marked done.</b>
    </div>
    <div class="pl-cl-v old">V2.2.26</div>
    <div class="pl-cl-txt">
      <b>🗺️ 機場詳情頁 All / Dep / Arr 改成釘在頂部固定。</b><br>
      <b>🗺️ Airport detail: All / Dep / Arr now pinned at the top.</b>
    </div>
    <div class="pl-cl-v old">V2.2.25</div>
    <div class="pl-cl-txt">
      <b>🔧 修正 iOS 離線：/pilot-log 啟動頁改用可離線快取的標頭。</b><br>
      <b>🔧 iOS offline fix: the /pilot-log launch page now uses an offline-cacheable header.</b>
    </div>
    <div class="pl-cl-v old">V2.2.24</div>
    <div class="pl-cl-txt">
      <b>📄 Log ATP 2 匯入支援 Realm system data 原始格式，跨 UTC 午夜時間正確。</b><br>
      <b>📄 Log ATP 2 import now supports the raw Realm system-data export, with times correct across UTC midnight.</b>
    </div>
    <div class="pl-cl-v old">V2.2.23</div>
    <div class="pl-cl-txt">
      <b>🔄 Airports 轉向自動重排，iPad 直橫拿都不卡欄。</b><br>
      <b>🔄 Airports now re-lays out on rotation — switches between 3-column and single-column.</b>
    </div>
    <div class="pl-cl-v old">V2.2.22</div>
    <div class="pl-cl-txt">
      <b>🗺️ Airports 手機／iPad 直拿改版：點機場看資訊、點進去看航班，不用一直滑。</b><br>
      <b>🗺️ Airports redesign (phone / iPad portrait) — tap an airport for info, tap in for its flights.</b>
    </div>
    <div class="pl-cl-v old">V2.2.21</div>
    <div class="pl-cl-txt">
      <b>🗺️ 「Pick from fleet」頂部標題列釘住，捲動時不再被推走。</b><br>
      <b>🗺️ Pick-from-fleet: the header now stays pinned while you scroll the fleet list.</b>
    </div>
    <div class="pl-cl-v old">V2.2.20</div>
    <div class="pl-cl-txt">
      <b>🗺️ Airports 右欄 All / Dep / Arr 篩選列釘在欄頂。</b><br>
      <b>🗺️ Airports: the All / Dep / Arr filter bar now stays pinned while you scroll.</b>
    </div>
    <div class="pl-cl-v old">V2.2.19</div>
    <div class="pl-cl-txt">
      <b>🗺️ Airports 捲動不再頂走頁首、保留列表位置，並補回金邊舊機場 VDPP。</b><br>
      <b>🗺️ Airports: scrolling no longer pushes the header, keeps list position, and restored old Phnom Penh (VDPP).</b>
    </div>
    <div class="pl-cl-v old">V2.2.18</div>
    <div class="pl-cl-txt">
      <b>🩹 Analyze iPad 左右捲動這次真的修好，標題不再蓋住內容（手機不動）。</b><br>
      <b>🩹 Analyze iPad scroll actually fixed now — header no longer overlaps content (phone untouched).</b>
    </div>
    <div class="pl-cl-v old">V2.2.17</div>
    <div class="pl-cl-txt">
      <b>🩹 Analyze iPad 捲動修正（未生效，見 V2.2.18）＋ ATIS 改瀏覽器端抓。</b><br>
      <b>🩹 Analyze iPad scroll fix (didn't take effect, see V2.2.18) + ATIS moved to browser-side fetch.</b>
    </div>
    <div class="pl-cl-v old">V2.2.14</div>
    <div class="pl-cl-txt">
      <b>🩹 修 Tools 入口下的頂部顯示與安全區，並改網路優先一次重開就更新。</b><br>
      <b>🩹 Fixed top rendering and safe-area under the Tools hub; the app is now network-first so it updates on first reopen.</b>
    </div>
    <div class="pl-cl-v old">V2.2.10</div>
    <div class="pl-cl-txt">
      <b>🩹 年份索引再修：不再戳進搜尋框、年份多也不爆螢幕、離線工具列黏在橫幅下方。</b><br>
      <b>🩹 More year-index fixes: no longer pokes the search box, won't overflow with many years, and offline toolbar sticks below the banner.</b>
    </div>
    <div class="pl-cl-v old">V2.2.09</div>
    <div class="pl-cl-txt">
      <b>🩹 修 V2.2.08 版面回歸（年份索引只在記錄本顯示）＋ 🗺️ 地圖標籤改用機場代碼。</b><br>
      <b>🩹 Fixed V2.2.08 layout regressions (year index on the logbook list only) + 🗺️ airport-code map labels.</b>
    </div>
    <div class="pl-cl-v old">V2.2.08</div>
    <div class="pl-cl-txt">
      <b>🧭 記錄本新增可滑年份索引、各分頁上方固定，離線更穩（地圖快取秒開）。</b><br>
      <b>🧭 New slidable year index, fixed page tops, and sturdier offline (maps open instantly from cache).</b>
    </div>
    <div class="pl-cl-v old">V2.2.07</div>
    <div class="pl-cl-txt">
      <b>🐛 修大 bug：記錄本現在會載入「全部」航班（原本只載最近 200 筆）。</b><br>
      <b>🐛 Big fix: the logbook now loads ALL flights (it used to load only the latest 200).</b>
    </div>
    <div class="pl-cl-v old">V2.2.06</div>
    <div class="pl-cl-txt">
      <b>🛬 Dep/Arr 跑道也換成自訂下拉，候選自動跟著機場、打字即時篩。</b><br>
      <b>🛬 Dep/Arr runways now use the same reliable dropdown — options follow the airport, type to filter.</b>
    </div>
    <div class="pl-cl-v old">V2.2.05</div>
    <div class="pl-cl-txt">
      <b>✏️ 編輯器小修：日期欄改純數字、From/To 機場下拉更穩。</b><br>
      <b>✏️ Editor fixes: date shows plain numeric; From/To airport dropdown is more reliable.</b>
    </div>
    <div class="pl-cl-v old">V2.2.04</div>
    <div class="pl-cl-txt">
      <b>🌍 3D 地球夜晚不再模糊，動態航跡一律從台灣飛出去。</b><br>
      <b>🌍 Sharper night view on 3D Earth, and animated routes now depart from the Taiwan end.</b>
    </div>
    <div class="pl-cl-v old">V2.2.03</div>
    <div class="pl-cl-txt">
      <b>🗺️ 地圖體驗修正：控制項穩定浮在最上層、日期區間移到右上並加快捷。</b><br>
      <b>🗺️ Map UX fixes: controls stay reliably on top, date-range moved to the top-right with quick shortcuts.</b>
    </div>
    <div class="pl-cl-v old">V2.2.02</div>
    <div class="pl-cl-txt">
      <b>🌍 3D 地球大升級（Cesium 衛星＋真實日夜光照）＋沉浸式全版地圖。</b><br>
      <b>🌍 3D Earth upgrade (Cesium satellite tiles + real day/night lighting) + a full-screen immersive map.</b>
    </div>
    <div class="pl-cl-v old">V2.2.01</div>
    <div class="pl-cl-txt">
      <b>🗺️ 全新「Map」分頁把飛過的航線畫在 2D 衛星與 3D 地球上，並把刪除帳號分離防誤觸。</b><br>
      <b>🗺️ New "Map" tab plots your routes on a 2D satellite map and 3D globe; delete-account separated to prevent mistaps.</b>
    </div>
    <div class="pl-cl-v old">V2.1.09</div>
    <div class="pl-cl-txt">
      <b>🆕 新增 Log ATP 2 匯入、記錄本搜尋框，手機 CREW 改一列一個。</b><br>
      <b>🆕 Added Log ATP 2 import, a logbook search box, and one-per-row crew fields on phones.</b>
    </div>
    <div class="pl-cl-v old">V2.1.08</div>
    <div class="pl-cl-txt">
      <b>新增帳號選單與會員身分，登入說明強調只取得 email、不讀信箱／雲端／通訊錄。</b><br>
      <b>Account menu + membership; the sign-in note stresses we only get your email, never your inbox, Drive or contacts.</b>
    </div>
    <div class="pl-cl-v old">V2.1.07</div>
    <div class="pl-cl-txt">
      <b>後台小修正，介面不變。</b><br>
      <b>Minor backend fix; nothing changes in how you use the app.</b>
    </div>
    <div class="pl-cl-v old">V2.1.06</div>
    <div class="pl-cl-txt">
      <b>後台小修正，介面不變。</b><br>
      <b>Minor backend fix; nothing changes in how you use the app.</b>
    </div>
    <div class="pl-cl-v old">V2.1.05</div>
    <div class="pl-cl-txt">
      <b>後台維護與安全性強化，介面不變。</b><br>
      <b>Backend maintenance & security hardening; nothing changes in how you use the app.</b>
    </div>
    <div class="pl-cl-v old">V2.1.04</div>
    <div class="pl-cl-txt">
      <b>修正跑道圖對不準：範圍長寬比改成直接等於圖檔，跑道線回到貼齊衛星圖。</b><br>
      <b>Fixed runway-overlay misalignment — the map extent ratio now matches the image so runway lines line up again.</b>
    </div>
    <div class="pl-cl-v old">V2.1.03</div>
    <div class="pl-cl-txt">
      <b>桌面點 Date 任意位置就跳日曆，重匯班表時改飛別班的舊航班直接刪掉。</b><br>
      <b>Clicking anywhere in the Date field opens the calendar; re-importing now deletes old draft flights that were reassigned.</b>
    </div>
    <div class="pl-cl-v old">V2.1.02</div>
    <div class="pl-cl-txt">
      <b>日期欄改可點日曆、From/To 加星宇航點下拉，跑道圖風分量不再重疊。</b><br>
      <b>Date field is now a native picker, From/To gain a Starlux airport dropdown, and runway wind components no longer overlap.</b>
    </div>
    <div class="pl-cl-v old">V2.1.01</div>
    <div class="pl-cl-txt">
      <b>跑道圖大進化：跑道畫在衛星圖上並依即時風向標色，flight detail 一鍵看起降兩地天氣。</b><br>
      <b>Runway maps leveled up — runways drawn on satellite imagery, wind-coloured ends, and one-tap departure/arrival weather in flight detail.</b>
    </div>
    <div class="pl-cl-v old">V2.0.03</div>
    <div class="pl-cl-txt">
      <b>✈️ 37 個星宇航點的衛星地圖預先抓進手機永久快取，飛機上離線也看得到。</b><br>
      <b>Offline satellite maps for the 37 Starlux airports — prefetched into a persistent cache so they stay viewable in-flight.</b>
    </div>
    <div class="pl-cl-v old">V2.0.02</div>
    <div class="pl-cl-txt">
      <b>班表匯入查重防呆（同日同班同起降已飛就略過）＋ ⭐ 星宇航點列出全部 37 個定期航點。</b><br>
      <b>Roster import dedup guard (skips already-flown same date/flight/route) + ⭐ Starlux airports lists all 37 scheduled destinations.</b>
    </div>
    <div class="pl-cl-v old">V2.0.01</div>
    <div class="pl-cl-txt">
      <b>🗺️ Places 改名 Airports 並重做成 LogTen 風格機場資訊中心（資訊／衛星地圖／筆記）。</b><br>
      <b>🗺️ Places renamed Airports and rebuilt LogTen-style into a full airport hub (details / satellite map / notes).</b>
    </div>
    <div class="pl-cl-v old">V1.3.38</div>
    <div class="pl-cl-txt">
      <b>修好跑道下拉（快取卡舊資料改版本化網址）＋機場詳情補時區／座標／海拔／跑道。</b><br>
      <b>Fixed the empty runway dropdown (stale cache → versioned URL) + airport detail now shows timezone / coordinates / elevation / runways.</b>
    </div>
    <div class="pl-cl-v old">V1.3.37</div>
    <div class="pl-cl-txt">
      <b>Dep/Arr 跑道改下拉、修組員列表最後一位重複、匯入一律自動帶組員、機場代碼自動大寫。</b><br>
      <b>Dep/Arr runway dropdowns, fixed the duplicated last crew member in lists, import always fills crew, and airport codes auto-uppercase.</b>
    </div>
    <div class="pl-cl-v old">V1.3.36</div>
    <div class="pl-cl-txt">
      <b>飛行明細加跑道與 POB、新增依機場查航班的 Places，內建約 4,200 個全球機場庫。</b><br>
      <b>Flight detail gains runways + POB, a new Places to view flights by airport, and a built-in ~4,200 global airport database.</b>
    </div>
    <div class="pl-cl-v old">V1.3.35</div>
    <div class="pl-cl-txt">
      <b>內建台灣六家航司現役機隊，✈️ Aircraft 頁點一架就加進機尾庫。</b><br>
      <b>Built-in current fleets of Taiwan's six carriers — tap a tail on the Aircraft page to add it to your registry.</b>
    </div>
    <div class="pl-cl-v old">V1.3.34</div>
    <div class="pl-cl-txt">
      <b>拿掉「已移除」篩選與 Report 多餘字樣，介面更乾淨。</b><br>
      <b>Removed the "Removed" filter and a redundant Report label for a cleaner interface.</b>
    </div>
    <div class="pl-cl-v old">V1.3.33</div>
    <div class="pl-cl-txt">
      <b>匯出集中到 Report 頁，並加「全鎖／全開」一鍵上鎖全部航班防誤改。</b><br>
      <b>Exports centralized on the Report page, plus one-click Lock-all / Unlock-all to protect every flight from accidental edits.</b>
    </div>
    <div class="pl-cl-v old">V1.3.32</div>
    <div class="pl-cl-txt">
      <b>可以匯出通訊錄／機尾庫／機型目錄了（UTF-8 CSV，Excel 直接開）。</b><br>
      <b>You can now export your address book / aircraft / aircraft types (UTF-8 CSV, opens in Excel).</b>
    </div>
    <div class="pl-cl-v old">V1.3.31</div>
    <div class="pl-cl-txt">
      <b>iPhone 版面整理：Logbook 工具列分動作／篩選兩列，Report 日期區間不再黏在一起。</b><br>
      <b>iPhone layout tidy-up: the Logbook toolbar splits into action / filter rows, and the Report date range no longer overlaps.</b>
    </div>
    <div class="pl-cl-v old">V1.3.30</div>
    <div class="pl-cl-txt">
      <b>Analyze 右欄補上更多明細卡（日夜起降、autoland、距離、approach、Pax、Duty）。</b><br>
      <b>Analyze gains a detail card (day/night takeoffs & landings, autolands, distance, approaches, pax, duty).</b>
    </div>
    <div class="pl-cl-v old">V1.3.29</div>
    <div class="pl-cl-txt">
      <b>Analyze 大改版成 LogTen 風兩欄（左選組、右出彩條），Aircraft 加機型分層。</b><br>
      <b>Analyze redesigned LogTen-style (pick a group left, colored bars right); Aircraft list gains a type layer.</b>
    </div>
    <div class="pl-cl-v old">V1.3.28</div>
    <div class="pl-cl-txt">
      <b>修好 Aircraft 全變「no operator」（改用 tail 範圍推公司），Position 下拉新增 SFO / FO。</b><br>
      <b>Fixed Aircraft all showing "no operator" (operator inferred from tail ranges); Position dropdown gains SFO / FO.</b>
    </div>
    <div class="pl-cl-v old">V1.3.27</div>
    <div class="pl-cl-txt">
      <b>crew 兩個編輯入口統一、Aircraft 列表按公司分類收合且可編輯。</b><br>
      <b>Unified the two crew editors; the Aircraft list is grouped by company, collapsed by default, and editable.</b>
    </div>
    <div class="pl-cl-v old">V1.3.26</div>
    <div class="pl-cl-txt">
      <b>修 New Entry 亂帶機型、換機型清掉不符的舊機尾，離線時 Report / Analyze 秒開不卡。</b><br>
      <b>Fixed New Entry auto-filling a type, clearing a mismatched tail on type change, and Report / Analyze render instantly offline.</b>
    </div>
    <div class="pl-cl-v old">V1.3.25</div>
    <div class="pl-cl-txt">
      <b>Import 介面改左側三分頁（班表／Logbook 來源／Wipe），Wipe 改成勾選類別清除。</b><br>
      <b>Import redesigned with a left 3-tab layout (Roster / Logbook source / Wipe); Wipe now clears by ticked data category.</b>
    </div>
    <div class="pl-cl-v old">V1.3.24</div>
    <div class="pl-cl-txt">
      <b>修好 LogTen 匯入漏掉副駕（FO），組員可手填新增進通訊錄，本人可編輯，SIM/DHD 自動完成。</b><br>
      <b>Fixed missing FO on LogTen import; hand-typed crew can be added to the address book, you can edit yourself, and SIM/DHD auto-complete.</b>
    </div>
    <div class="pl-cl-v old">V1.3.23</div>
    <div class="pl-cl-txt">
      <b>匯入的 night / PIC / SIC 上鎖，編輯時間時不會被自動重算蓋掉（仍可手改）。</b><br>
      <b>Imported night / PIC / SIC are locked from auto-recalc when you edit times (still hand-editable).</b>
    </div>
    <div class="pl-cl-v old">V1.3.22</div>
    <div class="pl-cl-txt">
      <b>夜航時間改用法規標準的 block 算法（Out→In，含滑行），滑行夜航不再漏算。</b><br>
      <b>Night time now uses the regulatory block-based method (Out→In, incl. taxi), so taxi night is no longer dropped.</b>
    </div>
    <div class="pl-cl-v old">V1.3.21</div>
    <div class="pl-cl-txt">
      <b>Analyze 可點選鑽取：點公司／機型看各自的 PIC/SIC 時數與該批航班。</b><br>
      <b>Analyze rows are now drill-down — tap a company or type to see PIC/SIC hours and the matching flights.</b>
    </div>
    <div class="pl-cl-v old">V1.3.20</div>
    <div class="pl-cl-txt">
      <b>機場碼 IATA / ICAO 可自選顯示，並修好班表航班的 night time 自動計算。</b><br>
      <b>IATA / ICAO airport-code display toggle, plus fixed night-time auto-calc for roster flights.</b>
    </div>
    <div class="pl-cl-v old">V1.3.19</div>
    <div class="pl-cl-txt">
      <b>匯入頁先選來源 logbook，編輯器加「類型」下拉（Flight / DHD / SIM）。</b><br>
      <b>Import now starts by selecting your source logbook, and the editor gets a Type dropdown (Flight / DHD / SIM).</b>
    </div>
    <div class="pl-cl-v old">V1.3.18</div>
    <div class="pl-cl-txt">
      <b>Wader 匯入可整批刪除（含起始累計）、匯入把本人帶進組員、deadhead 列表加 DHD 標示。</b><br>
      <b>Wader bulk-wipe (incl. opening balance), import puts you in the crew, and a DHD badge on deadhead rows.</b>
    </div>
    <div class="pl-cl-v old">V1.3.17</div>
    <div class="pl-cl-txt">
      <b>新增 Wader logbook CSV 匯入（真實航班＋模擬機＋過往結轉的起始累計）。</b><br>
      <b>Added Wader logbook CSV import (real flights + simulator sessions + brought-forward totals as an opening balance).</b>
    </div>
    <div class="pl-cl-v old">V1.3.16</div>
    <div class="pl-cl-txt">
      <b>匯入 crew 欄改模糊比對、Add Aircraft 打 tail 自動帶廠商機型、crew 排版修正。</b><br>
      <b>Fuzzy crew-column matching on import, Add Aircraft auto-fills make/model from the tail, and a crew layout fix.</b>
    </div>
    <div class="pl-cl-v old">V1.3.15</div>
    <div class="pl-cl-txt">
      <b>航班裡直接改同事資料、台灣機籍自動分公司，LogTen 匯入欄位放寬為選填。</b><br>
      <b>Edit a colleague inside a flight, auto-detect Taiwan operators from the tail, and LogTen import columns are now optional.</b>
    </div>
    <div class="pl-cl-v old">V1.3.14</div>
    <div class="pl-cl-txt">
      <b>修多個班表匯入問題（年份推算／本人槽位／跨月重匯），通訊錄可直接編輯刪除。</b><br>
      <b>Fixed several roster-import issues (year inference / self slot / cross-month re-import), and the address book is now directly editable.</b>
    </div>
    <div class="pl-cl-v old">V1.3.13</div>
    <div class="pl-cl-txt">
      <b>同名同事改用員編優先比對拆開，班表匯入可先列月份再勾選要匯的。</b><br>
      <b>Same-name colleagues separated by employee id, and roster import lets you pick which months to bring in.</b>
    </div>
    <div class="pl-cl-v old">V1.3.12</div>
    <div class="pl-cl-txt">
      <b>Crew 欄位重做成六格（含 rank 與員編），可從通訊錄點選，班表組員自動進通訊錄。</b><br>
      <b>Crew fields redesigned into six slots (rank + employee id), pickable from the Address Book, with roster crew auto-added.</b>
    </div>
    <div class="pl-cl-v old">V1.3.11</div>
    <div class="pl-cl-txt">
      <b>Import Roster 改走雲端，用 Google email 對員編撈回班表，兩個獨立 App 也能帶。</b><br>
      <b>Import Roster now pulls from the cloud (Google email → employee id), so it works across two separate apps.</b>
    </div>
    <div class="pl-cl-v old">V1.3.10</div>
    <div class="pl-cl-txt">
      <b>Crew 搜尋焦點修正：搜尋只重畫列、輸入框不再被砍掉重建。</b><br>
      <b>Crew search focus fix — search only repaints the rows so the input no longer loses focus.</b>
    </div>
    <div class="pl-cl-v old">V1.3.09</div>
    <div class="pl-cl-txt">
      <b>顏色重做成兩色（已完成綠／未完成藍），「已完成」改用實際抵達時間 in_utc 判斷。</b><br>
      <b>Color redesign to two states (done green / open blue), with "done" now defined by the actual in_utc arrival time.</b>
    </div>
    <div class="pl-cl-v old">V1.3.08</div>
    <div class="pl-cl-txt">
      <b>採 LogTen 模型：拿掉 draft/confirmed 改用日期判斷，並加 Lock / Unlock 防誤改。</b><br>
      <b>LogTen model — dropped draft/confirmed in favor of flight date, and added Lock / Unlock to prevent accidental edits.</b>
    </div>
    <div class="pl-cl-v old">V1.3.07</div>
    <div class="pl-cl-txt">
      <b>班表匯入：從 CrewSync 一鍵帶進來當 draft，不用上傳檔案。</b><br>
      <b>Roster import: pull from CrewSync in one tap as draft entries — no file upload.</b>
    </div>
    <div class="pl-cl-v old">V1.3.06</div>
    <div class="pl-cl-txt">
      <b>Add Aircraft 重做：廠商不再卡住、Type Code 自動省略，機型分組可收合。</b><br>
      <b>Add Aircraft redo — Manufacturer no longer "stuck", Type Code auto-elided, and aircraft-type groups are collapsible.</b>
    </div>
    <div class="pl-cl-v old">V1.3.05</div>
    <div class="pl-cl-txt">
      <b>手動新增航班自動算夜航時數並依太陽角度判斷日／夜起降（內建 76 個常飛機場座標）。</b><br>
      <b>Manual entry auto-computes night time and classifies day/night takeoffs/landings via solar altitude (built-in coords for 76 airports).</b>
    </div>
    <div class="pl-cl-v old">V1.3.04</div>
    <div class="pl-cl-txt">
      <b>新增飛機：廠商／機型可下拉選，選機型自動帶出機型代碼。</b><br>
      <b>Add Aircraft: pick Manufacturer / Model from dropdowns, and the Type Code auto-fills.</b>
    </div>
    <div class="pl-cl-v old">V1.3.03</div>
    <div class="pl-cl-txt">
      <b>起降只算你當 Pilot Flying 的那段、Crew PIC 排第一、機型篩機尾修正。</b><br>
      <b>Takeoffs/landings only count when you were Pilot Flying, PIC is listed first, and the type-to-tail filter is fixed.</b>
    </div>
    <div class="pl-cl-v old">V1.3.02</div>
    <div class="pl-cl-txt">
      <b>智慧編輯器：填 OOOI 自動算 Block / Air 時數、依機型篩機尾、勾 PF 自動帶起降。</b><br>
      <b>Smart editor: OOOI auto-computes Block / Air, tails filter by type, and ticking Pilot Flying auto-fills a takeoff + landing.</b>
    </div>
    <div class="pl-cl-v old">V1.3.01</div>
    <div class="pl-cl-txt">
      <b>離線優先：飛機上也能看與改，回連自動依序上傳並對帳。</b><br>
      <b>Offline-first — view and edit in flight, with changes auto-uploaded and reconciled on reconnect.</b>
    </div>
    <div class="pl-cl-v old">V1.2.07</div>
    <div class="pl-cl-txt">
      <b>[Admin/Ops] 後台新增用量成長速度與「多久滿 1 GB」推估，伺服器每天自動記快照。</b><br>
      <b>[Admin/Ops] Usage-growth tracking + a time-to-full (1 GB) estimate, with the server auto-recording a daily snapshot.</b>
    </div>
    <div class="pl-cl-v old">V1.2.06</div>
    <div class="pl-cl-txt">
      <b>[Admin/Ops] 新增可查詢的 DB 用量後台（整庫進度條／各表大小／Top users）。</b><br>
      <b>[Admin/Ops] New queryable DB-usage dashboard (whole-DB progress bar / per-table sizes / top users).</b>
    </div>
    <div class="pl-cl-v old">V1.2.05</div>
    <div class="pl-cl-txt">
      <b>真正能分析（Analyze 依機型／公司明細表）、一鍵 Confirm All、Deadhead 標記。</b><br>
      <b>Real analysis (Analyze by-type / by-company tables), one-tap Confirm All, and Deadhead marking.</b>
    </div>
    <div class="pl-cl-v old">V1.2.04</div>
    <div class="pl-cl-txt">
      <b>PIC/SIC 時數改讀 LogTen 實際時數對齊，並修 draft／重複／Preview。</b><br>
      <b>PIC/SIC hours now read LogTen's actual minutes to match it, plus draft / duplicate / Preview fixes.</b>
    </div>
    <div class="pl-cl-v old">V1.2.03</div>
    <div class="pl-cl-txt">
      <b>匯入修正：推斷 PIC/SIC 角色，並把 Deadhead/positioning 標成已發生事件。</b><br>
      <b>Import fixes — infer PIC/SIC role and flag Deadhead/positioning legs as completed events.</b>
    </div>
    <div class="pl-cl-v old">V1.2.02</div>
    <div class="pl-cl-txt">
      <b>Entry 編輯表單重排成語意分組（Flight / Times / Hours / Crew），不再眼花。</b><br>
      <b>Entry editor reorganized into logical groups (Flight / Times / Hours / Crew) — no more visual clutter.</b>
    </div>
    <div class="pl-cl-v old">V1.2.01</div>
    <div class="pl-cl-txt">
      <b>離線可用：refresh token 多放 HttpOnly cookie＋IndexedDB 快取，飛機上不再被踢回登入。</b><br>
      <b>Offline-capable — refresh token also in an HttpOnly cookie + IndexedDB cache, so you're no longer kicked to login in flight.</b>
    </div>
    <div class="pl-cl-v old">V1.1.02</div>
    <div class="pl-cl-txt">
      <b>iPad 改 LogTen Pro 風的左列表＋右明細分割視窗，列表重做成密集四行卡。</b><br>
      <b>iPad gets a LogTen Pro-style list + detail split view, with rows redesigned as dense four-line cards.</b>
    </div>
    <div class="pl-cl-v old">V1.1.0</div>
    <div class="pl-cl-txt">
      <b>介面大改版對齊 CrewSync：底部 tab bar（Analyze / Logbook / Report）＋日夜主題＋全新 Report 頁。</b><br>
      <b>Major UI redesign aligning with CrewSync — bottom tab bar (Analyze / Logbook / Report), light/dark theme, and a new Report page.</b>
    </div>
    <div class="pl-cl-v old">V1.0.11</div>
    <div class="pl-cl-txt">
      <b>新增 LogTen Aircraft Types 匯入與 👥 Crew 列表頁（含同名保護 SAME-NAME badge）。</b><br>
      <b>Added LogTen Aircraft Types import and a 👥 Crew list page (with same-name protection via a SAME-NAME badge).</b>
    </div>
    <div class="pl-cl-v old">V1.0.10</div>
    <div class="pl-cl-txt">
      <b>新增 ✈️ Aircraft 列表頁（依飛機看航班）＋手動新增機尾，並接上 Address Book 匯入 UI。</b><br>
      <b>Added an ✈️ Aircraft list page (view flights by aircraft) + manual tail add, and wired up the Address Book import UI.</b>
    </div>
    <div class="pl-cl-v old">V1.0.09</div>
    <div class="pl-cl-txt">
      <b>新增 LogTen Address Book 匯入，crew 名單存進 DB 變可查詢（員編優先、衝突不自動合併）。</b><br>
      <b>Added LogTen Address Book import — crew become queryable DB data (employee-id primary, conflicts never auto-merged).</b>
    </div>
    <div class="pl-cl-v old">V1.0.08</div>
    <div class="pl-cl-txt">
      <b>新增帳號刪除功能（Apple App Store 要求）＋完整 API.md REST 文件。</b><br>
      <b>Added account deletion (Apple App Store requirement) + a full API.md REST contract document.</b>
    </div>
    <div class="pl-cl-v old">V1.0.07</div>
    <div class="pl-cl-txt">
      <b>修 access token 過期時的並發 refresh race（改 singleton 鎖），iPad PWA 隔天不再被登出。</b><br>
      <b>Fixed the concurrent refresh race on token expiry (singleton lock) — the iPad PWA no longer forces re-login next day.</b>
    </div>
    <div class="pl-cl-v old">V1.0.06</div>
    <div class="pl-cl-txt">
      <b>修 LogTen import blocking bug：多行 Remarks 改用 proper TSV state machine 解析。</b><br>
      <b>Fixed a LogTen import blocking bug — multi-line Remarks now parsed by a proper TSV state machine.</b>
    </div>
    <div class="pl-cl-v old">V1.0.05</div>
    <div class="pl-cl-txt">
      <b>新增 admin stats endpoint，讓使用量／容量可見（含 active users 與各表大小）。</b><br>
      <b>Added an admin stats endpoint for usage / capacity visibility (active users and per-table sizes).</b>
    </div>
    <div class="pl-cl-v old">V1.0.04</div>
    <div class="pl-cl-txt">
      <b>LogTen import 效能優化：batch lookup＋bulk INSERT＋全程 transaction，大檔不再撞逾時。</b><br>
      <b>LogTen import perf optimization — batch lookup + bulk INSERT + a single transaction, so large files no longer hit the timeout.</b>
    </div>
    <div class="pl-cl-v old">V1.0.03</div>
    <div class="pl-cl-txt">
      <b>新增 LogTen entries 一鍵清除救援機制，匯入失敗想重來時可整批刪掉。</b><br>
      <b>Added a one-click LogTen entries bulk-delete escape hatch for botched imports / clean restarts.</b>
    </div>
    <div class="pl-cl-v old">V1.0.02</div>
    <div class="pl-cl-txt">
      <b>LogTen import 改 smart 模式：依 actual Out 判定已飛／計畫，重匯保護已確認的手動編輯。</b><br>
      <b>LogTen import upgraded to smart mode — status from actual Out, with re-import preserving confirmed manual edits.</b>
    </div>
    <div class="pl-cl-v old">V1.0.01</div>
    <div class="pl-cl-txt">
      <b>修兩件 LogTen import 安全網漏洞（嚴格 Date 驗證）＋加 Preview 預覽 dry-run。</b><br>
      <b>Two LogTen import safety-net fixes (strict Date validation) + a Preview dry-run mode.</b>
    </div>
    <div class="pl-cl-v old">V1.0.00</div>
    <div class="pl-cl-txt">
      <b>首次發佈：Google 登入、LogTen Pro 匯入、手動新增／編輯航班，獨立子系統。</b><br>
      <b>v1 standalone launch — Google sign-in, LogTen Pro import, and manual flight create/edit.</b>
    </div>
  `;
}

pilotLogRouter.get('/pilot-log', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // no-store 在 iOS WebKit 會擋 CacheStorage（離線殼存不進去）→ 改 no-cache：仍 revalidate 拿最新版、但可存離線副本（codex 診斷）。
  res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
  res.send(_renderPilotLogHtml());
});

// ── /pilot-log/manifest.json ─────────────────────────────────────────────────
pilotLogRouter.get('/pilot-log/manifest.json', (_req, res) => {
  res.json({
    name: 'Pilot Log',
    short_name: 'Pilot Log',
    description: '飛行記錄本 / Pilot logbook — cross-device, never expires',
    start_url: '/pilot-log',
    scope: '/pilot-log',
    display: 'standalone',
    background_color: '#0a0e1a',
    theme_color: '#0a0e1a',
    icons: [
      { src: '/pilot-log/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  });
});

// ── /pilot-log/icon.svg ──────────────────────────────────────────────────────
const _PILOT_LOG_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0a0e1a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="cover" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#60a5fa"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect x="116" y="92" width="280" height="328" rx="16" fill="url(#cover)"/>
  <circle cx="156" cy="158" r="9" fill="#e2e8f0" opacity=".75"/>
  <circle cx="156" cy="218" r="9" fill="#e2e8f0" opacity=".75"/>
  <circle cx="156" cy="278" r="9" fill="#e2e8f0" opacity=".75"/>
  <circle cx="156" cy="338" r="9" fill="#e2e8f0" opacity=".75"/>
  <rect x="200" y="170" width="160" height="6" rx="3" fill="#fff" opacity=".95"/>
  <rect x="200" y="200" width="120" height="6" rx="3" fill="#fff" opacity=".75"/>
  <rect x="200" y="230" width="140" height="6" rx="3" fill="#fff" opacity=".75"/>
  <rect x="200" y="270" width="100" height="6" rx="3" fill="#fff" opacity=".75"/>
  <rect x="200" y="300" width="130" height="6" rx="3" fill="#fff" opacity=".75"/>
  <g transform="translate(326 374) rotate(-22)" fill="#fbbf24">
    <path d="M-46 0 L-8 -7 L34 -10 L46 -3 L36 0 L36 4 L46 3 L36 0 L-8 7 Z"/>
  </g>
</svg>`;

pilotLogRouter.get('/pilot-log/icon.svg', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(_PILOT_LOG_ICON_SVG);
});

// ── /pilot-log/airport-db.js — 全域機場資料庫（懶載入，~317KB，SW + 瀏覽器快取） ──
pilotLogRouter.get('/pilot-log/airport-db.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 天
  res.send(getAirportDbJs());
});

// ── /pilot-log/sw.js — 獨立 Service Worker（scope: /pilot-log） ──────────────
pilotLogRouter.get('/pilot-log/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/pilot-log');
  res.send(`
const CACHE = '${PILOT_LOG_CACHE}';
const SHELL = ['/pilot-log', '/pilot-log/manifest.json', '/pilot-log/icon.svg'];
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
    ks.filter(k => k.startsWith('pilotlog-') && k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  // V2.0.03：衛星地圖（Esri）→ 獨立永久快取 plapt-maps（不以 pilotlog- 開頭 → activate 不清）。
  //   cache-first：預抓過/看過的離線可用；沒有就網路抓並存。飛機上離線也看得到星宇航點地圖。
  //   V2.2.02：3D Earth（Cesium）的衛星圖磚走 services.arcgisonline.com，一併納入同一份永久快取。
  if (u.hostname === 'server.arcgisonline.com' || u.hostname === 'services.arcgisonline.com') {
    e.respondWith(
      caches.open('plapt-maps').then(c => c.match(e.request).then(hit =>
        hit || fetch(e.request).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(e.request, r.clone()).catch(()=>{}); return r; }).catch(() => hit)
      ))
    );
    return;
  }
  // V2.2.02：3D Earth 引擎/函式庫（Cesium ~3MB、Leaflet、html2canvas、夜燈貼圖…都從 unpkg）→
  //   獨立永久快取 plcdn（不以 pilotlog- 開頭 → activate 不清）。有網路抓一次後常駐，省去每次重抓。
  //   codex P2：只快取成功(2xx)或 opaque(跨來源 no-cors)回應 → 不把 404/500/攔截頁存進去毒化快取。
  if (u.hostname === 'unpkg.com') {
    e.respondWith(
      caches.open('plcdn').then(c => c.match(e.request).then(hit =>
        hit || fetch(e.request).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(e.request, r.clone()).catch(()=>{}); return r; }).catch(() => hit)
      ))
    );
    return;
  }
  if (!u.pathname.startsWith('/pilot-log') && !u.pathname.startsWith('/api/pilot-log')) return;
  // API 走網路優先（auth + 動態資料絕不能從 cache 拿）
  if (u.pathname.startsWith('/api/pilot-log')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // HTML shell（navigation）network-first：上線時「一次」reopen 就拿到新版（pilot-log.js 內嵌在 shell 裡，
  // 所以連程式都一起更新）；離線才退回快取。解決「要滑掉兩次才看到新版」。
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(r => {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, cp)).catch(()=>{});
        return r;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(c => c || caches.match('/pilot-log')))
    );
    return;
  }
  // V2.0.01（codex P2）：機場庫 network-first —— 有網路一定拿最新（跑道/磁偏角/新增機場），
  // 離線才退回快取。不靠 HTML shell 注入的版號（cache-first shell 第一次升級會給舊版號 → 抓到舊機場庫）。
  if (u.pathname === '/pilot-log/airport-db.js') {
    e.respondWith(
      fetch(e.request).then(r => {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, cp)).catch(()=>{});
        return r;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }
  // 靜態資源 cache 優先 + 背景更新
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

// ── Config（前端拿 Google client_id 用，不含 secret）──────────────────────────
pilotLogRouter.get('/api/pilot-log/config', (_req, res) => {
  try {
    const creds = loadCredentials();
    res.json({ google_client_id: creds.web.client_id });
  } catch {
    res.status(500).json({ error: 'config_unavailable' });
  }
});

// ── Auth ─────────────────────────────────────────────────────────────────────
// V1.2：refresh token 同步用 HttpOnly cookie 維持 session — iOS 對 PWA 的 7 天無互動
// 清儲存政策會把 localStorage 清掉但對 server 設的 cookie 比較寬容，飛行員在飛機上開不
// 上來重登的痛點主修。Path 限制在 /api/pilot-log/auth 不外洩到其他 API。

const _PL_RT_COOKIE = 'plrt';
const _PL_RT_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,                                   // 只走 HTTPS（prod Render 必為 HTTPS）
  sameSite: 'lax' as const,
  maxAge: 90 * 24 * 60 * 60 * 1000,               // 跟 refresh token 一致 90 天
  path: '/api/pilot-log/auth',
};

// 手寫 cookie 解析避免新增 cookie-parser dep（只用在這幾個 handler）
function _plReadCookie(req: { headers: { cookie?: string } }, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = String(header).split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    if (p.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(p.slice(idx + 1).trim()); }
      catch { return p.slice(idx + 1).trim(); }
    }
  }
  return null;
}

pilotLogRouter.post('/api/pilot-log/auth/login', async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'missing_id_token' });
  }
  const ua = req.headers['user-agent'] || undefined;
  const session = await loginWithGoogle(idToken, ua);
  // 封閉測試門禁擋下：回 403 + 友善訊息（前端顯示「不在邀請名單」）
  if (session === 'not_invited') {
    return res.status(403).json({ error: 'not_invited' });
  }
  if (!session) return res.status(401).json({ error: 'login_failed' });
  res.cookie(_PL_RT_COOKIE, session.refreshToken, _PL_RT_COOKIE_OPTS);
  res.json(session);
});

pilotLogRouter.post('/api/pilot-log/auth/refresh', async (req, res) => {
  // 先 cookie，失敗（cookie 過期 / 換裝置 rotate 過）再 fallback body —
  // 不能無條件偏 cookie，否則 stale cookie 會把舊 client 還在傳的有效 body token 殺掉（codex P2）
  const cookieRt = _plReadCookie(req, _PL_RT_COOKIE);
  const bodyRt = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;
  if (!cookieRt && !bodyRt) return res.status(400).json({ error: 'missing_refresh_token' });
  const ua = req.headers['user-agent'] || undefined;

  let session = null;
  if (cookieRt) session = await rotateRefreshToken(cookieRt, ua);
  // cookie 失敗 + body 有另一個（不同的）rt → 再試 body
  if (!session && bodyRt && bodyRt !== cookieRt) {
    session = await rotateRefreshToken(bodyRt, ua);
  }

  if (!session) {
    res.clearCookie(_PL_RT_COOKIE, { path: _PL_RT_COOKIE_OPTS.path });
    return res.status(401).json({ error: 'invalid_refresh_token' });
  }
  res.cookie(_PL_RT_COOKIE, session.refreshToken, _PL_RT_COOKIE_OPTS);
  res.json(session);
});

pilotLogRouter.post('/api/pilot-log/auth/logout', async (req, res) => {
  const rt = req.body?.refreshToken || _plReadCookie(req, _PL_RT_COOKIE);
  if (rt && typeof rt === 'string') await revokeRefreshToken(rt);
  res.clearCookie(_PL_RT_COOKIE, { path: _PL_RT_COOKIE_OPTS.path });
  res.json({ ok: true });
});

// ── Me ───────────────────────────────────────────────────────────────────────
pilotLogRouter.get('/api/pilot-log/me', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;
  const u = await pool.query('SELECT id, created_at, last_login_at, crew_labels, crew_display_mode, field_labels, duty_rules FROM pilot_users WHERE id = $1', [userId]);
  const emails = await pool.query(
    'SELECT email, is_primary FROM pilot_user_emails WHERE user_id = $1 ORDER BY is_primary DESC, linked_at',
    [userId]
  );
  if (u.rows.length === 0) return res.status(404).json({ error: 'user_not_found' });
  // 創始會員：綁定的任一 email 在「凍結的封測名單」(pilot_beta_applicants) 裡 = ⭐ 創始會員，否則一般會員。
  // 開放後沒人再報名 → 名單天然凍結成當初那 12 人；用「綁定全部 email」比對，換 email 登入也認得出。
  let isFounder = false;
  try {
    const f = await pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM pilot_user_emails e
         JOIN pilot_beta_applicants a ON LOWER(a.email) = LOWER(e.email)
         WHERE e.user_id = $1
       ) AS founder`,
      [userId]
    );
    isFounder = !!f.rows[0]?.founder;
  } catch { /* pilot_beta_applicants 不存在/查詢失敗 → 當一般會員 */ }
  res.json({ user: u.rows[0], emails: emails.rows, crew_labels: u.rows[0].crew_labels || null,
    crew_display_mode: u.rows[0].crew_display_mode || 'flight', field_labels: u.rows[0].field_labels || null,
    duty_rules: u.rows[0].duty_rules || null, isFounder });
});

// V2.3：編輯器欄位顯示名稱自訂（LogTen 式）。key = 欄位 id（[a-z0-9_]，≤40 字）、值 = 標籤（≤24 字），整份取代、最多 120 個。
pilotLogRouter.post('/api/pilot-log/field-labels', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  let body: any;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const labels: Record<string, string> = {};
  let n = 0;
  for (const k of Object.keys(body || {})) {
    if (n >= 120) break;
    if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
    const v = body[k];
    if (typeof v === 'string' && v.trim()) { labels[k] = v.trim().slice(0, 24); n++; }
  }
  try {
    await pool.query('UPDATE pilot_users SET field_labels = $2, updated_at = NOW() WHERE id = $1',
      [req.pilotUserId, JSON.stringify(labels)]);
    res.json({ ok: true, field_labels: labels });
  } catch (e: any) {
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// V2.3：組員顯示模式（cic_only / flight / all）。客艙組員多、預設收合，使用者自選要看多少。
pilotLogRouter.post('/api/pilot-log/crew-display-mode', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  let body: any;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const mode = body && body.mode;
  if (!CREW_DISPLAY_MODES.includes(mode as CrewDisplayMode)) {
    return res.status(400).json({ error: 'invalid_mode' });
  }
  try {
    await pool.query('UPDATE pilot_users SET crew_display_mode = $2, updated_at = NOW() WHERE id = $1',
      [req.pilotUserId, mode]);
    res.json({ ok: true, crew_display_mode: mode });
  } catch (e: any) {
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// ── V2.3.07：報到時間規則（On Duty = STD − N 分，依公司×機場）────────────────
// 規則格式：[{co:'Starlux', apt:'RCTP', min:110}, {co:'Starlux', apt:'*', min:60}, …]，apt='*' = 該公司其他站。
function _sanitizeDutyRules(raw: any): Array<{ co: string; apt: string; min: number }> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<{ co: string; apt: string; min: number }> = [];
  for (const r of raw.slice(0, 50)) {
    const co = String(r?.co || '').trim().slice(0, 40);
    const apt = String(r?.apt || '').trim().toUpperCase().slice(0, 8);
    const min = parseInt(r?.min, 10);
    if (!co || !apt || isNaN(min) || min < 0 || min > 600) continue;
    out.push({ co, apt, min });
  }
  return out;
}
pilotLogRouter.post('/api/pilot-log/duty-rules', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  let body: any;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const rules = _sanitizeDutyRules(body && body.rules);
  if (!rules) return res.status(400).json({ error: 'invalid_rules' });
  try {
    await pool.query('UPDATE pilot_users SET duty_rules = $2, updated_at = NOW() WHERE id = $1',
      [req.pilotUserId, JSON.stringify(rules)]);
    res.json({ ok: true, duty_rules: rules });
  } catch (e: any) {
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// V2.3.07：依規則回填過去航班的 Duty —— 只補空白：On Duty=STD−規則分鐘（依公司×機場）、
// Off Duty=In+gap、Total=Off−On（原值 0 視為空白）。dry_run=true 只回報會補幾筆，不寫入。
// 公司判斷與前端同邏輯：機尾庫 operator → 台灣機籍範圍 → 班號字頭。
const _FLTNO_OP: Record<string, string> = { JX: 'Starlux', BR: 'EVA Air', CI: 'China Airlines', AE: 'Mandarin', B7: 'UNI Air', IT: 'Tigerair Taiwan' };
pilotLogRouter.post('/api/pilot-log/duty-backfill', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  let body: any;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const rules = _sanitizeDutyRules(body && body.rules) || [];
  const gapRaw = parseInt(body && body.off_gap_min, 10);
  const gap = (isNaN(gapRaw) || gapRaw < 0 || gapRaw > 600) ? 30 : gapRaw;
  const dryRun = !!(body && body.dry_run);
  const userId = req.pilotUserId!;
  try {
    // 機尾 → operator（使用者機尾庫；正規化去 dash/空白）
    const acQ = await pool.query('SELECT tail_no, operator FROM pilot_aircraft WHERE user_id = $1', [userId]);
    const opMap: Record<string, string> = {};
    for (const a of acQ.rows) {
      const t = String(a.tail_no || '').toUpperCase().replace(/[-\s]/g, '');
      if (t && a.operator) opMap[t] = a.operator;
    }
    const companyOf = (tail: string | null, fno: string | null): string => {
      const t = String(tail || '').toUpperCase().replace(/[-\s]/g, '');
      if (t) {
        if (opMap[t]) return opMap[t];
        const look = tailLookup(t);
        if (look) return look.operator;
      }
      const m = String(fno || '').trim().toUpperCase().match(/^([A-Z][A-Z0-9])\s*\d/);
      return (m && _FLTNO_OP[m[1]]) || '';
    };
    // 優先序：機場精準 > 開頭比對（'K*' = 美國本土這類區域規則）> '*' 其他站（與前端一致）
    const ruleFor = (co: string, origin: string | null): number | null => {
      if (!co) return null;
      const apt = normAirportKey(origin);
      let star: number | null = null, prefix: number | null = null;
      for (const r of rules) {
        if (r.co.toUpperCase() !== co.toUpperCase()) continue;
        const ra = r.apt.toUpperCase();
        if (normAirportKey(ra) === apt) return r.min;
        if (ra === '*') { if (star == null) star = r.min; }
        else if (ra.endsWith('*') && apt.startsWith(ra.slice(0, -1))) { if (prefix == null) prefix = r.min; }
      }
      return prefix != null ? prefix : star;
    };
    // codex P2 round6：只回填「已飛」（in_utc 非空）的航班 —— 未來班表草稿不動（規劃中的班不該被
    // 今天的規則寫死）；上鎖（is_locked）的航班也不動（跟編輯/刪除同一套鎖定契約）。
    const q = await pool.query(
      `SELECT id, flight_no, tail_no, origin, std_utc, in_utc, on_duty_utc, off_duty_utc, total_duty_minutes
       FROM pilot_log_entries
       WHERE user_id = $1 AND is_sim IS NOT TRUE AND is_deadhead IS NOT TRUE AND status <> 'roster_removed'
         AND is_locked IS NOT TRUE
         AND in_utc IS NOT NULL
         AND (
           (on_duty_utc IS NULL AND std_utc IS NOT NULL) OR
           off_duty_utc IS NULL OR
           (COALESCE(total_duty_minutes, 0) = 0)
         )`, [userId]);
    let nOn = 0, nOff = 0, nTot = 0;
    for (const r of q.rows) {
      let onD: Date | null = r.on_duty_utc ? new Date(r.on_duty_utc) : null;
      let offD: Date | null = r.off_duty_utc ? new Date(r.off_duty_utc) : null;
      let setOn: Date | null = null, setOff: Date | null = null, setTot: number | null = null;
      if (!onD && r.std_utc) {
        const min = ruleFor(companyOf(r.tail_no, r.flight_no), r.origin);
        if (min != null) { setOn = new Date(new Date(r.std_utc).getTime() - min * 60000); onD = setOn; }
      }
      if (!offD && r.in_utc) { setOff = new Date(new Date(r.in_utc).getTime() + gap * 60000); offD = setOff; }
      if (!(r.total_duty_minutes > 0) && onD && offD && offD.getTime() > onD.getTime()) {
        setTot = Math.round((offD.getTime() - onD.getTime()) / 60000);
      }
      if (!setOn && !setOff && setTot == null) continue;
      if (setOn) nOn++;
      if (setOff) nOff++;
      if (setTot != null) nTot++;
      if (!dryRun) {
        await pool.query(
          `UPDATE pilot_log_entries SET
             on_duty_utc = COALESCE(on_duty_utc, $2),
             off_duty_utc = COALESCE(off_duty_utc, $3),
             total_duty_minutes = CASE WHEN COALESCE(total_duty_minutes, 0) = 0 AND $4::int IS NOT NULL THEN $4 ELSE total_duty_minutes END,
             updated_at = NOW()
           WHERE id = $1 AND user_id = $5`,
          [r.id, setOn, setOff, setTot, userId]
        );
      }
    }
    res.json({ ok: true, dry_run: dryRun, on_duty_filled: nOn, off_duty_filled: nOff, total_filled: nTot });
  } catch (e: any) {
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// V1.3.12：crew 欄位顯示名稱自訂（CIC=JX、EVA=CP…）。白名單 = 全部組員槽位（V2.3 起含 cabin1..20），每個 ≤ 24 字。
pilotLogRouter.post('/api/pilot-log/crew-labels', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  let body: any;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const allow = CREW_SLOT_IDS;
  const labels: Record<string, string> = {};
  for (const k of allow) {
    const v = body && body[k];
    if (typeof v === 'string' && v.trim()) labels[k] = v.trim().slice(0, 24);
  }
  try {
    await pool.query('UPDATE pilot_users SET crew_labels = $2, updated_at = NOW() WHERE id = $1',
      [req.pilotUserId, JSON.stringify(labels)]);
    res.json({ ok: true, crew_labels: labels });
  } catch (e: any) {
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// ── Account delete（V1.0.08；Apple App Store 5.1.1(v) compliance）─────────────
// 永久刪除使用者帳號跟所有相關資料。CASCADE 會清掉：
//   - pilot_user_emails（ON DELETE CASCADE）
//   - pilot_user_sessions（ON DELETE CASCADE，含 refresh tokens）
//   - pilot_log_entries（ON DELETE CASCADE）
//   - pilot_aircraft（ON DELETE CASCADE）
// 不可復原。前端要做雙段 confirm 才能呼叫這個 endpoint。
pilotLogRouter.delete('/api/pilot-log/account', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;
  try {
    const r = await pool.query('DELETE FROM pilot_users WHERE id = $1', [userId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    res.status(204).end();
  } catch (e: any) {
    console.error('[pilot-log] account delete failed:', e.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

// ── Entries: list ────────────────────────────────────────────────────────────
pilotLogRouter.get('/api/pilot-log/entries', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });

  const userId = req.pilotUserId!;
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  // 記錄本要看得到「全部」航班，不該被人為上限砍掉（漏掉飛行＝錯）。
  // limit='all'（或 '0'）→ 不加 LIMIT，回該 user 全部（WHERE user_id 已限定只有本人資料，量受真實職涯上限）。
  // 其餘情況維持數字 limit（預設 200）+ offset，保留給未來分頁；不再硬上限 50000。
  const limitRaw = String(req.query.limit ?? '').trim();
  const unlimited = limitRaw === 'all' || limitRaw === '0';
  const limit = unlimited ? null : (parseInt(limitRaw, 10) || 200);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

  const conds: string[] = ['user_id = $1'];
  const params: any[] = [userId];
  if (status && ['draft', 'confirmed', 'roster_removed'].includes(status)) {
    params.push(status); conds.push(`status = $${params.length}`);
  }
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    params.push(from); conds.push(`flight_date >= $${params.length}`);
  }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    params.push(to); conds.push(`flight_date <= $${params.length}`);
  }

  let limitClause: string;
  if (unlimited) {
    // 無 LIMIT；若有帶 offset 仍套用（主列表用不到，但保留語意）
    if (offset > 0) { params.push(offset); limitClause = `OFFSET $${params.length}`; }
    else { limitClause = ''; }
  } else {
    params.push(limit, offset);
    limitClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }

  const r = await pool.query(
    `SELECT * FROM pilot_log_entries WHERE ${conds.join(' AND ')}
     ORDER BY flight_date DESC, COALESCE(std_utc, out_utc, off_utc, on_utc, in_utc) DESC NULLS LAST
     ${limitClause}`,
    params
  );
  res.json({ entries: r.rows, count: r.rowCount });
});

// ── Entries: get one ─────────────────────────────────────────────────────────
pilotLogRouter.get('/api/pilot-log/entries/:id', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  const r = await pool.query(
    'SELECT * FROM pilot_log_entries WHERE id = $1 AND user_id = $2',
    [req.params.id, req.pilotUserId]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ entry: r.rows[0] });
});

// ── Entries: manual create ───────────────────────────────────────────────────
const EDITABLE_FIELDS = [
  'flight_date', 'flight_no', 'origin', 'dest', 'aircraft_type', 'tail_no',
  'position', 'pilot_flying', 'std_utc', 'sta_utc', 'out_utc', 'off_utc', 'on_utc', 'in_utc',
  'block_minutes', 'air_minutes', 'night_minutes', 'distance_nm',
  'pic_minutes', 'sic_minutes',                    // V1.2.04：實際 PIC/SIC 時數（可手動編輯）
  'is_deadhead',                                   // V1.2.05：deadhead/positioning（手動標）
  'is_sim', 'sim_type', 'sim_minutes',             // V1.3.19：模擬機（編輯器類型下拉 Flight/SIM/DHD）
  'is_ground',                                      // V2.4.08：地面勤務
  'is_locked',                                     // V1.3.08：上鎖（LogTen 風格防誤改；鎖了不能編輯/刪除）
  'on_duty_utc', 'off_duty_utc', 'total_duty_minutes',
  'crew', 'approaches',
  'day_takeoffs', 'night_takeoffs', 'day_landings', 'night_landings', 'autolands',
  'pax_count', 'crew_count',                        // V1.3.36：crew_count（POB = crew_count + pax_count）
  'operating_crew',                                 // V2.4.03：操作飛行員人數 2/3/4（FDP duty 上限用）
  'dep_rwy', 'arr_rwy',                             // V1.3.36：起飛/落地跑道
  'sid', 'star', 'remarks',
] as const;

const JSONB_FIELDS = new Set(['crew', 'approaches']);

pilotLogRouter.post('/api/pilot-log/entries', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });

  const body = req.body || {};
  const status = body.status === 'confirmed' ? 'confirmed' : 'draft';
  if (!body.flight_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.flight_date)) {
    return res.status(400).json({ error: 'invalid_flight_date' });
  }

  const id = randomUUID();
  const sourceRef = `manual:${id}`;

  const cols = ['id', 'user_id', 'source', 'source_ref', 'status'];
  const vals: any[] = [id, req.pilotUserId, 'manual', sourceRef, status];
  const placeholders = ['$1', '$2', '$3', '$4', '$5'];
  let p = 6;
  for (const f of EDITABLE_FIELDS) {
    if (body[f] === undefined) continue;
    cols.push(f);
    if (JSONB_FIELDS.has(f)) {
      vals.push(body[f] === null ? null : JSON.stringify(body[f]));
      placeholders.push(`$${p}::jsonb`);
    } else {
      vals.push(body[f]);
      placeholders.push(`$${p}`);
    }
    p++;
  }

  try {
    const r = await pool.query(
      `INSERT INTO pilot_log_entries (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`,
      vals
    );
    res.json({ entry: r.rows[0] });
  } catch (e: any) {
    // 修：原本無 try/catch — 任何約束/型別錯誤都變 500，client 把 5xx 當「暫時性」永遠重送 →
    //     outbox 卡死（使用者回報「無法上傳」）。改成：23xxx 約束違反 / 22xxx 資料格式錯 = 永久性
    //     → 回 400，client 丟出佇列 + toast，不再卡死；其餘（連線/資源）= 暫時性 → 維持 500 保留重送。
    const code = e && e.code ? String(e.code) : '';
    console.error('[pilot-log] entry insert failed:', code, e && e.message, '| fields:', cols.join(','));
    if (code.startsWith('23') || code.startsWith('22')) {
      return res.status(400).json({ error: 'invalid_entry', detail: e && e.message, code });
    }
    return res.status(500).json({ error: 'insert_failed' });
  }
});

// ── Entries: update ──────────────────────────────────────────────────────────
pilotLogRouter.put('/api/pilot-log/entries/:id', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });

  const body = req.body || {};

  // V1.3.08：上鎖檢查 — 已鎖的航班拒絕任何編輯，除非該次 PUT 同時把 is_locked 設為 false（解鎖+存）
  const cur = await pool.query(
    `SELECT is_locked FROM pilot_log_entries WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.pilotUserId]
  );
  if (cur.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  if (cur.rows[0].is_locked && body.is_locked !== false) {
    return res.status(423).json({ error: 'locked', detail: 'Unlock first to edit' });
  }

  const sets: string[] = [];
  const vals: any[] = [];
  let p = 1;

  for (const f of EDITABLE_FIELDS) {
    if (body[f] === undefined) continue;
    if (JSONB_FIELDS.has(f)) {
      sets.push(`${f} = $${p}::jsonb`);
      vals.push(body[f] === null ? null : JSON.stringify(body[f]));
    } else {
      sets.push(`${f} = $${p}`);
      vals.push(body[f]);
    }
    p++;
  }

  if (typeof body.status === 'string' && ['draft', 'confirmed', 'roster_removed'].includes(body.status)) {
    sets.push(`status = $${p}`); vals.push(body.status); p++;
  }

  if (sets.length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

  sets.push('updated_at = NOW()');
  vals.push(req.params.id, req.pilotUserId);

  let r;
  try {
    r = await pool.query(
      `UPDATE pilot_log_entries SET ${sets.join(', ')} WHERE id = $${p} AND user_id = $${p + 1} RETURNING *`,
      vals
    );
  } catch (e: any) {
    // 同 POST：約束/格式錯（23xxx/22xxx）→ 400（client 丟出佇列，不卡死永遠重送）；其餘 → 500 暫時性。
    const code = e && e.code ? String(e.code) : '';
    console.error('[pilot-log] entry update failed:', code, e && e.message, '| sets:', sets.join(','));
    if (code.startsWith('23') || code.startsWith('22')) {
      return res.status(400).json({ error: 'invalid_entry', detail: e && e.message, code });
    }
    return res.status(500).json({ error: 'update_failed' });
  }
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  // 待補強補完：必填欄位（flight_no/origin/dest，flight_date 本就 NOT NULL）都齊了 → 自動清 needs_completion，
  //   過去日期會自動轉「已完成（綠）」並納入統計，不需另設 status。
  const row = r.rows[0];
  if (row.needs_completion && String(row.flight_no || '').trim() && String(row.origin || '').trim() && String(row.dest || '').trim()) {
    await pool.query(
      `UPDATE pilot_log_entries SET needs_completion = FALSE, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.pilotUserId]
    );
    row.needs_completion = false;
  }
  res.json({ entry: row });
});

// ── Entries: 一鍵把「過去日期」的 draft 標成 confirmed（V1.2.05）────────────────
// 匯入歷史 logbook 後常剩一堆沒 actual Out 的 draft，逐筆按 Confirm 太累。
// codex P1：只限過去日期（flight_date < CURRENT_DATE）— 未來計畫航班不可被一鍵標成已飛，
// 否則會污染時數 / currency。對「全是歷史資料」的使用者效果不變，但對未來班表安全。
pilotLogRouter.post('/api/pilot-log/entries/confirm-drafts', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const r = await pool.query(
    `UPDATE pilot_log_entries SET status = 'confirmed', updated_at = NOW()
       WHERE user_id = $1 AND status = 'draft' AND flight_date < CURRENT_DATE
         AND needs_completion IS NOT TRUE RETURNING id`,
    [req.pilotUserId]
  );
  res.json({ confirmed: r.rowCount ?? 0 });
});

// V1.3.33：一鍵上鎖 / 解鎖全部航班（LogTen 風防誤改）。{locked:true} 全鎖、{locked:false} 全開。
// IS DISTINCT FROM 只動「狀態真的會變」的列，回傳實際變動筆數。
pilotLogRouter.post('/api/pilot-log/entries/lock-all', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const locked = req.body?.locked !== false;   // 預設 true（鎖）
  const r = await pool.query(
    `UPDATE pilot_log_entries SET is_locked = $1, updated_at = NOW()
       WHERE user_id = $2 AND is_locked IS DISTINCT FROM $1 RETURNING id`,
    [locked, req.pilotUserId]
  );
  res.json({ updated: r.rowCount ?? 0, locked });
});

// ── Entries: delete ──────────────────────────────────────────────────────────
pilotLogRouter.delete('/api/pilot-log/entries/:id', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  // V1.3.08：上鎖的拒絕刪除
  const cur = await pool.query(
    `SELECT is_locked FROM pilot_log_entries WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.pilotUserId]
  );
  if (cur.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  if (cur.rows[0].is_locked) return res.status(423).json({ error: 'locked', detail: 'Unlock first to delete' });
  const r = await pool.query(
    'DELETE FROM pilot_log_entries WHERE id = $1 AND user_id = $2',
    [req.params.id, req.pilotUserId]
  );
  res.json({ deleted: r.rowCount });
});

// ── Entries: bulk delete by source (escape hatch) ────────────────────────────
// DELETE /api/pilot-log/entries?source=logten|wader&confirm=true
//   - auth 必須登入（自動 scope 到當前 user）
//   - source 開放 'logten' / 'wader'（不開 'all' / 'manual' / 'roster'）
//   - confirm 必須是 'true'，少傳就 reject
//   - 不影響 pilot_aircraft 機尾庫
//   - V1.3.18：source=wader 一併清掉起始累計（pilot_opening_balance），否則結轉時數殘留在總時數
const _PL_WIPE_SOURCES = ['logten', 'wader'];
pilotLogRouter.delete('/api/pilot-log/entries', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });

  const source = String(req.query.source || '');
  const confirm = String(req.query.confirm || '');

  if (_PL_WIPE_SOURCES.indexOf(source) < 0) {
    return res.status(400).json({ error: 'invalid_source', allowed: _PL_WIPE_SOURCES });
  }
  if (confirm !== 'true') {
    return res.status(400).json({ error: 'missing_confirm_true' });
  }

  const r = await pool.query(
    `DELETE FROM pilot_log_entries WHERE user_id = $1 AND source = $2`,
    [req.pilotUserId, source]
  );
  let openingDeleted = 0;
  if (source === 'wader') {
    const o = await pool.query(`DELETE FROM pilot_opening_balance WHERE user_id = $1`, [req.pilotUserId]);
    openingDeleted = o.rowCount || 0;
  }
  res.json({ deleted: r.rowCount, source, opening_deleted: openingDeleted });
});

// V1.3.25：依「資料類別」清除（不分匯入來源）—— 勾選 flights / aircraft / types / crew。
// flights = 所有航班 + 起始累計；crew 保留本人（is_self）。全部包進單一 transaction。
const _PL_WIPE_CATS = ['flights', 'aircraft', 'types', 'crew'];
pilotLogRouter.delete('/api/pilot-log/wipe', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  if (String(req.query.confirm || '') !== 'true') return res.status(400).json({ error: 'missing_confirm_true' });
  const cats = String(req.query.categories || '').split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = cats.filter((c) => _PL_WIPE_CATS.indexOf(c) < 0);
  if (cats.length === 0 || invalid.length > 0) {
    return res.status(400).json({ error: 'invalid_categories', allowed: _PL_WIPE_CATS });
  }
  const userId = req.pilotUserId!;
  const deleted: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (cats.indexOf('flights') >= 0) {
      const r = await client.query(`DELETE FROM pilot_log_entries WHERE user_id = $1`, [userId]);
      const o = await client.query(`DELETE FROM pilot_opening_balance WHERE user_id = $1`, [userId]);
      deleted.flights = r.rowCount || 0;
      deleted.opening = o.rowCount || 0;
    }
    if (cats.indexOf('aircraft') >= 0) {
      const r = await client.query(`DELETE FROM pilot_aircraft WHERE user_id = $1`, [userId]);
      deleted.aircraft = r.rowCount || 0;
    }
    if (cats.indexOf('types') >= 0) {
      const r = await client.query(`DELETE FROM pilot_aircraft_types WHERE user_id = $1`, [userId]);
      deleted.types = r.rowCount || 0;
    }
    if (cats.indexOf('crew') >= 0) {
      // 保留本人（is_self=true）；crew_employee_ids 靠 FK ON DELETE CASCADE 一起清
      const r = await client.query(`DELETE FROM crew WHERE user_id = $1 AND is_self = false`, [userId]);
      deleted.crew = r.rowCount || 0;
    }
    await client.query('COMMIT');
    res.json({ ok: true, deleted });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[pilot-log] category wipe failed:', e.message);
    res.status(500).json({ error: 'wipe_failed' });
  } finally {
    client.release();
  }
});

// ── Imports ──────────────────────────────────────────────────────────────────
pilotLogRouter.post('/api/pilot-log/import/logten-flights', requireAuth, async (req: AuthedRequest, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text) return res.status(400).json({ error: 'empty_body' });
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  // V1.3.24：overwriteCrew —— 對已完成（confirmed）航班也補/換組員 + PIC/SIC 時數（其餘欄位不動）
  const overwriteCrew = req.query.overwriteCrew === '1' || req.query.overwriteCrew === 'true';
  const r = await importLogtenFlights(req.pilotUserId!, text, { dryRun, overwriteCrew });
  res.json(r);
});

// V1.3.17：Wader logbook CSV 匯入（真實航班 / 模擬機 / 起始累計）
pilotLogRouter.post('/api/pilot-log/import/wader', requireAuth, async (req: AuthedRequest, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text) return res.status(400).json({ error: 'empty_body' });
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const r = await importWader(req.pilotUserId!, text, { dryRun });
  res.json(r);
});

// V2.1.09：LogATP 2 logbook CSV 匯入（OOOI/UTC + 班號代碼保留 + 機尾正規化 + 跨來源防重）
pilotLogRouter.post('/api/pilot-log/import/logatp', requireAuth, async (req: AuthedRequest, res) => {
  const raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) return res.status(400).json({ error: 'empty_body' });
  // system data 格式可選帶 crew 檔:前端把「航班檔 + 標記 + 組員檔」合併送,這裡切回兩段(把 crew1~4 的 Realm ID 對成名字)。
  const MARK = '\n__LOGATP_CREW_FILE__\n';
  const idx = raw.indexOf(MARK);
  const text = idx >= 0 ? raw.slice(0, idx) : raw;
  const crewText = idx >= 0 ? raw.slice(idx + MARK.length) : undefined;
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const r = await importLogatp(req.pilotUserId!, text, { dryRun }, crewText);
  res.json(r);
});

pilotLogRouter.post('/api/pilot-log/import/logten-aircraft', requireAuth, async (req: AuthedRequest, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text) return res.status(400).json({ error: 'empty_body' });
  const r = await importLogtenAircraft(req.pilotUserId!, text);
  res.json(r);
});

// V1.3.07：班表匯入 — 從 CrewSync localStorage 抓 duties[] 進來，建 draft entries。
// body：JSON { duties: RosterDuty[], dateRange?: { start, end } }（mount 用 express.text 故先 JSON.parse）
pilotLogRouter.post('/api/pilot-log/import/roster', requireAuth, async (req: AuthedRequest, res) => {
  let body: any;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const duties = Array.isArray(body && body.duties) ? body.duties : null;
  if (!duties) return res.status(400).json({ error: 'missing_duties' });
  const dr = body && body.dateRange;
  const dateRange = (dr && typeof dr.start === 'string' && typeof dr.end === 'string') ? dr : undefined;
  // V1.3.07 codex P2：優先用 months 做 per-month sweep（避免沒同步的空檔月份被誤標 roster_removed）
  const monthsRaw = body && body.months;
  const months: string[] | undefined = Array.isArray(monthsRaw)
    ? monthsRaw.filter((x: any) => typeof x === 'string' && /^\d{4}-\d{2}$/.test(x))
    : undefined;
  const gm = String((body && body.groundMode) || 'none');   // V2.4.08：none / sim / all
  const gOpts = { includeSim: gm === 'sim' || gm === 'all', includeGround: gm === 'all' };
  try {
    const r = await importRoster(req.pilotUserId!, duties, dateRange, months, gOpts);
    res.json(r);
  } catch (e: any) {
    console.error('[pilot-log] roster import error:', e.message);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// V1.3.11：從 server 私有表帶班表 — 解 iOS 把 CrewSync 與 Pilot Log 各自加主畫面後、
// 兩個獨立 PWA 不共用 localStorage 的問題。流程：登入 email → cs_users.employee_id
// → cs_rosters_full 撈完整班表（含組員）→ 丟給既有的 importRoster()。
// V1.3.13：body 支援 { list:true }（只回可匯入月份、不匯入）與 { months:[...] }（只匯選取月份）。
// 回傳 error：no_database / no_email / not_linked（email 對不到員編）/ no_roster（員編下沒班表）。
pilotLogRouter.post('/api/pilot-log/import/roster-from-server', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.pilotUserId!;
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'no_database' });
  let body: any = {};
  try { body = (typeof req.body === 'string' && req.body) ? JSON.parse(req.body) : (req.body || {}); } catch { body = {}; }
  const listOnly = !!(body && body.list);
  const monthFilterRaw = body && body.months;
  const monthFilter: string[] | null = Array.isArray(monthFilterRaw)
    ? monthFilterRaw.filter((x: any) => typeof x === 'string' && /^\d{4}-\d{2}$/.test(x))
    : null;
  const gmS = String((body && body.groundMode) || 'none');   // V2.4.08：none / sim / all
  const gOptsS = { includeSim: gmS === 'sim' || gmS === 'all', includeGround: gmS === 'all' };
  try {
    // 1) 拿這個 pilot 的所有 email（可能多筆）
    const emailQ = await pool.query('SELECT email FROM pilot_user_emails WHERE user_id = $1', [userId]);
    const emails = emailQ.rows.map((r: any) => r.email).filter(Boolean);
    if (!emails.length) return res.json({ error: 'no_email' });
    // 2) email → CrewSync 員編（同步時用 Google email 連結過）
    const eidQ = await pool.query(
      'SELECT DISTINCT employee_id FROM cs_users WHERE email = ANY($1) AND employee_id IS NOT NULL',
      [emails]
    );
    const eids = eidQ.rows.map((r: any) => r.employee_id).filter(Boolean);
    if (!eids.length) return res.json({ error: 'not_linked' });
    // 3) 員編 → 私有表撈所有月份的完整班表
    const rosterQ = await pool.query(
      'SELECT month, roster_data FROM cs_rosters_full WHERE employee_id = ANY($1) ORDER BY month',
      [eids]
    );
    const availMonths = rosterQ.rows.map((r: any) => r.month);
    // list 模式：只回可匯入月份，不匯入
    if (listOnly) return res.json({ months: availMonths });
    // 4) codex P1：傳「完整 duties（所有月份、ORDER BY month）」讓 importRoster 的全域 dutyIdx
    //    維持穩定；要匯入哪幾月改用 selMonths 過濾「處理」，不靠刪減 duties 陣列（否則 subset 重匯
    //    會換 source_ref → 重複 + 誤標 removed）。subset 與全匯產出完全相同的 ref。
    let allDuties: any[] = [];
    for (const row of rosterQ.rows) {
      const d = row.roster_data; // JSONB → 已是 array
      if (Array.isArray(d) && d.length) {
        for (const duty of d) { if (duty && typeof duty === 'object') duty._rmonth = row.month; } // codex P1：標 roster 月份，過濾用它（不用航班 UTC 日期）
        allDuties = allDuties.concat(d);
      }
    }
    const selMonths = (monthFilter && monthFilter.length)
      ? monthFilter.filter((m) => availMonths.indexOf(m) >= 0)
      : availMonths;
    if (!allDuties.length || !selMonths.length) return res.json({ error: 'no_roster', months: availMonths });
    // importRoster 用 selMonths 過濾處理 + per-month sweep（只掃選取月份、不誤標沒選的）
    const r = await importRoster(userId, allDuties, undefined, selMonths, gOptsS);
    res.json({ ...r, months: selMonths });
  } catch (e: any) {
    console.error('[pilot-log] roster-from-server error:', e.message);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// V1.0.09：LogTen Address Book → crew + crew_employee_ids
pilotLogRouter.post('/api/pilot-log/import/logten-addressbook', requireAuth, async (req: AuthedRequest, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text) return res.status(400).json({ error: 'empty_body' });
  const r = await importLogtenAddressBook(req.pilotUserId!, text);
  res.json(r);
});

// V1.0.11：LogTen Aircraft Types → pilot_aircraft_types（type 為主、無 tail）
pilotLogRouter.post('/api/pilot-log/import/logten-aircraft-types', requireAuth, async (req: AuthedRequest, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text) return res.status(400).json({ error: 'empty_body' });
  const r = await importLogtenAircraftTypes(req.pilotUserId!, text);
  res.json(r);
});

// ── Aircraft ─────────────────────────────────────────────────────────────────
pilotLogRouter.get('/api/pilot-log/aircraft', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  const r = await pool.query(
    `SELECT * FROM pilot_aircraft WHERE user_id = $1 ORDER BY last_used_at DESC NULLS LAST, tail_no`,
    [req.pilotUserId]
  );
  res.json({ aircraft: r.rows });
});

// V1.0.11：列出當前 user 的 aircraft types catalog（給前端用 type_code 查 make/model）
pilotLogRouter.get('/api/pilot-log/aircraft-types', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  const r = await pool.query(
    `SELECT * FROM pilot_aircraft_types WHERE user_id = $1 ORDER BY type_code`,
    [req.pilotUserId]
  );
  res.json({ aircraft_types: r.rows });
});

// V1.0.11：列出當前 user 的 crew 名單，含每筆的 employee_ids array（換公司多 ID 情境）
// is_self 排在最前面、其他依 display_name 排序
pilotLogRouter.get('/api/pilot-log/crew', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });   // V2.4.05：先跑 migration 確保 c.aliases 欄存在（升級後第一次開 Crew 頁不會 500，codex P1）
  const r = await pool.query(
    `SELECT c.id, c.display_name, c.organization, c.comment, c.is_self, c.aliases,
            c.created_at, c.updated_at,
            COALESCE(
              array_agg(e.employee_id ORDER BY e.created_at) FILTER (WHERE e.employee_id IS NOT NULL),
              '{}'::text[]
            ) AS employee_ids
     FROM crew c
     LEFT JOIN crew_employee_ids e ON e.crew_id = c.id
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.is_self DESC, c.display_name`,
    [req.pilotUserId]
  );
  res.json({ crew: r.rows });
});

// V2.4.05：從所有航班的組員槽「重建通訊錄」—— 掃每筆 entry 的 crew，把有員編的組員（含客艙）依員編 upsert 進通訊錄。
//   給「舊航班的組員（尤其空服）當初沒進通訊錄」一鍵補滿，不用一個月一個月重匯班表。只收有員編的（用員編比對、不會同名誤併）。
pilotLogRouter.post('/api/pilot-log/crew/rebuild', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;
  try {
    // 只掃「實際飛過的操作航班」：有實際落地(in_utc)、非搭便機、非已移除 → 不從未來草稿/移除/DHD 帶人進來（codex P1）
    const rows = await pool.query(
      `SELECT crew FROM pilot_log_entries
       WHERE user_id = $1 AND crew IS NOT NULL AND in_utc IS NOT NULL
         AND COALESCE(is_deadhead, false) = false AND COALESCE(status, '') <> 'roster_removed'`,
      [userId]
    );
    let scanned = 0, added = 0;
    const seen = new Set<string>();   // 同一員編一輪只 upsert 一次（一個人會出現在很多班）
    for (const row of rows.rows) {
      scanned++;
      const crew = row.crew;
      if (!crew || typeof crew !== 'object') continue;
      for (const k of Object.keys(crew)) {
        const slot: any = crew[k];
        if (!slot) continue;
        const name = (typeof slot === 'string') ? slot : String(slot.name || '');
        const eid = (typeof slot === 'object') ? String(slot.eid || '').trim() : '';
        if (!name.trim() || !eid) continue;          // 只收有員編的（安全，跟匯入一致）
        if (seen.has(eid)) continue;
        seen.add(eid);
        try { if (await upsertCrewContact(pool, userId, eid, name.trim())) added++; } catch { /* 單筆失敗略過 */ }
      }
    }
    res.json({ ok: true, scanned, added });
  } catch (e: any) {
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// V1.3.14：直接編輯 crew —— 之前只能匯入 / 從航班間接帶員編，沒有「點名單就改」。
// PUT body: { display_name, organization, comment, employee_ids: string[] }。員編整組覆蓋：
// 先刪這筆現有的、再插新的；某員編已掛在別的 crew（UNIQUE user_id+employee_id 衝突）→ 跳過並回報。
pilotLogRouter.put('/api/pilot-log/crew/:id', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;
  const crewId = req.params.id;
  const body: any = req.body || {};
  const displayName = String(body.display_name || '').trim();
  if (!displayName) return res.status(400).json({ error: 'missing_name' });
  const organization = String(body.organization || '').trim() || null;
  const comment = String(body.comment || '').trim() || null;

  // employee_ids：接受陣列或「逗號 / 空白分隔」字串；trim + 去空 + 去重
  let idsRaw: string[] = [];
  if (Array.isArray(body.employee_ids)) idsRaw = body.employee_ids.map((x: any) => String(x));
  else if (typeof body.employee_ids === 'string') idsRaw = body.employee_ids.split(/[\s,]+/);
  const ids = Array.from(new Set(idsRaw.map((s) => s.trim()).filter(Boolean)));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 確認這筆 crew 是本 user 的（避免改到別人）
    const own = await client.query(`SELECT id FROM crew WHERE id = $1 AND user_id = $2`, [crewId, userId]);
    if (own.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }

    // V2.4.05：改名時把舊名收進 aliases（去重）→ 改成中文後仍能用拼音搜尋。display_name 沒變就不動 aliases。
    await client.query(
      `UPDATE crew SET
         aliases = CASE
           WHEN display_name IS DISTINCT FROM $1 AND COALESCE(display_name,'') <> ''
                AND POSITION((';'||display_name||';') IN (';'||COALESCE(aliases,'')||';')) = 0
           THEN TRIM(BOTH ';' FROM COALESCE(aliases,'') || ';' || display_name)
           ELSE aliases END,
         display_name = $1, organization = $2, comment = $3, updated_at = NOW()
       WHERE id = $4 AND user_id = $5`,
      [displayName, organization, comment, crewId, userId]
    );

    // 員編整組重設：先清這筆現有的，再插新的；衝突（該員編已掛別人）→ 跳過
    await client.query(`DELETE FROM crew_employee_ids WHERE crew_id = $1 AND user_id = $2`, [crewId, userId]);
    const skipped: string[] = [];
    for (const eid of ids) {
      const ins = await client.query(
        `INSERT INTO crew_employee_ids (crew_id, user_id, employee_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, employee_id) DO NOTHING`,
        [crewId, userId, eid]
      );
      if ((ins.rowCount || 0) === 0) skipped.push(eid);
    }
    await client.query('COMMIT');
    res.json({ ok: true, skipped });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[pilot-log] crew update failed:', e.message);
    res.status(500).json({ error: 'update_failed' });
  } finally {
    client.release();
  }
});

// V1.3.24：新增 crew 聯絡人（從航班編輯器手填組員 → ✏️ 直接建進通訊錄並掛到該格）。
pilotLogRouter.post('/api/pilot-log/crew', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;
  const body: any = req.body || {};
  const displayName = String(body.display_name || '').trim();
  if (!displayName) return res.status(400).json({ error: 'missing_name' });
  const organization = String(body.organization || '').trim() || null;
  const comment = String(body.comment || '').trim() || null;
  let idsRaw: string[] = [];
  if (Array.isArray(body.employee_ids)) idsRaw = body.employee_ids.map((x: any) => String(x));
  else if (typeof body.employee_ids === 'string') idsRaw = body.employee_ids.split(/[\s,]+/);
  const ids = Array.from(new Set(idsRaw.map((s) => s.trim()).filter(Boolean)));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newId = randomUUID();
    await client.query(
      `INSERT INTO crew (id, user_id, display_name, organization, comment) VALUES ($1, $2, $3, $4, $5)`,
      [newId, userId, displayName, organization, comment]
    );
    const skipped: string[] = [];
    for (const eid of ids) {
      const ins = await client.query(
        `INSERT INTO crew_employee_ids (crew_id, user_id, employee_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, employee_id) DO NOTHING`,
        [newId, userId, eid]
      );
      if ((ins.rowCount || 0) === 0) skipped.push(eid);
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: newId, skipped });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[pilot-log] crew create failed:', e.message);
    res.status(500).json({ error: 'create_failed' });
  } finally {
    client.release();
  }
});

// V1.3.14：刪除 crew（crew_employee_ids 靠 FK ON DELETE CASCADE 一起走）。只刪通訊錄聯絡人，
// 不動 pilot_log_entries（航班 crew 欄是 JSONB 快照，跟通訊錄是兩回事）。
pilotLogRouter.delete('/api/pilot-log/crew/:id', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  try {
    // codex P2：本人聯絡人（is_self）不可刪 —— import-roster 撈本人員編、LogTen 角色判斷都靠它認出
    // 「你自己」，刪了之後匯入會認不得本人、要重匯通訊錄才修得回。後端硬擋，不只靠 UI。
    const chk = await pool.query(
      `SELECT is_self FROM crew WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.pilotUserId]
    );
    if (chk.rows.length === 0) return res.json({ ok: false });
    if (chk.rows[0].is_self) return res.status(400).json({ error: 'cannot_delete_self' });
    const r = await pool.query(
      `DELETE FROM crew WHERE id = $1 AND user_id = $2 AND is_self = false`,
      [req.params.id, req.pilotUserId]
    );
    res.json({ ok: (r.rowCount || 0) > 0 });
  } catch (e: any) {
    console.error('[pilot-log] crew delete failed:', e.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

// 手動新增一架機（V1.0.10）— 公司新交機等情境，不用每次都 export LogTen 再 import
// upsert 行為：tail_no 已存在 → 用 COALESCE merge（空欄位不洗掉舊資料）
pilotLogRouter.post('/api/pilot-log/aircraft', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;

  const body: any = req.body || {};
  // tail_no 正規化：trim + uppercase，避免 "b-58502" / "B-58502 " 變成兩筆
  // （ICAO/IATA tail 慣用全大寫；LogTen export 也是大寫）
  const tail_no = String(body.tail_no || '').trim().toUpperCase();
  if (!tail_no) return res.status(400).json({ error: 'missing_tail_no' });

  const operator = String(body.operator || '').trim() || null;
  const type_code = String(body.type_code || '').trim() || null;
  const make = String(body.make || '').trim() || null;
  const model = String(body.model || '').trim() || null;
  const notes = String(body.notes || '').trim() || null;

  try {
    const r = await pool.query(
      `INSERT INTO pilot_aircraft (user_id, tail_no, operator, type_code, make, model, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, tail_no) DO UPDATE SET
         operator = COALESCE(EXCLUDED.operator, pilot_aircraft.operator),
         type_code = COALESCE(EXCLUDED.type_code, pilot_aircraft.type_code),
         make = COALESCE(EXCLUDED.make, pilot_aircraft.make),
         model = COALESCE(EXCLUDED.model, pilot_aircraft.model),
         notes = COALESCE(EXCLUDED.notes, pilot_aircraft.notes)
       RETURNING *, (xmax = 0) AS inserted`,
      [userId, tail_no, operator, type_code, make, model, notes]
    );
    const row = r.rows[0];
    res.status(row.inserted ? 201 : 200).json({ aircraft: row, inserted: !!row.inserted });
  } catch (e: any) {
    console.error('[pilot-log] aircraft create failed:', e.message);
    res.status(500).json({ error: 'create_failed' });
  }
});

// V1.3.27：編輯既有機尾（user：新增後不能編輯、有錯只能刪重建不合理）。以原 tail 為 key，
// 純 UPDATE 覆寫 operator/type/make/model/notes（可清空，跟 POST 的 COALESCE merge 不同）。tail_no 不可改。
pilotLogRouter.put('/api/pilot-log/aircraft/:tail', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;
  const tail_no = String(req.params.tail || '').trim().toUpperCase();
  if (!tail_no) return res.status(400).json({ error: 'missing_tail_no' });
  const body: any = req.body || {};
  const operator = String(body.operator || '').trim() || null;
  const type_code = String(body.type_code || '').trim() || null;
  const make = String(body.make || '').trim() || null;
  const model = String(body.model || '').trim() || null;
  const notes = String(body.notes || '').trim() || null;
  try {
    const r = await pool.query(
      `UPDATE pilot_aircraft SET operator = $1, type_code = $2, make = $3, model = $4, notes = $5
       WHERE user_id = $6 AND tail_no = $7 RETURNING *`,
      [operator, type_code, make, model, notes, userId, tail_no]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ aircraft: r.rows[0], ok: true });
  } catch (e: any) {
    console.error('[pilot-log] aircraft update failed:', e.message);
    res.status(500).json({ error: 'update_failed' });
  }
});

// V1.3.36：移除機尾庫的一架（給 fleet picker「加錯了取消」用）。
// 安全閥：有航班用過這架（tail_no 對得到）→ 409 拒絕，避免孤立歷史航班；零航班才可刪。
pilotLogRouter.delete('/api/pilot-log/aircraft/:tail', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;
  const tail_no = String(req.params.tail || '').trim().toUpperCase();
  if (!tail_no) return res.status(400).json({ error: 'missing_tail_no' });
  try {
    const used = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pilot_log_entries WHERE user_id = $1 AND UPPER(tail_no) = $2`,
      [userId, tail_no]
    );
    if (used.rows[0].n > 0) return res.status(409).json({ error: 'aircraft_in_use', flights: used.rows[0].n });
    const r = await pool.query(
      `DELETE FROM pilot_aircraft WHERE user_id = $1 AND UPPER(tail_no) = $2`,
      [userId, tail_no]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ deleted: r.rowCount, ok: true });
  } catch (e: any) {
    console.error('[pilot-log] aircraft delete failed:', e.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

// ── Stats ────────────────────────────────────────────────────────────────────
pilotLogRouter.get('/api/pilot-log/stats', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.pilotUserId!;
  // codex P1：讀 pilot_opening_balance / is_sim / sim_minutes 前先確保 schema 已 migrate，
  // 否則既有部署在 migration 跑前被打 /stats 會 relation/column does not exist → 500。
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const [totals, rolling, byType, opening, sim] = await Promise.all([
    getTotals(userId),
    getRollingTotals(userId),
    getByAircraftType(userId),
    getOpeningBalance(userId),
    getSimTotals(userId),
  ]);
  res.json({ totals, rolling, by_type: byType, opening, sim });
});

// ── 字型 subset（給 Logbook PDF 嵌入中日韓字）V2.4.01 ───────────────────────────
//   前端 jsPDF 內建字型只支援拉丁；要印中文得嵌字型，但整包 CJK 十幾 MB → 每個 PDF 爆掉。
//   做法：前端把「這份 logbook 真正用到的字」傳來，伺服器用 subset-font 只切那些字（4.5MB→幾十 KB）回傳，
//   前端嵌進 jsPDF → 真·文字向量 PDF、中文正常、檔案小。字型：jf open 粉圓（justfont，免費可商用 TrueType）。
import _subsetFont from 'subset-font';
import { readFileSync as _plReadFile } from 'fs';
import { dirname as _plDirname, join as _plJoin } from 'path';
import { fileURLToPath as _plFileURL } from 'url';
// 字型「隨程式打包在 repo」（不在 runtime 去 CDN 抓）→ 沒有外網/CDN 掛掉也不會壞，codex P1。
let _plCjkFontBuf: Buffer | null = null;
function _plLoadCjkFont(): Buffer {
  if (!_plCjkFontBuf) {
    _plCjkFontBuf = _plReadFile(_plJoin(_plDirname(_plFileURL(import.meta.url)), 'assets', 'jf-openhuninn-2.0.ttf'));
  }
  return _plCjkFontBuf;
}
pilotLogRouter.post('/api/pilot-log/font-subset', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const chars = String((req.body && req.body.chars) || '').slice(0, 40000);
    if (!chars) return res.status(400).json({ error: 'no_chars' });
    const full = _plLoadCjkFont();
    const subset = await _subsetFont(full, chars, { targetFormat: 'truetype' });
    res.json({ font: Buffer.from(subset).toString('base64') });
  } catch (e: any) {
    console.error('[pilot-log] font-subset failed:', e && (e.stack || e.message || e));
    res.status(500).json({ error: 'subset_failed' });
  }
});

// ── Admin stats（V1.0.05；60s cache） ────────────────────────────────────────
// GET /api/pilot-log/admin/stats?limit=10
// 不掛 requireAuth：這是 ops 監控 endpoint。V1.3 拿掉密碼門檻（網址未對外連結，且不再回 email）。
const PL_STATS_TTL_MS = 60 * 1000;
let _plStatsCache: { at: number; data: any } | null = null;

import { timingSafeEqual as _tse, createHash as _ch } from 'crypto';
// TODO(V1.3)：密碼門檻已移除（user 反映 64 字密碼無法記、且要先進 Render 找密碼很多餘）。
// 保留此函式不刪 — 若日後要改用「擁有者 Google 登入」門檻可重用比對邏輯。目前未被呼叫。
function _plAdminPwMatch(provided: string): boolean {
  const expected = process.env.PILOT_LOG_ADMIN_PW || '';
  // server config 檢查（不是 user-controlled，沒 leak issue）
  if (!expected || expected.length < 8) return false;
  // codex review fix：先 SHA-256 digest 兩邊到固定 32 bytes 再 timingSafeEqual，
  // 避免「先比長度」的早期分支洩漏 expected 長度資訊
  try {
    const a = _ch('sha256').update(String(provided)).digest();
    const b = _ch('sha256').update(expected).digest();
    return _tse(a, b);
  } catch {
    return false;
  }
}

// Cache 內永遠存 top 50（最大值），response 依 request limit 動態 slice。
// 這樣 ?limit=10 / ?limit=50 共用同一份 cache，不會有 cross-limit 污染。
const PL_TOP_USERS_MAX = 50;

function _plBuildResponse(cached: any, limit: number, isCached: boolean, cacheAgeMs: number) {
  const all = cached.breakdown.top_users_by_entries || [];
  return {
    ...cached,
    breakdown: {
      ...cached.breakdown,
      top_users_by_entries: all.slice(0, limit),
    },
    cached: isCached,
    cache_age_ms: isCached ? cacheAgeMs : undefined,
  };
}

pilotLogRouter.get('/api/pilot-log/oops/stats', async (req, res) => {
  // V1.3：拿掉密碼門檻。網址 /pilot-log/oops 未對外連結（security-by-obscurity），
  // V1.3.11：路徑由 /admin 改為 /oops（admin 太好猜）。仍無密碼、仍只給非機密用量數字。
  // 本頁只給「DB 用量 / 成長」這類非機密數字 — 不回傳任何使用者 email（避免無密碼下外洩 PII）。
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), PL_TOP_USERS_MAX);

  // 60s in-memory cache（admin 用、低頻；不做事件型主動失效）
  const now = Date.now();
  if (_plStatsCache && (now - _plStatsCache.at) < PL_STATS_TTL_MS) {
    return res.json(_plBuildResponse(_plStatsCache.data, limit, true, now - _plStatsCache.at));
  }

  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });

  try {
    // ── Users 區 ────
    const usersAgg = await pool.query(`
      SELECT
        COUNT(*)::int                                                              AS total,
        COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '7 days')::int      AS active_7d,
        COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '30 days')::int     AS active_30d,
        COUNT(*) FILTER (WHERE last_import_at IS NOT NULL)::int                    AS with_imports,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM pilot_log_entries e WHERE e.user_id = u.id))::int AS with_entries
      FROM pilot_users u
    `);

    // ── Entries 區 ────
    const entriesTotal = await pool.query(`SELECT COUNT(*)::int AS total FROM pilot_log_entries`);
    const perUser = await pool.query(`
      SELECT
        COALESCE(AVG(c)::int, 0)                                              AS avg_per_user,
        COALESCE(MAX(c)::int, 0)                                              AS max_per_user,
        COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY c)::int, 0)      AS median_per_user
      FROM (SELECT user_id, COUNT(*) AS c FROM pilot_log_entries GROUP BY user_id) t
    `);
    const byStatus = await pool.query(`
      SELECT status, COUNT(*)::int AS c FROM pilot_log_entries GROUP BY status
    `);
    const statusMap: Record<string, number> = { draft: 0, confirmed: 0, roster_removed: 0 };
    for (const r of byStatus.rows) statusMap[r.status] = r.c;

    // V1.3.30：成長摘要（非隱私，公開頁也能看）—— 近 7 / 30 天新增幾人、幾筆航班
    const recent = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM pilot_users WHERE created_at > NOW() - INTERVAL '7 days')::int       AS new_users_7d,
        (SELECT COUNT(*) FROM pilot_users WHERE created_at > NOW() - INTERVAL '30 days')::int      AS new_users_30d,
        (SELECT COUNT(*) FROM pilot_log_entries WHERE created_at > NOW() - INTERVAL '7 days')::int  AS new_entries_7d,
        (SELECT COUNT(*) FROM pilot_log_entries WHERE created_at > NOW() - INTERVAL '30 days')::int AS new_entries_30d
    `);

    // ── Tables 區（三個 size 都回） ────
    // 清單用 schema.ts 的單一事實來源 PILOT_LOG_TABLES（餐廳+其他 = DB 總量扣掉這些）。
    const tableNames = PILOT_LOG_TABLES;
    const tables: Record<string, any> = {};
    let totalSize = 0;
    for (const t of tableNames) {
      const r = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM ${t})::int                       AS rows,
          pg_total_relation_size($1::regclass)::bigint            AS total_bytes,
          pg_relation_size($1::regclass)::bigint                  AS heap_bytes,
          pg_indexes_size($1::regclass)::bigint                   AS index_bytes
      `, [t]);
      const row = r.rows[0];
      tables[t] = {
        rows: row.rows,
        total_bytes: Number(row.total_bytes),
        heap_bytes: Number(row.heap_bytes),
        index_bytes: Number(row.index_bytes),
        toast_bytes: Number(row.total_bytes) - Number(row.heap_bytes) - Number(row.index_bytes),
      };
      totalSize += Number(row.total_bytes);
    }

    // ── V1.2.06：整個資料庫總量（含餐廳 POS 等所有表）+ 全表 size 排行 ─────────────
    // pilot-log 跟餐廳出勤系統共用同一個 Postgres，這裡才看得到「總共用多少 / 還剩多少 / 餐廳吃多少」。
    // V1.3.35（修）：Render「Storage used」≈ 所有 database + WAL + 開銷，不是單一 database 的邏輯大小。
    // 原本 pg_database_size(current_database()) 少算其他 DB 跟 WAL → 顯示遠低於 Render（user：Render 15.64% vs 本頁 2.8%）。
    let allDbBytes = 0;
    try {
      const r = await pool.query(`SELECT COALESCE(SUM(pg_database_size(oid)),0)::bigint AS bytes FROM pg_database WHERE NOT datistemplate`);
      allDbBytes = Number(r.rows[0].bytes);
    } catch {
      const r = await pool.query(`SELECT pg_database_size(current_database())::bigint AS bytes`);
      allDbBytes = Number(r.rows[0].bytes);
    }
    let walBytes = 0;
    try {
      const w = await pool.query(`SELECT COALESCE(SUM(size),0)::bigint AS bytes FROM pg_ls_waldir()`);
      walBytes = Number(w.rows[0].bytes);
    } catch { /* 多數 Render 帳號無 pg_monitor → 拿不到 WAL，walBytes 留 0 */ }
    const dbTotalBytes = allDbBytes + walBytes;   // SQL 算得到的部分（資料 + 拿得到時的 WAL）
    const GB = 1024 * 1024 * 1024;

    // V1.3.36：接 Render Metrics API 拿「真實磁碟用量」= 後台 Storage 那個數字（含 SQL 讀不到的 WAL/系統）。
    // 設了 RENDER_API_KEY + RENDER_PG_ID（dpg-…）才啟用；抓不到就維持 SQL 估算、不影響其他資料。
    let renderDiskBytes: number | null = null;
    const _rKey = process.env.RENDER_API_KEY;
    const _rId = process.env.RENDER_PG_ID;
    if (_rKey && _rId) {
      try {
        const ctrl = new AbortController();
        const _to = setTimeout(() => ctrl.abort(), 4000);
        const startTime = new Date(now - 3600 * 1000).toISOString();
        const endTime = new Date(now).toISOString();
        const url = `https://api.render.com/v1/metrics/disk-usage?resource=${encodeURIComponent(_rId)}&startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`;
        const rr = await fetch(url, { headers: { Authorization: `Bearer ${_rKey}`, Accept: 'application/json' }, signal: ctrl.signal });
        clearTimeout(_to);
        if (rr.ok) {
          const j: any = await rr.json();
          // Render metrics 回 [{ values: [{ timestamp, value }, …] }, …] —— 取所有 series 最後一筆裡最大的（取最新值）
          const series: any[] = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
          let latest: number | null = null;
          for (const s of series) {
            const vals: any[] = (s && Array.isArray(s.values)) ? s.values : [];
            if (vals.length) {
              const v = vals[vals.length - 1];
              if (v && typeof v.value === 'number') latest = Math.max(latest ?? 0, v.value);
            }
          }
          renderDiskBytes = latest;
        } else {
          console.error('[pilot-log] render disk-usage API non-ok:', rr.status);
        }
      } catch (e: any) {
        console.error('[pilot-log] render disk-usage fetch failed:', e && e.message);
      }
    }
    const topTablesRow = await pool.query(`
      SELECT relname AS name,
             pg_total_relation_size(relid)::bigint AS total_bytes,
             n_live_tup::bigint                    AS approx_rows
      FROM pg_stat_user_tables
      ORDER BY total_bytes DESC
      LIMIT 30
    `);
    const topTablesBySize = topTablesRow.rows.map((r: any) => ({
      name: r.name,
      total_mb: Math.round(Number(r.total_bytes) / 1024 / 1024 * 100) / 100,
      total_bytes: Number(r.total_bytes),
      approx_rows: Number(r.approx_rows),
    }));

    // ── V1.2.07：用量歷史快照 + 成長速度 / 滿載推估 ─────────────────────────────
    // 快照主要靠 startPilotLogSnapshotCron()（伺服器每天自動記）；這裡開後台時也順手補一筆
    // （同樣 20h gap 去重），確保剛部署完第一次看就有資料。
    await insertDbSizeSnapshotIfDue(dbTotalBytes, totalSize, dbTotalBytes - totalSize);
    const histRows = (await pool.query(
      `SELECT captured_at, db_total_bytes, restaurant_etc_bytes
       FROM pilot_db_size_history ORDER BY captured_at ASC`
    )).rows;
    const MB = 1024 * 1024;
    const DAY_MS = 86400 * 1000;
    const hist = histRows.map((r: any) => ({
      t: new Date(r.captured_at).getTime(),
      total: Number(r.db_total_bytes),
      rest: Number(r.restaurant_etc_bytes),
    }));
    const growth: any = {
      snapshot_count: hist.length,
      history_days: 0,        // 已記錄的時間跨度（天）
      basis_days: 0,          // 算速度用的實際跨度
      per_day_total_mb: null,
      per_day_restaurant_mb: null,
      delta_30d_total_mb: null,
      delta_30d_restaurant_mb: null,
      months_to_1gb: null,
      full_date_estimate: null,
    };
    if (hist.length >= 2) {
      const first = hist[0];
      const last = hist[hist.length - 1];
      const spanMs = last.t - first.t;
      growth.history_days = Math.round(spanMs / DAY_MS * 10) / 10;
      if (spanMs >= 1.5 * DAY_MS) {  // 至少 ~1.5 天跨度才算得出有意義的速度
        const days = spanMs / DAY_MS;
        const rateTotal = (last.total - first.total) / days;   // bytes/day
        const rateRest = (last.rest - first.rest) / days;
        growth.basis_days = Math.round(days * 10) / 10;
        growth.per_day_total_mb = Math.round(rateTotal / MB * 100) / 100;
        growth.per_day_restaurant_mb = Math.round(rateRest / MB * 100) / 100;
        growth.delta_30d_total_mb = Math.round(rateTotal * 30 / MB * 10) / 10;
        growth.delta_30d_restaurant_mb = Math.round(rateRest * 30 / MB * 10) / 10;
        if (rateTotal > 0) {
          const remaining = GB - dbTotalBytes;
          if (remaining <= 0) {
            // 已超過 1 GB：不要算出負的月數 / 過去的日期
            growth.months_to_1gb = 0;
            growth.full_date_estimate = new Date(now).toISOString().slice(0, 10);
          } else {
            const daysToFull = remaining / rateTotal;
            growth.months_to_1gb = Math.round(daysToFull / 30.44 * 10) / 10;
            growth.full_date_estimate = new Date(now + daysToFull * DAY_MS).toISOString().slice(0, 10);
          }
        }
      }
    }
    const sizeHistory = hist.slice(-60).map((r: { t: number; total: number; rest: number }) => ({
      at: new Date(r.t).toISOString().slice(0, 10),
      total_mb: Math.round(r.total / MB * 10) / 10,
      restaurant_mb: Math.round(r.rest / MB * 10) / 10,
    }));

    // ── Top users by entry count（V1.3：不回 email，僅匿名 rank + 筆數，無密碼也不外洩 PII）────
    const topUsers = await pool.query(`
      SELECT
        u.created_at, u.last_seen_at, u.last_import_at, u.last_login_at,
        (SELECT COUNT(*) FROM pilot_log_entries WHERE user_id = u.id)::int            AS entry_count,
        (SELECT COUNT(*) FROM pilot_aircraft WHERE user_id = u.id)::int               AS aircraft_count
      FROM pilot_users u
      ORDER BY entry_count DESC
      LIMIT $1
    `, [PL_TOP_USERS_MAX]);

    // cacheData 存「不分 limit 的完整資料」（top 50）；回應時依本次 request limit slice
    const cacheData = {
      generated_at: new Date().toISOString(),
      summary: {
        users: usersAgg.rows[0],
        entries: {
          total: entriesTotal.rows[0].total,
          avg_per_user: perUser.rows[0].avg_per_user,
          median_per_user: perUser.rows[0].median_per_user,
          max_per_user: perUser.rows[0].max_per_user,
          by_status: statusMap,
        },
        recent_growth: recent.rows[0],   // V1.3.30
        total_pilot_log_size_bytes: totalSize,
        total_pilot_log_size_mb: Math.round(totalSize / 1024 / 1024 * 10) / 10,
        // V1.2.06：整個 DB（含餐廳 POS）對 1GB 的用量
        db_total_size_bytes: dbTotalBytes,
        db_total_size_mb: Math.round(dbTotalBytes / 1024 / 1024 * 10) / 10,
        all_db_size_mb: Math.round(allDbBytes / 1024 / 1024 * 10) / 10,   // V1.3.35：全部 database（資料）
        wal_size_mb: Math.round(walBytes / 1024 / 1024 * 10) / 10,        // WAL（拿不到權限時為 0）
        db_used_pct_of_1gb: Math.round(dbTotalBytes / GB * 1000) / 10,
        db_free_mb_of_1gb: Math.round((GB - dbTotalBytes) / 1024 / 1024 * 10) / 10,
        // V1.3.36：Render API 回的「真實磁碟用量」（= 後台 Storage，含 WAL/系統）。設了 env 才有值，否則 null。
        render_disk_bytes: renderDiskBytes,
        render_disk_mb: renderDiskBytes != null ? Math.round(renderDiskBytes / 1024 / 1024 * 10) / 10 : null,
        render_disk_pct_of_1gb: renderDiskBytes != null ? Math.round(renderDiskBytes / GB * 1000) / 10 : null,
        restaurant_etc_size_mb: Math.round((dbTotalBytes - totalSize) / 1024 / 1024 * 10) / 10,  // 總量扣掉 pilot-log = 餐廳+晨報+其他+開銷
        growth,   // V1.2.07：成長速度 + 多久滿 1GB（需要歷史快照累積）
      },
      breakdown: {
        tables,
        top_tables_by_size: topTablesBySize,     // ← 全 DB 各表 size 排行（餐廳的表會在這）
        size_history: sizeHistory,               // ← V1.2.07：近 60 筆用量快照（畫趨勢用）
        top_users_by_entries: topUsers.rows,    // ← 永遠 top 50
      },
      warnings: [],
    };

    _plStatsCache = { at: now, data: cacheData };
    res.json(_plBuildResponse(cacheData, limit, false, 0));
  } catch (e: any) {
    console.error('[pilot-log] admin stats error:', e.message);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

// V1.3.30：逐人用量明細（含 email + 佔用空間）—— 鎖在 owner Google 登入後面（無密碼公開頁仍匿名）。
// 空間用 pg_column_size 加總每人在各表的 row 大小（約略、不含 index/TOAST，但夠看相對大戶），依大小排序。
pilotLogRouter.get('/api/pilot-log/oops/users', requireAuth, async (req: AuthedRequest, res) => {
  if (!(await _plRequireOwner(req, res))) return;
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  try {
    const r = await pool.query(`
      SELECT
        (SELECT email FROM pilot_user_emails WHERE user_id = u.id ORDER BY is_primary DESC, linked_at ASC LIMIT 1) AS email,
        u.created_at, u.last_seen_at, u.last_import_at,
        (SELECT COUNT(*) FROM pilot_log_entries WHERE user_id = u.id)::int AS entry_count,
        (SELECT COUNT(*) FROM pilot_aircraft WHERE user_id = u.id)::int    AS aircraft_count,
        (
          COALESCE((SELECT SUM(pg_column_size(e.*)) FROM pilot_log_entries e WHERE e.user_id = u.id), 0) +
          COALESCE((SELECT SUM(pg_column_size(a.*)) FROM pilot_aircraft a WHERE a.user_id = u.id), 0) +
          COALESCE((SELECT SUM(pg_column_size(cr.*)) FROM crew cr WHERE cr.user_id = u.id), 0) +
          COALESCE((SELECT SUM(pg_column_size(t.*)) FROM pilot_aircraft_types t WHERE t.user_id = u.id), 0) +
          COALESCE((SELECT SUM(pg_column_size(ob.*)) FROM pilot_opening_balance ob WHERE ob.user_id = u.id), 0) +
          COALESCE((SELECT SUM(pg_column_size(ss.*)) FROM pilot_user_sessions ss WHERE ss.user_id = u.id), 0) +
          COALESCE((SELECT SUM(pg_column_size(ce.*)) FROM crew_employee_ids ce WHERE ce.user_id = u.id), 0) +
          COALESCE((SELECT SUM(pg_column_size(em.*)) FROM pilot_user_emails em WHERE em.user_id = u.id), 0)
        )::bigint AS bytes
      FROM pilot_users u
      ORDER BY bytes DESC
    `);
    const fmtD = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const users = r.rows.map((x: any) => ({
      email: x.email || '(no email)',
      kb: Math.round(Number(x.bytes) / 1024 * 10) / 10,
      mb: Math.round(Number(x.bytes) / 1024 / 1024 * 100) / 100,
      entry_count: x.entry_count,
      aircraft_count: x.aircraft_count,
      created_at: fmtD(x.created_at),
      last_seen_at: fmtD(x.last_seen_at),
      last_import_at: fmtD(x.last_import_at),
    }));
    res.json({ users });
  } catch (e: any) {
    console.error('[pilot-log] oops users error:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── Admin dashboard 頁面（V1.2.06；V1.3 拿掉密碼）─────────────────────────────
// 可查詢的後台 UI：一開頁就顯示 DB 用量 / 成長 / 各表 size / 匿名 user 統計。
// 不需密碼（網址未對外連結 + 不回任何 email）；meta robots=noindex 不被搜尋。
pilotLogRouter.get('/pilot-log/oops', (_req, res) => {
  // V8.0.45：DB 用量總覽已整合進 /tower（需 owner Google 登入）。舊書籤 302 轉址過去。
  res.redirect(302, '/tower');
});
const _OOPS_PAGE_RETIRED = `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Pilot Log · DB Admin</title>
<style>
* { box-sizing: border-box; }
body { margin:0; background:#0a0e1a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:15px; padding:16px; padding-top:max(16px,env(safe-area-inset-top)); }
h1 { font-size:1.1em; margin:0 0 14px; }
.card { background:#1a1f2e; border:1px solid #334155; border-radius:12px; padding:14px; margin-bottom:12px; }
.lbl { color:#94a3b8; font-size:.72em; text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px; }
.big { font-size:1.6em; font-weight:800; }
.muted { color:#94a3b8; }
.bar { height:14px; border-radius:7px; background:rgba(255,255,255,.08); overflow:hidden; margin:8px 0 4px; }
.bar > i { display:block; height:100%; background:linear-gradient(90deg,#3b82f6,#60a5fa); }
input { background:#0a0e1a; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:9px 11px; font-size:.9em; width:100%; }
button { background:#3b82f6; color:#fff; border:0; border-radius:8px; padding:9px 16px; font-size:.85em; font-weight:700; cursor:pointer; }
table { width:100%; border-collapse:collapse; font-size:.8em; }
th,td { text-align:right; padding:5px 8px; white-space:nowrap; font-variant-numeric:tabular-nums; }
th:first-child,td:first-child { text-align:left; }
th { color:#94a3b8; font-weight:700; }
tr+tr td { border-top:1px solid #283449; }
.tbar { display:inline-block; height:8px; border-radius:4px; background:#3b82f6; vertical-align:middle; }
.err { color:#fca5a5; }
.row2 { display:flex; gap:10px; flex-wrap:wrap; }
.row2 > .card { flex:1; min-width:130px; }
</style></head>
<body>
<h1>📊 Pilot Log · DB Admin</h1>
<div id="msg" class="muted" style="font-size:.72em;margin-bottom:10px"></div>
<div id="out"></div>
<div class="card"><div class="lbl">逐人用量（Owner 登入才看 · 含 email）</div>
  <div class="muted" style="font-size:.72em;margin-bottom:8px">只看「誰佔多少空間」（容量管理用），不讀任何航班內容。</div>
  <div id="ologin"></div>
  <div id="omsg" class="muted" style="font-size:.72em;margin-top:6px"></div>
  <div id="ousers" style="margin-top:8px"></div>
</div>
<script>
function fmtMB(v){ return (v==null?'—':v) + ' MB'; }
function el(id){ return document.getElementById(id); }
async function load(){
  el('msg').textContent='查詢中…';
  try{
    var r = await fetch('/api/pilot-log/oops/stats?limit=50');
    if(!r.ok){ el('msg').innerHTML='<span class="err">查詢失敗 '+r.status+'</span>'; return; }
    var j = await r.json();
    el('msg').textContent='更新於 ' + new Date(j.generated_at).toLocaleString('zh-TW') + (j.cached?'（快取）':'');
    render(j);
  }catch(e){ el('msg').innerHTML='<span class="err">'+(e&&e.message||'error')+'</span>'; }
}
function render(j){
  var s = j.summary || {}, b = j.breakdown || {};
  // V1.3.36：接了 Render API（render_disk_mb 有值）→ 顯示真實磁碟用量（= 後台 Storage）；否則 SQL 估算。
  var hasRender = (s.render_disk_mb != null);
  var pct = hasRender ? (s.render_disk_pct_of_1gb || 0) : (s.db_used_pct_of_1gb || 0);
  var bigMB = hasRender ? s.render_disk_mb : s.db_total_size_mb;
  var freeMB = hasRender ? (Math.round((1024 - s.render_disk_mb) * 10) / 10) : s.db_free_mb_of_1gb;
  var out = '';
  // 儲存總覽
  out += '<div class="card"><div class="lbl">磁碟用量 / 1 GB' + (hasRender ? '（Render 即時 · 真實磁碟）' : '（SQL 估算 · 讀不到 WAL）') + '</div>' +
    '<div class="big">' + fmtMB(bigMB) + ' <span class="muted" style="font-size:.5em">/ 1024 MB · ' + pct + '%</span></div>' +
    '<div class="bar"><i style="width:' + Math.min(pct,100) + '%"></i></div>' +
    '<div class="muted" style="font-size:.78em">' +
    (hasRender
      ? '剩餘 ' + fmtMB(freeMB) + '　·　來源 Render Metrics API（= 後台 Storage，含 WAL+系統）。其中資料庫資料 ' + fmtMB(s.all_db_size_mb) + '，其餘為 WAL/系統開銷。'
      : '剩餘 ' + fmtMB(freeMB) + '　·　資料 ' + fmtMB(s.all_db_size_mb) + ' + WAL ' + fmtMB(s.wal_size_mb) +
        '（WAL 無權限取得，會比 Render 後台低 ~120MB；設 RENDER_API_KEY + RENDER_PG_ID 後顯示真實值）'
    ) + '</div></div>';
  // 成長速度 / 滿載推估（V1.2.07）
  var g = s.growth || {};
  out += '<div class="card"><div class="lbl">成長速度 / 多久滿 1 GB</div>';
  if(g.months_to_1gb===0){
    out += '<div class="big err">⚠️ 已達 / 超過 1 GB</div>';
  } else if(g.months_to_1gb!=null){
    out += '<div class="big">約 ' + g.months_to_1gb + ' 個月後滿</div>' +
      '<div class="muted" style="font-size:.78em">推估滿載日 ' + (g.full_date_estimate||'—') + '（依最近 ' + g.basis_days + ' 天速度）</div>' +
      '<div class="muted" style="font-size:.82em;line-height:1.9;margin-top:8px">' +
      '每天 +' + (g.per_day_total_mb!=null?g.per_day_total_mb:'—') + ' MB（其中餐廳 +' + (g.per_day_restaurant_mb!=null?g.per_day_restaurant_mb:'—') + '）<br>' +
      '每月約 +' + (g.delta_30d_total_mb!=null?g.delta_30d_total_mb:'—') + ' MB（其中餐廳 +' + (g.delta_30d_restaurant_mb!=null?g.delta_30d_restaurant_mb:'—') + '）</div>';
  } else if(g.per_day_total_mb!=null){
    out += '<div class="big muted">用量幾乎沒增長</div>' +
      '<div class="muted" style="font-size:.82em;margin-top:6px">每天約 ' + g.per_day_total_mb + ' MB（依最近 ' + g.basis_days + ' 天）</div>';
  } else {
    out += '<div class="big muted">累積中…</div>' +
      '<div class="muted" style="font-size:.8em;margin-top:6px">需要時間累積：已記錄 ' + (g.snapshot_count||0) + ' 筆快照、跨 ' + (g.history_days||0) + ' 天。伺服器每天自動記一筆，約 2-3 天後就能估速度與滿載日。</div>';
  }
  out += '</div>';
  // 組成
  out += '<div class="row2">' +
    '<div class="card"><div class="lbl">餐廳 + 其他</div><div class="big">' + fmtMB(s.restaurant_etc_size_mb) + '</div></div>' +
    '<div class="card"><div class="lbl">Pilot Log</div><div class="big">' + fmtMB(s.total_pilot_log_size_mb) + '</div></div>' +
    '</div>';
  // 各表 size 排行
  var tt = b.top_tables_by_size || [];
  if(tt.length){
    var maxmb = tt[0].total_mb || 1;
    var rows = tt.map(function(t){
      var w = Math.max(2, Math.round((t.total_mb/maxmb)*100));
      return '<tr><td>'+esc(t.name)+'</td><td>'+(t.approx_rows!=null?t.approx_rows.toLocaleString():'—')+'</td><td>'+t.total_mb+'</td>' +
        '<td style="width:90px"><span class="tbar" style="width:'+w+'%"></span></td></tr>';
    }).join('');
    out += '<div class="card"><div class="lbl">各表大小排行（餐廳的表也在這）</div>' +
      '<table><tr><th>Table</th><th>Rows</th><th>MB</th><th></th></tr>'+rows+'</table></div>';
  }
  // Users
  var u = s.users || {}, en = s.entries || {};
  out += '<div class="card"><div class="lbl">使用者 / 紀錄</div>' +
    '<div class="muted" style="font-size:.82em;line-height:1.8">使用者 '+ (u.total||0) +'（有資料 '+(u.with_entries||0)+'、近 7 天活躍 '+(u.active_7d||0)+'）<br>' +
    '航班總筆數 '+ (en.total||0) +'（confirmed '+((en.by_status||{}).confirmed||0)+' / draft '+((en.by_status||{}).draft||0)+'）</div></div>';
  // V1.3.30：近期成長（新增幾人、幾筆航班）
  var rg = s.recent_growth || {};
  out += '<div class="card"><div class="lbl">近期成長</div>' +
    '<div class="muted" style="font-size:.82em;line-height:1.8">近 7 天：<b style="color:#e2e8f0">+'+(rg.new_users_7d||0)+'</b> 人、<b style="color:#e2e8f0">+'+(rg.new_entries_7d||0)+'</b> 筆航班<br>' +
    '近 30 天：<b style="color:#e2e8f0">+'+(rg.new_users_30d||0)+'</b> 人、<b style="color:#e2e8f0">+'+(rg.new_entries_30d||0)+'</b> 筆航班</div></div>';
  // top users（匿名：只排名 + 筆數，不顯示 email / id，避免無密碼下外洩）
  var tu = b.top_users_by_entries || [];
  if(tu.length){
    var urows = tu.map(function(x, i){ return '<tr><td>#'+(i+1)+'</td><td>'+x.entry_count+'</td><td>'+x.aircraft_count+'</td></tr>'; }).join('');
    out += '<div class="card"><div class="lbl">Top users（匿名排名）</div><table><tr><th>#</th><th>Flights</th><th>Aircraft</th></tr>'+urows+'</table></div>';
  }
  out += '<div style="text-align:center;margin:6px 0 20px"><button onclick="load()">↻ 重新整理</button></div>';
  el('out').innerHTML = out;
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
// ── V1.3.30：Owner 登入看逐人用量（複用 pilot-log 的 Google 登入）────────────
var OW = { token:null, clientId:null };
async function ocfg(){ if(OW.clientId)return OW.clientId; try{var r=await fetch('/api/pilot-log/config');var j=await r.json();OW.clientId=j.google_client_id;return OW.clientId;}catch(e){return null;} }
function ogis(){ if(window.google&&google.accounts&&google.accounts.id)return Promise.resolve(); if(window._g)return window._g; window._g=new Promise(function(res,rej){var s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.defer=true;s.onload=res;s.onerror=rej;document.head.appendChild(s);}); return window._g; }
async function ologinInit(){ var c=await ocfg(); if(!c){ el('ologin').textContent='(無 client id)'; return; } try{ await ogis(); google.accounts.id.initialize({client_id:c,callback:oOnCred,auto_select:false}); el('ologin').innerHTML=''; google.accounts.id.renderButton(el('ologin'),{theme:'filled_blue',size:'large',text:'signin_with',shape:'pill'}); }catch(e){ el('ologin').innerHTML='<span class="err">登入元件載入失敗</span>'; } }
async function oOnCred(resp){ el('omsg').textContent='登入中…'; try{ var r=await fetch('/api/pilot-log/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:resp.credential})}); if(!r.ok){ el('omsg').innerHTML='<span class="err">登入失敗 '+r.status+'</span>'; return; } var j=await r.json(); OW.token=j.accessToken; oLoadUsers(); }catch(e){ el('omsg').innerHTML='<span class="err">'+(e&&e.message||'error')+'</span>'; } }
async function oLoadUsers(){ el('omsg').textContent='查詢中…'; try{ var r=await fetch('/api/pilot-log/oops/users',{headers:{'Authorization':'Bearer '+OW.token}}); if(r.status===403){ OW.token=null; el('ologin').style.display=''; el('omsg').innerHTML='<span class="err">這個帳號不是擁有者，請換一個擁有者帳號登入</span>'; return; } if(!r.ok){ el('omsg').innerHTML='<span class="err">查詢失敗 '+r.status+'</span>'; return; } var j=await r.json(); el('ologin').style.display='none'; oRenderUsers(j.users||[]); el('omsg').textContent='共 '+(j.users||[]).length+' 人 · 依佔用空間大到小'; }catch(e){ el('omsg').innerHTML='<span class="err">'+(e&&e.message||'error')+'</span>'; } }
function oRenderUsers(us){ if(!us.length){ el('ousers').innerHTML='<div class="muted">沒有使用者</div>'; return; } var max=us[0].kb||1; var rows=us.map(function(x){ var w=Math.max(2,Math.round((x.kb/max)*100)); var size=(x.mb>=0.1)?(x.mb+' MB'):(x.kb+' KB'); return '<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis">'+esc(x.email)+'</td><td>'+size+'</td><td>'+x.entry_count+'</td><td>'+(x.created_at||'—')+'</td><td style="width:64px"><span class="tbar" style="width:'+w+'%"></span></td></tr>'; }).join(''); el('ousers').innerHTML='<table><tr><th>Email</th><th>空間</th><th>航班</th><th>加入</th><th></th></tr>'+rows+'</table>'; }
// 一開頁就自動查詢（無密碼）
load();
ologinInit();
</script>
</body></html>`;
// TODO(V8.0.45)：舊 /pilot-log/oops DB-admin 頁已整合進 /tower（owner 登入），route 改 302 轉址。
// 此頁 HTML 暫留備查（遵守「刪碼留 TODO」），確認 /tower 穩定後可移除整段 const。
void _OOPS_PAGE_RETIRED;

// ══ 🐵 封閉測試招募（monkey）════════════════════════════════════════════════
// 招募頁 /monkey（刻意不放 /pilot-log 底下）；報名 / 名額 API；owner 後台 /monkey/admin。

// 名額計數（公開計數器；無 PII）
pilotLogRouter.get('/api/pilot-log/monkey/slots', async (_req, res) => {
  try { res.json(await getSlots()); }
  catch { res.status(503).json({ error: 'unavailable' }); }
});

// 報名：驗 Google idToken → email + 驗通關碼 + 算名額（滿了轉候補）
pilotLogRouter.post('/api/pilot-log/monkey/apply', async (req, res) => {
  const b = req.body || {};
  if (!b.idToken || typeof b.idToken !== 'string') return res.status(400).json({ error: 'missing_id_token' });
  const verified = await verifyGoogleIdToken(b.idToken);
  if (!verified) return res.status(401).json({ error: 'bad_token' });
  const result = await applyApplicant({
    email: verified.email,
    code: typeof b.code === 'string' ? b.code : '',
    fleet: typeof b.fleet === 'string' ? b.fleet : undefined,
    usesSync: typeof b.usesSync === 'boolean' ? b.usesSync : undefined,
    logbook: typeof b.logbook === 'string' ? b.logbook : undefined,
    logbookOther: typeof b.logbookOther === 'string' ? b.logbookOther : undefined,
  });
  if (!result.ok) {
    if (result.error === 'closed') return res.status(403).json({ error: 'closed' });
    if (result.error === 'bad_code') return res.status(403).json({ error: 'bad_code' });
    return res.status(503).json({ error: 'db' });
  }
  res.json({ ok: true, status: result.status, already: !!result.already, email: verified.email });
});

// 後台（owner 登入後）：列名單 / 加朋友 / 刪一筆。emails=PII，故走 owner 驗證，不放在無密碼的 /oops。
async function _plRequireOwner(req: AuthedRequest, res: express.Response): Promise<boolean> {
  if (!(await isOwnerUserId(req.pilotUserId!))) { res.status(403).json({ error: 'not_owner' }); return false; }
  return true;
}

pilotLogRouter.get('/api/pilot-log/monkey/admin/list', requireAuth, async (req: AuthedRequest, res) => {
  if (!(await _plRequireOwner(req, res))) return;
  res.json({ applicants: await listApplicants(), slots: await getSlots() });
});

pilotLogRouter.post('/api/pilot-log/monkey/admin/friend', requireAuth, async (req: AuthedRequest, res) => {
  if (!(await _plRequireOwner(req, res))) return;
  const email = req.body?.email;
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'missing_email' });
  const r = await addFriend(email);
  if (!r.ok) return res.status(400).json({ error: 'invalid_email' });
  res.json({ ok: true, already: !!r.already });
});

pilotLogRouter.delete('/api/pilot-log/monkey/admin/:id', requireAuth, async (req: AuthedRequest, res) => {
  if (!(await _plRequireOwner(req, res))) return;
  res.json({ ok: await removeApplicant(req.params.id) });
});

// ── 整合 owner 後台：跨 App 用戶總覽（owner Google 登入才看，含 PII；不放 pw 網址）──────
// 一次查同一個 DB 的三個 App：Pilot Log（標 ⭐founder＝email 在報名名單裡＝創始測試者）、CrewSync、Morning。
pilotLogRouter.get('/api/pilot-log/admin/all-users', requireAuth, async (req: AuthedRequest, res) => {
  if (!(await _plRequireOwner(req, res))) return;
  const pool = getPool();
  // 比照其他 Pilot Log endpoint：先 ensureTables，避免全新/未初始化環境 SELECT 撞表不存在 → 500
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  try {
    const pilot = await pool.query(`
      SELECT u.id, u.created_at, u.last_login_at, u.last_seen_at, u.last_import_at,
        (SELECT array_agg(e.email ORDER BY e.is_primary DESC, e.linked_at) FROM pilot_user_emails e WHERE e.user_id = u.id) AS emails,
        EXISTS(SELECT 1 FROM pilot_user_emails e JOIN pilot_beta_applicants a ON LOWER(a.email) = LOWER(e.email) WHERE e.user_id = u.id) AS founder,
        (SELECT COUNT(*)::int FROM pilot_log_entries pe WHERE pe.user_id = u.id) AS entries,
        (SELECT COUNT(*)::int FROM pilot_log_entries pe WHERE pe.user_id = u.id AND pe.in_utc IS NOT NULL) AS flown,
        -- V2.1.09：來源細項改「資料驅動」（動態 GROUP BY source）—— 以後加任何 logbook 來源
        -- Tower 自動就有，不用再手改。前端用 label 對照表顯示（沒對到就顯示原始 key）。
        (SELECT COALESCE(json_object_agg(source, cnt), '{}'::json)
           FROM (SELECT source, COUNT(*)::int AS cnt FROM pilot_log_entries pe WHERE pe.user_id = u.id GROUP BY source) s
         ) AS sources,
        (SELECT COUNT(*)::int FROM pilot_aircraft pa WHERE pa.user_id = u.id) AS aircraft,
        (SELECT COUNT(*)::int FROM crew c WHERE c.user_id = u.id) AS crew
      FROM pilot_users u ORDER BY u.created_at DESC`);
    const cs = await pool.query(`
      SELECT email, name, nickname, rank, fleet, sharing, employee_id, (picture IS NOT NULL) AS has_pic,
        created_at, updated_at,
        (SELECT COUNT(*)::int FROM cs_rosters r WHERE r.employee_id = cs_users.employee_id) AS rosters
      FROM cs_users ORDER BY created_at DESC`).catch(() => ({ rows: [] as any[] }));
    // 隱私界線：只撈 user_id + 時間，不撈 prefs（內含 watchlist/holdings/portfolio_pin_hash 等私人內容）。
    // V2.1.09：用 last_seen_at（開 app 時間）當「最後使用」，沒有才退 updated_at（改設定時間）—— 別名成
    // updated_at，前端顯示與活躍計算（都讀 updated_at）自動拿到正確值，不必改前端。
    const mr = await pool.query(
      `SELECT user_id, COALESCE(last_seen_at, updated_at) AS updated_at FROM morning_prefs
       ORDER BY COALESCE(last_seen_at, updated_at) DESC NULLS LAST`
    ).catch(() => ({ rows: [] as any[] }));
    // Groups：各群人數 / 類型(preset/custom) / 建立者 / 邀請碼 / 建立時間
    const groups = await pool.query(`
      SELECT g.id, g.name, g.type, g.created_by, g.invite_code, g.created_at,
        (SELECT COUNT(*)::int FROM cs_group_members gm WHERE gm.group_id = g.id) AS members
      FROM cs_groups g ORDER BY members DESC, g.created_at`).catch(() => ({ rows: [] as any[] }));
    const sharingCount = cs.rows.filter((u: any) => u.sharing).length;   // friends = 有開分享(sharing=true)的人數
    const dbsize = await pool.query(
      `SELECT db_total_bytes, pilot_log_bytes, restaurant_etc_bytes, captured_at
       FROM pilot_db_size_history ORDER BY captured_at DESC LIMIT 30`
    ).catch(() => ({ rows: [] as any[] }));
    // V9.5.02：全體聚合 —— 匯入來源分布 + 機型排行（純統計、無 PII；補上 Tower 移除額度卡後的空位）。
    const srcAgg = await pool.query(
      `SELECT source, COUNT(*)::int AS n FROM pilot_log_entries GROUP BY source ORDER BY n DESC`
    ).catch(() => ({ rows: [] as any[] }));
    const acAgg = await pool.query(
      `SELECT aircraft_type AS t, COUNT(*)::int AS n FROM pilot_log_entries
       WHERE COALESCE(aircraft_type,'') <> '' GROUP BY aircraft_type ORDER BY n DESC LIMIT 8`
    ).catch(() => ({ rows: [] as any[] }));
    res.json({
      pilot: { count: pilot.rows.length, users: pilot.rows },
      crewsync: { count: cs.rows.length, sharing: sharingCount, users: cs.rows },
      morning: { count: mr.rows.length, users: mr.rows },
      groups: { count: groups.rows.length, list: groups.rows },
      // 整庫 / pilot-log / 餐廳+其他 大小快照（最新 + 最近 30 筆，前端算成長速度、推估到 1GB）
      db: { latest: dbsize.rows[0] || null, history: dbsize.rows },
      // V9.5.02：全體匯入來源分布 + 機型排行（統計）
      stats: { sources: srcAgg.rows, aircraft: acAgg.rows },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 招募頁 /monkey ───────────────────────────────────────────────────────────
pilotLogRouter.get('/monkey', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(_renderMonkeyHtml());
});

// ── owner 後台 /monkey/admin（owner Google 登入後看名單）─────────────────────
pilotLogRouter.get('/monkey/admin', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.send(_renderMonkeyAdminHtml());
});

// ── Quick suggest ────────────────────────────────────────────────────────────
// 常用 tail / type / airport / crew name，給編輯器 autocomplete 用
pilotLogRouter.get('/api/pilot-log/quick-suggest', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;

  const [tails, types, airports] = await Promise.all([
    pool.query(
      `SELECT tail_no, MAX(updated_at) AS t FROM pilot_log_entries
       WHERE user_id = $1 AND tail_no IS NOT NULL
       GROUP BY tail_no ORDER BY t DESC LIMIT 30`,
      [userId]
    ),
    pool.query(
      `SELECT aircraft_type, MAX(updated_at) AS t FROM pilot_log_entries
       WHERE user_id = $1 AND aircraft_type IS NOT NULL
       GROUP BY aircraft_type ORDER BY t DESC LIMIT 20`,
      [userId]
    ),
    pool.query(
      `SELECT a AS code, MAX(t) AS t FROM (
         SELECT origin AS a, updated_at AS t FROM pilot_log_entries WHERE user_id = $1 AND origin IS NOT NULL
         UNION ALL
         SELECT dest AS a, updated_at AS t FROM pilot_log_entries WHERE user_id = $1 AND dest IS NOT NULL
       ) x GROUP BY a ORDER BY t DESC LIMIT 60`,
      [userId]
    ),
  ]);

  res.json({
    tail_nos: tails.rows.map(r => r.tail_no),
    aircraft_types: types.rows.map(r => r.aircraft_type),
    airports: airports.rows.map(r => r.code),
  });
});

// ══ 🐵 招募頁 HTML ════════════════════════════════════════════════════════════
// 接上：名額計數（/monkey/slots）+ Google 登入（/config + GSI）+ 報名（/monkey/apply）。
// 視覺沿用 Pilot Log 夜間主題；通關碼 = 社群置頂那組（後端比對 PILOT_LOG_MONKEY_CODE）。
function _renderMonkeyHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0e1a">
<title>來當實驗猴 · Pilot Log 封閉測試</title>
<style>
:root{ --bg:#0a0e1a; --card:#1a1f2e; --text:#e2e8f0; --muted:#94a3b8; --border:#334155; --accent:#3b82f6; --accent2:#22c55e; --warn:#f59e0b; --input-bg:#0a0e1a; }
*{box-sizing:border-box;} html{font-size:15px;}
body{ margin:0; background: radial-gradient(1200px 600px at 50% -10%, rgba(59,130,246,.18), transparent 60%), var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; line-height:1.6; min-height:100vh; padding:env(safe-area-inset-top) 18px calc(40px + env(safe-area-inset-bottom)); }
.wrap{max-width:520px; margin:0 auto;}
.hero{text-align:center; padding:42px 0 14px;}
.hero .pig{font-size:72px; line-height:1; filter:drop-shadow(0 8px 24px rgba(0,0,0,.4));}
.hero h1{font-size:1.9em; margin:14px 0 6px; letter-spacing:.5px;}
.hero .en{color:var(--muted); font-size:.9em; letter-spacing:1px; text-transform:uppercase;}
.hero .lead{margin:16px auto 0; max-width:430px; color:var(--text); font-size:1.02em;}
.hero .lead b{color:#fff;}
.hero .pun{margin:12px auto 0; max-width:420px; font-size:.78em; color:var(--muted); font-style:italic;}
.slots{ margin:26px auto; max-width:360px; background:linear-gradient(180deg, rgba(59,130,246,.12), rgba(59,130,246,.04)); border:1px solid var(--accent); border-radius:16px; padding:18px 20px; text-align:center; }
.slots .label{font-size:.78em; color:var(--muted); letter-spacing:.5px;}
.slots .num{font-size:2.6em; font-weight:800; color:#fff; line-height:1.1; margin:2px 0;}
.slots .num small{font-size:.34em; font-weight:600; color:var(--muted); vertical-align:middle;}
.slots .bar{height:8px; border-radius:4px; background:rgba(255,255,255,.08); overflow:hidden; margin:10px 0 4px;}
.slots .bar > i{display:block; height:100%; background:linear-gradient(90deg,var(--accent),#60a5fa); border-radius:4px; transition:width .4s;}
.slots .sub{font-size:.74em; color:var(--muted);}
.card{ background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px 18px 16px; margin:14px 0; }
.card h3{margin:0 0 12px; font-size:1.02em; display:flex; align-items:center; gap:8px;}
.deal{list-style:none; padding:0; margin:0;}
.deal li{display:flex; gap:10px; padding:7px 0; font-size:.92em; align-items:flex-start;}
.deal li .ic{flex:0 0 auto; font-size:1.1em; line-height:1.4;}
.deal li b{color:#fff;}
.deal li.warn .ic{color:var(--warn);}
.muted-en{color:var(--muted); font-size:.82em; margin-top:2px;}
label.q{display:block; font-size:.86em; color:var(--text); margin:14px 0 6px; font-weight:600;}
label.q span{color:var(--muted); font-weight:400; font-size:.92em;}
select,input[type=email],input[type=text]{ width:100%; background:var(--input-bg); color:var(--text); border:1px solid var(--border); border-radius:9px; padding:11px 12px; font-size:.95em; -webkit-appearance:none; }
.chk{display:flex; gap:9px; align-items:flex-start; margin:14px 0 4px; font-size:.86em; color:var(--muted);}
.chk input{margin-top:3px; transform:scale(1.2);}
.note{font-size:.74em; color:var(--muted); text-align:center; margin-top:12px; line-height:1.5;}
.mkmsg{font-size:.8em; text-align:center; margin:10px 0 0; min-height:1.2em;}
.mkmsg.err{color:#fca5a5;} .mkmsg.ok{color:var(--accent2);}
#mk-gsi-btn{display:flex; justify-content:center; margin-top:16px; min-height:44px;}
.done{text-align:center; padding:10px 4px;}
.done .big{font-size:1.5em; font-weight:800; margin-bottom:8px;}
.done .openbtn{display:inline-block; margin-top:16px; text-decoration:none; background:var(--accent); color:#fff; font-weight:700; font-size:.95em; padding:12px 22px; border-radius:10px;}
.foot{text-align:center; color:var(--muted); font-size:.72em; margin-top:30px; line-height:1.7;}
.foot .ver{opacity:.6;}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div class="pig">🐵</div>
    <h1>來當實驗猴</h1>
    <div class="en">Be a Test Monkey</div>
    <p class="lead">
      都說<b>猴子也能開飛機</b> —— 那測個 App 應該也難不倒你。<br>
      <b>Pilot Log</b> 正在找<b>創始測試員</b>：亂點、狂用、踩到雷就吱一聲。
    </p>
    <p class="pun">* 巧的是，工程師管「亂點亂測找 bug」也真的叫 monkey testing。天選之猴，就是你。</p>
  </div>

  <div class="slots">
    <div class="label">創始測試員名額</div>
    <div class="num" id="mkNum">10 <small>席</small></div>
    <div class="bar"><i id="mkBar" style="width:0%"></i></div>
    <div class="sub" id="mkSub">名額查詢中…</div>
  </div>

  <div class="card">
    <h3>🤝 這場交易</h3>
    <ul class="deal">
      <li><span class="ic">🎁</span><div><b>你拿到：</b>創始會員資格，這個 App 永久免費用。<div class="muted-en">Founding member — free forever.</div></div></li>
      <li><span class="ic">🍌</span><div><b>你要做：</b>認真用、踩到 bug 或有想法，到社群直接講。<div class="muted-en">Use it, report bugs &amp; ideas in the community.</div></div></li>
      <li class="warn"><span class="ic">⚠️</span><div><b>醜話先說：</b>登入後完全沒在用的帳號會被請出名單，由候補遞補。<div class="muted-en">Dead accounts get replaced from the waitlist.</div></div></li>
    </ul>
  </div>

  <div class="card" id="applyCard">
    <h3>✍️ 報名 · 限 10 名</h3>

    <div style="background:rgba(6,199,85,.08); border:1px solid #06C755; border-radius:10px; padding:13px 14px; margin-bottom:16px">
      <div style="font-size:.84em; font-weight:700; margin-bottom:5px">① 先進測試員社群，拿「通關碼」</div>
      <div style="font-size:.73em; color:var(--muted); line-height:1.5; margin-bottom:10px">
        通關碼藏在社群<b style="color:var(--text)">置頂訊息</b>裡，下面報名要填。<b style="color:var(--warn)">拿不到碼＝送不出報名</b> —— 所以非進不可。可用暱稱，不必露出本尊 LINE。<br>
        Code is pinned in the community. No code, no signup. Nicknames OK.
      </div>
      <a href="https://line.me/ti/g2/ArAw4k1D9vXEAMtBsButFLzSFjXzEvFXfKHQ2A?utm_source=invitation&utm_medium=link_copy&utm_campaign=default"
         target="_blank" rel="noopener"
         style="display:flex; align-items:center; justify-content:center; gap:8px; text-decoration:none; background:#06C755; color:#fff; font-weight:700; font-size:.92em; padding:11px; border-radius:9px;">
        💬 進測試員社群拿通關碼
      </a>
    </div>

    <label class="q">② 飛哪個機隊？ <span>Which fleet?</span></label>
    <select id="qFleet">
      <option value="">請選擇…</option>
      <option>A321</option>
      <option>A330</option>
      <option>A350</option>
    </select>

    <label class="q">③ 你目前有在用班表同步嗎？ <span>Using roster sync?</span></label>
    <select id="qSync" onchange="document.getElementById('qSyncNote').style.display = this.value.indexOf('有')===0 ? 'block' : 'none'">
      <option value="">請選擇…</option>
      <option>有 — 我有在用班表同步</option>
      <option>沒有 / 不知道那是什麼</option>
    </select>
    <div id="qSyncNote" style="display:none; margin-top:8px; font-size:.75em; color:var(--text); line-height:1.55; background:rgba(245,158,11,.08); border:1px solid rgba(245,158,11,.35); border-radius:8px; padding:10px 12px">
      ⚠️ <b>重要：</b>報名請用<b style="color:var(--warn)">跟班表同步「同一個」Google 帳號</b>登入，<br>否則你的班表帶不進 Pilot Log。<br>
      <span style="color:var(--muted)">Sign up with the <b>same Google account</b> you use for roster sync.</span>
      <div style="margin-top:7px">班表同步在 👉 <a href="https://oops.h-peak.com/main" target="_blank" rel="noopener" style="color:var(--accent); font-weight:700">oops.h-peak.com/main</a></div>
    </div>

    <label class="q">④ 現在用什麼記 logbook？ <span>Current logbook?</span></label>
    <select id="qLog" onchange="document.getElementById('qLogOther').style.display = this.value==='其他' ? 'block' : 'none'">
      <option value="">請選擇…</option>
      <option>沒在記 / 偶爾記</option>
      <option>紙本 Paper</option>
      <option>Excel / 試算表自製</option>
      <option>LogTen Pro</option>
      <option>logATP2</option>
      <option>ForeFlight Logbook</option>
      <option>APDL（Airline Pilot Logbook）</option>
      <option>CrewLounge / MccPILOTLOG</option>
      <option>MyFlightbook</option>
      <option>Logbook Pro</option>
      <option>其他</option>
    </select>
    <input type="text" id="qLogOther" placeholder="是哪一套軟體？ Which app?" style="display:none; margin-top:8px;">

    <label class="q">⑤ 社群通關碼 <span>Community code</span></label>
    <input type="text" id="qCode" placeholder="社群置頂訊息裡的通關碼" autocapitalize="characters">

    <label class="chk">
      <input type="checkbox" id="qCommit">
      <span>我願意認真試用，並在社群裡回報問題與想法。<br>I'll use it &amp; report back in the community.</span>
    </label>

    <div id="mkMsg" class="mkmsg"></div>
    <div id="mk-gsi-btn"></div>
    <div class="note">⑥ 用 Google 登入送出報名 —— 綁定你的帳號，之後就用<b>同一個帳號</b>登入 App。</div>
  </div>

  <div class="foot">
    Pilot Log · 飛行記錄本 · 封閉測試<br>
    <span class="ver">Cross-device · 永久保存 · 絕不過期</span>
  </div>
</div>

<script>
function mkEl(id){ return document.getElementById(id); }
function mkVal(id){ var e=mkEl(id); return e ? (e.value||'').trim() : ''; }
function mkMsg(t, cls){ var m=mkEl('mkMsg'); m.textContent=t||''; m.className='mkmsg'+(cls?(' '+cls):''); }
function mkB(n){ return '<b style="color:#fff">'+n+'</b>'; }
function mkSubText(left){
  if(left<=0) return '公開名額已滿 · 仍可報名'+mkB('候補');
  if(left===1) return mkB('最後一席')+' · 你是天選之人，搶到最後一個名額 🐵';
  if(left===2) return '最後 '+mkB(2)+' 席 · 再猶豫就沒了';
  if(left===3) return '最後 '+mkB(3)+' 席 · 慢來就沒了';
  if(left===4) return '還剩 '+mkB(4)+' 席 · 先搶先贏';
  return '僅剩 '+mkB(left)+' 席 · 先搶先贏';
}

var MK = { clientId:null };

async function mkLoadSlots(){
  try{
    var r = await fetch('/api/pilot-log/monkey/slots');
    if(!r.ok) return;
    var s = await r.json();
    mkEl('mkNum').innerHTML = s.total + ' <small>席</small>';
    var takenPct = s.publicCap>0 ? Math.round((s.publicCap - s.left)/s.publicCap*100) : 0;
    mkEl('mkBar').style.width = Math.min(100, takenPct) + '%';
    if(s.open === false){
      mkEl('mkSub').innerHTML = '報名已截止 · Signups closed';
      var card = mkEl('applyCard');
      if(card) card.innerHTML = '<div class="done"><div class="big">🙏 報名已截止</div><div style="color:var(--muted);font-size:.92em;line-height:1.6">這一梯創始測試員已招滿，謝謝你的興趣！<br>下一梯開放會在社群公告。<br><span style="font-size:.88em">This round is full — thanks! Next round will be announced in the community.</span></div></div>';
      return false;
    }
    mkEl('mkSub').innerHTML = mkSubText(s.full ? 0 : s.left);
    return true;
  }catch(e){}
}

async function mkLoadConfig(){
  if(MK.clientId) return MK.clientId;
  try{ var r=await fetch('/api/pilot-log/config'); var j=await r.json(); MK.clientId=j.google_client_id; return MK.clientId; }
  catch(e){ return null; }
}
function mkLoadGis(){
  if(window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
  if(window._mkGis) return window._mkGis;
  window._mkGis = new Promise(function(resolve,reject){
    var s=document.createElement('script'); s.src='https://accounts.google.com/gsi/client'; s.async=true; s.defer=true;
    s.onload=resolve; s.onerror=function(){reject(new Error('gis'));}; document.head.appendChild(s);
  });
  return window._mkGis;
}
async function mkInitSignIn(){
  var clientId = await mkLoadConfig();
  if(!clientId){ mkMsg('Google 載入失敗，稍後再試','err'); return; }
  try{ await mkLoadGis(); }catch(e){ mkMsg('Google 載入失敗，稍後再試','err'); return; }
  google.accounts.id.initialize({ client_id:clientId, callback:mkOnCredential, auto_select:false, cancel_on_tap_outside:true });
  var host=mkEl('mk-gsi-btn');
  if(host){ host.innerHTML=''; google.accounts.id.renderButton(host,{ theme:'filled_blue', size:'large', text:'continue_with', shape:'pill', logo_alignment:'left' }); }
}

async function mkOnCredential(resp){
  if(!resp || !resp.credential) return;
  // 先驗表單必填
  var code=mkVal('qCode'), fleet=mkVal('qFleet'), sync=mkVal('qSync');
  if(!fleet){ mkMsg('請先選機隊','err'); return; }
  if(!code){ mkMsg('請先填社群通關碼（社群置頂訊息裡）','err'); return; }
  if(!mkEl('qCommit').checked){ mkMsg('請勾選願意試用並回報','err'); return; }
  mkMsg('報名中…');
  var logbook=mkVal('qLog');
  var body={
    idToken: resp.credential, code: code, fleet: fleet,
    usesSync: sync ? (sync.indexOf('有')===0) : null,
    logbook: logbook || null,
    logbookOther: logbook==='其他' ? mkVal('qLogOther') : null
  };
  var r, j;
  try{
    r = await fetch('/api/pilot-log/monkey/apply', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    j = await r.json().catch(function(){ return {}; });
  }catch(e){ mkMsg('連線失敗，稍後再試','err'); return; }
  if(r.status===403 && j.error==='bad_code'){ mkMsg('通關碼不對 — 請確認社群置頂的那組','err'); return; }
  if(r.status===401){ mkMsg('Google 驗證失敗，請重試','err'); return; }
  if(!r.ok){ mkMsg('報名失敗，稍後再試','err'); return; }
  mkShowDone(j);
}

function mkShowDone(j){
  var card=mkEl('applyCard');
  var html='<div class="done">';
  if(j.already){
    html += '<div class="big">🐵 你已經報名過囉</div><div style="color:var(--muted);font-size:.9em">用同一個帳號（'+ (j.email||'') +'）直接登入 App 就好。</div>';
  } else if(j.status==='waitlist'){
    html += '<div class="big" style="color:var(--warn)">🈵 公開名額剛好滿了</div><div style="color:var(--muted);font-size:.9em">你已進<b style="color:#fff">候補名單</b>，有人空出來會在社群通知你，別退社群！</div>';
  } else {
    html += '<div class="big" style="color:var(--accent2)">✅ 報名成功！</div><div style="color:var(--muted);font-size:.9em">你已是創始測試員（'+ (j.email||'') +'）。記得<b style="color:#fff">用同一個 Google 帳號</b>登入 App，回報都在社群裡。</div>';
    html += '<a class="openbtn" href="/pilot-log">📒 打開 Pilot Log</a>';
  }
  html += '</div>';
  card.innerHTML = html;
  mkLoadSlots();
  card.scrollIntoView({behavior:'smooth', block:'center'});
}

async function mkInit(){ var open = await mkLoadSlots(); if(open !== false) mkInitSignIn(); }
document.addEventListener('DOMContentLoaded', mkInit);
if(document.readyState!=='loading') mkInit();
</script>
</body>
</html>`;
}

// ══ 🗼 整合 owner 後台 /tower ════════════════════════════════════════════════
// owner Google 登入 → 一頁看三個 App 全部用戶（CrewSync / Pilot Log[⭐founder] / Morning）
// + Groups + DB 用量（取代 /oops）。PWA（可加到主畫面）+ 重新整理鈕。含 PII，走 owner 驗證。
pilotLogRouter.get('/tower', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.send(_renderTowerHtml());
});
pilotLogRouter.get('/tower/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.json({
    name: 'H-Peak Tower', short_name: 'Tower', start_url: '/tower', scope: '/tower',
    display: 'standalone', background_color: '#0a0e1a', theme_color: '#0a0e1a',
    icons: [{ src: '/tower/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
});
// ── /tower/icon.svg — Tower 專屬圖示（天際線 / skyline，跟 Pilot Log 記錄本區分）──
const _TOWER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="twrBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0a0e1a"/><stop offset="100%" stop-color="#1e293b"/></linearGradient>
    <linearGradient id="twrCv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#twrBg)"/>
  <rect x="150" y="404" width="212" height="14" rx="7" fill="#1e3a5f"/>
  <rect x="150" y="280" width="48" height="124" rx="8" fill="url(#twrCv)" opacity=".7"/>
  <rect x="214" y="210" width="52" height="194" rx="8" fill="url(#twrCv)"/>
  <rect x="282" y="248" width="48" height="156" rx="8" fill="url(#twrCv)" opacity=".82"/>
  <rect x="334" y="312" width="34" height="92" rx="7" fill="url(#twrCv)" opacity=".55"/>
  <rect x="232" y="170" width="16" height="44" fill="#cbd5e1"/>
  <circle cx="240" cy="166" r="10" fill="#fbbf24"/>
</svg>`;
pilotLogRouter.get('/tower/icon.svg', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(_TOWER_ICON_SVG);
});
// ── /tower/sw.js — Tower 後台離線 SW（scope: /tower）──────────────────────────
// 只快取殼（HTML/manifest/icon）讓離線開得起來；所有 /api 一律走網路（auth + PII 絕不快取）。
pilotLogRouter.get('/tower/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/tower');
  res.send(`
const CACHE = 'tower-${PILOT_LOG_CACHE}';
const SHELL = ['/tower', '/tower/manifest.json', '/tower/icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(url =>
    fetch(url, {cache:'no-store'}).then(r => c.put(url, r)).catch(()=>{})
  ))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k.startsWith('tower-') && k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (!u.pathname.startsWith('/tower')) return;          // 只接管 /tower 殼
  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(r => {
        caches.open(CACHE).then(c => c.put(e.request, r.clone())).catch(()=>{});
        return r;
      }).catch(() => cached);
      return cached || net;                               // 殼 cache 優先 + 背景更新
    })
  );
});
`);
});

function _renderTowerHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0a0e1a">
<link rel="manifest" href="/tower/manifest.json"><meta name="apple-mobile-web-app-capable" content="yes">
<link rel="icon" href="/tower/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/tower/icon.svg">
<title>🗼 Tower · H-Peak 後台</title>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:#0a0e1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans TC',sans-serif;font-size:15px;line-height:1.45}
  .wrap{max-width:1100px;margin:0 auto;padding:max(16px,env(safe-area-inset-top)) 16px 60px}
  .top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px}
  h1{font-size:1.25em;margin:0}.who{color:#94a3b8;font-size:.78em}
  .ghost{background:transparent;border:1px solid #334155;color:#cbd5e1;border-radius:8px;padding:6px 11px;font-size:.78em;font-weight:700;cursor:pointer}
  .dash{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
  .card{background:#111827;border:1px solid #1f2a3d;border-radius:12px;padding:12px 14px}
  .card .lbl{color:#94a3b8;font-size:.72em;font-weight:700;letter-spacing:.3px}.card .big{font-size:1.7em;font-weight:800;margin-top:2px}
  .card .sub{color:#64748b;font-size:.72em;margin-top:2px}.card .seg{display:flex;gap:10px;margin-top:6px;font-size:.74em}.card .seg b{color:#e2e8f0}
  .g{color:#4ade80}.y{color:#fbbf24}.gray{color:#94a3b8}.blue{color:#60a5fa}
  .bar{height:7px;background:#0a0e1a;border-radius:4px;overflow:hidden;margin-top:7px;border:1px solid #1f2a3d}.bar>i{display:block;height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa)}
  .tabs{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
  .tab{background:#111827;border:1px solid #1f2a3d;border-radius:10px;padding:8px 14px;font-size:.85em;font-weight:700;cursor:pointer;color:#cbd5e1}
  .tab.on{background:#1e3a5f;border-color:#3b82f6;color:#fff}.tab .n{color:#60a5fa}
  .ctrl{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .ctrl input{flex:1;min-width:160px;background:#0a0e1a;border:1px solid #1f2a3d;border-radius:9px;padding:8px 11px;color:#e2e8f0;font-size:.85em}
  .ctrl select{background:#0a0e1a;border:1px solid #1f2a3d;border-radius:9px;padding:8px 11px;color:#cbd5e1;font-size:.85em}
  .dist{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .chip{background:#0a0e1a;border:1px solid #1f2a3d;border-radius:8px;padding:5px 10px;font-size:.76em;color:#94a3b8}.chip b{color:#e2e8f0}
  .sec{display:none}.sec.on{display:block}
  .sechdr{display:flex;align-items:baseline;gap:10px;margin:4px 0 10px;flex-wrap:wrap}.sechdr h2{font-size:1.05em;margin:0}.sechdr .cnt{color:#94a3b8;font-size:.82em}
  .row{background:#111827;border:1px solid #1f2a3d;border-radius:12px;padding:12px 14px;margin-bottom:9px}
  .r1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}.dot.g{background:#22c55e}.dot.y{background:#fbbf24}.dot.gray{background:#475569}
  .id{font-weight:700;font-size:.96em;word-break:break-all}.name{color:#cbd5e1;font-size:.85em}
  .badge{font-size:.68em;font-weight:800;padding:1px 7px;border-radius:5px;letter-spacing:.3px}
  .founder{background:#422006;color:#fcd34d;border:1px solid #92590e}.both{background:#1e1b4b;color:#c4b5fd;border:1px solid #4c1d95}
  .rank{background:#0a0e1a;color:#93c5fd;border:1px solid #1e3a5f}.fleet{background:#0a0e1a;color:#86efac;border:1px solid #14532d}
  .on2{background:#052e16;color:#4ade80;border:1px solid #166534}.preset{background:#1e1b4b;color:#c4b5fd;border:1px solid #4c1d95}.custom{background:#0a0e1a;color:#94a3b8;border:1px solid #334155}
  .stats{display:flex;gap:14px;flex-wrap:wrap;margin-top:7px;font-size:.78em;color:#94a3b8}.stats b{color:#e2e8f0;font-weight:700}
  .src{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:.73em}.src span{background:#0a0e1a;border:1px solid #1f2a3d;border-radius:5px;padding:1px 7px;color:#94a3b8}.src b{color:#cbd5e1}
  .t{color:#64748b;font-size:.72em;margin-top:5px}.err{color:#fca5a5}#gsi{margin:14px 0}
  .note{color:#64748b;font-size:.74em;margin-top:22px;line-height:1.6;border-top:1px solid #1f2a3d;padding-top:12px}
</style></head><body><div class="wrap">
  <div class="top"><h1>🗼 Tower</h1><div class="who"><span id="me"></span> <button class="ghost" id="reBtn" style="display:none" onclick="load()">🔄 重新整理</button> <button class="ghost" id="outBtn" style="display:none" onclick="logout()">登出</button></div></div>
  <div id="msg" class="who" style="margin-bottom:10px"></div>
  <div id="login" class="card"><div class="who" style="margin-bottom:6px">擁有者 Google 登入</div><div id="gsi"></div></div>
  <div id="app" style="display:none"></div>
  <div class="note" id="foot" style="display:none">🟢 今日 · 🟡 7天 · ⚪ 久未用。只給 owner 看，收集量+時間+身份+功能使用，不顯示任何私人內容（航班備註/組員姓名/班表內容/晨報細節都不撈）。</div>
</div>
<script>
var T={token:null,clientId:null,data:null,db:null,tab:0,q:'',sort:'active'};
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
// V2.1.09：Tower 時間維持 UTC，但加 Zulu「Z」標示時區（飛行員一看就懂 = UTC）。
function fmtDt(s){if(!s)return'—';var d=new Date(s);if(isNaN(d))return'—';return d.toISOString().slice(0,16).replace('T',' ')+'Z';}
function actDot(s){if(!s)return'gray';var days=(Date.now()-new Date(s).getTime())/864e5;return days<1?'g':days<7?'y':'gray';}
function mb(b){return b==null?'—':(b/1048576).toFixed(b<10485760?1:0)+' MB';}
async function cfg(){if(T.clientId)return T.clientId;try{var r=await fetch('/api/pilot-log/config');var j=await r.json();T.clientId=j.google_client_id;return T.clientId;}catch(e){return null;}}
function gis(){if(window.google&&google.accounts&&google.accounts.id)return Promise.resolve();if(window._g)return window._g;window._g=new Promise(function(res,rej){var s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.defer=true;s.onload=res;s.onerror=rej;document.head.appendChild(s);});return window._g;}
async function initLogin(){var c=await cfg();if(!c){el('msg').innerHTML='<span class=err>Google 載入失敗</span>';return;}await gis();google.accounts.id.initialize({client_id:c,callback:onCred,auto_select:false});google.accounts.id.renderButton(el('gsi'),{theme:'filled_blue',size:'large',text:'signin_with',shape:'pill'});}
async function onCred(resp){if(!resp||!resp.credential)return;el('msg').textContent='登入中…';var r=await fetch('/api/pilot-log/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:resp.credential})});if(!r.ok){el('msg').innerHTML='<span class=err>登入失敗</span>';return;}var j=await r.json();T.token=j.accessToken;try{localStorage.setItem('tower_tk',T.token);}catch(e){}load();}
function logout(){T.token=null;try{localStorage.removeItem('tower_tk');}catch(e){}el('app').style.display='none';el('foot').style.display='none';el('login').style.display='';el('reBtn').style.display='none';el('outBtn').style.display='none';el('me').textContent='';el('msg').textContent='';}
async function api(path){var r=await fetch(path,{headers:{'Authorization':'Bearer '+T.token}});if(r.status===401){logout();el('msg').innerHTML='<span class=err>登入過期，請重新登入</span>';throw new Error('401');}return r;}
async function load(){
  if(!T.token){try{T.token=localStorage.getItem('tower_tk');}catch(e){}if(!T.token){return;}}
  el('msg').textContent='查詢中…';el('login').style.display='none';
  try{
    var r=await api('/api/pilot-log/admin/all-users');
    if(r.status===403){el('msg').innerHTML='<span class=err>這個帳號不是擁有者</span>';el('login').style.display='';return;}
    if(!r.ok){el('msg').innerHTML='<span class=err>查詢失敗 '+r.status+'</span>';return;}
    T.data=await r.json();
    try{var rs=await api('/api/pilot-log/oops/stats?limit=30');if(rs.ok)T.db=await rs.json();}catch(e){}
    try{var ru=await api('/api/pilot-log/oops/users');if(ru.ok){var ju=await ru.json();T.dbusers=ju.users||[];}}catch(e){}
    // TODO（V9.5.02 移除）：ATIS airframes「額度」面板已停用 —— V9.4.18 換匿名 /v1 端點後無 key/無額度，getAtisUsage 恆為空。
    //   原本 try{ /api/atis-usage → T.atis }；連同 dash() 內的「ATIS 額度 · airframes」卡片一併拿掉（後端端點留著、孤兒、無害）。
    el('me').textContent='owner';el('reBtn').style.display='';el('outBtn').style.display='';el('foot').style.display='';el('msg').textContent='';
    T.coffee=null;   // P3：每次重載先清掉舊的，避免後續請求失敗時卡著上次的數據
    render();
    // 站長 API 用量：非阻塞載入（不卡主畫面，回來再補渲染那張卡）。owner-only、server 已濾個資+限時。
    // 非 OK / 例外 → 存失敗狀態（卡片顯示「讀取失敗」），不殘留舊數值。
    api('/api/coffee-usage').then(function(r){return r&&r.ok?r.json():null;}).then(function(j){T.coffee=j||{enabled:true,ok:false};render();}).catch(function(){T.coffee={enabled:true,ok:false};render();});
  }catch(e){}
}
function dash(){
  var d=T.data,p=d.pilot,c=d.crewsync,m=d.morning,gp=d.groups;
  function act(arr,key,days){var n=0,now=Date.now();arr.forEach(function(u){var t=u[key];if(t&&(now-new Date(t).getTime())/864e5<days)n++;});return n;}
  var actToday=act(c.users,'updated_at',1)+act(p.users,'last_seen_at',1)+act(m.users,'updated_at',1);
  var act7=act(c.users,'updated_at',7)+act(p.users,'last_seen_at',7)+act(m.users,'updated_at',7);
  var act30=act(c.users,'updated_at',30)+act(p.users,'last_seen_at',30)+act(m.users,'updated_at',30);
  var newToday=act(c.users,'created_at',1)+act(p.users,'created_at',1);
  // 跨 app 重疊：pilot emails ∩ crewsync emails
  var csSet={};c.users.forEach(function(u){if(u.email)csSet[u.email.toLowerCase()]=1;});
  var overlap=p.users.filter(function(u){return(u.emails||[]).some(function(e){return csSet[(e||'').toLowerCase()];});}).length;
  // 整庫優先用 Render 即時真實磁碟（含 WAL/系統），讀不到退回 DB 內容快照
  var sm=(T.db&&T.db.summary)?T.db.summary:null;
  var snap=(d.db&&d.db.latest)?d.db.latest:null;
  var diskBytes=null,plBytes=null,pct=0;
  if(sm&&sm.render_disk_mb!=null){diskBytes=sm.render_disk_mb*1048576;plBytes=(sm.total_pilot_log_size_mb||0)*1048576;pct=Math.min(100,Math.round(sm.render_disk_pct_of_1gb||0));}
  else if(sm&&sm.all_db_size_mb!=null){diskBytes=sm.all_db_size_mb*1048576;plBytes=(sm.total_pilot_log_size_mb||0)*1048576;pct=Math.min(100,Math.round(sm.db_used_pct_of_1gb||(sm.all_db_size_mb/1024*100)));}
  else if(snap){diskBytes=snap.db_total_bytes;plBytes=snap.pilot_log_bytes;pct=Math.min(100,Math.round(snap.db_total_bytes/10737418.24));}
  return '<div class=dash>'+
    '<div class=card><div class=lbl>總用戶</div><div class=big>'+(p.count+c.count+m.count)+'</div><div class=seg><span>🛬 <b>'+c.count+'</b></span><span>📒 <b>'+p.count+'</b></span><span>🌅 <b>'+m.count+'</b></span></div></div>'+
    '<div class=card><div class=lbl>活躍人數</div><div class="big g">'+actToday+'</div><div class=seg><span class=g>今日 <b>'+actToday+'</b></span><span class=y>7天 <b>'+act7+'</b></span><span class=gray>30天 <b>'+act30+'</b></span></div></div>'+
    '<div class=card><div class=lbl>今日新增</div><div class="big blue">+'+newToday+'</div></div>'+
    '<div class=card><div class=lbl>跨 App 重疊</div><div class=big>'+overlap+'</div><div class=sub>CrewSync + Pilot Log</div></div>'+
    (diskBytes!=null?'<div class=card><div class=lbl>資料庫</div><div class=big>'+mb(diskBytes)+'<span style="font-size:.5em;color:#64748b"> / 1 GB</span></div><div class=bar><i style="width:'+pct+'%"></i></div><div class=sub>'+pct+'% · Pilot Log '+mb(plBytes)+'</div></div>':'')+
    /* V9.5.02：原 ATIS 額度卡（匿名化後恆空）已移除，改放下面兩張全體統計卡。原碼見 git 歷史，後端孤兒端點留著。 */
    (function(){var ss=(d.stats&&d.stats.sources)||[];var sm={};var tot=0;ss.forEach(function(x){sm[x.source]=x.n;tot+=x.n;});
      if(!tot)return '';
      var segs=SRC_ORDER.filter(function(k){return sm[k];}).map(function(k){return '<span>'+SRC_LABELS[k]+' <b>'+sm[k]+'</b></span>';}).join('');
      return '<div class=card><div class=lbl>匯入來源</div><div class=big>'+tot+'</div><div class=seg style="flex-wrap:wrap">'+segs+'</div></div>';})()+
    (function(){var aa=(d.stats&&d.stats.aircraft)||[];
      if(!aa.length)return '';
      var rest=aa.slice(1,6).map(function(x){return '<span>'+esc(x.t)+' <b>'+x.n+'</b></span>';}).join('');
      return '<div class=card><div class=lbl>機型排行</div><div class=big>'+esc(aa[0].t)+'<span style="font-size:.5em;color:#64748b"> '+aa[0].n+'</span></div><div class=seg style="flex-wrap:wrap">'+rest+'</div></div>';})()+
    // 站長 coffee API：我們自己的足跡（只我們、已濾個資）。健康燈：近 1h 偏多 → 黃
    (function(){var cf=T.coffee;if(!cf||!cf.enabled)return '';
      if(!cf.ok)return '<div class=card><div class=lbl>站長 API · 我們</div><div class="big gray">—</div><div class=sub>讀取失敗'+(cf.status?' '+cf.status:'')+'</div></div>';
      var sm=cf.sample||{};var n=(cf.ourCalls24h!=null?cf.ourCalls24h:(sm.count||0));var lh=sm.lastHour||0;var cls=lh>=20?'y':'g';
      var ap=sm.byAirport||{};var apS=Object.keys(ap).sort(function(a,b){return ap[b]-ap[a];}).slice(0,6).map(function(k){return '<span>'+esc(k)+' <b>'+ap[k]+'</b></span>';}).join('')||'<span class=gray>近期無</span>';
      return '<div class=card><div class=lbl>站長 API · 我們</div><div class="big '+cls+'">'+n+'</div><div class=sub>近 24h ｜ 最近 1h(樣本) <b>'+lh+'</b>'+(lh>=20?' ⚠ 偏多':'')+'</div><div class=seg style="flex-wrap:wrap">最近查過 '+apS+'</div></div>';})()+
  '</div>';
}
function filt(arr,keys){var q=T.q.toLowerCase();if(!q)return arr;return arr.filter(function(u){return keys.some(function(k){var v=u[k];if(Array.isArray(v))v=v.join(' ');return String(v||'').toLowerCase().indexOf(q)>=0;});});}
function render(){
  var d=T.data;if(!d){return;}
  var p=d.pilot,c=d.crewsync,m=d.morning,gp=d.groups;
  var h=dash();
  h+='<div class=tabs>'+
    '<div class="tab'+(T.tab===0?' on':'')+'" onclick="setTab(0)">🛬 CrewSync <span class=n>· '+c.count+'</span></div>'+
    '<div class="tab'+(T.tab===1?' on':'')+'" onclick="setTab(1)">📒 Pilot Log <span class=n>· '+p.count+'</span></div>'+
    '<div class="tab'+(T.tab===2?' on':'')+'" onclick="setTab(2)">🌅 Morning <span class=n>· '+m.count+'</span></div>'+
    '<div class="tab'+(T.tab===3?' on':'')+'" onclick="setTab(3)">👥 Groups <span class=n>· '+gp.count+'</span></div>'+
    '<div class="tab'+(T.tab===4?' on':'')+'" onclick="setTab(4)">💾 DB</div>'+
    /* TODO（V9.5.02 移除）：📻 ATIS 分頁已停用（匿名化後額度/誰用紀錄皆空）。 */
  '</div>';
  if(T.tab<3){h+='<div class=ctrl><input placeholder="🔍 搜尋…" value="'+esc(T.q)+'" oninput="T.q=this.value;render()"></div>';}
  if(T.tab===0)h+=secCrew(c);else if(T.tab===1)h+=secPilot(p,c);else if(T.tab===2)h+=secMorning(m);else if(T.tab===3)h+=secGroups(gp);else if(T.tab===4)h+=secDb();
  el('app').style.display='';el('app').innerHTML=h;
}
/* TODO（V9.5.02 移除）：secAtis() ATIS 額度/誰用紀錄分頁已停用 —— V9.4.18 換匿名 /v1 端點後
   getAtisUsage 恆空、cs_atis_who 自 2026-06-08 起不再寫入。原實作見 git 歷史；要恢復「熱門查詢機場」
   需先在抓取路徑重新記錄 who/icao。對應導覽鈕與 dispatch 已一併移除，後端孤兒端點留著、無害。 */
function secCrew(c){
  var fl={},rk={},sh=0;c.users.forEach(function(u){if(u.fleet)fl[u.fleet]=(fl[u.fleet]||0)+1;if(u.rank)rk[u.rank]=(rk[u.rank]||0)+1;if(u.sharing)sh++;});
  var flS=Object.keys(fl).map(function(k){return k+' '+fl[k];}).join(' / ')||'—';
  var rkS=Object.keys(rk).map(function(k){return k+' '+rk[k];}).join(' / ')||'—';
  var rows=filt(c.users,['email','name','nickname','employee_id']).map(function(u){
    return '<div class=row><div class=r1><span class="dot '+actDot(u.updated_at)+'"></span><span class=id>'+esc(u.email)+'</span>'+(u.nickname||u.name?'<span class=name>'+esc(u.nickname||u.name)+'</span>':'')+(u.rank?'<span class="badge rank">'+esc(u.rank)+'</span>':'')+(u.fleet?'<span class="badge fleet">'+esc(u.fleet)+'</span>':'')+(u.sharing?'<span class="badge on2">分享開</span>':'')+'</div>'+
      '<div class=stats><span>員編 <b>'+esc(u.employee_id||'—')+'</b></span><span>班表 <b>'+(u.rosters||0)+'</b> 個月</span><span>大頭照 <b>'+(u.has_pic?'有':'—')+'</b></span></div>'+
      '<div class=t>加入 '+fmtDt(u.created_at)+' · 最後同步 '+fmtDt(u.updated_at)+'</div></div>';
  }).join('');
  return '<div class=dist><span class=chip>機隊 · '+esc(flS)+'</span><span class=chip>職級 · '+esc(rkS)+'</span><span class=chip>開分享 <b class=g>'+sh+'</b> / '+c.count+'</span></div>'+rows;
}
// 來源細項顯示（資料驅動）：label 對照表給友善名稱；沒對到的來源（未來新增）顯示原始 key，
// 所以後端加新來源、Tower 自動就有。順序固定走 SRC_ORDER，其餘未知 key 排後面。
var SRC_LABELS={roster:'班表',logten:'LogTen',wader:'Wader',logatp:'Log ATP 2',manual:'手動'};
var SRC_ORDER=['roster','logten','wader','logatp','manual'];
function srcHtml(s){s=s||{};var seen={};var out=SRC_ORDER.map(function(k){seen[k]=1;return '<span>'+(SRC_LABELS[k]||k)+' <b>'+(s[k]||0)+'</b></span>';});Object.keys(s).forEach(function(k){if(!seen[k])out.push('<span>'+esc(k)+' <b>'+s[k]+'</b></span>');});return out.join('');}
function secPilot(p,c){
  var csSet={};c.users.forEach(function(u){if(u.email)csSet[u.email.toLowerCase()]=1;});
  var fo=0;p.users.forEach(function(u){if(u.founder)fo++;});
  var rows=filt(p.users,['emails']).map(function(u){
    var em=(u.emails||[]).join(', ');var both=(u.emails||[]).some(function(e){return csSet[(e||'').toLowerCase()];});var s=u.sources||{};
    return '<div class=row><div class=r1><span class="dot '+actDot(u.last_seen_at||u.last_login_at)+'"></span><span class=id>'+esc(em||u.id)+'</span>'+(u.founder?'<span class="badge founder">⭐ FOUNDER</span>':'')+(both?'<span class="badge both">＋CrewSync</span>':'')+'</div>'+
      '<div class=stats><span>航班 <b>'+(u.entries||0)+'</b>（飛過 <b>'+(u.flown||0)+'</b>）</span><span>機隊 <b>'+(u.aircraft||0)+'</b></span><span>通訊錄 <b>'+(u.crew||0)+'</b></span></div>'+
      '<div class=src>'+srcHtml(s)+'</div>'+
      '<div class=t>註冊 '+fmtDt(u.created_at)+' · 最後登入 '+fmtDt(u.last_login_at)+' · 最後匯入 '+fmtDt(u.last_import_at)+'</div></div>';
  }).join('');
  return '<div class=dist><span class=chip>⭐ 創始 <b>'+fo+'</b> / '+p.count+'</span></div>'+rows;
}
function secMorning(m){
  var rows=filt(m.users,['user_id']).map(function(u){
    return '<div class=row><div class=r1><span class="dot '+actDot(u.updated_at)+'"></span><span class=id>'+esc(u.user_id)+'</span></div><div class=t>最後使用 '+fmtDt(u.updated_at)+'</div></div>';
  }).join('');
  return rows||'<div class=row><span class=gray>無資料</span></div>';
}
function secGroups(gp){
  var rows=(gp.list||[]).map(function(g){
    return '<div class=row><div class=r1><span class=id>'+esc(g.name)+'</span><span class="badge '+(g.type==='preset'?'preset':'custom')+'">'+(g.type==='preset'?'預設':'自訂')+'</span></div>'+
      '<div class=stats><span>成員 <b>'+(g.members||0)+'</b> 人</span><span>建立者 <b>'+esc(g.created_by||'—')+'</b></span></div>'+
      '<div class=t>邀請碼 '+esc(g.invite_code||'—')+' · 建立 '+fmtDt(g.created_at)+'</div></div>';
  }).join('');
  return rows||'<div class=row><span class=gray>無群組</span></div>';
}
function fmtMB(v){return v==null?'—':v+' MB';}
function secDb(){
  var raw=T.db;if(!raw){return '<div class=row><span class=gray>DB 統計載入中…</span></div>';}
  // /oops/stats 結構：摘要數字在 raw.summary 底下、表排行在 top-level raw.breakdown
  var s=raw.summary||{};
  var b=raw.breakdown||{},g=s.growth||{},u=s.users||{},en=s.entries||{},rg=s.recent_growth||{},byS=en.by_status||{};
  // 整庫優先顯示 Render 即時真實磁碟（含 WAL+系統開銷），讀不到才退回 SQL 估算的 DB 內容大小
  var hasRender=(s.render_disk_mb!=null);
  var diskMB=hasRender?s.render_disk_mb:(s.all_db_size_mb||0);
  var pct=Math.min(100,Math.round(hasRender?(s.render_disk_pct_of_1gb||0):(s.db_used_pct_of_1gb||((s.all_db_size_mb||0)/1024*100))));
  var h='<div class=dash>'+
    '<div class=card><div class=lbl>整庫 / Disk'+(hasRender?'（真實磁碟）':'（估算）')+'</div><div class=big>'+fmtMB(diskMB)+'</div><div class=bar><i style="width:'+pct+'%"></i></div><div class=sub>'+pct+'% of 1 GB'+(hasRender?' · 含 WAL/系統，DB 內容 '+fmtMB(s.all_db_size_mb):'')+'</div></div>'+
    '<div class=card><div class=lbl>Pilot Log</div><div class=big>'+fmtMB(s.total_pilot_log_size_mb)+'</div></div>'+
    '<div class=card><div class=lbl>餐廳+其他</div><div class=big>'+fmtMB(s.restaurant_etc_size_mb)+'</div></div>'+
    (g.months_to_1gb!=null?'<div class=card><div class=lbl>多久滿 1GB</div><div class=big>'+(g.months_to_1gb===0?'⚠️已滿':'~'+g.months_to_1gb+' 月')+'</div><div class=sub>每天 +'+(g.per_day_total_mb!=null?g.per_day_total_mb:'—')+' MB · 滿載 '+(g.full_date_estimate||'—')+'</div></div>':'<div class=card><div class=lbl>成長</div><div class="big gray" style="font-size:1.1em">累積中</div><div class=sub>快照 '+(g.snapshot_count||0)+' 筆 / '+(g.history_days||0)+' 天</div></div>')+
  '</div>';
  // 使用者 / 航班 + 近期成長
  h+='<div class=row><div class=stats><span>使用者 <b>'+(u.total||0)+'</b>（有資料 <b>'+(u.with_entries||0)+'</b> · 7天活躍 <b>'+(u.active_7d||0)+'</b>）</span></div>'+
    '<div class=stats><span>航班總 <b>'+(en.total||0)+'</b>（confirmed <b>'+(byS.confirmed||0)+'</b> / draft <b>'+(byS.draft||0)+'</b>）</span></div>'+
    '<div class=t>近 7 天 +'+(rg.new_users_7d||0)+' 人 / +'+(rg.new_entries_7d||0)+' 航班　·　近 30 天 +'+(rg.new_users_30d||0)+' 人 / +'+(rg.new_entries_30d||0)+' 航班</div></div>';
  // 各表大小排行（含餐廳表）
  var tt=b.top_tables_by_size||[];
  if(tt.length){h+='<div class=sechdr><h2 style="font-size:.98em">各表大小排行</h2><span class=cnt>餐廳的表也在這</span></div>';
    h+='<div class=row style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.8em;font-variant-numeric:tabular-nums"><tr style="color:#94a3b8"><th style="text-align:left;padding:4px 6px">Table</th><th style="text-align:right;padding:4px 6px">Rows</th><th style="text-align:right;padding:4px 6px">MB</th></tr>'+
      tt.map(function(t){return '<tr><td style="padding:3px 6px;border-top:1px solid #1f2a3d">'+esc(t.name)+'</td><td style="text-align:right;padding:3px 6px;border-top:1px solid #1f2a3d">'+(t.approx_rows!=null?t.approx_rows.toLocaleString():'—')+'</td><td style="text-align:right;padding:3px 6px;border-top:1px solid #1f2a3d">'+t.total_mb+'</td></tr>';}).join('')+'</table></div>';
  }
  // Top users（匿名排名）
  var tu=b.top_users_by_entries||[];
  if(tu.length){h+='<div class=sechdr><h2 style="font-size:.98em">Top users（匿名排名）</h2></div>';
    h+='<div class=row><table style="width:100%;font-size:.8em;font-variant-numeric:tabular-nums"><tr style="color:#94a3b8"><th style="text-align:left">#</th><th style="text-align:right">Flights</th><th style="text-align:right">Aircraft</th></tr>'+
      tu.map(function(x,i){return '<tr><td>#'+(i+1)+'</td><td style="text-align:right">'+x.entry_count+'</td><td style="text-align:right">'+x.aircraft_count+'</td></tr>';}).join('')+'</table></div>';
  }
  // 逐人用量（含 email，owner 才看）
  var du=T.dbusers||[];
  if(du.length){h+='<div class=sechdr><h2 style="font-size:.98em">逐人用量</h2><span class=cnt>誰佔多少空間 · 不讀內容</span></div>';
    h+=du.map(function(x){var size=(x.mb>=0.1)?(x.mb+' MB'):(x.kb+' KB');return '<div class=row><div class=r1><span class=id>'+esc(x.email)+'</span></div><div class=stats><span>佔用 <b>'+size+'</b></span><span>航班 <b>'+x.entry_count+'</b></span><span>加入 '+esc(x.created_at||'—')+'</span></div></div>';}).join('');}
  return h;
}
function setTab(i){T.tab=i;render();}
if('serviceWorker' in navigator){navigator.serviceWorker.register('/tower/sw.js',{scope:'/tower'}).catch(function(){});}
initLogin();load();
</script>
</body></html>`;
}

// ══ 🐵 owner 後台 /monkey/admin ══════════════════════════════════════════════
// owner Google 登入 → 看報名名單（含 email/機隊/同步/logbook/狀態）+ 加朋友 + 刪一筆。
// 因為含 PII + 寫入動作，走 owner 驗證（不像 /oops 無密碼）。
function _renderMonkeyAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>🐵 Monkey · Admin</title>
<style>
*{box-sizing:border-box;} body{margin:0;background:#0a0e1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;padding:16px;padding-top:max(16px,env(safe-area-inset-top));}
h1{font-size:1.1em;margin:0 0 12px;}
.card{background:#1a1f2e;border:1px solid #334155;border-radius:12px;padding:14px;margin-bottom:12px;}
.muted{color:#94a3b8;} .err{color:#fca5a5;}
table{width:100%;border-collapse:collapse;font-size:.8em;} th,td{text-align:left;padding:6px 7px;vertical-align:top;}
th{color:#94a3b8;font-weight:700;} tr+tr td{border-top:1px solid #283449;}
.pill{display:inline-block;font-size:.85em;font-weight:700;padding:1px 7px;border-radius:6px;}
.pill.active{background:rgba(34,197,94,.15);color:#4ade80;} .pill.waitlist{background:rgba(245,158,11,.15);color:#fbbf24;}
.pill.owner{background:rgba(59,130,246,.15);color:#60a5fa;} .pill.friend{background:rgba(168,85,247,.15);color:#c084fc;}
input{background:#0a0e1a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:9px 11px;font-size:.9em;}
button{background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:.82em;font-weight:700;cursor:pointer;}
button.del{background:#dc2626;padding:4px 9px;font-size:.74em;}
#gsi{margin:14px 0;}
</style></head>
<body>
<h1>🐵 Monkey · Admin</h1>
<div id="msg" class="muted" style="font-size:.78em;margin-bottom:8px"></div>
<div id="login" class="card"><div class="muted" style="font-size:.85em;margin-bottom:6px">擁有者登入</div><div id="gsi"></div></div>
<div id="panel" style="display:none"></div>
<script>
function el(id){return document.getElementById(id);}
var AD={token:null,clientId:null};
async function cfg(){ if(AD.clientId)return AD.clientId; try{var r=await fetch('/api/pilot-log/config');var j=await r.json();AD.clientId=j.google_client_id;return AD.clientId;}catch(e){return null;} }
function gis(){ if(window.google&&google.accounts&&google.accounts.id)return Promise.resolve(); if(window._g)return window._g; window._g=new Promise(function(res,rej){var s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.defer=true;s.onload=res;s.onerror=rej;document.head.appendChild(s);}); return window._g; }
async function initLogin(){
  var c=await cfg(); if(!c){el('msg').innerHTML='<span class="err">Google 載入失敗</span>';return;}
  await gis();
  google.accounts.id.initialize({client_id:c,callback:onCred,auto_select:false});
  google.accounts.id.renderButton(el('gsi'),{theme:'filled_blue',size:'large',text:'signin_with',shape:'pill'});
}
async function onCred(resp){
  if(!resp||!resp.credential)return;
  el('msg').textContent='登入中…';
  var r=await fetch('/api/pilot-log/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:resp.credential})});
  if(!r.ok){el('msg').innerHTML='<span class="err">登入失敗</span>';return;}
  var j=await r.json(); AD.token=j.accessToken; el('login').style.display='none'; load();
}
async function api(path,opt){ opt=opt||{}; opt.headers=opt.headers||{}; opt.headers['Authorization']='Bearer '+AD.token; var r=await fetch(path,opt); if(r.status===401){ AD.token=null; el('msg').innerHTML='<span class="err">登入已過期，請用下方按鈕重新登入</span>'; el('login').style.display=''; el('panel').style.display='none'; } return r; }
async function load(){
  el('msg').textContent='查詢中…';
  var r=await api('/api/pilot-log/monkey/admin/list');
  if(r.status===403){el('msg').innerHTML='<span class="err">這個帳號不是擁有者</span>';return;}
  if(!r.ok){el('msg').innerHTML='<span class="err">查詢失敗 '+r.status+'</span>';return;}
  var j=await r.json(); render(j);
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function render(j){
  var s=j.slots||{}, a=j.applicants||[];
  el('msg').textContent='公開 '+ (s.publicTaken||0) +'/'+ (s.publicCap||0) +' 席 · 名單共 '+ a.length +' 人';
  var rows=a.map(function(x){
    return '<tr><td>'+esc(x.email)+'<div class="muted" style="font-size:.85em">'+esc(x.fleet||'')+(x.uses_sync===true?' · 同步':'')+(x.logbook?(' · '+esc(x.logbook)+(x.logbook_other?(' ('+esc(x.logbook_other)+')'):'')):'')+'</div></td>'+
      '<td><span class="pill '+esc(x.source)+'">'+esc(x.source)+'</span><br><span class="pill '+esc(x.status)+'">'+esc(x.status)+'</span></td>'+
      '<td style="text-align:right"><button class="del" data-id="'+esc(x.id)+'" data-email="'+esc(x.email)+'" onclick="del(this)">刪</button></td></tr>';
  }).join('');
  var html='<div class="card"><div style="margin-bottom:8px"><input id="fe" type="email" placeholder="朋友 email（不佔公開席次）" style="width:64%"> <button onclick="addF()">+ 加朋友</button></div>'+
    '<table><tr><th>Email / 資料</th><th>類別 / 狀態</th><th></th></tr>'+rows+'</table></div>'+
    '<div style="text-align:center;margin:8px 0 24px"><button onclick="load()">↻ 重新整理</button></div>';
  var p=el('panel'); p.style.display='block'; p.innerHTML=html;
}
async function addF(){
  var v=(el('fe').value||'').trim(); if(!v)return;
  var r=await api('/api/pilot-log/monkey/admin/friend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:v})});
  if(!r.ok){ if(r.status!==401){ var e=await r.json().catch(function(){return{};}); alert('加入失敗：'+r.status+' '+(e.error||'')); } return; } load();
}
async function del(btn){
  var id=btn.getAttribute('data-id'), email=btn.getAttribute('data-email')||'';
  if(!confirm('刪除 '+email+' ？'))return;
  var r=await api('/api/pilot-log/monkey/admin/'+id,{method:'DELETE'});
  if(!r.ok){ if(r.status!==401){ var e=await r.json().catch(function(){return{};}); alert('刪除失敗：'+r.status+' '+(e.error||'')); } return; } load();
}
initLogin();
</script>
</body></html>`;
}
