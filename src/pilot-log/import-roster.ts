// Pilot Log v1 — Import from Roster
// 把 roster sync 抓到的 duties[] 變成 draft entries。
//
// TODO(V1.3.07+ / codex P1)：跨來源 draft→confirmed 自動接合還沒做。
// 目前 roster 寫入 source='roster' + ref `roster:flightNo:date:from:to:dutyIdx`；
// 而 import-logten.ts 找既有只查 source='logten' + `logten:date:flightNo:from:to`。
// 兩邊查不到 → LogTen 重匯時不會把 roster draft 接成 confirmed，會多一筆，目前要手動處理。
// 修法：import-logten.ts 的 existingMap lookup 多查一份 source='roster' 同 (date,flightNo,from,to)，
// 命中時 UPDATE 該 row 改 source='logten'+新 ref+confirmed 蓋過去，避免 dup。
//
// status 邏輯：
//   - 同 source_ref 已是 confirmed → skip（使用者已 finalize，不可覆蓋）
//   - 同 source_ref 已是 draft / roster_removed → 更新欄位，重設 status=draft（roster_removed 為舊資料相容）
//   - 沒有同 source_ref → 建新 draft
//   - 同期間內舊 draft 不在新 roster → 直接刪除（V2.1.03：本來要飛、後來改飛別班，舊的不留）
//   - 舊 confirmed 不在新 roster → 保留 confirmed（使用者飛過了）

import { randomUUID } from 'crypto';
import { getPool, ensureTables } from './schema.js';
import { normFlightNoKey } from './tw-fleet.js';   // V2.2.00：跨來源班號正規化（JX031 vs 031 視為同班）
import { normAirportKey } from './airport-codes.js';   // V2.3.04：機場 IATA/ICAO 正規化（TPE vs RCTP 視為同場）
import { CREW_CABIN_SLOTS } from './crew-slots.js';     // V2.3.04：班表空服員進 cabin1..20 槽

interface RosterCrewMember {
  position?: string;
  name?: string;
  staffId?: string;   // V1.3.12：CrewSync 班表組員帶的員編（generate-ics-headless 解析的 staffId）
  rank?: string;
  workCode?: string;
}

interface RosterFlight {
  flightNo: string;
  date?: string;
  origin: string;
  dest: string;
  depTime?: string;
  arrTime?: string;
  depTimeUtc?: string;
  arrTimeUtc?: string;
  position?: string;
  flightTime?: string;
  workCode?: string;
  crew?: RosterCrewMember[];
}

interface RosterDuty {
  duty: string;
  reportTime: string;
  endTime: string;
  flights: RosterFlight[];
}

export interface ImportRosterResult {
  inserted: number;
  updated: number;
  skipped_confirmed: number;
  marked_removed: number;
  crew_added?: number;   // V1.3.12：自動加進通訊錄的組員數
  skipped_existing?: number;   // V2.0.02：同航班已有「已完成」紀錄（LogTen/手動）→ 略過不重複建草稿
  crew_filled?: number;   // V2.2.00：把班表組員/POB/position「只補空缺」補進已完成航班的筆數
}

function normalizePosition(raw?: string): 'PIC' | 'SIC' | 'OBSERVER' | null {
  if (!raw) return null;
  const s = raw.toUpperCase().trim();
  if (/(CAP|PIC|CMD)/i.test(s)) return 'PIC';
  if (/(SFO|FO|SIC|FIRST OFFICER)/i.test(s)) return 'SIC';
  if (/(OBS|OBSERVER|JS)/i.test(s)) return 'OBSERVER';
  return null;
}

function parseUtc(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// V1.3.14：班表月份脈絡（年/月），用來補 CrewSync UTC 戳記缺的年份。
interface MonthCtx { year: number; month: number; }

// V1.3.14（bug fix）：CrewSync 雲端班表真實航班的 UTC 欄位是 "1610Z/17Jun" 這種格式
// （HHMM + Z + / + DD + Mmm，**沒有年份**）。舊 code 直接 new Date("1610Z/17Jun")，JS 會把
// 開頭 "1610" 當成西元 1610 年 → flight_date / std_utc 全爛 → 排序掉到列表尾被 200 筆上限切掉，
// 前端永遠看不到。這裡正確解析：年份從 ctx（班表月份 _rmonth）推算，跨年邊界校正。
function parseCrewSyncUtc(s: string | undefined, ctx?: MonthCtx): Date | null {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{2})(\d{2})\s*Z?\s*\/\s*(\d{1,2})\s*([A-Za-z]{3,})$/);
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10), dd = parseInt(m[3], 10);
    const monIdx = MONTHS.indexOf(m[4].slice(0, 3).toLowerCase());
    if (monIdx < 0 || !ctx) return null;
    let year = ctx.year;
    // 跨年邊界：Dec 班表帶 Jan leg → 隔年；Jan 班表帶 Dec leg → 前一年。
    if (ctx.month === 12 && monIdx === 0) year = ctx.year + 1;
    else if (ctx.month === 1 && monIdx === 11) year = ctx.year - 1;
    const d = new Date(Date.UTC(year, monIdx, dd, hh, mm));
    return isNaN(d.getTime()) ? null : d;
  }
  // 退回原生 Date（相容未來可能的 ISO 字串），但擋掉年份 < 1900 的明顯誤解析。
  const d = new Date(str);
  if (isNaN(d.getTime()) || d.getUTCFullYear() < 1900) return null;
  return d;
}

// V1.3.14：地面班/訓練的日期格式 "2026.Jun.10"（含年份），也吃 "2026.Jun.10 0900L"（取日期段）。
function parseDotDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})\.([A-Za-z]{3,})\.(\d{1,2})/);
  if (!m) return null;
  const monIdx = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (monIdx < 0) return null;
  const y = parseInt(m[1], 10), dd = parseInt(m[3], 10);
  const d = new Date(Date.UTC(y, monIdx, dd));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// V1.3.14：從 duty 取月份脈絡 —— 優先 _rmonth（"2026-06"），沒有才退回 reportTime 的日期段。
function dutyCtx(duty: RosterDuty): MonthCtx | undefined {
  const rm = (duty as any)._rmonth;
  if (typeof rm === 'string' && /^\d{4}-\d{2}$/.test(rm)) {
    return { year: parseInt(rm.slice(0, 4), 10), month: parseInt(rm.slice(5, 7), 10) };
  }
  const dd = parseDotDate(duty.reportTime);
  if (dd) return { year: parseInt(dd.slice(0, 4), 10), month: parseInt(dd.slice(5, 7), 10) };
  return undefined;
}

function flightDate(f: RosterFlight, ctx?: MonthCtx): string | null {
  // 真實航班：用 depTimeUtc（"1610Z/17Jun"）算 UTC 日期。
  const utc = parseCrewSyncUtc(f.depTimeUtc, ctx);
  if (utc) return utc.toISOString().slice(0, 10);
  // 地面班/訓練：date 或 depTime 帶 "2026.Jun.10"。
  const dot = parseDotDate(f.date) || parseDotDate(f.depTime);
  if (dot) return dot;
  // codex P2：退回原生 Date 解析，相容舊 client / 直接呼叫 API 帶 ISO 字串（reportTime/date 非
  // CrewSync 格式、又沒 _rmonth 的情境）。擋掉年份 < 1900 的誤解析 —— 就是這版要修的 "1610Z/17Jun"
  // 被當成西元 1610 年那個 bug，避免 fallback 又把它救成爛資料。
  for (const cand of [f.depTimeUtc, f.depTime, f.date]) {
    if (!cand) continue;
    const d = new Date(cand);
    if (!isNaN(d.getTime()) && d.getUTCFullYear() >= 1900) return d.toISOString().slice(0, 10);
  }
  return null;
}

function buildSourceRef(f: RosterFlight, dutyIdx: number, ctx?: MonthCtx): string | null {
  const date = flightDate(f, ctx);
  if (!date || !f.flightNo) return null;
  return `roster:${f.flightNo}:${date}:${f.origin || ''}:${f.dest || ''}:${dutyIdx}`;
}

// V1.3.12：每個 crew 槽存 {名字, rank, 員編}（rank 是「那班的快照」，完訓後新班會帶新 rank；
// 員編是穩定身分、串通訊錄用）。舊資料是純名字字串，前端讀取時相容。
interface CrewSlotVal { name: string; rank?: string; eid?: string; }
function crewVal(m: RosterCrewMember): CrewSlotVal {
  const rank = (m.rank || '').toUpperCase().trim();
  const eid = (m.staffId || '').trim();
  const v: CrewSlotVal = { name: m.name! };
  if (rank) v.rank = rank;
  if (eid) v.eid = eid;
  return v;
}

// V1.3.12：班表 position → 6 個固定槽。PIC→pic、OBS→obs、CIC→cic、
// 其餘駕駛艙（P1~P4/IS 會亂跳，不照號碼）→ 依出現順序填 crew2/crew3/crew4。
// 其他客艙（SC/CC/PC 等非 CIC）不進槽。內部 key 固定，前端顯示 label 可由使用者自訂。
// V1.3.14：解長程加強組員兩個 PIC 的 bug —— 以前碰到第 2 個 PIC 槽滿了、又是 else-if 不往下掉
// → 那個人（常常就是 logbook 本人）被整個丟掉。改成：駕駛艙先全部收集不丟人，再分槽；
// pic 槽用「本人優先」（這趟你是 PIC + 員編對得到本人 → pic 就是你，另一位機長改放 crew2），
// 其餘依序填 crew2/3/4。selfIds=本人員編集合、entryPosition=你這趟的角色。
function extractCrew(
  crew: RosterCrewMember[] | undefined,
  selfIds?: Set<string>,
  entryPosition?: 'PIC' | 'SIC' | 'OBSERVER' | null,
): Record<string, CrewSlotVal> | null {
  if (!crew || !crew.length) return null;
  const out: Record<string, CrewSlotVal> = {};
  const cockpit: RosterCrewMember[] = [];
  const cabin: RosterCrewMember[] = [];      // V2.3.04：客艙組員（非 CIC）收進 cabin1..20，不再丟掉
  for (const m of crew) {
    if (!m.name || !m.position) continue;
    const pos = m.position.toUpperCase();
    const rank = (m.rank || '').toUpperCase();
    if (/DHD|DEADHEAD/.test(pos)) continue;   // V1.3.12：搭便機的人沒操作這班，不進槽
    if (/CIC/.test(pos)) { if (!out.cic) out.cic = crewVal(m); else cabin.push(m); }
    else if (/OBS/.test(pos)) { if (!out.obs) out.obs = crewVal(m); else if (!out.obs2) out.obs2 = crewVal(m); }
    else if (/CAP|CMD|PIC/.test(pos) || /^P\d|^IS|SFO|FIRST OFFICER|^FO|SIC/.test(pos)
             || /CAP|SFO|FO|TFO|TCAP/.test(rank)) {
      cockpit.push(m);                         // 駕駛艙全收集，稍後分槽（不再當場丟人）
    }
    else cabin.push(m);                        // 其他客艙（SC/CC/PC…）→ cabin 槽（V2.3 編輯器已有 20 格）
  }
  // pic 槽：① 這趟你是 PIC 且你在駕駛艙名單（員編認本人）→ 放你；② 否則第一個 position 標 PIC 的人；
  //         ③ 再否則名單第一位。解兩個 PIC 時「哪個是你」的歧義。
  const isSelf = (m: RosterCrewMember) => !!selfIds && selfIds.has((m.staffId || '').trim());
  let picIdx = -1;
  if (entryPosition === 'PIC') picIdx = cockpit.findIndex(isSelf);
  if (picIdx < 0) picIdx = cockpit.findIndex((m) => /CAP|CMD|PIC/.test((m.position || '').toUpperCase()));
  if (picIdx < 0 && cockpit.length) picIdx = 0;
  if (picIdx >= 0) out.pic = crewVal(cockpit[picIdx]);
  // 其餘駕駛艙 → crew2..crew6（V2.3.04 跟上槽位擴充：原本只到 crew4，Relief 3/4 會被丟掉）
  const otherSlots = ['crew2', 'crew3', 'crew4', 'crew5', 'crew6'];
  let oi = 0;
  cockpit.forEach((m, i) => {
    if (i === picIdx) return;
    if (oi < otherSlots.length) out[otherSlots[oi++]] = crewVal(m);
  });
  // V2.3.04：客艙組員依出現順序填 cabin1..cabin20（超過 20 人才溢位丟棄）
  cabin.forEach((m, i) => { if (i < CREW_CABIN_SLOTS.length) out[CREW_CABIN_SLOTS[i]] = crewVal(m); });
  return Object.keys(out).length ? out : null;
}

// V1.3.12：哪些 roster 組員要自動進通訊錄 —— 跟 extractCrew 會進槽的角色一致：
// 駕駛艙（PIC/P1~P4/IS）+ OBS + CIC，不灌整批客艙（SC/CC/PC）。
function isLoggedCrew(m: RosterCrewMember): boolean {
  const pos = (m.position || '').toUpperCase();
  const rank = (m.rank || '').toUpperCase();
  if (!pos) return false;
  if (/DHD|DEADHEAD/.test(pos)) return false;   // V1.3.12：搭便機的人不進通訊錄
  if (/CIC|OBS|CAP|CMD|PIC/.test(pos)) return true;
  if (/^P\d|^IS|SFO|FIRST OFFICER|^FO|SIC/.test(pos)) return true;
  if (/CAP|SFO|FO|TFO|TCAP/.test(rank)) return true;
  return false;
}

// V1.3.12：把單一 roster 組員（以員編為主識別）upsert 進通訊錄。
// 純「加人不改人」：員編命中既有 → 不動使用者的聯絡人；員編沒命中但同名無員編剛好 1 筆
// → 補掛員編（避免重複）；都沒有 → 新建。回傳是否真的新增了一筆。
async function upsertCrewContact(
  pool: NonNullable<ReturnType<typeof getPool>>,
  userId: string,
  staffId: string | undefined,
  name: string,
): Promise<boolean> {
  const sid = (staffId || '').trim();
  if (sid) {
    const idMatch = await pool.query(
      `SELECT DISTINCT crew_id FROM crew_employee_ids WHERE user_id = $1 AND employee_id = $2`,
      [userId, sid]
    );
    if (idMatch.rows.length >= 1) return false;            // 員編已掛在某聯絡人 → 不動
    // 員編沒命中 → 試同名、且「沒掛任何員編」的聯絡人
    const nameMatch = await pool.query(
      `SELECT c.id FROM crew c
       WHERE c.user_id = $1 AND c.display_name = $2
         AND NOT EXISTS (SELECT 1 FROM crew_employee_ids e WHERE e.crew_id = c.id)`,
      [userId, name]
    );
    if (nameMatch.rows.length === 1) {
      // 把員編補掛上去（不改名）
      await pool.query(
        `INSERT INTO crew_employee_ids (crew_id, user_id, employee_id)
         VALUES ($1, $2, $3) ON CONFLICT (user_id, employee_id) DO NOTHING`,
        [nameMatch.rows[0].id, userId, sid]
      );
      return false;
    }
    if (nameMatch.rows.length > 1) return false;           // 多筆同名無員編 → 不猜
    // 都沒有 → 新建
    const crewId = randomUUID();
    await pool.query(`INSERT INTO crew (id, user_id, display_name) VALUES ($1, $2, $3)`, [crewId, userId, name]);
    // codex P2（並發）：員編有 UNIQUE(user_id, employee_id)。若同時另一個 import 已搶先掛了這個
    // 員編，這裡 ON CONFLICT 會 rowCount=0 → 我們剛建的 crew 就是孤兒，刪掉避免留重複聯絡人。
    const link = await pool.query(
      `INSERT INTO crew_employee_ids (crew_id, user_id, employee_id)
       VALUES ($1, $2, $3) ON CONFLICT (user_id, employee_id) DO NOTHING`,
      [crewId, userId, sid]
    );
    if (!link.rowCount) {
      await pool.query(`DELETE FROM crew WHERE id = $1`, [crewId]);
      return false;
    }
    return true;
  }
  // 沒員編 → 只靠名字；已存在（任意筆）就不重複建
  const exists = await pool.query(
    `SELECT 1 FROM crew WHERE user_id = $1 AND display_name = $2 LIMIT 1`,
    [userId, name]
  );
  if (exists.rows.length) return false;
  const crewId = randomUUID();
  await pool.query(`INSERT INTO crew (id, user_id, display_name) VALUES ($1, $2, $3)`, [crewId, userId, name]);
  return true;
}

/**
 * Import roster duties for a user.
 * @param userId pilot_users.id
 * @param duties roster duties from sync
 * @param dateRange { start, end } UTC dates — within range, draft entries not seen become roster_removed
 */
export async function importRoster(
  userId: string,
  duties: RosterDuty[],
  dateRange?: { start: string; end: string },
  months?: string[],          // V1.3.07 codex P2：實際同步的月份清單；給 → 只在這些月份做 roster_removed sweep，避免把沒同步的空檔月份（5/7 同步、6 沒同步）的舊 draft 誤殺
): Promise<ImportRosterResult> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) {
    return { inserted: 0, updated: 0, skipped_confirmed: 0, marked_removed: 0 };
  }

  const result: ImportRosterResult = {
    inserted: 0, updated: 0, skipped_confirmed: 0, marked_removed: 0, crew_added: 0, skipped_existing: 0, crew_filled: 0,
  };

  const seenRefs: string[] = [];
  // V1.3.12：跨整份班表蒐集「要進通訊錄」的組員，去重後再 upsert（一個人會出現在很多班）。
  // key：員編優先（穩定），沒員編退回 name:名字。
  const contacts = new Map<string, { staffId?: string; name: string }>();

  // V1.3.14：本人的員編（is_self 通訊錄聯絡人掛的所有 employee_id）。crew 分槽時用來認出「你自己」，
  // 把你擺進符合這趟 position 的槽（解長程兩個 PIC 你被丟掉/擺錯槽）。認不到就退回原本行為。
  const selfIds = new Set<string>();
  try {
    const sidQ = await pool.query(
      `SELECT e.employee_id FROM crew_employee_ids e
       JOIN crew c ON c.id = e.crew_id
       WHERE c.user_id = $1 AND c.is_self = true`,
      [userId]
    );
    for (const r of sidQ.rows) { const s = (r.employee_id || '').trim(); if (s) selfIds.add(s); }
  } catch (e) { /* 認不到本人員編 → selfIds 空，extractCrew 退回 position 規則 */ }

  // 「純班表草稿」判定（codex P1）：draft ≠ 沒碰過 —— 使用者可在 draft 上補很多手動欄位但 status 仍是 draft。
  // 只有「所有手動欄位都還是空 / 預設」的純草稿才能安全直接刪；只要動過任何一個一律保留。
  // 班表本來就帶的欄位（position/std/sta/duty/crew/deadhead/crew_count）不納入判定。
  // 涵蓋全部手動欄位（schema 對照）：OOOI、機號、機型、時數(block/air/night/pic/sic)、距離、duty分鐘、
  // approaches、起降(day/night takeoffs+landings)、autolands、pax、SID/STAR、remarks、pilot_flying。
  // （V2.3.04 從 sweep 區搬上來：主迴圈的同班合併也要用）
  const UNTOUCHED =
    "out_utc IS NULL AND off_utc IS NULL AND on_utc IS NULL AND in_utc IS NULL" +
    " AND COALESCE(tail_no,'')='' AND COALESCE(aircraft_type,'')='' AND COALESCE(remarks,'')=''" +
    " AND COALESCE(sid,'')='' AND COALESCE(star,'')=''" +
    " AND block_minutes IS NULL AND air_minutes IS NULL AND night_minutes IS NULL" +
    " AND pic_minutes IS NULL AND sic_minutes IS NULL AND distance_nm IS NULL" +
    " AND total_duty_minutes IS NULL AND pax_count IS NULL AND pilot_flying IS NULL AND approaches IS NULL" +
    " AND COALESCE(day_takeoffs,0)=0 AND COALESCE(night_takeoffs,0)=0" +
    " AND COALESCE(day_landings,0)=0 AND COALESCE(night_landings,0)=0 AND COALESCE(autolands,0)=0";

  // codex P2（V2.3.04）：同日同班號同航線可能有兩腿（罕見但合法）。正規化比對會把兩腿看成同一班
  // → 第二腿誤併掉第一腿、永遠少一筆。解法：「已認領」集合 —— 這輪匯入中，每筆既有列只能被一腿
  // 認走（合併/補組員/刪除都算），第二腿配不到未認領的列就走正常新增，兩腿各自保留。
  const consumedIds = new Set<string>();

  // codex P1（V2.3.04）：雙腿邊角的第二層防護 —— 一筆既有列的 source_ref 若正好是「本批另一腿」
  // 的 ref，那是那腿自己的列，不可被這腿 fuzzy 搶走（會把那腿使用者編輯過的資料覆寫成這腿的）。
  // dutyIdx 漂移留下的舊列 ref 形狀跟本批不同、不在集合內 → 照常可被 fuzzy 認領（自癒不受影響）。
  const batchRefs = new Set<string>();
  // codex P1 round3（V2.3.04）：同 key（日+正規化班號+起降）在本批出現 ≥2 腿 → 該 key 完全停用
  // fuzzy 比對、只認 exact source_ref。雙腿情境下 fuzzy 無論怎麼挑都可能挑錯腿（subset 匯入 / ref
  // 漂移組合無法分辨），寧可留一筆重複草稿也不覆寫/誤刪另一腿。單腿 key（絕大多數）自癒不受影響。
  const normKeyOf = (date: string | null, fno?: string, o?: string, d?: string): string | null => {
    if (!date) return null;
    const k = normFlightNoKey(fno || '');
    return k ? date + '|' + k + '|' + normAirportKey(o) + '|' + normAirportKey(d) : null;
  };
  const batchKeyCount = new Map<string, number>();
  for (let di = 0; di < duties.length; di++) {
    const dctx = dutyCtx(duties[di]);
    for (const ff of (duties[di].flights || [])) {
      const ref = buildSourceRef(ff, di, dctx);
      if (ref) batchRefs.add(ref);
      const kk = normKeyOf(flightDate(ff, dctx), ff.flightNo, ff.origin, ff.dest);
      if (kk) batchKeyCount.set(kk, (batchKeyCount.get(kk) || 0) + 1);
    }
  }

  for (let dutyIdx = 0; dutyIdx < duties.length; dutyIdx++) {
    const duty = duties[dutyIdx];
    // V1.3.14：班表月份脈絡（補 CrewSync UTC 戳記缺的年份）。
    const ctx = dutyCtx(duty);
    const onDuty = parseUtc(duty.reportTime);
    const offDuty = parseUtc(duty.endTime);
    const flights = duty.flights || [];

    for (const f of flights) {
      // V1.3.14：地面班/訓練（FSM/S5C 等，無起訖地）不進飛行 logbook，只匯真實航班。
      if (!f.origin && !f.dest) continue;

      const sourceRef = buildSourceRef(f, dutyIdx, ctx);
      if (!sourceRef) continue;

      const fDate = flightDate(f, ctx);
      if (!fDate) continue;

      // V1.3.13：月份篩選 —— 只處理 months 內的航班，但**仍迭代整份 duties**讓 dutyIdx 維持全域。
      // source_ref 含全域 dutyIdx：subset 重匯若改變陣列就會換 ref → 重複 + 誤標 removed（codex P1）。
      // 傳完整 duties + 用 months 過濾處理，subset 與全匯產出完全相同的 ref。
      // codex P1（boundary）：用 duty 標記的「roster 月份」(_rmonth) 比對，不用航班 UTC 日期 ——
      // 6 月班表裡 UTC 落在 5/31 的 leg 仍屬 6 月，用 UTC 日期會誤漏。沒標 _rmonth 才退回 fDate。
      const rosterMonth = (duty as any)._rmonth || fDate.slice(0, 7);
      if (months && months.length && months.indexOf(rosterMonth) < 0) continue;
      seenRefs.push(sourceRef);

      const stdUtc = parseCrewSyncUtc(f.depTimeUtc, ctx);
      const staUtc = parseCrewSyncUtc(f.arrTimeUtc, ctx);
      const position = normalizePosition(f.position || f.workCode);
      const crewJson = extractCrew(f.crew, selfIds, position);
      // V1.3.36：班表帶的組員人數當 crew_count 初值（POB 用）。只在「新建」帶入，
      // 之後使用者可自行編輯（含補後艙空服）；re-import 不覆寫，保留使用者改的值。
      // V2.2.00（codex P1）：宣告提前到這裡 —— 下方跨來源補組員分支會用到，原本在分支之後宣告 → TDZ。
      const crewCount = (f.crew && f.crew.length) ? f.crew.length : null;
      // V1.3.12：DHD（搭便機 positioning）→ 標 deadhead，照建 entry 但飛時/PIC/night 全不計
      const isDeadhead = /DHD|DEADHEAD|POSITIONING/i.test((f.position || '') + ' ' + (f.workCode || ''));
      // V1.3.12：蒐集要進通訊錄的組員（去重）
      for (const m of (f.crew || [])) {
        if (!m.name || !isLoggedCrew(m)) continue;
        const sid = (m.staffId || '').trim();
        const key = sid ? 'id:' + sid : 'name:' + m.name;
        if (!contacts.has(key)) contacts.set(key, { staffId: sid || undefined, name: m.name });
      }

      // ── V2.3.04「同班」比對重寫 ───────────────────────────────────────────
      // 班號用 normFlightNoKey（V2.2.00 既有：JX031 vs 031 vs JX31 同班）+ 機場用 normAirportKey
      // （新增：班表帶 IATA `TPE`、LogTen 帶 ICAO `RCTP`，舊版字面比對永遠對不上 → 半年航班全部
      // 重複兩份的實案）。同日同班號同起降（正規化後）就視為同一班。
      const fnKey = normFlightNoKey(f.flightNo);
      const oKey = normAirportKey(f.origin), dKey = normAirportKey(f.dest);
      // codex P1 round4：fuzzy 多一道「表定起飛時間相近（±4h）」條件 —— 同日同班號同航線的「真雙腿」
      // 表定時間差好幾小時、不會互相誤認（含 DB 已有兩腿、之後只重匯其中一腿的 subset 情境）；
      // 漂移殘留的重複是同一班、表定相同 → 照樣合併。任一邊沒有時間（理論上 roster 真航班必有
      // depTimeUtc、logten 必有 out_utc）才退回不限制。
      const fStdMs = stdUtc ? stdUtc.getTime() : null;
      const timeOk = (r: { std_utc?: any; out_utc?: any }) => {
        if (fStdMs == null) return true;
        const raw = r.std_utc || r.out_utc;
        if (!raw) return true;
        const t = new Date(raw).getTime();
        return isNaN(t) || Math.abs(t - fStdMs) <= 4 * 3600 * 1000;
      };
      const isSameFlight = (r: { flight_no?: string; origin?: string; dest?: string; std_utc?: any; out_utc?: any }) =>
        !!fnKey && normFlightNoKey(r.flight_no || '') === fnKey
        && normAirportKey(r.origin) === oKey && normAirportKey(r.dest) === dKey
        && timeOk(r);

      // roster 自家既有列：exact source_ref **或** 正規化同班都算同一班。
      // 後者解 dutyIdx 漂移：單匯 6 月 vs 整批匯 1-6 月，duty 順序不同 → source_ref 變
      // → 舊版查 exact ref 落空又建一筆（使用者動過的舊草稿 sweep 不會清 → 雙胞胎實案）。
      const rosterRowsQ = await pool.query(
        `SELECT id, status, source_ref, flight_no, origin, dest, std_utc, (${UNTOUCHED}) AS untouched
         FROM pilot_log_entries WHERE user_id = $1 AND source = 'roster' AND flight_date = $2`,
        [userId, fDate]
      );
      // 雙腿 key（本批同 key ≥2 腿）→ fuzzy 全關，只認 exact ref（見 batchKeyCount 註解）。
      const dualLeg = (batchKeyCount.get(normKeyOf(fDate, f.flightNo, f.origin, f.dest) || '') || 0) > 1;
      const rosterMatches = rosterRowsQ.rows.filter(
        (r: any) => !consumedIds.has(r.id)
          && (r.source_ref === sourceRef
              || (!dualLeg && isSameFlight(r) && !batchRefs.has(r.source_ref)))
      );

      // V2.0.02（codex P1）：跨來源查重 —— 同一天同班若已有「已完成」紀錄（LogTen/手動/LogATP，
      // confirmed 或有實際落地 in_utc），就不要 roster 草稿重複。
      // 命中時把班表帶的「組員 / POB / position」只補空缺（COALESCE / 既有槽優先）到那筆已完成航班，
      // 補上 logbook 來源常缺的加強組員、CIC、觀察員、空服員、後艙人數（不洗掉使用者既有資料）。
      {
        const cand = await pool.query(
          `SELECT id, flight_no, origin, dest, std_utc, out_utc FROM pilot_log_entries
           WHERE user_id = $1 AND flight_date = $2
             AND source <> 'roster' AND (status = 'confirmed' OR in_utc IS NOT NULL)`,
          [userId, fDate]
        );
        const dupRow = cand.rows.find((r: any) => !consumedIds.has(r.id) && isSameFlight(r));
        if (dupRow) {
          consumedIds.add(dupRow.id);
          if (crewJson || crewCount != null || position) {
            try {
              await pool.query(
                `UPDATE pilot_log_entries SET
                   crew = CASE WHEN $2::jsonb IS NULL THEN crew ELSE $2::jsonb || COALESCE(crew, '{}'::jsonb) END,
                   position = COALESCE(position, $3),
                   crew_count = COALESCE(crew_count, $4),
                   updated_at = NOW()
                 WHERE id = $1`,
                [dupRow.id, crewJson ? JSON.stringify(crewJson) : null, position, crewCount]
              );
              result.crew_filled = (result.crew_filled || 0) + 1;
            } catch (e) { /* 補組員失敗不擋整個匯入 */ }
          }
          // 對應的 roster 草稿清掉（不只 exact ref —— 舊版機場比不上時留下的重複草稿一併自癒）。
          // codex P2：只刪「沒動過」的純草稿 —— 動過的保留，寧可留一筆重複也不丟使用者手動補的資料。
          for (const r of rosterMatches) {
            if (r.status !== 'confirmed' && r.untouched) {
              await pool.query('DELETE FROM pilot_log_entries WHERE id = $1', [r.id]);
              consumedIds.add(r.id);
            }
          }
          result.skipped_existing = (result.skipped_existing || 0) + 1;
          continue;
        }
      }

      const confirmedMatch = rosterMatches.find((r: any) => r.status === 'confirmed');
      if (confirmedMatch) {
        // 同班已被使用者 confirm → 不動它也不再建草稿；多餘「沒動過」的重複草稿順手清掉（自癒）
        consumedIds.add(confirmedMatch.id);
        for (const r of rosterMatches) {
          if (r.id !== confirmedMatch.id && r.status !== 'confirmed' && r.untouched) {
            await pool.query('DELETE FROM pilot_log_entries WHERE id = $1', [r.id]);
            consumedIds.add(r.id);
          }
        }
        result.skipped_confirmed++;
      } else if (!rosterMatches.length) {
        // 新 draft
        await pool.query(
          `INSERT INTO pilot_log_entries
           (id, user_id, source, source_ref, status, flight_date, flight_no, origin, dest,
            position, std_utc, sta_utc, on_duty_utc, off_duty_utc, crew, is_deadhead, roster_month, crew_count)
           VALUES ($1, $2, 'roster', $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            randomUUID(), userId, sourceRef, fDate, f.flightNo, f.origin, f.dest,
            position, stdUtc, staUtc, onDuty, offDuty, crewJson ? JSON.stringify(crewJson) : null, isDeadhead, rosterMonth, crewCount,
          ]
        );
        result.inserted++;
      } else {
        // 既有草稿 → 合併成一筆：挑主列（動過的優先 → exact ref → 第一筆），其餘「沒動過」的刪掉。
        // 動過的優先 = 使用者手動補的機號/時數那筆活下來；多筆都動過則只更新主列、其餘保留（不敢亂合）。
        const touched = rosterMatches.filter((r: any) => !r.untouched);
        const primary =
          (touched.find((r: any) => r.source_ref === sourceRef) || touched[0]) ||
          rosterMatches.find((r: any) => r.source_ref === sourceRef) || rosterMatches[0];
        consumedIds.add(primary.id);
        for (const r of rosterMatches) {
          if (r.id !== primary.id && r.untouched) {
            await pool.query('DELETE FROM pilot_log_entries WHERE id = $1', [r.id]);
            consumedIds.add(r.id);
          }
        }
        // draft 或 roster_removed → 更新並重設 draft
        // codex P2：原本用 COALESCE 會卡住已 non-null 的欄位（gate 改了/duty 改了/組員換了
        // 都不會反映）。改成直接覆寫 — 班表是新鮮的就該蓋舊的。
        // V2.3.04：source_ref 同步更新成這次的 ref，下次重匯 exact 命中、sweep 也對得上。
        await pool.query(
          `UPDATE pilot_log_entries SET
             status = 'draft',
             source_ref = $15,
             flight_date = $2, flight_no = $3, origin = $4, dest = $5,
             position = $6,
             std_utc = $7, sta_utc = $8,
             on_duty_utc = $9,
             off_duty_utc = $10,
             crew = $11::jsonb,
             is_deadhead = $12,
             roster_month = $13,
             crew_count = COALESCE(crew_count, $14),
             updated_at = NOW()
           WHERE id = $1`,
          [
            primary.id, fDate, f.flightNo, f.origin, f.dest,
            position, stdUtc, staUtc, onDuty, offDuty,
            crewJson ? JSON.stringify(crewJson) : null, isDeadhead, rosterMonth, crewCount, sourceRef,
          ]
        );
        result.updated++;
      }
    }
  }

  // V1.3.12：把蒐集到的組員 upsert 進通訊錄（員編優先、純加人不改人）。
  // 包 try/catch：通訊錄寫失敗不該讓整個班表匯入炸掉。
  for (const c of contacts.values()) {
    try {
      if (await upsertCrewContact(pool, userId, c.staffId, c.name)) result.crew_added = (result.crew_added || 0) + 1;
    } catch (e) { /* 個別組員寫入失敗略過 */ }
  }

  // 這次有匯入的月份內、舊 draft 沒在新班表 → 直接刪掉（V2.1.03：不再標 roster_removed）。
  // codex P2：必須「per-month」sweep — 若同步了 5/7 但沒同步 6，連續 dateRange 會把 6 月舊
  // draft 全部誤刪。優先用 months（每月各自掃），沒給才退回單一 dateRange（舊行為）。
  const sweeps: Array<{ month: string | null; start: string; end: string }> = [];
  if (months && months.length) {
    for (const ym of months) {
      const parts = ym.split('-');
      if (parts.length !== 2) continue;
      const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
      if (!y || !m) continue;
      const nextMonth1st = new Date(Date.UTC(y, m, 1));                  // m 為 1-base：等同下個月 1 號
      const lastDay = new Date(nextMonth1st.getTime() - 24 * 3600 * 1000);
      sweeps.push({ month: ym, start: ym + '-01', end: lastDay.toISOString().slice(0, 10) });
    }
  } else if (dateRange) {
    sweeps.push({ month: null, start: dateRange.start, end: dateRange.end });
  }
  // V1.3.14（codex P1 修正）：改用 roster_month 精準掃除 —— 一筆屬於哪個月班表，import 時已記在
  // roster_month，所以「6 月班表的 SEA→TPE 回程（flight_date 落在 7/1）」會被 6 月 sweep 正確掃到，
  // 又不會誤動到真正屬於 7 月班表的 draft（它 roster_month='2026-07'）。舊資料 roster_month 為 NULL
  // → 退回原本的 flight_date 區間掃（非邊界腿都涵蓋；下次重匯就會補上 roster_month、自動升級成精準掃）。
  // UNTOUCHED 定義已搬到主迴圈前（V2.3.04）—— sweep 與同班合併共用。
  for (const sw of sweeps) {
    // 班表變更：這次匯入的月份內，舊「純草稿」不在新班表 → 直接刪掉（不留「已移除」狀態；動過的保留）。
    const r = sw.month
      ? await pool.query(
          `DELETE FROM pilot_log_entries
           WHERE user_id = $1
             AND source = 'roster'
             AND status = 'draft'
             AND ${UNTOUCHED}
             AND NOT (source_ref = ANY($5::text[]))
             AND (
               roster_month = $2
               OR (roster_month IS NULL AND flight_date >= $3 AND flight_date <= $4)
             )`,
          [userId, sw.month, sw.start, sw.end, seenRefs]
        )
      : await pool.query(
          `DELETE FROM pilot_log_entries
           WHERE user_id = $1
             AND source = 'roster'
             AND status = 'draft'
             AND ${UNTOUCHED}
             AND flight_date >= $2 AND flight_date <= $3
             AND NOT (source_ref = ANY($4::text[]))`,
          [userId, sw.start, sw.end, seenRefs]
        );
    result.marked_removed += r.rowCount || 0;
  }

  // V1.3.14（self-heal）：清掉舊版 parse bug 留下的爛 draft —— 真實航班的 depTimeUtc（"1610Z/17Jun"）
  // 被 new Date 誤判成西元 1610 等 → flight_date 年份 < 2000，排序掉到列表尾被 200 筆上限切掉、永遠看不到。
  // 這些是 draft、從沒 confirmed，純垃圾，直接刪不留。重匯時自動修好，受影響的人都一併自癒。
  try {
    await pool.query(
      `DELETE FROM pilot_log_entries
       WHERE user_id = $1 AND source = 'roster' AND status = 'draft' AND flight_date < DATE '2000-01-01'`,
      [userId]
    );
  } catch (e) { /* 清理失敗不該擋住整個匯入 */ }

  // V2.1.03：roster_removed 狀態已停用（班表變更改成直接刪）。清掉舊版殘留的 roster_removed，
  // 但只刪「純草稿」的（沒手動痕跡）；舊版若把使用者編輯過的航班標成 roster_removed → 原狀保留、不刪也不動
  // （codex P2：不要無條件復活成 draft，否則匯入任一月份會把跨月、刻意移除的舊編輯紀錄又叫回 active 清單）。
  try {
    await pool.query(
      `DELETE FROM pilot_log_entries WHERE user_id = $1 AND source = 'roster' AND status = 'roster_removed' AND ${UNTOUCHED}`,
      [userId]
    );
  } catch (e) { /* 清理失敗不該擋住整個匯入 */ }

  return result;
}
