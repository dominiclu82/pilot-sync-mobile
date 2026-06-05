// Pilot Log — LogATP 2 匯入（CSV）
//
// 對應規則（跟使用者逐項確認過）：
//   - OOOI（Out/Off/On/In）視為 UTC；跨日（後一個時間比前一個小）自動 +1 天
//   - Night Time / Total Block Time / Total Flight Time = HH:MM 時長
//   - PF Takeoff / PF Landing（TRUE/FALSE）→ 起飛/落地各 1 次；日/夜看該航班有無夜航
//   - PIC（TRUE/FALSE）→ TRUE 當 PIC、FALSE 當 SIC；時數用 block
//   - Autoland / Go around / Diverted（TRUE/FALSE）→ autolands / remarks
//   - Crew 1~4 → pic/crew2/crew3/crew4（清理頭尾與雙空格）
//   - 機尾：比對去破折號；存成 B-xxxxx（formatTail）；同步進機尾庫不重複
//   - 班號：原樣存（代碼＋前導零都留）；若沒代碼 → 用機尾反查補 IATA 代碼，查不到留原樣
//   - 防重：同檔/重匯用 source_ref=`logatp:<Object ID>`；跨來源用 (日期+起降+正規化班號)

import { randomUUID } from 'crypto';
import { getPool, ensureTables } from './schema.js';
import { airlineCodeFromTail, tailLookup, formatTail, normTailKey, normFlightNoKey } from './tw-fleet.js';

// ── CSV 解析（state machine：去 BOM、容忍引號內逗號＋換行）──────────────────
// codex deep：1) 去 UTF-8 BOM（試算表匯出常帶）2) 不可先切行 —— 引號內含換行的欄位
//   要當同一欄，整份用狀態機掃過去（比照 LogTen/Wader 之前修過的同類問題）。
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const s = String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records: string[][] = [];
  let field = '', row: string[] = [], inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') { inQ = true; }
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); records.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); records.push(row); }   // 收尾最後一列
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r++) {
    const cells = records[r];
    if (cells.every((c) => !String(c == null ? '' : c).trim())) continue;    // 整列空 → 跳過
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = (cells[c] == null ? '' : cells[c]).trim();
    rows.push(obj);
  }
  return { headers, rows };
}

// ── 小工具 ───────────────────────────────────────────────────────────────────
function cleanName(s: string): string { return String(s || '').replace(/\s+/g, ' ').trim(); }
function isTrue(s: string): boolean { return String(s || '').trim().toUpperCase() === 'TRUE'; }

// HH:MM 在某日 → UTC Date；跨日：比 prev 早就 +1 天
function parseHmAtDate(dateStr: string, hm: string, prevUtc?: Date | null): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const m = String(hm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  let d = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${m[2]}:00Z`);
  if (isNaN(d.getTime())) return null;
  if (prevUtc && d.getTime() < prevUtc.getTime()) d = new Date(d.getTime() + 24 * 3600 * 1000);
  return d;
}
// "12:38" → 758（分）
function hmToMin(s: string): number | null {
  const m = String(s || '').trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[2], 10);
  if (mm > 59) return null;
  return parseInt(m[1], 10) * 60 + mm;
}

// 班號：原樣存（代碼＋前導零都留）；沒代碼（純數字）→ 用機尾反查補 IATA 代碼，查不到留原樣
function resolveFlightNo(raw: string, tail: string): string {
  const fn = String(raw || '').trim().toUpperCase();
  if (!fn) return fn;
  if (/^[A-Z]/.test(fn)) return fn;          // 已有航空字母代碼 → 原樣
  const code = airlineCodeFromTail(tail);    // 沒代碼 → 機尾反查
  return code ? code + fn : fn;              // 查不到 → 留原樣（代碼空白）
}

const INSERT_COLS = [
  'id', 'user_id', 'source', 'source_ref', 'status',
  'flight_date', 'flight_no', 'origin', 'dest',
  'aircraft_type', 'tail_no',
  'std_utc', 'sta_utc', 'out_utc', 'off_utc', 'on_utc', 'in_utc',
  'block_minutes', 'air_minutes', 'night_minutes', 'distance_nm',
  'on_duty_utc', 'off_duty_utc', 'total_duty_minutes',
  'crew', 'approaches',
  'day_takeoffs', 'night_takeoffs', 'day_landings', 'night_landings', 'autolands',
  'pax_count', 'sid', 'star', 'remarks',
  'position', 'pic_minutes', 'sic_minutes', 'is_deadhead', 'pilot_flying',
];
const INSERT_N = INSERT_COLS.length;
const JSONB_IDX = new Set([INSERT_COLS.indexOf('crew'), INSERT_COLS.indexOf('approaches')]);
const INSERT_BATCH = 50;

function buildBulkInsertSQL(rowCount: number): string {
  const ph: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const one: string[] = [];
    for (let c = 0; c < INSERT_N; c++) { const num = r * INSERT_N + c + 1; one.push(JSONB_IDX.has(c) ? `$${num}::jsonb` : `$${num}`); }
    ph.push(`(${one.join(',')})`);
  }
  return `INSERT INTO pilot_log_entries (${INSERT_COLS.join(',')}) VALUES ${ph.join(',')}`;
}

export interface ImportLogatpResult {
  inserted: number;
  updated: number;
  duplicate_skipped: number;        // 命中既有 confirmed（同檔重匯，或跨來源同班）→ 不動
  cross_source_skipped: number;     // 跨來源（已有 logten/roster 同班）跳過
  code_backfilled: number;          // 沒代碼 → 用機尾補上 IATA 代碼的筆數
  parse_errors: number;
  preview?: Array<{
    flight_date: string; flight_no: string; flight_no_raw: string; origin: string; dest: string;
    aircraft_type: string; tail_no: string;
    out_utc: string | null; in_utc: string | null;
    block: string | null; night: string | null; position: string | null;
    crew: string[];
    action: 'insert' | 'update' | 'skip_confirmed' | 'skip_cross_source';
  }>;
  error?: string;
  dry_run?: boolean;
}

const REQUIRED = ['Flight Date', 'Departure', 'Destination'];

export async function importLogatp(
  userId: string,
  text: string,
  opts: { dryRun?: boolean } = {}
): Promise<ImportLogatpResult> {
  const empty: ImportLogatpResult = {
    inserted: 0, updated: 0, duplicate_skipped: 0, cross_source_skipped: 0,
    code_backfilled: 0, parse_errors: 0,
  };
  const pool = getPool();
  if (!pool || !(await ensureTables())) return { ...empty, error: 'database_unavailable' };

  const { headers, rows } = parseCsv(text);
  if (!headers.length) return { ...empty, error: 'empty_or_invalid_file' };
  const missing = REQUIRED.filter((r) => !headers.includes(r));
  if (missing.length) return { ...empty, error: `missing_required_columns:${missing.join(',')}` };

  const result: ImportLogatpResult = { ...empty, preview: [], dry_run: !!opts.dryRun };

  // 既有資料：1) 本來源 source_ref → 重匯判斷  2) 全部 (date|orig|dest|正規化班號) → 跨來源防重
  const existingLogatp = new Map<string, { id: string; status: string }>();
  const crossKey = new Map<string, { source: string; status: string }>();
  {
    const r = await pool.query(
      `SELECT id, source, source_ref, status, flight_date, origin, dest, flight_no
       FROM pilot_log_entries WHERE user_id = $1`,
      [userId]
    );
    for (const e of r.rows) {
      if (e.source === 'logatp' && e.source_ref) existingLogatp.set(e.source_ref, { id: e.id, status: e.status });
      const d = e.flight_date instanceof Date ? e.flight_date.toISOString().slice(0, 10) : String(e.flight_date || '').slice(0, 10);
      const key = `${d}|${(e.origin || '').toUpperCase()}|${(e.dest || '').toUpperCase()}|${normFlightNoKey(e.flight_no)}`;
      // 只記非 logatp 的當「別來源既有」；同 key 多筆時保留 confirmed 優先
      if (e.source !== 'logatp') {
        const prev = crossKey.get(key);
        if (!prev || (prev.status !== 'confirmed' && e.status === 'confirmed')) crossKey.set(key, { source: e.source, status: e.status });
      }
    }
  }

  const insertBatch: any[][] = [];
  const updateBatch: Array<{ id: string; params: any[] }> = [];
  const aircraftUpsert = new Map<string, { type: string; operator: string | null }>();   // tail(B-xxxxx) → 機尾庫

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const date = (row['Flight Date'] || '').trim();
      const origin = (row['Departure'] || '').trim().toUpperCase();
      const dest = (row['Destination'] || '').trim().toUpperCase();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !origin || !dest) { result.parse_errors++; continue; }

      const tailRaw = row['Aircraft Registration'] || '';
      const tail = formatTail(tailRaw);                                  // 存：B-xxxxx
      const fnRaw = row['Flight Number'] || '';
      const flightNo = resolveFlightNo(fnRaw, tailRaw);                  // 存：帶代碼、原樣
      if (flightNo && !/^[A-Z]/.test(String(fnRaw).trim().toUpperCase()) && /^[A-Z]/.test(flightNo)) result.code_backfilled++;

      const acType = (row['Aircraft Type'] || '').trim().toUpperCase();

      const outUtc = parseHmAtDate(date, row['Out time']);
      const offUtc = parseHmAtDate(date, row['Off time'], outUtc);
      const onUtc = parseHmAtDate(date, row['On time'], offUtc || outUtc);
      const inUtc = parseHmAtDate(date, row['In time'], onUtc || offUtc || outUtc);

      const blockMin = hmToMin(row['Total Block Time']);
      const airMin = hmToMin(row['Total Flight Time']);
      const nightMin = hmToMin(row['Night Time']);
      const hasNight = (nightMin || 0) > 0;

      // 起降：PF 才算 1；日/夜看該航班有無夜航（使用者確認的簡化規則，之後可手動改）
      const pfTO = isTrue(row['PF Takeoff']);
      const pfLdg = isTrue(row['PF Landing']);
      const dayTO = pfTO && !hasNight ? 1 : 0;
      const nightTO = pfTO && hasNight ? 1 : 0;
      const dayLdg = pfLdg && !hasNight ? 1 : 0;
      const nightLdg = pfLdg && hasNight ? 1 : 0;
      const autolands = isTrue(row['Autoland']) ? 1 : 0;
      const isPF = pfTO || pfLdg;

      // PIC TRUE→PIC、FALSE→SIC；時數用 block
      const isPic = isTrue(row['PIC']);
      const position = isPic ? 'PIC' : 'SIC';
      const picMin = isPic ? blockMin : null;
      const sicMin = isPic ? null : blockMin;

      // Crew 1~4 → pic/crew2/crew3/crew4（清理空白）
      const crew: Record<string, string> = {};
      const slots = ['pic', 'crew2', 'crew3', 'crew4'];
      for (let ci = 0; ci < 4; ci++) {
        const nm = cleanName(row[`Crew ${ci + 1}`]);
        if (nm) crew[slots[ci]] = nm;
      }

      // Diverted / Go around → remarks
      const notes: string[] = [];
      if (isTrue(row['Diverted'])) notes.push('Diverted');
      if (isTrue(row['Go around'])) notes.push('Go-around');
      const remarks = notes.length ? notes.join('; ') : null;

      const status: 'draft' | 'confirmed' = 'confirmed';   // LogATP 都是已飛的歷史
      const objId = (row['Object ID'] || '').trim();
      // codex P1：Object ID 缺失（非典型匯出）→ fallback 要夠細，含 Out 時間 + 列序，避免同日同航線多段塌成一筆。
      const sourceRef = objId
        ? `logatp:${objId}`
        : `logatp:${date}:${origin}:${dest}:${flightNo}:${String(row['Out time'] || '').replace(/\D/g, '')}:${i}`;

      // 跨來源防重：同 (日期|起降|正規化班號) 已有別來源紀錄 → 跳過。
      // codex P1：班號空白時「日期+航線」太粗（會誤殺接駁/訓練航段）→ 班號空就「不做」跨來源比對。
      const fnKey = normFlightNoKey(flightNo);
      const cross = fnKey ? (crossKey.get(`${date}|${origin}|${dest}|${fnKey}`) || null) : null;

      const existing = existingLogatp.get(sourceRef);
      let action: 'insert' | 'update' | 'skip_confirmed' | 'skip_cross_source';
      let decidedId: string;
      if (existing) {
        // 重匯本來源：confirmed 保護（skip）；否則更新
        if (existing.status === 'confirmed') { action = 'skip_confirmed'; decidedId = existing.id; }
        else { action = 'update'; decidedId = existing.id; }
      } else if (cross) {
        action = 'skip_cross_source'; decidedId = '';
      } else {
        action = 'insert'; decidedId = randomUUID();
      }

      result.preview!.push({
        flight_date: date, flight_no: flightNo, flight_no_raw: fnRaw, origin, dest,
        aircraft_type: acType, tail_no: tail,
        out_utc: outUtc ? outUtc.toISOString() : null, in_utc: inUtc ? inUtc.toISOString() : null,
        block: blockMin != null ? `${Math.floor(blockMin / 60)}:${String(blockMin % 60).padStart(2, '0')}` : null,
        night: nightMin != null ? `${Math.floor(nightMin / 60)}:${String(nightMin % 60).padStart(2, '0')}` : null,
        position, crew: Object.values(crew), action,
      });

      if (action === 'skip_confirmed') { result.duplicate_skipped++; continue; }
      if (action === 'skip_cross_source') { result.cross_source_skipped++; continue; }

      // 收進機尾庫（去重靠 formatTail 統一格式 + DB ON CONFLICT）
      if (tail) {
        const look = tailLookup(tailRaw);
        if (!aircraftUpsert.has(tail)) aircraftUpsert.set(tail, { type: acType || (look ? look.code : ''), operator: look ? look.operator : null });
      }

      // 即時回寫本來源 source_ref（同檔同 Object ID 重覆才更新）。
      // 注意：不把本次 logatp 寫進 crossKey —— 跨來源防重只擋「別的 logbook 來源（logten/roster…）」，
      // 同檔內不同 Object ID 的「同班雙筆」一律都進，由使用者自己決定刪哪筆（避免誤殺較完整那筆）。
      existingLogatp.set(sourceRef, { id: decidedId, status });

      if (opts.dryRun) continue;

      const crewJson = Object.keys(crew).length ? JSON.stringify(crew) : null;
      const params = [
        date, flightNo, origin, dest,
        acType || null, tail || null,
        null, null, outUtc, offUtc, onUtc, inUtc,
        blockMin, airMin, nightMin, null,
        null, null, null,
        crewJson, null,
        dayTO, nightTO, dayLdg, nightLdg, autolands,
        null, null, null, remarks,
        position, picMin, sicMin, false, isPF,
      ];
      if (action === 'update') {
        updateBatch.push({ id: decidedId, params });
      } else {
        insertBatch.push([decidedId, userId, 'logatp', sourceRef, status, ...params]);
      }
    } catch (e: any) {
      console.warn('[pilot-log] logatp row error:', e.message);
      result.parse_errors++;
    }
  }

  if (opts.dryRun) return result;
  if (!insertBatch.length && !updateBatch.length) return result;

  const client = await pool.connect();
  let insertedCount = 0, updatedCount = 0;
  try {
    await client.query('BEGIN');
    for (let off = 0; off < insertBatch.length; off += INSERT_BATCH) {
      const chunk = insertBatch.slice(off, off + INSERT_BATCH);
      const flat: any[] = [];
      for (const r of chunk) {
        if (r.length !== INSERT_N) throw new Error(`logatp insert arity mismatch: got ${r.length}, expected ${INSERT_N}`);
        for (const v of r) flat.push(v);
      }
      await client.query(buildBulkInsertSQL(chunk.length), flat);
      insertedCount += chunk.length;
    }
    for (const u of updateBatch) {
      await client.query(
        `UPDATE pilot_log_entries SET
           status='confirmed', flight_date=$2, flight_no=$3, origin=$4, dest=$5,
           aircraft_type=$6, tail_no=$7,
           std_utc=$8, sta_utc=$9, out_utc=$10, off_utc=$11, on_utc=$12, in_utc=$13,
           block_minutes=$14, air_minutes=$15, night_minutes=$16, distance_nm=$17,
           on_duty_utc=$18, off_duty_utc=$19, total_duty_minutes=$20,
           crew=$21::jsonb, approaches=$22::jsonb,
           day_takeoffs=$23, night_takeoffs=$24, day_landings=$25, night_landings=$26, autolands=$27,
           pax_count=$28, sid=$29, star=$30, remarks=$31,
           position=$32, pic_minutes=$33, sic_minutes=$34, is_deadhead=$35, pilot_flying=$36,
           updated_at=NOW()
         WHERE id=$1`,
        [u.id, ...u.params]
      );
      updatedCount++;
    }
    // 機尾庫：補上沒見過的機號（operator/type 用機籍表反查；ON CONFLICT 不洗白既有）
    for (const [tail, info] of aircraftUpsert) {
      await client.query(
        `INSERT INTO pilot_aircraft (user_id, tail_no, operator, type_code)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, tail_no) DO UPDATE SET
           operator = COALESCE(pilot_aircraft.operator, EXCLUDED.operator),
           type_code = COALESCE(pilot_aircraft.type_code, EXCLUDED.type_code)`,
        [userId, tail, info.operator, info.type || null]
      ).catch(() => { /* 機尾庫補不進不該擋主匯入 */ });
    }
    await client.query('COMMIT');
    result.inserted = insertedCount;
    result.updated = updatedCount;
    if (insertedCount || updatedCount) {
      pool.query(`UPDATE pilot_users SET last_import_at = NOW() WHERE id = $1`, [userId]).catch(() => {});
    }
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    console.error('[pilot-log] logatp import rolled back:', e.message);
    throw e;
  } finally {
    client.release();
  }
  return result;
}
