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

export interface CrewMember {
  workCode: string;
  position: string;
  staffId: string;
  rank: string;
  name: string;
}

export interface FlightDetail {
  flightNo: string;
  date: string;
  origin: string;
  dest: string;
  depTime: string;
  arrTime: string;
  depTimeUtc?: string;
  arrTimeUtc?: string;
  position?: string;
  flightTime?: string;
  workCode?: string;
  crew: CrewMember[];
}

export interface RosterResult {
  employeeId: string;
  duties: { duty: string; reportTime: string; endTime: string; flights: FlightDetail[] }[];
}

export async function generateICSHeadless(
  targetYear: number,
  targetMonth: number,
  jxCredentials: { username: string; password: string },
  icsPath: string,
  onLog?: (msg: string) => void
): Promise<RosterResult> {
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

      for (let i = 0; i < Math.abs(diff); i++) {
        let clicked = false;

        // 方法1: 用 rosterCalendarNav class 定位容器，點第一或最後一個子元素
        if (!clicked) {
          try {
            const navContainer = page.locator('[class*="rosterCalendarNav"]');
            if (await navContainer.count() > 0) {
              // 先試 button，再試任何子元素
              const btns = navContainer.locator('button');
              const btnCount = await btns.count();
              if (btnCount >= 2) {
                await (direction < 0 ? btns.first() : btns.last()).click();
                clicked = true;
              } else {
                // 沒有 button，試所有直接子元素
                const children = navContainer.locator('> *');
                const childCount = await children.count();
                if (childCount >= 2) {
                  await (direction < 0 ? children.first() : children.last()).click();
                  clicked = true;
                }
              }
            }
          } catch {}
        }

        // 方法2: 用 rosterCalendarNav 內所有可點擊的直接子節點（含 div）
        if (!clicked) {
          try {
            const handle = await page.evaluateHandle((dir: number) => {
              const nav = document.querySelector('[class*="rosterCalendarNav"]');
              if (!nav) return null;
              const children = Array.from(nav.querySelectorAll('button, [role="button"], div, span'))
                .filter(el => {
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && r.width < 200;
                });
              children.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
              return dir < 0 ? children[0] ?? null : children[children.length - 1] ?? null;
            }, direction);
            const el = handle.asElement();
            if (el) { await el.click(); clicked = true; }
          } catch {}
        }

        // 方法3: 找任何含 PREVIOUS/NEXT 文字的元素
        if (!clicked) {
          try {
            const el = page.locator(`text="${direction < 0 ? 'PREVIOUS' : 'NEXT'}"`).first();
            if (await el.count() > 0) { await el.click({ timeout: 3000 }); clicked = true; }
          } catch {}
        }

        if (!clicked) {
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
    interface DutyDetail { duty: string; reportTime: string; endTime: string; flights: FlightDetail[] }
    const dutyDetails: DutyDetail[] = [];
    const processedDuties = new Set<string>();

    // ── 抓取員工編號 ─────────────────────────────────────────
    let employeeId = '';
    try {
      employeeId = await page.evaluate(() => {
        const body = document.body.innerText;
        const m = body.match(/Close Menu\n(\d{5,})/);
        return m ? m[1] : '';
      });
      if (!employeeId) {
        // fallback: 找頁面上的 7 位數字
        employeeId = await page.evaluate(() => {
          const m = document.body.innerText.match(/\b(\d{7})\b/);
          return m ? m[1] : '';
        });
      }
      if (employeeId) log(`🪪 員工編號: ${employeeId}`);
    } catch { /* non-fatal */ }

    let crewName = '';
    let i = 0;
    const SKIP = new Set([
      'DO',  'HDO', 'BDO', 'MDO',
      'ANL', 'AWL', 'B1L', 'B2L', 'B3L', 'BNL', 'DSL', 'DPL', 'FCL', 'HAL',
      'HPL', 'M1L', 'M2L', 'M3L', 'M4L', 'M5L', 'M6L', 'M7L', 'M8L', 'MRL',
      'MTL', 'OKL', 'PNL', 'POL', 'PSL', 'PTL', 'PVL', 'RAL', 'SKL', 'SUP',
      'TFL', 'UBL', 'UKL', 'UQL', 'PPSL',
    ]);

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

      const flights: FlightDetail[] = [];

      if (isFlightDuty) {
        const items = await page.$$('.tripActivityItem');
        const flightNos: string[] = [];
        let outstation = '';

        for (const item of items) {
          const d = await item.evaluate((el) => ({
            flightNo: el.querySelector('.flightId')?.textContent?.trim() ?? '',
            origin: (el.querySelector('.startLocnId') as HTMLElement)?.textContent?.trim() ?? '',
            dest: (el.querySelector('.endLocnId') as HTMLElement)?.textContent?.trim() ?? '',
            depTimeLocal: (el.querySelector('.startTimeLocal') as HTMLElement)?.textContent?.trim() ?? '',
            depTimeUtc: (el.querySelector('.startTimeUTC, .startTimeUtc') as HTMLElement)?.textContent?.trim() ?? '',
            arrTimeLocal: (el.querySelector('.endTimeLocal') as HTMLElement)?.textContent?.trim() ?? '',
            arrTimeUtc: (el.querySelector('.endTimeUTC, .endTimeUtc') as HTMLElement)?.textContent?.trim() ?? '',
            position: (el.querySelector('.position') as HTMLElement)?.textContent?.trim() ?? '',
            flightTime: (el.querySelector('.flightTime') as HTMLElement)?.textContent?.trim().replace(/^FT\s*/, '') ?? '',
            workCode: (el.querySelector('.workDuty') as HTMLElement)?.firstChild?.textContent?.trim() ?? '',
          }));
          if (d.flightNo) {
            flightNos.push(d.flightNo);
            flights.push({
              flightNo: d.flightNo, date: '', origin: d.origin, dest: d.dest,
              depTime: d.depTimeLocal, arrTime: d.arrTimeLocal,
              depTimeUtc: d.depTimeUtc, arrTimeUtc: d.arrTimeUtc,
              position: d.position, flightTime: d.flightTime, workCode: d.workCode,
              crew: []
            });
          }
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

      } else {
        // ── Training / 非航班 duty：解析每天的子項目 ──
        // 確保 ActDetail tab 是啟動的
        try {
          const actTab = page.locator('#rosterAllocationView-tab-ActDetail, a[href*="ActDetail"].nav-link').first();
          if (await actTab.count() > 0) await actTab.click();
          await page.waitForTimeout(500);
        } catch {}

        const trainingItems = await page.evaluate(() => {
          const results: any[] = [];
          const pane = document.querySelector('#rosterAllocationView-tabpane-ActDetail') || document.body;
          const cards = pane.querySelectorAll('.card-body');
          for (const card of cards) {
            const dateEls = card.querySelectorAll('[class*="dutyStart"]');
            let dateStr = '';
            for (const de of dateEls) {
              const t = de.textContent?.trim() || '';
              if (/^\d{4}\./.test(t)) { dateStr = t; break; }
            }
            const item = card.querySelector('.tripActivityItem');
            if (!item) continue;
            results.push({
              date: dateStr,
              workCode: item.querySelector('.workDuty')?.textContent?.trim() ?? '',
              startTime: item.querySelector('.startTimeLocal')?.textContent?.trim() ?? '',
              endTime: item.querySelector('.endTimeLocal')?.textContent?.trim() ?? '',
              position: item.querySelector('.position')?.textContent?.trim() ?? '',
            });
          }
          return results;
        });

        for (const d of trainingItems) {
          if (!d.workCode) continue;
          const datePrefix = d.date || '';
          const fullStart = datePrefix && d.startTime ? `${datePrefix} ${d.startTime}` : d.startTime;
          const fullEnd = datePrefix && d.endTime ? `${datePrefix} ${d.endTime}` : d.endTime;
          flights.push({
            flightNo: d.workCode, date: d.date, origin: '', dest: '',
            depTime: fullStart, arrTime: fullEnd,
            position: d.position, workCode: d.workCode, crew: []
          });
        }
        if (flights.length > 0) {
          finalDutyName = flights.map(f => f.workCode).join(' + ');
        }
        log(`📚 Training 子項目：${flights.length} 筆 (${flights.map(f => f.workCode).join(', ')})`);
      }

      // ── 抓取組員名單（CREW tab）── 航班和訓練都抓
      try {
        const crewTab = page.locator('#rosterAllocationView-tab-Crew, a[href*="Crew"].nav-link').first();
        if (await crewTab.count() > 0) {
          await crewTab.click();
          await page.waitForTimeout(1200);
          const flightHeaders = await page.$$('#rosterAllocationView-tabpane-Crew .accordion-button, #rosterAllocationView-tabpane-Crew [class*="accordion"] > [class*="header"], #rosterAllocationView-tabpane-Crew [class*="card-header"]');
          const crewData: Record<string, Array<{workCode:string;position:string;staffId:string;rank:string;name:string}>> = {};

          const parseCrewText = `(function() {
            var pane = document.querySelector('#rosterAllocationView-tabpane-Crew') || document.body;
            var text = pane.innerText;
            var result = {};
            var sections = text.split(/((?:JX\\d+|Training) - [A-Za-z]+\\.\\d+)/);
            for (var s = 1; s < sections.length; s += 2) {
              var header = sections[s].trim();
              var isTraining = header.indexOf('Training') >= 0;
              var label = isTraining ? header.trim() : header.split(' - ')[0].trim();
              var tableText = sections[s + 1] || '';
              var rows = tableText.split('\\n').filter(function(r) { return r.includes('\\t'); });
              var crew = [];
              for (var ri = 0; ri < rows.length; ri++) {
                var c = rows[ri].split('\\t');
                if (c[0] === 'Work Code' || c[0] === 'Position') continue;
                if (c.length >= 5) {
                  crew.push({workCode:c[0],position:c[1],staffId:c[2],rank:c[3],name:c[4]});
                } else if (c.length >= 4) {
                  crew.push({workCode:'--',position:c[0],staffId:c[1],rank:c[2],name:c[3]});
                }
              }
              if (crew.length) result[label] = crew;
            }
            return result;
          })()`;

          if (flightHeaders.length === 0) {
            const data = await page.evaluate(parseCrewText) as Record<string, Array<{workCode:string;position:string;staffId:string;rank:string;name:string}>>;
            Object.assign(crewData, data);
          } else {
            for (const header of flightHeaders) {
              await header.click();
              await page.waitForTimeout(600);
              const data = await page.evaluate(parseCrewText) as Record<string, Array<{workCode:string;position:string;staffId:string;rank:string;name:string}>>;
              Object.assign(crewData, data);
            }
          }
          // Match crew to flights
          for (const f of flights) {
            // 航班：直接用 flightNo 比對
            if (crewData[f.flightNo]) {
              f.crew = crewData[f.flightNo];
            }
            // Training：用日期比對（crewData key 格式 "Training - Feb.09"）
            if (!f.crew || f.crew.length === 0) {
              for (const [label, crew] of Object.entries(crewData)) {
                if (!f.date) continue;
                const datePart = f.date.split('.').slice(1).join('.');
                if (label.includes(datePart)) {
                  f.crew = crew;
                  break;
                }
              }
            }
          }
          log(`👥 組員名單已擷取（${Object.keys(crewData).length} 個項目）`);
        }
      } catch (crewErr: any) {
        log(`⚠️ 組員名單擷取失敗: ${crewErr.message}`);
      }

      dutyDetails.push({ duty: finalDutyName, reportTime, endTime, flights });
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

    // 從 duty crew 資料中用 employeeId 找自己的名字
    if (!crewName && employeeId) {
      for (const d of dutyDetails) {
        if (crewName) break;
        for (const f of (d as any).flights || []) {
          if (crewName) break;
          for (const c of f.crew || []) {
            if (c.staffId === employeeId && c.name) {
              crewName = c.name;
              log(`👤 組員姓名: ${crewName}`);
              break;
            }
          }
        }
      }
    }

    return { employeeId, crewName, duties: dutyDetails };
  } finally {
    await browser.close();
  }
}
