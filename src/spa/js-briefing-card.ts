import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaBriefingCardJs(): string {
  return readFileSync(join(__dirname, 'briefing-card.js'), 'utf-8');
}
