import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaAtfmJs(): string {
  return readFileSync(join(__dirname, 'atfm.js'), 'utf-8');
}
