import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let _cache: string | null = null;

// 機場資料庫（OurAirports 公共領域，~4176 個有 IATA 的定期航班機場）。
// 約 317KB，懶載入（不塞進主頁 HTML），由 /pilot-log/airport-db.js 路由提供、SW + 瀏覽器快取。
export function getAirportDbJs(): string {
  if (_cache == null) _cache = readFileSync(join(__dirname, 'airport-db.js'), 'utf8');
  return _cache;
}
