/* ── ✈️ FR24 Radar ─────────────────────────────────────────────── */
var _fr24Map = null;
var _fr24PlaneLayer = null;
var _fr24LabelLayer = null;
var _fr24Flights = [];
var _fr24Filtered = [];
var _fr24Inited = false;
var _fr24ShowLabels = false;

/* auto-refresh & interpolation */
var _fr24CountdownInterval = null;
var _fr24InterpInterval = null;
var _fr24RateLimited = false;
var _fr24LastFetchTime = 0;
var _fr24Countdown = 10;
var FR24_REFRESH_SEC = 10;
var FR24_INTERP_MS = 1000;

/* callsign prefix → IATA mapping */
var _fr24PrefixMap = { SJX: 'JX', EVA: 'BR', CAL: 'CI' };
var _fr24IataToIcao = { JX: 'SJX', BR: 'EVA', CI: 'CAL' };

/* ICAO airport coordinates [lat, lon] */
var _fr24AirportDb = {
  RCTP:[25.08,121.23],RCSS:[25.07,121.55],RCKH:[22.57,120.35],RCMQ:[24.26,120.62],
  RJTT:[35.55,139.78],RJAA:[35.76,140.39],RJBB:[34.43,135.24],RJCC:[42.77,141.69],
  RJFF:[33.59,130.45],RJOO:[34.78,135.44],RJSN:[37.96,139.11],RJNK:[36.39,136.41],
  ROAH:[26.20,127.65],RJFK:[33.55,131.74],
  RKSI:[37.47,126.45],RKSS:[37.56,126.79],RKPC:[33.51,126.49],RKPK:[35.18,128.94],
  VHHH:[22.31,113.91],VMMC:[22.15,113.59],ZBAA:[40.08,116.58],ZSPD:[31.14,121.80],
  ZGGG:[23.39,113.30],ZUCK:[29.72,106.64],ZUUU:[30.58,103.95],ZSSS:[31.20,121.34],
  WSSS:[1.36,103.99],VTBS:[13.69,100.75],WIII:[-6.13,106.66],RPLL:[14.51,121.02],
  VVNB:[21.22,105.81],VVTS:[10.82,106.65],WMKK:[2.74,101.70],
  KLAX:[33.94,-118.41],KSFO:[37.62,-122.38],KJFK:[40.64,-73.78],KATL:[33.64,-84.43],
  KORD:[41.97,-87.91],KDFW:[32.90,-97.04],KDEN:[39.86,-104.67],KSEA:[47.45,-122.31],
  KPHX:[33.43,-112.01],KMIA:[25.80,-80.29],KLAS:[36.08,-115.15],KIAH:[29.98,-95.34],
  KEWR:[40.69,-74.17],KBOS:[42.36,-71.01],KMSP:[44.88,-93.22],KDTW:[42.21,-83.35],
  KHNL:[21.32,-157.92],
  EGLL:[51.47,-0.46],LFPG:[49.01,2.55],EDDF:[50.03,8.57],EHAM:[52.31,4.76],
  LEMD:[40.47,-3.57],LIRF:[41.80,12.24],LSZH:[47.46,8.55],LOWW:[48.11,16.57],
  EKCH:[55.62,12.66],ENGM:[60.19,11.10],EFHK:[60.32,24.96],
  OMDB:[25.25,55.36],OTHH:[25.27,51.61],OEJN:[21.68,39.16],OERK:[24.96,46.70],
  LLBG:[32.01,34.89],OIII:[35.69,51.31],
  YSSY:[-33.95,151.18],YMML:[-37.67,144.84],NZAA:[-37.01,174.79],
  CYYZ:[43.68,-79.63],CYVR:[49.19,-123.18]
};

/* ── lock/unlock landscape ── */
var _fr24LandscapeLocked = false;
var _fr24PortraitListening = false;
function _fr24LockLandscape() {
  if (window.innerWidth >= 640) return;
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').then(function() {
      _fr24LandscapeLocked = true;
      _fr24HidePortraitOverlay();
    }).catch(function() {
      _fr24StartPortraitDetect();
    });
  } else {
    _fr24StartPortraitDetect();
  }
}
function _fr24UnlockOrientation() {
  if (_fr24LandscapeLocked) {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    _fr24LandscapeLocked = false;
  }
  _fr24HidePortraitOverlay();
}
function _fr24StartPortraitDetect() {
  _fr24CheckPortrait();
  if (!_fr24PortraitListening) {
    _fr24PortraitListening = true;
    window.addEventListener('resize', _fr24CheckPortrait);
  }
}
function _fr24CheckPortrait() {
  var overlay = document.getElementById('fr24-portrait-overlay');
  if (!overlay) return;
  var isFr24 = document.getElementById('briefing-fr24') &&
    document.getElementById('briefing-fr24').classList.contains('active');
  if (!isFr24) { overlay.style.display = 'none'; return; }
  if (window.innerWidth < 640 && window.innerHeight > window.innerWidth) {
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}
function _fr24HidePortraitOverlay() {
  var overlay = document.getElementById('fr24-portrait-overlay');
  if (overlay) overlay.style.display = 'none';
}

/* ── init ── */
function fr24Init() {
  _fr24LockLandscape();
  if (_fr24Inited) {
    if (_fr24Map) _fr24Map.invalidateSize();
    _fr24StartAuto();
    return;
  }
  _fr24Inited = true;
  _fr24Map = L.map('fr24-map', {
    center: [25.0, 121.5],
    zoom: 5,
    zoomControl: false,
    worldCopyJump: true
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '\u00a9 OpenStreetMap \u00a9 CARTO',
    maxZoom: 18
  }).addTo(_fr24Map);
  L.control.zoom({ position: 'topright' }).addTo(_fr24Map);
  _fr24PlaneLayer = L.layerGroup().addTo(_fr24Map);
  _fr24LabelLayer = L.layerGroup().addTo(_fr24Map);

  var sb = document.getElementById('fr24-sidebar');
  var tbtn = document.getElementById('fr24-sidebar-toggle');
  L.DomEvent.disableClickPropagation(sb);
  L.DomEvent.disableScrollPropagation(sb);
  L.DomEvent.disableClickPropagation(tbtn);

  _fr24Map.on('moveend', function() {
    var allCheck = document.getElementById('fr24-f-all');
    if (allCheck && allCheck.checked) fr24ApplyFilter();
  });

  _fr24RestoreSettings();
  _fr24UpdateTogglePos();

  fr24FetchData();
  _fr24StartAuto();
}

/* ── fetch data ── */
function fr24FetchData() {
  var countEl = document.getElementById('fr24-count');
  if (countEl) countEl.textContent = 'Loading...';
  fetch('/api/fr24')
    .then(function(r) {
      if (r.status === 429) return r.json().then(function(d) { d._httpStatus = 429; return d; });
      return r.json();
    })
    .then(function(data) {
      if (data._httpStatus === 429 || data.error === 'rate_limit') {
        _fr24RateLimited = true;
        _fr24StopAuto();
        _fr24UpdateStatus();
        return;
      }
      if (data.error) {
        if (countEl) countEl.textContent = 'Error: ' + data.error;
        return;
      }
      _fr24RateLimited = false;
      _fr24LastFetchTime = Date.now();
      _fr24Flights = data.flights || [];
      _fr24UpdateStatus();
      fr24ApplyFilter();
    })
    .catch(function() {
      if (countEl) countEl.textContent = 'Fetch error';
    });
}

/* ── manual refresh ── */
function fr24ManualRefresh() {
  _fr24Countdown = FR24_REFRESH_SEC;
  fr24FetchData();
}

/* ── auto-refresh ── */
function _fr24StartAuto() {
  _fr24StopAuto();
  if (_fr24RateLimited) return;
  _fr24Countdown = FR24_REFRESH_SEC;
  _fr24UpdateStatus();
  _fr24CountdownInterval = setInterval(function() {
    _fr24Countdown--;
    if (_fr24Countdown <= 0) {
      _fr24Countdown = FR24_REFRESH_SEC;
      fr24FetchData();
    }
    _fr24UpdateStatus();
  }, 1000);
  _fr24InterpInterval = setInterval(_fr24Interpolate, FR24_INTERP_MS);
}

function _fr24StopAuto() {
  if (_fr24CountdownInterval) { clearInterval(_fr24CountdownInterval); _fr24CountdownInterval = null; }
  if (_fr24InterpInterval) { clearInterval(_fr24InterpInterval); _fr24InterpInterval = null; }
}

function fr24StopAll() {
  _fr24StopAuto();
}

/* ── status display ── */
function _fr24UpdateStatus() {
  var el = document.getElementById('fr24-status');
  if (!el) return;
  if (_fr24RateLimited) {
    el.innerHTML = '<span style="color:#f87171">\ud83d\udd34 \u88ab\u9650\u901f Throttled</span>';
  } else {
    el.innerHTML = '<span style="color:#4ade80">\ud83d\udfe2 Auto ' + _fr24Countdown + 's</span>';
  }
}

/* ── interpolation ── */
function _fr24Interpolate() {
  if (!_fr24Map || _fr24RateLimited) return;
  var elapsed = (Date.now() - _fr24LastFetchTime) / 1000;
  _fr24PlaneLayer.eachLayer(function(marker) {
    var f = marker._fr24Data;
    if (!f || f.gnd) return;
    var lat0 = f.lat, lon0 = f.lon;
    var spdKt = f.spd, hdg = f.hdg;
    if (lat0 == null || lon0 == null || spdKt == null || hdg == null || spdKt < 10) return;
    var spd = spdKt * 0.514444; /* knots → m/s */
    var dist = spd * elapsed;
    var R = 6371000;
    var brng = hdg * Math.PI / 180;
    var lat1 = lat0 * Math.PI / 180;
    var lon1 = lon0 * Math.PI / 180;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(dist / R) + Math.cos(lat1) * Math.sin(dist / R) * Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dist / R) * Math.cos(lat1), Math.cos(dist / R) - Math.sin(lat1) * Math.sin(lat2));
    marker.setLatLng([lat2 * 180 / Math.PI, lon2 * 180 / Math.PI]);
  });
  if (_fr24ShowLabels) {
    var labelLayers = _fr24LabelLayer.getLayers();
    var planeLayers = _fr24PlaneLayer.getLayers();
    for (var i = 0; i < labelLayers.length && i < planeLayers.length; i++) {
      labelLayers[i].setLatLng(planeLayers[i].getLatLng());
    }
  }
}

/* ── convert callsign to display name ── */
function _fr24DisplayName(cs) {
  for (var prefix in _fr24PrefixMap) {
    if (cs.indexOf(prefix) === 0) {
      return _fr24PrefixMap[prefix] + cs.substring(prefix.length);
    }
  }
  return cs;
}

/* ── apply filter & render ── */
function fr24ApplyFilter() {
  if (!_fr24Map) return;
  _fr24PlaneLayer.clearLayers();
  _fr24LabelLayer.clearLayers();

  var allCheck = document.getElementById('fr24-f-all');
  var showAll = allCheck && allCheck.checked;
  var prefixes = [];

  if (!showAll) {
    if (document.getElementById('fr24-f-jx').checked) prefixes.push('SJX');
    if (document.getElementById('fr24-f-br').checked) prefixes.push('EVA');
    if (document.getElementById('fr24-f-ci').checked) prefixes.push('CAL');
    var custom = (document.getElementById('fr24-f-custom').value || '').toUpperCase().split(',');
    for (var i = 0; i < custom.length; i++) {
      var c = custom[i].trim();
      if (c && prefixes.indexOf(c) < 0) prefixes.push(c);
    }
  }

  var bounds = null;
  var MAX_ALL = 500;
  if (showAll) bounds = _fr24Map.getBounds();

  _fr24Filtered = [];
  for (var j = 0; j < _fr24Flights.length; j++) {
    var f = _fr24Flights[j];
    var cs = f.cs || '';
    if (!cs) continue;
    var lat = f.lat, lon = f.lon;
    if (lat == null || lon == null) continue;

    if (showAll) {
      if (!bounds.contains([lat, lon])) continue;
      if (_fr24Filtered.length >= MAX_ALL) continue;
    } else if (prefixes.length > 0) {
      var match = false;
      for (var k = 0; k < prefixes.length; k++) {
        if (cs.indexOf(prefixes[k]) === 0) { match = true; break; }
      }
      if (!match) continue;
    }

    _fr24Filtered.push(f);
    var heading = f.hdg || 0;
    var icon = L.divIcon({
      className: 'live-plane-icon',
      html: '<div style="transform:rotate(' + heading + 'deg)">\u2708</div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    var marker = L.marker([lat, lon], { icon: icon });
    marker._fr24Data = f;
    marker.on('click', function(e) {
      _fr24ShowPopup(e.target);
    });
    _fr24PlaneLayer.addLayer(marker);

    if (_fr24ShowLabels) {
      var altStr = f.alt != null ? Math.round(f.alt).toLocaleString() : '';
      var labelHtml = '<div class="live-label">' + _fr24DisplayName(cs) +
        (altStr ? '<br>' + altStr + ' ft' : '') + '</div>';
      var labelIcon = L.divIcon({
        className: 'live-label-icon',
        html: labelHtml,
        iconSize: [0, 0],
        iconAnchor: [-12, 10]
      });
      _fr24LabelLayer.addLayer(L.marker([lat, lon], { icon: labelIcon, interactive: false }));
    }
  }

  var countEl = document.getElementById('fr24-count');
  if (countEl) {
    var cntText = _fr24Filtered.length + ' aircraft';
    if (showAll && _fr24Filtered.length >= MAX_ALL) cntText += ' (max ' + MAX_ALL + ')';
    countEl.textContent = cntText;
  }

  _fr24RenderFlightList();
  _fr24SaveSettings();
}

/* ── render flight list ── */
function _fr24RenderFlightList() {
  var el = document.getElementById('fr24-flight-list');
  if (!el) return;
  if (_fr24Filtered.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:.7em;text-align:center;padding:8px">No flights</div>';
    return;
  }
  var html = '<table class="live-list-table"><thead><tr><th>Flight</th><th>From</th><th>To</th><th>Alt</th></tr></thead><tbody>';
  for (var i = 0; i < _fr24Filtered.length; i++) {
    var f = _fr24Filtered[i];
    var display = _fr24DisplayName(f.cs);
    var altFt = f.alt != null ? Math.round(f.alt).toLocaleString() : '\u2014';
    var from = f.from || '\u2014';
    var to = f.to || '\u2014';
    html += '<tr data-idx="' + i + '" onclick="_fr24ListClick(' + i + ')">' +
      '<td>' + display + '</td>' +
      '<td>' + from + '</td>' +
      '<td>' + to + '</td>' +
      '<td>' + altFt + '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

/* ── flight list click ── */
function _fr24ListClick(idx) {
  var f = _fr24Filtered[idx];
  if (!f || !_fr24Map) return;
  var lat = f.lat, lon = f.lon;
  if (lat == null || lon == null) return;
  _fr24Map.flyTo([lat, lon], 8, { duration: 0.8 });
  _fr24PlaneLayer.eachLayer(function(layer) {
    if (layer._fr24Data === f) _fr24ShowPopup(layer);
  });
}

/* ── popup info card ── */
function _fr24ShowPopup(marker) {
  var f = marker._fr24Data;
  var cs = f.cs || '';
  var display = _fr24DisplayName(cs);
  var altFt = f.alt != null ? Math.round(f.alt).toLocaleString() + ' ft' : '\u2014';
  var spdKt = f.spd != null ? Math.round(f.spd) + ' kt' : '\u2014';
  var hdg = f.hdg != null ? Math.round(f.hdg) + '\u00b0' : '\u2014';
  var vs = f.vs != null ? (f.vs >= 0 ? '+' : '') + Math.round(f.vs) + ' ft/min' : '\u2014';
  var ground = f.gnd ? 'Yes' : 'No';
  var squawk = f.sq || '\u2014';
  var icao24 = f.icao24 || '\u2014';
  var reg = f.reg || '\u2014';
  var type = f.type || '\u2014';
  var from = f.from || '\u2014';
  var to = f.to || '\u2014';
  var lat = f.lat != null ? f.lat.toFixed(4) : '\u2014';
  var lon = f.lon != null ? f.lon.toFixed(4) : '\u2014';
  var route = from + ' \u2192 ' + to;

  var html = '<div class="live-popup">' +
    '<div class="live-popup-title">' + display + '</div>' +
    '<div style="font-size:.9em;color:#60a5fa;margin-bottom:6px">' + route + '</div>' +
    '<table class="live-popup-table">' +
    '<tr><td>Type</td><td>' + type + '</td></tr>' +
    '<tr><td>Reg</td><td>' + reg + '</td></tr>' +
    '<tr><td>Position</td><td>' + lat + '\u00b0, ' + lon + '\u00b0</td></tr>' +
    '<tr><td>Altitude</td><td>' + altFt + '</td></tr>' +
    '<tr><td>Speed</td><td>' + spdKt + '</td></tr>' +
    '<tr><td>Heading</td><td>' + hdg + '</td></tr>' +
    '<tr><td>V/S</td><td>' + vs + '</td></tr>' +
    '<tr><td>On Ground</td><td>' + ground + '</td></tr>' +
    '<tr><td>Squawk</td><td>' + squawk + '</td></tr>' +
    '<tr><td>ICAO24</td><td>' + icao24 + '</td></tr>' +
    '</table></div>';

  marker.unbindPopup();
  marker.bindPopup(html, { className: 'live-popup-wrap', maxWidth: 260 }).openPopup();
}

/* ── toggle labels ── */
function fr24ToggleLabels() {
  _fr24ShowLabels = document.getElementById('fr24-f-labels').checked;
  fr24ApplyFilter();
}

/* ── search flight by number ── */
function fr24SearchFlight() {
  var msgEl = document.getElementById('fr24-search-msg');
  if (msgEl) msgEl.textContent = '';
  var raw = (document.getElementById('fr24-f-custom').value || '').trim().toUpperCase();
  if (!raw) return;
  var hasDigit = /\d/.test(raw);
  if (!hasDigit) { fr24ApplyFilter(); return; }
  var match = raw.match(/^([A-Z]{2,3})(\d+.*)$/);
  if (!match) { fr24ApplyFilter(); return; }
  var iataPrefix = match[1];
  var flightNum = match[2];
  var icaoPrefix = _fr24IataToIcao[iataPrefix] || iataPrefix;
  var searchCallsign = icaoPrefix + flightNum;
  var displayName = iataPrefix + flightNum;
  document.getElementById('fr24-f-custom').value = iataPrefix;
  fr24ApplyFilter();
  var found = null;
  for (var i = 0; i < _fr24Flights.length; i++) {
    var cs = _fr24Flights[i].cs || '';
    if (cs === searchCallsign || cs === searchCallsign + ' ') { found = _fr24Flights[i]; break; }
  }
  if (found) {
    var lat = found.lat, lon = found.lon;
    if (lat != null && lon != null) {
      _fr24Map.flyTo([lat, lon], 8, { duration: 0.8 });
      _fr24PlaneLayer.eachLayer(function(layer) {
        if (layer._fr24Data === found) _fr24ShowPopup(layer);
      });
    }
  } else {
    if (msgEl) msgEl.textContent = '\u26a0 ' + displayName + ' \u7121\u6b64\u822a\u73ed Not found';
    setTimeout(function() { if (msgEl) msgEl.textContent = ''; }, 5000);
  }
  document.getElementById('fr24-f-custom').value = raw;
}

/* ── jump to airport ── */
function fr24JumpTo() {
  var sel = document.getElementById('fr24-jump');
  var val = sel.value;
  if (!val || !_fr24Map) return;
  var parts = val.split(',');
  _fr24Map.flyTo([parseFloat(parts[0]), parseFloat(parts[1])], parseInt(parts[2], 10), { duration: 1 });
  sel.value = '';
}

function fr24JumpToIcao() {
  var inp = document.getElementById('fr24-jump-input');
  var code = (inp.value || '').trim().toUpperCase();
  if (!code || !_fr24Map) return;
  var coords = _fr24AirportDb[code];
  if (coords) {
    _fr24Map.flyTo(coords, 10, { duration: 1 });
    inp.value = '';
  } else {
    inp.style.borderColor = '#f44';
    setTimeout(function() { inp.style.borderColor = ''; }, 1500);
  }
}

/* ── sidebar toggle ── */
function fr24ToggleSidebar() {
  var sb = document.getElementById('fr24-sidebar');
  sb.classList.toggle('collapsed');
  _fr24UpdateTogglePos();
}

function _fr24UpdateTogglePos() {
  var sb = document.getElementById('fr24-sidebar');
  var btn = document.getElementById('fr24-sidebar-toggle');
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
function fr24SwitchSidebarPos() {
  var sb = document.getElementById('fr24-sidebar');
  if (sb.classList.contains('live-sidebar-right')) {
    sb.classList.remove('live-sidebar-right');
    sb.classList.add('live-sidebar-left');
  } else {
    sb.classList.remove('live-sidebar-left');
    sb.classList.add('live-sidebar-right');
  }
  _fr24UpdateTogglePos();
  _fr24SaveSettings();
}

/* ── toggle all flights ── */
function fr24ToggleAll() {
  var allCheck = document.getElementById('fr24-f-all');
  var jx = document.getElementById('fr24-f-jx');
  var br = document.getElementById('fr24-f-br');
  var ci = document.getElementById('fr24-f-ci');
  var custom = document.getElementById('fr24-f-custom');
  if (allCheck.checked) {
    jx.disabled = true; br.disabled = true; ci.disabled = true; custom.disabled = true;
  } else {
    jx.disabled = false; br.disabled = false; ci.disabled = false; custom.disabled = false;
  }
  fr24ApplyFilter();
}

/* ── save/restore settings ── */
function _fr24SaveSettings() {
  var sb = document.getElementById('fr24-sidebar');
  var pos = sb.classList.contains('live-sidebar-left') ? 'left' : 'right';
  var filters = {
    jx: document.getElementById('fr24-f-jx').checked,
    br: document.getElementById('fr24-f-br').checked,
    ci: document.getElementById('fr24-f-ci').checked,
    all: document.getElementById('fr24-f-all').checked,
    custom: document.getElementById('fr24-f-custom').value,
    labels: document.getElementById('fr24-f-labels').checked
  };
  try {
    localStorage.setItem('crewsync_fr24_sb', pos);
    localStorage.setItem('crewsync_fr24_filters', JSON.stringify(filters));
  } catch (e) {}
}

function _fr24RestoreSettings() {
  try {
    var pos = localStorage.getItem('crewsync_fr24_sb');
    if (pos === 'right') fr24SwitchSidebarPos();
    var f = JSON.parse(localStorage.getItem('crewsync_fr24_filters') || 'null');
    if (f) {
      document.getElementById('fr24-f-jx').checked = !!f.jx;
      document.getElementById('fr24-f-br').checked = !!f.br;
      document.getElementById('fr24-f-ci').checked = !!f.ci;
      document.getElementById('fr24-f-all').checked = !!f.all;
      document.getElementById('fr24-f-custom').value = f.custom || '';
      document.getElementById('fr24-f-labels').checked = !!f.labels;
      _fr24ShowLabels = !!f.labels;
      if (f.all) fr24ToggleAll();
    }
  } catch (e) {}
}
