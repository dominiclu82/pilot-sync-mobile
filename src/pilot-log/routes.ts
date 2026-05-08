// Pilot Log v1 — REST API
// 路由前綴: /api/pilot-log
//
// Public:
//   POST   /api/pilot-log/auth/login          { idToken }   → { accessToken, refreshToken, ... }
//   POST   /api/pilot-log/auth/refresh        { refreshToken } → 同上 (rotated)
//   POST   /api/pilot-log/auth/logout         { refreshToken }
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
//   POST   /api/pilot-log/import/logten-aircraft     (text/plain body)
//   GET    /api/pilot-log/aircraft
//   GET    /api/pilot-log/stats
//   GET    /api/pilot-log/quick-suggest        (常用 tail/type/airport/crew)

import express from 'express';
import { randomUUID } from 'crypto';
import {
  loginWithGoogle,
  rotateRefreshToken,
  revokeRefreshToken,
  requireAuth,
  AuthedRequest,
} from './auth.js';
import { getPool, ensureTables } from './schema.js';
import { importLogtenFlights, importLogtenAircraft } from './import-logten.js';
import { getTotals, getRollingTotals, getByAircraftType } from './stats.js';
import { loadCredentials } from '../config.js';
import { getSpaPilotLogJs } from '../spa/js-pilot-log.js';

// ── 版本（比照 CrewSync / Morning：每次推版必更新；SW cache 名稱跟著走） ────
export const PILOT_LOG_VERSION = 'V1.0.08';
const PILOT_LOG_CACHE = 'pilotlog-v1-0-08';

export const pilotLogRouter = express.Router();

// 接受最多 5MB 的純文字（LogTen 匯出檔，幾年的資料夠用）
pilotLogRouter.use('/api/pilot-log/import', express.text({ type: '*/*', limit: '5mb' }));

// ── Standalone page (/pilot-log) ─────────────────────────────────────────────
// 初期獨立於 main SPA，等核心 flow 都測穩再決定要不要整合到 tab bar。
// 永久保留此路由：深連結 / debug / 獨立測試用。
function _renderPilotLogHtml(): string {
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
:root {
  --bg: #0a0e1a;
  --card: #1a1f2e;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --border: #334155;
  --accent: #3b82f6;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 15px;
  min-height: 100vh;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  overflow-x: hidden;            /* 擋橫滑（同 CrewSync / Morning 修法） */
  overscroll-behavior: none;
}
header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: rgba(0,0,0,.2);
  position: sticky; top: 0; z-index: 10;
}
header .h-icon { font-size: 1.4em; }
header .h-title { font-weight: 700; font-size: 1.05em; flex: 1; }
header .h-ver {
  font-size: .65em; color: var(--muted);
  background: rgba(255,255,255,.05);
  padding: 3px 8px; border-radius: 6px;
  cursor: pointer; user-select: none;
}
header .h-ver:active { background: rgba(255,255,255,.1); }

/* About modal — 比照 Morning，加 overflow-x:hidden + overflow-wrap:break-word */
.pl-modal-wrap {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,.7); z-index: 100;
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
</style>
</head>
<body>
<header>
  <span class="h-icon">📒</span>
  <span class="h-title">Pilot Log</span>
  <span class="h-ver" onclick="plShowAbout()">${PILOT_LOG_VERSION}</span>
</header>
<main>
  <div id="pilotlog-content"></div>
</main>

<!-- About modal — 點 header 版號開啟 -->
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
    <div class="pl-cl-v">${PILOT_LOG_VERSION}</div>
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
  if (!u.pathname.startsWith('/pilot-log') && !u.pathname.startsWith('/api/pilot-log')) return;
  // API 走網路優先（auth + 動態資料絕不能從 cache 拿）
  if (u.pathname.startsWith('/api/pilot-log')) {
    e.respondWith(fetch(e.request));
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
pilotLogRouter.post('/api/pilot-log/auth/login', async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'missing_id_token' });
  }
  const ua = req.headers['user-agent'] || undefined;
  const session = await loginWithGoogle(idToken, ua);
  if (!session) return res.status(401).json({ error: 'login_failed' });
  res.json(session);
});

pilotLogRouter.post('/api/pilot-log/auth/refresh', async (req, res) => {
  const rt = req.body?.refreshToken;
  if (!rt || typeof rt !== 'string') return res.status(400).json({ error: 'missing_refresh_token' });
  const ua = req.headers['user-agent'] || undefined;
  const session = await rotateRefreshToken(rt, ua);
  if (!session) return res.status(401).json({ error: 'invalid_refresh_token' });
  res.json(session);
});

pilotLogRouter.post('/api/pilot-log/auth/logout', async (req, res) => {
  const rt = req.body?.refreshToken;
  if (rt && typeof rt === 'string') await revokeRefreshToken(rt);
  res.json({ ok: true });
});

// ── Me ───────────────────────────────────────────────────────────────────────
pilotLogRouter.get('/api/pilot-log/me', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return res.status(503).json({ error: 'database_unavailable' });
  const userId = req.pilotUserId!;
  const u = await pool.query('SELECT id, created_at, last_login_at FROM pilot_users WHERE id = $1', [userId]);
  const emails = await pool.query(
    'SELECT email, is_primary FROM pilot_user_emails WHERE user_id = $1 ORDER BY is_primary DESC, linked_at',
    [userId]
  );
  if (u.rows.length === 0) return res.status(404).json({ error: 'user_not_found' });
  res.json({ user: u.rows[0], emails: emails.rows });
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
  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 1000);
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
  params.push(limit, offset);

  const r = await pool.query(
    `SELECT * FROM pilot_log_entries WHERE ${conds.join(' AND ')}
     ORDER BY flight_date DESC, std_utc DESC NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
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
  'on_duty_utc', 'off_duty_utc', 'total_duty_minutes',
  'crew', 'approaches',
  'day_takeoffs', 'night_takeoffs', 'day_landings', 'night_landings', 'autolands',
  'pax_count', 'sid', 'star', 'remarks',
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

  const r = await pool.query(
    `INSERT INTO pilot_log_entries (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`,
    vals
  );
  res.json({ entry: r.rows[0] });
});

// ── Entries: update ──────────────────────────────────────────────────────────
pilotLogRouter.put('/api/pilot-log/entries/:id', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });

  const body = req.body || {};
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

  const r = await pool.query(
    `UPDATE pilot_log_entries SET ${sets.join(', ')} WHERE id = $${p} AND user_id = $${p + 1} RETURNING *`,
    vals
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ entry: r.rows[0] });
});

// ── Entries: delete ──────────────────────────────────────────────────────────
pilotLogRouter.delete('/api/pilot-log/entries/:id', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });
  const r = await pool.query(
    'DELETE FROM pilot_log_entries WHERE id = $1 AND user_id = $2',
    [req.params.id, req.pilotUserId]
  );
  res.json({ deleted: r.rowCount });
});

// ── Entries: bulk delete by source (escape hatch；目前只開 source=logten） ────
// DELETE /api/pilot-log/entries?source=logten&confirm=true
//   - auth 必須登入（自動 scope 到當前 user）
//   - source 第一版只接受 'logten'（不開 'all' / 'manual' / 'roster'）
//   - confirm 必須是 'true'，少傳就 reject
//   - 不影響 pilot_aircraft 機尾庫
pilotLogRouter.delete('/api/pilot-log/entries', requireAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'database_unavailable' });

  const source = String(req.query.source || '');
  const confirm = String(req.query.confirm || '');

  if (source !== 'logten') {
    return res.status(400).json({ error: 'invalid_source', allowed: ['logten'] });
  }
  if (confirm !== 'true') {
    return res.status(400).json({ error: 'missing_confirm_true' });
  }

  const r = await pool.query(
    `DELETE FROM pilot_log_entries WHERE user_id = $1 AND source = $2`,
    [req.pilotUserId, source]
  );
  res.json({ deleted: r.rowCount, source });
});

// ── Imports ──────────────────────────────────────────────────────────────────
pilotLogRouter.post('/api/pilot-log/import/logten-flights', requireAuth, async (req: AuthedRequest, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text) return res.status(400).json({ error: 'empty_body' });
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const r = await importLogtenFlights(req.pilotUserId!, text, { dryRun });
  res.json(r);
});

pilotLogRouter.post('/api/pilot-log/import/logten-aircraft', requireAuth, async (req: AuthedRequest, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text) return res.status(400).json({ error: 'empty_body' });
  const r = await importLogtenAircraft(req.pilotUserId!, text);
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

// ── Stats ────────────────────────────────────────────────────────────────────
pilotLogRouter.get('/api/pilot-log/stats', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.pilotUserId!;
  const [totals, rolling, byType] = await Promise.all([
    getTotals(userId),
    getRollingTotals(userId),
    getByAircraftType(userId),
  ]);
  res.json({ totals, rolling, by_type: byType });
});

// ── Admin stats（V1.0.05；server-side admin secret，60s cache） ──────────────
// GET /api/pilot-log/admin/stats?pw=<env PILOT_LOG_ADMIN_PW>&limit=10
// 不掛 requireAuth：這是 ops 監控 endpoint，不走 user JWT。
// 認證走 timing-safe compare，避免泄漏密碼長度資訊。
const PL_STATS_TTL_MS = 60 * 1000;
let _plStatsCache: { at: number; data: any } | null = null;

import { timingSafeEqual as _tse, createHash as _ch } from 'crypto';
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

pilotLogRouter.get('/api/pilot-log/admin/stats', async (req, res) => {
  const pw = String(req.query.pw || '');
  if (!_plAdminPwMatch(pw)) return res.status(403).json({ error: 'forbidden' });

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

    // ── Tables 區（三個 size 都回） ────
    const tableNames = ['pilot_users', 'pilot_user_emails', 'pilot_user_sessions', 'pilot_log_entries', 'pilot_aircraft'];
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

    // ── Top users by entry count（永遠抓 max 50 進 cache，response 再 slice）────
    const topUsers = await pool.query(`
      SELECT
        u.id                                                                          AS user_id,
        (SELECT email FROM pilot_user_emails WHERE user_id = u.id ORDER BY is_primary DESC, linked_at LIMIT 1) AS primary_email,
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
        total_pilot_log_size_bytes: totalSize,
        total_pilot_log_size_mb: Math.round(totalSize / 1024 / 1024 * 10) / 10,
      },
      breakdown: {
        tables,
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
