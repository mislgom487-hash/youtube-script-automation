import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'yadam.db');

async function debug() {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(buffer);

    const categories = db.prepare('SELECT group_name, name FROM categories ORDER BY group_name, sort_order').bind([]);
    const results = [];
    while (categories.step()) {
        results.push(categories.getAsObject());
    }
    categories.free();

    console.log('--- CATEGORIES ---');
    console.log(JSON.stringify(results, null, 2));

    const groups = db.prepare('SELECT DISTINCT group_name FROM categories').bind([]);
    const groupRes = [];
    while (groups.step()) {
        groupRes.push(groups.getAsObject().group_name);
    }
    groups.free();
    console.log('--- GROUPS ---');
    console.log(groupRes.join(', '));
}

debug().catch(console.error);
