/**
 * Pilot Log Smoke Test (Layer 1: surface tests)
 *
 * 目的：確認獨立路由 + auth middleware + 主站乾淨無洩漏
 * 之後再補一支 workflow integration 測試（建 user → 寫 entry → list → confirm）
 *
 * 用法：npm run test:pl（自動啟 server、跑完關閉）
 */

import { spawn, ChildProcess } from 'child_process';

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;
let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = spawn('npx', ['tsx', 'src/server.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    const timeout = setTimeout(() => reject(new Error('Server 啟動超時')), 30000);
    server.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('伺服器啟動')) {
        clearTimeout(timeout);
        setTimeout(resolve, 1000);
      }
    });
    server.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('EADDRINUSE')) {
        clearTimeout(timeout);
        reject(new Error('Port 3000 已被佔用'));
      }
    });
    server.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

function stopServer() {
  if (server) { server.kill(); server = null; }
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function run() {
  console.log('\n📒 Pilot Log Smoke Test (Layer 1)\n');
  console.log('⏳ 啟動 server...');
  await startServer();
  console.log('✅ Server 已啟動\n');

  // ── 獨立頁面 ──────────────────────────────────────────────────────────
  console.log('📄 /pilot-log 獨立頁:');
  let plHtml = '';
  await check('GET /pilot-log → 200', async () => {
    const r = await fetch(`${BASE}/pilot-log`);
    assert(r.ok, `status ${r.status}`);
    plHtml = await r.text();
  });
  await check('含版號（V*.*.*）', async () => {
    assert(/V\d+\.\d+\.\d+/.test(plHtml), '找不到版號');
  });
  await check('含 root container <div id="pilotlog-content">', async () => {
    assert(plHtml.includes('id="pilotlog-content"'), '找不到 root container');
  });
  await check('含 pilotLogInit 啟動呼叫', async () => {
    assert(plHtml.includes('pilotLogInit()'), '頁面沒呼叫 pilotLogInit');
  });
  await check('manifest link 存在', async () => {
    assert(plHtml.includes('/pilot-log/manifest.json'), '頁面沒指向 manifest');
  });
  await check('Service Worker 註冊呼叫存在', async () => {
    assert(plHtml.includes("navigator.serviceWorker.register('/pilot-log/sw.js'"),
           '頁面沒註冊 SW');
  });
  await check('About modal 存在 + 版號可點擊', async () => {
    assert(plHtml.includes('id="pl-about-wrap"'), '找不到 About modal');
    assert(plHtml.includes('plShowAbout()'), '版號沒接 onclick');
  });
  await check('About changelog 含中英對照', async () => {
    // 有版號標記 + 中文敘述 + 英文敘述
    assert(plHtml.includes('class="pl-cl-v"'), '找不到 changelog 版號區塊');
    assert(plHtml.includes('class="pl-cl-txt"'), '找不到 changelog 內文區塊');
  });
  await check('inline JS 含關鍵 section 標記', async () => {
    assert(plHtml.includes('SECTION: state') && plHtml.includes('SECTION: auth') &&
           plHtml.includes('SECTION: editor'), 'pilot-log.js 內容沒注入或缺 section');
  });
  await check('Import UI 含 Preview (dry-run) 按鈕', async () => {
    assert(plHtml.includes('_plUploadFlights(true)') && plHtml.includes('Preview'),
           '找不到 Preview / dry-run 按鈕');
  });
  await check('Import UI 含 Import 按鈕', async () => {
    assert(plHtml.includes('_plUploadFlights(false)'), '找不到 Import 按鈕');
  });
  await check('Import UI 含 Danger Zone Wipe 按鈕', async () => {
    assert(plHtml.includes('_plWipeLogten()') && plHtml.includes('Danger Zone'),
           '找不到 Wipe LogTen 按鈕 / Danger Zone 區塊');
  });
  await check('Editor flight_date 用 date type（防 +0YYYYY 顯示 bug）', async () => {
    assert(plHtml.includes("_plEditorField('Date', 'flight_date', 'date')"),
           "flight_date 欄位沒用 'date' type，會顯示 ISO 字串");
  });
  await check('inline JS 能 parse（用 new Function 過編譯，不執行）', async () => {
    // 抽出整段 <script>...</script>（用最後一個 </script> 為止）
    const start = plHtml.indexOf('<script>');
    const end = plHtml.lastIndexOf('</script>');
    assert(start >= 0 && end > start, '找不到 <script> 區塊');
    try {
      new Function(plHtml.slice(start + 8, end));
    } catch (e: any) {
      throw new Error('parse error: ' + e.message);
    }
  });

  // ── PWA shell ─────────────────────────────────────────────────────────
  console.log('\n📦 PWA shell:');
  await check('GET /pilot-log/manifest.json → 200 + 必要欄位', async () => {
    const r = await fetch(`${BASE}/pilot-log/manifest.json`);
    assert(r.ok, `status ${r.status}`);
    const j = await r.json() as any;
    assert(j.name && j.start_url === '/pilot-log' && j.display === 'standalone',
           `manifest 欄位錯：${JSON.stringify(j)}`);
  });
  await check('GET /pilot-log/icon.svg → 200 + SVG', async () => {
    const r = await fetch(`${BASE}/pilot-log/icon.svg`);
    assert(r.ok, `status ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    assert(ct.includes('image/svg'), `content-type 錯：${ct}`);
    const text = await r.text();
    assert(text.startsWith('<svg'), '不是 SVG');
  });
  await check('GET /pilot-log/sw.js → 200 + cache name 含版號', async () => {
    const r = await fetch(`${BASE}/pilot-log/sw.js`);
    assert(r.ok, `status ${r.status}`);
    const text = await r.text();
    assert(text.includes('pilotlog-v'), 'SW 缺 cache name');
    assert(text.includes("scope") || text.includes('/pilot-log'), 'SW scope 設定錯');
  });

  // ── Public API ────────────────────────────────────────────────────────
  console.log('\n🔌 Public API:');
  await check('GET /api/pilot-log/config → 200 + google_client_id', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/config`);
    assert(r.ok, `status ${r.status}`);
    const j = await r.json() as any;
    assert(typeof j.google_client_id === 'string' && j.google_client_id.length > 0,
           '回應沒有 google_client_id');
  });
  await check('POST /api/pilot-log/auth/login（無 idToken）→ 400', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert(r.status === 400, `status ${r.status}`);
    const j = await r.json() as any;
    assert(j.error === 'missing_id_token', `錯誤代碼錯誤：${j.error}`);
  });
  await check('POST /api/pilot-log/auth/refresh（無 refreshToken）→ 400', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert(r.status === 400, `status ${r.status}`);
  });

  // ── Auth-protected endpoints (no token → 401) ─────────────────────────
  console.log('\n🔒 Auth 保護（未登入應回 401）:');
  const protectedGet = [
    '/api/pilot-log/me',
    '/api/pilot-log/entries',
    '/api/pilot-log/entries/00000000-0000-0000-0000-000000000000',
    '/api/pilot-log/aircraft',
    '/api/pilot-log/stats',
    '/api/pilot-log/quick-suggest',
  ];
  for (const path of protectedGet) {
    await check(`GET ${path} → 401`, async () => {
      const r = await fetch(`${BASE}${path}`);
      assert(r.status === 401, `status ${r.status}`);
    });
  }
  await check('POST /api/pilot-log/entries → 401', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert(r.status === 401, `status ${r.status}`);
  });
  await check('POST /api/pilot-log/import/logten-flights → 401', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/import/logten-flights`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'fake',
    });
    assert(r.status === 401, `status ${r.status}`);
  });
  await check('DELETE /api/pilot-log/entries?source=logten&confirm=true（無 auth）→ 401', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/entries?source=logten&confirm=true`, { method: 'DELETE' });
    assert(r.status === 401, `status ${r.status}`);
  });

  // ── Admin stats endpoint（V1.0.05）─────────────────────────────────────
  console.log('\n📊 Admin stats endpoint:');
  await check('GET /api/pilot-log/admin/stats（無 pw）→ 403', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/admin/stats`);
    assert(r.status === 403, `status ${r.status}`);
  });
  await check('GET /api/pilot-log/admin/stats?pw=wrong → 403', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/admin/stats?pw=wrong-secret-xx`);
    assert(r.status === 403, `status ${r.status}`);
  });
  await check('GET /api/pilot-log/admin/stats?pw=（空字串）→ 403', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/admin/stats?pw=`);
    assert(r.status === 403, `status ${r.status}`);
  });

  // ── Bearer with bogus token → 401 ─────────────────────────────────────
  await check('Bearer 假 token → 401', async () => {
    const r = await fetch(`${BASE}/api/pilot-log/me`, {
      headers: { 'Authorization': 'Bearer not-a-real-token' },
    });
    assert(r.status === 401, `status ${r.status}`);
  });

  // ── 主站不受影響（regression）─────────────────────────────────────────
  console.log('\n🏠 主站隔離檢查:');
  let mainHtml = '';
  await check('GET /main → 200', async () => {
    const r = await fetch(`${BASE}/main`, { redirect: 'follow' });
    assert(r.ok, `status ${r.status}`);
    mainHtml = await r.text();
  });
  await check('main 不含 Pilot Log tab button', async () => {
    assert(!mainHtml.includes('tabBtn-pilotlog'), '主站還掛著 Pilot Log tab button');
  });
  await check('main 不含 tab-pilotlog pane', async () => {
    assert(!mainHtml.includes('id="tab-pilotlog"'), '主站還有 tab-pilotlog pane');
  });
  await check('main 不含 pilot-log.js section 標記', async () => {
    assert(!mainHtml.includes('SECTION: editor'), 'pilot-log.js 不該被 inline 進主站');
  });

  // ── 結果 ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`✅ 通過: ${passed}  ❌ 失敗: ${failed}`);
  console.log(`${'─'.repeat(40)}\n`);

  if (failed > 0) {
    console.log('⛔ Pilot Log smoke test 未全過\n');
  } else {
    console.log('🎉 Pilot Log smoke test 全過\n');
  }
}

run()
  .catch(e => { console.error('測試執行失敗:', e); })
  .finally(() => {
    stopServer();
    process.exit(failed > 0 ? 1 : 0);
  });
