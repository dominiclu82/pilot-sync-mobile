// Portfolio module — Express router (Phase 1.B)
//
// Endpoints:
//   啟動:
//     startPortfolio()             — init schema + migrate 舊 holdings
//   診斷:
//     GET /api/portfolio/health    — module 已上線 marker
//   Transactions CRUD (使用者手動 buy / sell):
//     GET    /api/portfolio/transactions
//     POST   /api/portfolio/transaction
//     PATCH  /api/portfolio/transaction/:id
//     DELETE /api/portfolio/transaction/:id
//   Holdings (三視角 derivation):
//     GET /api/portfolio/holdings              — user 全部 symbols 列表 + 視角 1 摘要
//     GET /api/portfolio/holdings/:market/:symbol — 單一 symbol 三視角 full view

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
import { cnyesBatch } from '../morning-builder.js';

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

// 共用：驗證 user_id 中介層
function requireUserId(req: express.Request, res: express.Response): string | null {
  const userId = reqUserId(req);
  if (!userId) {
    res.status(400).json({ error: 'missing_or_invalid_user_id' });
    return null;
  }
  return userId;
}

// ── 診斷 ─────────────────────────────────────────────────────────────────────

portfolioRouter.get('/api/portfolio/health', async (req, res) => {
  res.json({
    ok: true,
    module: 'portfolio',
    phase: '1.C',
    user_id: reqUserId(req),
  });
});

// ── Portfolio PWA shell ──────────────────────────────────────────────────────

/** GET /portfolio — serve HTML/CSS/JS PWA shell */
portfolioRouter.get('/portfolio', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getPortfolioHtml());
});

// ── Quotes (即時股價 proxy 到 cnyes) ────────────────────────────────────────

/** GET /api/portfolio/quotes?tw=A,B,C&us=X,Y — batch 抓股價 */
portfolioRouter.get('/api/portfolio/quotes', async (req, res) => {
  // quotes 不用 user_id（公開市場資料），任何 client 都可呼叫
  try {
    const twParam = String(req.query.tw || '').trim();
    const usParam = String(req.query.us || '').trim();
    const twCodes = twParam ? twParam.split(',').filter(Boolean) : [];
    const usCodes = usParam ? usParam.split(',').filter(Boolean) : [];

    const quotes: Record<string, any> = {};

    if (twCodes.length > 0) {
      const tws = await cnyesBatch(twCodes, 'TWS');
      for (const [code, q] of Object.entries(tws)) {
        quotes[`TW:${code}`] = q;
      }
      // 上市抓不到的 fallback 興櫃 TWG
      const missing = twCodes.filter(c => !quotes[`TW:${c}`]);
      if (missing.length > 0) {
        const twg = await cnyesBatch(missing, 'TWG');
        for (const [code, q] of Object.entries(twg)) {
          quotes[`TW:${code}`] = q;
        }
      }
    }

    if (usCodes.length > 0) {
      const uss = await cnyesBatch(usCodes, 'USS');
      for (const [code, q] of Object.entries(uss)) {
        quotes[`US:${code}`] = q;
      }
    }

    res.json({ quotes });
  } catch (e: any) {
    res.status(500).json({ error: e.message, quotes: {} });
  }
});

// ── Transactions CRUD ────────────────────────────────────────────────────────

/** GET /api/portfolio/transactions — 列出 user 全部 transactions (DESC) */
portfolioRouter.get('/api/portfolio/transactions', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const txns = await listTransactions(userId);
    res.json({ transactions: txns });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/portfolio/transaction — 加一筆 buy / sell */
portfolioRouter.post('/api/portfolio/transaction', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const body = req.body || {};
  const { symbol, market, txn_date, txn_type, qty, price, note } = body;

  // Validation
  if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'invalid_symbol' });
  if (market !== 'TW' && market !== 'US') return res.status(400).json({ error: 'invalid_market' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(txn_date))) return res.status(400).json({ error: 'invalid_txn_date' });
  if (txn_type !== 'buy' && txn_type !== 'sell') return res.status(400).json({ error: 'invalid_txn_type' });
  const qtyNum = Number(qty);
  if (!isFinite(qtyNum) || qtyNum <= 0) return res.status(400).json({ error: 'qty_must_be_positive' });
  const priceNum = Number(price);
  if (!isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'invalid_price' });

  try {
    const txn = await insertManualTransaction(userId, {
      symbol: symbol.trim().toUpperCase(),
      market,
      txn_date,
      txn_type,
      qty: qtyNum,
      price: priceNum,
      note: typeof note === 'string' ? note.trim() : undefined,
    });
    res.json({ transaction: txn });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/portfolio/transaction/:id — 改一筆 transaction */
portfolioRouter.patch('/api/portfolio/transaction/:id', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

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

/** DELETE /api/portfolio/transaction/:id */
portfolioRouter.delete('/api/portfolio/transaction/:id', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

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

// ── Holdings (三視角 derivation) ────────────────────────────────────────────

/** GET /api/portfolio/holdings — user 全部 symbols 的視角 1 摘要列表（主畫面用） */
portfolioRouter.get('/api/portfolio/holdings', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const symbols = await listUserSymbols(userId);
    const holdings = [];
    for (const { symbol, market } of symbols) {
      const txns = await listTransactionsForSymbol(userId, symbol, market);
      const overall = calcOverall(txns);
      if (overall && overall.qty > 0) {
        // 只回傳當前還有持股的 (qty > 0)；qty <= 0 表示全賣光，主畫面不顯示
        holdings.push(overall);
      }
    }
    res.json({ holdings });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/portfolio/holdings/:market/:symbol — 單一 symbol 三視角 full view（detail 頁用） */
portfolioRouter.get('/api/portfolio/holdings/:market/:symbol', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

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
      transactions: [...txns].reverse(),  // detail 頁交易紀錄要 DESC（最新在前）
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 啟動 hook ────────────────────────────────────────────────────────────────

/**
 * Server 啟動時跑：建表 + 一次性 migrate（idempotent）
 */
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
}
