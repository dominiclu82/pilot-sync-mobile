// Portfolio module — Express router
//
// Phase 1.A：只有啟動 hook（init schema + auto-migrate）。CRUD endpoint 在 phase 1.B 加。

import express from 'express';
import { ensureTables } from './schema.js';
import { migrateAllUsers } from './migration.js';

export const portfolioRouter = express.Router();

// 從 request 取得 userId（X-User-Id header 或 ?uid= query param）
// 沿用晨報的 reqUserId pattern：URL-decode 處理非 ASCII 暱稱
function reqUserId(req: express.Request): string | null {
  const raw = req.header('X-User-Id') || req.query.uid;
  const str = Array.isArray(raw) ? String(raw[0]) : (raw as string | undefined);
  if (!str) return null;
  let decoded = str;
  try { decoded = decodeURIComponent(str); } catch (e) { /* 不是 encoded 就原樣用 */ }
  decoded = decoded.trim();
  return decoded || null;
}

// 健康檢查 endpoint — phase 1.A 暫時當 portfolio module 已上線的 marker
portfolioRouter.get('/api/portfolio/health', async (req, res) => {
  const userId = reqUserId(req);
  res.json({
    ok: true,
    module: 'portfolio',
    phase: '1.A',
    user_id: userId,
  });
});

/**
 * 啟動 hook：建表 + 一次性 migrate（idempotent）
 * server.ts 啟動時 await 跑一次
 */
export async function startPortfolio(): Promise<void> {
  const ok = await ensureTables();
  if (!ok) {
    console.warn('[portfolio] ensureTables failed, skip migration');
    return;
  }
  try {
    await migrateAllUsers();
  } catch (e: any) {
    console.error('[portfolio] migrateAllUsers crashed:', e.message);
  }
}
