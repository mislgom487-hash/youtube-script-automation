import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
// writeFile은 스트림 방식 전환 후 미사용 (generate-short 등 향후 사용 대비 보존)
// import { writeFile } from 'fs/promises';
import multer from 'multer';
import { callGemini } from '../services/gemini-service.js';
import { getDB } from '../db.js';

// === 디버그 로그 ===
const _debugLogPath = process.env.ELECTRON_USER_DATA
  ? path.join(process.env.ELECTRON_USER_DATA, 'gradio-debug.log')
  : path.join(process.cwd(), 'gradio-debug.log');

function dlog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(_debugLogPath, line); } catch (e) {}
  console.log(msg);
}

// 서버 환경 정보 (최초 1회)
dlog('=== TTS 라우터 로드 ===');
dlog(`Node.js: ${process.version}`);
dlog(`ELECTRON_USER_DATA: ${process.env.ELECTRON_USER_DATA || '(없음)'}`);
dlog(`resourcesPath: ${process.resourcesPath || '(없음)'}`);
dlog(`cwd: ${process.cwd()}`);
dlog(`typeof fetch: ${typeof fetch}`);
dlog(`logPath: ${_debugLogPath}`);

const router = Router();

// === 파일 업로드 설정 ===
const uploadDir = path.join(
  process.env.ELECTRON_USER_DATA || path.join(process.cwd(), 'data'),
  'tts-uploads'
);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('지원하지 않는 오디오 형식입니다.'));
  }
});

// === 오디오 저장 경로 ===
function getAudioDir() {
  const baseDir = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), 'data');
  const audioDir = path.join(baseDir, 'tts-audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
  return audioDir;
}

function getSeedAudioDir() {
  const baseDir = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), 'data');
  const seedDir = path.join(baseDir, 'tts-seeds-audio');
  if (!fs.existsSync(seedDir)) fs.mkdirSync(seedDir, { recursive: true });
  return seedDir;
}

// === DB 접근 (lazy import) ===
let _db = null;
async function getDb() {
  if (!_db) {
    _db = getDB();
  }
  return _db;
}

// === DB 마이그레이션: tts_seeds에 audio_filename 컬럼 추가 ===
(async () => {
  try {
    const db = await getDb();
    const cols = db.prepare(
      "PRAGMA table_info(tts_seeds)"
    ).all().map(c => c.name);
    if (!cols.includes('audio_filename')) {
      db.prepare(
        "ALTER TABLE tts_seeds ADD COLUMN audio_filename TEXT"
      ).run();
    }
  } catch (e) {
    console.error('tts_seeds 컬럼 추가 실패:', e.message);
  }
})();

// === 상태 문자열 파싱 ===
function parseStatus(statusText) {
  const result = { duration: 0, seed: -1 };
  if (!statusText || typeof statusText !== 'string') return result;
  const durMatch = statusText.match(/Generated\s+([\d.]+)s/);
  if (durMatch) result.duration = parseFloat(durMatch[1]);
  const seedMatch = statusText.match(/Seed:\s*(\d+)/);
  if (seedMatch) result.seed = parseInt(seedMatch[1], 10);
  return result;
}

// === Resume 세션 관리 ===
function computeResumeHash({ text, mode, speaker, voiceDescription, language }) {
  const data = JSON.stringify({
    text: text.trim(), mode,
    speaker: speaker || '', voiceDescription: voiceDescription || '', language
  });
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

function loadResumeSession(tempDir, expectedHash, expectedTotal) {
  const metaPath = path.join(tempDir, 'metadata.json');
  if (!fs.existsSync(tempDir) || !fs.existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.hash !== expectedHash || meta.totalSegments !== expectedTotal) return null;
    const count = fs.readdirSync(tempDir).filter(f => /^part\d+\.wav$/.test(f)).length;
    return { meta, completedCount: count };
  } catch (e) { return null; }
}

// === 타임스탬프 파일명 생성 ===
function generateFilename(prefix) {
  const now = new Date();
  const ts = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0') + '_' +
    String(now.getMilliseconds()).padStart(3, '0');
  return `${prefix}_${ts}.wav`;
}

// ============================================
// Gradio HTTP API 헬퍼
// ============================================

async function gradioCall(serverUrl, apiName, dataArray) {
  // URL 후보: gradio_api/call 우선, 실패 시 /call fallback
  const postUrls = [
    `${serverUrl}/gradio_api/call/${apiName}`,
    `${serverUrl}/call/${apiName}`
  ];
  const postBody = JSON.stringify({ data: dataArray });

  dlog(`[gradioCall] POST body: ${postBody.substring(0, 500)}`);

  let postRes;
  let postUrl;
  for (const url of postUrls) {
    dlog(`[gradioCall] POST 시도 URL: ${url}`);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody,
        signal: AbortSignal.timeout(60000)
      });
      dlog(`[gradioCall] POST 응답 status: ${r.status}`);
      if (r.ok) {
        postRes = r;
        postUrl = url;
        break;
      }
      const body = await r.text().catch(() => '');
      dlog(`[gradioCall] POST 응답 body: ${body.substring(0, 300)}`);
    } catch (fetchErr) {
      dlog(`[gradioCall] POST fetch 실패 (${url}): ${fetchErr.message}`);
    }
  }

  if (!postRes) {
    throw new Error(`Gradio 요청 실패: 모든 URL 시도 실패`);
  }

  dlog(`[gradioCall] POST 성공 URL: ${postUrl}`);
  const postJson = await postRes.json();
  const { event_id } = postJson;

  // (c) event_id
  dlog(`[gradioCall] event_id: ${event_id}`);

  // SSE URL: postUrl 기반으로 결정
  const sseUrl = postUrl.replace(`/call/${apiName}`, `/call/${apiName}/${event_id}`);

  // (d) SSE GET 요청 직전
  dlog(`[gradioCall] SSE GET URL: ${sseUrl}`);

  let sseRes;
  try {
    sseRes = await fetch(sseUrl, {
      signal: AbortSignal.timeout(300000)
    });
  } catch (sseErr) {
    dlog(`[gradioCall] SSE fetch 실패: ${sseErr.message}\n${sseErr.stack}`);
    throw sseErr;
  }

  dlog(`[gradioCall] SSE 응답 status: ${sseRes.status}`);
  if (!sseRes.ok) {
    throw new Error(`Gradio SSE 실패: HTTP ${sseRes.status}`);
  }

  // (e) SSE 스트림 수신
  let rawText;
  try {
    rawText = await sseRes.text();
  } catch (textErr) {
    dlog(`[gradioCall] SSE text() 실패: ${textErr.message}`);
    throw textErr;
  }
  dlog(`[gradioCall] SSE 전체 응답 길이: ${rawText.length}자`);

  const lines = rawText.split('\n');
  let lastEvent = '';
  for (const line of lines) {
    dlog(`[SSE RAW] ${JSON.stringify(line)}`);
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      lastEvent = trimmed.slice(6).trim();
      dlog(`[SSE EVENT] ${lastEvent}`);
    } else if (trimmed.startsWith('data:') && lastEvent === 'error') {
      const errStr = trimmed.slice(5).trim();
      dlog(`[SSE DATA RAW error] ${errStr}`);
      try {
        const errData = JSON.parse(errStr);
        throw new Error(Array.isArray(errData) ? errData[0] : JSON.stringify(errData));
      } catch (e) {
        if (e.message.includes('Gradio') || lastEvent === 'error') throw e;
        throw new Error(errStr);
      }
    } else if (trimmed.startsWith('data:') && lastEvent === 'complete') {
      const dataStr = trimmed.slice(5).trim();
      dlog(`[SSE DATA RAW complete] ${dataStr.substring(0, 300)}`);
      // (g) 반환 직전
      try {
        const parsed = JSON.parse(dataStr);
        dlog(`[gradioCall] 반환 데이터 타입: ${typeof parsed}, isArray: ${Array.isArray(parsed)}`);
        return parsed;
      } catch (parseErr) {
        dlog(`[gradioCall] JSON.parse 실패: ${parseErr.message}`);
        dlog(`[gradioCall] 파싱 실패 원본(200자): ${dataStr.substring(0, 200)}`);
        throw parseErr;
      }
    }
  }
  dlog('[gradioCall] complete 이벤트 없음 — 전체 SSE 덤프:');
  dlog(rawText.substring(0, 1000));
  throw new Error('Gradio 응답에서 complete 이벤트를 찾을 수 없습니다.');
}

async function gradioUpload(serverUrl, filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const blob = new Blob([fileBuffer]);
  const formData = new FormData();
  formData.append('files', blob, filename);

  const res = await fetch(`${serverUrl}/gradio_api/upload`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    throw new Error(`파일 업로드 실패: HTTP ${res.status}`);
  }
  const paths = await res.json();
  return paths[0];
}

function gradioFileUrl(serverUrl, filePath) {
  return `${serverUrl}/gradio_api/file=${filePath}`;
}

// ============================================
// 기존 엔드포인트 (1단계에서 생성)
// ============================================

// GET /connection-test
router.get('/connection-test', async (req, res) => {
  const serverUrl = req.query.url || 'http://127.0.0.1:7860';
  const endpoints = ['/gradio_api/info', '/api/config', '/'];
  let connected = false;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${serverUrl}${endpoint}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        connected = true;
        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (connected) {
    res.json({ success: true, message: 'Qwen3-TTS 연결 성공' });
  } else {
    res.json({ success: false, message: '서버가 응답하지 않습니다.' });
  }
});

// GET /model-status
router.get('/model-status', async (req, res) => {
  const serverUrl = req.query.url || 'http://127.0.0.1:7860';
  try {
    const result = await gradioCall(serverUrl, 'get_loaded_models_status', []);
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// GET /audio-files
router.get('/audio-files', (req, res) => {
  try {
    const audioDir = getAudioDir();
    const files = fs.readdirSync(audioDir)
      .filter(f => f.endsWith('.wav'))
      .map(f => {
        const stat = fs.statSync(path.join(audioDir, f));
        return { filename: f, size: stat.size, created: stat.birthtime };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ success: true, files });
  } catch (e) {
    res.json({ success: true, files: [] });
  }
});

// DELETE /audio-files/:filename
router.delete('/audio-files/:filename', (req, res) => {
  try {
    const filePath = path.join(getAudioDir(), req.params.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '파일을 찾을 수 없습니다.' });
    }
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// GET /audio-files/search
router.get('/audio-files/search', (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    const audioDir = getAudioDir();
    const files = fs.readdirSync(audioDir)
      .filter(f => f.endsWith('.wav') && f.toLowerCase().includes(q))
      .map(f => {
        const stat = fs.statSync(path.join(audioDir, f));
        return { filename: f, size: stat.size, created: stat.birthtime };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ success: true, files });
  } catch (e) {
    res.json({ success: true, files: [] });
  }
});

// ============================================
// 새 엔드포인트: Custom Voice 생성
// ============================================

router.post('/generate-custom', async (req, res) => {
  // (a) req.body 수신
  dlog(`[generate-custom] req.body: ${JSON.stringify(req.body).substring(0, 300)}`);

  const {
    text,
    language = 'Korean',
    speaker = 'Sohee',
    instruct = '',
    modelSize = '1.7B',
    seed = -1,
    serverUrl = 'http://127.0.0.1:7860'
  } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ success: false, message: '텍스트를 입력해주세요.' });
  }

  // (b) gradioCall 호출 직전
  const callArgs = [text.trim(), language, speaker, instruct, modelSize, parseInt(seed, 10)];
  dlog(`[generate-custom] gradioCall 인자: ${JSON.stringify(callArgs).substring(0, 300)}`);

  try {
    const result = await gradioCall(serverUrl, 'generate_custom_voice', callArgs);

    // (c) 반환값
    dlog(`[generate-custom] gradioCall 반환: ${JSON.stringify(result).substring(0, 300)}`);

    const audioInfo = result[0];
    const statusText = result[1] || '';
    const parsed = parseStatus(statusText);

    if (!audioInfo || !audioInfo.path) {
      return res.status(500).json({ success: false, message: '음성 생성에 실패했습니다.' });
    }

    const audioResponse = await fetch(gradioFileUrl(serverUrl, audioInfo.path));
    if (!audioResponse.ok) {
      return res.status(500).json({ success: false, message: '오디오 파일 다운로드에 실패했습니다.' });
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    const filename = generateFilename('custom');
    const filePath = path.join(getAudioDir(), filename);
    fs.writeFileSync(filePath, audioBuffer);

    try {
      const db = await getDb();
      db.prepare(`
        INSERT INTO tts_history (filename, original_text, voice_type, speaker, language, seed, model_size, duration_seconds, file_size)
        VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?)
      `).run(
        filename,
        text.trim().substring(0, 500),
        speaker,
        language,
        parsed.seed,
        modelSize,
        parsed.duration,
        audioBuffer.length
      );
    } catch (dbErr) {
      console.error('TTS history DB error:', dbErr.message);
    }

    res.json({
      success: true,
      filename,
      seed: parsed.seed,
      duration: parsed.duration,
      fileSize: audioBuffer.length,
      status: statusText
    });

  } catch (e) {
    dlog(`[generate-custom] catch error.message: ${e.message}`);
    dlog(`[generate-custom] catch error.stack: ${e.stack}`);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================
// 대사 단건 미리듣기 생성 (대사별 스타일 지시 테스트용)
router.post('/generate-short', async (req, res) => {
  const {
    text,
    language = 'Korean',
    speaker = 'Sohee',
    instruct = '',
    modelSize = '1.7B',
    seed = -1,
    serverUrl = 'http://127.0.0.1:7860'
  } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ success: false, message: '텍스트를 입력해주세요.' });
  }

  try {
    const callArgs = [text.trim(), language, speaker, instruct, modelSize, parseInt(seed, 10)];
    const result = await gradioCall(serverUrl, 'generate_custom_voice', callArgs);

    const audioInfo = result[0];
    const statusText = result[1] || '';
    const parsed = parseStatus(statusText);

    if (!audioInfo || !audioInfo.path) {
      return res.status(500).json({ success: false, message: '음성 생성에 실패했습니다.' });
    }

    const audioResponse = await fetch(gradioFileUrl(serverUrl, audioInfo.path));
    if (!audioResponse.ok) {
      return res.status(500).json({ success: false, message: '오디오 파일 다운로드에 실패했습니다.' });
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    const filename = generateFilename('short');
    const filePath = path.join(getAudioDir(), filename);
    fs.writeFileSync(filePath, audioBuffer);

    res.json({
      success: true,
      filename,
      seed: parsed.seed,
      duration: parsed.duration
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================
// Voice Clone 생성
// ============================================

router.post('/generate-clone', upload.single('refAudio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: '참조 음성 파일을 업로드해주세요.' });
  }

  const {
    refText = '',
    targetText,
    language = 'Korean',
    useXvectorOnly = 'false',
    modelSize = '1.7B',
    maxChunkChars = '200',
    chunkGap = '0',
    seed = '-1',
    serverUrl = 'http://127.0.0.1:7860'
  } = req.body;

  if (!targetText || targetText.trim().length === 0) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, message: '대본 텍스트를 입력해주세요.' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase() || '.wav';
  const renamedPath = req.file.path + ext;
  fs.renameSync(req.file.path, renamedPath);

  try {
    const uploadedPath = await gradioUpload(serverUrl, renamedPath);

    const result = await gradioCall(serverUrl, 'generate_voice_clone', [
      { path: uploadedPath },
      refText.trim(),
      targetText.trim(),
      language,
      useXvectorOnly === 'true',
      modelSize,
      parseFloat(maxChunkChars),
      parseFloat(chunkGap),
      parseInt(seed, 10)
    ]);

    const audioInfo = result[0];
    const statusText = result[1] || '';
    const parsed = parseStatus(statusText);

    if (!audioInfo || !audioInfo.path) {
      fs.unlinkSync(renamedPath);
      return res.status(500).json({ success: false, message: '음성 생성에 실패했습니다.' });
    }

    const audioResponse = await fetch(gradioFileUrl(serverUrl, audioInfo.path));
    if (!audioResponse.ok) {
      fs.unlinkSync(renamedPath);
      return res.status(500).json({ success: false, message: '오디오 파일 다운로드에 실패했습니다.' });
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    const filename = generateFilename('clone');
    const filePath = path.join(getAudioDir(), filename);
    fs.writeFileSync(filePath, audioBuffer);

    try { fs.unlinkSync(renamedPath); } catch (e) {}

    try {
      const db = await getDb();
      db.prepare(`
        INSERT INTO tts_history (filename, original_text, voice_type, speaker, language, seed, model_size, duration_seconds, file_size)
        VALUES (?, ?, 'clone', ?, ?, ?, ?, ?, ?)
      `).run(
        filename,
        targetText.trim().substring(0, 500),
        req.file.originalname,
        language,
        parsed.seed,
        modelSize,
        parsed.duration,
        audioBuffer.length
      );
    } catch (dbErr) {
      console.error('TTS history DB error:', dbErr.message);
    }

    res.json({
      success: true,
      filename,
      seed: parsed.seed,
      duration: parsed.duration,
      fileSize: audioBuffer.length,
      status: statusText
    });

  } catch (e) {
    try { fs.unlinkSync(renamedPath); } catch (cleanErr) {}
    console.error('TTS generate-clone error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================
// Whisper 음성 전사
// ============================================

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: '오디오 파일을 업로드해주세요.' });
  }

  const { serverUrl = 'http://127.0.0.1:7860' } = req.body;

  const ext = path.extname(req.file.originalname).toLowerCase() || '.wav';
  const renamedPath = req.file.path + ext;
  fs.renameSync(req.file.path, renamedPath);

  try {
    const uploadedPath = await gradioUpload(serverUrl, renamedPath);

    const result = await gradioCall(serverUrl, 'transcribe_audio', [
      { path: uploadedPath }
    ]);

    const transcribedText = result[0] || '';

    try { fs.unlinkSync(renamedPath); } catch (e) {}

    res.json({
      success: true,
      text: transcribedText
    });

  } catch (e) {
    try { fs.unlinkSync(renamedPath); } catch (cleanErr) {}
    console.error('TTS transcribe error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================
// Voice Design 생성
// ============================================

router.post('/generate-design', async (req, res) => {
  const {
    text,
    language = 'Korean',
    voiceDescription = '',
    seed = -1,
    serverUrl = 'http://127.0.0.1:7860'
  } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ success: false, message: '텍스트를 입력해주세요.' });
  }

  if (!voiceDescription || voiceDescription.trim().length === 0) {
    return res.status(400).json({ success: false, message: '음성 설명을 입력해주세요.' });
  }

  try {
    const result = await gradioCall(serverUrl, 'generate_voice_design', [
      text.trim(), language, voiceDescription.trim(), parseInt(seed, 10)
    ]);

    const audioInfo = result[0];
    const statusText = result[1] || '';
    const parsed = parseStatus(statusText);

    if (!audioInfo || !audioInfo.path) {
      return res.status(500).json({ success: false, message: '음성 생성에 실패했습니다.' });
    }

    const audioResponse = await fetch(gradioFileUrl(serverUrl, audioInfo.path));
    if (!audioResponse.ok) {
      return res.status(500).json({ success: false, message: '오디오 파일 다운로드에 실패했습니다.' });
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    const filename = generateFilename('design');
    const filePath = path.join(getAudioDir(), filename);
    fs.writeFileSync(filePath, audioBuffer);

    try {
      const db = await getDb();
      db.prepare(`
        INSERT INTO tts_history (filename, original_text, voice_type, speaker, voice_description, language, seed, model_size, duration_seconds, file_size)
        VALUES (?, ?, 'design', NULL, ?, ?, ?, '1.7B', ?, ?)
      `).run(
        filename,
        text.trim().substring(0, 500),
        voiceDescription.trim().substring(0, 500),
        language,
        parsed.seed,
        parsed.duration,
        audioBuffer.length
      );
    } catch (dbErr) {
      console.error('TTS history DB error:', dbErr.message);
    }

    res.json({
      success: true,
      filename,
      seed: parsed.seed,
      duration: parsed.duration,
      fileSize: audioBuffer.length,
      status: statusText
    });

  } catch (e) {
    console.error('TTS generate-design error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================
// 텍스트 분할 유틸
// ============================================

function splitText(text, maxLen = 400) {
  const sentences = [];
  const regex = /[^.!?。\n]+[.!?。\n]?/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const s = match[0].trim();
    if (s.length > 0) sentences.push(s);
  }

  if (sentences.length === 0) {
    const chunks = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.substring(i, i + maxLen));
    }
    return chunks;
  }

  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if (current.length + s.length + 1 > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += (current.length > 0 ? ' ' : '') + s;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());

  return chunks;
}

function createSilenceBuffer(durationSec) {
  const sampleRate = 24000;
  const channels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.round(sampleRate * durationSec);
  const dataSize = numSamples * channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize, 0);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buf.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function extractPcmData(wavBuffer) {
  let offset = 12;
  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return wavBuffer.subarray(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize;
  }
  return wavBuffer.subarray(44);
}

function mergeWavBuffers(wavBuffers, silenceDuration) {
  const sampleRate = 24000;
  const channels = 1;
  const bitsPerSample = 16;

  const pcmParts = [];
  const silenceSamples = Math.round(sampleRate * silenceDuration);
  const silencePcm = Buffer.alloc(silenceSamples * channels * (bitsPerSample / 8), 0);

  for (let i = 0; i < wavBuffers.length; i++) {
    pcmParts.push(extractPcmData(wavBuffers[i]));
    if (i < wavBuffers.length - 1 && silenceDuration > 0) {
      pcmParts.push(silencePcm);
    }
  }

  const totalPcm = Buffer.concat(pcmParts);
  const dataSize = totalPcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, totalPcm]);
}

// ============================================
// 다중 화자 분석 (Gemini)
// ============================================

router.post('/analyze-speakers', async (req, res) => {
  const { text, apiType = null } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ success: false, message: '텍스트를 입력해주세요.' });
  }

  // ─── 1단계: 코드에서 대사/나레이션 분리 ───

  function splitDialogueAndNarration(rawText) {
    const segs = [];
    const regex = /(["\u201C\u201D])((?:[^"\u201C\u201D\\]|\\.)*)\1/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(rawText)) !== null) {
      const beforeText = rawText.substring(lastIndex, match.index).trim();
      if (beforeText) {
        segs.push({ type: 'narration', speaker: '나레이터', text: beforeText, context: '' });
      }
      const dialogueText = match[2].trim();
      if (dialogueText) {
        const contextStart = Math.max(0, match.index - 100);
        const context = rawText.substring(contextStart, match.index).trim();
        segs.push({ type: 'dialogue', speaker: '', text: dialogueText, context });
      }
      lastIndex = match.index + match[0].length;
    }

    const remaining = rawText.substring(lastIndex).trim();
    if (remaining) {
      segs.push({ type: 'narration', speaker: '나레이터', text: remaining, context: '' });
    }
    return segs;
  }

  // ─── 2단계: 대사만 추출하여 Gemini에게 화자 판별 요청 ───

  const allSegments = splitDialogueAndNarration(text);
  const dialogues = allSegments
    .map((seg, idx) => ({ ...seg, index: idx }))
    .filter(seg => seg.type === 'dialogue');

  if (dialogues.length === 0) {
    return res.json({
      success: true,
      speakers: ['나레이터'],
      segments: allSegments.map(seg => ({ type: seg.type, speaker: '나레이터', text: seg.text })),
      totalSegments: allSegments.length
    });
  }

  const dialogueList = dialogues.map((d, i) =>
    `[대사 ${i + 1}]\n문맥: ...${d.context}\n대사: "${d.text}"`
  ).join('\n\n');

  const prompt = `당신은 한국어 소설/대본의 화자 판별 전문가입니다.

아래 대사 목록의 각 대사를 누가 말했는지 판별하세요.
"문맥"은 대사 직전의 나레이션으로, 화자 단서가 포함되어 있습니다.

규칙:
1. 문맥에서 화자 이름이나 지칭을 찾아 판별하세요.
2. 같은 인물의 이름은 통일하세요 (예: "선비" → 첫 등장 시 이름 확정).
3. 화자를 알 수 없으면 "미확인"으로 표시하세요.
4. 반드시 아래 JSON 형식으로만 응답하세요.

{
  "speakers": ["도윤", "봉녀", ...],
  "dialogues": [
    { "index": 1, "speaker": "도윤" },
    { "index": 2, "speaker": "봉녀" },
    ...
  ]
}

대사 수: ${dialogues.length}개

${dialogueList}`;

  try {
    const geminiApiType = apiType === 'vertex_ai' ? 'vertex_ai' : apiType === 'ai_studio' ? 'ai_studio' : null;

    const result = await callGemini(prompt, {
      jsonMode: false,
      maxTokens: 65536,
      temperature: 0.1
    }, geminiApiType);

    // ─── 3단계: 응답 파싱 및 세그먼트 조합 ───

    let parsed;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('JSON not found');
      }
    } catch (parseErr) {
      return res.status(500).json({
        success: false,
        message: 'Gemini 응답을 파싱할 수 없습니다.',
        raw: result.substring(0, 1000)
      });
    }

    if (!parsed.speakers || !parsed.dialogues) {
      return res.status(500).json({
        success: false,
        message: '응답 형식이 올바르지 않습니다.',
        raw: result.substring(0, 1000)
      });
    }

    // Gemini 응답을 원래 세그먼트에 매핑
    const speakerMapByIndex = {};
    parsed.dialogues.forEach(d => {
      speakerMapByIndex[d.index] = d.speaker;
    });
    dialogues.forEach((d, i) => {
      allSegments[d.index].speaker = speakerMapByIndex[i + 1] || '미확인';
    });

    // 최종 speakers 목록 (나레이터 포함)
    const allSpeakers = ['나레이터', ...parsed.speakers.filter(s => s !== '나레이터')];

    // 인접한 나레이션 병합
    const mergedSegments = [];
    allSegments.forEach(seg => {
      const last = mergedSegments[mergedSegments.length - 1];
      if (last && last.type === 'narration' && seg.type === 'narration' && last.speaker === seg.speaker) {
        last.text += '\n' + seg.text;
      } else {
        mergedSegments.push({ type: seg.type, speaker: seg.speaker, text: seg.text });
      }
    });

    res.json({
      success: true,
      speakers: allSpeakers,
      segments: mergedSegments,
      totalSegments: mergedSegments.length
    });

  } catch (e) {
    console.error('TTS analyze-speakers error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================
// 긴 대본 생성 (SSE 실시간 진행)
// ============================================

router.post('/generate-long', async (req, res) => {
  const {
    text,
    language = 'Korean',
    mode = 'custom',
    speaker = 'Sohee',
    instruct = '',
    voiceDescription = '',
    modelSize = '1.7B',
    seed = -1,
    silenceDuration = 0.5,
    serverUrl = 'http://127.0.0.1:7860',
    multiSpeaker = false,
    segments = [],
    speakerMap = {},
    forceNew = false
  } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ success: false, message: '텍스트를 입력해주세요.' });
  }

  req.setTimeout(0);
  res.setTimeout(0);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  function sendEvent(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  let tempPcmPath = null;
  let tempSegDir = null;
  let completedSegments = 0;
  try {
    let processSegments;

    if (multiSpeaker && segments.length > 0) {
      // 다중화자: 세그먼트별로도 200자 초과 시 재분할 (OOM 방지)
      processSegments = segments.flatMap(seg => {
        const subChunks = splitText(seg.text, 200);
        return subChunks.map(chunk => ({
          text: chunk,
          speaker: speakerMap[seg.speaker] || speaker,
          originalSpeaker: seg.speaker,
          instruct: seg.instruct || ''
        }));
      });
    } else {
      const chunks = splitText(text.trim(), 200);
      processSegments = chunks.map(chunk => ({
        text: chunk,
        speaker: speaker,
        originalSpeaker: null
      }));
    }

    const totalChunks = processSegments.length;

    // === 오디오 포맷 상수 ===
    const sampleRate = 24000;
    const channels = 1;
    const bitsPerSample = 16;
    const silenceDurationSec = parseFloat(silenceDuration) || 0;
    const silenceBytesPerSec = sampleRate * channels * (bitsPerSample / 8);
    const silenceByteCount = Math.round(silenceDurationSec * silenceBytesPerSec);

    // === Resume 세션 확인 ===
    const resumeHash = computeResumeHash({ text, mode, speaker, voiceDescription, language });
    tempSegDir = path.join(getAudioDir(), `resume_${resumeHash}`);

    if (forceNew && fs.existsSync(tempSegDir)) {
      fs.rmSync(tempSegDir, { recursive: true, force: true });
    }

    const existingSession = loadResumeSession(tempSegDir, resumeHash, totalChunks);
    let resumeFrom = 0;
    if (existingSession) {
      resumeFrom = Math.min(existingSession.completedCount, totalChunks);
      completedSegments = resumeFrom;
    }

    fs.mkdirSync(tempSegDir, { recursive: true });

    if (!existingSession) {
      fs.writeFileSync(path.join(tempSegDir, 'metadata.json'), JSON.stringify({
        hash: resumeHash, totalSegments: totalChunks, splitSize: 200,
        mode, speaker: speaker || '', voiceDescription: voiceDescription || '',
        language, seed: parseInt(seed, 10), silenceDuration: parseFloat(silenceDuration) || 0,
        instruct: instruct || '', modelSize, createdAt: new Date().toISOString()
      }, null, 2));
    }

    const filename = generateFilename(mode === 'design' ? 'design_long' : 'custom_long');
    const finalPath = path.join(getAudioDir(), filename);
    tempPcmPath = finalPath + '.pcm.tmp';
    const pcmStream = fs.createWriteStream(tempPcmPath);
    let totalPcmBytes = 0;
    let lastSeed = parseInt(seed, 10);
    let totalDuration = 0;

    // === 이어서 생성: 완료된 세그먼트 PCM 스트림 재기록 ===
    if (resumeFrom > 0) {
      sendEvent({
        type: 'resume', resumeFrom, totalChunks,
        percent: Math.round((resumeFrom / totalChunks) * 90),
        message: `${resumeFrom}개 세그먼트가 이미 완료되어 있습니다. ${resumeFrom + 1}번부터 이어서 생성합니다.`
      });
      sendEvent({ type: 'progress', current: resumeFrom, totalChunks, percent: 0, message: `이전 ${resumeFrom}개 세그먼트 불러오는 중...` });

      for (let ri = 0; ri < resumeFrom; ri++) {
        const partPath = path.join(tempSegDir, `part${String(ri + 1).padStart(3, '0')}.wav`);
        if (!fs.existsSync(partPath)) { resumeFrom = ri; completedSegments = ri; break; }
        const wavBuf = fs.readFileSync(partPath);
        const pcm = extractPcmData(wavBuf);
        pcmStream.write(pcm);
        totalPcmBytes += pcm.length;
        if (ri < totalChunks - 1 && silenceByteCount > 0) {
          pcmStream.write(Buffer.alloc(silenceByteCount, 0));
          totalPcmBytes += silenceByteCount;
        }
        totalDuration += pcm.length / (sampleRate * channels * (bitsPerSample / 8));
      }
    }

    sendEvent({ type: 'start', totalChunks, resumeFrom, message: resumeFrom > 0
      ? `${resumeFrom}/${totalChunks} 이어서 생성 시작`
      : `${totalChunks}개 파트로 분할 완료` });

    for (let i = resumeFrom; i < totalChunks; i++) {
      const seg = processSegments[i];
      console.log(`[TTS] segment ${i + 1}/${totalChunks}: ${seg.text.length}자 [${seg.originalSpeaker || '단일화자'}]`);
      const speakerLabel = seg.originalSpeaker ? ` [${seg.originalSpeaker}]` : '';

      sendEvent({
        type: 'progress',
        current: i + 1,
        totalChunks,
        percent: Math.round((i / totalChunks) * 90),
        message: `${i + 1}/${totalChunks} 파트 생성 중...${speakerLabel}`
      });

      let result;
      let retries = 0;
      const maxRetries = 2;

      while (true) {
        try {
          if (mode === 'design') {
            result = await gradioCall(serverUrl, 'generate_voice_design', [
              seg.text, language, voiceDescription, lastSeed
            ]);
          } else {
            const segInstruct = seg.instruct || instruct || '';
            result = await gradioCall(serverUrl, 'generate_custom_voice', [
              seg.text, language, seg.speaker, segInstruct, modelSize, lastSeed
            ]);
          }
          break;
        } catch (predictErr) {
          retries++;
          if (retries > maxRetries) throw predictErr;
          sendEvent({
            type: 'progress',
            current: i + 1,
            totalChunks,
            percent: Math.round((i / totalChunks) * 90),
            message: `${i + 1}/${totalChunks} 파트 재시도 중... (${retries}/${maxRetries})`
          });
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      const audioInfo = result[0];
      const statusText = result[1] || '';
      const parsed = parseStatus(statusText);
      if (i === 0 && parsed.seed > 0) lastSeed = parsed.seed;
      totalDuration += parsed.duration || 0;

      if (!audioInfo || !audioInfo.path) {
        pcmStream.destroy();
        fs.unlink(tempPcmPath, () => {});
        sendEvent({ type: 'error', message: `파트 ${i + 1} 생성 실패`, completedSegments, tempSegDir, savedMessage: completedSegments > 0 ? `${completedSegments}개 세그먼트가 저장되어 있습니다 (${tempSegDir})` : null });
        res.end();
        return;
      }

      const audioResponse = await fetch(gradioFileUrl(serverUrl, audioInfo.path));
      if (!audioResponse.ok) {
        pcmStream.destroy();
        fs.unlink(tempPcmPath, () => {});
        sendEvent({ type: 'error', message: `파트 ${i + 1} 다운로드 실패`, completedSegments, tempSegDir, savedMessage: completedSegments > 0 ? `${completedSegments}개 세그먼트가 저장되어 있습니다 (${tempSegDir})` : null });
        res.end();
        return;
      }

      const wavBuffer = Buffer.from(await audioResponse.arrayBuffer());

      // 세그먼트별 개별 WAV 저장 (중간 저장 — 오류 시 복구용)
      const partFile = path.join(tempSegDir, `part${String(i + 1).padStart(3, '0')}.wav`);
      fs.writeFileSync(partFile, wavBuffer);
      completedSegments++;

      const pcm = extractPcmData(wavBuffer);
      pcmStream.write(pcm);
      totalPcmBytes += pcm.length;

      if (i < totalChunks - 1 && silenceByteCount > 0) {
        const silence = Buffer.alloc(silenceByteCount, 0);
        pcmStream.write(silence);
        totalPcmBytes += silenceByteCount;
      }

      sendEvent({
        type: 'progress',
        current: i + 1,
        totalChunks,
        percent: Math.round(((i + 1) / totalChunks) * 90),
        message: `${i + 1}/${totalChunks} 파트 완료`
      });
    }

    // pcmStream 닫기
    await new Promise((resolve, reject) => {
      pcmStream.end(() => resolve());
      pcmStream.on('error', reject);
    });

    sendEvent({ type: 'progress', current: totalChunks, totalChunks, percent: 92, message: '오디오 파일 생성 중...' });

    // WAV 헤더(44바이트) 생성 후 PCM 임시 파일과 합쳐 최종 WAV 생성
    const wavHeader = Buffer.alloc(44);
    const dataSize = totalPcmBytes;
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + dataSize, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(channels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
    wavHeader.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(dataSize, 40);

    const finalStream = fs.createWriteStream(finalPath);
    finalStream.write(wavHeader);
    const pcmReadStream = fs.createReadStream(tempPcmPath);
    await new Promise((resolve, reject) => {
      pcmReadStream.pipe(finalStream, { end: true });
      finalStream.on('finish', resolve);
      finalStream.on('error', reject);
    });

    fs.unlink(tempPcmPath, () => {});
    // 정상 완료 — 개별 세그먼트 temp 폴더 삭제
    try { fs.rmSync(tempSegDir, { recursive: true, force: true }); } catch (e2) {}
    tempSegDir = null;

    sendEvent({ type: 'progress', current: totalChunks, totalChunks, percent: 96, message: '파일 저장 완료' });

    const finalFileSize = 44 + totalPcmBytes;
    const calcDuration = totalPcmBytes / (sampleRate * channels * (bitsPerSample / 8));
    const reportDuration = totalDuration > 0 ? totalDuration : calcDuration;

    try {
      const db = await getDb();
      db.prepare(`
        INSERT INTO tts_history (filename, original_text, voice_type, speaker, voice_description, language, seed, model_size, duration_seconds, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        filename,
        text.trim().substring(0, 500),
        mode,
        mode === 'custom' ? speaker : null,
        mode === 'design' ? voiceDescription.substring(0, 500) : null,
        language,
        lastSeed,
        modelSize,
        reportDuration,
        finalFileSize
      );
    } catch (dbErr) {
      console.error('TTS history DB error:', dbErr.message);
    }

    sendEvent({ type: 'progress', current: totalChunks, totalChunks, percent: 98, message: 'DB 저장 완료, 마무리 중...' });

    sendEvent({
      type: 'complete',
      filename,
      seed: lastSeed,
      duration: reportDuration,
      fileSize: finalFileSize,
      totalChunks,
      message: '생성 완료!'
    });

  } catch (e) {
    if (tempPcmPath) { try { fs.unlinkSync(tempPcmPath); } catch (e2) {} }
    console.error('TTS generate-long error:', e.message);
    // tempSegDir은 삭제하지 않음 — 완료된 세그먼트 보존
    const savedMessage = (tempSegDir && completedSegments > 0)
      ? `${completedSegments}개 세그먼트가 저장되어 있습니다 (${tempSegDir})`
      : null;
    sendEvent({ type: 'error', message: e.message, completedSegments, tempSegDir, savedMessage });
  }

  res.end();
});

// ============================================
// 설치 가이드 링크
// ============================================

const DEFAULT_GUIDE_LINK = '';

router.get('/guide-link', async (req, res) => {
  try {
    const db = await getDb();
    const row = db.prepare("SELECT value FROM tts_settings WHERE key = 'guide_link'").get();
    res.json({ success: true, link: row ? row.value : DEFAULT_GUIDE_LINK });
  } catch (e) {
    res.json({ success: true, link: DEFAULT_GUIDE_LINK });
  }
});

router.put('/guide-link', async (req, res) => {
  const { link, password } = req.body;

  if (password !== '1212') {
    return res.status(403).json({ success: false, message: '비밀번호가 틀렸습니다.' });
  }

  if (link === undefined || link === null) {
    return res.status(400).json({ success: false, message: '링크를 입력해주세요.' });
  }

  try {
    const db = await getDb();
    db.prepare(`
      INSERT INTO tts_settings (key, value) VALUES ('guide_link', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(link.trim());
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================
// 시드 관리
// ============================================

router.get('/seeds', async (req, res) => {
  try {
    const db = await getDb();
    const seeds = db.prepare('SELECT * FROM tts_seeds ORDER BY created_at DESC').all();
    res.json({ success: true, seeds });
  } catch (e) {
    res.json({ success: true, seeds: [] });
  }
});

router.post('/seeds', async (req, res) => {
  const { name, seed, voiceType, speaker, voiceDescription, audioFilename } = req.body;
  if (!name || seed === undefined) {
    return res.status(400).json({ success: false, message: '이름과 시드를 입력해주세요.' });
  }
  try {
    const db = await getDb();
    let savedAudioFilename = null;

    // 오디오 파일 복사 (있는 경우)
    if (audioFilename) {
      const srcPath = path.join(getAudioDir(), audioFilename);
      if (fs.existsSync(srcPath)) {
        const seedAudioDir = getSeedAudioDir();
        const destFilename = `seed_${Date.now()}_${audioFilename}`;
        const destPath = path.join(seedAudioDir, destFilename);
        fs.copyFileSync(srcPath, destPath);
        savedAudioFilename = destFilename;
      }
    }

    db.prepare(`
      INSERT INTO tts_seeds (name, seed, voice_type, speaker, voice_description, audio_filename)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name,
      parseInt(seed, 10),
      voiceType || 'custom',
      speaker || null,
      voiceDescription || null,
      savedAudioFilename
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/seeds/:id', async (req, res) => {
  try {
    const db = await getDb();
    // 삭제 전 오디오 파일명 조회
    const seed = db.prepare(
      'SELECT audio_filename FROM tts_seeds WHERE id = ?'
    ).get(parseInt(req.params.id, 10));

    // DB 삭제
    db.prepare('DELETE FROM tts_seeds WHERE id = ?').run(parseInt(req.params.id, 10));

    // 오디오 파일 삭제
    if (seed && seed.audio_filename) {
      const filePath = path.join(getSeedAudioDir(), seed.audio_filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================
// 오디오 히스토리 관리
// ============================================

router.get('/history', async (req, res) => {
  const { q = '', page = 1, limit = 20 } = req.query;
  try {
    const db = await getDb();
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    let rows, total;

    if (q.trim()) {
      const search = `%${q.trim()}%`;
      total = db.prepare(`
        SELECT COUNT(*) as cnt FROM tts_history
        WHERE original_text LIKE ? OR filename LIKE ? OR speaker LIKE ? OR voice_description LIKE ?
      `).get(search, search, search, search).cnt;
      rows = db.prepare(`
        SELECT * FROM tts_history
        WHERE original_text LIKE ? OR filename LIKE ? OR speaker LIKE ? OR voice_description LIKE ?
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(search, search, search, search, parseInt(limit, 10), offset);
    } else {
      total = db.prepare('SELECT COUNT(*) as cnt FROM tts_history').get().cnt;
      rows = db.prepare('SELECT * FROM tts_history ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(parseInt(limit, 10), offset);
    }

    res.json({ success: true, history: rows, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (e) {
    res.json({ success: true, history: [], total: 0 });
  }
});

router.delete('/history/:id', async (req, res) => {
  try {
    const db = await getDb();
    const row = db.prepare('SELECT filename FROM tts_history WHERE id = ?').get(parseInt(req.params.id, 10));
    if (row) {
      const filePath = path.join(getAudioDir(), row.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      db.prepare('DELETE FROM tts_history WHERE id = ?').run(parseInt(req.params.id, 10));
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/history-bulk', async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, message: '삭제할 항목을 선택해주세요.' });
  }
  try {
    const db = await getDb();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, filename FROM tts_history WHERE id IN (${placeholders})`).all(...ids);
    for (const row of rows) {
      const filePath = path.join(getAudioDir(), row.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    db.prepare(`DELETE FROM tts_history WHERE id IN (${placeholders})`).run(...ids);
    res.json({ success: true, deleted: rows.length });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

export default router;
