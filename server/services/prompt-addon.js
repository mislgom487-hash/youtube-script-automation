/**
 * Prompt Addon Utility
 * 추출된 DNA 정보를 기존 AI 프롬프트에 구조적으로 접목합니다.
 */

/**
 * 기존 프롬프트에 DNA 컨텍스트를 추가합니다.
 * @param {string} basePrompt - 기본 프롬프트
 * @param {object} dnaSummary - extractSpikeDNA에서 반환된 DNA 통계 객체
 */
export function attachDNAContextToPrompt(basePrompt, dnaSummary) {
    if (!dnaSummary) return basePrompt;

    const dnaText = JSON.stringify(dnaSummary, null, 2);

    return [
        basePrompt,
        "",
        "[추가 컨텍스트: 떡상 DNA 요약]",
        "- 아래 DNA는 떡상(이상치) 영상에서 추출된 ‘구조 특징’이다.",
        "- 키워드 나열이 아니라, 관계/사건/감정/반전 패턴을 빈틈 주제 추천에 ‘접목’하라.",
        "- 단, 기존 포화 주제와 유사한 조합은 회피하고(유사도 높으면 재조합), 더 희소한 조합을 우선한다.",
        "",
        dnaText
    ].join("\n");
}
