import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaFr24RadarJs(): string {
  return readFileSync(join(__dirname, 'fr24-radar.js'), 'utf-8');
}
