// ── Gate Info ──────────────────────────────────────────────────────────────────
var gateFlightsLoaded = false;
var gateFlightsList = [];
var giSortKey = 'sta';
var giSortAsc = true;
var _giSelectedDate = null; // null = today, 'YYYY/MM/DD' = specific date
var _giFirstScrollDone = false;
var _giRawDep = [];
var _giRawArr = [];
var _giAirline = (function(){ try { return localStorage.getItem('crewsync_gi_airline') || 'JX'; } catch(e){ return 'JX'; } })();
var _giTimeSlot = 'all';

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

var _giIcaoToIata = {
  KSFO:'SFO',KLAX:'LAX',KSEA:'SEA',KPHX:'PHX',KONT:'ONT',
  RJAA:'NRT',RJBB:'KIX',RJFF:'FUK',RJCC:'CTS',ROAH:'OKA',RJFT:'KMJ',
  RJGG:'NGO',RJSS:'SDJ',RJFK:'KOJ',RJSA:'AOJ',RJOT:'TAK',RJBE:'UKB',RCMQ:'RMQ',
  RKSI:'ICN',RKPK:'PUS',
  VHHH:'HKG',VMMC:'MFM',
  WSSS:'SIN',VTBS:'BKK',VVTS:'SGN',VVNB:'HAN',VDPP:'PNH',
  RPLL:'MNL',RPVM:'CEB',WIII:'CGK',WADD:'DPS',WMKK:'KUL',WMKP:'PEN',
  LKPR:'PRG',RCTP:'TPE'
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
  var pinnedTable = document.getElementById('gi-pinned-table');
  var btn = document.getElementById('gi-time-btn');
  if (table.classList.contains('gi-hide-time')) {
    table.classList.remove('gi-hide-time');
    if (pinnedTable) pinnedTable.classList.remove('gi-hide-time');
    btn.classList.add('gi-time-btn-on');
  } else {
    table.classList.add('gi-hide-time');
    if (pinnedTable) pinnedTable.classList.add('gi-hide-time');
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
  sorted = sorted.filter(_giTimeFilter);

  if (searchTerm) {
    var isNumeric = /^\d+$/.test(searchTerm);
    var termUpper = searchTerm.toUpperCase();
    // If ICAO code, convert to IATA for matching
    var iataFromIcao = _giIcaoToIata[termUpper] || '';

    sorted.forEach(function(f) {
      var matched = false;
      if (isNumeric) {
        // Flight number search
        var num = f.fno.replace(/^(JX|BR|CI)/, '');
        matched = (num === searchTerm || num.indexOf(searchTerm) === 0);
      } else {
        // Station search: IATA code, ICAO (via mapping), or city name
        var oCode = (f.originCode || '').toUpperCase();
        var dCode = (f.destCode || '').toUpperCase();
        var oName = f.originName || '';
        var dName = f.destName || '';
        var fno = f.fno.toUpperCase();

        matched = fno.indexOf(termUpper) >= 0
          || oCode.indexOf(termUpper) >= 0
          || dCode.indexOf(termUpper) >= 0
          || oName.indexOf(searchTerm) >= 0
          || dName.indexOf(searchTerm) >= 0;

        // ICAO match
        if (!matched && iataFromIcao) {
          matched = (oCode === iataFromIcao || dCode === iataFromIcao);
        }
      }

      if (matched) {
        pinned.push(f);
      } else {
        others.push(f);
      }
    });
  } else {
    others = sorted;
  }

  // Pinned search results → separate container
  var pinnedWrap = document.getElementById('gi-pinned-wrap');
  var pinnedBody = document.getElementById('gi-pinned-tbody');
  var pinnedHeader = document.getElementById('gi-pinned-header');
  pinnedBody.innerHTML = '';

  var mainThead = document.querySelector('#gi-table thead');
  var pinnedThead = document.querySelector('#gi-pinned-table thead');

  if (pinned.length > 0) {
    pinnedHeader.textContent = '搜尋結果（' + pinned.length + ' 筆）';
    pinned.forEach(function(f) {
      pinnedBody.appendChild(giMakeRow(f));
    });
    pinnedWrap.style.display = '';
    if (pinnedThead) pinnedThead.style.display = '';
    if (mainThead) mainThead.style.display = 'none';
    // Scroll main table to top-left
    var wrap = document.getElementById('gate-table-wrap');
    if (wrap) { wrap.scrollLeft = 0; wrap.scrollTop = 0; }
    _giSetupScrollSync();
  } else {
    pinnedWrap.style.display = 'none';
    if (pinnedThead) pinnedThead.style.display = 'none';
    if (mainThead) mainThead.style.display = '';
  }

  // Other flights → main table
  others.forEach(function(f) {
    tableBody.appendChild(giMakeRow(f));
  });

  // Auto-scroll to destination column on portrait mobile (first load only)
  if (!_giFirstScrollDone && window.innerHeight > window.innerWidth && window.innerWidth < 768) {
    var destTh = document.querySelector('#gi-table thead th.gi-sortable[onclick*="dest"]');
    var wrap = document.getElementById('gate-table-wrap');
    if (destTh && wrap) {
      var stickyCol = document.querySelector('#gi-table thead th.gi-sticky-col');
      var offset = stickyCol ? stickyCol.offsetWidth : 0;
      wrap.scrollLeft = destTh.offsetLeft - offset;
      _giFirstScrollDone = true;
    }
  }
}

var _giScrollSyncing = false;
function _giSetupScrollSync() {
  var pw = document.getElementById('gi-pinned-wrap');
  var tw = document.getElementById('gate-table-wrap');
  if (!pw || !tw) return;
  pw.onscroll = function() {
    if (!_giScrollSyncing) { _giScrollSyncing = true; tw.scrollLeft = pw.scrollLeft; _giScrollSyncing = false; }
  };
  tw.onscroll = function() {
    if (!_giScrollSyncing) { _giScrollSyncing = true; pw.scrollLeft = tw.scrollLeft; _giScrollSyncing = false; }
  };
}

function _giGetSortVal(f, key) {
  if (key === 'fno') return f.fno || '';
  if (key === 'origin') return (f.originName || f.originCode || f.origin || '');
  if (key === 'dest') return (f.destName || f.destCode || f.dest || '');
  if (key === 'std') return f.std || '';
  if (key === 'atd') return f.atd || '';
  if (key === 'sta') return f.sta || '';
  if (key === 'ata') return f.ata || '';
  return '';
}

function _giSortList(list) {
  var sorted = list.slice();
  var timeCols = { std:1, atd:1, sta:1, ata:1 };
  sorted.sort(function(a, b) {
    var va = _giGetSortVal(a, giSortKey);
    var vb = _giGetSortVal(b, giSortKey);
    // Time columns: empty values always to end
    if (timeCols[giSortKey]) {
      var aEmpty = !va;
      var bEmpty = !vb;
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      if (aEmpty && bEmpty) return 0;
      var cmp = va.localeCompare(vb);
      return giSortAsc ? cmp : -cmp;
    }
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
  // Update header indicators on both tables
  var allThs = document.querySelectorAll('#gi-table thead th.gi-sortable, #gi-pinned-table thead th.gi-sortable');
  allThs.forEach(function(th) {
    th.classList.remove('gi-sort-asc', 'gi-sort-desc');
  });
  var cls = giSortAsc ? 'gi-sort-asc' : 'gi-sort-desc';
  allThs.forEach(function(th) {
    var onclick = th.getAttribute('onclick') || '';
    if (onclick.indexOf("'" + key + "'") >= 0) {
      th.classList.add(cls);
    }
  });
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

function _giMergeFA(map, faData, airline) {
  _giTestRows = [];
  var flights = faData.flights || {};
  var prefix = airline || 'JX';
  Object.keys(flights).forEach(function(key) {
    var fa = flights[key];
    if (!fa || !fa.fno) return;
    var fno = fa.fno;
    var re = new RegExp('^' + prefix);
    if (!re.test(fno)) return;
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

  var fidsUrl = _giSelectedDate ? '/api/fids?date=' + encodeURIComponent(_giSelectedDate) : '/api/fids';

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

  tpePromise.then(function(data) {
    dateEl.textContent = data.date || '';
    _giRawDep = data.dep || [];
    _giRawArr = data.arr || [];
    _giProcessFlights();
  }).catch(function(e) {
    statusEl.textContent = '載入失敗：' + e.message;
    statusEl.style.display = 'block';
  });
}

function _giProcessFlights() {
  var statusEl = document.getElementById('gate-status');
  var wrapEl = document.getElementById('gate-table-wrap');

  var airline = _giAirline;
  var isAll = (airline === 'ALL');

  // Filter TPE FIDS by airline
  var dep = _giRawDep.filter(function(f) {
    if (isAll) return f.ACode && /^(JX|BR|CI)$/.test(f.ACode.trim());
    return f.ACode && f.ACode.trim() === airline;
  });
  var arr = _giRawArr.filter(function(f) {
    if (isAll) return f.ACode && /^(JX|BR|CI)$/.test(f.ACode.trim());
    return f.ACode && f.ACode.trim() === airline;
  });

  var map = {};

  dep.forEach(function(f) {
    var acode = f.ACode.trim();
    var key = acode + f.FlightNo.replace(/\s/g, '');
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
    var acode = f.ACode.trim();
    var key = acode + f.FlightNo.replace(/\s/g, '');
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

  var flights = Object.values(map);
  if (flights.length === 0) {
    var label = isAll ? 'ALL' : airline;
    statusEl.textContent = '今日無 ' + label + ' 航班資料';
    statusEl.style.display = 'block';
    wrapEl.style.display = 'none';
    return;
  }

  gateFlightsList = flights;
  statusEl.style.display = 'none';
  wrapEl.style.display = '';
  renderGateFlights();
  gateFlightsLoaded = true;

  // Background fetch FA data (today only)
  var isToday = !_giSelectedDate;
  if (isToday) {
    var currentAirline = _giAirline;
    var airlines = isAll ? ['JX', 'BR', 'CI'] : [airline];
    var faPromises = airlines.map(function(al) {
      return fetch('/api/fids-fa?airline=' + al)
        .then(function(r) { return r.ok ? r.json() : { flights: {} }; })
        .catch(function() { return { flights: {} }; })
        .then(function(data) { return { airline: al, data: data }; });
    });
    Promise.all(faPromises).then(function(results) {
      if (_giAirline !== currentAirline) return; // airline changed, ignore
      results.forEach(function(r) {
        _giMergeFA(map, r.data, r.airline);
      });
      gateFlightsList = Object.values(map);
      renderGateFlights();
    });
  }
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

// ── Airline / Time Slot / Sort UI ─────────────────────────────────────────────

function giSetAirline(al) {
  _giAirline = al;
  try { localStorage.setItem('crewsync_gi_airline', al); } catch(e){}
  _giUpdateAirlineBtns();
  var titleEl = document.querySelector('.gi-title');
  if (titleEl) titleEl.textContent = (al === 'ALL' ? 'ALL' : al) + ' Flight Info';
  if (_giRawDep.length > 0 || _giRawArr.length > 0) {
    _giProcessFlights();
  }
}

function giSetTimeSlot(slot) {
  _giTimeSlot = slot;
  _giUpdateTimeBtns();
  if (gateFlightsList.length > 0) renderGateFlights();
}

function _giTimeFilter(f) {
  if (_giTimeSlot === 'all') return true;
  var t = f.std || f.sta || '';
  if (!t) return true;
  var parts = t.split(':');
  var hh = parseInt(parts[0], 10);
  if (isNaN(hh)) return true;
  if (_giTimeSlot === '±2hr') {
    var now = new Date();
    var twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    var nowMin = twNow.getUTCHours() * 60 + twNow.getUTCMinutes();
    var mm = parseInt(parts[1], 10) || 0;
    var fMin = hh * 60 + mm;
    return Math.abs(fMin - nowMin) <= 120;
  }
  var range = _giTimeSlot.split('-');
  var lo = parseInt(range[0], 10);
  var hi = parseInt(range[1], 10);
  return hh >= lo && hh < hi;
}

function _giUpdateAirlineBtns() {
  var btns = document.querySelectorAll('.gi-airline-btn');
  btns.forEach(function(btn) {
    var al = btn.getAttribute('data-airline');
    if (al === _giAirline) {
      btn.classList.add('gi-airline-active');
    } else {
      btn.classList.remove('gi-airline-active');
    }
  });
}

function _giUpdateTimeBtns() {
  var btns = document.querySelectorAll('.gi-time-slot');
  btns.forEach(function(btn) {
    var slot = btn.getAttribute('data-slot');
    if (slot === _giTimeSlot) {
      btn.classList.add('gi-time-active');
    } else {
      btn.classList.remove('gi-time-active');
    }
  });
}

function _giHighlightCurrentSlot() {
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  var hh = tw.getUTCHours();
  var slot = '';
  if (hh < 6) slot = '00-06';
  else if (hh < 12) slot = '06-12';
  else if (hh < 18) slot = '12-18';
  else slot = '18-24';
  var btns = document.querySelectorAll('.gi-time-slot');
  btns.forEach(function(btn) {
    var s = btn.getAttribute('data-slot');
    if (s === slot) {
      btn.classList.add('gi-time-current');
    } else {
      btn.classList.remove('gi-time-current');
    }
  });
}

// Initialize airline/time UI
(function() {
  _giUpdateAirlineBtns();
  _giUpdateTimeBtns();
  _giHighlightCurrentSlot();
  var titleEl = document.querySelector('.gi-title');
  if (titleEl && _giAirline !== 'JX') {
    titleEl.textContent = (_giAirline === 'ALL' ? 'ALL' : _giAirline) + ' Flight Info';
  }
  // Set default sort header indicator
  var allThs = document.querySelectorAll('#gi-table thead th.gi-sortable, #gi-pinned-table thead th.gi-sortable');
  allThs.forEach(function(th) {
    var onclick = th.getAttribute('onclick') || '';
    if (onclick.indexOf("'sta'") >= 0) {
      th.classList.add('gi-sort-asc');
    }
  });
})();

