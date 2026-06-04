// runway-map.js — 共用跑道圖引擎（CrewSync 主 App 的 roster WX 用）。
// 依賴 window._PL_AIRPORTS（airport-db.js 須先載入）。Pilot Log 另有自己一份同等實作（pilot-log.js），互不共用、各自維護。
// 對外 API（window.RwyMap）：
//   .html(code)           → 該機場跑道圖 HTML（含 data-rwy-icao 的 svg；查無資料回 ''）
//   .parseWind(metarText) → {dir,spd} 或 null
//   .setWind(icao, wind)  → 設風向快取（供 .html / .applyWind 上色）
//   .applyWind(icao)      → 依快取重繪已在 DOM 的該機場跑道圖（綠橘端 + 風分量 + 風向箭頭）
//   .aptInfo(code)        → 機場資訊（查無回 null）
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var _idx = null, _idxSrc = null;
  function aptInfo(code) {
    code = (code == null ? '' : String(code)).toUpperCase().trim();
    if (!code || !window._PL_AIRPORTS) return null;
    if (_idxSrc !== window._PL_AIRPORTS) {   // 機場庫載入/更換後重建索引（ICAO + IATA 都可查）
      _idx = {}; var A = window._PL_AIRPORTS;
      for (var i = 0; i < A.length; i++) { var a = A[i]; if (a[0] && !_idx[a[0]]) _idx[a[0]] = a; if (a[1] && !_idx[a[1]]) _idx[a[1]] = a; }
      _idxSrc = window._PL_AIRPORTS;
    }
    var r = _idx[code]; if (!r) return null;
    return { icao: r[0], iata: r[1], name: r[2], city: r[3], lat: r[5], lon: r[6], tz: r[7] || '', runways: r[10] || [] };
  }

  // 視野：涵蓋所有跑道、置中 + 30% 邊距，維持 640:440 地面比例（經度按 cos(lat) 補償，座向不歪）。
  function view(info) {
    var ASPECT = 640 / 440, cosL = Math.cos((info.lat || 0) * Math.PI / 180) || 1;
    var la = [], lo = [];
    (info.runways || []).forEach(function (r) {
      if (r[2] != null && r[3] != null) { la.push(r[2]); lo.push(r[3]); }
      if (r[4] != null && r[5] != null) { la.push(r[4]); lo.push(r[5]); }
    });
    var cLat = info.lat, cLon = info.lon, halfLat;
    if (la.length) {
      var laMin = Math.min.apply(null, la), laMax = Math.max.apply(null, la);
      var loMin = Math.min.apply(null, lo), loMax = Math.max.apply(null, lo);
      cLat = (laMin + laMax) / 2; cLon = (loMin + loMax) / 2;
      var needLat = (laMax - laMin) / 2, needLon = (loMax - loMin) / 2;
      halfLat = Math.max(needLat, needLon * cosL / ASPECT) * 1.3;
      halfLat = Math.max(halfLat, 0.006);
    } else { halfLat = 0.022; }
    return { lat: cLat, lon: cLon, halfLat: halfLat, halfLon: halfLat * ASPECT / cosL };
  }
  function mapUrl(lat, lon, halfLat, halfLon) {
    var dLat = halfLat || 0.022, dLon = halfLon || 0.032;
    var bbox = (lon - dLon) + ',' + (lat - dLat) + ',' + (lon + dLon) + ',' + (lat + dLat);
    return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=' + bbox + '&bboxSR=4326&imageSR=4326&size=640,440&format=png&f=image';
  }
  function bearing(la1, lo1, la2, lo2) {
    var d = Math.PI / 180, p1 = la1 * d, p2 = la2 * d, dl = (lo2 - lo1) * d;
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function endColor(landingHdg, windDir) {
    if (windDir == null) return '#9ca3af';
    return Math.cos((windDir - landingHdg) * Math.PI / 180) >= 0 ? '#22c55e' : '#f97316';
  }
  function endMark(end, other, ident, color) {
    var dx = other[0] - end[0], dy = other[1] - end[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
    var cx = end[0] + dx / len * 16, cy = end[1] + dy / len * 16, ang = Math.atan2(dy, dx) * 180 / Math.PI;
    var w = 30, h = 17;
    return '<g transform="translate(' + cx.toFixed(1) + ',' + cy.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')">' +
        '<rect x="' + (-w / 2) + '" y="' + (-h / 2) + '" width="' + w + '" height="' + h + '" rx="3" fill="' + color + '" stroke="#000" stroke-opacity="0.35"/></g>' +
      (ident ? '<text x="' + cx.toFixed(1) + '" y="' + cy.toFixed(1) + '" font-size="12" font-weight="800" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="central">' + esc(ident) + '</text>' : '');
  }
  function windArrow(wind) {
    if (!wind || wind.dir == null) return '';
    var cx = 42, cy = 38, r = 17, to = (wind.dir + 180) % 360, a = (to - 90) * Math.PI / 180;
    var tx = cx + Math.cos(a) * r, ty = cy + Math.sin(a) * r, bx = cx - Math.cos(a) * r, by = cy - Math.sin(a) * r;
    var head = function (da) { var h = (to - 90 + da) * Math.PI / 180; return '<line x1="' + tx.toFixed(1) + '" y1="' + ty.toFixed(1) + '" x2="' + (tx + Math.cos(h) * 8).toFixed(1) + '" y2="' + (ty + Math.sin(h) * 8).toFixed(1) + '" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'; };
    return '<rect x="10" y="12" width="64" height="54" rx="6" fill="#000" fill-opacity="0.4"/>' +
      '<line x1="' + bx.toFixed(1) + '" y1="' + by.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y2="' + ty.toFixed(1) + '" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' +
      head(152) + head(-152) +
      '<text x="42" y="61" font-size="11" font-weight="700" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle">' + esc(wind.dir + '°/' + (wind.spd != null ? wind.spd : '?')) + '</text>';
  }
  function arrow(x1, y1, x2, y2, color, w) {
    var ang = Math.atan2(y2 - y1, x2 - x1);
    var hx = function (da) { return (x2 + Math.cos(ang + Math.PI + da) * 6).toFixed(1); };
    var hy = function (da) { return (y2 + Math.sin(ang + Math.PI + da) * 6).toFixed(1); };
    return '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + color + '" stroke-width="' + w + '" stroke-linecap="round"/>' +
      '<polyline points="' + hx(0.5) + ',' + hy(0.5) + ' ' + x2.toFixed(1) + ',' + y2.toFixed(1) + ' ' + hx(-0.5) + ',' + hy(-0.5) + '" fill="none" stroke="' + color + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"/>';
  }
  function windComp(x1, y1, x2, y2, hdgLe, wind) {
    if (!wind || wind.dir == null || wind.spd == null || wind.spd === 0) return '';
    var wd = wind.dir, sp = wind.spd;
    var favHdg = Math.cos((wd - hdgLe) * Math.PI / 180) >= 0 ? hdgLe : (hdgLe + 180) % 360;
    var hw = Math.round(sp * Math.cos((wd - favHdg) * Math.PI / 180));
    var xwS = sp * Math.sin((wd - favHdg) * Math.PI / 180), xw = Math.abs(Math.round(xwS));
    var fx, fy, tx, ty;
    if (favHdg === hdgLe) { fx = x1; fy = y1; tx = x2; ty = y2; } else { fx = x2; fy = y2; tx = x1; ty = y1; }
    var dx = tx - fx, dy = ty - fy, dl = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dl, uy = dy / dl, nx = -uy, ny = ux, sgn = xwS >= 0 ? 1 : -1;
    var px = fx + dx * 0.26, py = fy + dy * 0.26;
    var out = arrow(px, py, px - ux * 10, py - uy * 10, '#4ade80', 2.5) +
      '<text x="' + (px - ux * 10 + nx * 7 * sgn).toFixed(1) + '" y="' + (py - uy * 10 + ny * 7 * sgn).toFixed(1) + '" font-size="9.5" font-weight="800" fill="#4ade80" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="central">' + hw + '</text>';
    if (xw > 0) {
      out += arrow(px, py, px + nx * 8 * sgn, py + ny * 8 * sgn, '#fb923c', 2.5) +
        '<text x="' + (px + nx * 16 * sgn).toFixed(1) + '" y="' + (py + ny * 16 * sgn).toFixed(1) + '" font-size="9.5" font-weight="800" fill="#fb923c" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="central">' + xw + '</text>';
    }
    return out;
  }
  function overlay(info, v, wind) {
    var W = 640, H = 440;
    var lonMin = v.lon - v.halfLon, lonMax = v.lon + v.halfLon, latMin = v.lat - v.halfLat, latMax = v.lat + v.halfLat;
    var wd = wind ? wind.dir : null, s = '';
    (info.runways || []).forEach(function (r) {
      if (r[2] == null || r[3] == null || r[4] == null || r[5] == null) return;
      var x1 = (r[3] - lonMin) / (lonMax - lonMin) * W, y1 = (latMax - r[2]) / (latMax - latMin) * H;
      var x2 = (r[5] - lonMin) / (lonMax - lonMin) * W, y2 = (latMax - r[4]) / (latMax - latMin) * H;
      var hdgLe = bearing(r[2], r[3], r[4], r[5]);
      s += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="#f8fafc" stroke-width="9" stroke-opacity="0.5" stroke-linecap="butt"/>';
      if (r[6]) {
        var mx = (x1 + x2) / 2, my = (y1 + y2) / 2, ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
        var dim = Math.round(r[6]) + (r[7] ? ' × ' + Math.round(r[7]) : '') + ' ft';
        s += '<g transform="translate(' + mx.toFixed(1) + ',' + my.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')"><text font-size="11" font-weight="600" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="central">' + esc(dim) + '</text></g>';
      }
      s += endMark([x1, y1], [x2, y2], r[0], endColor(hdgLe, wd));
      s += endMark([x2, y2], [x1, y1], r[1], endColor((hdgLe + 180) % 360, wd));
      s += windComp(x1, y1, x2, y2, hdgLe, wind);
    });
    return s + windArrow(wind);
  }

  var windCache = {};
  function mapHtml(code) {
    var info = aptInfo(code);
    if (!info || info.lat == null || info.lon == null) return '';
    var v = view(info), W = 640, H = 440, rwys = info.runways || [];
    var has = rwys.some(function (r) { return r[2] != null && r[4] != null; });
    var txtFb = '';
    if (!has && rwys.length) {
      var rows = rwys.map(function (r) {
        return (r[0] || '') + (r[1] ? '/' + r[1] : '') + (r[6] ? '　' + Math.round(r[6]) + (r[7] ? ' × ' + Math.round(r[7]) : '') + ' ft' : '');
      });
      txtFb = '<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:14px;color:#cbd5e1;font-size:.82em;line-height:1.7">' +
        '<div style="font-weight:700;color:#94a3b8;letter-spacing:.5px;font-size:.8em;margin-bottom:4px">RUNWAYS</div>' +
        rows.map(function (t) { return '<div>' + esc(t) + '</div>'; }).join('') + '</div>';
    }
    var img = '<img src="' + mapUrl(v.lat, v.lon, v.halfLat, v.halfLon) + '" alt="satellite" onerror="this.style.display=\'none\'" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block" loading="lazy">';
    var inner = has ? overlay(info, v, windCache[info.icao] || null) : '';
    var svg = inner ? '<svg data-rwy-icao="' + esc(info.icao || '') + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">' + inner + '</svg>' : '';
    return '<div class="rg-rwymap" style="position:relative;margin:6px 0;border-radius:8px;overflow:hidden;background:#0e1525;aspect-ratio:' + W + '/' + H + '">' + txtFb + img + svg + '</div>';
  }
  function parseWind(metar) {
    if (!metar) return null;
    var line = (metar.trim().split('\n').filter(function (l) { return l.trim() && !l.startsWith('No'); })[0]) || '';
    var m = /\b(\d{3})(\d{2,3})(?:G\d{2,3})?(KT|MPS)\b/.exec(line);
    if (!m) return null;
    var spd = parseInt(m[2], 10);
    if (m[3] === 'MPS') spd = Math.round(spd * 1.944);
    return { dir: parseInt(m[1], 10), spd: spd };
  }
  function applyWind(icao) {
    var svgs = document.querySelectorAll('svg[data-rwy-icao="' + icao + '"]');
    if (!svgs.length) return;
    var info = aptInfo(icao); if (!info) return;
    var html = overlay(info, view(info), windCache[icao] || null);
    for (var i = 0; i < svgs.length; i++) svgs[i].innerHTML = html;
  }
  // 預抓一批機場的衛星底圖進永久快取（SW 攔 Esri 存 plapt-maps）。呼叫端負責先等 SW 控制頁面。
  function prefetch(codes) {
    if (!window._PL_AIRPORTS || !codes) return;
    codes.forEach(function (code) {
      var info = aptInfo(code); if (!info || info.lat == null || info.lon == null) return;
      var v = view(info);
      try { fetch(mapUrl(v.lat, v.lon, v.halfLat, v.halfLon), { mode: 'no-cors' }); } catch (e) {}
    });
    if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
  }
  window.RwyMap = {
    html: mapHtml, parseWind: parseWind, applyWind: applyWind, aptInfo: aptInfo, prefetch: prefetch,
    setWind: function (icao, w) { if (icao) windCache[icao] = w; }
  };
})();
