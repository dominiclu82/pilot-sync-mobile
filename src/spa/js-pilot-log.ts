import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaPilotLogJs(): string {
  return readFileSync(join(__dirname, 'pilot-log.js'), 'utf8');
}
