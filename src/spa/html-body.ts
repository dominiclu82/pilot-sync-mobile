export function getSpaHtmlBody(): string {
  return `
<body>

<!-- ══ Tab: 同步 ═════════════════════════════════════════════════════ -->
<div id="tab-sync">

<!-- Roster Subtab Bar -->
<div class="roster-subtabs">
  <button class="roster-subtab active" onclick="switchRosterTab('crew',this)">✈️ Crew Sync</button>
  <button class="roster-subtab" onclick="switchRosterTab('cal',this)">📅 Calendar</button>
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
        <div id="google-badge-text" style="flex:1;color:var(--muted)">尚未授權 Google 日曆（第一次需要）</div>
        <button class="btn btn-secondary btn-sm" id="google-auth-btn"
          onclick="doGoogleAuth()" style="width:auto;padding:6px 12px;font-size:.82em">授權</button>
      </div>
      <details class="how-to" style="background:var(--surface);border-radius:8px">
        <summary>🔐 首次授權出現警告？/ Warning on first authorization?</summary>
        <div class="how-to-body">
          <div class="how-to-os">
            Google 會顯示「這個應用程式未經驗證」的警告畫面，這是正常的：<br><br>
            1. 點左下角「<b>進階</b>」<br>
            2. 點「<b>前往 crew-sync.onrender.com（不安全）</b>」<br>
            3. 點「<b>繼續</b>」完成授權<br><br>
            <span style="color:var(--muted)">
            Google may show a "Google hasn't verified this app" warning — this is normal:<br><br>
            1. Click "<b>Advanced</b>" at bottom-left<br>
            2. Click "<b>Go to crew-sync.onrender.com (unsafe)</b>"<br>
            3. Click "<b>Continue</b>" to complete authorization
            </span>
          </div>
        </div>
      </details>
    </div>
    <div id="cred-error" class="alert alert-error" style="display:none"></div>

    <form id="cred-form" autocomplete="on" onsubmit="submitCredentials(event)">
      <div class="sync-cred-row">
        <div class="field">
          <label>班表帳號</label>
          <input type="text" id="jx-user" name="username"
            autocomplete="username" inputmode="numeric" placeholder="員工編號" required>
        </div>
        <div class="field">
          <label>班表密碼</label>
          <div class="pw-input-wrap">
            <input type="password" id="jx-pass" name="password"
              autocomplete="current-password" placeholder="班表登入密碼">
            <button type="button" class="pw-eye-btn" id="pw-eye-btn" onclick="togglePwVisibility()">&#9673;</button>
          </div>
        </div>
      </div>
      <hr class="sep" style="margin:4px 0">
      <div class="sync-month-row">
        <div>
          <div style="font-weight:600;font-size:.9em">同步月份</div>
          <div class="month-row">
            <div class="field">
              <label>年</label>
              <select id="sync-year"></select>
            </div>
            <div class="field">
              <label>月</label>
              <select id="sync-month"></select>
            </div>
          </div>
        </div>
        <button type="submit" class="btn btn-primary sync-submit-btn">🚀 開始同步</button>
      </div>
    </form>
    <div style="display:flex;justify-content:center;gap:16px;margin-top:10px">
      <button class="link-btn" onclick="showSettings()">⚙️ 設定</button>
      <button class="link-btn" onclick="showPrivacy()">🔒 隱私與安全</button>
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
      <div id="sync-status-text" style="font-size:.9em;color:var(--muted)">正在同步...</div>
    </div>
    <div id="sync-log" class="log-box">等待開始...</div>
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
      <button class="btn btn-secondary" onclick="showMain()" style="flex:1">← 返回</button>
      <button class="btn btn-secondary" id="copy-log-btn" onclick="copyLog()" style="flex:1">📋 複製紀錄</button>
    </div>
  </div>
</div>

<!-- ══ Settings ══════════════════════════════════════════════════════════ -->
<div id="screen-settings" class="screen">
  <div class="logo">
    <span class="logo-icon">⚙️</span>
    <div class="logo-title">設定</div>
  </div>
  <div class="card">
    <div style="font-weight:600;font-size:.9em;color:var(--muted)">Google 日曆授權狀態</div>
    <div id="settings-google-badge" class="google-badge">
      <div class="dot" id="settings-google-dot"></div>
      <div id="settings-google-text" style="flex:1;color:var(--muted)"></div>
    </div>
    <button class="btn btn-secondary btn-sm" onclick="doGoogleAuthFromSettings()">🔄 重新授權 Google 日曆</button>
    <hr class="sep">
    <div id="settings-msg" class="alert" style="display:none"></div>
    <button class="btn btn-danger btn-sm" onclick="clearSavedData()">🗑️ 清除已儲存的資料</button>
    <button class="btn btn-secondary" onclick="showMain()">← 返回</button>
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
        <button class="gcal-nav" onclick="gcalPrev()">◀</button>
        <button class="gcal-nav" onclick="gcalNext()">▶</button>
        <span class="gcal-title" id="gcal-title"></span>
      </div>
      <div class="gcal-weekdays" id="gcal-weekdays"></div>
      <div class="gcal-grid" id="gcal-grid"></div>
    </div>
    <div class="gcal-events" id="gcal-events"></div>
  </div>
</div>

</div><!-- end tab-sync -->

<!-- ══ Tab: A350簡報箱 ══════════════════════════════════════════════ -->
<div id="tab-briefing" class="tab-active">

  <!-- 子 Tab Bar -->
  <div class="briefing-subtabs">
    <div class="subtab-slot"><button class="briefing-subtab active" id="subtabBtn-brief" onclick="switchBriefingTab('brief',this)">📋 提示</button></div>
    <div class="subtab-wx-wrap">
      <button class="briefing-subtab" id="subtabBtn-datis" onclick="switchBriefingTab('datis',this)">⛅ Airport WX</button>
      <select class="wx-fleet-select" id="wx-fleet-select" onchange="wxSwitchFleet(this)">
        <option value="A321">A321</option>
        <option value="A330">A330</option>
        <option value="A350-900" selected>A350-900</option>
        <option value="A350-1000">A350-1000</option>
      </select>
    </div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-pa" onclick="switchBriefingTab('pa',this)">🎙️ PA</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-hf" onclick="switchBriefingTab('hf',this)">📻 Pacific HF</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-crewrest" onclick="switchBriefingTab('crewrest',this)">⏳ 輪休計算</button></div>
    <div class="subtab-slot" style="display:none"><button class="briefing-subtab" id="subtabBtn-live" onclick="switchBriefingTab('live',this)">📡 Live</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-coldtemp" onclick="switchBriefingTab('coldtemp',this)">❄️ Cold Temp</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-tools" onclick="switchBriefingTab('tools',this)">🗺️ Tools</button></div>
    <div class="subtab-slot"><button class="briefing-subtab" id="subtabBtn-duty" onclick="switchBriefingTab('duty',this)">⏱️ Duty Time</button></div>
  </div>

  <!-- ── 📋 提示 panel ── -->
  <div id="briefing-brief" class="briefing-panel active">
    <div class="brief-search">
      <input type="text" id="brief-fno" placeholder="航班號 Flight No. (e.g. JX801)" oninput="_briefOnInput(this.value)">
      <span id="brief-flt-status" class="pa-flt-status"></span>
    </div>

    <div class="brief-section">
      <div class="brief-section-header"><span>FLIGHT INFO / DATA</span><button class="brief-clear-btn" onclick="briefClearInfo()">清除</button></div>
      <div class="brief-grid">
        <div class="brief-field"><label>DEP Date</label><input type="text" id="brief-dep-date" placeholder="—"></div>
        <div class="brief-field"><label>ETD UTC</label><input type="text" id="brief-etd" placeholder="—"></div>
        <div class="brief-field"><label>ARR Date</label><input type="text" id="brief-arr-date" placeholder="—"></div>
        <div class="brief-field"><label>ETA UTC</label><input type="text" id="brief-eta" placeholder="—"></div>
        <div class="brief-field"><label>Registration No.</label><input type="text" id="brief-reg" placeholder="—"></div>
        <div class="brief-field"><label>Gate</label><input type="text" id="brief-gate" placeholder="—"></div>
        <div class="brief-field"><label>Cruise Altitude</label><input type="text" id="brief-ofp" placeholder="—"></div>
        <div class="brief-field"><label>Flight Time</label><input type="text" id="brief-ft" placeholder="—"></div>
      </div>
    </div>

    <div class="brief-section">
      <div class="brief-section-header"><span>NOTES / BRIEFING</span><button class="brief-clear-btn" onclick="briefClearNotes()">清除</button></div>
      <textarea class="brief-note" id="brief-note1" rows="2" placeholder="亂流時間/其他提醒 (Turbulence/Notes)"></textarea>
      <textarea class="brief-note" id="brief-note2" rows="2" placeholder="MEL"></textarea>
      <textarea class="brief-note" id="brief-note3" rows="2" placeholder="Required Fuel"></textarea>
    </div>
  </div>

  <!-- ── ⏳ 輪休計算 panel ── -->
  <div id="briefing-crewrest" class="briefing-panel">
    <div class="cr-wrap">
      <div class="cr-header">
        <span style="font-weight:700;font-size:1.05em">⏳ 輪休計算</span>
        <button class="brief-clear-btn" onclick="crewrestReset()">重置</button>
      </div>

      <div class="cr-input-row">
        <div class="cr-input-group">
          <label>飛行時間</label>
          <div style="display:flex;align-items:center;gap:4px">
            <input type="number" id="cr-fh" class="cr-input" placeholder="HH" min="0" max="24" inputmode="numeric" oninput="crewrestCalc();if(String(this.value).length>=2)document.getElementById('cr-fm').focus()" onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('cr-fm').focus()}">
            <span>:</span>
            <input type="number" id="cr-fm" class="cr-input" placeholder="MM" min="0" max="59" inputmode="numeric" oninput="crewrestCalc();if(String(this.value).length>=2){var s=document.getElementById('cr-start');if(s)s.focus()}" onkeydown="if(event.key==='Enter'){event.preventDefault();var s=document.getElementById('cr-start');if(s)s.focus()}">
          </div>
        </div>
        <div class="cr-input-group">
          <label>組員人數</label>
          <select id="cr-crew" class="cr-select" onchange="_crOnCrewChange();crewrestCalc()">
            <option value="3">3 人</option>
            <option value="4" selected>4 人</option>
          </select>
        </div>
        <div class="cr-result-box" id="cr-result" style="display:none">
          <div style="font-size:.72em;color:var(--accent)">建議每人休息</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="cr-result-time" id="cr-result-time">—</span>
            <button class="cr-apply-btn" onclick="crewrestApply()">帶入</button>
          </div>
        </div>
        <div class="cr-result-box" id="cr-manual-wrap" style="display:none">
          <div style="font-size:.72em;color:var(--muted)">或手動輸入每人休時</div>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="text" id="cr-manual-rest" class="cr-start-input" placeholder="H:MM" maxlength="5" style="width:60px;font-size:1.1em;font-weight:700">
            <button class="cr-apply-btn" onclick="crewrestApplyManual()">帶入</button>
          </div>
        </div>
      </div>

      <div id="cr-mode-wrap" class="cr-mode-wrap">
        <label class="cr-mode-label"><input type="radio" name="cr-mode" value="group" checked onchange="_crModeChange()"> CM1/CM2個別計算</label>
        <label class="cr-mode-label"><input type="radio" name="cr-mode" value="cross" onchange="_crModeChange()"> Ops Crew休一段</label>
        <label class="cr-mode-label"><input type="radio" name="cr-mode" value="single" onchange="_crModeChange()"> 一段輪休</label>
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
      </div>
      <!-- 內嵌 iframe -->
      <div id="tool-frame-wrap" style="display:none;margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span id="tool-frame-title" style="font-weight:700;font-size:.9em;color:var(--text)"></span>
          <div style="display:flex;gap:10px;align-items:center">
            <a id="tool-frame-external" href="#" target="_blank" style="font-size:.8em;color:var(--accent);text-decoration:none">↗ 新分頁</a>
            <button onclick="closeTool()" style="background:none;border:none;color:var(--muted);font-size:1.1em;cursor:pointer;padding:0 4px">✕</button>
          </div>
        </div>
        <iframe id="tool-frame" src="" style="width:100%;height:65vh;border:none;border-radius:12px;background:var(--surface)"></iframe>
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
  <div id="briefing-datis" class="briefing-panel">
    <div class="wx-fixed-header">
      <div class="wx-routes">
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
            <input class="pa-input" id="pa-lt-input" placeholder="e.g. JX2 / SJX002 / 002 / LAX / KLAX / 洛杉磯" oninput="_paLookupLocalTime(this.value)">
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
        </div>
        <div class="pa-content" id="pa-content">
          <div class="pa-placeholder">選擇分類以查看廣播詞範本<br>Select a category to view PA scripts</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── 📻 Pacific HF panel ── -->
  <div id="briefing-hf" class="briefing-panel">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid var(--dim);flex-shrink:0">
      <span style="font-size:.85em;font-weight:700;color:var(--text)">📻 Pacific HF 查詢</span>
      <a href="https://radio.arinc.net/pacific/" target="_blank" style="font-size:.78em;color:var(--accent);text-decoration:none">↗ 新分頁</a>
    </div>
    <iframe id="hf-panel-iframe" src="" style="flex:1;border:none;width:100%;min-height:400px"></iframe>
  </div>

  <!-- ── ⏱️ Duty Time panel ── -->
  <div id="briefing-duty" class="briefing-panel" style="position:relative">

    <!-- 密碼鎖 -->

    <div class="dt-wrap" style="flex:1">

      <!-- Placeholder hint -->
      <div id="dt-placeholder" style="padding:10px 14px 4px;text-align:center;color:var(--text);font-size:.82em">
        選好人數並輸入 FDP Start，按「Calculate」即可查看最大限制時間<br><span style="opacity:.7;font-size:.9em">Select crew config, enter FDP Start, then press "Calculate" to view max limits</span>
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

<!-- ══ Tab: Gate Info ═══════════════════════════════════════════════ -->
<div id="tab-gate" style="display:none">

  <div id="gate-content" style="display:flex;flex-direction:column">
    <div class="gi-header">
      <div class="gi-header-left">
        <span class="gi-title">JX Flight Info</span>
        <span class="gi-notice-inline">⚠ Non-operational Reference only</span>
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
      <div class="gi-search-hint">Search by flight no. / airport code / city name ｜ Tap <span style="color:var(--sort)">green headers</span> to sort</div>
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
    <span class="tab-btn-icon">💼</span>Operation
  </button>
  <button class="tab-btn" id="tabBtn-fr24" onclick="switchTab('fr24',this)">
    <span class="tab-btn-icon">📡</span>FR24
  </button>
  <button class="tab-btn" id="tabBtn-gate" onclick="switchTab('gate',this)">
    <span class="tab-btn-icon">🌏</span>Gate Info
  </button>
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
      <span style="font-size:.55em;color:var(--muted);line-height:1;opacity:.7;cursor:pointer" onclick="showAbout()">V6.109</span>
    </div>
  </div>
</div>

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
      <div style="margin-bottom:4px">📱 建議使用 <b>iPad 橫向</b>操作以獲得最佳體驗</div>
      <div style="color:var(--muted)">Best experience on iPad in landscape mode</div>
    </div>
    <div style="font-size:.78em;font-weight:700;margin-bottom:6px" id="about-version">V6.109</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>Subtab bar 響應式顯示（手機4個/iPad橫6個/筆電全滿）</div>
      <div>Subtab bar responsive layout (phone 4 / iPad landscape 6 / laptop all)</div>
    </div>
    <div style="font-size:.78em;font-weight:700;color:var(--muted);margin-bottom:6px">V6.108</div>
    <div style="font-size:.72em;color:var(--muted);margin-bottom:10px;line-height:1.5;text-align:left">
      <div>新增 📋 提示 subtab：航班號自動查詢帶入資料、Cruise Altitude、MEL/Required Fuel 備註欄</div>
      <div>新增 ⏳ 輪休計算 subtab：三種模式（CM1/CM2個別計算、Ops Crew休一段、一段輪休）、TOD 建議休時、自動重算配對段、Enter 跳格、輸入驗證</div>
      <div>Subtab bar 可左右捲動（手機/iPad）</div>
      <div>New 📋 Briefing Card subtab: auto-lookup flight info, Cruise Altitude, MEL/Required Fuel notes</div>
      <div>New ⏳ Crew Rest Calculator subtab: 3 modes, TOD-based suggestion, auto-redistribute, Enter to jump, input validation</div>
      <div>Subtab bar horizontally scrollable on mobile/iPad</div>
    </div>
    <button class="install-close-btn" onclick="closeAbout()">關閉</button>
  </div>
</div>

<!-- 隱私與安全 Q&A -->
<div id="privacy-overlay" class="install-overlay" style="display:none" onclick="if(event.target===this)closePrivacy()">
  <div class="privacy-card">
    <div style="font-size:1.5em;margin-bottom:6px">🔒</div>
    <div style="font-weight:700;font-size:1em;margin-bottom:14px">隱私與安全 Q&A / Privacy & Security FAQ</div>
    <div class="privacy-body">
      <div class="privacy-q">你的帳號密碼安全嗎？/ Are My Credentials Safe?</div>
      <div class="privacy-a">安全。你輸入的員工編號和密碼只會在同步的那幾秒鐘內使用，用來登入班表系統擷取資料。同步完成後，伺服器立即丟棄，不留任何紀錄。你的員工編號會存在你自己的瀏覽器裡（方便下次自動填入），密碼則完全不儲存，由瀏覽器的密碼管理器自行處理。</div>
      <div class="privacy-a" style="color:var(--muted)">Yes. Your employee ID and password are only used for a few seconds during sync to log into the roster system. Once complete, the server discards them immediately. Your employee ID is stored locally in your browser for convenience; your password is never stored.</div>

      <div class="privacy-q">Google 日曆授權做了什麼？/ What Does Google Authorization Do?</div>
      <div class="privacy-a">只做一件事：把你的班表寫進你的 Google 日曆。我們不會讀取、修改或分享你日曆裡的任何現有資料。授權產生的令牌只存在你自己的瀏覽器裡，不會上傳到伺服器。</div>
      <div class="privacy-a" style="color:var(--muted)">One thing only: writing your roster into your Google Calendar. We do not read, modify, or share any existing data in your calendar. The authorization token is stored only in your browser and is never uploaded to the server.</div>

      <div class="privacy-q">這個工具收費嗎？/ Is This Tool Free?</div>
      <div class="privacy-a">完全免費。本工具由個人開發者獨立開發，純粹為了方便機組人員同步班表，沒有任何商業目的。</div>
      <div class="privacy-a" style="color:var(--muted)">Completely free. This tool is independently developed solely to help crew members sync their roster — no commercial purpose whatsoever.</div>

      <div class="privacy-q">免責聲明 / Disclaimer</div>
      <div class="privacy-a">開發者已盡合理努力確保資料安全，但本工具並非公司官方應用程式。使用前請自行評估風險；若對隱私有任何疑慮，請勿使用。</div>
      <div class="privacy-a" style="color:var(--muted)">The developer has taken reasonable measures to ensure data security. However, this is not an official company application. Please assess the risks before use; if you have any privacy concerns, do not use this tool.</div>
    </div>
    <button class="install-close-btn" onclick="closePrivacy()">關閉</button>
  </div>
</div>

`;
}
