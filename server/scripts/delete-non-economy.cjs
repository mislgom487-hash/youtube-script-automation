// 경제 채널 미분류 + 비경제 영상 삭제 (일회성 스크립트)
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', '..', 'data', 'yadam.db'));

// 경제 키워드 (제목에 하나라도 있으면 보존)
const ECONOMY_KEYWORDS = [
  '주식','ETF','펀드','투자','배당','코스피','코스닥',
  '나스닥','종목','매수','매도','증권','상장','코인',
  '비트코인','가상화폐','부동산','아파트','청약','재건축',
  '분양','임대','전세','월세','매매','재테크','저축',
  '적금','예금','자산','금리','환율','경기','인플레이션',
  'GDP','기준금리','연준','경제','불황','호황','침체',
  '무역','수출','수입','유가','원자재','달러','관세',
  '세금','연말정산','종합소득세','양도세','증여세',
  '상속세','절세','정책','창업','자영업','스타트업',
  '부업','사업','매출','수익','프랜차이즈','노후','연금',
  '퇴직','은퇴','파이어족','물가','디플레이션','채권',
  '금융','은행','보험','대출','이자','신용','빚','부채'
];

// 경제소재 카테고리 ID 목록
const catIds = db.prepare(
  "SELECT id FROM categories WHERE group_name = '경제소재'"
).all().map(r => r.id);

// 경제 채널의 미분류 영상 조회
const unclassified = db.prepare(`
  SELECT v.id, v.title
  FROM videos v
  JOIN channels c ON c.id = v.channel_id
  WHERE c.group_tag = '경제'
  AND v.id NOT IN (
    SELECT vc.video_id FROM video_categories vc
    WHERE vc.category_id IN (${catIds.join(',')})
  )
`).all();

console.log(`미분류 영상 총 ${unclassified.length}건 검사`);

const toDelete = [];
const toKeep = [];

for (const v of unclassified) {
  const title = (v.title || '').toLowerCase();
  const hasEconKw = ECONOMY_KEYWORDS.some(kw =>
    title.includes(kw.toLowerCase())
  );

  if (hasEconKw) {
    toKeep.push(v);
  } else {
    toDelete.push(v.id);
  }
}

console.log(`삭제 대상: ${toDelete.length}건`);
console.log(`보존 대상: ${toKeep.length}건 (경제 키워드 포함)`);
console.log(`\n보존 샘플:`);
toKeep.slice(0, 10).forEach(v => console.log(`  - ${v.title}`));

// 삭제 실행
if (toDelete.length > 0) {
  const delSpike = db.prepare(
    'DELETE FROM video_spike_rankings WHERE video_id = ?'
  );
  const delCat = db.prepare(
    'DELETE FROM video_categories WHERE video_id = ?'
  );
  const delVideo = db.prepare(
    'DELETE FROM videos WHERE id = ?'
  );

  const deleteAll = db.transaction(() => {
    for (const id of toDelete) {
      delSpike.run(id);
      delCat.run(id);
      delVideo.run(id);
    }
  });

  deleteAll();
  console.log(`\n${toDelete.length}건 삭제 완료`);
}

// 결과 검증
const remaining = db.prepare(`
  SELECT COUNT(*) AS cnt FROM videos v
  JOIN channels c ON c.id = v.channel_id
  WHERE c.group_tag = '경제'
`).get();
console.log(`경제 영상 잔여: ${remaining.cnt}건`);

db.close();
