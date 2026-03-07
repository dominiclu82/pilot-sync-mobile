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
}

/* ── debounce 自動查詢 ── */
var _briefFltTimer = null;
var _briefFidsCache = null;

function _briefOnInput(val) {
  if (_briefFltTimer) clearTimeout(_briefFltTimer);
  var raw = val.trim().toUpperCase();
  if (!raw) { _briefFltStatus('', ''); return; }
  var num = raw.replace(/^SJX|^JX/, '').replace(/\s/g, '').replace(/^0+/, '') || '0';
  if (!/^\d+$/.test(num)) { _briefFltStatus('', ''); return; }
  _briefFltStatus('查詢中...', 'loading');
  _briefFltTimer = setTimeout(function() { _briefLookup(num); }, 500);
}

function _briefLookup(num) {
  var fno = 'JX' + num;
  var inp = document.getElementById('brief-fno');
  if (inp) inp.value = fno;

  if (_briefFidsCache) {
    _briefFillFromFids(fno, _briefFidsCache);
    return;
  }

  fetch('/api/fids')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (!data || data.error) throw new Error('no data');
      _briefFidsCache = data;
      _briefFillFromFids(fno, data);
    })
    .catch(function() {
      _briefFetchDirect().then(function(data) {
        _briefFidsCache = data;
        _briefFillFromFids(fno, data);
      }).catch(function() { _briefFltStatus('查詢失敗', 'err'); });
    });
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
    if (dNum === num) { depFlight = d; break; }
  }

  var arrFlight = null;
  for (var j = 0; j < arrList.length; j++) {
    var a = arrList[j];
    if (!a.ACode || a.ACode.trim() !== 'JX') continue;
    var aNum = (a.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (aNum === num) { arrFlight = a; break; }
  }

  if (!depFlight && !arrFlight) { _briefFltStatus('查無此航班', 'err'); return; }
  _briefFltStatus('✓', 'ok');

  // Dep Date/Time
  var dtEl = document.getElementById('brief-dep-dt');
  if (dtEl) {
    if (depFlight) {
      var time = _briefFmtTime(depFlight.OTime);
      dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + dateStr + '</div>' +
        '<div style="font-size:1.1em;font-weight:700">' + time + ' Local</div>';
    } else if (arrFlight) {
      var atime = _briefFmtTime(arrFlight.OTime);
      dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + dateStr + '</div>' +
        '<div style="font-size:1.1em;font-weight:700">' + atime + ' Local</div>' +
        '<div style="font-size:.7em;color:var(--muted)">(STA)</div>';
    }
  }

  // Gate
  if (depFlight && depFlight.Gate) {
    _briefSet('brief-gate', depFlight.Gate);
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

  fetch('/api/metar?ids=' + icao + '&hours=1')
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
