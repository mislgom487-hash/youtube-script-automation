/**
 * Spike Selector Utility
 * 채널별 평균 데이터를 기반으로 성과가 비정상적으로 높은(Spike) 영상을 선별합니다.
 */

/**
 * 채널의 조의수 베이스라인(중앙값 및 70% 지점)을 계산합니다.
 */
export function calcChannelBaseline(videos) {
    const views = videos.map(v => Number(v.viewCount || v.view_count || 0)).filter(n => Number.isFinite(n));
    if (views.length === 0) return { medianViews: 0, p70Views: 1 };

    views.sort((a, b) => a - b);
    const median = views[Math.floor(views.length * 0.5)];
    const p70 = views[Math.floor(views.length * 0.7)] || median;

    return { medianViews: median, p70Views: p70 || 1 };
}

/**
 * 개별 영상의 떡상 점수를 계산합니다.
 */
export function spikeScore(video, baseline) {
    const views = Number(video.viewCount || video.view_count || 0);
    const comments = Number(video.commentCount || video.comment_count || 0);
    const ratio = views / Math.max(1, baseline.p70Views);

    // 댓글 밀도 (참여도 지표)
    const commentDensity = comments / Math.max(1, views);

    // 최근성 가중치: 30일 이래 영상에 30% 가중치
    const publishedAt = video.publishedAt || video.published_at;
    const days = publishedAt ? (Date.now() - new Date(publishedAt).getTime()) / 86400000 : 999;
    const recency = days <= 30 ? 1.3 : 1.0;

    // 최종 점수: 배수 * (1 + 참여도 기여) * 최근성
    return ratio * (1 + Math.min(1, commentDensity / 0.005)) * recency;
}

/**
 * 전체 영상 목록에서 떡상 영상들을 추려냅니다.
 */
export function pickSpikeVideos(videos, { minRatio = 5, topPercent = 0.2 } = {}) {
    if (!videos || videos.length === 0) return { baseline: { medianViews: 0, p70Views: 1 }, spikes: [] };

    const baseline = calcChannelBaseline(videos);

    const scored = videos.map(v => {
        const views = Number(v.viewCount || v.view_count || 0);
        const ratio = views / Math.max(1, baseline.p70Views);
        return {
            ...v,
            __ratio: ratio,
            __spikeScore: spikeScore(v, baseline),
        };
    });

    // 1) 최소 배수 필터 (베이스라인 대비 5배 이상)
    let filtered = scored.filter(v => v.__ratio >= minRatio);

    // 2) 만약 5배수 이상이 하나도 없다면, 상대적으로 높은 상위 영상들이라도 고려 (유연성 확보)
    if (filtered.length === 0) {
        filtered = scored.filter(v => v.__ratio >= 2);
    }

    // 3) 상위 퍼센트 선정
    filtered.sort((a, b) => b.__spikeScore - a.__spikeScore);
    const cut = Math.max(1, Math.floor(filtered.length * topPercent));

    return {
        baseline,
        spikes: filtered.slice(0, cut),
    };
}
