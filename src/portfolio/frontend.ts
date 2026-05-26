// Portfolio module — frontend PWA shell (Phase 1.C)
//
// 一個獨立的 portfolio 子系統前端，掛在 /portfolio。
// 沿用晨報 localStorage key 'morning_uid' 作 user identity (同 origin 自動共用)。
//
// 三個主要 view：
//   1. main page — 持倉列表 + 即時股價 + 視角 1 摘要
//   2. detail page — 單一 symbol 三視角 + 交易紀錄
//   3. add transaction modal — buy/sell 表單

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
`;
}

function getClientJs(): string {
  return `
const UID_KEY = 'morning_uid';  // 沿用晨報 user identity key
const API = '/api/portfolio';

let _state = {
  holdings: [],     // [{ symbol, market, qty, avgCost, ... }]
  quotes: {},       // { 'TW:2330': { price, change, changePct, ... } }
  side: 'buy',
};

// ── User identity ────────────────────────────────────────────────────────────

function getUid() {
  try { return localStorage.getItem(UID_KEY) || ''; } catch { return ''; }
}
function setUid(uid) {
  try { localStorage.setItem(UID_KEY, uid); } catch {}
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
  refreshAll();
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const uid = getUid();
  if (!uid) throw new Error('請先設定暱稱');
  const headers = Object.assign({}, opts.headers || {}, {
    'X-User-Id': encodeURIComponent(uid),
    'Content-Type': 'application/json',
  });
  const r = await fetch(API + path, { ...opts, headers });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: 'http_' + r.status }));
    throw new Error(e.error || 'http_' + r.status);
  }
  return r.json();
}

async function fetchHoldings() {
  const j = await apiFetch('/holdings');
  return j.holdings || [];
}

async function fetchQuotes(symbols) {
  // symbols: [{symbol, market}, ...]
  if (symbols.length === 0) return {};
  const tw = symbols.filter(s => s.market === 'TW').map(s => s.symbol);
  const us = symbols.filter(s => s.market === 'US').map(s => s.symbol);
  const params = new URLSearchParams();
  if (tw.length) params.set('tw', tw.join(','));
  if (us.length) params.set('us', us.join(','));
  const j = await apiFetch('/quotes?' + params);
  return j.quotes || {};
}

async function fetchDetail(market, symbol) {
  return await apiFetch('/holdings/' + market + '/' + encodeURIComponent(symbol));
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

  // Overall card (視角 1)
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

  // Transactions (含視角 2 timing for buy)
  const timingMap = {};  // txn_id → diff info
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

  // Lots (視角 3) — 摺疊
  const lots = (d.lots || []).filter(l => l.remaining_qty > 0 || l.realized !== 0);
  const lotHtml = lots.map(l => {
    const remVal = price != null ? l.remaining_qty * price : null;
    const remUnrealized = (price != null && l.remaining_qty > 0)
      ? remVal - l.remaining_cost
      : null;
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

  if (!symbol) return showErr('請輸入股票代號');
  if (!txn_date) return showErr('請選日期');
  if (!isFinite(qty) || qty <= 0) return showErr('股數要 > 0');
  if (!isFinite(price) || price < 0) return showErr('價格不可為負');

  function showErr(m) { err.textContent = m; err.hidden = false; }

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
    // 重新抓 detail
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

// ── Init ─────────────────────────────────────────────────────────────────────

(function init() {
  updateUidDisplay();
  if (!getUid()) {
    // 第一次進來，沒設暱稱：提示但不強制
    document.getElementById('main-status').textContent = '請先點右上角設定暱稱';
  } else {
    refreshAll();
  }
})();
`;
}
