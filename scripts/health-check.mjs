#!/usr/bin/env node
// ── CrewSync / Pilot Log 全站健檢 ───────────────────────────────────────────
// 用途：每次部署後，自動爬每個對外網頁 + 核心 API，確認都還活著、內容沒被改壞。
// 用法：
//   node scripts/health-check.mjs                       # 預設打線上 https://oops.h-peak.com
//   node scripts/health-check.mjs http://localhost:3000 # 打本機
//   BASE=https://crew-sync.onrender.com node scripts/health-check.mjs
// 退出碼：全過 0，有任何一項失敗 1（可接 CI）。
//
// 維護：新增頁面/路由就往 PAGES / APIS 陣列加一條。expect 是「body 必須包含的字串」(可省略只驗 200)。

const BASE = (process.argv[2] || process.env.BASE || 'https://oops.h-peak.com').replace(/\/$/, '');

// 對外網頁（HTML）。allowRedirect=true 的容許 3xx（如 /fr24 → /main、/ → /main）。
const PAGES = [
  { path: '/',          expect: null,                 allowRedirect: true },
  { path: '/main',      expect: 'Briefing' },
  { path: '/share',     expect: 'Briefing' },
  { path: '/apps',      expect: null },
  { path: '/morning',   expect: null },
  { path: '/pilot-log', expect: null },
  { path: '/gate',      expect: null },
  { path: '/ops',       expect: null },
  { path: '/sync',      expect: null },
  { path: '/fr24',      expect: null,                 allowRedirect: true },   // V9.4.15 起導回 /main
  { path: '/privacy',   expect: 'Privacy' },
  { path: '/sw.js',     expect: 'crewsync-v' },        // SW cache 版本字串（每次部署應更新）
];

// 核心 API。check(json,status) 回 true=過。容許 fallback（外部源暫掛不算我們壞）。
const APIS = [
  { path: '/api/atis?icao=RCTP', check: (j) => Array.isArray(j.sections) || j.fallback === true },
  { path: '/api/atis?icao=KSFO', check: (j) => Array.isArray(j.sections) || j.fallback === true },
  { path: '/oauth/url',          check: (j, s) => s === 200 },
];

const UA = 'CrewSync-HealthCheck/1.0';
let pass = 0, fail = 0;
const fails = [];

function ok(msg)  { console.log('  \x1b[32m✅\x1b[0m ' + msg); pass++; }
function bad(msg) { console.log('  \x1b[31m❌\x1b[0m ' + msg); fail++; fails.push(msg); }

async function checkPage(p) {
  const url = BASE + p.path;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: p.allowRedirect ? 'follow' : 'manual' });
    if (!p.allowRedirect && r.status >= 300 && r.status < 400) return bad(`${p.path} → 非預期轉址 ${r.status}`);
    if (!r.ok) return bad(`${p.path} → HTTP ${r.status}`);
    if (p.expect) {
      const body = await r.text();
      if (!body.includes(p.expect)) return bad(`${p.path} → 200 但缺內容「${p.expect}」`);
    }
    ok(`${p.path} → ${r.status}${p.expect ? ` (含「${p.expect}」)` : ''}`);
  } catch (e) {
    bad(`${p.path} → 連不上 (${e.message})`);
  }
}

async function checkApi(a) {
  const url = BASE + a.path;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    let j = {};
    try { j = await r.json(); } catch { /* 非 JSON */ }
    if (a.check(j, r.status)) ok(`${a.path} → ${r.status} ✓`);
    else bad(`${a.path} → ${r.status} 回應不符預期 ${JSON.stringify(j).slice(0, 120)}`);
  } catch (e) {
    bad(`${a.path} → 連不上 (${e.message})`);
  }
}

(async () => {
  console.log(`\n🩺 健檢目標：${BASE}\n`);
  console.log('📄 網頁：');
  for (const p of PAGES) await checkPage(p);
  console.log('\n🔌 API：');
  for (const a of APIS) await checkApi(a);
  console.log('\n' + '─'.repeat(48));
  console.log(`${fail === 0 ? '🎉' : '⚠️ '} 通過 ${pass}　失敗 ${fail}`);
  if (fail) { console.log('失敗項目：'); fails.forEach((f) => console.log('  - ' + f)); }
  console.log('─'.repeat(48) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();
