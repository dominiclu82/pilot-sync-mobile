// ── Groups 群組面板 ──────────────────────────────────────────────────────────
var _grpData = null; // { presets, custom, pendingInvites }
var _grpYear = new Date().getFullYear();
var _grpMonth = new Date().getMonth() + 1;
var _grpGridData = [];

// ── Groups Panel Init ──
function _grpInitPanel() {
  _grpShowShareUI(true);
  _grpLoadPresets();
  _grpUpdateMonthTitle();
  _grpLoadGrid();
}

function _grpUpdateShareDot(on) {
  var dot = document.getElementById('grp-share-dot');
  if (dot) dot.style.left = on ? '18px' : '2px';
  var bg = dot ? dot.previousElementSibling : null;
  if (bg) bg.style.background = on ? 'var(--accent)' : '#4a5568';
}

function _grpToggleShare() {
  var toggle = document.getElementById('grp-share-toggle');
  if (toggle && toggle.checked) {
    localStorage.setItem('crewsync_share_enabled', '1');
    _grpUpdateShareDot(true);
    _grpShowShareUI(true);
    // 同步到 Friends
    var frToggle = document.getElementById('fr-share-toggle');
    if (frToggle && !frToggle.checked) { frToggle.checked = true; _frShowShareUI(true); }
    _grpLoadPresets();
    _grpUpdateMonthTitle();
    _grpLoadGrid();
  } else {
    localStorage.removeItem('crewsync_share_enabled');
    _grpUpdateShareDot(false);
    _grpShowShareUI(false);
    // 同步到 Friends
    var frToggle = document.getElementById('fr-share-toggle');
    if (frToggle && frToggle.checked) { frToggle.checked = false; _frShowShareUI(false); }
    _grpShowEmpty();
  }
}
// Groups ↔ Friends 連動
function _grpSyncFromFriends() {
  var isSharing = localStorage.getItem('crewsync_share_enabled') === '1';
  var toggle = document.getElementById('grp-share-toggle');
  if (toggle) toggle.checked = isSharing;
  _grpUpdateShareDot(isSharing);
  _grpShowShareUI(isSharing);
}

function _grpShowShareUI(show) {
  var fleetHint = document.getElementById('grp-fleet-hint');
  var nameWrap = document.getElementById('grp-name-wrap');
  var fleetSel = document.getElementById('grp-my-fleet');
  var rankSel = document.getElementById('grp-my-rank');
  var nameInp = document.getElementById('grp-my-name');
  var roleSel = document.getElementById('grp-my-role');
  if (fleetHint) fleetHint.style.display = show ? 'inline-flex' : 'none';
  if (nameWrap) nameWrap.style.display = show ? 'inline-flex' : 'none';
  if (show) {
    var role = localStorage.getItem('crewsync_my_role') || '';
    if (roleSel) roleSel.value = role;
    if (role === 'cc') {
      if (fleetSel) fleetSel.style.display = 'none';
      if (rankSel) rankSel.innerHTML = '<option value="" disabled selected>職級</option><option value="SP">SP</option><option value="PR">PR</option><option value="SC">SC</option><option value="CC">CC</option><option value="PC">PC</option>';
    } else if (role === 'fc') {
      if (fleetSel) fleetSel.style.display = '';
      if (rankSel) rankSel.innerHTML = '<option value="" disabled selected>職級</option><option value="CAP">CAP</option><option value="SFO">SFO</option><option value="FO">FO</option>';
    }
    if (fleetSel) fleetSel.value = localStorage.getItem('crewsync_my_fleet') || '';
    if (rankSel) rankSel.value = localStorage.getItem('crewsync_my_rank') || '';
    if (nameInp) nameInp.value = localStorage.getItem('crewsync_nickname') || localStorage.getItem('crewsync_crew_name') || '';
  }
}

function _grpSyncRole() {
  var roleSel = document.getElementById('grp-my-role');
  var role = roleSel ? roleSel.value : '';
  if (role) localStorage.setItem('crewsync_my_role', role);
  var fleetSel = document.getElementById('grp-my-fleet');
  var rankSel = document.getElementById('grp-my-rank');
  if (role === 'fc') {
    if (fleetSel) fleetSel.style.display = '';
    if (rankSel) {
      rankSel.innerHTML = '<option value="" disabled selected>職級</option><option value="CAP">CAP</option><option value="SFO">SFO</option><option value="FO">FO</option>';
      rankSel.style.display = '';
    }
  } else if (role === 'cc') {
    if (fleetSel) fleetSel.style.display = 'none';
    localStorage.removeItem('crewsync_my_fleet');
    if (rankSel) {
      rankSel.innerHTML = '<option value="" disabled selected>職級</option><option value="SP">SP</option><option value="PR">PR</option><option value="SC">SC</option><option value="CC">CC</option><option value="PC">PC</option>';
      rankSel.style.display = '';
    }
  }
  // 同步到 Friends
  var frRole = document.getElementById('fr-my-role');
  if (frRole) frRole.value = role;
  // 改身分時重置職級
  if (rankSel) rankSel.value = '';
  localStorage.removeItem('crewsync_my_rank');
  if (_grpData) _grpRenderPresets(_grpData);
}

function _grpSyncFleetRank() {
  var fleetSel = document.getElementById('grp-my-fleet');
  var rankSel = document.getElementById('grp-my-rank');
  var fleet = fleetSel ? fleetSel.value : '';
  var rank = rankSel ? rankSel.value : '';
  if (fleet) localStorage.setItem('crewsync_my_fleet', fleet);
  if (rank) localStorage.setItem('crewsync_my_rank', rank);
  // 同步到 Friends
  var frFleet = document.getElementById('fr-my-fleet');
  var frRank = document.getElementById('fr-my-rank');
  if (frFleet) frFleet.value = fleet;
  if (frRank) frRank.value = rank;
  // 機隊/職級改變時，退出不符合的預設群組 + 重新渲染
  if (fleet && rank) _grpAutoLeavePresets(fleet, rank);
  _grpLoadPresets();
  // 觸發上傳
  _frCheckReady();
}

function _grpSyncName() {
  var nameInp = document.getElementById('grp-my-name');
  var name = nameInp ? nameInp.value.trim() : '';
  if (name) localStorage.setItem('crewsync_nickname', name);
  else localStorage.removeItem('crewsync_nickname');
  // 同步到 Friends
  var frName = document.getElementById('fr-my-name');
  if (frName) frName.value = name;
  // 直接上傳名稱到 server
  var eid = localStorage.getItem('crewsync_eid');
  var fleet = localStorage.getItem('crewsync_my_fleet');
  var rank = localStorage.getItem('crewsync_my_rank');
  if (eid && fleet && rank) {
    fetch('/api/roster-share', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eid: eid, fleet: fleet, rank: rank, nickname: name, updateInfoOnly: true }) })
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d.ok) _grpLoadGrid(); })
      .catch(function() {});
  }
}

function _grpShowEmpty() {
  var list = document.getElementById('grp-preset-list');
  if (list) list.innerHTML = '';
  var grid = document.getElementById('grp-grid');
  if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted)"><div style="font-size:2em;margin-bottom:8px">👥</div><div style="font-size:.85em">開啟分享後即可加入群組<br><span style="opacity:.6">Enable sharing to join groups</span></div></div>';
}

// ── Preset toggles ──
function _grpLoadPresets() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups?eid=' + encodeURIComponent(eid))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) return;
      _grpData = data;
      _grpRenderPresets(data);
      _grpUpdateViewFilter(data);
      _grpUpdateBadge(data.pendingInvites);
      _grpLoadGrid();
    }).catch(function() {});
}

function _grpRenderPresets(data) {
  var sel = document.getElementById('grp-preset-select');
  var tags = document.getElementById('grp-preset-tags');
  if (!sel || !tags) return;
  var myRole = localStorage.getItem('crewsync_my_role') || '';
  var myFleet = localStorage.getItem('crewsync_my_fleet') || '';
  var myRank = localStorage.getItem('crewsync_my_rank') || '';

  // 下拉選單：未加入的群組
  var selHtml = '<option value="">+ 加入群組</option>';
  // 標籤：已加入的群組
  var tagHtml = '';

  for (var i = 0; i < data.presets.length; i++) {
    var p = data.presets[i];
    var isAll = p.id === 'preset_all';
    var canJoin = isAll;
    if (!isAll && myRole === 'fc') {
      if (myRank === 'CAP') canJoin = p.id === 'preset_' + myFleet + '_CAP';
      else canJoin = p.id === 'preset_' + myFleet + '_SFOFO';
    } else if (!isAll && myRole === 'cc') {
      if (myRank === 'SP' || myRank === 'PR') canJoin = p.id === 'preset_CC_SPPR';
      else if (myRank === 'SC') canJoin = p.id === 'preset_CC_SC';
      else if (myRank === 'CC' || myRank === 'PC') canJoin = p.id === 'preset_CC_CCPC';
    }

    if (p.joined) {
      // 已加入 → 標籤
      tagHtml += '<span style="display:inline-flex;align-items:center;gap:2px;background:var(--accent);color:#fff;border-radius:4px;padding:1px 6px;font-size:.68em;white-space:nowrap">';
      tagHtml += p.name;
      tagHtml += ' <span onclick="_grpTogglePreset(\'' + p.id + '\',false)" style="cursor:pointer;opacity:.7;font-size:1.1em">✕</span>';
      tagHtml += '</span>';
    } else {
      // 未加入 → 下拉選項
      var disabled = !canJoin;
      var suffix = disabled ? ' (不符合職級)' : '';
      selHtml += '<option value="' + p.id + '"' + (disabled ? ' disabled' : '') + '>' + p.name + suffix + '</option>';
    }
  }
  sel.innerHTML = selHtml;
  if (tagHtml) tagHtml += '<span style="font-size:.55em;color:var(--muted);opacity:.6;white-space:nowrap">✕退出 Leave</span>';
  tags.innerHTML = tagHtml;
}

function _grpJoinFromSelect(sel) {
  var groupId = sel.value;
  if (!groupId) return;
  sel.value = ''; // 重置下拉
  _grpTogglePreset(groupId, true);
}

function _grpTogglePreset(groupId, join) {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  var url = join ? '/api/groups/join' : '/api/groups/leave';
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid, groupId: groupId }) })
    .then(function(r) { return r.json(); })
    .then(function() {
      if (join) {
        localStorage.setItem('crewsync_share_enabled', '1');
        _grpAutoUploadRoster();
      } else {
        // 檢查是否還有任何群組，沒有就關閉 sharing
        _grpCheckAutoDisableSharing();
      }
      _grpLoadPresets();
    });
}

// ── Month nav ──
function _grpPrevMonth() {
  _grpMonth--;
  if (_grpMonth < 1) { _grpMonth = 12; _grpYear--; }
  _grpUpdateMonthTitle();
  _grpLoadGrid();
}
function _grpNextMonth() {
  _grpMonth++;
  if (_grpMonth > 12) { _grpMonth = 1; _grpYear++; }
  _grpUpdateMonthTitle();
  _grpLoadGrid();
}
function _grpUpdateMonthTitle() {
  var el = document.getElementById('grp-month-title');
  if (el) {
    var months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    el.textContent = months[_grpMonth] + ' ' + _grpYear;
  }
}

// ── View filter ──
function _grpUpdateViewFilter(data) {
  var sel = document.getElementById('grp-view-filter');
  if (!sel) return;
  var current = sel.value || 'all';
  var joined = data.presets.filter(function(p) { return p.joined; });
  if (joined.length <= 1) {
    sel.style.display = 'none';
    sel.innerHTML = '<option value="all">全部 All</option>';
    return;
  }
  sel.style.display = '';
  var html = '';
  for (var i = 0; i < joined.length; i++) {
    html += '<option value="' + joined[i].id + '">' + joined[i].name + '</option>';
  }
  sel.innerHTML = html;
  sel.value = current;
}

// ── Grid (reuse Friends grid rendering) ──
function _grpLoadGrid() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  var monthKey = _grpYear + '-' + String(_grpMonth).padStart(2, '0');
  var filterGroup = document.getElementById('grp-view-filter');
  var groupVal = filterGroup ? filterGroup.value : 'all';

  // 如果 groupVal 是 'all'，要用所有已加入的預設群組
  var url = '/api/roster-friends?month=' + monthKey + '&eid=' + encodeURIComponent(eid);
  if (groupVal !== 'all') {
    url += '&group=' + encodeURIComponent(groupVal);
  }

  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.friends) return;
      _grpGridData = data.friends;
      _grpRenderGrid();
    }).catch(function() {});
}

function _grpOnFilterRole() {
  var roleSel = document.getElementById('grp-filter-role');
  var fleetSel = document.getElementById('grp-filter-fleet');
  var rankSel = document.getElementById('grp-filter-rank');
  var role = roleSel ? roleSel.value : '';
  if (role === 'fc') {
    if (fleetSel) fleetSel.style.display = '';
    if (rankSel) { rankSel.style.display = ''; rankSel.innerHTML = '<option value="">All</option><option value="CAP">CAP</option><option value="SFOFO">SFO+FO</option>'; }
  } else if (role === 'cc') {
    if (fleetSel) fleetSel.style.display = 'none';
    if (rankSel) { rankSel.style.display = ''; rankSel.innerHTML = '<option value="">All</option><option value="SPPR">SP+PR</option><option value="SC">SC</option><option value="CCPC">CC+PC</option>'; }
  } else {
    if (fleetSel) fleetSel.style.display = '';
    if (rankSel) { rankSel.style.display = ''; rankSel.innerHTML = '<option value="">All</option>'; }
  }
  _grpLoadGrid();
}

function _grpRenderGrid() {
  var gridEl = document.getElementById('grp-grid');
  if (!gridEl) return;
  var viewSel = document.getElementById('grp-view-filter');
  var viewVal = viewSel ? viewSel.value : 'all';
  var filterRole = document.getElementById('grp-filter-role');
  var filterFleet = document.getElementById('grp-filter-fleet');
  var filterRank = document.getElementById('grp-filter-rank');
  // 篩選只在 All 群組時顯示
  var isAll = viewVal === 'preset_all' || viewVal === 'all';
  var filterWrap = filterRole ? filterRole.parentElement : null;
  if (filterRole) filterRole.style.display = isAll ? '' : 'none';
  if (filterFleet) filterFleet.style.display = isAll ? '' : 'none';
  if (filterRank) filterRank.style.display = isAll ? '' : 'none';
  var filtered = _grpGridData;
  if (isAll) {
    var roleVal = filterRole ? filterRole.value : '';
    var ff = filterFleet ? filterFleet.value : '';
    var frVal = filterRank ? filterRank.value : '';
    // 身分篩選
    if (roleVal === 'fc') {
      filtered = filtered.filter(function(p) { return p.fleet && p.fleet.indexOf('A3') === 0; });
    } else if (roleVal === 'cc') {
      filtered = filtered.filter(function(p) { return !p.fleet || p.fleet === ''; });
    }
    // 機隊篩選（FC only）
    if (ff && roleVal !== 'cc') filtered = filtered.filter(function(p) { return p.fleet === ff; });
    // 職級篩選
    if (frVal === 'CAP') filtered = filtered.filter(function(p) { return p.rank === 'CAP'; });
    else if (frVal === 'SFOFO') filtered = filtered.filter(function(p) { return p.rank === 'SFO' || p.rank === 'FO'; });
    else if (frVal === 'SPPR') filtered = filtered.filter(function(p) { return p.rank === 'SP' || p.rank === 'PR'; });
    else if (frVal === 'SC') filtered = filtered.filter(function(p) { return p.rank === 'SC'; });
    else if (frVal === 'CCPC') filtered = filtered.filter(function(p) { return p.rank === 'CC' || p.rank === 'PC'; });
  }
  if (filtered.length === 0) {
    gridEl.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted)"><div style="font-size:.85em">尚無成員班表<br><span style="opacity:.6">No roster data from group members</span></div></div>';
    return;
  }
  _frRenderGridTo(gridEl, filtered, _grpYear, _grpMonth);
}

// ── Badge ──
function _grpUpdateBadge(count) {
  var badge = document.getElementById('grp-badge');
  if (badge) {
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
    badge.textContent = count > 0 ? count : '';
  }
}

// ── Friends panel: 好友圈管理 ──
function _grpShowManage() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) { alert('請先同步班表 Please sync your roster first'); return; }
  var overlay = document.getElementById('grp-manage-overlay');
  if (overlay) overlay.style.display = 'flex';
  _grpRefreshFriends();
}

function _grpCloseManage() {
  var overlay = document.getElementById('grp-manage-overlay');
  if (overlay) overlay.style.display = 'none';
}

function _grpRefreshFriends() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups?eid=' + encodeURIComponent(eid))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) return;
      _grpData = data;
      _grpRenderFriends(data);
      _grpUpdateBadge(data.pendingInvites);
      // 同步 Friends 的好友圈下拉和紅點
      if (typeof _frPopulateGroupFilter === 'function') _frPopulateGroupFilter();
    }).catch(function() {});
  _grpLoadInvites();
}

function _grpRenderFriends(data) {
  var container = document.getElementById('grp-friends-content');
  if (!container) return;
  var html = '';

  // 自訂好友圈列表
  if (data.custom.length === 0) {
    html += '<div style="font-size:.78em;color:var(--muted);margin-bottom:8px">尚無自訂好友圈 No custom groups yet</div>';
  }
  for (var j = 0; j < data.custom.length; j++) {
    var c = data.custom[j];
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px;margin-bottom:6px;background:var(--card);border-radius:8px;border:1px solid var(--dim)">';
    html += '<div>';
    html += '<div style="font-size:.85em;font-weight:600;color:var(--text)">' + _grpEsc(c.name) + ' <span style="color:var(--muted);font-weight:400">(' + c.memberCount + '人)</span></div>';
    html += '<div style="font-size:.72em;color:var(--muted)">邀請碼 Code: <span style="font-weight:700;color:var(--accent);letter-spacing:2px">' + c.inviteCode + '</span> <span onclick="_grpCopyCode(\'' + c.inviteCode + '\')" style="cursor:pointer;color:var(--accent)">📋</span></div>';
    html += '<div style="display:flex;gap:4px;margin-top:4px">';
    html += '<button onclick="_grpViewMembers(\'' + c.id + '\',\'' + _grpEsc(c.name) + '\')" style="background:#2d3748;color:#e2e8f0;border:none;border-radius:4px;padding:2px 8px;font-size:.68em;cursor:pointer">👥 成員</button>';
    html += '<button onclick="_grpShowInvite(\'' + c.id + '\')" style="background:#2d3748;color:#e2e8f0;border:none;border-radius:4px;padding:2px 8px;font-size:.68em;cursor:pointer">✉ 邀請</button>';
    html += '</div>';
    html += '</div>';
    html += '<button onclick="_grpLeave(\'' + c.id + '\')" style="background:#ef4444;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.72em;cursor:pointer;align-self:center">退出</button>';
    html += '</div>';
  }

  // 操作按鈕
  html += '<div style="display:flex;gap:8px;margin-top:12px">';
  html += '<button onclick="_grpShowCreate()" style="flex:1;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px;font-size:.82em;cursor:pointer">建立好友圈 Create</button>';
  html += '<button onclick="_grpShowJoinCode()" style="flex:1;background:#2d3748;color:#e2e8f0;border:1px solid #4a5568;border-radius:8px;padding:8px;font-size:.82em;cursor:pointer">輸入邀請碼 Join</button>';
  html += '</div>';

  // 建立表單
  html += '<div id="grp-create-form" style="display:none;margin-top:12px;padding:10px;background:var(--card);border-radius:8px;border:1px solid var(--dim)">';
  html += '<div style="font-size:.78em;color:var(--muted);margin-bottom:6px">群組名稱 Group Name</div>';
  html += '<input id="grp-create-name" type="text" placeholder="e.g. 升訓讀書會" style="width:100%;padding:6px;border-radius:6px;border:1px solid var(--dim);background:var(--surface);color:var(--text);font-size:.85em;box-sizing:border-box">';
  html += '<button onclick="_grpCreate()" style="margin-top:8px;width:100%;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px;font-size:.82em;cursor:pointer">建立 Create</button>';
  html += '</div>';

  // 邀請碼表單
  html += '<div id="grp-joincode-form" style="display:none;margin-top:12px;padding:10px;background:var(--card);border-radius:8px;border:1px solid var(--dim)">';
  html += '<div style="font-size:.78em;color:var(--muted);margin-bottom:6px">邀請碼 Invite Code</div>';
  html += '<input id="grp-join-code-input" type="text" maxlength="4" placeholder="e.g. X7K9" style="width:100%;padding:6px;border-radius:6px;border:1px solid var(--dim);background:var(--surface);color:var(--text);font-size:.85em;text-transform:uppercase;letter-spacing:4px;text-align:center;box-sizing:border-box">';
  html += '<button onclick="_grpJoinCode()" style="margin-top:8px;width:100%;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px;font-size:.82em;cursor:pointer">加入 Join</button>';
  html += '</div>';

  // 待處理邀請
  html += '<div id="grp-invites-section" style="margin-top:12px"></div>';

  container.innerHTML = html;
  _grpLoadInvites();
}

// ── Shared helpers ──
function _grpShowCreate() {
  var el = document.getElementById('grp-create-form');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function _grpShowJoinCode() {
  var el = document.getElementById('grp-joincode-form');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function _grpCreate() {
  var eid = localStorage.getItem('crewsync_eid');
  var nameEl = document.getElementById('grp-create-name');
  if (!eid || !nameEl || !nameEl.value.trim()) return;
  fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid, name: nameEl.value.trim() }) })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        alert('建立成功！邀請碼 Invite Code: ' + data.group.inviteCode);
        nameEl.value = '';
        document.getElementById('grp-create-form').style.display = 'none';
        _grpAutoUploadRoster();
        _grpRefreshFriends();
      } else { alert(data.error || 'Error'); }
    });
}
function _grpJoinCode() {
  var eid = localStorage.getItem('crewsync_eid');
  var inp = document.getElementById('grp-join-code-input');
  if (!eid || !inp || !inp.value.trim()) return;
  fetch('/api/groups/join-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid, inviteCode: inp.value.trim() }) })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        alert('已加入「' + data.group.name + '」');
        inp.value = '';
        document.getElementById('grp-joincode-form').style.display = 'none';
        _grpAutoUploadRoster();
        _grpRefreshFriends();
      } else { alert(data.error || 'Error'); }
    });
}
function _grpLeave(groupId) {
  if (!confirm('確定退出此群組？Leave this group?')) return;
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid, groupId: groupId }) })
    .then(function() { _grpRefreshFriends(); });
}
function _grpCopyCode(code) {
  navigator.clipboard.writeText(code).then(function() { alert('已複製 Copied: ' + code); }).catch(function() {});
}
function _grpViewMembers(groupId, groupName) {
  fetch('/api/groups/' + groupId + '/members')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.members) return;
      var lines = data.members.map(function(m) { return m.name + (m.fleet ? ' (' + m.fleet + ' ' + (m.rank || '') + ')' : ''); });
      alert('「' + groupName + '」成員 (' + data.members.length + '人)\n\n' + lines.join('\n'));
    });
}
function _grpShowInvite(groupId) {
  var targetEid = prompt('輸入對方的員工編號 Enter employee ID:');
  if (!targetEid) return;
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid, groupId: groupId, targetEid: targetEid.trim() }) })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) alert(data.note || '邀請已送出 Invite sent');
      else alert(data.error || 'Error');
    });
}
function _grpLoadInvites() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups/invites?eid=' + encodeURIComponent(eid))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var section = document.getElementById('grp-invites-section');
      if (!section || !data.invites || data.invites.length === 0) { if (section) section.innerHTML = ''; return; }
      var html = '<div style="font-weight:700;font-size:.85em;color:var(--text);margin-bottom:6px;border-top:1px solid var(--dim);padding-top:10px">🔔 待處理邀請 Pending Invites</div>';
      for (var i = 0; i < data.invites.length; i++) {
        var inv = data.invites[i];
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px;margin-bottom:4px;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.2);border-radius:8px">';
        html += '<div style="font-size:.8em"><span style="font-weight:600;color:var(--text)">' + _grpEsc(inv.group_name) + '</span><br><span style="color:var(--muted);font-size:.85em">' + _grpEsc(inv.inviter_name) + ' 邀請你</span></div>';
        html += '<div style="display:flex;gap:4px">';
        html += '<button onclick="_grpAcceptInvite(' + inv.id + ')" style="background:#22c55e;color:#fff;border:none;border-radius:6px;padding:4px 8px;font-size:.72em;cursor:pointer">同意</button>';
        html += '<button onclick="_grpDeclineInvite(' + inv.id + ')" style="background:#4a5568;color:#e2e8f0;border:none;border-radius:6px;padding:4px 8px;font-size:.72em;cursor:pointer">拒絕</button>';
        html += '</div></div>';
      }
      section.innerHTML = html;
    }).catch(function() {});
}
function _grpAcceptInvite(invId) {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups/invites/' + invId + '/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid }) })
    .then(function() { _grpAutoUploadRoster(); _grpRefreshFriends(); });
}
function _grpDeclineInvite(invId) {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups/invites/' + invId + '/decline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid }) })
    .then(function() { _grpRefreshFriends(); });
}
// 機隊/職級改變時，自動退出不符合的預設群組
function _grpAutoLeavePresets(newFleet, newRank) {
  if (!_grpData || !_grpData.presets) return;
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  var role = localStorage.getItem('crewsync_my_role') || '';
  // 計算目前有效的群組 ID
  var validIds = ['preset_all'];
  if (role === 'fc') {
    if (newRank === 'CAP') validIds.push('preset_' + newFleet + '_CAP');
    else validIds.push('preset_' + newFleet + '_SFOFO');
  } else if (role === 'cc') {
    if (newRank === 'SP' || newRank === 'PR') validIds.push('preset_CC_SPPR');
    else if (newRank === 'SC') validIds.push('preset_CC_SC');
    else if (newRank === 'CC' || newRank === 'PC') validIds.push('preset_CC_CCPC');
  }
  var promises = [];
  for (var i = 0; i < _grpData.presets.length; i++) {
    var p = _grpData.presets[i];
    if (p.joined && validIds.indexOf(p.id) === -1) {
      promises.push(
        fetch('/api/groups/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid, groupId: p.id }) })
      );
    }
  }
  if (promises.length > 0) {
    Promise.all(promises).then(function() { _grpLoadPresets(); _grpLoadGrid(); });
  }
}

// 檢查是否還有任何群組（preset + custom），沒有就關閉 sharing
function _grpCheckAutoDisableSharing() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups?eid=' + encodeURIComponent(eid))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) return;
      var hasAny = (data.presets || []).some(function(p) { return p.joined; }) || (data.custom || []).length > 0;
      if (!hasAny) {
        localStorage.removeItem('crewsync_share_enabled');
        // 撤銷分享
        fetch('/api/roster-share', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eid: eid }) });
      }
    });
}

// 加入群組後自動上傳 local 班表到資料庫
function _grpAutoUploadRoster() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  var fleet = localStorage.getItem('crewsync_my_fleet') || '';
  var rank = localStorage.getItem('crewsync_my_rank') || '';
  var nickname = localStorage.getItem('crewsync_nickname') || '';
  // 找所有 localStorage 裡的班表
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (!key || key.indexOf('crewsync_roster_' + eid + '_') !== 0) continue;
    var monthKey = key.replace('crewsync_roster_' + eid + '_', '');
    try {
      var cached = JSON.parse(localStorage.getItem(key));
      var duties = cached.duties || cached;
      if (!duties || !duties.length) continue;
      fetch('/api/roster-share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eid: eid, month: monthKey, duties: duties, fleet: fleet, rank: rank, nickname: nickname })
      });
    } catch(e) {}
  }
}

function _grpEsc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Cabin Crew Rest Calculator ──────────────────────────────────────────────
// _ccRestUnlock removed — no longer password-locked

function _ccRestCalc() {
  var startEl = document.getElementById('cc-rest-start');
  var handoverEl = document.getElementById('cc-rest-handover');
  var prepEl = document.getElementById('cc-rest-prep');
  var mealEl = document.getElementById('cc-rest-meal');
  var todEl = document.getElementById('cc-rest-tod');
  var landingEl = document.getElementById('cc-rest-landing');
  var tzEl = document.getElementById('cc-rest-tz');

  if (!startEl.value || !todEl.value) { alert('請填入 1st Rest 開始和 TOD Time'); return; }

  var startMin = _ccTimeToMin(startEl.value);
  var todMin = _ccTimeToMin(todEl.value);
  var landingMin = landingEl.value ? _ccTimeToMin(landingEl.value) : null;
  var handoverMin = _ccParseDuration(handoverEl.value);
  var prepMin = _ccParseDuration(prepEl ? prepEl.value : '0');
  var mealMin = _ccParseDuration(mealEl.value);

  // 處理跨午夜
  if (todMin <= startMin) todMin += 1440;

  var totalAvail = todMin - startMin;
  var nonRest = handoverMin + prepMin + mealMin;
  var totalRest = totalAvail - nonRest;

  if (totalRest <= 0) { alert('可用休息時間不足 Not enough rest time'); return; }

  var restPerGroup = Math.floor(totalRest / 2);
  restPerGroup = Math.floor(restPerGroup / 5) * 5;

  // 時間軸：1st Rest → Handover → 2nd Rest → Crew Prep → 2nd Meal → TOD
  var t = startMin;
  var rest1Start = t;
  var rest1End = t + restPerGroup;
  t = rest1End;
  var hoStart = t;
  var hoEnd = t + handoverMin;
  t = hoEnd;
  var rest2Start = t;
  var rest2End = t + restPerGroup;
  t = rest2End;
  var prepStart = t;
  var prepEnd = t + prepMin;
  t = prepEnd;
  var mealStart = t;
  var mealEnd = t + mealMin;

  var resultEl = document.getElementById('cc-rest-result');
  var html = '';
  html += '<div style="font-size:.9em;font-weight:700;color:var(--text);margin-bottom:12px;text-align:center">📋 Rest Schedule (Dest Local Time)</div>';

  html += _ccRestRow('1st Rest', rest1Start, rest1End, '#1e40af', restPerGroup);
  html += _ccRestRow('Handover', hoStart, hoEnd, '#854d0e', handoverMin);
  html += _ccRestRow('2nd Rest', rest2Start, rest2End, '#7f1d1d', restPerGroup);
  if (prepMin > 0) html += _ccRestRow('Crew Prep', prepStart, prepEnd, '#6b21a8', prepMin);
  html += _ccRestRow('2nd Meal Svc', mealStart, mealEnd, '#065f46', mealMin);
  html += '<div style="border-top:1px solid var(--dim);margin-top:8px;padding-top:8px">';
  html += _ccRestRow('TOD', todMin, null, '#4a5568', 0);
  if (landingMin !== null) {
    var lm = landingMin;
    if (lm <= startMin) lm += 1440;
    html += _ccRestRow('Landing', lm, null, '#4a5568', 0);
  }
  html += '</div>';

  // 總結
  html += '<div style="margin-top:12px;padding:10px;background:rgba(59,130,246,.08);border-radius:8px;font-size:.78em;color:var(--muted);text-align:center">';
  html += '總可用 Total: ' + totalAvail + ' min ｜ 純休息 Rest: ' + totalRest + ' min ｜ 每組 Per group: ' + restPerGroup + ' min (' + Math.floor(restPerGroup/60) + 'h' + (restPerGroup%60 ? restPerGroup%60 + 'm' : '') + ')';
  html += '</div>';

  // 存快取
  _ccRestSaveCache();

  resultEl.innerHTML = html;
  resultEl.style.display = '';
}

function _ccRestRow(label, startMin, endMin, color, duration) {
  var html = '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">';
  html += '<div style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex-shrink:0"></div>';
  html += '<div style="flex:1;font-size:.85em;font-weight:600;color:var(--text)">' + label + '</div>';
  html += '<div style="font-size:.85em;color:var(--text);font-weight:700">' + _ccMinToTime(startMin);
  if (endMin !== null) html += ' ~ ' + _ccMinToTime(endMin);
  html += '</div>';
  if (duration > 0) html += '<div style="font-size:.7em;color:var(--muted);min-width:40px;text-align:right">' + duration + 'min</div>';
  html += '</div>';
  return html;
}

// ── CC Rest 快取（24 小時）──
function _ccRestSaveCache() {
  try {
    var obj = {
      ts: Date.now(),
      tz: document.getElementById('cc-rest-tz').value,
      start: document.getElementById('cc-rest-start').value,
      handover: document.getElementById('cc-rest-handover').value,
      prep: document.getElementById('cc-rest-prep').value,
      meal: document.getElementById('cc-rest-meal').value,
      tod: document.getElementById('cc-rest-tod').value,
      landing: document.getElementById('cc-rest-landing').value
    };
    localStorage.setItem('crewsync_cc_rest', JSON.stringify(obj));
  } catch(e) {}
}
function _ccRestLoadCache() {
  try {
    var raw = localStorage.getItem('crewsync_cc_rest');
    if (!raw) return;
    var obj = JSON.parse(raw);
    if (obj.ts && Date.now() - obj.ts > 24 * 60 * 60 * 1000) { localStorage.removeItem('crewsync_cc_rest'); return; }
    if (obj.tz) document.getElementById('cc-rest-tz').value = obj.tz;
    if (obj.start) document.getElementById('cc-rest-start').value = obj.start;
    if (obj.handover) document.getElementById('cc-rest-handover').value = obj.handover;
    if (obj.prep) document.getElementById('cc-rest-prep').value = obj.prep;
    if (obj.meal) document.getElementById('cc-rest-meal').value = obj.meal;
    if (obj.tod) document.getElementById('cc-rest-tod').value = obj.tod;
    if (obj.landing) document.getElementById('cc-rest-landing').value = obj.landing;
  } catch(e) {}
}
function _ccRestReset() {
  document.getElementById('cc-rest-tz').value = '8';
  document.getElementById('cc-rest-start').value = '';
  document.getElementById('cc-rest-handover').value = '5';
  document.getElementById('cc-rest-prep').value = '5';
  document.getElementById('cc-rest-meal').value = '0230';
  document.getElementById('cc-rest-tod').value = '';
  document.getElementById('cc-rest-landing').value = '';
  document.getElementById('cc-rest-result').innerHTML = '';
  document.getElementById('cc-rest-result').style.display = 'none';
  localStorage.removeItem('crewsync_cc_rest');
}
// 頁面載入時還原快取
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(_ccRestLoadCache, 500);
});

// 解析 HHMM 或純分鐘格式 → 回傳分鐘數
// "0230" → 150, "30" → 30, "0030" → 30, "130" → 90
function _ccParseDuration(val) {
  var s = (val || '').trim();
  if (!s) return 0;
  var n = parseInt(s);
  if (s.length >= 3) {
    // HHMM: 0230 → 2h30m, 130 → 1h30m
    var hh = Math.floor(n / 100);
    var mm = n % 100;
    return hh * 60 + mm;
  }
  // 純分鐘: 30 → 30
  return n;
}

function _ccTimeToMin(timeStr) {
  var parts = timeStr.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function _ccMinToTime(min) {
  var m = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// 頁面載入時檢查待處理邀請（紅點）
document.addEventListener('DOMContentLoaded', function() {
  var eid = localStorage.getItem('crewsync_eid');
  if (!eid) return;
  fetch('/api/groups/invites?eid=' + encodeURIComponent(eid))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.invites) return;
      var cnt = data.invites.length;
      ['fr-invite-badge', 'grp-manage-badge', 'grp-manage-badge-m'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) { el.style.display = cnt > 0 ? 'inline-flex' : 'none'; el.textContent = cnt > 0 ? cnt : ''; }
      });
    }).catch(function() {});
});
