import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaOvertimeJs(): string {
  return readFileSync(join(__dirname, 'overtime.js'), 'utf-8');
}
