/**
 * CrewSync Browser E2E（C 層）
 * 用真 chromium 載入每個功能頁，抓「執行期」致命錯 —— 語法對、但跑起來爆的那種（解析檢查 A 抓不到）。
 * 抓兩種訊號：
 *   1. pageerror —— 未捕捉的 JS 例外（最強的「頁面壞掉」訊號）
 *   2. console.error 中明顯是我們程式的（ReferenceError / not a function …）
 *   外部資料源 / CDN / 地圖磚 / 測試環境網路失敗等雜訊一律過濾，不算我們的鍋。
 * 用法：npm run test:browser（自動起 server、headless、測完關閉）
 */
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { chromium, Browser } from 'playwright';

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;
let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    // ⚠ 安全鎖：絕不碰正式 DB。DATABASE_URL='' → server 的 _pool=null（無 DB 模式）。
    server = spawn('npx', ['tsx', 'src/server.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, DATABASE_URL: '' },
    });
    const timeout = setTimeout(() => reject(new Error('Server 啟動超時')), 30000);
    server.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('伺服器啟動')) {
        clearTimeout(timeout);
        setTimeout(resolve, 1000);
      }
    });
    server.stderr?.on('data', (data: Buffer) => {
      if (data.toString().includes('EADDRINUSE')) {
        clearTimeout(timeout);
        reject(new Error('Port 3000 已被佔用，請先關閉其他 server'));
      }
    });
    server.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

function stopServer() {
  // ⚠ Windows + shell:true 會多包一層 cmd，server.kill() 只殺 cmd、殺不到底下 tsx/node →
  //   server 會殘留卡住 port 3000，害下一個 test「fetch failed」。用 taskkill /T 殺整棵 process tree。
  if (server && server.pid) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
      else server.kill('SIGTERM');
    } catch { /* 已關就算了 */ }
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

// 外部依賴 / 網路 / CDN / 地圖磚 / 測試環境狀態碼 → 不是我們 client JS 的問題，過濾掉（避免 flaky）。
const BENIGN = [
  /net::ERR_|Failed to load resource|Failed to fetch|NetworkError|AbortError|ERR_NAME_NOT_RESOLVED|ERR_INTERNET|ERR_CONNECTION/i,
  /favicon|ResizeObserver loop|manifest/i,
  /\bL\b is not defined|leaflet|\bChart\b is not defined|chart\.js/i,                         // CDN（測試環境可能載不到 → 非我們的鍋）
  /opensky|fr24|flightradar|fids|coffee|airframes|\batis\b|googleapis|gstatic|oauth|accounts\.google|jsdelivr|openstreetmap|cartocdn|basemaps|\btile/i,
  /\b(401|403|404|408|429|500|502|503|504)\b/,
];
const isReal = (t: string) => !BENIGN.some((re) => re.test(t));
// console.error 噪音多，只在「明顯是我們程式壞掉」時才當致命
const CODE_ERR = /ReferenceError|is not defined|is not a function|Cannot read propert|Cannot access|Unexpected token|SyntaxError|TypeError|is not a constructor/i;

async function run() {
  console.log('\n🌐 CrewSync Browser E2E（C 層：真瀏覽器逐頁跑）\n');
  console.log('⏳ 啟動 server...');
  await startServer();
  console.log('✅ Server 已啟動');
  console.log('⏳ 啟動 headless chromium...');
  const browser: Browser = await chromium.launch({ headless: true });
  console.log('✅ 瀏覽器就緒\n');

  console.log('📄 逐頁載入:');
  const pages = ['/main', '/share', '/gate', '/fr24', '/ops', '/sync', '/pilot-log', '/morning', '/apps'];
  for (const path of pages) {
    await check(`${path} 真瀏覽器載入無致命錯`, async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const fatal: string[] = [];
      page.on('pageerror', (e) => { const t = String(e); if (isReal(t)) fatal.push('未捕捉例外: ' + t); });
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (isReal(t) && CODE_ERR.test(t)) fatal.push('console.error: ' + t);
      });
      try {
        const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
        assert(!!resp && resp.status() < 400, `HTTP ${resp ? resp.status() : '無回應'}`);
        await page.waitForTimeout(1800);   // 給 client JS 跑起來、把該爆的爆出來
        const elCount = await page.evaluate(() => document.querySelectorAll('*').length);
        assert(elCount > 30, `頁面幾乎空白（DOM 僅 ${elCount} 個元素）— 疑似白畫面`);
        assert(fatal.length === 0, fatal[0]);
      } finally {
        await ctx.close();
      }
    });
  }

  await browser.close();

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`✅ 通過: ${passed}  ❌ 失敗: ${failed}`);
  console.log(`${'─'.repeat(40)}\n`);
  console.log(failed > 0 ? '⛔ 有頁面在真瀏覽器跑出致命錯\n' : '🎉 全部頁面真瀏覽器跑起來都正常\n');
}

run()
  .catch((e) => { console.error('測試執行失敗:', e); failed++; })
  .finally(() => { stopServer(); process.exit(failed > 0 ? 1 : 0); });
