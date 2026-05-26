// Portfolio module — Yahoo Finance dividend info fetcher (V1.0.11)
//
// 抓 quoteSummary endpoint 取 dividend yield / last dividend rate / ex-dividend date
// In-memory cache 24h (dividend data 變動低，不需要 always-fresh)

interface DividendInfo {
  symbol: string;
  market: 'TW' | 'US';
  dividendYield: number | null;   // 年化殖利率 (decimal, e.g. 0.052 = 5.2%)
  dividendRate: number | null;    // 每股年配 (currency unit per share)
  exDividendDate: string | null;  // 'YYYY-MM-DD'
  fetchedAt: number;              // unix ms
}

const _cache = new Map<string, DividendInfo>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24h

function yahooSymbol(symbol: string, market: 'TW' | 'US'): string {
  return market === 'TW' ? `${symbol}.TW` : symbol;
}

async function fetchOne(symbol: string, market: 'TW' | 'US'): Promise<DividendInfo> {
  const sym = yahooSymbol(symbol, market);
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=summaryDetail`;

  const empty: DividendInfo = {
    symbol, market,
    dividendYield: null,
    dividendRate: null,
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
    const sd = json?.quoteSummary?.result?.[0]?.summaryDetail;
    if (!sd) return empty;
    // yahoo 用 { raw, fmt } shape；只取 raw
    const yield_raw = sd.dividendYield?.raw ?? sd.trailingAnnualDividendYield?.raw ?? null;
    const rate_raw = sd.dividendRate?.raw ?? sd.trailingAnnualDividendRate?.raw ?? null;
    const exDate = sd.exDividendDate?.raw ? new Date(sd.exDividendDate.raw * 1000).toISOString().slice(0, 10) : null;
    return {
      symbol, market,
      dividendYield: typeof yield_raw === 'number' ? yield_raw : null,
      dividendRate: typeof rate_raw === 'number' ? rate_raw : null,
      exDividendDate: exDate,
      fetchedAt: Date.now(),
    };
  } catch (e: any) {
    console.error(`[portfolio.dividend] yahoo ${sym} fetch failed:`, e.message);
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
    // 並行抓 (yahoo 沒 official rate-limit but 還是 5 個一組保守)
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
