import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaCalendarJs(): string {
  return readFileSync(join(__dirname, 'js-calendar.js'), 'utf-8');
}
