// Portfolio module — frontend PWA shell (Phase 1.D)
//
// 一個獨立的 portfolio 子系統前端，掛在 /portfolio。
// 沿用晨報 localStorage key 'morning_uid' 作 user identity (同 origin 自動共用)。
// PIN opt-in：sessionStorage 存解鎖 PIN，tab 關了要重輸入。
//
// 主要 view:
//   1. PIN unlock overlay — 啟用 PIN 後第一次 access 跳出
//   2. main page — 持倉列表 + 即時股價 + 視角 1 摘要
//   3. detail page — 單一 symbol 三視角 + 交易紀錄
//   4. add transaction modal — buy/sell 表單
//   5. settings modal — PIN 啟用 / 改 / 取消

import { APP_VERSION } from '../version.js';
import { renderAppChangelog } from '../app-changelog.js';

export function getPortfolioHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0f">
<title>投資組合</title>
<style>${getStyles()}</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
</head>
<body>
  <div id="app">
    <!-- 主畫面 -->
    <div id="page-main" class="page">
      <!-- V1.0.18: top-stack sticky (hdr + sec-nav 整組黏頂，完全對齊晨報 layout) -->
      <div class="top-stack" id="top-stack">
        <div class="hdr">
          <div style="min-width:0;flex:1">
            <div class="hdr-title">
              <span class="emoji">📈</span><span class="hdr-user" id="hdr-user" onclick="changeUid()">—</span>
              <!-- 版號已移到底部設定區（右下角，三個 app 一致） -->
            </div>
            <div class="hdr-date" id="hdr-date">—</div>
          </div>
          <div class="hdr-actions-top">
            <button class="hdr-btn" onclick="openSettings()" title="設定 (PIN / 帳號)">⚙</button>
            <button class="hdr-btn" id="btn-refresh" onclick="manualRefresh()" title="重新整理">↻</button>
          </div>
        </div>
        <nav id="portfolio-section-nav" class="sec-nav" hidden>
          <button class="nav-btn" data-target="sec-tw">📈 台股</button>
          <button class="nav-btn" data-target="sec-us">🇺🇸 美股</button>
          <button class="nav-btn" data-target="chart-card">📊 資產變化</button>
        </nav>
      </div>
      <div class="hdr-actions">
        <button class="btn btn-primary" onclick="openAddModal()">+ 加交易</button>
      </div>
      <div id="main-status" class="status"></div>
      <!-- V1.0.16: 投資組合總覽 — 拆 TW / US + 合計 -->
      <div id="portfolio-overall" class="overall-card" hidden>
        <div class="ov-grid">
          <div class="ov-cell" id="ov-cell-tw" hidden>
            <div class="ov-cell-label">📈 台股</div>
            <div class="ov-cell-value" id="ov-tw-value">—</div>
            <div class="ov-cell-pnl" id="ov-tw-pnl">—</div>
          </div>
          <div class="ov-cell" id="ov-cell-us" hidden>
            <div class="ov-cell-label">🇺🇸 美股</div>
            <div class="ov-cell-value" id="ov-us-value">—</div>
            <div class="ov-cell-twd" id="ov-us-value-twd"></div>
            <div class="ov-cell-pnl" id="ov-us-pnl">—</div>
            <div class="ov-cell-twd" id="ov-us-pnl-twd"></div>
          </div>
        </div>
        <div class="ov-total">
          <div class="ov-row">
            <span class="ov-label">合計總資產</span>
            <span class="ov-value" id="ov-total-value">—</span>
          </div>
          <div class="ov-row">
            <span class="ov-label">合計未實現損益</span>
            <span class="ov-value" id="ov-pnl">—</span>
          </div>
          <div class="ov-fx-note" id="ov-fx-note"></div>
        </div>
      </div>
      <div id="holdings-list" class="list"></div>
      <!-- 資產變化圖 -->
      <div id="chart-card" class="card" style="margin-top:16px" hidden>
        <div class="card-hdr">
          <span>📊 資產變化</span>
          <span style="display:flex;gap:4px;flex-shrink:0">
            <button class="period-btn active" data-period="daily" onclick="setPeriod('daily')">日</button>
            <button class="period-btn" data-period="monthly" onclick="setPeriod('monthly')">月</button>
            <button class="period-btn" data-period="yearly" onclick="setPeriod('yearly')">年</button>
          </span>
        </div>
        <div class="card-body">
          <div style="display:flex;gap:6px;justify-content:space-between;margin-bottom:8px;align-items:center;flex-wrap:wrap">
            <span id="range-buttons" style="display:flex;gap:4px"></span>
            <button class="period-btn" onclick="backfillChart()" title="從 Yahoo Finance 拉歷史" id="btn-backfill">📥 補歷史</button>
          </div>
          <canvas id="asset-chart" style="max-height:220px"></canvas>
          <div id="chart-note" class="muted muted-small" style="text-align:center;margin-top:6px" hidden></div>
        </div>
      </div>
      <div class="footer">
        <span class="muted">資料源：cnyes</span>
      </div>
    </div>

    <!-- 個股 detail 頁 -->
    <div id="page-detail" class="page" hidden>
      <div class="hdr">
        <div class="hdr-back" onclick="goMain()">←</div>
        <div class="hdr-title" id="detail-title">—</div>
        <div class="hdr-user" id="detail-user">—</div>
      </div>
      <div id="detail-overall" class="card"></div>
      <div id="detail-txns" class="card"></div>
      <div id="detail-lots" class="card collapsible">
        <div class="card-hdr" onclick="toggleLots()">
          <span>▶ Lot 詳細（FIFO）</span>
          <span class="muted muted-small">power user view</span>
        </div>
        <div id="lots-body" class="card-body" hidden></div>
      </div>
    </div>

    <!-- 加交易 modal -->
    <div id="modal-add" class="modal" hidden>
      <div class="modal-card">
        <div class="modal-hdr">
          <span id="modal-title">加交易</span>
          <span class="modal-close" onclick="closeAddModal()">✕</span>
        </div>
        <div class="modal-body">
          <div class="seg">
            <button class="seg-btn active" id="seg-buy" onclick="setSide('buy')">買入</button>
            <button class="seg-btn" id="seg-sell" onclick="setSide('sell')">賣出</button>
          </div>
          <label>市場
            <select id="f-market" onchange="updateFeePreview()">
              <option value="TW">台股 TW</option>
              <option value="US">美股 US</option>
            </select>
          </label>
          <label>代號 <input id="f-symbol" type="text" placeholder="2330 / AAPL" autocomplete="off"></label>
          <label>日期 <input id="f-date" type="date"></label>
          <label>股數 <input id="f-qty" type="number" step="0.0001" min="0.0001" inputmode="decimal" oninput="_txInput('qty')"></label>
          <label>價格 <input id="f-price" type="number" step="0.0001" min="0" inputmode="decimal" oninput="_txInput('price')"></label>
          <label>總額（股數×價格，不含手續費；填任兩格自動算第三）<input id="f-total" type="number" step="0.0001" min="0" inputmode="decimal" oninput="_txInput('total')"></label>
          <label>手續費（空白 = 自動算 / 賣方含證交稅）<input id="f-fee" type="number" step="1" min="0" inputmode="decimal" placeholder="auto"></label>
          <label>備註（可選）<input id="f-note" type="text" maxlength="100"></label>
          <div id="fee-preview" class="muted muted-small" style="text-align:right;font-size:.82em" hidden></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="closeAddModal()">取消</button>
            <button class="btn btn-primary" onclick="submitAdd()">儲存</button>
          </div>
          <div id="modal-error" class="error" hidden></div>
        </div>
      </div>
    </div>

    <!-- PIN unlock overlay (啟用 PIN 後第一次 access) -->
    <div id="modal-pin-unlock" class="modal" hidden>
      <div class="modal-card">
        <div class="modal-hdr"><span>🔒 解鎖投資組合</span></div>
        <div class="modal-body">
          <div class="muted muted-small">這個帳號啟用了 PIN 保護。輸入 PIN 進入：</div>
          <input id="pin-unlock-input" type="password" maxlength="72" placeholder="輸入 PIN" autocomplete="off">
          <div id="pin-unlock-error" class="error" hidden></div>
          <button class="btn btn-primary" onclick="submitPinUnlock()">解鎖</button>
          <div class="muted muted-small">忘記 PIN？請聯絡 admin 後台 reset。</div>
        </div>
      </div>
    </div>

    <!-- Settings modal -->
    <div id="modal-settings" class="modal" hidden>
      <div class="modal-card">
        <div class="modal-hdr">
          <span>⚙ 設定</span>
          <span class="modal-close" onclick="closeSettings()">✕</span>
        </div>
        <div class="modal-body">
          <div class="kv">
            <span class="k">PIN 保護</span>
            <span class="v" id="settings-pin-status">—</span>
          </div>
          <div id="settings-pin-actions" class="modal-actions" style="flex-direction:column;align-items:stretch"></div>
          <div id="settings-error" class="error" hidden></div>
        </div>
      </div>
    </div>

    <!-- About modal (版次 + 歷史更新) -->
    <div id="modal-about" class="modal" hidden>
      <div class="modal-card">
        <div class="modal-hdr">
          <span>📈 投資組合 <span class="muted muted-small" id="about-version">V1.0.0</span></span>
          <span class="modal-close" onclick="closeAbout()">✕</span>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow-y:auto">
          <div class="muted muted-small">獨立投資組合子系統 — 多筆買賣帳本、自動算均價、三視角持倉分析、opt-in PIN 保護</div>
          ${renderAppChangelog()}
        </div>
      </div>
    </div>

    <!-- PIN setup / change / unset modal -->
    <div id="modal-dividend-detail" class="modal" hidden>
      <div class="modal-card" style="max-width:560px">
        <div class="modal-hdr">
          <span id="dd-title">除權息資料</span>
          <span class="modal-close" onclick="closeDividendDetail()">✕</span>
        </div>
        <div class="modal-body">
          <div id="dd-summary" class="muted muted-small" style="margin-bottom:10px"></div>
          <div id="dd-list" style="max-height:55vh;overflow-y:auto"></div>
          <div class="muted muted-small" style="margin-top:10px;font-size:.75em">
            來源 — 台股: Yahoo Finance 歷史 + TWSE 預告／美股: Yahoo Finance 歷史 + Nasdaq 預告
          </div>
        </div>
      </div>
    </div>

    <div id="modal-pin-form" class="modal" hidden>
      <div class="modal-card">
        <div class="modal-hdr">
          <span id="pin-form-title">設定 PIN</span>
          <span class="modal-close" onclick="closePinForm()">✕</span>
        </div>
        <div class="modal-body">
          <div id="pin-form-old-wrap" hidden>
            <label>當前 PIN
              <input id="pin-form-old" type="password" maxlength="72" autocomplete="off">
            </label>
          </div>
          <div id="pin-form-new-wrap">
            <label>新 PIN（任意長度 / 字元）
              <input id="pin-form-new1" type="password" maxlength="72" autocomplete="off">
            </label>
            <label>再輸入一次
              <input id="pin-form-new2" type="password" maxlength="72" autocomplete="off">
            </label>
          </div>
          <div id="pin-form-error" class="error" hidden></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="closePinForm()">取消</button>
            <button class="btn btn-primary" id="pin-form-submit" onclick="submitPinForm()">確認</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom fixed navbar: tabs (左) + function keys (右) -->
    <nav class="tab-nav">
      <div class="tab-links">
        <a href="/morning">📰 今日</a>
        <a href="/portfolio" class="active">📈 投資組合</a>
      </div>
      <div class="tab-controls">
        <a href="/apps" id="cs-apps-home" aria-label="Tools" title="回 Tools" style="display:none;align-items:center;justify-content:center;text-decoration:none;padding:0 4px"><svg width="20" height="20" viewBox="0 0 24 24"><rect x="2" y="2" width="9" height="9" rx="2.5" fill="#3b82f6"/><rect x="13" y="2" width="9" height="9" rx="2.5" fill="#10b981"/><rect x="2" y="13" width="9" height="9" rx="2.5" fill="#f59e0b"/><rect x="13" y="13" width="9" height="9" rx="2.5" fill="#a855f7"/></svg></a>
        <button class="hdr-btn" id="btn-theme" onclick="toggleTheme()" title="日/夜">☀️</button>
        <div class="hdr-btn-font" title="字型大小">
          <button onclick="bumpFont(1)">A+</button>
          <button onclick="bumpFont(-1)">A−</button>
        </div>
        <span onclick="openAbout()" style="cursor:pointer;font-size:.62em;color:var(--muted);text-decoration:underline;text-underline-offset:2px;white-space:nowrap">${APP_VERSION}</span>
      </div>
    </nav>
    <!-- ⊞ 回 Tools：只在「從 /apps 入口進來 + 裝成 PWA」時顯示 -->
    <script>(function(){try{var s=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone;if(s&&localStorage.getItem('cs_via_apps')==='1'){var b=document.getElementById('cs-apps-home');if(b)b.style.display='inline-flex';}}catch(e){}})();</script>
  </div>
<script>${getClientJs()}</script>
</body>
</html>`;
}

function getStyles(): string {
  return `
:root {
  /* V1.0.18: 全部 vars 精確對齊晨報 (除 --accent 用藍取代黃 — user 同意 Portfolio 藍色 theme)
     切換 PWA 時 border / nav-bg / muted 視覺微差累積成「跳動感」— 此版全 1:1 對齊 */
  --bg: #0B1428;
  --bg-card: #111c36;
  --bg-elev: #1a2540;
  --fg: #e8ecf5;
  --muted: #8a96b0;
  --accent: #5b9eff;     /* 藍 (Portfolio 自身 theme, 對齊晨報 --accent #F4C430 結構性位置) */
  --green: #2ecc71;
  --red: #ff5555;
  --border: rgba(255,255,255,0.08);
  --hdr-grad-1: #1E2740;
  --hdr-grad-2: #141c33;
  --nav-bg: rgba(15,22,45,0.92);
}
[data-theme="light"] {
  --bg: #f5f7fa;
  --bg-card: #ffffff;
  --bg-elev: #f0f3f8;
  --fg: #1a2540;
  --muted: #6b7a8f;
  --accent: #2563eb;
  --green: #00a65e;
  --red: #d63031;
  --border: rgba(0,0,0,0.1);
  --hdr-grad-1: #ffe9c9;
  --hdr-grad-2: #ffd59e;
  --nav-bg: rgba(255,255,255,0.92);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }  /* hotfix: 強制 hidden 屬性 override 任何 author CSS display */

/* V1.0.14: Bottom fixed tab navbar + function keys (跟 CrewSync 同 pattern) */
.tab-nav {
  position: fixed; bottom: 0; left: 0; right: 0;
  display: flex; align-items: stretch; gap: 8px;
  background: var(--bg-card); border-top: 1px solid var(--border);
  z-index: 30; padding: 0 8px;  /* 低於 modal (z-index 100)，modal 開時 nav 被蓋住 */
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
  color: var(--fg);
  border-top-color: var(--accent);
}
.tab-links a:active { background: var(--bg-elev); }
.tab-controls {
  display: flex; gap: 8px; align-items: center; flex-shrink: 0;
  padding: 6px 4px;
}

/* 禁 iOS 橡皮筋 overscroll (動態島 safe-area 由 top-stack 自己處理) */
body { overscroll-behavior: none; }
html { font-size: 15px; overscroll-behavior: none; }
/* 狀態列那塊鋪不透明底（同 CrewSync）：透明狀態列下捲動內容不透到狀態列區。 */
html::before { content:''; position:fixed; top:0; left:0; right:0; height:env(safe-area-inset-top,0px); background:var(--bg); z-index:9999; pointer-events:none; }
/* V1.0.20: font-family + line-height 1:1 對齊晨報 — 兩邊中文字 fallback (Noto Sans TC vs
   Microsoft JhengHei) 跟 line-height (1.5 vs default 1.2) 差異累積成 baseline/間距感差 */
html, body { margin: 0; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans TC', sans-serif;
  line-height: 1.5;
}
/* V1.0.16 fix: detail page 沒 top-stack，hdr 自己處理 safe-area-top */
#page-detail .hdr { padding-top: calc(env(safe-area-inset-top, 0px) + 6px); }
body { font-size: 1rem; padding-left: 0; padding-right: 0; }
.page {
  width: 100%;
  /* V1.0.18 fix: padding-top: 0 + L/R 12px 對齊晨報 .sec margin (避電腦版寬度差) */
  padding: 0 12px calc(72px + env(safe-area-inset-bottom, 0px));
}
/* V1.0.18: hdr 完全對齊晨報 — gradient bg + safe-area padding 內含 + border-bottom */
.hdr {
  background: linear-gradient(180deg, var(--hdr-grad-1) 0%, var(--hdr-grad-2) 100%);
  padding: calc(env(safe-area-inset-top, 0px) + 10px) 12px 8px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 0;
}
.hdr-title { font-size: 1.15em; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.hdr-title .emoji { font-size: 1.2em; }
.hdr-title .ver {
  font-size: .55em; font-weight: 600; color: var(--accent);
  background: rgba(91,158,255,0.12); border: 1px solid rgba(91,158,255,0.3);
  padding: 2px 7px; border-radius: 8px; cursor: pointer; letter-spacing: .02em;
}
.hdr-title .ver:active { opacity: .7; }
.hdr-date { font-size: .85em; color: var(--muted); font-variant-numeric: tabular-nums; }
.hdr-back { font-size: 1.5em; cursor: pointer; padding: 0 6px; user-select: none; }
/* V1.0.18 fix: hdr-user 繼承 hdr-title 大字 bold (對齊晨報 hdr-user-title)，只留 click affordance */
.hdr-user { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.hdr-btns { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }
/* V1.0.18 fix: 對齊晨報 hdr-btn CSS (bg / 圓角 / 字級) 避切換 PWA 視覺跳動 */
.hdr-btn {
  background: rgba(255,255,255,0.08); border: 1px solid var(--border); color: var(--fg);
  padding: 6px 9px; border-radius: 8px; font-size: .82em; cursor: pointer;
  min-width: 34px; line-height: 1.1;
}
.hdr-btn:active { opacity: 0.7; }
.hdr-btn-font { display: flex; flex-direction: column; gap: 3px; flex-shrink: 0; }
.hdr-btn-font button {
  background: var(--bg-card); border: 1px solid var(--border); color: var(--fg);
  padding: 2px 7px; font-size: .62em; font-weight: 700; line-height: 1.1;
  min-width: 28px; border-radius: 4px; cursor: pointer;
}
.hdr-btn-font button:active { opacity: 0.7; }
/* V1.0.18 fix: 14px top margin 對齊晨報 .sec 第一個 card 跟 top-stack 的 gap */
.hdr-actions { display: flex; gap: 8px; margin: 14px 0 16px; }
.btn { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--fg); font-size: .92em; cursor: pointer; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.btn-ghost { background: transparent; }
.btn-danger { background: var(--red); border-color: var(--red); color: #fff; font-weight: 600; }
.status { color: var(--muted); font-size: .85em; margin-bottom: 10px; min-height: 1.2em; }
.list { display: flex; flex-direction: column; gap: 8px; }

/* V1.0.18: top-stack — 跟晨報 .top-stack 1:1 (sticky / top 0 / z 50)，
   L/R -12px 抵消 .page padding 讓全寬，無 bottom margin (晨報沒有) */
.top-stack {
  position: sticky;
  top: 0;
  z-index: 50;
  margin: 0 -12px;
}
/* V1.0.18: sec-nav 對齊晨報 .nav — blur bg + 灰色預設 + active 藍色 outline
   (對齊晨報 yellow active pattern；ver tag 跟 nav-btn.active 都 var(--accent) 一致) */
.sec-nav {
  background: var(--nav-bg);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
  display: flex; gap: 4px;
  padding: 8px 10px;  /* 對齊晨報 .nav padding */
  overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
.sec-nav::-webkit-scrollbar { display: none; }
.sec-nav .nav-btn {
  flex: 0 0 auto;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 6px 12px; border-radius: 20px;
  font-size: .78em; font-weight: 600;  /* 對齊晨報 .nav-btn 字級 */
  cursor: pointer; white-space: nowrap;
  transition: background .15s, border-color .15s, color .15s;
}
.sec-nav .nav-btn:active { opacity: .6; }
.sec-nav .nav-btn.active {
  background: rgba(91,158,255,0.15);
  border-color: rgba(91,158,255,0.5);
  color: var(--accent);
}
.sec-block { margin-bottom: 16px; scroll-margin-top: var(--sec-nav-h, 60px); }  /* JS 動態設 nav 實際高 */
.sec-title { font-size: 1.05em; font-weight: 700; padding: 8px 4px; color: var(--accent); }
#chart-card { scroll-margin-top: var(--sec-nav-h, 60px); }
.hdr-actions-top { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }

/* V1.0.16: 投資組合總覽 card — TW / US 拆解 + 合計 */
.overall-card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; margin-bottom: 12px;
  display: flex; flex-direction: column; gap: 8px;
}
.overall-card .ov-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.overall-card .ov-cell { background: var(--bg-elev, rgba(255,255,255,.03)); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.overall-card .ov-cell-label { color: var(--muted); font-size: .8em; }
.overall-card .ov-cell-value { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 1em; }
.overall-card .ov-cell-pnl { font-weight: 600; font-variant-numeric: tabular-nums; font-size: .88em; }
.overall-card .ov-cell-twd { font-size: .76em; color: var(--muted); font-variant-numeric: tabular-nums; line-height: 1.3; }
.overall-card .ov-cell-twd:empty { display: none; }
.overall-card .ov-cell-pnl.ov-up { color: #ef4444; }
.overall-card .ov-cell-pnl.ov-down { color: #22c55e; }
.overall-card .ov-total { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; border-top: 1px solid var(--border); }
.overall-card .ov-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.overall-card .ov-label { color: var(--muted); font-size: .88em; }
.overall-card .ov-value { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 1.05em; }
.overall-card .ov-value.ov-up { color: #ef4444; }   /* 台股慣例: 漲紅 */
.overall-card .ov-value.ov-down { color: #22c55e; } /* 跌綠 */
.overall-card .ov-fx-note { color: var(--muted); font-size: .72em; }
.overall-card .ov-fx-note:empty { display: none; }
.holding {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; cursor: pointer;
}
.holding:hover { background: var(--bg-elev); }
.h-row1 { display: flex; align-items: baseline; gap: 10px; }
.h-symbol { font-weight: 700; flex: 1; }
.h-symbol .h-mkt { color: var(--muted); font-size: .8em; margin-right: 4px; }
a.h-symbol-link { color: inherit; text-decoration: none; display: block; min-width: 0; }
a.h-symbol-link:hover, a.h-symbol-link:active { color: var(--accent); text-decoration: underline dotted; }
.h-div { color: var(--muted); font-size: .82em; margin-top: 4px; cursor: pointer; padding: 4px 0; border-radius: 4px; }
.h-div:hover { color: var(--text); }
.h-div .yield { color: var(--accent); font-weight: 600; }
.h-div .upcoming { color: var(--accent); font-weight: 600; }
.h-div .h-div-more { color: var(--muted); margin-left: 4px; }

/* Dividend detail modal table */
.dd-year { margin-bottom: 14px; }
.dd-year-hdr { font-weight: 700; padding: 6px 0; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.dd-row { display: grid; grid-template-columns: 110px 1fr auto; gap: 10px; padding: 4px 4px; font-size: .9em; align-items: center; }
.dd-row:nth-child(even) { background: rgba(255,255,255,.02); }
.dd-date { color: var(--muted); font-variant-numeric: tabular-nums; }
.dd-amt { font-weight: 600; font-variant-numeric: tabular-nums; }
.dd-tag { font-size: .75em; padding: 1px 6px; border-radius: 8px; }
.dd-tag.dd-upcoming { background: rgba(99,102,241,.15); color: var(--accent); }
.h-price { font-weight: 600; }
.h-chg { font-size: .85em; }
.h-row2 { display: flex; gap: 12px; margin-top: 4px; color: var(--muted); font-size: .85em; }
.h-row2 .h-pnl { margin-left: auto; }
.h-add {
  background: var(--bg-elev); border: 1px solid var(--border); color: var(--accent);
  padding: 2px 9px; border-radius: 6px; font-size: 1em; font-weight: 700;
  cursor: pointer; line-height: 1.1; margin-left: 4px; flex-shrink: 0;
}
.h-add:hover, .h-add:active { background: var(--accent); color: #fff; }
.h-del {
  background: var(--bg-elev); border: 1px solid var(--border); color: var(--muted);
  padding: 2px 7px; border-radius: 6px; font-size: .9em;
  cursor: pointer; line-height: 1.1; margin-left: 4px; flex-shrink: 0;
}
.h-del:hover, .h-del:active { background: #dc2626; color: #fff; border-color: #dc2626; }
/* 台灣股市慣例：漲紅 / 跌綠（跟歐美相反） */
.up { color: var(--red); }
.down { color: var(--green); }
.empty { color: var(--muted); text-align: center; padding: 40px 0; }
.footer { text-align: center; color: var(--muted); font-size: .75em; margin-top: 30px; padding-top: 16px; border-top: 1px solid var(--border); display: flex; justify-content: center; align-items: center; gap: 8px; flex-wrap: wrap; }
.footer .ver { cursor: pointer; text-decoration: underline dotted; }
.footer .ver:hover { color: var(--accent); }
.muted { color: var(--muted); }
.muted-small { font-size: .8em; }
.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
.card-hdr { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
.card-hdr > span:first-child { flex: 1; font-weight: 600; }
.card-body { margin-top: 10px; }
.kv { display: flex; justify-content: space-between; padding: 4px 0; font-size: .92em; }
.kv .k { color: var(--muted); }
.kv .v { font-weight: 600; }
.kv .v.up { color: var(--red); }
.kv .v.down { color: var(--green); }
.txn-row { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: .9em; }
.txn-row:last-child { border-bottom: none; }
.txn-row .date { color: var(--muted); min-width: 86px; }
.txn-row .type { min-width: 50px; font-weight: 600; }
/* 台股 convention: buy = 進場加碼 = 紅, sell = 出場 = 綠 */
.txn-row .type.buy { color: var(--red); }
.txn-row .type.sell { color: var(--green); }
.txn-row .type.div { color: var(--accent); }
.txn-row .detail { flex: 1; }
.txn-row .timing { display: block; color: var(--muted); font-size: .82em; margin-top: 2px; }
.txn-row .edit, .txn-row .del { cursor: pointer; padding: 4px 9px; border-radius: 7px; border: 1px solid var(--border); font-size: 1.05em; line-height: 1; }
.txn-row .edit { color: var(--accent); }
.txn-row .del { color: var(--red); }
.txn-row .edit:hover, .txn-row .edit:active { background: var(--accent); color: #fff; border-color: var(--accent); }
.txn-row .del:hover, .txn-row .del:active { background: var(--red); color: #fff; border-color: var(--red); }
.lot { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: .9em; }
.lot:last-child { border-bottom: none; }
.lot .lot-hdr { font-weight: 600; }
.lot .lot-info { color: var(--muted); font-size: .85em; margin-top: 2px; }

/* Chart period switcher */
.period-btn {
  background: var(--bg-elev); border: 1px solid var(--border); color: var(--muted);
  padding: 4px 10px; font-size: .8em; cursor: pointer; border-radius: 4px;
}
.period-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

/* Modal */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
.modal-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; width: 100%; max-width: 420px; max-height: 90vh; overflow-y: auto; }
.modal-hdr { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.modal-hdr span:first-child { flex: 1; font-weight: 700; }
.modal-close { cursor: pointer; color: var(--muted); font-size: 1.2em; padding: 0 6px; }
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.modal-body label { display: flex; flex-direction: column; gap: 4px; font-size: .85em; color: var(--muted); }
.modal-body input, .modal-body select {
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 10px; color: var(--fg); font-size: 1em; font-family: inherit;
}
.seg { display: flex; gap: 0; }
.seg-btn { flex: 1; padding: 8px; background: var(--bg-elev); border: 1px solid var(--border); color: var(--muted); cursor: pointer; }
.seg-btn:first-child { border-radius: 6px 0 0 6px; }
.seg-btn:last-child { border-radius: 0 6px 6px 0; border-left: none; }
.seg-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.error { color: var(--red); font-size: .85em; padding: 8px; background: rgba(248,113,113,.1); border-radius: 6px; }

/* PIN unlock specific */
#modal-pin-unlock .modal-card { max-width: 360px; }
#modal-pin-unlock input { font-size: 1.3em; text-align: center; letter-spacing: 0.3em; }
#pin-form-new1, #pin-form-new2, #pin-form-old { font-size: 1.2em; text-align: center; letter-spacing: 0.25em; }
`;
}

function getClientJs(): string {
  return `
const UID_KEY = 'morning_uid';     // 沿用晨報 user identity
const PIN_SESSION_KEY = 'portfolio_pin';  // sessionStorage，tab 關了要重輸
const API = '/api/portfolio';

let _state = {
  holdings: [],
  quotes: {},
  dividends: {},   // V1.0.13: { 'TW:3231': { events, displayYear, displayRate, dividendYield, nextExDate, lastExDate, currentPrice } }
  side: 'buy',
  pinFormMode: 'set',  // 'set' | 'change' | 'unset'
  pinEnabled: false,
  editingTxnId: null,  // null = 加交易模式；number = 編輯該 id
};

// ── User identity ────────────────────────────────────────────────────────────

function getUid() {
  try { return localStorage.getItem(UID_KEY) || ''; } catch { return ''; }
}
function setUid(uid) {
  try { localStorage.setItem(UID_KEY, uid); } catch {}
  // 切 user 時清掉 PIN session
  try { sessionStorage.removeItem(PIN_SESSION_KEY); } catch {}
  updateUidDisplay();
}
function updateUidDisplay() {
  const uid = getUid();
  const text = uid || '(設定暱稱)';
  document.getElementById('hdr-user').textContent = text;
  const du = document.getElementById('detail-user');
  if (du) du.textContent = text;
}
function changeUid() {
  const cur = getUid();
  const v = prompt('輸入你的暱稱（今日跟投資組合共用）：', cur);
  if (v === null) return;
  const trimmed = v.trim();
  if (!trimmed) return;
  // V1.0.16: stop auto refresh + 清舊 state，避舊 user holdings 被 saveCache 寫進新 uid key
  if (typeof stopAutoRefresh === 'function') stopAutoRefresh();
  _state.holdings = [];
  _state.quotes = {};
  _state.dividends = {};
  setUid(trimmed);
  bootstrap();
}

// ── PIN session ──────────────────────────────────────────────────────────────

function getPin() {
  try { return sessionStorage.getItem(PIN_SESSION_KEY) || ''; } catch { return ''; }
}
function setPin(pin) {
  try { sessionStorage.setItem(PIN_SESSION_KEY, pin); } catch {}
}
function clearPin() {
  try { sessionStorage.removeItem(PIN_SESSION_KEY); } catch {}
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const uid = getUid();
  if (!uid) throw new Error('請先設定暱稱');
  const headers = Object.assign({}, opts.headers || {}, {
    'X-User-Id': encodeURIComponent(uid),
    'Content-Type': 'application/json',
  });
  const pin = getPin();
  if (pin) headers['X-Portfolio-Pin'] = pin;

  // 加逾時：iOS 上 fetch 偶爾會卡住不回（不 resolve 也不 reject）→ 整個儲存無聲無息「按了沒反應」。
  //   15 秒沒回就 abort，轉成可見錯誤，不再靜默卡死。
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 15000);
  let r;
  try {
    r = await fetch(API + path, { ...opts, headers, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('請求逾時（15 秒沒回應）——可能是網路，請重試');
    throw e;
  } finally {
    clearTimeout(tid);
  }
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: 'http_' + r.status }));
    if (e.error === 'pin_required' || e.error === 'invalid_pin') {
      // PIN 過期或錯了，清掉 session、跳 unlock screen
      clearPin();
      showPinUnlock();
      throw new Error(e.error);
    }
    // 把已知錯誤碼翻成看得懂、可行動的中文（原本只丟英文碼，使用者看不懂、又被鍵盤蓋住→以為沒反應）。
    if (e.error === 'sell_exceeds_holding') {
      throw new Error('賣出 ' + e.attempted_sell_qty + ' 股超過該日持股：系統記錄你在 ' + e.as_of_date + ' 只持有 ' + e.current_qty + ' 股。\\n請先記錄「買進」且買進日期早於賣出日，或調整賣出日期／股數。');
    }
    const codeMsg = { invalid_txn_date: '日期格式不對', qty_must_be_positive: '股數要大於 0', invalid_price: '價格不可為負', invalid_fee: '手續費不可為負', invalid_symbol: '股票代號無效', not_found: '找不到這筆交易' };
    throw new Error(codeMsg[e.error] || ('儲存失敗（' + (e.error || ('http_' + r.status)) + '）'));
  }
  return r.json();
}

// ── Bootstrap (load 時的初始化流程) ──────────────────────────────────────────

// V1.0.16: stale-while-revalidate cache — 開啟瞬間 render 上次資料避免跳畫面
// uid-scoped 避免 user A 切去 B 之後瞬間看到 A 的持倉 (codex P1)
const CACHE_KEY = 'portfolio_cache_v1';
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      uid: getUid(),
      holdings: _state.holdings,
      quotes: _state.quotes,
      dividends: _state.dividends,
      at: Date.now(),
    }));
  } catch {}
}
function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.holdings)) return null;
    if (obj.uid !== getUid()) return null;  // uid 不 match → 不 render 別人的 cache
    return obj;
  } catch { return null; }
}
function showCacheImmediate() {
  const cached = loadCache();
  if (!cached || cached.holdings.length === 0) return;
  _state.holdings = cached.holdings;
  _state.quotes = cached.quotes || {};
  _state.dividends = cached.dividends || {};
  renderMain();
  // 不 call renderOverall — 它 await fx 異步; cache renderOverall 可能 resolve 在
  // refreshAll renderOverall 之後 → 用 stale 蓋掉新總覽 (race). refreshAll 完整體 update
  const status = document.getElementById('main-status');
  if (status) {
    const t = new Date(cached.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    status.textContent = '上次更新：' + t + '（更新中…）';
  }
}

async function bootstrap() {
  updateUidDisplay();
  if (!getUid()) {
    document.getElementById('main-status').textContent = '請先點右上角設定暱稱';
    return;
  }
  try {
    const r = await fetch(API + '/pin/status?uid=' + encodeURIComponent(getUid()));
    const j = await r.json();
    _state.pinEnabled = !!j.enabled;
    if (j.enabled && !getPin()) {
      // PIN 保護中：不 render cache 避免外人在 lock-screen 前看到 holdings
      showPinUnlock();
    } else {
      hidePinUnlock();
      // 先 render cache 避跳畫面（PIN 已通過 / 未啟用 才走這條）
      showCacheImmediate();
      refreshAll();
    }
  } catch (e) {
    document.getElementById('main-status').textContent = '連線錯誤：' + e.message;
  }
}

// ── PIN unlock screen ───────────────────────────────────────────────────────

function showPinUnlock() {
  document.getElementById('modal-pin-unlock').hidden = false;
  document.getElementById('pin-unlock-input').value = '';
  document.getElementById('pin-unlock-error').hidden = true;
  setTimeout(() => document.getElementById('pin-unlock-input').focus(), 50);
}
function hidePinUnlock() {
  document.getElementById('modal-pin-unlock').hidden = true;
}
async function submitPinUnlock() {
  const pin = document.getElementById('pin-unlock-input').value.trim();
  const err = document.getElementById('pin-unlock-error');
  err.hidden = true;
  if (pin.length === 0) {
    err.textContent = '請輸入 PIN';
    err.hidden = false;
    return;
  }
  if (pin.length > 72) {
    err.textContent = 'PIN 太長（最多 72 字元）';
    err.hidden = false;
    return;
  }
  try {
    const uid = getUid();
    const r = await fetch(API + '/pin/verify', {
      method: 'POST',
      headers: { 'X-User-Id': encodeURIComponent(uid), 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      err.textContent = j.error === 'invalid_pin' ? 'PIN 錯誤' : ('錯誤：' + (j.error || r.status));
      err.hidden = false;
      return;
    }
    setPin(pin);
    hidePinUnlock();
    refreshAll();
  } catch (e) {
    err.textContent = '連線錯誤：' + e.message;
    err.hidden = false;
  }
}

// ── Settings (PIN management) ────────────────────────────────────────────────

async function openSettings() {
  if (!getUid()) { changeUid(); return; }
  document.getElementById('modal-settings').hidden = false;
  document.getElementById('settings-error').hidden = true;
  await renderSettingsPin();
}
function closeSettings() {
  document.getElementById('modal-settings').hidden = true;
}
async function renderSettingsPin() {
  const statusEl = document.getElementById('settings-pin-status');
  const actionsEl = document.getElementById('settings-pin-actions');
  statusEl.textContent = '檢查中…';
  actionsEl.innerHTML = '';
  try {
    const uid = getUid();
    const r = await fetch(API + '/pin/status?uid=' + encodeURIComponent(uid));
    const j = await r.json();
    _state.pinEnabled = !!j.enabled;
    if (j.enabled) {
      statusEl.textContent = '✓ 已啟用';
      statusEl.style.color = 'var(--green)';
      actionsEl.innerHTML = \`
        <button class="btn btn-ghost" onclick="openPinForm('change')">更換 PIN</button>
        <button class="btn btn-danger" onclick="openPinForm('unset')">取消 PIN 保護</button>
      \`;
    } else {
      statusEl.textContent = '未啟用';
      statusEl.style.color = 'var(--muted)';
      actionsEl.innerHTML = \`
        <button class="btn btn-primary" onclick="openPinForm('set')">啟用 PIN 保護</button>
      \`;
    }
  } catch (e) {
    statusEl.textContent = '錯誤';
    const err = document.getElementById('settings-error');
    err.textContent = e.message;
    err.hidden = false;
  }
}

// ── PIN form (set / change / unset) ─────────────────────────────────────────

function openPinForm(mode) {
  _state.pinFormMode = mode;
  const titles = { set: '啟用 PIN 保護', change: '更換 PIN', unset: '取消 PIN 保護' };
  document.getElementById('pin-form-title').textContent = titles[mode];
  document.getElementById('pin-form-old-wrap').hidden = (mode === 'set');
  document.getElementById('pin-form-new-wrap').hidden = (mode === 'unset');
  document.getElementById('pin-form-old').value = '';
  document.getElementById('pin-form-new1').value = '';
  document.getElementById('pin-form-new2').value = '';
  document.getElementById('pin-form-error').hidden = true;
  const submit = document.getElementById('pin-form-submit');
  submit.className = (mode === 'unset') ? 'btn btn-danger' : 'btn btn-primary';
  submit.textContent = (mode === 'unset') ? '確定取消' : '確認';
  document.getElementById('modal-pin-form').hidden = false;
}
function closePinForm() {
  document.getElementById('modal-pin-form').hidden = true;
}

async function submitPinForm() {
  const mode = _state.pinFormMode;
  const oldPin = document.getElementById('pin-form-old').value.trim();
  const new1 = document.getElementById('pin-form-new1').value.trim();
  const new2 = document.getElementById('pin-form-new2').value.trim();
  const err = document.getElementById('pin-form-error');
  err.hidden = true;
  function showErr(m) { err.textContent = m; err.hidden = false; }

  // 驗證 (PIN 任意長度 / 字元，只防超過 bcrypt 72 byte 上限)
  if (mode === 'change' || mode === 'unset') {
    if (oldPin.length === 0) return showErr('請輸入當前 PIN');
  }
  if (mode === 'set' || mode === 'change') {
    if (new1.length === 0) return showErr('請輸入新 PIN');
    if (new1.length > 72) return showErr('PIN 太長（最多 72 字元）');
    if (new1 !== new2) return showErr('兩次輸入的新 PIN 不一致');
  }

  try {
    const uid = getUid();
    if (mode === 'unset') {
      const r = await fetch(API + '/pin/unset', {
        method: 'POST',
        headers: { 'X-User-Id': encodeURIComponent(uid), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: oldPin }),
      });
      const j = await r.json();
      if (!r.ok) return showErr(j.error || '取消失敗');
      clearPin();
    } else {
      const body = { pin: new1 };
      if (mode === 'change') body.oldPin = oldPin;
      const r = await fetch(API + '/pin/set', {
        method: 'POST',
        headers: { 'X-User-Id': encodeURIComponent(uid), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) return showErr(j.error || '設定失敗');
      setPin(new1);  // 新 PIN 直接寫進 session
    }
    closePinForm();
    await renderSettingsPin();
  } catch (e) {
    showErr('連線錯誤：' + e.message);
  }
}

// ── Main page render ─────────────────────────────────────────────────────────

async function refreshAll() {
  const status = document.getElementById('main-status');
  status.textContent = '抓取中…';
  try {
    const holdings = await fetchHoldings();
    _state.holdings = holdings;
    if (holdings.length === 0) {
      _state.quotes = {};
      document.getElementById('portfolio-overall').hidden = true;
      renderMain();
      loadChart();
      clearCache();  // V1.0.16: 持倉全清 → 砍 cache 避免下次開啟還閃舊持倉
      status.textContent = '';
      return;
    }
    const symbolList = holdings.map(h => ({ symbol: h.symbol, market: h.market }));
    const [quotes, dividends] = await Promise.all([
      fetchQuotes(symbolList),
      fetchDividends(symbolList),
    ]);
    _state.quotes = quotes;
    _state.dividends = dividends;
    renderMain();
    renderOverall();  // V1.0.16: 頂部總覽 (總資產 + 未實現損益)
    loadChart();
    saveCache();  // V1.0.16: 存 cache 給下次開啟瞬間 render
    startAutoRefresh();  // V1.0.16: 10 秒自動 refresh quotes (盤中市值 update)
    status.textContent = '已更新：' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    status.textContent = '錯誤：' + e.message;
  }
}

async function fetchHoldings() {
  const j = await apiFetch('/holdings');
  return j.holdings || [];
}

async function fetchQuotes(symbols) {
  if (symbols.length === 0) return {};
  const tw = symbols.filter(s => s.market === 'TW').map(s => s.symbol);
  const us = symbols.filter(s => s.market === 'US').map(s => s.symbol);
  const params = new URLSearchParams();
  if (tw.length) params.set('tw', tw.join(','));
  if (us.length) params.set('us', us.join(','));
  // quotes 不需要 PIN (公開市場資料)，不走 apiFetch
  const r = await fetch(API + '/quotes?' + params);
  const j = await r.json();
  return j.quotes || {};
}

async function fetchDividends(symbols) {
  if (symbols.length === 0) return {};
  const pairs = symbols.map(s => s.market + ':' + s.symbol).join(',');
  try {
    const r = await fetch(API + '/dividend-info?symbols=' + encodeURIComponent(pairs));
    const j = await r.json();
    return j.info || {};
  } catch {
    return {};
  }
}

async function fetchDetail(market, symbol) {
  return await apiFetch('/holdings/' + market + '/' + encodeURIComponent(symbol));
}

// V1.0.16: 頂部總覽 — 拆 TW / US + 合計 (台股 NT$ / 美股 US$ / 合計 TWD)
async function renderOverall() {
  const card = document.getElementById('portfolio-overall');
  const holdings = _state.holdings || [];
  if (holdings.length === 0) { card.hidden = true; return; }
  let fxUsdTwd = 32;
  try {
    const r = await fetch('/api/portfolio/fx?pair=USD/TWD');
    if (r.ok) {
      const j = await r.json();
      if (typeof j.rate === 'number' && j.rate > 0) fxUsdTwd = j.rate;
    }
  } catch {}
  // 分市場累積 (原幣)
  let twCost = 0, twValue = 0, usCost = 0, usValue = 0;
  for (const h of holdings) {
    const q = _state.quotes[h.market + ':' + h.symbol] || {};
    const price = typeof q.price === 'number' ? q.price : h.avgCost;
    const v = h.qty * price;
    if (h.market === 'TW') { twCost += h.costBasis; twValue += v; }
    else { usCost += h.costBasis; usValue += v; }
  }
  const twPnl = twValue - twCost;
  const usPnl = usValue - usCost;
  const twPct = twCost > 0 ? (twPnl / twCost * 100) : 0;
  const usPct = usCost > 0 ? (usPnl / usCost * 100) : 0;
  const fmtRound = (n) => Math.round(n).toLocaleString();
  const sign = (n) => n > 0 ? '+' : '';
  const cls = (n) => n > 0 ? 'ov-up' : n < 0 ? 'ov-down' : '';

  const twCell = document.getElementById('ov-cell-tw');
  const usCell = document.getElementById('ov-cell-us');
  if (twValue > 0 || twCost > 0) {
    document.getElementById('ov-tw-value').textContent = 'NT$' + fmtRound(twValue);
    const el = document.getElementById('ov-tw-pnl');
    el.textContent = sign(twPnl) + fmtRound(twPnl) + ' (' + sign(twPnl) + twPct.toFixed(1) + '%)';
    el.className = 'ov-cell-pnl ' + cls(twPnl);
    twCell.hidden = false;
  } else twCell.hidden = true;
  if (usValue > 0 || usCost > 0) {
    document.getElementById('ov-us-value').textContent = '$' + fmtRound(usValue);
    // V1.0.19: 美股 cell 加台幣換算 (≈ NT$XX) 給 user 直觀比較
    const usValTwd = usValue * fxUsdTwd;
    document.getElementById('ov-us-value-twd').textContent = '≈ NT$' + fmtRound(usValTwd);
    const el = document.getElementById('ov-us-pnl');
    el.textContent = sign(usPnl) + fmtRound(usPnl) + ' (' + sign(usPnl) + usPct.toFixed(1) + '%)';
    el.className = 'ov-cell-pnl ' + cls(usPnl);
    const pnlTwdEl = document.getElementById('ov-us-pnl-twd');
    const usPnlTwd = usPnl * fxUsdTwd;
    pnlTwdEl.textContent = '≈ ' + sign(usPnl) + 'NT$' + fmtRound(Math.abs(usPnlTwd));
    usCell.hidden = false;
  } else usCell.hidden = true;

  // 合計換 TWD
  const totalValue = twValue + usValue * fxUsdTwd;
  const totalCost = twCost + usCost * fxUsdTwd;
  const pnl = totalValue - totalCost;
  const pct = totalCost > 0 ? (pnl / totalCost * 100) : 0;
  document.getElementById('ov-total-value').textContent = 'NT$' + fmtRound(totalValue);
  const pnlEl = document.getElementById('ov-pnl');
  pnlEl.className = 'ov-value ' + cls(pnl);
  pnlEl.textContent = sign(pnl) + fmtRound(pnl) + ' (' + sign(pnl) + pct.toFixed(1) + '%)';
  const hasUs = usValue > 0 || usCost > 0;
  document.getElementById('ov-fx-note').textContent = hasUs ? '美股部位 × USD/TWD ' + fxUsdTwd.toFixed(2) + ' 換算' : '';
  card.hidden = false;
}

function renderMain() {
  const root = document.getElementById('holdings-list');
  if (_state.holdings.length === 0) {
    root.innerHTML = '<div class="empty">尚無持倉。<br>按上方「+ 加交易」開始記錄你的買賣。</div>';
    document.getElementById('portfolio-section-nav').hidden = true;
    return;
  }
  // V1.0.16: 拆台股 / 美股 兩 section (比照晨報) + 顯示 section nav
  const renderHolding = (h) => {
    const key = h.market + ':' + h.symbol;
    const q = _state.quotes[key] || {};
    const price = q.price;
    const chg = q.change;
    const chgPct = q.changePct;
    const unrealized = (price != null && h.qty > 0) ? (price - h.avgCost) * h.qty : null;
    const unrealizedClass = unrealized != null ? (unrealized > 0 ? 'up' : unrealized < 0 ? 'down' : '') : '';
    const chgClass = chg != null ? (chg > 0 ? 'up' : chg < 0 ? 'down' : '') : '';
    const arrow = chg > 0 ? '↑' : chg < 0 ? '↓' : '';
    const priceTxt = price != null ? fmtNum(price) : '—';
    const chgTxt = (chg != null && chgPct != null) ? \`\${arrow}\${fmtNum(chg)} (\${fmtPct(chgPct)})\` : '';
    const name = q.name || '';
    // Stock name 跳 cnyes 外部 detail (V1.0.11)
    const cnyesUrl = h.market === 'TW'
      ? 'https://www.cnyes.com/twstock/' + h.symbol
      : 'https://invest.cnyes.com/usstock/detail/' + h.symbol;
    // 配股配息資訊 (V1.0.13: 台股 yahoo+TWSE / 美股 nasdaq.com)
    // 當年有 events → 顯示當年累計；否則前一年。點開 modal 看歷史 + 即將
    const divKey = h.market + ':' + h.symbol;
    const div = _state.dividends[divKey];
    let divHtml = '';
    if (div && (div.displayRate || div.nextExDate)) {
      const parts = [];
      // 殖利率：用 displayRate + 現價 (current quote price)
      const yieldVal = (div.displayRate != null && price != null && price > 0)
        ? (div.displayRate / price) : (div.dividendYield != null ? div.dividendYield : null);
      if (yieldVal != null) parts.push('<span class="yield">殖利率 ' + (yieldVal * 100).toFixed(2) + '%</span>');
      if (div.displayYear != null && div.displayRate != null) {
        parts.push(div.displayYear + ' 年配 ' + fmtNum(div.displayRate));
      }
      if (div.nextExDate) parts.push('<span class="upcoming">⏳ 即將除息 ' + div.nextExDate + '</span>');
      else if (div.lastExDate) parts.push('最近除息 ' + div.lastExDate);
      divHtml = '<div class="h-div" onclick="event.stopPropagation(); showDividendDetail(\\'' + divKey + '\\')">💰 ' + parts.join(' · ') + ' <span class="h-div-more">›</span></div>';
    }
    return \`
      <div class="holding" onclick="goDetail('\${h.market}', '\${h.symbol}')">
        <div class="h-row1">
          <a class="h-symbol h-symbol-link" href="\${cnyesUrl}" target="_blank" onclick="event.stopPropagation()" title="開 cnyes 詳細頁">
            <span class="h-mkt">\${h.market}</span>\${h.symbol}<span class="muted muted-small"> \${name}</span>
          </a>
          <div class="h-price">\${priceTxt}</div>
          <div class="h-chg \${chgClass}">\${chgTxt}</div>
          <span class="h-add" onclick="event.stopPropagation(); quickAddTxn('\${h.market}', '\${h.symbol}')" title="加交易">＋</span>
          <span class="h-del" onclick="event.stopPropagation(); deleteHolding('\${h.market}', '\${h.symbol}')" title="刪除這檔持股">🗑</span>
        </div>
        <div class="h-row2">
          <span>\${fmtNum(h.qty)} 股 · 均價 \${fmtNum(h.avgCost)}</span>
          <span class="h-pnl \${unrealizedClass}">\${unrealized != null ? (unrealized > 0 ? '+' : '') + fmtNum(unrealized) : ''}</span>
        </div>
        \${divHtml}
      </div>
    \`;
  };
  const tw = _state.holdings.filter(h => h.market === 'TW');
  const us = _state.holdings.filter(h => h.market === 'US');
  let html = '';
  if (tw.length > 0) {
    html += '<section id="sec-tw" class="sec-block"><div class="sec-title">📈 台股</div><div class="sec-body">' + tw.map(renderHolding).join('') + '</div></section>';
  }
  if (us.length > 0) {
    html += '<section id="sec-us" class="sec-block"><div class="sec-title">🇺🇸 美股</div><div class="sec-body">' + us.map(renderHolding).join('') + '</div></section>';
  }
  root.innerHTML = html;
  // Section nav 顯示 + 只 show 有資料的 tab
  const navBar = document.getElementById('portfolio-section-nav');
  if (navBar) {
    navBar.hidden = false;
    navBar.querySelector('[data-target="sec-tw"]').hidden = (tw.length === 0);
    navBar.querySelector('[data-target="sec-us"]').hidden = (us.length === 0);
    // recompute --sec-nav-h (字型變大 / nav 內按鈕數變動時)
    if (typeof updateSecNavHeight === 'function') updateSecNavHeight();
    // V1.0.18: IntersectionObserver — scroll 到該 section nav-btn 自動 active
    if (typeof setupSectionObserver === 'function') setupSectionObserver();
  }
}

// ── Detail page render ───────────────────────────────────────────────────────

async function goDetail(market, symbol) {
  document.getElementById('page-main').hidden = true;
  document.getElementById('page-detail').hidden = false;
  document.getElementById('detail-title').textContent = market + ' ' + symbol;
  document.getElementById('detail-overall').innerHTML = '<div class="muted">抓取中…</div>';
  document.getElementById('detail-txns').innerHTML = '';
  document.getElementById('lots-body').innerHTML = '';

  try {
    const d = await fetchDetail(market, symbol);
    _state.currentDetailTxns = d.transactions || [];
    const q = _state.quotes[market + ':' + symbol] || {};
    renderDetail(d, q);
  } catch (e) {
    document.getElementById('detail-overall').innerHTML = '<div class="error">' + e.message + '</div>';
  }
}

function editTxn(id) {
  const txn = (_state.currentDetailTxns || []).find(t => t.id === id);
  if (txn) openEditModal(txn);
}

function goMain() {
  document.getElementById('page-detail').hidden = true;
  document.getElementById('page-main').hidden = false;
}

function renderDetail(d, q) {
  const o = d.overall;
  const price = q.price;
  // 扣息派 (A 派 — dividend_cash 從 cost basis 扣減)
  const unrealized = (price != null && o && o.qty > 0) ? (price - o.avgCost) * o.qty : null;
  const unrealizedPct = (unrealized != null && o.costBasis > 0) ? (unrealized / o.costBasis * 100) : null;
  // 原始派 (B 派 — dividend_cash 不動 cost basis，配息歸到 totalDividend)
  const unrealizedBefore = (price != null && o && o.qty > 0) ? (price - o.avgCostBeforeDiv) * o.qty : null;
  const costBefore = o && o.qty > 0 ? o.avgCostBeforeDiv * o.qty : 0;
  const unrealizedBeforePct = (unrealizedBefore != null && costBefore > 0) ? (unrealizedBefore / costBefore * 100) : null;

  document.getElementById('detail-overall').innerHTML = \`
    <div class="card-hdr"><span>持倉摘要</span><span class="muted muted-small">現價 \${price != null ? fmtNum(price) : '—'}</span></div>
    <div class="card-body">
      <div class="kv"><span class="k">當前股數</span><span class="v">\${o ? fmtNum(o.qty) : '—'}</span></div>
      <div class="kv"><span class="k">均價（扣息）</span><span class="v">\${o ? fmtNum(o.avgCost) : '—'}</span></div>
      <div class="kv"><span class="k">均價（原始）</span><span class="v">\${o ? fmtNum(o.avgCostBeforeDiv) : '—'}</span></div>
      <div class="kv"><span class="k">總成本（扣息）</span><span class="v">\${o ? fmtNum(o.costBasis) : '—'}</span></div>
      <div class="kv"><span class="k">現值</span><span class="v">\${(price != null && o) ? fmtNum(price * o.qty) : '—'}</span></div>
      <div class="kv"><span class="k">未實現損益（扣息）</span><span class="v \${unrealized > 0 ? 'up' : unrealized < 0 ? 'down' : ''}">\${unrealized != null ? (unrealized > 0 ? '+' : '') + fmtNum(unrealized) + (unrealizedPct != null ? ' (' + (unrealizedPct > 0 ? '+' : '') + unrealizedPct.toFixed(1) + '%)' : '') : '—'}</span></div>
      <div class="kv"><span class="k">未實現損益（原始）</span><span class="v \${unrealizedBefore > 0 ? 'up' : unrealizedBefore < 0 ? 'down' : ''}">\${unrealizedBefore != null ? (unrealizedBefore > 0 ? '+' : '') + fmtNum(unrealizedBefore) + (unrealizedBeforePct != null ? ' (' + (unrealizedBeforePct > 0 ? '+' : '') + unrealizedBeforePct.toFixed(1) + '%)' : '') : '—'}</span></div>
      <div class="kv"><span class="k">累計實現損益</span><span class="v \${o && o.realizedPnl > 0 ? 'up' : o && o.realizedPnl < 0 ? 'down' : ''}">\${o ? (o.realizedPnl > 0 ? '+' : '') + fmtNum(o.realizedPnl) : '—'}</span></div>
      <div class="kv"><span class="k">累計領股利</span><span class="v">\${o ? fmtNum(o.totalDividend) : '—'}</span></div>
    </div>
  \`;

  const timingMap = {};
  if (price != null) {
    for (const t of d.timing || []) {
      timingMap[t.txn_id] = {
        diffPerShare: price - t.price,
        diffTotal: (price - t.price) * t.qty,
        diffPct: (price / t.price - 1) * 100,
      };
    }
  }

  const txnHtml = (d.transactions || []).map(t => {
    let typeClass = 'buy', typeLabel = '買';
    if (t.txn_type === 'sell') { typeClass = 'sell'; typeLabel = '賣'; }
    else if (t.txn_type === 'dividend_cash') { typeClass = 'div'; typeLabel = '💰股利'; }
    else if (t.txn_type === 'dividend_stock') { typeClass = 'div'; typeLabel = '🎁股票'; }

    let detail = '';
    let timing = '';
    if (t.txn_type === 'buy' || t.txn_type === 'sell') {
      detail = \`\${fmtNum(t.qty)} 股 @ \${fmtNum(t.price)}\`;
      if (t.fee && t.fee > 0) detail += \` <span class="muted muted-small">(費 \${fmtNum(t.fee)})</span>\`;
      if (t.txn_type === 'buy' && timingMap[t.id]) {
        const tm = timingMap[t.id];
        const cls = tm.diffTotal > 0 ? 'up' : tm.diffTotal < 0 ? 'down' : '';
        timing = \`<span class="timing \${cls}">若未動 \${tm.diffTotal > 0 ? '+' : ''}\${fmtNum(tm.diffTotal)} (\${tm.diffPct > 0 ? '+' : ''}\${tm.diffPct.toFixed(1)}%)</span>\`;
      }
    } else if (t.txn_type === 'dividend_cash') {
      detail = '$' + fmtNum(t.cash_amount || 0);
      if (t.source === 'auto_dividend') timing = '<span class="timing">✨自動入帳</span>';
    } else if (t.txn_type === 'dividend_stock') {
      detail = fmtNum(t.qty) + ' 股';
      if (t.source === 'auto_dividend') timing = '<span class="timing">✨自動配股</span>';
    }

    return \`
      <div class="txn-row">
        <span class="date">\${t.txn_date}</span>
        <span class="type \${typeClass}">\${typeLabel}</span>
        <span class="detail">\${detail}\${timing}</span>
        \${t.source === 'manual' ? \`<span class="edit" onclick="editTxn(\${t.id})" title="編輯">✏️</span><span class="del" onclick="deleteTxn(\${t.id})" title="刪除">🗑</span>\` : ''}
      </div>
    \`;
  }).join('');

  document.getElementById('detail-txns').innerHTML = \`
    <div class="card-hdr"><span>交易紀錄</span></div>
    <div class="card-body">\${txnHtml || '<div class="muted">尚無交易</div>'}</div>
  \`;

  const lots = (d.lots || []).filter(l => l.remaining_qty > 0 || l.realized !== 0);
  const lotHtml = lots.map(l => {
    const remVal = price != null ? l.remaining_qty * price : null;
    const remUnrealized = (price != null && l.remaining_qty > 0) ? remVal - l.remaining_cost : null;
    return \`
      <div class="lot">
        <div class="lot-hdr">\${l.txn_date} · 買 \${fmtNum(l.original_qty)} @ \${fmtNum(l.original_price)}</div>
        <div class="lot-info">
          剩 \${fmtNum(l.remaining_qty)} 股 · 剩餘成本 \${fmtNum(l.remaining_cost)}
          \${remUnrealized != null ? \` · 未實現 <span class="\${remUnrealized > 0 ? 'up' : 'down'}">\${remUnrealized > 0 ? '+' : ''}\${fmtNum(remUnrealized)}</span>\` : ''}
        </div>
        \${l.realized !== 0 ? \`<div class="lot-info">已實現 <span class="\${l.realized > 0 ? 'up' : 'down'}">\${l.realized > 0 ? '+' : ''}\${fmtNum(l.realized)}</span></div>\` : ''}
      </div>
    \`;
  }).join('');
  document.getElementById('lots-body').innerHTML = lotHtml || '<div class="muted">無 lot 資料</div>';
}

function toggleLots() {
  const body = document.getElementById('lots-body');
  const hdr = document.querySelector('#detail-lots .card-hdr > span:first-child');
  body.hidden = !body.hidden;
  hdr.textContent = (body.hidden ? '▶' : '▼') + ' Lot 詳細（FIFO）';
}

// ── Add transaction modal ────────────────────────────────────────────────────

// 加交易：股數 / 價格 / 總額 三格，填任兩格 → 自動算第三（總額 = 股數×價格，不含手續費）。
// _txOrder：最近編輯的排後面；最久沒碰的(_txOrder[0]) = 被自動計算的那格。
var _txOrder = ['total', 'qty', 'price'];
function _txReset() { _txOrder = ['total', 'qty', 'price']; }
function _txNum(n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toString(); }
function _txInput(f) {
  var i = _txOrder.indexOf(f);
  if (i >= 0) _txOrder.splice(i, 1);
  _txOrder.push(f);
  _txRecalc();
  updateFeePreview();
}
function _txRecalc() {
  var qEl = document.getElementById('f-qty'), pEl = document.getElementById('f-price'), tEl = document.getElementById('f-total');
  if (!qEl || !pEl || !tEl) return;
  var q = parseFloat(qEl.value), p = parseFloat(pEl.value), t = parseFloat(tEl.value);
  var derived = _txOrder[0];
  if (derived === 'total') { if (q > 0 && p > 0) tEl.value = _txNum(q * p, 2); }
  else if (derived === 'price') { if (q > 0 && t > 0) pEl.value = _txNum(t / q, 4); }
  else if (derived === 'qty') { if (p > 0 && t > 0) qEl.value = _txNum(t / p, 4); }
}

function openAddModal() {
  if (!getUid()) { changeUid(); return; }
  _state.editingTxnId = null;
  document.getElementById('f-symbol').disabled = false;
  document.getElementById('f-market').disabled = false;
  document.getElementById('seg-buy').disabled = false;
  document.getElementById('seg-sell').disabled = false;
  document.getElementById('modal-add').hidden = false;
  document.getElementById('f-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('f-symbol').value = '';
  document.getElementById('f-qty').value = '';
  document.getElementById('f-price').value = '';
  document.getElementById('f-total').value = '';
  document.getElementById('f-fee').value = '';
  document.getElementById('f-note').value = '';
  document.getElementById('modal-error').hidden = true;
  _txReset();
  setSide('buy');
  updateFeePreview();
}

/** 從持股 list 點 + 開加交易 modal，pre-fill symbol/market，user 不用再輸入 */
function quickAddTxn(market, symbol) {
  if (!getUid()) { changeUid(); return; }
  _state.editingTxnId = null;
  document.getElementById('f-symbol').disabled = false;
  document.getElementById('f-market').disabled = false;
  document.getElementById('seg-buy').disabled = false;
  document.getElementById('seg-sell').disabled = false;
  document.getElementById('modal-add').hidden = false;
  document.getElementById('f-market').value = market;
  document.getElementById('f-symbol').value = symbol;
  document.getElementById('f-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('f-qty').value = '';
  document.getElementById('f-price').value = '';
  document.getElementById('f-total').value = '';
  document.getElementById('f-fee').value = '';
  document.getElementById('f-note').value = '';
  document.getElementById('modal-error').hidden = true;
  _txReset();
  setSide('buy');
  updateFeePreview();
  setTimeout(() => { const el = document.getElementById('f-qty'); if (el) el.focus(); }, 50);
}

function openEditModal(txn) {
  if (!getUid()) { changeUid(); return; }
  _state.editingTxnId = txn.id;
  document.getElementById('modal-add').hidden = false;
  document.getElementById('f-market').value = txn.market;
  document.getElementById('f-market').disabled = true;
  document.getElementById('f-symbol').value = txn.symbol;
  document.getElementById('f-symbol').disabled = true;
  document.getElementById('seg-buy').disabled = true;
  document.getElementById('seg-sell').disabled = true;
  document.getElementById('f-date').value = txn.txn_date;
  document.getElementById('f-qty').value = txn.qty;
  document.getElementById('f-price').value = txn.price != null ? txn.price : '';
  document.getElementById('f-total').value = (txn.qty > 0 && txn.price != null) ? _txNum(txn.qty * txn.price, 2) : '';
  document.getElementById('f-fee').value = txn.fee != null && txn.fee > 0 ? txn.fee : '';
  document.getElementById('f-note').value = txn.note || '';
  document.getElementById('modal-error').hidden = true;
  _txReset();
  setSide(txn.txn_type);
  updateFeePreview();
}

function closeAddModal() {
  _state.editingTxnId = null;
  document.getElementById('modal-add').hidden = true;
}
function setSide(side) {
  _state.side = side;
  document.getElementById('seg-buy').classList.toggle('active', side === 'buy');
  document.getElementById('seg-sell').classList.toggle('active', side === 'sell');
  const verb = _state.editingTxnId !== null ? '編輯' : '加';
  document.getElementById('modal-title').textContent = verb + (side === 'buy' ? '買入交易' : '賣出交易');
  updateFeePreview();
}

// 加交易 modal 內 estimated fee 即時顯示 (台股 only，跟 backend queries.ts calcTwFee 邏輯一致)
function updateFeePreview() {
  const preview = document.getElementById('fee-preview');
  if (!preview) return;
  const market = document.getElementById('f-market').value;
  const qty = parseFloat(document.getElementById('f-qty').value);
  const price = parseFloat(document.getElementById('f-price').value);
  const side = _state.side;
  if (market !== 'TW' || !isFinite(qty) || qty <= 0 || !isFinite(price) || price <= 0) {
    preview.hidden = true;
    return;
  }
  const gross = qty * price;
  const brokerFee = Math.max(20, Math.round(gross * 0.001425));
  const tax = side === 'sell' ? Math.round(gross * 0.003) : 0;
  preview.hidden = false;
  preview.textContent = side === 'sell'
    ? '估算手續費 NT$' + brokerFee + ' + 證交稅 NT$' + tax + ' = NT$' + (brokerFee + tax)
    : '估算手續費 NT$' + brokerFee;
}

async function submitAdd() {
  // err / showErr 先安全取好（null-guard）。原本 err.hidden 在 try 外，modal-error 取不到就會同步 throw；
  //   因為 submitAdd 是 async + inline onclick，這種 throw 會變 unhandled rejection 被吃掉 → 「按了完全沒反應」(codex)。
  const err = document.getElementById('modal-error');
  // 同時用 alert()：iOS 上 modal-error 常被鍵盤蓋住/在摺疊線下，使用者看不到 → 以為「按了沒反應」。
  //   alert 是系統層對話框、一定蓋在最上面，保證看得到失敗原因（順便診斷到底卡在哪）。
  function showErr(m) { if (err) { err.textContent = m; err.hidden = false; } try { alert(m); } catch (e) { } }
  if (err) err.hidden = true;

  // 整段(取 DOM 值 + 驗證 + PATCH/POST)都包進 try → 任何例外都用 showErr 顯示，不再靜默無反應。
  try {
    const symbol = document.getElementById('f-symbol').value.trim().toUpperCase();
    const market = document.getElementById('f-market').value;
    const txn_date = document.getElementById('f-date').value;
    const qty = parseFloat(document.getElementById('f-qty').value);
    const price = parseFloat(document.getElementById('f-price').value);
    const feeRaw = document.getElementById('f-fee').value.trim();
    const note = document.getElementById('f-note').value.trim() || undefined;

    if (!symbol) return showErr('請輸入股票代號');
    if (!txn_date) return showErr('請選日期');
    if (!isFinite(qty) || qty <= 0) return showErr('股數要 > 0');
    if (!isFinite(price) || price < 0) return showErr('價格不可為負');

    // 手續費 optional override
    let feeNum = undefined;
    if (feeRaw !== '') {
      feeNum = parseFloat(feeRaw);
      if (!isFinite(feeNum) || feeNum < 0) return showErr('手續費不可為負');
    }

    if (_state.editingTxnId !== null) {
      // Edit mode: PATCH 只送可改的 fields (symbol / market / txn_type 不可改)
      const patchBody = { txn_date, qty, price, note: note || null };
      if (feeNum !== undefined) patchBody.fee = feeNum;
      await apiFetch('/transaction/' + _state.editingTxnId, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      });
      // 重新抓 detail（detail-title 取值也 null-guard，避免存好了卻在這 throw）
      const titleEl = document.getElementById('detail-title');
      const parts = (titleEl ? titleEl.textContent || '' : '').split(' ');
      const mkt = parts[0];
      const sym = parts[1];
      closeAddModal();
      if (mkt && sym) await goDetail(mkt, sym);
    } else {
      // Add mode: POST
      const body = { symbol, market, txn_date, txn_type: _state.side, qty, price, note };
      if (feeNum !== undefined) body.fee = feeNum;
      await apiFetch('/transaction', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      closeAddModal();
      refreshAll();
    }
  } catch (e) {
    showErr('儲存失敗：' + (e && e.message ? e.message : e));
  }
}

// 逐筆刪庫存：刪整檔持股（該 symbol+market 全部交易），PIN 保護、兩段確認避免誤觸
async function deleteHolding(market, symbol) {
  if (!confirm(market + ' ' + symbol + '\\n\\n確定刪除這檔持股嗎？\\n會刪掉這檔的全部交易紀錄（買 / 賣 / 配息），無法復原。')) return;
  try {
    await apiFetch('/holding/' + encodeURIComponent(market) + '/' + encodeURIComponent(symbol), { method: 'DELETE' });
    refreshAll();
  } catch (e) {
    alert('刪除失敗：' + e.message);
  }
}

async function deleteTxn(id) {
  if (!confirm('確定刪除這筆交易？')) return;
  try {
    await apiFetch('/transaction/' + id, { method: 'DELETE' });
    const title = document.getElementById('detail-title').textContent;
    const [market, symbol] = title.split(' ');
    if (market && symbol) {
      try { await goDetail(market, symbol); } catch (_e) { goMain(); refreshAll(); }
    } else {
      goMain();
      refreshAll();
    }
  } catch (e) {
    alert('刪除失敗：' + e.message);
  }
}

// ── Chart (資產變化) ─────────────────────────────────────────────────────────

const PERIOD_RANGES = {
  daily:   [30, 60, 90],
  monthly: [12, 24, 36],
  yearly:  [5, 10, 20],
};
const PERIOD_UNIT = { daily: '天', monthly: '月', yearly: '年' };

let _chartInstance = null;
let _chartPeriod = 'daily';
let _chartRange = 30;
let _autoBackfillTried = false;  // 第一次 chart load 自動 backfill 一次

async function loadChart() {
  const card = document.getElementById('chart-card');
  if (!card) return;
  if (!getUid() || _state.holdings.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  // V1.0.18: chart-card 從 hidden 變 visible → 重新 setup observer 把它納入監看
  if (typeof setupSectionObserver === 'function') setupSectionObserver();
  try {
    const data = await apiFetch('/chart?period=' + _chartPeriod + '&range=' + _chartRange);
    const points = data.points || [];
    // 第一次只有 0~1 個 point 且 user 有持倉 → 自動 backfill 90 天，
    // 避免 user 不知道要按「📥 補歷史」結果只看到 1 個點
    if (points.length <= 1 && !_autoBackfillTried && _state.holdings.length > 0) {
      _autoBackfillTried = true;
      await autoBackfill();
      return;  // autoBackfill 結束會 reload
    }
    renderChart(points, data.note || '');
  } catch (e) {
    const note = document.getElementById('chart-note');
    if (note) { note.textContent = '圖表載入失敗：' + e.message; note.hidden = false; }
  }
}

/** 首次 chart load 自動 backfill (避免 user 看到 1 個 point 困惑) */
async function autoBackfill() {
  const note = document.getElementById('chart-note');
  const btn = document.getElementById('btn-backfill');
  if (note) { note.textContent = '⏳ 第一次載入，從 Yahoo Finance 抓 90 天歷史…'; note.hidden = false; }
  if (btn) { btn.textContent = '⏳ 載入中…'; btn.disabled = true; }
  try {
    await apiFetch('/backfill?days=90', { method: 'POST' });
    if (btn) { btn.textContent = '📥 補歷史'; btn.disabled = false; }
    // 跑完重抓 chart，這次 _autoBackfillTried = true 不會再迴圈
    await loadChart();
  } catch (e) {
    if (note) note.textContent = '歷史載入失敗，可點「📥 補歷史」手動重試：' + e.message;
    if (btn) { btn.textContent = '📥 補歷史'; btn.disabled = false; }
  }
}

function setPeriod(p) {
  _chartPeriod = p;
  _chartRange = PERIOD_RANGES[p][0];  // reset to first range option
  document.querySelectorAll('.period-btn[data-period]').forEach(b => {
    b.classList.toggle('active', b.dataset.period === p);
  });
  renderRangeButtons();
  loadChart();
}

function setRange(n) {
  _chartRange = n;
  renderRangeButtons();
  loadChart();
}

function renderRangeButtons() {
  const container = document.getElementById('range-buttons');
  if (!container) return;
  const ranges = PERIOD_RANGES[_chartPeriod];
  const unit = PERIOD_UNIT[_chartPeriod];
  container.innerHTML = ranges.map(r =>
    '<button class="period-btn' + (r === _chartRange ? ' active' : '') + '" onclick="setRange(' + r + ')">' + r + unit + '</button>'
  ).join('');
}

async function backfillChart() {
  // 把 range 換算成 days
  let days = _chartRange;
  if (_chartPeriod === 'monthly') days = _chartRange * 31;
  else if (_chartPeriod === 'yearly') days = _chartRange * 366;

  const btn = document.getElementById('btn-backfill');
  const note = document.getElementById('chart-note');
  btn.textContent = '⏳ 載入中…';
  btn.disabled = true;
  note.textContent = '從 Yahoo Finance 拉 ' + days + ' 天歷史，可能要 10-30 秒…';
  note.hidden = false;
  try {
    const result = await apiFetch('/backfill?days=' + days, { method: 'POST' });
    note.textContent = '✓ 已回填 ' + (result.backfilled || 0) + ' 天 × ' + (result.symbols || 0) + ' 支股票';
    btn.textContent = '📥 補歷史';
    btn.disabled = false;
    loadChart();
  } catch (e) {
    note.textContent = '載入失敗：' + e.message;
    btn.textContent = '📥 補歷史';
    btn.disabled = false;
  }
}

function renderChart(points, note) {
  const noteEl = document.getElementById('chart-note');
  if (note) { noteEl.textContent = note; noteEl.hidden = false; }
  else { noteEl.hidden = true; }

  const canvas = document.getElementById('asset-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (_chartInstance) { _chartInstance.destroy(); _chartInstance = null; }

  if (typeof window.Chart === 'undefined') {
    // Chart.js 沒載入 (網路問題) → fallback 顯示 last value
    noteEl.textContent = '圖表 lib 載入失敗；最新總值 NT$' + (points.length > 0 ? fmtNum(points[points.length - 1].value) : '—');
    noteEl.hidden = false;
    return;
  }

  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--fg').trim() || '#e8e8ee';
  const muted = css.getPropertyValue('--muted').trim() || '#7a7a8a';
  const accent = css.getPropertyValue('--accent').trim() || '#5b9eff';

  _chartInstance = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => p.label),
      datasets: [
        {
          label: '總值',
          data: points.map(p => p.value),
          borderColor: accent,
          backgroundColor: accent + '22',
          tension: 0.2,
          fill: true,
        },
        {
          label: '總成本',
          data: points.map(p => p.cost),
          borderColor: muted,
          borderDash: [4, 4],
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: fg, font: { size: 11 } } },
        tooltip: { callbacks: { label: (item) => item.dataset.label + ': NT$' + Math.round(item.parsed.y).toLocaleString() } },
      },
      scales: {
        x: { ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 20 }, grid: { display: false } },
        y: { ticks: { color: muted, font: { size: 10 }, callback: (v) => 'NT$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : v) }, grid: { color: muted + '22' } },
      },
    },
  });
}

// ── Theme / Font / About ─────────────────────────────────────────────────────

const PORTFOLIO_VERSION = '${APP_VERSION}';
// V1.0.16: theme + font scale 三個 PWA 共用 (crewsync_*) — same origin localStorage 跨 app 同步
const THEME_KEY = 'crewsync_theme';
const LEGACY_THEME_KEY = 'portfolio_theme';
const FONT_SCALE_KEY = 'crewsync_font_scale';
const LEGACY_FONT_SCALE_KEY = 'portfolio_font_scale';

function readTheme() {
  // Same origin so 'morning_theme' 也可 access；fallback chain: shared → portfolio legacy → morning legacy
  try {
    return localStorage.getItem(THEME_KEY)
      || localStorage.getItem(LEGACY_THEME_KEY)
      || localStorage.getItem('morning_theme')
      || 'dark';
  } catch { return 'dark'; }
}

function applyTheme() {
  const t = readTheme();
  if (t === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  const btn = document.getElementById('btn-theme');
  // icon 顯示「目標 mode」: 現在 dark → 顯 ☀️ (按就切去 light)；現在 light → 顯 🌙
  if (btn) btn.textContent = t === 'light' ? '🌙' : '☀️';
  // meta theme-color 同步切換（PWA 上下狀態列色）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f5f7fa' : '#0a0a0f');
}
function toggleTheme() {
  const cur = readTheme();
  const next = cur === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyTheme();
}

// V1.0.14: 20-step font scale; V1.0.16: shared key crewsync_font_scale 跨 PWA + morning fallback
let _fontScale = 0;
try {
  const raw = localStorage.getItem(FONT_SCALE_KEY)
    ?? localStorage.getItem(LEGACY_FONT_SCALE_KEY)
    ?? localStorage.getItem('morning_font_scale');
  const s = parseInt(raw || '0');
  if (!isNaN(s) && s >= -2 && s <= 17) _fontScale = s;
} catch {}
function applyFontScale() {
  const px = 15 * (1 + _fontScale * 0.08);  // -2 → 12.6px, 0 → 15px, +17 → 35.4px
  document.documentElement.style.fontSize = px + 'px';
}
function bumpFont(dir) {
  _fontScale = Math.max(-2, Math.min(17, _fontScale + dir));
  try { localStorage.setItem(FONT_SCALE_KEY, String(_fontScale)); } catch {}
  // 字型變了 nav 高度也變 — recompute scroll offset
  if (typeof updateSecNavHeight === 'function') setTimeout(updateSecNavHeight, 50);
  applyFontScale();
}

function openAbout() {
  document.getElementById('modal-about').hidden = false;
}
function closeAbout() {
  document.getElementById('modal-about').hidden = true;
}

// ── Dividend detail modal (V1.0.13) ─────────────────────────────────────────

function showDividendDetail(key) {
  const div = _state.dividends[key];
  if (!div) return;
  const [market, symbol] = key.split(':');
  const h = _state.holdings.find(x => x.market === market && x.symbol === symbol);
  const q = _state.quotes[key] || {};
  const name = q.name || (h ? '' : symbol);
  const ccy = market === 'TW' ? 'NT$' : '$';
  document.getElementById('dd-title').textContent =
    '💰 ' + market + ' ' + symbol + (name ? ' · ' + name : '') + ' 除權息';
  // summary line: 當年 / 殖利率
  const price = q.price;
  const yieldVal = (div.displayRate != null && price && price > 0) ? (div.displayRate / price) : div.dividendYield;
  const summaryParts = [];
  if (div.displayYear != null && div.displayRate != null) {
    summaryParts.push(div.displayYear + ' 年累計 ' + ccy + fmtNum(div.displayRate));
  }
  if (yieldVal != null) summaryParts.push('殖利率 ' + (yieldVal * 100).toFixed(2) + '%');
  if (div.nextExDate) summaryParts.push('⏳ 下次除息 ' + div.nextExDate);
  document.getElementById('dd-summary').textContent = summaryParts.join(' · ');
  // events table
  const events = div.events || [];
  if (events.length === 0) {
    document.getElementById('dd-list').innerHTML = '<div class="empty">沒有除權息紀錄</div>';
  } else {
    // group by year
    const byYear = {};
    for (const e of events) {
      const y = e.date.slice(0, 4);
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push(e);
    }
    const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
    const html = years.map(y => {
      const yearTotal = byYear[y].reduce((s, e) => s + e.amount, 0);
      const rows = byYear[y].map(e => {
        const tag = e.upcoming ? '<span class="dd-tag dd-upcoming">⏳ 即將</span>' : '';
        const stockTxt = (e.stockRatio && e.stockRatio > 0) ? ' + 配股 ' + e.stockRatio + ' 股' : '';
        return '<div class="dd-row">' +
          '<span class="dd-date">' + e.date + '</span>' +
          '<span class="dd-amt">' + ccy + fmtNum(e.amount) + stockTxt + '</span>' +
          tag +
        '</div>';
      }).join('');
      return '<div class="dd-year"><div class="dd-year-hdr">' + y + ' <span class="muted muted-small">合計 ' + ccy + fmtNum(yearTotal) + '</span></div>' + rows + '</div>';
    }).join('');
    document.getElementById('dd-list').innerHTML = html;
  }
  document.getElementById('modal-dividend-detail').hidden = false;
}

function closeDividendDetail() {
  document.getElementById('modal-dividend-detail').hidden = true;
}

// ── Format helpers ───────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
function fmtPct(n) {
  if (n == null || !isFinite(n)) return '';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

// ── Enter key handler for PIN inputs ────────────────────────────────────────

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  const target = e.target;
  if (!target || !target.id) return;
  if (target.id === 'pin-unlock-input') { e.preventDefault(); submitPinUnlock(); }
  else if (target.id === 'pin-form-new2' || target.id === 'pin-form-old') { e.preventDefault(); submitPinForm(); }
});

// ── Init ─────────────────────────────────────────────────────────────────────

// 動態 set 版號顯示（避免硬編碼三處要同步）
const verTagEl = document.getElementById('ver-tag');
if (verTagEl) verTagEl.textContent = PORTFOLIO_VERSION;
const aboutVerEl = document.getElementById('about-version');
if (aboutVerEl) aboutVerEl.textContent = PORTFOLIO_VERSION;

// V1.0.18: ↻ refresh button 點下變「…」+ disabled 顯示 loading 中 (對齊晨報 smartRefresh)
async function manualRefresh() {
  const btn = document.getElementById('btn-refresh');
  const orig = btn ? btn.textContent : null;
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    await refreshAll();
  } finally {
    if (btn) { btn.textContent = orig || '↻'; btn.disabled = false; }
  }
}

// V1.0.16: 10s auto-refresh quotes — 盤中市值即時感 (不重抓 holdings/dividends)
// 盤中 only: TW 09:00-13:30 / US 21:30-05:00 (Asia/Taipei) Mon-Fri，避收盤後浪費請求
let _autoRefreshTimer = null;
function isMarketOpen(market) {
  // 用各自市場當地時區判斷，JS Date 自動處理 DST (避 codex P1: US 夏令冬令 hardcode Taipei 時段差 1 小時)
  const now = new Date();
  if (market === 'TW') {
    const tpe = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const day = tpe.getDay();
    if (day === 0 || day === 6) return false;
    const mins = tpe.getHours() * 60 + tpe.getMinutes();
    return mins >= 9 * 60 && mins <= 13 * 60 + 30;
  }
  if (market === 'US') {
    // 美東當地時間 09:30-16:00 Mon-Fri (NYSE/NASDAQ regular session)
    const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = ny.getDay();
    if (day === 0 || day === 6) return false;
    const mins = ny.getHours() * 60 + ny.getMinutes();
    return mins >= 9 * 60 + 30 && mins <= 16 * 60;
  }
  return false;
}
async function refreshQuotesOnly() {
  if (!_state.holdings || _state.holdings.length === 0) return;
  if (document.visibilityState !== 'visible') return;
  // 只抓有開盤的 market 的 symbols
  const openSymbols = _state.holdings.filter(h => isMarketOpen(h.market))
    .map(h => ({ symbol: h.symbol, market: h.market }));
  const status = document.getElementById('main-status');
  if (openSymbols.length === 0) {
    if (status) status.textContent = '市場已收盤 — 開盤時自動更新';
    return;
  }
  try {
    const newQuotes = await fetchQuotes(openSymbols);
    // merge：只更新開盤 market 的 symbol，收盤 market 的 quote 保留舊值
    _state.quotes = Object.assign({}, _state.quotes, newQuotes);
    renderMain();
    renderOverall();
    saveCache();
    const openMarkets = Array.from(new Set(openSymbols.map(s => s.market)));
    const label = openMarkets.map(m => m === 'TW' ? '📈 台股' : '🇺🇸 美股').join(' + ');
    if (status) status.textContent = label + ' 盤中 · 已更新 ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {}
}
function startAutoRefresh() {
  if (_autoRefreshTimer) return;
  _autoRefreshTimer = setInterval(refreshQuotesOnly, 10000);
}
function stopAutoRefresh() {
  if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopAutoRefresh();
  } else if (_state.holdings && _state.holdings.length > 0) {
    startAutoRefresh();
    refreshQuotesOnly();  // 切回 visible 立刻 update 一次
  }
});

applyTheme();
applyFontScale();
renderRangeButtons();
// V1.0.16: section nav click → scroll + 動態算 top-stack 高度設 scroll-margin-top
// 量整個 top-stack (hdr + sec-nav) 不只 sec-nav，scroll 才不會藏在 hdr 後
function updateSecNavHeight() {
  const stack = document.getElementById('top-stack');
  if (!stack) return;
  const h = stack.offsetHeight + 8;
  document.documentElement.style.setProperty('--sec-nav-h', h + 'px');
}

// V1.0.18: IntersectionObserver auto-active 跟著 scroll 標目前看到的 section (對齊晨報)
let _secObserver = null;
function setupSectionObserver() {
  if (_secObserver) { _secObserver.disconnect(); _secObserver = null; }
  const nav = document.getElementById('portfolio-section-nav');
  if (!nav || nav.hidden) return;
  const targets = ['sec-tw', 'sec-us', 'chart-card']
    .map(id => document.getElementById(id))
    .filter(el => el && !el.hidden);
  if (targets.length === 0) return;
  // 維護 currently-visible set across callbacks (entries 只是 delta，不是 full visible state)
  const visibleSet = new Set();
  _secObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visibleSet.add(e.target.id);
      else visibleSet.delete(e.target.id);
    }
    if (visibleSet.size === 0) return;
    // 挑 user 視野上半部 (top ∈ [0, vh/2]) 最靠近 top 那個。沒有的話 fallback 最接近 top 的
    const vh = window.innerHeight;
    let best = null, bestScore = Infinity;
    for (const id of visibleSet) {
      const el = document.getElementById(id);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      // 上半部 (0 ≤ top < vh/2) 優先；其他靠 |top| 補位 (上半部 score 0~vh/2，補位 1e6+ 一定 lose)
      const score = (top >= 0 && top < vh / 2) ? top : 1e6 + Math.abs(top);
      if (score < bestScore) { bestScore = score; best = id; }
    }
    if (best) {
      nav.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-target') === best);
      });
    }
  }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
  targets.forEach(t => _secObserver.observe(t));
}
document.addEventListener('click', function(e) {
  const t = e.target;
  if (t && t.classList && t.classList.contains('nav-btn') && t.closest('#portfolio-section-nav')) {
    updateSecNavHeight();
    const id = t.getAttribute('data-target');
    const el = id ? document.getElementById(id) : null;
    if (el) {
      // V1.0.18 fix: 點當下立即 toggle active，不等 observer (avoid observer score race)
      const nav = document.getElementById('portfolio-section-nav');
      nav.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === t));
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
});
// V1.0.19 fix: 用 Intl.DateTimeFormat formatToParts 明確抓 year/month/day
// 避 locale string format 差異 (Safari toLocaleString reparse 失敗 / en-CA ICU
// fallback 到 device locale) — formatToParts return 結構化 parts，跨 webview 穩
(function setHdrDate() {
  const el = document.getElementById('hdr-date');
  if (!el) return;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    el.textContent = y + '-' + m + '-' + d;
  } catch {
    // 極端 fallback: client local time (沒 Intl.DateTimeFormat 的 ancient browser)
    const d = new Date();
    el.textContent = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
})();
window.addEventListener('resize', updateSecNavHeight);
bootstrap();
`;
}
