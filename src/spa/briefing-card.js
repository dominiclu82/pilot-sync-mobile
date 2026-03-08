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

var _briefFields = ['brief-gate','brief-origin','brief-dest','brief-ofp','brief-ft'];
var _briefNotes = ['brief-note1','brief-note2','brief-note3'];

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

function briefInit() {
  if (_briefLoaded) return;
  _briefLoaded = true;
  _briefRestore();
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
  el.querySelectorAll('[data-pa="altitude"]').forEach(function(inp) { inp.value = _briefAltitude; });
}
function _briefApplyFtToPa() {
  var el = document.getElementById('pa-content');
  if (!el) return;
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
  _briefFidsCache = null;  // 清除快取，強制重新 fetch
  _briefFltStatus('查詢中...', 'loading');
  _briefLookup(num);
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

function _briefLookup(num) {
  var fno = 'JX' + num;
  var inp = document.getElementById('brief-fno');
  if (inp) inp.value = fno;

  if (_briefFidsCache && _briefHasFlight(num, _briefFidsCache)) {
    _briefFillFromFids(fno, _briefFidsCache);
    return;
  }

  // 今天 → 明天 → 昨天
  var tryDates = [0, 1, -1];
  var idx = 0;
  var tryNext = function() {
    if (idx >= tryDates.length) {
      _briefFltStatus('查無此航班', 'err');
      return;
    }
    var dateStr = _paDateOffset(tryDates[idx]);
    idx++;
    _paFetchByDate(dateStr).then(function(data) {
      if (_briefHasFlight(num, data)) {
        _briefFidsCache = data;
        _briefFillFromFids(fno, data);
      } else {
        tryNext();
      }
    }).catch(function() { tryNext(); });
  };
  tryNext();
}

function _briefFetchDirect() {
  var ep = atob('aHR0cHM6Ly93d3cudGFveXVhbi1haXJwb3J0LmNvbS9hcGkvYXBpL2ZsaWdodC9hX2ZsaWdodA==');
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 3600000);
  var odate = tw.getUTCFullYear() + '/' +
    String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(tw.getUTCDate()).padStart(2, '0');
  var base = { ODate: odate, OTimeOpen: null, OTimeClose: null, BNO: null, AState: '', language: 'ch', keyword: '' };
  var hdrs = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' };
  return Promise.all([
    fetch(ep, { method: 'POST', headers: hdrs, body: JSON.stringify(Object.assign({}, base, { AState: 'D' })) }),
    fetch(ep, { method: 'POST', headers: hdrs, body: JSON.stringify(Object.assign({}, base, { AState: 'A' })) })
  ]).then(function(res) {
    if (!res[0].ok || !res[1].ok) throw new Error('HTTP ' + res[0].status + '/' + res[1].status);
    return Promise.all([res[0].json(), res[1].json()]);
  }).then(function(data) {
    return { dep: data[0], arr: data[1], date: odate };
  });
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
  _briefFltStatus('✓', 'ok');

  // Dep Date/Time
  var dtEl = document.getElementById('brief-dep-dt');
  if (dtEl) {
    if (depFlight) {
      var depDateStr = depFlight.ODate || dateStr;
      var time = _briefFmtTime(depFlight.OTime);
      dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + depDateStr + '</div>' +
        '<div style="font-size:1.1em;font-weight:700">' + time + ' Local</div>';
    } else if (arrFlight) {
      var arrDateStr = arrFlight.ODate || dateStr;
      // arrFlight.OTime 是 TPE 抵達時間(STA)，不是出發地的 STD
      // 先顯示載入中，再從 FR24/FA 取得正確出發時間
      dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + arrDateStr + '</div>' +
        '<div style="font-size:1.1em;font-weight:700;color:var(--muted)">查詢出發時間...</div>';
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

  // Fetch weather
  var originEl = document.getElementById('brief-origin');
  var destEl = document.getElementById('brief-dest');
  if (originEl && originEl.value) _briefFetchWx('owx', originEl.value);
  if (destEl && destEl.value) _briefFetchWx('dwx', destEl.value);
}

/* ── 外站出發資訊查詢（出發時間 + Gate，FR24 + FA 雙查）── */
function _briefFetchOriginInfo(fno, dateStr, dtEl, originIata) {
  var done = false;
  var pending = 2;  // FR24 + FA

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
      if (offset === undefined) offset = 8; // fallback to UTC+8
      var local = new Date(d.getTime() + offset * 3600000);
      var hh = String(local.getUTCHours()).padStart(2, '0');
      var mm = String(local.getUTCMinutes()).padStart(2, '0');
      timeStr = hh + ':' + mm;
      // 日期也更新為出發地日期
      var yyyy = local.getUTCFullYear();
      var mo = String(local.getUTCMonth() + 1).padStart(2, '0');
      var dd = String(local.getUTCDate()).padStart(2, '0');
      depDateStr = yyyy + '/' + mo + '/' + dd;
    }
    var display = timeStr ? timeStr + ' Local' : '';
    if (gate && originIata !== 'TPE') display += (display ? ' / Gate ' : 'Gate ') + gate;
    dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + depDateStr + '</div>' +
      '<div style="font-size:1.1em;font-weight:700">' + (display || '—') + '</div>';
  }

  function fallback() {
    // 兩個來源都沒資料，顯示 —
    dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + dateStr + '</div>' +
      '<div style="font-size:1.1em;font-weight:700">—</div>';
  }

  // FR24
  fetch('/api/fids-fr24')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.flights) { tryUpdate(null); return; }
      tryUpdate(data.flights[fno] || null);
    })
    .catch(function() { tryUpdate(null); });
  // FA
  fetch('/api/fids-fa?airline=JX')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.flights) { tryUpdate(null); return; }
      tryUpdate(data.flights[fno] || null);
    })
    .catch(function() { tryUpdate(null); });
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

  fetch('/api/metar?ids=' + icao + '&hours=6')
    .then(function(r) { return r.ok ? r.text() : Promise.reject(); })
    .then(function(text) {
      var lines = text.trim().split('\n').filter(function(l) { return l.trim(); });
      if (lines.length === 0) { el.innerHTML = '<span style="color:var(--muted)">無資料</span>'; return; }
      var raw = lines[0].replace(/^(METAR|SPECI)\s+/, '').trim();
      var m = parseMetarLine(raw);
      var cat = wxCalcCat(m);
      var name = _briefGetName(icao);
      var mins = wxMinsAgo(m);
      var ageClass = mins > 90 ? 'color:#ef4444' : mins > 60 ? 'color:#f59e0b' : 'color:var(--muted)';
      var ageText = mins !== null ? (mins > 90 ? 'expired' : mins + 'm') : '';
      var skyText = _briefFmtSky(m);
      el.innerHTML =
        '<div style="text-align:left;font-size:.78em;line-height:1.6">' +
        '<div><span class="wx-cat cat-' + cat + '" style="font-size:.7em;padding:1px 5px">' + cat + '</span> ' +
        '<b>' + icao + '</b>' + (name ? ' ' + name : '') + '</div>' +
        '<div style="color:var(--muted)">' + wxFmtWind(m) + ' &middot; ' + wxFmtVis(m) + ' &middot; ' + wxFmtTemp(m) +
        (skyText ? ' &middot; ' + skyText : '') +
        (ageText ? ' <span style="font-size:.85em;' + ageClass + '">' + ageText + '</span>' : '') +
        '</div></div>';
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
  if (dtEl) dtEl.innerHTML = '—';
  var owx = document.getElementById('brief-owx');
  if (owx) owx.innerHTML = '—';
  var dwx = document.getElementById('brief-dwx');
  if (dwx) dwx.innerHTML = '—';
  _briefSave();
}

function briefClearNotes() {
  _briefNotes.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
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
      if (el) el.value = obj[id] || '';
    });
  } catch(e) {}
}
