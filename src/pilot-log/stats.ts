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

// V1.3.17：grand total 含「起始累計」(opening balance) —— 過往結轉時數算進總時數。
// sim 自然被排除（無 in_utc）。rolling（7/28/90）不含起始累計（那是歷史，不是近期）。
export async function getTotals(userId: string): Promise<Totals> {
  const pool = getPool();
  if (!pool) return zero();
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(block_minutes), 0)::int                                                AS total_minutes,
       COALESCE(SUM(COALESCE(pic_minutes, CASE WHEN position = 'PIC' THEN block_minutes ELSE 0 END)), 0)::int AS pic_minutes,
       COALESCE(SUM(COALESCE(sic_minutes, CASE WHEN position IN ('SIC','SFO','FO') THEN block_minutes ELSE 0 END)), 0)::int AS sic_minutes,
       COALESCE(SUM(night_minutes), 0)::int                                                AS night_minutes,
       COUNT(*)::int                                                                       AS entry_count
     FROM pilot_log_entries
     WHERE user_id = $1 AND in_utc IS NOT NULL AND status <> 'roster_removed' AND is_deadhead IS NOT TRUE AND needs_completion IS NOT TRUE`,
    [userId]
  );
  const ob = await pool.query(
    `SELECT COALESCE(SUM(total_min),0)::int AS t, COALESCE(SUM(pic_min),0)::int AS p,
            COALESCE(SUM(sic_min),0)::int AS s, COALESCE(SUM(night_min),0)::int AS n
     FROM pilot_opening_balance WHERE user_id = $1`,
    [userId]
  );
  const row = r.rows[0] || {};
  const o = ob.rows[0] || {};
  return {
    total_minutes: (row.total_minutes || 0) + (o.t || 0),
    pic_minutes: (row.pic_minutes || 0) + (o.p || 0),
    sic_minutes: (row.sic_minutes || 0) + (o.s || 0),
    night_minutes: (row.night_minutes || 0) + (o.n || 0),
    entry_count: row.entry_count || 0,   // entry_count = 已記錄航班數（起始累計是時數結轉、不是航班）
  };
}

// 起始累計（per 機型）給顯示用
export async function getOpeningBalance(userId: string): Promise<Array<{ aircraft_type: string; total_minutes: number; pic_minutes: number; sic_minutes: number; night_minutes: number }>> {
  const pool = getPool();
  if (!pool) return [];
  const r = await pool.query(
    `SELECT aircraft_type, total_min, pic_min, sic_min, night_min
     FROM pilot_opening_balance WHERE user_id = $1 ORDER BY total_min DESC`,
    [userId]
  );
  return r.rows.map((x) => ({
    aircraft_type: x.aircraft_type, total_minutes: x.total_min || 0,
    pic_minutes: x.pic_min || 0, sic_minutes: x.sic_min || 0, night_minutes: x.night_min || 0,
  }));
}

// 模擬機時數合計（is_sim entries）給顯示用 —— 完全跟飛行時數分開
export async function getSimTotals(userId: string): Promise<{ sim_minutes: number; sim_count: number }> {
  const pool = getPool();
  if (!pool) return { sim_minutes: 0, sim_count: 0 };
  const r = await pool.query(
    `SELECT COALESCE(SUM(sim_minutes),0)::int AS m, COUNT(*)::int AS c
     FROM pilot_log_entries WHERE user_id = $1 AND is_sim = TRUE AND status <> 'roster_removed'`,
    [userId]
  );
  const row = r.rows[0] || {};
  return { sim_minutes: row.m || 0, sim_count: row.c || 0 };
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
       COALESCE(SUM(COALESCE(sic_minutes, CASE WHEN position IN ('SIC','SFO','FO') THEN block_minutes ELSE 0 END)), 0)::int AS sic_minutes,
       COALESCE(SUM(night_minutes), 0)::int                                                AS night_minutes,
       COUNT(*)::int                                                                       AS entry_count
     FROM pilot_log_entries
     WHERE user_id = $1 AND in_utc IS NOT NULL AND status <> 'roster_removed' AND is_deadhead IS NOT TRUE AND needs_completion IS NOT TRUE
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
     WHERE user_id = $1 AND in_utc IS NOT NULL AND status <> 'roster_removed' AND aircraft_type IS NOT NULL AND is_deadhead IS NOT TRUE AND needs_completion IS NOT TRUE
     GROUP BY aircraft_type
     ORDER BY total_minutes DESC`,
    [userId]
  );
  // V1.3.17：merge 起始累計（only-結轉、沒記錄的機型也會出現，entry_count=0）
  const ob = await pool.query(
    `SELECT aircraft_type, total_min FROM pilot_opening_balance WHERE user_id = $1`, [userId]
  );
  const map = new Map<string, ByTypeRow>();
  for (const row of r.rows) map.set(row.aircraft_type, { aircraft_type: row.aircraft_type, total_minutes: row.total_minutes, entry_count: row.entry_count });
  for (const row of ob.rows) {
    const ex = map.get(row.aircraft_type);
    if (ex) ex.total_minutes += (row.total_min || 0);
    else map.set(row.aircraft_type, { aircraft_type: row.aircraft_type, total_minutes: row.total_min || 0, entry_count: 0 });
  }
  return Array.from(map.values()).sort((a, b) => b.total_minutes - a.total_minutes);
}

function zero(): Totals {
  return { total_minutes: 0, pic_minutes: 0, sic_minutes: 0, night_minutes: 0, entry_count: 0 };
}
