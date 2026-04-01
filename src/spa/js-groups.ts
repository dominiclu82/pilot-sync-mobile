import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
export const getSpaGroupsJs = () => readFileSync(join(__dirname, 'groups.js'), 'utf-8');
