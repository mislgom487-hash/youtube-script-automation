import { Router } from 'express';
import { queryAll, queryOne, runSQL, getDB, saveDB } from '../db.js';
import { resetClient, suggestMaterials, suggestKeywords } from '../services/gemini-service.js';
import fs, { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

try { mkdirSync('data/uploads', { recursive: true }); } catch(e) {}
const upload = multer({ dest: 'data/uploads/' });

try {
    const { runSQL: _r } = await import('../db.js');
    _r("ALTER TABLE api_keys ADD COLUMN key_file_path TEXT DEFAULT ''");
} catch (e) {}

// GET /api/settings
router.get('/', (req, res) => {
    try {
        const settings = queryAll('SELECT * FROM settings');
        const obj = {};
        for (const s of settings) {
            // Mask API keys for security
            if (s.key.includes('api_key') && s.value) {
                const val = s.value.trim();
                obj[s.key] = val.length > 4 ? '***' + val.substring(val.length - 4) : '***' + val;
                obj[s.key + '_set'] = true;
                if (s.key === 'gemini_api_key' && val.startsWith('AQ')) {
                    obj.is_gemini_vertex_token = true;
                }
            } else {
                obj[s.key] = s.value;
            }
        }
        res.json(obj);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/settings
router.put('/', (req, res) => {
    try {
        const updates = req.body;
        for (const [key, value] of Object.entries(updates)) {
            // Don't update if masked value is sent back
            if (key.includes('api_key') && value.includes('***')) continue;
            runSQL('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
            if (key === 'gemini_api_key') resetClient();
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/settings/apikey — dedicated endpoint for API keys
router.put('/apikey', (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key || !value) return res.status(400).json({ error: 'key와 value를 입력해주세요.' });
        runSQL('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
        if (key === 'gemini_api_key') resetClient();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/settings/api-keys — API키 목록 조회
router.get('/api-keys', (req, res) => {
    try {
        const db = getDB();
        const keys = db.prepare(
            `SELECT id, key_type, key_name, key_value, is_active, created_at, key_file_path FROM api_keys ORDER BY key_type, id`
        ).all();
        const masked = keys.map(k => ({
            ...k,
            key_value_masked: k.key_value
                ? k.key_value.slice(0, 4) + '****' + k.key_value.slice(-4)
                : '',
            key_value_full: k.key_value,
            hasServiceAccount: k.key_file_path ? true : false
        }));
        res.json({ keys: masked });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/api-keys — API키 추가
router.post('/api-keys', upload.single('service_account_file'), (req, res) => {
    try {
        const { key_type, key_name, key_value } = req.body;
        if (!key_type || !key_value) {
            return res.status(400).json({ error: 'key_type과 key_value는 필수입니다.' });
        }

        let keyFilePath = '';
        if (key_type === 'google_project_id' && req.file) {
            const uploadedPath = req.file.path;
            const destDir = path.join(__dirname, '..', 'services');
            const destPath = path.join(destDir, req.file.originalname);
            fs.renameSync(uploadedPath, destPath);
            keyFilePath = destPath;

            try {
                const saJson = JSON.parse(fs.readFileSync(destPath, 'utf8'));
                if (!saJson.project_id || !saJson.private_key) {
                    fs.unlinkSync(destPath);
                    return res.status(400).json({ error: '유효하지 않은 서비스 계정 JSON 파일입니다.' });
                }
            } catch (parseErr) {
                fs.unlinkSync(destPath);
                return res.status(400).json({ error: 'JSON 파일 파싱 실패: ' + parseErr.message });
            }
        }

        const result = runSQL(
            "INSERT INTO api_keys (key_type, key_name, key_value, is_active, key_file_path) VALUES (?, ?, ?, 0, ?)",
            [key_type, key_name || '', key_value, keyFilePath]
        );
        res.json({ success: true, id: result.lastId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/settings/api-keys/:id/activate — API키 활성화 (같은 타입 중 하나만)
router.put('/api-keys/:id/activate', (req, res) => {
    try {
        const db = getDB();
        const key = db.prepare(`SELECT key_type FROM api_keys WHERE id = ?`).get(req.params.id);
        if (!key) return res.status(404).json({ error: '키를 찾을 수 없습니다' });
        // 같은 타입 전부 비활성
        db.prepare(`UPDATE api_keys SET is_active = 0 WHERE key_type = ?`).run(key.key_type);
        // 선택한 키만 활성
        db.prepare(`UPDATE api_keys SET is_active = 1 WHERE id = ?`).run(req.params.id);
        // settings 테이블 동기화 (기존 코드 호환)
        const activeKey = db.prepare(`SELECT key_value FROM api_keys WHERE id = ?`).get(req.params.id);
        db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key.key_type, activeKey.key_value);
        if (key.key_type === 'gemini_api_key') resetClient();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/settings/api-keys/:id — API키 수정
router.put('/api-keys/:id', upload.single('service_account_file'), (req, res) => {
    try {
        const { id } = req.params;
        const { key_name, key_value } = req.body;
        const existing = queryOne("SELECT * FROM api_keys WHERE id = ?", [id]);
        if (!existing) return res.status(404).json({ error: 'not found' });

        let keyFilePath = existing.key_file_path || '';
        if (existing.key_type === 'google_project_id' && req.file) {
            const destDir = path.join(__dirname, '..', 'services');
            const destPath = path.join(destDir, req.file.originalname);
            fs.renameSync(req.file.path, destPath);

            try {
                const saJson = JSON.parse(fs.readFileSync(destPath, 'utf8'));
                if (!saJson.project_id || !saJson.private_key) {
                    fs.unlinkSync(destPath);
                    return res.status(400).json({ error: '유효하지 않은 서비스 계정 JSON 파일입니다.' });
                }
            } catch (parseErr) {
                fs.unlinkSync(destPath);
                return res.status(400).json({ error: 'JSON 파싱 실패' });
            }

            if (keyFilePath && fs.existsSync(keyFilePath)) {
                fs.unlinkSync(keyFilePath);
            }
            keyFilePath = destPath;
        }

        runSQL(
            "UPDATE api_keys SET key_name = ?, key_value = ?, key_file_path = ? WHERE id = ?",
            [key_name || existing.key_name, key_value || existing.key_value, keyFilePath, id]
        );

        if (existing.is_active === 1) {
            runSQL("UPDATE settings SET value = ? WHERE key = ?",
                [key_value || existing.key_value, existing.key_type]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/settings/api-keys/:id — API키 삭제
router.delete('/api-keys/:id', (req, res) => {
    try {
        const db = getDB();
        const key = db.prepare(`SELECT is_active FROM api_keys WHERE id = ?`).get(req.params.id);
        if (key && key.is_active === 1) {
            return res.status(400).json({ error: '사용 중인 키는 삭제할 수 없습니다. 다른 키를 활성화한 후 삭제하세요.' });
        }
        db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/settings/categories — list all categories
router.get('/categories', (req, res) => {
    try {
        const categories = queryAll('SELECT * FROM categories ORDER BY group_name, sort_order');
        const groups = {};
        for (const c of categories) {
            if (!groups[c.group_name]) groups[c.group_name] = [];
            groups[c.group_name].push(c);
        }
        res.json(groups);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/categories — add category
router.post('/categories', (req, res) => {
    try {
        const { group_name, name, color, keywords } = req.body;
        if (!group_name || !name) return res.status(400).json({ error: '그룹명과 카테고리명을 입력해주세요.' });
        const dup = queryOne('SELECT id FROM categories WHERE group_name = ? AND name = ?', [group_name, name]);
        if (dup) return res.status(409).json({ error: '이미 등록된 소재' });
        const { lastId } = runSQL('INSERT INTO categories (group_name, name, color, keywords) VALUES (?, ?, ?, ?)',
            [group_name, name, color || '#7c5cff', keywords || '']);
        const cat = queryOne('SELECT * FROM categories WHERE id = ?', [lastId]);
        res.json(cat);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/settings/categories/:id
router.delete('/categories/:id', (req, res) => {
    try {
        const db = getDB();
        const transaction = db.transaction(() => {
            db.prepare('DELETE FROM video_spike_rankings WHERE category_id = ?').run(req.params.id);
            db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
        });
        transaction();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/settings/categories/:id/keywords — 소재 키워드 업데이트
router.put('/categories/:id/keywords', (req, res) => {
    try {
        const { id } = req.params;
        const { keywords } = req.body;
        if (typeof keywords !== 'string') {
            return res.status(400).json({ error: 'keywords는 문자열' });
        }
        getDB().prepare(`UPDATE categories SET keywords = ? WHERE id = ?`).run(keywords, id);
        res.json({ success: true });
    } catch (err) {
        console.error('[키워드 UPDATE] 오류:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/settings/categories/:id — 소재명 변경
router.put('/categories/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;

        if (!name?.trim()) {
            return res.status(400).json({ error: '소재명을 입력해주세요' });
        }

        const newName = name.trim();
        const db = getDB();

        const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
        if (!cat) {
            return res.status(404).json({ error: '소재를 찾을 수 없습니다' });
        }

        const oldName = cat.name;

        const dup = db.prepare(
            'SELECT id FROM categories WHERE group_name = ? AND name = ? AND id != ?'
        ).get(cat.group_name, newName, id);
        if (dup) {
            return res.status(409).json({ error: '이미 존재하는 소재명입니다' });
        }

        const transaction = db.transaction(() => {
            db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(newName, id);
            db.prepare('UPDATE video_spike_rankings SET category_name = ? WHERE category_id = ?').run(newName, id);
        });
        transaction();

        res.json({ success: true, oldName, newName });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/categories/preset — load a genre preset
router.post('/categories/preset', (req, res) => {
    try {
        const { preset } = req.body;
        const presets = {
            '야담/역사': {
                '사건유형': ['살인/범죄', '괴담/미스터리', '로맨스', '복수극', '풍속/일상', '전쟁', '사기', '기행', '동물'],
            },
            '괴담/호러': {
                '괴현상유형': ['유령/귀신', '저주', '괴물/요괴', '빙의', '초자연현상', '도시전설', 'UFO/외계', '실종'],
                '장소': ['학교', '병원', '폐건물', '산/숲', '아파트', '군대', '도로/터널', '바다', '지하'],
                '시간대': ['심야', '새벽', '황혼', '비오는날', '보름달', '명절'],
                '결말유형': ['열린결말', '반전', '비극', '해결', '실화기반']
            },
            '요리/먹방': {
                '요리종류': ['한식', '중식', '일식', '양식', '디저트', '음료', '퓨전', '길거리음식'],
                '재료': ['육류', '해산물', '채소', '면류', '밥류', '빵/제과'],
                '난이도': ['초간단', '초보', '중급', '고급', '전문가'],
                '콘텐츠유형': ['레시피', '먹방', '맛집탐방', '재료리뷰', '요리팁']
            },
            '교육/지식': {
                '분야': ['과학', '역사', '경제', '심리', '기술', '언어', '예술', '철학'],
                '난이도': ['입문', '초급', '중급', '고급'],
                '포맷': ['강의', '실험', '다큐', '인터뷰', '애니메이션설명']
            },
            '게임': {
                '게임장르': ['RPG', 'FPS', '전략', '시뮬레이션', '레이싱', '격투', '퍼즐', '호러', '스포츠'],
                '콘텐츠유형': ['리뷰', '공략', '실황', 'e스포츠', '모딩', '뉴스'],
                '플랫폼': ['PC', 'PS5', 'Xbox', 'Switch', '모바일']
            }
        };

        const presetData = presets[preset];
        if (!presetData) return res.status(400).json({ error: '알 수 없는 프리셋입니다.', available: Object.keys(presets) });

        // Insert categories
        for (const [groupName, items] of Object.entries(presetData)) {
            items.forEach((name, i) => {
                runSQL('INSERT OR IGNORE INTO categories (group_name, name, sort_order) VALUES (?, ?, ?)', [groupName, name, i]);
            });
        }

        res.json({ success: true, message: `${preset} 프리셋이 적용되었습니다.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/backup
router.post('/backup', async (req, res) => {
    const backupDir = path.resolve('data/backups');
    try { mkdirSync(backupDir, { recursive: true }); } catch(e) {}

    const filename = `yadam_backup_${new Date().toISOString().slice(0, 10)}.db`;
    const backupPath = path.join(backupDir, filename);

    try {
        const db = getDB();
        // better-sqlite3 공식 Online Backup API — 비블로킹, 크기 무관
        await db.backup(backupPath, {
            progress({ totalPages, remainingPages }) {
                const pct = ((totalPages - remainingPages) / totalPages * 100).toFixed(1);
                console.log(`[백업] 진행: ${pct}%`);
                return 200;
            }
        });

        const stat = fs.statSync(backupPath);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', stat.size);

        const stream = fs.createReadStream(backupPath);
        stream.pipe(res);
        stream.on('end', () => {
            try { fs.unlinkSync(backupPath); } catch(e) {}
        });
        stream.on('error', (err) => {
            if (!res.headersSent) res.status(500).json({ error: '다운로드 실패: ' + err.message });
        });
    } catch (err) {
        try { fs.unlinkSync(backupPath); } catch(e) {}
        res.status(500).json({ error: '백업 실패: ' + err.message });
    }
});

// POST /api/settings/restore — restore DB from uploaded file
router.post('/restore', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '파일이 없습니다' });
    }

    const mode = req.body.mode || 'replace';
    const uploadedPath = req.file.path;

    try {
        const Database = (await import('better-sqlite3')).default;

        // 유효한 SQLite DB 파일인지 검증
        let uploadedDb;
        try {
            uploadedDb = new Database(uploadedPath, { readonly: true });
            uploadedDb.prepare('SELECT 1').get();
        } catch (e) {
            try { fs.unlinkSync(uploadedPath); } catch(x) {}
            return res.status(400).json({ error: '유효한 SQLite 데이터베이스 파일이 아닙니다' });
        }

        const dbPath = path.resolve('data/yadam.db');

        if (mode === 'replace') {
            // ━━━ 전체 교체 모드 ━━━
            const safeBackup = dbPath + '.before-restore.' + Date.now();
            fs.copyFileSync(dbPath, safeBackup);

            uploadedDb.close();
            fs.copyFileSync(uploadedPath, dbPath);
            fs.unlinkSync(uploadedPath);

            // WAL, SHM 파일 정리
            try { fs.unlinkSync(dbPath + '-wal'); } catch(e) {}
            try { fs.unlinkSync(dbPath + '-shm'); } catch(e) {}

            res.json({
                success: true,
                mode: 'replace',
                message: '전체 교체 완료. 서버가 2초 후 재시작됩니다.',
                backup: safeBackup
            });

            setTimeout(() => process.exit(0), 2000);

        } else {
            // ━━━ 병합 모드 ━━━
            const currentDb = new Database(dbPath);

            // _backup_ 테이블은 병합 대상에서 제외
            const tables = uploadedDb.prepare(
                `SELECT name FROM sqlite_master
                 WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_backup%'`
            ).all().map(t => t.name);

            let totalAdded = 0;
            const details = {};

            for (const table of tables) {
                const exists = currentDb.prepare(
                    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
                ).get(table);
                if (!exists) continue;

                const columns = uploadedDb.prepare(`PRAGMA table_info("${table}")`).all();
                const colNames = columns.map(c => c.name);

                // 현재 DB 컬럼과 교집합 (스키마 차이 대응)
                const currentCols = currentDb.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
                const commonCols = colNames.filter(c => currentCols.includes(c));
                if (commonCols.length === 0) continue;

                const placeholders = commonCols.map(() => '?').join(',');
                const insertStmt = currentDb.prepare(
                    `INSERT OR IGNORE INTO "${table}" (${commonCols.join(',')}) VALUES (${placeholders})`
                );
                const rows = uploadedDb.prepare(`SELECT ${commonCols.join(',')} FROM "${table}"`).all();

                let added = 0;
                const transaction = currentDb.transaction((rows) => {
                    for (const row of rows) {
                        const vals = commonCols.map(c => row[c]);
                        const result = insertStmt.run(...vals);
                        if (result.changes > 0) added++;
                    }
                });
                transaction(rows);

                if (added > 0) {
                    details[table] = added;
                    totalAdded += added;
                }
            }

            uploadedDb.close();
            currentDb.close();
            fs.unlinkSync(uploadedPath);

            res.json({
                success: true,
                mode: 'merge',
                added: totalAdded,
                details,
                message: `병합 완료 — ${totalAdded}건 추가`
            });
        }
    } catch (err) {
        try { fs.unlinkSync(uploadedPath); } catch (e) {}
        res.status(500).json({ error: '복원 실패: ' + err.message });
    }
});

// POST /api/settings/suggest-materials — Gemini 소재 자동 추천
router.post('/suggest-materials', async (req, res) => {
    try {
        const { categoryName } = req.body;
        if (!categoryName?.trim()) return res.status(400).json({ error: '카테고리명 필요' });
        const materials = await suggestMaterials(categoryName.trim());
        res.json({ materials });
    } catch (e) {
        console.error('[suggest-materials] 에러:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/settings/suggest-keywords — 소재별 키워드 추천
router.post('/suggest-keywords', async (req, res) => {
    try {
        const { categoryName, materialName } = req.body;
        if (!materialName?.trim()) return res.status(400).json({ error: '소재명 필요' });
        const keywords = await suggestKeywords(categoryName?.trim() || '', materialName.trim());
        res.json({ keywords });
    } catch (e) {
        console.error('[suggest-keywords] 에러:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/settings/service-account-guide
router.get('/service-account-guide', (req, res) => {
    res.json({
        title: 'Google Cloud 서비스 계정 JSON 파일 발급 방법',
        steps: [
            '1. Google Cloud Console (console.cloud.google.com) 접속',
            '2. 좌측 메뉴 → IAM 및 관리자 → 서비스 계정 클릭',
            '3. 상단 "+ 서비스 계정 만들기" 클릭',
            '4. 서비스 계정 이름 입력 (예: vertex-ai-access)',
            '5. 역할 선택: Vertex AI 사용자 (roles/aiplatform.user)',
            '6. 완료 클릭',
            '7. 생성된 서비스 계정 클릭 → 키 탭 → 키 추가 → 새 키 만들기',
            '8. JSON 선택 → 만들기 → 파일 다운로드됨',
            '9. 다운로드된 JSON 파일을 여기에 업로드'
        ]
    });
});

export default router;
