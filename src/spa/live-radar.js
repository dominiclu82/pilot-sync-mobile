/* ── 📡 Live Radar ─────────────────────────────────────────────── */
var _liveMap = null;
var _livePlaneLayer = null;
var _liveStates = [];
var _liveInited = false;

/* callsign prefix → IATA mapping */
var _livePrefixMap = { SJX: 'JX', EVA: 'BR', CAL: 'CI' };
var _liveIataToIcao = { JX: 'SJX', BR: 'EVA', CI: 'CAL' };

/* ── init ── */
function liveInit() {
  if (_liveInited) {
    if (_liveMap) _liveMap.invalidateSize();
    return;
  }
  _liveInited = true;
  _liveMap = L.map('live-map', {
    center: [25.0, 121.5],
    zoom: 5,
    zoomControl: false,
    worldCopyJump: true
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    maxZoom: 18
  }).addTo(_liveMap);
  L.control.zoom({ position: 'topright' }).addTo(_liveMap);
  _livePlaneLayer = L.layerGroup().addTo(_liveMap);

  /* prevent Leaflet from stealing sidebar clicks */
  var sb = document.getElementById('live-sidebar');
  var tbtn = document.getElementById('live-sidebar-toggle');
  L.DomEvent.disableClickPropagation(sb);
  L.DomEvent.disableScrollPropagation(sb);
  L.DomEvent.disableClickPropagation(tbtn);

  /* restore saved settings */
  _liveRestoreSettings();
  _liveUpdateTogglePos();

  /* first fetch */
  liveFetchData();
}

/* ── fetch data ── */
function liveFetchData() {
  var countEl = document.getElementById('live-count');
  if (countEl) countEl.textContent = 'Loading...';
  fetch('/api/opensky')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        if (countEl) countEl.textContent = 'Error: ' + data.error;
        return;
      }
      _liveStates = data.states || [];
      liveApplyFilter();
    })
    .catch(function(e) {
      if (countEl) countEl.textContent = 'Fetch error';
    });
}

/* ── apply filter & render ── */
function liveApplyFilter() {
  if (!_liveMap) return;
  _livePlaneLayer.clearLayers();

  var allCheck = document.getElementById('live-f-all');
  var showAll = allCheck && allCheck.checked;
  var prefixes = [];

  if (!showAll) {
    if (document.getElementById('live-f-jx').checked) prefixes.push('SJX');
    if (document.getElementById('live-f-br').checked) prefixes.push('EVA');
    if (document.getElementById('live-f-ci').checked) prefixes.push('CAL');
    var custom = (document.getElementById('live-f-custom').value || '').toUpperCase().split(',');
    for (var i = 0; i < custom.length; i++) {
      var c = custom[i].trim();
      if (c && prefixes.indexOf(c) < 0) prefixes.push(c);
    }
  }

  var count = 0;
  for (var j = 0; j < _liveStates.length; j++) {
    var s = _liveStates[j];
    var cs = (s[1] || '').trim();
    if (!cs) continue;
    var lat = s[6], lon = s[5];
    if (lat == null || lon == null) continue;

    if (!showAll && prefixes.length > 0) {
      var match = false;
      for (var k = 0; k < prefixes.length; k++) {
        if (cs.indexOf(prefixes[k]) === 0) { match = true; break; }
      }
      if (!match) continue;
    }

    count++;
    var heading = s[10] || 0;
    var icon = L.divIcon({
      className: 'live-plane-icon',
      html: '<div style="transform:rotate(' + heading + 'deg)">✈</div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    var marker = L.marker([lat, lon], { icon: icon });
    marker._oskyState = s;
    marker.on('click', function(e) {
      _liveShowPopup(e.target);
    });
    _livePlaneLayer.addLayer(marker);
  }

  var countEl = document.getElementById('live-count');
  if (countEl) countEl.textContent = count + ' aircraft';

  /* save filter settings */
  _liveSaveSettings();
}

/* ── popup info card ── */
function _liveShowPopup(marker) {
  var s = marker._oskyState;
  var cs = (s[1] || '').trim();
  var display = cs;
  /* convert ICAO callsign to IATA */
  for (var prefix in _livePrefixMap) {
    if (cs.indexOf(prefix) === 0) {
      display = _livePrefixMap[prefix] + cs.substring(prefix.length);
      break;
    }
  }
  var baroFt = s[7] != null ? Math.round(s[7] * 3.28084).toLocaleString() + ' ft' : '—';
  var geoFt = s[13] != null ? Math.round(s[13] * 3.28084).toLocaleString() + ' ft' : '—';
  var spdKt = s[9] != null ? Math.round(s[9] * 1.94384) + ' kt' : '—';
  var hdg = s[10] != null ? Math.round(s[10]) + '°' : '—';
  var vs = s[11] != null ? (s[11] >= 0 ? '+' : '') + Math.round(s[11] * 196.85) + ' ft/min' : '—';
  var ground = s[8] ? 'Yes' : 'No';
  var squawk = s[14] || '—';
  var icao24 = s[0] || '—';
  var country = s[2] || '—';
  var lat = s[6] != null ? s[6].toFixed(4) : '—';
  var lon = s[5] != null ? s[5].toFixed(4) : '—';

  var html = '<div class="live-popup">' +
    '<div class="live-popup-title">' + display + '</div>' +
    '<table class="live-popup-table">' +
    '<tr><td>Country</td><td>' + country + '</td></tr>' +
    '<tr><td>Position</td><td>' + lat + '°, ' + lon + '°</td></tr>' +
    '<tr><td>Baro Alt</td><td>' + baroFt + '</td></tr>' +
    '<tr><td>Geo Alt</td><td>' + geoFt + '</td></tr>' +
    '<tr><td>Speed</td><td>' + spdKt + '</td></tr>' +
    '<tr><td>Heading</td><td>' + hdg + '</td></tr>' +
    '<tr><td>V/S</td><td>' + vs + '</td></tr>' +
    '<tr><td>On Ground</td><td>' + ground + '</td></tr>' +
    '<tr><td>Squawk</td><td>' + squawk + '</td></tr>' +
    '<tr><td>ICAO24</td><td>' + icao24 + '</td></tr>' +
    '</table></div>';

  marker.unbindPopup();
  marker.bindPopup(html, { className: 'live-popup-wrap', maxWidth: 250 }).openPopup();
}

/* ── sidebar toggle ── */
function liveToggleSidebar() {
  var sb = document.getElementById('live-sidebar');
  sb.classList.toggle('collapsed');
  _liveUpdateTogglePos();
}

function _liveUpdateTogglePos() {
  var sb = document.getElementById('live-sidebar');
  var btn = document.getElementById('live-sidebar-toggle');
  var isRight = sb.classList.contains('live-sidebar-right');
  var isCollapsed = sb.classList.contains('collapsed');
  if (isRight) {
    btn.style.left = '';
    btn.style.right = isCollapsed ? '6px' : '186px';
  } else {
    btn.style.right = '';
    btn.style.left = isCollapsed ? '6px' : '186px';
  }
}

/* ── sidebar left/right switch ── */
function liveSwitchSidebarPos() {
  var sb = document.getElementById('live-sidebar');
  var btn = document.getElementById('live-sidebar-toggle');
  if (sb.classList.contains('live-sidebar-right')) {
    sb.classList.remove('live-sidebar-right');
    sb.classList.add('live-sidebar-left');
  } else {
    sb.classList.remove('live-sidebar-left');
    sb.classList.add('live-sidebar-right');
  }
  _liveUpdateTogglePos();
  _liveSaveSettings();
}

/* ── toggle all flights ── */
function liveToggleAll() {
  var allCheck = document.getElementById('live-f-all');
  var jx = document.getElementById('live-f-jx');
  var br = document.getElementById('live-f-br');
  var ci = document.getElementById('live-f-ci');
  var custom = document.getElementById('live-f-custom');
  if (allCheck.checked) {
    jx.disabled = true; br.disabled = true; ci.disabled = true; custom.disabled = true;
  } else {
    jx.disabled = false; br.disabled = false; ci.disabled = false; custom.disabled = false;
  }
  liveApplyFilter();
}

/* ── save/restore settings ── */
function _liveSaveSettings() {
  var sb = document.getElementById('live-sidebar');
  var pos = sb.classList.contains('live-sidebar-left') ? 'left' : 'right';
  var filters = {
    jx: document.getElementById('live-f-jx').checked,
    br: document.getElementById('live-f-br').checked,
    ci: document.getElementById('live-f-ci').checked,
    all: document.getElementById('live-f-all').checked,
    custom: document.getElementById('live-f-custom').value
  };
  try {
    localStorage.setItem('crewsync_live_sb', pos);
    localStorage.setItem('crewsync_live_filters', JSON.stringify(filters));
  } catch (e) {}
}

function _liveRestoreSettings() {
  try {
    var pos = localStorage.getItem('crewsync_live_sb');
    if (pos === 'right') liveSwitchSidebarPos();
    var f = JSON.parse(localStorage.getItem('crewsync_live_filters') || 'null');
    if (f) {
      document.getElementById('live-f-jx').checked = !!f.jx;
      document.getElementById('live-f-br').checked = !!f.br;
      document.getElementById('live-f-ci').checked = !!f.ci;
      document.getElementById('live-f-all').checked = !!f.all;
      document.getElementById('live-f-custom').value = f.custom || '';
      if (f.all) liveToggleAll();
    }
  } catch (e) {}
}
