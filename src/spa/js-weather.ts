export function getSpaWeatherJs(): string {
  return `
// ── 航路氣象 ──────────────────────────────────────────────────────────────────
// WX_AIRPORTS 由 _wxFleetData 動態取得（資料定義在 airport-data.js）
var wxCurrentFleet = (function() { try { var f = localStorage.getItem('crewsync_fleet'); if (f && _wxFleetData[f]) return f; } catch(e) {} return 'A350-900'; })();
var wxCurrentRegion = 'taiwan';
var wxMetarMap = {};      // icao -> parsed metar object (cleared when region changes)
var wxCacheTime = null;   // timestamp of last successful fetch (ms)
var wxMetarRawMap = {};   // icao -> string[] of 6h METAR lines
var wxMetarShowAll = {};  // icao -> bool (true = show all 6h, false = latest 1)
var wxDetailCache = {};   // icao -> rendered HTML string (persists across airport switches)
var wxDetailRawCache = {}; // icao -> { metar:[], taf:'', atis:[], atisSrc:'', time:number }
var _atisSrc = {};         // icao -> 選用來源:undefined/'primary'=server(FAA/airframes)、'guru'=atis.guru
var _atisLevel = 'none';   // 創始身份(server 回傳),決定顯不顯示「換來源」鈕。不存 localStorage → 每次連線重問當前帳號,避免共用瀏覽器跨帳號繼承
var _atisLevelKnown = false;   // 本次連線是否已確知身份(避免每次快取命中都重複探)
var wxSelectedIcao = '';
var wxSelectedName = '';
var wxLoaded = false;
var _wxRefreshing = false;

function wxGetAirports(region) {
  return ((_wxFleetData[wxCurrentFleet] || {})[region]) || [];
}

function wxSwitchFleet(sel) {
  wxCurrentFleet = sel.value;
  try { localStorage.setItem('crewsync_fleet', wxCurrentFleet); } catch(e) {}
  wxSelectedIcao = '';
  wxSelectedName = '';
  wxDetailCache = {};
  document.getElementById('wx-detail-pane').innerHTML = '<div class="wx-empty"><span class="wx-hint-desktop">\\u2190 點選左側機場</span><span class="wx-hint-mobile">\\u2191 點選上方機場</span><br>查看 METAR \\u00b7 TAF \\u00b7 ATIS</div>';
  if (typeof switchBriefingTab === 'function') { switchBriefingTab('datis', document.getElementById('subtabBtn-datis')); }
  loadWxRegion(wxCurrentRegion);
}

function wxCalcCat(m) {
  if (!m) return 'UNKN';
  var sky = m.sky || [];
  var ceilings = sky.filter(function(s) { return s.cover === 'BKN' || s.cover === 'OVC' || s.cover === 'OVX'; });
  var ceiling = ceilings.length > 0 ? Math.min.apply(null, ceilings.map(function(s) { return Number(s.base) || 0; })) : 99999;
  var vis = parseFloat(String(m.visib || '10+').replace('+','')) || 10;
  if (ceiling < 500 || vis < 1) return 'LIFR';
  if (ceiling < 1000 || vis < 3) return 'IFR';
  if (ceiling < 3000 || vis < 5) return 'MVFR';
  return 'VFR';
}

function wxFmtWind(m) {
  if (!m || m.wspd === undefined || m.wspd === null) return '--';
  if (m.wspd === 0) return 'Calm';
  var dir = (m.wdir === 'VRB') ? 'VRB' : (String(m.wdir || 0).padStart(3,'0') + '\\u00b0');
  var gst = m.wgst ? '/G' + m.wgst : '';
  return dir + '\\u00a0' + m.wspd + 'kt' + gst;
}

function wxFmtVis(m) {
  if (!m || m.visib === undefined) return '--';
  var v = String(m.visib);
  return (v === '10+' ? '>10' : v) + 'SM';
}

function wxFmtTemp(m) {
  if (!m || m.temp === undefined || m.temp === null) return '--';
  return m.temp + '\\u00b0C';
}

function selectWxRegion(region, btn) {
  wxCurrentRegion = region;
  wxSelectedIcao = '';
  wxSelectedName = '';
  document.querySelectorAll('.wx-route-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  document.getElementById('wx-detail-pane').innerHTML = '<div class="wx-empty"><span class="wx-hint-desktop">\\u2190 點選左側機場</span><span class="wx-hint-mobile">\\u2191 點選上方機場</span><br>查看 METAR \\u00b7 TAF \\u00b7 ATIS</div>';
  loadWxRegion(region);
}

function parseMetarLine(raw) {
  if (!raw || !raw.trim()) return null;
  var s = raw.trim();
  var result = {};
  // Wind: 36008KT, 36008G20KT, VRB03KT, 00000KT
  var wm = s.match(/\\b(\\d{3}|VRB)(\\d{2,3})(G(\\d{2,3}))?KT\\b/);
  if (wm) {
    result.wdir = wm[1] === 'VRB' ? 'VRB' : parseInt(wm[1]);
    result.wspd = parseInt(wm[2]);
    if (wm[4]) result.wgst = parseInt(wm[4]);
  }
  // CAVOK
  if (/\\bCAVOK\\b/.test(s)) { result.visib = '10+'; result.sky = []; return result; }
  // Visibility SM (US/Canada): 10SM, 6SM, 1/2SM, M1/4SM
  var vSM = s.match(/\\b(M?[\\d]+(?:\\/\\d+)?)\\s*SM\\b/);
  if (vSM) {
    var vStr = vSM[1].replace('M','');
    var vVal = vStr.indexOf('/') >= 0
      ? parseInt(vStr.split('/')[0]) / parseInt(vStr.split('/')[1])
      : parseFloat(vStr);
    result.visib = vVal >= 10 ? '10+' : String(Math.round(vVal * 10) / 10);
  } else {
    // Visibility meters (ICAO): 9999, 0800, 3000
    var vM = s.match(/\\b(\\d{4})\\b/);
    if (vM) {
      var meters = parseInt(vM[1]);
      result.visib = meters >= 9000 ? '10+' : String(Math.round(meters / 160.934) / 10);
    }
  }
  // Sky conditions
  result.sky = [];
  var skyRe = /(BKN|OVC|FEW|SCT)(\\d{3})/g;
  var m2;
  while ((m2 = skyRe.exec(s)) !== null) {
    result.sky.push({ cover: m2[1], base: parseInt(m2[2]) * 100 });
  }
  // VV (vertical visibility): treat as OVC
  var vv = s.match(/\\bVV(\\d{3})\\b/);
  if (vv) result.sky.push({ cover: 'OVC', base: parseInt(vv[1]) * 100 });
  // Temperature: 15/11 or M01/M05
  var tm = s.match(/\\b(M?\\d{2})\\/(M?\\d{2})\\b/);
  if (tm) result.temp = tm[1].charAt(0) === 'M' ? -parseInt(tm[1].slice(1)) : parseInt(tm[1]);
  // Observation time: DDHHMMZ
  var om = s.match(/\\b(\\d{2})(\\d{2})(\\d{2})Z\\b/);
  if (om) { result.obsDay = parseInt(om[1]); result.obsHour = parseInt(om[2]); result.obsMin = parseInt(om[3]); }
  return result;
}

function wxMinsAgo(m) {
  if (!m || m.obsDay === undefined) return null;
  var now = new Date();
  var obs = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), m.obsDay, m.obsHour, m.obsMin));
  if (obs > now) obs.setUTCMonth(obs.getUTCMonth() - 1);
  return Math.round((now - obs) / 60000);
}

function loadWxRegion(region) {
  var airports = wxGetAirports(region);
  // 嘗試從 localStorage 讀取快取
  try {
    var cached = localStorage.getItem('crewsync_metar_' + region);
    if (cached) {
      var c = JSON.parse(cached);
      wxMetarMap = c.data || {};
      wxCacheTime = c.time || null;
    } else { wxMetarMap = {}; wxCacheTime = null; }
  } catch(e) { wxMetarMap = {}; wxCacheTime = null; }
  renderWxList(airports, region);
  if (airports.length === 0) return;
  var icaos = airports.map(function(a) { return a.icao; }).join(',');
  fetch('/api/metar?ids=' + icaos + '&hours=6')
    .then(function(r) { return r.ok ? r.text() : Promise.reject(); })
    .then(function(text) {
      wxMetarMap = {};
      text.split('\\n').forEach(function(line) {
        line = line.trim();
        if (!line) return;
        var stripped = line.replace(/^(METAR|SPECI)\\s+/, '');
        var icao = stripped.split(' ')[0].toUpperCase();
        if (/^[A-Z]{4}$/.test(icao) && !wxMetarMap[icao]) wxMetarMap[icao] = parseMetarLine(stripped);
      });
      wxCacheTime = Date.now();
      try { localStorage.setItem('crewsync_metar_' + region, JSON.stringify({data: wxMetarMap, time: wxCacheTime})); } catch(e) {}
      renderWxList(airports, region);
    })
    .catch(function() { renderWxList(airports, region); });
}

function renderWxList(airports, region) {
  if (!airports || airports.length === 0) {
    document.getElementById('wx-list-pane').innerHTML = '<div class="wx-empty" style="padding:24px 16px;font-size:.82em;line-height:1.8">'
      + '目前在 Ops Spec. 裡無符合機場<br><span style="color:var(--dim)">No authorized airports in current Ops Spec.</span></div>';
    return;
  }
  var ts = wxCacheTime ? (function(d){ return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + 'Z'; })(new Date(wxCacheTime)) : '—';
  var cacheAge = wxCacheTime ? Math.round((Date.now() - wxCacheTime) / 60000) : null;
  var cacheNote = cacheAge !== null && cacheAge > 5 ? ' <span style="color:#f59e0b;font-size:.85em">(' + cacheAge + 'm ago)</span>' : '';
  var hdr = '<div class="wx-list-hdr"><span class="wx-list-ts">METAR ' + ts + cacheNote + '</span>'
    + '<button class="wx-refresh-btn" id="wx-region-refresh-btn" onclick="wxRefreshRegion()">\\u21ba</button></div>';
  var cards = airports.map(function(a) {
    var m = wxMetarMap[a.icao];
    var cat = wxCalcCat(m);
    var cardCls = 'wx-card-' + (a.cls || 'r');
    var sel = (a.icao === wxSelectedIcao) ? ' selected' : '';
    var mins = wxMinsAgo(m);
    var ageClass = mins > 90 ? ' stale' : mins > 60 ? ' warn' : '';
    var ageText = mins > 90 ? 'expired' : mins + 'm';
    var ageHtml = mins !== null ? '<div class="wx-obs-age' + ageClass + '">' + ageText + '</div>' : '';
    return '<div class="wx-card ' + cardCls + sel + '" onclick="selectWxAirport(\\'' + a.icao + '\\',\\'' + a.name + '\\',this)">'
      + '<div class="wx-row">'
      + '<div class="wx-cat cat-' + cat + '">' + cat + '</div>'
      + '<div class="wx-icao-col">' + a.icao + '</div>'
      + '<div class="wx-name-col"><div class="wx-aname">' + a.name + '</div>'
      + '<div class="wx-wind">' + wxFmtWind(m) + '</div></div>'
      + '<div style="text-align:right;flex-shrink:0"><div class="wx-mini">' + wxFmtVis(m) + '<br>' + wxFmtTemp(m) + '</div>' + ageHtml + '</div>'
      + '</div></div>';
  }).join('');
  var bx = 'display:inline-block;width:14px;height:12px;border-radius:2px;vertical-align:middle;margin-right:4px';
  var legend = '<div class="wx-legend">'
    + '<span style="' + bx + ';border:2px solid var(--accent)"></span>Regular&nbsp;&nbsp;'
    + '<span style="' + bx + ';border:2px dashed var(--accent);opacity:.8"></span>Alternate&nbsp;&nbsp;'
    + '<span style="color:#b45309;font-weight:700">Special</span>'
    + '</div>'
    + '<details class="wx-flt-def">'
    + '<summary>&#9656; Flight Category Definition</summary>'
    + '<div class="wx-flt-def-body">'
    + '<div style="color:var(--muted);font-style:italic;font-size:.95em">FAA Flight Category (used by aviationweather.gov)</div>'
    + '<div><span class="wx-cat cat-VFR">VFR</span> Ceiling &ge; 3000 ft AGL &amp; Vis &ge; 5 SM &mdash; VMC</div>'
    + '<div><span class="wx-cat cat-MVFR">MVFR</span> Ceiling 1000&ndash;2999 ft AGL or Vis 3&ndash;4 SM &mdash; Marginal VMC</div>'
    + '<div><span class="wx-cat cat-IFR">IFR</span> Ceiling 500&ndash;999 ft AGL or Vis 1&ndash;2 SM &mdash; IMC</div>'
    + '<div><span class="wx-cat cat-LIFR">LIFR</span> Ceiling &lt; 500 ft AGL or Vis &lt; 1 SM &mdash; Low IMC</div>'
    + '<div><span class="wx-cat cat-UNKN">UNKN</span> No METAR data available</div>'
    + '<div style="margin-top:2px;font-style:italic;font-size:.95em">ICAO standard uses VMC / IMC only. VFR/MVFR &#8776; VMC; IFR/LIFR &#8776; IMC.</div>'
    + '</div></details>';
  document.getElementById('wx-list-pane').innerHTML = hdr + cards + legend;
}

function selectWxAirport(icao, name, rowEl) {
  document.querySelectorAll('.wx-card').forEach(function(r) { r.classList.remove('selected'); });
  rowEl.classList.add('selected');
  wxSelectedIcao = icao;
  wxSelectedName = name;
  var m = wxMetarMap[icao];
  var cat = wxCalcCat(m);
  var detailPane = document.getElementById('wx-detail-pane');
  detailPane.innerHTML = '<div class="wx-detail-hdr">'
    + '<div class="wx-detail-title">' + icao + '\\u3000' + name + '</div>'
    + '<div class="wx-cat cat-' + cat + '">' + cat + '</div>'
    + '<button class="wx-refresh-btn" id="wx-detail-refresh-btn" style="margin-left:4px" onclick="refreshWxDetail(\\'' + icao + '\\',\\'' + name + '\\')">\\u21ba 更新</button>'
    + '</div>'
    + '<div id="wx-detail-content">'
    + (wxDetailCache[icao] ? wxDetailCache[icao] : '<div class="atis-loading">載入詳細資料...</div>')
    + '</div>';
  if (!wxDetailCache[icao]) fetchWxDetail(icao, name);
  if (window.innerWidth < 640) detailPane.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function refreshWxDetail(icao, name) {
  delete wxDetailCache[icao];
  delete wxDetailRawCache[icao];
  _wxSaveDetailCache();
  var content = document.getElementById('wx-detail-content');
  if (content) content.innerHTML = '<div class="atis-loading">重新載入...</div>';
  var btn = document.getElementById('wx-detail-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '\\u21ba ...'; }
  fetchWxDetail(icao, name);
}

function buildMetarCard(icao) {
  var lines = wxMetarRawMap[icao] || [];
  var showAll = !!wxMetarShowAll[icao];
  var noData = '<span style="color:var(--muted);font-style:italic">\\u7121\\u8cc7\\u6599</span>';
  var displayText = lines.length === 0 ? noData : (showAll ? lines.join('\\n\\n') : lines[0]);
  var toggleBtns = lines.length > 1
    ? '<div style="display:flex;gap:4px;margin-left:auto">'
      + '<button onclick="setMetarMode(\\'' + icao + '\\',false)" class="metar-mode-btn' + (!showAll ? ' active' : '') + '">\\u6700\\u65b0</button>'
      + '<button onclick="setMetarMode(\\'' + icao + '\\',true)" class="metar-mode-btn' + (showAll ? ' active' : '') + '">6\\u5c0f\\u6642</button>'
      + '</div>'
    : '';
  return '<div class="atis-card" id="wx-metar-card"><div class="atis-card-title" style="display:flex;align-items:center">\\ud83c\\udf24\\ufe0f METAR'
    + toggleBtns + '</div><pre>' + displayText + '</pre></div>';
}

function setMetarMode(icao, showAll) {
  wxMetarShowAll[icao] = showAll;
  delete wxDetailCache[icao];
  if (wxSelectedIcao !== icao) return;
  var content = document.getElementById('wx-detail-content');
  if (!content) return;
  var metarCard = document.getElementById('wx-metar-card');   // 精準換 METAR 卡：跑道圖卡現在排在 METAR 前，不能盲取第一張 .atis-card（codex P1）
  if (metarCard && metarCard.parentNode) {
    var tmp = document.createElement('div');
    tmp.innerHTML = buildMetarCard(icao);
    metarCard.parentNode.replaceChild(tmp.firstChild, metarCard);
  }
}

// 跑道圖收合（比照 roster / Pilot Log，狀態記 localStorage）。
function _wxRwyMapCollapsed() {
  try { return localStorage.getItem('crewsync_wxmap_collapsed') === '1'; } catch (e) { return false; }
}
function _wxToggleRwyMap() {
  var c = !_wxRwyMapCollapsed();
  try { localStorage.setItem('crewsync_wxmap_collapsed', c ? '1' : '0'); } catch (e) {}
  var bodies = document.querySelectorAll('.wx-rwymap-body');
  for (var i = 0; i < bodies.length; i++) bodies[i].style.display = c ? 'none' : '';
  var arrows = document.querySelectorAll('.wx-rwymap-arrow');
  for (var j = 0; j < arrows.length; j++) arrows[j].textContent = c ? '\\u25b8' : '\\u25be';
}
function _wxBuildDetailHtml(icao, metarLines, tafText, atisSections, atisSource) {
  var noData = '<span style="color:var(--muted);font-style:italic">\\u7121\\u8cc7\\u6599</span>';
  wxMetarRawMap[icao] = metarLines;
  if (wxMetarShowAll[icao] === undefined) wxMetarShowAll[icao] = false;
  var cards = '';
  // 跑道圖（依最新 METAR 風向標綠[逆風]/橘[順風]端 + 風分量 + 風向箭頭），比照 roster / Pilot Log。點標題可收合。
  if (typeof RwyMap !== 'undefined' && RwyMap.aptInfo(icao)) {
    if (metarLines && metarLines[0]) RwyMap.setWind(icao, RwyMap.parseWind(metarLines[0]));
    var _mh = RwyMap.html(icao);
    if (_mh) {
      var _col = _wxRwyMapCollapsed();
      cards += '<div class="atis-card"><div class="atis-card-title" style="cursor:pointer" onclick="_wxToggleRwyMap()">\\ud83d\\uddfa\\ufe0f \\u8dd1\\u9053\\u5716 Runway <span class="wx-rwymap-arrow" style="margin-left:auto">' + (_col ? '\\u25b8' : '\\u25be') + '</span></div><div class="wx-rwymap-body" style="display:' + (_col ? 'none' : '') + '">' + _mh + '</div></div>';
    }
  }
  cards += buildMetarCard(icao);
  cards += '<div class="atis-card"><div class="atis-card-title">\\ud83d\\udcc5 TAF</div><pre>' + (tafText || noData) + '</pre></div>';
  // atisSections===null = 還在背景載(顯示「載入中」,不卡 METAR/TAF/跑道圖)；[] = 無資料；有 = 各 ATIS 卡。
  if (atisSections === null) {
    cards += '<div class="atis-card"><div class="atis-card-title">\\ud83d\\udcfb ATIS</div><pre><span style="color:var(--muted)">\\u8f09\\u5165\\u4e2d\\u2026 Loading\\u2026</span></pre></div>';
  } else {
    var atisOnly = atisSections.filter(function(s) {
      var t = s.title.toLowerCase(); return !t.includes('metar') && !t.includes('taf');
    });
    var srcBar = _atisSrcBar(icao, atisSource);   // 來源標籤/切換鈕(創始會員一律有,連無資料時也在 → 切得回去)
    var srcRight = srcBar ? '<span style="margin-left:auto">' + srcBar + '</span>' : '';
    if (atisOnly.length > 0) {
      cards += atisOnly.map(function(s, i) {
        return '<div class="atis-card"><div class="atis-card-title" style="display:flex;align-items:center;gap:6px">' + s.title + (i === 0 ? srcRight : '') + '</div><pre>' + s.text + '</pre></div>';
      }).join('');
    } else {
      cards += '<div class="atis-card"><div class="atis-card-title" style="display:flex;align-items:center;gap:6px">\\ud83d\\udcfb ATIS' + srcRight + '</div><pre>' + noData + '</pre></div>';
    }
  }
  return cards;
}

/* ── ATIS 來源切換(創始會員)──────────────────────────────────────────
   美國場:FAA ⇄ atis.guru;其他全部:airframes ⇄ atis.guru。一般會員只看標籤、讀快取。 */
function _wxAtisFallback(icao) {   // atis.guru(經 allorigins，client 端抓，免額度)
  return fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent('https://atis.guru/atis/' + icao))
    .then(function (r) { return r.ok ? r.text() : ''; }).then(parseAtisHtml).catch(function () { return []; });
}
/* 抓 ATIS,回 {sections, source}。chosen==='guru' 用 atis.guru;否則用 server(FAA/airframes),fresh=強制跳快取重抓 */
function _wxAtisFetch(icao, chosen, fresh) {
  var viaGuru = function () { return _wxAtisFallback(icao).then(function (secs) { return { sections: secs, source: secs.length ? 'atis.guru' : '' }; }); };
  if (chosen === 'guru') return viaGuru();
  return fetch('/api/atis?icao=' + icao + (fresh ? '&fresh=1' : ''), { headers: (typeof _plAtHeaders === 'function' ? _plAtHeaders() : {}) })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d && typeof d.level !== 'undefined') { _atisLevel = d.level; _atisLevelKnown = true; }
      if (d && d.sections) return { sections: d.sections, source: d.source || '' };
      return viaGuru();                                  // server 回 fallback → 退 atis.guru
    })
    .catch(function () { return viaGuru(); });            // server 非 JSON / 網路錯 → 退 atis.guru
}
/* 只探「創始身份」用:打輕端點 /api/atis-level(不抓 ATIS、不扣額度、不碰快取資料) */
function _wxAtisProbeLevel() {
  return fetch('/api/atis-level', { headers: (typeof _plAtHeaders === 'function' ? _plAtHeaders() : {}) })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && typeof d.level !== 'undefined') { _atisLevel = d.level; _atisLevelKnown = true; } })
    .catch(function () { });
}
/* ATIS 卡的來源標籤。創始會員=可按的切換鈕,顯示「按下去會切到的來源」(目標),且「一律顯示」連目前來源沒資料時也在(才切得回去);一般會員=純標示,顯示現況來源。 */
function _atisSrcBar(icao, source) {
  var founder = (_atisLevel === 'founder' || _atisLevel === 'owner');
  if (founder) {
    var isUs = (icao[0] === 'K' || icao[0] === 'P');
    var curGuru = source ? (source === 'atis.guru') : (_atisSrc[icao] === 'guru');          // 目前在不在 guru:有實際來源就用實際顯示的(reopen 從快取重繪也對);沒資料才靠選的來源
    var target = curGuru ? (isUs ? 'FAA' : 'airframes') : 'atis.guru';                     // 按了會切到的來源
    return '<button class="atis-src atis-src-btn" onclick="wxAtisSwitch(\\'' + icao + '\\')" title="\\u6309\\u4e00\\u4e0b\\u63db\\u5230 ' + target + '">\\ud83d\\udce1 ' + target + '</button>';
  }
  if (!source) return '';                                                                   // 非創始會員又沒來源 → 不顯示
  var nm = function (s) { return s === 'faa' ? 'FAA' : s === 'airframes' ? 'airframes' : s === 'atis.guru' ? 'atis.guru' : s; };
  return '<span class="atis-src">\\ud83d\\udce1 ' + nm(source) + '</span>';                  // 純標示=現況來源
}
/* 創始會員按「換來源」:在 server 源(FAA/airframes)⇄ atis.guru 之間切,重抓該機場 ATIS 並重繪 */
function wxAtisSwitch(icao) {
  if (wxSelectedIcao !== icao) return;
  var _tok = ++_wxDetailReqToken;                    // 佔最新 token:之後重開/刷新會蓋過這次切換,舊切換回來就丟棄(防 race)
  var cached = wxDetailRawCache[icao] || {};
  // 目前來源:優先看記憶體選擇;reload 後 _atisSrc 是空的 → 退看快取實際來源(避免第一次點變無效)
  var curGuru = (_atisSrc[icao] === 'guru') || (_atisSrc[icao] === undefined && cached.atisSrc === 'atis.guru');
  var goGuru = !curGuru;                              // 目前非 guru → 切到 guru;否則切回 server 源
  _atisSrc[icao] = goGuru ? 'guru' : 'primary';
  var mLines = cached.metar || [], tText = cached.taf || '';
  var content = document.getElementById('wx-detail-content');
  if (content) content.innerHTML = _wxBuildDetailHtml(icao, mLines, tText, null);   // ATIS 區顯示載入中,保留 METAR/TAF
  _wxAtisFetch(icao, _atisSrc[icao], !goGuru).then(function (r) {                    // 切回 server 源時 fresh=強抓
    if (wxSelectedIcao !== icao || _tok !== _wxDetailReqToken) return;              // 已被更新的開啟/刷新取代 → 丟棄,不蓋新資料(防 race)
    // 用實際拿到的來源校正狀態(server 退回 guru 時也對);但「抓到空(沒資料)」時不要亂翻 → 保留 goGuru 的意圖值,才切得回去
    if (r.source === 'atis.guru') _atisSrc[icao] = 'guru';
    else if (r.source) _atisSrc[icao] = 'primary';
    // ⚠ 切換結果「絕不」寫進 wxDetailRawCache(那是會被 _wxSaveDetailCache 持久化的共享結構)→ 換來源永不殘留到 localStorage、不跨 reload/帳號。
    //    只更新 DOM + HTML 渲染快取(wxDetailCache,純記憶體、reload 即清)→ 本次連線內 stick,reload 後回到共享的預設來源。
    var html = _wxBuildDetailHtml(icao, mLines, tText, r.sections, r.source);
    wxDetailCache[icao] = html;
    var c2 = document.getElementById('wx-detail-content');
    if (c2) c2.innerHTML = html;
  });
}

var _wxDetailReqToken = 0;
function fetchWxDetail(icao, name) {
  /* 每次 fetch 給一個遞增 token,只讓「最新那次」的結果(含背景 ATIS)生效,避免慢 ATIS 覆蓋新資料 */
  var _tok = ++_wxDetailReqToken;
  /* check 24hr cache first。⚠ 舊版快取沒有 atisSrc 欄(undefined)→ 不走捷徑、落到下面正常重抓,讓來源徽章/切換鈕補上(升級一次性自癒)。空字串''=有抓過但無 ATIS,仍算有效快取。 */
  var cached = wxDetailRawCache[icao];
  if (cached && (Date.now() - cached.time) < 86400000 && cached.atisSrc !== undefined) {
    if (cached.atisSrc) _atisSrc[icao] = (cached.atisSrc === 'atis.guru' ? 'guru' : 'primary');   // 重繪自快取(預設源)→ 一律把 toggle 狀態同步成「目前顯示的來源」,免得 reopen 後方向反掉
    var html = _wxBuildDetailHtml(icao, cached.metar, cached.taf, cached.atis, cached.atisSrc);
    wxDetailCache[icao] = html;
    var content = document.getElementById('wx-detail-content');
    if (content && wxSelectedIcao === icao) content.innerHTML = html;
    // 還不知道創始身份 → 背景只探一次身份(不碰快取資料,免把共享 FAA/airframes 降級成 guru,P1)。學到後用「原快取資料」重繪,只多出切換鈕。已知就不再探。
    if (!_atisLevelKnown) {
      _wxAtisProbeLevel().then(function () {
        if (wxSelectedIcao !== icao || _tok !== _wxDetailReqToken || !_atisLevelKnown) return;
        var h2 = _wxBuildDetailHtml(icao, cached.metar, cached.taf, cached.atis, cached.atisSrc);   // 用原快取資料重繪,只是現在會帶切換鈕
        wxDetailCache[icao] = h2;
        var c = document.getElementById('wx-detail-content');
        if (c && wxSelectedIcao === icao) c.innerHTML = h2;
      });
    }
    return;
  }
  var metarP = fetch('/api/metar?ids=' + icao + '&hours=6')
    .then(function(r) { return r.ok ? r.text() : ''; })
    .then(function(t) {
      var lines = t.trim().split('\\n').filter(function(l) { return l.trim(); });
      return lines.map(function(l) { return l.replace(/^(METAR|SPECI)\\s+/, '').trim(); }).filter(function(l) { return l.length > 0; });
    }).catch(function() { return []; });
  var tafP = fetch('/api/taf?ids=' + icao)
    .then(function(r) { return r.ok ? r.text() : ''; }).then(function(t) { return t.trim(); }).catch(function() { return ''; });
  /* ATIS：主抓取「永遠」抓預設來源(server FAA/airframes)寫進共享快取 wxDetailRawCache → 持久化的一律是預設源、不會被個人切換污染。
     創始會員的換來源是 wxAtisSwitch 的純記憶體覆蓋(不進這條路徑、不持久化)。回 {sections, source} → 顯示來源標籤。 */
  var atisP = _wxAtisFetch(icao, undefined, false);
  /* 先等 METAR+TAF(快)就秒出(ATIS 標「載入中」、跑道圖照樣秒出);ATIS 背景補上 → 不卡載入。 */
  Promise.all([metarP, tafP]).then(function(res) {
    var metarLines = res[0], tafText = res[1];
    var content = document.getElementById('wx-detail-content');
    if (!content || wxSelectedIcao !== icao || _tok !== _wxDetailReqToken) return;
    content.innerHTML = _wxBuildDetailHtml(icao, metarLines, tafText, null);
    _wxDetailRefreshDone();
    atisP.then(function(r) {
      var atisSections = r.sections, atisSource = r.source;
      wxDetailRawCache[icao] = { metar: metarLines, taf: tafText, atis: atisSections, atisSrc: atisSource, time: Date.now() };
      _wxSaveDetailCache();
      if (wxSelectedIcao !== icao || _tok !== _wxDetailReqToken) return;
      var html = _wxBuildDetailHtml(icao, metarLines, tafText, atisSections, atisSource);
      wxDetailCache[icao] = html;
      var c2 = document.getElementById('wx-detail-content');
      if (c2) c2.innerHTML = html;
    });
  }).catch(function() { _wxDetailRefreshDone(); });
}
function _wxDetailRefreshDone() {
  var btn = document.getElementById('wx-detail-refresh-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '\\u21ba Done';
    btn.classList.add('done');
    setTimeout(function() {
      var b = document.getElementById('wx-detail-refresh-btn');
      if (b) { b.textContent = '\\u21ba \\u66f4\\u65b0'; b.classList.remove('done'); }
    }, 2000);
  }
}

/* ── 24hr detail cache persistence ── */
function _wxSaveDetailCache() {
  try { localStorage.setItem('crewsync_wx_detail', JSON.stringify(wxDetailRawCache)); } catch(e) {}
}
function _wxLoadDetailCache() {
  try {
    var raw = localStorage.getItem('crewsync_wx_detail');
    if (raw) {
      var parsed = JSON.parse(raw);
      var now = Date.now();
      Object.keys(parsed).forEach(function(k) {
        if (parsed[k] && parsed[k].time && (now - parsed[k].time) < 86400000) {
          wxDetailRawCache[k] = parsed[k];
        }
      });
    }
  } catch(e) {}
}
_wxLoadDetailCache();

var _wxAllRegions = ['taiwan','hkmacao','japan','korea','philippines','thailand','vietnam','seasia','usa','pacific','canada','europe'];

// V8.0.43：開 App 背景把「所有 Ops Spec 機場」的衛星底圖預抓進永久快取（plapt-maps，跟 Pilot Log 共用、
// 同網域同網址）→ 看過沒看過、離線都秒出。要等 SW 控制頁面才抓（否則不經 SW、存不進永久快取）。
var _wxMapsPrefetched = false;
function _wxPrefetchAllMaps() {
  if (_wxMapsPrefetched || typeof RwyMap === 'undefined' || !window._PL_AIRPORTS || typeof _wxFleetData === 'undefined') return;
  var go = function() {
    if (_wxMapsPrefetched) return;
    _wxMapsPrefetched = true;
    var seen = {}, icaos = [];
    _wxAllRegions.forEach(function(reg) {
      Object.keys(_wxFleetData).forEach(function(fleet) {
        ((_wxFleetData[fleet] || {})[reg] || []).forEach(function(a) {
          if (a && a.icao && !seen[a.icao]) { seen[a.icao] = 1; icaos.push(a.icao); }
        });
      });
    });
    RwyMap.prefetch(icaos);
  };
  var sw = navigator.serviceWorker;
  if (!sw) { go(); return; }
  if (sw.controller) { go(); return; }
  (sw.ready || Promise.resolve()).then(function() {
    if (sw.controller) go();
    else { try { sw.addEventListener('controllerchange', go, { once: true }); } catch (e) { go(); } }
  }).catch(go);
}
setTimeout(function() { try { _wxPrefetchAllMaps(); } catch (e) {} }, 4000);

/* ── shared batch refresh core ── */
/* btn can be a DOM element or a string (element ID) — re-queried each time to survive re-renders */
function _wxGetBtn(btn) { return typeof btn === 'string' ? document.getElementById(btn) : btn; }
function _wxBatchRefresh(icaos, updateListRegion, btn, btnLabel) {
  var doneCount = 0;
  var total = icaos.length;

  /* batch METAR (all at once) */
  var metarAllP = fetch('/api/metar?ids=' + icaos.join(',') + '&hours=6')
    .then(function(r) { return r.ok ? r.text() : ''; })
    .then(function(text) {
      var result = {};
      text.split('\\n').forEach(function(line) {
        line = line.trim(); if (!line) return;
        var stripped = line.replace(/^(METAR|SPECI)\\s+/, '');
        var icao = stripped.split(' ')[0].toUpperCase();
        if (!/^[A-Z]{4}$/.test(icao)) return;
        if (!result[icao]) result[icao] = [];
        result[icao].push(stripped);
      });
      return result;
    }).catch(function() { return {}; });

  /* batch TAF (all at once) */
  var tafAllP = fetch('/api/taf?ids=' + icaos.join(','))
    .then(function(r) { return r.ok ? r.text() : ''; })
    .then(function(text) {
      var result = {};
      var blocks = text.trim().split(/(?=TAF\\s)/);
      blocks.forEach(function(b) {
        b = b.trim(); if (!b) return;
        var m = b.match(/^TAF\\s+(?:AMD\\s+|COR\\s+)?([A-Z]{4})/);
        if (m) result[m[1]] = b;
      });
      return result;
    }).catch(function() { return {}; });

  Promise.all([metarAllP, tafAllP]).then(function(batchRes) {
    var metarAll = batchRes[0];
    var tafAll = batchRes[1];

    /* update left list METAR for the visible region */
    if (updateListRegion) {
      var listAirports = wxGetAirports(updateListRegion);
      wxMetarMap = {};
      listAirports.forEach(function(a) {
        var lines = metarAll[a.icao] || [];
        if (lines.length > 0) wxMetarMap[a.icao] = parseMetarLine(lines[0]);
      });
      wxCacheTime = Date.now();
      try { localStorage.setItem('crewsync_metar_' + updateListRegion, JSON.stringify({data: wxMetarMap, time: wxCacheTime})); } catch(e) {}
      renderWxList(listAirports, updateListRegion);
    }

    /* also update METAR cache for other regions involved */
    if (!updateListRegion) {
      _wxAllRegions.forEach(function(reg) {
        var regAirports = wxGetAirports(reg);
        if (regAirports.length === 0) return;
        var regMap = {};
        regAirports.forEach(function(a) {
          var lines = metarAll[a.icao] || [];
          if (lines.length > 0) regMap[a.icao] = parseMetarLine(lines[0]);
        });
        try { localStorage.setItem('crewsync_metar_' + reg, JSON.stringify({data: regMap, time: Date.now()})); } catch(e) {}
      });
      /* update current region display */
      var curAirports = wxGetAirports(wxCurrentRegion);
      wxMetarMap = {};
      curAirports.forEach(function(a) {
        var lines = metarAll[a.icao] || [];
        if (lines.length > 0) wxMetarMap[a.icao] = parseMetarLine(lines[0]);
      });
      wxCacheTime = Date.now();
      renderWxList(curAirports, wxCurrentRegion);
    }

    /* 一鍵更新只做 METAR/TAF（上面 batch 已抓好 + 已更新左側列表）。
       ⚠ ATIS 改成「點開單一機場時才向 server(airframes) 抓」，絕不在這裡一次抓 80 個機場
       （一次幾百個請求會瞬間爆 airframes 免費 500/天額度）。 */
    _wxRefreshDone(btn, total, btnLabel);
    /* 更新「所有已開過(有 detail 快取)機場」的 METAR/TAF，保留各自 ATIS、不重抓 ATIS → 之後點開不會看到舊天氣。
       沒開過的不建快取(維持點開才抓)。codex P2:原本只更新選中那個 → 其他開過的機場會殘留 24h 舊資料。 */
    icaos.forEach(function(ic) {
      var sc = wxDetailRawCache[ic];
      if (!sc) return;
      if (metarAll[ic]) sc.metar = metarAll[ic];
      if (tafAll[ic] != null) sc.taf = tafAll[ic];
      sc.time = Date.now();
      wxMetarRawMap[ic] = sc.metar;
      delete wxDetailCache[ic];                    // 清渲染快取,下次重建
    });
    _wxSaveDetailCache();
    /* 重 render 當前開著的那個 */
    if (wxSelectedIcao && wxDetailRawCache[wxSelectedIcao]) {
      var c = wxDetailRawCache[wxSelectedIcao];
      var html = _wxBuildDetailHtml(wxSelectedIcao, c.metar, c.taf, c.atis, c.atisSrc);
      wxDetailCache[wxSelectedIcao] = html;
      var el = document.getElementById('wx-detail-content');
      if (el) el.innerHTML = html;
    }
  }).catch(function() {
    _wxRefreshDone(btn, 0, btnLabel);
  });
}

function _wxRefreshDone(btn, count, label) {
  _wxRefreshing = false;
  var el = _wxGetBtn(btn);
  if (el) {
    el.disabled = false;
    el.textContent = '\\u21ba Done (' + count + ')';
    el.classList.add('done');
    setTimeout(function() {
      var el2 = _wxGetBtn(btn);
      if (el2) { el2.textContent = label || '\\u21ba'; el2.classList.remove('done'); }
    }, 2000);
  }
}

/* ── Refresh All (all regions) ── */
function wxRefreshAll() {
  if (_wxRefreshing) return;
  _wxRefreshing = true;
  var btn = document.getElementById('wx-refresh-all-btn');
  if (btn) { btn.disabled = true; btn.textContent = '\\u21ba Refreshing...'; }

  /* collect all unique ICAOs across all regions */
  var seen = {};
  var allIcaos = [];
  _wxAllRegions.forEach(function(reg) {
    wxGetAirports(reg).forEach(function(a) {
      if (!seen[a.icao]) { seen[a.icao] = true; allIcaos.push(a.icao); }
    });
  });
  if (allIcaos.length === 0) { _wxRefreshDone('wx-refresh-all-btn', 0, '\\u21ba Refresh All'); return; }
  _wxBatchRefresh(allIcaos, null, 'wx-refresh-all-btn', '\\u21ba Refresh All');
}

/* ── Refresh Region (current region only) ── */
function wxRefreshRegion() {
  if (_wxRefreshing) return;
  _wxRefreshing = true;
  var btn = document.getElementById('wx-region-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '\\u21ba ...'; }

  var airports = wxGetAirports(wxCurrentRegion);
  if (airports.length === 0) { _wxRefreshDone(btn, 0, '\\u21ba'); return; }
  var icaos = airports.map(function(a) { return a.icao; });
  _wxBatchRefresh(icaos, wxCurrentRegion, 'wx-region-refresh-btn', '\\u21ba');
}

`;
}
