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
      <button class="btn btn-secondary" id="copy-log-btn" onclick="copyLog()" style="flex:1">📋 複製紀錄 Copy Log</button>
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
        <option value="A321">A321</option>
        <option value="A330">A330</option>
        <option value="A350-900" selected>A350-900</option>
        <option value="A350-1000">A350-1000</option>
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
        <div style="display:flex;flex-direction:column;gap:6px">
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
  <button class="tab-btn" id="tabBtn-fr24" onclick="switchTab('fr24',this)">
    <span class="tab-btn-icon">📡</span>FR24
  </button>
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
      <span style="font-size:.55em;color:var(--muted);line-height:1;opacity:.7;cursor:pointer;text-decoration:underline" onclick="showAbout()">V9.4.06</span>
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
    <div style="font-size:.78em;font-weight:700;margin-bottom:6px" id="about-version">V9.4.06</div>
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
      <div>📻 <b>ATIS 來源升級,更穩。</b>美國機場改走官方 FAA 源;其他機場改走更可靠的資料源;一鍵更新改成只刷天氣(ATIS 改成「點開機場才抓」,省資源)。</div>
      <div>📻 <b>ATIS sources upgraded for reliability.</b> US airports now use the official FAA feed; other airports use a more reliable source; Refresh All updates weather only (ATIS loads when you open an airport).</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.55</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛰️ <b>衛星圖快取「這次真的」修好。</b>上一版把快取改成「只存成功回應」，但衛星圖磚是跨網域的不透明回應、判斷不出成功 → 反而每次打開機場都重新下載、先空白再載。這版改成跟 Pilot Log 一樣的寫法（不透明圖磚也存、命中就秒出），重複打開同一機場不再重抓。</div>
      <div>🛰️ <b>Satellite-map cache actually fixed now.</b> The previous version cached only “successful” responses, but cross-origin map tiles are opaque and can’t be judged successful — so every airport reopen re-downloaded the map (blank, then reload). This matches Pilot Log’s caching (opaque tiles are cached too), so reopening the same airport is instant.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.54</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>ATIS 修復 ＋ 天氣載入加速 ＋ RCTP 衛星圖修。</b>ATIS 改成「你的瀏覽器經 allorigins 代理抓」（atis.guru 擋我們伺服器 IP，server 端抓不到）；天氣詳情改成 METAR/TAF/跑道圖先秒出、ATIS 背景補上，不再整頁卡等；修「衛星圖快取把失敗回應也存住」害 RCTP 圖出不來（改成只存成功的、壞的自動重抓）；Tools 入口文字改清楚（入口本身也能加到主畫面）。</div>
      <div>📻 <b>ATIS fixed + faster weather load + RCTP map fix.</b> ATIS is now fetched from your browser via the allorigins proxy (atis.guru blocks our server IP); weather details now show METAR/TAF/runway map instantly with ATIS loading in the background; fixed the satellite-map cache storing failed responses (which broke the RCTP map — now only successes are cached and bad ones re-fetched); clarified the Tools hub text.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.52</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🌦️ <b>天氣 TAF 修復 ＋ PA 時間欄位加大。</b>Airport WX 的 TAF 之前繞的免費代理掛了、抓不到也很慢 → 改走自己 server 直連，恢復又快又穩；PA「下降」廣播的時間欄（HH:MM）放大好填。</div>
      <div>🌦️ <b>TAF fixed + bigger PA time fields.</b> Airport WX's TAF no longer routes through a (now-broken) free proxy — fetched directly via our own server, fast and reliable again; the descent PA's HH:MM time fields are wider.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.51</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>📻 <b>Pacific HF 移到 Tools、嵌入工具改全螢幕浮層。</b>HF 分頁移除，改成 Tools 裡一顆按鈕直接開瀏覽器；Tools 嵌入工具（颱風/GPSjam）改全螢幕浮層，修掉把分頁推走、卡住的問題。A+/A- 改上下直排、iPad 底部分頁列改等寬鋪滿（平均分散，多一顆鈕也不換行）；從 Tools 入口進來時右下角多一顆回 Tools 鈕（彩色四格）。</div>
      <div>📻 <b>Pacific HF moved to Tools; embedded tools go full-screen.</b> The HF tab is gone — now a Tools button that opens in your browser; embedded tools (typhoon/GPS-jam) go full-screen, fixing the layout-push/stuck issue. A+/A- now stack vertically and the iPad bottom tab bar evenly fills the width; a Tools button appears bottom-right when launched from the Tools hub.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.48</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>💬 <b>加入社群連結。</b>關於頁最上方新增「加入社群 · Money 回報區」按鈕，點一下直接到 LINE 社群（所有軟體的回報都在這）。</div>
      <div>💬 <b>Community link added.</b> A "Join our community" button now sits at the top of the About page — tap to open the LINE group (feedback for all the apps).</div>
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
      <div>🛠️ <b>修正跑道圖對不準 + Airport WX 跑道圖可收合。</b><b>(1)</b> 修正衛星圖上<b>跑道線歪斜對不準</b>（之前為高緯機場加的經度補償，讓地圖範圍比例跟圖檔不符、Esri 自動微調範圍所致）→ 範圍比例直接對齊圖檔 640:440，跑道線貼齊真實跑道。<b>(2)</b> Airport WX 的跑道圖可<b>點標題收合</b>（記憶偏好，比照 roster）。<b>(3)</b> /apps 入口頁移除頁面大標題。</div>
      <div>🛠️ <b>Fixed runway misalignment + collapsible runway map in Airport WX.</b> (1) Runway lines were skewed off the real runways (a longitude compensation made the extent ratio mismatch the image, so Esri auto-adjusted the bbox); the ratio now matches the image (640:440) and lines align. (2) The Airport WX runway map is collapsible (tap the title, remembers your choice). (3) Removed the page heading on /apps.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.43</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🗺️ <b>跑道圖擴大到 Airport WX + 所有 Ops Spec 機場底圖永久快取 + App 入口頁。</b><b>(1)</b> 在 Airport WX 點機場看 METAR/TAF 時，上方加一張<b>跑道圖</b>（依即時風向標綠[逆風]/橘[順風]端 + 逆風/側風分量 + 風向箭頭，比照 Pilot Log）。<b>(2)</b> 開 App 背景把<b>所有 Ops Spec 機場</b>的衛星底圖預抓進<b>永久快取</b>（跟 Pilot Log 同網域共用、改版也不清）→ 看過沒看過、離線都秒出。<b>(3)</b> 新增 App 入口頁 <code>/apps</code>：一頁拿到 CrewSync / Pilot Log / 晨報 + 加到主畫面教學（可貼社群置頂）。</div>
      <div>🗺️ <b>Runway maps in Airport WX + all Ops Spec tiles cached permanently + app hub.</b> (1) Airport WX now shows a runway map above METAR/TAF (green/orange ends by live wind + head/crosswind components + arrow, same as Pilot Log). (2) On launch, all Ops Spec airport satellite tiles are prefetched into a persistent cache (shared with Pilot Log on the same domain, survives updates) — instant on re-open or offline. (3) New app hub at <code>/apps</code>: CrewSync / Pilot Log / Morning on one page with an add-to-home-screen guide (pin it in your community).</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.42</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🛬 班表的 <b>WX</b> 展開後，起降兩地各多一張<b>跑道圖</b>（比照 Pilot Log）：依真實座標畫出每條跑道、標跑道號與長 × 寬，依<b>即時 METAR 風向</b>把<b>逆風端標綠、順風端標橘</b>，每條跑道旁標逆風／側風分量，左上角加風向箭頭。跑道圖可<b>收合</b>（記住偏好）。</div>
      <div>🛬 Expanding a flight's <b>WX</b> in the roster now shows a <b>runway map</b> for both departure and arrival (same as Pilot Log): each runway drawn from real coordinates with its number and length × width, ends coloured <b>green (into-wind) / orange (downwind)</b> by live METAR wind, headwind/crosswind components beside each runway, and a wind arrow. Maps are <b>collapsible</b> (remembers your choice).</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.41</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🗂️ 同步班表時，多存一份<b>完整班表（含組員）</b>到雲端私有表，給 <b>Pilot Log</b> app 直接帶班表用。解決把 CrewSync 與 Pilot Log 各自加到 iPad 主畫面後、變成兩個獨立 App 不共用瀏覽器儲存、Pilot Log 抓不到班表的問題。這份是<b>你自己的、不會分享給朋友/群組</b>（跟「分享班表」功能完全分開、不剃組員）。沿用方式：在 Pilot Log 按 Import Roster 前，先在這裡<b>重新同步一次</b>當月（及想補登的月份），且兩邊用<b>同一個 Google 帳號</b>。</div>
      <div>🗂️ On each roster sync, a full copy (incl. crew) is now saved to a private cloud table for the <b>Pilot Log</b> app to import directly — fixing the case where CrewSync and Pilot Log are added to the iPad home screen as two separate apps that don't share browser storage, so Pilot Log couldn't find the roster. This copy is <b>yours only, never shared</b> to friends/groups (entirely separate from the Share feature, crew not stripped). To use it: re-sync the month(s) here once before pressing Import Roster in Pilot Log, and use the <b>same Google account</b> on both.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.40</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>⛅ Airport WX 機場分組更新至 Ops Spec. C-6 Amdt 070（MAY 11 2026 生效）+ Amdt 071（MAY 29 2026 生效）：(1) A321-252NX：移除 RCFN（台東）— Amdt 071。(2) A350-1041：RJFF（福岡）新增 Special 標、VMMC（澳門）拿掉 Special 標 — Amdt 070。順手把 <code>cls</code> 編碼規則寫進 <code>airport-data.js</code> 註解 header（A / S 為主類別，RF / P 等視為附加屬性、不另開新代碼），未來 amend 時不會走偏。</div>
      <div>⛅ Airport WX fleet groupings updated to Ops Spec. C-6 Amdt 070 (effective MAY 11 2026) + Amdt 071 (effective MAY 29 2026): (1) A321-252NX — removed RCFN (Taitung) per Amdt 071. (2) A350-1041 — RJFF (Fukuoka) added Special tag, VMMC (Macao) removed Special tag per Amdt 070. Also codified the <code>cls</code> encoding rule in <code>airport-data.js</code> header comment (A / S as primary class; RF / P treated as supplementary attributes, no new codes added) to prevent future amendments from drifting.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.39</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Portfolio V1.0.6: 1) 資產變化圖加 range — 日 30/60/90、月 12/24/36、年 5/10/20。2) 加「📥 補歷史」按鈕從 Yahoo Finance 拉 daily close 回填 portfolio_snapshots，跑 backfill 後就能看到趨勢（V1.0.5 只 snapshot 今天無歷史 user 抱怨「只給我當下我怎麼知道變化」）。3) 主畫面持股 row 加 ＋ 按鈕，點開 pre-fill symbol/market 不用再輸入。4) Detail 頁加「均價（原始）」/「未實現損益（原始）」雙派同時顯示 — 扣息派 vs 原始派並列，差額 × qty = 累計領股利。</div>
      <div>Portfolio V1.0.6: 1) Asset chart range selector — daily 30/60/90, monthly 12/24/36, yearly 5/10/20. 2) 「📥 Backfill」button pulls daily close from Yahoo Finance and replays transactions to fill portfolio_snapshots (V1.0.5 only had today's snapshot). 3) Quick-add ＋ button on each holding row, pre-fills symbol/market. 4) Detail page shows both cost-basis methods side-by-side: dividend-adjusted avgCost vs raw avgCost (and corresponding unrealized PnL); the diff × qty = total cash dividend received.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.38</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Portfolio V1.0.5: 1) 交易紀錄每筆加 ✏️ 編輯按鈕（user 反映「萬一打錯只能重來」），複用加交易 modal edit mode 可改日期/股數/價格/手續費/備註，symbol/方向鎖住。2) 主畫面加 📊 <strong>資產變化圖</strong>，按日/月/年切換 — daily cron 23:30 台北 snapshot 全 user 的 portfolio 總值，從 V1.0.5 上線那天開始累積。Chart.js 4.4.7 CDN 載入 (~90KB)。</div>
      <div>Portfolio V1.0.5: 1) ✏️ Edit button on each transaction (user feedback "what if I mistype"); reuses add-txn modal in edit mode — date/qty/price/fee/note editable, symbol/side locked. 2) 📊 Asset history chart with daily/monthly/yearly toggle. Daily cron at 23:30 Taipei snapshots all users' portfolio total value; chart accumulates from V1.0.5 launch. Chart.js 4.4.7 via CDN (~90KB).</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.37</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Portfolio V1.0.4: 台股手續費 + 證交稅自動算 — 買賣自動套用 0.1425% 手續費（最低 NT$20），賣方加 0.3% 證交稅。加交易 modal 即時 preview 估算 fee；同時保留**手動覆寫欄位**（user 從券商 app 抄實際 fee 填進去，留空就 auto-calc）。Cost basis 算法：買 fee 加進成本、賣 fee+稅扣 realized PnL；FIFO Lot 視角的賣出 fee 按各 lot 比例分配。Detail 頁交易紀錄每筆 buy/sell 後面顯示 (費 NT$X)。美股暫不算 fee（多數 broker $0 commission）。</div>
      <div>Portfolio V1.0.4: Auto Taiwan stock fees + capital gains tax — 0.1425% broker fee (min NT$20) on both sides, 0.3% transaction tax on sell. Add-txn modal shows live fee preview; manual override field also available (paste actual fee from broker app, leave blank for auto). Cost basis: buy fee added to cost, sell fee+tax deducted from realized PnL; FIFO lot view splits sell fee proportionally across lots. Detail txn rows show (fee NT$X) suffix. US side keeps fee=0 ($0 commission at most brokers).</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.36</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Portfolio V1.0.3 hotfix：A+/A- 字型按了沒變化 — CSS 寫成 <code>html, body { font-size: 15px }</code> 把 body 也寫死 15px，<code>bumpFont</code> 改 html inline style 但子元素 em 相對 body 算（body 還 15px）→ 視覺零變化。拆成 <code>html { font-size: 15px }</code> + <code>body { font-size: 1rem }</code>，body 跟著 root 動。</div>
      <div>Portfolio V1.0.3 hotfix: A+/A- font-scale buttons had no visible effect — CSS combined <code>html, body { font-size: 15px }</code> hardcoded body too; <code>bumpFont</code> changed html inline style but body kept overriding (children's em relative to body, not html). Split into <code>html { font-size: 15px }</code> + <code>body { font-size: 1rem }</code>.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.35</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Portfolio V1.0.2: UX 對齊晨報 — 1) 版號 / 字型 ± / 日夜切換按鈕從 footer + settings modal **搬到 header 右上**，跟晨報同位置（user 反映「都說了要對齊晨報」）。2) 漲跌顏色從歐美 convention（綠漲紅跌）改成**台灣股市慣例**（漲紅 / 跌綠），buy 紅 sell 綠也配合改。3) Theme button 改 icon only（☀️ / 🌙）。</div>
      <div>Portfolio V1.0.2: UX alignment with morning report — 1) Version tag / font ± / theme toggle moved from footer + settings modal **into the header top-right**, matching morning report position. 2) Up/down colors changed from Western (green up / red down) to Taiwan stock convention (red up / green down); buy/sell colors also flipped to match. 3) Theme button reduced to icon only.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.34</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Portfolio module 升 V1.0.1：補上晨報 / Pilot Log 都有的 UX 基本款 — 日夜切換、字型大小 ±、版次顯示、歷史更新（about modal）。沿用晨報的 <code>data-theme</code> + <code>font-scale</code> localStorage pattern，theme + font 偏好跨裝置不同步（純本機 preference）。V1.0.0 launch 時設計遺漏，user 反映「晨報都有的東西怎麼沒看到」後補完。</div>
      <div>Portfolio module bump to V1.0.1: add the basic UX features that morning report and Pilot Log already had — light/dark toggle, font size ±, version tag, changelog history (about modal). Reuses the morning report's <code>data-theme</code> + <code>font-scale</code> localStorage pattern; theme + font are per-device (not cross-device). Filled the gap left by V1.0.0 launch after user feedback.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.33</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Portfolio V1 hotfix 2 個 bug：1) CSS <code>.modal {display:flex}</code> 蓋過 HTML <code>hidden</code> 屬性 → 所有 modal 同時顯示，最上面一層「設定 PIN」誤導 user 以為被強迫設 PIN（實際 PIN 是 opt-in 預設 OFF）。修法：CSS 加 <code>[hidden] {display:none !important}</code> 強制 hidden override 任何 author display。2) PIN 不再限制 4-6 碼數字 — 改成任意長度（min 1, max 72 byte = bcrypt 上限）、任意字元（數字 / 字母 / symbol），兩次輸入一致即可。</div>
      <div>Portfolio V1 hotfix for 2 bugs: 1) CSS <code>.modal {display:flex}</code> overrode HTML <code>hidden</code> attribute → all modals visible at once with「設定 PIN」on top, misleading users into thinking PIN was forced (it's opt-in, default OFF). Fix: <code>[hidden] {display:none !important}</code>. 2) PIN no longer restricted to 4-6 digits — any length 1-72 bytes, any character set, just needs the two entries to match.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.32</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>🎉 Portfolio module V1.0.0 + 新 domain 上線：</div>
      <div>1) 新增「投資組合」獨立子系統 <code>/portfolio</code> — 多筆 buy / sell 交易帳本、移動均價自動計算、配股配息（V2 加 auto 入帳）、FIFO Lot 詳細追蹤；三種視角同時呈現（整體實際持倉 / 每筆 buy 的 timing 回顧 / Lot 詳細）；opt-in PIN 保護（sessionStorage 解鎖、tab 關了要重輸）；跨裝置同步沿用晨報 user 暱稱機制。</div>
      <div>2) Domain rename — 新增 <code>oops.h-peak.com</code> alias（自嘲笨小孩感，跟 brand 主域 h-peak 呼應），老 <code>crewsync.h-peak.com</code> 保留 backward compat，現有 PWA 不受影響；新 user 用新 URL。</div>
      <div>3) 一次性 migration — 把舊 <code>morning_prefs.tw_holdings / us_holdings</code> 簡單持倉資料搬到新 <code>portfolio_transactions</code> 表（標 <code>source='migration'</code>），影響 3 個 user 共 4 筆 transactions：Dominic / 大全 / 湯湯。</div>
      <div>4) 新依賴：<code>bcryptjs ^3.0.3</code>（pure JS，~30KB，給 PIN feature 用）。</div>
      <div>Portfolio module 整體 ~1,800 行新 code 分 4 phase commit 累積（phase 1.A schema → 1.B CRUD + 三視角 → 1.C PWA frontend → 1.D PIN）；intentionally 跳過 phase 1.E（晨報 stocks read-only 改造），晨報短期維持現況 — Portfolio 是 source-of-truth，user 一旦進 Portfolio 加交易就不會回頭編晨報 holdings。V2 視 user 回饋再做 morning frontend cleanup + 配股配息 auto cron。</div>
      <div>🎉 Portfolio module V1.0.0 + new domain launch: 1) New independent Portfolio subsystem at <code>/portfolio</code> with multi-row buy/sell ledger, moving-average cost basis, stock/cash dividend support (auto-credit in V2), FIFO lot tracking — three views simultaneously (overall reality / per-buy timing retrospective / lot detail); opt-in PIN protection (sessionStorage unlock, re-enter on tab close); cross-device sync reuses morning report's nickname-based identity. 2) Domain rename — added <code>oops.h-peak.com</code> alias (self-deprecating brand fit), kept <code>crewsync.h-peak.com</code> backward compat. 3) One-shot migration of <code>morning_prefs.tw_holdings/us_holdings</code> into <code>portfolio_transactions</code> (3 users, 4 txns). 4) New dep: <code>bcryptjs ^3.0.3</code> (~30KB pure JS for PIN). ~1,800 LOC across phases 1.A-1.D; intentionally skipped phase 1.E (morning stocks read-only refactor) — Portfolio is source-of-truth; users won't go back to editing morning holdings once they use Portfolio.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.31</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Dual-source 收斂 — 永遠根治 V8.0.30 修的問題：砍掉 9 個 tracked <code>.js</code>（<code>server</code> / <code>morning</code> / <code>morning-builder</code> / <code>generate-ics-headless</code> / <code>spa/html-body</code> / <code>spa/js-core</code> / <code>spa/js-pilot-log</code> / <code>spa/js-weather</code> / <code>spa/styles</code>）+ 13 個 untracked stale 編譯產物，<code>.ts</code> 變唯一 source-of-truth。tsx 對 <code>'./xxx.js'</code> 的 import 會自動 fallback 到同名 <code>.ts</code>，所以 server.ts 不用改 import 路徑。<code>.gitignore</code> 加防護避免本機跑 tsc 再被誤 track。從此推版只改 <code>.ts</code>，不再有「改了 <code>.js</code> 但 prod 跑 <code>.ts</code>」這種白做工的可能。</div>
      <div>Dual-source consolidation — permanent fix for the issue V8.0.30 patched: removed 9 tracked <code>.js</code> files (<code>server</code> / <code>morning</code> / <code>morning-builder</code> / <code>generate-ics-headless</code> / <code>spa/html-body</code> / <code>spa/js-core</code> / <code>spa/js-pilot-log</code> / <code>spa/js-weather</code> / <code>spa/styles</code>) plus 13 untracked stale build artifacts, making <code>.ts</code> the sole source of truth. tsx automatically falls back from <code>'./xxx.js'</code> imports to the matching <code>.ts</code>, so server.ts import paths don't need to change. <code>.gitignore</code> now explicitly blocks the <code>.js</code> compilation outputs to prevent re-tracking if someone runs tsc locally. Going forward only the <code>.ts</code> needs to be touched, eliminating the「edited .js but prod runs .ts」class of no-op releases.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.30</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>修正 V8.0.27 / V8.0.28 / V8.0.29 三版皆未生效於 prod 的根本問題：<code>src/spa/html-body.ts</code> 跟 <code>html-body.js</code> 是同名雙檔（都被 git tracked），server.ts 雖 import <code>'./spa/html-body.js'</code>，但 tsx ESM resolver 優先解析到同名 <code>.ts</code> → prod runtime 永遠 serve V8.0.26 的 source。前三次推版只改 <code>.js</code> 沒改 <code>.ts</code>，等於白做。本版把 <code>.ts</code> 內容同步到 <code>.js</code> 最新版（含 V8.0.27～29 全部 fix），未來推版兩份要一起改直到 dual-source 收斂。</div>
      <div>Fix the root cause of V8.0.27/28/29 all failing to take effect in prod: <code>src/spa/html-body.ts</code> and <code>html-body.js</code> are dual-source files (both git-tracked); although server.ts imports <code>'./spa/html-body.js'</code>, tsx's ESM resolver prefers the same-named <code>.ts</code> → prod runtime always serves V8.0.26 source. The previous three releases only updated <code>.js</code> without touching <code>.ts</code>, so they were no-ops on prod. This release syncs <code>.ts</code> to match <code>.js</code> (carrying V8.0.27～29 fixes through), and going forward both files must be edited together until the dual-source situation is resolved.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.29</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>修正 PWA cache 永遠看到舊版本問題：Service Worker 的 cache name 寫死成 <code>'crewsync-v8026'</code>，每次推版都用同一個 cache name → SW activate handler 「刪除別的 cache key」永遠刪不到自己 → 舊 shell 永遠 cached，user kill PWA 重開仍看舊版號（V8.0.26 / V8.0.27 / V8.0.28 改完都沒生效）。改成從 SPA HTML 內動態抓當前 V8.0.X 字串組 cache name → 每次推版 cache name 自動跟著變 → 新 SW 自動 invalidate 舊 cache。</div>
      <div>Fix PWA cache stuck on old version: Service Worker cache name was hardcoded as <code>'crewsync-v8026'</code>, so every deploy reused the same cache key — SW activate handler's <code>delete keys !== CACHE</code> never cleared its own cache → app shell stuck at the cached old version (V8.0.26/27/28 all failed to take effect even after kill+reopen PWA). Now the cache name is derived dynamically from the current V8.0.X string in the SPA HTML, so it changes with every deploy and the new SW automatically invalidates the old cache.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.28</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>修正 Briefing 中 Overtime warning「表定 FT 00:00 → 任何輸入都顯示 OT」bug：root cause 是 DHD（deadhead，配位調機）任務班表系統會把 <code>flightTime</code> 寫成 <code>"00:00"</code>（DHD 計薪方式不算 FT），但 dep/arr time 還在（飛機還是要飛），DHD 也該算 OT。<code>_briefCalcSchedFTmin</code> 原本看到 <code>flightTime</code> 就用，parse 出 0 也回傳 → OT 警告基準變 0 → 永遠觸發。改成 parse 出 0 視為無效繼續走下方 dep/arr fallback 用 schedule dep/arr 算 schedFT（跟 Overtime 子頁 <code>_otCalcMagic</code> 同邏輯）。</div>
      <div>Fix Briefing Overtime warning「sched FT 00:00 → always triggers」bug: root cause is DHD (deadhead) tasks — roster system writes <code>flightTime="00:00"</code> for DHD (its pay logic excludes FT), but dep/arr times are still present (the plane still flies) and DHD should still trigger OT calc. <code>_briefCalcSchedFTmin</code> previously took <code>flightTime</code> as-is, returning 0 → OT baseline became 0 → warning always triggered. Now treats parsed value of 0 as invalid and falls through to dep/arr-based sched FT calculation (same logic as Overtime subtab <code>_otCalcMagic</code>).</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.27</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>修正 JX 班表登入流程：原本 <code>catch {}</code> 吞掉真實 error 硬塞「密碼錯」當 fallback 訊息，員工被誤導以為自己帳密錯但其實是 navigation timeout / network error。改為 <code>catch (e)</code> 接住 error 並 <code>log</code> cause，錯誤訊息帶實際原因方便排查（navigation timeout / network error / 真錯帳密）。同時把 <code>page.waitForNavigation</code> timeout 從 8 秒拉到 20 秒，避免班表發布日 JX 後端壅塞時 8 秒太短被誤判成密碼錯。</div>
      <div>Fix JX roster login flow: previously <code>catch {}</code> swallowed the real error and hardcoded "wrong password" as a fallback message, misleading users into thinking their credentials were wrong when it was actually a navigation timeout / network error. Changed to <code>catch (e)</code> that logs the cause; error message now includes the real reason (navigation timeout / network error / actual wrong credentials) for easier diagnosis. Also bumped <code>page.waitForNavigation</code> timeout from 8s to 20s — 8s was too aggressive during JX server congestion right after roster release.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.26</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>修正 Briefing 中 Overtime warning：統一航班號比對規則（去前導 0／去空白）、改用 flight-level 日期推算（學 overtime 子頁的方式，更穩）、找不到航班或算不出表定 FT 時改顯示診斷提示，不再靜默失敗。Groups 群組面板：清除 SFO/FO 合併前留下的舊群組（denylist 模式，只刪明確列出的 legacy id，未來新增機隊／preset 不會被誤刪）。Duty Time 持久化補強：每次輸入即存（不再需要按 Calculate 才存）、保存／還原 crew 人數選擇、重開頁面時若 FDP Start 已填妥則自動重算讓結果區塊回來。</div>
      <div>Briefing Overtime warning fix: unified flight number matching (strip leading zeros/spaces), use flight-level date parsing (matches Overtime subtab logic), replaced silent failures with diagnostic hints when roster flight not found or scheduled FT unavailable. Groups panel: removed legacy SFO/FO orphan groups left from the merge (denylist approach — only deletes explicitly listed legacy IDs, so future fleets/presets won't be accidentally removed). Duty Time persistence: instant save on every input (no longer requires clicking Calculate), save/restore crew size selection, auto-recalculates on page reopen when FDP Start is filled so the result section comes back too.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.25</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>機場分類資料表更新到 Operations Specifications C-6 Authorized Airport List APR 01 2026 修正版（Amendment 069），共 8 項：(1) A350-1041 新增 RJBB（關西）為定期機場、新增 RJFF（福岡）為備用機場。(2) A330-941：RJCH（函館）、RJOT（高松）、RPVM（宿霧）由定期改備用。(3) A350-941：新增 RJCH（函館）為備用；RJSS（仙台）、RPLC（克拉克）、RPVM（宿霧）由定期改備用。(4) A321-252NX / A330-941 / A350-941：移除 VDPP（金邊）為備用機場。(5) A321-252NX：WADD（峇里島）由定期改備用。(6) A330-941：WIII（雅加達）由定期改備用。(7) A350-941：VVPQ（富國）、WIII（雅加達）由定期改備用。(8) A330-941：移除 WADD（峇里島）為定期機場；A350-941：移除 WADD 為備用機場。</div>
      <div>Airport classification table updated to Operations Specifications C-6 Authorized Airport List APR 01 2026 amendment (Amendment 069), 8 changes: (1) A350-1041 — added RJBB (Kansai) as regular, RJFF (Fukuoka) as alternate. (2) A330-941 — RJCH / RJOT / RPVM regular → alternate. (3) A350-941 — added RJCH as alternate; RJSS / RPLC / RPVM regular → alternate. (4) A321-252NX / A330-941 / A350-941 — removed VDPP (Phnom Penh) as alternate. (5) A321-252NX — WADD (Bali) regular → alternate. (6) A330-941 — WIII (Jakarta) regular → alternate. (7) A350-941 — VVPQ / WIII regular → alternate. (8) A330-941 — removed WADD as regular; A350-941 — removed WADD as alternate.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.24</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Roster sync（Playwright）穩定性大改造：(1) 所有 <code>.rbc-event-content</code> 的等待 timeout 從 2s 拉到 10s，慢網下不再因為 calendar 重繪稍慢就噴掉。(2) 外層 while 入口加 <code>try/catch</code>，超時就優雅 break 並保留已抓到的 duties，不再整份 sync 中止。(3) Click 失敗後檢查是否還在 calendar，有部分導航就 <code>goBack</code> 恢復再繼續。(4) 三個失敗點（outer_timeout / click_fail / goback_wait_fail）加詳細 log（<code>url / i / dutyText / .rbc 數量 / readyState</code>）+ 截圖到 <code>/tmp/sync-debug/{jobId}/{i}_{type}_{ts}.png</code>。(5) 最外層 try/catch 接 unhandled Playwright error，若已抓到 ≥1 筆 duty → 回傳 partial + 輸出部分 ICS；完全沒抓到則維持 fail 不包裝。(6) 新增 <code>GET /api/sync-debug/:syncId/:file?eid=xxx</code>（job.employeeId 比對）讓使用者下載除錯截圖；啟動時清除 24h 前的檔案。(7) 前端同步完成頁三態顯示：✅ 完整 / ⚠️ 部分成功（列出原因 + 截圖連結）/ ❌ 失敗。</div>
      <div>Roster sync (Playwright) reliability overhaul: (1) all <code>.rbc-event-content</code> wait timeouts raised from 2s to 10s — slow networks no longer trip over calendar re-renders. (2) Outer while-loop entry wrapped in <code>try/catch</code> — timeouts break gracefully, preserving already-captured duties. (3) Click failure now checks if still on calendar, recovers via <code>goBack</code> if partial navigation occurred. (4) Three failure points (outer_timeout / click_fail / goback_wait_fail) now log detailed context (<code>url / i / dutyText / .rbc count / readyState</code>) and snapshot to <code>/tmp/sync-debug/{jobId}/{i}_{type}_{ts}.png</code>. (5) Outermost <code>try/catch</code> catches unhandled Playwright errors — returns partial with partial ICS if ≥1 duty captured, otherwise still fails cleanly (no dishonest wrapping). (6) New <code>GET /api/sync-debug/:syncId/:file?eid=xxx</code> (job.employeeId check) for downloading debug screenshots; 24h-old session dirs auto-cleaned on startup. (7) Sync-complete screen now has three states: ✅ full / ⚠️ partial (with reason + clickable screenshot links) / ❌ failed.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.23</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>FLIGHT INFO/DATA 標題的 🗺️ Briefing Room 連結旁，新增小輸入格（約 98px 寬，maxlength 4），placeholder <code>eg. ONT</code>、輸入自動轉大寫，讓使用者自己填 briefing room 代碼。欄位 <code>brief-room</code> 納入 <code>_briefFields</code> 一起 debounced auto-save、歷史同步、載入歷史會還原。</div>
      <div>Added a small input next to the 🗺️ Briefing Room link in the FLIGHT INFO/DATA header (~98px wide, maxlength 4, placeholder <code>eg. ONT</code>, auto-uppercase) so users can note their assigned briefing room code. Field <code>brief-room</code> is part of <code>_briefFields</code> — debounced auto-save, history sync, restored on history load.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.22</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>修正 V8.0.21 的 🗺️ Briefing Room 連結在 PWA（iPad/手機安裝版）沒地方關閉的問題。改為 in-app modal viewer：點連結不再開新 tab，而是在 app 內彈全螢幕黑底 modal，右上角 ✕ 按鈕（避開 notch safe-area），點空白處也能關，圖片支援雙指縮放（<code>touch-action: pinch-zoom</code>）。修正初始 <code>src=""</code> 被瀏覽器解讀為當前頁 URL 導致 bug。</div>
      <div>Fixed V8.0.21 issue where the 🗺️ Briefing Room link had no close button in PWA mode (installed iPad/phone app). Replaced new-tab with in-app modal viewer: tap the link now opens a full-screen black-backdrop modal inside the app, with a ✕ button top-right (respects notch safe-area), tap outside to close, pinch-zoom supported. Fixed a bug where initial <code>src=""</code> was resolved to current page URL by browsers.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.21</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Briefing 新增兩個功能：(1) FLIGHT INFO/DATA 標題旁加「🗺️ Briefing Room」藍色超連結，點擊開新 tab 顯示 briefing room 平面圖，由 server <code>/briefing-room</code> route 提供（7 天 cache）。(2) 輸入 Flight Time 時自動比對 roster 當日表定 FT；邏輯：實際 ≥ 表定 − 10 分鐘就顯示黃色警告框（實際越長 OT 機率越高），含「→ Overtime」按鈕可直接跳去 Overtime subtab。匹配 duty 日期範圍 <code>[reportTime ~ endTime]</code> ± 1 天容錯（處理外站時區差 + 同日來回），冬夏班表不跨月估算。沒同步當天 roster 就靜默不顯示。警告在清除/改航班號/FT 大幅縮短時自動消失。</div>
      <div>Briefing gains two features: (1) 🗺️ Briefing Room blue underlined link in the FLIGHT INFO/DATA header — opens floor plan in a new tab, served via <code>/briefing-room</code> route (7-day cache). (2) Entering Flight Time auto-compares against that day's scheduled FT from roster; logic: if actual FT ≥ scheduled − 10 min, shows a yellow warning banner (longer actual = higher OT chance) with a "→ Overtime" button. Matches duty's <code>[reportTime ~ endTime]</code> range with ±1 day tolerance (handles outstation timezone + same-day turns), no cross-month estimation. Silently hides if roster not synced for that day. Warning auto-clears on field clear / flight no. change / FT drop below threshold.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.20</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Briefing 資料儲存改為每字 <code>oninput</code> debounced 500ms 自動存（不用等 blur），整份 briefing（Block 1 + Block 2 notes/POB 全部）都即時同步。搜尋列右邊新增儲存狀態小圓點：🟡 存檔中 / 🟢 已儲存。blur 保留當備胎避免關 tab race。</div>
      <div>Briefing auto-save switched from blur to <code>input</code> event (debounced 500ms) — no more waiting for field blur; full briefing (Block 1 + Block 2 notes/POB) syncs in real time. Tiny status dot next to the search row: 🟡 saving / 🟢 saved. Blur kept as fallback to guard against tab-close races.</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V8.0.19</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Briefing panel 新增歷史功能：📅 History 按鈕打開月曆式歷史檢視，黃色日期表示有 briefing，格子內顯示航班號 + 非 TPE 那端城市（例如 <code>JX820 KIX</code>），多班時顯示 <code>⋯ +N</code>。點日期格子 → 下方 panel 列出當日全部航班（可點擊載入或 ✕ 刪除）。查詢成功自動存 snapshot、notes blur 自動 save，資料永久保留。有 eid（上傳過班表）→ Postgres 跨裝置同步；無 eid → 本機 localStorage。NOTES 區塊重構：Turbulence / Tail No./MEL / Min Water / Fuel Required 四欄都加永久 label（標題獨立一行在 textarea 上方，不會被輸入遮蔽）；新增 👥 Crew + Pax = POB 自動加總欄位（同一行顯示）。後端新增 <code>crewsync_briefings</code> 表 + <code>POST/GET/LIST/DELETE /api/briefing</code> 端點；每筆以 (eid, flight_no, flight_date) 唯一。</div>
      <div>Briefing panel gains history feature: 📅 History button opens a calendar-style modal where golden days indicate saved briefings; each cell shows flight_no + non-TPE city (e.g., <code>JX820 KIX</code>) with <code>⋯ +N</code> for additional flights. Tap a golden date → detail panel below lists all flights for that day (click to load, ✕ to delete). Auto-save on successful Query + debounced on notes blur; permanent retention. Cross-device sync via eid (Postgres) when roster uploaded; else local (localStorage). NOTES restructured: Turbulence / Tail No./MEL / Min Water / Fuel Required all now have a permanent label above each textarea (no longer hidden when typing); new 👥 Crew + Pax = POB row with auto-sum on a single line. Backend: new <code>crewsync_briefings</code> Postgres table + <code>POST/GET/LIST/DELETE /api/briefing</code> endpoints; unique per (eid, flight_no, flight_date).</div>
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
      <div>Groups 移除分享 toggle，加入群組即啟用分享，退出所有群組自動停止；預設群組改下拉選單 + 已加入標籤；新增 FC/CC/職級篩選器；Friends header 加 ⓘ、名稱/機隊欄位預設顯示、自動載入第一個群組班表；CC Rest Calculator 移除密碼鎖正式開放、新增 Crew Prep 欄位、休時取整至 5 min、新增重設按鈕與 24hr 快取、表單寬度優化；好友圈說明文字更新；PA dep-min 手動修改 flag 修正</div>
      <div>Groups: remove share toggle, join = auto-share, leave all = auto-stop; presets changed to dropdown + joined tags; added FC/CC/rank filter; Friends: ⓘ in header, name/fleet shown by default, auto-load first group roster; CC Rest Calculator: removed password lock, added Crew Prep field, rest rounded to 5 min, Reset button, 24hr cache, form width optimized; friend group description updated; PA dep-min manual flag fix</div>
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
