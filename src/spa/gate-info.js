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
  var dir = f.direction === 'A' ? 'Arr' : 'Dep';
  var cells = [
    { val: '[TEST] ' + f.airport },
    { val: f.fno },
    { val: '' },
    { val: '' },
    { val: f.gate || '—' },
    { val: f.scheduled || '—' },
    { val: '' },
    { val: f.origin || '—' },
    { val: f.terminal || '—' },
    { val: '' },
    { val: f.carousel || '—' },
    { val: '' },
    { val: dir + ': ' + (f.status || '—') }
  ];
  cells.forEach(function(c) {
    var td = document.createElement('td');
    td.textContent = c.val;
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

function _giFetchONTDirect() {
  var base = atob('aHR0cHM6Ly93d3cuZmx5b250YXJpby5jb20vYXBpL2pzb24vZmxpZ2h0cw==');
  return Promise.all([
    fetch(base + '/arrivals', { headers: { 'Accept': 'application/json' } }),
    fetch(base + '/departures', { headers: { 'Accept': 'application/json' } })
  ]).then(function(res) {
    return Promise.all([
      res[0].ok ? res[0].json() : [],
      res[1].ok ? res[1].json() : []
    ]);
  }).then(function(data) {
    var results = [];
    var arrData = Array.isArray(data[0]) ? data[0] : (data[0].data || data[0].flights || []);
    var depData = Array.isArray(data[1]) ? data[1] : (data[1].data || data[1].flights || []);
    arrData.forEach(function(f) {
      var fno = (f.flightno || '').replace(/\s/g, '').toUpperCase();
      if (!fno.startsWith('JX') && !/STARLUX/i.test(f.airline_name || '')) return;
      results.push({
        airport: 'ONT', fno: fno, direction: 'A',
        gate: f.gate || '', terminal: f.terminal || '', carousel: '',
        origin: f.origin || '', dest: 'ONT'
      });
    });
    depData.forEach(function(f) {
      var fno = (f.flightno || '').replace(/\s/g, '').toUpperCase();
      if (!fno.startsWith('JX') && !/STARLUX/i.test(f.airline_name || '')) return;
      results.push({
        airport: 'ONT', fno: fno, direction: 'D',
        gate: f.gate || '', terminal: f.terminal || '', carousel: '',
        origin: 'ONT', dest: f.origin || ''
      });
    });
    return results;
  }).catch(function() { return []; });
}

var _giTestRows = [];

function _giMergeUS(map, usData) {
  _giTestRows = [];
  var allFlights = [].concat(
    usData.sfo || [], usData.phx || [], usData.sea || [], usData.lax || [],
    usData.ont || []
  );
  allFlights.forEach(function(f) {
    var key = f.fno;
    if (!key) return;
    if (f._test) {
      _giTestRows.push(f);
      return;
    }
    if (!map[key]) map[key] = { fno: key };
    var m = map[key];
    if (f.direction === 'D') {
      if (!m.gate || m.gate === '—') m.gate = f.gate || m.gate;
      if (!m.depTerminal) m.depTerminal = f.terminal || '';
      if (!m.origin) m.origin = f.airport;
      if (!m.originCode) m.originCode = f.airport;
    } else {
      if (!m.parking) m.parking = f.gate || '';
      if (!m.carousel) m.carousel = f.carousel || '';
      if (!m.arrTerminal) m.arrTerminal = f.terminal || '';
      if (!m.dest && f.airport) { m.dest = f.airport; m.destCode = f.airport; }
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

  var usPromise = fetch('/api/fids-us')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .catch(function() {
      return { sfo: [], phx: [], sea: [], lax: [], ont: [] };
    });

  Promise.all([tpePromise, usPromise])
    .then(function(results) {
      var data = results[0];
      var usData = results[1];

      // ONT client-side fallback if server returned empty
      var ontFallback = (!usData.ont || usData.ont.length === 0)
        ? _giFetchONTDirect() : Promise.resolve(null);
      return ontFallback.then(function(ontDirect) {
        if (ontDirect && ontDirect.length > 0) usData.ont = ontDirect;
        return { data: data, usData: usData };
      });
    })
    .then(function(r) {
      var data = r.data;
      var usData = r.usData;

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

      // Merge US airport data
      _giMergeUS(map, usData);

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
