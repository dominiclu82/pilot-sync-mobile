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
import { getSpaPaJs } from './spa/js-pa.js';
import { getSpaAirportDataJs } from './spa/js-airport-data.js';
import { getSpaCalendarJs } from './spa/js-calendar-wrap.js';
import { getSpaLiveRadarJs } from './spa/js-live-radar.js';
import { getSpaFr24RadarJs } from './spa/js-fr24-radar.js';
import { getSpaBriefingCardJs } from './spa/js-briefing-card.js';
import { getSpaCrewRestJs } from './spa/js-crew-rest.js';
import { getSpaSubtabReorderJs } from './spa/js-subtab-reorder.js';
import FR24Pkg from 'flightradarapi';


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
  res.setHeader('Cache-Control', 'no-store');
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
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => {
      caches.open(CACHE).then(c => c.put(e.request, r.clone()));
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
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

// ── OpenSky Network proxy (OAuth2) ────────────────────────────────────────────
let _oskyCache: { ts: number; data: any; remaining: number | null } = { ts: 0, data: null, remaining: null };
let _oskyToken: { token: string; expires: number } = { token: '', expires: 0 };

async function _oskyGetToken(): Promise<string> {
  const now = Date.now();
  if (_oskyToken.token && now < _oskyToken.expires - 60000) return _oskyToken.token;
  const cid = process.env.OPENSKY_CLIENT_ID;
  const csec = process.env.OPENSKY_CLIENT_SECRET;
  if (!cid || !csec) return '';
  try {
    const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(csec)}`
    });
    if (!r.ok) { console.error('OpenSky token error:', r.status); return ''; }
    const d = await r.json();
    _oskyToken = { token: d.access_token, expires: now + (d.expires_in || 1800) * 1000 };
    return _oskyToken.token;
  } catch (e: any) { console.error('OpenSky token fetch error:', e.message); return ''; }
}

app.get('/api/opensky', async (req, res) => {
  try {
    const now = Date.now();
    // server-side 8s cache (slightly less than 10s refresh interval)
    if (_oskyCache.data && now - _oskyCache.ts < 8000) {
      res.json({ ..._oskyCache.data, _remaining: _oskyCache.remaining });
      return;
    }
    let url = 'https://opensky-network.org/api/states/all';
    const { lamin, lomin, lamax, lomax } = req.query;
    const params: string[] = [];
    if (lamin) params.push(`lamin=${lamin}`);
    if (lomin) params.push(`lomin=${lomin}`);
    if (lamax) params.push(`lamax=${lamax}`);
    if (lomax) params.push(`lomax=${lomax}`);
    if (params.length) url += '?' + params.join('&');
    const headers: Record<string, string> = { 'User-Agent': 'CrewSync/1.0' };
    const token = await _oskyGetToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(url, { headers });
    const remaining = r.headers.get('x-rate-limit-remaining');
    const remainNum = remaining != null ? parseInt(remaining, 10) : null;
    if (!r.ok) {
      if (r.status === 429) {
        const retryAfter = r.headers.get('x-rate-limit-retry-after-seconds');
        res.status(429).json({ error: 'rate_limit', retryAfter: retryAfter ? parseInt(retryAfter, 10) : null, _remaining: 0 });
        return;
      }
      res.status(502).json({ error: `OpenSky returned ${r.status}` });
      return;
    }
    const data = await r.json();
    _oskyCache = { ts: now, data, remaining: remainNum };
    res.json({ ...data, _remaining: remainNum });
  } catch (e: any) {
    console.error('OpenSky proxy error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── FR24 proxy ───────────────────────────────────────────────────────────────
const _fr24Api = new FR24Pkg.FlightRadar24API();
let _fr24Cache: { ts: number; bounds: string; data: any } = { ts: 0, bounds: '', data: null };

app.get('/api/fr24', async (req, res) => {
  try {
    const now = Date.now();
    // bounds format: "latN,latS,lonW,lonE"
    const b = req.query.bounds as string || '';
    if (_fr24Cache.data && now - _fr24Cache.ts < 8000 && _fr24Cache.bounds === b) {
      res.json(_fr24Cache.data);
      return;
    }
    const flights = await _fr24Api.getFlights(null, b || null);
    const result = flights.map((f: any) => ({
      id: f.id || '',
      cs: (f.callsign || '').trim(),
      lat: f.latitude,
      lon: f.longitude,
      alt: f.altitude,
      hdg: f.heading,
      spd: f.groundSpeed,
      vs: f.verticalSpeed,
      sq: f.squawk || '',
      icao24: f.icao24bit || '',
      reg: f.registration || '',
      type: f.aircraftCode || '',
      from: f.originAirportIata || '',
      to: f.destinationAirportIata || '',
      num: f.number || '',
      gnd: f.onGround ? 1 : 0
    }));
    const data = { flights: result, time: Math.floor(now / 1000) };
    _fr24Cache = { ts: now, bounds: b, data };
    res.json(data);
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('Cloudflare') || msg.includes('unexpected')) {
      res.status(429).json({ error: 'rate_limit' });
    } else {
      console.error('FR24 proxy error:', msg);
      res.status(502).json({ error: msg });
    }
  }
});

app.get('/api/fr24/detail', async (req, res) => {
  try {
    const flightId = req.query.id as string;
    if (!flightId) { res.status(400).json({ error: 'missing id' }); return; }
    const details = await _fr24Api.getFlightDetails({ id: flightId } as any);
    res.json(details || {});
  } catch (e: any) {
    console.error('FR24 detail error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── FR24 detail background cache (gate info) ────────────────────────────────
const _fr24DetailCache: { flights: Record<string, any>; updatedAt: number } = { flights: {}, updatedAt: 0 };
let _fr24DetailRefreshing = false;

const _fr24AirlineConf: Record<string, { icao: string; iata: string }> = {
  JX: { icao: 'SJX', iata: 'JX' },
  BR: { icao: 'EVA', iata: 'BR' },
  CI: { icao: 'CAL', iata: 'CI' }
};

async function _fr24RefreshDetails(): Promise<void> {
  if (_fr24DetailRefreshing) return;
  _fr24DetailRefreshing = true;
  console.log('[FR24-Detail] Starting refresh...');
  try {
    // Get all flights (no bounds = worldwide)
    const flights = await _fr24Api.getFlights(null, null);
    // Filter JX/BR/CI flights
    const targets: { id: string; cs: string; num: string; from: string; to: string }[] = [];
    for (const f of flights) {
      const cs = ((f as any).callsign || '').trim();
      const num = (f as any).number || '';
      const id = (f as any).id || '';
      if (!id || !cs) continue;
      for (const al of Object.keys(_fr24AirlineConf)) {
        const conf = _fr24AirlineConf[al];
        if (cs.startsWith(conf.icao)) {
          targets.push({ id, cs, num, from: (f as any).originAirportIata || '', to: (f as any).destinationAirportIata || '' });
          break;
        }
      }
    }
    console.log('[FR24-Detail] Found', targets.length, 'flights:', targets.map(t => t.num || t.cs).join(', '));

    const newFlights: Record<string, any> = {};
    for (const t of targets) {
      try {
        const detail = await _fr24Api.getFlightDetails({ id: t.id } as any);
        if (!detail) continue;
        const airport = (detail as any).airport || {};
        const orig = airport.origin || {};
        const dest = airport.destination || {};
        const origInfo = orig.info || {};
        const destInfo = dest.info || {};
        const origCode = orig.code || {};
        const destCode = dest.code || {};
        // Convert callsign (SJX012) to IATA fno (JX12)
        let fno = t.num || t.cs;
        for (const al of Object.keys(_fr24AirlineConf)) {
          const conf = _fr24AirlineConf[al];
          if (fno.startsWith(conf.icao)) {
            fno = fno.replace(new RegExp('^' + conf.icao + '0*'), conf.iata);
            break;
          }
        }
        // Remove leading zeros from number part: JX012 → JX12
        fno = fno.replace(/^([A-Z]{2})0+(\d)/, '$1$2');
        const timeInfo = (detail as any).time || {};
        const sched = timeInfo.scheduled || {};
        const real = timeInfo.real || {};
        newFlights[fno] = {
          fno,
          origin: { iata: origCode.iata || t.from || '', gate: origInfo.gate || '', terminal: origInfo.terminal || '' },
          destination: { iata: destCode.iata || t.to || '', gate: destInfo.gate || '', terminal: destInfo.terminal || '' },
          scheduledDep: sched.departure ? new Date(sched.departure * 1000).toISOString() : '',
          actualDep: real.departure ? new Date(real.departure * 1000).toISOString() : '',
          scheduledArr: sched.arrival ? new Date(sched.arrival * 1000).toISOString() : '',
          actualArr: real.arrival ? new Date(real.arrival * 1000).toISOString() : '',
          status: ''
        };
      } catch (e: any) {
        console.error('[FR24-Detail] Error fetching', t.num || t.cs, ':', e.message);
      }
      await new Promise(ok => setTimeout(ok, 300));
    }

    _fr24DetailCache.flights = newFlights;
    _fr24DetailCache.updatedAt = Date.now();
    console.log('[FR24-Detail] Cache updated:', Object.keys(newFlights).length, 'flights');
  } catch (e: any) {
    console.error('[FR24-Detail] Refresh error:', e.message);
  } finally {
    _fr24DetailRefreshing = false;
  }
}

// Background refresh: immediately + every 5 minutes
setTimeout(() => _fr24RefreshDetails(), 8000);
setInterval(() => _fr24RefreshDetails(), 5 * 60 * 1000);

app.get('/api/fids-fr24', (_req, res) => {
  if (!_fr24DetailCache.updatedAt) {
    _fr24RefreshDetails();
    return res.json({ flights: {}, updatedAt: null, count: 0, refreshing: true });
  }
  res.json({
    flights: _fr24DetailCache.flights,
    updatedAt: new Date(_fr24DetailCache.updatedAt).toISOString(),
    count: Object.keys(_fr24DetailCache.flights).length
  });
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

const _faAirlineConf: Record<string, { icao: string; iata: string }> = {
  JX: { icao: 'SJX', iata: 'JX' },
  BR: { icao: 'EVA', iata: 'BR' },
  CI: { icao: 'CAL', iata: 'CI' }
};
const _faCaches: Record<string, FaCacheEntry> = {};
const _faRefreshing: Record<string, boolean> = {};

function _parseFaPage(html: string, icaoPrefix: string, iataPrefix: string): FaFlightData[] {
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
      const fno = displayIdent.replace(new RegExp('^' + icaoPrefix), iataPrefix);
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

async function _faFetchFlight(icaoIdent: string, icaoPrefix: string, iataPrefix: string): Promise<FaFlightData[]> {
  try {
    const r = await fetch(_faBase + icaoIdent, { headers: _faHeaders });
    if (!r.ok) return [];
    const html = await r.text();
    return _parseFaPage(html, icaoPrefix, iataPrefix);
  } catch { return []; }
}

async function _faRefreshAirline(airline: string): Promise<void> {
  const conf = _faAirlineConf[airline];
  if (!conf) return;
  if (_faRefreshing[airline]) return;
  _faRefreshing[airline] = true;
  console.log('[FA] Starting refresh for', airline, '...');
  try {
    // Get fleet page for active flights
    const fleetBase = Buffer.from('aHR0cHM6Ly93d3cuZmxpZ2h0YXdhcmUuY29tL2xpdmUvZmxlZXQv', 'base64').toString();
    const fleetUrl = fleetBase + conf.icao;
    const r = await fetch(fleetUrl, { headers: _faHeaders });
    if (!r.ok) { console.error('[FA]', airline, 'fleet page error:', r.status); return; }
    const html = await r.text();

    // Extract flight idents from fleet page
    const identSet = new Set<string>();
    const identRe = new RegExp(conf.icao + '\\d+', 'g');
    const identMatches = html.matchAll(identRe);
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
          if (f.ACode?.trim() === airline) {
            const num = (f.FlightNo || '').replace(/\s/g, '');
            if (num) identSet.add(conf.icao + num);
          }
        }
      }
    } catch {}

    console.log('[FA]', airline, 'found', identSet.size, 'flights:', [...identSet].join(', '));

    // Today's date range (Taiwan time, with 6h buffer on each side)
    const now = Date.now();
    const tw = new Date(now + 8 * 60 * 60 * 1000);
    const todayStart = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
    const rangeStart = todayStart.getTime() - 6 * 60 * 60 * 1000;
    const rangeEnd = todayStart.getTime() + 30 * 60 * 60 * 1000;

    // Fetch each flight page (with delay to avoid rate limiting)
    const newFlights: Record<string, FaFlightData> = {};
    for (const ident of identSet) {
      const entries = await _faFetchFlight(ident, conf.icao, conf.iata);
      for (const entry of entries) {
        const key = entry.fno;
        if (!key) continue;
        const depTime = entry.scheduledDep ? new Date(entry.scheduledDep).getTime() : 0;
        const arrTime = entry.scheduledArr ? new Date(entry.scheduledArr).getTime() : 0;
        const refTime = depTime || arrTime;
        if (refTime && (refTime < rangeStart || refTime > rangeEnd)) continue;
        if (!newFlights[key] || entry.origin.gate || entry.destination.gate) {
          newFlights[key] = entry;
        }
      }
      await new Promise(ok => setTimeout(ok, 500));
    }

    _faCaches[airline] = { flights: newFlights, updatedAt: Date.now() };
    console.log('[FA]', airline, 'cache updated:', Object.keys(newFlights).length, 'flights');
  } catch (e: any) {
    console.error('[FA]', airline, 'refresh error:', e.message);
  } finally {
    _faRefreshing[airline] = false;
  }
}

// Background refresh: JX only, immediately + every 5 minutes
setTimeout(() => _faRefreshAirline('JX'), 5000);
setInterval(() => _faRefreshAirline('JX'), 5 * 60 * 1000);

app.get('/api/fids-fa', (req, res) => {
  const airline = (typeof req.query.airline === 'string' ? req.query.airline : 'JX').toUpperCase();
  if (!_faAirlineConf[airline]) {
    return res.json({ flights: {}, updatedAt: null, count: 0 });
  }
  const cache = _faCaches[airline];
  if (!cache || !cache.updatedAt) {
    _faRefreshAirline(airline);
    return res.json({ flights: {}, updatedAt: null, count: 0, refreshing: true });
  }
  // BR/CI: trigger background refresh if cache > 10 minutes old
  if (airline !== 'JX' && Date.now() - cache.updatedAt > 10 * 60 * 1000) {
    _faRefreshAirline(airline);
  }
  res.json({
    flights: cache.flights,
    updatedAt: cache.updatedAt ? new Date(cache.updatedAt).toISOString() : null,
    count: Object.keys(cache.flights).length
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

app.get('/api/calendar-events', async (req, res) => {
  try {
    const { refreshToken, start, end } = req.query as Record<string, string>;
    if (!refreshToken || !start || !end) {
      res.status(400).json({ error: 'Missing refreshToken, start, or end' });
      return;
    }
    const creds = loadCredentials();
    const oauth2 = new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret);
    oauth2.setCredentials({ refresh_token: refreshToken });

    const calendar = google.calendar({ version: 'v3', auth: oauth2 });
    const calInfo = await calendar.calendarList.get({ calendarId: 'primary' });
    const defaultReminderMins = ((calInfo.data.defaultReminders || []) as Array<{method?: string; minutes?: number}>)
      .map((r: {minutes?: number}) => r.minutes ?? 0).sort((a: number, b: number) => a - b);

    const resp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const events = (resp.data.items || []).map(ev => ({
      id: ev.id,
      title: ev.summary || '(No title)',
      start: ev.start?.dateTime || ev.start?.date || '',
      end: ev.end?.dateTime || ev.end?.date || '',
      allDay: !ev.start?.dateTime,
      color: ev.colorId || null,
      location: ev.location || '',
      description: ev.description || '',
      reminders: ev.reminders?.useDefault
        ? defaultReminderMins
        : (ev.reminders?.overrides || []).map(r => r.minutes ?? 0).sort((a, b) => a - b),
    }));

    const withLoc = events.filter(e => e.location);
    if (withLoc.length) console.log('[Calendar] Events with location:', withLoc.map(e => e.title + ' @ ' + e.location));
    res.json({ events });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css"/>
<title>CrewSync</title>
<style>
${getSpaStyles()}
</style>
</head>
<body>
${getSpaHtmlBody()}
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>
<script>
${getSpaCoreJs()}
${getSpaAirportDataJs()}
${getSpaWeatherJs()}
${getSpaDutyTimeJs()}
${getSpaGateInfoJs()}
${getSpaPaJs()}
${getSpaCalendarJs()}
${getSpaLiveRadarJs()}
${getSpaFr24RadarJs()}
${getSpaBriefingCardJs()}
${getSpaCrewRestJs()}
${getSpaSubtabReorderJs()}
</script>
</body>
</html>`;
}
