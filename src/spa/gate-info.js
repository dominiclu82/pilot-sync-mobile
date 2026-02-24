// ── Gate Info ──────────────────────────────────────────────────────────────────
var gateFlightsLoaded = false;

function giFmtTime(t) {
  if (!t) return '';
  return t.replace(/:00$/, '');
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

  fetch('/api/fids')
    .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(data) {
      if (data.error) throw new Error(data.error);

      dateEl.textContent = data.date || '';

      var dep = (data.dep || []).filter(function(f) { return f.ACode === 'JX'; });
      var arr = (data.arr || []).filter(function(f) { return f.ACode === 'JX'; });

      // Merge by flight number
      var map = {};

      dep.forEach(function(f) {
        var key = 'JX' + f.FlightNo.replace(/\s/g, '');
        if (!map[key]) map[key] = { fno: key };
        var m = map[key];
        m.origin = 'TPE';
        m.dest = f.CityCode || '';
        m.destName = f.CityName || f.CityCode || '';
        m.checkin = f.CheckIn || '';
        m.gate = f.Gate || '';
        m.std = giFmtTime(f.OTime);
        m.atd = giFmtTime(f.RTime);
        m.depTerminal = f.BNO ? 'T' + f.BNO : '';
        m.depMemo = f.Memo || '';
      });

      arr.forEach(function(f) {
        var key = 'JX' + f.FlightNo.replace(/\s/g, '');
        if (!map[key]) map[key] = { fno: key };
        var m = map[key];
        m.originCode = f.CityCode || '';
        m.originName = f.CityName || f.CityCode || '';
        if (!m.origin) m.origin = f.CityCode || '';
        m.dest = m.dest || 'TPE';
        m.parking = f.Gate || '';
        m.carousel = f.StopCode || '';
        m.sta = giFmtTime(f.OTime);
        m.ata = giFmtTime(f.RTime);
        m.arrTerminal = f.BNO ? 'T' + f.BNO : '';
        m.arrMemo = f.Memo || '';
      });

      var flights = Object.values(map);
      flights.sort(function(a, b) {
        return a.fno.localeCompare(b.fno, undefined, { numeric: true });
      });

      if (flights.length === 0) {
        statusEl.textContent = '今日無 JX 航班資料';
        return;
      }

      statusEl.style.display = 'none';
      wrapEl.style.display = '';

      flights.forEach(function(f) {
        var tr = document.createElement('tr');

        // For origin display: if it came from departure data, origin is TPE; from arrival, use originName
        var originDisplay = '';
        if (f.originName) {
          originDisplay = f.originName;
        } else if (f.origin) {
          originDisplay = f.origin;
        }

        // For dest display: if it came from departure data, use destName; from arrival, dest is TPE
        var destDisplay = '';
        if (f.destName) {
          destDisplay = f.destName;
        } else if (f.dest) {
          destDisplay = f.dest;
        }

        var cells = [
          { val: f.fno, cls: 'gi-fno' },
          { val: originDisplay || '—' },
          { val: f.checkin || '—' },
          { val: f.gate || '—' },
          { val: f.std || '—' },
          { val: f.atd || '—', cls: (f.atd && f.std && f.atd !== f.std) ? 'gi-actual' : '' },
          { val: destDisplay || '—' },
          { val: f.parking || '—' },
          { val: f.carousel || '—' },
          { val: f.sta || '—' },
          { val: f.ata || '—', cls: (f.ata && f.sta && f.ata !== f.sta) ? 'gi-actual' : '' }
        ];

        cells.forEach(function(c, idx) {
          var td = document.createElement('td');
          td.textContent = c.val;
          if (c.cls) td.className = c.cls;
          if (idx === 0) td.className = 'gi-fno gi-sticky-col';
          tr.appendChild(td);
        });

        // Memo as tooltip
        var memo = [f.depMemo, f.arrMemo].filter(Boolean).join(' / ');
        if (memo) tr.title = memo;

        tableBody.appendChild(tr);
      });

      gateFlightsLoaded = true;
    })
    .catch(function(e) {
      statusEl.textContent = '載入失敗：' + e.message;
      statusEl.style.display = 'block';
    });
}

function refreshGateFlights() {
  loadGateFlights();
}
