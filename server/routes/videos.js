import { Router } from 'express';
import { queryAll, queryOne, runSQL, getMaterialGroupName, getDB } from '../db.js';
import { fetchTranscript } from '../services/transcript-fetcher.js';
import { categorizeVideoByKeywords } from '../services/gap-analyzer.js';
import { rebuildSpikeRankings } from '../services/spike-rankings-builder.js';
import { classifyUnclassifiedVideos } from '../services/gemini-service.js';

const router = Router();

// GET /api/videos — list videos with pagination, filtering, search
router.get('/', (req, res) => {
    try {
        const { page = 1, limit = 20, channel_id, search, category_id, video_type, sort = 'fetched_at', order = 'desc' } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        let where = [];
        let params = [];
        if (channel_id) { where.push('v.channel_id = ?'); params.push(channel_id); }
        if (search) { where.push("(v.title LIKE ? OR v.description LIKE ? OR v.transcript_summary LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
        if (category_id) { where.push('EXISTS (SELECT 1 FROM video_categories vc WHERE vc.video_id = v.id AND vc.category_id = ?)'); params.push(category_id); }

        if (video_type === 'shorts') {
            where.push("(v.duration_seconds > 0 AND v.duration_seconds <= 60) OR v.title LIKE '%#shorts%' OR v.title LIKE '%#쇼츠%'");
        } else if (video_type === 'longform') {
            where.push("v.duration_seconds > 60 AND v.title NOT LIKE '%#shorts%' AND v.title NOT LIKE '%#쇼츠%'");
        }

        const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const validSorts = ['fetched_at', 'published_at', 'view_count', 'like_count', 'title'];
        const sortCol = validSorts.includes(sort) ? sort : 'fetched_at';
        const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
        const countResult = queryOne(`SELECT COUNT(*) as total FROM videos v ${whereClause}`, params);
        const total = countResult?.total || 0;
        const videos = queryAll(`
      SELECT v.*, c.name as channel_name, c.thumbnail_url as channel_thumbnail, c.subscriber_count as channel_subscribers
      FROM videos v LEFT JOIN channels c ON v.channel_id = c.id
      ${whereClause} ORDER BY v.${sortCol} ${sortOrder} LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);
        res.json({ videos, total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/videos/export/json
router.get('/export/json', (req, res) => {
    try {
        const videos = queryAll('SELECT v.*, c.name as channel_name FROM videos v LEFT JOIN channels c ON v.channel_id = c.id');
        res.json(videos);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ v4: GET /api/videos/export/csv — CSV with UTF-8 BOM ═══
router.get('/export/csv', (req, res) => {
    try {
        const { search, channel_id } = req.query;
        let where = []; let params = [];
        if (channel_id) { where.push('v.channel_id = ?'); params.push(channel_id); }
        if (search) { where.push("v.title LIKE ?"); params.push(`%${search}%`); }
        const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const videos = queryAll(`SELECT v.*, c.name as channel_name, c.subscriber_count as ch_subs
      FROM videos v LEFT JOIN channels c ON v.channel_id = c.id ${whereClause} ORDER BY v.view_count DESC`, params);
        const headers = ['제목', '채널', 'URL', '조회수', '좋아요', '댓글수', '구독자', '떡상지표', '업로드일', '키워드', '자막요약'];
        const rows = videos.map(v => {
            const viral = v.ch_subs > 0 ? Math.round((v.view_count / v.ch_subs) * 100) : 0;
            return [
                `"${(v.title || '').replace(/"/g, '""')}"`, `"${(v.channel_name || '').replace(/"/g, '""')}"`,
                v.video_id ? `https://youtube.com/watch?v=${v.video_id}` : '',
                v.view_count || 0, v.like_count || 0, v.comment_count || 0, v.ch_subs || 0,
                `${viral}%`, v.published_at || '',
                `"${(v.transcript_keywords || '').replace(/"/g, '""')}"`,
                `"${(v.transcript_summary || '').replace(/"/g, '""')}"`
            ];
        });
        const BOM = '\uFEFF';
        const csv = BOM + headers.join(',') + '\n' + rows.map(r => r.join(',')).join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=videos_${new Date().toISOString().slice(0, 10)}.csv`);
        res.send(csv);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/videos/unclassified — 소재 미분류 영상 조회
router.get('/unclassified', (req, res) => {
    try {
        const { group_tag } = req.query;
        const mgn = getMaterialGroupName(group_tag || '야담');
        let sql = `
            SELECT v.id, v.video_id, v.title, ch.name as channel_name, ch.id as channel_id,
                   v.published_at, v.view_count, v.thumbnail_url
            FROM videos v
            JOIN channels ch ON v.channel_id = ch.id
            WHERE NOT EXISTS (
                SELECT 1 FROM video_categories vc
                JOIN categories c ON vc.category_id = c.id
                WHERE vc.video_id = v.id AND c.group_name = ?
            )`;
        const params = [mgn];
        if (group_tag) { sql += ' AND ch.group_tag = ?'; params.push(group_tag); }
        sql += ' ORDER BY v.published_at DESC';
        const rows = queryAll(sql, params);
        res.json({ videos: rows, total: rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/videos/:id — video detail
router.get('/:id', (req, res) => {
    try {
        const video = queryOne(`SELECT v.*, c.name as channel_name, c.subscriber_count as channel_subscribers
      FROM videos v LEFT JOIN channels c ON v.channel_id = c.id WHERE v.id = ?`, [req.params.id]);
        if (!video) return res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
        const categories = queryAll(`SELECT c.* FROM categories c JOIN video_categories vc ON c.id = vc.category_id WHERE vc.video_id = ?`, [req.params.id]);
        const keywords = queryAll(`SELECT k.word, vk.tfidf_score, vk.frequency FROM keywords k JOIN video_keywords vk ON k.id = vk.keyword_id WHERE vk.video_id = ? ORDER BY vk.tfidf_score DESC`, [req.params.id]);
        res.json({ ...video, categories, keywords });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/videos/:id/memo
router.put('/:id/memo', (req, res) => {
    try {
        runSQL('UPDATE videos SET memo = ? WHERE id = ?', [req.body.memo || '', req.params.id]); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/videos/:id/categories
router.put('/:id/categories', (req, res) => {
    try {
        runSQL('DELETE FROM video_categories WHERE video_id = ?', [req.params.id]);
        for (const catId of (req.body.category_ids || [])) {
            runSQL('INSERT OR IGNORE INTO video_categories (video_id, category_id, source) VALUES (?, ?, ?)', [req.params.id, catId, 'manual']);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/videos/:id
router.delete('/:id', (req, res) => {
    try {
        const video = queryOne('SELECT v.*, ch.name as channel_name FROM videos v JOIN channels ch ON v.channel_id = ch.id WHERE v.id = ?', [req.params.id]);
        if (!video) return res.status(404).json({ error: '영상을 찾을 수 없습니다' });

        runSQL(`INSERT OR IGNORE INTO excluded_videos (video_id, title, channel_name, reason) VALUES (?, ?, ?, 'manual_delete')`,
            [video.video_id, video.title, video.channel_name]);

        runSQL('DELETE FROM video_categories WHERE video_id = ?', [video.id]);
        runSQL('DELETE FROM video_spike_rankings WHERE video_id = ?', [video.video_id]);
        runSQL('DELETE FROM videos WHERE id = ?', [video.id]);

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/videos/check-existing — DB에 존재하는 video_id 목록 반환 (source 무관)
router.post('/check-existing', (req, res) => {
    try {
        const { videoIds } = req.body;
        if (!videoIds?.length) return res.json({ existing: [] });
        const placeholders = videoIds.map(() => '?').join(',');
        const rows = queryAll(
            `SELECT video_id FROM videos WHERE video_id IN (${placeholders})`,
            videoIds
        );
        res.json({ existing: rows.map(r => r.video_id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/videos/manual — Collect/Add manual video
router.post('/manual', (req, res) => {
    try {
        const {
            video_id, title, description, published_at,
            view_count, like_count, comment_count, duration_seconds, thumbnail_url,
            channel_id, channel_name, channel_thumbnail, subscriber_count,
            group_tag  // 1-G: 채널 카테고리
        } = req.body;

        if (!title) return res.status(400).json({ error: '제목을 입력해주세요.' });

        // 1. Resolve internal channel DB ID
        let channelDbId = null;
        let resolvedGroupTag = group_tag || '';
        if (channel_id) {
            const existing = queryOne('SELECT id, group_tag FROM channels WHERE channel_id = ?', [channel_id]);
            if (existing) {
                channelDbId = existing.id;
                resolvedGroupTag = resolvedGroupTag || existing.group_tag || '';
            } else if (channel_name) {
                // 1-G: group_tag 포함하여 채널 자동 등록
                const { lastId } = runSQL(
                    `INSERT INTO channels (channel_id, name, thumbnail_url, subscriber_count, group_tag) VALUES (?, ?, ?, ?, ?)`,
                    [channel_id, channel_name, channel_thumbnail || '', subscriber_count || 0, resolvedGroupTag]
                );
                channelDbId = lastId;
            }
        }

        // If still no channel, fallback to a global "Standalone" channel
        if (!channelDbId) {
            let standalone = queryOne('SELECT id FROM channels WHERE channel_id = ?', ['standalone']);
            if (!standalone) {
                const { lastId } = runSQL(`INSERT INTO channels (channel_id, name) VALUES (?, ?)`, ['standalone', '수집된 영상 (채널 미등록)']);
                channelDbId = lastId;
            } else {
                channelDbId = standalone.id;
            }
        }

        const vid = video_id || `manual_${Date.now()}`;

        // Check if already exists
        const existingVideo = queryOne('SELECT id FROM videos WHERE video_id = ?', [vid]);
        if (existingVideo) {
            return res.status(409).json({ error: '이미 수집된 영상입니다.' });
        }

        const { lastId } = runSQL(
            `INSERT INTO videos (
                channel_id, video_id, title, description, published_at,
                view_count, like_count, comment_count, duration_seconds, thumbnail_url,
                source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                channelDbId, vid, title, description || '', published_at || new Date().toISOString(),
                view_count || 0, like_count || 0, comment_count || 0, duration_seconds || 0, thumbnail_url || '',
                'search'
            ]
        );

        // 1-H: video_categories 자동 매핑
        try {
            const allDBCats = queryAll('SELECT * FROM categories');
            if (allDBCats.length > 0) {
                const catIds = categorizeVideoByKeywords({ title, description: description || '' }, allDBCats, resolvedGroupTag);
                for (const catId of catIds) {
                    runSQL(
                        'INSERT OR IGNORE INTO video_categories (video_id, category_id, source) VALUES (?, ?, ?)',
                        [lastId, catId, 'keyword_fallback']
                    );
                }
            }
        } catch (catErr) {
            console.error('[manual] video_categories 매핑 실패:', catErr.message);
        }

        const inserted = queryOne('SELECT * FROM videos WHERE id = ?', [lastId]);

        // 1-F: 백그라운드에서 rankings 재계산 (응답 먼저 반환)
        res.json(inserted);

        if (resolvedGroupTag && !req.body.skipRebuild) {
            setImmediate(() => {
                try {
                    rebuildSpikeRankings(resolvedGroupTag);
                } catch (rbErr) {
                    console.error('[manual] rankings rebuild 실패:', rbErr.message);
                }
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══ v4: GET /api/videos/:id/transcript — on-demand transcript ═══
router.get('/:id/transcript', async (req, res) => {
    try {
        console.log(`[API] Transcript requested for DB ID: ${req.params.id}`);
        const video = queryOne('SELECT * FROM videos WHERE id = ?', [req.params.id]);
        if (!video) {
            console.error(`[API] Video not found for ID: ${req.params.id}`);
            return res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
        }

        if (video.transcript_raw && video.transcript_raw.length > 50) {
            console.log(`[API] Returning cached transcript for ${video.video_id} (len: ${video.transcript_raw.length})`);
            return res.json({ text: video.transcript_raw, source: 'cached' });
        }

        if (!video.video_id || video.video_id.startsWith('manual_')) {
            console.log(`[API] Manual video or missing ID for ${video.title}`);
            return res.json({ text: null, message: '자막을 가져올 수 없는 영상입니다.' });
        }

        console.log(`[API] Fetching fresh transcript for ${video.video_id}...`);
        const text = await fetchTranscript(video.video_id);

        if (text) {
            console.log(`[API] Fetch success! Saving to DB for ID: ${req.params.id}`);
            runSQL('UPDATE videos SET transcript_raw = ?, has_transcript = 1 WHERE id = ?', [text, req.params.id]);
            return res.json({ text, source: 'fetched' });
        }

        console.log(`[API] Fetch returned null for ${video.video_id}`);
        res.json({ text: null, message: '자막이 없는 영상입니다.' });
    } catch (err) {
        console.error(`[API] Transcript Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══ v4: GET /api/videos/:id/comments — saved comments from DB ═══
router.get('/:id/comments', (req, res) => {
    try {
        const comments = queryAll('SELECT * FROM comments WHERE video_id = ? ORDER BY like_count DESC', [req.params.id]);
        res.json({ comments, total: comments.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/videos/classify-unclassified — AI 미분류 자동 분류
router.post('/classify-unclassified', async (req, res) => {
    try {
        const { groupTag } = req.body;
        if (!groupTag) return res.status(400).json({ error: 'groupTag 필수' });

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        const sendProgress = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const groupName = groupTag.trim() + '소재';
        const db = getDB();

        // 1. 미분류 영상 조회
        const unclassified = db.prepare(`
            SELECT v.id, v.video_id, v.title, ch.name as channel_name
            FROM videos v
            JOIN channels ch ON v.channel_id = ch.id
            WHERE NOT EXISTS (
                SELECT 1 FROM video_categories vc
                JOIN categories c ON vc.category_id = c.id
                WHERE vc.video_id = v.id AND c.group_name = ?
            )
            AND ch.group_tag = ?
            ORDER BY v.published_at DESC
        `).all(groupName, groupTag);

        if (unclassified.length === 0) {
            sendProgress({ type: 'done', message: '미분류 영상 없음', totalProcessed: 0, classified: 0, deleted: 0, keywordsAdded: 0, keywordsDetail: [], remaining: 0, batchesCompleted: 0, error: null });
            res.end();
            return;
        }

        // 2. 소재 목록 조회
        const materials = db.prepare(`SELECT id, name, keywords FROM categories WHERE group_name = ?`).all(groupName);
        const materialNames = materials.map(m => m.name);
        const materialMap = new Map(materials.map(m => [m.name, m]));

        // 3. 배치 처리 (100개씩, 최대 5회)
        const BATCH_SIZE = 100;
        const MAX_BATCHES = 5;
        const processedIds = new Set();

        let totalClassified = 0, totalDeleted = 0, totalKeywordsAdded = 0, batchCount = 0;
        let lastError = null;
        const keywordsDetail = [];
        const deletedDetail = [];
        const classifiedDetail = [];

        const insertVC = db.prepare(`INSERT OR IGNORE INTO video_categories (video_id, category_id, source) VALUES (?, ?, 'ai')`);
        const insertExcluded = db.prepare(`INSERT OR IGNORE INTO excluded_videos (video_id, title, channel_name, reason) VALUES (?, ?, ?, 'ai_unclassified')`);
        const deleteVC = db.prepare(`DELETE FROM video_categories WHERE video_id = ?`);
        const deleteRankings = db.prepare(`DELETE FROM video_spike_rankings WHERE video_id = ?`);
        const deleteVideo = db.prepare(`DELETE FROM videos WHERE id = ?`);

        for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
            if (batchCount >= MAX_BATCHES) break;
            const batch = unclassified.slice(i, i + BATCH_SIZE);
            batchCount++;

            console.log(`[AI분류] 배치 ${batchCount} 시작: ${batch.length}건 (전체 ${unclassified.length}건 중 ${i + 1}~${i + batch.length})`);

            try {
                const results = await classifyUnclassifiedVideos(batch, materialNames);
                let batchClassified = 0, batchDeleted = 0, batchKeywords = 0;
                const newKeywordsMap = new Map();

                for (const r of results) {
                    if (processedIds.has(r.videoId)) continue;
                    processedIds.add(r.videoId);

                    if (r.isDelete) {
                        const video = batch[r.videoIndex];
                        insertExcluded.run(video.video_id, video.title || '', video.channel_name || '');
                        deleteVC.run(video.id);
                        deleteRankings.run(video.id);
                        deleteVideo.run(video.id);
                        batchDeleted++;
                        deletedDetail.push({ title: video.title || '(제목 없음)', channel: video.channel_name || '' });
                    } else {
                        const mat = materialMap.get(r.category);
                        if (!mat) continue;
                        insertVC.run(r.videoId, mat.id);
                        batchClassified++;
                        const video = batch[r.videoIndex];
                        classifiedDetail.push({ title: video.title || '(제목 없음)', channel: video.channel_name || '', category: mat.name });
                        if (r.keywords.length > 0) {
                            if (!newKeywordsMap.has(mat.id)) newKeywordsMap.set(mat.id, new Set());
                            for (const kw of r.keywords) newKeywordsMap.get(mat.id).add(kw);
                        }
                    }
                }

                // 키워드 DB 반영
                for (const [matId, kwSet] of newKeywordsMap) {
                    const mat = materials.find(m => m.id === matId);
                    if (!mat) continue;
                    const existingKws = (mat.keywords || '').split(',').map(k => k.trim()).filter(k => k);
                    const existingSet = new Set(existingKws);
                    const addedKws = [];
                    for (const kw of kwSet) {
                        if (!existingSet.has(kw)) { existingKws.push(kw); existingSet.add(kw); addedKws.push(kw); }
                    }
                    if (addedKws.length > 0) {
                        db.prepare(`UPDATE categories SET keywords = ? WHERE id = ?`).run(existingKws.join(','), matId);
                        mat.keywords = existingKws.join(',');
                        batchKeywords += addedKws.length;
                        for (const kw of addedKws) {
                            keywordsDetail.push({ category: mat.name, keyword: kw });
                        }
                        console.log(`[AI분류] ${mat.name} 키워드 추가: ${addedKws.join(', ')}`);
                    }
                }

                totalClassified += batchClassified;
                totalDeleted += batchDeleted;
                totalKeywordsAdded += batchKeywords;
                console.log(`[AI분류] 배치 ${batchCount} 완료: 분류 ${batchClassified}, 삭제 ${batchDeleted}, 키워드 ${batchKeywords}개`);

                sendProgress({
                    type: 'progress',
                    batch: batchCount,
                    maxBatches: Math.min(MAX_BATCHES, Math.ceil(unclassified.length / BATCH_SIZE)),
                    processed: processedIds.size,
                    total: unclassified.length,
                    classified: totalClassified,
                    deleted: totalDeleted,
                    keywordsAdded: totalKeywordsAdded
                });

                if (batchClassified === 0 && batchDeleted === 0) {
                    console.warn('[AI분류] 진행 없음 감지, 중단');
                    lastError = '분류/삭제 0건으로 중단됨';
                    break;
                }

                if (i + BATCH_SIZE < unclassified.length && batchCount < MAX_BATCHES) {
                    await new Promise(r => setTimeout(r, 5000));
                }
            } catch (batchErr) {
                console.error(`[AI분류] 배치 ${batchCount} 오류:`, batchErr.message);
                lastError = batchErr.message;
                break;
            }
        }

        const remaining = db.prepare(`
            SELECT COUNT(*) as cnt FROM videos v
            JOIN channels ch ON v.channel_id = ch.id
            WHERE NOT EXISTS (
                SELECT 1 FROM video_categories vc
                JOIN categories c ON vc.category_id = c.id
                WHERE vc.video_id = v.id AND c.group_name = ?
            )
            AND ch.group_tag = ?
        `).get(groupName, groupTag).cnt;

        sendProgress({
            type: 'done',
            totalProcessed: totalClassified + totalDeleted,
            classified: totalClassified,
            deleted: totalDeleted,
            keywordsAdded: totalKeywordsAdded,
            keywordsDetail: keywordsDetail,
            deletedDetail: deletedDetail,
            classifiedDetail: classifiedDetail,
            remaining,
            batchesCompleted: batchCount,
            error: lastError
        });
        res.end();
    } catch (err) {
        console.error('[AI분류] 전체 오류:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/videos/rebuild-rankings — 수집 완료 후 1회 랭킹 재구축
router.post('/rebuild-rankings', (req, res) => {
    try {
        const { groupTag } = req.body;
        if (!groupTag) return res.status(400).json({ error: 'groupTag 필요' });
        rebuildSpikeRankings(groupTag);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
