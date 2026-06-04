// ── Roster Grid 月班表 ───────────────────────────────────────────────────────
var _rgYear = new Date().getFullYear();
var _rgMonth = new Date().getMonth() + 1;
var _rgData = null; // { duties: [...], pictures: {} }
var _rgLoading = false;
var _rgView = 'calendar'; // 'calendar' or 'grid'

function _rgUpdateSyncHint(monthKey) {
  var el = document.getElementById('rg-sync-hint');
  if (!el) return;
  var syncTime = null;
  try { syncTime = localStorage.getItem('crewsync_roster_sync_time_' + monthKey); } catch(e){}
  if (syncTime) {
    var d = new Date(syncTime);
    var dateStr = d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    el.innerHTML = '⚠️ 班表不會自動更新（📱 本機離線儲存 · 上次同步：' + dateStr + '）<br>Roster does not auto-sync. (📱 Local storage · Last sync: ' + dateStr + ')';
  } else {
    el.innerHTML = '⚠️ 此月份尚未同步，請先至 Crew Sync 同步班表<br>No roster data for this month. Please sync your roster first.';
  }
}

function _rgInit() {
  var eid = localStorage.getItem('crewsync_eid');
  var monthKey = _rgYear + '-' + String(_rgMonth).padStart(2, '0');
  _rgUpdateSyncHint(monthKey);
  if (!eid) {
    document.getElementById('rg-grid').innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">請先同步班表<br>Please sync your roster first</div>';
    return;
  }
  _rgLoadMonth();
}

function _rgSetView(view) {
  _rgView = view;
  var calBtn = document.getElementById('rg-view-cal');
  var gridBtn = document.getElementById('rg-view-grid');
  if (calBtn && gridBtn) {
    calBtn.style.background = view === 'calendar' ? 'var(--accent)' : '#2d3748';
    calBtn.style.color = view === 'calendar' ? '#fff' : '#e2e8f0';
    gridBtn.style.background = view === 'grid' ? 'var(--accent)' : '#2d3748';
    gridBtn.style.color = view === 'grid' ? '#fff' : '#e2e8f0';
  }
  if (_rgData) _rgRender();
}

function _rgPrevMonth() {
  _rgMonth--;
  if (_rgMonth < 1) { _rgMonth = 12; _rgYear--; }
  document.getElementById('rg-detail').style.display = 'none';
  _rgLoadMonth();
}

function _rgNextMonth() {
  _rgMonth++;
  if (_rgMonth > 12) { _rgMonth = 1; _rgYear++; }
  document.getElementById('rg-detail').style.display = 'none';
  _rgLoadMonth();
}

function _rgLoadMonth() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid || _rgLoading) return;
  _rgLoading = true;
  var monthKey = _rgYear + '-' + String(_rgMonth).padStart(2, '0');
  var titleEl = document.getElementById('rg-month-title');
  var months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  titleEl.textContent = months[_rgMonth] + ' ' + _rgYear;

  var gridEl = document.getElementById('rg-grid');
  var cacheKey = 'crewsync_roster_' + eid + '_' + monthKey;

  // 只讀 localStorage（離線可用，不依賴 server）
  var cached = null;
  try { cached = localStorage.getItem(cacheKey); } catch(e){}
  _rgLoading = false;
  if (cached) {
    try {
      _rgData = JSON.parse(cached);
      _rgRender();
    } catch(e){}
  } else {
    gridEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">此月份無班表資料<br>No roster data for this month</div>';
  }
  _rgUpdateSyncHint(monthKey);
}

function _rgGetDayMap() {
  if (!_rgData) return {};
  var dayMap = {};
  var duties = _rgData.duties;
  for (var i = 0; i < duties.length; i++) {
    var d = duties[i];
    var dates = _rgParseDates(d.reportTime, d.endTime);
    for (var j = 0; j < dates.length; j++) {
      var dk = dates[j];
      if (!dayMap[dk]) dayMap[dk] = [];
      dayMap[dk].push(d);
    }
  }
  return dayMap;
}

function _rgRender() {
  if (_rgView === 'grid') _rgRenderGrid();
  else _rgRenderCalendar();
}

// ── Calendar View（月曆格式，跨天 bar）────────────────────────────────────
function _rgGetDutyColor(dutyName) {
  if (dutyName.indexOf('JX') >= 0) return '#7f1d1d'; // 深紅 = 航班
  if (/^S\d/.test(dutyName)) return '#166534'; // 綠 = 待命
  if (dutyName === 'MCC' || dutyName.indexOf('A35') >= 0 || dutyName.indexOf('A32') >= 0 || dutyName.indexOf('CRM') >= 0) return '#1e40af'; // 藍 = 訓練/體檢
  return '#6b7280'; // 灰 = 其他
}

function _rgGetDutyLabel(duty) {
  // "JX002/JX001 LAX" → "JX002|LAX"  (show first flight + dest)
  var d = duty.duty;
  if (d.indexOf('JX') >= 0) {
    var parts = d.split(' ');
    var dest = parts.length > 1 ? parts[parts.length - 1] : '';
    var flts = parts[0].split('/');
    return flts[0] + (dest ? '|' + dest : '');
  }
  return d;
}

function _rgCellDate(row, col, firstDay) {
  // Returns actual Date object for any cell position (including prev/next month overflow)
  var dayNum = row * 7 + col - firstDay + 1;
  return new Date(_rgYear, _rgMonth - 1, dayNum); // JS Date handles overflow automatically
}

function _rgDateKey(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}

function _rgRenderCalendar() {
  if (!_rgData) return;
  var gridEl = document.getElementById('rg-grid');
  var duties = _rgData.duties;

  var firstDay = new Date(_rgYear, _rgMonth - 1, 1).getDay(); // 0=Sun
  var daysInMonth = new Date(_rgYear, _rgMonth, 0).getDate();
  var today = new Date();
  var todayStr = _rgDateKey(today);
  var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var totalCells = firstDay + daysInMonth;
  var totalRows = Math.ceil(totalCells / 7);

  // Build dayMap: dateKey → [{duty, label}]
  var dayMap = {};
  for (var i = 0; i < duties.length; i++) {
    var d = duties[i];
    var dates = _rgParseDates(d.reportTime, d.endTime);
    for (var j = 0; j < dates.length; j++) {
      if (!dayMap[dates[j]]) dayMap[dates[j]] = [];
      dayMap[dates[j]].push(d);
    }
  }

  // Build events with grid positions (for bar spanning within rows)
  // Now includes overflow days from prev/next month
  var events = [];
  for (var i = 0; i < duties.length; i++) {
    var d = duties[i];
    var dates = _rgParseDates(d.reportTime, d.endTime);
    if (dates.length === 0) continue;
    // Collect all cell indices that this duty covers in the visible grid
    var cellIndices = [];
    for (var j = 0; j < dates.length; j++) {
      var p = dates[j].split('-');
      var dt = new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]));
      var cellIdx = Math.round((dt - new Date(_rgYear, _rgMonth - 1, 1)) / 86400000) + firstDay;
      if (cellIdx >= 0 && cellIdx < totalRows * 7) cellIndices.push(cellIdx);
    }
    if (cellIndices.length === 0) continue;
    // Split into week-rows
    var startIdx = cellIndices[0];
    var endIdx = cellIndices[cellIndices.length - 1];
    var cur = startIdx;
    while (cur <= endIdx) {
      var curRow = Math.floor(cur / 7);
      var curCol = cur % 7;
      var rowEndIdx = curRow * 7 + 6;
      if (rowEndIdx > endIdx) rowEndIdx = endIdx;
      var span = rowEndIdx - cur + 1;
      var startDate = _rgCellDate(curRow, curCol, firstDay);
      events.push({ duty: d, row: curRow, col: curCol, span: span, label: _rgGetDutyLabel(d), dateKey: _rgDateKey(startDate) });
      cur = rowEndIdx + 1;
    }
  }

  // Mark which cells have duties
  var cellsWithDuty = {};
  for (var i = 0; i < events.length; i++) {
    var idx = events[i].row * 7 + events[i].col;
    for (var s = 0; s < events[i].span; s++) cellsWithDuty[idx + s] = true;
  }

  var html = '';
  // Header
  html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);border-bottom:1px solid var(--dim)">';
  for (var h = 0; h < 7; h++) {
    var hColor = h === 0 || h === 6 ? 'color:#ef4444' : 'color:var(--muted)';
    html += '<div style="padding:8px 2px;text-align:center;font-size:.75em;font-weight:600;' + hColor + '">' + dayNames[h] + '</div>';
  }
  html += '</div>';

  // Rows
  for (var row = 0; row < totalRows; row++) {
    // Date numbers row
    html += '<div style="display:grid;grid-template-columns:repeat(7,1fr)">';
    for (var col = 0; col < 7; col++) {
      var dt = _rgCellDate(row, col, firstDay);
      var dateKey = _rgDateKey(dt);
      var dayNum = dt.getDate();
      var isToday = dateKey === todayStr;
      var isWeekend = col === 0 || col === 6;
      var dateColor = isWeekend ? 'color:#ef4444' : 'color:var(--text)';
      var bgColor = isToday ? 'background:rgba(59,130,246,.12)' : '';
      html += '<div style="padding:3px 4px;border-left:1px solid var(--dim);border-right:1px solid var(--dim);border-top:1px solid var(--dim);' + bgColor + '">';
      if (isToday) {
        html += '<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font-size:.75em;font-weight:700">' + dayNum + '</span>';
      } else {
        html += '<span style="font-size:.75em;font-weight:700;' + dateColor + '">' + dayNum + '</span>';
      }
      html += '</div>';
    }
    html += '</div>';

    // Event bars row
    html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);min-height:28px;position:relative">';
    // Find events in this row
    var rowEvents = [];
    for (var ei = 0; ei < events.length; ei++) {
      if (events[ei].row === row) rowEvents.push(events[ei]);
    }
    rowEvents.sort(function(a,b) { return a.col - b.col; });

    var filledCols = {};
    for (var re = 0; re < rowEvents.length; re++) {
      for (var sc = rowEvents[re].col; sc < rowEvents[re].col + rowEvents[re].span; sc++) filledCols[sc] = true;
    }

    var cellsHtml = '';
    for (var c = 0; c < 7; c++) {
      var cellIdx = row * 7 + c;
      // Check if this col is start of an event
      var found = false;
      for (var re = 0; re < rowEvents.length; re++) {
        if (rowEvents[re].col === c) {
          var ev = rowEvents[re];
          var color = _rgGetDutyColor(ev.duty.duty);
          cellsHtml += '<div style="grid-column:' + (c+1) + '/span ' + ev.span + ';background:' + color + ';color:#fff;border-radius:4px;margin:2px 1px;padding:2px 4px;font-size:.68em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;display:flex;align-items:center;min-height:24px" onclick="_rgShowDay(\'' + ev.dateKey + '\')">' + ev.label + '</div>';
          found = true;
          c += ev.span - 1;
          break;
        }
      }
      if (!found && !filledCols[c]) {
        if (!cellsWithDuty[cellIdx]) {
          var dt = _rgCellDate(row, c, firstDay);
          var dateKey = _rgDateKey(dt);
          cellsHtml += '<div style="border-left:1px solid var(--dim);border-right:1px solid var(--dim);border-bottom:1px solid var(--dim);display:flex;align-items:center;justify-content:center;font-size:.65em;color:var(--muted);opacity:.5;cursor:pointer" onclick="_rgShowDay(\'' + dateKey + '\')">OFF</div>';
        } else {
          cellsHtml += '<div style="border-left:1px solid var(--dim);border-right:1px solid var(--dim);border-bottom:1px solid var(--dim)"></div>';
        }
      }
    }
    html += cellsHtml;
    html += '</div>';
  }

  gridEl.innerHTML = html;
}

// ── Grid View（橫向捲動表格）─────────────────────────────────────────────
function _rgRenderGrid() {
  if (!_rgData) return;
  var gridEl = document.getElementById('rg-grid');
  var dayMap = _rgGetDayMap();
  var daysInMonth = new Date(_rgYear, _rgMonth, 0).getDate();
  var today = new Date();
  var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var monthAbbr = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  var colW = '72px';
  var html = '<table style="border-collapse:collapse;font-size:.72em">';

  // Header row: month day + weekday
  html += '<thead><tr>';
  for (var d = 1; d <= daysInMonth; d++) {
    var dateObj = new Date(_rgYear, _rgMonth - 1, d);
    var dow = dateObj.getDay();
    var isWeekend = dow === 0 || dow === 6;
    var dateKey = _rgYear + '-' + String(_rgMonth).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    var isToday = dateKey === todayStr;
    var hdrBg = isToday ? 'background:var(--accent);color:#fff' : isWeekend ? 'background:rgba(239,68,68,.15);color:#ef4444' : 'background:var(--surface);color:var(--muted)';
    html += '<th style="min-width:' + colW + ';width:' + colW + ';padding:4px 2px;text-align:center;border:1px solid var(--dim);' + hdrBg + ';position:sticky;top:0;z-index:1">';
    html += '<div style="font-size:.85em">' + monthAbbr[_rgMonth] + '</div>';
    html += '<div style="font-size:1.1em;font-weight:700">' + d + '</div>';
    html += '<div style="font-size:.8em">' + dayNames[dow] + '</div>';
    html += '</th>';
  }
  html += '</tr></thead>';

  // Duty row
  html += '<tbody><tr>';
  for (var d = 1; d <= daysInMonth; d++) {
    var dateKey = _rgYear + '-' + String(_rgMonth).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    var dayDuties = dayMap[dateKey] || [];
    var isToday = dateKey === todayStr;
    var bgStyle = isToday ? 'background:rgba(59,130,246,.08)' : '';

    html += '<td style="min-width:' + colW + ';width:' + colW + ';padding:3px 2px;vertical-align:top;border:1px solid var(--dim);cursor:pointer;' + bgStyle + '" onclick="_rgShowDay(\'' + dateKey + '\')">';

    if (dayDuties.length === 0) {
      html += '<div style="text-align:center;color:var(--muted);font-size:.85em;padding:4px 0;opacity:.5">OFF</div>';
    } else {
      for (var di = 0; di < dayDuties.length; di++) {
        var duty = dayDuties[di];
        var isJX = duty.duty.indexOf('JX') >= 0;

        // Flight number(s) bold
        var flightNos = _rgExtractFlightNos(duty.duty);
        var dest = _rgExtractDest(duty.duty);

        if (isJX && duty.flights && duty.flights.length > 0) {
          for (var fi = 0; fi < duty.flights.length; fi++) {
            var fl = duty.flights[fi];
            html += '<div style="text-align:center;margin-bottom:4px;border-bottom:1px solid var(--dim);padding-bottom:3px">';
            html += '<div style="font-weight:700;text-decoration:underline">' + (fl.flightNo || '') + '</div>';
            html += '<div style="color:var(--muted);font-size:.9em">' + (fl.depTime || '') + '</div>';
            html += '<div style="color:var(--muted);font-size:.9em">' + (fl.origin || '') + '</div>';
            html += '<div style="color:var(--muted);font-size:.9em">' + (fl.dest || '') + '</div>';
            html += '<div style="color:var(--muted);font-size:.9em">' + (fl.arrTime || '') + '</div>';
            html += '</div>';
          }
        } else {
          // Non-flight duty
          html += '<div style="text-align:center;font-weight:600;color:var(--text);padding:2px 0">' + duty.duty + '</div>';
        }
      }
    }
    html += '</td>';
  }
  html += '</tr></tbody></table>';
  gridEl.innerHTML = html;
}

// ── Helper functions ─────────────────────────────────────────────────────
function _rgExtractDest(dutyStr) {
  // "JX002/JX001 LAX" → "LAX"
  // "A35 RT" → "A35 RT"
  // "MCC" → "MCC"
  var parts = dutyStr.split(' ');
  if (parts.length > 1 && parts[0].indexOf('JX') >= 0) return parts[parts.length - 1];
  return dutyStr;
}

function _rgExtractFlightNos(dutyStr) {
  // "JX002/JX001 LAX" → ["JX002","JX001"]
  var parts = dutyStr.split(' ');
  if (parts.length > 0 && parts[0].indexOf('/') >= 0) return parts[0].split('/');
  if (parts[0].indexOf('JX') === 0) return [parts[0]];
  return [];
}

function _rgParseDates(reportTime, endTime) {
  var dates = [];
  var start = _rgParseDate(reportTime);
  var end = _rgParseDate(endTime);
  if (!start || isNaN(start.getTime())) return dates;
  if (!end || isNaN(end.getTime())) end = start;
  var cur = new Date(start);
  var endD = new Date(end);
  var maxDays = 30;
  while (cur <= endD && maxDays-- > 0) {
    var y = cur.getFullYear();
    var m = String(cur.getMonth() + 1).padStart(2, '0');
    var d = String(cur.getDate()).padStart(2, '0');
    dates.push(y + '-' + m + '-' + d);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function _rgParseDate(dateStr) {
  if (!dateStr) return null;
  var parts = dateStr.split(' ');
  if (parts.length < 1) return null;
  var dp = parts[0].split('.');
  if (dp.length < 3) return null;
  var monthNames = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  var mon = monthNames[dp[1]];
  if (mon === undefined) return null;
  return new Date(parseInt(dp[0]), mon, parseInt(dp[2]));
}

// ── Detail panel with Pairing / Crew tabs ────────────────────────────────
var _rgDetailDuties = [];
var _rgDetailDateKey = '';

function _rgShowDay(dateKey) {
  if (!_rgData) return;
  var duties = _rgData.duties;
  _rgDetailDuties = [];
  _rgDetailDateKey = dateKey;
  for (var i = 0; i < duties.length; i++) {
    var dates = _rgParseDates(duties[i].reportTime, duties[i].endTime);
    if (dates.indexOf(dateKey) >= 0) _rgDetailDuties.push(duties[i]);
  }

  var detailEl = document.getElementById('rg-detail');
  if (_rgDetailDuties.length === 0) {
    detailEl.style.display = 'none';
    return;
  }

  var parts = dateKey.split('-');
  var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var monthNames = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
  var dateObj = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
  var dateTitle = monthNames[parseInt(parts[1])] + ' ' + parseInt(parts[2]) + ', ' + dayNames[dateObj.getDay()];

  var html = '';
  // Header
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
  html += '<div style="font-weight:700;font-size:1em;color:var(--text)">' + dateTitle + '</div>';
  html += '<button onclick="document.getElementById(\'rg-detail\').style.display=\'none\'" style="background:none;border:none;color:var(--muted);font-size:1.3em;cursor:pointer;padding:0 4px">✕</button>';
  html += '</div>';

  // Pairing / Crew tabs
  html += '<div style="display:flex;border-bottom:2px solid var(--dim);margin-bottom:12px">';
  html += '<button id="rg-tab-pairing" onclick="_rgSwitchDetailTab(\'pairing\')" style="flex:1;padding:8px;background:none;border:none;border-bottom:2px solid var(--accent);color:var(--accent);font-weight:700;font-size:.85em;cursor:pointer;margin-bottom:-2px">PAIRING</button>';
  html += '<button id="rg-tab-crew" onclick="_rgSwitchDetailTab(\'crew\')" style="flex:1;padding:8px;background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);font-weight:700;font-size:.85em;cursor:pointer;margin-bottom:-2px">CREW</button>';
  html += '</div>';

  // Content area
  html += '<div id="rg-tab-content"></div>';

  detailEl.innerHTML = html;
  detailEl.style.display = 'block';
  _rgRenderPairingTab();
  // 用 panel 容器的 scrollTop 捲動，避免影響外層 subtab
  var panel = detailEl.closest('.roster-panel');
  if (panel) {
    var detailTop = detailEl.offsetTop - panel.offsetTop;
    panel.scrollTo({ top: detailTop, behavior: 'smooth' });
  }
}

function _rgSwitchDetailTab(tab) {
  var pBtn = document.getElementById('rg-tab-pairing');
  var cBtn = document.getElementById('rg-tab-crew');
  if (pBtn && cBtn) {
    pBtn.style.borderBottomColor = tab === 'pairing' ? 'var(--accent)' : 'transparent';
    pBtn.style.color = tab === 'pairing' ? 'var(--accent)' : 'var(--muted)';
    cBtn.style.borderBottomColor = tab === 'crew' ? 'var(--accent)' : 'transparent';
    cBtn.style.color = tab === 'crew' ? 'var(--accent)' : 'var(--muted)';
  }
  if (tab === 'pairing') _rgRenderPairingTab();
  else _rgRenderCrewTab();
}

// ── Pairing tab ──────────────────────────────────────────────────────────
function _rgRenderPairingTab() {
  var container = document.getElementById('rg-tab-content');
  if (!container) return;
  var html = '';

  for (var d = 0; d < _rgDetailDuties.length; d++) {
    var duty = _rgDetailDuties[d];
    var isJX = duty.duty.indexOf('JX') >= 0;

    if (isJX && duty.flights && duty.flights.length > 0) {
      for (var f = 0; f < duty.flights.length; f++) {
        var flight = duty.flights[f];
        html += '<div style="background:var(--card);border-radius:12px;margin-bottom:12px;border:1px solid var(--border);overflow:hidden">';

        // Flight number header
        html += '<div style="background:#7f1d1d;color:#fff;padding:10px;text-align:center;font-weight:700;font-size:1.05em">' + (flight.flightNo || duty.duty) + '</div>';

        // Position badge
        if (flight.position) {
          html += '<div style="padding:6px 20px 0;font-size:.75em"><span style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-weight:600;color:var(--accent)">' + flight.position + '</span></div>';
        }

        // Origin ✈ Destination (SkyCrew style)
        var wxId = 'rg-wx-' + d + '-' + f;
        if (flight.origin && flight.dest) {
          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px">';
          html += '<div style="text-align:center;flex:1">';
          html += '<div style="font-size:2em;font-weight:700;color:var(--text);letter-spacing:1px">' + flight.origin + '</div>';
          html += '<div style="font-size:.78em;color:var(--text);margin-top:2px">' + (flight.depTime || '') + '</div>';
          if (flight.depTimeUtc) html += '<div style="font-size:.68em;color:var(--muted)">' + flight.depTimeUtc + '</div>';
          html += '<div style="margin-top:3px"><button onclick="_rgFetchWxBoth(\'' + flight.origin + '\',\'' + flight.dest + '\',\'' + wxId + '\')" style="background:none;border:none;color:#22c55e;font-size:.7em;font-weight:600;cursor:pointer;padding:0">WX</button></div>';
          html += '</div>';
          html += '<div style="text-align:center;padding:0 8px">';
          html += '<div style="font-size:.72em;color:var(--muted);margin-bottom:2px">' + (flight.workCode || 'OPR') + '</div>';
          html += '<div style="font-size:1.5em;opacity:.4">✈</div>';
          if (flight.flightTime) html += '<div style="font-size:.7em;color:var(--muted);margin-top:2px">FT ' + flight.flightTime + '</div>';
          html += '</div>';
          html += '<div style="text-align:center;flex:1">';
          html += '<div style="font-size:2em;font-weight:700;color:var(--text);letter-spacing:1px">' + flight.dest + '</div>';
          html += '<div style="font-size:.78em;color:var(--text);margin-top:2px">' + (flight.arrTime || '') + '</div>';
          if (flight.arrTimeUtc) html += '<div style="font-size:.68em;color:var(--muted)">' + flight.arrTimeUtc + '</div>';
          html += '<div style="margin-top:3px"><button onclick="_rgFetchWxBoth(\'' + flight.origin + '\',\'' + flight.dest + '\',\'' + wxId + '\')" style="background:none;border:none;color:#22c55e;font-size:.7em;font-weight:600;cursor:pointer;padding:0">WX</button></div>';
          html += '</div>';
          html += '</div>';
        }

        // WX panel (hidden, shown when WX clicked)
        html += '<div id="' + wxId + '" style="display:none"></div>';

        // Report / End
        html += '<div style="border-top:1px solid var(--dim);padding:8px 20px;font-size:.78em;color:var(--muted)">';
        html += '<div style="display:flex;justify-content:space-between;margin-bottom:2px"><span>Report</span><span style="color:var(--text)">' + (duty.reportTime || '—') + '</span></div>';
        html += '<div style="display:flex;justify-content:space-between"><span>End</span><span style="color:var(--text)">' + (duty.endTime || '—') + '</span></div>';
        html += '</div>';

        html += '</div>';
      }
    } else if (duty.flights && duty.flights.length > 0) {
      // Training / non-flight duty with sub-items (PT/PC etc.)
      for (var f = 0; f < duty.flights.length; f++) {
        var tf = duty.flights[f];
        var tfColor = _rgGetDutyColor(tf.workCode || tf.flightNo || duty.duty);
        html += '<div style="background:var(--card);border-radius:12px;margin-bottom:12px;border:1px solid var(--border);overflow:hidden">';
        html += '<div style="background:' + tfColor + ';color:#fff;padding:10px;text-align:center;font-weight:700;font-size:1.05em">' + (tf.workCode || tf.flightNo || duty.duty) + '</div>';
        if (tf.position) {
          html += '<div style="padding:6px 20px 0;font-size:.75em"><span style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-weight:600;color:var(--accent)">' + tf.position + '</span></div>';
        }
        html += '<div style="padding:8px 20px;font-size:.78em;color:var(--muted)">';
        if (tf.date) html += '<div style="display:flex;justify-content:space-between;margin-bottom:2px"><span>Date</span><span style="color:var(--text)">' + tf.date + '</span></div>';
        html += '<div style="display:flex;justify-content:space-between;margin-bottom:2px"><span>Start</span><span style="color:var(--text)">' + (tf.depTime || '—') + '</span></div>';
        html += '<div style="display:flex;justify-content:space-between"><span>End</span><span style="color:var(--text)">' + (tf.arrTime || '—') + '</span></div>';
        html += '</div>';
        html += '</div>';
      }
    } else {
      // Non-flight duty without sub-items
      var bgColor = _rgGetDutyColor(duty.duty);
      html += '<div style="background:var(--card);border-radius:12px;margin-bottom:12px;border:1px solid var(--border);overflow:hidden">';
      html += '<div style="background:' + bgColor + ';color:#fff;padding:10px;text-align:center;font-weight:700;font-size:1.05em">' + duty.duty + '</div>';
      html += '<div style="padding:8px 20px;font-size:.78em;color:var(--muted)">';
      html += '<div style="display:flex;justify-content:space-between;margin-bottom:2px"><span>Report</span><span style="color:var(--text)">' + (duty.reportTime || '—') + '</span></div>';
      html += '<div style="display:flex;justify-content:space-between"><span>End</span><span style="color:var(--text)">' + (duty.endTime || '—') + '</span></div>';
      html += '</div>';
      html += '</div>';
    }
  }

  container.innerHTML = html;
}

// ── Crew tab (collapsible per flight) ────────────────────────────────────
function _rgRenderCrewTab() {
  var container = document.getElementById('rg-tab-content');
  if (!container) return;
  var html = '';
  var idx = 0;

  for (var d = 0; d < _rgDetailDuties.length; d++) {
    var duty = _rgDetailDuties[d];
    var flights = duty.flights || [];

    for (var f = 0; f < flights.length; f++) {
      var flight = flights[f];
      if (!flight.crew || flight.crew.length === 0) continue;

      var headerId = 'rg-crew-hdr-' + idx;
      var bodyId = 'rg-crew-body-' + idx;
      var label = flight.flightNo || duty.duty;
      if (flight.flightLabel) label = flight.flightLabel;

      // Collapsible header (same style as pairing)
      var hdrColor = _rgGetDutyColor(duty.duty);
      html += '<div id="' + headerId + '" onclick="_rgToggleCrew(\'' + bodyId + '\',\'' + headerId + '\')" style="background:' + hdrColor + ';border-radius:8px;padding:10px 16px;margin-bottom:2px;cursor:pointer;display:flex;justify-content:space-between;align-items:center">';
      html += '<span style="font-weight:700;font-size:.92em;color:#fff">👥 ' + label + ' <span style="font-size:.8em;opacity:.8">(' + flight.crew.length + ')</span></span>';
      html += '<span class="rg-crew-arrow" style="color:#fff;font-size:.8em;transition:transform .2s;opacity:.7">▶</span>';
      html += '</div>';

      // Collapsible body (hidden by default)
      html += '<div id="' + bodyId + '" style="display:none;padding:4px 0;margin-bottom:10px">';
      for (var c = 0; c < flight.crew.length; c++) {
        var crew = flight.crew[c];
        var pic = '';
        if (_rgData.pictures && _rgData.pictures[crew.staffId]) {
          pic = '<img src="' + _rgData.pictures[crew.staffId].picture + '" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--dim)">';
        } else {
          pic = '<div style="width:36px;height:36px;border-radius:50%;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:.8em;color:var(--muted);border:2px solid var(--dim)">👤</div>';
        }
        var rankColor = crew.rank === 'CAP' ? '#f59e0b' : (crew.rank === 'PR' || crew.rank === 'SC') ? '#10b981' : 'var(--muted)';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--dim)">';
        html += pic;
        html += '<div style="flex:1">';
        html += '<div style="font-size:.85em;font-weight:600;color:var(--text)">' + crew.name + '</div>';
        html += '<div style="font-size:.72em;color:' + rankColor + '">' + crew.position + ' | ' + crew.rank + ' | ' + crew.staffId + '</div>';
        html += '</div>';
        html += '</div>';
      }
      html += '</div>';
      idx++;
    }
  }

  if (!html) html = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:.85em">此班次無組員資料<br>No crew data available</div>';
  container.innerHTML = html;
}

function _rgToggleCrew(bodyId, headerId) {
  var body = document.getElementById(bodyId);
  var header = document.getElementById(headerId);
  if (!body) return;
  var isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  var arrow = header ? header.querySelector('.rg-crew-arrow') : null;
  if (arrow) arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
}

// ── METAR/TAF fetch ──────────────────────────────────────────────────────
var _rgIataToIcao = {TPE:'RCTP',BKK:'VTBS',NRT:'RJAA',KIX:'RJBB',LAX:'KLAX',SFO:'KSFO',PHX:'KPHX',ONT:'KONT',SEA:'KSEA',SGN:'VVTS',HND:'RJTT',ICN:'RKSI',PVG:'ZSPD',HKG:'VHHH',SIN:'WSSS',KUL:'WMKK',MNL:'RPLL',CTS:'RJCC',FUK:'RJFF',OKA:'ROAH',PNH:'VDPP',DPS:'WADD',CGK:'WIII',MLE:'VRMM',BOM:'VABB',DEL:'VIDP',CCU:'VECC',DAC:'VGZR',RUH:'OERK',GLA:'EGPF',FRA:'EDDF',CDG:'LFPG',AMS:'EHAM',LHR:'EGLL',MAD:'LEMD',BCN:'LEBL',NAP:'LIRN'};

function _rgFetchWxOne(icao) {
  return fetch('/api/metar?ids=' + icao + '&hours=1')
    .then(function(r) { return r.ok ? r.text() : ''; })
    .then(function(metarText) {
      var lines = metarText.trim().split('\n').filter(function(l) { return l.trim() && !l.startsWith('No'); });
      return fetch('/api/taf?ids=' + icao).then(function(r) { return r.ok ? r.text() : ''; }).then(function(tafText) {
        return { metar: lines.length > 0 ? lines[0].trim() : '', taf: (tafText && tafText.trim() && !tafText.startsWith('No')) ? tafText.trim() : '' };
      });
    })
    .catch(function() { return { metar: '', taf: '' }; });
}

// 跑道圖收合（比照 Pilot Log flight detail 的 WX 跑道圖，狀態記 localStorage）。
function _rgRwyMapCollapsed() {
  try { return localStorage.getItem('crewsync_rg_rwymap_collapsed') === '1'; } catch (e) { return false; }
}
function _rgToggleRwyMap() {
  var c = !_rgRwyMapCollapsed();
  try { localStorage.setItem('crewsync_rg_rwymap_collapsed', c ? '1' : '0'); } catch (e) {}
  var maps = document.querySelectorAll('.rg-wxmap'), btns = document.querySelectorAll('.rg-wxmap-btn');
  for (var i = 0; i < maps.length; i++) maps[i].style.display = c ? 'none' : '';
  for (var j = 0; j < btns.length; j++) btns[j].textContent = '🗺️ 跑道圖 ' + (c ? '▸' : '▾');
}
function _rgRwyMapBlock(icao) {
  if (typeof RwyMap === 'undefined' || !icao) return '';
  var h = RwyMap.html(icao);
  if (!h) return '';
  var c = _rgRwyMapCollapsed();
  return '<button type="button" class="rg-wxmap-btn" onclick="_rgToggleRwyMap()" style="background:none;border:none;color:#60a5fa;font-size:1em;font-weight:700;cursor:pointer;padding:2px 0">🗺️ 跑道圖 ' + (c ? '▸' : '▾') + '</button>' +
    '<div class="rg-wxmap" style="display:' + (c ? 'none' : '') + '">' + h + '</div>';
}
// WX 欄＝機場碼 + 可收合跑道圖（風向綠橘 + 風分量）+ METAR + TAF。
function _rgWxCol(iata, icao, wx) {
  var h = '<div style="flex:1 1 240px;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;text-align:left;word-break:break-word">';
  h += '<div style="font-weight:700;font-size:1.05em;color:var(--text);margin-bottom:6px">' + iata + '</div>';
  h += _rgRwyMapBlock(icao);
  if (wx.metar) h += '<div style="font-weight:700;color:#22c55e;margin-bottom:2px">METAR</div><div style="line-height:1.4;margin-bottom:6px">' + wx.metar + '</div>';
  if (wx.taf) h += '<div style="font-weight:700;color:#22c55e;margin-bottom:2px">TAF</div><div style="line-height:1.4">' + wx.taf.replace(/\n/g, '<br>') + '</div>';
  if (!wx.metar && !wx.taf) h += '<div style="color:var(--muted)">No WX data</div>';
  return h + '</div>';
}
function _rgFetchWxBoth(originIata, destIata, wxId) {
  var panel = document.getElementById(wxId);
  if (!panel) return;
  // Toggle
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }

  // 機場碼→ICAO：優先用全球機場庫（RwyMap）查真 ICAO，否則退回小表 / 原碼。
  var hasRM = typeof RwyMap !== 'undefined';
  var infoO = hasRM ? RwyMap.aptInfo(originIata) : null, infoD = hasRM ? RwyMap.aptInfo(destIata) : null;
  var keyO = infoO ? infoO.icao : (_rgIataToIcao[originIata.toUpperCase()] || originIata.toUpperCase());
  var keyD = infoD ? infoD.icao : (_rgIataToIcao[destIata.toUpperCase()] || destIata.toUpperCase());

  panel.style.display = 'block';
  panel.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px;border-top:1px solid var(--dim);font-size:.78em;color:var(--text)';
  panel.innerHTML = '<div style="flex:1;text-align:center;color:var(--muted)">載入中...</div>';

  Promise.all([_rgFetchWxOne(keyO), _rgFetchWxOne(keyD)]).then(function(results) {
    var origWx = results[0], destWx = results[1];
    if (hasRM) {   // 先存風向 → 跑道圖 render 時直接上綠橘色 + 風分量
      RwyMap.setWind(keyO, RwyMap.parseWind(origWx.metar));
      RwyMap.setWind(keyD, RwyMap.parseWind(destWx.metar));
    }
    panel.innerHTML = _rgWxCol(originIata, keyO, origWx) + _rgWxCol(destIata, keyD, destWx);
  });
}

// Auto-init when roster tab is shown
var _rgInited = false;
