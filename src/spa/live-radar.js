/* ── 📡 Live Radar ─────────────────────────────────────────────── */
var _liveMap = null;
var _livePlaneLayer = null;
var _liveLabelLayer = null;
var _liveStates = [];
var _liveFiltered = [];
var _liveInited = false;
var _liveShowLabels = false;

/* auto-refresh & interpolation */
var _liveAutoInterval = null;
var _liveCountdown = 10;
var _liveCountdownInterval = null;
var _liveInterpInterval = null;
var _liveRateLimited = false;
var _liveLastFetchTime = 0;
var LIVE_REFRESH_SEC = 10;
var LIVE_INTERP_MS = 1000;

/* callsign prefix → IATA mapping */
var _livePrefixMap = { SJX: 'JX', EVA: 'BR', CAL: 'CI' };
var _liveIataToIcao = { JX: 'SJX', BR: 'EVA', CI: 'CAL' };

/* ICAO airport coordinates [lat, lon] */
var _liveAirportDb = {
  /* Taiwan */
  RCTP:[25.08,121.23],RCSS:[25.07,121.55],RCKH:[22.57,120.35],RCMQ:[24.26,120.62],
  /* Japan */
  RJTT:[35.55,139.78],RJAA:[35.76,140.39],RJBB:[34.43,135.24],RJCC:[42.77,141.69],
  RJFF:[33.59,130.45],RJOO:[34.78,135.44],RJSN:[37.96,139.11],RJNK:[36.39,136.41],
  ROAH:[26.20,127.65],RJFK:[33.55,131.74],
  /* Korea */
  RKSI:[37.47,126.45],RKSS:[37.56,126.79],RKPC:[33.51,126.49],RKPK:[35.18,128.94],
  /* China / HK / Macau */
  VHHH:[22.31,113.91],VMMC:[22.15,113.59],ZBAA:[40.08,116.58],ZSPD:[31.14,121.80],
  ZGGG:[23.39,113.30],ZUCK:[29.72,106.64],ZUUU:[30.58,103.95],ZSSS:[31.20,121.34],
  /* Southeast Asia */
  WSSS:[1.36,103.99],VTBS:[13.69,100.75],WIII:[-6.13,106.66],RPLL:[14.51,121.02],
  VVNB:[21.22,105.81],VVTS:[10.82,106.65],WMKK:[2.74,101.70],
  /* USA */
  KLAX:[33.94,-118.41],KSFO:[37.62,-122.38],KJFK:[40.64,-73.78],KATL:[33.64,-84.43],
  KORD:[41.97,-87.91],KDFW:[32.90,-97.04],KDEN:[39.86,-104.67],KSEA:[47.45,-122.31],
  KPHX:[33.43,-112.01],KMIA:[25.80,-80.29],KLAS:[36.08,-115.15],KIAH:[29.98,-95.34],
  KEWR:[40.69,-74.17],KBOS:[42.36,-71.01],KMSP:[44.88,-93.22],KDTW:[42.21,-83.35],
  KHNL:[21.32,-157.92],
  /* Europe */
  EGLL:[51.47,-0.46],LFPG:[49.01,2.55],EDDF:[50.03,8.57],EHAM:[52.31,4.76],
  LEMD:[40.47,-3.57],LIRF:[41.80,12.24],LSZH:[47.46,8.55],LOWW:[48.11,16.57],
  EKCH:[55.62,12.66],ENGM:[60.19,11.10],EFHK:[60.32,24.96],
  /* Middle East */
  OMDB:[25.25,55.36],OTHH:[25.27,51.61],OEJN:[21.68,39.16],OERK:[24.96,46.70],
  LLBG:[32.01,34.89],OIII:[35.69,51.31],
  /* Oceania */
  YSSY:[-33.95,151.18],YMML:[-37.67,144.84],NZAA:[-37.01,174.79],
  /* Canada */
  CYYZ:[43.68,-79.63],CYVR:[49.19,-123.18]
};

/* ── lock/unlock landscape ── */
var _liveLandscapeLocked = false;
var _livePortraitListening = false;
function _liveLockLandscape() {
  if (window.innerWidth >= 640) return;
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').then(function() {
      _liveLandscapeLocked = true;
      _liveHidePortraitOverlay();
    }).catch(function() {
      _liveStartPortraitDetect();
    });
  } else {
    _liveStartPortraitDetect();
  }
}
function _liveUnlockOrientation() {
  if (_liveLandscapeLocked) {
    try {
      if (screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
    } catch (e) {}
    _liveLandscapeLocked = false;
  }
  _liveHidePortraitOverlay();
}
function _liveStartPortraitDetect() {
  _liveCheckPortrait();
  if (!_livePortraitListening) {
    _livePortraitListening = true;
    window.addEventListener('resize', _liveCheckPortrait);
  }
}
function _liveCheckPortrait() {
  var overlay = document.getElementById('live-portrait-overlay');
  if (!overlay) return;
  var isLive = document.getElementById('briefing-live') &&
    document.getElementById('briefing-live').classList.contains('active');
  if (!isLive) { overlay.style.display = 'none'; return; }
  if (window.innerWidth < 640 && window.innerHeight > window.innerWidth) {
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}
function _liveHidePortraitOverlay() {
  var overlay = document.getElementById('live-portrait-overlay');
  if (overlay) overlay.style.display = 'none';
}

/* ── init ── */
function liveInit() {
  _liveLockLandscape();
  if (_liveInited) {
    if (_liveMap) _liveMap.invalidateSize();
    _liveStartAuto();
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
  _liveLabelLayer = L.layerGroup().addTo(_liveMap);

  /* prevent Leaflet from stealing sidebar clicks */
  var sb = document.getElementById('live-sidebar');
  var tbtn = document.getElementById('live-sidebar-toggle');
  L.DomEvent.disableClickPropagation(sb);
  L.DomEvent.disableScrollPropagation(sb);
  L.DomEvent.disableClickPropagation(tbtn);

  /* re-render on map move when showing all flights */
  _liveMap.on('moveend', function() {
    var allCheck = document.getElementById('live-f-all');
    if (allCheck && allCheck.checked) liveApplyFilter();
  });

  /* restore saved settings */
  _liveRestoreSettings();
  _liveUpdateTogglePos();

  /* first fetch + start auto-refresh */
  liveFetchData();
  _liveStartAuto();
}

/* ── fetch data ── */
function liveFetchData() {
  var countEl = document.getElementById('live-count');
  if (countEl) countEl.textContent = 'Loading...';
  fetch('/api/opensky')
    .then(function(r) {
      if (r.status === 429) return r.json().then(function(d) { d._httpStatus = 429; return d; });
      return r.json();
    })
    .then(function(data) {
      if (data._httpStatus === 429 || data.error === 'rate_limit') {
        _liveRateLimited = true;
        _liveStopAuto();
        _liveUpdateStatus();
        return;
      }
      if (data.error) {
        if (countEl) countEl.textContent = 'Error: ' + data.error;
        return;
      }
      _liveRateLimited = false;
      _liveLastFetchTime = Date.now();
      _liveStates = data.states || [];
      /* update credits display */
      if (data._remaining != null) {
        var credEl = document.getElementById('live-credits');
        if (credEl) credEl.textContent = data._remaining.toLocaleString() + ' credits';
      }
      liveApplyFilter();
    })
    .catch(function() {
      if (countEl) countEl.textContent = 'Fetch error';
    });
}

/* ── manual refresh (button click) ── */
function liveManualRefresh() {
  _liveCountdown = LIVE_REFRESH_SEC;
  liveFetchData();
}

/* ── auto-refresh start/stop ── */
function _liveStartAuto() {
  _liveStopAuto();
  if (_liveRateLimited) return;
  _liveCountdown = LIVE_REFRESH_SEC;
  _liveUpdateStatus();
  /* countdown tick every 1s */
  _liveCountdownInterval = setInterval(function() {
    _liveCountdown--;
    if (_liveCountdown <= 0) {
      _liveCountdown = LIVE_REFRESH_SEC;
      liveFetchData();
    }
    _liveUpdateStatus();
  }, 1000);
  /* interpolation tick */
  _liveInterpInterval = setInterval(_liveInterpolate, LIVE_INTERP_MS);
}

function _liveStopAuto() {
  if (_liveCountdownInterval) { clearInterval(_liveCountdownInterval); _liveCountdownInterval = null; }
  if (_liveInterpInterval) { clearInterval(_liveInterpInterval); _liveInterpInterval = null; }
}

function liveStopAll() {
  _liveStopAuto();
}

/* ── status display ── */
function _liveUpdateStatus() {
  var statusEl = document.getElementById('live-auto-status');
  if (!statusEl) return;
  if (_liveRateLimited) {
    statusEl.innerHTML = '<span style="color:#f87171">🔴 額度已滿 Daily limit reached</span>';
  } else {
    statusEl.innerHTML = '<span style="color:#4ade80">🟢 Auto ' + _liveCountdown + 's</span>';
  }
}

/* ── interpolation: move planes between API refreshes ── */
function _liveInterpolate() {
  if (!_liveMap || _liveRateLimited) return;
  var elapsed = (Date.now() - _liveLastFetchTime) / 1000;
  _livePlaneLayer.eachLayer(function(marker) {
    var s = marker._oskyState;
    if (!s || s[8]) return; /* skip if on ground */
    var lat0 = s[6], lon0 = s[5];
    var spd = s[9]; /* m/s */
    var hdg = s[10]; /* degrees */
    if (lat0 == null || lon0 == null || spd == null || hdg == null || spd < 10) return;
    var dist = spd * elapsed; /* meters */
    var R = 6371000;
    var brng = hdg * Math.PI / 180;
    var lat1 = lat0 * Math.PI / 180;
    var lon1 = lon0 * Math.PI / 180;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(dist / R) + Math.cos(lat1) * Math.sin(dist / R) * Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dist / R) * Math.cos(lat1), Math.cos(dist / R) - Math.sin(lat1) * Math.sin(lat2));
    var newLat = lat2 * 180 / Math.PI;
    var newLon = lon2 * 180 / Math.PI;
    marker.setLatLng([newLat, newLon]);
  });
  /* also move labels */
  if (_liveShowLabels) {
    var labelLayers = _liveLabelLayer.getLayers();
    var planeLayers = _livePlaneLayer.getLayers();
    for (var i = 0; i < labelLayers.length && i < planeLayers.length; i++) {
      labelLayers[i].setLatLng(planeLayers[i].getLatLng());
    }
  }
}

/* ── convert callsign to display name ── */
function _liveDisplayName(cs) {
  for (var prefix in _livePrefixMap) {
    if (cs.indexOf(prefix) === 0) {
      return _livePrefixMap[prefix] + cs.substring(prefix.length);
    }
  }
  return cs;
}

/* ── apply filter & render ── */
function liveApplyFilter() {
  if (!_liveMap) return;
  _livePlaneLayer.clearLayers();
  _liveLabelLayer.clearLayers();

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

  /* viewbox bounds for All flights mode */
  var bounds = null;
  var MAX_ALL = 500;
  if (showAll) bounds = _liveMap.getBounds();

  _liveFiltered = [];
  for (var j = 0; j < _liveStates.length; j++) {
    var s = _liveStates[j];
    var cs = (s[1] || '').trim();
    if (!cs) continue;
    var lat = s[6], lon = s[5];
    if (lat == null || lon == null) continue;

    if (showAll) {
      /* only show planes within visible map area */
      if (!bounds.contains([lat, lon])) continue;
      if (_liveFiltered.length >= MAX_ALL) continue;
    } else if (prefixes.length > 0) {
      var match = false;
      for (var k = 0; k < prefixes.length; k++) {
        if (cs.indexOf(prefixes[k]) === 0) { match = true; break; }
      }
      if (!match) continue;
    }

    _liveFiltered.push(s);
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

    /* label */
    if (_liveShowLabels) {
      var altFt = s[7] != null ? Math.round(s[7] * 3.28084) : null;
      var altStr = altFt != null ? altFt.toLocaleString() : '';
      var labelHtml = '<div class="live-label">' + _liveDisplayName(cs) +
        (altStr ? '<br>' + altStr + ' ft' : '') + '</div>';
      var labelIcon = L.divIcon({
        className: 'live-label-icon',
        html: labelHtml,
        iconSize: [0, 0],
        iconAnchor: [-12, 10]
      });
      _liveLabelLayer.addLayer(L.marker([lat, lon], { icon: labelIcon, interactive: false }));
    }
  }

  var countEl = document.getElementById('live-count');
  if (countEl) {
    var cntText = _liveFiltered.length + ' aircraft';
    if (showAll && _liveFiltered.length >= MAX_ALL) cntText += ' (max ' + MAX_ALL + ')';
    countEl.textContent = cntText;
  }

  /* update flight list */
  _liveRenderFlightList();

  /* save filter settings */
  _liveSaveSettings();
}

/* ── render flight list ── */
function _liveRenderFlightList() {
  var el = document.getElementById('live-flight-list');
  if (!el) return;
  if (_liveFiltered.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:.7em;text-align:center;padding:8px">No flights</div>';
    return;
  }
  var html = '<table class="live-list-table"><thead><tr><th>Flight</th><th>Alt</th><th>Spd</th></tr></thead><tbody>';
  for (var i = 0; i < _liveFiltered.length; i++) {
    var s = _liveFiltered[i];
    var cs = (s[1] || '').trim();
    var display = _liveDisplayName(cs);
    var altFt = s[7] != null ? Math.round(s[7] * 3.28084).toLocaleString() : '—';
    var spdKt = s[9] != null ? Math.round(s[9] * 1.94384) : '—';
    html += '<tr data-idx="' + i + '" onclick="_liveListClick(' + i + ')">' +
      '<td>' + display + '</td>' +
      '<td>' + altFt + '</td>' +
      '<td>' + spdKt + '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

/* ── flight list click → fly to plane ── */
function _liveListClick(idx) {
  var s = _liveFiltered[idx];
  if (!s || !_liveMap) return;
  var lat = s[6], lon = s[5];
  if (lat == null || lon == null) return;
  _liveMap.flyTo([lat, lon], 8, { duration: 0.8 });
  /* find marker and open popup */
  _livePlaneLayer.eachLayer(function(layer) {
    if (layer._oskyState === s) {
      _liveShowPopup(layer);
    }
  });
}

/* ── popup info card ── */
function _liveShowPopup(marker) {
  var s = marker._oskyState;
  var cs = (s[1] || '').trim();
  var display = _liveDisplayName(cs);
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

/* ── toggle labels ── */
function liveToggleLabels() {
  _liveShowLabels = document.getElementById('live-f-labels').checked;
  liveApplyFilter();
}

/* ── jump to airport ── */
function liveJumpTo() {
  var sel = document.getElementById('live-jump');
  var val = sel.value;
  if (!val || !_liveMap) return;
  var parts = val.split(',');
  var lat = parseFloat(parts[0]);
  var lon = parseFloat(parts[1]);
  var zoom = parseInt(parts[2], 10);
  _liveMap.flyTo([lat, lon], zoom, { duration: 1 });
  sel.value = '';
}

/* ── jump by ICAO code input ── */
function liveJumpToIcao() {
  var inp = document.getElementById('live-jump-input');
  var code = (inp.value || '').trim().toUpperCase();
  if (!code || !_liveMap) return;
  var coords = _liveAirportDb[code];
  if (coords) {
    _liveMap.flyTo(coords, 10, { duration: 1 });
    inp.value = '';
  } else {
    inp.style.borderColor = '#f44';
    setTimeout(function() { inp.style.borderColor = ''; }, 1500);
  }
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
  var isMobile = window.innerWidth < 640;
  var isCollapsed = sb.classList.contains('collapsed');
  if (isMobile) {
    btn.style.right = '';
    btn.style.left = isCollapsed ? '6px' : '';
    btn.style.display = isCollapsed ? '' : 'none';
    return;
  }
  var isRight = sb.classList.contains('live-sidebar-right');
  var sbWidth = 266;
  if (isRight) {
    btn.style.left = '';
    btn.style.right = isCollapsed ? '6px' : (sbWidth + 6) + 'px';
  } else {
    btn.style.right = '';
    btn.style.left = isCollapsed ? '6px' : (sbWidth + 6) + 'px';
  }
  btn.style.display = '';
}

/* ── sidebar left/right switch ── */
function liveSwitchSidebarPos() {
  var sb = document.getElementById('live-sidebar');
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
    custom: document.getElementById('live-f-custom').value,
    labels: document.getElementById('live-f-labels').checked
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
      document.getElementById('live-f-labels').checked = !!f.labels;
      _liveShowLabels = !!f.labels;
      if (f.all) liveToggleAll();
    }
  } catch (e) {}
}
