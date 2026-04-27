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
  entries: [],
  filter: 'all',                 // all | draft | confirmed | roster_removed
  stats: null,
  aircraft: [],                  // pilot_aircraft
  suggest: { tail_nos: [], aircraft_types: [], airports: [] },
  editing: null,                 // entry being edited
  initialized: false,
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

async function _plTryRefresh() {
  if (!_pl.refreshToken) return false;
  try {
    var r = await fetch('/api/pilot-log/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: _pl.refreshToken }),
    });
    if (!r.ok) { _plClearSession(); return false; }
    var j = await r.json();
    _plSaveSession(j);
    return true;
  } catch (e) {
    return false;
  }
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

// === SECTION: list ══════════════════════════════════════════════════════════
async function _plFetchAll() {
  var q = '';
  if (_pl.filter !== 'all') q = '?status=' + _pl.filter;
  var [eRes, sRes, aRes, qRes] = await Promise.all([
    _plApi('/api/pilot-log/entries' + q),
    _plApi('/api/pilot-log/stats'),
    _plApi('/api/pilot-log/aircraft'),
    _plApi('/api/pilot-log/quick-suggest'),
  ]);
  if (eRes.ok) { var ej = await eRes.json(); _pl.entries = ej.entries || []; }
  if (sRes.ok) { _pl.stats = await sRes.json(); }
  if (aRes.ok) { var aj = await aRes.json(); _pl.aircraft = aj.aircraft || []; }
  if (qRes.ok) { _pl.suggest = await qRes.json(); }
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
    '<div style="flex:1"></div>' +
    filterBtn('all', 'All') + filterBtn('draft', 'Draft') +
    filterBtn('confirmed', 'Confirmed') + filterBtn('roster_removed', 'Removed') +
    '<button onclick="_plLogout()" style="background:transparent;color:var(--muted);border:0;font-size:.7em;cursor:pointer;margin-left:8px">Logout</button>' +
    '</div>';
}

function _plRenderEntryRow(e) {
  var statusColor = { draft: '#f59e0b', confirmed: '#10b981', roster_removed: '#94a3b8' }[e.status] || '#94a3b8';
  var time = '';
  if (e.out_utc && e.in_utc) time = _plFmtUtcHHMM(e.out_utc) + ' → ' + _plFmtUtcHHMM(e.in_utc) + 'z';
  else if (e.std_utc && e.sta_utc) time = _plFmtUtcHHMM(e.std_utc) + '/' + _plFmtUtcHHMM(e.sta_utc) + 'z (sched)';
  return '<div onclick="_plOpenEditor(\'' + e.id + '\')" ' +
    'style="background:var(--card);border-radius:8px;padding:10px;margin-bottom:6px;cursor:pointer;display:flex;gap:10px;align-items:center">' +
    '<div style="width:6px;height:38px;background:' + statusColor + ';border-radius:3px"></div>' +
    '<div style="min-width:90px"><div style="font-size:.78em;font-weight:700">' + _plFmtDate(e.flight_date) + '</div>' +
      '<div style="font-size:.66em;color:var(--muted)">' + _plEsc(e.flight_no || '') + '</div></div>' +
    '<div style="min-width:120px;font-size:.78em">' + _plEsc(e.origin || '???') + ' → ' + _plEsc(e.dest || '???') + '</div>' +
    '<div style="min-width:90px;font-size:.7em;color:var(--muted)">' + _plEsc(e.aircraft_type || '') +
      (e.tail_no ? ' / ' + _plEsc(e.tail_no) : '') + '</div>' +
    '<div style="min-width:90px;font-size:.68em;color:var(--muted)">' + time + '</div>' +
    '<div style="min-width:60px;font-size:.74em;text-align:right">' + (e.block_minutes ? _plMinToHHMM(e.block_minutes) : '—') + '</div>' +
    '<div style="min-width:50px;font-size:.62em;text-align:right;color:' + statusColor + '">' + (e.position || '') + '</div>' +
    '</div>';
}

function _plRenderList() {
  var c = document.getElementById('pl-list');
  if (!c) return;
  if (_pl.entries.length === 0) {
    c.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px;font-size:.85em">' +
      (_pl.filter === 'all' ? '尚無紀錄。點 <b>+ New Entry</b> 新增，或 <b>📥 Import</b> 匯入 LogTen Pro 資料。' : '此分類無紀錄。') +
    '</div>';
    return;
  }
  c.innerHTML = _pl.entries.map(_plRenderEntryRow).join('');
}

function _plSetFilter(f) {
  _pl.filter = f;
  _plRefreshMain();
}

async function _plRefreshMain() {
  await _plFetchAll();
  _plRenderMain();
}

function _plRenderMain() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
  if (!_pl.user) { _plRenderLogin(); return; }
  c.innerHTML =
    '<div style="padding:10px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<div style="font-size:.7em;color:var(--muted)">' + _plEsc(_pl.user.primaryEmail || '') + '</div>' +
      '</div>' +
      _plRenderStats() +
      _plRenderToolbar() +
      '<div id="pl-list"></div>' +
    '</div>';
  _plRenderList();
}

function _plRenderLogin() {
  var c = document.getElementById('pilotlog-content');
  if (!c) return;
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
    var e = _pl.entries.filter(function(x) { return x.id === id; })[0];
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
  _plRenderEditor();
}

function _plCloseEditor() {
  _pl.editing = null;
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
  } else {
    input = '<input ' + attrs + ' value="' + _plEsc(val) + '"' + (opts.placeholder ? ' placeholder="' + _plEsc(opts.placeholder) + '"' : '') + '>';
  }
  if (type === 'check') return '<div style="margin-bottom:8px">' + input + '</div>';
  return '<div style="margin-bottom:8px">' +
    '<div style="font-size:.62em;color:var(--muted);margin-bottom:2px">' + _plEsc(label) + '</div>' +
    input + '</div>';
}

function _plRenderEditor() {
  var c = document.getElementById('pilotlog-content');
  if (!c || !_pl.editing) return;
  var e = _pl.editing;
  var statusBadge = e.id ? (
    '<span style="background:' +
    ({ draft:'#f59e0b', confirmed:'#10b981', roster_removed:'#94a3b8' }[e.status] || '#666') +
    ';color:#fff;border-radius:10px;padding:2px 8px;font-size:.62em;margin-left:8px">' + e.status + '</span>'
  ) : '';

  var typeOptions = ['', 'A321', 'A359', 'A35K', 'B777-300ER', 'B789', 'B78X'].concat(_pl.suggest.aircraft_types || []);
  typeOptions = Array.from(new Set(typeOptions));

  c.innerHTML =
    '<div style="padding:10px;max-width:760px;margin:0 auto">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
      '<button onclick="_plCloseEditor()" style="background:transparent;border:0;color:var(--text);font-size:1.2em;cursor:pointer">←</button>' +
      '<div style="font-size:1em;font-weight:700">' + (e.id ? 'Edit Entry' : 'New Entry') + '</div>' + statusBadge +
      '<div style="flex:1"></div>' +
      (e.id && e.status !== 'confirmed' ? '<button onclick="_plSaveEntry(true)" style="background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Confirm</button>' : '') +
      '<button onclick="_plSaveEntry(false)" style="background:#3b82f6;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Save</button>' +
      (e.id ? '<button onclick="_plDeleteEntry()" style="background:transparent;color:#ef4444;border:1px solid #ef4444;border-radius:6px;padding:6px 10px;font-size:.74em;cursor:pointer">Delete</button>' : '') +
    '</div>' +

    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;background:var(--card);border-radius:10px;padding:12px">' +
      '<div style="grid-column:span 2">' + _plEditorField('Date', 'flight_date', 'text') + '</div>' +
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
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">✈️ Flights (Tab 動態匯出)</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        'LogTen Pro 6 → File → Export → Dynamic Export Flights (Tab)。<br>' +
        '必填欄位：Date / Flight # / From / To / Aircraft Type / Aircraft ID / Out / In / On Duty / Off Duty / PIC/P1 / SIC/P2。' +
      '</div>' +
      '<input type="file" id="pl-flights-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<button onclick="_plUploadFlights()" style="margin-left:8px;background:#10b981;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Upload</button>' +
    '</div>' +
    '<div style="background:var(--card);border-radius:10px;padding:14px">' +
      '<div style="font-size:.85em;font-weight:700;margin-bottom:6px">🛩️ Aircraft (Tab 匯出，選用)</div>' +
      '<div style="font-size:.7em;color:var(--muted);margin-bottom:8px;line-height:1.5">' +
        '建你的機尾庫，之後新增 entry 時 tail # 可自動帶 operator/type/notes。<br>' +
        '必填欄位：Aircraft ID / Operator / Type。' +
      '</div>' +
      '<input type="file" id="pl-aircraft-file" accept=".txt,.tab,.tsv,text/plain" style="font-size:.78em">' +
      '<button onclick="_plUploadAircraft()" style="margin-left:8px;background:#6366f1;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:.78em;font-weight:700;cursor:pointer">Upload</button>' +
    '</div>' +
    '<div id="pl-import-result" style="margin-top:14px"></div>' +
    '</div>';
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

async function _plUploadFlights() {
  var j = await _plUploadFile('pl-flights-file', '/api/pilot-log/import/logten-flights');
  if (!j) return;
  var resBox = document.getElementById('pl-import-result');
  if (j.error) {
    resBox.innerHTML = '<div style="background:#7f1d1d;color:#fff;padding:10px;border-radius:8px;font-size:.78em">❌ ' + _plEsc(j.error) + '</div>';
  } else {
    resBox.innerHTML = '<div style="background:#064e3b;color:#fff;padding:10px;border-radius:8px;font-size:.78em">' +
      '✅ 匯入完成：新增 <b>' + j.inserted + '</b>、重複略過 <b>' + j.duplicate_skipped + '</b>、解析失敗 <b>' + j.parse_errors + '</b>' +
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
  }
  if (_pl.editing) { _plRenderEditor(); return; }
  if (_pl.user) {
    await _plFetchAll();
    _plRenderMain();
  } else {
    _plRenderLogin();
  }
}
