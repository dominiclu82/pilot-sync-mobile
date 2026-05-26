// Portfolio module — Yahoo Finance dividend info fetcher (V1.0.12)
//
// V1.0.11 用 /v10/finance/quoteSummary?modules=summaryDetail 全 null —
// Yahoo 從 2023 起逐漸 deprecate quoteSummary，無 crumb cookie 抓不到。
// 改用 /v8/finance/chart?events=div 抓過去 1 年 dividend events + 自己算
// trailing annual dividend rate + yield (current price / total annual rate)

interface DividendInfo {
  symbol: string;
  market: 'TW' | 'US';
  dividendYield: number | null;   // 年化殖利率 (decimal, e.g. 0.052 = 5.2%)
  dividendRate: number | null;    // 過去 1 年累計配息每股 (currency unit, sum of all)
  lastRate: number | null;        // 最近一次配息 per share (separate, for clarity)
  exDividendDate: string | null;  // 最近一次除息日 'YYYY-MM-DD'
  fetchedAt: number;
}

const _cache = new Map<string, DividendInfo>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function yahooSymbol(symbol: string, market: 'TW' | 'US'): string {
  return market === 'TW' ? `${symbol}.TW` : symbol;
}

async function fetchOne(symbol: string, market: 'TW' | 'US'): Promise<DividendInfo> {
  const sym = yahooSymbol(symbol, market);
  const now = Math.floor(Date.now() / 1000);
  // 2 年 lookback (annual payer 可能 ex >365d ago，過短窗會空)
  const twoYearsAgo = now - 730 * 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${twoYearsAgo}&period2=${now}&interval=1d&events=div`;

  const empty: DividendInfo = {
    symbol, market,
    dividendYield: null,
    dividendRate: null,
    lastRate: null,
    exDividendDate: null,
    fetchedAt: Date.now(),
  };

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioDividend/1.0)' },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return empty;
    const json: any = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) return empty;

    const dividends = result.events?.dividends || {};
    const price = result.meta?.regularMarketPrice ?? null;

    // annualDividend = 最近 12 個月內所有 events 加總；如果 trailing year 內 0 (annual
    // payer 上次 ex >365d ago)，fallback 用所有 events / yearsCovered 推估
    const oneYearAgoTs = now - 365 * 24 * 60 * 60;
    let trailingYearTotal = 0;
    let allEventsTotal = 0;
    let oldestTs = Number.POSITIVE_INFINITY;
    let lastExTs = 0;
    let lastRate = 0;
    for (const ts of Object.keys(dividends)) {
      const d = dividends[ts];
      const amount = typeof d?.amount === 'number' ? d.amount : 0;
      const tsNum = parseInt(ts, 10);
      allEventsTotal += amount;
      if (tsNum >= oneYearAgoTs) trailingYearTotal += amount;
      if (tsNum < oldestTs) oldestTs = tsNum;
      if (tsNum > lastExTs) {
        lastExTs = tsNum;
        lastRate = amount;
      }
    }

    let annualDividend = trailingYearTotal;
    if (annualDividend === 0 && allEventsTotal > 0 && oldestTs < now) {
      const yearsCovered = Math.max(1, (now - oldestTs) / (365 * 24 * 60 * 60));
      annualDividend = allEventsTotal / yearsCovered;
    }

    if (annualDividend === 0) return empty;  // 真的沒配過 → hide

    const exDate = lastExTs > 0 ? new Date(lastExTs * 1000).toISOString().slice(0, 10) : null;
    const dividendYield = (price && price > 0) ? annualDividend / price : null;

    return {
      symbol, market,
      dividendYield,
      dividendRate: annualDividend,
      lastRate: lastRate > 0 ? lastRate : null,
      exDividendDate: exDate,
      fetchedAt: Date.now(),
    };
  } catch (e: any) {
    console.error(`[portfolio.dividend] yahoo v8 ${sym} fetch failed:`, e.message);
    return empty;
  }
}

/** Batch fetch with 24h cache */
export async function fetchDividendInfo(
  symbols: Array<{ symbol: string; market: 'TW' | 'US' }>,
): Promise<Record<string, DividendInfo>> {
  const now = Date.now();
  const out: Record<string, DividendInfo> = {};
  const toFetch: Array<{ symbol: string; market: 'TW' | 'US' }> = [];

  for (const s of symbols) {
    const key = `${s.market}:${s.symbol}`;
    const cached = _cache.get(key);
    if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
      out[key] = cached;
    } else {
      toFetch.push(s);
    }
  }

  if (toFetch.length > 0) {
    const CHUNK = 5;
    for (let i = 0; i < toFetch.length; i += CHUNK) {
      const chunk = toFetch.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(s => fetchOne(s.symbol, s.market)));
      for (const r of results) {
        const key = `${r.market}:${r.symbol}`;
        _cache.set(key, r);
        out[key] = r;
      }
    }
  }

  return out;
}
