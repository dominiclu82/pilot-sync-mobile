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
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { chromium as pwChromium } from 'playwright';


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
  if (url.includes('/api/fids-us')) {
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
app.get('/api/fids', async (_req, res) => {
  try {
    const now = new Date();
    const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const odate = tw.getUTCFullYear() + '/' +
      String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
      String(tw.getUTCDate()).padStart(2, '0');

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

// ── US FIDS proxy ────────────────────────────────────────────────────────────
function _sfoMap(f: any): any {
  return {
    airport: 'SFO',
    fno: (f.airline?.iata_code || '') + (f.flight_number || ''),
    direction: f.flight_kind === 'Arrival' ? 'A' : 'D',
    gate: f.gate?.gate_number || '',
    terminal: f.terminal?.terminal_code || '',
    carousel: f.baggage_carousel?.carousel_name || '',
    scheduled: f.scheduled_aod_time || '',
    estimated: f.estimated_aod_time || '',
    actual: f.actual_aod_time || '',
    status: f.remark || '',
    origin: f.flight_kind === 'Arrival' ? (f.routes?.[0]?.origin_airport?.iata_code || '') : 'SFO',
    dest: f.flight_kind === 'Arrival' ? 'SFO' : (f.routes?.[0]?.destination_airport?.iata_code || '')
  };
}

async function fetchSFO(): Promise<any[]> {
  const r = await fetch('https://www.flysfo.com/flysfo/api/flight-status', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  if (!r.ok) return [];
  const data = await r.json();
  const all = data.data || data || [];
  const jx = all.filter((f: any) => f.airline?.iata_code === 'JX');
  if (jx.length > 0) return jx.map(_sfoMap);
  // Test: return first available flight as sample
  if (all.length > 0) {
    const s = _sfoMap(all[0]);
    s._test = true;
    return [s];
  }
  return [];
}

function _phxMap(f: any): any {
  return {
    airport: 'PHX',
    fno: (f.LineCode || '') + (f.Flightnumber || ''),
    direction: f.AD === 'A' ? 'A' : 'D',
    gate: f.Gate || '',
    terminal: f.Terminal ? 'T' + f.Terminal : '',
    carousel: f.BagClaim || '',
    scheduled: f.ScheduledDateTime || f.ScheduledTime || '',
    estimated: f.Estimated || '',
    actual: f.Actual || '',
    status: f.Status || '',
    origin: f.AD === 'A' ? (f.Destination || '').replace(/.*\((\w+)\).*/, '$1') : 'PHX',
    dest: f.AD === 'A' ? 'PHX' : (f.Destination || '').replace(/.*\((\w+)\).*/, '$1')
  };
}

async function fetchPHX(): Promise<any[]> {
  const r = await fetch('https://api.phx.aero/flight-information?Key=4f85fe2ef5a240d59809b63de94ef536', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  if (!r.ok) return [];
  const data = await r.json();
  const all = data || [];
  const jx = all.filter((f: any) => f.LineCode === 'JX');
  if (jx.length > 0) return jx.map(_phxMap);
  if (all.length > 0) {
    const s = _phxMap(all[0]);
    s._test = true;
    return [s];
  }
  return [];
}

function _seaMapRow(cells: string[], dir: string, isTest: boolean): any {
  const obj: any = {
    airport: 'SEA',
    fno: cells[2] || '',
    direction: dir,
    gate: cells[6] || '',
    terminal: '',
    carousel: cells[7] || '',
    scheduled: cells[4] || '',
    estimated: '',
    actual: '',
    status: cells[5] || '',
    origin: dir === 'A' ? (cells[0] || '') : 'SEA',
    dest: dir === 'A' ? 'SEA' : (cells[0] || '')
  };
  if (isTest) obj._test = true;
  return obj;
}

async function fetchSEA(): Promise<any[]> {
  const results: any[] = [];
  let hasTest = false;
  for (const dir of ['A', 'D']) {
    const r = await fetch(
      `https://www.portseattle.org/pos/flights?arr_or_depart=${dir}&airline=&flightNo=&city=&flight_date=`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) continue;
    const html = await r.text();
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    let foundJX = false;
    let firstRow: string[] | null = null;
    for (const row of rows) {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map((c: string) => c.replace(/<[^>]+>/g, '').trim());
      if (cells.length < 7) continue;
      if (!firstRow) firstRow = cells;
      if ((cells[2] || '').startsWith('JX')) {
        results.push(_seaMapRow(cells, dir, false));
        foundJX = true;
      }
    }
    if (!foundJX && firstRow && !hasTest) {
      results.push(_seaMapRow(firstRow, dir, true));
      hasTest = true;
    }
  }
  return results;
}

function _laxParseRow(row: string, type: string): any | null {
  const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
    .map((c: string) => c.replace(/<[^>]+>/g, '').trim());
  const fnMatch = row.match(/fn=([A-Z0-9]+\d+)/i);
  const fno = fnMatch ? fnMatch[1].toUpperCase() : (cells[1] || '').replace(/\s/g, '');
  if (!fno) return null;
  const gateRaw = cells[2] || '';
  const gateMatch = gateRaw.match(/T([^-\s]+)\s*-\s*(\S+)/);
  const terminal = gateMatch ? gateMatch[1] : '';
  const gate = gateMatch ? gateMatch[2] : gateRaw;
  return {
    airport: 'LAX', fno,
    direction: type === 'arr' ? 'A' : 'D',
    gate, terminal: terminal ? 'T' + terminal : '',
    carousel: '',
    scheduled: cells[4] || '', estimated: '', actual: '',
    status: (cells[5] || '').replace(/<[^>]+>/g, '').trim(),
    origin: type === 'arr' ? (cells[3] || '') : 'LAX',
    dest: type === 'arr' ? 'LAX' : (cells[3] || '')
  };
}

async function fetchLAX(): Promise<any[]> {
  const results: any[] = [];
  let hasTest = false;
  for (const type of ['arr', 'dep']) {
    const r = await fetch(
      `https://www.flylax.com/flight-search-list?type=${type}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) continue;
    const html = await r.text();
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    let foundJX = false;
    let firstParsed: any = null;
    for (const row of rows) {
      const parsed = _laxParseRow(row, type);
      if (!parsed) continue;
      if (!firstParsed) firstParsed = parsed;
      const isJX = /data-airlinecode="JX"/i.test(row) ||
                   /fn=JX\d/i.test(row) ||
                   /STARLUX/i.test(row);
      if (isJX) {
        results.push(parsed);
        foundJX = true;
      }
    }
    if (!foundJX && firstParsed && !hasTest) {
      firstParsed._test = true;
      results.push(firstParsed);
      hasTest = true;
    }
  }
  // Also try baggage claim page for carousel info
  try {
    const r = await fetch('https://www.flylax.com/lax-baggage-claim',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) {
      const html = await r.text();
      const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      for (const row of rows) {
        if (!/STARLUX/i.test(row) && !/\bJX\b/i.test(row)) continue;
        const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
          .map((c: string) => c.replace(/<[^>]+>/g, '').trim());
        if (cells.length < 4) continue;
        const fnRaw = cells[1] || '';
        const fnMatch2 = fnRaw.match(/(JX\d+)/i);
        if (!fnMatch2) continue;
        const fno2 = fnMatch2[1].toUpperCase();
        const existing = results.find((f: any) => f.fno === fno2 && f.direction === 'A');
        if (existing) {
          existing.carousel = cells[3] || existing.carousel;
          if (!existing.terminal && cells[2]) existing.terminal = cells[2];
        } else {
          results.push({
            airport: 'LAX', fno: fno2, direction: 'A',
            gate: '', terminal: cells[2] || '', carousel: cells[3] || '',
            scheduled: '', estimated: '', actual: '', status: '',
            origin: '', dest: 'LAX'
          });
        }
      }
    }
  } catch {}
  return results;
}

function _ontMap(f: any, dir: string): any {
  return {
    airport: 'ONT',
    fno: (f.flightno || '').replace(/\s/g, '').toUpperCase(),
    direction: dir === 'arrivals' ? 'A' : 'D',
    gate: f.gate || '',
    terminal: f.terminal || '',
    carousel: '',
    scheduled: f.schedule_time || '',
    estimated: '',
    actual: '',
    status: f.status || '',
    origin: dir === 'arrivals' ? (f.origin || '') : 'ONT',
    dest: dir === 'arrivals' ? 'ONT' : (f.origin || '')
  };
}

// Stealth puppeteer for Cloudflare-protected sites
const _stealthBrowser = (() => {
  puppeteerExtra.use(StealthPlugin());
  return puppeteerExtra;
})();

async function _ontScrape(): Promise<{ arrivals: any[]; departures: any[] }> {
  const pageUrl = Buffer.from('aHR0cHM6Ly93d3cuZmx5b250YXJpby5jb20vZmxpZ2h0cw==', 'base64').toString();
  let browser: any;
  try {
    const execPath = pwChromium.executablePath();
    console.log('[ONT] Launching stealth browser, chrome:', execPath);
    browser = await _stealthBrowser.launch({
      headless: true,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-gpu', '--single-process']
    });
    console.log('[ONT] Browser launched OK');
  } catch (launchErr: any) {
    console.error('[ONT] Browser launch FAILED:', launchErr.message || launchErr);
    throw new Error('Browser launch failed: ' + (launchErr.message || String(launchErr)));
  }
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Intercept the page's own API calls to get clean JSON
    const captured: { arrivals: any[]; departures: any[] } = { arrivals: [], departures: [] };
    page.on('response', async (resp: any) => {
      const url: string = resp.url();
      try {
        if (url.includes('/flights/arrivals')) {
          const json = await resp.json();
          captured.arrivals = json.data || json || [];
          console.log('[ONT] Captured arrivals:', captured.arrivals.length, 'flights');
        } else if (url.includes('/flights/departures')) {
          const json = await resp.json();
          captured.departures = json.data || json || [];
          console.log('[ONT] Captured departures:', captured.departures.length, 'flights');
        }
      } catch { /* non-JSON response, skip */ }
    });

    console.log('[ONT] Navigating to page...');
    await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    console.log('[ONT] Page loaded, current URL:', page.url());

    // Wait for table rows to confirm data loaded
    await page.waitForSelector('.flights__table table tbody tr', { timeout: 30000 })
      .catch(() => { console.log('[ONT] No table rows found (timeout)'); });

    console.log('[ONT] Result: arrivals=' + captured.arrivals.length + ' departures=' + captured.departures.length);
    return captured;
  } finally {
    await browser.close();
    console.log('[ONT] Browser closed');
  }
}

async function fetchONT(): Promise<any[]> {
  const results: any[] = [];
  try {
    const { arrivals, departures } = await _ontScrape();
    let hasTest = false;
    for (const [dir, flights] of [['arrivals', arrivals], ['departures', departures]] as const) {
      let foundJX = false;
      let firstFlight: any = null;
      for (const f of flights) {
        if (!firstFlight && f.flightno) firstFlight = f;
        const airline = (f.airline_name || '').toUpperCase();
        const fno = (f.flightno || '').replace(/\s/g, '').toUpperCase();
        if (fno.startsWith('JX') || /STARLUX/i.test(airline)) {
          results.push(_ontMap(f, dir));
          foundJX = true;
        }
      }
      if (!foundJX && firstFlight && !hasTest) {
        const s = _ontMap(firstFlight, dir);
        s._test = true;
        results.push(s);
        hasTest = true;
      }
    }
  } catch (e: any) {
    const msg = 'ONT: ' + (e.message || String(e));
    console.error(msg);
    results.push({ _ontErr: msg });
  }
  return results;
}

app.get('/api/fids-us', async (_req, res) => {
  try {
    let ontErr = '';
    const [sfo, phx, sea, lax, ont] = await Promise.all([
      fetchSFO().catch(() => []),
      fetchPHX().catch(() => []),
      fetchSEA().catch(() => []),
      fetchLAX().catch(() => []),
      fetchONT().catch((e: any) => { ontErr = e.message || String(e); return []; })
    ]);
    res.json({ sfo, phx, sea, lax, ont, _ontErr: ontErr || undefined });
  } catch (e: any) {
    console.error('FIDS-US proxy error:', e.message);
    res.status(502).json({ error: e.message });
  }
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
