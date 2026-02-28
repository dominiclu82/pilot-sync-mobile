import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaAirportDataJs(): string {
  return readFileSync(join(__dirname, 'airport-data.js'), 'utf-8');
}
