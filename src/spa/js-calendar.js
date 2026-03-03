// ── Google Calendar UI ────────────────────────────────────────────────────────
var gcalYear, gcalMonth, gcalSelDay;
var gcalView = 'month'; // 'day', 'week', 'month', 'year'
var gcalAllEvents = [];
var gcalLoadedMonths = {};
var GCAL_MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];
var GCAL_MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var GCAL_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var GCAL_COLORS = {
  '1':'#7986cb','2':'#33b679','3':'#8e24aa','4':'#e67c73',
  '5':'#f6bf26','6':'#f4511e','7':'#039be5','8':'#616161',
  '9':'#3f51b5','10':'#0b8043','11':'#d50000'
};
var GCAL_HOUR_H = 48; // px per hour in week view
var GCAL_LUNAR_DAYS = ['','初一','初二','初三','初四','初五','初六','初七','初八','初九','初十',
  '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
  '廿一','廿二','廿三','廿四','廿五','廿六','廿七','廿八','廿九','三十'];
var GCAL_LUNAR_MONTHS = ['正月','二月','三月','四月','五月','六月',
  '七月','八月','九月','十月','冬月','臘月'];

function _gcalLunarLabel(date) {
  try {
    var parts = new Intl.DateTimeFormat('zh-TW-u-ca-chinese', { month: 'numeric', day: 'numeric' })
      .formatToParts(date);
    var day = 0, month = 0;
    parts.forEach(function(p) {
      if (p.type === 'day') day = parseInt(p.value);
      if (p.type === 'month') month = parseInt(p.value);
    });
    if (day === 1) return GCAL_LUNAR_MONTHS[month - 1] || (month + '月');
    return GCAL_LUNAR_DAYS[day] || '';
  } catch (e) { return ''; }
}

function _gcalFmt(y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function _gcalFmtD(dt) { return _gcalFmt(dt.getFullYear(), dt.getMonth(), dt.getDate()); }

// ── Init & view switching ──

function gcalInit() {
  var now = new Date();
  gcalYear = now.getFullYear();
  gcalMonth = now.getMonth();
  gcalSelDay = now.getDate();
  gcalAllEvents = [];
  gcalLoadedMonths = {};
  gcalView = 'month';
  document.querySelectorAll('.gcal-view-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.view === 'month');
  });
  var vsel = document.getElementById('gcal-view-select');
  if (vsel) vsel.value = 'month';
  gcalRender();
  gcalFetchEvents();
}

function gcalSetView(view) {
  if (view === gcalView) return;
  gcalView = view;
  document.querySelectorAll('.gcal-view-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  var vsel = document.getElementById('gcal-view-select');
  if (vsel) vsel.value = view;
  if (!gcalSelDay) {
    var now = new Date();
    if (gcalYear === now.getFullYear() && gcalMonth === now.getMonth()) {
      gcalSelDay = now.getDate();
    } else {
      gcalSelDay = 1;
    }
  }
  gcalRender();
  gcalFetchEvents();
}

// ── Navigation ──

function gcalPrev() {
  if (gcalView === 'week') {
    var d = new Date(gcalYear, gcalMonth, (gcalSelDay || 1) - 7);
    gcalYear = d.getFullYear(); gcalMonth = d.getMonth(); gcalSelDay = d.getDate();
  } else {
    gcalMonth--;
    if (gcalMonth < 0) { gcalMonth = 11; gcalYear--; }
    gcalSelDay = 0;
  }
  gcalRender();
  gcalFetchEvents();
}

function gcalNext() {
  if (gcalView === 'week') {
    var d = new Date(gcalYear, gcalMonth, (gcalSelDay || 1) + 7);
    gcalYear = d.getFullYear(); gcalMonth = d.getMonth(); gcalSelDay = d.getDate();
  } else {
    gcalMonth++;
    if (gcalMonth > 11) { gcalMonth = 0; gcalYear++; }
    gcalSelDay = 0;
  }
  gcalRender();
  gcalFetchEvents();
}

function gcalToday() {
  var now = new Date();
  gcalYear = now.getFullYear();
  gcalMonth = now.getMonth();
  gcalSelDay = now.getDate();
  gcalRender();
  gcalFetchEvents();
}

// ── Data fetching ──

function gcalFetchEvents() {
  if (gcalView === 'week') {
    var sel = new Date(gcalYear, gcalMonth, gcalSelDay || 1);
    var sun = new Date(sel); sun.setDate(sun.getDate() - sun.getDay());
    var sat = new Date(sun); sat.setDate(sat.getDate() + 6);
    _gcalFetchMonth(sun.getFullYear(), sun.getMonth());
    if (sat.getMonth() !== sun.getMonth() || sat.getFullYear() !== sun.getFullYear()) {
      _gcalFetchMonth(sat.getFullYear(), sat.getMonth());
    }
  } else {
    _gcalFetchMonth(gcalYear, gcalMonth);
  }
}

function _gcalFetchMonth(year, month) {
  var key = year + '-' + String(month + 1).padStart(2, '0');
  if (gcalLoadedMonths[key]) return;
  gcalLoadedMonths[key] = true; // Mark immediately to prevent duplicate fetches
  var rt = localStorage.getItem('crewsync_rt');
  if (!rt) return;

  var start = year + '-' + String(month + 1).padStart(2, '0') + '-01';
  var endMonth = month + 2, endYear = year;
  if (endMonth > 12) { endMonth = 1; endYear++; }
  var end = endYear + '-' + String(endMonth).padStart(2, '0') + '-01';

  fetch('/api/calendar-events?refreshToken=' + encodeURIComponent(rt) +
    '&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end))
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { console.error('Calendar API:', data.error); gcalLoadedMonths[key] = false; return; }

    (data.events || []).forEach(function(ev) {
      // Deduplicate: skip if already loaded (cross-month events appear in both months)
      if (ev.id && gcalAllEvents.some(function(e) { return e.id === ev.id; })) return;

      var color = ev.color ? (GCAL_COLORS[ev.color] || '#039be5') : '#039be5';
      var startKey, endKey, startTime = '', endTime = '', rawStart = ev.start, rawEnd = ev.end;

      if (ev.allDay) {
        startKey = ev.start;
        var ed = new Date(ev.end + 'T00:00:00');
        ed.setDate(ed.getDate() - 1);
        endKey = _gcalFmtD(ed);
      } else {
        var sdt = new Date(ev.start);
        var edt = new Date(ev.end);
        startKey = _gcalFmtD(sdt);
        var lastDay = new Date(edt.getFullYear(), edt.getMonth(), edt.getDate());
        if (edt.getHours() === 0 && edt.getMinutes() === 0) lastDay.setDate(lastDay.getDate() - 1);
        endKey = _gcalFmtD(lastDay < sdt ? sdt : lastDay);
        startTime = String(sdt.getHours()).padStart(2, '0') + ':' + String(sdt.getMinutes()).padStart(2, '0');
        endTime = String(edt.getHours()).padStart(2, '0') + ':' + String(edt.getMinutes()).padStart(2, '0');
      }

      gcalAllEvents.push({
        id: ev.id,
        title: ev.title, startKey: startKey, endKey: endKey,
        startTime: startTime, endTime: endTime,
        allDay: ev.allDay, color: color, rawStart: rawStart, rawEnd: rawEnd,
        location: ev.location || '', description: ev.description || '',
        reminders: ev.reminders || []
      });
    });
    gcalRender();
  }).catch(function(e) { console.error('Calendar fetch error:', e); gcalLoadedMonths[key] = false; });
}

// ── Render dispatcher ──

function gcalRender() {
  if (gcalView === 'week') {
    gcalRenderWeek();
  } else if (gcalView === 'schedule') {
    gcalRenderSchedule();
  } else {
    gcalRenderMonth();
  }
}

// ── Month view ──

function gcalRenderMonth() {
  var evPanel = document.getElementById('gcal-events');
  if (evPanel) evPanel.style.display = '';
  var wkEl = document.getElementById('gcal-weekdays');
  if (wkEl) {
    wkEl.style.display = '';
    wkEl.style.gridTemplateColumns = '';
    wkEl.innerHTML = GCAL_DAYS.map(function(d) {
      return '<div class="gcal-wk-cell">' + d + '</div>';
    }).join('');
  }

  var titleEl = document.getElementById('gcal-title');
  if (titleEl) titleEl.textContent = GCAL_MONTHS_SHORT[gcalMonth] + ' ' + gcalYear;

  var grid = document.getElementById('gcal-grid');
  if (!grid) return;

  var todayKey = _gcalFmtD(new Date());

  var firstDay = new Date(gcalYear, gcalMonth, 1).getDay();
  var daysInMonth = new Date(gcalYear, gcalMonth + 1, 0).getDate();
  var daysInPrev = new Date(gcalYear, gcalMonth, 0).getDate();
  var prevM = gcalMonth === 0 ? 11 : gcalMonth - 1;
  var prevY = gcalMonth === 0 ? gcalYear - 1 : gcalYear;
  var nextM = gcalMonth === 11 ? 0 : gcalMonth + 1;
  var nextY = gcalMonth === 11 ? gcalYear + 1 : gcalYear;

  var allDates = [];
  for (var p = firstDay - 1; p >= 0; p--)
    allDates.push({ key: _gcalFmt(prevY, prevM, daysInPrev - p), d: daysInPrev - p, other: true });
  for (var d = 1; d <= daysInMonth; d++)
    allDates.push({ key: _gcalFmt(gcalYear, gcalMonth, d), d: d, other: false });
  var remain = 7 - (allDates.length % 7);
  if (remain < 7) for (var n = 1; n <= remain; n++)
    allDates.push({ key: _gcalFmt(nextY, nextM, n), d: n, other: true });

  var weeks = [];
  for (var w = 0; w < allDates.length; w += 7) weeks.push(allDates.slice(w, w + 7));

  var html = '';
  weeks.forEach(function(week) {
    var wkStart = week[0].key, wkEnd = week[6].key;

    var spanEvs = [];
    var dotEvs = {};
    gcalAllEvents.forEach(function(ev, idx) {
      var isBar = ev.allDay || ev.startKey !== ev.endKey;
      if (isBar) {
        if (ev.endKey >= wkStart && ev.startKey <= wkEnd) {
          var cs = 0, ce = 6;
          for (var c = 0; c < 7; c++) { if (week[c].key >= ev.startKey) { cs = c; break; } }
          for (var c = 6; c >= 0; c--) { if (week[c].key <= ev.endKey) { ce = c; break; } }
          spanEvs.push({ ev: ev, cs: cs, ce: ce, idx: idx });
        }
      } else {
        if (ev.startKey >= wkStart && ev.startKey <= wkEnd) {
          if (!dotEvs[ev.startKey]) dotEvs[ev.startKey] = [];
          dotEvs[ev.startKey].push({ ev: ev, idx: idx });
        }
      }
    });

    var slots = [];
    spanEvs.forEach(function(se) {
      for (var s = 0; ; s++) {
        if (!slots[s]) slots[s] = [];
        var ok = true;
        for (var i = 0; i < slots[s].length; i++) {
          if (se.cs <= slots[s][i].ce && se.ce >= slots[s][i].cs) { ok = false; break; }
        }
        if (ok) { slots[s].push(se); se.slot = s; break; }
      }
    });

    var numSlots = slots.length;
    var rows = 'auto repeat(' + numSlots + ',auto) 1fr';
    html += '<div class="gcal-week-row" style="grid-template-rows:' + rows + '">';

    week.forEach(function(day, di) {
      var cls = 'gcal-day-num';
      if (day.other) cls += ' gcal-day-other';
      if (day.key === todayKey) cls += ' gcal-day-today';
      if (!day.other && day.d === gcalSelDay) cls += ' gcal-day-sel';
      var oc = day.other ? '' : ' onclick="gcalSelectDay(' + day.d + ')"';
      html += '<div class="' + cls + '" style="grid-column:' + (di + 1) + ';grid-row:1"' + oc + '>' +
        '<span class="gcal-num">' + day.d + '</span></div>';
    });

    spanEvs.forEach(function(se) {
      var r = se.slot + 2;
      var label = se.ev.allDay ? se.ev.title : (se.ev.startTime + ' ' + se.ev.title);
      var cL = se.ev.startKey < wkStart, cR = se.ev.endKey > wkEnd;
      var rad = '4px';
      if (cL && cR) rad = '0';
      else if (cL) rad = '0 4px 4px 0';
      else if (cR) rad = '4px 0 0 4px';
      html += '<div class="gcal-span-bar" onclick="gcalClickEvent(' + se.idx + ',event)" style="grid-column:' + (se.cs + 1) + '/' + (se.ce + 2) +
        ';grid-row:' + r + ';background:' + se.ev.color + ';border-radius:' + rad + '">' +
        '<span class="gcal-span-txt">' + label + '</span></div>';
    });

    var barsPerDay = [0,0,0,0,0,0,0];
    spanEvs.forEach(function(se) {
      for (var c = se.cs; c <= se.ce; c++) barsPerDay[c]++;
    });

    var evRow = numSlots + 2;
    week.forEach(function(day, di) {
      var evs = dotEvs[day.key] || [];
      var maxDots = Math.max(0, 2 - barsPerDay[di]);
      var c = '';
      for (var ei = 0; ei < Math.min(evs.length, maxDots); ei++) {
        var se = evs[ei];
        c += '<div class="gcal-dot-ev" onclick="gcalClickEvent(' + se.idx + ',event)" style="display:flex;align-items:center;gap:3px;overflow:hidden;white-space:nowrap">' +
          '<span style="width:6px;height:6px;border-radius:50%;flex-shrink:0;background:' + se.ev.color + '"></span>' +
          '<span style="font-size:.6em;overflow:hidden;text-overflow:ellipsis;color:var(--text)">' + se.ev.startTime + ' ' + se.ev.title + '</span></div>';
      }
      var remaining = evs.length - Math.min(evs.length, maxDots);
      if (remaining > 0) c += '<div class="gcal-cell-more" onclick="gcalShowDayEvents(\'' + day.key + '\',event)">' +
        '<span class="gcal-more-dots">...</span><span class="gcal-more-num">+' + remaining + ' more</span></div>';
      html += '<div class="gcal-day-evs" style="grid-column:' + (di + 1) + ';grid-row:' + evRow + '">' + c + '</div>';
    });

    html += '</div>';
  });

  grid.innerHTML = html;
  gcalRenderEvents();
}

// ── Week view ──

function _gcalWeekDays() {
  var sel = new Date(gcalYear, gcalMonth, gcalSelDay || 1);
  var sun = new Date(sel); sun.setDate(sun.getDate() - sun.getDay());
  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(sun); d.setDate(d.getDate() + i);
    days.push({ date: d, key: _gcalFmtD(d), day: d.getDate(), mon: d.getMonth(), yr: d.getFullYear() });
  }
  return days;
}

function gcalRenderWeek() {
  var evPanel = document.getElementById('gcal-events');
  if (evPanel) evPanel.style.display = '';
  var days = _gcalWeekDays();
  var todayKey = _gcalFmtD(new Date());
  var wkStart = days[0].key, wkEnd = days[6].key;

  // Title
  var titleEl = document.getElementById('gcal-title');
  if (titleEl) {
    var s = days[0], e = days[6];
    if (s.mon === e.mon) {
      titleEl.textContent = GCAL_MONTHS_SHORT[s.mon] + ' ' + s.day + ' – ' + e.day + ', ' + s.yr;
    } else {
      titleEl.textContent = GCAL_MONTHS_SHORT[s.mon] + ' ' + s.day + ' – ' + GCAL_MONTHS_SHORT[e.mon] + ' ' + e.day + ', ' + e.yr;
    }
  }

  // Weekday header with dates
  var wkEl = document.getElementById('gcal-weekdays');
  if (wkEl) {
    wkEl.style.display = '';
    wkEl.style.gridTemplateColumns = '36px repeat(7,minmax(0,1fr))';
    var wkHtml = '<div class="gcal-wk-cell" style="font-size:.55em;color:var(--dim)"></div>';
    days.forEach(function(day) {
      var isSel = (day.yr === gcalYear && day.mon === gcalMonth && day.day === gcalSelDay);
      var lunar = _gcalLunarLabel(day.date);
      wkHtml += '<div class="gcal-wk-cell gcal-wk-hd" onclick="gcalWeekSelDay(' + day.yr + ',' + day.mon + ',' + day.day + ')">' +
        '<span class="gcal-wk-hd-name">' + GCAL_DAYS[day.date.getDay()] + '</span>' +
        '<span class="gcal-wk-hd-num' + (day.key === todayKey ? ' gcal-wk-today' : '') + (isSel ? ' gcal-wk-sel' : '') + '">' + day.day + '</span>' +
        '<span class="gcal-wk-hd-lunar">' + lunar + '</span>' +
        '</div>';
    });
    wkEl.innerHTML = wkHtml;
  }

  var grid = document.getElementById('gcal-grid');
  if (!grid) return;

  // Classify events
  var barEvs = [], timedEvs = {};
  gcalAllEvents.forEach(function(ev, idx) {
    var isBar = ev.allDay || ev.startKey !== ev.endKey;
    if (isBar) {
      if (ev.endKey >= wkStart && ev.startKey <= wkEnd) {
        var cs = 0, ce = 6;
        for (var c = 0; c < 7; c++) { if (days[c].key >= ev.startKey) { cs = c; break; } }
        for (var c = 6; c >= 0; c--) { if (days[c].key <= ev.endKey) { ce = c; break; } }
        barEvs.push({ ev: ev, cs: cs, ce: ce, idx: idx });
      }
    } else {
      if (ev.startKey >= wkStart && ev.startKey <= wkEnd) {
        if (!timedEvs[ev.startKey]) timedEvs[ev.startKey] = [];
        timedEvs[ev.startKey].push({ ev: ev, idx: idx });
      }
    }
  });

  // Stack bar events
  var slots = [];
  barEvs.forEach(function(se) {
    for (var s = 0; ; s++) {
      if (!slots[s]) slots[s] = [];
      var ok = true;
      for (var i = 0; i < slots[s].length; i++) {
        if (se.cs <= slots[s][i].ce && se.ce >= slots[s][i].cs) { ok = false; break; }
      }
      if (ok) { slots[s].push(se); se.slot = s; break; }
    }
  });

  var html = '';

  // All-day section
  if (barEvs.length > 0) {
    var numSlots = slots.length;
    html += '<div class="gcal-wk-allday">';
    html += '<div class="gcal-wk-alabel">All day</div>';
    html += '<div class="gcal-wk-allday-grid" style="grid-template-rows:repeat(' + numSlots + ',auto)">';
    barEvs.forEach(function(se) {
      var r = se.slot + 1;
      var label = se.ev.allDay ? se.ev.title : (se.ev.startTime + ' ' + se.ev.title);
      var cL = se.ev.startKey < wkStart, cR = se.ev.endKey > wkEnd;
      var rad = '4px';
      if (cL && cR) rad = '0';
      else if (cL) rad = '0 4px 4px 0';
      else if (cR) rad = '4px 0 0 4px';
      html += '<div class="gcal-span-bar" onclick="gcalClickEvent(' + se.idx + ',event)" style="grid-column:' + (se.cs + 1) + '/' + (se.ce + 2) +
        ';grid-row:' + r + ';background:' + se.ev.color + ';border-radius:' + rad + '">' +
        '<span class="gcal-span-txt">' + label + '</span></div>';
    });
    html += '</div></div>';
  }

  // Scrollable time grid
  html += '<div class="gcal-wk-scroll">';
  html += '<div class="gcal-wk-tg" style="min-height:' + (24 * GCAL_HOUR_H) + 'px">';

  // Hour labels
  html += '<div class="gcal-wk-hours">';
  for (var h = 0; h < 24; h++) {
    html += '<div class="gcal-wk-hlabel" style="top:' + (h * GCAL_HOUR_H) + 'px">' +
      String(h).padStart(2, '0') + ':00</div>';
  }
  html += '</div>';

  // Day columns
  html += '<div class="gcal-wk-cols" style="background-size:100% ' + GCAL_HOUR_H + 'px">';
  for (var di = 0; di < 7; di++) {
    var day = days[di];
    var colCls = 'gcal-wk-col';
    if (day.key === todayKey) colCls += ' gcal-wk-col-today';
    html += '<div class="' + colCls + '">';

    // Timed events
    var evs = timedEvs[day.key] || [];
    evs.forEach(function(se) {
      var sdt = new Date(se.ev.rawStart);
      var edt = new Date(se.ev.rawEnd);
      var startMin = sdt.getHours() * 60 + sdt.getMinutes();
      var endMin = (_gcalFmtD(edt) > day.key) ? 24 * 60 : (edt.getHours() * 60 + edt.getMinutes());
      var duration = Math.max(endMin - startMin, 20);

      var topPx = startMin / 60 * GCAL_HOUR_H;
      var heightPx = Math.max(duration / 60 * GCAL_HOUR_H, 18);

      html += '<div class="gcal-wk-ev" onclick="gcalClickEvent(' + se.idx + ',event)" style="top:' + topPx + 'px;height:' + heightPx + 'px;background:' + se.ev.color + '">' +
        '<div class="gcal-wk-ev-title">' + se.ev.title + '</div>' +
        (heightPx > 26 ? '<div class="gcal-wk-ev-time">' + se.ev.startTime + '–' + se.ev.endTime + '</div>' : '') +
        '</div>';
    });

    html += '</div>';
  }
  html += '</div>';

  // Current time indicator
  var now = new Date();
  var nowKey = _gcalFmtD(now);
  if (nowKey >= wkStart && nowKey <= wkEnd) {
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var nowTop = nowMin / 60 * GCAL_HOUR_H;
    var nowCol = -1;
    for (var i = 0; i < 7; i++) { if (days[i].key === nowKey) { nowCol = i; break; } }
    if (nowCol >= 0) {
      html += '<div class="gcal-wk-now" style="top:' + nowTop + 'px"></div>';
    }
  }

  html += '</div></div>';

  grid.innerHTML = html;

  // Auto-scroll to 6am (or current time - 1hr if today)
  var scrollEl = grid.querySelector('.gcal-wk-scroll');
  if (scrollEl) {
    var scrollTo = 6 * GCAL_HOUR_H;
    if (nowKey >= wkStart && nowKey <= wkEnd) {
      var curMin = now.getHours() * 60 + now.getMinutes();
      scrollTo = Math.max(0, (curMin - 60) / 60 * GCAL_HOUR_H);
    }
    scrollEl.scrollTop = scrollTo;
  }

  gcalRenderEvents();
}

function gcalWeekSelDay(yr, mon, day) {
  gcalYear = yr; gcalMonth = mon; gcalSelDay = day;
  gcalRender();
}

// ── Schedule view ──

function gcalRenderSchedule() {
  // Hide weekday header
  var wkEl = document.getElementById('gcal-weekdays');
  if (wkEl) wkEl.style.display = 'none';

  // Title
  var titleEl = document.getElementById('gcal-title');
  if (titleEl) titleEl.textContent = GCAL_MONTHS_SHORT[gcalMonth] + ' ' + gcalYear;

  var grid = document.getElementById('gcal-grid');
  if (!grid) return;

  // Hide events panel (info is inline in schedule view)
  var evEl = document.getElementById('gcal-events');
  if (evEl) evEl.style.display = 'none';

  var todayKey = _gcalFmtD(new Date());
  var daysInMonth = new Date(gcalYear, gcalMonth + 1, 0).getDate();
  var html = '<div class="gcal-sch-list">';
  var hasEvents = false;

  for (var d = 1; d <= daysInMonth; d++) {
    var dayKey = _gcalFmt(gcalYear, gcalMonth, d);
    var dayEvs = [];
    gcalAllEvents.forEach(function(ev, idx) {
      if (dayKey >= ev.startKey && dayKey <= ev.endKey) {
        dayEvs.push({ ev: ev, idx: idx });
      }
    });

    if (dayEvs.length === 0) continue;
    hasEvents = true;

    var dateObj = new Date(gcalYear, gcalMonth, d);
    var isToday = dayKey === todayKey;
    var lunar = _gcalLunarLabel(dateObj);

    html += '<div class="gcal-sch-day' + (isToday ? ' gcal-sch-today' : '') + '"' +
      (isToday ? ' id="gcal-sch-now"' : '') + '>';

    // Date column
    html += '<div class="gcal-sch-date">';
    html += '<span class="gcal-sch-dnum' + (isToday ? ' gcal-sch-dnum-today' : '') + '">' + d + '</span>';
    html += '<div class="gcal-sch-dmeta">';
    html += '<span>' + GCAL_MONTHS_SHORT[gcalMonth] + ', ' + GCAL_DAYS[dateObj.getDay()] + '</span>';
    html += '<span class="gcal-sch-lunar">' + lunar + '</span>';
    html += '</div></div>';

    // Events column
    html += '<div class="gcal-sch-events">';
    dayEvs.forEach(function(se) {
      var ev = se.ev;
      var timeStr;
      if (ev.allDay) {
        timeStr = 'All day';
      } else {
        timeStr = ev.startTime + ' – ' + ev.endTime;
      }
      html += '<div class="gcal-sch-ev" onclick="gcalClickEvent(' + se.idx + ',event)">';
      html += '<span class="gcal-sch-dot" style="background:' + ev.color + '"></span>';
      html += '<div class="gcal-sch-ev-time">' + timeStr + '</div>';
      html += '<div class="gcal-sch-ev-info">';
      html += '<span class="gcal-sch-ev-title">' + ev.title + '</span>';
      if (ev.location) html += '<span class="gcal-sch-ev-loc">' + ev.location.split(',')[0] + '</span>';
      html += '</div></div>';
    });
    html += '</div></div>';

    // Today red line
    if (isToday) {
      html += '<div class="gcal-sch-nowline"></div>';
    }
  }

  if (!hasEvents) {
    html += '<div class="gcal-ev-empty" style="padding:40px 0">No events this month</div>';
  }

  html += '</div>';
  grid.innerHTML = html;

  // Scroll to today
  var nowEl = document.getElementById('gcal-sch-now');
  if (nowEl) nowEl.scrollIntoView({ block: 'start' });
}

// ── Shared: day selection & event details ──

function gcalSelectDay(day) {
  gcalSelDay = day;
  gcalRender();
}

function gcalShowDayEvents(dayKey, domEvent) {
  if (domEvent) domEvent.stopPropagation();
  var el = document.getElementById('gcal-events');
  if (!el) return;

  var dayEvs = gcalAllEvents.filter(function(ev) {
    return dayKey >= ev.startKey && dayKey <= ev.endKey;
  });

  var parts = dayKey.split('-');
  var dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  var dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
  var header = '<div class="gcal-ev-header">' + GCAL_MONTHS[parseInt(parts[1]) - 1] + ' ' + parseInt(parts[2]) + ', ' + dayName + '</div>';

  if (dayEvs.length === 0) {
    el.innerHTML = header + '<div class="gcal-ev-empty">No events</div>';
    return;
  }

  var html = header;
  dayEvs.forEach(function(ev) { html += _gcalEvDetailHtml(ev); });
  el.innerHTML = html;
}

function _gcalEvTimeStr(ev) {
  if (ev.allDay) {
    return (ev.startKey !== ev.endKey) ? _gcalDateLabel(ev.startKey) + ' – ' + _gcalDateLabel(ev.endKey) : 'All day';
  }
  return _gcalDateTimeLabel(ev.rawStart) + ' – ' + _gcalDateTimeLabel(ev.rawEnd);
}

function _gcalEvDetailHtml(ev) {
  var h = '<div class="gcal-ev-item">' +
    '<div class="gcal-ev-color" style="background:' + ev.color + '"></div>' +
    '<div class="gcal-ev-body">' +
      '<div class="gcal-ev-title">' + ev.title + '</div>' +
      '<div class="gcal-ev-time">🕐 ' + _gcalEvTimeStr(ev) + '</div>';
  if (ev.location) {
    h += '<div class="gcal-ev-loc">📍 ' + ev.location + '</div>';
  }
  if (ev.reminders && ev.reminders.length) {
    h += '<div class="gcal-ev-remind">🔔 ' + ev.reminders.map(_gcalReminderStr).join(', ') + '</div>';
  }
  if (ev.description) {
    h += '<div class="gcal-ev-desc">' + ev.description.replace(/\n/g, '<br>') + '</div>';
  }
  h += '</div></div>';
  return h;
}

function _gcalReminderStr(mins) {
  if (mins === 0) return 'At time of event';
  if (mins < 60) return mins + ' min before';
  if (mins < 1440) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return h + ' hr' + (m ? ' ' + m + ' min' : '') + ' before';
  }
  var d = Math.floor(mins / 1440);
  var rem = mins % 1440;
  if (rem === 0) return d + ' day' + (d > 1 ? 's' : '') + ' before';
  var rh = Math.floor(rem / 60);
  return d + ' day' + (d > 1 ? 's' : '') + ' ' + rh + ' hr before';
}

function gcalClickEvent(idx, domEvent) {
  if (domEvent) domEvent.stopPropagation();
  var ev = gcalAllEvents[idx];
  if (!ev) return;

  var el = document.getElementById('gcal-events');
  if (!el) return;

  el.innerHTML = '<div class="gcal-ev-header">' + ev.title + '</div>' + _gcalEvDetailHtml(ev);
}

function gcalRenderEvents() {
  var el = document.getElementById('gcal-events');
  if (!el) return;

  if (!gcalSelDay) { el.innerHTML = ''; return; }

  var selKey = _gcalFmt(gcalYear, gcalMonth, gcalSelDay);
  var dayEvs = gcalAllEvents.filter(function(ev) {
    return selKey >= ev.startKey && selKey <= ev.endKey;
  });

  var dateObj = new Date(gcalYear, gcalMonth, gcalSelDay);
  var dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
  var header = '<div class="gcal-ev-header">' + GCAL_MONTHS[gcalMonth] + ' ' + gcalSelDay + ', ' + dayName + '</div>';

  if (dayEvs.length === 0) {
    el.innerHTML = header + '<div class="gcal-ev-empty">No events</div>';
    return;
  }

  var html = header;
  dayEvs.forEach(function(ev) { html += _gcalEvDetailHtml(ev); });
  el.innerHTML = html;
}

function _gcalDateLabel(key) {
  var parts = key.split('-');
  return GCAL_MONTHS[parseInt(parts[1]) - 1] + ' ' + parseInt(parts[2]) + ', ' + parts[0];
}
function _gcalDateTimeLabel(raw) {
  var dt = new Date(raw);
  return GCAL_MONTHS[dt.getMonth()] + ' ' + dt.getDate() + ', ' +
    String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
}
