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
  crewLabels: null,               // V1.3.12 crew 欄位自訂顯示名稱 {pic,crew2,...,cabin1..20}；null=用預設
  crewDisplayMode: 'flight',      // V2.3 列表組員顯示：cic_only=只機長 / flight=飛航組 / all=含客艙
  fieldLabels: null,              // V2.3 編輯器欄位自訂顯示名稱 {fieldKey: label}；null=用預設
  configFields: false,            // V2.3 編輯器「設定欄位」模式（LogTen 式）：開了才能改欄位名稱（session-only）
  selectMode: false,              // V2.3 logbook 多選模式（勾選刪除）
  selectedIds: {},                // V2.3 多選模式選中的 entry id 集合 {id:true}
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
    localStorage.removeItem('pilotlog_is_founder');   // 別讓下一個登入的人看到上一個人的會員身分（codex P3）
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
  ['analyze', 'logbook', 'map', 'report'].forEach(function(t) {
    var b = document.getElementById('plTabBtn-' + t);
    if (b) b.classList.toggle('pl-tab-active', t === tab);
  });
  // iPhone：tab bar 太窄會橫向捲動 → 把當前分頁捲進可視範圍（iPad 夠寬不會捲、此呼叫無作用）。
  var act = document.getElementById('plTabBtn-' + tab);
  if (act && act.scrollIntoView) { try { act.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {} }
}

// 底部主功能切換。Logbook 內的 editor/import/aircraft/crew 都是 Logbook 的 sub-view，
// 切 tab 一律先丟掉編輯中的草稿狀態回到該 tab 的頂層。
function switchPlTab(tab, btn) {
  if (!_pl.user) return;            // 未登入時 tab bar 是藏的，保險再擋一次
  if (typeof _plDisposeGlobe === 'function') _plDisposeGlobe();   // V2.2.00：離開 Map 先釋放 3D WebGL
  _pl.tab = tab;
  _pl.editing = null;
  _pl.selectedId = null;            // 切走 logbook，detail pane 的選取就重置
  _plHighlightTab(tab);
  if (tab === 'analyze') _plRenderAnalyze();
  else if (tab === 'report') _plRenderReport();
  else if (tab === 'map') _plRenderMapTab();
  else _plRenderMain();
  _plRenderYearIndex();   // codex P2：切頁時收起/更新年份索引（非 logbook 會隱藏）
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
  _plUpdateBannerHeight();     // 量實際橫幅高度（換行會變高）→ 給 sticky 工具列偏移用（codex P2）
  _plApplyOfflineMapShift();   // V2.2.08：離線時把沉浸式地圖下移，避免 OFFLINE 橫幅擋住浮動控制項
  _plManageReconnectProbe(!!off);   // V2.2.08：離線時開始主動探線（iOS 的 online 事件常不觸發 → 橫幅卡住）
}
// 量 OFFLINE 橫幅實際高度 → 寫進 --pl-banner-h（離線時 sticky 工具列要黏在橫幅下方，橫幅換行會變更高，不能寫死）。
function _plUpdateBannerHeight() {
  try {
    var bar = document.getElementById('pl-offline-bar');
    var off = document.body.classList.contains('pl-offline');
    var h = (off && bar && bar.offsetHeight) ? bar.offsetHeight : 0;
    document.documentElement.style.setProperty('--pl-banner-h', h + 'px');
  } catch (e) {}
}
// V2.2.08：離線時每 15 秒主動探一次線（打 /me 帶 timeout）。一旦成功就當作連回線 → 清橫幅 + 重抓當前頁。
// 不靠 window 'online' 事件（iOS PWA 上常不觸發，導致連回線了橫幅還在、要重開 App）。
function _plManageReconnectProbe(off) {
  try {
    if (off) {
      if (_pl._reconnTimer) return;
      _pl._reconnTimer = setInterval(function () {
        if (!document.body.classList.contains('pl-offline')) { _plManageReconnectProbe(false); return; }
        if (_pl._reconnProbing) return;   // 上一個探測還在飛 → 跳過，避免堆疊
        _pl._reconnProbing = true;
        _plApi('/api/pilot-log/me')
          .then(function (res) { if (res && res.ok) _plReconnected(); })
          .catch(function () {})
          .finally(function () { _pl._reconnProbing = false; });
      }, 6000);   // 每 6 秒探一次 → 連回線最多 6 秒就清橫幅（離線時 fetch 多半瞬間失敗、成本低）
    } else if (_pl._reconnTimer) {
      clearInterval(_pl._reconnTimer); _pl._reconnTimer = null; _pl._reconnProbing = false;
    }
  } catch (e) {}
}
// 連回線：清離線狀態 + 補送離線期間改動 + 重抓當前頁（不打斷編輯中）。
function _plReconnected() {
  if (!document.body.classList.contains('pl-offline')) return;
  _plSetOffline(false);              // 清橫幅 + 停探線 + 還原地圖位移
  try { _plSync(); } catch (e) {}    // 補送離線期間排進 outbox 的改動
  if (_pl.editing) return;           // 編輯中就只清狀態，不重載（避免丟草稿）
  try {
    if (_pl.tab === 'analyze') _plRenderAnalyze();
    else if (_pl.tab === 'report') _plRenderReport();
    else if (_pl.tab === 'map') _plRenderMapTab();
    else _plFetchAll().then(function () { if (_pl.tab === 'logbook' && !_pl.editing) _plRenderList(); });
  } catch (e) {}
}
// V2.2.08：地圖 #pl-map-full 是 inline top:0（外部 CSS 蓋不過），離線時用 JS 直接設 inline top，
// 依實際橫幅高度把整張地圖（含掛在裡面的控制項 overlay）下移；連線時還原 top:0。
function _plApplyOfflineMapShift() {
  var mapFull = document.getElementById('pl-map-full');
  if (!mapFull) return;   // 不在地圖頁就略過（之後切到地圖頁 render 時會再呼叫一次）
  var off = document.body.classList.contains('pl-offline');
  if (off) {
    var bar = document.getElementById('pl-offline-bar');
    var h = (bar && bar.offsetHeight) ? bar.offsetHeight : 28;   // 量實際橫幅高（含換行）
    mapFull.style.top = 'calc(env(safe-area-inset-top) + ' + h + 'px)';
  } else {
    mapFull.style.top = '0';
  }
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
// V1.3.27（codex P2）：安全內嵌進 onclick="fn('...')" 的值 —— 先 JS 跳脫（\ 與 '），再 HTML 跳脫屬性。
// 用於自由文字當參數（如公司名可能含 ' ）；瀏覽器會先 HTML-decode 屬性、再執行 JS，兩層都要顧。
function _plJs(s) {
  return _plEsc(String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

function _plToast(msg, kind) {
  var bg = kind === 'error' ? '#ef4444' : (kind === 'warn' ? '#f59e0b' : '#10b981');
  var t = document.createElement('div');
  // V2.3.04：top 避開 iPhone 動態島/瀏海（PWA 全螢幕 content 鑽到狀態列下，固定 20px 會被蓋住）
  t.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top, 0px) + 14px);left:50%;transform:translateX(-50%);background:' + bg +
    ';color:#fff;padding:10px 16px;border-radius:8px;font-size:.85em;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:88vw';
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
  var res = await _plFetchTimeout(path, opts, opts.timeoutMs);   // V2.3：可帶自訂逾時（匯入這種慢動作用長的，否則吃預設 8 秒被 abort）
  if (res.status === 401 && _pl.refreshToken) {
    var ok = await _plTryRefresh();
    if (ok) {
      opts.headers['Authorization'] = 'Bearer ' + _pl.accessToken;
      res = await _plFetchTimeout(path, opts, opts.timeoutMs);
    }
  }
  return res;
}
// V2.2.08：帶 timeout 的 fetch —— iOS PWA 飛航模式下 navigator.onLine 常仍回 true，沒 timeout 的話
// fetch 會永久 hang（Map/Report 一直卡「Loading…」、離線旗標也沒設）。逾時就 abort → throw，
// 讓 caller 走離線快取 + 設 OFFLINE。預設 10 秒。
function _plFetchTimeout(path, opts, ms) {
  ms = ms || 8000;   // V2.2.08：8 秒（搭配快取優先，幾乎不會乾等到逾時；僅首次無快取又離線時當後盾）
  if (typeof AbortController === 'undefined') return fetch(path, opts);
  var ctrl = new AbortController();
  var tid = setTimeout(function () { ctrl.abort(); }, ms);
  var o = {};
  for (var k in opts) { if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k]; }
  o.signal = ctrl.signal;
  return fetch(path, o).finally(function () { clearTimeout(tid); });
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

// 帳號選單（點右上角 email 跳出）：顯示會員身分 + 登出 + 刪帳號。
function _plTierLabel() {
  var f = _pl.user ? _pl.user.isFounder : undefined;
  if (f === undefined || f === null) {            // 還沒從 /me 載到 → 看 localStorage 快取（離線也能顯示）
    try { var c = localStorage.getItem('pilotlog_is_founder'); if (c === '1') f = true; else if (c === '0') f = false; } catch (e) {}
  }
  if (f === true) return '⭐ 創始會員 Founder';
  if (f === false) return '一般會員 Member';
  return '…';
}
function _plToggleAcctMenu(e) {
  if (e) e.stopPropagation();
  var m = document.getElementById('pl-acct-menu');
  if (!m) return;
  var show = (m.style.display === 'none' || !m.style.display);
  m.style.display = show ? 'block' : 'none';
  if (show) {
    var tEl = document.getElementById('pl-acct-tier');
    if (tEl) tEl.textContent = _plTierLabel();    // 開選單當下刷新身分（萬一剛載好）
    setTimeout(function () { document.addEventListener('click', _plCloseAcctMenu); }, 0);
  } else {
    document.removeEventListener('click', _plCloseAcctMenu);
  }
}
function _plCloseAcctMenu() {
  var m = document.getElementById('pl-acct-menu');
  if (m) m.style.display = 'none';
  document.removeEventListener('click', _plCloseAcctMenu);
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
  // V1.3.08：filter 改成 client-side（all/past/future/removed 不對應 server status）— 要抓「全部」entries。
  // V2.2.07 修大 bug：原本 q='' 沒帶 limit → server 預設只回最近 200 筆，飛行筆數多的人看不到 2024 以前的
  //   航班（總時數正常是因為 stats 是 server 端全量算）。改帶 limit=all → server 不加 LIMIT，整本全載、無上限。
  var q = '?limit=all';
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
      // V2.3：列表組員顯示模式（cic_only/flight/all）
      if (mj && typeof mj.crew_display_mode === 'string') _pl.crewDisplayMode = mj.crew_display_mode;
      try { localStorage.setItem('pilotlog_crew_display_mode', _pl.crewDisplayMode); } catch (e) {}
      // V2.3：編輯器欄位自訂顯示名稱
      _pl.fieldLabels = (mj && mj.field_labels) || null;
      // V2.3.07：報到時間規則（On Duty = STD − N 分，依公司×機場）
      _pl.dutyRules = (mj && mj.duty_rules) || null;
      try { localStorage.setItem('pilotlog_duty_rules', JSON.stringify(_pl.dutyRules || null)); } catch (e) {}
      try { localStorage.setItem('pilotlog_field_labels', JSON.stringify(_pl.fieldLabels || {})); } catch (e) {}
      // 會員身分（⭐ 創始會員 / 一般會員）— 帳號選單顯示用，順便存 localStorage 給離線
      if (_pl.user) _pl.user.isFounder = !!(mj && mj.isFounder);
      try { localStorage.setItem('pilotlog_is_founder', (mj && mj.isFounder) ? '1' : '0'); } catch (e) {}
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
  if (_pl.filter === 'removed') _pl.filter = 'all';   // V1.3.34：拿掉 removed 篩選 → 舊偏好正規化回 all
  var filterBtn = function(val, label) {
    var active = _pl.filter === val;
    return '<button onclick="_plSetFilter(\'' + val + '\')" style="background:' +
      (active ? 'var(--accent,#3b82f6)' : 'transparent') + ';color:' +
      (active ? '#fff' : 'var(--text)') + ';border:1px solid var(--border,#334155);' +
      'border-radius:6px;padding:4px 10px;font-size:.75em;cursor:pointer;margin-right:4px">' + label + '</button>';
  };
  // V1.3.31：iPhone 版面 —— 動作鈕一列、篩選鈕另一列（不再擠成一坨）；保留彩色
  var actBtn = 'border:0;border-radius:6px;padding:6px 12px;font-size:.8em;font-weight:700;cursor:pointer;color:#fff';
  return '<div style="margin-bottom:10px">' +
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' +
      '<button onclick="_plOpenEditor(null)" style="background:#10b981;' + actBtn + '">+ New Entry</button>' +
      '<button onclick="_plOpenImport()" style="background:#6366f1;' + actBtn + '">📥 Import</button>' +
      '<button onclick="_plOpenAircraft()" style="background:#0ea5e9;' + actBtn + '">✈️ Aircraft</button>' +
      '<button onclick="_plOpenCrew()" style="background:#a855f7;' + actBtn + '">👥 Crew</button>' +
      '<button onclick="_plOpenPlaces()" style="background:#f59e0b;' + actBtn + '">🗺️ Airports</button>' +
      // V1.3.29：機場碼切換比照日夜間 —— 顯示「按了會切到的目標」
      '<button onclick="_plToggleAptFmt()" style="background:transparent;color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 10px;font-size:.72em;cursor:pointer" title="機場碼顯示切換：按一下切到另一種">🌐 ' + (_plAptFmtCur() === 'iata' ? 'ICAO' : 'IATA') + '</button>' +
      // V1.3.33：一鍵上鎖 / 解鎖全部航班
      '<button onclick="_plLockAll(true)" style="background:transparent;color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 10px;font-size:.72em;cursor:pointer" title="一鍵上鎖全部航班 · Lock every flight">🔒 Lock all</button>' +
      '<button onclick="_plLockAll(false)" style="background:transparent;color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 10px;font-size:.72em;cursor:pointer" title="一鍵解鎖全部航班 · Unlock every flight">🔓 Unlock all</button>' +
      // V2.3：多選勾選刪除（清非航班腿 / ground duty 用）
      '<button onclick="_plToggleSelectMode()" style="background:' + (_pl.selectMode ? '#ef4444' : 'transparent') + ';color:' + (_pl.selectMode ? '#fff' : 'var(--muted)') + ';border:1px solid ' + (_pl.selectMode ? '#ef4444' : 'var(--border,#334155)') + ';border-radius:6px;padding:6px 10px;font-size:.72em;cursor:pointer" title="多選刪除 · Select to delete">' + (_pl.selectMode ? '✕ 取消 Cancel' : '☑️ 選取刪除 Select') + '</button>' +
      (_pl.selectMode ? '<button onclick="_plDeleteSelected()" style="background:#ef4444;' + actBtn + '">🗑 刪除 Delete (<span id="pl-sel-count">' + Object.keys(_pl.selectedIds || {}).length + '</span>)</button>' : '') +
    '</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">' +
      filterBtn('all', 'All') + filterBtn('done', '已完成 Done') +
      filterBtn('open', '未完成 Open') +
    '</div>' +
    // V2.1.09：記錄本搜尋（純前端即時過濾：航班號 / 組員 / 起降機場 / 機尾）
    '<input id="pl-search" type="search" placeholder="🔍 搜尋 航班號 / 組員 / 機場 / 機尾" value="' + _plEsc(_pl.search || '') + '" oninput="_plSearchInput(this.value)" style="margin-top:6px;width:100%;box-sizing:border-box;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:8px;padding:7px 10px;font-size:.78em">' +
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
  // V1.3.09：色條判斷已完成（user：「已完成綠、未完成藍；未來的跟未完成都是藍色」）
  // V1.3.24：改走 _plEntryIsDone（含 SIM / DHD 過去日期 = 已完成）
  var statusColor;
  if (e.needs_completion) statusColor = '#f59e0b';                    // amber - 待補強（飛了、缺資料、等你補；跟「還沒飛的未完成」不同色）
  else if (e.status === 'roster_removed') statusColor = '#94a3b8';    // gray - removed
  else if (_plEntryIsDone(e)) statusColor = '#10b981';               // green - done
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

  var airports = e.is_sim
    ? '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="background:#7c3aed;color:#fff;font-size:.6em;font-weight:800;padding:2px 8px;border-radius:5px;letter-spacing:.5px">SIM</span>' +
        '<span style="font-size:1.05em;font-weight:700">' + _plEsc(e.sim_type || 'Simulator') + '</span>' +
        (e.sim_minutes ? '<span style="font-size:.72em;color:var(--muted)">' + _plMinToHHMM(e.sim_minutes) + '</span>' : '') +
      '</div>'
    : '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">' +
        '<span style="font-size:1.35em;font-weight:800;letter-spacing:.5px">' +
          (e.is_deadhead ? '<span style="background:#475569;color:#cbd5e1;font-size:.42em;font-weight:800;padding:2px 6px;border-radius:4px;letter-spacing:.5px;vertical-align:middle;margin-right:6px">DHD</span>' : '') +
          _plEsc(_plAptFmt(e.origin) || '???') + '</span>' +
        '<span style="font-size:1.35em;font-weight:800;letter-spacing:.5px">' + _plEsc(_plAptFmt(e.dest) || '???') + '</span>' +
      '</div>';

  var meta = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:.7em;color:var(--muted)">' +
    '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">' + acMeta + '</span>' +
    '<span style="white-space:nowrap">' + fltNo + '</span>' +
  '</div>';

  var crewLine = crewNames
    ? '<div style="font-size:.7em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _plEsc(crewNames) + '</div>'
    : '';

  // V2.3：多選模式 —— 點列改成「勾選」而非開編輯器，左側加 checkbox。
  var inSel = _pl.selectMode;
  var isChk = inSel && _pl.selectedIds && _pl.selectedIds[e.id];
  var rowOnclick = inSel ? '_plToggleSelect(\'' + e.id + '\')' : '_plOpenEditor(\'' + e.id + '\')';
  var chkbox = inSel
    ? '<div style="flex:0 0 auto;display:flex;align-items:center"><input type="checkbox"' + (isChk ? ' checked' : '') + ' onclick="event.stopPropagation();_plToggleSelect(\'' + e.id + '\')" style="width:20px;height:20px"></div>'
    : '';
  return '<div class="pl-row' + selCls + (isChk ? ' pl-row-sel' : '') + '" data-yr="' + (/^\d{4}/.test(ds) ? ds.slice(0, 4) : '') + '" onclick="' + rowOnclick + '" ' +
    'style="background:var(--card);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;display:flex;gap:12px;align-items:stretch;scroll-margin-top:70px">' +
    chkbox +
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

// V2.1.09：搜尋比對 —— 航班號 / 起降機場 / 機尾 / 組員名字任一含 q 即命中
function _plEntryMatchesSearch(e, q) {
  if (!q) return true;
  var hay = [e.flight_no, e.origin, e.dest, e.tail_no];
  // 組員值可能是 string 或 {name,rank,eid}；用 _plCrewDisplayName 取「顯示的名字」（含 eid→通訊錄名）
  if (e.crew) { for (var k in e.crew) { var nm = _plCrewDisplayName(e.crew[k]); if (nm) hay.push(nm); } }
  for (var i = 0; i < hay.length; i++) { if (hay[i] && String(hay[i]).toLowerCase().indexOf(q) >= 0) return true; }
  return false;
}
// 搜尋輸入：只更新清單（不重畫工具列，保留輸入焦點）
function _plSearchInput(v) {
  _pl.search = v || '';
  _plRenderList();
}
function _plRenderList() {
  var c = document.getElementById('pl-list');
  if (!c) return;
  // V1.3.08：filter 改成 client-side（all / past / future / removed）
  var shown = _pl.entries.filter(function(e) { return _plEntryMatchesFilter(e, _pl.filter); });
  // V2.1.09：搜尋（即時過濾，純前端）—— 航班號 / 組員 / 起降機場 / 機尾任一命中
  if (_pl.search) {
    var q = String(_pl.search).toLowerCase();
    shown = shown.filter(function(e) { return _plEntryMatchesSearch(e, q); });
  }
  if (shown.length === 0) {
    c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">' +
      (_pl.filter === 'all'
        ? '尚無紀錄。點 <b>+ New Entry</b> 新增，或 <b>📥 Import</b> 匯入 LogTen Pro 資料。<br>No entries yet — tap <b>+ New Entry</b>, or <b>📥 Import</b> your LogTen Pro data.'
        : '此分類無紀錄。<br>No entries in this filter.') +
    '</div>';
    _plRenderYearIndex();
    return;
  }
  // 待補強釘最上面（不管日期）— 要顯眼逼使用者去補；其餘維持原本日期排序（API 已 ORDER BY flight_date DESC，sort 穩定）。
  shown.sort(function(a, b) { return (b.needs_completion ? 1 : 0) - (a.needs_completion ? 1 : 0); });
  c.innerHTML = shown.map(_plRenderEntryRow).join('');
  _plRenderYearIndex();
  _plDeferYearIndex();   // 直接開 PWA 載入太快時，index 會搶在版面/字體排好前就建 → 位移或年份截斷；排好後再校正一次
}

// V2.2.08：通訊錄式右側年份索引 —— 常駐、一眼看到整個職涯跨度、可點可滑（滑動時中央放大泡泡顯示年份）。
// 借 iPhone 通訊錄 A–Z 索引那套，解決 LogTen 細條難點的問題。window 捲動，索引 position:fixed 貼 list pane 右緣。
function _plYearBubble(yr) {
  var b = document.getElementById('pl-year-bubble');
  if (yr == null) { if (b) b.style.display = 'none'; return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'pl-year-bubble';
    b.style.cssText = 'position:fixed;z-index:56;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'background:rgba(15,23,42,.92);color:#fff;font-weight:800;font-size:2.6em;padding:14px 28px;border-radius:18px;' +
      'box-shadow:0 10px 34px rgba(0,0,0,.55);pointer-events:none;letter-spacing:1px';
    document.body.appendChild(b);
  }
  b.textContent = yr;
  b.style.display = 'block';
}
function _plYearIndexEl() {
  var el = document.getElementById('pl-year-index');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'pl-year-index';
  el.style.cssText = 'position:fixed;z-index:55;display:none;flex-direction:column;justify-content:space-between;' +
    'align-items:center;padding:6px 5px;top:50%;transform:translateY(-50%);touch-action:none;cursor:pointer;' +
    'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent';
  var onMove = function (clientY) {
    var yrs = el._yrs || [];
    if (!yrs.length) return;
    var r = el.getBoundingClientRect();
    var frac = (clientY - r.top) / Math.max(1, r.height);
    var i = Math.max(0, Math.min(yrs.length - 1, Math.floor(frac * yrs.length)));
    var yr = yrs[i];
    _plYearBubble(yr);
    var row = document.querySelector('#pl-list [data-yr="' + yr + '"]');
    if (row) row.scrollIntoView({ block: 'start' });
  };
  el.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_e) {}
    el._drag = true; onMove(e.clientY);
  });
  el.addEventListener('pointermove', function (e) { if (el._drag) { e.preventDefault(); onMove(e.clientY); } });
  var end = function () { el._drag = false; _plYearBubble(null); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  document.body.appendChild(el);
  // 視窗尺寸/轉向變化 → 重新定位 + 量 sticky 標題高
  try {
    window.addEventListener('resize', function () { _plUpdateBannerHeight(); _plUpdateHeadHeight(); if (_pl.tab === 'logbook') _plRenderYearIndex(); _plPlacesReflow(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { _plUpdateBannerHeight(); _plUpdateHeadHeight(); if (_pl.tab === 'logbook') _plRenderYearIndex(); _plPlacesReflow(); }, 250); });
  } catch (_e) {}
  // #2：盯著內容區 —— 任何頁面切換/子頁（Aircraft/Crew/Airports/編輯器…）替換 #pilotlog-content 內容時
  // 都重判一次：①收起漏到別頁的年份索引 ②更新 sticky 標題高度 --pl-head-h（給編輯器下移/Analyze 標題固定用）。
  try {
    var content = document.getElementById('pilotlog-content');
    if (content && window.MutationObserver) {
      new MutationObserver(function () { _plRenderYearIndex(); _plUpdateHeadHeight(); }).observe(content, { childList: true });
    }
  } catch (_e) {}
  return el;
}
// 量目前頁面 sticky 標題（.pl-topstack / .pl-stickhead）實際高度 → 寫進 --pl-head-h。
// 給 #7（iPad 編輯器 detail-pane 黏貼位置往下移過標題）與 #2（Analyze 群組標題固定在標題下）共用。
var _plHeadRO = null, _plHeadROEl = null;
function _plUpdateHeadHeight() {
  try {
    var h = document.querySelector('#pilotlog-content .pl-topstack, #pilotlog-content .pl-stickhead');
    var px = h ? Math.round(h.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--pl-head-h', px + 'px');
    // V2.3.04：頁首高度會在量完「之後」才變（工具列換行 / 字體載入 / 離線橫幅出現）→ --pl-head-h 過時
    // → iPad sticky 編輯面板貼進頁首底下、Edit Entry 列被搜尋框蓋住拉不回來（user 實測）。
    // 掛 ResizeObserver 盯著頁首元素，高度一變就重寫（值沒變不會重複觸發，不會迴圈）。
    if (window.ResizeObserver && h !== _plHeadROEl) {
      if (_plHeadRO) { _plHeadRO.disconnect(); _plHeadRO = null; }
      _plHeadROEl = h;
      if (h) { _plHeadRO = new ResizeObserver(function () { _plUpdateHeadHeight(); }); _plHeadRO.observe(h); }
    }
  } catch (e) {}
}
function _plRenderYearIndex() {
  _plUpdateHeadHeight();   // logbook 渲染時順手更新 --pl-head-h（給 iPad 編輯器下移用）
  var el = _plYearIndexEl();
  var list = document.getElementById('pl-list');
  // 只在 logbook 航班清單顯示（切到別頁 / 編輯中 / #pl-list 不在 → 收起來，並還原 list 右邊 gutter）。
  if (_pl.tab !== 'logbook' || !list || _pl.editing) { el.style.display = 'none'; _plYearBubble(null); if (list) list.style.paddingRight = ''; return; }
  var rows = list.querySelectorAll('[data-yr]');
  var yrs = [], seen = {};
  for (var i = 0; i < rows.length; i++) {
    var y = rows[i].getAttribute('data-yr');
    if (y && !seen[y]) { seen[y] = 1; yrs.push(y); }
  }
  if (yrs.length < 2) { el.style.display = 'none'; list.style.paddingRight = ''; return; }   // 只有一年 → 沒必要
  el._yrs = yrs;   // 滑動一律對應「完整年份清單」，泡泡顯示確切年（標籤可抽稀，不影響精準度）
  // 貼齊 list pane 右緣（iPhone 滿版 → 視窗右緣；iPad split → 左側列表的右緣）
  var pane = document.querySelector('.pl-list-pane');
  var rightInset = 3;
  if (pane) { var pr = pane.getBoundingClientRect(); rightInset = Math.max(3, window.innerWidth - pr.right + 3); }
  el.style.right = rightInset + 'px';
  // #2：錨定在固定工具列「下方」。用標題「實際底緣」(getBoundingClientRect) 定位 → 自動含狀態列安全區
  // （Tools 入口 PWA 是透明狀態列，內容鑽到瀏海下；用 headH+14 會少算 safe-area → 索引凸頂搜尋框）與離線橫幅，
  // 不用各自加總。headH 只當抓不到標題時的退路。
  var headEl = document.querySelector('#pilotlog-content .pl-topstack, #pilotlog-content .pl-stickhead');
  var headH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--pl-head-h'), 10) || 0;
  var topPx = headEl ? (Math.max(0, Math.round(headEl.getBoundingClientRect().bottom)) + 14) : (headH + 14);
  el.style.top = topPx + 'px';
  el.style.transform = 'none';
  var avail = Math.max(120, window.innerHeight - topPx - 74);   // 預留底部 tab bar 空間
  var hPx = Math.min(avail, Math.max(8, yrs.length) * 26);
  el.style.height = hPx + 'px';
  // #3：標籤「抽稀」—— 螢幕裝得下幾個就顯示幾個（年份多就均勻跳著當刻度），避免愈來愈長爆出螢幕。
  var maxLabels = Math.max(4, Math.floor(hPx / 24));
  var labels = yrs;
  if (yrs.length > maxLabels) {
    labels = [];
    for (var k = 0; k < maxLabels; k++) labels.push(yrs[Math.round(k * (yrs.length - 1) / (maxLabels - 1))]);
    var sn = {}; labels = labels.filter(function (v) { if (sn[v]) return false; sn[v] = 1; return true; });
  }
  el.innerHTML = labels.map(function (y) {
    return '<span style="font-size:.6em;font-weight:700;color:var(--muted);line-height:1.05;padding:1px 0;pointer-events:none;font-variant-numeric:tabular-nums">’' + y.slice(2) + '</span>';
  }).join('');
  el.style.display = 'flex';
  // #1：讓出右邊 gutter，索引不壓到班號/組員（量索引實際寬 + 緩衝）
  list.style.paddingRight = (el.offsetWidth + 6) + 'px';
}
// 直接開 PWA（吃快取）載入太快時，_plRenderYearIndex 會搶在「工具列高度量好、航班全排好、字體載入完」之前就建好，
// 導致索引位移（頂到搜尋框）或年份被截斷（iPad 只到 2014）。這裡在版面 settle 後再重建一次校正 →
// 不論快載/慢載、iPhone/iPad、入口進/直接開，最後都以排好後的正確狀態為準。
function _plDeferYearIndex() {
  var rerun = function () { if (_pl.tab === 'logbook' && !_pl.editing) _plRenderYearIndex(); };
  requestAnimationFrame(function () { requestAnimationFrame(rerun); });
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(rerun); } catch (e) {}
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
  _pl.aptReturn = false;   // V1.3.39：回到 Logbook 主列表 → 清掉 Airports 返回標記
  // V1.3 離線優先：只有「有網路且手機裡沒有可用身分」才跳登入（Google 登入本來就要網路）。
  // 離線時即使 _pl.user 物件還沒建好，也照樣顯示快取的 logbook，不卡登入。
  if (!_pl.user && _plOnline() && !_plHasSession()) { _plRenderLogin(); return; }
  _plShowTabBar(true);
  _plHighlightTab('logbook');
  var email = (_pl.user && _pl.user.primaryEmail) || '';
  c.innerHTML =
    '<div>' +
      // V2.2.08：整個頂部（標題 email + 工具列）固定 —— 長列表滑到哪都能搜尋/篩選/+New（option B）。
      '<div class="pl-topstack" style="position:sticky;top:env(safe-area-inset-top);z-index:40;background:var(--bg,#0a0e1a);padding:10px 14px 8px;will-change:transform;-webkit-backface-visibility:hidden">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">' +
        '<div style="font-size:1em;font-weight:700;white-space:nowrap">📒 Logbook</div>' +
        '<div id="pl-sync-status" style="font-size:.65em;flex:1;text-align:center"></div>' +
        '<div style="position:relative;max-width:48%;flex-shrink:0">' +
          '<div onclick="_plToggleAcctMenu(event)" title="帳號" style="display:flex;align-items:center;justify-content:flex-end;gap:3px;font-size:.65em;color:var(--muted);white-space:nowrap;cursor:pointer">' +
            '<span style="overflow:hidden;text-overflow:ellipsis">' + _plEsc(email) + '</span><span style="opacity:.6">▾</span>' +
          '</div>' +
          '<div id="pl-acct-menu" style="display:none;position:absolute;right:0;top:100%;margin-top:6px;min-width:200px;background:var(--bg-elev,#1a1f2e);border:1px solid var(--border,#334155);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:60;overflow:hidden;text-align:left">' +
            '<div style="padding:10px 14px;border-bottom:1px solid var(--border,#334155)">' +
              '<div style="font-size:.72em;color:var(--muted);word-break:break-all">' + _plEsc(email) + '</div>' +
              '<div id="pl-acct-tier" style="font-size:.78em;font-weight:700;margin-top:3px">' + _plTierLabel() + '</div>' +
            '</div>' +
            '<button onclick="_plLogout()" style="display:block;width:100%;text-align:left;background:transparent;color:var(--text);border:0;padding:11px 14px;font-size:.82em;cursor:pointer">🚪 登出 Logout</button>' +
            // V2.2.00：刪除帳號從選單移除（原本貼在登出下面易誤觸）→ 改指路到 版本ⓘ→Danger Zone（獨立畫面 + 雙重確認）。
            '<div onclick="var m=document.getElementById(\'pl-acct-menu\');if(m)m.style.display=\'none\';plShowAbout()" style="border-top:1px solid var(--border,#334155);padding:9px 14px;font-size:.64em;color:var(--muted);cursor:pointer;line-height:1.5">要刪除帳號？請至 <b>版本 ⓘ → Danger Zone</b><br>To delete account: tap the version number → Danger Zone</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="pl-toolbar">' + _plRenderToolbar() + '</div>' +
      '</div>' +   // close .pl-topstack（固定頂部）
      '<div class="pl-split" style="padding:0 14px">' +
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
      '<div style="font-size:.7em;color:var(--muted);max-width:320px;line-height:1.6;margin-top:6px;opacity:.85">' +
        '🔒 登入只是把紀錄<b>綁在你帳號、跨裝置同步＋雲端備份</b>；只取得 email 辨識身分，<b>不會讀取你的信箱、雲端硬碟或通訊錄</b>。<br>' +
        '<span style="opacity:.75">Sign-in only links your logbook to your account for sync &amp; backup. We just get your email — never your inbox, Drive or contacts.</span>' +
      '</div>' +
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
    pax_count: null, crew_count: null, operating_crew: null, dep_rwy: '', arr_rwy: '', sid: '', star: '', remarks: '',
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
    // V1.3.26：新增航班不再硬帶「機尾庫第一台」的機型 / 機尾（user：不必要，且換機型時舊機尾還不清）。留空白讓使用者自己選。
    _pl.editing = _plBlankEntry();
  }
  // iPad（>=768px）且 logbook 的右明細面板存在 → render 到右側、列表保留；
  // 否則（iPhone、或 Aircraft/Crew detail 等場景）→ 全螢幕（原行為）
  _pl.selectedId = id || null;
  if (_plWide() && document.getElementById('pl-detail-pane')) {
    _plRenderEditor('pl-detail-pane');
    _plRenderList();                    // 重畫列表套用 .pl-row-sel highlight
  } else {
    _plRenderEditor();
    _plRenderYearIndex();   // codex P2：iPhone 全螢幕編輯器替換內容 → 收起年份索引（guard 認 _pl.editing/#pl-list 不在）
  }
}

function _plCloseEditor() {
  _pl.editing = null;
  _pl.selectedId = null;
  // V2.0.01（codex P2）：從 Airports 點航班進來的 → 關閉回對的那一層（三層導航才順）：
  //   寬螢幕 → 回三欄（保留選中機場）；窄螢幕 → 回該機場詳情頁（不是回最上層列表）。
  if (_pl.aptReturn) {
    if (_plAptIsWide()) _plRenderPlaces();
    else if (_pl.aptDetailKey && _pl.aptFlightsFilt) _plOpenPlaceFlights(_pl.aptDetailKey, _pl.aptFlightsFilt);   // 從子頁點航班進來 → 回子頁(不是回詳情)
    else if (_pl.aptDetailKey) _plOpenPlaceDetail(_pl.aptDetailKey);
    else _plOpenPlaces();
    return;
  }
  // iPad split：清右側回 placeholder + 重畫列表去掉 highlight；列表保持原位不重 fetch
  if (_plWide() && document.getElementById('pl-detail-pane')) {
    document.getElementById('pl-detail-pane').innerHTML = _plDetailPlaceholder();
    _plRenderList();
    return;
  }
  _plRenderMain();
}

// V2.3：欄位自訂顯示名稱（LogTen 式 Configure Fields）。name = 穩定欄位 key、def = 預設標籤。
function _plFieldLabel(name, def) {
  if (_pl.fieldLabels == null) {
    try { var s = localStorage.getItem('pilotlog_field_labels'); if (s) _pl.fieldLabels = JSON.parse(s); } catch (e) {}
  }
  var lbl = _pl.fieldLabels && name && _pl.fieldLabels[name];
  return (typeof lbl === 'string' && lbl.trim()) ? lbl.trim() : def;
}
// 欄位標籤的 HTML：config 模式 → 可編輯 input（id=pl-fl-<name>）；否則靜態文字。extraStyle 給排版微調。
function _plFieldLabelHtml(name, def, extraStyle) {
  var disp = _plFieldLabel(name, def);
  if (_pl.configFields && name) {
    return '<input id="pl-fl-' + name + '" value="' + _plEsc(disp) + '" placeholder="' + _plEsc(def) + '" maxlength="24" ' +
      'onclick="event.stopPropagation()" ' +
      'style="width:100%;box-sizing:border-box;background:#1e293b;color:#fbbf24;border:1px dashed #f59e0b;border-radius:5px;padding:3px 6px;font-size:.62em;margin-bottom:2px;' + (extraStyle || '') + '">';
  }
  return '<div style="font-size:.62em;color:var(--muted);margin-bottom:2px;' + (extraStyle || '') + '">' + _plEsc(disp) + '</div>';
}
function _plEditorField(label, name, type, opts) {
  opts = opts || {};
  var e = _pl.editing;
  var val = e[name];
  if (val == null) val = '';
  var attrs = 'id="ple-' + name + '" style="width:100%;box-sizing:border-box;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em"';
  var input;
  if (type === 'time-utc') {
    var oninp = opts.localOf ? ' oninput="_plUpdateSchedLocal(\'' + name + '\',\'' + opts.localOf + '\')"' : '';
    input = '<input ' + attrs + oninp + ' value="' + _plEsc(_plFmtUtcHHMM(val)) + '" placeholder="HHMM UTC" maxlength="4">';
  } else if (type === 'hhmm-dur') {
    // V2.3.05：Total Duty 存 0（匯入來源的「沒資料」寫法）→ 顯示空白。0:00 既誤導又擋自動計算。
    if (name === 'total_duty_minutes' && (val === 0 || val === '0')) val = null;
    input = '<input ' + attrs + ' value="' + _plEsc(_plMinToHHMM(val)) + '" placeholder="H:MM">';
  } else if (type === 'select') {
    var optsHtml = (opts.options || []).map(function(o) {
      return '<option value="' + _plEsc(o) + '"' + (String(val) === String(o) ? ' selected' : '') + '>' + _plEsc((opts.optLabels && opts.optLabels[o]) || o || '—') + '</option>';
    }).join('');
    input = '<select ' + attrs + '>' + optsHtml + '</select>';
  } else if (type === 'check') {
    input = '<label style="display:flex;align-items:center;gap:6px;font-size:.78em"><input type="checkbox" id="ple-' + name + '"' + (val ? ' checked' : '') + '> ' + _plEsc(opts.checkLabel || label) + '</label>';
  } else if (type === 'textarea') {
    input = '<textarea ' + attrs + ' rows="2">' + _plEsc(val) + '</textarea>';
  } else if (type === 'number') {
    if (opts.readonly) attrs = 'id="ple-' + name + '" readonly tabindex="-1" style="width:100%;box-sizing:border-box;background:var(--card);color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em;font-weight:700"';
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
    // V2.2.05：自訂日期欄 —— 上層 readonly 顯示純數字 YYYY-MM-DD（避免 iOS 中文長格式「2026年6月5日」
    // 撐出格子壓到 Flight#）；底層透明原生 <input type=date>（id 維持 ple-<name>，點了照樣跳 iOS 原生日曆）。
    input = '<div style="position:relative">' +
      '<input id="ple-' + name + '-disp" readonly tabindex="-1" value="' + _plEsc(dateStr) + '" placeholder="YYYY-MM-DD" ' +
        'style="width:100%;box-sizing:border-box;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em">' +
      '<input type="date" id="ple-' + name + '" value="' + _plEsc(dateStr) + '" ' +
        'onclick="try{this.showPicker()}catch(e){}" oninput="_plDateSync(\'' + name + '\')" onchange="_plDateSync(\'' + name + '\')" ' +
        'style="position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;margin:0;padding:0;color:transparent;background:transparent">' +
      '</div>';
  } else if (opts.aptSide) {
    // V2.2.05：From/To 自訂下拉（取代 iPhone 不穩的原生 datalist）。候選＝星宇 37 航點，點一下一定跳、
    // 打字即時篩；手動輸入照常（含星宇以外機場，只是那些不會有候選）。
    var dvalA = opts.fmt ? opts.fmt(val) : val;
    var attrsA = attrs.replace('padding:6px 8px', 'padding:6px 26px 6px 8px');
    var side = opts.aptSide;
    input = '<div style="position:relative">' +
      '<input ' + attrsA + ' autocomplete="off" value="' + _plEsc(dvalA) + '" placeholder="' + _plEsc(opts.placeholder || '選或輸入 · pick or type') + '"' +
        ' onfocus="_plAptDropdown(\'' + side + '\')" oninput="_plAptDropdown(\'' + side + '\')" onblur="_plAptDDClose(\'' + side + '\')">' +
      '<span style="position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--muted);font-size:.8em">▾</span>' +
      '<div id="ple-' + side + '-dd" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:60;max-height:190px;overflow-y:auto;background:var(--card,#0f172a);border:1px solid var(--border,#334155);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45)"></div>' +
      '</div>';
  } else if (opts.rwySide) {
    // V2.2.05：跑道（Dep/Arr Rwy）比照 From/To 換自訂下拉，取代 iPhone 不穩的原生 datalist。
    // 候選＝對應機場（origin→Dep / dest→Arr）的跑道號，聚焦/打字時即時依當前機場算；手動輸入照常。
    var dvalR = val;
    var attrsR = attrs.replace('padding:6px 8px', 'padding:6px 26px 6px 8px');
    var rwSide = opts.rwySide;
    input = '<div style="position:relative">' +
      '<input ' + attrsR + ' autocomplete="off" value="' + _plEsc(dvalR) + '"' + (opts.placeholder ? ' placeholder="' + _plEsc(opts.placeholder) + '"' : '') +
        ' onfocus="_plRwyDropdown(\'' + name + '\',\'' + rwSide + '\')" oninput="_plRwyDropdown(\'' + name + '\',\'' + rwSide + '\')" onblur="_plRwyDDClose(\'' + name + '\')">' +
      '<span style="position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--muted);font-size:.8em">▾</span>' +
      '<div id="ple-' + name + '-dd" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:60;max-height:190px;overflow-y:auto;background:var(--card,#0f172a);border:1px solid var(--border,#334155);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45)"></div>' +
      '</div>';
  } else if (opts.listId) {
    // V2.0.01：datalist 下拉 + 持續顯示的 ▾ 提示（讓使用者知道可下拉選，也能手動輸入覆蓋）
    var dvalL = opts.fmt ? opts.fmt(val) : val;
    var attrsL = attrs.replace('padding:6px 8px', 'padding:6px 26px 6px 8px');
    input = '<div style="position:relative">' +
      '<input ' + attrsL + ' list="' + opts.listId + '" autocomplete="off" value="' + _plEsc(dvalL) + '" placeholder="' + _plEsc(opts.placeholder || '選或輸入 · pick or type') + '">' +
      '<span style="position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--muted);font-size:.8em">▾</span>' +
      '<datalist id="' + opts.listId + '"></datalist></div>';
  } else {
    var dval = opts.fmt ? opts.fmt(val) : val;   // V1.3.20：可選顯示格式轉換（如機場碼 IATA/ICAO）
    input = '<input ' + attrs + ' value="' + _plEsc(dval) + '"' + (opts.placeholder ? ' placeholder="' + _plEsc(opts.placeholder) + '"' : '') + '>';
  }
  if (type === 'check') return '<div style="margin-bottom:8px">' + input + '</div>';
  // time-utc 帶 localOf：欄位下方一行藍字顯示「當地時間 (UTC+x)」，依 origin/dest 時區換算（不影響排版，獨占一行）
  var sub = (type === 'time-utc' && opts.localOf)
    ? '<div id="ple-' + name + '-local" style="font-size:.58em;color:#60a5fa;margin-top:2px;min-height:1.1em;letter-spacing:.3px"></div>'
    : '';
  // V2.3：label 走自訂顯示名稱。opts.labelId（From/To 會隨 IATA/ICAO 動態改寫）平常用可被 _plSyncRouteFmt
  // 改寫的 <div>；config 模式（codex P3）則跟其他欄位一樣變可編輯 input，讓 From/To 也能改名。
  var labelHtml = (opts.labelId && !_pl.configFields)
    ? '<div id="' + opts.labelId + '" style="font-size:.62em;color:var(--muted);margin-bottom:2px">' + _plEsc(_plFieldLabel(name, label)) + '</div>'
    : _plFieldLabelHtml(name, label);
  // V2.4.03：labelSuffix —— 在 label 同一列右側塞東西（Off Duty 旁的 FDP Limit 標籤用）。
  if (opts.labelSuffix) {
    labelHtml = '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:6px;margin-bottom:2px">' + labelHtml + opts.labelSuffix + '</div>';
  }
  return '<div style="margin-bottom:8px">' + labelHtml + input + sub + '</div>';
}
// time-utc 欄位 → 當地時間提示：用 flight_date + HHMM(UTC) 組 UTC 時間，再依 origin/dest 機場時區換算。
// 顯示「16:30 (UTC+8)」格式；資料不全（無時間/日期/機場/時區）就清空，不擋排版。
function _plTzOffsetStr(tz, date) {
  try {
    var p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date || new Date());
    var o = p.find(function(x) { return x.type === 'timeZoneName'; });
    return o ? o.value.replace('GMT', 'UTC').replace('UTC+0', 'UTC').replace(/^UTC$/, 'UTC+0') : '';
  } catch (e) { return ''; }
}
function _plUpdateSchedLocal(name, side) {
  var el = document.getElementById('ple-' + name + '-local');
  if (!el) return;
  el.textContent = '';
  var hhmm = (_plGetVal('ple-' + name) || '').replace(/[^0-9]/g, '');
  var m = /^(\d{2})(\d{2})$/.exec(hhmm);
  var dateStr = (_plGetVal('ple-flight_date') || '').slice(0, 10);
  var code = (_plGetVal('ple-' + (side === 'dest' ? 'dest' : 'origin')) || '').trim();
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !code) return;
  var info = _plAptInfo(code);
  if (!info || !info.tz) return;
  var utc = new Date(dateStr + 'T' + m[1] + ':' + m[2] + ':00Z');
  if (isNaN(utc.getTime())) return;
  var local = '';
  try { local = new Intl.DateTimeFormat('en-GB', { timeZone: info.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(utc); } catch (e) { return; }
  var off = _plTzOffsetStr(info.tz, utc);
  el.textContent = '🕒 ' + local + (off ? ' (' + off + ')' : '');
}
function _plRefreshSchedLocal() {
  _plUpdateSchedLocal('std_utc', 'origin');
  _plUpdateSchedLocal('sta_utc', 'dest');
}
// From/To 即時天氣：點開才抓 METAR/TAF（展開式 panel，收合時不佔空間、不動原排版）。
// 沿用 roster 同一組 server proxy（/api/metar、/api/taf），輸入碼一律先轉 ICAO。
function _plWxIcao(code) {
  var info = _plAptInfo((code || '').trim());
  return (info && info.icao) ? info.icao : (code || '').toUpperCase().trim();
}
function _plFetchWxOne(icao) {
  return fetch('/api/metar?ids=' + icao + '&hours=1')
    .then(function(r) { return r.ok ? r.text() : ''; })
    .then(function(metarText) {
      var lines = metarText.trim().split('\n').filter(function(l) { return l.trim() && !l.startsWith('No'); });
      return fetch('/api/taf?ids=' + icao).then(function(r) { return r.ok ? r.text() : ''; }).then(function(tafText) {
        return { metar: lines.length ? lines[0].trim() : '', taf: (tafText && tafText.trim() && !tafText.startsWith('No')) ? tafText.trim() : '' };
      });
    })
    .catch(function() { return { metar: '', taf: '' }; });
}
function _plWxMapCollapsed() {
  try { return localStorage.getItem('pilotlog_wxmap_collapsed') === '1'; } catch (e) { return false; }
}
// 收合/展開 WX panel 內所有跑道圖（一鍵同步起降兩張），狀態記 localStorage，下次點開維持偏好。
function _plToggleWxMap() {
  var collapsed = !_plWxMapCollapsed();
  try { localStorage.setItem('pilotlog_wxmap_collapsed', collapsed ? '1' : '0'); } catch (e) {}
  var panel = document.getElementById('ple-wx-panel');
  if (!panel) return;
  var maps = panel.querySelectorAll('.pl-wxmap'), btns = panel.querySelectorAll('.pl-wxmap-btn');
  for (var i = 0; i < maps.length; i++) maps[i].style.display = collapsed ? 'none' : '';
  for (var j = 0; j < btns.length; j++) btns[j].textContent = '🗺️ 跑道圖 ' + (collapsed ? '▸' : '▾');
}
// WX 欄＝機場碼標題 + 可收合跑道地圖（風向綠橘 + 風分量）+ METAR + TAF。info 有跑道座標才畫地圖。
function _plWxCol(code, wx, info) {
  if (!code) return '';
  var h = '<div style="flex:1 1 260px;min-width:0;background:var(--bg,#0a0e1a);border:1px solid var(--border,#334155);border-radius:8px;padding:8px 10px;word-break:break-word;font-size:.72em;line-height:1.45">';
  h += '<div style="font-weight:700;color:var(--text);margin-bottom:4px">' + _plEsc(code) + '</div>';
  if (info && info.lat != null && info.lon != null) {
    var col = _plWxMapCollapsed();
    h += '<button type="button" class="pl-wxmap-btn" onclick="_plToggleWxMap()" style="background:none;border:none;color:#60a5fa;font-size:1em;font-weight:700;cursor:pointer;padding:2px 0">🗺️ 跑道圖 ' + (col ? '▸' : '▾') + '</button>';
    h += '<div class="pl-wxmap" style="display:' + (col ? 'none' : '') + '">' + _plAptMapHtml(info) + '</div>';
  }
  if (wx && wx.metar) h += '<div style="font-weight:700;color:#22c55e">METAR</div><div style="margin-bottom:6px">' + _plEsc(wx.metar) + '</div>';
  if (wx && wx.taf) h += '<div style="font-weight:700;color:#22c55e">TAF</div><div>' + _plEsc(wx.taf).replace(/\n/g, '<br>') + '</div>';
  if (!wx || (!wx.metar && !wx.taf)) h += '<div style="color:var(--muted)">No WX data</div>';
  return h + '</div>';
}
function _plToggleEditorWx() {
  var panel = document.getElementById('ple-wx-panel'), btn = document.getElementById('ple-wx-btn');
  if (!panel) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; if (btn) btn.textContent = '⛅ WX + 跑道圖 · METAR / TAF ▾'; return; }
  var o = (_plGetVal('ple-origin') || '').trim(), d = (_plGetVal('ple-dest') || '').trim();
  if (!o && !d) return;
  panel.style.display = 'block';
  if (btn) btn.textContent = '⛅ WX + 跑道圖 · METAR / TAF ▴';
  panel.innerHTML = '<div style="color:var(--muted);font-size:.72em;padding:6px 0">載入中… · loading</div>';
  var io = o ? _plAptInfo(o) : null, id = d ? _plAptInfo(d) : null;
  var icaoO = io && io.icao ? io.icao : (o ? _plWxIcao(o) : '');
  var icaoD = id && id.icao ? id.icao : (d ? _plWxIcao(d) : '');
  Promise.all([
    icaoO ? _plFetchWxOne(icaoO) : Promise.resolve(null),
    icaoD ? _plFetchWxOne(icaoD) : Promise.resolve(null)
  ]).then(function(res) {
    // 先把風向存進快取，地圖 render 時就能直接上綠橘色（省一次 fetch）
    if (icaoO && res[0]) _plAptWind[icaoO] = _plParseMetarWind(res[0].metar);
    if (icaoD && res[1]) _plAptWind[icaoD] = _plParseMetarWind(res[1].metar);
    panel.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      _plWxCol(o.toUpperCase(), res[0], io) + _plWxCol(d.toUpperCase(), res[1], id) + '</div>';
  });
}

// 語意分組：固定 N 欄的 grid row（minmax(0,1fr) 允許窄螢幕收縮、不溢出）。
// 取代原本 auto-fit「塞得下就配對」造成的眼花排版。
function _plFieldRow(cols, fieldsHtml) {
  return '<div style="display:grid;grid-template-columns:repeat(' + cols + ',minmax(0,1fr));gap:10px">' + fieldsHtml + '</div>';
}
function _plFieldSub(label) {
  return '<div style="font-size:.58em;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin:10px 0 3px">' + _plEsc(label) + '</div>';
}
// V2.3：組員槽位 —— 對齊後端 src/pilot-log/crew-slots.ts（瀏覽器端不能 import .ts，這裡平行定義；改一邊兩邊都要同步）。
//   飛航組：pic / crew2(SIC) / crew3-6(Relief) / cic / obs / obs2 ；客艙組：cabin1..cabin20（預設 "Cabin N"，可自訂）。
//   既有 6 槽（pic/crew2/crew3/crew4/cic/obs）key 不變 → 舊資料、舊自訂標籤、舊程式全相容。
var PL_FLIGHT_KEYS = ['pic', 'crew2', 'crew3', 'crew4', 'crew5', 'crew6', 'cic', 'obs', 'obs2'];
var PL_CABIN_KEYS = [];
for (var _plCi = 1; _plCi <= 20; _plCi++) PL_CABIN_KEYS.push('cabin' + _plCi);
var PL_CREW_KEYS = PL_FLIGHT_KEYS.concat(PL_CABIN_KEYS);
var PL_CREW_LABEL_DEFAULT = {
  pic: 'PIC', crew2: 'SIC', crew3: 'Relief 1', crew4: 'Relief 2', crew5: 'Relief 3', crew6: 'Relief 4',
  cic: 'CIC', obs: 'Observer', obs2: 'Observer 2',
};
PL_CABIN_KEYS.forEach(function(k, i) { PL_CREW_LABEL_DEFAULT[k] = 'Cabin ' + (i + 1); });
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
// V1.3.14：員編 → 通訊錄顯示名字 的索引。班表只帶官方拼音（JUNG-HAO LEE），但通訊錄裡使用者存的是
// 認得的名字（Reggie Lee 李戎浩）。顯示組員時用員編去換成使用者存的名字 —— 而且是「顯示當下才換」、
// 不寫死，所以改通訊錄名字、過去所有航班一起更新。以 _pl.crew 陣列參照當快取鍵，名單重載才重建。
function _plEidNameIndex() {
  if (_pl._eidIdxSrc === _pl.crew && _pl._eidIdx) return _pl._eidIdx;
  var byEid = {};
  (_pl.crew || []).forEach(function(c) {
    var nm = (c.display_name || '').trim();
    if (!nm) return;
    (c.employee_ids || []).forEach(function(eid) {
      var e = String(eid == null ? '' : eid).trim();
      if (e && !byEid[e]) byEid[e] = nm;
    });
  });
  _pl._eidIdx = byEid; _pl._eidIdxSrc = _pl.crew;
  return byEid;
}
// 單一 crew 槽值 → 顯示名字：有員編且通訊錄查得到 → 用通訊錄名；否則退回槽裡存的名字（班表拼音）。
function _plCrewDisplayName(v) {
  var o = _plCrewVal(v);
  var eid = (o.eid || '').trim();
  if (eid) { var idx = _plEidNameIndex(); if (idx[eid]) return idx[eid]; }
  return o.name ? o.name.trim() : '';
}
// V1.3.12（codex P1）：把舊 schema 的 crew key 對映到新 6 槽，讓編輯舊紀錄時看得到、可編、不掉資料。
// 只在新槽是空的時候搬；observer2 無對應槽 → 留在物件裡（存檔時 _plSaveEntry 會保留，不丟）。
function _plMigrateLegacyCrew(crew) {
  if (!crew || typeof crew !== 'object') return crew || {};
  var map = { sic: 'crew2', fo1: 'crew3', fo2: 'crew4', purser: 'cic', observer1: 'obs', observer2: 'obs2' };
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
  function _lblRow(k) {
    return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">' +
      '<span style="font-size:.6em;color:var(--muted);width:54px;flex-shrink:0">' + k + '</span>' +
      '<input id="pl-cl-' + k + '" value="' + _plEsc(_plCrewLabel(k)) + '" placeholder="' + _plEsc(PL_CREW_LABEL_DEFAULT[k]) + '" maxlength="24" style="' + inputCss + '">' +
    '</div>';
  }
  var flightRows = PL_FLIGHT_KEYS.map(_lblRow).join('');
  // V2.3：客艙 20 槽的標籤改名收進巢狀折疊，避免一長串塞爆設定區。
  var cabinRows = '<details style="margin-top:4px"><summary style="font-size:.66em;color:var(--muted);cursor:pointer;padding:4px 2px">🧑‍✈️ 客艙組員標籤 / Cabin labels（cabin1..20）</summary>' +
    '<div style="padding-top:4px">' + PL_CABIN_KEYS.map(_lblRow).join('') + '</div></details>';
  var btnCss = 'border:0;border-radius:6px;padding:6px 12px;font-size:.75em;font-weight:700;cursor:pointer';
  return '<details style="margin-bottom:10px;background:var(--card);border-radius:8px;padding:8px 10px">' +
    '<summary style="font-size:.72em;font-weight:700;color:var(--muted);cursor:pointer">⚙ 欄位名稱 / Crew field labels</summary>' +
    '<div style="font-size:.62em;color:var(--muted);margin:6px 0 8px">改成你公司的稱呼（JX=CIC、EVA=CP…），套用到航班編輯器的 crew 欄位、跨裝置同步。<br>Rename to your airline\'s terms; applies to the flight editor, synced across devices.</div>' +
    flightRows + cabinRows +
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
// V2.3：列表組員顯示模式設定（cic_only / flight / all）。航班列表第 4 行的組員要顯示到哪一層。
function _plCrewDisplayModeEditor() {
  var cur = _plGetCrewDisplayMode();
  var opts = [
    { v: 'cic_only', t: '只機長 PIC only' },
    { v: 'flight', t: '飛航組 Flight crew' },
    { v: 'all', t: '全部含客艙 All incl. cabin' },
  ];
  var sel = opts.map(function(o) {
    return '<option value="' + o.v + '"' + (o.v === cur ? ' selected' : '') + '>' + o.t + '</option>';
  }).join('');
  return '<details style="margin-bottom:10px;background:var(--card);border-radius:8px;padding:8px 10px">' +
    '<summary style="font-size:.72em;font-weight:700;color:var(--muted);cursor:pointer">👁 列表組員顯示 / Crew shown in list</summary>' +
    '<div style="font-size:.62em;color:var(--muted);margin:6px 0 8px">航班列表每筆第 4 行要列到哪些組員（編輯器與 CSV 匯出不受影響、一律完整）。<br>How many crew to show on each flight row (the editor & CSV export always keep everyone).</div>' +
    '<select id="pl-crew-dispmode" onchange="_plSaveCrewDisplayMode(this.value)" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:7px 8px;font-size:.8em;box-sizing:border-box">' +
    sel + '</select>' +
  '</details>';
}
async function _plSaveCrewDisplayMode(mode) {
  if (['cic_only', 'flight', 'all'].indexOf(mode) < 0) return;
  var prev = _pl.crewDisplayMode;   // V2.3（codex P2）：server 存失敗要還原，避免本機跟雲端分叉。
  _pl.crewDisplayMode = mode;
  try { localStorage.setItem('pilotlog_crew_display_mode', mode); } catch (e) {}
  try { if (_pl.tab === 'logbook' && !_pl.editing && document.getElementById('pl-list')) _plRenderList(); } catch (e) {}   // 在 logbook 才即時重畫
  function _revert() {
    _pl.crewDisplayMode = prev;
    try { localStorage.setItem('pilotlog_crew_display_mode', prev || 'flight'); } catch (e) {}
    try { if (_pl.tab === 'logbook' && !_pl.editing && document.getElementById('pl-list')) _plRenderList(); } catch (e) {}
    var sel = document.getElementById('pl-crew-dispmode'); if (sel) sel.value = prev || 'flight';
  }
  try {
    var r = await _plApi('/api/pilot-log/crew-display-mode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { mode: mode },
    });
    if (!r.ok) { _revert(); _plToast('顯示設定儲存失敗、已還原 / Save failed (reverted) ' + r.status, 'error'); return; }
    _plToast('顯示設定已儲存');
  } catch (e) {
    _revert();
    _plToast('顯示設定儲存失敗、已還原：' + (e && e.message ? e.message : 'unknown'), 'error');
  }
}
// V2.3：把編輯器重畫到正確容器（iPad 右明細面板 / 全螢幕）—— 跟 _plOpenEditor 同邏輯。
function _plRerenderEditor() {
  if (_plWide() && document.getElementById('pl-detail-pane')) _plRenderEditor('pl-detail-pane');
  else _plRenderEditor();
}
// V2.3：LogTen 式「Configure Fields」開關。關 → 先存欄位名稱；開 → 進可編輯狀態。
function _plToggleConfigFields() {
  if (_pl.configFields) { _plSaveFieldLabels(); }       // 退出 = 儲存（async 內會重畫）
  else { _pl.configFields = true; _pl._drEdit = null; _plRerenderEditor(); }   // 進設定：規則暫存重建（吃最新值）
}
async function _plSaveFieldLabels() {
  // V2.3.07：✓ Done 同時存「報到時間規則」（獨立 endpoint；失敗回滾本機值，不擋欄位名稱儲存）
  var dutyRules = _plDrCollect();
  var prevRules = _pl.dutyRules;   // codex P2：存失敗要還原，否則本機用沒存進 server 的規則自動帶，跨裝置不一致
  _pl.dutyRules = dutyRules;       // 樂觀更新；空陣列 = 使用者刻意全刪 = 關閉自動帶（不彈回預設）
  try { localStorage.setItem('pilotlog_duty_rules', JSON.stringify(_pl.dutyRules)); } catch (e) {}
  _pl._drEdit = null;
  var _revertRules = function(msg) {
    _pl.dutyRules = prevRules;
    try { localStorage.setItem('pilotlog_duty_rules', JSON.stringify(prevRules || null)); } catch (e) {}
    _plToast(msg, 'error');
  };
  // codex P2：await 到完成才往下 —— fire-and-forget 在使用者立刻關頁時會被瀏覽器取消、規則悄悄沒存到
  try {
    var drRes = await _plApi('/api/pilot-log/duty-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { rules: dutyRules },
    });
    if (!drRes.ok) _revertRules('報到規則儲存失敗、已還原 ' + drRes.status);
  } catch (e) { _revertRules('報到規則儲存失敗、已還原（離線？）'); }
  // 從畫面所有 pl-fl-* 收集；以現有 fieldLabels 為底合併（沒渲染到的欄位標籤保留、不掉）。空字串 → 還原預設。
  var body = {};
  var prev = _pl.fieldLabels;   // V2.3（codex P2）：server 存失敗要還原，避免本機顯示成已存、跨裝置卻沒有。
  var existing = _pl.fieldLabels || {};
  Object.keys(existing).forEach(function(k) { if (typeof existing[k] === 'string' && existing[k].trim()) body[k] = existing[k]; });
  var inputs = document.querySelectorAll('[id^="pl-fl-"]');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    var key = el.id.slice(6);   // 去掉 'pl-fl-'
    if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
    var v = (el.value || '').trim().slice(0, 24);
    if (v) body[key] = v; else delete body[key];
  }
  // 樂觀更新：先收 config 模式 + 套上新名字，立刻看到效果；server 回來再用正規版覆蓋。
  _pl.fieldLabels = body;
  try { localStorage.setItem('pilotlog_field_labels', JSON.stringify(body)); } catch (e) {}
  _pl.configFields = false;
  _plRerenderEditor();
  function _revert() {
    _pl.fieldLabels = prev;
    try { localStorage.setItem('pilotlog_field_labels', JSON.stringify(prev || {})); } catch (e) {}
    _plRerenderEditor();   // 重畫成舊標籤（已退出 config 模式）
  }
  try {
    var r = await _plApi('/api/pilot-log/field-labels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
    });
    if (!r.ok) { _revert(); _plToast('儲存失敗、已還原 / Save failed (reverted) ' + r.status, 'error'); return; }
    var j = await r.json();
    _pl.fieldLabels = (j && j.field_labels) || {};
    try { localStorage.setItem('pilotlog_field_labels', JSON.stringify(_pl.fieldLabels)); } catch (e) {}
    _plToast('Field labels saved');
  } catch (e) {
    _revert();
    _plToast('儲存失敗、已還原 / Save failed (reverted): ' + (e && e.message ? e.message : 'unknown'), 'error');
  }
}
// crew.X 是 JSONB 巢狀欄位，用專屬 input id ple-crew-X（名字）/ ple-crewrank-X（rank）/ ple-crewid-X（員編 hidden），跟 _plSaveEntry 讀法對齊
function _plCrewField(key, e) {
  var val = _plCrewVal(e.crew && e.crew[key]);
  var label = _plCrewLabel(key);
  // V1.3.14：有員編且通訊錄查得到 → 編輯器也顯示通訊錄名（跟列表一致）。name0 同步設成顯示名，
  // 這樣「沒被改過 → 沿用舊員編」的判斷仍成立（name === name0），不會弄丟 eid 連結。
  var dispName = _plCrewDisplayName(val);
  var inputCss = 'background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 8px;font-size:.78em';
  // V2.2.02：✏️ 一律「佔位」—— 沒名字時用 visibility:hidden（不是 display:none），
  // 否則名字格 flex:1 會膨脹，造成空列名字格比較大、rank 被擠掉、六列寬度不一致（畫面很怪）。
  var editBtn = '<button type="button" id="ple-crewedit-' + key + '" onclick="_plQuickEditCrewSlot(\'' + key + '\')" title="編輯 / 新增此聯絡人 Edit / add contact" style="flex:0 0 auto;background:transparent;border:1px solid var(--border,#334155);border-radius:6px;color:var(--text);font-size:.85em;padding:0 7px;cursor:pointer;visibility:' + (dispName ? 'visible' : 'hidden') + '">✏️</button>';
  var hidden = '<input type="hidden" id="ple-crewid-' + key + '" value="' + _plEsc(val.eid) + '">' +
    '<input type="hidden" id="ple-crewname0-' + key + '" value="' + _plEsc(dispName) + '">';   // 原始名字：判斷名字有沒有被改過，改過就不沿用舊員編
  // V2.1.09：iPad（寬螢幕）維持原本 label-above 緊湊版（搭配 2-per-row，不動）。
  if (_plWide()) {
    return '<div style="margin-bottom:8px">' +
      '<div style="font-size:.62em;color:var(--muted);margin-bottom:2px">' + _plEsc(label) + '</div>' +
      '<div style="display:flex;gap:4px">' +
        '<div style="flex:1;min-width:0;position:relative">' +
          '<input id="ple-crew-' + key + '" autocomplete="off" placeholder="name" oninput="_plCrewSlotInput(\'' + key + '\');_plCrewDD(\'' + key + '\')" onfocus="_plCrewDD(\'' + key + '\')" onblur="_plCrewDDClose(\'' + key + '\')" style="width:100%;box-sizing:border-box;' + inputCss + '" value="' + _plEsc(dispName) + '">' +
          '<div id="ple-crewdd-' + key + '" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:60;max-height:190px;overflow-y:auto;background:var(--card,#0f172a);border:1px solid var(--border,#334155);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45)"></div>' +
        '</div>' +
        '<input id="ple-crewrank-' + key + '" placeholder="rank" style="flex:0 0 auto;width:54px;text-transform:uppercase;' + inputCss + '" value="' + _plEsc(val.rank) + '">' +
        editBtn +
      '</div>' + hidden + '</div>';
  }
  // 手機：LogTen 式 —— 標籤靠左、名字吃滿整列（一列一個），長名不再被截斷。職級與 ✏️ 收右邊。
  // V2.2.02：label 欄 64→46px（左邊不再留空、把空間還給名字），rank 50→52px（"RANK"/職級顯示得完整）。
  return '<div style="display:flex;align-items:center;gap:5px;margin-bottom:6px">' +
    '<div style="flex:0 0 46px;font-size:.62em;color:var(--muted);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + _plEsc(label) + '">' + _plEsc(label) + '</div>' +
    '<div style="flex:1;min-width:0;position:relative">' +
      '<input id="ple-crew-' + key + '" autocomplete="off" placeholder="name" oninput="_plCrewSlotInput(\'' + key + '\');_plCrewDD(\'' + key + '\')" onfocus="_plCrewDD(\'' + key + '\')" onblur="_plCrewDDClose(\'' + key + '\')" style="width:100%;box-sizing:border-box;' + inputCss + '" value="' + _plEsc(dispName) + '">' +
      '<div id="ple-crewdd-' + key + '" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:60;max-height:190px;overflow-y:auto;background:var(--card,#0f172a);border:1px solid var(--border,#334155);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45)"></div>' +
    '</div>' +
    '<input id="ple-crewrank-' + key + '" placeholder="rank" style="flex:0 0 auto;width:52px;text-transform:uppercase;' + inputCss + '" value="' + _plEsc(val.rank) + '">' +
    editBtn + hidden + '</div>';
}

// V2.3：航班編輯器的整組 crew 欄位 —— 核心飛航組常駐，Relief/Observer2 與「客艙組員（cabin1..20）」各自收合，
// 有值才預設展開。所有槽位一律渲染（即使收合）→ 存檔時 _plSaveEntry 讀得到、不會掉資料。
function _plCrewFields(e) {
  var crew = (e && e.crew) || {};
  function has(k) { return !!_plCrewVal(crew[k]).name; }
  // 核心飛航組（沿用既有 6 格版面：iPad 2-per-row、手機一列一個）—— 不動原設計。
  var core = _plWide()
    ? _plFieldRow(2, _plCrewField('pic', e) + _plCrewField('crew2', e)) +
      _plFieldRow(2, _plCrewField('crew3', e) + _plCrewField('crew4', e)) +
      _plFieldRow(2, _plCrewField('cic', e) + _plCrewField('obs', e))
    : _plCrewField('pic', e) + _plCrewField('crew2', e) +
      _plCrewField('crew3', e) + _plCrewField('crew4', e) +
      _plCrewField('cic', e) + _plCrewField('obs', e);
  var sumCss = 'font-size:.66em;font-weight:700;color:var(--muted);cursor:pointer;padding:5px 2px';
  // V2.3.04：收合區排版比照核心組（iPad 一行兩格、手機一列一個）—— 原本不分裝置一人一行，
  // 20 格客艙在 iPad 拉超長（user 實測抱怨）。
  function rows(keys) {
    if (!_plWide()) return keys.map(function(k) { return _plCrewField(k, e); }).join('');
    var out = '';
    for (var i = 0; i < keys.length; i += 2) {
      out += _plFieldRow(2, _plCrewField(keys[i], e) + (keys[i + 1] ? _plCrewField(keys[i + 1], e) : ''));
    }
    return out;
  }
  // 只收合「多出來的」：Relief 3/4 + Observer 2（有人才自動展開）
  var moreKeys = ['crew5', 'crew6', 'obs2'];
  var moreOpen = moreKeys.some(has);
  var more = '<details style="margin-top:6px"' + (moreOpen ? ' open' : '') + '>' +
    '<summary style="' + sumCss + '">＋ 更多飛航組員 / More flight crew</summary>' +
    '<div style="padding-top:4px">' + rows(moreKeys) + '</div></details>';
  // 客艙組員 cabin1..20 —— V2.3.05：永遠預設收合（匯入帶滿名單後「有人就展開」變成每班都展開，user 反映很煩）
  var cabin = '<details style="margin-top:4px">' +
    '<summary style="' + sumCss + '">🧑‍✈️ 客艙組員 / Cabin crew（最多 20）</summary>' +
    '<div style="padding-top:4px">' + rows(PL_CABIN_KEYS) + '</div></details>';
  return core + more + cabin;
}

// V1.3.24：crew 格有字才顯示 ✏️（手填即現、清空即藏）—— 對應 _plCrewField 的 oninput
function _plCrewSlotInput(key) {
  var nameEl = document.getElementById('ple-crew-' + key);
  var btn = document.getElementById('ple-crewedit-' + key);
  if (btn) btn.style.visibility = (nameEl && (nameEl.value || '').trim()) ? 'visible' : 'hidden';   // V2.2.02：佔位不變，只切可見
}
// V2.4.04：組員名字自訂下拉（取代 iPhone 難用的原生 datalist）—— 打字即時篩通訊錄、點一下就帶名字+員編。
//   候選 = _pl.crew（通訊錄聯絡人），名字「包含」即篩；上限 50 筆避免一次塞滿（通訊錄可達數千）。
function _plCrewDD(key) {
  var inp = document.getElementById('ple-crew-' + key);
  var dd = document.getElementById('ple-crewdd-' + key);
  if (!inp || !dd) return;
  var q = (inp.value || '').trim().toLowerCase();
  var cands = _pl.crew || [];
  var list = [];
  for (var i = 0; i < cands.length && list.length < 50; i++) {
    var nm = (cands[i].display_name || '').trim();
    if (!nm) continue;
    if (!q || nm.toLowerCase().indexOf(q) >= 0) list.push(cands[i]);
  }
  if (!list.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = list.map(function(c) {
    var nm = c.display_name || '';
    var org = c.organization ? ' <span style="color:var(--muted)">· ' + _plEsc(c.organization) + '</span>' : '';
    var eidn = (c.employee_ids && c.employee_ids.length) ? ' <span style="color:var(--muted);font-size:.85em">#' + _plEsc(c.employee_ids[0]) + '</span>' : '';
    return '<div onmousedown="event.preventDefault();_plCrewPick(\'' + key + '\',\'' + _plEsc(String(c.id)) + '\')" ' +
      'style="padding:7px 10px;cursor:pointer;font-size:.8em;border-bottom:1px solid var(--border,#1e293b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
      _plEsc(nm) + eidn + org + '</div>';
  }).join('');
  dd.style.display = 'block';
}
function _plCrewPick(key, cid) {
  var c = null, cands = _pl.crew || [];
  for (var i = 0; i < cands.length; i++) { if (String(cands[i].id) === String(cid)) { c = cands[i]; break; } }
  if (!c) return;
  var inp = document.getElementById('ple-crew-' + key);
  var idEl = document.getElementById('ple-crewid-' + key);
  var n0El = document.getElementById('ple-crewname0-' + key);
  var nm = c.display_name || '';
  var eid = (c.employee_ids && c.employee_ids.length) ? c.employee_ids[0] : '';
  if (inp) inp.value = nm;
  if (idEl) idEl.value = eid || '';     // 帶員編 → 顯示/比對都連得上（中文名）
  if (n0El) n0El.value = nm;            // 標記名字沒被改過 → 保留這個員編（_plSaveEntry 邏輯）
  var dd = document.getElementById('ple-crewdd-' + key);
  if (dd) dd.style.display = 'none';
  _plCrewSlotInput(key);
}
function _plCrewDDClose(key) {
  setTimeout(function() { var dd = document.getElementById('ple-crewdd-' + key); if (dd) dd.style.display = 'none'; }, 150);
}
// V2.4.04：從目前表單讀出 crew 物件（跟 _plSaveEntry 同邏輯）—— 給 ↩ Return 帶最新組員用。
function _plReadFormCrew() {
  var crew = {};
  var prevCrew = (_pl.editing && _pl.editing.crew) || {};
  Object.keys(prevCrew).forEach(function(k) {   // 保留未被新 UI 渲染的舊 key（不掉資料）
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
    var eid = _plResolveEid(name);
    if (!eid && name0El && name === name0El.value.trim() && idEl) eid = idEl.value.trim();
    var slot = { name: name };
    if (rank) slot.rank = rank;
    if (eid) slot.eid = eid;
    crew[k] = slot;
  });
  return crew;
}
// V2.4.04：對調兩個 input 的值
function _plSwapVals(idA, idB) {
  var a = document.getElementById(idA), b = document.getElementById(idB);
  if (a && b) { var t = a.value; a.value = b.value; b.value = t; }
}
// V2.4.04：把 UTC ISO 換算成某時區的「當地日期」YYYY-MM-DD（回程日用 —— 跨午夜要看當地，不是 UTC，codex P1）
function _plLocalDate(utcIso, tz) {
  try {
    var d = new Date(utcIso);
    if (isNaN(d.getTime()) || !tz) return '';
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : '';
  } catch (e) { return ''; }
}
// V2.4.04：找 SIC（副駕駛）槽 —— 駕駛艙非 PIC 的槽裡，rank 像副駕駛(SFO/FO/SIC)的那格；找不到(如兩位都機長)→ 第二位 crew2（codex P2：別假設 crew2 一定是 SIC）
function _plSicSlotKey() {
  var keys = ['crew2', 'crew3', 'crew4', 'crew5', 'crew6'];
  for (var i = 0; i < keys.length; i++) {
    var r = ((document.getElementById('ple-crewrank-' + keys[i]) || {}).value || '').toUpperCase();
    if (/SFO|FO|FIRST OFFICER|SIC/.test(r)) return keys[i];
  }
  return 'crew2';
}
// V2.4.04：⇄ Swap PIC/SIC —— 兩位機長一去一回輪替 PIC 用。對調本人 position + pic↔SIC(crew2) 名字/員編/rank + PIC↔SIC 時數；PF 不動。
function _plSwapPicSic() {
  // 只適用 PIC↔SIC 輪替（兩位機長一去一回）。FO/SFO/OBSERVER 不是這情境 → 不動，避免把 FO/SFO 誤改成 PIC（codex P2）。
  var posEl = document.getElementById('ple-position');
  var p = posEl ? posEl.value : '';
  if (p !== 'PIC' && p !== 'SIC') { if (typeof _plToast === 'function') _plToast('⇄ 只適用 PIC/SIC 輪替'); return; }
  // pic 槽 ↔ SIC 槽（用 rank 找真正的副駕駛，不假設 crew2）：名字/員編/rank/原始名
  var sk = _plSicSlotKey();
  _plSwapVals('ple-crew-pic', 'ple-crew-' + sk);
  _plSwapVals('ple-crewid-pic', 'ple-crewid-' + sk);
  _plSwapVals('ple-crewrank-pic', 'ple-crewrank-' + sk);
  _plSwapVals('ple-crewname0-pic', 'ple-crewname0-' + sk);
  // 本人 position：PIC↔SIC —— 直接設值「不」dispatch change（否則 logten/wader 的 change handler 會清 manual 並重算 role，把下面對調的時數蓋掉，codex P2）
  if (posEl) posEl.value = (p === 'PIC') ? 'SIC' : 'PIC';
  // PIC↔SIC 時數對調 + 標 manual（之後 block 變動也不被自動重算蓋掉）
  var picM = document.getElementById('ple-pic_minutes'), sicM = document.getElementById('ple-sic_minutes');
  if (picM && sicM) { var t = picM.value; picM.value = sicM.value; sicM.value = t; picM.dataset.manual = '1'; sicM.dataset.manual = '1'; }
  _plCrewSlotInput('pic'); _plCrewSlotInput(sk);
  if (typeof _plToast === 'function') _plToast('⇄ 已對調 PIC/SIC');
}
// V2.4.04：↩ Return —— 從已存的去程一鍵建回程草稿：出發↔目的對調、組員/機型/機尾/operating_crew 複製、
//   日期=去程落地日（跨午夜自動隔天）；航班號+所有時間留空你填。PIC/SIC 不自動換（要輪替按 ⇄ Swap）。
function _plMakeReturn() {
  var e = _pl.editing;
  if (!e || !e.id) return;
  var r = _plBlankEntry();
  // 一律用「目前表單」的最新值（不是上次存的）→ 去程未存的修改(航線/組員/機尾/時間)也帶得到（codex P2）
  var fOrigin = (_plGetVal('ple-origin') || '').toUpperCase();
  var fDest = (_plGetVal('ple-dest') || '').toUpperCase();
  var fOut = _plReadField('out_utc', 'time-utc') || _plReadField('std_utc', 'time-utc');
  var arrIso = _plReadField('in_utc', 'time-utc') || _plReadField('sta_utc', 'time-utc');
  if (arrIso && fOut && Date.parse(arrIso) < Date.parse(fOut)) arrIso = new Date(Date.parse(arrIso) + 86400000).toISOString();   // 落地早於起飛 → 跨午夜 +1 天
  var ad = '';
  if (arrIso) {
    var info = (typeof _plAptInfo === 'function') ? _plAptInfo(fDest || '') : null;
    if (info && info.tz) ad = _plLocalDate(arrIso, info.tz);   // 取「目的地當地日期」（跨午夜看當地、不是 UTC，codex P1）
    if (!ad) ad = String(arrIso).slice(0, 10);                 // 查無時區 → 退 UTC 日
  }
  r.flight_date = /^\d{4}-\d{2}-\d{2}$/.test(ad) ? ad : ((_plGetVal('ple-flight_date') || '').slice(0, 10) || r.flight_date);
  r.origin = fDest || '';                            // 對調
  r.dest = fOrigin || '';
  r.aircraft_type = _plGetVal('ple-aircraft_type') || '';
  r.tail_no = _plGetVal('ple-tail_no') || '';
  r.position = _plGetVal('ple-position') || 'PIC';
  var ocv = parseInt(_plGetVal('ple-operating_crew'), 10);
  r.operating_crew = (ocv >= 2 && ocv <= 4) ? ocv : null;
  r.crew = _plReadFormCrew();                        // 從表單讀組員（turnaround 大多同一批）
  // 其餘（flight_no / 所有時間 / 時數 / 起降…）留空白由 _plBlankEntry 提供
  _pl.editing = r;
  _pl.selectedId = null;
  if (_plWide() && document.getElementById('pl-detail-pane')) { _plRenderEditor('pl-detail-pane'); _plRenderList(); }
  else { _plRenderEditor(); if (typeof _plRenderYearIndex === 'function') _plRenderYearIndex(); }
  if (typeof _plToast === 'function') _plToast('↩ 已建回程草稿，填航班號與時間即可');
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

// V1.3.20：IATA↔ICAO 對照（涵蓋 _PL_APT 機場）。班表帶 IATA、LogTen 帶 ICAO → 統一查座標 + 顯示自選格式。
var _PL_IATA2ICAO = {
  TPE: 'RCTP', TSA: 'RCSS', KHH: 'RCKH', RMQ: 'RCMQ', KNH: 'RCBS',
  NRT: 'RJAA', KIX: 'RJBB', CTS: 'RJCC', SDJ: 'RJSS', FUK: 'RJFF', NGO: 'RJGG', KIJ: 'RJSN', AKJ: 'RJEC', AOJ: 'RJSA', HKD: 'RJCH', KMQ: 'RJNK', OKA: 'ROAH',
  ICN: 'RKSI', GMP: 'RKSS', HKG: 'VHHH', MFM: 'VMMC',
  PEK: 'ZBAA', HET: 'ZBHH', SJW: 'ZBSJ', TSN: 'ZBTJ', TYN: 'ZBYN', CAN: 'ZGGG', CSX: 'ZGHA', KWL: 'ZGKL', SZX: 'ZGSZ', CGO: 'ZHCC', XIY: 'ZLXY', KMG: 'ZPPP', XMN: 'ZSAM', HGH: 'ZSHC', TNA: 'ZSJN', NGB: 'ZSNB', NKG: 'ZSNJ', PVG: 'ZSPD', TAO: 'ZSQD', WUX: 'ZSWX', YNT: 'ZSYN', HYN: 'ZSTX', CTU: 'ZUUU', CKG: 'ZUCK', HRB: 'ZYHB',
  BKK: 'VTBS', PNH: 'VDPP', SGN: 'VVTS', HAN: 'VVNB', KUL: 'WMKK', PEN: 'WMKP', CGK: 'WIII', SUB: 'WARR', SIN: 'WSSS', MNL: 'RPLL', CEB: 'RPVM',
  ATL: 'KATL', DFW: 'KDFW', EWR: 'KEWR', IAH: 'KIAH', JFK: 'KJFK', LAX: 'KLAX', ONT: 'KONT', ORD: 'KORD', PHX: 'KPHX', SEA: 'KSEA', SFO: 'KSFO', ANC: 'PANC',
  YYZ: 'CYYZ', YVR: 'CYVR', LHR: 'EGLL', CDG: 'LFPG', AMS: 'EHAM', VIE: 'LOWW', BNE: 'YBBN',
};
var _PL_ICAO2IATA = (function() { var m = {}; for (var k in _PL_IATA2ICAO) m[_PL_IATA2ICAO[k]] = k; return m; })();

// ── 全域機場資料庫（懶載入 ~4176 個機場；給 Places / From-To 名稱 / 全機場座標 & 碼換算） ──
var _plAirportsP = null;
function _plLoadAirports() {
  if (window._PL_AIRPORTS) return Promise.resolve(window._PL_AIRPORTS);
  if (_plAirportsP) return _plAirportsP;
  _plAirportsP = new Promise(function(res) {
    var s = document.createElement('script');
    s.src = '/pilot-log/airport-db.js?v=' + (window._PL_VER || '1'); s.async = true;   // V1.3.38：版本化網址，版本一變強制重抓（解 7 天快取卡舊資料）
    s.onload = function() { _PL_GAPT_IDX = null; res(window._PL_AIRPORTS || []); };
    s.onerror = function() { _plAirportsP = null; res([]); };   // 失敗可重試
    (document.head || document.documentElement).appendChild(s);
  });
  return _plAirportsP;
}
var _PL_GAPT_IDX = null;   // code(ICAO|IATA) → [icao,iata,name,city,cc,lat,lon]
function _plGAptIdx() {
  if (_PL_GAPT_IDX) return _PL_GAPT_IDX;
  var m = {}, arr = window._PL_AIRPORTS || [];
  for (var i = 0; i < arr.length; i++) {
    var a = arr[i];
    if (a[0] && !m[a[0]]) m[a[0]] = a;   // ICAO
    if (a[1] && !m[a[1]]) m[a[1]] = a;   // IATA
  }
  _PL_GAPT_IDX = m; return m;
}
// 機場詳情（名稱/城市/國家/座標）—— 需先 _plLoadAirports() 載入，否則回 null
function _plAptInfo(code) {
  var c = String(code == null ? '' : code).toUpperCase().trim();
  if (!c || !window._PL_AIRPORTS) return null;
  var idx = _plGAptIdx();
  var a = idx[c] || (_PL_IATA2ICAO[c] && idx[_PL_IATA2ICAO[c]]);
  if (!a) return null;
  return { icao: a[0], iata: a[1], name: a[2], city: a[3], cc: a[4], lat: a[5], lon: a[6],
           tz: a[7] || '', elev: a[8], region: a[9] || '', runways: a[10] || [], mvar: a[11] };
}
// 機場顯示名稱（「City Name」風格，查無回空字串）
function _plAptName(code) {
  var i = _plAptInfo(code);
  if (!i) return '';
  if (i.city && i.name && i.name.indexOf(i.city) < 0) return i.city + ' · ' + i.name;
  return i.name || i.city || '';
}
// V2.0.03：機場衛星地圖網址（Esri World Imagery 靜態圖）。詳情顯示 + 離線預快取共用同一個 URL
// V2.0.04：縮小範圍（約 5×7km）讓跑道放大、座向看得清楚（飛行員在乎跑道方向）；解析度提高到 640×440
// 衛星圖視野：以「涵蓋所有跑道」為主——算跑道端點範圍 → 置中 + 30% 邊距。
// ⚠️ bbox 的經緯度長寬比必須精確 = 圖檔 640:440，否則 Esri export 會自動微調 bbox 來配合圖檔比例
// （ArcGIS 預設行為），導致跑道 overlay 對不準衛星圖（中高緯特別明顯）。所以這裡用純度數比例、不做 cos 補償。
// 回傳 {lat, lon, halfLat, halfLon}；無跑道座標時退回機場座標 + 固定視野。
function _plAptView(info) {
  var ASPECT = 640 / 440;
  var la = [], lo = [];
  (info.runways || []).forEach(function(r) {
    if (r[2] != null && r[3] != null) { la.push(r[2]); lo.push(r[3]); }
    if (r[4] != null && r[5] != null) { la.push(r[4]); lo.push(r[5]); }
  });
  var cLat = info.lat, cLon = info.lon, halfLat;
  if (la.length) {
    var laMin = Math.min.apply(null, la), laMax = Math.max.apply(null, la);
    var loMin = Math.min.apply(null, lo), loMax = Math.max.apply(null, lo);
    cLat = (laMin + laMax) / 2; cLon = (loMin + loMax) / 2;
    var needLat = (laMax - laMin) / 2, needLon = (loMax - loMin) / 2;
    halfLat = Math.max(needLat, needLon / ASPECT) * 1.3;   // 取較大的一軸 + 30% 邊距，跑道不貼邊
    halfLat = Math.max(halfLat, 0.006);                    // 最小視野，單跑道小機場別放太大
  } else {
    halfLat = 0.022;
  }
  return { lat: cLat, lon: cLon, halfLat: halfLat, halfLon: halfLat * ASPECT };
}
function _plAptMapUrl(lat, lon, halfLat, halfLon) {
  var dLat = halfLat || 0.022, dLon = halfLon || 0.032;
  var bbox = (lon - dLon) + ',' + (lat - dLat) + ',' + (lon + dLon) + ',' + (lat + dLat);
  return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=' + bbox + '&bboxSR=4326&imageSR=4326&size=640,440&format=png&f=image';
}
// 衛星圖 + 跑道 overlay：依跑道兩端座標投影到 640×440 圖框，畫跑道線並標跑道號（飛行員看座向）。
// 投影 bbox 必須跟 _plAptMapUrl 用同一個 view，否則跑道線會對不準衛星圖。
// 跑道兩端座標 → 大圓方位角（落地航向用）。
function _plBearing(la1, lo1, la2, lo2) {
  var d = Math.PI / 180, p1 = la1 * d, p2 = la2 * d, dl = (lo2 - lo1) * d;
  var y = Math.sin(dl) * Math.cos(p2);
  var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// 跑道某端：落地航向 vs 風向 → 綠（風從正前方來＝逆風、適合落地）/ 橘（順風）；無風向 → 中性灰。
function _plRwyEndColor(landingHdg, windDir) {
  if (windDir == null) return '#9ca3af';
  return Math.cos((windDir - landingHdg) * Math.PI / 180) >= 0 ? '#22c55e' : '#f97316';
}
// 跑道端彩色方塊 + 跑道號（白字黑邊水平易讀）。end＝該端 px、other＝對端 px。
function _plRwyEndMark(end, other, ident, color) {
  var dx = other[0] - end[0], dy = other[1] - end[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
  var cx = end[0] + dx / len * 16, cy = end[1] + dy / len * 16, ang = Math.atan2(dy, dx) * 180 / Math.PI;
  var w = 30, h = 17;
  return '<g transform="translate(' + cx.toFixed(1) + ',' + cy.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')">' +
      '<rect x="' + (-w / 2) + '" y="' + (-h / 2) + '" width="' + w + '" height="' + h + '" rx="3" fill="' + color + '" stroke="#000" stroke-opacity="0.35"/></g>' +
    (ident ? '<text x="' + cx.toFixed(1) + '" y="' + cy.toFixed(1) + '" font-size="12" font-weight="800" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="central">' + _plEsc(ident) + '</text>' : '');
}
// 風向箭頭（左上角）：箭頭指「風吹去的方向」(dir+180)，下方標 dir°/spd kt。
function _plWindArrow(wind) {
  if (!wind || wind.dir == null) return '';
  var cx = 42, cy = 38, r = 17, to = (wind.dir + 180) % 360, a = (to - 90) * Math.PI / 180;
  var tx = cx + Math.cos(a) * r, ty = cy + Math.sin(a) * r, bx = cx - Math.cos(a) * r, by = cy - Math.sin(a) * r;
  var head = function(da) { var h = (to - 90 + da) * Math.PI / 180; return '<line x1="' + tx.toFixed(1) + '" y1="' + ty.toFixed(1) + '" x2="' + (tx + Math.cos(h) * 8).toFixed(1) + '" y2="' + (ty + Math.sin(h) * 8).toFixed(1) + '" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'; };
  return '<rect x="10" y="12" width="64" height="54" rx="6" fill="#000" fill-opacity="0.4"/>' +
    '<line x1="' + bx.toFixed(1) + '" y1="' + by.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y2="' + ty.toFixed(1) + '" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' +
    head(152) + head(-152) +
    '<text x="42" y="61" font-size="11" font-weight="700" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle">' + _plEsc(wind.dir + '°/' + (wind.spd != null ? wind.spd : '?')) + '</text>';
}
// 通用小箭頭（線 + 箭頭頭）。
function _plArrow(x1, y1, x2, y2, color, w) {
  var ang = Math.atan2(y2 - y1, x2 - x1);
  var hx = function(da) { return (x2 + Math.cos(ang + Math.PI + da) * 6).toFixed(1); };
  var hy = function(da) { return (y2 + Math.sin(ang + Math.PI + da) * 6).toFixed(1); };
  return '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + color + '" stroke-width="' + w + '" stroke-linecap="round"/>' +
    '<polyline points="' + hx(0.5) + ',' + hy(0.5) + ' ' + x2.toFixed(1) + ',' + y2.toFixed(1) + ' ' + hx(-0.5) + ',' + hy(-0.5) + '" fill="none" stroke="' + color + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"/>';
}
// 每條跑道的風分量：逆風(headwind 沿跑道指 favored 端、綠) + 側風(crosswind 垂直、橘)。
// 標在 favored(綠)端往內 26% 處、貼著跑道線 —— 平行跑道各自落在自己線上，不互相重疊、也不撞中間長寬。
function _plRwyWindComp(x1, y1, x2, y2, hdgLe, wind) {
  if (!wind || wind.dir == null || wind.spd == null || wind.spd === 0) return '';
  var wd = wind.dir, sp = wind.spd;
  var favHdg = Math.cos((wd - hdgLe) * Math.PI / 180) >= 0 ? hdgLe : (hdgLe + 180) % 360;
  var hw = Math.round(sp * Math.cos((wd - favHdg) * Math.PI / 180));     // 逆風分量(kt)
  var xwS = sp * Math.sin((wd - favHdg) * Math.PI / 180);               // 側風分量(±)
  var xw = Math.abs(Math.round(xwS));
  var fx, fy, tx, ty;
  if (favHdg === hdgLe) { fx = x1; fy = y1; tx = x2; ty = y2; } else { fx = x2; fy = y2; tx = x1; ty = y1; }
  var dx = tx - fx, dy = ty - fy, dl = Math.sqrt(dx * dx + dy * dy) || 1;
  var ux = dx / dl, uy = dy / dl;        // 往中點方向（離 favored 端）
  var nx = -uy, ny = ux, sgn = xwS >= 0 ? 1 : -1;
  var px = fx + dx * 0.26, py = fy + dy * 0.26;   // favored 端往內 26%
  // headwind：短綠箭頭沿跑道指 favored 端(-u) + 數字
  var out = _plArrow(px, py, px - ux * 10, py - uy * 10, '#4ade80', 2.5) +
    '<text x="' + (px - ux * 10 + nx * 7 * sgn).toFixed(1) + '" y="' + (py - uy * 10 + ny * 7 * sgn).toFixed(1) + '" font-size="9.5" font-weight="800" fill="#4ade80" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="central">' + hw + '</text>';
  // crosswind：短橘箭頭垂直 + 數字（偏移壓小避免伸進鄰道）
  if (xw > 0) {
    out += _plArrow(px, py, px + nx * 8 * sgn, py + ny * 8 * sgn, '#fb923c', 2.5) +
      '<text x="' + (px + nx * 16 * sgn).toFixed(1) + '" y="' + (py + ny * 16 * sgn).toFixed(1) + '" font-size="9.5" font-weight="800" fill="#fb923c" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="central">' + xw + '</text>';
  }
  return out;
}
// 跑道 overlay 內容（svg inner）：粗白跑道線 + 中間長寬 + 兩端綠橘方塊/號 + 每跑道風分量 + 角落風向箭頭。
function _plRwyOverlay(info, v, wind) {
  var W = 640, H = 440;
  var lonMin = v.lon - v.halfLon, lonMax = v.lon + v.halfLon, latMin = v.lat - v.halfLat, latMax = v.lat + v.halfLat;
  var wd = wind ? wind.dir : null, s = '';
  (info.runways || []).forEach(function(r) {
    if (r[2] == null || r[3] == null || r[4] == null || r[5] == null) return;   // 無座標的舊資料跳過
    var x1 = (r[3] - lonMin) / (lonMax - lonMin) * W, y1 = (latMax - r[2]) / (latMax - latMin) * H;
    var x2 = (r[5] - lonMin) / (lonMax - lonMin) * W, y2 = (latMax - r[4]) / (latMax - latMin) * H;
    var hdgLe = _plBearing(r[2], r[3], r[4], r[5]);   // le 端落地朝 he 方向
    s += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="#f8fafc" stroke-width="9" stroke-opacity="0.5" stroke-linecap="butt"/>';
    if (r[6]) {
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2, ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
      var dim = Math.round(r[6]) + (r[7] ? ' × ' + Math.round(r[7]) : '') + ' ft';
      s += '<g transform="translate(' + mx.toFixed(1) + ',' + my.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')"><text font-size="11" font-weight="600" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="central">' + _plEsc(dim) + '</text></g>';
    }
    s += _plRwyEndMark([x1, y1], [x2, y2], r[0], _plRwyEndColor(hdgLe, wd));
    s += _plRwyEndMark([x2, y2], [x1, y1], r[1], _plRwyEndColor((hdgLe + 180) % 360, wd));
    s += _plRwyWindComp(x1, y1, x2, y2, hdgLe, wind);
  });
  return s + _plWindArrow(wind);
}
function _plAptMapHtml(info) {
  var v = _plAptView(info), W = 640, H = 440, rwys = info.runways || [];
  var has = rwys.some(function(r) { return r[2] != null && r[4] != null; });
  // 沒端點座標的機場（畫不出跑道線）→ 底層放跑道號/長寬文字清單。底圖在時被衛星圖蓋住，
  // 離線抓不到底圖時露出來，仍看得到跑道資訊（codex P2：不要變空深色框）。
  var txtFb = '';
  if (!has && rwys.length) {
    var rows = rwys.map(function(r) {
      return (r[0] || '') + (r[1] ? '/' + r[1] : '') + (r[6] ? '　' + Math.round(r[6]) + (r[7] ? ' × ' + Math.round(r[7]) : '') + ' ft' : '');
    });
    txtFb = '<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:14px;color:#cbd5e1;font-size:.82em;line-height:1.7">' +
      '<div style="font-weight:700;color:#94a3b8;letter-spacing:.5px;font-size:.8em;margin-bottom:4px">RUNWAYS</div>' +
      rows.map(function(t) { return '<div>' + _plEsc(t) + '</div>'; }).join('') + '</div>';
  }
  // 底圖抓不到（離線、非快取機場）→ 只藏 img，保留深色底 + 跑道線 overlay（有座標）或文字清單（無座標）
  var img = '<img src="' + _plAptMapUrl(v.lat, v.lon, v.halfLat, v.halfLon) + '" alt="satellite" onerror="this.style.display=\'none\'" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block" loading="lazy">';
  var inner = has ? _plRwyOverlay(info, v, _plAptWind[info.icao] || null) : '';
  var svg = inner ? '<svg data-rwy-icao="' + _plEsc(info.icao || '') + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">' + inner + '</svg>' : '';
  return '<div class="pl-aptmap" style="position:relative;margin:10px 0;border-radius:8px;overflow:hidden;background:#0e1525;aspect-ratio:' + W + '/' + H + '">' + txtFb + img + svg + '</div>';
}
// 抓該機場即時 METAR → 解析風向/風速 → 重繪跑道綠橘端 + 風向箭頭（抓過就快取，null 也存不重抓）。
var _plAptWind = {};
function _plParseMetarWind(metar) {
  if (!metar) return null;
  var line = (metar.trim().split('\n').filter(function(l) { return l.trim() && !l.startsWith('No'); })[0]) || '';
  var m = /\b(\d{3})(\d{2,3})(?:G\d{2,3})?(KT|MPS)\b/.exec(line);
  if (!m) return null;
  var spd = parseInt(m[2], 10);
  if (m[3] === 'MPS') spd = Math.round(spd * 1.944);   // m/s → kt
  return { dir: parseInt(m[1], 10), spd: spd };
}
function _plApplyWind(icao) {
  var svgs = document.querySelectorAll('svg[data-rwy-icao="' + icao + '"]');
  if (!svgs.length) return;
  var info = _plAptInfo(icao);
  if (!info) return;
  var html = _plRwyOverlay(info, _plAptView(info), _plAptWind[icao] || null);
  for (var i = 0; i < svgs.length; i++) svgs[i].innerHTML = html;
}
function _plLoadAptWind(icao) {
  if (!icao) return;
  if (_plAptWind[icao] !== undefined) { _plApplyWind(icao); return; }   // 已抓過 → 直接套
  fetch('/api/metar?ids=' + icao + '&hours=1').then(function(r) { return r.ok ? r.text() : ''; }).then(function(t) {
    _plAptWind[icao] = _plParseMetarWind(t);
    _plApplyWind(icao);
  }).catch(function() { _plAptWind[icao] = null; });
}
// V2.0.03：背景把 37 個星宇航點的衛星圖預抓進「永久快取」（SW 攔 Esri 存 plapt-maps）→ 飛機上離線也看得到。
// 只抓一次（已快取就跳過），並請求持久化儲存避免被系統清掉。
var _plMapsPrefetched = false;
function _plPrefetchStarluxMaps() {
  if (_plMapsPrefetched || !window._PL_AIRPORTS) return;
  var go = function() {
    if (_plMapsPrefetched || !window._PL_AIRPORTS) return;
    _plMapsPrefetched = true;
    try {
      Object.keys(_PL_STARLUX_APTS).forEach(function(icao) {
        var info = _plAptInfo(icao);
        if (!info || info.lat == null || info.lon == null) return;
        var v = _plAptView(info);   // 用跟詳情頁同一個 fit-跑道視野，URL 才會一致命中快取
        try { fetch(_plAptMapUrl(v.lat, v.lon, v.halfLat, v.halfLon), { mode: 'no-cors' }); } catch (e) {}   // 觸發 SW 攔截 → 存永久快取
      });
      if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
    } catch (e) {}
  };
  // V2.0.03（codex P2）：要等 SW 真正「控制頁面」才抓，否則首次安裝時 fetch 直接走網路、不經 SW，
  // 存不進 plapt-maps → 首次離線地圖會失效。有 controller 就直接抓；沒有就等 ready / controllerchange。
  var sw = navigator.serviceWorker;
  if (!sw) { go(); return; }
  if (sw.controller) { go(); return; }
  (sw.ready || Promise.resolve()).then(function() {
    if (sw.controller) go();
    else { try { sw.addEventListener('controllerchange', go, { once: true }); } catch (e) { go(); } }
  }).catch(go);
}

// code（ICAO 或 IATA）→ 座標：先試小表，再 IATA→ICAO，最後全域庫 fallback
function _plApt(code) {
  var c = String(code == null ? '' : code).toUpperCase().trim();
  if (_PL_APT[c]) return _PL_APT[c];
  var icao = _PL_IATA2ICAO[c];
  if (icao && _PL_APT[icao]) return _PL_APT[icao];
  if (window._PL_AIRPORTS) {   // 全域庫已載入 → 任何機場都查得到座標
    var idx = _plGAptIdx(), g = idx[c] || (icao && idx[icao]);
    if (g && g[5] != null && g[6] != null) return [g[5], g[6]];
  }
  return null;
}
// 顯示格式（使用者自選 icao/iata，預設 icao）→ 把任一碼轉成選的格式；查不到就原樣
function _plAptFmt(code) {
  var c = String(code == null ? '' : code).toUpperCase().trim();
  if (!c) return c;
  var fmt = 'icao';
  try { fmt = localStorage.getItem('pilotlog_apt_fmt') || 'icao'; } catch (e) {}
  if (fmt === 'iata') {
    if (_PL_ICAO2IATA[c]) return _PL_ICAO2IATA[c];
    if (window._PL_AIRPORTS) { var gi = _plGAptIdx()[c]; if (gi && gi[1]) return gi[1]; }
    return c;
  }
  if (_PL_IATA2ICAO[c]) return _PL_IATA2ICAO[c];
  if (window._PL_AIRPORTS) { var go = _plGAptIdx()[c]; if (go && go[0]) return go[0]; }
  return c;
}
function _plAptFmtCur() { try { return localStorage.getItem('pilotlog_apt_fmt') || 'icao'; } catch (e) { return 'icao'; } }
function _plToggleAptFmt() {
  var next = _plAptFmtCur() === 'iata' ? 'icao' : 'iata';
  try { localStorage.setItem('pilotlog_apt_fmt', next); } catch (e) {}
  _plToast('機場碼顯示：' + next.toUpperCase());
  // codex P2：編輯器開著時（iPad detail pane）只重畫列表，不動編輯器 —— 否則會丟未存的編輯。
  if (_pl.editing) {
    if (document.getElementById('pl-list')) _plRenderList();
    _plSyncRouteFmt();   // 但 From/To 要跟上新格式：轉換顯示值 + 更新 label + 重建下拉（codex P2 V2.1.02）
  } else _plRenderMain();
}
// 編輯器開著時切換 IATA/ICAO → 只同步 From/To（其他欄位不動、不丟編輯）：轉碼 + 改 label + 重建星宇下拉。
function _plSyncRouteFmt() {
  var iata = _plAptFmtCur() === 'iata', tag = iata ? 'IATA' : 'ICAO';
  [['origin', 'From'], ['dest', 'To']].forEach(function(p) {
    var inp = document.getElementById('ple-' + p[0]);
    if (inp && (inp.value || '').trim()) {
      var info = _plAptInfo(inp.value.trim());
      if (info) { var c = (iata && info.iata) ? info.iata : info.icao; if (c) inp.value = c; }
    }
    var lb = document.getElementById('ple-' + p[0] + '-label');
    // V2.3（codex P3）：若使用者自訂了 From/To 名稱，尊重它（不被 IATA/ICAO 切換蓋掉）；沒自訂才用「From (ICAO)」。
    if (lb) { var cl = _plFieldLabel(p[0], ''); lb.textContent = cl ? cl : (p[1] + ' (' + tag + ')'); }
  });
  _plUpdateAptLists();
}

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

// 沿大圓取樣，算「空中段」（Off→On）夜航分鐘（float）
function _plRouteNightMinF(A, B, offD, onD) {
  var ms = onD.getTime() - offD.getTime();
  if (ms <= 0) return 0;
  var totalMin = ms / 60000;
  var steps = Math.max(6, Math.min(120, Math.round(totalMin / 5)));   // ~5 分一點，最少 6 點
  var nights = 0;
  for (var i = 0; i <= steps; i++) {
    var f = i / steps, p = _plGcInterp(A, B, f), t = new Date(offD.getTime() + f * ms);
    if (_plIsNight(p[0], p[1], t)) nights++;
  }
  return totalMin * nights / (steps + 1);
}
// 固定點（滑行時飛機停在機場）取樣夜航分鐘（float）
function _plPointNightMinF(A, startD, endD) {
  var ms = endD.getTime() - startD.getTime();
  if (ms <= 0) return 0;
  var totalMin = ms / 60000;
  var steps = Math.max(2, Math.min(60, Math.round(totalMin / 5)));
  var nights = 0;
  for (var i = 0; i <= steps; i++) {
    var t = new Date(startD.getTime() + (i / steps) * ms);
    if (_plIsNight(A[0], A[1], t)) nights++;
  }
  return totalMin * nights / (steps + 1);
}
// 空中段 night（Off→On）；保留作為缺 OOOI 時的退路。null = 無法算
function _plRouteNightMin(origin, dest, offD, onD) {
  var A = _plApt(origin), B = _plApt(dest);   // V1.3.20：IATA/ICAO 都查得到
  if (!A || !B || !offD || !onD) return null;
  return Math.round(_plRouteNightMinF(A, B, offD, onD));
}
// V1.3.22：依法規（FAA 14 CFR 1.1 / EASA FCL.050）夜航算 block（Out→In，含滑行）。
// = 起點滑行（Out→Off，停在起點）+ 空中（Off→On，沿大圓）+ 終點滑行（On→In，停在終點）的夜航和。
// 缺 Out/In 時自動退化為只算空中段。null = 連空中段都算不出（缺座標 / 缺 Off-On）。
function _plBlockNightMin(origin, dest, outD, offD, onD, inD) {
  var A = _plApt(origin), B = _plApt(dest);
  if (!A || !B || !offD || !onD) return null;       // 至少要有空中段
  var total = _plRouteNightMinF(A, B, offD, onD);
  if (outD && outD.getTime() < offD.getTime()) total += _plPointNightMinF(A, outD, offD);  // 起點滑行
  if (inD && inD.getTime() > onD.getTime())   total += _plPointNightMinF(B, onD, inD);     // 終點滑行
  return Math.round(total);
}
function _plLegDayNight(apt, dt) {
  var A = _plApt(apt); if (!A || !dt) return null;   // V1.3.20：IATA/ICAO 都查得到
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
// V1.3.22：組出 OOOI 四個 UTC Date（Out/Off/On/In），單調遞增（每段比前一個非空時間早就 +24h）。
// 中間某段空 → 該段 null，但仍以「上一個非空時間」當錨保持後續單調。
function _plEditorOOOI() {
  var dt = _plGetVal('ple-flight_date');
  if (!dt) return null;
  var raw = { out: _plGetVal('ple-out_utc'), off: _plGetVal('ple-off_utc'),
              on: _plGetVal('ple-on_utc'), inn: _plGetVal('ple-in_utc') };
  var keys = ['out', 'off', 'on', 'inn'], res = {}, prev = null;
  for (var i = 0; i < keys.length; i++) {
    var v = String(raw[keys[i]] || '').trim();
    if (!v) { res[keys[i]] = null; continue; }
    var iso = _plMakeUtcIso(dt, v);
    if (!iso) { res[keys[i]] = null; continue; }
    var d = new Date(iso);
    while (prev && d.getTime() < prev.getTime()) d = new Date(d.getTime() + 24 * 3600 * 1000);
    res[keys[i]] = d; prev = d;
  }
  return res;
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

  // V1.3.05/1.3.22：夜航分鐘 — 依法規算 block（Out→In，含滑行），缺 OOOI 退化為空中段。
  // 手動改過的不覆寫；座標 / 時間不完整 → 清掉 stale auto（codex P2）
  var q = _plEditorOOOI();
  var origin = (_plGetVal('ple-origin') || '').toUpperCase().trim();
  var dest = (_plGetVal('ple-dest') || '').toUpperCase().trim();
  var nEl = document.getElementById('ple-night_minutes');
  if (nEl && nEl.dataset.manual !== '1') {
    var nm = (q && origin && dest) ? _plBlockNightMin(origin, dest, q.out, q.off, q.on, q.inn) : null;
    if (nm != null) nEl.value = _plMinToHHMM(nm);
    else if (offRaw || onRaw || outRaw || inRaw || origin || dest) nEl.value = '';   // 不完整 / 查無座標 → 清舊值；完全空才不碰
  }
  // 路線變化時也順手讓 day/night 起降 re-evaluate（解 codex P1：先勾 PF 後填路線的情境）
  _plAutoCalcLandings();
}
// ── V2.3.04：Duty 連動 —— In → Off Duty（= In + 設定分鐘，預設 30）→ Total Duty（= Off Duty − On Duty）
// 規則：欄位「本來就有值」（存過 / 班表帶的）或「被手動改過」→ 不覆寫；
//       是這次 session 自動帶出來的（dataset.auto）→ 跟著 In / On Duty 持續更新。
// gap 分鐘數存在 field_labels 的保留 key `off_duty_gap_min`（搭既有存檔機制、跨裝置同步，公司規定不同可改）。
function _plOffDutyGapMin() {
  var v = parseInt((_pl.fieldLabels || {}).off_duty_gap_min, 10);
  return (isNaN(v) || v < 0 || v > 600) ? 30 : v;
}
// ── V2.3.07：報到時間規則（On Duty = STD − N 分，依公司×機場；apt='*' = 該公司其他站）──
// 預設帶星宇 + 長榮（user 提供）；使用者可在 ⚙ Fields 自行增刪改，存 server 跨裝置同步。
// 星宇數字出自 FOM 4.7.4 Reporting for Duty（2026-06 版，user 提供截圖）：RCTP 110 / RCMQ 90 /
// USA Territories 70（用 K* 開頭比對涵蓋美國本土）/ 其他 60。EVA RCTP 120 為 user 記憶值，可自行修。
var PL_DUTY_RULES_DEFAULT = [
  { co: 'Starlux', apt: 'RCTP', min: 110 },
  { co: 'Starlux', apt: 'RCMQ', min: 90 },
  { co: 'Starlux', apt: 'K*', min: 70 },
  { co: 'Starlux', apt: '*', min: 60 },
  { co: 'EVA Air', apt: 'RCTP', min: 120 },
  { co: 'EVA Air', apt: '*', min: 60 },
];
// 語意（codex P2 round8）：null/從未設定 → 內建預設；空陣列 [] → 使用者刻意全刪 = 關閉自動帶。
function _plDutyRules() {
  if (Array.isArray(_pl.dutyRules)) return _pl.dutyRules;
  try { var c = JSON.parse(localStorage.getItem('pilotlog_duty_rules') || 'null'); if (Array.isArray(c)) return c; } catch (e) {}
  return PL_DUTY_RULES_DEFAULT;
}
// ── 規則設定 UI（⚙ Fields 面板內）：編輯中暫存 _pl._drEdit，✓ Done 才存 server ──
// UX（user 指定）：預設「收合一行」，點開是文字清單不是一排格子 —— 按 ✏️ 那一條才變輸入格、
// 按＋才長新格。不需要設定的人不會被一堆格子嚇到。
function _plDrSync() {   // 把畫面上「編輯中列」的輸入讀回暫存（加/刪/切換前要先收，不然改一半的值會掉）
  if (!_pl._drEdit) return;
  for (var i = 0; i < _pl._drEdit.length; i++) {
    if (!_pl._drEdit[i].edit) continue;
    var co = document.getElementById('pl-dr-co-' + i), apt = document.getElementById('pl-dr-apt-' + i), mn = document.getElementById('pl-dr-min-' + i);
    if (co) _pl._drEdit[i].co = co.value.trim();
    if (apt) _pl._drEdit[i].apt = apt.value.trim().toUpperCase();
    if (mn) _pl._drEdit[i].min = mn.value.trim();
  }
}
function _plDrAdd() { _plDrSync(); _pl._drEdit.push({ co: '', apt: '', min: '', edit: true }); _plRerenderEditor(); }
function _plDrDel(i) { _plDrSync(); _pl._drEdit.splice(i, 1); _plRerenderEditor(); }
function _plDrEditRow(i) { _plDrSync(); _pl._drEdit[i].edit = true; _plRerenderEditor(); }
function _plDrCollect() {   // 暫存 → 乾淨規則陣列（丟掉沒填齊的列）
  _plDrSync();
  var out = [];
  (_pl._drEdit || []).forEach(function(r) {
    var min = parseInt(r.min, 10);
    if (r.co && r.apt && !isNaN(min) && min >= 0 && min <= 600) out.push({ co: r.co, apt: r.apt, min: min });
  });
  return out;
}
function _plDutyRulesEditHtml() {
  if (!_pl._drEdit) _pl._drEdit = _plDutyRules().map(function(r) { return { co: r.co, apt: r.apt, min: r.min, edit: false }; });
  var inCss = 'background:var(--bg,#0a0e1a);color:var(--text);border:1px solid #f59e0b;border-radius:5px;padding:3px 6px;font-size:1em';
  var rows = _pl._drEdit.map(function(r, i) {
    if (r.edit) {
      return '<div style="display:flex;gap:5px;align-items:center;margin-top:4px">' +
        '<input id="pl-dr-co-' + i + '" value="' + _plEsc(r.co) + '" placeholder="公司 Company" style="flex:1.4;min-width:0;' + inCss + '">' +
        '<input id="pl-dr-apt-' + i + '" value="' + _plEsc(r.apt) + '" placeholder="機場/*" maxlength="8" style="flex:1;min-width:0;text-transform:uppercase;' + inCss + '">' +
        '<span style="white-space:nowrap">STD −</span>' +
        '<input id="pl-dr-min-' + i + '" type="number" inputmode="numeric" min="0" max="600" value="' + _plEsc(String(r.min)) + '" style="width:52px;text-align:center;' + inCss + '">' +
        '<span>分</span>' +
        '<button onclick="_plDrDel(' + i + ')" style="background:transparent;border:0;color:#ef4444;cursor:pointer;font-size:1em;padding:2px 4px">✕</button>' +
      '</div>';
    }
    // 文字列（非編輯）：公司 · 機場 · STD−N分 ＋ ✏️/✕
    return '<div style="display:flex;gap:7px;align-items:center;margin-top:3px;padding:1px 0">' +
      '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        _plEsc(r.co) + ' · ' + _plEsc(r.apt === '*' ? '其他站 *' : r.apt) + ' · STD−' + _plEsc(String(r.min)) + '分</span>' +
      '<button onclick="_plDrEditRow(' + i + ')" title="Edit" style="background:transparent;border:0;cursor:pointer;font-size:.95em;padding:1px 3px">✏️</button>' +
      '<button onclick="_plDrDel(' + i + ')" title="Delete" style="background:transparent;border:0;color:#ef4444;cursor:pointer;font-size:1em;padding:1px 3px">✕</button>' +
    '</div>';
  }).join('');
  var btnCss = 'background:transparent;border:1px solid #f59e0b;color:#fbbf24;border-radius:5px;padding:3px 9px;font-size:1em;cursor:pointer;margin-top:6px';
  // 收合：預設閉合一行；展開狀態記在 _pl._drOpen（重畫不彈回）
  return '<details style="margin-top:8px;border-top:1px dashed #f59e0b;padding-top:6px"' + (_pl._drOpen ? ' open' : '') + ' ontoggle="_pl._drOpen=this.open">' +
    '<summary style="cursor:pointer">⏰ <b>報到時間 On Duty 自動帶</b>（STD − N 分，' + _pl._drEdit.length + ' 條規則，預設星宇 FOM）／Report-time rules</summary>' +
    '<div style="opacity:.85;margin-top:4px">機場填 <b>*</b>＝該公司其他站、<b>K*</b>＝K 開頭（全美國）；公司名要跟 Analyze「依公司」顯示的一致（Starlux／EVA Air）。</div>' +
    rows +
    '<div style="display:flex;gap:8px">' +
      '<button onclick="_plDrAdd()" style="' + btnCss + '">＋ 新增規則 Add</button>' +
      '<button onclick="_plDutyBackfill()" style="' + btnCss + '">🪄 依規則回填舊航班 Backfill…</button>' +
    '</div></details>';
}
// 回填：先 dry-run 報數字 → 使用者確認 → 真寫入（只補空白，含 Off Duty=In+gap、Total=Off−On）
async function _plDutyBackfill() {
  var rules = _plDrCollect();
  if (!rules.length) { _plToast('先把規則填齊（公司/機場/分鐘）', 'warn'); return; }
  // codex P2：gap 讀「畫面上正在編輯的值」優先（使用者改了還沒按 ✓ Done 就按回填，要用新值）
  var gapEl = document.getElementById('pl-fl-off_duty_gap_min');
  var gv = gapEl ? parseInt(gapEl.value, 10) : NaN;
  var body = { rules: rules, off_gap_min: (!isNaN(gv) && gv >= 0 && gv <= 600) ? gv : _plOffDutyGapMin() };
  try {
    var r = await _plApi('/api/pilot-log/duty-backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Object.assign({ dry_run: true }, body) });
    if (!r.ok) { _plToast('預覽失敗 ' + r.status, 'error'); return; }
    var j = await r.json();
    var n = (j.on_duty_filled || 0) + (j.off_duty_filled || 0) + (j.total_filled || 0);
    if (!n) { _plToast('沒有可回填的空白欄位 / Nothing to backfill'); return; }
    if (!confirm('將回填（只補空白、不動既有值）：\nOn Duty ' + j.on_duty_filled + ' 班、Off Duty ' + j.off_duty_filled + ' 班、Total Duty ' + j.total_filled + ' 班\n\n確定執行？')) return;
    var r2 = await _plApi('/api/pilot-log/duty-backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
    if (!r2.ok) { _plToast('回填失敗 ' + r2.status, 'error'); return; }
    var j2 = await r2.json();
    _plToast('✅ 回填完成：On ' + j2.on_duty_filled + ' / Off ' + j2.off_duty_filled + ' / Total ' + j2.total_filled);
    await _plFetchAll();
    _plRerenderEditor();
  } catch (e) { _plToast('回填失敗：' + (e && e.message ? e.message : 'unknown'), 'error'); }
}
// 機場代碼正規化（codex P2）：3 碼 IATA → ICAO（機場庫載入後才查得到，沒載到原樣比對 = 舊行為）
function _plNormApt(code) {
  var c = String(code == null ? '' : code).trim().toUpperCase();
  if (c.length === 3 && typeof _PL_AIRPORTS !== 'undefined') {
    if (!_pl._iataIdx) {
      var m = {};
      for (var i = 0; i < _PL_AIRPORTS.length; i++) { var a = _PL_AIRPORTS[i]; if (a[1] && !m[a[1]]) m[a[1]] = a[0]; }
      _pl._iataIdx = m;
    }
    if (_pl._iataIdx[c]) return _pl._iataIdx[c];
  }
  return c;
}
// 依「目前編輯器欄位」推這班的公司 + 套規則 → 提前分鐘；配不到回 null（不亂猜）
function _plOnDutyRuleMin() {
  var co = _plEntryCompany({ tail_no: _plGetVal('ple-tail_no'), flight_no: _plGetVal('ple-flight_no') });
  return _plOnDutyRuleMinForCo(co, _plGetVal('ple-origin'));
}
// V2.4.03：抽出可帶參數版 —— 給「任一航段」算報到規則分鐘（turnaround 串接要算別段、不只表單那筆）。
function _plOnDutyRuleMinForCo(co, originRaw) {
  if (!co || co === '—') return null;
  var origin = _plNormApt(originRaw);
  if (!origin) return null;
  // 優先序：機場精準 > 開頭比對（'K*' = 美國本土這類區域規則）> '*' 其他站
  var star = null, prefix = null, rules = _plDutyRules();
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (String(r.co || '').toUpperCase() !== co.toUpperCase()) continue;
    var apt = String(r.apt || '').toUpperCase();
    if (apt !== '*' && apt.slice(-1) !== '*' && _plNormApt(apt) === origin) return parseInt(r.min, 10);
    if (apt === '*') { if (star == null) star = parseInt(r.min, 10); }
    else if (apt.slice(-1) === '*' && origin.indexOf(apt.slice(0, -1)) === 0) { if (prefix == null) prefix = parseInt(r.min, 10); }
  }
  var pick = (prefix != null) ? prefix : star;
  return (pick == null || isNaN(pick)) ? null : pick;
}

// ── V2.4.03：Operating Crew + FDP Duty 上限 + Turnaround 串接 ──────────────────────
// FDP max duty 上限（分鐘），只看操作飛行員人數（CAR 07-02A）：2人14h／3人18h／4人24h。
var DT_MAX_FDP_MIN = { 2: 14 * 60, 3: 18 * 60, 4: 24 * 60 };
var PL_PILOT_OP_SLOTS = ['pic', 'crew2', 'crew3', 'crew4', 'crew5', 'crew6'];   // PIC+SIC+Relief（OBS/CIC/cabin 不算）
// 從一筆 entry 的 crew 物件即時數操作飛行員（PIC+SIC+Relief 填了幾個），夾 2~4；數不到回 null。
function _plDetectOpCrew(crewObj) {
  if (!crewObj || typeof crewObj !== 'object') return null;
  var n = 0;
  for (var i = 0; i < PL_PILOT_OP_SLOTS.length; i++) {
    var v = _plCrewVal(crewObj[PL_PILOT_OP_SLOTS[i]]);
    if (v && v.name && String(v.name).trim()) n++;
  }
  return n ? Math.max(2, Math.min(4, n)) : null;
}
// 取一筆 entry 的操作人數：優先存好的 operating_crew，否則即時偵測。DHD/SIM/本人是 OBSERVER（觀察、不操作）不算 → null。
function _plEntryOpCrew(e) {
  if (!e || e.is_deadhead || e.is_sim || e.position === 'OBSERVER') return null;
  var oc = parseInt(e.operating_crew, 10);
  if (oc >= 2 && oc <= 4) return oc;
  if (oc > 4) return 4;
  return _plDetectOpCrew(e.crew);
}
// 一筆 entry 的「報到時刻」毫秒：優先存好的 on_duty_utc，否則 STD − 規則分鐘。算不出回 NaN。
function _plEntryOnDutyMs(e) {
  if (e && e.on_duty_utc) { var t = Date.parse(e.on_duty_utc); if (!isNaN(t)) return t; }
  var std = (e && e.std_utc) ? Date.parse(e.std_utc) : NaN;
  if (isNaN(std)) return NaN;
  var rule = _plOnDutyRuleMinForCo(_plEntryCompany(e), e.origin);
  if (rule == null) return NaN;
  return std - rule * 60000;
}
// 一筆 entry 的「解除時刻」毫秒：優先存好的 off_duty_utc（尊重手動修正，codex P2），否則落地(實際 In→表定 STA)+gap。
function _plEntryOffDutyMs(e, gapMin) {
  if (e && e.off_duty_utc) { var t = Date.parse(e.off_duty_utc); if (!isNaN(t)) return t; }
  var arrRaw = (e && (e.in_utc || e.sta_utc)) || null;
  var arr = arrRaw ? Date.parse(arrRaw) : NaN;
  if (isNaN(arr)) return NaN;
  return arr + (gapMin || 0) * 60000;
}
// 把一批 entries 串成「duty 段」。規則：相鄰段「出發地==前段目的地」且「地面銜接時間 < 8h」→ 同一段。
//   用「地面時間」分（不是用 FDP 上限分）—— 過夜會有長休息(地面 10h+)自然斷開；而「同日但超時的 turnaround」
//   地面銜接仍短，會留在同一段 → 才能照常算 limit 並標紅警示（codex P1：別把超時的 turnaround 拆掉、警示就消失）。
//   時間優先實際 OOOI、退表定。DHD/SIM 不參與。回 [{legs, onMs, offMs, opCrew, limitMs, lastArrMs}]。
var PL_DUTY_MAX_GROUND_MS = 8 * 3600000;   // 段內銜接上限 8h；超過視為休息/過夜 → 斷開
function _plDutyGroups(entries) {
  var gap = _plOffDutyGapMin();
  var list = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || e.is_sim || e.is_deadhead || e.position === 'OBSERVER' || e.status === 'roster_removed') continue;   // SIM/DHD/本人觀察/已移除 不參與串接（codex P2）
    var depRaw = e.out_utc || e.std_utc;
    var dep = depRaw ? Date.parse(depRaw) : NaN;
    if (isNaN(dep)) continue;            // 無出發時間 → 無法排序/串，跳過
    list.push({ e: e, dep: dep });
  }
  list.sort(function(a, b) { return a.dep - b.dep; });
  var groups = [], cur = null;
  for (var j = 0; j < list.length; j++) {
    var e2 = list[j].e, depMs = list[j].dep;
    var offMs = _plEntryOffDutyMs(e2, gap);
    var arrRaw = e2.in_utc || e2.sta_utc;
    var arrMs = arrRaw ? Date.parse(arrRaw) : NaN;
    if (cur) {
      var prev = cur.legs[cur.legs.length - 1];
      var contiguous = e2.origin && prev.dest && _plNormApt(e2.origin) === _plNormApt(prev.dest);
      var ground = (!isNaN(depMs) && !isNaN(cur.lastArrMs)) ? (depMs - cur.lastArrMs) : NaN;   // 前段落地→本段起飛 的地面時間
      var sameDuty = contiguous && !isNaN(ground) && ground >= 0 && ground < PL_DUTY_MAX_GROUND_MS;
      if (sameDuty) {
        cur.legs.push(e2);
        if (!isNaN(offMs)) cur.offMs = offMs;
        if (!isNaN(arrMs)) cur.lastArrMs = arrMs;
        continue;
      }
    }
    cur = { legs: [e2], onMs: _plEntryOnDutyMs(e2), offMs: offMs, opCrew: _plEntryOpCrew(e2), lastArrMs: arrMs };
    cur.limitMs = (cur.opCrew && !isNaN(cur.onMs)) ? cur.onMs + DT_MAX_FDP_MIN[cur.opCrew] * 60000 : NaN;
    groups.push(cur);
  }
  return groups;
}
// 找「包含某 entry」的 duty 段（用 id 比對；entry 自己會被換成傳入的最新版）。
function _plDutyGroupForEntry(targetEntry, allEntries) {
  // 效能：只看 target 日期 ±2 天的航班（一段 duty 最多跨一個午夜）→ 別在每次按鍵都排序整本 logbook（可達數萬筆）。
  var tDate = targetEntry.flight_date ? Date.parse(String(targetEntry.flight_date).slice(0, 10) + 'T00:00:00Z') : NaN;
  var WIN = 2 * 86400000;
  var pool = isNaN(tDate) ? allEntries : allEntries.filter(function(e) {
    var d = e.flight_date ? Date.parse(String(e.flight_date).slice(0, 10) + 'T00:00:00Z') : NaN;
    return isNaN(d) || Math.abs(d - tDate) <= WIN;
  });
  var merged = [], replaced = false;
  for (var i = 0; i < pool.length; i++) {
    if (targetEntry.id && pool[i].id === targetEntry.id) { merged.push(targetEntry); replaced = true; }
    else merged.push(pool[i]);
  }
  if (!replaced) merged.push(targetEntry);
  var groups = _plDutyGroups(merged);
  for (var g = 0; g < groups.length; g++) {
    for (var k = 0; k < groups[g].legs.length; k++) {
      var L = groups[g].legs[k];
      if ((targetEntry.id && L.id === targetEntry.id) || L === targetEntry) return groups[g];
    }
  }
  return null;
}
function _plAutoCalcDuty() {
  var onEl = document.getElementById('ple-on_duty_utc');
  var offEl = document.getElementById('ple-off_duty_utc');
  var totEl = document.getElementById('ple-total_duty_minutes');
  // V2.3.07：On Duty = STD − 規則分鐘（依公司×機場；手動優先、清空恢復自動）
  var std = _plHHMMtoMin(_plGetVal('ple-std_utc'));
  if (onEl && onEl.dataset.manual !== '1' && (onEl.dataset.auto === '1' || !onEl.value.trim())) {
    var ruleMin = (std != null) ? _plOnDutyRuleMin() : null;
    if (ruleMin != null) {
      var on = ((std - ruleMin) % 1440 + 1440) % 1440;
      onEl.value = ('0' + Math.floor(on / 60)).slice(-2) + ('0' + (on % 60)).slice(-2);
      onEl.dataset.auto = '1';
    } else if (onEl.dataset.auto === '1') { onEl.value = ''; }   // STD 清掉/規則配不到 → auto 值也清
  }
  // Off Duty = In + gap
  var inn = _plHHMMtoMin(_plGetVal('ple-in_utc'));
  if (offEl && offEl.dataset.manual !== '1' && (offEl.dataset.auto === '1' || !offEl.value.trim())) {
    if (inn != null) {
      var od = (inn + _plOffDutyGapMin()) % 1440;
      offEl.value = ('0' + Math.floor(od / 60)).slice(-2) + ('0' + (od % 60)).slice(-2);
      offEl.dataset.auto = '1';
    } else if (offEl.dataset.auto === '1') { offEl.value = ''; }   // In 清掉 → auto 帶的也清，不留 stale
  }
  // Total Duty = Off Duty − On Duty（跨午夜 +24h）
  var onD = _plHHMMtoMin(_plGetVal('ple-on_duty_utc')), offD = _plHHMMtoMin(_plGetVal('ple-off_duty_utc'));
  if (totEl && totEl.dataset.manual !== '1') {
    // V2.3.05：存過「0」的也當沒資料 —— 匯入來源會把沒有 duty 時數的班存成 0（顯示 0:00），
    // duty 不可能是 0，0 被「有值不覆寫」保護住 → 永遠不會自動算（user 實測）。
    var curT = (totEl.value || '').trim();
    var curZero = /^0{1,2}:?0{0,2}$/.test(curT);
    if (totEl.dataset.auto === '1' || !curT || curZero) {
      if (onD != null && offD != null) { totEl.value = _plMinToHHMM(_plDurDiff(onD, offD)); totEl.dataset.auto = '1'; }
      else if (totEl.dataset.auto === '1') { totEl.value = ''; }
    }
  }
  _plUpdateOpCrewLimit();   // V2.4.03：操作人數自動偵測 + turnaround On/Off + FDP Limit
}
// V2.4.03：從表單駕駛艙槽即時數操作飛行員（PIC+SIC+Relief 填了幾個），夾 2~4；數不到回 null。
function _plDetectOpCrewFromForm() {
  var n = 0;
  for (var i = 0; i < PL_PILOT_OP_SLOTS.length; i++) {
    var el = document.getElementById('ple-crew-' + PL_PILOT_OP_SLOTS[i]);
    if (el && el.value.trim()) n++;
  }
  return n ? Math.max(2, Math.min(4, n)) : null;
}
// 用表單目前值組一筆 entry-like，給 turnaround 串接/limit 計算（含本人最新編輯值）。
function _plEditingSnapshotForDuty() {
  var ocv = parseInt(_plGetVal('ple-operating_crew'), 10);
  return {
    id: _pl.editing ? _pl.editing.id : null,
    flight_date: _plGetVal('ple-flight_date'),
    origin: _plGetVal('ple-origin'), dest: _plGetVal('ple-dest'),
    tail_no: _plGetVal('ple-tail_no'), flight_no: _plGetVal('ple-flight_no'),
    std_utc: _plReadField('std_utc', 'time-utc'), sta_utc: _plReadField('sta_utc', 'time-utc'),
    out_utc: _plReadField('out_utc', 'time-utc'), in_utc: _plReadField('in_utc', 'time-utc'),
    on_duty_utc: _plReadField('on_duty_utc', 'time-utc'), off_duty_utc: _plReadField('off_duty_utc', 'time-utc'),
    is_deadhead: ((document.getElementById('ple-entry-type') || {}).value || (_pl.editing ? _plEntryType(_pl.editing) : 'flight')) === 'dhd',
    is_sim: ((document.getElementById('ple-entry-type') || {}).value || (_pl.editing ? _plEntryType(_pl.editing) : 'flight')) === 'sim',
    operating_crew: (ocv >= 2 && ocv <= 4) ? ocv : null,
    crew: _plFormPilotCrew(),   // 用表單目前打的駕駛艙名字（不是上次存的）→ Auto 時即時偵測對得上（codex P2）
  };
}
// 從表單駕駛艙槽即時組出 crew 物件（只含飛航組，供 operating crew 偵測 fallback 用）。
function _plFormPilotCrew() {
  var c = {};
  for (var i = 0; i < PL_PILOT_OP_SLOTS.length; i++) {
    var k = PL_PILOT_OP_SLOTS[i];
    var el = document.getElementById('ple-crew-' + k);
    if (el && el.value.trim()) c[k] = { name: el.value.trim() };
  }
  return c;
}
// 操作人數自動偵測 → 算這筆所屬 duty 段 → FDP Limit 顯示在 Off Duty 旁。
// 註：On/Off Duty 欄位「不」覆寫成整段值 —— 每段保留自己的報到/解除（codex P2：寫進欄位後若 turnaround 被改散會殘留舊值、且 auto 旗標不持久無法乾淨還原）。
//     整段 duty 的概念由 Limit（用第一段報到+maxFDP）與 Analyze 的 Total Duty 去重（用第一段報到~最後一段解除）體現，兩者都直接讀第一/最後段、不靠欄位覆寫。
function _plUpdateOpCrewLimit() {
  var ocEl = document.getElementById('ple-operating_crew');
  var limEl = document.getElementById('ple-fdp-limit');
  var _et = (document.getElementById('ple-entry-type') || {}).value || (_pl.editing ? _plEntryType(_pl.editing) : 'flight');
  var _isObs = ((document.getElementById('ple-position') || {}).value || '') === 'OBSERVER';   // 本人是觀察員→不操作，比照 DHD/SIM 不顯示 limit（codex P2）
  var isDhd = _et === 'dhd' || _isObs;   // 編輯器用 entry-type 下拉(Flight/DHD/SIM)，沒有 is_deadhead 勾選框（codex P2）
  var isSim = _et === 'sim';
  // 1. 操作人數：DHD/SIM 一律清空（非操作、不該帶 operating_crew，否則 _plSaveEntry 會存到殘值，codex P2）。
  //    連 manual 旗標也清 → 切回一般航班時能重新自動偵測，不會卡在「manual 但空白」(codex P2)。
  if (isDhd || isSim) {
    if (ocEl) { ocEl.value = ''; delete ocEl.dataset.auto; delete ocEl.dataset.manual; }
  } else if (ocEl && ocEl.dataset.manual !== '1') {
    // 只在「目前空白」或「這次 session 自動帶的(auto)」才覆寫 → 已存的值(匯入或手動改的)開啟時保留、不被重偵測蓋掉（codex：可手動改要持久）。
    // 數不到 → 留空(不顯示 limit)。不亂猜 2，否則 4 人長程缺組員會誤判 14h 超限紅字。
    if (!ocEl.value || ocEl.dataset.auto === '1') {
      var det = _plDetectOpCrewFromForm();
      if (det != null) { ocEl.value = String(det); ocEl.dataset.auto = '1'; }
      else if (ocEl.dataset.auto === '1') ocEl.value = '';
    }
  }
  var fromEl = document.getElementById('ple-onduty-from');
  if (limEl) limEl.innerHTML = '';
  if (fromEl) fromEl.innerHTML = '';
  if (isDhd || isSim) return;
  // 2. 找這筆所屬 duty 段
  var snap = _plEditingSnapshotForDuty();
  var grp = null;
  try { grp = _plDutyGroupForEntry(snap, _pl.entries || []); } catch (e) {}
  if (!grp) return;
  // 2.5 turnaround 第二段以後：On Duty 旁標「起算自第一段航班」（duty 從哪班起算）。單段就是自己→不標。
  if (fromEl && grp.legs.length > 1) {
    var firstLeg = grp.legs[0];
    var isFirst = (snap.id && firstLeg.id === snap.id) || firstLeg === snap;
    if (!isFirst && firstLeg.flight_no) fromEl.innerHTML = 'from ' + _plEsc(firstLeg.flight_no);
  }
  // 3. FDP Limit 標籤（無操作人數→不顯示；實際落地超過→紅字）。turnaround 一律用第一段報到+第一段人數。
  if (limEl && grp.opCrew && !isNaN(grp.limitMs) && !isNaN(grp.onMs)) {
    var hrs = DT_MAX_FDP_MIN[grp.opCrew] / 60;
    var lim = _plFmtUtcHHMM(new Date(grp.limitMs).toISOString());
    var dd = Math.floor(grp.limitMs / 86400000) - Math.floor(grp.onMs / 86400000);
    var plus = dd > 0 ? '+' + dd : '';
    var lastLeg = grp.legs[grp.legs.length - 1];
    // 超限判定用「實際/已存的解除時刻」：優先存好的 off_duty_utc（手動或匯入改過的），否則實際落地 In+gap；
    //   都沒有(只有表定)→ 不標紅(計畫中不算超)。跟編輯器顯示的 off_duty 一致（codex P2）。
    var actualOff = lastLeg.off_duty_utc ? Date.parse(lastLeg.off_duty_utc)
      : (lastLeg.in_utc ? (Date.parse(lastLeg.in_utc) + _plOffDutyGapMin() * 60000) : NaN);
    var exceeded = !isNaN(actualOff) && actualOff > grp.limitMs;
    var col = exceeded ? '#ef4444' : '#22c55e';
    limEl.innerHTML = '<span style="color:' + col + '">' + (exceeded ? '🔴 ' : '🟢 ') + 'Limit ' + lim + plus + ' (' + hrs + 'h)</span>';
  }
}
// 只在「沒被手動改過」時才覆寫 PIC/SIC（dataset.manual 由 _plWireEditor 標記）— 自動帶但保留手填
function _plSetRoleField(id, val) {
  var el = document.getElementById(id);
  if (el && el.dataset.manual !== '1') el.value = val;
}
// V1.3.28：SFO / FO 都算 SIC（co-pilot 記 SIC 時數）—— position 下拉新增這兩個可選
function _plIsSicPos(p) { return p === 'SIC' || p === 'SFO' || p === 'FO'; }
function _plAutoCalcRole() {
  var pos = _plGetVal('ple-position');
  var blockStr = _plGetVal('ple-block_minutes').trim();      // 直接沿用 block 欄目前值（可能為空）
  // 角色互斥（codex P1）：目前角色 = block、另一個清空；blank / OBSERVER 兩者都清，避免雙重計算。
  // 但手動改過的欄位不覆寫（codex fast P1：自動帶之後改 OOOI 不該把手填的 PIC/SIC 蓋掉）。
  _plSetRoleField('ple-pic_minutes', pos === 'PIC' ? blockStr : '');
  _plSetRoleField('ple-sic_minutes', _plIsSicPos(pos) ? blockStr : '');
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
  var type = _plGetVal('ple-aircraft_type');
  var cur = sel.value;
  // V1.3.26：換機型 → 只清「機尾庫裡已知、但屬於別機型」的機尾（明確 mismatch，例如 B-16201 是 A321、改成 A330 就清）。
  // 機尾庫查無的機尾（匯入的歷史機尾，沒建進機尾庫）一律保留 —— 否則改機型會誤刪 valid tail（codex P2）。
  if (cur && type) {
    var _all = _pl.aircraft || [];
    var _inReg = _all.some(function(a) { return a.tail_no === cur; });
    var _match = _all.some(function(a) { return a.tail_no === cur && a.type_code === type; });
    if (_inReg && !_match) cur = '';
  }
  var opts = _plTailOptionsFor(type, cur);
  sel.innerHTML = opts.map(function(o) {
    return '<option value="' + _plEsc(o) + '"' + (o === cur ? ' selected' : '') + '>' + _plEsc(o || '—') + '</option>';
  }).join('');
}
// 每次 _plRenderEditor 重畫後重掛 input/change 監聽（DOM 換新）
// V1.3.36：POB = Crew + Pax 自動加總（唯讀顯示）
function _plPobSync() {
  var pob = document.getElementById('ple-pob_display');
  if (!pob) return;
  var cv = parseInt((document.getElementById('ple-crew_count') || {}).value, 10);
  var pv = parseInt((document.getElementById('ple-pax_count') || {}).value, 10);
  if (isNaN(cv) && isNaN(pv)) { pob.value = ''; return; }
  pob.value = (isNaN(cv) ? 0 : cv) + (isNaN(pv) ? 0 : pv);
}
// V1.3.36：From/To 機場名稱顯示（全域庫載入後才有名字）
function _plUpdateAptNames() {
  var row = document.getElementById('ple-aptname-row');
  if (!row) return;
  var o = (document.getElementById('ple-origin') || {}).value || '';
  var d = (document.getElementById('ple-dest') || {}).value || '';
  var on = _plAptName(o), dn = _plAptName(d);
  if (!on && !dn) { row.innerHTML = ''; return; }
  row.innerHTML =
    (on ? '<b>' + _plEsc(o.toUpperCase()) + '</b> ' + _plEsc(on) : '') +
    (on && dn ? '　→　' : '') +
    (dn ? '<b>' + _plEsc(d.toUpperCase()) + '</b> ' + _plEsc(dn) : '');
}
// V1.3.37：依 From/To 機場填 Dep/Arr 跑道下拉清單（資料來自全域機場庫，庫載入後才有）
function _plFillRwyList(listId, code) {
  var dl = document.getElementById(listId); if (!dl) return;
  var info = _plAptInfo(code);
  var rwys = (info && info.runways) || [];
  var idents = [];   // runways 現為 [le,he,...] tuple → 展平成跑道號清單給下拉（不可整個 tuple 塞進 option）
  rwys.forEach(function(r) { if (r[0]) idents.push(r[0]); if (r[1]) idents.push(r[1]); });
  dl.innerHTML = idents.map(function(id) { return '<option value="' + _plEsc(id) + '"></option>'; }).join('');
}
function _plUpdateRwyLists() {
  // V2.2.05 起 Dep/Arr Rwy 改用 _plRwyDropdown 自訂下拉（候選即時依當前 From/To 算），
  // 原生 datalist 已移除 → 這兩個呼叫變成 no-op（_plFillRwyList 找不到元素就早退）。保留不刪。
  _plFillRwyList('ple-dep-rwy-list', (document.getElementById('ple-origin') || {}).value || '');
  _plFillRwyList('ple-arr-rwy-list', (document.getElementById('ple-dest') || {}).value || '');
}
// From/To 下拉：列 37 個星宇定期航點（碼依當前 IATA/ICAO 格式 + 城市/機場名），可下拉選也可手打其他機場。
function _plFillAptList(listId) {
  var dl = document.getElementById(listId); if (!dl) return;
  var iata = _plAptFmtCur() === 'iata';
  var opts = Object.keys(_PL_STARLUX_APTS).map(function(icao) {
    var info = _plAptInfo(icao);
    var code = (iata && info && info.iata) ? info.iata : icao;
    return { code: code, nm: info ? (info.city || info.name || '') : '' };
  }).filter(function(o) { return o.code; }).sort(function(a, b) { return a.code.localeCompare(b.code); });
  dl.innerHTML = opts.map(function(o) { return '<option value="' + _plEsc(o.code) + '">' + _plEsc(o.nm) + '</option>'; }).join('');
}
function _plUpdateAptLists() {
  // V2.2.05 起 From/To 改用 _plAptDropdown 自訂下拉，原生 datalist 已不存在 → 這兩個呼叫變成 no-op
  // （_plFillAptList 內 getElementById 找不到就早退）。保留不刪，避免動到其他呼叫點。
  _plFillAptList('ple-origin-aptlist');
  _plFillAptList('ple-dest-aptlist');
}

// V2.2.05：自訂日期欄 —— 底層原生 <input type=date> 改值時，同步上層顯示的純數字 YYYY-MM-DD。
function _plDateSync(name) {
  var disp = document.getElementById('ple-' + name + '-disp');
  var src = document.getElementById('ple-' + name);
  if (disp && src) disp.value = src.value;
}

// V2.2.05：From/To 自訂下拉候選 = 星宇 37 航點（碼依當前 IATA/ICAO 格式 + 城市/機場名）。
function _plAptCandidates() {
  var iata = _plAptFmtCur() === 'iata';
  return Object.keys(_PL_STARLUX_APTS).map(function(icao) {
    var info = _plAptInfo(icao);
    var code = (iata && info && info.iata) ? info.iata : icao;
    return { code: code, nm: info ? (info.city || info.name || '') : '' };
  }).filter(function(o) { return o.code; }).sort(function(a, b) { return a.code.localeCompare(b.code); });
}
function _plAptDropdown(side) {
  var inp = document.getElementById('ple-' + side);
  var dd = document.getElementById('ple-' + side + '-dd');
  if (!inp || !dd) return;
  var q = (inp.value || '').trim().toUpperCase();
  var cands = _plAptCandidates();
  var list;
  if (!q) {
    list = cands;   // 空 → 全列（聚焦就看得到 37 個）
  } else {
    // 代碼「開頭」符合的排前面（打 R → RCTP/RJAA…），城市/機場名「包含」的排後面（打 Tokyo 也能篩）
    var pref = [], byName = [];
    cands.forEach(function(o) {
      if (o.code.toUpperCase().indexOf(q) === 0) pref.push(o);
      else if (o.nm && o.nm.toUpperCase().indexOf(q) >= 0) byName.push(o);
    });
    list = pref.concat(byName);
  }
  if (!list.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = list.map(function(o) {
    // onmousedown + preventDefault：在 input blur 之前選取，避免下拉先被關掉（iPhone/桌面都穩）
    return '<div onmousedown="event.preventDefault();_plAptPick(\'' + side + '\',\'' + _plEsc(o.code) + '\')" ' +
      'style="padding:7px 10px;cursor:pointer;font-size:.8em;border-bottom:1px solid var(--border,#1e293b)">' +
      '<b style="letter-spacing:.5px">' + _plEsc(o.code) + '</b>' +
      (o.nm ? ' <span style="color:var(--muted)">' + _plEsc(o.nm) + '</span>' : '') + '</div>';
  }).join('');
  dd.style.display = 'block';
}
function _plAptPick(side, code) {
  var inp = document.getElementById('ple-' + side);
  if (inp) {
    inp.value = code;
    inp.dispatchEvent(new Event('input', { bubbles: true }));   // 觸發大寫/夜航/機場名等既有連動（會順帶重開下拉）
  }
  // 連動跑完後再關 —— 上面的 input 事件會再呼叫 _plAptDropdown 重開，故必須在這之後關掉，確保選完是收合的
  var dd = document.getElementById('ple-' + side + '-dd');
  if (dd) dd.style.display = 'none';
}
function _plAptDDClose(side) {
  // 延遲關閉，讓 option 的 onmousedown 先觸發（blur 比 click 早）
  setTimeout(function() { var dd = document.getElementById('ple-' + side + '-dd'); if (dd) dd.style.display = 'none'; }, 150);
}

// V2.2.05：跑道自訂下拉（取代原生 datalist）。候選＝對應機場（origin→Dep / dest→Arr）的跑道號，
// 即時依當前 From/To 算（改了機場跑道跟著變）。name = dep_rwy / arr_rwy；side = origin / dest。
function _plRwyDropdown(name, side) {
  var inp = document.getElementById('ple-' + name);
  var dd = document.getElementById('ple-' + name + '-dd');
  if (!inp || !dd) return;
  var code = (document.getElementById('ple-' + side) || {}).value || '';
  var info = _plAptInfo(code);
  var rwys = (info && info.runways) || [];
  var idents = [];   // runways 為 [le,he,...] tuple → 展平成跑道號清單
  rwys.forEach(function(r) { if (r[0]) idents.push(r[0]); if (r[1]) idents.push(r[1]); });
  var q = (inp.value || '').trim().toUpperCase();
  var list = q ? idents.filter(function(id) { return id.toUpperCase().indexOf(q) === 0; }) : idents;
  if (!list.length) { dd.style.display = 'none'; return; }   // 查無機場/跑道 → 不擋手動輸入
  dd.innerHTML = list.map(function(id) {
    return '<div onmousedown="event.preventDefault();_plRwyPick(\'' + name + '\',\'' + _plEsc(id) + '\')" ' +
      'style="padding:7px 10px;cursor:pointer;font-size:.8em;border-bottom:1px solid var(--border,#1e293b)">' +
      '<b style="letter-spacing:.5px">' + _plEsc(id) + '</b></div>';
  }).join('');
  dd.style.display = 'block';
}
function _plRwyPick(name, ident) {
  var inp = document.getElementById('ple-' + name);
  if (inp) { inp.value = ident; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  var dd = document.getElementById('ple-' + name + '-dd');
  if (dd) dd.style.display = 'none';   // 連動跑完後再關，確保選完是收合的
}
function _plRwyDDClose(name) {
  setTimeout(function() { var dd = document.getElementById('ple-' + name + '-dd'); if (dd) dd.style.display = 'none'; }, 150);
}

function _plWireEditor() {
  _plPobSync();                                   // 初始 POB（locked 也要顯示）
  _plUpdateAptNames();
  _plUpdateRwyLists();                             // 初始跑道下拉（庫已載入時就有）
  _plUpdateAptLists();                             // From/To 星宇 37 航點下拉
  // codex P2：機場庫是非同步載入。庫到之前 _plApt() 查不到非硬編機場座標 → night/起降被算成空。
  // 庫載入後除了補機場名 + 跑道下拉，還要補算一次（只在仍是同一筆、未上鎖時；_plAutoCalcTimes 會尊重手動鎖值）。
  var _wireEntryId = _pl.editing ? _pl.editing.id : null;
  _plLoadAirports().then(function() {
    if (!_pl.editing || _pl.editing.id !== _wireEntryId) return;   // 已換/關編輯器 → 不動
    _plUpdateAptNames();
    _plUpdateRwyLists();
    _plUpdateAptLists();
    if (!_pl.editing.is_locked) { _plAutoCalcTimes(); _plAutoCalcDuty(); }   // V2.3.07：機場庫到位後 IATA→ICAO 才查得到，Duty 規則要補算一次（codex P2）
  });
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
  // V1.3.37：機場代碼欄（From/To）即時轉大寫 —— 不管打 IATA 或 ICAO、大小寫，一律大寫顯示＋存。
  ['origin', 'dest'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) el.addEventListener('input', function() {
      var p = el.selectionStart, up = el.value.toUpperCase();
      if (up !== el.value) { el.value = up; try { el.setSelectionRange(p, p); } catch (e) {} }
    });
  });
  ['out_utc', 'off_utc', 'on_utc', 'in_utc'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) el.addEventListener('input', _plAutoCalcTimes);
  });
  var pos = document.getElementById('ple-position');
  if (pos) { pos.addEventListener('change', _plAutoCalcRole); pos.addEventListener('change', _plAutoCalcDuty); }   // 切 OBSERVER → 更新 FDP Limit
  var pf = document.getElementById('ple-pilot_flying');
  if (pf) pf.addEventListener('change', _plAutoCalcLandings);
  var ty = document.getElementById('ple-aircraft_type');
  if (ty) ty.addEventListener('change', _plRefilterTails);
  // 標記 PIC/SIC/Night 是否被手動改過 → 之後就不覆寫（codex fast P1 + V1.3.05 night）
  ['pic_minutes', 'sic_minutes', 'night_minutes'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) el.addEventListener('input', function() { el.dataset.manual = '1'; });
  });
  // V2.3.04：Duty 連動 —— 來源欄位變更觸發；On/Off/Total Duty 手動輸入標 manual 停止覆寫，
  // 清空欄位則解除 manual（沒資料就恢復自動）。
  // V2.3.07：On Duty 也改自動帶（STD−規則分鐘），觸發源加 std/origin/班號/機尾（公司與機場會影響規則）。
  ['in_utc', 'std_utc', 'origin', 'flight_no', 'tail_no'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    // codex P2：tail_no 是 <select>，部分瀏覽器只發 change 不發 input → 兩個都掛（重複觸發無害、計算冪等）
    if (el) { el.addEventListener('input', _plAutoCalcDuty); el.addEventListener('change', _plAutoCalcDuty); }
  });
  ['on_duty_utc', 'off_duty_utc', 'total_duty_minutes'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) el.addEventListener('input', function() {
      if (el.value.trim()) { el.dataset.manual = '1'; delete el.dataset.auto; }
      else { delete el.dataset.manual; }
      _plAutoCalcDuty();
    });
  });
  // V2.4.03：Operating Crew 手動改 → 標 manual（清空＝恢復自動偵測）＋ 重算 limit；
  //   駕駛艙組員名字改 → 重新偵測操作人數。
  var _ocEl = document.getElementById('ple-operating_crew');
  if (_ocEl) _ocEl.addEventListener('change', function() {
    if (_ocEl.value) { _ocEl.dataset.manual = '1'; delete _ocEl.dataset.auto; }   // 手動選 → 鎖住、不再自動帶
    else { delete _ocEl.dataset.manual; delete _ocEl.dataset.auto; }              // 選回空白(Auto) → 恢復自動偵測
    _plAutoCalcDuty();
  });
  PL_PILOT_OP_SLOTS.forEach(function(k) {
    var el = document.getElementById('ple-crew-' + k);
    if (el) { el.addEventListener('input', _plAutoCalcDuty); el.addEventListener('change', _plAutoCalcDuty); }
  });
  _plAutoCalcDuty();   // 開編輯器先帶一次（已飛但 Duty 欄還空的，直接看到自動值）
  // V1.3.05：origin / dest / flight_date 變更也觸發夜航計算（不只 OOOI）
  ['origin', 'dest', 'flight_date'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) { el.addEventListener('input', _plAutoCalcTimes); el.addEventListener('input', _plRefreshSchedLocal); }
  });
  // V1.3.36：Crew/Pax 變更 → 重算 POB；origin/dest 變更 → 更新機場名稱列
  ['crew_count', 'pax_count'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) el.addEventListener('input', _plPobSync);
  });
  ['origin', 'dest'].forEach(function(n) {
    var el = document.getElementById('ple-' + n);
    if (el) { el.addEventListener('input', _plUpdateAptNames); el.addEventListener('input', _plUpdateRwyLists); }
  });
  // V1.3.23：LogTen / Wader 匯入帶來的 night / PIC / SIC 是「正本」（pilot 自己記的）→ 上鎖，
  // 標記為手動，之後就算編輯 OOOI / 航線也不會被自動重算蓋掉。Roster / manual 不鎖（要靠自動算）。
  var _src = (_pl.editing && _pl.editing.source) || '';
  if (_src === 'logten' || _src === 'wader') {
    ['night_minutes', 'pic_minutes', 'sic_minutes'].forEach(function(n) {
      var el = document.getElementById('ple-' + n);
      if (el && (el.value || '').trim()) el.dataset.manual = '1';   // 有值才鎖；空的仍可手動補
    });
    // 但若使用者「明確改 position」→ pic/sic 解鎖 + 依新角色重帶（避免 position=SIC 卻把時數還掛在 pic）。
    // night 仍維持上鎖（換 position 不該動夜航）。原 _plAutoCalcRole 監聽先觸發但被鎖擋掉，這裡解鎖後補跑一次。
    var _posEl = document.getElementById('ple-position');
    if (_posEl) _posEl.addEventListener('change', function() {
      ['pic_minutes', 'sic_minutes'].forEach(function(n) {
        var el = document.getElementById('ple-' + n); if (el) delete el.dataset.manual;
      });
      _plAutoCalcRole();
    });
  }
  // V1.3.20：開啟時自動補算 night —— 班表航班用 IATA 碼以前查不到座標、night 一直空白；
  // 現在 _plApt 兩種碼都查得到。只在 night 空 + 有 off/on 時補（避免動到已存的 block）。
  var _nEl = document.getElementById('ple-night_minutes');
  var _offV = (document.getElementById('ple-off_utc') || {}).value;
  var _onV = (document.getElementById('ple-on_utc') || {}).value;
  if (_nEl && !(_nEl.value || '').trim() && _offV && _onV) _plAutoCalcTimes();
  _plRefreshSchedLocal();   // 初次顯示已存的 Sched 時間之當地時間
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
    if (e.needs_completion) {
      statusBadge = '<span style="background:#f59e0b;color:#fff;border-radius:10px;padding:2px 8px;font-size:.62em;margin-left:8px">待補強 needs fix</span>';
    } else if (e.status === 'roster_removed') {
      statusBadge = '<span style="background:#94a3b8;color:#fff;border-radius:10px;padding:2px 8px;font-size:.62em;margin-left:8px">removed</span>';
    } else if (_plEntryIsDone(e)) {
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
      // V2.3：⚙ Configure Fields（LogTen 式）—— 平常欄位名稱鎖住，點了才進可編輯狀態改名。UI 文案用英文。
      '<button onclick="_plToggleConfigFields()" title="Configure field labels" style="background:' + (_pl.configFields ? '#f59e0b' : 'transparent') + ';color:' + (_pl.configFields ? '#fff' : 'var(--muted)') + ';border:1px solid ' + (_pl.configFields ? '#f59e0b' : 'var(--border,#334155)') + ';border-radius:6px;padding:6px 10px;font-size:.74em;cursor:pointer">' + (_pl.configFields ? '✓ Done' : '⚙ Fields') + '</button>' +
      // V1.3.08：拿掉 Confirm — Save 就是 Save。Lock 鈕（LogTen 風格）：鎖了不能改/不能刪；點一下解鎖
      (e.id && _plEntryType(e) === 'flight' ? '<button onclick="_plMakeReturn()" title="建立回程（出發地↔目的地對調、組員/機型複製，時間留空）" style="background:transparent;color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 10px;font-size:.74em;cursor:pointer">↩ Return</button>' : '') +
      (e.id ? '<button onclick="_plToggleLock()" style="background:transparent;color:' + (e.is_locked ? '#10b981' : 'var(--muted)') + ';border:1px solid ' + (e.is_locked ? '#10b981' : 'var(--border,#334155)') + ';border-radius:6px;padding:6px 10px;font-size:.74em;cursor:pointer">' + (e.is_locked ? '🔒 Locked' : '🔓 Lock') + '</button>' : '') +
      (!e.is_locked ? '<button onclick="_plSaveEntry()" style="background:#3b82f6;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Save</button>' : '') +
      (e.id && !e.is_locked ? '<button onclick="_plDeleteEntry()" style="background:transparent;color:#ef4444;border:1px solid #ef4444;border-radius:6px;padding:6px 10px;font-size:.74em;cursor:pointer">Delete</button>' : '') +
    '</div>' +
    // V2.3：Configure Fields 模式提示橫幅（英文）
    (_pl.configFields ? '<div style="background:#3b2f0a;border:1px solid #f59e0b;color:#fbbf24;border-radius:8px;padding:8px 10px;font-size:.68em;margin-bottom:10px;line-height:1.5">✏️ <b>Configure fields</b> — tap any field name to rename it, then <b>✓ Done</b> to save. Applies to all flights, synced across your devices.' +
      // V2.3.04：Off Duty 自動帶的間隔分鐘（公司規定不同可改；存 field_labels 保留 key，跨裝置同步）
      '<br>⏱️ Off Duty 自動帶 = In + <input id="pl-fl-off_duty_gap_min" type="number" inputmode="numeric" min="0" max="600" value="' + _plOffDutyGapMin() + '" style="width:54px;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid #f59e0b;border-radius:5px;padding:3px 6px;font-size:1em;text-align:center"> 分鐘 / Off Duty auto-fill = In + N min (company-specific).' +
      // V2.3.07：報到時間規則（依公司×機場）+ 回填按鈕
      _plDutyRulesEditHtml() + '</div>' : '') +

    // ── Flight：Date+Flight# / From+To / Type+Tail+Position ──
    '<div style="background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Flight</div>' +
      // V1.3.19：類型下拉（取代原本的 Deadhead 勾選框）— Flight / DHD / SIM
      '<div style="margin-bottom:8px">' +
        '<div style="font-size:.62em;color:var(--muted);margin-bottom:3px">類型 / Type</div>' +
        '<select id="ple-entry-type" onchange="_plEntryTypeChange()" style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em">' +
          '<option value="flight"' + (_plEntryType(e) === 'flight' ? ' selected' : '') + '>✈️ Flight 一般航班</option>' +
          '<option value="dhd"' + (_plEntryType(e) === 'dhd' ? ' selected' : '') + '>🧳 DHD 搭便機（乘客 — 不算 PIC/SIC 與起降）</option>' +
          '<option value="sim"' + (_plEntryType(e) === 'sim' ? ' selected' : '') + '>🖥️ SIM 模擬機</option>' +
        '</select>' +
      '</div>' +
      '<div id="ple-sim-fields" style="display:' + (_plEntryType(e) === 'sim' ? 'block' : 'none') + ';margin-bottom:8px">' +
        _plFieldRow(2, _plEditorField('Sim Type（FFS/FTD）', 'sim_type', 'text') + _plEditorField('Sim Time', 'sim_minutes', 'hhmm-dur')) +
      '</div>' +
      _plFieldRow(2, _plEditorField('Date', 'flight_date', 'date') + _plEditorField('Flight #', 'flight_no', 'text')) +
      '<div id="ple-route-row" style="display:' + (_plEntryType(e) === 'sim' ? 'none' : '') + '">' + _plFieldRow(2, _plEditorField('From (' + (_plAptFmtCur() === 'iata' ? 'IATA' : 'ICAO') + ')', 'origin', 'text', { fmt: _plAptFmt, aptSide: 'origin', labelId: 'ple-origin-label', placeholder: '選星宇航點或輸入 · pick/type' }) + _plEditorField('To (' + (_plAptFmtCur() === 'iata' ? 'IATA' : 'ICAO') + ')', 'dest', 'text', { fmt: _plAptFmt, aptSide: 'dest', labelId: 'ple-dest-label', placeholder: '選星宇航點或輸入 · pick/type' })) +
        '<div id="ple-aptname-row" style="font-size:.6em;color:var(--muted);margin:-4px 0 8px;line-height:1.4"></div>' +
        '<button type="button" id="ple-wx-btn" onclick="_plToggleEditorWx()" style="background:none;border:none;color:#22c55e;font-size:.7em;font-weight:700;cursor:pointer;padding:0 0 6px">⛅ WX · METAR / TAF ▾</button>' +
        '<div id="ple-wx-panel" style="display:none;margin-bottom:8px"></div></div>' +
      _plFieldRow(3, _plEditorField('Aircraft Type', 'aircraft_type', 'select', { options: typeOptions }) +
        _plEditorField('Tail #（清單來自 ✈️ Aircraft）', 'tail_no', 'select', { options: tailOptions }) +
        _plEditorField('Position', 'position', 'select', { options: ['', 'PIC', 'SIC', 'SFO', 'FO', 'OBSERVER'] })) +
    '</div>' +

    // ── Times：Scheduled 一行 / OOOI 一行 / Duty 一行 ──
    '<div id="ple-times-sec" style="display:' + (_plEntryType(e) === 'sim' ? 'none' : 'block') + ';margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:2px">Times (UTC HHMM)</div>' +
      _plFieldSub('Scheduled') +
      _plFieldRow(2, _plEditorField('Sched Out', 'std_utc', 'time-utc', { localOf: 'origin' }) + _plEditorField('Sched In', 'sta_utc', 'time-utc', { localOf: 'dest' })) +
      _plFieldSub('Actual · OOOI') +
      // V2.2.02：OOOI —— iPad 維持 4 欄一排；手機改 2×2（4 欄太擠、placeholder「HHMM UTC」被切）。
      (_plWide()
        ? _plFieldRow(4, _plEditorField('Out', 'out_utc', 'time-utc') + _plEditorField('Off', 'off_utc', 'time-utc') +
            _plEditorField('On', 'on_utc', 'time-utc') + _plEditorField('In', 'in_utc', 'time-utc'))
        : _plFieldRow(2, _plEditorField('Out', 'out_utc', 'time-utc') + _plEditorField('Off', 'off_utc', 'time-utc')) +
          _plFieldRow(2, _plEditorField('On', 'on_utc', 'time-utc') + _plEditorField('In', 'in_utc', 'time-utc'))) +
      _plFieldSub('Duty') +
      _plFieldRow(2, _plEditorField('On Duty', 'on_duty_utc', 'time-utc', { labelSuffix: '<span id="ple-onduty-from" style="font-size:.6em;color:var(--muted);white-space:nowrap"></span>' }) +
        _plEditorField('Off Duty', 'off_duty_utc', 'time-utc', { labelSuffix: '<span id="ple-fdp-limit" style="font-size:.62em;font-weight:700;white-space:nowrap"></span>' })) +
      _plFieldRow(2, _plEditorField('Operating Crew', 'operating_crew', 'select', { options: ['', '2', '3', '4'], optLabels: { '': '自動 Auto', '2': '2 人', '3': '3 人', '4': '4 人' } }) +
        '<div style="font-size:.58em;color:var(--muted);align-self:center;line-height:1.3">操作飛行員數（FDP 上限用）<br>PIC+SIC+Relief · auto-detected</div>') +
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
      _plFieldRow(1, _plEditorField('Autolands', 'autolands', 'number')) +
    '</div>' +

    // ── Persons / POB：Crew（含後艙空服）+ Pax → POB 機上總人數（自動加總）──
    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Persons on Board · POB</div>' +
      _plFieldRow(3, _plEditorField('Crew 組員', 'crew_count', 'number') + _plEditorField('Pax 乘客', 'pax_count', 'number') +
        _plEditorField('POB 總人數', 'pob_display', 'number', { readonly: true })) +
      '<div style="font-size:.6em;color:var(--muted);margin-top:4px">POB = Crew + Pax 自動加總 · auto-summed.</div>' +
    '</div>' +

    // ── Crew：飛航組（PIC/SIC/Relief/Observer）+ 客艙組（cabin1..20，收合）（V2.3；欄位名可在 Crew 頁自訂）──
    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
        '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase">Crew</div>' +
        (_plEntryType(e) === 'flight' ? '<button type="button" onclick="_plSwapPicSic()" title="對調 PIC/SIC（一去一回輪替）" style="background:transparent;border:1px solid var(--border,#334155);border-radius:6px;color:var(--text);font-size:.7em;padding:4px 8px;cursor:pointer">⇄ Swap PIC/SIC</button>' : '') +
      '</div>' +
      _plCrewDatalist() +
      _plCrewFields(e) +
    '</div>' +

    // ── Other：SID+STAR / Remarks ──
    '<div style="margin-top:12px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="font-size:.7em;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Other</div>' +
      _plFieldRow(2, _plEditorField('Dep Rwy', 'dep_rwy', 'text', { rwySide: 'origin' }) + _plEditorField('SID', 'sid', 'text')) +
      _plFieldRow(2, _plEditorField('STAR', 'star', 'text') + _plEditorField('Arr Rwy', 'arr_rwy', 'text', { rwySide: 'dest' })) +
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
// V1.3.19：entry 類型（flight/dhd/sim）。下拉切換時 show/hide sim 欄 + 收/展航線與 Times。
function _plEntryType(e) { return (e && e.is_sim) ? 'sim' : ((e && e.is_deadhead) ? 'dhd' : 'flight'); }
function _plEntryTypeChange() {
  var v = (document.getElementById('ple-entry-type') || {}).value || 'flight';
  var sf = document.getElementById('ple-sim-fields');
  var route = document.getElementById('ple-route-row');
  var times = document.getElementById('ple-times-sec');
  if (sf) sf.style.display = (v === 'sim') ? 'block' : 'none';
  if (route) route.style.display = (v === 'sim') ? 'none' : '';
  if (times) times.style.display = (v === 'sim') ? 'none' : '';
  if (typeof _plAutoCalcDuty === 'function') _plAutoCalcDuty();   // V2.4.03：切 DHD/SIM 即時更新 FDP Limit（DHD/SIM 不顯示）
}

async function _plSaveEntry() {
  var e = _pl.editing;
  if (!e) return;

  // V1.3.19：類型下拉決定 flight / dhd / sim
  var _etype = (document.getElementById('ple-entry-type') || {}).value || 'flight';
  var _isSim = _etype === 'sim';

  var body = {
    flight_date: _plReadField('flight_date'),
    flight_no: _plReadField('flight_no'),
    origin: (_plReadField('origin') || '').toUpperCase(),
    dest: (_plReadField('dest') || '').toUpperCase(),
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
    is_deadhead: _etype === 'dhd',
    is_sim: _isSim,
    sim_type: _isSim ? (_plReadField('sim_type') || null) : null,
    sim_minutes: _isSim ? _plReadField('sim_minutes', 'hhmm-dur') : null,
    total_duty_minutes: _plReadField('total_duty_minutes', 'hhmm-dur'),
    distance_nm: _plReadField('distance_nm', 'number'),
    day_takeoffs: _plReadField('day_takeoffs', 'number') || 0,
    night_takeoffs: _plReadField('night_takeoffs', 'number') || 0,
    day_landings: _plReadField('day_landings', 'number') || 0,
    night_landings: _plReadField('night_landings', 'number') || 0,
    autolands: _plReadField('autolands', 'number') || 0,
    pax_count: _plReadField('pax_count', 'number'),
    crew_count: _plReadField('crew_count', 'number'),
    operating_crew: (function() { var v = parseInt(_plGetVal('ple-operating_crew'), 10); return (v >= 2 && v <= 4) ? v : null; })(),
    dep_rwy: _plReadField('dep_rwy'),
    arr_rwy: _plReadField('arr_rwy'),
    sid: _plReadField('sid'),
    star: _plReadField('star'),
    remarks: _plReadField('remarks'),
  };

  // V1.3.19：SIM 沒有航線 / OOOI → 即使隱藏欄位有殘值也清空
  if (_isSim) {
    body.origin = null; body.dest = null;
    body.std_utc = null; body.sta_utc = null;
    body.out_utc = null; body.off_utc = null; body.on_utc = null; body.in_utc = null;
  }

  // V2.3.07（codex P2）：Duty 時間跨午夜校正 —— time-utc 欄位存檔一律掛在 flight_date 上，
  // 但 STD 剛過 00Z（台北早班很常見）時 On Duty = STD−110分 落在「前一天」22:xxZ，naive 存法會晚 24h。
  // 錨定修正：On Duty 不可能晚於 STD/Out → 晚了就 −24h；Off Duty 不可能早於 In → 早了就 +24h。
  // codex P2 round5：加 12h 護欄 —— 差距大到只可能是跨午夜（>12h）才校正；
  // 幾小時內的偏差（大延誤晚報到、手動特例）視為使用者本意，原樣保存。
  try {
    var HALF_DAY = 12 * 3600 * 1000;
    var _onAnchor = body.std_utc || body.out_utc;
    if (body.on_duty_utc && _onAnchor && new Date(body.on_duty_utc).getTime() - new Date(_onAnchor).getTime() > HALF_DAY) {
      body.on_duty_utc = new Date(new Date(body.on_duty_utc).getTime() - 86400000).toISOString();
    }
    // Off Duty 不可能早於落地/on-block/報到（codex P2 round9 補 on_duty 錨點）——
    // 早於錨點一律視為跨午夜 +24h（這側沒有「合法提早」情境，不用 12h 護欄）。
    var _offAnchor = body.in_utc || body.on_utc || body.on_duty_utc;
    if (body.off_duty_utc && _offAnchor && new Date(body.off_duty_utc).getTime() < new Date(_offAnchor).getTime()) {
      body.off_duty_utc = new Date(new Date(body.off_duty_utc).getTime() + 86400000).toISOString();
    }
  } catch (err) { /* 校正失敗就存原值（與舊行為相同） */ }

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

// V1.3.33：一鍵上鎖 / 解鎖全部航班
async function _plLockAll(locked) {
  var msg = locked
    ? '把「全部航班」一次上鎖嗎？\n鎖了就不能編輯 / 刪除（要改先解鎖）。'
    : '把「全部航班」一次解鎖嗎？';
  if (!window.confirm(msg)) return;
  if (!_plOnline()) { _plToast('🔒 一鍵上鎖需要連網路', 'error'); return; }
  try {
    var r = await _plApi('/api/pilot-log/entries/lock-all', { method: 'POST', body: { locked: locked } });
    if (!r.ok) { var ej = await r.json().catch(function() { return {}; }); _plToast('操作失敗 ' + (ej.error || r.status), 'error'); return; }
    var j = await r.json().catch(function() { return {}; });
    // codex P2：不要 _plRefreshMain（會用 server 快照蓋掉 outbox 裡未同步的離線編輯）。直接改本地 is_locked。
    (_pl.entries || []).forEach(function(e) { e.is_locked = locked; });
    if (_pl.aircraftEntries) _pl.aircraftEntries.forEach(function(e) { e.is_locked = locked; });
    _plCacheSaveEntries();
    if (_pl.aircraftEntries) _plCacheSaveAircraftEntries();
    _plToast((locked ? '🔒 已上鎖 ' : '🔓 已解鎖 ') + (j.updated || 0) + ' 筆');
    if (!_pl.editing) _plRenderMain();
  } catch (e) {
    _plToast('操作失敗', 'error');
  }
}

// 本地今天（YYYY-MM-DD）
function _plTodayStr() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
// V1.3.09：done / open 改用 in_utc 判斷（user：「未來的跟未完成都是藍色」）。
// V1.3.24：SIM / DHD 本來就沒 actual In（模擬機 / 搭便機沒 OOOI）→ 改用日期：flight_date
// 今天或更早（已發生）就算已完成；未來（roster 預排的 DHD）仍未完成（藍）。一般航班維持看 in_utc。
function _plEntryIsDone(e) {
  if (!e || e.status === 'roster_removed') return false;
  if (e.needs_completion) return false;   // 待補強＝未完成（缺資料），不管有沒有 in_utc 都不算「已完成」（codex P2）
  if (e.in_utc) return true;
  if ((e.is_sim || e.is_deadhead) && e.flight_date &&
      String(e.flight_date).slice(0, 10) <= _plTodayStr()) return true;
  return false;
}
function _plEntryMatchesFilter(e, filter) {
  // V1.3.34：roster_removed 完全不在任何篩選顯示（含 All）—— user：removed 就是 removed，不該出現在 All
  if (e.status === 'roster_removed') return false;
  if (filter === 'all') return true;
  if (filter === 'done') return _plEntryIsDone(e);
  if (filter === 'open') return !_plEntryIsDone(e);
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

// V2.3：多選勾選刪除 —— 清掉跑進來的 ground duty / 非航班腿用。
function _plToggleSelectMode() {
  _pl.selectMode = !_pl.selectMode;
  if (!_pl.selectMode) _pl.selectedIds = {};   // 離開選取模式清空
  _plRenderMain();
}
function _plToggleSelect(id) {
  if (!_pl.selectedIds) _pl.selectedIds = {};
  if (_pl.selectedIds[id]) delete _pl.selectedIds[id]; else _pl.selectedIds[id] = true;
  _plRenderList();   // 重畫列表反映勾選狀態
  var c = document.getElementById('pl-sel-count'); if (c) c.textContent = Object.keys(_pl.selectedIds).length;
}
async function _plDeleteSelected() {
  var ids = Object.keys(_pl.selectedIds || {});
  if (!ids.length) { _plToast('沒有選取任何航班 / Nothing selected', 'warn'); return; }
  // 鎖定的航班跳過（避免本機刪了、server 因鎖拒絕 → 下次同步又冒回來）。
  var byId = {}; for (var i = 0; i < _pl.entries.length; i++) byId[_pl.entries[i].id] = _pl.entries[i];
  var del = [], locked = [];
  // codex P2：只刪「目前還在列表裡」的 id。選取後若該筆 local id 被同步 reconcile 成 server id（id 變了），
  // 舊 id 已不在 byId → 跳過，否則會 enqueue 一個對不到的 delete、UI 報成功但實際沒刪（silent no-op）。
  ids.forEach(function(id) { var e = byId[id]; if (!e) return; if (e.is_locked) locked.push(id); else del.push(id); });
  if (!del.length) { _plToast('沒有可刪的航班（選取的都鎖定或已不存在）/ Nothing deletable (locked or gone)', 'warn'); return; }
  if (!window.confirm('刪除選取的 ' + del.length + ' 筆航班？' + (locked.length ? '（' + locked.length + ' 筆鎖定會跳過）' : '') + '無法復原。\nDelete ' + del.length + ' flights?' + (locked.length ? ' (' + locked.length + ' locked skipped)' : '') + ' Cannot be undone.')) return;
  var delset = {}; del.forEach(function(id) { delset[id] = true; });
  _pl.entries = _pl.entries.filter(function(x) { return !delset[x.id]; });
  if (_pl.aircraftEntries) _pl.aircraftEntries = _pl.aircraftEntries.filter(function(x) { return !delset[x.id]; });
  _plCacheSaveEntries();
  if (_pl.aircraftEntries) _plCacheSaveAircraftEntries();
  del.forEach(function(id) { _plEnqueue('delete', id); });   // 逐筆排 delete op（離線優先、回連自動上傳）
  _pl.selectedIds = {};
  _pl.selectMode = false;
  _plToast('已刪除 ' + del.length + ' 筆' + (locked.length ? '、' + locked.length + ' 鎖定跳過' : '') + ' / Deleted ' + del.length);
  _plRenderMain();
  _plSync();
}

// === SECTION: import ════════════════════════════════════════════════════════
// V1.3.25：Import 改成左側直欄三分頁（📅 班表 / 📥 Logbook / 🗑️ Wipe）+ 右側內容，
// 不再一次疊六張卡。Logbook 進去再子選 LogTen（4 格）/ Wader（1 格）；Wipe 用勾選類別。
function _plOpenImport() {
  _pl.aptReturn = false;   // V2.0.01（codex P2）：離開 Airports → 清返回標記，免得從這裡開編輯器關閉時誤跳 Airports
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  c.innerHTML =
    '<style>' +
      '.pl-imp-wrap{display:flex;gap:14px;max-width:780px;margin:0 auto;padding:0 20px 24px}' +
      '.pl-imp-nav{display:flex;flex-direction:column;gap:6px;flex:0 0 124px}' +
      '.pl-imp-nav button{text-align:left;background:var(--card);border:1px solid var(--border,#334155);border-radius:10px;padding:11px 12px;font-size:.8em;font-weight:700;color:var(--text);cursor:pointer;line-height:1.35}' +
      '.pl-imp-nav button.active{background:#10b981;color:#fff;border-color:#10b981}' +
      '.pl-imp-pane{flex:1;min-width:0}' +
      '.pl-imp-card{background:var(--card);border-radius:10px;padding:14px;margin-bottom:12px}' +
      '.pl-src-btn{flex:1;background:var(--bg,#0a0e1a);border:1px solid var(--border,#334155);border-radius:8px;padding:9px;font-size:.82em;font-weight:700;color:var(--text);cursor:pointer}' +
      '.pl-src-btn.active{background:#6366f1;color:#fff;border-color:#6366f1}' +
      '@media(max-width:640px){.pl-imp-wrap{flex-direction:column;padding:0 14px 18px;gap:10px}.pl-imp-nav{flex-direction:row;flex:none}.pl-imp-nav button{flex:1;text-align:center;padding:9px 4px;font-size:.72em}}' +
    '</style>' +
    '<div style="position:sticky;top:env(safe-area-inset-top);z-index:40;background:var(--bg);display:flex;align-items:center;gap:10px;padding:16px 20px 14px;max-width:780px;margin:0 auto">' +
      '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
      '<div style="font-size:1em;font-weight:700">Import 匯入</div>' +
    '</div>' +
    '<div class="pl-imp-wrap">' +
      '<div class="pl-imp-nav">' +
        '<button id="pl-imp-nav-roster" onclick="_plImportTab(\'roster\')">📅 班表<br>Roster</button>' +
        '<button id="pl-imp-nav-logbook" onclick="_plImportTab(\'logbook\')">📥 Logbook<br>來源</button>' +
        '<button id="pl-imp-nav-wipe" onclick="_plImportTab(\'wipe\')">🗑️ Wipe<br>清除</button>' +
      '</div>' +
      '<div class="pl-imp-pane" id="pl-imp-pane"></div>' +
    '</div>';
  var saved = 'roster';
  try { saved = localStorage.getItem('pilotlog_import_tab') || 'roster'; } catch (e) {}
  _plImportTab(saved);
}

function _plImportTab(tab) {
  if (['roster', 'logbook', 'wipe'].indexOf(tab) < 0) tab = 'roster';
  try { localStorage.setItem('pilotlog_import_tab', tab); } catch (e) {}
  ['roster', 'logbook', 'wipe'].forEach(function(t) {
    var b = document.getElementById('pl-imp-nav-' + t);
    if (b) b.className = (t === tab) ? 'active' : '';
  });
  var pane = document.getElementById('pl-imp-pane');
  if (!pane) return;
  if (tab === 'roster') pane.innerHTML = _plImportPaneRoster();
  else if (tab === 'logbook') { pane.innerHTML = _plImportPaneLogbook(); _plImportLogbookSrc(_plImportSavedSrc()); }
  else pane.innerHTML = _plImportPaneWipe();
}

// ① 班表 Roster pane
function _plImportPaneRoster() {
  return '<div class="pl-imp-card">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">📅 Roster · 從 CrewSync 帶班表（不用上傳檔）</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'CrewSync 同步過的班表<b>直接帶進來</b>，先是<b>未完成（藍）</b>，飛完補上實際時間（In）就自動變<b>已完成（綠）</b>。按下面先<b>列出可匯入的月份</b>，勾選你要的再匯入。<br>' +
        'Pulls the roster CrewSync has synced — they arrive as <b>open (blue)</b> and turn <b>done (green)</b> once you log the actual in-time after flying.<br>' +
        '<b>用前提示：</b>先去 CrewSync 用<b>同一個 Google 帳號</b>同步當月（與想要的其他月份），再回來。' +
      '</div>' +
      '<button onclick="_plRosterListMonths()" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">📅 列出可匯入月份 / List months</button>' +
      '<div id="pl-roster-months" style="margin-top:10px"></div>' +
    '</div>';
}

// ② Logbook pane：來源子選 + 內容容器 + 結果框
function _plImportSavedSrc() { try { return localStorage.getItem('pilotlog_import_src') || 'logten'; } catch (e) { return 'logten'; } }
function _plImportPaneLogbook() {
  return '<div class="pl-imp-card" style="padding:12px 14px">' +
      '<div style="font-size:.78em;color:var(--muted);margin-bottom:6px">來源 logbook / Source</div>' +
      '<div style="display:flex;gap:6px">' +
        '<button id="pl-src-logten" class="pl-src-btn" onclick="_plImportLogbookSrc(\'logten\')">LogTen Pro</button>' +
        '<button id="pl-src-wader" class="pl-src-btn" onclick="_plImportLogbookSrc(\'wader\')">Wader</button>' +
        '<button id="pl-src-logatp" class="pl-src-btn" onclick="_plImportLogbookSrc(\'logatp\')">Log ATP 2</button>' +
      '</div>' +
    '</div>' +
    '<div id="pl-imp-src-content"></div>' +
    '<div id="pl-import-result" style="margin-top:14px"></div>';
}
function _plImportLogbookSrc(src) {
  src = (src === 'wader' || src === 'logatp') ? src : 'logten';
  try { localStorage.setItem('pilotlog_import_src', src); } catch (e) {}
  var lt = document.getElementById('pl-src-logten'), wd = document.getElementById('pl-src-wader'), lp = document.getElementById('pl-src-logatp');
  if (lt) lt.className = 'pl-src-btn' + (src === 'logten' ? ' active' : '');
  if (wd) wd.className = 'pl-src-btn' + (src === 'wader' ? ' active' : '');
  if (lp) lp.className = 'pl-src-btn' + (src === 'logatp' ? ' active' : '');
  var box = document.getElementById('pl-imp-src-content');
  if (box) box.innerHTML = (src === 'logten') ? _plImportCardsLogTen() : (src === 'wader') ? _plImportCardWader() : _plImportCardLogatp();
}

// LogTen 四格：Flights / Aircraft / Aircraft Types / Address Book
function _plImportCardsLogTen() {
  return '<div class="pl-imp-card">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">✈️ Flights · Tab 動態匯出 / Dynamic Export</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'LogTen Pro 6 → File → Export → Dynamic Export Flights (Tab)。<br>' +
        '必填 / Required：Date / Flight # / From / To / Aircraft Type / Aircraft ID / Out / In。' +
      '</div>' +
      '<input type="file" id="pl-flights-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<div style="margin-top:10px;font-size:.68em;color:var(--muted);line-height:1.45">匯入會<b>自動帶入 / 補上組員</b>（含 FO）：已存在的航班也會用檔案重填組員＋PIC/SIC 時數，其他欄位（時間、你的編輯）不動。</div>' +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button onclick="_plUploadFlights(true)" style="background:#475569;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">🔍 Preview (dry-run)</button>' +
        '<button onclick="_plUploadFlights(false)" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Import</button>' +
      '</div>' +
      '<div style="font-size:.65em;color:var(--muted);margin-top:6px">建議先 Preview 確認解析正常再 Import。</div>' +
    '</div>' +
    '<div class="pl-imp-card">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">🛩️ Aircraft · 機尾庫 / Tail registry</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        '⚠️ LogTen 的 <b>Aircraft</b> export（每筆有機號），<b>不是 Aircraft Types</b>。建機尾庫，新增 entry 時 tail # 自動帶 operator/type。<br>必填 / Required：Aircraft ID / Operator / Type。' +
      '</div>' +
      '<input type="file" id="pl-aircraft-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<button onclick="_plUploadAircraft()" style="margin-left:8px;background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Upload</button>' +
    '</div>' +
    '<div class="pl-imp-card">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">🧭 Aircraft Types · 機型目錄 / Type catalog</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        '⚠️ LogTen 的 <b>Aircraft Types</b> export（type 為主、無機號），<b>跟 Aircraft 不同檔</b>。讓 Aircraft 列表顯示完整廠商機型（A359 → Airbus A-350-900）。<br>必填 / Required：Type。' +
      '</div>' +
      '<input type="file" id="pl-aircraft-types-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<button onclick="_plUploadAircraftTypes()" style="margin-left:8px;background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Upload</button>' +
    '</div>' +
    '<div class="pl-imp-card">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">👥 Address Book · Tab 匯出（選用）</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'LogTen → File → Export → Address Book Tab。匯入 crew 名單供篩選 / 查同事航班。<br>必填 / Required：Name / ID / This is Me（=1 標記本人，每人一筆 self）。' +
      '</div>' +
      '<input type="file" id="pl-addressbook-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<button onclick="_plUploadAddressBook()" style="margin-left:8px;background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Upload</button>' +
    '</div>';
}

// Wader 一格
function _plImportCardWader() {
  return '<div class="pl-imp-card">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">📄 Wader · CSV 匯出 / export</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'Wader logbook → 匯出 CSV。真實航班、模擬機、過往結轉時數（起始累計）都會帶進來。<br>' +
        'Imports Wader CSV — real flights, simulator sessions, and brought-forward totals.' +
      '</div>' +
      '<input type="file" id="pl-wader-file" accept=".csv,text/csv,text/plain" style="font-size:.78em">' +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button onclick="_plUploadWader(true)" style="background:#475569;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">🔍 Preview (dry-run)</button>' +
        '<button onclick="_plUploadWader(false)" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Import</button>' +
      '</div>' +
    '</div>';
}

// Log ATP 2 一格（CSV）
function _plImportCardLogatp() {
  return '<div class="pl-imp-card">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">📄 Log ATP 2 · CSV 匯出 / export</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'Log ATP 2 匯出 CSV。航班、OOOI、夜航、PIC/SIC、組員都會帶進來。可讀格式或 system data（Realm 原始匯出）都吃。<br>' +
        '時間視為 <b>UTC</b>；班號保留航空代碼（沒代碼會用機尾反查補上）；機尾統一加破折號；重複航班自動略過。<br>' +
        'Imports Log ATP 2 CSV (readable or raw system-data export) — flights, OOOI (UTC), night, PIC/SIC, crew; dedupes against existing logbooks.' +
      '</div>' +
      '<div style="font-size:.7em;font-weight:600;margin-bottom:3px">航班檔 Flight CSV</div>' +
      '<input type="file" id="pl-logatp-file" accept=".csv,text/csv,text/plain" style="font-size:.78em">' +
      '<div style="font-size:.7em;font-weight:600;margin:8px 0 3px">組員檔 Crew CSV <span style="color:var(--muted);font-weight:400">（選填，system data 要組員名字才需要）</span></div>' +
      '<input type="file" id="pl-logatp-crew-file" accept=".csv,text/csv,text/plain" style="font-size:.78em">' +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button onclick="_plUploadLogatp(true)" style="background:#475569;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">🔍 Preview (dry-run)</button>' +
        '<button onclick="_plUploadLogatp(false)" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Import</button>' +
      '</div>' +
      '<div style="font-size:.65em;color:var(--muted);margin-top:6px">建議先 Preview 確認解析正常再 Import。system data 格式請一併選組員檔，才帶得到組員名字。</div>' +
    '</div>';
}

// ③ Wipe pane：勾選資料類別（不分來源）
// V2.2.00：① 拿掉飛時的來源清單（新增來源會列不完，「所有航班紀錄」已涵蓋）② 每項補英文
//          ③ 沒勾任何項目前，紅色刪除鈕變灰不可按（解「會不小心按到」）。
function _plImportPaneWipe() {
  var cat = function(id, label, sub, subEn) {
    return '<label style="display:flex;align-items:flex-start;gap:9px;padding:11px 12px;background:var(--card);border:1px solid var(--border,#334155);border-radius:8px;margin-bottom:8px;cursor:pointer">' +
      '<input type="checkbox" id="pl-wipe-' + id + '" onchange="_plWipeSync()" style="margin-top:2px;flex:0 0 auto">' +
      '<span style="font-size:.8em"><b>' + label + '</b><br><span style="color:var(--muted);font-size:.9em">' + sub + '<br>' + subEn + '</span></span>' +
    '</label>';
  };
  return '<div style="font-size:.85em;font-weight:700;margin-bottom:4px;color:#fca5a5">🗑️ Wipe · 清除資料</div>' +
    '<div style="font-size:.7em;color:var(--muted);margin-bottom:10px;line-height:1.5">勾選要清除的資料類別（<b>不分匯入來源</b>）。<strong style="color:#fca5a5">不可復原。</strong><br>Tick categories to wipe (regardless of import source). Cannot be undone.</div>' +
    cat('flights', '飛時 Flights', '所有航班紀錄 + 起始累計', 'All flight records + brought-forward totals') +
    cat('aircraft', '機籍 Aircraft', '機尾庫', 'Tail registry') +
    cat('types', '機型 Aircraft Types', '機型目錄', 'Type catalog') +
    cat('crew', '通訊錄 Address Book', '所有同事聯絡人（會保留你本人）', 'All crew contacts (your own profile is kept)') +
    '<button id="pl-wipe-btn" onclick="_plWipeCategories()" disabled style="background:#dc2626;color:#fff;border:0;border-radius:8px;padding:11px 16px;font-size:.82em;font-weight:700;cursor:not-allowed;margin-top:6px;width:100%;opacity:.4">🔴 刪除勾選項目 / Delete selected</button>' +
    '<div id="pl-wipe-hint" style="font-size:.62em;color:var(--muted);text-align:center;margin-top:6px">先勾選要清除的項目 · Tick a category first</div>';
}

// V2.2.00：勾選狀態變化 → 沒勾任何項目時刪除鈕保持灰色不可按，避免誤觸。
function _plWipeSync() {
  var ids = ['flights', 'aircraft', 'types', 'crew'];
  var any = ids.some(function(id) { var el = document.getElementById('pl-wipe-' + id); return el && el.checked; });
  var btn = document.getElementById('pl-wipe-btn');
  var hint = document.getElementById('pl-wipe-hint');
  if (btn) {
    btn.disabled = !any;
    btn.style.opacity = any ? '1' : '.4';
    btn.style.cursor = any ? 'pointer' : 'not-allowed';
  }
  if (hint) hint.style.display = any ? 'none' : 'block';
}

// V1.3.25：依勾選的資料類別清除（不分來源）。通訊錄保留本人。
async function _plWipeCategories() {
  var all = [['flights', '飛時'], ['aircraft', '機籍'], ['types', '機型'], ['crew', '通訊錄']];
  var picked = all.filter(function(c) { var el = document.getElementById('pl-wipe-' + c[0]); return el && el.checked; });
  if (picked.length === 0) { _plToast('先勾選要清除的項目', 'error'); return; }
  var labels = picked.map(function(c) { return c[1]; }).join('、');
  if (!window.confirm('確定要清除：' + labels + '？\n（清通訊錄會保留你本人）\n這個動作不可復原。')) return;
  if (!window.confirm('再確認一次。按 OK 才會真的刪除。')) return;
  var qs = picked.map(function(c) { return c[0]; }).join(',');
  var r = await _plApi('/api/pilot-log/wipe?categories=' + encodeURIComponent(qs) + '&confirm=true', { method: 'DELETE' });
  if (!r.ok) {
    var err = await r.json().catch(function() { return {}; });
    _plToast('清除失敗：' + (err.error || r.status), 'error');
    return;
  }
  var j = await r.json();
  var d = j.deleted || {};
  var parts = [];
  if (d.flights != null) parts.push('飛時 ' + d.flights + (d.opening ? '（+ 起始累計 ' + d.opening + '）' : ''));
  if (d.aircraft != null) parts.push('機籍 ' + d.aircraft);
  if (d.types != null) parts.push('機型 ' + d.types);
  if (d.crew != null) parts.push('通訊錄 ' + d.crew);
  _plToast('已清除：' + (parts.join('、') || '無'));
  await _plRefreshMain();
}

async function _plUploadFile(inputId, endpoint) {
  // V2.3：並發守衛 —— 8 秒逾時時期 user 會「按了沒反應就再按」→ 多個匯入同時打 → DB 互撞變 500。
  // 一次只允許一個匯入在跑（搭配 120 秒逾時，不會卡死）。
  if (_pl.importing) { _plToast('已有匯入進行中，請稍候 / An import is already running', 'warn'); return null; }
  var input = document.getElementById(inputId);
  if (!input || !input.files || !input.files[0]) { _plToast('請先選檔案 / Pick a file first', 'warn'); return null; }
  var file = input.files[0];
  if (file.size > 5 * 1024 * 1024) { _plToast('檔案過大（>5MB）', 'error'); return null; }
  _pl.importing = true;
  // V2.3：匯入中指示 —— 大檔解析/上傳要幾秒，沒提示會被當成「按了沒反應」（user 實際踩過）。
  // 把處理中狀態寫進結果框（按鈕正下方一定看得到）+ toast，並包 try/catch 避免網路錯誤靜默失敗。
  var resBox = document.getElementById('pl-import-result');
  if (resBox) resBox.innerHTML = '<div style="background:#1e3a5f;color:#fff;padding:12px;border-radius:8px;font-size:.82em;display:flex;align-items:center;gap:8px">' +
    '<span style="display:inline-block;width:14px;height:14px;border:2px solid #93c5fd;border-top-color:transparent;border-radius:50%;animation:plspin .7s linear infinite"></span>' +
    '<span>⏳ 匯入處理中…請稍候、勿重複按（' + Math.round(file.size / 1024) + ' KB）<br>Importing… please wait, don’t tap again.</span></div>' +
    '<style>@keyframes plspin{to{transform:rotate(360deg)}}</style>';
  _plToast('⏳ 匯入中… Importing…');
  try {
    var text = await file.text();
    var r = await _plApi(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      timeoutMs: 120000,   // V2.3：匯入大檔/重匯可能要 30-60 秒，給 2 分鐘逾時（不可吃預設 8 秒 → 否則 Fetch aborted）
    });
    if (!r.ok && r.status !== 400) {
      _plToast('上傳失敗 ' + r.status, 'error');
      if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ 上傳失敗 ' + r.status + '（請重試）</div>';
      return null;
    }
    return await r.json();
  } catch (e) {
    var msg = (e && e.message) ? e.message : 'unknown';
    _plToast('匯入失敗：' + msg, 'error');
    if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ 匯入失敗：' + _plEsc(msg) + '<br>（網路或檔案問題，請重試）</div>';
    return null;
  } finally {
    _pl.importing = false;   // V2.3：無論成功/失敗/逾時都解鎖，下次才能再匯
  }
}

function _plRenderPreviewRows(rows) {
  if (!rows || !rows.length) return '';
  // V1.3.24：badge 改講「已完成/未完成」（不露內部 draft/confirmed）；新增「補組員」action
  var statusZh = function(s) { return s === 'confirmed' ? '已完成' : '未完成'; };
  var actionBadge = function(action, newStatus) {
    if (action === 'skip_confirmed') return '<span style="background:#475569;color:#fff;padding:1px 6px;border-radius:4px;font-size:.85em">不動</span>';
    if (action === 'overwrite_crew') return '<span style="background:#8b5cf6;color:#fff;padding:1px 6px;border-radius:4px;font-size:.85em">補組員</span>';
    if (action === 'update') {
      var col = newStatus === 'confirmed' ? '#10b981' : '#f59e0b';
      return '<span style="background:' + col + ';color:#fff;padding:1px 6px;border-radius:4px;font-size:.85em">更新→' + statusZh(newStatus) + '</span>';
    }
    var col = newStatus === 'confirmed' ? '#10b981' : '#f59e0b';
    return '<span style="background:' + col + ';color:#fff;padding:1px 6px;border-radius:4px;font-size:.85em">新增 ' + statusZh(newStatus) + '</span>';
  };
  // V1.2.04：顯示「全部」row（不再只前 10）、容器加高可捲動
  var html = '<div style="margin-top:8px;font-size:.7em;color:var(--muted)">共 ' + rows.length + ' 筆預覽，可上下捲（新增＝新航班、更新＝覆蓋未完成的、不動＝已完成不碰、補組員＝只補/換組員；role=你的角色、pic/sic=實際時數、DH=deadhead）：</div>' +
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
  // V2.0.02（codex P3）：當月及「以後」（含更遠的未來班表）都預設勾；只有「過去」（早於當月）才不勾，
  // 避免誤匯一堆過去草稿，又不會把有效的未來班表漏掉。
  var _now = new Date();
  var _cm = _now.getFullYear() + '-' + String(_now.getMonth() + 1).padStart(2, '0');
  // 單列月份（含勾選盒）。當月及未來預設勾，過去不勾。
  function _row(mo) {
    var on = (mo >= _cm);
    return '<label style="display:flex;align-items:center;gap:8px;padding:5px 6px;font-size:.8em;cursor:pointer">' +
      '<input type="checkbox" class="pl-rmonth" value="' + _plEsc(mo) + '"' + (on ? ' checked' : '') + ' style="width:16px;height:16px">' +
      '<span>' + _plEsc(mo) + (on ? '' : ' <span style="color:var(--muted);font-size:.85em">（過去 · 預設不勾）</span>') + '</span></label>';
  }
  // V2.3：避免月份越累積越長 — 最近 6 個月直接列出，更早的「按年份」收合（預設摺起、點開才展開）。
  var RECENT_N = 6;
  var recentHtml = months.slice(0, RECENT_N).map(_row).join('');
  var byYear = {}, yearOrder = [];
  months.slice(RECENT_N).forEach(function(mo) {
    var y = mo.slice(0, 4);
    if (!byYear[y]) { byYear[y] = []; yearOrder.push(y); }
    byYear[y].push(mo);
  });
  var olderHtml = yearOrder.map(function(y) {
    return '<details style="margin-top:2px;border-top:1px solid var(--border,#334155)">' +
      '<summary style="cursor:pointer;font-size:.74em;color:var(--muted);padding:5px 6px">' +
      _plEsc(y) + ' 年（' + byYear[y].length + ' 個月）</summary>' +
      byYear[y].map(_row).join('') + '</details>';
  }).join('');
  box.innerHTML =
    '<div style="font-size:.68em;color:var(--muted);margin-bottom:4px">勾選要匯入的月份（<b>當月及未來預設勾</b>，過去月份預設不勾、要補再自己勾）。最近 6 個月直接顯示，更早的依年份收合：</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:4px">' +
      '<button onclick="_plRosterMonthsAll(true)" style="background:transparent;border:1px solid var(--border,#334155);color:var(--muted);border-radius:6px;padding:3px 8px;font-size:.68em;cursor:pointer">全選</button>' +
      '<button onclick="_plRosterMonthsAll(false)" style="background:transparent;border:1px solid var(--border,#334155);color:var(--muted);border-radius:6px;padding:3px 8px;font-size:.68em;cursor:pointer">全不選</button>' +
    '</div>' +
    '<div style="max-height:240px;overflow-y:auto;border:1px solid var(--border,#334155);border-radius:6px;padding:4px;margin-bottom:8px">' + recentHtml + olderHtml + '</div>' +
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
          ' / 已完成略過 ' + (sj.skipped_confirmed || 0) +
          (sj.skipped_existing ? ' / 已記略過 ' + sj.skipped_existing : '') +
          (sj.crew_filled ? ' / 補組員 ' + sj.crew_filled : '') +
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
      ' / 已完成略過 ' + (j.skipped_confirmed || 0) +
      (j.skipped_existing ? ' / 已記略過 ' + j.skipped_existing : '') +
      (j.crew_filled ? ' / 補組員 ' + j.crew_filled : '') +
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

// V1.3.17：Wader CSV 上傳（真實航班 / 模擬機 / 起始累計）
async function _plUploadWader(dryRun) {
  var endpoint = '/api/pilot-log/import/wader' + (dryRun ? '?dryRun=1' : '');
  var j = await _plUploadFile('pl-wader-file', endpoint);
  if (!j) return;
  var resBox = document.getElementById('pl-import-result');
  if (j.error) {
    resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ ' + _plEsc(j.error) + '</div>';
    return;
  }
  var msg = (dryRun ? '🔍 Dry-run（沒寫入 DB）：' : '✅ 匯入完成：') +
    '航班 <b>' + (j.imported_flights || 0) + '</b>、模擬機 <b>' + (j.imported_sims || 0) + '</b>、' +
    '起始累計 <b>' + (j.opening_types || 0) + '</b> 型、重複略過 <b>' + (j.duplicate_skipped || 0) + '</b>、' +
    '解析失敗 <b>' + (j.parse_errors || 0) + '</b>' + (j.needs_completion ? '、<span style="color:#fbbf24">待補強 <b>' + j.needs_completion + '</b> 筆（已收進來，可點開補完）</span>' : '');
  resBox.innerHTML = '<div style="background:' + (dryRun ? '#1e3a5f' : '#064e3b') + ';color:#fff;padding:10px;border-radius:8px;font-size:.78em">' + msg + '</div>';
  if (!dryRun) { await _plRefreshMain(); }
}

async function _plUploadLogatp(dryRun) {
  // V2.3（codex）：Log ATP 走兩檔合併、不經 _plUploadFile，所以同樣要自己帶並發守衛 + 長逾時 + 進度提示。
  if (_pl.importing) { _plToast('已有匯入進行中，請稍候 / An import is already running', 'warn'); return; }
  var endpoint = '/api/pilot-log/import/logatp' + (dryRun ? '?dryRun=1' : '');
  // 讀航班檔(必填)+ 組員檔(選填,system data 要組員名字才需要)→ 合併送(用標記切),server 端對照 crew1~4 的 ID → 名字。
  var fin = document.getElementById('pl-logatp-file');
  if (!fin || !fin.files || !fin.files[0]) { _plToast('請先選航班檔', 'warn'); return; }
  var cin = document.getElementById('pl-logatp-crew-file');
  var hasCrew = !!(cin && cin.files && cin.files[0]);
  // ⚠ 兩檔合併送 → 合計要 < server body limit(5MB),否則 413(codex P2)。航班+組員合計檢查(+標記約 30 bytes)。
  var combinedBytes = fin.files[0].size + (hasCrew ? cin.files[0].size + 30 : 0);
  if (combinedBytes > 5 * 1024 * 1024) { _plToast('檔案太大：航班+組員合計需 <5MB', 'error'); return; }
  _pl.importing = true;
  var resBox = document.getElementById('pl-import-result');
  if (resBox) resBox.innerHTML = '<div style="background:#1e3a5f;color:#fff;padding:12px;border-radius:8px;font-size:.82em;display:flex;align-items:center;gap:8px">' +
    '<span style="display:inline-block;width:14px;height:14px;border:2px solid #93c5fd;border-top-color:transparent;border-radius:50%;animation:plspin .7s linear infinite"></span>' +
    '<span>⏳ 匯入處理中…請稍候、勿重複按<br>Importing… please wait, don’t tap again.</span></div><style>@keyframes plspin{to{transform:rotate(360deg)}}</style>';
  _plToast('⏳ 匯入中… Importing…');
  try {
    var text = await fin.files[0].text();
    if (hasCrew) text = text + '\n__LOGATP_CREW_FILE__\n' + (await cin.files[0].text());
    var rr = await _plApi(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text, timeoutMs: 120000 });
    if (!rr.ok && rr.status !== 400) { _plToast('上傳失敗 ' + rr.status, 'error'); if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ 上傳失敗 ' + rr.status + '（請重試）</div>'; return; }
    var j = await rr.json().catch(function() { return null; });
    if (!j) return;
    if (j.error) {
      // system data 帶了組員 ID 卻沒附組員檔 → 翻成白話,叫 user 補上組員檔(否則組員會被清空)。
      var emsg = (j.error === 'system_data_needs_crew_file')
        ? '這是 System Data 格式、航班裡有組員代碼，請一併在「組員檔 Crew CSV」放上組員 CSV，才對得到名字。<br>This is a System Data export with crew codes — please also attach the Crew CSV so names can be matched.'
        : _plEsc(j.error);
      resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ ' + emsg + '</div>';
      return;
    }
    var nNew = (j.preview || []).filter(function(p) { return p.action === 'insert'; }).length;
    var msg = (dryRun ? '🔍 Dry-run（沒寫入 DB）：' : '✅ 匯入完成 / Import done：') +
      '新增 <b>' + (dryRun ? nNew : (j.inserted || 0)) + '</b>、更新 <b>' + (j.updated || 0) + '</b>、' +
      '跨來源重複略過 <b>' + (j.cross_source_skipped || 0) + '</b>、補航空代碼 <b>' + (j.code_backfilled || 0) + '</b>、' +
      '解析失敗 <b>' + (j.parse_errors || 0) + '</b>' + (j.needs_completion ? '、<span style="color:#fbbf24">待補強 <b>' + j.needs_completion + '</b> 筆（已收進來，可點開補完）</span>' : '');
    resBox.innerHTML = '<div style="background:' + (dryRun ? '#1e3a5f' : '#064e3b') + ';color:#fff;padding:10px;border-radius:8px;font-size:.78em">' + msg + '</div>';
    if (!dryRun) { _plToast('✅ 匯入完成 / Import done：新增 ' + (j.inserted || 0) + ' · 更新 ' + (j.updated || 0)); await _plRefreshMain(); }
  } catch (e) {
    var em = (e && e.message) ? e.message : 'unknown';
    _plToast('匯入失敗：' + em, 'error');
    if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ 匯入失敗：' + _plEsc(em) + '<br>（網路或檔案問題，請重試）</div>';
  } finally {
    _pl.importing = false;
  }
}

async function _plUploadFlights(dryRun) {
  var overwrite = true;   // V1.3.37：一律自動帶入/覆蓋組員（拿掉勾選 — 匯入航班卻不帶組員無實務意義）
  var qs = [];
  if (dryRun) qs.push('dryRun=1');
  if (overwrite) qs.push('overwriteCrew=1');
  var endpoint = '/api/pilot-log/import/logten-flights' + (qs.length ? '?' + qs.join('&') : '');
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
  var nNew = 0, nUpdate = 0, nCrew = 0;
  if (j.preview) {
    for (var i = 0; i < j.preview.length; i++) {
      if (j.preview[i].action === 'insert') nNew++;
      else if (j.preview[i].action === 'update') nUpdate++;
      else if (j.preview[i].action === 'overwrite_crew') nCrew++;
    }
  }
  // 「已完成航班」的處置：開覆蓋 → 補組員筆數；沒開 → 保留不動筆數
  var doneLine = overwrite
    ? '補/換已完成航班組員 <b>' + (dryRun ? nCrew : (j.crew_overwritten || 0)) + '</b>、'
    : '保留已完成 <b>' + (j.duplicate_skipped || 0) + '</b>、';

  if (dryRun) {
    // V1.2.04：欄位偵測 — 一眼看出匯出檔有沒有帶 PIC/SIC 時數欄 + Deadhead 欄
    var headersInfo = '';
    if (j.headers && j.headers.length) {
      var hset = {};
      j.headers.forEach(function(h) { hset[String(h).toLowerCase().trim()] = true; });
      var hasPic = hset['pic'] || hset['pic/p1'] || hset['pic time'] || hset['flight pic'];
      var hasSic = hset['sic'] || hset['sic/p2'] || hset['sic time'] || hset['flight sic'];
      var hasDh = hset['deadhead'] || hset['positioning'];
      headersInfo = '<div style="margin-top:6px;font-size:.72em;line-height:1.6">' +
        '欄位偵測：PIC 時數 ' + (hasPic ? '✅' : '❌缺') + '　SIC 時數 ' + (hasSic ? '✅' : '❌缺') + '　Deadhead ' + (hasDh ? '✅' : '❌缺') +
        ((!hasPic || !hasSic) ? '<br><span style="color:#fde68a">⚠ 缺 PIC/SIC 時數欄 → 數字會對不上 LogTen。請在 LogTen 匯出時把 PIC、SIC 時數欄勾進去再重匯。</span>' : '') +
        (!hasDh ? '<br><span style="color:#fde68a">⚠ 缺 Deadhead 欄 → deadhead 仍會靠「過去日期自動算已完成」救起，只是不另外標 DH。</span>' : '') +
      '</div>';
    }
    var preview = _plRenderPreviewRows(j.preview);
    resBox.innerHTML = '<div style="background:#1e3a5f;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
      '🔍 Dry-run（沒寫入 DB）：新增 <b>' + nNew + '</b>、更新未完成 <b>' + nUpdate + '</b>、' +
      doneLine + '解析失敗 <b>' + j.parse_errors + '</b>' + (j.needs_completion ? '、<span style="color:#fbbf24">待補強 <b>' + j.needs_completion + '</b> 筆（已收進來，可點開補完）</span>' : '') + '<br>' +
      '<span style="font-size:.85em;color:#bfdbfe">確認 OK 後按 Import 真的寫入。</span>' +
      headersInfo +
      preview +
      '</div>';
  } else {
    resBox.innerHTML = '<div style="background:#064e3b;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
      '✅ 匯入完成：新增 <b>' + (j.inserted || 0) + '</b>、更新 <b>' + (j.updated || 0) + '</b>、' +
      doneLine + '解析失敗 <b>' + j.parse_errors + '</b>' + (j.needs_completion ? '、<span style="color:#fbbf24">待補強 <b>' + j.needs_completion + '</b> 筆（已收進來，可點開補完）</span>' : '') +
      '</div>';
    _plToast('✅ 匯入完成 / Import done：新增 ' + (j.inserted || 0) + ' · 更新 ' + (j.updated || 0) + (overwrite && (j.crew_overwritten || 0) > 0 ? ' · 補組員 ' + j.crew_overwritten : ''));
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
// 主頁 _pl.entries 受 filter 影響，counts 跟 drill-down 用這份獨立全量快照
async function _plFetchAircraftEntries() {
  // V2.2.07：用 limit=all（server 不加 LIMIT）整本全載，無上限。
  // V1.3.26：已知離線就別等網路 —— 離線時 fetch 會卡很久才失敗（Report/Analyze 一直 Loading…）。
  // navigator 明確離線 → 直接用既有快取（IDB 已載）+ 標離線，秒回。
  if (!_plOnline()) {
    _plSetOffline(true);
    if (!_pl.aircraftEntries) _pl.aircraftEntries = [];
    return;
  }
  // V1.2：網路掛掉保留既有快照（可能來自 IDB），設 OFFLINE 旗標；成功就寫一份回 IDB。
  try {
    var res = await _plApi('/api/pilot-log/entries?limit=all');
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

// V1.3.06：切換分組收合狀態，重畫 Aircraft 列表。V1.3.27：預設收合（未設=收合）→ toggle 用目前狀態反轉
function _plToggleAircraftType(key) {
  _pl.aircraftCollapsed = _pl.aircraftCollapsed || {};
  var collapsed = (_pl.aircraftCollapsed[key] !== false);   // 跟 render 同義：未設視為收合
  _pl.aircraftCollapsed[key] = !collapsed;                  // 收合→展開(false)、展開→收合(true)
  _plRenderAircraftList();
}
// V1.3.36：機型子分組收合（預設展開 → render 用 ===true 才收合，這裡同義反轉）
function _plToggleAircraftSubtype(key) {
  _pl.aircraftCollapsed = _pl.aircraftCollapsed || {};
  var collapsed = (_pl.aircraftCollapsed[key] === true);
  _pl.aircraftCollapsed[key] = !collapsed;
  _plRenderAircraftList();
}

async function _plOpenAircraft() {
  _pl.aptReturn = false;   // V2.0.01（codex P2）：離開 Airports → 清返回標記
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // Loading state（避免空白）
  c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">載入機尾庫… · Loading aircraft…</div>';
  // 同時拉 aircraft 清單跟完整 entries（兩者各自獨立、可並行）
  await _plFetchAll(); _pl.aircraftEntries = _pl.entries;   // V2.2.07：_plFetchAll 已用 limit=all 載全本 → 共用，免再抓一次（codex P2 修重複下載）
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

// V1.3.28（修 V1.3.27 分組）：機尾 → 公司 / 機型代碼。機尾庫欄位優先；空的用台灣機籍 tail 範圍推
// （跟 Analyze「依公司」同一套 _plTailLookup）。user 的機尾庫 operator 大多是空的，不推就全部變 no operator。
function _plAircraftCompany(a) {
  var op = (a && a.operator ? String(a.operator) : '').trim();
  if (op) return op;
  var look = _plTailLookup(a ? a.tail_no : '');
  return (look && look.operator) ? look.operator : '（未分類 No operator）';
}
function _plAircraftTypeLabel(a) {
  var tc = (a && a.type_code ? String(a.type_code) : '').trim();
  if (tc) return tc;
  var look = _plTailLookup(a ? a.tail_no : '');
  return (look && look.code) ? look.code : '';
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
    rows = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">機尾庫是空的。<b>📋 Pick from list</b>（台灣機隊一鍵加）、<b>✏️ Add manually</b>，或 <b>📥 Import</b> 上傳 LogTen Aircraft 檔。<br>No aircraft yet — 📋 pick from the built-in list, ✏️ add manually, or 📥 import a LogTen Aircraft file.</div>';
  } else {
    // V1.3.27：改依「公司（operator）」分組（user：之前按機型、且全展開）；預設全收合，tail 下標機型。
    var groups = {}, order = [];
    for (var ai = 0; ai < _pl.aircraft.length; ai++) {
      var a = _pl.aircraft[ai];
      var op = _plAircraftCompany(a);   // V1.3.28：operator 空就用 tail 推公司（不再全部 no operator）
      if (!groups[op]) { groups[op] = []; order.push(op); }
      groups[op].push(a);
    }
    var grpFlights = function(op) {
      var s = 0; groups[op].forEach(function(a) { s += tailCount[a.tail_no] || 0; }); return s;
    };
    order.sort(function(x, y) { return grpFlights(y) - grpFlights(x); });  // 飛最多的公司在前
    for (var gi = 0; gi < order.length; gi++) {
      var gop = order[gi];
      var list = groups[gop];
      // V1.3.27：預設收合（aircraftCollapsed[key] 未設 → 視為收合；明確 false 才展開）
      var collapsed = (_pl.aircraftCollapsed[gop] !== false);
      var arrow = collapsed ? '▶' : '▼';
      rows += '<div onclick="_plToggleAircraftType(\'' + _plJs(gop) + '\')" ' +
        'style="margin:14px 0 6px;display:flex;align-items:baseline;gap:8px;cursor:pointer;user-select:none">' +
        '<span style="font-size:.7em;color:var(--muted);width:14px;display:inline-block;text-align:center">' + arrow + '</span>' +
        '<span style="font-size:.95em;font-weight:800">' + _plEsc(gop) + '</span>' +
        '<span style="flex:1"></span>' +
        '<span style="font-size:.62em;color:var(--muted)">' + list.length + ' tail · ' + grpFlights(gop) + ' flights</span>' +
      '</div>';
      rows += '<div style="display:' + (collapsed ? 'none' : 'block') + '">';
      // V1.3.29：公司內再依「機型」分組（機型子標題 → 該型機尾）。user：分了公司要再分機型。
      var byType = {}, tOrder = [];
      list.forEach(function(ac) { var tl = _plAircraftTypeLabel(ac) || '—'; if (!byType[tl]) { byType[tl] = []; tOrder.push(tl); } byType[tl].push(ac); });
      var typeFlights = function(tl) { var s = 0; byType[tl].forEach(function(a) { s += tailCount[a.tail_no] || 0; }); return s; };
      tOrder.sort(function(x, y) { return typeFlights(y) - typeFlights(x); });   // 飛最多的機型在前
      tOrder.forEach(function(tl) {
        var tlist = byType[tl];
        // V1.3.36：機型子分組也可收合（key 用「公司|機型」；預設展開，明確收合才藏）
        var tkey = 'T:' + gop + '|' + tl;
        var tCollapsed = (_pl.aircraftCollapsed[tkey] === true);
        var tArrow = tCollapsed ? '▶' : '▼';
        rows += '<div onclick="_plToggleAircraftSubtype(\'' + _plJs(tkey) + '\')" ' +
          'style="display:flex;align-items:baseline;gap:6px;margin:8px 0 4px 4px;cursor:pointer;user-select:none">' +
          '<span style="font-size:.6em;color:var(--muted);width:12px;display:inline-block;text-align:center">' + tArrow + '</span>' +
          '<span style="font-size:.76em;font-weight:700;color:var(--accent)">' + _plEsc(tl) + '</span>' +
          '<span style="flex:1"></span>' +
          '<span style="font-size:.58em;color:var(--muted)">' + tlist.length + ' tail · ' + typeFlights(tl) + ' flights</span>' +
        '</div>';
        rows += '<div style="display:' + (tCollapsed ? 'none' : 'block') + '">';
        tlist.sort(function(a, b) { return (tailCount[b.tail_no] || 0) - (tailCount[a.tail_no] || 0); });
        tlist.forEach(function(ac) {
          var count = tailCount[ac.tail_no] || 0;
          rows += '<div onclick="_plOpenAircraftDetail(\'' + _plEsc(ac.tail_no) + '\')" ' +
            'style="background:var(--card);border-radius:8px;padding:9px 12px;margin:0 0 5px 8px;cursor:pointer;display:flex;gap:10px;align-items:center">' +
            '<div style="flex:1;min-width:0"><span style="font-size:.85em;font-weight:700">' + _plEsc(ac.tail_no) + '</span></div>' +
            '<div style="font-size:.72em;color:var(--text);text-align:right;white-space:nowrap">' + count + ' flights</div>' +
          '</div>';
        });
        rows += '</div>';   // close per-type collapsible wrapper
      });
      rows += '</div>';   // close per-company collapsible wrapper
    }
  }
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div class="pl-stickhead">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
        '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">✈️ Aircraft</div>' +
        '<div style="flex:1"></div>' +
        // V1.3.32：匯出機尾庫 / 機型目錄 CSV
        '<button onclick="_plExportAircraftCsv()" style="background:transparent;color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:5px 9px;font-size:.72em;cursor:pointer">⬇️ Aircraft</button>' +
        '<button onclick="_plExportTypesCsv()" style="background:transparent;color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:5px 9px;font-size:.72em;cursor:pointer">⬇️ Types</button>' +
        // V1.3.35：從台灣機隊挑機（內建現役機隊，點選一鍵加入）
        '<button onclick="_plOpenFleetPicker()" title="從內建台灣機隊清單挑機加入" style="background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">📋 Pick from list</button>' +
        '<button onclick="_plOpenAddAircraft()" title="手動輸入一架新機（清單沒有的）" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">✏️ Add manually</button>' +
      '</div>' +
      '</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:10px">依機型分組，共 ' + _pl.aircraft.length + ' 架；點任一筆查看用過這架的所有航班。<br>Grouped by type — tap a tail to see every flight on it.</div>' +
      rows +
    '</div>';
}

// === SECTION: Places（V1.3.36）— 仿 LogTen「依機場查航班」══════════════════════
// V2.0.02：星宇定期航點 37 個（Ops Spec C-6，4 機隊去重）。Airports 列表標 ⭐ 區分官方航點。
var _PL_STARLUX_APTS = {
  RCTP:1,RCMQ:1, VHHH:1,VMMC:1,
  RJAA:1,RJBB:1,RJBE:1,RJCC:1,RJCH:1,RJFF:1,RJFT:1,RJGG:1,RJOT:1,RJSS:1,ROAH:1,RORS:1,
  RKPK:1, RPLC:1,RPLL:1,RPVM:1, VTBS:1,VTCC:1,
  VVNB:1,VVPQ:1,VVTS:1,VVDN:1, WIII:1,WSSS:1,WMKP:1,WMKK:1,
  KLAX:1,KONT:1,KPHX:1,KSEA:1,KSFO:1, PGUM:1, LKPR:1
};
// 把任一碼（ICAO/IATA）正規化成 canonical ICAO（查不到就原樣大寫）
function _plCanonApt(code) {
  var c = String(code == null ? '' : code).toUpperCase().trim();
  if (!c) return '';
  var info = _plAptInfo(c);
  if (info && info.icao) return info.icao;
  if (_PL_IATA2ICAO[c]) return _PL_IATA2ICAO[c];
  return c;
}
// 列入 Places 的航班：只算「已飛」（排除未來班表草稿/未完成），非 SIM、且有起或訖。
// codex P2：原本納入所有 scheduled legs → 匯入下個月班表後，沒去過的機場就冒出來。
function _plPlacesEntries() {
  return (_pl.aircraftEntries || []).filter(function(e) {
    if (_plEntryType(e) === 'sim') return false;   // SIM 無機場
    if (!_plEntryIsDone(e)) return false;          // 只算已飛
    return !!(e.origin || e.dest);
  });
}
async function _plOpenPlaces() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  _pl.aptReturn = true;   // V1.3.39：標記「在 Airports」→ 從這裡點航班進編輯器，關閉就回 Airports
  c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">載入機場… · Loading places…</div>';
  await Promise.all([_plFetchAircraftEntries(), _plLoadAirports()]);
  _plRenderPlaces();
}
// 機場聚合列表。mode='flown'（你飛過的，依航班數）｜'starlux'（全 37 星宇航點，含沒飛過的，依代碼）
function _plAirportAgg(mode) {
  var map = {};
  function bump(code, dir) { var k = _plCanonApt(code); if (!k) return; if (!map[k]) map[k] = { key: k, dep: 0, arr: 0 }; map[k][dir]++; }
  _plPlacesEntries().forEach(function(e) { if (e.origin) bump(e.origin, 'dep'); if (e.dest) bump(e.dest, 'arr'); });
  function decorate(k) {
    var m = map[k] || { key: k, dep: 0, arr: 0 };
    m.total = m.dep + m.arr;
    var info = _plAptInfo(k);
    m.full = info ? info.name : ''; m.city = info ? info.city : ''; m.cc = info ? info.cc : '';
    return m;
  }
  if (mode === 'starlux') {
    // V2.0.02：全部 37 星宇航點（沒飛過的 count=0 也列），依 ICAO 排（區域聚集）
    return Object.keys(_PL_STARLUX_APTS).map(decorate).sort(function(a, b) { return a.key.localeCompare(b.key); });
  }
  var list = Object.keys(map).map(decorate);
  list.sort(function(a, b) { return b.total - a.total || a.key.localeCompare(b.key); });
  return list;
}
// 機場列表 HTML（左欄 / 窄螢幕全寬）；sel = 三欄目前選中（highlight）
function _plAptListHtml(list, sel) {
  if (list.length === 0) return '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">還沒有任何航班機場資料。 · No airports yet.</div>';
  return list.map(function(m) {
    var on = (m.key === sel);
    var sub = [m.city, m.cc].filter(Boolean).join(' · ');
    var star = _PL_STARLUX_APTS[m.key] ? '<span title="星宇定期航點 · Starlux scheduled" style="color:#f59e0b">⭐</span> ' : '';
    return '<div onclick="_plSelectAirport(\'' + _plJs(m.key) + '\')" style="background:' + (on ? 'rgba(59,130,246,.18)' : 'var(--card)') + ';border:1px solid ' + (on ? '#3b82f6' : 'transparent') + ';border-radius:8px;padding:9px 12px;margin-bottom:6px;cursor:pointer;display:flex;align-items:center;gap:10px">' +
      '<div style="min-width:54px;font-weight:800;font-size:1em">' + _plEsc(_plAptFmt(m.key)) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:.78em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + star + _plEsc(m.full || '—') + '</div>' +
        (sub ? '<div style="font-size:.64em;color:var(--muted)">' + _plEsc(sub) + '</div>' : '') +
      '</div>' +
      '<div style="text-align:right;font-size:.6em;color:var(--muted);white-space:nowrap;line-height:1.3">↗' + m.dep + ' ↘' + m.arr + '<br><b style="color:var(--text);font-size:1.5em">' + m.total + '</b></div>' +
    '</div>';
  }).join('');
}
// ≥1180=只有「真夠寬」的 iPad 橫拿(Air/Pro 11"+ 1180/1194、12.9" 1366)才用三欄;<1180(手機 + 所有直拿 + 小 iPad 橫拿 mini1133/10.2"1080)一律走窄版新單欄導覽 → 全機型全拿法不擠版/不裁切(贏過 LogTen)。使用者有意見再調。
function _plAptIsWide() { return (typeof window !== 'undefined' && window.innerWidth >= 1180); }
// 轉向/縮放時,若正在 Airports 且跨越了寬窄斷點 → 重繪成對的版型。否則「橫拿渲染的三欄」轉直拿會留著(版型是渲染當下決定的,不會自己變)。
function _plPlacesReflow() {
  if (!_pl.aptReturn) return;                                   // 只在 Airports 區(list/詳情/子頁)才管
  if (_pl.editing) return;                                      // ⚠ 編輯器開著就別重繪(從 Airports 點航班進編輯時 aptReturn 仍 true)→ 否則轉向會把編輯器砍掉、丟失未存編輯(codex P1)
  var wide = _plAptIsWide();
  if (_pl.placesWide === wide) return;                          // 沒跨斷點 → 不重繪(免每像素重畫)
  // 重繪前先讓開著的「機場 note」textarea 失焦 → 觸發它的 onblur 存檔(note 只在 blur 存)→ 轉向不丟未存的字(codex P2)
  try { var _ta = document.querySelector('#pilotlog-content textarea'); if (_ta) _ta.blur(); } catch (e) {}
  _pl.placesWide = wide;
  if (wide) {
    if (_pl.aptDetailKey) _pl.airportSel = _pl.aptDetailKey;    // 窄版詳情/子頁轉寬 → 三欄選中那機場
    if (_pl.aptFlightsFilt) _pl.placeFilter = _pl.aptFlightsFilt;   // 帶上目前 All/Dep/Arr 篩選 → 寬版三欄維持同一個(codex P2)
    _plRenderPlaces();
  } else if (_pl.aptDetailKey && _pl.aptFlightsFilt) {
    _plOpenPlaceFlights(_pl.aptDetailKey, _pl.aptFlightsFilt);  // 子頁
  } else if (_pl.aptDetailKey || _pl.airportSel) {
    _plOpenPlaceDetail(_pl.aptDetailKey || _pl.airportSel);     // 寬版選中的機場轉窄 → 開它的詳情頁
  } else {
    _plRenderPlaces();                                          // 列表
  }
}

// 🗺️ Airports —— 寬螢幕三欄（列表 | 資訊 | 航班）；窄螢幕列表（點 → 詳情頁）
function _plRenderPlaces() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  // 保留左欄機場列表的捲動位置:點機場會整頁重畫,不要跳回頂端(要重滑找回剛剛的機場)
  var _prevAptScroll = 0;
  var _leOld = document.getElementById('pl-apt-listcol');
  if (_leOld) _prevAptScroll = _leOld.scrollTop;
  var mode = _pl.aptMode || 'flown';
  var list = _plAirportAgg(mode);
  var wide = _plAptIsWide();
  _pl.placesWide = wide;   // 記錄目前渲染的版型 → 轉向時 _plPlacesReflow 比對是否跨斷點
  var sel = _pl.airportSel;
  if (sel && !list.some(function(m) { return m.key === sel; })) sel = null;
  if (wide && !sel && list.length) sel = list[0].key;
  _pl.airportSel = sel;

  function modeTab(mo, lbl) {
    var on = (mode === mo);
    return '<button onclick="_plSetAptMode(\'' + mo + '\')" style="background:' + (on ? '#3b82f6' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--muted)') + ';border:1px solid ' + (on ? '#3b82f6' : 'var(--border,#334155)') + ';border-radius:6px;padding:4px 10px;font-size:.72em;font-weight:600;cursor:pointer">' + lbl + '</button>';
  }
  var header = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
    '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
    '<div style="font-size:1em;font-weight:700">🗺️ Airports</div>' +
    modeTab('flown', '✈️ 飛過的') + modeTab('starlux', '⭐ 星宇') +
    '<div style="flex:1"></div>' +
    '<div style="font-size:.72em;color:var(--muted)">' + list.length + ' airports</div>' +
  '</div>';
  var hint = (mode === 'starlux'
    ? '星宇 37 個定期航點（含還沒飛過的）。點任一筆看資訊 / 衛星地圖 / 航班。'
    : '你飛過的機場，依航班數排序。點任一筆看進出航班。');

  if (!wide) {
    c.innerHTML = '<div style="padding:10px 14px">' +
      '<div class="pl-stickhead">' + header +   // #5：窄螢幕整頁捲 → 頂部（標題+篩選+說明）固定
        '<div style="font-size:.68em;color:var(--muted)">' + hint + '</div>' +
      '</div>' +
      _plAptListHtml(list, null) + '</div>';
    return;
  }
  // 寬螢幕三欄：外框固定高度，三欄各自獨立捲動（不整頁一起捲）
  c.innerHTML = '<div style="padding:10px 14px">' + header +
    '<div style="display:flex;gap:14px;align-items:stretch;height:calc(100vh - 138px)">' +
      '<div id="pl-apt-listcol" style="flex:0 0 280px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px">' + _plAptListHtml(list, sel) + '</div>' +
      (sel
        ? '<div style="flex:0 0 400px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px">' + _plAptInfoHtml(sel) + '</div>' +
          '<div style="flex:1 1 auto;min-width:0;max-width:660px;overflow-y:auto;overscroll-behavior:contain">' + _plAptFlightsHtml(sel) + '</div>'
        : '<div style="flex:1;color:var(--muted);padding:30px;font-size:.85em">左邊選一個機場 · pick an airport</div>') +
    '</div>' +
  '</div>';
  // 點機場重畫後把左欄捲回剛剛位置(不用重滑找機場)
  var _leNew = document.getElementById('pl-apt-listcol');
  if (_leNew) _leNew.scrollTop = _prevAptScroll;
}
// 點機場：寬螢幕更新三欄中右；窄螢幕進詳情頁
function _plSelectAirport(key) {
  _pl.placeFilter = 'all';
  if (_plAptIsWide()) { _pl.airportSel = key; _plRenderPlaces(); }
  else { _plOpenPlaceDetail(key); }
}
// V2.0.02：切換「飛過的 / ⭐ 星宇航點」清單
function _plSetAptMode(mode) { _pl.aptMode = mode; _pl.airportSel = null; _plRenderPlaces(); }
// V1.3.39：機場個人筆記（Note）—— 先存本機 localStorage（server 同步版之後做）
// V2.0.01（codex P2）：per-user key —— 同裝置多帳號 / 登出登入不會互相看到/蓋掉筆記
function _plAptNoteKey() { return 'pilotlog_apt_notes_' + ((_pl.user && _pl.user.id) || 'anon'); }
function _plAirportNote(icao) {
  try { return (JSON.parse(localStorage.getItem(_plAptNoteKey()) || '{}'))[icao] || ''; } catch (e) { return ''; }
}
// V1.3.39：inline 編輯（textarea 失焦直接存；不彈窗、不重畫以免丟焦/閃）
function _plSaveAirportNote(icao, val) {
  try {
    var k = _plAptNoteKey(), m = JSON.parse(localStorage.getItem(k) || '{}');
    if (val && val.trim()) m[icao] = val.trim(); else delete m[icao];
    localStorage.setItem(k, JSON.stringify(m));
  } catch (e) {}
}
// 機場資訊卡 HTML（label 左值右；三欄中欄 + 窄螢幕詳情共用）
function _plAptInfoHtml(key) {
  var info = _plAptInfo(key);
  function cell(lbl, val) {
    if (val == null || val === '') return '';
    return '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid var(--border,#1e293b)">' +
      '<span style="color:var(--muted);font-size:.7em;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap">' + lbl + '</span>' +
      '<span style="font-weight:600;font-size:.82em;text-align:right">' + val + '</span></div>';
  }
  if (!info) return '<div style="background:var(--card);border-radius:10px;padding:12px;font-size:.78em;color:var(--muted)">機場庫載入中… · loading airport DB…</div>';
  var ltime = '', tzOff = '';
  if (info.tz) {
    try { ltime = new Intl.DateTimeFormat('en-GB', { timeZone: info.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); } catch (e) {}
    try {
      var _tp = new Intl.DateTimeFormat('en-US', { timeZone: info.tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
      var _to = _tp.find(function(x) { return x.type === 'timeZoneName'; });
      if (_to) tzOff = _to.value.replace('GMT', 'UTC');   // 「GMT+8」→「UTC+8」（含夏令時自動）
    } catch (e) {}
  }
  var cName = info.cc || '';
  try { if (info.cc) cName = new Intl.DisplayNames(['en'], { type: 'region' }).of(info.cc) || info.cc; } catch (e) {}
  var st = '';
  if (['US', 'CA', 'AU'].indexOf(info.cc) >= 0 && info.region && info.region.indexOf('-') >= 0) st = info.region.split('-')[1];
  var mvStr = (info.mvar != null) ? (Math.abs(info.mvar) + '°' + (info.mvar < 0 ? 'W' : info.mvar > 0 ? 'E' : '')) : '';
  // 衛星地圖（Esri World Imagery 靜態圖；公開服務、無金鑰，看得到真實跑道/航廈）
  var mapImg = '';
  if (info.lat != null && info.lon != null) {
    mapImg = _plAptMapHtml(info);
    if (info.icao) setTimeout(function() { _plLoadAptWind(info.icao); }, 0);   // DOM 插入後抓 METAR 風向 → 跑道上綠橘端 + 風向箭頭
  }
  return '<div style="background:var(--card);border-radius:10px;padding:4px 14px">' +
    cell('Name', _plEsc(info.name)) +
    cell('ICAO', _plEsc(info.icao)) + cell('IATA', _plEsc(info.iata)) +
    cell('City', _plEsc(info.city)) + cell('State', _plEsc(st)) +
    cell('Country', _plEsc(cName)) + cell('Elevation', (info.elev !== '' && info.elev != null) ? info.elev + ' ft' : '') +
    cell('Mag Var', mvStr) +
    cell('Timezone', _plEsc(info.tz) + (tzOff ? ' <span style="color:var(--muted);font-weight:400">· ' + tzOff + '</span>' : '') + (ltime ? ' <span style="color:var(--muted);font-weight:400">· ' + ltime + '</span>' : '')) +
    cell('Lat / Lon', info.lat != null ? info.lat + ', ' + info.lon : '') +
    cell('Runways', (info.runways && info.runways.length) ? _plEsc(info.runways.map(function(r) { return r[0] + '/' + r[1]; }).join('　')) : '') +
    mapImg +
    '<div style="padding:7px 0;border-top:1px solid var(--border,#1e293b);margin-top:3px">' +
      '<div style="color:var(--muted);font-size:.7em;text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px">Note</div>' +
      '<textarea onblur="_plSaveAirportNote(\'' + _plJs(info.icao || key) + '\', this.value)" placeholder="新增機場筆記… · add a note" rows="2" style="width:100%;background:var(--bg,#0a0e1a);border:1px solid var(--border,#334155);border-radius:6px;color:var(--text);font-size:.82em;padding:6px 8px;resize:vertical;font-family:inherit;outline:none;box-sizing:border-box">' + _plEsc(_plAirportNote(info.icao || key)) + '</textarea></div>' +
  '</div>';
}
// 某機場的進出航班集合 {all, dep, arr}（已依日期新→舊排序）。三欄右欄 + 窄版詳情/子頁共用。
function _plAptFlightSets(key) {
  var all = _plPlacesEntries().filter(function(e) { return _plCanonApt(e.origin) === key || _plCanonApt(e.dest) === key; });
  var dep = all.filter(function(e) { return _plCanonApt(e.origin) === key; });
  var arr = all.filter(function(e) { return _plCanonApt(e.dest) === key; });
  var byDate = function(a, b) { return (b.flight_date || '').localeCompare(a.flight_date || ''); };
  all.sort(byDate); dep.sort(byDate); arr.sort(byDate);
  return { all: all, dep: dep, arr: arr };
}
// 航班分頁 + 列表 HTML（≥1080 三欄右欄用；窄版改走 _plOpenPlaceDetail → _plOpenPlaceFlights 子頁）
function _plAptFlightsHtml(key) {
  var sets = _plAptFlightSets(key);
  var all = sets.all, depF = sets.dep, arrF = sets.arr;
  var filt = _pl.placeFilter || 'all';
  var flights = (filt === 'dep' ? depF : filt === 'arr' ? arrF : all);
  function ftab(f, lbl, n) {
    var on = (filt === f);
    return '<button onclick="_plSetPlaceFilter(\'' + f + '\',\'' + _plJs(key) + '\')" style="flex:1;background:' + (on ? '#3b82f6' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--muted)') + ';border:1px solid ' + (on ? '#3b82f6' : 'var(--border,#334155)') + ';border-radius:6px;padding:7px 4px;font-size:.74em;font-weight:600;cursor:pointer">' + lbl + ' <b>' + n + '</b></button>';
  }
  // 釘在欄頂:列表捲動時 All/Dep/Arr 不被推走(底色蓋住底下捲動的航班)
  var tabs = '<div style="display:flex;gap:6px;position:sticky;top:0;z-index:3;background:var(--bg,#0a0e1a);padding-bottom:8px;margin-bottom:2px">' +
    ftab('all', 'All', all.length) + ftab('dep', '🛫 Dep', depF.length) + ftab('arr', '🛬 Arr', arrF.length) + '</div>';
  var rows = flights.length === 0
    ? '<div style="text-align:center;color:var(--muted);padding:24px;font-size:.85em">沒有航班。 · No flights.</div>'
    : flights.map(_plRenderEntryRow).join('');
  return tabs + rows;
}
// 分頁切換：寬螢幕重畫三欄（保 sel）、窄螢幕重畫詳情頁
function _plEnterPlace(key) { _pl.placeFilter = 'all'; _plOpenPlaceDetail(key); }
function _plSetPlaceFilter(f, key) {
  _pl.placeFilter = f;
  if (_plAptIsWide()) { _pl.airportSel = key; _plRenderPlaces(); }
  else _plOpenPlaceDetail(key);
}
// 窄版（手機 + iPad 直拿）：機場詳情頁＝資訊(衛星圖+note) + 三列導覽(All/Departing/Arriving →)，← 回列表。
// 航班清單不再塞這頁(避免「一直滑」)，改點某列跳到 _plOpenPlaceFlights 子頁。仿 LogTen 但連 iPad 直拿都處理好。
function _plOpenPlaceDetail(key) {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  _pl.aptDetailKey = key;   // V2.0.01（codex P2）：記住正在看哪個機場 → 從這裡點航班、關閉時回到這頁（不是回列表）
  _pl.aptFlightsFilt = null;   // 在詳情層(不是子頁)→ 清掉子頁返回標記
  var info = _plAptInfo(key);
  var disp = _plAptFmt(key);
  var sets = _plAptFlightSets(key);
  // 頂部三段鈕：比照第三層子頁(seg 樣式)，點了一樣跳子頁(篩 all/dep/arr)。詳情層本身非選中狀態，故都不上色。
  function seg(f, lbl, n) {
    return '<button onclick="_plOpenPlaceFlights(\'' + _plJs(key) + '\',\'' + f + '\')" style="flex:1;background:transparent;color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:7px 4px;font-size:.74em;font-weight:600;cursor:pointer">' + lbl + ' <b>' + n + '</b></button>';
  }
  c.innerHTML = '<div style="padding:10px 14px">' +
    '<div class="pl-stickhead">' +   // 釘頂:返回鈕+機場名+三段鈕(比照第三層)，捲機場圖時不被推走
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<button onclick="_plOpenPlaces()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1.05em;font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _plEsc(disp) +
          (info && info.icao && info.iata ? ' <span style="color:var(--muted);font-size:.66em;font-weight:400">' + _plEsc(info.icao) + ' / ' + _plEsc(info.iata) + '</span>' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;padding-bottom:8px">' +
        seg('all', 'All', sets.all.length) + seg('dep', '🛫 Dep', sets.dep.length) + seg('arr', '🛬 Arr', sets.arr.length) +
      '</div>' +
    '</div>' +
    '<div style="margin-bottom:12px">' + _plAptInfoHtml(key) + '</div>' +
  '</div>';
}
// 窄版子頁：某機場的航班清單。釘頂 [← 機場名] + 三段鈕(All/Dep/Arr) + 純清單(上面不放衛星圖 → 不用一直滑)。
function _plOpenPlaceFlights(key, filt) {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  filt = filt || 'all';
  _pl.aptDetailKey = key;
  _pl.aptFlightsFilt = filt;   // 記住在子頁 → 從這裡點航班看明細、返回時回到子頁(不是詳情頁)
  var info = _plAptInfo(key);
  var disp = _plAptFmt(key);
  var sets = _plAptFlightSets(key);
  var flights = (filt === 'dep' ? sets.dep : filt === 'arr' ? sets.arr : sets.all);
  function seg(f, lbl, n) {
    var on = (filt === f);
    return '<button onclick="_plOpenPlaceFlights(\'' + _plJs(key) + '\',\'' + f + '\')" style="flex:1;background:' + (on ? '#3b82f6' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--muted)') + ';border:1px solid ' + (on ? '#3b82f6' : 'var(--border,#334155)') + ';border-radius:6px;padding:7px 4px;font-size:.74em;font-weight:600;cursor:pointer">' + lbl + ' <b>' + n + '</b></button>';
  }
  var rows = flights.length === 0
    ? '<div style="text-align:center;color:var(--muted);padding:24px;font-size:.85em">沒有航班。 · No flights.</div>'
    : flights.map(_plRenderEntryRow).join('');
  c.innerHTML = '<div style="padding:10px 14px">' +
    '<div class="pl-stickhead">' +   // 釘頂:返回鈕+機場名+三段鈕,捲清單時不被推走
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<button onclick="_plOpenPlaceDetail(\'' + _plJs(key) + '\')" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1.05em;font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _plEsc(disp) +
          (info && info.icao && info.iata ? ' <span style="color:var(--muted);font-size:.66em;font-weight:400">' + _plEsc(info.icao) + '</span>' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;padding-bottom:8px">' +
        seg('all', 'All', sets.all.length) + seg('dep', '🛫 Dep', sets.dep.length) + seg('arr', '🛬 Arr', sets.arr.length) +
      '</div>' +
    '</div>' +
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
        // V1.3.27：可編輯既有機尾（之前只能刪掉重建）
        (aircraft ? '<button onclick="_plOpenEditAircraft(\'' + _plEsc(tail) + '\')" style="background:transparent;border:1px solid var(--border,#334155);color:var(--text);border-radius:6px;padding:5px 10px;font-size:.72em;font-weight:600;cursor:pointer;margin-right:8px">✏️ Edit</button>' : '') +
        '<div style="font-size:.72em;color:var(--muted)">' + flights.length + ' flights</div>' +
      '</div>' +
      head +
      rows +
    '</div>';
}

// V1.3.27：編輯既有機尾（純文字欄位）。Tail # 唯讀 —— 改機號會跟既有航班紀錄（tail 是字串快照）對不上，
// 要改機號請刪掉重建。其餘 operator / type / make / model / notes 可改，走 PUT 覆寫（可清空）。
function _plOpenEditAircraft(tail) {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  var ac = null;
  for (var i = 0; i < (_pl.aircraft || []).length; i++) { if (_pl.aircraft[i].tail_no === tail) { ac = _pl.aircraft[i]; break; } }
  if (!ac) { _plToast('找不到這架 · Aircraft not found', 'error'); return; }
  var inCss = 'width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em;box-sizing:border-box';
  function fld(label, id, v, ro) {
    return '<div style="margin-bottom:10px">' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:3px">' + label + '</div>' +
      '<input id="' + id + '" value="' + _plEsc(v || '') + '"' + (ro ? ' readonly' : '') + ' style="' + inCss + (ro ? ';opacity:.55' : '') + '"></div>';
  }
  c.innerHTML =
    '<div style="padding:10px;max-width:520px;margin:0 auto">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<button onclick="_plOpenAircraftDetail(\'' + _plEsc(tail) + '\')" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">✏️ 編輯 Aircraft</div>' +
      '</div>' +
      '<div style="background:var(--card);border-radius:10px;padding:14px">' +
        fld('Tail #（機號 · 不可改，要改請刪掉重建）', 'pl-edit-tail', ac.tail_no, true) +
        fld('Operator（公司）', 'pl-edit-operator', ac.operator) +
        fld('Type Code 機型代碼（例：A359）', 'pl-edit-type', ac.type_code) +
        fld('Manufacturer 廠商', 'pl-edit-make', ac.make) +
        fld('Model 機型', 'pl-edit-model', ac.model) +
        fld('Notes 備註', 'pl-edit-notes', ac.notes) +
        '<div style="display:flex;gap:8px;margin-top:6px">' +
          '<button onclick="_plSubmitEditAircraft(\'' + _plEsc(tail) + '\')" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:.85em;font-weight:700;cursor:pointer">💾 Save</button>' +
          '<button onclick="_plOpenAircraftDetail(\'' + _plEsc(tail) + '\')" style="background:transparent;border:1px solid var(--border,#334155);color:var(--text);border-radius:6px;padding:8px 14px;font-size:.85em;cursor:pointer">Cancel</button>' +
        '</div>' +
        '<div style="font-size:.65em;color:var(--muted);margin-top:8px">空欄位會清掉該欄（跟新增不同，編輯是覆寫）。<br>Blank fields are cleared (edit overwrites, unlike add which merges).</div>' +
      '</div>' +
      '<div id="pl-edit-result" style="margin-top:14px"></div>' +
    '</div>';
}

async function _plSubmitEditAircraft(tail) {
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  var body = {
    operator: val('pl-edit-operator'),
    type_code: val('pl-edit-type'),
    make: val('pl-edit-make'),
    model: val('pl-edit-model'),
    notes: val('pl-edit-notes')
  };
  var resBox = document.getElementById('pl-edit-result');
  try {
    var res = await _plApi('/api/pilot-log/aircraft/' + encodeURIComponent(tail), { method: 'PUT', body: body });
    if (res.ok) {
      _plToast('已更新 ' + tail);
      await _plFetchAll();
      _plOpenAircraftDetail(tail);
      return;
    }
    var ej = await res.json().catch(function() { return {}; });
    if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:8px 10px;border-radius:6px;font-size:.78em">❌ ' + _plEsc(ej.error || ('HTTP ' + res.status)) + '</div>';
  } catch (e) {
    if (resBox) resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:8px 10px;border-radius:6px;font-size:.78em">❌ ' + _plEsc((e && e.message) || 'unknown') + '</div>';
  }
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
        dlField('Tail # *（機號，例：B-58502）', 'pl-add-tail', 'B-58502', '', '_plAddAcTailLookup()') +
        '<div id="pl-add-tw-hint" style="font-size:.7em;margin:-2px 0 10px;min-height:1em"></div>' +
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

// V1.3.35：台灣 6 航司「逐架現役」機隊（user 2026-06-03 提供，截自 xmyzl）。只給選機 picker 用，
// 不參與推算（推算仍走 _PL_TW_REG 範圍，涵蓋退役機）。tail = B-xxxxx 後 5 碼。資料會過時，需可更新。
// 連號區間 → 陣列（給內建機隊用連續機號範圍，省得逐個列、也不易打錯）
function _plSeq(a, b, ex) { var r = []; for (var i = a; i <= b; i++) { if (!ex || ex.indexOf(i) < 0) r.push(i); } return r; }
// 星宇用「已配發機號完整範圍」（含尚未交機的預留號），picker 會標示未交機；其餘航司為現役機。
var _PL_TW_FLEET = [
  // inSvc = 目前已交機的最大機號（含以下為現役、超過為尚未交機的預留號，picker 以虛線標示）
  { op: 'Starlux', type: 'A321neo', code: 'A21N', tails: _plSeq(58201, 58227), inSvc: 58213 },
  { op: 'Starlux', type: 'A330-900', code: 'A339', tails: _plSeq(58301, 58311), inSvc: 58308 },
  { op: 'Starlux', type: 'A350-900', code: 'A359', tails: _plSeq(58501, 58510), inSvc: 58510 },
  { op: 'Starlux', type: 'A350-1000', code: 'A35K', tails: _plSeq(58551, 58568), inSvc: 58552 },
  { op: 'Starlux', type: 'A350F', code: 'A35F', tails: _plSeq(58581, 58590), inSvc: 0 },
  { op: 'EVA Air', type: 'A321-200', code: 'A321', tails: [16208,16209,16211,16212,16213,16215,16216,16217,16218,16219,16220,16221,16222,16223,16225,16226,16227] },
  // 長榮：依民航局「註冊編號法則」完整配發範圍（含尚未交機，picker 標 ⏳）。inSvc = 目前已交最大機號。
  { op: 'EVA Air', type: 'A330-300', code: 'A333', tails: _plSeq(16331, 16340), inSvc: 16340 },
  { op: 'EVA Air', type: 'A350-1000', code: 'A35K', tails: _plSeq(16501, 16527), inSvc: 16500 },
  { op: 'EVA Air', type: 'B777-300ER', code: 'B77W', tails: _plSeq(16701, 16740, [16704, 16714, 16724, 16734]), inSvc: 16740 },
  { op: 'EVA Air', type: 'B777F', code: 'B77F', tails: _plSeq(16781, 16790), inSvc: 16790 },
  { op: 'EVA Air', type: 'B787-9', code: 'B789', tails: _plSeq(17881, 17899), inSvc: 17890 },
  { op: 'EVA Air', type: 'B787-10', code: 'B78X', tails: _plSeq(17801, 17819), inSvc: 17815 },
  { op: 'China Airlines', type: 'A321neo', code: 'A21N', tails: [18101,18102,18103,18105,18106,18107,18108,18109,18110,18111,18112,18115,18116,18117,18118,18120,18121,18122,18123] },
  { op: 'China Airlines', type: 'A330-300', code: 'A333', tails: [18306,18307,18308,18309,18311,18315,18316,18317,18358,18359,18360,18361] },
  { op: 'China Airlines', type: 'A350-900', code: 'A359', tails: [18901,18902,18903,18905,18906,18907,18908,18909,18910,18912,18915,18916,18917,18918,18919,18920] },
  { op: 'China Airlines', type: 'B737-800', code: 'B738', tails: [18651,18652,18660,18661,18662,18663,18665] },
  { op: 'China Airlines', type: 'B747-400F', code: 'B74F', tails: [18717,18718,18719,18720,18721,18722,18723,18725] },
  { op: 'China Airlines', type: 'B777-300ER', code: 'B77W', tails: [18001,18002,18003,18005,18006,18007,18051,18052,18053,18055] },
  { op: 'China Airlines', type: 'B777F', code: 'B77F', tails: [18771,18772,18773,18775,18776,18777,18778,18779,18780,18781] },
  { op: 'Mandarin', type: 'ATR72-600', code: 'AT76', tails: [16855,16856,16857,16858,16859,16860,16861,16862,16863,16865,16866,16867,16868] },
  { op: 'Mandarin', type: 'B737-800', code: 'B738', tails: [18653] },
  { op: 'UNI Air', type: 'ATR72-600', code: 'AT76', tails: [17001,17002,17003,17005,17006,17007,17008,17009,17011,17012,17013,17015,17016,17017] },
  { op: 'Tigerair Taiwan', type: 'A320-200', code: 'A320', tails: [50001,50005,50006,50008,50011,50015,50016,50017,50018] },
  { op: 'Tigerair Taiwan', type: 'A320neo', code: 'A20N', tails: [50021,50022,50023,50025,50026,50027,50028,50029] },
];
function _plFleetMake(type, code) {
  if (/ATR/i.test(type)) return 'ATR';
  if (/^A/.test(type) || /^A/.test(code)) return 'Airbus';
  if (/^B/.test(type) || /^B/.test(code)) return 'Boeing';
  return '';
}
// V1.3.36：fleet picker 公司收合 —— 預設只展開星宇（Starlux），其他公司收合（user 是星宇機師）。
function _plFleetOpCollapsed(op) {
  _pl.fleetCollapsed = _pl.fleetCollapsed || {};
  if (_pl.fleetCollapsed[op] === undefined) return op !== 'Starlux';   // 未設：星宇展開、其他收合
  return _pl.fleetCollapsed[op];
}
function _plToggleFleetOp(op) {
  _pl.fleetCollapsed = _pl.fleetCollapsed || {};
  _pl.fleetCollapsed[op] = !_plFleetOpCollapsed(op);
  _plOpenFleetPicker();
}

// V1.3.35：從台灣機隊挑機 → 一鍵加進自己的機尾庫（依公司 → 機型 → 點機尾）
function _plOpenFleetPicker() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  var have = {}; (_pl.aircraft || []).forEach(function(a) { if (a.tail_no) have[String(a.tail_no).toUpperCase()] = true; });
  var byOp = {}, opOrder = [];
  _PL_TW_FLEET.forEach(function(f) { if (!byOp[f.op]) { byOp[f.op] = []; opOrder.push(f.op); } byOp[f.op].push(f); });
  var body = '';
  opOrder.forEach(function(op) {
    var total = byOp[op].reduce(function(s, f) { return s + f.tails.length; }, 0);
    var opCollapsed = _plFleetOpCollapsed(op);   // V1.3.36：公司可收合，預設只星宇展開
    body += '<div onclick="_plToggleFleetOp(\'' + _plJs(op) + '\')" style="display:flex;align-items:baseline;gap:8px;margin:16px 0 4px;cursor:pointer;user-select:none">' +
      '<span style="font-size:.66em;color:var(--muted);width:14px;display:inline-block;text-align:center">' + (opCollapsed ? '▶' : '▼') + '</span>' +
      '<span style="font-size:.95em;font-weight:800">' + _plEsc(op) + '</span>' +
      '<span style="font-size:.62em;color:var(--muted)">· ' + total + ' 架</span></div>' +
      '<div style="display:' + (opCollapsed ? 'none' : 'block') + '">';
    byOp[op].forEach(function(f) {
      // 機型小標：現役 / 含預留（未交機）數。inSvc 未設 = 全現役。
      var delivered = f.inSvc != null ? f.tails.filter(function(n) { return n <= f.inSvc; }).length : f.tails.length;
      var future = f.tails.length - delivered;
      body += '<div style="font-size:.72em;font-weight:700;color:var(--accent);margin:8px 0 5px">' + _plEsc(f.type) +
        ' <span style="color:var(--muted);font-weight:400">· ' + delivered + ' in svc' + (future > 0 ? ' · ' + future + ' reserved' : '') + '</span></div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px">';
      f.tails.forEach(function(n) {
        var tail = 'B-' + n;
        var isFuture = (f.inSvc != null && n > f.inSvc);   // 尚未交機的預留機號
        if (have[tail.toUpperCase()]) {
          body += '<button onclick="_plUnpickFleetAircraft(\'' + tail + '\')" title="點一下可取消加入（剛加錯、且還沒有航班時）" style="background:#10b981;color:#fff;border:1px solid #10b981;border-radius:6px;padding:6px 9px;font-size:.74em;cursor:pointer">✓ ' + tail + '</button>';
        } else if (isFuture) {
          body += '<button onclick="_plPickFleetAircraft(\'' + tail + '\',\'' + _plJs(f.op) + '\',\'' + _plJs(f.type) + '\',\'' + _plJs(f.code) + '\')" title="尚未交機的預留機號 · Not yet delivered" style="background:transparent;color:var(--muted);border:1px dashed var(--border,#475569);border-radius:6px;padding:6px 9px;font-size:.74em;cursor:pointer">' + tail + '</button>';
        } else {
          body += '<button onclick="_plPickFleetAircraft(\'' + tail + '\',\'' + _plJs(f.op) + '\',\'' + _plJs(f.type) + '\',\'' + _plJs(f.code) + '\')" style="background:var(--card);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:6px 9px;font-size:.74em;cursor:pointer">' + tail + '</button>';
        }
      });
      body += '</div>';
    });
    body += '</div>';   // close per-company collapsible
  });
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div class="pl-stickhead"><div style="display:flex;align-items:center;gap:10px">' +
        '<button onclick="_plOpenAircraft()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">🇹🇼 從機隊挑機 · Pick from fleet</div>' +
      '</div></div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:6px">台灣 6 家機隊。點一架加進你的機尾庫（綠色 ✓ = 已在庫；<b>加錯再點 ✓ 可取消</b>，前提是還沒有航班）。<b>虛線 = 尚未交機的預留機號</b>（清單含未來機，仍可先選入）。退役機不在此清單，可用 + Add Aircraft 手動加。<br>Tap to add; ✓ to remove (no-flights only); dashed = reserved tail not yet delivered.</div>' +
      body +
    '</div>';
}
async function _plPickFleetAircraft(tail, op, type, code) {
  try {
    // codex P1：type_code 要存 ICAO 碼（A359），不是可讀型號（A350-900）—— 跟 LogTen 匯入一致，
    // 才不會破壞 _plLookupTypeFullName / 編輯器 tail 篩選；可讀型號放 model。
    var res = await _plApi('/api/pilot-log/aircraft', { method: 'POST', body: { tail_no: tail, operator: op, type_code: code, make: _plFleetMake(type, code), model: type } });
    if (res.status === 200 || res.status === 201) {
      await _plFetchAll();
      _plToast('已加入 ' + tail);
      _plOpenFleetPicker();   // 重畫，該 tail 變 ✓
      return;
    }
    var ej = await res.json().catch(function() { return {}; });
    _plToast('加入失敗：' + (ej.error || res.status), 'error');
  } catch (e) { _plToast('加入失敗', 'error'); }
}
// V1.3.36：取消加入（剛加錯）。本地先擋有航班的，後端再嚴格擋一次（409）。
async function _plUnpickFleetAircraft(tail) {
  var up = String(tail).toUpperCase();
  var used = (_pl.aircraftEntries || []).some(function(e) {
    return e.tail_no && String(e.tail_no).toUpperCase() === up;
  });
  if (used) { _plToast(tail + ' 已有航班紀錄，不能取消', 'error'); return; }
  if (!confirm(tail + ' 從機尾庫移除？（剛加錯可移除；之後仍可從機隊再加回）')) return;
  try {
    var res = await _plApi('/api/pilot-log/aircraft/' + encodeURIComponent(tail), { method: 'DELETE' });
    if (res.status === 200) {
      await _plFetchAll();
      _plToast('已移除 ' + tail);
      _plOpenFleetPicker();   // 重畫，該 tail 變回可點加入
      return;
    }
    var ej = await res.json().catch(function() { return {}; });
    if (res.status === 409) { _plToast(tail + ' 已有 ' + (ej.flights || '') + ' 筆航班，不能取消', 'error'); return; }
    _plToast('移除失敗：' + (ej.error || res.status), 'error');
  } catch (e) { _plToast('移除失敗', 'error'); }
}

// === SECTION: crew（V1.0.11） ═══════════════════════════════════════════════════
// 列表頁：所有 crew + 一起飛過幾班 → 點某人 → 顯示一起飛過的所有 flight
// drill-down 用名字比對 entry.crew JSONB 內任一欄位（pic / sic / fo1 / fo2 / purser ...）
// 完整 entries 快照沿用 Aircraft 那套（_pl.aircraftEntries），不再開第二份

var _plCrewSearchTerm = '';

async function _plOpenCrew() {
  _pl.aptReturn = false;   // V2.0.01（codex P2）：離開 Airports → 清返回標記
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">載入 crew… · Loading crew…</div>';
  // 同時拉 crew 跟完整 entries（兩者各自獨立、可並行）
  await _plFetchAll(); _pl.aircraftEntries = _pl.entries;   // V2.2.07：_plFetchAll 已用 limit=all 載全本 → 共用，免再抓一次（codex P2 修重複下載）
  _plRenderCrewList();
}

// V2.3：列表組員顯示模式（含 localStorage 離線退路）。cic_only=只機長 / flight=飛航組（排除客艙）/ all=全部。
function _plGetCrewDisplayMode() {
  var m = _pl.crewDisplayMode;
  if (!m) { try { m = localStorage.getItem('pilotlog_crew_display_mode'); } catch (e) {} }
  return (m === 'cic_only' || m === 'flight' || m === 'all') ? m : 'flight';
}
// 從 entry.crew JSONB 收集要顯示的組員名字。mode 省略 → 用使用者偏好；CSV 匯出傳 'all' 強制全收。
function _plEntryCrewNames(e, mode) {
  if (!e || !e.crew || typeof e.crew !== 'object') return [];
  mode = mode || _plGetCrewDisplayMode();
  // V2.3：飛航組擴充到 9 槽（含 Relief/Observer2）；後面接舊 key（相容已匯入的舊資料）。槽值相容字串(舊)與 {name,...}(新)。
  var primary = ['pic', 'crew2', 'crew3', 'crew4', 'crew5', 'crew6', 'cic', 'obs', 'obs2'];  // 飛航組
  var legacy = ['sic', 'fo1', 'fo2', 'purser', 'observer1', 'observer2'];                    // 舊殘留槽：對正式槽去重
  function allowed(k) {
    if (mode === 'cic_only') return k === 'pic';        // 只顯示在隊機長
    if (mode === 'all') return true;                    // 全部（含 cabin1..20）
    return !/^cabin\d+$/.test(k);                       // flight：排除客艙
  }
  var names = [], seenName = {};
  function nm(v) { return _plCrewDisplayName(v); }   // V1.3.14：員編對得到 → 顯示通訊錄名
  // 飛航組：全列（即使兩位不同人剛好同名也都顯示，不誤併 — codex P2）。
  primary.forEach(function(k) { if (!allowed(k)) return; var n = nm(e.crew[k]); if (n) { names.push(n); seenName[n] = 1; } });
  // V1.3.37：舊殘留槽（如 observer2）只在「沒跟正式槽重名」時補。
  legacy.forEach(function(k) { if (!allowed(k)) return; var n = nm(e.crew[k]); if (n && !seenName[n]) { names.push(n); seenName[n] = 1; } });
  // 其他未列名的 key（含 cabin1..20）也補在後面，同樣對已列名字去重。
  Object.keys(e.crew).forEach(function(k) {
    if (primary.indexOf(k) >= 0 || legacy.indexOf(k) >= 0) return;
    if (!allowed(k)) return;
    var n = nm(e.crew[k]); if (n && !seenName[n]) names.push(n);
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
    if (c.is_self) return;                                   // V1.3.14：你不會「跟自己飛」→ 本人不進歸戶索引，不算同事航班數
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
      '<div class="pl-stickhead">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
        '<button onclick="_plRenderMain()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">👥 Crew</div>' +
        '<div style="flex:1"></div>' +
        // V1.3.32：匯出通訊錄 CSV
        '<button onclick="_plExportCrewCsv()" style="background:transparent;color:var(--muted);border:1px solid var(--border,#334155);border-radius:6px;padding:5px 9px;font-size:.72em;cursor:pointer">⬇️ Export</button>' +
        '<div style="font-size:.7em;color:var(--muted)">共 ' + _pl.crew.length + ' 人</div>' +
      '</div>' +
      _plCrewLabelsEditor() +
      _plCrewDisplayModeEditor() +
      '<input id="pl-crew-search" type="search" placeholder="搜尋名字 / ID..." value="' + _plEsc(term) + '" ' +
        'oninput="_plCrewSearchInput(this.value)" ' +
        'style="width:100%;background:var(--bg,#0a0e1a);color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:8px 10px;font-size:.85em;margin-bottom:0;box-sizing:border-box">' +
      '</div>' +   // #4：sticky 收尾移到搜尋框之後 → 標題+欄位名稱+搜尋一起固定
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
      // V1.3.24：本人那列不可點 drill-down（跟自己飛沒意義）→ 但給一顆 ✏️ Edit，讓你能編輯自己
      // （改名 / 補員編）。沒有它的話，本人永遠進不去那個藏在 drill-down 裡的編輯鈕。
      var countCell = p.is_self
        ? '<button type="button" onclick="event.stopPropagation();_plEditCrew(\'' + _plEsc(p.id) + '\')" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 9px;font-size:.72em;font-weight:600;cursor:pointer;white-space:nowrap" title="編輯本人 Edit yourself">✏️ Edit</button>'
        : unattrib
        ? '<div style="font-size:.72em;color:var(--muted);text-align:right" title="同名且無員編，無法計數">—</div>'
        : '<div style="font-size:.72em;color:var(--text);text-align:right">' + (countById[p.id] || 0) + ' flights</div>';
      // V1.3.14（codex P3）：本人不進歸戶索引 → drill-down 會是空的，所以本人這列不可點（跟自己飛沒意義）。
      var clickAttr = p.is_self ? '' : 'onclick="_plOpenCrewDetail(\'' + _plEsc(p.id) + '\')" ';
      var cursorCss = p.is_self ? 'cursor:default' : 'cursor:pointer';
      rows += '<div ' + clickAttr +
        'style="background:var(--card);border-radius:8px;padding:10px 12px;margin-bottom:6px;' + cursorCss + ';display:flex;gap:10px;align-items:center">' +
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
        '<button onclick="_plEditCrew(\'' + _plEsc(person.id) + '\')" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 9px;font-size:.76em;font-weight:600;cursor:pointer;margin-left:8px">✏️ Edit</button>' +
      '</div>' +
      head +
      bodyHtml +
    '</div>';
}

// V1.3.14：直接編輯 crew —— 點名單→詳情→✏️ Edit，不用再繞去別處找人改。
function _plEditCrew(crewId) {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  var person = null;
  for (var i = 0; i < _pl.crew.length; i++) { if (_pl.crew[i].id === crewId) { person = _pl.crew[i]; break; } }
  if (!person) { _plOpenCrew(); return; }
  var ids = Array.isArray(person.employee_ids) ? person.employee_ids.join(', ') : '';
  var inCss = 'width:100%;background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:.95em;-webkit-appearance:none;box-sizing:border-box';
  var lblCss = 'display:block;font-size:.8em;color:var(--muted);font-weight:600;margin:12px 0 5px';
  c.innerHTML =
    '<div style="padding:12px 14px;max-width:460px;margin:0 auto">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
        '<button onclick="_plOpenCrewDetail(\'' + _plEsc(crewId) + '\')" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">✏️ 編輯 Crew</div>' +
      '</div>' +
      '<label style="' + lblCss + '">名字 Name</label>' +
      '<input id="plce-name" type="text" style="' + inCss + '" value="' + _plEsc(person.display_name || '') + '">' +
      '<label style="' + lblCss + '">員編 Employee ID（多個用逗號分隔）</label>' +
      '<input id="plce-ids" type="text" style="' + inCss + '" value="' + _plEsc(ids) + '" placeholder="例如 79363, B12345">' +
      '<label style="' + lblCss + '">公司 Organization</label>' +
      '<input id="plce-org" type="text" style="' + inCss + '" value="' + _plEsc(person.organization || '') + '">' +
      '<label style="' + lblCss + '">註記 Comment</label>' +
      '<input id="plce-comment" type="text" style="' + inCss + '" value="' + _plEsc(person.comment || '') + '">' +
      '<div style="display:flex;gap:10px;margin-top:18px">' +
        '<button onclick="_plSaveCrewEdit(\'' + _plEsc(crewId) + '\')" style="flex:1;background:#10b981;color:#fff;border:0;border-radius:8px;padding:11px;font-size:.9em;font-weight:700;cursor:pointer">💾 儲存 Save</button>' +
        '<button onclick="_plOpenCrewDetail(\'' + _plEsc(crewId) + '\')" style="flex:0 0 auto;background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:8px;padding:11px 16px;font-size:.9em;cursor:pointer">取消</button>' +
      '</div>' +
      '<div style="border-top:1px solid var(--border);margin:22px 0 0;padding-top:14px">' +
        '<button onclick="_plDeleteCrew(\'' + _plEsc(crewId) + '\')" style="background:transparent;color:#ef4444;border:1px solid rgba(239,68,68,.4);border-radius:8px;padding:9px 14px;font-size:.82em;font-weight:700;cursor:pointer">🗑️ 刪除這個 crew</button>' +
        '<div style="font-size:.7em;color:var(--muted);margin-top:6px">刪除只移除通訊錄聯絡人，不影響你的航班紀錄。<br>Deleting removes the contact only; your flight records are untouched.</div>' +
      '</div>' +
    '</div>';
}

// 重新拉 crew 名單到 _pl.crew（編輯 / 刪除後即時反映；換新陣列參照會讓員編索引快取自動重建）
async function _plReloadCrew() {
  try {
    var r = await _plApi('/api/pilot-log/crew');
    if (r.ok) { var j = await r.json(); _pl.crew = j.crew || []; try { _plIDBSet('crew', _pl.crew); } catch (e) {} }
  } catch (e) {}
}

async function _plSaveCrewEdit(crewId) {
  var nameEl = document.getElementById('plce-name');
  var name = nameEl ? (nameEl.value || '').trim() : '';
  if (!name) { _plToast('名字不能空白 · Name required', 'error'); return; }
  var idsRaw = (document.getElementById('plce-ids').value || '');
  var body = {
    display_name: name,
    employee_ids: idsRaw.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean),
    organization: (document.getElementById('plce-org').value || '').trim(),
    comment: (document.getElementById('plce-comment').value || '').trim()
  };
  var r;
  try { r = await _plApi('/api/pilot-log/crew/' + encodeURIComponent(crewId), { method: 'PUT', body: body }); }
  catch (e) { _plToast('儲存失敗 · Save failed', 'error'); return; }
  if (!r.ok) { _plToast('儲存失敗 · Save failed', 'error'); return; }
  var j = await r.json().catch(function () { return {}; });
  await _plReloadCrew();
  _plOpenCrewDetail(crewId);
  if (j.skipped && j.skipped.length) {
    _plToast('已存；這些員編已掛在別人身上、略過：' + j.skipped.join(', '), 'error');
  } else {
    _plToast('已更新 · Updated');
  }
}

async function _plDeleteCrew(crewId) {
  if (!confirm('確定刪除這個 crew？只移除通訊錄聯絡人，不影響航班紀錄。')) return;
  var r;
  try { r = await _plApi('/api/pilot-log/crew/' + encodeURIComponent(crewId), { method: 'DELETE' }); }
  catch (e) { _plToast('刪除失敗 · Delete failed', 'error'); return; }
  if (r.status === 400) { _plToast('本人聯絡人不能刪除 · Cannot delete your own contact', 'error'); return; }
  if (!r.ok) { _plToast('刪除失敗 · Delete failed', 'error'); return; }
  await _plReloadCrew();
  _plToast('已刪除 · Deleted');
  _plOpenCrew();
}

// V1.3.15：航班編輯器 crew 格 → ✏️ 直接改那個聯絡人（彈窗，不離開航班）。
// 用員編找聯絡人；員編對不到再用「唯一同名」回查；都查不到 → 提示（還沒進通訊錄）。
function _plCrewByEid(eid) {
  var e = String(eid == null ? '' : eid).trim();
  if (!e) return null;
  var list = _pl.crew || [];
  for (var i = 0; i < list.length; i++) {
    var ids = list[i].employee_ids || [];
    for (var j = 0; j < ids.length; j++) {
      if (String(ids[j] == null ? '' : ids[j]).trim() === e) return list[i];
    }
  }
  return null;
}

function _plQuickEditCrewSlot(key) {
  var eidEl = document.getElementById('ple-crewid-' + key);
  var nameEl = document.getElementById('ple-crew-' + key);
  var eid = eidEl ? (eidEl.value || '').trim() : '';
  var name = nameEl ? (nameEl.value || '').trim() : '';
  if (!name) { _plToast('先填名字 · Enter a name first', 'error'); return; }
  var contact = _plCrewByEid(eid);
  if (!contact && name) {
    var matches = (_pl.crew || []).filter(function(c) { return (c.display_name || '').trim() === name; });
    if (matches.length === 1) contact = matches[0];
    else if (matches.length > 1) { _plToast('同名多人，請先補員編再編輯 · Same name, add an id first', 'error'); return; }
  }
  // V1.3.24：通訊錄已有 → 編輯；還沒有（手填的新人）→ 跳「新增聯絡人」直接建進通訊錄並掛上，不再擋
  if (contact) _plOpenCrewModal(contact, key);
  else _plOpenCrewModal(null, key, name);
}

function _plCloseCrewModal() { var m = document.getElementById('pl-crew-modal'); if (m) m.remove(); }

// contact 為 null → 新增模式（prefillName 帶入手填的名字）；否則編輯既有聯絡人
function _plOpenCrewModal(contact, slotKey, prefillName) {
  _plCloseCrewModal();
  var isNew = !contact;
  var ids = (contact && Array.isArray(contact.employee_ids)) ? contact.employee_ids.join(', ') : '';
  var nameVal = isNew ? (prefillName || '') : (contact.display_name || '');
  var orgVal = isNew ? '' : (contact.organization || '');      // V1.3.27：跟通訊錄編輯一致（公司 / 註記）
  var commentVal = isNew ? '' : (contact.comment || '');
  var inCss = 'width:100%;background:var(--input-bg,#0a0e1a);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:.95em;-webkit-appearance:none;box-sizing:border-box';
  var lblCss = 'display:block;font-size:.78em;color:var(--muted);font-weight:600;margin:12px 0 5px';
  var wrap = document.createElement('div');
  wrap.id = 'pl-crew-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:400;display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.onclick = function(ev) { if (ev.target === wrap) _plCloseCrewModal(); };
  var saveOnclick = isNew
    ? '_plQuickCreateCrew(\'' + slotKey + '\')'
    : '_plQuickSaveCrew(\'' + _plEsc(contact.id) + '\',\'' + slotKey + '\')';
  wrap.innerHTML =
    '<div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;max-width:380px;width:100%">' +
      '<div style="font-weight:700;margin-bottom:4px">' + (isNew ? '➕ 新增聯絡人 · Add contact' : '✏️ 編輯聯絡人 · Edit contact') + '</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px">' + (isNew ? '把手填的這個人建進通訊錄並掛到這格，之後可重複選用。' : '改完所有航班顯示的這個人一起更新。') + '</div>' +
      '<label style="' + lblCss + '">名字 Name</label>' +
      '<input id="plqe-name" type="text" style="' + inCss + '" value="' + _plEsc(nameVal) + '">' +
      '<label style="' + lblCss + '">員編 Employee ID（多個用逗號分隔）</label>' +
      '<input id="plqe-ids" type="text" style="' + inCss + '" value="' + _plEsc(ids) + '" placeholder="例如 79363, B12345">' +
      '<label style="' + lblCss + '">公司 Organization</label>' +
      '<input id="plqe-org" type="text" style="' + inCss + '" value="' + _plEsc(orgVal) + '">' +
      '<label style="' + lblCss + '">註記 Comment</label>' +
      '<input id="plqe-comment" type="text" style="' + inCss + '" value="' + _plEsc(commentVal) + '">' +
      '<div style="display:flex;gap:10px;margin-top:18px">' +
        '<button type="button" onclick="' + saveOnclick + '" style="flex:1;background:#10b981;color:#fff;border:0;border-radius:8px;padding:11px;font-size:.9em;font-weight:700;cursor:pointer">💾 儲存 Save</button>' +
        '<button type="button" onclick="_plCloseCrewModal()" style="flex:0 0 auto;background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:8px;padding:11px 16px;font-size:.9em;cursor:pointer">取消</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  var f = document.getElementById('plqe-name'); if (f) f.focus();
}

// V1.3.24：新增聯絡人（手填組員 → 建進通訊錄並掛回該格）
async function _plQuickCreateCrew(slotKey) {
  var name = (document.getElementById('plqe-name').value || '').trim();
  if (!name) { _plToast('名字不能空白 · Name required', 'error'); return; }
  var idsRaw = (document.getElementById('plqe-ids').value || '');
  var newIds = idsRaw.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  var org = (document.getElementById('plqe-org').value || '').trim();
  var comment = (document.getElementById('plqe-comment').value || '').trim();
  var r;
  try { r = await _plApi('/api/pilot-log/crew', { method: 'POST', body: { display_name: name, employee_ids: newIds, organization: org, comment: comment } }); }
  catch (e) { _plToast('新增失敗 · Add failed', 'error'); return; }
  if (!r.ok) { _plToast('新增失敗 · Add failed', 'error'); return; }
  var j = await r.json().catch(function () { return {}; });
  await _plReloadCrew();
  // 回填這一格：名字 + 主要員編。codex P2：被 server 略過的員編（已掛別人）不能塞進這格，
  // 否則會把這趟誤掛到別人 / 觸發 SAME-NAME。只用「真的存進這位新聯絡人」的員編。
  var skipped = j.skipped || [];
  var accepted = newIds.filter(function (id) { return skipped.indexOf(id) < 0; });
  var newEid = accepted[0] || '';
  var sName = document.getElementById('ple-crew-' + slotKey); if (sName) sName.value = name;
  var sId = document.getElementById('ple-crewid-' + slotKey); if (sId) sId.value = newEid;
  var sName0 = document.getElementById('ple-crewname0-' + slotKey); if (sName0) sName0.value = name;
  _plCrewSlotInput(slotKey);   // 確保 ✏️ 仍顯示
  _plCloseCrewModal();
  if (j.skipped && j.skipped.length) _plToast('已新增；這些員編已掛別人、略過：' + j.skipped.join(', '), 'error');
  else _plToast('已加入通訊錄 · Added');
}

async function _plQuickSaveCrew(contactId, slotKey) {
  var name = (document.getElementById('plqe-name').value || '').trim();
  if (!name) { _plToast('名字不能空白 · Name required', 'error'); return; }
  var idsRaw = (document.getElementById('plqe-ids').value || '');
  var newIds = idsRaw.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  // V1.3.27：公司 / 註記改成讀彈窗欄位（跟通訊錄編輯一致），不再只沿用舊值
  var body = {
    display_name: name,
    employee_ids: newIds,
    organization: (document.getElementById('plqe-org').value || '').trim(),
    comment: (document.getElementById('plqe-comment').value || '').trim()
  };
  var r;
  try { r = await _plApi('/api/pilot-log/crew/' + encodeURIComponent(contactId), { method: 'PUT', body: body }); }
  catch (e) { _plToast('儲存失敗 · Save failed', 'error'); return; }
  if (!r.ok) { _plToast('儲存失敗 · Save failed', 'error'); return; }
  var j = await r.json().catch(function () { return {}; });
  await _plReloadCrew();
  // 回填航班編輯器這一格：名字 + 員編（原員編還在就留，否則用新主要員編）+ 同步 name0 防存檔誤判改名
  var origEid = (document.getElementById('ple-crewid-' + slotKey) || {}).value || '';
  var newEid = newIds.indexOf(origEid) >= 0 ? origEid : (newIds[0] || '');
  var sName = document.getElementById('ple-crew-' + slotKey); if (sName) sName.value = name;
  var sId = document.getElementById('ple-crewid-' + slotKey); if (sId) sId.value = newEid;
  var sName0 = document.getElementById('ple-crewname0-' + slotKey); if (sName0) sName0.value = name;
  _plCloseCrewModal();
  if (j.skipped && j.skipped.length) _plToast('已存；這些員編已掛在別人身上、略過：' + j.skipped.join(', '), 'error');
  else _plToast('已更新 · Updated');
}

// === SECTION: analyze（純統計 + 圖表）═══════════════════════════════════════
// 統計卡片沿用 _plRenderStats()；圖表用純 CSS bar（不引 chart library，離線可用、
// 顏色走 var()/固定 accent 兩主題都讀得清楚，切日夜不必重畫）。

async function _plRenderAnalyze() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  _pl.aptReturn = false;   // V1.3.39：切到 Analyze → 清 Airports 返回標記
  if (!_pl.user) { _plRenderLogin(); return; }
  _plShowTabBar(true);
  _plHighlightTab('analyze');
  c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">Loading stats…</div>';
  await _plFetchAll(); _pl.aircraftEntries = _pl.entries;   // V2.2.07：_plFetchAll 已用 limit=all 載全本 → 共用，免再抓一次（codex P2 修重複下載）
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
    m.sic += (e.sic_minutes != null) ? e.sic_minutes : (_plIsSicPos(e.position) ? (e.block_minutes || 0) : 0);
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

function _plBreakdownTable(title, firstCol, entries, keyFn, rowClickFn) {
  if (!entries.length) return '';
  var agg = _plBreakdownAgg(entries, keyFn);
  var th = function(t) { return '<th style="text-align:right;padding:5px 8px;font-weight:700;color:var(--muted);white-space:nowrap">' + t + '</th>'; };
  var head = '<tr><th style="text-align:left;padding:5px 8px;color:var(--muted)">' + firstCol + '</th>' +
    th('Flt') + th('Block') + th('PIC') + th('PIC&nbsp;Sec') + th('SIC') + th('Night') + th('T/O') + th('Ldg') + '</tr>';
  var tdN = function(v) { return '<td style="text-align:right;padding:5px 8px;font-variant-numeric:tabular-nums;white-space:nowrap">' + v + '</td>'; };
  var rowHtml = function(label, r, extra, clickable) {
    var onclick = (clickable && rowClickFn) ? rowClickFn(label) : null;
    return '<tr style="' + extra + (onclick ? ';cursor:pointer' : '') + '"' + (onclick ? ' onclick="' + _plEsc(onclick) + '"' : '') + '>' +
      '<td style="text-align:left;padding:5px 8px;font-weight:700;white-space:nowrap">' + (onclick ? '<span style="color:var(--accent)">▸</span> ' : '') + _plEsc(label) + '</td>' +
      tdN(r.flights) + tdN(_plMinToHHMM(r.block)) + tdN(_plMinToHHMM(r.pic)) + tdN(r.picSec) +
      tdN(_plMinToHHMM(r.sic)) + tdN(_plMinToHHMM(r.night)) + tdN(r.to) + tdN(r.ldg) + '</tr>';
  };
  var body = agg.rows.map(function(r) { return rowHtml(r.key, r, 'border-top:1px solid var(--border)', true); }).join('');
  var totalRow = rowHtml('Total', agg.tot, 'border-top:2px solid var(--border);font-weight:700', false);
  return '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:14px;margin-bottom:10px">' +
    '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">' + title + '</div>' +
    '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">' +
      '<table style="width:100%;border-collapse:collapse;font-size:.76em">' +
        '<thead>' + head + '</thead><tbody>' + body + totalRow + '</tbody></table>' +
    '</div></div>';
}

// V1.3.17：起始累計（已含進總時數）+ 模擬機（不計入飛行時數）兩區塊
function _plRenderOpeningSim() {
  var s = _pl.stats || {};
  var ob = s.opening || [];
  var sim = s.sim || {};
  var out = '';
  if (ob.length) {
    var rows = ob.map(function(o) {
      return '<tr><td style="text-align:left;padding:4px 6px">' + _plEsc(o.aircraft_type) + '</td>' +
        '<td style="text-align:right;padding:4px 6px;font-variant-numeric:tabular-nums">' + _plMinToHHMM(o.total_minutes) + '</td>' +
        '<td style="text-align:right;padding:4px 6px;font-variant-numeric:tabular-nums">' + _plMinToHHMM(o.pic_minutes) + '</td>' +
        '<td style="text-align:right;padding:4px 6px;font-variant-numeric:tabular-nums">' + _plMinToHHMM(o.sic_minutes) + '</td></tr>';
    }).join('');
    out += '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:14px;margin-bottom:10px">' +
      '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">起始累計 · Brought Forward（已含進總時數）</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:.82em">' +
      '<tr style="color:var(--muted);font-size:.85em"><th style="text-align:left;padding:4px 6px">Type</th><th style="text-align:right;padding:4px 6px">Total</th><th style="text-align:right;padding:4px 6px">PIC</th><th style="text-align:right;padding:4px 6px">SIC</th></tr>' +
      rows + '</table></div>';
  }
  if (sim.sim_minutes) {
    out += '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:14px;margin-bottom:10px">' +
      '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">模擬機 · Simulator（不計入飛行時數）</div>' +
      '<div style="font-size:1.1em;font-weight:800">' + _plMinToHHMM(sim.sim_minutes) +
      ' <span style="font-size:.6em;color:var(--muted);font-weight:600">· ' + (sim.sim_count || 0) + ' sessions</span></div></div>';
  }
  return out;
}

function _plRenderTypeBreakdown(entries) {
  return _plBreakdownTable('依機型明細 By Type（點機型看各公司 PIC/SIC）', 'Type', entries, function(e) { return e.aircraft_type || '—'; }, function(type) {
    return (type && type !== '—') ? "_plOpenTypeDetail('" + String(type).replace(/'/g, "\\'") + "')" : null;
  });
}
// V1.3.21：點機型 → 鑽進去看「該機型各公司」的 PIC/SIC 時數
function _plOpenTypeDetail(type) {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (_pl.tab !== 'analyze') return;
  var entries = (_pl.aircraftEntries || []).filter(function(e) {
    if (e.is_deadhead || e.is_sim || e.status === 'roster_removed') return false;
    return !!e.in_utc && (e.aircraft_type || '—') === type;
  });
  var sorted = entries.slice().sort(function(a, b) { return String(b.flight_date || '').localeCompare(String(a.flight_date || '')); });
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<button onclick="_plRenderAnalyze()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">' + _plEsc(type) + '</div>' +
        '<div style="flex:1"></div>' +
        '<div style="font-size:.72em;color:var(--muted)">' + entries.length + ' flights</div>' +
      '</div>' +
      (entries.length
        ? _plBreakdownTable(_plEsc(type) + ' · 依公司 By Company（含 PIC / SIC 時數）', 'Company', entries, _plEntryCompany) +
          '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px">航班 · Flights（' + entries.length + '）</div>' +
          sorted.map(_plRenderEntryRow).join('')
        : '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">這個機型沒有已飛紀錄。</div>') +
    '</div>';
}

// V1.3.15：台灣商用機籍「註冊範圍 → 公司 + 機型」對照（來源：各家維基「註冊編號法則」，源頭民航局）。
// 用數字範圍精準比對（B-xxxxx 取後 5 碼），範圍互不重疊（B-162/163/165/167=長榮、B-168=華信、
// B-170=立榮、B-178=長榮787），解 B-16xxx / B-17xxx 多家共用。新交機 / 退役時更新這份。
// 每筆多帶 c = ICAO 機型代碼，給 Add Aircraft 連動廠商/機型下拉用（型錄查得到 → 直接選；
// 貨機等型錄沒有的代碼 → 走自訂帶入）。
var _PL_TW_REG = [
  // 星宇 Starlux
  { op: 'Starlux', s: 58201, e: 58227, t: 'A321neo', c: 'A21N' },
  { op: 'Starlux', s: 58301, e: 58311, t: 'A330neo', c: 'A339' },
  { op: 'Starlux', s: 58501, e: 58510, t: 'A350-900', c: 'A359' },
  { op: 'Starlux', s: 58551, e: 58568, t: 'A350-1000', c: 'A35K' },
  { op: 'Starlux', s: 58581, e: 58590, t: 'A350F', c: 'A35F' },
  // 長榮 EVA Air
  // 退役機種（V2.3.03）：對照表原本只建現役範圍，飛過退役機的 logbook 推不出公司（A332 798h 歸「—」實案）。
  // 範圍出處：airfleets/planespotters/airliners.net 交叉驗證，MD-11 客貨混列、747 客/Combi/貨分段。
  { op: 'EVA Air', s: 16101, e: 16113, t: 'MD-11', c: 'MD11' },
  { op: 'EVA Air', s: 16301, e: 16312, t: 'A330-200', c: 'A332' },
  { op: 'EVA Air', s: 16401, e: 16412, t: '747-400', c: 'B744' },
  { op: 'EVA Air', s: 16461, e: 16465, t: '747-400M', c: 'B744' },
  { op: 'EVA Air', s: 16481, e: 16483, t: '747-400F', c: 'B74F' },
  { op: 'EVA Air', s: 16601, e: 16605, t: '767-300ER', c: 'B763' },
  { op: 'EVA Air', s: 16621, e: 16622, t: '767-200', c: 'B762' },
  { op: 'EVA Air', s: 16200, e: 16299, t: 'A321neo', c: 'A21N' },
  { op: 'EVA Air', s: 16331, e: 16340, t: 'A330-300', c: 'A333' },
  { op: 'EVA Air', s: 16501, e: 16527, t: 'A350-1000', c: 'A35K' },
  { op: 'EVA Air', s: 16701, e: 16740, t: '777-300ER', c: 'B77W' },
  { op: 'EVA Air', s: 16781, e: 16790, t: '777F', c: 'B77F' },
  { op: 'EVA Air', s: 17801, e: 17819, t: '787-10', c: 'B78X' },
  { op: 'EVA Air', s: 17881, e: 17899, t: '787-9', c: 'B789' },
  // 華航 China Airlines
  { op: 'China Airlines', s: 18001, e: 18007, t: '777-300ER', c: 'B77W' },
  { op: 'China Airlines', s: 18051, e: 18055, t: '777-300ER', c: 'B77W' },
  { op: 'China Airlines', s: 18031, e: 18050, t: '777-9', c: 'B779' },
  { op: 'China Airlines', s: 18101, e: 18136, t: 'A321neo', c: 'A21N' },
  { op: 'China Airlines', s: 18306, e: 18317, t: 'A330-300', c: 'A333' },
  { op: 'China Airlines', s: 18358, e: 18361, t: 'A330-300', c: 'A333' },
  { op: 'China Airlines', s: 18651, e: 18653, t: '737-800', c: 'B738' },
  { op: 'China Airlines', s: 18660, e: 18665, t: '737-800', c: 'B738' },
  { op: 'China Airlines', s: 18717, e: 18725, t: '747-400F', c: 'B74F' },
  { op: 'China Airlines', s: 18771, e: 18786, t: '777-200F', c: 'B77F' },
  { op: 'China Airlines', s: 18787, e: 18795, t: '777-8F', c: 'B778' },
  { op: 'China Airlines', s: 18811, e: 18832, t: '787-9', c: 'B789' },
  { op: 'China Airlines', s: 18901, e: 18930, t: 'A350-900', c: 'A359' },
  { op: 'China Airlines', s: 18931, e: 18950, t: 'A350-1000', c: 'A35K' },
  // 立榮 UNI Air
  { op: 'UNI Air', s: 17001, e: 17017, t: 'ATR 72-600', c: 'AT76' },
  // 華信 Mandarin
  { op: 'Mandarin', s: 16821, e: 16829, t: 'E190', c: 'E190' },
  { op: 'Mandarin', s: 16851, e: 16868, t: 'ATR 72-600', c: 'AT76' },
  // 虎航 Tigerair Taiwan
  { op: 'Tigerair Taiwan', s: 50001, e: 50018, t: 'A320', c: 'A320' },
  { op: 'Tigerair Taiwan', s: 50021, e: 50037, t: 'A320neo', c: 'A20N' },
  { op: 'Tigerair Taiwan', s: 50051, e: 50067, t: 'A321neo', c: 'A21N' },
];
// tail（B-xxxxx）→ { operator, type, code }；查不到回 null（不亂猜）
function _plTailLookup(tail) {
  var m = String(tail == null ? '' : tail).toUpperCase().replace(/\s/g, '').match(/^B-?(\d{5})$/);
  if (!m) return null;
  var n = parseInt(m[1], 10);
  for (var i = 0; i < _PL_TW_REG.length; i++) {
    var r = _PL_TW_REG[i];
    if (n >= r.s && n <= r.e) return { operator: r.op, type: r.t, code: r.c };
  }
  return null;
}
// ICAO 代碼 → 型錄 { make, model }；查不到回 null（貨機等不在型錄內）
function _plAcFindByCode(code) {
  var c = String(code || '').toUpperCase();
  if (!c) return null;
  var cat = _plAcMergedCatalog(), found = null;
  Object.keys(cat).forEach(function(mk) {
    cat[mk].forEach(function(r) { if (String(r[0]).toUpperCase() === c) found = { make: mk, model: r[1] }; });
  });
  return found;
}
// 機型字串 → 廠商（型錄沒對到代碼時的 fallback）
function _plMakeFromType(t) {
  var s = String(t || '').toUpperCase().replace(/[\s-]/g, '');
  if (s.indexOf('ATR') === 0) return 'ATR';
  if (s.charAt(0) === 'A') return 'Airbus';
  if (s.charAt(0) === '7' || s.charAt(0) === 'B') return 'Boeing';
  if (s.charAt(0) === 'E') return 'Embraer';
  return '';
}

// V1.3.15：Add Aircraft 打 tail → 自動帶公司（空白時才帶，不覆蓋手填）+ 顯示偵測到的公司/機型。
function _plAddAcTailLookup() {
  var tailEl = document.getElementById('pl-add-tail');
  var hintEl = document.getElementById('pl-add-tw-hint');
  var look = _plTailLookup(tailEl ? tailEl.value : '');
  if (!look) { if (hintEl) hintEl.innerHTML = ''; return; }
  var opEl = document.getElementById('pl-add-operator');
  if (opEl && !opEl.value.trim()) opEl.value = look.operator;
  _plAddAcAutofillType(look);   // 連帶把廠商 + 機型下拉也選好
  if (hintEl) hintEl.innerHTML = '<span style="color:#10b981">✓ 台灣機籍：<b>' + _plEsc(look.operator) + '</b> · ' + _plEsc(look.type) + '（公司 / 機型已自動帶入）</span>';
}

// 偵測到 tail → 連動 Add Aircraft 的廠商 + 機型下拉（使用者已自選廠商則不覆蓋）。
function _plAddAcAutofillType(look) {
  var makeSel = document.getElementById('pl-add-make');
  if (!makeSel) return;
  // codex P2：使用者手選過廠商（且不是我們上次自動填的那個）→ 不覆蓋；空的或自動填的 → 可重帶（改 tail）。
  if (makeSel.value && makeSel.value !== window._plAcAutofilledMake) return;
  var hit = _plAcFindByCode(look.code);
  var make = hit ? hit.make : _plMakeFromType(look.type);
  if (!make) return;
  var hasMake = false;
  for (var i = 0; i < makeSel.options.length; i++) { if (makeSel.options[i].value === make) { hasMake = true; break; } }
  if (!hasMake) return;
  makeSel.value = make;
  window._plAcAutofilledMake = make;   // 記下這是自動填的，改 tail 時才能再覆蓋
  _plAddAcMakeChange();   // 重建該廠商的 model select
  var modelSel = document.getElementById('pl-add-model');
  if (!modelSel) return;
  if (hit) {
    modelSel.value = hit.model;   // 型錄有 → 直接選（type code 存檔時 derive）
  } else {
    // 型錄沒有（貨機等）→ Other + 自填機型 + type code
    modelSel.value = '__other__';
    _plAddAcModelChange();
    var mc = document.getElementById('pl-add-model-custom'); if (mc) mc.value = look.type;
    var tc = document.getElementById('pl-add-type'); if (tc && look.code) tc.value = look.code;
  }
}

// 依公司（operator）分析：先用機尾庫 _pl.aircraft 的 operator；沒填 → V1.3.15 用台灣機籍 tail 範圍推。
// V1.3.21：entry → 公司（機尾庫 operator 優先；沒填用台灣機籍 tail 範圍推）。_pl.aircraft 換新才重建快取。
// V2.3.06：沒機尾（或機尾推不出）時，用「班號字頭」推公司 —— LogTen Smart Group 用文字搜尋撈得到、
// 我們靠機尾推不到的那幾班（連機尾都沒有），至少公司先歸對，不會掉出公司統計。
var _PL_FLTNO_OP = { JX: 'Starlux', BR: 'EVA Air', CI: 'China Airlines', AE: 'Mandarin', B7: 'UNI Air', IT: 'Tigerair Taiwan' };
function _plCompanyFromFlightNo(fno) {
  var m = String(fno == null ? '' : fno).trim().toUpperCase().match(/^([A-Z][A-Z0-9])\s*\d/);
  return (m && _PL_FLTNO_OP[m[1]]) || '';
}
function _plEntryCompany(e) {
  // V2.3.03：機尾正規化去 dash/空白再比 —— entry 寫 B16701、機隊庫寫 B-16701 也要對得起來
  var norm = function(t) { return String(t == null ? '' : t).toUpperCase().replace(/[-\s]/g, ''); };
  var tail = norm((e && e.tail_no));
  if (!tail) return _plCompanyFromFlightNo(e && e.flight_no) || '—';
  if (_pl._opMapSrc !== _pl.aircraft) {
    var m = {}; (_pl.aircraft || []).forEach(function(a) { if (a.tail_no) m[norm(a.tail_no)] = a.operator || ''; });
    _pl._opMap = m; _pl._opMapSrc = _pl.aircraft;
  }
  var o = _pl._opMap[tail];
  if (!o) { var look = _plTailLookup(tail); if (look) o = look.operator; }
  return o || _plCompanyFromFlightNo(e && e.flight_no) || '—';
}
function _plRenderCompanyBreakdown(entries) {
  return _plBreakdownTable('依公司明細 By Company（點公司看各機型 PIC/SIC）', 'Company', entries, _plEntryCompany, function(company) {
    return (company && company !== '—') ? "_plOpenCompanyDetail('" + String(company).replace(/'/g, "\\'") + "')" : null;
  });
}
// V1.3.21：點公司 → 鑽進去看「該公司各機型」的 PIC/SIC 時數（重用 By Type 表）
function _plOpenCompanyDetail(company) {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (_pl.tab !== 'analyze') return;
  var entries = (_pl.aircraftEntries || []).filter(function(e) {
    if (e.is_deadhead || e.is_sim || e.status === 'roster_removed') return false;
    return !!e.in_utc && _plEntryCompany(e) === company;
  });
  var sorted = entries.slice().sort(function(a, b) { return String(b.flight_date || '').localeCompare(String(a.flight_date || '')); });
  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<button onclick="_plRenderAnalyze()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
        '<div style="font-size:1em;font-weight:700">' + _plEsc(company) + '</div>' +
        '<div style="flex:1"></div>' +
        '<div style="font-size:.72em;color:var(--muted)">' + entries.length + ' flights</div>' +
      '</div>' +
      (entries.length
        ? _plBreakdownTable(_plEsc(company) + ' · 依機型 By Type（含 PIC / SIC 時數）', 'Type', entries, function(e) { return e.aircraft_type || '—'; }) +
          '<div style="font-size:.72em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px">航班 · Flights（' + entries.length + '）</div>' +
          sorted.map(_plRenderEntryRow).join('')
        : '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">這家公司沒有已飛紀錄。<br>No flown records for this company.</div>') +
    '</div>';
}

// ── V1.3.29：LogTen 風兩欄 Analyze ──────────────────────────────────────────
// 左欄選「組」（時間區間 / 公司 / 機型），右欄顯示該組彩色比例橫條 + 依機型(或依公司)卡片。
// iPad 兩欄、iPhone 由上至下堆疊。資料用已飛 entries（in_utc、非 deadhead/removed）。
function _plDaysAgoStr(n) {
  var d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function _plAnSum(entries) {
  var s = { flights: 0, block: 0, air: 0, night: 0, pic: 0, sic: 0,
            dist: 0, dayTO: 0, nightTO: 0, dayLdg: 0, nightLdg: 0, autoland: 0, appr: 0, pax: 0, duty: 0 };
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    s.flights++;
    s.block += e.block_minutes || 0;
    s.air += e.air_minutes || 0;
    s.night += e.night_minutes || 0;
    s.pic += (e.pic_minutes != null) ? e.pic_minutes : (e.position === 'PIC' ? (e.block_minutes || 0) : 0);
    s.sic += (e.sic_minutes != null) ? e.sic_minutes : (_plIsSicPos(e.position) ? (e.block_minutes || 0) : 0);
    s.dist += Number(e.distance_nm) || 0;
    s.dayTO += e.day_takeoffs || 0; s.nightTO += e.night_takeoffs || 0;
    s.dayLdg += e.day_landings || 0; s.nightLdg += e.night_landings || 0;
    s.autoland += e.autolands || 0;
    s.appr += (Array.isArray(e.approaches) ? e.approaches.length : 0);
    s.pax += e.pax_count || 0;
    // V2.4.03：Total Duty 一段 duty 只算一次 —— 用「全 logbook」算好的 duty 表（整段時長掛在第一段），
    //   每筆只加自己被分到的值。不在這裡用 subset 分組（subset 會切斷跨 bucket 的 turnaround，算錯邊界，codex P2）。
    s.duty += _plDutyMinFor(e);
  }
  return s;
}
// 用「整個分析母集合」算 duty 段 → 建「每筆 entry 被分到的 duty 分鐘」表存進 _pl._dutyMap。
//   多段 turnaround 整段時長(最後解除−第一報到)歸給「第一段」(duty 從哪開始就算在那)、其餘段 0；單段/DHD/SIM/算不出 → 各自 total_duty。
//   ⚠ 一定要用母集合建（不是 _plAnSum 收到的 subset），否則跨 bucket 的 turnaround 邊界會被切錯（codex P2）。
//   取捨：duty 歸第一段 → 「只含後段的 bucket」(如跨午夜 turnaround 的次月、duty 中途換機型/公司) 不計這段 duty。
//     這是為了滿足使用者要的「整段只算一次、總計不灌水」必然的取捨；常見的同日同機 turnaround 各段同 bucket、不受影響。
function _plRebuildDutyMap(fullEntries) {
  var map = {}, all = fullEntries || [];
  var grps = _plDutyGroups(all);
  var inGroup = {};
  for (var g = 0; g < grps.length; g++) {
    var grp = grps[g];
    var first = grp.legs[0], fid = first.id;
    var dutyMin;
    if (grp.legs.length > 1 && !isNaN(grp.onMs) && !isNaN(grp.offMs) && grp.offMs > grp.onMs) {
      dutyMin = Math.round((grp.offMs - grp.onMs) / 60000);   // 整段時長
    } else {
      dutyMin = 0; for (var y = 0; y < grp.legs.length; y++) dutyMin += grp.legs[y].total_duty_minutes || 0;
    }
    for (var x = 0; x < grp.legs.length; x++) {
      var lid = grp.legs[x].id; if (!lid) continue;
      if (lid === fid) inGroup[lid] = dutyMin; else inGroup[lid] = 0;   // 整段掛第一段，其餘 0
    }
  }
  for (var i = 0; i < all.length; i++) {
    var e = all[i]; if (!e.id) continue;
    map[e.id] = (e.id in inGroup) ? inGroup[e.id] : (e.total_duty_minutes || 0);   // 不在任何段(DHD/SIM/無時間) → 自己
  }
  _pl._dutyMap = map;
}
// 查一筆 entry 被分到的 duty 分鐘（讀 _plRebuildDutyMap 建好的表；沒建過或不在表 → 退回自己 total_duty，不重複算）。
function _plDutyMinFor(e) {
  if (!e || !e.id) return e ? (e.total_duty_minutes || 0) : 0;
  var m = _pl._dutyMap;
  return (m && (e.id in m)) ? m[e.id] : (e.total_duty_minutes || 0);
}
// V1.3.30：LogTen 風明細數字（起降 / 距離 / Approach / Pax / Duty）—— 給右欄選中組用
function _plAnDetailCard(s) {
  function rw(label, val) { return '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:.76em"><span style="color:var(--muted)">' + label + '</span><span style="font-weight:700;font-variant-numeric:tabular-nums">' + val + '</span></div>'; }
  function sec(t) { return '<div style="font-size:.58em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin:11px 0 3px">' + t + '</div>'; }
  return '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:13px;margin-bottom:9px">' +
    sec('Flight 飛行') +
    rw('Block', _plMinToHHMM(s.block)) + rw('Air', _plMinToHHMM(s.air)) +
    rw('Distance (NM)', Math.round(s.dist).toLocaleString()) +
    sec('Landings 起降') +
    rw('Day T/O', s.dayTO) + rw('Night T/O', s.nightTO) +
    rw('Day Ldg', s.dayLdg) + rw('Night Ldg', s.nightLdg) +
    rw('Autolands', s.autoland) +
    sec('Operations / Pax') +
    rw('Approaches', s.appr) + rw('Total Pax', s.pax.toLocaleString()) +
    rw('Total Duty', _plMinToHHMM(s.duty)) +
  '</div>';
}
// codex P1：'All' 組要把「起始累計（brought forward）」加進去 —— 舊版總計含它（走 _pl.stats），
// 不加會讓有匯入結轉時數的人總時數憑空少一截。其他組（時間/公司/機型）不含（結轉無日期/機尾）。
function _plAnGroupSum(g) {
  var s = _plAnSum(g.entries);
  if (g.id === 'all') {
    var ob = (_pl.stats && _pl.stats.opening) || [];
    ob.forEach(function(o) { s.block += o.total_minutes || 0; s.pic += o.pic_minutes || 0; s.sic += o.sic_minutes || 0; s.night += o.night_minutes || 0; });
  }
  return s;
}
var _PL_AN_COL = { block: 'var(--accent)', air: '#64748b', night: '#3b82f6', pic: '#ef4444', sic: '#f59e0b' };
function _plAnBar(label, mins, maxMins, color) {
  var pct = maxMins > 0 ? Math.max(mins > 0 ? 3 : 0, Math.round(mins / maxMins * 100)) : 0;
  return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
    '<div style="flex:0 0 44px;font-size:.66em;color:' + color + ';font-weight:700">' + label + '</div>' +
    '<div style="flex:0 0 60px;text-align:right;font-size:.74em;font-weight:700;font-variant-numeric:tabular-nums">' + _plMinToHHMM(mins) + '</div>' +
    '<div style="flex:1;min-width:0;background:var(--bar-bg);border-radius:5px;height:13px;overflow:hidden">' +
      '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:5px"></div>' +
    '</div></div>';
}
function _plAnBarsCard(title, sub, s, clickAttr) {
  var max = s.block || 1;
  return '<div style="background:var(--bar-bg-soft);border-radius:10px;padding:13px;margin-bottom:9px' + (clickAttr ? ';cursor:pointer' : '') + '"' + (clickAttr || '') + '>' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px">' +
      '<div style="font-size:.92em;font-weight:800">' + (clickAttr ? '<span style="color:var(--accent)">▸</span> ' : '') + _plEsc(title) + '</div>' +
      '<div style="font-size:.68em;color:var(--muted)">' + _plEsc(sub) + '</div>' +
    '</div>' +
    _plAnBar('Block', s.block, max, _PL_AN_COL.block) +
    (s.air ? _plAnBar('Air', s.air, max, _PL_AN_COL.air) : '') +
    _plAnBar('Night', s.night, max, _PL_AN_COL.night) +
    _plAnBar('PIC', s.pic, max, _PL_AN_COL.pic) +
    _plAnBar('SIC', s.sic, max, _PL_AN_COL.sic) +
  '</div>';
}
// 依維度（type / company）切卡片，點卡片進既有 drill-down
function _plAnDimCards(entries, dim) {
  var groups = {}, order = [];
  entries.forEach(function(e) {
    var k = (dim === 'company') ? _plEntryCompany(e) : (e.aircraft_type || '—');
    if (!k) k = '—';
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(e);
  });
  order.sort(function(a, b) { return _plAnSum(groups[b]).block - _plAnSum(groups[a]).block; });
  return order.map(function(k) {
    var s = _plAnSum(groups[k]);
    var click = '';
    if (k) {
      // 「—」（機型/公司空白）也開放點進明細 —— 不然這群航班沒有任何入口可以找出來補資料
      var fn = (dim === 'company') ? '_plOpenCompanyDetail' : '_plOpenTypeDetail';
      click = ' onclick="' + fn + "('" + _plJs(k) + "')" + '"';
    }
    return _plAnBarsCard(k, s.flights + ' flights', s, click);
  }).join('');
}
// 建左欄群組（時間 / 公司 / 機型），各帶已過濾 entries
function _plAnBuildGroups(all) {
  var groups = [];
  function add(id, label, section, filtered) { groups.push({ id: id, label: label, section: section, entries: filtered }); }
  add('all', 'All Flight Time', 'time', all);
  [[7, 'Last 7 Days'], [28, 'Last 28 Days'], [90, 'Last 90 Days'], [365, 'Last 12 Months']].forEach(function(p) {
    var cut = _plDaysAgoStr(p[0] - 1);   // codex P2：含今天往回 N 天 = today-(N-1)，跟後端 rolling 一致（不多一天）
    add('d' + p[0], p[1], 'time', all.filter(function(e) { return String(e.flight_date || '').slice(0, 10) >= cut; }));
  });
  var byCo = {}, coOrder = [];
  all.forEach(function(e) { var co = _plEntryCompany(e); if (co && co !== '—') { if (!byCo[co]) { byCo[co] = []; coOrder.push(co); } byCo[co].push(e); } });
  coOrder.sort(function(a, b) { return _plAnSum(byCo[b]).block - _plAnSum(byCo[a]).block; });
  coOrder.forEach(function(co) { add('co:' + co, co, 'company', byCo[co]); });
  var byT = {}, tOrder = [];
  all.forEach(function(e) { var t = e.aircraft_type || '—'; if (!byT[t]) { byT[t] = []; tOrder.push(t); } byT[t].push(e); });
  tOrder.sort(function(a, b) { return _plAnSum(byT[b]).block - _plAnSum(byT[a]).block; });
  tOrder.forEach(function(t) { add('ty:' + t, t, 'type', byT[t]); });
  return groups;
}
function _plAnSelect(id) { _pl.anGroup = id; _plRenderAnalyzeContent(); }

function _plRenderAnalyzeContent() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (_pl.tab !== 'analyze') return;   // 防 race：切走後過期的 async render 不可覆蓋新分頁
  // V1.3.09：「已完成」改用 in_utc 判斷（跟後端 stats 一致）— 沒填實際抵達時間的不算飛行統計
  var entries = (_pl.aircraftEntries || []).filter(function(e) {
    if (e.is_deadhead || e.status === 'roster_removed') return false;
    return !!e.in_utc;
  });
  _plRebuildDutyMap(entries);   // V2.4.03：用整個母集合算 duty 去重表，供下面各 bucket 的 _plAnSum 查（避免 subset 切錯 turnaround）
  if (!entries.length) {
    // codex P1：沒有已飛航班但有起始累計 / SIM 時，仍要顯示那些區塊（不要只丟空訊息）
    var extra = _plRenderOpeningSim();
    c.innerHTML = '<div style="padding:10px 14px"><div style="font-size:1em;font-weight:700;margin-bottom:10px">📊 Analyze</div>' +
      (extra || '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">尚無可分析的飛行紀錄，先到 <b>📒 Logbook</b> 新增或匯入 · No flights to analyze yet.</div>') +
      '</div>';
    return;
  }
  var groups = _plAnBuildGroups(entries);
  var sel = null;
  for (var i = 0; i < groups.length; i++) { if (groups[i].id === (_pl.anGroup || 'all')) { sel = groups[i]; break; } }
  if (!sel) sel = groups[0];
  // 左欄：分區 + 各組（label + block 時數），選中高亮
  var sectionTitle = { time: '時間 Time', company: '依公司 Company', type: '依機型 Type' };
  var leftHtml = '', curSection = '';
  groups.forEach(function(g) {
    if (g.section !== curSection) {
      curSection = g.section;
      leftHtml += '<div style="font-size:.6em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin:12px 4px 5px">' + sectionTitle[g.section] + '</div>';
    }
    var active = (g.id === sel.id);
    var s = _plAnGroupSum(g);
    leftHtml += '<div onclick="_plAnSelect(\'' + _plJs(g.id) + '\')" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 11px;border-radius:8px;margin-bottom:4px;cursor:pointer;' +
      (active ? 'background:var(--accent);color:#fff' : 'background:var(--bar-bg-soft)') + '">' +
      '<div style="font-size:.78em;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _plEsc(g.label) + '</div>' +
      '<div style="font-size:.72em;font-variant-numeric:tabular-nums;' + (active ? '' : 'color:var(--muted)') + '">' + _plMinToHHMM(s.block) + '</div>' +
    '</div>';
  });
  // 右欄：選中組的總計橫條 + 依機型(或依公司)卡片；'all' 再加月圖 + 起始累計/SIM
  var selSum = _plAnGroupSum(sel);
  var dim = (sel.section === 'type') ? 'company' : 'type';
  var rightHtml =
    // #2-analyze：群組標題（All Flight Time 等）。手機(<768)靠 .pl-an-ghead 的 base sticky 固定；
    //   iPad(≥768) 由 media query 改成 static（右欄自己是捲動盒，標題不再 sticky，否則行內 sticky 會蓋住內容）。
    //   ⚠ 一定要用 class，不可寫行內 style position:sticky —— 行內優先權會壓過 media query 的 static 改寫（2026-06-06 踩過：iPad 標題一直蓋住內容修不好就是這個）。
    '<div class="pl-an-ghead">' +
      '<div style="font-size:1.05em;font-weight:800">' + _plEsc(sel.label) + '</div>' +
      '<div style="font-size:.7em;color:var(--muted)">' + selSum.flights + ' flights</div>' +
    '</div>' +
    _plAnBarsCard('總計 Totals', _plMinToHHMM(selSum.block) + ' block', selSum, '') +
    _plAnDetailCard(selSum) +
    '<div style="font-size:.62em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin:14px 4px 7px">' + (dim === 'company' ? '依公司 By Company' : '依機型 By Type') + '（點看明細）</div>' +
    _plAnDimCards(sel.entries, dim) +
    // V2.3.06：「—」群組（機型空白）把航班直接列出來 —— 只給統計卡看不到是哪幾班、無從補資料（user 抱怨）。
    // 點任一班直接進編輯器補機型/機尾。
    (sel.label === '—'
      ? '<div style="font-size:.62em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin:14px 4px 7px">航班 · Flights（' + sel.entries.length + '）— 點開補機型 Tap to fix</div>' +
        sel.entries.slice().sort(function(a, b) { return String(b.flight_date || '').localeCompare(String(a.flight_date || '')); }).map(_plRenderEntryRow).join('')
      : '') +
    (sel.id === 'all' ? _plRenderMonthlyChart(entries) + _plRenderOpeningSim() : '');
  c.innerHTML =
    '<style>' +
      '.pl-an-wrap{display:flex;gap:14px;max-width:1100px;margin:0 auto}' +
      '.pl-an-left{flex:0 0 268px;min-width:0}.pl-an-right{flex:1 1 0;min-width:0}' +
      /* 群組標題 base 是 sticky —— 手機(整頁捲)就是靠這個固定群組標題，不能動。 */
      '.pl-an-ghead{position:sticky;top:calc(var(--pl-head-h,0px));z-index:30;background:var(--bg);display:flex;justify-content:space-between;align-items:baseline;padding:4px 0 8px}' +
      /* iPad/寬螢幕(≥768，對齊 Logbook 斷點)：完全照 Logbook detail —— 只「右欄」做 sticky+overflow 捲動盒，左欄隨頁捲。
         群組標題在「右捲動盒內」吸頂 top:0(內容從下面穿過)。⚠ 不可用 base 的 top:var(--pl-head-h)（那是外層頁首高度，在捲動盒內會浮在頂下方、蓋住內容，2026-06-06 踩過）→ 這裡覆寫成 top:0。手機(<768 column)完全不動。 */
      '@media(min-width:768px){.pl-an-wrap{align-items:flex-start}.pl-an-right{position:sticky;top:calc(var(--pl-head-h,0px) + 8px);max-height:calc(100dvh - 84px - var(--pl-head-h,0px) - env(safe-area-inset-bottom));overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}.pl-an-ghead{top:0}}' +
      '@media(max-width:767px){.pl-an-wrap{flex-direction:column}.pl-an-left{flex:none}}' +
    '</style>' +
    '<div style="padding:10px 14px">' +
      '<div class="pl-stickhead">' +
      '<div style="margin-bottom:12px">' +
        '<div style="font-size:1em;font-weight:700">📊 Analyze</div>' +
      '</div>' +
      '</div>' +
      '<div class="pl-an-wrap">' +
        '<div class="pl-an-left">' + leftHtml + '</div>' +
        '<div class="pl-an-right">' + rightHtml + '</div>' +
      '</div>' +
    '</div>';
  // 量「📊 Analyze」標題實際高度寫進 --pl-head-h，左右捲動盒的 sticky top/max-height 才算得準（不然最上面會被切）。
  // 立即量一次 + 下一幀再量一次（字體/版面 settle 後校正）。
  _plUpdateHeadHeight();
  requestAnimationFrame(function () { _plUpdateHeadHeight(); });
}

// === SECTION: Map tab — Flown Map(2D 衛星) / Earth(3D 地球)（V2.2.00）═════════
// 獨立底部分頁。把飛過的機場標在真實地圖、機場間畫大圓航線。2D=Leaflet+Esri 衛星圖、
// 3D=globe.gl（藍色彈珠地球）。引擎只在打開時才從 CDN 懶載入，離線時優雅退場。Save Image 匯出 PNG。

// 航跡顯示偏好（globe 用）：'static'（預設，實線不動）/ 'animated'（流動虛線）
function _plMapArc() { try { return localStorage.getItem('pilotlog_map_arc') === 'animated' ? 'animated' : 'static'; } catch (e) { return 'static'; } }
function _plSetMapArc(v) { try { localStorage.setItem('pilotlog_map_arc', v); } catch (e) {} _plDisposeGlobe(); _plRenderMapTabContent(); }

function _plSetMapView(v) {
  if ((_pl.mapView || 'map') === v) return;
  _plDisposeGlobe();                 // 離開 3D 先釋放 WebGL，避免重複開啟洩漏 context
  _pl.mapView = v;
  _plRenderMapTabContent();
}

// V2.2.02：地圖日期區間（空 = 全部）。
function _plMapRange() { return { from: _pl.mapFrom || '', to: _pl.mapTo || '' }; }
function _plSetMapFrom(v) { _pl.mapFrom = v || null; _plDisposeGlobe(); _plRenderMapTabContent(); }
function _plSetMapTo(v) { _pl.mapTo = v || null; _plDisposeGlobe(); _plRenderMapTabContent(); }
function _plClearMapRange() { _pl.mapFrom = null; _pl.mapTo = null; _plDisposeGlobe(); _plRenderMapTabContent(); }
// 區間列：From → To + 快捷（今年 / 近12月 / 全部）。仿 Report 的 date 區間樣式。
function _plMapRangeRow(rr) {
  var di = 'background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 7px;font-size:.72em';
  var now = new Date();
  var ymd = function(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
  var today = ymd(now);
  var ytd = now.getFullYear() + '-01-01';
  // codex P2：用日曆運算（不是毫秒相減）—— DST 時區午夜後相減會掉到前一天、多算一天。
  var d30 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  var d90 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89);
  var d12 = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  var from12 = d12.getFullYear() + '-' + ('0' + (d12.getMonth() + 1)).slice(-2) + '-01';
  var chip = function(label, fromV, toV) {
    var on = rr.from === fromV && rr.to === toV;
    return '<button onclick="_pl.mapFrom=' + (fromV ? '\'' + fromV + '\'' : 'null') + ';_pl.mapTo=' + (toV ? '\'' + toV + '\'' : 'null') + ';_plDisposeGlobe();_plRenderMapTabContent()" ' +
      'style="background:' + (on ? 'var(--accent)' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--muted)') + ';border:1px solid var(--border);border-radius:6px;padding:5px 9px;font-size:.66em;font-weight:700;cursor:pointer;white-space:nowrap">' + label + '</button>';
  };
  return '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
    '<input type="date" value="' + _plEsc(rr.from) + '" onchange="_plSetMapFrom(this.value)" style="' + di + ';flex:1;min-width:116px">' +
    '<span style="color:var(--muted);font-size:.72em">→</span>' +
    '<input type="date" value="' + _plEsc(rr.to) + '" onchange="_plSetMapTo(this.value)" style="' + di + ';flex:1;min-width:116px">' +
    chip('全部 All', null, null) + chip('近30天', ymd(d30), today) + chip('近90天', ymd(d90), today) + chip('今年', ytd, today) + chip('近12月', from12, today) +
  '</div>';
}

// 把 entries 聚合成 { airports[], routes[], stats }。機場座標查 _plAptInfo（需機場庫已載入）。
function _plBuildFlownGeo(entries) {
  var aptMap = {}, routeMap = {};
  function addApt(code) {
    var info = _plAptInfo(code);
    if (!info || info.lat == null || info.lon == null) return null;
    var key = info.icao || info.iata || String(code).toUpperCase();
    if (!aptMap[key]) aptMap[key] = { code: key, icao: info.icao, iata: info.iata, lat: info.lat, lon: info.lon, name: info.name, city: info.city, cc: info.cc, visits: 0 };
    aptMap[key].visits++;
    return aptMap[key];
  }
  for (var i = 0; i < entries.length; i++) {
    var A = addApt(entries[i].origin), B = addApt(entries[i].dest);
    if (A && B && A.code !== B.code) {
      var k = [A.code, B.code].sort().join('|');
      if (!routeMap[k]) routeMap[k] = { a: A.code, b: B.code, aLat: A.lat, aLon: A.lon, bLat: B.lat, bLon: B.lon, count: 0 };
      routeMap[k].count++;
    }
  }
  var airports = Object.keys(aptMap).map(function(k) { return aptMap[k]; });
  var routes = Object.keys(routeMap).map(function(k) { return routeMap[k]; });
  var countries = {};
  airports.forEach(function(a) { if (a.cc) countries[a.cc] = 1; });
  airports.sort(function(a, b) { return b.visits - a.visits; });
  // 最遠航線（大圓距離 nm）
  var far = null;
  routes.forEach(function(r) {
    var nm = _plGcDistNm(r.aLat, r.aLon, r.bLat, r.bLon);
    if (!far || nm > far.nm) far = { a: r.a, b: r.b, nm: nm };
  });
  return { airports: airports, routes: routes,
    stats: { airports: airports.length, routes: routes.length, countries: Object.keys(countries).length,
             top: airports[0] || null, far: far } };
}

// 大圓距離（海里）
function _plGcDistNm(lat1, lon1, lat2, lon2) {
  var d = Math.PI / 180;
  var a = Math.sin((lat2 - lat1) * d / 2), b = Math.sin((lon2 - lon1) * d / 2);
  var h = a * a + Math.cos(lat1 * d) * Math.cos(lat2 * d) * b * b;
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) * 0.539957);
}

// 大圓航線取樣點（給 Leaflet 畫曲線）。經度沿著大圓「連續展開」（相對起點，可超出 ±180）。
// ⚠️ 換日線：不在這裡切段，而是讓繪圖端把整條線 + 機場點一起平移到「飛行作業區中心框」
// （_plInitFlownMap 的環狀平均經度），跨太平洋航線(TPE↔LAX)才會連到正確的點、不被切到地圖邊緣。
function _plGreatCircle(lat1, lon1, lat2, lon2) {
  var d2r = Math.PI / 180, r2d = 180 / Math.PI;
  var p1 = lat1 * d2r, l1 = lon1 * d2r, p2 = lat2 * d2r, l2 = lon2 * d2r;
  var dl = l2 - l1;
  var dd = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((p2 - p1) / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2)));
  if (!dd || isNaN(dd)) return [[lat1, lon1], [lat2, lon2]];
  var n = Math.max(8, Math.min(128, Math.round(dd * r2d / 2)));
  var pts = [], prev = lon1;
  for (var i = 0; i <= n; i++) {
    var f = i / n;
    var A = Math.sin((1 - f) * dd) / Math.sin(dd), B = Math.sin(f * dd) / Math.sin(dd);
    var x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    var y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    var z = A * Math.sin(p1) + B * Math.sin(p2);
    var lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * r2d;
    var lon = Math.atan2(y, x) * r2d;
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    pts.push([lat, lon]);
  }
  return pts;
}

function _plMapMsg(txt) {
  return '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:.85em;text-align:center;padding:24px">' + txt + '</div>';
}

// Map 分頁進入點（async 抓 entries，跟 Analyze 一樣用完整快照 _pl.aircraftEntries）。
async function _plRenderMapTab() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  _pl.aptReturn = false;
  if (!_pl.user) { _plRenderLogin(); return; }
  _plShowTabBar(true);
  _plHighlightTab('map');
  // V2.2.08：快取優先 —— 手機裡有資料就立刻畫（飛航/慢網秒開、不乾等），背景再 refresh。
  // 只有「從沒載過、沒任何快取」時才顯示 Loading 並等網路。
  if (_pl.aircraftEntries && _pl.aircraftEntries.length) {
    _plRenderMapTabContent();
    _plFetchAircraftEntries().then(function () {
      if (!_pl.user) { _plRenderLogin(); return; }   // codex P1：背景 fetch 期間 token 失效 → 回登入，別重畫快取私資料
      if (_pl.tab === 'map' && !_pl.editing) _plRenderMapTabContent();
    });
  } else {
    c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">Loading map…</div>';
    await _plFetchAircraftEntries();
    if (!_pl.user) { _plRenderLogin(); return; }   // fetch 中 session 失效 → 回登入
    _plRenderMapTabContent();
  }
}

// Map 分頁內容：全版沉浸式地圖 + 浮層控制（仿 ATP2）。
// ⚠️ 機場座標要靠 window._PL_AIRPORTS（懶載入）才查得到 → 一律先 _plLoadAirports() 再建 geo，
// 否則庫沒載入時 _plBuildFlownGeo 會回 0 個機場、誤顯示「無機場」。
function _plRenderMapTabContent() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (_pl.tab !== 'map') return;   // 防 race：切走後過期的 async render 不可覆蓋新分頁
  var view = _pl.mapView || 'map';
  var rr = _plMapRange();
  var entries = (_pl.aircraftEntries || []).filter(function(e) {
    if (e.is_deadhead || e.status === 'roster_removed') return false;
    if (!e.in_utc) return false;
    var fd = String(e.flight_date || '').slice(0, 10);   // 日期區間篩選（空 = 全部）
    if (rr.from && fd < rr.from) return false;
    if (rr.to && fd > rr.to) return false;
    return true;
  });
  var hostId = view === 'globe' ? 'pl-globe-host' : 'pl-map-host';
  var hostBg = view === 'globe' ? '#05070d' : '#0b0f1a';
  var emptyMsg = (rr.from || rr.to) ? '此區間內沒有航班<br>No flights in this range' : '尚無已完成的航班<br>No completed flights yet';
  // 半透明浮層藥丸樣式（毛玻璃）
  var PILL = 'background:rgba(13,18,30,0.66);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.13);border-radius:13px;box-shadow:0 4px 18px rgba(0,0,0,.35)';
  var seg = function(id, label) {
    var on = view === id;
    return '<button onclick="_plSetMapView(\'' + id + '\')" style="padding:6px 14px;border:0;border-radius:10px;font-size:.78em;font-weight:700;cursor:pointer;-webkit-appearance:none;' +
      (on ? 'background:var(--accent);color:#fff' : 'background:transparent;color:rgba(255,255,255,.8)') + '">' + label + '</button>';
  };
  var iconBtn = function(onclick, label, extra) {
    return '<button onclick="' + onclick + '" style="' + PILL + ';color:#fff;padding:7px 11px;font-size:.74em;font-weight:700;cursor:pointer;white-space:nowrap;' + (extra || '') + '">' + label + '</button>';
  };
  // 航跡切換做成跟 Map/Earth 一樣的「雙格段控」（按你要的那個，當前高亮），預設靜態。只在 Earth 顯示。
  var arcBtn = '';
  if (view === 'globe') {
    var arc = _plMapArc();
    var aseg = function(id, label) {
      var on = arc === id;
      return '<button onclick="_plSetMapArc(\'' + id + '\')" style="padding:6px 11px;border:0;border-radius:10px;font-size:.72em;font-weight:700;cursor:pointer;-webkit-appearance:none;' +
        (on ? 'background:var(--accent);color:#fff' : 'background:transparent;color:rgba(255,255,255,.8)') + '">' + label + '</button>';
    };
    arcBtn = '<div style="display:flex;gap:3px;padding:3px;' + PILL + '">' + aseg('static', '靜態') + aseg('animated', '動態') + '</div>';
  }
  var rangeActive = (rr.from || rr.to);
  // 浮層：上排控制 + 統計藥丸 + 可收合日期面板
  var overlay =
    '<div style="position:absolute;top:calc(env(safe-area-inset-top) + 10px);left:10px;right:10px;z-index:10;display:flex;flex-direction:column;gap:8px;pointer-events:none">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
        '<div style="display:flex;gap:8px;align-items:center;pointer-events:auto">' +
          '<div style="display:flex;gap:3px;padding:3px;' + PILL + '">' + seg('map', '🗺️ Map') + seg('globe', '🌐 Earth') + '</div>' +
          arcBtn +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;pointer-events:auto">' +
          iconBtn('_plToggleMapRange()', '📅' + (rangeActive ? ' •' : ''), rangeActive ? 'color:var(--accent)' : '') +
          iconBtn('_plSaveMapImage()', '📷 Save') +
        '</div>' +
      '</div>' +
      '<div id="pl-flown-stats" style="pointer-events:auto"></div>' +
      // 日期區間面板：靠右開（右上空間大），跟右上的 📅 鈕對齊
      '<div id="pl-map-range-panel" style="pointer-events:auto;align-self:flex-end;display:' + (rangeActive ? 'block' : 'none') + ';' + PILL + ';padding:9px 11px;max-width:340px">' + _plMapRangeRow(rr) + '</div>' +
    '</div>';
  c.innerHTML =
    '<div id="pl-map-full" style="position:fixed;top:0;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom));background:' + hostBg + ';overflow:hidden">' +
      // z-index:0 → 給地圖一個獨立堆疊層，把 Leaflet 內部高 z-index（圖磚/控制項 200~1000）關在裡面，
      // 才不會爬到下面 overlay(z-index:10) 之上把切換鈕/日期區間蓋掉。地圖永遠在最底層。
      '<div id="' + hostId + '" style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:0">' +
        _plMapMsg(entries.length ? '載入中… Loading…' : emptyMsg) +
      '</div>' +
      overlay +
    '</div>';
  _plApplyOfflineMapShift();   // V2.2.08：剛建好 pl-map-full，若目前離線就立刻下移讓開橫幅
  // codex P2：每次 render 都先 bump 序號（含「空區間」這條提早 return 的路徑），讓任何更新的 render
  // 立刻讓先前還在飛的 _plLoadAirports().then 失效 —— 否則切到空區間時，舊的非空結果會蓋回來。
  var seq = (_pl.mapRenderSeq = (_pl.mapRenderSeq || 0) + 1);
  if (!entries.length) return;
  _plLoadAirports().then(function() {
    if (seq !== _pl.mapRenderSeq) return;
    if (_pl.tab !== 'map' || (_pl.mapView || 'map') !== view) return;
    var geo = _plBuildFlownGeo(entries);
    var sc = document.getElementById('pl-flown-stats');
    if (sc) sc.innerHTML = _plFlownStatsPill(geo);
    if (!geo.airports.length) {
      var h0 = document.getElementById(hostId);
      if (h0) h0.innerHTML = _plMapMsg('尚無可繪製的機場座標<br>No mappable airports yet');
      return;
    }
    if (view === 'globe') _plInitGlobe(geo);
    else _plInitFlownMap(geo);
  }).catch(function() {
    var h0 = document.getElementById(hostId);
    if (h0) h0.innerHTML = _plMapMsg('機場庫載入失敗<br>Airport database failed to load');
  });
}

// 收合/展開日期面板（不重畫地圖，避免重新初始化閃爍）
function _plToggleMapRange() {
  var p = document.getElementById('pl-map-range-panel');
  if (p) p.style.display = (p.style.display === 'none' || !p.style.display) ? 'block' : 'none';
}

// 統計藥丸（半透明、浮在地圖上、過寬可橫向捲）
function _plFlownStatsPill(geo) {
  var s = geo.stats;
  var PILL = 'background:rgba(13,18,30,0.66);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.13);border-radius:13px;box-shadow:0 4px 18px rgba(0,0,0,.35)';
  var item = function(label, val) {
    return '<div style="text-align:center;padding:3px 11px;white-space:nowrap"><div style="font-size:.98em;font-weight:800;font-variant-numeric:tabular-nums;color:#fff">' + val + '</div>' +
      '<div style="font-size:.5em;color:rgba(255,255,255,.65);text-transform:uppercase;letter-spacing:.5px;margin-top:1px">' + label + '</div></div>';
  };
  var sep = '<div style="width:1px;align-self:stretch;background:rgba(255,255,255,.16);margin:5px 0"></div>';
  var top = s.top ? (s.top.iata || s.top.code) : '—';
  var far = s.far ? (s.far.nm.toLocaleString() + ' nm') : '—';
  return '<div style="display:inline-flex;align-items:center;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;' + PILL + ';padding:3px 4px">' +
    item('Airports', s.airports) + sep + item('Routes', s.routes) + sep + item('Countries', s.countries) + sep + item('Base', _plEsc(top)) + sep + item('Longest', far) +
  '</div>';
}

// Save Image：把目前地圖／地球輸出成 PNG 下載（仿 ATP2）。
// 2D 用 html2canvas 截 host（Esri 衛星圖開 CORS）；3D 直接抓 WebGL canvas（preserveDrawingBuffer）。
async function _plSaveMapImage() {
  var view = _pl.mapView || 'map';
  var fname = 'pilot-log-' + (view === 'globe' ? 'earth' : 'map') + '.png';
  var dl = function(dataUrl) {
    var a = document.createElement('a');
    a.href = dataUrl; a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };
  try {
    if (view === 'globe') {
      if (!_plGlobeInst || (_plGlobeInst.isDestroyed && _plGlobeInst.isDestroyed())) { _plToast('地球尚未就緒', 'error'); return; }
      try { _plGlobeInst.render(); } catch (e) {}   // 確保最新一幀畫進 buffer 才截
      var cv = _plGlobeInst.scene.canvas;
      dl(cv.toDataURL('image/png'));
      _plToast('已存成圖片');
      return;
    }
    var host = document.getElementById('pl-map-host');
    if (!host) { _plToast('地圖尚未就緒', 'error'); return; }
    _plToast('產生圖片中…');
    await _plLoadHtml2Canvas();
    if (!window.html2canvas) { _plToast('匯出元件載入失敗', 'error'); return; }
    var ctrl = host.querySelector('.leaflet-control-container');
    if (ctrl) ctrl.style.visibility = 'hidden';     // 截圖不要含 +/- 控制鈕
    var canvas;
    try { canvas = await window.html2canvas(host, { useCORS: true, backgroundColor: '#0b0f1a', logging: false }); }
    finally { if (ctrl) ctrl.style.visibility = ''; }   // codex P3：截圖失敗也要還原控制鈕（不然按鈕永久消失）
    dl(canvas.toDataURL('image/png'));
    _plToast('已存成圖片');
  } catch (e) {
    _plToast('匯出失敗：' + (e && e.message ? e.message : 'error'), 'error');
  }
}
var _plH2cP = null;
function _plLoadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve();
  if (_plH2cP) return _plH2cP;
  _plH2cP = new Promise(function(res, rej) {
    var s = document.createElement('script');
    s.src = 'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload = function() { res(); };
    s.onerror = function() { _plH2cP = null; rej(new Error('html2canvas')); };
    document.head.appendChild(s);
  });
  return _plH2cP;
}

// ── 懶載入 Leaflet / globe.gl（只在打開地圖時抓 CDN）──────────────────────────
var _plLeafletP = null;
function _plLoadLeaflet() {
  if (window.L) return Promise.resolve();
  if (_plLeafletP) return _plLeafletP;
  _plLeafletP = new Promise(function(res, rej) {
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    var s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = function() { res(); };
    s.onerror = function() { _plLeafletP = null; rej(new Error('leaflet')); };
    document.head.appendChild(s);
  });
  return _plLeafletP;
}
// 3D Earth 用 CesiumJS（衛星圖磚串流＝放大有街道級細節 ＋ 日夜光照 ＋ 城市夜燈，仿 ATP2）。
// 引擎較大（~3MB），只在打開 Earth 時才抓；並在 Service Worker 做永久快取（routes.ts），抓過一次就常駐。
var _plCesiumP = null;
function _plLoadCesium() {
  if (window.Cesium) return Promise.resolve();
  if (_plCesiumP) return _plCesiumP;
  // codex P2：釘死精確版本（不用 @1 浮動 tag）—— plcdn 是永久 cache-first，浮動 tag 會讓使用者
  // 永遠卡在第一次抓到的版本。要升級 Cesium 就改這個版號（新網址＝新 cache 條目，自動換新）。
  var BASE = 'https://unpkg.com/cesium@1.142.0/Build/Cesium/';
  window.CESIUM_BASE_URL = BASE;   // Cesium 的 worker/wasm/資產相對此路徑載入
  _plCesiumP = new Promise(function(res, rej) {
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = BASE + 'Widgets/widgets.css';
    document.head.appendChild(css);
    var s = document.createElement('script');
    s.src = BASE + 'Cesium.js';
    s.onload = function() { res(); };
    s.onerror = function() { _plCesiumP = null; rej(new Error('cesium')); };
    document.head.appendChild(s);
  });
  return _plCesiumP;
}

// 2D Leaflet：Esri 衛星實景圖 + 機場點 + 大圓航線（仿 ATP2）
function _plInitFlownMap(geo) {
  var host = document.getElementById('pl-map-host');
  if (!host) return;
  // codex P2（一致）：不早退，讓已永久快取的 Leaflet 離線也能載；真的載不到走 .catch。
  _plLoadLeaflet().then(function() {
    if (_pl.tab !== 'map' || (_pl.mapView || 'map') !== 'map') return;
    var h = document.getElementById('pl-map-host');
    if (!h || !window.L) { if (h) h.innerHTML = _plMapMsg('地圖載入失敗<br>Map failed to load'); return; }
    h.innerHTML = '<div id="pl-lmap" style="width:100%;height:100%;background:#0b0f1a"></div>';   // 深底，載入時不露 Leaflet 預設灰
    _plEnsureMapLblCss();
    var L = window.L;
    // zoomControl 移到右下 —— 左上/左下會擋到浮層的切換鈕與統計，右下角最空。
    var map = L.map('pl-lmap', { worldCopyJump: true, attributionControl: false, zoomControl: false, minZoom: 1 }).setView([20, 100], 2);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    // Esri World Imagery 衛星圖（跟跑道圖同源）。crossOrigin 讓 Save Image 可截圖。
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, crossOrigin: true }).addTo(map);
    // 「飛行作業區中心」= 所有機場的環狀平均經度。把機場點 + 航線整條都平移進這個中心框
    // （near() 把任一經度移到離中心 ±180 內），亞洲基地飛美西/歐洲的圖才會以你的作業區置中、
    // 跨太平洋航線連得起來、不被切到地圖左右邊緣。
    var sx = 0, sy = 0, d2r = Math.PI / 180;
    geo.airports.forEach(function(a) { sx += Math.cos(a.lon * d2r); sy += Math.sin(a.lon * d2r); });
    var meanLon = (sx || sy) ? Math.atan2(sy, sx) / d2r : 0;
    var near = function(lon) { return lon + 360 * Math.round((meanLon - lon) / 360); };
    var bounds = [];
    geo.routes.forEach(function(r) {
      var w = Math.min(0.6 + r.count * 0.12, 1.8);           // 細線（仿 ATP2），密集航網才不會糊成一坨
      var off = near(r.aLon) - r.aLon;                       // 整條線平移到中心框（起點對齊）
      var line = _plGreatCircle(r.aLat, r.aLon, r.bLat, r.bLon).map(function(p) { return [p[0], p[1] + off]; });
      L.polyline(line, { color: '#e0f2fe', weight: w, opacity: 0.5 }).addTo(map);   // 淡藍白、半透明，不搶戲
    });
    geo.airports.forEach(function(a) {
      var ll = [a.lat, near(a.lon)];
      bounds.push(ll);
      var rad = Math.min(2.4 + Math.sqrt(a.visits) * 0.7, 6.5);   // 點縮小，不擋圖
      var mk = L.circleMarker(ll, { radius: rad, color: '#ffffff', weight: 1.3, fillColor: '#f43f5e', fillOpacity: 0.95 })  // 紅點白圈，衛星圖上跳出來
        .addTo(map)
        .bindPopup('<b>' + _plEsc(a.iata || a.code) + '</b> <span style="opacity:.6">' + _plEsc(a.icao || '') + '</span><br>' +
          _plEsc(a.city || a.name || '') + '<br>' + a.visits + ' 次 · visits');
      // 機場標籤：用機場代碼（跟 IATA/ICAO 切換連動），不用城市/區名（飛行員看不習慣）。常駐 tooltip、zoom 夠近才顯示。
      mk.bindTooltip(_plEsc(_plAptFmt(a.code) || a.code || a.iata), { permanent: true, direction: 'right', offset: [5, 0], className: 'pl-maplbl' });
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 6 });
    // 依 zoom 切換地名顯示：zoom 夠近(>=5)才把標籤顯示出來。
    var LBL_ZOOM = 5;
    var syncLbls = function() {
      var el = document.getElementById('pl-lmap');
      if (el) el.classList.toggle('pl-lbls-on', map.getZoom() >= LBL_ZOOM);
    };
    map.on('zoomend', syncLbls); syncLbls();
    setTimeout(function() { try { map.invalidateSize(); } catch (e) {} }, 120);
  }).catch(function() {
    var h = document.getElementById('pl-map-host');
    if (h) h.innerHTML = _plMapMsg('地圖載入失敗<br>Map failed to load');
  });
}

// 地名標籤樣式（注入一次）：衛星圖上白字描黑邊、無底框；預設隱藏，地圖縮放夠近(.pl-lbls-on)才顯示。
function _plEnsureMapLblCss() {
  if (document.getElementById('pl-maplbl-css')) return;
  var st = document.createElement('style');
  st.id = 'pl-maplbl-css';
  st.textContent =
    '.pl-maplbl.leaflet-tooltip{background:transparent;border:none;box-shadow:none;color:#fff;font-weight:700;font-size:10px;' +
    'text-shadow:0 0 3px #000,0 0 3px #000,0 0 3px #000;padding:0;white-space:nowrap;display:none}' +
    '.pl-maplbl.leaflet-tooltip:before{display:none}' +
    '#pl-lmap.pl-lbls-on .pl-maplbl.leaflet-tooltip{display:block}';
  document.head.appendChild(st);
}

// 3D Earth：CesiumJS Viewer（衛星圖磚 + 日夜光照 + 城市夜燈 + 測地線航線 + 近看才顯示地名）
var _plGlobeInst = null;   // Cesium Viewer
function _plDisposeGlobe() {
  if (_plGlobeInst) {
    try { if (!(_plGlobeInst.isDestroyed && _plGlobeInst.isDestroyed())) _plGlobeInst.destroy(); } catch (e) {}
    _plGlobeInst = null;
  }
}
function _plInitGlobe(geo) {
  var host = document.getElementById('pl-globe-host');
  if (!host) return;
  // codex P2：不在這裡用 _plOnline() 早退 —— 引擎已永久快取在 SW(plcdn) 時，離線重開也要能從快取載入。
  // 真的離線又沒快取，_plLoadCesium() 的 script onerror 會 reject → 走下面 .catch 顯示需連網。
  host.innerHTML = _plMapMsg('載入 3D 地球中…<br>Loading 3D Earth…');
  _plLoadCesium().then(function() {
    if (_pl.tab !== 'map' || (_pl.mapView || 'map') !== 'globe') return;
    var h = document.getElementById('pl-globe-host');
    if (!h || !window.Cesium) { if (h) h.innerHTML = _plMapMsg('地球載入失敗<br>Earth failed to load'); return; }
    var C = window.Cesium;
    _plDisposeGlobe();
    h.innerHTML = '<div id="pl-cesium" style="position:absolute;top:0;left:0;right:0;bottom:0"></div>';
    var animated = _plMapArc() === 'animated';
    try { C.Ion.defaultAccessToken = ''; } catch (e) {}   // 不用 Cesium ion（改用免費 Esri 衛星圖 + 橢球地形）
    var viewer;
    try {
      viewer = new C.Viewer('pl-cesium', {
        baseLayer: false, baseLayerPicker: false, timeline: false, animation: false, geocoder: false,
        homeButton: false, sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false,
        infoBox: false, selectionIndicator: false, requestRenderMode: false,
        contextOptions: { webgl: { preserveDrawingBuffer: true } }   // 截圖（Save Image）才抓得到內容
      });
    } catch (e) { h.innerHTML = _plMapMsg('地球初始化失敗<br>' + _plEsc(e.message || '')); return; }
    _plGlobeInst = viewer;
    var scene = viewer.scene;
    // V2.2.04：仿 Apple 自動切換 —— 拉遠看整顆地球時開日夜光照 + 城市燈（有氛圍）；放大過門檻
    // 自動關掉、切回清楚的白天衛星圖（街道級細節只有白天資料，近看必是白天圖）。實作在下方 camera 監聽。
    var PL_NIGHT_HI = 3.0e6;    // 鏡頭離地高於此（公尺）= 日夜陰影 + 城市燈；低於此 = 純白天清楚圖
    var _plNightLayer = null;   // 城市燈疊圖參照（async 載入後才有），近看時 hide
    try { scene.globe.enableLighting = true; } catch (e) {}    // 初始遠景先開，camera 監聽會依高度自動調
    try { scene.highDynamicRange = false; } catch (e) {}
    try { scene.globe.showGroundAtmosphere = true; } catch (e) {}
    try { viewer.cesiumWidget.creditContainer.style.display = 'none'; } catch (e) {}   // 隱藏 logo 列（保留地圖供應商不影響）
    // 衛星圖（Esri World Imagery，免費、無金鑰、跟 2D 同源）
    try {
      C.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer')
        .then(function(prov) { if (_plGlobeInst === viewer) try { viewer.imageryLayers.addImageryProvider(prov); } catch (e) {} })
        .catch(function() {});
    } catch (e) {}
    // 夜面城市燈（earth-night.jpg）：解析度低、放大會糊，所以只在「拉遠」時顯示，近看由 camera 監聽 hide。
    try {
      C.SingleTileImageryProvider.fromUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
        .then(function(np) {
          if (_plGlobeInst !== viewer) return;
          _plNightLayer = viewer.imageryLayers.addImageryProvider(np);
          try { _plNightLayer.dayAlpha = 0.0; _plNightLayer.nightAlpha = 1.0; _plNightLayer.brightness = 1.6; } catch (e) {}
          try { _plNightLayer.show = (viewer.camera.positionCartographic.height > PL_NIGHT_HI); } catch (e) {}
        }).catch(function() {});
    } catch (e) {}
    // 依鏡頭高度自動切換日夜：遠 = 日夜陰影 + 城市燈；近 = 純白天清楚衛星圖（仿 Apple）
    try {
      viewer.camera.percentageChanged = 0.05;   // 較敏感：門檻附近的小幅縮放也能觸發 changed
      var _plApplyDayNight = function() {
        var far = true;
        try { far = viewer.camera.positionCartographic.height > PL_NIGHT_HI; } catch (e) {}
        try { scene.globe.enableLighting = far; } catch (e) {}
        if (_plNightLayer) { try { _plNightLayer.show = far; } catch (e) {} }
      };
      viewer.camera.changed.addEventListener(_plApplyDayNight);
      viewer.camera.moveEnd.addEventListener(_plApplyDayNight);   // 保險：小縮放沒觸發 changed 時，移動一結束一定補判一次（修 codex P2：避免卡在邊界狀態）
      _plApplyDayNight();
    } catch (e) {}
    // 航線（測地線大圓，Cesium 原生處理換日線）。動態時時鐘要跑，光點才會沿線移動。
    try { viewer.clock.shouldAnimate = animated; } catch (e) {}
    var clockStart = C.JulianDate.clone(viewer.clock.currentTime);
    // 本站群＝所有台灣機場（國碼 TW 或 ICAO 以 RC 開頭，如 RCTP/RCSS/RCKH/RCMQ）。光點一律從台灣端飛出去。
    var _plTW = {};
    try { geo.airports.forEach(function(a) { if (a.cc === 'TW' || /^RC/.test(a.icao || a.code || '')) _plTW[a.code] = 1; }); } catch (e) {}
    geo.routes.forEach(function(r, idx) {
      var w = Math.min(0.8 + r.count * 0.12, 2.2);
      try {
        // 底線（動態時淡一點，讓移動光點更突出）
        viewer.entities.add({ polyline: {
          positions: C.Cartesian3.fromDegreesArray([r.aLon, r.aLat, r.bLon, r.bLat]),
          width: w, arcType: C.ArcType.GEODESIC,
          material: C.Color.fromCssColorString('#e0f2fe').withAlpha(animated ? 0.32 : 0.55)
        } });
        // 動態：一顆發光點沿著大圓「光影移動」（各線錯開相位），靜態則沒有。
        if (animated) {
          // 光點固定「從台灣飛出去」：台灣端當起點。台↔台航線則以桃園(RCTP)為起點。
          var sLon = r.aLon, sLat = r.aLat, eLon = r.bLon, eLat = r.bLat;
          var aTW = _plTW[r.a], bTW = _plTW[r.b], rev = false;
          if (bTW && !aTW) rev = true;                                         // 台灣在 b 端 → 反向，從台灣飛出
          else if (aTW && bTW && r.b === 'RCTP' && r.a !== 'RCTP') rev = true; // 台↔台 → 從桃園出發
          if (rev) { sLon = r.bLon; sLat = r.bLat; eLon = r.aLon; eLat = r.aLat; }
          var gd = new C.EllipsoidGeodesic(C.Cartographic.fromDegrees(sLon, sLat), C.Cartographic.fromDegrees(eLon, eLat));
          var phase = (idx % 8) / 8;
          viewer.entities.add({
            position: new C.CallbackProperty(function(time) {
              var s = C.JulianDate.secondsDifference(time, clockStart);
              var t = (((s / 4) + phase) % 1 + 1) % 1;   // 0→1 沿線跑，週期 4 秒
              var cg = gd.interpolateUsingFraction(t);
              return C.Cartesian3.fromRadians(cg.longitude, cg.latitude, 8000);
            }, false),
            point: { pixelSize: 6, color: C.Color.fromCssColorString('#a5f3fc'), outlineColor: C.Color.WHITE.withAlpha(0.6), outlineWidth: 1 }
          });
        }
      } catch (e) {}
    });
    // 機場（紅點白圈 + 地名標籤；標籤用 distanceDisplayCondition 近看(<2000km)才顯示）
    geo.airports.forEach(function(a) {
      var px = Math.min(5 + Math.sqrt(a.visits) * 1.4, 11);
      try {
        viewer.entities.add({
          position: C.Cartesian3.fromDegrees(a.lon, a.lat),
          point: { pixelSize: px, color: C.Color.fromCssColorString('#f43f5e'), outlineColor: C.Color.WHITE, outlineWidth: 1.4 },
          label: {
            text: _plAptFmt(a.code) || a.code || a.iata,   // 機場代碼（跟 IATA/ICAO 切換連動），不用城市/區名
            font: 'bold 13px -apple-system, "Segoe UI", sans-serif',
            fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
            style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(9, 0),
            horizontalOrigin: C.HorizontalOrigin.LEFT, verticalOrigin: C.VerticalOrigin.CENTER,
            distanceDisplayCondition: new C.DistanceDisplayCondition(0, 2.0e6)   // 近看才顯示地名
          }
        });
      } catch (e) {}
    });
    // 鏡頭定位到主場上空
    try {
      var t = geo.stats.top || geo.airports[0];
      if (t) viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(t.lon, t.lat, 1.4e7) });
    } catch (e) {}
  }).catch(function() {
    var h = document.getElementById('pl-globe-host');
    if (h) h.innerHTML = _plMapMsg('地球載入失敗（需連網）<br>Earth failed to load');
  });
}

// === SECTION: report（currency + 區間總表 + 匯出）═══════════════════════════
// 全新 tab。資料用完整快照 _pl.aircraftEntries 計算。currency 僅供參考、非官方判定。

async function _plRenderReport() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  _pl.aptReturn = false;   // V1.3.39：切到 Report → 清 Airports 返回標記
  if (!_pl.user) { _plRenderLogin(); return; }
  _plShowTabBar(true);
  _plHighlightTab('report');
  // V2.2.08：快取優先（同 Map）—— 有快取就立刻畫、背景 refresh；只有完全沒快取才 Loading 等網路。
  if (_pl.aircraftEntries && _pl.aircraftEntries.length) {
    _plRenderReportContent();
    _plFetchAircraftEntries().then(function () {
      if (!_pl.user) { _plRenderLogin(); return; }   // codex P1：背景 fetch 期間 token 失效 → 回登入
      if (_pl.tab === 'report' && !_pl.editing) _plRenderReportContent();
    });
  } else {
    c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-size:.85em">Loading report…</div>';
    await _plFetchAircraftEntries();
    if (!_pl.user) { _plRenderLogin(); return; }   // fetch 中 session 失效 → 回登入（codex fast P1）
    _plRenderReportContent();
  }
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
    else if (_plIsSicPos(e.position)) a.sic += e.block_minutes || 0;
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
    // V1.3.31：標題自己一行、日期區間另一行（兩個 date 平分撐開），iPhone 不再擠成一團
    '<div style="margin:14px 0 8px">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">📅 Hours Summary</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<input type="date" value="' + _plEsc(r.from) + '" onchange="_plSetReportFrom(this.value)" style="' + inputStyle + ';flex:1;min-width:130px">' +
        '<span style="color:var(--muted);font-size:.78em">→</span>' +
        '<input type="date" value="' + _plEsc(r.to) + '" onchange="_plSetReportTo(this.value)" style="' + inputStyle + ';flex:1;min-width:130px">' +
      '</div>' +
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
      '<button onclick="_plOpenLogbookDialog()" style="background:#6366f1;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:.8em;font-weight:700;cursor:pointer">📕 Logbook PDF</button>' +
      '<button onclick="_plExportCsv()" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:.8em;font-weight:700;cursor:pointer">⬇️ 航班 Flights CSV</button>' +
    '</div>' +
    '<div style="font-size:.62em;color:var(--muted);margin-top:6px">📕 PDF = 人類可讀的飛行紀錄簿（轉職交件用，可選地區格式：通用/EASA/FAA/ICAO）；⬇️ CSV = 給其他軟體匯入用。</div>' +
    '<div style="font-size:.62em;color:var(--muted);margin-top:8px">航班 CSV 為區間內已飛（confirmed）航班，含 PIC/SIC、起降、夜航時數（' + _plEsc(r.from) + ' → ' + _plEsc(r.to) + '）。</div>' +
    // V1.3.33：其他資料匯出集中在 Report（各頁也有，這裡一站全包）。通訊錄/飛機/機型不分區間、匯出全部。
    '<div style="font-size:.62em;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:16px 0 6px">其他資料匯出 · Export data（全部，不分區間）</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button onclick="_plExportCrewCsv()" style="background:transparent;color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:7px 12px;font-size:.78em;font-weight:700;cursor:pointer">👥 通訊錄 Crew</button>' +
      '<button onclick="_plExportAircraftCsv()" style="background:transparent;color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:7px 12px;font-size:.78em;font-weight:700;cursor:pointer">✈️ 機尾庫 Aircraft</button>' +
      '<button onclick="_plExportTypesCsv()" style="background:transparent;color:var(--text);border:1px solid var(--border,#334155);border-radius:6px;padding:7px 12px;font-size:.78em;font-weight:700;cursor:pointer">🧭 機型 Types</button>' +
    '</div>';

  c.innerHTML =
    '<div style="padding:10px 14px">' +
      '<div class="pl-stickhead">' +
      '<div style="margin-bottom:10px">' +
        '<div style="font-size:1em;font-weight:700">📄 Report</div>' +
      '</div>' +
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
    var otherNames = _plEntryCrewNames(e, 'all').filter(function(n) { return n !== picName; }).join('; ');
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

// V1.3.32：通用 CSV 下載（比照 Report Export CSV：BOM + CRLF）。給通訊錄 / 飛機 / 機型匯出共用。
function _plDownloadCsv(filename, head, rows) {
  var lines = [head.map(_plCsvCell).join(',')];
  rows.forEach(function(cells) { lines.push(cells.map(_plCsvCell).join(',')); });
  var blob = new Blob([String.fromCharCode(0xFEFF) + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

// ══════════════════════════════════════════════════════════════════════════
// 📕 Logbook PDF — 人類可讀飛行紀錄簿（設定驅動引擎 + 地區格式預設）
//   前端 jsPDF + autotable 產 PDF、一鍵下載（iOS：開啟後「分享 → 儲存到檔案」）。
//   每個格式 = 一組欄位設定（cols）；要加地區只要加一組設定、不動引擎。
//   資料缺口（IFR/儀器、cross-country）法規欄留空；單/多發航司一律多發 → 多發欄帶 block、單發留空。
// ══════════════════════════════════════════════════════════════════════════
var _plJsPdfP = null;
function _plLoadJsPdf() {
  var ok = window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable;
  if (ok) return Promise.resolve();
  if (_plJsPdfP) return _plJsPdfP;
  _plJsPdfP = new Promise(function (res, rej) {
    var s1 = document.createElement('script');
    s1.src = 'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js';
    s1.onload = function () {
      var s2 = document.createElement('script');
      s2.src = 'https://unpkg.com/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js';
      s2.onload = function () { res(); };
      s2.onerror = function () { _plJsPdfP = null; rej(new Error('autotable load failed')); };
      document.head.appendChild(s2);
    };
    s1.onerror = function () { _plJsPdfP = null; rej(new Error('jspdf load failed')); };
    document.head.appendChild(s1);
  });
  return _plJsPdfP;
}

// 時間戳 → "HHMM" UTC（logbook 起飛/落地時間欄）
function _plUtcHHMM(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return ('0' + d.getUTCHours()).slice(-2) + ('0' + d.getUTCMinutes()).slice(-2);
}
// PIC / SIC 分鐘：有明確值用明確值，否則依角色 × block（與後端 stats 一致）
function _plPicMin(e) { return (typeof e.pic_minutes === 'number') ? e.pic_minutes : (e.position === 'PIC' ? (e.block_minutes || 0) : 0); }
function _plSicMin(e) { return (typeof e.sic_minutes === 'number') ? e.sic_minutes : (_plIsSicPos(e.position) ? (e.block_minutes || 0) : 0); }
function _plPicNameCell(e) { var c = e.crew || {}; var n = _plCrewVal(c.pic).name; return n || (e.position === 'PIC' ? 'SELF' : ''); }

// 區間內已飛（confirmed、非 deadhead、有 in_utc），日期升冪 — 與 CSV/Report 同一套過濾
function _plLogbookSrc(from, to) {
  var src = (_pl.aircraftEntries || []).filter(function (e) {
    if (e.is_deadhead || e.status === 'roster_removed') return false;
    if (!e.in_utc) return false;
    var fd = String(e.flight_date || '').slice(0, 10);
    return (!from || fd >= from) && (!to || fd <= to);
  });
  src.sort(function (a, b) { return (a.flight_date || '').localeCompare(b.flight_date || ''); });
  return src;
}

// 欄位 builder：_plT=時間欄(分鐘→HH:MM、加總) _plI=計數欄(整數、加總) _plX=文字欄(不加總)
function _plT(h, val) { return { h: h, get: function (e) { return _plMinToHHMM(val(e)); }, val: val, tot: 'time' }; }
function _plI(h, val) { return { h: h, get: function (e) { var v = val(e); return v ? String(v) : ''; }, val: val, tot: 'int' }; }
function _plX(h, get) { return { h: h, get: get }; }

// 各格式（欄位設定）。只列「有官方明確範本」的地區 + 通用擺第一。
function _plLbFormats() {
  var date = function (e) { return String(e.flight_date || '').slice(0, 10); };
  var fno = function (e) { return e.flight_no || ''; };
  var org = function (e) { return e.origin || ''; };
  var dst = function (e) { return e.dest || ''; };
  var typ = function (e) { return e.aircraft_type || ''; };
  var reg = function (e) { return e.tail_no || ''; };
  var rmk = function (e) { return e.remarks || ''; };
  var blk = function (e) { return e.block_minutes || 0; };
  var ngt = function (e) { return e.night_minutes || 0; };
  var dTO = function (e) { return e.day_takeoffs || 0; }, nTO = function (e) { return e.night_takeoffs || 0; };
  var dLd = function (e) { return e.day_landings || 0; }, nLd = function (e) { return e.night_landings || 0; };
  var blank = function () { return ''; };

  // EASA-FCL 12 欄（AMC1 FCL.050；分組欄攤平）。航司多機組：單發 SE 留空、多發 MP=block；IFR/Dual/Instr 留空。
  var easaCols = [
    _plX('Date', date),
    _plX('Dep', org), _plX('Time', function (e) { return _plUtcHHMM(e.out_utc || e.off_utc); }),
    _plX('Arr', dst), _plX('Time', function (e) { return _plUtcHHMM(e.in_utc || e.on_utc); }),
    _plX('Type', typ), _plX('Reg', reg),
    _plX('SE', blank), _plX('ME', blank),
    _plT('Multi-Pilot', blk), _plT('Total', blk),
    _plX('Name PIC', _plPicNameCell),
    _plI('Ldg Day', dLd), _plI('Ldg Nt', nLd),
    _plT('Night', ngt), _plX('IFR', blank),
    _plT('PIC', _plPicMin), _plT('Co-Pilot', _plSicMin), _plX('Dual', blank), _plX('Instr', blank),
    _plX('Remarks', rmk),
  ];

  return [
    {
      id: 'generic', name: '通用 Generic', orientation: 'landscape',
      cols: [
        _plX('Date', date), _plX('Flight', fno), _plX('From', org), _plX('To', dst),
        _plX('Type', typ), _plX('Reg', reg),
        _plT('Block', blk), _plT('Night', ngt), _plT('PIC', _plPicMin), _plT('SIC', _plSicMin),
        _plI('Day TO', dTO), _plI('Nt TO', nTO), _plI('Day Ldg', dLd), _plI('Nt Ldg', nLd),
        _plX('Remarks', rmk),
      ],
    },
    { id: 'easa', name: 'EASA-FCL', orientation: 'landscape', cols: easaCols },
    { id: 'icao', name: 'ICAO', orientation: 'landscape', cols: easaCols },
    {
      id: 'faa', name: 'FAA', orientation: 'landscape',
      cols: [
        _plX('Date', date), _plX('Make/Model', typ), _plX('Ident', reg),
        _plX('From', org), _plX('To', dst),
        _plT('Total', blk), _plT('Night', ngt),
        _plX('Inst', blank), _plX('XC', blank),
        _plI('Day TO', dTO), _plI('Nt TO', nTO), _plI('Day Ldg', dLd), _plI('Nt Ldg', nLd),
        _plT('PIC', _plPicMin), _plT('SIC', _plSicMin), _plX('Dual', blank),
        _plX('Remarks', rmk),
      ],
    },
  ];
}

// 機型統計（區間內，給 PDF 附頁）：機型 → block/PIC/SIC/Night/班數
function _plLbByType(src) {
  var m = {};
  for (var i = 0; i < src.length; i++) {
    var e = src[i], t = e.aircraft_type || '—';
    if (!m[t]) m[t] = { type: t, block: 0, pic: 0, sic: 0, night: 0, n: 0 };
    m[t].block += e.block_minutes || 0; m[t].pic += _plPicMin(e); m[t].sic += _plSicMin(e);
    m[t].night += e.night_minutes || 0; m[t].n++;
  }
  var arr = Object.keys(m).map(function (k) { return m[k]; });
  arr.sort(function (a, b) { return b.block - a.block; });
  return arr;
}

// 偵測非 Latin-1 字（中日韓等 → 需內嵌字型才印得出來）
function _plLbHasCJK(s) { return /[^\u0000-\u00FF]/.test(String(s == null ? '' : s)); }
// 收集整份 PDF 會用到的「所有字」→ 給伺服器 subset（只嵌這些字，檔案才小：4.5MB → 幾十 KB）
function _plLbCollectChars(fmt, src, extra) {
  var set = {};
  function add(s) { s = String(s == null ? '' : s); for (var i = 0; i < s.length; i++) set[s[i]] = 1; }
  add(extra || '');
  fmt.cols.forEach(function (c) { add(c.h); });
  for (var i = 0; i < src.length; i++) { for (var j = 0; j < fmt.cols.length; j++) { add(fmt.cols[j].get(src[i])); } }
  return Object.keys(set).join('');
}
// 設字型：某段文字含中日韓且有嵌入 CJK 字型 → 用它；否則用內建 helvetica
function _plLbFont(doc, text, CJK, style) { if (CJK && _plLbHasCJK(text)) { doc.setFont(CJK, 'normal'); } else { doc.setFont('helvetica', style || 'normal'); } }

// 引擎：autotable 真·文字向量 PDF；內容含中日韓 → 跟伺服器要「只含用到的字」的 subset 字型嵌入（檔案小、可選取）
function _plGenLogbookPdf(formatId, opts) {
  opts = opts || {};
  var r = _plReportRange();
  var src = _plLogbookSrc(r.from, r.to);
  if (!src.length) { _plToast('此區間沒有已飛航班 No flights in range'); return; }
  var fmts = _plLbFormats(), fmt = null;
  for (var i = 0; i < fmts.length; i++) { if (fmts[i].id === formatId) { fmt = fmts[i]; break; } }
  if (!fmt) fmt = fmts[0];
  var orient = opts.orientation || fmt.orientation || 'landscape';
  var many = fmt.cols.length > 16;
  var pilot = (_pl.user && (_pl.user.name || _pl.user.email)) || '';
  var bt = _plLbByType(src);
  // 收集所有會出現的字（含格式名/機長名/機型/靜態標籤 + 全部可印 ASCII）→ subset 用
  //   含全部 ASCII：CJK 儲存格/標題裡夾的英數標點（如「機師考核 PC」的 PC、「-」）一定也在 subset 內，不會缺字。
  var ASCII = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  var staticTxt = ASCII + ' Pilot Logbook Summary by Aircraft Type Flights Block PIC SIC Night TOTAL Page Total Generated by reference flights to ' + fmt.name + ' ' + pilot + ' ' + r.from + ' ' + r.to;
  bt.forEach(function (t) { staticTxt += ' ' + t.type; });
  var allChars = _plLbCollectChars(fmt, src, staticTxt);
  var needCJK = _plLbHasCJK(allChars);
  _plToast('產生 PDF… Generating');
  _plLoadJsPdf().then(function () {
    // 有中日韓 → 先跟伺服器拿 subset 字型（base64 truetype）
    var fontP = needCJK
      ? _plApi('/api/pilot-log/font-subset', { method: 'POST', body: { chars: allChars } })
          .then(function (res) { return res.json(); }).then(function (j) { return (j && j.font) ? j.font : null; })
          .catch(function () { return null; })
      : Promise.resolve(null);
    fontP.then(function (fontB64) {
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ orientation: orient, unit: 'mm', format: (opts.paper || 'a4') });
      var CJK = null;
      if (fontB64) { try { doc.addFileToVFS('plcjk.ttf', fontB64); doc.addFont('plcjk.ttf', 'plcjk', 'normal'); CJK = 'plcjk'; } catch (e) { CJK = null; } }
      // 內容有中日韓但字型沒載成功 → 明確報錯、不產出「亂碼但假裝成功」的 PDF（codex P1）
      if (needCJK && !CJK) { _plToast('中文字型載入失敗，請稍後再試 · CJK font failed, please retry'); return; }
      var asciiName = { generic: 'Generic', easa: 'EASA-FCL', icao: 'ICAO', faa: 'FAA' }[fmt.id] || fmt.id;
      // 標頭：格式名/機長名若含中文且有 CJK 字型就用它，否則退英文/helvetica
      var title = 'Pilot Logbook - ' + ((CJK || !_plLbHasCJK(fmt.name)) ? fmt.name : asciiName);
      doc.setFontSize(13); _plLbFont(doc, title, CJK, 'bold'); doc.text(title, 8, 11);
      var sub = (pilot ? pilot + '    ' : '') + r.from + '  to  ' + r.to + '    -    ' + src.length + ' flights';
      doc.setFontSize(8); _plLbFont(doc, sub, CJK, 'normal'); doc.text(sub, 8, 16);
      // 主表 + 總計列；CJK 儲存格在 didParseCell 切到嵌入字型，其餘 helvetica（拉丁清晰）
      var head = [fmt.cols.map(function (c) { return c.h; })];
      var body = src.map(function (e) { return fmt.cols.map(function (c) { return c.get(e); }); });
      var totals = fmt.cols.map(function (c, idx) {
        if (c.val) { var s = 0; for (var j = 0; j < src.length; j++) s += (c.val(src[j]) || 0); return c.tot === 'time' ? _plMinToHHMM(s) : String(s); }
        return idx === 0 ? 'TOTAL' : '';
      });
      body.push(totals);
      var lastIdx = body.length - 1;
      function cjkCell(data) {
        if (CJK && _plLbHasCJK((data.cell.text || []).join(''))) { data.cell.styles.font = CJK; data.cell.styles.fontStyle = 'normal'; }
      }
      doc.autoTable({
        head: head, body: body, startY: 20, theme: 'grid',
        styles: { font: 'helvetica', fontSize: many ? 5.5 : 7, cellPadding: 1, overflow: 'linebreak', valign: 'middle' },
        headStyles: { fillColor: [40, 60, 90], textColor: 255, fontSize: many ? 5.5 : 6.5, halign: 'center', fontStyle: 'bold' },
        margin: { left: 8, right: 8 },
        didParseCell: function (data) {
          if (data.section === 'body' && data.row.index === lastIdx) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [225, 232, 240]; }
          cjkCell(data);
        },
      });
      // 附頁：機型統計
      if (opts.summary !== false) {
        var sy = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 20) + 8;
        var ph0 = doc.internal.pageSize.getHeight();
        if (sy > ph0 - 30) { doc.addPage(); sy = 14; }
        doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.text('Summary by Aircraft Type', 8, sy);
        var sbody = bt.map(function (t) { return [t.type, String(t.n), _plMinToHHMM(t.block), _plMinToHHMM(t.pic), _plMinToHHMM(t.sic), _plMinToHHMM(t.night)]; });
        var tot = { block: 0, pic: 0, sic: 0, night: 0, n: 0 };
        bt.forEach(function (t) { tot.block += t.block; tot.pic += t.pic; tot.sic += t.sic; tot.night += t.night; tot.n += t.n; });
        sbody.push(['TOTAL', String(tot.n), _plMinToHHMM(tot.block), _plMinToHHMM(tot.pic), _plMinToHHMM(tot.sic), _plMinToHHMM(tot.night)]);
        doc.autoTable({
          head: [['Type', 'Flights', 'Block', 'PIC', 'SIC', 'Night']], body: sbody, startY: sy + 3, theme: 'grid',
          styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: [40, 60, 90], textColor: 255, fontSize: 8 },
          margin: { left: 8, right: 8 }, tableWidth: 'wrap',
          didParseCell: function (data) { if (data.section === 'body' && data.row.index === sbody.length - 1) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [225, 232, 240]; } cjkCell(data); },
        });
      }
      // 頁尾頁碼 + 免責（全 ASCII）
      var pc = doc.internal.getNumberOfPages();
      for (var p = 1; p <= pc; p++) {
        doc.setPage(p); doc.setFontSize(6); doc.setFont('helvetica', 'normal'); doc.setTextColor(150);
        var pw = doc.internal.pageSize.getWidth(), phh = doc.internal.pageSize.getHeight();
        doc.text('Generated by Pilot Log - times in HH:MM - UTC - for reference', 8, phh - 5);
        doc.text('Page ' + p + ' / ' + pc, pw - 22, phh - 5);
      }
      doc.setTextColor(0);
      doc.save('logbook_' + fmt.id + '_' + r.from + '_' + r.to + '.pdf');
      _plToast('PDF 已產生 ' + src.length + ' 航班（iOS：分享 → 儲存到檔案）');
    }).catch(function (err) { _plToast('PDF 失敗：' + ((err && err.message) || err)); });
  }).catch(function (err) { _plToast('PDF 載入失敗：' + ((err && err.message) || err)); });
}

// 產生 PDF 的對話框（選格式 / 紙張 / 方向 / 附統計頁）
function _plOpenLogbookDialog() {
  if (document.getElementById('pl-lb-overlay')) return;
  var fmts = _plLbFormats(), r = _plReportRange();
  var fopt = fmts.map(function (f) { return '<option value="' + f.id + '">' + _plEsc(f.name) + '</option>'; }).join('');
  var iy = 'background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 8px;font-size:.82em;width:100%';
  var lbl = 'font-size:.7em;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:10px 0 3px;display:block';
  var ov = document.createElement('div');
  ov.id = 'pl-lb-overlay';
  ov.setAttribute('style', 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px');
  ov.onclick = function (ev) { if (ev.target === ov) _plCloseLogbookDialog(); };
  ov.innerHTML =
    '<div style="background:var(--card);border-radius:14px;max-width:420px;width:100%;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.45);max-height:90vh;overflow:auto">' +
      '<div style="font-size:1.05em;font-weight:700;margin-bottom:4px">📕 產生 Logbook PDF</div>' +
      '<div style="font-size:.66em;color:var(--muted);margin-bottom:6px">轉職交件用的人類可讀飛行紀錄簿 · Human-readable logbook for job applications</div>' +
      '<label style="' + lbl + '">格式 Format</label><select id="pl-lb-fmt" style="' + iy + '">' + fopt + '</select>' +
      '<label style="' + lbl + '">紙張 Paper</label><select id="pl-lb-paper" style="' + iy + '"><option value="a4">A4</option><option value="letter">Letter</option></select>' +
      '<label style="' + lbl + '">方向 Orientation</label><select id="pl-lb-orient" style="' + iy + '"><option value="landscape">橫式 Landscape</option><option value="portrait">直式 Portrait</option></select>' +
      '<label style="display:flex;align-items:center;gap:7px;margin-top:12px;font-size:.82em;cursor:pointer"><input type="checkbox" id="pl-lb-summary" checked> 附機型統計頁 Summary by type</label>' +
      '<div style="font-size:.68em;color:var(--muted);margin-top:10px;background:var(--input-bg);border-radius:8px;padding:8px">區間 Range：<b>' + _plEsc(r.from) + '</b> → <b>' + _plEsc(r.to) + '</b><br>（在上方 📅 Hours Summary 調整日期）</div>' +
      '<div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">' +
        '<button onclick="_plCloseLogbookDialog()" style="background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 14px;font-size:.82em;font-weight:700;cursor:pointer">取消</button>' +
        '<button onclick="_plLogbookGo()" style="background:#6366f1;color:#fff;border:0;border-radius:6px;padding:8px 18px;font-size:.82em;font-weight:700;cursor:pointer">產生 PDF</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
}
function _plCloseLogbookDialog() { var o = document.getElementById('pl-lb-overlay'); if (o) o.parentNode.removeChild(o); }
function _plLogbookGo() {
  var fmt = (document.getElementById('pl-lb-fmt') || {}).value || 'generic';
  var paper = (document.getElementById('pl-lb-paper') || {}).value || 'a4';
  var orient = (document.getElementById('pl-lb-orient') || {}).value || 'landscape';
  var summary = !!(document.getElementById('pl-lb-summary') || {}).checked;
  _plCloseLogbookDialog();
  _plGenLogbookPdf(fmt, { paper: paper, orientation: orient, summary: summary });
}
function _plExportCrewCsv() {
  var rows = (_pl.crew || []).map(function(c) {
    return [c.display_name || '', (Array.isArray(c.employee_ids) ? c.employee_ids.join('; ') : ''), c.organization || '', c.comment || '', c.is_self ? '1' : ''];
  });
  _plDownloadCsv('crew_addressbook.csv', ['Name', 'Employee IDs', 'Organization', 'Comment', 'This is Me'], rows);
  _plToast('Exported ' + rows.length + ' crew');
}
function _plExportAircraftCsv() {
  var rows = (_pl.aircraft || []).map(function(a) {
    return [a.tail_no || '', a.operator || '', a.type_code || '', a.make || '', a.model || '', a.notes || ''];
  });
  _plDownloadCsv('aircraft.csv', ['Tail', 'Operator', 'Type', 'Make', 'Model', 'Notes'], rows);
  _plToast('Exported ' + rows.length + ' aircraft');
}
function _plExportTypesCsv() {
  var rows = (_pl.aircraftTypes || []).map(function(t) {
    return [t.type_code || '', t.make || '', t.model || '', t.engine_type || '', t.category || '', t.class || '', t.notes || ''];
  });
  _plDownloadCsv('aircraft_types.csv', ['Type', 'Make', 'Model', 'Engine Type', 'Category', 'Class', 'Notes'], rows);
  _plToast('Exported ' + rows.length + ' types');
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

  // codex P2：背景預載全域機場庫（~317KB，不擋首屏）。預載後主頁/Report 的 IATA↔ICAO 切換、
  // 機場名稱、夜航座標才能涵蓋全世界機場，不必先進 Places/編輯器才生效。
  try { _plLoadAirports().then(_plPrefetchStarluxMaps); } catch (e) {}   // V2.0.03：庫載入後背景預抓 37 星宇航點離線地圖
}

// V1.3：同步觸發點 — 一回連 / 切回前景就自動補送 outbox（只註冊一次）
function _plRegisterSyncTriggers() {
  try {
    window.addEventListener('online', function() { _plReconnected(); });
    window.addEventListener('offline', function() { _plSetOffline(true); _plRenderSyncStatus(); });
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState !== 'visible') return;
      // V2.2.08：回前景時若還標離線，主動探一次（iOS online 事件常不觸發）→ 通了就清橫幅 + 重抓
      if (document.body.classList.contains('pl-offline')) {
        _plApi('/api/pilot-log/me').then(function(res){ if (res && res.ok) _plReconnected(); }).catch(function(){});
      }
      if (_plOnline() && _pl.outbox.length) _plSync();
    });
  } catch (e) {}
}
