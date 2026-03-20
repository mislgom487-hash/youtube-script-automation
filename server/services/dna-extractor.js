/**
 * DNA Extractor Utility
 * 떡상 영상들에서 주요 패턴(관계, 사건, 감정, 반전)을 딕셔너리 기반으로 통계 추출합니다.
 */

const REL = ["시어머니", "남편", "아내", "아들", "딸", "친구", "상사", "동료", "가족", "어머니", "아버지"];
const EVT = ["병원", "보험금", "유산", "간병", "상속", "장례", "이혼", "불륜", "배신", "사기", "폭력", "실종", "빚", "해고", "퇴사"];
const EMO = ["분노", "충격", "눈물", "감동", "공포", "억울", "복수", "후회", "감사"];
const TWIST = ["녹음", "CCTV", "문자", "증거", "유서", "비밀", "정체", "거짓말", "반전", "폭로"];

function countHits(text, dict) {
    const t = (text || "").toLowerCase();
    let hits = [];
    for (const w of dict) {
        if (t.includes(w.toLowerCase())) hits.push(w);
    }
    return hits;
}

function addCount(map, arr) {
    for (const k of arr) map.set(k, (map.get(k) || 0) + 1);
}

function topN(map, n = 8) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ k, c }));
}

/**
 * 떡상 영상들의 제목, 설명 등을 분석하여 구조적 패턴을 요약합니다.
 */
export function extractSpikeDNA(spikes, { topNSize = 6 } = {}) {
    const relMap = new Map();
    const evtMap = new Map();
    const emoMap = new Map();
    const twMap = new Map();

    for (const v of spikes) {
        // 제목, 설명, 그리고 자막 요약(transcript_summary) 등을 합쳐서 분석
        const text = [v.title, v.description, v.transcript_summary, v.scriptText].filter(Boolean).join(" ");
        addCount(relMap, countHits(text, REL));
        addCount(evtMap, countHits(text, EVT));
        addCount(emoMap, countHits(text, EMO));
        addCount(twMap, countHits(text, TWIST));
    }

    return {
        dna: {
            relationshipTop: topN(relMap, topNSize),
            eventTop: topN(evtMap, topNSize),
            emotionTop: topN(emoMap, topNSize),
            twistTop: topN(twMap, topNSize),
        },
        spikesMeta: {
            totalSpikes: spikes.length,
            sampleTitles: spikes.slice(0, 5).map(v => v.title).filter(Boolean),
        }
    };
}

/**
 * DNA 객체를 AI 프롬프트에 넣기 좋은 문자열로 변환합니다.
 */
export function formatDNAForPrompt(dnaResult) {
    if (!dnaResult || !dnaResult.dna) return "";

    const { dna } = dnaResult;
    const parts = [];

    if (dna.relationshipTop.length)
        parts.push(`주요 관계: ${dna.relationshipTop.map(i => `${i.k}(${i.c}회)`).join(', ')}`);
    if (dna.eventTop.length)
        parts.push(`핵심 사건: ${dna.eventTop.map(i => `${i.k}(${i.c}회)`).join(', ')}`);
    if (dna.emotionTop.length)
        parts.push(`감정 키워드: ${dna.emotionTop.map(i => `${i.k}(${i.c}회)`).join(', ')}`);
    if (dna.twistTop.length)
        parts.push(`반전/장치: ${dna.twistTop.map(i => `${i.k}(${i.c}회)`).join(', ')}`);

    return parts.join(' | ');
}
