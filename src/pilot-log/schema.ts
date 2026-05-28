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
    // V1.0.05 monitoring：active user / 重 import 偵測欄位
    await pool.query(`ALTER TABLE pilot_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE pilot_users ADD COLUMN IF NOT EXISTS last_import_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pilot_users_last_seen ON pilot_users(last_seen_at DESC NULLS LAST)`).catch(() => {});

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
    // V1.2.04：LogTen 實際 PIC/SIC 時數欄。之前統計用 position × block 反推，但 LogTen 的
    // PIC/SIC 是各自獨立的實際時數（加總 < 總時間 — 因為 deadhead/加強組員巡航等既非 P1 也非 P2），
    // 反推會把整段 block 灌進單一角色而對不上。改成直接存 LogTen 的值。
    await pool.query(`ALTER TABLE pilot_log_entries ADD COLUMN IF NOT EXISTS pic_minutes INT`).catch(() => {});
    await pool.query(`ALTER TABLE pilot_log_entries ADD COLUMN IF NOT EXISTS sic_minutes INT`).catch(() => {});
    // V1.2.05：deadhead / positioning 標記。LogTen 多數匯出不帶此欄，主要靠 editor 手動標，
    // 讓「飛行」跟「deadhead」能區分（deadhead 不算 PIC/SIC、不算起降 currency）。
    await pool.query(`ALTER TABLE pilot_log_entries ADD COLUMN IF NOT EXISTS is_deadhead BOOLEAN DEFAULT FALSE`).catch(() => {});

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

    // ── Aircraft Types（V1.0.11；LogTen Aircraft Types export 對應）─────────────
    // 跟 pilot_aircraft（tail 為主）區分：這張表是 type 為主、無 tail。
    // 用來把 A359 這種代碼對應到完整廠商機型 (Airbus A-350-900)，
    // 之後 Aircraft 列表 / drill-down 顯示完整名用。
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pilot_aircraft_types (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES pilot_users(id) ON DELETE CASCADE,
        type_code TEXT NOT NULL,
        make TEXT,
        model TEXT,
        engine_type TEXT,
        category TEXT,
        class TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, type_code)
      );
      CREATE INDEX IF NOT EXISTS idx_pilot_aircraft_types_user ON pilot_aircraft_types(user_id);
    `);

    // ── Crew 名單（V1.0.09；含 pilot + cabin crew，不掛 pilot_ prefix）──────────
    // 設計重點：employee_id 為主識別、display_name 只當顯示與弱比對 fallback。
    // 換公司會有多個 ID（例如 "2214780/B79363"），所以 ID 拆出去獨立成 alias 表，
    // 同一人可掛多 ID，每 ID 在 user 範圍內唯一。
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crew (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES pilot_users(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        organization TEXT,
        comment TEXT,
        is_self BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_crew_user ON crew(user_id);
      CREATE INDEX IF NOT EXISTS idx_crew_user_name ON crew(user_id, display_name);
    `);

    // crew_employee_ids: 一個 crew 可掛多個 employee_id（換公司情境）
    // user_id 故意 denormalize → 跨 row UNIQUE 限制：同一個 user 的 address book 內，
    // 任何 employee_id 都只能掛在一個 crew 上，避免 import 後跨人混淆
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crew_employee_ids (
        id SERIAL PRIMARY KEY,
        crew_id UUID NOT NULL REFERENCES crew(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES pilot_users(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, employee_id)
      );
      CREATE INDEX IF NOT EXISTS idx_crew_eid_crew ON crew_employee_ids(crew_id);
    `);

    // ── DB 用量歷史快照（V1.2.07）──────────────────────────────────────────────
    // 全域（非 per-user）：定期記錄整庫 / pilot-log / 餐廳+其他 的大小，
    // 之後拿「今天 vs N 天前」算成長速度、推估多久到 1GB。
    // 寫入時機：伺服器啟動 + 每 6h 自動檢查（距上一筆 > 20h 才插一筆），
    //          不靠任何人開後台 → 見 startPilotLogSnapshotCron()。
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pilot_db_size_history (
        id SERIAL PRIMARY KEY,
        captured_at TIMESTAMPTZ DEFAULT NOW(),
        db_total_bytes BIGINT NOT NULL,
        pilot_log_bytes BIGINT NOT NULL,
        restaurant_etc_bytes BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pdsh_captured ON pilot_db_size_history(captured_at);
    `);

    _ready = true;
    console.log('✅ Pilot Log tables ready');
    return true;
  } catch (e: any) {
    console.error('❌ Pilot Log schema init error:', e.message);
    return false;
  }
}

// ── DB 用量快照（V1.2.07）─────────────────────────────────────────────────────
// pilot-log 自有表清單 = 單一事實來源：admin size 統計 + 快照「pilot-log 用量」都用這份。
// ⚠️ 新增 pilot-log 表時務必同步補進來（漏一張 → 那張的量會被算成「餐廳+其他」）。
export const PILOT_LOG_TABLES: readonly string[] = [
  'pilot_users', 'pilot_user_emails', 'pilot_user_sessions', 'pilot_log_entries',
  'pilot_aircraft', 'pilot_aircraft_types', 'crew', 'crew_employee_ids',
  'pilot_db_size_history',
];

const SNAP_GAP_MS = 20 * 3600 * 1000;

// 距上一筆 > minGap 才插一筆快照（避免重複）。回傳是否真的插入。永不 throw。
export async function insertDbSizeSnapshotIfDue(
  dbTotalBytes: number, pilotLogBytes: number, restaurantEtcBytes: number,
  minGapMs: number = SNAP_GAP_MS
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const last = (await pool.query(
      `SELECT captured_at FROM pilot_db_size_history ORDER BY captured_at DESC LIMIT 1`
    )).rows[0];
    if (last && (Date.now() - new Date(last.captured_at).getTime()) <= minGapMs) return false;
    await pool.query(
      `INSERT INTO pilot_db_size_history (db_total_bytes, pilot_log_bytes, restaurant_etc_bytes)
       VALUES ($1, $2, $3)`,
      [dbTotalBytes, pilotLogBytes, restaurantEtcBytes]
    );
    return true;
  } catch (e: any) {
    console.error('[pilot-log] snapshot insert error:', e.message);
    return false;
  }
}

// 自己算整庫 / pilot-log / 餐廳+其他 大小後，距上一筆夠久就記一筆。給排程用。永不 throw。
export async function recordDbSizeSnapshotIfDue(minGapMs: number = SNAP_GAP_MS): Promise<boolean> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return false;
  try {
    const dbRow = await pool.query(`SELECT pg_database_size(current_database())::bigint AS bytes`);
    const dbTotalBytes = Number(dbRow.rows[0].bytes);
    let pilotLogBytes = 0;
    for (const t of PILOT_LOG_TABLES) {
      const r = await pool.query(`SELECT pg_total_relation_size($1::regclass)::bigint AS b`, [t]);
      pilotLogBytes += Number(r.rows[0].b);
    }
    return await insertDbSizeSnapshotIfDue(dbTotalBytes, pilotLogBytes, dbTotalBytes - pilotLogBytes, minGapMs);
  } catch (e: any) {
    console.error('[pilot-log] snapshot record error:', e.message);
    return false;
  }
}

// 伺服器啟動 30s 後記一次 + 每 6h 自動檢查（20h gap 去重）→ 不靠任何人開後台，每天都有一筆。
export function startPilotLogSnapshotCron(): void {
  const SIX_H = 6 * 3600 * 1000;
  setTimeout(() => { recordDbSizeSnapshotIfDue().catch(() => {}); }, 30 * 1000);
  setInterval(() => { recordDbSizeSnapshotIfDue().catch(() => {}); }, SIX_H);
  console.log('🕒 Pilot Log DB-size snapshot cron started (startup + every 6h)');
}
