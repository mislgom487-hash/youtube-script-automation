/**
 * Advanced DNA Extractor
 * Gemini AI 기반 5종 구조화 DNA 추출 + 황금 키워드 + 그룹 DNA 합산
 */
import { callGemini } from './gemini-service.js';

// ─────────────────────────────────────────────
// 1) 단일/복수 영상 → 5종 DNA 추출
// ─────────────────────────────────────────────
export async function extractAdvancedDNA(videos, category = '야담') {
    if (!videos || videos.length === 0) return null;

    // 분석 텍스트 조합 (전체 자막 원문 우선)
    const corpus = videos.slice(0, 20).map((v, i) => {
        const transcript = v.transcript_raw || v.transcript_summary || '';
        const content = transcript || [v.title, v.description].filter(Boolean).join(' ');
        const commentStr = v.comments?.length
            ? `\n\n[시청자 인기 댓글 TOP ${v.comments.length}개]\n` +
              v.comments.map((c, j) => `${j + 1}. "${c.text}" (좋아요 ${c.like_count}개)`).join('\n')
            : '\n\n[댓글 없음]';
        return `[영상${i + 1}] 제목: "${v.title}" | 조회수: ${(v.view_count || 0).toLocaleString()} | 전체 자막 원문:\n${content}${commentStr}`;
    }).join('\n\n---\n\n');

    const prompt = `당신은 유튜브 영상 성공 요인 분석 전문가입니다.
아래 떡상 영상(카테고리: ${category})의 전체 자막과 시청자 댓글을 분석하여
이 영상이 왜 성공했는지 깊이 분석하세요.

[분석 대상]
${corpus}

분석 시 반드시 아래 기준으로 각 항목을 0~100점으로 평가하세요:

■ 후킹력 (첫 10초에 시청자를 잡는 힘)
- 도입부 문장이 궁금증을 유발하는가?
- 오프닝에 결과 암시, 질문, 충격 요소가 있는가?
- 시청자가 "더 보고 싶다"고 느끼게 만드는가?

■ 구조력 (이야기 전개가 얼마나 탄탄한가)
- 도입→전개→위기→반전→정리 흐름이 명확한가?
- 클라이맥스 위치가 적절한가?
- 각 구간의 비율이 지루하지 않은가?

■ 감정력 (시청자 감정을 얼마나 흔드는가)
- 분노, 안타까움, 희망, 통쾌함 등 감정 변화가 있는가?
- 감정 곡선의 진폭이 충분한가?
- 피크 포인트에서 감정이 최고조에 달하는가?

■ 몰입도 (끝까지 보게 만드는 힘)
- 짧고 리듬감 있는 문장을 사용하는가?
- 적절한 질문과 반복으로 집중을 유지하는가?
- 중간에 이탈할 만한 지루한 구간이 없는가?

■ 제목력 (클릭하고 싶게 만드는 힘)
- 제목에 궁금증 유발 요소가 있는가?
- 썸네일 텍스트와 조합이 효과적인가?
- CTA(행동유도) 단어가 적절한가?

반드시 아래 JSON 형식 딱 하나만 응답하세요 (다른 텍스트 절대 없음):
※ scores는 영상 실제 내용을 분석하여 산출하세요. 예시 값을 그대로 사용하지 마세요. 각 항목은 0~100 정수이며 영상마다 다른 점수가 나와야 합니다.
{
  "scores": {
    "hooking": "<영상 도입부의 시청자 관심 유도력 0~100 정수>",
    "structure": "<영상 전체 구성과 전개의 완성도 0~100 정수>",
    "emotion": "<감정 자극 및 공감 유발 정도 0~100 정수>",
    "immersion": "<시청 지속을 유도하는 몰입감 0~100 정수>",
    "title": "<제목의 클릭 유도력과 적절성 0~100 정수>",
    "overall": "<hooking*0.25 + structure*0.2 + emotion*0.25 + immersion*0.15 + title*0.15 의 가중 평균 0~100 정수>"
  },
  "success_summary": "이 영상이 성공한 핵심 이유를 시청자도 이해할 수 있는 쉬운 말로 3~5문장으로 설명. 전문 용어 사용 금지. 예: '첫 문장에서 바로 궁금증을 만들었고, 중간에 반전이 있어서 끝까지 보게 됩니다.'",
  "comment_analysis": {
    "positive": ["시청자가 좋아한 점 1", "시청자가 좋아한 점 2", "시청자가 좋아한 점 3"],
    "negative": ["아쉬운 점 또는 개선 요청 1", "아쉬운 점 2"],
    "comment_summary": "댓글을 종합한 시청자 반응 요약 1~2문장"
  },
  "hook_dna": {
    "hook_type": "결과암시 | 질문 | 충격 | 결론부분공개 | 스토리시작 | 경고 중 하나",
    "hook_sentences": ["상위 후킹 문장 1", "상위 후킹 문장 2", "상위 후킹 문장 3"],
    "open_loop": ["미공개 요소1", "미공개 요소2"]
  },
  "structure_dna": {
    "structure_type": "야담 | 경제 | 심리 중 하나",
    "sections": [
      { "name": "도입", "goal": "시청자 훅", "duration_pct": 10, "key_question": "왜 봐야 하는가?" },
      { "name": "전개", "goal": "갈등 상승", "duration_pct": 40, "key_question": "무슨 일이 벌어지는가?" },
      { "name": "위기", "goal": "최고조", "duration_pct": 20, "key_question": "결말은?" },
      { "name": "반전", "goal": "충격 반전", "duration_pct": 20, "key_question": "예상 밖의 결말?" },
      { "name": "정리", "goal": "교훈/마무리", "duration_pct": 10, "key_question": "시청자가 얻는 것은?" }
    ],
    "climax_position": 75,
    "payoff_type": "반전 | 교훈 | 해결 | 정의구현 | 현실자각 중 하나"
  },
  "emotion_dna": {
    "emotion_curve": [
      { "position_pct": 0,  "tension": 30, "anxiety": 20, "hope": 40, "anger": 10, "relief": 60 },
      { "position_pct": 25, "tension": 60, "anxiety": 50, "hope": 30, "anger": 40, "relief": 20 },
      { "position_pct": 50, "tension": 80, "anxiety": 70, "hope": 20, "anger": 70, "relief": 10 },
      { "position_pct": 75, "tension": 95, "anxiety": 90, "hope": 15, "anger": 90, "relief": 5  },
      { "position_pct": 100,"tension": 30, "anxiety": 10, "hope": 90, "anger": 20, "relief": 95 }
    ],
    "peak_points": ["70~80% 구간 — 반전 폭로 순간"],
    "drop_points": ["30~40% 구간 — 전개 지루함 위험"]
  },
  "pace_dna": {
    "sentence_length_avg": 18,
    "short_sentence_ratio": 0.45,
    "question_frequency": 3.2,
    "repetition_keywords": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"],
    "taboo_flags": []
  },
  "title_dna": {
    "title_pattern": "손해회피 | 타이밍불안 | 반전 | 개인영향 | 비밀폭로 | 경고 중 하나",
    "thumbnail_text_pattern": "충격 + 결과 + 반전 (3~6단어)",
    "cta_words": ["충격", "실화", "반전", "비밀", "결말"]
  }
}

주의사항:
1. scores의 각 항목은 반드시 실제 영상 내용을 근거로 산출한 0~100 정수값으로 응답하세요. JSON 템플릿의 문자열 설명을 그대로 넣지 마세요.
2. scores.overall은 hooking*0.25 + structure*0.20 + emotion*0.25 + immersion*0.15 + title*0.15의 가중 평균으로 계산하세요.
3. success_summary는 반드시 쉬운 일상 언어로 작성하세요. "후킹", "클라이맥스", "CTA" 같은 전문 용어를 사용하지 마세요.
4. comment_analysis는 실제 댓글 내용을 기반으로 작성하세요. 댓글이 없으면 positive와 negative를 빈 배열로, comment_summary를 "댓글 데이터 없음"으로 설정하세요.
5. JSON 외 다른 텍스트를 절대 포함하지 마세요.`;

    try {
        const raw = await callGemini(prompt, { jsonMode: true, timeout: 180000, maxTokens: 16384 });
        if (!raw || typeof raw !== 'string') return null;
        const jsonStr = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        // 점수 검증 및 보정
        if (parsed.scores) {
            const s = parsed.scores;
            ['hooking', 'structure', 'emotion', 'immersion', 'title'].forEach(key => {
                if (typeof s[key] !== 'number' || s[key] < 0 || s[key] > 100) s[key] = 0;
                s[key] = Math.round(s[key]);
            });
            // 종합 점수 재계산 (Gemini 계산 오류 방지)
            s.overall = Math.round(
                s.hooking * 0.25 +
                s.structure * 0.20 +
                s.emotion * 0.25 +
                s.immersion * 0.15 +
                s.title * 0.15
            );
        } else {
            const hookScore = parsed.hook_dna?.hook_strength_score || 0;
            parsed.scores = {
                hooking: hookScore,
                structure: 0,
                emotion: 0,
                immersion: 0,
                title: 0,
                overall: Math.round(hookScore * 0.25)
            };
        }

        // comment_analysis 없으면 기본값
        if (!parsed.comment_analysis) {
            parsed.comment_analysis = {
                positive: [],
                negative: [],
                comment_summary: '댓글 데이터 없음'
            };
        }

        // success_summary 없으면 기본값
        if (!parsed.success_summary) {
            parsed.success_summary = '분석 요약을 생성하지 못했습니다.';
        }

        return {
            ...parsed,
            _meta: {
                videoCount: videos.length,
                category,
                analyzedAt: new Date().toISOString(),
                sampleTitles: videos.slice(0, 5).map(v => v.title).filter(Boolean)
            }
        };
    } catch (e) {
        console.error('[AdvancedDNA] 파싱 실패:', e.message);
        return null;
    }
}

// ─────────────────────────────────────────────
// 2) DNA → 황금 키워드 추출
// ─────────────────────────────────────────────
export async function extractGoldenKeywords(dna) {
    if (!dna) return [];

    // 기존 pace_dna.repetition_keywords + title_dna.cta_words를 기반으로 AI가 정제
    const rawKeywords = [
        ...(dna.pace_dna?.repetition_keywords || []),
        ...(dna.title_dna?.cta_words || []),
        ...(dna.hook_dna?.open_loop || []),
    ].join(', ');

    const prompt = `당신은 유튜브 콘텐츠 마케팅 전문가입니다.
아래는 떡상 영상들의 DNA에서 추출된 키워드 목록입니다:
[원시 키워드]: ${rawKeywords}

[Hook 유형]: ${dna.hook_dna?.hook_type || ''}
[감정 절정]: ${dna.emotion_dna?.peak_points?.join(', ') || ''}
[구조 유형]: ${dna.structure_dna?.structure_type || ''}
[제목 패턴]: ${dna.title_dna?.title_pattern || ''}

위 데이터를 종합하여, 썸네일 제목에 바로 쓸 수 있는 **황금 키워드 15개**를 선별/정제하세요.
형용사·명사·동사 조합으로 제목 후킹에 최적화된 단어들이어야 합니다.

반드시 아래 JSON만 응답하세요:
{
  "golden_keywords": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5",
                       "키워드6", "키워드7", "키워드8", "키워드9", "키워드10",
                       "키워드11", "키워드12", "키워드13", "키워드14", "키워드15"],
  "keyword_reason": "이 키워드들이 황금인 이유를 한 문장으로"
}`;

    try {
        const raw = await callGemini(prompt, { jsonMode: true });
        if (!raw || typeof raw !== 'string') return [];
        const jsonStr = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        return parsed;
    } catch (e) {
        console.error('[GoldenKeywords] 파싱 실패:', e.message);
        return { golden_keywords: [], keyword_reason: '' };
    }
}

// ─────────────────────────────────────────────
// 3) 황금 키워드 + DNA + 주제(Topic) → 썸네일 후킹 제목 10개 추천
// ─────────────────────────────────────────────
export async function recommendTitles(dna, goldenKeywords, category = '야담', topic = '') {
    const keywords = goldenKeywords?.golden_keywords || goldenKeywords || [];
    const keywordStr = keywords.join(', ');

    const prompt = `당신은 유튜브 구독자 100만 채널의 썸네일·제목 전문 카피라이터입니다.

[사용자 요청 주제]: "${topic}"

[DNA 분석 결과 요약]
- 후킹 유형: ${dna.hook_dna?.hook_type}
- 구조 유형: ${dna.structure_dna?.structure_type}
- 제목 패턴: ${dna.title_dna?.title_pattern}
- 페이오프: ${dna.structure_dna?.payoff_type}
- 황금 키워드: ${keywordStr}
- 카테고리: ${category}

위 [사용자 요청 주제]의 핵심 소재(예: 맹인, 점쟁이, 왕의 비밀 등)를 반드시 유지하면서, 클릭률(CTR)을 극대화할 수 있는 **썸네일·후킹 제목 10개**를 생성하세요.

규칙:
1. **[사용자 요청 주제]의 주인공이나 핵심 소재를 절대 바꾸지 마십시오.** (예: 맹인 이야기면 제목에도 맹인이나 관련 표현이 들어가야 함)
2. 제목은 15~30자 이내 (너무 길면 썸네일에서 잘림)
3. 황금 키워드를 최소 2개 이상 포함
4. 기존에 없는 신선한 각도로 (기존 인기 영상과 완전히 다른 주제)
5. 10개 중 1~2개는 ${category === '야담' ? '가난뱅이/절름발이/맹인/거지 등 파격적 조선 민중 언어' : '파격적 표현'}을 제목에 포함하여 원본 주제를 더 자극적으로 만드세요.
6. 각 제목 뒤에 예상 CTR 점수(0~100)와 한 줄 이유를 붙이세요

반드시 아래 JSON만 응답하세요:
[
  {
    "title": "후킹 제목 1",
    "ctr_score": 92,
    "reason": "이 제목이 클릭될 이유"
  }
]`;

    try {
        // jsonMode: true — google_search 그라운딩 텍스트가 섞이면 JSON.parse 실패 → useGoogleSearch 금지
        const raw = await callGemini(prompt, { jsonMode: true });
        if (!raw || typeof raw !== 'string') return [];
        const jsonStr = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        return Array.isArray(parsed) ? parsed.slice(0, 10) : [];
    } catch (e) {
        console.error('[RecommendTitles] 파싱 실패:', e.message);
        return [];
    }
}

// ─────────────────────────────────────────────
// 5) 여러 영상의 DNA → 그룹 DNA 합산
// ─────────────────────────────────────────────
export function buildGroupDNA(dnaResults) {
    const valid = dnaResults.filter(Boolean);
    if (valid.length === 0) return null;

    // hook_type 빈도 집계
    const hookTypes = {};
    valid.forEach(d => {
        const t = d.hook_dna?.hook_type;
        if (t) hookTypes[t] = (hookTypes[t] || 0) + 1;
    });

    // structure_type 빈도 집계
    const structTypes = {};
    valid.forEach(d => {
        const t = d.structure_dna?.structure_type;
        if (t) structTypes[t] = (structTypes[t] || 0) + 1;
    });

    // climax_position 평균
    const climaxAvg = Math.round(
        valid.reduce((s, d) => s + (d.structure_dna?.climax_position || 75), 0) / valid.length
    );

    // 반복 키워드 합산
    const kwMap = {};
    valid.forEach(d => {
        (d.pace_dna?.repetition_keywords || []).forEach(k => {
            kwMap[k] = (kwMap[k] || 0) + 1;
        });
    });
    const topKeywords = Object.entries(kwMap)
        .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);

    // title_pattern 빈도
    const titlePatterns = {};
    valid.forEach(d => {
        const t = d.title_dna?.title_pattern;
        if (t) titlePatterns[t] = (titlePatterns[t] || 0) + 1;
    });

    return {
        total_analyzed: valid.length,
        top_hook_types: Object.entries(hookTypes).sort((a, b) => b[1] - a[1])
            .map(([type, count]) => ({ type, count, ratio: Math.round(count / valid.length * 100) + '%' })),
        common_structure: Object.entries(structTypes).sort((a, b) => b[1] - a[1])[0]?.[0] || '야담',
        climax_position_avg: climaxAvg,
        common_repetition_keywords: topKeywords,
        top_title_patterns: Object.entries(titlePatterns).sort((a, b) => b[1] - a[1])
            .slice(0, 5).map(([pattern, count]) => ({ pattern, count })),
        generated_at: new Date().toISOString()
    };
}
