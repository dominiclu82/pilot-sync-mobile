import express from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { OUTPUT_DIR, ROOT, loadCredentials } from './config.js';
import { generateICSHeadless } from './generate-ics-headless.js';
import { syncICS, SyncResult } from './upload-ics.js';
import { getSpaStyles } from './spa/styles.js';
import { getSpaHtmlBody } from './spa/html-body.js';
import { getSpaCoreJs } from './spa/js-core.js';
import { getSpaWeatherJs } from './spa/js-weather.js';
import { getSpaDutyTimeJs } from './spa/js-duty-time.js';
import { getSpaGateInfoJs } from './spa/js-gate-info.js';


config({ path: path.join(ROOT, '.env') });

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Determine redirect URI: env var > BASE_URL-derived > credentials.json
const _creds = loadCredentials();
const REDIRECT_URI: string = process.env.REDIRECT_URI
  || (process.env.BASE_URL ? `${process.env.BASE_URL}/api/oauth2callback` : _creds.web.redirect_uris[0]);
const _ru = new URL(REDIRECT_URI);
const REDIRECT_PORT = parseInt(_ru.port) || (REDIRECT_URI.startsWith('https') ? 443 : 80);
const REDIRECT_PATH = _ru.pathname;

// ── Job state ────────────────────────────────────────────────────────────────

interface SyncJob {
  status: 'running' | 'done' | 'error';
  logs: string[];
  result?: SyncResult;
  newRefreshToken?: string;
  error?: string;
  startedAt: Date;
  icsPath: string;
}

const jobs = new Map<string, SyncJob>();

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.startedAt.getTime() < cutoff) {
      try { if (fs.existsSync(job.icsPath)) fs.unlinkSync(job.icsPath); } catch {}
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── Server ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getSPAHtml());
});

app.get('/icon.svg', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="38" fill="#1e2740"/>
  <text x="96" y="145" text-anchor="middle" font-size="115"
    font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">✈️</text>
</svg>`);
});

app.get('/manifest.json', (_req, res) => {
  res.json({
    name: 'CrewSync',
    short_name: 'CrewSync',
    description: 'Crew Roster → Google Calendar',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0e1a',
    theme_color: '#1e2740',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  });
});

app.get('/oauth/url', (_req, res) => {
  try {
    const creds = loadCredentials();
    const client = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret, REDIRECT_URI);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      scope: ['https://www.googleapis.com/auth/calendar'],
    });
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get(REDIRECT_PATH, oauthCallback);
app.get('/api/oauth2callback', oauthCallback); // 雲端路徑
app.get('/oauth/callback', oauthCallback);     // 本機 fallback

// ── METAR proxy ────────────────────────────────────────────────────────────────
app.get('/api/metar', async (req, res) => {
  try {
    const { ids, hours } = req.query;
    const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&format=raw&hours=${hours || 1}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (e: any) {
    res.status(502).send('');
  }
});

// ── Service Worker ────────────────────────────────────────────────────────────
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
const CACHE = 'crewsync-v1';
const SHELL = ['/'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (url.includes('/api/fids')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  if (url.includes('/api/metar')) {
    e.respondWith(fetch(e.request).then(r => {
      const clone = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(cached => {
    const net = fetch(e.request).then(r => {
      caches.open(CACHE).then(c => c.put(e.request, r.clone()));
      return r;
    });
    return cached || net;
  }));
});
`);
});

// ── Pacific HF proxy ──────────────────────────────────────────────────────────
app.get('/api/pacific-hf', async (_req, res) => {
  try {
    const r = await fetch('https://radio.arinc.net/pacific/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' }
    });
    let html = await r.text();
    // 注入 base tag 讓相對路徑可以正確載入
    html = html.replace(/<head>/i, '<head><base href="https://radio.arinc.net/">');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e: any) {
    res.status(502).send(`<p style="font-family:sans-serif;padding:20px;color:red">無法載入 Pacific HF 資料：${e.message}</p>`);
  }
});

// ── FIDS proxy ──────────────────────────────────────────────────────────────
app.get('/api/fids', async (req, res) => {
  try {
    let odate = req.query.date as string || '';
    if (!odate || !/^\d{4}\/\d{2}\/\d{2}$/.test(odate)) {
      const now = new Date();
      const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      odate = tw.getUTCFullYear() + '/' +
        String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
        String(tw.getUTCDate()).padStart(2, '0');
    }

    const base = {
      ODate: odate, OTimeOpen: null, OTimeClose: null,
      BNO: null, AState: '', language: 'ch', keyword: ''
    };
    const hdrs: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://www.taoyuan-airport.com',
      'Referer': 'https://www.taoyuan-airport.com/flight_arrival'
    };
    const ep = 'https://www.taoyuan-airport.com/api/api/flight/a_flight';

    const [dR, aR] = await Promise.all([
      fetch(ep, { method: 'POST', headers: hdrs, body: JSON.stringify({ ...base, AState: 'D' }) }),
      fetch(ep, { method: 'POST', headers: hdrs, body: JSON.stringify({ ...base, AState: 'A' }) })
    ]);

    if (!dR.ok || !aR.ok) {
      console.error(`FIDS proxy upstream error: dep=${dR.status} arr=${aR.status}`);
      res.status(502).json({ error: `upstream ${dR.status}/${aR.status}` });
      return;
    }

    const dep = await dR.json();
    const arr = await aR.json();
    res.json({ dep, arr, date: odate });
  } catch (e: any) {
    console.error('FIDS proxy error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── FlightAware background cache ─────────────────────────────────────────────
const _faBase = Buffer.from('aHR0cHM6Ly93d3cuZmxpZ2h0YXdhcmUuY29tL2xpdmUvZmxpZ2h0Lw==', 'base64').toString();
const _faHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };

interface FaCacheEntry {
  flights: Record<string, FaFlightData>;
  updatedAt: number;
}
interface FaFlightData {
  fno: string;
  origin: { iata: string; gate: string; terminal: string };
  destination: { iata: string; gate: string; terminal: string };
  scheduledDep: string;
  actualDep: string;
  scheduledArr: string;
  actualArr: string;
  status: string;
}

let _faCache: FaCacheEntry = { flights: {}, updatedAt: 0 };

function _parseFaPage(html: string): FaFlightData[] {
  const m = html.match(/trackpollBootstrap\s*=\s*(\{[\s\S]*?\});\s*(?:var\s|<\/script>)/);
  if (!m) return [];
  let data: any;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const results: FaFlightData[] = [];
  const flights = data?.flights || {};
  for (const id of Object.keys(flights)) {
    const logs = flights[id]?.activityLog?.flights || [];
    for (const f of logs) {
      const orig = f.origin || {};
      const dest = f.destination || {};
      const iataOrig = orig.iata || orig.altIdent || '';
      const iataDest = dest.iata || dest.altIdent || '';
      // Convert ICAO ident (SJX12) to IATA (JX12)
      const displayIdent = f.displayIdent || id.split('-')[0] || '';
      const fno = displayIdent.replace(/^SJX/, 'JX');
      results.push({
        fno,
        origin: { iata: iataOrig, gate: orig.gate || '', terminal: orig.terminal || '' },
        destination: { iata: iataDest, gate: dest.gate || '', terminal: dest.terminal || '' },
        scheduledDep: f.gateDepartureTimes?.scheduled ? new Date(f.gateDepartureTimes.scheduled * 1000).toISOString() : '',
        actualDep: f.gateDepartureTimes?.actual ? new Date(f.gateDepartureTimes.actual * 1000).toISOString() : '',
        scheduledArr: f.gateArrivalTimes?.scheduled ? new Date(f.gateArrivalTimes.scheduled * 1000).toISOString() : '',
        actualArr: f.gateArrivalTimes?.actual ? new Date(f.gateArrivalTimes.actual * 1000).toISOString() : '',
        status: f.flightStatus || (f.cancelled ? 'Cancelled' : '')
      });
    }
  }
  return results;
}

async function _faFetchFlight(icaoIdent: string): Promise<FaFlightData[]> {
  try {
    const r = await fetch(_faBase + icaoIdent, { headers: _faHeaders });
    if (!r.ok) return [];
    const html = await r.text();
    return _parseFaPage(html);
  } catch { return []; }
}

async function _faRefreshCache(): Promise<void> {
  console.log('[FA] Starting background refresh...');
  try {
    // Get JX fleet page for active flights
    const fleetUrl = Buffer.from('aHR0cHM6Ly93d3cuZmxpZ2h0YXdhcmUuY29tL2xpdmUvZmxlZXQvU0pY', 'base64').toString();
    const r = await fetch(fleetUrl, { headers: _faHeaders });
    if (!r.ok) { console.error('[FA] Fleet page error:', r.status); return; }
    const html = await r.text();

    // Extract SJX flight idents from fleet page
    const identSet = new Set<string>();
    const identMatches = html.matchAll(/SJX\d+/g);
    for (const im of identMatches) identSet.add(im[0]);

    // Also add scheduled flights from TPE FIDS if available
    try {
      const tpeBase = 'https://www.taoyuan-airport.com/api/api/flight/a_flight';
      const now = new Date();
      const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const odate = tw.getUTCFullYear() + '/' +
        String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
        String(tw.getUTCDate()).padStart(2, '0');
      const hdrs: Record<string, string> = {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.taoyuan-airport.com',
        'Referer': 'https://www.taoyuan-airport.com/flight_arrival'
      };
      const base = { ODate: odate, OTimeOpen: null, OTimeClose: null, BNO: null, AState: '', language: 'ch', keyword: '' };
      const [dR, aR] = await Promise.all([
        fetch(tpeBase, { method: 'POST', headers: hdrs, body: JSON.stringify({ ...base, AState: 'D' }) }),
        fetch(tpeBase, { method: 'POST', headers: hdrs, body: JSON.stringify({ ...base, AState: 'A' }) })
      ]);
      if (dR.ok && aR.ok) {
        const dep = await dR.json();
        const arr = await aR.json();
        for (const f of [...(dep || []), ...(arr || [])]) {
          if (f.ACode?.trim() === 'JX') {
            const num = (f.FlightNo || '').replace(/\s/g, '');
            if (num) identSet.add('SJX' + num);
          }
        }
      }
    } catch {}

    console.log('[FA] Found', identSet.size, 'JX flights:', [...identSet].join(', '));

    // Today's date range (Taiwan time, with 6h buffer on each side)
    const now = Date.now();
    const tw = new Date(now + 8 * 60 * 60 * 1000);
    const todayStart = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
    const rangeStart = todayStart.getTime() - 6 * 60 * 60 * 1000; // 6h before midnight TW
    const rangeEnd = todayStart.getTime() + 30 * 60 * 60 * 1000;  // 6h after midnight+1 TW

    // Fetch each flight page (with delay to avoid rate limiting)
    const newFlights: Record<string, FaFlightData> = {};
    for (const ident of identSet) {
      const entries = await _faFetchFlight(ident);
      for (const entry of entries) {
        const key = entry.fno;
        if (!key) continue;
        // Filter: only keep today's flights (by scheduled departure time)
        const depTime = entry.scheduledDep ? new Date(entry.scheduledDep).getTime() : 0;
        const arrTime = entry.scheduledArr ? new Date(entry.scheduledArr).getTime() : 0;
        const refTime = depTime || arrTime;
        if (refTime && (refTime < rangeStart || refTime > rangeEnd)) continue;
        // Prefer entry with gate data
        if (!newFlights[key] || entry.origin.gate || entry.destination.gate) {
          newFlights[key] = entry;
        }
      }
      // Small delay between requests
      await new Promise(ok => setTimeout(ok, 500));
    }

    _faCache = { flights: newFlights, updatedAt: Date.now() };
    console.log('[FA] Cache updated:', Object.keys(newFlights).length, 'flights');
  } catch (e: any) {
    console.error('[FA] Refresh error:', e.message);
  }
}

// Start background refresh: immediately + every 5 minutes
setTimeout(() => _faRefreshCache(), 5000);
setInterval(() => _faRefreshCache(), 5 * 60 * 1000);

app.get('/api/fids-fa', (_req, res) => {
  res.json({
    flights: _faCache.flights,
    updatedAt: _faCache.updatedAt ? new Date(_faCache.updatedAt).toISOString() : null,
    count: Object.keys(_faCache.flights).length
  });
});

async function oauthCallback(req: express.Request, res: express.Response) {
  const { code } = req.query;
  if (!code) { res.status(400).send('Missing code'); return; }
  try {
    const creds = loadCredentials();
    const client = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret, REDIRECT_URI);
    const { tokens } = await client.getToken(code as string);
    const rt = tokens.refresh_token ?? '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0a0e1a;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style>
</head><body>
<div><p style="font-size:2.5em">✅</p><p>授權完成！<br>正在關閉視窗...</p></div>
<script>
  try { window.opener && window.opener.postMessage({ type:'oauth_done', refreshToken:${JSON.stringify(rt)} }, '*'); } catch(e){}
  setTimeout(() => window.close(), 1000);
</script></body></html>`);
  } catch (err: any) {
    res.status(500).send(`<p>授權失敗：${err.message}</p>`);
  }
}

app.get('/debug/screenshot', (_req, res) => {
  // 找最新的 debug 截圖
  try {
    if (!fs.existsSync(OUTPUT_DIR)) { res.status(404).send('No screenshot'); return; }
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('-debug.png'))
      .map(f => ({ f, t: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) { res.status(404).send('No screenshot yet. Run a sync first.'); return; }
    res.sendFile(path.join(OUTPUT_DIR, files[0].f));
  } catch (err: any) { res.status(500).send(err.message); }
});

app.post('/sync', async (req, res) => {
  const { year, month, jxUsername, jxPassword, refreshToken, calendarId } = req.body;
  if (!year || !month || !jxUsername || !jxPassword || !refreshToken || !calendarId) {
    res.status(400).json({ error: '缺少必要參數' });
    return;
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const jobId = randomUUID();
  const icsPath = path.join(OUTPUT_DIR, `roster-${jobId}.ics`);
  const job: SyncJob = { status: 'running', logs: [], startedAt: new Date(), icsPath };
  jobs.set(jobId, job);

  const onLog = (msg: string) => { job.logs.push(msg); };

  (async () => {
    try {
      await generateICSHeadless(Number(year), Number(month), { username: jxUsername, password: jxPassword }, icsPath, onLog);
      const { result, newRefreshToken } = await syncICS({ refreshToken, calendarId, icsPath, onLog });
      job.result = result;
      if (newRefreshToken) job.newRefreshToken = newRefreshToken;
      job.status = 'done';
    } catch (err: any) {
      job.error = err.message;
      job.status = 'error';
      onLog(`❌ 錯誤：${err.message}`);
    } finally {
      try { if (fs.existsSync(icsPath)) fs.unlinkSync(icsPath); } catch {}
    }
  })();

  res.json({ jobId });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: '找不到此工作' }); return; }
  res.json({ status: job.status, logs: job.logs, result: job.result, newRefreshToken: job.newRefreshToken, error: job.error });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 CrewSync 伺服器啟動：${BASE_URL}`);
});

// If the registered redirect URI is on a different port, start a second mini-server for it
if (REDIRECT_PORT && REDIRECT_PORT !== Number(PORT)) {
  const callbackApp = express();
  callbackApp.get(REDIRECT_PATH, oauthCallback);
  callbackApp.listen(REDIRECT_PORT, '0.0.0.0', () => {
    console.log(`🔑 OAuth callback 監聽：${REDIRECT_URI}`);
  });
}


// ── SPA HTML ─────────────────────────────────────────────────────────────────
function getSPAHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,minimum-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="CrewSync">
<meta name="theme-color" content="#0a0e1a">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<title>CrewSync</title>
<style>
${getSpaStyles()}
</style>
</head>
<body>
${getSpaHtmlBody()}
<script>
${getSpaCoreJs()}
${getSpaWeatherJs()}
${getSpaDutyTimeJs()}
${getSpaGateInfoJs()}
</script>
</body>
</html>`;
}
