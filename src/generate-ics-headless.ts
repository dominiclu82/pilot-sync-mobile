import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { OUTPUT_DIR } from './config.js';

const MONTH_ABBR_MAP: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function parseToolbarLabel(label: string): { year: number; month: number } {
  const parts = label.trim().toUpperCase().split('.');
  return { year: parseInt(parts[0]), month: MONTH_ABBR_MAP[parts[1]] ?? 1 };
}

const parseFullDateTime = (fullDateTimeStr: string): string => {
  if (!fullDateTimeStr) return '';
  const parts = fullDateTimeStr.split(' ');
  if (parts.length !== 2) return '';
  const datePart = parts[0];
  const timePart = parts[1].replace('L', '');
  const [year, monthAbbr, day] = datePart.split('.');
  const monthNum = new Date(Date.parse(monthAbbr + ' 1, 2000')).getMonth();
  if (timePart.length !== 4) return '';
  const hour = parseInt(timePart.substring(0, 2));
  const minute = parseInt(timePart.substring(2, 4));
  const dateObj = new Date(parseInt(year), monthNum, parseInt(day), hour, minute);
  const formattedMonth = dateObj.toLocaleString('en-us', { month: 'short' });
  const formattedDay = dateObj.getDate().toString().padStart(2, '0');
  return `${dateObj.getFullYear()}.${formattedMonth}.${formattedDay} ${timePart}L`;
};

export async function generateICSHeadless(
  targetYear: number,
  targetMonth: number,
  jxCredentials: { username: string; password: string },
  icsPath: string,
  onLog?: (msg: string) => void
): Promise<void> {
  const log = (msg: string) => { console.log(msg); onLog?.(msg); };
  const { username, password } = jxCredentials;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // ── 登入 ──────────────────────────────────────────────
    log('🌐 開啟登入頁面...');
    await page.goto('https://jxcrew.starlux-airlines.com/jxcrew/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#username', username);
    await page.fill('#password', password);

    try {
      await Promise.all([
        page.waitForNavigation({ timeout: 8000 }),
        page.click('button[type="submit"]'),
      ]);
      log('✅ 登入成功');
    } catch {
      throw new Error('登入失敗，請確認 JX 帳號密碼是否正確');
    }

    // 登入後直接導覽到 roster 頁面（登入不一定自動跳轉）
    const currentUrl = page.url();
    if (!currentUrl.includes('/roster')) {
      log('🔀 導覽至班表頁面...');
      await page.goto('https://jxcrew.starlux-airlines.com/jxcrew/roster', { waitUntil: 'load', timeout: 30000 });
    }
    log(`📍 URL: ${page.url()}`);
    await page.waitForTimeout(2000); // 等 React 完整渲染

    // ── 切換月份 ───────────────────────────────────────────
    // 月份標題格式為 "2026.FEB"，用文字 pattern 定位
    const monthLocator = page.locator('text=/^\\d{4}\\.(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/i').first();
    await monthLocator.waitFor({ state: 'visible', timeout: 15000 });
    const toolbarLabel = ((await monthLocator.textContent()) ?? '').trim();
    if (!toolbarLabel) throw new Error('無法讀取月曆月份');

    const { year: curYear, month: curMonth } = parseToolbarLabel(toolbarLabel);
    const diff = (targetYear * 12 + targetMonth) - (curYear * 12 + curMonth);

    // 截圖供偵錯
    const debugScreenshotPath = icsPath.replace('.ics', '-debug.png');
    try { await page.screenshot({ path: debugScreenshotPath, fullPage: false }); } catch {}

    if (diff !== 0) {
      const direction = diff < 0 ? -1 : 1;
      log(`🗓️ 切換月份：${curYear}/${curMonth} → ${targetYear}/${targetMonth}`);

      // 列出頁面 header 區所有元素供偵錯
      const headerInfo = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('*'))
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.y > 50 && r.y < 250 && r.width > 5 && r.width < 400 && r.height > 5 && r.height < 80;
          })
          .map(el => {
            const r = el.getBoundingClientRect();
            return `[${el.tagName} cls="${(el.className+'').substring(0,25)}" x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} txt="${(el.textContent??'').trim().substring(0,15)}"]`;
          }).slice(0, 20).join(' ');
      });
      log(`🔍 Header元素: ${headerInfo}`);

      for (let i = 0; i < Math.abs(diff); i++) {
        let clicked = false;

        // 方法0: 嘗試 Open Menu 按鈕（可能是月份選擇器入口）
        try {
          const openMenuBtn = page.getByRole('button', { name: 'Open Menu' });
          if (await openMenuBtn.count() > 0) {
            await openMenuBtn.click();
            await page.waitForTimeout(800);
            // 找月份選擇器或 PREVIOUS/NEXT
            const prevEl = page.locator(`text="${direction < 0 ? 'PREVIOUS' : 'NEXT'}"`).first();
            if (await prevEl.count() > 0) {
              await prevEl.click({ timeout: 3000 });
              clicked = true;
            }
            if (!clicked) {
              // 關閉選單再試其他方法
              try { await page.getByRole('button', { name: /close menu/i }).click(); } catch {}
            }
          }
        } catch {}

        // 方法1: 找任何含 PREVIOUS/NEXT 文字的元素
        if (!clicked) {
          try {
            const el = page.locator(`text="${direction < 0 ? 'PREVIOUS' : 'NEXT'}"`).first();
            if (await el.count() > 0) { await el.click({ timeout: 3000 }); clicked = true; }
          } catch {}
        }

        // 方法2: 鍵盤導覽 ArrowLeft/Right
        if (!clicked) {
          for (const key of (direction < 0 ? ['ArrowLeft', 'PageUp'] : ['ArrowRight', 'PageDown'])) {
            try {
              await page.keyboard.press(key);
              await page.waitForTimeout(600);
              const newLbl = ((await monthLocator.textContent()) ?? '').trim();
              if (newLbl !== toolbarLabel) { clicked = true; break; }
            } catch {}
          }
        }

        // 方法3: 掃描 header 區域的可點擊元素
        if (!clicked) {
          try {
            const box = await monthLocator.boundingBox();
            if (box) {
              const handle = await page.evaluateHandle(({ dir, cy }: { dir: number; cy: number }) => {
                const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
                  const r = el.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0 || r.width > 400 || r.height > 100) return false;
                  if (Math.abs((r.top + r.height / 2) - cy) > 60) return false;
                  const s = window.getComputedStyle(el);
                  return s.cursor === 'pointer' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
                });
                candidates.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
                return dir < 0 ? candidates[0] ?? null : candidates[candidates.length - 1] ?? null;
              }, { dir: direction, cy: box.y + box.height / 2 });
              const el = handle.asElement();
              if (el) { await el.click(); clicked = true; }
            }
          } catch {}
        }

        if (!clicked) {
          // 最後截圖
          try { await page.screenshot({ path: debugScreenshotPath, fullPage: false }); } catch {}
          throw new Error('找不到月份切換方式，請查看 /debug/screenshot');
        }
        await page.waitForTimeout(1200);
      }

      await monthLocator.waitFor({ state: 'visible', timeout: 5000 });
      const newLabel = ((await monthLocator.textContent()) ?? '').trim();
      const { year: vy, month: vm } = parseToolbarLabel(newLabel);
      if (vy !== targetYear || vm !== targetMonth) {
        throw new Error(`月份切換失敗。目標: ${targetYear}/${targetMonth}，實際: ${vy}/${vm}`);
      }
    }
    log(`✅ 已切換至 ${targetYear}年${targetMonth}月`);

    // ── Time 檢視 ──────────────────────────────────────────
    try {
      await page.click('#toggleEventViewType');
      await page.waitForTimeout(1000);
    } catch { /* 非致命 */ }

    // ── 抓取班表 ───────────────────────────────────────────
    interface DutyDetail { duty: string; reportTime: string; endTime: string; }
    const dutyDetails: DutyDetail[] = [];
    const processedDuties = new Set<string>();
    let i = 0;
    const SKIP = new Set(['DO', 'HDO', 'BDO', 'ANL', 'PSL']);

    while (true) {
      await page.waitForSelector('.rbc-event-content', { timeout: 2000 });
      const elements = await page.$$('.rbc-event-content');
      if (i >= elements.length) break;

      const el = elements[i];
      const dutyText = (await el.innerText()).trim();

      if (SKIP.has(dutyText)) { i++; continue; }

      log(`🔍 [${i}] ${dutyText}`);

      try {
        await el.scrollIntoViewIfNeeded();
        await el.click({ timeout: 3000 });
      } catch {
        log(`⚠️ [${i}] 無法點擊，跳過`);
        i++; continue;
      }

      try {
        await page.waitForURL('**/roster-allocation/**', { timeout: 5000 });
        await page.waitForSelector('.RosterAllocationView_rosterAllocationHeaderSummary__qyXG7', { timeout: 10000 });
        await page.waitForTimeout(500);
      } catch {
        log(`⚠️ [${i}] 頁面未跳轉，跳過`);
        await page.goBack({ waitUntil: 'domcontentloaded' });
        try { await page.waitForSelector('.rbc-event-content', { timeout: 2000 }); } catch { break; }
        i++; continue;
      }

      const isFlightDuty = dutyText.startsWith('JX');
      const headerDivs = await page.$$('.RosterAllocationView_rosterAllocationHeaderSummary__qyXG7 div');
      let reportTimeStr = '', endTimeStr = '';

      for (let j = 0; j < headerDivs.length; j++) {
        const txt = (await headerDivs[j].textContent())?.trim();
        if (txt === 'From') reportTimeStr = (await headerDivs[j + 1]?.textContent())?.trim() || '';
        else if (txt === 'To') endTimeStr = (await headerDivs[j + 1]?.textContent())?.trim() || '';
      }

      const reportTime = parseFullDateTime(reportTimeStr);
      const endTime = parseFullDateTime(endTimeStr);
      let finalDutyName = dutyText;

      if (isFlightDuty) {
        const items = await page.$$('.tripActivityItem');
        const flightNos: string[] = [];
        let outstation = '';

        for (const item of items) {
          const d = await item.evaluate((el) => ({
            flightNo: el.querySelector('.RosterAllocationView_flightId__dvh72')?.textContent?.trim() ?? '',
            dest: el.querySelector('.RosterAllocationView_endLocnId__XVqIa')?.textContent?.trim() ?? '',
          }));
          if (d.flightNo) flightNos.push(d.flightNo);
          if (d.dest && d.dest !== 'TPE') outstation = d.dest;
        }
        if (!outstation && flightNos.length) outstation = 'TPE';

        const combined = [...new Set(flightNos)].join('/');
        finalDutyName = `${combined} ${outstation}`.trim();
        const dutyKey = `${combined}-${reportTime.split(' ')[0]}`;
        if (processedDuties.has(dutyKey)) {
          await page.goBack({ waitUntil: 'domcontentloaded' });
          try { await page.waitForSelector('.rbc-event-content', { timeout: 2000 }); } catch { break; }
          i++; continue;
        }
        processedDuties.add(dutyKey);
      }

      dutyDetails.push({ duty: finalDutyName, reportTime, endTime });
      log(`✅ [${i}] ${finalDutyName}`);

      await page.goBack({ waitUntil: 'domcontentloaded' });
      try { await page.waitForSelector('.rbc-event-content', { timeout: 2000 }); } catch { break; }
      i++;
    }

    log(`\n📋 共擷取 ${dutyDetails.length} 筆班次，生成 ICS...`);

    // ── 生成 ICS ───────────────────────────────────────────
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    let ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//CrewSync//Roster//EN\nCALSCALE:GREGORIAN\nMETHOD:PUBLISH\n`;

    for (const d of dutyDetails) {
      if (!d.reportTime || !d.endTime) continue;

      const toICS = (dt: string): string => {
        const [dp, tp] = dt.split(' ');
        const [y, mo, day] = dp.split('.');
        const t = tp.replace('L', '');
        const m = new Date(Date.parse(mo + ' 1, 2000')).getMonth() + 1;
        return `${y}${m.toString().padStart(2,'0')}${day.padStart(2,'0')}T${t.substring(0,2)}${t.substring(2,4)}00`;
      };

      const start = toICS(d.reportTime);
      const end = toICS(d.endTime);
      const uid = `${d.duty.toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9\/]/g,'')}-${start}@crewsync`;
      const isJX = /^JX\d{3}/.test(d.duty);

      ics += `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:${d.duty}\nDESCRIPTION:Imported from CrewSync\n`;
      if (isJX) {
        ics += `BEGIN:VALARM\nTRIGGER:-PT60M\nACTION:DISPLAY\nDESCRIPTION:Reminder\nEND:VALARM\n`;
        ics += `BEGIN:VALARM\nTRIGGER:-PT1440M\nACTION:DISPLAY\nDESCRIPTION:Reminder\nEND:VALARM\n`;
      }
      ics += `END:VEVENT\n`;
    }

    ics += 'END:VCALENDAR\n';
    fs.writeFileSync(icsPath, ics, 'utf8');
    log(`✅ ICS 已生成（${dutyDetails.length} 筆）`);

  } finally {
    await browser.close();
  }
}
