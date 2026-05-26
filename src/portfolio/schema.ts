// Portfolio module v1 — DB schema
// 兩張表 + morning_prefs 加一個 migration flag 欄位

import pg from 'pg';

let _pool: pg.Pool | null = null;
let _ready = false;

export function getPool(): pg.Pool | null {
  if (!_pool && process.env.DATABASE_URL) {
    _pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

export async function ensureTables(): Promise<boolean> {
  if (_ready) return true;
  const pool = getPool();
  if (!pool) return false;

  try {
    // portfolio_transactions — 交易帳本（source of truth）
    // 每筆 buy / sell / dividend_cash / dividend_stock 都是一 row
    // 持倉不存獨立表，從這張表 derive（移動均價 / lot tracking）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portfolio_transactions (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        market TEXT NOT NULL CHECK (market IN ('TW', 'US')),
        txn_date DATE NOT NULL,
        txn_type TEXT NOT NULL CHECK (txn_type IN ('buy', 'sell', 'dividend_cash', 'dividend_stock')),
        qty NUMERIC(20,4) NOT NULL,
        price NUMERIC(20,4),
        cash_amount NUMERIC(20,4),
        fee NUMERIC(20,4) DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto_dividend', 'migration')),
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_portfolio_txn_user_symbol ON portfolio_transactions(user_id, symbol);
      CREATE INDEX IF NOT EXISTS idx_portfolio_txn_user_date ON portfolio_transactions(user_id, txn_date DESC);
    `);

    // dividend_events — 公開資料 cache（公司宣告的除權息事件）
    // 每日 cron 抓 mops / cnyes / yahoo 寫進來，再 auto-credit 給持股 user
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dividend_events (
        symbol TEXT NOT NULL,
        market TEXT NOT NULL CHECK (market IN ('TW', 'US')),
        ex_date DATE NOT NULL,
        pay_date DATE,
        cash_dividend NUMERIC(20,6) DEFAULT 0,
        stock_dividend NUMERIC(20,6) DEFAULT 0,
        cash_tax_rate NUMERIC(5,4) DEFAULT 0,
        source TEXT NOT NULL,
        fetched_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (symbol, market, ex_date)
      );
      CREATE INDEX IF NOT EXISTS idx_dividend_events_ex_date ON dividend_events(ex_date DESC);
    `);

    // morning_prefs 加 portfolio_migrated_at 欄位 — 標記 user 是否已從舊 holdings 模型 migrate 過
    // NULL = 沒 migrate；timestamp = 已 migrate（idempotent，避免重跑）
    await pool.query(`ALTER TABLE morning_prefs ADD COLUMN IF NOT EXISTS portfolio_migrated_at TIMESTAMPTZ`).catch(() => {});

    // portfolio_snapshots — 每日 portfolio 總值 snapshot (V1.0.5)
    // 給資產變化圖用，daily cron 跑一次 insert 當天 snapshot
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        user_id TEXT NOT NULL,
        snapshot_date DATE NOT NULL,
        total_value NUMERIC(20,2) NOT NULL DEFAULT 0,
        total_cost NUMERIC(20,2) NOT NULL DEFAULT 0,
        total_realized NUMERIC(20,2) NOT NULL DEFAULT 0,
        total_dividend NUMERIC(20,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, snapshot_date)
      );
      CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_user_date
        ON portfolio_snapshots(user_id, snapshot_date DESC);
    `);

    _ready = true;
    console.log('✅ Portfolio tables ready');
    return true;
  } catch (e: any) {
    console.error('❌ Portfolio schema init error:', e.message);
    return false;
  }
}
