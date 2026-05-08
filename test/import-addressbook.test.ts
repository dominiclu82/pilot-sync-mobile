/**
 * import-addressbook unit tests (V1.0.09)
 *
 * 純函式測試，不啟 server、不打 DB。針對 normName / normIds 兩個 normalize helper：
 * 這兩個的正確性是整支 importer 的識別基礎（lookup key），先把這層覆蓋到位。
 *
 * importer 主邏輯（lookup / conflict / TX）的測試需要 test DB 或 PG 替身，
 * 先擋掉純函式風險、importer 整段邏輯先靠 smoke + 實機驗證；
 * 之後再補 integration 等級的 importer 測試（pg-mem 或專用 schema）。
 *
 * 用法：tsx test/import-addressbook.test.ts
 */

import { normName, normIds } from '../src/pilot-log/import-addressbook.js';

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

console.log('\n👥 import-addressbook normalize helpers\n');

// ── normName ────────────────────────────────────────────────────────────────
console.log('📛 normName:');

check('1. 空字串 → 空字串', () => {
  eq(normName(''), '', 'empty string');
});

check('2. null/undefined → 空字串（防呆）', () => {
  eq(normName(null as any), '', 'null');
  eq(normName(undefined as any), '', 'undefined');
});

check('3. 純空白 → 空字串', () => {
  eq(normName('   '), '', 'all spaces');
  eq(normName('\t\n  '), '', 'tabs+newlines');
});

check('4. 前後空白 trim', () => {
  eq(normName('  Dominic Lu  '), 'Dominic Lu', 'leading+trailing');
  eq(normName('\tYoshi Terachi\n'), 'Yoshi Terachi', 'tab+newline');
});

check('5. 中間多重空白 collapse 成單一空白', () => {
  eq(normName('Dominic    Lu'), 'Dominic Lu', 'multiple spaces');
  eq(normName('Yoshi\t\tTerachi'), 'Yoshi Terachi', 'tabs');
  eq(normName('呂 偉 宏'), '呂 偉 宏', 'Chinese with single spaces (no change)');
});

check('6. 中英混合姓名（LogTen 常見）', () => {
  eq(normName('Dominic Lu 呂偉宏'), 'Dominic Lu 呂偉宏', 'normal mixed');
  eq(normName('  Dominic   Lu   呂偉宏  '), 'Dominic Lu 呂偉宏', 'mixed with extra spaces');
});

check('7. 只有換行/tab 也視為空白被 collapse', () => {
  eq(normName('a\nb\tc'), 'a b c', 'newline+tab as whitespace');
});

// ── normIds ─────────────────────────────────────────────────────────────────
console.log('\n🆔 normIds:');

check('1. 空字串 → 空陣列', () => {
  eq(normIds(''), [], 'empty');
});

check('2. null/undefined → 空陣列', () => {
  eq(normIds(null as any), [], 'null');
  eq(normIds(undefined as any), [], 'undefined');
});

check('3. 單一 ID 不帶 slash', () => {
  eq(normIds('2214780'), ['2214780'], 'single id');
});

check('4. 兩個 ID 用 / 分隔（換公司情境）', () => {
  eq(normIds('2214780/B79363'), ['2214780', 'B79363'], 'two ids');
});

check('5. 三個以上', () => {
  eq(normIds('A123/B456/C789'), ['A123', 'B456', 'C789'], 'three ids');
});

check('6. 各段含前後空白要 trim', () => {
  eq(normIds(' 2214780 / B79363 '), ['2214780', 'B79363'], 'spaces around');
  eq(normIds('2207460 / 155678'), ['2207460', '155678'], 'spaces inside (LogTen real case)');
});

check('7. 空段要被過濾掉', () => {
  eq(normIds('A123//B456'), ['A123', 'B456'], 'empty middle');
  eq(normIds('/A123/'), ['A123'], 'empty leading/trailing');
  eq(normIds('//'), [], 'all empty');
});

check('8. 重複 ID 要去重', () => {
  eq(normIds('A123/A123'), ['A123'], 'dup adjacent');
  eq(normIds('A/B/A'), ['A', 'B'], 'dup non-adjacent (preserve first)');
});

check('9. 純空白也要被過濾', () => {
  eq(normIds('  /  /  '), [], 'all whitespace segments');
  eq(normIds('A123 /   / B456'), ['A123', 'B456'], 'whitespace-only segment in middle');
});

check('10. 帶字母+數字混合（LogTen 真實 ID 格式）', () => {
  eq(normIds('B79363'), ['B79363'], 'letter+digits');
  eq(normIds('D32289/E54732/F80587'), ['D32289', 'E54732', 'F80587'], 'multiple letter+digit IDs');
});

// ── 收尾 ─────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`✅ 通過: ${passed}  ❌ 失敗: ${failed}`);
console.log(`${'─'.repeat(40)}`);

if (failed > 0) {
  console.log('\n⛔ import-addressbook unit test 未全過');
  process.exit(1);
}
console.log('\n🎉 import-addressbook unit test 全過');
