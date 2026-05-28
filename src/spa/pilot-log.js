// ════════════════════════════════════════════════════════════════════════════
// Pilot Log — 前端 v1
//
// 強制分區，每塊自包含；只允許 state 被其他區塊 read，
// 跨區塊呼叫透過 utils。之後若某 section 太大要拆檔，照邊界拆即可。
// ════════════════════════════════════════════════════════════════════════════

// === SECTION: state ═════════════════════════════════════════════════════════
var _pl = {
  clientId: null,
  accessToken: null,
  refreshToken: null,
  user: null,                    // { id, primaryEmail }
  entries: [],                   // 主頁列表用，受 _pl.filter 跟 200 limit 影響（不是完整資料）
  filter: 'all',                 // all | draft | confirmed | roster_removed
  stats: null,
  aircraft: [],                  // pilot_aircraft（tail 為主）
  aircraftTypes: [],              // pilot_aircraft_types（V1.0.11；type 為主，含 make/model）
  crew: [],                       // V1.0.11 crew 名單（含 pilots + cabin crew）
  // Aircraft / Crew 頁共用的完整 entries 快照：不過 _pl.filter、不分頁，撈到所有 user 的 flights
  // 用 null 區別「還沒拉過」和「拉過但是空陣列」，進 Aircraft 或 Crew 頁第一次才 fetch
  aircraftEntries: null,
  suggest: { tail_nos: [], aircraft_types: [], airports: [] },
  editing: null,                 // entry being edited
  initialized: false,
  tab: 'logbook',                // 底部主功能列：analyze | logbook | report
  reportFrom: null,              // Report 區間總表的起日（YYYY-MM-DD），null = 今年初
  reportTo: null,                // Report 區間總表的迄日，null = 今天
  selectedId: null,              // iPad 分割視窗：目前在 detail pane 開的那筆 entry id
};

var _PL_LS_AT = 'pilotlog_at';
var _PL_LS_RT = 'pilotlog_rt';
var _PL_LS_UID = 'pilotlog_uid';
var _PL_LS_EMAIL = 'pilotlog_email';

function _plLoadSession() {
  try {
    _pl.accessToken = localStorage.getItem(_PL_LS_AT);
    _pl.refreshToken = localStorage.getItem(_PL_LS_RT);
    var uid = localStorage.getItem(_PL_LS_UID);
    var email = localStorage.getItem(_PL_LS_EMAIL);
    if (uid) _pl.user = { id: uid, primaryEmail: email || '' };
  } catch (e) {}
}

function _plSaveSession(s) {
  try {
    localStorage.setItem(_PL_LS_AT, s.accessToken);
    localStorage.setItem(_PL_LS_RT, s.refreshToken);
    localStorage.setItem(_PL_LS_UID, s.userId);
    if (s.primaryEmail) localStorage.setItem(_PL_LS_EMAIL, s.primaryEmail);
  } catch (e) {}
  _pl.accessToken = s.accessToken;
  _pl.refreshToken = s.refreshToken;
  _pl.user = { id: s.userId, primaryEmail: s.primaryEmail };
}

function _plClearSession() {
  try {
    localStorage.removeItem(_PL_LS_AT);
    localStorage.removeItem(_PL_LS_RT);
    localStorage.removeItem(_PL_LS_UID);
    localStorage.removeItem(_PL_LS_EMAIL);
  } catch (e) {}
  _pl.accessToken = null;
  _pl.refreshToken = null;
  _pl.user = null;
  // V1.2：把 IDB 的 user 一起清掉，否則下次 init _plCacheLoadAll 又把 user 撈回來、
  // 形成「看起來登入但 token 都沒了 → 401 → resurrect → 又 401」的死循環（codex P1 衍生）
  if (typeof _plIDBSet === 'function') _plIDBSet('user', null);
}

// === SECTION: chrome（底部 tab / 日夜 / 字級）═══════════════════════════════
// 全部沿用 CrewSync / 晨報 的 pattern：data-theme + font-scale 存 localStorage、純本機。
// 早期 FOUC 防護在 shell <head> 的 inline script 先套用；這裡只負責切換 + 圖示同步。

var _plFontScale = (function() {
  try { var s = parseInt(localStorage.getItem('pilotlog_font_scale'), 10);
    return (s >= -2 && s <= 17) ? s : 0; } catch (e) {} return 0;
})();

function _plAdjustFontSize(dir) {
  _plFontScale = Math.max(-2, Math.min(17, _plFontScale + dir)); // -2..17 = 20 段
  document.documentElement.style.fontSize = (100 + _plFontScale * 8) + '%';
  try { localStorage.setItem('pilotlog_font_scale', String(_plFontScale)); } catch (e) {}
}

function _plToggleTheme() {
  var html = document.documentElement;
  var icon = document.getElementById('pl-theme-icon');
  if (html.dataset.theme === 'light') {
    delete html.dataset.theme;
    if (icon) icon.textContent = '☀️';
    try { localStorage.setItem('pilotlog_theme', 'dark'); } catch (e) {}
  } else {
    html.dataset.theme = 'light';
    if (icon) icon.textContent = '🌙';
    try { localStorage.setItem('pilotlog_theme', 'light'); } catch (e) {}
  }
}

// 載入時把主題圖示對齊目前狀態（FOUC script 只設了 data-theme，沒動圖示）
(function() {
  try {
    if (localStorage.getItem('pilotlog_theme') === 'light') {
      var i = document.getElementById('pl-theme-icon');
      if (i) i.textContent = '🌙';
    }
  } catch (e) {}
})();

function _plShowTabBar(show) {
  var bar = document.getElementById('pl-tab-bar');
  if (bar) bar.style.display = show ? 'flex' : 'none';
}

// 寬螢幕（iPad/桌機）判斷：跟 CSS .pl-split 的 media query 對齊。
// 用 matchMedia 即時讀，旋轉/視窗變動下次點擊就對。
function _plWide() {
  try { return window.matchMedia('(min-width: 768px)').matches; } catch (e) { return false; }
}

function _plDetailPlaceholder() {
  return '<div class="pl-detail-empty">' +
    '← 從左側選一筆航班看明細<br>' +
    'Select a flight on the left to view details' +
  '</div>';
}

function _plHighlightTab(tab) {
  ['analyze', 'logbook', 'report'].forEach(function(t) {
    var b = document.getElementById('plTabBtn-' + t);
    if (b) b.classList.toggle('pl-tab-active', t === tab);
  });
}

// 底部三顆主功能切換。Logbook 內的 editor/import/aircraft/crew 都是 Logbook 的 sub-view，
// 切 tab 一律先丟掉編輯中的草稿狀態回到該 tab 的頂層。
function switchPlTab(tab, btn) {
  if (!_pl.user) return;            // 未登入時 tab bar 是藏的，保險再擋一次
  _pl.tab = tab;
  _pl.editing = null;
  _pl.selectedId = null;            // 切走 logbook，detail pane 的選取就重置
  _plHighlightTab(tab);
  if (tab === 'analyze') _plRenderAnalyze();
  else if (tab === 'report') _plRenderReport();
  else _plRenderMain();
  window.scrollTo(0, 0);
}

// === SECTION: cache + offline（V1.2）═══════════════════════════════════════
// 解 iOS PWA 在 7 天無互動清掉 localStorage 把飛行員踢回登入頁的問題。
// (1) Refresh token 後端用 HttpOnly cookie，iOS 對 cookie 比 localStorage 寬容。
// (2) 拉到的資料寫一份 IDB（容量比 localStorage 大、iOS 保護較好）；
//     下次打開先用 IDB 立刻 render，網路掛了還能看上次同步的 logbook。
// (3) 啟動時 navigator.storage.persist() 申請 persistent storage（iOS 不保證，但延長保留）。

var _PL_DB_NAME = 'pilotlog';
var _PL_DB_VER = 1;
var _PL_DB_STORE = 'cache';

function _plIDB() {
  return new Promise(function(resolve, reject) {
    try {
      var req = indexedDB.open(_PL_DB_NAME, _PL_DB_VER);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(_PL_DB_STORE)) db.createObjectStore(_PL_DB_STORE);
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function() { reject(req.error); };
    } catch (e) { reject(e); }
  });
}

function _plIDBSet(key, val) {
  return _plIDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(_PL_DB_STORE, 'readwrite');
      tx.objectStore(_PL_DB_STORE).put(val, key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }).catch(function() {});      // 隱私模式 / quota 全滿就靜默不擋主流程
}

function _plIDBGet(key) {
  return _plIDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(_PL_DB_STORE, 'readonly');
      var r = tx.objectStore(_PL_DB_STORE).get(key);
      r.onsuccess = function() { resolve(r.result); };
      r.onerror = function() { reject(r.error); };
    });
  }).catch(function() { return undefined; });
}

function _plRequestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function() {});
    }
  } catch (e) {}
}

// 寫所有當前 _pl 拉到的資料進 IDB（網路 fetch 成功後呼叫）
function _plCacheSaveAll() {
  _plIDBSet('entries', _pl.entries);
  _plIDBSet('filter', _pl.filter);          // 跟 entries 配對存：entries 是當下 filter 的子集，
                                            // 不存 filter 的話下次離線開、UI 預設 'all' 但資料只有 draft 會嚴重誤導（codex P3）
  _plIDBSet('stats', _pl.stats);
  _plIDBSet('aircraft', _pl.aircraft);
  _plIDBSet('aircraftTypes', _pl.aircraftTypes);
  _plIDBSet('crew', _pl.crew);
  _plIDBSet('suggest', _pl.suggest);
  _plIDBSet('user', _pl.user);
}
function _plCacheSaveAircraftEntries() {
  if (_pl.aircraftEntries) _plIDBSet('aircraftEntries', _pl.aircraftEntries);
}

// 從 IDB 撈回填 _pl；回傳是否有任何快取（用來判斷「曾經登入過」）
async function _plCacheLoadAll() {
  var keys = ['entries', 'stats', 'aircraft', 'aircraftTypes', 'crew', 'suggest', 'aircraftEntries', 'user', 'filter'];
  var vals = await Promise.all(keys.map(_plIDBGet));
  var any = false;
  if (vals[0]) { _pl.entries = vals[0]; any = true; }
  if (vals[1]) { _pl.stats = vals[1]; any = true; }
  if (vals[2]) { _pl.aircraft = vals[2]; any = true; }
  if (vals[3]) { _pl.aircraftTypes = vals[3]; any = true; }
  if (vals[4]) { _pl.crew = vals[4]; any = true; }
  if (vals[5]) { _pl.suggest = vals[5]; any = true; }
  if (vals[6]) { _pl.aircraftEntries = vals[6]; any = true; }
  if (vals[7] && !_pl.user) { _pl.user = vals[7]; any = true; }
  if (vals[8]) { _pl.filter = vals[8]; }    // 把 filter 還原成跟快取 entries 配對的值（codex P3）
  return any;
}

// 切離線/連線狀態 — 控制頂部 OFFLINE 提示條
function _plSetOffline(off) {
  var bar = document.getElementById('pl-offline-bar');
  if (bar) bar.classList.toggle('show', !!off);
  document.body.classList.toggle('pl-offline', !!off);
}

// === SECTION: utils ═════════════════════════════════════════════════════════
function _plMinToHHMM(min) {
  if (min == null || isNaN(min)) return '';
  var h = Math.floor(min / 60), m = min % 60;
  return h + ':' + (m < 10 ? '0' : '') + m;
}

function _plParseHHMM(s) {
  if (!s) return null;
  var m = String(s).match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  var mm = parseInt(m[2], 10);
  if (mm > 59) return null;
  return parseInt(m[1], 10) * 60 + mm;
}

function _plFmtDate(s) {
  if (!s) return '';
  return String(s).slice(0, 10);
}

function _plFmtUtcHHMM(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var h = d.getUTCHours(), m = d.getUTCMinutes();
  return (h < 10 ? '0' : '') + h + (m < 10 ? '0' : '') + m;
}

// HHMM (UTC) + flight_date → ISO
function _plMakeUtcIso(dateStr, hhmm) {
  if (!dateStr || !hhmm) return null;
  if (!/^\d{4}$/.test(hhmm)) return null;
  return dateStr + 'T' + hhmm.slice(0, 2) + ':' + hhmm.slice(2) + ':00Z';
}

function _plEsc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}

function _plToast(msg, kind) {
  var bg = kind === 'error' ? '#ef4444' : (kind === 'warn' ? '#f59e0b' : '#10b981');
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:' + bg +
    ';color:#fff;padding:10px 16px;border-radius:8px;font-size:.85em;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.3)';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.remove(); }, 3000);
}

async function _plApi(path, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  if (_pl.accessToken) opts.headers['Authorization'] = 'Bearer ' + _pl.accessToken;
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  var res = await fetch(path, opts);
  if (res.status === 401 && _pl.refreshToken) {
    var ok = await _plTryRefresh();
    if (ok) {
      opts.headers['Authorization'] = 'Bearer ' + _pl.accessToken;
      res = await fetch(path, opts);
    }
  }
  return res;
}

// === SECTION: auth ══════════════════════════════════════════════════════════
async function _plLoadConfig() {
  if (_pl.clientId) return _pl.clientId;
  try {
    var r = await fetch('/api/pilot-log/config');
    var j = await r.json();
    _pl.clientId = j.google_client_id;
    return _pl.clientId;
  } catch (e) {
    return null;
  }
}

function _plLoadGisScript() {
  if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
  if (window._plGisLoading) return window._plGisLoading;
  window._plGisLoading = new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = resolve;
    s.onerror = function() { reject(new Error('gis_load_failed')); };
    document.head.appendChild(s);
  });
  return window._plGisLoading;
}

async function _plInitSignIn() {
  var clientId = await _plLoadConfig();
  if (!clientId) {
    _plToast('Google client_id 載入失敗', 'error');
    return;
  }
  await _plLoadGisScript();
  google.accounts.id.initialize({
    client_id: clientId,
    callback: _plOnGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  var btnHost = document.getElementById('pl-gsi-btn');
  if (btnHost) {
    btnHost.innerHTML = '';
    google.accounts.id.renderButton(btnHost, {
      theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill', logo_alignment: 'left',
    });
  }
}

async function _plOnGoogleCredential(response) {
  if (!response || !response.credential) return;
  var r = await fetch('/api/pilot-log/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: response.credential }),
  });
  if (!r.ok) {
    _plToast('登入失敗', 'error');
    return;
  }
  var j = await r.json();
  _plSaveSession(j);
  _plToast('登入成功 — ' + (j.primaryEmail || ''));
  _plRenderMain();
}

// 並發保護：同一時間只允許一個 refresh 在跑，其他 caller 共用同一個 promise。
// 過去的問題：_plFetchAll() 用 Promise.all 同時打 4 個 API，access token 過期時 4 個並發
// 各自呼叫 _plTryRefresh()，server rotation 後第一個成功、後 3 個拿著已作廢的 refresh token
// 全部失敗。任何一個失敗的 race-loser 都會觸發 _plClearSession() → 把已成功更新的 session
// 清掉、誤把使用者登出。改成 singleton 後只發一次 refresh，沒有 race，沒有誤清。
var _plRefreshPromise = null;

async function _plTryRefresh() {
  // V1.2：拿掉「沒 refreshToken 就 fail」的早退，讓 cookie-only 流程也能跑 —
  // localStorage 被 iOS 清掉時，HttpOnly cookie 還在，空 body 送出去、cookie 自動附上、
  // server 端會用 cookie 認，回新 token 把 session 復活。
  if (_plRefreshPromise) return _plRefreshPromise;
  _plRefreshPromise = (async () => {
    try {
      var body = _pl.refreshToken ? { refreshToken: _pl.refreshToken } : {};
      var r = await fetch('/api/pilot-log/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',     // 明示 cookie 隨行（同源預設值，留下意圖紀錄）
        body: JSON.stringify(body),
      });
      if (r.ok) {
        var j = await r.json();
        _plSaveSession(j);
        return true;
      }
      // 401 = server 確認 refresh token + cookie 都失效 → 清 session 強制重登
      // 其他（5xx 服務暫時不可用 / 網路錯誤）= 暫時性失敗，不清 session，下次再試
      if (r.status === 401) _plClearSession();
      return false;
    } catch (e) {
      // 網路錯誤等暫時性失敗 → 保留 session，下次再試
      return false;
    } finally {
      _plRefreshPromise = null;
    }
  })();
  return _plRefreshPromise;
}

async function _plLogout() {
  if (_pl.refreshToken) {
    try {
      await fetch('/api/pilot-log/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: _pl.refreshToken }),
      });
    } catch (e) {}
  }
  _plClearSession();
  _plRender();
}

// 永久刪除帳號（Apple App Store 5.1.1(v) 強制要求 in-app 刪帳號功能）
// CASCADE 會清掉 emails / sessions / log entries / aircraft，無法復原
async function _plDeleteAccount() {
  var msg1 = '⚠️ 永久刪除你的帳號？\n\n' +
             '會一起清掉：\n' +
             '• 全部飛行記錄 entries\n' +
             '• 機尾資料 (Aircraft)\n' +
             '• 全部登入 sessions\n\n' +
             '此動作無法復原。\n\n' +
             '— — —\n\n' +
             'Permanently delete your account? All flight records, aircraft data, and sessions will be erased. This cannot be undone.';
  if (!confirm(msg1)) return;
  var msg2 = '最後確認：真的要刪除整個帳號嗎？\n\nFinal confirm: are you sure you want to delete the entire account?';
  if (!confirm(msg2)) return;
  try {
    var res = await _plApi('/api/pilot-log/account', { method: 'DELETE' });
    if (res.status === 204) {
      _plClearSession();
      alert('帳號已刪除\nAccount deleted');
      _plRender();
      return;
    }
    var j = {};
    try { j = await res.json(); } catch (e) {}
    alert('刪除失敗 Delete failed: ' + (j.error || 'HTTP ' + res.status));
  } catch (e) {
    alert('刪除失敗 Delete failed: ' + (e && e.message ? e.message : 'unknown'));
  }
}

// === SECTION: list ══════════════════════════════════════════════════════════
// V1.2：網路失敗時 catch 起來、保留現有 _pl 資料（可能來自 IDB 快取）、設 OFFLINE 旗標；
// 不讓網路掛掉的 throw 把 caller 炸掉。成功時順手寫一份進 IDB。
async function _plFetchAll() {
  var q = '';
  if (_pl.filter !== 'all') q = '?status=' + _pl.filter;
  try {
    var [eRes, sRes, aRes, qRes, atRes, cRes] = await Promise.all([
      _plApi('/api/pilot-log/entries' + q),
      _plApi('/api/pilot-log/stats'),
      _plApi('/api/pilot-log/aircraft'),
      _plApi('/api/pilot-log/quick-suggest'),
      _plApi('/api/pilot-log/aircraft-types'),  // V1.0.11
      _plApi('/api/pilot-log/crew'),            // V1.0.11
    ]);
    if (eRes.ok) { var ej = await eRes.json(); _pl.entries = ej.entries || []; }
    if (sRes.ok) { _pl.stats = await sRes.json(); }
    if (aRes.ok) { var aj = await aRes.json(); _pl.aircraft = aj.aircraft || []; }
    if (qRes.ok) { _pl.suggest = await qRes.json(); }
    if (atRes.ok) { var atj = await atRes.json(); _pl.aircraftTypes = atj.aircraft_types || []; }
    if (cRes.ok) { var cj = await cRes.json(); _pl.crew = cj.crew || []; }
    // codex fast P1：fetch 過程中如果 token 過期 + refresh/cookie 真的失效，_plApi 內部會清
    // session（_pl.user=null）。此時不能假裝成功，否則 caller 會繼續顯示「沒授權但有快取」的 stale UI。
    if (!_pl.user) {
      _plSetOffline(false);
      return false;
    }
    _plCacheSaveAll();
    _plSetOffline(false);
    return true;
  } catch (e) {
    _plSetOffline(true);
    return false;
  }
}

function _plRenderStats() {
  var s = _pl.stats;
  if (!s) return '';
  var t = s.totals || {};
  var r = s.rolling || {};
  var by = s.by_type || [];
  function box(label, mins, count) {
    return '<div style="background:var(--card);border-radius:8px;padding:8px 10px;flex:1;min-width:90px">' +
      '<div style="font-size:.62em;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">' + label + '</div>' +
      '<div style="font-size:1.05em;font-weight:700">' + _plMinToHHMM(mins || 0) + '</div>' +
      (count != null ? '<div style="font-size:.6em;color:var(--muted)">' + count + ' flights</div>' : '') +
      '</div>';
  }
  var rolling = '<div style="display:flex;gap:6px;margin-top:6px">' +
    box('7 day', r.d7 && r.d7.total_minutes, r.d7 && r.d7.entry_count) +
    box('28 day', r.d28 && r.d28.total_minutes, r.d28 && r.d28.entry_count) +
    box('90 day', r.d90 && r.d90.total_minutes, r.d90 && r.d90.entry_count) +
    '</div>';
  var byTypeHtml = '';
  if (by.length) {
    byTypeHtml = '<div style="margin-top:8px;font-size:.7em;color:var(--muted)">By type: ' +
      by.map(function(x) {
        return '<span style="margin-right:8px">' + _plEsc(x.aircraft_type) + ' ' + _plMinToHHMM(x.total_minutes) +
          ' <span style="opacity:.6">(' + x.entry_count + ')</span></span>';
      }).join('') + '</div>';
  }
  return '<div style="background:rgba(255,255,255,.03);border-radius:10px;padding:10px;margin-bottom:10px">' +
    '<div style="display:flex;gap:6px">' +
      box('Total', t.total_minutes, t.entry_count) +
      box('PIC', t.pic_minutes) +
      box('SIC', t.sic_minutes) +
      box('Night', t.night_minutes) +
    '</div>' + rolling + byTypeHtml + '</div>';
}

function _plRenderToolbar() {
  var filterBtn = function(val, label) {
    var active = _pl.filter === val;
    return '<button onclick="_plSetFilter(\'' + val + '\')" style="background:' +
      (active ? 'var(--accent,#3b82f6)' : 'transparent') + ';color:' +
      (active ? '#fff' : 'var(--text)') + ';border:1px solid var(--border,#334155);' +
      'border-radius:6px;padding:4px 10px;font-size:.75em;cursor:pointer;margin-right:4px">' + label + '</button>';
  };
  return '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:10px">' +
    '<button onclick="_plOpenEditor(null)" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.8em;font-weight:700;cursor:pointer">+ New Entry</button>' +
    '<button onclick="_plOpenImport()" style="background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.8em;font-weight:700;cursor:pointer">📥 Import</button>' +
    '<button onclick="_plOpenAircraft()" style="background:#0ea5e9;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.8em;font-weight:700;cursor:pointer">✈️ Aircraft</button>' +
    '<button onclick="_plOpenCrew()" style="background:#a855f7;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.8em;font-weight:700;cursor:pointer">👥 Crew</button>' +
    '<div style="flex:1"></div>' +
    filterBtn('all', 'All') + filterBtn('draft', 'Draft') +
    filterBtn('confirmed', 'Confirmed') + filterBtn('roster_removed', 'Removed') +
    '<button onclick="_plLogout()" style="background:transparent;color:var(--muted);border:0;font-size:.7em;cursor:pointer;margin-left:8px">Logout</button>' +
    '</div>';
}

// LogTen Pro 風格的密集 4 行卡：
//   line 1：起飛HHMM ──飛時/sched── 落地HHMM（中間用一條線連起來）
//   line 2：大字 ORIGIN ............... DEST
//   line 3：✈ 機尾, 機型 ............... Flt JX001
//   line 4：組員姓名（單行省略）
// 左側保留狀態色條（draft/confirmed/roster_removed）+ 大日期區。
// 被選中（iPad detail pane 開著的那筆）會套 .pl-row-sel 描邊。
var _PL_MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function _plRenderEntryRow(e) {
  var statusColor = { draft: '#f59e0b', confirmed: '#10b981', roster_removed: '#94a3b8' }[e.status] || '#94a3b8';

  // 日期：拆 day / MON 'YY
  var ds = String(e.flight_date || '').slice(0, 10);
  var dayNum = '', monthYr = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
    var p = ds.split('-');
    dayNum = p[2];
    monthYr = _PL_MON[parseInt(p[1], 10) - 1] + " '" + p[0].slice(2);
  }

  // 起降時間 + 中段標籤
  var dep = '', arr = '', mid = '';
  if (e.out_utc && e.in_utc) {
    dep = _plFmtUtcHHMM(e.out_utc); arr = _plFmtUtcHHMM(e.in_utc);
    mid = e.block_minutes ? _plMinToHHMM(e.block_minutes) + ' hrs' : '';
  } else if (e.std_utc && e.sta_utc) {
    dep = _plFmtUtcHHMM(e.std_utc); arr = _plFmtUtcHHMM(e.sta_utc);
    mid = (e.block_minutes ? _plMinToHHMM(e.block_minutes) + ' ' : '') + 'sched';
  } else {
    mid = e.block_minutes ? _plMinToHHMM(e.block_minutes) + ' hrs' : '—';
  }

  // line 3 機尾/機型 + Flt#
  var acIcon = (e.out_utc && e.in_utc) ? '✈' : '🛠';
  var acMeta = acIcon + ' ' + _plEsc(e.tail_no || '') + (e.aircraft_type ? ', ' + _plEsc(e.aircraft_type) : '');
  var fltNo = e.flight_no ? 'Flt ' + _plEsc(e.flight_no) : '';

  // line 4 組員
  var crewNames = '';
  try { crewNames = _plEntryCrewNames(e).join(', '); } catch (_e) {}

  var selCls = (_pl.selectedId === e.id) ? ' pl-row-sel' : '';
  var times = '<div style="display:flex;align-items:center;gap:8px;font-size:.72em;color:var(--muted)">' +
    '<span style="min-width:34px">' + dep + '</span>' +
    '<span style="flex:1;display:flex;align-items:center;gap:8px;min-width:0">' +
      '<span style="flex:1;height:1px;background:var(--border)"></span>' +
      '<span style="white-space:nowrap">' + mid + '</span>' +
      '<span style="flex:1;height:1px;background:var(--border)"></span>' +
    '</span>' +
    '<span style="min-width:34px;text-align:right">' + arr + '</span>' +
  '</div>';

  var airports = '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
    '<span style="font-size:1.35em;font-weight:800;letter-spacing:.5px">' + _plEsc(e.origin || '???') + '</span>' +
    '<span style="font-size:1.35em;font-weight:800;letter-spacing:.5px">' + _plEsc(e.dest || '???') + '</span>' +
  '</div>';

  var meta = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:.7em;color:var(--muted)">' +
    '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">' + acMeta + '</span>' +
    '<span style="white-space:nowrap">' + fltNo + '</span>' +
  '</div>';

  var crewLine = crewNames
    ? '<div style="font-size:.7em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _plEsc(crewNames) + '</div>'
    : '';

  return '<div class="pl-row' + selCls + '" onclick="_plOpenEditor(\'' + e.id + '\')" ' +
    'style="background:var(--card);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;display:flex;gap:12px;align-items:stretch">' +
    '<div style="flex:0 0 4px;background:' + statusColor + ';border-radius:3px"></div>' +
    '<div style="flex:0 0 50px;padding-top:1px">' +
      '<div style="font-size:1.85em;font-weight:800;line-height:.9">' + dayNum + '</div>' +
      '<div style="font-size:.58em;color:var(--muted);margin-top:3px;letter-spacing:.5px;white-space:nowrap">' + monthYr + '</div>' +
    '</div>' +
    '<div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px">' +
      times + airports + meta + crewLine +
    '</div>' +
  '</div>';
}

function _plRenderList() {
  var c = document.getElementById('pl-list');
  if (!c) return;
  if (_pl.entries.length === 0) {
    c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">' +
      (_pl.filter === 'all'
        ? '尚無紀錄。點 <b>+ New Entry</b> 新增，或 <b>📥 Import</b> 匯入 LogTen Pro 資料。<br>No entries yet — tap <b>+ New Entry</b>, or <b>📥 Import</b> your LogTen Pro data.'
        : '此分類無紀錄。<br>No entries in this filter.') +
    '</div>';
    return;
  }
  c.innerHTML = _pl.entries.map(_plRenderEntryRow).join('');
}

async function _plSetFilter(f) {
  _pl.filter = f;
  // iPad split view 編輯中：filter 只刷 list + toolbar 高亮，不重建整個 Logbook，
  // 否則會把右側 editor DOM 連同未存的修改一起清掉（codex deep P2-1）。
  if (_pl.editing && _plWide() && document.getElementById('pl-detail-pane')) {
    await _plFetchAll();
    var tb = document.getElementById('pl-toolbar');
    if (tb) tb.innerHTML = _plRenderToolbar();
    _plRenderList();
    return;
  }
  await _plRefreshMain();
}

async function _plRefreshMain() {
  await _plFetchAll();
  _plRenderMain();
}

// Logbook tab：航班清單 + toolbar（New / Import / Aircraft / Crew）+ 篩選。
// 統計已搬到 Analyze tab。
// iPad（>=768px）：底下用 .pl-split 並排左列表 + 右明細（master-detail）；
// iPhone（<768px）：detail-pane CSS 藏起來，列表撐滿、點一筆走 _plOpenEditor 全螢幕。
function _plRenderMain() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (!_pl.user) { _plRenderLogin(); return; }
  _plShowTabBar(true);
  _plHighlightTab('logbook');
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<div style="font-size:1em;font-weight:700">📒 Logbook</div>' +
        '<div style="font-size:.65em;color:var(--muted)">' + _plEsc(_pl.user.primaryEmail || '') + '</div>' +
      '</div>' +
      '<div id="pl-toolbar">' + _plRenderToolbar() + '</div>' +
      '<div class="pl-split">' +
        '<div class="pl-list-pane"><div id="pl-list"></div></div>' +
        '<div class="pl-detail-pane" id="pl-detail-pane">' + _plDetailPlaceholder() + '</div>' +
      '</div>' +
    '</div>';
  _plRenderList();
}

function _plRenderLogin() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  _plShowTabBar(false);
  c.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;gap:14px">' +
      '<div style="font-size:2.5em">📒</div>' +
      '<div style="font-size:1.1em;font-weight:700">Pilot Log</div>' +
      '<div style="font-size:.78em;color:var(--muted);max-width:340px;line-height:1.5">' +
        '飛行記錄本：跨裝置、永久保存。<br>用 Google 帳號登入即可開始；換公司也能繼續用同一本 logbook。' +
      '</div>' +
      '<div id="pl-gsi-btn" style="margin-top:8px"></div>' +
    '</div>';
  _plInitSignIn();
}

// === SECTION: editor ════════════════════════════════════════════════════════
function _plBlankEntry() {
  var today = new Date();
  var iso = today.toISOString().slice(0, 10);
  return {
    id: null, status: 'draft', source: 'manual',
    flight_date: iso, flight_no: '', origin: '', dest: '',
    aircraft_type: '', tail_no: '', position: 'PIC', pilot_flying: false,
    std_utc: null, sta_utc: null, out_utc: null, off_utc: null, on_utc: null, in_utc: null,
    block_minutes: null, air_minutes: null, night_minutes: null,
    distance_nm: null, on_duty_utc: null, off_duty_utc: null, total_duty_minutes: null,
    crew: {}, approaches: [],
    day_takeoffs: 0, night_takeoffs: 0, day_landings: 0, night_landings: 0, autolands: 0,
    pax_count: null, sid: '', star: '', remarks: '',
  };
}

function _plOpenEditor(id) {
  if (id) {
    // 先從主頁 list 找；找不到再退回 Aircraft 頁的完整快照
    // （Aircraft detail 顯示的 row 可能不在 _pl.entries 主頁清單裡 — 主頁 filter 篩掉、
    //  或在 200 limit 之外。沒有這個 fallback，使用者點下去會無聲無息打不開）
    var e = _pl.entries.filter(function(x) { return x.id === id; })[0];
    if (!e && _pl.aircraftEntries) {
      e = _pl.aircraftEntries.filter(function(x) { return x.id === id; })[0];
    }
    if (!e) return;
    _pl.editing = JSON.parse(JSON.stringify(e));
    if (!_pl.editing.crew) _pl.editing.crew = {};
    if (!_pl.editing.approaches) _pl.editing.approaches = [];
  } else {
    _pl.editing = _plBlankEntry();
    if (_pl.aircraft.length) {
      _pl.editing.tail_no = _pl.aircraft[0].tail_no;
      _pl.editing.aircraft_type = _pl.aircraft[0].type_code;
    }
  }
  // iPad（>=768px）且 logbook 的右明細面板存在 → render 到右側、列表保留；
  // 否則（iPhone、或 Aircraft/Crew detail 等場景）→ 全螢幕（原行為）
  _pl.selectedId = id || null;
  if (_plWide() && document.getElementById('pl-detail-pane')) {
    _plRenderEditor('pl-detail-pane');
    _plRenderList();                    // 重畫列表套用 .pl-row-sel highlight
  } else {
    _plRenderEditor();
  }
}

function _plCloseEditor() {
  _pl.editing = null;
  _pl.selectedId = null;
  // iPad split：清右側回 placeholder + 重畫列表去掉 highlight；列表保持原位不重 fetch
  if (_plWide() && document.getElementById('pl-detail-pane')) {
    document.getElementById('pl-detail-pane').innerHTML = _plDetailPlaceholder();
    _plRenderList();
    return;
  }
  _plRenderMain();
}

function _plEditorField(label, name, type, opts) {
  opts = opts || {};
  var e = _pl.editing;
  var val = e[name];
  if (val == null) val = '';
  var attrs = 'id="ple-' + name + '" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em"';
  var input;
  if (type === 'time-utc') {
    input = '<input ' + attrs + ' value="' + _plEsc(_plFmtUtcHHMM(val)) + '" placeholder="HHMM UTC" maxlength="4">';
  } else if (type === 'hhmm-dur') {
    input = '<input ' + attrs + ' value="' + _plEsc(_plMinToHHMM(val)) + '" placeholder="H:MM">';
  } else if (type === 'select') {
    var optsHtml = (opts.options || []).map(function(o) {
      return '<option value="' + _plEsc(o) + '"' + (val === o ? ' selected' : '') + '>' + _plEsc(o || '—') + '</option>';
    }).join('');
    input = '<select ' + attrs + '>' + optsHtml + '</select>';
  } else if (type === 'check') {
    input = '<label style="display:flex;align-items:center;gap:6px;font-size:.78em"><input type="checkbox" id="ple-' + name + '"' + (val ? ' checked' : '') + '> ' + _plEsc(opts.checkLabel || label) + '</label>';
  } else if (type === 'textarea') {
    input = '<textarea ' + attrs + ' rows="2">' + _plEsc(val) + '</textarea>';
  } else if (type === 'number') {
    input = '<input type="number" ' + attrs + ' value="' + _plEsc(val) + '" step="' + (opts.step || '1') + '">';
  } else if (type === 'date') {
    // 從 server 來的可能是 'YYYY-MM-DD' 純字串、'YYYY-MM-DDTHH:mm:ss.sssZ' ISO，
    // 甚至 PG TIMESTAMPTZ 序列化的 6 位年份 '+0YYYYY-MM-DDT...'。
    // 一律抽前 10 字、必要時清掉非 YYYY-MM-DD 的雜訊。
    var dateStr = String(val || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      // 嘗試從任何 ISO 變體用 Date.parse 還原
      var d = new Date(val);
      if (!isNaN(d.getTime())) {
        var y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
        // 年份若 > 9999 表示資料壞了，留空讓使用者察覺
        dateStr = (y >= 1000 && y <= 9999)
          ? y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (da < 10 ? '0' : '') + da
          : '';
      } else {
        dateStr = '';
      }
    }
    input = '<input ' + attrs + ' value="' + _plEsc(dateStr) + '" placeholder="YYYY-MM-DD" maxlength="10">';
  } else {
    input = '<input ' + attrs + ' value="' + _plEsc(val) + '"' + (opts.placeholder ? ' placeholder="' + _plEsc(opts.placeholder) + '"' : '') + '>';
  }
  if (type === 'check') return '<div style="margin-bottom:8px">' + input + '</div>';
  return '<div style="margin-bottom:8px">' +
    '<div style="font-size:.62em;color:var(--muted);margin-bottom:2px">' + _plEsc(label) + '</div>' +
    input + '</div>';
}

// target：'pilotlog-content'（預設，全螢幕）或 'pl-detail-pane'（iPad 右側明細面板）。
// 兩個目標差別只在 header 的關閉鈕標籤（← 回列表 / ✕ 關閉明細）。
function _plRenderEditor(target) {
  target = target || 'pilotlog-content';
  var c = document.getElementById(target);
  if (!c || !_pl.editing) return;
  var e = _pl.editing;
  var inDetail = (target === 'pl-detail-pane');
  var closeLabel = inDetail ? '✕' : '←';
  var statusBadge = e.id ? (
    '<span style="background:' +
    ({ draft:'#f59e0b', confirmed:'#10b981', roster_removed:'#94a3b8' }[e.status] || '#666') +
    ';color:#fff;border-radius:10px;padding:2px 8px;font-size:.62em;margin-left:8px">' + e.status + '</span>'
  ) : '';

  var typeOptions = ['', 'A321', 'A359', 'A35K', 'B777-300ER', 'B789', 'B78X'].concat(_pl.suggest.aircraft_types || []);
  typeOptions = Array.from(new Set(typeOptions));

  c.innerHTML =
    '<div style="padding:10px 14px">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
      '<button onclick="_plCloseEditor()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">' + closeLabel + '</button>' +
      '<div style="font-size:1em;font-weight:700">' + (e.id ? 'Edit Entry' : 'New Entry') + '</div>' + statusBadge +
      '<div style="flex:1"></div>' +
      (e.id && e.status !== 'confirmed' ? '<button onclick="_plSaveEntry(true)" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Confirm</button>' : '') +
      '<button onclick="_plSaveEntry(false)" style="background:#3b82f6;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Save</button>' +
      (e.id ? '<button onclick="_plDeleteEntry()" style="background:transparent;color:#ef4444;border:1px solid #ef4444;border-radius:6px;padding:6px 10px;font-size:.74em;cursor:pointer">Delete</button>' : '') +
    '</div>' +

    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="grid-column:span 2">' + _plEditorField('Date', 'flight_date', 'date') + '</div>' +
      _plEditorField('Flight #', 'flight_no', 'text') +
      _plEditorField('From (ICAO)', 'origin', 'text') +
      _plEditorField('To (ICAO)', 'dest', 'text') +
      _plEditorField('Aircraft Type', 'aircraft_type', 'select', { options: typeOptions }) +
      _plEditorField('Tail #', 'tail_no', 'text', { placeholder: 'B-58504' }) +
      _plEditorField('Position', 'position', 'select', { options: ['', 'PIC', 'SIC', 'OBSERVER'] }) +
    '</div>' +

    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Times (UTC HHMM)</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px">' +
        _plEditorField('Sched Out', 'std_utc', 'time-utc') +
        _plEditorField('Sched In', 'sta_utc', 'time-utc') +
        _plEditorField('Out', 'out_utc', 'time-utc') +
        _plEditorField('Off', 'off_utc', 'time-utc') +
        _plEditorField('On', 'on_utc', 'time-utc') +
        _plEditorField('In', 'in_utc', 'time-utc') +
        _plEditorField('On Duty', 'on_duty_utc', 'time-utc') +
        _plEditorField('Off Duty', 'off_duty_utc', 'time-utc') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-top:8px">' +
        _plEditorField('Block', 'block_minutes', 'hhmm-dur') +
        _plEditorField('Air', 'air_minutes', 'hhmm-dur') +
        _plEditorField('Night', 'night_minutes', 'hhmm-dur') +
        _plEditorField('Total Duty', 'total_duty_minutes', 'hhmm-dur') +
        _plEditorField('Distance (NM)', 'distance_nm', 'number', { step: '0.1' }) +
      '</div>' +
      _plEditorField('Pilot Flying', 'pilot_flying', 'check', { checkLabel: 'I was the Pilot Flying' }) +
    '</div>' +

    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Take-offs / Landings</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:10px">' +
        _plEditorField('Day T/O', 'day_takeoffs', 'number') +
        _plEditorField('Night T/O', 'night_takeoffs', 'number') +
        _plEditorField('Day Ldg', 'day_landings', 'number') +
        _plEditorField('Night Ldg', 'night_landings', 'number') +
        _plEditorField('Autolands', 'autolands', 'number') +
        _plEditorField('Pax', 'pax_count', 'number') +
      '</div>' +
    '</div>' +

    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Crew (姓名)</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">' +
        '<div><div style="font-size:.62em;color:var(--muted);margin-bottom:2px">PIC</div><input id="ple-crew-pic" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em" value="' + _plEsc((e.crew && e.crew.pic) || '') + '"></div>' +
        '<div><div style="font-size:.62em;color:var(--muted);margin-bottom:2px">SIC</div><input id="ple-crew-sic" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em" value="' + _plEsc((e.crew && e.crew.sic) || '') + '"></div>' +
        '<div><div style="font-size:.62em;color:var(--muted);margin-bottom:2px">FO 1</div><input id="ple-crew-fo1" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em" value="' + _plEsc((e.crew && e.crew.fo1) || '') + '"></div>' +
        '<div><div style="font-size:.62em;color:var(--muted);margin-bottom:2px">FO 2</div><input id="ple-crew-fo2" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em" value="' + _plEsc((e.crew && e.crew.fo2) || '') + '"></div>' +
      '</div>' +
    '</div>' +

    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Other</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">' +
        _plEditorField('SID', 'sid', 'text') +
        _plEditorField('STAR', 'star', 'text') +
      '</div>' +
      _plEditorField('Remarks', 'remarks', 'textarea') +
    '</div>' +

    '<div style="height:30px"></div>' +
    '</div>';
}

function _plReadField(name, type) {
  var el = document.getElementById('ple-' + name);
  if (!el) return undefined;
  var raw = el.type === 'checkbox' ? el.checked : el.value;
  if (type === 'time-utc') {
    var dateEl = document.getElementById('ple-flight_date');
    var dateStr = dateEl ? dateEl.value : null;
    return raw ? _plMakeUtcIso(dateStr, String(raw).trim()) : null;
  }
  if (type === 'hhmm-dur') return raw ? _plParseHHMM(raw) : null;
  if (type === 'number') return raw === '' ? null : Number(raw);
  return raw;
}

async function _plSaveEntry(confirm) {
  var e = _pl.editing;
  if (!e) return;

  var body = {
    flight_date: _plReadField('flight_date'),
    flight_no: _plReadField('flight_no'),
    origin: _plReadField('origin'),
    dest: _plReadField('dest'),
    aircraft_type: _plReadField('aircraft_type'),
    tail_no: _plReadField('tail_no'),
    position: _plReadField('position') || null,
    pilot_flying: !!_plReadField('pilot_flying'),
    std_utc: _plReadField('std_utc', 'time-utc'),
    sta_utc: _plReadField('sta_utc', 'time-utc'),
    out_utc: _plReadField('out_utc', 'time-utc'),
    off_utc: _plReadField('off_utc', 'time-utc'),
    on_utc: _plReadField('on_utc', 'time-utc'),
    in_utc: _plReadField('in_utc', 'time-utc'),
    on_duty_utc: _plReadField('on_duty_utc', 'time-utc'),
    off_duty_utc: _plReadField('off_duty_utc', 'time-utc'),
    block_minutes: _plReadField('block_minutes', 'hhmm-dur'),
    air_minutes: _plReadField('air_minutes', 'hhmm-dur'),
    night_minutes: _plReadField('night_minutes', 'hhmm-dur'),
    total_duty_minutes: _plReadField('total_duty_minutes', 'hhmm-dur'),
    distance_nm: _plReadField('distance_nm', 'number'),
    day_takeoffs: _plReadField('day_takeoffs', 'number') || 0,
    night_takeoffs: _plReadField('night_takeoffs', 'number') || 0,
    day_landings: _plReadField('day_landings', 'number') || 0,
    night_landings: _plReadField('night_landings', 'number') || 0,
    autolands: _plReadField('autolands', 'number') || 0,
    pax_count: _plReadField('pax_count', 'number'),
    sid: _plReadField('sid'),
    star: _plReadField('star'),
    remarks: _plReadField('remarks'),
  };

  var crew = {};
  ['pic', 'sic', 'fo1', 'fo2'].forEach(function(k) {
    var el = document.getElementById('ple-crew-' + k);
    if (el && el.value.trim()) crew[k] = el.value.trim();
  });
  body.crew = crew;

  if (confirm) body.status = 'confirmed';

  var r;
  if (e.id) {
    r = await _plApi('/api/pilot-log/entries/' + e.id, { method: 'PUT', body: body });
  } else {
    if (confirm) body.status = 'confirmed';
    r = await _plApi('/api/pilot-log/entries', { method: 'POST', body: body });
  }
  if (!r.ok) {
    var err = await r.json().catch(function() { return {}; });
    _plToast('Save failed: ' + (err.error || r.status), 'error');
    return;
  }
  _plToast(confirm ? 'Confirmed' : 'Saved');
  _pl.editing = null;
  _pl.selectedId = null;          // iPad detail pane 的選取也清掉，_plRenderMain 會重建成 placeholder
  await _plRefreshMain();
}

async function _plDeleteEntry() {
  var e = _pl.editing;
  if (!e || !e.id) return;
  if (!window.confirm('Delete this entry?')) return;
  var r = await _plApi('/api/pilot-log/entries/' + e.id, { method: 'DELETE' });
  if (!r.ok) { _plToast('Delete failed', 'error'); return; }
  _plToast('Deleted');
  _pl.editing = null;
  _pl.selectedId = null;
  await _plRefreshMain();
}

// === SECTION: import ════════════════════════════════════════════════════════
function _plOpenImport() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  c.innerHTML =
    '<div style="padding:20px;max-width:600px;margin:0 auto">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
      '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
      '<div style="font-size:1em;font-weight:700">Import LogTen Pro</div>' +
    '</div>' +
    '<div style="background:var(--card);border-radius:10px;padding:14px;margin-bottom:12px">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">✈️ Flights · Tab 動態匯出 / Dynamic Export</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'LogTen Pro 6 → File → Export → Dynamic Export Flights (Tab)。<br>' +
        '必填欄位 / Required columns：Date / Flight # / From / To / Aircraft Type / Aircraft ID / Out / In / On Duty / Off Duty / PIC/P1 / SIC/P2。' +
      '</div>' +
      '<input type="file" id="pl-flights-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button onclick="_plUploadFlights(true)" style="background:#475569;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">🔍 Preview (dry-run)</button>' +
        '<button onclick="_plUploadFlights(false)" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Import</button>' +
      '</div>' +
      '<div style="font-size:.65em;color:var(--muted);margin-top:6px">建議先 Preview 確認每筆都解析正常，再按 Import。<br>Run Preview first to confirm every row parses, then Import.</div>' +
    '</div>' +
    '<div style="background:var(--card);border-radius:10px;padding:14px;margin-bottom:12px">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">🛩️ Aircraft · 機尾庫 / Tail registry（LogTen Aircraft）</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        '⚠️ 是 LogTen 的 <b>Aircraft</b> export（每筆有機號），<b>不是 Aircraft Types</b>。<br>' +
        'This is the LogTen <b>Aircraft</b> export (each row has a tail #), <b>not Aircraft Types</b>.<br>' +
        '建你的機尾庫，新增 entry 時 tail # 可自動帶 operator/type/notes。<br>' +
        'Builds your tail registry so new entries auto-fill operator/type/notes from the tail #.<br>' +
        '必填欄位 / Required columns：Aircraft ID / Operator / Type。' +
      '</div>' +
      '<input type="file" id="pl-aircraft-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<button onclick="_plUploadAircraft()" style="margin-left:8px;background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Upload</button>' +
    '</div>' +
    '<div style="background:var(--card);border-radius:10px;padding:14px;margin-bottom:12px">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">🧭 Aircraft Types · 機型目錄 / Type catalog（LogTen Aircraft Types）</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        '⚠️ 是 LogTen 的 <b>Aircraft Types</b> export（type 為主、無機號），<b>跟上面 Aircraft 不同檔</b>。<br>' +
        'This is the LogTen <b>Aircraft Types</b> export (type-centric, no tail #), <b>a different file from Aircraft above</b>.<br>' +
        '建你的機型目錄，Aircraft 列表 / drill-down 會顯示完整廠商機型（例：A359 → Airbus A-350-900）。<br>' +
        'Builds your type catalog so the Aircraft list / drill-down shows full make/model (e.g. A359 → Airbus A-350-900).<br>' +
        '必填欄位 / Required：Type。Make / Model / Engine Type / Category / Class / Notes 皆選填 / optional。' +
      '</div>' +
      '<input type="file" id="pl-aircraft-types-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<button onclick="_plUploadAircraftTypes()" style="margin-left:8px;background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Upload</button>' +
    '</div>' +
    '<div style="background:var(--card);border-radius:10px;padding:14px">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">👥 Address Book · Tab 匯出 / export（選用 optional）</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'LogTen Pro → File → Export → Address Book Tab。匯入 crew 名單（含 pilots 與 cabin crew）供日後篩選 / 查同事飛過的航班。<br>' +
        'Imports the crew roster (pilots and cabin crew) for later filtering and shared-flight lookup.<br>' +
        '必填欄位 / Required：Name / ID / This is Me。「This is Me=1」自動標記成你本人，每位 user 只能有一筆 self。<br>' +
        '“This is Me=1” marks the row as yourself; only one self per user.' +
      '</div>' +
      '<input type="file" id="pl-addressbook-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<button onclick="_plUploadAddressBook()" style="margin-left:8px;background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Upload</button>' +
    '</div>' +
    '<div id="pl-import-result" style="margin-top:14px"></div>' +
    '<div style="background:rgba(127,29,29,.2);border:1px solid #7f1d1d;border-radius:10px;padding:14px;margin-top:24px">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px;color:#fca5a5">⚠️ Danger Zone</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        '一鍵砍掉你<b>所有 LogTen 來源</b>的 entries（manual / roster 來源不動、機尾庫不動）。匯入失敗或想完全重來時用。<br>' +
        'Deletes <b>all LogTen-sourced</b> entries (manual / roster entries and the tail registry are untouched). Use after a botched import or to start over. <strong style="color:#fca5a5">不可復原 / Cannot be undone.</strong>' +
      '</div>' +
      '<button onclick="_plWipeLogten()" style="background:#dc2626;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">🗑️ Wipe all my LogTen entries</button>' +
    '</div>' +
    '</div>';
}

async function _plWipeLogten() {
  // 兩段 confirm
  if (!window.confirm('真的要砍掉所有 LogTen 來源的 entries 嗎？\n（manual / roster 來源不會動）')) return;
  if (!window.confirm('再確認一次。這個動作不可復原。\n按 OK 才會真的執行。')) return;

  var r = await _plApi('/api/pilot-log/entries?source=logten&confirm=true', { method: 'DELETE' });
  if (!r.ok) {
    var err = await r.json().catch(function() { return {}; });
    _plToast('砍除失敗：' + (err.error || r.status), 'error');
    return;
  }
  var j = await r.json();
  _plToast('已砍除 ' + (j.deleted || 0) + ' 筆 LogTen entries');
  // 清掉 import 介面殘留的結果，並回 main view 讓 list 重新 fetch
  var resBox = document.getElementById('pl-import-result');
  if (resBox) resBox.innerHTML = '';
  await _plRefreshMain();
}

async function _plUploadFile(inputId, endpoint) {
  var input = document.getElementById(inputId);
  if (!input || !input.files || !input.files[0]) { _plToast('請先選檔案', 'warn'); return null; }
  var file = input.files[0];
  if (file.size > 5 * 1024 * 1024) { _plToast('檔案過大（>5MB）', 'error'); return null; }
  var text = await file.text();
  var r = await _plApi(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text,
  });
  if (!r.ok && r.status !== 400) {
    _plToast('上傳失敗 ' + r.status, 'error');
    return null;
  }
  return await r.json();
}

function _plRenderPreviewRows(rows) {
  if (!rows || !rows.length) return '';
  var actionBadge = function(action, newStatus) {
    if (action === 'skip_confirmed') return '<span style="background:#475569;color:#fff;padding:1px 6px;border-radius:4px;font-size:.85em">SKIP</span>';
    if (action === 'update') {
      var col = newStatus === 'confirmed' ? '#10b981' : '#f59e0b';
      return '<span style="background:' + col + ';color:#fff;padding:1px 6px;border-radius:4px;font-size:.85em">UPDATE→' + (newStatus || '?') + '</span>';
    }
    var col = newStatus === 'confirmed' ? '#10b981' : '#f59e0b';
    return '<span style="background:' + col + ';color:#fff;padding:1px 6px;border-radius:4px;font-size:.85em">NEW ' + (newStatus || '?') + '</span>';
  };
  var html = '<div style="margin-top:8px;font-size:.7em;color:var(--muted)">前 ' + Math.min(rows.length, 10) + ' / 共 ' + rows.length + ' 筆預覽（NEW=新增、UPDATE=覆蓋舊 draft、SKIP=已是 confirmed 不動）：</div>' +
    '<div style="max-height:240px;overflow-y:auto;margin-top:4px">';
  for (var i = 0; i < Math.min(rows.length, 10); i++) {
    var p = rows[i];
    html += '<div style="font-size:.66em;padding:4px 6px;border-bottom:1px solid var(--border);font-family:monospace;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
      actionBadge(p.action, p.new_status) +
      '<span>' + _plEsc(p.flight_date) + ' ' + _plEsc(p.flight_no) + ' ' + _plEsc(p.origin) + '→' + _plEsc(p.dest) + '</span>' +
      '<span style="color:var(--muted)">[' + _plEsc(p.aircraft_type) + '/' + _plEsc(p.tail_no) + ']</span>' +
      '<span style="color:var(--muted)">blk=' + _plEsc(p.block || '—') + ' out=' + _plEsc(p.out_utc ? p.out_utc.slice(11,16) + 'z' : '—') + '</span>' +
      '<span style="color:var(--muted)">pic=' + _plEsc(p.pic || '—') + '</span>' +
    '</div>';
  }
  html += '</div>';
  return html;
}

function _plRenderBadRows(badRows) {
  if (!badRows || !badRows.length) return '';
  var html = '<div style="margin-top:8px;font-size:.78em;font-weight:700;color:#fca5a5">❌ 以下 row 格式錯誤，整批不會 import：</div>' +
    '<div style="max-height:200px;overflow-y:auto;margin-top:4px">';
  for (var i = 0; i < badRows.length; i++) {
    var b = badRows[i];
    html += '<div style="font-size:.7em;padding:4px 6px;border-bottom:1px solid #7f1d1d;font-family:monospace;color:#fca5a5">' +
      'Row ' + b.row + ' (' + _plEsc(b.flight_no || '?') + '): date=<b>' + _plEsc(b.date || '空') + '</b> — ' + _plEsc(b.reason) +
    '</div>';
  }
  html += '</div>';
  return html;
}

async function _plUploadFlights(dryRun) {
  var endpoint = '/api/pilot-log/import/logten-flights' + (dryRun ? '?dryRun=1' : '');
  var j = await _plUploadFile('pl-flights-file', endpoint);
  if (!j) return;
  var resBox = document.getElementById('pl-import-result');

  if (j.error) {
    var badHtml = _plRenderBadRows(j.bad_rows);
    resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
      '❌ ' + _plEsc(j.error) + (badHtml ? '' : '') +
      '</div>' + badHtml;
    return;
  }

  // 從 preview 算出各 action 數量（dry-run 跟實際都用同一個來源）
  var nNew = 0, nUpdate = 0;
  if (j.preview) {
    for (var i = 0; i < j.preview.length; i++) {
      if (j.preview[i].action === 'insert') nNew++;
      else if (j.preview[i].action === 'update') nUpdate++;
    }
  }

  if (dryRun) {
    var preview = _plRenderPreviewRows(j.preview);
    resBox.innerHTML = '<div style="background:#1e3a5f;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
      '🔍 Dry-run（沒寫入 DB）：新增 <b>' + nNew + '</b>、更新舊 draft <b>' + nUpdate + '</b>、' +
      '保留 confirmed <b>' + j.duplicate_skipped + '</b>、解析失敗 <b>' + j.parse_errors + '</b><br>' +
      '<span style="font-size:.85em;color:#bfdbfe">確認 OK 後按 Import 真的寫入。</span>' +
      preview +
      '</div>';
  } else {
    resBox.innerHTML = '<div style="background:#064e3b;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
      '✅ 匯入完成：新增 <b>' + (j.inserted || 0) + '</b>、更新 <b>' + (j.updated || 0) + '</b>、' +
      '保留 confirmed <b>' + j.duplicate_skipped + '</b>、解析失敗 <b>' + j.parse_errors + '</b>' +
      '</div>';
    _plToast('匯入完成');
  }
}

async function _plUploadAircraft() {
  var j = await _plUploadFile('pl-aircraft-file', '/api/pilot-log/import/logten-aircraft');
  if (!j) return;
  var resBox = document.getElementById('pl-import-result');
  if (j.error) {
    resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ ' + _plEsc(j.error) + '</div>';
  } else {
    resBox.innerHTML = '<div style="background:#064e3b;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
      '✅ 機尾庫：新增 <b>' + j.inserted + '</b>、更新 <b>' + j.updated + '</b>、解析失敗 <b>' + j.parse_errors + '</b>' +
      '</div>';
    _plToast('機尾庫已更新');
  }
}

// V1.0.11：Aircraft Types 匯入（type catalog，跟 Aircraft tail 區分）
async function _plUploadAircraftTypes() {
  var j = await _plUploadFile('pl-aircraft-types-file', '/api/pilot-log/import/logten-aircraft-types');
  if (!j) return;
  var resBox = document.getElementById('pl-import-result');
  if (j.error) {
    var hint = '';
    if (j.error.indexOf('missing_required_columns') >= 0) {
      hint = '<div style="margin-top:6px;color:#fde68a;font-size:.92em">提示：你可能上傳到 Aircraft（機尾）檔了。Aircraft Types 必填欄位是 <code>Type</code>，是 LogTen 的另一個 export。</div>';
    }
    resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ ' + _plEsc(j.error) + hint + '</div>';
    return;
  }
  resBox.innerHTML = '<div style="background:#064e3b;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
    '✅ 機型目錄：新增 <b>' + j.inserted + '</b>、更新 <b>' + j.updated + '</b>、解析失敗 <b>' + j.parse_errors + '</b>' +
    '</div>';
  _plToast('機型目錄已更新');
}

// V1.0.10：Address Book 匯入（接 V1.0.09 backend）
async function _plUploadAddressBook() {
  var j = await _plUploadFile('pl-addressbook-file', '/api/pilot-log/import/logten-addressbook');
  if (!j) return;
  var resBox = document.getElementById('pl-import-result');
  if (j.error) {
    resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ ' + _plEsc(j.error) + '</div>';
    return;
  }
  var html = '<div style="background:#064e3b;color:#fff;padding:10px;border-radius:8px;font-size:.78em;line-height:1.6">' +
    '✅ Address Book：新增 <b>' + j.inserted + '</b>、更新 <b>' + j.updated + '</b>、解析失敗 <b>' + j.parse_errors + '</b>';
  if (j.self_set) html += '、本人標記為 <b>' + _plEsc(j.self_set) + '</b>';
  if (j.conflicts && j.conflicts.length > 0) {
    html += '<div style="margin-top:6px;background:rgba(251,191,36,.15);border:1px solid #fbbf24;border-radius:6px;padding:6px 8px;color:#fde68a;font-size:.92em">' +
      '⚠️ ' + j.conflicts.length + ' 筆 conflict（多 ID 命中不同 crew、或同名多筆都沒 ID） — 不自動合併、請人工檢查';
    for (var ci = 0; ci < Math.min(j.conflicts.length, 5); ci++) {
      var c = j.conflicts[ci];
      html += '<div style="margin-top:4px;font-size:.88em">row ' + c.row + '：' + _plEsc(c.name) + '（IDs: ' + (c.ids.join(', ') || '無') + '）</div>';
    }
    if (j.conflicts.length > 5) html += '<div style="margin-top:4px;font-size:.88em">…還有 ' + (j.conflicts.length - 5) + ' 筆</div>';
    html += '</div>';
  }
  if (j.self_update_error) {
    html += '<div style="margin-top:6px;color:#fca5a5">⚠️ self 標記更新失敗：' + _plEsc(j.self_update_error) + '（其他資料正常匯入）</div>';
  }
  html += '</div>';
  resBox.innerHTML = html;
  _plToast('Address Book 已更新');
}

// === SECTION: aircraft（V1.0.10） ═══════════════════════════════════════════════
// 列表頁：所有 pilot_aircraft → 點某架 → 顯示用過這架 tail 的所有 flights
// + Add Aircraft：手動加新機（公司新交機等）

// 獨立 fetch：撈完整 entries（不過主頁 filter、不分頁），給 Aircraft 列表 / drill-down 用
// 主頁 _pl.entries 受 filter + 200 limit 影響，counts 跟 drill-down 不能用它
async function _plFetchAircraftEntries() {
  // 用 limit=50000（server 端剛調的上限），覆蓋任何真實飛行員職涯範圍。
  // V1.2：網路掛掉保留既有快照（可能來自 IDB），設 OFFLINE 旗標；成功就寫一份回 IDB。
  try {
    var res = await _plApi('/api/pilot-log/entries?limit=50000');
    if (!res.ok) {
      if (!_pl.aircraftEntries) _pl.aircraftEntries = [];
      return;
    }
    var j = await res.json();
    _pl.aircraftEntries = j.entries || [];
    _plCacheSaveAircraftEntries();
    _plSetOffline(false);
  } catch (e) {
    _plSetOffline(true);
    if (!_pl.aircraftEntries) _pl.aircraftEntries = [];
  }
}

async function _plOpenAircraft() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // Loading state（避免空白）
  c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">載入機尾庫… · Loading aircraft…</div>';
  // 同時拉 aircraft 清單跟完整 entries（兩者各自獨立、可並行）
  await Promise.all([_plFetchAll(), _plFetchAircraftEntries()]);
  _plRenderAircraftList();
}

// 用 type_code 從 _pl.aircraftTypes 撈完整名（V1.0.11）
// 例：A359 → "Airbus A-350-900"。沒匹配就回空字串
function _plLookupTypeFullName(typeCode) {
  if (!typeCode || !_pl.aircraftTypes || _pl.aircraftTypes.length === 0) return '';
  for (var i = 0; i < _pl.aircraftTypes.length; i++) {
    var t = _pl.aircraftTypes[i];
    if (t.type_code === typeCode) {
      return [t.make, t.model].filter(Boolean).join(' ');
    }
  }
  return '';
}

function _plRenderAircraftList() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // 用完整快照算 count（不受主頁 filter 跟 200 limit 影響）
  var sourceEntries = _pl.aircraftEntries || [];
  var tailCount = {};
  for (var i = 0; i < sourceEntries.length; i++) {
    var t = sourceEntries[i].tail_no;
    if (t) tailCount[t] = (tailCount[t] || 0) + 1;
  }
  var rows = '';
  if (_pl.aircraft.length === 0) {
    rows = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">機尾庫是空的。點 <b>+ Add Aircraft</b> 手動加，或從 <b>📥 Import</b> 上傳 LogTen Aircraft 檔。<br>No aircraft yet — tap <b>+ Add Aircraft</b>, or upload a LogTen Aircraft file via <b>📥 Import</b>.</div>';
  } else {
    for (var ai = 0; ai < _pl.aircraft.length; ai++) {
      var a = _pl.aircraft[ai];
      var count = tailCount[a.tail_no] || 0;
      var typeStr = _plEsc(a.type_code || '');
      // 機型顯示優先序：(1) pilot_aircraft 自己的 make/model（手動建的可能有）
      //                (2) Aircraft Types catalog 查到的完整名（V1.0.11）
      var modelStr = '';
      if (a.make || a.model) {
        modelStr = _plEsc([a.make, a.model].filter(Boolean).join(' '));
      } else if (a.type_code) {
        var fromCatalog = _plLookupTypeFullName(a.type_code);
        if (fromCatalog) modelStr = _plEsc(fromCatalog);
      }
      rows += '<div onclick="_plOpenAircraftDetail(\'' + _plEsc(a.tail_no) + '\')" ' +
        'style="background:var(--card);border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;display:flex;gap:10px;align-items:center">' +
        '<div style="min-width:110px"><div style="font-size:.85em;font-weight:700">' + _plEsc(a.tail_no) + '</div>' +
        (a.operator ? '<div style="font-size:.62em;color:var(--muted)">' + _plEsc(a.operator) + '</div>' : '') + '</div>' +
        '<div style="min-width:90px;font-size:.74em;color:var(--muted)">' + typeStr + '</div>' +
        '<div style="flex:1;font-size:.7em;color:var(--muted)">' + modelStr + '</div>' +
        '<div style="font-size:.72em;color:var(--text);text-align:right">' + count + ' flights</div>' +
        '</div>';
    }
  }
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">✈️ Aircraft</div>' +
        '<div style="flex:1"></div>' +
        '<button onclick="_plOpenAddAircraft()" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">+ Add Aircraft</button>' +
      '</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:10px">共 ' + _pl.aircraft.length + ' 架；點任一筆查看用過這架的所有航班。 · ' + _pl.aircraft.length + ' aircraft — tap one to see every flight on that tail.</div>' +
      rows +
    '</div>';
}

function _plOpenAircraftDetail(tail) {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // 找出這架的詳細資料 + 用過這架的 entries
  var aircraft = null;
  for (var ai = 0; ai < _pl.aircraft.length; ai++) {
    if (_pl.aircraft[ai].tail_no === tail) { aircraft = _pl.aircraft[ai]; break; }
  }
  // 從完整快照篩這架的所有航班（不受主頁 filter / 分頁影響）
  var sourceEntries = _pl.aircraftEntries || [];
  var flights = sourceEntries.filter(function(e) { return e.tail_no === tail; });
  // 依日期排序（最新先）
  flights.sort(function(a, b) { return (b.flight_date || '').localeCompare(a.flight_date || ''); });

  // make/model 優先用 pilot_aircraft 自己的，沒有再從 aircraft_types catalog 查
  var fullName = '';
  if (aircraft) {
    if (aircraft.make || aircraft.model) {
      fullName = [aircraft.make, aircraft.model].filter(Boolean).join(' ');
    } else if (aircraft.type_code) {
      fullName = _plLookupTypeFullName(aircraft.type_code);
    }
  }
  var head = aircraft
    ? '<div style="background:var(--card);border-radius:8px;padding:12px;margin-bottom:10px;font-size:.78em">' +
        '<div style="font-weight:700;font-size:1.1em">' + _plEsc(aircraft.tail_no) + '</div>' +
        '<div style="color:var(--muted);margin-top:4px">' +
          (aircraft.type_code ? _plEsc(aircraft.type_code) : '') +
          (fullName ? '　' + _plEsc(fullName) : '') +
          (aircraft.operator ? '　' + _plEsc(aircraft.operator) : '') +
        '</div>' +
        (aircraft.notes ? '<div style="color:var(--muted);margin-top:4px">' + _plEsc(aircraft.notes) + '</div>' : '') +
      '</div>'
    : '<div style="background:var(--card);border-radius:8px;padding:12px;margin-bottom:10px;font-size:.85em;font-weight:700">' + _plEsc(tail) + '</div>';

  var rows = '';
  if (flights.length === 0) {
    rows = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">沒有用過這架的航班紀錄。 · No flights recorded on this aircraft.</div>';
  } else {
    rows = flights.map(_plRenderEntryRow).join('');
  }

  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<button onclick="_plOpenAircraft()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">' + _plEsc(tail) + ' / Flights</div>' +
        '<div style="flex:1"></div>' +
        '<div style="font-size:.72em;color:var(--muted)">' + flights.length + ' flights</div>' +
      '</div>' +
      head +
      rows +
    '</div>';
}

function _plOpenAddAircraft() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  function field(label, id, placeholder) {
    return '<div style="margin-bottom:10px">' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:3px">' + label + '</div>' +
      '<input id="' + id + '" placeholder="' + (placeholder || '') + '" ' +
        'style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em">' +
      '</div>';
  }
  c.innerHTML =
    '<div style="padding:10px;max-width:520px;margin:0 auto">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<button onclick="_plOpenAircraft()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">+ Add Aircraft</div>' +
      '</div>' +
      '<div style="background:var(--card);border-radius:10px;padding:14px">' +
        field('Tail # *（機號，例：B-58502）', 'pl-add-tail', 'B-58502') +
        field('Type Code（機型代碼，例：A359）', 'pl-add-type', 'A359') +
        field('Manufacturer（廠商，例：Airbus）', 'pl-add-make', 'AIRBUS INDUSTRIES') +
        field('Model（完整機型，例：A-350-900）', 'pl-add-model', 'A-350-900') +
        field('Operator（公司）', 'pl-add-operator', 'Starlux') +
        field('Notes（備註）', 'pl-add-notes', '') +
        '<div style="display:flex;gap:8px;margin-top:6px">' +
          '<button onclick="_plSubmitAddAircraft()" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:.85em;font-weight:700;cursor:pointer">Save</button>' +
          '<button onclick="_plOpenAircraft()" style="background:transparent;border:1px solid var(--border,#334155);color:var(--text);border-radius:6px;padding:8px 14px;font-size:.85em;cursor:pointer">Cancel</button>' +
        '</div>' +
        '<div style="font-size:.65em;color:var(--muted);margin-top:8px">* 必填。已存在同 tail 會 merge（空欄位不會洗掉舊資料）。<br>* Required. An existing tail is merged (blank fields won’t overwrite saved data).</div>' +
      '</div>' +
      '<div id="pl-add-result" style="margin-top:14px"></div>' +
    '</div>';
}

async function _plSubmitAddAircraft() {
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  var tail = val('pl-add-tail');
  var resBox = document.getElementById('pl-add-result');
  if (!tail) {
    if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:8px 10px;border-radius:6px;font-size:.78em">❌ Tail # 必填</div>';
    return;
  }
  var body = {
    tail_no: tail,
    type_code: val('pl-add-type'),
    make: val('pl-add-make'),
    model: val('pl-add-model'),
    operator: val('pl-add-operator'),
    notes: val('pl-add-notes'),
  };
  try {
    var res = await _plApi('/api/pilot-log/aircraft', { method: 'POST', body: body });
    if (res.status === 201 || res.status === 200) {
      var j = await res.json();
      _plToast(j.inserted ? '已新增 ' + tail : '已更新 ' + tail);
      // 重新拉資料 + 回列表
      await _plFetchAll();
      _plRenderAircraftList();
      return;
    }
    var ej = await res.json().catch(function() { return {}; });
    if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:8px 10px;border-radius:6px;font-size:.78em">❌ ' + _plEsc(ej.error || ('HTTP ' + res.status)) + '</div>';
  } catch (e) {
    if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:8px 10px;border-radius:6px;font-size:.78em">❌ ' + _plEsc((e && e.message) || 'unknown') + '</div>';
  }
}

// === SECTION: crew（V1.0.11） ═══════════════════════════════════════════════════
// 列表頁：所有 crew + 一起飛過幾班 → 點某人 → 顯示一起飛過的所有 flight
// drill-down 用名字比對 entry.crew JSONB 內任一欄位（pic / sic / fo1 / fo2 / purser ...）
// 完整 entries 快照沿用 Aircraft 那套（_pl.aircraftEntries），不再開第二份

var _plCrewSearchTerm = '';

async function _plOpenCrew() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">載入 crew… · Loading crew…</div>';
  // 同時拉 crew 跟完整 entries（兩者各自獨立、可並行）
  await Promise.all([_plFetchAll(), _plFetchAircraftEntries()]);
  _plRenderCrewList();
}

// 從 entry.crew JSONB 內所有欄位收集名字（pic/sic/fo1/fo2/purser/observer 都算）
function _plEntryCrewNames(e) {
  if (!e || !e.crew || typeof e.crew !== 'object') return [];
  var names = [];
  Object.keys(e.crew).forEach(function(k) {
    var v = e.crew[k];
    if (typeof v === 'string' && v.trim()) names.push(v.trim());
  });
  return names;
}

// 找出 Address Book 內 display_name 被多筆共用的名字（同名 ambiguous）。
// entry.crew 只有名字、沒有 employee_id，所以同名的 crew 我們無法確定
// 哪一筆 flight 屬於哪一個人 → 必須標 ambiguous，不能算 flight count、
// drill-down 也不該列航班，避免錯誤歸屬。
function _plCrewAmbiguousNames() {
  var counts = {};
  var list = _pl.crew || [];
  for (var i = 0; i < list.length; i++) {
    var n = (list[i].display_name || '').trim();
    if (!n) continue;
    counts[n] = (counts[n] || 0) + 1;
  }
  var amb = {};
  Object.keys(counts).forEach(function(k) { if (counts[k] > 1) amb[k] = true; });
  return amb;
}

function _plRenderCrewList() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // 用完整快照算「跟某 crew 一起飛過幾班」
  var sourceEntries = _pl.aircraftEntries || [];
  var nameCount = {};
  for (var i = 0; i < sourceEntries.length; i++) {
    var ns = _plEntryCrewNames(sourceEntries[i]);
    for (var j = 0; j < ns.length; j++) {
      nameCount[ns[j]] = (nameCount[ns[j]] || 0) + 1;
    }
  }
  var ambNames = _plCrewAmbiguousNames();
  var hasAmb = false;
  for (var ak in ambNames) { if (ambNames.hasOwnProperty(ak)) { hasAmb = true; break; } }

  // 套搜尋條件（display_name / employee_id 都比對）
  var term = (_plCrewSearchTerm || '').toLowerCase().trim();
  var filtered = _pl.crew.filter(function(p) {
    if (!term) return true;
    if ((p.display_name || '').toLowerCase().indexOf(term) >= 0) return true;
    if (Array.isArray(p.employee_ids)) {
      for (var k = 0; k < p.employee_ids.length; k++) {
        if (String(p.employee_ids[k]).toLowerCase().indexOf(term) >= 0) return true;
      }
    }
    return false;
  });

  var rows = '';
  if (_pl.crew.length === 0) {
    rows = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">名單是空的。從 <b>📥 Import</b> 上傳 LogTen Address Book 把 crew 匯進來。<br>No crew yet — import a LogTen Address Book via <b>📥 Import</b>.</div>';
  } else if (filtered.length === 0) {
    rows = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">沒符合「' + _plEsc(term) + '」的 crew。 · No crew matching “' + _plEsc(term) + '”.</div>';
  } else {
    for (var ri = 0; ri < filtered.length; ri++) {
      var p = filtered[ri];
      var ambiguous = !!ambNames[(p.display_name || '').trim()];
      var idStr = Array.isArray(p.employee_ids) && p.employee_ids.length ? p.employee_ids.join(' / ') : '';
      var selfMark = p.is_self ? '<span style="background:#0ea5e9;color:#fff;border-radius:4px;padding:1px 6px;font-size:.6em;margin-left:6px">YOU</span>' : '';
      var ambMark = ambiguous ? '<span style="background:#f59e0b;color:#000;border-radius:4px;padding:1px 6px;font-size:.6em;margin-left:6px" title="Address Book 內有多筆同名 crew，無法判斷哪些航班屬於誰">SAME-NAME</span>' : '';
      var countCell = ambiguous
        ? '<div style="font-size:.72em;color:var(--muted);text-align:right" title="同名 crew 無法計數">—</div>'
        : '<div style="font-size:.72em;color:var(--text);text-align:right">' + (nameCount[p.display_name] || 0) + ' flights</div>';
      rows += '<div onclick="_plOpenCrewDetail(\'' + _plEsc(p.id) + '\')" ' +
        'style="background:var(--card);border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;display:flex;gap:10px;align-items:center">' +
        '<div style="flex:1"><div style="font-size:.85em;font-weight:700">' + _plEsc(p.display_name) + selfMark + ambMark + '</div>' +
          (idStr ? '<div style="font-size:.62em;color:var(--muted)">ID: ' + _plEsc(idStr) + '</div>' : '') +
          (p.organization ? '<div style="font-size:.62em;color:var(--muted)">' + _plEsc(p.organization) + '</div>' : '') + '</div>' +
        countCell +
        '</div>';
    }
  }

  var ambNotice = hasAmb
    ? '<div style="background:#3b2f0a;border:1px solid #f59e0b;color:#fbbf24;border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:.7em">⚠ 有同名 crew（標記 <b>SAME-NAME</b>）：因為 entry.crew 只記名字、沒帶 employee_id，無法判斷某筆航班屬於哪一位，所以不顯示 flight count、drill-down 也不列航班。建議在 Address Book 內把同名的人加註 organization 或 comment 區分。<br>Some crew share a display name (<b>SAME-NAME</b>): since entries store only the name (no employee_id), we cannot tell which person a flight belongs to, so flight counts and drill-down are suppressed. Differentiate them with organization / comment in your Address Book.</div>'
    : '';

  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">👥 Crew</div>' +
        '<div style="flex:1"></div>' +
        '<div style="font-size:.7em;color:var(--muted)">共 ' + _pl.crew.length + ' 人</div>' +
      '</div>' +
      '<input id="pl-crew-search" type="search" placeholder="搜尋名字 / ID..." value="' + _plEsc(term) + '" ' +
        'oninput="_plCrewSearchInput(this.value)" ' +
        'style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em;margin-bottom:10px;box-sizing:border-box">' +
      ambNotice +
      '<div style="font-size:.65em;color:var(--muted);margin-bottom:8px">flight count 用完整資料計算（不受 Logbook 篩選影響）。點任一筆查看一起飛過的航班。<br>Flight counts use all data (ignores the Logbook filter). Tap anyone to see flights flown together.</div>' +
      rows +
    '</div>';
}

function _plCrewSearchInput(v) {
  _plCrewSearchTerm = v;
  _plRenderCrewList();
}

function _plOpenCrewDetail(crewId) {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // 找 crew 本人
  var person = null;
  for (var i = 0; i < _pl.crew.length; i++) {
    if (_pl.crew[i].id === crewId) { person = _pl.crew[i]; break; }
  }
  if (!person) {
    _plRenderCrewList();
    return;
  }
  var name = (person.display_name || '').trim();
  var ambNames = _plCrewAmbiguousNames();
  var ambiguous = !!ambNames[name];

  var idStr = Array.isArray(person.employee_ids) && person.employee_ids.length ? person.employee_ids.join(' / ') : '';
  var head = '<div style="background:var(--card);border-radius:8px;padding:12px;margin-bottom:10px;font-size:.78em">' +
    '<div style="font-weight:700;font-size:1.1em">' + _plEsc(person.display_name) +
      (person.is_self ? '<span style="background:#0ea5e9;color:#fff;border-radius:4px;padding:1px 6px;font-size:.6em;margin-left:6px">YOU</span>' : '') +
      (ambiguous ? '<span style="background:#f59e0b;color:#000;border-radius:4px;padding:1px 6px;font-size:.6em;margin-left:6px">SAME-NAME</span>' : '') +
    '</div>' +
    (idStr ? '<div style="color:var(--muted);margin-top:4px">ID: ' + _plEsc(idStr) + '</div>' : '') +
    (person.organization ? '<div style="color:var(--muted);margin-top:2px">' + _plEsc(person.organization) + '</div>' : '') +
    (person.comment ? '<div style="color:var(--muted);margin-top:2px;font-size:.92em">' + _plEsc(person.comment) + '</div>' : '') +
  '</div>';

  var bodyHtml;
  var countLabel;
  if (ambiguous) {
    bodyHtml = '<div style="background:#3b2f0a;border:1px solid #f59e0b;color:#fbbf24;border-radius:6px;padding:12px;font-size:.78em;line-height:1.5">' +
      '⚠ <b>無法列出航班 / Cannot list flights</b><br>' +
      'Address Book 內有多位 crew 叫「' + _plEsc(name) + '」，但 entry 只記名字、沒帶 employee_id，' +
      '所以無法判斷某筆航班是跟哪一位同名 crew 飛。為避免錯誤歸屬，先不顯示。<br>' +
      'Multiple crew are named “' + _plEsc(name) + '”, but entries store only the name (no employee_id), so we cannot tell which one a flight was with. Suppressed to avoid misattribution.<br><br>' +
      '建議到 Address Book（LogTen 端）給同名的人加上不同的 organization 或備註後重新匯入。<br>' +
      'Tip: give same-named crew distinct organization / comments in LogTen, then re-import.' +
    '</div>';
    countLabel = '—';
  } else {
    var sourceEntries = _pl.aircraftEntries || [];
    var flights = sourceEntries.filter(function(e) {
      var ns = _plEntryCrewNames(e);
      for (var k = 0; k < ns.length; k++) if (ns[k] === name) return true;
      return false;
    });
    flights.sort(function(a, b) { return (b.flight_date || '').localeCompare(a.flight_date || ''); });
    bodyHtml = flights.length === 0
      ? '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">沒有跟這位 crew 一起飛過的紀錄。比對方式是 entry.crew 內姓名是否完全一致，不同 export 的拼法可能對不到。<br>No flights flown with this crew. Matching is by exact name in entry.crew — spelling differences across exports may not match.</div>'
      : flights.map(_plRenderEntryRow).join('');
    countLabel = flights.length + ' flights';
  }

  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<button onclick="_plOpenCrew()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">' + _plEsc(person.display_name) + ' / Flights</div>' +
        '<div style="flex:1"></div>' +
        '<div style="font-size:.72em;color:var(--muted)">' + countLabel + '</div>' +
      '</div>' +
      head +
      bodyHtml +
    '</div>';
}

// === SECTION: analyze（純統計 + 圖表）═══════════════════════════════════════
// 統計卡片沿用 _plRenderStats()；圖表用純 CSS bar（不引 chart library，離線可用、
// 顏色走 var()/固定 accent 兩主題都讀得清楚，切日夜不必重畫）。

async function _plRenderAnalyze() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (!_pl.user) { _plRenderLogin(); return; }
  _plShowTabBar(true);
  _plHighlightTab('analyze');
  c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">Loading stats…</div>';
  await Promise.all([_plFetchAll(), _plFetchAircraftEntries()]);
  if (!_pl.user) { _plRenderLogin(); return; }   // fetch 中 session 失效 → 回登入（codex fast P1）
  _plRenderAnalyzeContent();
}

// 近 12 個月各月 block 分鐘（含今天所在月）
function _plMonthlyBlock(entries) {
  var now = new Date();
  var buckets = [], map = {};
  for (var i = 11; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var ym = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    var b = { ym: ym, mm: ('0' + (d.getMonth() + 1)).slice(-2), minutes: 0 };
    map[ym] = b; buckets.push(b);
  }
  for (var j = 0; j < entries.length; j++) {
    var fd = String(entries[j].flight_date || '').slice(0, 7);
    if (map[fd]) map[fd].minutes += (entries[j].block_minutes || 0);
  }
  return buckets;
}

// 近 12 個月 block hours 直條圖（CSS bar）
function _plRenderMonthlyChart(entries) {
  var data = _plMonthlyBlock(entries);
  var max = 0;
  for (var i = 0; i < data.length; i++) if (data[i].minutes > max) max = data[i].minutes;
  if (max === 0) {
    return '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:14px;margin-bottom:10px">' +
      '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Block Hours · Last 12 Months</div>' +
      '<div style="text-align:center;color:var(--muted);font-size:.8em;padding:14px">尚無資料 · No data</div></div>';
  }
  var bars = '';
  for (var k = 0; k < data.length; k++) {
    var pct = Math.round((data[k].minutes / max) * 82); // 留上下標籤空間（容器 130px）
    var hrs = (data[k].minutes / 60);
    var label = hrs >= 1 ? hrs.toFixed(0) : (data[k].minutes > 0 ? hrs.toFixed(1) : '');
    bars += '<div style="flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px;min-width:0">' +
      '<div style="font-size:.52em;color:var(--muted);line-height:1">' + label + '</div>' +
      '<div title="' + _plMinToHHMM(data[k].minutes) + '" style="flex:none;width:70%;max-width:18px;height:' + Math.max(pct, data[k].minutes > 0 ? 5 : 0) + '%;min-height:' + (data[k].minutes > 0 ? '4px' : '0') + ';background:var(--accent);border-radius:3px 3px 0 0"></div>' +
      '<div style="font-size:.52em;color:var(--muted);line-height:1">' + data[k].mm + '</div>' +
    '</div>';
  }
  return '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:14px;margin-bottom:10px">' +
    '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Block Hours · Last 12 Months (hrs)</div>' +
    '<div style="display:flex;align-items:flex-end;gap:4px;height:130px">' + bars + '</div>' +
  '</div>';
}

// by-type 水平 bar（用 stats.by_type）
function _plRenderByTypeChart() {
  var by = (_pl.stats && _pl.stats.by_type) || [];
  if (!by.length) return '';
  var max = 0;
  for (var i = 0; i < by.length; i++) if ((by[i].total_minutes || 0) > max) max = by[i].total_minutes;
  var rows = '';
  for (var k = 0; k < by.length; k++) {
    var t = by[k];
    var pct = max ? Math.round((t.total_minutes / max) * 100) : 0;
    rows += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">' +
      '<div style="min-width:64px;font-size:.72em;font-weight:700">' + _plEsc(t.aircraft_type || '—') + '</div>' +
      '<div style="flex:1;background:var(--bar-bg);border-radius:5px;height:16px;overflow:hidden">' +
        '<div style="width:' + Math.max(pct, 2) + '%;height:100%;background:var(--accent);border-radius:5px"></div>' +
      '</div>' +
      '<div style="min-width:74px;text-align:right;font-size:.68em;color:var(--muted)">' + _plMinToHHMM(t.total_minutes) + ' <span style="opacity:.6">(' + t.entry_count + ')</span></div>' +
    '</div>';
  }
  return '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:14px;margin-bottom:10px">' +
    '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">By Type</div>' +
    rows +
  '</div>';
}

function _plRenderAnalyzeContent() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (_pl.tab !== 'analyze') return;   // 防 race：切走後過期的 async render 不可覆蓋新分頁
  // 只算已飛（confirmed）— 跟 /stats 卡片一致（codex P2）；draft/roster_removed 不進圖表
  var entries = (_pl.aircraftEntries || []).filter(function(e) { return e.status === 'confirmed'; });
  var hasStats = _pl.stats && _pl.stats.totals;
  var body = hasStats
    ? _plRenderStats() + _plRenderMonthlyChart(entries) + _plRenderByTypeChart()
    : '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">尚無可分析的飛行紀錄，先到 <b>📒 Logbook</b> 新增或匯入 · No flights to analyze yet — add or import in <b>📒 Logbook</b>.</div>';
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
        '<div style="font-size:1em;font-weight:700">📊 Analyze</div>' +
        '<div style="font-size:.65em;color:var(--muted)">全部已飛資料 · All flown data</div>' +
      '</div>' +
      body +
    '</div>';
}

// === SECTION: report（currency + 區間總表 + 匯出）═══════════════════════════
// 全新 tab。資料用完整快照 _pl.aircraftEntries 計算。currency 僅供參考、非官方判定。

async function _plRenderReport() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (!_pl.user) { _plRenderLogin(); return; }
  _plShowTabBar(true);
  _plHighlightTab('report');
  c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">Loading report…</div>';
  await _plFetchAircraftEntries();
  if (!_pl.user) { _plRenderLogin(); return; }   // fetch 中 session 失效 → 回登入（codex fast P1）
  _plRenderReportContent();
}

// 取目前區間（預設今年初 → 今天）
function _plReportRange() {
  var now = new Date();
  var ytd = now.getFullYear() + '-01-01';
  var today = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
  return { from: _pl.reportFrom || ytd, to: _pl.reportTo || today };
}

// 區間內聚合（block/PIC/SIC/night/班數/起降）
function _plAggregate(entries, from, to) {
  var a = { block: 0, pic: 0, sic: 0, night: 0, flights: 0, landings: 0, takeoffs: 0,
            dayLdg: 0, nightLdg: 0, dayTO: 0, nightTO: 0 };
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var fd = String(e.flight_date || '').slice(0, 10);
    if (!fd) continue;
    if (from && fd < from) continue;
    if (to && fd > to) continue;
    a.flights++;
    a.block += e.block_minutes || 0;
    a.night += e.night_minutes || 0;
    if (e.position === 'PIC') a.pic += e.block_minutes || 0;
    else if (e.position === 'SIC') a.sic += e.block_minutes || 0;
    a.dayLdg += e.day_landings || 0; a.nightLdg += e.night_landings || 0;
    a.dayTO += e.day_takeoffs || 0; a.nightTO += e.night_takeoffs || 0;
  }
  a.landings = a.dayLdg + a.nightLdg;
  a.takeoffs = a.dayTO + a.nightTO;
  return a;
}

function _plRenderReportContent() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (_pl.tab !== 'report') return;   // 防 race：切走後過期的 async render 不可覆蓋新分頁
  // 報表只看已飛（confirmed）— recency / 時數 / CSV 都不能把 draft（計畫中）跟
  // roster_removed 當成已飛，否則起降數、block 時數會灌水（codex P1）
  var src = (_pl.aircraftEntries || []).filter(function(e) { return e.status === 'confirmed'; });

  // ── 90 天 recency ──
  var now = new Date();
  var d90 = new Date(now.getTime() - 90 * 86400000);
  var d90str = d90.getFullYear() + '-' + ('0' + (d90.getMonth() + 1)).slice(-2) + '-' + ('0' + d90.getDate()).slice(-2);
  var rec = _plAggregate(src, d90str, null);
  // 最後飛行日
  var lastDate = '';
  for (var i = 0; i < src.length; i++) {
    var fd = String(src[i].flight_date || '').slice(0, 10);
    if (fd && fd > lastDate) lastDate = fd;
  }
  var daysAgo = '';
  if (lastDate) {
    var diff = Math.floor((now - new Date(lastDate + 'T00:00:00Z')) / 86400000);
    daysAgo = diff <= 0 ? 'Today' : diff + ' days ago';
  }
  function recCard(label, value, sub) {
    return '<div style="background:var(--card);border-radius:10px;padding:12px;flex:1;min-width:120px">' +
      '<div style="font-size:.62em;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">' + label + '</div>' +
      '<div style="font-size:1.4em;font-weight:700">' + value + '</div>' +
      (sub ? '<div style="font-size:.62em;color:var(--muted);margin-top:2px">' + sub + '</div>' : '') +
    '</div>';
  }
  var recencyHtml =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">' +
      '<div style="font-size:.85em;font-weight:700">⏱️ Last 90 Days Recency</div>' +
      '<div style="font-size:.6em;color:var(--muted)">僅供參考、非官方 currency 判定 · For reference only — not an official currency determination</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
      recCard('Takeoffs', rec.takeoffs, 'Day ' + rec.dayTO + ' / Night ' + rec.nightTO) +
      recCard('Landings', rec.landings, 'Day ' + rec.dayLdg + ' / Night ' + rec.nightLdg) +
      recCard('Night Landings', rec.nightLdg, 'Last 90 days') +
      recCard('Last Flight', daysAgo || '—', lastDate || 'No flights') +
    '</div>';

  // ── 區間時數總表 ──
  var r = _plReportRange();
  var agg = _plAggregate(src, r.from, r.to);
  function sumCell(label, val) {
    return '<div style="background:var(--card);border-radius:8px;padding:10px;flex:1;min-width:90px">' +
      '<div style="font-size:.6em;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">' + label + '</div>' +
      '<div style="font-size:1.05em;font-weight:700">' + val + '</div></div>';
  }
  var inputStyle = 'background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:.78em';
  var rangeHtml =
    '<div style="display:flex;align-items:center;gap:8px;margin:14px 0 8px;flex-wrap:wrap">' +
      '<div style="font-size:.85em;font-weight:700">📅 Hours Summary</div>' +
      '<div style="flex:1"></div>' +
      '<input type="date" value="' + _plEsc(r.from) + '" onchange="_plSetReportFrom(this.value)" style="' + inputStyle + '">' +
      '<span style="color:var(--muted);font-size:.78em">→</span>' +
      '<input type="date" value="' + _plEsc(r.to) + '" onchange="_plSetReportTo(this.value)" style="' + inputStyle + '">' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
      sumCell('Block', _plMinToHHMM(agg.block)) +
      sumCell('PIC', _plMinToHHMM(agg.pic)) +
      sumCell('SIC', _plMinToHHMM(agg.sic)) +
      sumCell('Night', _plMinToHHMM(agg.night)) +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">' +
      sumCell('Flights', agg.flights) +
      sumCell('Landings', agg.landings) +
      sumCell('Takeoffs', agg.takeoffs) +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button onclick="_plExportCsv()" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:.8em;font-weight:700;cursor:pointer">⬇️ Export CSV</button>' +
      '<button onclick="window.print()" style="background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 14px;font-size:.8em;font-weight:700;cursor:pointer">🖨️ Print</button>' +
    '</div>' +
    '<div style="font-size:.62em;color:var(--muted);margin-top:8px">CSV 為區間內已飛（confirmed）航班，含 PIC/SIC、起降、夜航時數 · CSV covers confirmed (flown) flights in the selected range (' + _plEsc(r.from) + ' → ' + _plEsc(r.to) + '): PIC/SIC, takeoffs/landings, night time.</div>';

  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
        '<div style="font-size:1em;font-weight:700">📄 Report</div>' +
        '<div style="font-size:.65em;color:var(--muted)">只計已飛航班 · Flown flights only</div>' +
      '</div>' +
      recencyHtml +
      '<hr style="border:none;border-top:1px solid var(--border);margin:6px 0">' +
      rangeHtml +
    '</div>';
}

function _plSetReportFrom(v) { _pl.reportFrom = v || null; _plRenderReportContent(); }
function _plSetReportTo(v) { _pl.reportTo = v || null; _plRenderReportContent(); }

function _plCsvCell(v) {
  v = v == null ? '' : String(v);
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function _plExportCsv() {
  var r = _plReportRange();
  var src = (_pl.aircraftEntries || []).filter(function(e) {
    if (e.status !== 'confirmed') return false;   // 只匯出已飛（codex P1）
    var fd = String(e.flight_date || '').slice(0, 10);
    return fd && (!r.from || fd >= r.from) && (!r.to || fd <= r.to);
  });
  src.sort(function(a, b) { return (a.flight_date || '').localeCompare(b.flight_date || ''); });
  var head = ['Date', 'Flight', 'From', 'To', 'Type', 'Tail', 'Position',
              'Block', 'Night', 'DayTO', 'NightTO', 'DayLdg', 'NightLdg', 'PIC', 'SIC'];
  var lines = [head.join(',')];
  for (var i = 0; i < src.length; i++) {
    var e = src[i];
    var crew = e.crew || {};
    var cells = [
      String(e.flight_date || '').slice(0, 10), e.flight_no, e.origin, e.dest,
      e.aircraft_type, e.tail_no, e.position,
      _plMinToHHMM(e.block_minutes), _plMinToHHMM(e.night_minutes),
      e.day_takeoffs || 0, e.night_takeoffs || 0, e.day_landings || 0, e.night_landings || 0,
      crew.pic || '', crew.sic || '',
    ];
    lines.push(cells.map(_plCsvCell).join(','));
  }
  // BOM 讓 Excel 認得 UTF-8
  var blob = new Blob([String.fromCharCode(0xFEFF) + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'pilot-log_' + r.from + '_' + r.to + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  _plToast('Exported ' + src.length + ' flights to CSV');
}

// === SECTION: entry point ════════════════════════════════════════════════════
async function _plRender() {
  if (!_pl.user) { _plRenderLogin(); return; }
  await _plFetchAll();
  _plRenderMain();
}

// 由 switchTab 呼叫
async function pilotLogInit() {
  if (!_pl.initialized) {
    _plLoadSession();
    _pl.initialized = true;
    _plRequestPersist();           // V1.2：請瀏覽器把儲存標 persistent，iOS 7 天清除延緩
  }
  if (_pl.editing) { _plRenderEditor(); return; }

  // V1.2：cache-first 啟動流程
  // 1) 先把 IDB 快取塞回 _pl（離線時這就是唯一資料來源）
  var hadCache = await _plCacheLoadAll();

  // 2) 只要 accessToken 不在記憶體就試 cookie resurrection（codex deep P1）—
  //    不能只看 _pl.user，因為 cache 會把 user 撈回來、看起來「像登入」但其實 token 已被 iOS 清掉，
  //    跳過 refresh 的話 _plApi 全部送出 Bearer undefined 永遠 401。
  if (!_pl.accessToken) {
    var ok = await _plTryRefresh();
    if (!ok && !_pl.user) {
      _plRenderLogin();
      return;
    }
    // refresh 失敗但 _pl.user 還在（cache 撈到的）→ 用快取資料顯示，OFFLINE 條會亮，
    // user 連回網就會自然恢復；若 refresh 回 401 _plTryRefresh 內部已清 session 把 user 也清掉。
  }

  // 3) 用快取（或剛拿到的新 session）立刻 render，不等網路
  if (_pl.tab === 'analyze') { _plRenderAnalyze(); }
  else if (_pl.tab === 'report') { _plRenderReport(); }
  else { _plRenderMain(); _plFetchAll().then(function(ok) {
    // 背景刷新後若 session 已被清（token+cookie 都失效）→ 送回登入，不顯示 stale UI（codex fast P1）
    if (!_pl.user) { _plRenderLogin(); return; }
    // 成功 → 重畫 list 反映新資料（保留 user 互動，不重建整個 split）
    if (ok && _pl.tab === 'logbook' && !_pl.editing) _plRenderList();
  }); }
}
