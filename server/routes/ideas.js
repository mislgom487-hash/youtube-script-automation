import { Router } from 'express';
import { queryAll, queryOne, runSQL } from '../db.js';

const router = Router();

// GET /api/ideas
router.get('/', (req, res) => {
    try {
        const { category, idea_type, save_type } = req.query;
        let sql = 'SELECT * FROM ideas WHERE 1=1';
        const params = [];
        if (category) { sql += ' AND category = ?'; params.push(category); }
        if (idea_type) {
            const types = idea_type.split(',').map(t => t.trim()).filter(t => t);
            sql += ` AND idea_type IN (${types.map(() => '?').join(',')})`;
            params.push(...types);
        }
        if (save_type) {
            const types = save_type.split(',').map(t => t.trim());
            sql += ` AND save_type IN (${types.map(() => '?').join(',')})`;
            params.push(...types);
        }
        sql += ' ORDER BY created_at DESC';
        res.json({ ideas: queryAll(sql, params) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ideas
router.post('/', (req, res) => {
    try {
        const {
            title, description, category, idea_type,
            source_video_id, source_video_title,
            source_channel_name, source_thumbnail_url,
            dna_score, dna_summary, save_type,
            view_count, subscriber_count, duration_seconds,
            spike_ratio, spike_grade, video_id
        } = req.body;
        const now = new Date().toISOString();
        const { lastId } = runSQL(
            `INSERT INTO ideas
             (title, description, category, idea_type,
              source_video_id, source_video_title,
              source_channel_name, source_thumbnail_url,
              dna_score, dna_summary, save_type,
              view_count, subscriber_count, duration_seconds,
              spike_ratio, spike_grade, video_id,
              status, priority, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'idea','normal',?,?)`,
            [
                title || '', description || '', category || '', idea_type || 'memo',
                source_video_id || '', source_video_title || '',
                source_channel_name || '', source_thumbnail_url || '',
                dna_score || 0, dna_summary || '', save_type || '',
                view_count || 0, subscriber_count || 0, duration_seconds || 0,
                spike_ratio || 0, spike_grade || '', video_id || '',
                now, now
            ]
        );
        res.json({ id: lastId, success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/ideas/:id
router.put('/:id', (req, res) => {
    try {
        const { title, description, category } = req.body;
        const now = new Date().toISOString();
        runSQL(
            `UPDATE ideas SET title=?, description=?, category=?, updated_at=? WHERE id=?`,
            [title, description, category || '', now, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/ideas/:id
router.delete('/:id', (req, res) => {
    try {
        runSQL('DELETE FROM ideas WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ideas/check/:videoId — 저장 여부 확인
router.get('/check/:videoId', (req, res) => {
    try {
        const { videoId } = req.params;
        const rows = queryAll(
            `SELECT save_type FROM ideas WHERE source_video_id = ?`,
            [videoId]
        );
        res.json({
            idea: rows.some(r => r.save_type === 'idea'),
            thumbnail: rows.some(r => r.save_type === 'thumbnail')
        });
    } catch (err) {
        res.json({ idea: false, thumbnail: false });
    }
});

// GET /api/ideas/thumbnails
router.get('/thumbnails', (req, res) => {
    try {
        const { category } = req.query;
        let sql = `SELECT * FROM ideas WHERE idea_type = 'dna'
                   AND save_type = 'thumbnail'
                   AND source_thumbnail_url != '' AND source_thumbnail_url IS NOT NULL`;
        const params = [];
        if (category) { sql += ' AND category = ?'; params.push(category); }
        sql += ' ORDER BY created_at DESC';
        res.json({ thumbnails: queryAll(sql, params) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
