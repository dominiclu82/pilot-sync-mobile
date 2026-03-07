import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaSubtabReorderJs(): string {
  return readFileSync(join(__dirname, 'subtab-reorder.js'), 'utf-8');
}
