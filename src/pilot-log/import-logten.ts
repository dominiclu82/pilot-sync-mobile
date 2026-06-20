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
import { parseTab } from './tsv-parser.js';
import { normAirportKey } from './airport-codes.js';   // V2.4.xx：TPE/RCTP 正規化（同站來回判定）
// V1.0.06：parseTab 抽到 tsv-parser.ts 改成 proper state machine，
// 處理 quoted 多行欄位（LogTen Remarks 多行用 quote 包）+ escaped quote。
// 原本 inline split-by-line 版本會把 LogTen 多行 Remarks 拆成假 row，
// 觸發 invalid_date_format 整批 reject。

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
// V1.3.15：On Duty / Off Duty / PIC/P1 / SIC/P2 改成「選填」—— 勤務時間跟組員名字非必要
// （很多人的 LogTen Dynamic Export 沒勾這幾欄），有就解析、沒有就留空，不該整批擋掉。
// 解析端本來就容忍它們不存在（row['On Duty'] 等 undefined → null/skip），只是 header 檢查太嚴。
const FLIGHTS_REQUIRED = [
  'Date', 'Flight #', 'From', 'To', 'Aircraft Type', 'Aircraft ID', 'Out', 'In',
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
  'position',                                   // V1.2.03：匯入時推斷的角色（PIC/SIC）
  'pic_minutes', 'sic_minutes',                 // V1.2.04：LogTen 實際 PIC/SIC 時數
  'is_deadhead',                                // V1.2.05：deadhead/positioning 標記
  'is_sim',                                     // V2.4.xx：模擬機（班號 EM/TM/PT/PC）
  'pilot_flying',                               // V1.3.03：LogTen「Pilot Flying」欄；起降只在 PF 時計
  'needs_completion',                           // 待補強：缺必填欄位（航班號/起降）但完整保留資料、補完轉綠
];
const INSERT_N = INSERT_COLS.length; // 40

// V1.2.03 helpers ─────────────────────────────────────────────────────────────
// 名字正規化（比對使用者本人）：小寫、空白收斂、去頭尾
function _plNormName(s: string | undefined | null): string {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}
// LogTen 的 Deadhead 欄位真值（匯出可能是 1 / YES / true / x …）
function _plTruthyFlag(v: string | undefined | null): boolean {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'x' || s === '✓' || s === 'deadhead';
}
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
  crew_overwritten?: number;            // V1.3.24：overwriteCrew 模式下，confirmed 航班被補/換組員的筆數
  oooi_backfilled?: number;             // V2.4.xx：confirmed 卻缺 OOOI（in_utc 空）→ 用檔案的實際時間回填（只補空缺）
  parse_errors: number;
  needs_completion?: number;            // 待補強：有日期、缺必填（航班號/起降）→ 收為 needs_completion，不丟棄
  skipped_standby?: number;             // V2.4.xx：SB 待命 → 不匯入（這次檔案裡跳過的列數）
  skipped_training?: number;            // V2.4.xx：同站來回（TPE↔TPE）訓練/待命 → 不匯入（只留最早一筆 local check）
  cleaned_standby?: number;             // V2.4.xx：順手刪掉的「既有」待命垃圾筆數
  cleaned_training?: number;            // V2.4.xx：順手刪掉的「既有」同站訓練垃圾筆數（留最早一筆 local check）
  bad_rows?: Array<{ row: number; flight_no?: string; date?: string; reason: string }>;
  preview?: Array<{
    flight_date: string; flight_no: string; origin: string; dest: string;
    aircraft_type: string; tail_no: string;
    out_utc: string | null; off_utc: string | null; on_utc: string | null; in_utc: string | null;
    block: string | null; pic: string | null; sic: string | null;
    action: 'insert' | 'update' | 'skip_confirmed' | 'overwrite_crew' | 'backfill_oooi';
    new_status: 'draft' | 'confirmed' | null;   // skip_confirmed / overwrite_crew / backfill_oooi 時為 null
    position?: string | null;                    // V1.2.03：推斷的角色（PIC/SIC/null）
    deadhead?: boolean;                          // V1.2.03：是否 positioning
    pic_min?: number | null;                     // V1.2.04：讀到的 LogTen PIC 時數（分）
    sic_min?: number | null;                     // V1.2.04：讀到的 LogTen SIC 時數（分）
  }>;
  headers?: string[];                            // V1.2.04：匯出檔欄位 headers（診斷用）
  error?: string;
  dry_run?: boolean;
}

export async function importLogtenFlights(
  userId: string,
  text: string,
  opts: { dryRun?: boolean; overwriteCrew?: boolean } = {}
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
    inserted: 0, updated: 0, duplicate_skipped: 0, crew_overwritten: 0, parse_errors: 0,
    needs_completion: 0,
    bad_rows: [], preview: [],
    dry_run: !!opts.dryRun,
    headers,                                       // V1.2.04：回傳欄位 headers，方便確認 PIC/SIC 時數欄有沒有被讀到
  };
  // completeKeys 記本次「完整航班」的 日期|出發時間(ISO) → TX 內用來合併掉「已被補完」的舊待補強（不留兩筆）。
  //   缺欄位的待補強走正常 insert 路徑、帶 needs_completion 旗標（保留所有解析資料）；不再另存精簡記錄。
  const completeKeys = new Set<string>();

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
  // in_utc 一起撈：用來判斷「confirmed 但缺 OOOI」→ 回填（V2.4.xx）
  const existingMap = new Map<string, { id: string; status: string; inUtc: string | null; isSim: boolean; isDeadhead: boolean }>();
  {
    const r = await pool.query(
      `SELECT source_ref, id, status, in_utc, is_sim, is_deadhead FROM pilot_log_entries WHERE user_id = $1 AND source = 'logten'`,
      [userId]
    );
    for (const row of r.rows) {
      existingMap.set(row.source_ref, { id: row.id, status: row.status, inUtc: row.in_utc ? new Date(row.in_utc).toISOString() : null, isSim: !!row.is_sim, isDeadhead: !!row.is_deadhead });
    }
  }

  // ── V1.2.03：撈使用者本人名字（Address Book is_self）──────────────────────────
  // LogTen 沒有單一 position 欄，沒帶 PIC/SIC 時數欄時，靠比對 PIC/P1 vs SIC/P2 的姓名
  // 是不是本人來推斷 position。沒匯 Address Book / 沒標 self 就退回只靠時數欄。
  const selfNames = new Set<string>();
  try {
    const r = await pool.query(
      `SELECT display_name FROM crew WHERE user_id = $1 AND is_self = true`,
      [userId]
    );
    for (const row of r.rows) {
      const n = _plNormName(row.display_name);
      if (n) selfNames.add(n);
    }
  } catch { /* crew 表不存在 / 沒匯 Address Book → selfNames 空，只靠時數欄判 position */ }

  // ── 累積 INSERT / UPDATE 任務，loop 結束後一次 bulk write ────────────────────
  // INSERT: 35 個欄位的 param tuple，照 INSERT_COLS 順序
  // UPDATE: 走逐筆（draft → confirmed 在正常流程中是少數，per-row UPDATE 不是瓶頸）
  const insertBatch: any[][] = [];
  const updateBatch: Array<{ id: string; params: any[] }> = [];
  // V1.3.24：overwriteCrew —— 對 confirmed 航班只補/換組員 + PIC/SIC 時數 + position，其餘欄位不動
  const crewUpdateBatch: Array<{ id: string; crewJson: string | null; picMin: number | null; sicMin: number | null; position: string | null }> = [];
  // V2.4.xx：OOOI 回填 —— confirmed 卻缺 in_utc 的航班，用檔案實際時間「只補空缺」（COALESCE），不動其他編輯
  const backfillBatch: Array<{ id: string; params: any[] }> = [];

  // V1.2.04 / codex P2：同檔內「日期+航班號+起降」完全相同的不同航班（同日同班號折返、
  // 兩段 leg）原本 source_ref 會碰撞、被 merge 掉一筆。先掃一遍找出哪些 base 重複，
  // 對「重複的」才加上穩定的時間戳記區分（不用列順序序號 — 否則下次匯出順序變了會對到錯紀錄）。
  const baseCount = new Map<string, number>();
  for (const row of rows) {
    const d = row['Date'], f = row['Flight #'], o = row['From'], t = row['To'];
    if (!d || !f || !o || !t) continue;   // 沒班號的列走 incomplete-style ref（date+out 天然唯一），不靠 baseCount
    const b = `logten:${d}:${f}:${o}:${t}`;
    baseCount.set(b, (baseCount.get(b) || 0) + 1);
  }

  // V2.4.xx（user 規則）：同站來回（TPE↔TPE，含 RCTP）幾乎都是過去待命/訓練，不需要保留；
  //   只留「日期最早的那一筆」當 local check（第一筆紀錄）。先掃一遍找出要保留那筆的列索引，
  //   主迴圈裡其餘 TPE→TPE 一律跳過不匯。
  const _TPE_KEY = normAirportKey('TPE');
  let _keepLocalCheckIdx = -1;
  let _keepLocalCheckDate = '';
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i]['From'], t = rows[i]['To'], d = rows[i]['Date'];
    // codex P2：只在「主迴圈真的會收」的列裡挑 local check —— 沒日期 / 待命(SB/SBY) 的列主迴圈會跳過，
    //   若被選成 keep idx，會害其餘合格 TPE↔TPE 全被跳掉、最後一筆 local check 都沒留。
    if (!o || !t || !d) continue;
    const _fnFirst0 = String(rows[i]['Flight #'] || '').toUpperCase().split(/\s+/)[0] || '';
    if (/^SBY?[0-9]*$/.test(_fnFirst0)) continue;   // 待命不算 local check
    if (normAirportKey(o) === _TPE_KEY && normAirportKey(t) === _TPE_KEY) {
      if (_keepLocalCheckIdx < 0 || d < _keepLocalCheckDate) { _keepLocalCheckIdx = i; _keepLocalCheckDate = d; }
    }
  }

  // V1.2.04 / codex P1：判斷航班是否「已過」用來決定 confirmed。不能用單純 UTC 今天 —
  // 否則 UTC 跨日後、當地還沒跨日的西半球 user，今天還沒飛的航班會被誤標 confirmed（之後
  // confirmed 重匯會 skip 改不了）。改用「最落後時區(UTC-12)的當地日期」當 cutoff：航班日期
  // 早於它，代表在任何時區都已過 → 安全。代價：近 1 天內的航班會晚點才自動 confirmed（無害，
  // 真飛了會有 Out 直接 confirmed）。
  const _PL_PAST_CUTOFF = new Date(Date.now() - 12 * 3600 * 1000).toISOString().slice(0, 10);

  // V1.3.24：crew 欄位偵測重寫 —— 比對「忽略空格」（"FO 1" = "FO1"），CAP/SFO 等一律納入，
  // 不再用「某關鍵字鎖死某槽 + 排除清單」（舊版把 FO1/FO2 排除、又抓不到 "FO 1" 帶空格 → FO 整批漏）。
  // 角色：PIC/P1 Crew → pic；其餘機師欄（SIC/P2 Crew、CAP/SFO、FO 1、FO 2…）照「欄位出現順序」非空填
  // crew2/crew3/crew4；Purser → cic；Observer / Observer 2 → obs。用值（_looksLikeName）擋掉時數欄
  // （值是 HH:MM 的 PIC/P1、SIC/P2 那種純時數欄）。
  const _norm = (s: string): string => String(s || '').toUpperCase().replace(/\s+/g, '');
  const _looksLikeName = (col: string): boolean => {
    for (let i = 0; i < rows.length && i < 30; i++) {
      const v = String(rows[i][col] || '').trim();
      if (!v) continue;
      if (/^\d{1,3}:\d{2}$/.test(v)) return false;   // HH:MM 時數
      if (/^[\d.:]+$/.test(v)) return false;          // 純數字 / 時間
      return true;                                    // 有字母 → 像名字
    }
    return true;                                      // 全空 → 允許（反正不會帶入值）
  };
  // FO 當成「token」比對，避免誤吃 INFO / OFFICER 之類（OFFICER 另由 FIRSTOFFICER 命中）
  const _hasFO = (n: string): boolean => /(^|[^A-Z])FO\d*($|[^A-Z])/.test(n);
  // V1.3.24（實檔驗證後補）：是否「真的有名字值」。關鍵 —— 有些匯出同時有「PIC/P1」(時數，常空)
  // 跟「PIC/P1 Crew」(姓名)。時數欄若整欄空，_looksLikeName 會放行 → 會搶走 PIC 槽、把姓名欄擠掉。
  // 所以同槽多候選時，優先選「有姓名值」的那欄；都沒有才退回第一個（涵蓋稀疏但合法的欄）。
  // 掃「整份」rows（不設上限）：relief 欄常在早年 2 人派遣是空的、晚幾百筆才開始有人，
  // 設 cap 會把它們誤判成「沒名字值」而丟掉。整份掃一遍很便宜（大多欄很快就命中第一個非空值）。
  const _hasNameValues = (col: string): boolean => {
    for (let i = 0; i < rows.length; i++) {
      const v = String(rows[i][col] || '').trim();
      if (!v) continue;
      if (/^\d{1,3}:\d{2}$/.test(v)) return false;   // 撞到 HH:MM 時數 → 這是時數欄、不是姓名欄
      if (/^[\d.:]+$/.test(v)) return false;
      return true;                                    // 有字母 → 真有名字
    }
    return false;                                     // 整欄空 → 沒有名字值
  };
  const _crewExclude = ['TIME', 'HOUR', 'REMARK', 'NOTE', 'DUTY', 'NIGHT', 'INSTRUMENT', 'APPROACH',
    'LDG', 'TAKEOFF', 'LANDING', 'TOTAL', 'BLOCK', 'DISTANCE', 'PILOTFLYING', 'PAX', 'SCHED'];
  // 先把每個 header 歸到候選清單（照 header 順序），再「優先有名字值」選定 —— 不再 greedy 取第一個
  const picCand: string[] = [], pilotCand: string[] = [], cicCand: string[] = [], obsCand: string[] = [], obs2Cand: string[] = [];
  for (const h of headers) {
    const n = _norm(h);
    if (_crewExclude.some((x) => n.includes(x))) continue;
    if (!_looksLikeName(h)) continue;        // 擋「有 HH:MM 值」的時數欄（SIC/P2 那種有值的）
    if (/OBSERVER.?2|OBS.?2/.test(n)) { obs2Cand.push(h); continue; }
    if (n.includes('OBSERVER') || n.includes('JUMPSEAT') || n.includes('SUPERNUMERARY') || n === 'OBS') { obsCand.push(h); continue; }
    if (n.includes('PURSER') || n.includes('CIC') || n.includes('CHIEF') || n.includes('INCHARGE')) { cicCand.push(h); continue; }
    const reliefish = n.includes('SFO') || n.includes('RELIEF') || n.includes('RCA') || n.includes('RCP') || n.includes('CRUISE');
    if (!reliefish && (n.includes('PIC') || /(^|[^A-Z])P1($|[^A-Z])/.test(n) || n.includes('CAPTAIN') || n.includes('COMMANDER'))) { picCand.push(h); continue; }
    const isPilot = n.includes('SIC') || /(^|[^A-Z])P2($|[^A-Z])/.test(n) || _hasFO(n) ||
      n.includes('SFO') || n.includes('CAP') || n.includes('RCA') || n.includes('RCP') ||
      n.includes('RELIEF') || n.includes('CRUISE') || /(^|[^A-Z])P[34]($|[^A-Z])/.test(n) ||
      n.includes('COPILOT') || n.includes('FIRSTOFFICER');
    if (isPilot) pilotCand.push(h);
  }
  // 選定：同槽多候選 → 優先「有名字值」，否則退回第一個
  const _pick = (cands: string[]): string | undefined => cands.find(_hasNameValues) || cands[0];
  const colPic = _pick(picCand);
  const colCic = _pick(cicCand);
  const colObs = _pick(obsCand);
  const colObs2 = _pick(obs2Cand);
  // 機師欄（→ crew2/3/4）：排掉已選為 PIC 的，優先保留有名字值的（同時擋掉空的時數欄如 PIC/P1）
  let pilotCols = pilotCand.filter((c) => c !== colPic && _hasNameValues(c));
  if (pilotCols.length === 0) pilotCols = pilotCand.filter((c) => c !== colPic);   // 保險：全沒名字值才退回
  // position 推斷用：pilotCols 裡第一個 SIC/P2 姓名欄
  const colSic = pilotCols.find((c) => { const n = _norm(c); return n.includes('SIC') || /(^|[^A-Z])P2($|[^A-Z])/.test(n); });
  // V2.3：客艙組員欄偵測 —— header 含客艙關鍵字、非時數欄、且未被機師/CIC/OBS 佔用 → 照 header 順序當 cabin1..20。
  //   關鍵字採寬鬆比對（CABIN / ATTENDANT / STEWARD / HOSTESS / SCCM / CCM / FA# / CA#）；若使用者匯出欄名不在內，
  //   需拿到實際 header 再補（whole feature 的不確定點 —— LogTen 欄名可自訂）。
  const _isCabinHdr = (n: string): boolean =>
    n.includes('CABIN') || n.includes('ATTENDANT') || n.includes('STEWARD') || n.includes('HOSTESS') ||
    n.includes('SCCM') || n.includes('CCM') || n.includes('FLIGHTATTENDANT') ||
    /(^|[^A-Z])FA\d*($|[^A-Z])/.test(n) || /(^|[^A-Z])CA\d*($|[^A-Z])/.test(n);
  const _crewClaimed = new Set([colPic, colCic, colObs, colObs2, ...pilotCols].filter(Boolean) as string[]);
  const cabinCols: string[] = [];
  for (const h of headers) {
    if (_crewClaimed.has(h)) continue;
    const n = _norm(h);
    if (_crewExclude.some((x) => n.includes(x))) continue;
    if (!_isCabinHdr(n)) continue;
    // V2.3（codex P2）：用「整份掃」的 _hasNameValues 取代只看前 30 列的 _looksLikeName ——
    // 客艙欄常是早期航班全空、晚期才有人，30 列取樣會誤判沒名字而漏掉整欄。
    if (!_hasNameValues(h)) continue;
    cabinCols.push(h);
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const date = row['Date'];
      const flightNo = row['Flight #'];
      const from = row['From'];
      const to = row['To'];
      if (!date) { result.parse_errors++; continue; }   // 連日期都沒有 → flight_date NOT NULL，無法收（極少；批次日期檢查通常已先擋）
      // V2.4.xx：用班號自動分類（user 要求）—— 班號開頭 EM/TM/PT/PC/FFK/PNR = 模擬機；含 PNC = deadhead；SB = 待命。
      //   sim 沒航線是正常、不算待補強；過去 confirmed 的也會在重匯時被回填這兩個旗標。
      const _fnUp = String(flightNo || '').toUpperCase();
      const _fnFirst = _fnUp.split(/\s+/)[0] || '';
      const isSim = /^(EM|TM|PT|PC|FFK|PNR)\d*$/.test(_fnFirst);
      const isPnc = /\bPNC\b/.test(_fnUp);
      const isStandby = /^SBY?\d*$/.test(_fnFirst);   // SB / SBY / SB1… = 待命

      // V2.4.xx（user 規則）：① 待命（SB）→ 一律不匯。
      //   ② 同站來回（TPE↔TPE）幾乎都是過去待命/訓練 → 不匯，只留最早那筆（local check）。
      //   都在進任何寫入/preview 之前先攔掉，並計數讓 dry-run 看得到。
      const _isTpeTpe = !!from && !!to && normAirportKey(from) === _TPE_KEY && normAirportKey(to) === _TPE_KEY;
      if (isStandby) { result.skipped_standby = (result.skipped_standby || 0) + 1; continue; }
      if (_isTpeTpe && i !== _keepLocalCheckIdx) { result.skipped_training = (result.skipped_training || 0) + 1; continue; }
      // V2.3：拆成兩個概念 ——
      //   missingKeyFields = 缺關鍵欄位（含沒班號）→ 沿用既有 incomplete-style source_ref，
      //     讓 V2.2 已匯入過的「沒班號」航段重匯時對得回去（codex：否則 ref 改格式 → 重匯變兩筆）。
      //   needsCompletion = 真正待補強 = 只有「沒航線」(from/to)；沒班號但有航線+時間的是真飛過的航段、要計入統計。
      const missingKeyFields = !flightNo || !from || !to;
      const needsCompletion = !isSim && (!from || !to);   // 模擬機沒航線是正常、不該被當待補強

      // 跨日 OOOI：Out → Off → On → In 順序遞增，若回繞則 +1 day（提前解析，待補強的穩定鍵要用 out）
      const outUtc = parseUtcAtDate(date, row['Out']);
      // source_ref：齊全航班用 date+班號+起降（重複再加 Out 戳，向後相容）；缺關鍵欄位改用「date + 出發時間」當穩定鍵——
      //   不依賴缺失欄位（codex P1-A：用「缺的起降」當鍵，補好重匯會認不回、變兩筆）。
      let sourceRef: string;
      if (missingKeyFields) {
        sourceRef = `logten:incomplete:${date}:${outUtc ? outUtc.getTime() : 'r' + (i + 2)}`;
      } else {
        const baseRef = `logten:${date}:${flightNo}:${from}:${to}`;
        sourceRef = baseRef;
        if ((baseCount.get(baseRef) || 0) > 1) {
          const stamp = String(row['Scheduled Out'] || '').replace(/[^0-9]/g, '') + '_' +
                        String(row['Out'] || '').replace(/[^0-9]/g, '');
          sourceRef = `${baseRef}:${stamp}`;
        }
        completeKeys.add(`${date}|${outUtc ? outUtc.toISOString() : ''}`);   // 完整航班的 日期+出發 → 合併掉同筆舊待補強
      }
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

      // V1.3.24：crew 依角色 + 順序組裝。PIC 固定 pic；PIC 以外機師欄非空值照 header 順序填 crew2/3/4。
      // 直接寫新 6 槽 schema（pic/crew2/crew3/crew4/cic/obs），前端不必再 migrate。
      const crew: Record<string, string> = {};
      const pic = colPic ? String(row[colPic] || '').trim() : '';
      const sic = colSic ? String(row[colSic] || '').trim() : '';   // position 推斷用
      if (pic) crew.pic = pic;
      // V2.3：飛航組副/巡航機師槽位擴充 crew2..crew6（原本只到 crew4，>3 名會被丟）。
      const _slots = ['crew2', 'crew3', 'crew4', 'crew5', 'crew6'];
      let _si = 0;
      for (const c of pilotCols) {
        const v = String(row[c] || '').trim();
        if (!v) continue;
        if (_si >= _slots.length) break;     // >5 名副/巡航機師（極罕見）才不再塞
        crew[_slots[_si]] = v;
        _si++;
      }
      if (colCic) { const v = String(row[colCic] || '').trim(); if (v) crew.cic = v; }
      if (colObs) { const v = String(row[colObs] || '').trim(); if (v) crew.obs = v; }
      if (colObs2) { const v = String(row[colObs2] || '').trim(); if (v) crew.obs2 = v; }   // V2.3：obs2 已是正式槽
      // V2.3：客艙組員（cabin1..20）—— 依偵測到的客艙欄照順序非空填。
      let _cci = 0;
      for (const c of cabinCols) {
        const v = String(row[c] || '').trim();
        if (!v) continue;
        if (_cci >= 20) break;
        crew['cabin' + (_cci + 1)] = v;
        _cci++;
      }

      // V1.2.03：Deadhead = LogTen 標記 positioning 的欄位。deadhead 是已發生事件
      // （你被載過去、沒操作），先判它，因為它會蓋掉 position 推斷。
      const isDeadhead = _plTruthyFlag(row['Deadhead']) || _plTruthyFlag(row['Positioning']) || isPnc;

      // V1.2.04：讀 LogTen 實際 PIC/SIC 時數（多候選欄名，取第一個能解析成 HH:MM 的）。
      // 這是統計要加總的真值；deadhead/加強組員巡航等既非 P1 也非 P2 的時間就不會被灌進來。
      // V1.3.24：時數欄名也因人而異 —— 你的匯出是 "PIC/P1" / "SIC/P2"（不是 "PIC"/"SIC"），補進候選。
      const picMin = parseHHColonMM(row['PIC'] || row['PIC/P1'] || row['PIC Time'] || row['Flight PIC']);
      const sicMin = parseHHColonMM(row['SIC'] || row['SIC/P2'] || row['SIC Time'] || row['Flight SIC']);

      // V1.3.03：起降只在「你是 Pilot Flying」時才算（user：不是 PF 就不該有起降紀錄）。
      // 讀 LogTen「Pilot Flying」欄；非 PF → 起降全 0；PF → 用 LogTen 值但 clamp 掉爆值
      // （LogTen 偶有 97 之類錯值；單一航段合理上限抓 9，訓練 circuit 也夠）。
      const isPF = _plTruthyFlag(row['Pilot Flying']);
      const clampLdg = (v: string | undefined): number => { const n = parseInt0(v || ''); return (n < 0 || n > 9) ? 0 : n; };
      const dTO = isPF ? clampLdg(row['Day T/O']) : 0;
      const nTO = isPF ? clampLdg(row['Night T/O']) : 0;
      const dLdg = isPF ? clampLdg(row['Day Ldg']) : 0;
      const nLdg = isPF ? clampLdg(row['Night Ldg']) : 0;
      const alands = isPF ? clampLdg(row['Autolands']) : 0;

      // V1.2.03：推斷你這趟的角色（position，給篩選/顯示用）— deadhead 一律留空（你是乘客）。
      // 優先看 PIC/SIC 時數欄，再退回比對 PIC/P1 vs SIC/P2 姓名是不是本人。
      let position: string | null = null;
      if (!isDeadhead) {
        if (picMin && picMin > 0) position = 'PIC';
        else if (sicMin && sicMin > 0) position = 'SIC';
        else if (pic && selfNames.has(_plNormName(pic))) position = 'PIC';
        else if (sic && selfNames.has(_plNormName(sic))) position = 'SIC';
      }

      // Smart status（V1.2.04 放寬）：有 actual Out（已飛）、deadhead（已 positioning）、
      // 或飛行日期已過（LogTen 裡有的就是發生過的、可能忘了記 Out）→ confirmed；
      // 只有「未來日期 + 沒 Out + 非 deadhead」才是 draft（真正還沒飛的計畫）。
      const isPast = date < _PL_PAST_CUTOFF;
      // 待補強（沒航線）一律 draft；沒班號但有航線+時間的航段照原本「過去/有 Out/deadhead = confirmed」、計入統計。
      const newStatus: 'draft' | 'confirmed' = needsCompletion ? 'draft' : ((outUtc || isDeadhead || isPast) ? 'confirmed' : 'draft');
      if (needsCompletion) result.needs_completion = (result.needs_completion || 0) + 1;

      // Smart re-import：用 Map 取代 SELECT，語意不變（V1.0.02 起）
      // confirmed → skip 保護使用者編輯；draft / roster_removed → 整筆覆蓋
      // V1.0.04 補：existingMap 在 loop 中也即時回寫，讓「同一檔內重複 sourceRef」
      // 走跟 cross-run 一樣的語意（confirmed → 後者 skip；draft → 後者覆蓋前者）
      const existing = existingMap.get(sourceRef);
      let action: 'insert' | 'update' | 'skip_confirmed' | 'overwrite_crew' | 'backfill_oooi';
      let existingId: string | null = null;
      if (!existing) {
        action = 'insert';
      } else if (existing.status === 'confirmed') {
        // V1.3.24：confirmed 預設 skip（保護你的編輯）；開 overwriteCrew → 只補/換組員，不動其他欄位
        // V2.4.xx：但「confirmed 卻缺實際 OOOI（in_utc 空）而檔案有」→ backfill 回填實際時間，
        //   或「過去資料還沒被分類成 sim/deadhead」→ 一併補上分類旗標。
        //   修正「過去航班一匯入就被標 confirmed，補了 OOOI 重匯卻被 skip、永遠補不進」的 bug。
        //   只在沒開 overwriteCrew 時走 backfill；回填用 COALESCE 只補空缺，旗標用 CASE 只補不清。
        //   ⚠ 必須「真的有缺」才 backfill，否則每次重匯都會跑無謂 UPDATE、灌水回填數（codex P1）。
        const needsOooi = !existing.inUtc && !!inUtc;
        const needsSimFlag = isSim && !existing.isSim;
        const needsDhdFlag = isDeadhead && !existing.isDeadhead;
        if (!opts.overwriteCrew && (needsOooi || needsSimFlag || needsDhdFlag)) { action = 'backfill_oooi'; existingId = existing.id; }
        else { action = opts.overwriteCrew ? 'overwrite_crew' : 'skip_confirmed'; existingId = existing.id; }
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
        position: action === 'skip_confirmed' ? null : position,
        deadhead: isDeadhead,
        pic_min: picMin,
        sic_min: sicMin,
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
      // overwrite_crew / backfill_oooi 不改 status（維持 confirmed），其餘用 newStatus；inUtc 一併更新供同檔後續 row 判斷
      // isSim/isDeadhead 也回寫：insert/update 取本次值；backfill 取「舊 OR 新」（只加不清）；skip/overwrite 維持舊值，
      //   讓同檔重複 sourceRef 的後續 row 看到分類已補、不會再被當成「待分類」重觸發（codex P1 延伸）
      const wrote = action === 'insert' || action === 'update';
      existingMap.set(sourceRef, {
        id: decidedId,
        status: (action === 'overwrite_crew' || action === 'backfill_oooi') ? existing!.status : newStatus,
        inUtc: (action === 'overwrite_crew') ? (existing ? existing.inUtc : null) : (inUtc ? inUtc.toISOString() : (existing ? existing.inUtc : null)),
        isSim: wrote ? isSim : ((existing?.isSim || false) || (action === 'backfill_oooi' && isSim)),
        isDeadhead: wrote ? isDeadhead : ((existing?.isDeadhead || false) || (action === 'backfill_oooi' && isDeadhead)),
      });

      if (opts.dryRun) continue;

      const crewJson = Object.keys(crew).length ? JSON.stringify(crew) : null;
      const approachesJson = approaches.length ? JSON.stringify(approaches) : null;
      const distanceVal = parseDecimalOrNull(row['Distance']);
      const paxVal = parseIntOrNull(row['Total Pax']);

      if (action === 'overwrite_crew') {
        // V1.3.24：只補/換組員 + PIC/SIC 時數 + position（SQL 用 COALESCE：檔案沒值就保留原值，不洗白）
        crewUpdateBatch.push({ id: decidedId, crewJson, picMin, sicMin, position });
      } else if (action === 'backfill_oooi') {
        // V2.4.xx：confirmed 航班的「補空缺 + 重分類」—— 實際時間欄 COALESCE 只補空缺；
        //   is_sim/is_deadhead 只在班號判定為 sim/PNC 時才設 TRUE（不會把正常航班洗成 sim/dhd）。
        //   不動 status / 組員 / 備註 / 起降數 / position 等你的編輯。
        backfillBatch.push({ id: decidedId, params: [outUtc, offUtc, onUtc, inUtc, blockMin, airMin, nightMin, stdUtc, staUtc, onDutyUtc, offDutyUtc, dutyMin, distanceVal, isSim, isDeadhead, needsCompletion] });
      } else if (action === 'update') {
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
            dTO, nTO,
            dLdg, nLdg,
            alands,
            paxVal, row['SID'] || null, row['STAR'] || null,
            row['Remarks'] || null,
            position,
            picMin, sicMin,
            isDeadhead,
            isPF,
            needsCompletion,
            isSim,                               // $39（UPDATE 末位）
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
          dTO, nTO,
          dLdg, nLdg,
          alands,
          paxVal, row['SID'] || null, row['STAR'] || null,
          row['Remarks'] || null,
          position,
          picMin, sicMin,
          isDeadhead,
          isSim,                               // is_sim（緊接 is_deadhead，對齊 INSERT_COLS 順序）
          isPF,
          needsCompletion,                     // needs_completion（INSERT_COLS 最後一欄；只有沒航線才 true）
        ]);
      }
    } catch (e: any) {
      console.warn('[pilot-log] flight import row error:', e.message);
      result.parse_errors++;
    }
  }

  // ── V2.4.xx cleanup（user：匯入順手把多餘的刪掉，不必清全部、不必重匯組員）──────────────
  //   只動 source='logten' + 沒鎖的：① 待命（flight_no SB/SBY[數字]）；② 同站來回（TPE↔TPE）訓練，
  //   但保留「日期最早一筆」當 local check。dry-run 只數不刪；實際匯入才真刪。
  const _tpeWhere = `user_id = $1 AND source = 'logten' AND origin IN ('TPE','RCTP') AND dest IN ('TPE','RCTP')`;
  const _keepSub = `(SELECT id FROM pilot_log_entries WHERE ${_tpeWhere} ORDER BY flight_date ASC, created_at ASC LIMIT 1)`;
  const _sbWhere = `user_id = $1 AND source = 'logten' AND is_locked IS NOT TRUE AND flight_no ~* '^SBY?[0-9]*$'`;
  const _trWhere = `${_tpeWhere} AND is_locked IS NOT TRUE AND id <> ${_keepSub}`;
  if (opts.dryRun) {
    // dry-run：到此為止，不寫 DB；只「數」會被清掉的既有垃圾，讓使用者先看數字
    try {
      const a = await pool.query(`SELECT COUNT(*)::int AS n FROM pilot_log_entries WHERE ${_sbWhere}`, [userId]);
      const b = await pool.query(`SELECT COUNT(*)::int AS n FROM pilot_log_entries WHERE ${_trWhere}`, [userId]);
      result.cleaned_standby = a.rows[0].n;
      result.cleaned_training = b.rows[0].n;
    } catch (e: any) { console.warn('[pilot-log] cleanup dry-run count error:', e.message); }
    return result;
  }
  // 實際匯入：cleanup 的 DELETE 改到「transaction 內、插入之後」執行（見下方 client TX）：
  //   codex P1 —— 若放在 BEGIN 之前，後面 insert 失敗 rollback，刪除卻已生效＝資料遺失。
  //   codex P2 —— 放在 insert 之後，_keepSub 會用「DB 既有＋這次新插入」一起算最早一筆，
  //     才能保證全域只留一筆 local check（否則檔案較晚的那筆會跟 DB 既有的並存成兩筆）。
  //   故這裡不再 early-return；一律開 TX（即使只有 cleanup 要做），讓刪除跟寫入同生共死。

  // ── 包進單一 transaction：要嘛全寫成功，要嘛全 ROLLBACK，避免 partial 狀態 ──
  // codex 提醒：原本 bulk INSERT 後接 UPDATE，若中途任一失敗會留下部分寫入。
  // 用 pool.connect() 拿單一 client，自己控制 BEGIN/COMMIT/ROLLBACK。
  const client = await pool.connect();
  let insertedCount = 0;
  let updatedCount = 0;
  let crewUpdatedCount = 0;
  let oooiBackfilledCount = 0;
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
           position = $33,
           pic_minutes = $34, sic_minutes = $35,
           is_deadhead = $36,
           pilot_flying = $37,
           needs_completion = $38,
           is_sim = $39,
           updated_at = NOW()
         WHERE id = $1`,
        [u.id, ...u.params]
      );
      updatedCount++;
    }

    // V1.3.24：overwriteCrew —— 對 confirmed 航班只補/換組員 + PIC/SIC 時數 + position。
    // COALESCE：檔案有值才覆蓋、沒值保留原值（crew 由檔案決定取代，pic/sic/position 只填不洗白）。
    for (const u of crewUpdateBatch) {
      await client.query(
        // crew 用 JSONB 合併（檔案的槽覆蓋、檔案沒提供的槽保留）而非整包取代 —— 避免把
        // 檔案這趟沒帶到的組員（手填的、或客艙）洗掉。檔案完全沒 crew（$2 null）→ 原封不動。
        // V1.3.37（codex）：拿掉「覆蓋組員」勾選、改成一律帶組員後，pic/sic/position 改「只補空缺」
        // COALESCE(現值, 檔案值) —— 現有值（你手改 / 已確認的）保留不動，只有原本空白才用檔案補。
        // 兼顧「保護手動修正」＋「補上缺的角色/時數」。
        `UPDATE pilot_log_entries SET
           crew = CASE WHEN $2::jsonb IS NULL THEN crew ELSE COALESCE(crew, '{}'::jsonb) || $2::jsonb END,
           pic_minutes = COALESCE(pic_minutes, $3),
           sic_minutes = COALESCE(sic_minutes, $4),
           position = COALESCE(position, $5),
           updated_at = NOW()
         WHERE id = $1`,
        [u.id, u.crewJson, u.picMin, u.sicMin, u.position]
      );
      crewUpdatedCount++;
    }

    // V2.4.xx：OOOI 回填 —— confirmed 卻缺實際時間的航班，用檔案值「只補空缺」(COALESCE)，
    //   不碰 status / 組員 / 備註 / 起降數 / position 等你的編輯。修「補了 OOOI 重匯卻被 skip」的 bug。
    for (const u of backfillBatch) {
      await client.query(
        `UPDATE pilot_log_entries SET
           out_utc = COALESCE(out_utc, $2), off_utc = COALESCE(off_utc, $3),
           on_utc = COALESCE(on_utc, $4), in_utc = COALESCE(in_utc, $5),
           block_minutes = COALESCE(block_minutes, $6), air_minutes = COALESCE(air_minutes, $7),
           night_minutes = COALESCE(night_minutes, $8),
           std_utc = COALESCE(std_utc, $9), sta_utc = COALESCE(sta_utc, $10),
           on_duty_utc = COALESCE(on_duty_utc, $11), off_duty_utc = COALESCE(off_duty_utc, $12),
           total_duty_minutes = COALESCE(total_duty_minutes, $13), distance_nm = COALESCE(distance_nm, $14),
           is_sim = CASE WHEN $15 THEN TRUE ELSE is_sim END,
           is_deadhead = CASE WHEN $16 THEN TRUE ELSE is_deadhead END,
           -- 重分類成 sim / 補齊 from-to 後，把舊的「待補強」狀態清掉（只清不重新標，避免洗掉你手動補完的）
           needs_completion = CASE WHEN $17 THEN needs_completion ELSE FALSE END,
           updated_at = NOW()
         WHERE id = $1`,
        [u.id, ...u.params]
      );
      oooiBackfilledCount++;
    }

    // ── 待補強合併：本次「完整航班」的 日期+出發時間 → 刪掉同一筆的舊待補強（之前缺資料、現在補好重匯）→ 不留兩筆。
    //   用 out_utc 配對（不依賴缺失的起降/航班號欄；codex P1-A）。待補強現在走正常 insert、已保留 out_utc。
    for (const key of completeKeys) {
      const ci = key.indexOf('|'); const d = key.slice(0, ci); const outIso = key.slice(ci + 1);
      if (outIso) {
        await client.query(
          `DELETE FROM pilot_log_entries WHERE user_id = $1 AND source = 'logten' AND needs_completion = TRUE
             AND flight_date = $2 AND out_utc = $3::timestamptz`,
          [userId, d, outIso]
        );
      }   // 無 out 的完整航班（極少）不做 date-only 合併，避免誤刪同日其他待補強
    }

    // ── V2.4.xx cleanup（在 TX 內、插入之後）：刪掉待命 + 同站訓練垃圾 ───────────────
    //   放這裡的兩個理由（codex）：① 跟寫入同生共死 —— import 失敗 rollback，刪除也一起回復，不會資料遺失。
    //   ② _keepSub 用「DB 既有 + 這次剛插入」一起算最早一筆 → 全域只留一筆 local check（檔案較晚的那筆也會被清掉）。
    {
      const sb = await client.query(`DELETE FROM pilot_log_entries WHERE ${_sbWhere}`, [userId]);
      const tr = await client.query(`DELETE FROM pilot_log_entries WHERE ${_trWhere}`, [userId]);
      result.cleaned_standby = sb.rowCount || 0;
      result.cleaned_training = tr.rowCount || 0;
    }

    await client.query('COMMIT');
    // 只有 COMMIT 成功才寫進 result；不然 ROLLBACK 後 DB 是空的，計數也該是 0
    result.inserted = insertedCount;
    result.updated = updatedCount;
    result.crew_overwritten = crewUpdatedCount;
    result.oooi_backfilled = oooiBackfilledCount;

    // V1.0.05 monitoring：成功匯入後寫 last_import_at（fire-and-forget，跟主 TX 解耦）
    // V2.4.xx：backfill-only / 只清理 的重匯也真的改了 pilot_log_entries，要一併更新時間戳（codex P3）
    if (insertedCount > 0 || updatedCount > 0 || crewUpdatedCount > 0 || oooiBackfilledCount > 0
        || (result.cleaned_standby || 0) > 0 || (result.cleaned_training || 0) > 0) {
      pool.query(
        `UPDATE pilot_users SET last_import_at = NOW() WHERE id = $1`,
        [userId]
      ).catch(() => { /* swallow */ });
    }
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
