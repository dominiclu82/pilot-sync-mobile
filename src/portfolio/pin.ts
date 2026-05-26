// Portfolio module — PIN feature (Phase 1.D, opt-in)
//
// 機制：
//   - PIN hash 存 morning_prefs.prefs.portfolio_pin_hash (bcrypt)
//   - NULL/undefined = 沒設 PIN（沿用晨報 user identity 直接通過）
//   - 設了 PIN → portfolio data endpoints 要求 X-Portfolio-Pin header verify

import bcrypt from 'bcryptjs';
import { getPool } from './schema.js';

const SALT_ROUNDS = 10;
const BCRYPT_MAX_BYTES = 72;  // bcrypt 演算法上限，超過會被 truncate

// ── Format validation ───────────────────────────────────────────────────────
// 不限長度 (>= 1)，不限字元 (數字 / 字母 / symbol 全 OK)；只防超過 bcrypt 上限

export function validatePinFormat(pin: any): { ok: boolean; reason?: string } {
  if (typeof pin !== 'string') return { ok: false, reason: 'pin_must_be_string' };
  if (pin.length === 0) return { ok: false, reason: 'pin_required' };
  // 用 byte length 而不是 char length（中文等多 byte 字元也要算）
  const byteLen = new TextEncoder().encode(pin).length;
  if (byteLen > BCRYPT_MAX_BYTES) return { ok: false, reason: 'pin_too_long' };
  return { ok: true };
}

// ── bcrypt helpers ──────────────────────────────────────────────────────────

export async function hashPin(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPinAgainstHash(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

// ── DB layer (操作 morning_prefs.prefs JSON 內的 portfolio_pin_hash) ────────

/** 抓 user PIN hash；NULL = 沒設過 PIN，user 不存在也 NULL */
export async function getPinHash(userId: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT prefs->>'portfolio_pin_hash' AS hash FROM morning_prefs WHERE user_id = $1`,
      [userId],
    );
    if (r.rows.length === 0) return null;
    return r.rows[0].hash || null;
  } catch (e: any) {
    console.error('[portfolio.pin] getPinHash failed:', e.message);
    return null;
  }
}

/**
 * 寫 / 改 / 移除 PIN hash（merge 進 morning_prefs.prefs JSON）
 * hash=null  → 移除 portfolio_pin_hash key
 * hash=string → 寫入或覆寫
 */
export async function setPinHash(userId: string, hash: string | null): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    if (hash === null) {
      // 移除：用 JSON `-` operator 刪 key
      // 注意 user 必須已存在於 morning_prefs（否則沒設過 PIN 也不用 unset）
      const r = await pool.query(
        `UPDATE morning_prefs
         SET prefs = prefs - 'portfolio_pin_hash', updated_at = NOW()
         WHERE user_id = $1`,
        [userId],
      );
      return (r.rowCount ?? 0) > 0;
    } else {
      // 設定：upsert，prefs 內 jsonb_set 寫入
      await pool.query(
        `INSERT INTO morning_prefs (user_id, prefs, updated_at)
         VALUES ($1, jsonb_build_object('portfolio_pin_hash', $2::text), NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET prefs = jsonb_set(
           COALESCE(morning_prefs.prefs, '{}'::jsonb),
           '{portfolio_pin_hash}',
           to_jsonb($2::text)
         ),
         updated_at = NOW()`,
        [userId, hash],
      );
      return true;
    }
  } catch (e: any) {
    console.error('[portfolio.pin] setPinHash failed:', e.message);
    return false;
  }
}

// ── High-level helpers ──────────────────────────────────────────────────────

/** 用 plain PIN 驗證 user PIN（合併 fetch + compare 一步） */
export async function verifyUserPin(userId: string, plain: string): Promise<boolean> {
  const hash = await getPinHash(userId);
  if (!hash) return false;
  return verifyPinAgainstHash(plain, hash);
}

/** Check user 是否啟用 PIN 保護 */
export async function userHasPin(userId: string): Promise<boolean> {
  const hash = await getPinHash(userId);
  return hash !== null;
}
