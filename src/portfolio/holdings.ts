// Portfolio module — 三視角 holdings derivation algorithms
//
// 從 portfolio_transactions ledger 衍生持倉狀態，純 function 不碰 DB。
//
// 視角 1: calcOverall    — 整體實際 (avg cost + 配息扣成本)，反映賣出/股利後的真實持倉
// 視角 2: calcTimingPerBuy — 每筆 buy 的 timing 回顧 (純算 buy_price vs currentPrice)
// 視角 3: calcLots       — FIFO lot tracking，每筆 buy 是獨立 lot，賣出按 FIFO 扣
//
// 配股配息策略 (對齊 V1 spec)：
//   - dividend_cash → 累計到 totalDividend；avg cost 派：成本基礎扣息 (A 派)
//   - dividend_stock → 股數增加，cost 不變，avg 自動稀釋
//   - 賣出永遠用 FIFO 順序 (視角 3) 或 avg cost (視角 1)

// ── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioTxn {
  id: number;
  user_id: string;
  symbol: string;
  market: 'TW' | 'US';
  txn_date: string;              // 'YYYY-MM-DD'
  txn_type: 'buy' | 'sell' | 'dividend_cash' | 'dividend_stock';
  qty: number;
  price: number | null;
  cash_amount: number | null;
  fee: number;
  source: 'manual' | 'auto_dividend' | 'migration';
  note: string | null;
  created_at?: string;
  updated_at?: string;
}

// 視角 1: 整體實際持倉
export interface OverallHolding {
  symbol: string;
  market: 'TW' | 'US';
  qty: number;                // 當前持股
  avgCost: number;            // 移動均價（扣息後 — 配息減 cost basis 的算法）
  avgCostBeforeDiv: number;   // 原始均價（不扣息 — 純買入 cost / 累計股數）
  costBasis: number;          // 累積成本（扣息後）
  realizedPnl: number;        // 累計已實現損益
  totalDividend: number;      // 累計領現金股利
}

// 視角 2: 每筆 buy 的 timing 回顧
export interface TimingViewItem {
  txn_id: number;
  txn_date: string;
  qty: number;              // 當時 buy 的股數
  price: number;            // 當時 buy 的單價
  // 注：currentPrice / diffTotal / diffPct 由 caller 注入（這個 function 不知道現價）
}

// 視角 3: FIFO Lot 詳細
export interface LotItem {
  txn_id: number;
  txn_date: string;
  original_qty: number;       // buy 時 qty
  original_price: number;     // buy 時單價
  remaining_qty: number;      // 經過 sell 後剩多少
  remaining_cost: number;     // 經過 sell + dividend 後剩多少 cost
  realized: number;           // 這個 lot 已被 sell 的累計實現損益
}

// ── 排序 helper ──────────────────────────────────────────────────────────────

function sortByDate(txns: PortfolioTxn[]): PortfolioTxn[] {
  // txn_date 主排序，同日按 id 第二排序（保證 deterministic）
  return [...txns].sort((a, b) => {
    if (a.txn_date < b.txn_date) return -1;
    if (a.txn_date > b.txn_date) return 1;
    return a.id - b.id;
  });
}

// ── 視角 1: 整體實際持倉 ──────────────────────────────────────────────────────
// 對單一 symbol 的所有 txns 算移動平均 cost basis + 累計實現/股利

export function calcOverall(txns: PortfolioTxn[]): OverallHolding | null {
  if (txns.length === 0) return null;

  let qty = 0;
  let costBasis = 0;             // A 派：扣息後的累積成本
  let costBasisBeforeDiv = 0;    // B 派：原始累積成本（dividend_cash 不扣）
  let realizedPnl = 0;
  let totalDividend = 0;

  for (const t of sortByDate(txns)) {
    if (t.txn_type === 'buy') {
      const price = t.price ?? 0;
      const buyCost = t.qty * price + (t.fee || 0);
      costBasis += buyCost;
      costBasisBeforeDiv += buyCost;
      qty += t.qty;
    }
    else if (t.txn_type === 'sell') {
      if (qty <= 0) continue;
      const sellQty = Math.min(t.qty, qty);
      const avg = costBasis / qty;
      const avgBefore = costBasisBeforeDiv / qty;
      const sellPrice = t.price ?? 0;
      realizedPnl += (sellPrice - avg) * sellQty - (t.fee || 0);
      costBasis = Math.max(0, costBasis - avg * sellQty);
      costBasisBeforeDiv = Math.max(0, costBasisBeforeDiv - avgBefore * sellQty);
      qty -= sellQty;
    }
    else if (t.txn_type === 'dividend_cash') {
      const amount = t.cash_amount ?? 0;
      totalDividend += amount;
      // A 派：cost basis 扣息（cap 在 0）；B 派 (BeforeDiv) cost 不變
      costBasis = Math.max(0, costBasis - amount);
    }
    else if (t.txn_type === 'dividend_stock') {
      // 配股：股數增加，兩個 cost basis 都不變 → 兩個均價都自動稀釋
      qty += t.qty;
    }
  }

  const avgCost = qty > 0 ? costBasis / qty : 0;
  const avgCostBeforeDiv = qty > 0 ? costBasisBeforeDiv / qty : 0;

  return {
    symbol: txns[0].symbol,
    market: txns[0].market,
    qty,
    avgCost,
    avgCostBeforeDiv,
    costBasis,
    realizedPnl,
    totalDividend,
  };
}

// ── 視角 2: 每筆 buy 的 timing 回顧 ──────────────────────────────────────────
// 純粹列出每筆 buy 當時的 qty/price，給 frontend 配上 currentPrice 算 diff

export function calcTimingPerBuy(txns: PortfolioTxn[]): TimingViewItem[] {
  return sortByDate(txns)
    .filter(t => t.txn_type === 'buy')
    .map(t => ({
      txn_id: t.id,
      txn_date: t.txn_date,
      qty: t.qty,
      price: t.price ?? 0,
    }));
}

// ── 視角 3: FIFO Lot 詳細追蹤 ──────────────────────────────────────────────
// 每筆 buy 是獨立 lot，賣出時按 FIFO 從最早 lot 扣
// 配股配息按各 lot 剩餘 qty 比例分配

export function calcLots(txns: PortfolioTxn[]): LotItem[] {
  const lots: LotItem[] = [];

  for (const t of sortByDate(txns)) {
    if (t.txn_type === 'buy') {
      const price = t.price ?? 0;
      const fee = t.fee || 0;
      lots.push({
        txn_id: t.id,
        txn_date: t.txn_date,
        original_qty: t.qty,
        original_price: price,
        remaining_qty: t.qty,
        remaining_cost: t.qty * price + fee,  // 買入 fee 算進該 lot 成本
        realized: 0,
      });
    }
    else if (t.txn_type === 'sell') {
      let toSell = t.qty;
      const sellPrice = t.price ?? 0;
      const totalFee = t.fee || 0;
      const totalSellQty = t.qty;
      for (const lot of lots) {
        if (toSell <= 0) break;
        if (lot.remaining_qty <= 0) continue;
        const sellFromLot = Math.min(lot.remaining_qty, toSell);
        const lotAvg = lot.remaining_qty > 0 ? lot.remaining_cost / lot.remaining_qty : 0;
        // 賣出 fee 按本筆 sell 內各 lot 的 qty 比例分配
        const feeShare = totalFee * (sellFromLot / totalSellQty);
        lot.realized += (sellPrice - lotAvg) * sellFromLot - feeShare;
        lot.remaining_qty -= sellFromLot;
        lot.remaining_cost = Math.max(0, lot.remaining_cost - lotAvg * sellFromLot);
        toSell -= sellFromLot;
      }
      // toSell 還有剩 = 賣超過持股，silent skip 剩餘 (空頭不支援)
    }
    else if (t.txn_type === 'dividend_cash') {
      const amount = t.cash_amount ?? 0;
      const totalQty = lots.reduce((s, l) => s + l.remaining_qty, 0);
      if (totalQty <= 0) continue;
      // 按各 lot 剩餘 qty 比例分配扣息
      for (const lot of lots) {
        if (lot.remaining_qty <= 0) continue;
        const share = lot.remaining_qty / totalQty;
        const lotDividend = amount * share;
        lot.remaining_cost = Math.max(0, lot.remaining_cost - lotDividend);
      }
    }
    else if (t.txn_type === 'dividend_stock') {
      const totalQty = lots.reduce((s, l) => s + l.remaining_qty, 0);
      if (totalQty <= 0) continue;
      // 按各 lot 剩餘 qty 比例分配新股 (cost 不變)
      for (const lot of lots) {
        if (lot.remaining_qty <= 0) continue;
        const share = lot.remaining_qty / totalQty;
        const newShares = t.qty * share;
        lot.remaining_qty += newShares;
      }
    }
  }

  return lots;
}

// ── 組合三視角的 helper ──────────────────────────────────────────────────────
// 給 API endpoint 用：對單一 symbol 一次性算出三視角資料

export interface HoldingFullView {
  overall: OverallHolding | null;
  timing: TimingViewItem[];
  lots: LotItem[];
}

export function calcAllViews(txns: PortfolioTxn[]): HoldingFullView {
  return {
    overall: calcOverall(txns),
    timing: calcTimingPerBuy(txns),
    lots: calcLots(txns),
  };
}

// ── Group by symbol helper ──────────────────────────────────────────────────
// User 全部 txns → 按 symbol+market 分組 → 各算三視角

export function groupTxnsBySymbol(txns: PortfolioTxn[]): Map<string, PortfolioTxn[]> {
  const groups = new Map<string, PortfolioTxn[]>();
  for (const t of txns) {
    const key = `${t.market}:${t.symbol}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  return groups;
}
