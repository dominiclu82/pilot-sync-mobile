/**
 * parseTab unit tests (V1.0.06)
 *
 * 純函式測試，不啟 server、不打 DB。針對 TSV state machine parser
 * 覆蓋 codex 指定的 6 類核心 + 4 個 care points + 額外 edge cases。
 *
 * 用法：npm run test:parser
 */

import { parseTab } from '../src/pilot-log/tsv-parser.js';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

function eq(actual: any, expected: any, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg}\n     expected: ${e}\n     actual:   ${a}`);
  }
}

console.log('\n📑 parseTab unit tests\n');

// ── Codex 6 類核心 ──────────────────────────────────────────────────────────

console.log('🎯 Codex 指定 6 類:');

check('1. 單行普通欄位（unquoted）', () => {
  const r = parseTab('Date\tFlight\n2026-01-01\tJX800');
  eq(r.headers, ['Date', 'Flight'], 'headers');
  eq(r.rows, [{ Date: '2026-01-01', Flight: 'JX800' }], 'rows');
});

check('2. 單行 quoted（含 comma / 不被當欄位分隔）', () => {
  const r = parseTab('Date\tRemarks\n2026-01-01\t"hello, world"');
  eq(r.rows, [{ Date: '2026-01-01', Remarks: 'hello, world' }], 'rows');
});

check('3. 多行 quoted Remarks（embedded \\n 不當 row 分隔）', () => {
  const r = parseTab('Date\tRemarks\n2026-01-01\t"line1\nline2\nline3"');
  eq(r.rows, [{ Date: '2026-01-01', Remarks: 'line1\nline2\nline3' }], 'rows');
  eq(r.rows.length, 1, '多行 quoted 仍是 1 筆 row');
});

check('4. Escaped quote ""（quote 內的兩個 " 變一個）', () => {
  const r = parseTab('Date\tRemarks\n2026-01-01\t"He said ""hi"" today"');
  eq(r.rows, [{ Date: '2026-01-01', Remarks: 'He said "hi" today' }], 'rows');
});

check('5. 最後一欄是 quoted multiline（EOF 緊鄰）', () => {
  const text = 'Date\tFlight\tRemarks\n2026-01-01\tJX800\t"line1\nline2\nline3"';
  const r = parseTab(text);
  eq(r.rows, [{ Date: '2026-01-01', Flight: 'JX800', Remarks: 'line1\nline2\nline3' }], 'rows');
});

check('6. 空欄位 + 尾端 tab', () => {
  const r = parseTab('A\tB\tC\nv1\t\tv3');
  eq(r.rows, [{ A: 'v1', B: '', C: 'v3' }], '中間空欄位');

  // 真實 LogTen 多筆會在 row 結尾有 trailing \t（多餘空欄位，無對應 header）
  const r2 = parseTab('A\tB\nv1\tv2\t');
  eq(r2.rows, [{ A: 'v1', B: 'v2' }], 'trailing tab 不該影響有效欄位');
});

// ── Codex 4 care points ──────────────────────────────────────────────────────

console.log('\n🛡️ Codex care points:');

check('BOM (U+FEFF) 處理（檔頭被吃掉、不污染 header）', () => {
  const r = parseTab('﻿Date\tFlight\n2026-01-01\tJX800');
  eq(r.headers, ['Date', 'Flight'], 'headers 沒帶 BOM');
  eq(r.rows[0].Date, '2026-01-01', 'first row 正常');
});

check('Line endings: \\n / \\r\\n / \\r 都吃', () => {
  const lf = parseTab('A\tB\nv1\tv2');
  const crlf = parseTab('A\tB\r\nv1\tv2');
  const cr = parseTab('A\tB\rv1\tv2');
  eq(lf.rows, [{ A: 'v1', B: 'v2' }], 'LF');
  eq(crlf.rows, [{ A: 'v1', B: 'v2' }], 'CRLF');
  eq(cr.rows, [{ A: 'v1', B: 'v2' }], 'CR');
});

check('檔案結尾沒 newline 不漏最後一筆', () => {
  const r = parseTab('Date\tFlight\n2026-01-01\tJX800');  // 結尾無 \n
  eq(r.rows.length, 1, '最後一筆 entry 進去');
  eq(r.rows[0].Flight, 'JX800', '欄位值正確');
});

check('Quoted close 後接非 tab/newline 字元 → 嚴格 throw', () => {
  let threw = false;
  try {
    parseTab('A\tB\nv1\t"end"junk');
  } catch (e: any) {
    threw = true;
    if (!e.message.includes('after closing quote')) {
      throw new Error(`error 訊息應該提到 closing quote，實際: ${e.message}`);
    }
  }
  if (!threw) throw new Error('expected throw on malformed close quote');
});

// ── 額外 edge cases ─────────────────────────────────────────────────────────

console.log('\n🔬 Extra edge cases:');

check('多筆 row 中間夾雜多行 quoted（最關鍵的 LogTen 真實情境）', () => {
  const text =
    'Date\tFlight\tRemarks\n' +
    '2026-01-01\tJX800\tplain remark 1\n' +
    '2026-01-02\tJX801\t"multi line\nwith embedded\nnewlines"\n' +
    '2026-01-03\tJX802\tplain remark 3';
  const r = parseTab(text);
  eq(r.rows.length, 3, '應該有 3 筆 row（不是 5 筆）');
  eq(r.rows[0].Remarks, 'plain remark 1', 'row 1 plain');
  eq(r.rows[1].Remarks, 'multi line\nwith embedded\nnewlines', 'row 2 multi-line preserved');
  eq(r.rows[2].Remarks, 'plain remark 3', 'row 3 plain');
});

check('Empty quoted field ""', () => {
  const r = parseTab('A\tB\nv1\t""');
  eq(r.rows, [{ A: 'v1', B: '' }], 'empty quoted = empty string');
});

check('Quoted field 內含 tab（不當欄位分隔）', () => {
  const r = parseTab('A\tB\nv1\t"with\tembedded\ttabs"');
  eq(r.rows, [{ A: 'v1', B: 'with\tembedded\ttabs' }], 'embedded tabs preserved');
});

check('Unterminated quote at EOF → throw', () => {
  let threw = false;
  try {
    parseTab('A\tB\nv1\t"never closed');
  } catch (e: any) {
    threw = true;
    if (!e.message.includes('unterminated')) {
      throw new Error(`error 訊息應該提到 unterminated，實際: ${e.message}`);
    }
  }
  if (!threw) throw new Error('expected throw on unterminated quote');
});

check('全空白 row 跳過', () => {
  const r = parseTab('A\tB\n\nv1\tv2\n\n');
  eq(r.rows.length, 1, '中間跟結尾的空 row 被跳過');
});

check('Quote 在 field 中間（不在 field 開頭）→ 當 data 不進 quoted mode', () => {
  const r = parseTab('A\tB\nstart"middle\tend');
  // start"middle 不是 quoted（因為 " 不在 field 開頭），所以 \t 還是欄位分隔
  eq(r.rows, [{ A: 'start"middle', B: 'end' }], '中間的 " 是 data');
});

check('CRLF + quoted multi-line（embedded \\n 在 quoted 內，row 終止用 \\r\\n）', () => {
  const text = 'A\tB\r\nv1\t"line1\nline2"\r\nv3\tv4';
  const r = parseTab(text);
  eq(r.rows.length, 2, '兩筆 row');
  eq(r.rows[0].B, 'line1\nline2', '內嵌 \\n 不被 \\r\\n 切');
});

// ── Codex 補要求 3 項 ────────────────────────────────────────────────────────

console.log('\n🔧 Codex 補要求:');

check('Quoted 空字串作為第一欄（""\\t...）', () => {
  // Quote 內無內容、緊接 tab → empty string field
  const r = parseTab('A\tB\tC\n""\tv2\tv3');
  eq(r.rows, [{ A: '', B: 'v2', C: 'v3' }], '"" 開頭 = 空字串，後續欄位不錯位');
});

check('Header 自己出現 quoted 欄位（含 comma 在 header 名稱裡）', () => {
  // 如果有人把 LogTen header 改名導致用 quote 包，要正確識別 header
  const text = '"Date"\t"Flight #"\t"Remarks, with comma"\nA\tB\tC';
  const r = parseTab(text);
  eq(r.headers, ['Date', 'Flight #', 'Remarks, with comma'], 'header 解出 quote 內容');
  eq(r.rows, [{ Date: 'A', 'Flight #': 'B', 'Remarks, with comma': 'C' }], 'row 對應 quoted header');
});

check('Quoted 內單獨 \\r 作為 data（不被當 row 終止）', () => {
  // \r 在 quoted 內單獨出現（非 \r\n），要當 data 保留
  const text = 'A\tB\nv1\t"line1\rline2"\nv3\tv4';
  const r = parseTab(text);
  eq(r.rows.length, 2, '兩筆 row（單獨 \\r 沒切 row）');
  eq(r.rows[0].B, 'line1\rline2', 'embedded \\r 保留為 data');
});

// ── 結果 ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`✅ 通過: ${passed}  ❌ 失敗: ${failed}`);
console.log(`${'─'.repeat(40)}\n`);

if (failed > 0) {
  console.log('⛔ parseTab 測試未全過，import 不能上\n');
  process.exit(1);
} else {
  console.log('🎉 parseTab 測試全過\n');
  process.exit(0);
}
