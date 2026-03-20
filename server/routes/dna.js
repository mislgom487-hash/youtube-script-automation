import { Router } from 'express';
import { queryAll, queryOne, runSQLNoSave, saveDB, getMaterialGroupName } from '../db.js';
import { pickSpikeVideos } from '../services/spike-selector.js';
import { extractAdvancedDNA, extractGoldenKeywords, recommendTitles, generateDnaSkeleton, buildGroupDNA } from '../services/advanced-dna-extractor.js';
import { callGemini } from '../services/gemini-service.js';

const router = Router();

// 간단 인메모리 캐시
const dnaCache = new Map();

function setCache(key, value) {
    dnaCache.set(key, { value, at: Date.now() });
}
function getCache(key) {
    const entry = dnaCache.get(key);
    return entry ? entry.value : null;
}

// ─────────────────────────────────────────────
// GET /api/dna/spikes?channelId=&topN=20&days=90&category=야담
// 떡상 영상 수집
// ─────────────────────────────────────────────
router.get('/spikes', (req, res) => {
    try {
        const { channelId, topN = 20, days = 90, category } = req.query;

        let videos;
        if (channelId) {
            videos = queryAll(
                'SELECT * FROM videos WHERE channel_id = ? ORDER BY view_count DESC LIMIT 100',
                [channelId]
            );
        } else {
            // 전체 DB에서 기간 필터 + 조회수 상위
            const since = days == 0 ? '1970-01-01' :
                new Date(Date.now() - Number(days) * 86400000).toISOString().split('T')[0];
            videos = queryAll(
                `SELECT * FROM videos WHERE published_at >= ? ORDER BY view_count DESC LIMIT 200`,
                [since]
            );
        }

        const { spikes, baseline } = pickSpikeVideos(videos, { minRatio: 2, topPercent: 0.3 });
        const result = spikes.slice(0, Number(topN));

        res.json({ spikes: result, baseline, total: result.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/dna/analyze
// body: { videoIds[], category }
// DNA 5종 추출
// ─────────────────────────────────────────────
router.post('/analyze', async (req, res) => {
    try {
        const { videoIds, category = '야담' } = req.body;
        if (!videoIds || videoIds.length === 0)
            return res.status(400).json({ error: 'videoIds가 필요합니다.' });

        const placeholders = videoIds.map(() => '?').join(',');
        const videos = queryAll(`SELECT * FROM videos WHERE id IN (${placeholders})`, videoIds);

        if (videos.length === 0)
            return res.status(404).json({ error: '해당 영상을 찾을 수 없습니다.' });

        const dna = await extractAdvancedDNA(videos, category);
        if (!dna) return res.status(502).json({ error: 'DNA 추출 실패 (AI 응답 없음)' });

        setCache(`dna_${category}`, dna);
        res.json({ dna, cached: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/dna/theme-analyze
// body: { topic, category }
// 특정 주제(추천주제) 기반 관련 떡상 영상 검색 + DNA 추출
// ─────────────────────────────────────────────
router.post('/theme-analyze', async (req, res) => {
    try {
        const { topic, category = '야담' } = req.body;
        if (!topic) return res.status(400).json({ error: 'topic이 필요합니다.' });

        // 1. 단어 분리하여 검색 (유연한 매칭)
        const words = topic.split(' ').filter(w => w.length > 1);
        let videos = [];

        if (words.length > 0) {
            const conditions = words.map(() => 'title LIKE ?').join(' OR ');
            const params = words.map(w => `%${w}%`);
            videos = queryAll(`SELECT * FROM videos WHERE ${conditions} ORDER BY view_count DESC LIMIT 100`, params);
        }

        // 2. 검색 결과가 부족하면 카테고리 전체 상위 영상으로 대체
        if (videos.length < 5) {
            videos = queryAll(`SELECT * FROM videos ORDER BY view_count DESC LIMIT 100`);
        }

        // 3. 떡상 영상 선정
        const { spikes } = pickSpikeVideos(videos, { minRatio: 2, topPercent: 0.3 });

        // 4. DNA 추출
        const dna = await extractAdvancedDNA(spikes, category);
        if (!dna) return res.status(502).json({ error: '추제 기반 DNA 추출 실패' });

        res.json({ dna, spikeCount: spikes.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/dna/golden-keywords
// body: { dna }
// 황금 키워드 추출
// ─────────────────────────────────────────────
router.post('/golden-keywords', async (req, res) => {
    try {
        const { dna } = req.body;
        if (!dna) return res.status(400).json({ error: 'dna 데이터가 필요합니다.' });

        const result = await extractGoldenKeywords(dna);
        setCache('golden_keywords', result);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/dna/recommend-titles
// body: { dna, goldenKeywords, category, topic }
// 썸네일 후킹 제목 10개 추천
// ─────────────────────────────────────────────
router.post('/recommend-titles', async (req, res) => {
    try {
        const { dna, goldenKeywords, category = '야담', topic = '' } = req.body;
        if (!dna) return res.status(400).json({ error: 'dna 데이터가 필요합니다.' });

        const titles = await recommendTitles(dna, goldenKeywords, category, topic);
        setCache('recommended_titles', titles);
        res.json({ titles });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/dna/skeleton
// body: { dna, selectedTitle, category }
// 선택 제목 + DNA → 대본 뼈대
// ─────────────────────────────────────────────
router.post('/skeleton', async (req, res) => {
    try {
        const { dna, selectedTitle, category = '야담' } = req.body;
        if (!dna || !selectedTitle)
            return res.status(400).json({ error: 'dna와 selectedTitle이 필요합니다.' });

        const skeleton = await generateDnaSkeleton(dna, selectedTitle, category);
        if (!skeleton) return res.status(502).json({ error: '뼈대 생성 실패 (AI 응답 없음)' });

        const dna_evidence = {
            analyzed_video_count: dna._meta?.videoCount ?? '정보 없음',
            hook_type: dna.hook_dna?.hook_type || '정보 없음',
            hook_examples: (dna.hook_dna?.hook_sentences || []).slice(0, 3),
            struct_type: dna.structure_dna?.structure_type || '정보 없음',
            payoff_type: dna.structure_dna?.payoff_type || '정보 없음',
            emotion_peaks: (dna.emotion_dna?.peak_points || []).join(' / ') || '정보 없음',
            style_type: dna.title_dna?.title_pattern || '정보 없음',
        };

        setCache('last_skeleton', skeleton);
        res.json({ skeleton, dna_evidence });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/dna/cache/:key
// 마지막 성공 결과 반환
// ─────────────────────────────────────────────
router.get('/cache/:key', (req, res) => {
    const cached = getCache(req.params.key);
    if (!cached) return res.status(404).json({ error: '캐시된 결과가 없습니다.' });
    res.json({ cached, fromCache: true });
});

// ─────────────────────────────────────────────
// POST /api/dna/group
// body: { dnaResults[] }
// 여러 DNA → 그룹 DNA 합산
// ─────────────────────────────────────────────
router.post('/group', (req, res) => {
    try {
        const { dnaResults } = req.body;
        if (!dnaResults || dnaResults.length === 0)
            return res.status(400).json({ error: 'dnaResults가 필요합니다.' });

        const groupDna = buildGroupDNA(dnaResults);
        res.json({ groupDna });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/dna/local-dna
// body: { channel_id?, category? }
// Gemini 없이 DB 집계만으로 떡상 DNA 추출
// ─────────────────────────────────────────────
router.post('/local-dna', (req, res) => {
    try {
        const { channel_id, category } = req.body || {};

        // ── 1. 영상 조회 (channel_id 또는 전체) ────────────────
        let videos;
        if (channel_id) {
            videos = queryAll(
                `SELECT v.*, c.subscriber_count FROM videos v
                 JOIN channels c ON v.channel_id = c.id
                 WHERE v.channel_id = ?`,
                [channel_id]
            );
        } else {
            videos = queryAll(
                `SELECT v.*, c.subscriber_count FROM videos v
                 JOIN channels c ON v.channel_id = c.id`
            );
        }

        if (videos.length === 0) return res.status(404).json({ error: '영상 데이터가 없습니다.' });

        // ── 2. 떡상 판정: view_count / subscriber_count >= 50 ──
        const viralVideos = videos.filter(v => {
            const subs = v.subscriber_count || 0;
            return subs > 0 && (v.view_count || 0) / subs >= 50;
        });
        // 떡상이 너무 적으면 상위 10%로 대체
        const useVideos = viralVideos.length >= 5 ? viralVideos
            : [...videos].sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
                         .slice(0, Math.max(5, Math.floor(videos.length * 0.1)));

        // ── 3. 제목 패턴 분석 ────────────────────────────────
        const STOPWORDS = new Set([
            '이','가','을','를','의','에','에서','으로','로','와','과','는','은','도','만',
            '부터','까지','에게','한테','보다','처럼','같이','그리고','하지만','그러나',
            '또는','그래서','때문에','하는','했다','있는','없는','된다','이다','합니다',
            '있다','없다','하다','되다','같다','이런','그런','저런','어떤','무슨'
        ]);

        const titles = useVideos.map(v => v.title || '');
        const avgLength = titles.reduce((s, t) => s + t.length, 0) / (titles.length || 1);

        // 특수문자 빈도
        const specialChars = { '?': 0, '!': 0, '…': 0, '"': 0, "'": 0, '【': 0, '】': 0, '|': 0 };
        titles.forEach(t => {
            for (const ch of Object.keys(specialChars)) {
                specialChars[ch] += (t.split(ch).length - 1);
            }
        });

        // 자주 등장하는 단어
        const wordFreq = {};
        titles.forEach(t => {
            t.replace(/[^\w\s가-힣]/g, ' ').split(/\s+/).forEach(w => {
                if (w.length >= 2 && w.length <= 6 && !STOPWORDS.has(w)) {
                    wordFreq[w] = (wordFreq[w] || 0) + 1;
                }
            });
        });
        const topKeywords = Object.entries(wordFreq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([w]) => w);

        // 제목 구조 패턴
        const n = titles.length || 1;
        const structure_pattern = {
            question:    Math.round(titles.filter(t => t.trimEnd().endsWith('?')).length / n * 100),
            exclamation: Math.round(titles.filter(t => t.trimEnd().endsWith('!')).length / n * 100),
            ellipsis:    Math.round(titles.filter(t => t.includes('…') || t.includes('...')).length / n * 100),
            quote:       Math.round(titles.filter(t => t.includes('\u201c') || t.includes('\u201d') || t.includes('\u2018') || t.includes('\u2019') || t.includes('"')).length / n * 100),
        };
        structure_pattern.narrative = Math.max(0, 100 - structure_pattern.question - structure_pattern.exclamation - structure_pattern.ellipsis - structure_pattern.quote);

        // ── 4. 게시 타이밍 분석 ──────────────────────────────
        const DAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
        const dayDist = { '월': 0, '화': 0, '수': 0, '목': 0, '금': 0, '토': 0, '일': 0 };
        const hourDist = {};
        for (let h = 0; h < 24; h++) hourDist[String(h)] = 0;

        useVideos.forEach(v => {
            if (!v.published_at) return;
            const d = new Date(v.published_at);
            const dayKo = DAYS_KO[d.getDay()];
            dayDist[dayKo] = (dayDist[dayKo] || 0) + 1;
            hourDist[String(d.getHours())]++;
        });

        const bestDays = Object.entries(dayDist).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
        const bestHours = Object.entries(hourDist).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => Number(h));

        // ── 5. 태그 분석 ─────────────────────────────────────
        const tagFreq = {};
        useVideos.forEach(v => {
            if (!v.tags) return;
            v.tags.split(',').map(t => t.trim()).filter(Boolean).forEach(tag => {
                tagFreq[tag] = (tagFreq[tag] || 0) + 1;
            });
        });
        const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t);

        // ── 6. 장르 분포 (video_categories 기반) ─────────────
        const videoDbIds = useVideos.map(v => v.id);
        const genreDist = {};
        if (videoDbIds.length > 0) {
            const placeholders = videoDbIds.map(() => '?').join(',');
            const catRows = queryAll(
                `SELECT c.name, COUNT(*) as cnt FROM video_categories vc
                 JOIN categories c ON vc.category_id = c.id
                 WHERE vc.video_id IN (${placeholders}) AND c.group_name IN ('사건유형','소재유형','시대유형')
                 GROUP BY c.name ORDER BY cnt DESC LIMIT 10`,
                videoDbIds
            );
            const total = catRows.reduce((s, r) => s + r.cnt, 0) || 1;
            catRows.forEach(r => { genreDist[r.name] = Math.round(r.cnt / total * 100); });
        }

        // ── 7. 결과 조립 ─────────────────────────────────────
        const dna = {
            viral_count: useVideos.length,
            total_count: videos.length,
            viral_rate: Math.round(useVideos.length / videos.length * 100),
            title_analysis: {
                avg_length: Math.round(avgLength),
                top_keywords: topKeywords,
                structure_pattern,
                special_chars: specialChars
            },
            timing_analysis: {
                best_days: bestDays,
                best_hours: bestHours,
                day_distribution: dayDist,
                hour_distribution: hourDist
            },
            tag_analysis: { top_tags: topTags },
            genre_distribution: genreDist,
            _meta: {
                source: 'local',
                videoCount: useVideos.length,
                usedFallback: viralVideos.length < 5
            }
        };

        res.json({ dna });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/dna/channels — 채널 목록 (셀렉트용)
// ─────────────────────────────────────────────
router.get('/channels', (req, res) => {
    try {
        const channels = queryAll('SELECT id, name FROM channels ORDER BY name');
        res.json({ channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/dna/unclassified-count
// 사건유형 분류 영상 중 세부 카테고리 미분류 수 반환
// ─────────────────────────────────────────────
router.get('/unclassified-count', (req, res) => {
    try {
        const group_tag = req.query.group_tag || '야담';
        const mgn = getMaterialGroupName(group_tag);
        const row = queryOne(`
            SELECT COUNT(DISTINCT v.video_id) as cnt
            FROM videos v
            JOIN channels ch ON v.channel_id = ch.id AND ch.group_tag = ?
            JOIN video_categories vc ON v.id = vc.video_id
            JOIN categories c ON vc.category_id = c.id
            WHERE c.group_name = ?
            AND v.video_id NOT IN (
                SELECT DISTINCT video_id FROM video_sub_categories
            )
        `, [group_tag, mgn]);
        res.json({ count: row?.cnt || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
