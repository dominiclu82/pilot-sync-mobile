import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSpaCrewRestJs(): string {
  return readFileSync(join(__dirname, 'crew-rest.js'), 'utf-8');
}
