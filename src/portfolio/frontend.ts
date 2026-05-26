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
</head>
<body>
  <div id="app">
    <!-- 主畫面 -->
    <div id="page-main" class="page">
      <div class="hdr">
        <div class="hdr-title">📈 投資組合</div>
        <div class="hdr-user" id="hdr-user" onclick="changeUid()">—</div>
      </div>
      <div class="hdr-actions">
        <button class="btn btn-primary" onclick="openAddModal()">+ 加交易</button>
        <button class="btn btn-ghost" onclick="refreshAll()">↻ 重抓</button>
        <button class="btn btn-ghost" onclick="openSettings()" title="設定">⚙</button>
      </div>
      <div id="main-status" class="status"></div>
      <div id="holdings-list" class="list"></div>
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
            <select id="f-market">
              <option value="TW">台股 TW</option>
              <option value="US">美股 US</option>
            </select>
          </label>
          <label>代號 <input id="f-symbol" type="text" placeholder="2330 / AAPL" autocomplete="off"></label>
          <label>日期 <input id="f-date" type="date"></label>
          <label>股數 <input id="f-qty" type="number" step="0.0001" min="0.0001" inputmode="decimal"></label>
          <label>價格 <input id="f-price" type="number" step="0.0001" min="0" inputmode="decimal"></label>
          <label>備註（可選）<input id="f-note" type="text" maxlength="100"></label>
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
* { box-sizing: border-box; }
[hidden] { display: none !important; }  /* hotfix: 強制 hidden 屬性 override 任何 author CSS display */
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, "Segoe UI", system-ui, "Microsoft JhengHei", sans-serif; font-size: 15px; }
.page { max-width: 720px; margin: 0 auto; padding: 12px 14px 80px; }
.hdr { display: flex; align-items: center; gap: 10px; margin: 6px 0 16px; }
.hdr-title { font-size: 1.2em; font-weight: 700; flex: 1; }
.hdr-back { font-size: 1.5em; cursor: pointer; padding: 0 6px; user-select: none; }
.hdr-user { color: var(--muted); font-size: .85em; cursor: pointer; text-decoration: underline dotted; }
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
.up { color: var(--green); }
.down { color: var(--red); }
.empty { color: var(--muted); text-align: center; padding: 40px 0; }
.footer { text-align: center; color: var(--muted); font-size: .75em; margin-top: 30px; padding-top: 16px; border-top: 1px solid var(--border); }
.muted { color: var(--muted); }
.muted-small { font-size: .8em; }
.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
.card-hdr { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
.card-hdr > span:first-child { flex: 1; font-weight: 600; }
.card-body { margin-top: 10px; }
.kv { display: flex; justify-content: space-between; padding: 4px 0; font-size: .92em; }
.kv .k { color: var(--muted); }
.kv .v { font-weight: 600; }
.kv .v.up { color: var(--green); }
.kv .v.down { color: var(--red); }
.txn-row { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: .9em; }
.txn-row:last-child { border-bottom: none; }
.txn-row .date { color: var(--muted); min-width: 86px; }
.txn-row .type { min-width: 50px; font-weight: 600; }
.txn-row .type.buy { color: var(--green); }
.txn-row .type.sell { color: var(--red); }
.txn-row .type.div { color: var(--accent); }
.txn-row .detail { flex: 1; }
.txn-row .timing { display: block; color: var(--muted); font-size: .82em; margin-top: 2px; }
.txn-row .del { cursor: pointer; color: var(--muted); padding: 0 6px; }
.txn-row .del:hover { color: var(--red); }
.lot { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: .9em; }
.lot:last-child { border-bottom: none; }
.lot .lot-hdr { font-weight: 600; }
.lot .lot-info { color: var(--muted); font-size: .85em; margin-top: 2px; }

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
      status.textContent = '';
      return;
    }
    const quotes = await fetchQuotes(holdings.map(h => ({ symbol: h.symbol, market: h.market })));
    _state.quotes = quotes;
    renderMain();
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
    const q = _state.quotes[market + ':' + symbol] || {};
    renderDetail(d, q);
  } catch (e) {
    document.getElementById('detail-overall').innerHTML = '<div class="error">' + e.message + '</div>';
  }
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
        \${t.source === 'manual' ? \`<span class="del" onclick="deleteTxn(\${t.id})" title="刪除">🗑</span>\` : ''}
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
  document.getElementById('modal-add').hidden = false;
  document.getElementById('f-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('f-symbol').value = '';
  document.getElementById('f-qty').value = '';
  document.getElementById('f-price').value = '';
  document.getElementById('f-note').value = '';
  document.getElementById('modal-error').hidden = true;
  setSide('buy');
}
function closeAddModal() { document.getElementById('modal-add').hidden = true; }
function setSide(side) {
  _state.side = side;
  document.getElementById('seg-buy').classList.toggle('active', side === 'buy');
  document.getElementById('seg-sell').classList.toggle('active', side === 'sell');
  document.getElementById('modal-title').textContent = side === 'buy' ? '加買入交易' : '加賣出交易';
}

async function submitAdd() {
  const symbol = document.getElementById('f-symbol').value.trim().toUpperCase();
  const market = document.getElementById('f-market').value;
  const txn_date = document.getElementById('f-date').value;
  const qty = parseFloat(document.getElementById('f-qty').value);
  const price = parseFloat(document.getElementById('f-price').value);
  const note = document.getElementById('f-note').value.trim() || undefined;

  const err = document.getElementById('modal-error');
  err.hidden = true;
  function showErr(m) { err.textContent = m; err.hidden = false; }

  if (!symbol) return showErr('請輸入股票代號');
  if (!txn_date) return showErr('請選日期');
  if (!isFinite(qty) || qty <= 0) return showErr('股數要 > 0');
  if (!isFinite(price) || price < 0) return showErr('價格不可為負');

  try {
    await apiFetch('/transaction', {
      method: 'POST',
      body: JSON.stringify({ symbol, market, txn_date, txn_type: _state.side, qty, price, note }),
    });
    closeAddModal();
    refreshAll();
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

bootstrap();
`;
}
