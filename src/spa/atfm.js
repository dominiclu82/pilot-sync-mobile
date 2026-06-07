// ── ATFM 流量管制（地圖版，多地區）──────────────────────────────────────────────
// 太平洋置中：美洲經度 +360 畫到亞洲右側，整網連續(亞洲←→太平洋←→美國)，往右滑直達美國
var _atfmRegions = [
  { code: 'all', name: 'ALL', center: [22, 185], zoom: 2 },
  { code: 'tw', name: 'Taiwan', center: [24.2, 121], zoom: 7 },
  { code: 'jp', name: 'Japan', center: [37, 138], zoom: 5 },
  { code: 'kr', name: 'Korea', center: [36.5, 127.8], zoom: 7 },
  { code: 'hk', name: 'Hong Kong', center: [22.31, 113.92], zoom: 9 },
  { code: 'mo', name: 'Macau', center: [22.15, 113.57], zoom: 11 },
  { code: 'th', name: 'Thailand', center: [13.9, 100.7], zoom: 6 },
  { code: 'vn', name: 'Vietnam', center: [16.5, 107], zoom: 6 },
  { code: 'us', name: 'US', center: [39, 245], zoom: 4 },
  { code: 'eu', name: 'Europe', center: [50, 10], zoom: 4 }
];
function _atfmLon(lon) { return lon < -30 ? lon + 360 : lon; }  // 美洲移到右側
var _atfmRegion = 'all';
var _atfmMapObj = null;
var _atfmMarkerLayer = null;
var _atfmAirports = null;   // 全機場狀態快取（含座標/色）
var _atfmAllCtot = null;    // 台/港/澳/泰合併逐班 CTOT（點機場用）
var _atfmUpdated = '';
var _atfmTimer = null;
var _atfmUiReady = false;
var _atfmTapped = null;       // 目前點選的機場 ICAO（null=未點，顯示總覽/區域表）
var _atfmDepArr = 'dep';      // CTOT 表目前顯示 dep / arr / other
var _atfmDepArrAuto = true;   // true=自動挑有資料的(預設DEP);使用者手動點過就false鎖定
var _atfmSearch = '';
var _atfmRegionData = null;   // 目前地區的資料(切 DEP/ARR 不重抓)
var _atfmLastBase = null;     // 目前拖到第幾「圈」世界(經度 base)，換圈才重畫點
var _atfmCLR = { grey: '#6b7280', green: '#22c55e', amber: '#f59e0b', red: '#ef4444' };

function _atfmEsc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }
function _atfmCur() { for (var i = 0; i < _atfmRegions.length; i++) if (_atfmRegions[i].code === _atfmRegion) return _atfmRegions[i]; return _atfmRegions[0]; }

function atfmInit() {
  if (!_atfmMapObj && typeof L !== 'undefined') {
    var c = _atfmCur();
    _atfmMapObj = L.map('atfm-map', { zoomControl: true, attributionControl: false }).setView(c.center, c.zoom);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 11, minZoom: 2 }).addTo(_atfmMapObj);
    _atfmMarkerLayer = L.layerGroup().addTo(_atfmMapObj);
    _atfmMapObj.on('moveend', function () {  // 拖到新一圈世界 → 把機場點重畫到這圈
      if (!_atfmMapObj) return;
      var b = Math.round((_atfmMapObj.getCenter().lng - 180) / 360) * 360;
      if (b !== _atfmLastBase) _atfmPlotMarkers();
    });
  }
  if (!_atfmUiReady) { _atfmRenderRegions(); _atfmApplyBarState(); _atfmUiReady = true; }
  setTimeout(function () { if (_atfmMapObj) _atfmMapObj.invalidateSize(); }, 120);
  _atfmLoadAll();
  if (_atfmRegion !== 'all') _atfmLoadRegion(_atfmRegion);
  _atfmStartAuto();
}
function _atfmStartAuto() {
  if (_atfmTimer) clearInterval(_atfmTimer);
  _atfmTimer = setInterval(function () {
    var tab = document.getElementById('tab-atfm');
    if (tab && tab.style.display !== 'none') { _atfmLoadAll(true); if (_atfmRegion !== 'all') _atfmLoadRegion(_atfmRegion, true); }
    else _atfmStopAuto();
  }, 45000);
}
function _atfmStopAuto() { if (_atfmTimer) { clearInterval(_atfmTimer); _atfmTimer = null; } }

// 收合底部資訊面板:地圖變大。狀態存 localStorage,切回來記得
function atfmToggleBar() {
  var t = document.getElementById('tab-atfm'); if (!t) return;
  var hidden = t.classList.toggle('atfm-bar-hidden');
  try { localStorage.setItem('crewsync_atfm_bar', hidden ? '0' : '1'); } catch (e) { }
  setTimeout(function () { if (_atfmMapObj) _atfmMapObj.invalidateSize(); }, 220);  // 面板收合後地圖重算尺寸
}
function _atfmApplyBarState() {
  try {
    var t = document.getElementById('tab-atfm');
    if (t && localStorage.getItem('crewsync_atfm_bar') === '0') t.classList.add('atfm-bar-hidden');
  } catch (e) { }
}

function _atfmRenderRegions() {
  var el = document.getElementById('atfm-regions');
  if (!el) return;
  el.innerHTML = _atfmRegions.map(function (r) {
    return '<button class="atfm-rgn' + (r.code === _atfmRegion ? ' atfm-rgn-on' : '') + '" onclick="atfmSetRegion(\'' + r.code + '\')">' + r.name + '</button>';
  }).join('');
}
function atfmSetRegion(code) {
  _atfmRegion = code;
  _atfmTapped = null;                                                          // 換區域取消點選
  _atfmDepArr = 'dep'; _atfmDepArrAuto = true; _atfmSearch = ''; _atfmRegionData = null;
  _atfmRenderRegions();
  var r = _atfmCur();
  if (_atfmMapObj) _atfmMapObj.flyTo(r.center, r.zoom, { duration: 0.6 });
  if (code === 'all') _atfmRenderBar();
  else _atfmLoadRegion(code);
}

// 全機場狀態 + 合併 CTOT → 地圖點
function _atfmLoadAll(quiet) {
  fetch('/api/atfm?region=all').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
    _atfmAirports = d.airports || [];
    _atfmAllCtot = d.ctot || [];
    _atfmUpdated = d.updated || '';
    _atfmPlotMarkers();
    if (_atfmRegion === 'all' || _atfmTapped) _atfmRenderBar();
  }).catch(function () { });
}
function _atfmPlotMarkers() {
  if (!_atfmMarkerLayer || !_atfmMapObj) return;
  _atfmMarkerLayer.clearLayers();
  var base = Math.round((_atfmMapObj.getCenter().lng - 180) / 360) * 360;  // 目前這圈
  _atfmLastBase = base;
  var copies = [base - 360, base, base + 360];  // 當前圈 + 左右各一圈，拖動時點不消失
  (_atfmAirports || []).forEach(function (a) {
    var ctrl = (a.color === 'amber' || a.color === 'red');
    var canon = _atfmLon(a.lon);
    copies.forEach(function (off) {
      var mk = L.circleMarker([a.lat, canon + off], { radius: ctrl ? 8 : 5, color: '#0a0e1a', weight: 1, fillColor: _atfmCLR[a.color] || _atfmCLR.grey, fillOpacity: .95 });
      if (ctrl && off === base) mk.bindTooltip(a.icao, { permanent: true, direction: 'top', className: 'atfm-lbl', offset: [0, -8] });  // 常駐標籤只掛中央圈,免重複
      else mk.bindTooltip(ctrl ? a.icao : ('<b>' + _atfmEsc(a.icao) + '</b> · ' + (a.color === 'grey' ? 'No data' : 'Normal')), { direction: 'top', offset: [0, -6] });
      mk.on('click', (function (ic) { return function () { atfmTapAirport(ic); }; })(a.icao));
      mk.addTo(_atfmMarkerLayer);
    });
  });
}

// ── 底部面板分派：點了機場→該機場 CTOT；ALL未點→總覽；區域未點→區域總表 ──
function _atfmRenderBar() {
  if (_atfmTapped) { _atfmRenderTapped(); return; }
  if (_atfmRegion === 'all') { _atfmShowRestrictions(); return; }
  _atfmRenderRegion();
}

// ALL 未點：管制總覽
function _atfmShowRestrictions() {
  var bar = document.getElementById('atfm-bar');
  if (!bar) return;
  var active = (_atfmAirports || []).filter(function (a) { return a.color === 'amber' || a.color === 'red'; });
  var h = '<div class="atfm-bar-h">Active restrictions (' + active.length + ')' + (_atfmUpdated ? ' · ' + _atfmEsc(_atfmUpdated) : '') + '</div>';
  if (active.length) {
    h += active.map(function (a) {
      var ty = a.type || 'GDP';
      var bb = _atfmMBadge[ty] || _atfmMBadge['GDP'];
      return '<div class="atfm-m-row"><span class="atfm-badge" style="background:' + bb[0] + ';color:' + bb[1] + '">' + _atfmEsc(ty) + '</span><span class="atfm-m-txt"><b>' + _atfmEsc(a.icao) + '</b> ' + _atfmEsc(a.text) + '</span></div>';
    }).join('');
  } else { h += '<div class="atfm-empty">No ATFM restrictions active ✅</div>'; }
  h += '<div class="atfm-empty" style="padding-top:6px">Tap an airport on the map for its CTOT.</div>';
  bar.innerHTML = h;
}

// 點機場：列出跟它有關的逐班 CTOT（合併源，依 adep/ades 過濾）
function atfmTapAirport(icao) {
  _atfmTapped = icao;
  _atfmDepArr = 'dep'; _atfmDepArrAuto = true; _atfmSearch = '';
  _atfmRenderTapped();
}
function atfmClearTap() { _atfmTapped = null; _atfmSearch = ''; _atfmRenderBar(); }
function _atfmTapDep() { var ic = _atfmTapped; return (_atfmAllCtot || []).filter(function (c) { return c.adep === ic; }); }
function _atfmTapArr() { var ic = _atfmTapped; return (_atfmAllCtot || []).filter(function (c) { return c.ades === ic; }); }
function _atfmTappedBody() {
  var rows = _atfmDepArr === 'arr' ? _atfmTapArr() : _atfmTapDep();
  var q = _atfmSearch.trim().toUpperCase().replace(/\s/g, '');
  if (q) rows = rows.filter(function (c) { return ((c.acid || '') + (c.adep || '') + (c.ades || '')).toUpperCase().indexOf(q) >= 0; });
  return rows.length ? _atfmTbl(rows) : '<div class="atfm-empty">' + (_atfmSearch ? 'No match' : 'No active CTOT') + '</div>';
}
function _atfmRenderTapped() {
  var bar = document.getElementById('atfm-bar');
  if (!bar) return;
  var icao = _atfmTapped;
  var a = (_atfmAirports || []).filter(function (x) { return x.icao === icao; })[0] || { icao: icao, color: 'grey', text: '', type: '' };
  var dep = _atfmTapDep(), arr = _atfmTapArr();
  var hasC = dep.length + arr.length > 0;
  if (_atfmDepArrAuto) _atfmDepArr = dep.length ? 'dep' : (arr.length ? 'arr' : 'dep');
  var dotc = _atfmCLR[a.color] || _atfmCLR.grey;
  var ctrl = (a.color === 'amber' || a.color === 'red');
  var badge = '';
  if (ctrl) { var ty = a.type || 'GDP'; var bb = _atfmMBadge[ty] || _atfmMBadge['GDP']; badge = ' <span class="atfm-badge" style="background:' + bb[0] + ';color:' + bb[1] + '">' + _atfmEsc(ty) + '</span>'; }
  var h = '<div class="atfm-tap-h"><span><span class="atfm-dot" style="background:' + dotc + '"></span><b>' + _atfmEsc(icao) + '</b>' + badge + '</span><button class="atfm-clear" onclick="atfmClearTap()">✕ Show all</button></div>';
  var st = ctrl ? a.text : (a.color === 'grey' ? 'No data' : 'Normal — no ATFM measure');
  if (st) h += '<div class="atfm-tap-txt">' + _atfmEsc(st) + '</div>';
  if (hasC) {
    h += '<div class="atfm-da">' +
      '<button class="atfm-da-btn' + (_atfmDepArr === 'dep' ? ' atfm-da-on' : '') + '" onclick="atfmSetDepArr(\'dep\')">🛫 Departures (' + dep.length + ')</button>' +
      '<button class="atfm-da-btn' + (_atfmDepArr === 'arr' ? ' atfm-da-on' : '') + '" onclick="atfmSetDepArr(\'arr\')">🛬 Arrivals (' + arr.length + ')</button>' +
      '</div>';
    h += '<div class="atfm-da2"><input type="text" class="atfm-search" placeholder="Search flight / airport" oninput="atfmSearchCtot(this.value)" value="' + _atfmEsc(_atfmSearch) + '">' + (_atfmUpdated ? '<span class="atfm-upd">Updated ' + _atfmEsc(_atfmUpdated) + '</span>' : '') + '</div>';
    h += '<div id="atfm-ctot-body">' + _atfmTappedBody() + '</div>';
  } else {
    h += '<div class="atfm-empty">No active CTOT for this airport</div>';
  }
  bar.innerHTML = h;
}

// ── 區域總表（點區域按鈕，沿用原行為）──
var _atfmMBadge = {
  'FLOW CONTROL': ['#fff3cd', '#7d4e00'], 'ATFM MEASURE': ['#fde8e8', '#b91c1c'], 'GDP': ['#ffedd5', '#9a3412'],
  'GROUND STOP': ['#fee2e2', '#991b1b'], 'LVL RESTRICTION': ['#e0f2fe', '#0369a1'], 'MDI': ['#ede9fe', '#6d28d9'],
  'CTOT TRIAL': ['#f3f4f6', '#374151'], 'NOTICE': ['#f3f4f6', '#374151'], 'CLOSURE': ['#fee2e2', '#991b1b']
};
function _atfmTbl(rows) {
  return '<div class="atfm-tw"><table class="atfm-table"><thead><tr><th>Flight</th><th>Route</th><th>CTOT</th><th>Note</th></tr></thead><tbody>' +
    rows.map(function (c) {
      return '<tr><td class="atfm-acid">' + _atfmEsc(c.acid || '—') + '</td><td>' + _atfmEsc(c.adep || '—') + '→' + _atfmEsc(c.ades || '—') + '</td><td class="atfm-ctotv">' + _atfmEsc(c.ctot || '—') + (c.ctotNew ? ' <span class="atfm-new">' + _atfmEsc(c.ctotNew) + '</span>' : '') + '</td><td class="atfm-note">' + _atfmEsc(c.status || c.win || '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}
function _atfmCtotForDir() {
  var ctot = (_atfmRegionData && _atfmRegionData.ctot) || [];
  var rows = _atfmDepArr === 'arr' ? ctot.filter(function (c) { return c.dir === 'ARR'; })
    : _atfmDepArr === 'other' ? ctot.filter(function (c) { return c.dir !== 'DEP' && c.dir !== 'ARR'; })
      : ctot.filter(function (c) { return c.dir === 'DEP'; });
  var q = _atfmSearch.trim().toUpperCase().replace(/\s/g, '');
  if (q) rows = rows.filter(function (c) { return ((c.acid || '') + (c.adep || '') + (c.ades || '')).toUpperCase().indexOf(q) >= 0; });
  return rows;
}
function _atfmCtotBodyHtml() {
  var rows = _atfmCtotForDir();
  return rows.length ? _atfmTbl(rows) : '<div class="atfm-empty">' + (_atfmSearch ? 'No match' : 'No active CTOT') + '</div>';
}
// dep/arr 切換 + 搜尋：依目前模式（點機場 / 區域總表）更新
function atfmSetDepArr(which) { _atfmDepArr = which; _atfmDepArrAuto = false; _atfmRenderBar(); }
function atfmSearchCtot(v) {
  _atfmSearch = v || '';
  var el = document.getElementById('atfm-ctot-body');
  if (el) el.innerHTML = _atfmTapped ? _atfmTappedBody() : _atfmCtotBodyHtml();
}
function _atfmRenderRegion() {
  var bar = document.getElementById('atfm-bar');
  if (!bar || !_atfmRegionData) return;
  var d = _atfmRegionData, meas = d.measures || [], h = '';
  if (meas.length) {
    h += meas.map(function (m) {
      var b = _atfmMBadge[m.type] || _atfmMBadge['NOTICE'];
      return '<div class="atfm-m-row"><span class="atfm-badge" style="background:' + b[0] + ';color:' + b[1] + '">' + _atfmEsc(m.type) + '</span><span class="atfm-m-txt">' + (m.airport ? '<b>' + _atfmEsc(m.airport) + '</b> ' : '') + _atfmEsc(m.text) + (m.time ? ' <span class="atfm-m-t">' + _atfmEsc(m.time) + '</span>' : '') + '</span></div>';
    }).join('');
  }
  if (d.hasCtot === false) {
    if (!meas.length) h += '<div class="atfm-bar-h">' + (d.updated ? 'Updated ' + _atfmEsc(d.updated) : 'Status') + '</div><div class="atfm-empty">No active restrictions ✅</div>';
    h += '<div class="atfm-empty" style="padding-top:6px">Tap an airport on the map for its CTOT.</div>';
    bar.innerHTML = h; return;
  }
  var ctot = d.ctot || [];
  var nd = ctot.filter(function (c) { return c.dir === 'DEP'; }).length;
  var na = ctot.filter(function (c) { return c.dir === 'ARR'; }).length;
  var no = ctot.filter(function (c) { return c.dir !== 'DEP' && c.dir !== 'ARR'; }).length;
  if (_atfmDepArrAuto) _atfmDepArr = nd ? 'dep' : (na ? 'arr' : (no ? 'other' : 'dep'));
  h += '<div class="atfm-da">' +
    '<button class="atfm-da-btn' + (_atfmDepArr === 'dep' ? ' atfm-da-on' : '') + '" onclick="atfmSetDepArr(\'dep\')">🛫 Departures (' + nd + ')</button>' +
    '<button class="atfm-da-btn' + (_atfmDepArr === 'arr' ? ' atfm-da-on' : '') + '" onclick="atfmSetDepArr(\'arr\')">🛬 Arrivals (' + na + ')</button>' +
    (no ? '<button class="atfm-da-btn' + (_atfmDepArr === 'other' ? ' atfm-da-on' : '') + '" onclick="atfmSetDepArr(\'other\')">Other (' + no + ')</button>' : '') +
    '</div>';
  h += '<div class="atfm-da2"><input type="text" class="atfm-search" placeholder="Search flight / airport" oninput="atfmSearchCtot(this.value)" value="' + _atfmEsc(_atfmSearch) + '">' + (d.updated ? '<span class="atfm-upd">Updated ' + _atfmEsc(d.updated) + '</span>' : '') + '</div>';
  h += '<div id="atfm-ctot-body">' + _atfmCtotBodyHtml() + '</div>';
  bar.innerHTML = h;
}
function _atfmLoadRegion(code, quiet) {
  var bar = document.getElementById('atfm-bar');
  if (!bar) return;
  if (!quiet && !_atfmTapped) bar.innerHTML = '<div class="atfm-bar-h">Loading…</div>';
  fetch('/api/atfm?region=' + encodeURIComponent(code)).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
    if (_atfmRegion !== code) return;
    _atfmRegionData = d;
    if (!_atfmTapped) _atfmRenderBar();
  }).catch(function () { if (_atfmRegion === code && !quiet && !_atfmTapped) bar.innerHTML = '<div class="atfm-empty">載入失敗 Load failed</div>'; });
}
