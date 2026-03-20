import { Router } from 'express';
import { queryAll, queryOne, runSQL, runSQLNoSave, saveDB } from '../db.js';
import { resolveChannel, apiFetch } from '../services/youtube-fetcher.js';

const router = Router();

// 초기 데이터 마이그레이션: 경제 채널 sub_type NULL → '실사'
try {
    runSQL(`UPDATE channels SET sub_type = '실사' WHERE group_tag = '경제' AND sub_type IS NULL`);
} catch (e) { /* ignore */ }

// DB 마이그레이션: deleted_channels에 sub_type 컬럼 추가
try {
    runSQL(`ALTER TABLE deleted_channels ADD COLUMN sub_type TEXT`);
} catch (err) { if (!err.message.includes('duplicate column')) console.error(err); }
try {
    runSQL(`UPDATE deleted_channels SET sub_type = '실사' WHERE group_tag = '경제' AND sub_type IS NULL`);
} catch (e) { /* ignore */ }

// GET /api/channels — list all channels
router.get('/', (req, res) => {
    try {
        const t = Date.now();
        const channels = queryAll(`
            SELECT c.*, COALESCE(vc.cnt, 0) as collected_count
            FROM channels c
            LEFT JOIN (
                SELECT channel_id, COUNT(*) as cnt FROM videos GROUP BY channel_id
            ) vc ON vc.channel_id = c.id
            ORDER BY c.created_at DESC
        `);
        console.log('[PERF-SERVER] channels query:', Date.now() - t, 'ms, rows:', channels.length);
        res.json(channels);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/channels/ids — channel_id 목록만 반환 (경량, search.js 전용)
router.get('/ids', (req, res) => {
    try {
        const rows = queryAll('SELECT channel_id FROM channels');
        res.json(rows.map(r => r.channel_id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/channels/preview — preview channel info before registering
router.post('/preview', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: '채널 URL 또는 ID를 입력해주세요.' });
        const info = await resolveChannel(input);
        res.json(info);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/channels — register a new channel
router.post('/', async (req, res) => {
    try {
        const { channel_id, name, handle, thumbnail_url, subscriber_count, video_count, group_tag, description, sub_type } = req.body;
        if (!channel_id || !name) return res.status(400).json({ error: '필수 정보가 없습니다.' });

        const existing = queryOne('SELECT id FROM channels WHERE channel_id = ?', [channel_id]);
        if (existing) return res.status(409).json({ error: '이미 등록된 채널입니다.' });

        const { lastId } = runSQL(
            `INSERT INTO channels (channel_id, name, handle, thumbnail_url, subscriber_count, video_count, group_tag, description, sub_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [channel_id, name, handle || '', thumbnail_url || '', subscriber_count || 0, video_count || 0, group_tag || '', description || '', sub_type || (['경제', '심리'].includes(group_tag) ? '실사' : null)]
        );

        // Deep categorization: Fetch videos if missing, then analyze
        let finalGroupTag = group_tag || '';
        if (!finalGroupTag) {
            try {
                const { classifyChannel } = await import('../services/gemini-service.js');
                const { fetchChannelVideos } = await import('../services/youtube-fetcher.js');

                let videoData = req.body.initial_video_data || [];

                // If no initial data, fetch from YouTube immediately
                if (videoData.length === 0 && channel_id) {
                    const ytVideos = await fetchChannelVideos(channel_id, 15);
                    videoData = ytVideos.map(v => ({ title: v.title, description: v.description }));

                    // Save these videos to DB immediately
                    for (const v of ytVideos) {
                        try {
                            runSQL(`INSERT OR IGNORE INTO videos (
                                channel_id, video_id, title, description, published_at, 
                                view_count, like_count, comment_count, duration_seconds, thumbnail_url
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                                lastId, v.video_id, v.title, v.description, v.published_at,
                                v.view_count, v.like_count, v.comment_count, v.duration_seconds, v.thumbnail_url
                            ]);
                        } catch (vidErr) { /* ignore */ }
                    }
                }

                if (videoData.length > 0) {
                    const category = await classifyChannel(name, videoData, req.body.search_context, description || '');
                    if (category && category !== '미분류') {
                        runSQL('UPDATE channels SET group_tag = ? WHERE id = ?', [category, lastId]);
                        finalGroupTag = category;
                    }
                }
            } catch (err) {
                console.error('Deep classification during registration failed:', err.message);
            }
        }

        const channel = queryOne('SELECT * FROM channels WHERE id = ?', [lastId]);
        res.json(channel);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/channels/categories — sort_order 기준 정렬, category_settings 자동 동기화
router.get('/categories', (req, res) => {
    try {
        // 1. channels에서 고유 group_tag 조회
        const channelCats = queryAll(
            `SELECT DISTINCT group_tag FROM channels WHERE group_tag IS NOT NULL AND group_tag != ''`
        );
        // 2. category_settings에 없는 항목 자동 추가
        for (const row of channelCats) {
            runSQL(
                `INSERT OR IGNORE INTO category_settings (category_name, sort_order)
                 VALUES (?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM category_settings))`,
                [row.group_tag]
            );
        }
        // 3. sort_order 기준 정렬 반환
        const sorted = queryAll(
            `SELECT category_name, sub_type_mode, material_group_name FROM category_settings ORDER BY sort_order ASC`
        );
        res.json({ categories: sorted.map(r => ({ name: r.category_name, sub_type_mode: r.sub_type_mode || 'none', material_group_name: r.material_group_name || (r.category_name + '소재') })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/channels/categories — 카테고리 신규 등록
router.post('/categories', (req, res) => {
    try {
        const { name, sub_type_mode } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: '카테고리명을 입력해주세요.' });
        const exists = queryOne('SELECT id FROM category_settings WHERE category_name = ?', [name.trim()]);
        if (exists) return res.status(409).json({ error: '이미 존재하는 카테고리입니다.' });
        const mode = sub_type_mode === 'dual' ? 'dual' : 'none';
        const mgn = name.trim() + '소재';
        runSQL(
            `INSERT INTO category_settings (category_name, sort_order, sub_type_mode, material_group_name)
             VALUES (?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM category_settings), ?, ?)`,
            [name.trim(), mode, mgn]
        );
        const sorted = queryAll(`SELECT category_name, sub_type_mode, material_group_name FROM category_settings ORDER BY sort_order ASC`);
        res.json({ categories: sorted.map(r => ({ name: r.category_name, sub_type_mode: r.sub_type_mode || 'none', material_group_name: r.material_group_name || (r.category_name + '소재') })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/channels/categories/:name — 카테고리 삭제
router.delete('/categories/:name', (req, res) => {
    try {
        const name = decodeURIComponent(req.params.name);
        const mgn = name + '소재';
        runSQL('DELETE FROM video_categories WHERE category_id IN (SELECT id FROM categories WHERE group_name = ?)', [mgn]);
        runSQL('DELETE FROM categories WHERE group_name = ?', [mgn]);
        runSQL('DELETE FROM category_settings WHERE category_name = ?', [name]);
        runSQL('DELETE FROM category_keywords WHERE category_name = ?', [name]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/channels/categories/reorder — 카테고리 순서 저장
router.put('/categories/reorder', (req, res) => {
    try {
        const { order } = req.body;
        if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
        for (let i = 0; i < order.length; i++) {
            runSQL(
                `UPDATE category_settings SET sort_order = ?, updated_at = datetime('now') WHERE category_name = ?`,
                [i, order[i]]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/channels/spike-counts — 채널별 떡상 TOP50 영상 수 (주제찾기 동기화)
router.get('/spike-counts', (req, res) => {
    try {
        const rows = queryAll(`
            WITH top50 AS (
                SELECT video_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY genre, category_name
                           ORDER BY rank_in_category ASC
                       ) AS rn
                FROM video_spike_rankings
                WHERE is_spike = 1
            )
            SELECT v.channel_id, COUNT(*) AS spike_count
            FROM top50 t
            JOIN videos v ON v.id = t.video_id
            WHERE t.rn <= 50
            GROUP BY v.channel_id
        `);
        res.json({ spikeCounts: rows });
    } catch (e) {
        console.error('spike-counts error:', e);
        res.json({ spikeCounts: [] });
    }
});

// GET /api/channels/deleted/list — 삭제된 채널 목록 조회
router.get('/deleted/list', (req, res) => {
    try {
        const { group_tag, sub_type, sort, reason, keyword } = req.query;
        let sql = 'SELECT * FROM deleted_channels WHERE 1=1';
        const params = [];
        if (group_tag && group_tag !== 'all') { sql += ' AND group_tag = ?'; params.push(group_tag); }
        if (sub_type) { sql += ' AND (sub_type = ? OR sub_type IS NULL)'; params.push(sub_type); }
        if (reason && reason !== 'all') { sql += ' AND delete_reason = ?'; params.push(reason); }
        if (keyword) { sql += ' AND name LIKE ?'; params.push(`%${keyword}%`); }
        sql += sort === 'subscriber' ? ' ORDER BY subscriber_count DESC' : ' ORDER BY deleted_at DESC';
        const rows = queryAll(sql, params);

        let statSql = 'SELECT delete_reason, COUNT(*) AS cnt FROM deleted_channels WHERE 1=1';
        const statParams = [];
        if (group_tag && group_tag !== 'all') { statSql += ' AND group_tag = ?'; statParams.push(group_tag); }
        if (sub_type) { statSql += ' AND (sub_type = ? OR sub_type IS NULL)'; statParams.push(sub_type); }
        statSql += ' GROUP BY delete_reason';
        const stats = queryAll(statSql, statParams);
        const totalAll = stats.reduce((s, r) => s + r.cnt, 0);

        res.json({ channels: rows, total: rows.length, stats: { total: totalAll, reasons: stats } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/channels/inactive?days=N&group_tag=TAG — 장기 미업로드 채널
router.get('/inactive', (req, res) => {
    const days = parseInt(req.query.days) || 30;
    const groupTag = req.query.group_tag || null;
    try {
        let sql = `
            SELECT c.id, c.channel_id, c.name, c.group_tag,
                MAX(v.published_at) as last_upload
            FROM channels c
            LEFT JOIN videos v ON c.id = v.channel_id
        `;
        const params = [];
        if (groupTag && groupTag !== 'all') {
            sql += ' WHERE c.group_tag = ?';
            params.push(groupTag);
        }
        sql += `
            GROUP BY c.id
            HAVING last_upload IS NULL
                OR last_upload < datetime('now', '-' || ? || ' days')
        `;
        params.push(days);
        const rows = queryAll(sql, params);
        res.json({ channels: rows, count: rows.length });
    } catch (e) {
        console.error('inactive error:', e);
        res.json({ channels: [], count: 0 });
    }
});

// POST /api/channels/restore/:id — 삭제된 채널 복구
router.post('/restore/:id', (req, res) => {
    const { id } = req.params;
    const deleted = queryOne('SELECT * FROM deleted_channels WHERE id = ?', [id]);
    if (!deleted) return res.status(404).json({ error: '삭제 기록 없음' });

    const existing = queryOne('SELECT id FROM channels WHERE channel_id = ?', [deleted.channel_id]);
    if (existing) return res.status(409).json({ error: '이미 존재하는 채널' });

    runSQL(`
        INSERT INTO channels (channel_id, name, handle, group_tag, thumbnail_url,
            subscriber_count, video_count, description, created_at, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [deleted.channel_id, deleted.name, deleted.handle, deleted.group_tag,
        deleted.thumbnail_url, deleted.subscriber_count, deleted.video_count,
        deleted.description, deleted.created_at]);

    runSQL('DELETE FROM deleted_channels WHERE id = ?', [id]);
    res.json({ success: true, message: '채널이 복구되었습니다' });
});

// PUT /api/channels/deleted/:id/reason — 삭제 이유 변경
router.put('/deleted/:id/reason', (req, res) => {
    const { id } = req.params;
    const { reason, reasonDetail } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason 필수' });

    try {
        const row = queryOne('SELECT id FROM deleted_channels WHERE id = ?', [id]);
        if (!row) return res.status(404).json({ error: '삭제 기록 없음' });
        runSQL('UPDATE deleted_channels SET delete_reason = ?, delete_reason_detail = ? WHERE id = ?',
            [reason, reasonDetail || null, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/channels/bulk-subtype — 여러 채널 sub_type 일괄 업데이트
router.put('/bulk-subtype', (req, res) => {
    const { channelIds, subType } = req.body;
    if (!channelIds || !Array.isArray(channelIds) || channelIds.length === 0 || !subType) {
        return res.status(400).json({ error: 'channelIds 배열과 subType 필수' });
    }
    if (!['만화', '실사'].includes(subType)) {
        return res.status(400).json({ error: 'subType은 만화 또는 실사만 가능' });
    }
    try {
        const placeholders = channelIds.map(() => '?').join(',');
        runSQL(`UPDATE channels SET sub_type = ? WHERE id IN (${placeholders})`, [subType, ...channelIds]);
        res.json({ success: true, updated: channelIds.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/channels/:id/spike-videos — 채널의 떡상 TOP50 영상 (주제찾기 동기화)
router.get('/:id/spike-videos', (req, res) => {
    try {
        const videos = queryAll(`
            WITH top50 AS (
                SELECT video_id, spike_ratio, rank_in_category,
                       genre, category_name, subscriber_count,
                       ROW_NUMBER() OVER (
                           PARTITION BY genre, category_name
                           ORDER BY rank_in_category ASC
                       ) AS rn
                FROM video_spike_rankings
                WHERE is_spike = 1
            )
            SELECT v.video_id, v.title, v.view_count, v.like_count,
                   v.thumbnail_url, v.published_at,
                   v.duration_seconds, v.comment_count,
                   t.spike_ratio, t.rank_in_category AS rank,
                   t.genre, t.category_name, t.subscriber_count
            FROM top50 t
            JOIN videos v ON v.id = t.video_id
            WHERE v.channel_id = ? AND t.rn <= 50
            ORDER BY t.rank_in_category ASC
        `, [req.params.id]);
        res.json({ videos });
    } catch (e) {
        console.error('spike-videos error:', e);
        res.json({ videos: [] });
    }
});

// GET /api/channels/:id — get single channel
router.get('/:id', (req, res) => {
    try {
        const channel = queryOne(`
            SELECT c.*,
              (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id) as collected_count
            FROM channels c WHERE c.id = ?
        `, [req.params.id]);
        if (!channel) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' });
        res.json(channel);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/channels/:id/toggle-active — toggle channel active state
router.put('/:id/toggle-active', (req, res) => {
    try {
        const { id } = req.params;
        const channel = queryOne('SELECT is_active FROM channels WHERE id = ?', [id]);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        const newState = channel.is_active ? 0 : 1;
        runSQL('UPDATE channels SET is_active = ? WHERE id = ?', [newState, id]);
        res.json({ id, is_active: newState });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/channels/by-youtube-id/:channelId — 검색 등록 취소용 (deleted_channels 기록 없음)
router.delete('/by-youtube-id/:channelId', (req, res) => {
    const { channelId } = req.params;
    try {
        const channel = queryOne('SELECT * FROM channels WHERE channel_id = ?', [channelId]);
        if (!channel) return res.status(404).json({ error: '채널 없음' });
        runSQL(`DELETE FROM video_spike_rankings WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?)`, [channel.id]);
        runSQL(`DELETE FROM video_categories WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?)`, [channel.id]);
        runSQL('DELETE FROM videos WHERE channel_id = ?', [channel.id]);
        runSQL('DELETE FROM channels WHERE id = ?', [channel.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/channels/:id — delete channel and its videos
router.delete('/:id', (req, res) => {
    try {
        const id = req.params.id;
        const reason = req.body?.reason || '이유없음';
        const reasonDetail = req.body?.reasonDetail || null;

        const ch = queryOne('SELECT * FROM channels WHERE id = ?', [id]);
        if (!ch) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' });

        const countRow = queryOne('SELECT COUNT(*) AS cnt FROM videos WHERE channel_id = ?', [id]);

        runSQL(`INSERT INTO deleted_channels
            (channel_id, name, handle, group_tag, sub_type, thumbnail_url,
             subscriber_count, video_count, collected_count,
             description, created_at, delete_reason, delete_reason_detail)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [ch.channel_id, ch.name, ch.handle, ch.group_tag, ch.sub_type || null,
             ch.thumbnail_url, ch.subscriber_count, ch.video_count,
             countRow?.cnt || 0, ch.description, ch.created_at,
             reason, reasonDetail]
        );

        runSQL(`DELETE FROM video_spike_rankings
            WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?)`, [id]);
        runSQL(`DELETE FROM video_categories WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?)`, [id]);
        runSQL('DELETE FROM videos WHERE channel_id = ?', [id]);

        runSQL('DELETE FROM channels WHERE id = ?', [id]);
        res.json({ success: true, message: `${ch.name} 채널이 삭제되었습니다.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/channels/:id/categorized-videos — get videos grouped by categories
router.get('/:id/categorized-videos', (req, res) => {
    try {
        const channelId = req.params.id;

        // 1. Get all categories for context
        const categories = queryAll('SELECT * FROM categories ORDER BY group_name, sort_order');
        const groups = [...new Set(categories.map(c => c.group_name))];

        // 2. Get videos with their linked categories
        const videos = queryAll(`
            SELECT v.id, v.title, v.video_id, v.published_at, v.view_count, v.thumbnail_url,
                   c.id as cat_id, c.name as cat_name, c.group_name as group_name
            FROM videos v
            LEFT JOIN video_categories vc ON v.id = vc.video_id
            LEFT JOIN categories c ON vc.category_id = c.id
            WHERE v.channel_id = ?
            ORDER BY v.published_at DESC
        `, [channelId]);

        // 3. Structure the data: Group -> Category -> Videos
        const result = groups.map(groupName => {
            const groupCats = categories.filter(c => c.group_name === groupName);
            return {
                group: groupName,
                categories: groupCats.map(cat => {
                    const catVideos = videos.filter(v => v.cat_id === cat.id);
                    return {
                        id: cat.id,
                        name: cat.name,
                        count: catVideos.length,
                        videos: catVideos.slice(0, 50) // Limit per category for performance
                    };
                }),
                // Videos with no category in THIS group
                uncategorized: videos.filter(v => {
                    const hasCatInGroup = videos.some(v2 => v2.id === v.id && v2.group_name === groupName);
                    return !hasCatInGroup;
                }).length
            };
        });

        // 4. Special "All" category for the channel
        const totalCount = queryOne('SELECT COUNT(*) as count FROM videos WHERE channel_id = ?', [channelId]).count;

        res.json({
            channel_id: channelId,
            total_videos: totalCount,
            structure: result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/channels/auto-categorize-all — analyze all channels with AI and set categories
router.post('/auto-categorize-all', async (req, res) => {
    try {
        const { classifyChannel } = await import('../services/gemini-service.js');
        const { fetchChannelVideos, resolveChannel } = await import('../services/youtube-fetcher.js');

        // Select all channels to allow re-categorization and track current tags
        const channels = queryAll('SELECT id, channel_id, name, description, group_tag FROM channels');
        if (channels.length === 0) return res.json({ success: true, count: 0 });

        let count = 0;
        const results = [];

        // v6: High speed parallel processing with batch saving
        const CHUNK_SIZE = 5;
        for (let i = 0; i < channels.length; i += CHUNK_SIZE) {
            const chunk = channels.slice(i, i + CHUNK_SIZE);
            console.log(`[AI 분류 배치] ${i + 1}~${Math.min(i + CHUNK_SIZE, channels.length)}번째 채널 분석 중...`);

            await Promise.all(chunk.map(async (ch) => {
                try {
                    // 1. Get titles AND descriptions from DB
                    const videos = queryAll('SELECT title, description FROM videos WHERE channel_id = ? ORDER BY published_at DESC LIMIT 15', [ch.id]);
                    let videoData = videos.map(v => ({ title: v.title, description: v.description }));
                    let currentDescription = ch.description || '';

                    // 2. Fetch data if missing
                    if ((videoData.length === 0 || !currentDescription) && ch.channel_id) {
                        try {
                            const ytInfo = await resolveChannel(ch.channel_id);
                            if (!currentDescription && ytInfo.description) {
                                currentDescription = ytInfo.description;
                                runSQLNoSave('UPDATE channels SET description = ? WHERE id = ?', [currentDescription, ch.id]);
                            }
                            if (videoData.length === 0) {
                                const ytVideos = await fetchChannelVideos(ch.channel_id, 15);
                                videoData = ytVideos.map(v => ({ title: v.title, description: v.description }));

                                for (const v of ytVideos) {
                                    try {
                                        runSQLNoSave(`INSERT OR IGNORE INTO videos (
                                            channel_id, video_id, title, description, published_at, 
                                            view_count, like_count, comment_count, duration_seconds, thumbnail_url
                                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                                            ch.id, v.video_id, v.title, v.description, v.published_at,
                                            v.view_count, v.like_count, v.comment_count, v.duration_seconds, v.thumbnail_url
                                        ]);
                                    } catch (e) { }
                                }
                            }
                        } catch (yerr) {
                            console.error(`[AI 분류] 데이터 수집 실패 (${ch.name}):`, yerr.message);
                        }
                    }

                    if (videoData.length > 0) {
                        const category = await classifyChannel(ch.name, videoData, '', currentDescription);
                        const finalCategory = (category === '야담' || category === '경제' || category === '심리학') ? category : '';

                        if (finalCategory) {
                            runSQLNoSave('UPDATE channels SET group_tag = ? WHERE id = ?', [finalCategory, ch.id]);
                            count++;
                            results.push({ id: ch.id, name: ch.name, category: finalCategory, updated: true });
                        } else {
                            results.push({ id: ch.id, name: ch.name, category: '미분류', updated: false });
                        }
                    }
                } catch (err) {
                    console.error(`[AI 분류] 오류 (${ch.name}):`, err.message);
                }
            }));

            // Sync with disk after each chunk for high performance + safety
            saveDB();
        }

        const changedCount = results.filter(r => r.updated).length;
        res.json({ success: true, count, changedCount, detail: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── 카테고리 키워드 관리 ────────────────────────────────────────────────────

// GET /api/channels/keywords/:category?tab=video|channel — 키워드 목록
router.get('/keywords/:category', (req, res) => {
    try {
        const tabType = req.query.tab || 'video';
        const rows = queryAll(
            'SELECT id, keyword FROM category_keywords WHERE category_name = ? AND tab_type = ? ORDER BY order_index ASC, id ASC',
            [req.params.category, tabType]
        );
        res.json({ keywords: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/channels/keywords/:category — 키워드 추가
router.post('/keywords/:category', (req, res) => {
    try {
        const { keyword, tab_type } = req.body;
        const tabType = tab_type || 'video';
        if (!keyword?.trim()) return res.status(400).json({ error: '키워드를 입력해주세요.' });
        const maxRow = queryOne(
            'SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM category_keywords WHERE category_name = ? AND tab_type = ?',
            [req.params.category, tabType]
        );
        runSQL(
            'INSERT OR IGNORE INTO category_keywords (category_name, keyword, tab_type, order_index) VALUES (?, ?, ?, ?)',
            [req.params.category, keyword.trim(), tabType, maxRow.next]
        );
        const rows = queryAll(
            'SELECT id, keyword FROM category_keywords WHERE category_name = ? AND tab_type = ? ORDER BY order_index ASC, id ASC',
            [req.params.category, tabType]
        );
        res.json({ keywords: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/channels/keywords/:category/reorder — 순서 저장
router.put('/keywords/:category/reorder', (req, res) => {
    try {
        const { orderedIds } = req.body;
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds 필요' });
        orderedIds.forEach((id, idx) => {
            runSQL('UPDATE category_keywords SET order_index = ? WHERE id = ?', [idx, id]);
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/channels/keywords/:category/:id — 키워드 삭제
router.delete('/keywords/:category/:id', (req, res) => {
    try {
        runSQL(
            'DELETE FROM category_keywords WHERE id = ? AND category_name = ?',
            [req.params.id, req.params.category]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/channels/refresh-subscribers — 구독자수 일괄 갱신
router.post('/refresh-subscribers', async (req, res) => {
  try {
    const { channelIds } = req.body;
    if (!channelIds || !Array.isArray(channelIds) || channelIds.length === 0) {
      return res.status(400).json({ error: 'channelIds 배열이 필요합니다' });
    }

    const changes = [];
    const unchanged = [];

    for (let i = 0; i < channelIds.length; i += 50) {
      const batch = channelIds.slice(i, i + 50);
      const channelRows = batch.map(id =>
        queryOne('SELECT id, channel_id, name, subscriber_count FROM channels WHERE id = ?', [id])
      ).filter(Boolean);

      const youtubeIds = channelRows.map(r => r.channel_id).filter(Boolean);
      if (youtubeIds.length === 0) continue;

      const response = await apiFetch('channels', { part: 'statistics', id: youtubeIds.join(',') });
      if (response && response.items) {
        for (const item of response.items) {
          const newSub = parseInt(item.statistics.subscriberCount || '0', 10);
          const row = channelRows.find(r => r.channel_id === item.id);
          if (!row) continue;

          const oldSub = row.subscriber_count || 0;
          runSQL('UPDATE channels SET subscriber_count = ? WHERE channel_id = ?', [newSub, item.id]);

          if (newSub !== oldSub) {
            changes.push({ name: row.name, oldCount: oldSub, newCount: newSub, diff: newSub - oldSub });
          } else {
            unchanged.push({ name: row.name, count: oldSub });
          }
        }
      }
    }

    changes.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    res.json({
      success: true,
      total: channelIds.length,
      changed: changes.length,
      unchangedCount: unchanged.length,
      changes,
    });
  } catch (err) {
    console.error('[refresh-subscribers] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
