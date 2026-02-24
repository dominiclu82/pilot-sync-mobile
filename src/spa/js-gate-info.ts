import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaGateInfoJs(): string {
  return readFileSync(join(__dirname, 'gate-info.js'), 'utf-8');
}
