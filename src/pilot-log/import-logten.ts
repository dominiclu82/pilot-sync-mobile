// Pilot Log v1 — LogTen Pro 匯入
//
// 邊界寫死（避免 scope 漂移）：
//   - 只接受 LogTen Pro 6 Tab 動態匯出 (Flights) + Aircraft Tab 匯出
//   - 編碼只接受 UTF-8
//   - Header 缺必填欄位 → reject
//   - 未知欄位 → 忽略不報錯
//   - 不接受 CSV / ICS / 其他格式

import { randomUUID } from 'crypto';
import { getPool, ensureTables } from './schema.js';

// ── Tab parser ────────────────────────────────────────────────────────────────
function parseTab(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // 處理 BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split('\t').map(h => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    // 跳過全空白行
    if (cells.every(c => !c.trim())) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? '').trim();
    }
    rows.push(row);
  }
  return { headers, rows };
}

function assertHeaders(headers: string[], required: string[]): string[] {
  const missing: string[] = [];
  const set = new Set(headers);
  for (const r of required) if (!set.has(r)) missing.push(r);
  return missing;
}

// ── HHMM UTC parser ──────────────────────────────────────────────────────────
// e.g. Date='2026-04-02', hhmm='1217' → '2026-04-02T12:17:00Z'
// 跨日：若上一個時間點 hhmm 比這個大，視為次日
function parseUtcAtDate(dateStr: string, hhmm: string, prevUtc?: Date | null): Date | null {
  if (!hhmm || !/^\d{4}$/.test(hhmm)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = parseInt(hhmm.slice(2, 4), 10);
  if (h > 23 || m > 59) return null;
  let d = new Date(`${dateStr}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`);
  // 跨日修正：若 prev 比 d 晚，把 d 推一天
  if (prevUtc && d.getTime() < prevUtc.getTime()) {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
  }
  return isNaN(d.getTime()) ? null : d;
}

// "12:26" → 746
function parseHHColonMM(s: string): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (mm > 59) return null;
  return h * 60 + mm;
}

// "1;ILS;23R;RCTP" → { count, type, runway, airport }
function parseApproach(s: string): { count: number; type: string; runway: string; airport: string } | null {
  if (!s) return null;
  const parts = s.split(';');
  if (parts.length < 4) return null;
  const count = parseInt(parts[0], 10);
  if (isNaN(count)) return null;
  return {
    count,
    type: parts[1].trim(),
    runway: parts[2].trim(),
    airport: parts[3].trim(),
  };
}

function parseInt0(s: string): number {
  if (!s) return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function parseIntOrNull(s: string): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function parseDecimalOrNull(s: string): number | null {
  if (!s) return null;
  // 移除千分位逗號
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// ── Position 推斷（依 PIC/P1 vs SIC/P2 哪一格是當事人）─────────────────
// LogTen 不會直接告訴我們「這筆是不是 PIC」，
// 只能靠 PIC/P1 + SIC/P2 + 自己名字配對。
// v1 簡化：留空 position（之後使用者可在 UI 編輯）。

// ── Flights file 解析 ────────────────────────────────────────────────────────
const FLIGHTS_REQUIRED = [
  'Date', 'Flight #', 'From', 'To', 'Aircraft Type', 'Aircraft ID',
  'Out', 'In', 'On Duty', 'Off Duty', 'PIC/P1', 'SIC/P2',
];

export interface ImportLogtenFlightsResult {
  inserted: number;
  updated: number;
  duplicate_skipped: number;            // 命中 confirmed → 不動
  parse_errors: number;
  bad_rows?: Array<{ row: number; flight_no?: string; date?: string; reason: string }>;
  preview?: Array<{
    flight_date: string; flight_no: string; origin: string; dest: string;
    aircraft_type: string; tail_no: string;
    out_utc: string | null; off_utc: string | null; on_utc: string | null; in_utc: string | null;
    block: string | null; pic: string | null; sic: string | null;
    action: 'insert' | 'update' | 'skip_confirmed';
    new_status: 'draft' | 'confirmed' | null;   // skip_confirmed 時為 null
  }>;
  error?: string;
  dry_run?: boolean;
}

export async function importLogtenFlights(
  userId: string,
  text: string,
  opts: { dryRun?: boolean } = {}
): Promise<ImportLogtenFlightsResult> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) {
    return { inserted: 0, duplicate_skipped: 0, parse_errors: 0, error: 'database_unavailable' };
  }

  const { headers, rows } = parseTab(text);
  if (headers.length === 0) {
    return { inserted: 0, duplicate_skipped: 0, parse_errors: 0, error: 'empty_or_invalid_file' };
  }

  const missing = assertHeaders(headers, FLIGHTS_REQUIRED);
  if (missing.length > 0) {
    return {
      inserted: 0, updated: 0, duplicate_skipped: 0, parse_errors: 0,
      error: `missing_required_columns:${missing.join(',')}`,
    };
  }

  const result: ImportLogtenFlightsResult = {
    inserted: 0, updated: 0, duplicate_skipped: 0, parse_errors: 0,
    bad_rows: [], preview: [],
    dry_run: !!opts.dryRun,
  };

  // 嚴格 Date 格式驗證 — 任何一筆爛掉就標記、整批不寫
  // 先掃一遍找壞 row。即使 dry-run 也要回 bad_rows 給前端看。
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const date = (row['Date'] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      result.bad_rows!.push({
        row: i + 2,                       // header 是第 1 行，資料從第 2 行起
        flight_no: row['Flight #'] || '',
        date,
        reason: 'invalid_date_format (expected YYYY-MM-DD)',
      });
    }
  }

  if (result.bad_rows!.length > 0) {
    return {
      ...result,
      error: `bad_date_in_${result.bad_rows!.length}_row(s)`,
    };
  }

  // 早期 dryRun 回傳：但是還是要逐筆跑出 preview + action（不寫 DB），所以繼續往下走

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const date = row['Date'];
      const flightNo = row['Flight #'];
      const from = row['From'];
      const to = row['To'];
      if (!date || !flightNo || !from || !to) {
        result.parse_errors++;
        continue;
      }

      const sourceRef = `logten:${date}:${flightNo}:${from}:${to}`;

      // 跨日 OOOI：Out → Off → On → In 順序遞增，若回繞則 +1 day
      const outUtc = parseUtcAtDate(date, row['Out']);
      const offUtc = parseUtcAtDate(date, row['Off'], outUtc);
      const onUtc = parseUtcAtDate(date, row['On'], offUtc || outUtc);
      const inUtc = parseUtcAtDate(date, row['In'], onUtc || offUtc || outUtc);
      const stdUtc = parseUtcAtDate(date, row['Scheduled Out']);
      const staUtc = parseUtcAtDate(date, row['Scheduled In'], stdUtc);
      const onDutyUtc = parseUtcAtDate(date, row['On Duty']);
      const offDutyUtc = parseUtcAtDate(date, row['Off Duty'], onDutyUtc);

      const blockMin = parseHHColonMM(row['Block'] || row['Total Time']);
      const airMin = parseHHColonMM(row['Air Time']);
      const nightMin = parseHHColonMM(row['Night']);
      const dutyMin = parseHHColonMM(row['Total Duty']);

      // Approach 1..N
      const approaches: any[] = [];
      for (let ai = 1; ai <= 5; ai++) {
        const a = parseApproach(row[`Approach ${ai}`] || '');
        if (a) approaches.push(a);
      }

      // Crew JSONB
      const crew: Record<string, string> = {};
      const pic = row['PIC/P1 Crew'] || row['PIC/P1'];
      const sic = row['SIC/P2 Crew'] || row['SIC/P2'];
      if (pic) crew.pic = pic;
      if (sic) crew.sic = sic;
      if (row['FO 1']) crew.fo1 = row['FO 1'];
      if (row['FO 2']) crew.fo2 = row['FO 2'];
      if (row['Purser']) crew.purser = row['Purser'];
      if (row['Observer']) crew.observer1 = row['Observer'];
      if (row['Observer 2']) crew.observer2 = row['Observer 2'];

      // Smart status：有 actual Out 才算飛過，否則仍是計畫
      const newStatus: 'draft' | 'confirmed' = outUtc ? 'confirmed' : 'draft';

      // Smart re-import：找現有同 source_ref → 已 confirmed 不動，draft / roster_removed 可更新
      const existing = await pool.query(
        `SELECT id, status FROM pilot_log_entries WHERE user_id = $1 AND source = 'logten' AND source_ref = $2`,
        [userId, sourceRef]
      );
      let action: 'insert' | 'update' | 'skip_confirmed';
      let existingId: string | null = null;
      if (existing.rows.length === 0) {
        action = 'insert';
      } else if (existing.rows[0].status === 'confirmed') {
        action = 'skip_confirmed';
      } else {
        action = 'update';
        existingId = existing.rows[0].id;
      }

      // Preview / 結果用簡短 summary
      result.preview!.push({
        flight_date: date,
        flight_no: flightNo,
        origin: from,
        dest: to,
        aircraft_type: row['Aircraft Type'] || '',
        tail_no: row['Aircraft ID'] || '',
        out_utc: outUtc ? outUtc.toISOString() : null,
        off_utc: offUtc ? offUtc.toISOString() : null,
        on_utc: onUtc ? onUtc.toISOString() : null,
        in_utc: inUtc ? inUtc.toISOString() : null,
        block: blockMin != null ? `${Math.floor(blockMin / 60)}:${String(blockMin % 60).padStart(2, '0')}` : null,
        pic: pic || null,
        sic: sic || null,
        action,
        new_status: action === 'skip_confirmed' ? null : newStatus,
      });

      if (action === 'skip_confirmed') {
        result.duplicate_skipped++;
        continue;
      }

      // dry-run：到此為止，不真的寫 DB
      if (opts.dryRun) continue;

      const crewJson = Object.keys(crew).length ? JSON.stringify(crew) : null;
      const approachesJson = approaches.length ? JSON.stringify(approaches) : null;
      const distanceVal = parseDecimalOrNull(row['Distance']);
      const paxVal = parseIntOrNull(row['Total Pax']);

      if (action === 'update') {
        // 對 draft / roster_removed 整筆覆蓋（LogTen 是 source of truth；
        // 使用者要保留 confirmed 之前的編輯，自己改成 confirmed 就會被保護）
        await pool.query(
          `UPDATE pilot_log_entries SET
             status = $2,
             flight_date = $3, flight_no = $4, origin = $5, dest = $6,
             aircraft_type = $7, tail_no = $8,
             std_utc = $9, sta_utc = $10, out_utc = $11, off_utc = $12, on_utc = $13, in_utc = $14,
             block_minutes = $15, air_minutes = $16, night_minutes = $17, distance_nm = $18,
             on_duty_utc = $19, off_duty_utc = $20, total_duty_minutes = $21,
             crew = $22::jsonb, approaches = $23::jsonb,
             day_takeoffs = $24, night_takeoffs = $25, day_landings = $26, night_landings = $27, autolands = $28,
             pax_count = $29, sid = $30, star = $31, remarks = $32,
             updated_at = NOW()
           WHERE id = $1`,
          [
            existingId, newStatus,
            date, flightNo, from, to,
            row['Aircraft Type'] || null, row['Aircraft ID'] || null,
            stdUtc, staUtc, outUtc, offUtc, onUtc, inUtc,
            blockMin, airMin, nightMin, distanceVal,
            onDutyUtc, offDutyUtc, dutyMin,
            crewJson, approachesJson,
            parseInt0(row['Day T/O']), parseInt0(row['Night T/O']),
            parseInt0(row['Day Ldg']), parseInt0(row['Night Ldg']),
            parseInt0(row['Autolands']),
            paxVal, row['SID'] || null, row['STAR'] || null,
            row['Remarks'] || null,
          ]
        );
        result.updated++;
      } else {
        await pool.query(
          `INSERT INTO pilot_log_entries
           (id, user_id, source, source_ref, status, flight_date, flight_no, origin, dest,
            aircraft_type, tail_no, std_utc, sta_utc, out_utc, off_utc, on_utc, in_utc,
            block_minutes, air_minutes, night_minutes, distance_nm,
            on_duty_utc, off_duty_utc, total_duty_minutes,
            crew, approaches,
            day_takeoffs, night_takeoffs, day_landings, night_landings, autolands,
            pax_count, sid, star, remarks)
           VALUES ($1, $2, 'logten', $3, $4, $5, $6, $7, $8,
                   $9, $10, $11, $12, $13, $14, $15, $16,
                   $17, $18, $19, $20,
                   $21, $22, $23,
                   $24::jsonb, $25::jsonb,
                   $26, $27, $28, $29, $30,
                   $31, $32, $33, $34)`,
          [
            randomUUID(), userId, sourceRef, newStatus, date, flightNo, from, to,
            row['Aircraft Type'] || null, row['Aircraft ID'] || null,
            stdUtc, staUtc, outUtc, offUtc, onUtc, inUtc,
            blockMin, airMin, nightMin, distanceVal,
            onDutyUtc, offDutyUtc, dutyMin,
            crewJson, approachesJson,
            parseInt0(row['Day T/O']), parseInt0(row['Night T/O']),
            parseInt0(row['Day Ldg']), parseInt0(row['Night Ldg']),
            parseInt0(row['Autolands']),
            paxVal, row['SID'] || null, row['STAR'] || null,
            row['Remarks'] || null,
          ]
        );
        result.inserted++;
      }
    } catch (e: any) {
      console.warn('[pilot-log] flight import row error:', e.message);
      result.parse_errors++;
    }
  }

  return result;
}

// ── Aircraft file 解析 ───────────────────────────────────────────────────────
const AIRCRAFT_REQUIRED = ['Aircraft ID', 'Operator', 'Type'];

export interface ImportLogtenAircraftResult {
  inserted: number;
  updated: number;
  parse_errors: number;
  error?: string;
}

export async function importLogtenAircraft(
  userId: string,
  text: string
): Promise<ImportLogtenAircraftResult> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) {
    return { inserted: 0, updated: 0, parse_errors: 0, error: 'database_unavailable' };
  }

  const { headers, rows } = parseTab(text);
  if (headers.length === 0) {
    return { inserted: 0, updated: 0, parse_errors: 0, error: 'empty_or_invalid_file' };
  }

  const missing = assertHeaders(headers, AIRCRAFT_REQUIRED);
  if (missing.length > 0) {
    return {
      inserted: 0, updated: 0, parse_errors: 0,
      error: `missing_required_columns:${missing.join(',')}`,
    };
  }

  const result: ImportLogtenAircraftResult = { inserted: 0, updated: 0, parse_errors: 0 };

  for (const row of rows) {
    try {
      const tail = row['Aircraft ID'];
      if (!tail) { result.parse_errors++; continue; }

      const r = await pool.query(
        `INSERT INTO pilot_aircraft (user_id, tail_no, operator, type_code, make, model, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, tail_no) DO UPDATE SET
           operator = COALESCE(EXCLUDED.operator, pilot_aircraft.operator),
           type_code = COALESCE(EXCLUDED.type_code, pilot_aircraft.type_code),
           make = COALESCE(EXCLUDED.make, pilot_aircraft.make),
           model = COALESCE(EXCLUDED.model, pilot_aircraft.model),
           notes = COALESCE(EXCLUDED.notes, pilot_aircraft.notes)
         RETURNING (xmax = 0) AS inserted`,
        [
          userId, tail, row['Operator'] || null, row['Type'] || null,
          row['Make'] || null, row['Model'] || null, row['Notes'] || null,
        ]
      );
      if (r.rows[0]?.inserted) result.inserted++; else result.updated++;
    } catch (e: any) {
      console.warn('[pilot-log] aircraft import row error:', e.message);
      result.parse_errors++;
    }
  }

  return result;
}
