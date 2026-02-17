import fs from 'fs';
import { google } from 'googleapis';
import ical from 'ical';
import { loadCredentials } from './config.js';

export interface SyncResult {
  addedCount: number;
  updatedCount: number;
  deletedCount: number;
  totalCount: number;
}

export async function syncICS(params: {
  refreshToken: string;
  calendarId: string;
  icsPath: string;
  onLog?: (msg: string) => void;
}): Promise<{ result: SyncResult; newRefreshToken: string | null }> {
  const { refreshToken, calendarId, icsPath, onLog } = params;
  const log = (msg: string) => { console.log(msg); onLog?.(msg); };

  // ical 將浮動時間（無時區）以 UTC 解析，但實際上是台北時間，
  // 需用 UTC 數值直接組成 +08:00 字串，避免二次轉換
  const toTaipei = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00+08:00`;
  };

  log('📋 開始上傳到 Google 日曆...');

  const credentials = loadCredentials();
  const oauth2Client = new google.auth.OAuth2(
    credentials.web.client_id,
    credentials.web.client_secret,
    credentials.web.redirect_uris[0]
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  let newRefreshToken: string | null = null;
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      newRefreshToken = tokens.refresh_token;
    }
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  if (!fs.existsSync(icsPath)) {
    throw new Error('找不到 ICS 檔案，請先執行班表擷取');
  }

  const icsContent = fs.readFileSync(icsPath, 'utf8');
  const icsData = ical.parseICS(icsContent);

  const eventsToUpload = Object.values(icsData)
    .filter((e) => e.type === 'VEVENT')
    .map((e) => ({
      uid: e.uid ? String(e.uid).trim().toLowerCase() : '',
      summary: e.summary,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      startDate: e.start,
      endDate: e.end,
    }));

  log(`📊 ICS 解析出 ${eventsToUpload.length} 筆事件`);

  if (eventsToUpload.length === 0) {
    return { result: { addedCount: 0, updatedCount: 0, deletedCount: 0, totalCount: 0 }, newRefreshToken };
  }

  // 計算同步時間範圍
  const allStartDates = eventsToUpload.map(e => e.startDate);
  const allEndDates = eventsToUpload.map(e => e.endDate);
  const earliestDate = new Date(Math.min(...allStartDates.map(d => d.getTime())));
  const latestDate = new Date(Math.max(...allEndDates.map(d => d.getTime())));

  const timeMin = new Date(earliestDate);
  timeMin.setDate(timeMin.getDate() - 1);
  const timeMax = new Date(latestDate);
  timeMax.setDate(timeMax.getDate() + 1);

  log(`📅 同步範圍: ${timeMin.toISOString().split('T')[0]} 到 ${timeMax.toISOString().split('T')[0]}`);

  const icsUIDsSet = new Set(eventsToUpload.map(e => e.uid));

  // 獲取 Google 日曆現有事件
  const existingUIDMap = new Map<string, string>();
  const eventsToDelete: Array<{ summary: string; eventId: string; uid: string }> = [];
  let pageToken: string | undefined = undefined;

  do {
    const existing = await calendar.events.list({
      calendarId,
      showDeleted: true,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
    });

    for (const ev of (existing.data.items || [])) {
      if (ev.iCalUID && ev.id) {
        const standardizedUID = String(ev.iCalUID).trim().toLowerCase();
        existingUIDMap.set(standardizedUID, ev.id);

        const isCrewSyncEvent =
          standardizedUID.includes('@crewsync') ||
          (ev.description && ev.description.includes('Imported from CrewSync'));

        if (isCrewSyncEvent && !icsUIDsSet.has(standardizedUID)) {
          eventsToDelete.push({
            summary: ev.summary || '未知事件',
            eventId: ev.id,
            uid: standardizedUID,
          });
        }
      }
    }
    pageToken = existing.data.nextPageToken || undefined;
  } while (pageToken);

  // 刪除已取消事件
  let deletedCount = 0;
  for (const event of eventsToDelete) {
    try {
      await calendar.events.delete({ calendarId, eventId: event.eventId });
      deletedCount++;
      log(`🗑️ 已刪除: ${event.summary}`);
    } catch (err: any) {
      if (err.message?.includes('Resource has been deleted')) {
        deletedCount++;
      } else {
        log(`⚠️ 刪除失敗 ${event.summary}: ${err.message}`);
      }
    }
  }

  // 新增或更新事件
  let addedCount = 0;
  let updatedCount = 0;

  for (const event of eventsToUpload) {
    const isFlightDuty = /^JX\d{3}/.test(event.summary);
    const requestBody = {
      summary: event.summary,
      start: { dateTime: toTaipei(event.startDate), timeZone: 'Asia/Taipei' },
      end: { dateTime: toTaipei(event.endDate), timeZone: 'Asia/Taipei' },
      description: 'Imported from CrewSync',
      reminders: isFlightDuty ? {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 24 * 60 },
        ],
      } : { useDefault: true },
    };

    try {
      if (existingUIDMap.has(event.uid)) {
        await calendar.events.update({
          calendarId,
          eventId: existingUIDMap.get(event.uid)!,
          requestBody,
        });
        updatedCount++;
        log(`🔁 已更新: ${event.summary}`);
      } else {
        await calendar.events.insert({
          calendarId,
          requestBody: { ...requestBody, iCalUID: event.uid },
        });
        addedCount++;
        log(`✅ 已新增: ${event.summary}`);
      }
    } catch (err: any) {
      log(`❌ 錯誤 ${event.summary}: ${err.message}`);
    }
  }

  log(`\n🎉 同步完成！新增 ${addedCount}、更新 ${updatedCount}、刪除 ${deletedCount}`);

  return {
    result: { addedCount, updatedCount, deletedCount, totalCount: eventsToUpload.length },
    newRefreshToken,
  };
}
