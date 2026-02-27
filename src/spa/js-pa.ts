import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaPaJs(): string {
  return readFileSync(join(__dirname, 'pa-scripts.js'), 'utf-8');
}
