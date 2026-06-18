// ── Gate Info ──────────────────────────────────────────────────────────────────
var gateFlightsLoaded = false;
var gateFlightsList = [];
var giSortKey = 'dest';
var giSortAsc = true;
var _giSelectedDate = null; // null = today, 'YYYY/MM/DD' = specific date
var _giFirstScrollDone = false;
var _giRawDep = [];
var _giRawArr = [];
var _giAirline = (function(){ try { return localStorage.getItem('crewsync_gi_airline') || 'JX'; } catch(e){ return 'JX'; } })();
var _giTimeSlot = '±2hr';

// ── 場站切換（地區 → 場站）。桃園走原邏輯；外站走 /api/fids?airport= 正規化來源 ──
var _giRegions = {
  TW: { name: 'TW', stations: [ { code: 'TPE', name: '桃園', src: 'tpe', tz: 'Asia/Taipei' }, { code: 'KHH', name: '高雄', src: 'khh', tz: 'Asia/Taipei' } ] },
  HK: { name: 'HK', stations: [ { code: 'HKG', name: '香港', src: 'hkg', tz: 'Asia/Hong_Kong' } ] },
  JP: { name: 'JP', stations: [ { code: 'NRT', name: '成田', src: 'nrt', tz: 'Asia/Tokyo' }, { code: 'CTS', name: '新千歲', src: 'cts', tz: 'Asia/Tokyo' }, { code: 'HKD', name: '函館', src: 'hkd', tz: 'Asia/Tokyo' } ] },
  SG: { name: 'SG', stations: [ { code: 'SIN', name: '樟宜', src: 'sin', tz: 'Asia/Singapore' } ] },
  US: { name: 'US', stations: [ { code: 'SFO', name: '舊金山', src: 'sfo', tz: 'America/Los_Angeles' }, { code: 'LAX', name: '洛杉磯', src: 'lax', tz: 'America/Los_Angeles' }, { code: 'PHX', name: '鳳凰城', src: 'phx', tz: 'America/Phoenix', dev: true }, { code: 'SEA', name: '西雅圖', src: 'sea', tz: 'America/Los_Angeles', dev: true }, { code: 'ONT', name: '安大略', src: 'ont', tz: 'America/Los_Angeles', dev: true } ] },
  EU: { name: 'EU', stations: [ { code: 'PRG', name: '布拉格', src: 'prg', tz: 'Europe/Prague' }, { code: 'BCN', name: '巴塞隆納', src: 'bcn', tz: 'Europe/Madrid' }, { code: 'ZRH', name: '蘇黎世', src: 'zrh', tz: 'Europe/Zurich' } ] }
};
var _giRegion = 'TW';
var _giAirport = 'TPE';      // 目前場站 code
var _giStationRows = null;   // 外站抓回的正規化 rows（含全航空，前端再篩）
var _giStationCache = {};    // key: src|date

function _giCurrentStation() {
  var r = _giRegions[_giRegion];
  if (r) { for (var i = 0; i < r.stations.length; i++) { if (r.stations[i].code === _giAirport) return r.stations[i]; } }
  return { code: 'TPE', name: '桃園', src: 'tpe', tz: 'Asia/Taipei' };
}
// 目前場站「當地時間」的 {hh, min}。時段（±2hr / 高亮）要用機場當地的現在，不是台北，
// 不然 SFO 等差好幾時區會整片錯位。用 Intl 算 DST 自動正確；不支援就退回台北。
function _giLocalNow() {
  var st = _giCurrentStation();
  try {
    var o = {};
    new Intl.DateTimeFormat('en-US', { timeZone: st.tz || 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date()).forEach(function(x) { o[x.type] = x.value; });
    var hh = parseInt(o.hour, 10) % 24, mm = parseInt(o.minute, 10) || 0;
    return { hh: hh, min: hh * 60 + mm };
  } catch (e) {
    var tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return { hh: tw.getUTCHours(), min: tw.getUTCHours() * 60 + tw.getUTCMinutes() };
  }
}

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
  PRG:'布拉格',BCN:'巴塞隆納',ZRH:'蘇黎世',TPE:'桃園'
};

var _giIcaoToIata = {
  KSFO:'SFO',KLAX:'LAX',KSEA:'SEA',KPHX:'PHX',KONT:'ONT',
  RJAA:'NRT',RJBB:'KIX',RJFF:'FUK',RJCC:'CTS',ROAH:'OKA',RJFT:'KMJ',
  RJGG:'NGO',RJSS:'SDJ',RJFK:'KOJ',RJSA:'AOJ',RJOT:'TAK',RJBE:'UKB',RCMQ:'RMQ',
  RKSI:'ICN',RKPK:'PUS',
  VHHH:'HKG',VMMC:'MFM',
  WSSS:'SIN',VTBS:'BKK',VVTS:'SGN',VVNB:'HAN',VDPP:'PNH',
  RPLL:'MNL',RPVM:'CEB',WIII:'CGK',WADD:'DPS',WMKK:'KUL',WMKP:'PEN',
  LKPR:'PRG',LEBL:'BCN',LSZH:'ZRH',RCTP:'TPE'
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
    if (idx === 0) {
      td.className = 'gi-fno gi-sticky-col';
      var fno = c.val || '';
      if (fno.indexOf('JX') === 0) td.style.color = '#B8860B';
      else if (fno.indexOf('BR') === 0) td.style.color = '#00A651';
      else if (fno.indexOf('CI') === 0) td.style.color = '#E91E8C';
    }
    if (timeCols[idx]) td.className = (td.className ? td.className + ' ' : '') + 'gi-time-col';
    tr.appendChild(td);
  });

  return tr;
}

var _giViewMode = 'dest';
function toggleGiView() {
  var wrap = document.getElementById('gate-table-wrap');
  var pw = document.getElementById('gi-pinned-wrap');
  var btn = document.getElementById('gi-view-btn');
  if (!wrap) return;
  var stickyCol = document.querySelector('#gi-table thead th.gi-sticky-col');
  var offset = stickyCol ? stickyCol.offsetWidth : 0;
  if (_giViewMode === 'dest') {
    _giViewMode = 'orig';
    btn.textContent = '🛬 Dest';
    // Sort by origin (TPE first)
    giSortKey = 'origin'; giSortAsc = true;
    _giUpdateSortHeaders('origin');
    renderGateFlights();
    // Scroll to origin columns
    setTimeout(function() {
      var origTh = document.querySelector('#gi-table thead th.gi-sortable[onclick*="origin"]');
      if (origTh) {
        var pos = origTh.offsetLeft - offset;
        wrap.scrollLeft = pos;
        if (pw && pw.style.display !== 'none') pw.scrollLeft = pos;
      }
    }, 0);
  } else {
    _giViewMode = 'dest';
    btn.textContent = '🛫 Orig';
    // Sort by dest (TPE first)
    giSortKey = 'dest'; giSortAsc = true;
    _giUpdateSortHeaders('dest');
    renderGateFlights();
    // Scroll to dest columns
    setTimeout(function() {
      var destTh = document.querySelector('#gi-table thead th.gi-sortable[onclick*="dest"]');
      if (destTh) {
        var pos = destTh.offsetLeft - offset;
        wrap.scrollLeft = pos;
        if (pw && pw.style.display !== 'none') pw.scrollLeft = pos;
      }
    }, 0);
  }
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

  // 空狀態（時段篩完後統一判斷；搜尋時交給搜尋結果區、不套用）：
  var _statusEl = document.getElementById('gate-status');
  var _wrapEl = document.getElementById('gate-table-wrap');
  if (!searchTerm && sorted.length === 0) {
    var _lbl = (_giAirline === 'ALL') ? 'ALL' : _giAirline;
    // gateFlightsList = 航空篩選後(未套時段)的全天清單：它空 = 該航空整天無班 → 今日無；它有但被時段濾光 → 本時段無（時段=All 不會發生）。
    var _allDay = (gateFlightsList.length === 0) || (_giTimeSlot === 'all');
    if (_statusEl) { _statusEl.textContent = (_allDay ? '今日無 ' : '本時段無 ') + _lbl + ' 航班'; _statusEl.style.display = 'block'; }
    if (_wrapEl) _wrapEl.style.display = 'none';
    var _pw0 = document.getElementById('gi-pinned-wrap'); if (_pw0) _pw0.style.display = 'none';
    return;
  }
  if (_statusEl) _statusEl.style.display = 'none';
  if (_wrapEl) _wrapEl.style.display = '';

  if (searchTerm) {
    var isNumeric = /^\d+$/.test(searchTerm);
    var termUpper = searchTerm.toUpperCase();
    // If ICAO code, convert to IATA for matching
    var iataFromIcao = _giIcaoToIata[termUpper] || '';

    sorted.forEach(function(f) {
      var matched = false;
      if (isNumeric) {
        // Flight number search（IATA 與 ICAO 兩種航班號都比對）
        var nums = [f.fno, f.altFno || ''].map(function(x) { var m = x.toUpperCase().match(/(\d+[A-Z]?)$/); return (m ? m[1] : '').replace(/^0+/, ''); });
        matched = nums.some(function(n) { return n && (n === searchTerm || n.indexOf(searchTerm) === 0); });
      } else {
        // Station search: IATA code, ICAO (via mapping), or city name
        var oCode = (f.originCode || '').toUpperCase();
        var dCode = (f.destCode || '').toUpperCase();
        var oName = f.originName || '';
        var dName = f.destName || '';
        var fno = f.fno.toUpperCase();
        var altFno = (f.altFno || '').toUpperCase();

        matched = fno.indexOf(termUpper) >= 0
          || (altFno && altFno.indexOf(termUpper) >= 0)
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

function _giUpdateSortHeaders(key) {
  var allThs = document.querySelectorAll('#gi-table thead th.gi-sortable, #gi-pinned-table thead th.gi-sortable');
  allThs.forEach(function(th) { th.classList.remove('gi-sort-asc', 'gi-sort-desc'); });
  var cls = giSortAsc ? 'gi-sort-asc' : 'gi-sort-desc';
  allThs.forEach(function(th) {
    var onclick = th.getAttribute('onclick') || '';
    if (onclick.indexOf("'" + key + "'") >= 0) th.classList.add(cls);
  });
}

function giSort(key) {
  if (giSortKey === key) {
    giSortAsc = !giSortAsc;
  } else {
    giSortKey = key;
    giSortAsc = true;
  }
  _giUpdateSortHeaders(key);
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

  var dateStr = _giSelectedDate || _giTodayStr();   // 場站當地今天（外站跨時區才不會送成別天）
  var st = _giCurrentStation();

  if (st.code === 'TPE') {
    // 桃園：原邏輯完全不動
    _fidsFetchByDate(dateStr).then(function(data) {
      dateEl.textContent = data.date || '';
      _giRawDep = data.dep || [];
      _giRawArr = data.arr || [];
      _giProcessFlights();
    }).catch(function(e) {
      statusEl.textContent = '載入失敗：' + e.message;
      statusEl.style.display = 'block';
    });
    return;
  }

  // 外站：抓正規化 rows，前端再依航空快篩
  _giStationRows = null;
  _giRawDep = []; _giRawArr = [];
  _giFetchStation(st.src, dateStr).then(function(data) {
    dateEl.textContent = data.date || '';
    _giStationRows = data.rows || [];
    _giProcessStationRows();
  }).catch(function(e) {
    statusEl.textContent = '載入失敗：' + e.message;
    statusEl.style.display = 'block';
  });
}

function _giFetchStation(src, dateStr) {
  var key = src + '|' + dateStr;
  var c = _giStationCache[key];
  if (c) {
    var expired = navigator.onLine && (Date.now() - c.ts > 120000);
    if (!expired) return Promise.resolve(c.data);
  }
  if (!navigator.onLine) return Promise.reject(new Error('offline'));
  return fetch('/api/fids?airport=' + encodeURIComponent(src) + '&date=' + encodeURIComponent(dateStr))
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) { if (data && data.rows && data.rows.length) _giStationCache[key] = { data: data, ts: Date.now() }; return data; })
    .catch(function(e) { if (c) return c.data; throw e; });  // 抓失敗時退回上次成功的舊資料(機場wifi不穩)
}

function _giProcessStationRows() {
  var statusEl = document.getElementById('gate-status');
  var wrapEl = document.getElementById('gate-table-wrap');
  var raw = _giStationRows || [];
  // 「開發中」只在「整站完全沒資料」(raw 空)且是 dev 站(PHX/SEA/ONT 尚無穩定來源)時顯示。其餘空狀態(航空篩選/時段)交給 renderGateFlights。
  if (raw.length === 0 && _giCurrentStation().dev) {
    statusEl.textContent = '頁面開發中 · Page under development';
    statusEl.style.display = 'block';
    wrapEl.style.display = 'none';
    gateFlightsList = [];
    return;
  }
  var airline = _giAirline, isAll = (airline === 'ALL');
  gateFlightsList = raw.filter(function(f) { return isAll || (f.fno || '').toUpperCase().indexOf(airline) === 0; });
  renderGateFlights();   // 由它判斷空狀態(今日無 / 本時段無)+ 顯示/隱藏表格
  gateFlightsLoaded = true;
}

function _giProcessFlights() {
  var statusEl = document.getElementById('gate-status');
  var wrapEl = document.getElementById('gate-table-wrap');

  var airline = _giAirline;
  var isAll = (airline === 'ALL');

  // Filter TPE FIDS by airline
  var dep = _giRawDep.filter(function(f) {
    if (isAll) return !!(f.ACode && f.ACode.trim());
    return f.ACode && f.ACode.trim() === airline;
  });
  var arr = _giRawArr.filter(function(f) {
    if (isAll) return !!(f.ACode && f.ACode.trim());
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
  gateFlightsList = flights;
  renderGateFlights();   // 空狀態(今日無 / 本時段無)+ 顯示/隱藏由 renderGateFlights 統一處理
  gateFlightsLoaded = true;

  // Background fetch gate data: FR24 first, FA fallback (today only)
  var isToday = !_giSelectedDate;
  if (isToday) {
    var currentAirline = _giAirline;
    var airlines = isAll ? ['JX', 'BR', 'CI'] : [airline];
    // Try FR24 first
    fetch('/api/fids-fr24')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(fr24Data) {
        if (_giAirline !== currentAirline) return;
        if (fr24Data && fr24Data.count > 0) {
          airlines.forEach(function(al) {
            _giMergeFA(map, fr24Data, al);
          });
          gateFlightsList = Object.values(map);
          renderGateFlights();
        }
        // Also fetch FA as supplement (may have flights FR24 missed)
        var faPromises = airlines.map(function(al) {
          return fetch('/api/fids-fa?airline=' + al)
            .then(function(r) { return r.ok ? r.json() : { flights: {} }; })
            .catch(function() { return { flights: {} }; })
            .then(function(data) { return { airline: al, data: data }; });
        });
        return Promise.all(faPromises);
      })
      .then(function(results) {
        if (!results || _giAirline !== currentAirline) return;
        results.forEach(function(r) {
          _giMergeFA(map, r.data, r.airline);
        });
        gateFlightsList = Object.values(map);
        renderGateFlights();
      })
      .catch(function() {
        // FR24 failed, fall back to FA only
        var faPromises = airlines.map(function(al) {
          return fetch('/api/fids-fa?airline=' + al)
            .then(function(r) { return r.ok ? r.json() : { flights: {} }; })
            .catch(function() { return { flights: {} }; })
            .then(function(data) { return { airline: al, data: data }; });
        });
        Promise.all(faPromises).then(function(results) {
          if (_giAirline !== currentAirline) return;
          results.forEach(function(r) {
            _giMergeFA(map, r.data, r.airline);
          });
          gateFlightsList = Object.values(map);
          renderGateFlights();
        });
      });
  }
}

function refreshGateFlights() {
  loadGateFlights();
}

// 目前場站「當地日期」YYYY/MM/DD（dayShift 天位移）。date nav 全用這個，跨時區外站才一致。
// TPE=Asia/Taipei→等同台北，行為不變；北海道/NRT=JST、SIN、SFO 各用自己的當地日。
function _giLocalDateStr(dayShift) {
  var st = _giCurrentStation();
  try {
    var o = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: st.tz || 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(Date.now() + (dayShift || 0) * 86400000)).forEach(function(x) { o[x.type] = x.value; });
    return o.year + '/' + o.month + '/' + o.day;
  } catch (e) {
    var tw = new Date(Date.now() + 8 * 60 * 60 * 1000 + (dayShift || 0) * 86400000);
    return tw.getUTCFullYear() + '/' + String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' + String(tw.getUTCDate()).padStart(2, '0');
  }
}
function _giTodayStr() { return _giLocalDateStr(0); }

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
  // 桃園可看到次日；外站(北海道)只有 today/yesterday，次日上限設今天
  var maxNext = (_giCurrentStation().code === 'TPE') ? tomorrow : today;
  if (prevBtn) prevBtn.disabled = (current <= yesterday);
  if (nextBtn) nextBtn.disabled = (current >= maxNext);
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
  // 只在桃園記住偏好；外站(預設 ALL)的手動點選不污染桃園存檔
  if (_giCurrentStation().code === 'TPE') { try { localStorage.setItem('crewsync_gi_airline', al); } catch(e){} }
  _giUpdateAirlineBtns();
  var titleEl = document.querySelector('.gi-title');
  if (titleEl) titleEl.textContent = (al === 'ALL' ? 'ALL' : al) + ' Flight Info';
  if (_giCurrentStation().code === 'TPE') {
    if (_giRawDep.length > 0 || _giRawArr.length > 0) _giProcessFlights();
  } else {
    if (_giStationRows) _giProcessStationRows(); else loadGateFlights();
  }
}

// ── 場站切換 ──────────────────────────────────────────────────────────────────
function _giRenderRegionOptions() {
  var sel = document.getElementById('gi-region');
  if (!sel) return;
  sel.innerHTML = '';
  Object.keys(_giRegions).forEach(function(rk) {
    var o = document.createElement('option');
    o.value = rk; o.textContent = _giRegions[rk].name;
    sel.appendChild(o);
  });
  sel.value = _giRegion;
}
function _giRenderStationOptions() {
  var sel = document.getElementById('gi-station');
  if (!sel) return;
  sel.innerHTML = '';
  ((_giRegions[_giRegion] || {}).stations || []).forEach(function(s) {
    var o = document.createElement('option');
    o.value = s.code; o.textContent = s.name + ' ' + s.code;
    sel.appendChild(o);
  });
  sel.value = _giAirport;
}
function giSetRegion(region) {
  if (!_giRegions[region]) return;
  _giRegion = region;
  _giRenderStationOptions();
  giSetStation(_giRegions[region].stations[0].code);
}
function giSetStation(code) {
  _giAirport = code;
  var sel = document.getElementById('gi-station');
  if (sel) sel.value = code;
  // 桃園用儲存偏好(預設 JX)；外站預設 ALL(整個機場全板，不然套 JX 多半空)
  if (code === 'TPE') {
    try { _giAirline = localStorage.getItem('crewsync_gi_airline') || 'JX'; } catch (e) { _giAirline = 'JX'; }
  } else {
    _giAirline = 'ALL';
  }
  _giUpdateAirlineBtns();
  _giHighlightCurrentSlot();   // 切站後「目前時段」高亮要跟著該站當地時間更新
  var titleEl = document.querySelector('.gi-title');
  if (titleEl) titleEl.textContent = (_giAirline === 'ALL' ? 'ALL' : _giAirline) + ' Flight Info';
  _giStationRows = null;
  _giSelectedDate = null;     // 切場站回今天，避免帶著別站的日期造成空白
  _giUpdateDateNav();
  loadGateFlights();
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
    var nowMin = _giLocalNow().min;   // 機場當地的現在（非台北），跨時區才不錯位
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
  var hh = _giLocalNow().hh;   // 高亮「目前時段」也用機場當地的現在
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
  _giRenderRegionOptions();
  _giRenderStationOptions();
  var titleEl = document.querySelector('.gi-title');
  if (titleEl && _giAirline !== 'JX') {
    titleEl.textContent = (_giAirline === 'ALL' ? 'ALL' : _giAirline) + ' Flight Info';
  }
  // Set default sort header indicator
  var allThs = document.querySelectorAll('#gi-table thead th.gi-sortable, #gi-pinned-table thead th.gi-sortable');
  allThs.forEach(function(th) {
    var onclick = th.getAttribute('onclick') || '';
    if (onclick.indexOf("'dest'") >= 0) {
      th.classList.add('gi-sort-asc');
    }
  });
})();

