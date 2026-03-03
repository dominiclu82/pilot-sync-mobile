import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaLiveRadarJs(): string {
  return readFileSync(join(__dirname, 'live-radar.js'), 'utf-8');
}
