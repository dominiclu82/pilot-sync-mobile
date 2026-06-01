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
  crewLabels: null,               // V1.3.12 crew 欄位自訂顯示名稱 {pic,crew2,crew3,crew4,cic,obs}；null=用預設
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
  outbox: [],                    // V1.3：離線改動佇列（create/update/delete），回連自動上傳
  syncing: false,                // V1.3：同步進行中旗標（單例保護）
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
  // codex P1：剛確立身分 → 立刻清掉「屬於別人」的待上傳佇列（換帳號情境），不灌錯帳號
  if (typeof _plPurgeForeignOutbox === 'function') _plPurgeForeignOutbox();
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
// V1.3：只存 entries（樂觀更新後快速落地，不必整批重寫）
function _plCacheSaveEntries() { _plIDBSet('entries', _pl.entries); }

// === SECTION: offline outbox + sync ═════════════════════════════════════════
// 離線優先：所有 entry 改動先寫本機（_pl.entries 樂觀更新 + IDB），同時排進 outbox 佇列，
// 再背景同步到 server。有網路就立刻送、離線就排隊，回連自動補送。新航班先給 'local-' 臨時 id，
// 上傳成功後換成 server 正式 id。沿用 CrewSync briefing「server 存、身分當 key = 跨裝置」模型，
// 補上 pilot-log 缺的離線那一半。
function _plUuid() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function _plIsLocalId(id) { return typeof id === 'string' && id.indexOf('local-') === 0; }
function _plOutboxPersist() { _plIDBSet('outbox', _pl.outbox); }
function _plHasPending(id) {
  for (var i = 0; i < _pl.outbox.length; i++) if (_pl.outbox[i].id === id) return true;
  return false;
}
// codex P1：丟掉「屬於別的使用者」的待上傳 op（換 Google 帳號 / 共用裝置），
// 避免拿目前的 token 把前一個人的離線改動灌進現在登入的人。uid=null（離線期間建立、
// 當時 session 物件還沒解出）的視為本機這位、保留。
function _plPurgeForeignOutbox() {
  var uid = _pl.user && _pl.user.id;
  if (!uid || !_pl.outbox.length) return;
  var before = _pl.outbox.length;
  _pl.outbox = _pl.outbox.filter(function(op) { return op.uid == null || op.uid === uid; });
  if (_pl.outbox.length !== before) _plOutboxPersist();
}
// V1.3：離線優先的判斷 — 「現在有網路嗎」「手機裡有沒有可用身分」
function _plOnline() { return typeof navigator === 'undefined' || navigator.onLine !== false; }
function _plHasSession() {
  if (_pl.refreshToken || _pl.accessToken || _pl.user) return true;
  try { return !!(localStorage.getItem(_PL_LS_RT) || localStorage.getItem(_PL_LS_UID)); } catch (e) { return false; }
}

// 把一筆 entry 改動排進佇列（含 collapse 合併，避免同一筆堆一堆 op）
function _plEnqueue(type, id, body) {
  var uid = (_pl.user && _pl.user.id) || null;     // codex P1：op 綁住建立當下的使用者，避免換帳號後灌錯人
  if (type === 'delete') {
    var wasLocal = _plIsLocalId(id);
    // 移除該 id 既有的 create/update（被刪了就不必先建/改）
    _pl.outbox = _pl.outbox.filter(function(op) { return op.id !== id; });
    // 還沒上傳過的 local 新增 → 連 server 都不用碰；真實 id 才排 delete
    if (!wasLocal) _pl.outbox.push({ opId: _plUuid(), type: 'delete', id: id, uid: uid, ts: Date.now(), rev: 1 });
    _plOutboxPersist();
    return;
  }
  // create / update：該 id 已有 pending op 就就地更新 body（合併成最新版），不堆多筆。
  // rev++ 讓同步引擎能偵測「送出後又被改過」→ 不會把較新的編輯誤刪（codex P1）。
  for (var i = 0; i < _pl.outbox.length; i++) {
    if (_pl.outbox[i].id === id && (_pl.outbox[i].type === 'create' || _pl.outbox[i].type === 'update')) {
      _pl.outbox[i].body = body; _pl.outbox[i].ts = Date.now();
      _pl.outbox[i].rev = (_pl.outbox[i].rev || 1) + 1;
      _plOutboxPersist();
      return;
    }
  }
  _pl.outbox.push({ opId: _plUuid(), type: type, id: id, body: body, uid: uid, ts: Date.now(), rev: 1 });
  _plOutboxPersist();
}

// local 臨時 id → server 正式 id（entries 快取 + outbox 其他 op + 選取狀態一起換）
function _plReconcileId(localId, realId) {
  for (var i = 0; i < _pl.entries.length; i++) if (_pl.entries[i].id === localId) _pl.entries[i].id = realId;
  for (var k = 0; k < _pl.outbox.length; k++) if (_pl.outbox[k].id === localId) _pl.outbox[k].id = realId;
  if (_pl.selectedId === localId) _pl.selectedId = realId;
  _plCacheSaveEntries(); _plOutboxPersist();
}

// 同步引擎：依序把 outbox 送 server。單例；離線直接 return（回連再觸發）。
async function _plSync() {
  if (_pl.syncing) return;
  _plRenderSyncStatus();
  if (!_pl.outbox.length) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  _pl.syncing = true;
  _plRenderSyncStatus();
  try {
    // 確保有 token：沒有就試 refresh（離線會失敗 → 保留佇列下次再送）
    if (!_pl.accessToken) { var ok = await _plTryRefresh(); if (!ok) return; }
    _plPurgeForeignOutbox();          // codex P1：只送屬於「目前登入者」的 op，別人的丟掉不灌錯帳號
    while (_pl.outbox.length) {
      var op = _pl.outbox[0];
      var sendingRev = op.rev;                          // 送出當下的版本；回來時若已變 = 期間又被編輯
      var res, done = false, isCreate = (op.type === 'create'), createdId = null;
      try {
        if (op.type === 'create') {
          res = await _plApi('/api/pilot-log/entries', { method: 'POST', body: op.body });
          if (res.ok) {
            var j = await res.json().catch(function() { return {}; });
            createdId = (j && j.entry && j.entry.id != null) ? j.entry.id : (j && j.id);
            done = true;
          }
        } else if (op.type === 'update') {
          res = await _plApi('/api/pilot-log/entries/' + op.id, { method: 'PUT', body: op.body });
          done = res.ok || res.status === 404;        // 404 = server 端已不在，視同處理完
        } else if (op.type === 'delete') {
          res = await _plApi('/api/pilot-log/entries/' + op.id, { method: 'DELETE' });
          done = res.ok || res.status === 404;
        } else { done = true; }                        // 未知 op 丟掉
      } catch (netErr) {
        _plSetOffline(true);                            // 網路斷 → 停止排空，保留佇列回連再送
        break;
      }

      // op 可能在 await 期間被並發的 delete 從佇列移除了（刪掉正在上傳的那筆）→ 用 identity 判斷，不盲目 shift
      var stillQueued = _pl.outbox.indexOf(op) !== -1;

      if (done) {
        if (isCreate && createdId != null) {
          if (stillQueued) {
            _plReconcileId(op.id, createdId);            // temp id → 正式 id（op.id 也一起換）
          } else {
            // 建立成功但上傳途中被刪了 → server 留了孤兒，補一個 delete 清掉，不留髒資料
            _plEnqueue('delete', createdId);
            continue;
          }
        }
        if (!stillQueued) continue;                       // 已被並發移除，這筆無事可做
        // codex P1：送出期間又被編輯（rev 變了）→ 別把較新的編輯誤刪。
        // create 已建好 → 轉成 update（用剛換到的正式 id）重送最新 body；update → 留著重送。
        if (op.rev !== sendingRev && op.type !== 'delete') {
          if (isCreate) op.type = 'update';
          _plOutboxPersist();
          continue;                                       // 不移除，下一圈用最新 body 再送一次
        }
        var di = _pl.outbox.indexOf(op);
        if (di !== -1) { _pl.outbox.splice(di, 1); _plOutboxPersist(); }
      } else {
        var st = res ? res.status : 0;
        // codex P1：暫時性 / 授權問題（5xx / 429 / 408 / 401 / 403）→ 保留佇列，停止本輪回連或重登後再送，
        //           不可丟掉使用者的改動。只有明確的資料錯誤 4xx（400/409/422…）重試也不會過才略過。
        if (st >= 500 || st === 429 || st === 408 || st === 401 || st === 403) break;
        if (stillQueued) {
          var fi = _pl.outbox.indexOf(op);
          if (fi !== -1) { _pl.outbox.splice(fi, 1); _plOutboxPersist(); }
          _plToast('一筆改動被伺服器拒絕（資料問題），已略過', 'error');
        }
      }
    }
  } finally {
    _pl.syncing = false;
  }
  // 排空後跟 server 對帳一次（顯示 server 真實資料）
  if (!_pl.outbox.length && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    try { await _plFetchAll(); } catch (e) {}
    if (_pl.tab === 'logbook' && !_pl.editing) _plRenderList();
  }
  _plRenderSyncStatus();
}

// 同步狀態小列（待上傳幾筆 / 同步中），填進 logbook header 的 #pl-sync-status
function _plRenderSyncStatus() {
  var el = document.getElementById('pl-sync-status');
  if (!el) return;
  if (_pl.syncing) { el.innerHTML = '<span style="color:#3b82f6">🔄 同步中…</span>'; return; }
  var n = _pl.outbox.length;
  el.innerHTML = n
    ? '<span style="color:#f59e0b">⏳ ' + n + ' 筆待上傳' + ((typeof navigator!=='undefined'&&navigator.onLine===false)?'（離線）':'') + '</span>'
    : '';
}

// 從 IDB 撈回填 _pl；回傳是否有任何快取（用來判斷「曾經登入過」）
async function _plCacheLoadAll() {
  var keys = ['entries', 'stats', 'aircraft', 'aircraftTypes', 'crew', 'suggest', 'aircraftEntries', 'user', 'filter', 'outbox'];
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
  if (vals[9] && vals[9].length) { _pl.outbox = vals[9]; any = true; }  // V1.3：未上傳的離線改動
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
  // V1.3.08：filter 改成 client-side（all/past/future/removed 不對應 server status）— fetch 抓全部
  // q stays ''
  try {
    var [eRes, sRes, aRes, qRes, atRes, cRes, mRes] = await Promise.all([
      _plApi('/api/pilot-log/entries' + q),
      _plApi('/api/pilot-log/stats'),
      _plApi('/api/pilot-log/aircraft'),
      _plApi('/api/pilot-log/quick-suggest'),
      _plApi('/api/pilot-log/aircraft-types'),  // V1.0.11
      _plApi('/api/pilot-log/crew'),            // V1.0.11
      _plApi('/api/pilot-log/me'),              // V1.3.12：順便載 crew_labels
    ]);
    if (eRes.ok) { var ej = await eRes.json(); _pl.entries = ej.entries || []; }
    if (sRes.ok) { _pl.stats = await sRes.json(); }
    if (aRes.ok) { var aj = await aRes.json(); _pl.aircraft = aj.aircraft || []; }
    if (qRes.ok) { _pl.suggest = await qRes.json(); }
    if (atRes.ok) { var atj = await atRes.json(); _pl.aircraftTypes = atj.aircraft_types || []; }
    if (cRes.ok) { var cj = await cRes.json(); _pl.crew = cj.crew || []; }
    if (mRes.ok) {
      var mj = await mRes.json();
      _pl.crewLabels = (mj && mj.crew_labels) || null;
      try { localStorage.setItem('pilotlog_crew_labels', JSON.stringify(_pl.crewLabels || {})); } catch (e) {}
    }
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
    // V1.3.08：拿掉 ✓ Confirm All — LogTen 模型沒有 confirm 概念
    '<div style="flex:1"></div>' +
    filterBtn('all', 'All') + filterBtn('done', '已完成 Done') +
    filterBtn('open', '未完成 Open') + filterBtn('removed', '已移除 Removed') +
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
  // V1.3.09：色條改用 in_utc 判斷已完成（user：「已完成綠、未完成藍；未來的跟未完成都是藍色」）
  var statusColor;
  if (e.status === 'roster_removed') statusColor = '#94a3b8';        // gray - removed
  else if (e.in_utc) statusColor = '#10b981';                         // green - done (has actual arrival)
  else statusColor = '#3b82f6';                                       // blue - open (future or past-but-not-logged)

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

  // line 3 機尾/機型 + Flt#（deadhead 標 DH badge 跟普通 flight 區分）
  var acIcon = e.is_deadhead ? '🧳' : ((e.out_utc && e.in_utc) ? '✈' : '🛠');
  var acMeta = acIcon + ' ' + _plEsc(e.tail_no || '') + (e.aircraft_type ? ', ' + _plEsc(e.aircraft_type) : '');
  var dhBadge = e.is_deadhead ? '<span style="background:#a855f7;color:#fff;border-radius:4px;padding:0 5px;font-size:.85em;margin-right:5px;font-weight:700">DH</span>' : '';
  // V1.3：尚未上傳的離線改動標 ⏳，讓使用者看得到哪些還沒同步
  var pendBadge = _plHasPending(e.id) ? '<span title="待上傳 pending sync" style="background:#f59e0b;color:#fff;border-radius:4px;padding:0 5px;font-size:.85em;margin-right:5px;font-weight:700">⏳</span>' : '';
  var lockBadge = e.is_locked ? '<span title="Locked" style="font-size:.95em;margin-right:4px">🔒</span>' : '';
  var fltNo = pendBadge + lockBadge + dhBadge + (e.flight_no ? 'Flt ' + _plEsc(e.flight_no) : '');

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
  // V1.3.08：filter 改成 client-side（all / past / future / removed）
  var shown = _pl.entries.filter(function(e) { return _plEntryMatchesFilter(e, _pl.filter); });
  if (shown.length === 0) {
    c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">' +
      (_pl.filter === 'all'
        ? '尚無紀錄。點 <b>+ New Entry</b> 新增，或 <b>📥 Import</b> 匯入 LogTen Pro 資料。<br>No entries yet — tap <b>+ New Entry</b>, or <b>📥 Import</b> your LogTen Pro data.'
        : '此分類無紀錄。<br>No entries in this filter.') +
    '</div>';
    return;
  }
  c.innerHTML = shown.map(_plRenderEntryRow).join('');
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

// V1.2.05：一鍵把所有 draft 標 confirmed（匯入歷史 logbook 後清草稿用）
async function _plConfirmAllDrafts() {
  if (!window.confirm('把所有「過去日期」的 draft 航班一次標成 confirmed（已飛）？\n（未來日期的計畫航班不會被動到）\n適合匯入歷史 logbook 後清草稿，無法批次還原。\n\nConfirm all PAST-dated draft flights as flown?')) return;
  try {
    var r = await _plApi('/api/pilot-log/entries/confirm-drafts', { method: 'POST' });
    if (!r.ok) { _plToast('操作失敗 ' + r.status, 'error'); return; }
    var j = await r.json();
    _plToast('已 confirm ' + (j.confirmed || 0) + ' 筆');
    await _plRefreshMain();
  } catch (e) {
    _plToast('操作失敗：' + (e && e.message ? e.message : 'unknown'), 'error');
  }
}

// Logbook tab：航班清單 + toolbar（New / Import / Aircraft / Crew）+ 篩選。
// 統計已搬到 Analyze tab。
// iPad（>=768px）：底下用 .pl-split 並排左列表 + 右明細（master-detail）；
// iPhone（<768px）：detail-pane CSS 藏起來，列表撐滿、點一筆走 _plOpenEditor 全螢幕。
function _plRenderMain() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // V1.3 離線優先：只有「有網路且手機裡沒有可用身分」才跳登入（Google 登入本來就要網路）。
  // 離線時即使 _pl.user 物件還沒建好，也照樣顯示快取的 logbook，不卡登入。
  if (!_pl.user && _plOnline() && !_plHasSession()) { _plRenderLogin(); return; }
  _plShowTabBar(true);
  _plHighlightTab('logbook');
  var email = (_pl.user && _pl.user.primaryEmail) || '';
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">' +
        '<div style="font-size:1em;font-weight:700;white-space:nowrap">📒 Logbook</div>' +
        '<div id="pl-sync-status" style="font-size:.65em;flex:1;text-align:center"></div>' +
        '<div style="font-size:.65em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%">' + _plEsc(email) + '</div>' +
      '</div>' +
      '<div id="pl-toolbar">' + _plRenderToolbar() + '</div>' +
      '<div class="pl-split">' +
        '<div class="pl-list-pane"><div id="pl-list"></div></div>' +
        '<div class="pl-detail-pane" id="pl-detail-pane">' + _plDetailPlaceholder() + '</div>' +
      '</div>' +
    '</div>';
  _plRenderList();
  _plRenderSyncStatus();
}

function _plRenderLogin() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  _plShowTabBar(false);
  // V1.3：離線時別顯示按不動的 Google 鈕（OAuth 第一次一定要網路），改提示連網一次
  if (!_plOnline()) {
    c.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;gap:14px">' +
        '<div style="font-size:2.5em">📡</div>' +
        '<div style="font-size:1.1em;font-weight:700">目前離線</div>' +
        '<div style="font-size:.8em;color:var(--muted);max-width:340px;line-height:1.6">' +
          '這台裝置還沒有快取你的 logbook。<br>請先連一次網路登入，之後就能離線使用。<br>' +
          '<span style="opacity:.7">Offline — connect once to sign in and load your logbook, then it works offline.</span>' +
        '</div>' +
      '</div>';
    return;
  }
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
    pic_minutes: null, sic_minutes: null, is_deadhead: false,
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
    _plMigrateLegacyCrew(_pl.editing.crew);   // V1.3.12：舊 crew schema → 新 6 槽（看得到、可編）
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

// 語意分組：固定 N 欄的 grid row（minmax(0,1fr) 允許窄螢幕收縮、不溢出）。
// 取代原本 auto-fit「塞得下就配對」造成的眼花排版。
function _plFieldRow(cols, fieldsHtml) {
  return '<div style="display:grid;grid-template-columns:repeat(' + cols + ',minmax(0,1fr));gap:10px">' + fieldsHtml + '</div>';
}
function _plFieldSub(label) {
  return '<div style="font-size:.58em;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin:10px 0 3px">' + _plEsc(label) + '</div>';
}
// V1.3.12：6 個固定 crew 槽 + 預設顯示名稱（使用者可自訂，存 server）。
var PL_CREW_KEYS = ['pic', 'crew2', 'crew3', 'crew4', 'cic', 'obs'];
var PL_CREW_LABEL_DEFAULT = { pic: 'PIC', crew2: 'Crew 2', crew3: 'Crew 3', crew4: 'Crew 4', cic: 'CIC', obs: 'OBS' };
function _plCrewLabel(key) {
  if (_pl.crewLabels == null) {
    try { var s = localStorage.getItem('pilotlog_crew_labels'); if (s) _pl.crewLabels = JSON.parse(s); } catch (e) {}
  }
  var lbl = _pl.crewLabels && _pl.crewLabels[key];
  return (typeof lbl === 'string' && lbl.trim()) ? lbl.trim() : (PL_CREW_LABEL_DEFAULT[key] || key);
}
// V1.3.12：crew 槽值相容 — 舊資料是純名字字串，新資料是 {name, rank, eid}。一律 normalize。
function _plCrewVal(raw) {
  if (raw == null) return { name: '', rank: '', eid: '' };
  if (typeof raw === 'string') return { name: raw, rank: '', eid: '' };
  return { name: raw.name || '', rank: raw.rank || '', eid: raw.eid || '' };
}
// V1.3.12（codex P1）：把舊 schema 的 crew key 對映到新 6 槽，讓編輯舊紀錄時看得到、可編、不掉資料。
// 只在新槽是空的時候搬；observer2 無對應槽 → 留在物件裡（存檔時 _plSaveEntry 會保留，不丟）。
function _plMigrateLegacyCrew(crew) {
  if (!crew || typeof crew !== 'object') return crew || {};
  var map = { sic: 'crew2', fo1: 'crew3', fo2: 'crew4', purser: 'cic', observer1: 'obs' };
  Object.keys(map).forEach(function(oldK) {
    var newK = map[oldK];
    var hasOld = crew[oldK] != null && crew[oldK] !== '';
    var emptyNew = crew[newK] == null || crew[newK] === '';
    if (hasOld && emptyNew) { crew[newK] = crew[oldK]; delete crew[oldK]; }
  });
  return crew;
}
// 給編輯器 crew 欄位用的通訊錄 datalist（一份，所有 crew input 共用 list=ple-crew-dl）
function _plCrewDatalist() {
  var opts = (_pl.crew || []).map(function(c) {
    var org = c.organization ? (' — ' + c.organization) : '';
    return '<option value="' + _plEsc(c.display_name || '') + '">' + _plEsc((c.display_name || '') + org) + '</option>';
  }).join('');
  return '<datalist id="ple-crew-dl">' + opts + '</datalist>';
}
// 用顯示名字回查員編：通訊錄剛好 1 筆同名且有員編 → 回該員編，否則空（不猜）
function _plResolveEid(name) {
  if (!name) return '';
  var hit = (_pl.crew || []).filter(function(c) { return (c.display_name || '') === name; });
  if (hit.length === 1 && hit[0].employee_ids && hit[0].employee_ids.length) return hit[0].employee_ids[0];
  return '';
}
// V1.3.12：Crew 頁的「欄位名稱」設定（折疊）。static input，存檔才送 server，不踩搜尋的 focus bug。
function _plCrewLabelsEditor() {
  var inputCss = 'flex:1;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:5px 8px;font-size:.78em;box-sizing:border-box';
  var rows = PL_CREW_KEYS.map(function(k) {
    return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">' +
      '<span style="font-size:.6em;color:var(--muted);width:46px;flex-shrink:0">' + k + '</span>' +
      '<input id="pl-cl-' + k + '" value="' + _plEsc(_plCrewLabel(k)) + '" placeholder="' + _plEsc(PL_CREW_LABEL_DEFAULT[k]) + '" maxlength="24" style="' + inputCss + '">' +
    '</div>';
  }).join('');
  var btnCss = 'border:0;border-radius:6px;padding:6px 12px;font-size:.75em;font-weight:700;cursor:pointer';
  return '<details style="margin-bottom:10px;background:var(--card);border-radius:8px;padding:8px 10px">' +
    '<summary style="font-size:.72em;font-weight:700;color:var(--muted);cursor:pointer">⚙ 欄位名稱 / Crew field labels</summary>' +
    '<div style="font-size:.62em;color:var(--muted);margin:6px 0 8px">改成你公司的稱呼（JX=CIC、EVA=CP…），套用到航班編輯器的 crew 欄位、跨裝置同步。<br>Rename to your airline\'s terms; applies to the flight editor, synced across devices.</div>' +
    rows +
    '<div style="display:flex;gap:8px;margin-top:6px">' +
      '<button onclick="_plSaveCrewLabels()" style="background:#10b981;color:#fff;' + btnCss + '">儲存 Save</button>' +
      '<button onclick="_plResetCrewLabels()" style="background:transparent;color:var(--muted);border:1px solid var(--border,#334155)!important;' + btnCss + '">恢復預設 Reset</button>' +
    '</div>' +
  '</details>';
}
async function _plSaveCrewLabels() {
  var body = {};
  PL_CREW_KEYS.forEach(function(k) {
    var el = document.getElementById('pl-cl-' + k);
    if (el && el.value.trim()) body[k] = el.value.trim().slice(0, 24);
  });
  try {
    var r = await _plApi('/api/pilot-log/crew-labels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
    });
    if (!r.ok) { _plToast('儲存失敗 ' + r.status, 'error'); return; }
    var j = await r.json();
    _pl.crewLabels = (j && j.crew_labels) || {};
    try { localStorage.setItem('pilotlog_crew_labels', JSON.stringify(_pl.crewLabels)); } catch (e) {}
    _plToast('欄位名稱已儲存');
  } catch (e) {
    _plToast('儲存失敗：' + (e && e.message ? e.message : 'unknown'), 'error');
  }
}
async function _plResetCrewLabels() {
  PL_CREW_KEYS.forEach(function(k) {
    var el = document.getElementById('pl-cl-' + k);
    if (el) el.value = PL_CREW_LABEL_DEFAULT[k];
  });
  await _plSaveCrewLabels();
}
// crew.X 是 JSONB 巢狀欄位，用專屬 input id ple-crew-X（名字）/ ple-crewrank-X（rank）/ ple-crewid-X（員編 hidden），跟 _plSaveEntry 讀法對齊
function _plCrewField(key, e) {
  var val = _plCrewVal(e.crew && e.crew[key]);
  var label = _plCrewLabel(key);
  var inputCss = 'background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em';
  return '<div style="margin-bottom:8px">' +
    '<div style="font-size:.62em;color:var(--muted);margin-bottom:2px">' + _plEsc(label) + '</div>' +
    '<div style="display:flex;gap:4px">' +
      '<input id="ple-crew-' + key + '" list="ple-crew-dl" placeholder="name" style="flex:1;' + inputCss + '" value="' + _plEsc(val.name) + '">' +
      '<input id="ple-crewrank-' + key + '" placeholder="rank" style="width:62px;text-transform:uppercase;' + inputCss + '" value="' + _plEsc(val.rank) + '">' +
    '</div>' +
    '<input type="hidden" id="ple-crewid-' + key + '" value="' + _plEsc(val.eid) + '">' +
    '<input type="hidden" id="ple-crewname0-' + key + '" value="' + _plEsc(val.name) + '"></div>';  // 原始名字：判斷名字有沒有被改過，改過就不沿用舊員編
}

// ── V1.3.05：機場座標 + 太陽角度，給手動新增航班自動算 night time / 日夜起降 ─────────
// day/night 判斷對座標 ±0.5° 已綽綽有餘（民用曙暮光：sun alt 過 -6° 才算夜）。
// 太陽公式已用 RCTP/KLAX 已知值驗證（誤差 < 0.5°）。查不到的機場 → 留空讓使用者手填，不會亂判。
var _PL_APT = {
  // Taiwan
  RCTP: [25.08, 121.23], RCSS: [25.07, 121.55], RCKH: [22.58, 120.35], RCMQ: [24.27, 120.62], RCBS: [24.43, 118.36],
  // Japan
  RJAA: [35.76, 140.39], RJBB: [34.43, 135.23], RJCC: [42.78, 141.69], RJSS: [38.14, 140.92], RJFF: [33.59, 130.45],
  RJGG: [34.86, 136.81], RJSN: [37.95, 139.12], RJEC: [43.67, 142.45], RJSA: [40.73, 140.69], RJCH: [41.77, 140.82],
  RJNK: [36.39, 136.41], ROAH: [26.20, 127.65],
  // Korea
  RKSI: [37.46, 126.44], RKSS: [37.56, 126.79],
  // HK / Macau
  VHHH: [22.31, 113.91], VMMC: [22.16, 113.59],
  // China
  ZBAA: [40.08, 116.58], ZBHH: [40.85, 111.82], ZBSJ: [38.28, 114.70], ZBTJ: [39.12, 117.35], ZBYN: [37.75, 112.63],
  ZGGG: [23.39, 113.30], ZGHA: [28.19, 113.22], ZGKL: [25.22, 110.04], ZGSZ: [22.64, 113.81], ZHCC: [34.52, 113.84],
  ZLXY: [34.45, 108.75], ZPPP: [25.10, 102.93], ZSAM: [24.54, 118.13], ZSHC: [30.23, 120.43], ZSJN: [36.86, 117.22],
  ZSNB: [29.83, 121.46], ZSNJ: [31.74, 118.86], ZSPD: [31.14, 121.81], ZSQD: [36.37, 120.10], ZSWX: [31.49, 120.43],
  ZSYN: [33.43, 120.20], ZSTX: [29.73, 118.26], ZUUU: [30.58, 103.95], ZUCK: [29.72, 106.64], ZYHB: [45.62, 126.25],
  // SE Asia
  VTBS: [13.69, 100.75], VDPP: [11.55, 104.84], VVTS: [10.82, 106.65], VVNB: [21.22, 105.81],
  WMKK: [2.75, 101.71], WMKP: [5.30, 100.27], WIII: [-6.13, 106.66], WARR: [-7.38, 112.78], WSSS: [1.36, 103.99],
  // Philippines
  RPLL: [14.51, 121.02], RPVM: [10.31, 123.98],
  // US
  KATL: [33.64, -84.43], KDFW: [32.90, -97.04], KEWR: [40.69, -74.17], KIAH: [29.98, -95.34], KJFK: [40.64, -73.78],
  KLAX: [33.94, -118.41], KONT: [34.06, -117.60], KORD: [41.98, -87.90], KPHX: [33.43, -112.01], KSEA: [47.45, -122.31],
  KSFO: [37.62, -122.38], PANC: [61.17, -149.99],
  // Canada
  CYYZ: [43.68, -79.61], CYVR: [49.19, -123.18],
  // Europe
  EGLL: [51.47, -0.46], LFPG: [49.01, 2.55], EHAM: [52.31, 4.76], LOWW: [48.11, 16.57],
  // Australia
  YBBN: [-27.38, 153.12],
};

// 太陽高度角（degrees）；driven by Julian day → ecliptic longitude → declination → hour angle
function _plSunAlt(lat, lon, d) {
  var rad = Math.PI / 180;
  var J = d.getTime() / 86400000 + 2440587.5, n = J - 2451545.0;
  var L = (280.460 + 0.9856474 * n) % 360;
  var g = ((357.528 + 0.9856003 * n) % 360) * rad;
  var lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  var eps = 23.439 * rad;
  var decl = Math.asin(Math.sin(eps) * Math.sin(lam));
  var GMST = (280.46061837 + 360.98564736629 * n) % 360;
  var LST = (GMST + lon) % 360;
  var RA = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / rad;
  var HA = (((LST - RA) % 360 + 360) % 360) * rad;
  var la = lat * rad;
  return Math.asin(Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(HA)) / rad;
}
function _plIsNight(lat, lon, d) { return _plSunAlt(lat, lon, d) < -6; }   // 民用曙暮光：太陽低於 -6° 算夜

// 大圓內插（球面 slerp）：fraction f∈[0,1] 從 A 到 B
function _plGcInterp(A, B, f) {
  var rad = Math.PI / 180, deg = 180 / Math.PI;
  var la1 = A[0] * rad, lo1 = A[1] * rad, la2 = B[0] * rad, lo2 = B[1] * rad;
  var d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((la2 - la1) / 2), 2) +
    Math.cos(la1) * Math.cos(la2) * Math.pow(Math.sin((lo2 - lo1) / 2), 2)));
  if (d === 0 || isNaN(d)) return [A[0], A[1]];
  var sA = Math.sin((1 - f) * d) / Math.sin(d), sB = Math.sin(f * d) / Math.sin(d);
  var x = sA * Math.cos(la1) * Math.cos(lo1) + sB * Math.cos(la2) * Math.cos(lo2);
  var y = sA * Math.cos(la1) * Math.sin(lo1) + sB * Math.cos(la2) * Math.sin(lo2);
  var z = sA * Math.sin(la1) + sB * Math.sin(la2);
  return [Math.atan2(z, Math.sqrt(x * x + y * y)) * deg, Math.atan2(y, x) * deg];
}

// 沿大圓取樣，算航路夜航分鐘；null = 無法算（缺座標 / 時間）
function _plRouteNightMin(origin, dest, offD, onD) {
  var A = _PL_APT[origin], B = _PL_APT[dest];
  if (!A || !B || !offD || !onD) return null;
  var ms = onD.getTime() - offD.getTime();
  if (ms <= 0) return 0;
  var totalMin = ms / 60000;
  var steps = Math.max(6, Math.min(120, Math.round(totalMin / 5)));   // ~5 分一點，最少 6 點
  var nights = 0;
  for (var i = 0; i <= steps; i++) {
    var f = i / steps, p = _plGcInterp(A, B, f), t = new Date(offD.getTime() + f * ms);
    if (_plIsNight(p[0], p[1], t)) nights++;
  }
  return Math.round(totalMin * nights / (steps + 1));
}
function _plLegDayNight(apt, dt) {
  var A = _PL_APT[apt]; if (!A || !dt) return null;
  return _plIsNight(A[0], A[1], dt) ? 'night' : 'day';
}
// 從 editor 欄位組出 Off/On 的 UTC Date（含跨午夜修正）
function _plEditorOffOn() {
  var dt = _plGetVal('ple-flight_date');
  var off = _plGetVal('ple-off_utc'), on = _plGetVal('ple-on_utc');
  if (!dt || !off || !on) return null;
  var offIso = _plMakeUtcIso(dt, String(off).trim());
  var onIso = _plMakeUtcIso(dt, String(on).trim());
  if (!offIso || !onIso) return null;
  var offD = new Date(offIso), onD = new Date(onIso);
  if (onD.getTime() < offD.getTime()) onD = new Date(onD.getTime() + 24 * 3600 * 1000);
  return [offD, onD];
}

// ── V1.3.02：智慧編輯器自動計算 ──────────────────────────────────────────────
// block/air 由 OOOI 帶、PIC/SIC 由 position 帶、pilot flying 帶起降、機型篩 tail。
// 只改 input.value，存檔仍走 _plReadField（不另存狀態）。
function _plHHMMtoMin(v) {                        // 解析 OOOI 的 4 位 HHMM（無冒號）
  var s = String(v == null ? '' : v).trim().replace(':', '');
  if (!/^\d{3,4}$/.test(s)) return null;
  while (s.length < 4) s = '0' + s;
  var h = parseInt(s.slice(0, 2), 10), m = parseInt(s.slice(2), 10);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
function _plDurDiff(a, b) { if (a == null || b == null) return null; var d = b - a; if (d < 0) d += 1440; return d; }  // 跨午夜 +24h
function _plSetVal(id, v) { var el = document.getElementById(id); if (el) el.value = v; }
function _plGetVal(id) { var el = document.getElementById(id); return el ? el.value : ''; }

function _plAutoCalcTimes() {
  var out = _plHHMMtoMin(_plGetVal('ple-out_utc')), inn = _plHHMMtoMin(_plGetVal('ple-in_utc'));
  var off = _plHHMMtoMin(_plGetVal('ple-off_utc')), on = _plHHMMtoMin(_plGetVal('ple-on_utc'));
  var outRaw = _plGetVal('ple-out_utc').trim(), inRaw = _plGetVal('ple-in_utc').trim();
  var offRaw = _plGetVal('ple-off_utc').trim(), onRaw = _plGetVal('ple-on_utc').trim();
  // 兩端都有效 → 算；OOOI 區動過（任一端有字）但算不出 → 清掉舊值避免與畫面不符（codex P2）。
  // 兩端都空 → 完全不碰 block（保留純手填 block 的工作流）。
  if (out != null && inn != null) _plSetVal('ple-block_minutes', _plMinToHHMM(_plDurDiff(out, inn)));
  else if (outRaw || inRaw) _plSetVal('ple-block_minutes', '');
  if (off != null && on != null) _plSetVal('ple-air_minutes', _plMinToHHMM(_plDurDiff(off, on)));
  else if (offRaw || onRaw) _plSetVal('ple-air_minutes', '');
  _plAutoCalcRole();                              // block 變了 → PIC/SIC 跟著（含清空）

  // V1.3.05：航路 night 分鐘 — 手動改過的不覆寫；座標 / 時間不完整 → 清掉 stale auto（codex P2）
  var oo = _plEditorOffOn();
  var origin = (_plGetVal('ple-origin') || '').toUpperCase().trim();
  var dest = (_plGetVal('ple-dest') || '').toUpperCase().trim();
  var nEl = document.getElementById('ple-night_minutes');
  if (nEl && nEl.dataset.manual !== '1') {
    var nm = (oo && origin && dest) ? _plRouteNightMin(origin, dest, oo[0], oo[1]) : null;
    if (nm != null) nEl.value = _plMinToHHMM(nm);
    else if (offRaw || onRaw || origin || dest) nEl.value = '';   // 不完整 / 查無座標 → 清舊值；完全空才不碰
  }
  // 路線變化時也順手讓 day/night 起降 re-evaluate（解 codex P1：先勾 PF 後填路線的情境）
  _plAutoCalcLandings();
}
// 只在「沒被手動改過」時才覆寫 PIC/SIC（dataset.manual 由 _plWireEditor 標記）— 自動帶但保留手填
function _plSetRoleField(id, val) {
  var el = document.getElementById(id);
  if (el && el.dataset.manual !== '1') el.value = val;
}
function _plAutoCalcRole() {
  var pos = _plGetVal('ple-position');
  var blockStr = _plGetVal('ple-block_minutes').trim();      // 直接沿用 block 欄目前值（可能為空）
  // 角色互斥（codex P1）：目前角色 = block、另一個清空；blank / OBSERVER 兩者都清，避免雙重計算。
  // 但手動改過的欄位不覆寫（codex fast P1：自動帶之後改 OOOI 不該把手填的 PIC/SIC 蓋掉）。
  _plSetRoleField('ple-pic_minutes', pos === 'PIC' ? blockStr : '');
  _plSetRoleField('ple-sic_minutes', pos === 'SIC' ? blockStr : '');
}
function _plAutoCalcLandings() {
  var pf = document.getElementById('ple-pilot_flying');
  if (!pf || !pf.checked) return;
  // codex P1：路線/時間還不完整時，「不要先塞 1 day」— 否則 any-guard 會擋掉之後正確的日/夜重算。
  // 之後 origin/dest/OOOI 補齊時，_plAutoCalcTimes 末尾會再呼叫一次本函式（這次有資料就算對）。
  var oo = _plEditorOffOn();
  var origin = (_plGetVal('ple-origin') || '').toUpperCase().trim();
  var dest = (_plGetVal('ple-dest') || '').toUpperCase().trim();
  if (!oo || !origin || !dest) return;
  var ids = ['ple-day_takeoffs', 'ple-night_takeoffs', 'ple-day_landings', 'ple-night_landings'];
  var any = ids.some(function(id) { var el = document.getElementById(id); return el && Number(el.value) > 0; });
  if (any) return;
  // 起飛看 origin@Off、落地看 dest@On；座標查不到的機場 → 預設日間（使用者可手改）
  var toNight = (_plLegDayNight(origin, oo[0]) === 'night');
  var ldgNight = (_plLegDayNight(dest, oo[1]) === 'night');
  _plSetVal(toNight ? 'ple-night_takeoffs' : 'ple-day_takeoffs', '1');
  _plSetVal(ldgNight ? 'ple-night_landings' : 'ple-day_landings', '1');
}
// 依目前選的機型回傳 tail 清單；永遠含目前值
function _plTailOptionsFor(type, current) {
  var opts = [''];
  var all = (_pl.aircraft || []);
  if (type) {
    // 選了機型 → 只列機尾庫裡 type_code 相符的，不混入其他型 / suggest（V1.3.03 修：之前會倒入全部）
    all.forEach(function(a) { if (a.tail_no && a.type_code === type) opts.push(a.tail_no); });
    // 該機型在機尾庫完全沒有相符機尾 → 退回「整個機尾庫」避免空 select 卡住手動新增（codex P2）；
    // 仍不退回 suggest（那才是之前「亂七八糟混進去」的來源）。正常情況有相符 → 維持嚴格只列該型。
    if (opts.length <= 1) all.forEach(function(a) { if (a.tail_no) opts.push(a.tail_no); });
  } else {
    // 沒選機型 → 全部機尾庫 + 常用 suggest
    all.forEach(function(a) { if (a.tail_no) opts.push(a.tail_no); });
    opts = opts.concat(_pl.suggest.tail_nos || []);
  }
  if (current && opts.indexOf(current) < 0) opts.push(current);  // 目前值一定保留（即使不符目前機型）
  return Array.from(new Set(opts));
}
function _plRefilterTails() {
  var sel = document.getElementById('ple-tail_no');
  if (!sel) return;
  var cur = sel.value;
  var opts = _plTailOptionsFor(_plGetVal('ple-aircraft_type'), cur);
  sel.innerHTML = opts.map(function(o) {
    return '<option value="' + _plEsc(o) + '"' + (o === cur ? ' selected' : '') + '>' + _plEsc(o || '—') + '</option>';
  }).join('');
}
// 每次 _plRenderEditor 重畫後重掛 input/change 監聽（DOM 換新）
function _plWireEditor() {
  // V1.3.08：上鎖的航班 — 所有編輯欄位 disabled；Lock 按鈕仍可用以解鎖
  if (_pl.editing && _pl.editing.is_locked) {
    ['input', 'select', 'textarea'].forEach(function(tag) {
      var els = document.querySelectorAll(tag);
      for (var i = 0; i < els.length; i++) {
        var id = els[i].id || '';
        if (id.indexOf('ple-') === 0 || id.indexOf('ple-crew-') === 0) els[i].disabled = true;
      }
    });
    return;   // 鎖了就不掛 auto-calc 監聽（沒意義 — 改不動）
  }
  ['out_utc', 'off_utc', 'on_utc', 'in_utc'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) el.addEventListener('input', _plAutoCalcTimes);
  });
  var pos = document.getElementById('ple-position');
  if (pos) pos.addEventListener('change', _plAutoCalcRole);
  var pf = document.getElementById('ple-pilot_flying');
  if (pf) pf.addEventListener('change', _plAutoCalcLandings);
  var ty = document.getElementById('ple-aircraft_type');
  if (ty) ty.addEventListener('change', _plRefilterTails);
  // 標記 PIC/SIC/Night 是否被手動改過 → 之後就不覆寫（codex fast P1 + V1.3.05 night）
  ['pic_minutes', 'sic_minutes', 'night_minutes'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) el.addEventListener('input', function() { el.dataset.manual = '1'; });
  });
  // V1.3.05：origin / dest / flight_date 變更也觸發夜航計算（不只 OOOI）
  ['origin', 'dest', 'flight_date'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) el.addEventListener('input', _plAutoCalcTimes);
  });
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
  // V1.3.09：badge 改用 in_utc 判斷已完成（roster_removed → 灰；in_utc 有 → 綠 done；其餘 → 藍 open）
  var statusBadge = '';
  if (e.id) {
    if (e.status === 'roster_removed') {
      statusBadge = '<span style="background:#94a3b8;color:#fff;border-radius:10px;padding:2px 8px;font-size:.62em;margin-left:8px">removed</span>';
    } else if (e.in_utc) {
      statusBadge = '<span style="background:#10b981;color:#fff;border-radius:10px;padding:2px 8px;font-size:.62em;margin-left:8px">flown 已完成</span>';
    } else {
      statusBadge = '<span style="background:#3b82f6;color:#fff;border-radius:10px;padding:2px 8px;font-size:.62em;margin-left:8px">open 未完成</span>';
    }
    if (e.is_locked) statusBadge += '<span style="margin-left:6px;font-size:.85em" title="Locked">🔒</span>';
  }

  var typeOptions = ['', 'A321', 'A359', 'A35K', 'B777-300ER', 'B789', 'B78X'].concat(_pl.suggest.aircraft_types || []);
  typeOptions = Array.from(new Set(typeOptions));
  // V1.3.02：Tail # 依目前機型篩選（選了機型只跳該型機尾，不再全部顯示）。
  // 要新增機尾到清單 → 去 ✈️ Aircraft 頁的 + Add Aircraft（或匯入 LogTen Aircraft）。
  var tailOptions = _plTailOptionsFor(e.aircraft_type, e.tail_no);

  c.innerHTML =
    '<div style="padding:10px 14px">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
      '<button onclick="_plCloseEditor()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">' + closeLabel + '</button>' +
      '<div style="font-size:1em;font-weight:700">' + (e.id ? 'Edit Entry' : 'New Entry') + '</div>' + statusBadge +
      '<div style="flex:1"></div>' +
      // V1.3.08：拿掉 Confirm — Save 就是 Save。Lock 鈕（LogTen 風格）：鎖了不能改/不能刪；點一下解鎖
      (e.id ? '<button onclick="_plToggleLock()" style="background:transparent;color:' + (e.is_locked ? '#10b981' : 'var(--muted)') + ';border:1px solid ' + (e.is_locked ? '#10b981' : 'var(--border,#334155)') + ';border-radius:6px;padding:6px 10px;font-size:.74em;cursor:pointer">' + (e.is_locked ? '🔒 Locked' : '🔓 Lock') + '</button>' : '') +
      (!e.is_locked ? '<button onclick="_plSaveEntry()" style="background:#3b82f6;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Save</button>' : '') +
      (e.id && !e.is_locked ? '<button onclick="_plDeleteEntry()" style="background:transparent;color:#ef4444;border:1px solid #ef4444;border-radius:6px;padding:6px 10px;font-size:.74em;cursor:pointer">Delete</button>' : '') +
    '</div>' +

    // ── Flight：Date+Flight# / From+To / Type+Tail+Position ──
    '<div style="background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Flight</div>' +
      _plFieldRow(2, _plEditorField('Date', 'flight_date', 'date') + _plEditorField('Flight #', 'flight_no', 'text')) +
      _plFieldRow(2, _plEditorField('From (ICAO)', 'origin', 'text') + _plEditorField('To (ICAO)', 'dest', 'text')) +
      _plFieldRow(3, _plEditorField('Aircraft Type', 'aircraft_type', 'select', { options: typeOptions }) +
        _plEditorField('Tail #（清單來自 ✈️ Aircraft）', 'tail_no', 'select', { options: tailOptions }) +
        _plEditorField('Position', 'position', 'select', { options: ['', 'PIC', 'SIC', 'OBSERVER'] })) +
      _plEditorField('Deadhead', 'is_deadhead', 'check', { checkLabel: 'Deadhead / positioning（我是乘客、非操作 — 不算 PIC/SIC 與起降）' }) +
    '</div>' +

    // ── Times：Scheduled 一行 / OOOI 一行 / Duty 一行 ──
    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:2px">Times (UTC HHMM)</div>' +
      _plFieldSub('Scheduled') +
      _plFieldRow(2, _plEditorField('Sched Out', 'std_utc', 'time-utc') + _plEditorField('Sched In', 'sta_utc', 'time-utc')) +
      _plFieldSub('Actual · OOOI') +
      _plFieldRow(4, _plEditorField('Out', 'out_utc', 'time-utc') + _plEditorField('Off', 'off_utc', 'time-utc') +
        _plEditorField('On', 'on_utc', 'time-utc') + _plEditorField('In', 'in_utc', 'time-utc')) +
      _plFieldSub('Duty') +
      _plFieldRow(2, _plEditorField('On Duty', 'on_duty_utc', 'time-utc') + _plEditorField('Off Duty', 'off_duty_utc', 'time-utc')) +
    '</div>' +

    // ── Hours：時數獨立區，不再跟 OOOI 混在一起 ──
    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Hours</div>' +
      _plFieldRow(3, _plEditorField('Block', 'block_minutes', 'hhmm-dur') + _plEditorField('Air', 'air_minutes', 'hhmm-dur') +
        _plEditorField('Night', 'night_minutes', 'hhmm-dur')) +
      _plFieldRow(2, _plEditorField('PIC Time', 'pic_minutes', 'hhmm-dur') +
        _plEditorField('SIC Time', 'sic_minutes', 'hhmm-dur')) +
      _plFieldRow(2, _plEditorField('Total Duty', 'total_duty_minutes', 'hhmm-dur') +
        _plEditorField('Distance (NM)', 'distance_nm', 'number', { step: '0.1' })) +
      _plEditorField('Pilot Flying', 'pilot_flying', 'check', { checkLabel: 'I was the Pilot Flying' }) +
    '</div>' +

    // ── Take-offs / Landings：日/夜成對 ──
    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Take-offs / Landings</div>' +
      _plFieldRow(2, _plEditorField('Day T/O', 'day_takeoffs', 'number') + _plEditorField('Night T/O', 'night_takeoffs', 'number')) +
      _plFieldRow(2, _plEditorField('Day Ldg', 'day_landings', 'number') + _plEditorField('Night Ldg', 'night_landings', 'number')) +
      _plFieldRow(2, _plEditorField('Autolands', 'autolands', 'number') + _plEditorField('Pax', 'pax_count', 'number')) +
    '</div>' +

    // ── Crew：駕駛艙 PIC / Crew2-4，客艙 CIC / OBS（V1.3.12；欄位名可在 Crew 頁自訂）──
    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Crew</div>' +
      _plCrewDatalist() +
      _plFieldRow(2, _plCrewField('pic', e) + _plCrewField('crew2', e)) +
      _plFieldRow(2, _plCrewField('crew3', e) + _plCrewField('crew4', e)) +
      _plFieldRow(2, _plCrewField('cic', e) + _plCrewField('obs', e)) +
    '</div>' +

    // ── Other：SID+STAR / Remarks ──
    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Other</div>' +
      _plFieldRow(2, _plEditorField('SID', 'sid', 'text') + _plEditorField('STAR', 'star', 'text')) +
      _plEditorField('Remarks', 'remarks', 'textarea') +
    '</div>' +

    '<div style="height:30px"></div>' +
    '</div>';

  _plWireEditor();   // V1.3.02：掛上 OOOI→block/air、position→PIC/SIC、pilot flying→起降、機型→篩 tail 的自動計算
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

// V1.3.08：LogTen 模型 — Save 就是 Save，沒有 Confirm 步驟。是否「飛了」用 flight_date 隱含判斷。
async function _plSaveEntry() {
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
    pic_minutes: _plReadField('pic_minutes', 'hhmm-dur'),
    sic_minutes: _plReadField('sic_minutes', 'hhmm-dur'),
    is_deadhead: !!_plReadField('is_deadhead'),
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

  // V1.3.12：6 槽，每槽存 {name, rank, eid}。員編優先用 hidden（roster 帶的/原本的），
  // 名字若對得到通訊錄唯一同名聯絡人就用那個員編（手動選了已知聯絡人 → 自動連結）。
  // codex P1：先保留「沒被新 UI 渲染的舊 key」（如 observer2），避免編輯舊紀錄存檔時掉資料。
  var crew = {};
  var prevCrew = (_pl.editing && _pl.editing.crew) || {};
  Object.keys(prevCrew).forEach(function(k) {
    if (PL_CREW_KEYS.indexOf(k) < 0 && prevCrew[k] != null && prevCrew[k] !== '') crew[k] = prevCrew[k];
  });
  PL_CREW_KEYS.forEach(function(k) {
    var nameEl = document.getElementById('ple-crew-' + k);
    var name = nameEl ? nameEl.value.trim() : '';
    if (!name) return;
    var rankEl = document.getElementById('ple-crewrank-' + k);
    var idEl = document.getElementById('ple-crewid-' + k);
    var name0El = document.getElementById('ple-crewname0-' + k);
    var rank = rankEl ? rankEl.value.trim().toUpperCase() : '';
    // codex P1：名字改過就不准沿用舊員編（避免新名字揹到前一個人的員編）。
    // 先用通訊錄唯一同名回查；查不到才在「名字沒被改過」時沿用原本員編。
    var eid = _plResolveEid(name);
    if (!eid && name0El && name === name0El.value.trim() && idEl) eid = idEl.value.trim();
    var slot = { name: name };
    if (rank) slot.rank = rank;
    if (eid) slot.eid = eid;
    crew[k] = slot;
  });
  body.crew = crew;

  // V1.3.08：新 manual entry 直接 status='confirmed'（LogTen 模型 — 寫好就是寫好）；
  //          編輯既有 entry 不動 status（用 flight_date 隱含「飛了沒」）
  var isNew = !e.id;
  if (isNew) body.status = 'confirmed';

  // V1.3：離線優先 — 先寫本機（_pl.entries 樂觀更新 + IDB）+ 排進 outbox，再背景同步。
  // 線上也走這條：飛機上斷斷續續的網路不會掉資料，回連自動補送。
  var id = e.id || ('local-' + _plUuid());
  var statusForCache = isNew ? 'confirmed' : (e.status || 'confirmed');
  var cached = {};
  for (var kk in body) { if (Object.prototype.hasOwnProperty.call(body, kk)) cached[kk] = body[kk]; }
  cached.id = id;
  cached.status = statusForCache;
  cached.is_locked = !!e.is_locked;                       // 保留 lock 狀態（save 不會改變鎖定）
  cached.source = e.source || 'manual';

  // V1.3.08：filter 改成日期 / status 為基底（all / past / future / removed），保留視圖一致
  var matchesFilter = _plEntryMatchesFilter(cached, _pl.filter);
  var fidx = -1;
  for (var i = 0; i < _pl.entries.length; i++) { if (_pl.entries[i].id === id) { fidx = i; break; } }
  if (fidx >= 0) {
    if (matchesFilter) _pl.entries[fidx] = cached; else _pl.entries.splice(fidx, 1);
  } else if (matchesFilter) {
    _pl.entries.unshift(cached);
  }
  // Aircraft/Crew 頁的完整快照若已載入，也同步更新，避免顯示舊資料
  if (_pl.aircraftEntries) {
    var hit = false;
    for (var ai = 0; ai < _pl.aircraftEntries.length; ai++) {
      if (_pl.aircraftEntries[ai].id === id) { _pl.aircraftEntries[ai] = cached; hit = true; break; }
    }
    if (!hit) _pl.aircraftEntries.unshift(cached);
    _plCacheSaveAircraftEntries();
  }
  _plCacheSaveEntries();
  _plEnqueue(isNew ? 'create' : 'update', id, body);

  _pl.editing = null;
  _pl.selectedId = null;          // iPad detail pane 的選取也清掉，_plRenderMain 會重建成 placeholder
  _plToast('Saved');
  _plRenderMain();
  _plSync();                       // 背景同步，不 await（離線會排隊，回連自動補送）
}

// V1.3.08：lock toggle — 直接 PUT（不走 outbox；lock 是管理操作，需連網）。鎖了就不能 edit/delete。
async function _plToggleLock() {
  var e = _pl.editing;
  if (!e || !e.id) return;
  if (_plIsLocalId(e.id)) { _plToast('先存檔再上鎖', 'error'); return; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    _plToast('🔒 鎖定切換需要連網路', 'error'); return;
  }
  var newLocked = !e.is_locked;
  try {
    var r = await _plApi('/api/pilot-log/entries/' + e.id, { method: 'PUT', body: { is_locked: newLocked } });
    if (!r.ok) {
      var ej = await r.json().catch(function() { return {}; });
      _plToast('鎖定切換失敗 ' + (ej.error || r.status), 'error'); return;
    }
    e.is_locked = newLocked;
    for (var i = 0; i < _pl.entries.length; i++) if (_pl.entries[i].id === e.id) _pl.entries[i].is_locked = newLocked;
    if (_pl.aircraftEntries) for (var ai = 0; ai < _pl.aircraftEntries.length; ai++)
      if (_pl.aircraftEntries[ai].id === e.id) _pl.aircraftEntries[ai].is_locked = newLocked;
    _plCacheSaveEntries();
    _plToast(newLocked ? '🔒 Locked' : '🔓 Unlocked');
    // 重畫 editor 反映 lock 狀態（按鈕變、Delete 隱/現）
    var inDetail = !!(document.getElementById('pl-detail-pane') && document.getElementById('pl-detail-pane').contains(document.getElementById('ple-flight_date')));
    _plRenderEditor(inDetail ? 'pl-detail-pane' : 'pilotlog-content');
    _plRenderList();
  } catch (err) {
    _plToast('鎖定切換失敗', 'error');
  }
}

// V1.3.09：done / open 改用 in_utc 判斷（user：「未來的跟未完成都是藍色」）。
// 沒填 in_utc = 未完成（未來計畫的、或飛了還沒補實際時間的）；有 in_utc = 已完成（已抵達、已記錄）。
function _plEntryMatchesFilter(e, filter) {
  if (filter === 'all') return true;
  if (filter === 'removed') return e.status === 'roster_removed';
  if (e.status === 'roster_removed') return false;
  if (filter === 'done') return !!e.in_utc;
  if (filter === 'open') return !e.in_utc;
  return true;
}

async function _plDeleteEntry() {
  var e = _pl.editing;
  if (!e || !e.id) return;
  if (!window.confirm('Delete this entry?')) return;
  var id = e.id;
  // V1.3：離線優先 — 先從本機移除 + 排 delete。還沒上傳過的 local 新增，_plEnqueue 會直接丟掉不碰 server。
  _pl.entries = _pl.entries.filter(function(x) { return x.id !== id; });
  if (_pl.aircraftEntries) _pl.aircraftEntries = _pl.aircraftEntries.filter(function(x) { return x.id !== id; });
  _plCacheSaveEntries();
  if (_pl.aircraftEntries) _plCacheSaveAircraftEntries();
  _plEnqueue('delete', id);
  _pl.editing = null;
  _pl.selectedId = null;
  _plToast('Deleted');
  _plRenderMain();
  _plSync();
}

// === SECTION: import ════════════════════════════════════════════════════════
function _plOpenImport() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  c.innerHTML =
    '<div style="padding:20px;max-width:600px;margin:0 auto">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
      '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
      '<div style="font-size:1em;font-weight:700">Import 匯入</div>' +
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
    // V1.3.07：班表匯入；V1.3.11 改走雲端；V1.3.13 先列月份讓你勾選要匯入哪幾月
    '<div style="background:var(--card);border-radius:10px;padding:14px;margin-bottom:12px">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">📅 Roster · 從 CrewSync 帶班表（不用上傳檔）</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'CrewSync 同步過的班表<b>直接帶進來當 draft</b>，飛了再 confirm。按下面先<b>列出可匯入的月份</b>，勾選你要的再匯入。<br>' +
        'Pulls the roster CrewSync has synced as draft entries. Tap below to <b>list available months</b>, tick the ones you want, then import.<br>' +
        '<b>用前提示：</b>先去 CrewSync 用<b>同一個 Google 帳號</b>同步當月（與想要的其他月份），再回來。' +
      '</div>' +
      '<button onclick="_plRosterListMonths()" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">📅 列出可匯入月份 / List months</button>' +
      '<div id="pl-roster-months" style="margin-top:10px"></div>' +
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
  // V1.2.04：顯示「全部」row（不再只前 10）、容器加高可捲動
  var html = '<div style="margin-top:8px;font-size:.7em;color:var(--muted)">共 ' + rows.length + ' 筆預覽，可上下捲（NEW=新增、UPDATE=覆蓋舊 draft、SKIP=已是 confirmed 不動；role=你的角色、pic/sic=實際時數、DH=deadhead）：</div>' +
    '<div style="max-height:60vh;overflow-y:auto;-webkit-overflow-scrolling:touch;margin-top:4px;border:1px solid var(--border);border-radius:6px">';
  for (var i = 0; i < rows.length; i++) {
    var p = rows[i];
    html += '<div style="font-size:.66em;padding:4px 6px;border-bottom:1px solid var(--border);font-family:monospace;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
      actionBadge(p.action, p.new_status) +
      '<span>' + _plEsc(p.flight_date) + ' ' + _plEsc(p.flight_no) + ' ' + _plEsc(p.origin) + '→' + _plEsc(p.dest) + '</span>' +
      '<span style="color:var(--muted)">[' + _plEsc(p.aircraft_type) + '/' + _plEsc(p.tail_no) + ']</span>' +
      '<span style="color:var(--muted)">blk=' + _plEsc(p.block || '—') + '</span>' +
      // V1.2.03/04：顯示推斷的 role + 實際 PIC/SIC 時數 + deadhead，dry-run 即可驗證
      '<span style="color:' + (p.position ? '#38bdf8' : 'var(--muted)') + '">role=' + _plEsc(p.position || '—') + '</span>' +
      '<span style="color:var(--muted)">PIC=' + _plEsc(p.pic_min != null ? _plMinToHHMM(p.pic_min) : '—') + ' SIC=' + _plEsc(p.sic_min != null ? _plMinToHHMM(p.sic_min) : '—') + '</span>' +
      (p.deadhead ? '<span style="background:#a855f7;color:#fff;padding:1px 5px;border-radius:4px;font-size:.85em">DH</span>' : '') +
    '</div>';
  }
  html += '</div>';
  return html;
}

// V1.3.13：列出可匯入月份（雲端 + 本機 localStorage 合併），渲染勾選清單讓使用者挑要匯入哪幾月。
async function _plRosterListMonths() {
  var box = document.getElementById('pl-roster-months');
  if (box) box.innerHTML = '<div style="font-size:.72em;color:var(--muted)">查詢可匯入月份中…</div>';
  var serverErr = '';
  var cloudMonths = [];
  try {
    var sr = await _plApi('/api/pilot-log/import/roster-from-server', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { list: true },
    });
    if (sr.ok) {
      var sj = await sr.json().catch(function() { return {}; });
      if (sj && Array.isArray(sj.months)) cloudMonths = sj.months;
      if (sj && sj.error) serverErr = sj.error;
    }
  } catch (e) {}
  // 本機 localStorage 的月份（瀏覽器分頁 / fallback）
  var localMonths = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || !/^crewsync_roster_.+_\d{4}-\d{2}$/.test(k)) continue;
      var m = k.match(/_(\d{4}-\d{2})$/);
      if (m) localMonths.push(m[1]);
    }
  } catch (e) {}
  // 合併去重、由新到舊排序
  var seen = {}, months = [];
  cloudMonths.concat(localMonths).forEach(function(mo) { if (mo && !seen[mo]) { seen[mo] = 1; months.push(mo); } });
  months.sort(function(a, b) { return a < b ? 1 : (a > b ? -1 : 0); });
  if (!box) return;
  if (!months.length) {
    var hint = serverErr === 'not_linked'
      ? '雲端對不到你的員編 — Pilot Log 跟 CrewSync 要用同一個 Google 帳號，並在 CrewSync 重新同步一次。'
      : '還沒有可匯入的月份 — 先到 CrewSync 用同一個 Google 帳號同步當月（及想補的月份），再回來。';
    box.innerHTML = '<div style="background:#3b2f0a;border:1px solid #f59e0b;color:#fbbf24;border-radius:6px;padding:8px 10px;font-size:.72em">' + _plEsc(hint) + '</div>';
    return;
  }
  var checks = months.map(function(mo) {
    return '<label style="display:flex;align-items:center;gap:8px;padding:5px 6px;font-size:.8em;cursor:pointer">' +
      '<input type="checkbox" class="pl-rmonth" value="' + _plEsc(mo) + '" checked style="width:16px;height:16px">' +
      '<span>' + _plEsc(mo) + '</span></label>';
  }).join('');
  box.innerHTML =
    '<div style="font-size:.68em;color:var(--muted);margin-bottom:4px">勾選要匯入的月份（預設全選）：</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:4px">' +
      '<button onclick="_plRosterMonthsAll(true)" style="background:transparent;border:1px solid var(--border,#334155);color:var(--muted);border-radius:6px;padding:3px 8px;font-size:.68em;cursor:pointer">全選</button>' +
      '<button onclick="_plRosterMonthsAll(false)" style="background:transparent;border:1px solid var(--border,#334155);color:var(--muted);border-radius:6px;padding:3px 8px;font-size:.68em;cursor:pointer">全不選</button>' +
    '</div>' +
    '<div style="max-height:200px;overflow-y:auto;border:1px solid var(--border,#334155);border-radius:6px;padding:4px;margin-bottom:8px">' + checks + '</div>' +
    '<button onclick="_plRosterImportSelected()" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">📥 匯入選取月份 / Import selected</button>';
}
function _plRosterMonthsAll(on) {
  var els = document.querySelectorAll('.pl-rmonth');
  for (var i = 0; i < els.length; i++) els[i].checked = !!on;
}
function _plRosterImportSelected() {
  var els = document.querySelectorAll('.pl-rmonth');
  var sel = [];
  for (var i = 0; i < els.length; i++) if (els[i].checked) sel.push(els[i].value);
  if (!sel.length) { _plToast('至少勾一個月份', 'warn'); return; }
  _plImportRoster(sel);
}

// V1.3.07：班表匯入 — 撈 CrewSync 同步的班表，POST 到 server 由 importRoster() 處理
// （建 draft / 既有更新 / 範圍內舊 draft 沒看到改 roster_removed）。
// V1.3.11：先試 server 私有表（雲端帶班表，跨獨立 PWA 也行），撈不到才退回掃本機 localStorage
// （同瀏覽器分頁情境仍可用）。解 iOS 把 CrewSync / Pilot Log 各自加主畫面後兩個 app 不共用儲存。
// V1.3.13：selectedMonths 給 → 只匯這幾個月。
async function _plImportRoster(selectedMonths) {
  // V1.3.13：selectedMonths 給 → 只匯這幾個月（雲端傳 months 篩、本機過濾 byMonth）；沒給 → 全部。
  var hasSel = Array.isArray(selectedMonths) && selectedMonths.length > 0;
  // 1) 先試 server 私有表
  var serverErr = '';
  try {
    var sr = await _plApi('/api/pilot-log/import/roster-from-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: hasSel ? { months: selectedMonths } : {},
    });
    if (sr.ok) {
      var sj = await sr.json().catch(function() { return {}; });
      if (sj && !sj.error) {
        _plToast('班表匯入（雲端）' + (Array.isArray(sj.months) && sj.months.length ? '〔' + sj.months.join(',') + '〕' : '') +
          '：新增 ' + (sj.inserted || 0) + ' / 更新 ' + (sj.updated || 0) +
          ' / 已 confirmed 略過 ' + (sj.skipped_confirmed || 0) +
          ' / 標 removed ' + (sj.marked_removed || 0) +
          (sj.crew_added ? ' / 通訊錄 +' + sj.crew_added : ''));
        await _plRefreshMain();
        return;
      }
      serverErr = (sj && sj.error) || '';
    }
  } catch (e) {}

  // 2) server 撈不到 → 退回掃本機 localStorage（瀏覽器分頁、同一個 app context 才有）
  // V1.3.11（codex P2）：先收 {month, duties} 再「按月份排序」才攤平 —— 跟 server path 的
  // ORDER BY month 一致。importRoster() 的 source_ref 含全域 dutyIdx，兩條路排序若不同會產生
  // 不同 ref → 重複 + 誤標 removed；統一排序後兩路產出完全相同的 ref，互換不會出事。
  var byMonth = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || !/^crewsync_roster_.+_\d{4}-\d{2}$/.test(k)) continue;
      try {
        var cache = JSON.parse(localStorage.getItem(k) || '{}');
        var m = k.match(/_(\d{4}-\d{2})$/);
        if (m && cache && Array.isArray(cache.duties) && cache.duties.length) {
          byMonth.push({ month: m[1], duties: cache.duties });
        }
      } catch (e) {}
    }
  } catch (e) {}
  byMonth.sort(function(a, b) { return a.month < b.month ? -1 : (a.month > b.month ? 1 : 0); });
  // codex P1：傳「完整 duties」讓 server 的全域 dutyIdx 穩定，要匯哪幾月改用 months 過濾，不刪陣列
  var allDuties = [], allMonths = [];
  byMonth.forEach(function(e) {
    e.duties.forEach(function(d) { if (d && typeof d === 'object') d._rmonth = e.month; });  // codex P1：標 roster 月份供過濾
    allDuties = allDuties.concat(e.duties); allMonths.push(e.month);
  });
  var months = hasSel ? selectedMonths.filter(function(m) { return allMonths.indexOf(m) >= 0; }) : allMonths;
  if (!allDuties.length || (hasSel && !months.length)) {
    if (serverErr === 'not_linked') {
      _plToast('找不到班表：Pilot Log 的 Google email 跟 CrewSync 對不起來。請用同一個 email 登入，並到 CrewSync 重新同步一次班表', 'error');
    } else {
      _plToast('找不到班表 — 請先到 CrewSync 重新同步當月（雲端帶班表需要重新同步一次）', 'error');
    }
    return;
  }
  // codex P2：傳 months[]（實際同步到的月份），server 才能 per-month sweep；
  // 不傳連續 dateRange — 否則本機快取了 5/7 但沒 6，會把 6 月舊 draft 全部誤標 removed
  try {
    var r = await _plApi('/api/pilot-log/import/roster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { duties: allDuties, months: Array.from(new Set(months)) },
    });
    if (!r.ok) {
      var ej = await r.json().catch(function() { return {}; });
      _plToast('班表匯入失敗 ' + (ej.error || r.status), 'error');
      return;
    }
    var j = await r.json();
    _plToast('班表匯入：新增 ' + (j.inserted || 0) + ' / 更新 ' + (j.updated || 0) +
      ' / 已 confirmed 略過 ' + (j.skipped_confirmed || 0) +
      ' / 標 removed ' + (j.marked_removed || 0) +
      (j.crew_added ? ' / 通訊錄 +' + j.crew_added : ''));
    await _plRefreshMain();
  } catch (e) {
    _plToast('班表匯入失敗：' + (e && e.message ? e.message : 'unknown'), 'error');
  }
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
    // V1.2.04：欄位偵測 — 一眼看出匯出檔有沒有帶 PIC/SIC 時數欄 + Deadhead 欄
    var headersInfo = '';
    if (j.headers && j.headers.length) {
      var hset = {};
      j.headers.forEach(function(h) { hset[String(h).toLowerCase().trim()] = true; });
      var hasPic = hset['pic'] || hset['pic time'] || hset['flight pic'];
      var hasSic = hset['sic'] || hset['sic time'] || hset['flight sic'];
      var hasDh = hset['deadhead'] || hset['positioning'];
      headersInfo = '<div style="margin-top:6px;font-size:.72em;line-height:1.6">' +
        '欄位偵測：PIC 時數 ' + (hasPic ? '✅' : '❌缺') + '　SIC 時數 ' + (hasSic ? '✅' : '❌缺') + '　Deadhead ' + (hasDh ? '✅' : '❌缺') +
        ((!hasPic || !hasSic) ? '<br><span style="color:#fde68a">⚠ 缺 PIC/SIC 時數欄 → 數字會對不上 LogTen。請在 LogTen 匯出時把 PIC、SIC 時數欄勾進去再重匯。</span>' : '') +
        (!hasDh ? '<br><span style="color:#fde68a">⚠ 缺 Deadhead 欄 → deadhead 仍會靠「過去日期→confirmed」救起，只是不另外標 DH。</span>' : '') +
      '</div>';
    }
    var preview = _plRenderPreviewRows(j.preview);
    resBox.innerHTML = '<div style="background:#1e3a5f;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
      '🔍 Dry-run（沒寫入 DB）：新增 <b>' + nNew + '</b>、更新舊 draft <b>' + nUpdate + '</b>、' +
      '保留 confirmed <b>' + j.duplicate_skipped + '</b>、解析失敗 <b>' + j.parse_errors + '</b><br>' +
      '<span style="font-size:.85em;color:#bfdbfe">確認 OK 後按 Import 真的寫入。</span>' +
      headersInfo +
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

// V1.3.06：切換機型分組的收合狀態，重畫 Aircraft 列表
function _plToggleAircraftType(tc) {
  _pl.aircraftCollapsed = _pl.aircraftCollapsed || {};
  _pl.aircraftCollapsed[tc] = !_pl.aircraftCollapsed[tc];
  _plRenderAircraftList();
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
  // V1.3.06：機型分組可收合（state 保存在 _pl，跨 render 維持）
  _pl.aircraftCollapsed = _pl.aircraftCollapsed || {};
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
    // V1.2.05：先依機型（type_code）分組，type header 下列 tail（不再全部混一起）
    var groups = {}, order = [];
    for (var ai = 0; ai < _pl.aircraft.length; ai++) {
      var a = _pl.aircraft[ai];
      var tc = a.type_code || '—';
      if (!groups[tc]) { groups[tc] = []; order.push(tc); }
      groups[tc].push(a);
    }
    var typeFlights = function(tc) {
      var s = 0; groups[tc].forEach(function(a) { s += tailCount[a.tail_no] || 0; }); return s;
    };
    order.sort(function(x, y) { return typeFlights(y) - typeFlights(x); });  // 飛最多的機型在前
    for (var gi = 0; gi < order.length; gi++) {
      var gtc = order[gi];
      var list = groups[gtc];
      var full = _plLookupTypeFullName(gtc);
      // V1.3.06：點 header 收合/展開該機型；箭頭顯示狀態
      var collapsed = !!_pl.aircraftCollapsed[gtc];
      var arrow = collapsed ? '▶' : '▼';
      rows += '<div onclick="_plToggleAircraftType(\'' + _plEsc(gtc) + '\')" ' +
        'style="margin:14px 0 6px;display:flex;align-items:baseline;gap:8px;cursor:pointer;user-select:none">' +
        '<span style="font-size:.7em;color:var(--muted);width:14px;display:inline-block;text-align:center">' + arrow + '</span>' +
        '<span style="font-size:.95em;font-weight:800">' + _plEsc(gtc) + '</span>' +
        (full ? '<span style="font-size:.66em;color:var(--muted)">' + _plEsc(full) + '</span>' : '') +
        '<span style="flex:1"></span>' +
        '<span style="font-size:.62em;color:var(--muted)">' + list.length + ' tail · ' + typeFlights(gtc) + ' flights</span>' +
      '</div>';
      rows += '<div style="display:' + (collapsed ? 'none' : 'block') + '">';
      list.sort(function(a, b) { return (tailCount[b.tail_no] || 0) - (tailCount[a.tail_no] || 0); });
      for (var ti = 0; ti < list.length; ti++) {
        var ac = list[ti];
        var count = tailCount[ac.tail_no] || 0;
        rows += '<div onclick="_plOpenAircraftDetail(\'' + _plEsc(ac.tail_no) + '\')" ' +
          'style="background:var(--card);border-radius:8px;padding:9px 12px;margin-bottom:5px;cursor:pointer;display:flex;gap:10px;align-items:center">' +
          '<div style="flex:1;min-width:0"><span style="font-size:.85em;font-weight:700">' + _plEsc(ac.tail_no) + '</span>' +
          (ac.operator ? '<span style="font-size:.62em;color:var(--muted)"> · ' + _plEsc(ac.operator) + '</span>' : '') + '</div>' +
          '<div style="font-size:.72em;color:var(--text);text-align:right;white-space:nowrap">' + count + ' flights</div>' +
          '</div>';
      }
      rows += '</div>';   // close per-type collapsible wrapper (V1.3.06)
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
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:10px">依機型分組，共 ' + _pl.aircraft.length + ' 架；點任一筆查看用過這架的所有航班。<br>Grouped by type — tap a tail to see every flight on it.</div>' +
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

// ── V1.3.04：常見廠商 / 機型目錄（Add Aircraft 下拉用）─────────────────────────
// datalist：可下拉選、也能自己打（涵蓋各家機型）。選機型會自動帶 type code。
var _PL_AC_CATALOG = {
  'Airbus': [['A319', 'A-319'], ['A320', 'A-320'], ['A20N', 'A-320neo'], ['A321', 'A-321'], ['A21N', 'A-321neo'],
    ['A332', 'A-330-200'], ['A333', 'A-330-300'], ['A339', 'A-330-900'],
    ['A359', 'A-350-900'], ['A35K', 'A-350-1000'], ['A388', 'A-380-800'], ['BCS3', 'A220-300']],
  'Boeing': [['B738', '737-800'], ['B38M', '737 MAX 8'], ['B39M', '737 MAX 9'], ['B752', '757-200'],
    ['B763', '767-300'], ['B772', '777-200'], ['B77L', '777-200LR'], ['B77W', '777-300ER'], ['B779', '777-9'],
    ['B788', '787-8'], ['B789', '787-9'], ['B78X', '787-10'], ['B744', '747-400'], ['B748', '747-8']],
  'Embraer': [['E170', 'E170'], ['E175', 'E175'], ['E190', 'E190'], ['E195', 'E195'], ['E290', 'E190-E2'], ['E295', 'E195-E2']],
  'ATR': [['AT72', 'ATR 72'], ['AT76', 'ATR 72-600'], ['AT45', 'ATR 42-500']],
  'Bombardier': [['CRJ7', 'CRJ-700'], ['CRJ9', 'CRJ-900'], ['DH8D', 'Dash 8 Q400']],
};
// 內建目錄 + 疊上使用者既有機型目錄（_pl.aircraftTypes，可能含非 Airbus/Boeing 的自訂型）。
// 這樣 Make/Model 下拉與 model→type 自動帶對「你匯入的機型」也有效（codex P2）。
function _plAcMergedCatalog() {
  var cat = {};
  Object.keys(_PL_AC_CATALOG).forEach(function(mk) { cat[mk] = _PL_AC_CATALOG[mk].slice(); });
  (_pl.aircraftTypes || []).forEach(function(t) {
    if (!t.type_code) return;
    var mk = (t.make && String(t.make).trim()) || 'Other';
    var model = (t.model && String(t.model).trim()) || t.type_code;
    cat[mk] = cat[mk] || [];
    if (!cat[mk].some(function(r) { return r[0] === t.type_code; })) cat[mk].push([t.type_code, model]);
  });
  return cat;
}
function _plAcAllModels() {
  var cat = _plAcMergedCatalog(), out = [];
  Object.keys(cat).forEach(function(mk) { cat[mk].forEach(function(r) { out.push(r); }); });
  return out;
}
function _plAcModelOptions(make) {
  var cat = _plAcMergedCatalog();
  var rows = (make && cat[make]) ? cat[make] : _plAcAllModels();
  return rows.map(function(r) { return '<option value="' + _plEsc(r[1]) + '">' + _plEsc(r[0]) + '</option>'; }).join('');
}
function _plAcFindByModel(model) {
  var m = String(model || '').trim().toUpperCase();
  var cat = _plAcMergedCatalog(), found = null;
  Object.keys(cat).forEach(function(mk) {
    cat[mk].forEach(function(r) { if (r[1].toUpperCase() === m) found = { make: mk, code: r[0] }; });
  });
  return found;
}
function _plAcDatalists() {
  var makes = Object.keys(_plAcMergedCatalog()).map(function(mk) { return '<option value="' + _plEsc(mk) + '">'; }).join('');
  var codes = {};
  _plAcAllModels().forEach(function(r) { codes[r[0]] = 1; });
  var typeOpts = Object.keys(codes).map(function(c) { return '<option value="' + _plEsc(c) + '">'; }).join('');
  return '<datalist id="pl-dl-makes">' + makes + '</datalist>' +
    '<datalist id="pl-dl-models">' + _plAcModelOptions('') + '</datalist>' +
    '<datalist id="pl-dl-types">' + typeOpts + '</datalist>';
}
// V1.3.06：Manufacturer select 換值時 — 依新廠商重建 Model select；廠商=Other 切換成自由打。
function _plAddAcMakeChange() {
  var v = (document.getElementById('pl-add-make') || {}).value;
  var customMk = document.getElementById('pl-add-make-custom');
  var modelWrap = document.getElementById('pl-add-model-wrap');
  var modelSel = document.getElementById('pl-add-model');
  var modelCustom = document.getElementById('pl-add-model-custom');
  var typeWrap = document.getElementById('pl-add-type-wrap');
  if (!customMk || !modelWrap || !modelSel || !modelCustom || !typeWrap) return;
  if (v === '__other__') {
    // 自訂廠商 → 機型也只能自己打 + Type Code 需要使用者輸入
    customMk.style.display = ''; customMk.focus();
    modelWrap.style.display = '';
    modelSel.style.display = 'none';
    modelCustom.style.display = '';
    typeWrap.style.display = '';
    return;
  }
  customMk.style.display = 'none'; customMk.value = '';
  if (!v) { modelWrap.style.display = 'none'; typeWrap.style.display = 'none'; return; }
  // 已選廠商 → Model select 重填該廠商的機型（含「其他」），Type Code 暫隱（catalog → auto-derive）
  var rows = (_plAcMergedCatalog()[v] || []);
  modelSel.style.display = '';
  modelSel.innerHTML = '<option value="">— 選 —</option>' +
    rows.map(function(r) { return '<option value="' + _plEsc(r[1]) + '" data-code="' + _plEsc(r[0]) + '">' + _plEsc(r[1]) + ' (' + _plEsc(r[0]) + ')</option>'; }).join('') +
    '<option value="__other__">其他 / Other</option>';
  modelWrap.style.display = '';
  modelCustom.style.display = 'none'; modelCustom.value = '';
  typeWrap.style.display = 'none';
}
// Model select 換值時 — 選了「其他」就露出 Model+TypeCode 自由欄；catalog 的機型則 type code 隱藏由 submit 時 derive
function _plAddAcModelChange() {
  var v = (document.getElementById('pl-add-model') || {}).value;
  var modelCustom = document.getElementById('pl-add-model-custom');
  var typeWrap = document.getElementById('pl-add-type-wrap');
  if (!modelCustom || !typeWrap) return;
  if (v === '__other__') { modelCustom.style.display = ''; modelCustom.focus(); typeWrap.style.display = ''; }
  else { modelCustom.style.display = 'none'; modelCustom.value = ''; typeWrap.style.display = 'none'; }
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
  // V1.3.04：可下拉也可手打（datalist）。listId 提供建議清單，oninput 觸發連動。
  function dlField(label, id, placeholder, listId, oninput) {
    return '<div style="margin-bottom:10px">' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:3px">' + label + '</div>' +
      '<input id="' + id + '" list="' + listId + '" placeholder="' + (placeholder || '') + '"' +
        (oninput ? ' oninput="' + oninput + '"' : '') +
        ' style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em">' +
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
        // V1.3.06：Manufacturer 改回 <select>。原本的 datalist 在欄位已有值時會用值去濾建議，
        //          導致使用者想重選廠商時下拉只剩當前那家（user：「會被底下機型限制住」），體驗壞掉。
        '<div style="margin-bottom:10px">' +
          '<div style="font-size:.7em;color:var(--muted);margin-bottom:3px">Manufacturer 廠商</div>' +
          '<select id="pl-add-make" onchange="_plAddAcMakeChange()" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em">' +
            '<option value="">— 選 —</option>' +
            Object.keys(_plAcMergedCatalog()).map(function(mk) { return '<option value="' + _plEsc(mk) + '">' + _plEsc(mk) + '</option>'; }).join('') +
            '<option value="__other__">其他 / Other（自己打）</option>' +
          '</select>' +
          '<input id="pl-add-make-custom" placeholder="廠商名稱" style="display:none;width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em;margin-top:6px">' +
        '</div>' +
        // V1.3.06：Model select 由 _plAddAcMakeChange 動態填；預設整段隱藏（等選了廠商才出）
        '<div id="pl-add-model-wrap" style="margin-bottom:10px;display:none">' +
          '<div style="font-size:.7em;color:var(--muted);margin-bottom:3px">Model 機型</div>' +
          '<select id="pl-add-model" onchange="_plAddAcModelChange()" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em">' +
            '<option value="">— 選 —</option>' +
          '</select>' +
          '<input id="pl-add-model-custom" placeholder="機型（例：A-350-900）" style="display:none;width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em;margin-top:6px">' +
        '</div>' +
        // V1.3.06：Type Code 只在自訂時出現（從目錄選的會自動 derive — user：「不需要再有機型代碼選擇」）
        '<div id="pl-add-type-wrap" style="margin-bottom:10px;display:none">' +
          '<div style="font-size:.7em;color:var(--muted);margin-bottom:3px">Type Code 機型代碼（自訂時填）</div>' +
          '<input id="pl-add-type" placeholder="例：A359" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em">' +
        '</div>' +
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
  // V1.3.06：select 用 sentinel "__other__" 表示自訂，從 customs 讀；catalog 兩者皆選則 type code 從 model
  // 的 data-code 屬性 derive（user：不需要再有 type code 選擇）
  var makeSelV = val('pl-add-make');
  var make = (makeSelV === '__other__') ? val('pl-add-make-custom') : makeSelV;
  var modelSelV = val('pl-add-model');
  var model;
  if (makeSelV === '__other__' || modelSelV === '__other__') model = val('pl-add-model-custom');
  else model = modelSelV;
  var typeCode;
  if (makeSelV && makeSelV !== '__other__' && modelSelV && modelSelV !== '__other__') {
    var ms = document.getElementById('pl-add-model');
    var opt = ms && ms.options[ms.selectedIndex];
    typeCode = opt ? (opt.getAttribute('data-code') || '') : '';
  } else {
    typeCode = val('pl-add-type');
  }
  var body = {
    tail_no: tail,
    type_code: typeCode,
    make: make,
    model: model,
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
  // V1.3.12：新 6 槽 PIC 先，再 Crew2-4 / CIC / OBS；後面接舊 key（相容已匯入的舊資料）。
  // 槽值相容字串(舊)與 {name,...}(新)。
  var order = ['pic', 'crew2', 'crew3', 'crew4', 'cic', 'obs',
               'sic', 'fo1', 'fo2', 'purser', 'observer1', 'observer2'];
  var names = [], seen = {};
  function nm(v) { var o = _plCrewVal(v); return o.name ? o.name.trim() : ''; }
  order.forEach(function(k) {
    var n = nm(e.crew[k]);
    if (n) { names.push(n); seen[k] = 1; }
  });
  // 其他未列在 order 的 key 也補在後面（保險，不漏人）
  Object.keys(e.crew).forEach(function(k) {
    if (seen[k]) return;
    var n = nm(e.crew[k]);
    if (n) names.push(n);
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

// V1.3.13：取 entry 所有 crew 槽的 {name, eid}（含舊 key、字串/物件相容）。
function _plEntryCrewSlots(e) {
  if (!e || !e.crew || typeof e.crew !== 'object') return [];
  var out = [];
  Object.keys(e.crew).forEach(function(k) {
    var v = _plCrewVal(e.crew[k]);
    var nm = (v.name || '').trim();
    if (nm) out.push({ name: nm, eid: (v.eid || '').trim() });
  });
  return out;
}

// V1.3.13：用「員編優先」把航班歸給通訊錄聯絡人，解同名問題（公司真的有同名同事）。
// 規則：槽有員編 → 對到擁有該員編的聯絡人（精準，同名也拆得開）；槽沒員編 → 只在「名字不同名」
// 時才用名字 fallback（同名又沒員編 → 歸不了，不亂猜）。回傳每位聯絡人的航班數與航班清單。
function _plCrewFlightIndex() {
  var entries = _pl.aircraftEntries || [];
  var ambNames = _plCrewAmbiguousNames();
  var eidToId = {}, nameToId = {};
  (_pl.crew || []).forEach(function(c) {
    var nm = (c.display_name || '').trim();
    if (nm && !ambNames[nm]) nameToId[nm] = c.id;            // 只索引「不同名」的名字
    (c.employee_ids || []).forEach(function(eid) { if (eid) eidToId[String(eid).trim()] = c.id; });
  });
  var countById = {}, entriesById = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var slots = _plEntryCrewSlots(e);
    var matched = {};                                        // 這筆航班命中的聯絡人（去重，一筆只算一次）
    for (var s = 0; s < slots.length; s++) {
      var sl = slots[s], cid = null;
      if (sl.eid && eidToId[sl.eid]) cid = eidToId[sl.eid];  // 員編精準
      else if (!sl.eid && nameToId[sl.name]) cid = nameToId[sl.name]; // 名字 fallback（僅不同名）
      if (cid) matched[cid] = 1;
    }
    Object.keys(matched).forEach(function(cid) {
      countById[cid] = (countById[cid] || 0) + 1;
      (entriesById[cid] = entriesById[cid] || []).push(e);
    });
  }
  return { countById: countById, entriesById: entriesById, ambNames: ambNames };
}
// 聯絡人是否「完全歸不了航班」：沒有任何員編、且名字同名 → 員編對不了、名字又不敢猜 → suppress。
function _plCrewUnattributable(c, ambNames) {
  var hasEid = Array.isArray(c.employee_ids) && c.employee_ids.length > 0;
  var nameAmb = !!ambNames[(c.display_name || '').trim()];
  return !hasEid && nameAmb;
}

// V1.3.10：拆成「shell（含 input）」+「rows 容器」兩段 — oninput 只重畫 rows，input element 不被砍掉，
// 焦點與游標位置自然保留（user：「每打一字游標就跳離開」）。
function _plRenderCrewList() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // V1.3.13：同名只要「有員編」就靠員編拆得開；只有「同名 + 完全沒員編」才仍 suppress。
  var ambNames = _plCrewAmbiguousNames();
  var hasAmb = (_pl.crew || []).some(function(c) { return _plCrewUnattributable(c, ambNames); });
  var ambNotice = hasAmb
    ? '<div style="background:#3b2f0a;border:1px solid #f59e0b;color:#fbbf24;border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:.7em">⚠ 有同名 crew 且<b>沒有員編</b>（標記 <b>SAME-NAME</b>）：員編對得到的同名同事已能自動拆開；但這幾位連員編都沒有，無法判斷航班屬於哪一位，先不計數 / 不列航班。補上員編（Address Book 加 ID，或編輯航班時從通訊錄點選）就會拆開。<br>Some crew share a name and have <b>no employee id</b> (<b>SAME-NAME</b>): same-name colleagues that carry an employee id are now separated automatically; these have none, so their flights cannot be attributed. Add an employee id (in the Address Book, or pick from the address book when editing a flight) to resolve them.</div>'
    : '';
  var term = (_plCrewSearchTerm || '');
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">👥 Crew</div>' +
        '<div style="flex:1"></div>' +
        '<div style="font-size:.7em;color:var(--muted)">共 ' + _pl.crew.length + ' 人</div>' +
      '</div>' +
      _plCrewLabelsEditor() +
      '<input id="pl-crew-search" type="search" placeholder="搜尋名字 / ID..." value="' + _plEsc(term) + '" ' +
        'oninput="_plCrewSearchInput(this.value)" ' +
        'style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em;margin-bottom:10px;box-sizing:border-box">' +
      ambNotice +
      '<div style="font-size:.65em;color:var(--muted);margin-bottom:8px">flight count 用完整資料計算（不受 Logbook 篩選影響）。點任一筆查看一起飛過的航班。<br>Flight counts use all data (ignores the Logbook filter). Tap anyone to see flights flown together.</div>' +
      '<div id="pl-crew-rows"></div>' +
    '</div>';
  _plRenderCrewRows();   // 列出符合 _plCrewSearchTerm 的 rows
}

// 只重畫 rows 區段（不動 input），給搜尋每次 oninput 用 — 焦點不會跳掉
function _plRenderCrewRows() {
  var el = document.getElementById('pl-crew-rows');
  if (!el) return;
  // V1.3.13：員編優先索引（同名靠員編拆開）。countById 以聯絡人 id 為 key，不再以名字。
  var idx = _plCrewFlightIndex();
  var countById = idx.countById;
  var ambNames = idx.ambNames;
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
      // V1.3.13：只有「沒員編 + 同名」才真的歸不了 → suppress；有員編的同名照樣算得出來。
      var unattrib = _plCrewUnattributable(p, ambNames);
      var idStr = Array.isArray(p.employee_ids) && p.employee_ids.length ? p.employee_ids.join(' / ') : '';
      var selfMark = p.is_self ? '<span style="background:#0ea5e9;color:#fff;border-radius:4px;padding:1px 6px;font-size:.6em;margin-left:6px">YOU</span>' : '';
      var ambMark = unattrib ? '<span style="background:#f59e0b;color:#000;border-radius:4px;padding:1px 6px;font-size:.6em;margin-left:6px" title="同名且沒有員編，無法判斷哪些航班屬於誰。在 Address Book 給該員編、或之後從通訊錄點選即可拆開">SAME-NAME</span>' : '';
      var countCell = unattrib
        ? '<div style="font-size:.72em;color:var(--muted);text-align:right" title="同名且無員編，無法計數">—</div>'
        : '<div style="font-size:.72em;color:var(--text);text-align:right">' + (countById[p.id] || 0) + ' flights</div>';
      rows += '<div onclick="_plOpenCrewDetail(\'' + _plEsc(p.id) + '\')" ' +
        'style="background:var(--card);border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;display:flex;gap:10px;align-items:center">' +
        '<div style="flex:1"><div style="font-size:.85em;font-weight:700">' + _plEsc(p.display_name) + selfMark + ambMark + '</div>' +
          (idStr ? '<div style="font-size:.62em;color:var(--muted)">ID: ' + _plEsc(idStr) + '</div>' : '') +
          (p.organization ? '<div style="font-size:.62em;color:var(--muted)">' + _plEsc(p.organization) + '</div>' : '') + '</div>' +
        countCell +
        '</div>';
    }
  }
  el.innerHTML = rows;
}

function _plCrewSearchInput(v) {
  _plCrewSearchTerm = v;
  _plRenderCrewRows();   // 只重畫 rows 容器，input 與焦點保留
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
  // V1.3.13：只有「沒員編 + 同名」才歸不了；有員編的同名靠員編列得出航班。
  var ambiguous = _plCrewUnattributable(person, ambNames);

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
      '有多位 crew 叫「' + _plEsc(name) + '」，而<b>這一位沒有員編</b>，所以航班無法靠員編歸戶、' +
      '名字又同名不敢亂猜。為避免錯誤歸屬，先不顯示。<br>' +
      'Several crew are named “' + _plEsc(name) + '” and <b>this one has no employee id</b>, so flights cannot be attributed by id and the shared name is unsafe to guess.<br><br>' +
      '解法：在 Address Book 給這位加上員編；或編輯該航班時從通訊錄點選這個人（會自動帶員編），就能拆開。<br>' +
      'Fix: add an employee id to this person in the Address Book, or pick them from the address book when editing the flight (auto-links the id).' +
    '</div>';
    countLabel = '—';
  } else {
    // V1.3.13：用員編優先索引拿這位的航班（同名靠員編拆開；沒員編的槽只在名字不同名時才算）
    var flights = (_plCrewFlightIndex().entriesById[crewId] || []).slice();
    flights.sort(function(a, b) { return (b.flight_date || '').localeCompare(a.flight_date || ''); });
    bodyHtml = flights.length === 0
      ? '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">沒有跟這位 crew 一起飛過的紀錄。員編對得到的會精準歸戶；舊紀錄或手打沒帶員編的同名航班可能對不到。<br>No flights flown with this crew. Flights carrying an employee id are matched precisely; older or hand-typed same-name flights without an id may not match.</div>'
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

// V1.2.05：明細表 — 真正能整理分析的核心。共用 helper 給「依機型」「依公司」兩表用。
// 每列：班數 / Block / PIC 時數 / PIC sector 數 / SIC / Night / 起飛 / 落地 + 總計。
// PIC/SIC 時數用實際 pic_minutes，沒有就 fallback position×block（跟 stats 一致）。
// deadhead 已在 entries 來源層排除（不算飛行），這裡不會收到。
function _plBreakdownAgg(entries, keyFn) {
  var map = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var k = keyFn(e) || '—';
    if (!map[k]) map[k] = { key: k, flights: 0, block: 0, pic: 0, picSec: 0, sic: 0, night: 0, to: 0, ldg: 0 };
    var m = map[k];
    var picMin = (e.pic_minutes != null) ? e.pic_minutes : (e.position === 'PIC' ? (e.block_minutes || 0) : 0);
    var isPicSector = (e.pic_minutes != null) ? (e.pic_minutes > 0) : (e.position === 'PIC');
    m.flights++;
    m.block += e.block_minutes || 0;
    m.pic += picMin;
    if (isPicSector) m.picSec++;
    m.sic += (e.sic_minutes != null) ? e.sic_minutes : (e.position === 'SIC' ? (e.block_minutes || 0) : 0);
    m.night += e.night_minutes || 0;
    m.to += (e.day_takeoffs || 0) + (e.night_takeoffs || 0);
    m.ldg += (e.day_landings || 0) + (e.night_landings || 0);
  }
  var rows = Object.keys(map).map(function(k) { return map[k]; });
  rows.sort(function(a, b) { return b.block - a.block; });
  var tot = { key: 'Total', flights: 0, block: 0, pic: 0, picSec: 0, sic: 0, night: 0, to: 0, ldg: 0 };
  rows.forEach(function(r) {
    tot.flights += r.flights; tot.block += r.block; tot.pic += r.pic; tot.picSec += r.picSec;
    tot.sic += r.sic; tot.night += r.night; tot.to += r.to; tot.ldg += r.ldg;
  });
  return { rows: rows, tot: tot };
}

function _plBreakdownTable(title, firstCol, entries, keyFn) {
  if (!entries.length) return '';
  var agg = _plBreakdownAgg(entries, keyFn);
  var th = function(t) { return '<th style="text-align:right;padding:5px 8px;font-weight:700;color:var(--muted);white-space:nowrap">' + t + '</th>'; };
  var head = '<tr><th style="text-align:left;padding:5px 8px;color:var(--muted)">' + firstCol + '</th>' +
    th('Flt') + th('Block') + th('PIC') + th('PIC&nbsp;Sec') + th('SIC') + th('Night') + th('T/O') + th('Ldg') + '</tr>';
  var tdN = function(v) { return '<td style="text-align:right;padding:5px 8px;font-variant-numeric:tabular-nums;white-space:nowrap">' + v + '</td>'; };
  var rowHtml = function(label, r, extra) {
    return '<tr style="' + extra + '">' +
      '<td style="text-align:left;padding:5px 8px;font-weight:700;white-space:nowrap">' + _plEsc(label) + '</td>' +
      tdN(r.flights) + tdN(_plMinToHHMM(r.block)) + tdN(_plMinToHHMM(r.pic)) + tdN(r.picSec) +
      tdN(_plMinToHHMM(r.sic)) + tdN(_plMinToHHMM(r.night)) + tdN(r.to) + tdN(r.ldg) + '</tr>';
  };
  var body = agg.rows.map(function(r) { return rowHtml(r.key, r, 'border-top:1px solid var(--border)'); }).join('');
  var totalRow = rowHtml('Total', agg.tot, 'border-top:2px solid var(--border);font-weight:700');
  return '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:14px;margin-bottom:10px">' +
    '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">' + title + '</div>' +
    '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">' +
      '<table style="width:100%;border-collapse:collapse;font-size:.76em">' +
        '<thead>' + head + '</thead><tbody>' + body + totalRow + '</tbody></table>' +
    '</div></div>';
}

function _plRenderTypeBreakdown(entries) {
  return _plBreakdownTable('依機型明細 By Type（時數=時:分、PIC Sec=PIC 段數）', 'Type', entries, function(e) { return e.aircraft_type || '—'; });
}

// 依公司（operator）分析：entry 沒存 operator，用 tail_no 對應機尾庫 _pl.aircraft 的 operator
function _plRenderCompanyBreakdown(entries) {
  var op = {};
  (_pl.aircraft || []).forEach(function(a) { if (a.tail_no) op[String(a.tail_no).trim().toUpperCase()] = a.operator || ''; });
  return _plBreakdownTable('依公司明細 By Company', 'Company', entries, function(e) {
    return op[String(e.tail_no || '').trim().toUpperCase()] || '—';
  });
}

function _plRenderAnalyzeContent() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (_pl.tab !== 'analyze') return;   // 防 race：切走後過期的 async render 不可覆蓋新分頁
  // V1.3.09：「已完成」改用 in_utc 判斷（跟後端 stats 一致）— 沒填實際抵達時間的不算飛行統計
  var entries = (_pl.aircraftEntries || []).filter(function(e) {
    if (e.is_deadhead || e.status === 'roster_removed') return false;
    return !!e.in_utc;
  });
  var hasStats = _pl.stats && _pl.stats.totals;
  var body = hasStats
    ? _plRenderStats() + _plRenderTypeBreakdown(entries) + _plRenderCompanyBreakdown(entries) + _plRenderMonthlyChart(entries)
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
  // 報表只看已飛 confirmed 且非 deadhead（deadhead 不算 PIC/SIC / 起降 currency / 時數）
  // V1.3.09：跟 Analyze / 後端 stats 一致 — 用 in_utc 判斷已完成（user：未完成的不算）
  var src = (_pl.aircraftEntries || []).filter(function(e) {
    if (e.is_deadhead || e.status === 'roster_removed') return false;
    return !!e.in_utc;
  });

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
  // V1.3.09：CSV 跟 Analyze / Report / 後端 stats 一致 — 用 in_utc 判斷已完成（未完成不匯出）
  var src = (_pl.aircraftEntries || []).filter(function(e) {
    if (e.is_deadhead || e.status === 'roster_removed') return false;
    if (!e.in_utc) return false;
    var fd = String(e.flight_date || '').slice(0, 10);
    return (!r.from || fd >= r.from) && (!r.to || fd <= r.to);
  });
  src.sort(function(a, b) { return (a.flight_date || '').localeCompare(b.flight_date || ''); });
  var head = ['Date', 'Flight', 'From', 'To', 'Type', 'Tail', 'Position',
              'Block', 'Night', 'DayTO', 'NightTO', 'DayLdg', 'NightLdg', 'PIC', 'Crew'];
  var lines = [head.join(',')];
  for (var i = 0; i < src.length; i++) {
    var e = src[i];
    var crew = e.crew || {};
    // V1.3.12：crew 槽值已物件化（{name,rank,eid}），相容舊字串。PIC 一欄、其餘合併一欄。
    var picName = _plCrewVal(crew.pic).name;
    var otherNames = _plEntryCrewNames(e).filter(function(n) { return n !== picName; }).join('; ');
    var cells = [
      String(e.flight_date || '').slice(0, 10), e.flight_no, e.origin, e.dest,
      e.aircraft_type, e.tail_no, e.position,
      _plMinToHHMM(e.block_minutes), _plMinToHHMM(e.night_minutes),
      e.day_takeoffs || 0, e.night_takeoffs || 0, e.day_landings || 0, e.night_landings || 0,
      picName, otherNames,
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
    _plRequestPersist();           // V1.2：請瀏覽器把儲存標 persistent
    _plRegisterSyncTriggers();     // V1.3：online / 切回前景時自動補送 outbox
  }
  if (_pl.editing) { _plRenderEditor(); return; }

  // cache-first 啟動：先把 IDB 快取塞回 _pl（離線時這就是唯一資料來源）
  var hadCache = await _plCacheLoadAll();

  // accessToken 不在記憶體就試 cookie resurrection（線上才有意義；離線會失敗但不清 session）
  if (!_pl.accessToken) {
    var ok = await _plTryRefresh();
    // V1.3 離線優先：只有「有網路且手機裡完全沒有可用身分」才跳登入。
    // 離線 / 有快取 / 有 localStorage 身分 → 一律往下走顯示快取，不卡登入（這就是 CrewSync 的行為）。
    if (!ok && _plOnline() && !_plHasSession()) {
      _plRenderLogin();
      return;
    }
  }

  // 用快取（或剛拿到的新 session）立刻 render，不等網路
  if (_pl.tab === 'analyze') { _plRenderAnalyze(); }
  else if (_pl.tab === 'report') { _plRenderReport(); }
  else {
    _plRenderMain();
    // codex P1：有待上傳的離線改動時，別先用 server 舊資料蓋掉本機未同步的編輯
    // （否則一回連重開 App 會看到剛離線存的航班「消失」幾秒）。改由 _plSync 排空後自己對帳。
    if (!(_pl.outbox.length && _plOnline())) {
      _plFetchAll().then(function(ok) {
        // 線上且 session 確實失效（token+cookie 都 401、本機身分也被清）→ 送回登入；離線絕不踢
        if (_plOnline() && !_plHasSession()) { _plRenderLogin(); return; }
        if (ok && _pl.tab === 'logbook' && !_pl.editing) _plRenderList();
        _plRenderSyncStatus();
      });
    }
  }

  // 有待上傳就先同步（_plSync 排空後內部會 _plFetchAll 對帳）；無待上傳則為 no-op
  _plSync();
}

// V1.3：同步觸發點 — 一回連 / 切回前景就自動補送 outbox（只註冊一次）
function _plRegisterSyncTriggers() {
  try {
    window.addEventListener('online', function() { _plSetOffline(false); _plSync(); });
    window.addEventListener('offline', function() { _plSetOffline(true); _plRenderSyncStatus(); });
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible' && _plOnline() && _pl.outbox.length) _plSync();
    });
  } catch (e) {}
}
