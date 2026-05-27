// Portfolio module — Express router (Phase 1.D)
//
// Endpoints:
//   啟動:
//     startPortfolio()             — init schema + migrate 舊 holdings
//   診斷 (無 PIN 保護):
//     GET /api/portfolio/health
//   公開資料 (無 PIN 保護):
//     GET /portfolio                            — HTML PWA shell
//     GET /api/portfolio/quotes                 — 即時股價 proxy
//   PIN management (需 user_id，但本身不需 PIN 驗證):
//     GET  /api/portfolio/pin/status            — { enabled: bool }
//     POST /api/portfolio/pin/verify            — { pin } → { ok }
//     POST /api/portfolio/pin/set               — { pin, oldPin? } 啟用 / 改
//     POST /api/portfolio/pin/unset             — { pin } 取消
//   PIN-protected (使用 pinGate 中間件):
//     GET    /api/portfolio/transactions
//     POST   /api/portfolio/transaction
//     PATCH  /api/portfolio/transaction/:id
//     DELETE /api/portfolio/transaction/:id
//     GET    /api/portfolio/holdings
//     GET    /api/portfolio/holdings/:market/:symbol

import express from 'express';
import { ensureTables } from './schema.js';
import { migrateAllUsers } from './migration.js';
import {
  listTransactions,
  listTransactionsForSymbol,
  listUserSymbols,
  insertManualTransaction,
  updateTransaction,
  deleteTransaction,
} from './queries.js';
import { calcOverall, calcAllViews } from './holdings.js';
import { getPortfolioHtml } from './frontend.js';
import { cnyesBatch, fetchUsdTwdRate } from '../morning-builder.js';
import { querySnapshots, snapshotUser, startSnapshotCron } from './snapshot.js';
import { backfillUser } from './backfill.js';
import { fetchDividendInfo } from './dividend.js';
import {
  validatePinFormat,
  hashPin,
  verifyUserPin,
  userHasPin,
  setPinHash,
} from './pin.js';

export const portfolioRouter = express.Router();

// ── User identity (沿用晨報 X-User-Id pattern) ────────────────────────────────

function reqUserId(req: express.Request): string | null {
  const raw = req.header('X-User-Id') || req.query.uid;
  const str = Array.isArray(raw) ? String(raw[0]) : (raw as string | undefined);
  if (!str) return null;
  let decoded = str;
  try { decoded = decodeURIComponent(str); } catch (e) { /* 不是 encoded 就原樣用 */ }
  decoded = decoded.trim();
  return decoded || null;
}

function requireUserId(req: express.Request, res: express.Response): string | null {
  const userId = reqUserId(req);
  if (!userId) {
    res.status(400).json({ error: 'missing_or_invalid_user_id' });
    return null;
  }
  return userId;
}

// ── PIN gate middleware ──────────────────────────────────────────────────────
// 沒設 PIN → pass through (sub-PIN 模式，符合 opt-in)
// 設了 PIN → 要求 X-Portfolio-Pin header verify

async function pinGate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const userId = reqUserId(req);
  if (!userId) {
    res.status(400).json({ error: 'missing_or_invalid_user_id' });
    return;
  }

  try {
    const has = await userHasPin(userId);
    if (!has) return next();  // 沒啟用 PIN，直接通過

    const pin = (req.header('X-Portfolio-Pin') || '').trim();
    if (!pin) {
      res.status(401).json({ error: 'pin_required' });
      return;
    }
    const ok = await verifyUserPin(userId, pin);
    if (!ok) {
      res.status(401).json({ error: 'invalid_pin' });
      return;
    }
    return next();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ── 診斷 ─────────────────────────────────────────────────────────────────────

portfolioRouter.get('/api/portfolio/health', async (req, res) => {
  res.json({
    ok: true,
    module: 'portfolio',
    phase: '1.D',
    user_id: reqUserId(req),
  });
});

// ── Portfolio PWA shell ──────────────────────────────────────────────────────

portfolioRouter.get('/portfolio', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getPortfolioHtml());
});

// ── Quotes (即時股價 proxy 到 cnyes) — 公開市場資料，不 PIN 保護 ──────────

portfolioRouter.get('/api/portfolio/quotes', async (req, res) => {
  try {
    const twParam = String(req.query.tw || '').trim();
    const usParam = String(req.query.us || '').trim();
    const twCodes = twParam ? twParam.split(',').filter(Boolean) : [];
    const usCodes = usParam ? usParam.split(',').filter(Boolean) : [];

    const quotes: Record<string, any> = {};

    if (twCodes.length > 0) {
      const tws = await cnyesBatch(twCodes, 'TWS');
      for (const [code, q] of Object.entries(tws)) quotes[`TW:${code}`] = q;
      const missing = twCodes.filter(c => !quotes[`TW:${c}`]);
      if (missing.length > 0) {
        const twg = await cnyesBatch(missing, 'TWG');
        for (const [code, q] of Object.entries(twg)) quotes[`TW:${code}`] = q;
      }
    }

    if (usCodes.length > 0) {
      const uss = await cnyesBatch(usCodes, 'USS');
      for (const [code, q] of Object.entries(uss)) quotes[`US:${code}`] = q;
    }

    res.json({ quotes });
  } catch (e: any) {
    res.status(500).json({ error: e.message, quotes: {} });
  }
});

// ── PIN management ──────────────────────────────────────────────────────────

/** GET /api/portfolio/pin/status — 該 user 有沒有啟用 PIN？ */
portfolioRouter.get('/api/portfolio/pin/status', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const enabled = await userHasPin(userId);
    res.json({ enabled });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/portfolio/pin/verify — { pin } → { ok } */
portfolioRouter.post('/api/portfolio/pin/verify', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const pin = (req.body?.pin || '').toString();
  try {
    const ok = await verifyUserPin(userId, pin);
    if (!ok) {
      res.status(401).json({ ok: false, error: 'invalid_pin' });
      return;
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/portfolio/pin/set — 啟用或更改 PIN
 * Body: { pin: string, oldPin?: string }
 * - 首次啟用 (沒舊 PIN)：只給 pin
 * - 改 PIN：給 pin + oldPin，會先驗 oldPin
 */
portfolioRouter.post('/api/portfolio/pin/set', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const pin = (req.body?.pin || '').toString();
  const oldPin = req.body?.oldPin ? String(req.body.oldPin) : null;

  const v = validatePinFormat(pin);
  if (!v.ok) return res.status(400).json({ error: v.reason });

  try {
    const hasOld = await userHasPin(userId);
    if (hasOld) {
      if (!oldPin) return res.status(400).json({ error: 'old_pin_required' });
      const oldOk = await verifyUserPin(userId, oldPin);
      if (!oldOk) return res.status(401).json({ error: 'invalid_old_pin' });
    }

    const hash = await hashPin(pin);
    const ok = await setPinHash(userId, hash);
    if (!ok) return res.status(500).json({ error: 'set_failed' });

    res.json({ ok: true, enabled: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/portfolio/pin/unset — 取消 PIN
 * Body: { pin: string } — 驗證當前 PIN 才能 unset
 */
portfolioRouter.post('/api/portfolio/pin/unset', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const pin = (req.body?.pin || '').toString();
  try {
    const hasOld = await userHasPin(userId);
    if (!hasOld) return res.json({ ok: true, enabled: false });  // 本來就沒啟用，直接 OK

    const ok = await verifyUserPin(userId, pin);
    if (!ok) return res.status(401).json({ error: 'invalid_pin' });

    await setPinHash(userId, null);
    res.json({ ok: true, enabled: false });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Transactions CRUD (PIN-protected) ───────────────────────────────────────

portfolioRouter.get('/api/portfolio/transactions', pinGate, async (req, res) => {
  const userId = reqUserId(req)!;  // pinGate 已驗證
  try {
    const txns = await listTransactions(userId);
    res.json({ transactions: txns });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

portfolioRouter.post('/api/portfolio/transaction', pinGate, async (req, res) => {
  const userId = reqUserId(req)!;
  const body = req.body || {};
  const { symbol, market, txn_date, txn_type, qty, price, fee, note } = body;

  if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'invalid_symbol' });
  if (market !== 'TW' && market !== 'US') return res.status(400).json({ error: 'invalid_market' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(txn_date))) return res.status(400).json({ error: 'invalid_txn_date' });
  if (txn_type !== 'buy' && txn_type !== 'sell') return res.status(400).json({ error: 'invalid_txn_type' });
  const qtyNum = Number(qty);
  if (!isFinite(qtyNum) || qtyNum <= 0) return res.status(400).json({ error: 'qty_must_be_positive' });
  const priceNum = Number(price);
  if (!isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'invalid_price' });

  // Optional fee override (留空 / undefined / null = auto-calc 台股 fee；給 number = override)
  let feeNum: number | undefined = undefined;
  if (fee !== undefined && fee !== null && fee !== '') {
    feeNum = Number(fee);
    if (!isFinite(feeNum) || feeNum < 0) return res.status(400).json({ error: 'invalid_fee' });
  }

  const normalizedSymbol = symbol.trim().toUpperCase();

  // Sell pre-check：不可超賣（codex P1 fix，含 date-aware 防 backdated sell）
  // 用 txn_date <= sell.txn_date 過濾，避免 backdated sell 用未來的 buy 來 cover
  // (例：existing buy 2024-02-01，user 提 sell 2024-01-15 → 那一天根本沒持股)
  if (txn_type === 'sell') {
    try {
      const existing = await listTransactionsForSymbol(userId, normalizedSymbol, market);
      const beforeSell = existing.filter(t => t.txn_date <= txn_date);
      const overall = calcOverall(beforeSell);
      const currentQty = overall ? overall.qty : 0;
      if (qtyNum > currentQty) {
        return res.status(400).json({
          error: 'sell_exceeds_holding',
          current_qty: currentQty,
          attempted_sell_qty: qtyNum,
          as_of_date: txn_date,
        });
      }
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    const txn = await insertManualTransaction(userId, {
      symbol: normalizedSymbol,
      market,
      txn_date,
      txn_type,
      qty: qtyNum,
      price: priceNum,
      fee: feeNum,
      note: typeof note === 'string' ? note.trim() : undefined,
    });
    res.json({ transaction: txn });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

portfolioRouter.patch('/api/portfolio/transaction/:id', pinGate, async (req, res) => {
  const userId = reqUserId(req)!;
  const id = parseInt(req.params.id, 10);
  if (!isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

  const body = req.body || {};
  const update: any = {};
  if (body.txn_date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.txn_date))) return res.status(400).json({ error: 'invalid_txn_date' });
    update.txn_date = body.txn_date;
  }
  if (body.qty !== undefined) {
    const n = Number(body.qty);
    if (!isFinite(n) || n <= 0) return res.status(400).json({ error: 'qty_must_be_positive' });
    update.qty = n;
  }
  if (body.price !== undefined) {
    const n = Number(body.price);
    if (!isFinite(n) || n < 0) return res.status(400).json({ error: 'invalid_price' });
    update.price = n;
  }
  if (body.fee !== undefined && body.fee !== null && body.fee !== '') {
    const n = Number(body.fee);
    if (!isFinite(n) || n < 0) return res.status(400).json({ error: 'invalid_fee' });
    update.fee = n;
  }
  if (body.note !== undefined) {
    update.note = typeof body.note === 'string' ? body.note.trim() : null;
  }

  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

  try {
    const txn = await updateTransaction(userId, id, update);
    if (!txn) return res.status(404).json({ error: 'not_found' });
    res.json({ transaction: txn });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

portfolioRouter.delete('/api/portfolio/transaction/:id', pinGate, async (req, res) => {
  const userId = reqUserId(req)!;
  const id = parseInt(req.params.id, 10);
  if (!isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

  try {
    const ok = await deleteTransaction(userId, id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Holdings (三視角，PIN-protected) ────────────────────────────────────────

portfolioRouter.get('/api/portfolio/holdings', pinGate, async (req, res) => {
  const userId = reqUserId(req)!;
  try {
    const symbols = await listUserSymbols(userId);
    const holdings = [];
    for (const { symbol, market } of symbols) {
      const txns = await listTransactionsForSymbol(userId, symbol, market);
      const overall = calcOverall(txns);
      if (overall && overall.qty > 0) holdings.push(overall);
    }
    res.json({ holdings });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/portfolio/chart?period=daily|monthly|yearly&range=N — 資產變化圖資料 */
portfolioRouter.get('/api/portfolio/chart', pinGate, async (req, res) => {
  const userId = reqUserId(req)!;
  const period = String(req.query.period || 'daily') as 'daily' | 'monthly' | 'yearly';
  if (period !== 'daily' && period !== 'monthly' && period !== 'yearly') {
    return res.status(400).json({ error: 'invalid_period' });
  }
  const rangeRaw = parseInt(String(req.query.range || '30'), 10);
  const defaults = { daily: 30, monthly: 12, yearly: 5 };
  const range = isFinite(rangeRaw) && rangeRaw > 0 ? Math.min(rangeRaw, 365) : defaults[period];
  try {
    const points = await querySnapshots(userId, period, range);
    if (points.length === 0) {
      // 沒 snapshot data → 即時 snapshot 今天當第一個 point
      const today = new Date().toISOString().slice(0, 10);
      const result = await snapshotUser(userId, today);
      if (result) {
        return res.json({
          period,
          range,
          points: [{ label: today, value: result.total_value, cost: result.total_cost }],
          note: '尚無歷史資料；按下方「📥 補歷史」從 Yahoo Finance 回填',
        });
      }
    }
    res.json({ period, range, points });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/portfolio/fx?pair=USD/TWD — 換匯 rate (從台銀 BOT) */
// 1h memory cache，BOT 一天 update 數次
let _fxCache: { rate: number; at: number } | null = null;
portfolioRouter.get('/api/portfolio/fx', async (req, res) => {
  const pair = String(req.query.pair || '');
  if (pair !== 'USD/TWD') return res.status(400).json({ error: 'unsupported_pair' });
  const now = Date.now();
  if (_fxCache && now - _fxCache.at < 60 * 60 * 1000) {
    return res.json({ pair, rate: _fxCache.rate, cached: true });
  }
  try {
    const rate = await fetchUsdTwdRate();
    if (rate == null) return res.status(503).json({ error: 'fx_fetch_failed' });
    _fxCache = { rate, at: now };
    res.json({ pair, rate });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/portfolio/dividend-info?symbols=TW:3231,US:NVDA — V1.0.13: 台股 yahoo+TWSE，美股 nasdaq.com */
portfolioRouter.get('/api/portfolio/dividend-info', async (req, res) => {
  // 配息資料是公開市場資訊 — 不需要 user_id / PIN
  const symbolsRaw = String(req.query.symbols || '').trim();
  if (!symbolsRaw) return res.json({ info: {} });
  const parsed: Array<{ symbol: string; market: 'TW' | 'US' }> = [];
  for (const pair of symbolsRaw.split(',')) {
    const [market, symbol] = pair.split(':');
    if ((market === 'TW' || market === 'US') && symbol) {
      parsed.push({ market, symbol: symbol.trim().toUpperCase() });
    }
  }
  try {
    const info = await fetchDividendInfo(parsed);
    res.json({ info });
  } catch (e: any) {
    res.status(500).json({ error: e.message, info: {} });
  }
});

/** POST /api/portfolio/backfill?days=N — 從 Yahoo Finance 回填過去 N 天 snapshot */
portfolioRouter.post('/api/portfolio/backfill', pinGate, async (req, res) => {
  const userId = reqUserId(req)!;
  const daysRaw = parseInt(String(req.query.days || '90'), 10);
  const days = isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 1825) : 90;  // cap 5 年
  try {
    const result = await backfillUser(userId, days);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

portfolioRouter.get('/api/portfolio/holdings/:market/:symbol', pinGate, async (req, res) => {
  const userId = reqUserId(req)!;
  const market = req.params.market;
  if (market !== 'TW' && market !== 'US') return res.status(400).json({ error: 'invalid_market' });
  const symbol = req.params.symbol.toUpperCase();

  try {
    const txns = await listTransactionsForSymbol(userId, symbol, market);
    if (txns.length === 0) return res.status(404).json({ error: 'no_transactions' });
    const views = calcAllViews(txns);
    res.json({
      symbol,
      market,
      ...views,
      transactions: [...txns].reverse(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 啟動 hook ────────────────────────────────────────────────────────────────

export async function startPortfolio(): Promise<void> {
  const ok = await ensureTables();
  if (!ok) {
    console.warn('[portfolio] ensureTables failed, skip migration');
    return;
  }
  try {
    await migrateAllUsers();
  } catch (e: any) {
    console.error('[portfolio] migrateAllUsers crashed:', e.message);
  }
  // 啟動 daily snapshot cron (V1.0.5)
  startSnapshotCron();
}
