/**
 * CrewSync Smoke Test
 * 推版前必跑，確認基本功能正常
 *
 * 用法：npm test（自動啟動 server、測完自動關閉）
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
        // 多等 1 秒確保 server 完全就緒
        setTimeout(resolve, 1000);
      }
    });
    server.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('EADDRINUSE')) {
        clearTimeout(timeout);
        reject(new Error('Port 3000 已被佔用，請先關閉其他 server'));
      }
    });
    server.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

function stopServer() {
  if (server) {
    server.kill();
    server = null;
  }
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

async function fetchOk(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { redirect: 'follow' });
  assert(res.ok, `${path} returned ${res.status}`);
  return await res.text();
}

async function run() {
  console.log('\n🧪 CrewSync Smoke Test\n');
  console.log('⏳ 啟動 server...');
  await startServer();
  console.log('✅ Server 已啟動\n');

  // ── 頁面回應 ──
  console.log('📄 頁面回應:');
  const pages = ['/', '/main', '/share', '/privacy', '/terms', '/faq', '/gate', '/fr24', '/ops', '/sync'];
  for (const p of pages) {
    await check(`GET ${p} → 200`, async () => { await fetchOk(p); });
  }

  // ── 主頁內容檢查 ──
  console.log('\n🔍 主頁內容:');
  const html = await fetchOk('/main');

  await check('版號存在 (V6.)', async () => {
    assert(html.includes('V6.'), '找不到版號');
  });

  await check('Tab bar 存在', async () => {
    assert(html.includes('class="tab-bar"'), '找不到 tab-bar');
  });

  await check('Roster Sync tab', async () => {
    assert(html.includes('Roster Sync'), '找不到 Roster Sync');
  });

  await check('Operation tab', async () => {
    assert(html.includes('Operation'), '找不到 Operation');
  });

  await check('FR24 tab', async () => {
    assert(html.includes('FR24'), '找不到 FR24');
  });

  await check('Gate Info tab', async () => {
    assert(html.includes('Gate Info'), '找不到 Gate Info');
  });

  await check('標題含 JX', async () => {
    assert(html.includes('JX航空組員') || html.includes('JX crew'), '標題缺少 JX');
  });

  await check('Google OAuth 按鈕', async () => {
    assert(html.includes('doGoogleAuth'), '找不到 OAuth 按鈕');
  });

  // ── Subtab 檢查 ──
  console.log('\n📑 Operation Subtabs:');
  const subtabs = ['Briefing', 'PA', 'Rest Calc', 'Pacific HF', 'WX', 'Cold Temp', 'Tools', 'Duty Time'];
  for (const st of subtabs) {
    await check(`Subtab: ${st}`, async () => {
      assert(html.includes(st), `找不到 subtab: ${st}`);
    });
  }

  // ── 隱私政策內容 ──
  console.log('\n🔒 隱私政策:');
  const privacy = await fetchOk('/privacy');

  await check('Data Accessed 段落', async () => {
    assert(privacy.includes('Data Accessed'), '缺少 Data Accessed');
  });

  await check('Data Usage 段落', async () => {
    assert(privacy.includes('Data Usage'), '缺少 Data Usage');
  });

  await check('Data Sharing 段落', async () => {
    assert(privacy.includes('Data Sharing'), '缺少 Data Sharing');
  });

  await check('Data Storage & Protection 段落', async () => {
    assert(privacy.includes('Data Storage'), '缺少 Data Storage');
  });

  await check('Data Retention & Deletion 段落', async () => {
    assert(privacy.includes('Data Retention'), '缺少 Data Retention');
  });

  await check('Limited Use 聲明', async () => {
    assert(privacy.includes('Limited Use'), '缺少 Limited Use 聲明');
  });

  await check('Google API Policy 連結', async () => {
    assert(privacy.includes('developers.google.com/terms/api-services-user-data-policy'), '缺少 Google API Policy 連結');
  });

  // ── API 端點 ──
  console.log('\n🔌 API 端點:');
  await check('GET /api/fr24 回應', async () => {
    const res = await fetch(`${BASE}/api/fr24`);
    assert(res.ok || res.status === 503, `/api/fr24 returned ${res.status}`);
  });

  await check('GET /api/fids 回應', async () => {
    const res = await fetch(`${BASE}/api/fids`);
    assert(res.status < 500 || res.status === 502 || res.status === 503, `/api/fids returned ${res.status}`);
  });

  await check('GET /oauth/url 回應', async () => {
    const res = await fetch(`${BASE}/oauth/url`);
    assert(res.status < 500, `/oauth/url returned ${res.status}`);
  });

  // ── 結果 ──
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`✅ 通過: ${passed}  ❌ 失敗: ${failed}`);
  console.log(`${'─'.repeat(40)}\n`);

  if (failed > 0) {
    console.log('⛔ 測試未全部通過，請修復後再推版\n');
  } else {
    console.log('🎉 全部通過，可以推版\n');
  }
}

run()
  .catch(e => {
    console.error('測試執行失敗:', e);
  })
  .finally(() => {
    stopServer();
    process.exit(failed > 0 ? 1 : 0);
  });
