// ── Gate Info ──────────────────────────────────────────────────────────────────
var gateFlightsLoaded = false;
var gateFlightsList = [];
var giSortKey = 'origin';
var giSortAsc = true;
var _giSelectedDate = null; // null = today, 'YYYY/MM/DD' = specific date

function giFmtTime(t) {
  if (!t) return '';
  return t.replace(/:\d{2}$/, '');
}

var _giCityNames = {
  SFO:'舊金山',LAX:'洛杉磯',SEA:'西雅圖',PHX:'鳳凰城',ONT:'安大略',
  NRT:'成田',KIX:'關西',FUK:'福岡',CTS:'札幌',OKA:'沖繩',KMJ:'熊本',
  NGO:'名古屋',SDJ:'仙台',KOJ:'鹿兒島',AOJ:'青森',TAK:'高松',UKB:'神戶',RMQ:'台中',
  ICN:'仁川',PUS:'釜山',
  HKG:'香港',MFM:'澳門',
  SIN:'新加坡',BKK:'曼谷',SGN:'胡志明',HAN:'河內',PNH:'金邊',
  MNL:'馬尼拉',CEB:'宿霧',CGK:'雅加達',DPS:'峇里島',KUL:'吉隆坡',PEN:'檳城',
  PRG:'布拉格',TPE:'桃園'
};

function giAirportDisplay(name, code) {
  var n = name || _giCityNames[code] || '';
  if (n && code && n !== code) return n + ' ' + code;
  return n || code || '';
}

function _giDate() {
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw.getUTCFullYear() + '/' +
    String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(tw.getUTCDate()).padStart(2, '0');
}

function _giFetchDirect(dateOverride) {
  var ep = atob('aHR0cHM6Ly93d3cudGFveXVhbi1haXJwb3J0LmNvbS9hcGkvYXBpL2ZsaWdodC9hX2ZsaWdodA==');
  var odate = dateOverride || _giDate();
  var base = {
    ODate: odate, OTimeOpen: null, OTimeClose: null,
    BNO: null, AState: '', language: 'ch', keyword: ''
  };
  var hdrs = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*'
  };
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

function giMakeRow(f) {
  var tr = document.createElement('tr');

  var originDisplay = giAirportDisplay(f.originName, f.originCode || (f.origin === 'TPE' ? 'TPE' : ''));
  if (!originDisplay && f.origin) originDisplay = f.origin;

  var destDisplay = giAirportDisplay(f.destName, f.destCode || (f.dest === 'TPE' ? 'TPE' : ''));
  if (!destDisplay && f.dest) destDisplay = f.dest;

  var cells = [
    { val: f.fno },
    { val: originDisplay || '—' },
    { val: f.depTerminal || '—' },
    { val: f.checkin || '—' },
    { val: f.gate || '—' },
    { val: f.std || '—' },
    { val: f.atd || '—' },
    { val: destDisplay || '—' },
    { val: f.arrTerminal || '—' },
    { val: f.parking || '—' },
    { val: f.carousel || '—' },
    { val: f.sta || '—' },
    { val: f.ata || '—' }
  ];

  var timeCols = { 5:1, 6:1, 11:1, 12:1 };
  cells.forEach(function(c, idx) {
    var td = document.createElement('td');
    td.textContent = c.val;
    if (idx === 0) td.className = 'gi-fno gi-sticky-col';
    if (timeCols[idx]) td.className = (td.className ? td.className + ' ' : '') + 'gi-time-col';
    tr.appendChild(td);
  });

  return tr;
}

function toggleGiTime() {
  var table = document.getElementById('gi-table');
  var btn = document.getElementById('gi-time-btn');
  if (table.classList.contains('gi-hide-time')) {
    table.classList.remove('gi-hide-time');
    btn.classList.add('gi-time-btn-on');
  } else {
    table.classList.add('gi-hide-time');
    btn.classList.remove('gi-time-btn-on');
  }
}

function giMakeTestRow(f) {
  var tr = document.createElement('tr');
  tr.className = 'gi-test-row';
  var originVal = f.direction === 'A' ? (f.origin || '—') : f.airport;
  var destVal = f.direction === 'A' ? f.airport : (f.dest || '—');
  var depTerminal = f.direction === 'D' ? (f.terminal || '—') : '—';
  var arrTerminal = f.direction === 'A' ? (f.terminal || '—') : '—';
  var parking = f.direction === 'A' ? (f.gate || '—') : '—';
  var gate = f.direction === 'D' ? (f.gate || '—') : '—';
  var cells = [
    { val: '[TEST] ' + f.fno },
    { val: originVal },
    { val: depTerminal },
    { val: '—' },
    { val: gate },
    { val: f.scheduled || '—' },
    { val: '—' },
    { val: destVal },
    { val: arrTerminal },
    { val: parking },
    { val: f.carousel || '—' },
    { val: '—' },
    { val: f.status || '—' }
  ];
  var timeCols = { 5:1, 6:1, 11:1, 12:1 };
  cells.forEach(function(c, idx) {
    var td = document.createElement('td');
    td.textContent = c.val;
    if (timeCols[idx]) td.className = 'gi-time-col';
    tr.appendChild(td);
  });
  return tr;
}

function renderGateFlights() {
  var tableBody = document.getElementById('gate-tbody');
  var thead = document.querySelector('#gi-table thead');
  var searchInput = document.getElementById('gate-search');
  var searchTerm = (searchInput && searchInput.value || '').replace(/\s/g, '').replace(/^0+/, '');

  tableBody.innerHTML = '';
  // Remove old pinned rows from thead
  thead.querySelectorAll('.gi-pinned-row, .gi-pinned-sep').forEach(function(el) { el.remove(); });

  // Show test rows at top
  if (_giTestRows.length > 0) {
    var testHeader = document.createElement('tr');
    testHeader.className = 'gi-test-header';
    var th = document.createElement('td');
    th.colSpan = 13;
    th.textContent = '⚠ 以下為測試資料（驗證各機場資料來源）';
    testHeader.appendChild(th);
    tableBody.appendChild(testHeader);
    _giTestRows.forEach(function(f) {
      tableBody.appendChild(giMakeTestRow(f));
    });
    var sep0 = document.createElement('tr');
    sep0.className = 'gi-separator';
    var td0 = document.createElement('td');
    td0.colSpan = 13;
    sep0.appendChild(td0);
    tableBody.appendChild(sep0);
  }

  var pinned = [];
  var others = [];

  var sorted = _giSortList(gateFlightsList);

  if (searchTerm) {
    sorted.forEach(function(f) {
      var num = f.fno.replace(/^JX/, '');
      if (num === searchTerm || num.indexOf(searchTerm) === 0) {
        pinned.push(f);
      } else {
        others.push(f);
      }
    });
  } else {
    others = sorted;
  }

  // Pinned rows go into thead (sticky with header)
  if (pinned.length > 0) {
    pinned.forEach(function(f) {
      var tr = giMakeRow(f);
      tr.classList.add('gi-pinned-row');
      thead.appendChild(tr);
    });
    var sep = document.createElement('tr');
    sep.className = 'gi-pinned-sep';
    var td = document.createElement('td');
    td.colSpan = 13;
    sep.appendChild(td);
    thead.appendChild(sep);
  }

  others.forEach(function(f) {
    tableBody.appendChild(giMakeRow(f));
  });
}

function _giGetSortVal(f, key) {
  if (key === 'fno') return f.fno || '';
  if (key === 'origin') return (f.originName || f.originCode || f.origin || '');
  if (key === 'dest') return (f.destName || f.destCode || f.dest || '');
  return '';
}

function _giSortList(list) {
  var sorted = list.slice();
  sorted.sort(function(a, b) {
    var va = _giGetSortVal(a, giSortKey);
    var vb = _giGetSortVal(b, giSortKey);
    if (giSortKey === 'origin' || giSortKey === 'dest') {
      var twAirports = /TPE|桃園/;
      var twOther = /RMQ|台中|KHH|高雄|TSA|松山/;
      var aRank = twAirports.test(va) ? 0 : twOther.test(va) ? 1 : 2;
      var bRank = twAirports.test(vb) ? 0 : twOther.test(vb) ? 1 : 2;
      if (aRank !== bRank) return giSortAsc ? aRank - bRank : bRank - aRank;
    }
    if (giSortKey === 'fno') {
      var cmp = va.localeCompare(vb, undefined, { numeric: true });
      return giSortAsc ? cmp : -cmp;
    }
    var cmp2 = va.localeCompare(vb);
    return giSortAsc ? cmp2 : -cmp2;
  });
  return sorted;
}

function giSort(key) {
  if (giSortKey === key) {
    giSortAsc = !giSortAsc;
  } else {
    giSortKey = key;
    giSortAsc = true;
  }
  // Update header indicators
  var ths = document.querySelectorAll('#gi-table thead th.gi-sortable');
  ths.forEach(function(th) {
    th.classList.remove('gi-sort-asc', 'gi-sort-desc');
  });
  var labels = { fno: 0, origin: 1, dest: 2 };
  var idx = labels[key];
  if (idx !== undefined && ths[idx]) {
    ths[idx].classList.add(giSortAsc ? 'gi-sort-asc' : 'gi-sort-desc');
  }
  renderGateFlights();
}

function filterGateFlights() {
  if (gateFlightsList.length > 0) renderGateFlights();
}

var _giTestRows = [];

function _giFaTime(isoStr) {
  if (!isoStr) return '';
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  // Convert to Taiwan time (UTC+8)
  var tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return String(tw.getUTCHours()).padStart(2, '0') + ':' + String(tw.getUTCMinutes()).padStart(2, '0');
}

function _giMergeFA(map, faData) {
  _giTestRows = [];
  var flights = faData.flights || {};
  Object.keys(flights).forEach(function(key) {
    var fa = flights[key];
    if (!fa || !fa.fno) return;
    var fno = fa.fno;
    if (!/^JX/.test(fno)) return;
    var isNew = !map[fno];
    var m = map[fno];
    if (!m) {
      m = { fno: fno };
      map[fno] = m;
    }

    // New flight not in TPE FIDS → fill all fields from FA
    if (isNew) {
      var oIata = (fa.origin && fa.origin.iata) || '';
      var dIata = (fa.destination && fa.destination.iata) || '';
      m.origin = oIata;
      m.originCode = oIata;
      m.originName = _giCityNames[oIata] || '';
      m.dest = dIata;
      m.destCode = dIata;
      m.destName = _giCityNames[dIata] || '';
      m.gate = (fa.origin && fa.origin.gate) || '';
      m.depTerminal = (fa.origin && fa.origin.terminal) || '';
      m.parking = (fa.destination && fa.destination.gate) || '';
      m.arrTerminal = (fa.destination && fa.destination.terminal) || '';
      m.std = _giFaTime(fa.scheduledDep);
      m.atd = _giFaTime(fa.actualDep);
      m.sta = _giFaTime(fa.scheduledArr);
      m.ata = _giFaTime(fa.actualArr);
    } else {
      // Existing flight from TPE FIDS → only supplement non-TPE gate/terminal
      if (fa.origin && fa.origin.iata && fa.origin.iata !== 'TPE') {
        if (!m.gate || m.gate === '—') m.gate = fa.origin.gate || '';
        if (!m.depTerminal) m.depTerminal = fa.origin.terminal || '';
      }
      if (fa.destination && fa.destination.iata && fa.destination.iata !== 'TPE') {
        if (!m.parking || m.parking === '—') m.parking = fa.destination.gate || '';
        if (!m.arrTerminal) m.arrTerminal = fa.destination.terminal || '';
      }
    }
  });
}

function loadGateFlights() {
  var statusEl = document.getElementById('gate-status');
  var tableBody = document.getElementById('gate-tbody');
  var dateEl = document.getElementById('gate-date');
  var wrapEl = document.getElementById('gate-table-wrap');

  statusEl.textContent = '載入中...';
  statusEl.style.display = 'block';
  wrapEl.style.display = 'none';
  tableBody.innerHTML = '';
  gateFlightsList = [];

  var isToday = !_giSelectedDate;
  var fidsUrl = isToday ? '/api/fids' : '/api/fids?date=' + encodeURIComponent(_giSelectedDate);

  var tpePromise = fetch(fidsUrl)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (data.error) throw new Error(data.error);
      return data;
    })
    .catch(function() {
      return _giFetchDirect(_giSelectedDate);
    });

  var faPromise = isToday
    ? fetch('/api/fids-fa')
        .then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .catch(function() {
          return { flights: {}, updatedAt: null, count: 0 };
        })
    : Promise.resolve({ flights: {}, updatedAt: null, count: 0 });

  Promise.all([tpePromise, faPromise])
    .then(function(results) {
      var data = results[0];
      var faData = results[1];

      return { data: data, faData: faData };
    })
    .then(function(r) {
      var data = r.data;
      var faData = r.faData;

      dateEl.textContent = data.date || '';

      var dep = (data.dep || []).filter(function(f) { return f.ACode && f.ACode.trim() === 'JX'; });
      var arr = (data.arr || []).filter(function(f) { return f.ACode && f.ACode.trim() === 'JX'; });

      var map = {};

      dep.forEach(function(f) {
        var key = 'JX' + f.FlightNo.replace(/\s/g, '');
        if (!map[key]) map[key] = { fno: key };
        var m = map[key];
        m.origin = 'TPE';
        m.originCode = 'TPE';
        m.originName = '桃園';
        m.dest = f.CityCode || '';
        m.destCode = f.CityCode || '';
        m.destName = f.CityName || f.CityCode || '';
        m.checkin = f.CheckIn || '';
        m.gate = f.Gate || '';
        m.std = giFmtTime(f.OTime);
        m.atd = giFmtTime(f.RTime);
        m.depTerminal = f.BNO ? 'T' + f.BNO : '';
        m.depMemo = f.Memo || '';
      });

      arr.forEach(function(f) {
        var key = 'JX' + f.FlightNo.replace(/\s/g, '');
        if (!map[key]) map[key] = { fno: key };
        var m = map[key];
        m.originCode = f.CityCode || '';
        m.originName = f.CityName || f.CityCode || '';
        if (!m.origin) m.origin = f.CityCode || '';
        if (!m.dest) m.dest = 'TPE';
        if (!m.destCode) m.destCode = 'TPE';
        if (!m.destName) m.destName = '桃園';
        m.parking = f.Gate || '';
        m.carousel = f.StopCode || '';
        m.sta = giFmtTime(f.OTime);
        m.ata = giFmtTime(f.RTime);
        m.arrTerminal = f.BNO ? 'T' + f.BNO : '';
        m.arrMemo = f.Memo || '';
      });

      // Merge foreign airport data from background cache
      _giMergeFA(map, faData);

      var flights = Object.values(map);
      flights.sort(function(a, b) {
        return a.fno.localeCompare(b.fno, undefined, { numeric: true });
      });

      if (flights.length === 0) {
        statusEl.textContent = '今日無 JX 航班資料';
        return;
      }

      gateFlightsList = flights;
      statusEl.style.display = 'none';
      wrapEl.style.display = '';
      renderGateFlights();
      gateFlightsLoaded = true;
    })
    .catch(function(e) {
      statusEl.textContent = '載入失敗：' + e.message;
      statusEl.style.display = 'block';
    });
}

function refreshGateFlights() {
  loadGateFlights();
}

function _giTodayStr() {
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw.getUTCFullYear() + '/' +
    String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(tw.getUTCDate()).padStart(2, '0');
}

function _giShiftDate(dateStr, days) {
  var parts = dateStr.split('/');
  var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '/' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(d.getUTCDate()).padStart(2, '0');
}

function _giUpdateDateNav() {
  var today = _giTodayStr();
  var current = _giSelectedDate || today;
  var prevBtn = document.getElementById('gi-prev-day');
  var nextBtn = document.getElementById('gi-next-day');
  var todayBtn = document.getElementById('gi-today-btn');
  var tomorrow = _giShiftDate(today, 1);
  var yesterday = _giShiftDate(today, -1);
  if (prevBtn) prevBtn.disabled = (current <= yesterday);
  if (nextBtn) nextBtn.disabled = (current >= tomorrow);
  if (todayBtn) todayBtn.style.display = (current === today) ? 'none' : '';
}

function giPrevDay() {
  var today = _giTodayStr();
  var current = _giSelectedDate || today;
  var prev = _giShiftDate(current, -1);
  var yesterday = _giShiftDate(today, -1);
  if (prev < yesterday) return;
  _giSelectedDate = (prev === today) ? null : prev;
  _giUpdateDateNav();
  loadGateFlights();
}

function giNextDay() {
  var today = _giTodayStr();
  var current = _giSelectedDate || today;
  var next = _giShiftDate(current, 1);
  var tomorrow = _giShiftDate(today, 1);
  if (next > tomorrow) return;
  _giSelectedDate = (next === today) ? null : next;
  _giUpdateDateNav();
  loadGateFlights();
}

function giToday() {
  _giSelectedDate = null;
  _giUpdateDateNav();
  loadGateFlights();
}

