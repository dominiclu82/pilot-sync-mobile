

// ── Auto-reload on idle ──────────────────────────────────────────────────────
var _hiddenAt = 0;
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') {
    _hiddenAt = Date.now();
  } else if (_hiddenAt && Date.now() - _hiddenAt > 30 * 60 * 1000) {
    location.reload();
  }
});

// ── Font Scale ───────────────────────────────────────────────────────────────
var _fontScale = (function(){
  try { var s = parseInt(localStorage.getItem('crewsync_font_scale'));
  return (s >= -2 && s <= 3) ? s : 0; } catch(e){} return 0;
})();
(function(){ if(_fontScale !== 0) document.documentElement.style.fontSize = (100 + _fontScale * 8) + '%'; })();

function adjustFontSize(dir) {
  _fontScale = Math.max(-2, Math.min(3, _fontScale + dir));
  document.documentElement.style.fontSize = (100 + _fontScale * 8) + '%';
  try { localStorage.setItem('crewsync_font_scale', String(_fontScale)); } catch(e){}
}

// ── Password visibility toggle ───────────────────────────────────────────────
function togglePwVisibility() {
  var inp = document.getElementById('jx-pass');
  var btn = document.getElementById('pw-eye-btn');
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.textContent = '◎';
    btn.style.opacity = '1';
  } else {
    inp.type = 'password';
    btn.textContent = '◉';
    btn.style.opacity = '.5';
  }
}

// ── State ────────────────────────────────────────────────────────────────────
let refreshToken = localStorage.getItem('crewsync_rt') || '';
let currentJobId = null;
let pollTimer = null;
let pendingSyncParams = null;

// ── Screen ───────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Init / Main ──────────────────────────────────────────────────────────────
function showMain() {
  const now = new Date();
  const yr = document.getElementById('sync-year');
  const mo = document.getElementById('sync-month');
  yr.innerHTML = '';
  for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
    yr.innerHTML += '<option value="' + y + '"' + (y === now.getFullYear() ? ' selected' : '') + '>' + y + ' 年</option>';
  }
  mo.innerHTML = '';
  ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'].forEach((m, i) => {
    mo.innerHTML += '<option value="' + (i+1) + '"' + (i+1 === now.getMonth()+1 ? ' selected' : '') + '>' + m + '</option>';
  });
  // Pre-fill saved values
  document.getElementById('jx-user').value = localStorage.getItem('crewsync_user') || '';
  document.getElementById('cred-error').style.display = 'none';
  updateGoogleBadge();
  showScreen('screen-main');
}

function updateGoogleBadge() {
  const hasToken = !!refreshToken;
  const dot  = document.getElementById('google-dot');
  const text = document.getElementById('google-badge-text');
  const btn  = document.getElementById('google-auth-btn');
  dot.className  = 'dot ' + (hasToken ? 'dot-ok' : 'dot-no');
  text.textContent = hasToken ? '✅ 已授權 Google 日曆' : '尚未授權 Google 日曆（首次需要）';
  text.style.color = hasToken ? 'var(--success)' : 'var(--muted)';
  btn.textContent  = hasToken ? '重新授權' : '授權';
}

async function doGoogleAuth() {
  const btn = document.getElementById('google-auth-btn');
  btn.disabled = true; btn.textContent = '等待中...';
  try {
    const res = await fetch('/oauth/url');
    const { url, error } = await res.json();
    if (error) throw new Error(error);
    const popup = window.open(url, 'google-oauth', 'width=500,height=650,left=50,top=50');
    if (!popup) throw new Error('請允許此網頁開啟彈出視窗後再試');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('授權逾時，請重試')), 120000);
      function onMsg(e) {
        if (e.data && e.data.type === 'oauth_done') {
          clearTimeout(timer); window.removeEventListener('message', onMsg);
          if (!e.data.refreshToken) reject(new Error('未收到授權碼，請重試'));
          else { refreshToken = e.data.refreshToken; localStorage.setItem('crewsync_rt', refreshToken); resolve(); }
        }
      }
      window.addEventListener('message', onMsg);
    });
    updateGoogleBadge();
    // If we were waiting for auth to proceed with sync, continue
    if (pendingSyncParams) {
      const p = pendingSyncParams; pendingSyncParams = null;
      startSyncJob(p);
    }
  } catch (err) {
    document.getElementById('cred-error').textContent = err.message;
    document.getElementById('cred-error').style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = refreshToken ? '重新授權' : '授權';
  }
}

function showSettings() {
  updateSettingsPage();
  showScreen('screen-settings');
}

async function doGoogleAuthFromSettings() {
  const msgEl = document.getElementById('settings-msg');
  msgEl.className = 'alert alert-info'; msgEl.style.display = ''; msgEl.textContent = '等待 Google 授權...';
  try {
    const res = await fetch('/oauth/url');
    const { url, error } = await res.json();
    if (error) throw new Error(error);
    const popup = window.open(url, 'google-oauth', 'width=500,height=650,left=50,top=50');
    if (!popup) throw new Error('請允許此網頁開啟彈出視窗後再試');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('授權逾時')), 120000);
      function onMsg(e) {
        if (e.data && e.data.type === 'oauth_done') {
          clearTimeout(timer); window.removeEventListener('message', onMsg);
          if (!e.data.refreshToken) reject(new Error('未收到授權碼'));
          else { refreshToken = e.data.refreshToken; localStorage.setItem('crewsync_rt', refreshToken); resolve(); }
        }
      }
      window.addEventListener('message', onMsg);
    });
    msgEl.className = 'alert alert-success'; msgEl.textContent = '✅ 重新授權成功！';
    updateSettingsPage();
  } catch (err) {
    msgEl.className = 'alert alert-error'; msgEl.textContent = err.message;
  }
}

function updateSettingsPage() {
  const hasToken = !!refreshToken;
  document.getElementById('settings-google-dot').className = 'dot ' + (hasToken ? 'dot-ok' : 'dot-no');
  document.getElementById('settings-google-text').textContent = hasToken ? '已授權 Google 日曆' : '尚未授權';
  document.getElementById('settings-google-text').style.color = hasToken ? 'var(--success)' : 'var(--muted)';
}

function clearSavedData() {
  if (!confirm('確定要清除所有儲存的資料嗎？')) return;
  localStorage.removeItem('crewsync_rt');
  localStorage.removeItem('crewsync_user');
  refreshToken = '';
  const el = document.getElementById('settings-msg');
  el.className = 'alert alert-success'; el.style.display = ''; el.textContent = '✅ 資料已清除';
  updateSettingsPage();
}

// ── Submit credentials & sync ────────────────────────────────────────────────
function submitCredentials(e) {
  e.preventDefault();
  document.getElementById('cred-error').style.display = 'none';

  const jxUser = document.getElementById('jx-user').value.trim();
  const jxPass = document.getElementById('jx-pass').value;

  if (!jxUser || !jxPass) {
    document.getElementById('cred-error').textContent = '請填入員工編號和密碼';
    document.getElementById('cred-error').style.display = '';
    return;
  }

  // 儲存帳號供下次預填（密碼由瀏覽器密碼管理器處理）
  localStorage.setItem('crewsync_user', jxUser);

  const year  = parseInt(document.getElementById('sync-year').value);
  const month = parseInt(document.getElementById('sync-month').value);
  const params = { year, month, jxUsername: jxUser, jxPassword: jxPass, calendarId: 'primary' };

  if (!refreshToken) {
    // Need Google auth first
    pendingSyncParams = params;
    document.getElementById('cred-error').textContent = '請先點擊上方「授權」按鈕完成 Google 日曆授權';
    document.getElementById('cred-error').style.display = '';
    return;
  }

  startSyncJob(params);
}

async function startSyncJob(params) {
  const { year, month, jxUsername, jxPassword, calendarId } = params;
  document.getElementById('sync-log').textContent = '準備中...';
  document.getElementById('sync-status-text').textContent = '正在同步 ' + year + '年' + month + '月...';
  showScreen('screen-syncing');

  try {
    const res = await fetch('/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month, jxUsername, jxPassword, refreshToken, calendarId }),
    });
    const { jobId, error } = await res.json();
    if (error) throw new Error(error);
    currentJobId = jobId;
    pollStatus();
  } catch (err) {
    showDone(false, [], null, err.message);
  }
}

function pollStatus() {
  if (!currentJobId) return;
  pollTimer = setInterval(async () => {
    try {
      const data = await fetch('/status/' + currentJobId).then(r => r.json());
      const logEl = document.getElementById('sync-log');
      logEl.textContent = data.logs.join('\n') || '等待中...';
      logEl.scrollTop = logEl.scrollHeight;
      if (data.status === 'done' || data.status === 'error') {
        clearInterval(pollTimer); pollTimer = null;
        if (data.newRefreshToken) {
          refreshToken = data.newRefreshToken;
          localStorage.setItem('crewsync_rt', refreshToken);
        }
        showDone(data.status === 'done', data.logs, data.result, data.error);
      }
    } catch (err) {
      clearInterval(pollTimer); pollTimer = null;
      showDone(false, [], null, '網路錯誤：' + err.message);
    }
  }, 2000);
}

function showDone(success, logs, result, error) {
  const titleEl = document.getElementById('done-title');
  const statsEl = document.getElementById('done-stats');
  titleEl.textContent = success ? '✅ 同步完成！' : '❌ 同步失敗';
  titleEl.style.color = success ? 'var(--success)' : 'var(--error)';
  if (success && result) {
    statsEl.innerHTML =
      mkStat(result.addedCount,'新增') + mkStat(result.updatedCount,'更新') +
      mkStat(result.deletedCount,'刪除') + mkStat(result.totalCount,'總計');
  } else {
    statsEl.innerHTML = error ? '<div class="alert alert-error" style="width:100%">' + error + '</div>' : '';
  }
  document.getElementById('done-log').textContent = logs.join('\n') || '';
  showScreen('screen-done');
}

function mkStat(n, label) {
  return '<div class="stat-item"><div class="stat-num">' + n + '</div><div class="stat-lbl">' + label + '</div></div>';
}

// ── Roster sub-tab ───────────────────────────────────────────────────────────
var gcalInited = false;
function switchRosterTab(panel, btn) {
  document.querySelectorAll('.roster-subtab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.roster-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('roster-' + panel).classList.add('active');
  if (panel === 'cal' && !gcalInited) { gcalInited = true; gcalInit(); }
}
// Auto-switch to Calendar if user already authorized (setTimeout to wait for calendar JS)
setTimeout(function() {
  if (localStorage.getItem('crewsync_rt')) {
    var calBtn = document.querySelectorAll('.roster-subtab')[1];
    if (calBtn) switchRosterTab('cal', calBtn);
  }
}, 0);

// 24 小時自動清除航班資料（保留機長姓名、機隊、自訂筆記、FR24 設定）
(function() {
  try {
    var now = Date.now();
    var last = parseInt(localStorage.getItem('crewsync_last_visit') || '0');
    if (last && now - last > 24 * 3600000) {
      ['crewsync_brief_data','crewsync_pa_flt','crewsync_pa_dest',
       'crewsync_pa_inputs','crewsync_pa_manual_flags','crewsync_cr_data',
       'crewsync_ct_data','crewsync_dt_data'].forEach(function(k) {
        localStorage.removeItem(k);
      });
    }
    localStorage.setItem('crewsync_last_visit', String(now));
  } catch(e){}
})();

// Auto-init briefing card + subtab reorder (brief is default active subtab on page load)
setTimeout(function() { briefInit(); subtabReorderInit(); _ctRestore(); _dtRestore(); }, 0);

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab, btn) {
  ['tab-sync','tab-briefing','tab-fr24','tab-gate'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.classList.remove('tab-active'); el.style.display = 'none'; }
  });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
  var target = document.getElementById('tab-' + tab);
  if (target) { target.style.display = ''; target.classList.add('tab-active'); }
  btn.classList.add('tab-active');
  if (tab === 'briefing') {
    briefInit();
  }
  if (tab === 'gate' && !gateFlightsLoaded) {
    loadGateFlights();
  }
  if (tab === 'fr24') {
    if (typeof fr24Init === 'function') fr24Init();
  } else {
    if (typeof _fr24UnlockOrientation === 'function') _fr24UnlockOrientation();
    if (typeof fr24StopAll === 'function') fr24StopAll();
  }
  if (typeof _liveUnlockOrientation === 'function') _liveUnlockOrientation();
  if (typeof liveStopAll === 'function') liveStopAll();
  window.scrollTo(0, 0);
}

// ── D-ATIS ────────────────────────────────────────────────────────────────────
var currentAtisUrl = '';
var currentAtisIcao = '';

function switchDatisRegion(region, tab) {
  document.querySelectorAll('.datis-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  document.querySelectorAll('.datis-btn').forEach(btn => {
    if (region === 'all' || btn.dataset.region === region) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  });
}

function openDatisLink(url, btn) {
  document.querySelectorAll('.datis-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  const icao = btn.textContent.trim().substring(0, 4);
  currentAtisUrl = url;
  currentAtisIcao = icao;
  const display = document.getElementById('datisDisplay');
  const label = document.getElementById('datisLabel');
  const content = document.getElementById('datisContent');
  label.textContent = btn.querySelector('span') ? icao + ' ' + btn.querySelector('span').textContent : icao;
  content.innerHTML = '<div class="atis-loading">載入中...</div>';
  display.style.display = 'block';
  fetchAtisData(url, icao, content);
  display.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function reloadCurrentAtis() {
  if (currentAtisUrl) {
    const content = document.getElementById('datisContent');
    content.innerHTML = '<div class="atis-loading">重新載入中...</div>';
    fetchAtisData(currentAtisUrl, currentAtisIcao, content);
  }
}

function fetchAtisData(url, icao, container) {
  const corsProxy = 'https://api.codetabs.com/v1/proxy/?quest=';
  const metarUrl = 'https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=raw&hours=12';
  const tafUrl = 'https://aviationweather.gov/api/data/taf?ids=' + icao + '&format=raw';
  const atisPromise = fetch(corsProxy + encodeURIComponent(url))
    .then(r => { if (!r.ok) throw new Error(); return r.text(); })
    .then(html => parseAtisHtml(html))
    .catch(() => []);
  const metarPromise = fetch(corsProxy + encodeURIComponent(metarUrl))
    .then(r => { if (!r.ok) throw new Error(); return r.text(); })
    .then(t => t.trim()).catch(() => '');
  const tafPromise = fetch(corsProxy + encodeURIComponent(tafUrl))
    .then(r => { if (!r.ok) throw new Error(); return r.text(); })
    .then(t => t.trim()).catch(() => '');
  Promise.all([atisPromise, metarPromise, tafPromise]).then(([atisSections, metarText, tafText]) => {
    const atisOnly = atisSections.filter(s => {
      const t = s.title.toLowerCase();
      return !t.includes('metar') && !t.includes('taf');
    });
    const noData = '<span style="color:var(--muted);font-style:italic">無資料</span>';
    let cards = '';
    if (atisOnly.length > 0) {
      cards += atisOnly.map(s =>
        '<div class="atis-card"><div class="atis-card-title">' + s.title + '</div><pre>' + s.text + '</pre></div>'
      ).join('');
    } else {
      cards += '<div class="atis-card"><div class="atis-card-title">📻 ATIS</div><pre>' + noData + '</pre></div>';
    }
    const latestMetar = metarText ? metarText.split('\n')[0] : '';
    cards += '<div class="atis-card"><div class="atis-card-title">🌤️ METAR</div><pre>' + (latestMetar || noData) + '</pre></div>';
    cards += '<div class="atis-card"><div class="atis-card-title">📅 TAF</div><pre>' + (tafText || noData) + '</pre></div>';
    container.innerHTML = cards;
  });
}

function parseAtisHtml(html) {
  const results = [];
  const titlePattern = /<h5[^>]*class="card-title"[^>]*>([\s\S]*?)<\/h5>/gi;
  const atisPattern = /<div[^>]*class="atis"[^>]*>([\s\S]*?)<\/div>/gi;
  const titles = [];
  const atisTexts = [];
  let m;
  while ((m = titlePattern.exec(html)) !== null) titles.push(m[1].trim().replace(/<[^>]*>/g, ''));
  while ((m = atisPattern.exec(html)) !== null) {
    let text = m[1].replace(/&#xA;/g,'\n').replace(/&#xD;/g,'').replace(/&#x9;/g,'  ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,'').trim();
    atisTexts.push(text);
  }
  for (let i = 0; i < atisTexts.length; i++) {
    const title = titles[i] || (i === 0 ? 'ATIS' : 'Info ' + (i + 1));
    const icon = title.toLowerCase().includes('arrival') ? '🛬' :
                 title.toLowerCase().includes('departure') ? '🛫' :
                 title.toLowerCase().includes('atis') ? '📻' : 'ℹ️';
    results.push({ title: icon + ' ' + title, text: atisTexts[i] });
  }
  return results;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const icon = document.getElementById('theme-icon');
  if (html.dataset.theme === 'light') {
    // 目前日間 → 切換回夜間
    delete html.dataset.theme;
    icon.textContent = '☀️';
    localStorage.setItem('crewsync_theme', 'dark');
  } else {
    // 目前夜間 → 切換到日間
    html.dataset.theme = 'light';
    icon.textContent = '🌙';
    localStorage.setItem('crewsync_theme', 'light');
  }
  if (typeof fr24SwitchTheme === 'function') fr24SwitchTheme();
}
(function() {
  if (localStorage.getItem('crewsync_theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
    document.getElementById('theme-icon').textContent = '🌙';
  }
})();

// ── Cold Temperature Altitude Correction ──────────────────────────────────────
(function initColdTempTable() {
  const CT_ROWS = [200,300,400,500,600,700,800,900,1000,1500,2000,3000,4000,5000,6000,7000,8000,9000,10000];
  const CT_VALS = [
    [20,20,30,40,50,60],
    [20,30,40,50,70,80],
    [30,40,50,70,90,100],
    [30,50,70,90,110,130],
    [40,60,80,100,130,150],
    [40,70,90,120,150,180],
    [50,80,100,140,170,210],
    [50,90,120,150,190,230],
    [60,100,130,170,210,260],
    [90,140,190,250,310,380],
    [120,180,250,320,400,490],
    [170,260,360,470,580,710],
    [220,340,470,610,760,920],
    [270,420,570,740,920,1120],
    [320,490,670,870,1080,1310],
    [370,570,780,1010,1250,1510],
    [420,640,880,1140,1410,1710],
    [460,710,980,1260,1570,1900],
    [510,780,1070,1390,1720,2090]
  ];
  const tbody = document.getElementById('ct-tbody');
  CT_ROWS.forEach(function(haa, i) {
    const tr = document.createElement('tr');
    tr.id = 'ct-row-' + i;
    const td0 = document.createElement('td');
    td0.textContent = haa >= 1000 ? haa.toLocaleString() : haa;
    tr.appendChild(td0);
    CT_VALS[i].forEach(function(v, j) {
      const td = document.createElement('td');
      td.id = 'ct-cell-' + i + '-' + j;
      td.textContent = v.toLocaleString();
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  window._CT_ROWS = CT_ROWS;
  window._CT_VALS = CT_VALS;
})();

function ctInterp(alt, elev, oat) {
  const CT_TEMPS = [0,-10,-20,-30,-40,-50];
  const CT_ROWS  = window._CT_ROWS;
  const CT_VALS  = window._CT_VALS;
  const haa  = alt - elev;
  const haaC = Math.max(CT_ROWS[0], Math.min(CT_ROWS[CT_ROWS.length-1], haa));
  const oatC = Math.max(-50, Math.min(0, oat));
  let ri = CT_ROWS.length - 2;
  for (let i = 0; i < CT_ROWS.length - 1; i++) {
    if (haaC <= CT_ROWS[i+1]) { ri = i; break; }
  }
  const haaFrac = (haaC - CT_ROWS[ri]) / (CT_ROWS[ri+1] - CT_ROWS[ri]);
  let ti = CT_TEMPS.length - 2;
  for (let i = 0; i < CT_TEMPS.length - 1; i++) {
    if (oatC >= CT_TEMPS[i+1]) { ti = i; break; }
  }
  const oatFrac = (CT_TEMPS[ti] - oatC) / (CT_TEMPS[ti] - CT_TEMPS[ti+1]);
  const v00 = CT_VALS[ri][ti], v01 = CT_VALS[ri][ti+1];
  const v10 = CT_VALS[ri+1][ti], v11 = CT_VALS[ri+1][ti+1];
  const corr = v00*(1-haaFrac)*(1-oatFrac) + v01*(1-haaFrac)*oatFrac
             + v10*haaFrac*(1-oatFrac)      + v11*haaFrac*oatFrac;
  return { corr: Math.round(corr/10)*10, ri: ri, ti: ti };
}

function calcColdTemp() {
  const elev   = parseFloat(document.getElementById('ct-elev').value);
  const oat    = parseFloat(document.getElementById('ct-oat').value);
  const noCorr = document.getElementById('ct-no-corr');
  if (isNaN(elev) || isNaN(oat)) return;
  // Reset
  document.querySelectorAll('.ct-hi').forEach(function(el) { el.classList.remove('ct-hi'); });
  noCorr.style.display = 'none';
  for (var i = 0; i < 6; i++) {
    var rs = document.getElementById('ct-r'+i);
    if (rs) { rs.textContent = '—'; rs.className = 'ct-card-result empty'; }
  }
  if (oat >= 0) { noCorr.style.display = 'block'; return; }
  var highlighted = {};
  for (var idx = 0; idx < 6; idx++) {
    var inp = document.getElementById('ct-a'+idx);
    var res = document.getElementById('ct-r'+idx);
    if (!inp || !res) continue;
    var val = parseFloat(inp.value);
    if (isNaN(val)) continue;

    /* FPA correction (idx 3) */
    if (idx === 3) {
      var isaTemp = 15 - 1.98 * elev / 1000;
      var corrFpa = Math.atan(Math.tan(val * Math.PI / 180) * (isaTemp + 273.15) / (oat + 273.15)) * 180 / Math.PI;
      res.innerHTML = corrFpa.toFixed(2) + '°';
      res.className = 'ct-card-result';
      continue;
    }

    var r = ctInterp(val, elev, oat);
    var corrAlt = Math.round((val + r.corr) / 10) * 10;
    res.innerHTML = '+' + r.corr.toLocaleString() + ' ft<br>' + corrAlt.toLocaleString() + ' ft';
    res.className = 'ct-card-result';
    // Highlight table cells (track unique cells)
    [[r.ri,r.ti],[r.ri,r.ti+1],[r.ri+1,r.ti],[r.ri+1,r.ti+1]].forEach(function(p) {
      var key = p[0]+'-'+p[1];
      if (!highlighted[key]) {
        var el = document.getElementById('ct-cell-'+key);
        if (el) { el.classList.add('ct-hi'); highlighted[key] = true; }
      }
    });
  }
  _ctSave();
}

/* ── Cold Temp 持久化 ── */
function _ctSave() {
  try {
    var obj = {};
    ['ct-elev','ct-oat','ct-a0','ct-a1','ct-a2','ct-a3','ct-a4','ct-a5','ct-l4','ct-l5'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.value) obj[id] = el.value;
    });
    localStorage.setItem('crewsync_ct_data', JSON.stringify(obj));
  } catch(e){}
}

function _ctRestore() {
  try {
    var s = localStorage.getItem('crewsync_ct_data');
    if (!s) return;
    var obj = JSON.parse(s);
    Object.keys(obj).forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.value = obj[id] || '';
    });
  } catch(e){}
}

function ctReset() {
  ['ct-elev','ct-oat','ct-a0','ct-a1','ct-a2','ct-a3','ct-a4','ct-a5','ct-l4','ct-l5'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  for (var i = 0; i < 6; i++) {
    var rs = document.getElementById('ct-r'+i);
    if (rs) { rs.textContent = '—'; rs.className = 'ct-card-result empty'; }
  }
  document.querySelectorAll('.ct-hi').forEach(function(el) { el.classList.remove('ct-hi'); });
  var noCorr = document.getElementById('ct-no-corr');
  if (noCorr) noCorr.style.display = 'none';
  try { localStorage.removeItem('crewsync_ct_data'); } catch(e){}
}

// ── Briefing sub-tab ──────────────────────────────────────────────────────────
function switchBriefingTab(panel, btn) {
  document.querySelectorAll('.briefing-subtab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.briefing-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('briefing-' + panel).classList.add('active');
  if (panel === 'datis' && !wxLoaded) { wxLoaded = true; var fsel = document.getElementById('wx-fleet-select'); if (fsel) fsel.value = wxCurrentFleet; loadWxRegion(wxCurrentRegion); }
  if (panel === 'hf') {
    var ifr = document.getElementById('hf-panel-iframe');
    if (ifr && !ifr.getAttribute('src')) ifr.src = '/api/pacific-hf';
  }
  if (panel === 'pa') {
    paStartTzTimer();
  }
  if (panel === 'brief') {
    briefInit();
  }
  if (panel === 'crewrest') {
    crewrestInit();
  }
  if (panel === 'live') {
    liveInit();
  } else {
    if (typeof _liveUnlockOrientation === 'function') _liveUnlockOrientation();
    if (typeof liveStopAll === 'function') liveStopAll();
  }
}


// ── 工具連結內嵌 iframe ────────────────────────────────────────────────────────
function loadTool(e, anchor, mode) {
  e.preventDefault();
  const externalUrl = anchor.href;
  const iframeUrl = mode === 'pacific-hf' ? '/api/pacific-hf' : externalUrl;
  const title = anchor.textContent.trim();
  const wrap = document.getElementById('tool-frame-wrap');
  document.getElementById('tool-frame').src = iframeUrl;
  document.getElementById('tool-frame-title').textContent = title;
  document.getElementById('tool-frame-external').href = externalUrl;
  wrap.style.display = 'block';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return false;
}
function closeTool() {
  document.getElementById('tool-frame-wrap').style.display = 'none';
  document.getElementById('tool-frame').src = '';
}
function openHF(e) {
  e.preventDefault();
  const overlay = document.getElementById('hf-overlay');
  document.getElementById('hf-iframe').src = '/api/pacific-hf';
  overlay.style.display = 'flex';
  return false;
}
function closeHF() {
  document.getElementById('hf-overlay').style.display = 'none';
  document.getElementById('hf-iframe').src = '';
}

// ── iOS Install Guide ─────────────────────────────────────────────────────────
function showInstallGuide() {
  document.getElementById('install-overlay').style.display = 'flex';
}
function closeInstallGuide() {
  document.getElementById('install-overlay').style.display = 'none';
}

// ── About ────────────────────────────────────────────────────────────────────
function showAbout() {
  document.getElementById('about-overlay').style.display = 'flex';
}
function closeAbout() {
  document.getElementById('about-overlay').style.display = 'none';
}

// ── Privacy Q&A ──────────────────────────────────────────────────────────────
function showPrivacy() {
  document.getElementById('privacy-overlay').style.display = 'flex';
}
function closePrivacy() {
  document.getElementById('privacy-overlay').style.display = 'none';
}
function copyLog() {
  var log = document.getElementById('done-log');
  var text = log ? log.innerText : '';
  var btn = document.getElementById('copy-log-btn');
  navigator.clipboard.writeText(text).then(function() {
    btn.textContent = '✅ 已複製';
    setTimeout(function() { btn.textContent = '📋 複製紀錄'; }, 2000);
  }).catch(function() {
    // fallback for older browsers
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '✅ 已複製';
    setTimeout(function() { btn.textContent = '📋 複製紀錄'; }, 2000);
  });
}
(function() {
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !isStandalone) {
    var btn = document.getElementById('tab-install-btn');
    if (btn) btn.style.display = '';
  }
})();


// ── 機隊機場分類資料 ─────────────────────────────────────────────────
// 依據 Operations Specifications C-6 Authorized Airport List (Effective: JAN 30 2026)
// cls: 'r'=Regular, 'a'=Alternate, 'rs'=Regular+Special, 'as'=Alternate+Special
// P → 視為 A；P,S → 視為 A,S（RCKH/RCFN 等）

var _wxFleetData = {

// ════════════════════════════════════════════════════════════════════
// A321-252NX
// ════════════════════════════════════════════════════════════════════
'A321': {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCMQ',name:'台中',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'},{icao:'RCSS',name:'松山',cls:'as'},{icao:'RCFN',name:'台東',cls:'as'},{icao:'RCNN',name:'台南',cls:'a'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'rs'},{icao:'VMMC',name:'澳門',cls:'r'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'r'},{icao:'RJBE',name:'神戶',cls:'r'},{icao:'RJCC',name:'新千歲',cls:'r'},{icao:'RJCH',name:'函館',cls:'r'},{icao:'RJFF',name:'福岡',cls:'rs'},{icao:'RJFK',name:'鹿兒島',cls:'a'},{icao:'RJFT',name:'熊本',cls:'r'},{icao:'RJFU',name:'長崎',cls:'a'},{icao:'RJGG',name:'名古屋',cls:'r'},{icao:'RJNK',name:'小松',cls:'a'},{icao:'RJOS',name:'德島',cls:'a'},{icao:'RJOT',name:'高松',cls:'r'},{icao:'RJSN',name:'新潟',cls:'a'},{icao:'RJSS',name:'仙台',cls:'r'},{icao:'RJTT',name:'羽田',cls:'a'},{icao:'ROAH',name:'那霸',cls:'r'},{icao:'ROIG',name:'石垣',cls:'a'},{icao:'RORS',name:'下地島',cls:'r'}],
  korea:       [{icao:'RKPC',name:'濟州',cls:'a'},{icao:'RKPK',name:'釜山',cls:'rs'},{icao:'RKSI',name:'仁川',cls:'a'},{icao:'RKSS',name:'金浦',cls:'a'},{icao:'RKTN',name:'大邱',cls:'a'}],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'r'},{icao:'RPLL',name:'馬尼拉',cls:'r'},{icao:'RPMD',name:'達沃',cls:'a'},{icao:'RPVM',name:'宿霧',cls:'r'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'r'},{icao:'VTSP',name:'普吉',cls:'a'}],
  vietnam:     [{icao:'VVNB',name:'河內',cls:'r'},{icao:'VVPQ',name:'富國',cls:'r'},{icao:'VVTS',name:'胡志明',cls:'r'},{icao:'VDPP',name:'金邊',cls:'a'},{icao:'VVCR',name:'芽莊',cls:'a'},{icao:'VVDN',name:'峴港',cls:'r'}],
  seasia:      [{icao:'WIII',name:'雅加達',cls:'r'},{icao:'WSSS',name:'新加坡',cls:'r'},{icao:'WADD',name:'峇里島',cls:'r'},{icao:'WARR',name:'泗水',cls:'a'},{icao:'WBGG',name:'古晉',cls:'a'},{icao:'WICA',name:'戈達查帝',cls:'a'},{icao:'WMKP',name:'檳城',cls:'r'},{icao:'WMKK',name:'吉隆坡',cls:'r'}],
  usa:         [],
  pacific:     [{icao:'PGSN',name:'塞班',cls:'a'},{icao:'PGUM',name:'關島',cls:'r'},{icao:'PTRO',name:'帛琉',cls:'a'}],
  canada:      [],
  europe:      []
},

// ════════════════════════════════════════════════════════════════════
// A330-941
// ════════════════════════════════════════════════════════════════════
'A330': {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'},{icao:'RCSS',name:'松山',cls:'as'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'rs'},{icao:'VMMC',name:'澳門',cls:'r'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'r'},{icao:'RJCC',name:'新千歲',cls:'r'},{icao:'RJCH',name:'函館',cls:'r'},{icao:'RJFF',name:'福岡',cls:'rs'},{icao:'RJFK',name:'鹿兒島',cls:'a'},{icao:'RJFT',name:'熊本',cls:'r'},{icao:'RJGG',name:'名古屋',cls:'r'},{icao:'RJOT',name:'高松',cls:'r'},{icao:'RJSS',name:'仙台',cls:'r'},{icao:'RJTT',name:'羽田',cls:'a'},{icao:'ROAH',name:'那霸',cls:'r'}],
  korea:       [],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'r'},{icao:'RPLL',name:'馬尼拉',cls:'r'},{icao:'RPVM',name:'宿霧',cls:'r'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'r'}],
  vietnam:     [{icao:'VVNB',name:'河內',cls:'r'},{icao:'VVPQ',name:'富國',cls:'r'},{icao:'VVTS',name:'胡志明',cls:'r'},{icao:'VDPP',name:'金邊',cls:'a'},{icao:'VVCR',name:'芽莊',cls:'a'},{icao:'VVDN',name:'峴港',cls:'r'}],
  seasia:      [{icao:'WIII',name:'雅加達',cls:'r'},{icao:'WSSS',name:'新加坡',cls:'r'},{icao:'WADD',name:'峇里島',cls:'r'},{icao:'WARR',name:'泗水',cls:'a'},{icao:'WBGG',name:'古晉',cls:'a'},{icao:'WMKP',name:'檳城',cls:'r'},{icao:'WMKK',name:'吉隆坡',cls:'r'}],
  usa:         [],
  pacific:     [],
  canada:      [],
  europe:      []
},

// ════════════════════════════════════════════════════════════════════
// A350-941
// ════════════════════════════════════════════════════════════════════
'A350-900': {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'},{icao:'RCSS',name:'松山',cls:'as'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'rs'},{icao:'VMMC',name:'澳門',cls:'r'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'r'},{icao:'RJCC',name:'新千歲',cls:'r'},{icao:'RJFF',name:'福岡',cls:'rs'},{icao:'RJGG',name:'名古屋',cls:'r'},{icao:'RJSS',name:'仙台',cls:'r'},{icao:'ROAH',name:'那霸',cls:'r'},{icao:'RJTT',name:'羽田',cls:'a'}],
  korea:       [{icao:'RKPC',name:'濟州',cls:'a'},{icao:'RKPK',name:'釜山',cls:'as'},{icao:'RKSI',name:'仁川',cls:'a'}],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'r'},{icao:'RPLL',name:'馬尼拉',cls:'r'},{icao:'RPVM',name:'宿霧',cls:'r'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'a'}],
  vietnam:     [{icao:'VVNB',name:'河內',cls:'r'},{icao:'VVPQ',name:'富國',cls:'r'},{icao:'VVTS',name:'胡志明',cls:'r'},{icao:'VDPP',name:'金邊',cls:'a'},{icao:'VVCR',name:'芽莊',cls:'a'},{icao:'VVDN',name:'峴港',cls:'a'}],
  seasia:      [{icao:'WIII',name:'雅加達',cls:'r'},{icao:'WSSS',name:'新加坡',cls:'r'},{icao:'WADD',name:'峇里島',cls:'a'},{icao:'WARR',name:'泗水',cls:'a'},{icao:'WMKK',name:'吉隆坡',cls:'a'},{icao:'WMKP',name:'檳城',cls:'a'}],
  usa:         [{icao:'KLAX',name:'洛杉磯',cls:'r'},{icao:'KONT',name:'安大略',cls:'rs'},{icao:'KPHX',name:'鳳凰城',cls:'r'},{icao:'KSEA',name:'西雅圖',cls:'r'},{icao:'KSFO',name:'舊金山',cls:'rs'},{icao:'KLAS',name:'拉斯維加斯',cls:'a'},{icao:'KOAK',name:'奧克蘭',cls:'a'},{icao:'KPDX',name:'波特蘭',cls:'a'},{icao:'KSMF',name:'沙加緬度',cls:'a'},{icao:'KTUS',name:'土森',cls:'a'}],
  pacific:     [{icao:'PACD',name:'Cold Bay',cls:'a'},{icao:'PAFA',name:'費爾班克斯',cls:'a'},{icao:'PAKN',name:'King Salmon',cls:'a'},{icao:'PANC',name:'安克拉治',cls:'a'},{icao:'PASY',name:'Shemya',cls:'a'},{icao:'PGSN',name:'塞班',cls:'a'},{icao:'PGUM',name:'關島',cls:'a'},{icao:'PHNL',name:'檀香山',cls:'a'},{icao:'PMDY',name:'中途島',cls:'a'},{icao:'PWAK',name:'威克島',cls:'a'}],
  canada:      [{icao:'CYVR',name:'溫哥華',cls:'a'}],
  europe:      [{icao:'LKPR',name:'布拉格',cls:'r'},{icao:'EDDB',name:'柏林',cls:'a'},{icao:'EDDM',name:'慕尼黑',cls:'a'},{icao:'EPWA',name:'華沙',cls:'a'},{icao:'LOWL',name:'林茲',cls:'a'},{icao:'LOWW',name:'維也納',cls:'a'}]
},

// ════════════════════════════════════════════════════════════════════
// A350-1041
// ════════════════════════════════════════════════════════════════════
'A350-1000': {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'as'},{icao:'VMMC',name:'澳門',cls:'as'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'a'},{icao:'RJCC',name:'新千歲',cls:'a'},{icao:'RJGG',name:'名古屋',cls:'a'},{icao:'RJSS',name:'仙台',cls:'a'},{icao:'ROAH',name:'那霸',cls:'a'},{icao:'RJTT',name:'羽田',cls:'a'}],
  korea:       [],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'a'},{icao:'RPLL',name:'馬尼拉',cls:'a'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'a'}],
  vietnam:     [],
  seasia:      [],
  usa:         [],
  pacific:     [],
  canada:      [],
  europe:      []
}

};


// ── 航路氣象 ──────────────────────────────────────────────────────────────────
// WX_AIRPORTS 由 _wxFleetData 動態取得（資料定義在 airport-data.js）
var wxCurrentFleet = (function() { try { var f = localStorage.getItem('crewsync_fleet'); if (f && _wxFleetData[f]) return f; } catch(e) {} return 'A350-900'; })();
var wxCurrentRegion = 'taiwan';
var wxMetarMap = {};      // icao -> parsed metar object (cleared when region changes)
var wxCacheTime = null;   // timestamp of last successful fetch (ms)
var wxMetarRawMap = {};   // icao -> string[] of 6h METAR lines
var wxMetarShowAll = {};  // icao -> bool (true = show all 6h, false = latest 1)
var wxDetailCache = {};   // icao -> rendered HTML string (persists across airport switches)
var wxSelectedIcao = '';
var wxSelectedName = '';
var wxLoaded = false;

function wxGetAirports(region) {
  return ((_wxFleetData[wxCurrentFleet] || {})[region]) || [];
}

function wxSwitchFleet(sel) {
  wxCurrentFleet = sel.value;
  try { localStorage.setItem('crewsync_fleet', wxCurrentFleet); } catch(e) {}
  wxSelectedIcao = '';
  wxSelectedName = '';
  wxDetailCache = {};
  document.getElementById('wx-detail-pane').innerHTML = '<div class="wx-empty"><span class="wx-hint-desktop">\u2190 點選左側機場</span><span class="wx-hint-mobile">\u2191 點選上方機場</span><br>查看 METAR \u00b7 TAF \u00b7 ATIS</div>';
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
  var dir = (m.wdir === 'VRB') ? 'VRB' : (String(m.wdir || 0).padStart(3,'0') + '\u00b0');
  var gst = m.wgst ? '/G' + m.wgst : '';
  return dir + '\u00a0' + m.wspd + 'kt' + gst;
}

function wxFmtVis(m) {
  if (!m || m.visib === undefined) return '--';
  var v = String(m.visib);
  return (v === '10+' ? '>10' : v) + 'SM';
}

function wxFmtTemp(m) {
  if (!m || m.temp === undefined || m.temp === null) return '--';
  return m.temp + '\u00b0C';
}

function selectWxRegion(region, btn) {
  wxCurrentRegion = region;
  wxSelectedIcao = '';
  wxSelectedName = '';
  document.querySelectorAll('.wx-route-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  document.getElementById('wx-detail-pane').innerHTML = '<div class="wx-empty"><span class="wx-hint-desktop">\u2190 點選左側機場</span><span class="wx-hint-mobile">\u2191 點選上方機場</span><br>查看 METAR \u00b7 TAF \u00b7 ATIS</div>';
  loadWxRegion(region);
}

function parseMetarLine(raw) {
  if (!raw || !raw.trim()) return null;
  var s = raw.trim();
  var result = {};
  // Wind: 36008KT, 36008G20KT, VRB03KT, 00000KT
  var wm = s.match(/\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/);
  if (wm) {
    result.wdir = wm[1] === 'VRB' ? 'VRB' : parseInt(wm[1]);
    result.wspd = parseInt(wm[2]);
    if (wm[4]) result.wgst = parseInt(wm[4]);
  }
  // CAVOK
  if (/\bCAVOK\b/.test(s)) { result.visib = '10+'; result.sky = []; return result; }
  // Visibility SM (US/Canada): 10SM, 6SM, 1/2SM, M1/4SM
  var vSM = s.match(/\b(M?[\d]+(?:\/\d+)?)\s*SM\b/);
  if (vSM) {
    var vStr = vSM[1].replace('M','');
    var vVal = vStr.indexOf('/') >= 0
      ? parseInt(vStr.split('/')[0]) / parseInt(vStr.split('/')[1])
      : parseFloat(vStr);
    result.visib = vVal >= 10 ? '10+' : String(Math.round(vVal * 10) / 10);
  } else {
    // Visibility meters (ICAO): 9999, 0800, 3000
    var vM = s.match(/\b(\d{4})\b/);
    if (vM) {
      var meters = parseInt(vM[1]);
      result.visib = meters >= 9000 ? '10+' : String(Math.round(meters / 160.934) / 10);
    }
  }
  // Sky conditions
  result.sky = [];
  var skyRe = /(BKN|OVC|FEW|SCT)(\d{3})/g;
  var m2;
  while ((m2 = skyRe.exec(s)) !== null) {
    result.sky.push({ cover: m2[1], base: parseInt(m2[2]) * 100 });
  }
  // VV (vertical visibility): treat as OVC
  var vv = s.match(/\bVV(\d{3})\b/);
  if (vv) result.sky.push({ cover: 'OVC', base: parseInt(vv[1]) * 100 });
  // Temperature: 15/11 or M01/M05
  var tm = s.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  if (tm) result.temp = tm[1].charAt(0) === 'M' ? -parseInt(tm[1].slice(1)) : parseInt(tm[1]);
  // Observation time: DDHHMMZ
  var om = s.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
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
      text.split('\n').forEach(function(line) {
        line = line.trim();
        if (!line) return;
        var stripped = line.replace(/^(METAR|SPECI)\s+/, '');
        var icao = stripped.split(' ')[0].toUpperCase();
        if (/^[A-Z]{4}$/.test(icao)) wxMetarMap[icao] = parseMetarLine(stripped);
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
    + '<button class="wx-refresh-btn" onclick="loadWxRegion(\'' + region + '\')">\u21ba</button></div>';
  var cards = airports.map(function(a) {
    var m = wxMetarMap[a.icao];
    var cat = wxCalcCat(m);
    var cardCls = 'wx-card-' + (a.cls || 'r');
    var sel = (a.icao === wxSelectedIcao) ? ' selected' : '';
    var mins = wxMinsAgo(m);
    var ageClass = mins > 90 ? ' stale' : mins > 60 ? ' warn' : '';
    var ageText = mins > 90 ? 'expired' : mins + 'm';
    var ageHtml = mins !== null ? '<div class="wx-obs-age' + ageClass + '">' + ageText + '</div>' : '';
    return '<div class="wx-card ' + cardCls + sel + '" onclick="selectWxAirport(\'' + a.icao + '\',\'' + a.name + '\',this)">'
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
    + '<div class="wx-detail-title">' + icao + '\u3000' + name + '</div>'
    + '<div class="wx-cat cat-' + cat + '">' + cat + '</div>'
    + '<button class="wx-refresh-btn" style="margin-left:4px" onclick="refreshWxDetail(\'' + icao + '\',\'' + name + '\')">\u21ba 更新</button>'
    + '</div>'
    + '<div id="wx-detail-content">'
    + (wxDetailCache[icao] ? wxDetailCache[icao] : '<div class="atis-loading">載入詳細資料...</div>')
    + '</div>';
  if (!wxDetailCache[icao]) fetchWxDetail(icao, name);
  if (window.innerWidth < 640) detailPane.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function refreshWxDetail(icao, name) {
  delete wxDetailCache[icao];
  var content = document.getElementById('wx-detail-content');
  if (content) content.innerHTML = '<div class="atis-loading">重新載入...</div>';
  fetchWxDetail(icao, name);
}

function buildMetarCard(icao) {
  var lines = wxMetarRawMap[icao] || [];
  var showAll = !!wxMetarShowAll[icao];
  var noData = '<span style="color:var(--muted);font-style:italic">\u7121\u8cc7\u6599</span>';
  var displayText = lines.length === 0 ? noData : (showAll ? lines.join('\n\n') : lines[0]);
  var toggleBtns = lines.length > 1
    ? '<div style="display:flex;gap:4px;margin-left:auto">'
      + '<button onclick="setMetarMode(\'' + icao + '\',false)" class="metar-mode-btn' + (!showAll ? ' active' : '') + '">\u6700\u65b0</button>'
      + '<button onclick="setMetarMode(\'' + icao + '\',true)" class="metar-mode-btn' + (showAll ? ' active' : '') + '">6\u5c0f\u6642</button>'
      + '</div>'
    : '';
  return '<div class="atis-card"><div class="atis-card-title" style="display:flex;align-items:center">\ud83c\udf24\ufe0f METAR'
    + toggleBtns + '</div><pre>' + displayText + '</pre></div>';
}

function setMetarMode(icao, showAll) {
  wxMetarShowAll[icao] = showAll;
  delete wxDetailCache[icao];
  if (wxSelectedIcao !== icao) return;
  var content = document.getElementById('wx-detail-content');
  if (!content) return;
  var firstCard = content.querySelector('.atis-card');
  if (firstCard) {
    var tmp = document.createElement('div');
    tmp.innerHTML = buildMetarCard(icao);
    content.replaceChild(tmp.firstChild, firstCard);
  }
}

function fetchWxDetail(icao, name) {
  var proxy = 'https://api.codetabs.com/v1/proxy/?quest=';
  var metarP = fetch('/api/metar?ids=' + icao + '&hours=6')
    .then(function(r) { return r.ok ? r.text() : ''; })
    .then(function(t) {
      var lines = t.trim().split('\n').filter(function(l) { return l.trim(); });
      return lines.map(function(l) { return l.replace(/^(METAR|SPECI)\s+/, '').trim(); }).filter(function(l) { return l.length > 0; });
    }).catch(function() { return []; });
  var tafP = fetch(proxy + encodeURIComponent('https://aviationweather.gov/api/data/taf?ids=' + icao + '&format=raw'))
    .then(function(r) { return r.ok ? r.text() : ''; }).then(function(t) { return t.trim(); }).catch(function() { return ''; });
  var atisP = fetch(proxy + encodeURIComponent('https://atis.guru/atis/' + icao))
    .then(function(r) { return r.ok ? r.text() : ''; }).then(parseAtisHtml).catch(function() { return []; });
  Promise.all([metarP, tafP, atisP]).then(function(res) {
    var metarLines = res[0], tafText = res[1], atisSections = res[2];
    var content = document.getElementById('wx-detail-content');
    if (!content || wxSelectedIcao !== icao) return;
    var noData = '<span style="color:var(--muted);font-style:italic">\u7121\u8cc7\u6599</span>';
    wxMetarRawMap[icao] = metarLines;
    if (wxMetarShowAll[icao] === undefined) wxMetarShowAll[icao] = false;
    var cards = buildMetarCard(icao);
    cards += '<div class="atis-card"><div class="atis-card-title">\ud83d\udcc5 TAF</div><pre>' + (tafText || noData) + '</pre></div>';
    var atisOnly = atisSections.filter(function(s) {
      var t = s.title.toLowerCase(); return !t.includes('metar') && !t.includes('taf');
    });
    if (atisOnly.length > 0) {
      cards += atisOnly.map(function(s) {
        return '<div class="atis-card"><div class="atis-card-title">' + s.title + '</div><pre>' + s.text + '</pre></div>';
      }).join('');
    } else {
      cards += '<div class="atis-card"><div class="atis-card-title">\ud83d\udcfb ATIS</div><pre>' + noData + '</pre></div>';
    }
    wxDetailCache[icao] = cards;
    content.innerHTML = cards;
  });
}


// ── Duty Time Calculator ──────────────────────────────────────────────────────
var DT_MAX_FDP = {2:14*60, 3:18*60, 4:24*60};
var DT_MAX_FT  = {2:{noC1:10*60,c1:10*60}, 3:{noC1:12*60,c1:16*60}, 4:{noC1:12*60,c1:18*60}};
var dtMode = 'home';
var DT_DATE_IDS = ['dt-s-day','dt-e-day','dt-n-day','dt-ci-day','dt-co-day','dt-dhd-day'];

// ── HH/MM input clamp (capture phase → fires before inline handlers) ──
document.addEventListener('input', function(e) {
  var el = e.target;
  if (!el.classList.contains('dt-time-box')) return;
  var v = el.value.replace(/[^0-9]/g, '').slice(0, 2);
  var id = el.id;
  // Flight Time & Accommodation: no hard clamp
  if (id === 'dt-ft-h' || id === 'dt-ft-m' || id === 'dt-accom-h' || id === 'dt-accom-m') { el.value = v; return; }
  var max = id.match(/-m$/) ? 59 : 23;
  if (v !== '' && parseInt(v, 10) > max) v = String(max);
  if (el.value !== v) el.value = v;
}, true);

// ── Auto-jump: HH(2碼)→MM(2碼)→下一組 ──
var DT_INPUT_ORDER = [
  'dt-s-day','dt-s-h','dt-s-m',
  'dt-e-day','dt-e-h','dt-e-m',
  'dt-dhd-day','dt-dhd-h','dt-dhd-m',
  'dt-ft-h','dt-ft-m',
  'dt-n-day','dt-n-h','dt-n-m',
  'dt-ci-day','dt-ci-h','dt-ci-m',
  'dt-co-day','dt-co-h','dt-co-m',
  'dt-accom-h','dt-accom-m'
];
function dtAutoJumpNext(currentId) {
  var idx = DT_INPUT_ORDER.indexOf(currentId);
  if (idx < 0) return;
  for (var i = idx + 1; i < DT_INPUT_ORDER.length; i++) {
    var el = document.getElementById(DT_INPUT_ORDER[i]);
    if (!el) continue;
    /* skip hidden fields (e.g. DHD row not visible) */
    if (el.offsetParent === null) continue;
    /* skip date inputs — they use date picker, not text focus */
    if (el.type === 'date') continue;
    el.focus();
    el.select();
    return;
  }
}
document.addEventListener('input', function(e) {
  var el = e.target;
  if (!el.classList.contains('dt-time-box')) return;
  if (el.value.length >= (parseInt(el.maxLength) || 2)) {
    dtAutoJumpNext(el.id);
  }
});

// ── Flight Time real-time check ──
function dtCheckFT() {
  var err = document.getElementById('dt-ft-err');
  var hEl = document.getElementById('dt-ft-h');
  var mEl = document.getElementById('dt-ft-m');
  if (!err || !hEl || !mEl) return;
  var h = parseInt(hEl.value) || 0;
  var m = parseInt(mEl.value) || 0;
  var totalMin = h * 60 + m;
  if (totalMin <= 0) {
    hEl.style.color = ''; mEl.style.color = '';
    err.style.display = 'none'; err.textContent = '';
    return;
  }
  var crew = parseInt(document.querySelector('.dt-crew-btn.active').dataset.crew);
  var hasC1 = document.getElementById('dt-c1').checked;
  var maxFT = DT_MAX_FT[crew][hasC1 ? 'c1' : 'noC1'];
  var maxH = Math.floor(maxFT / 60);
  // Check FT vs Max FT
  var warns = [];
  if (totalMin > maxFT) {
    warns.push('\u26a0 Max FT: ' + maxH + 'h (' + crew + 'P' + (hasC1 ? ' + C1' : '') + ')');
  }
  // Check FT vs FDP duration
  var startMin = dtDayMin('dt-s-day','dt-s-h','dt-s-m');
  var endMin = dtDayMin('dt-e-day','dt-e-h','dt-e-m');
  if (startMin !== null && endMin !== null) {
    if (endMin <= startMin) endMin += 1440;
    var actFdp = endMin - startMin;
    if (totalMin > actFdp) {
      warns.push('\u26a0 FT (' + dtFmtHM(totalMin) + ') exceeds FDP (' + dtFmtHM(actFdp) + ')');
    }
  }
  if (warns.length) {
    hEl.style.color = '#ef4444'; mEl.style.color = '#ef4444';
    err.innerHTML = warns.join('<br>');
    err.style.display = 'block';
  } else {
    hEl.style.color = ''; mEl.style.color = '';
    err.style.display = 'none';
    err.textContent = '';
  }
}

function dtInitDates() {
  var now = new Date();
  var yyyy = now.getUTCFullYear();
  var mm = ('0'+(now.getUTCMonth()+1)).slice(-2);
  var dd = ('0'+now.getUTCDate()).slice(-2);
  var today = yyyy+'-'+mm+'-'+dd;
  var label = mm+'/'+dd;
  DT_DATE_IDS.forEach(function(id) {
    var inp = document.getElementById(id);
    var btn = document.getElementById(id+'-btn');
    if (inp) { inp.value = today; }
    if (btn) { btn.textContent = label; }
  });
}

function dtDateChanged(inp) {
  var btn = document.getElementById(inp.id+'-btn');
  if (inp.value) {
    var parts = inp.value.split('-');
    btn.textContent = parts[1]+'/'+parts[2];
    dtAutoJumpNext(inp.id);
  } else {
    btn.textContent = '--/--';
  }
}

function dtToggleAccom() {
  var on = document.getElementById('dt-accom').checked;
  document.getElementById('dt-accom-detail').style.display = on ? 'block' : 'none';
  if (on) dtUpdateAccomHint();
}

function dtToggleDhd() {
  var on = document.getElementById('dt-dhd').checked;
  document.getElementById('dt-dhd-section').style.display = on ? 'block' : 'none';
}

function dtUpdateAccomHint() {
  var h = parseInt(document.getElementById('dt-accom-h').value) || 0;
  var m = parseInt(document.getElementById('dt-accom-m').value) || 0;
  var total = h * 60 + m;
  var type = dtGetAccomType();
  var hint = document.getElementById('dt-accom-hint');
  var err = document.getElementById('dt-accom-err');
  if (!hint) return;
  // 即時驗證 > 3h
  if (err) {
    if (total > 0 && total <= 180) {
      err.textContent = '⚠ Rest Duration must be more than 3 hours to apply Accommodation rules.';
      err.style.display = 'block';
    } else {
      err.style.display = 'none';
      err.textContent = '';
    }
  }
  if (total <= 0) {
    hint.textContent = type === 'notstart'
      ? '* Mode: Deducting rest duration from Actual FDP'
      : '* Mode: Max FDP increased by 50% of rest duration';
    return;
  }
  if (type === 'notstart') {
    hint.textContent = '* Mode: Deducting ' + h + ':' + ('0' + m).slice(-2) + ' from Actual FDP';
  } else {
    var ext = Math.floor(total * 0.5);
    var eh = Math.floor(ext / 60);
    var em = ext % 60;
    hint.textContent = '* Mode: Max FDP increased by ' + eh + ':' + ('0' + em).slice(-2) + ' (50% Rest)';
  }
}

function dtGetAccomType() {
  var radios = document.getElementsByName('dt-accom-type');
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].checked) return radios[i].value;
  }
  return 'notstart';
}

function dtGetTzOffset(tzId) {
  var now = new Date();
  var yr  = now.getUTCFullYear();
  function nthSun(y, mo, n) { // mo: 0-indexed
    var d = new Date(Date.UTC(y, mo, 1));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCDate(d.getUTCDate() + (n-1)*7); return d;
  }
  function lastSun(y, mo) {
    var d = new Date(Date.UTC(y, mo+1, 0));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() - 1); return d;
  }
  if (tzId === 'la')     { var sLA=nthSun(yr,2,2),eLA=nthSun(yr,10,1); return (now>=sLA&&now<eLA)?-7:-8; }
  if (tzId === 'prague') { var sPr=lastSun(yr,2),ePr=lastSun(yr,9);   return (now>=sPr&&now<ePr)?2:1;   }
  var fixed = {taipei:8,tokyo:9,bangkok:7,phoenix:-7};
  return fixed[tzId] !== undefined ? fixed[tzId] : 8;
}

function dtFmtH(m) { // "HH:MM" for timeline labels
  var h=Math.floor(m/60), mm=m%60;
  return h+':'+(mm<10?'0':'')+mm;
}

function dtRenderTimeline(startMin, endMin, maxFdp, restStart, restEnd, minRest, tz, disc, accomExt, accomType, dhdEndMin) {
  try {
  var actFdp = endMin - startMin;
  var dhdDur = dhdEndMin ? dhdEndMin - endMin : 0;
  // Calculate total extension and base Max FDP
  var totalExt = (disc ? 2*60 : 0) + (accomType === 'start' ? (accomExt || 0) : 0);
  var baseFdp = maxFdp - totalExt;
  var dhdEnd = dhdEndMin || startMin;
  var spanEnd = restEnd !== null
    ? Math.max(startMin + maxFdp, restEnd, dhdEnd) + 60
    : Math.max(startMin + maxFdp, dhdEnd) + minRest + 60;
  var span = spanEnd - startMin;

  function pct(offset) { return (Math.max(0, offset) / span * 100).toFixed(2); }
  function setBar(barId, offset, dur) {
    var el = document.getElementById(barId);
    el.style.left  = pct(offset) + '%';
    el.style.width = (Math.max(0.1, Math.min(dur, span - Math.max(0, offset))) / span * 100).toFixed(2) + '%';
  }

  // Bars
  setBar('dt-bar-fdp', 0, actFdp);
  document.getElementById('dt-lbl-fdp').textContent = 'Actual FDP ' + dtFmtH(actFdp);
  setBar('dt-bar-maxfdp', 0, baseFdp);
  document.getElementById('dt-lbl-maxfdp').textContent = 'Max ' + dtFmtH(baseFdp);

  // FDP exceed bar + alert
  var fdpOver = document.getElementById('dt-bar-fdp-over');
  var fdpBar = document.getElementById('dt-bar-fdp');
  if (actFdp > maxFdp) {
    fdpBar.classList.add('dt-bar-alert');
    fdpOver.style.display = '';
    fdpOver.classList.add('dt-bar-alert');
    fdpOver.style.left = pct(maxFdp) + '%';
    fdpOver.style.width = (Math.max(0.1, actFdp - maxFdp) / span * 100).toFixed(2) + '%';
  } else {
    fdpBar.classList.remove('dt-bar-alert');
    fdpOver.style.display = 'none';
    fdpOver.classList.remove('dt-bar-alert');
  }

  // Ext bar (PIC Discretion and/or Accommodation Start)
  var extEl = document.getElementById('dt-bar-ext');
  if (totalExt > 0) {
    extEl.style.display = 'flex';
    setBar('dt-bar-ext', baseFdp, totalExt);
    var extParts = [];
    if (disc) extParts.push('PIC +2h');
    if (accomType === 'start' && accomExt > 0) extParts.push('Accom +' + dtFmtH(accomExt));
    document.getElementById('dt-lbl-ext').textContent = extParts.join(' / ');
  } else {
    extEl.style.display = 'none';
  }

  // DHD bar
  var dhdBar = document.getElementById('dt-bar-dhd');
  var dhdLeg = document.getElementById('dt-leg-dhd');
  if (dhdEndMin && dhdDur > 0) {
    dhdBar.style.display = 'flex';
    setBar('dt-bar-dhd', actFdp, dhdDur);
    document.getElementById('dt-lbl-dhd').textContent = 'DHD ' + dtFmtH(dhdDur);
    if (dhdLeg) dhdLeg.style.display = '';
  } else {
    dhdBar.style.display = 'none';
    if (dhdLeg) dhdLeg.style.display = 'none';
  }

  var minRestOffset = dhdEndMin ? (dhdEndMin - startMin) : actFdp;
  setBar('dt-bar-minrest', minRestOffset, minRest);
  document.getElementById('dt-lbl-minrest').textContent = 'Min Req ' + dtFmtH(minRest);

  var restBar = document.getElementById('dt-bar-rest');
  var actRest = 0;
  if (restEnd !== null) {
    actRest = restEnd - restStart;
    restBar.style.display = 'flex';
    setBar('dt-bar-rest', restStart - startMin, actRest);
    document.getElementById('dt-lbl-rest').textContent = 'Rest ' + dtFmtH(actRest);
    if (actRest < minRest) {
      restBar.classList.add('dt-bar-alert');
    } else {
      restBar.classList.remove('dt-bar-alert');
    }
  } else {
    restBar.style.display = 'none';
    restBar.classList.remove('dt-bar-alert');
  }

  // WOCL overlay (02:00-05:00 local time)
  var woclSUTC = ((2*60 - tz*60) % 1440 + 1440) % 1440;
  var woclEUTC = ((5*60 - tz*60) % 1440 + 1440) % 1440;
  var woclEl = document.getElementById('dt-bar-wocl');
  // Map WOCL to timeline-relative minutes
  var sDay = Math.floor(startMin / 1440) * 1440;
  var wS = sDay + woclSUTC;
  // If WOCL start is before FDP start, try next day
  if (wS + (woclSUTC < woclEUTC ? (woclEUTC - woclSUTC) : (1440 - woclSUTC + woclEUTC)) <= startMin) wS += 1440;
  var wDur = woclSUTC < woclEUTC ? (woclEUTC - woclSUTC) : (1440 - woclSUTC + woclEUTC);
  var wOff = wS - startMin;
  // Show if WOCL overlaps the visible span
  if (wOff < span && wOff + wDur > 0) {
    woclEl.style.display = '';
    woclEl.style.left = pct(Math.max(0, wOff)) + '%';
    var visW = Math.min(wDur, span - Math.max(0, wOff));
    if (wOff < 0) visW = Math.min(wDur + wOff, span);
    woclEl.style.width = (Math.max(0, visW) / span * 100).toFixed(2) + '%';
  } else {
    woclEl.style.display = 'none';
  }

  // Vertical lines
  function setVline(id, offset, show) {
    var el = document.getElementById(id);
    if (show) { el.style.display = ''; el.style.left = pct(offset) + '%'; }
    else el.style.display = 'none';
  }
  setVline('dt-vline-start', 0, true);
  setVline('dt-vline-end', actFdp, true);
  setVline('dt-vline-next', restEnd !== null ? restEnd - startMin : 0, restEnd !== null);

  // Tick labels
  function fmtUTC(m) {
    var t=((m%1440)+1440)%1440, h=Math.floor(t/60), mm=t%60;
    return (h<10?'0':'')+h+':'+(mm<10?'0':'')+mm+'Z';
  }
  function makeTick(leftPct, line1, line2, align, topPx) {
    var tx = align === 'left' ? 'translateX(0)' : align === 'right' ? 'translateX(-100%)' : 'translateX(-50%)';
    var ta = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
    var topS = topPx ? 'top:' + topPx + 'px;' : '';
    return '<div style="position:absolute;left:' + leftPct + '%;transform:' + tx + ';text-align:' + ta + ';font-size:.58em;color:var(--dim);line-height:1.35;white-space:nowrap;' + topS + '">' + line1 + '<br>' + line2 + '</div>';
  }
  var ticks = document.getElementById('dt-tl2-ticks');
  var fdpEndPct = parseFloat(pct(actFdp));
  var dhdEndPctVal = dhdEndMin ? parseFloat(pct(dhdEndMin - startMin)) : -999;
  var rstPct = dhdEndMin ? dhdEndPctVal : fdpEndPct;
  var nxtPct = restEnd !== null ? parseFloat(pct(restEnd - startMin)) : -999;
  // Smart alignment: right-align if close to right edge, and stagger if ticks overlap
  var nxtAlign = 'right';
  var nxtTop = 0;
  if (restEnd !== null && Math.abs(nxtPct - rstPct) < 18) nxtTop = 28;
  var html = makeTick(pct(0), 'FDP Start', fmtUTC(startMin), 'left');
  if (dhdEndMin) {
    var feAlign = fdpEndPct > 75 ? 'right' : 'center';
    html += makeTick(pct(actFdp), 'FDP End', fmtUTC(endMin), feAlign);
    var dhdAlign = dhdEndPctVal > 75 ? 'right' : 'center';
    var dhdTop = Math.abs(dhdEndPctVal - fdpEndPct) < 18 ? 28 : 0;
    html += makeTick(pct(dhdEndMin - startMin), 'Rst Start (DHD End)', fmtUTC(dhdEndMin), dhdAlign, dhdTop);
  } else {
    var rstAlign = fdpEndPct > 75 ? 'right' : 'center';
    html += makeTick(pct(actFdp), 'Rst Start (FDP End)', fmtUTC(endMin), rstAlign);
  }
  if (restEnd !== null) html += makeTick(pct(restEnd - startMin), 'Next Rpt', fmtUTC(restEnd), nxtAlign, nxtTop);
  ticks.innerHTML = html;

  // Warning text
  var warnEl = document.getElementById('dt-tl2-warn');
  var warns = [];
  if (actFdp > maxFdp) warns.push('\u26a0 FDP EXCEEDS LIMIT \u2014 Over by ' + dtFmtH(actFdp - maxFdp));
  if (restEnd !== null && actRest < minRest) warns.push('\u26a0 MINIMUM REST NOT MET \u2014 Short by ' + dtFmtH(minRest - actRest));
  if (warns.length) { warnEl.innerHTML = warns.join('<br>'); warnEl.style.display = 'block'; }
  else { warnEl.style.display = 'none'; warnEl.innerHTML = ''; }

  } catch(e) { alert('Timeline Error: ' + e.message); }
}

function dtMinRest(crew, ftMin) {
  var ft = ftMin / 60;
  if (crew === 2) return ft <= 8 ? 10*60 : 18*60;
  if (crew === 3) return ft <= 8 ? 10*60 : ft <= 12 ? 18*60 : 24*60;
  return ft <= 8 ? 10*60 : ft <= 16 ? 18*60 : 22*60;
}

function dtToggleRef() {
  var p = document.getElementById('dt-ref-panel');
  var a = document.getElementById('dt-ref-arrow');
  var open = p.style.display !== 'none';
  p.style.display = open ? 'none' : 'block';
  a.textContent   = open ? '▼' : '▲';
  if (!open) {
    setTimeout(function() {
      var wrap = p.closest('.dt-wrap');
      if (wrap) {
        var toggle = document.querySelector('.dt-ref-toggle');
        wrap.scrollTo({ top: toggle ? toggle.offsetTop : wrap.scrollHeight, behavior: 'smooth' });
      }
    }, 50);
  }
}

function dtFmtHM(m) {
  if (m < 0) m = 0;
  var h = Math.floor(m/60); var mm = m%60;
  return h + 'h ' + (mm<10?'0':'') + mm + 'm';
}

function dtFmtUTC(m) {
  var t = ((m%1440)+1440)%1440;
  var h = Math.floor(t/60); var mm = t%60;
  return (h<10?'0':'') + h + ':' + (mm<10?'0':'') + mm + 'Z';
}

function dtDayMin(dayId, hId, mId) {
  var dateVal = document.getElementById(dayId).value; // YYYY-MM-DD
  var h = parseInt(document.getElementById(hId).value);
  var m = parseInt(document.getElementById(mId).value);
  if (isNaN(h) || isNaN(m)) return null;
  if (!dateVal) return h*60 + m;
  var parts = dateVal.split('-');
  var dt = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]), h, m));
  return dt.getTime() / 60000; // absolute minutes since epoch
}

function dtSelectCrew(btn) {
  document.querySelectorAll('.dt-crew-btn').forEach(function(b){b.classList.remove('active');});
  btn.classList.add('active');
  var crew = parseInt(btn.dataset.crew);
  document.getElementById('dt-c1-row').style.display   = crew >= 3 ? 'flex' : 'none';
  document.getElementById('dt-disc-row').style.display = crew === 3 ? 'flex' : 'none';
  if (crew !== 3) document.getElementById('dt-disc').checked = false;
  if (crew < 3)   document.getElementById('dt-c1').checked  = false;
  dtCheckFT();
}

function dtSetMode(mode) {
  dtMode = mode;
  document.getElementById('dt-mode-home').classList.toggle('active', mode==='home');
  document.getElementById('dt-mode-out').classList.toggle('active',  mode==='out');
  document.getElementById('dt-next-section').style.display  = mode==='home' ? 'block' : 'none';
  document.getElementById('dt-hotel-section').style.display = mode==='out'  ? 'block' : 'none';
}

function dtCardState(cardId, ok) {
  var el = document.getElementById(cardId);
  el.classList.remove('ok','warn','err');
  if (ok === true) el.classList.add('ok');
  else if (ok === false) el.classList.add('err');
}

function dtWoclCheck(startMin, endMin, tzOffset) {
  // WOCL = 02:00–05:00 local → convert to UTC
  var wS = ((2*60 - tzOffset*60) % 1440 + 1440) % 1440;
  var wE = ((5*60 - tzOffset*60) % 1440 + 1440) % 1440;
  var wDur = wS < wE ? (wE - wS) : (1440 - wS + wE);
  // Use absolute minutes (same approach as timeline rendering)
  var sDay = Math.floor(startMin / 1440) * 1440;
  var wAbs = sDay + wS;
  if (wAbs + wDur <= startMin) wAbs += 1440;
  // Check overlap: FDP [startMin, endMin] vs WOCL [wAbs, wAbs+wDur]
  return startMin < wAbs + wDur && endMin > wAbs;
}

function dtCalculate() {
  var crew  = parseInt(document.querySelector('.dt-crew-btn.active').dataset.crew);
  var hasC1 = document.getElementById('dt-c1').checked;
  var disc  = crew===3 && document.getElementById('dt-disc').checked;
  var td6   = document.getElementById('dt-td6').checked;
  var accom = document.getElementById('dt-accom').checked;
  var accomMin = 0, accomType = 'notstart';
  var accomErr = document.getElementById('dt-accom-err');
  if (accomErr) { accomErr.style.display = 'none'; accomErr.textContent = ''; }
  if (accom) {
    accomMin = (parseInt(document.getElementById('dt-accom-h').value)||0)*60 +
               (parseInt(document.getElementById('dt-accom-m').value)||0);
    if (accomMin <= 180) {
      if (accomErr) {
        accomErr.textContent = '⚠ Rest Duration must be more than 3 hours to apply Accommodation rules.';
        accomErr.style.display = 'block';
      }
      return;
    }
    accomType = dtGetAccomType();
  }
  var tz    = dtGetTzOffset(document.getElementById('dt-tz').value);

  var startMin = dtDayMin('dt-s-day','dt-s-h','dt-s-m');
  var endMin   = dtDayMin('dt-e-day','dt-e-h','dt-e-m');
  var hasDhd   = document.getElementById('dt-dhd').checked;
  var dhdEndMin = hasDhd ? dtDayMin('dt-dhd-day','dt-dhd-h','dt-dhd-m') : null;
  var ftMin    = (parseInt(document.getElementById('dt-ft-h').value)||0)*60 +
                 (parseInt(document.getElementById('dt-ft-m').value)||0);

  if (startMin === null) {
    alert('請輸入 FDP Start 時間');
    return;
  }

  var maxFdp = DT_MAX_FDP[crew] + (disc ? 2*60 : 0);
  var accomExt = 0;
  if (accom && accomMin > 0 && accomType === 'start') {
    accomExt = Math.floor(accomMin * 0.5);
    maxFdp = Math.min(maxFdp + accomExt, 24*60);
  }
  var maxFt  = hasC1 ? DT_MAX_FT[crew].c1 : DT_MAX_FT[crew].noC1;

  // ── Deadline cards (always shown) ──────────────────────────────────────────
  var maxFdpDeadline = startMin + maxFdp;
  var maxFtDeadline  = startMin + maxFt;
  document.getElementById('dt-r-maxfdp-time').textContent = dtFmtUTC(maxFdpDeadline);
  document.getElementById('dt-r-maxfdp-dur').textContent  = dtFmtHM(maxFdp) + (disc ? ' (incl. disc.)' : '');
  document.getElementById('dt-r-maxft-time').textContent  = dtFmtUTC(maxFtDeadline);
  document.getElementById('dt-r-maxft-dur').textContent   = dtFmtHM(maxFt) + (hasC1 ? ' (C1)' : '');

  // ── Ext note ───────────────────────────────────────────────────────────────
  var extNote = document.getElementById('dt-ext-note');
  if (disc) { extNote.textContent = '🟣 PIC Discretion applied: +2h to Max FDP'; extNote.style.display='block'; }
  else extNote.style.display = 'none';

  // Show results
  document.getElementById('dt-results-area').style.display = 'block';

  // ── If FDP End not provided, hide compliance cards and timeline ────────────
  if (endMin === null) {
    document.getElementById('dt-card-fdp').style.display  = 'none';
    document.getElementById('dt-card-ft').style.display   = 'none';
    document.getElementById('dt-card-rest').style.display = 'none';
    document.getElementById('dt-wocl-box').style.display  = 'none';
    document.querySelector('.dt-tl2').style.display        = 'none';
    return;
  }

  // If end < start (crossed midnight), add 1 day
  if (endMin <= startMin) endMin += 1440;
  // DHD End must be after FDP End
  if (dhdEndMin !== null && dhdEndMin <= endMin) dhdEndMin += 1440;

  var actFdp  = endMin - startMin;

  // Re-validate FT vs FDP in case Calculate was pressed
  dtCheckFT();
  // Accommodation Not Start: deduct rest from actual FDP
  var adjFdp = actFdp;
  if (accom && accomMin > 0 && accomType === 'notstart') {
    adjFdp = Math.max(0, actFdp - accomMin);
  }
  var minRest = td6 ? 48*60 : dtMinRest(crew, ftMin);

  // Show compliance cards and timeline
  document.querySelector('.dt-tl2').style.display = '';

  // Rest calculation
  var restStart = null, restEnd = null, actRest = null;
  if (dtMode === 'home') {
    var nxtMin = dtDayMin('dt-n-day','dt-n-h','dt-n-m');
    if (nxtMin !== null) {
      restStart = (dhdEndMin !== null) ? dhdEndMin : endMin;
      restEnd = nxtMin;
      if (restEnd <= restStart) restEnd += 1440;
      actRest = restEnd - restStart;
    }
  } else {
    var ciMin = dtDayMin('dt-ci-day','dt-ci-h','dt-ci-m');
    var coMin = dtDayMin('dt-co-day','dt-co-h','dt-co-m');
    if (ciMin !== null && coMin !== null) {
      restStart = ciMin; restEnd = coMin;
      if (restEnd <= restStart) restEnd += 1440;
      actRest = restEnd - restStart;
    }
  }

  // FDP card
  var fdpOk = adjFdp <= maxFdp;
  document.getElementById('dt-card-fdp').style.display    = '';
  var fdpLabel = dtFmtHM(actFdp);
  if (accom && accomMin > 0 && accomType === 'notstart') {
    fdpLabel += ' → ' + dtFmtHM(adjFdp) + ' (−Accom)';
  }
  document.getElementById('dt-r-fdp').textContent         = fdpLabel;
  var maxLabel = 'Max: ' + dtFmtHM(maxFdp);
  if (disc) maxLabel += ' (incl. PIC disc.)';
  if (accom && accomMin > 0 && accomType === 'start') maxLabel += ' (incl. Accom +' + dtFmtHM(accomExt) + ')';
  document.getElementById('dt-r-fdp-max').textContent     = maxLabel;
  dtCardState('dt-card-fdp', fdpOk);

  // FT card
  var ftOk = ftMin === 0 ? null : ftMin <= maxFt;
  document.getElementById('dt-card-ft').style.display    = '';
  document.getElementById('dt-r-ft').textContent         = ftMin > 0 ? dtFmtHM(ftMin) : '—';
  document.getElementById('dt-r-ft-max').textContent     = 'Max: ' + dtFmtHM(maxFt) + (hasC1 ? ' (C1)' : '');
  dtCardState('dt-card-ft', ftOk);

  // Rest card
  var minRestLabel = td6 ? 'No FD at least 48hr' : dtFmtHM(minRest);
  document.getElementById('dt-card-rest').style.display = '';
  if (actRest !== null) {
    var restOk = actRest >= minRest;
    document.getElementById('dt-r-rest').textContent     = dtFmtHM(actRest);
    document.getElementById('dt-r-rest-min').textContent = 'Min: ' + minRestLabel;
    dtCardState('dt-card-rest', restOk);
  } else {
    document.getElementById('dt-r-rest').textContent     = '—';
    document.getElementById('dt-r-rest-min').textContent = 'Min required: ' + minRestLabel;
    dtCardState('dt-card-rest', null);
  }

  // WOCL
  var woclHit = dtWoclCheck(startMin, endMin, tz);
  var woclBox = document.getElementById('dt-wocl-box');
  if (woclHit) {
    document.getElementById('dt-wocl-msg').innerHTML = 'FDP 觸碰 WOCL 時段。連續2天需34h休息，連續3天需54h休息。例外：每次WOCL後有14h休息則免除。<br><span style="opacity:.7">FDP overlaps WOCL window. 2 consecutive days require 34h rest; 3 consecutive days require 54h rest. Exception: waived if 14h rest is provided after each WOCL.</span>';
    woclBox.style.display = 'block';
  } else {
    woclBox.style.display = 'none';
  }

  // CSS percentages recalculate on reflow, no timing hacks needed
  dtRenderTimeline(startMin, endMin, maxFdp, restStart, restEnd, minRest, tz, disc, accomExt, accomType, dhdEndMin);
  _dtSave();
}

/* ── Duty Time 持久化 ── */
var _dtInputIds = [
  'dt-tz','dt-s-day','dt-s-h','dt-s-m','dt-e-day','dt-e-h','dt-e-m',
  'dt-ft-h','dt-ft-m','dt-n-day','dt-n-h','dt-n-m',
  'dt-ci-day','dt-ci-h','dt-ci-m','dt-co-day','dt-co-h','dt-co-m',
  'dt-dhd-day','dt-dhd-h','dt-dhd-m','dt-accom-h','dt-accom-m'
];
var _dtCheckIds = ['dt-c1','dt-disc','dt-td6','dt-accom','dt-dhd'];

function _dtSave() {
  try {
    var obj = { mode: dtMode, inputs: {}, checks: {} };
    _dtInputIds.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) obj.inputs[id] = el.value || '';
    });
    _dtCheckIds.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) obj.checks[id] = el.checked;
    });
    localStorage.setItem('crewsync_dt_data', JSON.stringify(obj));
  } catch(e){}
}

function _dtRestore() {
  try {
    var s = localStorage.getItem('crewsync_dt_data');
    if (!s) return;
    var obj = JSON.parse(s);
    if (obj.mode) dtSetMode(obj.mode);
    if (obj.inputs) {
      Object.keys(obj.inputs).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) {
          el.value = obj.inputs[id] || '';
          // 更新日期顯示
          if (id.match(/-day$/) && el.value) dtDateChanged(el);
        }
      });
    }
    if (obj.checks) {
      Object.keys(obj.checks).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.checked = !!obj.checks[id];
      });
      // 觸發相關顯示邏輯
      if (obj.checks['dt-dhd']) dtToggleDhd();
      if (obj.checks['dt-accom']) dtToggleAccom();
    }
  } catch(e){}
}

function dtReset() {
  _dtInputIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  _dtCheckIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.checked = false;
  });
  dtMode = 'home';
  document.getElementById('dt-mode-home').classList.add('active');
  document.getElementById('dt-mode-out').classList.remove('active');
  document.getElementById('dt-hotel-section').style.display = 'none';
  document.getElementById('dt-dhd-section').style.display = 'none';
  document.getElementById('dt-accom-detail').style.display = 'none';
  document.getElementById('dt-results-area').style.display = 'none';
  var crew3 = document.querySelector('.dt-crew-btn[data-crew="3"]');
  if (crew3) { document.querySelectorAll('.dt-crew-btn').forEach(function(b) { b.classList.remove('active'); }); crew3.classList.add('active'); }
  dtInitDates();
  try { localStorage.removeItem('crewsync_dt_data'); } catch(e){}
}

// ── Boot ─────────────────────────────────────────────────────────────────────
dtInitDates();
showMain();
// 預設顯示簡報箱 datis 分頁 → 立即載入初始天氣資料
wxLoaded = true; (function(){ var fsel = document.getElementById('wx-fleet-select'); if (fsel) fsel.value = wxCurrentFleet; })(); loadWxRegion(wxCurrentRegion);
// ── Service Worker 註冊 ───────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function(){});
}

// ── Gate Info ──────────────────────────────────────────────────────────────────
var gateFlightsLoaded = false;
var gateFlightsList = [];
var giSortKey = 'dest';
var giSortAsc = true;
var _giSelectedDate = null; // null = today, 'YYYY/MM/DD' = specific date
var _giFirstScrollDone = false;
var _giRawDep = [];
var _giRawArr = [];
var _giAirline = (function(){ try { return localStorage.getItem('crewsync_gi_airline') || 'JX'; } catch(e){ return 'JX'; } })();
var _giTimeSlot = '±2hr';

function giFmtTime(t) {
  if (!t) return '';
  return t.replace(/:\d{2}$/, '');
}

var _giCityNames = {
  SFO:'舊金山',LAX:'洛杉磯',SEA:'西雅圖',PHX:'鳳凰城',ONT:'安大略',
  NRT:'成田',KIX:'關西',FUK:'福岡',CTS:'札幌',OKA:'沖繩',KMJ:'熊本',
  NGO:'名古屋',SDJ:'仙台',KOJ:'鹿兒島',AOJ:'青森',TAK:'高松',UKB:'神戶',RMQ:'台中',
  ICN:'仁川',PUS:'釜山',
  HKG:'香港',MFM:'澳門',
  SIN:'新加坡',BKK:'曼谷',SGN:'胡志明',HAN:'河內',PNH:'金邊',
  MNL:'馬尼拉',CEB:'宿霧',CGK:'雅加達',DPS:'峇里島',KUL:'吉隆坡',PEN:'檳城',
  PRG:'布拉格',TPE:'桃園'
};

var _giIcaoToIata = {
  KSFO:'SFO',KLAX:'LAX',KSEA:'SEA',KPHX:'PHX',KONT:'ONT',
  RJAA:'NRT',RJBB:'KIX',RJFF:'FUK',RJCC:'CTS',ROAH:'OKA',RJFT:'KMJ',
  RJGG:'NGO',RJSS:'SDJ',RJFK:'KOJ',RJSA:'AOJ',RJOT:'TAK',RJBE:'UKB',RCMQ:'RMQ',
  RKSI:'ICN',RKPK:'PUS',
  VHHH:'HKG',VMMC:'MFM',
  WSSS:'SIN',VTBS:'BKK',VVTS:'SGN',VVNB:'HAN',VDPP:'PNH',
  RPLL:'MNL',RPVM:'CEB',WIII:'CGK',WADD:'DPS',WMKK:'KUL',WMKP:'PEN',
  LKPR:'PRG',RCTP:'TPE'
};

function giAirportDisplay(name, code) {
  var n = name || _giCityNames[code] || '';
  if (n && code && n !== code) return n + ' ' + code;
  return n || code || '';
}

function _giDate() {
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw.getUTCFullYear() + '/' +
    String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(tw.getUTCDate()).padStart(2, '0');
}

function _giFetchDirect(dateOverride) {
  var ep = atob('aHR0cHM6Ly93d3cudGFveXVhbi1haXJwb3J0LmNvbS9hcGkvYXBpL2ZsaWdodC9hX2ZsaWdodA==');
  var odate = dateOverride || _giDate();
  var base = {
    ODate: odate, OTimeOpen: null, OTimeClose: null,
    BNO: null, AState: '', language: 'ch', keyword: ''
  };
  var hdrs = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*'
  };
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

function giMakeRow(f) {
  var tr = document.createElement('tr');

  var originDisplay = giAirportDisplay(f.originName, f.originCode || (f.origin === 'TPE' ? 'TPE' : ''));
  if (!originDisplay && f.origin) originDisplay = f.origin;

  var destDisplay = giAirportDisplay(f.destName, f.destCode || (f.dest === 'TPE' ? 'TPE' : ''));
  if (!destDisplay && f.dest) destDisplay = f.dest;

  var cells = [
    { val: f.fno },
    { val: originDisplay || '—' },
    { val: f.depTerminal || '—' },
    { val: f.checkin || '—' },
    { val: f.gate || '—' },
    { val: f.std || '—' },
    { val: f.atd || '—' },
    { val: destDisplay || '—' },
    { val: f.arrTerminal || '—' },
    { val: f.parking || '—' },
    { val: f.carousel || '—' },
    { val: f.sta || '—' },
    { val: f.ata || '—' }
  ];

  var timeCols = { 5:1, 6:1, 11:1, 12:1 };
  cells.forEach(function(c, idx) {
    var td = document.createElement('td');
    td.textContent = c.val;
    if (idx === 0) {
      td.className = 'gi-fno gi-sticky-col';
      var fno = c.val || '';
      if (fno.indexOf('JX') === 0) td.style.color = '#B8860B';
      else if (fno.indexOf('BR') === 0) td.style.color = '#00A651';
      else if (fno.indexOf('CI') === 0) td.style.color = '#E91E8C';
    }
    if (timeCols[idx]) td.className = (td.className ? td.className + ' ' : '') + 'gi-time-col';
    tr.appendChild(td);
  });

  return tr;
}

var _giViewMode = 'dest';
function toggleGiView() {
  var wrap = document.getElementById('gate-table-wrap');
  var pw = document.getElementById('gi-pinned-wrap');
  var btn = document.getElementById('gi-view-btn');
  if (!wrap) return;
  var stickyCol = document.querySelector('#gi-table thead th.gi-sticky-col');
  var offset = stickyCol ? stickyCol.offsetWidth : 0;
  if (_giViewMode === 'dest') {
    _giViewMode = 'orig';
    btn.textContent = '🛬 Dest';
    // Sort by origin (TPE first)
    giSortKey = 'origin'; giSortAsc = true;
    _giUpdateSortHeaders('origin');
    renderGateFlights();
    // Scroll to origin columns
    setTimeout(function() {
      var origTh = document.querySelector('#gi-table thead th.gi-sortable[onclick*="origin"]');
      if (origTh) {
        var pos = origTh.offsetLeft - offset;
        wrap.scrollLeft = pos;
        if (pw && pw.style.display !== 'none') pw.scrollLeft = pos;
      }
    }, 0);
  } else {
    _giViewMode = 'dest';
    btn.textContent = '🛫 Orig';
    // Sort by dest (TPE first)
    giSortKey = 'dest'; giSortAsc = true;
    _giUpdateSortHeaders('dest');
    renderGateFlights();
    // Scroll to dest columns
    setTimeout(function() {
      var destTh = document.querySelector('#gi-table thead th.gi-sortable[onclick*="dest"]');
      if (destTh) {
        var pos = destTh.offsetLeft - offset;
        wrap.scrollLeft = pos;
        if (pw && pw.style.display !== 'none') pw.scrollLeft = pos;
      }
    }, 0);
  }
}

function toggleGiTime() {
  var table = document.getElementById('gi-table');
  var pinnedTable = document.getElementById('gi-pinned-table');
  var btn = document.getElementById('gi-time-btn');
  if (table.classList.contains('gi-hide-time')) {
    table.classList.remove('gi-hide-time');
    if (pinnedTable) pinnedTable.classList.remove('gi-hide-time');
    btn.classList.add('gi-time-btn-on');
  } else {
    table.classList.add('gi-hide-time');
    if (pinnedTable) pinnedTable.classList.add('gi-hide-time');
    btn.classList.remove('gi-time-btn-on');
  }
}

function giMakeTestRow(f) {
  var tr = document.createElement('tr');
  tr.className = 'gi-test-row';
  var originVal = f.direction === 'A' ? (f.origin || '—') : f.airport;
  var destVal = f.direction === 'A' ? f.airport : (f.dest || '—');
  var depTerminal = f.direction === 'D' ? (f.terminal || '—') : '—';
  var arrTerminal = f.direction === 'A' ? (f.terminal || '—') : '—';
  var parking = f.direction === 'A' ? (f.gate || '—') : '—';
  var gate = f.direction === 'D' ? (f.gate || '—') : '—';
  var cells = [
    { val: '[TEST] ' + f.fno },
    { val: originVal },
    { val: depTerminal },
    { val: '—' },
    { val: gate },
    { val: f.scheduled || '—' },
    { val: '—' },
    { val: destVal },
    { val: arrTerminal },
    { val: parking },
    { val: f.carousel || '—' },
    { val: '—' },
    { val: f.status || '—' }
  ];
  var timeCols = { 5:1, 6:1, 11:1, 12:1 };
  cells.forEach(function(c, idx) {
    var td = document.createElement('td');
    td.textContent = c.val;
    if (timeCols[idx]) td.className = 'gi-time-col';
    tr.appendChild(td);
  });
  return tr;
}

function renderGateFlights() {
  var tableBody = document.getElementById('gate-tbody');
  var searchInput = document.getElementById('gate-search');
  var searchTerm = (searchInput && searchInput.value || '').replace(/\s/g, '').replace(/^0+/, '');

  tableBody.innerHTML = '';

  // Show test rows at top
  if (_giTestRows.length > 0) {
    var testHeader = document.createElement('tr');
    testHeader.className = 'gi-test-header';
    var th = document.createElement('td');
    th.colSpan = 13;
    th.textContent = '⚠ 以下為測試資料（驗證各機場資料來源）';
    testHeader.appendChild(th);
    tableBody.appendChild(testHeader);
    _giTestRows.forEach(function(f) {
      tableBody.appendChild(giMakeTestRow(f));
    });
    var sep0 = document.createElement('tr');
    sep0.className = 'gi-separator';
    var td0 = document.createElement('td');
    td0.colSpan = 13;
    sep0.appendChild(td0);
    tableBody.appendChild(sep0);
  }

  var pinned = [];
  var others = [];

  var sorted = _giSortList(gateFlightsList);
  sorted = sorted.filter(_giTimeFilter);

  if (searchTerm) {
    var isNumeric = /^\d+$/.test(searchTerm);
    var termUpper = searchTerm.toUpperCase();
    // If ICAO code, convert to IATA for matching
    var iataFromIcao = _giIcaoToIata[termUpper] || '';

    sorted.forEach(function(f) {
      var matched = false;
      if (isNumeric) {
        // Flight number search
        var num = f.fno.replace(/^(JX|BR|CI)/, '');
        matched = (num === searchTerm || num.indexOf(searchTerm) === 0);
      } else {
        // Station search: IATA code, ICAO (via mapping), or city name
        var oCode = (f.originCode || '').toUpperCase();
        var dCode = (f.destCode || '').toUpperCase();
        var oName = f.originName || '';
        var dName = f.destName || '';
        var fno = f.fno.toUpperCase();

        matched = fno.indexOf(termUpper) >= 0
          || oCode.indexOf(termUpper) >= 0
          || dCode.indexOf(termUpper) >= 0
          || oName.indexOf(searchTerm) >= 0
          || dName.indexOf(searchTerm) >= 0;

        // ICAO match
        if (!matched && iataFromIcao) {
          matched = (oCode === iataFromIcao || dCode === iataFromIcao);
        }
      }

      if (matched) {
        pinned.push(f);
      } else {
        others.push(f);
      }
    });
  } else {
    others = sorted;
  }

  // Pinned search results → separate container
  var pinnedWrap = document.getElementById('gi-pinned-wrap');
  var pinnedBody = document.getElementById('gi-pinned-tbody');
  var pinnedHeader = document.getElementById('gi-pinned-header');
  pinnedBody.innerHTML = '';

  var mainThead = document.querySelector('#gi-table thead');
  var pinnedThead = document.querySelector('#gi-pinned-table thead');

  if (pinned.length > 0) {
    pinnedHeader.textContent = '搜尋結果（' + pinned.length + ' 筆）';
    pinned.forEach(function(f) {
      pinnedBody.appendChild(giMakeRow(f));
    });
    pinnedWrap.style.display = '';
    if (pinnedThead) pinnedThead.style.display = '';
    if (mainThead) mainThead.style.display = 'none';
    // Scroll main table to top-left
    var wrap = document.getElementById('gate-table-wrap');
    if (wrap) { wrap.scrollLeft = 0; wrap.scrollTop = 0; }
    _giSetupScrollSync();
  } else {
    pinnedWrap.style.display = 'none';
    if (pinnedThead) pinnedThead.style.display = 'none';
    if (mainThead) mainThead.style.display = '';
  }

  // Other flights → main table
  others.forEach(function(f) {
    tableBody.appendChild(giMakeRow(f));
  });

  // Auto-scroll to destination column on portrait mobile (first load only)
  if (!_giFirstScrollDone && window.innerHeight > window.innerWidth && window.innerWidth < 768) {
    var destTh = document.querySelector('#gi-table thead th.gi-sortable[onclick*="dest"]');
    var wrap = document.getElementById('gate-table-wrap');
    if (destTh && wrap) {
      var stickyCol = document.querySelector('#gi-table thead th.gi-sticky-col');
      var offset = stickyCol ? stickyCol.offsetWidth : 0;
      wrap.scrollLeft = destTh.offsetLeft - offset;
      _giFirstScrollDone = true;
    }
  }
}

var _giScrollSyncing = false;
function _giSetupScrollSync() {
  var pw = document.getElementById('gi-pinned-wrap');
  var tw = document.getElementById('gate-table-wrap');
  if (!pw || !tw) return;
  pw.onscroll = function() {
    if (!_giScrollSyncing) { _giScrollSyncing = true; tw.scrollLeft = pw.scrollLeft; _giScrollSyncing = false; }
  };
  tw.onscroll = function() {
    if (!_giScrollSyncing) { _giScrollSyncing = true; pw.scrollLeft = tw.scrollLeft; _giScrollSyncing = false; }
  };
}

function _giGetSortVal(f, key) {
  if (key === 'fno') return f.fno || '';
  if (key === 'origin') return (f.originName || f.originCode || f.origin || '');
  if (key === 'dest') return (f.destName || f.destCode || f.dest || '');
  if (key === 'std') return f.std || '';
  if (key === 'atd') return f.atd || '';
  if (key === 'sta') return f.sta || '';
  if (key === 'ata') return f.ata || '';
  return '';
}

function _giSortList(list) {
  var sorted = list.slice();
  var timeCols = { std:1, atd:1, sta:1, ata:1 };
  sorted.sort(function(a, b) {
    var va = _giGetSortVal(a, giSortKey);
    var vb = _giGetSortVal(b, giSortKey);
    // Time columns: empty values always to end
    if (timeCols[giSortKey]) {
      var aEmpty = !va;
      var bEmpty = !vb;
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      if (aEmpty && bEmpty) return 0;
      var cmp = va.localeCompare(vb);
      return giSortAsc ? cmp : -cmp;
    }
    if (giSortKey === 'origin' || giSortKey === 'dest') {
      var twAirports = /TPE|桃園/;
      var twOther = /RMQ|台中|KHH|高雄|TSA|松山/;
      var aRank = twAirports.test(va) ? 0 : twOther.test(va) ? 1 : 2;
      var bRank = twAirports.test(vb) ? 0 : twOther.test(vb) ? 1 : 2;
      if (aRank !== bRank) return giSortAsc ? aRank - bRank : bRank - aRank;
    }
    if (giSortKey === 'fno') {
      var cmp = va.localeCompare(vb, undefined, { numeric: true });
      return giSortAsc ? cmp : -cmp;
    }
    var cmp2 = va.localeCompare(vb);
    return giSortAsc ? cmp2 : -cmp2;
  });
  return sorted;
}

function _giUpdateSortHeaders(key) {
  var allThs = document.querySelectorAll('#gi-table thead th.gi-sortable, #gi-pinned-table thead th.gi-sortable');
  allThs.forEach(function(th) { th.classList.remove('gi-sort-asc', 'gi-sort-desc'); });
  var cls = giSortAsc ? 'gi-sort-asc' : 'gi-sort-desc';
  allThs.forEach(function(th) {
    var onclick = th.getAttribute('onclick') || '';
    if (onclick.indexOf("'" + key + "'") >= 0) th.classList.add(cls);
  });
}

function giSort(key) {
  if (giSortKey === key) {
    giSortAsc = !giSortAsc;
  } else {
    giSortKey = key;
    giSortAsc = true;
  }
  _giUpdateSortHeaders(key);
  renderGateFlights();
}

function filterGateFlights() {
  if (gateFlightsList.length > 0) renderGateFlights();
}

var _giTestRows = [];

function _giFaTime(isoStr) {
  if (!isoStr) return '';
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  // Convert to Taiwan time (UTC+8)
  var tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return String(tw.getUTCHours()).padStart(2, '0') + ':' + String(tw.getUTCMinutes()).padStart(2, '0');
}

function _giMergeFA(map, faData, airline) {
  _giTestRows = [];
  var flights = faData.flights || {};
  var prefix = airline || 'JX';
  Object.keys(flights).forEach(function(key) {
    var fa = flights[key];
    if (!fa || !fa.fno) return;
    var fno = fa.fno;
    var re = new RegExp('^' + prefix);
    if (!re.test(fno)) return;
    var isNew = !map[fno];
    var m = map[fno];
    if (!m) {
      m = { fno: fno };
      map[fno] = m;
    }

    // New flight not in TPE FIDS → fill all fields from FA
    if (isNew) {
      var oIata = (fa.origin && fa.origin.iata) || '';
      var dIata = (fa.destination && fa.destination.iata) || '';
      m.origin = oIata;
      m.originCode = oIata;
      m.originName = _giCityNames[oIata] || '';
      m.dest = dIata;
      m.destCode = dIata;
      m.destName = _giCityNames[dIata] || '';
      m.gate = (fa.origin && fa.origin.gate) || '';
      m.depTerminal = (fa.origin && fa.origin.terminal) || '';
      m.parking = (fa.destination && fa.destination.gate) || '';
      m.arrTerminal = (fa.destination && fa.destination.terminal) || '';
      m.std = _giFaTime(fa.scheduledDep);
      m.atd = _giFaTime(fa.actualDep);
      m.sta = _giFaTime(fa.scheduledArr);
      m.ata = _giFaTime(fa.actualArr);
    } else {
      // Existing flight from TPE FIDS → only supplement non-TPE gate/terminal
      if (fa.origin && fa.origin.iata && fa.origin.iata !== 'TPE') {
        if (!m.gate || m.gate === '—') m.gate = fa.origin.gate || '';
        if (!m.depTerminal) m.depTerminal = fa.origin.terminal || '';
      }
      if (fa.destination && fa.destination.iata && fa.destination.iata !== 'TPE') {
        if (!m.parking || m.parking === '—') m.parking = fa.destination.gate || '';
        if (!m.arrTerminal) m.arrTerminal = fa.destination.terminal || '';
      }
    }
  });
}

function loadGateFlights() {
  var statusEl = document.getElementById('gate-status');
  var tableBody = document.getElementById('gate-tbody');
  var dateEl = document.getElementById('gate-date');
  var wrapEl = document.getElementById('gate-table-wrap');

  statusEl.textContent = '載入中...';
  statusEl.style.display = 'block';
  wrapEl.style.display = 'none';
  tableBody.innerHTML = '';
  gateFlightsList = [];

  var dateStr = _giSelectedDate || _paDateOffset(0);
  var tpePromise = _fidsFetchByDate(dateStr);

  tpePromise.then(function(data) {
    dateEl.textContent = data.date || '';
    _giRawDep = data.dep || [];
    _giRawArr = data.arr || [];
    _giProcessFlights();
  }).catch(function(e) {
    statusEl.textContent = '載入失敗：' + e.message;
    statusEl.style.display = 'block';
  });
}

function _giProcessFlights() {
  var statusEl = document.getElementById('gate-status');
  var wrapEl = document.getElementById('gate-table-wrap');

  var airline = _giAirline;
  var isAll = (airline === 'ALL');

  // Filter TPE FIDS by airline
  var dep = _giRawDep.filter(function(f) {
    if (isAll) return f.ACode && /^(JX|BR|CI)$/.test(f.ACode.trim());
    return f.ACode && f.ACode.trim() === airline;
  });
  var arr = _giRawArr.filter(function(f) {
    if (isAll) return f.ACode && /^(JX|BR|CI)$/.test(f.ACode.trim());
    return f.ACode && f.ACode.trim() === airline;
  });

  var map = {};

  dep.forEach(function(f) {
    var acode = f.ACode.trim();
    var key = acode + f.FlightNo.replace(/\s/g, '');
    if (!map[key]) map[key] = { fno: key };
    var m = map[key];
    m.origin = 'TPE';
    m.originCode = 'TPE';
    m.originName = '桃園';
    m.dest = f.CityCode || '';
    m.destCode = f.CityCode || '';
    m.destName = f.CityName || f.CityCode || '';
    m.checkin = f.CheckIn || '';
    m.gate = f.Gate || '';
    m.std = giFmtTime(f.OTime);
    m.atd = giFmtTime(f.RTime);
    m.depTerminal = f.BNO ? 'T' + f.BNO : '';
    m.depMemo = f.Memo || '';
  });

  arr.forEach(function(f) {
    var acode = f.ACode.trim();
    var key = acode + f.FlightNo.replace(/\s/g, '');
    if (!map[key]) map[key] = { fno: key };
    var m = map[key];
    m.originCode = f.CityCode || '';
    m.originName = f.CityName || f.CityCode || '';
    if (!m.origin) m.origin = f.CityCode || '';
    if (!m.dest) m.dest = 'TPE';
    if (!m.destCode) m.destCode = 'TPE';
    if (!m.destName) m.destName = '桃園';
    m.parking = f.Gate || '';
    m.carousel = f.StopCode || '';
    m.sta = giFmtTime(f.OTime);
    m.ata = giFmtTime(f.RTime);
    m.arrTerminal = f.BNO ? 'T' + f.BNO : '';
    m.arrMemo = f.Memo || '';
  });

  var flights = Object.values(map);
  if (flights.length === 0) {
    var label = isAll ? 'ALL' : airline;
    statusEl.textContent = '今日無 ' + label + ' 航班資料';
    statusEl.style.display = 'block';
    wrapEl.style.display = 'none';
    return;
  }

  gateFlightsList = flights;
  statusEl.style.display = 'none';
  wrapEl.style.display = '';
  renderGateFlights();
  gateFlightsLoaded = true;

  // Background fetch gate data: FR24 first, FA fallback (today only)
  var isToday = !_giSelectedDate;
  if (isToday) {
    var currentAirline = _giAirline;
    var airlines = isAll ? ['JX', 'BR', 'CI'] : [airline];
    // Try FR24 first
    fetch('/api/fids-fr24')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(fr24Data) {
        if (_giAirline !== currentAirline) return;
        if (fr24Data && fr24Data.count > 0) {
          airlines.forEach(function(al) {
            _giMergeFA(map, fr24Data, al);
          });
          gateFlightsList = Object.values(map);
          renderGateFlights();
        }
        // Also fetch FA as supplement (may have flights FR24 missed)
        var faPromises = airlines.map(function(al) {
          return fetch('/api/fids-fa?airline=' + al)
            .then(function(r) { return r.ok ? r.json() : { flights: {} }; })
            .catch(function() { return { flights: {} }; })
            .then(function(data) { return { airline: al, data: data }; });
        });
        return Promise.all(faPromises);
      })
      .then(function(results) {
        if (!results || _giAirline !== currentAirline) return;
        results.forEach(function(r) {
          _giMergeFA(map, r.data, r.airline);
        });
        gateFlightsList = Object.values(map);
        renderGateFlights();
      })
      .catch(function() {
        // FR24 failed, fall back to FA only
        var faPromises = airlines.map(function(al) {
          return fetch('/api/fids-fa?airline=' + al)
            .then(function(r) { return r.ok ? r.json() : { flights: {} }; })
            .catch(function() { return { flights: {} }; })
            .then(function(data) { return { airline: al, data: data }; });
        });
        Promise.all(faPromises).then(function(results) {
          if (_giAirline !== currentAirline) return;
          results.forEach(function(r) {
            _giMergeFA(map, r.data, r.airline);
          });
          gateFlightsList = Object.values(map);
          renderGateFlights();
        });
      });
  }
}

function refreshGateFlights() {
  loadGateFlights();
}

function _giTodayStr() {
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw.getUTCFullYear() + '/' +
    String(tw.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(tw.getUTCDate()).padStart(2, '0');
}

function _giShiftDate(dateStr, days) {
  var parts = dateStr.split('/');
  var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '/' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '/' +
    String(d.getUTCDate()).padStart(2, '0');
}

function _giUpdateDateNav() {
  var today = _giTodayStr();
  var current = _giSelectedDate || today;
  var prevBtn = document.getElementById('gi-prev-day');
  var nextBtn = document.getElementById('gi-next-day');
  var todayBtn = document.getElementById('gi-today-btn');
  var tomorrow = _giShiftDate(today, 1);
  var yesterday = _giShiftDate(today, -1);
  if (prevBtn) prevBtn.disabled = (current <= yesterday);
  if (nextBtn) nextBtn.disabled = (current >= tomorrow);
  if (todayBtn) todayBtn.style.display = (current === today) ? 'none' : '';
}

function giPrevDay() {
  var today = _giTodayStr();
  var current = _giSelectedDate || today;
  var prev = _giShiftDate(current, -1);
  var yesterday = _giShiftDate(today, -1);
  if (prev < yesterday) return;
  _giSelectedDate = (prev === today) ? null : prev;
  _giUpdateDateNav();
  loadGateFlights();
}

function giNextDay() {
  var today = _giTodayStr();
  var current = _giSelectedDate || today;
  var next = _giShiftDate(current, 1);
  var tomorrow = _giShiftDate(today, 1);
  if (next > tomorrow) return;
  _giSelectedDate = (next === today) ? null : next;
  _giUpdateDateNav();
  loadGateFlights();
}

function giToday() {
  _giSelectedDate = null;
  _giUpdateDateNav();
  loadGateFlights();
}

// ── Airline / Time Slot / Sort UI ─────────────────────────────────────────────

function giSetAirline(al) {
  _giAirline = al;
  try { localStorage.setItem('crewsync_gi_airline', al); } catch(e){}
  _giUpdateAirlineBtns();
  var titleEl = document.querySelector('.gi-title');
  if (titleEl) titleEl.textContent = (al === 'ALL' ? 'ALL' : al) + ' Flight Info';
  if (_giRawDep.length > 0 || _giRawArr.length > 0) {
    _giProcessFlights();
  }
}

function giSetTimeSlot(slot) {
  _giTimeSlot = slot;
  _giUpdateTimeBtns();
  if (gateFlightsList.length > 0) renderGateFlights();
}

function _giTimeFilter(f) {
  if (_giTimeSlot === 'all') return true;
  var t = f.std || f.sta || '';
  if (!t) return true;
  var parts = t.split(':');
  var hh = parseInt(parts[0], 10);
  if (isNaN(hh)) return true;
  if (_giTimeSlot === '±2hr') {
    var now = new Date();
    var twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    var nowMin = twNow.getUTCHours() * 60 + twNow.getUTCMinutes();
    var mm = parseInt(parts[1], 10) || 0;
    var fMin = hh * 60 + mm;
    return Math.abs(fMin - nowMin) <= 120;
  }
  var range = _giTimeSlot.split('-');
  var lo = parseInt(range[0], 10);
  var hi = parseInt(range[1], 10);
  return hh >= lo && hh < hi;
}

function _giUpdateAirlineBtns() {
  var btns = document.querySelectorAll('.gi-airline-btn');
  btns.forEach(function(btn) {
    var al = btn.getAttribute('data-airline');
    if (al === _giAirline) {
      btn.classList.add('gi-airline-active');
    } else {
      btn.classList.remove('gi-airline-active');
    }
  });
}

function _giUpdateTimeBtns() {
  var btns = document.querySelectorAll('.gi-time-slot');
  btns.forEach(function(btn) {
    var slot = btn.getAttribute('data-slot');
    if (slot === _giTimeSlot) {
      btn.classList.add('gi-time-active');
    } else {
      btn.classList.remove('gi-time-active');
    }
  });
}

function _giHighlightCurrentSlot() {
  var now = new Date();
  var tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  var hh = tw.getUTCHours();
  var slot = '';
  if (hh < 6) slot = '00-06';
  else if (hh < 12) slot = '06-12';
  else if (hh < 18) slot = '12-18';
  else slot = '18-24';
  var btns = document.querySelectorAll('.gi-time-slot');
  btns.forEach(function(btn) {
    var s = btn.getAttribute('data-slot');
    if (s === slot) {
      btn.classList.add('gi-time-current');
    } else {
      btn.classList.remove('gi-time-current');
    }
  });
}

// Initialize airline/time UI
(function() {
  _giUpdateAirlineBtns();
  _giUpdateTimeBtns();
  _giHighlightCurrentSlot();
  var titleEl = document.querySelector('.gi-title');
  if (titleEl && _giAirline !== 'JX') {
    titleEl.textContent = (_giAirline === 'ALL' ? 'ALL' : _giAirline) + ' Flight Info';
  }
  // Set default sort header indicator
  var allThs = document.querySelectorAll('#gi-table thead th.gi-sortable, #gi-pinned-table thead th.gi-sortable');
  allThs.forEach(function(th) {
    var onclick = th.getAttribute('onclick') || '';
    if (onclick.indexOf("'dest'") >= 0) {
      th.classList.add('gi-sort-asc');
    }
  });
})();


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

// ── Local Time 查詢 ──────────────────────────────────────────────────────────
var _paLocalTimeTimer = null;
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
  '<div>「各位旅客大家好，我是機長 <input class="pa-input" data-pa="captain-name-zh" placeholder="姓名">。代表<span class="pa-choice">[駕駛艙組員 / 全體組員]</span>，歡迎搭乘星宇航空 <input class="pa-input" data-pa="flt" placeholder="e.g. JX2"> 班機前往 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯">。我們預計在 <input class="pa-input pa-input-num" data-pa="dep-min" inputmode="numeric"> 分鐘後出發。飛行時間約 <input class="pa-input pa-input-num" data-pa="flt-hr" inputmode="numeric"> 小時 <input class="pa-input pa-input-num" data-pa="flt-min" inputmode="numeric"> 分鐘，初始巡航高度 <input class="pa-input" data-pa="altitude" inputmode="numeric" style="min-width:70px"> 呎。再次祝您旅途愉快，謝謝。」</div>';

_paScripts.delay = '<div class="pa-note">If ground delay is expected to be more than 15 minutes before pushback, a ground delay PA should be delivered.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your captain speaking. Due to <input class="pa-input" placeholder="Delay Reason">, we might be delayed up to <input class="pa-input pa-input-num" data-pa="delay-min" inputmode="numeric"> minutes before takeoff. I will keep you updated if longer delay happens. Thank you for your patient."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，這裡是機長廣播。由於 <input class="pa-input" placeholder="延誤原因">，我們可能需要延遲約 <input class="pa-input pa-input-num" data-pa="delay-min" inputmode="numeric"> 分鐘後才能起飛。如有更長時間的延誤，我會再向各位報告。感謝您的耐心等候。」</div>';

_paScripts.descent = '<div class="pa-note">The PA shall be given around 10 minutes before top of descent. <button class="pa-wx-refresh" onclick="_paFetchDescentWx()">Refresh WX</button></div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your captain speaking. We are approaching <input class="pa-input" data-pa="dest" placeholder="e.g. LAX"> and expect to start our descent in 10 minutes. We estimate landing at <input class="pa-input pa-input-num" data-pa="eta" inputmode="numeric" style="min-width:50px" placeholder="HH:MM"> <span class="pa-choice">[a.m. / p.m.]</span>. The current local time in <input class="pa-input" data-pa="dest" placeholder="e.g. LAX"> is <input class="pa-input pa-input-num" data-pa="local-time" inputmode="numeric" style="min-width:50px" placeholder="HH:MM"> <span class="pa-choice" data-pa="ampm-local">[a.m. / p.m.]</span> on <input class="pa-input" data-pa="local-day" placeholder="Day and Date">. The present weather at the airport is <input class="pa-input" data-pa="wx-en" placeholder="Weather Condition"> with a temperature of <input class="pa-input pa-input-num" data-pa="temp-c" inputmode="numeric"> degree Celsius, which is <input class="pa-input pa-input-num" data-pa="temp-f" inputmode="numeric"> degree Fahrenheit. We certainly hope that you have enjoyed the flight with us, and we look forward to having you onboard another STARLUX flight again very soon. Thank you, and we wish you all a very pleasant journey."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，這裡是機長廣播。我們即將接近 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯">，預計在 10 分鐘後開始下降。預計落地時間為 <span class="pa-choice">[上午 / 下午]</span> <input class="pa-input pa-input-num" data-pa="eta" inputmode="numeric" style="min-width:50px" placeholder="HH:MM">。<input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 當地時間為 <input class="pa-input" data-pa="local-day-cn" placeholder="星期與日期"> <span class="pa-choice" data-pa="ampm-local-cn">[上午 / 下午]</span> <input class="pa-input pa-input-num" data-pa="local-time-cn" inputmode="numeric" style="min-width:50px" placeholder="HH:MM">。目前機場天氣為 <input class="pa-input" data-pa="wx-zh" placeholder="天氣狀況">，氣溫攝氏 <input class="pa-input pa-input-num" data-pa="temp-c" inputmode="numeric"> 度，華氏 <input class="pa-input pa-input-num" data-pa="temp-f" inputmode="numeric"> 度。非常感謝各位搭乘星宇航空，期待再次為您服務。祝各位旅途愉快。」</div>';

_paScripts.turbulence = '<div class="pa-sub">i. Approaching an Area of Known or Forecast Turbulence</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your Captain speaking. We will soon be flying through an area with light to moderate turbulence. We have already made <span class="pa-choice">[changes to our route and altitude / deviations]</span> to provide you with the smoothest flight possible. To ensure your safety, please stay in your seats and fasten your seat belt."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，這裡是機長廣播。我們即將通過一個輕度到中度亂流區域。我們已經 <span class="pa-choice">[調整航路和高度 / 偏航]</span> 以提供最平穩的飛行。為了您的安全，請留在座位上並繫好安全帶。」</div>' +
  '<div class="pa-sub">ii. To ask cabin crew to be seated</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"For the safety of the cabin crew, I have asked them to stop the inflight service, take their seats, and remain seated, until we have passed through this area. We apologize for any inconvenience. The inflight service will resume as soon as flight conditions permit. We expect that these conditions to last for approximately <input class="pa-input pa-input-num" data-pa="turb-min" inputmode="numeric"> minutes. <span class="pa-choice">(If estimate of the period of turbulence is known)</span> Your cooperation and understanding are always appreciated. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「為了組員的安全，我已請空服員暫停機上服務並回座就位，待我們通過此區域後再恢復。造成不便敬請見諒，機上服務將在飛行條件允許時盡快恢復。預計此狀況將持續約 <input class="pa-input pa-input-num" data-pa="turb-min" inputmode="numeric"> 分鐘。<span class="pa-choice">（如已知亂流持續時間）</span>感謝您的配合與理解。」</div>';

_paScripts.deice = '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, welcome on board. This is your Captain speaking. Today we must complete a procedure to protect the aircraft against the build-up of ice. And we will be on ground for <input class="pa-input pa-input-num" data-pa="deice-min" inputmode="numeric"> minutes. <span class="pa-choice">(If delay)</span> This will involve the spraying of a fluid on the aircraft; there may be some noise during this process and, possibly, a slightly unusual smell inside of the cabin. The procedure is routine and should be completed in a few minutes. Thank you for your attention."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，歡迎登機。這裡是機長廣播。今天我們需要進行除冰/防冰程序以保護飛機。我們將在地面等候約 <input class="pa-input pa-input-num" data-pa="deice-min" inputmode="numeric"> 分鐘。<span class="pa-choice">（如有延遲）</span>過程中會在機身噴灑除冰液，期間可能會有一些噪音，機艙內也可能聞到些許異味。這是例行程序，幾分鐘內即可完成。感謝您的配合。」</div>';

_paScripts.missedappr = '<div class="pa-note">The PA should be done after the aircraft has leveled at missed approach altitude with completion of the After Takeoff Checklist, and before the start of next approach.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"May we have your attention. This is your Captain speaking. We were unable to complete our approach to landing at <input class="pa-input" data-pa="dest" placeholder="e.g. LAX">. We have just completed a routine go-around procedure and, shortly, we shall be starting another approach to land. We will be landing in <input class="pa-input pa-input-num" data-pa="ga-min" inputmode="numeric"> minutes. Thank you for your attention."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客請注意。這裡是機長廣播。我們無法完成在 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 的進場降落。我們剛剛已完成例行的重飛程序，稍後將再次進場降落。預計在 <input class="pa-input pa-input-num" data-pa="ga-min" inputmode="numeric"> 分鐘後落地。感謝您的配合。」</div>';

_paScripts.diversion = '<div class="pa-lang">English</div>' +
  '<div>"May we have your attention. This is your Captain speaking. The weather at <input class="pa-input" data-pa="dest" placeholder="e.g. LAX"> airport is below landing minimum, we are unable to land at this moment. We shall divert to <input class="pa-input" data-pa="alt-apt" placeholder="Alternate"> airport, and we can wait for the weather at <input class="pa-input" data-pa="dest" placeholder="e.g. LAX"> airport to improve."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客請注意。這裡是機長廣播。<input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 機場天氣低於降落標準，目前無法降落。我們將轉降至 <input class="pa-input" data-pa="alt-apt" placeholder="備降機場">，等待 <input class="pa-input" data-pa="dest-zh" placeholder="e.g. 洛杉磯"> 機場天氣改善。」</div>';

_paScripts.modsevcat = '<div class="pa-sub">i. Normal</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your Captain speaking. We have just encountered an area of <span class="pa-choice">[moderate / severe]</span> Clear Air Turbulence. The aircraft condition is safe, with all systems operating normally. This type of turbulence cannot be detected with our system and was unexpected. We appreciate your cooperation to stay in your seats with seatbelt fasten until the seatbelt sign is turned off."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，這裡是機長廣播。我們剛剛遭遇了一個 <span class="pa-choice">[中度 / 強烈]</span> 晴空亂流區域。飛機狀態安全，所有系統運作正常。此類亂流無法被系統偵測且為突發狀況。請您配合留在座位上繫好安全帶，直到安全帶指示燈熄滅為止。」</div>' +
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

/* ── 📡 Live Radar ─────────────────────────────────────────────── */
var _liveMap = null;
var _livePlaneLayer = null;
var _liveLabelLayer = null;
var _liveStates = [];
var _liveFiltered = [];
var _liveInited = false;
var _liveShowLabels = false;

/* auto-refresh & interpolation */
var _liveAutoInterval = null;
var _liveCountdown = 10;
var _liveCountdownInterval = null;
var _liveInterpInterval = null;
var _liveRateLimited = false;
var _liveLastFetchTime = 0;
var _liveCreditsRemaining = null;
var LIVE_REFRESH_SEC = 15;
var LIVE_INTERP_MS = 1000;

/* callsign prefix → IATA mapping */
var _livePrefixMap = { SJX: 'JX', EVA: 'BR', CAL: 'CI' };
var _liveIataToIcao = { JX: 'SJX', BR: 'EVA', CI: 'CAL' };

/* ICAO airport coordinates [lat, lon] */
var _liveAirportDb = {
  /* Taiwan */
  RCTP:[25.08,121.23],RCSS:[25.07,121.55],RCKH:[22.57,120.35],RCMQ:[24.26,120.62],
  /* Japan */
  RJTT:[35.55,139.78],RJAA:[35.76,140.39],RJBB:[34.43,135.24],RJCC:[42.77,141.69],
  RJFF:[33.59,130.45],RJOO:[34.78,135.44],RJSN:[37.96,139.11],RJNK:[36.39,136.41],
  ROAH:[26.20,127.65],RJFK:[33.55,131.74],
  /* Korea */
  RKSI:[37.47,126.45],RKSS:[37.56,126.79],RKPC:[33.51,126.49],RKPK:[35.18,128.94],
  /* China / HK / Macau */
  VHHH:[22.31,113.91],VMMC:[22.15,113.59],ZBAA:[40.08,116.58],ZSPD:[31.14,121.80],
  ZGGG:[23.39,113.30],ZUCK:[29.72,106.64],ZUUU:[30.58,103.95],ZSSS:[31.20,121.34],
  /* Southeast Asia */
  WSSS:[1.36,103.99],VTBS:[13.69,100.75],WIII:[-6.13,106.66],RPLL:[14.51,121.02],
  VVNB:[21.22,105.81],VVTS:[10.82,106.65],WMKK:[2.74,101.70],
  /* USA */
  KLAX:[33.94,-118.41],KSFO:[37.62,-122.38],KJFK:[40.64,-73.78],KATL:[33.64,-84.43],
  KORD:[41.97,-87.91],KDFW:[32.90,-97.04],KDEN:[39.86,-104.67],KSEA:[47.45,-122.31],
  KPHX:[33.43,-112.01],KMIA:[25.80,-80.29],KLAS:[36.08,-115.15],KIAH:[29.98,-95.34],
  KEWR:[40.69,-74.17],KBOS:[42.36,-71.01],KMSP:[44.88,-93.22],KDTW:[42.21,-83.35],
  KHNL:[21.32,-157.92],
  /* Europe */
  EGLL:[51.47,-0.46],LFPG:[49.01,2.55],EDDF:[50.03,8.57],EHAM:[52.31,4.76],
  LEMD:[40.47,-3.57],LIRF:[41.80,12.24],LSZH:[47.46,8.55],LOWW:[48.11,16.57],
  EKCH:[55.62,12.66],ENGM:[60.19,11.10],EFHK:[60.32,24.96],
  /* Middle East */
  OMDB:[25.25,55.36],OTHH:[25.27,51.61],OEJN:[21.68,39.16],OERK:[24.96,46.70],
  LLBG:[32.01,34.89],OIII:[35.69,51.31],
  /* Oceania */
  YSSY:[-33.95,151.18],YMML:[-37.67,144.84],NZAA:[-37.01,174.79],
  /* Canada */
  CYYZ:[43.68,-79.63],CYVR:[49.19,-123.18]
};

/* ── lock/unlock landscape ── */
var _liveLandscapeLocked = false;
var _livePortraitListening = false;
function _liveLockLandscape() {
  if (window.innerWidth >= 640) return;
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').then(function() {
      _liveLandscapeLocked = true;
      _liveHidePortraitOverlay();
    }).catch(function() {
      _liveStartPortraitDetect();
    });
  } else {
    _liveStartPortraitDetect();
  }
}
function _liveUnlockOrientation() {
  if (_liveLandscapeLocked) {
    try {
      if (screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
    } catch (e) {}
    _liveLandscapeLocked = false;
  }
  _liveHidePortraitOverlay();
}
function _liveStartPortraitDetect() {
  _liveCheckPortrait();
  if (!_livePortraitListening) {
    _livePortraitListening = true;
    window.addEventListener('resize', _liveCheckPortrait);
  }
}
function _liveCheckPortrait() {
  var overlay = document.getElementById('live-portrait-overlay');
  if (!overlay) return;
  var isLive = document.getElementById('briefing-live') &&
    document.getElementById('briefing-live').classList.contains('active');
  if (!isLive) { overlay.style.display = 'none'; return; }
  if (window.innerWidth < 640 && window.innerHeight > window.innerWidth) {
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}
function _liveHidePortraitOverlay() {
  var overlay = document.getElementById('live-portrait-overlay');
  if (overlay) overlay.style.display = 'none';
}

/* ── init ── */
function liveInit() {
  _liveLockLandscape();
  if (_liveInited) {
    if (_liveMap) _liveMap.invalidateSize();
    _liveStartAuto();
    return;
  }
  _liveInited = true;
  _liveMap = L.map('live-map', {
    center: [25.0, 121.5],
    zoom: 5,
    zoomControl: false,
    worldCopyJump: true
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    maxZoom: 18
  }).addTo(_liveMap);
  L.control.zoom({ position: 'topright' }).addTo(_liveMap);
  _livePlaneLayer = L.layerGroup().addTo(_liveMap);
  _liveLabelLayer = L.layerGroup().addTo(_liveMap);

  /* prevent Leaflet from stealing sidebar clicks */
  var sb = document.getElementById('live-sidebar');
  var tbtn = document.getElementById('live-sidebar-toggle');
  L.DomEvent.disableClickPropagation(sb);
  L.DomEvent.disableScrollPropagation(sb);
  L.DomEvent.disableClickPropagation(tbtn);

  /* re-render on map move when showing all flights */
  _liveMap.on('moveend', function() {
    var allCheck = document.getElementById('live-f-all');
    if (allCheck && allCheck.checked) liveApplyFilter();
  });

  /* restore saved settings */
  _liveRestoreSettings();
  _liveUpdateTogglePos();

  /* first fetch + start auto-refresh */
  liveFetchData();
  _liveStartAuto();
}

/* ── fetch data ── */
function liveFetchData() {
  var countEl = document.getElementById('live-count');
  if (countEl) countEl.textContent = 'Loading...';
  fetch('/api/opensky')
    .then(function(r) {
      if (r.status === 429) return r.json().then(function(d) { d._httpStatus = 429; return d; });
      return r.json();
    })
    .then(function(data) {
      if (data._httpStatus === 429 || data.error === 'rate_limit') {
        _liveRateLimited = true;
        _liveStopAuto();
        _liveUpdateStatus();
        return;
      }
      if (data.error) {
        if (countEl) countEl.textContent = 'Error: ' + data.error;
        return;
      }
      _liveRateLimited = false;
      _liveLastFetchTime = Date.now();
      _liveStates = data.states || [];
      if (data._remaining != null) _liveCreditsRemaining = data._remaining;
      _liveUpdateStatus();
      liveApplyFilter();
    })
    .catch(function() {
      if (countEl) countEl.textContent = 'Fetch error';
    });
}

/* ── manual refresh (button click) ── */
function liveManualRefresh() {
  _liveCountdown = LIVE_REFRESH_SEC;
  liveFetchData();
}

/* ── auto-refresh start/stop ── */
function _liveStartAuto() {
  _liveStopAuto();
  if (_liveRateLimited) return;
  _liveCountdown = LIVE_REFRESH_SEC;
  _liveUpdateStatus();
  /* countdown tick every 1s */
  _liveCountdownInterval = setInterval(function() {
    _liveCountdown--;
    if (_liveCountdown <= 0) {
      _liveCountdown = LIVE_REFRESH_SEC;
      liveFetchData();
    }
    _liveUpdateStatus();
  }, 1000);
  /* interpolation tick */
  _liveInterpInterval = setInterval(_liveInterpolate, LIVE_INTERP_MS);
}

function _liveStopAuto() {
  if (_liveCountdownInterval) { clearInterval(_liveCountdownInterval); _liveCountdownInterval = null; }
  if (_liveInterpInterval) { clearInterval(_liveInterpInterval); _liveInterpInterval = null; }
}

function liveStopAll() {
  _liveStopAuto();
}

/* ── status display ── */
function _liveUpdateStatus() {
  var el = document.getElementById('live-status');
  if (!el) return;
  var cred = _liveCreditsRemaining != null ? _liveCreditsRemaining.toLocaleString() + ' / 4,000' : '';
  if (_liveRateLimited) {
    el.innerHTML = '<span style="color:#f87171">🔴 額度已滿</span>' + (cred ? ' <span style="color:var(--muted)">| ' + cred + '</span>' : '');
  } else {
    el.innerHTML = '<span style="color:#4ade80">🟢 Auto ' + _liveCountdown + 's</span>' + (cred ? ' <span style="color:var(--muted)">| 剩餘 ' + cred + '</span>' : '');
  }
}

/* ── interpolation: move planes between API refreshes ── */
function _liveInterpolate() {
  if (!_liveMap || _liveRateLimited) return;
  var elapsed = (Date.now() - _liveLastFetchTime) / 1000;
  _livePlaneLayer.eachLayer(function(marker) {
    var s = marker._oskyState;
    if (!s || s[8]) return; /* skip if on ground */
    var lat0 = s[6], lon0 = s[5];
    var spd = s[9]; /* m/s */
    var hdg = s[10]; /* degrees */
    if (lat0 == null || lon0 == null || spd == null || hdg == null || spd < 10) return;
    var dist = spd * elapsed; /* meters */
    var R = 6371000;
    var brng = hdg * Math.PI / 180;
    var lat1 = lat0 * Math.PI / 180;
    var lon1 = lon0 * Math.PI / 180;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(dist / R) + Math.cos(lat1) * Math.sin(dist / R) * Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dist / R) * Math.cos(lat1), Math.cos(dist / R) - Math.sin(lat1) * Math.sin(lat2));
    var newLat = lat2 * 180 / Math.PI;
    var newLon = lon2 * 180 / Math.PI;
    marker.setLatLng([newLat, newLon]);
  });
  /* also move labels */
  if (_liveShowLabels) {
    var labelLayers = _liveLabelLayer.getLayers();
    var planeLayers = _livePlaneLayer.getLayers();
    for (var i = 0; i < labelLayers.length && i < planeLayers.length; i++) {
      labelLayers[i].setLatLng(planeLayers[i].getLatLng());
    }
  }
}

/* ── convert callsign to display name ── */
function _liveDisplayName(cs) {
  for (var prefix in _livePrefixMap) {
    if (cs.indexOf(prefix) === 0) {
      return _livePrefixMap[prefix] + cs.substring(prefix.length);
    }
  }
  return cs;
}

/* ── apply filter & render ── */
function liveApplyFilter() {
  if (!_liveMap) return;
  _livePlaneLayer.clearLayers();
  _liveLabelLayer.clearLayers();

  var allCheck = document.getElementById('live-f-all');
  var showAll = allCheck && allCheck.checked;
  var prefixes = [];

  if (!showAll) {
    if (document.getElementById('live-f-jx').checked) prefixes.push('SJX');
    if (document.getElementById('live-f-br').checked) prefixes.push('EVA');
    if (document.getElementById('live-f-ci').checked) prefixes.push('CAL');
    var custom = (document.getElementById('live-f-custom').value || '').toUpperCase().split(',');
    for (var i = 0; i < custom.length; i++) {
      var c = custom[i].trim();
      if (c && prefixes.indexOf(c) < 0) prefixes.push(c);
    }
  }

  /* viewbox bounds for All flights mode */
  var bounds = null;
  var MAX_ALL = 500;
  if (showAll) bounds = _liveMap.getBounds();

  _liveFiltered = [];
  for (var j = 0; j < _liveStates.length; j++) {
    var s = _liveStates[j];
    var cs = (s[1] || '').trim();
    if (!cs) continue;
    var lat = s[6], lon = s[5];
    if (lat == null || lon == null) continue;

    if (showAll) {
      /* only show planes within visible map area */
      if (!bounds.contains([lat, lon])) continue;
      if (_liveFiltered.length >= MAX_ALL) continue;
    } else if (prefixes.length > 0) {
      var match = false;
      for (var k = 0; k < prefixes.length; k++) {
        if (cs.indexOf(prefixes[k]) === 0) { match = true; break; }
      }
      if (!match) continue;
    }

    _liveFiltered.push(s);
    var heading = s[10] || 0;
    var icon = L.divIcon({
      className: 'live-plane-icon',
      html: '<div style="transform:rotate(' + heading + 'deg)">✈</div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    var marker = L.marker([lat, lon], { icon: icon });
    marker._oskyState = s;
    marker.on('click', function(e) {
      _liveShowPopup(e.target);
    });
    _livePlaneLayer.addLayer(marker);

    /* label */
    if (_liveShowLabels) {
      var altFt = s[7] != null ? Math.round(s[7] * 3.28084) : null;
      var altStr = altFt != null ? altFt.toLocaleString() : '';
      var labelHtml = '<div class="live-label">' + _liveDisplayName(cs) +
        (altStr ? '<br>' + altStr + ' ft' : '') + '</div>';
      var labelIcon = L.divIcon({
        className: 'live-label-icon',
        html: labelHtml,
        iconSize: [0, 0],
        iconAnchor: [-12, 10]
      });
      _liveLabelLayer.addLayer(L.marker([lat, lon], { icon: labelIcon, interactive: false }));
    }
  }

  var countEl = document.getElementById('live-count');
  if (countEl) {
    var cntText = _liveFiltered.length + ' aircraft';
    if (showAll && _liveFiltered.length >= MAX_ALL) cntText += ' (max ' + MAX_ALL + ')';
    countEl.textContent = cntText;
  }

  /* update flight list */
  _liveRenderFlightList();

  /* save filter settings */
  _liveSaveSettings();
}

/* ── render flight list ── */
function _liveRenderFlightList() {
  var el = document.getElementById('live-flight-list');
  if (!el) return;
  if (_liveFiltered.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:.7em;text-align:center;padding:8px">No flights</div>';
    return;
  }
  var html = '<table class="live-list-table"><thead><tr><th>Flight</th><th>Alt</th><th>Spd</th></tr></thead><tbody>';
  for (var i = 0; i < _liveFiltered.length; i++) {
    var s = _liveFiltered[i];
    var cs = (s[1] || '').trim();
    var display = _liveDisplayName(cs);
    var altFt = s[7] != null ? Math.round(s[7] * 3.28084).toLocaleString() : '—';
    var spdKt = s[9] != null ? Math.round(s[9] * 1.94384) : '—';
    html += '<tr data-idx="' + i + '" onclick="_liveListClick(' + i + ')">' +
      '<td>' + display + '</td>' +
      '<td>' + altFt + '</td>' +
      '<td>' + spdKt + '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

/* ── flight list click → fly to plane ── */
function _liveListClick(idx) {
  var s = _liveFiltered[idx];
  if (!s || !_liveMap) return;
  var lat = s[6], lon = s[5];
  if (lat == null || lon == null) return;
  _liveMap.flyTo([lat, lon], 8, { duration: 0.8 });
  /* find marker and open popup */
  _livePlaneLayer.eachLayer(function(layer) {
    if (layer._oskyState === s) {
      _liveShowPopup(layer);
    }
  });
}

/* ── popup info card ── */
function _liveShowPopup(marker) {
  var s = marker._oskyState;
  var cs = (s[1] || '').trim();
  var display = _liveDisplayName(cs);
  var baroFt = s[7] != null ? Math.round(s[7] * 3.28084).toLocaleString() + ' ft' : '—';
  var geoFt = s[13] != null ? Math.round(s[13] * 3.28084).toLocaleString() + ' ft' : '—';
  var spdKt = s[9] != null ? Math.round(s[9] * 1.94384) + ' kt' : '—';
  var hdg = s[10] != null ? Math.round(s[10]) + '°' : '—';
  var vs = s[11] != null ? (s[11] >= 0 ? '+' : '') + Math.round(s[11] * 196.85) + ' ft/min' : '—';
  var ground = s[8] ? 'Yes' : 'No';
  var squawk = s[14] || '—';
  var icao24 = s[0] || '—';
  var country = s[2] || '—';
  var lat = s[6] != null ? s[6].toFixed(4) : '—';
  var lon = s[5] != null ? s[5].toFixed(4) : '—';

  var html = '<div class="live-popup">' +
    '<div class="live-popup-title">' + display + '</div>' +
    '<table class="live-popup-table">' +
    '<tr><td>Country</td><td>' + country + '</td></tr>' +
    '<tr><td>Position</td><td>' + lat + '°, ' + lon + '°</td></tr>' +
    '<tr><td>Baro Alt</td><td>' + baroFt + '</td></tr>' +
    '<tr><td>Geo Alt</td><td>' + geoFt + '</td></tr>' +
    '<tr><td>Speed</td><td>' + spdKt + '</td></tr>' +
    '<tr><td>Heading</td><td>' + hdg + '</td></tr>' +
    '<tr><td>V/S</td><td>' + vs + '</td></tr>' +
    '<tr><td>On Ground</td><td>' + ground + '</td></tr>' +
    '<tr><td>Squawk</td><td>' + squawk + '</td></tr>' +
    '<tr><td>ICAO24</td><td>' + icao24 + '</td></tr>' +
    '</table></div>';

  marker.unbindPopup();
  marker.bindPopup(html, { className: 'live-popup-wrap', maxWidth: 250 }).openPopup();
}

/* ── toggle labels ── */
function liveToggleLabels() {
  _liveShowLabels = document.getElementById('live-f-labels').checked;
  liveApplyFilter();
}

/* ── search flight by number ── */
function liveSearchFlight() {
  var msgEl = document.getElementById('live-search-msg');
  if (msgEl) msgEl.textContent = '';
  var raw = (document.getElementById('live-f-custom').value || '').trim().toUpperCase();
  if (!raw) return;
  /* check if input contains digits → specific flight search */
  var hasDigit = /\d/.test(raw);
  if (!hasDigit) {
    /* just a prefix — apply filter normally */
    liveApplyFilter();
    return;
  }
  /* extract prefix (letters) and number */
  var match = raw.match(/^([A-Z]{2,3})(\d+.*)$/);
  if (!match) { liveApplyFilter(); return; }
  var iataPrefix = match[1];
  var flightNum = match[2];
  /* convert IATA to ICAO if needed */
  var icaoPrefix = _liveIataToIcao[iataPrefix] || iataPrefix;
  var searchCallsign = icaoPrefix + flightNum;
  var displayName = iataPrefix + flightNum;
  /* set the prefix input to just the airline code for filtering */
  document.getElementById('live-f-custom').value = iataPrefix;
  liveApplyFilter();
  /* now search for the specific flight in _liveStates */
  var found = null;
  for (var i = 0; i < _liveStates.length; i++) {
    var cs = (_liveStates[i][1] || '').trim();
    if (cs === searchCallsign || cs === searchCallsign + ' ') {
      found = _liveStates[i];
      break;
    }
  }
  if (found) {
    var lat = found[6], lon = found[5];
    if (lat != null && lon != null) {
      _liveMap.flyTo([lat, lon], 8, { duration: 0.8 });
      /* find marker and open popup */
      _livePlaneLayer.eachLayer(function(layer) {
        if (layer._oskyState === found) _liveShowPopup(layer);
      });
    }
  } else {
    if (msgEl) msgEl.textContent = '⚠ ' + displayName + ' 無此航班 Not found';
    setTimeout(function() { if (msgEl) msgEl.textContent = ''; }, 5000);
  }
  /* restore full flight number in input for reference */
  document.getElementById('live-f-custom').value = raw;
}

/* ── jump to airport ── */
function liveJumpTo() {
  var sel = document.getElementById('live-jump');
  var val = sel.value;
  if (!val || !_liveMap) return;
  var parts = val.split(',');
  var lat = parseFloat(parts[0]);
  var lon = parseFloat(parts[1]);
  var zoom = parseInt(parts[2], 10);
  _liveMap.flyTo([lat, lon], zoom, { duration: 1 });
  sel.value = '';
}

/* ── jump by ICAO code input ── */
function liveJumpToIcao() {
  var inp = document.getElementById('live-jump-input');
  var code = (inp.value || '').trim().toUpperCase();
  if (!code || !_liveMap) return;
  var coords = _liveAirportDb[code];
  if (coords) {
    _liveMap.flyTo(coords, 10, { duration: 1 });
    inp.value = '';
  } else {
    inp.style.borderColor = '#f44';
    setTimeout(function() { inp.style.borderColor = ''; }, 1500);
  }
}

/* ── sidebar toggle ── */
function liveToggleSidebar() {
  var sb = document.getElementById('live-sidebar');
  sb.classList.toggle('collapsed');
  _liveUpdateTogglePos();
}

function _liveUpdateTogglePos() {
  var sb = document.getElementById('live-sidebar');
  var btn = document.getElementById('live-sidebar-toggle');
  var isMobile = window.innerWidth < 640;
  var isCollapsed = sb.classList.contains('collapsed');
  if (isMobile) {
    btn.style.right = '';
    btn.style.left = isCollapsed ? '6px' : '';
    btn.style.display = isCollapsed ? '' : 'none';
    return;
  }
  var isRight = sb.classList.contains('live-sidebar-right');
  var sbWidth = 266;
  if (isRight) {
    btn.style.left = '';
    btn.style.right = isCollapsed ? '6px' : (sbWidth + 6) + 'px';
  } else {
    btn.style.right = '';
    btn.style.left = isCollapsed ? '6px' : (sbWidth + 6) + 'px';
  }
  btn.style.display = '';
}

/* ── sidebar left/right switch ── */
function liveSwitchSidebarPos() {
  var sb = document.getElementById('live-sidebar');
  if (sb.classList.contains('live-sidebar-right')) {
    sb.classList.remove('live-sidebar-right');
    sb.classList.add('live-sidebar-left');
  } else {
    sb.classList.remove('live-sidebar-left');
    sb.classList.add('live-sidebar-right');
  }
  _liveUpdateTogglePos();
  _liveSaveSettings();
}

/* ── toggle all flights ── */
function liveToggleAll() {
  var allCheck = document.getElementById('live-f-all');
  var jx = document.getElementById('live-f-jx');
  var br = document.getElementById('live-f-br');
  var ci = document.getElementById('live-f-ci');
  var custom = document.getElementById('live-f-custom');
  if (allCheck.checked) {
    jx.disabled = true; br.disabled = true; ci.disabled = true; custom.disabled = true;
  } else {
    jx.disabled = false; br.disabled = false; ci.disabled = false; custom.disabled = false;
  }
  liveApplyFilter();
}

/* ── save/restore settings ── */
function _liveSaveSettings() {
  var sb = document.getElementById('live-sidebar');
  var pos = sb.classList.contains('live-sidebar-left') ? 'left' : 'right';
  var filters = {
    jx: document.getElementById('live-f-jx').checked,
    br: document.getElementById('live-f-br').checked,
    ci: document.getElementById('live-f-ci').checked,
    all: document.getElementById('live-f-all').checked,
    custom: document.getElementById('live-f-custom').value,
    labels: document.getElementById('live-f-labels').checked
  };
  try {
    localStorage.setItem('crewsync_live_sb', pos);
    localStorage.setItem('crewsync_live_filters', JSON.stringify(filters));
  } catch (e) {}
}

function _liveRestoreSettings() {
  try {
    var pos = localStorage.getItem('crewsync_live_sb');
    if (pos === 'right') liveSwitchSidebarPos();
    var f = JSON.parse(localStorage.getItem('crewsync_live_filters') || 'null');
    if (f) {
      document.getElementById('live-f-jx').checked = !!f.jx;
      document.getElementById('live-f-br').checked = !!f.br;
      document.getElementById('live-f-ci').checked = !!f.ci;
      document.getElementById('live-f-all').checked = !!f.all;
      document.getElementById('live-f-custom').value = f.custom || '';
      document.getElementById('live-f-labels').checked = !!f.labels;
      _liveShowLabels = !!f.labels;
      if (f.all) liveToggleAll();
    }
  } catch (e) {}
}

/* ── ✈️ FR24 Radar ─────────────────────────────────────────────── */
var _fr24Map = null;
var _fr24PlaneLayer = null;
var _fr24LabelLayer = null;
var _fr24Flights = [];
var _fr24Filtered = [];
var _fr24Inited = false;
var _fr24ShowLabels = false;
var _fr24TrailLines = [];  /* [solid trail, dashed predicted] */
var _fr24TrailFlight = null; /* flight object with active trail */
var _fr24SearchedFlight = null; /* flight found by search (survives filter) */
var _fr24PopupCs = null; /* callsign of currently open popup (survives re-render) */
var _fr24TileLayer = null;

/* auto-refresh & interpolation */
var _fr24CountdownInterval = null;
var _fr24InterpInterval = null;
var _fr24RateLimited = false;
var _fr24LastFetchTime = 0;
var _fr24Countdown = 10;
var FR24_REFRESH_SEC = 10;
var FR24_INTERP_MS = 1000;

/* callsign prefix → IATA mapping */
var _fr24PrefixMap = { SJX: 'JX', EVA: 'BR', CAL: 'CI' };
var _fr24IataToIcao = { JX: 'SJX', BR: 'EVA', CI: 'CAL' };

/* ICAO airport coordinates [lat, lon] */
var _fr24AirportDb = {
  RCTP:[25.08,121.23],RCSS:[25.07,121.55],RCKH:[22.57,120.35],RCMQ:[24.26,120.62],
  RJTT:[35.55,139.78],RJAA:[35.76,140.39],RJBB:[34.43,135.24],RJCC:[42.77,141.69],
  RJFF:[33.59,130.45],RJOO:[34.78,135.44],RJSN:[37.96,139.11],RJNK:[36.39,136.41],
  ROAH:[26.20,127.65],RJFK:[33.55,131.74],
  RKSI:[37.47,126.45],RKSS:[37.56,126.79],RKPC:[33.51,126.49],RKPK:[35.18,128.94],
  VHHH:[22.31,113.91],VMMC:[22.15,113.59],ZBAA:[40.08,116.58],ZSPD:[31.14,121.80],
  ZGGG:[23.39,113.30],ZUCK:[29.72,106.64],ZUUU:[30.58,103.95],ZSSS:[31.20,121.34],
  WSSS:[1.36,103.99],VTBS:[13.69,100.75],WIII:[-6.13,106.66],RPLL:[14.51,121.02],
  VVNB:[21.22,105.81],VVTS:[10.82,106.65],WMKK:[2.74,101.70],
  KLAX:[33.94,-118.41],KSFO:[37.62,-122.38],KJFK:[40.64,-73.78],KATL:[33.64,-84.43],
  KORD:[41.97,-87.91],KDFW:[32.90,-97.04],KDEN:[39.86,-104.67],KSEA:[47.45,-122.31],
  KPHX:[33.43,-112.01],KMIA:[25.80,-80.29],KLAS:[36.08,-115.15],KIAH:[29.98,-95.34],
  KEWR:[40.69,-74.17],KBOS:[42.36,-71.01],KMSP:[44.88,-93.22],KDTW:[42.21,-83.35],
  KHNL:[21.32,-157.92],
  EGLL:[51.47,-0.46],LFPG:[49.01,2.55],EDDF:[50.03,8.57],EHAM:[52.31,4.76],
  LEMD:[40.47,-3.57],LIRF:[41.80,12.24],LSZH:[47.46,8.55],LOWW:[48.11,16.57],
  EKCH:[55.62,12.66],ENGM:[60.19,11.10],EFHK:[60.32,24.96],
  OMDB:[25.25,55.36],OTHH:[25.27,51.61],OEJN:[21.68,39.16],OERK:[24.96,46.70],
  LLBG:[32.01,34.89],OIII:[35.69,51.31],
  YSSY:[-33.95,151.18],YMML:[-37.67,144.84],NZAA:[-37.01,174.79],
  CYYZ:[43.68,-79.63],CYVR:[49.19,-123.18]
};

/* ── lock/unlock landscape ── */
var _fr24LandscapeLocked = false;
var _fr24PortraitListening = false;
function _fr24LockLandscape() {
  if (window.innerWidth >= 640) return;
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').then(function() {
      _fr24LandscapeLocked = true;
      _fr24HidePortraitOverlay();
    }).catch(function() {
      _fr24StartPortraitDetect();
    });
  } else {
    _fr24StartPortraitDetect();
  }
}
function _fr24UnlockOrientation() {
  if (_fr24LandscapeLocked) {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    _fr24LandscapeLocked = false;
  }
  _fr24HidePortraitOverlay();
}
function _fr24StartPortraitDetect() {
  _fr24CheckPortrait();
  if (!_fr24PortraitListening) {
    _fr24PortraitListening = true;
    window.addEventListener('resize', _fr24CheckPortrait);
  }
}
function _fr24CheckPortrait() {
  var overlay = document.getElementById('fr24-portrait-overlay');
  if (!overlay) return;
  var isFr24 = document.getElementById('briefing-fr24') &&
    document.getElementById('briefing-fr24').classList.contains('active');
  if (!isFr24) { overlay.style.display = 'none'; return; }
  if (window.innerWidth < 640 && window.innerHeight > window.innerWidth) {
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}
function _fr24HidePortraitOverlay() {
  var overlay = document.getElementById('fr24-portrait-overlay');
  if (overlay) overlay.style.display = 'none';
}

/* ── init ── */
function fr24Init() {
  _fr24LockLandscape();
  if (_fr24Inited) {
    if (_fr24Map) _fr24Map.invalidateSize();
    _fr24StartAuto();
    return;
  }
  _fr24Inited = true;
  _fr24Map = L.map('fr24-map', {
    center: [25.0, 121.5],
    zoom: 5,
    zoomControl: false,
    worldCopyJump: true
  });
  var isDark = document.documentElement.dataset.theme !== 'light';
  var tileStyle = isDark ? 'dark_all' : 'light_all';
  _fr24TileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/' + tileStyle + '/{z}/{x}/{y}{r}.png', {
    attribution: '\u00a9 OpenStreetMap \u00a9 CARTO',
    maxZoom: 18
  }).addTo(_fr24Map);
  L.control.zoom({ position: 'topright' }).addTo(_fr24Map);
  _fr24PlaneLayer = L.layerGroup().addTo(_fr24Map);
  _fr24LabelLayer = L.layerGroup().addTo(_fr24Map);

  var sb = document.getElementById('fr24-sidebar');
  var tbtn = document.getElementById('fr24-sidebar-toggle');
  L.DomEvent.disableClickPropagation(sb);
  L.DomEvent.disableScrollPropagation(sb);
  L.DomEvent.disableClickPropagation(tbtn);

  _fr24Map.on('moveend', function() {
    fr24ApplyFilter();
  });
  _fr24Map.on('click', function() {
    _fr24ClearTrail();
    _fr24SearchedFlight = null;
  });

  _fr24RestoreSettings();
  _fr24UpdateTogglePos();

  fr24FetchData();
  _fr24StartAuto();
}

/* ── fetch data ── */
function fr24FetchData() {
  var countEl = document.getElementById('fr24-count');
  if (countEl) countEl.textContent = 'Loading...';
  var url = '/api/fr24';
  if (_fr24Map) {
    var b = _fr24Map.getBounds();
    var boundsStr = b.getNorth().toFixed(2) + ',' + b.getSouth().toFixed(2) + ',' + b.getWest().toFixed(2) + ',' + b.getEast().toFixed(2);
    url += '?bounds=' + encodeURIComponent(boundsStr);
  }
  fetch(url)
    .then(function(r) {
      if (r.status === 429) return r.json().then(function(d) { d._httpStatus = 429; return d; });
      return r.json();
    })
    .then(function(data) {
      if (data._httpStatus === 429 || data.error === 'rate_limit') {
        _fr24RateLimited = true;
        _fr24StopAuto();
        _fr24UpdateStatus();
        return;
      }
      if (data.error) {
        if (countEl) countEl.textContent = 'Error: ' + data.error;
        return;
      }
      _fr24RateLimited = false;
      _fr24LastFetchTime = Date.now();
      _fr24Flights = data.flights || [];
      _fr24UpdateStatus();
      fr24ApplyFilter();
    })
    .catch(function() {
      if (countEl) countEl.textContent = 'Fetch error';
    });
}

/* ── manual refresh ── */
function fr24ManualRefresh() {
  _fr24Countdown = FR24_REFRESH_SEC;
  fr24FetchData();
}

/* ── auto-refresh ── */
function _fr24StartAuto() {
  _fr24StopAuto();
  if (_fr24RateLimited) return;
  _fr24Countdown = FR24_REFRESH_SEC;
  _fr24UpdateStatus();
  _fr24CountdownInterval = setInterval(function() {
    _fr24Countdown--;
    if (_fr24Countdown <= 0) {
      _fr24Countdown = FR24_REFRESH_SEC;
      fr24FetchData();
    }
    _fr24UpdateStatus();
  }, 1000);
  _fr24InterpInterval = setInterval(_fr24Interpolate, FR24_INTERP_MS);
}

function _fr24StopAuto() {
  if (_fr24CountdownInterval) { clearInterval(_fr24CountdownInterval); _fr24CountdownInterval = null; }
  if (_fr24InterpInterval) { clearInterval(_fr24InterpInterval); _fr24InterpInterval = null; }
}

function fr24StopAll() {
  _fr24StopAuto();
}

/* ── status display ── */
function _fr24UpdateStatus() {
  var el = document.getElementById('fr24-status');
  if (!el) return;
  if (_fr24RateLimited) {
    el.innerHTML = '<span style="color:#f87171">\ud83d\udd34 \u88ab\u9650\u901f Throttled</span>';
  } else {
    el.innerHTML = '<span style="color:#4ade80">\ud83d\udfe2 Auto ' + _fr24Countdown + 's</span>';
  }
}

/* ── interpolation ── */
function _fr24Interpolate() {
  if (!_fr24Map || _fr24RateLimited) return;
  var elapsed = (Date.now() - _fr24LastFetchTime) / 1000;
  _fr24PlaneLayer.eachLayer(function(marker) {
    var f = marker._fr24Data;
    if (!f || f.gnd) return;
    var lat0 = f.lat, lon0 = f.lon;
    var spdKt = f.spd, hdg = f.hdg;
    if (lat0 == null || lon0 == null || spdKt == null || hdg == null || spdKt < 10) return;
    var spd = spdKt * 0.514444; /* knots → m/s */
    var dist = spd * elapsed;
    var R = 6371000;
    var brng = hdg * Math.PI / 180;
    var lat1 = lat0 * Math.PI / 180;
    var lon1 = lon0 * Math.PI / 180;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(dist / R) + Math.cos(lat1) * Math.sin(dist / R) * Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dist / R) * Math.cos(lat1), Math.cos(dist / R) - Math.sin(lat1) * Math.sin(lat2));
    marker.setLatLng([lat2 * 180 / Math.PI, lon2 * 180 / Math.PI]);
  });
  if (_fr24ShowLabels) {
    var labelLayers = _fr24LabelLayer.getLayers();
    var planeLayers = _fr24PlaneLayer.getLayers();
    for (var i = 0; i < labelLayers.length && i < planeLayers.length; i++) {
      labelLayers[i].setLatLng(planeLayers[i].getLatLng());
    }
  }
}

/* ── convert callsign to display name ── */
function _fr24DisplayName(cs) {
  for (var prefix in _fr24PrefixMap) {
    if (cs.indexOf(prefix) === 0) {
      return _fr24PrefixMap[prefix] + cs.substring(prefix.length);
    }
  }
  return cs;
}

/* ── apply filter & render ── */
function fr24ApplyFilter() {
  if (!_fr24Map) return;
  _fr24PlaneLayer.clearLayers();
  _fr24LabelLayer.clearLayers();

  var prefixes = [];
  if (document.getElementById('fr24-f-jx').checked) prefixes.push('SJX');
  if (document.getElementById('fr24-f-br').checked) prefixes.push('EVA');
  if (document.getElementById('fr24-f-ci').checked) prefixes.push('CAL');
  var custom = (document.getElementById('fr24-f-custom').value || '').toUpperCase().split(',');
  for (var i = 0; i < custom.length; i++) {
    var c = custom[i].trim();
    if (!c) continue;
    /* convert IATA to ICAO if needed */
    var icao = _fr24IataToIcao[c] || c;
    if (prefixes.indexOf(icao) < 0) prefixes.push(icao);
  }

  var showAll = prefixes.length === 0;
  var bounds = _fr24Map.getBounds();
  var MAX_ALL = 500;

  _fr24Filtered = [];
  for (var j = 0; j < _fr24Flights.length; j++) {
    var f = _fr24Flights[j];
    var cs = f.cs || '';
    if (!cs) continue;
    var lat = f.lat, lon = f.lon;
    if (lat == null || lon == null) continue;

    if (showAll) {
      if (!bounds.contains([lat, lon])) continue;
      if (_fr24Filtered.length >= MAX_ALL) continue;
    } else {
      var match = false;
      for (var k = 0; k < prefixes.length; k++) {
        if (cs.indexOf(prefixes[k]) === 0) { match = true; break; }
      }
      if (!match) continue;
    }

    _fr24Filtered.push(f);
    var heading = f.hdg || 0;
    var icon = L.divIcon({
      className: 'live-plane-icon',
      html: '<div style="transform:rotate(' + heading + 'deg)">\u2708</div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    var marker = L.marker([lat, lon], { icon: icon });
    marker._fr24Data = f;
    marker.on('click', function(e) {
      _fr24ShowPopup(e.target);
    });
    _fr24PlaneLayer.addLayer(marker);

    if (_fr24ShowLabels) {
      var altStr = f.alt != null ? Math.round(f.alt).toLocaleString() : '';
      var labelHtml = '<div class="live-label">' + _fr24DisplayName(cs) +
        (altStr ? '<br>' + altStr + ' ft' : '') + '</div>';
      var labelIcon = L.divIcon({
        className: 'live-label-icon',
        html: labelHtml,
        iconSize: [0, 0],
        iconAnchor: [-12, 10]
      });
      _fr24LabelLayer.addLayer(L.marker([lat, lon], { icon: labelIcon, interactive: false }));
    }
  }

  var countEl = document.getElementById('fr24-count');
  if (countEl) {
    var cntText = _fr24Filtered.length + ' aircraft';
    if (showAll && _fr24Filtered.length >= MAX_ALL) cntText += ' (max ' + MAX_ALL + ')';
    countEl.textContent = cntText;
  }

  /* always include searched flight regardless of filter */
  if (_fr24SearchedFlight && _fr24Filtered.indexOf(_fr24SearchedFlight) < 0) {
    var sf = _fr24SearchedFlight;
    if (sf.lat != null && sf.lon != null) {
      _fr24Filtered.push(sf);
      var sHeading = sf.hdg || 0;
      var sIcon = L.divIcon({
        className: 'live-plane-icon',
        html: '<div style="transform:rotate(' + sHeading + 'deg)">\u2708</div>',
        iconSize: [20, 20], iconAnchor: [10, 10]
      });
      var sMarker = L.marker([sf.lat, sf.lon], { icon: sIcon });
      sMarker._fr24Data = sf;
      sMarker.on('click', function(e) { _fr24ShowPopup(e.target); });
      _fr24PlaneLayer.addLayer(sMarker);
      if (_fr24ShowLabels) {
        var sAlt = sf.alt != null ? Math.round(sf.alt).toLocaleString() : '';
        var sLblHtml = '<div class="live-label">' + _fr24DisplayName(sf.cs || '') +
          (sAlt ? '<br>' + sAlt + ' ft' : '') + '</div>';
        _fr24LabelLayer.addLayer(L.marker([sf.lat, sf.lon], {
          icon: L.divIcon({ className: 'live-label-icon', html: sLblHtml, iconSize: [0,0], iconAnchor: [-12,10] }),
          interactive: false
        }));
      }
    }
  }

  /* clear trail if the tracked flight is no longer visible */
  if (_fr24TrailFlight && _fr24Filtered.indexOf(_fr24TrailFlight) < 0) {
    _fr24ClearTrail();
  }

  /* re-open popup if it was open before re-render */
  if (_fr24PopupCs) {
    var reopenCs = _fr24PopupCs;
    _fr24PlaneLayer.eachLayer(function(layer) {
      if (layer._fr24Data && layer._fr24Data.cs === reopenCs) {
        _fr24ShowPopup(layer);
      }
    });
  }

  _fr24RenderFlightList();
  _fr24SaveSettings();
}

/* ── render flight list ── */
function _fr24RenderFlightList() {
  var el = document.getElementById('fr24-flight-list');
  if (!el) return;
  if (_fr24Filtered.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:.7em;text-align:center;padding:8px">No flights</div>';
    return;
  }
  var html = '<table class="live-list-table"><thead><tr><th>Flight</th><th>From</th><th>To</th><th>Alt</th></tr></thead><tbody>';
  for (var i = 0; i < _fr24Filtered.length; i++) {
    var f = _fr24Filtered[i];
    var display = _fr24DisplayName(f.cs);
    var altFt = f.alt != null ? Math.round(f.alt).toLocaleString() : '\u2014';
    var from = f.from || '\u2014';
    var to = f.to || '\u2014';
    html += '<tr data-idx="' + i + '" onclick="_fr24ListClick(' + i + ')">' +
      '<td>' + display + '</td>' +
      '<td>' + from + '</td>' +
      '<td>' + to + '</td>' +
      '<td>' + altFt + '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

/* ── flight list click ── */
function _fr24ListClick(idx) {
  var f = _fr24Filtered[idx];
  if (!f || !_fr24Map) return;
  var lat = f.lat, lon = f.lon;
  if (lat == null || lon == null) return;
  _fr24Map.flyTo([lat, lon], 8, { duration: 0.8 });
  _fr24PlaneLayer.eachLayer(function(layer) {
    if (layer._fr24Data === f) _fr24ShowPopup(layer);
  });
}

/* ── popup info card ── */
function _fr24ShowPopup(marker) {
  var f = marker._fr24Data;

  function _buildAndOpen(detail) {
    var cs = f.cs || '';
    var display = _fr24DisplayName(cs);
    var altFt = f.alt != null ? Math.round(f.alt).toLocaleString() + ' ft' : '\u2014';
    var spdKt = f.spd != null ? Math.round(f.spd) + ' kt' : '\u2014';
    var hdg = f.hdg != null ? Math.round(f.hdg) + '\u00b0' : '\u2014';
    var vs = f.vs != null ? (f.vs >= 0 ? '+' : '') + Math.round(f.vs) + ' ft/min' : '\u2014';
    var squawk = f.sq || '\u2014';
    var icao24 = f.icao24 || '\u2014';
    var reg = f.reg || '\u2014';
    var type = f.type || '\u2014';
    var from = f.from || '\u2014';
    var to = f.to || '\u2014';
    var lat = f.lat != null ? f.lat.toFixed(4) : '\u2014';
    var lon = f.lon != null ? f.lon.toFixed(4) : '\u2014';

    /* extract detail fields */
    var airline = '', origName = '', destName = '', std = '', atd = '', sta = '', eta = '';
    if (detail) {
      airline = (detail.airline && detail.airline.name) || '';
      origName = (detail.airport && detail.airport.origin && detail.airport.origin.name) || '';
      destName = (detail.airport && detail.airport.destination && detail.airport.destination.name) || '';
      var _t = detail.time || {};
      var _ts = _t.scheduled || {};
      var _te = _t.estimated || {};
      var _tr = _t.real || {};
      /* STD (scheduled departure) */
      if (_ts.departure) { var d = new Date(_ts.departure * 1000); if (d.getUTCFullYear() > 1970) std = d.toISOString().substring(11, 16) + ' UTC'; }
      /* ATD (actual departure) */
      if (_tr.departure) { var d2 = new Date(_tr.departure * 1000); if (d2.getUTCFullYear() > 1970) atd = d2.toISOString().substring(11, 16) + ' UTC'; }
      /* STA (scheduled arrival) */
      if (_ts.arrival) { var d3 = new Date(_ts.arrival * 1000); if (d3.getUTCFullYear() > 1970) sta = d3.toISOString().substring(11, 16) + ' UTC'; }
      /* ETA (estimated arrival) */
      if (_te.arrival) { var d4 = new Date(_te.arrival * 1000); if (d4.getUTCFullYear() > 1970) eta = d4.toISOString().substring(11, 16) + ' UTC'; }
      if (!eta && sta) { eta = sta + ' (sched)'; sta = ''; }
    }

    /* time diff color + label: actual vs scheduled (unix timestamps) */
    function _fr24TimeDiff(actualTs, schedTs) {
      if (!actualTs || !schedTs) return { style: '', label: '' };
      var diff = (actualTs - schedTs) / 60; // minutes
      var style = '';
      if (diff > 60) style = 'color:#ef4444';
      else if (diff > 15) style = 'color:#eab308';
      else if (diff < -15) style = 'color:#22c55e';
      var absDiff = Math.abs(Math.round(diff));
      var h = Math.floor(absDiff / 60);
      var m = absDiff % 60;
      var sign = diff >= 0 ? '+' : '-';
      var label = ' (' + sign + h + ':' + String(m).padStart(2, '0') + ')';
      return { style: style, label: label };
    }
    var _trSafe = (detail && detail.time && detail.time.real) || {};
    var _tsSafe = (detail && detail.time && detail.time.scheduled) || {};
    var _teSafe = (detail && detail.time && detail.time.estimated) || {};
    var atdDiff = _fr24TimeDiff(_trSafe.departure, _tsSafe.departure);
    var etaDiff = _fr24TimeDiff(_teSafe.arrival, _tsSafe.arrival);
    var atdStyle = atdDiff.style;
    var etaStyle = etaDiff.style;

    /* FR24-style compact card */
    var html = '<div class="fr24-card">' +
      /* header: callsign + badges */
      '<div class="fr24-card-hdr">' +
        '<span class="fr24-card-cs">' + display + '</span>' +
        (type !== '\u2014' ? '<span class="fr24-badge">' + type + '</span>' : '') +
        (reg !== '\u2014' ? '<span class="fr24-badge">' + reg + '</span>' : '') +
      '</div>' +
      (airline ? '<div class="fr24-card-airline">' + airline + '</div>' : '') +
      /* route: FROM ✈ TO */
      '<div class="fr24-card-route">' +
        '<div class="fr24-card-apt">' +
          '<div class="fr24-card-iata">' + from + '</div>' +
          (origName ? '<div class="fr24-card-city">' + origName + '</div>' : '') +
        '</div>' +
        '<div class="fr24-card-arrow">\u2708</div>' +
        '<div class="fr24-card-apt">' +
          '<div class="fr24-card-iata">' + to + '</div>' +
          (destName ? '<div class="fr24-card-city">' + destName + '</div>' : '') +
        '</div>' +
      '</div>' +
      /* departure times row */
      ((std || atd) ? '<div class="fr24-card-row">' +
        (std ? '<div class="fr24-card-cell"><div class="fr24-card-lbl">STD</div><div class="fr24-card-val">' + std + '</div></div>' : '') +
        (atd ? '<div class="fr24-card-cell"><div class="fr24-card-lbl">ATD</div><div class="fr24-card-val"' + (atdStyle ? ' style="' + atdStyle + '"' : '') + '>' + atd + atdDiff.label + '</div></div>' : '') +
      '</div>' : '') +
      /* arrival times row */
      ((sta || eta) ? '<div class="fr24-card-row">' +
        (sta ? '<div class="fr24-card-cell"><div class="fr24-card-lbl">STA</div><div class="fr24-card-val">' + sta + '</div></div>' : '') +
        (eta ? '<div class="fr24-card-cell"><div class="fr24-card-lbl">ETA</div><div class="fr24-card-val"' + (etaStyle ? ' style="' + etaStyle + '"' : '') + '>' + eta + etaDiff.label + '</div></div>' : '') +
      '</div>' : '') +
      /* altitude & v/s */
      '<div class="fr24-card-row">' +
        '<div class="fr24-card-cell"><div class="fr24-card-lbl">ALT</div><div class="fr24-card-val">' + altFt + '</div></div>' +
        '<div class="fr24-card-cell"><div class="fr24-card-lbl">V/S</div><div class="fr24-card-val">' + vs + '</div></div>' +
      '</div>' +
      /* speed & heading */
      '<div class="fr24-card-row">' +
        '<div class="fr24-card-cell"><div class="fr24-card-lbl">SPD</div><div class="fr24-card-val">' + spdKt + '</div></div>' +
        '<div class="fr24-card-cell"><div class="fr24-card-lbl">HDG</div><div class="fr24-card-val">' + hdg + '</div></div>' +
      '</div>' +
      /* squawk & icao24 */
      '<div class="fr24-card-row">' +
        '<div class="fr24-card-cell"><div class="fr24-card-lbl">SQK</div><div class="fr24-card-val">' + squawk + '</div></div>' +
        '<div class="fr24-card-cell"><div class="fr24-card-lbl">ICAO24</div><div class="fr24-card-val">' + icao24 + '</div></div>' +
      '</div>' +
      /* position */
      '<div class="fr24-card-row">' +
        '<div class="fr24-card-cell"><div class="fr24-card-lbl">LAT</div><div class="fr24-card-val">' + lat + '\u00b0</div></div>' +
        '<div class="fr24-card-cell"><div class="fr24-card-lbl">LON</div><div class="fr24-card-val">' + lon + '\u00b0</div></div>' +
      '</div>' +
    '</div>';

    marker.unbindPopup();
    marker.bindPopup(html, { className: 'live-popup-wrap', maxWidth: 280, minWidth: 200, closeOnClick: false, autoClose: false }).openPopup();
    _fr24PopupCs = f.cs || null;
    marker.on('popupclose', function() { _fr24PopupCs = null; });

    /* draw trail */
    _fr24ClearTrail();
    _fr24TrailFlight = f;
    if (detail && detail.trail && detail.trail.length > 1) {
      /* solid line: already flown (fix antimeridian wrap) */
      var pts = [];
      var prevLon2 = null;
      for (var ti = 0; ti < detail.trail.length; ti++) {
        var tLat = detail.trail[ti].lat, tLon = detail.trail[ti].lng;
        if (prevLon2 !== null) {
          while (tLon - prevLon2 > 180) tLon -= 360;
          while (tLon - prevLon2 < -180) tLon += 360;
        }
        prevLon2 = tLon;
        pts.push([tLat, tLon]);
      }
      _fr24TrailLines.push(L.polyline(pts, {
        color: '#f59e0b', weight: 2.5, opacity: 0.85, interactive: false
      }).addTo(_fr24Map));

      /* dashed line: predicted great circle to destination */
      var destCoord = null;
      if (detail.airport && detail.airport.destination && detail.airport.destination.position) {
        var dp = detail.airport.destination.position;
        destCoord = [dp.latitude, dp.longitude];
      } else if (f.to && _fr24AirportDb[f.to]) {
        destCoord = _fr24AirportDb[f.to];
      }
      if (destCoord && f.lat != null && f.lon != null) {
        var gcPts = _fr24GreatCircle(f.lat, f.lon, destCoord[0], destCoord[1], 60);
        _fr24TrailLines.push(L.polyline(gcPts, {
          color: '#f59e0b', weight: 2, opacity: 0.5,
          dashArray: '8,6', interactive: false
        }).addTo(_fr24Map));
      }
    }
  }

  if (f.id) {
    fetch('/api/fr24/detail?id=' + encodeURIComponent(f.id))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { _buildAndOpen(d); })
      .catch(function() { _buildAndOpen(null); });
  } else {
    _buildAndOpen(null);
  }
}

/* ── trail helpers ── */
function _fr24ClearTrail() {
  for (var i = 0; i < _fr24TrailLines.length; i++) {
    if (_fr24TrailLines[i] && _fr24Map) _fr24Map.removeLayer(_fr24TrailLines[i]);
  }
  _fr24TrailLines = [];
  _fr24TrailFlight = null;
}

/* great circle: interpolate N points between two lat/lon */
function _fr24GreatCircle(lat1d, lon1d, lat2d, lon2d, n) {
  var toRad = Math.PI / 180, toDeg = 180 / Math.PI;
  var lat1 = lat1d * toRad, lon1 = lon1d * toRad;
  var lat2 = lat2d * toRad, lon2 = lon2d * toRad;
  var d = 2 * Math.asin(Math.sqrt(
    Math.pow(Math.sin((lat2 - lat1) / 2), 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin((lon2 - lon1) / 2), 2)
  ));
  if (d < 1e-10) return [[lat1d, lon1d], [lat2d, lon2d]];
  var pts = [];
  var prevLon = null;
  for (var i = 0; i <= n; i++) {
    var f = i / n;
    var A = Math.sin((1 - f) * d) / Math.sin(d);
    var B = Math.sin(f * d) / Math.sin(d);
    var x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    var y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    var z = A * Math.sin(lat1) + B * Math.sin(lat2);
    var lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg;
    var lon = Math.atan2(y, x) * toDeg;
    /* keep longitude continuous across antimeridian */
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([lat, lon]);
  }
  return pts;
}

/* ── theme switch ── */
function fr24SwitchTheme() {
  if (!_fr24Map || !_fr24TileLayer) return;
  var isDark = document.documentElement.dataset.theme !== 'light';
  var tileStyle = isDark ? 'dark_all' : 'light_all';
  _fr24Map.removeLayer(_fr24TileLayer);
  _fr24TileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/' + tileStyle + '/{z}/{x}/{y}{r}.png', {
    attribution: '\u00a9 OpenStreetMap \u00a9 CARTO',
    maxZoom: 18
  }).addTo(_fr24Map);
  _fr24TileLayer.bringToBack();
}

/* ── toggle labels ── */
function fr24ToggleLabels() {
  _fr24ShowLabels = document.getElementById('fr24-f-labels').checked;
  fr24ApplyFilter();
}

/* ── search flight by number ── */
function fr24SearchFlight() {
  var msgEl = document.getElementById('fr24-search-msg');
  if (msgEl) msgEl.textContent = '';
  var raw = (document.getElementById('fr24-f-custom').value || '').trim().toUpperCase();
  if (!raw) return;
  var hasDigit = /\d/.test(raw);
  if (!hasDigit) { fr24ApplyFilter(); return; }
  var match = raw.match(/^([A-Z]{2,3})(\d+.*)$/);
  if (!match) { fr24ApplyFilter(); return; }
  var iataPrefix = match[1];
  var flightNum = match[2];
  var icaoPrefix = _fr24IataToIcao[iataPrefix] || iataPrefix;
  var displayName = iataPrefix + flightNum;

  /* normalize: strip leading zeros for comparison */
  var searchNumVal = parseInt(flightNum, 10);

  /* search in local flights first */
  var found = _fr24FindInList(_fr24Flights, icaoPrefix, searchNumVal);
  if (found) {
    _fr24GoToFound(found, msgEl);
  } else {
    /* not in local data → fetch global (no bounds) */
    if (msgEl) msgEl.textContent = '\u2708 Searching globally...';
    fetch('/api/fr24')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.flights) { _fr24NotFound(msgEl, displayName); return; }
        var gf = _fr24FindInList(data.flights, icaoPrefix, searchNumVal);
        if (!gf) { _fr24NotFound(msgEl, displayName); return; }
        if (msgEl) msgEl.textContent = '';
        _fr24GoToFound(gf, msgEl);
      })
      .catch(function() { _fr24NotFound(msgEl, displayName); });
  }
}

function _fr24FindInList(list, icaoPrefix, numVal) {
  for (var i = 0; i < list.length; i++) {
    var cs = (list[i].cs || '').trim();
    if (cs.indexOf(icaoPrefix) !== 0) continue;
    var csNumPart = cs.substring(icaoPrefix.length).trim();
    if (parseInt(csNumPart, 10) === numVal) return list[i];
  }
  return null;
}

function _fr24NotFound(msgEl, displayName) {
  if (msgEl) msgEl.textContent = '\u26a0 ' + displayName + ' \u7121\u6b64\u822a\u73ed Not found';
  setTimeout(function() { if (msgEl) msgEl.textContent = ''; }, 5000);
}

function _fr24GoToFound(found, msgEl) {
  var lat = found.lat, lon = found.lon;
  if (lat == null || lon == null) return;

  /* mark as searched so it survives filter reapply */
  _fr24SearchedFlight = found;

  /* fly to the flight */
  _fr24Map.flyTo([lat, lon], 8, { duration: 0.8 });

  /* find existing marker or create a temporary one */
  var targetMarker = null;
  _fr24PlaneLayer.eachLayer(function(layer) {
    if (layer._fr24Data === found) targetMarker = layer;
  });
  if (!targetMarker) {
    var heading = found.hdg || 0;
    var icon = L.divIcon({
      className: 'live-plane-icon',
      html: '<div style="transform:rotate(' + heading + 'deg)">\u2708</div>',
      iconSize: [20, 20], iconAnchor: [10, 10]
    });
    targetMarker = L.marker([lat, lon], { icon: icon });
    targetMarker._fr24Data = found;
    targetMarker.on('click', function(e) { _fr24ShowPopup(e.target); });
    _fr24PlaneLayer.addLayer(targetMarker);
  }
  _fr24ShowPopup(targetMarker);
}

/* ── jump to airport ── */
function fr24JumpTo() {
  var sel = document.getElementById('fr24-jump');
  var val = sel.value;
  if (!val || !_fr24Map) return;
  var parts = val.split(',');
  _fr24Map.flyTo([parseFloat(parts[0]), parseFloat(parts[1])], parseInt(parts[2], 10), { duration: 1 });
  sel.value = '';
}

function fr24JumpToIcao() {
  var inp = document.getElementById('fr24-jump-input');
  var code = (inp.value || '').trim().toUpperCase();
  if (!code || !_fr24Map) return;
  var coords = _fr24AirportDb[code];
  if (coords) {
    _fr24Map.flyTo(coords, 10, { duration: 1 });
    inp.value = '';
  } else {
    inp.style.borderColor = '#f44';
    setTimeout(function() { inp.style.borderColor = ''; }, 1500);
  }
}

/* ── sidebar toggle ── */
function fr24ToggleSidebar() {
  var sb = document.getElementById('fr24-sidebar');
  sb.classList.toggle('collapsed');
  _fr24UpdateTogglePos();
}

function _fr24UpdateTogglePos() {
  var sb = document.getElementById('fr24-sidebar');
  var btn = document.getElementById('fr24-sidebar-toggle');
  var isMobile = window.innerWidth < 640;
  var isCollapsed = sb.classList.contains('collapsed');
  if (isMobile) {
    btn.style.right = '';
    btn.style.left = isCollapsed ? '6px' : '';
    btn.style.display = isCollapsed ? '' : 'none';
    return;
  }
  var isRight = sb.classList.contains('live-sidebar-right');
  var sbWidth = 266;
  if (isRight) {
    btn.style.left = '';
    btn.style.right = isCollapsed ? '6px' : (sbWidth + 6) + 'px';
  } else {
    btn.style.right = '';
    btn.style.left = isCollapsed ? '6px' : (sbWidth + 6) + 'px';
  }
  btn.style.display = '';
}

/* ── sidebar left/right switch ── */
function fr24SwitchSidebarPos() {
  var sb = document.getElementById('fr24-sidebar');
  if (sb.classList.contains('live-sidebar-right')) {
    sb.classList.remove('live-sidebar-right');
    sb.classList.add('live-sidebar-left');
  } else {
    sb.classList.remove('live-sidebar-left');
    sb.classList.add('live-sidebar-right');
  }
  _fr24UpdateTogglePos();
  _fr24SaveSettings();
}


/* ── save/restore settings ── */
function _fr24SaveSettings() {
  var sb = document.getElementById('fr24-sidebar');
  var pos = sb.classList.contains('live-sidebar-left') ? 'left' : 'right';
  var filters = {
    jx: document.getElementById('fr24-f-jx').checked,
    br: document.getElementById('fr24-f-br').checked,
    ci: document.getElementById('fr24-f-ci').checked,
    custom: document.getElementById('fr24-f-custom').value,
    labels: document.getElementById('fr24-f-labels').checked
  };
  try {
    localStorage.setItem('crewsync_fr24_sb', pos);
    localStorage.setItem('crewsync_fr24_filters', JSON.stringify(filters));
  } catch (e) {}
}

function _fr24RestoreSettings() {
  try {
    var pos = localStorage.getItem('crewsync_fr24_sb');
    if (pos === 'right') fr24SwitchSidebarPos();
    var f = JSON.parse(localStorage.getItem('crewsync_fr24_filters') || 'null');
    if (f) {
      document.getElementById('fr24-f-jx').checked = !!f.jx;
      document.getElementById('fr24-f-br').checked = !!f.br;
      document.getElementById('fr24-f-ci').checked = !!f.ci;
      document.getElementById('fr24-f-custom').value = f.custom || '';
      document.getElementById('fr24-f-labels').checked = !!f.labels;
      _fr24ShowLabels = !!f.labels;
    }
  } catch (e) {}
}

// ── 📋 提示卡 (Flight Briefing Card) ─────────────────────────────────────────
var _briefLoaded = false;

/* ── 航班號跨分頁同步 ── */
var _syncFltLock = false;
function _syncFltNo(source, val) {
  if (_syncFltLock) return;
  if (!/\d/.test(val)) return;
  _syncFltLock = true;
  if (source === 'brief') {
    var pa = document.getElementById('pa-lt-input');
    if (pa) {
      pa.value = val;
      if (_briefFidsCache && !_paFidsCache) { _paFidsCache = _briefFidsCache; _paFidsCacheTime = Date.now(); }
      _paLookupLocalTime(val);
    }
  } else {
    var br = document.getElementById('brief-fno');
    if (br) {
      br.value = val;
      if (_paFidsCache && !_briefFidsCache) { _briefFidsCache = _paFidsCache; }
      _briefOnInput(val);
    }
  }
  _syncFltLock = false;
}

var _briefFields = ['brief-gate','brief-origin','brief-dest','brief-ofp','brief-ft'];
var _briefNotes = ['brief-note1','brief-note2','brief-note3'];

/* ── IATA → UTC offset (hours) ── */
var _briefTzOffset = {
  TPE:8,KHH:8,TSA:8,RMQ:8,
  HKG:8,MFM:8,
  NRT:9,HND:9,KIX:9,CTS:9,FUK:9,SDJ:9,OKA:9,
  KMJ:9,NGO:9,KOJ:9,TAK:9,UKB:9,
  ICN:9,PUS:9,CJU:9,
  CRK:8,MNL:8,CEB:8,DVO:8,
  BKK:7,DMK:7,UTP:7,CNX:7,HKT:7,
  SGN:7,HAN:7,PQC:7,PNH:7,CXR:7,DAD:7,
  CGK:7,DPS:8,SUB:7,KCH:8,KUL:8,PEN:8,
  SIN:8,
  LAX:-8,SFO:-8,SEA:-8,ONT:-8,OAK:-8,PDX:-8,SMF:-8,
  DEN:-7,TUS:-7,PHX:-7,LAS:-8,
  ANC:-9,HNL:-10,GUM:10,SPN:10,
  YVR:-8,
  PRG:1,BER:1,MUC:1,WAW:1,LNZ:1,VIE:1
};

/* ── IATA → ICAO 對照 ── */
var _briefIataToIcao = {
  TPE:'RCTP',KHH:'RCKH',TSA:'RCSS',RMQ:'RCMQ',
  HKG:'VHHH',MFM:'VMMC',
  NRT:'RJAA',HND:'RJTT',KIX:'RJBB',CTS:'RJCC',FUK:'RJFF',SDJ:'RJSS',OKA:'ROAH',
  KMJ:'RJFT',NGO:'RJGG',KOJ:'RJFK',TAK:'RJOT',UKB:'RJBE',
  ICN:'RKSI',PUS:'RKPK',CJU:'RKPC',
  CRK:'RPLC',MNL:'RPLL',CEB:'RPVM',DVO:'RPMD',
  BKK:'VTBS',DMK:'VTBD',UTP:'VTBU',CNX:'VTCC',HKT:'VTSP',
  SGN:'VVTS',HAN:'VVNB',PQC:'VVPQ',PNH:'VDPP',CXR:'VVCR',DAD:'VVDN',
  CGK:'WIII',DPS:'WADD',SUB:'WARR',KCH:'WBGG',KUL:'WMKK',PEN:'WMKP',
  SIN:'WSSS',
  LAX:'KLAX',SFO:'KSFO',SEA:'KSEA',ONT:'KONT',OAK:'KOAK',PDX:'KPDX',SMF:'KSMF',
  DEN:'KDEN',TUS:'KTUS',PHX:'KPHX',LAS:'KLAS',
  ANC:'PANC',HNL:'PHNL',GUM:'PGUM',SPN:'PGSN',
  YVR:'CYVR',
  PRG:'LKPR',BER:'EDDB',MUC:'EDDM',WAW:'EPWA',LNZ:'LOWL',VIE:'LOWW'
};

/* ── 機場名稱查詢（從 _wxFleetData 建表）── */
var _briefAirportNames = null;
function _briefGetName(icao) {
  if (!_briefAirportNames) {
    _briefAirportNames = {};
    if (typeof _wxFleetData !== 'undefined') {
      for (var fleet in _wxFleetData) {
        for (var region in _wxFleetData[fleet]) {
          var list = _wxFleetData[fleet][region];
          for (var i = 0; i < list.length; i++) {
            _briefAirportNames[list[i].icao] = list[i].name;
          }
        }
      }
    }
  }
  return _briefAirportNames[icao] || '';
}

function briefInit() {
  if (_briefLoaded) return;
  _briefLoaded = true;
  _briefRestore();
  // 還原後同步航班號到 PA
  var _rFno = document.getElementById('brief-fno');
  if (_rFno && _rFno.value) _syncFltNo('brief', _rFno.value);
  // 還原後自動載入天氣
  var _rOrigin = document.getElementById('brief-origin');
  var _rDest = document.getElementById('brief-dest');
  if (_rOrigin && _rOrigin.value) _briefFetchWx('owx', _rOrigin.value);
  if (_rDest && _rDest.value) _briefFetchWx('dwx', _rDest.value);
  _briefFields.concat(_briefNotes).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', _briefSave);
  });
  // Flight Time + Altitude → PA Welcome 同步
  var ftEl = document.getElementById('brief-ft');
  if (ftEl) {
    ftEl.addEventListener('input', function() { _briefSyncFtToPa(ftEl.value); });
    if (ftEl.value) _briefSyncFtToPa(ftEl.value);
  }
  var altEl = document.getElementById('brief-ofp');
  if (altEl) {
    altEl.addEventListener('input', function() { _briefSyncAltToPa(altEl.value); });
    if (altEl.value) _briefSyncAltToPa(altEl.value);
  }
}

/* ── Flight Time + Altitude → PA Welcome 同步 ── */
var _briefFltHr = '';
var _briefFltMin = '';
var _briefAltitude = '';
function _briefSyncFtToPa(val) {
  var raw = val.replace(/\s/g, '');
  _briefFltHr = ''; _briefFltMin = '';
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    var parts = raw.split(':');
    _briefFltHr = parts[0]; _briefFltMin = parts[1];
  } else if (/^\d{3,4}$/.test(raw)) {
    _briefFltMin = raw.slice(-2);
    _briefFltHr = raw.slice(0, -2);
  }
  _briefApplyFtToPa();
}
function _briefSyncAltToPa(val) {
  _briefAltitude = val.trim();
  _briefApplyAltToPa();
}
function _briefApplyAltToPa() {
  var el = document.getElementById('pa-content');
  if (!el) return;
  if (typeof _paManualFlags !== 'undefined') delete _paManualFlags['altitude'];
  el.querySelectorAll('[data-pa="altitude"]').forEach(function(inp) { inp.value = _briefAltitude; });
}
function _briefApplyFtToPa() {
  var el = document.getElementById('pa-content');
  if (!el) return;
  if (typeof _paManualFlags !== 'undefined') { delete _paManualFlags['flt-hr']; delete _paManualFlags['flt-min']; }
  el.querySelectorAll('[data-pa="flt-hr"]').forEach(function(inp) { inp.value = _briefFltHr; });
  el.querySelectorAll('[data-pa="flt-min"]').forEach(function(inp) { inp.value = _briefFltMin; });
}

/* ── 強制重新查詢（Enter / 查詢按鈕）── */
function _briefForceQuery() {
  var inp = document.getElementById('brief-fno');
  if (!inp) return;
  var raw = inp.value.trim().toUpperCase();
  if (!raw) return;
  var num = raw.replace(/^SJX|^JX/, '').replace(/\s/g, '').replace(/^0+/, '') || '0';
  if (!/^\d+$/.test(num)) return;
  _briefFidsCache = null;
  _briefFltStatus('查詢中...', 'loading');
  _briefLookup(num, true);  // force=true 跳過快取
}

/* ── debounce 自動查詢 ── */
var _briefFltTimer = null;
var _briefFidsCache = null;

function _briefOnInput(val) {
  if (_briefFltTimer) clearTimeout(_briefFltTimer);
  var raw = val.trim().toUpperCase();
  if (!raw) { _briefFltStatus('', ''); briefClearInfo(); return; }
  var num = raw.replace(/^SJX|^JX/, '').replace(/\s/g, '').replace(/^0+/, '') || '0';
  if (!/^\d+$/.test(num)) { _briefFltStatus('', ''); return; }
  _briefFltStatus('查詢中...', 'loading');
  _briefFltTimer = setTimeout(function() { _briefLookup(num); }, 500);
}

function _briefHasFlight(num, data) {
  var lists = (data.dep || []).concat(data.arr || []);
  for (var i = 0; i < lists.length; i++) {
    var f = lists[i];
    if (!f.ACode || f.ACode.trim() !== 'JX') continue;
    var fNum = (f.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (fNum === num) return true;
  }
  return false;
}

function _briefLookup(num, force) {
  var fno = 'JX' + num;
  var inp = document.getElementById('brief-fno');
  if (inp) inp.value = fno;

  if (!force && _briefFidsCache && _briefHasFlight(num, _briefFidsCache)) {
    var cd = (_briefFidsCache.date || '').replace(/^\d{4}\//, '');
    _briefFltStatus(cd + ' 查到航班 ✓', 'ok');
    _briefFillFromFids(fno, _briefFidsCache);
    return;
  }

  // 自動搜尋：今天 → 明天 → 昨天
  var tryDates = [0, 1, -1];
  var idx = 0;
  var tryNext = function() {
    if (idx >= tryDates.length) {
      _briefFltStatus('查無此航班', 'err');
      return;
    }
    var d = _paDateOffset(tryDates[idx]);
    var dm = d.replace(/^\d{4}\//, '');
    idx++;
    _briefFltStatus('查詢 ' + dm + '...', 'loading');
    _fidsFetchByDate(d, force).then(function(data) {
      if (_briefHasFlight(num, data)) {
        _briefFidsCache = data;
        var foundDate = (data.date || d).replace(/^\d{4}\//, '');
        _briefFltStatus(foundDate + ' 查到航班 ✓', 'ok');
        _briefFillFromFids(fno, data);
      } else {
        tryNext();
      }
    }).catch(function() { tryNext(); });
  };
  tryNext();
}

function _briefFltStatus(msg, type) {
  var el = document.getElementById('brief-flt-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pa-flt-status' + (type ? ' pa-flt-' + type : '');
}

function _briefFillFromFids(fno, data) {
  var depList = data.dep || [];
  var arrList = data.arr || [];
  var dateStr = data.date || '';
  var num = fno.replace(/^JX/i, '').replace(/^0+/, '') || '0';

  var depFlight = null;
  for (var i = 0; i < depList.length; i++) {
    var d = depList[i];
    if (!d.ACode || d.ACode.trim() !== 'JX') continue;
    var dNum = (d.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (dNum === num) { depFlight = d; /* 不 break，取最後一筆（跨午夜取次日） */ }
  }

  var arrFlight = null;
  for (var j = 0; j < arrList.length; j++) {
    var a = arrList[j];
    if (!a.ACode || a.ACode.trim() !== 'JX') continue;
    var aNum = (a.FlightNo || '').replace(/\s/g, '').replace(/^0+/, '') || '0';
    if (aNum === num) { arrFlight = a; /* 不 break，取最後一筆 */ }
  }

  if (!depFlight && !arrFlight) { _briefFltStatus('查無此航班', 'err'); return; }

  // Dep Date/Time
  var dtEl = document.getElementById('brief-dep-dt');
  if (dtEl) {
    if (depFlight) {
      var depDateStr = depFlight.ODate || dateStr;
      var time = _briefFmtTime(depFlight.OTime);
      dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + depDateStr + '</div>' +
        '<div style="font-size:1.1em;font-weight:700">' + time + ' Local</div>';
    } else if (arrFlight) {
      var arrDateStr = arrFlight.ODate || dateStr;
      // arrFlight.OTime 是 TPE 抵達時間(STA)，不是出發地的 STD
      // 先顯示載入中，再從 FR24/FA 取得正確出發時間
      dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + arrDateStr + '</div>' +
        '<div style="font-size:1.1em;font-weight:700;color:var(--muted)">查詢出發時間...</div>';
      var originIata = arrFlight.CityCode || '';
      _briefFetchOriginInfo(fno, arrDateStr, dtEl, originIata);
    }
  }

  // TPE Gate (出發或抵達都顯示台北端的 Gate)
  if (depFlight && depFlight.Gate) {
    _briefSet('brief-gate', depFlight.Gate);
  } else if (arrFlight && arrFlight.Gate) {
    _briefSet('brief-gate', arrFlight.Gate);
  }

  // Origin & Dest
  if (depFlight) {
    _briefSet('brief-origin', 'TPE');
    _briefSet('brief-dest', depFlight.CityCode || '');
  } else if (arrFlight) {
    _briefSet('brief-origin', arrFlight.CityCode || '');
    _briefSet('brief-dest', 'TPE');
  }

  _briefSave();

  // Fetch weather
  var originEl = document.getElementById('brief-origin');
  var destEl = document.getElementById('brief-dest');
  if (originEl && originEl.value) _briefFetchWx('owx', originEl.value);
  if (destEl && destEl.value) _briefFetchWx('dwx', destEl.value);
}

/* ── 外站出發資訊查詢（FR24 排程 API → FR24 即時 → FA）── */
function _briefFetchOriginInfo(fno, arrDateStr, dtEl, originIata) {

  function renderDep(depTs, gate) {
    var timeStr = '';
    var depDateStr = arrDateStr;
    if (depTs) {
      var d = new Date(depTs * 1000);
      var offset = _briefTzOffset[originIata];
      if (offset === undefined) offset = 8;
      var local = new Date(d.getTime() + offset * 3600000);
      var hh = String(local.getUTCHours()).padStart(2, '0');
      var mm = String(local.getUTCMinutes()).padStart(2, '0');
      timeStr = hh + ':' + mm;
      depDateStr = local.getUTCFullYear() + '/' +
        String(local.getUTCMonth() + 1).padStart(2, '0') + '/' +
        String(local.getUTCDate()).padStart(2, '0');
    }
    var display = timeStr ? timeStr + ' Local' : '';
    if (gate && originIata !== 'TPE') display += (display ? ' / Gate ' : 'Gate ') + gate;
    dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + depDateStr + '</div>' +
      '<div style="font-size:1.1em;font-weight:700">' + (display || '—') + '</div>';
  }

  // 把 FIDS 到達日 "2026/03/09" 轉成 "20260309" 用於比對
  var arrDateClean = arrDateStr.replace(/\//g, '');

  // 1) FR24 排程 API（主要來源）
  fetch('/api/fr24-schedule?fno=' + encodeURIComponent(fno))
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.flights || data.flights.length === 0) return null;
      var matched = null;
      for (var i = 0; i < data.flights.length; i++) {
        var f = data.flights[i];
        var arrTs = f.actualArr || f.scheduledArr;
        if (!arrTs) continue;
        var arrTPE = new Date(arrTs * 1000 + 8 * 3600000);
        var y = arrTPE.getUTCFullYear();
        var m = String(arrTPE.getUTCMonth() + 1).padStart(2, '0');
        var d = String(arrTPE.getUTCDate()).padStart(2, '0');
        if (y + m + d === arrDateClean) { matched = f; break; }
      }
      if (!matched) matched = data.flights[data.flights.length - 1];
      return matched;
    })
    .then(function(sched) {
      if (sched && (sched.actualDep || sched.scheduledDep)) {
        var depTs = sched.actualDep || sched.scheduledDep;
        renderDep(depTs, '');
        // 再查 FR24 即時/FA 補 gate
        _briefFetchGate(fno, originIata, function(gate) {
          if (gate) renderDep(depTs, gate);
        });
      } else {
        // 排程沒資料，退回即時查詢
        _briefFetchLiveOrigin(fno, arrDateStr, dtEl, originIata);
      }
    })
    .catch(function() {
      _briefFetchLiveOrigin(fno, arrDateStr, dtEl, originIata);
    });
}

/* ── 退回 FR24 即時 + FA 查出發資訊 ── */
function _briefFetchLiveOrigin(fno, dateStr, dtEl, originIata) {
  var done = false;
  var pending = 2;
  function tryUpdate(flight) {
    if (done) return;
    if (!flight) { pending--; if (pending <= 0) fallback(); return; }
    var depIso = flight.scheduledDep || flight.actualDep || '';
    var gate = (flight.origin && flight.origin.gate) || '';
    if (!depIso && !gate) { pending--; if (pending <= 0) fallback(); return; }
    done = true;
    var timeStr = '';
    var depDateStr = dateStr;
    if (depIso) {
      var d = new Date(depIso);
      var offset = _briefTzOffset[originIata];
      if (offset === undefined) offset = 8;
      var local = new Date(d.getTime() + offset * 3600000);
      timeStr = String(local.getUTCHours()).padStart(2, '0') + ':' + String(local.getUTCMinutes()).padStart(2, '0');
      depDateStr = local.getUTCFullYear() + '/' + String(local.getUTCMonth() + 1).padStart(2, '0') + '/' + String(local.getUTCDate()).padStart(2, '0');
    }
    var display = timeStr ? timeStr + ' Local' : '';
    if (gate && originIata !== 'TPE') display += (display ? ' / Gate ' : 'Gate ') + gate;
    dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + depDateStr + '</div>' +
      '<div style="font-size:1.1em;font-weight:700">' + (display || '—') + '</div>';
  }
  function fallback() {
    dtEl.innerHTML = '<div style="font-size:.85em;color:var(--muted)">' + dateStr + '</div>' +
      '<div style="font-size:1.1em;font-weight:700">—</div>';
  }
  fetch('/api/fids-fr24')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { tryUpdate(data && data.flights && data.flights[fno] || null); })
    .catch(function() { tryUpdate(null); });
  fetch('/api/fids-fa?airline=JX')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { tryUpdate(data && data.flights && data.flights[fno] || null); })
    .catch(function() { tryUpdate(null); });
}

/* ── 只查 Gate（FR24 即時 + FA）── */
function _briefFetchGate(fno, originIata, cb) {
  var done = false;
  var pending = 2;
  function tryGate(flight) {
    if (done) return;
    var gate = flight && flight.origin && flight.origin.gate || '';
    if (gate && originIata !== 'TPE') { done = true; cb(gate); return; }
    pending--;
    if (pending <= 0) cb('');
  }
  fetch('/api/fids-fr24')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { tryGate(data && data.flights && data.flights[fno]); })
    .catch(function() { tryGate(null); });
  fetch('/api/fids-fa?airline=JX')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { tryGate(data && data.flights && data.flights[fno]); })
    .catch(function() { tryGate(null); });
}

function _briefFmtTime(t) {
  if (!t) return '';
  return t.replace(/:\d{2}$/, '');
}

function _briefSet(id, val) {
  var el = document.getElementById(id);
  if (el) el.value = val;
}

function _briefFmtSky(m) {
  if (!m) return '';
  if (!m.sky || m.sky.length === 0) return m.visib === '10+' ? 'CAVOK' : '';
  var ceilings = m.sky.filter(function(s) { return s.cover === 'BKN' || s.cover === 'OVC'; });
  if (ceilings.length > 0) {
    var lowest = ceilings.reduce(function(a, b) { return a.base < b.base ? a : b; });
    return lowest.cover + String(Math.round(lowest.base / 100)).padStart(3, '0');
  }
  var top = m.sky[m.sky.length - 1];
  return top.cover + String(Math.round(top.base / 100)).padStart(3, '0');
}

/* ── 天氣查詢 ── */
var _briefWxTimer = {};

function _briefWxRefresh(target, iata) {
  if (_briefWxTimer[target]) clearTimeout(_briefWxTimer[target]);
  _briefWxTimer[target] = setTimeout(function() {
    _briefFetchWx(target, iata.trim().toUpperCase());
  }, 500);
}

function _briefFetchWx(target, iata) {
  var el = document.getElementById('brief-' + target);
  if (!el) return;
  if (!iata || iata.length < 2) { el.innerHTML = '—'; return; }

  var icao = _briefIataToIcao[iata] || iata;
  if (!/^[A-Z]{4}$/.test(icao)) { el.innerHTML = '—'; return; }

  el.innerHTML = '<span style="color:var(--muted);font-size:.8em">載入中...</span>';

  fetch('/api/metar?ids=' + icao + '&hours=6').then(function(r) { return r.ok ? r.text() : Promise.reject(); }).then(function(text) {
      var lines = text.trim().split('\n').filter(function(l) { return l.trim(); });
      if (lines.length === 0) { el.innerHTML = '<span style="color:var(--muted)">無資料</span>'; return; }
      var raw = lines[0].replace(/^(METAR|SPECI)\s+/, '').trim();
      var m = parseMetarLine(raw);
      var cat = wxCalcCat(m);
      var name = _briefGetName(icao);
      var mins = wxMinsAgo(m);
      var ageClass = mins > 90 ? 'color:#ef4444' : mins > 60 ? 'color:#f59e0b' : 'color:var(--muted)';
      var ageText = mins !== null && mins > 90 ? 'expired' : '';
      var skyText = _briefFmtSky(m);
      el.innerHTML =
        '<div style="text-align:left;font-size:.78em;line-height:1.6">' +
        '<div><span class="wx-cat cat-' + cat + '" style="font-size:.7em;padding:1px 5px">' + cat + '</span> ' +
        '<b>' + icao + '</b>' + (name ? ' ' + name : '') + '</div>' +
        '<div style="color:var(--muted)">' + wxFmtWind(m) + ' &middot; ' + wxFmtVis(m) + ' &middot; ' + wxFmtTemp(m) +
        (skyText ? ' &middot; ' + skyText : '') +
        (ageText ? ' <span style="font-size:.85em;' + ageClass + '">' + ageText + '</span>' : '') +
        '</div></div>';
    })
    .catch(function() {
      el.innerHTML = '<span style="color:var(--muted)">查詢失敗</span>';
    });
}

/* ── 清除 ── */
function briefClearInfo() {
  _briefFields.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var dtEl = document.getElementById('brief-dep-dt');
  if (dtEl) dtEl.innerHTML = '—';
  var owx = document.getElementById('brief-owx');
  if (owx) owx.innerHTML = '—';
  var dwx = document.getElementById('brief-dwx');
  if (dwx) dwx.innerHTML = '—';
  _briefSave();
}

function briefClearAll() {
  var fno = document.getElementById('brief-fno');
  if (fno) fno.value = '';
  _briefFltStatus('', '');
  _briefFidsCache = null;
  briefClearInfo();
  briefClearNotes();
}

function briefClearNotes() {
  _briefNotes.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  _briefSave();
}

/* ── localStorage ── */
function _briefSave() {
  try {
    var obj = {};
    _briefFields.concat(_briefNotes).forEach(function(id) {
      var el = document.getElementById(id);
      if (el) obj[id] = el.value;
    });
    var fno = document.getElementById('brief-fno');
    if (fno) obj['brief-fno'] = fno.value;
    var depDt = document.getElementById('brief-dep-dt');
    if (depDt) obj['brief-dep-dt'] = depDt.innerHTML;
    localStorage.setItem('crewsync_brief_data', JSON.stringify(obj));
  } catch(e) {}
}

function _briefRestore() {
  try {
    var s = localStorage.getItem('crewsync_brief_data');
    if (!s) return;
    var obj = JSON.parse(s);
    Object.keys(obj).forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (id === 'brief-dep-dt') { el.innerHTML = obj[id] || '—'; }
      else { el.value = obj[id] || ''; }
    });
  } catch(e) {}
}

// ── ⏳ 輪休計算 (Crew Rest Calculator) ────────────────────────────────────────
var _crLoaded = false;
var _crPerPerson = 0; // minutes

function crewrestInit() {
  if (_crLoaded) return;
  _crLoaded = true;
  var restored = _crRestore();
  if (!restored) {
    _crOnCrewChange();
    // 從提示卡帶入飛行時間（如果輪休欄位為空）
    _crSyncFtFromBrief();
  }
}

/* ── 從提示卡帶入飛行時間 ── */
function _crSyncFtFromBrief() {
  var fhEl = document.getElementById('cr-fh');
  var fmEl = document.getElementById('cr-fm');
  if (!fhEl || !fmEl) return;
  if (fhEl.value || fmEl.value) return; // 已有值不覆蓋
  if (typeof _briefFltHr === 'undefined' || typeof _briefFltMin === 'undefined') return;
  if (_briefFltHr) fhEl.value = _briefFltHr;
  if (_briefFltMin) fmEl.value = _briefFltMin;
  if (_briefFltHr || _briefFltMin) crewrestCalc();
}

/* ── 計算建議休時 ── */
function crewrestCalc() {
  var fh = parseInt(document.getElementById('cr-fh').value) || 0;
  var fm = parseInt(document.getElementById('cr-fm').value) || 0;
  var crew = parseInt(document.getElementById('cr-crew').value) || 4;
  var groups = crew === 3 ? 3 : 2;

  var totalMin = fh * 60 + fm;
  if (totalMin <= 60) {
    document.getElementById('cr-result').style.display = 'none';
    var mw0 = document.getElementById('cr-manual-wrap');
    if (mw0) mw0.style.display = 'none';
    _crPerPerson = 0;
    _crSave();
    return;
  }

  var restMin = totalMin - 60;
  var perPerson = Math.floor(restMin / groups);
  perPerson = Math.floor(perPerson / 5) * 5;
  _crPerPerson = perPerson;

  var hh = Math.floor(perPerson / 60);
  var mm = perPerson % 60;
  document.getElementById('cr-result-time').textContent = String(hh) + ':' + String(mm).padStart(2, '0');
  // only show if TOD suggestion is not visible
  var todVis = document.getElementById('cr-tod-box');
  document.getElementById('cr-result').style.display = (todVis && todVis.style.display !== 'none') ? 'none' : '';
  var mw = document.getElementById('cr-manual-wrap');
  if (mw) mw.style.display = '';

  _crBuildSchedule();
}

/* ── 組員人數切換 ── */
function _crOnCrewChange() {
  var crew = parseInt(document.getElementById('cr-crew').value) || 4;
  var modeWrap = document.getElementById('cr-mode-wrap');
  if (modeWrap) modeWrap.style.display = crew === 3 ? 'none' : '';
  _crBuildSchedule();
}

/* ── 動態產生排程表 ── */
function _crBuildSchedule() {
  var crew = parseInt(document.getElementById('cr-crew').value) || 4;
  var container = document.getElementById('cr-schedule');
  if (!container) return;

  // preserve start / TOD values across rebuild (duration resets on mode change)
  var prevStart = '';
  var prevTod = '';
  var oldStartEl = document.getElementById('cr-start');
  var oldTodEl = document.getElementById('cr-tod');
  if (oldStartEl) prevStart = oldStartEl.value;
  if (oldTodEl) prevTod = oldTodEl.value;

  container.innerHTML = '';

  // shared start time + TOD row
  var startRow = document.createElement('div');
  startRow.className = 'cr-start-row';
  startRow.innerHTML =
    '<label>Rest Start (UTC)</label><input type="text" class="cr-start-input" id="cr-start" placeholder="HHMM" maxlength="4" inputmode="numeric">' +
    '<label style="margin-left:12px">TOD (UTC)</label><input type="text" class="cr-start-input" id="cr-tod" placeholder="HHMM" maxlength="4" inputmode="numeric">' +
    '<div class="cr-result-box" id="cr-tod-box" style="display:none;flex-direction:row;align-items:center;gap:8px;padding:4px 12px">' +
      '<span style="font-size:10px;color:var(--accent);white-space:nowrap">Per Person</span>' +
      '<span class="cr-result-time" id="cr-tod-result">—</span>' +
      '<button class="cr-apply-btn" onclick="crewrestApplyTod()">Apply</button>' +
    '</div>';
  container.appendChild(startRow);

  // restore preserved values
  var startInput = document.getElementById('cr-start');
  var todInput = document.getElementById('cr-tod');
  if (prevStart) startInput.value = prevStart;
  if (prevTod) todInput.value = prevTod;

  startInput.addEventListener('input', function() { _crValidateTimeInput(this); _crRecalcAll(); _crCalcTod(); if (this.value.length === 4) todInput.focus(); });
  startInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); todInput.focus(); } });
  todInput.addEventListener('input', function() { _crValidateTimeInput(this); _crCalcTod(); if (this.value.length === 4) { var f = document.getElementById('cr-d-g1-0'); if (f) f.focus(); } });
  todInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); var f = document.getElementById('cr-d-g1-0'); if (f) f.focus(); } });

  if (crew === 3) {
    container.appendChild(_crBuildGroupTable('A / B / C', ['A', 'B', 'C'], 1));
  } else {
    var mode = _crGetMode();
    if (mode === 'cross') {
      // 交叉輪休: Ops Crew 休中間一段
      container.appendChild(_crHintNote());
      container.appendChild(_crBuildGroupTable('Ops Crew Single Rest', ['B+D', 'A+C', 'B+D'], 1));
    } else if (mode === 'single') {
      // 一段輪休: Group 1 → Group 2 (sequential)
      container.appendChild(_crBuildGroupTable('Sequential Rest', ['Group 1', 'Group 2'], 1));
    } else {
      // 分組輪休: CM1 + CM2 side by side
      container.appendChild(_crHintNote());
      var row = document.createElement('div');
      row.className = 'cr-groups-row';
      row.appendChild(_crBuildGroupTable('CM1 (A / B)', ['A', 'B', 'A', 'B'], 1));
      row.appendChild(_crBuildGroupTable('CM2 (C / D)', ['C', 'D', 'C', 'D'], 2));
      container.appendChild(row);
    }
  }

  // re-evaluate TOD after rebuild
  _crCalcTod();
  _crRecalcAll();
}

function _crGetMode() {
  var radios = document.getElementsByName('cr-mode');
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].checked) return radios[i].value;
  }
  return 'group';
}

function _crBuildGroupTable(title, people, groupNum) {
  var div = document.createElement('div');
  div.className = 'cr-group';

  var titleDiv = document.createElement('div');
  titleDiv.className = 'cr-group-title';
  titleDiv.textContent = title;
  div.appendChild(titleDiv);

  var table = document.createElement('table');
  table.className = 'cr-table';

  var thead = document.createElement('thead');
  thead.innerHTML = '<tr><th></th><th>Start</th><th>Duration</th><th>End</th></tr>';
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  tbody.id = 'cr-tbody-g' + groupNum;

  for (var i = 0; i < people.length; i++) {
    var tr = document.createElement('tr');

    var tdWho = document.createElement('td');
    tdWho.className = 'cr-who';
    var letter = people[i];
    tdWho.textContent = letter;

    var tdStart = document.createElement('td');
    var spanStart = document.createElement('span');
    spanStart.id = 'cr-s-g' + groupNum + '-' + i;
    spanStart.textContent = '—';
    spanStart.style.cssText = 'color:var(--muted);font-size:.9em';
    tdStart.appendChild(spanStart);

    var tdDur = document.createElement('td');
    var durInput = document.createElement('input');
    durInput.type = 'text';
    durInput.className = 'cr-dur-input';
    durInput.id = 'cr-d-g' + groupNum + '-' + i;
    durInput.placeholder = 'HH:MM';
    durInput.maxLength = 5;
    durInput.addEventListener('input', function() { _crValidateDurInput(this); _crAutoRedistribute(this.id); _crRecalcAll(); });
    durInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); _crJumpNext(this.id); } });
    tdDur.appendChild(durInput);

    var tdEnd = document.createElement('td');
    tdEnd.className = 'cr-end';
    tdEnd.id = 'cr-e-g' + groupNum + '-' + i;
    tdEnd.textContent = '—';

    tr.appendChild(tdWho);
    tr.appendChild(tdStart);
    tr.appendChild(tdDur);
    tr.appendChild(tdEnd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  div.appendChild(table);
  return div;
}

function _crHintNote() {
  var p = document.createElement('div');
  p.style.cssText = 'font-size:.75em;color:var(--muted);text-align:center;margin:4px 0 8px';
  p.textContent = 'Adjust duration manually; remaining time auto-calculated';
  return p;
}

/* ── 手動帶入休時 ── */
function crewrestApplyManual() {
  var inp = document.getElementById('cr-manual-rest');
  if (!inp) return;
  var min = _crParseDur(inp.value);
  if (min <= 0) return;
  _crApplyWithMinutes(min);
}

/* ── 帶入建議休時 ── */
function crewrestApply() {
  if (_crPerPerson <= 0) return;
  _crApplyWithMinutes(_crPerPerson);
}

function _crApplyWithMinutes(perPerson) {
  var crew = parseInt(document.getElementById('cr-crew').value) || 4;

  if (crew === 3) {
    _crFillGroup(1, 3, perPerson);
  } else {
    var mode = _crGetMode();
    if (mode === 'cross') {
      // B+D splits (first+last), A+C full middle
      var bdFirst = Math.floor(perPerson / 2);
      bdFirst = Math.floor(bdFirst / 5) * 5;
      var bdSecond = perPerson - bdFirst;
      var el0 = document.getElementById('cr-d-g1-0');
      var el1 = document.getElementById('cr-d-g1-1');
      var el2 = document.getElementById('cr-d-g1-2');
      if (el0) el0.value = _crFmtMin(bdFirst);
      if (el1) el1.value = _crFmtMin(perPerson);
      if (el2) el2.value = _crFmtMin(bdSecond);
    } else if (mode === 'single') {
      // 一段輪休: Group 1 → Group 2, each = perPerson
      var elS0 = document.getElementById('cr-d-g1-0');
      var elS1 = document.getElementById('cr-d-g1-1');
      if (elS0) elS0.value = _crFmtMin(perPerson);
      if (elS1) elS1.value = _crFmtMin(perPerson);
    } else {
      _crFillGroup(1, 4, perPerson);
      _crFillGroup(2, 4, perPerson);
    }
  }
  _crRecalcAll();
}

function _crFillGroup(groupNum, segCount, perPerson) {
  if (segCount === 3) {
    for (var i = 0; i < 3; i++) {
      var el = document.getElementById('cr-d-g' + groupNum + '-' + i);
      if (el) el.value = _crFmtMin(perPerson);
    }
  } else {
    var half = Math.floor(perPerson / 2);
    half = Math.floor(half / 5) * 5;
    var remainder = perPerson - half;
    for (var j = 0; j < 4; j++) {
      var el2 = document.getElementById('cr-d-g' + groupNum + '-' + j);
      if (el2) el2.value = (j < 2) ? _crFmtMin(half) : _crFmtMin(remainder);
    }
  }
}

/* ── 重新計算所有時間 ── */
function _crRecalcAll() {
  var crew = parseInt(document.getElementById('cr-crew').value) || 4;
  var startMin = _crParseStart();

  if (crew === 3) {
    _crRecalcGroup(1, 3, startMin);
  } else {
    var mode = _crGetMode();
    if (mode === 'cross') {
      _crRecalcGroup(1, 3, startMin);
    } else if (mode === 'single') {
      _crRecalcGroup(1, 2, startMin);
    } else {
      // CM1 and CM2 share the same start time
      _crRecalcGroup(1, 4, startMin);
      _crRecalcGroup(2, 4, startMin);
    }
  }
  _crSave();
}

function _crParseStart() {
  var startEl = document.getElementById('cr-start');
  if (!startEl) return -1;
  var v = startEl.value.replace(/\D/g, '');
  if (v.length === 4) {
    var h = parseInt(v.substring(0, 2));
    var m = parseInt(v.substring(2, 4));
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return h * 60 + m;
  }
  return -1;
}

function _crRecalcGroup(groupNum, segCount, startMin) {
  var currentStart = startMin;
  for (var i = 0; i < segCount; i++) {
    var sEl = document.getElementById('cr-s-g' + groupNum + '-' + i);
    var dEl = document.getElementById('cr-d-g' + groupNum + '-' + i);
    var eEl = document.getElementById('cr-e-g' + groupNum + '-' + i);

    if (sEl) {
      if (currentStart >= 0) {
        sEl.textContent = _crFmtMinToTime(currentStart);
        sEl.style.color = 'var(--text)';
      } else {
        sEl.textContent = '—';
        sEl.style.color = 'var(--muted)';
      }
    }

    var durMin = _crParseDur(dEl ? dEl.value : '');

    if (eEl) {
      if (currentStart >= 0 && durMin > 0) {
        var endMin = (currentStart + durMin) % 1440;
        eEl.textContent = _crFmtMinToTime(endMin);
        currentStart = endMin;
      } else {
        eEl.textContent = '—';
        if (durMin > 0 && currentStart >= 0) {
          currentStart = (currentStart + durMin) % 1440;
        }
      }
    }
  }
}

/* ── 模式切換 ── */
function _crModeChange() {
  _crBuildSchedule();
}

/* ── 重置 ── */
function crewrestReset() {
  document.getElementById('cr-fh').value = '';
  document.getElementById('cr-fm').value = '';
  document.getElementById('cr-crew').value = '4';
  document.getElementById('cr-result').style.display = 'none';
  var mwR = document.getElementById('cr-manual-wrap');
  if (mwR) mwR.style.display = 'none';
  var mrI = document.getElementById('cr-manual-rest');
  if (mrI) mrI.value = '';
  _crPerPerson = 0;
  _crTodPerPerson = 0;
  var radios = document.getElementsByName('cr-mode');
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].value === 'group') radios[i].checked = true;
  }
  // 清除 localStorage
  try { localStorage.removeItem('crewsync_cr_data'); } catch(e){}
  _crOnCrewChange();
}

/* ── 自動重算配對段 ── */
function _crAutoRedistribute(editedId) {
  var pp = _crTodPerPerson > 0 ? _crTodPerPerson : _crPerPerson;
  if (pp <= 0) return;
  var m = editedId.match(/^cr-d-g(\d+)-(\d+)$/);
  if (!m) return;
  var g = parseInt(m[1]);
  var idx = parseInt(m[2]);
  var crew = parseInt(document.getElementById('cr-crew').value) || 4;
  var mode = crew === 3 ? '3p' : _crGetMode();

  // only redistribute when a person appears twice
  // group mode: 4 segments (0,1,2,3) → 0↔2, 1↔3
  // cross mode: 3 segments (0,1,2) → 0↔2 (B+D pair), 1 is solo (A+C)
  var pairedIdx = -1;
  if (mode === 'group' && g <= 2) {
    // segments 0↔2, 1↔3
    if (idx === 0) pairedIdx = 2;
    else if (idx === 1) pairedIdx = 3;
    else if (idx === 2) pairedIdx = 0;
    else if (idx === 3) pairedIdx = 1;
  } else if (mode === 'cross') {
    // segments 0↔2 (B+D), segment 1 (A+C) solo
    if (idx === 0) pairedIdx = 2;
    else if (idx === 2) pairedIdx = 0;
  }

  if (pairedIdx < 0) return;
  var editedEl = document.getElementById('cr-d-g' + g + '-' + idx);
  var pairedEl = document.getElementById('cr-d-g' + g + '-' + pairedIdx);
  if (!editedEl || !pairedEl) return;

  var editedMin = _crParseDur(editedEl.value);
  if (editedMin <= 0) return;

  var remain = pp - editedMin;
  if (remain < 0) remain = 0;
  pairedEl.value = _crFmtMin(remain);
  _crValidateDurInput(pairedEl);

  // group mode: 如果 A 全休（配對段=0），合併成 A/B 兩段；反之恢復四段
  if (mode === 'group') {
    _crCheckCollapse(g, pp);
  }
}

/* ── 檢查是否應合併/展開分組輪休 ── */
function _crCheckCollapse(groupNum, pp) {
  var tbody = document.getElementById('cr-tbody-g' + groupNum);
  if (!tbody) return;
  var rows = tbody.querySelectorAll('tr');
  if (rows.length !== 4) return; // 已經是2段或非4段，不處理

  // 檢查 seg0 和 seg1（A和B的第一段）
  var d0 = document.getElementById('cr-d-g' + groupNum + '-0');
  var d1 = document.getElementById('cr-d-g' + groupNum + '-1');
  var dur0 = _crParseDur(d0 ? d0.value : '');
  var dur1 = _crParseDur(d1 ? d1.value : '');

  // A 全休（dur0 >= pp）或 B 全休（dur1 >= pp）→ 合併
  if (dur0 >= pp || dur1 >= pp) {
    // 隱藏第3、4行
    rows[2].style.display = 'none';
    rows[3].style.display = 'none';
    // B 也設為全休
    if (dur0 >= pp && d1) { d1.value = _crFmtMin(pp); }
    if (dur1 >= pp && d0) { d0.value = _crFmtMin(pp); }
    // 清空隱藏段的值
    var d2 = document.getElementById('cr-d-g' + groupNum + '-2');
    var d3 = document.getElementById('cr-d-g' + groupNum + '-3');
    if (d2) d2.value = '00:00';
    if (d3) d3.value = '00:00';
  } else {
    // 恢復顯示
    rows[2].style.display = '';
    rows[3].style.display = '';
  }
}

/* ── auto-jump to next duration input ── */
function _crJumpNext(currentId) {
  // currentId like "cr-d-g1-0" → parse group & index
  var m = currentId.match(/^cr-d-g(\d+)-(\d+)$/);
  if (!m) return;
  var g = parseInt(m[1]);
  var idx = parseInt(m[2]);
  // try next index in same group
  var next = document.getElementById('cr-d-g' + g + '-' + (idx + 1));
  if (next) { next.focus(); return; }
  // try first index of next group
  next = document.getElementById('cr-d-g' + (g + 1) + '-0');
  if (next) { next.focus(); }
}

/* ── helpers ── */
function _crFmtMin(minutes) {
  var h = Math.floor(minutes / 60);
  var m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function _crFmtMinToTime(totalMin) {
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  var h = Math.floor(totalMin / 60);
  var m = totalMin % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/* ── 解析 HHMM 時間，回傳分鐘數或 -1 ── */
function _crParseHHMM(val) {
  if (!val) return -1;
  var v = val.replace(/\D/g, '');
  if (v.length !== 4) return -1;
  var h = parseInt(v.substring(0, 2));
  var m = parseInt(v.substring(2, 4));
  if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

/* ── TOD 計算 ── */
var _crTodPerPerson = 0;

function _crCalcTod() {
  var todBox = document.getElementById('cr-tod-box');
  var resultEl = document.getElementById('cr-tod-result');
  if (!todBox || !resultEl) return;

  var startMin = _crParseStart();
  var todMin = _crParseHHMM(document.getElementById('cr-tod') ? document.getElementById('cr-tod').value : '');

  if (startMin < 0 || todMin < 0) {
    todBox.style.display = 'none';
    _crTodPerPerson = 0;
    // restore flight-time suggestion if available
    var r1 = document.getElementById('cr-result');
    if (r1 && _crPerPerson > 0) r1.style.display = '';
    return;
  }

  // TOD - 20min - start
  var todAdj = (todMin - 20 + 1440) % 1440;
  var available = (todAdj - startMin + 1440) % 1440;
  if (available <= 0) {
    todBox.style.display = 'none';
    _crTodPerPerson = 0;
    var r2 = document.getElementById('cr-result');
    if (r2 && _crPerPerson > 0) r2.style.display = '';
    return;
  }

  var crew = parseInt(document.getElementById('cr-crew').value) || 4;
  var groups = crew === 3 ? 3 : 2;

  // 差 5 分鐘可整除 → 用 TOD-15（available+5）
  if (available % groups !== 0 && (available + 5) % groups === 0) {
    available = available + 5;
  }

  var perPerson = Math.floor(available / groups);
  perPerson = Math.floor(perPerson / 5) * 5;
  _crTodPerPerson = perPerson;

  var hh = Math.floor(perPerson / 60);
  var mm = perPerson % 60;
  resultEl.textContent = hh + ':' + String(mm).padStart(2, '0');
  todBox.style.display = '';
  // hide flight-time suggestion when TOD suggestion is visible
  var r3 = document.getElementById('cr-result');
  if (r3) r3.style.display = 'none';
}

function crewrestApplyTod() {
  if (_crTodPerPerson <= 0) return;
  _crApplyWithMinutes(_crTodPerPerson);
}

/* ── 時間驗證 ── */
function _crValidateTimeInput(el) {
  if (!el || !el.value) { el.style.borderColor = ''; return true; }
  var v = el.value.trim();

  // HH:MM format
  if (v.indexOf(':') >= 0) {
    var parts = v.split(':');
    var h = parseInt(parts[0]);
    var m = parseInt(parts[1]);
    if (isNaN(h) || isNaN(m) || m < 0 || m > 59) {
      el.style.borderColor = '#ef4444';
      return false;
    }
    el.style.borderColor = '';
    return true;
  }

  // HHMM format
  if (/^\d{4}$/.test(v)) {
    var hh = parseInt(v.substring(0, 2));
    var mm = parseInt(v.substring(2, 4));
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      el.style.borderColor = '#ef4444';
      return false;
    }
    el.style.borderColor = '';
    return true;
  }

  el.style.borderColor = '';
  return true;
}

/* ── 休息長度驗證（HH不限, MM≤59） ── */
function _crValidateDurInput(el) {
  if (!el || !el.value) { el.style.borderColor = ''; return true; }
  var v = el.value.trim();

  // H:MM or HH:MM format
  if (v.indexOf(':') >= 0) {
    var parts = v.split(':');
    var h = parseInt(parts[0]);
    var m = parseInt(parts[1]);
    if (isNaN(h) || isNaN(m) || h < 0 || m < 0 || m > 59) {
      el.style.borderColor = '#ef4444';
      return false;
    }
    el.style.borderColor = '';
    return true;
  }

  // 3-4 digit format (e.g. 200 = 2:00, 1030 = 10:30)
  if (/^\d{3,4}$/.test(v)) {
    var mm = parseInt(v.substring(v.length - 2));
    if (mm < 0 || mm > 59) {
      el.style.borderColor = '#ef4444';
      return false;
    }
    el.style.borderColor = '';
    return true;
  }

  el.style.borderColor = '';
  return true;
}

function _crParseDur(val) {
  if (!val) return 0;
  val = val.trim();
  var parts = val.split(':');
  if (parts.length === 2) {
    var h = parseInt(parts[0]) || 0;
    var m = parseInt(parts[1]) || 0;
    if (m > 59) return 0;
    return h * 60 + m;
  }
  if (/^\d{3,4}$/.test(val)) {
    var hh = parseInt(val.substring(0, val.length - 2)) || 0;
    var mm = parseInt(val.substring(val.length - 2)) || 0;
    if (mm > 59) return 0;
    return hh * 60 + mm;
  }
  return 0;
}

/* ── 持久化 ── */
function _crSave() {
  try {
    var obj = {};
    var fh = document.getElementById('cr-fh');
    var fm = document.getElementById('cr-fm');
    var crew = document.getElementById('cr-crew');
    var start = document.getElementById('cr-start');
    var tod = document.getElementById('cr-tod');
    if (fh) obj.fh = fh.value;
    if (fm) obj.fm = fm.value;
    if (crew) obj.crew = crew.value;
    if (start) obj.start = start.value;
    if (tod) obj.tod = tod.value;
    // mode
    var radios = document.getElementsByName('cr-mode');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) { obj.mode = radios[i].value; break; }
    }
    // duration inputs
    obj.durs = {};
    document.querySelectorAll('.cr-dur-input').forEach(function(el) {
      if (el.id && el.value) obj.durs[el.id] = el.value;
    });
    localStorage.setItem('crewsync_cr_data', JSON.stringify(obj));
  } catch(e){}
}

function _crRestore() {
  try {
    var s = localStorage.getItem('crewsync_cr_data');
    if (!s) return false;
    var obj = JSON.parse(s);
    var fh = document.getElementById('cr-fh');
    var fm = document.getElementById('cr-fm');
    var crew = document.getElementById('cr-crew');
    if (fh && obj.fh) fh.value = obj.fh;
    if (fm && obj.fm) fm.value = obj.fm;
    if (crew && obj.crew) crew.value = obj.crew;
    // mode
    if (obj.mode) {
      var radios = document.getElementsByName('cr-mode');
      for (var i = 0; i < radios.length; i++) {
        radios[i].checked = radios[i].value === obj.mode;
      }
    }
    // 先重算建議休時
    if ((fh && fh.value) || (fm && fm.value)) crewrestCalc();
    // rebuild schedule（會用到 crew + mode）
    _crBuildSchedule();
    // restore start/tod after rebuild
    var startEl = document.getElementById('cr-start');
    var todEl = document.getElementById('cr-tod');
    if (startEl && obj.start) startEl.value = obj.start;
    if (todEl && obj.tod) todEl.value = obj.tod;
    // restore durations
    if (obj.durs) {
      Object.keys(obj.durs).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = obj.durs[id];
      });
    }
    _crCalcTod();
    _crRecalcAll();
    // 還原後檢查是否需要合併
    var mode = _crGetMode();
    if (mode === 'group') {
      var pp = _crTodPerPerson > 0 ? _crTodPerPerson : _crPerPerson;
      if (pp > 0) {
        _crCheckCollapse(1, pp);
        _crCheckCollapse(2, pp);
      }
    }
    return true;
  } catch(e){}
  return false;
}

// ── Subtab 拖曳排序 ─────────────────────────────────────────────────────────
var _stDragging = false;
var _stDragSlot = null;
var _stLongTimer = null;
var _stStartX = 0;
var _stStartY = 0;

function _stSlotId(slot) {
  var btn = slot.querySelector('.briefing-subtab');
  return btn ? btn.id : '';
}

function _stVisibleSlots() {
  var bar = document.querySelector('.briefing-subtabs');
  if (!bar) return [];
  return Array.from(bar.children).filter(function(el) {
    return el.style.display !== 'none' &&
      (el.classList.contains('subtab-slot') || el.classList.contains('subtab-wx-wrap'));
  });
}

/* ── 儲存 / 還原順序 ── */
function _stSaveOrder() {
  var bar = document.querySelector('.briefing-subtabs');
  if (!bar) return;
  var order = Array.from(bar.children)
    .filter(function(el) { return el.classList.contains('subtab-slot') || el.classList.contains('subtab-wx-wrap'); })
    .map(function(el) { return _stSlotId(el); })
    .filter(Boolean);
  try { localStorage.setItem('crewsync_subtab_order', JSON.stringify(order)); } catch(e) {}
}

function _stRestoreOrder() {
  try {
    var s = localStorage.getItem('crewsync_subtab_order');
    if (!s) return;
    var order = JSON.parse(s);
    if (!Array.isArray(order) || order.length === 0) return;
    var bar = document.querySelector('.briefing-subtabs');
    if (!bar) return;
    var slotMap = {};
    Array.from(bar.children).forEach(function(el) {
      var id = _stSlotId(el);
      if (id) slotMap[id] = el;
    });
    var frag = document.createDocumentFragment();
    order.forEach(function(id) {
      if (slotMap[id]) { frag.appendChild(slotMap[id]); delete slotMap[id]; }
    });
    // 新增的 tab（不在儲存順序中）放最後
    Object.keys(slotMap).forEach(function(id) { frag.appendChild(slotMap[id]); });
    bar.appendChild(frag);
  } catch(e) {}
}

/* ── 啟動拖曳 ── */
function _stActivate(slot) {
  _stDragging = true;
  slot.classList.add('subtab-dragging');
  if (navigator.vibrate) navigator.vibrate(30);
}

function _stSwapCheck(x) {
  if (!_stDragSlot) return;
  var slots = _stVisibleSlots();
  var idx = slots.indexOf(_stDragSlot);
  if (idx === -1) return;
  // 往左交換
  if (idx > 0) {
    var prev = slots[idx - 1];
    var pr = prev.getBoundingClientRect();
    if (x < pr.left + pr.width * 0.5) {
      _stDragSlot.parentNode.insertBefore(_stDragSlot, prev);
      if (navigator.vibrate) navigator.vibrate(15);
      return;
    }
  }
  // 往右交換
  if (idx < slots.length - 1) {
    var next = slots[idx + 1];
    var nr = next.getBoundingClientRect();
    if (x > nr.left + nr.width * 0.5) {
      _stDragSlot.parentNode.insertBefore(next, _stDragSlot);
      if (navigator.vibrate) navigator.vibrate(15);
      return;
    }
  }
}

function _stEnd() {
  if (_stDragSlot) _stDragSlot.classList.remove('subtab-dragging');
  if (_stDragging) _stSaveOrder();
  _stDragging = false;
  _stDragSlot = null;
  clearTimeout(_stLongTimer);
}

/* ── Touch 事件 ── */
function _stTouchStart(e) {
  var btn = e.target.closest('.briefing-subtab');
  if (!btn) return;
  var slot = btn.closest('.subtab-slot, .subtab-wx-wrap');
  if (!slot || slot.style.display === 'none') return;
  _stStartX = e.touches[0].clientX;
  _stStartY = e.touches[0].clientY;
  _stDragSlot = slot;
  _stLongTimer = setTimeout(function() { _stActivate(slot); }, 500);
  document.addEventListener('touchmove', _stTouchMove, { passive: false });
  document.addEventListener('touchend', _stTouchEnd);
}

function _stTouchMove(e) {
  if (!_stDragging) {
    var dx = Math.abs(e.touches[0].clientX - _stStartX);
    var dy = Math.abs(e.touches[0].clientY - _stStartY);
    if (dx > 10 || dy > 10) { clearTimeout(_stLongTimer); _stTouchCleanup(); }
    return;
  }
  e.preventDefault();
  _stSwapCheck(e.touches[0].clientX);
  // 自動捲動 subtab bar（手指靠近邊緣時）
  var bar = document.querySelector('.briefing-subtabs');
  if (bar) {
    var br = bar.getBoundingClientRect();
    var x = e.touches[0].clientX;
    if (x < br.left + 40) bar.scrollLeft -= 8;
    else if (x > br.right - 40) bar.scrollLeft += 8;
  }
}

function _stTouchEnd() {
  _stEnd();
  _stTouchCleanup();
}

function _stTouchCleanup() {
  document.removeEventListener('touchmove', _stTouchMove);
  document.removeEventListener('touchend', _stTouchEnd);
}

/* ── Mouse 事件（桌面測試用）── */
function _stMouseDown(e) {
  if (e.button !== 0) return;
  var btn = e.target.closest('.briefing-subtab');
  if (!btn) return;
  var slot = btn.closest('.subtab-slot, .subtab-wx-wrap');
  if (!slot || slot.style.display === 'none') return;
  _stStartX = e.clientX;
  _stStartY = e.clientY;
  _stDragSlot = slot;
  _stLongTimer = setTimeout(function() { _stActivate(slot); }, 500);
  document.addEventListener('mousemove', _stMouseMove);
  document.addEventListener('mouseup', _stMouseUp);
}

function _stMouseMove(e) {
  if (!_stDragging) {
    var dx = Math.abs(e.clientX - _stStartX);
    var dy = Math.abs(e.clientY - _stStartY);
    if (dx > 10 || dy > 10) { clearTimeout(_stLongTimer); _stMouseCleanup(); }
    return;
  }
  e.preventDefault();
  _stSwapCheck(e.clientX);
}

function _stMouseUp() {
  _stEnd();
  _stMouseCleanup();
}

function _stMouseCleanup() {
  document.removeEventListener('mousemove', _stMouseMove);
  document.removeEventListener('mouseup', _stMouseUp);
}

/* ── 防止拖曳後觸發 click ── */
function _stPreventClick(e) {
  e.preventDefault();
  e.stopImmediatePropagation();
  e.currentTarget.removeEventListener('click', _stPreventClick, true);
}

/* ── 初始化 ── */
function subtabReorderInit() {
  _stRestoreOrder();
  var bar = document.querySelector('.briefing-subtabs');
  if (!bar) return;
  bar.addEventListener('touchstart', _stTouchStart, { passive: true });
  bar.addEventListener('mousedown', _stMouseDown);
}

