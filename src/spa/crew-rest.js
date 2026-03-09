// ── ⏳ 輪休計算 (Crew Rest Calculator) ────────────────────────────────────────
var _crLoaded = false;
var _crPerPerson = 0; // minutes

function crewrestInit() {
  if (_crLoaded) return;
  _crLoaded = true;
  var restored = _crRestore();
  if (!restored) {
    _crOnCrewChange();
  }
  // 提示卡飛行時間永遠覆蓋（source of truth）
  _crSyncFtFromBrief();
}

/* ── 從提示卡帶入飛行時間 ── */
function _crSyncFtFromBrief() {
  var fhEl = document.getElementById('cr-fh');
  var fmEl = document.getElementById('cr-fm');
  if (!fhEl || !fmEl) return;
  if (typeof _briefFltHr === 'undefined' || typeof _briefFltMin === 'undefined') return;
  if (!_briefFltHr && !_briefFltMin) return; // 提示卡無資料則不動
  fhEl.value = _briefFltHr || '';
  fmEl.value = _briefFltMin || '';
  crewrestCalc();
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
  // 清除 Rest Start / TOD
  var startEl = document.getElementById('cr-start');
  if (startEl) startEl.value = '';
  var todEl = document.getElementById('cr-tod');
  if (todEl) todEl.value = '';
  var todBox = document.getElementById('cr-tod-box');
  if (todBox) todBox.style.display = 'none';
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
