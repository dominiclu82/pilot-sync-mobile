// Portfolio module — 一次性 migration：morning_prefs.tw_holdings / us_holdings → portfolio_transactions
//
// 舊資料 model（morning_prefs.prefs JSON）：
//   tw_holdings: { '2330': { qty: 100, cost: 1050 } }
//   us_holdings: { 'AAPL': { qty: 50, cost: 230 } }
//
// 搬成新 model（portfolio_transactions 一筆筆 row）：
//   每對 {code, {qty, cost}} → 一筆 txn_type='buy', source='migration', note='從舊版遷移'
//   txn_date 用今天（user 沒提供原始買入日期）
//
// Idempotent：用 morning_prefs.portfolio_migrated_at 標記已 migrate
//   NULL → 跑 migrate
//   timestamp → skip

import { getPool } from './schema.js';

interface HoldingMap { [code: string]: { qty: number; cost: number } }

export interface MigrationResult {
  user_id: string;
  migrated: boolean;
  count: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Migrate 單一 user 的 holdings → transactions
 * idempotent：已 migrate 過的會 skip
 */
export async function migrateUserHoldings(userId: string): Promise<MigrationResult> {
  const pool = getPool();
  if (!pool) return { user_id: userId, migrated: false, count: 0, skipped: false, reason: 'no_db' };

  const r = await pool.query(
    'SELECT prefs, portfolio_migrated_at FROM morning_prefs WHERE user_id = $1',
    [userId]
  );
  if (r.rows.length === 0) {
    return { user_id: userId, migrated: false, count: 0, skipped: false, reason: 'user_not_found' };
  }

  // 已 migrate → skip
  if (r.rows[0].portfolio_migrated_at !== null) {
    return { user_id: userId, migrated: false, count: 0, skipped: true, reason: 'already_migrated' };
  }

  const prefs = r.rows[0].prefs || {};
  const twHoldings: HoldingMap = prefs.tw_holdings || {};
  const usHoldings: HoldingMap = prefs.us_holdings || {};

  const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD (UTC，dev 跨日邊界差最多 8h 接受)
  let count = 0;

  // TW holdings → 一筆 buy txn
  for (const [code, h] of Object.entries(twHoldings)) {
    if (!h || typeof h.qty !== 'number' || typeof h.cost !== 'number') continue;
    if (h.qty <= 0 || h.cost <= 0) continue;
    await pool.query(
      `INSERT INTO portfolio_transactions
       (user_id, symbol, market, txn_date, txn_type, qty, price, cash_amount, source, note)
       VALUES ($1, $2, 'TW', $3, 'buy', $4, $5, $6, 'migration', '從舊版遷移')`,
      [userId, code, today, h.qty, h.cost, h.qty * h.cost]
    );
    count++;
  }

  // US holdings → 一筆 buy txn
  for (const [code, h] of Object.entries(usHoldings)) {
    if (!h || typeof h.qty !== 'number' || typeof h.cost !== 'number') continue;
    if (h.qty <= 0 || h.cost <= 0) continue;
    await pool.query(
      `INSERT INTO portfolio_transactions
       (user_id, symbol, market, txn_date, txn_type, qty, price, cash_amount, source, note)
       VALUES ($1, $2, 'US', $3, 'buy', $4, $5, $6, 'migration', '從舊版遷移')`,
      [userId, code, today, h.qty, h.cost, h.qty * h.cost]
    );
    count++;
  }

  // Mark migrated（即使 0 筆也標，避免下次重跑）
  await pool.query(
    'UPDATE morning_prefs SET portfolio_migrated_at = NOW() WHERE user_id = $1',
    [userId]
  );

  return { user_id: userId, migrated: true, count, skipped: false };
}

/**
 * 啟動時跑：所有未 migrate 的 user 一起搬（idempotent，已 migrate 的會 skip）
 */
export async function migrateAllUsers(): Promise<MigrationResult[]> {
  const pool = getPool();
  if (!pool) return [];

  const r = await pool.query('SELECT user_id FROM morning_prefs WHERE portfolio_migrated_at IS NULL');
  if (r.rows.length === 0) {
    console.log('[portfolio-migration] 沒有 user 需要 migrate');
    return [];
  }

  console.log(`[portfolio-migration] 找到 ${r.rows.length} 個 user 需要 migrate`);

  const results: MigrationResult[] = [];
  for (const row of r.rows) {
    try {
      const result = await migrateUserHoldings(row.user_id);
      results.push(result);
      if (result.migrated) {
        console.log(`[portfolio-migration] ${row.user_id}: ${result.count} 筆 holdings → transactions`);
      }
    } catch (e: any) {
      console.error(`[portfolio-migration] ${row.user_id} failed:`, e.message);
      results.push({ user_id: row.user_id, migrated: false, count: 0, skipped: false, reason: e.message });
    }
  }

  const totalTxn = results.reduce((s, r) => s + r.count, 0);
  console.log(`[portfolio-migration] 完成：${results.filter(r => r.migrated).length} user / ${totalTxn} 筆 transactions`);
  return results;
}
