// ── Gate Info ──────────────────────────────────────────────────────────────────
var gateFlightsLoaded = false;
var gateFlightsList = [];
var giSortKey = 'fno';
var giSortAsc = true;

function giFmtTime(t) {
  if (!t) return '';
  return t.replace(/:\d{2}$/, '');
}

function giAirportDisplay(name, code) {
  if (name && code && name !== code) return name + ' ' + code;
  return name || code || '';
}

function _giDate() {
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw.getUTCFullYear() + '/' +
    String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(tw.getUTCDate()).padStart(2, '0');
}

function _giFetchDirect() {
  var ep = atob('aHR0cHM6Ly93d3cudGFveXVhbi1haXJwb3J0LmNvbS9hcGkvYXBpL2ZsaWdodC9hX2ZsaWdodA==');
  var odate = _giDate();
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
  var searchInput = document.getElementById('gate-search');
  var searchTerm = (searchInput && searchInput.value || '').replace(/\s/g, '').replace(/^0+/, '');

  tableBody.innerHTML = '';

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

  pinned.forEach(function(f) {
    tableBody.appendChild(giMakeRow(f));
  });

  if (pinned.length > 0 && others.length > 0) {
    var sep = document.createElement('tr');
    sep.className = 'gi-separator';
    var td = document.createElement('td');
    td.colSpan = 13;
    sep.appendChild(td);
    tableBody.appendChild(sep);
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
      var aTPE = /TPE|桃園/.test(va) ? 0 : 1;
      var bTPE = /TPE|桃園/.test(vb) ? 0 : 1;
      if (aTPE !== bTPE) return giSortAsc ? aTPE - bTPE : bTPE - aTPE;
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

function _giMergeFA(map, faData) {
  _giTestRows = [];
  var flights = faData.flights || {};
  Object.keys(flights).forEach(function(key) {
    var fa = flights[key];
    if (!fa || !fa.fno) return;
    var fno = fa.fno;
    if (!/^JX/.test(fno)) return;
    var m = map[fno];
    if (!m) {
      m = { fno: fno };
      map[fno] = m;
    }
    // Origin is foreign airport → fill departure gate/terminal
    if (fa.origin.iata && fa.origin.iata !== 'TPE') {
      if (!m.gate || m.gate === '—') m.gate = fa.origin.gate || '';
      if (!m.depTerminal) m.depTerminal = fa.origin.terminal || '';
      if (!m.origin) { m.origin = fa.origin.iata; m.originCode = fa.origin.iata; }
    }
    // Destination is foreign airport → fill arrival gate/terminal
    if (fa.destination.iata && fa.destination.iata !== 'TPE') {
      if (!m.parking || m.parking === '—') m.parking = fa.destination.gate || '';
      if (!m.arrTerminal) m.arrTerminal = fa.destination.terminal || '';
      if (!m.dest) { m.dest = fa.destination.iata; m.destCode = fa.destination.iata; }
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

  var tpePromise = fetch('/api/fids')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (data.error) throw new Error(data.error);
      return data;
    })
    .catch(function() {
      return _giFetchDirect();
    });

  var faPromise = fetch('/api/fids-fa')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .catch(function() {
      return { flights: {}, updatedAt: null, count: 0 };
    });

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

function forceRefreshGateFlights() {
  var btn = document.getElementById('gi-force-refresh-btn');
  var statusEl = document.getElementById('gate-status');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '⏳ 抓取中，請稍候...';
  statusEl.textContent = '正在重新抓取外站資料，約需 30-60 秒...';
  statusEl.style.display = 'block';

  fetch('/api/fids-fa/refresh', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      btn.disabled = false;
      btn.textContent = '🔄 重新抓取外站 (約30-60秒)';
      if (data.status === 'already_running') {
        statusEl.textContent = '已有抓取作業進行中，請稍後再試';
        setTimeout(function() { loadGateFlights(); }, 2000);
      } else {
        loadGateFlights();
      }
    })
    .catch(function() {
      btn.disabled = false;
      btn.textContent = '🔄 重新抓取外站 (約30-60秒)';
      statusEl.textContent = '抓取失敗，請稍後再試';
    });
}
