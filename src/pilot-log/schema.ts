// Pilot Log v1 — DB schema
// 5 張表：pilot_users, pilot_user_emails, pilot_user_sessions,
//         pilot_log_entries, pilot_aircraft

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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pilot_users (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pilot_user_emails (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES pilot_users(id) ON DELETE CASCADE,
        email TEXT NOT NULL UNIQUE,
        is_primary BOOLEAN DEFAULT false,
        linked_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pilot_user_emails_user ON pilot_user_emails(user_id);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pilot_user_sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES pilot_users(id) ON DELETE CASCADE,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        rotated_from UUID REFERENCES pilot_user_sessions(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ DEFAULT NOW(),
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pilot_sessions_user ON pilot_user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_pilot_sessions_hash ON pilot_user_sessions(refresh_token_hash);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pilot_log_entries (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES pilot_users(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('roster','logten','manual')),
        source_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','confirmed','roster_removed')) DEFAULT 'draft',
        flight_date DATE NOT NULL,
        flight_no TEXT,
        origin TEXT,
        dest TEXT,
        aircraft_type TEXT,
        tail_no TEXT,
        position TEXT CHECK (position IN ('PIC','SIC','OBSERVER')),
        pilot_flying BOOLEAN,
        std_utc TIMESTAMPTZ,
        sta_utc TIMESTAMPTZ,
        out_utc TIMESTAMPTZ,
        off_utc TIMESTAMPTZ,
        on_utc TIMESTAMPTZ,
        in_utc TIMESTAMPTZ,
        block_minutes INT,
        air_minutes INT,
        night_minutes INT,
        distance_nm NUMERIC(7,1),
        on_duty_utc TIMESTAMPTZ,
        off_duty_utc TIMESTAMPTZ,
        total_duty_minutes INT,
        crew JSONB,
        approaches JSONB,
        day_takeoffs INT DEFAULT 0,
        night_takeoffs INT DEFAULT 0,
        day_landings INT DEFAULT 0,
        night_landings INT DEFAULT 0,
        autolands INT DEFAULT 0,
        pax_count INT,
        sid TEXT,
        star TEXT,
        remarks TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, source, source_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_pilot_entries_user_date ON pilot_log_entries(user_id, flight_date DESC);
      CREATE INDEX IF NOT EXISTS idx_pilot_entries_status ON pilot_log_entries(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_pilot_entries_type ON pilot_log_entries(user_id, aircraft_type);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pilot_aircraft (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES pilot_users(id) ON DELETE CASCADE,
        tail_no TEXT NOT NULL,
        operator TEXT,
        type_code TEXT,
        make TEXT,
        model TEXT,
        notes TEXT,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, tail_no)
      );
      CREATE INDEX IF NOT EXISTS idx_pilot_aircraft_user ON pilot_aircraft(user_id);
    `);

    _ready = true;
    console.log('✅ Pilot Log tables ready');
    return true;
  } catch (e: any) {
    console.error('❌ Pilot Log schema init error:', e.message);
    return false;
  }
}
