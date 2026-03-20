import { Router } from 'express';
import { queryAll, queryOne, runSQL, runSQLNoSave, saveDB, getDB, getMaterialGroupName } from '../db.js';
import { callGemini, suggestTopics, analyzeComments, generateBenchmarkReport } from '../services/gemini-service.js';
import { buildGapMatrix, buildYadamGapMatrix, getEconomyTrendAnalysis, getCategoryDistribution, getCategoryGroups, getTrends, getTrendsByCategory, getNicheDetailGrid, buildMaterialSaturation } from '../services/gap-analyzer.js';
import { fetchComments, refreshVideoStats } from '../services/youtube-fetcher.js';
import { fetchTranscript } from '../services/transcript-fetcher.js';
import { pickSpikeVideos } from '../services/spike-selector.js';
import { extractSpikeDNA, formatDNAForPrompt } from '../services/dna-extractor.js';
import { extractAdvancedDNA } from '../services/advanced-dna-extractor.js';
import { logToFile } from '../utils/logger.js';
import { rebuildSpikeRankings, analyzeRankingChanges } from '../services/spike-rankings-builder.js';

const router = Router();

const dnaJobs = new Map();


// GET /api/analysis/keywords — top keywords
router.get('/keywords', (req, res) => {
    try {
        const { limit = 30 } = req.query;
        const keywords = queryAll(`
      SELECT k.id, k.word, k.total_count, k.is_saturated 
      FROM keywords k 
      ORDER BY k.total_count DESC 
      LIMIT ?
    `, [parseInt(limit)]);
        res.json(keywords);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/analysis/categories — category distribution
router.get('/categories', (req, res) => {
    try {
        const { group } = req.query;
        const groups = getCategoryGroups();
        if (group) {
            res.json(getCategoryDistribution(group));
        } else {
            const result = {};
            for (const g of groups) { result[g] = getCategoryDistribution(g); }
            res.json({ groups, distributions: result });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/analysis/gaps/yadam — special yadam mode (Hybrid: DB + Real-time)
router.get('/gaps/yadam', async (req, res) => {
    try {
        console.log('[YadamGaps] 야담 하이브리드 분석 요청 수신');

        // 0. DB State for Debugging
        const channelCount = (queryOne('SELECT COUNT(*) as cnt FROM channels') || { cnt: 0 }).cnt;
        const localVideoCount = (queryOne('SELECT COUNT(*) as cnt FROM videos') || { cnt: 0 }).cnt;
        const geminiKey = queryOne("SELECT value FROM settings WHERE key = 'gemini_api_key'")?.value;
        const cloudRunUrl = queryOne("SELECT value FROM settings WHERE key = 'cloud_run_url'")?.value?.trim();

        // 1. Key Check & Mode Selection
        const hasGeminiKey = geminiKey && geminiKey.trim() !== '';
        const hasCloudRun = !!cloudRunUrl;
        const isVertex = geminiKey?.startsWith('AQ');
        const googleProjectId = queryOne("SELECT value FROM settings WHERE key = 'google_project_id'")?.value;
        const hasProjectID = googleProjectId && googleProjectId.trim() !== '';

        if ((!hasGeminiKey && !hasCloudRun) || (isVertex && !hasProjectID)) {
            console.log('[YadamGaps] 필수 Gemini API 키 또는 Project ID가 누락되었습니다.');
            return res.json({
                xLabels: [], yLabels: [], matrix: [], gaps: [], suggestions: [],
                externalSourceCount: 0,
                isHybrid: false,
                debugCounts: {
                    channelCount,
                    collectedVideoCountLocal: localVideoCount,
                    collectedVideoCountExternal: 0,
                    topicCount: 0,
                    dropReason: 'MISSING_GEMINI_KEY'
                }
            });
        }

        // DB에 등록된 채널의 수집 영상만으로 분석 (YouTube API 실시간 검색 제거됨)
        let externalVideos = [];

        // 2-1. Fetch Local Videos for Hybrid Merge
        const localVideos = queryAll(`
            SELECT v.*, group_concat(vc.category_id) as categoryIds
            FROM videos v
            JOIN video_categories vc ON v.id = vc.video_id
            GROUP BY v.id
        `).map(v => ({
            ...v,
            matchedCategoryIds: (v.categoryIds || '').split(',').map(Number)
        }));

        // 3. Extract Spike DNA from Combined Pool
        const combinedPool = [...localVideos, ...externalVideos];
        const spikeResult = pickSpikeVideos(combinedPool, { minRatio: 3, topPercent: 0.15 });
        const dnaSummary = extractSpikeDNA(spikeResult.spikes);
        const dnaPromptStr = formatDNAForPrompt(dnaSummary);

        logToFile(`[YadamGaps] 하이브리드 DNA 추출 완료 (Spikes: ${spikeResult.spikes.length}개)`);

        // 4. Build Hybrid Matrix
        const matrix = buildYadamGapMatrix('야담', externalVideos);

        // 5. Determine Final Drop Reason
        let dropReason = matrix.debugCounts?.dropReason || '정상';
        if (channelCount === 0 && externalVideos.length === 0) {
            dropReason = 'NO_CHANNELS';
        } else if (localVideoCount === 0 && externalVideos.length === 0) {
            dropReason = 'NO_VIDEOS';
        }

        // 인기 주제 suggestions: 영상 수 상위 10개 셀
        const topCells = (matrix.gaps || []).filter(g => g.count > 0).slice(0, 10);
        const suggestions = topCells.map(g => {
            let sampleVideos = [];
            try {
                const { eventId } = g.meta || {};
                const conds = [];
                const params = [];
                if (eventId) { conds.push('EXISTS (SELECT 1 FROM video_categories WHERE video_id = v.id AND category_id = ?)'); params.push(eventId); }
                if (conds.length > 0) {
                    sampleVideos = queryAll(
                        `SELECT v.title, v.view_count FROM videos v WHERE ${conds.join(' AND ')} ORDER BY v.view_count DESC LIMIT 5`,
                        params
                    );
                }
            } catch (e) { /* skip */ }
            const avgViewCount = sampleVideos.length > 0
                ? Math.round(sampleVideos.reduce((s, v) => s + (v.view_count || 0), 0) / sampleVideos.length)
                : 0;
            return {
                title: g.x,
                catX: g.x,
                catY: g.y,
                count: g.count,
                level: g.level,
                gap_rate: Math.round(g.level / 5 * 100),
                analyzed_video_count: g.count,
                avg_view_count: avgViewCount,
                sample_titles: sampleVideos.slice(0, 3).map(v => v.title),
                reason: `이 주제는 떡상 영상 ${g.count}개가 존재하는 인기 주제입니다. 차별화된 대본으로 경쟁력을 확보하세요.`,
            };
        });

        // 1단계: 분포도 중심 응답 (Stage 1: Distribution View)
        res.json({
            ...matrix,
            suggestions,
            dna_analysis: '',
            externalSourceCount: externalVideos.length,
            isHybrid: true,
            debugCounts: {
                channelCount,
                collectedVideoCountLocal: localVideoCount,
                collectedVideoCountExternal: externalVideos.length,
                spikeCount: spikeResult.spikes.length,
                topicCount: 0,
                dropReason
            }
        });
    } catch (err) {
        logToFile(`[YadamGaps] ❌ 전체 과정 에러: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/analysis/gaps/yadam/detail — 특정 수퍼 니치 테마의 세부 [인물 x 지역] 분포 (드릴 다운)
router.get('/gaps/yadam/detail', (req, res) => {
    try {
        const { eventId = '0', materialId = '0', groupTag = '야담' } = req.query;
        const data = getNicheDetailGrid(parseInt(eventId), parseInt(materialId), groupTag);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/analysis/gaps/material-saturation — 소재별 포화도 분석
router.get('/gaps/material-saturation', (req, res) => {
    try {
        const { genre = '야담' } = req.query;
        const result = buildMaterialSaturation(genre);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/analysis/gaps/economy — special economy mode (TREND & SCORE BASED)
router.get('/gaps/economy', async (req, res) => {
    try {
        const { period = 30 } = req.query;
        console.log(`[EconomyTrends] 경제 분석 요청 수신 (기간: ${period}일)`);

        const data = getEconomyTrendAnalysis(parseInt(period));

        // Get AI suggestions based on top scoring categories
        let suggestions = [];
        if (data.topRecommendations && data.topRecommendations.length > 0) {
            try {
                // Use top 5 categories for suggestions
                const context = data.topRecommendations.map(c => `${c.name} (점수: ${c.finalScore})`).join(', ');
                suggestions = await suggestTopics(
                    data.topRecommendations.map(c => c.name),
                    `경제 트렌드 분석 (${context})`
                );
            } catch (e) {
                console.error('[EconomyTrends] AI 추천 실패:', e.message);
            }
        }

        res.json({ ...data, suggestions, mode: 'trend' });
    } catch (err) {
        console.error('[EconomyTrends] 오류:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// YouTube 실시간 데이터 기반 경제 트렌드 분석
// ═══════════════════════════════════════════════════════════
const realtimeCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1시간


// v3: GET /api/analysis/economy/realtime-v3 — Extract keywords from hit videos of registered channels
router.get('/economy/realtime-v3', async (req, res) => {
    try {
        const { period = '7' } = req.query; // '3' or '7' days
        const days = parseInt(period);

        // 캐시 확인 (1시간 TTL)
        const cacheKey = `economy-realtime-v3-${period}`;
        const cached = realtimeCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            console.log('[EconomyV3] 캐시 사용 (남은:', Math.round((CACHE_TTL - (Date.now() - cached.timestamp)) / 60000), '분)');
            return res.json(cached.data);
        }

        // 1. Get economy channels
        const channels = queryAll("SELECT id, name FROM channels WHERE group_tag = '경제'");

        const hitVideos = [];
        let finalTitles = [];
        let fallbackMessage = "";

        if (channels.length === 0) {
            console.log('[EconomyV3] 등록된 경제 채널 없음 -> 실시간 트렌드로 바로 진행');
            fallbackMessage = "등록된 경제 채널이 없어 실시간 트렌드 정보를 기반으로 분석을 시작합니다.";
        } else {
            console.log(`[EconomyV3] 분석 시작: 채널 ${channels.length}개, 기간 ${days}일`);
        }

        for (const channel of channels) {
            // A. Get 30-day average for this channel
            const stats = queryOne(`
                SELECT AVG(view_count) as avg_views 
                FROM videos 
                WHERE channel_id = ? 
                AND published_at >= date('now', '-30 days')
            `, [channel.id]);

            const avgViews = stats?.avg_views || 0;
            const threshold = Math.max(avgViews, 100);

            // B. Find "hit" videos (try strict 2.0x -> lenient 1.3x -> top results)
            let hits = queryAll(`
                SELECT v.id, v.video_id, v.title, v.view_count, v.comment_count, v.published_at, c.name as channel_name
                FROM videos v
                JOIN channels c ON v.channel_id = c.id
                WHERE v.channel_id = ?
                AND v.published_at >= date('now', ?)
                AND v.view_count >= ? * 2.0
                ORDER BY v.view_count DESC
            `, [channel.id, `-${days} days`, threshold]);

            if (hits.length === 0) {
                hits = queryAll(`
                    SELECT v.id, v.video_id, v.title, v.view_count, v.comment_count, v.published_at, c.name as channel_name
                    FROM videos v
                    JOIN channels c ON v.channel_id = c.id
                    WHERE v.channel_id = ?
                    AND v.published_at >= date('now', ?)
                    AND v.view_count >= ? * 1.3
                    ORDER BY v.view_count DESC
                `, [channel.id, `-${days} days`, threshold]);
            }

            if (hits.length === 0) {
                hits = queryAll(`
                    SELECT v.id, v.video_id, v.title, v.view_count, v.comment_count, v.published_at, c.name as channel_name
                    FROM videos v
                    JOIN channels c ON v.channel_id = c.id
                    WHERE v.channel_id = ?
                    AND v.published_at >= date('now', ?)
                    ORDER BY v.view_count DESC
                    LIMIT 3
                `, [channel.id, `-${days} days`]);
            }

            hitVideos.push(...hits);
        }

        console.log(`[EconomyV3] 분석 대상 영상 총 ${hitVideos.length}개 확보 (등록 채널 기반)`);

        // DB에 등록된 채널의 수집 영상만으로 분석 (YouTube API 실시간 검색 제거됨)
        fallbackMessage = hitVideos.length > 0 ? "등록 채널 데이터를 기반으로 분석합니다." : "등록된 경제 채널의 수집 영상이 없습니다. 채널을 등록하고 영상을 수집해주세요.";

        finalTitles = hitVideos.map(v => v.title);

        // 최후의 보루: 만약 검색 결과조차 없다면 (API 에러 등) 하드코딩된 현재의 핫 키워드라도 제공
        if (finalTitles.length === 0) {
            console.log('[EconomyV3] 모든 데이터 부재 -> 정적 키워드 리스트 발동');
            fallbackMessage = "실시간 검색 API 응답이 원활하지 않아 주요 경제 키워드 중심으로 분석을 진행합니니다.";
            finalTitles = ['미국 금리 인하 수혜주', '반도체 시장 전망', '부동산 하락장 대응법', '비트코인 ETF 도입 영향', '삼성전자 배당금', '엔비디아 실적 발표'];
            hitVideos = finalTitles.map(t => ({
                id: 'static_' + Math.random().toString(36).substr(2, 9),
                video_id: 'sample_id',
                title: t,
                view_count: 500000,
                published_at: new Date().toISOString(),
                channel_name: '시장 트렌드'
            }));
        }

        // 2. Extract keywords using AI (Limit to top 60 to prevent timeouts)
        const { extractEconomyKeywords } = await import('../services/gemini-service.js');
        const keywordGroupsArr = await extractEconomyKeywords(finalTitles.slice(0, 60));

        let aiErrorMessage = "";
        if (keywordGroupsArr && keywordGroupsArr.errorType) {
            aiErrorMessage = `AI 분석 오류: ${keywordGroupsArr.message || '알 수 없는 오류'}`;
        } else if (!keywordGroupsArr || keywordGroupsArr.length === 0) {
            if (finalTitles.length > 0) aiErrorMessage = "AI가 영상 제목에서 키워드를 추출하지 못했습니다. (형식 오류 가능성)";
        }

        const keywordGroups = Array.isArray(keywordGroupsArr) ? keywordGroupsArr : [];

        // 3. Enrich keyword groups with stats (핫 지수 알고리즘 적용)
        const enrichedKeywords = keywordGroups.map(group => {
            const matchingVideos = hitVideos.filter(v =>
                (group.titles || []).some(t => {
                    const cleanT = (t || '').trim();
                    const cleanV = (v.title || '').trim();
                    return cleanV.includes(cleanT) || cleanT.includes(cleanV);
                })
            );

            if (matchingVideos.length === 0) return null;

            const now = new Date();
            const totalViews = matchingVideos.reduce((sum, v) => sum + (v.view_count || 0), 0);
            const avgViews = Math.round(totalViews / matchingVideos.length);
            const maxViews = Math.max(...matchingVideos.map(v => v.view_count || 0));

            // [Hot 지수 산정 로직]
            // 1. 최신성 점수: 24시간 이내 영상당 5만점, 48시간 이내 2만점
            let recencyScore = 0;
            matchingVideos.forEach(v => {
                const pubDate = new Date(v.published_at);
                const diffHours = (now - pubDate) / (1000 * 60 * 60);
                if (diffHours <= 24) recencyScore += 50000;
                else if (diffHours <= 48) recencyScore += 20000;
            });

            // 2. 채널 밀도 점수: 다루는 채널이 많을수록 고득점 (채널당 3만점)
            const uniqueChannels = new Set(matchingVideos.map(v => v.channel_name)).size;
            const densityScore = uniqueChannels * 30000;

            // 3. 최종 핫 지수: (평균 조회수) + (최신성 점수) + (밀도 점수) + (떡상수 * 1만점)
            const hotScore = avgViews + recencyScore + densityScore + (matchingVideos.length * 10000);

            return {
                keyword: group.keyword,
                hit_count: matchingVideos.length,
                avg_views: avgViews,
                max_views: maxViews,
                hot_score: hotScore, // 랭킹 기준값
                unique_channels: uniqueChannels,
                videos: matchingVideos
            };
        }).filter(item => item !== null).sort((a, b) => b.hot_score - a.hot_score);

        const responseData = {
            keywords: enrichedKeywords,
            message: fallbackMessage,
            error: aiErrorMessage
        };
        realtimeCache.set(cacheKey, { timestamp: Date.now(), data: responseData });
        res.json(responseData);
    } catch (err) {
        console.error('[EconomyRealtimeV3] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// v3: POST /api/analysis/economy/suggest-topics-v3 — Suggest 10 differentiated topics
router.post('/economy/suggest-topics-v3', async (req, res) => {
    try {
        const { keyword, existingVideos } = req.body;
        if (!keyword) return res.status(400).json({ error: '키워드가 필요합니다.' });

        const { suggestEconomyTopics } = await import('../services/gemini-service.js');
        const result = await suggestEconomyTopics(keyword, existingVideos || []);

        res.json(result);
    } catch (err) {
        console.error('[SuggestTopicsV3] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// v3: POST /api/analysis/economy/thumbnail-titles-v3 — Suggest 3 catchy thumbnail titles
router.post('/economy/thumbnail-titles-v3', async (req, res) => {
    try {
        const { topicTitle, keyword, existingTitles } = req.body;
        const { getThumbnailTitlesV3 } = await import('../services/gemini-service.js');
        const result = await getThumbnailTitlesV3(topicTitle, keyword, existingTitles || []);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/gaps/economy-realtime', async (req, res) => {
    try {
        const cacheKey = 'economy_realtime';
        const cached = realtimeCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            console.log('[EconomyRealtime] 캐시 사용 (남은:', Math.round((CACHE_TTL - (Date.now() - cached.timestamp)) / 60000), '분)');
            return res.json(cached.data);
        }

        // 구형 경제 분석 — YouTube API 실시간 검색 제거됨
        res.json({ period: 7, categories: [], mainCategories: [], topRecommendations: [], dataSource: 'removed', cachedAt: new Date().toISOString() });
    } catch (err) {
        console.error('[EconomyRealtime] 오류:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/analysis/gaps — gap analysis
router.get('/gaps', async (req, res) => {
    try {
        const { groupX, groupY } = req.query;
        const groups = getCategoryGroups();

        if (groupX && groupY) {
            const matrix = buildGapMatrix(groupX, groupY);

            // Get AI suggestions for gaps
            let suggestions = [];
            if (matrix.gaps.length > 0) {
                try {
                    suggestions = await suggestTopics(
                        matrix.gaps.slice(0, 10).map(g => `${g.y} + ${g.x}`),
                        `${groupY} × ${groupX}`
                    );
                } catch (e) { }
            }

            res.json({ ...matrix, suggestions, groups });
        } else {
            res.json({ groups });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/analysis/gaps/multi — advanced tag-based gap analysis
router.post('/gaps/multi', async (req, res) => {
    try {
        const { selectedCategoryIds = [] } = req.body;
        const analysis = getMultiGapAnalysis(selectedCategoryIds);

        // Map selected IDs to names for AI context
        const allCats = queryAll('SELECT id, group_name as "group", name FROM categories');
        const selectedInfo = selectedCategoryIds.map(id => allCats.find(c => c.id === id)).filter(Boolean);

        // AI suggestions
        let suggestions = [];
        if (analysis.gaps.length > 0) {
            try {
                suggestions = await suggestMultiGapTopics(selectedInfo, analysis.gaps.slice(0, 10));
            } catch (e) { }
        }

        res.json({ ...analysis, suggestions });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/analysis/gaps/deep — high-intensity deep dive for a specific pair
router.post('/gaps/deep', async (req, res) => {
    try {
        const { catX, catY, groupX, groupY, isEconomy, isYadam, groupTag, meta } = req.body;
        const _groupTag = groupTag || (isYadam ? '야담' : '경제');
        const mgn = getMaterialGroupName(_groupTag);
        if (!catX || !catY || !groupX || !groupY) {
            return res.status(400).json({ error: '카테고리 정보가 부족합니다.' });
        }

        // DB에서 해당 카테고리 조합에 속하는 기존 영상 목록 가져오기
        let existingVideos = [];
        let existingCount = 0;
        try {
            // meta.eventId 기반 또는 catX/catY 이름 기반 영상 조회
            if (existingVideos.length === 0) {
                const catXRow = queryOne('SELECT id FROM categories WHERE name = ? AND group_name = ?', [catX, groupX]);

                if (catXRow) {
                    if (existingVideos.length === 0) {
                        const catYRow = queryOne('SELECT id FROM categories WHERE name = ? AND group_name = ?', [catY, groupY]);
                        if (catYRow) {
                            existingVideos = queryAll(`
                                SELECT DISTINCT v.id, v.title, v.view_count, v.comment_count, v.published_at, v.transcript_summary, v.description, c.name as channel_name
                                FROM videos v
                                JOIN channels c ON v.channel_id = c.id
                                JOIN video_categories vc1 ON v.id = vc1.video_id AND vc1.category_id = ?
                                JOIN video_categories vc2 ON v.id = vc2.video_id AND vc2.category_id = ?
                                ORDER BY v.view_count DESC
                                LIMIT 30
                            `, [catXRow.id, catYRow.id]);
                        }
                    }
                }
            }

            // 3. 마지막 수단: 키워드 검색 기반 Fallback
            if (existingVideos.length === 0) {
                const keywords = [
                    ...catX.split(/[\/\s,]+/).filter(k => k.length >= 2),
                    ...catY.replace(/\[|\]/g, ' ').split(/[\/\s,]+/).filter(k => k.length >= 2)
                ];
                if (keywords.length > 0) {
                    const likeClauses = keywords.map(() => '(v.title LIKE ? OR v.description LIKE ?)').join(' OR ');
                    const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
                    existingVideos = queryAll(`
                        SELECT DISTINCT v.id, v.title, v.view_count, v.comment_count, v.published_at, v.transcript_summary, v.description, c.name as channel_name
                        FROM videos v
                        JOIN channels c ON v.channel_id = c.id
                        WHERE (${likeClauses})
                        AND v.published_at >= date('now', '-365 days')
                        ORDER BY v.view_count DESC
                        LIMIT 30
                    `, params);
                }
            }
            existingCount = existingVideos.length;
        } catch (dbErr) {
            console.warn('[deepGaps] DB 조회 실패:', dbErr.message);
        }

        console.log(`[deepGaps] ${catY} × ${catX} — 기존 영상 ${existingCount}개, 떡상 DNA 분석 시작`);

        // DNA 추출
        let dnaSummary = null;
        let spikeCount = 0;
        try {
            if (existingVideos.length > 2) {
                const spikeInfo = pickSpikeVideos(existingVideos, { minRatio: 2.5, topPercent: 0.3 });
                if (spikeInfo.spikes.length > 0) {
                    spikeCount = spikeInfo.spikes.length;
                    // 고급 DNA 추출로 교체
                    dnaSummary = await extractAdvancedDNA(spikeInfo.spikes, isYadam ? '야담' : (isEconomy ? '경제' : '일반'));
                }
            }
        } catch (e) {
            console.warn('[deepGaps] DNA 분석 실패:', e.message);
        }

        // AI 추천 생성
        const suggestions = await deepSuggestTopics(catX, catY, groupX, groupY, existingVideos, isEconomy, dnaSummary, isYadam, meta);

        res.json({ suggestions, existingCount, dnaSummary, spikeCount, existingVideos });
    } catch (err) {
        console.error('[deepGaps] 오류:', err.message);
        // Use the status code from the error if available
        const status = err.status || 500;
        res.status(status).json({
            error: err.errorType || 'SERVER_ERROR',
            message: err.message
        });
    }
});

// GET /api/analysis/trends
router.get('/trends', (req, res) => {
    try {
        const { months = 12, group } = req.query;
        if (group) {
            res.json(getTrendsByCategory(group, parseInt(months)));
        } else {
            res.json(getTrends(parseInt(months)));
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/search — unified search
router.get('/search', (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json({ videos: [], channels: [], ideas: [] });

        const videos = queryAll(`
      SELECT v.id, v.title, v.video_id, 'video' as type, c.name as channel_name
      FROM videos v LEFT JOIN channels c ON v.channel_id = c.id
      WHERE v.title LIKE ? OR v.description LIKE ?
      LIMIT 10
    `, [`%${q}%`, `%${q}%`]);

        const channels = queryAll(`
      SELECT id, name, handle, 'channel' as type FROM channels
      WHERE name LIKE ? OR handle LIKE ? LIMIT 5
    `, [`%${q}%`, `%${q}%`]);

        const ideas = queryAll(`
      SELECT id, title, status, 'idea' as type FROM ideas
      WHERE title LIKE ? OR description LIKE ? LIMIT 5
    `, [`%${q}%`, `%${q}%`]);

        res.json({ videos, channels, ideas });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// v4: POST /api/analysis/benchmark/:videoId — AI Benchmark Report
// ═══════════════════════════════════════════════════════════
router.post('/benchmark/:videoId', async (req, res) => {
    try {
        const video = queryOne(`
      SELECT v.*, c.name as channel_name, c.subscriber_count
      FROM videos v LEFT JOIN channels c ON v.channel_id = c.id
      WHERE v.id = ?`, [req.params.videoId]);
        if (!video) return res.status(404).json({ error: '영상을 찾을 수 없습니다.' });

        // Check cache
        const cached = queryOne('SELECT * FROM benchmark_reports WHERE video_id = ? ORDER BY created_at DESC LIMIT 1', [req.params.videoId]);
        if (cached && !req.body.force) {
            return res.json({ report: JSON.parse(cached.report_json), source: 'cached' });
        }

        // Fetch comments if not already
        let commentsAnalysis = null;
        if (video.video_id && !video.video_id.startsWith('manual_')) {
            try {
                const comments = await fetchComments(video.video_id, 50);
                if (comments.length > 0) {
                    commentsAnalysis = await analyzeComments(comments, video.title);
                }
            } catch (e) { }
        }

        // Generate report
        const report = await generateBenchmarkReport({
            ...video,
            subscriber_count: video.subscriber_count || 0,
            comments_analysis: commentsAnalysis
        });

        if (!report) {
            return res.status(500).json({ error: 'AI 리포트 생성에 실패했습니다. Gemini API 키를 확인해주세요.' });
        }

        // Attach comments analysis
        report.comments_analysis = commentsAnalysis;

        // Cache
        runSQL('INSERT INTO benchmark_reports (video_id, report_json) VALUES (?, ?)',
            [req.params.videoId, JSON.stringify(report)]);

        res.json({ report, source: 'generated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ v4: POST /api/analysis/comments — analyze comments with AI ═══
router.post('/comments/:videoId', async (req, res) => {
    try {
        const video = queryOne('SELECT * FROM videos WHERE video_id = ?', [req.params.videoId]);
        const videoTitle = video?.title || req.body.title || '';

        // Fetch fresh comments
        const comments = await fetchComments(req.params.videoId, 150);
        if (comments.length === 0) return res.json({ comments: [], analysis: null, message: '댓글을 가져올 수 없습니다.' });

        // AI analysis
        let analysis = null;
        try {
            analysis = await analyzeComments(comments, videoTitle);
        } catch (e) { }

        res.json({ comments, analysis, total: comments.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/analysis/sub-category-progress — video_categories 기준 소재 분류 진행률
router.get('/sub-category-progress', (req, res) => {
    try {
        const group_tag = req.query.group_tag || '야담';
        const mgn = getMaterialGroupName(group_tag);
        const db = getDB();

        const totalRow = db.prepare(`
            SELECT COUNT(DISTINCT v.id) as cnt
            FROM videos v
            JOIN channels ch ON v.channel_id = ch.id
            WHERE ch.group_tag = ?
        `).get(group_tag);

        const classifiedRow = db.prepare(`
            SELECT COUNT(DISTINCT vc.video_id) as cnt
            FROM video_categories vc
            JOIN categories c ON vc.category_id = c.id
            JOIN videos v ON vc.video_id = v.id
            JOIN channels ch ON v.channel_id = ch.id
            WHERE c.group_name = ? AND ch.group_tag = ?
        `).get(mgn, group_tag);

        const total = totalRow?.cnt || 0;
        const classified = classifiedRow?.cnt || 0;
        res.json({ total, classified, unclassified: total - classified });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/analysis/spellcheck — 맞춤법/띄어쓰기 검사 (단일 청크, 프론트에서 분할 호출)
router.post('/spellcheck', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: '텍스트를 입력해주세요.' });

        const prompt = `다음 텍스트의 맞춤법, 띄어쓰기, 오타만 검사하세요.
원문을 그대로 반환하지 마세요.

오류가 있는 부분만 아래 JSON 형식으로 반환:
{
  "corrections": [
    {
      "original": "틀린 단어/구문",
      "corrected": "올바른 단어/구문",
      "type": "오타|띄어쓰기|맞춤법",
      "reason": "수정 이유"
    }
  ],
  "total_corrections": 숫자
}

오류가 없으면 {"corrections":[],"total_corrections":0} 반환
반드시 JSON만 반환. 마크다운 코드블록 사용 금지.

텍스트:
${text}`;

        const raw = await callGemini(prompt, { jsonMode: true, maxTokens: 8192 });
        if (!raw) return res.status(503).json({ error: 'API 키가 설정되지 않았습니다.' });

        let parsed;
        try {
            const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
            parsed = JSON.parse(cleaned);
        } catch {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return res.status(500).json({ error: 'AI 응답 파싱 실패' });
            try { parsed = JSON.parse(jsonMatch[0]); }
            catch { return res.status(500).json({ error: 'AI 응답 파싱 실패' }); }
        }

        const corrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
        res.json({ corrections, total_corrections: corrections.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/analysis/gaps/spike-videos — 카테고리 내 떡상 영상 추출 (video_spike_rankings 테이블 조회)
router.post('/gaps/spike-videos', async (req, res) => {
    try {
        const { catX, catY, isYadam, groupTag, meta } = req.body;
        if (!catX || !catY) {
            return res.status(400).json({ error: 'catX, catY는 필수입니다.' });
        }

        const genre = groupTag || (isYadam ? '야담' : '경제');

        const spikeRows = queryAll(`
            SELECT
                video_id as id,
                video_id_youtube as videoId,
                video_title as title,
                view_count as viewCount,
                like_count as likeCount,
                duration_seconds as durationSeconds,
                published_at as publishedAt,
                channel_name as channelName,
                subscriber_count as subscriberCount,
                channel_id as channelId,
                spike_ratio as spikeRatio,
                channel_avg_views as channelAvgViews,
                channel_avg_multiple as channelAvgMultiple,
                thumbnail_url,
                rank_in_category
            FROM video_spike_rankings
            WHERE genre = ? AND category_name = ? AND is_spike = 1
              AND duration_seconds > 300
              AND channel_id IN (
                SELECT id FROM channels ch2
                WHERE CASE
                  WHEN (SELECT sub_type_mode FROM category_settings
                        WHERE category_name = ch2.group_tag) = 'dual'
                  THEN ch2.sub_type = '만화'
                  ELSE 1
                END
              )
            ORDER BY rank_in_category ASC
            LIMIT 50
        `, [genre, catX]);

        const dnaVideoIds = new Set();
        const dnaScoreMap = new Map();
        const dnaIdMap = new Map();
        const dnaRows = queryAll(`SELECT id, video_ids, json_extract(dna_json, '$.scores.overall') as overall_score FROM video_dna`, []);
        dnaRows.forEach(r => {
            try {
                JSON.parse(r.video_ids || '[]').forEach(vid => {
                    dnaVideoIds.add(vid);
                    if (r.overall_score != null) dnaScoreMap.set(Number(vid), r.overall_score);
                    dnaIdMap.set(Number(vid), r.id);
                });
            } catch(e) {}
        });

        const spikeVideos = spikeRows.map(v => {
            const daysSinceUpload = Math.round((Date.now() - new Date(v.publishedAt).getTime()) / 86400000);
            return {
                ...v,
                hasDna: dnaVideoIds.has(v.id),
                dnaScore: dnaScoreMap.get(v.id) ?? null,
                dnaId: dnaIdMap.get(v.id) ?? null,
                daysSinceUpload,
                dailyAvgViews: Math.round(v.viewCount / Math.max(daysSinceUpload, 3))
            };
        });

        const totalInCategory = queryAll(`
            SELECT COUNT(*) as cnt FROM video_spike_rankings WHERE genre = ? AND category_name = ?
        `, [genre, catX])[0]?.cnt || 0;

        if (spikeVideos.length === 0) {
            return res.json({ spikeVideos: [], totalVideosInCategory: totalInCategory, totalSpikeVideos: 0, category: catX, message: '떡상 조건을 충족하는 영상이 없습니다.' });
        }

        return res.json({ spikeVideos, totalVideosInCategory: totalInCategory, totalSpikeVideos: spikeVideos.length, category: catX });

    } catch (err) {
        console.error('[spikeVideos] 오류:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/analysis/gaps/spike-videos — 구버전 (LIMIT 500 방식, 비활성)
// eslint-disable-next-line no-unused-vars
const _spike_videos_legacy = async (req, res) => {
    try {
        const { catX, catY, isYadam, groupTag: _legacyGroupTag, meta } = req.body;
        const _lgGroupTag = _legacyGroupTag || (isYadam ? '야담' : '경제');
        const _lgMgn = getMaterialGroupName(_lgGroupTag);
        if (!catX || !catY) {
            return res.status(400).json({ error: 'catX, catY는 필수입니다.' });
        }

        // ── 1. 해당 카테고리 영상 id 목록 수집 (최대 500개) ──────────────────
        let categoryVideoIds = [];
        let totalVideosInCategory = 0;
        try {
            let rows = [];

            if (isYadam) {
                // ── 야담 경로: meta ID 직접 활용 ─────────────────────────────
                const eventId  = meta?.eventId  ? parseInt(meta.eventId,  10) : 0;

                // Tier3: catY의 "[사건유형]" 형식 파싱 → 이름으로 2중 JOIN
                if (rows.length === 0 && catY.includes('[') && catY.includes(']')) {
                    const eraNameMatch   = catY.match(/\[(.*?)\]/);
                    const eventNamePart  = catY.split(']')[1]?.trim();
                    const eraRow   = eraNameMatch   ? queryOne('SELECT id FROM categories WHERE name = ?', [eraNameMatch[1]]) : null;
                    const eventRow = eventNamePart  ? queryOne('SELECT id FROM categories WHERE name = ? AND group_name = ?', [eventNamePart, _lgMgn]) : null;

                    if (eraRow && eventRow) {
                        rows = queryAll(`
                            SELECT DISTINCT v.id FROM videos v
                            JOIN video_categories vc1 ON v.id = vc1.video_id AND vc1.category_id = ?
                            JOIN video_categories vc2 ON v.id = vc2.video_id AND vc2.category_id = ?
                            LIMIT 500
                        `, [eraRow.id, eventRow.id]);
                    }
                }

                // Tier4.5: eventId 단독 조회 (카테고리 ID 직접 사용, group_tag 필터 포함)
                if (rows.length === 0 && eventId) {
                    rows = queryAll(`
                        SELECT DISTINCT v.id
                        FROM videos v
                        JOIN video_categories vc ON v.id = vc.video_id AND vc.category_id = ?
                        JOIN channels ch ON v.channel_id = ch.id
                        WHERE ch.group_tag = ?
                        LIMIT 500
                    `, [eventId, _lgGroupTag]);
                }
            } else {
                // ── 커스텀 탭 경로: catX, catY 이름으로 2중 JOIN ──────────────
                // group_name 무관하게 이름으로 검색 (커스텀 탭은 어떤 group이든 가능)
                const catXRow = queryOne('SELECT id FROM categories WHERE name = ?', [catX]);
                const catYRow = queryOne('SELECT id FROM categories WHERE name = ?', [catY]);

                if (catXRow && catYRow) {
                    rows = queryAll(`
                        SELECT DISTINCT v.id FROM videos v
                        JOIN video_categories vc1 ON v.id = vc1.video_id AND vc1.category_id = ?
                        JOIN video_categories vc2 ON v.id = vc2.video_id AND vc2.category_id = ?
                        LIMIT 500
                    `, [catXRow.id, catYRow.id]);
                } else if (catXRow) {
                    rows = queryAll(`
                        SELECT DISTINCT v.id FROM videos v
                        JOIN video_categories vc1 ON v.id = vc1.video_id AND vc1.category_id = ?
                        LIMIT 500
                    `, [catXRow.id]);
                } else if (catYRow) {
                    rows = queryAll(`
                        SELECT DISTINCT v.id FROM videos v
                        JOIN video_categories vc1 ON v.id = vc1.video_id AND vc1.category_id = ?
                        LIMIT 500
                    `, [catYRow.id]);
                }
            }

            // 공통 LIKE fallback (야담/커스텀 모두) — group_tag 필터 포함
            if (rows.length === 0) {
                const rawTokens = [
                    ...catX.replace(/\[|\]/g, ' ').split(/[\/\s,+]+/),
                    ...catY.replace(/\[|\]/g, ' ').split(/[\/\s,+]+/)
                ];
                const keywords = [...new Set(rawTokens.filter(k => k.length >= 2))];
                if (keywords.length > 0) {
                    const likeClauses = keywords.map(() => '(v.title LIKE ? OR v.description LIKE ?)').join(' OR ');
                    const likeParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
                    // isYadam 여부에 따라 group_tag 필터 적용 (경제 채널 혼입 방지)
                    const groupTag = isYadam ? '야담' : '경제';
                    rows = queryAll(`
                        SELECT DISTINCT v.id FROM videos v
                        JOIN channels ch ON v.channel_id = ch.id
                        WHERE ch.group_tag = ?
                          AND (${likeClauses})
                        LIMIT 500
                    `, [groupTag, ...likeParams]);
                }
            }

            categoryVideoIds = rows.map(r => r.id);
            totalVideosInCategory = categoryVideoIds.length;
        } catch (dbErr) {
            console.warn('[spikeVideos] 카테고리 조회 실패:', dbErr.message);
        }

        if (categoryVideoIds.length === 0) {
            return res.json({ spikeVideos: [], totalVideosInCategory: 0, totalSpikeVideos: 0, category: catX, message: '카테고리 내 영상이 없습니다.' });
        }

        // ── 2. 채널 평균 조회수 맵 구성 ──────────────────────────────────────
        const channelAvgRows = queryAll(`
            SELECT channel_id, AVG(view_count) as avg_views
            FROM videos
            WHERE view_count > 0
            GROUP BY channel_id
        `);
        const channelAvgMap = {};
        for (const r of channelAvgRows) channelAvgMap[r.channel_id] = r.avg_views;

        // ── 3. 후보 영상 전체 조회 (spike_ratio DESC) ────────────────────────
        const placeholders = categoryVideoIds.map(() => '?').join(',');
        const candidateRows = queryAll(`
            SELECT
                v.id,
                v.video_id,
                v.title,
                v.view_count,
                v.like_count,
                v.duration_seconds,
                v.published_at,
                v.comment_count,
                v.has_transcript,
                LENGTH(v.transcript_raw) as transcript_length,
                v.channel_id,
                c.name as channel_name,
                c.subscriber_count,
                c.channel_id as youtube_channel_id,
                CASE WHEN c.subscriber_count > 0
                    THEN ROUND(CAST(v.view_count AS REAL) / c.subscriber_count, 2)
                    ELSE 0
                END as spike_ratio
            FROM videos v
            JOIN channels c ON v.channel_id = c.id
            WHERE v.id IN (${placeholders})
              AND v.view_count > 0
              AND c.subscriber_count > 0
              AND c.group_tag = ?
            ORDER BY spike_ratio DESC
        `, [...categoryVideoIds, isYadam ? '야담' : '경제']);

        // ── 4. 단계적 떡상 필터 ──────────────────────────────────────────────
        // 각 후보에 channelAvgMultiple 미리 계산
        const withAvg = candidateRows.map(v => {
            const avg = channelAvgMap[v.channel_id] || 0;
            return { ...v, channelAvg: avg, channelAvgMultiple: avg > 0 ? v.view_count / avg : 0 };
        });

        // 단계1: spike_ratio >= 5.0 AND channelAvgMultiple >= 3.0
        let spikeRows = withAvg.filter(v => v.spike_ratio >= 5.0 && v.channelAvgMultiple >= 3.0);

        // 단계2: 50개 미만이면 spike_ratio >= 3.0 AND channelAvgMultiple >= 3.0
        if (spikeRows.length < 50) {
            spikeRows = withAvg.filter(v => v.spike_ratio >= 3.0 && v.channelAvgMultiple >= 3.0);
        }

        // 단계3: 그래도 없으면 spike_ratio >= 3.0 AND channelAvgMultiple >= 2.0
        if (spikeRows.length === 0) {
            spikeRows = withAvg.filter(v => v.spike_ratio >= 3.0 && v.channelAvgMultiple >= 2.0);
        }

        const totalSpikeVideos = spikeRows.length;
        const top10 = spikeRows.slice(0, 50);

        // ── 5. DNA 저장 여부 확인 ─────────────────────────────────────────────
        const dnaVideoIds = new Set();
        if (top10.length > 0) {
            const allDnaRows = queryAll(`SELECT video_ids FROM video_dna`, []);
            allDnaRows.forEach(row => {
                try { JSON.parse(row.video_ids || '[]').forEach(id => dnaVideoIds.add(id)); } catch(e) {}
            });
        }

        // ── 6. 응답 구성 ─────────────────────────────────────────────────────
        const spikeVideos = top10.map(v => ({
            id: v.id,
            videoId: v.video_id,
            title: v.title,
            viewCount: v.view_count,
            likeCount: v.like_count,
            durationSeconds: v.duration_seconds,
            publishedAt: v.published_at,
            channelName: v.channel_name,
            subscriberCount: v.subscriber_count,
            channelYoutubeId: v.youtube_channel_id,
            spikeRatio: v.spike_ratio,
            channelAvgViews: Math.round(v.channelAvg),
            channelAvgMultiple: Math.round(v.channelAvgMultiple * 10) / 10,
            commentCount: v.comment_count || 0,
            hasDna: dnaVideoIds.has(v.id)
        }));

        if (spikeVideos.length === 0) {
            return res.json({ spikeVideos: [], totalVideosInCategory, totalSpikeVideos: 0, category: catX, message: '떡상 조건을 충족하는 영상이 없습니다.' });
        }

        res.json({ spikeVideos, totalVideosInCategory, totalSpikeVideos, category: catX });
    } catch (err) {
        console.error('[spikeVideos] 오류:', err.message);
        res.status(500).json({ error: err.message });
    }
};

// POST /api/analysis/gaps/extract-dna — DNA 추출 및 저장
router.post('/gaps/extract-dna', async (req, res) => {
    res.setTimeout(240000);
    try {
        const { videoIds, category, groupTag: reqGroupTag } = req.body;

        // 1. 유효성 검사
        if (!Array.isArray(videoIds) || videoIds.length === 0) {
            return res.status(400).json({ error: '분석할 영상을 선택해주세요.' });
        }
        if (videoIds.length > 1) {
            return res.status(400).json({ error: '1개만 선택 가능합니다.' });
        }

        // 2. 캐시 확인 (동일 영상 조합)
        const sortedIds = [...videoIds].map(Number).sort((a, b) => a - b);
        const videoIdsKey = JSON.stringify(sortedIds);

        const cached = queryOne(
            `SELECT * FROM video_dna WHERE video_ids = ? ORDER BY created_at DESC LIMIT 1`,
            [videoIdsKey]
        );

        if (cached) {
            let sourceVideos = [];
            try {
                const titles = JSON.parse(cached.video_titles || '[]');
                const channels = JSON.parse(cached.channel_names || '[]');
                const rows = queryAll(
                    `SELECT v.id, v.video_id, v.view_count, c.subscriber_count,
                            LENGTH(v.transcript_raw) as transcript_length, c.channel_id as youtube_channel_id,
                            c.handle
                     FROM videos v JOIN channels c ON v.channel_id = c.id
                     WHERE v.id IN (${sortedIds.map(() => '?').join(',')})`,
                    sortedIds
                );
                sourceVideos = sortedIds.map((sid, i) => {
                    const r = rows.find(row => row.id === sid) || {};
                    return {
                        id: sid,
                        videoId: r.video_id || '',
                        title: titles[i] || '',
                        viewCount: r.view_count || 0,
                        channelName: channels[i] || '',
                        subscriberCount: r.subscriber_count || 0,
                        transcriptLength: r.transcript_length || 0,
                        channelYoutubeId: r.youtube_channel_id || '',
                        channelHandle: r.handle || ''
                    };
                });
            } catch (e) {
                console.warn('[extractDna] 캐시 소스영상 복원 실패:', e.message);
            }
            return res.json({
                dna: JSON.parse(cached.dna_json),
                dnaId: cached.id,
                sourceVideos,
                isNewExtraction: false,
                category: cached.category
            });
        }

        // 3. 영상 정보 + 자막 조회
        const rows = queryAll(
            `SELECT v.id, v.video_id, v.title, v.view_count, v.like_count, v.comment_count, v.duration_seconds, v.published_at,
                    v.transcript_raw, LENGTH(v.transcript_raw) as transcript_length,
                    c.name as channel_name, c.subscriber_count, c.channel_id as youtube_channel_id,
                    c.handle
             FROM videos v JOIN channels c ON v.channel_id = c.id
             WHERE v.id IN (${sortedIds.map(() => '?').join(',')})`,
            sortedIds
        );

        // 4. 자막 없는 영상 실시간 수집
        const newlyCollected = new Set();
        for (const row of rows) {
            if (!row.transcript_raw || row.transcript_raw.trim() === '') {
                try {
                    console.log(`[DNA] 자막 수집 시작: ${row.title} (${row.video_id})`);
                    const transcriptText = await fetchTranscript(row.video_id);
                    if (transcriptText && transcriptText.length > 0) {
                        runSQL('UPDATE videos SET transcript_raw = ?, has_transcript = 1 WHERE id = ?',
                            [transcriptText.substring(0, 100000), row.id]);
                        row.transcript_raw = transcriptText.substring(0, 100000);
                        newlyCollected.add(row.id);
                        console.log(`[DNA] 자막 수집 완료: ${row.title} (${transcriptText.length}자)`);
                    } else {
                        console.log(`[DNA] 자막 없음: ${row.title}`);
                    }
                } catch (err) {
                    console.error(`[DNA] 자막 수집 실패: ${row.title}`, err.message);
                }
            }
        }

        // 4-1. 자막 있는 영상만 필터링
        const videosWithTranscript = rows.filter(r => r.transcript_raw && r.transcript_raw.trim().length > 0);
        if (videosWithTranscript.length === 0) {
            return res.status(400).json({ error: '선택한 영상에서 자막을 가져올 수 없습니다. 다른 영상을 선택해주세요.' });
        }

        // 4-2. 자막 합산 100,000자 초과 시 1개만 사용
        const totalChars = videosWithTranscript.reduce((sum, r) => sum + (r.transcript_raw?.length || 0), 0);
        if (totalChars > 100000) {
            videosWithTranscript.splice(1);
            console.log(`[DNA] 자막 합산 ${totalChars}자 초과 — 1개 영상만 분석`);
        }

        // 4-3. 댓글 실시간 수집 (DNA 분석용, 상위 100개)
        for (const row of videosWithTranscript) {
            try {
                const comments = await fetchComments(row.video_id, 100);
                row.comments = comments || [];
                // DB에도 저장 (comment_id UNIQUE → 중복 자동 무시)
                for (const c of row.comments) {
                    try {
                        runSQL(
                            `INSERT OR IGNORE INTO comments (video_id, comment_id, author, text, like_count, published_at)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [row.id, c.comment_id, c.author, c.text, c.like_count, c.published_at]
                        );
                    } catch (e) { /* 중복 무시 */ }
                }
                // videos.comment_count는 YouTube API statistics.commentCount(정확한 전체 수)를 유지
                // 수집된 배열 길이로 덮어쓰지 않는다
                console.log(`[DNA] 댓글 수집 완료: ${row.title} (${row.comments.length}개)`);
            } catch (e) {
                row.comments = [];
                console.log(`[DNA] 댓글 수집 실패 (${row.video_id}):`, e.message);
            }
        }

        const videosArray = videosWithTranscript.map(r => ({
            title: r.title,
            view_count: r.view_count,
            transcript_raw: r.transcript_raw,
            description: '',
            comments: r.comments || []
        }));

        // category 결정: 클라이언트 catX → groupTag 하위 첫 번째 카테고리 → '야담' 순으로 폴백
        let effectiveCategory = (category && category.trim()) ? category.trim() : null;
        if (!effectiveCategory && reqGroupTag && reqGroupTag.trim()) {
            const catRow = queryOne(
                `SELECT c.name FROM categories c
                 JOIN category_settings cs ON c.group_name = cs.material_group_name
                 WHERE cs.category_name = ? LIMIT 1`,
                [reqGroupTag.trim()]
            );
            effectiveCategory = catRow?.name || null;
        }
        effectiveCategory = effectiveCategory || '야담';

        // 5. DNA 추출 (Gemini 1회 호출)
        const dna = await extractAdvancedDNA(videosArray, effectiveCategory);
        if (!dna) {
            return res.status(500).json({ error: 'DNA 추출에 실패했습니다. 잠시 후 다시 시도해주세요.' });
        }

        // 6. DB 저장
        const titles = rows.map(r => r.title);
        const channels = rows.map(r => r.channel_name);
        const singleInsertResult = runSQL(
            `INSERT INTO video_dna (video_ids, video_titles, channel_names, category, dna_json) VALUES (?, ?, ?, ?, ?)`,
            [videoIdsKey, JSON.stringify(titles), JSON.stringify(channels), effectiveCategory, JSON.stringify(dna)]
        );
        const singleDnaId = singleInsertResult?.lastId;

        // 7. 응답
        const skippedVideos = rows
            .filter(r => !videosWithTranscript.find(v => v.id === r.id))
            .map(r => ({ id: r.id, title: r.title }));

        const sourceVideos = videosWithTranscript.map(r => ({
            id: r.id,
            videoId: r.video_id,
            title: r.title,
            viewCount: r.view_count,
            channelName: r.channel_name,
            subscriberCount: r.subscriber_count,
            transcriptLength: r.transcript_raw?.length || 0,
            channelYoutubeId: r.youtube_channel_id || '',
            channelHandle: r.handle || '',
            transcriptCollected: newlyCollected.has(r.id),
            commentCount: r.comment_count || 0,
            likeCount: r.like_count || 0
        }));

        res.json({ dna, dnaId: singleDnaId, sourceVideos, skippedVideos, isNewExtraction: true, category: effectiveCategory });
    } catch (err) {
        console.error('[extractDna] 오류:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── DNA 배치 분석 시작 ───
router.post('/gaps/batch-extract-dna', async (req, res) => {
  try {
    const { videoIds, category, groupTag } = req.body;
    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return res.status(400).json({ error: 'videoIds 배열이 필요합니다' });
    }
    if (videoIds.length > 10) {
      return res.status(400).json({ error: '최대 10개까지 분석 가능합니다' });
    }

    const jobId = `dna-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      status: 'processing',
      progress: 0,
      total: videoIds.length,
      results: [],
      errors: [],
      category,
      groupTag,
      videoIds,
      createdAt: new Date().toISOString()
    };
    dnaJobs.set(jobId, job);

    // 즉시 응답 후 백그라운드 처리
    res.json({ jobId, status: 'processing', total: videoIds.length });

    // 백그라운드 순차 처리
    (async () => {
      for (let i = 0; i < videoIds.length; i++) {
        if (job.status === 'cancelled') break;

        const videoId = videoIds[i];
        try {
          // 캐시 확인
          const sortedKey = JSON.stringify([Number(videoId)]);
          const cached = queryOne(
            'SELECT * FROM video_dna WHERE video_ids = ? ORDER BY created_at DESC LIMIT 1',
            [sortedKey]
          );

          if (cached) {
            const row = queryOne(
              `SELECT v.id, v.video_id, v.title, v.view_count, v.thumbnail_url,
                      c.name as channel_name, c.subscriber_count
               FROM videos v JOIN channels c ON v.channel_id = c.id
               WHERE v.id = ?`,
              [videoId]
            );
            job.results.push({
              videoId,
              status: 'success',
              cached: true,
              dnaId: cached.id,
              dna: JSON.parse(cached.dna_json),
              video: row ? {
                id: row.id, videoId: row.video_id, title: row.title,
                viewCount: row.view_count, channelName: row.channel_name,
                subscriberCount: row.subscriber_count, thumbnailUrl: row.thumbnail_url
              } : null
            });
            job.progress = i + 1;
            continue;
          }

          // DB에서 영상 정보 조회
          const row = queryOne(
            `SELECT v.id, v.video_id, v.title, v.description, v.view_count, v.like_count,
                    v.comment_count, v.transcript_raw, v.thumbnail_url,
                    c.name as channel_name, c.subscriber_count, c.channel_id as youtube_channel_id
             FROM videos v JOIN channels c ON v.channel_id = c.id
             WHERE v.id = ?`,
            [videoId]
          );

          if (!row) {
            job.results.push({ videoId, status: 'error', error: '영상을 찾을 수 없습니다' });
            job.progress = i + 1;
            continue;
          }

          // 자막 수집 (없는 경우)
          let transcript = row.transcript_raw;
          if (!transcript) {
            try {
              transcript = await fetchTranscript(row.video_id);
              if (transcript) {
                runSQL('UPDATE videos SET transcript_raw = ? WHERE id = ?', [transcript, row.id]);
              }
            } catch (e) {
              // 자막 수집 실패 → 건너뜀
            }
          }

          if (!transcript) {
            job.results.push({
              videoId, status: 'skipped', error: '자막이 없습니다',
              video: {
                id: row.id, videoId: row.video_id, title: row.title,
                viewCount: row.view_count, channelName: row.channel_name,
                subscriberCount: row.subscriber_count, thumbnailUrl: row.thumbnail_url
              }
            });
            job.progress = i + 1;
            continue;
          }

          // 댓글 수집
          let comments = [];
          try {
            comments = await fetchComments(row.video_id, 100);
          } catch (e) {
            // 댓글 수집 실패해도 계속 진행
          }

          // Gemini DNA 분석
          const videosArray = [{
            title: row.title,
            view_count: row.view_count,
            transcript_raw: transcript,
            description: row.description || '',
            comments: comments
          }];

          const dna = await extractAdvancedDNA(videosArray, category);

          if (!dna) {
            job.results.push({
              videoId, status: 'error', error: 'DNA 분석 실패',
              video: {
                id: row.id, videoId: row.video_id, title: row.title,
                viewCount: row.view_count, channelName: row.channel_name,
                subscriberCount: row.subscriber_count, thumbnailUrl: row.thumbnail_url
              }
            });
            job.progress = i + 1;
            continue;
          }

          // DB 저장
          const insertResult = runSQL(
            'INSERT INTO video_dna (video_ids, video_titles, channel_names, category, dna_json) VALUES (?, ?, ?, ?, ?)',
            [sortedKey, JSON.stringify([row.title]), JSON.stringify([row.channel_name]), category, JSON.stringify(dna)]
          );
          const newDnaId = insertResult?.lastId;

          job.results.push({
            videoId,
            status: 'success',
            cached: false,
            dnaId: newDnaId,
            dna,
            video: {
              id: row.id, videoId: row.video_id, title: row.title,
              viewCount: row.view_count, channelName: row.channel_name,
              subscriberCount: row.subscriber_count, thumbnailUrl: row.thumbnail_url
            }
          });
          job.progress = i + 1;

          // 다음 영상 전 대기 (마지막 제외)
          if (i < videoIds.length - 1 && job.status !== 'cancelled') {
            await new Promise(r => setTimeout(r, 2000));
          }

        } catch (err) {
          console.error(`[batch-dna] 영상 ${videoId} 분석 실패:`, err.message);

          // 429 에러 시 60초 대기 후 재시도
          if (err.status === 429 || err.message?.includes('429') || err.message?.includes('quota')) {
            job.results.push({ videoId, status: 'retrying', error: 'API 한도 초과, 60초 대기 중...' });
            await new Promise(r => setTimeout(r, 60000));

            try {
              const row = queryOne(
                `SELECT v.id, v.video_id, v.title, v.description, v.view_count, v.thumbnail_url,
                        v.transcript_raw, c.name as channel_name, c.subscriber_count
                 FROM videos v JOIN channels c ON v.channel_id = c.id WHERE v.id = ?`,
                [videoId]
              );
              let comments2 = [];
              try { comments2 = await fetchComments(row.video_id, 100); } catch (e) {}

              const dna2 = await extractAdvancedDNA([{
                title: row.title, view_count: row.view_count,
                transcript_raw: row.transcript_raw, description: row.description || '',
                comments: comments2
              }], category);

              if (dna2) {
                const sortedKey2 = JSON.stringify([Number(videoId)]);
                runSQL(
                  'INSERT INTO video_dna (video_ids, video_titles, channel_names, category, dna_json) VALUES (?, ?, ?, ?, ?)',
                  [sortedKey2, JSON.stringify([row.title]), JSON.stringify([row.channel_name]), category, JSON.stringify(dna2)]
                );
                // 재시도 상태를 성공으로 교체
                const retryIdx = job.results.findIndex(r => r.videoId === videoId && r.status === 'retrying');
                if (retryIdx !== -1) job.results[retryIdx] = {
                  videoId, status: 'success', cached: false, dna: dna2,
                  video: { id: row.id, videoId: row.video_id, title: row.title,
                    viewCount: row.view_count, channelName: row.channel_name,
                    subscriberCount: row.subscriber_count, thumbnailUrl: row.thumbnail_url }
                };
              } else {
                const retryIdx = job.results.findIndex(r => r.videoId === videoId && r.status === 'retrying');
                if (retryIdx !== -1) job.results[retryIdx] = { videoId, status: 'error', error: '재시도 후에도 분석 실패' };
              }
            } catch (retryErr) {
              const retryIdx = job.results.findIndex(r => r.videoId === videoId && r.status === 'retrying');
              if (retryIdx !== -1) job.results[retryIdx] = { videoId, status: 'error', error: '재시도 실패: ' + retryErr.message };
            }
          } else {
            job.results.push({ videoId, status: 'error', error: err.message });
          }
          job.progress = i + 1;
        }
      }

      job.status = job.status === 'cancelled' ? 'cancelled' : 'complete';
      // 30분 후 메모리에서 제거
      setTimeout(() => dnaJobs.delete(jobId), 1800000);
    })();

  } catch (err) {
    console.error('[batch-dna] 시작 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DNA 배치 분석 상태 폴링 ───
router.get('/gaps/batch-dna-status/:jobId', (req, res) => {
  const job = dnaJobs.get(req.params.jobId);
  if (!job) return res.json({ status: 'idle' });
  res.json({
    status: job.status,
    progress: job.progress,
    total: job.total,
    results: job.results,
    errors: job.errors,
    category: job.category,
    groupTag: job.groupTag
  });
});

// ─── DNA 배치 분석 취소 ───
router.post('/gaps/batch-dna-cancel/:jobId', (req, res) => {
  const job = dnaJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.status = 'cancelled';
  res.json({ success: true });
});

// ─── DNA 이력 조회 ──────────────────────────────
router.get('/gaps/dna-history', (req, res) => {
    try {
        const { category, groupTag } = req.query;

        // 1) 이력 목록 + DNA 요약 추출 (json_extract)
        let sql = `
            SELECT
                id,
                video_ids,
                video_titles,
                channel_names,
                category,
                dna_json,
                LENGTH(dna_json) AS json_length,
                created_at,
                json_extract(dna_json, '$.hook_dna.hook_strength_score') AS hook_score,
                json_extract(dna_json, '$.hook_dna.hook_type') AS hook_type,
                json_extract(dna_json, '$.hook_dna.hook_sentences') AS hook_sentences_json,
                json_extract(dna_json, '$.title_dna.title_pattern') AS title_pattern,
                json_extract(dna_json, '$.title_dna.cta_words') AS cta_words_json,
                json_extract(dna_json, '$.structure_dna.climax_position') AS climax_position,
                json_extract(dna_json, '$.pace_dna.sentence_length_avg') AS sentence_length_avg,
                json_extract(dna_json, '$._meta.videoCount') AS video_count_meta
            FROM video_dna
        `;
        const params = [];
        if (category && category.trim() !== '') {
            sql += ' WHERE category = ?';
            params.push(category.trim());
        } else if (groupTag && groupTag.trim() !== '') {
            sql += ` WHERE category IN (SELECT name FROM categories WHERE group_name = (SELECT material_group_name FROM category_settings WHERE category_name = ?))`;
            params.push(groupTag.trim());
        }
        sql += ' ORDER BY created_at DESC';

        const rows = queryAll(sql, params);

        // 2) 각 이력의 영상 상세 정보를 videos+channels에서 조회
        const history = rows.map(row => {
            let videoIds = [];
            try { videoIds = JSON.parse(row.video_ids || '[]'); } catch(e) {}

            let videoDetails = [];
            if (videoIds.length > 0) {
                const placeholders = videoIds.map(() => '?').join(',');
                const videoSql = `
                    SELECT
                        v.id,
                        v.title,
                        v.video_id AS youtube_id,
                        v.view_count,
                        v.like_count,
                        v.comment_count,
                        v.published_at,
                        v.thumbnail_url,
                        v.duration_seconds,
                        c.name AS channel_name,
                        c.channel_id AS channel_youtube_id,
                        c.handle AS channel_handle,
                        c.subscriber_count,
                        ROUND(CAST(v.view_count AS REAL) / NULLIF(c.subscriber_count, 0), 2) AS spike_ratio
                    FROM videos v
                    LEFT JOIN channels c ON v.channel_id = c.id
                    WHERE v.id IN (${placeholders})
                `;
                videoDetails = queryAll(videoSql, videoIds);
            }

            let hookSentences = [];
            try { hookSentences = JSON.parse(row.hook_sentences_json || '[]'); } catch(e) {}

            let ctaWords = [];
            try { ctaWords = JSON.parse(row.cta_words_json || '[]'); } catch(e) {}

            // dna_full: dna_json 전체 파싱 (showDnaResultModal에 전달)
            let dnaFull = null;
            try { dnaFull = JSON.parse(row.dna_json || 'null'); } catch(e) {}

            // scores 추출
            const scores = dnaFull?.scores || null;

            return {
                id: row.id,
                video_ids: row.video_ids,
                video_titles: row.video_titles,
                channel_names: row.channel_names,
                category: row.category,
                json_length: row.json_length,
                created_at: row.created_at,
                dna_summary: {
                    hook_score: row.hook_score || 0,
                    hook_type: row.hook_type || '',
                    hook_first_sentence: hookSentences.length > 0 ? hookSentences[0] : '',
                    title_pattern: row.title_pattern || '',
                    cta_words: ctaWords.slice(0, 5),
                    climax_position: row.climax_position || 0,
                    sentence_length_avg: row.sentence_length_avg || 0,
                    scores
                },
                dna_full: dnaFull,
                video_details: videoDetails.map(v => ({
                    id: v.id,
                    title: v.title,
                    youtube_id: v.youtube_id,
                    view_count: v.view_count || 0,
                    like_count: v.like_count || 0,
                    comment_count: v.comment_count || 0,
                    published_at: v.published_at || '',
                    thumbnail_url: v.thumbnail_url || '',
                    duration_seconds: v.duration_seconds || 0,
                    channel_name: v.channel_name || '',
                    subscriber_count: v.subscriber_count || 0,
                    spike_ratio: v.spike_ratio || 0,
                    channel_youtube_id: v.channel_youtube_id || '',
                    channel_handle: v.channel_handle || ''
                }))
            };
        });

        res.json({ history });

    } catch (err) {
        console.error('dna-history error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── DNA 조회 — videos.id 기반 ──────────────────
router.get('/gaps/dna-by-video/:videoId', (req, res) => {
    try {
        const videoId = parseInt(req.params.videoId, 10);
        const row = queryOne(
            `SELECT * FROM video_dna
             WHERE EXISTS (
               SELECT 1 FROM json_each(video_ids) WHERE CAST(value AS INTEGER) = ?
             )
             ORDER BY id DESC LIMIT 1`,
            [videoId]
        );
        if (!row) {
            return res.status(404).json({ error: 'DNA 데이터를 찾을 수 없습니다' });
        }

        const dna = JSON.parse(row.dna_json || '{}');
        const videoIds = JSON.parse(row.video_ids || '[]');
        const videoTitles = JSON.parse(row.video_titles || '[]');
        const channelNames = JSON.parse(row.channel_names || '[]');

        // videos 테이블에서 실제 YouTube ID + 메타 정보 조회
        let sourceVideos = [];
        if (videoIds.length > 0) {
            const placeholders = videoIds.map(() => '?').join(',');
            const videoRows = queryAll(
                `SELECT v.id, v.video_id, v.title, v.view_count, v.duration_seconds, v.like_count,
                        v.comment_count, c.name as channel_name, c.subscriber_count,
                        c.channel_id, c.handle
                 FROM videos v LEFT JOIN channels c ON v.channel_id = c.id
                 WHERE v.id IN (${placeholders})`,
                videoIds
            );
            sourceVideos = videoIds.map((vid, i) => {
                const row = videoRows.find(r => r.id === vid);
                if (row) {
                    return {
                        id: row.id,
                        videoId: row.video_id,
                        title: row.title,
                        channelName: row.channel_name || channelNames[i] || '',
                        subscriberCount: row.subscriber_count || 0,
                        channelYoutubeId: row.channel_id || '',
                        channelHandle: row.handle || '',
                        viewCount: row.view_count || 0,
                        durationSeconds: row.duration_seconds || 0,
                        likeCount: row.like_count || 0,
                        commentCount: row.comment_count || 0
                    };
                }
                return {
                    id: vid,
                    videoId: '',
                    title: videoTitles[i] || '',
                    channelName: channelNames[i] || ''
                };
            });
        }

        res.json({
            dna,
            sourceVideos,
            skippedVideos: [],
            isNewExtraction: false,
            category: row.category
        });
    } catch (err) {
        console.error('DNA by video lookup error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── DNA 상세 조회 ──────────────────────────────
router.get('/gaps/dna-history/:id', (req, res) => {
    try {
        const { id } = req.params;
        const row = queryOne(`SELECT * FROM video_dna WHERE id = ?`, [id]);
        if (!row) {
            return res.status(404).json({ error: '해당 DNA를 찾을 수 없습니다' });
        }

        const dna = JSON.parse(row.dna_json || '{}');
        const videoIds = JSON.parse(row.video_ids || '[]');
        const videoTitles = JSON.parse(row.video_titles || '[]');
        const channelNames = JSON.parse(row.channel_names || '[]');

        // videos 테이블에서 YouTube ID + 메타 정보 조회
        let sourceVideos = [];
        if (videoIds.length > 0) {
            const placeholders = videoIds.map(() => '?').join(',');
            const videoRows = queryAll(
                `SELECT v.id, v.video_id, v.title, v.view_count, v.duration_seconds, v.like_count,
                        v.comment_count, v.published_at, c.name as channel_name, c.subscriber_count,
                        c.channel_id, c.handle
                 FROM videos v LEFT JOIN channels c ON v.channel_id = c.id
                 WHERE v.id IN (${placeholders})`,
                videoIds
            );
            sourceVideos = videoIds.map((vid, i) => {
                const vr = videoRows.find(r => r.id === vid);
                if (vr) {
                    return {
                        id: vr.id,
                        videoId: vr.video_id,
                        title: vr.title,
                        channelName: vr.channel_name || channelNames[i] || '',
                        subscriberCount: vr.subscriber_count || 0,
                        channelYoutubeId: vr.channel_id || '',
                        channelHandle: vr.handle || '',
                        viewCount: vr.view_count || 0,
                        durationSeconds: vr.duration_seconds || 0,
                        likeCount: vr.like_count || 0,
                        commentCount: vr.comment_count || 0,
                        publishedAt: vr.published_at || ''
                    };
                }
                return {
                    id: vid,
                    videoId: '',
                    title: videoTitles[i] || '',
                    channelName: channelNames[i] || ''
                };
            });
        }

        res.json({
            id: row.id,
            videoIds,
            videoTitles,
            channelNames,
            category: row.category,
            dna,
            sourceVideos,
            skippedVideos: [],
            isNewExtraction: false,
            createdAt: row.created_at
        });
    } catch (err) {
        console.error('DNA 상세 조회 오류:', err);
        res.status(500).json({ error: 'DNA 상세 조회 실패' });
    }
});

// POST /api/analysis/rebuild-rankings — rebuild video_spike_rankings table
router.post('/rebuild-rankings', (req, res) => {
    try {
        const { genre } = req.body;
        const count = rebuildSpikeRankings(genre || null);
        res.json({ success: true, count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/analysis/rankings?genre=야담 — 해당 genre의 전체 spike rankings 조회 (TOP50 순위 예측용)
router.get('/rankings', (req, res) => {
    try {
        const { genre } = req.query;
        if (!genre) return res.status(400).json({ error: 'genre required' });
        const db = getDB();
        const rows = db.prepare(`
            SELECT video_id_youtube as videoId,
                   spike_ratio as spikeRatio,
                   rank_in_category as rank,
                   category_name as categoryName
            FROM video_spike_rankings
            WHERE genre = ? AND is_spike = 1
            ORDER BY spike_ratio DESC
        `).all(genre);
        res.json({ rankings: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/analysis/refresh-top50 — TOP50 대상 영상 조회수 갱신 + 순위 재계산
router.post('/refresh-top50', async (req, res) => {
    try {
        const { genre, categoryName } = req.body;
        if (!genre) return res.status(400).json({ error: 'genre 필수' });

        const db = getDB();

        let rows;
        if (categoryName) {
            rows = db.prepare(`
                SELECT v.video_id FROM videos v
                JOIN video_spike_rankings r ON v.id = r.video_id
                WHERE r.genre = ? AND r.category_name = ?
                ORDER BY v.view_count DESC LIMIT 200
            `).all(genre, categoryName);
        } else {
            rows = db.prepare(`
                SELECT v.video_id FROM videos v
                JOIN video_spike_rankings r ON v.id = r.video_id
                WHERE r.genre = ?
                ORDER BY v.view_count DESC LIMIT 200
            `).all(genre);
        }

        const videoIds = rows.map(r => r.video_id);
        if (videoIds.length === 0) {
            return res.json({ updated: 0, rankingChanges: null });
        }

        console.log(`[TOP50 갱신] ${genre}${categoryName ? '/' + categoryName : ''} 시작, 예상 API 호출: ${Math.ceil(videoIds.length / 50)}회 (${Math.ceil(videoIds.length / 50)}유닛)`);

        const refreshResult = await refreshVideoStats(videoIds, db);
        const rankingChanges = analyzeRankingChanges(db, genre);

        res.json({
            updated: refreshResult.updated,
            rankingChanges
        });
    } catch (err) {
        console.error('[TOP50 갱신] 오류:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/analysis/refresh-video-stats — 영상 조회수 재검수 + 급등 시 TOP50 재계산
router.post('/refresh-video-stats', async (req, res) => {
    try {
        const { videoIds, genre } = req.body;
        if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
            return res.json({ updated: 0, rankingChanges: null });
        }
        const limitedIds = videoIds.slice(0, 500);
        const db = getDB();
        const result = await refreshVideoStats(limitedIds, db);
        let rankingChanges = null;
        if (genre) {
            rankingChanges = analyzeRankingChanges(db, genre);
            console.log(`[TOP50] ${genre} 순위 재계산 완료 (검색 재검수)`);
        }
        res.json({ updated: result.updated, rankingChanges });
    } catch (err) {
        console.error('[재검수 API] 오류:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
