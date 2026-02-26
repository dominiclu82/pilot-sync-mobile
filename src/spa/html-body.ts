export function getSpaHtmlBody(): string {
  return `
<body>

<!-- ══ Tab: 同步 ═════════════════════════════════════════════════════ -->
<div id="tab-sync">

<!-- ══ Main（含帳號 + 月份，一個畫面搞定）══════════════════════════════ -->
<div id="screen-main" class="screen active">
  <div class="logo">
    <span class="logo-icon">✈️</span>
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
        <summary>🔐 首次授權出現警告？</summary>
        <div class="how-to-body">
          <div class="how-to-os">
            Google 會顯示「這個應用程式未經驗證」的警告畫面，這是正常的：<br><br>
            1. 點左下角「<b>進階</b>」<br>
            2. 點「<b>前往 crew-sync.onrender.com（不安全）</b>」<br>
            3. 點「<b>繼續</b>」完成授權
          </div>
        </div>
      </details>
    </div>
    <div id="cred-error" class="alert alert-error" style="display:none"></div>

    <form id="cred-form" autocomplete="on" onsubmit="submitCredentials(event)">
      <div class="field">
        <label>班表帳號</label>
        <input type="text" id="jx-user" name="username"
          autocomplete="username" inputmode="numeric" placeholder="員工編號" required>
      </div>
      <div class="field" style="margin-top:10px">
        <label>班表密碼</label>
        <input type="password" id="jx-pass" name="password"
          autocomplete="current-password" placeholder="班表登入密碼">
      </div>
      <hr class="sep" style="margin:4px 0">
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
      <div style="height:4px"></div>
      <button type="submit" class="btn btn-primary">🚀 開始同步</button>
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
    <span class="logo-icon">✈️</span>
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
    <span class="logo-icon">✈️</span>
    <div class="logo-title">CrewSync</div>
  </div>
  <div class="card">
    <div id="done-title" style="font-weight:700;font-size:1.1em;text-align:center"></div>
    <div id="done-stats" class="stats"></div>
    <div id="done-log" class="log-box" style="max-height:25vh"></div>
    <button class="btn btn-secondary" onclick="showMain()">← 返回</button>
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

</div><!-- end tab-sync -->

<!-- ══ Tab: A350簡報箱 ══════════════════════════════════════════════ -->
<div id="tab-briefing" class="tab-active">

  <!-- 子 Tab Bar -->
  <div class="briefing-subtabs">
    <button class="briefing-subtab" id="subtabBtn-tools" onclick="switchBriefingTab('tools',this)">🗺️ 工具連結</button>
    <button class="briefing-subtab active" id="subtabBtn-datis" onclick="switchBriefingTab('datis',this)">⛅ Airport WX</button>
    <button class="briefing-subtab" id="subtabBtn-hf" onclick="switchBriefingTab('hf',this)">📻 Pacific HF</button>
    <button class="briefing-subtab" id="subtabBtn-coldtemp" onclick="switchBriefingTab('coldtemp',this)">❄️ 低溫修正</button>
    <button class="briefing-subtab" id="subtabBtn-duty" onclick="switchBriefingTab('duty',this)">⏱️ Duty Time</button>
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

  <!-- ── 🌡️ Cold Temperature Altitude Correction panel ── -->
  <div id="briefing-coldtemp" class="briefing-panel">
    <div class="ct-panel">
      <div class="ct-form">
        <!-- 機場標高 + OAT -->
        <div class="ct-inputs">
          <div class="ct-input-group">
            <label>機場標高 Airport Elevation (ft)</label>
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
            <input class="ct-label-inp" type="text" id="ct-l3" placeholder="自訂名稱">
            <input class="ct-card-input" type="number" id="ct-a3" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r3">—</div>
          </div>
          <div class="ct-card">
            <input class="ct-label-inp" type="text" id="ct-l4" placeholder="自訂名稱">
            <input class="ct-card-input" type="number" id="ct-a4" inputmode="numeric" placeholder="ft">
            <div class="ct-card-result empty" id="ct-r4">—</div>
          </div>
          <div class="ct-card">
            <input class="ct-label-inp" type="text" id="ct-l5" placeholder="自訂名稱">
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
        <button class="wx-route-btn active" onclick="selectWxRegion('taiwan',this)">台灣</button>
        <button class="wx-route-btn" onclick="selectWxRegion('hkmacao',this)">港澳</button>
        <button class="wx-route-btn" onclick="selectWxRegion('japan',this)">日本</button>
        <button class="wx-route-btn" onclick="selectWxRegion('korea',this)">韓國</button>
        <button class="wx-route-btn" onclick="selectWxRegion('philippines',this)">菲律賓</button>
        <button class="wx-route-btn" onclick="selectWxRegion('thailand',this)">泰國</button>
        <button class="wx-route-btn" onclick="selectWxRegion('vietnam',this)">越南柬埔寨</button>
        <button class="wx-route-btn" onclick="selectWxRegion('seasia',this)">星馬印</button>
        <button class="wx-route-btn" onclick="selectWxRegion('usa',this)">美國</button>
        <button class="wx-route-btn" onclick="selectWxRegion('pacific',this)">阿拉斯加太平洋</button>
        <button class="wx-route-btn" onclick="selectWxRegion('canada',this)">加拿大</button>
        <button class="wx-route-btn" onclick="selectWxRegion('europe',this)">歐洲</button>
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
    <div class="dt-lock-overlay" id="dt-lock-overlay">
      <div class="dt-lock-card">
        <div class="dt-lock-icon">🔒</div>
        <div class="dt-lock-title">Duty Time Calculator</div>
        <div class="dt-lock-sub">請輸入密碼以繼續</div>
        <div style="margin:8px 0 4px;font-size:.82em;color:#f59e0b">功能開發中，敬請期待</div>
        <input class="dt-lock-input" type="password" id="dt-lock-pw" placeholder="••••••••" maxlength="16"
          onkeydown="if(event.key==='Enter')dtUnlock()">
        <button class="dt-lock-btn" onclick="dtUnlock()">解鎖</button>
        <div class="dt-lock-err" id="dt-lock-err"></div>
      </div>
    </div>

    <div class="dt-wrap" style="flex:1">

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
            <input type="checkbox" id="dt-c1"> Class 1 Bunk
          </label>
          <label class="dt-chk-label" id="dt-disc-row" style="display:none">
            <input type="checkbox" id="dt-disc"> PIC Discretion (+2h)
          </label>
        </div>
        <div class="dt-opt-row" style="margin-bottom:4px">
          <span style="font-size:.72em;color:var(--dim);flex-shrink:0">時區</span>
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
          ★ PIC Discretion: +2h to Max FDP (3P only), requires report.
        </div>
      </div>


      <!-- Mode -->
      <div class="dt-body" style="padding-bottom:0">
        <div class="dt-mode-row">
          <button class="dt-mode-btn active" id="dt-mode-home" onclick="dtSetMode('home')">🏠 Home Base</button>
          <button class="dt-mode-btn" id="dt-mode-out" onclick="dtSetMode('out')">✈️ Outstation</button>
        </div>
      </div>

      <!-- Inputs -->
      <div class="dt-body">

        <!-- FDP Start -->
        <div class="dt-field">
          <div class="dt-field-label">FDP Start (UTC) — Report Time</div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-s-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-s-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-s-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- FDP End -->
        <div class="dt-field">
          <div class="dt-field-label">FDP End (UTC) — Block In / Release <span style="color:var(--dim);font-size:.85em">（選填，用於檢查實際 FDP）</span></div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-e-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-e-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-e-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <!-- Flight Time -->
        <div class="dt-field">
          <div class="dt-field-label">Flight Time (Block Time)</div>
          <div class="dt-time-row">
            <input class="dt-time-box" type="text" id="dt-ft-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-ft-m" placeholder="MM" maxlength="2" inputmode="numeric">
          </div>
        </div>

        <!-- Home Base: Next Report -->
        <div class="dt-field" id="dt-next-section">
          <div class="dt-field-label">Next Duty Report (UTC) — 選填</div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-n-day" placeholder="DD" maxlength="2" inputmode="numeric">
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
            <input class="dt-date-box" type="text" id="dt-ci-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-ci-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-ci-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
          <div class="dt-field-label" style="margin-top:8px">Hotel Check-out (UTC)</div>
          <div class="dt-time-row">
            <input class="dt-date-box" type="text" id="dt-co-day" placeholder="DD" maxlength="2" inputmode="numeric">
            <span class="dt-sep">/</span>
            <input class="dt-time-box" type="text" id="dt-co-h" placeholder="HH" maxlength="2" inputmode="numeric">
            <span class="dt-sep">:</span>
            <input class="dt-time-box" type="text" id="dt-co-m" placeholder="MM" maxlength="2" inputmode="numeric">
            <span class="dt-tag">UTC</span>
          </div>
        </div>

        <button class="dt-calc-btn" onclick="dtCalculate()">計算</button>
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
              <div id="dt-bar-wocl" style="position:absolute;top:0;bottom:0;background:rgba(251,191,36,.18);border-radius:4px;display:none;z-index:1"></div>
              <!-- Bars (z-index:2) -->
              <div id="dt-bar-fdp" style="position:absolute;top:0;height:28px;background:#0ea5e9;border-radius:4px;display:flex;align-items:center;overflow:hidden;z-index:2">
                <span id="dt-lbl-fdp" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <div id="dt-bar-maxfdp" style="position:absolute;top:34px;height:28px;background:repeating-linear-gradient(-45deg,#a855f7 0,#a855f7 7px,#c084fc 7px,#c084fc 14px);border-radius:4px;display:flex;align-items:center;overflow:hidden;z-index:2">
                <span id="dt-lbl-maxfdp" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <div id="dt-bar-minrest" style="position:absolute;top:68px;height:28px;background:repeating-linear-gradient(-45deg,#f97316 0,#f97316 7px,#fdba74 7px,#fdba74 14px);border-radius:4px;display:flex;align-items:center;overflow:hidden;z-index:2">
                <span id="dt-lbl-minrest" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <div id="dt-bar-rest" style="position:absolute;top:102px;height:28px;background:#64748b;border-radius:4px;display:flex;align-items:center;overflow:hidden;display:none;z-index:2">
                <span id="dt-lbl-rest" style="font-size:.65em;font-weight:700;color:#fff;white-space:nowrap;padding:0 6px"></span>
              </div>
              <!-- Vertical lines (z-index:3) -->
              <div id="dt-vline-start" style="position:absolute;top:0;bottom:0;border-left:1.5px dashed rgba(148,163,184,.5);z-index:3;display:none"></div>
              <div id="dt-vline-end" style="position:absolute;top:0;bottom:0;border-left:1.5px dashed rgba(148,163,184,.5);z-index:3;display:none"></div>
              <div id="dt-vline-next" style="position:absolute;top:0;bottom:0;border-left:1.5px dashed rgba(148,163,184,.5);z-index:3;display:none"></div>
            </div>
            <!-- Tick labels (positioned absolutely inside relative container) -->
            <div id="dt-tl2-ticks" style="position:relative;height:40px;margin-top:4px"></div>
            <div class="dt-legend">
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:#0ea5e9"></div>FDP</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:rgba(251,191,36,.35)"></div>WOCL (02-05)</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:repeating-linear-gradient(-45deg,#a855f7 0,#a855f7 4px,#c084fc 4px,#c084fc 8px)"></div>Max FDP</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:repeating-linear-gradient(-45deg,#f97316 0,#f97316 4px,#fdba74 4px,#fdba74 8px)"></div>Min Rest</div>
              <div class="dt-leg-item"><div class="dt-leg-box" style="background:#64748b"></div>Rest</div>
            </div>
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

          <div class="dt-notice">⚠ Non-operational reference only · CAR 07-02A · 請以公司手冊為準</div>
        </div>
      </div>

      <!-- Placeholder before calc -->
      <div id="dt-placeholder" style="padding:32px 14px;text-align:center;color:var(--dim);font-size:.82em">
        選好人數並輸入 FDP Start，按「計算」即可查看最大限制時間
      </div>

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
      </div>
      <div class="gi-header-btns">
        <button class="gi-time-btn" id="gi-time-btn" onclick="toggleGiTime()">⏱ 時間</button>
        <button class="gi-refresh-btn" onclick="refreshGateFlights()">🔄 更新</button>
      </div>
    </div>
    <div class="gi-search-bar">
      <span class="gi-search-label">輸入航班號 / 機場代碼 / 機場名搜尋</span>
      <input type="text" id="gate-search" class="gi-search-input" placeholder="搜尋..." oninput="filterGateFlights()">
    </div>
    <div id="gi-pinned-wrap" class="gi-pinned-wrap" style="display:none">
      <div id="gi-pinned-header" class="gi-pinned-header-bar"></div>
      <table class="gi-table gi-hide-time" id="gi-pinned-table">
        <thead>
          <tr>
            <th class="gi-sticky-col">航班</th>
            <th>出發地</th>
            <th>Terminal</th>
            <th>Check-in</th>
            <th>Gate</th>
            <th class="gi-time-col">STD</th>
            <th class="gi-time-col">ATD</th>
            <th>目的地</th>
            <th>Terminal</th>
            <th>Parking</th>
            <th>轉盤</th>
            <th class="gi-time-col">STA</th>
            <th class="gi-time-col">ATA</th>
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
            <th class="gi-sticky-col gi-sortable" onclick="giSort('fno')">航班</th>
            <th class="gi-sortable" onclick="giSort('origin')">出發地</th>
            <th>Terminal</th>
            <th>Check-in</th>
            <th>Gate</th>
            <th class="gi-time-col">STD</th>
            <th class="gi-time-col">ATD</th>
            <th class="gi-sortable" onclick="giSort('dest')">目的地</th>
            <th>Terminal</th>
            <th>Parking</th>
            <th>轉盤</th>
            <th class="gi-time-col">STA</th>
            <th class="gi-time-col">ATA</th>
          </tr>
        </thead>
        <tbody id="gate-tbody"></tbody>
      </table>
    </div>
  </div>

</div><!-- end tab-gate -->

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
    <span class="tab-btn-icon">✈️</span>班表同步
  </button>
  <button class="tab-btn tab-active" id="tabBtn-briefing" onclick="switchTab('briefing',this)">
    <span class="tab-btn-icon">📦</span>A350簡報箱
  </button>
  <button class="tab-btn" id="tabBtn-gate" onclick="switchTab('gate',this)">
    <span class="tab-btn-icon">🌏</span>Gate Info
  </button>
  <div class="tab-btn tab-util">
    <div class="tab-util-row">
      <button class="tab-util-btn" onclick="toggleTheme()" id="tabBtn-theme">
        <span id="theme-icon">☀️</span><span id="theme-label">日間</span>
      </button>
      <button class="tab-util-btn tab-install-btn" id="tab-install-btn" onclick="showInstallGuide()" style="display:none">
        <span>📲</span>安裝
      </button>
    </div>
    <span style="font-size:.55em;color:var(--dim);line-height:1;opacity:.7">V4.037</span>
  </div>
</div>

<!-- iOS 安裝說明 -->
<div id="install-overlay" class="install-overlay" style="display:none" onclick="if(event.target===this)closeInstallGuide()">
  <div class="install-card">
    <div style="font-size:2em;margin-bottom:8px">📲</div>
    <div style="font-weight:700;font-size:1em;margin-bottom:12px">加入主畫面</div>
    <div class="install-steps">
      1. 點 Safari 底部的 <b>分享按鈕</b>（⬆️ 方框加箭頭）<br>
      2. 向下滑，點「<b>加入主畫面</b>」<br>
      3. 右上角點「<b>新增</b>」
    </div>
    <button class="install-close-btn" onclick="closeInstallGuide()">知道了</button>
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
      <div class="privacy-a" style="color:var(--dim)">Yes. Your employee ID and password are only used for a few seconds during sync to log into the roster system. Once complete, the server discards them immediately. Your employee ID is stored locally in your browser for convenience; your password is never stored.</div>

      <div class="privacy-q">Google 日曆授權做了什麼？/ What Does Google Authorization Do?</div>
      <div class="privacy-a">只做一件事：把你的班表寫進你的 Google 日曆。我們不會讀取、修改或分享你日曆裡的任何現有資料。授權產生的令牌只存在你自己的瀏覽器裡，不會上傳到伺服器。</div>
      <div class="privacy-a" style="color:var(--dim)">One thing only: writing your roster into your Google Calendar. We do not read, modify, or share any existing data in your calendar. The authorization token is stored only in your browser and is never uploaded to the server.</div>

      <div class="privacy-q">這個工具收費嗎？/ Is This Tool Free?</div>
      <div class="privacy-a">完全免費。本工具由個人開發者獨立開發，純粹為了方便機組人員同步班表，沒有任何商業目的。</div>
      <div class="privacy-a" style="color:var(--dim)">Completely free. This tool is independently developed solely to help crew members sync their roster — no commercial purpose whatsoever.</div>

      <div class="privacy-q">免責聲明 / Disclaimer</div>
      <div class="privacy-a">開發者已盡合理努力確保資料安全，但本工具並非公司官方應用程式。使用前請自行評估風險；若對隱私有任何疑慮，請勿使用。</div>
      <div class="privacy-a" style="color:var(--dim)">The developer has taken reasonable measures to ensure data security. However, this is not an official company application. Please assess the risks before use; if you have any privacy concerns, do not use this tool.</div>
    </div>
    <button class="install-close-btn" onclick="closePrivacy()">關閉</button>
  </div>
</div>

`;
}
