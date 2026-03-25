// ── Friends 班表總覽 ─────────────────────────────────────────────────────────
var _frYear = new Date().getFullYear();
var _frMonth = new Date().getMonth() + 1;
var _frData = []; // [{ name, nickname, picture, duties }]
var _frInited = false;

function _frInit() {
  var isSharing = localStorage.getItem('crewsync_share_enabled') === '1';
  var shareToggle = document.getElementById('fr-share-toggle');
  if (shareToggle) shareToggle.checked = isSharing;
  _frShowShareUI(isSharing);
  if (isSharing) _frLoadMonth();
  else _frShowEmpty();
}

function _frShowInfo() {
  var overlay = document.getElementById('fr-info-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function _frShowEmpty() {
  var gridEl = document.getElementById('fr-grid');
  if (!gridEl) return;
  gridEl.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted)">' +
    '<div style="font-size:2.5em;margin-bottom:12px">👥</div>' +
    '<div style="font-size:.95em;font-weight:700;color:var(--text);margin-bottom:8px">Friends 班表分享</div>' +
    '<div style="font-size:.78em;line-height:1.6;max-width:380px;margin:0 auto">' +
    '<div style="margin-bottom:12px">同意分享後即可查看其他組員的班表<br><span style="opacity:.6">Share your roster to view others\' schedules</span></div>' +
    '<table style="text-align:left;margin:0 auto;border-spacing:0 6px">' +
    '<tr><td style="vertical-align:top;padding-right:6px">•</td><td>未分享者無法查看他人班表<br><span style="opacity:.6">Non-sharing members cannot view others\' rosters</span></td></tr>' +
    '<tr><td style="vertical-align:top;padding-right:6px">•</td><td>同意分享後即可查看其他組員的班表<br><span style="opacity:.6">Share your roster to view others\' schedules</span></td></tr>' +
    '<tr><td style="vertical-align:top;padding-right:6px">•</td><td>你的班表將上傳至雲端供其他分享者查看<br><span style="opacity:.6">Your roster will be uploaded for shared members to view</span></td></tr>' +
    '<tr><td style="vertical-align:top;padding-right:6px">•</td><td>支援離線查看，連線時自動更新最新資料<br><span style="opacity:.6">Offline viewing supported — data refreshed when online</span></td></tr>' +
    '<tr><td style="vertical-align:top;padding-right:6px">•</td><td>隨時可關閉分享，雲端資料將立即刪除<br><span style="opacity:.6">Turn off anytime — cloud data deleted immediately</span></td></tr>' +
    '<tr><td style="vertical-align:top;padding-right:6px">•</td><td>撤銷分享後，其他使用者的離線快取將於下次連線時更新<br><span style="opacity:.6">After revoking, others\' offline cache will update on next connection</span></td></tr>' +
    '<tr><td style="vertical-align:top;padding-right:6px">•</td><td>離線快取保留一個月，一個月內未連網更新亦會自動刪除<br><span style="opacity:.6">Offline cache expires after 1 month — auto-deleted if not refreshed</span></td></tr>' +
    '</table></div></div>';
}

function _frShowShareUI(show) {
  var fleetSel = document.getElementById('fr-my-fleet');
  var rankSel = document.getElementById('fr-my-rank');
  var hint = document.getElementById('fr-share-hint');
  var nameWrap = document.getElementById('fr-name-wrap');
  var nameInput = document.getElementById('fr-my-name');
  if (fleetSel) { fleetSel.value = localStorage.getItem('crewsync_my_fleet') || ''; fleetSel.style.display = show ? '' : 'none'; }
  if (rankSel) { rankSel.value = localStorage.getItem('crewsync_my_rank') || ''; rankSel.style.display = show ? '' : 'none'; }
  if (hint) hint.style.display = show ? '' : 'none';
  if (nameWrap) nameWrap.style.display = show ? 'inline-flex' : 'none';
  if (nameInput) nameInput.value = localStorage.getItem('crewsync_nickname') || localStorage.getItem('crewsync_crew_name') || localStorage.getItem('crewsync_eid') || '';
}

// 機隊/職級/名稱都選完後才觸發上傳
function _frCheckReady() {
  var fleetSel = document.getElementById('fr-my-fleet');
  var rankSel = document.getElementById('fr-my-rank');
  var nameInput = document.getElementById('fr-my-name');
  var fleet = fleetSel ? fleetSel.value : '';
  var rank = rankSel ? rankSel.value : '';
  var name = nameInput ? nameInput.value.trim() : '';
  if (fleet) localStorage.setItem('crewsync_my_fleet', fleet);
  if (rank) localStorage.setItem('crewsync_my_rank', rank);
  // 名字清空時移除 nickname，fallback 回英文名
  if (name) { localStorage.setItem('crewsync_nickname', name); }
  else { localStorage.removeItem('crewsync_nickname'); }
  // 如果已開啟分享且三個都填了，自動上傳
  if (localStorage.getItem('crewsync_share_enabled') === '1' && fleet && rank) {
    var eid = localStorage.getItem('crewsync_eid');
    if (eid) _frUploadAll(eid, fleet, rank);
  }
}

function _frToggleShare() {
  var toggle = document.getElementById('fr-share-toggle');
  var eid = localStorage.getItem('crewsync_eid');
  var fleetSel = document.getElementById('fr-my-fleet');
  var rankSel = document.getElementById('fr-my-rank');

  if (!eid) { alert('請先同步班表 Please sync your roster first'); toggle.checked = false; return; }

  if (toggle.checked) {
    localStorage.setItem('crewsync_share_enabled', '1');
    _frShowShareUI(true);
    // 如果之前已選過機隊/職級，直接上傳
    var myFleet = localStorage.getItem('crewsync_my_fleet') || '';
    var myRank = localStorage.getItem('crewsync_my_rank') || '';
    if (myFleet && myRank) {
      _frUploadAll(eid, myFleet, myRank);
    }
    // 否則等使用者選完，_frCheckReady 會觸發上傳
  } else {
    _frShowShareUI(false);
    localStorage.removeItem('crewsync_share_enabled');
    fetch('/api/roster-share', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eid: eid })
    }).then(function() { _frShowEmpty(); });
  }
}


function _frUploadAll(eid, fleet, rank) {
  var promises = [];
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.indexOf('crewsync_roster_' + eid + '_') === 0) {
      var monthKey = key.replace('crewsync_roster_' + eid + '_', '');
      try {
        var data = JSON.parse(localStorage.getItem(key));
        if (data && data.duties && data.duties.length > 0) {
          promises.push(fetch('/api/roster-share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eid: eid, month: monthKey, duties: data.duties, crewName: localStorage.getItem('crewsync_crew_name') || eid, nickname: localStorage.getItem('crewsync_nickname') || '', fleet: fleet, rank: rank })
          }));
        }
      } catch(e){}
    }
  }
  if (promises.length > 0) {
    var gridEl = document.getElementById('fr-grid');
    if (gridEl) gridEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">上傳中（' + promises.length + ' 筆）... Uploading...</div>';
    Promise.all(promises).then(function(responses) {
      return Promise.all(responses.map(function(r) { return r.json(); }));
    }).then(function(results) {
      var errors = results.filter(function(r) { return r.error; });
      if (errors.length > 0) {
        alert('上傳部分失敗 Upload errors: ' + errors.map(function(e) { return e.error; }).join(', '));
      }
      _frLoadMonth();
    }).catch(function(err) {
      alert('上傳失敗 Upload failed: ' + err.message);
      _frLoadMonth();
    });
  } else {
    alert('本機無班表資料，請先同步 No local roster data');
    var toggle = document.getElementById('fr-share-toggle');
    if (toggle) toggle.checked = false;
    localStorage.removeItem('crewsync_share_enabled');
    _frShowShareUI(false);
    _frShowEmpty();
  }
}


function _frPrevMonth() {
  _frMonth--;
  if (_frMonth < 1) { _frMonth = 12; _frYear--; }
  _frLoadMonth();
}

function _frNextMonth() {
  _frMonth++;
  if (_frMonth > 12) { _frMonth = 1; _frYear++; }
  _frLoadMonth();
}

function _frLoadMonth() {
  var months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var titleEl = document.getElementById('fr-month-title');
  if (titleEl) titleEl.textContent = months[_frMonth] + ' ' + _frYear;

  var monthKey = _frYear + '-' + String(_frMonth).padStart(2, '0');

  // 從 DB 拉有分享的人的班表
  _frData = [];
  fetch('/api/roster-friends?month=' + monthKey)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var filterFleet = document.getElementById('fr-filter-fleet');
      var filterRank = document.getElementById('fr-filter-rank');
      var ff = filterFleet ? filterFleet.value : '';
      var fr = filterRank ? filterRank.value : '';
      if (data.friends && data.friends.length > 0) {
        // 存離線快取（未篩選的完整資料）
        try { localStorage.setItem('crewsync_friends_' + monthKey, JSON.stringify(data.friends)); } catch(e){}
        for (var i = 0; i < data.friends.length; i++) {
          var f = data.friends[i];
          if (ff && f.fleet && f.fleet !== ff) continue;
          if (fr && f.rank && f.rank !== fr) continue;
          _frData.push({ name: f.name, nickname: f.nickname, picture: f.picture, duties: f.duties });
        }
      } else {
        // 雲端無資料，清除該月快取
        try { localStorage.removeItem('crewsync_friends_' + monthKey); } catch(e){}
      }
      _frRender();
    })
    .catch(function() {
      // 離線：讀 localStorage 快取
      _frLoadFromCache(monthKey, ff, fr);
      _frRender();
    });
}


function _frLoadFromCache(monthKey, ff, fr) {
  try {
    var cached = localStorage.getItem('crewsync_friends_' + monthKey);
    if (cached) {
      var friends = JSON.parse(cached);
      for (var i = 0; i < friends.length; i++) {
        var f = friends[i];
        if (ff && f.fleet && f.fleet !== ff) continue;
        if (fr && f.rank && f.rank !== fr) continue;
        _frData.push({ name: f.name, nickname: f.nickname, picture: f.picture, duties: f.duties });
      }
    }
  } catch(e){}
}

function _frRender() {
  var gridEl = document.getElementById('fr-grid');
  if (!gridEl) return;

  if (_frData.length === 0) {
    gridEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">此月份無分享班表<br>No shared roster for this month</div>';
    return;
  }

  var daysInMonth = new Date(_frYear, _frMonth, 0).getDate();
  var today = new Date();
  var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var colW = 68;
  var gridCols = 'repeat(' + daysInMonth + ', ' + colW + 'px)';

  var nameColW = 110;
  var totalGridW = daysInMonth * colW;
  var fullW = nameColW + totalGridW + 2;
  // Single scroll container (both axes)
  var html = '<div style="overflow:scroll;max-height:calc(100dvh - 188px);-webkit-overflow-scrolling:touch;overscroll-behavior:none;position:relative" id="fr-outer">';
  html += '<div style="display:grid;grid-template-columns:' + nameColW + 'px ' + gridCols + ';grid-template-rows:48px repeat(' + _frData.length + ',44px);gap:0;width:' + fullW + 'px">';

  // ── Top-left corner cell: "Crew" (sticky top + sticky left) ──
  html += '<div style="grid-row:1;grid-column:1;position:sticky;left:0;top:0;z-index:20;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;border-right:2px solid var(--dim);border-bottom:1px solid var(--dim);font-size:.7em;color:var(--muted);font-weight:700"><span>Crew</span><span style="font-size:.55em;font-weight:400;opacity:.6">點頭像看全名</span><span style="font-size:.55em;font-weight:400;opacity:.6">Tap 👤</span></div>';

  // ── Date header cells (row 1, col 2+): sticky top ──
  for (var d = 1; d <= daysInMonth; d++) {
    var dateObj = new Date(_frYear, _frMonth - 1, d);
    var dow = dateObj.getDay();
    var isWeekend = dow === 0 || dow === 6;
    var dateKey = _frYear + '-' + String(_frMonth).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    var isToday = dateKey === todayStr;
    var hdrBg = isToday ? 'background:var(--accent);color:#fff' : isWeekend ? 'background:#1a1220;color:#ef4444' : 'background:var(--bg);color:var(--muted)';
    html += '<div style="grid-row:1;grid-column:' + (d + 1) + ';position:sticky;top:0;z-index:10;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:.65em;border-right:1px solid var(--dim);border-bottom:1px solid var(--dim);' + hdrBg + '">';
    html += '<div style="font-weight:700;font-size:1.1em">' + d + '</div>';
    html += '<div>' + dayNames[dow] + '</div>';
    html += '</div>';
  }

  // ── Left name cells (col 1, row 2+): sticky left ──
  for (var p = 0; p < _frData.length; p++) {
    var person = _frData[p];
    var displayName = person.nickname || _frFormatName(person.name);
    var fullName = person.name || '';
    var escapedFull = fullName.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    var picHtml = person.picture
      ? '<img src="' + person.picture + '" onclick="_frToggleFullName(this,\'' + escapedFull + '\')" style="width:28px;height:28px;border-radius:50%;object-fit:cover;cursor:pointer;flex-shrink:0">'
      : '<div onclick="_frToggleFullName(this,\'' + escapedFull + '\')" style="width:28px;height:28px;border-radius:50%;background:#374151;display:flex;align-items:center;justify-content:center;font-size:.7em;cursor:pointer;flex-shrink:0">👤</div>';
    var gridRow = p + 2;
    html += '<div style="grid-row:' + gridRow + ';grid-column:1;position:sticky;left:0;z-index:2;background:var(--bg);display:flex;align-items:center;gap:5px;padding:4px 6px;border-right:2px solid var(--dim);border-bottom:1px solid var(--dim)">';
    html += picHtml;
    html += '<div style="font-size:.62em;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2">' + displayName + '</div>';
    html += '</div>';
  }

  // Person duty rows
  for (var p = 0; p < _frData.length; p++) {
    var person = _frData[p];
    var dayMap = _frBuildDayMap(person.duties);
    var rendered = {};
    var gridRow = p + 2; // row 1 = header, row 2+ = persons

    for (var d = 1; d <= daysInMonth; d++) {
      if (rendered[d]) continue;

      var dateKey = _frYear + '-' + String(_frMonth).padStart(2,'0') + '-' + String(d).padStart(2,'0');
      var dayDuties = dayMap[dateKey] || [];
      var gc = d + 1; // grid column offset: col 1 = name, col 2+ = dates

      if (dayDuties.length === 0) {
        html += '<div style="grid-row:' + gridRow + ';grid-column:' + gc + ';border-right:1px solid var(--dim);border-bottom:1px solid var(--dim)"></div>';
      } else {
        var duty = dayDuties[0];
        var span = _frCalcSpan(duty, d, daysInMonth);
        for (var s = 1; s < span; s++) rendered[d + s] = true;

        var color = _frGetDutyColor(duty.duty);
        var label = _frGetDutyLabel(duty);
        var gcEnd = gc + span;

        html += '<div style="grid-row:' + gridRow + ';grid-column:' + gc + '/' + gcEnd + ';background:' + color + ';display:flex;align-items:center;justify-content:center;border-right:1px solid rgba(255,255,255,.15);border-bottom:1px solid var(--dim)">';
        html += '<div style="color:#fff;font-size:.58em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 3px;text-align:center;line-height:1.3">' + label + '</div>';
        html += '</div>';
      }
    }
  }

  html += '</div>'; // end grid
  html += '</div>'; // end scroll container

  gridEl.innerHTML = html;
}

// 點大頭顯示/隱藏全名
var _frFullNameEl = null;
var _frFullNameTarget = null;
function _frToggleFullName(el, fullName) {
  if (_frFullNameEl) { _frFullNameEl.remove(); _frFullNameEl = null; }
  if (_frFullNameTarget === el) { _frFullNameTarget = null; return; }
  _frFullNameTarget = el;
  var rect = el.getBoundingClientRect();
  var tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + (rect.bottom + 4) + 'px;background:#1e2740;color:#e2e8f0;padding:5px 10px;border-radius:6px;font-size:.75em;white-space:nowrap;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.6)';
  tip.textContent = fullName;
  tip.id = 'fr-fullname-tip';
  document.body.appendChild(tip);
  _frFullNameEl = tip;
}

document.addEventListener('click', function(e) {
  if (_frFullNameEl && !e.target.closest('#fr-fullname-tip') && e.target !== _frFullNameTarget) {
    _frFullNameEl.remove();
    _frFullNameEl = null;
    _frFullNameTarget = null;
  }
});

function _frBuildDayMap(duties) {
  var dayMap = {};
  for (var i = 0; i < duties.length; i++) {
    var d = duties[i];
    var dates = _frParseDates(d.reportTime, d.endTime);
    for (var j = 0; j < dates.length; j++) {
      if (!dayMap[dates[j]]) dayMap[dates[j]] = [];
      dayMap[dates[j]].push(d);
    }
  }
  return dayMap;
}

function _frCalcSpan(duty, startDay, daysInMonth) {
  // Calculate how many days this duty spans starting from startDay within this month
  var dates = _frParseDates(duty.reportTime, duty.endTime);
  var monthPrefix = _frYear + '-' + String(_frMonth).padStart(2, '0') + '-';
  var span = 0;
  for (var i = 0; i < dates.length; i++) {
    if (dates[i].indexOf(monthPrefix) !== 0) continue;
    var dayNum = parseInt(dates[i].substring(8), 10);
    if (dayNum >= startDay && dayNum <= daysInMonth) {
      if (dayNum === startDay + span) span++;
    }
  }
  return Math.max(1, span);
}

function _frGetDutyColor(dutyName) {
  // 顏色邏輯比照 Roster (_rgGetDutyColor)
  if (!dutyName) return '#6b7280';
  if (dutyName.indexOf('JX') >= 0) return '#7f1d1d'; // 深紅 = 航班
  if (/^S\d/.test(dutyName)) return '#166534'; // 綠 = 待命
  if (dutyName === 'MCC' || dutyName.indexOf('A35') >= 0 || dutyName.indexOf('A32') >= 0 || dutyName.indexOf('CRM') >= 0 || dutyName.indexOf('SIM') >= 0) return '#1e40af'; // 藍 = 訓練/體檢
  return '#6b7280'; // 灰 = 其他（OFF/REST/VAC 等）
}

function _frGetDutyLabel(duty) {
  var d = duty.duty;
  if (!d) return '';
  // Flight: "JX002/JX001 LAX" → "JX002-JX001\nLAX"
  if (d.indexOf('JX') >= 0) {
    var parts = d.split(' ');
    var flights = parts[0].replace(/\//g, '-');
    var dest = parts.length > 1 ? parts[parts.length - 1] : '';
    return flights + (dest ? '<br>' + dest : '');
  }
  return d;
}

function _frFormatName(name) {
  // "LU, DOMINIC" → "Dominic"
  if (!name) return '?';
  var parts = name.split(',');
  if (parts.length >= 2) {
    var first = parts[1].trim();
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }
  return name;
}

function _frParseDates(reportTime, endTime) {
  var dates = [];
  var start = _frParseDate(reportTime);
  var end = _frParseDate(endTime);
  if (!start || isNaN(start.getTime())) return dates;
  if (!end || isNaN(end.getTime())) end = start;
  var cur = new Date(start);
  var maxDays = 30;
  while (cur <= end && maxDays-- > 0) {
    var y = cur.getFullYear();
    var m = String(cur.getMonth() + 1).padStart(2, '0');
    var d = String(cur.getDate()).padStart(2, '0');
    dates.push(y + '-' + m + '-' + d);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function _frParseDate(str) {
  if (!str) return null;
  var months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  // "2026.Mar.08 2150L" format
  var m = str.match(/(\d{4})\.([A-Za-z]{3})\.(\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), months[m[2].toLowerCase()] || 0, parseInt(m[3]));
  // "DD MMM YYYY" format
  var m2 = str.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (m2) return new Date(parseInt(m2[3]), months[m2[2].toLowerCase()] || 0, parseInt(m2[1]));
  // ISO or other
  var d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  return null;
}
