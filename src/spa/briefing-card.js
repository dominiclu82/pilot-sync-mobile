// ── 📋 提示卡 (Flight Briefing Card) ─────────────────────────────────────────
var _briefLoaded = false;

var _briefFields = ['brief-dep-date','brief-etd','brief-arr-date','brief-eta',
  'brief-reg','brief-gate','brief-ofp','brief-ft'];
var _briefNotes = ['brief-note1','brief-note2','brief-note3'];

function briefInit() {
  if (_briefLoaded) return;
  _briefLoaded = true;
  _briefRestore();
  // auto-save on input
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
  if (!raw) {
    _briefFltStatus('', '');
    return;
  }
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
      // fallback: direct fetch
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
  // extract pure number for comparison (e.g. "JX2" → "2")
  var num = fno.replace(/^JX/i, '').replace(/^0+/, '') || '0';

  // find matching departure (JX only, compare numeric part)
  var depFlight = null;
  for (var i = 0; i < depList.length; i++) {
    var d = depList[i];
    if (!d.ACode || d.ACode.trim() !== 'JX') continue;
    var dNum = (d.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (dNum === num) { depFlight = d; break; }
  }

  // find matching arrival
  var arrFlight = null;
  for (var j = 0; j < arrList.length; j++) {
    var a = arrList[j];
    if (!a.ACode || a.ACode.trim() !== 'JX') continue;
    var aNum = (a.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (aNum === num) { arrFlight = a; break; }
  }

  if (!depFlight && !arrFlight) { _briefFltStatus('查無此航班', 'err'); return; }
  _briefFltStatus('✓', 'ok');

  // format date: "2026/03/04" → "03/04" or keep as-is
  var depDate = dateStr || '';

  // fill fields
  if (depFlight) {
    _briefSet('brief-dep-date', depDate);
    _briefSet('brief-etd', _briefFmtTime(depFlight.OTime));
    _briefSet('brief-gate', depFlight.Gate || '');
  }

  if (arrFlight) {
    _briefSet('brief-arr-date', depDate); // same date by default
    _briefSet('brief-eta', _briefFmtTime(arrFlight.OTime));
  }

  _briefSave();
}

function _briefFmtTime(t) {
  if (!t) return '';
  // "HH:MM:SS" → "HH:MM" or "HH:MM" → "HH:MM"
  return t.replace(/:\d{2}$/, '');
}

function _briefSet(id, val) {
  var el = document.getElementById(id);
  if (el) el.value = val;
}

/* ── 清除 ── */
function briefClearInfo() {
  _briefFields.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
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
