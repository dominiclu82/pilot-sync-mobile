// ── PA 工具 ──────────────────────────────────────────────────────────────────

// ── 溫度換算 ─────────────────────────────────────────────────────────────────
function paConvertTemp(from) {
  var cEl = document.getElementById('pa-temp-c');
  var fEl = document.getElementById('pa-temp-f');
  if (from === 'c') {
    var c = parseFloat(cEl.value);
    fEl.value = isNaN(c) ? '' : Math.round(c * 9 / 5 + 32);
  } else {
    var f = parseFloat(fEl.value);
    cEl.value = isNaN(f) ? '' : Math.round((f - 32) * 5 / 9);
  }
}

// ── 時區列表 ─────────────────────────────────────────────────────────────────
var _paTzZones = [
  { stations: 'UTC', offset: 0, dst: false },
  { stations: 'TPE', offset: 8, dst: false },
  { stations: 'LAX / SFO / SEA', offset: -8, dst: true, dstOffset: -7, dstLabel: 'PDT' },
  { stations: 'PHX', offset: -7, dst: false },
  { stations: 'PRG', offset: 1, dst: true, dstOffset: 2, dstLabel: 'CEST' },
  { stations: 'BKK / SGN / CGK', offset: 7, dst: false },
  { stations: 'HKG / MFM / SIN', offset: 8, dst: false },
  { stations: 'NRT / ICN', offset: 9, dst: false }
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
    html += '<div class="' + rowClass + '">' +
      '<span class="pa-tz-stations">' + z.stations + '</span>' +
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
}

// ── PA 廣播詞內容 ────────────────────────────────────────────────────────────
var _paCurrentCat = 'welcome';
var _paScripts = {};

_paScripts.welcome = '<div class="pa-note">When all passengers are boarded, the CIC will inform the PIC to make a brief welcome PA.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is Captain <input class="pa-input" placeholder="Full Name"> speaking. On behalf of <span class="pa-choice">[the cockpit crew / all the crew]</span>, welcome onboard STARLUX flight number <input class="pa-input" placeholder="FLT No."> to <input class="pa-input" placeholder="Destination">. We should be ready for departure in <input class="pa-input pa-input-num" inputmode="numeric"> minutes. Our flight time is <input class="pa-input pa-input-num" inputmode="numeric"> hours and <input class="pa-input pa-input-num" inputmode="numeric"> minutes, with an initial cruising altitude of <input class="pa-input" inputmode="numeric" style="min-width:70px" placeholder="XX,XXX"> feet. Once again, please make yourself comfortable and enjoy the flight with us. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，我是機長 <input class="pa-input" placeholder="姓名">。代表<span class="pa-choice">[駕駛艙組員 / 全體組員]</span>，歡迎搭乘星宇航空 <input class="pa-input" placeholder="航班號"> 班機前往 <input class="pa-input" placeholder="目的地">。我們預計在 <input class="pa-input pa-input-num" inputmode="numeric"> 分鐘後出發。飛行時間約 <input class="pa-input pa-input-num" inputmode="numeric"> 小時 <input class="pa-input pa-input-num" inputmode="numeric"> 分鐘，初始巡航高度 <input class="pa-input" inputmode="numeric" style="min-width:70px"> 呎。再次祝您旅途愉快，謝謝。」</div>';

_paScripts.delay = '<div class="pa-note">If ground delay is expected to be more than 15 minutes before pushback, a ground delay PA should be delivered.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your captain speaking. Due to <input class="pa-input" placeholder="Delay Reason">, we might be delayed up to <input class="pa-input pa-input-num" inputmode="numeric"> minutes before takeoff. I will keep you updated if longer delay happens. Thank you for your patient."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，這裡是機長廣播。由於 <input class="pa-input" placeholder="延誤原因">，我們可能需要延遲約 <input class="pa-input pa-input-num" inputmode="numeric"> 分鐘後才能起飛。如有更長時間的延誤，我會再向各位報告。感謝您的耐心等候。」</div>';

_paScripts.descent = '<div class="pa-note">The PA shall be given around 10 minutes before top of descent.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your captain speaking. We are approaching <input class="pa-input" placeholder="Destination"> and expect to start our descent in 10 minutes. We estimate landing at <input class="pa-input pa-input-num" inputmode="numeric" style="min-width:50px" placeholder="HH:MM"> <span class="pa-choice">[a.m. / p.m.]</span>. The current local time in <input class="pa-input" placeholder="Destination"> is <input class="pa-input pa-input-num" inputmode="numeric" style="min-width:50px" placeholder="HH:MM"> <span class="pa-choice">[a.m. / p.m.]</span> on <input class="pa-input" placeholder="Day and Date">. The present weather at the airport is <input class="pa-input" placeholder="Weather Condition"> with a temperature of <input class="pa-input pa-input-num" inputmode="numeric"> degree Celsius, which is <input class="pa-input pa-input-num" inputmode="numeric"> degree Fahrenheit. We certainly hope that you have enjoyed the flight with us, and we look forward to having you onboard another STARLUX flight again very soon. Thank you, and we wish you all a very pleasant journey."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，這裡是機長廣播。我們即將接近 <input class="pa-input" placeholder="目的地">，預計在 10 分鐘後開始下降。預計落地時間為 <span class="pa-choice">[上午 / 下午]</span> <input class="pa-input pa-input-num" inputmode="numeric" style="min-width:50px" placeholder="HH:MM">。<input class="pa-input" placeholder="目的地"> 當地時間為 <input class="pa-input" placeholder="星期與日期"> <span class="pa-choice">[上午 / 下午]</span> <input class="pa-input pa-input-num" inputmode="numeric" style="min-width:50px" placeholder="HH:MM">。目前機場天氣為 <input class="pa-input" placeholder="天氣狀況">，氣溫攝氏 <input class="pa-input pa-input-num" inputmode="numeric"> 度，華氏 <input class="pa-input pa-input-num" inputmode="numeric"> 度。非常感謝各位搭乘星宇航空，期待再次為您服務。祝各位旅途愉快。」</div>';

_paScripts.turbulence = '<div class="pa-sub">i. Approaching an Area of Known or Forecast Turbulence</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your Captain speaking. We will soon be flying through an area with light to moderate turbulence. We have already made <span class="pa-choice">[changes to our route and altitude / deviations]</span> to provide you with the smoothest flight possible. To ensure your safety, please stay in your seats and fasten your seat belt."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，這裡是機長廣播。我們即將通過一個輕度到中度亂流區域。我們已經 <span class="pa-choice">[調整航路和高度 / 偏航]</span> 以提供最平穩的飛行。為了您的安全，請留在座位上並繫好安全帶。」</div>' +
  '<div class="pa-sub">ii. To ask cabin crew to be seated</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"For the safety of the cabin crew, I have asked them to stop the inflight service, take their seats, and remain seated, until we have passed through this area. We apologize for any inconvenience. The inflight service will resume as soon as flight conditions permit. We expect that these conditions to last for approximately <input class="pa-input pa-input-num" inputmode="numeric"> minutes. <span class="pa-choice">(If estimate of the period of turbulence is known)</span> Your cooperation and understanding are always appreciated. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「為了組員的安全，我已請空服員暫停機上服務並回座就位，待我們通過此區域後再恢復。造成不便敬請見諒，機上服務將在飛行條件允許時盡快恢復。預計此狀況將持續約 <input class="pa-input pa-input-num" inputmode="numeric"> 分鐘。<span class="pa-choice">（如已知亂流持續時間）</span>感謝您的配合與理解。」</div>' +
  '<div class="pa-sub">iii. If more turbulence is forecast</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"However, it is possible that we may experience some light turbulence <span class="pa-choice">[later / during descent]</span>. I will provide you with an update before we start our descent. We invite you to relax and enjoy the remainder of the flight to <input class="pa-input" placeholder="Destination">. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「不過，<span class="pa-choice">[稍後 / 下降過程中]</span> 可能還會遇到輕微亂流。在開始下降前我會再向各位報告。請放鬆心情，享受飛往 <input class="pa-input" placeholder="目的地"> 的剩餘旅程。謝謝。」</div>';

_paScripts.deice = '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, welcome on board. This is your Captain speaking. Today we must complete a procedure to protect the aircraft against the build-up of ice. And we will be on ground for <input class="pa-input pa-input-num" inputmode="numeric"> minutes. <span class="pa-choice">(If delay)</span> This will involve the spraying of a fluid on the aircraft; there may be some noise during this process and, possibly, a slightly unusual smell inside of the cabin. The procedure is routine and should be completed in a few minutes. Thank you for your attention."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，歡迎登機。這裡是機長廣播。今天我們需要進行除冰/防冰程序以保護飛機。我們將在地面等候約 <input class="pa-input pa-input-num" inputmode="numeric"> 分鐘。<span class="pa-choice">（如有延遲）</span>過程中會在機身噴灑除冰液，期間可能會有一些噪音，機艙內也可能聞到些許異味。這是例行程序，幾分鐘內即可完成。感謝您的配合。」</div>';

_paScripts.missedappr = '<div class="pa-note">The PA should be done after the aircraft has leveled at missed approach altitude with completion of the After Takeoff Checklist, and before the start of next approach.</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"May we have your attention. This is your Captain speaking. We were unable to complete our approach to landing at <input class="pa-input" placeholder="Airport">. We have just completed a routine go-around procedure and, shortly, we shall be starting another approach to land. We will be landing in <input class="pa-input pa-input-num" inputmode="numeric"> minutes. Thank you for your attention."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客請注意。這裡是機長廣播。我們無法完成在 <input class="pa-input" placeholder="機場"> 的進場降落。我們剛剛已完成例行的重飛程序，稍後將再次進場降落。預計在 <input class="pa-input pa-input-num" inputmode="numeric"> 分鐘後落地。感謝您的配合。」</div>';

_paScripts.diversion = '<div class="pa-lang">English</div>' +
  '<div>"May we have your attention. This is your Captain speaking. The weather at <input class="pa-input" placeholder="Destination"> airport is below landing minimum, we are unable to land at this moment. We shall divert to <input class="pa-input" placeholder="Alternate"> airport, and we can wait for the weather at <input class="pa-input" placeholder="Destination"> airport to improve."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客請注意。這裡是機長廣播。<input class="pa-input" placeholder="目的地"> 機場天氣低於降落標準，目前無法降落。我們將轉降至 <input class="pa-input" placeholder="備降機場">，等待 <input class="pa-input" placeholder="目的地"> 機場天氣改善。」</div>';

_paScripts.modsevcat = '<div class="pa-sub">i. Normal</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"Hello everyone, this is your Captain speaking. We have just encountered an area of <span class="pa-choice">[moderate / severe]</span> Clear Air Turbulence. The aircraft condition is safe, with all systems operating normally. This type of turbulence cannot be detected with our system and was unexpected. We appreciate your cooperation to stay in your seats with seatbelt fasten until the seatbelt sign is turned off."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位旅客大家好，這裡是機長廣播。我們剛剛遭遇了一個 <span class="pa-choice">[中度 / 強烈]</span> 晴空亂流區域。飛機狀態安全，所有系統運作正常。此類亂流無法被系統偵測且為突發狀況。請您配合留在座位上繫好安全帶，直到安全帶指示燈熄滅為止。」</div>' +
  '<div class="pa-sub">ii. If damage to cabin or injury</div>' +
  '<div class="pa-lang">English</div>' +
  '<div>"The cabin crew are now making every effort to safeguard the condition of everyone onboard. If you need assistance, the crew will help you as soon as possible. We appreciate your cooperation to stay in your seats until the seatbelt sign is turned off. After an assessment of conditions onboard are completed, I will provide you with more information regarding the status of the flight. Your cooperation and understanding are appreciated to ensure the safety of all onboard. Thank you."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「空服員正全力確保機上每位旅客的狀況。如果您需要協助，組員會盡快前來幫忙。請您配合留在座位上，直到安全帶指示燈熄滅為止。在完成機上狀況評估後，我會再向各位報告航班最新資訊。感謝您的配合與理解，以確保機上所有人員的安全。謝謝。」</div>';

_paScripts.unrulypax = '<div class="pa-lang">English</div>' +
  '<div>"This is your captain speaking. The passenger at <input class="pa-input" placeholder="Seat Number">, we have already warned you about your unacceptable behavior and requested you to moderate it. This is the FINAL WARNING that your unruly behavior has violated the above laws and regulations. If the unruly behavior remains, it may be committed a criminal offence, and you may be restrained and handed over to the aviation security authorities. Punishment may be imposed against you, including but not limited to imprisonment, detention or monetary fine. If there is any diversion, stop over or delay caused by your unruly behavior, STARLUX Airlines shall be entitled to request you for any and all losses, expenses and damages incurred from such circumstances. PLEASE NOW COOPERATE WITH OUR CREW MEMBERS IN AN AMICABLE WAY."</div>' +
  '<div class="pa-lang">中文</div>' +
  '<div>「各位女士、各位先生，這裡是機長廣播，我現在鄭重的對座位在 <input class="pa-input" placeholder="座位號碼">（及其附近）的乘客提出警告，您現在的行為已經嚴重的違反了中華民國民用航空法。現在請您立即停止滋擾他人及破壞客艙安寧的行為，並依照空服人員的指示配合執行！若因您的行為而造成飛機的延誤、轉降或公司任何損失，公司將依法向您個人提出求償！感謝您們的理解與配合，謝謝！」</div>';

// ── PA 分類切換 ──────────────────────────────────────────────────────────────
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
}
