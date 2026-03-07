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
