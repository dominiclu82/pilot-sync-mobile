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
      <div class="hdr">
        <div style="min-width:0;flex:1">
          <div class="hdr-title">
            📈 投資組合
            <span class="ver" id="ver-tag" onclick="openAbout()">V1.0.5</span>
          </div>
          <div class="hdr-user" id="hdr-user" onclick="changeUid()">—</div>
        </div>
        <div class="hdr-btns">
          <div class="hdr-btn-font" title="字型大小">
            <button onclick="bumpFont(1)">A+</button>
            <button onclick="bumpFont(-1)">A−</button>
          </div>
          <button class="hdr-btn" id="btn-theme" onclick="toggleTheme()" title="日/夜">🌙</button>
          <button class="hdr-btn" onclick="openSettings()" title="設定">⚙</button>
        </div>
      </div>
      <div class="hdr-actions">
        <button class="btn btn-primary" onclick="openAddModal()">+ 加交易</button>
        <button class="btn btn-ghost" onclick="refreshAll()">↻ 重抓</button>
      </div>
      <div id="main-status" class="status"></div>
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
          <label>股數 <input id="f-qty" type="number" step="0.0001" min="0.0001" inputmode="decimal" oninput="updateFeePreview()"></label>
          <label>價格 <input id="f-price" type="number" step="0.0001" min="0" inputmode="decimal" oninput="updateFeePreview()"></label>
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
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-weight:700;margin-bottom:6px">V1.0.5 — 編輯交易 + 資產變化圖</div>
            <div class="muted" style="font-size:.85em;line-height:1.6;margin-bottom:12px">
              • 交易紀錄每筆加 ✏️ 編輯按鈕 — 點開複用加交易 modal (edit mode)
                可改日期 / 股數 / 價格 / 手續費 / 備註（symbol / market / 方向
                lock 住不能改，避免改錯算法 break）<br>
              • 主畫面 holdings 下方加 📊 <strong>資產變化圖表</strong>
                — 按日 / 月 / 年切換<br>
              • 後台 daily cron 每天 23:30 台北自動 snapshot 全部 user 的
                portfolio 總值 + 總成本，存進新 <code>portfolio_snapshots</code> 表<br>
              • 圖表顯示「總值（accent 線）vs 總成本（虛線）」，越多天資料越完整<br>
              • 第一次開圖會 trigger 即時 snapshot 當天值當第一個 point<br>
              • Chart.js 4.4.7 從 jsdelivr CDN 載入（~90KB）
            </div>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-weight:700;margin-bottom:6px;color:var(--muted)">V1.0.4 — 台股手續費 + 證交稅</div>
            <div class="muted" style="font-size:.85em;line-height:1.6;margin-bottom:12px">
              • 台股自動算手續費（0.1425%，最低 NT$ 20）<br>
              • 賣方自動加證交稅（0.3%，一般股票）<br>
              • 美股暫不算 fee（多數 broker $0 commission）<br>
              • 加交易 modal 即時顯示「估算手續費」preview<br>
              • <strong>手續費欄位可手動覆寫</strong>（user 自己 input 從 broker app
                抄真實值，留空就用 auto-calc）<br>
              • Cost basis 算法：買入 fee 加進成本、賣出 fee + 稅扣 realized PnL<br>
              • FIFO Lot tracking：賣出 fee 按各 lot 比例分配
            </div>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-weight:700;margin-bottom:6px;color:var(--muted)">V1.0.3 — 字型 ± 無反應 hotfix</div>
            <div class="muted" style="font-size:.85em;line-height:1.6;margin-bottom:12px">
              修 V1.0.2 字型 A+/A- 按了沒變化：CSS 寫成 <code>html, body { font-size: 15px }</code>
              把 body 也寫死 15px，<code>bumpFont</code> 改 html 的 inline font-size 但
              子元素 em 是相對 body 算（body 還是 15px 沒變）→ 視覺無變化。<br>
              拆成 <code>html { font-size: 15px }</code> + <code>body { font-size: 1rem }</code>，
              body 跟著 root 變動。
            </div>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-weight:700;margin-bottom:6px;color:var(--muted)">V1.0.2 — UX 對齊晨報</div>
            <div class="muted" style="font-size:.85em;line-height:1.6;margin-bottom:12px">
              • 版號 / 字型 ± / 日夜切換按鈕**搬到 header 右上**（對齊晨報位置，
                不再藏在 footer 跟 settings modal 內）<br>
              • 漲跌顏色改**台灣股市慣例**：漲紅、跌綠（V1.0.1 用歐美 convention
                綠漲紅跌 — user 反映 "台灣人習慣跟歐美不同"，已 reverse）<br>
              • Buy / Sell 配合：buy = 紅（加碼）、sell = 綠（出場）<br>
              • Theme button 改 icon only（☀️ / 🌙），不再帶文字
            </div>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-weight:700;margin-bottom:6px;color:var(--muted)">V1.0.1 — UX 補完</div>
            <div class="muted" style="font-size:.85em;line-height:1.6;margin-bottom:12px">
              • 日夜切換（沿用晨報 <code>data-theme</code> pattern）<br>
              • 字型大小調整（基準 15px ± 8% / 級）<br>
              • 版次顯示在主畫面右下角，點開查看歷史更新<br>
              • 設定 modal 內可調整外觀、字型、PIN 三項<br>
              • 修 V1.0.0 launch 時遺漏的 UX 基本款（晨報 / Pilot Log 都有）
            </div>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-weight:700;margin-bottom:6px;color:var(--muted)">V1.0.0 — 首次上線</div>
            <div class="muted" style="font-size:.85em;line-height:1.6">
              • 多筆 buy / sell 交易帳本（不限數量、可改可刪）<br>
              • 移動均價自動計算 + 配股配息扣成本（V2 加 auto 入帳）<br>
              • 三視角同時呈現：整體實際持倉 / 每筆 buy timing 回顧 / FIFO Lot 詳細<br>
              • 即時股價（cnyes 抓取，按 ↻ 重抓）<br>
              • Opt-in PIN 保護（任意長度字元，sessionStorage 解鎖）<br>
              • 跨裝置同步沿用晨報暱稱識別<br>
              • 從晨報舊持倉 morning_prefs.tw_holdings/us_holdings 一次性 migration<br>
              • 日夜切換 + 字型大小調整
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- PIN setup / change / unset modal -->
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
  </div>
<script>${getClientJs()}</script>
</body>
</html>`;
}

function getStyles(): string {
  return `
:root {
  --bg: #0a0a0f;
  --bg-card: #15151c;
  --bg-elev: #1d1d28;
  --fg: #e8e8ee;
  --muted: #7a7a8a;
  --accent: #5b9eff;
  --green: #34d399;
  --red: #f87171;
  --border: #2a2a36;
}
[data-theme="light"] {
  --bg: #f5f7fa;
  --bg-card: #ffffff;
  --bg-elev: #eef1f5;
  --fg: #1a1a24;
  --muted: #6b6b78;
  --accent: #2563eb;
  --green: #059669;
  --red: #dc2626;
  --border: #d4d8e0;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }  /* hotfix: 強制 hidden 屬性 override 任何 author CSS display */
html { font-size: 15px; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, "Segoe UI", system-ui, "Microsoft JhengHei", sans-serif; }
body { font-size: 1rem; }
.page { max-width: 720px; margin: 0 auto; padding: 12px 14px 80px; }
.hdr { display: flex; align-items: center; gap: 10px; margin: 6px 0 16px; }
.hdr-title { font-size: 1.2em; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hdr-title .ver {
  font-size: .55em; font-weight: 600; color: var(--accent);
  background: rgba(91,158,255,0.12); border: 1px solid rgba(91,158,255,0.3);
  padding: 2px 7px; border-radius: 8px; cursor: pointer; letter-spacing: .02em;
}
.hdr-title .ver:active { opacity: .7; }
.hdr-back { font-size: 1.5em; cursor: pointer; padding: 0 6px; user-select: none; }
.hdr-user { color: var(--muted); font-size: .85em; cursor: pointer; text-decoration: underline dotted; }
.hdr-btns { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }
.hdr-btn {
  background: var(--bg-card); border: 1px solid var(--border); color: var(--fg);
  padding: 6px 9px; border-radius: 6px; font-size: .9em; cursor: pointer;
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
.hdr-actions { display: flex; gap: 8px; margin-bottom: 16px; }
.btn { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--fg); font-size: .92em; cursor: pointer; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.btn-ghost { background: transparent; }
.btn-danger { background: var(--red); border-color: var(--red); color: #fff; font-weight: 600; }
.status { color: var(--muted); font-size: .85em; margin-bottom: 10px; min-height: 1.2em; }
.list { display: flex; flex-direction: column; gap: 8px; }
.holding {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; cursor: pointer;
}
.holding:hover { background: var(--bg-elev); }
.h-row1 { display: flex; align-items: baseline; gap: 10px; }
.h-symbol { font-weight: 700; flex: 1; }
.h-symbol .h-mkt { color: var(--muted); font-size: .8em; margin-right: 4px; }
.h-price { font-weight: 600; }
.h-chg { font-size: .85em; }
.h-row2 { display: flex; gap: 12px; margin-top: 4px; color: var(--muted); font-size: .85em; }
.h-row2 .h-pnl { margin-left: auto; }
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
.txn-row .edit { cursor: pointer; color: var(--muted); padding: 0 6px; }
.txn-row .edit:hover { color: var(--accent); }
.txn-row .del { cursor: pointer; color: var(--muted); padding: 0 6px; }
.txn-row .del:hover { color: var(--red); }
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
  const text = uid ? '@' + uid : '(設定暱稱)';
  document.getElementById('hdr-user').textContent = text;
  const du = document.getElementById('detail-user');
  if (du) du.textContent = text;
}
function changeUid() {
  const cur = getUid();
  const v = prompt('輸入你的暱稱（晨報跟投資組合共用）：', cur);
  if (v === null) return;
  const trimmed = v.trim();
  if (!trimmed) return;
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

  const r = await fetch(API + path, { ...opts, headers });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: 'http_' + r.status }));
    if (e.error === 'pin_required' || e.error === 'invalid_pin') {
      // PIN 過期或錯了，清掉 session、跳 unlock screen
      clearPin();
      showPinUnlock();
      throw new Error(e.error);
    }
    throw new Error(e.error || 'http_' + r.status);
  }
  return r.json();
}

// ── Bootstrap (load 時的初始化流程) ──────────────────────────────────────────

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
      showPinUnlock();
    } else {
      hidePinUnlock();
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
      renderMain();
      loadChart();
      status.textContent = '';
      return;
    }
    const quotes = await fetchQuotes(holdings.map(h => ({ symbol: h.symbol, market: h.market })));
    _state.quotes = quotes;
    renderMain();
    loadChart();
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

async function fetchDetail(market, symbol) {
  return await apiFetch('/holdings/' + market + '/' + encodeURIComponent(symbol));
}

function renderMain() {
  const root = document.getElementById('holdings-list');
  if (_state.holdings.length === 0) {
    root.innerHTML = '<div class="empty">尚無持倉。<br>按上方「+ 加交易」開始記錄你的買賣。</div>';
    return;
  }
  const html = _state.holdings.map(h => {
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
    return \`
      <div class="holding" onclick="goDetail('\${h.market}', '\${h.symbol}')">
        <div class="h-row1">
          <div class="h-symbol"><span class="h-mkt">\${h.market}</span>\${h.symbol}<span class="muted muted-small"> \${name}</span></div>
          <div class="h-price">\${priceTxt}</div>
          <div class="h-chg \${chgClass}">\${chgTxt}</div>
        </div>
        <div class="h-row2">
          <span>\${fmtNum(h.qty)} 股 · 均價 \${fmtNum(h.avgCost)}</span>
          <span class="h-pnl \${unrealizedClass}">\${unrealized != null ? (unrealized > 0 ? '+' : '') + fmtNum(unrealized) : ''}</span>
        </div>
      </div>
    \`;
  }).join('');
  root.innerHTML = html;
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
  const unrealized = (price != null && o && o.qty > 0) ? (price - o.avgCost) * o.qty : null;
  const unrealizedPct = (unrealized != null && o.costBasis > 0) ? (unrealized / o.costBasis * 100) : null;

  document.getElementById('detail-overall').innerHTML = \`
    <div class="card-hdr"><span>持倉摘要</span><span class="muted muted-small">現價 \${price != null ? fmtNum(price) : '—'}</span></div>
    <div class="card-body">
      <div class="kv"><span class="k">當前股數</span><span class="v">\${o ? fmtNum(o.qty) : '—'}</span></div>
      <div class="kv"><span class="k">均價（扣息後）</span><span class="v">\${o ? fmtNum(o.avgCost) : '—'}</span></div>
      <div class="kv"><span class="k">總成本</span><span class="v">\${o ? fmtNum(o.costBasis) : '—'}</span></div>
      <div class="kv"><span class="k">現值</span><span class="v">\${(price != null && o) ? fmtNum(price * o.qty) : '—'}</span></div>
      <div class="kv"><span class="k">未實現損益</span><span class="v \${unrealized > 0 ? 'up' : unrealized < 0 ? 'down' : ''}">\${unrealized != null ? (unrealized > 0 ? '+' : '') + fmtNum(unrealized) + (unrealizedPct != null ? ' (' + (unrealizedPct > 0 ? '+' : '') + unrealizedPct.toFixed(1) + '%)' : '') : '—'}</span></div>
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
  document.getElementById('f-fee').value = '';
  document.getElementById('f-note').value = '';
  document.getElementById('modal-error').hidden = true;
  setSide('buy');
  updateFeePreview();
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
  document.getElementById('f-fee').value = txn.fee != null && txn.fee > 0 ? txn.fee : '';
  document.getElementById('f-note').value = txn.note || '';
  document.getElementById('modal-error').hidden = true;
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
  const symbol = document.getElementById('f-symbol').value.trim().toUpperCase();
  const market = document.getElementById('f-market').value;
  const txn_date = document.getElementById('f-date').value;
  const qty = parseFloat(document.getElementById('f-qty').value);
  const price = parseFloat(document.getElementById('f-price').value);
  const feeRaw = document.getElementById('f-fee').value.trim();
  const note = document.getElementById('f-note').value.trim() || undefined;

  const err = document.getElementById('modal-error');
  err.hidden = true;
  function showErr(m) { err.textContent = m; err.hidden = false; }

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

  try {
    if (_state.editingTxnId !== null) {
      // Edit mode: PATCH 只送可改的 fields (symbol / market / txn_type 不可改)
      const patchBody = { txn_date, qty, price, note: note || null };
      if (feeNum !== undefined) patchBody.fee = feeNum;
      await apiFetch('/transaction/' + _state.editingTxnId, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      });
      // 重新抓 detail
      const title = document.getElementById('detail-title').textContent;
      const parts = title.split(' ');
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
    showErr('儲存失敗：' + e.message);
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

let _chartInstance = null;
let _chartPeriod = 'daily';

async function loadChart() {
  const card = document.getElementById('chart-card');
  if (!card) return;
  if (!getUid() || _state.holdings.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  try {
    const data = await apiFetch('/chart?period=' + _chartPeriod);
    renderChart(data.points || [], data.note || '');
  } catch (e) {
    const note = document.getElementById('chart-note');
    if (note) { note.textContent = '圖表載入失敗：' + e.message; note.hidden = false; }
  }
}

function setPeriod(p) {
  _chartPeriod = p;
  document.querySelectorAll('.period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.period === p);
  });
  loadChart();
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

const PORTFOLIO_VERSION = 'V1.0.5';
const THEME_KEY = 'portfolio_theme';
const FONT_SCALE_KEY = 'portfolio_font_scale';

function applyTheme() {
  const t = (function(){ try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; } })();
  if (t === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = t === 'light' ? '☀️' : '🌙';
  // meta theme-color 同步切換（PWA 上下狀態列色）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f5f7fa' : '#0a0a0f');
}
function toggleTheme() {
  let cur = 'dark';
  try { cur = localStorage.getItem(THEME_KEY) || 'dark'; } catch {}
  const next = cur === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyTheme();
}

let _fontScale = 0;
try { const s = parseInt(localStorage.getItem(FONT_SCALE_KEY) || '0'); if (!isNaN(s)) _fontScale = s; } catch {}
function applyFontScale() {
  // 基準 15px，每級 ±1.2px (≈8%)
  const px = 15 * (1 + _fontScale * 0.08);
  document.documentElement.style.fontSize = px + 'px';
  const disp = document.getElementById('font-scale-display');
  if (disp) disp.textContent = _fontScale > 0 ? '+' + _fontScale : String(_fontScale);
}
function bumpFont(dir) {
  _fontScale = Math.max(-2, Math.min(8, _fontScale + dir));
  try { localStorage.setItem(FONT_SCALE_KEY, String(_fontScale)); } catch {}
  applyFontScale();
}

function openAbout() {
  document.getElementById('modal-about').hidden = false;
}
function closeAbout() {
  document.getElementById('modal-about').hidden = true;
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

applyTheme();
applyFontScale();
bootstrap();
`;
}
