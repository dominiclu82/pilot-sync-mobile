import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let _cache: string | null = null;

// 共用跑道圖引擎（window.RwyMap）— 給主 App 的 roster WX 跑道圖用。依賴 window._PL_AIRPORTS。
// Pilot Log 另有自己一份同等實作（pilot-log.js 內），兩者互不共用、各自維護。
export function getSpaRunwayMapJs(): string {
  if (_cache == null) _cache = readFileSync(join(__dirname, 'runway-map.js'), 'utf8');
  return _cache;
}
