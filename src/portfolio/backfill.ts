// Portfolio module — 從 Yahoo Finance 拉歷史 close price 回填過去 N 天的
// portfolio snapshots，讓資產變化圖能看到趨勢（V1.0.6）
//
// User 抱怨「你現在這樣只給我當下的資產.我怎麼知道變化?」 — daily cron 從上線
// 那天才開始累積，沒歷史資料。本機制：抓每支持股的 yahoo daily close + replay
// transactions 算每日 portfolio value，UPSERT 進 portfolio_snapshots。

import { getPool } from './schema.js';
import { listTransactionsForSymbol, listUserSymbols } from './queries.js';
import { calcOverall, type PortfolioTxn } from './holdings.js';
import { fetchUsdTwdRate } from '../morning-builder.js';
import { getCachedUsdTwdFromMorningReport } from '../morning.js';

interface YahooHistoryPoint {
  date: string;       // 'YYYY-MM-DD'
  close: number;
}

/**
 * 從 Yahoo Finance API 抓 symbol 的歷史 daily close
 * TW: '2330' → '2330.TW'；US: 'AAPL' → 'AAPL'
 */
export async function fetchYahooHistory(
  symbol: string,
  market: 'TW' | 'US',
  fromDate: string,        // 'YYYY-MM-DD'
  toDate: string,
): Promise<YahooHistoryPoint[]> {
  const yahooSymbol = market === 'TW' ? `${symbol}.TW` : symbol;
  const period1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const period2 = Math.floor(new Date(toDate + 'T23:59:59Z').getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=1d`;

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioBackfill/1.0)' },
    });
    if (!r.ok) return [];
    const json: any = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];
    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    const out: YahooHistoryPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      out.push({ date, close: c });
    }
    return out;
  } catch (e: any) {
    console.error(`[portfolio-backfill] yahoo fetch ${yahooSymbol} failed:`, e.message);
    return [];
  }
}

/**
 * 回填 user 過去 N 天的 portfolio snapshots
 * UPSERT 進 portfolio_snapshots，與 daily cron snapshot 共存
 * idempotent — 重跑相同 user/range 結果一樣（會 overwrite）
 */
export async function backfillUser(userId: string, days: number): Promise<{ backfilled: number; symbols: number; range: { from: string; to: string } }> {
  const pool = getPool();
  if (!pool) throw new Error('no_db');

  const symbols = await listUserSymbols(userId);
  if (symbols.length === 0) {
    return { backfilled: 0, symbols: 0, range: { from: '', to: '' } };
  }

  // 起訖日：max(today - days, 最早 transaction date)
  const earliestR = await pool.query(
    'SELECT MIN(txn_date) AS earliest FROM portfolio_transactions WHERE user_id = $1',
    [userId],
  );
  const earliest = earliestR.rows[0]?.earliest;
  if (!earliest) return { backfilled: 0, symbols: symbols.length, range: { from: '', to: '' } };

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const limitFrom = new Date(today.getTime() - days * 24 * 3600 * 1000);
  const earliestDate = new Date(earliest instanceof Date ? earliest : String(earliest));
  const fromDate = limitFrom > earliestDate ? limitFrom : earliestDate;
  const fromStr = fromDate.toISOString().slice(0, 10);

  // 1. 並行抓所有 symbol 的歷史 close price
  const histPerSymbol: Record<string, Map<string, number>> = {};
  await Promise.all(symbols.map(async ({ symbol, market }) => {
    const hist = await fetchYahooHistory(symbol, market, fromStr, todayStr);
    const map = new Map<string, number>();
    for (const h of hist) map.set(h.date, h.close);
    histPerSymbol[`${market}:${symbol}`] = map;
  }));

  // 2. 抓所有 transactions per symbol（一次性，避免每日 query）
  const txnsPerSymbol: Record<string, PortfolioTxn[]> = {};
  for (const { symbol, market } of symbols) {
    txnsPerSymbol[`${market}:${symbol}`] = await listTransactionsForSymbol(userId, symbol, market);
  }

  // 3. 生成 fromStr ~ todayStr 全部日期
  const allDates: string[] = [];
  const cur = new Date(fromStr);
  const end = new Date(todayStr);
  while (cur <= end) {
    allDates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  // 台股=TWD、美股=USD，換成台幣後再合計（修 codex P1：原本混幣相加 → 圖表/歷史錯）。
  // 歷史回填用「當前」USD/TWD 匯率近似（逐日歷史匯率為日後精修項）；抓不到且持有美股就放棄回填，避免存混幣錯值。
  const hasUs = symbols.some(s => s.market === 'US');
  let usdTwd: number | null = null;
  if (hasUs) {
    usdTwd = await getCachedUsdTwdFromMorningReport();
    if (usdTwd == null) usdTwd = await fetchUsdTwdRate();
    if (usdTwd == null || !isFinite(usdTwd) || usdTwd <= 0) {
      console.warn(`[portfolio] backfillUser ${userId}: USD/TWD 匯率抓不到且持有美股 → 略過回填（避免存混幣錯值）`);
      return { backfilled: 0, symbols: symbols.length, range: { from: '', to: '' } };
    }
  }
  const fxOf = (market: 'TW' | 'US'): number => (market === 'US' ? (usdTwd as number) : 1);

  // 4. Replay txns + 用該日 close price 算 portfolio value
  // 「最後一個已知 close」cache，跨日 fallback (週末 / 假日 yahoo 沒資料)
  const lastClose: Record<string, number> = {};
  let count = 0;

  // 用 transaction 包 upsert，避免中途 fail 留下 partial state
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const dateStr of allDates) {
      let totalValue = 0;
      let totalCost = 0;
      let totalRealized = 0;
      let totalDividend = 0;

      for (const { symbol, market } of symbols) {
        const key = `${market}:${symbol}`;
        const txns = txnsPerSymbol[key].filter(t => t.txn_date <= dateStr);
        const overall = calcOverall(txns);
        if (!overall) continue;
        const fx = fxOf(market);
        totalRealized += overall.realizedPnl * fx;
        totalDividend += overall.totalDividend * fx;
        if (overall.qty <= 0) continue;
        totalCost += overall.costBasis * fx;
        // 該日 close → fallback 用最後已知 close → fallback avgCost
        const todayClose = histPerSymbol[key].get(dateStr);
        if (todayClose != null) lastClose[key] = todayClose;
        const usePrice = todayClose ?? lastClose[key] ?? overall.avgCost;
        totalValue += overall.qty * usePrice * fx;
      }

      await client.query(
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
      count++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  console.log(`[portfolio-backfill] ${userId}: ${count} days × ${symbols.length} symbols`);
  return { backfilled: count, symbols: symbols.length, range: { from: fromStr, to: todayStr } };
}
