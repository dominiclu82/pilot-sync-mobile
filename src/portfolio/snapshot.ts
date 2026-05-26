// Portfolio module — daily snapshot logic (V1.0.5)
//
// 每日 cron 跑一次：對每個有持倉的 user 算 portfolio 總值 + 寫進 snapshots 表
// 給「資產變化圖」用 (按日 / 月 / 年聚合)

import { getPool } from './schema.js';
import { listTransactionsForSymbol, listUserSymbols } from './queries.js';
import { calcOverall } from './holdings.js';
import { cnyesBatch } from '../morning-builder.js';

/**
 * 抓所有需要報價的 symbols → 一次性 batch fetch 報價 → 回 map
 * 減少 API call (cnyes 不收 free quota，但別打太兇)
 */
async function fetchQuotesMap(symbols: Array<{ symbol: string; market: 'TW' | 'US' }>): Promise<Record<string, { price: number }>> {
  const map: Record<string, { price: number }> = {};
  const twCodes = symbols.filter(s => s.market === 'TW').map(s => s.symbol);
  const usCodes = symbols.filter(s => s.market === 'US').map(s => s.symbol);

  if (twCodes.length > 0) {
    const tws: any = await cnyesBatch(twCodes, 'TWS').catch(() => ({}));
    for (const [code, q] of Object.entries(tws)) {
      const p = (q as any)?.price;
      if (typeof p === 'number') map[`TW:${code}`] = { price: p };
    }
    const missing = twCodes.filter(c => !map[`TW:${c}`]);
    if (missing.length > 0) {
      const twg: any = await cnyesBatch(missing, 'TWG').catch(() => ({}));
      for (const [code, q] of Object.entries(twg)) {
        const p = (q as any)?.price;
        if (typeof p === 'number') map[`TW:${code}`] = { price: p };
      }
    }
  }

  if (usCodes.length > 0) {
    const uss: any = await cnyesBatch(usCodes, 'USS').catch(() => ({}));
    for (const [code, q] of Object.entries(uss)) {
      const p = (q as any)?.price;
      if (typeof p === 'number') map[`US:${code}`] = { price: p };
    }
  }

  return map;
}

/** Snapshot 單一 user 的當日 portfolio 總值 */
export async function snapshotUser(userId: string, dateStr: string): Promise<{ user_id: string; total_value: number; total_cost: number; symbol_count: number } | null> {
  const pool = getPool();
  if (!pool) return null;

  const symbols = await listUserSymbols(userId);
  if (symbols.length === 0) return null;

  // 抓所有 symbols 報價
  const quotes = await fetchQuotesMap(symbols);

  let totalValue = 0;
  let totalCost = 0;
  let totalRealized = 0;
  let totalDividend = 0;

  for (const { symbol, market } of symbols) {
    const txns = await listTransactionsForSymbol(userId, symbol, market);
    const overall = calcOverall(txns);
    if (!overall) continue;
    totalRealized += overall.realizedPnl;
    totalDividend += overall.totalDividend;
    if (overall.qty <= 0) continue;  // 已全賣
    totalCost += overall.costBasis;
    const price = quotes[`${market}:${symbol}`]?.price;
    if (typeof price === 'number') {
      totalValue += overall.qty * price;
    } else {
      // 抓不到報價 fallback 用 avgCost (保守估，避免 totalValue 為 0)
      totalValue += overall.qty * overall.avgCost;
    }
  }

  // Upsert (同 user / 同日只一筆)
  await pool.query(
    `INSERT INTO portfolio_snapshots
       (user_id, snapshot_date, total_value, total_cost, total_realized, total_dividend)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, snapshot_date) DO UPDATE
     SET total_value = EXCLUDED.total_value,
         total_cost = EXCLUDED.total_cost,
         total_realized = EXCLUDED.total_realized,
         total_dividend = EXCLUDED.total_dividend`,
    [userId, dateStr, totalValue, totalCost, totalRealized, totalDividend],
  );

  return { user_id: userId, total_value: totalValue, total_cost: totalCost, symbol_count: symbols.length };
}

/** Daily snapshot 全 user — 給 cron 用 */
export async function snapshotAllUsers(): Promise<{ count: number; users: string[] }> {
  const pool = getPool();
  if (!pool) return { count: 0, users: [] };
  // 抓所有有 portfolio transactions 的 user
  const r = await pool.query(`SELECT DISTINCT user_id FROM portfolio_transactions ORDER BY user_id`);
  const users = r.rows.map((row: any) => row.user_id as string);
  const today = new Date().toISOString().slice(0, 10);
  let count = 0;
  for (const userId of users) {
    try {
      const result = await snapshotUser(userId, today);
      if (result) {
        count++;
        console.log(`[portfolio-snapshot] ${userId}: $${result.total_value.toFixed(0)} (${result.symbol_count} symbols)`);
      }
    } catch (e: any) {
      console.error(`[portfolio-snapshot] ${userId} failed:`, e.message);
    }
  }
  console.log(`[portfolio-snapshot] daily done: ${count}/${users.length} users`);
  return { count, users };
}

// ── Cron 排程 — 每日 23:30 台北跑（台股早盤後 + 美股盤中，能抓到當日 close） ──

let _cronStarted = false;
let _lastSnapshotDate = '';

export function startSnapshotCron() {
  if (_cronStarted) return;
  _cronStarted = true;

  setInterval(async () => {
    try {
      const now = new Date();
      // Taipei tz offset = +8h (UTC base)
      const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const todayStr = taipei.toISOString().slice(0, 10);
      const hour = taipei.getUTCHours();  // 因為 new Date+8h 後 getUTCHours 對應 Taipei 時
      const minute = taipei.getUTCMinutes();

      // 每日 23:30 台北跑（一日只跑一次）
      if (hour === 23 && minute >= 30 && _lastSnapshotDate !== todayStr) {
        _lastSnapshotDate = todayStr;
        console.log(`[portfolio-snapshot] cron trigger ${todayStr} 23:30+`);
        await snapshotAllUsers();
      }
    } catch (e: any) {
      console.error('[portfolio-snapshot] cron tick error:', e.message);
    }
  }, 60 * 1000);  // 每分鐘 check

  console.log('[portfolio-snapshot] cron started (daily 23:30 台北)');
}

/**
 * 查 snapshots 按 period 聚合
 * period: 'daily' | 'monthly' | 'yearly'
 */
export async function querySnapshots(userId: string, period: 'daily' | 'monthly' | 'yearly'): Promise<Array<{ label: string; value: number; cost: number }>> {
  const pool = getPool();
  if (!pool) return [];

  let sql = '';
  if (period === 'daily') {
    sql = `SELECT TO_CHAR(snapshot_date, 'YYYY-MM-DD') AS label, total_value AS value, total_cost AS cost
           FROM portfolio_snapshots
           WHERE user_id = $1
           ORDER BY snapshot_date ASC`;
  } else if (period === 'monthly') {
    // 每月最後 snapshot 為當月代表
    sql = `SELECT TO_CHAR(MAX(snapshot_date), 'YYYY-MM') AS label,
                  (array_agg(total_value ORDER BY snapshot_date DESC))[1] AS value,
                  (array_agg(total_cost ORDER BY snapshot_date DESC))[1] AS cost
           FROM portfolio_snapshots
           WHERE user_id = $1
           GROUP BY DATE_TRUNC('month', snapshot_date)
           ORDER BY DATE_TRUNC('month', snapshot_date) ASC`;
  } else {  // yearly
    sql = `SELECT TO_CHAR(MAX(snapshot_date), 'YYYY') AS label,
                  (array_agg(total_value ORDER BY snapshot_date DESC))[1] AS value,
                  (array_agg(total_cost ORDER BY snapshot_date DESC))[1] AS cost
           FROM portfolio_snapshots
           WHERE user_id = $1
           GROUP BY DATE_TRUNC('year', snapshot_date)
           ORDER BY DATE_TRUNC('year', snapshot_date) ASC`;
  }

  const r = await pool.query(sql, [userId]);
  return r.rows.map((row: any) => ({
    label: row.label,
    value: parseFloat(row.value || 0),
    cost: parseFloat(row.cost || 0),
  }));
}
