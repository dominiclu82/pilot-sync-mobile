// ── PA 工具 ──────────────────────────────────────────────────────────────────

// ── 全域狀態 ─────────────────────────────────────────────────────────────────
var _paGlobalDest = '';
var _paGlobalFlt = '';
try { _paGlobalFlt = localStorage.getItem('crewsync_pa_flt') || ''; } catch(e){}
try { _paGlobalDest = localStorage.getItem('crewsync_pa_dest') || ''; } catch(e){}
var _paGlobalTempC = '';
var _paGlobalTempF = '';
var _paSelectedStation = '';
var _paListenersReady = false;
var _paManualFlags = {};  // 手動修改 flag：{ 'flt-hr': true, ... }
try { _paManualFlags = JSON.parse(localStorage.getItem('crewsync_pa_manual_flags') || '{}'); } catch(e){}
var _paFidsCache = null;
var _paFidsCacheTime = 0;
var _paFltTimer = null;
var _paLtTimer = null;

// ── 溫度換算 ─────────────────────────────────────────────────────────────────
function paConvertTemp(from) {
  var cEl = document.getElementById('pa-temp-c');
  var fEl = document.getElementById('pa-temp-f');
  if (from === 'c') {
    var c = parseFloat(cEl.value);
    _paGlobalTempC = cEl.value;
    if (isNaN(c)) { fEl.value = ''; _paGlobalTempF = ''; }
    else { var fv = String(Math.round(c * 9 / 5 + 32)); fEl.value = fv; _paGlobalTempF = fv; }
  } else {
    var f = parseFloat(fEl.value);
    _paGlobalTempF = fEl.value;
    if (isNaN(f)) { cEl.value = ''; _paGlobalTempC = ''; }
    else { var cv = String(Math.round((f - 32) * 5 / 9)); cEl.value = cv; _paGlobalTempC = cv; }
  }
  _paSyncTempToContent();
}

function _paSyncTempToContent() {
  var el = document.getElementById('pa-content');
  if (!el) return;
  el.querySelectorAll('[data-pa="temp-c"]').forEach(function(inp) {
    if (document.activeElement !== inp) inp.value = _paGlobalTempC;
  });
  el.querySelectorAll('[data-pa="temp-f"]').forEach(function(inp) {
    if (document.activeElement !== inp) inp.value = _paGlobalTempF;
  });
}

// ── 時區列表 ─────────────────────────────────────────────────────────────────
var _paTzZones = [
  { stations: 'UTC', offset: 0, dst: false },
  { stations: 'TPE', offset: 8, dst: false },
  { stations: 'LAX / SFO / SEA', offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT' },
  { stations: 'PHX', offset: -7, dst: false },
  { stations: 'BKK / SGN / CGK', offset: 7, dst: false },
  { stations: 'HKG / MFM / SIN', offset: 8, dst: false },
  { stations: 'NRT / ICN', offset: 9, dst: false },
  { stations: 'PRG', offset: 1, dst: true, dstOffset: 2, dstLabel: 'CEST' }
];

function _paIsDST_US() {
  var now = new Date();
  var year = now.getUTCFullYear();
  var mar1 = new Date(Date.UTC(year, 2, 1));
  var marSun2 = 8 + (7 - mar1.getUTCDay()) % 7;
  var dstStart = Date.UTC(year, 2, marSun2, 10, 0);
  var nov1 = new Date(Date.UTC(year, 10, 1));
  var novSun1 = 1 + (7 - nov1.getUTCDay()) % 7;
  if (novSun1 > 7) novSun1 -= 7;
  var dstEnd = Date.UTC(year, 10, novSun1, 9, 0);
  var ts = now.getTime();
  return ts >= dstStart && ts < dstEnd;
}

function _paIsDST_EU() {
  var now = new Date();
  var year = now.getUTCFullYear();
  var mar31 = new Date(Date.UTC(year, 2, 31));
  var marLastSun = 31 - mar31.getUTCDay();
  var dstStart = Date.UTC(year, 2, marLastSun, 1, 0);
  var oct31 = new Date(Date.UTC(year, 9, 31));
  var octLastSun = 31 - oct31.getUTCDay();
  var dstEnd = Date.UTC(year, 9, octLastSun, 1, 0);
  var ts = now.getTime();
  return ts >= dstStart && ts < dstEnd;
}

var _paTzTimer = null;
function paUpdateTzList() {
  var el = document.getElementById('pa-tz-list');
  if (!el) return;
  var now = new Date();
  var usDST = _paIsDST_US();
  var euDST = _paIsDST_EU();
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var html = '';
  _paTzZones.forEach(function(z) {
    var off = z.offset;
    var isDst = false;
    if (z.dst) {
      if (z.dstLabel === 'PDT' && usDST) { off = z.dstOffset; isDst = true; }
      if (z.dstLabel === 'CEST' && euDST) { off = z.dstOffset; isDst = true; }
    }
    var local = new Date(now.getTime() + off * 3600000);
    var mm = String(local.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(local.getUTCDate()).padStart(2, '0');
    var day = days[local.getUTCDay()];
    var hh = String(local.getUTCHours()).padStart(2, '0');
    var mi = String(local.getUTCMinutes()).padStart(2, '0');
    var utcStr = 'UTC' + (off >= 0 ? '+' : '') + off;
    var dstStr = isDst ? ' <span class="pa-tz-dst">DST</span>' : '';
    var rowClass = z.stations === 'UTC' ? 'pa-tz-row pa-tz-utc-row' : 'pa-tz-row';
    var stationsHtml = z.stations === 'UTC' ? z.stations : z.stations.split(' / ').map(function(s) {
      var cls = 'pa-tz-link' + (s === _paSelectedStation ? ' pa-tz-selected' : '');
      return '<span class="' + cls + '" onclick="_paTzSelectStation(\'' + s + '\')">' + s + '</span>';
    }).join(' / ');
    html += '<div class="' + rowClass + '">' +
      '<span class="pa-tz-stations">' + stationsHtml + '</span>' +
      '<span class="pa-tz-date">' + mm + '/' + dd + ' ' + day + '</span>' +
      '<span class="pa-tz-time">' + hh + ':' + mi + '</span>' +
      '<span class="pa-tz-utc">' + utcStr + dstStr + '</span>' +
      '</div>';
  });
  el.innerHTML = html;
}

function paStartTzTimer() {
  paUpdateTzList();
  if (_paTzTimer) clearInterval(_paTzTimer);
  _paTzTimer = setInterval(paUpdateTzList, 30000);
  var content = document.getElementById('pa-content');
  if (content && !content.innerHTML.trim()) {
    var firstBtn = document.querySelector('.pa-cat-btn');
    paSwitchCat('welcome', firstBtn);
  }
}

// ── 目的地時區對應 ───────────────────────────────────────────────────────────
var _paTzMap = {
  // 台灣 UTC+8
  'TPE': { offset: 8, dst: false, lat: 25.08, lon: 121.23 },
  'KHH': { offset: 8, dst: false, lat: 22.58, lon: 120.35 },
  'TSA': { offset: 8, dst: false, lat: 25.07, lon: 121.55 },
  'RMQ': { offset: 8, dst: false, lat: 24.26, lon: 120.62 },
  // 港澳 UTC+8
  'HKG': { offset: 8, dst: false, lat: 22.31, lon: 113.91 },
  'MFM': { offset: 8, dst: false, lat: 22.15, lon: 113.59 },
  // 日本 UTC+9
  'NRT': { offset: 9, dst: false, lat: 35.76, lon: 140.39 },
  'HND': { offset: 9, dst: false, lat: 35.55, lon: 139.78 },
  'KIX': { offset: 9, dst: false, lat: 34.43, lon: 135.24 },
  'CTS': { offset: 9, dst: false, lat: 42.78, lon: 141.69 },
  'FUK': { offset: 9, dst: false, lat: 33.59, lon: 130.45 },
  'SDJ': { offset: 9, dst: false, lat: 38.14, lon: 140.92 },
  'OKA': { offset: 9, dst: false, lat: 26.20, lon: 127.65 },
  'KMJ': { offset: 9, dst: false, lat: 32.84, lon: 130.86 },
  'NGO': { offset: 9, dst: false, lat: 34.86, lon: 136.81 },
  'KOJ': { offset: 9, dst: false, lat: 31.80, lon: 130.72 },
  'AOJ': { offset: 9, dst: false, lat: 40.73, lon: 140.69 },
  'TAK': { offset: 9, dst: false, lat: 34.21, lon: 134.02 },
  'UKB': { offset: 9, dst: false, lat: 34.63, lon: 135.22 },
  // 韓國 UTC+9
  'ICN': { offset: 9, dst: false, lat: 37.46, lon: 126.44 },
  'PUS': { offset: 9, dst: false, lat: 35.18, lon: 128.94 },
  'CJU': { offset: 9, dst: false, lat: 33.51, lon: 126.49 },
  // 菲律賓 UTC+8
  'CRK': { offset: 8, dst: false, lat: 15.19, lon: 120.56 },
  'MNL': { offset: 8, dst: false, lat: 14.51, lon: 121.02 },
  'CEB': { offset: 8, dst: false, lat: 10.31, lon: 123.98 },
  // 泰國 UTC+7
  'BKK': { offset: 7, dst: false, lat: 13.69, lon: 100.75 },
  'DMK': { offset: 7, dst: false, lat: 13.91, lon: 100.61 },
  'UTP': { offset: 7, dst: false, lat: 12.68, lon: 101.01 },
  'CNX': { offset: 7, dst: false, lat: 18.77, lon: 98.96 },
  // 越柬 UTC+7
  'SGN': { offset: 7, dst: false, lat: 10.82, lon: 106.65 },
  'HAN': { offset: 7, dst: false, lat: 21.22, lon: 105.81 },
  'PQC': { offset: 7, dst: false, lat: 10.23, lon: 103.97 },
  'PNH': { offset: 7, dst: false, lat: 11.55, lon: 104.84 },
  'CXR': { offset: 7, dst: false, lat: 12.23, lon: 109.19 },
  'DAD': { offset: 7, dst: false, lat: 16.04, lon: 108.20 },
  // 印尼
  'CGK': { offset: 7, dst: false, lat: -6.13, lon: 106.66 },
  'DPS': { offset: 8, dst: false, lat: -8.75, lon: 115.17 },
  'SUB': { offset: 7, dst: false, lat: -7.38, lon: 112.79 },
  // 馬來西亞 UTC+8
  'KUL': { offset: 8, dst: false, lat: 2.75, lon: 101.71 },
  'PEN': { offset: 8, dst: false, lat: 5.30, lon: 100.28 },
  'KCH': { offset: 8, dst: false, lat: 1.49, lon: 110.35 },
  // 新加坡 UTC+8
  'SIN': { offset: 8, dst: false, lat: 1.35, lon: 103.99 },
  // 美國西岸 UTC-8 (DST: -7)
  'LAX': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 33.94, lon: -118.41 },
  'SFO': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 37.62, lon: -122.38 },
  'SEA': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 47.45, lon: -122.31 },
  'ONT': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 34.06, lon: -117.60 },
  'OAK': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 37.72, lon: -122.22 },
  'PDX': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 45.59, lon: -122.60 },
  'SMF': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 38.70, lon: -121.59 },
  // 美國山區 UTC-7 (DST: -6)
  'DEN': { offset: -7, dst: true, dstOffset: -6, dstLabel: 'MDT', lat: 39.86, lon: -104.67 },
  'TUS': { offset: -7, dst: false, lat: 32.12, lon: -110.94 },
  'PHX': { offset: -7, dst: false, lat: 33.43, lon: -112.01 },
  'LAS': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 36.08, lon: -115.15 },
  // 阿拉斯加 UTC-9 (DST: -8)
  'ANC': { offset: -9, dst: true, dstOffset: -8, dstLabel: 'AKDT', lat: 61.17, lon: -149.99 },
  // 夏威夷 UTC-10
  'HNL': { offset: -10, dst: false, lat: 21.32, lon: -157.92 },
  // 關島/塞班 UTC+10
  'GUM': { offset: 10, dst: false, lat: 13.48, lon: 144.80 },
  'SPN': { offset: 10, dst: false, lat: 15.12, lon: 145.73 },
  // 加拿大 UTC-8 (DST: -7)
  'YVR': { offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT', lat: 49.19, lon: -123.18 },
  // 歐洲 CET UTC+1 (DST: +2)
  'PRG': { offset: 1, dst: true, dstOffset: 2, dstLabel: 'CEST', lat: 50.10, lon: 14.26 },
  'BER': { offset: 1, dst: true, dstOffset: 2, dstLabel: 'CEST', lat: 52.37, lon: 13.52 },
  'MUC': { offset: 1, dst: true, dstOffset: 2, dstLabel: 'CEST', lat: 48.35, lon: 11.79 },
  'WAW': { offset: 1, dst: true, dstOffset: 2, dstLabel: 'CEST', lat: 52.17, lon: 20.97 },
  'LNZ': { offset: 1, dst: true, dstOffset: 2, dstLabel: 'CEST', lat: 48.23, lon: 14.19 },
  'VIE': { offset: 1, dst: true, dstOffset: 2, dstLabel: 'CEST', lat: 48.11, lon: 16.57 }
};

var _paIcaoToIata = {
  RCTP:'TPE',RCKH:'KHH',RCSS:'TSA',RCMQ:'RMQ',
  VHHH:'HKG',VMMC:'MFM',
  RJAA:'NRT',RJTT:'HND',RJBB:'KIX',RJCC:'CTS',RJFF:'FUK',RJSS:'SDJ',ROAH:'OKA',
  RJFT:'KMJ',RJGG:'NGO',RJFK:'KOJ',RJSA:'AOJ',RJOT:'TAK',RJBE:'UKB',
  RKSI:'ICN',RKPK:'PUS',RKPC:'CJU',
  RPLC:'CRK',RPLL:'MNL',RPVM:'CEB',
  VTBS:'BKK',VTBD:'DMK',VTBU:'UTP',VTCC:'CNX',
  VVTS:'SGN',VVNB:'HAN',VVPQ:'PQC',VDPP:'PNH',VVCR:'CXR',VVDN:'DAD',
  WIII:'CGK',WADD:'DPS',WARR:'SUB',WBGG:'KCH',WMKK:'KUL',WMKP:'PEN',
  WSSS:'SIN',
  KLAX:'LAX',KSFO:'SFO',KSEA:'SEA',KONT:'ONT',KOAK:'OAK',KPDX:'PDX',KSMF:'SMF',
  KDEN:'DEN',KTUS:'TUS',KPHX:'PHX',KLAS:'LAS',
  PANC:'ANC',PHNL:'HNL',PGUM:'GUM',PGSN:'SPN',
  CYVR:'YVR',
  LKPR:'PRG',EDDB:'BER',EDDM:'MUC',EPWA:'WAW',LOWL:'LNZ',LOWW:'VIE'
};

var _paNameToIata = {
  '桃園':'TPE','高雄':'KHH','松山':'TSA','台中':'RMQ',
  '香港':'HKG','澳門':'MFM',
  '成田':'NRT','羽田':'HND','關西':'KIX','新千歲':'CTS','福岡':'FUK','仙台':'SDJ',
  '那霸':'OKA','熊本':'KMJ','名古屋':'NGO','鹿兒島':'KOJ','青森':'AOJ','高松':'TAK','神戶':'UKB',
  '仁川':'ICN','釜山':'PUS','濟州':'CJU',
  '克拉克':'CRK','馬尼拉':'MNL','宿霧':'CEB',
  '曼谷':'BKK','素萬那普':'BKK','廊曼':'DMK','芭達雅':'UTP','清邁':'CNX',
  '胡志明':'SGN','河內':'HAN','富國':'PQC','金邊':'PNH','芽莊':'CXR','峴港':'DAD',
  '雅加達':'CGK','峇里島':'DPS','泗水':'SUB',
  '吉隆坡':'KUL','檳城':'PEN','古晉':'KCH',
  '新加坡':'SIN',
  '洛杉磯':'LAX','舊金山':'SFO','西雅圖':'SEA','安大略':'ONT','奧克蘭':'OAK',
  '波特蘭':'PDX','沙加緬度':'SMF','丹佛':'DEN','土森':'TUS','鳳凰城':'PHX','拉斯維加斯':'LAS',
  '安克拉治':'ANC','檀香山':'HNL','關島':'GUM','塞班':'SPN',
  '溫哥華':'YVR',
  '布拉格':'PRG','柏林':'BER','慕尼黑':'MUC','華沙':'WAW','林茲':'LNZ','維也納':'VIE'
};

var _paIataToName = {};
(function() {
  for (var name in _paNameToIata) {
    var code = _paNameToIata[name];
    if (!_paIataToName[code]) _paIataToName[code] = name;
    else if (_paIataToName[code].indexOf(name) === -1) _paIataToName[code] += '/' + name;
  }
})();

function _paResolveAirport(input) {
  var s = input.trim();
  if (!s) return null;
  var upper = s.toUpperCase();
  if (_paTzMap[upper]) return upper;
  var fromIcao = _paIcaoToIata[upper];
  if (fromIcao && _paTzMap[fromIcao]) return fromIcao;
  var fromName = _paNameToIata[s];
  if (fromName && _paTzMap[fromName]) return fromName;
  for (var name in _paNameToIata) {
    if (s.indexOf(name) !== -1) return _paNameToIata[name];
  }
  return null;
}

function _paGetDestTz(dest) {
  var code = _paResolveAirport(dest);
  if (code && _paTzMap[code]) return _paTzMap[code];
  return null;
}

// ── 日出日落計算 ─────────────────────────────────────────────────────────────
function _paSunTimes(lat, lon, utcOffset) {
  var now = new Date();
  var start = new Date(now.getFullYear(), 0, 0);
  var dayOfYear = Math.floor((now - start) / 86400000);
  var D2R = Math.PI / 180;
  var gamma = 2 * Math.PI / 365 * (dayOfYear - 1);
  var decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  var eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  var zenith = 90.833 * D2R;
  var latRad = lat * D2R;
  var cosHA = (Math.cos(zenith) / (Math.cos(latRad) * Math.cos(decl))) - Math.tan(latRad) * Math.tan(decl);
  if (cosHA > 1 || cosHA < -1) return null;
  var ha = Math.acos(cosHA) * 180 / Math.PI;
  var rise = 720 - 4 * (lon + ha) - eqTime + utcOffset * 60;
  var set = 720 - 4 * (lon - ha) - eqTime + utcOffset * 60;
  rise = ((rise % 1440) + 1440) % 1440;
  set = ((set % 1440) + 1440) % 1440;
  var fmt = function(m) {
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0');
  };
  return { rise: fmt(rise), set: fmt(set) };
}

// ── 問安 helpers ─────────────────────────────────────────────────────────────
function _paGetLocalHour(iata) {
  if (!iata) return null;
  var tz = _paGetDestTz(iata.toUpperCase().trim());
  if (!tz) return null;
  var off = tz.offset;
  if (tz.dst) {
    var isUS = (tz.dstLabel === 'PDT' || tz.dstLabel === 'MDT' || tz.dstLabel === 'AKDT');
    if (isUS && _paIsDST_US()) off = tz.dstOffset;
    if (tz.dstLabel === 'CEST' && _paIsDST_EU()) off = tz.dstOffset;
  }
  return new Date(new Date().getTime() + off * 3600000).getUTCHours();
}

function _paUpdateGreetings() {
  var content = document.getElementById('pa-content');
  if (!content) return;
  content.querySelectorAll('.pa-greeting').forEach(function(gr) {
    var gtype = gr.getAttribute('data-gtype');
    var iata = '';
    if (gtype === 'dest') {
      iata = _paGlobalDest;
    } else if (gtype === 'origin') {
      var originEl = document.getElementById('brief-origin');
      iata = originEl ? originEl.value.trim() : '';
    }
    var h = _paGetLocalHour(iata);
    var idx = (h === null) ? -1 : (h < 12) ? 0 : (h < 18) ? 1 : 2;
    gr.querySelectorAll('.pa-greet-opt').forEach(function(opt, i) {
      opt.classList.toggle('pa-greet-active', i === idx);
    });
  });
}

var _paGreetingOrigin = '<span class="pa-greeting" data-gtype="origin"><span class="pa-greet-opt">早安</span> / <span class="pa-greet-opt">午安</span> / <span class="pa-greet-opt">晚安</span></span>';
var _paGreetingDest   = '<span class="pa-greeting" data-gtype="dest"><span class="pa-greet-opt">早安</span> / <span class="pa-greet-opt">午安</span> / <span class="pa-greet-opt">晚安</span></span>';

// ── Local Time 查詢 ──────────────────────────────────────────────────────────
var _paLocalTimeTimer = null;
var _paContentTimer = null;
function _paFltToDest(num) {
  if (!_paFidsCache) return null;
  var dep = (_paFidsCache.dep || []).filter(function(f) { return f.ACode && f.ACode.trim() === 'JX'; });
  var arr = (_paFidsCache.arr || []).filter(function(f) { return f.ACode && f.ACode.trim() === 'JX'; });
  for (var i = 0; i < dep.length; i++) {
    var dFlt = dep[i].FlightNo ? dep[i].FlightNo.replace(/\s/g, '').replace(/^0+/, '') || '0' : '';
    if (dFlt === num) return dep[i].CityCode || null;
  }
  for (var j = 0; j < arr.length; j++) {
    var aFlt = arr[j].FlightNo ? arr[j].FlightNo.replace(/\s/g, '').replace(/^0+/, '') || '0' : '';
    if (aFlt === num) return 'TPE';
  }
  return null;
}

function _paLtStatus(msg, type) {
  var el = document.getElementById('pa-lt-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pa-flt-status' + (type ? ' pa-flt-' + type : '');
}

function _paLookupLocalTime(input) {
  if (_paLtTimer) clearTimeout(_paLtTimer);
  var resultEl = document.getElementById('pa-localtime-result');
  if (!resultEl) return;
  // 清空時：清除 PA 欄位 + 結果 + 狀態
  if (!input.trim()) {
    resultEl.innerHTML = '';
    _paOnFltInput('');
    _paOnDestInput('');
    _paFltStatus('', '');
    _paLtStatus('', '');
    return;
  }
  // 先嘗試機場查詢（不需 debounce，即時回應）
  var code = _paResolveAirport(input);
  if (code && _paTzMap[code]) {
    _paLtStatus('', '');
    _paOnDestInput(code);
    _paShowLocalTime(code);
    return;
  }
  // 航班號輸入變動 → 立刻清舊資料
  _paOnDestInput('');
  _paLtStatus('', '');
  resultEl.innerHTML = '';
  // 航班號查詢用 debounce，避免刪除過程中逐字觸發
  _paLtTimer = setTimeout(function() {
    var num = _paNormalizeFlt(input);
    if (num && /^\d+$/.test(num)) {
      _paOnFltInput('JX' + num);
      _paLtStatus('Loading...', 'loading');
      if (_paFidsCache) {
        var dest = _paFltToDest(num);
        if (dest) { _paLtStatus('→ ' + dest, 'ok'); _paOnDestInput(dest); _paShowLocalTime(dest); return; }
      }
      resultEl.innerHTML = '<div class="pa-lt-loading">Loading...</div>';
      _paFltLookupForLT(num);
    } else {
      resultEl.innerHTML = '';
      _paLtStatus('', '');
    }
  }, 300);
}

function _paDateOffset(days) {
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 3600000 + days * 86400000);
  return tw.getUTCFullYear() + '/' +
    String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(tw.getUTCDate()).padStart(2, '0');
}

/* ── 共用 FIDS 快取（提示卡 / PA / Gate Info 共用） ── */
var _fidsCache = {};  // { 'YYYY/MM/DD': { data:{dep,arr,date}, ts:number } }
var _FIDS_TTL = 120000; // 2 分鐘

function _fidsFetchByDate(dateStr, force) {
  // 快取檢查：有網路 → 2 分鐘過期；離線 → 不過期
  if (!force) {
    var cached = _fidsCache[dateStr];
    if (cached) {
      var expired = navigator.onLine && (Date.now() - cached.ts > _FIDS_TTL);
      if (!expired) return Promise.resolve(cached.data);
    }
  }
  // 離線且無快取 → 直接失敗
  if (!navigator.onLine) return Promise.reject(new Error('offline'));
  // proxy → direct fallback
  return fetch('/api/fids?date=' + encodeURIComponent(dateStr)).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).catch(function() {
    return _fidsFetchDirect(dateStr);
  }).then(function(data) {
    _fidsCache[dateStr] = { data: data, ts: Date.now() };
    return data;
  });
}

function _fidsClearCache(dateStr) {
  if (dateStr) delete _fidsCache[dateStr];
  else _fidsCache = {};
}

function _fidsFetchDirect(dateStr) {
  var ep = atob('aHR0cHM6Ly93d3cudGFveXVhbi1haXJwb3J0LmNvbS9hcGkvYXBpL2ZsaWdodC9hX2ZsaWdodA==');
  var base = { ODate: dateStr, OTimeOpen: null, OTimeClose: null, BNO: null, AState: '', language: 'ch', keyword: '' };
  var hdrs = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' };
  return Promise.all([
    fetch(ep, { method: 'POST', headers: hdrs, body: JSON.stringify(Object.assign({}, base, { AState: 'D' })) }),
    fetch(ep, { method: 'POST', headers: hdrs, body: JSON.stringify(Object.assign({}, base, { AState: 'A' })) })
  ]).then(function(res) {
    if (!res[0].ok || !res[1].ok) throw new Error('HTTP ' + res[0].status + '/' + res[1].status);
    return Promise.all([res[0].json(), res[1].json()]);
  }).then(function(data) {
    return { dep: data[0], arr: data[1], date: dateStr };
  });
}

/* 向後相容 */
function _paFetchByDate(dateStr) {
  return _fidsFetchByDate(dateStr);
}

/* ── 共用 METAR 快取 ── */
var _metarCache = {};  // { 'ICAO': { text:string, ts:number } }
var _METAR_TTL = 120000; // 2 分鐘

function _metarFetch(icao, force) {
  if (!force) {
    var cached = _metarCache[icao];
    if (cached) {
      var expired = navigator.onLine && (Date.now() - cached.ts > _METAR_TTL);
      if (!expired) return Promise.resolve(cached.text);
    }
  }
  if (!navigator.onLine) {
    var stale = _metarCache[icao];
    if (stale) return Promise.resolve(stale.text);
    return Promise.reject(new Error('offline'));
  }
  return fetch('/api/metar?ids=' + icao + '&hours=6')
    .then(function(r) { return r.ok ? r.text() : Promise.reject(); })
    .then(function(text) {
      _metarCache[icao] = { text: text, ts: Date.now() };
      return text;
    });
}

/* 批次抓取並存入快取（用於預載） */
function _metarFetchBatch(icaos, force) {
  // 篩出需要抓的（過期或沒快取的）
  var toFetch = force ? icaos : icaos.filter(function(ic) {
    var c = _metarCache[ic];
    return !c || (navigator.onLine && Date.now() - c.ts > _METAR_TTL);
  });
  if (toFetch.length === 0) return Promise.resolve();
  if (!navigator.onLine) return Promise.resolve();
  return fetch('/api/metar?ids=' + toFetch.join(',') + '&hours=6')
    .then(function(r) { return r.ok ? r.text() : Promise.reject(); })
    .then(function(text) {
      var now = Date.now();
      // 逐行解析，按 ICAO 分組存入快取
      var byIcao = {};
      text.split('\n').forEach(function(line) {
        line = line.trim();
        if (!line) return;
        var stripped = line.replace(/^(METAR|SPECI)\s+/, '');
        var ic = stripped.split(' ')[0].toUpperCase();
        if (/^[A-Z]{4}$/.test(ic)) {
          if (!byIcao[ic]) byIcao[ic] = [];
          byIcao[ic].push(line);
        }
      });
      Object.keys(byIcao).forEach(function(ic) {
        _metarCache[ic] = { text: byIcao[ic].join('\n'), ts: now };
      });
    })
    .catch(function() {});
}

/* 背景預載全部機場 METAR */
function _metarPreloadAll() {
  if (!navigator.onLine) return;
  if (typeof _wxFleetData === 'undefined') return;
  var allIcaos = {};
  for (var fleet in _wxFleetData) {
    for (var region in _wxFleetData[fleet]) {
      var list = _wxFleetData[fleet][region];
      for (var i = 0; i < list.length; i++) allIcaos[list[i].icao] = true;
    }
  }
  var icaoArr = Object.keys(allIcaos);
  if (icaoArr.length > 0) _metarFetchBatch(icaoArr);
}

function _paFltLookupForLT(num) {
  if (_paFidsCache && Date.now() - _paFidsCacheTime < 120000) {
    var dest = _paFltToDest(num);
    if (dest) { _paLtStatus('→ ' + dest, 'ok'); _paOnDestInput(dest); _paShowLocalTime(dest); return; }
  }
  // 今天 → 明天 → 昨天
  var tryDates = [0, 1, -1];
  var idx = 0;
  var tryNext = function() {
    if (idx >= tryDates.length) {
      _paLtStatus('JX' + num + ' not found', 'warn');
      var resultEl = document.getElementById('pa-localtime-result');
      if (resultEl) resultEl.innerHTML = '';
      _paOnDestInput('');
      return;
    }
    var dateStr = _paDateOffset(tryDates[idx]);
    idx++;
    _fidsFetchByDate(dateStr).then(function(data) {
      _paFidsCache = data; _paFidsCacheTime = Date.now();
      var dest = _paFltToDest(num);
      if (dest) { _paLtStatus('→ ' + dest, 'ok'); _paOnDestInput(dest); _paShowLocalTime(dest); }
      else { tryNext(); }
    }).catch(function() { tryNext(); });
  };
  tryNext();
}

function _paShowLocalTime(code) {
  var tz = _paTzMap[code];
  var resultEl = document.getElementById('pa-localtime-result');
  if (!resultEl) return;
  if (!tz) { resultEl.innerHTML = ''; return; }
  _paUpdateLocalTimeDisplay(code, tz);
  if (_paLocalTimeTimer) clearInterval(_paLocalTimeTimer);
  _paLocalTimeTimer = setInterval(function() { _paUpdateLocalTimeDisplay(code, tz); }, 30000);
}

function _paUpdateLocalTimeDisplay(_, tz) {
  var resultEl = document.getElementById('pa-localtime-result');
  if (!resultEl) return;
  var now = new Date();
  var off = tz.offset;
  if (tz.dst) {
    var isUS = (tz.dstLabel === 'PDT' || tz.dstLabel === 'MDT' || tz.dstLabel === 'AKDT');
    if (isUS && _paIsDST_US()) off = tz.dstOffset;
    if (tz.dstLabel === 'CEST' && _paIsDST_EU()) off = tz.dstOffset;
  }
  var local = new Date(now.getTime() + off * 3600000);
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(local.getUTCDate()).padStart(2, '0');
  var day = days[local.getUTCDay()];
  var hh = String(local.getUTCHours()).padStart(2, '0');
  var mi = String(local.getUTCMinutes()).padStart(2, '0');
  var utcStr = 'UTC' + (off >= 0 ? '+' : '') + off;
  var sunHtml = '';
  if (tz.lat !== undefined) {
    var sun = _paSunTimes(tz.lat, tz.lon, off);
    if (sun) sunHtml = '☀️' + sun.rise + ' 🌙' + sun.set;
  }
  resultEl.innerHTML = '<div class="pa-tz-row pa-lt-row">' +
    '<span class="pa-tz-stations pa-lt-sun">' + sunHtml + '</span>' +
    '<span class="pa-tz-date">' + mm + '/' + dd + ' ' + day + '</span>' +
    '<span class="pa-tz-time">' + hh + ':' + mi + '</span>' +
    '<span class="pa-tz-utc">' + utcStr + '</span>' +
    '</div>';
}

function _paCalcLocalTime(tz) {
  var now = new Date();
  var off = tz.offset;
  if (tz.dst) {
    var isUS = (tz.dstLabel === 'PDT' || tz.dstLabel === 'MDT' || tz.dstLabel === 'AKDT');
    if (isUS && _paIsDST_US()) off = tz.dstOffset;
    if (tz.dstLabel === 'CEST' && _paIsDST_EU()) off = tz.dstOffset;
  }
  var local = new Date(now.getTime() + off * 3600000);
  var h = local.getUTCHours();
  var m = local.getUTCMinutes();
  var h12 = h % 12 || 12;
  var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var daysCn = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
  var mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(local.getUTCDate()).padStart(2, '0');
  return {
    time12: String(h12).padStart(2, '0') + ':' + String(m).padStart(2, '0'),
    ampm: h >= 12 ? 'p.m.' : 'a.m.',
    ampmCn: h >= 18 ? '晚上' : h >= 12 ? '下午' : h >= 6 ? '上午' : '凌晨',
    dayEn: days[local.getUTCDay()] + ' ' + mm + '/' + dd,
    dayCn: (local.getUTCMonth() + 1) + '月' + local.getUTCDate() + '號' + daysCn[local.getUTCDay()]
  };
}

// ── 時區點選 ─────────────────────────────────────────────────────────────────
function _paTzSelectStation(code) {
  _paSelectedStation = code;
  _paGlobalDest = code;
  var el = document.getElementById('pa-content');
  if (el) {
    el.querySelectorAll('[data-pa="dest"]').forEach(function(inp) { inp.value = code; });
  }
  if (_paCurrentCat === 'descent') _paFillDescentTime();
  document.querySelectorAll('.pa-tz-link').forEach(function(l) {
    l.classList.toggle('pa-tz-selected', l.textContent === code);
  });
}

// ── 航班號查詢 ─────────────────────────────────────────────────────────────────
function _paNormalizeFlt(val) {
  var s = val.trim().toUpperCase();
  if (!s) return '';
  s = s.replace(/^SJX/, '').replace(/^JX/, '');
  s = s.replace(/\s/g, '');
  if (!s) return '';
  return s.replace(/^0+/, '') || '0';
}

function _paFltStatus(msg, type) {
  var el = document.getElementById('pa-flt-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pa-flt-status' + (type ? ' pa-flt-' + type : '');
}

function _paOnFltInput(val) {
  _paGlobalFlt = val;
  try { localStorage.setItem('crewsync_pa_flt', val); } catch(e){}
  // Sync across all data-pa="flt" fields in PA content
  var el = document.getElementById('pa-content');
  if (el) {
    el.querySelectorAll('[data-pa="flt"]').forEach(function(inp) {
      if (document.activeElement !== inp) inp.value = val;
    });
  }
  // 航班號變動 → 立刻清除舊目的地
  _paOnDestInput('');
  // Debounced FIDS lookup
  if (_paFltTimer) clearTimeout(_paFltTimer);
  var num = _paNormalizeFlt(val);
  if (num && /^\d+$/.test(num)) {
    _paFltStatus('Loading...', 'loading');
    _paFltTimer = setTimeout(function() { _paFltLookup(num); }, 500);
  } else {
    _paFltStatus('', '');
  }
}

function _paFetchDirect() {
  var ep = atob('aHR0cHM6Ly93d3cudGFveXVhbi1haXJwb3J0LmNvbS9hcGkvYXBpL2ZsaWdodC9hX2ZsaWdodA==');
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 3600000);
  var odate = tw.getUTCFullYear() + '/' +
    String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(tw.getUTCDate()).padStart(2, '0');
  var base = {
    ODate: odate, OTimeOpen: null, OTimeClose: null,
    BNO: null, AState: '', language: 'ch', keyword: ''
  };
  var hdrs = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' };
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

function _paFltLookup(num) {
  var now = Date.now();
  if (_paFidsCache && now - _paFidsCacheTime < 120000) {
    console.log('[PA-FLT] Using cache, dep=' + (_paFidsCache.dep || []).length + ' arr=' + (_paFidsCache.arr || []).length);
    _paMatchFlight(num);
    return;
  }
  console.log('[PA-FLT] Fetching /api/fids ...');
  fetch('/api/fids').then(function(r) {
    console.log('[PA-FLT] Response status=' + r.status);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function(data) {
    console.log('[PA-FLT] Data received: dep=' + (data.dep || []).length + ' arr=' + (data.arr || []).length);
    _paFidsCache = data;
    _paFidsCacheTime = Date.now();
    _paMatchFlight(num);
  }).catch(function(err) {
    console.warn('[PA-FLT] Proxy failed, trying direct...', err);
    _paFetchDirect().then(function(data) {
      console.log('[PA-FLT] Direct OK: dep=' + (data.dep || []).length + ' arr=' + (data.arr || []).length);
      _paFidsCache = data;
      _paFidsCacheTime = Date.now();
      _paMatchFlight(num);
    }).catch(function(err2) {
      console.error('[PA-FLT] Direct also failed:', err2);
      _paFltStatus('Connection failed: ' + (err2.message || err2), 'error');
    });
  });
}

function _paMatchFlight(num) {
  if (!_paFidsCache) { _paFltStatus('No data', 'error'); return; }
  var dest = _paFltToDest(num);
  if (dest) {
    _paFltStatus('→ ' + dest, 'ok');
    _paOnDestInput(dest);
  } else {
    _paFltStatus('JX' + num + ' not found', 'warn');
    _paOnDestInput('');
  }
}

// ── 自動同步邏輯 ─────────────────────────────────────────────────────────────
function _paOnDestInput(val) {
  _paGlobalDest = val;
  try { localStorage.setItem('crewsync_pa_dest', val); } catch(e){}
  _paSelectedStation = val.toUpperCase().trim();
  var el = document.getElementById('pa-content');
  if (!el) return;
  el.querySelectorAll('[data-pa="dest"]').forEach(function(inp) {
    if (document.activeElement !== inp) inp.value = val;
  });
  var zhName = val ? (_paIataToName[val.toUpperCase().trim()] || val) : '';
  el.querySelectorAll('[data-pa="dest-zh"]').forEach(function(inp) {
    if (document.activeElement !== inp) inp.value = zhName;
  });
  if (_paCurrentCat === 'descent') _paFillDescentTime();
  document.querySelectorAll('.pa-tz-link').forEach(function(l) {
    l.classList.toggle('pa-tz-selected', l.textContent === _paSelectedStation);
  });
}

function _paFillDescentTime() {
  var tz = _paGetDestTz(_paGlobalDest);
  var el = document.getElementById('pa-content');
  if (!el) return;
  var q = function(s) { return el.querySelector('[data-pa="' + s + '"]'); };
  if (!tz) {
    var lt = q('local-time'); if (lt) lt.value = '';
    var ltCn = q('local-time-cn'); if (ltCn) ltCn.value = '';
    var ap = q('ampm-local'); if (ap) ap.textContent = '';
    var apCn = q('ampm-local-cn'); if (apCn) apCn.textContent = '';
    var dy = q('local-day'); if (dy) dy.value = '';
    var dyCn = q('local-day-cn'); if (dyCn) dyCn.value = '';
    return;
  }
  var t = _paCalcLocalTime(tz);
  var lt = q('local-time'); if (lt) lt.value = t.time12;
  var ltCn = q('local-time-cn'); if (ltCn) ltCn.value = t.time12;
  var ap = q('ampm-local'); if (ap) ap.textContent = t.ampm;
  var apCn = q('ampm-local-cn'); if (apCn) apCn.textContent = t.ampmCn;
  var dy = q('local-day'); if (dy) dy.value = t.dayEn;
  var dyCn = q('local-day-cn'); if (dyCn) dyCn.value = t.dayCn;
}

/* ── METAR → 簡單天氣描述 ── */
var _paWxPhenomena = {
  'TS':   { en: 'Thunderstorm', zh: '雷陣雨' },
  'TSRA': { en: 'Thunderstorm', zh: '雷陣雨' },
  '+RA':  { en: 'Heavy Rain', zh: '大雨' },
  'RA':   { en: 'Rain', zh: '下雨' },
  '-RA':  { en: 'Light Rain', zh: '小雨' },
  '+SHRA':{ en: 'Heavy Showers', zh: '大陣雨' },
  'SHRA': { en: 'Showers', zh: '陣雨' },
  '-SHRA':{ en: 'Light Showers', zh: '小陣雨' },
  'DZ':   { en: 'Drizzle', zh: '毛毛雨' },
  '-DZ':  { en: 'Light Drizzle', zh: '毛毛雨' },
  '+SN':  { en: 'Heavy Snow', zh: '大雪' },
  'SN':   { en: 'Snow', zh: '下雪' },
  '-SN':  { en: 'Light Snow', zh: '小雪' },
  'FG':   { en: 'Fog', zh: '霧' },
  'BR':   { en: 'Mist', zh: '薄霧' },
  'HZ':   { en: 'Haze', zh: '霾' },
  'SQ':   { en: 'Squall', zh: '暴風' },
  'GR':   { en: 'Hail', zh: '冰雹' }
};

function _paMetarToWx(raw, isNight) {
  if (!raw) return { en: '', zh: '' };
  var tokens = raw.split(/\s+/);
  // 找天氣現象
  var wxFound = null;
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (_paWxPhenomena[t]) { wxFound = _paWxPhenomena[t]; break; }
    // 帶強度前綴
    if (t.length > 1 && _paWxPhenomena[t]) { wxFound = _paWxPhenomena[t]; break; }
  }
  // 找雲層（取最高覆蓋）
  var skyOrder = { SKC: 0, CLR: 0, NSC: 0, FEW: 1, SCT: 2, BKN: 3, OVC: 4 };
  var skyNames = {
    0: { en: 'Sky Clear', zh: '晴天', zhNight: '好天氣' },
    1: { en: 'Few Clouds', zh: '疏雲' },
    2: { en: 'Partly Cloudy', zh: '局部有雲' },
    3: { en: 'Mostly Cloudy', zh: '多雲' },
    4: { en: 'Overcast', zh: '陰天' }
  };
  var maxSky = -1;
  for (var i = 0; i < tokens.length; i++) {
    var prefix = tokens[i].substring(0, 3);
    if (skyOrder[prefix] !== undefined && skyOrder[prefix] > maxSky) maxSky = skyOrder[prefix];
  }
  var skyRaw = maxSky >= 0 ? skyNames[maxSky] : null;
  var sky = null;
  if (skyRaw) {
    var zhText = (isNight && skyRaw.zhNight) ? skyRaw.zhNight : skyRaw.zh;
    sky = { en: skyRaw.en, zh: zhText };
  }

  if (wxFound && sky) {
    return { en: sky.en + ', ' + wxFound.en, zh: sky.zh + '，' + wxFound.zh };
  } else if (wxFound) {
    return wxFound;
  } else if (sky) {
    return sky;
  }
  return { en: '', zh: '' };
}

function _paFetchDescentWx() {
  var el = document.getElementById('pa-content');
  if (!el) return;
  // 取目的地 IATA
  var destInp = el.querySelector('[data-pa="dest"]');
  var iata = destInp ? destInp.value.trim().toUpperCase() : '';
  if (!iata && _paGlobalDest) iata = _paGlobalDest.trim().toUpperCase();
  if (!iata) { alert('請先填入目的地 / Enter destination first'); return; }

  var icao = (typeof _briefIataToIcao !== 'undefined' && _briefIataToIcao[iata]) || iata;
  if (!/^[A-Z]{4}$/.test(icao)) { alert('無法辨識機場代碼 / Unknown airport code'); return; }

  // 顯示載入中
  var wxEn = el.querySelector('[data-pa="wx-en"]');
  var wxZh = el.querySelector('[data-pa="wx-zh"]');
  if (wxEn) wxEn.value = '...';
  if (wxZh) wxZh.value = '...';

  fetch('/api/metar?ids=' + icao + '&hours=6').then(function(r) {
    return r.ok ? r.text() : Promise.reject();
  }).then(function(text) {
    var lines = text.trim().split('\n').filter(function(l) { return l.trim(); });
    if (lines.length === 0) throw new Error('no data');
    var raw = lines[0].replace(/^(METAR|SPECI)\s+/, '').trim();
    // 判斷目的地是否為晚上（18:00–06:00）
    var isNight = false;
    var destTz = _paGetDestTz(iata);
    if (destTz !== null) {
      var localH = new Date(Date.now() + destTz * 3600000).getUTCHours();
      isNight = localH >= 18 || localH < 6;
    }
    var wx = _paMetarToWx(raw, isNight);
    if (wxEn) wxEn.value = wx.en || 'N/A';
    if (wxZh) wxZh.value = wx.zh || 'N/A';
    // 帶入溫度
    if (typeof parseMetarLine === 'function') {
      var m = parseMetarLine(raw);
      if (m && m.temp !== null && m.temp !== undefined) {
        _paOnTempInput('c', String(m.temp));
      }
    }
  }).catch(function() {
    if (wxEn) wxEn.value = '';
    if (wxZh) wxZh.value = '';
    alert('天氣查詢失敗 / Weather fetch failed');
  });
}

function _paOnTempInput(from, val) {
  var num = parseFloat(val);
  if (from === 'c') {
    _paGlobalTempC = val;
    _paGlobalTempF = isNaN(num) ? '' : String(Math.round(num * 9 / 5 + 32));
  } else {
    _paGlobalTempF = val;
    _paGlobalTempC = isNaN(num) ? '' : String(Math.round((num - 32) * 5 / 9));
  }
  var cEl = document.getElementById('pa-temp-c');
  var fEl = document.getElementById('pa-temp-f');
  if (cEl) cEl.value = _paGlobalTempC;
  if (fEl) fEl.value = _paGlobalTempF;
  _paSyncTempToContent();
}

function _paSyncField(attr, source) {
  var el = document.getElementById('pa-content');
  if (!el) return;
  el.querySelectorAll('[data-pa="' + attr + '"]').forEach(function(inp) {
    if (inp !== source) inp.value = source.value;
  });
}

function _paInitListeners() {
  if (_paListenersReady) return;
  var content = document.getElementById('pa-content');
  if (!content) return;
  content.addEventListener('input', function(e) {
    var attr = e.target.getAttribute('data-pa');
    if (!attr) return;
    if (attr === 'dest') _paOnDestInput(e.target.value);
    else if (attr === 'dest-zh') _paSyncField('dest-zh', e.target);
    else if (attr === 'flt') _paOnFltInput(e.target.value);
    else if (attr === 'temp-c') _paOnTempInput('c', e.target.value);
    else if (attr === 'temp-f') _paOnTempInput('f', e.target.value);
    else _paSyncField(attr, e.target);
    // 手動修改 flag（flt-hr / flt-min / altitude）
    if (attr === 'flt-hr' || attr === 'flt-min' || attr === 'altitude') {
      _paManualFlags[attr] = true;
    }
    _paSaveInputs();
  });
  _paListenersReady = true;
}

function _paRestoreValues() {
  var el = document.getElementById('pa-content');
  if (!el) return;
  if (_paGlobalFlt) {
    el.querySelectorAll('[data-pa="flt"]').forEach(function(inp) { inp.value = _paGlobalFlt; });
  }
  if (_paGlobalDest) {
    el.querySelectorAll('[data-pa="dest"]').forEach(function(inp) { inp.value = _paGlobalDest; });
    var zhName = _paIataToName[_paGlobalDest.toUpperCase().trim()] || _paGlobalDest;
    el.querySelectorAll('[data-pa="dest-zh"]').forEach(function(inp) { inp.value = zhName; });
  }
  // 機長姓名從 localStorage 還原
  var savedName = localStorage.getItem('crewsync_captain_name') || '';
  var savedNameZh = localStorage.getItem('crewsync_captain_name_zh') || '';
  if (savedName) el.querySelectorAll('[data-pa="captain-name"]').forEach(function(inp) { inp.value = savedName; });
  if (savedNameZh) el.querySelectorAll('[data-pa="captain-name-zh"]').forEach(function(inp) { inp.value = savedNameZh; });
  // 輸入時存入
  el.querySelectorAll('[data-pa="captain-name"]').forEach(function(inp) {
    inp.addEventListener('input', function() { localStorage.setItem('crewsync_captain_name', inp.value); });
  });
  el.querySelectorAll('[data-pa="captain-name-zh"]').forEach(function(inp) {
    inp.addEventListener('input', function() { localStorage.setItem('crewsync_captain_name_zh', inp.value); });
  });
  // 還原手動 flag 中有值的欄位（flt-hr / flt-min / altitude）
  try {
    var savedPaInputs = JSON.parse(localStorage.getItem('crewsync_pa_inputs') || '{}');
    ['flt-hr','flt-min','altitude'].forEach(function(attr) {
      if (_paManualFlags[attr] && savedPaInputs[attr]) {
        el.querySelectorAll('[data-pa="' + attr + '"]').forEach(function(inp) { inp.value = savedPaInputs[attr]; });
      }
    });
  } catch(e){}
  if (_paCurrentCat === 'descent') {
    _paSyncTempToContent();
    if (_paGlobalDest) _paFillDescentTime();
  }
}

/* ── PA 手動值持久化 ── */
function _paSaveInputs() {
  try {
    var el = document.getElementById('pa-content');
    if (!el) return;
    var obj = {};
    el.querySelectorAll('.pa-input[data-pa]').forEach(function(inp) {
      var attr = inp.getAttribute('data-pa');
      if (attr && inp.value) obj[attr] = inp.value;
    });
    localStorage.setItem('crewsync_pa_inputs', JSON.stringify(obj));
    localStorage.setItem('crewsync_pa_manual_flags', JSON.stringify(_paManualFlags));
  } catch(e){}
}

/* ── PA 重設（清除全部，只留機長姓名 + 自訂筆記）── */
function paReset() {
  _paGlobalFlt = '';
  _paGlobalDest = '';
  _paGlobalTempC = '';
  _paGlobalTempF = '';
  _paSelectedStation = '';
  _paManualFlags = {};
  try {
    localStorage.removeItem('crewsync_pa_flt');
    localStorage.removeItem('crewsync_pa_dest');
    localStorage.removeItem('crewsync_pa_inputs');
    localStorage.removeItem('crewsync_pa_manual_flags');
  } catch(e){}
  var cEl = document.getElementById('pa-temp-c');
  var fEl = document.getElementById('pa-temp-f');
  if (cEl) cEl.value = '';
  if (fEl) fEl.value = '';
  var fltInput = document.getElementById('pa-lt-input');
  if (fltInput) fltInput.value = '';
  var statusEl = document.getElementById('pa-flt-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'pa-flt-status'; }
  // 重新渲染當前分類（名字會自動還原，跳過提示卡同步）
  _paSkipBriefSync = true;
  paSwitchCat(_paCurrentCat, document.querySelector('.pa-cat-btn.active'));
}

// ── PA 廣播詞內容 ────────────────────────────────────────────────────────────
var _paCurrentCat = 'welcome';
var _paScripts = {};

_paScripts.welcome = '<div class="pa-note">When all passengers are boarded, the CIC will inform the PIC to make a brief welcome PA.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is Captain <input class="pa-input" data-pa="captain-name" placeholder="Full Name"> speaking. On behalf of <span class="pa-choice">[the cockpit crew / all the crew]</span>, welcome onboard STARLUX flight number <input class="pa-input" data-pa="flt" placeholder="e.g. JX2"> <span id="pa-flt-status" class="pa-flt-status"></span> to <input class="pa-input" data-pa="dest" placeholder="e.g. LAX">. We should be ready for departure in <input class="pa-input pa-input-num" data-pa="dep-min" inputmode="numeric"> minutes. Our flight time is <input class="pa-input pa-input-num" data-pa="flt-hr" inputmode="numeric"> hours and <input class="pa-input pa-input-num" data-pa="flt-min" inputmode="numeric"> minutes, with an initial cruising altitude of <input class="pa-input" data-pa="altitude" inputmode="numeric" style="min-width:70px" placeholder="XX,XXX"> feet. Once again, please make yourself comfortable and enjoy the flight with us. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「' + _paGreetingOrigin + '，各位貴賓，我是機長 <input class="pa-input" data-pa="captain-name-zh" placeholder="姓名">。代表<span class="pa-choice">[駕駛艙組員 / 全體組員]</span>，歡迎搭乘星宇航空 <input class="pa-input" data-pa="flt" placeholder="e.g. JX2"> 班機前往 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯">。我們預計在 <input class="pa-input pa-input-num" data-pa="dep-min" inputmode="numeric"> 分鐘後出發。飛行時間約 <input class="pa-input pa-input-num" data-pa="flt-hr" inputmode="numeric"> 小時 <input class="pa-input pa-input-num" data-pa="flt-min" inputmode="numeric"> 分鐘，初始巡航高度 <input class="pa-input" data-pa="altitude" inputmode="numeric" style="min-width:70px"> 呎。再次祝您旅途愉快，謝謝。」</div>';

_paScripts.delay = '<div class="pa-note">If ground delay is expected to be more than 15 minutes before pushback, a ground delay PA should be delivered.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your captain speaking. Due to <input class="pa-input" placeholder="Delay Reason">, we might be delayed up to <input class="pa-input pa-input-num" data-pa="delay-min" inputmode="numeric"> minutes before takeoff. I will keep you updated if longer delay happens. Thank you for your patient."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位貴賓，這裡是機長廣播。由於 <input class="pa-input" placeholder="延誤原因">，我們可能需要延遲約 <input class="pa-input pa-input-num" data-pa="delay-min" inputmode="numeric"> 分鐘後才能起飛。如有更長時間的延誤，我會再向各位報告。感謝您的耐心等候。」</div>';

_paScripts.descent = '<div class="pa-note">The PA shall be given around 10 minutes before top of descent. <button class="pa-wx-refresh" onclick="_paFetchDescentWx()">Refresh WX</button></div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your captain speaking. We are approaching <input class="pa-input" data-pa="dest" placeholder="e.g. LAX"> and expect to start our descent in 10 minutes. We estimate landing at <input class="pa-input pa-input-num" data-pa="eta" inputmode="numeric" style="min-width:50px" placeholder="HH:MM"> <span class="pa-choice">[a.m. / p.m.]</span>. The current local time in <input class="pa-input" data-pa="dest" placeholder="e.g. LAX"> is <input class="pa-input pa-input-num" data-pa="local-time" inputmode="numeric" style="min-width:50px" placeholder="HH:MM"> <span class="pa-choice" data-pa="ampm-local">[a.m. / p.m.]</span> on <input class="pa-input" data-pa="local-day" placeholder="Day and Date">. The present weather at the airport is <input class="pa-input" data-pa="wx-en" placeholder="Weather Condition"> with a temperature of <input class="pa-input pa-input-num" data-pa="temp-c" inputmode="numeric"> degree Celsius, which is <input class="pa-input pa-input-num" data-pa="temp-f" inputmode="numeric"> degree Fahrenheit. We certainly hope that you have enjoyed the flight with us, and we look forward to having you onboard another STARLUX flight again very soon. Thank you, and we wish you all a very pleasant journey."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「' + _paGreetingDest + '，各位貴賓，這裡是機長廣播。我們即將接近 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯">，預計在 10 分鐘後開始下降。預計落地時間為 <span class="pa-choice">[上午 / 下午]</span> <input class="pa-input pa-input-num" data-pa="eta" inputmode="numeric" style="min-width:50px" placeholder="HH:MM">。<input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 當地時間為 <input class="pa-input" data-pa="local-day-cn" placeholder="星期與日期"> <span class="pa-choice" data-pa="ampm-local-cn">[上午 / 下午]</span> <input class="pa-input pa-input-num" data-pa="local-time-cn" inputmode="numeric" style="min-width:50px" placeholder="HH:MM">。目前機場天氣為 <input class="pa-input" data-pa="wx-zh" placeholder="天氣狀況">，氣溫攝氏 <input class="pa-input pa-input-num" data-pa="temp-c" inputmode="numeric"> 度，華氏 <input class="pa-input pa-input-num" data-pa="temp-f" inputmode="numeric"> 度。非常感謝各位搭乘星宇航空，期待再次為您服務。祝各位旅途愉快。」</div>';

_paScripts.turbulence = '<div class="pa-sub">i. Approaching an Area of Known or Forecast Turbulence</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your Captain speaking. We will soon be flying through an area with light to moderate turbulence. We have already made <span class="pa-choice">[changes to our route and altitude / deviations]</span> to provide you with the smoothest flight possible. To ensure your safety, please stay in your seats and fasten your seat belt."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位貴賓，這裡是機長廣播。我們即將通過一個輕度到中度亂流區域。我們已經 <span class="pa-choice">[調整航路和高度 / 偏航]</span> 以提供最平穩的飛行。為了您的安全，請留在座位上並繫好安全帶。」</div>' +
  '<div class="pa-sub">ii. To ask cabin crew to be seated</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"For the safety of the cabin crew, I have asked them to stop the inflight service, take their seats, and remain seated, until we have passed through this area. We apologize for any inconvenience. The inflight service will resume as soon as flight conditions permit. We expect that these conditions to last for approximately <input class="pa-input pa-input-num" data-pa="turb-min" inputmode="numeric"> minutes. <span class="pa-choice">(If estimate of the period of turbulence is known)</span> Your cooperation and understanding are always appreciated. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「為了組員的安全，我已請空服員暫停機上服務並回座就位，待我們通過此區域後再恢復。造成不便敬請見諒，機上服務將在飛行條件允許時盡快恢復。預計此狀況將持續約 <input class="pa-input pa-input-num" data-pa="turb-min" inputmode="numeric"> 分鐘。<span class="pa-choice">（如已知亂流持續時間）</span>感謝您的配合與理解。」</div>';

_paScripts.deice = '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, welcome on board. This is your Captain speaking. Today we must complete a procedure to protect the aircraft against the build-up of ice. And we will be on ground for <input class="pa-input pa-input-num" data-pa="deice-min" inputmode="numeric"> minutes. <span class="pa-choice">(If delay)</span> This will involve the spraying of a fluid on the aircraft; there may be some noise during this process and, possibly, a slightly unusual smell inside of the cabin. The procedure is routine and should be completed in a few minutes. Thank you for your attention."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位貴賓，歡迎登機。這裡是機長廣播。今天我們需要進行除冰/防冰程序以保護飛機。我們將在地面等候約 <input class="pa-input pa-input-num" data-pa="deice-min" inputmode="numeric"> 分鐘。<span class="pa-choice">（如有延遲）</span>過程中會在機身噴灑除冰液，期間可能會有一些噪音，機艙內也可能聞到些許異味。這是例行程序，幾分鐘內即可完成。感謝您的配合。」</div>';

_paScripts.missedappr = '<div class="pa-note">The PA should be done after the aircraft has leveled at missed approach altitude with completion of the After Takeoff Checklist, and before the start of next approach.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"May we have your attention. This is your Captain speaking. We were unable to complete our approach to landing at <input class="pa-input" data-pa="dest" placeholder="e.g. LAX">. We have just completed a routine go-around procedure and, shortly, we shall be starting another approach to land. We will be landing in <input class="pa-input pa-input-num" data-pa="ga-min" inputmode="numeric"> minutes. Thank you for your attention."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位貴賓，請注意。這裡是機長廣播。我們無法完成在 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 的進場降落。我們剛剛已完成例行的重飛程序，稍後將再次進場降落。預計在 <input class="pa-input pa-input-num" data-pa="ga-min" inputmode="numeric"> 分鐘後落地。感謝您的配合。」</div>';

_paScripts.diversion = '<div class="pa-lang">English</div>' +
  '<div>"May we have your attention. This is your Captain speaking. The weather at <input class="pa-input" data-pa="dest" placeholder="e.g. LAX"> airport is below landing minimum, we are unable to land at this moment. We shall divert to <input class="pa-input" data-pa="alt-apt" placeholder="Alternate"> airport, and we can wait for the weather at <input class="pa-input" data-pa="dest" placeholder="e.g. LAX"> airport to improve."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位貴賓，請注意。這裡是機長廣播。<input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 機場天氣低於降落標準，目前無法降落。我們將轉降至 <input class="pa-input" data-pa="alt-apt" placeholder="備降機場">，等待 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 機場天氣改善。」</div>';

_paScripts.modsevcat = '<div class="pa-sub">i. Normal</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your Captain speaking. We have just encountered an area of <span class="pa-choice">[moderate / severe]</span> Clear Air Turbulence. The aircraft condition is safe, with all systems operating normally. This type of turbulence cannot be detected with our system and was unexpected. We appreciate your cooperation to stay in your seats with seatbelt fasten until the seatbelt sign is turned off."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位貴賓，這裡是機長廣播。我們剛剛遭遇了一個 <span class="pa-choice">[中度 / 強烈]</span> 晴空亂流區域。飛機狀態安全，所有系統運作正常。此類亂流無法被系統偵測且為突發狀況。請您配合留在座位上繫好安全帶，直到安全帶指示燈熄滅為止。」</div>' +
  '<div class="pa-sub">ii. If damage to cabin or injury</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"The cabin crew are now making every effort to safeguard the condition of everyone onboard. If you need assistance, the crew will help you as soon as possible. We appreciate your cooperation to stay in your seats until the seatbelt sign is turned off. After an assessment of conditions onboard are completed, I will provide you with more information regarding the status of the flight. Your cooperation and understanding are appreciated to ensure the safety of all onboard. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「空服員正全力確保機上每位旅客的狀況。如果您需要協助，組員會盡快前來幫忙。請您配合留在座位上，直到安全帶指示燈熄滅為止。在完成機上狀況評估後，我會再向各位報告航班最新資訊。感謝您的配合與理解，以確保機上所有人員的安全。謝謝。」</div>' +
  '<div class="pa-sub">iii. If more turbulence is forecast</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"However, it is possible that we may experience some light turbulence <span class="pa-choice">[later / during descent]</span>. I will provide you with an update before we start our descent. We invite you to relax and enjoy the remainder of the flight to <input class="pa-input" data-pa="dest" placeholder="e.g. LAX">. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「不過，<span class="pa-choice">[稍後 / 下降過程中]</span> 可能還會遇到輕微亂流。在開始下降前我會再向各位報告。請放鬆心情，享受飛往 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 的剩餘旅程。謝謝。」</div>';

_paScripts.unrulypax = '<div class="pa-lang">English</div>' +
  '<div>"This is your captain speaking. The passenger at <input class="pa-input" data-pa="seat" placeholder="Seat Number">, we have already warned you about your unacceptable behavior and requested you to moderate it. This is the FINAL WARNING that your unruly behavior has violated the above laws and regulations. If the unruly behavior remains, it may be committed a criminal offence, and you may be restrained and handed over to the aviation security authorities. Punishment may be imposed against you, including but not limited to imprisonment, detention or monetary fine. If there is any diversion, stop over or delay caused by your unruly behavior, STARLUX Airlines shall be entitled to request you for any and all losses, expenses and damages incurred from such circumstances. PLEASE NOW COOPERATE WITH OUR CREW MEMBERS IN AN AMICABLE WAY."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位女士、各位先生，這裡是機長廣播，我現在鄭重的對座位在 <input class="pa-input" data-pa="seat" placeholder="座位號碼">（及其附近）的乘客提出警告，您現在的行為已經嚴重的違反了中華民國民用航空法。現在請您立即停止滋擾他人及破壞客艙安寧的行為，並依照空服人員的指示配合執行！若因您的行為而造成飛機的延誤、轉降或公司任何損失，公司將依法向您個人提出求償！感謝您們的理解與配合，謝謝！」</div>';

// ── PA 分類切換 ──────────────────────────────────────────────────────────────
var _paSkipBriefSync = false;
function paSwitchCat(cat, btn) {
  _paCurrentCat = cat;
  document.querySelectorAll('.pa-cat-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  var content = document.getElementById('pa-content');
  if (_paScripts[cat]) {
    content.innerHTML = '<div class="pa-script">' + _paScripts[cat] + '</div>';
  } else {
    content.innerHTML = '<div class="pa-placeholder">廣播詞範本準備中...<br>PA script coming soon...</div>';
  }
  _paInitListeners();
  _paRestoreValues();
  if (!_paSkipBriefSync) {
    if (typeof _briefApplyFtToPa === 'function' && !_paManualFlags['flt-hr'] && !_paManualFlags['flt-min']) _briefApplyFtToPa();
    if (typeof _briefApplyAltToPa === 'function' && !_paManualFlags['altitude']) _briefApplyAltToPa();
  }
  _paSkipBriefSync = false;
  _paInjectNotes(cat);
  if (_paContentTimer) clearInterval(_paContentTimer);
  _paUpdateGreetings();
  if (cat === 'descent') _paFillDescentTime();
  _paContentTimer = setInterval(function() {
    _paUpdateGreetings();
    if (_paCurrentCat === 'descent') _paFillDescentTime();
  }, 30000);
}

function _paInjectNotes(cat) {
  var script = document.querySelector('#pa-content .pa-script');
  if (!script) return;
  var langs = script.querySelectorAll('.pa-lang');
  var lastEn = null, lastZh = null;
  langs.forEach(function(el) {
    var txt = el.textContent.trim();
    if (txt === 'English') lastEn = el;
    else if (txt === '中文') lastZh = el;
  });
  if (lastEn) _paAttachNote(lastEn, cat, 'en', '📝', 'Write your own version here...');
  if (lastZh) _paAttachNote(lastZh, cat, 'zh', '📝', '寫下你自己的版本...');
}

function _paAttachNote(langEl, cat, lang, label, placeholder) {
  var key = 'crewsync_pa_note_' + cat + '_' + lang;
  var saved = '';
  try { saved = localStorage.getItem(key) || ''; } catch(e){}
  // Button next to language label
  var btn = document.createElement('button');
  btn.className = 'pa-note-toggle';
  btn.textContent = label;
  langEl.appendChild(btn);
  // Textarea right after the language label (before content)
  var ta = document.createElement('textarea');
  ta.className = 'pa-note-area';
  ta.placeholder = placeholder;
  ta.value = saved;
  ta.style.display = saved ? 'block' : 'none';
  // 清除按鈕
  var clearBtn = document.createElement('button');
  clearBtn.className = 'pa-note-clear';
  clearBtn.textContent = '✕';
  clearBtn.title = 'Clear / 清除';
  clearBtn.style.display = saved ? 'inline' : 'none';
  clearBtn.addEventListener('click', function() {
    ta.value = '';
    ta.style.display = 'none';
    clearBtn.style.display = 'none';
    try { localStorage.removeItem(key); } catch(e){}
  });
  langEl.appendChild(clearBtn);
  btn.addEventListener('click', function() {
    ta.style.display = ta.style.display === 'none' ? 'block' : 'none';
  });
  ta.addEventListener('input', function() {
    try { localStorage.setItem(key, ta.value); } catch(e){}
    clearBtn.style.display = ta.value ? 'inline' : 'none';
  });
  langEl.after(ta);
}

function _paFindContent(langEl) {
  var el = langEl.nextElementSibling;
  var last = null;
  while (el) {
    if (el.classList.contains('pa-lang') || el.classList.contains('pa-sub')) break;
    if (el.tagName !== 'TEXTAREA' && !el.classList.contains('pa-note-block')) last = el;
    el = el.nextElementSibling;
  }
  return last;
}
