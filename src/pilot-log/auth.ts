// Pilot Log v1 — Auth
// Google ID token = identity only.
// App owns session: access JWT (1h) + refresh token (SHA-256, 90d, rotation on use).
//
// JWT 用 node:crypto DIY HS256，避免新增依賴。
// 使用 process.env.PILOT_LOG_JWT_SECRET（沒設則啟動時隨機產生 + 警告）。

import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'crypto';
import { google } from 'googleapis';
import { loadCredentials } from '../config.js';
import { getPool, ensureTables } from './schema.js';
import { isLoginAllowed } from './beta.js';

const ACCESS_TTL_SECONDS = 60 * 60;            // 1 hour
const REFRESH_TTL_DAYS = 90;
const REFRESH_TTL_MS = REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;

let _jwtSecret: string;
{
  const env = process.env.PILOT_LOG_JWT_SECRET;
  if (env && env.length >= 32) {
    _jwtSecret = env;
  } else {
    _jwtSecret = randomBytes(32).toString('hex');
    if (process.env.NODE_ENV === 'production') {
      console.warn('⚠️ PILOT_LOG_JWT_SECRET 未設定或過短，已隨機產生（重啟後現有 token 全失效）');
    }
  }
}

// ── JWT helpers ──────────────────────────────────────────────────────────────
function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export interface JwtPayload {
  sub: string;       // user_id
  iat: number;
  exp: number;
}

export function signAccessToken(userId: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = { sub: userId, iat: now, exp: now + ACCESS_TTL_SECONDS };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signing = `${headerB64}.${payloadB64}`;
  const sig = createHmac('sha256', _jwtSecret).update(signing).digest();
  return `${signing}.${b64url(sig)}`;
}

export function verifyAccessToken(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  try {
    const expected = createHmac('sha256', _jwtSecret).update(`${headerB64}.${payloadB64}`).digest();
    const got = b64urlDecode(sigB64);
    if (got.length !== expected.length) return null;
    if (!timingSafeEqual(got, expected)) return null;
    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as JwtPayload;
    if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Refresh token ────────────────────────────────────────────────────────────
function newRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(48).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function hashRefresh(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// ── Google verify ────────────────────────────────────────────────────────────
let _googleClient: any = null;
function getGoogleClient() {
  if (_googleClient) return _googleClient;
  const creds = loadCredentials();
  _googleClient = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret);
  return _googleClient;
}

export async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; name: string; picture: string } | null> {
  try {
    const client = getGoogleClient();
    const creds = loadCredentials();
    const ticket = await client.verifyIdToken({ idToken, audience: creds.web.client_id });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.email_verified) return null;
    return {
      email: payload.email,
      name: payload.name || '',
      picture: payload.picture || '',
    };
  } catch (e: any) {
    console.warn('[pilot-log] verifyGoogleIdToken failed:', e.message);
    return null;
  }
}

// ── Login / Refresh / Logout ─────────────────────────────────────────────────

export interface SessionPair {
  accessToken: string;
  refreshToken: string;
  userId: string;
  primaryEmail: string;
}

/**
 * Login / sign-up via Google ID token.
 * 找得到 email → 用同一 user；找不到 → 新建 pilot_users + pilot_user_emails。
 */
export async function loginWithGoogle(
  idToken: string, userAgent?: string
): Promise<SessionPair | null | 'not_invited'> {
  const verified = await verifyGoogleIdToken(idToken);
  if (!verified) return null;

  // 封閉測試門禁：PILOT_LOG_BETA_GATE=on 時，只有 owner + active 報名者能登入。
  // 不在白名單 → 回 'not_invited'（不建帳號），路由層轉成友善訊息。gate off 時恆放行。
  if (!(await isLoginAllowed(verified.email))) return 'not_invited';

  const pool = getPool();
  if (!pool || !(await ensureTables())) return null;

  // 找已綁的 user
  const existing = await pool.query(
    'SELECT user_id FROM pilot_user_emails WHERE email = $1',
    [verified.email]
  );

  let userId: string;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].user_id;
    await pool.query('UPDATE pilot_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [userId]);
  } else {
    userId = randomUUID();
    await pool.query(
      'INSERT INTO pilot_users (id, last_login_at) VALUES ($1, NOW())',
      [userId]
    );
    await pool.query(
      'INSERT INTO pilot_user_emails (user_id, email, is_primary) VALUES ($1, $2, true)',
      [userId, verified.email]
    );
  }

  // 拿 primary email（多 email 情境也回得對）
  const primary = await pool.query(
    `SELECT email FROM pilot_user_emails WHERE user_id = $1 ORDER BY is_primary DESC, linked_at ASC LIMIT 1`,
    [userId]
  );
  const primaryEmail = primary.rows[0]?.email || verified.email;

  // 建 session
  const { raw, hash } = newRefreshToken();
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO pilot_user_sessions (id, user_id, refresh_token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days', $4)`,
    [sessionId, userId, hash, userAgent || null]
  );

  return {
    accessToken: signAccessToken(userId),
    refreshToken: raw,
    userId,
    primaryEmail,
  };
}

/**
 * Refresh：用舊 refresh token 換新 access + 新 refresh（rotation）。
 * 舊 session 設 expires_at = NOW() 並記 rotated_from。
 */
export async function rotateRefreshToken(rawRefresh: string, userAgent?: string): Promise<SessionPair | null> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return null;

  const hash = hashRefresh(rawRefresh);
  const r = await pool.query(
    `SELECT id, user_id, expires_at FROM pilot_user_sessions WHERE refresh_token_hash = $1`,
    [hash]
  );
  if (r.rows.length === 0) return null;
  const old = r.rows[0];
  if (new Date(old.expires_at).getTime() <= Date.now()) return null;

  // Rotation: 作廢舊的、產生新的
  const { raw, hash: newHash } = newRefreshToken();
  const newId = randomUUID();
  await pool.query('BEGIN');
  try {
    await pool.query(
      `UPDATE pilot_user_sessions SET expires_at = NOW(), last_used_at = NOW() WHERE id = $1`,
      [old.id]
    );
    await pool.query(
      `INSERT INTO pilot_user_sessions (id, user_id, refresh_token_hash, expires_at, rotated_from, user_agent)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days', $4, $5)`,
      [newId, old.user_id, newHash, old.id, userAgent || null]
    );
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }

  const primary = await pool.query(
    `SELECT email FROM pilot_user_emails WHERE user_id = $1 ORDER BY is_primary DESC, linked_at ASC LIMIT 1`,
    [old.user_id]
  );

  return {
    accessToken: signAccessToken(old.user_id),
    refreshToken: raw,
    userId: old.user_id,
    primaryEmail: primary.rows[0]?.email || '',
  };
}

export async function revokeRefreshToken(rawRefresh: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const hash = hashRefresh(rawRefresh);
  await pool.query('UPDATE pilot_user_sessions SET expires_at = NOW() WHERE refresh_token_hash = $1', [hash]);
}

// ── Express middleware ───────────────────────────────────────────────────────
import type { Request, Response, NextFunction } from 'express';

export interface AuthedRequest extends Request {
  pilotUserId?: string;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'missing_token' }); return; }
  const payload = verifyAccessToken(m[1]);
  if (!payload) { res.status(401).json({ error: 'invalid_or_expired_token' }); return; }
  req.pilotUserId = payload.sub;

  // V1.0.05 monitoring：last_seen_at server-side 條件式 update（每分鐘最多 1 次寫入）
  // - 不在 app memory 節流（race condition 多）→ 走 SQL WHERE 條件
  // - fire-and-forget：不 await，不擋 request；錯了也不影響業務
  const pool = getPool();
  if (pool) {
    pool.query(
      `UPDATE pilot_users SET last_seen_at = NOW()
       WHERE id = $1
         AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '1 minute')`,
      [payload.sub]
    ).catch(() => { /* swallow: monitoring 寫入失敗不該擋 user */ });
  }

  next();
}
