// Pilot Log v1 — Import from Roster
// 把 roster sync 抓到的 duties[] 變成 draft entries。
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

function extractCrew(crew?: RosterCrewMember[]): Record<string, string> | null {
  if (!crew || !crew.length) return null;
  const out: Record<string, string> = {};
  for (const m of crew) {
    if (!m.name || !m.position) continue;
    const pos = m.position.toUpperCase();
    if (/CAP|CMD|PIC/i.test(pos) && !out.pic) out.pic = m.name;
    else if (/SFO|FIRST OFFICER|SIC/i.test(pos) && !out.sic) out.sic = m.name;
    else if (/^FO$|^FO\d|^FO /i.test(pos)) {
      if (!out.fo1) out.fo1 = m.name;
      else if (!out.fo2) out.fo2 = m.name;
    } else if (/PURSER|SP|PR/i.test(pos) && !out.purser) out.purser = m.name;
    else if (/OBS/i.test(pos)) {
      if (!out.observer1) out.observer1 = m.name;
      else if (!out.observer2) out.observer2 = m.name;
    }
  }
  return Object.keys(out).length ? out : null;
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
  dateRange?: { start: string; end: string }
): Promise<ImportRosterResult> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) {
    return { inserted: 0, updated: 0, skipped_confirmed: 0, marked_removed: 0 };
  }

  const result: ImportRosterResult = {
    inserted: 0, updated: 0, skipped_confirmed: 0, marked_removed: 0,
  };

  const seenRefs: string[] = [];

  for (let dutyIdx = 0; dutyIdx < duties.length; dutyIdx++) {
    const duty = duties[dutyIdx];
    const onDuty = parseUtc(duty.reportTime);
    const offDuty = parseUtc(duty.endTime);
    const flights = duty.flights || [];

    for (const f of flights) {
      const sourceRef = buildSourceRef(f, dutyIdx);
      if (!sourceRef) continue;
      seenRefs.push(sourceRef);

      const fDate = flightDate(f);
      if (!fDate) continue;

      const stdUtc = parseUtc(f.depTimeUtc);
      const staUtc = parseUtc(f.arrTimeUtc);
      const position = normalizePosition(f.position || f.workCode);
      const crewJson = extractCrew(f.crew);

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
            position, std_utc, sta_utc, on_duty_utc, off_duty_utc, crew)
           VALUES ($1, $2, 'roster', $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            randomUUID(), userId, sourceRef, fDate, f.flightNo, f.origin, f.dest,
            position, stdUtc, staUtc, onDuty, offDuty, crewJson ? JSON.stringify(crewJson) : null,
          ]
        );
        result.inserted++;
      } else if (existing.rows[0].status === 'confirmed') {
        result.skipped_confirmed++;
      } else {
        // draft 或 roster_removed → 更新並重設 draft
        await pool.query(
          `UPDATE pilot_log_entries SET
             status = 'draft',
             flight_date = $2, flight_no = $3, origin = $4, dest = $5,
             position = COALESCE(position, $6),
             std_utc = $7, sta_utc = $8,
             on_duty_utc = COALESCE(on_duty_utc, $9),
             off_duty_utc = COALESCE(off_duty_utc, $10),
             crew = COALESCE(crew, $11::jsonb),
             updated_at = NOW()
           WHERE id = $1`,
          [
            existing.rows[0].id, fDate, f.flightNo, f.origin, f.dest,
            position, stdUtc, staUtc, onDuty, offDuty,
            crewJson ? JSON.stringify(crewJson) : null,
          ]
        );
        result.updated++;
      }
    }
  }

  // 範圍內 draft 沒看到的 → roster_removed
  if (dateRange && seenRefs.length >= 0) {
    const r = await pool.query(
      `UPDATE pilot_log_entries SET status = 'roster_removed', updated_at = NOW()
       WHERE user_id = $1
         AND source = 'roster'
         AND status = 'draft'
         AND flight_date >= $2 AND flight_date <= $3
         AND NOT (source_ref = ANY($4::text[]))`,
      [userId, dateRange.start, dateRange.end, seenRefs]
    );
    result.marked_removed = r.rowCount || 0;
  }

  return result;
}
