// Pilot Log v1 — 封閉測試（🐵 monkey 招募）邏輯
//
// 表 pilot_beta_applicants 在 schema.ts 建（並列入 PILOT_LOG_TABLES）。
// 本檔只放邏輯，且**只 import schema、不 import auth**：
// auth.ts 會 import 本檔的 isLoginAllowed 做登入白名單，若本檔反向 import auth 會循環。
// 需要 verifyGoogleIdToken 的地方（報名 API）放在 routes.ts 串接，不在這裡。

import { randomUUID } from 'crypto';
import { getPool, ensureTables } from './schema.js';

// ── 設定（環境變數，附預設值；上線前可在 Render 調整）──────────────────────────
// 通關碼：社群置頂那組，報名要填對。預設 MONKEYCANFLY。
export const MONKEY_CODE = (process.env.PILOT_LOG_MONKEY_CODE || 'MONKEYCANFLY').trim();
// 對外顯示的總席次（頁面寫「10 席」）。
const TOTAL_SLOTS = parseInt(process.env.PILOT_LOG_BETA_TOTAL_SLOTS || '10', 10) || 10;
// 公開報名實收幾席（朋友那 5 席走後台另加，不佔這個）。
const PUBLIC_SLOTS = parseInt(process.env.PILOT_LOG_BETA_PUBLIC_SLOTS || '5', 10) || 5;
// 封閉測試門禁：on=只有 owner + active 報名者能登入 App；預設 off（不影響現有開發 / 既有使用者）。
const GATE_ON = String(process.env.PILOT_LOG_BETA_GATE || 'off').toLowerCase() === 'on';
// 公開報名開關：on=開放、off=關閉（頁面顯示已截止、後端擋新報名）。預設 off（已招滿/暫停）。
// 要重開設 PILOT_LOG_MONKEY_OPEN=on。owner 後台與既有報名者登入不受此影響。
const MONKEY_OPEN = String(process.env.PILOT_LOG_MONKEY_OPEN || 'off').toLowerCase() === 'on';
// 報名臨界區的 Postgres advisory lock key（任意固定值）：序列化「算名額 + 寫入」防超賣（codex P2）。
const BETA_LOCK_KEY = 918273645;

export function normEmail(e: string): string {
  return String(e || '').trim().toLowerCase();
}
function normCode(c: string): string {
  return String(c || '').trim().toUpperCase();
}

// 擁有者 email（永遠可登入、永遠不佔席次）。預設 Dominic，可用環境變數覆蓋 / 增列。
function ownerEmailSet(): Set<string> {
  // 預設兩個擁有者（Dominic 的兩組信箱）；可用 PILOT_LOG_OWNER_EMAILS 覆蓋。
  // 擁有者永遠可登入、永不佔席次、且唯一能進 /monkey/admin 後台。
  const raw = process.env.PILOT_LOG_OWNER_EMAILS || 'dominiclu@h-peak.com,dominiclu82@gmail.com';
  return new Set(raw.split(',').map(normEmail).filter(Boolean));
}
export function isOwnerEmail(email: string): boolean {
  return ownerEmailSet().has(normEmail(email));
}

// ── 登入白名單（auth.ts 的 loginWithGoogle 內呼叫）────────────────────────────
// gate off → 一律放行（維持現況）。gate on → 只有 owner 或 active 報名者能登入。
// DB 掛掉但 gate 開著 → 保守擋下（避免封閉期意外全開）。
export async function isLoginAllowed(email: string): Promise<boolean> {
  if (!GATE_ON) return true;
  const e = normEmail(email);
  if (isOwnerEmail(e)) return true;
  const pool = getPool();
  // codex P1：查表前先 ensureTables —— 全新部署表還沒建時，直接查會丟例外被當成「不允許」，
  // 連被邀請的人都登不進去。先建表（owner 已在上面放行，這裡只剩非 owner）。
  if (!pool || !(await ensureTables())) return false;
  try {
    const r = await pool.query(
      `SELECT 1 FROM pilot_beta_applicants WHERE email = $1 AND status = 'active' LIMIT 1`,
      [e]
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// ── Founder 等級判斷（CrewSync ATIS：分 owner / founder / none 三級，對應三個額度池）──
// owner（站長）= 自己獨享 50 次池；founder（active 報名者）= 共用 450 次池；none = 走備案。
// 輸入 userId（JWT sub）→ 查該用戶所有 email → 比對 owner / active 名單。不受登入 gate 開關影響。
export async function getFounderLevel(userId: string): Promise<'owner' | 'founder' | 'none'> {
  if (!userId) return 'none';
  const pool = getPool();
  if (!pool || !(await ensureTables())) return 'none';
  try {
    const u = await pool.query(`SELECT email FROM pilot_user_emails WHERE user_id = $1`, [userId]);
    const emails = u.rows.map((r: any) => normEmail(r.email)).filter(Boolean);
    if (!emails.length) return 'none';
    if (emails.some((e) => isOwnerEmail(e))) return 'owner';   // 站長 → 獨享池
    const r = await pool.query(
      `SELECT 1 FROM pilot_beta_applicants WHERE status = 'active' AND email = ANY($1::text[]) LIMIT 1`,
      [emails]
    );
    return r.rows.length > 0 ? 'founder' : 'none';
  } catch {
    return 'none';
  }
}

// 同上，但直接用 email 判斷（CrewSync 班表同步登入：身份證裡就是 email，不必先查 userId）。
export async function getFounderLevelByEmail(email: string): Promise<'owner' | 'founder' | 'none'> {
  const e = normEmail(email);
  if (!e) return 'none';
  if (isOwnerEmail(e)) return 'owner';
  const pool = getPool();
  if (!pool || !(await ensureTables())) return 'none';
  try {
    const r = await pool.query(
      `SELECT 1 FROM pilot_beta_applicants WHERE status = 'active' AND email = $1 LIMIT 1`, [e]
    );
    return r.rows.length > 0 ? 'founder' : 'none';
  } catch {
    return 'none';
  }
}

// ── 名額計數（招募頁計數器用）────────────────────────────────────────────────
export interface SlotInfo {
  total: number;        // 對外顯示總席次（10）
  publicCap: number;    // 公開實收（5）
  publicTaken: number;  // 已被公開報名佔走幾席
  left: number;         // 公開還剩幾席
  full: boolean;        // 公開額滿
  open: boolean;        // 報名是否開放（PILOT_LOG_MONKEY_OPEN）
}

export async function getSlots(): Promise<SlotInfo> {
  const pool = getPool();
  let publicTaken = 0;
  if (pool && (await ensureTables())) {
    try {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM pilot_beta_applicants
         WHERE status = 'active' AND source = 'public'`
      );
      publicTaken = r.rows[0]?.c || 0;
    } catch { /* 計數失敗就當 0，不擋頁面 */ }
  }
  const left = Math.max(0, PUBLIC_SLOTS - publicTaken);
  return { total: TOTAL_SLOTS, publicCap: PUBLIC_SLOTS, publicTaken, left, full: left <= 0, open: MONKEY_OPEN };
}

// ── 報名 ─────────────────────────────────────────────────────────────────────
export type ApplyResult =
  | { ok: true; status: 'active' | 'waitlist' | 'owner'; already?: boolean }
  | { ok: false; error: 'bad_code' | 'db' | 'closed' };

export async function applyApplicant(input: {
  email: string; code: string; fleet?: string; usesSync?: boolean;
  logbook?: string; logbookOther?: string;
}): Promise<ApplyResult> {
  // 報名已關閉 → 直接擋（owner 後台 / 既有報名者登入不走這條，不受影響）
  if (!MONKEY_OPEN) return { ok: false, error: 'closed' };
  // 通關碼先驗（不對就不寫 DB）
  if (normCode(input.code) !== normCode(MONKEY_CODE)) return { ok: false, error: 'bad_code' };

  const pool = getPool();
  if (!pool || !(await ensureTables())) return { ok: false, error: 'db' };
  const email = normEmail(input.email);

  // codex P2：count + insert 包進 transaction + advisory lock 序列化，避免兩人同搶最後一席
  // 都讀到「沒滿」而雙雙進 active（超賣）。用獨立 client（pool.query 每次可能換連線，BEGIN/COMMIT 不可跨連線）。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [BETA_LOCK_KEY]);

    // 已報名 → idempotent，回現狀（不覆蓋、不重複扣席次）
    const existing = await client.query(
      `SELECT source, status FROM pilot_beta_applicants WHERE email = $1`, [email]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      const row = existing.rows[0];
      const st = row.source === 'owner' ? 'owner' : (row.status as 'active' | 'waitlist');
      return { ok: true, status: st, already: true };
    }

    let source: 'owner' | 'public';
    let status: 'active' | 'waitlist';
    if (isOwnerEmail(email)) {
      source = 'owner'; status = 'active';          // owner：標 owner、不佔公開席次
    } else {
      // 鎖內重新數一次 active public，決定 active / waitlist（杜絕超賣）
      const cnt = (await client.query(
        `SELECT COUNT(*)::int AS c FROM pilot_beta_applicants WHERE status = 'active' AND source = 'public'`
      )).rows[0].c as number;
      source = 'public';
      status = cnt >= PUBLIC_SLOTS ? 'waitlist' : 'active';
    }
    await _insert(client, email, input, source, status);
    await client.query('COMMIT');
    return { ok: true, status: source === 'owner' ? 'owner' : status };
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    // 兩個請求同時報名同一 email → UNIQUE 撞車，當已報名處理
    if (e?.code === '23505') return { ok: true, status: 'active', already: true };
    console.error('[pilot-log] applyApplicant error:', e?.message);
    return { ok: false, error: 'db' };
  } finally {
    client.release();
  }
}

async function _insert(
  pool: any, email: string, input: any, source: string, status: string
): Promise<void> {
  await pool.query(
    `INSERT INTO pilot_beta_applicants
       (id, email, fleet, uses_sync, logbook, logbook_other, source, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(), email, input.fleet || null,
      typeof input.usesSync === 'boolean' ? input.usesSync : null,
      input.logbook || null, input.logbookOther || null, source, status,
    ]
  );
}

// ── 後台（owner 登入後才可呼叫；路由層做 owner 驗證）────────────────────────────
export async function listApplicants(): Promise<any[]> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return [];
  const r = await pool.query(
    `SELECT id, email, fleet, uses_sync, logbook, logbook_other, source, status, created_at
     FROM pilot_beta_applicants
     ORDER BY (source='owner') DESC, created_at ASC`
  );
  return r.rows;
}

// 後台手動加朋友（source='friend'、active，不佔公開席次）。idempotent。
export async function addFriend(emailRaw: string): Promise<{ ok: boolean; already?: boolean; promoted?: boolean }> {
  const pool = getPool();
  if (!pool || !(await ensureTables())) return { ok: false };
  const email = normEmail(emailRaw);
  if (!email || email.indexOf('@') < 0) return { ok: false };
  try {
    const ex = await pool.query(
      `SELECT source, status FROM pilot_beta_applicants WHERE email = $1`, [email]
    );
    if (ex.rows.length > 0) {
      // 已 active（含 owner）→ 真的無事可做
      if (ex.rows[0].status === 'active') return { ok: true, already: true };
      // codex（fast P1）：在候補 / 已移除 → owner 手動放行＝升級成 friend + active。
      // 否則「加朋友」對已報名者靜默 no-op，他還是卡在候補登不進去，但後台卻顯示成功。
      await pool.query(
        `UPDATE pilot_beta_applicants SET source = 'friend', status = 'active' WHERE email = $1`,
        [email]
      );
      return { ok: true, promoted: true };
    }
    await _insert(pool, email, {}, 'friend', 'active');
    return { ok: true };
  } catch (e: any) {
    if (e?.code === '23505') return { ok: true, already: true };
    return { ok: false };
  }
}

export async function removeApplicant(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(`DELETE FROM pilot_beta_applicants WHERE id = $1`, [id]);
    return (r.rowCount || 0) > 0;
  } catch {
    return false;
  }
}

// 路由層 owner 驗證用：登入後的 userId → 看綁的 email 有沒有 owner。
export async function isOwnerUserId(userId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(
      `SELECT email FROM pilot_user_emails WHERE user_id = $1`, [userId]
    );
    return r.rows.some((row: any) => isOwnerEmail(row.email));
  } catch {
    return false;
  }
}
