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
//   - 同 source_ref 已是 draft / roster_removed → 更新欄位，重設 status=draft
//   - 沒有同 source_ref → 建新 draft
//   - 同期間內舊 draft 不在新 roster → 改 roster_removed（保留歷史）
//   - 舊 confirmed 不在新 roster → 保留 confirmed（使用者飛過了）

import { randomUUID } from 'crypto';
import { getPool, ensureTables } from './schema.js';

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

function flightDate(f: RosterFlight): string | null {
  // 優先 depTimeUtc / depTime / date
  const candidate = f.depTimeUtc || f.depTime || f.date;
  if (!candidate) return null;
  const d = new Date(candidate);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildSourceRef(f: RosterFlight, dutyIdx: number): string | null {
  const date = flightDate(f);
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
function extractCrew(crew?: RosterCrewMember[]): Record<string, CrewSlotVal> | null {
  if (!crew || !crew.length) return null;
  const out: Record<string, CrewSlotVal> = {};
  const otherSlots = ['crew2', 'crew3', 'crew4'];
  let otherIdx = 0;
  for (const m of crew) {
    if (!m.name || !m.position) continue;
    const pos = m.position.toUpperCase();
    const rank = (m.rank || '').toUpperCase();
    if (/DHD|DEADHEAD/.test(pos)) continue;   // V1.3.12：搭便機的人沒操作這班，不進槽
    if (/CIC/.test(pos)) { if (!out.cic) out.cic = crewVal(m); }
    else if (/OBS/.test(pos)) { if (!out.obs) out.obs = crewVal(m); }
    else if (/CAP|CMD|PIC/.test(pos)) { if (!out.pic) out.pic = crewVal(m); }
    else if (/^P\d|^IS|SFO|FIRST OFFICER|^FO|SIC/.test(pos) || /CAP|SFO|FO|TFO|TCAP/.test(rank)) {
      if (otherIdx < otherSlots.length) out[otherSlots[otherIdx++]] = crewVal(m);
    }
    // else：其他客艙（SC/CC/PC…非 CIC）→ 不記
  }
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
    inserted: 0, updated: 0, skipped_confirmed: 0, marked_removed: 0, crew_added: 0,
  };

  const seenRefs: string[] = [];
  // V1.3.12：跨整份班表蒐集「要進通訊錄」的組員，去重後再 upsert（一個人會出現在很多班）。
  // key：員編優先（穩定），沒員編退回 name:名字。
  const contacts = new Map<string, { staffId?: string; name: string }>();

  for (let dutyIdx = 0; dutyIdx < duties.length; dutyIdx++) {
    const duty = duties[dutyIdx];
    const onDuty = parseUtc(duty.reportTime);
    const offDuty = parseUtc(duty.endTime);
    const flights = duty.flights || [];

    for (const f of flights) {
      const sourceRef = buildSourceRef(f, dutyIdx);
      if (!sourceRef) continue;

      const fDate = flightDate(f);
      if (!fDate) continue;

      // V1.3.13：月份篩選 —— 只處理 months 內的航班，但**仍迭代整份 duties**讓 dutyIdx 維持全域。
      // source_ref 含全域 dutyIdx：subset 重匯若改變陣列就會換 ref → 重複 + 誤標 removed（codex P1）。
      // 傳完整 duties + 用 months 過濾處理，subset 與全匯產出完全相同的 ref。
      // codex P1（boundary）：用 duty 標記的「roster 月份」(_rmonth) 比對，不用航班 UTC 日期 ——
      // 6 月班表裡 UTC 落在 5/31 的 leg 仍屬 6 月，用 UTC 日期會誤漏。沒標 _rmonth 才退回 fDate。
      const rosterMonth = (duty as any)._rmonth || fDate.slice(0, 7);
      if (months && months.length && months.indexOf(rosterMonth) < 0) continue;
      seenRefs.push(sourceRef);

      const stdUtc = parseUtc(f.depTimeUtc);
      const staUtc = parseUtc(f.arrTimeUtc);
      const position = normalizePosition(f.position || f.workCode);
      const crewJson = extractCrew(f.crew);
      // V1.3.12：DHD（搭便機 positioning）→ 標 deadhead，照建 entry 但飛時/PIC/night 全不計
      const isDeadhead = /DHD|DEADHEAD|POSITIONING/i.test((f.position || '') + ' ' + (f.workCode || ''));
      // V1.3.12：蒐集要進通訊錄的組員（去重）
      for (const m of (f.crew || [])) {
        if (!m.name || !isLoggedCrew(m)) continue;
        const sid = (m.staffId || '').trim();
        const key = sid ? 'id:' + sid : 'name:' + m.name;
        if (!contacts.has(key)) contacts.set(key, { staffId: sid || undefined, name: m.name });
      }

      // 查現有
      const existing = await pool.query(
        `SELECT id, status FROM pilot_log_entries WHERE user_id = $1 AND source = 'roster' AND source_ref = $2`,
        [userId, sourceRef]
      );

      if (existing.rows.length === 0) {
        // 新 draft
        await pool.query(
          `INSERT INTO pilot_log_entries
           (id, user_id, source, source_ref, status, flight_date, flight_no, origin, dest,
            position, std_utc, sta_utc, on_duty_utc, off_duty_utc, crew, is_deadhead)
           VALUES ($1, $2, 'roster', $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            randomUUID(), userId, sourceRef, fDate, f.flightNo, f.origin, f.dest,
            position, stdUtc, staUtc, onDuty, offDuty, crewJson ? JSON.stringify(crewJson) : null, isDeadhead,
          ]
        );
        result.inserted++;
      } else if (existing.rows[0].status === 'confirmed') {
        result.skipped_confirmed++;
      } else {
        // draft 或 roster_removed → 更新並重設 draft
        // codex P2：原本用 COALESCE 會卡住已 non-null 的欄位（gate 改了/duty 改了/組員換了
        // 都不會反映）。改成直接覆寫 — 班表是新鮮的就該蓋舊的。
        await pool.query(
          `UPDATE pilot_log_entries SET
             status = 'draft',
             flight_date = $2, flight_no = $3, origin = $4, dest = $5,
             position = $6,
             std_utc = $7, sta_utc = $8,
             on_duty_utc = $9,
             off_duty_utc = $10,
             crew = $11::jsonb,
             is_deadhead = $12,
             updated_at = NOW()
           WHERE id = $1`,
          [
            existing.rows[0].id, fDate, f.flightNo, f.origin, f.dest,
            position, stdUtc, staUtc, onDuty, offDuty,
            crewJson ? JSON.stringify(crewJson) : null, isDeadhead,
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

  // 範圍內 draft 沒看到的 → roster_removed。
  // codex P2：必須「per-month」sweep — 若同步了 5/7 但沒同步 6，連續 dateRange 會把 6 月舊
  // draft 全部誤標 removed。優先用 months（每月各自掃），沒給才退回單一 dateRange（舊行為）。
  const sweepRanges: Array<{ start: string; end: string }> = [];
  if (months && months.length) {
    for (const ym of months) {
      const parts = ym.split('-');
      if (parts.length !== 2) continue;
      const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
      if (!y || !m) continue;
      const nextMonth1st = new Date(Date.UTC(y, m, 1));                  // m 為 1-base：等同下個月 1 號
      const lastDay = new Date(nextMonth1st.getTime() - 24 * 3600 * 1000);
      sweepRanges.push({ start: ym + '-01', end: lastDay.toISOString().slice(0, 10) });
    }
  } else if (dateRange) {
    sweepRanges.push(dateRange);
  }
  for (const rg of sweepRanges) {
    const r = await pool.query(
      `UPDATE pilot_log_entries SET status = 'roster_removed', updated_at = NOW()
       WHERE user_id = $1
         AND source = 'roster'
         AND status = 'draft'
         AND flight_date >= $2 AND flight_date <= $3
         AND NOT (source_ref = ANY($4::text[]))`,
      [userId, rg.start, rg.end, seenRefs]
    );
    result.marked_removed += r.rowCount || 0;
  }

  return result;
}
