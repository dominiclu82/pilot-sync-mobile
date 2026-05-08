// Pilot Log v1 — LogTen Pro Address Book 匯入
//
// 邊界寫死（避免 scope 漂移）：
//   - 只接受 LogTen Pro 6 Address Book Tab 動態匯出
//   - 編碼只接受 UTF-8
//   - Header 缺必填欄位 → reject 整批
//   - 未知欄位 → 忽略不報錯
//
// 識別邏輯（V1.0.09）：employee_id 為主、display_name 為輔。
//   1. row 的 ids[] (split by '/') 在 crew_employee_ids 找命中：
//      - 命中單一 crew → upsert 該 crew、把缺的 ID 補進去
//      - 命中多個 crew → CONFLICT，row 記進 conflicts、不動 DB
//   2. row 沒任何 ID → 在「也都沒 ID 的 crew」之間用 display_name 弱比對
//      - 命中 0 筆 → INSERT 新 crew
//      - 命中 1 筆 → UPDATE 該 crew
//      - 命中 2 筆以上 → CONFLICT，不自動接第一筆（跟 ID 多命中規則一致）
//   3. 都沒命中 → INSERT 新 crew + 全部 IDs
//   4. is_self：只有當檔案有「This is Me=1」標記才動，且整批最後才寫
//                 (UPDATE all to false → UPDATE self to true)，否則完全不動現有 is_self
//
// 寫入保證：
//   - 每 row 用獨立 BEGIN/COMMIT 包；中途任一步失敗整 row ROLLBACK，不留半套 crew + 部分 alias
//   - is_self 的 clear-then-set 也包單一 TX
//   - 整批至少有 1 筆 inserted/updated 才 fire-and-forget 更新 pilot_users.last_import_at

import { randomUUID } from 'crypto';
import { getPool, ensureTables } from './schema.js';
import { parseTab } from './tsv-parser.js';

const ADDRESSBOOK_REQUIRED = ['Name', 'ID', 'This is Me'];

function assertHeaders(headers: string[], required: string[]): string[] {
  const missing: string[] = [];
  const set = new Set(headers);
  for (const r of required) if (!set.has(r)) missing.push(r);
  return missing;
}

// 名字正規化：trim + collapse internal whitespace
// export 出來給 unit test 用（test/import-addressbook.test.ts）
export function normName(s: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ID 字串正規化：split by '/'、trim、去空白、去重複
// export 出來給 unit test 用
export function normIds(idStr: string): string[] {
  const raw = String(idStr || '').split('/');
  const trimmed = raw.map(s => s.trim()).filter(s => s.length > 0);
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const id of trimmed) {
    if (!seen.has(id)) {
      seen.add(id);
      dedup.push(id);
    }
  }
  return dedup;
}

export interface ImportAddressBookResult {
  inserted: number;
  updated: number;
  conflicts: Array<{ row: number; name: string; ids: string[]; matched_crew_ids: string[] }>;
  parse_errors: number;
  bad_rows?: Array<{ row: number; reason: string }>;
  self_set?: string | null;          // 若這次成功設了 self，回報名稱
  self_update_error?: string;        // 若 is_self TX 失敗，把錯誤訊息帶到 caller（不 swallow）
  error?: string;
}

export async function importLogtenAddressBook(
  userId: string,
  text: string
): Promise<ImportAddressBookResult> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) {
    return { inserted: 0, updated: 0, conflicts: [], parse_errors: 0, error: 'database_unavailable' };
  }

  const { headers, rows } = parseTab(text);
  if (headers.length === 0) {
    return { inserted: 0, updated: 0, conflicts: [], parse_errors: 0, error: 'empty_or_invalid_file' };
  }

  const missing = assertHeaders(headers, ADDRESSBOOK_REQUIRED);
  if (missing.length > 0) {
    return {
      inserted: 0, updated: 0, conflicts: [], parse_errors: 0,
      error: `missing_required_columns:${missing.join(',')}`,
    };
  }

  const result: ImportAddressBookResult = {
    inserted: 0, updated: 0, conflicts: [], parse_errors: 0, bad_rows: [], self_set: null,
  };

  // 暫存「整批跑完才寫」的 self 指派；只有當 row 設了 isSelf 才會被填
  let selfCrewId: string | null = null;
  let selfDisplayName: string | null = null;

  // 拿單一 client 整批用，每 row 自己 BEGIN/COMMIT，避免半套寫入
  const client = await pool.connect();
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // 解析 + normalize（不需要 TX 包）
      const name = normName(row['Name']);
      if (!name) {
        result.parse_errors++;
        result.bad_rows!.push({ row: i + 2, reason: 'empty_name' });
        continue;
      }
      const ids = normIds(row['ID']);
      const org = normName(row['Organization']) || null;
      const comment = String(row['Comment'] || '').trim() || null;
      const isSelf = String(row['This is Me'] || '').trim() === '1';

      // Per-row TX：reads + writes 同一個 BEGIN/COMMIT，整 row atomic
      await client.query('BEGIN');
      try {
        // Step 1: 用 ids[] 在 alias 表找命中
        let matchedCrewIds: string[] = [];
        if (ids.length > 0) {
          const r = await client.query(
            `SELECT DISTINCT crew_id FROM crew_employee_ids
             WHERE user_id = $1 AND employee_id = ANY($2::text[])`,
            [userId, ids]
          );
          matchedCrewIds = r.rows.map((row: any) => row.crew_id);
        }

        // Step 1a: 多 crew 命中 → CONFLICT，不動 DB
        if (matchedCrewIds.length > 1) {
          result.conflicts.push({
            row: i + 2, name, ids, matched_crew_ids: matchedCrewIds,
          });
          await client.query('ROLLBACK');
          continue;
        }

        let crewId: string | null = matchedCrewIds[0] || null;

        // Step 2: 沒命中、且 row 也沒 ID → 用 display_name 弱比對（只在「也沒 ID 的 crew」之間）
        // 多筆同名命中時也視為 conflict，跟 ID 多命中規則一致，不默默接第一筆
        if (!crewId && ids.length === 0) {
          const r = await client.query(
            `SELECT c.id FROM crew c
             WHERE c.user_id = $1 AND c.display_name = $2
               AND NOT EXISTS (SELECT 1 FROM crew_employee_ids e WHERE e.crew_id = c.id)`,
            [userId, name]
          );
          if (r.rows.length === 1) {
            crewId = r.rows[0].id;
          } else if (r.rows.length > 1) {
            result.conflicts.push({
              row: i + 2, name, ids: [],
              matched_crew_ids: r.rows.map((row: any) => row.id),
            });
            await client.query('ROLLBACK');
            continue;
          }
          // 0 筆 → 落到下面 INSERT 分支
        }

        let isInsert = false;
        if (crewId) {
          // Step 3: UPDATE 既有 crew（COALESCE：空欄位不洗掉舊資料）
          await client.query(
            `UPDATE crew SET
               display_name = $2,
               organization = COALESCE($3, organization),
               comment = COALESCE($4, comment),
               updated_at = NOW()
             WHERE id = $1`,
            [crewId, name, org, comment]
          );
          // 把 row 帶來但 crew 還沒掛的 ID 加進去
          for (const id of ids) {
            await client.query(
              `INSERT INTO crew_employee_ids (crew_id, user_id, employee_id)
               VALUES ($1, $2, $3) ON CONFLICT (user_id, employee_id) DO NOTHING`,
              [crewId, userId, id]
            );
          }
        } else {
          // Step 4: INSERT 新 crew + 全部 IDs
          crewId = randomUUID();
          isInsert = true;
          await client.query(
            `INSERT INTO crew (id, user_id, display_name, organization, comment)
             VALUES ($1, $2, $3, $4, $5)`,
            [crewId, userId, name, org, comment]
          );
          for (const id of ids) {
            await client.query(
              `INSERT INTO crew_employee_ids (crew_id, user_id, employee_id)
               VALUES ($1, $2, $3)`,
              [crewId, userId, id]
            );
          }
        }

        await client.query('COMMIT');
        if (isInsert) result.inserted++;
        else result.updated++;

        // Step 5: COMMIT 後才暫存 self（避免失敗的 row 被當成 self）
        if (isSelf && crewId) {
          selfCrewId = crewId;
          selfDisplayName = name;
        }
      } catch (e: any) {
        try { await client.query('ROLLBACK'); } catch { /* swallow */ }
        console.warn('[pilot-log] addressbook import row error:', e.message);
        result.parse_errors++;
        result.bad_rows!.push({ row: i + 2, reason: e.message || 'unknown' });
      }
    }

    // is_self 一致性：
    //   - 檔案有明確的 This is Me=1 → 整 TX 包 clear-then-set，避免中間有「沒人是 self」窗口
    //   - 沒任何 self 標記 → 完全不動現有 is_self（避免匯入別人的 Address Book 把自己誤清）
    if (selfCrewId) {
      await client.query('BEGIN');
      try {
        await client.query('UPDATE crew SET is_self = false, updated_at = NOW() WHERE user_id = $1', [userId]);
        await client.query('UPDATE crew SET is_self = true, updated_at = NOW() WHERE id = $1', [selfCrewId]);
        await client.query('COMMIT');
        result.self_set = selfDisplayName;
      } catch (e: any) {
        try { await client.query('ROLLBACK'); } catch { /* swallow */ }
        console.warn('[pilot-log] addressbook is_self update failed:', e.message);
        // 把錯誤帶到 caller，不再 silent swallow，方便前端決定要不要提示「self 沒換掉」
        result.self_update_error = e.message || 'unknown';
      }
    }
  } finally {
    client.release();
  }

  // V1.0.05 monitoring：成功有寫進 DB（inserted 或 updated）才更新 last_import_at
  // fire-and-forget，跟主 import 解耦，失敗不影響回傳結果
  if (result.inserted > 0 || result.updated > 0) {
    pool.query(
      `UPDATE pilot_users SET last_import_at = NOW() WHERE id = $1`,
      [userId]
    ).catch(() => { /* swallow */ });
  }

  return result;
}
