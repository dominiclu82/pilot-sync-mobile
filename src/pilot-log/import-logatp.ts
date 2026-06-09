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

// ── Log ATP 2「system data」(Realm 資料庫原始匯出)支援 ──────────────────────
//   欄名是 camelCase(flightDate/departure…)、OOOI 是 Unix epoch 秒、Block/Flight/Night 是分鐘、
//   crew1~4 是 Realm objectId(要配 crew 檔對成名字)。做法:把每列「正規化」成可讀格式的 row,
//   後面整套處理(防重/insert)沿用不改。偵測:headers 有 flightDate 但沒有 'Flight Date'。
function isSystemDataHeaders(headers: string[]): boolean {
  return headers.includes('flightDate') && headers.includes('departure') && !headers.includes('Flight Date');
}
// Unix epoch 秒(float)→ UTC 'HH:MM';0 / 0.0 / 空 = 缺(回空字串,讓上層當沒填)
function epochToHHMM(v: string): string {
  const n = parseFloat(String(v == null ? '' : v).trim());
  if (!isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
// Unix epoch 秒 → UTC 'YYYY-MM-DD'(那刻的真實 UTC 日期)。日期錨在 out 這刻 → 不管幾點起飛、跨不跨 UTC 午夜都對。
function epochToUTCDate(v: string): string {
  const n = parseFloat(String(v == null ? '' : v).trim());
  if (!isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
// 分鐘整數 → 'HH:MM'(blockTime=192 → '03:12');空/負 = 缺
function minToHHMM(v: string): string {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  if (!isFinite(n) || n < 0) return '';
  return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
}
// 'true'/'false' → 'TRUE'/'FALSE'(isTrue 認 'TRUE')。picTime 也走這支:實際資料一律 boolean('false'),
// 不揣測「分鐘數>0 當 PIC」——否則萬一是分鐘數會把整段 block 灌成 PIC、誇大 pic_minutes(codex P1)。boolean 才安全。
function boolToTrue(v: string): string { return String(v == null ? '' : v).trim().toLowerCase() === 'true' ? 'TRUE' : 'FALSE'; }
// crew 檔(objectId,firstName,lastName,…,isSelf)→ map: objectId → {name, isSelf}
function buildCrewMap(crewText?: string): Record<string, { name: string; isSelf: boolean }> {
  const map: Record<string, { name: string; isSelf: boolean }> = {};
  if (!crewText) return map;
  const { rows } = parseCsv(crewText);
  for (const r of rows) {
    const id = (r['objectId'] || '').trim();
    if (!id) continue;
    const name = cleanName((r['firstName'] || '') + ' ' + (r['lastName'] || ''));   // 中文「瑞棋 陳」/西文全名;空格收斂
    map[id] = { name, isSelf: String(r['isSelf'] || '').trim().toLowerCase() === 'true' };
  }
  return map;
}
const SYSDATA_HEADERS = ['Object ID', 'Flight Date', 'Departure', 'Destination', 'Aircraft Registration', 'Flight Number', 'Aircraft Type', 'Out time', 'Off time', 'On time', 'In time', 'Total Block Time', 'Total Flight Time', 'Night Time', 'PF Takeoff', 'PF Landing', 'PIC', 'Autoland', 'Diverted', 'Go around', 'Crew 1', 'Crew 2', 'Crew 3', 'Crew 4'];
// 把 system-data 列正規化成可讀格式的 row(crew1~4 用 crewMap 對名字、排除本人 isSelf)
function normalizeSystemData(rows: Record<string, string>[], crewText?: string): { headers: string[]; rows: Record<string, string>[] } {
  const crewMap = buildCrewMap(crewText);
  const out = rows.map((sr) => {
    const r: Record<string, string> = {};
    // 防重 source_ref 用:objectId 優先;空的(此格式常見)退用 realmID(每列都有、Realm 主鍵、穩定唯一)
    //   → 重匯 idempotent,不會因列序變動而重複(codex P1)。兩者都空才落到下游含列序的 fallback。
    r['Object ID'] = (sr['objectId'] || '').trim() || (sr['realmID'] || '').trim();
    // 日期錨在 out 這刻的真實 UTC 日期 → 不管幾點起飛、跨不跨 UTC 午夜,
    //   後面 parseHmAtDate(date, HH:MM) 配 epoch 還原的時刻一定落在對的那天(off/on/in 跨午夜由 +1day 邏輯接)。
    //   退路:沒 outTime 才用 flightDate 欄。
    r['Flight Date'] = epochToUTCDate(sr['outTime']) || (sr['flightDate'] || '').trim();
    r['Departure'] = sr['departure'] || '';
    r['Destination'] = sr['destination'] || '';
    r['Aircraft Registration'] = sr['aircraftRegistration'] || '';
    r['Flight Number'] = sr['flightNumber'] || '';
    r['Aircraft Type'] = sr['aircraftType'] || '';
    r['Out time'] = epochToHHMM(sr['outTime']);
    r['Off time'] = epochToHHMM(sr['offTime']);
    r['On time'] = epochToHHMM(sr['onTime']);
    r['In time'] = epochToHHMM(sr['inTime']);
    r['Total Block Time'] = minToHHMM(sr['blockTime']);
    r['Total Flight Time'] = minToHHMM(sr['flightTime']);
    r['Night Time'] = minToHHMM(sr['nightTime']);
    r['PF Takeoff'] = boolToTrue(sr['pfTakeoff']);
    r['PF Landing'] = boolToTrue(sr['pfLanding']);
    r['PIC'] = boolToTrue(sr['picTime']);
    r['Autoland'] = boolToTrue(sr['autoland']);
    r['Diverted'] = boolToTrue(sr['diverted']);
    r['Go around'] = boolToTrue(sr['goAround']);
    // crew1 = PIC slot:下游把 Crew 1 當機長(pic),所以「固定」放 crew1(本人即 PIC 時留空,不把自己列成機長)。
    //   ⚠ 不可把其餘 crew compact 進 Crew 1 → 否則本人是 PIC 那趟,副駕會被誤標機長(codex P2)。
    const c1 = crewMap[String(sr['crew1'] == null ? '' : sr['crew1']).trim()];
    r['Crew 1'] = (c1 && !c1.isSelf && c1.name) ? c1.name : '';
    // crew2~4:排除本人後 compact 進 Crew 2~4(這幾格無 PIC 語意,壓掉空格較乾淨)
    const rest: string[] = [];
    for (const id of [sr['crew2'], sr['crew3'], sr['crew4']]) {
      const c = crewMap[String(id == null ? '' : id).trim()];
      if (c && !c.isSelf && c.name) rest.push(c.name);
    }
    for (let i = 0; i < 3; i++) r['Crew ' + (i + 2)] = rest[i] || '';
    return r;
  });
  return { headers: SYSDATA_HEADERS, rows: out };
}

// 給單元測試用(不影響正式流程)
export const _logatpTestHooks = { parseCsv, isSystemDataHeaders, normalizeSystemData, epochToHHMM, epochToUTCDate, minToHHMM, buildCrewMap, parseHmAtDate };

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
  'needs_completion',                          // 待補強：缺起降但完整保留資料、補完轉綠
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
  needs_completion?: number;        // 待補強：有日期、缺起降 → 收為 needs_completion，不丟棄
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
  opts: { dryRun?: boolean } = {},
  crewText?: string   // Log ATP 2 system data 用:crew 檔(把 crew1~4 的 Realm ID 對成名字)
): Promise<ImportLogatpResult> {
  const empty: ImportLogatpResult = {
    inserted: 0, updated: 0, duplicate_skipped: 0, cross_source_skipped: 0,
    code_backfilled: 0, parse_errors: 0, needs_completion: 0,
  };
  const pool = getPool();
  if (!pool || !(await ensureTables())) return { ...empty, error: 'database_unavailable' };

  let { headers, rows } = parseCsv(text);
  if (isSystemDataHeaders(headers)) {   // Log ATP 2 system data(Realm 原始匯出,camelCase)→ 正規化成可讀格式,後面流程不變
    // 防靜默資料流失:航班列帶了組員 ID、卻沒附組員檔 → 名字對不回來會被清空還報成功。直接擋下提示補檔(codex P2)。
    //   (純無組員的 system data 不受影響:本來就沒 ID,允許只匯航班。)
    const hasCrewIds = rows.some((r) => (r['crew1'] || r['crew2'] || r['crew3'] || r['crew4'] || '').trim());
    const hasCrewFile = !!(crewText && crewText.trim());
    if (hasCrewIds && !hasCrewFile) return { ...empty, error: 'system_data_needs_crew_file' };
    const norm = normalizeSystemData(rows, crewText);
    headers = norm.headers; rows = norm.rows;
  }
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { result.parse_errors++; continue; }   // 日期壞 → flight_date NOT NULL，收不進

      const tailRaw = row['Aircraft Registration'] || '';
      const tail = formatTail(tailRaw);                                  // 存：B-xxxxx
      const fnRaw = row['Flight Number'] || '';
      const flightNo = resolveFlightNo(fnRaw, tailRaw);                  // 存：帶代碼、原樣
      const acType = (row['Aircraft Type'] || '').trim().toUpperCase();

      // 缺起降 → 待補強：仍完整解析、保留所有時間/組員資料（codex P1-B），標 needs_completion。
      //   source_ref 用 Object ID（穩定、不依賴缺失欄位）→ 補好重匯同 objId 自然 UPDATE 合併，不會變兩筆。
      const incomplete = !origin || !dest;
      if (incomplete) result.needs_completion = (result.needs_completion || 0) + 1;
      else if (flightNo && !/^[A-Z]/.test(String(fnRaw).trim().toUpperCase()) && /^[A-Z]/.test(flightNo)) result.code_backfilled++;

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

      // 待補強用 draft（否則重匯會被 skip_confirmed 跳過、補好的資料更新不進來）；完整航班照原本 confirmed。
      const status: 'draft' | 'confirmed' = incomplete ? 'draft' : 'confirmed';   // LogATP 完整列都是已飛的歷史
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
        incomplete,                          // needs_completion（INSERT_COLS 最後一欄；update 用 $37）
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
           status = CASE WHEN $37 THEN 'draft' ELSE 'confirmed' END, flight_date=$2, flight_no=$3, origin=$4, dest=$5,
           aircraft_type=$6, tail_no=$7,
           std_utc=$8, sta_utc=$9, out_utc=$10, off_utc=$11, on_utc=$12, in_utc=$13,
           block_minutes=$14, air_minutes=$15, night_minutes=$16, distance_nm=$17,
           on_duty_utc=$18, off_duty_utc=$19, total_duty_minutes=$20,
           crew=$21::jsonb, approaches=$22::jsonb,
           day_takeoffs=$23, night_takeoffs=$24, day_landings=$25, night_landings=$26, autolands=$27,
           pax_count=$28, sid=$29, star=$30, remarks=$31,
           position=$32, pic_minutes=$33, sic_minutes=$34, is_deadhead=$35, pilot_flying=$36,
           needs_completion=$37,
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
    // 待補強：走正常 insert/update（帶 needs_completion 旗標、保留所有資料）；source_ref=Object ID 穩定，
    //   補好重匯同 objId 自然 UPDATE 合併、不會變兩筆 → 不需額外 reconcile。
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
