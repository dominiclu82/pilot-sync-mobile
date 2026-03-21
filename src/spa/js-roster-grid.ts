import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaRosterGridJs(): string {
  return readFileSync(join(__dirname, 'roster-grid.js'), 'utf8');
}
