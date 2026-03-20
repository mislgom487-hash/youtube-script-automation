import { rebuildSpikeRankings } from '../server/services/spike-rankings-builder.js';
import { getDB } from '../server/db.js';

console.log('=== video_spike_rankings 재빌드 시작 ===\n');

const db = getDB();

// 처리 대상 장르 표시
const genres = db.prepare(
    `SELECT DISTINCT group_tag FROM channels WHERE group_tag IS NOT NULL AND group_tag != '' ORDER BY group_tag`
).all().map(r => r.group_tag);

console.log(`대상 장르 (${genres.length}개): ${genres.join(', ') || '없음'}`);

if (genres.length === 0) {
    console.log('\n처리할 장르가 없습니다. channels 테이블에 group_tag를 설정해주세요.');
    process.exit(0);
}

// 전체 재빌드 (genre=null → 모든 장르)
const totalCount = rebuildSpikeRankings(null);

console.log(`\n=== 재빌드 완료: ${totalCount.toLocaleString()}건 ===\n`);

// 검증 출력
const total = db.prepare(`SELECT COUNT(*) as c FROM video_spike_rankings`).get();
console.log(`전체 행 수: ${total.c.toLocaleString()}`);

console.log('\n장르별 집계:');
db.prepare(`
  SELECT genre, category_name,
    COUNT(*) as total,
    SUM(is_spike) as spike_count,
    MIN(rank_in_category) as min_rank,
    MAX(rank_in_category) as max_rank
  FROM video_spike_rankings
  GROUP BY genre, category_name
  ORDER BY genre, spike_count DESC
`).all().forEach(r => {
    console.log(`  [${r.genre}] ${r.category_name.padEnd(12)}: 전체=${r.total}, 떡상=${r.spike_count}, 순위=${r.min_rank}~${r.max_rank}`);
});
