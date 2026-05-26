// Portfolio module — DB query helpers
// 純 DB 層，不含 HTTP/Express logic

import { getPool } from './schema.js';
import type { PortfolioTxn } from './holdings.js';

// ── Row → PortfolioTxn converter ─────────────────────────────────────────────
// pg driver 對 NUMERIC 預設返回 string 避免精度損失，要手動 parseFloat
function rowToTxn(row: any): PortfolioTxn {
  return {
    id: typeof row.id === 'number' ? row.id : parseInt(row.id, 10),
    user_id: row.user_id,
    symbol: row.symbol,
    market: row.market,
    txn_date: row.txn_date instanceof Date
      ? row.txn_date.toISOString().slice(0, 10)
      : String(row.txn_date).slice(0, 10),
    txn_type: row.txn_type,
    qty: parseFloat(row.qty),
    price: row.price !== null ? parseFloat(row.price) : null,
    cash_amount: row.cash_amount !== null ? parseFloat(row.cash_amount) : null,
    fee: parseFloat(row.fee ?? 0),
    source: row.source,
    note: row.note,
    created_at: row.created_at?.toISOString?.(),
    updated_at: row.updated_at?.toISOString?.(),
  };
}

// ── 讀取 ─────────────────────────────────────────────────────────────────────

/** 列出 user 全部 transactions（最近的在前面，給 detail 頁交易紀錄用） */
export async function listTransactions(userId: string): Promise<PortfolioTxn[]> {
  const pool = getPool();
  if (!pool) return [];
  const r = await pool.query(
    `SELECT * FROM portfolio_transactions
     WHERE user_id = $1
     ORDER BY txn_date DESC, id DESC`,
    [userId]
  );
  return r.rows.map(rowToTxn);
}

/** 列出 user 對單一 symbol 的 transactions（時序 ASC，給三視角算法用） */
export async function listTransactionsForSymbol(
  userId: string,
  symbol: string,
  market: 'TW' | 'US',
): Promise<PortfolioTxn[]> {
  const pool = getPool();
  if (!pool) return [];
  const r = await pool.query(
    `SELECT * FROM portfolio_transactions
     WHERE user_id = $1 AND symbol = $2 AND market = $3
     ORDER BY txn_date ASC, id ASC`,
    [userId, symbol, market],
  );
  return r.rows.map(rowToTxn);
}

/** 取得 user 持有的所有 (symbol, market) tuple（給主畫面 list 用） */
export async function listUserSymbols(
  userId: string,
): Promise<Array<{ symbol: string; market: 'TW' | 'US' }>> {
  const pool = getPool();
  if (!pool) return [];
  const r = await pool.query(
    `SELECT DISTINCT symbol, market FROM portfolio_transactions
     WHERE user_id = $1
     ORDER BY market, symbol`,
    [userId],
  );
  return r.rows.map(row => ({ symbol: row.symbol, market: row.market }));
}

// ── 寫入：手動 buy / sell ────────────────────────────────────────────────────
// dividend_cash / dividend_stock 不在這 — 那是 auto cron 自己 insert，user 不直接輸入

export interface InsertManualTxnInput {
  symbol: string;
  market: 'TW' | 'US';
  txn_date: string;          // 'YYYY-MM-DD'
  txn_type: 'buy' | 'sell';  // 限 buy/sell；dividend 自動入帳不走這
  qty: number;
  price: number;
  fee?: number;              // 留 undefined = 自動算台股 fee；給 number = override
  note?: string;
}

// ── 台股 fee + tax 自動算 ────────────────────────────────────────────────────
// 一般券商手續費 0.1425%，電子下單常見打 6 折 → 簡化用 0.1425% (V2 可加 user
// 設定 broker rate)。最低收 NT$ 20 (台股慣例 floor)。
// 證券交易稅：賣方 0.3% (一般股票；ETF 0.1%，本版 V1 簡化用 0.3% 統一)
const TW_FEE_RATE = 0.001425;
const TW_FEE_MIN = 20;
const TW_SELL_TAX = 0.003;

export function calcTwFee(qty: number, price: number, txn_type: 'buy' | 'sell'): number {
  const gross = qty * price;
  const brokerFee = Math.max(TW_FEE_MIN, Math.round(gross * TW_FEE_RATE));
  if (txn_type === 'sell') {
    return brokerFee + Math.round(gross * TW_SELL_TAX);
  }
  return brokerFee;
}

export async function insertManualTransaction(
  userId: string,
  input: InsertManualTxnInput,
): Promise<PortfolioTxn> {
  const pool = getPool();
  if (!pool) throw new Error('no_db');
  const cash_amount = input.qty * input.price;
  // fee 優先順序：user override > 台股自動算 > 美股預設 0 (broker $0 commission)
  const fee = input.fee !== undefined
    ? input.fee
    : (input.market === 'TW' ? calcTwFee(input.qty, input.price, input.txn_type) : 0);
  const r = await pool.query(
    `INSERT INTO portfolio_transactions
     (user_id, symbol, market, txn_date, txn_type, qty, price, cash_amount, fee, source, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10)
     RETURNING *`,
    [userId, input.symbol, input.market, input.txn_date, input.txn_type,
      input.qty, input.price, cash_amount, fee, input.note || null],
  );
  return rowToTxn(r.rows[0]);
}

// ── 更新 ─────────────────────────────────────────────────────────────────────

export interface UpdateTxnInput {
  txn_date?: string;
  qty?: number;
  price?: number;
  fee?: number;
  note?: string;
}

/** 改一筆 transaction；若 qty/price 變了會重算 cash_amount。回傳更新後的 row，找不到回 null */
export async function updateTransaction(
  userId: string,
  id: number,
  input: UpdateTxnInput,
): Promise<PortfolioTxn | null> {
  const pool = getPool();
  if (!pool) throw new Error('no_db');

  // 動態 build SET clause
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (input.txn_date !== undefined) { sets.push(`txn_date = $${i++}`); vals.push(input.txn_date); }
  if (input.qty !== undefined) { sets.push(`qty = $${i++}`); vals.push(input.qty); }
  if (input.price !== undefined) { sets.push(`price = $${i++}`); vals.push(input.price); }
  if (input.fee !== undefined) { sets.push(`fee = $${i++}`); vals.push(input.fee); }
  if (input.note !== undefined) { sets.push(`note = $${i++}`); vals.push(input.note); }

  // 若 qty/price 任一變了 → cash_amount 重算
  if (input.qty !== undefined || input.price !== undefined) {
    const cur = await pool.query(
      'SELECT qty, price FROM portfolio_transactions WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (cur.rows.length === 0) return null;
    const newQty = input.qty ?? parseFloat(cur.rows[0].qty);
    const curPrice = cur.rows[0].price !== null ? parseFloat(cur.rows[0].price) : 0;
    const newPrice = input.price ?? curPrice;
    sets.push(`cash_amount = $${i++}`);
    vals.push(newQty * newPrice);
  }

  if (sets.length === 0) return null;  // 沒任何欄位要更新

  sets.push(`updated_at = NOW()`);

  vals.push(id, userId);
  const r = await pool.query(
    `UPDATE portfolio_transactions SET ${sets.join(', ')}
     WHERE id = $${i++} AND user_id = $${i++}
     RETURNING *`,
    vals,
  );
  return r.rows.length > 0 ? rowToTxn(r.rows[0]) : null;
}

// ── 刪除 ─────────────────────────────────────────────────────────────────────

/** 刪一筆 transaction（限 user 自己的）；回傳是否真的刪到 */
export async function deleteTransaction(userId: string, id: number): Promise<boolean> {
  const pool = getPool();
  if (!pool) throw new Error('no_db');
  const r = await pool.query(
    'DELETE FROM portfolio_transactions WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
}
