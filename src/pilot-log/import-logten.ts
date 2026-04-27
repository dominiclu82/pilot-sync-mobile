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

// V1.0.04：Bulk INSERT 用的 column 順序與 JSONB 標記
// 改 column 順序 = 改 INSERT row params 結構，要一起改
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
];
const INSERT_N = INSERT_COLS.length; // 35
const JSONB_IDX = new Set([INSERT_COLS.indexOf('crew'), INSERT_COLS.indexOf('approaches')]);
const INSERT_BATCH = 50;             // 50 row × 35 col = 1750 params/batch（遠低於 PG 65535 限制）

function buildBulkInsertSQL(rowCount: number): string {
  const placeholders: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const ph: string[] = [];
    for (let c = 0; c < INSERT_N; c++) {
      const num = r * INSERT_N + c + 1;
      ph.push(JSONB_IDX.has(c) ? `$${num}::jsonb` : `$${num}`);
    }
    placeholders.push(`(${ph.join(',')})`);
  }
  return `INSERT INTO pilot_log_entries (${INSERT_COLS.join(',')}) VALUES ${placeholders.join(',')}`;
}

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
    return { inserted: 0, updated: 0, duplicate_skipped: 0, parse_errors: 0, error: 'database_unavailable' };
  }

  const { headers, rows } = parseTab(text);
  if (headers.length === 0) {
    return { inserted: 0, updated: 0, duplicate_skipped: 0, parse_errors: 0, error: 'empty_or_invalid_file' };
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
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const date = (row['Date'] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      result.bad_rows!.push({
        row: i + 2,
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

  // ── V1.0.04 速度優化：一次撈所有現有 source_ref 進 Map ──────────────────────
  // 取代 V1.0.0x 每 row 一次 SELECT，2000 筆從 2000 query 降到 1 query
  const existingMap = new Map<string, { id: string; status: string }>();
  {
    const r = await pool.query(
      `SELECT source_ref, id, status FROM pilot_log_entries WHERE user_id = $1 AND source = 'logten'`,
      [userId]
    );
    for (const row of r.rows) {
      existingMap.set(row.source_ref, { id: row.id, status: row.status });
    }
  }

  // ── 累積 INSERT / UPDATE 任務，loop 結束後一次 bulk write ────────────────────
  // INSERT: 35 個欄位的 param tuple，照 INSERT_COLS 順序
  // UPDATE: 走逐筆（draft → confirmed 在正常流程中是少數，per-row UPDATE 不是瓶頸）
  const insertBatch: any[][] = [];
  const updateBatch: Array<{ id: string; params: any[] }> = [];

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

      const approaches: any[] = [];
      for (let ai = 1; ai <= 5; ai++) {
        const a = parseApproach(row[`Approach ${ai}`] || '');
        if (a) approaches.push(a);
      }

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

      // Smart status：有 actual Out 才算飛過，否則仍是計畫（V1.0.02 起，語意不變）
      const newStatus: 'draft' | 'confirmed' = outUtc ? 'confirmed' : 'draft';

      // Smart re-import：用 Map 取代 SELECT，語意不變（V1.0.02 起）
      // confirmed → skip 保護使用者編輯；draft / roster_removed → 整筆覆蓋
      // V1.0.04 補：existingMap 在 loop 中也即時回寫，讓「同一檔內重複 sourceRef」
      // 走跟 cross-run 一樣的語意（confirmed → 後者 skip；draft → 後者覆蓋前者）
      const existing = existingMap.get(sourceRef);
      let action: 'insert' | 'update' | 'skip_confirmed';
      let existingId: string | null = null;
      if (!existing) {
        action = 'insert';
      } else if (existing.status === 'confirmed') {
        action = 'skip_confirmed';
      } else {
        action = 'update';
        existingId = existing.id;
      }

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

      // 決定本次行動的 id（insert 用新 UUID；update 用現有 id）
      // 這個 id 同時要回寫 existingMap，讓同檔後續 row 看見
      const decidedId = action === 'insert' ? randomUUID() : existingId!;

      // 即時回寫 existingMap：之後同 sourceRef 的 row 會走 update 或 skip
      // 不論 dryRun 或實際 run，都要回寫，否則 dryRun preview 會跟實際行為不一致
      existingMap.set(sourceRef, { id: decidedId, status: newStatus });

      if (opts.dryRun) continue;

      const crewJson = Object.keys(crew).length ? JSON.stringify(crew) : null;
      const approachesJson = approaches.length ? JSON.stringify(approaches) : null;
      const distanceVal = parseDecimalOrNull(row['Distance']);
      const paxVal = parseIntOrNull(row['Total Pax']);

      if (action === 'update') {
        updateBatch.push({
          id: decidedId,
          params: [
            newStatus,
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
          ],
        });
      } else {
        // INSERT_COLS 順序：id, user_id, source, source_ref, status,
        //   flight_date, flight_no, origin, dest,
        //   aircraft_type, tail_no,
        //   std_utc..in_utc, block_minutes..distance_nm,
        //   on_duty_utc, off_duty_utc, total_duty_minutes,
        //   crew, approaches,
        //   day_takeoffs..autolands,
        //   pax_count, sid, star, remarks
        insertBatch.push([
          decidedId, userId, 'logten', sourceRef, newStatus,
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
        ]);
      }
    } catch (e: any) {
      console.warn('[pilot-log] flight import row error:', e.message);
      result.parse_errors++;
    }
  }

  // dry-run：到此為止，不寫 DB（preview/result 已組好）
  if (opts.dryRun) return result;

  // 沒任何寫入需求（全部 skip_confirmed）→ 直接回，省掉 TX 開銷
  if (insertBatch.length === 0 && updateBatch.length === 0) return result;

  // ── 包進單一 transaction：要嘛全寫成功，要嘛全 ROLLBACK，避免 partial 狀態 ──
  // codex 提醒：原本 bulk INSERT 後接 UPDATE，若中途任一失敗會留下部分寫入。
  // 用 pool.connect() 拿單一 client，自己控制 BEGIN/COMMIT/ROLLBACK。
  const client = await pool.connect();
  let insertedCount = 0;
  let updatedCount = 0;
  try {
    await client.query('BEGIN');

    // Bulk INSERT：每 INSERT_BATCH (50) row 合併成一個 INSERT statement
    for (let off = 0; off < insertBatch.length; off += INSERT_BATCH) {
      const chunk = insertBatch.slice(off, off + INSERT_BATCH);
      const sql = buildBulkInsertSQL(chunk.length);
      const flatParams: any[] = [];
      for (const row of chunk) {
        // insertBatch.push() 永遠是 INSERT_N (35) 個元素的固定 array literal；
        // 若哪天 refactor 破壞這個不變量 → fast-fail 比 silent placeholder 對不上好
        if (row.length !== INSERT_N) {
          throw new Error(`bulk insert row arity mismatch: got ${row.length}, expected ${INSERT_N}`);
        }
        for (const v of row) flatParams.push(v);
      }
      await client.query(sql, flatParams);
      insertedCount += chunk.length;
    }

    // UPDATE：逐筆（draft → confirmed 是少數情境，per-row 不是瓶頸）
    for (const u of updateBatch) {
      await client.query(
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
        [u.id, ...u.params]
      );
      updatedCount++;
    }

    await client.query('COMMIT');
    // 只有 COMMIT 成功才寫進 result；不然 ROLLBACK 後 DB 是空的，計數也該是 0
    result.inserted = insertedCount;
    result.updated = updatedCount;
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    console.error('[pilot-log] import transaction rolled back:', e.message);
    throw e;     // 讓 route handler 回 500，前端會看到「上傳失敗」而不是假的成功訊息
  } finally {
    client.release();
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
