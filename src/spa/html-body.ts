import { renderCommunityLink } from '../app-changelog.js';

export function getSpaHtmlBody(): string {
  return `
<body>

<div style="text-align:center;padding:6px 12px;font-size:.72em;color:var(--muted);letter-spacing:.3px">
  <span style="font-weight:700;color:var(--text)">CrewSync</span> — JX航空組員班表同步與飛行資訊工具 / JX crew roster sync & flight info tool
</div>

<!-- ══ Tab: 同步 ═════════════════════════════════════════════════════ -->
<div id="tab-sync">

<!-- Roster Subtab Bar -->
<div class="roster-subtabs">
  <div class="subtab-slot"><button class="roster-subtab active" onclick="switchRosterTab('crew',this)"><span class="drag-grip">≡</span>✈️ Crew Sync</button></div>
  <div class="subtab-slot"><button class="roster-subtab" onclick="switchRosterTab('cal',this)"><span class="drag-grip">≡</span>📅 Google Calendar</button></div>
  <div class="subtab-slot"><button class="roster-subtab" onclick="switchRosterTab('roster',this)"><span class="drag-grip">≡</span>📋 Roster</button></div>
  <div class="subtab-slot"><button class="roster-subtab" onclick="switchRosterTab('friends',this)"><span class="drag-grip">≡</span>🤝 Friends<span id="fr-invite-badge" style="display:none;background:#ef4444;color:#fff;font-size:.55em;min-width:14px;height:14px;border-radius:7px;align-items:center;justify-content:center;margin-left:4px;padding:0 3px"></span></button></div>
  <div class="subtab-slot"><button class="roster-subtab" onclick="switchRosterTab('groups',this)"><span class="drag-grip">≡</span>👥 Groups</button></div>
</div>

<!-- ── Crew Sync panel ── -->
<div id="roster-crew" class="roster-panel active">

<!-- ══ Main（含帳號 + 月份，一個畫面搞定）══════════════════════════════ -->
<div id="screen-main" class="screen active">
  <div class="logo">
    <div class="logo-title">CrewSync</div>
    <div class="logo-sub">Crew Roster → Google Calendar</div>
  </div>

  <div class="card">
    <!-- Google auth group -->
    <div class="auth-group">
      <div id="google-badge" class="google-badge" style="padding:0">
        <div class="dot dot-no" id="google-dot"></div>
        <div id="google-badge-text" style="flex:1;color:var(--muted)">尚未授權 Google 日曆 Google Calendar not authorized</div>
        <button class="btn btn-secondary btn-sm" id="google-auth-btn"
          onclick="doGoogleAuth()" style="width:auto;padding:6px 12px;font-size:.82em">授權</button>
      </div>
    </div>
    <div id="cred-error" class="alert alert-error" style="display:none"></div>

    <form id="cred-form" autocomplete="on" onsubmit="submitCredentials(event)">
      <div class="sync-cred-row">
        <div class="field">
          <label>班表帳號 ID</label>
          <input type="text" id="jx-user" name="username"
            autocomplete="username" inputmode="numeric" placeholder="ID" required>
        </div>
        <div class="field">
          <label>班表密碼 Password</label>
          <div class="pw-input-wrap">
            <input type="password" id="jx-pass" name="password"
              autocomplete="current-password" placeholder="Password">
            <button type="button" class="pw-eye-btn" id="pw-eye-btn" onclick="togglePwVisibility()">&#9673;</button>
          </div>
        </div>
      </div>
      <hr class="sep" style="margin:4px 0">
      <div class="sync-month-row">
        <div>
          <div style="font-weight:600;font-size:.9em">同步月份 Select Month</div>
          <div class="month-row">
            <div class="field">
              <label>年 Year</label>
              <select id="sync-year"></select>
            </div>
            <div class="field">
              <label>月 Month</label>
              <select id="sync-month"></select>
            </div>
          </div>
        </div>
        <button type="submit" class="btn btn-primary sync-submit-btn">🚀 開始同步 Start Sync</button>
      </div>
    </form>
    <div style="display:flex;justify-content:center;gap:16px;margin-top:10px">
      <button class="link-btn" onclick="showSettings()">⚙️ 設定 Settings</button>
      <button class="link-btn" onclick="showPrivacy()">🔒 隱私與安全 Privacy & Security</button>
    </div>
  </div>
</div>

<!-- ══ Syncing ════════════════════════════════════════════════════════════ -->
<div id="screen-syncing" class="screen">
  <div class="logo">
    <div class="logo-title">CrewSync</div>
  </div>
  <div class="card">
    <div style="display:flex;align-items:center;gap:12px">
      <div class="spinner"></div>
      <div id="sync-status-text" style="font-size:.9em;color:var(--muted)">正在同步 Syncing...</div>
    </div>
    <div id="sync-log" class="log-box">等待開始 Waiting...</div>
  </div>
</div>

<!-- ══ Done ══════════════════════════════════════════════════════════════ -->
<div id="screen-done" class="screen">
  <div class="logo">
    <div class="logo-title">CrewSync</div>
  </div>
  <div class="card">
    <div id="done-title" style="font-weight:700;font-size:1.1em;text-align:center"></div>
    <div id="done-stats" class="stats"></div>
    <div id="done-log" class="log-box" style="max-height:25vh"></div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-secondary" onclick="showMain()" style="flex:1">← 返回 Back</button>
      <button class="btn btn-secondary" id="copy-log-btn" onclick="copyLog()" style="flex:1">📤 回報給管理員 Report</button>
    </div>
  </div>
</div>

<!-- ══ Settings ══════════════════════════════════════════════════════════ -->
<div id="screen-settings" class="screen">
  <div class="logo">
    <span class="logo-icon">⚙️</span>
    <div class="logo-title">設定 Settings</div>
  </div>
  <div class="card">
    <div style="font-weight:600;font-size:.9em;color:var(--muted)">Google 日曆授權狀態 Authorization Status</div>
    <div id="settings-google-badge" class="google-badge">
      <div class="dot" id="settings-google-dot"></div>
      <div id="settings-google-text" style="flex:1;color:var(--muted)"></div>
    </div>
    <button class="btn btn-secondary btn-sm" onclick="doGoogleAuthFromSettings()">🔄 重新授權 Re-authorize Google Calendar</button>
    <hr class="sep">
    <div id="settings-msg" class="alert" style="display:none"></div>
    <button class="btn btn-danger btn-sm" onclick="clearSavedData()">🗑️ 清除已儲存的資料 Clear Saved Data</button>
    <button class="btn btn-secondary" onclick="showMain()">← 返回 Back</button>
  </div>
</div>

</div><!-- end roster-crew -->

<!-- ── Calendar panel ── -->
<div id="roster-cal" class="roster-panel">
  <div class="gcal-wrap">
    <div class="gcal-main">
      <div class="gcal-header">
        <button class="gcal-today-btn" onclick="gcalToday()">Today</button>
        <div class="gcal-view-bar">
          <button class="gcal-view-btn" data-view="week" onclick="gcalSetView('week')">Week</button>
          <button class="gcal-view-btn active" data-view="month" onclick="gcalSetView('month')">Month</button>
          <button class="gcal-view-btn" data-view="schedule" onclick="gcalSetView('schedule')">Schedule</button>
        </div>
        <select class="gcal-view-select" id="gcal-view-select" onchange="gcalSetView(this.value)">
          <option value="week">Week</option>
          <option value="month" selected>Month</option>
          <option value="schedule">Schedule</option>
        </select>
        <div style="display:flex;align-items:center;gap:4px;margin-left:auto">
          <button class="gcal-nav" onclick="gcalPrev()">◀</button>
          <span class="gcal-title" id="gcal-title" style="min-width:120px;text-align:center"></span>
          <button class="gcal-nav" onclick="gcalNext()">▶</button>
        </div>
      </div>
      <div class="gcal-weekdays" id="gcal-weekdays"></div>
      <div class="gcal-grid" id="gcal-grid"></div>
    </div>
    <div class="gcal-events" id="gcal-events"></div>
  </div>
</div>

<!-- ── Roster panel ── -->
<div id="roster-roster" class="roster-panel">
  <div>
    <!-- Roster header -->
    <div id="rg-header" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--dim)">
      <button onclick="_rgPrevMonth()" style="background:none;border:none;color:var(--muted);font-size:1.2em;cursor:pointer;padding:4px 12px">◀</button>
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
        <span id="rg-month-title" style="font-weight:700;font-size:1em;color:var(--text)"></span>
        <div style="display:flex;gap:4px">
          <button id="rg-view-cal" onclick="_rgSetView('calendar')" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:3px 10px;font-size:.72em;font-weight:600;cursor:pointer">Calendar</button>
          <button id="rg-view-grid" onclick="_rgSetView('grid')" style="background:#2d3748;color:#e2e8f0;border:1px solid #4a5568;border-radius:6px;padding:3px 10px;font-size:.72em;font-weight:600;cursor:pointer">Grid</button>
        </div>
      </div>
      <button onclick="_rgNextMonth()" style="background:none;border:none;color:var(--muted);font-size:1.2em;cursor:pointer;padding:4px 12px">▶</button>
    </div>
    <!-- Roster warning -->
    <div id="rg-sync-hint" style="padding:4px 12px;font-size:.7em;color:#eab308;text-align:center;line-height:1.4">⚠️ 班表不會自動更新<br>Roster does not auto-sync.</div>
    <!-- Roster content -->
    <div id="rg-grid" style="overflow-x:auto;-webkit-overflow-scrolling:touch;padding:0"></div>
    <!-- Flight detail / crew panel -->
    <div id="rg-detail" style="display:none;padding:16px 16px 60px"></div>
  </div>
</div>

<!-- ── Groups panel ── -->
<div id="roster-groups" class="roster-panel">
  <div style="display:flex;flex-direction:column;height:100%">
    <!-- Groups header (固定不捲動，比照 Friends 單行) -->
    <div style="padding:5px 8px;border-bottom:1px solid var(--dim);flex-shrink:0;display:flex;align-items:center;gap:4px;white-space:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch">
        <span onclick="_frShowInfo()" style="cursor:pointer;font-size:.85em;color:var(--accent);flex-shrink:0" title="分享說明">ⓘ</span>
        <!-- 身分/機隊/職級 -->
        <span id="grp-fleet-hint" style="flex-shrink:0;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.25);border-radius:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">
          <select id="grp-my-role" onchange="_grpSyncRole()" style="background:#1e3a5f;color:#93c5fd;border:1px solid rgba(59,130,246,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
            <option value="" disabled selected>身分</option><option value="fc">Flight Crew</option><option value="cc">Cabin Crew</option>
          </select>
          <select id="grp-my-fleet" onchange="_grpSyncFleetRank()" style="background:#1e3a5f;color:#93c5fd;border:1px solid rgba(59,130,246,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
            <option value="" disabled selected>機隊</option><option value="A321">A321</option><option value="A330">A330</option><option value="A350">A350</option>
          </select>
          <select id="grp-my-rank" onchange="_grpSyncFleetRank()" style="background:#1e3a5f;color:#93c5fd;border:1px solid rgba(59,130,246,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
            <option value="" disabled selected>職級</option>
          </select>
        </span>
        <!-- 名稱 -->
        <span id="grp-name-wrap" style="flex-shrink:0;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">
          <span style="font-size:.5em;color:#86efac">名稱<br>Name</span>
          <input id="grp-my-name" type="text" placeholder="可修改 editable" onchange="_grpSyncName()" style="background:#1a3a2a;color:#86efac;border:1px solid rgba(34,197,94,.3);border-radius:4px;padding:2px 4px;font-size:.72em;width:100px">
          <span onclick="_frShowNameInfo()" style="cursor:pointer;font-size:.85em;color:rgba(34,197,94,.6);flex-shrink:0" title="名稱說明">ⓘ</span>
        </span>
        <!-- 群組下拉 + 已加入標籤 -->
        <select id="grp-preset-select" onchange="_grpJoinFromSelect(this)" style="flex-shrink:0;background:#1e3a5f;color:#93c5fd;border:1px solid rgba(59,130,246,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto;max-width:120px">
          <option value="">+ 加入群組</option>
        </select>
        <span id="grp-preset-tags" style="display:inline-flex;align-items:center;gap:3px"></span>
    </div>
    <!-- Groups month nav + filter (固定不捲動) -->
    <div style="display:flex;align-items:center;padding:5px 8px;border-bottom:1px solid var(--dim);gap:6px;flex-shrink:0">
      <span style="flex:1"></span>
      <button onclick="_grpPrevMonth()" style="background:none;border:none;color:var(--muted);font-size:1.1em;cursor:pointer;padding:0 4px">◀</button>
      <span id="grp-month-title" style="font-weight:700;font-size:1.1em;color:var(--text);min-width:100px;text-align:center"></span>
      <button onclick="_grpNextMonth()" style="background:none;border:none;color:var(--muted);font-size:1.1em;cursor:pointer;padding:0 4px">▶</button>
      <span style="flex:1"></span>
      <span style="flex-shrink:0;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);border-radius:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">
        <span style="font-size:.52em;color:#c084fc;line-height:1.2">查看<br>View</span>
        <select id="grp-view-filter" onchange="_grpLoadGrid()" style="background:#2d1f4e;color:#d8b4fe;border:1px solid rgba(168,85,247,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
          <option value="all">全部 All</option>
        </select>
        <select id="grp-filter-role" onchange="_grpOnFilterRole()" style="background:#2d1f4e;color:#d8b4fe;border:1px solid rgba(168,85,247,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
          <option value="">All</option><option value="fc">FC</option><option value="cc">CC</option>
        </select>
        <select id="grp-filter-fleet" onchange="_grpLoadGrid()" style="background:#2d1f4e;color:#d8b4fe;border:1px solid rgba(168,85,247,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
          <option value="">All</option><option value="A321">A321</option><option value="A330">A330</option><option value="A350">A350</option>
        </select>
        <select id="grp-filter-rank" onchange="_grpLoadGrid()" style="background:#2d1f4e;color:#d8b4fe;border:1px solid rgba(168,85,247,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
          <option value="">All</option>
        </select>
      </span>
    </div>
    <div id="grp-grid" style="padding:0;flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch"></div>
  </div>
</div>

<!-- ── Friends panel ── -->
<div id="roster-friends" class="roster-panel">
  <div style="display:flex;flex-direction:column;height:100%">
    <!-- Friends header: desktop 一行 / mobile portrait 兩行 -->
    <div class="fr-header">
      <!-- Row 1: ⓘ + 機隊 + 名稱（手機可左右滑） -->
      <div class="fr-header-row1">
        <span onclick="_frShowInfo()" style="cursor:pointer;font-size:.85em;color:var(--accent);flex-shrink:0" title="分享說明">ⓘ</span>
        <!-- 區塊1: 身分/機隊/職級 (淡藍) -->
        <span id="fr-share-hint" style="flex-shrink:0;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.25);border-radius:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">
          <select id="fr-my-role" onchange="_frSyncRole()" style="background:#1e3a5f;color:#93c5fd;border:1px solid rgba(59,130,246,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
            <option value="" disabled selected>身分</option><option value="fc">Flight Crew</option><option value="cc">Cabin Crew</option>
          </select>
          <select id="fr-my-fleet" onchange="_frCheckReady()" style="background:#1e3a5f;color:#93c5fd;border:1px solid rgba(59,130,246,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
            <option value="" disabled selected>機隊</option><option value="A321">A321</option><option value="A330">A330</option><option value="A350">A350</option>
          </select>
          <select id="fr-my-rank" onchange="_frCheckReady()" style="background:#1e3a5f;color:#93c5fd;border:1px solid rgba(59,130,246,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
            <option value="" disabled selected>職級</option>
          </select>
        </span>
        <!-- 區塊2: 名字 (淡綠) -->
        <span id="fr-name-wrap" style="flex-shrink:0;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:6px;padding:2px 6px;margin-left:12px;display:inline-flex;align-items:center;gap:4px">
          <span style="font-size:.5em;color:#86efac">名稱<br>Name</span>
          <input id="fr-my-name" type="text" placeholder="可修改 editable" onchange="_frCheckReady()" style="background:#1a3a2a;color:#86efac;border:1px solid rgba(34,197,94,.3);border-radius:4px;padding:2px 4px;font-size:.72em;width:100px">
          <span onclick="_frShowNameInfo()" style="cursor:pointer;font-size:.85em;color:rgba(34,197,94,.6);flex-shrink:0" title="名稱說明">ⓘ</span>
        </span>
        <!-- desktop: 月份+篩選接在同一行 -->
        <span class="fr-header-row2-inline" style="flex:1"></span>
        <button class="fr-header-row2-inline" onclick="_frPrevMonth()" style="background:none;border:none;color:var(--muted);font-size:1.1em;cursor:pointer;padding:0 4px;flex-shrink:0">◀</button>
        <span class="fr-header-row2-inline" id="fr-month-title" style="font-weight:700;font-size:1em;color:var(--text);flex-shrink:0;min-width:80px;text-align:center"></span>
        <button class="fr-header-row2-inline" onclick="_frNextMonth()" style="background:none;border:none;color:var(--muted);font-size:1.1em;cursor:pointer;padding:0 4px;flex-shrink:0">▶</button>
        <span class="fr-header-row2-inline" style="flex:2"></span>
        <span class="fr-header-row2-inline" style="flex-shrink:0;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);border-radius:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">
          <span style="font-size:.52em;color:#c084fc;line-height:1.2">查看<br>View</span>
          <select id="fr-filter-group" onchange="_frLoadMonth()" style="background:#2d1f4e;color:#d8b4fe;border:1px solid rgba(168,85,247,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
            <option value="none">尚無好友圈</option>
          </select>
        </span>
        <button class="fr-header-row2-inline" onclick="_grpShowManage()" style="flex-shrink:0;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);border-radius:8px;padding:4px 12px;font-size:.82em;color:#fbbf24;cursor:pointer;position:relative;font-weight:600">⚙ 好友圈<span id="grp-manage-badge" style="display:none;position:absolute;top:-5px;right:-5px;background:#ef4444;color:#fff;font-size:.6em;min-width:16px;height:16px;border-radius:8px;align-items:center;justify-content:center;padding:0 3px"></span></button>
      </div>
      <!-- Row 2: 月份+篩選（僅手機直拿顯示） -->
      <div class="fr-header-row2">
        <span style="flex:1"></span>
        <button onclick="_frPrevMonth()" style="background:none;border:none;color:var(--muted);font-size:1.1em;cursor:pointer;padding:0 4px;flex-shrink:0">◀</button>
        <span id="fr-month-title-m" style="font-weight:700;font-size:1em;color:var(--text);flex-shrink:0;min-width:80px;text-align:center"></span>
        <button onclick="_frNextMonth()" style="background:none;border:none;color:var(--muted);font-size:1.1em;cursor:pointer;padding:0 4px;flex-shrink:0">▶</button>
        <span style="flex:1"></span>
        <span style="flex-shrink:0;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);border-radius:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">
          <span style="font-size:.52em;color:#c084fc;line-height:1.2">查看<br>View</span>
          <select id="fr-filter-group-m" onchange="document.getElementById('fr-filter-group').value=this.value;_frLoadMonth()" style="background:#2d1f4e;color:#d8b4fe;border:1px solid rgba(168,85,247,.3);border-radius:4px;padding:2px 4px;font-size:.72em;cursor:pointer;width:auto">
            <option value="none">尚無好友圈</option>
          </select>
        </span>
        <button onclick="_grpShowManage()" style="flex-shrink:0;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);border-radius:8px;padding:4px 12px;font-size:.82em;color:#fbbf24;cursor:pointer;position:relative;font-weight:600">⚙ 好友圈<span id="grp-manage-badge-m" style="display:none;position:absolute;top:-5px;right:-5px;background:#ef4444;color:#fff;font-size:.6em;min-width:16px;height:16px;border-radius:8px;align-items:center;justify-content:center;padding:0 3px"></span></button>
      </div>
    </div>
    <style>#fr-share-toggle:checked+span{background:var(--accent)!important}#fr-share-toggle:checked~#fr-share-dot{transform:translateX(16px)}</style>
    <!-- Friends grid -->
    <div id="fr-grid" style="padding:0;flex:1;min-height:0"></div>
  </div>
</div>

<!-- Friends info overlay (tab-sync 層級) -->
    <div id="fr-info-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:9000;align-items:center;justify-content:center" onclick="if(event.target===this)this.style.display='none'">
      <div style="background:var(--card);border-radius:12px;padding:20px 24px;max-width:400px;margin:20px;line-height:1.6;max-height:80vh;overflow-y:auto">
        <div style="font-size:1em;font-weight:700;margin-bottom:12px;text-align:center">👥 Groups 群組分享</div>
        <div style="font-size:.78em;color:var(--muted)">
          <div style="margin-bottom:6px">• 開啟分享後，你的班表將僅對你所加入的群組成員可見<br><span style="opacity:.7">When sharing is enabled, your roster is only visible to members of groups you have joined</span></div>
          <div style="margin-bottom:6px">• 未加入任何群組的人無法看到你的班表<br><span style="opacity:.7">No one outside your groups can see your roster</span></div>
          <div style="margin-bottom:6px">• 你的班表將上傳至雲端供群組成員查看<br><span style="opacity:.7">Your roster will be uploaded for group members to view</span></div>
          <div style="margin-bottom:6px">• 關閉分享後，雲端資料將立即刪除<br><span style="opacity:.7">Turn off sharing — cloud data deleted immediately</span></div>
          <div>• 離線快取保留一個月，一個月內未連網更新亦會自動刪除<br><span style="opacity:.7">Offline cache expires after 1 month — auto-deleted if not refreshed</span></div>
        </div>
        <button onclick="document.getElementById('fr-info-overlay').style.display='none'" style="margin-top:14px;width:100%;padding:8px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:.85em;cursor:pointer">了解 Got it</button>
      </div>
    </div>
    <!-- 名字說明彈窗 -->
    <div id="fr-name-info-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:9000;align-items:center;justify-content:center" onclick="if(event.target===this)this.style.display='none'">
      <div style="background:var(--card);border-radius:12px;padding:20px 24px;max-width:360px;margin:20px;line-height:1.6;max-height:80vh;overflow-y:auto">
        <div style="font-size:1em;font-weight:700;margin-bottom:12px;text-align:center">✏️ 顯示名稱說明</div>
        <div style="font-size:.78em;color:var(--muted)">
          <div style="margin-bottom:6px">• 可改中文或暱稱，方便同事辨認<br><span style="opacity:.7">Chinese name or nickname OK for easy recognition</span></div>
          <div style="margin-bottom:6px">• 不改則預設顯示班表系統英文拼音<br><span style="opacity:.7">Default: English name from roster system</span></div>
          <div style="margin-bottom:6px">• 大頭照同步自 Google 帳號<br><span style="opacity:.7">Avatar synced from Google account</span></div>
          <div>• 點按大頭照可顯示完整全名<br><span style="opacity:.7">Tap avatar to view full name</span></div>
        </div>
        <button onclick="document.getElementById('fr-name-info-overlay').style.display='none'" style="margin-top:14px;width:100%;padding:8px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:.85em;cursor:pointer">了解 Got it</button>
      </div>
    </div>

<!-- Groups 管理彈窗 -->
<div id="grp-manage-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:9000;align-items:center;justify-content:center" onclick="if(event.target===this)_grpCloseManage()">
  <div style="background:var(--bg,#0a0e1a);border-radius:14px;padding:16px;width:90vw;max-width:400px;max-height:80vh;overflow-y:auto;-webkit-overflow-scrolling:touch">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-weight:700;font-size:1em;color:var(--text)">🤝 好友圈管理 Friends</span>
      <button onclick="_grpCloseManage()" style="background:none;border:none;color:var(--muted);font-size:1.3em;cursor:pointer">✕</button>
    </div>
    <div style="font-size:.75em;color:var(--muted);line-height:1.5;margin-bottom:12px;padding:8px;background:rgba(59,130,246,.06);border-radius:8px">
      <div><span onclick="_frShowInfo()" style="cursor:pointer;color:var(--accent)">ⓘ</span> 加入好友圈或建立好友圈即代表同意將班表分享給<b style="color:var(--text)">該好友圈</b>成員</div>
      <div style="opacity:.7">Joining or creating a friend group means you agree to share your roster with <b>that group's</b> members</div>
    </div>
    <div id="grp-friends-content"></div>
  </div>
</div>

</div><!-- end tab-sync -->

<!-- ══ Tab: A350簡報箱 ══════════════════════════════════════════════ -->
<div id="tab-briefing" class="tab-active">

  <!-- 子 Tab Bar -->
  <div class="briefing-subtabs">
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-brief" onclick="switchBriefingTab('brief',this)"><span class="drag-grip">≡</span>📋 Briefing</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-pa" onclick="switchBriefingTab('pa',this)"><span class="drag-grip">≡</span>🎙️ PA</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-crewrest" onclick="switchBriefingTab('crewrest',this)"><span class="drag-grip">≡</span>⏳ Rest Calc</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-overtime" onclick="switchBriefingTab('overtime',this)"><span class="drag-grip">≡</span>💰 Overtime</button></div>
    <div class="subtab-wx-wrap">
      <button class="briefing-subtab active" id="subtabBtn-datis" onclick="switchBriefingTab('datis',this)"><span class="drag-grip">≡</span>⛅ WX <select class="wx-fleet-inline" id="wx-fleet-select"
        onclick="event.stopPropagation()"
        onfocus="this._prev=this.value;this.selectedIndex=0"
        onchange="wxSwitchFleet(this);switchBriefingTab('datis',document.getElementById('subtabBtn-datis'))"
        onblur="if(this.value===''){this.value=this._prev||'A350-900'}">
        <option value="" style="display:none">機型</option>
        <option value="A321">A21N</option>
        <option value="A330">A339</option>
        <option value="A350-900" selected>A359</option>
        <option value="A350-1000">A35K</option>
      </select></button>
    </div>
    <div class="subtab-slot" style="display:none"><button class="briefing-subtab" id="subtabBtn-live" onclick="switchBriefingTab('live',this)"><span class="drag-grip">≡</span>📡 Live</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-coldtemp" onclick="switchBriefingTab('coldtemp',this)"><span class="drag-grip">≡</span>❄️ Cold Temp</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-tools" onclick="switchBriefingTab('tools',this)"><span class="drag-grip">≡</span>🗺️ Tools</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-duty" onclick="switchBriefingTab('duty',this)"><span class="drag-grip">≡</span>⏱️ Duty Time</button></div>
  </div>

  <!-- ── 📋 提示 panel ── -->
  <div id="briefing-brief" class="briefing-panel">
    <div class="brief-search">
      <input type="text" id="brief-fno" placeholder="JX801" oninput="_briefOnInput(this.value);_syncFltNo('brief',this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();_briefForceQuery()}">
      <div style="display:inline-flex;align-items:center;gap:2px;margin:0 4px">
        <button onclick="_briefDateNav(-1)" style="padding:4px 6px;font-size:.75em;border:none;cursor:pointer;background:#2d3748;color:#e2e8f0;border-radius:6px">◀</button>
        <span id="brief-date-label" style="font-size:.75em;min-width:40px;text-align:center;color:#e2e8f0"></span>
        <button onclick="_briefDateNav(1)" style="padding:4px 6px;font-size:.75em;border:none;cursor:pointer;background:#2d3748;color:#e2e8f0;border-radius:6px">▶</button>
      </div>
      <button class="brief-search-btn" onclick="_briefForceQuery()">查詢 Query</button>
      <span id="brief-flt-status" class="pa-flt-status"></span>
      <button style="background:#2d3748;color:#e2e8f0;border:1px solid #4a5568;border-radius:8px;padding:4px 10px;font-size:.8em;cursor:pointer" onclick="openTurbli(true)">🌪️ Turbli</button>
      <button style="background:#2d3748;color:#e2e8f0;border:1px solid #4a5568;border-radius:8px;padding:4px 10px;font-size:.8em;cursor:pointer" onclick="_briefOpenHistory()">📅 History</button>
      <span id="brief-save-dot" class="brief-save-dot" title=""></span>
      <button class="pa-reset-btn" onclick="briefClearAll()">重設 Reset</button>
    </div>
    <div id="brief-sync-hint" style="font-size:.68em;color:var(--muted);padding:4px 2px;opacity:.75"></div>

    <!-- Briefing 歷史 modal（月曆式） -->
    <!-- Briefing Room 平面圖 modal (PWA 也能關) -->
    <div id="brief-room-wrap" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:300;align-items:center;justify-content:center;overflow:auto;padding:env(safe-area-inset-top) 10px env(safe-area-inset-bottom)" onclick="if(event.target===this)_closeBriefRoom()">
      <button onclick="_closeBriefRoom()" style="position:fixed;top:calc(env(safe-area-inset-top) + 10px);right:14px;width:44px;height:44px;border-radius:50%;border:none;background:rgba(255,255,255,.18);color:#fff;font-size:1.3em;cursor:pointer;z-index:301;line-height:1;display:flex;align-items:center;justify-content:center">✕</button>
      <img id="brief-room-img" alt="Briefing Room 平面圖" style="max-width:100%;max-height:100%;object-fit:contain;touch-action:pinch-zoom;user-select:none">
    </div>

    <div id="brief-hist-wrap" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;align-items:flex-start;justify-content:center;padding:40px 10px;overflow-y:auto" onclick="if(event.target===this)_briefCloseHistory()">
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;max-width:480px;width:100%;padding:16px;color:var(--text)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h3 style="margin:0;font-size:1em">📅 Briefing History</h3>
          <button onclick="_briefCloseHistory()" style="background:none;border:none;color:var(--muted);font-size:1.2em;cursor:pointer">✕</button>
        </div>
        <div id="brief-hist-hint" style="font-size:.72em;color:var(--muted);margin-bottom:10px"></div>
        <!-- 月份 header -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0">
          <button id="brief-hist-prev" style="background:none;border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:6px;cursor:pointer">◀</button>
          <div id="brief-hist-title" style="font-weight:700"></div>
          <button id="brief-hist-next" style="background:none;border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:6px;cursor:pointer">▶</button>
        </div>
        <!-- 月曆 grid（日期格子內直接顯示航班號+起訖地） -->
        <div id="brief-hist-cal" style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px"></div>
      </div>
    </div>
    <style>
      .bhc-dow { text-align:center;font-size:.72em;color:var(--muted);padding:4px 0 }
      /* 固定 4 行高：date / flight_no / route / more。所有格子一樣大 */
      .bhc-day {
        padding:3px 2px;border-radius:6px;background:rgba(255,255,255,.03);color:var(--muted);
        display:grid;grid-template-rows:12px 14px 14px 12px;gap:0;text-align:center;overflow:hidden;
      }
      .bhc-day.empty { background:transparent }
      .bhc-day.has-data { background:rgba(244,196,48,.18);color:var(--text);cursor:pointer }
      .bhc-day.has-data:active { opacity:.7 }
      .bhc-day.today { outline:2px solid var(--accent) }
      .bhc-date { font-size:.75em;font-weight:600;line-height:1;text-align:right;padding-right:3px;color:var(--muted) }
      .bhc-day.has-data .bhc-date { color:var(--accent) }
      .bhc-fno { font-size:.68em;font-weight:700;color:var(--accent);line-height:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .bhc-route { font-size:.66em;color:var(--text);line-height:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .bhc-more { font-size:.6em;color:var(--muted);line-height:1 }
    </style>

    <div class="brief-section">
      <div class="brief-section-header"><span>FLIGHT INFO / DATA <span style="font-size:.75em;color:var(--muted);font-weight:400;opacity:.8">auto-filled · editable</span> <a href="/briefing-room" onclick="event.preventDefault();_openBriefRoom()" style="font-size:.78em;color:#60a5fa;text-decoration:underline;font-weight:400;margin-left:8px">🗺️ Briefing Room</a> <input type="text" id="brief-room" maxlength="4" placeholder="eg. ONT" style="width:98px;padding:3px 8px;font-size:.82em;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:4px;color:var(--text);margin-left:4px;text-transform:uppercase;font-weight:400"></span><button class="brief-clear-btn" onclick="briefClearInfo()">清除 Clear</button></div>
      <div class="brief-grid">
        <div class="brief-field"><label>Dep Date/Time</label><div id="brief-dep-dt" class="brief-auto-val" contenteditable="true">—</div></div>
        <div class="brief-field"><label>TPE Gate</label><input type="text" id="brief-gate" placeholder="—"></div>
        <div class="brief-field"><label>Origin</label><input type="text" id="brief-origin" placeholder="IATA" oninput="_briefWxRefresh('owx',this.value)"></div>
        <div class="brief-field"><label>Orig WX</label><div id="brief-owx" class="brief-wx-val">—</div></div>
        <div class="brief-field"><label>Dest.</label><input type="text" id="brief-dest" placeholder="IATA" oninput="_briefWxRefresh('dwx',this.value)"></div>
        <div class="brief-field"><label>Dest. WX</label><div id="brief-dwx" class="brief-wx-val">—</div></div>
        <div class="brief-field"><label>Cruise Altitude</label><input type="text" id="brief-ofp" placeholder="manual input"></div>
        <div class="brief-field"><label>Flight Time</label><input type="text" id="brief-ft" placeholder="manual input"></div>
      </div>
      <div id="brief-ot-warn" style="display:none;align-items:center;gap:8px;margin-top:8px;padding:8px 10px;background:rgba(251,191,36,.12);border:1px solid #fbbf24;border-radius:8px;font-size:.82em;color:var(--text)"></div>
    </div>

    <div class="brief-section">
      <div class="brief-section-header"><span>NOTES / BRIEFING</span><button class="brief-clear-btn" onclick="briefClearNotes()">清除 Clear</button></div>
      <div class="brief-note-row brief-note-stack"><div class="brief-note-label">🌪️ Turbulence</div><textarea class="brief-note" id="brief-note1" rows="2" placeholder="亂流時間/其他提醒" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea></div>
      <div class="brief-note-row brief-note-stack"><div class="brief-note-label">🛩️ Tail No. / MEL</div><textarea class="brief-note" id="brief-note2" rows="2" placeholder="Tail / MEL" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea></div>
      <div class="brief-note-row brief-note-stack"><div class="brief-note-label">💧 Min Water</div><textarea class="brief-note" id="brief-water" rows="2" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea></div>
      <div class="brief-note-row brief-note-stack"><div class="brief-note-label">⛽ Fuel Required</div><textarea class="brief-note" id="brief-fuel" rows="2" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea></div>
      <div class="brief-note-row brief-pob-row">
        <span class="brief-note-icon">👥</span>
        <div class="brief-pob">
          <span class="brief-pob-label">Crew</span>
          <input type="number" id="brief-crew" min="0" class="brief-pob-input" oninput="_briefUpdatePob()">
          <span class="brief-pob-sep">+</span>
          <span class="brief-pob-label">Pax</span>
          <input type="number" id="brief-pax" min="0" class="brief-pob-input" oninput="_briefUpdatePob()">
          <span class="brief-pob-sep">=</span>
          <span class="brief-pob-label">POB</span>
          <span id="brief-pob" class="brief-pob-value">—</span>
        </div>
      </div>
    </div>
  </div>

  <!-- ── ⏳ 輪休計算 panel ── -->
  <div id="briefing-crewrest" class="briefing-panel">
    <div class="cr-wrap">
      <div class="cr-header">
        <span style="font-weight:700;font-size:1.05em">⏳ 輪休計算 Crew Rest</span>
        <button class="pa-reset-btn" onclick="crewrestReset()">重設 Reset</button>
      </div>

      <div class="cr-input-row">
        <div class="cr-input-group">
          <label>飛行時間 Flight Time</label>
          <div style="display:flex;align-items:center;gap:4px">
            <input type="number" id="cr-fh" class="cr-input" placeholder="HH" min="0" max="24" inputmode="numeric" oninput="crewrestCalc();if(String(this.value).length>=2)document.getElementById('cr-fm').focus()" onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('cr-fm').focus()}">
            <span>:</span>
            <input type="number" id="cr-fm" class="cr-input" placeholder="MM" min="0" max="59" inputmode="numeric" oninput="crewrestCalc();if(String(this.value).length>=2){var s=document.getElementById('cr-start');if(s)s.focus()}" onkeydown="if(event.key==='Enter'){event.preventDefault();var s=document.getElementById('cr-start');if(s)s.focus()}">
          </div>
        </div>
        <div class="cr-input-group">
          <label>組員人數 Crew</label>
          <select id="cr-crew" class="cr-select" onchange="_crOnCrewChange();crewrestCalc()">
            <option value="3">3P</option>
            <option value="4" selected>4P</option>
          </select>
        </div>
        <div class="cr-result-box" id="cr-result" style="display:none">
          <div style="font-size:.72em;color:var(--accent)">建議每人休時 Per Person</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="cr-result-time" id="cr-result-time">—</span>
            <button class="cr-apply-btn" onclick="crewrestApply()">Apply</button>
          </div>
        </div>
        <div class="cr-result-box" id="cr-manual-wrap" style="display:none">
          <div style="font-size:.72em;color:var(--muted)">或手動輸入 Manual Input</div>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="text" id="cr-manual-rest" class="cr-start-input" placeholder="H:MM" maxlength="5" style="width:60px;font-size:1.1em;font-weight:700">
            <button class="cr-apply-btn" onclick="crewrestApplyManual()">Apply</button>
          </div>
        </div>
      </div>

      <div id="cr-mode-wrap" class="cr-mode-wrap">
        <label class="cr-mode-label"><input type="radio" name="cr-mode" value="group" checked onchange="_crModeChange()"> CM1/CM2 個別計算 Individual</label>
        <label class="cr-mode-label"><input type="radio" name="cr-mode" value="cross" onchange="_crModeChange()"> Ops Crew 休一段 Single Rest</label>
      </div>

      <div id="cr-schedule">
        <!-- 由 JS 動態產生 -->
      </div>
    </div>
  </div>

  <!-- ── 工具連結 panel ── -->
  <div id="briefing-tools" class="briefing-panel">
    <div class="briefing-section">
      <div class="tool-grid">
        <a class="tool-link-btn" href="https://flight-plan-editor.weathernews.com/flight_plan_editor/#login" target="_blank">☁️ Weathernews Flight Plan</a>
        <a class="tool-link-btn" href="https://pilotstarspace.starlux-airlines.com/#/" target="_blank">🌟 SJX Pilot Space</a>
        <a class="tool-link-btn" href="https://elb.starlux-airlines.com/elb/#/dashboard/fleet" target="_blank">🧰 STARLUX ELB Fleet</a>
        <a class="tool-link-btn" href="https://tono2.net" target="_blank" onclick="return loadTool(event,this)">🇯🇵 Tono2 航空氣象</a>
        <a class="tool-link-btn" href="https://sjx.lido.aero/lido/las/login.jsp?DESMON_RESULT_PAGE=https://sjx.lido.aero/briefing&DESMON_CODE=LAS_001&DESMON_LANG=null" target="_blank">📋 LIDO Briefing</a>
        <a class="tool-link-btn" href="https://www.skyinfo.jp" target="_blank" onclick="return loadTool(event,this)">🇯🇵 日本NOTAM地圖</a>
        <a class="tool-link-btn" href="https://app.cwa.gov.tw/web/obsmap/typhoon.html" target="_blank" onclick="return loadTool(event,this)">🌀 颱風路徑圖</a>
        <a class="tool-link-btn" href="https://gpsjam.org/" target="_blank" onclick="return loadTool(event,this)">🛰️ GPS干擾區域</a>
        <a class="tool-link-btn" href="https://turbli.com/" target="_blank">🌪️ Turbli 亂流預報</a>
        <a class="tool-link-btn" href="https://radio.arinc.net/pacific/" target="_blank">📻 Pacific HF</a>
      </div>
      <!-- 嵌入工具：全螢幕浮層（固定覆蓋，不再把分頁往上推/卡住捲不回；關閉鈕永遠在頂） -->
      <div id="tool-frame-wrap" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:600;background:var(--bg);flex-direction:column;padding-top:env(safe-area-inset-top)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dim);flex-shrink:0">
          <span id="tool-frame-title" style="font-weight:700;font-size:.9em;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
          <div style="display:flex;gap:12px;align-items:center;flex-shrink:0">
            <a id="tool-frame-external" href="#" target="_blank" style="font-size:.8em;color:var(--accent);text-decoration:none">↗ 新分頁</a>
            <button onclick="closeTool()" style="background:none;border:none;color:var(--text);font-size:1.3em;cursor:pointer;padding:0 4px">✕</button>
          </div>
        </div>
        <iframe id="tool-frame" src="" style="flex:1;width:100%;border:none;background:var(--surface)"></iframe>
      </div>
    </div>
  </div>

  <!-- ── 📡 Live Radar panel ── -->
  <div id="briefing-live" class="briefing-panel">
    <div id="live-portrait-overlay" class="live-portrait-overlay" style="display:none">
      <div style="font-size:2.5em;margin-bottom:12px">📱↔️</div>
      <div style="font-weight:700;font-size:1.05em;margin-bottom:6px">請橫拿手機</div>
      <div style="color:var(--muted);font-size:.82em">Please rotate to landscape</div>
    </div>
    <div id="live-map"></div>
    <button id="live-sidebar-toggle" class="live-toggle-btn" onclick="liveToggleSidebar()">☰</button>
    <div id="live-sidebar" class="live-sidebar live-sidebar-left">
      <!-- header -->
      <div class="live-sb-header">
        <div id="live-count" style="font-weight:700;font-size:.8em"></div>
        <div style="display:flex;gap:6px">
          <button class="live-sb-pos-btn" onclick="liveSwitchSidebarPos()" title="Switch side">⇄</button>
          <button class="live-sb-close-btn" onclick="liveToggleSidebar()" title="Close">✕</button>
        </div>
      </div>
      <!-- airline quick filter -->
      <div class="live-sb-section">
        <div class="live-airline-row">
          <label class="live-cb-label"><input type="checkbox" id="live-f-jx" checked onchange="liveApplyFilter()"><span>JX</span></label>
          <label class="live-cb-label"><input type="checkbox" id="live-f-br" onchange="liveApplyFilter()"><span>BR</span></label>
          <label class="live-cb-label"><input type="checkbox" id="live-f-ci" onchange="liveApplyFilter()"><span>CI</span></label>
        </div>
        <label class="live-cb-label" style="margin-top:4px"><input type="checkbox" id="live-f-all" onchange="liveToggleAll()"><span>All flights</span></label>
        <div style="font-size:.65em;color:#f5a623;margin-top:1px;line-height:1.2;padding-left:21px">⚠ 顯示可視範圍，上限 500</div>
      </div>
      <!-- custom prefix / flight search + labels -->
      <div class="live-sb-section" style="display:flex;align-items:center;gap:6px">
        <div style="font-size:.7em;color:var(--muted);white-space:nowrap">Search</div>
        <input type="text" id="live-f-custom" class="live-custom-input" placeholder="JX / JX800" onchange="liveApplyFilter()" onkeydown="if(event.key==='Enter')liveSearchFlight()" style="width:72px;flex:none">
        <label class="live-cb-label" style="margin-left:auto"><input type="checkbox" id="live-f-labels" onchange="liveToggleLabels()"><span>Labels</span></label>
      </div>
      <div id="live-search-msg" style="font-size:.6em;color:#f87171;min-height:.8em;line-height:1.2"></div>
      <!-- jump to airport -->
      <div class="live-sb-section" style="display:flex;align-items:center;gap:4px">
        <select id="live-jump" class="live-jump-select" style="flex:1;min-width:0" onchange="liveJumpTo()">
          <option value="">Jump to</option>
          <option value="25.08,121.23,8">TPE</option>
          <option value="22.57,120.35,10">KHH</option>
          <option value="35.76,140.39,8">NRT</option>
          <option value="34.43,135.24,10">KIX</option>
          <option value="42.77,141.69,10">CTS</option>
          <option value="22.31,113.91,10">HKG</option>
          <option value="1.36,103.99,10">SIN</option>
          <option value="13.69,100.75,10">BKK</option>
          <option value="33.94,-118.41,8">LAX</option>
          <option value="37.62,-122.38,10">SFO</option>
          <option value="47.45,-122.31,10">SEA</option>
          <option value="33.43,-112.01,10">PHX</option>
          <option value="25.0,121.5,5">Asia</option>
          <option value="40.0,-100.0,4">USA</option>
          <option value="50.0,10.0,4">Europe</option>
          <option value="0,0,2">World</option>
        </select>
        <input type="text" id="live-jump-input" class="live-custom-input" placeholder="ICAO" style="width:56px;flex:none" onkeydown="if(event.key==='Enter')liveJumpToIcao()">
        <button class="live-sb-pos-btn" onclick="liveJumpToIcao()" style="padding:4px 6px;font-size:.72em">Go</button>
      </div>
      <!-- refresh -->
      <button id="live-refresh-btn" class="live-refresh-btn" onclick="liveManualRefresh()">↻ Refresh</button>
      <!-- status -->
      <div id="live-status" style="font-size:.6em;margin-top:6px;line-height:1.3"></div>
      <div style="font-size:.6em;margin-top:2px;color:var(--muted)">僅即時位置，無起訖地資訊及ETA</div>
      <div style="font-size:.55em;margin-top:2px;color:var(--muted);opacity:.6">額度每日 UTC 00:00 重置</div>
      <!-- flight list -->
      <div class="live-list-header">Flights</div>
      <div id="live-flight-list" class="live-flight-list"></div>
    </div>
  </div>

  <!-- ── 🌡️ Cold Temperature Altitude Correction panel ── -->
  <div id="briefing-coldtemp" class="briefing-panel">
    <div class="ct-panel">
      <div class="ct-form">
        <!-- 機場標高 + OAT -->
        <div class="ct-inputs">
          <div class="ct-input-group">
            <label>Airport Elevation (ft)</label>
            <input type="text" id="ct-elev" placeholder="e.g. 108" inputmode="text">
          </div>
          <div class="ct-input-group">
            <label>OAT (°C)</label>
            <input type="text" id="ct-oat" placeholder="e.g. −20" inputmode="text">
          </div>
          <button class="pa-reset-btn" onclick="ctReset()" style="margin-bottom:1px">重設 Reset</button>
        </div>
        <!-- 高度輸入卡片格 -->
        <div class="ct-grid">
          <div class="ct-card">
            <div class="ct-card-label">FAF</div>
            <input class="ct-card-input" type="number" id="ct-a0" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r0">—</div>
          </div>
          <div class="ct-card">
            <div class="ct-card-label">DA / MDA</div>
            <input class="ct-card-input" type="number" id="ct-a1" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r1">—</div>
          </div>
          <div class="ct-card">
            <div class="ct-card-label">Missed Apch</div>
            <input class="ct-card-input" type="number" id="ct-a2" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r2">—</div>
          </div>
          <div class="ct-card">
            <div class="ct-card-label">FPA</div>
            <input class="ct-card-input" type="number" id="ct-a3" inputmode="decimal" placeholder="°" step="0.01">
            <div class="ct-card-result empty" id="ct-r3">—</div>
          </div>
          <div class="ct-card">
            <input class="ct-label-inp" type="text" id="ct-l4" placeholder="自訂 / Custom (optional)">
            <input class="ct-card-input" type="number" id="ct-a4" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r4">—</div>
          </div>
          <div class="ct-card">
            <input class="ct-label-inp" type="text" id="ct-l5" placeholder="自訂 / Custom (optional)">
            <input class="ct-card-input" type="number" id="ct-a5" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r5">—</div>
          </div>
        </div>
        <button class="ct-calc-btn" onclick="calcColdTemp()">計算修正量</button>
        <div id="ct-no-corr" class="ct-no-corr" style="display:none">✅ OAT ≥ 0°C，無需低溫修正</div>
      </div>
      <div class="ct-table-wrap">
        <h3>ICAO Doc 8168 Cold Temperature Error Table（修正量 ft）</h3>
        <table class="ct-table" id="ct-table">
          <thead><tr>
            <th>HAA (ft) ↓ / OAT (°C) →</th>
            <th>0°</th><th>−10°</th><th>−20°</th><th>−30°</th><th>−40°</th><th>−50°</th>
          </tr></thead>
          <tbody id="ct-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ── ⛅ 航路氣象 / D-ATIS panel ── -->
  <div id="briefing-datis" class="briefing-panel active">
    <div class="wx-fixed-header">
      <div class="wx-routes">
        <button class="wx-refresh-all-btn" onclick="wxRefreshAll()" id="wx-refresh-all-btn" title="Refresh All METAR / TAF / ATIS">&#x21ba; Refresh All</button>
        <button class="wx-route-btn active" onclick="selectWxRegion('taiwan',this)">台灣 TW</button>
        <button class="wx-route-btn" onclick="selectWxRegion('hkmacao',this)">港澳 HK/MO</button>
        <button class="wx-route-btn" onclick="selectWxRegion('japan',this)">日本 JP</button>
        <button class="wx-route-btn" onclick="selectWxRegion('korea',this)">韓國 KR</button>
        <button class="wx-route-btn" onclick="selectWxRegion('philippines',this)">菲律賓 PH</button>
        <button class="wx-route-btn" onclick="selectWxRegion('thailand',this)">泰國 TH</button>
        <button class="wx-route-btn" onclick="selectWxRegion('vietnam',this)">越柬 VN/KH</button>
        <button class="wx-route-btn" onclick="selectWxRegion('seasia',this)">星馬印 SG/MY/ID</button>
        <button class="wx-route-btn" onclick="selectWxRegion('usa',this)">美國 US</button>
        <button class="wx-route-btn" onclick="selectWxRegion('pacific',this)">阿拉斯加太平洋 AK/PAC</button>
        <button class="wx-route-btn" onclick="selectWxRegion('canada',this)">加拿大 CA</button>
        <button class="wx-route-btn" onclick="selectWxRegion('europe',this)">歐洲 EU</button>
      </div>
      <div style="background:rgba(245,158,11,.08);border-bottom:1px solid rgba(245,158,11,.25);padding:5px 14px;font-size:.72em;color:#f59e0b;display:flex;align-items:center;gap:6px">
        <span>⚠</span><span>Non-operational use only. Data may not reflect current conditions.</span>
      </div>
    </div>
    <div class="wx-split">
      <div class="wx-list-pane" id="wx-list-pane">
        <div class="wx-loading-msg">載入氣象資料中...</div>
      </div>
      <div class="wx-detail-pane" id="wx-detail-pane">
        <div class="wx-empty"><span class="wx-hint-desktop">← 點選左側機場</span><span class="wx-hint-mobile">↑ 點選上方機場</span><br>查看 METAR · TAF · ATIS</div>
      </div>
    </div>
  </div>

  <!-- ── 🎙️ PA 工具 panel ── -->
  <div id="briefing-pa" class="briefing-panel" style="position:relative">
    <div class="pa-split">
      <!-- 左側：航班號 + 溫度換算 + 時區列表 -->
      <div class="pa-left">
        <!-- 溫度換算 -->
        <div class="pa-section">
          <div class="pa-section-title">🌡️ 溫度換算 Temp Converter</div>
          <div class="pa-temp-hint">輸入溫度自動換算並帶入廣播詞<br>Auto-converts and fills into PA script</div>
          <div class="pa-temp-row">
            <div class="pa-temp-field">
              <label>°C</label>
              <input type="number" id="pa-temp-c" inputmode="decimal" placeholder="—" oninput="paConvertTemp('c')">
            </div>
            <span class="pa-temp-arrow">⇄</span>
            <div class="pa-temp-field">
              <label>°F</label>
              <input type="number" id="pa-temp-f" inputmode="decimal" placeholder="—" oninput="paConvertTemp('f')">
            </div>
          </div>
        </div>
        <!-- 時區列表 -->
        <div class="pa-section pa-tz-section">
          <div class="pa-section-title">🕐 Local Time Query</div>
          <div class="pa-tz-hint">👇 輸入航班號或點選場站，自動帶入目的地及當地時間<br>Enter flight number or tap a station to auto-fill destination &amp; local time</div>
          <div class="pa-lt-search">
            <input class="pa-input" id="pa-lt-input" placeholder="e.g. JX2 / SJX002 / 002 / LAX / KLAX / 洛杉磯" oninput="_paLookupLocalTime(this.value);_syncFltNo('pa',this.value)">
            <span id="pa-lt-status" class="pa-flt-status"></span>
          </div>
          <div id="pa-localtime-result"></div>
          <div class="pa-tz-list" id="pa-tz-list"></div>
        </div>
      </div>
      <!-- 右側：PA 分類按鈕 + 內容 -->
      <div class="pa-right">
        <div class="pa-cat-btns">
          <button class="pa-cat-btn active" onclick="paSwitchCat('welcome',this)">Welcome</button>
          <button class="pa-cat-btn" onclick="paSwitchCat('delay',this)">Ground Delay</button>
          <button class="pa-cat-btn" onclick="paSwitchCat('descent',this)">Descent</button>
          <button class="pa-cat-btn" onclick="paSwitchCat('turbulence',this)">Turbulence</button>
          <button class="pa-cat-btn" onclick="paSwitchCat('deice',this)">De/Anti-ice</button>
          <button class="pa-cat-btn" onclick="paSwitchCat('missedappr',this)">Missed Approach</button>
          <button class="pa-cat-btn" onclick="paSwitchCat('diversion',this)">Diversion</button>
          <button class="pa-cat-btn" onclick="paSwitchCat('modsevcat',this)">MOD SEV CAT</button>
          <button class="pa-cat-btn" onclick="paSwitchCat('unrulypax',this)">Unruly Pax</button>
          <button class="pa-reset-btn" onclick="paReset()">重設 Reset</button>
        </div>
        <div class="pa-content" id="pa-content">
          <div class="pa-placeholder">選擇分類以查看廣播詞範本<br>Select a category to view PA scripts</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── 💰 Overtime panel ── -->
  <div id="briefing-overtime" class="briefing-panel" style="padding:12px;padding-bottom:80px;overflow-y:auto;-webkit-overflow-scrolling:touch;max-height:calc(100vh - 160px)">
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:8px">
      <span style="font-size:1em;font-weight:700;color:var(--text)">💰 Overtime Calculator</span>
      <button onclick="_otReset()" style="background:none;border:2px solid #ef4444;color:#ef4444;border-radius:6px;padding:2px 10px;font-size:.72em;font-weight:700;cursor:pointer">重設 Reset</button>
    </div>
    <div style="max-width:480px;margin:0 auto">
      <!-- 月份切換 + 航班選擇 + 說明（一區塊） -->
      <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
        <button onclick="_otPrevMonth()" style="background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:6px;padding:2px 8px;font-size:.85em;cursor:pointer">◀</button>
        <span id="ot-month-title" style="font-size:.85em;font-weight:700;color:var(--text);min-width:70px;text-align:center"></span>
        <button onclick="_otNextMonth()" style="background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:6px;padding:2px 8px;font-size:.85em;cursor:pointer">▶</button>
        <select id="ot-flight-select" onchange="_otSelectFlight(this)" style="background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:6px;padding:4px 8px;font-size:.8em;max-width:220px">
          <option value="">選擇航班 Select flight</option>
        </select>
      </div>
      <div style="font-size:.65em;color:var(--muted);text-align:center;margin-bottom:10px;line-height:1.5">
        已同步班表可直接下拉選擇航班，或手動輸入時間資訊 / Select from synced roster, or enter schedule times manually<br>
        <span style="opacity:.6">手動輸入時僅需輸入時間 / Origin & Dest optional for manual input</span><br>
        <span style="color:#eab308">⚠ 已值勤完畢航班的表定時間可能被更改，並非原本表定時間，資料僅供參考<br>Schedule times for completed flights may have been modified and may not reflect the original schedule. Data is for reference only.</span>
      </div>
      <!-- 輸入區 -->
      <div style="background:var(--card);border-radius:12px;padding:16px;margin-bottom:16px">
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:130px;white-space:nowrap">起飛地<br><span style="opacity:.6">Origin (IATA)</span></div>
            <input id="ot-origin" type="text" maxlength="4" placeholder="e.g. TPE" oninput="_otCalcScheduleFT()" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em;text-align:center;text-transform:uppercase">
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:130px;white-space:nowrap">目的地<br><span style="opacity:.6">Dest (IATA)</span></div>
            <input id="ot-dest" type="text" maxlength="4" placeholder="e.g. NRT" oninput="_otCalcScheduleFT()" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em;text-align:center;text-transform:uppercase">
          </div>
          <div style="border-top:1px solid var(--dim);padding-top:12px"></div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:130px;white-space:nowrap">Sched Block-Out<br><span style="opacity:.6">UTC (HH:MM)</span></div>
            <input id="ot-sched-out" type="time" oninput="_otCalcScheduleFT()" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em">
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:130px;white-space:nowrap">Sched Block-In<br><span style="opacity:.6">UTC (HH:MM)</span></div>
            <input id="ot-sched-in" type="time" oninput="_otCalcScheduleFT()" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em">
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:130px;white-space:nowrap">Sched Flight Time<br><span style="opacity:.6">Block Time</span></div>
            <div id="ot-sched-ft" style="flex:1;text-align:center;font-size:1.1em;font-weight:700;color:var(--text)">—</div>
          </div>
          <div style="border-top:1px solid var(--dim);padding-top:12px"></div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:130px;white-space:nowrap">Actual Block-Out<br><span style="opacity:.6">UTC (HH:MM)</span></div>
            <input id="ot-actual-out" type="time" oninput="_otCalcMagic()" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em">
          </div>
        </div>
      </div>
      <!-- 結果區 -->
      <div id="ot-result" style="display:none;background:var(--card);border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:.78em;color:var(--muted);margin-bottom:8px">晚於此時間 Block-In 將產生<span style="color:#eab308;font-weight:700">額外營運成本</span><br><span style="opacity:.7">Block-In after this time will incur <span style="color:#eab308;font-weight:700">additional operational costs</span></span></div>
        <div id="ot-magic" style="font-size:2em;font-weight:700;color:#22c55e">—</div>
        <div id="ot-magic-local" style="font-size:1em;color:var(--muted);margin-top:4px;display:none">—</div>
        <div style="font-size:.65em;color:var(--muted);margin-top:8px;opacity:.6">= Actual Block-Out + Schedule Flight Time + 30 min</div>
      </div>
    </div>
  </div>

  <!-- 📻 Pacific HF 分頁已移除（ARINC 封鎖嵌入＋擋伺服器 IP，無法 app 內顯示）→ 改放 Tools 的「📻 Pacific HF」按鈕，在瀏覽器開。 -->

  <!-- ── ⏱️ Duty Time panel ── -->
  <div id="briefing-duty" class="briefing-panel" style="position:relative">

    <!-- 密碼鎖 -->

    <div class="dt-wrap" style="flex:1">

      <!-- Placeholder hint -->
      <div id="dt-placeholder" style="padding:10px 14px 4px;text-align:center;color:var(--text);font-size:.82em;position:relative">
        選好人數並輸入 FDP Start，按「Calculate」即可查看最大限制時間<br><span style="opacity:.7;font-size:.9em">Select crew config, enter FDP Start, then press "Calculate" to view max limits</span>
        <button class="pa-reset-btn" onclick="dtReset()" style="position:absolute;right:0;top:50%;transform:translateY(-50%)">重設 Reset</button>
      </div>

      <!-- Config -->
      <div class="dt-config">
        <div class="dt-section-title">機組配置</div>
        <div class="dt-crew-row">
          <button class="dt-crew-btn active" data-crew="2" onclick="dtSelectCrew(this)">Single<br>2P</button>
          <button class="dt-crew-btn" data-crew="3" onclick="dtSelectCrew(this)">Multiple<br>3P</button>
          <button class="dt-crew-btn" data-crew="4" onclick="dtSelectCrew(this)">Double<br>4P</button>
        </div>
        <div class="dt-opt-row">
          <label class="dt-chk-label" id="dt-c1-row" style="display:none">
            <input type="checkbox" id="dt-c1" onchange="dtCheckFT()"> Class 1 Bunk
          </label>
          <label class="dt-chk-label" id="dt-disc-row" style="display:none">
            <input type="checkbox" id="dt-disc"> PIC Discretion (+2h)
          </label>
        </div>
        <div class="dt-opt-row">
          <label class="dt-chk-label">
            <input type="checkbox" id="dt-td6"> Time Diff ≥ 6h &amp; Stay &gt; 48h
          </label>
        </div>
        <div class="dt-opt-row" style="align-items:center">
          <label class="dt-chk-label">
            <input type="checkbox" id="dt-accom" onchange="dtToggleAccom()">
          </label>
          <span style="font-size:.78em;color:var(--text);flex-shrink:0">Rest at an Appropriate Accommodation</span>
          <input class="dt-time-box" type="text" id="dt-accom-h" placeholder="HH" maxlength="2" inputmode="numeric" style="width:36px" oninput="dtUpdateAccomHint()">
          <span class="dt-sep">hr</span>
          <input class="dt-time-box" type="text" id="dt-accom-m" placeholder="MM" maxlength="2" inputmode="numeric" style="width:36px" oninput="dtUpdateAccomHint()">
          <span class="dt-sep">min</span>
        </div>
        <div id="dt-accom-detail" style="display:none;padding:0 4px;margin-bottom:4px">
          <div style="display:flex;gap:12px;font-size:.78em;color:var(--text)">
            <label><input type="radio" name="dt-accom-type" value="notstart" checked onchange="dtUpdateAccomHint()"> First Sector Not Start</label>
            <label><input type="radio" name="dt-accom-type" value="start" onchange="dtUpdateAccomHint()"> First Sector Start</label>
          </div>
          <div id="dt-accom-hint" style="font-size:.75em;color:var(--text);margin-top:4px">* Actual FDP deducted by rest duration</div>
        </div>
        <div id="dt-accom-err" style="display:none;font-size:.78em;color:#ef4444;padding:0 4px;margin-bottom:4px"></div>
        <div class="dt-opt-row" style="margin-bottom:4px">
          <span style="font-size:.78em;color:var(--text);flex-shrink:0">時區</span>
          <select class="dt-tz-select" id="dt-tz">
            <option value="taipei" selected>台北 UTC+8</option>
            <option value="tokyo">東京 UTC+9</option>
            <option value="bangkok">曼谷 UTC+7</option>
            <option value="prague">布拉格 UTC+1/+2★</option>
            <option value="la">洛杉磯 UTC−8/−7★</option>
            <option value="phoenix">鳳凰城 UTC−7</option>
          </select>
        </div>
      </div>

      <!-- Mode -->
      <div class="dt-body" style="padding-bottom:0">
        <div class="dt-mode-row">
          <button class="dt-mode-btn active" id="dt-mode-home" onclick="dtSetMode('home')">🏠 Home Base</button>
          <button class="dt-mode-btn" id="dt-mode-out" onclick="dtSetMode('out')">🛏️ Outstation</button>
        </div>
      </div>

      <!-- Inputs -->
      <div class="dt-body">

        <!-- FDP Start -->
        <div class="dt-field">
          <div class="dt-field-label">FDP Start (UTC) — Report Time</div>
          <div class="dt-time-row">
            <div class="dt-date-wrap">
              <input type="date" id="dt-s-day" class="dt-date-input" onchange="dtDateChanged(this)">
              <span class="dt-date-display" id="dt-s-day-btn">--/--</span>
            </div>
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-s-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-s-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- FDP End -->
        <div class="dt-field">
          <div class="dt-field-label">FDP End (UTC) — Block In / Release <span style="color:var(--muted);font-size:.85em">（選填 用於檢查實際FDP — Optional / for actual FDP check）</span></div>
          <div class="dt-time-row">
            <div class="dt-date-wrap">
              <input type="date" id="dt-e-day" class="dt-date-input" onchange="dtDateChanged(this)">
              <span class="dt-date-display" id="dt-e-day-btn">--/--</span>
            </div>
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-e-h" placeholder="HH" maxlength="2" inputmode="numeric" oninput="dtCheckFT()">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-e-m" placeholder="MM" maxlength="2" inputmode="numeric" oninput="dtCheckFT()">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- DHD after OPS -->
        <div class="dt-opt-row" style="margin-top:8px">
          <label class="dt-chk-label">
            <input type="checkbox" id="dt-dhd" onchange="dtToggleDhd()"> DHD after OPS
          </label>
        </div>
        <div style="font-size:.72em;color:var(--muted);padding:0 4px;margin-top:-2px">* DHD before OPS：FDP Start 填 sign-on 時間，限制照算<br>DHD before OPS: Use sign-on time as FDP Start — same limits apply</div>
        <div class="dt-field" id="dt-dhd-section" style="display:none">
          <div class="dt-field-label">DHD End Time (UTC) — REST START</div>
          <div class="dt-time-row">
            <div class="dt-date-wrap">
              <input type="date" id="dt-dhd-day" class="dt-date-input" onchange="dtDateChanged(this)">
              <span class="dt-date-display" id="dt-dhd-day-btn">--/--</span>
            </div>
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-dhd-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-dhd-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- Flight Time -->
        <div class="dt-field">
          <div class="dt-field-label">Flight Time (Block Time)</div>
          <div class="dt-time-row">
            <input class="dt-time-box" type="text" id="dt-ft-h" placeholder="HH" maxlength="2" inputmode="numeric" oninput="dtCheckFT()">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-ft-m" placeholder="MM" maxlength="2" inputmode="numeric" oninput="dtCheckFT()">
          </div>
          <div id="dt-ft-err" style="display:none;font-size:.78em;color:#ef4444;margin-top:4px"></div>
        </div>

        <!-- Home Base: Next Report -->
        <div class="dt-field" id="dt-next-section">
          <div class="dt-field-label">Next Duty Report (UTC) — 選填</div>
          <div class="dt-time-row">
            <div class="dt-date-wrap">
              <input type="date" id="dt-n-day" class="dt-date-input" onchange="dtDateChanged(this)">
              <span class="dt-date-display" id="dt-n-day-btn">--/--</span>
            </div>
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-n-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-n-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- Outstation: Hotel Check-in / Check-out -->
        <div class="dt-field" id="dt-hotel-section" style="display:none">
          <div class="dt-field-label">Hotel Check-in (UTC)</div>
          <div class="dt-time-row">
            <div class="dt-date-wrap">
              <input type="date" id="dt-ci-day" class="dt-date-input" onchange="dtDateChanged(this)">
              <span class="dt-date-display" id="dt-ci-day-btn">--/--</span>
            </div>
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-ci-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-ci-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
          <div class="dt-field-label" style="margin-top:8px">Hotel Check-out (UTC)</div>
          <div class="dt-time-row">
            <div class="dt-date-wrap">
              <input type="date" id="dt-co-day" class="dt-date-input" onchange="dtDateChanged(this)">
              <span class="dt-date-display" id="dt-co-day-btn">--/--</span>
            </div>
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-co-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-co-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <button class="dt-calc-btn" onclick="dtCalculate()">Calculate</button>
      </div>

      <!-- Results -->
      <div id="dt-results-area" style="display:none">
        <div id="dt-ext-note" class="dt-ext-note" style="display:none"></div>
        <div class="dt-results-wrap">

          <!-- Deadline cards (PRIMARY) -->
          <div class="dt-deadline-row">
            <div class="dt-deadline-card">
              <div class="dt-deadline-label">⏱ Max Duty 截止</div>
              <div class="dt-deadline-time" id="dt-r-maxfdp-time">—</div>
              <div class="dt-deadline-dur" id="dt-r-maxfdp-dur"></div>
            </div>
            <div class="dt-deadline-card">
              <div class="dt-deadline-label">✈ Max Flight Time 截止</div>
              <div class="dt-deadline-time" id="dt-r-maxft-time">—</div>
              <div class="dt-deadline-dur" id="dt-r-maxft-dur"></div>
            </div>
          </div>

          <!-- Timeline -->
          <div class="dt-tl2">
            <div class="dt-tl2-title">Visual Timeline</div>
            <div id="dt-tl2-bars" style="position:relative;width:100%;height:156px">
              <!-- WOCL overlay -->
              <div id="dt-bar-wocl" style="position:absolute;top:0;bottom:0;background:rgba(239,68,68,.15);border-radius:4px;display:none;z-index:1"></div>
              <!-- Bars (z-index:2) -->
              <div id="dt-bar-fdp" style="position:absolute;top:0;height:28px;background:#10b981;border-radius:4px;display:flex;align-items:center;overflow:hidden;z-index:2">
                <span id="dt-lbl-fdp" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <div id="dt-bar-fdp-over" style="position:absolute;top:0;height:28px;background:#ef4444;border-radius:0 4px 4px 0;display:none;z-index:2"></div>
              <div id="dt-bar-dhd" style="position:absolute;top:0;height:28px;background:#8b5cf6;border-radius:0 4px 4px 0;display:flex;align-items:center;overflow:hidden;display:none;z-index:2">
                <span id="dt-lbl-dhd" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <div id="dt-bar-maxfdp" style="position:absolute;top:34px;height:28px;background:repeating-linear-gradient(-45deg,#3b82f6 0,#3b82f6 7px,#60a5fa 7px,#60a5fa 14px);border-radius:4px;display:flex;align-items:center;overflow:hidden;z-index:2">
                <span id="dt-lbl-maxfdp" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <div id="dt-bar-ext" style="position:absolute;top:34px;height:28px;background:repeating-linear-gradient(-45deg,#e11d48 0,#e11d48 7px,#f43f5e 7px,#f43f5e 14px);border-radius:4px;display:flex;align-items:center;overflow:visible;display:none;z-index:2">
                <span id="dt-lbl-ext" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <div id="dt-bar-minrest" style="position:absolute;top:68px;height:28px;background:repeating-linear-gradient(-45deg,#d97706 0,#d97706 7px,#f59e0b 7px,#f59e0b 14px);border-radius:4px;display:flex;align-items:center;overflow:hidden;z-index:2">
                <span id="dt-lbl-minrest" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <div id="dt-bar-rest" style="position:absolute;top:102px;height:28px;background:#475569;border-radius:4px;display:flex;align-items:center;overflow:hidden;display:none;z-index:2">
                <span id="dt-lbl-rest" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <!-- Vertical lines (z-index:3) -->
              <div id="dt-vline-start" style="position:absolute;top:0;bottom:0;border-left:1.5px dashed rgba(148,163,184,.5);z-index:3;display:none"></div>
              <div id="dt-vline-end" style="position:absolute;top:0;bottom:0;border-left:1.5px dashed rgba(148,163,184,.5);z-index:3;display:none"></div>
              <div id="dt-vline-next" style="position:absolute;top:0;bottom:0;border-left:1.5px dashed rgba(148,163,184,.5);z-index:3;display:none"></div>
            </div>
            <!-- Tick labels (positioned absolutely inside relative container) -->
            <div id="dt-tl2-ticks" style="position:relative;min-height:40px;margin-top:4px"></div>
            <div class="dt-legend">
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:#10b981"></div>FDP</div>
              <div class="dt-leg-item" id="dt-leg-dhd" style="display:none"><div class="dt-leg-box" style="background:#8b5cf6"></div>DHD</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:rgba(239,68,68,.25)"></div>WOCL (02-05)</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:repeating-linear-gradient(-45deg,#3b82f6 0,#3b82f6 4px,#60a5fa 4px,#60a5fa 8px)"></div>Max FDP</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:repeating-linear-gradient(-45deg,#e11d48 0,#e11d48 4px,#f43f5e 4px,#f43f5e 8px)"></div>Ext</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:repeating-linear-gradient(-45deg,#d97706 0,#d97706 4px,#f59e0b 4px,#f59e0b 8px)"></div>Min Rest</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:#475569"></div>Rest</div>
            </div>
            <div id="dt-tl2-warn" style="margin-top:8px;font-size:.75em;font-weight:700;color:#ef4444;line-height:1.6;display:none"></div>
          </div>

          <!-- WOCL -->
          <div id="dt-wocl-box" class="dt-wocl-box" style="display:none">
            <strong>⚠ WOCL (02:00–05:00 LT)</strong><br>
            <span id="dt-wocl-msg"></span>
          </div>

          <!-- Number cards (secondary) -->
          <div class="dt-cards">
            <div class="dt-card" id="dt-card-fdp">
              <div class="dt-card-label">Actual FDP</div>
              <div class="dt-card-actual" id="dt-r-fdp">—</div>
              <div class="dt-card-max" id="dt-r-fdp-max"></div>
            </div>
            <div class="dt-card" id="dt-card-ft">
              <div class="dt-card-label">Flight Time</div>
              <div class="dt-card-actual" id="dt-r-ft">—</div>
              <div class="dt-card-max" id="dt-r-ft-max"></div>
            </div>
            <div class="dt-rest-card" id="dt-card-rest">
              <div class="dt-card-label">Actual Rest</div>
              <div class="dt-card-actual" id="dt-r-rest">—</div>
              <div class="dt-card-max" id="dt-r-rest-min"></div>
            </div>
          </div>

          <div class="dt-notice">⚠ Non-operational reference only · Refer to company manuals</div>
        </div>
      </div>

      <!-- Reference toggle -->
      <div class="dt-ref-toggle" onclick="dtToggleRef()">
        <span>📋 CAR 07-02A 規定說明</span><span id="dt-ref-arrow">▼</span>
      </div>
      <div class="dt-ref-panel" id="dt-ref-panel">
      <div class="dt-ref-title">4.7.5 STARLUX Airlines Flight Time Limitation</div>
      <div class="dt-ref-sub">REF.: CAR 07-02A ART. 37/37-2/38/38-3/38-4/39/41/42/43/43-1</div>
      <table class="dt-ref-table">
        <thead>
          <tr>
            <th></th>
            <th>Single<br>2P</th>
            <th>Multiple<br>3P</th>
            <th>Double<br>4P</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="dt-ref-lbl">Min Rest Before Duty</td>
            <td>10h</td><td>10h</td><td>10h</td>
          </tr>
          <tr>
            <td class="dt-ref-lbl">Min Rest After Duty</td>
            <td>FT≤8: 10h<br>8&lt;FT≤10: 18h</td>
            <td>FT≤8: 10h<br>8&lt;FT≤12: 18h<br>12&lt;FT≤16: 24h</td>
            <td>FT≤8: 10h<br>8&lt;FT≤16: 18h<br>16&lt;FT≤18: 22h</td>
          </tr>
          <tr>
            <td class="dt-ref-lbl">Max FDP</td>
            <td>14h</td><td>18h</td><td>24h</td>
          </tr>
          <tr>
            <td class="dt-ref-lbl">Max FT (No C1) ①</td>
            <td>10h</td><td>12h</td><td>12h</td>
          </tr>
          <tr>
            <td class="dt-ref-lbl">Max FT (With C1) ①</td>
            <td>10h</td><td>16h</td><td>18h</td>
          </tr>
          <tr>
            <td class="dt-ref-lbl">Min Rest in 7 Days</td>
            <td>30h</td><td>30h</td><td>30h</td>
          </tr>
          <tr>
            <td class="dt-ref-lbl">Max FT in 7 Days</td>
            <td>32h</td><td>—</td><td>—</td>
          </tr>
          <tr>
            <td class="dt-ref-lbl">Max DP in 30 Days ②</td>
            <td>230h</td><td>230h</td><td>230h</td>
          </tr>
        </tbody>
      </table>
      <div class="dt-ref-note">
        <b>NOTE</b><br>
        ① Flight time within 24 hours.<br>
        ② Duty period may be extended to 260h; standby &amp; deadhead up to 30h may be counted.<br>
        ③ Before standby duty, pilot shall have 10 consecutive hours rest.<br>
        ④ Domestic: FT ≤ 8h/24h, FDP ≤ 12h.<br>
        ★ PIC Discretion: +2h to Max FDP (3P only).<br>
        ⑤ Min rest before duty: at least 10 consecutive hours before any flight duty or standby.<br>
        ⑥ 7-day rest: at least 30 consecutive hours within any 7 consecutive days.<br>
        ⑦ Sector limits: max 4 sectors per FDP; up to 6 sectors in case of force majeure diversion.<br>
        ⑧ Time zone adaptation: if stay &gt; 48h and time diff ≥ 6h, no flight duty within 48h after returning to base (DHD with min rest requirement permitted).<br>
        ⑨ WOCL (Window of Circadian Low, local 02:00–05:00):<br>
        &nbsp;&nbsp;• No more than 3 consecutive days of WOCL-infringing duty.<br>
        &nbsp;&nbsp;• 2 consecutive WOCL days → min 34h rest after duty.<br>
        &nbsp;&nbsp;• 3 consecutive WOCL days → min 54h rest after duty.<br>
        &nbsp;&nbsp;• Exception: if ≥ 14h rest given after each WOCL duty, the 34/54h requirement is waived.<br>
        ⑩ Accommodation (Not Start): Actual FDP deducted by rest duration (no upper limit on extension).<br>
        ⑪ Accommodation (Started): Max FDP increased by 50% of rest duration (capped at 24h).<br><br>
        ① 24 小時內之飛航時間。<br>
        ② 執勤時間可延長至 260h；待命及乘客身分搭機最多 30h 可計入。<br>
        ③ 待命勤務前，飛航組員須有連續 10 小時休息。<br>
        ④ 國內航線：FT ≤ 8h/24h，FDP ≤ 12h。<br>
        ★ 機長裁量權：Max FDP +2h（僅 3P）。<br>
        ⑤ 執勤前基本休時：任何飛航任務或待命前，必須給予至少連續 10 小時的休息。<br>
        ⑥ 7 日連續休時：在任何連續 7 天內，必須提供至少連續 30 小時的休息時間。<br>
        ⑦ 起降航段限制：單一 FDP 內最多 4 個航段；遇不可抗力轉降最多可放寬至 6 個航段。<br>
        ⑧ 時區差異適應：若外站停留 &gt; 48h 且時差 ≥ 6h，返回基地後 48 小時內不得指派飛航任務（可指派帶最低休時規定之 DHD）。<br>
        ⑨ WOCL（生理時鐘低潮期，當地 02:00–05:00）：<br>
        &nbsp;&nbsp;• 不得連續超過 3 天指派觸及 WOCL 之任務。<br>
        &nbsp;&nbsp;• 連續 2 天觸及 WOCL → 任務後至少 34h 休息。<br>
        &nbsp;&nbsp;• 連續 3 天觸及 WOCL → 任務後至少 54h 休息。<br>
        &nbsp;&nbsp;• 例外：每次觸及 WOCL 後皆有 ≥ 14h 休息，則免除 34/54h 限制。<br>
        ⑩ Accommodation（Not Start）：Actual FDP 扣除休息時數（無上限延長）。<br>
        ⑪ Accommodation（Started）：Max FDP 增加休息時數的 50%（上限 24h）。
      </div>
      </div>

      <div style="height:60px;flex-shrink:0"></div>
    </div>
  </div>

</div><!-- end tab-briefing -->

<!-- ══ Tab: Cabin Crew ══════════════════════════════════════════════ -->
<div id="tab-cabin" style="display:none">
  <!-- Cabin Crew sub-tabs -->
  <div class="briefing-subtabs cabin-subtabs" id="cabin-subtabs" style="justify-content:space-evenly">
    <div class="subtab-slot" style="flex:1"><button class="briefing-subtab active" id="cabinSubBtn-rest" onclick="switchCabinTab('rest',this)" style="width:100%"><span class="drag-grip">≡</span>⏳ Rest Calc</button></div>
    <div class="subtab-slot" style="flex:1"><button class="briefing-subtab" id="cabinSubBtn-swap" onclick="switchCabinTab('swap',this)" style="width:100%"><span class="drag-grip">≡</span>🔄 Swap Check</button></div>
  </div>

  <!-- Cabin Rest Calc -->
  <div id="cabin-rest" class="briefing-panel active" style="padding:20px">
    <div id="cabin-rest-content">
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:16px">
        <span style="font-size:1em;font-weight:700;color:var(--text)">⏳ Cabin Crew Rest Calculator</span>
        <button onclick="_ccRestReset()" style="background:none;border:2px solid #ef4444;color:#ef4444;border-radius:6px;padding:2px 10px;font-size:.72em;font-weight:700;cursor:pointer">重設 Reset</button>
      </div>
      <!-- 輸入區 -->
      <div style="background:var(--card);border-radius:12px;padding:16px;margin-bottom:16px;max-width:480px;margin-left:auto;margin-right:auto">
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:110px;white-space:nowrap">目的地時區<br><span style="opacity:.6">Dest TZ</span></div>
            <select id="cc-rest-tz" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:.9em">
              <option value="8" selected>UTC+8 (TPE / HKG / MFM / SIN)</option>
              <option value="9">UTC+9 (NRT / ICN)</option>
              <option value="7">UTC+7 (BKK / SGN / CGK)</option>
              <option value="-8">UTC-8 (LAX / SFO / SEA) PST</option>
              <option value="-7">UTC-7 (PHX / LAX DST)</option>
              <option value="1">UTC+1 (PRG) CET</option>
              <option value="2">UTC+2 (PRG DST) CEST</option>
              <option value="0">UTC+0</option>
              <option value="-5">UTC-5</option>
              <option value="-6">UTC-6</option>
              <option value="-9">UTC-9</option>
              <option value="-10">UTC-10</option>
              <option value="3">UTC+3</option>
              <option value="4">UTC+4</option>
              <option value="5">UTC+5</option>
              <option value="5.5">UTC+5:30</option>
              <option value="6">UTC+6</option>
              <option value="10">UTC+10</option>
              <option value="11">UTC+11</option>
              <option value="12">UTC+12</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:110px;white-space:nowrap">1st Rest 開始<br><span style="opacity:.6">Start</span></div>
            <input id="cc-rest-start" type="time" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em">
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:120px;white-space:nowrap">Handover<br><span style="opacity:.6">Duration (min)</span></div>
            <input id="cc-rest-handover" type="text" value="5" inputmode="numeric" placeholder="5" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em;text-align:center">
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:120px;white-space:nowrap">2nd Rest 準備<br><span style="opacity:.6">Crew Prep (min)</span></div>
            <input id="cc-rest-prep" type="text" value="5" inputmode="numeric" placeholder="5" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em;text-align:center">
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:120px;white-space:nowrap">2nd Meal<br><span style="opacity:.6">Duration (HHMM)</span></div>
            <input id="cc-rest-meal" type="text" value="0230" inputmode="numeric" placeholder="e.g. 0230" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em;text-align:center">
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:120px;white-space:nowrap">TOD<br><span style="opacity:.6">Time (HH:MM)</span></div>
            <input id="cc-rest-tod" type="time" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em">
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:.85em;color:var(--muted);min-width:120px;white-space:nowrap">Landing<br><span style="opacity:.6">Time (HH:MM)</span></div>
            <input id="cc-rest-landing" type="time" style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--dim);border-radius:8px;padding:10px;font-size:1em">
          </div>
        </div>
        <button onclick="_ccRestCalc()" style="margin-top:16px;width:100%;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:14px;font-size:1.05em;font-weight:700;cursor:pointer">計算 Calculate</button>
      </div>
      <!-- 結果區 -->
      <div id="cc-rest-result" style="display:none;background:var(--card);border-radius:12px;padding:14px;max-width:480px;margin:0 auto">
      </div>
    </div>
  </div>

  <!-- Swap Check -->
  <div id="cabin-swap" class="briefing-panel" style="padding:20px">
    <div style="text-align:center;padding:40px 20px;color:var(--muted)">
      <div style="font-size:2.5em;margin-bottom:12px">🔄</div>
      <div style="font-size:1em;font-weight:700;color:var(--text);margin-bottom:8px">Swap Check</div>
      <div style="font-size:.82em;color:var(--muted)">Coming Soon</div>
    </div>
  </div>
</div><!-- end tab-cabin -->

<!-- ══ Tab: ATFM 流量管制 ═══════════════════════════════════════════════ -->
<div id="tab-atfm" style="display:none">
  <div class="atfm-head">
    <span class="atfm-title">🚦 Air Traffic Flow Management</span>
    <span class="atfm-notice">⚠ Non-operational Reference only</span>
  </div>
  <div id="atfm-regions" class="atfm-regions"></div>
  <div class="atfm-legend" id="atfm-legend">
    <div class="atfm-legend-head">
      <button class="atfm-legend-tog" onclick="atfmToggleLegend()"><span class="atfm-legend-chev" id="atfm-legend-chev">▸</span>🚦 Legend 燈號說明</button>
      <button class="atfm-scope" id="atfm-scope" onclick="atfmToggleScope()" title="⭐ Key 只看清單機場 / 🌐 Events 看全部事件機場">⭐ Key</button>
    </div>
    <div class="atfm-legend-body">
      <span><span class="atfm-dot" style="background:#ef4444"></span>Closed 關場·地停</span>
      <span><span class="atfm-dot" style="background:#f59e0b"></span>Restriction 管制·天氣·罷工·跑道關</span>
      <span><span class="atfm-dot" style="background:#38bdf8"></span>Info 告示(施工/設施)·不影響流量</span>
      <span><span class="atfm-dot" style="background:#22c55e"></span>Normal 正常無管制</span>
      <span><span class="atfm-dot" style="background:#6b7280"></span>No data 無資料</span>
      <span class="atfm-legend-hint">Tap airport 點機場看詳情</span>
    </div>
  </div>
  <div id="atfm-map"></div>
  <button class="atfm-bar-toggle" onclick="atfmToggleBar()" aria-label="收合/展開資訊面板"><span class="atfm-bar-grip"></span><span id="atfm-bar-chev">⌄</span></button>
  <div class="atfm-bar" id="atfm-bar"></div>
</div><!-- end tab-atfm -->

<!-- ══ Tab: Gate Info ═══════════════════════════════════════════════ -->
<div id="tab-gate" style="display:none">

  <div id="gate-content" style="display:flex;flex-direction:column">
    <div class="gi-header">
      <div class="gi-header-left">
        <span class="gi-notice-inline" style="color:#eab308">⚠ Non-operational Reference only</span>
        <div class="gi-station-bar">
          <select id="gi-region" class="gi-station-sel" onchange="giSetRegion(this.value)"></select>
          <select id="gi-station" class="gi-station-sel" onchange="giSetStation(this.value)"></select>
        </div>
        <div class="gi-date-nav">
          <button class="gi-nav-btn" id="gi-prev-day" onclick="giPrevDay()">◀</button>
          <span class="gi-date" id="gate-date"></span>
          <button class="gi-nav-btn gi-today-btn" id="gi-today-btn" onclick="giToday()" style="display:none">今天</button>
          <button class="gi-nav-btn" id="gi-next-day" onclick="giNextDay()">▶</button>
        </div>
        <div style="font-size:.62em;color:var(--muted);margin-top:1px">跨午夜抵達航班請切換至次日查詢 / For post-midnight arrivals, switch to the next day</div>
      </div>
      <div class="gi-header-btns">
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="gi-time-btn" id="gi-time-btn" onclick="toggleGiTime()">⏱ STD/STA</button>
          <button class="gi-view-btn" id="gi-view-btn" onclick="toggleGiView()">🛫 Orig</button>
        </div>
        <button class="gi-refresh-btn" onclick="refreshGateFlights()">🔄 更新</button>
      </div>
    </div>
    <div class="gi-filter-bar">
      <div class="gi-search-bar">
        <div class="gi-airline-btns">
          <button class="gi-airline-btn" data-airline="JX" onclick="giSetAirline('JX')" style="color:#B8860B">JX</button>
          <button class="gi-airline-btn" data-airline="BR" onclick="giSetAirline('BR')" style="color:#00A651">BR</button>
          <button class="gi-airline-btn" data-airline="CI" onclick="giSetAirline('CI')" style="color:#E91E8C">CI</button>
          <button class="gi-airline-btn" data-airline="ALL" onclick="giSetAirline('ALL')" style="color:var(--muted)">ALL</button>
        </div>
        <input type="text" id="gate-search" class="gi-search-input" placeholder="搜尋..." oninput="filterGateFlights()">
      </div>
      <div class="gi-search-hint">Search by flight no. / airport code / city name ｜ Tap <span style="color:var(--sort)">blue headers</span> to sort</div>
      <div class="gi-time-bar">
        <button class="gi-time-slot" data-slot="±2hr" onclick="giSetTimeSlot('±2hr')">±2hr</button>
        <button class="gi-time-slot" data-slot="00-06" onclick="giSetTimeSlot('00-06')">00-06</button>
        <button class="gi-time-slot" data-slot="06-12" onclick="giSetTimeSlot('06-12')">06-12</button>
        <button class="gi-time-slot" data-slot="12-18" onclick="giSetTimeSlot('12-18')">12-18</button>
        <button class="gi-time-slot" data-slot="18-24" onclick="giSetTimeSlot('18-24')">18-24</button>
        <button class="gi-time-slot" data-slot="all" onclick="giSetTimeSlot('all')">All</button>
      </div>
    </div>
    <div id="gi-pinned-wrap" class="gi-pinned-wrap" style="display:none">
      <div id="gi-pinned-header" class="gi-pinned-header-bar"></div>
      <table class="gi-table gi-hide-time" id="gi-pinned-table">
        <thead>
          <tr>
            <th class="gi-sticky-col gi-sortable" onclick="giSort('fno')">Flight</th>
            <th class="gi-sortable" onclick="giSort('origin')">Origin</th>
            <th>Terminal</th>
            <th>Check-in</th>
            <th>Gate</th>
            <th class="gi-time-col gi-sortable" onclick="giSort('std')">STD</th>
            <th class="gi-time-col gi-sortable" onclick="giSort('atd')">ATD</th>
            <th class="gi-sortable" onclick="giSort('dest')">Dest</th>
            <th>Terminal</th>
            <th>Parking</th>
            <th>Belt</th>
            <th class="gi-time-col gi-sortable" onclick="giSort('sta')">STA</th>
            <th class="gi-time-col gi-sortable" onclick="giSort('ata')">ATA</th>
          </tr>
        </thead>
        <tbody id="gi-pinned-tbody"></tbody>
      </table>
    </div>
    <div id="gate-status" class="gi-status">按下「更新航班資訊」載入今日航班</div>
    <div id="gate-table-wrap" class="gi-table-wrap" style="display:none">
      <table class="gi-table gi-hide-time" id="gi-table">
        <thead>
          <tr>
            <th class="gi-sticky-col gi-sortable" onclick="giSort('fno')">Flight</th>
            <th class="gi-sortable" onclick="giSort('origin')">Origin</th>
            <th>Terminal</th>
            <th>Check-in</th>
            <th>Gate</th>
            <th class="gi-time-col gi-sortable" onclick="giSort('std')">STD</th>
            <th class="gi-time-col gi-sortable" onclick="giSort('atd')">ATD</th>
            <th class="gi-sortable" onclick="giSort('dest')">Dest</th>
            <th>Terminal</th>
            <th>Parking</th>
            <th>Belt</th>
            <th class="gi-time-col gi-sortable" onclick="giSort('sta')">STA</th>
            <th class="gi-time-col gi-sortable" onclick="giSort('ata')">ATA</th>
          </tr>
        </thead>
        <tbody id="gate-tbody"></tbody>
      </table>
    </div>
  </div>

</div><!-- end tab-gate -->

<!-- ══ Tab: FR24 Radar ════════════════════════════════════════════════ -->
<div id="tab-fr24" style="display:none">
  <div id="fr24-portrait-overlay" class="live-portrait-overlay" style="display:none">
    <div style="font-size:2.5em;margin-bottom:12px">📱↔️</div>
    <div style="font-weight:700;font-size:1.05em;margin-bottom:6px">請橫拿手機</div>
    <div style="color:var(--muted);font-size:.82em">Please rotate to landscape</div>
  </div>
  <div id="fr24-map"></div>
  <button id="fr24-sidebar-toggle" class="live-toggle-btn" onclick="fr24ToggleSidebar()">☰</button>
  <div id="fr24-sidebar" class="live-sidebar live-sidebar-left">
    <div class="live-sb-header">
      <div id="fr24-count" style="font-weight:700;font-size:.8em"></div>
      <div style="display:flex;gap:6px">
        <button class="live-sb-pos-btn" onclick="fr24SwitchSidebarPos()" title="Switch side">⇄</button>
        <button class="live-sb-close-btn" onclick="fr24ToggleSidebar()" title="Close">✕</button>
      </div>
    </div>
    <div class="live-sb-section">
      <div class="live-airline-row">
        <label class="live-cb-label"><input type="checkbox" id="fr24-f-jx" checked onchange="fr24ApplyFilter()"><span>JX</span></label>
        <label class="live-cb-label"><input type="checkbox" id="fr24-f-br" onchange="fr24ApplyFilter()"><span>BR</span></label>
        <label class="live-cb-label"><input type="checkbox" id="fr24-f-ci" onchange="fr24ApplyFilter()"><span>CI</span></label>
      </div>
      <div style="font-size:.6em;color:var(--muted);margin-top:2px;line-height:1.2">都不選 = 地圖範圍內全部顯示（上限 500）</div>
    </div>
    <div class="live-sb-section" style="display:flex;align-items:center;gap:6px">
      <div style="font-size:.7em;color:var(--muted);white-space:nowrap">Search</div>
      <input type="text" id="fr24-f-custom" class="live-custom-input" placeholder="JX / JX800" onchange="fr24ApplyFilter()" onkeydown="if(event.key==='Enter')fr24SearchFlight()" style="width:72px;flex:none">
      <label class="live-cb-label" style="margin-left:auto"><input type="checkbox" id="fr24-f-labels" onchange="fr24ToggleLabels()"><span>Labels</span></label>
    </div>
    <div id="fr24-search-msg" style="font-size:.6em;color:#f87171;min-height:.8em;line-height:1.2"></div>
    <div class="live-sb-section" style="display:flex;align-items:center;gap:4px">
      <select id="fr24-jump" class="live-jump-select" style="flex:1;min-width:0" onchange="fr24JumpTo()">
        <option value="">Jump to</option>
        <option value="25.08,121.23,8">TPE</option>
        <option value="22.57,120.35,10">KHH</option>
        <option value="35.76,140.39,8">NRT</option>
        <option value="34.43,135.24,10">KIX</option>
        <option value="42.77,141.69,10">CTS</option>
        <option value="22.31,113.91,10">HKG</option>
        <option value="1.36,103.99,10">SIN</option>
        <option value="13.69,100.75,10">BKK</option>
        <option value="33.94,-118.41,8">LAX</option>
        <option value="37.62,-122.38,10">SFO</option>
        <option value="47.45,-122.31,10">SEA</option>
        <option value="33.43,-112.01,10">PHX</option>
        <option value="25.0,121.5,5">Asia</option>
        <option value="40.0,-100.0,4">USA</option>
        <option value="50.0,10.0,4">Europe</option>
        <option value="0,0,2">World</option>
      </select>
      <input type="text" id="fr24-jump-input" class="live-custom-input" placeholder="ICAO" style="width:56px;flex:none" onkeydown="if(event.key==='Enter')fr24JumpToIcao()">
      <button class="live-sb-pos-btn" onclick="fr24JumpToIcao()" style="padding:4px 6px;font-size:.72em">Go</button>
    </div>
    <button id="fr24-refresh-btn" class="live-refresh-btn" onclick="fr24ManualRefresh()">↻ Refresh</button>
    <div id="fr24-status" style="font-size:.6em;margin-top:6px;line-height:1.3"></div>
    <div style="font-size:.55em;margin-top:2px;color:var(--muted);opacity:.6">非FR24官方資料源，可能隨時失效</div>
    <div class="live-list-header">Flights</div>
    <div id="fr24-flight-list" class="live-flight-list"></div>
  </div>
</div><!-- end tab-fr24 -->

<!-- ══ Pacific HF 全螢幕 Overlay ════════════════════════════════════ -->
<div id="hf-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:500;background:#fff;flex-direction:column">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top,0px) + 8px) 16px 8px;background:#1e293b;border-bottom:1px solid #334155;flex-shrink:0">
    <span style="font-weight:700;font-size:.95em;color:#e2e8f0">📻 Pacific HF 查詢</span>
    <div style="display:flex;gap:14px;align-items:center">
      <a href="https://radio.arinc.net/pacific/" target="_blank" style="font-size:.82em;color:#7dd3fc;text-decoration:none">↗ 新分頁</a>
      <button onclick="closeHF()" style="background:none;border:none;color:#94a3b8;font-size:1.3em;cursor:pointer;padding:0 2px;line-height:1">✕</button>
    </div>
  </div>
  <iframe id="hf-iframe" src="" style="flex:1;border:none;width:100%"></iframe>
</div>

<!-- ══ Tab Bar ═══════════════════════════════════════════════════════ -->
<div class="tab-bar">
  <button class="tab-btn" id="tabBtn-sync" onclick="switchTab('sync',this)">
    <span class="tab-btn-icon">✈️</span>Roster Sync
  </button>
  <button class="tab-btn tab-active" id="tabBtn-briefing" onclick="switchTab('briefing',this)">
    <span class="tab-btn-icon">🧑‍✈️</span>Flight Crew
  </button>
  <button class="tab-btn" id="tabBtn-cabin" onclick="switchTab('cabin',this)">
    <span class="tab-btn-icon">👥</span>Cabin Crew
  </button>
  <!-- FR24 tab UI 已拿掉(看不到歷史、比不上真 FR24 app)。程式保留:/api/fr24 proxy + fr24-radar.js + #tab-fr24 內容都 dormant，要復活把這顆按鈕加回來即可。 -->
  <button class="tab-btn" id="tabBtn-atfm" onclick="switchTab('atfm',this)">
    <span class="tab-btn-icon">🚦</span>ATFM
  </button>
  <button class="tab-btn" id="tabBtn-gate" onclick="switchTab('gate',this)">
    <span class="tab-btn-icon">🌏</span>Gate Info
  </button>
  <a href="/apps" id="cs-apps-home" class="tab-util-btn" aria-label="Tools" title="回 Tools" style="display:none;flex:0 0 auto;align-self:center;text-decoration:none;padding:0 8px"><svg width="20" height="20" viewBox="0 0 24 24"><rect x="2" y="2" width="9" height="9" rx="2.5" fill="#3b82f6"/><rect x="13" y="2" width="9" height="9" rx="2.5" fill="#10b981"/><rect x="2" y="13" width="9" height="9" rx="2.5" fill="#f59e0b"/><rect x="13" y="13" width="9" height="9" rx="2.5" fill="#a855f7"/></svg></a>
  <div class="tab-btn tab-util" style="flex-direction:row;gap:0">
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <button class="tab-util-btn" onclick="toggleTheme()" id="tabBtn-theme">
        <span id="theme-icon">☀️</span>
      </button>
    </div>
    <div class="font-size-wrap">
      <button class="tab-util-btn font-size-btn font-size-btn-lg" onclick="adjustFontSize(1)">A+</button>
      <button class="tab-util-btn font-size-btn font-size-btn-sm" onclick="adjustFontSize(-1)">A-</button>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">
      <button class="tab-util-btn tab-install-btn" id="tab-install-btn" onclick="showInstallGuide()" style="display:none">
        <span>📲</span>安裝
      </button>
      <span style="font-size:.55em;color:var(--muted);line-height:1;opacity:.7;cursor:pointer;text-decoration:underline" onclick="showAbout()">V9.5.06</span>
    </div>
  </div>
</div>
<!-- ⊞ 回 Apps：只在「從 /apps 入口進來(sessionStorage 章) + 裝成 PWA」時顯示 -->
<script>(function(){try{var s=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone;if(s&&sessionStorage.getItem('cs_via_apps')==='1'){var b=document.getElementById('cs-apps-home');if(b)b.style.display='inline-flex';}}catch(e){}})();</script>

<!-- iOS 安裝說明 -->
<div id="install-overlay" class="install-overlay" style="display:none" onclick="if(event.target===this)closeInstallGuide()">
  <div class="install-card">
    <div style="font-size:2em;margin-bottom:8px">📲</div>
    <div style="font-weight:700;font-size:1em;margin-bottom:4px">加入主畫面</div>
    <div style="font-size:.82em;color:var(--muted);margin-bottom:12px">Add to Home Screen</div>
    <div class="install-steps">
      1. 點 Safari 底部的 <b>分享按鈕</b>（⬆️ 方框加箭頭）<br>
      <span style="color:var(--muted);font-size:.9em">Tap the <b>Share</b> button at the bottom of Safari (⬆️)</span><br><br>
      2. 向下滑，點「<b>加入主畫面</b>」<br>
      <span style="color:var(--muted);font-size:.9em">Scroll down, tap "<b>Add to Home Screen</b>"</span><br><br>
      3. 右上角點「<b>新增</b>」<br>
      <span style="color:var(--muted);font-size:.9em">Tap "<b>Add</b>" in the top right</span>
    </div>
    <button class="install-close-btn" onclick="closeInstallGuide()">知道了 Got it</button>
  </div>
</div>

<!-- 關於 -->
<div id="about-overlay" class="install-overlay" style="display:none" onclick="if(event.target===this)closeAbout()">
  <div class="install-card">
    <div style="font-size:.82em;color:var(--text);line-height:1.7;margin-bottom:14px;text-align:left">
      <div style="margin-bottom:4px">📱 建議使用 <b>iPad 橫向</b>操作以獲得最佳體驗，Android 裝置可能無法正確顯示</div>
      <div style="color:var(--muted)">Best experience on iPad in landscape mode. Android devices may not display correctly.</div>
    </div>
    <div style="max-height:50vh;overflow-y:auto;-webkit-overflow-scrolling:touch;margin-bottom:10px">
    ${renderCommunityLink()}
    <div style="font-size:.78em;font-weight:700;margin-bottom:6px" id="about-version">V9.5.06</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛬 <b>Gate Info 新增外站:巴塞隆納、蘇黎世。</b></div>
      <div>🛬 <b>Gate Info: added Barcelona and Zurich.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.5.04</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛬 <b>Gate Info 新增外站:洛杉磯、布拉格。</b></div>
      <div>🛬 <b>Gate Info: added Los Angeles and Prague.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.5.03</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🗄️ <b>優化快取機制。</b></div>
      <div>🗄️ <b>Improved caching.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.5.02</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🧹 <b>精簡歷史更新摘要（每版一句），載入更快。</b></div>
      <div>🧹 <b>Condensed past changelog entries (one line each) for faster loading.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.5.01</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔒 <b>修正未同步時部分機場 ATIS 誤顯示「無資料」，現在會正確顯示鎖定提示。</b></div>
      <div>🔒 <b>Fixed some airports showing "no data" instead of the lock notice when not synced.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.5.00</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛡️ <b>隱私強化：班表分享／群組／Briefing 的寫入與刪除改為需驗證本人身分（防冒名覆蓋他人班表、亂加群、刪他人 briefing）；班表查詢加流量限制擋枚舉撈照片。Briefing 筆記改為僅本人可讀寫。</b></div>
      <div>🛡️ <b>Privacy hardening: writes/deletes for roster sharing, groups and briefings now require identity verification (no impersonating others); roster lookups are rate-limited against enumeration. Briefing notes are now owner-only.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.47</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔒 <b>ATIS 即時資料改為僅限已同步班表的星宇組員；其餘天氣資訊（METAR/TAF）不受影響。</b></div>
      <div>🔒 <b>Real-time ATIS is now limited to verified STARLUX crew who have synced their roster; other weather info is unaffected.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.46</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>⛅ <b>Airport WX 更新至 Ops Spec C-6 Amdt 072；機隊選單改用 ICAO 機型碼。</b></div>
      <div>⛅ <b>Airport WX updated to Ops Spec C-6 Amdt 072; fleet uses ICAO type codes.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.45</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>一併清掉已誤存的飛行計畫殘留（如 LOWW DEP）。</b></div>
      <div>🛰️ <b>Also clears already-cached bogus flight-plan data (e.g. LOWW DEP).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.44</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>修正部分外站（如維也納 LOWW）把公司飛行計畫誤判成 ATIS。</b></div>
      <div>🛰️ <b>Fixed some airports (e.g. LOWW) mistaking a company flight plan for ATIS.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.43</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>修正部分機場（如香港）偶爾只顯示半截 ATIS：庫裡若是缺天氣／QNH 的半截資料，改成先等完整來源再顯示，不再把半截 ATIS 端給你。</b></div>
      <div>🛰️ <b>Fixed some airports (e.g. HKG) occasionally showing a half ATIS: if the cached copy is missing weather/QNH, it now waits for the full source instead of serving the partial text.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.42</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>ATIS 結尾雜碼完全清乾淨（含黏在字尾的純數字訊號碼；QNH／高度表數值保留不誤砍）。</b></div>
      <div>🛰️ <b>ATIS trailing codes fully removed (incl. all-digit codes glued to the end; QNH / altimeter values preserved).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.41</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>ATIS 結尾雜碼去除更徹底。</b></div>
      <div>🛰️ <b>ATIS trailing codes removed more thoroughly.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.40</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>ATIS 資料來源標註 CoffeeTeaorMe。</b></div>
      <div>🛰️ <b>Credit ATIS data source: CoffeeTeaorMe.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.39</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>系統更新：ATIS 顯示更乾淨完整（去除結尾雜碼、來源改顯示航班號）。</b></div>
      <div>🛰️ <b>System update: cleaner, complete ATIS display (trailing code removed, source shows flight number).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.38</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>系統更新。</b></div>
      <div>🛰️ <b>System update.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.37</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>系統更新：修正部分 ATIS 顯示不完整；時間標示改為資料收到時刻。</b></div>
      <div>🛰️ <b>System update: fixed occasionally-incomplete ATIS; timestamp now shows data-received time.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.36</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>系統更新：ATIS 改用更即時的資料源。</b></div>
      <div>🛰️ <b>System update: ATIS now uses a more real-time source.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.35</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>天氣資料校正，修正部分機場 ATIS 卡在舊資料的問題。</b></div>
      <div>🛠️ <b>Weather data correction — fixed certain airports' ATIS being stuck on stale data.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.34</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>系統更新。</b></div>
      <div>📻 <b>System update.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.33</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>系統更新。</b></div>
      <div>📻 <b>System update.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.32</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>系統更新。</b></div>
      <div>📻 <b>System update.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.31</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>系統優化。</b></div>
      <div>📻 <b>System optimization.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.30</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 抓取優化：亞洲場更即時。</b></div>
      <div>📻 <b>ATIS fetching improved: fresher for Asian airports.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.29</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>系統優化：ATIS 更新更即時。</b></div>
      <div>📻 <b>System optimization: fresher ATIS updates.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.28</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 改用 airframes A9 專屬 label 抓取：只回 ATIS、視窗涵蓋約 9-10 小時，現行 ARR/DEP 幾乎不再漏、更新更即時。</b></div>
      <div>📻 <b>ATIS now uses airframes' A9 (ATIS-only) label: the window holds ~9-10h of ATIS, so current ARR/DEP rarely scroll out — much fresher.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.27</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 支援「合併 ATIS」（歐洲等不分到/離場的單一 ATIS）：這些場也走累積庫、不再只靠前端備援。</b></div>
      <div>📻 <b>ATIS supports combined ATIS (single ATIS not split into ARR/DEP, e.g. Europe) — these airports now use our accumulation store, not just the frontend fallback.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.26</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 時間顯示補正：「庫」服務的那筆也改標真實發布時刻（V9.4.25 漏了庫路徑、還顯示收到時間，舊資料看起來像剛收到）。</b></div>
      <div>📻 <b>ATIS time-display fix: store-served entries now also show the real issue time (V9.4.25 missed the store path and still showed receipt time, making old data look fresh).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.25</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 修正「有資料卻顯示空白」（日本場 DEP 等）：有 ATIS 就一定顯示（含較舊的），時間改標「真實發布時刻」誠實呈現新舊；宵禁的「NOT AVAILABLE」也照實顯示。</b></div>
      <div>📻 <b>Fixed ATIS showing blank despite having data (e.g. Japan DEP): now always shows an ATIS when one exists (incl. older), labels the real issue time honestly, and shows curfew "NOT AVAILABLE" states.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.24</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 快層重點機場改為常飛航點（桃園/成田/關西/新千歲/香港/樟宜/曼谷）；並清掉早期殘留的「ATIS 暫無」舊資料。</b></div>
      <div>📻 <b>ATIS priority airports set to the regular network (Taipei/Narita/Kansai/Sapporo/HK/Singapore/Bangkok); also purged leftover "ATIS not available" placeholders.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.23</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 背景累積調校：重點機場用更全面的雙重查法、輪得更勤，並濾掉「ATIS 暫無」佔位訊息，更快接到最新、更少舊資料。</b></div>
      <div>📻 <b>Tuned ATIS background accumulation: priority airports use a fuller dual query and poll more often, and "ATIS not available" placeholders are filtered — catching the latest faster with less stale data.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.22</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 改用背景持續累積：伺服器定時輪詢、把每個機場最新的 ATIS 存起來，打開就是存好的最新那筆，大幅減少顯示到舊資料。</b></div>
      <div>📻 <b>ATIS now continuously accumulates in the background: the server polls on a schedule and keeps each airport's latest, so you see the freshest held copy and far less stale data.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.21</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>修正 ATIS 偶爾顯示「過期/壞時戳」資料（自報時間晚於收到時間的重複訊息）；現在只挑真正有效的現行那則，挑不到寧可留白也不硬塞舊資料。</b></div>
      <div>📻 <b>Fixed ATIS occasionally showing stale/bad-timestamp data (re-transmitted messages stamped later than received); now picks only the genuinely current one, showing nothing rather than forcing stale data.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.20</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔧 <b>三個工具一起修：同步失敗訊息更清楚、匯入失敗航班可補完、投資組合編輯交易修好。</b></div>
      <div>🔧 <b>Fixes across all three apps: clearer sync errors, recoverable failed imports, Portfolio edit fixed.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.19</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔒 <b>後端安全性強化（保護班表與個人資料）。</b></div>
      <div>🔒 <b>Backend security hardening (protecting roster and personal data).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.18</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 換用 airframes 即時 ACARS 來源,每則標示下傳的航班/機號與時間;各地區一鍵更新會順手刷該區 ATIS。</b></div>
      <div>📻 <b>ATIS now streams from airframes' live ACARS feed, each tagged with the reporting flight/aircraft and time; per-region refresh also updates that region's ATIS.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.17</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔧 <b>修正 Gate Info 場站選單過寬跑版;更新隱私頁來源清單。</b></div>
      <div>🔧 <b>Fixed the wide Gate Info station selector; refreshed the privacy-page source list.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.16</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛫 <b>Gate Info 新增成田 NRT、樟宜 SIN、舊金山 SFO 三個外站;時段預設改依機場當地時間,只顯示此刻前後航班。</b></div>
      <div>🛫 <b>Gate Info adds Narita, Changi & San Francisco; the time filter now follows each airport's local time, showing flights around "now."</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.15</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🎨 <b>介面優化:移除 FR24 分頁與多餘按鈕,ATIS 顯示更簡潔。</b></div>
      <div>🎨 <b>UI cleanup: removed the FR24 tab and redundant buttons; cleaner ATIS display.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.14</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📲 <b>入口頁連網開一次,順手把「今日」最新資料也抓下來存好——之後離線開今日就有剛更新的內容,不必先進今日。</b></div>
      <div>📲 <b>Opening the hub online now also fetches Today's latest data — so Today shows fresh content offline without opening it first.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.13</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔧 <b>離線真的修好——啟動頁不再用 iOS 會拒存的 no-store 標頭;入口頁存完即驗證、存不進會明白標示。</b></div>
      <div>🔧 <b>Offline really fixed — launch pages no longer use the no-store header that iOS refuses to cache; the hub now verifies the cache and shows a clear status.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.12</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔧 <b>入口頁改由自己預存(不靠多重 SW);(此版 iOS 仍卡,V9.4.13 才真正解掉)。</b></div>
      <div>🔧 <b>Hub precaches itself instead of relying on multiple SWs (iOS still stuck here; fully fixed in V9.4.13).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.11</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔧 <b>修好入口頁離線快取被一個轉址檔拖垮整批;CrewSync 說明改 ATFM。</b></div>
      <div>🔧 <b>Fixed offline cache broken by one redirecting file; CrewSync tagline now shows ATFM.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.10</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>✅ <b>入口頁每個 app 顯示「離線就緒」——上線開一次,看到三個都打勾再切飛航就穩。</b></div>
      <div>✅ <b>The hub shows each app's "offline ready" status — wait for all three before going offline.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.09</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📴 <b>只裝入口頁、上線開一次,三個 app 全部都能離線開(看最後一次資料)。</b></div>
      <div>📴 <b>Install just the hub, open it online once — all apps work offline.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.08</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔧 <b>修 ATIS 換到沒資料的來源時切換鈕消失、切不回來;歐洲 cookie 存資料庫,部署重啟自動復原不熄燈。</b></div>
      <div>🔧 <b>Fix ATIS switch button vanishing on an empty source; persist Europe cookie so it survives restarts.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.07</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔀 <b>切換鈕改顯示「按了會變成什麼」（ATIS 換來源、ATFM Key/Events）。</b></div>
      <div>🔀 <b>Toggle buttons now show what tapping switches to.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.06</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📡 <b>ATIS 可換來源——創始會員一鍵切換資料來源（撈到舊的就換一家撈新的），一般會員照讀快取。</b></div>
      <div>📡 <b>ATIS source switch — founders swap the data source in one tap for fresher ATIS; others read the shared cache.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.05</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🌐 <b>ATFM 新增 Key/Events 切換——預設只看重點清單機場，一鍵切換看全部正在管制的機場（美國也補上 FAA 即時管制場）；點機場自動展開資訊面板；預設載入定位台灣。</b></div>
      <div>🌐 <b>ATFM adds Key/Events toggle — curated list by default, switch to all airports under active restriction (incl. US FAA); tap auto-opens the info panel; opens at Taiwan.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.04</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🟢🔵 <b>ATFM 歐洲大升級——加綠燈底圖（主要樞紐＋布拉格等航點平常顯綠）；事件分三級：紅＝關場、黃＝真管制（天氣／罷工／跑道關）、藍＝資訊告示（施工／設施，不影響流量），不再一片黃。燈號說明改可收合。</b></div>
      <div>🟢🔵 <b>ATFM Europe overhaul — green baseline for major hubs &amp; destinations; events tiered red/amber/blue (closure / real restriction / info-only), no more all-amber. Collapsible legend.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.03</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>ATFM 歐洲穩定性——保活加快 + 資料續用，歐洲不再突然熄燈、維持即時。</b></div>
      <div>🚦 <b>ATFM Europe stability — faster keep-alive + data fallback; Europe no longer goes dark, stays live.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.02</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>ATFM 歐洲修正——機場事件不再重複（紅點卻顯示 No data），並加強保鮮讓歐洲不會熄燈。</b></div>
      <div>🚦 <b>ATFM Europe fixes — no more duplicate airport entries (red dot showing "No data"); keep-alive so Europe data stays lit.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.4.01</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>ATFM 新增歐洲——EUROCONTROL 網路事件（機場關閉／罷工／維修／天氣／軍事區），有事件的機場上色＋列出原因。</b></div>
      <div>🚦 <b>ATFM adds Europe — EUROCONTROL network events (closures, strikes, works, weather, military zones); affected airports flagged with the reason.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.3.02</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>ATFM 底部資訊面板可收合——點面板上方把手收起、騰出地圖空間，狀態會記住。</b></div>
      <div>🚦 <b>ATFM bottom panel is now collapsible — tap the handle to free up the map; remembers your choice.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.3.01</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>ATFM 新增越南（河內）流量管制；修正點機場面板頂走頁首與地圖回彈；📡 FR24 飛行軌跡修復。</b></div>
      <div>🚦 <b>ATFM adds Vietnam (Hanoi) flow control; fixed airport-tap panel pushing the header &amp; map bounce; 📡 FR24 flight trail restored.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.2.01</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>ATFM 改為全球地圖：可無限左右拖動，直接點機場看該場 CTOT（出發／到達），並加入長榮、華航北美航點作為未來潛在點。</b></div>
      <div>🚦 <b>ATFM is now a global map — pan freely and tap any airport for its CTOT (departures/arrivals); added EVA Air &amp; China Airlines North America stations as future points.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.1.02</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>ATFM 的 CTOT 表改用「出發 / 到達」切換（看到達不用再滑出發），並加航班／機場搜尋。</b></div>
      <div>🚦 <b>ATFM CTOT now toggles Departures / Arrivals (no scrolling) + flight/airport search.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.1.01</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>ATFM 擴充——CTOT 分出發/到達、新增美國（FAA）與日本/韓國機場狀態、iPad 版號邊距修正。</b></div>
      <div>🚦 <b>ATFM update — CTOT split by departure/arrival; added US (FAA) + Japan/Korea airport status; iPad label fix.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V9.0.01</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🚦 <b>新增 ATFM 流量管制——地圖顯示亞太機場即時管制狀態（GDP / Ground Stop），點地區看 CTOT；Gate Info 小修與 iPad 排版優化。</b></div>
      <div>🚦 <b>New ATFM flow control — live map of Asia-Pacific airport restrictions (GDP / Ground Stop), tap a region for CTOT; Gate Info fixes &amp; iPad layout tweaks.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.1.01</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛫 <b>Gate Info 新增機場切換，加入日本新千歲、函館（含 gate），ALL 改為顯示全部航空；後台優化。</b></div>
      <div>🛫 <b>Gate Info adds airport switching with New Chitose &amp; Hakodate, Japan (incl. gate); ALL now shows all airlines; backend improvements.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.59</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🔧 <b>後台優化與穩定度調整。</b></div>
      <div>🔧 <b>Backend improvements and stability tweaks.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.56</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 來源升級更穩：美國走官方 FAA、其他改更可靠來源、ATIS 改點開機場才抓。</b></div>
      <div>📻 <b>ATIS sources upgraded for reliability (US via FAA, others more reliable, ATIS loads on airport open).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.55</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>衛星圖快取這次真的修好：不透明圖磚也存，重開同一機場秒出不再重抓。</b></div>
      <div>🛰️ <b>Satellite-map cache truly fixed — opaque tiles are now cached, so reopening an airport is instant.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.54</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 修復、天氣詳情先秒出 ATIS 背景補上、RCTP 衛星圖修好。</b></div>
      <div>📻 <b>ATIS fixed, weather shows instantly with ATIS loading in background, RCTP map fixed.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.52</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🌦️ <b>天氣 TAF 改自家 server 直連恢復快穩；PA 下降廣播時間欄加大好填。</b></div>
      <div>🌦️ <b>TAF now fetched directly via our server (fast again); descent PA time fields widened.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.51</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>Pacific HF 移到 Tools、嵌入工具改全螢幕浮層；底部分頁列等寬鋪滿。</b></div>
      <div>📻 <b>Pacific HF moved to Tools, embedded tools now full-screen; bottom tab bar evenly fills width.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.48</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>💬 <b>關於頁最上方新增「加入社群」按鈕，一鍵到 LINE 社群回報。</b></div>
      <div>💬 <b>Community link added at the top of the About page — tap to open the LINE group.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.47</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>✏️ <b>App 入口頁（/apps）用字修正。</b></div>
      <div>✏️ <b>Fixed wording on the app hub (/apps).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.46</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🧹 <b>App 入口頁（/apps）標題精簡。</b>瀏覽器分頁／加到主畫面時的標題由「H-Peak 飛行工具 · Apps」改成「Apps」，頁尾只留網域。</div>
      <div>🧹 <b>Tidied the app hub (/apps) title.</b> The browser / home-screen title is now just "Apps" (was "H-Peak 飛行工具 · Apps"); the footer shows only the domain.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.45</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>後台維護與安全性強化。</b>本次為背景維護與安全性更新，使用者操作與介面不變。</div>
      <div>🛠️ <b>Backend maintenance &amp; security hardening.</b> Background maintenance and security update; nothing changes in how you use the app.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.44</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>修正衛星圖跑道線歪斜對不準；Airport WX 跑道圖可點標題收合。</b></div>
      <div>🛠️ <b>Fixed skewed runway lines; Airport WX runway map is now collapsible.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.43</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🗺️ <b>Airport WX 加跑道圖、所有 Ops Spec 機場底圖永久快取、新增 App 入口頁 /apps。</b></div>
      <div>🗺️ <b>Runway maps in Airport WX, all Ops Spec tiles cached permanently, new app hub at /apps.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.42</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛬 <b>班表 WX 展開後，起降兩地各多一張依即時風向標色的跑道圖（可收合）。</b></div>
      <div>🛬 <b>Expanding a flight's WX now shows a wind-coloured runway map for both ends (collapsible).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.41</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🗂️ <b>同步班表時多存一份完整班表（含組員）到雲端私有表，給 Pilot Log 直接匯入用。</b></div>
      <div>🗂️ <b>Each roster sync now saves a private full copy (incl. crew) for Pilot Log to import directly.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.40</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>⛅ <b>Airport WX 機場分組更新至 Ops Spec C-6 Amdt 070 + 071。</b></div>
      <div>⛅ <b>Airport WX fleet groupings updated to Ops Spec C-6 Amdt 070 + 071.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.39</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📊 <b>投資組合 V1.0.6：資產變化圖加時間範圍、補歷史按鈕回填趨勢、持股快速加交易、均價雙派並列。</b></div>
      <div>📊 <b>Portfolio V1.0.6: chart range selector, backfill button, quick-add per holding, dual cost-basis view.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.38</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📊 <b>投資組合 V1.0.5：交易紀錄可編輯、主畫面加資產變化圖（日/月/年切換）。</b></div>
      <div>📊 <b>Portfolio V1.0.5: editable transactions + asset history chart (daily/monthly/yearly).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.37</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📊 <b>投資組合 V1.0.4：台股手續費 + 證交稅自動計算（可手動覆寫），併入成本與損益。</b></div>
      <div>📊 <b>Portfolio V1.0.4: auto Taiwan broker fee + transaction tax (manual override), folded into cost/PnL.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.36</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📊 <b>投資組合 V1.0.3 修正：A+/A- 字型按了沒變化的問題。</b></div>
      <div>📊 <b>Portfolio V1.0.3 hotfix: A+/A- font-scale buttons had no visible effect.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.35</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📊 <b>投資組合 V1.0.2：UX 對齊晨報，漲跌顏色改台股慣例（漲紅跌綠）。</b></div>
      <div>📊 <b>Portfolio V1.0.2: UX aligned with morning report; up/down colors switched to Taiwan convention.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.34</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📊 <b>投資組合 V1.0.1：補上日夜切換、字型 ±、版次與更新歷史等基本 UX。</b></div>
      <div>📊 <b>Portfolio V1.0.1: added the basic UX (theme toggle, font ±, version tag, changelog).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.33</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📊 <b>投資組合 V1 修正：modal 全擠在一起誤導要設 PIN（PIN 其實預設關）；PIN 放寬為任意字元。</b></div>
      <div>📊 <b>Portfolio V1 hotfix: modals stacked, falsely implying forced PIN (it's opt-in); PIN now any characters.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.32</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🎉 <b>投資組合 V1.0.0 上線：獨立 /portfolio 子系統（交易帳本 + 三視角 + opt-in PIN），並新增 oops.h-peak.com 網域。</b></div>
      <div>🎉 <b>Portfolio V1.0.0 launch: standalone /portfolio (ledger + three views + opt-in PIN); new oops.h-peak.com domain.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.31</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>清掉重複的 .js 編譯檔，讓 .ts 成為唯一原始碼，根治「改了沒生效」的推版問題。</b></div>
      <div>🛠️ <b>Removed duplicate compiled .js so .ts is the sole source, fixing no-op releases for good.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.30</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>修正 V8.0.27～29 三版未生效的根本原因（同名雙檔只改到 .js），把修正同步進去。</b></div>
      <div>🛠️ <b>Fixed why V8.0.27–29 never took effect (dual-source file edited on the wrong copy); carried the fixes through.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.29</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>修正 PWA 永遠卡舊版：cache 名稱改隨版次自動變動，新版自動清掉舊快取。</b></div>
      <div>🛠️ <b>Fixed PWA stuck on old version: cache name now changes per release so the old cache auto-clears.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.28</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>修正 Briefing OT 警告對 DHD（表定 FT 00:00）誤判成永遠超時，改用起降時間推算。</b></div>
      <div>🛠️ <b>Fixed Briefing OT warning always triggering on DHD (sched FT 00:00); now uses dep/arr times.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.27</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>修正班表登入錯誤訊息誤報「密碼錯」，改帶真實原因；登入等待時間拉長避免誤判。</b></div>
      <div>🛠️ <b>Fixed roster login falsely reporting "wrong password"; error now shows the real cause, longer timeout.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.26</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>Briefing OT 警告比對更穩、Groups 清掉合併前舊群組、Duty Time 改即時儲存與自動重算。</b></div>
      <div>🛠️ <b>Sturdier Briefing OT matching, Groups legacy cleanup, Duty Time instant-save + auto-recalc.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.25</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>⛅ <b>機場分類資料表更新至 Ops Spec C-6 Amdt 069（APR 01 2026），共 8 項調整。</b></div>
      <div>⛅ <b>Airport classification table updated to Ops Spec C-6 Amdt 069 (APR 01 2026), 8 changes.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.24</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛠️ <b>班表同步穩定性大改造：慢網不再整份失敗、保留已抓到的班、完成頁分完整／部分／失敗三態。</b></div>
      <div>🛠️ <b>Roster sync reliability overhaul: survives slow networks, keeps captured duties, three-state result.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.23</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🗺️ <b>Briefing Room 連結旁加一個小輸入格，可自己填 briefing room 代碼（自動存、隨歷史還原）。</b></div>
      <div>🗺️ <b>Added a small input beside the Briefing Room link to note your room code (auto-saved with history).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.22</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🗺️ <b>修正 Briefing Room 圖在 PWA 沒地方關，改成 app 內全螢幕浮層（✕ 關閉、可雙指縮放）。</b></div>
      <div>🗺️ <b>Fixed Briefing Room image with no close button in PWA; now an in-app modal (✕ close, pinch-zoom).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.21</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🗺️ <b>Briefing 加 Briefing Room 平面圖連結；輸入 FT 時自動比對表定、可能超時就跳黃色警告。</b></div>
      <div>🗺️ <b>Briefing adds a Briefing Room floor-plan link; entering FT auto-compares scheduled and warns on likely OT.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.20</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📝 <b>Briefing 改為每字即時自動存，搜尋列旁加儲存狀態小圓點（🟡 存檔中 / 🟢 已儲存）。</b></div>
      <div>📝 <b>Briefing now auto-saves as you type, with a status dot beside the search row (🟡 saving / 🟢 saved).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.19</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📅 <b>Briefing 新增歷史功能：月曆檢視過往 briefing 可點選載入；NOTES 加固定標題與 POB 自動加總。</b></div>
      <div>📅 <b>Briefing adds history: a calendar view to reload past briefings; NOTES get fixed labels and POB auto-sum.</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.18</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>修正退出群組時未清理 sharing 和班表資料的 bug：退出最後一個群組後自動設 sharing=false 並刪除雲端班表</div>
      <div>Fix: leaving last group now auto-disables sharing and deletes roster data from cloud</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.17</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>新增「晨報 Morning Report」PWA，掛在 /morning 獨立路由，擁有自己的 icon、manifest、Service Worker 和版次；CrewSync icon 升級為深藍夜空 + 雲海 + 飛機的新設計</div>
      <div>Added Morning Report PWA at /morning with independent icon, manifest, Service Worker and versioning; CrewSync icon upgraded with night sky, clouds, and plane design</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.16e</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Friends/Groups grid 加入底部 120px spacer 修正最後一列被切、Tab bar 斷點下調至 600px 修正 iPad 直拿</div>
      <div>Friends/Groups grid added 120px bottom spacer for last row, tab bar breakpoint lowered to 600px for iPad portrait</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.15a</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Groups grid 修正：iPad 垂直捲動 + 水平卷軸修正、.ts/.js 同步修正</div>
      <div>Groups grid fix: iPad vertical scroll + horizontal scrollbar fix, .ts/.js sync fix</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.14</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Overtime Calculator 結果文字調整：強調額外營運成本提示</div>
      <div>Overtime Calculator result text update: highlight additional operational costs warning</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.13</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Overtime Calculator UI 優化：header 精簡、航班選單與月份同行、iPad 橫拿捲動修正、已完成航班警語</div>
      <div>Overtime Calculator UI improvements: compact header, inline month & flight selector, iPad landscape scroll fix, completed flight warning</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.12</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>新增 Overtime Calculator subtab（Flight Crew），從班表自動帶入航班時間、月份切換、跨月航班支援、手動輸入模式、24hr 快取</div>
      <div>New Overtime Calculator subtab (Flight Crew): auto-load flights from roster, month navigation, cross-month flight support, manual input mode, 24hr cache</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.11</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Groups All 群組篩選修正：CC 不顯示機隊下拉；Groups / Friends 記憶上次選擇的群組（30 天快取）</div>
      <div>Groups All filter fix: hide fleet dropdown for CC; Groups / Friends remember last selected group (30-day cache)</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.10</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>👥 <b>Groups 加入即自動分享、改下拉選單 + 職級篩選；CC Rest Calculator 取消密碼鎖正式開放。</b></div>
      <div>👥 <b>Groups: join = auto-share, dropdown + rank filter; CC Rest Calculator unlocked (no password).</b></div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.08</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Friends 拿掉分享 toggle、說明文字更新；Groups ⓘ 修正；加入群組自動開分享；0 人群組自動刪除；離線快取 30 天過期</div>
      <div>Friends remove share toggle, updated descriptions; Groups ⓘ fix; auto-share on join; auto-delete empty groups; 30-day cache expiry</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.07</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Cabin Crew Rest Calculator（Beta）、FC/CC 身分連動 Friends、Cabin subtab 拖移排序、時區加場站名</div>
      <div>Cabin Crew Rest Calculator (Beta), FC/CC role sync with Friends, Cabin subtab drag reorder, timezone with station names</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.06</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>新增 Cabin Crew tab + 預設群組改版（FC 6 + CC 3 + All）、手機 tab bar 可捲動、分享選 FC/CC 身分</div>
      <div>New Cabin Crew tab, preset groups redesign (FC 6 + CC 3 + All), mobile tab bar scrollable, FC/CC role selection</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.05</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Training duty（RT）拆分 PT/PC 子項目、每天獨立組員名單；Groups 排版修正、toggle 與名稱同行、ⓘ 修正</div>
      <div>Training duty (RT) split into PT/PC sub-items with per-day crew; Groups layout fix, inline toggles, ⓘ fix</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.03</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Groups 排版修正：隱藏不符合群組、header 固定、toggle 與名稱同行、ⓘ 修正、Friends 重複按鈕修正</div>
      <div>Groups layout fix: hide non-matching groups, fixed header, inline toggles, ⓘ fix, Friends duplicate button fix</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.02</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Groups 手機版排版修正：隱藏不符合機隊/職級的群組、header 固定不捲動</div>
      <div>Groups mobile layout fix: hide non-matching groups, fixed header</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.01</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>新增 Groups 群組功能：10 個預設群組（All + 9 個機隊職級）、自訂好友圈、邀請碼加入、員工編號邀請、紅點通知</div>
      <div>New Groups feature: 10 preset groups (All + 9 fleet/rank), custom friend circles, invite code, employee ID invitation, notification badge</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V7.0.15</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Briefing 日期切換改 ◀ M/D ▶ 支援前一天；Gate Info 移除標題、警語改黃色；隱私權政策補齊第三方服務</div>
      <div>Briefing date nav changed to ◀ M/D ▶ with yesterday support; Gate Info title removed, warning in yellow; privacy policy third-party services updated</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V7.0.14</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>About card 加註 Android 裝置可能無法正確顯示；FAQ 修正日曆授權說明以符合隱私權政策</div>
      <div>About card adds Android display note; FAQ corrects calendar authorization description to align with privacy policy</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V7.0.13</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>PA Welcome 出發分鐘數快取保留、Descent 點選場站帶入中文目的地</div>
      <div>PA Welcome departure minutes persisted; Descent tap-to-select fills Chinese destination</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V7.0.12</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>WX 單一機場更新按鈕加入載入狀態，清除 24hr 快取強制重新抓取</div>
      <div>WX single airport refresh button shows loading state, clears 24hr cache</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V7.0.11</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>手機直拿 Friends header 分兩行排列，第一行可滑動、第二行月份置中+篩選靠右</div>
      <div>Mobile portrait Friends header split into two rows</div>
    </div>
    </div>
    <div style="font-size:.68em;color:var(--muted);margin-top:12px;margin-bottom:10px;display:flex;gap:16px;justify-content:center">
      <a href="/privacy" onclick="openLegal('/privacy');return false" style="color:var(--muted);text-decoration:underline">Privacy Policy 隱私權政策</a>
      <a href="/terms" onclick="openLegal('/terms');return false" style="color:var(--muted);text-decoration:underline">Terms of Service 服務條款</a>
    </div>
    <button class="install-close-btn" onclick="closeAbout()">關閉</button>
  </div>
</div>

<!-- 隱私與安全 -->
<div id="privacy-overlay" class="install-overlay" style="display:none" onclick="if(event.target===this)closePrivacy()">
  <div class="privacy-card" style="text-align:center">
    <div style="font-size:1.5em;margin-bottom:6px">🔒</div>
    <div style="font-weight:700;font-size:1em;margin-bottom:18px">隱私與安全 / Privacy & Security</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:18px">
      <a href="/faq" onclick="openLegal('/faq');return false" style="display:block;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:10px;color:var(--text);text-decoration:none;font-size:.88em;font-weight:600">❓ FAQ 隱私與安全問答</a>
      <a href="/privacy" onclick="openLegal('/privacy');return false" style="display:block;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:10px;color:var(--text);text-decoration:none;font-size:.88em;font-weight:600">📋 Privacy Policy 隱私權政策</a>
      <a href="/terms" onclick="openLegal('/terms');return false" style="display:block;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:10px;color:var(--text);text-decoration:none;font-size:.88em;font-weight:600">📄 Terms of Service 服務條款</a>
    </div>
    <button class="install-close-btn" onclick="closePrivacy()">關閉</button>
  </div>
</div>

<!-- iframe 彈窗（Privacy / Terms / FAQ） -->
<div id="legal-overlay" style="display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center" onclick="if(event.target===this)closeLegal()">
  <div style="position:relative;width:94vw;max-width:600px;height:85vh;background:var(--bg,#0a0e1a);border-radius:14px;overflow:hidden">
    <button onclick="closeLegal()" style="position:absolute;top:8px;right:12px;z-index:1;background:none;border:none;color:var(--text,#fff);font-size:1.5em;cursor:pointer">✕</button>
    <iframe id="legal-iframe" src="" style="width:100%;height:100%;border:none"></iframe>
  </div>
</div>

`;
}
