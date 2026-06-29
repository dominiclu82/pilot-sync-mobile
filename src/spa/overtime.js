// ── ⏱️ Overtime Calculator ─────────────────────────────────────────────────
// Magic Number = Actual Block-Out + Schedule Flight Time + 30 min

var _otYear = 0;
var _otMonth = 0;
var _otMonNames = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
var _otMonLabels = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _otInit() {
  var now = new Date();
  _otYear = now.getFullYear();
  _otMonth = now.getMonth() + 1;
  _otLoadCache();
  _otLoadFlights();
}

/* ── 月份切換 ── */
function _otPrevMonth() {
  _otMonth--;
  if (_otMonth < 1) { _otMonth = 12; _otYear--; }
  _otUpdateMonthTitle();
  _otLoadFlights();
}
function _otNextMonth() {
  _otMonth++;
  if (_otMonth > 12) { _otMonth = 1; _otYear++; }
  _otUpdateMonthTitle();
  _otLoadFlights();
}
function _otUpdateMonthTitle() {
  var el = document.getElementById('ot-month-title');
  if (el) el.textContent = _otMonLabels[_otMonth] + ' ' + _otYear;
}

/* ── 載入航班（掃描當月 + 前後月 roster，抓出屬於當月的航班）── */
function _otLoadFlights() {
  _otUpdateMonthTitle();
  var eid = localStorage.getItem('crewsync_eid') || '';
  var sel = document.getElementById('ot-flight-select');
  var noRoster = document.getElementById('ot-no-roster');
  if (!sel) return;

  if (!eid) {
    sel.innerHTML = '<option value="">選擇航班 Select flight</option>';
    if (noRoster) noRoster.style.display = '';
    return;
  }

  // 掃描當月 + 前後月
  var months = [];
  var pm = _otMonth - 1, py = _otYear;
  if (pm < 1) { pm = 12; py--; }
  var nm = _otMonth + 1, ny = _otYear;
  if (nm > 12) { nm = 1; ny++; }
  months.push(py + '-' + String(pm).padStart(2, '0'));
  months.push(_otYear + '-' + String(_otMonth).padStart(2, '0'));
  months.push(ny + '-' + String(nm).padStart(2, '0'));

  var allFlights = [];
  for (var mi = 0; mi < months.length; mi++) {
    var key = 'crewsync_roster_' + eid + '_' + months[mi];
    var raw = localStorage.getItem(key);
    if (!raw) continue;
    var data;
    try { data = JSON.parse(raw); } catch(e) { continue; }
    var duties = data.duties || [];
    for (var i = 0; i < duties.length; i++) {
      var duty = duties[i];
      if (!duty.flights || duty.flights.length === 0) continue;
      for (var f = 0; f < duty.flights.length; f++) {
        var fl = duty.flights[f];
        if (!fl.flightNo || fl.flightNo.indexOf('JX') < 0) continue;
        var parsed = _otParseDateFromFlight(fl, duty);
        // 只顯示屬於選定月份的航班
        if (parsed.mon === _otMonth) {
          allFlights.push({ fl: fl, day: parsed.mon + '/' + parsed.dayNum, dayNum: parsed.dayNum });
        }
      }
    }
  }

  // 去重（同一航班號+同一天只留一筆）
  var seen = {};
  var unique = [];
  for (var u = 0; u < allFlights.length; u++) {
    var uKey = allFlights[u].fl.flightNo + '_' + allFlights[u].dayNum;
    if (!seen[uKey]) { seen[uKey] = true; unique.push(allFlights[u]); }
  }
  allFlights = unique;

  // 依日期排序
  allFlights.sort(function(a, b) { return a.dayNum - b.dayNum; });

  sel.innerHTML = '<option value="">選擇航班 Select flight</option>';
  for (var j = 0; j < allFlights.length; j++) {
    var tf = allFlights[j].fl;
    var label = allFlights[j].day + '  ' + tf.flightNo + ' ' + (tf.origin || '') + '-' + (tf.dest || '');
    var opt = document.createElement('option');
    opt.value = j;
    opt.textContent = label;
    opt.dataset.flight = JSON.stringify(tf);
    sel.appendChild(opt);
  }

  if (noRoster) noRoster.style.display = allFlights.length > 0 ? 'none' : '';
}

/* ── 從航班資料解析日期 ── */
function _otParseDateFromFlight(fl, duty) {
  // 優先 depTime local，fallback depTimeUtc
  var dateMatch = (fl.depTime || '').match(/\/(\d{1,2})([A-Za-z]{3})/);
  if (!dateMatch) dateMatch = (fl.depTimeUtc || '').match(/\/(\d{1,2})([A-Za-z]{3})/);
  if (dateMatch) {
    var dayNum = parseInt(dateMatch[1]);
    var mon = _otMonNames[dateMatch[2].charAt(0).toUpperCase() + dateMatch[2].slice(1).toLowerCase()] || 0;
    return { dayNum: dayNum, mon: mon };
  }
  if (fl.date) {
    var parts = fl.date.split('-');
    if (parts.length === 3) return { dayNum: parseInt(parts[2]), mon: parseInt(parts[1]) };
  }
  return { dayNum: 0, mon: 0 };
}

/* ── 選擇航班後帶入資訊 ── */
function _otSelectFlight(sel) {
  if (!sel.value) return;
  var opt = sel.options[sel.selectedIndex];
  var fl;
  try { fl = JSON.parse(opt.dataset.flight); } catch(e) { return; }

  document.getElementById('ot-origin').value = fl.origin || '';
  document.getElementById('ot-dest').value = fl.dest || '';

  var depLocal = _otParseTimeStr(fl.depTime);
  var arrLocal = _otParseTimeStr(fl.arrTime);
  var depUtc = fl.depTimeUtc ? _otParseTimeStr(fl.depTimeUtc) : '';
  var arrUtc = fl.arrTimeUtc ? _otParseTimeStr(fl.arrTimeUtc) : '';

  if (depUtc && arrUtc) {
    document.getElementById('ot-sched-out').value = depUtc;
    document.getElementById('ot-sched-in').value = arrUtc;
  } else {
    var origin = (fl.origin || '').toUpperCase();
    var dest = (fl.dest || '').toUpperCase();
    var depOffset = _otGetTzOffset(origin);
    var arrOffset = _otGetTzOffset(dest);
    if (depLocal && depOffset !== null) {
      document.getElementById('ot-sched-out').value = _otLocalToUtc(depLocal, depOffset);
    } else if (depLocal) {
      document.getElementById('ot-sched-out').value = depLocal;
    }
    if (arrLocal && arrOffset !== null) {
      document.getElementById('ot-sched-in').value = _otLocalToUtc(arrLocal, arrOffset);
    } else if (arrLocal) {
      document.getElementById('ot-sched-in').value = arrLocal;
    }
  }

  _otCalcScheduleFT();
}

/* ── 解析時間字串 → "HH:MM" ── */
function _otParseTimeStr(str) {
  if (!str) return '';
  str = str.trim();
  var tzMatch = str.match(/^(\d{4})[ZLzl]/);
  if (tzMatch) {
    var s = tzMatch[1];
    return s.substring(0, 2) + ':' + s.substring(2, 4);
  }
  str = str.replace(/[LZlz]$/i, '').trim();
  var spaceIdx = str.lastIndexOf(' ');
  if (spaceIdx >= 0) str = str.substring(spaceIdx + 1);
  if (/^\d{1,2}:\d{2}$/.test(str)) return str.padStart(5, '0');
  if (/^\d{3,4}$/.test(str)) {
    var s2 = str.padStart(4, '0');
    return s2.substring(0, 2) + ':' + s2.substring(2, 4);
  }
  return str;
}

/* ── 取得機場 UTC offset（DST-aware）── */
function _otGetTzOffset(iata) {
  if (typeof _tzDstOffset !== 'undefined') {
    var off = _tzDstOffset(iata, new Date());
    if (off !== null) return off;
  }
  if (typeof _briefTzOffset !== 'undefined' && _briefTzOffset[iata] !== undefined) {
    return _briefTzOffset[iata];
  }
  return null;
}

/* ── Local time → UTC (HH:MM) ── */
function _otLocalToUtc(timeStr, offsetHours) {
  var parts = timeStr.split(':');
  if (parts.length !== 2) return timeStr;
  var h = parseInt(parts[0]);
  var m = parseInt(parts[1]);
  var totalMin = h * 60 + m - offsetHours * 60;
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  return String(Math.floor(totalMin / 60)).padStart(2, '0') + ':' + String(totalMin % 60).padStart(2, '0');
}

/* ── UTC time → Local (HH:MM) ── */
function _otUtcToLocal(timeStr, offsetHours) {
  var parts = timeStr.split(':');
  if (parts.length !== 2) return timeStr;
  var h = parseInt(parts[0]);
  var m = parseInt(parts[1]);
  var totalMin = h * 60 + m + offsetHours * 60;
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  return String(Math.floor(totalMin / 60)).padStart(2, '0') + ':' + String(totalMin % 60).padStart(2, '0');
}

/* ── 計算 Schedule Flight Time ── */
function _otCalcScheduleFT() {
  var outStr = document.getElementById('ot-sched-out').value;
  var inStr = document.getElementById('ot-sched-in').value;
  var ftEl = document.getElementById('ot-sched-ft');
  if (!outStr || !inStr) { ftEl.textContent = '—'; return; }

  var outMin = _otTimeToMin(outStr);
  var inMin = _otTimeToMin(inStr);
  if (outMin < 0 || inMin < 0) { ftEl.textContent = '—'; return; }

  var diff = (inMin - outMin + 1440) % 1440;
  var hh = Math.floor(diff / 60);
  var mm = diff % 60;
  ftEl.textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');

  _otCalcMagic();
}

/* ── 計算 Magic Number ── */
function _otCalcMagic() {
  var outStr = document.getElementById('ot-sched-out').value;
  var inStr = document.getElementById('ot-sched-in').value;
  var actOutStr = document.getElementById('ot-actual-out').value;
  var resultEl = document.getElementById('ot-result');
  var magicEl = document.getElementById('ot-magic');
  var magicLocalEl = document.getElementById('ot-magic-local');

  if (!outStr || !inStr || !actOutStr) {
    resultEl.style.display = 'none';
    return;
  }

  var schedOut = _otTimeToMin(outStr);
  var schedIn = _otTimeToMin(inStr);
  var actOut = _otTimeToMin(actOutStr);
  if (schedOut < 0 || schedIn < 0 || actOut < 0) {
    resultEl.style.display = 'none';
    return;
  }

  var schedFT = (schedIn - schedOut + 1440) % 1440;
  var magicMin = (actOut + schedFT + 30) % 1440;
  var magicH = Math.floor(magicMin / 60);
  var magicM = magicMin % 60;
  var magicStr = String(magicH).padStart(2, '0') + ':' + String(magicM).padStart(2, '0');

  magicEl.textContent = magicStr + ' UTC';

  var dest = (document.getElementById('ot-dest').value || '').toUpperCase();
  var destOffset = _otGetTzOffset(dest);
  if (destOffset !== null) {
    var localStr = _otUtcToLocal(magicStr, destOffset);
    magicLocalEl.textContent = localStr + ' Local';
    magicLocalEl.style.display = '';
  } else {
    magicLocalEl.style.display = 'none';
  }

  resultEl.style.display = '';
  _otSaveCache();
}

/* ── helpers ── */
function _otTimeToMin(str) {
  if (!str) return -1;
  str = str.trim();
  var parts = str.split(':');
  if (parts.length === 2) {
    var h = parseInt(parts[0]);
    var m = parseInt(parts[1]);
    if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return -1;
    return h * 60 + m;
  }
  if (/^\d{4}$/.test(str)) {
    var hh = parseInt(str.substring(0, 2));
    var mm = parseInt(str.substring(2, 4));
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return -1;
    return hh * 60 + mm;
  }
  return -1;
}

/* ── 快取 24hr ── */
function _otSaveCache() {
  try {
    var obj = {
      ts: Date.now(),
      origin: document.getElementById('ot-origin').value,
      dest: document.getElementById('ot-dest').value,
      schedOut: document.getElementById('ot-sched-out').value,
      schedIn: document.getElementById('ot-sched-in').value,
      actualOut: document.getElementById('ot-actual-out').value
    };
    localStorage.setItem('crewsync_overtime', JSON.stringify(obj));
  } catch(e) {}
}

function _otLoadCache() {
  try {
    var raw = localStorage.getItem('crewsync_overtime');
    if (!raw) return;
    var obj = JSON.parse(raw);
    if (obj.ts && Date.now() - obj.ts > 24 * 60 * 60 * 1000) {
      localStorage.removeItem('crewsync_overtime');
      return;
    }
    if (obj.origin) document.getElementById('ot-origin').value = obj.origin;
    if (obj.dest) document.getElementById('ot-dest').value = obj.dest;
    if (obj.schedOut) document.getElementById('ot-sched-out').value = obj.schedOut;
    if (obj.schedIn) document.getElementById('ot-sched-in').value = obj.schedIn;
    if (obj.actualOut) document.getElementById('ot-actual-out').value = obj.actualOut;
    _otCalcScheduleFT();
  } catch(e) {}
}

function _otReset() {
  document.getElementById('ot-origin').value = '';
  document.getElementById('ot-dest').value = '';
  document.getElementById('ot-sched-out').value = '';
  document.getElementById('ot-sched-in').value = '';
  document.getElementById('ot-actual-out').value = '';
  document.getElementById('ot-sched-ft').textContent = '—';
  document.getElementById('ot-result').style.display = 'none';
  var sel = document.getElementById('ot-flight-select');
  if (sel) sel.value = '';
  localStorage.removeItem('crewsync_overtime');
}

// 頁面載入時初始化
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(_otInit, 600);
});
