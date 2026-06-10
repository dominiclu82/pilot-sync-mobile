// Server 端機場代碼正規化（V2.3.04）：解掉「班表 IATA（TPE）vs LogTen ICAO（RCTP）比不上 → 重複航班」。
// 對照表借用 spa/airport-db.js（OurAirports 產生，4176 場），啟動後第一次用到才解析、整個 process 共用一份。
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

let iataToIcao: Map<string, string> | null = null;

function ensureMap(): Map<string, string> {
  if (iataToIcao) return iataToIcao;
  iataToIcao = new Map();
  try {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'spa', 'airport-db.js'), 'utf8');
    // 每列開頭固定 ["ICAO","IATA",…（ICAO 4 碼、IATA 3 碼才收；重複 IATA 只取第一筆）
    const re = /^\["([A-Z0-9]{4})","([A-Z0-9]{3})"/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) { if (!iataToIcao.has(m[2])) iataToIcao.set(m[2], m[1]); }
  } catch (e) { /* 讀不到 db 檔 → 空 map，normAirportKey 退回原樣比對（不擋匯入） */ }
  return iataToIcao;
}

// 機場代碼正規化比對 key：3 碼當 IATA 轉 ICAO（查得到才轉），其餘 trim+大寫原樣。
export function normAirportKey(code?: string | null): string {
  const c = String(code == null ? '' : code).trim().toUpperCase();
  if (c.length === 3) { const icao = ensureMap().get(c); if (icao) return icao; }
  return c;
}
