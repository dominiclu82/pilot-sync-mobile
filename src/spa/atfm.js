// ── ATFM 流量管制（地圖版，多地區）──────────────────────────────────────────────
var _atfmRegions = [
  { code: 'apac', name: 'APAC', center: [20, 116], zoom: 4 },
  { code: 'tw', name: 'Taiwan', center: [24.2, 121], zoom: 7 },
  { code: 'jp', name: 'Japan', center: [37, 138], zoom: 5 },
  { code: 'kr', name: 'Korea', center: [36.5, 127.8], zoom: 7 },
  { code: 'hk', name: 'Hong Kong', center: [22.31, 113.92], zoom: 9 },
  { code: 'mo', name: 'Macau', center: [22.15, 113.57], zoom: 11 },
  { code: 'th', name: 'Thailand', center: [13.9, 100.7], zoom: 6 },
  { code: 'us', name: 'US', center: [39, -98], zoom: 4 }
];
var _atfmRegion = 'apac';
var _atfmMapObj = null;
var _atfmMarkerLayer = null;
var _atfmAirports = null;   // apac 機場狀態快取
var _atfmUpdated = '';
var _atfmTimer = null;
var _atfmUiReady = false;
var _atfmDepArr = 'dep';      // CTOT 表目前顯示 dep / arr / other
var _atfmDepArrAuto = true;   // true=自動挑有資料的(預設DEP);使用者手動點過就false鎖定
var _atfmRegionData = null;   // 目前地區的資料(切 DEP/ARR 不重抓)
var _atfmCLR = { grey: '#6b7280', green: '#22c55e', amber: '#f59e0b', red: '#ef4444' };

function _atfmEsc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }
function _atfmCur() { for (var i = 0; i < _atfmRegions.length; i++) if (_atfmRegions[i].code === _atfmRegion) return _atfmRegions[i]; return _atfmRegions[0]; }

function atfmInit() {
  if (!_atfmMapObj && typeof L !== 'undefined') {
    _atfmMapObj = L.map('atfm-map', { zoomControl: true, attributionControl: false }).setView([20, 116], 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 11, minZoom: 2 }).addTo(_atfmMapObj);
    _atfmMarkerLayer = L.layerGroup().addTo(_atfmMapObj);
  }
  if (!_atfmUiReady) { _atfmRenderRegions(); _atfmUiReady = true; }
  setTimeout(function () { if (_atfmMapObj) _atfmMapObj.invalidateSize(); }, 120);
  _atfmLoadApac();
  if (_atfmRegion !== 'apac') _atfmLoadRegion(_atfmRegion);
  _atfmStartAuto();
}
function _atfmStartAuto() {
  if (_atfmTimer) clearInterval(_atfmTimer);
  _atfmTimer = setInterval(function () {
    var tab = document.getElementById('tab-atfm');
    if (tab && tab.style.display !== 'none') { _atfmLoadApac(true); if (_atfmRegion !== 'apac') _atfmLoadRegion(_atfmRegion, true); }
    else _atfmStopAuto();
  }, 45000);
}
function _atfmStopAuto() { if (_atfmTimer) { clearInterval(_atfmTimer); _atfmTimer = null; } }

function _atfmRenderRegions() {
  var el = document.getElementById('atfm-regions');
  if (!el) return;
  el.innerHTML = _atfmRegions.map(function (r) {
    return '<button class="atfm-rgn' + (r.code === _atfmRegion ? ' atfm-rgn-on' : '') + '" onclick="atfmSetRegion(\'' + r.code + '\')">' + r.name + '</button>';
  }).join('');
}
function atfmSetRegion(code) {
  _atfmRegion = code;
  _atfmDepArr = 'dep'; _atfmDepArrAuto = true; _atfmSearch = ''; _atfmRegionData = null;  // 切地區重設、自動挑
  _atfmRenderRegions();
  var r = _atfmCur();
  if (_atfmMapObj) _atfmMapObj.flyTo(r.center, r.zoom, { duration: 0.6 });
  if (code === 'apac') _atfmShowRestrictions();
  else _atfmLoadRegion(code);
}

// APAC：機場狀態 → 地圖點
function _atfmLoadApac(quiet) {
  fetch('/api/atfm?region=apac').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
    _atfmAirports = d.airports || [];
    _atfmUpdated = d.updated || '';
    _atfmPlotMarkers();
    if (_atfmRegion === 'apac') _atfmShowRestrictions();
  }).catch(function () { });
}
function _atfmPlotMarkers() {
  if (!_atfmMarkerLayer) return;
  _atfmMarkerLayer.clearLayers();
  (_atfmAirports || []).forEach(function (a) {
    var ctrl = (a.color === 'amber' || a.color === 'red');
    var mk = L.circleMarker([a.lat, a.lon], { radius: ctrl ? 8 : 5, color: '#0a0e1a', weight: 1, fillColor: _atfmCLR[a.color] || _atfmCLR.grey, fillOpacity: .95 });
    if (ctrl) {
      var ty = a.type || 'GDP';
      var bb = _atfmMBadge[ty] || _atfmMBadge['GDP'];
      mk.bindPopup('<div class="atfm-pp"><b>' + _atfmEsc(a.icao) + '</b><br><span class="atfm-pp-ty" style="background:' + bb[0] + ';color:' + bb[1] + '">' + _atfmEsc(ty) + '</span><br><div style="margin-top:4px;max-width:230px;color:#222;line-height:1.4">' + _atfmEsc(a.text) + '</div></div>');
      mk.bindTooltip(a.icao, { permanent: true, direction: 'top', className: 'atfm-lbl', offset: [0, -8] });
    } else {
      mk.bindTooltip('<b>' + _atfmEsc(a.icao) + '</b> · ' + (a.color === 'grey' ? 'No data' : 'Normal'), { direction: 'top', offset: [0, -6] });
    }
    mk.addTo(_atfmMarkerLayer);
  });
}
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
  bar.innerHTML = h;
}

// 地區：CTOT 表
var _atfmMBadge = {
  'FLOW CONTROL': ['#fff3cd', '#7d4e00'], 'ATFM MEASURE': ['#fde8e8', '#b91c1c'], 'GDP': ['#ffedd5', '#9a3412'],
  'GROUND STOP': ['#fee2e2', '#991b1b'], 'LVL RESTRICTION': ['#e0f2fe', '#0369a1'], 'MDI': ['#ede9fe', '#6d28d9'],
  'CTOT TRIAL': ['#f3f4f6', '#374151'], 'NOTICE': ['#f3f4f6', '#374151'],
  'CLOSURE': ['#fee2e2', '#991b1b'], 'GROUND STOP': ['#fee2e2', '#991b1b']
};
var _atfmSearch = '';
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
function atfmSetDepArr(which) { _atfmDepArr = which; _atfmDepArrAuto = false; _atfmRenderRegion(); }
function atfmSearchCtot(v) { _atfmSearch = v || ''; var el = document.getElementById('atfm-ctot-body'); if (el) el.innerHTML = _atfmCtotBodyHtml(); }
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
    bar.innerHTML = h; return;
  }
  var ctot = d.ctot || [];
  var nd = ctot.filter(function (c) { return c.dir === 'DEP'; }).length;
  var na = ctot.filter(function (c) { return c.dir === 'ARR'; }).length;
  var no = ctot.filter(function (c) { return c.dir !== 'DEP' && c.dir !== 'ARR'; }).length;
  // 自動模式:預設DEP,但DEP空就跳到有資料的(避免漏看到達)
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
  if (!quiet) bar.innerHTML = '<div class="atfm-bar-h">Loading…</div>';
  fetch('/api/atfm?region=' + encodeURIComponent(code)).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
    if (_atfmRegion !== code) return;
    _atfmRegionData = d;
    _atfmRenderRegion();
  }).catch(function () { if (_atfmRegion === code && !quiet) bar.innerHTML = '<div class="atfm-empty">載入失敗 Load failed</div>'; });
}
