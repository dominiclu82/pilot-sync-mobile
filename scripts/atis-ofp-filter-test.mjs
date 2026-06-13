// 驗證 _atisPickKind 的 OFP 排除 + 真 ATIS 保留（regex 跟 server.ts 同寫法）
function filt(msgs, kind, icao) {
  const ico = (icao || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const icoPat = /^[A-Z]{4}$/.test(ico) ? ico : '[A-Z]{4}';
  const reKind = new RegExp('\\b' + icoPat + '\\s+' + kind + '\\s+ATIS\\b');
  const reCombo = new RegExp('\\b' + icoPat + '\\s+ATIS\\s+[A-Z]\\b');
  const reComboNA = new RegExp('\\b' + icoPat + '\\s+ATIS\\b[\\s\\S]{0,15}NOT\\s+AVAIL', 'i');
  return msgs.filter((m) => {
    const t = String(m.text || '');
    if (kind === 'ATIS') { if (/\b[A-Z]{4}\s+(?:ARR|DEP)\s+ATIS\b/.test(t)) return false; return reCombo.test(t) || reComboNA.test(t); }
    return reKind.test(t);
  });
}
const ofp = { text: 'AES:4C0223 GES:D0 .YU-ARD ... ALTN LOWW 5103 0053 ... DEP ATC CLRN:\n------\nDEP ATIS \n------\n PLANNED FUEL UPLINK PART 1 OF 14' };
const realDep = { text: 'LOWW DEP ATIS Z\n0750Z START OF DATA DEP\nDEP RWY 29\nQNH 1023' };
const realArr = { text: 'LOWW ARR ATIS Z\n0750Z START OF DATA ARR\nARR RWY 34 ILS\nQNH 1023' };
const na = { text: 'RJAA ATIS NOT AVAILABLE' };
const combo = { text: 'EDDF ATIS X\nRWY 25 QNH 1013' };
const otherDep = { text: 'EDDF DEP ATIS Y QNH 1013 ALTN LOWW' };
const cases = [
  ['OFP 當 LOWW DEP', filt([ofp], 'DEP', 'LOWW').length, 0],
  ['真 LOWW DEP', filt([realDep], 'DEP', 'LOWW').length, 1],
  ['真 LOWW ARR', filt([realArr], 'ARR', 'LOWW').length, 1],
  ['OFP+真DEP 混在一起當 LOWW DEP', filt([ofp, realDep], 'DEP', 'LOWW').length, 1],
  ['RJAA NOT AVAIL 當 ATIS', filt([na], 'ATIS', 'RJAA').length, 1],
  ['EDDF 合併 ATIS', filt([combo], 'ATIS', 'EDDF').length, 1],
  ['別場 EDDF DEP 不該當 LOWW DEP', filt([otherDep], 'DEP', 'LOWW').length, 0],
];
let ok = true;
for (const [name, got, want] of cases) { const pass = got === want; if (!pass) ok = false; console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' → ' + got + ' (want ' + want + ')'); }
process.exit(ok ? 0 : 1);
