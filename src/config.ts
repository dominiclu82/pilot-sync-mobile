import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename);

export const ROOT = path.join(__dirname_local, '..');
export const CREDENTIALS_PATH = path.join(ROOT, 'credentials.json');
export const OUTPUT_DIR = path.join(ROOT, 'output');
