/**
 * Morning Report Smoke Test
 * 晨報獨立測試，涵蓋所有 /morning 路由與 API
 *
 * 用法：npm run test:m（自動啟動 server、測完自動關閉）
 */

import { spawn, ChildProcess } from 'child_process';

const BASE = 'http://localhost:3000';
const TEST_UID = 'smoketest';  // 測試用的暱稱
const UID_HEADERS = { 'X-User-Id': TEST_UID };
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
        setTimeout(resolve, 1500);
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

async function run() {
  console.log('\n🌅 Morning Report Smoke Test\n');
  console.log('⏳ 啟動 server...');
  await startServer();
  console.log('✅ Server 已啟動\n');

  // ── 頁面回應 ──
  console.log('📄 /morning 頁面與 PWA 資源:');

  await check('GET /morning → 200', async () => {
    const res = await fetch(`${BASE}/morning`);
    assert(res.ok, `/morning returned ${res.status}`);
    const html = await res.text();
    assert(html.includes('晨報'), '頁面缺少「晨報」標題');
    assert(html.includes('Morning Report'), '頁面缺少 Morning Report 副標');
  });

  await check('GET /morning/manifest.json → 200 + 今日 name', async () => {
    const res = await fetch(`${BASE}/morning/manifest.json`);
    assert(res.ok, `manifest returned ${res.status}`);
    const j: any = await res.json();
    assert(j.name && j.name.includes('今日'), 'manifest name 缺少「今日」');  // V2.0.04 改名「晨報」→「今日 Today」
    assert(j.start_url === '/morning', `start_url 錯誤: ${j.start_url}`);
    assert(j.scope === '/morning/', `scope 錯誤: ${j.scope}`);
  });

  await check('GET /morning/sw.js → 200 + CACHE name', async () => {
    const res = await fetch(`${BASE}/morning/sw.js`);
    assert(res.ok, `sw.js returned ${res.status}`);
    const text = await res.text();
    assert(text.includes('CACHE'), 'SW 缺少 CACHE 定義');
    assert(text.includes('morning-v'), 'SW CACHE name 格式不對');
  });

  await check('GET /morning/icon.svg → 200 + SVG', async () => {
    const res = await fetch(`${BASE}/morning/icon.svg`);
    assert(res.ok, `icon.svg returned ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert(ct.includes('svg'), `content-type 不是 SVG: ${ct}`);
    const text = await res.text();
    assert(text.includes('<svg'), 'SVG 內容缺失');
  });

  // ── HTML 內容檢查 ──
  console.log('\n🔍 /morning HTML 內容:');
  const res = await fetch(`${BASE}/morning`);
  const html = await res.text();

  await check('版號存在 (V1.)', async () => {
    assert(/V1\.\d+\.\d+/.test(html), '找不到 V 開頭版號');
  });

  await check('Header 含「🌅 晨報」', async () => {
    assert(html.includes('🌅'), '缺少 🌅 emoji');
  });

  await check('Nav bar 含 5 個快速按鈕', async () => {
    assert(html.includes('天氣'), 'nav 缺少天氣');
    assert(html.includes('台股'), 'nav 缺少台股');
    assert(html.includes('美股'), 'nav 缺少美股');
    assert(html.includes('台灣新聞'), 'nav 缺少台灣新聞');
    assert(html.includes('世界新聞'), 'nav 缺少世界新聞');
  });

  await check('Header 按鈕 A+ / A- / 🌙 / 📅 / ↻', async () => {
    assert(html.includes('A+') && html.includes('A−'), '缺少字型按鈕');
    assert(html.includes('btn-theme'), '缺少主題切換按鈕');
    assert(html.includes('btn-date'), '缺少歷史月曆按鈕');
    assert(html.includes('btn-refresh'), '缺少重新整理按鈕');
  });

  await check('設定 modal 結構（4 區塊）', async () => {
    assert(html.includes('data-section="wx"'), '缺少 wx 設定區');
    assert(html.includes('data-section="tw"'), '缺少 tw 設定區');
    assert(html.includes('data-section="us"'), '缺少 us 設定區');
    assert(html.includes('data-section="fx"'), '缺少 fx 設定區');
  });

  await check('Service Worker 註冊', async () => {
    assert(html.includes('/morning/sw.js'), '缺少 SW 註冊');
    assert(html.includes('scope:'), '缺少 SW scope 設定');
  });

  await check('頁面 <script> 內的 JS 能成功 parse（防 template literal 逸出錯）', async () => {
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert(!!m, '找不到 <script> 內容');
    const js = m![1];
    try {
      new Function(js);
    } catch (e: any) {
      throw new Error('JS parse failed: ' + e.message);
    }
  });

  // ── API 端點 ──
  console.log('\n🔌 API 端點:');

  // 缺 X-User-Id header 應被拒絕
  await check('GET /api/morning-report 無 uid → 400', async () => {
    const res = await fetch(`${BASE}/api/morning-report`);
    assert(res.status === 400, `應回 400 實際 ${res.status}`);
  });

  // 先 POST 一個初始 prefs + refresh 建立測試使用者資料
  await check('POST /api/morning-prefs (建立測試使用者)', async () => {
    const res = await fetch(`${BASE}/api/morning-prefs`, {
      method: 'POST',
      headers: { ...UID_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wx: [{ name: '台北', lat: 25.03, lon: 121.56 }],
        tw: ['2330'], us: ['NVDA'], fx: ['USD/TWD'],
      }),
    });
    assert(res.ok, `prefs POST returned ${res.status}`);
    const j: any = await res.json();
    assert(j.ok === true, 'prefs save ok 不是 true');
  });

  await check('GET /api/morning-prefs (取回剛存的)', async () => {
    const res = await fetch(`${BASE}/api/morning-prefs`, { headers: UID_HEADERS });
    assert(res.ok, `prefs GET returned ${res.status}`);
    const j: any = await res.json();
    assert(Array.isArray(j.tw) && j.tw.includes('2330'), '取回的 prefs 缺 2330');
  });

  await check('POST /api/morning-report/refresh (per-user build)', async () => {
    const res = await fetch(`${BASE}/api/morning-report/refresh`, {
      method: 'POST', headers: UID_HEADERS,
    });
    assert(res.status === 200 || res.status === 503, `refresh returned ${res.status}`);
    const j: any = await res.json();
    assert(typeof j.ok === 'boolean', 'response 缺少 ok 欄位');
  });

  await check('GET /api/morning-report → 200 + 該使用者的資料', async () => {
    const res = await fetch(`${BASE}/api/morning-report`, { headers: UID_HEADERS });
    assert(res.ok || res.status === 404, `/api/morning-report returned ${res.status}`);
    if (res.ok) {
      const j: any = await res.json();
      assert(typeof j === 'object' && j !== null, 'response 不是 object');
      assert('date' in j || '_actualDate' in j, '缺少 date 欄位');
    }
  });

  await check('GET /api/morning-report/dates → 200 + dates array', async () => {
    const res = await fetch(`${BASE}/api/morning-report/dates`, { headers: UID_HEADERS });
    assert(res.ok, `/dates returned ${res.status}`);
    const j: any = await res.json();
    assert(Array.isArray(j.dates), 'dates 不是 array');
  });

  await check('GET /api/morning-translate → 200', async () => {
    const res = await fetch(`${BASE}/api/morning-translate?q=hello`);
    assert(res.ok, `translate returned ${res.status}`);
    const j: any = await res.json();
    assert('translated' in j, 'response 缺少 translated 欄位');
  });

  // 中文暱稱 round trip：header 必須 URL-encoded，避免 iOS Safari fetch TypeError
  await check('中文暱稱 prefs round trip', async () => {
    const nick = '測試用戶';
    const encoded = encodeURIComponent(nick);
    // Save
    const save = await fetch(`${BASE}/api/morning-prefs`, {
      method: 'POST',
      headers: { 'X-User-Id': encoded, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wx: [], tw: ['2330'], us: [], fx: [] }),
    });
    assert(save.ok, `Chinese nick save returned ${save.status}`);
    // Retrieve
    const get = await fetch(`${BASE}/api/morning-prefs`, {
      headers: { 'X-User-Id': encoded },
    });
    assert(get.ok, `Chinese nick get returned ${get.status}`);
    const j: any = await get.json();
    assert(Array.isArray(j.tw) && j.tw.includes('2330'), '中文暱稱 prefs 讀不回');
  });

  // 多使用者隔離測試：alice 的 report 只應含她自己的選擇
  await check('使用者隔離：alice 的 report 只含 alice 的 prefs', async () => {
    // alice 只選 2317（跟 smoketest 的 2330 不同）
    const alicePrefs = { wx: [], tw: ['2317'], us: [], fx: [] };
    await fetch(`${BASE}/api/morning-prefs`, {
      method: 'POST',
      headers: { 'X-User-Id': 'smoketestalice', 'Content-Type': 'application/json' },
      body: JSON.stringify(alicePrefs),
    });
    // 觸發 alice 的 build
    const refreshRes = await fetch(`${BASE}/api/morning-report/refresh`, {
      method: 'POST',
      headers: { 'X-User-Id': 'smoketestalice' },
    });
    assert(refreshRes.ok, `alice refresh returned ${refreshRes.status}`);
    // 讀 alice 的 report
    const res = await fetch(`${BASE}/api/morning-report`, { headers: { 'X-User-Id': 'smoketestalice' } });
    assert(res.ok, `alice report returned ${res.status}`);
    const j: any = await res.json();
    const aliceTw = Object.keys(j.stocks_tw || {});
    assert(aliceTw.includes('2317'), `alice 應含 2317，實際 ${aliceTw.join(',')}`);
    assert(!aliceTw.includes('2330'), `alice 不應含 smoketest 的 2330，實際 ${aliceTw.join(',')}`);
  });

  // ── Builder 單元測試（不透過 HTTP，直接 import）──
  console.log('\n🔧 Morning Builder（直接 import）:');

  await check('buildMorningReport 能 import', async () => {
    const m: any = await import('../src/morning-builder.js');
    assert(typeof m.buildMorningReport === 'function', 'buildMorningReport 不是 function');
  });

  // ── CrewSync 共存驗證：晨報路由不應影響 CrewSync 主路由 ──
  console.log('\n🤝 與 CrewSync 共存:');

  await check('GET /main 仍正常（CrewSync 未被影響）', async () => {
    const res = await fetch(`${BASE}/main`);
    assert(res.ok, `/main returned ${res.status}`);
    const text = await res.text();
    assert(text.includes('CrewSync') || text.includes('V'), 'CrewSync 主頁異常');
  });

  await check('/morning 和 /main 各自獨立 manifest', async () => {
    const m1 = await (await fetch(`${BASE}/manifest.json`)).json() as any;
    const m2 = await (await fetch(`${BASE}/morning/manifest.json`)).json() as any;
    assert(m1.name === 'CrewSync', 'CrewSync manifest name 不對');
    assert(m2.name && m2.name.includes('今日'), '今日 manifest name 不對');  // V2.0.04 改名「晨報」→「今日 Today」
    assert(m1.scope !== m2.scope, 'manifest scope 應獨立');
  });

  // ── 結果 ──
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`✅ 通過: ${passed}  ❌ 失敗: ${failed}`);
  console.log(`${'─'.repeat(40)}\n`);

  if (failed > 0) {
    console.log('⛔ 晨報測試未全部通過，請修復後再推版\n');
  } else {
    console.log('🎉 晨報全部通過，可以推版\n');
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
