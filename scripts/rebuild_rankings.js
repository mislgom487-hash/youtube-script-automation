import { rebuildSpikeRankings } from '../server/services/spike-rankings-builder.js';

console.log('랭킹 재빌드 시작...');
const count = rebuildSpikeRankings();
console.log('재빌드 완료. 삽입/갱신:', count, '건');

import Database from 'better-sqlite3';
const db = new Database('data/yadam.db');
console.log('\n=== 재빌드 후 검증 ===');
console.log('video_spike_rankings 총:', db.prepare('SELECT COUNT(*) AS n FROM video_spike_rankings').get().n, '건');
console.log('\nDISTINCT category_name:');
db.prepare('SELECT DISTINCT category_name, COUNT(*) AS cnt FROM video_spike_rankings GROUP BY category_name ORDER BY cnt DESC').all()
  .forEach(r => console.log(' -', r.category_name, ':', r.cnt, '건'));
db.close();
