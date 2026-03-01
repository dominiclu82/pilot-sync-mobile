export function getSpaCoreJs(): string {
  return `
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
    btn.textContent = '\u25CE';
    btn.style.opacity = '1';
  } else {
    inp.type = 'password';
    btn.textContent = '\u25C9';
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
      logEl.textContent = data.logs.join('\\n') || '等待中...';
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
  document.getElementById('done-log').textContent = logs.join('\\n') || '';
  showScreen('screen-done');
}

function mkStat(n, label) {
  return '<div class="stat-item"><div class="stat-num">' + n + '</div><div class="stat-lbl">' + label + '</div></div>';
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab, btn) {
  ['tab-sync','tab-briefing','tab-gate'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.classList.remove('tab-active'); el.style.display = 'none'; }
  });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
  var target = document.getElementById('tab-' + tab);
  if (target) { target.style.display = ''; target.classList.add('tab-active'); }
  btn.classList.add('tab-active');
  if (tab === 'gate' && !gateFlightsLoaded) {
    loadGateFlights();
  }
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
    const latestMetar = metarText ? metarText.split('\\n')[0] : '';
    cards += '<div class="atis-card"><div class="atis-card-title">🌤️ METAR</div><pre>' + (latestMetar || noData) + '</pre></div>';
    cards += '<div class="atis-card"><div class="atis-card-title">📅 TAF</div><pre>' + (tafText || noData) + '</pre></div>';
    container.innerHTML = cards;
  });
}

function parseAtisHtml(html) {
  const results = [];
  const titlePattern = /<h5[^>]*class="card-title"[^>]*>([\\s\\S]*?)<\\/h5>/gi;
  const atisPattern = /<div[^>]*class="atis"[^>]*>([\\s\\S]*?)<\\/div>/gi;
  const titles = [];
  const atisTexts = [];
  let m;
  while ((m = titlePattern.exec(html)) !== null) titles.push(m[1].trim().replace(/<[^>]*>/g, ''));
  while ((m = atisPattern.exec(html)) !== null) {
    let text = m[1].replace(/&#xA;/g,'\\n').replace(/&#xD;/g,'').replace(/&#x9;/g,'  ')
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
    var alt = parseFloat(inp.value);
    if (isNaN(alt)) continue;
    var r = ctInterp(alt, elev, oat);
    var corrAlt = Math.round((alt + r.corr) / 10) * 10;
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
  if (panel === 'duty' && !dtUnlocked) {
    document.getElementById('dt-lock-overlay').style.display = 'flex';
    setTimeout(function(){ document.getElementById('dt-lock-pw').focus(); }, 100);
  }
  if (panel === 'pa') {
    paStartTzTimer();
  }
}

// ── Duty Time 密碼鎖 ──────────────────────────────────────────────────────────
var dtUnlocked = false;
function dtUnlock() {
  var pw = document.getElementById('dt-lock-pw').value;
  if (pw === '12345678') {
    dtUnlocked = true;
    document.getElementById('dt-lock-overlay').style.display = 'none';
    document.getElementById('dt-lock-pw').value = '';
    document.getElementById('dt-lock-err').textContent = '';
  } else {
    document.getElementById('dt-lock-err').textContent = '密碼錯誤，請再試一次';
    document.getElementById('dt-lock-pw').value = '';
    document.getElementById('dt-lock-pw').focus();
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

`;
}
