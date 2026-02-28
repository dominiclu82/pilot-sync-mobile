// ── Duty Time Calculator ──────────────────────────────────────────────────────
var DT_MAX_FDP = {2:14*60, 3:18*60, 4:24*60};
var DT_MAX_FT  = {2:{noC1:10*60,c1:10*60}, 3:{noC1:12*60,c1:16*60}, 4:{noC1:12*60,c1:18*60}};
var dtMode = 'home';

function dtGetTzOffset(tzId) {
  var now = new Date();
  var yr  = now.getUTCFullYear();
  function nthSun(y, mo, n) { // mo: 0-indexed
    var d = new Date(Date.UTC(y, mo, 1));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCDate(d.getUTCDate() + (n-1)*7); return d;
  }
  function lastSun(y, mo) {
    var d = new Date(Date.UTC(y, mo+1, 0));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() - 1); return d;
  }
  if (tzId === 'la')     { var sLA=nthSun(yr,2,2),eLA=nthSun(yr,10,1); return (now>=sLA&&now<eLA)?-7:-8; }
  if (tzId === 'prague') { var sPr=lastSun(yr,2),ePr=lastSun(yr,9);   return (now>=sPr&&now<ePr)?2:1;   }
  var fixed = {taipei:8,tokyo:9,bangkok:7,phoenix:-7};
  return fixed[tzId] !== undefined ? fixed[tzId] : 8;
}

function dtFmtH(m) { // "HH:MM" for timeline labels
  var h=Math.floor(m/60), mm=m%60;
  return h+':'+(mm<10?'0':'')+mm;
}

function dtRenderTimeline(startMin, endMin, maxFdp, restStart, restEnd, minRest, tz) {
  try {
  var actFdp = endMin - startMin;
  var spanEnd = restEnd !== null
    ? Math.max(startMin + maxFdp, restEnd) + 60
    : startMin + maxFdp + minRest + 60;
  var span = spanEnd - startMin;

  function pct(offset) { return (Math.max(0, offset) / span * 100).toFixed(2); }
  function setBar(barId, offset, dur) {
    var el = document.getElementById(barId);
    el.style.left  = pct(offset) + '%';
    el.style.width = (Math.max(0.1, Math.min(dur, span - Math.max(0, offset))) / span * 100).toFixed(2) + '%';
  }

  // Bars
  setBar('dt-bar-fdp', 0, actFdp);
  document.getElementById('dt-lbl-fdp').textContent = 'Actual FDP ' + dtFmtH(actFdp);
  setBar('dt-bar-maxfdp', 0, maxFdp);
  document.getElementById('dt-lbl-maxfdp').textContent = 'Max ' + dtFmtH(maxFdp);
  setBar('dt-bar-minrest', actFdp, minRest);
  document.getElementById('dt-lbl-minrest').textContent = 'Min Req ' + dtFmtH(minRest);

  if (restEnd !== null) {
    var restEl = document.getElementById('dt-bar-rest');
    restEl.style.display = 'flex';
    setBar('dt-bar-rest', restStart - startMin, restEnd - restStart);
    document.getElementById('dt-lbl-rest').textContent = 'Rest ' + dtFmtH(restEnd - restStart);
  } else {
    document.getElementById('dt-bar-rest').style.display = 'none';
  }

  // WOCL overlay (02:00-05:00 local time)
  var woclSUTC = ((2*60 - tz*60) % 1440 + 1440) % 1440;
  var woclEUTC = ((5*60 - tz*60) % 1440 + 1440) % 1440;
  var woclEl = document.getElementById('dt-bar-wocl');
  // Map WOCL to timeline-relative minutes
  var sDay = Math.floor(startMin / 1440) * 1440;
  var wS = sDay + woclSUTC;
  // If WOCL start is before FDP start, try next day
  if (wS + (woclSUTC < woclEUTC ? (woclEUTC - woclSUTC) : (1440 - woclSUTC + woclEUTC)) <= startMin) wS += 1440;
  var wDur = woclSUTC < woclEUTC ? (woclEUTC - woclSUTC) : (1440 - woclSUTC + woclEUTC);
  var wOff = wS - startMin;
  // Show if WOCL overlaps the visible span
  if (wOff < span && wOff + wDur > 0) {
    woclEl.style.display = '';
    woclEl.style.left = pct(Math.max(0, wOff)) + '%';
    var visW = Math.min(wDur, span - Math.max(0, wOff));
    if (wOff < 0) visW = Math.min(wDur + wOff, span);
    woclEl.style.width = (Math.max(0, visW) / span * 100).toFixed(2) + '%';
  } else {
    woclEl.style.display = 'none';
  }

  // Vertical lines
  function setVline(id, offset, show) {
    var el = document.getElementById(id);
    if (show) { el.style.display = ''; el.style.left = pct(offset) + '%'; }
    else el.style.display = 'none';
  }
  setVline('dt-vline-start', 0, true);
  setVline('dt-vline-end', actFdp, true);
  setVline('dt-vline-next', restEnd !== null ? restEnd - startMin : 0, restEnd !== null);

  // Tick labels
  function fmtUTC(m) {
    var t=((m%1440)+1440)%1440, h=Math.floor(t/60), mm=t%60;
    return (h<10?'0':'')+h+':'+(mm<10?'0':'')+mm+'Z';
  }
  function makeTick(leftPct, line1, line2, align) {
    var tx = align === 'left' ? 'translateX(0)' : align === 'right' ? 'translateX(-100%)' : 'translateX(-50%)';
    var ta = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
    return '<div style="position:absolute;left:' + leftPct + '%;transform:' + tx + ';text-align:' + ta + ';font-size:.58em;color:var(--dim);line-height:1.35;white-space:nowrap">' + line1 + '<br>' + line2 + '</div>';
  }
  var ticks = document.getElementById('dt-tl2-ticks');
  var html = makeTick(pct(0), 'FDP Start', fmtUTC(startMin), 'left');
  html += makeTick(pct(actFdp), 'Rst Start (FDP End)', fmtUTC(endMin));
  if (restEnd !== null) html += makeTick(pct(restEnd - startMin), 'Next Rpt', fmtUTC(restEnd));
  ticks.innerHTML = html;

  } catch(e) { alert('Timeline Error: ' + e.message); }
}

function dtMinRest(crew, ftMin) {
  var ft = ftMin / 60;
  if (crew === 2) return ft <= 8 ? 10*60 : 18*60;
  if (crew === 3) return ft <= 8 ? 10*60 : ft <= 12 ? 18*60 : 24*60;
  return ft <= 8 ? 10*60 : ft <= 16 ? 18*60 : 22*60;
}

function dtToggleRef() {
  var p = document.getElementById('dt-ref-panel');
  var a = document.getElementById('dt-ref-arrow');
  var open = p.style.display !== 'none';
  p.style.display = open ? 'none' : 'block';
  a.textContent   = open ? '▼' : '▲';
}

function dtFmtHM(m) {
  if (m < 0) m = 0;
  var h = Math.floor(m/60); var mm = m%60;
  return h + 'h ' + (mm<10?'0':'') + mm + 'm';
}

function dtFmtUTC(m) {
  var t = ((m%1440)+1440)%1440;
  var h = Math.floor(t/60); var mm = t%60;
  return (h<10?'0':'') + h + ':' + (mm<10?'0':'') + mm + 'Z';
}

function dtDayMin(dayId, hId, mId) {
  var d = parseInt(document.getElementById(dayId).value);
  var h = parseInt(document.getElementById(hId).value);
  var m = parseInt(document.getElementById(mId).value);
  if (isNaN(h) || isNaN(m)) return null;
  var base = isNaN(d) ? 0 : d * 1440;
  return base + h*60 + m;
}

function dtSelectCrew(btn) {
  document.querySelectorAll('.dt-crew-btn').forEach(function(b){b.classList.remove('active');});
  btn.classList.add('active');
  var crew = parseInt(btn.dataset.crew);
  document.getElementById('dt-c1-row').style.display   = crew >= 3 ? 'flex' : 'none';
  document.getElementById('dt-disc-row').style.display = crew === 3 ? 'flex' : 'none';
  if (crew !== 3) document.getElementById('dt-disc').checked = false;
  if (crew < 3)   document.getElementById('dt-c1').checked  = false;
}

function dtSetMode(mode) {
  dtMode = mode;
  document.getElementById('dt-mode-home').classList.toggle('active', mode==='home');
  document.getElementById('dt-mode-out').classList.toggle('active',  mode==='out');
  document.getElementById('dt-next-section').style.display  = mode==='home' ? 'block' : 'none';
  document.getElementById('dt-hotel-section').style.display = mode==='out'  ? 'block' : 'none';
}

function dtCardState(cardId, ok) {
  var el = document.getElementById(cardId);
  el.classList.remove('ok','warn','err');
  if (ok === true) el.classList.add('ok');
  else if (ok === false) el.classList.add('err');
}

function dtWoclCheck(startMin, endMin, tzOffset) {
  // WOCL = 02:00–05:00 local = (02:00 - tzOffset) UTC
  var woclStart = (2*60 - tzOffset*60 + 1440*3) % 1440;
  var woclEnd   = (5*60 - tzOffset*60 + 1440*3) % 1440;
  // Check if FDP window overlaps WOCL (simple daily check)
  var s = startMin % 1440, e = endMin % 1440;
  function overlaps(a1,a2,b1,b2) {
    if (b1 < b2) return a1 < b2 && a2 > b1;
    return a1 < b2 || a2 > b1; // wraps midnight
  }
  if (woclStart < woclEnd) return overlaps(s, e, woclStart, woclEnd);
  return s < woclEnd || e > woclStart;
}

function dtCalculate() {
  var crew  = parseInt(document.querySelector('.dt-crew-btn.active').dataset.crew);
  var hasC1 = document.getElementById('dt-c1').checked;
  var disc  = crew===3 && document.getElementById('dt-disc').checked;
  var tz    = dtGetTzOffset(document.getElementById('dt-tz').value);

  var startMin = dtDayMin('dt-s-day','dt-s-h','dt-s-m');
  var endMin   = dtDayMin('dt-e-day','dt-e-h','dt-e-m');
  var ftMin    = (parseInt(document.getElementById('dt-ft-h').value)||0)*60 +
                 (parseInt(document.getElementById('dt-ft-m').value)||0);

  if (startMin === null) {
    alert('請輸入 FDP Start 時間');
    return;
  }

  var maxFdp = DT_MAX_FDP[crew] + (disc ? 2*60 : 0);
  var maxFt  = hasC1 ? DT_MAX_FT[crew].c1 : DT_MAX_FT[crew].noC1;

  // ── Deadline cards (always shown) ──────────────────────────────────────────
  var maxFdpDeadline = startMin + maxFdp;
  var maxFtDeadline  = startMin + maxFt;
  document.getElementById('dt-r-maxfdp-time').textContent = dtFmtUTC(maxFdpDeadline);
  document.getElementById('dt-r-maxfdp-dur').textContent  = dtFmtHM(maxFdp) + (disc ? ' (incl. disc.)' : '');
  document.getElementById('dt-r-maxft-time').textContent  = dtFmtUTC(maxFtDeadline);
  document.getElementById('dt-r-maxft-dur').textContent   = dtFmtHM(maxFt) + (hasC1 ? ' (C1)' : '');

  // ── Ext note ───────────────────────────────────────────────────────────────
  var extNote = document.getElementById('dt-ext-note');
  if (disc) { extNote.textContent = '🟣 PIC Discretion applied: +2h to Max FDP'; extNote.style.display='block'; }
  else extNote.style.display = 'none';

  // Show results
  document.getElementById('dt-results-area').style.display = 'block';
  document.getElementById('dt-placeholder').style.display  = 'none';

  // ── If FDP End not provided, hide compliance cards and timeline ────────────
  if (endMin === null) {
    document.getElementById('dt-card-fdp').style.display  = 'none';
    document.getElementById('dt-card-ft').style.display   = 'none';
    document.getElementById('dt-card-rest').style.display = 'none';
    document.getElementById('dt-wocl-box').style.display  = 'none';
    document.querySelector('.dt-tl2').style.display        = 'none';
    return;
  }

  // If end < start (crossed midnight), add 1 day
  if (endMin <= startMin) endMin += 1440;

  var actFdp  = endMin - startMin;
  var minRest = dtMinRest(crew, ftMin);

  // Show compliance cards and timeline
  document.querySelector('.dt-tl2').style.display = '';

  // Rest calculation
  var restStart = null, restEnd = null, actRest = null;
  if (dtMode === 'home') {
    var nxtMin = dtDayMin('dt-n-day','dt-n-h','dt-n-m');
    if (nxtMin !== null) {
      restStart = endMin; restEnd = nxtMin;
      if (restEnd <= restStart) restEnd += 1440;
      actRest = restEnd - restStart;
    }
  } else {
    var ciMin = dtDayMin('dt-ci-day','dt-ci-h','dt-ci-m');
    var coMin = dtDayMin('dt-co-day','dt-co-h','dt-co-m');
    if (ciMin !== null && coMin !== null) {
      restStart = ciMin; restEnd = coMin;
      if (restEnd <= restStart) restEnd += 1440;
      actRest = restEnd - restStart;
    }
  }

  // FDP card
  var fdpOk = actFdp <= maxFdp;
  document.getElementById('dt-card-fdp').style.display    = '';
  document.getElementById('dt-r-fdp').textContent         = dtFmtHM(actFdp);
  document.getElementById('dt-r-fdp-max').textContent     = 'Max: ' + dtFmtHM(maxFdp) + (disc ? ' (incl. PIC disc.)' : '');
  dtCardState('dt-card-fdp', fdpOk);

  // FT card
  var ftOk = ftMin === 0 ? null : ftMin <= maxFt;
  document.getElementById('dt-card-ft').style.display    = '';
  document.getElementById('dt-r-ft').textContent         = ftMin > 0 ? dtFmtHM(ftMin) : '—';
  document.getElementById('dt-r-ft-max').textContent     = 'Max: ' + dtFmtHM(maxFt) + (hasC1 ? ' (C1)' : '');
  dtCardState('dt-card-ft', ftOk);

  // Rest card
  document.getElementById('dt-card-rest').style.display = '';
  if (actRest !== null) {
    var restOk = actRest >= minRest;
    document.getElementById('dt-r-rest').textContent     = dtFmtHM(actRest) + (restOk ? ' ✓' : ' ✗');
    document.getElementById('dt-r-rest-min').textContent = 'Min: ' + dtFmtHM(minRest);
    dtCardState('dt-card-rest', restOk);
  } else {
    document.getElementById('dt-r-rest').textContent     = '—';
    document.getElementById('dt-r-rest-min').textContent = 'Min required: ' + dtFmtHM(minRest);
    dtCardState('dt-card-rest', null);
  }

  // WOCL
  var woclHit = dtWoclCheck(startMin, endMin, tz);
  var woclBox = document.getElementById('dt-wocl-box');
  if (woclHit) {
    document.getElementById('dt-wocl-msg').textContent = 'FDP 觸碰 WOCL 時段。連續2天需34h休息，連續3天需54h休息。例外：每次WOCL後有14h休息則免除。';
    woclBox.style.display = 'block';
  } else {
    woclBox.style.display = 'none';
  }

  // CSS percentages recalculate on reflow, no timing hacks needed
  dtRenderTimeline(startMin, endMin, maxFdp, restStart, restEnd, minRest, tz);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
showMain();
// 預設顯示簡報箱 datis 分頁 → 立即載入初始天氣資料
wxLoaded = true; (function(){ var fsel = document.getElementById('wx-fleet-select'); if (fsel) fsel.value = wxCurrentFleet; })(); loadWxRegion(wxCurrentRegion);
// ── Service Worker 註冊 ───────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function(){});
}
