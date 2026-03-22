import { Router } from 'express';
import multer from 'multer';
import { queryAll, queryOne, runSQL } from '../db.js';
import { readFileSync } from 'fs';
import fs from 'fs';
import path from 'path';

const router = Router();

// txt 파일 업로드용 multer 설정
const uploadDir = process.env.ELECTRON_MODE === 'true'
  ? path.join(process.env.ELECTRON_USER_DATA, 'data', 'uploads')
  : 'data/uploads/';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: process.env.ELECTRON_MODE === 'true'
    ? path.join(process.env.ELECTRON_USER_DATA, 'data', 'uploads')
    : 'data/uploads/',
  limits: { fileSize: 512000 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/plain' ||
        file.originalname.endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('txt 파일만 업로드 가능합니다.'));
    }
  }
});

// GET /api/guidelines — 전체 지침 목록
router.get('/', (req, res) => {
  try {
    const { category, type, active } = req.query;
    let sql = 'SELECT id, category, type, title, is_active, created_at, updated_at FROM story_guidelines';
    const conditions = [];
    const params = [];

    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }
    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }
    if (active) {
      conditions.push('is_active = 1');
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY is_active DESC, updated_at DESC';

    const rows = queryAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guidelines/:id — 특정 지침 상세 (content 포함)
router.get('/:id', (req, res) => {
  try {
    const row = queryOne(
      'SELECT * FROM story_guidelines WHERE id = ?',
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: '지침을 찾을 수 없습니다.' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/guidelines — 새 지침 등록
router.post('/', (req, res) => {
  try {
    const { category, type, title, content } = req.body;
    if (!category || !type || !title || !content) {
      return res.status(400).json({ error: 'category, type, title, content 모두 필수입니다.' });
    }
    if (type !== 'topic_prompt' && type !== 'thumbnail_prompt') {
      return res.status(400).json({ error: 'type은 topic_prompt 또는 thumbnail_prompt만 가능합니다.' });
    }

    // 같은 category+type의 기존 활성 지침 비활성화
    runSQL(
      "UPDATE story_guidelines SET is_active = 0, updated_at = datetime('now') WHERE category = ? AND type = ? AND is_active = 1",
      [category, type]
    );

    // 새 지침 등록 (활성 상태)
    const result = runSQL(
      'INSERT INTO story_guidelines (category, type, title, content, is_active) VALUES (?, ?, ?, ?, 1)',
      [category, type, title, content]
    );

    res.json({ id: result.lastId, message: '지침이 등록되었습니다.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/guidelines/upload — txt 파일로 지침 등록
router.post('/upload', upload.single('file'), (req, res) => {
  try {
    const { category, type, title } = req.body;
    if (!category || !type || !title) {
      return res.status(400).json({ error: 'category, type, title 모두 필수입니다.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'txt 파일이 필요합니다.' });
    }

    const content = readFileSync(req.file.path, 'utf-8');

    // 기존 활성 지침 비활성화
    runSQL(
      "UPDATE story_guidelines SET is_active = 0, updated_at = datetime('now') WHERE category = ? AND type = ? AND is_active = 1",
      [category, type]
    );

    const result = runSQL(
      'INSERT INTO story_guidelines (category, type, title, content, is_active) VALUES (?, ?, ?, ?, 1)',
      [category, type, title, content]
    );

    res.json({ id: result.lastId, message: '지침 파일이 등록되었습니다.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/guidelines/:id — 지침 수정
router.put('/:id', (req, res) => {
  try {
    const existing = queryOne('SELECT * FROM story_guidelines WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '지침을 찾을 수 없습니다.' });

    const title = req.body.title || existing.title;
    const content = req.body.content || existing.content;

    runSQL(
      "UPDATE story_guidelines SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
      [title, content, req.params.id]
    );

    res.json({ message: '지침이 수정되었습니다.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/guidelines/:id — 지침 삭제
router.delete('/:id', (req, res) => {
  try {
    const existing = queryOne('SELECT * FROM story_guidelines WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '지침을 찾을 수 없습니다.' });

    runSQL('DELETE FROM story_guidelines WHERE id = ?', [req.params.id]);

    res.json({ message: '지침이 삭제되었습니다.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/guidelines/:id/activate — 지침 활성화
router.put('/:id/activate', (req, res) => {
  try {
    const existing = queryOne('SELECT * FROM story_guidelines WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '지침을 찾을 수 없습니다.' });

    // 같은 category+type의 기존 활성 지침 비활성화
    runSQL(
      "UPDATE story_guidelines SET is_active = 0, updated_at = datetime('now') WHERE category = ? AND type = ? AND is_active = 1",
      [existing.category, existing.type]
    );

    // 선택한 지침 활성화
    runSQL(
      "UPDATE story_guidelines SET is_active = 1, updated_at = datetime('now') WHERE id = ?",
      [req.params.id]
    );

    res.json({ message: '지침이 활성화되었습니다.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
