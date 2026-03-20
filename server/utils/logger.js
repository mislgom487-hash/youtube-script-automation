import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, '../../debug.log');

export function logToFile(msg) {
    const time = new Date().toLocaleString();
    fs.appendFileSync(logPath, `[${time}] ${msg}\n`);
    console.log(`[LOG] ${msg}`);
}
