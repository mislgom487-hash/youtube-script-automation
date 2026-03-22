// 글로벌 에러 핸들러 — 서버 크래시 방지
process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] unhandledRejection:', reason);
});

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { initDB, queryOne, getLastBackup } from './db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __sysdir = path.dirname(fileURLToPath(import.meta.url));
const isElectron = process.env.ELECTRON_MODE === 'true';
const __dbPath = isElectron
    ? path.join(process.env.ELECTRON_USER_DATA, 'data', 'yadam.db')
    : path.join(__sysdir, '..', 'data', 'yadam.db');
import channelsRouter from './routes/channels.js';
import videosRouter from './routes/videos.js';
import youtubeRouter from './routes/youtube.js';
import analysisRouter from './routes/analysis.js';
import ideasRouter from './routes/ideas.js';
import settingsRouter from './routes/settings.js';
import { ensureYadamCategories } from './services/gap-analyzer.js';
import { startBackgroundWorker } from './services/background-worker.js';
import dnaRouter from './routes/dna.js';
import guidelinesRouter from './routes/guidelines.js';
import topicsRouter from './routes/topics.js';
import thumbReferencesRouter from './routes/thumb-references.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 정적 파일 서빙 (프론트엔드)
app.use(express.static(path.join(__sysdir, '..')));
if (process.env.ELECTRON_MODE === 'true') {
    const distPath = path.join(__sysdir, '..', 'dist');
    if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
    }
}

// API routes
app.use('/api/channels', channelsRouter);
app.use('/api/videos', videosRouter);
app.use('/api/youtube', youtubeRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/ideas', ideasRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/dna', dnaRouter);
app.use('/api/guidelines', guidelinesRouter);
app.use('/api/topics', topicsRouter);
app.use('/api/thumb-references', thumbReferencesRouter);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// DB status
app.get('/api/system/db-status', (req, res) => {
    try {
        const stat = fs.statSync(__dbPath);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        const videos = queryOne('SELECT COUNT(*) as cnt FROM videos');
        const channels = queryOne('SELECT COUNT(*) as cnt FROM channels');
        const lastBackup = getLastBackup();
        res.json({
            engine: 'better-sqlite3',
            sizeMB: parseFloat(sizeMB),
            videoCount: videos?.cnt ?? 0,
            channelCount: channels?.cnt ?? 0,
            lastBackup: lastBackup ? lastBackup.filename : null,
            lastBackupTime: lastBackup ? lastBackup.mtime : null,
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Dev: 서버 재시작 (개발용)
app.post('/api/system/restart', (req, res) => {
    res.json({ ok: true, message: '재시작 중...' });
    const execPath = process.execPath;
    const args = process.argv.slice(1);
    const cwd = process.cwd();
    const script = `setTimeout(()=>{require('child_process').spawn(${JSON.stringify(execPath)},${JSON.stringify(args)},{detached:true,stdio:'inherit',env:process.env,cwd:${JSON.stringify(cwd)}}).unref()},2000)`;
    spawn(execPath, ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 300);
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

async function start() {
    try {
        await initDB();
        try { ensureYadamCategories(); console.log('✅ 야담 카테고리 초기화 완료'); } catch (e) { console.error('[CategoryInit]', e.message); }
        // 백그라운드 워커 자동 시작 비활성화 (AI quota 보호 — 수동 시작만 허용)
        // try { startBackgroundWorker(); console.log('✅ 백그라운드 워커 시작'); } catch (e) { console.error('[WorkerInit]', e.message); }
        console.log('⏸ 백그라운드 워커 자동 시작 비활성화 (수동으로 시작하세요)');
        if (process.env.ELECTRON_MODE === 'true') {
            app.get('*', (req, res) => {
                if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not Found' });
                const distIndex = path.join(__sysdir, '..', 'dist', 'index.html');
                if (fs.existsSync(distIndex)) {
                    res.sendFile(distIndex);
                } else {
                    res.status(404).send('Not Found');
                }
            });
        }
        app.listen(PORT, () => {
            console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
            console.log(`📊 API: http://localhost:${PORT}/api/health`);
            if (process.env.ELECTRON_MODE === 'true' && process.send) {
                process.send('ready');
            }
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();
