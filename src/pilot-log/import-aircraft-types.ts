// Pilot Log v1 — LogTen Pro Aircraft Types 匯入（V1.0.11）
//
// 跟 importLogtenAircraft（tail 為主、要 Aircraft ID/Operator/Type）區分：
// 這支處理 LogTen 的 Aircraft Types export，是 type 為主、無 tail 的 catalog。
// 必填欄位只有 Type（其他全 optional）。資料量小（典型 < 30 筆），per-row pool.query
// 就夠，不需要 batch / TX 包整檔。

import { getPool, ensureTables } from './schema.js';
import { parseTab } from './tsv-parser.js';

const AIRCRAFT_TYPES_REQUIRED = ['Type'];

function assertHeaders(headers: string[], required: string[]): string[] {
  const missing: string[] = [];
  const set = new Set(headers);
  for (const r of required) if (!set.has(r)) missing.push(r);
  return missing;
}

export interface ImportAircraftTypesResult {
  inserted: number;
  updated: number;
  parse_errors: number;
  bad_rows?: Array<{ row: number; reason: string }>;
  error?: string;
}

export async function importLogtenAircraftTypes(
  userId: string,
  text: string
): Promise<ImportAircraftTypesResult> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) {
    return { inserted: 0, updated: 0, parse_errors: 0, error: 'database_unavailable' };
  }

  const { headers, rows } = parseTab(text);
  if (headers.length === 0) {
    return { inserted: 0, updated: 0, parse_errors: 0, error: 'empty_or_invalid_file' };
  }

  const missing = assertHeaders(headers, AIRCRAFT_TYPES_REQUIRED);
  if (missing.length > 0) {
    return {
      inserted: 0, updated: 0, parse_errors: 0,
      error: `missing_required_columns:${missing.join(',')}`,
    };
  }

  const result: ImportAircraftTypesResult = {
    inserted: 0, updated: 0, parse_errors: 0, bad_rows: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const type_code = String(row['Type'] || '').trim();
      if (!type_code) {
        result.parse_errors++;
        result.bad_rows!.push({ row: i + 2, reason: 'empty_type' });
        continue;
      }
      const make = String(row['Make'] || '').trim() || null;
      const model = String(row['Model'] || '').trim() || null;
      const engine_type = String(row['Engine Type'] || '').trim() || null;
      const category = String(row['Category'] || '').trim() || null;
      const klass = String(row['Class'] || '').trim() || null;
      const notes = String(row['Notes'] || '').trim() || null;

      const r = await pool.query(
        `INSERT INTO pilot_aircraft_types (user_id, type_code, make, model, engine_type, category, class, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, type_code) DO UPDATE SET
           make = COALESCE(EXCLUDED.make, pilot_aircraft_types.make),
           model = COALESCE(EXCLUDED.model, pilot_aircraft_types.model),
           engine_type = COALESCE(EXCLUDED.engine_type, pilot_aircraft_types.engine_type),
           category = COALESCE(EXCLUDED.category, pilot_aircraft_types.category),
           class = COALESCE(EXCLUDED.class, pilot_aircraft_types.class),
           notes = COALESCE(EXCLUDED.notes, pilot_aircraft_types.notes),
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [userId, type_code, make, model, engine_type, category, klass, notes]
      );
      if (r.rows[0]?.inserted) result.inserted++; else result.updated++;
    } catch (e: any) {
      console.warn('[pilot-log] aircraft-types import row error:', e.message);
      result.parse_errors++;
      result.bad_rows!.push({ row: i + 2, reason: e.message || 'unknown' });
    }
  }

  // 匯入成功才更新 last_import_at（fire-and-forget）
  if (result.inserted > 0 || result.updated > 0) {
    pool.query(
      `UPDATE pilot_users SET last_import_at = NOW() WHERE id = $1`,
      [userId]
    ).catch(() => { /* swallow */ });
  }

  return result;
}
