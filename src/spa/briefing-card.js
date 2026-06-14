// ── 📋 提示卡 (Flight Briefing Card) ─────────────────────────────────────────
var _briefLoaded = false;

/* ── 航班號跨分頁同步 ── */
var _syncFltLock = false;
function _syncFltNo(source, val) {
  if (_syncFltLock) return;
  if (!/\d/.test(val)) return;
  _syncFltLock = true;
  if (source === 'brief') {
    var pa = document.getElementById('pa-lt-input');
    if (pa) {
      pa.value = val;
      if (_briefFidsCache && !_paFidsCache) { _paFidsCache = _briefFidsCache; _paFidsCacheTime = Date.now(); }
      _paLookupLocalTime(val);
    }
  } else {
    var br = document.getElementById('brief-fno');
    if (br) {
      br.value = val;
      if (_paFidsCache && !_briefFidsCache) { _briefFidsCache = _paFidsCache; }
      _briefOnInput(val);
    }
  }
  _syncFltLock = false;
}

var _briefFields = ['brief-gate','brief-origin','brief-dest','brief-ofp','brief-ft','brief-room'];
var _briefNotes = ['brief-note1','brief-note2','brief-water','brief-fuel','brief-crew','brief-pax'];

function _briefUpdatePob() {
  var crewEl = document.getElementById('brief-crew');
  var paxEl = document.getElementById('brief-pax');
  var pobEl = document.getElementById('brief-pob');
  if (!pobEl) return;
  var c = crewEl ? Number(crewEl.value) : NaN;
  var p = paxEl ? Number(paxEl.value) : NaN;
  var hasC = crewEl && crewEl.value !== '' && !isNaN(c);
  var hasP = paxEl && paxEl.value !== '' && !isNaN(p);
  if (!hasC && !hasP) { pobEl.textContent = '—'; return; }
  var total = (hasC ? c : 0) + (hasP ? p : 0);
  pobEl.textContent = total;
}
window._briefUpdatePob = _briefUpdatePob;

/* ── IATA → UTC offset (hours) ── */
var _briefTzOffset = {
  TPE:8,KHH:8,TSA:8,RMQ:8,
  HKG:8,MFM:8,
  NRT:9,HND:9,KIX:9,CTS:9,FUK:9,SDJ:9,OKA:9,
  KMJ:9,NGO:9,KOJ:9,TAK:9,UKB:9,
  ICN:9,PUS:9,CJU:9,
  CRK:8,MNL:8,CEB:8,DVO:8,
  BKK:7,DMK:7,UTP:7,CNX:7,HKT:7,
  SGN:7,HAN:7,PQC:7,PNH:7,CXR:7,DAD:7,
  CGK:7,DPS:8,SUB:7,KCH:8,KUL:8,PEN:8,
  SIN:8,
  LAX:-8,SFO:-8,SEA:-8,ONT:-8,OAK:-8,PDX:-8,SMF:-8,
  DEN:-7,TUS:-7,PHX:-7,LAS:-8,
  ANC:-9,HNL:-10,GUM:10,SPN:10,
  YVR:-8,
  PRG:1,BER:1,MUC:1,WAW:1,LNZ:1,VIE:1
};

/* ── IATA → ICAO 對照 ── */
var _briefIataToIcao = {
  TPE:'RCTP',KHH:'RCKH',TSA:'RCSS',RMQ:'RCMQ',
  HKG:'VHHH',MFM:'VMMC',
  NRT:'RJAA',HND:'RJTT',KIX:'RJBB',CTS:'RJCC',FUK:'RJFF',SDJ:'RJSS',OKA:'ROAH',
  KMJ:'RJFT',NGO:'RJGG',KOJ:'RJFK',TAK:'RJOT',UKB:'RJBE',
  ICN:'RKSI',PUS:'RKPK',CJU:'RKPC',
  CRK:'RPLC',MNL:'RPLL',CEB:'RPVM',DVO:'RPMD',
  BKK:'VTBS',DMK:'VTBD',UTP:'VTBU',CNX:'VTCC',HKT:'VTSP',
  SGN:'VVTS',HAN:'VVNB',PQC:'VVPQ',PNH:'VDPP',CXR:'VVCR',DAD:'VVDN',
  CGK:'WIII',DPS:'WADD',SUB:'WARR',KCH:'WBGG',KUL:'WMKK',PEN:'WMKP',
  SIN:'WSSS',
  LAX:'KLAX',SFO:'KSFO',SEA:'KSEA',ONT:'KONT',OAK:'KOAK',PDX:'KPDX',SMF:'KSMF',
  DEN:'KDEN',TUS:'KTUS',PHX:'KPHX',LAS:'KLAS',
  ANC:'PANC',HNL:'PHNL',GUM:'PGUM',SPN:'PGSN',
  YVR:'CYVR',
  PRG:'LKPR',BER:'EDDB',MUC:'EDDM',WAW:'EPWA',LNZ:'LOWL',VIE:'LOWW'
};

/* ── 機場名稱查詢（從 _wxFleetData 建表）── */
var _briefAirportNames = null;
function _briefGetName(icao) {
  if (!_briefAirportNames) {
    _briefAirportNames = {};
    if (typeof _wxFleetData !== 'undefined') {
      for (var fleet in _wxFleetData) {
        for (var region in _wxFleetData[fleet]) {
          var list = _wxFleetData[fleet][region];
          for (var i = 0; i < list.length; i++) {
            _briefAirportNames[list[i].icao] = list[i].name;
          }
        }
      }
    }
  }
  return _briefAirportNames[icao] || '';
}

function _briefAutoExpandNotes() {
  setTimeout(function() {
    _briefNotes.forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.value) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
    });
  }, 50);
}

function briefInit() {
  if (_briefLoaded) { _briefAutoExpandNotes(); return; }
  _briefLoaded = true;
  _briefRestore();
  _briefAutoExpandNotes();
  // 還原後同步航班號到 PA
  var _rFno = document.getElementById('brief-fno');
  if (_rFno && _rFno.value) _syncFltNo('brief', _rFno.value);
  // 還原後自動載入天氣
  var _rOrigin = document.getElementById('brief-origin');
  var _rDest = document.getElementById('brief-dest');
  if (_rOrigin && _rOrigin.value) _briefFetchWx('owx', _rOrigin.value);
  if (_rDest && _rDest.value) _briefFetchWx('dwx', _rDest.value);
  _briefFields.concat(_briefNotes).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', _briefSave);
  });
  // Flight Time + Altitude → PA Welcome 同步
  var ftEl = document.getElementById('brief-ft');
  if (ftEl) {
    ftEl.addEventListener('input', function() { _briefSyncFtToPa(ftEl.value); });
    if (ftEl.value) _briefSyncFtToPa(ftEl.value);
  }
  var altEl = document.getElementById('brief-ofp');
  if (altEl) {
    altEl.addEventListener('input', function() { _briefSyncAltToPa(altEl.value); });
    if (altEl.value) _briefSyncAltToPa(altEl.value);
  }
}

/* ── Flight Time + Altitude → PA Welcome 同步 ── */
var _briefFltHr = '';
var _briefFltMin = '';
var _briefAltitude = '';
function _briefSyncFtToPa(val) {
  var raw = val.replace(/\s/g, '');
  _briefFltHr = ''; _briefFltMin = '';
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    var parts = raw.split(':');
    _briefFltHr = parts[0]; _briefFltMin = parts[1];
  } else if (/^\d{3,4}$/.test(raw)) {
    _briefFltMin = raw.slice(-2);
    _briefFltHr = raw.slice(0, -2);
  }
  _briefApplyFtToPa();
}
function _briefSyncAltToPa(val) {
  _briefAltitude = val.trim();
  _briefApplyAltToPa();
}
function _briefApplyAltToPa() {
  var el = document.getElementById('pa-content');
  if (!el) return;
  if (typeof _paManualFlags !== 'undefined') delete _paManualFlags['altitude'];
  el.querySelectorAll('[data-pa="altitude"]').forEach(function(inp) { inp.value = _briefAltitude; });
}
function _briefApplyFtToPa() {
  var el = document.getElementById('pa-content');
  if (!el) return;
  if (typeof _paManualFlags !== 'undefined') { delete _paManualFlags['flt-hr']; delete _paManualFlags['flt-min']; }
  el.querySelectorAll('[data-pa="flt-hr"]').forEach(function(inp) { inp.value = _briefFltHr; });
  el.querySelectorAll('[data-pa="flt-min"]').forEach(function(inp) { inp.value = _briefFltMin; });
}

/* ── 強制重新查詢（Enter / 查詢按鈕）── */
function _briefForceQuery() {
  var inp = document.getElementById('brief-fno');
  if (!inp) return;
  var raw = inp.value.trim().toUpperCase();
  if (!raw) return;
  var num = raw.replace(/^SJX|^JX/, '').replace(/\s/g, '').replace(/^0+/, '') || '0';
  if (!/^\d+$/.test(num)) return;
  // 按 Query 就離開歷史檢視模式
  if (typeof _briefLoadedSnapshot !== 'undefined') _briefLoadedSnapshot = null;
  if (typeof _briefLoadedFlightDate !== 'undefined') _briefLoadedFlightDate = null;
  _briefFidsCache = null;
  _briefFltStatus('查詢中...', 'loading');
  _briefLookup(num, true);  // force=true 跳過快取
}

/* ── debounce 自動查詢 ── */
var _briefFltTimer = null;
var _briefFidsCache = null;

function _briefOnInput(val) {
  if (_briefFltTimer) clearTimeout(_briefFltTimer);
  var raw = val.trim().toUpperCase();
  if (!raw) { _briefFltStatus('', ''); briefClearInfo(); return; }
  var num = raw.replace(/^SJX|^JX/, '').replace(/\s/g, '').replace(/^0+/, '') || '0';
  if (!/^\d+$/.test(num)) { _briefFltStatus('', ''); return; }
  _briefFltStatus('查詢中...', 'loading');
  _briefFltTimer = setTimeout(function() { _briefLookup(num); }, 500);
}

function _briefHasFlight(num, data) {
  var lists = (data.dep || []).concat(data.arr || []);
  for (var i = 0; i < lists.length; i++) {
    var f = lists[i];
    if (!f.ACode || f.ACode.trim() !== 'JX') continue;
    var fNum = (f.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (fNum === num) return true;
  }
  return false;
}

function _briefLookup(num, force) {
  var fno = 'JX' + num;
  var inp = document.getElementById('brief-fno');
  if (inp) inp.value = fno;

  if (!force && _briefFidsCache && _briefHasFlight(num, _briefFidsCache)) {
    var cd = (_briefFidsCache.date || '').replace(/^\d{4}\//, '');
    _briefFltStatus(cd + ' 查到航班 ✓', 'ok');
    _briefFillFromFids(fno, _briefFidsCache);
    return;
  }

  // 只查詢選定的日期
  var tryDates = [_briefDateOffset];
  var idx = 0;
  var tryNext = function() {
    if (idx >= tryDates.length) {
      _briefFltStatus('查無此航班', 'err');
      return;
    }
    var d = _paDateOffset(tryDates[idx]);
    var dm = d.replace(/^\d{4}\//, '');
    idx++;
    _briefFltStatus('查詢 ' + dm + '...', 'loading');
    _fidsFetchByDate(d, force).then(function(data) {
      if (_briefHasFlight(num, data)) {
        _briefFidsCache = data;
        var foundDate = (data.date || d).replace(/^\d{4}\//, '');
        _briefFltStatus(foundDate + ' 查到航班 ✓', 'ok');
        _briefFillFromFids(fno, data);
      } else {
        tryNext();
      }
    }).catch(function() { tryNext(); });
  };
  tryNext();
}

function _briefFltStatus(msg, type) {
  var el = document.getElementById('brief-flt-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pa-flt-status' + (type ? ' pa-flt-' + type : '');
}

function _briefFillFromFids(fno, data) {
  var depList = data.dep || [];
  var arrList = data.arr || [];
  var dateStr = data.date || '';
  var num = fno.replace(/^JX/i, '').replace(/^0+/, '') || '0';

  var depFlight = null;
  for (var i = 0; i < depList.length; i++) {
    var d = depList[i];
    if (!d.ACode || d.ACode.trim() !== 'JX') continue;
    var dNum = (d.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (dNum === num) { depFlight = d; /* 不 break，取最後一筆（跨午夜取次日） */ }
  }

  var arrFlight = null;
  for (var j = 0; j < arrList.length; j++) {
    var a = arrList[j];
    if (!a.ACode || a.ACode.trim() !== 'JX') continue;
    var aNum = (a.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (aNum === num) { arrFlight = a; /* 不 break，取最後一筆 */ }
  }

  if (!depFlight && !arrFlight) { _briefFltStatus('查無此航班', 'err'); return; }

  // Dep Date/Time
  var dtEl = document.getElementById('brief-dep-dt');
  if (dtEl) {
    if (depFlight) {
      var depDateStr = depFlight.ODate || dateStr;
      var time = _briefFmtTime(depFlight.OTime);
      dtEl.textContent = depDateStr + '\n' + time + ' Local';
    } else if (arrFlight) {
      var arrDateStr = arrFlight.ODate || dateStr;
      // arrFlight.OTime 是 TPE 抵達時間(STA)，不是出發地的 STD
      // 先顯示載入中，再從 FR24/FA 取得正確出發時間
      dtEl.textContent = arrDateStr + ' 查詢出發時間...';
      var originIata = arrFlight.CityCode || '';
      _briefFetchOriginInfo(fno, arrDateStr, dtEl, originIata);
    }
  }

  // TPE Gate (出發或抵達都顯示台北端的 Gate)
  if (depFlight && depFlight.Gate) {
    _briefSet('brief-gate', depFlight.Gate);
  } else if (arrFlight && arrFlight.Gate) {
    _briefSet('brief-gate', arrFlight.Gate);
  }

  // Origin & Dest
  if (depFlight) {
    _briefSet('brief-origin', 'TPE');
    _briefSet('brief-dest', depFlight.CityCode || '');
  } else if (arrFlight) {
    _briefSet('brief-origin', arrFlight.CityCode || '');
    _briefSet('brief-dest', 'TPE');
  }

  _briefSave();
  if (typeof _briefUpdatePob === 'function') _briefUpdatePob();
  if (typeof _briefCheckOvertime === 'function') _briefCheckOvertime();
  // 查詢成功 → 存歷史 snapshot（eid→server / 無eid→localStorage）
  if (typeof _briefSaveHistory === 'function') _briefSaveHistory(true);

  // Fetch weather
  var originEl = document.getElementById('brief-origin');
  var destEl = document.getElementById('brief-dest');
  if (originEl && originEl.value) _briefFetchWx('owx', originEl.value);
  if (destEl && destEl.value) _briefFetchWx('dwx', destEl.value);
}

/* ── 外站出發資訊查詢（FR24 排程 API → FR24 即時 → FA）── */
function _briefFetchOriginInfo(fno, arrDateStr, dtEl, originIata) {

  function renderDep(depTs, gate) {
    var timeStr = '';
    var depDateStr = arrDateStr;
    if (depTs) {
      var d = new Date(depTs * 1000);
      var offset = _briefTzOffset[originIata];
      if (offset === undefined) offset = 8;
      var local = new Date(d.getTime() + offset * 3600000);
      var hh = String(local.getUTCHours()).padStart(2, '0');
      var mm = String(local.getUTCMinutes()).padStart(2, '0');
      timeStr = hh + ':' + mm;
      depDateStr = local.getUTCFullYear() + '/' +
        String(local.getUTCMonth() + 1).padStart(2, '0') + '/' +
        String(local.getUTCDate()).padStart(2, '0');
    }
    var display = timeStr ? timeStr + ' Local' : '';
    if (gate && originIata !== 'TPE') display += (display ? ' / Gate ' : 'Gate ') + gate;
    dtEl.textContent = depDateStr + '\n' + (display || '—');
  }

  // 把 FIDS 到達日 "2026/03/09" 轉成 "20260309" 用於比對
  var arrDateClean = arrDateStr.replace(/\//g, '');

  // 1) FR24 排程 API（主要來源）
  fetch('/api/fr24-schedule?fno=' + encodeURIComponent(fno))
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.flights || data.flights.length === 0) return null;
      var matched = null;
      for (var i = 0; i < data.flights.length; i++) {
        var f = data.flights[i];
        var arrTs = f.actualArr || f.scheduledArr;
        if (!arrTs) continue;
        var arrTPE = new Date(arrTs * 1000 + 8 * 3600000);
        var y = arrTPE.getUTCFullYear();
        var m = String(arrTPE.getUTCMonth() + 1).padStart(2, '0');
        var d = String(arrTPE.getUTCDate()).padStart(2, '0');
        if (y + m + d === arrDateClean) { matched = f; break; }
      }
      if (!matched) matched = data.flights[data.flights.length - 1];
      return matched;
    })
    .then(function(sched) {
      if (sched && (sched.actualDep || sched.scheduledDep)) {
        var depTs = sched.actualDep || sched.scheduledDep;
        renderDep(depTs, '');
        // 再查 FR24 即時/FA 補 gate
        _briefFetchGate(fno, originIata, function(gate) {
          if (gate) renderDep(depTs, gate);
        });
      } else {
        // 排程沒資料，退回即時查詢
        _briefFetchLiveOrigin(fno, arrDateStr, dtEl, originIata);
      }
    })
    .catch(function() {
      _briefFetchLiveOrigin(fno, arrDateStr, dtEl, originIata);
    });
}

/* ── 退回 FR24 即時 + FA 查出發資訊 ── */
function _briefFetchLiveOrigin(fno, dateStr, dtEl, originIata) {
  var done = false;
  var pending = 2;
  function tryUpdate(flight) {
    if (done) return;
    if (!flight) { pending--; if (pending <= 0) fallback(); return; }
    var depIso = flight.scheduledDep || flight.actualDep || '';
    var gate = (flight.origin && flight.origin.gate) || '';
    if (!depIso && !gate) { pending--; if (pending <= 0) fallback(); return; }
    done = true;
    var timeStr = '';
    var depDateStr = dateStr;
    if (depIso) {
      var d = new Date(depIso);
      var offset = _briefTzOffset[originIata];
      if (offset === undefined) offset = 8;
      var local = new Date(d.getTime() + offset * 3600000);
      timeStr = String(local.getUTCHours()).padStart(2, '0') + ':' + String(local.getUTCMinutes()).padStart(2, '0');
      depDateStr = local.getUTCFullYear() + '/' + String(local.getUTCMonth() + 1).padStart(2, '0') + '/' + String(local.getUTCDate()).padStart(2, '0');
    }
    var display = timeStr ? timeStr + ' Local' : '';
    if (gate && originIata !== 'TPE') display += (display ? ' / Gate ' : 'Gate ') + gate;
    dtEl.textContent = depDateStr + '\n' + (display || '—');
  }
  function fallback() {
    dtEl.textContent = dateStr + '\n—';
  }
  fetch('/api/fids-fr24')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { tryUpdate(data && data.flights && data.flights[fno] || null); })
    .catch(function() { tryUpdate(null); });
  fetch('/api/fids-fa?airline=JX')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { tryUpdate(data && data.flights && data.flights[fno] || null); })
    .catch(function() { tryUpdate(null); });
}

/* ── 只查 Gate（FR24 即時 + FA）── */
function _briefFetchGate(fno, originIata, cb) {
  var done = false;
  var pending = 2;
  function tryGate(flight) {
    if (done) return;
    var gate = flight && flight.origin && flight.origin.gate || '';
    if (gate && originIata !== 'TPE') { done = true; cb(gate); return; }
    pending--;
    if (pending <= 0) cb('');
  }
  fetch('/api/fids-fr24')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { tryGate(data && data.flights && data.flights[fno]); })
    .catch(function() { tryGate(null); });
  fetch('/api/fids-fa?airline=JX')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { tryGate(data && data.flights && data.flights[fno]); })
    .catch(function() { tryGate(null); });
}

function _briefFmtTime(t) {
  if (!t) return '';
  return t.replace(/:\d{2}$/, '');
}

function _briefSet(id, val) {
  var el = document.getElementById(id);
  if (el) el.value = val;
}

function _briefFmtSky(m) {
  if (!m) return '';
  if (!m.sky || m.sky.length === 0) return m.visib === '10+' ? 'CAVOK' : '';
  var ceilings = m.sky.filter(function(s) { return s.cover === 'BKN' || s.cover === 'OVC'; });
  if (ceilings.length > 0) {
    var lowest = ceilings.reduce(function(a, b) { return a.base < b.base ? a : b; });
    return lowest.cover + String(Math.round(lowest.base / 100)).padStart(3, '0');
  }
  var top = m.sky[m.sky.length - 1];
  return top.cover + String(Math.round(top.base / 100)).padStart(3, '0');
}

/* ── 天氣查詢 ── */
var _briefWxTimer = {};

function _briefWxRefresh(target, iata) {
  if (_briefWxTimer[target]) clearTimeout(_briefWxTimer[target]);
  _briefWxTimer[target] = setTimeout(function() {
    _briefFetchWx(target, iata.trim().toUpperCase());
  }, 500);
}

function _briefFetchWx(target, iata) {
  var el = document.getElementById('brief-' + target);
  if (!el) return;
  if (!iata || iata.length < 2) { el.innerHTML = '—'; return; }

  var icao = _briefIataToIcao[iata] || iata;
  if (!/^[A-Z]{4}$/.test(icao)) { el.innerHTML = '—'; return; }

  el.innerHTML = '<span style="color:var(--muted);font-size:.8em">載入中...</span>';

  fetch('/api/metar?ids=' + icao + '&hours=6').then(function(r) { return r.ok ? r.text() : Promise.reject(); }).then(function(text) {
      var lines = text.trim().split('\n').filter(function(l) { return l.trim(); });
      if (lines.length === 0) { el.innerHTML = '<span style="color:var(--muted)">無資料</span>'; return; }
      var raw = lines[0].replace(/^(METAR|SPECI)\s+/, '').trim();
      var m = parseMetarLine(raw);
      var cat = wxCalcCat(m);
      var name = _briefGetName(icao);
      var mins = wxMinsAgo(m);
      var ageClass = mins > 90 ? 'color:#ef4444' : mins > 60 ? 'color:#f59e0b' : 'color:var(--muted)';
      var ageText = mins !== null && mins > 90 ? 'expired' : '';
      var skyText = _briefFmtSky(m);
      el.innerHTML =
        '<div style="text-align:left;font-size:.78em;line-height:1.6">' +
        '<div><span class="wx-cat cat-' + cat + '" style="font-size:.7em;padding:1px 5px">' + cat + '</span> ' +
        '<b>' + icao + '</b>' + (name ? ' ' + name : '') + '</div>' +
        '<div style="color:var(--muted)">' + wxFmtWind(m) + ' &middot; ' + wxFmtVis(m) + ' &middot; ' + wxFmtTemp(m) +
        (skyText ? ' &middot; ' + skyText : '') +
        (ageText ? ' <span style="font-size:.85em;' + ageClass + '">' + ageText + '</span>' : '') +
        '</div></div>';
      // WX 抓完順便更新 history snapshot（debounced，避免 o+d 兩次 call）
      if (typeof _briefSaveHistory === 'function') _briefSaveHistory(false);
    })
    .catch(function() {
      el.innerHTML = '<span style="color:var(--muted)">查詢失敗</span>';
    });
}

/* ── 清除 ── */
function briefClearInfo() {
  _briefFields.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var dtEl = document.getElementById('brief-dep-dt');
  if (dtEl) dtEl.textContent = '—';
  var owx = document.getElementById('brief-owx');
  if (owx) owx.innerHTML = '—';
  var dwx = document.getElementById('brief-dwx');
  if (dwx) dwx.innerHTML = '—';
  _briefSave();
  if (typeof _briefCheckOvertime === 'function') _briefCheckOvertime();
}

function briefClearAll() {
  var fno = document.getElementById('brief-fno');
  if (fno) fno.value = '';
  _briefFltStatus('', '');
  _briefFidsCache = null;
  briefClearInfo();
  briefClearNotes();
  if (typeof _briefCheckOvertime === 'function') _briefCheckOvertime();
}

function briefClearNotes() {
  _briefNotes.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  if (typeof _briefUpdatePob === 'function') _briefUpdatePob();
  _briefSave();
}

/* ── localStorage ── */
function _briefSave() {
  try {
    var obj = {};
    _briefFields.concat(_briefNotes).forEach(function(id) {
      var el = document.getElementById(id);
      if (el) obj[id] = el.value;
    });
    var fno = document.getElementById('brief-fno');
    if (fno) obj['brief-fno'] = fno.value;
    var depDt = document.getElementById('brief-dep-dt');
    if (depDt) obj['brief-dep-dt'] = depDt.textContent;
    localStorage.setItem('crewsync_brief_data', JSON.stringify(obj));
  } catch(e) {}
}

function _briefRestore() {
  try {
    var s = localStorage.getItem('crewsync_brief_data');
    if (!s) return;
    var obj = JSON.parse(s);
    Object.keys(obj).forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (id === 'brief-dep-dt') { el.textContent = obj[id] || '—'; }
      else { el.value = obj[id] || ''; }
      if (el.tagName === 'TEXTAREA') { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
    });
    if (typeof _briefUpdatePob === 'function') _briefUpdatePob();
  } catch(e) {}
}

/* ── 日期切換 ◀ M/D ▶ ── */
var _briefDateOffset = 0; // -1=yesterday, 0=today, 1=tomorrow
function _briefDateNav(dir) {
  var next = _briefDateOffset + dir;
  if (next < -1 || next > 1) return;
  _briefDateOffset = next;
  // 點 ◀ ▶ 也離開歷史檢視
  if (typeof _briefLoadedSnapshot !== 'undefined') _briefLoadedSnapshot = null;
  if (typeof _briefLoadedFlightDate !== 'undefined') _briefLoadedFlightDate = null;
  _briefUpdateDateLabel();
  // 切換日期後自動重新查詢
  var inp = document.getElementById('brief-fno');
  if (inp && inp.value.trim()) {
    briefClearInfo();
    _briefFidsCache = null;
    _briefForceQuery();
  }
  if (typeof _briefUpdatePob === 'function') _briefUpdatePob();
}
function _briefUpdateDateLabel() {
  var el = document.getElementById('brief-date-label');
  if (!el) return;
  var d = new Date();
  d.setDate(d.getDate() + _briefDateOffset);
  el.textContent = (d.getMonth() + 1) + '/' + d.getDate();
}
/* 頁面載入時初始化日期標籤 */
document.addEventListener('DOMContentLoaded', _briefUpdateDateLabel);
function _briefGetDate() {
  var d = new Date();
  d.setDate(d.getDate() + _briefDateOffset);
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/* ── Turbli 亂流預報 ── */
function openTurbli(autoFill) {
  if (!autoFill) { window.open('https://turbli.com/', '_blank'); return; }
  var orig = (document.getElementById('brief-origin') || {}).value || '';
  var dest = (document.getElementById('brief-dest') || {}).value || '';
  var dt = _briefGetDate();
  var fltEl = document.getElementById('brief-fno');
  var flt = (fltEl ? fltEl.value : '').trim().toUpperCase();
  var fn = flt.replace(/([A-Z]{2})(\d+)/, '$1-$2');
  if (orig && dest && fn) {
    window.open('https://turbli.com/' + orig + '/' + dest + '/' + dt + '/' + fn + '/', '_blank');
  } else {
    var missing = [];
    if (!orig) missing.push('Origin');
    if (!dest) missing.push('Dest');
    if (!fn) missing.push('Flight');
    if (confirm('缺少：' + missing.join(', ') + '\n開啟 Turbli 首頁？')) {
      window.open('https://turbli.com/', '_blank');
    }
  }
}

/* ═════════════════════════════════════════════════════════════
   Briefing 歷史（有員編 eid → server 跨裝置；沒員編 → 本機 localStorage）
   ═════════════════════════════════════════════════════════════ */
function _briefGetEid() {
  try { return localStorage.getItem('crewsync_eid') || ''; } catch(e) { return ''; }
}
function _briefUpdateSyncHint() {
  var el = document.getElementById('brief-sync-hint');
  if (!el) return;
  var eid = _briefGetEid();
  el.textContent = eid
    ? '🔗 已登入員編 ' + eid + '，briefing 歷史跨裝置同步'
    : '💾 未登入員編（上傳班表後才會跨裝置），目前僅本機儲存';
}
var _briefLoadedFlightDate = null;  // 歷史檢視時的日期（存檔要對到它而非今天）
function _briefFlightKey() {
  var fnoEl = document.getElementById('brief-fno');
  var fno = fnoEl ? String(fnoEl.value || '').trim().toUpperCase() : '';
  var date = _briefLoadedFlightDate || _briefGetDate();
  return { flight_no: fno, flight_date: date };
}
function _briefSnapshot() {
  var obj = {};
  _briefFields.concat(_briefNotes).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) obj[id] = el.value;
  });
  var fno = document.getElementById('brief-fno');
  if (fno) obj['brief-fno'] = fno.value;
  var depDt = document.getElementById('brief-dep-dt');
  if (depDt) obj['brief-dep-dt'] = depDt.textContent;
  // WX 顯示（METAR/TAF 的 textContent，方便歷史直接看）
  var owx = document.getElementById('brief-owx');
  if (owx) obj['brief-owx'] = owx.innerHTML;
  var dwx = document.getElementById('brief-dwx');
  if (dwx) obj['brief-dwx'] = dwx.innerHTML;
  return obj;
}
function _briefApplySnapshot(obj) {
  if (!obj) return;
  Object.keys(obj).forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (id === 'brief-dep-dt') { el.textContent = obj[id] || '—'; }
    else if (id === 'brief-owx' || id === 'brief-dwx') { el.innerHTML = obj[id] || '—'; }
    else if ('value' in el) { el.value = obj[id] || ''; }
    if (el.tagName === 'TEXTAREA') { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  });
  if (typeof _briefUpdatePob === 'function') _briefUpdatePob();
  if (typeof _briefCheckOvertime === 'function') _briefCheckOvertime();
}
function _briefLocalHistKey() { return 'crewsync_brief_hist'; }
function _briefLocalHistGet() {
  try { return JSON.parse(localStorage.getItem(_briefLocalHistKey()) || '{}') || {}; } catch(e) { return {}; }
}
function _briefLocalHistSet(map) {
  try { localStorage.setItem(_briefLocalHistKey(), JSON.stringify(map)); } catch(e) {}
}
function _briefLocalKey(fno, date) { return (fno || '') + '|' + (date || ''); }

/* ── 存 / 取 / 列 / 刪（eid → server；無 eid → localStorage） ── */
var _briefSaveTimer = null;
// 儲存狀態 dot: 'saved' (綠) | 'saving' (黃) | 'idle' (隱藏)
function _briefSetSaveDot(state) {
  var dot = document.getElementById('brief-save-dot');
  if (!dot) return;
  dot.className = 'brief-save-dot';
  if (state === 'saved') dot.classList.add('saved');
  else if (state === 'saving') dot.classList.add('saving');
  dot.title = state === 'saved' ? '已儲存' : (state === 'saving' ? '儲存中…' : '');
}
function _briefSaveHistory(forceImmediate) {
  var k = _briefFlightKey();
  if (!k.flight_no || !k.flight_date) return;
  var doSave = function() {
    _briefSetSaveDot('saving');
    var snap = _briefSnapshot();
    var eid = _briefGetEid();
    var done = function() { _briefSetSaveDot('saved'); };
    var saveLocal = function() {
      var map = _briefLocalHistGet();
      map[_briefLocalKey(k.flight_no, k.flight_date)] = { data: snap, updated_at: new Date().toISOString() };
      _briefLocalHistSet(map);
    };
    if (eid) {
      fetch('/api/briefing', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, (typeof _plAtHeaders === 'function' ? _plAtHeaders() : {})),
        body: JSON.stringify({ eid: eid, flight_no: k.flight_no, flight_date: k.flight_date, data: snap }),
      }).then(function(r) {
        // server 拒(403 驗證失敗/未登入)或非 200 → 退存本機，資料不丟、'saved' 才不會騙人(codex P2)。讀取端同樣會退本機。
        if (!r || !r.ok) saveLocal();
        done();
      }).catch(function() { saveLocal(); done(); });   // 網路掛 → 也退本機
    } else {
      saveLocal();
      done();
    }
  };
  if (forceImmediate) {
    if (_briefSaveTimer) { clearTimeout(_briefSaveTimer); _briefSaveTimer = null; }
    doSave();
  } else {
    if (_briefSaveTimer) clearTimeout(_briefSaveTimer);
    _briefSetSaveDot('saving');  // 使用者還在打字時，dot 先變黃
    _briefSaveTimer = setTimeout(doSave, 500);
  }
}
async function _briefLoadHistoryEntry(fno, date) {
  var eid = _briefGetEid();
  if (eid) {
    try {
      var r = await fetch('/api/briefing?eid=' + encodeURIComponent(eid) + '&flight_no=' + encodeURIComponent(fno) + '&flight_date=' + encodeURIComponent(date), { headers: (typeof _plAtHeaders === 'function' ? _plAtHeaders() : {}) });
      if (r.ok) { var j = await r.json(); return j.data || null; }
    } catch(e) {}
    return null;
  }
  var map = _briefLocalHistGet();
  var e = map[_briefLocalKey(fno, date)];
  return e ? e.data : null;
}
async function _briefListHistory() {
  var eid = _briefGetEid();
  if (eid) {
    try {
      var r = await fetch('/api/briefing/list?eid=' + encodeURIComponent(eid) + '&limit=100', { headers: (typeof _plAtHeaders === 'function' ? _plAtHeaders() : {}) });
      if (r.ok) { var j = await r.json(); return j.items || []; }
    } catch(e) {}
    return [];
  }
  var map = _briefLocalHistGet();
  var items = [];
  Object.keys(map).forEach(function(k) {
    var parts = k.split('|');
    items.push({ flight_no: parts[0], flight_date: parts[1], updated_at: map[k].updated_at });
  });
  items.sort(function(a, b) { return (b.flight_date || '').localeCompare(a.flight_date || ''); });
  return items;
}
async function _briefDeleteHistoryEntry(fno, date) {
  var eid = _briefGetEid();
  if (eid) {
    try {
      await fetch('/api/briefing', {
        method: 'DELETE',
        headers: Object.assign({ 'Content-Type': 'application/json' }, (typeof _plAtHeaders === 'function' ? _plAtHeaders() : {})),
        body: JSON.stringify({ eid: eid, flight_no: fno, flight_date: date }),
      });
    } catch(e) {}
  } else {
    var map = _briefLocalHistGet();
    delete map[_briefLocalKey(fno, date)];
    _briefLocalHistSet(map);
  }
}

/* ── 歷史 modal UI（月曆式，點日期下方顯示該日航班列表）── */
var _briefHistItems = [];
var _briefHistMonth = null; // {year, month}
var _briefHistSelected = null; // 'YYYY-MM-DD'

async function _briefOpenHistory() {
  var wrap = document.getElementById('brief-hist-wrap');
  var hint = document.getElementById('brief-hist-hint');
  if (!wrap) return;
  wrap.style.display = 'flex';
  var eid = _briefGetEid();
  var cal = document.getElementById('brief-hist-cal');
  var day = document.getElementById('brief-hist-day');
  if (cal) cal.innerHTML = '<div style="grid-column:span 7;padding:20px;text-align:center;color:var(--muted)">載入中…</div>';
  if (day) day.innerHTML = '';
  _briefHistItems = await _briefListHistory();
  var storage = eid ? ('員編 ' + eid + ' · 跨裝置同步') : '未登入員編 · 僅本機裝置';
  hint.textContent = storage + ' · 共 ' + _briefHistItems.length + ' 筆紀錄';
  _briefHistSelected = null;
  // 預設月份：最新一筆的月份，否則今天
  var base = new Date();
  if (_briefHistItems.length > 0 && _briefHistItems[0].flight_date) {
    var p = (_briefHistItems[0].flight_date || '').split('-');
    if (p.length === 3) base = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  _briefHistMonth = { year: base.getFullYear(), month: base.getMonth() };
  _briefRenderCal();
  // 綁 ◀ ▶
  var prev = document.getElementById('brief-hist-prev');
  var next = document.getElementById('brief-hist-next');
  if (prev) prev.onclick = function() { _briefHistMonth.month--; if (_briefHistMonth.month < 0) { _briefHistMonth.month = 11; _briefHistMonth.year--; } _briefRenderCal(); };
  if (next) next.onclick = function() { _briefHistMonth.month++; if (_briefHistMonth.month > 11) { _briefHistMonth.month = 0; _briefHistMonth.year++; } _briefRenderCal(); };
}

// 把航線簡化為「非 TPE 那一側」（絕大多數航班都過 TPE）
function _briefRouteShort(orig, dest) {
  var o = (orig || '').toUpperCase();
  var d = (dest || '').toUpperCase();
  if (o === 'TPE' && d) return d;
  if (d === 'TPE' && o) return o;
  if (!o && !d) return '—';
  return (o || '—') + '-' + (d || '—');
}

function _briefRenderCal() {
  if (!_briefHistMonth) return;
  var y = _briefHistMonth.year, m = _briefHistMonth.month;
  var title = document.getElementById('brief-hist-title');
  if (title) title.textContent = y + ' / ' + String(m + 1).padStart(2, '0');
  var cal = document.getElementById('brief-hist-cal');
  if (!cal) return;
  // 按日期分組
  var byDate = {};
  _briefHistItems.forEach(function(it) {
    if (!it.flight_date) return;
    var p = it.flight_date.split('-');
    if (p.length === 3 && parseInt(p[0], 10) === y && parseInt(p[1], 10) - 1 === m) {
      if (!byDate[it.flight_date]) byDate[it.flight_date] = [];
      byDate[it.flight_date].push(it);
    }
  });
  var td = new Date();
  var todayStr = td.getFullYear() + '-' + String(td.getMonth() + 1).padStart(2, '0') + '-' + String(td.getDate()).padStart(2, '0');
  var dowNames = ['日','一','二','三','四','五','六'];
  var html = dowNames.map(function(n) { return '<div class="bhc-dow">' + n + '</div>'; }).join('');
  var firstDay = new Date(y, m, 1).getDay();
  var lastDate = new Date(y, m + 1, 0).getDate();
  for (var i = 0; i < firstDay; i++) html += '<div class="bhc-day empty"></div>';
  for (var d = 1; d <= lastDate; d++) {
    var ds = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    var cls = ['bhc-day'];
    var items = byDate[ds] || [];
    var has = items.length > 0;
    if (has) cls.push('has-data');
    if (ds === todayStr) cls.push('today');
    // 第一班 + 多餘班數提示
    var first = has ? items[0] : null;
    var extra = items.length > 1 ? items.length - 1 : 0;
    var onc = has ? (' onclick="_briefHistDayTap(\'' + ds + '\')"') : '';
    html += '<div class="' + cls.join(' ') + '"' + onc + '>';
    html += '<div class="bhc-date">' + d + '</div>';
    html += '<div class="bhc-fno">' + (first ? (first.flight_no || '—') : '&nbsp;') + '</div>';
    html += '<div class="bhc-route">' + (first ? _briefRouteShort(first.orig, first.dest) : '&nbsp;') + '</div>';
    html += '<div class="bhc-more">' + (extra > 0 ? ('⋯ +' + extra) : '&nbsp;') + '</div>';
    html += '</div>';
  }
  cal.innerHTML = html;
}

// 點日期格子 → 下方彈出該日完整清單（不管幾班，都讓使用者選載入或刪除）
function _briefHistDayTap(ds) {
  var items = _briefHistItems.filter(function(it) { return it.flight_date === ds; });
  if (items.length === 0) return;
  _briefShowDayPanel(ds, items);
}

var _briefDayPanelShow = false;
function _briefShowDayPanel(ds, items) {
  // 在 calendar 下方 insert/update 一個 overlay panel
  var wrap = document.getElementById('brief-hist-wrap');
  if (!wrap) return;
  var existing = document.getElementById('brief-hist-day-panel');
  if (existing) existing.remove();
  var panel = document.createElement('div');
  panel.id = 'brief-hist-day-panel';
  panel.style.cssText = 'margin-top:10px;border-top:1px solid var(--border);padding-top:10px;max-height:35vh;overflow-y:auto';
  var html = '<div style="font-size:.76em;color:var(--muted);margin-bottom:6px">' + ds + ' 共 ' + items.length + ' 班</div>';
  items.forEach(function(it) {
    var safeFno = (it.flight_no || '').replace(/'/g, "\\'");
    var safeDate = (it.flight_date || '').replace(/'/g, "\\'");
    var route = _briefRouteShort(it.orig, it.dest);
    html += '<div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border)">'
      + '<div style="flex:1;cursor:pointer" onclick="_briefLoadHistoryItem(\'' + safeFno + '\',\'' + safeDate + '\')">'
      +   '<div style="font-weight:600;color:var(--text)">' + (it.flight_no || '—') + '</div>'
      +   '<div style="font-size:.76em;color:var(--muted)">' + route + '</div>'
      + '</div>'
      + '<button onclick="_briefDeleteHistoryItem(\'' + safeFno + '\',\'' + safeDate + '\')" style="background:none;border:1px solid var(--border);color:var(--muted);width:28px;height:28px;border-radius:50%;font-size:.8em;cursor:pointer">✕</button>'
      + '</div>';
  });
  panel.innerHTML = html;
  wrap.querySelector('.bhc-dow') ? wrap.querySelector('div').parentNode.appendChild(panel) : wrap.appendChild(panel);
  // 更簡單：append 到 calendar 後面
  var cal = document.getElementById('brief-hist-cal');
  if (cal && cal.parentNode) cal.parentNode.appendChild(panel);
}

function _briefCloseHistory() {
  var w = document.getElementById('brief-hist-wrap');
  if (w) w.style.display = 'none';
}
var _briefLoadedSnapshot = null;
async function _briefLoadHistoryItem(fno, date) {
  var data = await _briefLoadHistoryEntry(fno, date);
  if (!data) { alert('找不到此歷史紀錄'); return; }
  // 先 reset 再填入
  briefClearInfo();
  briefClearNotes();
  // 航班號跟日期
  var fnoEl = document.getElementById('brief-fno');
  if (fnoEl) fnoEl.value = fno;
  _briefApplySnapshot(data);
  // 更新日期 label 顯示歷史日期（M/D 格式）
  var dateLabel = document.getElementById('brief-date-label');
  if (dateLabel && date) {
    var parts = date.split('-');
    if (parts.length === 3) dateLabel.textContent = parseInt(parts[1], 10) + '/' + parseInt(parts[2], 10);
  }
  // 同步到當前編輯 buffer，下次重整頁面看到的是這份歷史
  if (typeof _briefSave === 'function') _briefSave();
  // 記下載入的 snapshot 跟歷史日期，blur/Query 存檔要對到歷史這筆
  _briefLoadedSnapshot = data;
  _briefLoadedFlightDate = date;
  _briefCloseHistory();
  _briefFltStatus && _briefFltStatus('🕘 歷史 ' + (date || ''), '#94a3b8');
}
async function _briefDeleteHistoryItem(fno, date) {
  if (!confirm('確定刪除 ' + fno + ' @ ' + date + ' 的 briefing？')) return;
  await _briefDeleteHistoryEntry(fno, date);
  _briefOpenHistory();  // 重新載入
}

/* 啟動時更新同步提示 + 每個 briefing 欄位 oninput 觸發 debounced save（不用等 blur） */
function _briefAttachAutoSave() {
  var ids = _briefFields.concat(_briefNotes).concat(['brief-dep-dt']);
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el._briefSaveBound) return;
    el._briefSaveBound = true;
    // input 事件：textarea/input 打字時觸發；contenteditable 也會觸發 input
    el.addEventListener('input', function() { _briefSaveHistory(false); });
    // 加 blur 當備胎（avoid race on closing tab）
    el.addEventListener('blur', function() { _briefSaveHistory(false); });
  });
}
document.addEventListener('DOMContentLoaded', function() {
  _briefUpdateSyncHint();
  _briefAttachAutoSave();
  // 有些元素可能是後來才出現的，briefInit 後再補綁一次
  setTimeout(_briefAttachAutoSave, 200);
});

/* ── Briefing Room 平面圖 modal ── */
function _openBriefRoom() {
  var wrap = document.getElementById('brief-room-wrap');
  var img = document.getElementById('brief-room-img');
  // 確保 src 是 /briefing-room（初始 src="" 讀出來會是 current URL，需明確設）
  if (img && !(img.getAttribute('src') || '').endsWith('/briefing-room')) {
    img.src = '/briefing-room';
  }
  if (wrap) wrap.style.display = 'flex';
}
function _closeBriefRoom() {
  var wrap = document.getElementById('brief-room-wrap');
  if (wrap) wrap.style.display = 'none';
}
window._openBriefRoom = _openBriefRoom;
window._closeBriefRoom = _closeBriefRoom;

/* ═════════════════════════════════════════════════════════════
   Overtime 提醒：輸入 FT 跟 roster 表定 FT 比對，差 ≤ 10 分鐘就提示
   ═════════════════════════════════════════════════════════════ */
// 把 "0320" / "03:20" / "3:20" → 分鐘。無效回 null
function _briefParseFT(s) {
  if (!s) return null;
  s = String(s).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { return parseInt(m[1], 10) * 60 + parseInt(m[2], 10); }
  m = s.match(/^(\d{3,4})$/);
  if (m) { var p = m[1].padStart(4, '0'); return parseInt(p.substring(0, 2), 10) * 60 + parseInt(p.substring(2, 4), 10); }
  return null;
}
// 統一航班號比對形式：去空白、去前導 0，統一成 "JX{純數字}"
// 與 _briefForceQuery / _briefOnInput / _briefHasFlight 等其他 lookup 規則一致
function _briefNormFno(s) {
  s = String(s || '').toUpperCase().replace(/\s+/g, '');
  s = s.replace(/^SJX|^JX/, '');
  s = s.replace(/^0+/, '') || '0';
  return 'JX' + s;
}
// 日期 'YYYY-MM-DD' +- N 天 → 'YYYY-MM-DD'
function _briefDateShift(dateStr, deltaDays) {
  var p = String(dateStr).split('-');
  if (p.length !== 3) return dateStr;
  var d = new Date(parseInt(p[0],10), parseInt(p[1],10) - 1, parseInt(p[2],10));
  d.setDate(d.getDate() + deltaDays);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
// 解析 "2025.Dec.28 2215L" → "2025-12-28"
function _briefParseDutyDate(str) {
  if (!str) return null;
  var m = String(str).match(/(\d{4})\.(\w{3})\.(\d{1,2})/);
  if (!m) return null;
  var months = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
  var mon = months[m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()];
  if (!mon) return null;
  return m[1] + '-' + String(mon).padStart(2, '0') + '-' + String(parseInt(m[3], 10)).padStart(2, '0');
}
// 從 flight 自己的欄位推日期 → 'YYYY-MM-DD'。學 overtime.js _otParseDateFromFlight 的做法。
// 優先序：fl.date (YYYY-MM-DD) → fl.depTime / depTimeUtc 內的 "/DDMMM" pattern → fallback duty.reportTime
function _briefParseFlightDate(fl, duty, monthStr) {
  if (fl && fl.date && /^\d{4}-\d{2}-\d{2}$/.test(fl.date)) return fl.date;
  var monNames = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6, JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 };
  var sources = [fl && fl.depTime, fl && fl.depTimeUtc];
  for (var i = 0; i < sources.length; i++) {
    var match = (sources[i] || '').match(/\/(\d{1,2})([A-Za-z]{3})/);
    if (!match) continue;
    var day = parseInt(match[1], 10);
    var mon = monNames[match[2].toUpperCase()];
    if (!day || !mon) continue;
    var ym = String(monthStr || '').split('-');
    var year = parseInt(ym[0], 10);
    var monInRoster = parseInt(ym[1], 10);
    if (isNaN(year) || isNaN(monInRoster)) continue;
    // 跨年容錯：12 月 roster 看到 1 月日期 → 隔年；1 月 roster 看到 12 月 → 前年
    if (mon === 1 && monInRoster === 12) year++;
    else if (mon === 12 && monInRoster === 1) year--;
    return year + '-' + String(mon).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  return _briefParseDutyDate(duty && duty.reportTime);
}
// 找 roster 內航班號相符的 flight。兩階段比對：
//   (1) 先用 flight-level 日期 (穩，跟 overtime.js 一致)
//   (2) fallback duty-level 日期範圍 (兼容沒 flight-level 日期欄位的舊 roster)
// 夏冬班表時間不同，必須用當天 roster，不可用其他月份估算
function _briefFindRosterFlight(flightNo, dateStr) {
  var eid = _briefGetEid();
  if (!eid || !flightNo || !dateStr) return null;
  var target = _briefNormFno(flightNo);
  var mm = dateStr.slice(0, 7);
  var ym = mm.split('-');
  var y = parseInt(ym[0], 10), m = parseInt(ym[1], 10);
  if (isNaN(y) || isNaN(m)) return null;
  var months = [];
  var pm = m - 1, py = y; if (pm < 1) { pm = 12; py--; }
  var nm = m + 1, ny = y; if (nm > 12) { nm = 1; ny++; }
  months.push(py + '-' + String(pm).padStart(2, '0'));
  months.push(y + '-' + String(m).padStart(2, '0'));
  months.push(ny + '-' + String(nm).padStart(2, '0'));
  var targetMin = _briefDateShift(dateStr, -1);
  var targetMax = _briefDateShift(dateStr, +1);
  // 先收集所有航班號相符的 candidates（保留來源 month / duty 供日期推算）
  var candidates = [];
  for (var mi = 0; mi < months.length; mi++) {
    var raw;
    try { raw = localStorage.getItem('crewsync_roster_' + eid + '_' + months[mi]); } catch(e) { continue; }
    if (!raw) continue;
    var data;
    try { data = JSON.parse(raw); } catch(e) { continue; }
    var duties = Array.isArray(data) ? data : (data.duties || []);
    for (var di = 0; di < duties.length; di++) {
      var d = duties[di];
      for (var fi = 0; fi < (d.flights || []).length; fi++) {
        var f = d.flights[fi];
        if (_briefNormFno(f.flightNo) !== target) continue;
        candidates.push({ fl: f, duty: d, monthStr: months[mi] });
      }
    }
  }
  if (candidates.length === 0) return null;
  // 第一輪：flight-level 日期比對
  for (var c1 = 0; c1 < candidates.length; c1++) {
    var cand1 = candidates[c1];
    var fDate = _briefParseFlightDate(cand1.fl, cand1.duty, cand1.monthStr);
    if (fDate && fDate >= targetMin && fDate <= targetMax) return cand1.fl;
  }
  // 第二輪 fallback：duty-level 日期範圍
  for (var c2 = 0; c2 < candidates.length; c2++) {
    var cand2 = candidates[c2];
    var startDate = _briefParseDutyDate(cand2.duty.reportTime);
    var endDate = _briefParseDutyDate(cand2.duty.endTime);
    if (!startDate) continue;
    var dutyEnd = endDate || startDate;
    if (targetMax < startDate || targetMin > dutyEnd) continue;
    return cand2.fl;
  }
  return null;
}
// 算 flight 的表定 FT 分鐘（優先用 flightTime 欄，fallback 用 dep/arr + tz）
function _briefCalcSchedFTmin(fl) {
  if (!fl) return null;
  // V8.0.28 fix: DHD 任務（deadhead）班表系統會把 flightTime 寫 "00:00"（計薪不算 FT），
  // 但 dep/arr time 還在（飛機還是要飛），DHD 也該算 OT。parse 出 0 視為無效，
  // 繼續走下方 dep/arr fallback 算 schedFT。
  if (fl.flightTime) {
    var p = _briefParseFT(fl.flightTime);
    if (p != null && p > 0) return p;
  }
  // fallback: UTC 版本優先，否則 local 轉 UTC
  var parseTime = function(str) {
    if (!str) return null;
    var s = String(str).trim();
    var mm = s.match(/^(\d{4})[ZLzl]?/);
    if (mm) return { hh: parseInt(mm[1].substring(0, 2), 10), mm: parseInt(mm[1].substring(2, 4), 10) };
    var m2 = s.match(/(\d{1,2}):(\d{2})/);
    if (m2) return { hh: parseInt(m2[1], 10), mm: parseInt(m2[2], 10) };
    return null;
  };
  var depU = parseTime(fl.depTimeUtc);
  var arrU = parseTime(fl.arrTimeUtc);
  if (depU && arrU) {
    var d = depU.hh * 60 + depU.mm, a = arrU.hh * 60 + arrU.mm;
    return (a - d + 1440) % 1440;
  }
  // local + tz offset
  var depL = parseTime(fl.depTime);
  var arrL = parseTime(fl.arrTime);
  if (depL && arrL) {
    var oOff = _briefTzOffset[(fl.origin || '').toUpperCase()];
    var dOff = _briefTzOffset[(fl.dest || '').toUpperCase()];
    if (oOff === undefined || dOff === undefined) return null;
    var dUtc = ((depL.hh * 60 + depL.mm) - oOff * 60 + 1440) % 1440;
    var aUtc = ((arrL.hh * 60 + arrL.mm) - dOff * 60 + 1440) % 1440;
    return (aUtc - dUtc + 1440) % 1440;
  }
  return null;
}
function _briefFmtMin(mins) {
  if (mins == null) return '—';
  var h = Math.floor(mins / 60), m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
// 設定 brief-ot-warn 的視覺樣式：'warn' = 黃色（OT 警告）；'hint' = 灰色（診斷提示）
function _briefSetOtBox(el, kind, html) {
  el.style.display = 'flex';
  if (kind === 'warn') {
    el.style.background = 'rgba(251,191,36,.12)';
    el.style.borderColor = '#fbbf24';
  } else {
    el.style.background = 'rgba(148,163,184,.12)';
    el.style.borderColor = 'rgba(148,163,184,.5)';
  }
  el.innerHTML = html;
}
function _briefCheckOvertime() {
  var warnEl = document.getElementById('brief-ot-warn');
  if (!warnEl) return;
  var ftEl = document.getElementById('brief-ft');
  var fnoEl = document.getElementById('brief-fno');
  if (!ftEl || !fnoEl) { warnEl.style.display = 'none'; return; }
  var actualMin = _briefParseFT(ftEl.value);
  var fno = (fnoEl.value || '').trim().toUpperCase();
  // 必要條件不齊：靜默隱藏（使用者還沒輸入完）
  if (actualMin == null || !fno) { warnEl.style.display = 'none'; return; }
  // 沒登入員編就沒 roster 可比對，靜默退出（不是 bug，是預期狀態）
  if (!_briefGetEid()) { warnEl.style.display = 'none'; return; }
  var date = _briefLoadedFlightDate || _briefGetDate();
  var fl = _briefFindRosterFlight(fno, date);
  if (!fl) {
    // 診斷：班表內找不到此航班（消除 silent fail）
    _briefSetOtBox(warnEl, 'hint',
      '<span style="flex:1;color:var(--muted)">📋 班表中找不到 <b>' + _briefNormFno(fno) + '</b>，請確認航班號或當月 roster 是否已載入</span>');
    return;
  }
  var schedMin = _briefCalcSchedFTmin(fl);
  if (schedMin == null) {
    // 診斷：找到 flight 但沒有表定 FT 資料
    _briefSetOtBox(warnEl, 'hint',
      '<span style="flex:1;color:var(--muted)">⏱️ 班表中此航班沒有表定飛行時間，無法比對 OT</span>');
    return;
  }
  // 邏輯：實際 >= 表定-10 就警告（實際更久 = OT 機率高；短於表定 10min 以內 = 邊界）
  if (actualMin >= schedMin - 10) {
    var delta = actualMin - schedMin;  // 正 = 長，負 = 短
    var deltaTxt = delta >= 0 ? ('長 <b>' + delta + '</b> 分鐘') : ('短 <b>' + (-delta) + '</b> 分鐘');
    _briefSetOtBox(warnEl, 'warn',
      '<span style="flex:1">⚠️ 表定 FT <b>' + _briefFmtMin(schedMin) + '</b>，實際' + deltaTxt + '，可能有 OT</span>'
      + '<button onclick="switchBriefingTab(\'overtime\', document.getElementById(\'subtabBtn-overtime\'))" style="background:#fbbf24;color:#1a202c;border:none;border-radius:6px;padding:4px 10px;font-size:.85em;font-weight:700;cursor:pointer;white-space:nowrap">→ Overtime</button>');
  } else {
    // 實際短於表定夠多 → 沒 OT 風險，不顯示（per spec：無 OT 時不打擾）
    warnEl.style.display = 'none';
  }
}
window._briefCheckOvertime = _briefCheckOvertime;
// 任何可能影響判斷的欄位變動都要重算 OT 警告
document.addEventListener('DOMContentLoaded', function() {
  var attach = function() {
    ['brief-ft', 'brief-fno'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && !el._briefOtBound) {
        el._briefOtBound = true;
        el.addEventListener('input', _briefCheckOvertime);
        el.addEventListener('blur', _briefCheckOvertime);
      }
    });
  };
  attach();
  setTimeout(attach, 300);
});
