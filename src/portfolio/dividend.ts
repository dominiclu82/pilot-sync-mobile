// Portfolio module — dividend info fetcher (V1.0.13)
//
// 多來源 multi-source 設計，目標 lookback 20 年 + 即將除息:
//   - 台股 (TW):
//       歷史 events → Yahoo /v8/finance/chart?events=div (lookback 20 年)
//       即將除息 → TWSE OpenAPI /v1/exchangeReport/TWT48U_ALL (預告表，全市場一次抓)
//   - 美股 (US):
//       歷史 events → Yahoo /v8/finance/chart?events=div (lookback 20 年，cover NYSE+NASDAQ)
//       即將除息 → nasdaq.com /api/quote/{sym}/dividends (only future rows)
//       (KO NYSE-listed nasdaq.com 0 rows，所以歷史走 yahoo cover 完整)
//
// Yahoo /v10/finance/quoteSummary 跟 /v7/finance/quote 都被 cookie/auth 擋，
// 但 /v8/finance/chart 不擋 (跟 backfill 同 endpoint reliable)

export interface DividendEvent {
  date: string;        // 'YYYY-MM-DD' (ex-dividend date)
  amount: number;      // 現金股利 per share (TWD for TW, USD for US) — 殖利率/年配只算這個
  stockRatio?: number; // 股票股利 (TW only, 股／股 e.g. 0.5 = 每股配 0.5 股) — 顯示用，不灌進 amount
  upcoming: boolean;   // true 即將除息 (ex date 在未來)
}

export interface DividendInfo {
  symbol: string;
  market: 'TW' | 'US';
  events: DividendEvent[];        // newest first，含 upcoming 跟 historical
  displayYear: number | null;     // row 顯示用哪一年的資料 (當年有 events 就當年；否則前一年)
  displayRate: number | null;     // 該年累計每股配息
  dividendYield: number | null;   // displayRate / currentPrice
  nextExDate: string | null;      // 最近一筆 upcoming (沒則 null)
  lastExDate: string | null;      // 最近一筆 historical (沒則 null)
  currentPrice: number | null;    // 計算 yield 用
  fetchedAt: number;
}

const _cache = new Map<string, DividendInfo>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6h (預告日會 update 改成短一點)

// ── TWSE 預告表 (全市場一次抓 + cache) ───────────────────────────────────────
interface TwseUpcomingEntry {
  exDate: string;     // 'YYYY-MM-DD'
  cashDividend: number;
  stockDividend: number;  // 股票股利 (股／股，e.g. 0.5 = 0.5 股每股)
  type: string;       // '息' / '權' / '權息'
}
let _twseUpcomingCache: { data: Map<string, TwseUpcomingEntry>; at: number } | null = null;
const TWSE_TTL_MS = 6 * 60 * 60 * 1000;

function rocToIso(rocDate: string): string | null {
  // '1150526' → '2026-05-26' (民國 + 1911)
  if (!rocDate || rocDate.length < 7) return null;
  const yr = parseInt(rocDate.slice(0, -4), 10) + 1911;
  const mm = rocDate.slice(-4, -2);
  const dd = rocDate.slice(-2);
  if (!isFinite(yr)) return null;
  return `${yr}-${mm}-${dd}`;
}

async function fetchTwseUpcoming(): Promise<Map<string, TwseUpcomingEntry>> {
  const now = Date.now();
  if (_twseUpcomingCache && now - _twseUpcomingCache.at < TWSE_TTL_MS) {
    return _twseUpcomingCache.data;
  }
  const fallback = () => _twseUpcomingCache?.data ?? new Map<string, TwseUpcomingEntry>();
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return fallback();  // 不 overwrite 舊 cache (avoid wiping 6h on transient outage)
    const rows: any[] = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return fallback();
    const out = new Map<string, TwseUpcomingEntry>();
    for (const row of rows) {
      const code = String(row.Code || '').trim();
      const iso = rocToIso(String(row.Date || ''));
      if (!code || !iso) continue;
      const cash = parseFloat(row.CashDividend || '0') || 0;
      const stock = parseFloat(row.StockDividendRatio || '0') || 0;
      // 同一 symbol 多日預告，保留最近 (近 future)
      const existing = out.get(code);
      if (existing && existing.exDate < iso) continue;
      out.set(code, {
        exDate: iso,
        cashDividend: cash,
        stockDividend: stock,
        type: String(row.Exdividend || ''),
      });
    }
    _twseUpcomingCache = { data: out, at: now };
    return out;
  } catch (e: any) {
    console.error('[portfolio.dividend] TWSE upcoming fetch failed:', e.message);
    return fallback();
  }
}

// ── 美股 nasdaq.com (歷史 + 即將一站式) ─────────────────────────────────────
function parseUsDate(mdy: string): string | null {
  // 'MM/DD/YYYY' → 'YYYY-MM-DD'
  if (!mdy || mdy === 'N/A') return null;
  const m = mdy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function parseUsAmount(amt: string): number {
  if (!amt) return 0;
  const cleaned = amt.replace(/[$,]/g, '');
  return parseFloat(cleaned) || 0;
}

async function fetchNasdaqUpcomingOnly(symbol: string): Promise<DividendEvent[]> {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/dividends?assetclass=stocks`;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return [];
    const json: any = await r.json();
    const rows: any[] = json?.data?.dividends?.rows || [];
    const todayIso = new Date().toISOString().slice(0, 10);
    const events: DividendEvent[] = [];
    for (const row of rows) {
      const iso = parseUsDate(String(row.exOrEffDate || ''));
      const amount = parseUsAmount(String(row.amount || ''));
      if (!iso || amount <= 0) continue;
      if (iso > todayIso) {  // only future (upcoming)
        events.push({ date: iso, amount, upcoming: true });
      }
    }
    return events;
  } catch (e: any) {
    console.error(`[portfolio.dividend] nasdaq ${symbol} upcoming fetch failed:`, e.message);
    return [];
  }
}

async function fetchYahooHistorical(yhSymbol: string): Promise<{ events: DividendEvent[]; price: number | null }> {
  const now = Math.floor(Date.now() / 1000);
  const twentyYearsAgo = now - 20 * 365 * 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yhSymbol)}?period1=${twentyYearsAgo}&period2=${now}&interval=1mo&events=div`;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioDividend/1.0)' },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return { events: [], price: null };
    const json: any = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) return { events: [], price: null };
    const dividends = result.events?.dividends || {};
    const price = result.meta?.regularMarketPrice ?? null;
    const events: DividendEvent[] = [];
    for (const ts of Object.keys(dividends)) {
      const d = dividends[ts];
      const amount = typeof d?.amount === 'number' ? d.amount : 0;
      const tsNum = parseInt(ts, 10);
      if (!isFinite(tsNum) || amount <= 0) continue;
      events.push({
        date: new Date(tsNum * 1000).toISOString().slice(0, 10),
        amount,
        upcoming: false,
      });
    }
    events.sort((a, b) => b.date.localeCompare(a.date));
    return { events, price };
  } catch (e: any) {
    console.error(`[portfolio.dividend] yahoo ${yhSymbol} fetch failed:`, e.message);
    return { events: [], price: null };
  }
}

// ── 整合 + display year picker ──────────────────────────────────────────────
function pickDisplayYear(events: DividendEvent[]): { year: number | null; rate: number | null } {
  // 只算 historical (upcoming 是預告會變，且未來年度的 declared 不該佔 fallback)
  // 當年有 historical events → 當年累計；否則最近一年 historical
  const thisYear = new Date().getFullYear();
  const byYear = new Map<number, number>();
  for (const e of events) {
    if (e.upcoming) continue;
    const y = parseInt(e.date.slice(0, 4), 10);
    byYear.set(y, (byYear.get(y) || 0) + e.amount);
  }
  if (byYear.has(thisYear)) {
    return { year: thisYear, rate: byYear.get(thisYear)! };
  }
  // 找 ≤ thisYear 最近一年 (避免抓未來)
  const years = Array.from(byYear.keys()).filter(y => y <= thisYear).sort((a, b) => b - a);
  if (years.length === 0) return { year: null, rate: null };
  return { year: years[0], rate: byYear.get(years[0])! };
}

async function fetchOne(
  symbol: string,
  market: 'TW' | 'US',
  twseUpcoming: Map<string, TwseUpcomingEntry>,
): Promise<DividendInfo> {
  const empty: DividendInfo = {
    symbol, market,
    events: [],
    displayYear: null,
    displayRate: null,
    dividendYield: null,
    nextExDate: null,
    lastExDate: null,
    currentPrice: null,
    fetchedAt: Date.now(),
  };

  let events: DividendEvent[] = [];
  let price: number | null = null;

  if (market === 'TW') {
    const hist = await fetchYahooHistorical(`${symbol}.TW`);
    events = hist.events;
    price = hist.price;
    // merge 即將除息 (TWSE 預告) — cash / stock 分開 store，避免灌進 amount 膨脹殖利率
    const up = twseUpcoming.get(symbol);
    if (up && (up.cashDividend > 0 || up.stockDividend > 0)) {
      const dup = events.find(e => e.date === up.exDate);
      if (!dup) {
        events.unshift({
          date: up.exDate,
          amount: up.cashDividend,  // cash only — yield 計算公平比較
          stockRatio: up.stockDividend > 0 ? up.stockDividend : undefined,
          upcoming: true,
        });
      }
    }
  } else {
    // 美股：yahoo 歷史 (cover NYSE+NASDAQ) + nasdaq.com upcoming only
    const [hist, upcoming] = await Promise.all([
      fetchYahooHistorical(symbol),
      fetchNasdaqUpcomingOnly(symbol),
    ]);
    events = [...upcoming, ...hist.events];
    price = hist.price;
  }

  if (events.length === 0) return empty;
  events.sort((a, b) => b.date.localeCompare(a.date));

  const { year, rate } = pickDisplayYear(events);
  const upcoming = events.filter(e => e.upcoming);
  const historical = events.filter(e => !e.upcoming);
  const nextExDate = upcoming.length > 0 ? upcoming[upcoming.length - 1].date : null;  // 最近未來
  const lastExDate = historical.length > 0 ? historical[0].date : null;
  const dividendYield = (rate != null && price != null && price > 0) ? rate / price : null;

  return {
    symbol, market,
    events,
    displayYear: year,
    displayRate: rate,
    dividendYield,
    nextExDate,
    lastExDate,
    currentPrice: price,
    fetchedAt: Date.now(),
  };
}

/** Batch fetch with 6h cache */
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

  if (toFetch.length === 0) return out;

  // 台股有要抓的才 fetch TWSE 預告 (全市場 cache 6h)
  const hasTw = toFetch.some(s => s.market === 'TW');
  const twseUpcoming = hasTw ? await fetchTwseUpcoming() : new Map<string, TwseUpcomingEntry>();

  const CHUNK = 5;
  for (let i = 0; i < toFetch.length; i += CHUNK) {
    const chunk = toFetch.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map(s => fetchOne(s.symbol, s.market, twseUpcoming)));
    for (const r of results) {
      const key = `${r.market}:${r.symbol}`;
      _cache.set(key, r);
      out[key] = r;
    }
  }

  return out;
}
