// Gap Analyzer — finds under-explored topic areas from category data
import { queryAll, queryOne, runSQL, getMaterialGroupName, getDB } from '../db.js';

// Build a cross-category matrix showing video counts per combination
export function buildGapMatrix(groupX, groupY) {
  // Get categories for each group
  const catsX = queryAll('SELECT * FROM categories WHERE group_name = ? ORDER BY sort_order', [groupX]);
  const catsY = queryAll('SELECT * FROM categories WHERE group_name = ? ORDER BY sort_order', [groupY]);

  if (catsX.length === 0 || catsY.length === 0) {
    return { xLabels: [], yLabels: [], matrix: [], gaps: [] };
  }

  // Build matrix
  const matrix = [];
  const gaps = [];
  let maxCount = 0;

  for (const cy of catsY) {
    const row = [];
    for (const cx of catsX) {
      // Count videos with both categories
      const result = queryAll(`
        SELECT COUNT(DISTINCT vc1.video_id) as cnt
        FROM video_categories vc1
        JOIN video_categories vc2 ON vc1.video_id = vc2.video_id
        WHERE vc1.category_id = ? AND vc2.category_id = ?
      `, [cx.id, cy.id]);
      const count = result[0]?.cnt || 0;
      row.push(count);
      if (count > maxCount) maxCount = count;

      if (count <= 2) {
        gaps.push({
          x: cx.name,
          y: cy.name,
          count,
          opportunity: count === 0 ? 'high' : 'medium'
        });
      }
    }
    matrix.push(row);
  }

  // 고수요(인기 있는) 영역부터 분석되도록 정렬 (사용자 요청 반영: 포화 영역 우선)
  gaps.sort((a, b) => b.count - a.count);

  return {
    xLabels: catsX.map(c => c.name),
    yLabels: catsY.map(c => c.name),
    xColors: catsX.map(c => c.color),
    yColors: catsY.map(c => c.color),
    matrix,
    maxCount,
    gaps: gaps.slice(0, 30)
  };
}

// Get category distribution (for donut charts)
export function getCategoryDistribution(groupName) {
  const data = queryAll(`
    SELECT c.name, c.color, COUNT(vc.video_id) as count
    FROM categories c
    LEFT JOIN video_categories vc ON c.id = vc.category_id
    WHERE c.group_name = ?
    GROUP BY c.id
    ORDER BY count DESC
  `, [groupName]);
  return data;
}

// Get all category groups
export function getCategoryGroups() {
  const data = queryAll('SELECT DISTINCT group_name FROM categories ORDER BY group_name');
  return data.map(d => d.group_name);
}

// Get monthly trend data
export function getTrends(months = 12) {
  const data = queryAll(`
    SELECT 
      strftime('%Y-%m', published_at) as month,
      COUNT(*) as count
    FROM videos
    WHERE published_at IS NOT NULL
      AND published_at >= date('now', '-${months} months')
    GROUP BY month
    ORDER BY month
  `);
  return data;
}

// Get trend by category
export function getTrendsByCategory(groupName, months = 12) {
  const data = queryAll(`
    SELECT 
      strftime('%Y-%m', v.published_at) as month,
      c.name as category,
      c.color,
      COUNT(*) as count
    FROM videos v
    JOIN video_categories vc ON v.id = vc.video_id
    JOIN categories c ON vc.category_id = c.id
    WHERE c.group_name = ?
      AND v.published_at IS NOT NULL
      AND v.published_at >= date('now', '-${months} months')
    GROUP BY month, c.id
    ORDER BY month
  `, [groupName]);
  return data;
}
// Multi-category analysis for a filtered set of videos
export function getMultiGapAnalysis(selectedCategoryIds = []) {
  let videoIds = [];
  const allCategories = queryAll('SELECT * FROM categories ORDER BY group_name, sort_order');
  const groups = [...new Set(allCategories.map(c => c.group_name))];

  if (selectedCategoryIds.length > 0) {
    // Find videos that have ALL selected categories
    const placeholders = selectedCategoryIds.map(() => '?').join(',');
    const results = queryAll(`
            SELECT video_id FROM video_categories 
            WHERE category_id IN (${placeholders})
            GROUP BY video_id
            HAVING COUNT(DISTINCT category_id) = ?
        `, [...selectedCategoryIds, selectedCategoryIds.length]);
    videoIds = results.map(r => r.video_id);
  } else {
    // If nothing selected, analyze overall saturation
    const results = queryAll('SELECT id as video_id FROM videos');
    videoIds = results.map(r => r.video_id);
  }

  if (videoIds.length === 0) {
    return { totalVideos: 0, groupDistributions: {}, gaps: [] };
  }

  // For each group, calculate distribution within the filtered videos
  const groupDistributions = {};
  const gaps = [];

  for (const group of groups) {
    const groupCats = allCategories.filter(c => c.group_name === group);
    const distribution = [];

    for (const cat of groupCats) {
      const countResult = queryAll(`
                SELECT COUNT(DISTINCT video_id) as cnt FROM video_categories 
                WHERE category_id = ? AND video_id IN (${videoIds.join(',')})
            `, [cat.id]);
      const count = countResult[0]?.cnt || 0;
      const percentage = Math.round((count / videoIds.length) * 100);

      distribution.push({ id: cat.id, name: cat.name, count, percentage, color: cat.color });

      // Mark as gap if percentage < 30%
      if (percentage < 30) {
        gaps.push({ group, name: cat.name, percentage, count, opportunity: count === 0 ? 'high' : 'medium' });
      }
    }
    groupDistributions[group] = distribution;
  }

  return {
    totalVideos: videoIds.length,
    groupDistributions,
    gaps: gaps.sort((a, b) => a.percentage - b.percentage).slice(0, 15)
  };
}

// Helper: Categorize an external video by its title and description
export function categorizeVideoByKeywords(video, categories, groupTag) {
  const text = ((video.title || '') + ' ' + (video.description || '')).toLowerCase();
  const matchedIds = [];

  let targetCategories = categories;
  if (groupTag) {
    const mgn = getMaterialGroupName(groupTag);
    if (mgn) {
      targetCategories = categories.filter(c => c.group_name === mgn);
    }
  }

  const allMgn = getDB().prepare(
    'SELECT material_group_name FROM category_settings WHERE material_group_name IS NOT NULL'
  ).all().map(r => r.material_group_name);

  for (const cat of targetCategories) {
    if (!allMgn.includes(cat.group_name)) continue;

    // DB keywords 컬럼에서 키워드 목록 가져오기
    const kwString = cat.keywords || '';
    const keywords = kwString
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0);

    // 카테고리 이름 자체도 키워드로 추가
    const catNameLower = cat.name.toLowerCase();
    if (!keywords.includes(catNameLower)) keywords.push(catNameLower);

    // 이름에 / 가 있으면 각 부분도 키워드로 추가
    if (cat.name.includes('/')) {
      cat.name.split('/').forEach(part => {
        const p = part.trim().toLowerCase();
        if (p && !keywords.includes(p)) keywords.push(p);
      });
    }

    for (const kw of keywords) {
      if (text.includes(kw)) {
        matchedIds.push(cat.id);
        break;
      }
    }
  }
  return matchedIds;
}

// DB에 야담 분석용 기본 카테고리가 없으면 자동 삽입
// 구 그룹('시대', '인물유형', '소재출처', '지역')은 DB 마이그레이션에서 삭제됨 — 재삽입 금지
export function ensureYadamCategories() {
  // no-op: 삭제된 그룹을 재생성하지 않도록 비워둠
}

/**
 * 데이터베이스 통계 추출: 전체 영상 수 및 AI 분석 완료 영상 수
 */
export function getDatabaseStats() {
  const total = queryOne("SELECT COUNT(*) as cnt FROM videos");
  const analyzed = queryOne("SELECT COUNT(*) as cnt FROM videos WHERE is_analyzed = 1");
  const categorized = queryOne("SELECT COUNT(DISTINCT video_id) as cnt FROM video_categories");

  return {
    total: total?.cnt || 0,
    analyzed: analyzed?.cnt || 0,
    categorized: categorized?.cnt || 0,
    percent: total?.cnt > 0 ? Math.round((analyzed?.cnt / total?.cnt) * 100) : 0
  };
}

/**
 * 5중 교집합 통합 분석: [시대+사건+소재+인물+지역]이 모두 겹치는 가장 인기 있는 조합 Top 10 추출
 */
export function buildCombinedNicheRanking(groupTag = '야담') {
  const mgn = getMaterialGroupName(groupTag);
  const topCombinations = queryAll(`
    SELECT
      c2.name as event, c2.id as eventId,
      COUNT(DISTINCT v.id) as count
    FROM videos v
    JOIN channels ch ON v.channel_id = ch.id AND ch.group_tag = ?
    JOIN video_categories vc2 ON v.id = vc2.video_id
    JOIN categories c2 ON vc2.category_id = c2.id AND c2.group_name = ?
    GROUP BY c2.id
    ORDER BY count DESC
    LIMIT 15
  `, [groupTag, mgn]);

  return topCombinations.map(combo => ({
    label: combo.event,
    count: combo.count,
    event: combo.event,
    eventId: combo.eventId,
  }));
}

// Special Yadam Analysis: 소재별 영상 분포 분석
export function buildYadamGapMatrix(groupTag = '야담', externalVideos = []) {
  const mgn = getMaterialGroupName(groupTag);

  // 소재 카테고리 (Y축)
  const catsEvent = queryAll("SELECT * FROM categories WHERE group_name = ? ORDER BY sort_order", [mgn]);
  const hasEventCats = catsEvent.length > 0;

  const gaps = [];
  let globalMaxCount = 0;

  // Y축: 소재 카테고리 레이블
  const yLabels = [];
  const yMetaData = [];

  if (hasEventCats) {
    for (const event of catsEvent) {
      yLabels.push(event.name);
      yMetaData.push({ eventId: event.id, eventName: event.name });
    }
  } else {
    yLabels.push('전체 소재');
    yMetaData.push({ eventId: 0, eventName: '전체 소재' });
  }

  const allRowCells = [];
  for (let yi = 0; yi < yMetaData.length; yi++) {
    const meta = yMetaData[yi];
    const eventSql = meta.eventId === 0 ? '1=1' : `vc1.category_id = ${meta.eventId}`;

    // 소재 영상 수 단일 카운트
    const cntRow = queryOne(`
      SELECT COUNT(DISTINCT v.id) as cnt
      FROM videos v
      JOIN channels ch ON v.channel_id = ch.id AND ch.group_tag = ?
      JOIN video_categories vc1 ON v.id = vc1.video_id AND ${eventSql}
    `, [groupTag]);
    const cnt = cntRow?.cnt || 0;

    if (cnt > globalMaxCount) globalMaxCount = cnt;

    const cell = {
      label: meta.eventName,
      fullLabel: meta.eventName,
      count: cnt,
      meta: { eventId: meta.eventId }
    };

    gaps.push({
      x: meta.eventName,
      y: meta.eventName,
      count: cnt,
      level: 0,
      rawY: yLabels[yi],
      grX: '소재',
      grY: '소재',
      meta: cell.meta
    });

    allRowCells.push([cell]);
  }

  // 레벨 계산
  gaps.forEach(g => {
    if (globalMaxCount > 0) {
      const ratio = g.count / globalMaxCount;
      if (ratio < 0.1) g.level = 1;
      else if (ratio < 0.25) g.level = 2;
      else if (ratio < 0.5) g.level = 3;
      else if (ratio < 0.75) g.level = 4;
      else g.level = 5;
    } else {
      g.level = 1; // 기준점 없을 시 최하위 레벨
    }
  });

  gaps.sort((a, b) => b.count - a.count);

  const stats = getDatabaseStats();
  const topCombined = buildCombinedNicheRanking(groupTag);

  return {
    yLabels,
    allRowCells,
    maxCount: globalMaxCount,
    gaps: gaps.slice(0, 30),
    stats,
    topCombined,
    groups: { x: '소재', y: '소재' },
    debugCounts: { dropReason: 'SUCCESS' }
  };
}
// Economy Trend Analysis — Scoring based on Freshness, Trend, and Impact
export function getEconomyTrendAnalysis(periodDays = 30) {
  const mainCats = queryAll("SELECT * FROM categories WHERE group_name = '경제(메인)' ORDER BY sort_order");
  const subCats = queryAll("SELECT * FROM categories WHERE group_name = '경제(최신분류)' ORDER BY sort_order");

  // Sub-issue keyword map (fallback when no DB sub-categories exist)
  const ISSUE_MAP = {
    '금리 / 금융 환경': [
      { name: '기준금리', keywords: ['기준금리', '금리인하', '금리인상', '한국은행'] },
      { name: '대출금리', keywords: ['대출금리', '주담대', '담보대출', '주택담보'] },
      { name: '예금금리', keywords: ['예금금리', '예금', '적금', '저축'] },
      { name: '통화정책', keywords: ['통화정책', '양적완화', '긴축', '통화량'] },
      { name: '환율', keywords: ['환율', '달러', '원달러', '외환'] },
    ],
    '부동산 / 주거': [
      { name: '담보대출', keywords: ['주담대', '담보대출', '주택담보', 'LTV', 'DSR'] },
      { name: '아파트 시세', keywords: ['아파트', '시세', '집값', '매매가'] },
      { name: '전세', keywords: ['전세', '전세금', '전세사기', '역전세'] },
      { name: '청약', keywords: ['청약', '분양', '청약통장', '당첨'] },
      { name: '재건축', keywords: ['재건축', '재개발', '정비사업', '용적률'] },
    ],
    '경제 종합': [
      { name: 'GDP / 성장률', keywords: ['GDP', '성장률', '경제성장', '잠재성장'] },
      { name: '물가 / 인플레이션', keywords: ['물가', '인플레', 'CPI', '소비자물가'] },
      { name: '소비 / 내수', keywords: ['소비', '내수', '소비심리', '가계지출'] },
      { name: '수출입', keywords: ['수출', '수입', '무역수지', '경상수지'] },
      { name: '실업 / 취업', keywords: ['실업', '취업', '고용', '일자리'] },
    ],
    '글로벌 경제 / 국제 이슈': [
      { name: '미국 경제', keywords: ['미국경제', 'FED', '연준', '미금리'] },
      { name: '중국 경제', keywords: ['중국경제', '중국', '차이나', '디커플링'] },
      { name: '관세 / 무역전쟁', keywords: ['관세', '무역전쟁', '트럼프', '보호무역'] },
      { name: '원자재', keywords: ['원자재', '유가', '원유', '금값'] },
      { name: '이머징마켓', keywords: ['이머징', '신흥국', '동남아', '인도'] },
    ],
    '주식 / 투자 시장': [
      { name: '코스피 / 코스닥', keywords: ['코스피', '코스닥', '주가', '주식'] },
      { name: '나스닥 / S&P', keywords: ['나스닥', 's&p', 'S&P', '미국증시', '미장'] },
      { name: 'ETF / 펀드', keywords: ['ETF', '펀드', '인덱스', '리츠'] },
      { name: '채권', keywords: ['채권', '국채', '회사채', '금리채'] },
      { name: 'IPO / 공모주', keywords: ['IPO', '공모주', '상장', '청약'] },
    ],
    '코인 / 디지털 자산': [
      { name: '비트코인', keywords: ['비트코인', 'BTC', '비트', '암호화폐'] },
      { name: '이더리움', keywords: ['이더리움', 'ETH', '이더'] },
      { name: '알트코인', keywords: ['알트코인', '리플', '솔라나', '도지'] },
      { name: '규제 / SEC', keywords: ['SEC', '규제', '가상자산법', '코인규제'] },
      { name: '스테이블코인', keywords: ['스테이블코인', 'USDT', 'USDC'] },
    ],
    '경제 인물 / 시장 발언': [
      { name: '중앙은행 총재', keywords: ['파월', '한국은행총재', '이창용', '연준의장'] },
      { name: '정부 / 기획재정부', keywords: ['기재부', '기획재정부', '재정부', '예산'] },
      { name: '기업인 발언', keywords: ['CEO', '대표이사', '삼성', '현대'] },
      { name: '경제학자', keywords: ['경제학자', '교수', '전문가', '분석'] },
    ],
    '생활경제 / 물가': [
      { name: '식품 물가', keywords: ['식품', '먹거리', '밥값', '음식값'] },
      { name: '에너지 / 공과금', keywords: ['전기요금', '가스요금', '에너지', '공과금'] },
      { name: '교통 / 유류비', keywords: ['휘발유', '기름값', '유류비', '교통비'] },
      { name: '의료비', keywords: ['의료비', '병원비', '건강보험', '의료'] },
    ],
    '정부 정책 / 세금': [
      { name: '세금 / 세제', keywords: ['세금', '세제', '종부세', '부동산세'] },
      { name: '복지 정책', keywords: ['복지', '지원금', '보조금', '수당'] },
      { name: '규제 / 완화', keywords: ['규제완화', '규제개혁', '완화', '행정'] },
      { name: '재정 / 예산', keywords: ['재정', '예산', '적자', '국가부채'] },
    ],
    '노후 / 연금 / 자산관리': [
      { name: '국민연금', keywords: ['국민연금', '연금개혁', '연금', '노령연금'] },
      { name: '퇴직연금', keywords: ['퇴직연금', 'IRP', '퇴직금', '연금저축'] },
      { name: '노후 자산', keywords: ['노후', '은퇴', '자산관리', '재산'] },
      { name: '상속 / 증여', keywords: ['상속', '증여', '상속세', '증여세'] },
    ],
    '개인 재테크 / 돈 관리': [
      { name: '저축 / 투자', keywords: ['저축', '재테크', '투자', '절약'] },
      { name: '부채 관리', keywords: ['빚', '부채', '대출상환', '신용'] },
      { name: '신용 / 대출', keywords: ['신용점수', '신용등급', '소액대출', '신용대출'] },
      { name: '보험', keywords: ['보험', '생명보험', '실손보험', '암보험'] },
    ],
  };

  if (mainCats.length === 0) return { categories: [], mainCategories: [], topics: [] };

  const now = new Date();
  const results = [];

  // Score calculator for a list of videos
  const scoreVideos = (videos, cat) => {
    if (videos.length === 0) {
      const baseline = (cat.group_name === '경제(메인)') ? 25 : 15;
      return { count: 0, freshScore: baseline, trendScore: baseline + 5, impactScore: baseline + 10, finalScore: baseline + 5 };
    }
    let totalFresh = 0, totalImpact = 0, totalInterest = 0;
    videos.forEach(v => {
      const pubDate = new Date(v.published_at);
      const daysDiff = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
      const fresh = Math.max(10, 100 - (daysDiff * 1.5));
      totalFresh += fresh;
      try {
        const meta = JSON.parse(v.economy_metadata || '{}');
        totalImpact += meta.impact ? (Object.values(meta.impact).reduce((a, b) => a + b, 0) / Object.values(meta.impact).length) : 3.5;
        totalInterest += meta.interest ? (meta.interest['전체'] || 3.5) : 3.5;
      } catch (e) { totalImpact += 3.5; totalInterest += 3.5; }
    });
    const avgFresh = totalFresh / videos.length;
    const avgImpact = (totalImpact / videos.length) * 20;
    const avgInterest = (totalInterest / videos.length) * 20;
    const volumeDensity = Math.min(100, (videos.length / Math.max(1, periodDays / 7)) * 20);
    const trendScore = (volumeDensity * 0.5) + (avgInterest * 0.5);
    const finalScore = Math.round((avgFresh * 0.35) + (avgInterest * 0.35) + (volumeDensity * 0.30));
    return { count: videos.length, freshScore: Math.round(avgFresh), trendScore: Math.round(trendScore), impactScore: Math.round(avgImpact), finalScore };
  };

  // Helper: get videos for keywords via title/description match
  const getVideosForKeywords = (keywords) => {
    if (!keywords || keywords.length === 0) return [];
    const likeClauses = keywords.map(() => '(title LIKE ? OR description LIKE ?)').join(' OR ');
    const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
    return queryAll(`SELECT * FROM videos WHERE (${likeClauses}) AND published_at >= date('now', '-365 days') LIMIT 30`, params);
  };

  // Build main category results with sub-issues
  const mainCategoryResults = [];

  for (const cat of mainCats) {
    // Get directly tagged videos
    let videos = queryAll(`
      SELECT v.* FROM videos v
      JOIN video_categories vc ON v.id = vc.video_id
      WHERE vc.category_id = ? AND v.published_at >= date('now', '-${periodDays} days')
    `, [cat.id]);

    if (videos.length === 0) {
      const keywords = cat.name.split(/[\/\s,]+/).filter(k => k.length >= 2);
      if (keywords.length > 0) {
        const likeClauses = keywords.map(() => '(title LIKE ? OR description LIKE ?)').join(' OR ');
        const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
        videos = queryAll(`SELECT * FROM videos WHERE (${likeClauses}) AND published_at >= date('now', '-365 days') LIMIT 50`, params);
      }
    }

    const scores = scoreVideos(videos, cat);

    // Build sub-issues
    const issueListRaw = ISSUE_MAP[cat.name] || [];
    const subIssues = issueListRaw.map(issue => {
      const issueVideos = getVideosForKeywords(issue.keywords);
      const s = scoreVideos(issueVideos, { group_name: '경제(최신분류)' });

      // Color based on score
      let color = '#4b5563';
      if (s.finalScore >= 75) color = '#ef4444';
      else if (s.finalScore >= 55) color = '#f97316';
      else if (s.finalScore >= 35) color = '#eab308';
      else if (s.finalScore >= 15) color = '#22c55e';

      return { name: issue.name, score: s.finalScore, color, count: s.count };
    }).sort((a, b) => b.score - a.score);

    // Also check DB sub-categories that match this main category by keyword
    const matchedSubCats = subCats.filter(sc => {
      const mainKeywords = cat.name.split(/[\/\s,]+/).filter(k => k.length >= 2);
      return mainKeywords.some(kw => sc.name.includes(kw) || cat.name.includes(kw.substring(0, Math.min(kw.length, 4))));
    });

    matchedSubCats.forEach(sc => {
      if (!subIssues.find(si => si.name === sc.name)) {
        const scVideos = queryAll(`SELECT v.* FROM videos v JOIN video_categories vc ON v.id=vc.video_id WHERE vc.category_id=? LIMIT 30`, [sc.id]);
        const s = scoreVideos(scVideos, sc);
        subIssues.push({ name: sc.name, score: s.finalScore, color: sc.color || '#4b5563', count: s.count });
      }
    });

    subIssues.sort((a, b) => b.score - a.score);

    results.push({
      id: cat.id, name: cat.name, group: cat.group_name,
      count: scores.count, freshScore: scores.freshScore, trendScore: scores.trendScore,
      impactScore: scores.impactScore, finalScore: scores.finalScore,
      subIssues: subIssues.slice(0, 6),
      videos: videos.slice(0, 5).map(v => ({ title: v.title }))
    });

    mainCategoryResults.push({ name: cat.name, score: scores.finalScore });
  }

  // Also score sub-categories separately for compatibility
  const allResults = [...results];
  for (const cat of subCats) {
    const videos = queryAll(`SELECT v.* FROM videos v JOIN video_categories vc ON v.id=vc.video_id WHERE vc.category_id=? AND v.published_at >= date('now', '-${periodDays} days')`, [cat.id]);
    const scores = scoreVideos(videos, cat);
    allResults.push({
      id: cat.id, name: cat.name, group: cat.group_name,
      ...scores, subIssues: [],
      videos: videos.slice(0, 3).map(v => ({ title: v.title }))
    });
  }

  allResults.sort((a, b) => b.finalScore - a.finalScore);

  return {
    period: periodDays,
    categories: allResults,
    mainCategories: results.sort((a, b) => b.finalScore - a.finalScore),
    topRecommendations: results.slice(0, 5)
  };
}

// 드릴 다운: 사건×소재 교차점 클릭 시 해당 테마 내 소재 그룹별 분포 반환
export function getNicheDetailGrid(eventId = 0, materialId = 0, groupTag = '야담') {
  const allMgn = getDB().prepare(
    'SELECT material_group_name FROM category_settings WHERE material_group_name IS NOT NULL'
  ).all().map(r => r.material_group_name);

  const eventSql   = eventId    > 0 ? `vc_event.category_id = ${parseInt(eventId)}`  : '1=1';
  const materialSql = materialId > 0 ? `vc_mat.category_id = ${parseInt(materialId)}` : '1=1';

  // 해당 테마에 속하는 영상 ID 목록 (최대 5000개)
  const themeVideoIds = queryAll(`
    SELECT DISTINCT v.id
    FROM videos v
    JOIN channels ch ON v.channel_id = ch.id AND ch.group_tag = ?
    JOIN video_categories vc_event ON v.id = vc_event.video_id AND ${eventSql}
    JOIN video_categories vc_mat   ON v.id = vc_mat.video_id   AND ${materialSql}
    LIMIT 5000
  `, [groupTag]).map(r => r.id);

  if (themeVideoIds.length === 0) return { groups: [], totalVideos: 0 };

  const idList = themeVideoIds.join(',');

  // 조회할 세부 카테고리 그룹: DB에서 동적 조회
  const detailGroups = allMgn;

  const groups = [];
  let globalMax = 0;

  for (const groupName of detailGroups) {
    const rows = queryAll(`
      SELECT c.id, c.name, COUNT(DISTINCT vc.video_id) as cnt
      FROM video_categories vc
      JOIN categories c ON vc.category_id = c.id AND c.group_name = ?
      WHERE vc.video_id IN (${idList})
      GROUP BY c.id
      ORDER BY cnt DESC
    `, [groupName]);

    if (rows.length === 0) continue;

    const groupMax = rows[0].cnt;
    if (groupMax > globalMax) globalMax = groupMax;

    const cells = rows.map(r => {
      const ratio = groupMax > 0 ? r.cnt / groupMax : 0;
      let level = 1;
      if (ratio >= 0.75) level = 5;
      else if (ratio >= 0.5) level = 4;
      else if (ratio >= 0.25) level = 3;
      else if (ratio >= 0.1) level = 2;

      return {
        id: r.id,
        label: r.name,
        count: r.cnt,
        level,
        // 초록색(level 1~2) 제외 여부: 사용자 요청에 따라 level >= 3만 포함
        isVisible: level >= 3
      };
    }).filter(c => c.isVisible);

    if (cells.length > 0) {
      groups.push({ groupName, cells, groupMax });
    }
  }

  return { groups, totalVideos: themeVideoIds.length };
}

/**
 * 소재별 포화도 분석: 각 소재의 영상 수, 평균 조회수, 떡상 비율 → 포화도 점수 반환
 */
export function buildMaterialSaturation(genre = '야담') {
  const mgn = getMaterialGroupName(genre);
  const rows = queryAll(`
    SELECT
      c.id AS categoryId,
      c.name AS material,
      COUNT(DISTINCT vc.video_id) AS videoCount,
      ROUND(AVG(v.view_count)) AS avgViews,
      MAX(v.view_count) AS maxViews,
      ROUND(AVG(v.like_count)) AS avgLikes,
      SUM(CASE
        WHEN ch.subscriber_count > 0
          AND v.view_count >= ch.subscriber_count * 5.0
        THEN 1 ELSE 0
      END) AS spikeCount
    FROM video_categories vc
    JOIN videos v ON v.id = vc.video_id
    JOIN channels ch ON ch.id = v.channel_id
    JOIN categories c ON c.id = vc.category_id
    WHERE c.group_name = ?
    GROUP BY c.id, c.name
    ORDER BY c.sort_order ASC
  `, [mgn]);

  const totalRow = queryOne(
    `SELECT COUNT(DISTINCT v.id) as cnt FROM videos v JOIN channels ch ON ch.id = v.channel_id WHERE ch.group_tag = ?`,
    [genre]
  );
  const totalVideos = totalRow?.cnt || 0;
  const maxVideoCount = Math.max(...rows.map(r => r.videoCount), 1);

  const materials = rows.map(r => {
    const spikeRatio = r.videoCount > 0 ? Math.round(r.spikeCount / r.videoCount * 100) / 100 : 0;
    const volumeRatio = maxVideoCount > 0 ? r.videoCount / maxVideoCount : 0;
    const saturationScore = Math.round(volumeRatio * 60 + (1 - spikeRatio) * 40);
    const saturationLevel = saturationScore >= 80 ? 'saturated' : saturationScore >= 50 ? 'moderate' : 'opportunity';
    return {
      categoryId: r.categoryId,
      material: r.material,
      videoCount: r.videoCount,
      avgViews: r.avgViews || 0,
      maxViews: r.maxViews || 0,
      avgLikes: r.avgLikes || 0,
      spikeCount: r.spikeCount || 0,
      spikeRatio,
      saturationScore,
      saturationLevel,
    };
  });

  // 포화도 내림차순 정렬 (높은 포화도 → 낮은 포화도)
  materials.sort((a, b) => b.saturationScore - a.saturationScore);

  return { genre, totalVideos, materials };
}
