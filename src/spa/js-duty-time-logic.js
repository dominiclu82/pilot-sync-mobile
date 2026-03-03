// ── Duty Time Calculator ──────────────────────────────────────────────────────
var DT_MAX_FDP = {2:14*60, 3:18*60, 4:24*60};
var DT_MAX_FT  = {2:{noC1:10*60,c1:10*60}, 3:{noC1:12*60,c1:16*60}, 4:{noC1:12*60,c1:18*60}};
var dtMode = 'home';
var DT_DATE_IDS = ['dt-s-day','dt-e-day','dt-n-day','dt-ci-day','dt-co-day','dt-dhd-day'];

// ── HH/MM input clamp (capture phase → fires before inline handlers) ──
document.addEventListener('input', function(e) {
  var el = e.target;
  if (!el.classList.contains('dt-time-box')) return;
  var v = el.value.replace(/[^0-9]/g, '').slice(0, 2);
  var id = el.id;
  // Flight Time & Accommodation: no hard clamp
  if (id === 'dt-ft-h' || id === 'dt-ft-m' || id === 'dt-accom-h' || id === 'dt-accom-m') { el.value = v; return; }
  var max = id.match(/-m$/) ? 59 : 23;
  if (v !== '' && parseInt(v, 10) > max) v = String(max);
  if (el.value !== v) el.value = v;
}, true);

// ── Flight Time real-time check ──
function dtCheckFT() {
  var err = document.getElementById('dt-ft-err');
  var hEl = document.getElementById('dt-ft-h');
  var mEl = document.getElementById('dt-ft-m');
  if (!err || !hEl || !mEl) return;
  var h = parseInt(hEl.value) || 0;
  var m = parseInt(mEl.value) || 0;
  var totalMin = h * 60 + m;
  if (totalMin <= 0) {
    hEl.style.color = ''; mEl.style.color = '';
    err.style.display = 'none'; err.textContent = '';
    return;
  }
  var crew = parseInt(document.querySelector('.dt-crew-btn.active').dataset.crew);
  var hasC1 = document.getElementById('dt-c1').checked;
  var maxFT = DT_MAX_FT[crew][hasC1 ? 'c1' : 'noC1'];
  var maxH = Math.floor(maxFT / 60);
  // Check FT vs Max FT
  var warns = [];
  if (totalMin > maxFT) {
    warns.push('\u26a0 Max FT: ' + maxH + 'h (' + crew + 'P' + (hasC1 ? ' + C1' : '') + ')');
  }
  // Check FT vs FDP duration
  var startMin = dtDayMin('dt-s-day','dt-s-h','dt-s-m');
  var endMin = dtDayMin('dt-e-day','dt-e-h','dt-e-m');
  if (startMin !== null && endMin !== null) {
    if (endMin <= startMin) endMin += 1440;
    var actFdp = endMin - startMin;
    if (totalMin > actFdp) {
      warns.push('\u26a0 FT (' + dtFmtHM(totalMin) + ') exceeds FDP (' + dtFmtHM(actFdp) + ')');
    }
  }
  if (warns.length) {
    hEl.style.color = '#ef4444'; mEl.style.color = '#ef4444';
    err.innerHTML = warns.join('<br>');
    err.style.display = 'block';
  } else {
    hEl.style.color = ''; mEl.style.color = '';
    err.style.display = 'none';
    err.textContent = '';
  }
}

function dtInitDates() {
  var now = new Date();
  var yyyy = now.getUTCFullYear();
  var mm = ('0'+(now.getUTCMonth()+1)).slice(-2);
  var dd = ('0'+now.getUTCDate()).slice(-2);
  var today = yyyy+'-'+mm+'-'+dd;
  var label = mm+'/'+dd;
  DT_DATE_IDS.forEach(function(id) {
    var inp = document.getElementById(id);
    var btn = document.getElementById(id+'-btn');
    if (inp) { inp.value = today; }
    if (btn) { btn.textContent = label; }
  });
}

function dtDateChanged(inp) {
  var btn = document.getElementById(inp.id+'-btn');
  if (inp.value) {
    var parts = inp.value.split('-');
    btn.textContent = parts[1]+'/'+parts[2];
  } else {
    btn.textContent = '--/--';
  }
}

function dtToggleAccom() {
  var on = document.getElementById('dt-accom').checked;
  document.getElementById('dt-accom-detail').style.display = on ? 'block' : 'none';
  if (on) dtUpdateAccomHint();
}

function dtToggleDhd() {
  var on = document.getElementById('dt-dhd').checked;
  document.getElementById('dt-dhd-section').style.display = on ? 'block' : 'none';
}

function dtUpdateAccomHint() {
  var h = parseInt(document.getElementById('dt-accom-h').value) || 0;
  var m = parseInt(document.getElementById('dt-accom-m').value) || 0;
  var total = h * 60 + m;
  var type = dtGetAccomType();
  var hint = document.getElementById('dt-accom-hint');
  var err = document.getElementById('dt-accom-err');
  if (!hint) return;
  // 即時驗證 > 3h
  if (err) {
    if (total > 0 && total <= 180) {
      err.textContent = '⚠ Rest Duration must be more than 3 hours to apply Accommodation rules.';
      err.style.display = 'block';
    } else {
      err.style.display = 'none';
      err.textContent = '';
    }
  }
  if (total <= 0) {
    hint.textContent = type === 'notstart'
      ? '* Mode: Deducting rest duration from Actual FDP'
      : '* Mode: Max FDP increased by 50% of rest duration';
    return;
  }
  if (type === 'notstart') {
    hint.textContent = '* Mode: Deducting ' + h + ':' + ('0' + m).slice(-2) + ' from Actual FDP';
  } else {
    var ext = Math.floor(total * 0.5);
    var eh = Math.floor(ext / 60);
    var em = ext % 60;
    hint.textContent = '* Mode: Max FDP increased by ' + eh + ':' + ('0' + em).slice(-2) + ' (50% Rest)';
  }
}

function dtGetAccomType() {
  var radios = document.getElementsByName('dt-accom-type');
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].checked) return radios[i].value;
  }
  return 'notstart';
}

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

function dtRenderTimeline(startMin, endMin, maxFdp, restStart, restEnd, minRest, tz, disc, accomExt, accomType, dhdEndMin) {
  try {
  var actFdp = endMin - startMin;
  var dhdDur = dhdEndMin ? dhdEndMin - endMin : 0;
  // Calculate total extension and base Max FDP
  var totalExt = (disc ? 2*60 : 0) + (accomType === 'start' ? (accomExt || 0) : 0);
  var baseFdp = maxFdp - totalExt;
  var dhdEnd = dhdEndMin || startMin;
  var spanEnd = restEnd !== null
    ? Math.max(startMin + maxFdp, restEnd, dhdEnd) + 60
    : Math.max(startMin + maxFdp, dhdEnd) + minRest + 60;
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
  setBar('dt-bar-maxfdp', 0, baseFdp);
  document.getElementById('dt-lbl-maxfdp').textContent = 'Max ' + dtFmtH(baseFdp);

  // FDP exceed bar + alert
  var fdpOver = document.getElementById('dt-bar-fdp-over');
  var fdpBar = document.getElementById('dt-bar-fdp');
  if (actFdp > maxFdp) {
    fdpBar.classList.add('dt-bar-alert');
    fdpOver.style.display = '';
    fdpOver.classList.add('dt-bar-alert');
    fdpOver.style.left = pct(maxFdp) + '%';
    fdpOver.style.width = (Math.max(0.1, actFdp - maxFdp) / span * 100).toFixed(2) + '%';
  } else {
    fdpBar.classList.remove('dt-bar-alert');
    fdpOver.style.display = 'none';
    fdpOver.classList.remove('dt-bar-alert');
  }

  // Ext bar (PIC Discretion and/or Accommodation Start)
  var extEl = document.getElementById('dt-bar-ext');
  if (totalExt > 0) {
    extEl.style.display = 'flex';
    setBar('dt-bar-ext', baseFdp, totalExt);
    var extParts = [];
    if (disc) extParts.push('PIC +2h');
    if (accomType === 'start' && accomExt > 0) extParts.push('Accom +' + dtFmtH(accomExt));
    document.getElementById('dt-lbl-ext').textContent = extParts.join(' / ');
  } else {
    extEl.style.display = 'none';
  }

  // DHD bar
  var dhdBar = document.getElementById('dt-bar-dhd');
  var dhdLeg = document.getElementById('dt-leg-dhd');
  if (dhdEndMin && dhdDur > 0) {
    dhdBar.style.display = 'flex';
    setBar('dt-bar-dhd', actFdp, dhdDur);
    document.getElementById('dt-lbl-dhd').textContent = 'DHD ' + dtFmtH(dhdDur);
    if (dhdLeg) dhdLeg.style.display = '';
  } else {
    dhdBar.style.display = 'none';
    if (dhdLeg) dhdLeg.style.display = 'none';
  }

  var minRestOffset = dhdEndMin ? (dhdEndMin - startMin) : actFdp;
  setBar('dt-bar-minrest', minRestOffset, minRest);
  document.getElementById('dt-lbl-minrest').textContent = 'Min Req ' + dtFmtH(minRest);

  var restBar = document.getElementById('dt-bar-rest');
  var actRest = 0;
  if (restEnd !== null) {
    actRest = restEnd - restStart;
    restBar.style.display = 'flex';
    setBar('dt-bar-rest', restStart - startMin, actRest);
    document.getElementById('dt-lbl-rest').textContent = 'Rest ' + dtFmtH(actRest);
    if (actRest < minRest) {
      restBar.classList.add('dt-bar-alert');
    } else {
      restBar.classList.remove('dt-bar-alert');
    }
  } else {
    restBar.style.display = 'none';
    restBar.classList.remove('dt-bar-alert');
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
  function makeTick(leftPct, line1, line2, align, topPx) {
    var tx = align === 'left' ? 'translateX(0)' : align === 'right' ? 'translateX(-100%)' : 'translateX(-50%)';
    var ta = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
    var topS = topPx ? 'top:' + topPx + 'px;' : '';
    return '<div style="position:absolute;left:' + leftPct + '%;transform:' + tx + ';text-align:' + ta + ';font-size:.58em;color:var(--dim);line-height:1.35;white-space:nowrap;' + topS + '">' + line1 + '<br>' + line2 + '</div>';
  }
  var ticks = document.getElementById('dt-tl2-ticks');
  var fdpEndPct = parseFloat(pct(actFdp));
  var dhdEndPctVal = dhdEndMin ? parseFloat(pct(dhdEndMin - startMin)) : -999;
  var rstPct = dhdEndMin ? dhdEndPctVal : fdpEndPct;
  var nxtPct = restEnd !== null ? parseFloat(pct(restEnd - startMin)) : -999;
  // Smart alignment: right-align if close to right edge, and stagger if ticks overlap
  var nxtAlign = 'right';
  var nxtTop = 0;
  if (restEnd !== null && Math.abs(nxtPct - rstPct) < 18) nxtTop = 28;
  var html = makeTick(pct(0), 'FDP Start', fmtUTC(startMin), 'left');
  if (dhdEndMin) {
    var feAlign = fdpEndPct > 75 ? 'right' : 'center';
    html += makeTick(pct(actFdp), 'FDP End', fmtUTC(endMin), feAlign);
    var dhdAlign = dhdEndPctVal > 75 ? 'right' : 'center';
    var dhdTop = Math.abs(dhdEndPctVal - fdpEndPct) < 18 ? 28 : 0;
    html += makeTick(pct(dhdEndMin - startMin), 'Rst Start (DHD End)', fmtUTC(dhdEndMin), dhdAlign, dhdTop);
  } else {
    var rstAlign = fdpEndPct > 75 ? 'right' : 'center';
    html += makeTick(pct(actFdp), 'Rst Start (FDP End)', fmtUTC(endMin), rstAlign);
  }
  if (restEnd !== null) html += makeTick(pct(restEnd - startMin), 'Next Rpt', fmtUTC(restEnd), nxtAlign, nxtTop);
  ticks.innerHTML = html;

  // Warning text
  var warnEl = document.getElementById('dt-tl2-warn');
  var warns = [];
  if (actFdp > maxFdp) warns.push('\u26a0 FDP EXCEEDS LIMIT \u2014 Over by ' + dtFmtH(actFdp - maxFdp));
  if (restEnd !== null && actRest < minRest) warns.push('\u26a0 MINIMUM REST NOT MET \u2014 Short by ' + dtFmtH(minRest - actRest));
  if (warns.length) { warnEl.innerHTML = warns.join('<br>'); warnEl.style.display = 'block'; }
  else { warnEl.style.display = 'none'; warnEl.innerHTML = ''; }

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
  if (!open) {
    setTimeout(function() {
      var wrap = p.closest('.dt-wrap');
      if (wrap) {
        var toggle = document.querySelector('.dt-ref-toggle');
        wrap.scrollTo({ top: toggle ? toggle.offsetTop : wrap.scrollHeight, behavior: 'smooth' });
      }
    }, 50);
  }
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
  var dateVal = document.getElementById(dayId).value; // YYYY-MM-DD
  var h = parseInt(document.getElementById(hId).value);
  var m = parseInt(document.getElementById(mId).value);
  if (isNaN(h) || isNaN(m)) return null;
  if (!dateVal) return h*60 + m;
  var parts = dateVal.split('-');
  var dt = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]), h, m));
  return dt.getTime() / 60000; // absolute minutes since epoch
}

function dtSelectCrew(btn) {
  document.querySelectorAll('.dt-crew-btn').forEach(function(b){b.classList.remove('active');});
  btn.classList.add('active');
  var crew = parseInt(btn.dataset.crew);
  document.getElementById('dt-c1-row').style.display   = crew >= 3 ? 'flex' : 'none';
  document.getElementById('dt-disc-row').style.display = crew === 3 ? 'flex' : 'none';
  if (crew !== 3) document.getElementById('dt-disc').checked = false;
  if (crew < 3)   document.getElementById('dt-c1').checked  = false;
  dtCheckFT();
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
  // WOCL = 02:00–05:00 local → convert to UTC
  var wS = ((2*60 - tzOffset*60) % 1440 + 1440) % 1440;
  var wE = ((5*60 - tzOffset*60) % 1440 + 1440) % 1440;
  var wDur = wS < wE ? (wE - wS) : (1440 - wS + wE);
  // Use absolute minutes (same approach as timeline rendering)
  var sDay = Math.floor(startMin / 1440) * 1440;
  var wAbs = sDay + wS;
  if (wAbs + wDur <= startMin) wAbs += 1440;
  // Check overlap: FDP [startMin, endMin] vs WOCL [wAbs, wAbs+wDur]
  return startMin < wAbs + wDur && endMin > wAbs;
}

function dtCalculate() {
  var crew  = parseInt(document.querySelector('.dt-crew-btn.active').dataset.crew);
  var hasC1 = document.getElementById('dt-c1').checked;
  var disc  = crew===3 && document.getElementById('dt-disc').checked;
  var td6   = document.getElementById('dt-td6').checked;
  var accom = document.getElementById('dt-accom').checked;
  var accomMin = 0, accomType = 'notstart';
  var accomErr = document.getElementById('dt-accom-err');
  if (accomErr) { accomErr.style.display = 'none'; accomErr.textContent = ''; }
  if (accom) {
    accomMin = (parseInt(document.getElementById('dt-accom-h').value)||0)*60 +
               (parseInt(document.getElementById('dt-accom-m').value)||0);
    if (accomMin <= 180) {
      if (accomErr) {
        accomErr.textContent = '⚠ Rest Duration must be more than 3 hours to apply Accommodation rules.';
        accomErr.style.display = 'block';
      }
      return;
    }
    accomType = dtGetAccomType();
  }
  var tz    = dtGetTzOffset(document.getElementById('dt-tz').value);

  var startMin = dtDayMin('dt-s-day','dt-s-h','dt-s-m');
  var endMin   = dtDayMin('dt-e-day','dt-e-h','dt-e-m');
  var hasDhd   = document.getElementById('dt-dhd').checked;
  var dhdEndMin = hasDhd ? dtDayMin('dt-dhd-day','dt-dhd-h','dt-dhd-m') : null;
  var ftMin    = (parseInt(document.getElementById('dt-ft-h').value)||0)*60 +
                 (parseInt(document.getElementById('dt-ft-m').value)||0);

  if (startMin === null) {
    alert('請輸入 FDP Start 時間');
    return;
  }

  var maxFdp = DT_MAX_FDP[crew] + (disc ? 2*60 : 0);
  var accomExt = 0;
  if (accom && accomMin > 0 && accomType === 'start') {
    accomExt = Math.floor(accomMin * 0.5);
    maxFdp = Math.min(maxFdp + accomExt, 24*60);
  }
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
  // DHD End must be after FDP End
  if (dhdEndMin !== null && dhdEndMin <= endMin) dhdEndMin += 1440;

  var actFdp  = endMin - startMin;

  // Re-validate FT vs FDP in case Calculate was pressed
  dtCheckFT();
  // Accommodation Not Start: deduct rest from actual FDP
  var adjFdp = actFdp;
  if (accom && accomMin > 0 && accomType === 'notstart') {
    adjFdp = Math.max(0, actFdp - accomMin);
  }
  var minRest = td6 ? 48*60 : dtMinRest(crew, ftMin);

  // Show compliance cards and timeline
  document.querySelector('.dt-tl2').style.display = '';

  // Rest calculation
  var restStart = null, restEnd = null, actRest = null;
  if (dtMode === 'home') {
    var nxtMin = dtDayMin('dt-n-day','dt-n-h','dt-n-m');
    if (nxtMin !== null) {
      restStart = (dhdEndMin !== null) ? dhdEndMin : endMin;
      restEnd = nxtMin;
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
  var fdpOk = adjFdp <= maxFdp;
  document.getElementById('dt-card-fdp').style.display    = '';
  var fdpLabel = dtFmtHM(actFdp);
  if (accom && accomMin > 0 && accomType === 'notstart') {
    fdpLabel += ' → ' + dtFmtHM(adjFdp) + ' (−Accom)';
  }
  document.getElementById('dt-r-fdp').textContent         = fdpLabel;
  var maxLabel = 'Max: ' + dtFmtHM(maxFdp);
  if (disc) maxLabel += ' (incl. PIC disc.)';
  if (accom && accomMin > 0 && accomType === 'start') maxLabel += ' (incl. Accom +' + dtFmtHM(accomExt) + ')';
  document.getElementById('dt-r-fdp-max').textContent     = maxLabel;
  dtCardState('dt-card-fdp', fdpOk);

  // FT card
  var ftOk = ftMin === 0 ? null : ftMin <= maxFt;
  document.getElementById('dt-card-ft').style.display    = '';
  document.getElementById('dt-r-ft').textContent         = ftMin > 0 ? dtFmtHM(ftMin) : '—';
  document.getElementById('dt-r-ft-max').textContent     = 'Max: ' + dtFmtHM(maxFt) + (hasC1 ? ' (C1)' : '');
  dtCardState('dt-card-ft', ftOk);

  // Rest card
  var minRestLabel = td6 ? 'No FD at least 48hr' : dtFmtHM(minRest);
  document.getElementById('dt-card-rest').style.display = '';
  if (actRest !== null) {
    var restOk = actRest >= minRest;
    document.getElementById('dt-r-rest').textContent     = dtFmtHM(actRest);
    document.getElementById('dt-r-rest-min').textContent = 'Min: ' + minRestLabel;
    dtCardState('dt-card-rest', restOk);
  } else {
    document.getElementById('dt-r-rest').textContent     = '—';
    document.getElementById('dt-r-rest-min').textContent = 'Min required: ' + minRestLabel;
    dtCardState('dt-card-rest', null);
  }

  // WOCL
  var woclHit = dtWoclCheck(startMin, endMin, tz);
  var woclBox = document.getElementById('dt-wocl-box');
  if (woclHit) {
    document.getElementById('dt-wocl-msg').innerHTML = 'FDP 觸碰 WOCL 時段。連續2天需34h休息，連續3天需54h休息。例外：每次WOCL後有14h休息則免除。<br><span style="opacity:.7">FDP overlaps WOCL window. 2 consecutive days require 34h rest; 3 consecutive days require 54h rest. Exception: waived if 14h rest is provided after each WOCL.</span>';
    woclBox.style.display = 'block';
  } else {
    woclBox.style.display = 'none';
  }

  // CSS percentages recalculate on reflow, no timing hacks needed
  dtRenderTimeline(startMin, endMin, maxFdp, restStart, restEnd, minRest, tz, disc, accomExt, accomType, dhdEndMin);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
dtInitDates();
showMain();
// 預設顯示簡報箱 datis 分頁 → 立即載入初始天氣資料
wxLoaded = true; (function(){ var fsel = document.getElementById('wx-fleet-select'); if (fsel) fsel.value = wxCurrentFleet; })(); loadWxRegion(wxCurrentRegion);
// ── Service Worker 註冊 ───────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function(){});
}
