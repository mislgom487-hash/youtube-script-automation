import { queryOne } from '../db.js';
import { logToFile } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleAuth } from 'google-auth-library';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, '../../debug.log');

function logError(msg) {
    const time = new Date().toLocaleString();
    fs.appendFileSync(logPath, `[${time}] ${msg} \n`);
}

let genaiModule = null;
let aiClient = null;

async function getVertexAccessToken() {
    const fsM = await import('fs');
    const pathM = await import('path');

    const keyFileRow = queryOne(
        "SELECT key_file_path FROM api_keys WHERE key_type = 'google_project_id' AND is_active = 1"
    );
    const keyFilePath = keyFileRow?.key_file_path || null;

    if (!keyFilePath) {
        throw new Error('서비스 계정 JSON 파일이 등록되지 않았습니다. 설정에서 업로드해 주세요.');
    }

    const absolutePath = pathM.default.resolve(keyFilePath);
    if (!fsM.default.existsSync(absolutePath)) {
        throw new Error('서비스 계정 JSON 파일을 찾을 수 없습니다: ' + absolutePath);
    }

    const auth = new GoogleAuth({
        keyFilename: absolutePath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token.token;
}

async function getClient() {
    const row = queryOne("SELECT value FROM settings WHERE key = 'gemini_api_key'");
    const apiKey = row?.value?.trim();
    if (!apiKey) {
        console.error('Gemini API 키가 설정되지 않았습니다.');
        return null;
    }

    // Vertex AI Bearer Token Check (starting with AQ.A...)
    if (apiKey.startsWith('AQ.A')) {
        console.log('[Auth] Vertex AI Bearer Token detected.');
        return { type: 'vertex_token', token: apiKey };
    }

    try {
        if (!genaiModule) {
            genaiModule = await import('@google/genai');
        }
        const { GoogleGenAI } = genaiModule;
        if (!aiClient) {
            aiClient = new GoogleGenAI({ apiKey });
        }
        return { type: 'api_key', client: aiClient, apiKey };
    } catch (err) {
        console.error('Gemini SDK 로드 실패:', err.message);
        return null;
    }
}

// Reset client when API key changes
export function resetClient() {
    aiClient = null;
}

export async function callGemini(prompt, options = {}, apiType = null) {
    const { jsonMode = false, useGoogleSearch = false, maxTokens = null } = options;
    const _projectId = queryOne("SELECT value FROM settings WHERE key = 'google_project_id'")?.value?.trim();
    const _apiKey = queryOne("SELECT value FROM settings WHERE key = 'gemini_api_key'")?.value?.trim();
    console.log('[GEMINI호출]', { apiType, hasProjectId: !!_projectId, hasApiKey: !!_apiKey });

    // 429 시 즉시 에러 반환 (재시도 없음 — 일일 쿼터 소진 상황에서 60초 대기+재시도는 의미 없음)
    let timer;
    try {
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('AI 분석 시간 초과 (300초). 모델이 응답하지 않거나 네트워크 상태가 불안정합니다.')), options.timeout || 300000);
        });

        const fetchPromise = (async () => {
            const cloudRunUrl = queryOne("SELECT value FROM settings WHERE key = 'cloud_run_url'")?.value?.trim();
            const projectId = queryOne("SELECT value FROM settings WHERE key = 'google_project_id'")?.value?.trim();
            const row2 = queryOne("SELECT value FROM settings WHERE key = 'gemini_api_key'");
            const apiKey = row2?.value?.trim();

            let url;
            let headers = { 'Content-Type': 'application/json' };
            const modelName = 'gemini-2.5-flash';

            if (apiType === 'ai_studio') {
                if (!apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다.');
                url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            } else if (apiType === 'vertex_ai') {
                if (!projectId) throw new Error('Google Cloud 프로젝트 ID가 설정되지 않았습니다.');
                const serviceAccount = queryOne("SELECT key_file_path FROM api_keys WHERE key_type = 'google_project_id' AND is_active = 1");
                if (!serviceAccount?.key_file_path) throw new Error('서비스 계정 JSON 파일이 등록되지 않았습니다.');
                const fsV = await import('fs');
                const saJson = JSON.parse(fsV.default.readFileSync(serviceAccount.key_file_path, 'utf8'));
                const saProjectId = saJson.project_id;
                const location = queryOne("SELECT value FROM settings WHERE key = 'google_location'")?.value?.trim() || 'us-central1';
                const accessToken = await getVertexAccessToken();
                url = `https://${location}-aiplatform.googleapis.com/v1/projects/${saProjectId}/locations/${location}/publishers/google/models/${modelName}:generateContent`;
                headers['Authorization'] = `Bearer ${accessToken}`;
            } else {
                if (cloudRunUrl) {
                    url = `${cloudRunUrl}/v1beta/models/${modelName}:generateContent`;
                    if (apiKey) url += `?key=${apiKey}`;
                } else if (projectId) {
                    const serviceAccount = queryOne("SELECT key_file_path FROM api_keys WHERE key_type = 'google_project_id' AND is_active = 1");
                    if (serviceAccount?.key_file_path) {
                        const fsV = await import('fs');
                        const saJson = JSON.parse(fsV.default.readFileSync(serviceAccount.key_file_path, 'utf8'));
                        const saProjectId = saJson.project_id;
                        const location = queryOne("SELECT value FROM settings WHERE key = 'google_location'")?.value?.trim() || 'us-central1';
                        const accessToken = await getVertexAccessToken();
                        url = `https://${location}-aiplatform.googleapis.com/v1/projects/${saProjectId}/locations/${location}/publishers/google/models/${modelName}:generateContent`;
                        headers['Authorization'] = `Bearer ${accessToken}`;
                    } else {
                        if (!apiKey) throw new Error('사용 가능한 API 키가 없습니다.');
                        url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
                    }
                } else if (apiKey) {
                    url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
                } else {
                    throw new Error('사용 가능한 API 설정이 없습니다.');
                }
            }

            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        response_mime_type: jsonMode ? 'application/json' : 'text/plain',
                        temperature: options.temperature !== undefined ? options.temperature : 1.2,
                        ...(maxTokens ? { maxOutputTokens: maxTokens } : {})
                    },
                    ...(useGoogleSearch && !jsonMode ? { tools: [{ google_search: {} }] } : {})
                })
            });

            const data = await res.json();
            console.log('[callGemini] API 응답 수신');
            if (res.ok) {
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) {
                    logToFile(`[AI Warning] 응답 성공했으나 결과가 비어있음: ${JSON.stringify(data)}`);
                    return '';
                }
                logToFile(`[AI Response] 성공 (${text.length}자)`);
                return text;
            }

            logToFile(`[AI Error] API 호출 실패 (${res.status}): ${JSON.stringify(data)}`);
            console.error(`[API Error Detail] status=${res.status}, body=${JSON.stringify(data, null, 2)}`);
            throw new Error(data.error?.message || 'AI Studio Call Failed');
        })();

        const text = await Promise.race([fetchPromise, timeoutPromise]);
        if (timer) clearTimeout(timer);

        if (typeof text !== 'string') {
            console.warn('[AI Warning] 응답이 문자열이 아닙니다:', typeof text);
            return String(text || '');
        }

        return text;
    } catch (err) {
        if (timer) clearTimeout(timer);

        // [제거됨] 429 시 60초 대기+재시도 로직 — 일일 쿼터 소진 시 무의미하므로 즉시 에러 반환
        // if (... 429 ... && attempt < MAX_RETRIES) { await sleep(60000); continue; }

        console.error(`[AI Error] Gemini API 호출 실패:`, err.message);
        logError(`Gemini Error: ${err.message}`);

        // Rethrow with specific message or wrap it
        if (err.message.includes('401') || err.message.includes('UNAUTHENTICATED') || err.message.includes('API keys are not supported')) {
            const authErr = new Error('API 인증에 실패했습니다. Project ID와 토큰/키를 다시 확인해주세요.');
            authErr.status = 401;
            authErr.errorType = 'AUTH_ERROR';
            throw authErr;
        }
        if (err.message.includes('429') || err.message.includes('quota') || err.message.includes('RESOURCE_EXHAUSTED')) {
            const msg = apiType === 'vertex_ai'
                ? 'Vertex AI 쿼터 초과. 잠시 후 다시 시도해주세요.'
                : '일일 API 한도 초과. 오후 4시 이후 다시 시도해주세요.';
            const quotaErr = new Error(msg);
            quotaErr.status = 429;
            quotaErr.errorType = 'QUOTA_EXCEEDED';
            throw quotaErr;
        }
        if (err.message.includes('0.5s') || err.message.includes('Safety') || err.message.includes('candidate')) {
            const safetyErr = new Error('안전성 필터 또는 비어있는 응답입니다. (주제 선정 부적절 가능성)');
            safetyErr.status = 400;
            safetyErr.errorType = 'SAFETY_ERROR';
            throw safetyErr;
        }
        if (err.message.includes('Timeout')) {
            const timeoutErr = new Error('Gemini API 응답 시간 초과 (300초). 모델이 응답하지 않거나 네트워크 상태가 불안정합니다.');
            timeoutErr.status = 504;
            timeoutErr.errorType = 'TIMEOUT';
            throw timeoutErr;
        }
        throw err;
    }
}

// Extract keywords from video title + description + transcript
export async function extractKeywords(title, description = '', transcriptText = '') {
    const desc = description.substring(0, 300);
    const transcript = transcriptText.substring(0, 1500);

    const prompt = `당신은 YouTube 영상 분석 전문가입니다.
아래 영상 정보에서 핵심 키워드를 정확히 10개 추출해주세요.
유튜브 상투어(구독, 좋아요, 알림, 영상 등)는 제외하세요.

제목: ${title}
${desc ? `설명: ${desc}` : ''}
${transcript ? `자막 내용: ${transcript}` : ''}

JSON 배열로만 응답하세요 (다른 텍스트 없이):
["키워드1", "키워드2", ...]`;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    if (!result || typeof result !== 'string') return fallbackKeywords(title, description);

    try {
        const jsonStr = result.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) return parsed.slice(0, 15);
    } catch (e) { }

    return fallbackKeywords(title, description);
}

// Categorize a video based on keywords and available category groups
export async function categorizeVideo(title, keywords, categoryGroups) {
    if (!categoryGroups || categoryGroups.length === 0) return [];

    const isEconomy = categoryGroups.some(g => g.group_name.includes('경제'));
    const groupsStr = categoryGroups.map(g =>
        `${g.group_name}: [${g.items.join(', ')}]`
    ).join('\n');

    let prompt = `당신은 콘텐츠 분류 전문가입니다.
아래 영상의 제목과 키워드를 보고, 해당하는 카테고리를 분류해주세요.

제목: ${title}
키워드: ${keywords.join(', ')}

사용 가능한 카테고리:
${groupsStr}

각 그룹에서 가장 적합한 카테고리를 하나씩만 선택하세요.
해당하지 않는 그룹은 건너뛰세요.
`;

    if (isEconomy) {
        prompt += `
또한, 경제 콘텐츠인 경우 아래의 영향도 및 관심도 점수를 1~5점 사이로 매겨주세요:
- 생활 영향도, 투자 영향도, 정책 영향도, 노후 영향도
- 3040 관심도, 5060 관심도, 전체 관심도

JSON 객체로 응답하세요:
{
  "categories": {"그룹명": "카테고리명", ...},
  "economy_metadata": {
    "impact": {"생활": 3, "투자": 5, "정책": 2, "노후": 1},
    "interest": {"3040": 4, "5060": 5, "전체": 4}
  }
}`;
    } else {
        prompt += `
JSON 객체로만 응답하세요:
{"그룹명": "카테고리명", ...}`;
    }

    const result = await callGemini(prompt, { useGoogleSearch: true });
    if (!result || typeof result !== 'string') return isEconomy ? { categories: {}, economy_metadata: {} } : {};

    try {
        const jsonStr = result.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        return isEconomy ? { categories: {}, economy_metadata: {} } : {};
    }
}

// Summarize transcript
export async function summarizeTranscript(transcriptText) {
    if (!transcriptText || transcriptText.length < 50) return '';

    const prompt = `아래 YouTube 영상의 자막 내용을 한국어 200자 이내로 요약하세요.
핵심 줄거리와 주요 인물/사건만 간결하게 서술하세요.

자막 내용:
${transcriptText.substring(0, 2000)}

요약(200자 이내, 텍스트만):`;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    return (result && typeof result === 'string') ? result.trim().substring(0, 300) : '';
}

// Suggest topics from gap data with DNA Benchmarking
export async function suggestTopics(gapData, genreContext = '', dnaSummary = null) {
    const dnaPrompt = dnaSummary ? `
[성공 공식: 떡상 DNA 패턴]
이 데이터는 최근 떡상한 영상들에서 공통적으로 발견된 성공 패턴입니다. 
구조 설계 시 이 패턴을 적극적으로 반영하십시오:
- 주요 관계: ${dnaSummary.dna.relationshipTop.map(i => i.k).join(', ')}
- 핵심 사건: ${dnaSummary.dna.eventTop.map(i => i.k).join(', ')}
- 감정 키워드: ${dnaSummary.dna.emotionTop.map(i => i.k).join(', ')}
- 반전 장치: ${dnaSummary.dna.twistTop.map(i => i.k).join(', ')}
` : "";

    const prompt = `당신은 YouTube 콘텐츠 전략 및 드라마 기획 전문가입니다.
특히 한국의 고전 '야담'과 '역사' 콘텐츠를 현대적으로 재해석하여 100만 조회수를 기록하는 전문가 페르소나로 응답하세요.

[분석 데이터: 시장의 빈틈(Gaps)]
${JSON.stringify(gapData)}

[맥락 정보]
${genreContext}
${dnaPrompt}

[기획 미션]
위의 '빈틈' 데이터와 '떡상 DNA'를 결합하여, 기존 대형 채널들과 차별화되는 **압도적인 영상 주제 10개**를 제안하십시오.

[작업 원칙 — 매우 중요]
1. **구조적 벤치마킹**: 떡상 DNA에서 추출된 관계, 사건, 감정, 반전의 '구조'는 흥행 보증 수표입니다. 이 구조를 새로운 기획의 뼈대로 삼으십시오.
2. **소재 및 제목 재조합**: 떡상 DNA는 '구조'만 참고할 뿐, '소재(구체적인 이야기 내용)'는 기존 떡상 영상들과 절대 겹쳐서는 안 됩니다. 
   - 기존 영상에 사또가 나온다면, 구조는 유지하되 인물을 포졸이나 암행어사로 바꾸십시오. 
   - 배경이 한양이라면 평양이나 시골 마을로 바꾸어 '희소성'을 확보하십시오.
3. **독창적 카피라이팅**: 제목은 기존 영상들을 회피하면서도 클릭을 부르는 고CTR 스타일로 지으십시오.

[필수 요구사항]
1. **dna_analysis**: 전달받은 DNA 패턴 중 이번 기획에 핵심적으로 반영한 요소가 무엇인지 설명하세요.
2. **target_audience**: 어떤 심리를 가진 시청자가 이 영상을 클릭할지 정의하세요.
3. **reason**: 기존 영상들과 무엇이 다른지(소재 재조합의 묘미)를 설명하세요.
4. **title**: 클릭을 부르는 매혹적인 제목.
5. **description**: 반전과 흥미 포인트가 포함된 상세 줄거리 (100자 내외).

JSON 객체로 응답하세요:
{
  "dna_analysis": "DNA 분석 및 기획 방향 요약",
  "suggestions": [
    {
      "title": "제목",
      "description": "줄거리",
      "target_audience": "타겟",
      "reason": "차별화 포인트",
      "categories": ["카테고리1", "2"],
      "gap_rate": 95
    }
  ]
} (정확히 10개)`;

    const result = await callGemini(prompt, { jsonMode: true });
    if (!result || typeof result !== 'object') {
        if (result && result.errorType) return result;
        return { dna_analysis: '', suggestions: [] };
    }

    return parseGeminiJson(result, { dna_analysis: '', suggestions: [] });
}

// ═══════════════════════════════════════════════════════════
// v4: Analyze comments — AI sentiment analysis
// ═══════════════════════════════════════════════════════════
export async function analyzeComments(comments, videoTitle) {
    if (!comments || comments.length === 0) return null;

    const commentsStr = comments.slice(0, 50).map((c, i) =>
        `${i + 1}. [좋아요 ${c.like_count}] ${c.text.substring(0, 100)}`
    ).join('\n');

    const prompt = `당신은 YouTube 댓글 분석 전문가입니다.

영상 제목: ${videoTitle}

상위 댓글 (좋아요 순):
${commentsStr}

아래 형식으로 분석해주세요. JSON 객체로만 응답하세요:
{
  "sentiment": {"positive": 백분율, "neutral": 백분율, "negative": 백분율},
  "top_reactions": ["시청자가 가장 공감한 포인트 1", "포인트 2", "포인트 3", "포인트 4", "포인트 5"],
  "emotion_keywords": ["감동", "충격", "재미" 등 자주 나타나는 감정 키워드],
  "improvement_hints": ["시청자가 아쉬워하거나 더 보고 싶어하는 부분 1", "2"],
  "content_ideas": ["이 댓글 반응을 활용하면 좋을 새 영상 주제 1", "2", "3"],
  "summary": "댓글 전체 분위기를 50자 이내로 요약"
}`;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    if (!result || typeof result !== 'string') {
        if (result && result.errorType === 'QUOTA_EXCEEDED') return { errorType: 'QUOTA_EXCEEDED' };
        return null;
    }

    try {
        const jsonStr = result.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════
// v4: Generate AI Benchmark Report (one-click)
// ═══════════════════════════════════════════════════════════
export async function generateBenchmarkReport(videoData) {
    const { title, description, view_count, like_count, comment_count,
        subscriber_count, duration_seconds, transcript_summary,
        transcript_keywords, channel_name, published_at, comments_analysis } = videoData;

    const engagementRate = view_count > 0
        ? (((like_count || 0) + (comment_count || 0)) / view_count * 100).toFixed(2)
        : 0;
    const viralScore = subscriber_count > 0
        ? Math.round((view_count / subscriber_count) * 100)
        : 0;
    const viralGrade = viralScore >= 2000 ? 'S' : viralScore >= 500 ? 'A' : viralScore >= 100 ? 'B' : viralScore >= 30 ? 'C' : 'D';

    const prompt = `당신은 YouTube 콘텐츠 벤치마킹 전문가입니다.

아래 영상을 상세히 분석하여 벤치마킹 리포트를 작성해주세요.

📊 영상 정보:
- 제목: ${title}
- 채널: ${channel_name || '알 수 없음'}
- 구독자: ${(subscriber_count || 0).toLocaleString()}
- 조회수: ${(view_count || 0).toLocaleString()}
- 좋아요: ${(like_count || 0).toLocaleString()}
- 댓글수: ${(comment_count || 0).toLocaleString()}
- 참여율: ${engagementRate}%
- 떡상 지표: ${viralScore}% (${viralGrade}등급)
- 영상 길이: ${Math.floor(duration_seconds / 60)}분 ${duration_seconds % 60}초
- 업로드일: ${published_at || ''}
${description ? `- 설명: ${description.substring(0, 300)}` : ''}
${transcript_summary ? `- 자막 요약: ${transcript_summary}` : ''}
${transcript_keywords ? `- 키워드: ${transcript_keywords}` : ''}
${comments_analysis ? `- 댓글 감정: 긍정 ${comments_analysis.sentiment?.positive}%` : ''}

JSON 객체로만 응답하세요:
{
  "performance_summary": "이 영상의 성과를 3줄로 요약",
  "why_viral": ["이 영상이 뜬 이유 1", "이유 2", "이유 3", "이유 4"],
  "title_analysis": "제목이 효과적인 이유 분석 (50자)",
  "thumbnail_tips": "이 영상의 썸네일 전략 추정 (50자)",
  "script_structure": [
    {"section": "도입", "time": "0~1분", "description": "어떤 내용"},
    {"section": "전개", "time": "1~5분", "description": "어떤 내용"},
    {"section": "절정", "time": "5~7분", "description": "어떤 내용"},
    {"section": "결말", "time": "7~끝", "description": "어떤 내용"}
  ],
  "benchmark_tips": ["벤치마킹할 때 따라해야 할 포인트 1", "2", "3"],
  "new_topic_ideas": [
    {"title": "이 영상을 벤치마킹한 새 주제 1", "description": "간단한 기획 방향"},
    {"title": "새 주제 2", "description": "기획 방향"},
    {"title": "새 주제 3", "description": "기획 방향"}
  ],
  "risk_factors": ["주의할 점 1", "2"]
}`;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    if (!result || typeof result !== 'string') {
        if (result && result.errorType === 'QUOTA_EXCEEDED') return { errorType: 'QUOTA_EXCEEDED' };
        return null;
    }

    try {
        const jsonStr = result.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        // Attach computed metrics
        parsed.metrics = {
            viral_score: viralScore,
            viral_grade: viralGrade,
            engagement_rate: parseFloat(engagementRate),
            view_count, like_count, comment_count, subscriber_count
        };
        return parsed;
    } catch (e) {
        return null;
    }
}

// Fallback: basic keyword extraction without AI
export function fallbackKeywords(title, description = '') {
    const text = `${title} ${description.substring(0, 200)}`;
    const stopwords = new Set([
        '의', '를', '을', '에', '에서', '은', '는', '이', '가', '와', '과', '도', '로', '으로',
        '한', '하는', '된', '되는', '있는', '없는', '그', '이', '저', '것', '수', '등',
        '더', '및', '또는', '그리고', '하지만', '때문에', '위해', '통해', '대한',
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for',
        '구독', '좋아요', '알림', '영상', '채널', '시청', '감사', '링크', '댓글',
        '오늘', '여러분', '정말', '너무', '우리', '같은', '많은', '다른'
    ]);

    const words = text
        .replace(/[^\w\s가-힣]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 2 && !stopwords.has(w))
        .slice(0, 10);

    return [...new Set(words)];
}

/**
 * v4: Suggest topics from multi-category gap data
 */
export async function suggestMultiGapTopics(selectedCategories, gapCategories) {
    const selectedStr = selectedCategories.map(c => `${c.group}: ${c.name}`).join(', ');
    const gapsStr = gapCategories.map(g => `${g.group} -> ${g.name} (${g.percentage}%)`).join(', ');

    const prompt = `당신은 YouTube 콘텐츠 전략 전문가입니다.
사용자가 선택한 카테고리 설정과, 분석 결과 발견된 '기회 영역(점유율 30% 미만)'을 조합하여 떡상할 수 있는 새로운 영상 주제를 기획해주세요.

사용자 선택 상황:
- ${selectedStr || '전체 영상 대상'}

발견된 빈틈 (점유율 30% 미만인 카테고리들):
- ${gapsStr}

위의 '사용자 선택 상황'을 배경으로 하면서, '빈틈'에 해당하는 카테고리 소재를 하나 이상 융합한 독창적인 영상 아이디어를 **정확히 10개** 제안해주세요. 
기존에 너무 흔한 뻔한 조합은 피하고, 시청자들이 신선함을 느낄 수 있는 기획이어야 합니다.

JSON 배열로만 응답하세요 (총 10개):
[
  {
    "title": "제목", 
    "description": "영상 한 줄 기획 (100자 내외)", 
    "categories": ["카테고리1", "2"]
  }, 
  ...
]`;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    if (!result || typeof result !== 'string') {
        if (result && result.errorType) return result;
        return [];
    }

    try {
        const jsonStr = result.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        return [];
    }
}

import { attachDNAContextToPrompt } from './prompt-addon.js';

/**
 * Helper: Extract and parse JSON from Gemini response
 * 고도화된 JSON 추출기: 마크다운 블록 제거, 불필요한 서술부 도려내기, 문법 자동 보관 로직 포함
 */
function parseGeminiJson(text, defaultValue = null) {
    if (!text || typeof text !== 'string') return defaultValue;

    let cleaned = text.trim();

    try {
        // 1. 마크다운 코드 블록 제거 (```json ... ```)
        const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonBlockMatch) {
            cleaned = jsonBlockMatch[1].trim();
        }

        // 2. 가장 바깥쪽 대괄호 [] 또는 중괄호 {} 찾기
        const firstBracket = cleaned.indexOf('[');
        const firstBrace = cleaned.indexOf('{');
        const lastBracket = cleaned.lastIndexOf(']');
        const lastBrace = cleaned.lastIndexOf('}');

        let startIndex = -1;
        let endIndex = -1;

        if (firstBracket !== -1 && lastBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
            startIndex = firstBracket;
            endIndex = lastBracket;
        } else if (firstBrace !== -1 && lastBrace !== -1) {
            startIndex = firstBrace;
            endIndex = lastBrace;
        }

        if (startIndex !== -1 && endIndex !== -1) {
            cleaned = cleaned.substring(startIndex, endIndex + 1);
        }

        // 3. 마지막 콤마(Trailing Comma) 및 코멘트 제거
        cleaned = cleaned
            .replace(/,\s*([\]}])/g, '$1') // 마지막 쉼표 제거
            .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // // 또는 /* */ 주석 제거

        return JSON.parse(cleaned);
    } catch (e) {
        console.error('[GeminiJSON] Parsing Error:', e.message);
        console.error('[GeminiJSON] Raw Sample:', text.substring(0, 300));
        return defaultValue;
    }
}

/**
 * 1. 고CTR 썸네일 제목 생성 (심리 트리거 카피라이터 페르소나)
 */
async function generateHighCTRTitles(topicTitle, keywords, contextStr) {
    const prompt = `당신은 유튜브 CTR(클릭률) 최적화 전문가이자 인간 심리 트리거 카피라이터입니다.
0.5초 내에 이해되고, 강한 궁금증을 유발하며, 감정을 자극하는 제목을 만드는 것이 당신의 유일한 목표입니다.

[절대 규칙 — 매우 중요]
    1. 제목 길이: ** 12~18자 내외 ** (너무 짧고 단조롭지 않게)
    2. 결과 / 결론 절대 공개 금지
    3. ** 어미 다각화 **: "했다", "다" 처럼 ** '-다'로 끝나는 평서문 종결 어미를 절대 사용하지 마십시오.** (예: "~한 이유", "~했더니...", "~라고?", "~하는 순간" 등 미완성·의문·명사형 어미 사용)
    4. 설명형 및 정보 전달형 문장 금지
    5. 상황 또는 감정 중심
    6. 반드시 “왜 ?” 궁금증이 생겨야 함(오픈 루프)
    7. 가능하면 인물을 포함하고, 평범한 표현보다 이상·변화·충격 단어 우선 사용
    8. 결과물은 10개를 출력하되, 각각이 위 규칙을 완벽히 준수해야 함

    [제목 생성 공식]
    상황 + 이상 신호 + 미완성 / 의문형(예: "아들이 갑자기...", "그날 이후 벌어진 일", "의사가 멈춰버린 이유")

    [분석 기초 데이터]
    주제: ${topicTitle}
    키워드: ${keywords.join(', ')}
${contextStr}

    [AI 내부 분석 단계]
먼저 아래 3개를 추출하고 이를 조합하여 제목을 생성하세요:
    1. 가장 충격적인 순간 1개
    2. 감정 변화 지점 1개
    3. 시청자가 궁금해할 미스터리 요소 1개

    [핵심 원칙]
결과를 숨기고 감정을 던지세요.

JSON 배열로만 응답하세요:
    ["제목 1", ..., "제목 10"]`;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    return parseGeminiJson(result, []);
}

/**
 * 2. v2.0 야담 대본 뼈대 설계 (역사 야담 및 드라마 기획 전문가 페르소나)
 * @param {object} dnaSummary - 떡상 DNA 패턴 객체
 */
async function generateYadamSkeletonV2(topicTitle, keywords, contextStr, dnaSummary = null) {
    const dnaPrompt = dnaSummary ? `
[필수 반영: 성공 DNA 구조]
최근 떡상한 야담 영상들에서 발견된 '흥행 보증' 구조입니다. 이 패턴을 이야기의 뼈대로 삼으십시오:
- 주요 관계 패턴: ${dnaSummary.dna.relationshipTop.map(i => i.k).join(', ')}
- 핵심 사건 패턴: ${dnaSummary.dna.eventTop.map(i => i.k).join(', ')}
- 감어 키워드 패턴: ${dnaSummary.dna.emotionTop.map(i => i.k).join(', ')}
- 반전 장치 패턴: ${dnaSummary.dna.twistTop.map(i => i.k).join(', ')}

[작성 지침]
위의 DNA 패턴 중 가장 적합한 요소를 골라 7단계 구조에 녹여내십시오. 
특히 '관계'와 '반전'은 DNA 패턴을 벤치마킹하되, 구체적인 소재와 인물 설정은 기존 영상들과 겹치지 않게 '재조합'하십시오.
` : "";

    const prompt = `당신은 역사 야담 및 드라마 시나리오 기획 전문가입니다.
시니어 시청자층의 몰입도를 극대화하는 '구조 기반 설계' 대본 뼈대를 작성하는 것이 목적입니다.
${dnaPrompt}

[핵심 원칙]
- 문체(20%)보다 구조(80%)에 집중하십시오. 사건보다 감정이 먼저입니다.
- 대본을 먼저 쓰지 말고 반드시 뼈대부터 완성하십시오.

[공식 - 7단계 구조]
아래 순서와 구성을 반드시 엄수하십시오:
① 충격 사건: 설명 없이 사건부터 시작(위험 상황, 충격 장면 등)
② 의심 발생: 이상 징후와 궁금증 고리 배치
③ 갈등 확대: 최소 2개 이상의 갈등 축 설정(부모vs자식, 욕망vs양심 등)
④ 단서 발견: 정보를 점진적으로 공개(초반 - 정보부족, 중반 - 단서일부)
⑤ 반전 조짐: 정보가 연결되며 긴장을 최고조로 상승
⑥ 진실 공개: 강렬한 감정 반전 삽입(댓글 반응 유도 핵심)
⑦ 감정 여운: 설명하지 않고 여운을 남기는 엔딩

[분석 지침]
- 감정 곡선: 불안 → 희망 → 의심 → 위기 → 충격 → 이해 → 여운
- 인물: 3~6명 유지, 각 인물은 명확한 동기를 가짐
- 반복 장치: 특정 물건 / 말 / 습관을 상징적으로 활용

[분석 기초 데이터]
주제: ${topicTitle}
키워드: ${keywords.join(', ')}
${contextStr}

JSON 객체로만 응답하세요:
{
  "differentiation": "인물 동기 및 차별화 포인트",
  "dna_usage": "어떤 DNA 패턴(관계/반전 등)을 구조에 반영했는지 설명",
  "script_skeleton": {
    "step1_shock": "충격 사건 (DNA 사건 패턴 참고)",
    "step2_doubt": "의심 발생 (이상 현상)",
    "step3_conflict": "갈등 확대 (DNA 관계 패턴 기반)",
    "step4_clue": "단서 발견 (점진 공개)",
    "step5_flash": "반전 조짐 (긴장 상승)",
    "step6_truth": "진실 공개 (DNA 반전 패턴 반영)",
    "step7_resonance": "감정 여운 (엔딩 설계)"
  }
}
모든 내용은 한국어로 작성하세요.`;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    return parseGeminiJson(result, null);
}

/**
 * 3. 경제 전용 대본 뼈대 설계 (거시경제 애널리스트 + 유튜브 시놉시스 전문가)
 */
async function generateEconomySkeletonV2(topicTitle, keywords, contextStr) {
    const prompt = `당신은 20년 경력 거시경제 및 금융시장 전문 애널리스트이자
유튜브 경제 채널 시놉시스 설계 전문가입니다.

지금부터 완성 대본을 쓰지 말고
"클로드 4.6이 각색하기 가장 좋은 고밀도 대본 뼈대"만 설계하십시오.

[분석 기초 데이터]
주제: ${topicTitle}
키워드: ${keywords.join(', ')}
${contextStr}

[목표]
1. 조회수 후킹 구조 극대화
2. 정보 지연 공개 구조 설계
3. 데이터 기반 긴장 설계
4. 감정 곡선 설계
5. 클로드가 살을 붙이기 쉬운 구조 제공

[출력 형식 — JSON으로만 응답하세요]

{
  "core_message": "전체 영상 한 줄 핵심 메시지 (단정 금지, 결론 금지)",

  "five_parts": [
    {
      "part_number": 1,
      "purpose": "이 파트의 목적",
      "viewer_emotion": "시청자가 느껴야 할 감정",
      "data_to_reveal": "공개할 데이터 종류",
      "hidden_info": "의도적으로 숨길 정보",
      "tension_device": "긴장 장치",
      "ending_hook": "엔딩 훅 문장 초안"
    }
  ],

  "data_slots": {
    "latest_data": ["[SLOT] 최신 데이터 자리 표시 1", "[SLOT] 최신 데이터 자리 표시 2"],
    "comparison_data": ["[SLOT] 과거 비교 데이터 1"],
    "policy_variables": ["[SLOT] 정책 변수 1"],
    "liquidity_variables": ["[SLOT] 유동성 변수 1"],
    "sentiment_variables": ["[SLOT] 심리 변수 1"],
    "global_variables": ["[SLOT] 글로벌 변수 1"]
  },

  "emotion_curve": {
    "intro_tension": "도입 긴장 강도 (1~10 수치)",
    "mid_refire_point": "중반 몰입 재점화 지점 설명",
    "analysis_stability": "구조 분석 구간 안정도 (1~10 수치)",
    "final_uncertainty": "마지막 변수 제시 구간 불확실성 강도 (1~10 수치)"
  },

  "algorithm_design": {
    "first_30sec_hook": "초반 30초 후킹 전략",
    "info_delay_method": "정보 지연 방식",
    "mid_refire_method": "중반 재점화 방식",
    "retention_defense": "시청 지속률 방어 장치"
  },

  "claude_guide": {
    "tone": "강의형 화법 유지",
    "question_points": ["질문 삽입 위치 1", "질문 삽입 위치 2"],
    "data_timing": ["데이터 공개 타이밍 1", "데이터 공개 타이밍 2"],
    "restrictions": ["절대 결론 선공개 금지", "공포 조장 금지", "투자 권유 금지", "특수기호 제한 준수"]
  },

  "differentiation": "기존 경제 영상 대비 이 기획의 차별화 포인트"
}

[주의]
- 완성 대본을 작성하지 마십시오. 설계도만 작성하십시오.
- 과장 표현 금지. 단정 표현 금지.
- 숫자는 실제 값 대신 [SLOT] 형식으로 남기십시오.
- 예시: "2025년 3분기 CPI 전년대비 상승률 [SLOT]%", "연준 기준금리 [SLOT]%"
- five_parts 배열은 정확히 5개의 파트로 구성하세요.
- 모든 내용은 한국어로 작성하세요.
- JSON 데이터 외의 다른 텍스트는 포함하지 마세요.`;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    return parseGeminiJson(result, null);
}

/**
 * v2.0 통합 관리 함수: 독립된 전문가들을 호출하여 결과 취합
 * type: 'all' | 'titles' | 'skeleton' | 'economy'
 * @param {object} dnaSummary - [NEW] 추가된 떡상 DNA 통계 객체
 */
export async function generateFullScriptPlan(topicTitle, keywords, existingVideos = [], type = 'all', dnaSummary = null) {
    const dnaStr = dnaSummary ? `\n[성공 패턴(DNA)]: ${JSON.stringify(dnaSummary, null, 2)}\n` : "";

    const contextStr = existingVideos.length > 0
        ? `기존 관련 영상들: \n${existingVideos.map(v => `- ${v.title}`).join('\n')} ${dnaStr}`
        : `데이터베이스에 비슷한 기존 영상이 없습니다. ${dnaStr}`;

    // 경제 모드: 전용 프롬프트 사용
    if (type === 'economy') {
        const [titles, economySkeleton] = await Promise.all([
            generateHighCTRTitles(topicTitle, keywords, contextStr),
            generateEconomySkeletonV2(topicTitle, keywords, contextStr)
        ]);

        if (!titles.length && !economySkeleton) return null;

        return {
            hooking_titles: titles,
            seo_keywords: keywords.slice(0, 10),
            differentiation: economySkeleton?.differentiation || "",
            script_skeleton: economySkeleton || null,
            isEconomyFormat: true
        };
    }

    // 기본 모드 (야담 등)
    const [titles, skeletonData] = await Promise.all([
        (type === 'all' || type === 'titles') ? generateHighCTRTitles(topicTitle, keywords, contextStr) : Promise.resolve([]),
        (type === 'all' || type === 'skeleton') ? generateYadamSkeletonV2(topicTitle, keywords, contextStr, dnaSummary) : Promise.resolve(null)
    ]);

    // Validation: Require at least what was asked for
    if (type === 'titles' && !titles.length) return null;
    if (type === 'skeleton' && !skeletonData) return null;
    if (type === 'all' && !titles.length && !skeletonData) return null;
    if (type === 'economy' && !titles.length && !skeletonData) return null;

    return {
        hooking_titles: titles,
        seo_keywords: keywords.slice(0, 10),
        differentiation: skeletonData?.differentiation || "",
        script_skeleton: skeletonData?.script_skeleton || null
    };
}

/**
 * v4: Edit script based on specific instructions
 */
export async function editScript(content, instructions) {
    if (!content) return "";

    const prompt = `당신은 문서 편집 및 텍스트 구조 설계 전문가입니다.
        사용자의[지시사항]에 따라[원본 대본]을 엄격하게 수정해주세요.

[지시사항]
${instructions || '내용을 더 매끄럽고 자연스럽게 다듬어주세요.'}

    [원본 대본]
${content}

⚠️ 반드시 지켜야 할 작업 원칙:
    1.[지시사항]에 "삭제" 요청이 있다면 해당 내용을 즉시 제거하세요.
2.[지시사항]에 "삽입"이나 "추가" 요청이 있다면 지정된 위치나 문맥에 맞는 최적의 위치에 내용을 삽입하세요.
3. 지시사항이 없는 부분이라도 문맥이 어색해졌다면 자연스럽게 문장을 다듬으세요.
4. ** 문법 및 시제 일치 **: 특히 과거 상황에 대한 가정이나 추측(예: ~했을 겁니다) 등 문맥에 맞는 정확한 시제와 어미를 사용하세요. 
5. 출력은 '수정된 대본 내용'만 단 한 글자도 빠짐없이 반환해야 합니다.인사말이나 "수정을 완료했습니다" 같은 부연 설명은 절대 포함하지 마세요.

수정된 대본: `;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    return result || content;
}

/**
 * v5: Classify a channel based on its name and detailed video data (titles + descriptions)
 */
export async function classifyChannel(channelName, videoData = [], context = '', description = '') {
    if (!videoData || videoData.length === 0) return null;

    // Build a detailed list of videos with descriptions
    const videoInfoStr = videoData.slice(0, 15).map(v =>
        `- 제목: ${v.title} \n  ㄴ 내용요약: ${(v.description || '').slice(0, 200)}...`
    ).join('\n');

    const descStr = description ? description.slice(0, 500) : '설명 없음';

    const prompt = `당신은 YouTube 채널의 정체성을 꿰뚫어 보는 '초정밀 콘텐츠 분류 전문가'입니다.
        채널명, 설명글, 그리고 수집된 영상들의 실제 '제목과 상세 설명'을 종합 분석하여 결과를 도출하세요.

            ${context ? `[최우선 지침: 사용자 의도 반영]\n사용자는 현재 "${context}" 관련 키워드로 검색하던 중 이 채널을 발견했습니다. 채널이 "${context}"(경제, 심리학, 또는 역사)와 조금이라도 연관성이 있다면, 해당 카테고리로 분류하는 것을 최우선순위로 두십시오.\n` : ''}

    [분류 기준 및 상세 정의]
    1. '야담'(전통 역사 / 설화 / 기이한 이야기):
    - 조선 / 고려 / 삼국시대 등 정통 역사 배경의 기이한 이야기나 민담, 설화.
   - ** [판정 팁] **: 영상 제목이나 설명에 "과거 인물, 설화, 민담, 고전, 야사" 같은 단어가 하나라도 포함되어 있다면 '야담'으로 강력히 분류하십시오.

2. '경제'(금융, 주식, 글로벌 시사, 비즈니스 지식):
    - 주식, 부동산뿐만 아니라 ** 세상 돌아가는 이치, 글로벌 시사지식, 비즈니스 전략, 기업 분석, 재테크 ** 포함.
   - ** [판정 팁] **: '슈카월드' 스타일의 지식 전달이나 "반도체, 환율, 금리, 미중관계, 경영" 등 현대 사회의 전략과 흐름을 다룬다면 무조건 '경제'로 분류하십시오.

3. '심리학'(인간 내면, 관계 분석, 정신 건강):
    - 실제 심리 상담, 인간관계 고민, 행동 심리, 무의식 분석, 자존감 등.
   - ** [판정 팁] **: "자존감, 가스라이팅, 인간관계, 무의식, 상담, 마음" 등 인간의 마음과 관계를 분석하는 내용이 주를 이룬다면 '심리학'으로 분류하십시오.

[분류 대상 데이터]
    - 채널명: ${channelName}
    - 채널 소개: ${descStr}
    - 수집된 영상 상세 리스트(최신순):
${videoInfoStr}

    [최종 판정 지침]
        - ** [미분류 절대 금지] **: '미분류'라는 선택지는 잊으십시오.위 세 카테고리(야담, 경제, 심리학) 중 조금이라도 가능성이 높은 쪽을 반드시 무조건 선택하십시오.
- ** [강제 할당] **: 만약 도저히 모르겠다면 채널명에서 풍기는 뉘앙스로라도 세 개 중 하나를 골라내십시오.
- ** [방송사 예외] **: 종합 방송사 채널이라도 현재 분석 중인 데이터가 특정 주제에 치우쳐 있다면 망설임 없이 해당 카테고리로 못 박으십시오.
- 결과물은 반드시 '야담', '경제', '심리학' 중 한 단어로만 응답하십시오.

        결과: `;

    const result = await callGemini(prompt, { useGoogleSearch: true });
    console.log(`[AI 분석 원본] 채널: ${channelName}, 결과: "${typeof result === 'string' ? result.trim() : 'non-string'}"`);
    if (!result || typeof result !== 'string') return null;

    const cleaned = result.trim().replace(/[. "']/g, '');
    console.log(`[AI 분석 정제]채널: ${channelName}, 정제: "${cleaned}"`);

    const isYadam = cleaned.includes('야담') || cleaned.includes('역사') || cleaned.includes('설화') || cleaned.includes('야사');
    const isEconomy = cleaned.includes('경제') || cleaned.includes('금융') || cleaned.includes('주식') || cleaned.includes('비즈니스') || cleaned.includes('재테크');
    const isPsychology = cleaned.includes('심리학') || cleaned.includes('심리') || cleaned.includes('마음') || cleaned.includes('멘탈');

    if (isEconomy) return '경제';
    if (isYadam) return '야담';
    if (isPsychology) return '심리학';

    // Fallback if AI still fails to follow instructions
    console.warn(`[AI 예외 발생] 분석 결과가 규격외입니다: "${cleaned}".`);
    return null;
}

/**
 * [Economy v3] Stage 1: Extract keywords from hit video titles and group them
 */
export async function extractEconomyKeywords(videoTitles = []) {
    if (videoTitles.length === 0) return [];

    // [Standardization] 제목 리스트를 가나다 순으로 정렬하여 입력 순서에 따른 AI 판단 흔들림 방지
    const sortedTitles = [...videoTitles].sort();

    const currentDate = new Date().toLocaleDateString();

    const prompt = `당신은 대한민국 최정상 경제 뉴스 데스크의 팩트 체크 팀장이자 
유튜브 경제 알고리즘의 '트렌드 포착' 최고 전문가입니다.

[분석 현재 시점]
오늘 날짜: ${currentDate} (이 날짜를 기준으로 가장 최신이고 뜨거운 이슈를 우선하십시오)

[분석 대상: 실제 유튜브 떡상 중인 경제 영상 제목 리스트]
${sortedTitles.join('\n')}

[미션: 트렌드 중심 키워드 추출 및 그룹화]
1. 제공된 제목 리스트를 분석하여, **현재 다수의 채널에서 동시에 다루고 있거나 조회수가 폭발적으로 상승 중인 '핵심 경제 이슈'**를 10~15개 도출하세요.
2. 각 키워드는 단순한 단어가 아닌, **시장의 흐름을 관통하는 구체적 주제**(예: "미국 금리 인하 수혜주 분석", "국내 증시 반등 신호탄")로 정의하십시오.
3. 아래의 '표준 카테고리 기둥'을 기반으로 하여, 현재 시점에서 가장 파급력이 큰 이슈부터 우선적으로 그룹화하세요:
   - 증시/주식, 거시경제/금리, 산업/기술(AI/반도체), 부동산, 코인, 정책/민생
4. 반드시 제공된 리스트 내의 제목들만 근거로 사용하십시오. 존재하지 않는 사실을 지어내지 마십시오.

[출력 형식 - 반드시 JSON 배열로만 응답하세요]
[
  {
    "keyword": "트렌디한 키워드 명칭",
    "video_count": 0,
    "titles": ["정확히 매칭되는 영상 제목들"]
  }
]

[주의사항]
- **최신성(Recency)과 빈도(Density)**가 높은 이슈를 상위 키워드로 배치하십시오.
- 절대로 1~2년 전 지난 이슈를 현재인 것처럼 그룹화하지 마십시오.
- 응답에 인사말 없이 JSON만 출력하십시오.`;

    const result = await callGemini(prompt, { jsonMode: true });

    if (result && result.errorType) {
        return result;
    }

    const parsed = parseGeminiJson(result, []);
    if (!parsed || parsed.length === 0) {
        console.warn('[extractEconomyKeywords] AI가 키워드를 추출하지 못했습니다. 원본 텍스트:', result);
    }

    // [Grounding] 2중 팩트 체크: 실제 제공된 제목 리스트와 대조하여 가짜 키워드/제목 필터링
    const normalize = t => t.trim().replace(/\s+/g, ' ');
    const validTitles = new Set(videoTitles.map(normalize));

    return (parsed || [])
        .map(item => {
            // AI가 리스트에 없는 제목을 지어낸 경우 걸러냄 (미세한 여백 차이는 허용)
            const groundedTitles = (item.titles || []).filter(t => validTitles.has(normalize(t)));
            if (groundedTitles.length === 0) return null;

            return {
                ...item,
                titles: groundedTitles,
                video_count: groundedTitles.length
            };
        })
        .filter(item => item !== null && item.keyword);
}

/**
 * [Economy v3] Stage 2: Analyze existing angles and suggest 10 differentiated topics
 */
export async function suggestEconomyTopics(keyword, existingVideos = []) {
    const titlesStr = existingVideos.map(v => `- [${v.view_count}회] ${v.title}`).join('\n');
    const currentDate = new Date().toLocaleDateString();

    const prompt = `당신은 20년 경력의 메이저 경제지 편집장 출신이자, 
100만 경제 유튜버의 기획을 총괄하는 콘텐츠 디렉터입니다.

[분석 현재 시점]
오늘 날짜: ${currentDate} (이 날짜를 기준으로 현재의 경제 상황과 정책을 정확히 반영하십시오)

[기초 데이터]
핵심 키워드: ${keyword}
기존 영상 리스트: 
${titlesStr}

[분석 및 기획 가이드라인 - 무관용 파편화(Zero-Tolerance Fragmentation) v4.1]
당신은 10명의 각기 다른 전문 채널 PD들에게 기획안을 하달하는 **고대의 집행관**입니다. 10개 주제 간의 **교집합은 곧 '생성 실패'**를 의미합니다.

1. **소재의 독점적 점유 (Resource Monopoly)**: 
   - '중동/지정학'은 전체 10개 중 **단 1개**만 점유할 수 있습니다.
   - 'HBM/반도체 수율'은 전체 10개 중 **단 1개**만 점유할 수 있습니다.
   - 나머지 8개는 반드시 [미국 금리 데이터, 국내 부동산 정책, 기업 실적 시뮬레이션, 역발상 심리 기술, 역사적 폭락 주기] 등 **관련성 제로**의 소재를 강제 할당하십시오.
2. **청사진별 시작 문법 강제 (Opening Blueprint)**: 제목과 오프닝에서 아래 패턴을 번갈아 사용하되, 타 주제와 **단 한 단어도 겹치지 않게** 하십시오.
   - [공시 낭독]: "오늘 오후 2시, 전자공시시스템에 올라온 이 한 줄..."
   - [데이터 폭로]: "1,200명의 자산가 데이터에서 공통된 균열이 발견되었습니다."
   - [현장 증언]: "지금 제가 서 있는 이 폐쇄된 공장 부지는..."
   - [역사 복기]: "1997년 외환위기 직전과 소름 끼칠 정도로 일치하는 지표가 있습니다."
3. **금지된 매너리즘 (Forbidden Mannerisms)**: 아래 단어/패턴은 10개 주제 전체에서 **사용 시 즉시 탈락**합니다.
   - [제목 패턴]: "지금 안 보면 ~", "자산이 녹아내린다", "충격/폭로/극비" (자극적 변형 허용하나 동일 문구 반복 금지)
   - [반전 화법]: "**대부분은/전문가는 ~라고 생각하지만 사실은 ~**" (이 구조를 0%로 박률하고 바로 본론의 팩트부터 박으십시오)
   - [날짜 표기]: 오프닝 첫 줄에 "2026년 3월 4일" 기계적 표기를 **전면 금지**하십시오.
4. **결착의 원자적 분산**: 모든 결론이 '현금 확보/포트폴리오 재편'으로 흐르지 않게 하십시오. [강력 손절], [대체 코인 이전], [공포 속 매수], [국채 보유], [부동산 청약 포기] 등 **결론의 물리적 결과값**을 찢어놓으십시오.

[출력 형식 - JSON으로만 응답하세요]
{
  "angle_analysis": "전문가가 지적한 'HBM, 중동, 하지만 사실은' 등의 무의식적 중복에 대한 강력한 반성 및 차단 전략",
  "suggestions": [
    {
      "title": "영상 제목 (팩트/시나리오 중심, 기계적 패턴 절대 금지)",
      "differentiation_reason": "독점 점유 소재 및 할당된 시작 문법 설명",
      "target_audience": "세밀하게 정의된 타겟",
      "conclusion_type": "낙관/비관/매도/보류/경고 등 극단적 분산",
      "primary_asset": "독점 소유 분석 대상 (타 주제 언급 금지)",
      "forbidden_keywords": ["중동", "HBM", "삼성전자", "유가", "지금 안 보면", "대부분은"],
      "narrative_blueprint": "공시 낭독/데이터 폭로/현장 증언 등 1:1 할당"
    }
  ]
}

[출력 형식 - JSON으로만 응답하세요]
{
  "angle_analysis": "기존 영상들의 각도 분포 요약 및 현재 시점의 핵심 팩트 분석",
  "suggestions": [
    {
      "title": "영상 제목 (팩트와 기획 의도가 담긴 문장 형태)",
      "differentiation_reason": "실시간 데이터 및 공식 자료 기준의 차별성",
      "target_audience": "구체적 타깃 시청자층",
      "conclusion_type": "낙관/비관/중립/대체투자 중 하나",
      "primary_asset": "이 주제가 점유한 핵심 분석 대상 (예: 삼성전자, 금, 비트코인 등)"
    }
  ]
}

[주의]
- 주제는 반드시 경제 유튜버가 바로 촬영에 들어갈 수 있을 정도로 구체적이어야 합니다.
- **절대 과거의 시제나 상황(예: 대통령 당선 전 상황 등)을 현재인 것처럼 혼동하지 마십시오.**
- JSON 외 다른 텍스트는 금지합니다.`;

    const result = await callGemini(prompt, { jsonMode: true });
    if (result && result.errorType) return result;
    return parseGeminiJson(result, { angle_analysis: '', suggestions: [] });
}

/**
 * [Economy v3] Stage 3: Generate detailed script skeleton
 */
export async function generateEconomySkeletonV3(topicTitle, keyword, existingTitles = [], top3Titles = [], diffReason = '', targetAudience = '', conclusionType = '', primaryAsset = '', forbiddenKeywords = [], narrativeBlueprint = '') {
    const currentDate = new Date().toLocaleDateString();

    const prompt = `당신은 경제 지식 전달의 대가이자 유튜브 체류 시간 극대화 설계 전문가입니다.

[분석 현재 시점]
오늘 날짜: ${currentDate} (이 날짜를 기점으로 시점이 어긋나지 않도록 설계하십시오)

[기획 기초 데이터]
선택한 주제: ${topicTitle}
 핵심 키워드: ${keyword}
**[메시지 방화벽 - 결론 지침]: 이 대본은 반드시 [${conclusionType || '자율'}] 관점에서 결론을 내야 합니다.**
**[메시지 방화벽 - 분석 대상]: 이 대본은 [${primaryAsset || '전체'}]를 집중 분석하십시오.**
**[메시지 방화벽 - 화법 청사진]: 이 대본은 반드시 [${narrativeBlueprint || '일반'}] 화법으로만 전개하십시오.**
**[메시지 방화벽 - 언급 금지]: [${(forbiddenKeywords || []).join(', ')}]와 관련된 내용은 5% 미만으로 제한하거나 아예 언급하지 마십시오.**
**[기획 각도]: ${diffReason || '없음'}**
**[타겟층]: ${targetAudience || '경제 시청자'}**
기존 유사 영상들: ${existingTitles.slice(0, 5).join(', ')}
최고 떡상 영상 3선: ${top3Titles.join(', ')}

[미션]
선택한 주제를 바탕으로 시청자가 끝까지 보고 '구독'까지 누르게 만드는 '고밀도 대본 뼈대'를 설계하십시오. 
모든 내용은 **오늘의 실시간 상황(예: 서킷브레이커, 정책 발표 등)**과 공식 데이터에 기반하여, 
시청자가 느끼는 현재의 위기감이나 기대감을 논리적으로 해소해 주어야 합니다.

[작업 원칙 - 무관용 파편화 v4.1]
1. **완결성 중독 해결 (배경 설명 0%)**: 시청자는 현재 상황(중동, 금리 등)을 이미 다 안다고 전제하십시오. 불필요한 시장 배경 설명을 1초라도 하면 실패입니다. 바로 할당된 **[화법 청사진]**의 입구로 직행하십시오.
2. **패턴 박멸 (반전 구조 금지)**: **"대부분은~ 사실은~"** 구조 발견 시 즉시 경고입니다. 대신 "데이터가 말해주는 결론은 단 하나였습니다", "현장에서 제 눈으로 본 광경은 이랬습니다" 등 청사진 고유의 문장으로 시작하십시오.
3. **소재의 배타적 고립**: **[언급 금지]** 키워드는 제목, 오프닝, 본론, 결론 전 영역에서 단 한 번도 쓰지 마십시오. 'HBM' 주제가 아니라면 '반도체'라는 단어조차 배제하고 다른 산업(부동산, 원유 등)의 성격에만 집중하십시오.
4. **제목의 고유 개성**: "자산이 녹아내린다"와 같은 식상한 공포 유발 문구를 타 주제와 중복 사용하지 마십시오. 할당된 **시나리오의 핵심 팩트**를 제목에 박으십시오. (예: "3nm 수율 12.8%의 충격, 삼성 내부 보고서 단독 입수")
5. **결론의 원자적 일치**: 할당된 **[결론 지침]**에만 충실하십시오. 중간 지점의 타협 없이 낙관이면 극강의 낙관, 매도면 극강의 공포 전략을 확실히 제시하십시오.

[출력 필수 항목]
1. 영상 제목 후보 10개: 팩트 기반의 고강도 후킹(공포/기회/예측)이 담긴 제목들
2. 15초 오프닝 멘트: 오늘의 긴박한 경제 상황을 인용한 충격적 화두 제시
3. 본론 전개 순서: 3~5단계로 구성, '팩트 분석 -> 원인 파악 -> 시청자 대응 전략' 구조
4. Retention Point (반전/인사이트): 시장의 통념을 뒤집는 데이터 기반의 예리한 분석
5. 클로징 멘트: 시청 소감 유도 및 행동 유도(Call to Action)
6. 예상 영상 길이 및 참고 데이터: 분석 시 확인한 실제 수치나 통계 지표(CPI, 금리, 실적 등)

[주의 형식 - JSON으로만 응답하세요]
{
  "titles": ["제목 1", "제목 2", ..., "제목 10"],
  "opening": "15초 오프닝 멘트 내용 (데이터 인용)",
  "body_steps": [
    { "step": 1, "message": "단계 내용", "benefit": "시청자 이득" }
  ],
  "retention_insight": "팩트 기반 반전 포인트",
  "closing": "클로징 멘트 내용",
  "estimated_duration": "예상 영상 길이",
  "key_data_to_check": ["확인할 공식 지표 1", "확인할 공식 지표 2"]
}

[작업 원칙]
- 절대 과거의 사건을 현재인 것처럼 표현하지 마십시오. (팩트 체크 엄격 수행)
- 모든 주장의 근거(정부 발표, 뉴스, 데이터 등)를 내용 속에 녹여내십시오.
- JSON 외 다른 텍스트는 금지합니다.`;

    const result = await callGemini(prompt, { jsonMode: true });
    if (result && result.errorType) return result;
    return parseGeminiJson(result, { titles: [], opening: '', body_steps: [], retention_insight: '', closing: '', estimated_duration: '', key_data_to_check: [] });
}

/**
 * [Economy v3] Stage 2.5: Generate 3 Catchy Thumbnail Title Candidates
 */
export async function getThumbnailTitlesV3(topicTitle, keyword, existingTitles = []) {
    const currentDate = new Date().toLocaleDateString();

    const prompt = `당신은 유튜브 클릭율(CTR)을 극대화하는 썸네일 카피라이팅 전문가입니다.

[분석 현재 시점]
오늘 날짜: ${currentDate}

[기획 주제]
주제: ${topicTitle}
키워드: ${keyword}
기존 영상 제목들: ${existingTitles.slice(0, 5).join(', ')}

[미션]
위 주제를 바탕으로 시청자가 누르지 않고는 못 배기는 **실시간 팩트 기반의 '극강의 자극적 후킹' 썸네일 제목 10개**를 제안하십시오.

[작업 원칙]
1. **신뢰와 자극의 합의**: 공식 자료와 수치를 뼈대로 하되, 시청자의 **공포, 후회, 일생일대의 선택** 등 강렬한 감정을 자극하는 카피를 사용하십시오.
2. **허위 확정 배제**: "300% 폭등 확정", "무조건 매수" 같은 투자 권유나 허위 사실은 절대 금지합니다.
3. **실시간 긴박감**: 오늘 벌어진 **서킷브레이커, 금리 변동, 정부 발표** 등 가장 뜨거운 팩트를 제목의 '이유'로 삼으십시오.
4. **고급 후킹**: "당신만 몰랐던", "지금 안 보면 내 자산 녹아내린다", "부의 재편 시작" 등 클릭하지 않고는 못 배길 수준의 강력한 언어를 사용하십시오.

[출력 형식 - JSON 배열로만 응답하세요]
{
  "candidates": [
    "제목 1 (근거 중심)",
    "제목 2 (수치 중심)",
    ...
    "제목 10"
  ]
}

[주의]
- JSON 외 다른 텍스트는 금지합니다.`;

    const result = await callGemini(prompt, { jsonMode: true });
    if (result && result.errorType) return result;
    return parseGeminiJson(result, { candidates: [] });
}

export async function suggestMaterials(categoryName) {
    const prompt = `당신은 유튜브 콘텐츠 분석 전문가입니다.

"${categoryName}" 카테고리의 유튜브 채널에서 다루는
대표적인 콘텐츠 소재(주제)를 정확히 7개 추천해주세요.

- 소재명은 2~6글자, 한글, 슬래시로 구분 가능 (예: 주식/투자)
- 반드시 아래 JSON 형식으로만 응답:
{"materials": ["소재명1", "소재명2", "소재명3", "소재명4", "소재명5", "소재명6", "소재명7"]}`;

    try {
        const result = await callGemini(prompt, { jsonMode: true });
        const parsed = parseGeminiJson(result);
        if (!parsed || !parsed.materials || !Array.isArray(parsed.materials)) {
            throw new Error('AI 응답을 파싱할 수 없습니다. 다시 시도해주세요.');
        }
        return parsed.materials;
    } catch (err) {
        console.error('[Gemini 소재추천] 오류:', err.message);
        throw err;
    }
}

export async function suggestKeywords(categoryName, materialName) {
    const prompt = `"${categoryName}" 카테고리의 "${materialName}" 소재에 해당하는 YouTube 영상을 자동 분류하기 위한 키워드를 추천해주세요.

키워드 작성 규칙:
- 해당 소재의 YouTube 영상 제목/설명에 자주 등장하는 핵심 단어
- 다른 소재와 중복되지 않는 고유한 키워드 우선
- 2~6글자의 한글 또는 영문 약어 (예: ETF, IRP, PER)
- 너무 일반적인 단어(영상, 채널, 구독, 좋아요 등) 제외
- 동의어, 유의어, 관련 전문용어를 최대한 포함
- 최소 50개, 최대 100개

키워드만 쉼표로 구분하여 한 줄로 나열해주세요. 다른 설명 없이 키워드만 출력:`;

    try {
        const result = await callGemini(prompt, { jsonMode: false });
        if (!result || result.trim().length === 0) {
            throw new Error('빈 응답: ' + materialName);
        }
        const keywords = result
            .split(',')
            .map(k => k.trim().replace(/[\[\]"{}]/g, ''))
            .filter(k => k.length > 0 && k.length <= 20);

        if (keywords.length === 0) {
            throw new Error('키워드 추출 실패: ' + materialName);
        }
        console.log(`[키워드추천] ${materialName}: ${keywords.length}개 성공`);
        return keywords;
    } catch (e) {
        console.error('[키워드추천] 오류:', materialName, e.message);
        throw e;
    }
}

/**
 * 미분류 영상을 소재로 AI 분류
 * @param {Array} videos - [{ id, title }] 배열 (최대 100건)
 * @param {string[]} materialNames - 소재명 목록
 * @returns {Array} [{ videoIndex, videoId, category, isDelete, keywords }]
 */
export async function classifyUnclassifiedVideos(videos, materialNames) {
    const videoLines = videos.map((v, i) => `${i + 1}. ${v.title}`).join('\n');
    const materialList = materialNames.join(', ');

    const prompt = `당신은 YouTube 영상 분류 전문가입니다.

아래 영상 제목들을 다음 소재 중 하나로 분류해주세요.
소재 목록: ${materialList}

규칙:
- 어떤 소재에도 해당하지 않으면 "삭제"로 표시
- 분류 근거가 되는 핵심 키워드를 1~3개 추출 (2~6글자, 한글)
- 이 키워드는 향후 자동 분류에 사용됩니다

응답 형식 (각 영상을 한 줄로, | 구분):
번호|소재명|키워드1,키워드2
해당 소재 없으면:
번호|삭제|

영상 목록:
${videoLines}`;

    const result = await callGemini(prompt, { jsonMode: false, maxTokens: 65536 });

    if (!result || result.trim().length === 0) {
        throw new Error('빈 응답');
    }

    const lines = result.trim().split('\n').filter(l => l.includes('|'));
    const parsed = [];

    for (const line of lines) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 2) continue;

        const index = parseInt(parts[0], 10) - 1;
        if (isNaN(index) || index < 0 || index >= videos.length) continue;

        const category = parts[1];
        const keywords = parts[2]
            ? parts[2].split(',').map(k => k.trim()).filter(k => k.length >= 2 && k.length <= 6)
            : [];

        parsed.push({
            videoIndex: index,
            videoId: videos[index].id,
            category,
            isDelete: category === '삭제',
            keywords
        });
    }

    console.log(`[AI분류] 파싱 완료: ${parsed.length}건 (분류 ${parsed.filter(p => !p.isDelete).length}, 삭제 ${parsed.filter(p => p.isDelete).length})`);
    return parsed;
}

