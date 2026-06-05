// 台灣六家航空機籍範圍表（tail B-xxxxx → 航空公司 / 機型）＋ 班號/機尾正規化。
// 後端版，對應前端 pilot-log.js 的 _PL_TW_REG（靜態資料，少動；改動時兩邊要同步）。
// 用途：LogATP 匯入「沒代碼 → 機尾反查補航空代碼」＋ 跨來源防重的正規化比對。

export interface TwRegEntry { op: string; s: number; e: number; t: string; c: string; }

// 機尾 5 碼數字範圍 → 航空公司 / 機型 / ICAO 機型碼
export const TW_REG: TwRegEntry[] = [
  // 星宇 Starlux
  { op: 'Starlux', s: 58201, e: 58227, t: 'A321neo', c: 'A21N' },
  { op: 'Starlux', s: 58301, e: 58311, t: 'A330neo', c: 'A339' },
  { op: 'Starlux', s: 58501, e: 58510, t: 'A350-900', c: 'A359' },
  { op: 'Starlux', s: 58551, e: 58568, t: 'A350-1000', c: 'A35K' },
  { op: 'Starlux', s: 58581, e: 58590, t: 'A350F', c: 'A35F' },
  // 長榮 EVA Air
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

// 航空公司 → IATA 航班代碼
const OP_TO_IATA: Record<string, string> = {
  'Starlux': 'JX',
  'EVA Air': 'BR',
  'China Airlines': 'CI',
  'UNI Air': 'B7',
  'Mandarin': 'AE',
  'Tigerair Taiwan': 'IT',
};

// 機尾 → { operator, type, code, iata }；查不到回 null（不亂猜）
export function tailLookup(tail: string): { operator: string; type: string; code: string; iata: string | null } | null {
  const m = String(tail == null ? '' : tail).toUpperCase().replace(/\s/g, '').match(/^B-?(\d{5})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  for (const r of TW_REG) {
    if (n >= r.s && n <= r.e) return { operator: r.op, type: r.t, code: r.c, iata: OP_TO_IATA[r.op] || null };
  }
  return null;
}

// 機尾 → IATA 航班代碼（給「沒代碼→機尾反查補代碼」用）；查不到回 null
export function airlineCodeFromTail(tail: string): string | null {
  const look = tailLookup(tail);
  return look ? look.iata : null;
}

// 班號正規化（只用於防重比對）：去航空字母前綴 ＋ 去前導零。
//   JX031 / SJX31 / 0031 / 031 → '31'；201D → '201D'（尾碼保留）；'' → ''
export function normFlightNoKey(fn: string | null | undefined): string {
  let s = String(fn == null ? '' : fn).toUpperCase().replace(/\s+/g, '');
  s = s.replace(/^[A-Z]+/, '');   // 去開頭航空字母（JX / SJX…）
  s = s.replace(/^0+(?=\d)/, '');  // 去前導零（後面還有數字才去，避免把純 '0' 砍空）
  return s;
}

// 機尾正規化（只用於比對）：只留英數＋大寫。B-58501 = B58501 → 'B58501'
export function normTailKey(tail: string | null | undefined): string {
  return String(tail == null ? '' : tail).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// 機尾顯示格式（存用）：標準化成 B-xxxxx（在開頭字母群後補一個破折號）。
//   B58510 → B-58510；B-58505 → B-58505（不變）；空 → ''
export function formatTail(tail: string | null | undefined): string {
  const k = String(tail == null ? '' : tail).toUpperCase().replace(/\s+/g, '');
  if (!k) return '';
  const m = k.match(/^([A-Z]+)-?(.+)$/);   // 開頭字母群（可含破折號）+ 其餘
  return m ? `${m[1]}-${m[2]}` : k;
}
