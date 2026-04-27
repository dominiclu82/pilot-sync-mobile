// TSV (Tab-Separated Values) parser — proper state machine that respects:
//
//   - Quoted fields wrapped in "..." (LogTen 多行 Remarks 用這個)
//   - Embedded newlines / tabs inside quoted fields（不當 row/field 終止）
//   - Escaped double quotes inside quoted fields ("" → ")
//   - BOM (U+FEFF) at file start
//   - \r\n / \n / \r 三種 line ending
//   - 檔案結尾沒 newline 也要進最後一筆
//
// 嚴格行為（避免默默吞掉髒格式）：
//   - Quoted field close 後若不是 \t / \n / \r / EOF → throw
//   - Unterminated quote at EOF → throw
//
// V1.0.06 引入。原本 import-logten.ts inline 的 split-by-line/tab 版本完全
// 沒處理 quoted multi-line，導致 LogTen 多行 Remarks 把 Date 欄打亂。

export interface ParsedTsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseTab(text: string): ParsedTsv {
  // BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const allRows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  let atFieldStart = true;
  let i = 0;
  const n = text.length;

  // 用 line/col 給 throw 訊息更好 debug
  let line = 1;
  let col = 1;

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        // 看下一個字元決定是 escaped quote 還是 close quote
        const next = i + 1 < n ? text[i + 1] : '';
        if (next === '"') {
          cur += '"';
          i += 2; col += 2;
          continue;
        }
        // close quote — 嚴格：後面必須是 \t / \n / \r / EOF
        inQuotes = false;
        i++; col++;
        if (i < n) {
          const after = text[i];
          if (after !== '\t' && after !== '\n' && after !== '\r') {
            throw new Error(
              `TSV parse error at line ${line} col ${col}: unexpected char '${after}' after closing quote (expected tab/newline/EOF)`
            );
          }
        }
        continue;
      }
      // quoted field 內，包括 \t / \n / \r 都算 data
      if (c === '\n') { line++; col = 1; } else { col++; }
      cur += c;
      i++;
      continue;
    }

    // 不在 quotes
    if (c === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      i++; col++;
      continue;
    }
    if (c === '\t') {
      row.push(cur);
      cur = '';
      atFieldStart = true;
      i++; col++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(cur);
      cur = '';
      atFieldStart = true;
      // 整 row 全空白 → skip
      if (row.some(v => v.length > 0)) {
        allRows.push(row);
      }
      row = [];
      i++;
      // \r\n 算一個 line break
      if (c === '\r' && i < n && text[i] === '\n') i++;
      line++; col = 1;
      continue;
    }
    cur += c;
    atFieldStart = false;
    i++; col++;
  }

  // EOF — 檢查未閉合的 quote
  if (inQuotes) {
    throw new Error(`TSV parse error: unterminated quoted field at end of input (line ${line})`);
  }

  // EOF 沒 newline → 補進最後一筆
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    if (row.some(v => v.length > 0)) {
      allRows.push(row);
    }
  }

  if (allRows.length === 0) return { headers: [], rows: [] };

  const headers = allRows[0].map(h => h.trim());
  const dataRows: Record<string, string>[] = [];
  for (let r = 1; r < allRows.length; r++) {
    const cells = allRows[r];
    if (cells.every(c => !c.trim())) continue;
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = (cells[j] ?? '').trim();
    }
    dataRows.push(obj);
  }

  return { headers, rows: dataRows };
}
