// Pilot Log — Wader logbook CSV 匯入（V1.3.17）
//
// Wader 匯出是乾淨的逗號 CSV，欄位齊全（OOOI、block/PIC/SIC/night 時數=分鐘、起降、組員、角色）。
// 一份檔內三種列：
//   - isPreviousExperience=true → 過往結轉（無單筆航班）→ 寫進 pilot_opening_balance（per 機型）
//   - isSimulator=true          → 模擬機 → entry 標 is_sim、存 sim_type/sim_minutes（不算飛行時數）
//   - 其餘                       → 真實航班 entry（含 OOOI UTC 時戳，status=confirmed）
//
// 時間：Wader 的 OOOI（startTime/takeoffTime/landingTime/parkingTime）是 UTC 的 HH:MM，
//       跟 flightDate 組出 UTC 時戳，跨午夜自動 +1 天。時數欄（totalTime 等）單位是分鐘。

import { randomUUID } from 'crypto';
import { getPool, ensureTables } from './schema.js';

export interface ImportWaderResult {
  imported_flights: number;
  imported_sims: number;
  opening_types: number;
  duplicate_skipped: number;
  parse_errors: number;
  bad_rows?: Array<{ row: number; reason: string }>;
  dry_run: boolean;
  error?: string;
}

// ── CSV 解析（含引號欄位、"" 跳脫）────────────────────────────────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      /* skip */
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function int0(v: string | undefined): number {
  const n = parseInt(String(v ?? '').trim(), 10);
  return isNaN(n) ? 0 : n;
}
function truthy(v: string | undefined): boolean {
  return String(v ?? '').trim().toLowerCase() === 'true';
}

// flightDate(YYYY-MM-DD) + UTC HH:MM → Date；after 提供時若早於它就 +1 天（跨午夜）
function utcAt(date: string, hhmm: string | undefined, after?: Date | null): Date | null {
  if (!date) return null;
  const m = String(hhmm ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let d = new Date(`${date}T${m[1].padStart(2, '0')}:${m[2]}:00Z`);
  if (isNaN(d.getTime())) return null;
  if (after && d.getTime() < after.getTime()) d = new Date(d.getTime() + 24 * 3600 * 1000);
  return d;
}

const WADER_REQUIRED = ['flightDate', 'aircraftType']; // 最低限度；逐列再各自判斷類型

export async function importWader(
  userId: string,
  csvText: string,
  opts: { dryRun?: boolean } = {}
): Promise<ImportWaderResult> {
  const result: ImportWaderResult = {
    imported_flights: 0, imported_sims: 0, opening_types: 0,
    duplicate_skipped: 0, parse_errors: 0, bad_rows: [], dry_run: !!opts.dryRun,
  };

  const pool = getPool();
  if (!pool || !(await ensureTables())) { result.error = 'database_unavailable'; return result; }

  const grid = parseCsv(csvText.replace(/^﻿/, ''));
  if (grid.length < 2) { result.error = 'empty_or_no_rows'; return result; }
  const headers = grid[0].map((h) => h.trim());
  for (const req of WADER_REQUIRED) {
    if (headers.indexOf(req) < 0) { result.error = `missing_required_columns:${req}`; return result; }
  }
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const get = (cols: string[], key: string): string => {
    const i = idx[key];
    return i == null ? '' : String(cols[i] ?? '').trim();
  };

  // 既有 wader source_ref（去重）
  const existing = new Set<string>();
  {
    const r = await pool.query(
      `SELECT source_ref FROM pilot_log_entries WHERE user_id = $1 AND source = 'wader'`, [userId]
    );
    for (const row of r.rows) existing.add(row.source_ref);
  }

  // 本人員編對映（給 position 推斷 / crew 用，目前 Wader 用 'SELF' 標本人，足夠）
  const flightInserts: any[][] = [];
  const simInserts: any[][] = [];
  const openings: Array<{ type: string; row: string[] }> = [];

  for (let r = 1; r < grid.length; r++) {
    const cols = grid[r];
    if (!cols || cols.length === 0 || cols.every((c) => !String(c).trim())) continue;
    try {
      if (truthy(get(cols, 'isPreviousExperience'))) {
        const type = get(cols, 'aircraftType');
        if (type) openings.push({ type, row: cols });
        continue;
      }

      const isSim = truthy(get(cols, 'isSimulator'));
      const date = get(cols, 'flightDate');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        result.bad_rows!.push({ row: r + 1, reason: 'invalid_or_missing_flightDate' });
        result.parse_errors++;
        continue;
      }
      const acType = get(cols, 'aircraftType');

      // 組員：pilotName1~4 去掉 'SELF'/空 → crew2/3/4
      const crew: Record<string, any> = {};
      const others: string[] = [];
      for (const k of ['pilotName1', 'pilotName2', 'pilotName3', 'pilotName4']) {
        const nm = get(cols, k);
        if (nm && nm.toUpperCase() !== 'SELF') others.push(nm);
      }
      ['crew2', 'crew3', 'crew4'].forEach((slot, i) => { if (others[i]) crew[slot] = { name: others[i], rank: '', eid: '' }; });
      const crewJson = Object.keys(crew).length ? JSON.stringify(crew) : null;
      const remarks = get(cols, 'remarks') || null;

      if (isSim) {
        const simType = get(cols, 'simType') || null;
        const simMin = int0(get(cols, 'simTrainerTime')) || int0(get(cols, 'simTraineeTime')) || int0(get(cols, 'totalTime'));
        // codex P2：用穩定 key（不含 CSV 列號），否則重匯時順序不同會被當新筆、重複塞。
        // date + simType + remarks（sim 事件名，如 PreADV/ETLP）+ 時數，足以唯一識別一場 sim。
        const sourceRef = `wader-sim:${date}:${simType || ''}:${(remarks || '').slice(0, 40)}:${simMin}`;
        if (existing.has(sourceRef)) { result.duplicate_skipped++; continue; }
        // is_sim entry：無起降地、不算飛行時數
        simInserts.push([
          randomUUID(), userId, 'wader', sourceRef, 'confirmed', date, acType,
          crewJson, true, simType, simMin, remarks,
        ]);
        result.imported_sims++;
        continue;
      }

      // ── 真實航班 ──
      const flightNo = get(cols, 'flightNumber') || null;
      const origin = get(cols, 'depAirport') || null;
      const dest = get(cols, 'arrAirport') || null;
      const tail = get(cols, 'aircraftTailnumber') || null;
      const outUtc = utcAt(date, get(cols, 'startTime'));
      const offUtc = utcAt(date, get(cols, 'takeoffTime'), outUtc);
      const onUtc = utcAt(date, get(cols, 'landingTime'), offUtc || outUtc);
      const inUtc = utcAt(date, get(cols, 'parkingTime'), onUtc || offUtc || outUtc);
      const blockMin = int0(get(cols, 'totalTime')) || null;
      const airMin = (offUtc && onUtc) ? Math.round((onUtc.getTime() - offUtc.getTime()) / 60000) : null;
      const picMin = int0(get(cols, 'picTime')) || null;
      const sicMin = int0(get(cols, 'sicTime')) || null;
      const nightMin = int0(get(cols, 'nightTime')) || null;
      const fn = get(cols, 'function').toUpperCase();
      const position = fn.indexOf('PIC') === 0 ? 'PIC' : (fn.indexOf('SIC') === 0 ? 'SIC' : null);
      const at = get(cols, 'approachType');
      const approaches = at ? JSON.stringify([{ type: at }]) : null;
      const sid = get(cols, 'depProcedure') || null;   // SID
      const star = get(cols, 'arrProcedure') || null;  // STAR
      // 跑道 / transition / threats / notes 沒專屬欄 → folding 進 remarks，不漏資料
      const rp: string[] = [];
      if (remarks) rp.push(remarks);
      const dRwy = get(cols, 'depRunway'), aRwy = get(cols, 'arrRunway');
      if (dRwy || aRwy) rp.push(`RWY ${dRwy || '?'}→${aRwy || '?'}`);
      const dTr = get(cols, 'depTransition'), aTr = get(cols, 'arrTransition');
      if (dTr) rp.push(`SID TRANS ${dTr}`);
      if (aTr) rp.push(`STAR TRANS ${aTr}`);
      for (const x of [get(cols, 'depNotes'), get(cols, 'arrNotes'), get(cols, 'depThreats'), get(cols, 'arrThreats')]) {
        if (x) rp.push(x);
      }
      const flightRemarks = rp.length ? rp.join(' · ') : null;

      const sourceRef = `wader:${date}:${flightNo || ''}:${origin || ''}:${dest || ''}:${get(cols, 'startTime')}`;
      if (existing.has(sourceRef)) { result.duplicate_skipped++; continue; }
      existing.add(sourceRef);

      flightInserts.push([
        randomUUID(), userId, 'wader', sourceRef, 'confirmed', date, flightNo, origin, dest,
        acType, tail, position, outUtc, offUtc, onUtc, inUtc,
        blockMin, airMin, nightMin, picMin, sicMin,
        int0(get(cols, 'dayTakeoffs')), int0(get(cols, 'nightTakeoffs')),
        int0(get(cols, 'dayLandings')), int0(get(cols, 'nightLandings')),
        crewJson, approaches, sid, star, flightRemarks,
      ]);
      result.imported_flights++;
    } catch (e: any) {
      result.parse_errors++;
      result.bad_rows!.push({ row: r + 1, reason: e?.message || 'parse_error' });
    }
  }

  if (opts.dryRun) {
    result.opening_types = openings.length;
    return result;
  }

  // ── 寫入 ──────────────────────────────────────────────────────────────────
  // 真實航班
  for (const p of flightInserts) {
    try {
      await pool.query(
        `INSERT INTO pilot_log_entries
           (id, user_id, source, source_ref, status, flight_date, flight_no, origin, dest,
            aircraft_type, tail_no, position, out_utc, off_utc, on_utc, in_utc,
            block_minutes, air_minutes, night_minutes, pic_minutes, sic_minutes,
            day_takeoffs, night_takeoffs, day_landings, night_landings,
            crew, approaches, sid, star, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27::jsonb,$28,$29,$30)
         ON CONFLICT (user_id, source, source_ref) DO NOTHING`,
        p
      );
    } catch (e: any) { result.parse_errors++; }
  }
  // 模擬機
  for (const p of simInserts) {
    try {
      await pool.query(
        `INSERT INTO pilot_log_entries
           (id, user_id, source, source_ref, status, flight_date, aircraft_type,
            crew, is_sim, sim_type, sim_minutes, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
         ON CONFLICT (user_id, source, source_ref) DO NOTHING`,
        p
      );
    } catch (e: any) { result.parse_errors++; }
  }
  // 起始累計（per 機型 upsert）
  for (const o of openings) {
    const c = o.row;
    try {
      await pool.query(
        `INSERT INTO pilot_opening_balance
           (user_id, aircraft_type, total_min, pic_min, sic_min, night_min, day_to, night_to, day_ldg, night_ldg, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'wader',NOW())
         ON CONFLICT (user_id, aircraft_type) DO UPDATE SET
           total_min = EXCLUDED.total_min, pic_min = EXCLUDED.pic_min, sic_min = EXCLUDED.sic_min,
           night_min = EXCLUDED.night_min, day_to = EXCLUDED.day_to, night_to = EXCLUDED.night_to,
           day_ldg = EXCLUDED.day_ldg, night_ldg = EXCLUDED.night_ldg, updated_at = NOW()`,
        [
          userId, o.type, int0(get(c, 'totalTime')), int0(get(c, 'picTime')), int0(get(c, 'sicTime')),
          int0(get(c, 'nightTime')), int0(get(c, 'dayTakeoffs')), int0(get(c, 'nightTakeoffs')),
          int0(get(c, 'dayLandings')), int0(get(c, 'nightLandings')),
        ]
      );
      result.opening_types++;
    } catch (e: any) { result.parse_errors++; }
  }

  return result;
}
