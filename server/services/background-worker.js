import { queryOne, runSQL } from '../db.js';
import { extractKeywords, categorizeVideo } from './gemini-service.js';

let isRunning = false;
let startTime = null;
let processedCount = 0;
let currentVideoTitle = '';
let workerStatus = 'idle'; // idle | running | waiting | done | error
let stopRequested = false;
let workerTimer = null;

export function getBackgroundStatus() {
    try {
        const totalRow = queryOne('SELECT COUNT(*) as cnt FROM videos');
        const remainingRow = queryOne(
            'SELECT COUNT(*) as cnt FROM videos WHERE is_analyzed = 0 OR is_analyzed IS NULL'
        );
        const total = totalRow?.cnt || 0;
        const remaining = remainingRow?.cnt || 0;
        const analyzed = total - remaining;

        let speed = 0;
        let estimatedMinutes = 0;
        if (startTime && processedCount > 0) {
            const elapsedMin = (Date.now() - startTime) / 60000;
            speed = Math.round((processedCount / elapsedMin) * 10) / 10;
            if (speed > 0) estimatedMinutes = Math.round(remaining / speed);
        }

        return { isRunning, workerStatus, total, analyzed, remaining, processedThisSession: processedCount, currentVideo: currentVideoTitle, speed, estimatedMinutes };
    } catch (e) {
        return { isRunning: false, workerStatus: 'error', total: 0, analyzed: 0, remaining: 0, processedThisSession: 0, currentVideo: '', speed: 0, estimatedMinutes: 0 };
    }
}

async function processNext() {
    if (stopRequested) {
        isRunning = false;
        workerStatus = 'idle';
        console.log('[BG] 워커 중지됨');
        return;
    }

    const video = queryOne(
        'SELECT id, video_id, title, description, tags FROM videos WHERE is_analyzed = 0 OR is_analyzed IS NULL LIMIT 1'
    );

    if (!video) {
        isRunning = false;
        workerStatus = 'done';
        currentVideoTitle = '';
        console.log('[BG] 모든 영상 분석 완료');
        return;
    }

    currentVideoTitle = video.title || '';
    workerStatus = 'running';
    console.log(`[BG] 처리 중: ${video.title}`);

    try {
        const keywords = await extractKeywords(video.title, video.description || '', '');
        runSQL('UPDATE videos SET is_analyzed = 1, transcript_keywords = ? WHERE id = ?',
            [keywords.join(','), video.id]);
        processedCount++;

    } catch (e) {
        console.error(`[BG] 처리 실패 (${video.title}):`, e.message);
        // 무한 루프 방지: 실패해도 analyzed=1로 마킹
        runSQL('UPDATE videos SET is_analyzed = 1 WHERE id = ?', [video.id]);
    }

    // 30초 대기 후 다음 영상 처리
    workerStatus = 'waiting';
    currentVideoTitle = '';
    workerTimer = setTimeout(processNext, 30000);
}

export function startBackgroundWorker() {
    if (isRunning) {
        console.log('[BG] 이미 실행 중');
        return;
    }
    stopRequested = false;
    isRunning = true;
    startTime = Date.now();
    processedCount = 0;
    currentVideoTitle = '';
    workerStatus = 'running';
    console.log('[BG] 백그라운드 워커 시작');
    processNext();
}

export function stopBackgroundWorker() {
    stopRequested = true;
    isRunning = false;
    workerStatus = 'idle';
    if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }
    console.log('[BG] 워커 중지 요청됨');
}
