import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaDutyTimeJs(): string {
  return readFileSync(join(__dirname, 'js-duty-time-logic.js'), 'utf-8');
}
