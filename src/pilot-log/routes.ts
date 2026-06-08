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
import { importRoster } from './import-roster.js';
import { getTotals, getRollingTotals, getByAircraftType, getOpeningBalance, getSimTotals } from './stats.js';
import { loadCredentials } from '../config.js';
import { getSpaPilotLogJs } from '../spa/js-pilot-log.js';
import { getAirportDbJs } from '../spa/js-airport-db.js';

// ── 版本（比照 CrewSync / Morning：每次推版必更新；SW cache 名稱跟著走） ────
// 本機 preview build 會暫時加 -tNN 後綴方便對版；推正式版前拿掉只留乾淨版號。
export const PILOT_LOG_VERSION = 'V2.2.23';
const PILOT_LOG_CACHE = 'pilotlog-v2-2-23';

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
    position: sticky; top: calc(var(--pl-head-h, 0px) + 8px);
    /* 往下移了 --pl-head-h，max-height 也要扣掉同量，否則底部超出視窗被切掉（codex P2） */
    max-height: calc(100dvh - 84px - var(--pl-head-h, 0px) - env(safe-area-inset-bottom));
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
<script>(function(){try{var s=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone;if(s&&sessionStorage.getItem('cs_via_apps')==='1'){var b=document.getElementById('cs-apps-home');if(b)b.style.display='inline-flex';}}catch(e){}})();</script>

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
      <b>🔄 Airports 轉向自動重排——iPad 橫拿開、轉直拿時自動切成單欄（不再卡在三欄）。</b><br>
      <b>🔄 Airports now re-lays out on rotation — switches between 3-column and single-column when you rotate.</b>
    </div>
    <div class="pl-cl-v old">V2.2.22</div>
    <div class="pl-cl-txt">
      <b>🗺️ Airports 手機／iPad 直拿改版——點機場看資訊、點進去看航班（釘頂可切 All／Dep／Arr），不用再一直滑；📊 Analyze 標題在 iPad 釘住。</b><br>
      <b>🗺️ Airports redesign (phone / iPad portrait) — tap an airport for info, tap in for its flights (pinned All / Dep / Arr); Analyze header now pinned on iPad.</b>
    </div>
    <div class="pl-cl-v old">V2.2.21</div>
    <div class="pl-cl-txt">
      <b>🗺️ 「Pick from fleet」從機隊挑機頁的頂部標題列釘住，捲動機隊時不再被推走。</b><br>
      <b>🗺️ Pick-from-fleet: the header now stays pinned while you scroll the fleet list.</b>
    </div>
    <div class="pl-cl-v old">V2.2.20</div>
    <div class="pl-cl-txt">
      <b>🗺️ Airports 右欄 All / Dep / Arr 篩選列釘在欄頂，捲動航班時不再被推走。</b><br>
      <b>🗺️ Airports: the All / Dep / Arr filter bar now stays pinned while you scroll the flight list.</b>
    </div>
    <div class="pl-cl-v old">V2.2.19</div>
    <div class="pl-cl-txt">
      <b>🗺️ Airports：捲動航班不再把頁首頂走、點機場保留列表捲動位置；補回金邊舊機場 VDPP（Pochentong，給歷史航班）。</b><br>
      <b>🗺️ Airports: scrolling flights no longer pushes the header; the airport list keeps its scroll position when you tap an airport; restored old Phnom Penh (VDPP, Pochentong) for historical flights.</b>
    </div>
    <div class="pl-cl-v old">V2.2.18</div>
    <div class="pl-cl-txt">
      <b>🩹 Analyze iPad 左右捲動「這次真的」修好。</b>上一版的修正改錯地方沒接上、群組標題（All Flight Time…）在 iPad 仍黏著蓋住內容；這版把標題接上正確樣式，iPad 才真的變成只「右欄」獨立捲動、標題不再蓋住；手機維持原樣不動。<br>
      <b>🩹 Analyze iPad scroll actually fixed now.</b> The previous fix didn’t take effect — the group header still stuck and overlapped content on iPad. This version wires the header to the right style so iPad finally gets an independent right-column scroll with no overlap; phone untouched.
    </div>
    <div class="pl-cl-v old">V2.2.17</div>
    <div class="pl-cl-txt">
      <b>🩹 Analyze iPad 捲動修正（未生效，見 V2.2.18）＋ ATIS 改瀏覽器端抓。</b><br>
      <b>🩹 Analyze iPad scroll fix (didn’t take effect, see V2.2.18) + ATIS moved to browser-side fetch.</b>
    </div>
    <div class="pl-cl-v old">V2.2.14</div>
    <div class="pl-cl-txt">
      <b>🩹 修 Tools 入口（透明狀態列）下的頂部顯示 ＋ 更新更即時 ＋ 回 Tools 鈕。</b>從 Tools 入口進來時，年份索引會凸頂搜尋框、捲動時標題/內容跑到狀態列那塊 → 改成依「標題實際底緣」定位、標題吸頂補安全區、狀態列那塊鋪不透明底。另外：Import 標題吸頂不被捲走；app 改網路優先、一次重開就更新；右下角多一顆回 Tools 鈕（彩色四格）。<br>
      <b>🩹 Fixes top rendering under the Tools hub (translucent status bar) + snappier updates + a Tools button.</b> Entering via the Tools hub pushed the year index into the search box and let the header/content bleed into the status-bar area — now anchored to the header's real bottom, the sticky header respects the safe-area inset, and an opaque strip backs the status-bar area. Also: the Import header stays pinned; the app is network-first so it updates on the first reopen; a Tools launcher button appears bottom-right.
    </div>
    <div class="pl-cl-v old">V2.2.10</div>
    <div class="pl-cl-txt">
      <b>🩹 年份索引再修。</b><b>(1)</b> 索引<b>不再戳進搜尋框</b>（錨在工具列下方）。<b>(2)</b> 年份多也<b>不爆螢幕</b>——標籤自動<b>抽稀當刻度</b>，滑動仍能<b>精準跳到任一年</b>（泡泡顯示確切年）。<b>(3)</b> 離線時頂部工具列黏在<b>橫幅下方</b>，按鈕不再被橫幅蓋住。<br>
      <b>🩹 More year-index fixes.</b> (1) The index <b>no longer pokes into the search box</b> (anchored below the toolbar). (2) It <b>won’t overflow the screen</b> as years pile up — labels auto-thin into tick marks while sliding still jumps to <b>any exact year</b> (the bubble shows it). (3) Offline, the top toolbar sticks <b>below the banner</b> so its buttons aren’t covered.
    </div>
    <div class="pl-cl-v old">V2.2.09</div>
    <div class="pl-cl-txt">
      <b>🩹 修 V2.2.08 的版面回歸 ＋ 🗺️ 地圖標籤改用機場代碼。</b><b>(1)</b> 年份索引不再壓到航班、也不再漏到 Aircraft／Crew／Airports（只在記錄本航班列顯示）。<b>(2)</b> Crew 搜尋框、Airports 頂部也一起固定。<b>(3)</b> Analyze 群組標題捲動時保持可見。<b>(4)</b> iPad 編輯器可捲到最上面。<b>(5)</b> 地圖機場標籤改用<b>機場代碼</b>（RCTP／TPE，跟 IATA/ICAO 切換連動），不再用飛行員看不習慣的城市/區名。<br>
      <b>🩹 Fixes for V2.2.08 layout regressions + 🗺️ airport-code map labels.</b> (1) The year index no longer overlaps flights or leaks onto Aircraft/Crew/Airports (logbook list only). (2) Crew search and the Airports top now stay fixed too. (3) The Analyze group title stays visible while scrolling. (4) The iPad editor can scroll to the very top again. (5) Map labels now show the <b>airport code</b> (RCTP/TPE, follows the IATA/ICAO toggle) instead of city/district names.
    </div>
    <div class="pl-cl-v old">V2.2.08</div>
    <div class="pl-cl-txt">
      <b>🧭 記錄本更好用 ＋ 離線更穩。</b><b>(1)</b> 右側新增<b>年份索引</b>（可點、可滑，滑動時中央放大泡泡顯示年份），長記錄本一秒跳到任一年。<b>(2)</b> 各分頁<b>上方固定</b>、關掉<b>視窗回彈</b>。<b>(3)</b> 離線更穩：地圖<b>快取秒開</b>、橫幅<b>不再擋按鈕</b>、連回線<b>橫幅自動消失</b>。<b>(4)</b> 關於頁加<b>社群連結</b>。<br>
      <b>🧭 Handier logbook + sturdier offline.</b> (1) New <b>year index</b> on the right (tap or slide, with a zoomed bubble) jumps to any year instantly. (2) Page tops now <b>stay fixed</b>; window <b>bounce removed</b>. (3) Offline: map <b>opens instantly from cache</b>, the banner <b>no longer covers buttons</b>, and it <b>clears itself</b> once you reconnect. (4) <b>Community link</b> added to About.
    </div>
    <div class="pl-cl-v old">V2.2.07</div>
    <div class="pl-cl-txt">
      <b>🐛 修大 bug：記錄本現在會載入「全部」航班</b>（原本只載最近 200 筆，飛行多的人看不到舊航班；總時數一直是對的）。<br>
      <b>🐛 Big fix: the logbook now loads ALL flights</b> (it used to load only the latest 200, hiding older flights for high-time pilots; total hours were always correct).
    </div>
    <div class="pl-cl-v old">V2.2.06</div>
    <div class="pl-cl-txt">
      <b>🛬 跑道也比照辦理：</b>Dep/Arr Rwy 換成自訂下拉，點一下就跳、候選自動跟著 From/To 機場、打字即時篩，手動輸入照常。<br>
      <b>🛬 Runway pickers too:</b> Dep/Arr Rwy now use the same reliable dropdown — taps open it, options follow the From/To airport, type to filter, manual entry preserved.
    </div>
    <div class="pl-cl-v old">V2.2.05</div>
    <div class="pl-cl-txt">
      <b>✏️ 編輯器小修：</b>日期欄改純數字（不再壓到 Flight#）；From/To 機場下拉更穩、點一下就跳、打字即時篩，手動輸入照常。<br>
      <b>✏️ Editor fixes:</b> Date shows plain numeric (no overflow into Flight#); From/To airport dropdown is more reliable — taps open it, type to filter, manual entry preserved.
    </div>
    <div class="pl-cl-v old">V2.2.04</div>
    <div class="pl-cl-txt">
      <b>🌍 3D 地球夜晚不再模糊 ＋ ✈️ 動態航跡從台灣飛出去。</b><b>(1)</b> Earth 拉遠有日夜＋城市燈，放大自動切回清楚的白天衛星圖（仿 Apple），夜面放大不再糊。<b>(2)</b> 動態光點凡經台灣的航線一律從台灣飛出去。<br>
      <b>🌍 Sharper night view on 3D Earth + ✈️ animated routes depart from Taiwan.</b> (1) Earth shows day/night + city lights when zoomed out, auto-switches to a clear daytime map up close (Apple-style). (2) Animated route lights now fly outward from the Taiwan end.
    </div>
    <div class="pl-cl-v old">V2.2.03</div>
    <div class="pl-cl-txt">
      <b>🗺️ 地圖體驗修正。</b><b>(1)</b> 控制項（Map／Earth、統計、日期）改成<b>穩定浮在地圖最上層</b>，不再被地圖蓋住。<b>(2)</b> 日期區間移到<b>右上角</b>，並新增 <b>近30天 / 近90天</b> 快捷。<b>(3)</b> Earth 的航跡改成 <b>[靜態｜動態]</b> 雙格鈕（按你要的那個），<b>動態</b>時有光點<b>沿著航線流動</b>。<b>(4)</b> 2D 縮放鈕移到右下，不再擋到上方控制項。<br>
      <b>🗺️ Map UX fixes.</b> (1) Controls (Map/Earth, stats, date) now <b>stay reliably on top</b> of the map instead of being covered. (2) The date-range moved to the <b>top-right</b>, with new <b>last-30-day / last-90-day</b> shortcuts. (3) Earth route style is now a <b>[Static｜Animated]</b> two-button toggle (tap the one you want); <b>Animated</b> shows a light <b>flowing along each route</b>. (4) The 2D zoom buttons moved to the bottom-right so they no longer overlap the top controls.
    </div>
    <div class="pl-cl-v old">V2.2.02</div>
    <div class="pl-cl-txt">
      <b>🌍 3D 地球大升級（Cesium）＋ 🗺️ 沉浸式地圖 ＋ 編輯器排版修正。</b><b>(1)</b> Map 分頁的 <b>Earth</b> 換成可<b>放大看細節的衛星地球</b>，還有<b>真實日夜光照＋夜面城市燈</b>（依當下時間）；引擎只在打開時下載、之後永久快取。<b>(2)</b> 地圖改成<b>全版沉浸式</b>：地圖佔滿整頁、控制項（Map／Earth、Save、統計）<b>半透明浮在地圖上</b>；2D 衛星圖、<b>航線變細變淡</b>不再糊住地圖、<b>地名放大才浮出</b>、可選<b>動態／靜態航跡</b>、可篩<b>日期區間</b>。<b>(3)</b> 編輯器：手機版 <b>CREW</b> 六列對齊一致（沒填名字的格子不再變大）、<b>OOOI</b> 由四格擠一排改成<b>2×2</b>（iPad 不變）。<br>
      <b>🌍 3D Earth upgrade (Cesium) + 🗺️ immersive map + editor layout fixes.</b> (1) The <b>Earth</b> view now streams <b>satellite tiles you can zoom into</b>, with <b>real day/night lighting and city lights</b> (by current time); the engine downloads only on first open, then stays cached. (2) The map is now <b>full-screen immersive</b> — controls (Map/Earth, Save, stats) <b>float over the map</b>; thinner translucent routes, place-name labels appear on zoom-in, animated/static route toggle, and a date-range filter. (3) Editor: phone <b>CREW</b> rows align consistently (empty slots no longer widen), and <b>OOOI</b> changed from four cramped boxes to <b>2×2</b> (iPad unchanged).
    </div>
    <div class="pl-cl-v old">V2.2.01</div>
    <div class="pl-cl-txt">
      <b>🗺️ 全新「Map」分頁 ＋ 🧹 清除更安全 ＋ 🗑️ 刪除帳號分離。</b><b>(1)</b> 底部多一個 <b>Map</b> 分頁，把你飛過的航線畫在真實地圖上 —— <b>2D 衛星實景圖</b>與 <b>3D 立體地球</b>（Map / Earth 切換）、大圓航線、雙指縮放、<b>Save Image</b> 一鍵存圖；統計機場數 / 航線數 / 國家數 / 主場 / 最遠航線（跨換日線航線正確繪製）。<b>(2)</b> 清除資料：<b>未勾選任何項目時刪除鈕變灰不可按</b>，說明補上英文。<b>(3)</b> <b>刪除帳號移出帳號選單</b>（不再貼在登出下面、避免誤觸），改至「版本 ⓘ → Danger Zone」（雙重確認）。<b>(4)</b> 班表匯入會把<b>組員 / 機上人數補進已完成的航班</b>（只補空缺、不覆蓋你已填的）。<br>
      <b>🗺️ New "Map" tab + 🧹 safer wipe + 🗑️ delete-account separated.</b> (1) A new <b>Map</b> tab plots every route you've flown — <b>2D satellite map</b> and <b>3D globe</b> (Map / Earth toggle), great-circle routes, pinch-zoom, one-tap <b>Save Image</b>; stats for airports / routes / countries / main base / longest leg (dateline-crossing routes drawn correctly). (2) Data wipe: the delete button now <b>stays disabled until a category is ticked</b>, with English labels added. (3) <b>Delete-account moved out of the account menu</b> (no longer next to logout) to "version ⓘ → Danger Zone" (double confirm). (4) Roster import now <b>fills crew / persons-on-board into completed flights</b> (empty fields only, never overwrites your edits).
    </div>
    <div class="pl-cl-v old">V2.1.09</div>
    <div class="pl-cl-txt">
      <b>🆕 新增 Log ATP 2 匯入 ＋ 🔍 記錄本搜尋 ＋ 👥 手機 CREW 排版。</b><b>(1)</b> Import 多一個「<b>Log ATP 2</b>」來源 —— 把你的 Log ATP 2 紀錄帶進來（時間視為 UTC、夜航、PIC/SIC、組員一次到位；班號保留航空代碼、機尾統一格式；<b>跟現有紀錄自動防重</b>）。<b>(2)</b> 記錄本上方加<b>搜尋框</b>，即時找 航班號 / 組員 / 機場 / 機尾。<b>(3)</b> <b>手機版</b>的 CREW 組員欄改成一列一個、名字全寬，長名不再被截斷（iPad 維持原樣）。<b>(4)</b> 同日多段航班照<b>實際起飛時間</b>排序；機隊挑機小修。<br>
      <b>🆕 Log ATP 2 import + 🔍 logbook search + 👥 roomier crew fields on phones.</b> (1) Import gains a <b>Log ATP 2</b> source — brings in your flights (OOOI as UTC, night, PIC/SIC, crew; flight numbers keep their airline code, tails normalized; <b>auto-deduped</b> against existing entries). (2) A <b>search box</b> on the logbook filters by flight no. / crew / airport / tail in real time. (3) On phones, crew fields are one-per-row so long names aren't truncated (iPad unchanged). (4) Same-day sectors now sort by actual departure time; minor fleet-picker tidy-up.
    </div>
    <div class="pl-cl-v old">V2.1.08</div>
    <div class="pl-cl-txt">
      <b>帳號選單 ＋ 會員身分 ＋ 登入說明。</b><b>(1)</b> 點右上角你的 <b>email ▾</b> 跳出帳號選單，裡面有你的<b>會員身分（⭐ 創始會員 / 一般會員）</b>、登出、永久刪除帳號 —— 登出不再裸露在工具列、不會誤按。創始會員＝當初封測的朋友，名單已凍結。<b>(2)</b> 登入畫面加說明：登入只是把紀錄綁在你帳號做<b>跨裝置同步＋雲端備份</b>，只取得 email、<b>不會讀你的信箱／雲端硬碟／通訊錄</b>。<br>
      <b>Account menu + membership + sign-in note.</b> (1) Tap your <b>email ▾</b> (top-right) for an account menu: your <b>membership (⭐ Founder / Member)</b>, logout, and delete account — logout is no longer loose in the toolbar. Founders are the original beta testers (list now frozen). (2) The sign-in screen explains login only links your logbook for <b>cross-device sync &amp; cloud backup</b>; we only get your email — never your inbox, Drive or contacts.
    </div>
    <div class="pl-cl-v old">V2.1.07</div>
    <div class="pl-cl-txt">
      <b>後台小修正。</b>背景維護更新，使用者操作與介面不變。<br>
      <b>Minor backend fix.</b> Background maintenance update; nothing changes in how you use the app.
    </div>
    <div class="pl-cl-v old">V2.1.06</div>
    <div class="pl-cl-txt">
      <b>後台小修正。</b>背景維護更新，使用者操作與介面不變。<br>
      <b>Minor backend fix.</b> Background maintenance update; nothing changes in how you use the app.
    </div>
    <div class="pl-cl-v old">V2.1.05</div>
    <div class="pl-cl-txt">
      <b>後台維護與安全性強化。</b>本次為背景維護與安全性更新，使用者操作與介面不變。<br>
      <b>Backend maintenance &amp; security hardening.</b> Background maintenance and security update; nothing changes in how you use the app.
    </div>
    <div class="pl-cl-v old">V2.1.04</div>
    <div class="pl-cl-txt">
      <b>修正跑道圖對不準（不少機場跑道線歪斜）。</b>之前為了「高緯機場的圖不變形」加的<b>經度補償</b>，反而讓地圖範圍的長寬比跟圖檔不一致，Esri 會自動微調範圍配合圖檔，但跑道線仍照原始範圍畫 → 跑道線歪斜、對不準衛星圖（緯度越高越明顯）。改成<b>範圍長寬比直接 = 圖檔 640:440</b>，Esri 不再微調，跑道線回到貼齊真實跑道。<br>
      <b>Fixed runway-overlay misalignment.</b> A longitude compensation (added to keep high-latitude maps undistorted) made the map extent ratio differ from the image, so Esri auto-adjusted the bbox while the runway lines were still drawn for the original extent — leaving them skewed off the real runways (worse at higher latitudes). The extent ratio now matches the image (640:440) exactly, so runway lines line up with the satellite imagery again.
    </div>
    <div class="pl-cl-v old">V2.1.03</div>
    <div class="pl-cl-txt">
      <b>日期選擇修正 + 班表變更改成直接刪。</b><b>(1)</b> 桌面點 Date 欄位<b>任何位置</b>就跳日曆（原本只有點右側小圖示才跳）；修正手機 Date／Flight# 等欄位在窄畫面溢出重疊。<b>(2)</b> 重新匯入班表時，本來要飛、後來改飛別班的舊航班<b>直接刪掉</b>（不再留灰色「已移除」狀態），換上新班；你已完成（飛過記錄）的航班與通訊錄組員都不動。<br>
      <b>Date picker fix + roster changes delete directly.</b> (1) On desktop, clicking anywhere in the Date field opens the calendar (previously only the small icon did); fixed Date/Flight# fields overflowing on narrow mobile screens. (2) Re-importing a roster now deletes old draft flights that were dropped or reassigned (no more grey "removed" state); your completed flights and address-book crew are untouched.
    </div>
    <div class="pl-cl-v old">V2.1.02</div>
    <div class="pl-cl-txt">
      <b>航班輸入更順手 + 跑道圖風分量不再重疊。</b><b>(1)</b> 日期欄改成可點日曆（iPhone/iPad 點了跳原生日期選擇器，不用手打）。<b>(2)</b> From/To 多了 37 個星宇航點下拉，可直接選、也能手打其他機場。<b>(3)</b> 跑道圖的逆風／側風分量改標在綠端附近，平行跑道不再互相重疊、也不壓住跑道與長寬。<br>
      <b>Smoother flight entry + de-cluttered runway wind components.</b> (1) The date field is now a native date picker (tap to open the calendar on iPhone/iPad). (2) From/To gain a dropdown of the 37 Starlux airports — pick one or type any other. (3) Runway headwind/crosswind components now sit by the green into-wind end, so parallel runways no longer overlap each other or the runway/size labels.
    </div>
    <div class="pl-cl-v old">V2.1.01</div>
    <div class="pl-cl-txt">
      <b>跑道圖大進化 + 起降天氣一鍵看。</b><b>(1) 跑道畫在衛星圖上：</b>Airports 詳情的衛星地圖，依真實座標把每條跑道畫出來、標跑道號與長 × 寬，地圖自動縮放涵蓋所有跑道。<b>(2) 依即時風向標色：</b>抓該機場即時 METAR 風向，逆風端標綠、順風端標橘，每條跑道旁標逆風／側風分量，左上角風向箭頭（比照 AeroWeather）。<b>(3) flight detail 整合天氣：</b>編輯航班時 From/To 旁多了「⛅ WX + 跑道圖」鈕，一次看起降兩地的跑道圖 + METAR／TAF，跑道圖可收合（記住偏好）。<b>(4) 班表時間顯示當地時間：</b>Sched Out／In 輸入後，下方顯示當地時間與 UTC 時差。<b>(5) 離線也看得到跑道座向：</b>連不到衛星底圖時改用深色底 + 跑道線，任何機場離線都能看座向／長寬／跑道號。另：iPad 三欄寬度微調、POB 說明精簡。<br>
      <b>Runway maps leveled up + one-tap departure/arrival weather.</b> (1) Runways drawn on the map: the Airports satellite view draws each runway from real coordinates with its number and length × width, auto-zoomed to fit all runways. (2) Wind-coloured ends: live METAR wind colours the into-wind end green and the downwind end orange, with headwind/crosswind components beside each runway and a wind arrow (AeroWeather-style). (3) Weather in flight detail: a "⛅ WX + runway map" button by From/To opens both airports' runway maps + METAR/TAF at once; maps are collapsible (remembers your choice). (4) Local time for schedule: Sched Out/In show local time + UTC offset below the field. (5) Runway orientation offline: when the satellite tile can't load, a dark backdrop + runway lines still show orientation/size/numbers for any airport. Also: iPad three-column width tweak, trimmed POB hint.
    </div>
    <div class="pl-cl-v old">V2.0.03</div>
    <div class="pl-cl-txt">
      <b>✈️ 37 個星宇航點的衛星地圖 → 飛機上離線也看得到。</b>第一次有網路打開 App 時，會在<b>背景</b>把 37 個星宇定期航點的衛星地圖<b>預先抓進手機</b>，存在一個<b>「改版也不會清掉」的永久快取</b>，並請求瀏覽器持久化（避免被系統清除）。之後就算<b>飛機上離線</b>，這 37 個機場的衛星地圖照樣看得到。其他全球機場（非星宇 37）維持線上即時抓。整批約 6MB，存在你裝置、<b>不佔我們的資料庫</b>。<br>
      <b>Offline satellite maps for the 37 Starlux airports.</b> On the first online launch, the app prefetches the satellite maps for the 37 Starlux scheduled airports into a persistent cache (survives app updates) and requests persistent storage, so they stay viewable offline (e.g. in-flight). Other airports worldwide still load live. ~6MB, stored on your device — not in our database.
    </div>
    <div class="pl-cl-v old">V2.0.02</div>
    <div class="pl-cl-txt">
      <b>班表匯入防呆 + ⭐ 星宇航點。</b><b>(1) 班表查重：</b>匯入班表時，<b>同一天＋同班號＋同起降</b>若已經有「已完成」的紀錄（LogTen / 手動）→ <b>自動略過</b>，不再重複建草稿（解決「當月已飛已記、又匯班表」變兩筆的問題）；匯入結果會顯示「已記略過 X 筆」。<b>(2) 月份預設：</b>列出可匯月份時，<b>當月及未來月份預設勾</b>，只有過去月份預設不勾（標「過去」）、要補再自己勾。<b>(3) ⭐ 星宇航點：</b>Airports 頁多了「<b>✈️ 飛過的 / ⭐ 星宇</b>」切換 —— ⭐ 星宇會列出<b>全部 37 個定期航點</b>（含還沒飛過的，依 Ops Spec C-6），點進去就能看任一機場的資訊／衛星地圖；飛過的列表裡星宇航點也標 ⭐。<br>
      <b>Roster import guard + ⭐ Starlux airports.</b> (1) Importing a roster now skips a flight if the same date + flight no. + route already has a completed record (LogTen/manual) — no more duplicate drafts; the result shows how many were skipped. (2) The month picker checks the current month and all future months by default; only past months are unchecked. (3) Airports gains a ✈️ Flown / ⭐ Starlux toggle — ⭐ lists all 37 scheduled airports (incl. ones you haven't flown yet) so you can open any for info/satellite map; flown airports that are Starlux destinations are marked ⭐ too.
    </div>
    <div class="pl-cl-v old">V2.0.01</div>
    <div class="pl-cl-txt">
      <b>🗺️ Airports 大改版 —— 機場資訊中心。</b>Places 改名 <b>Airports</b>，整頁重做成 LogTen 風格：<b>寬螢幕三欄</b>（機場列表 ｜ 機場資訊 ｜ 航班）、<b>iPhone 三層</b>（列表 → 機場 → 航班，關閉自動回上一層）。點任一機場，中間看得到完整資訊：<b>ICAO / IATA / 城市 / 國家全名 / 磁偏角（WMM 模型算）/ 時區（UTC offset + 當地即時時間）/ 座標 / 海拔 / 跑道</b>，再附一張<b>衛星地圖</b>（看得到真實跑道、航廈）＋ 可寫<b>機場筆記</b>。航班用 <b>All / 🛫 Dep / 🛬 Arr</b> 分頁分開看出發/抵達。<br>
      <b>🗺️ Airports — a full airport hub (major update).</b> Places is renamed <b>Airports</b> and rebuilt LogTen-style: three columns on wide screens (airport list ｜ info ｜ flights), three levels on iPhone (list → airport → flight, back returns to the previous level). Tap any airport for full details: ICAO / IATA / city / full country name / magnetic variation (WMM) / timezone (UTC offset + live local time) / coordinates / elevation / runways, plus a satellite map (real runways &amp; terminals) and an editable note. Flights split into All / 🛫 Dep / 🛬 Arr tabs.
    </div>
    <div class="pl-cl-v old">V1.3.38</div>
    <div class="pl-cl-txt">
      <b>修好跑道下拉（快取卡舊資料）＋機場詳情補資料。</b><b>(1) 跑道下拉修正：</b>上一版的跑道下拉是空的 —— 機場資料檔被瀏覽器 7 天快取卡在舊版（沒有跑道那欄），改成<b>版本化網址</b>強制重抓，現在 Dep/Arr 跑道下拉正常跳出該機場的實際跑道。<b>(2) 機場詳情補資料：</b>在 Places 點任一機場，現在看得到<b>時區（含當地即時時間）、座標、海拔、跑道</b>。<br>
      <b>Runway dropdown fix (stale cache) + airport detail data.</b> (1) Last version's runway dropdown was empty — the airport data file was stuck on a 7-day browser cache (old version without the runways column); switched to a versioned URL to force a refresh, so Dep/Arr runway dropdowns now show the airport's actual runways. (2) Tapping an airport in Places now shows its timezone (with live local time), coordinates, elevation and runways.
    </div>
    <div class="pl-cl-v old">V1.3.37</div>
    <div class="pl-cl-txt">
      <b>跑道下拉 + 組員顯示修正 + 匯入自動帶組員 + 機場代碼自動大寫。</b><b>(1) Dep/Arr 跑道改下拉：</b>起飛/落地跑道<b>依該機場實際跑道</b>選（資料內建），不用背；跑道跟 SID/STAR 排在<b>同一區、照飛行時序</b>（Dep Rwy → SID → STAR → Arr Rwy）。<b>(2) 修組員「最後一個重複」：</b>有些航班列表把最後一位組員顯示兩次 —— 你的<b>資料其實沒壞</b>（flight detail 一直正確），是列表顯示沒去重，已修。<b>(3) 匯入更直覺：</b>拿掉「覆蓋組員」勾選 —— 匯入<b>一律自動帶入/補上組員</b>（含 FO），其他欄位（你的編輯）不動；重匯也會補回 Crew 人數。<b>(4) New Entry 機場代碼自動大寫</b>（IATA/ICAO 都是）。<b>(5) 機場庫升級：</b>加入<b>時區、海拔、州、跑道</b>（為下一版機場頁鋪路）。<br>
      <b>Runway dropdown + crew display fix + auto crew on import + auto-uppercase airport codes.</b> (1) Dep/Arr runway are now dropdowns driven by the airport's actual runways (built-in); runway sits with SID/STAR in one block, in flight order (Dep Rwy → SID → STAR → Arr Rwy). (2) Fixed the "last crew member shown twice" on some list views — your data was never broken (flight detail was always correct), the list just didn't de-duplicate; fixed. (3) Import is simpler: the "overwrite crew" checkbox is gone — import always fills/updates crew (incl. FO) without touching your other edits; re-import also backfills the crew count. (4) New Entry auto-uppercases airport codes. (5) Airport DB now carries timezone, elevation, state and runways (groundwork for the Airports page).
    </div>
    <div class="pl-cl-v old">V1.3.36</div>
    <div class="pl-cl-txt">
      <b>飛行明細升級（跑道 + POB）＋依機場查航班＋內建全球機場庫。</b><b>(1) 明細新欄位：</b>加 <b>Dep / Arr 跑道</b>（SIM/DHD 也能記）；新增「<b>POB 機上人數</b>」區——填 <b>Crew（含後艙空服）＋ Pax 自動算出 POB</b>；Pax 從起降區搬到這裡更合理。匯入班表會自動帶組員人數當 Crew 初值，你可自己改（重匯不會蓋掉你改的）。<b>(2) 🗺️ Places 依機場查航班：</b>工具列新增 Places，列出你<b>飛過的機場</b>（依航班數排序，↗ 出發 / ↘ 抵達），點任一機場看所有進出航班；只算已飛，未來班表不會混進來。<b>(3) 內建全球機場庫（約 4,200 個）：</b>編輯航班時 From / To <b>自動顯示機場名稱</b>；IATA ↔ ICAO 切換、夜航判斷現在<b>全世界機場都認得</b>。<b>(4) 機隊挑機可反悔：</b>從機隊加錯了，再點一下綠色 ✓ 可取消（前提是還沒有航班；已有航班的會擋住）。<b>(5) Aircraft 機型也可收合：</b>機尾庫的機型子分組現在也能各自收合。<br>
      <b>Flight detail upgrade (runways + POB) + view flights by airport + built-in global airport database.</b> (1) Detail fields: added Dep / Arr runway (works for SIM/DHD too); a new POB section — enter Crew (incl. cabin) + Pax and POB is auto-summed; Pax moved here from the takeoffs/landings block. Roster import seeds the crew count (editable; re-import won't overwrite your edits). (2) 🗺️ Places: a new toolbar button lists the airports you've flown (by frequency, ↗ departures / ↘ arrivals); tap one to see every flight to/from it — flown flights only, future roster legs excluded. (3) Built-in global airport DB (~4,200): From/To now show airport names, and IATA↔ICAO switching plus night calc work for airports worldwide. (4) Fleet picker is reversible: tap a green ✓ to remove a tail you added by mistake (only if it has no flights yet). (5) Aircraft type sub-groups are now individually collapsible.
    </div>
    <div class="pl-cl-v old">V1.3.35</div>
    <div class="pl-cl-txt">
      <b>內建台灣機隊，一鍵挑機加進機尾庫。</b>✈️ Aircraft 頁多了「<b>🇹🇼 從機隊</b>」：列出台灣 6 家航司（星宇 / 長榮 / 華航 / 華信 / 立榮 / 虎航）的<b>現役機隊</b>，依公司 → 機型分組，<b>點一架就加進你的機尾庫</b>（自動帶公司 + 機型，不用手 key）。已在庫的標綠色 ✓。退役機不在這份現役清單，仍可用「+ Add Aircraft」手動加（你飛過的退役機，公司/機型一樣推算得出來）。<br>
      <b>Built-in Taiwan fleets — tap to add aircraft.</b> The ✈️ Aircraft page gains 🇹🇼 Pick from fleet: browse the current fleets of Taiwan's six carriers (Starlux / EVA / China Airlines / Mandarin / UNI / Tigerair) by airline → type, and tap a tail to add it to your registry (operator + type auto-filled). Already-added tails show a green ✓. Retired aircraft aren't in this current-fleet list — use "+ Add Aircraft" for those.
    </div>
    <div class="pl-cl-v old">V1.3.34</div>
    <div class="pl-cl-txt">
      <b>拿掉「已移除」篩選 + Report 多餘字樣，介面更乾淨。</b>「已移除」（班表同步時被取消的航班）這個篩選分類拿掉了——這種紀錄<b>不再出現在 All</b>，篩選列也少一顆鈕（紀錄仍留在資料庫，只是畫面上不顯示）。另外 Report 右上角那句「只計已飛航班」也拿掉（Report 本來就只算已飛的，不用特別寫）。<br>
      <b>Removed the "Removed" filter + a redundant Report label.</b> The "Removed" category (roster-sync-cancelled flights) is gone — those records no longer show in All, and the filter row loses a button (the records stay in the database, just hidden). The Report page also drops the redundant "flown flights only" label.
    </div>
    <div class="pl-cl-v old">V1.3.33</div>
    <div class="pl-cl-txt">
      <b>匯出集中到 Report + 一鍵上鎖全部航班。</b><b>(1) 匯出集中：</b>通訊錄 / 機尾庫 / 機型的匯出現在 <b>📄 Report 頁也有</b>（跟航班 CSV 放一起，一站全包）；各頁原本的匯出鈕也保留。<b>(2) 一鍵上鎖：</b>Logbook 工具列加「<b>🔒 全鎖</b>」「<b>🔓 全開</b>」，一次把<b>全部航班上鎖 / 解鎖</b>。上鎖後防誤改——不能編輯也不能刪除，要改先解鎖（跟單筆 🔒 Lock 同樣道理，只是一次全部）。<br>
      <b>Exports centralized in Report + one-click lock-all.</b> (1) Crew / aircraft / type exports now also live on the 📄 Report page (next to the flights CSV); the per-page buttons stay too. (2) The Logbook toolbar gains 🔒 Lock all / 🔓 Unlock all to lock or unlock every flight at once (locked = protected from accidental edits/deletes; unlock to edit).
    </div>
    <div class="pl-cl-v old">V1.3.32</div>
    <div class="pl-cl-txt">
      <b>可以匯出資料了：通訊錄 / 機尾庫 / 機型目錄（比照 LogTen）。</b>之前只能匯出航班，現在 <b>👥 Crew 頁</b>右上多了「⬇️ Export」匯出整本通訊錄（名字 / 員編 / 公司 / 註記）；<b>✈️ Aircraft 頁</b>多了「⬇️ Aircraft」「⬇️ Types」匯出機尾庫（機號 / 公司 / 機型 / 廠商 / Model / 備註）與機型目錄。都是 UTF-8 CSV，Excel 直接開得開，方便你備份或搬到別的軟體。<br>
      <b>You can now export your data: address book / aircraft / aircraft types (like LogTen).</b> Previously only flights could be exported. The 👥 Crew page gets a ⬇️ Export (name / employee id / org / comment); the ✈️ Aircraft page gets ⬇️ Aircraft and ⬇️ Types for the tail registry and type catalog. All UTF-8 CSV (opens in Excel) for backup or moving to other software.
    </div>
    <div class="pl-cl-v old">V1.3.31</div>
    <div class="pl-cl-txt">
      <b>iPhone 版面整理：Logbook 工具列 + Report 日期區間。</b>Logbook 上面那排按鈕（新增 / 匯入 / Aircraft / Crew / IATA + 篩選 + Logout）以前在手機擠成一坨，現在分成<b>「動作」一列、「篩選」一列</b>，清楚不亂（彩色保留）。Report 的「Hours Summary」日期選擇器以前在手機跟下面卡片黏在一起，現在<b>標題自己一行、日期區間另一行平分撐開</b>，好點選。<br>
      <b>iPhone layout tidy-up: Logbook toolbar &amp; Report date range.</b> The Logbook button row (add / import / aircraft / crew / IATA + filters + logout) was cramped on phones — now split into an action row and a filter row (colors kept). The Report "Hours Summary" date pickers no longer overlap the cards on phones: the title sits on its own line and the date range fills the next.
    </div>
    <div class="pl-cl-v old">V1.3.30</div>
    <div class="pl-cl-txt">
      <b>Analyze 補上更多明細（比照 LogTen）+ 拿掉多餘字樣。</b>Analyze 右欄選中的那一組，現在除了彩色橫條，<b>多一張明細卡</b>：日/夜起飛、日/夜落地、Autolands、總距離（NM）、Approach 數、總載客 Pax、Total Duty。順手把右上角多餘的「全部已飛資料」字樣拿掉（左欄本來就能選組，那句話反而像不能改）。<br>
      <b>Analyze gains more detail (LogTen-style) + a redundant label removed.</b> The selected group's right pane now adds a detail card — day/night takeoffs &amp; landings, autolands, total distance (NM), approaches, total pax, total duty — alongside the bars. Also removed the redundant "all flown data" label.
    </div>
    <div class="pl-cl-v old">V1.3.29</div>
    <div class="pl-cl-txt">
      <b>Analyze 大改版（LogTen 風兩欄）+ Aircraft 加機型分層 + 機場碼按鈕改邏輯。</b><b>(1) Analyze 兩欄：</b>仿 LogTen——<b>左邊選一組</b>（全部 / 近 7・28・90 天・12 個月 / 依公司 / 依機型，每組帶總時數），<b>右邊出彩色比例橫條</b>（Block / Air / Night / PIC / SIC）+ <b>依機型（或依公司）卡片</b>，點卡片進明細。iPad 兩欄、iPhone 由上至下堆疊——順便把舊表格在手機上爆版的問題解掉。<b>(2) Aircraft 加機型分層：</b>機尾庫現在是 <b>公司 → 機型 → 機尾</b> 三層（之前只有公司）。<b>(3) 機場碼按鈕：</b>🌐 IATA/ICAO 改成跟日夜間按鈕一樣的邏輯——<b>顯示「按了會切到的目標」</b>（例如目前 ICAO 就顯示 IATA），不再顯示目前狀態。<br>
      <b>Analyze redesigned (LogTen-style two columns) + Aircraft gains a type layer + airport-code button logic.</b> (1) Analyze: pick a group on the left (All / last 7·28·90 days·12 months / by company / by type, each with a total), the right shows colored proportion bars (Block/Air/Night/PIC/SIC) + by-type (or by-company) cards you can tap into. Two columns on iPad, stacked on iPhone — also fixes the old table overflow on phones. (2) Aircraft list is now company → type → tail (three levels). (3) The 🌐 IATA/ICAO button now matches the day/night button: it shows the target you'll switch to, not the current state.
    </div>
    <div class="pl-cl-v old">V1.3.28</div>
    <div class="pl-cl-txt">
      <b>修好 Aircraft 全變「no operator」+ Position 下拉新增 SFO / FO。</b><b>(1) Aircraft 分類修正：</b>上一版改成「依公司分組」時，誤用了機尾庫的 operator 欄位 —— 但你那個欄位大多是空的，結果全部掉進「no operator」、根本沒分到公司，抱歉。現在改成<b>跟 Analyze「依公司」同一套：operator 空就用台灣機籍的 tail 範圍推</b>（B-16xxx → EVA Air、B-58xxx → Starlux…），公司就分對了；每架的機型也一樣推得出來。<b>(2) Position 多 SFO / FO：</b>航班的「Position」下拉除了 PIC / SIC / OBSERVER，<b>新增 SFO、FO 可選</b>；兩者都當 SIC 計時數（co-pilot 記 SIC）。<br>
      <b>Fixed Aircraft all showing "no operator" + added SFO / FO to Position.</b> (1) Last version's "group by company" mistakenly read the registry's operator field, which is mostly empty for you, so everything fell into "no operator" — sorry. It now derives the company the same way Analyze does: when operator is blank, it's inferred from the Taiwan registration ranges (B-16xxx → EVA Air, B-58xxx → Starlux…); type is inferred too. (2) The flight Position dropdown gains SFO and FO (both counted as SIC, since co-pilots log SIC time).
    </div>
    <div class="pl-cl-v old">V1.3.27</div>
    <div class="pl-cl-txt">
      <b>資料管理三件套：crew 編輯一致 + Aircraft 列表按公司分類收合 + Aircraft 可編輯。</b><b>(1) 兩個 crew 編輯入口統一：</b>以前在「通訊錄」改聯絡人有 公司 / 註記 可填，但在「航班裡點 ✏️」只給 名字 / 員編 —— 兩邊不一樣。現在<b>航班裡的 ✏️ 也補上 公司 / 註記</b>，跟通訊錄一致。<b>(2) Aircraft 列表改按公司分類 + 預設全收合：</b>以前一打開全部機尾攤開、又是按機型分。現在<b>依公司（operator）分組、預設全部收合</b>，點公司才展開；每架底下標機型。<b>(3) Aircraft 可編輯：</b>以前機尾新增後打錯只能刪掉重建。現在 Aircraft 明細頁右上有 <b>✏️ Edit</b>，可改公司 / 機型 / 廠商 / Model / 備註（機號不可改，要改請刪重建）。<br>
      <b>Data-management trio: consistent crew edit + Aircraft list grouped by company &amp; collapsed + editable Aircraft.</b> (1) The crew ✏️ inside a flight now also has Organization / Comment, matching the Address Book editor. (2) The Aircraft list is now grouped by company (operator) and collapsed by default (tap a company to expand; each tail shows its type). (3) Aircraft are now editable — an ✏️ Edit on the aircraft detail page lets you fix operator / type / make / model / notes (tail # is fixed; delete &amp; re-add to change it).
    </div>
    <div class="pl-cl-v old">V1.3.26</div>
    <div class="pl-cl-txt">
      <b>修兩個 New Entry bug + 離線秒開。</b><b>(1) 新增航班不再亂帶機型：</b>以前按 + New Entry 會自動塞「機尾庫第一台」的機型 / 機尾（例如 A321-200 / B-16201），不必要。現在<b>留空白讓你自己選</b>。<b>(2) 換機型會清掉舊機尾：</b>以前選了新機型，右邊舊機型的機尾（例如 B-16201）不會消失、對不起來。現在<b>換機型時若機尾不屬於新機型就自動清空</b>。<b>(3) 離線秒開：</b>確定沒網路時，Report / Analyze 不再卡「Loading…」轉半天 —— <b>直接用上次的快取資料即時顯示</b>（頂部維持 OFFLINE 提示）。<br>
      <b>Two New Entry bugs fixed + instant offline.</b> (1) New Entry no longer auto-fills the first registry aircraft's type/tail (e.g. A321-200 / B-16201) — left blank for you to pick. (2) Changing the aircraft type now clears a tail that doesn't belong to the new type (no more stale mismatched tail). (3) When offline, Report / Analyze stop hanging on "Loading…" and render instantly from the last cached data (OFFLINE banner stays).
    </div>
    <div class="pl-cl-v old">V1.3.25</div>
    <div class="pl-cl-txt">
      <b>Import 介面大改版：左側三分頁，清爽不雜亂 + Wipe 改成勾選類別清除。</b>以前 Import 一頁疊六張卡、來源下拉跟卡片混在一起很亂。現在改成<b>左邊直欄三個分頁</b>，點哪個右邊就顯示哪個：<br>
      <b>① 📅 班表 Roster</b>（最常用、預設）—— 從 CrewSync 帶班表。<br>
      <b>② 📥 Logbook 來源</b> —— 進去再子選 <b>LogTen Pro</b>（顯示 Flights / Aircraft / Aircraft Types / Address Book 四格）或 <b>Wader</b>（只顯示它的 CSV）。<br>
      <b>③ 🗑️ Wipe 清除</b> —— 改成<b>勾選資料類別</b>（飛時 / 機籍 / 機型 / 通訊錄，不分匯入來源），勾哪個刪哪個、全勾就是全部刪除；清通訊錄會<b>保留你本人</b>。一律兩段確認。手機窄螢幕時左欄自動收成上方一排。<br>
      <b>Import redesigned: a clean left-side 3-tab layout + category-based Wipe.</b> Instead of six stacked cards, the Import page now has a left vertical nav: <b>① 📅 Roster</b> (default), <b>② 📥 Logbook</b> (pick LogTen → 4 cards, or Wader → 1), <b>③ 🗑️ Wipe</b> — now <b>tick which data categories</b> to clear (flights / aircraft / types / address book, regardless of source); wiping the address book keeps your own (self) entry. Two-step confirm throughout; the left nav collapses to a top row on narrow screens.
    </div>
    <div class="pl-cl-v old">V1.3.24</div>
    <div class="pl-cl-txt">
      <b>修好 LogTen 匯入漏掉副駕（FO）+ 組員可手填新增 + 本人可編輯 + SIM/DHD 自動完成。</b>這版一次解掉 crew 一整串問題：<br>
      <b>① 匯入終於把 FO / relief 機師帶進來。</b>你的 LogTen 欄位是 <code>FO 1</code>、<code>FO 2</code>（中間有空格）跟 <code>CAP/SFO</code>，舊版比對看死關鍵字又把 FO1/FO2 排除，整批副駕都漏掉，很多航班只剩你一個。現在改成<b>忽略空格、依欄位順序</b>把 PIC 以外的機師（SIC/P2 Crew、CAP/SFO、FO 1、FO 2）填進 Crew 2/3/4，並修好誤抓空的時數欄當正駕的問題。順手把 <code>PIC/P1</code>、<code>SIC/P2</code> 時數欄也讀對（影響 Analyze 的 PIC/SIC 時數）。<br>
      <b>② 匯入加「覆蓋現有航班的組員」選項。</b>已完成的航班預設會被保護跳過，所以光重匯救不回舊資料。勾這個選項重新上傳，就<b>只補/換組員＋PIC/SIC 時數</b>（其他欄位不動），一次補回所有過去航班的 FO。<br>
      <b>③ 手填的組員現在可編輯 / 可新增進通訊錄。</b>在航班裡手打一個組員，旁邊的 <b>✏️</b> 會即時出現（空格沒名字就不顯示）；按下去如果通訊錄還沒這個人，會跳<b>「新增聯絡人」</b>直接建進去並掛上，之後可重複選用。<br>
      <b>④ 通訊錄裡「本人」那列終於可以編輯</b>（多了 ✏️ Edit，可改名 / 補員編）。<br>
      <b>⑤ SIM / DHD 過去日期自動算「已完成」</b>（綠）；未來預排的仍是未完成（藍）。模擬機 / 搭便機沒有 OOOI，改用日期判斷。<br>
      <b>⑥ 文案統一</b>：使用者看到的一律「已完成 / 未完成」，不再出現內部的 draft / confirm 字眼。
    </div>
    <div class="pl-cl-txt" style="border-top:1px solid var(--border,#334155);margin-top:6px;padding-top:6px">
      <b>Fixed missing FO on LogTen import + crew can be hand-added + edit yourself + SIM/DHD auto-done.</b> A whole cluster of crew fixes:<br>
      <b>① FO / relief pilots finally import.</b> Your LogTen columns are <code>FO 1</code>, <code>FO 2</code> (with a space) and <code>CAP/SFO</code>; the old keyword matcher excluded FO1/FO2 and couldn't match the spaced names, so every relief pilot was dropped and many flights showed only you. Detection is now <b>space-insensitive and order-based</b> — non-PIC pilots (SIC/P2 Crew, CAP/SFO, FO 1, FO 2) fill Crew 2/3/4 in column order — plus a fix so an empty time column can't be mistaken for PIC. The <code>PIC/P1</code> / <code>SIC/P2</code> time columns now read correctly too (affects Analyze PIC/SIC hours).<br>
      <b>② New "overwrite crew on existing flights" import option.</b> Done flights are protected/skipped by default, so a plain re-import won't fix old data. Tick this and re-upload to <b>re-fill crew + PIC/SIC time only</b> (other fields untouched) across all your past flights.<br>
      <b>③ Hand-typed crew can now be edited / added to the address book.</b> Type a name in a crew slot and the <b>✏️</b> appears instantly (hidden when empty); if that person isn't in the address book yet, it opens <b>"Add contact"</b> to create and link them.<br>
      <b>④ You can finally edit your own entry</b> in the address book (a new ✏️ Edit — rename / add employee id).<br>
      <b>⑤ Past-dated SIM / DHD auto-count as done</b> (green); future-scheduled stay open (blue). SIM/DHD have no OOOI, so date decides.<br>
      <b>⑥ Wording unified</b> to "done / open" everywhere — the internal draft / confirm terms no longer leak into the UI.
    </div>
    <div class="pl-cl-v old">V1.3.23</div>
    <div class="pl-cl-txt">
      <b>匯入（LogTen / Wader）的 night / PIC / SIC 上鎖，編輯時間不會被自動重算蓋掉。</b>從 LogTen Pro / Wader 帶進來的夜航、PIC、SIC 是你<b>原本就記好的正本</b>。現在打開這類紀錄時會自動「上鎖」——就算你之後去改 OOOI 或航線，這三個欄位也<b>不會</b>被系統的自動計算覆蓋掉（要改可以直接手動改）。班表（Roster）與手動新增的航班不受影響，仍照常自動算 night。<br>
      <b>Imported (LogTen / Wader) night / PIC / SIC are now locked from auto-recalc when you edit times.</b> Night, PIC and SIC brought in from LogTen Pro / Wader are <b>your originally-logged values</b>. Opening such an entry now locks those three fields — editing OOOI or the route will <b>not</b> overwrite them with the auto-calculation (you can still change them by hand). Roster and manually-added flights are unaffected and keep auto-computing night.
    </div>
    <div class="pl-cl-v old">V1.3.22</div>
    <div class="pl-cl-txt">
      <b>夜航時間改用法規標準的 block 算法（Out→In，含滑行）。</b>之前 night 只算「空中段」（起飛→落地），所以你改推離時間（Out）night 不會動。現在依 <b>FAA 14 CFR 1.1 / EASA FCL.050</b> 改成算整段 block：<b>起點滑行（Out→Off）＋ 空中（Off→On）＋ 終點滑行（On→In）</b>，落在夜間的部分都算進去——滑行的夜航終於不再漏。缺 Out / In 時自動退化為只算空中段。<br>
      <b>Night time now uses the regulatory block-based method (Out→In, incl. taxi).</b> Night was previously airborne-only (takeoff→landing), so changing your out-time didn't move it. Per <b>FAA 14 CFR 1.1 / EASA FCL.050</b>, night is now computed across the whole block: <b>taxi-out (Out→Off) + airborne (Off→On) + taxi-in (On→In)</b>, counting any portion that falls in darkness — taxi night is no longer dropped. Falls back to airborne-only when Out/In are missing.
    </div>
    <div class="pl-cl-v old">V1.3.21</div>
    <div class="pl-cl-txt">
      <b>Analyze 可點選鑽取：點公司看各機型 PIC/SIC + 該批航班，點機型看各公司。</b>Analyze 的「依公司」「依機型」每一列現在<b>可以點</b>：點「EVA Air」→ 看它<b>各機型的 PIC / SIC 時數</b>（B777 PIC 多少、B787 PIC 多少…）<b>＋那些航班的列表</b>（再點一筆可開進去看 / 編）；點機型 → 看各公司的 PIC / SIC + 航班。終於能查「我在某公司某機型飛了多少 PIC」。<br>
      <b>Analyze rows are now drill-down.</b> Each row in "By Company" and "By Type" is tappable: tap "EVA Air" → see PIC / SIC hours <b>per type</b> (e.g. B777 PIC, B787 PIC) <b>plus the list of those flights</b> (tap one to open it); tap a type → per-company breakdown + flights. You can finally check "how many PIC hours on this type at this airline".
    </div>
    <div class="pl-cl-v old">V1.3.20</div>
    <div class="pl-cl-txt">
      <b>機場碼 IATA / ICAO 自選顯示 + 修好班表航班的 night time 自動計算。</b><b>(顯示)</b> Logbook 工具列加 <b>🌐 切換鈕</b>，機場碼可選 ICAO（預設）或 IATA 顯示，列表與編輯器一致；班表帶 IATA、LogTen 帶 ICAO 不再混亂。<b>(Night)</b> 以前班表航班用 IATA 碼（TPE/LAX）查不到座標、night 一直空白；現在 IATA / ICAO 都查得到座標，而且<b>開啟編輯器就自動補算 night</b>（不用手動碰欄位）。<br>
      <b>IATA / ICAO airport-code display toggle + fixed night-time auto-calc for roster flights.</b> <b>(Display)</b> A 🌐 toggle in the Logbook toolbar switches airport codes between ICAO (default) and IATA, consistent across the list and editor — no more mixed IATA/ICAO from different sources. <b>(Night)</b> Roster flights using IATA codes (TPE/LAX) previously couldn't resolve coordinates so night stayed blank; now both IATA and ICAO resolve, and night auto-computes when you open the editor.
    </div>
    <div class="pl-cl-v old">V1.3.19</div>
    <div class="pl-cl-txt">
      <b>匯入頁先選來源 logbook + 編輯器加「類型」下拉（Flight / DHD / SIM）。</b><b>(匯入)</b> Import 頁最上面多了「來源 logbook」下拉：選 <b>LogTen Pro</b> 顯示它的匯入選項、選 <b>Wader</b> 顯示 Wader CSV；<b>📅 Roster 班表獨立、不在此選單</b>。會記住上次選的。<b>(類型)</b> 航班編輯器 FLIGHT 區加「類型」下拉，預設 Flight，可改成 <b>DHD</b>（搭便機，不算 PIC/SIC 與起降）或 <b>SIM</b>（模擬機：露出 sim type + 時數欄、收起航線/OOOI）。取代原本的 Deadhead 勾選框，<b>現在可在編輯器直接建立 / 編輯模擬機紀錄</b>。<br>
      <b>Import starts with "select your source logbook" + the editor gets a "Type" dropdown (Flight / DHD / SIM).</b> <b>(Import)</b> A source dropdown at the top of Import: LogTen Pro shows its imports, Wader shows the Wader CSV; Roster is independent. Remembers your last choice. <b>(Type)</b> The flight editor's FLIGHT section gets a Type dropdown — default Flight, switch to DHD (deadhead) or SIM (simulator: shows sim type + time, hides route/OOOI). Replaces the old Deadhead checkbox; you can now create/edit simulator entries directly in the editor.
    </div>
    <div class="pl-cl-v old">V1.3.18</div>
    <div class="pl-cl-txt">
      <b>Wader 匯入可整批刪除（含起始累計）+ 匯入把本人帶進組員 + deadhead 列表加標示。</b><b>(刪除)</b> Import 頁 Danger Zone 現在 LogTen / Wader <b>各有一顆 Wipe</b>；Wader 的 Wipe 會連<b>起始累計</b>一起清。<b>(組員)</b> Wader 匯入會把你自己也放進組員（你那趟的 PIC/SIC 格，先顯示「SELF」，可到通訊錄改成你的名字）。<b>(標示)</b> deadhead（搭便機）航班在 Logbook 列表加上「<b>DHD</b>」標示，跟模擬機的「SIM」一樣一眼認出。<br>
      <b>Wader bulk-wipe (incl. opening balance) + import puts you in the crew + DHD badge on deadhead rows.</b> <b>(Wipe)</b> The Import page Danger Zone now has separate Wipe buttons for LogTen / Wader; wiping Wader also clears the opening balance. <b>(Crew)</b> Wader import now includes you in the crew (your PIC/SIC slot, shown as "SELF" for now — rename in the Address Book). <b>(Badge)</b> Deadhead flights get a "DHD" badge in the Logbook list, like the "SIM" badge.
    </div>
    <div class="pl-cl-v old">V1.3.17</div>
    <div class="pl-cl-txt">
      <b>新增 Wader logbook CSV 匯入（真實航班 + 模擬機 + 起始累計）。</b>Import 頁多一顆「<b>📄 Wader · CSV</b>」按鈕，把 Wader 匯出的 CSV 帶進來：① <b>真實航班</b>（含 OOOI、PIC/SIC/night 時數、起降、跑道/SID/STAR、組員）② <b>模擬機</b> session（標 SIM、時數另計、不混進飛行時數）③ <b>過往結轉時數</b>做成「起始累計」（算進總時數 + By Type、分機型保留，但不是單筆航班）。Analyze 新增「起始累計」「模擬機」兩區塊。<br>
      <b>Add Wader logbook CSV import (flights + simulator + brought-forward totals).</b> The Import page gains a "📄 Wader · CSV" button: ① real flights (OOOI, PIC/SIC/night times, takeoffs/landings, runway/SID/STAR, crew) ② simulator sessions (flagged SIM, counted separately, not in flight hours) ③ pre-app experience as an opening balance (counts toward total + By Type, kept per type, not individual flights). Analyze gains "Brought Forward" and "Simulator" sections.
    </div>
    <div class="pl-cl-v old">V1.3.16</div>
    <div class="pl-cl-txt">
      <b>匯入 crew 欄模糊比對 + Add Aircraft 自動帶機型 + crew 排版修正。</b><b>(匯入)</b> LogTen 的 crew 欄名可自訂（PIC/P1 Crew、Relief Crew… 因人而異），之前只認固定名稱、改過名就抓不到（Crew 3/4 空白）。改成<b>含關鍵字就認</b>：PIC/P1、SIC/P2、Relief/P3、CIC/Purser、Observer/OBS 各種寫法都帶得進來，也用在「你這趟是 PIC/SIC」的判斷。<b>(機籍)</b> Add Aircraft 打 tail（如 B-58553）→ 現在連<b>廠商 + 機型下拉也一起自動選好</b>（型錄有的直接選，貨機等自動填）。<b>(排版)</b> 航班編輯器 crew 欄的 rank 不再跑出卡片右邊界。<br>
      <b>Fuzzy crew-column matching on import + Add Aircraft auto-fills type + crew layout fix.</b> <b>(Import)</b> LogTen crew column names are customizable, and old exact-name matching missed renamed columns (Crew 3/4 came in blank). Now matched by keyword — PIC/P1, SIC/P2, Relief/P3, CIC/Purser, Observer/OBS variants all import, and feed the PIC/SIC role inference too. <b>(Registry)</b> Add Aircraft: typing a tail (e.g. B-58553) now also auto-selects the manufacturer + model. <b>(Layout)</b> The rank field in the flight editor's crew rows no longer overflows the card edge.
    </div>
    <div class="pl-cl-v old">V1.3.15</div>
    <div class="pl-cl-txt">
      <b>航班裡直接改同事 + 台灣機籍自動分公司 + LogTen 匯入放寬。</b><b>(改同事)</b> 航班編輯器的 crew 格選了同事，旁邊多了 <b>✏️</b>，直接改名字 / 員編（彈窗、不離開航班），改完所有航班一起更新；補員編就能拆同名。<b>(機籍)</b> 內建台灣六家航空（華航 / 長榮 / 星宇 / 立榮 / 華信 / 虎航）的註冊編號範圍：Analyze「依公司」<b>就算機尾庫沒填 operator 也能自動分出航空公司</b>；Add Aircraft 打 tail（如 B-58205）自動帶出公司。<b>(匯入)</b> LogTen 航班匯入的 On Duty / Off Duty / PIC/P1 / SIC/P2 改成<b>選填</b>——沒勾這幾欄也能匯入。<br>
      <b>Edit crew inside a flight + auto-detect Taiwan operators + looser LogTen import.</b> <b>(Edit crew)</b> Each crew slot in the flight editor now has an ✏️ to edit that colleague's name / employee id in a popup without leaving the flight; changes apply across all flights. Adding an id separates same-name colleagues. <b>(Registry)</b> Built-in registration ranges for six Taiwan carriers (China Airlines / EVA / Starlux / UNI / Mandarin / Tigerair): Analyze "By Company" now derives the operator from the tail even when your registry has none; Add Aircraft auto-fills the operator from the tail (e.g. B-58205). <b>(Import)</b> LogTen flight import now treats On Duty / Off Duty / PIC/P1 / SIC/P2 as optional — exports without those columns import fine.
    </div>
    <div class="pl-cl-v old">V1.3.14</div>
    <div class="pl-cl-txt">
      <b>班表匯入修正 + 通訊錄可直接編輯。</b><b>(匯入)</b> 修好幾個班表匯入問題：① 真實航班的 UTC 時間（像 1610Z/17Jun）少了年份被誤判、整筆掉到列表最底看不到 → 年份改從班表月份推算。② 長程加強組員、兩個機長時，本人有時被整個丟掉或擺錯槽 → 改用員編認出本人、放進正確的槽。③ 跨月回程腿（UTC 落在下個月）重匯時被誤刪 → 改用班表月份精準掃除。④ 地面班 / 訓練不再混進飛行 logbook。<b>(通訊錄)</b> Crew 名單點一個人 → 詳情頁多了 <b>✏️ Edit</b>，可直接改名字 / 員編 / 公司 / 註記，不用再繞去別處找人改；補上員編就能拆開同名同事。也可刪除聯絡人（不影響航班紀錄）。<br>
      <b>Roster import fixes + edit crew directly.</b> <b>(Import)</b> Fixed several roster-import issues: ① real flights whose UTC time lacked a year (e.g. 1610Z/17Jun) were misparsed and sank to the bottom of the list, invisible — the year is now inferred from the roster month. ② On long-haul augmented flights with two captains, you were sometimes dropped or placed in the wrong slot — now matched by employee id. ③ Cross-month return legs were wrongly removed on re-import — now swept precisely by roster month. ④ Ground duties / training no longer leak into the flight logbook. <b>(Address Book)</b> Tap a crew member → the detail now has <b>✏️ Edit</b> to change name / employee id / organization / comment directly. Adding an employee id separates same-name colleagues. You can also delete a contact (flight records untouched).
    </div>
    <div class="pl-cl-v old">V1.3.13</div>
    <div class="pl-cl-txt">
      <b>同名同事用員編拆開 + 班表匯入可挑月份。</b><b>(同名)</b> 公司有同名同事時，Crew 頁的航班數 / drill-down 改成<b>員編優先比對</b>：只要航班帶員編（V1.3.12 起的新紀錄、班表匯入的都有），同名的兩個人就能各自精準歸戶，不再一律標 SAME-NAME。只有「同名<b>又完全沒員編</b>」的人仍無法歸戶（補員編、或編輯航班時從通訊錄點選即可拆開）。<b>(挑月份)</b> Import Roster 改成兩段：先「列出可匯入月份」→ 勾選你要的（預設全選、可全選/全不選）→「匯入選取月份」，不再一次全帶。<br>
      <b>Same-name crew separated by employee id + pick months on roster import.</b> <b>(Same-name)</b> When colleagues share a name, the Crew page now matches flights by <b>employee id first</b>: any flight carrying an id (new V1.3.12+ entries and roster imports) is attributed precisely, so same-name people are no longer blanket-marked SAME-NAME. Only people who share a name <b>and have no employee id at all</b> stay unattributable (add an id, or pick them from the address book when editing a flight). <b>(Pick months)</b> Import Roster is now two-step: list available months → tick the ones you want (all selected by default) → import only those.
    </div>
    <div class="pl-cl-v old">V1.3.12</div>
    <div class="pl-cl-txt">
      <b>Crew 欄位重做 + 從通訊錄點選 + 班表組員自動進通訊錄。</b>航班的組員欄改成 <b>PIC / Crew 2 / Crew 3 / Crew 4 / CIC / OBS</b> 六格（取代舊的 PIC/SIC/FO1/FO2），每格除了名字還記 <b>rank</b>（CAP/SFO/FO/TFO/TCAP/PR…，是「那班的快照」，完訓後新班會帶新 rank）跟 <b>員編</b>。打字會跳出<b>通訊錄</b>建議直接點選。<b>(欄位名稱可改)</b> 👥 Crew 頁有「⚙ 欄位名稱」設定，改成你公司的稱呼（JX 用 CIC、EVA 用 CP…），跨裝置同步。<b>(班表自動建通訊錄)</b> 匯班表時會把駕駛艙(PIC/P1~P4/IS)+CIC 用<b>員編</b>自動加進通訊錄——飛過誰自動長出來，不用再手動匯。<b>(DHD)</b> 搭便機(DHD/positioning)的航段標成 deadhead：logbook 看得到、但飛時/PIC/night 全不計；別人在你這班 DHD 也不會被當成操作組員。<br>
      <b>Crew fields redesigned + pick from Address Book + roster crew auto-added.</b> Flight crew fields are now <b>PIC / Crew 2 / Crew 3 / Crew 4 / CIC / OBS</b> (replacing PIC/SIC/FO1/FO2); each stores name + <b>rank</b> (a per-flight snapshot) + <b>employee id</b>. Typing shows <b>Address Book</b> suggestions to tap. <b>(Editable labels)</b> the 👥 Crew page has a "⚙ field labels" setting to rename for your airline (JX=CIC, EVA=CP…), synced across devices. <b>(Auto address book)</b> importing a roster auto-adds cockpit (PIC/P1–P4/IS) + CIC to your Address Book by employee id. <b>(DHD)</b> deadhead/positioning legs are flagged deadhead — shown in the logbook but excluded from flight/PIC/night totals; someone deadheading on your flight is not counted as operating crew.
    </div>
    <div class="pl-cl-v old">V1.3.11</div>
    <div class="pl-cl-txt">
      <b>Import Roster 改走雲端 — 兩個獨立 App 也能帶班表。</b>之前「Import Roster」是讀同一個瀏覽器的 localStorage 抓 CrewSync 同步的班表。但把 CrewSync 跟 Pilot Log <b>各自加到 iPad 主畫面變成兩個獨立 App</b> 後，iOS 給每個 App 各自獨立的儲存沙箱、互不相通，所以這邊永遠「找不到班表」。改成<b>從雲端帶</b>：CrewSync 同步時會把完整班表（含組員）私下存一份到伺服器，Pilot Log 按 Import 時用<b>你的 Google email 對到員編</b>直接撈回來，跟兩個 App 共不共用儲存無關。<b>(前提)</b> CrewSync 同步用的 Google 帳號要跟 Pilot Log 登入用的<b>同一個</b>；上線後第一次請先到 CrewSync <b>重新同步一次</b>當月（及想補登的月份），班表才會進雲端。撈不到雲端時仍會退回讀本機 localStorage（瀏覽器分頁情境）。這份雲端班表是<b>你自己的、不會分享給朋友/群組</b>（跟「分享班表」完全分開、不剃組員）。<br>
      <b>Import Roster now pulls from the cloud — works across two separate apps.</b> Import Roster used to read the roster CrewSync synced from the same browser's localStorage. But once CrewSync and Pilot Log are added to the iPad home screen as <b>two separate apps</b>, iOS sandboxes each app's storage separately, so Pilot Log could never see the roster. Now it pulls from the cloud: CrewSync saves a full private copy (incl. crew) on each sync, and Import resolves <b>your Google email → employee id</b> to fetch it directly — independent of cross-app storage. <b>(Requires)</b> the Google account used for CrewSync sync must match the one you sign into Pilot Log with; after this update, re-sync the month(s) in CrewSync once so the cloud copy exists. Falls back to local localStorage when the cloud has nothing (browser-tab case). This cloud copy is <b>yours only, never shared</b> (separate from the Share feature, crew not stripped). <b>[Ops]</b> 用量後台網址由 <code>/pilot-log/admin</code> 改為 <code>/pilot-log/oops</code>（admin 太好猜，仍無密碼）。<b>[Ops]</b> usage dashboard moved from <code>/pilot-log/admin</code> to <code>/pilot-log/oops</code>.
    </div>
    <div class="pl-cl-v old">V1.3.10</div>
    <div class="pl-cl-txt">
      <b>Crew 搜尋焦點修正。</b>之前 Crew 頁的搜尋框每打一個字游標就跳離開、無法連續輸入 — oninput 把整個頁面（含 input element 本身）重畫，焦點就掉了。改成「shell + rows 容器」兩段渲染：搜尋只重畫 rows 區段，input element 不再被砍掉重建。<br>
      <b>Crew search focus fix.</b> The Crew page search box used to lose focus after every keystroke — oninput re-rendered the whole page (including the input itself), nuking focus. Split into shell + rows container; search only repaints the rows, the input stays put.
    </div>
    <div class="pl-cl-v old">V1.3.09</div>
    <div class="pl-cl-txt">
      <b>顏色重做 + 「已完成」改用 in_utc 判斷。</b>user 反映「兩種顏色就好,已完成綠、未完成藍;未來的跟未完成都是藍色」。改成：<b>(1)</b> 色條與 badge：<b>已完成（有實際抵達時間 in_utc）= 綠 / 未完成（沒填 in_utc，含未來計畫）= 藍 / 已移除 = 灰</b>。<b>(2) 篩選器</b>改成 <b>All / 已完成 Done / 未完成 Open / 已移除 Removed</b>，門檻一律看 in_utc，不再看 flight_date。<b>(3)</b> 後端 stats / 前端 Analyze / Report / CSV 全部對齊新規則：要算進統計必須有 in_utc — 沒填實際抵達時間（roster 帶進來還沒飛或忘了補的）<b>不算飛行時數</b>。這樣畫面藍色 = 不計入,綠色 = 已計入,跟你看到的顏色一致。<br>
      <b>Color redesign + "done" now defined by in_utc.</b> Per user: "just two colors — done green, open blue; future and incomplete are both blue." (1) Color bar / badge: <b>done (has actual in_utc arrival) = green / open (no in_utc, includes future) = blue / removed = gray</b>. (2) Filters: <b>All / Done 已完成 / Open 未完成 / Removed</b>, gated by in_utc, not by flight_date. (3) Backend stats + frontend Analyze / Report / CSV all aligned: an entry must have <code>in_utc</code> to count in flight stats — past-date entries without actual arrival times (roster-imported or forgotten OOOI) <b>don't add to hours</b>. So blue = not counted, green = counted, matching what you see.
    </div>
    <div class="pl-cl-v old">V1.3.08</div>
    <div class="pl-cl-txt">
      <b>LogTen 模型：拿掉 draft / confirmed，加 Lock / Unlock 防誤改。</b>過去要按 Confirm / Confirm All 才算「飛了」這套是多此一舉。改成 LogTen 風格：<b>(1)</b> Save 就是 Save，沒有 Confirm 按鈕、沒有 ✓ Confirm All。<b>(2)</b>「飛了沒」全部用航班日期隱含判斷——過去日期(≤ 今天)直接算進<b>時數 / Analyze / Report / Currency</b>，未來日期(roster 帶的計畫航班)會顯示在 Logbook 但不算進統計。後端 stats 同步改成 <code>flight_date &lt;= CURRENT_DATE</code>。<b>(3)</b> Logbook 色條改成事實：<b>過去 = 綠（flown）/ 未來 = 橘（upcoming）/ 已移除 = 灰</b>。篩選器改 All / 過去 / 未來 / 已移除。<b>(4) Lock / Unlock：</b>編輯器右上 🔓 Lock 按一下鎖起來,鎖了所有欄位 disabled、無法 Save、無法 Delete（後端也擋）—— 防自己不小心手滑改到已飛紀錄；要改就先 🔒 Unlock。<br>
      <b>LogTen model: drop draft/confirmed, add Lock/Unlock.</b> The Confirm / Confirm All workflow was unnecessary friction. Now LogTen-style: (1) Save is just Save — no Confirm button. (2) "Did you fly it?" is implied by <code>flight_date</code>: past-dated flights are counted in stats / Analyze / Report / currency; future-dated (roster-imported plans) show in the Logbook but aren't counted. Backend stats use <code>flight_date &lt;= CURRENT_DATE</code> instead of <code>status='confirmed'</code>. (3) Logbook status bar reflects fact: past = green (flown), future = amber (upcoming), removed = grey. Filters change to All / Past / Future / Removed. (4) Lock / Unlock: top-right 🔓 Lock toggle in the editor; locked entries disable all inputs, refuse Save and Delete (server enforces) — prevents accidental edits to a flown record. Unlock anytime.
    </div>
    <div class="pl-cl-v old">V1.3.07</div>
    <div class="pl-cl-txt">
      <b>班表匯入：從 CrewSync 一鍵帶進來當 draft，不用上傳檔案。</b>Import 頁新增 <b>📅 Roster · 從 CrewSync 帶班表</b>。CrewSync 同步過的班表（同瀏覽器 localStorage）直接讀進來：未飛的班全部建成 <b>draft</b>，飛完了你再 ✓ Confirm。<b>(規則)</b> 已 confirmed 的航班不會被覆蓋；只有<b>實際同步到的月份</b>裡舊 draft 沒在這次班表才標 <b>roster_removed</b>（沒同步的空檔月份不誤殺）；班表欄位重整會直接覆寫（gate / duty / 組員變更會反映）。<b>(目前限制)</b> 之後匯入 LogTen 飛行紀錄不會自動把 roster draft 接成 confirmed（兩邊 source / sourceRef 格式不同），會多一筆——你飛完了點該 draft → ✓ Confirm，或匯完 LogTen 後手動刪 roster draft。跨來源自動接合是下一輪的事。<br>
      <b>Roster import: pull from CrewSync in one tap — no file upload.</b> The Import page gains a <b>📅 Roster · from CrewSync</b> card. Whatever roster CrewSync has synced (same-browser localStorage) is pulled in as draft entries; mark each confirmed after you fly it. Confirmed entries are never overwritten; only drafts in <b>months actually re-synced this time</b> get flagged <b>roster_removed</b> (gap months are not touched); refreshed roster fields overwrite (gate/duty/crew changes apply). <b>(Known limitation)</b> A later LogTen flight import does <i>not</i> auto-promote the matching roster draft to confirmed (source mismatch — duplicates appear); confirm the draft manually after you fly, or delete the roster draft after re-importing LogTen. Cross-source matching is queued for the next round.
    </div>
    <div class="pl-cl-v old">V1.3.06</div>
    <div class="pl-cl-txt">
      <b>Add Aircraft 重做：廠商不再被卡住、Type Code 自動省略；Aircraft 列表機型可收合。</b><b>(1) 廠商不會被綁住：</b>原本廠商用 datalist 在欄位有值時會用值過濾建議，導致想重選廠商時下拉只剩當前那家。改回正常 <code>&lt;select&gt;</code>,點 Manufacturer 就重出全部廠商。<b>(2) Type Code 自動省略：</b>從目錄選了 Manufacturer + Model 就<b>不再多一個 Type Code 給你選</b>，存檔時自動從 Model 帶出代碼（A-350-900 → A359）。只有選「其他/Other」自訂時才會出現 Type Code 欄位。<b>(3) 機型分組可收合：</b>Aircraft 列表每個機型 header 點一下收合，箭頭 ▼/▶ 顯示狀態；機尾多了不用一路滑到底，看哪型展開哪型。<br>
      <b>Add Aircraft redo: Manufacturer no longer "stuck", Type Code auto-elided; Aircraft list groups collapsible.</b> (1) Manufacturer reverted to a proper <code>&lt;select&gt;</code> so re-picking shows all options again (the previous datalist filtered suggestions by the current value, which made re-selection awkward). (2) Type Code is no longer a separate picker when both Manufacturer and Model come from the catalog — it's derived automatically from the chosen model (e.g. A-350-900 → A359); the Type Code input appears only when "Other" is selected. (3) Each aircraft-type group header in the Aircraft list is now click-to-collapse with a ▼/▶ chevron, so a long tail list doesn't force you to scroll past every type.
    </div>
    <div class="pl-cl-v old">V1.3.05</div>
    <div class="pl-cl-txt">
      <b>手動新增航班：自動算夜航時數 + 自動判斷日 / 夜起降。</b>填好 Off / On + Origin / Dest，編輯器會用<b>機場座標 + 太陽角度（民用曙暮光）</b>沿大圓航路取樣，自動帶出 <b>Night Time</b>；勾 Pilot Flying 時 <b>day vs night 起降</b>也用「起飛看 origin@Off、落地看 dest@On」判斷,不再一律日間。內建你常飛的 76 個機場（RCTP/KLAX/RJAA/VHHH/WSSS/EGLL… 及兩岸日韓東南亞常見場），<b>座標查不到的機場 → 留空讓你手填，不誤判</b>。太陽公式已用 RCTP 正午（夏至 88° / 冬至 41°）與 KLAX 正午（79°）已知值驗證。手動改過的 Night 不被後續覆寫。<br>
      <b>Manual entry: auto-computed Night Time + day/night classification for takeoffs/landings.</b> Once Off/On + Origin/Dest are filled, the editor uses airport coordinates + solar altitude (civil twilight) sampled along the great-circle route to populate <b>Night Time</b>. With Pilot Flying checked, day-vs-night TO/landings are derived from origin@Off and dest@On (instead of defaulting to day). Built-in coordinates cover your 76 most-flown airports (RCTP/KLAX/RJAA/VHHH/WSSS/EGLL and major Asia/Europe/US hubs); airports without coords stay blank for you to enter manually (no wrong guesses). Solar formula validated against known RCTP solstice noon (88°/41°) and KLAX noon (79°). Manually edited Night Time is preserved.
    </div>
    <div class="pl-cl-v old">V1.3.04</div>
    <div class="pl-cl-txt">
      <b>新增飛機：廠商 / 機型可下拉選，選機型自動帶機型代碼。</b>Add Aircraft 不用再全部手打：<b>Manufacturer 廠商</b>、<b>Model 機型</b>、<b>Type Code 代碼</b>都改成可下拉（內建 Airbus / Boeing / Embraer / ATR / Bombardier 常見機型目錄，也納入你既有的機型目錄）——也可以直接打自訂值。<b>選了廠商 → 機型清單跟著換；選了機型 → 自動帶出 Type Code</b>（例：選 A-350-900 自動填 A359）。<br>
      <b>Add Aircraft: pick Manufacturer / Model from dropdowns, type code auto-fills.</b> Manufacturer, Model and Type Code are now searchable dropdowns (built-in Airbus/Boeing/Embraer/ATR/Bombardier catalog plus your existing type catalog) — you can still type custom values. Selecting a manufacturer filters the model list; selecting a model auto-fills the Type Code (e.g. A-350-900 → A359).
    </div>
    <div class="pl-cl-v old">V1.3.03</div>
    <div class="pl-cl-txt">
      <b>起降只算你當 Pilot Flying 的、Crew PIC 排第一、機型篩機尾修正。</b><b>(1) 匯入起降修正：</b>過去匯入會把 LogTen 某些欄位的錯值（例如某段顯示「97 個落地」）原封帶進來，而且你不是操作的那班也記了起降。改成<b>讀 LogTen 的「Pilot Flying」欄 — 只有你是操作飛行員（PF）那段才算起降</b>，非 PF 一律 0，並 clamp 掉爆值。新增儲存 <code>pilot_flying</code>。<b>套用既有資料：</b>因為重匯會跳過已 confirmed 的，要修正歷史請用 📥 Import → ⚠️ Wipe 後重匯一次。<b>(2) Crew PIC 排第一：</b>航班列的組員名單固定 PIC → SIC → FO… 順序，PIC 永遠在最前。<b>(3) 機型篩機尾：</b>選了 Aircraft Type 後 Tail # 真的只剩該機型的機尾（V1.3.02 還會混入其他，已修）。<br>
      <b>Takeoffs/landings only when you were Pilot Flying; PIC listed first; tail filter fixed.</b> (1) Import now reads LogTen's "Pilot Flying" column — takeoffs/landings count only for sectors you actually flew (0 otherwise), with bad values clamped (fixes the "97 landings" + landings logged when you weren't flying). Stores <code>pilot_flying</code>. To fix already-imported flights, Wipe + re-import (re-import skips confirmed entries). (2) Crew list always shows PIC first (PIC → SIC → FO…). (3) Selecting an Aircraft Type now strictly filters the Tail # dropdown to that type (V1.3.02 still leaked other tails).
    </div>
    <div class="pl-cl-v old">V1.3.02</div>
    <div class="pl-cl-txt">
      <b>智慧編輯器：自動帶時數 / 起降 / 依機型篩機尾。</b>編輯航班時不用再手算：<b>(1)</b> 填 OOOI（Out/In、Off/On）→ 自動算 <b>Block（In−Out）</b>與 <b>Air（Off−On）</b>，跨午夜也對。<b>(2)</b> Position 選 <b>PIC → 自動帶 PIC 時間</b>、SIC → 帶 SIC 時間（= block）。<b>(3)</b> 勾「I was the Pilot Flying」→ 自動帶 <b>1 起飛 + 1 落地</b>（起降欄都還沒填時才帶，不蓋手填）。<b>(4)</b> 選了 <b>Aircraft Type → Tail # 只跳出該機型的機尾</b>，不再全部混在一起。自動帶的值都還能手改。<br>
      <b>Smart editor: auto times / landings / tail filtered by type.</b> (1) Enter OOOI → Block (In−Out) and Air (Off−On) auto-compute (midnight-safe). (2) Position PIC → PIC time auto-fills (= block), SIC → SIC time. (3) "I was the Pilot Flying" → auto 1 takeoff + 1 landing (only when none entered yet). (4) Picking an Aircraft Type filters the Tail # dropdown to that type's tails. All auto-filled values stay editable. <i>(Day/night for takeoff/landing defaults to day for now — automatic day/night by location needs an airport coordinate table, coming next.)</i>
    </div>
    <div class="pl-cl-v old">V1.3.01</div>
    <div class="pl-cl-txt">
      <b>離線優先：飛機上也能看 + 改，回連自動上傳。</b>過去離線打開會被踢回登入畫面（即使手機裡有資料）——因為它每次開都堅持跟伺服器重新確認登入，離線必然失敗。改成 <b>CrewSync 那種離線優先</b>：<b>(1) 離線能看：</b>手機裡有快取就直接顯示上次的 logbook，登入鈕只在有網路時出現（Google 登入本來就需要網路）。<b>(2) 離線能改：</b>離線時新增 / 編輯 / 刪除航班，<b>立刻寫進手機本機、畫面馬上更新</b>，完全不等網路。<b>(3) 待上傳佇列：</b>每筆改動排進本機佇列，該筆標 <b>⏳</b>、上方顯示「待上傳 N 筆」，看得到哪些還沒同步。<b>(4) 回連自動上傳：</b>一偵測到有網路（或切回 App）自動依序送出，送完跟伺服器對帳。新航班先給臨時編號，上傳成功換成正式編號。所有改動「先寫本機、再背景同步」，飛機上斷續網路不掉資料。提醒：第一次一定要連網登入一次，手機才有資料可離線用。<b>另外：</b>DB 用量後台 <code>/pilot-log/admin</code> 拿掉密碼（網址未對外連結、且不再顯示任何 email），直接開就看得到用量。<br>
      <b>Offline-first: view + edit in flight, auto-upload on reconnect.</b> Previously opening offline kicked you to a login screen even with cached data, because it insisted on re-validating the session with the server on every open. Now it works like CrewSync: (1) offline view from cache; the sign-in button only appears online (Google sign-in needs network). (2) Offline create/edit/delete writes to the phone instantly — no waiting on network. (3) An outbox queue marks each pending change with ⏳ and shows "N pending"; (4) on reconnect (or app foreground) it auto-uploads in order and reconciles with the server (temp IDs swapped for real ones). Every change is local-first then background-synced, so flaky in-flight connectivity never loses data. Note: sign in online once first so the phone has data to use offline.
    </div>
    <div class="pl-cl-v old">V1.2.07</div>
    <div class="pl-cl-txt">
      <b>[Admin/Ops] 用量成長追蹤 + 多久滿 1 GB 推估。</b>後台新增<b>「成長速度 / 多久滿 1 GB」</b>卡片：<b>伺服器每天自動記一筆</b>整庫 / 餐廳+其他 / pilot-log 的大小快照（啟動 + 每 6h 檢查，<b>不靠任何人開後台</b>），用今天比過去算出<b>每天 +X MB、每月 +Y MB</b>（其中餐廳吃多少），並推估照現況<b>約幾個月後、哪天會到 1 GB 上限</b>。剛上線會顯示「累積中」，約 2-3 天有足夠快照後就會出現速度與滿載日。新增 <code>pilot_db_size_history</code> 表。<br>
      <b>[Admin/Ops] Usage-growth tracking + time-to-full (1 GB) estimate.</b> The admin page gains a <b>"growth speed / time to 1 GB"</b> card: the <b>server auto-records a daily snapshot</b> of whole-DB / restaurant+other / pilot-log sizes (on startup + a 6-hourly check, <b>no need for anyone to open the dashboard</b>) and derives <b>+X MB/day, +Y MB/month</b> (with the restaurant share), plus a projection of <b>how many months until — and roughly which date — the 1 GB plan limit is hit</b>. Right after launch it shows "accumulating"; after ~2-3 days of snapshots the speed and full date appear. New <code>pilot_db_size_history</code> table.
    </div>
    <div class="pl-cl-v old">V1.2.06</div>
    <div class="pl-cl-txt">
      <b>[Admin/Ops] 可查詢的 DB 用量後台。</b>不用再每次問 — 新增 <code>/pilot-log/admin</code> 後台頁面：輸入 admin 密碼（<code>PILOT_LOG_ADMIN_PW</code>，存 sessionStorage 免重打）→ 顯示<b>整個資料庫對 1GB 的用量進度條</b>、<b>餐廳 + 其他 vs Pilot Log 組成</b>、<b>各表大小排行</b>（餐廳出勤系統的表也看得到）、使用者/航班統計、Top users。admin/stats 端點同步加 <code>pg_database_size</code>（整個 DB 含餐廳）+ 全表 size 排行 + 剩餘空間。純後台 ops 功能，一般使用者體驗不變。<br>
      <b>[Admin/Ops] Queryable DB-usage dashboard.</b> New <code>/pilot-log/admin</code> page: enter the admin password (<code>PILOT_LOG_ADMIN_PW</code>, cached in sessionStorage) → shows whole-database usage vs the 1 GB plan (progress bar), restaurant+other vs Pilot Log composition, per-table size ranking (the restaurant/attendance tables show up too), user/flight stats, and top users. The admin/stats endpoint now also returns <code>pg_database_size</code> (whole DB incl. restaurant), an all-table size ranking, and free space. Ops-only; no change to the normal pilot experience.
    </div>
    <div class="pl-cl-v old">V1.2.05</div>
    <div class="pl-cl-txt">
      <b>真正能分析 + 一鍵 Confirm + Deadhead 標記 + Aircraft 依機型分組。</b><b>(1) Analyze 依機型 + 依公司明細表：</b>每列顯示 班數 / Block / PIC 時數 / <b>PIC Sec（PIC 段數）</b> / SIC / Night / 起飛 / 落地 + 總計列；<b>依機型</b>跟<b>依公司</b>（operator，用 tail 對機尾庫）兩張表。PIC/SIC 用實際時數。<b>deadhead 一律排除在所有飛行統計外</b>（Analyze 卡片 / 明細表 / Report recency+時數 / CSV / stats 查詢都加 <code>is_deadhead</code> 排除 — codex P1/P2）。取代原本只有長度的 by-type 長條，真正能整理分析。<b>(2) 一鍵 Confirm All：</b>Logbook 工具列加「✓ Confirm All」，把<b>過去日期</b>的 draft 一次標 confirmed（匯入歷史 logbook 後清草稿用；未來計畫航班不動 — codex P1）。後端 <code>POST /api/pilot-log/entries/confirm-drafts</code>。<b>(3) Deadhead 記錄：</b>新增 <code>is_deadhead</code> 欄，Editor 加「Deadhead / positioning」勾選可手動標（LogTen 多數匯出不帶此欄），Logbook 列顯示紫色 <b>DH</b> badge + 🧳 圖示，讓飛行與 deadhead 區分；deadhead 不算 PIC/SIC、不算起降。<b>(4) Aircraft 依機型分組：</b>機尾庫從「全部混一起」改成先列機型（type + 完整廠商機型 + tail 數 + 該型總航班），底下才是各 tail（按飛行數排序），點 tail 進原 drill-down。<br>
      <b>Real analysis + Confirm-all + Deadhead marking + Aircraft grouped by type.</b> (1) Analyze by-type table: per type → flights / block / PIC / SIC / night / takeoffs / landings + totals (PIC/SIC use actual minutes; deadheads excluded). (2) One-tap "Confirm All" in the Logbook toolbar flips all drafts to confirmed (<code>POST /entries/confirm-drafts</code>) — for cleaning up after a historical import. (3) Deadhead recording: new <code>is_deadhead</code> column, an editor "Deadhead / positioning" toggle (most LogTen exports omit the column, so manual marking matters), purple <b>DH</b> badge + 🧳 icon in the list; deadheads don't count toward PIC/SIC or takeoff/landing currency. (4) Aircraft list grouped by type: instead of one flat mixed list, types are listed first (type + full make/model + tail count + flights), with each tail underneath (sorted by flights); tap a tail for the existing drill-down.
    </div>
    <div class="pl-cl-v old">V1.2.04</div>
    <div class="pl-cl-txt">
      <b>PIC/SIC 時數對齊 LogTen + 修 draft/重複/Preview。</b>V1.2.03 用「角色 × 整段 block」反推 PIC/SIC，結果 PIC+SIC ≈ 總時間、SIC 灌爆（跟 LogTen 對不上）。<b>(1) 改成匯入 LogTen 實際 PIC/SIC 時數：</b>新增 <code>pic_minutes</code> / <code>sic_minutes</code> 欄，匯入時直接讀 LogTen 的 <code>PIC</code> / <code>SIC</code> 時數欄存進來，統計改 <code>SUM(pic_minutes)</code>（manual 舊資料 fallback 角色×block）→ 數字跟 LogTen 一致（deadhead/加強組員巡航等既非 P1 也非 P2 的時間不再被灌進來）。Editor 加 <b>PIC Time / SIC Time</b> 可手動編輯。<b>(2) draft 放寬：</b>飛行日期已過的航班一律 confirmed（deadhead、忘記記 Out 的、補登的都涵蓋），只有「未來 + 沒 Out」才 draft — 不用再依賴 Deadhead 欄。<b>(3) 修少掉的航班：</b>同檔內「日期+航班號+起降」完全相同的不同航班，原本 source_ref 碰撞會 merge 掉一筆，現在加檔內序號各自獨立。<b>(4) Preview 強化：</b>dry-run 改成<b>顯示全部 row + 可捲動</b>（不再只前 10 筆），每筆顯示 <code>role</code> / PIC / SIC 時數 / <code>DH</code>，頂部列出匯出檔欄位 headers（方便確認 PIC/SIC 時數欄有沒有被讀到）。SW cache → <code>pilotlog-v1-2-04</code>。<b>套用：</b>Wipe LogTen entries 後重匯（先 Preview）。<br>
      <b>PIC/SIC hours aligned with LogTen + draft/dup/Preview fixes.</b> V1.2.03 derived PIC/SIC as role × full block, so PIC+SIC ≈ total and SIC was inflated (didn't match LogTen). <b>(1) Import actual PIC/SIC time:</b> new <code>pic_minutes</code>/<code>sic_minutes</code> columns; import reads LogTen's <code>PIC</code>/<code>SIC</code> time columns directly, stats now <code>SUM(pic_minutes)</code> (manual entries fall back to role×block) → matches LogTen (deadhead / augmented-crew cruise time that's neither P1 nor P2 is no longer counted). Editor gains editable <b>PIC Time / SIC Time</b>. <b>(2) Draft relaxed:</b> any past-dated flight is confirmed (covers deadheads, missed Out, back-filled), only future + no Out stays draft — no longer depends on the Deadhead column. <b>(3) Missing-flight fix:</b> different flights sharing date+flight#+from+to no longer collide on source_ref (in-file sequence added). <b>(4) Preview:</b> dry-run now shows all rows + scrolls (not just 10), each row shows role / PIC / SIC time / DH, with the export's column headers listed at top. SW cache → <code>pilotlog-v1-2-04</code>. <b>To apply:</b> Wipe LogTen entries, then re-import (Preview first).
    </div>
    <div class="pl-cl-v old">V1.2.03</div>
    <div class="pl-cl-txt">
      <b>匯入修正：PIC/SIC 角色 + Deadhead/positioning。</b>之前 LogTen 匯入永遠不帶 position（v1 刻意留空），導致 Analyze/Report 的 PIC/SIC 永遠 0；deadhead 因為沒 actual Out 被誤判成 draft。<b>(1) Position 推斷：</b>LogTen 沒有單一「position」欄，改成 — 優先讀你的 <code>PIC</code>/<code>SIC</code> 時數欄（有帶就最準），沒帶則比對 <code>PIC/P1</code> vs <code>SIC/P2</code> 的姓名是不是你本人（用 Address Book <code>is_self</code>）來定 PIC/SIC。position 寫進 INSERT/UPDATE（原本根本沒帶這欄），統計就會正確。<b>(2) Deadhead：</b>讀 LogTen 的 <code>Deadhead</code>（你的 positioning 標記，備援也讀 <code>Positioning</code>）→ 是就標 <b>confirmed</b>（已發生事件，不再卡 draft），position 留空（你是乘客沒操作、不算 PIC/SIC、不影響 currency）。<b>(3) Preview 強化：</b>🔍 dry-run 每筆多顯示 <code>role=PIC/SIC</code> 跟 <code>DH</code> badge，重匯前可先驗證判斷對不對。<b>套用方式：</b>因為重匯會 skip 既有 confirmed，要讓歷史資料生效請用 📥 Import 的 ⚠️ Danger Zone「Wipe all my LogTen entries」清掉後重匯一次（建議先 Preview）。<br>
      <b>Import fixes: PIC/SIC role + Deadhead/positioning.</b> LogTen import never set <code>position</code> (left blank in v1), so Analyze/Report PIC/SIC were always 0; deadheads got mis-flagged as draft because they have no actual Out. <b>(1) Role inference:</b> LogTen has no single "position" field, so we now read your <code>PIC</code>/<code>SIC</code> time columns first (most accurate), falling back to matching the <code>PIC/P1</code> vs <code>SIC/P2</code> crew name against yourself (via Address Book <code>is_self</code>). Position is now written on INSERT/UPDATE (it wasn't before), so stats compute correctly. <b>(2) Deadhead:</b> reads LogTen's <code>Deadhead</code> flag (your positioning marker; also reads <code>Positioning</code>) → marks it <b>confirmed</b> (a completed event, no longer stuck at draft), position left blank (you were a passenger — not PIC/SIC, doesn't affect currency). <b>(3) Preview:</b> the 🔍 dry-run now shows <code>role=PIC/SIC</code> and a <code>DH</code> badge per row so you can verify before importing. <b>To apply:</b> re-import skips existing confirmed entries, so to fix history use 📥 Import → ⚠️ Danger Zone "Wipe all my LogTen entries", then re-import (Preview first recommended).
    </div>
    <div class="pl-cl-v old">V1.2.02</div>
    <div class="pl-cl-txt">
      <b>Entry 編輯表單重排 — 語意分組、不再眼花：</b>原本用 <code>auto-fit</code> 自動流（欄位「塞得下就配對」沒邏輯），改成固定語意分組的 grid 列。<b>Flight：</b>Date + Flight# 一行、<b>From + To 一行</b>、Aircraft Type + Tail# + Position 一行。<b>Times：</b>分三組小標題 — <b>Scheduled</b>（Sched Out + Sched In 一行）、<b>Actual · OOOI</b>（<b>Out + Off + On + In 同一行</b>）、<b>Duty</b>（On Duty + Off Duty 一行）。時數獨立成 <b>Hours</b> 區（Block/Air/Night 一行、Total Duty + Distance 一行），不再跟 OOOI 混。Take-offs/Landings 日夜成對、Crew（PIC+SIC / FO1+FO2）、Other（SID+STAR / Remarks）。窄螢幕用 <code>minmax(0,1fr)</code> 收縮不溢出。純前端排版，欄位與儲存邏輯不動。<br>
      <b>Entry editor form reorganized into logical groups (no more visual clutter):</b> replaced <code>auto-fit</code> (which paired fields by whatever fit) with fixed semantic grid rows. <b>Flight:</b> Date + Flight#, <b>From + To on one line</b>, Aircraft Type + Tail# + Position. <b>Times:</b> three labeled groups — <b>Scheduled</b> (Sched Out + Sched In), <b>Actual · OOOI</b> (<b>Out + Off + On + In on one line</b>), <b>Duty</b> (On Duty + Off Duty). Durations split into their own <b>Hours</b> section (Block/Air/Night, then Total Duty + Distance), no longer mixed with OOOI. Take-offs/Landings paired day/night, Crew (PIC+SIC / FO1+FO2), Other (SID+STAR / Remarks). Narrow screens shrink via <code>minmax(0,1fr)</code>. Frontend layout only; fields and save logic unchanged.
    </div>
    <div class="pl-cl-v old">V1.2.01</div>
    <div class="pl-cl-txt">
      <b>離線可用（飛機上不會再被踢回登入頁）：</b>飛行員核心痛點修正。<b>(1) Refresh token 多放一份 HttpOnly cookie：</b><code>POST /auth/login</code> 跟 <code>/auth/refresh</code> 額外 <code>Set-Cookie: plrt</code>（HttpOnly / Secure / SameSite=Lax / 90 天 / Path 限 <code>/api/pilot-log/auth</code>），iOS 對 server 設的 cookie 比 localStorage 寬容很多，PWA 7 天無互動清儲存時 cookie 通常還在；<code>/auth/refresh</code> 改成讀 cookie 優先、缺才退回 body，舊 client 100% 相容。<b>(2) IndexedDB 快取：</b>網路成功後把 entries / stats / aircraft / crew / aircraft_types / suggest / aircraftEntries / user 寫一份進 IDB（容量比 localStorage 大、適合 50k 筆 entries、iOS 對 IDB 保護較佳）；下次打開 <b>cache-first</b>：先用 IDB 快取秒出畫面、再背景刷新。<b>(3) Cookie-only session 復活：</b><code>_plTryRefresh</code> 拿掉「沒 refreshToken 就 fail」的早退，localStorage 被清也能靠 cookie 復活一個新 session。<b>(4) OFFLINE 旗標：</b>頂部琥珀色細條「OFFLINE — Showing last cached data」，網路掛了顯示、回來自動消，列表/統計/報表全部用快取資料運作不卡死。<b>(5) Persistent storage 申請：</b>啟動時 <code>navigator.storage.persist()</code> 請瀏覽器把儲存標 persistent，iOS 不保證 100% 但會延長保留。<b>(6) <code>_plFetchAll</code> 跟 <code>_plFetchAircraftEntries</code> 改 try/catch 包起來</b>：網路異常不再讓 caller 炸掉，全部 graceful 降級到快取。SW cache 跟 <code>pilotlog-v1-2-01</code>。<br>
      <b>Offline-capable (you will no longer be kicked back to login on the plane):</b> fixes the core pilot pain point. <b>(1) Refresh token also in HttpOnly cookie:</b> <code>/auth/login</code> and <code>/auth/refresh</code> now <code>Set-Cookie: plrt</code> (HttpOnly / Secure / SameSite=Lax / 90 days / Path scoped to <code>/api/pilot-log/auth</code>); iOS treats server-set cookies more leniently than localStorage, so even when the 7-day PWA storage eviction wipes localStorage, the cookie typically survives. <code>/auth/refresh</code> reads cookie first, body second — old clients still work. <b>(2) IndexedDB cache:</b> on successful fetch the app writes entries / stats / aircraft / crew / aircraft_types / suggest / aircraftEntries / user into IDB (larger than localStorage, fits ~50k entries, iOS protects IDB better). Next launch is <b>cache-first</b>: instant render from IDB, then background refresh. <b>(3) Cookie-only session resurrection:</b> <code>_plTryRefresh</code> no longer early-exits when localStorage is empty — a cookie-only call can revive the session. <b>(4) OFFLINE banner:</b> a thin amber top bar appears when network is down; list / stats / report all keep working off cached data. <b>(5) Persistent storage request:</b> <code>navigator.storage.persist()</code> on init asks the browser to mark storage persistent (iOS not guaranteed but extends retention). <b>(6) <code>_plFetchAll</code> / <code>_plFetchAircraftEntries</code> wrap in try/catch</b>: network failures no longer throw into callers, everything degrades gracefully to cache. SW cache follows to <code>pilotlog-v1-2-01</code>.
    </div>
    <div class="pl-cl-v old">V1.1.02</div>
    <div class="pl-cl-txt">
      <b>iPad 分割視窗（master-detail）對齊 LogTen Pro：</b>Logbook 在寬螢幕（≥768px）改為左列表＋右明細並排，點一筆右側直接開 editor、不跳全螢幕，左側被選取的列藍框 highlight；iPhone 維持點一筆全螢幕的行為，跳轉照舊。<b>列表改 LogTen 四行密集卡：</b>大日期（日／MON 'YY）／起飛 HHMM ── 飛時 hrs ── 落地 HHMM（中間用線連起來）／大字 ORIGIN ... DEST／✈ 機尾，機型 ... Flt#／組員姓名（單行省略）。原本 iPad 單行擠到兩端、中間留白的「空蕩」感消除。Aircraft / Crew drill-down 點航班仍走全螢幕 editor（那兩頁沒分割面板），切到 Analyze / Report 時選取自動清除。SW cache 跟著走 <code>pilotlog-v1-1-02</code>。<br>
      <b>iPad master-detail split aligning with LogTen Pro:</b> on screens ≥768px the Logbook is now a side-by-side list + detail layout — tapping a row opens the editor on the right (no full-screen jump), with the selected row outlined in accent; iPhone keeps the tap → full-screen behavior unchanged. <b>Rows redesigned as LogTen-style dense 4-line cards:</b> big day / DEP HHMM ── duration ── ARR HHMM (connector line) / big airport codes ORIGIN ... DEST / ✈ tail, type ... Flt# / crew names (single-line ellipsis). Removes the empty-middle look of the previous single-line iPad row. Aircraft / Crew drill-down tap still uses the full-screen editor (those pages have no detail pane); switching to Analyze / Report auto-clears the selection. SW cache follows to <code>pilotlog-v1-1-02</code>.
    </div>
    <div class="pl-cl-v old">V1.1.0</div>
    <div class="pl-cl-txt">
      <b>介面大改版：對齊 CrewSync / 晨報。</b>主功能選單從內容頁上方的一排按鈕，改成底部固定的 <b>tab bar</b>（📊 Analyze / 📒 Logbook / 📄 Report）＋右側功能鍵區（☀️/🌙 日夜切換、A+/A- 字級 20 段、版號點開更新日誌）。<b>(1) 日夜主題：</b>新增完整淺色主題，沿用 CrewSync / 晨報 的 <code>data-theme</code> + CSS var pattern，偏好存 <code>pilotlog_theme</code> / <code>pilotlog_font_scale</code>（純本機、跨裝置不同步），load 時先套用避免 FOUC。<b>(2) Logbook：</b>原本的航班清單頁，集中所有資料管理 — 篩選、＋New Entry、📥 Import、✈️ Aircraft、👥 Crew 都在這；統計從這裡移走。<b>(3) Analyze（純統計）：</b>把 Total / PIC / SIC / Night、7/28/90 天 rolling、by-type 拉成獨立頁，再加近 12 個月 block hours 長條圖跟 by-type 水平 bar（純 inline SVG，不加 chart library、維持離線可用）。<b>(4) Report（全新）：</b>90 天起降 recency 卡片（日/夜起降次數、最後飛行日；僅供參考非官方判定）＋日期區間時數總表（預設今年至今，算 block/PIC/SIC/night/班數/落地數）＋匯出 CSV／列印。功能邏輯與既有 API 不動，純前端改版。<br>
      <b>Major UI redesign aligning with CrewSync / morning report.</b> The main menu moved from a top toolbar to a fixed bottom <b>tab bar</b> (📊 Analyze / 📒 Logbook / 📄 Report) plus a utility cluster (☀️/🌙 light-dark toggle, 20-step A+/A- font scale, version tag opening the changelog). <b>(1) Theme:</b> full light theme added, reusing CrewSync / morning report's <code>data-theme</code> + CSS-var pattern; preferences persist in <code>pilotlog_theme</code> / <code>pilotlog_font_scale</code> (per-device), applied early to avoid FOUC. <b>(2) Logbook:</b> the flight list page now centralizes all data management — filters, + New Entry, 📥 Import, ✈️ Aircraft, 👥 Crew; stats moved out. <b>(3) Analyze:</b> Total / PIC / SIC / Night, 7/28/90-day rolling, and by-type are now their own page, plus a trailing-12-month block-hours bar chart and by-type horizontal bars (pure inline SVG, no chart library, stays offline-capable). <b>(4) Report (new):</b> 90-day takeoff/landing recency cards (day/night counts, last flight date; informational, not an official currency determination) + a date-range hours summary (defaults to year-to-date: block/PIC/SIC/night/flights/landings) + CSV export / print. Backend APIs unchanged; frontend-only redesign. <b>(5) 平板／桌機全寬：</b>內容區拿掉 max-width 置中，iPad / 筆電不再兩側留白。<b>(6) 雙語說明：</b>各頁說明文字改中英對照（短標籤維持英文，飛行員通用），crew 中文名字是資料、完全不動。<b>(7) Report / Analyze 只計已飛：</b>recency / 時數 / 圖表 / CSV 都只算 <code>confirmed</code>（已飛）的 entry，draft（計畫中）跟 roster_removed 不計入，避免起降數與 block 時數灌水。<br>
      <b>(5) Full-width on tablet/desktop:</b> removed the centered max-width so iPad / laptop no longer waste side margins. <b>(6) Bilingual copy:</b> descriptive text is now Chinese + English (short labels stay English, universal for pilots); crew names are data and left untouched. <b>(7) Report / Analyze count flown flights only:</b> recency, hours, charts, and CSV all count <code>confirmed</code> entries only — drafts (planned) and roster_removed are excluded, so takeoff/landing counts and block time aren’t inflated.
    </div>
    <div class="pl-cl-v old">V1.0.11</div>
    <div class="pl-cl-txt">
      新增 LogTen <b>Aircraft Types</b> 匯入跟 👥 <b>Crew</b> 列表頁，補齊兩個 V1.0.10 之後使用者馬上就會碰到的工作流。<b>(1) Aircraft Types：</b>LogTen 其實有兩種 export — 一種是 Aircraft（tail 為主，必填 <code>Aircraft ID / Operator</code>），另一種是 Aircraft Types（type 為主、無 tail，必填只有 <code>Type</code>）；之前 UI 只認得前者，使用者把 Aircraft Types 檔丟進 Aircraft 區塊就會撞 <code>missing_required_columns</code>。新表 <code>pilot_aircraft_types</code>（<code>type_code/make/model/engine_type/category/class/notes</code>，<code>UNIQUE(user_id, type_code)</code>）+ 兩個 endpoint <code>POST /api/pilot-log/import/logten-aircraft-types</code>、<code>GET /api/pilot-log/aircraft-types</code>，都走 COALESCE upsert 保留舊資料。📥 Import 區明確分成 📋 <b>Aircraft</b> 跟 🧭 <b>Aircraft Types</b> 兩塊（含「不是 Aircraft Types」的明確提示），Aircraft 列表 / drill-down 顯示時會把 <code>A359</code> enrich 成 <code>Airbus A-350-900</code>，方便辨識。<b>(2) Crew 列表頁：</b>V1.0.09 backend 已把 Address Book 寫進 <code>crew</code> + <code>crew_employee_ids</code>，但沒 UI，這版補上。新 endpoint <code>GET /api/pilot-log/crew</code>（<code>JOIN ... array_agg</code> 把 employee IDs 帶出），主頁工具列加紫色 👥 Crew 按鈕；列表頁可搜尋 name 或 employee ID、顯示一起飛過的航班次數、<code>is_self</code> 的人 mark 「YOU」、點進 drill-down 顯示一起飛過的所有航班。<b>(3) 同名保護（SAME-NAME）：</b>因為 <code>entry.crew</code> JSONB 只記名字、沒帶 <code>employee_id</code>，如果 Address Book 內有兩位 crew 同名，從某筆航班是無法判斷該名出自哪一位的。為避免錯誤歸屬，列表頁會給同名 crew 掛橘色 <code>SAME-NAME</code> badge、flight count 改顯示 <code>—</code>、drill-down 完全不列航班，改顯示警告框 + 建議在 LogTen 端用 organization / comment 區分後重匯。順手把 5 個新 endpoint 的 auth 401 檢查補進 smoke test。<br>
      Added LogTen <b>Aircraft Types</b> import and a 👥 <b>Crew</b> list page, closing two workflows users immediately ran into post-V1.0.10. <b>(1) Aircraft Types:</b> LogTen actually has two exports — Aircraft (tail-centric, requires <code>Aircraft ID / Operator</code>) vs Aircraft Types (type-centric, no tail, only <code>Type</code> required); the old UI only recognized the former, so dropping an Aircraft Types file into the Aircraft section returned <code>missing_required_columns</code>. New table <code>pilot_aircraft_types</code> (<code>type_code/make/model/engine_type/category/class/notes</code>, <code>UNIQUE(user_id, type_code)</code>) plus two endpoints <code>POST /api/pilot-log/import/logten-aircraft-types</code> and <code>GET /api/pilot-log/aircraft-types</code>, both COALESCE upsert to preserve existing data. The 📥 Import section now clearly separates 📋 <b>Aircraft</b> from 🧭 <b>Aircraft Types</b> (with explicit "not Aircraft Types" disambiguation), and the Aircraft list / drill-down enriches codes like <code>A359</code> into <code>Airbus A-350-900</code> for recognition. <b>(2) Crew list page:</b> V1.0.09's backend already wrote Address Book to <code>crew</code> + <code>crew_employee_ids</code>, but had no UI — fixed here. New endpoint <code>GET /api/pilot-log/crew</code> (<code>JOIN ... array_agg</code> for employee IDs), purple 👥 Crew button in the main toolbar; list page supports search by name or employee ID, shows shared-flight counts, marks <code>is_self</code> with "YOU", and drill-down lists all flights flown together. <b>(3) Same-name protection:</b> because <code>entry.crew</code> JSONB stores only names, not <code>employee_id</code>, when two Address Book crews share a display name there is no way to tell which one a given flight refers to. To prevent misattribution, the list tags same-name crew with an orange <code>SAME-NAME</code> badge, replaces the flight count with <code>—</code>, and the drill-down refuses to list any flights — instead showing a warning suggesting users differentiate them via organization / comment in LogTen and re-import. Also added auth 401 checks for the 5 new endpoints to the smoke test.
    </div>
    <div class="pl-cl-v old">V1.0.10</div>
    <div class="pl-cl-txt">
      新增 ✈️ Aircraft 列表頁，把「依飛機看航班」工作流補齊。主頁工具列加 ✈️ Aircraft 按鈕 → 列表顯示所有 <code>pilot_aircraft</code> 跟每架的 flight 數，點某架 → drill-down 顯示用過這架的所有航班。配套三個基礎修正：(a) 後端新 endpoint <code>POST /api/pilot-log/aircraft</code>，公司新交機等情境可手動加 tail / type / 廠商 / 完整機型 / operator / notes，已存在 tail 走 COALESCE upsert 不洗掉舊資料，<code>tail_no</code> 統一 <code>trim + uppercase</code> 避免 <code>b-58502</code> 跟 <code>B-58502&nbsp;</code> 變兩筆；(b) Aircraft 頁的完整資料來源改從獨立快照 <code>_pl.aircraftEntries</code> 撈（不受主頁 filter 跟 200 limit 影響），不再讓「我看了哪個 status」「在第幾頁」污染 aircraft 的 count 跟 drill-down，後端 entries endpoint <code>limit</code> 上限從 1000 拉到 50000 給這個獨立快照用；(c) <code>_plOpenEditor</code> 加 fallback：找不到 entry 時退到 <code>_pl.aircraftEntries</code> 找，避免 Aircraft drill-down 顯示得到、點下去卻打不開的洞。順手把 V1.0.09 已做好但沒接的 Address Book import UI 接上，📥 Import 多一個 👥 Address Book 區塊，匯入結果顯示 <code>inserted / updated / conflicts / self_set / self_update_error</code>。Entry editor 的 aircraft picker（新增 log 直接選飛機）跟「save 後回 Aircraft drill-down」這兩個非阻擋 UX 留 V1.0.11。<br>
      Added ✈️ Aircraft list page, completing the "view flights by aircraft" workflow. The main toolbar now has an ✈️ Aircraft button → opens a list of all <code>pilot_aircraft</code> with per-aircraft flight counts; tap an aircraft → drill-down showing every flight that used that tail. Three foundational fixes shipped together: (a) new backend endpoint <code>POST /api/pilot-log/aircraft</code> for manual add (new delivery aircraft, etc.) with fields tail / type / make / model / operator / notes — existing tails go through COALESCE upsert so empty fields don't wipe old data, <code>tail_no</code> is normalized via <code>trim + uppercase</code> to prevent <code>b-58502</code> and <code>B-58502&nbsp;</code> becoming two rows; (b) Aircraft page reads from an independent <code>_pl.aircraftEntries</code> snapshot (not affected by main filter or 200-row pagination), so "which status I'm filtering on" / "which page I'm on" no longer corrupts aircraft counts or drill-down — the backend entries endpoint <code>limit</code> cap was raised from 1000 to 50000 to support this single-shot fetch; (c) <code>_plOpenEditor</code> now falls back to <code>_pl.aircraftEntries</code> when an entry isn't in the main list, fixing a hole where flights visible in the Aircraft drill-down would silently fail to open. Also wired up the Address Book import UI for V1.0.09's already-shipped backend — 📥 Import now has a 👥 Address Book section, showing <code>inserted / updated / conflicts / self_set / self_update_error</code> from the response. Two non-blocking UX items deferred to V1.0.11: aircraft picker in the entry editor (new logs can select from saved aircraft instead of typing) and "return to Aircraft drill-down after save" instead of bouncing to the main list.
    </div>
    <div class="pl-cl-v old">V1.0.09</div>
    <div class="pl-cl-txt">
      新增 LogTen Address Book 匯入，把 crew 名單存進 DB 變成可查詢的資料。新表 <code>crew</code> + <code>crew_employee_ids</code>（alias 表，支援換公司多 <code>employee_id</code>）。識別邏輯以 <code>employee_id</code> 為主、<code>display_name</code> 為輔：row 的 <code>ids[]</code> 在 alias 表命中單一 crew 就 upsert；命中多個 crew 視為 conflict、不自動合併；row 完全沒 ID 時才用名字弱比對「也都沒 ID 的 crew」，多筆同名也視為 conflict、不默默接第一筆。<code>is_self</code> 只有當檔案有明確 <code>This is Me=1</code> 才動，採 clear-then-set 包單一 TX，避免有「沒人是 self」窗口；沒標記就完全不動現有 <code>is_self</code>（避免匯入別人的 Address Book 把自己誤清）。寫入保證：每 row 用獨立 <code>BEGIN/COMMIT</code>，中途任一步失敗整 row <code>ROLLBACK</code>，不留半套 crew + 部分 alias。<code>is_self</code> TX 若失敗，錯誤訊息透過 <code>self_update_error</code> 欄位帶到 caller，不再 silent swallow。新 endpoint <code>POST /api/pilot-log/import/logten-addressbook</code>。新增 importer 專屬 unit test（17 cases 覆蓋 <code>normName</code> / <code>normIds</code> 的 normalize 邏輯），加進 <code>npm run test:all</code> pipeline；importer 主邏輯（lookup / conflict / TX 寫入）目前仍靠 smoke + 實機驗證，待之後補 integration 測試。<code>API.md</code> 同步補完 endpoint 文件 + conflict 規則 + <code>self_update_error</code> 說明。<br>
      Added LogTen Address Book import, turning the crew roster into queryable DB-backed data. New tables: <code>crew</code> + <code>crew_employee_ids</code> (alias table supporting multiple <code>employee_id</code>s per person for company-change cases). Identification logic uses <code>employee_id</code> as primary key, <code>display_name</code> only as fallback: a row's <code>ids[]</code> hitting a single crew via alias → upsert; hitting multiple crews → conflict, not auto-merged; only when a row has no IDs at all does it fall back to weak name match against ID-less crews, and multi-name match is also a conflict, not silently taking the first. <code>is_self</code> is only touched when the file has explicit <code>This is Me=1</code>, using clear-then-set wrapped in a single TX to avoid a "no one is self" window; without explicit marks, existing <code>is_self</code> stays untouched (so importing someone else's Address Book doesn't wipe yours). Write guarantee: each row gets its own <code>BEGIN/COMMIT</code> — any mid-row failure rolls the entire row back, no orphan crew + partial alias. If the <code>is_self</code> TX fails, the error is surfaced to caller via <code>self_update_error</code> field instead of being silently swallowed. New endpoint <code>POST /api/pilot-log/import/logten-addressbook</code>. New importer-specific unit tests (17 cases covering <code>normName</code> / <code>normIds</code> normalization), added to the <code>npm run test:all</code> pipeline; the importer's main logic (lookup / conflict / TX writes) is still covered by smoke + manual verification — integration-level tests deferred. <code>API.md</code> updated with the full endpoint doc, conflict rules, and <code>self_update_error</code> notes.
    </div>
    <div class="pl-cl-v old">V1.0.08</div>
    <div class="pl-cl-txt">
      新增帳號刪除功能（Apple App Store 5.1.1(v) 要求提供 in-app delete account），為未來上架做準備。新增 endpoint <code>DELETE /api/pilot-log/account</code>，會以 CASCADE 方式刪除使用者的 emails / sessions / log entries / aircraft 全部資料，無法復原。前端在 About modal 底部加入 Danger Zone 紅色區塊（點 header 右上角版號開啟），採雙段 confirm 才會真的呼叫 API，以避免誤觸。另新增 <code>API.md</code> 完整 REST contract 文件，整理全部 endpoint 的 method / path / auth / request / response 範例，以及 native client 注意事項（Keychain 儲存 token、refresh singleton 必做、未來 Apple Sign In endpoint 預留位置等），讓之後 native app 開發可直接參照，降低遷移成本。<br>
      Added account deletion (Apple App Store 5.1.1(v) requires in-app account deletion), preparing for future store submission. New endpoint <code>DELETE /api/pilot-log/account</code> cascades deletion of the user's emails / sessions / log entries / aircraft and is irreversible. The frontend adds a red Danger Zone section at the bottom of the About modal (opened via the header version badge) with two-step confirmation before calling the API to reduce accidental deletion. Also added <code>API.md</code>, a full REST contract document covering every endpoint's method / path / auth / request / response examples plus native-client notes (Keychain token storage, mandatory refresh singleton, reserved spot for a future Apple Sign In endpoint, etc.), so future native app development has a direct reference and migration cost stays lower.
    </div>
    <div class="pl-cl-v old">V1.0.07</div>
    <div class="pl-cl-txt">
      <b>修 access token 過期時的並發 refresh race</b>：原本 <code>_plFetchAll()</code> 用 <code>Promise.all</code> 同時打 4 個 API（entries / stats / aircraft / quick-suggest），token 過期時 4 個並發各自呼叫 <code>_plTryRefresh()</code>，server 的 refresh token rotation 後第一個成功、後 3 個拿著已作廢的 refresh token 全部失敗 — 任何 race-loser 失敗都會觸發 <code>_plClearSession()</code> → 把已成功更新的 session 清掉、誤把使用者登出，同時部分 API 會看似「資料消失」（iPad PWA 隔天打開常見 stats summary 不見）。改成 singleton in-flight lock：同時間只允許一個 refresh 在跑，其他 caller 共用同一個 promise；只有 server 確實回 401（refresh token 真的失效）才清 session，5xx / 網路錯誤等暫時性失敗保留 session 下次再試。預期效果：iPad PWA 隔天打開不再被登出（refresh token 90 天內持續有效），stats summary 不再偶發消失。<br>
      <b>Fixed concurrent refresh race on access token expiry</b>: previously <code>_plFetchAll()</code> fired 4 parallel API calls via <code>Promise.all</code>; on token expiry all 4 hit 401 and each invoked <code>_plTryRefresh()</code> in parallel. After the server's refresh token rotation the first refresh succeeded but the other 3 race-losers failed with the now-invalidated old refresh token, and any failure triggered <code>_plClearSession()</code> — wiping the freshly-rotated session and forcing re-login, while some APIs (stats / aircraft / quick-suggest) appeared as "missing data" (iPad PWA next-day open often lost the stats summary). Now uses a singleton in-flight lock: only one refresh runs at a time, concurrent callers share the same promise; <code>_plClearSession()</code> only fires on a definitive 401 from server (refresh token actually invalid), retaining session for transient 5xx / network errors. Expected: iPad PWA no longer forces re-login on next-day reopen (refresh token stays valid for 90 days), stats summary no longer randomly disappears.
    </div>
    <div class="pl-cl-v old">V1.0.06</div>
    <div class="pl-cl-txt">
      <b>修 LogTen import blocking bug</b>：原本 <code>parseTab()</code> 用 split-by-line / split-by-tab 的天真版本，碰到 LogTen 多行 Remarks（用 <code>"..."</code> 包、內嵌 <code>\\n</code>）時會把一筆飛行記錄拆成多個假 row，假 row 的第一欄變成 Remarks 中段內容、撞 Date 格式驗證、整批 reject。重寫成 proper TSV state machine（抽到 <code>src/pilot-log/tsv-parser.ts</code>），正確處理 quoted field、embedded newline / tab、escaped quote (<code>""</code>)、BOM、<code>\\n</code>/<code>\\r\\n</code>/<code>\\r</code> 三種 line ending、檔尾無 newline、close quote 後嚴格期待 tab / newline / EOF 否則 throw、unterminated quote at EOF 也 throw。新增 <code>test/parsetab.test.ts</code> 純函式 unit test，17 項全過：codex 指定 6 類核心（單行 unquoted / 單行 quoted / 多行 quoted Remarks / escaped quote / 最後一欄 multiline / 空欄位+尾端 tab）+ 4 個 care points（BOM / 三種 line ending / EOF 無 newline / close quote 嚴格）+ 7 個 extra edge cases（混合 row / empty quoted / 內嵌 tab / unterminated / 全空 row / 中間 quote / CRLF+multi-line）。<code>npm run test:all</code> 自動先跑 parser test 再跑 smoke。<br>
      <b>Fix LogTen import blocking bug</b>: the old <code>parseTab()</code> used naive split-by-line / split-by-tab, which broke on LogTen multi-line Remarks (wrapped in <code>"..."</code> with embedded <code>\\n</code>) — splitting one flight entry into multiple ghost rows whose first cell (Date) became Remarks fragments, triggering bulk reject on date format. Rewrote as a proper TSV state machine (extracted to <code>src/pilot-log/tsv-parser.ts</code>) handling quoted fields, embedded newline/tab, escaped quotes (<code>""</code>), BOM, <code>\\n</code>/<code>\\r\\n</code>/<code>\\r</code> line endings, EOF without trailing newline; strict throws on close-quote followed by non-terminator and on unterminated quote at EOF. New <code>test/parsetab.test.ts</code> with 17 unit tests passing: codex's 6 core scenarios + 4 care points + 7 edge cases. <code>npm run test:all</code> runs parser tests first, then smokes.
    </div>
    <div class="pl-cl-v old">V1.0.05</div>
    <div class="pl-cl-txt">
      新增 admin stats endpoint，讓使用量 / 容量管理可見（因應 Pilot Log 跟餐廳 POS 共用 1 GB Postgres，必須能監控成長速度與重度使用者）。
      (1) Schema 補欄位：<code>pilot_users.last_seen_at</code>（active user 偵測）+ <code>pilot_users.last_import_at</code>（重 import 偵測）。<code>last_seen_at</code> 在 <code>requireAuth</code> middleware 用 server-side 條件式 UPDATE 寫入（<code>WHERE last_seen_at IS NULL OR last_seen_at &lt; NOW() - INTERVAL '1 minute'</code>），每分鐘最多寫 1 次、fire-and-forget 不擋 user。
      (2) <code>GET /api/pilot-log/admin/stats?pw=&lt;PILOT_LOG_ADMIN_PW&gt;</code>：server-side admin secret（環境變數，timing-safe compare），不沿用前端可見模式。回傳結構分兩層：<b>summary</b>（total / active_7d / active_30d / with_entries / with_imports / entries 統計 / 總 size）+ <b>breakdown</b>（per-table 三組 size：<code>pg_total_relation_size</code> + <code>pg_relation_size</code> + <code>pg_indexes_size</code> + 推算 toast；top users by entry count，default 10、可選 <code>?limit=N</code> 最大 50）。
      (3) 60 秒 in-memory cache（admin 用、低頻；不做事件型主動失效）。<br>
      Added admin stats endpoint for usage / capacity management (Pilot Log shares a 1 GB Postgres with the user's restaurant POS — growth tracking and heavy-user identification are required).
      (1) Schema additions: <code>pilot_users.last_seen_at</code> (active user detection) + <code>pilot_users.last_import_at</code> (heavy import detection). <code>last_seen_at</code> updates via server-side conditional UPDATE in the <code>requireAuth</code> middleware (<code>WHERE last_seen_at IS NULL OR last_seen_at &lt; NOW() - INTERVAL '1 minute'</code>) — at most one write per user per minute, fire-and-forget so it never blocks the user.
      (2) <code>GET /api/pilot-log/admin/stats?pw=&lt;PILOT_LOG_ADMIN_PW&gt;</code>: server-side admin secret (env var, timing-safe compare), distinct from any user-visible password pattern. Two-tier response: <b>summary</b> (total / active_7d / active_30d / with_entries / with_imports / entries stats / total size) + <b>breakdown</b> (per-table three sizes: <code>pg_total_relation_size</code> + <code>pg_relation_size</code> + <code>pg_indexes_size</code> + computed toast; top users by entry count, default 10, optional <code>?limit=N</code> max 50).
      (3) 60-second in-memory cache (admin use, low frequency; no event-driven invalidation in v1).
    </div>
    <div class="pl-cl-v old">V1.0.04</div>
    <div class="pl-cl-txt">
      LogTen import 效能優化 + in-file dedup + 全部寫入包 transaction（<b>業務語意維持 V1.0.02 行為</b>）。原本逐筆 SELECT + INSERT，2000 筆會打 4000 次 query 撞 Render 30s timeout。改成：(1) <b>Batch lookup</b>：一次 <code>SELECT</code> 撈出所有現有 <code>source_ref</code> 進 Map，省 N 次 SELECT。(2) <b>Bulk INSERT</b>：每 50 筆 row 合併成一個 <code>INSERT ... VALUES (...), (...), ...</code> statement（35 col × 50 row = 1750 params/batch，遠低於 PG 65535 限制），省 95%+ round trip。預估 2000 筆從 ~40s 降到 ~3-5s。UPDATE 維持逐筆（draft → confirmed 是少數情境、不是瓶頸）。(3) <b>In-file dedup</b>：existingMap 在 loop 中即時回寫，讓「同一檔內 sourceRef 重複」走跟 cross-run 一樣的語意（confirmed → 後者 skip；draft → 後者覆蓋前者），避免 bulk INSERT 撞 UNIQUE constraint 整批 fail。(4) <b>Atomic transaction</b>：所有 INSERT + UPDATE 包在單一 BEGIN/COMMIT 區塊（<code>pool.connect()</code> 取得 client），任一失敗就 ROLLBACK 全部，不會留 partial 寫入；前端會看到 500 而不是假的成功訊息，counter 也只在 COMMIT 後才寫進 result。<br>
      LogTen import perf optimization + in-file dedup + transactional writes (<b>business semantics preserve V1.0.02 behavior</b>). Old code did per-row SELECT + INSERT — 2000 rows = 4000 queries, hitting Render's 30s timeout. New: (1) <b>Batch lookup</b>: single <code>SELECT</code> pulls all existing <code>source_ref</code>s into a Map. (2) <b>Bulk INSERT</b>: every 50 rows merge into one <code>INSERT ... VALUES (...), (...), ...</code> statement (35 × 50 = 1750 params/batch, well under PG's 65535 limit), saving 95%+ round trips. Estimated 2000 rows: ~40s → ~3-5s. UPDATE stays per-row. (3) <b>In-file dedup</b>: existingMap is updated in-loop so duplicate sourceRefs within the same file follow the same semantics as cross-run, avoiding bulk INSERT UNIQUE constraint blowups. (4) <b>Atomic transaction</b>: all INSERTs + UPDATEs wrapped in a single BEGIN/COMMIT block on a dedicated client (<code>pool.connect()</code>); any failure ROLLBACKs everything — no partial state, frontend gets a real 500 instead of a misleading success message, counters are only written to result after COMMIT.
    </div>
    <div class="pl-cl-v old">V1.0.03</div>
    <div class="pl-cl-txt">
      新增 LogTen entries bulk-delete 救援機制（escape hatch），讓匯入失敗 / 想完全重來時可以一鍵清掉。<code>DELETE /api/pilot-log/entries?source=logten&confirm=true</code> 砍掉當前 user 所有 LogTen 來源的 entries（auth 必須登入、<code>source</code> 必須是 <code>'logten'</code>、<code>confirm</code> 必須是 <code>'true'</code>，缺一就 reject），回傳實際刪除筆數。第一版意圖性收斂：<b>不開 <code>source=all</code> / <code>manual</code> / <code>roster</code></b>；<b>不影響機尾庫</b>（<code>pilot_aircraft</code>）；不影響非 LogTen 來源的 entries。Import 介面底部新增 ⚠️ Danger Zone：紅色 <b>🗑️ Wipe all my LogTen entries</b> 按鈕，兩段 confirm 才執行，避免誤觸。<br>
      Added LogTen entries bulk-delete escape hatch for botched imports / clean restart. <code>DELETE /api/pilot-log/entries?source=logten&confirm=true</code> wipes all LogTen-sourced entries belonging to the current user (auth required; <code>source</code> must be <code>'logten'</code>; <code>confirm</code> must be <code>'true'</code>; missing any rejects). Returns actual delete count. v1 intentionally narrow: <b>no <code>source=all</code> / <code>manual</code> / <code>roster</code></b>; <b>tail registry untouched</b> (<code>pilot_aircraft</code>); non-LogTen entries untouched. Import page now has an ⚠️ Danger Zone at the bottom with a red <b>🗑️ Wipe all my LogTen entries</b> button gated behind two confirms.
    </div>
    <div class="pl-cl-v old">V1.0.02</div>
    <div class="pl-cl-txt">
      LogTen import 改成 smart 模式，語意對齊飛行實況：(1) <b>Smart status</b>：每筆 entry 依據 actual <code>Out</code> 是否填寫決定 status —有填→<code>confirmed</code>（已飛）；空白→<code>draft</code>（計畫中、還沒飛）。原本 V1.0.0x 一律 confirmed 是錯的語意，未飛的航班放 confirmed 不合理。(2) <b>Smart re-import</b>：同 source_ref 重 import 時，現有 <code>draft</code> / <code>roster_removed</code> 整筆覆蓋（LogTen 是 source of truth）；現有 <code>confirmed</code> 一律 skip 不動，保護使用者的手動編輯。所以「飛之前先 import 計畫，飛完 LogTen 補完 actual 再 import 一次」會正確把 draft 升級成 confirmed。(3) Preview / 結果頁顯示每筆 action badge：<b>NEW draft / NEW confirmed / UPDATE→confirmed / SKIP</b>，加總顯示新增、更新、保留三類數字，使用者一眼看到會發生什麼。<br>
      LogTen import upgraded to smart mode that respects flight reality: (1) <b>Smart status</b>: each entry's status now derives from whether actual <code>Out</code> is filled — filled → <code>confirmed</code> (flown); empty → <code>draft</code> (planned but not yet flown). Previous V1.0.0x always-confirmed semantic was wrong for unflown flights. (2) <b>Smart re-import</b>: when re-importing the same source_ref, existing <code>draft</code> / <code>roster_removed</code> entries are fully overwritten (LogTen is source of truth); existing <code>confirmed</code> entries are always skipped, preserving manual edits. So "import schedule before flight, then re-import after LogTen has actuals" correctly upgrades draft → confirmed. (3) Preview / result UI now shows per-row action badge: <b>NEW draft / NEW confirmed / UPDATE→confirmed / SKIP</b>, with summary counts for inserts / updates / preserved.
    </div>
    <div class="pl-cl-v old">V1.0.01</div>
    <div class="pl-cl-txt">
      修兩件 LogTen import 安全網漏洞 + 加 Preview 預覽：(1) 嚴格 Date 驗證：Tab 檔任一筆 Date 欄位不符合 <code>YYYY-MM-DD</code> 格式（例如手動編輯誤打成 <code>22026-04-21</code>），整批 reject 並列出哪幾 row 壞掉，不再默默存爛資料進去。(2) Editor <code>flight_date</code> 顯示修正：欄位改用 <code>date</code> type，無論 server 回純字串、ISO 字串還是 PG TIMESTAMPTZ 6 位年份序列化都正常還原前 10 字。(3) Dry-run mode：Import 介面多一顆 🔍 <b>Preview</b> 按鈕（<code>?dryRun=1</code>），預覽會匯入哪些 row（前 10 筆顯示 date / flight# / from→to / block / out / pic）但不真寫 DB；確認 OK 再按 Import 真的寫入。<br>
      Two LogTen import safety-net fixes + Preview added: (1) Strict Date validation: any row with Date not matching <code>YYYY-MM-DD</code> (e.g., manual-edit typo like <code>22026-04-21</code>) rejects the whole batch and lists offending rows, instead of silently storing corrupted data. (2) Editor <code>flight_date</code> display fix: field now uses <code>date</code> type, correctly recovering YYYY-MM-DD from plain string, ISO string, or PG TIMESTAMPTZ 6-digit-year serialization. (3) Dry-run mode: Import UI now has a 🔍 <b>Preview</b> button (<code>?dryRun=1</code>) that previews which rows would be imported (first 10 with date / flight# / from→to / block / out / pic) without writing to DB. Click Import after confirming.
    </div>
    <div class="pl-cl-v old">V1.0.00</div>
    <div class="pl-cl-txt">
      首次發佈，獨立子系統。Google 帳號登入（access JWT 1h + refresh 90d auto-rotation），用 email 認身分，換公司可繼續用同一本 logbook。LogTen Pro 6 Tab 動態匯出（飛行記錄）+ Aircraft Tab 匯出（機尾庫）匯入；UTF-8 only、header 缺必填欄位整批 reject。手動新增 / 編輯 entry：OOOI 4 段時間、起降統計（日/夜/autoland）、機組名單、Approach、SID/STAR、Pax、Remarks。三態管理 draft / confirmed / roster_removed。Stats: total/PIC/SIC/Night + 7/28/90 day rolling + 機型分組。獨立路由 <code>/pilot-log</code>、獨立 API <code>/api/pilot-log/*</code>、獨立 smoke test <code>npm run test:pl</code>，目前不在主 tab bar，需直接 URL 進入；之後核心 flow 測穩才整合，<code>/pilot-log</code> 永久保留作深連結 / debug。<br>
      v1 standalone subsystem launch. Google sign-in (access JWT 1h + refresh 90d auto-rotation); email-keyed identity so users keep their logbook when switching employers. LogTen Pro 6 dynamic Tab export (flights) + Aircraft Tab export (tail registry) import; UTF-8 only, missing required headers reject the whole batch. Manual entry create/edit: OOOI 4-segment times, takeoff/landing counters (day/night/autoland), crew names, approaches, SID/STAR, pax, remarks. Three-state lifecycle: draft / confirmed / roster_removed. Stats: total/PIC/SIC/Night + 7/28/90 day rolling + grouped by aircraft type. Independent route <code>/pilot-log</code>, independent API <code>/api/pilot-log/*</code>, independent smoke test <code>npm run test:pl</code>; not yet exposed in main tab bar — direct URL only for now. Integration into the bar will follow once core flow is proven; <code>/pilot-log</code> stays permanent for deep-link / debug.
    </div>
  `;
}

pilotLogRouter.get('/pilot-log', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
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
  const u = await pool.query('SELECT id, created_at, last_login_at, crew_labels FROM pilot_users WHERE id = $1', [userId]);
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
  res.json({ user: u.rows[0], emails: emails.rows, crew_labels: u.rows[0].crew_labels || null, isFounder });
});

// V1.3.12：crew 欄位顯示名稱自訂（CIC=JX、EVA=CP…）。只收 6 個白名單 key、每個 ≤ 24 字。
pilotLogRouter.post('/api/pilot-log/crew-labels', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  let body: any;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const allow = ['pic', 'crew2', 'crew3', 'crew4', 'cic', 'obs'];
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
  'is_locked',                                     // V1.3.08：上鎖（LogTen 風格防誤改；鎖了不能編輯/刪除）
  'on_duty_utc', 'off_duty_utc', 'total_duty_minutes',
  'crew', 'approaches',
  'day_takeoffs', 'night_takeoffs', 'day_landings', 'night_landings', 'autolands',
  'pax_count', 'crew_count',                        // V1.3.36：crew_count（POB = crew_count + pax_count）
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
  res.json({ entry: r.rows[0] });
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
       WHERE user_id = $1 AND status = 'draft' AND flight_date < CURRENT_DATE RETURNING id`,
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
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text) return res.status(400).json({ error: 'empty_body' });
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const r = await importLogatp(req.pilotUserId!, text, { dryRun });
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
  try {
    const r = await importRoster(req.pilotUserId!, duties, dateRange, months);
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
    const r = await importRoster(userId, allDuties, undefined, selMonths);
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
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  const r = await pool.query(
    `SELECT c.id, c.display_name, c.organization, c.comment, c.is_self,
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

    await client.query(
      `UPDATE crew SET display_name = $1, organization = $2, comment = $3, updated_at = NOW()
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
    res.json({
      pilot: { count: pilot.rows.length, users: pilot.rows },
      crewsync: { count: cs.rows.length, sharing: sharingCount, users: cs.rows },
      morning: { count: mr.rows.length, users: mr.rows },
      groups: { count: groups.rows.length, list: groups.rows },
      // 整庫 / pilot-log / 餐廳+其他 大小快照（最新 + 最近 30 筆，前端算成長速度、推估到 1GB）
      db: { latest: dbsize.rows[0] || null, history: dbsize.rows },
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
    try{var ra=await api('/api/atis-usage');if(ra.ok)T.atis=await ra.json();}catch(e){}
    el('me').textContent='owner';el('reBtn').style.display='';el('outBtn').style.display='';el('foot').style.display='';el('msg').textContent='';
    render();
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
    (T.atis?'<div class=card><div class=lbl>ATIS 額度 · airframes</div>'+(T.atis.known?'<div class=big>'+T.atis.used+'<span style="font-size:.5em;color:#64748b"> / '+T.atis.limit+'</span></div><div class=seg><span class=gray>剩 <b>'+T.atis.remaining+'</b></span><span class=blue>founder 上限 <b>'+T.atis.founderCap+'</b></span></div>':'<div class=big>—</div><div class=sub>等有人用過才顯示(不主動抓、省額度)</div>')+'<div class=sub style="margin-top:5px">今日 <b style="color:#e2e8f0">'+(T.atis.todayUsers||0)+'</b> 人用 · 詳見 📻 ATIS 分頁</div></div>':'')+
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
    '<div class="tab'+(T.tab===5?' on':'')+'" onclick="setTab(5)">📻 ATIS</div>'+
  '</div>';
  if(T.tab<3){h+='<div class=ctrl><input placeholder="🔍 搜尋…" value="'+esc(T.q)+'" oninput="T.q=this.value;render()"></div>';}
  if(T.tab===0)h+=secCrew(c);else if(T.tab===1)h+=secPilot(p,c);else if(T.tab===2)h+=secMorning(m);else if(T.tab===3)h+=secGroups(gp);else if(T.tab===4)h+=secDb();else h+=secAtis();
  el('app').style.display='';el('app').innerHTML=h;
}
function secAtis(){
  var a=T.atis;
  if(!a){return '<div class="sec on"><div class=sechdr><h2>📻 ATIS · airframes</h2></div><div class=row>無資料（owner 才看得到）</div></div>';}
  var h='<div class="sec on"><div class=sechdr><h2>📻 ATIS · airframes 額度</h2><span class=cnt>每天 UTC 00:00 重置（台灣早上 08:00）</span></div>';
  h+='<div class=row><div class=stats>';
  if(a.known){h+='<span>今日已用 <b>'+a.used+'</b> / '+a.limit+'</span><span>剩 <b>'+a.remaining+'</b></span><span>founder 上限 <b>'+a.founderCap+'</b></span><span>你 owner 可用滿 <b>'+a.limit+'</b></span>';}
  else{h+='<span>今日已用 <b>—</b>（不主動抓、省額度 → 等有人真的用過 ATIS 才顯示）</span>';}
  h+='</div><div class=t>快取機場 '+(a.cachedAirports||0)+' · 數字來自 airframes，重啟不歸零</div></div>';
  // helper：把 [{who,icao,n}] 依 who 分組;把機場清單轉字串
  function grp(rows,k){var m={};(rows||[]).forEach(function(r){(m[r.who]=m[r.who]||[]).push({icao:r.icao,n:r[k]});});return m;}
  function aptStr(list){return (list||[]).map(function(x){return '<span><b>'+esc(x.icao||'?')+'</b> '+x.n+'</span>';}).join('');}
  var hist=a.history||{};
  // 今日誰用(誰查了哪些機場)
  var todayG=grp(a.who,'count'),todayKeys=Object.keys(todayG);
  h+='<div class=sechdr style="margin-top:14px"><h2 style="font-size:.95em">今日誰用 · 查了哪些機場</h2><span class=cnt>'+(a.todayUsers||0)+' 人</span></div>';
  if(todayKeys.length){todayKeys.forEach(function(who){var s=todayG[who].reduce(function(t,x){return t+x.n;},0);h+='<div class=row><div class=r1><span class=id>'+esc(who)+'</span><span class=badge style="background:#0a0e1a;color:#fcd34d;border:1px solid #92590e">共 '+s+'</span></div><div class=src style="flex-wrap:wrap">'+aptStr(todayG[who])+'</div></div>';});}else{h+='<div class=row>今日尚無人觸發 airframes</div>';}
  // 累計誰用最多(+各自查的機場)
  var uaG=grp(hist.byUserAirport,'total');
  h+='<div class=sechdr style="margin-top:14px"><h2 style="font-size:.95em">累計 · 誰用最多（全部歷史）</h2><span class=cnt>'+((hist.byUser&&hist.byUser.length)||0)+' 人</span></div>';
  if(hist.byUser&&hist.byUser.length){hist.byUser.forEach(function(w){h+='<div class=row><div class=r1><span class=id>'+esc(w.who)+'</span><span class=badge style="background:#0a0e1a;color:#fcd34d;border:1px solid #92590e">'+w.total+' 次</span></div><div class=src style="flex-wrap:wrap">'+aptStr(uaG[w.who])+'</div>'+(w.last?'<div class=t>最後 '+fmtDt(w.last)+'</div>':'')+'</div>';});}else{h+='<div class=row>尚無紀錄</div>';}
  // 各機場被查熱度
  h+='<div class=sechdr style="margin-top:14px"><h2 style="font-size:.95em">各機場被查次數（全部歷史）</h2></div>';
  if(hist.byAirport&&hist.byAirport.length){h+='<div class=row><div class=src style="flex-wrap:wrap">'+hist.byAirport.map(function(x){return '<span><b>'+esc(x.icao||'?')+'</b> '+x.total+'</span>';}).join('')+'</div></div>';}else{h+='<div class=row>尚無紀錄</div>';}
  // 每日用量
  h+='<div class=sechdr style="margin-top:14px"><h2 style="font-size:.95em">每日用量</h2></div>';
  if(hist.byDay&&hist.byDay.length){hist.byDay.forEach(function(dd){h+='<div class=row><div class=r1><span class=id>'+esc(dd.day)+'</span><span class=badge style="background:#0a0e1a;color:#93c5fd;border:1px solid #1e3a5f">'+dd.total+' 次</span><span class=name>'+dd.users+' 人</span></div></div>';});}else{h+='<div class=row>尚無紀錄</div>';}
  return h+'</div>';
}
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
