import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isElectron = process.env.ELECTRON_MODE === 'true';
const baseDataDir = isElectron
  ? path.join(process.env.ELECTRON_USER_DATA, 'data')
  : path.join(__dirname, '..', 'data');

const DB_PATH = path.join(baseDataDir, 'yadam.db');
const BACKUP_DIR = path.join(baseDataDir, 'backups');

if (!fs.existsSync(baseDataDir)) {
  fs.mkdirSync(baseDataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  handle TEXT,
  group_tag TEXT DEFAULT '',
  thumbnail_url TEXT,
  subscriber_count INTEGER DEFAULT 0,
  video_count INTEGER DEFAULT 0,
  last_fetched TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);
try { db.exec("ALTER TABLE channels ADD COLUMN is_active INTEGER DEFAULT 1"); } catch(e) {}
try { db.exec('ALTER TABLE channels ADD COLUMN description TEXT DEFAULT ""'); } catch(e) {}
try { db.exec("ALTER TABLE channels ADD COLUMN sub_type TEXT DEFAULT NULL"); } catch(e) {}

db.exec(`CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  video_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  transcript_summary TEXT DEFAULT '',
  transcript_keywords TEXT DEFAULT '',
  has_transcript INTEGER DEFAULT 0,
  published_at TEXT,
  view_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  thumbnail_url TEXT,
  memo TEXT DEFAULT '',
  is_analyzed INTEGER DEFAULT 0,
  fetched_at TEXT DEFAULT (datetime('now'))
)`);
try { db.exec('ALTER TABLE videos ADD COLUMN transcript_raw TEXT DEFAULT ""'); } catch(e) {}
try { db.exec('ALTER TABLE videos ADD COLUMN comment_count INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE videos ADD COLUMN source TEXT DEFAULT "channel"'); } catch(e) {}
try { db.exec('ALTER TABLE videos ADD COLUMN economy_metadata TEXT DEFAULT "{}"'); } catch(e) {}

db.exec(`CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT UNIQUE NOT NULL,
  total_count INTEGER DEFAULT 0,
  is_saturated INTEGER DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS video_keywords (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  tfidf_score REAL DEFAULT 0,
  frequency INTEGER DEFAULT 1,
  source TEXT DEFAULT 'title',
  PRIMARY KEY (video_id, keyword_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#7c5cff',
  sort_order INTEGER DEFAULT 0,
  UNIQUE(group_name, name)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS video_categories (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source TEXT DEFAULT 'ai',
  PRIMARY KEY (video_id, category_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'idea',
  priority TEXT DEFAULT 'normal',
  max_similarity REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);

try { db.exec(`ALTER TABLE ideas ADD COLUMN category TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN source_video_id TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN source_video_title TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN source_channel_name TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN source_thumbnail_url TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN dna_score INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN dna_summary TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN idea_type TEXT DEFAULT 'memo'`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN save_type TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN view_count INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN subscriber_count INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN duration_seconds INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN spike_ratio REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN spike_grade TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE ideas ADD COLUMN video_id TEXT DEFAULT ''`); } catch(e) {}

db.exec(`CREATE TABLE IF NOT EXISTS idea_similar_videos (
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  similarity_score REAL DEFAULT 0,
  PRIMARY KEY (idea_id, video_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_type TEXT NOT NULL,
    key_name TEXT NOT NULL DEFAULT '',
    key_value TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 기존 settings 테이블 API키를 api_keys로 마이그레이션 (최초 1회만)
{
  const existingKeys = db.prepare(`SELECT COUNT(*) as cnt FROM api_keys`).get();
  if (existingKeys.cnt === 0) {
    const migrate = (keyType, settingsKey) => {
      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(settingsKey);
      if (row && row.value) {
        db.prepare(
          `INSERT INTO api_keys (key_type, key_name, key_value, is_active) VALUES (?, ?, ?, 1)`
        ).run(keyType, keyType + ' #1', row.value);
      }
    };
    migrate('youtube_api_key', 'youtube_api_key');
    migrate('gemini_api_key', 'gemini_api_key');
    migrate('google_project_id', 'google_project_id');
  }
}

db.exec(`CREATE TABLE IF NOT EXISTS tagging_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  is_active INTEGER DEFAULT 1
)`);

db.exec(`CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  comment_id TEXT UNIQUE,
  author TEXT DEFAULT '',
  text TEXT NOT NULL,
  like_count INTEGER DEFAULT 0,
  published_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS benchmark_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// 세부분류 테이블 제거 (단계 A)
try { db.exec(`DROP TABLE IF EXISTS video_sub_categories`); } catch(e) {}
try { db.exec(`DROP TABLE IF EXISTS sub_categories`); } catch(e) {}

db.exec(`CREATE TABLE IF NOT EXISTS video_dna (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_ids TEXT NOT NULL,
  video_titles TEXT NOT NULL,
  channel_names TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  dna_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_video_dna_category ON video_dna(category)`);
console.log('✅ video_dna 테이블 초기화 완료');

db.exec(`CREATE TABLE IF NOT EXISTS deleted_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT,
  name TEXT,
  handle TEXT,
  group_tag TEXT,
  thumbnail_url TEXT,
  subscriber_count INTEGER,
  video_count INTEGER,
  collected_count INTEGER DEFAULT 0,
  description TEXT,
  created_at TEXT,
  deleted_at TEXT DEFAULT (datetime('now','localtime')),
  delete_reason TEXT DEFAULT '이유없음',
  delete_reason_detail TEXT
)`);

// ── 성능 인덱스 ──────────────────────────────────────────────────────────────
db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id)`);

// ── 카테고리 키워드 관리 ────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS category_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_name TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  order_index INTEGER DEFAULT 0,
  tab_type TEXT DEFAULT 'video',
  UNIQUE(category_name, keyword, tab_type)
)`);

// UNIQUE 제약 마이그레이션: (category_name, keyword) → (category_name, keyword, tab_type)
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='category_keywords'").get()?.sql || '';
  const hasTabTypeUnique = /UNIQUE\s*\([^)]*tab_type/.test(sql);
  if (!hasTabTypeUnique) {
    db.exec(`
      CREATE TABLE category_keywords_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_name TEXT NOT NULL,
        keyword TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        order_index INTEGER DEFAULT 0,
        tab_type TEXT DEFAULT 'video',
        UNIQUE(category_name, keyword, tab_type)
      )
    `);
    db.exec(`
      INSERT OR IGNORE INTO category_keywords_v2 (id, category_name, keyword, created_at, order_index, tab_type)
      SELECT id, category_name, keyword, created_at, COALESCE(order_index, 0), COALESCE(tab_type, 'video')
      FROM category_keywords
    `);
    db.exec(`DROP TABLE category_keywords`);
    db.exec(`ALTER TABLE category_keywords_v2 RENAME TO category_keywords`);
  }
}

// 기본 키워드 삽입 — (category_name, tab_type) 조합이 완전히 비어있을 때만 삽입
// (삭제된 키워드는 복원하지 않음)
{
  const stmtKw = db.prepare(
    'INSERT OR IGNORE INTO category_keywords (category_name, keyword, tab_type, order_index) VALUES (?, ?, ?, ?)'
  );
  const stmtCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM category_keywords WHERE category_name = ? AND tab_type = ?'
  );
  const defaults = {
    video: {
      '야담': ['야담','조선시대','전설','귀신','설화','민담','도깨비','역사','기담'],
      '경제': ['주식','부동산','재테크','투자','경제','돈','금융','ETF','코인'],
      '심리학': ['심리학','인간관계','자존감','트라우마','정신건강','MBTI','공황'],
    },
    channel: {
      '야담': ['야담','야담 채널','야담 애니','전래동화','옛날이야기'],
      '경제': ['경제','재테크','투자','주식','부동산'],
      '심리학': ['심리학','심리','상담','멘탈'],
    },
  };
  for (const [tabType, categories] of Object.entries(defaults)) {
    for (const [cat, kws] of Object.entries(categories)) {
      const { cnt } = stmtCount.get(cat, tabType);
      if (cnt === 0) {
        kws.forEach((kw, idx) => stmtKw.run(cat, kw, tabType, idx));
      }
    }
  }
}

db.exec(`CREATE TABLE IF NOT EXISTS category_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_name TEXT UNIQUE NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);
try { db.exec(`ALTER TABLE category_settings ADD COLUMN sub_type_mode TEXT DEFAULT 'none'`); } catch(e) {}
try { db.exec(`UPDATE category_settings SET sub_type_mode = 'dual' WHERE category_name IN ('경제', '심리') AND (sub_type_mode IS NULL OR sub_type_mode = 'none')`); } catch(e) {}

// === 지침 관리 테이블 ===
db.exec(`CREATE TABLE IF NOT EXISTS story_guidelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);

// === 주제 추천 결과 테이블 ===
db.exec(`CREATE TABLE IF NOT EXISTS topic_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  group_tag TEXT,
  topic_title TEXT NOT NULL DEFAULT '',
  topic_summary TEXT NOT NULL DEFAULT '',
  thumb_titles TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
)`);

// 기존 컬럼 호환 마이그레이션
try { db.exec(`ALTER TABLE topic_recommendations ADD COLUMN topic_title TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE topic_recommendations ADD COLUMN topic_summary TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE topic_recommendations ADD COLUMN thumb_titles TEXT NOT NULL DEFAULT '[]'`); } catch(e) {}


// ── material_group_name 마이그레이션 ─────────────────────────────────────────
// 순서 1: 컬럼 추가
try { db.exec(`ALTER TABLE category_settings ADD COLUMN material_group_name TEXT`); } catch(e) {}
// 순서 2: 기존 카테고리 초기값 설정
try { db.exec(`UPDATE category_settings SET material_group_name = '야담소재' WHERE category_name = '야담' AND (material_group_name IS NULL OR material_group_name = '')`); } catch(e) {}
try { db.exec(`UPDATE category_settings SET material_group_name = '경제소재' WHERE category_name = '경제' AND (material_group_name IS NULL OR material_group_name = '')`); } catch(e) {}
try { db.exec(`UPDATE category_settings SET material_group_name = '심리소재' WHERE category_name = '심리' AND (material_group_name IS NULL OR material_group_name = '')`); } catch(e) {}
// 순서 3: 야담 소재 group_name 변경 (순서 4 이전에 반드시 실행)
try { db.exec(`UPDATE categories SET group_name = '야담소재' WHERE group_name = '소재'`); } catch(e) {}
// 순서 4: 불필요 그룹 video_categories 삭제 (FK 먼저)
try { db.exec(`DELETE FROM video_categories WHERE category_id IN (SELECT id FROM categories WHERE group_name IN ('시대', '소재출처', '인물유형', '지역'))`); } catch(e) {}
// 순서 5: 불필요 그룹 categories 삭제
try { db.exec(`DELETE FROM categories WHERE group_name IN ('시대', '소재출처', '인물유형', '지역')`); } catch(e) {}
// 순서 6: 검증 출력
{
  const mgnCheck = db.prepare(`SELECT group_name, COUNT(*) as cnt FROM categories GROUP BY group_name`).all();
  console.log('[DB] categories group_name 분포:', JSON.stringify(mgnCheck));
  const csCheck = db.prepare(`SELECT category_name, sub_type_mode, material_group_name FROM category_settings`).all();
  console.log('[DB] category_settings:', JSON.stringify(csCheck));
}

// ── 카테고리 keywords 컬럼 + 키워드 데이터 이관 ──────────────────────────────
// [수정 1] keywords 컬럼 추가
try { db.exec(`ALTER TABLE categories ADD COLUMN keywords TEXT DEFAULT ''`); } catch(e) {}

// [수정 2] 야담소재 키워드 (항상 최신 값으로 덮어쓰기)
{
  const yadamKeywords = {
    '범죄/옥사': '살해,참수,독살,강도,형벌,처형,살인,범죄,옥사,흉기,시신,도둑,도적,폭행,주리,형리,능지,교수형,참형,처단,단죄,죄인,포졸,포청,감옥,옥에,유배,귀양',
    '괴담/미스터리': '귀신,도깨비,공포,저주,흉가,괴담,미스터리,유령,혼령,빙의,요괴,괴물,저승,귀물,기이,무서운,으스스,소름,공포스러운,무덤,산신,변괴,지옥,넋,이상한,불가사의,수상한,기묘,환상,신비,요술',
    '로맨스': '사랑,연모,기생,첩,이별,로맨스,연애,혼인,정분,상사병,재회,정인,애정,금슬,부부,불륜,첫사랑,낭군,아씨,연정,사모,변심,질투,미인,미녀,규방,색시,신부,낭자,정혼,혼약,이혼,정실,소실',
    '복수극': '원한,응징,억울,원수,복수,원귀,설원,앙갚음,한,처단,통한,복수극,씻다,원수갚다,피의,설분,원수를',
    '풍속/일상': '생활,민중,기담,옛날,풍습,풍속,일상,마을,장터,과거시험,효도,서민,이야기,인생,교훈,조상,먹거리,놀이,시장,장날,양반,상민,백성,고을,지방,평민,풍경,풍경화,민화,세시풍속,명절,제사,제례',
    '전쟁/영웅': '군대,임진왜란,의병,포로,전쟁,영웅,병자호란,전투,장수,무관,전장,싸움,무기,갑옷,칼,활,화살,대포,침략,방어,공격,진지,격전,충신,열사,순국,의사,용사,전사',
    '사기/기만': '사기꾼,속임,가짜,흑심,사기,기만,위조,사칭,협잡,뜯다,등쳐먹다,속이다,허풍,거짓말,유혹,꾀,계략,음모,모략,책략,함정,올가미,사술,교활',
  };
  const updateYdKw = db.prepare(`UPDATE categories SET keywords = ? WHERE group_name = '야담소재' AND name = ? AND (keywords IS NULL OR keywords = '')`);
  for (const [name, kws] of Object.entries(yadamKeywords)) updateYdKw.run(kws, name);
}

// [수정 3] 경제소재 키워드 (항상 최신 값으로 덮어쓰기 — 대폭 확장)
{
  const economyKeywords = {
    '주식/투자': '주식,ETF,펀드,투자,배당,코스피,코스닥,나스닥,S&P,종목,매수,매도,차트,테마주,공모주,증권,상장,PER,PBR,시총,워렌버핏,트레이딩,선물,옵션,코인,비트코인,가상화폐,암호화폐,리츠,인덱스,포트폴리오,주가,주가지수,증시,장세,폭락,폭등,급락,급등,대폭락,대폭등,하락장,상승장,반등,조정,변동성,엔비디아,테슬라,삼성전자,반도체,AI주,기술주,성장주,가치주,배당주,수익률,투자수익,단타,장기투자,분산투자,자산배분,딥시크,개인투자자,기관투자자,외국인투자자,공매도',
    '부동산': '부동산,아파트,청약,재건축,분양,임대,전세,월세,매매,갭투자,토지,상가,오피스텔,주택,재개발,용적률,건폐율,LTV,DSR,모기지,집값,경매,공실,임차,다주택,건설,인프라,개발,공사,도시개발,신도시,스마트시티,인공섬,항구,운하,다리,터널,공항,항만,입지,역세권,학군,건물,빌딩,고층빌딩,복합단지,상업시설,물류센터,데이터센터,도심,외곽,지방,수도권',
    '재테크/저축': '재테크,저축,적금,예금,절약,자산관리,가계부,짠테크,통장,금리비교,복리,저금,용돈,소비습관,돈모으기,목돈,비상금,카드추천,앱테크,부수입,부자,빈부,빈부격차,생활비,임금,월급,연봉,소비,지출,현금흐름,돈관리,재무,불로소득,자산증식,내집마련,생활수준,생활고,물가,가난,빈곤,계층이동,경제적독립,돈버는,부의공식,부의추월차선,행동경제학,소득',
    '경제 전망/시황': '금리,환율,경기,인플레이션,디플레이션,GDP,기준금리,연준,Fed,한은,경제전망,불황,호황,침체,글로벌,무역,수출,수입,유가,원자재,달러,엔화,위안,경제위기,스태그플레이션,긴축,양적완화,통화정책,트럼프,관세,무역전쟁,공황,대공황,파산,붕괴,경제붕괴,국가부도,구제금융,IMF,물가상승,성장률,경제성장,최빈국,이민,이민자,실업,실업률,제조업,에너지,자원,원유,천연가스,부채,국가부채,재정,재정적자,근황,경제상황,몰락,쇠퇴,추락,위기,격차,불평등,전쟁,국방,강대국,부국,금융위기,도산,세계경제,글로벌경제,국가경제,인구,저출산,고령화,산업,경제대공황,경기침체,성장,발전,선진국,개발도상국,잘사는,못사는,부진,회복,반등,전망,예측,전문가,경제학자,분석,보고서,지표,지수,통계',
    '세금/정책': '세금,연말정산,종합소득세,부가세,양도세,증여세,상속세,절세,세액공제,소득공제,정부정책,규제,법안,개정,국세청,세무,홈택스,사업자등록,종부세,취득세,재산세,복지,사회보장,지원금,보조금,민영화,국유화,공기업,개혁,공무원,관료,복지국가,세제,세법,법인세,누진세,탈세,탈루,탈세방지,정책금융,금융지원,보조금정책,산업정책,경제정책,재정정책,통화정책',
    '창업/사업': '창업,자영업,스타트업,부업,사업,프랜차이즈,매출,수익,소자본,온라인사업,쇼핑몰,유통,마케팅,브랜딩,사업계획,법인,개인사업자,배달,무인,N잡,투잡,사이드프로젝트,기업,대기업,그룹,재벌,브랜드,회사,도산,기업파산,적자,흑자,수익구조,돈버는방법,비즈니스모델,상권,폐점,폐업,식당,레스토랑,호텔,체인,나이키,롯데,현대,LG,SK,쿠팡,맥도날드,스타벅스,노키아,네이버,카카오,유니콘,IPO,M&A,합병,인수,상장기업,코스피기업,혁신,성공한기업,망한기업,폐업,파산기업,기업위기,기업전략,경영,CEO,창업자',
    '노후/연금': '노후,연금,퇴직,국민연금,개인연금,IRP,퇴직금,은퇴,실버,노년,연금저축,연금보험,기초연금,노후준비,노후자금,경제적자유,파이어족,조기은퇴,노인,고령화,초고령,인구감소,시니어,100세,노년기,은퇴준비,연금개혁,노인빈곤,정년,65세,60세,50대노후,노후생활',
  };
  const updateEcKw = db.prepare(`UPDATE categories SET keywords = ? WHERE group_name = '경제소재' AND name = ? AND (keywords IS NULL OR keywords = '')`);
  for (const [name, kws] of Object.entries(economyKeywords)) updateEcKw.run(kws, name);
}

// 기존 미분류 영상 자동 재분류 (매 서버 시작 시 미분류만 처리)
// default_fallback으로 배정된 기존 데이터 제거
try { db.exec(`DELETE FROM video_categories WHERE source = 'default_fallback'`); } catch(e) {}

try {
  const mgnRows = db.prepare(
    'SELECT material_group_name, category_name FROM category_settings WHERE material_group_name IS NOT NULL'
  ).all();

  const allCategories = db.prepare(`
    SELECT c.id, c.group_name, c.name, c.keywords
    FROM categories c
    WHERE c.group_name IN (
      SELECT material_group_name FROM category_settings WHERE material_group_name IS NOT NULL
    )
  `).all();

  const insertVc = db.prepare(
    'INSERT OR IGNORE INTO video_categories (video_id, category_id, source) VALUES (?, ?, ?)'
  );

  for (const { material_group_name: mgn, category_name: groupTag } of mgnRows) {
    const catsForGroup = allCategories.filter(c => c.group_name === mgn);
    if (catsForGroup.length === 0) continue;

    const catIds = catsForGroup.map(c => c.id);
    const placeholders = catIds.map(() => '?').join(',');

    const unclassified = db.prepare(`
      SELECT v.id, v.title, v.description
      FROM videos v
      JOIN channels ch ON v.channel_id = ch.id
      WHERE ch.group_tag = ?
        AND v.id NOT IN (
          SELECT vc.video_id FROM video_categories vc
          WHERE vc.category_id IN (${placeholders})
        )
    `).all(groupTag, ...catIds);

    if (unclassified.length === 0) continue;

    console.log(`[재분류] ${groupTag}: 미분류 ${unclassified.length}건 처리 시작`);

    let classified = 0;
    let stillUnclassified = 0;

    for (const v of unclassified) {
      const text = ((v.title || '') + ' ' + (v.description || '')).toLowerCase();
      const matchedIds = [];

      for (const cat of catsForGroup) {
        const kwString = cat.keywords || '';
        const keywords = kwString.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 0);
        const catNameLower = cat.name.toLowerCase();
        if (!keywords.includes(catNameLower)) keywords.push(catNameLower);
        if (cat.name.includes('/')) {
          cat.name.split('/').forEach(part => {
            const p = part.trim().toLowerCase();
            if (p && !keywords.includes(p)) keywords.push(p);
          });
        }
        for (const kw of keywords) {
          if (text.includes(kw)) { matchedIds.push(cat.id); break; }
        }
      }

      if (matchedIds.length > 0) {
        for (const catId of matchedIds) insertVc.run(v.id, catId, 'keyword_fallback');
        classified++;
      } else {
        stillUnclassified++;
      }
    }

    console.log(`[재분류] ${groupTag}: 분류됨 ${classified}건, 미분류 ${stillUnclassified}건`);
  }

  console.log('[재분류] 전체 완료');
} catch (e) {
  console.warn('[재분류] 실패:', e.message);
}

// ── Default data ─────────────────────────────────────────────────────────────

const stmtSettings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of [
  ['youtube_api_key', ''],
  ['gemini_api_key', ''],
  ['google_project_id', ''],
  ['google_location', 'us-central1'],
  ['transcript_enabled', 'true'],
  ['theme', 'dark'],
  ['genre_preset', 'custom'],
]) { stmtSettings.run(k, v); }


// ── Backup ───────────────────────────────────────────────────────────────────

function backupDB() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `yadam_${ts}.db`;
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, filename));
    // Keep last 10 only
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('yadam_') && f.endsWith('.db'))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - 10))) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
    console.log(`[DB] 백업 완료: ${filename}`);
  } catch(e) {
    console.error('[DB] 백업 실패:', e.message);
  }
}

export function getLastBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return null;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('yadam_') && f.endsWith('.db'))
      .sort();
    if (!files.length) return null;
    const last = files[files.length - 1];
    const stat = fs.statSync(path.join(BACKUP_DIR, last));
    return { filename: last, mtime: stat.mtime.toISOString() };
  } catch(e) { return null; }
}

db.exec(`CREATE TABLE IF NOT EXISTS excluded_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL UNIQUE,
  title TEXT,
  channel_name TEXT,
  reason TEXT DEFAULT 'manual_delete',
  excluded_at TEXT DEFAULT (datetime('now'))
)`);

backupDB();
console.log('✅ Database initialized');

// ── 1회성 고아 데이터 + 숏츠 정리 ────────────────────────────────────────────
try {
  // 고아 video_spike_rankings 정리 (삭제된 채널)
  db.exec(`DELETE FROM video_spike_rankings WHERE channel_id NOT IN (SELECT id FROM channels)`);
  // 고아 videos 정리 (삭제된 채널)
  db.exec(`DELETE FROM video_categories WHERE video_id IN (SELECT v.id FROM videos v WHERE v.channel_id NOT IN (SELECT id FROM channels))`);
  db.exec(`DELETE FROM videos WHERE channel_id NOT IN (SELECT id FROM channels)`);
  // 숏츠 영상 정리 (5분 이하)
  db.exec(`DELETE FROM video_spike_rankings WHERE duration_seconds <= 300`);
  db.exec(`DELETE FROM video_categories WHERE video_id IN (SELECT id FROM videos WHERE duration_seconds <= 300)`);
  db.exec(`DELETE FROM videos WHERE duration_seconds <= 300`);
  // duration NULL/0 영상 정리
  db.exec(`DELETE FROM video_spike_rankings WHERE duration_seconds IS NULL OR duration_seconds = 0`);
  db.exec(`DELETE FROM video_categories WHERE video_id IN (SELECT id FROM videos WHERE duration_seconds IS NULL OR duration_seconds = 0)`);
  db.exec(`DELETE FROM videos WHERE duration_seconds IS NULL OR duration_seconds = 0`);
  console.log('[DB] 고아 데이터 및 숏츠 정리 완료');
  // dual 카테고리(경제)의 실사 채널 spike_rankings 삭제
  db.exec(`
    DELETE FROM video_spike_rankings
    WHERE channel_id IN (
      SELECT id FROM channels
      WHERE group_tag IN (
        SELECT category_name FROM category_settings
        WHERE sub_type_mode = 'dual'
      )
      AND sub_type = '실사'
    )
  `);
  console.log('[DB] dual 카테고리 실사 데이터 정리 완료');
} catch(e) {
  console.warn('[DB] 데이터 정리 실패 (무시):', e.message);
}

// ── 임시 백업 테이블 정리 ─────────────────────────────────────────────────────
try {
  const backupTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_backup%'"
  ).all();
  for (const t of backupTables) {
    db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    console.log(`[DB 정리] 임시 테이블 삭제: ${t.name}`);
  }
  if (backupTables.length > 0) {
    db.exec('VACUUM');
    console.log(`[DB 정리] VACUUM 완료 — ${backupTables.length}개 테이블 제거`);
  }
} catch (e) {
  console.error('[DB 정리 실패]', e.message);
}

// ── 랭킹 재구축 ──────────────────────────────────────────────────────────────
import('./services/spike-rankings-builder.js').then(({ rebuildSpikeRankings }) => {
  try {
    rebuildSpikeRankings();
    console.log('[DB] 랭킹 재구축 완료');
  } catch(e) {
    console.warn('[DB] 랭킹 재구축 실패:', e.message);
  }
}).catch(e => console.warn('[DB] 랭킹 재구축 모듈 로드 실패:', e.message));

// ── Public API ───────────────────────────────────────────────────────────────

export function initDB() { return Promise.resolve(db); }
export function getDB() { return db; }
export function saveDB() { /* no-op: better-sqlite3 writes directly to disk */ }

export function queryAll(sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function queryOne(sql, params = []) {
  return db.prepare(sql).get(...params) ?? null;
}

export function runSQLNoSave(sql, params = []) {
  const info = db.prepare(sql).run(...params);
  return { changes: info.changes, lastId: info.lastInsertRowid };
}

export function runSQL(sql, params = []) {
  return runSQLNoSave(sql, params);
}

export function getMaterialGroupName(groupTag) {
  const row = db.prepare(
    'SELECT material_group_name FROM category_settings WHERE category_name = ?'
  ).get(groupTag);
  return row?.material_group_name || (groupTag + '소재');
}
