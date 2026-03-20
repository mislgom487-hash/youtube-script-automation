import { Router } from 'express';
import { queryAll, queryOne, runSQL } from '../db.js';

const router = Router();

// 테이블 자동 생성
runSQL(`
  CREATE TABLE IF NOT EXISTS thumb_title_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL,
    title TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 마이그레이션: 기존 story_guidelines content에서 제목 추출 (최초 1회)
const countRow = queryOne('SELECT COUNT(*) as cnt FROM thumb_title_references');
if (!countRow || countRow.cnt === 0) {
  const guideline = queryOne(
    "SELECT id, content FROM story_guidelines WHERE type = 'thumbnail_prompt' AND is_active = 1"
  );
  if (guideline && guideline.content) {
    const content = guideline.content;
    const markerIdx = content.indexOf('[썸네일 제목 참고 데이터]');
    if (markerIdx !== -1) {
      const afterMarker = content.substring(markerIdx + '[썸네일 제목 참고 데이터]'.length);
      const lines = afterMarker.split('\n');
      const regex = /^(\d+)\.\s+(.+)$/;
      let inserted = 0;
      for (const line of lines) {
        const match = line.trim().match(regex);
        if (match) {
          try {
            runSQL(
              'INSERT INTO thumb_title_references (number, title) VALUES (?, ?)',
              [parseInt(match[1]), match[2].trim()]
            );
            inserted++;
          } catch (e) { /* 중복 무시 */ }
        }
      }
      if (inserted > 0) {
        const beforeMarker = content.substring(0, markerIdx + '[썸네일 제목 참고 데이터]'.length);
        runSQL(
          'UPDATE story_guidelines SET content = ? WHERE id = ?',
          [beforeMarker + '\n{{THUMB_TITLE_REFERENCES}}', guideline.id]
        );
        console.log(`[마이그레이션] 썸네일 제목 ${inserted}개 이전 완료`);
      }
    }
  }
}

// GET / — 전체 목록 (검색 지원)
router.get('/', (req, res) => {
  try {
    const { search } = req.query;
    let rows;
    if (search && search.trim()) {
      rows = queryAll(
        'SELECT * FROM thumb_title_references WHERE title LIKE ? ORDER BY number ASC',
        [`%${search.trim()}%`]
      );
    } else {
      rows = queryAll('SELECT * FROM thumb_title_references ORDER BY number ASC');
    }
    res.json({ references: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — 새 제목 추가
router.post('/', (req, res) => {
  try {
    const title = (req.body.title || '').trim();
    if (!title) {
      return res.status(400).json({ error: 'empty_title', message: '제목을 입력해 주세요.' });
    }
    const existing = queryOne('SELECT id FROM thumb_title_references WHERE title = ?', [title]);
    if (existing) {
      return res.status(409).json({ error: 'duplicate_title', message: '이미 존재하는 제목입니다.' });
    }
    const maxRow = queryOne('SELECT MAX(number) as maxNum FROM thumb_title_references');
    const nextNumber = (maxRow && maxRow.maxNum ? maxRow.maxNum : 0) + 1;
    const result = runSQL(
      'INSERT INTO thumb_title_references (number, title) VALUES (?, ?)',
      [nextNumber, title]
    );
    const inserted = queryOne('SELECT * FROM thumb_title_references WHERE id = ?', [result.lastId]);
    res.status(201).json(inserted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id — 삭제 후 번호 재정렬
router.delete('/:id', (req, res) => {
  try {
    const row = queryOne('SELECT * FROM thumb_title_references WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '존재하지 않는 항목입니다.' });
    runSQL('DELETE FROM thumb_title_references WHERE id = ?', [req.params.id]);
    const allRows = queryAll('SELECT id FROM thumb_title_references ORDER BY number ASC');
    for (let i = 0; i < allRows.length; i++) {
      runSQL(
        'UPDATE thumb_title_references SET number = ? WHERE id = ?',
        [i + 1, allRows[i].id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
