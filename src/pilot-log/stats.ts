// Pilot Log v1 — Stats (minimal)
// 只放最基本 helper，避免做成半套統計模組。
// v2 才做：起降 currency (Day/Night, FAA 90-day vs EASA 規則)、圖表、年度趨勢。

import { getPool } from './schema.js';

export interface Totals {
  total_minutes: number;
  pic_minutes: number;
  sic_minutes: number;
  night_minutes: number;
  entry_count: number;
}

export async function getTotals(userId: string): Promise<Totals> {
  const pool = getPool();
  if (!pool) return zero();
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(block_minutes), 0)::int                                                AS total_minutes,
       COALESCE(SUM(COALESCE(pic_minutes, CASE WHEN position = 'PIC' THEN block_minutes ELSE 0 END)), 0)::int AS pic_minutes,
       COALESCE(SUM(COALESCE(sic_minutes, CASE WHEN position = 'SIC' THEN block_minutes ELSE 0 END)), 0)::int AS sic_minutes,
       COALESCE(SUM(night_minutes), 0)::int                                                AS night_minutes,
       COUNT(*)::int                                                                       AS entry_count
     FROM pilot_log_entries
     WHERE user_id = $1 AND flight_date <= CURRENT_DATE AND status <> 'roster_removed' AND is_deadhead IS NOT TRUE`,
    [userId]
  );
  const row = r.rows[0] || {};
  return {
    total_minutes: row.total_minutes || 0,
    pic_minutes: row.pic_minutes || 0,
    sic_minutes: row.sic_minutes || 0,
    night_minutes: row.night_minutes || 0,
    entry_count: row.entry_count || 0,
  };
}

/**
 * 7 / 28 / 90 day rolling 純加總，不做 currency 計算。
 */
export async function getRollingTotals(userId: string): Promise<{ d7: Totals; d28: Totals; d90: Totals }> {
  return {
    d7: await rolling(userId, 7),
    d28: await rolling(userId, 28),
    d90: await rolling(userId, 90),
  };
}

async function rolling(userId: string, days: number): Promise<Totals> {
  const pool = getPool();
  if (!pool) return zero();
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(block_minutes), 0)::int                                                AS total_minutes,
       COALESCE(SUM(COALESCE(pic_minutes, CASE WHEN position = 'PIC' THEN block_minutes ELSE 0 END)), 0)::int AS pic_minutes,
       COALESCE(SUM(COALESCE(sic_minutes, CASE WHEN position = 'SIC' THEN block_minutes ELSE 0 END)), 0)::int AS sic_minutes,
       COALESCE(SUM(night_minutes), 0)::int                                                AS night_minutes,
       COUNT(*)::int                                                                       AS entry_count
     FROM pilot_log_entries
     WHERE user_id = $1 AND flight_date <= CURRENT_DATE AND status <> 'roster_removed' AND is_deadhead IS NOT TRUE
       AND flight_date >= CURRENT_DATE - ($2::int - 1)`,
    [userId, days]
  );
  const row = r.rows[0] || {};
  return {
    total_minutes: row.total_minutes || 0,
    pic_minutes: row.pic_minutes || 0,
    sic_minutes: row.sic_minutes || 0,
    night_minutes: row.night_minutes || 0,
    entry_count: row.entry_count || 0,
  };
}

export interface ByTypeRow {
  aircraft_type: string;
  total_minutes: number;
  entry_count: number;
}

export async function getByAircraftType(userId: string): Promise<ByTypeRow[]> {
  const pool = getPool();
  if (!pool) return [];
  const r = await pool.query(
    `SELECT aircraft_type,
            COALESCE(SUM(block_minutes), 0)::int AS total_minutes,
            COUNT(*)::int                         AS entry_count
     FROM pilot_log_entries
     WHERE user_id = $1 AND flight_date <= CURRENT_DATE AND status <> 'roster_removed' AND aircraft_type IS NOT NULL AND is_deadhead IS NOT TRUE
     GROUP BY aircraft_type
     ORDER BY total_minutes DESC`,
    [userId]
  );
  return r.rows.map(row => ({
    aircraft_type: row.aircraft_type,
    total_minutes: row.total_minutes,
    entry_count: row.entry_count,
  }));
}

function zero(): Totals {
  return { total_minutes: 0, pic_minutes: 0, sic_minutes: 0, night_minutes: 0, entry_count: 0 };
}
