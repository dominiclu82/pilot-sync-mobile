/**
 * CrewSync Smoke Test
 * 推版前必跑，確認基本功能正常
 *
 * 用法：npm test（自動啟動 server、測完自動關閉）
 */

import { spawn, ChildProcess } from 'child_process';
import { Script } from 'vm';

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;
let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    // ⚠ 安全鎖：smoke test 絕不可碰正式 DB。把 DATABASE_URL 設成空字串，
    // server.ts 的 _pool 就會是 null（無 DB 模式）→ 不連庫、不跑 migration。
    // dotenv 沒開 override，空字串「已存在」→ .env 不會蓋回真實連線字串。
    server = spawn('npx', ['tsx', 'src/server.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, DATABASE_URL: '' },
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

// 抽出 HTML 裡所有「本地 inline <script>」內容（跳過外部 CDN src= 與非 JS 的資料區塊）。
//   本專案 client JS 全部 inline 進 HTML（只有 leaflet/chart.js 走 CDN）→ 解析這些就涵蓋全部前端程式。
function extractInlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;                                                   // 外部 CDN（leaflet/chart.js）→ 不檢
    if (/\btype\s*=\s*["']?(application\/(ld\+)?json|text\/(template|html))/i.test(attrs)) continue;  // JSON/模板資料區塊，非 JS
    const code = (m[2] || '').trim();
    if (code) out.push(code);
  }
  return out;
}

// 解析（只編譯不執行）一段 client JS → 語法錯就拋。瀏覽器 global（document/window）在「編譯」階段不會被碰，所以不需要它們。
function assertParses(code: string, label: string) {
  try {
    new Script(code);   // vm 編譯：解析 + 編譯成 bytecode，但不 run → 純抓 SyntaxError
  } catch (e: any) {
    const head = code.slice(0, 70).replace(/\s+/g, ' ');
    throw new Error(`${label} 解析失敗：${e.message}｜開頭「${head}」`);
  }
}

async function run() {
  console.log('\n🧪 CrewSync Smoke Test\n');
  console.log('⏳ 啟動 server...');
  await startServer();
  console.log('✅ Server 已啟動\n');

  // ── 頁面回應 ──
  console.log('📄 頁面回應:');
  const pages = ['/', '/main', '/share', '/privacy', '/terms', '/faq', '/gate', '/fr24', '/ops', '/sync', '/pilot-log', '/morning', '/apps'];
  for (const p of pages) {
    await check(`GET ${p} → 200`, async () => { await fetchOk(p); });
  }

  // ── 主頁內容檢查 ──
  console.log('\n🔍 主頁內容:');
  const html = await fetchOk('/main');

  await check('版號存在 (V6.)', async () => {
    assert(html.includes('V6.') || html.includes('V7.'), '找不到版號');
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

  // ── Client JS 解析（白畫面防線）──
  // ⚠ 內容檢查（html.includes('Roster Sync')）只驗「字串在不在」，不驗「JS 跑不跑得起來」。
  //    真正會白畫面的是 client JS 語法錯（template literal \n、regex 壞字元…），這節對每頁的 inline <script> 實際解析一遍，抓那類致命錯。
  console.log('\n🧩 Client JS 解析（白畫面防線）:');
  const jsPages = ['/main', '/share', '/gate', '/fr24', '/ops', '/sync', '/pilot-log', '/morning', '/apps'];
  for (const p of jsPages) {
    await check(`${p} inline JS 全部可解析`, async () => {
      const pageHtml = await fetchOk(p);
      const scripts = extractInlineScripts(pageHtml);
      assert(scripts.length > 0, `找不到任何 inline <script>（頁面可能整個壞掉）`);
      scripts.forEach((s, i) => assertParses(s, `${p} 第 ${i + 1}/${scripts.length} 段`));
    });
  }

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
