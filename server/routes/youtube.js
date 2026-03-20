import { Router } from 'express';
import { queryOne, queryAll, runSQL, getDB } from '../db.js';
import { fetchChannelVideos, searchVideos, searchChannels, fetchComments, fetchChannelsByIds, refreshVideoStats } from '../services/youtube-fetcher.js';
import { extractKeywords, categorizeVideo, summarizeTranscript, fallbackKeywords } from '../services/gemini-service.js';
import { categorizeVideoByKeywords } from '../services/gap-analyzer.js';
import { analyzeRankingChanges } from '../services/spike-rankings-builder.js';

const router = Router();
const activeJobs = new Map();

// ═══════════════════════════════════════════════════════════
// POST /api/youtube/search-channels — channel direct search
// ═══════════════════════════════════════════════════════════
router.post('/search-channels', async (req, res) => {
    try {
        const { keyword, maxResults, pageToken, publishedAfter } = req.body;
        if (!keyword) return res.status(400).json({ error: '검색 키워드를 입력해주세요.' });
        const result = await searchChannels({ keyword, maxResults: maxResults || 50, pageToken: pageToken || null, publishedAfter: publishedAfter || null });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// v4: POST /api/youtube/search — trending/viral video search
// ═══════════════════════════════════════════════════════════
router.post('/search', async (req, res) => {
    try {
        const { keyword, period, videoType, maxResults, minSubscribers, minViews, order, pageToken } = req.body;
        if (!keyword) return res.status(400).json({ error: '검색 키워드를 입력해주세요.' });
        const { results, nextPageToken } = await searchVideos({ keyword, period, videoType, maxResults, minSubscribers, minViews, order, pageToken });
        res.json({ results, nextPageToken, total: results.length, keyword });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// v4: GET /api/youtube/comments/:videoId — fetch comments
// ═══════════════════════════════════════════════════════════
router.get('/comments/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const { max = 150 } = req.query;
        const comments = await fetchComments(videoId, parseInt(max));

        // Save to DB if we have a matching video
        const video = queryOne('SELECT id FROM videos WHERE video_id = ?', [videoId]);
        if (video) {
            runSQL('DELETE FROM comments WHERE video_id = ?', [video.id]);
            for (const c of comments) {
                runSQL('INSERT OR IGNORE INTO comments (video_id, comment_id, author, text, like_count, published_at) VALUES (?, ?, ?, ?, ?, ?)',
                    [video.id, c.comment_id, c.author, c.text, c.like_count, c.published_at]);
            }
            runSQL('UPDATE videos SET comment_count = ? WHERE id = ?', [comments.length, video.id]);
        }

        res.json({ comments, total: comments.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/youtube/fetch/:channelId — start fetching videos for a channel
router.post('/fetch/:channelId', async (req, res) => {
    const channelDbId = req.params.channelId;
    const { maxResults = 5000, afterDate: requestedAfterDate } = req.body;

    try {
        const channel = queryOne('SELECT * FROM channels WHERE id = ?', [channelDbId]);
        if (!channel) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' });

        if (activeJobs.has(channelDbId)) {
            return res.status(409).json({ error: '이미 수집 중입니다.', status: 'processing' });
        }

        // 즉시 job 등록 후 백그라운드에서 독립 실행
        const job = { status: 'queued', progress: 0, total: 0, cancel: false, errors: [] };
        activeJobs.set(channelDbId, job);

        res.json({ message: '수집을 시작합니다.', jobId: channelDbId, status: 'started' });

        processChannel(channel, channelDbId, maxResults, job, requestedAfterDate).catch(e => {
            console.error('[processChannel] 오류:', channelDbId, e.message);
            job.status = 'error';
            job.error = e.message;
            setTimeout(() => activeJobs.delete(channelDbId), 30000);
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/youtube/status/:channelId — get fetch job status
router.get('/status/:channelId', (req, res) => {
    const job = activeJobs.get(req.params.channelId);
    if (!job) return res.json({ status: 'idle' });
    res.json({
        status: job.status,
        progress: job.progress,
        total: job.total,
        completedCount: job.completedCount || job.progress,
        errors: job.errors,
        refreshResult: job.refreshResult || null
    });
});

// GET /api/youtube/status-all — 모든 활성 수집 작업 상태 일괄 반환 (개별 150회 호출 방지)
router.get('/status-all', (req, res) => {
    const result = {};
    for (const [id, job] of activeJobs.entries()) {
        result[id] = {
            status: job.status,
            progress: job.progress,
            total: job.total,
            completedCount: job.completedCount || job.progress
        };
    }
    res.json(result);
});

// POST /api/youtube/cancel/:channelId — cancel ongoing fetch
router.post('/cancel/:channelId', (req, res) => {
    const job = activeJobs.get(req.params.channelId);
    if (job) job.cancel = true;
    res.json({ success: true });
});

async function processChannel(channel, channelDbId, maxResults, job, requestedAfterDate = null) {
    try {
        // Fetch video list
        job.status = 'fetching_list';
        const videos = await fetchChannelVideos(channel.channel_id, maxResults, requestedAfterDate ?? channel.last_fetched);
        job.total = videos.length;
        let shortsSkipped = 0;
        let savedCount = 0;

        // Insert videos and analyze
        const db = getDB();
        const allDBCats = queryAll('SELECT * FROM categories');

        for (let i = 0; i < videos.length; i++) {
            if (job.cancel) {
                job.status = 'cancelled';
                job.completedCount = job.progress;
                setTimeout(() => activeJobs.delete(channelDbId), 30000);
                return;
            }

            const v = videos[i];
            try {
            job.progress = i + 1;
            job.status = 'processing';

            // 5분 이하 영상 스킵
            if ((v.duration_seconds || 0) <= 300) {
                shortsSkipped++;
                continue;
            }

            // Check if video already exists
            const existing = queryOne('SELECT id FROM videos WHERE video_id = ?', [v.video_id]);
            if (existing) { continue; }
            // Check if video is excluded (manually deleted)
            const excluded = queryOne('SELECT id FROM excluded_videos WHERE video_id = ?', [v.video_id]);
            if (excluded) { continue; }

            // ── 트랜잭션으로 INSERT/UPDATE 묶기 ──
            const insertOneVideo = db.transaction(() => {
                // Insert video
                const { lastId: videoDbId } = runSQL(
                    `INSERT INTO videos (channel_id, video_id, title, description, tags, published_at, view_count, like_count, comment_count, duration_seconds, thumbnail_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [channelDbId, v.video_id, v.title, v.description, v.tags, v.published_at, v.view_count, v.like_count, v.comment_count || 0, v.duration_seconds, v.thumbnail_url]
                );
                savedCount++;

                // ── 키워드 추출: fallbackKeywords 사용 (Gemini 호출 없음) ──
                const keywords = fallbackKeywords(v.title, v.description || '');
                const summary = '';

                // Save keywords
                for (const kw of keywords) {
                    runSQL('INSERT OR IGNORE INTO keywords (word) VALUES (?)', [kw]);
                    const kwRow = queryOne('SELECT id FROM keywords WHERE word = ?', [kw]);
                    if (kwRow) {
                        runSQL('INSERT OR IGNORE INTO video_keywords (video_id, keyword_id, frequency) VALUES (?, ?, 1)', [videoDbId, kwRow.id]);
                        runSQL('UPDATE keywords SET total_count = total_count + 1 WHERE id = ?', [kwRow.id]);
                    }
                }

                // Save keywords text
                runSQL('UPDATE videos SET transcript_summary = ?, transcript_keywords = ?, is_analyzed = 1 WHERE id = ?',
                    [summary, keywords.join(','), videoDbId]);

                // 키워드 기반 카테고리 분류
                if (allDBCats.length > 0) {
                    const keywordCats = categorizeVideoByKeywords({ title: v.title, description: v.description || '' }, allDBCats, channel.group_tag);
                    for (const catId of keywordCats) {
                        runSQL('INSERT OR IGNORE INTO video_categories (video_id, category_id, source) VALUES (?, ?, ?)', [videoDbId, catId, 'keyword_fallback']);
                    }
                }
            });

            try {
                insertOneVideo();
            } catch (e) {
                job.errors.push(`${v.title}: ${e.message}`);
            }

            // Cancel check: after video insert
            if (job.cancel) {
                job.status = 'cancelled';
                job.completedCount = job.progress;
                console.log('[수집 중단] ' + channelDbId + ' - ' + job.progress + '개 수집 완료 후 중단');
                setTimeout(() => activeJobs.delete(channelDbId), 30000);
                return;
            }

            } catch (err) {
                console.error('[ERROR] 영상 처리 실패:', v.video_id, err.message);
            }

            // 수집 중지 여부 확인 (10개마다 1회)
            if (i % 10 === 9) {
                const activeCheck = queryOne('SELECT is_active, name FROM channels WHERE id = ?', [channelDbId]);
                if (activeCheck && activeCheck.is_active === 0) {
                    job.status = 'cancelled';
                    job.completedCount = job.progress;
                    console.log(`[수집 중단] ${channelDbId} - ${job.progress}개 수집 완료 후 중단`);
                    setTimeout(() => activeJobs.delete(channelDbId), 30000);
                    break;
                }
            }
        }

        // Update channel last_fetched
        runSQL('UPDATE channels SET last_fetched = ? WHERE id = ?', [new Date().toISOString(), channelDbId]);
        console.log(`[${channel.name}] 수집 완료: ${savedCount}건 저장, ${shortsSkipped}건 숏츠 제외`);

        // === 기존 영상 재검수 + TOP50 재계산 ===
        try {
            const db = getDB();
            const existingVideos = db.prepare(
                `SELECT video_id FROM videos WHERE channel_id = ?`
            ).all(channelDbId);

            const existingIds = existingVideos.map(v => v.video_id);
            if (existingIds.length > 0) {
                console.log(`[재검수] ${channel.name} 기존 영상 ${existingIds.length}개 조회수 갱신 시작`);
                const refreshResult = await refreshVideoStats(existingIds, db);
                console.log(`[재검수] 완료: ${refreshResult.updated}건 갱신`);

                const genreRow = queryOne('SELECT group_tag FROM channels WHERE id = ?', [channelDbId]);
                let rankingChanges = null;
                if (genreRow?.group_tag) {
                    rankingChanges = analyzeRankingChanges(db, genreRow.group_tag);
                    console.log(`[TOP50] ${genreRow.group_tag} 순위 재계산 완료`);
                }
                job.refreshResult = { updated: refreshResult.updated, rankingChanges };
            }
        } catch (refreshErr) {
            console.error('[재검수] 오류 (수집은 정상 완료):', refreshErr.message);
        }
        // === 재검수 끝 ===

        job.status = 'complete';

        // Cleanup job after 30 seconds
        setTimeout(() => activeJobs.delete(channelDbId), 30000);
    } catch (err) {
        job.status = 'error';
        job.error = err.message;
        setTimeout(() => activeJobs.delete(channelDbId), 30000);
    }
}

// ═══════════════════════════════════════════════════════════
// GET /api/youtube/channel-details — fetch real channel info by IDs
// ═══════════════════════════════════════════════════════════
router.get('/channel-details', async (req, res) => {
    try {
        const { ids } = req.query;
        if (!ids) return res.json({ channels: [] });
        const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
        if (idList.length === 0) return res.json({ channels: [] });

        const allChannels = [];
        for (let i = 0; i < idList.length; i += 50) {
            const batch = idList.slice(i, i + 50);
            const items = await fetchChannelsByIds(batch);
            allChannels.push(...items);
        }
        res.json({ channels: allChannels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
