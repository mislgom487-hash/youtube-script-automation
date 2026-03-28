// API client — all backend communication
const API_BASE = '/api';

async function request(path, options = {}) {
    const { method = 'GET', body, params, signal, keepalive } = options;
    let url = `${API_BASE}${path}`;
    if (params) {
        const q = new URLSearchParams(params).toString();
        url += `?${q}`;
    }
    const fetchOptions = { method, headers: { 'Content-Type': 'application/json' }, signal };
    if (keepalive) fetchOptions.keepalive = true;
    if (body) fetchOptions.body = JSON.stringify(body);

    const res = await fetch(url, fetchOptions);

    let data = {};
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        data = await res.json();
    } else {
        const text = await res.text();
        if (!res.ok) throw new Error(`Server Error (${res.status}): ${text.slice(0, 100)}...`);
    }

    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

export const api = {
    request,
    // Health
    health: () => request('/health'),

    // Channels
    getChannels: () => request('/channels'),
    getChannelIds: () => request('/channels/ids'),
    getChannelCategories: () => request('/channels/categories'),
    addCategory: (name, subTypeMode) => request('/channels/categories', { method: 'POST', body: { name, sub_type_mode: subTypeMode || 'none' } }),
    deleteCategory: (name) => request(`/channels/categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    reorderCategories: (order) => request('/channels/categories/reorder', { method: 'PUT', body: { order } }),
    previewChannel: (input) => request('/channels/preview', { method: 'POST', body: { input } }),
    addChannel: (data) => request('/channels', { method: 'POST', body: data }),
    deleteChannel: (id, reason, reasonDetail) => request(`/channels/${id}`, { method: 'DELETE', body: { reason: reason || '이유없음', reasonDetail: reasonDetail || null } }),
    getDeletedChannels: (groupTag, subType, sort, reason, keyword) => {
        const p = new URLSearchParams();
        if (groupTag) p.set('group_tag', groupTag);
        if (subType) p.set('sub_type', subType);
        if (sort) p.set('sort', sort);
        if (reason) p.set('reason', reason);
        if (keyword) p.set('keyword', keyword);
        return request(`/channels/deleted/list?${p.toString()}`);
    },
    getChannelCategorizedVideos: (id) => request(`/channels/${id}/categorized-videos`),
    updateChannelGroup: (id, group_tag) => request(`/channels/${id}/group`, { method: 'PUT', body: { group_tag } }),
    bulkUpdateSubType: (channelIds, subType) => request('/channels/bulk-subtype', { method: 'PUT', body: { channelIds, subType } }),
    restoreChannel: (deletedId) => request(`/channels/restore/${deletedId}`, { method: 'POST' }),
    deleteChannelByYoutubeId: (channelId) => request(`/channels/by-youtube-id/${channelId}`, { method: 'DELETE' }),
    updateDeleteReason: (deletedId, reason, reasonDetail) => request(`/channels/deleted/${deletedId}/reason`, { method: 'PUT', body: { reason, reasonDetail } }),
    autoCategorizeAllChannels: () => request('/channels/auto-categorize-all', { method: 'POST' }),
    refreshSubscribers: (channelIds) => request('/channels/refresh-subscribers', { method: 'POST', body: { channelIds } }),
    getCategoryKeywords: (category, tab) => request(`/channels/keywords/${encodeURIComponent(category)}`, { params: { tab: tab || 'video' } }),
    addCategoryKeyword: (category, keyword, tab) => request(`/channels/keywords/${encodeURIComponent(category)}`, { method: 'POST', body: { keyword, tab_type: tab || 'video' } }),
    deleteCategoryKeyword: (category, id) => request(`/channels/keywords/${encodeURIComponent(category)}/${id}`, { method: 'DELETE' }),
    reorderCategoryKeywords: (category, orderedIds) => request(`/channels/keywords/${encodeURIComponent(category)}/reorder`, { method: 'PUT', body: { orderedIds } }),

    // YouTube fetch
    fetchChannelVideos: (channelId, maxResults) => request(`/youtube/fetch/${channelId}`, { method: 'POST', body: { maxResults } }),
    getFetchStatus: (channelId) => request(`/youtube/status/${channelId}`),
    getAllFetchStatuses: () => request('/youtube/status-all'),
    cancelFetch: (channelId) => request(`/youtube/cancel/${channelId}`, { method: 'POST' }),

    // Videos
    getVideos: (params) => request('/videos', { params }),
    getVideo: (id) => request(`/videos/${id}`),
    updateMemo: (id, memo) => request(`/videos/${id}/memo`, { method: 'PUT', body: { memo } }),
    updateVideoCategories: (id, categoryIds) => request(`/videos/${id}/categories`, { method: 'PUT', body: { category_ids: categoryIds } }),
    deleteVideo: (id) => request(`/videos/${id}`, { method: 'DELETE' }),
    addVideoManual: (data) => request('/videos/manual', { method: 'POST', body: data }),
    checkExistingVideos: (videoIds) => request('/videos/check-existing', { method: 'POST', body: { videoIds } }),
    rebuildVideoRankings: (groupTag) => request('/videos/rebuild-rankings', { method: 'POST', body: { groupTag } }),
    getUnclassifiedVideos: (groupTag) => request('/videos/unclassified', { params: groupTag ? { group_tag: groupTag } : {} }),

    // Analysis
    getKeywords: (limit) => request('/analysis/keywords', { params: { limit } }),
    getCategories: (group) => request('/analysis/categories', { params: group ? { group } : {} }),

    getGaps: (params) => request('/analysis/gaps', { params }),
    getYadamGaps: () => request('/analysis/gaps/yadam'),
    getYadamDetailGrid: ({ eraId, eventId, sourceId }) => request('/analysis/gaps/yadam/detail', { params: { eraId, eventId, sourceId } }),
    getMaterialSaturation: (genre = '야담') => request('/analysis/gaps/material-saturation', { params: { genre } }),
    getEconomyGaps: (period) => request('/analysis/gaps/economy', { params: { period } }),
    getEconomyRealtime: () => request('/analysis/gaps/economy-realtime'),
    getMultiGaps: (selectedCategoryIds) => request('/analysis/gaps/multi', { method: 'POST', body: { selectedCategoryIds } }),
    deepGapAnalysis: (data) => request('/analysis/gaps/deep', { method: 'POST', body: data }),
    rebuildRankings: (genre) => request('/analysis/rebuild-rankings', { method: 'POST', body: { genre } }),
    refreshVideoStats: (videoIds, genre) => request('/analysis/refresh-video-stats', { method: 'POST', body: { videoIds, genre } }),
    refreshTop50: (genre, categoryName) => request('/analysis/refresh-top50', { method: 'POST', body: { genre, categoryName } }),
    getRankings: (genre) => request('/analysis/rankings', { params: { genre } }),
    getTrends: (params) => request('/analysis/trends', { params }),
    search: (q) => request('/analysis/search', { params: { q } }),

    // DNA 분석
    getDnaSpikes: (p) => request('/dna/spikes', { params: p }),
    getDnaChannels: () => request('/dna/channels'),
    analyzeDna: (data) => request('/dna/analyze', { method: 'POST', body: data }),
    analyzeThemeDna: (topic, category) => request('/dna/theme-analyze', { method: 'POST', body: { topic, category } }),
    extractGoldenKeywords: (dna) => request('/dna/golden-keywords', { method: 'POST', body: { dna } }),
    recommendDnaTitles: (dna, goldenKeywords, category, topic) => request('/dna/recommend-titles', { method: 'POST', body: { dna, goldenKeywords, category, topic } }),
    getDnaCache: (key) => request(`/dna/cache/${key}`),
    buildGroupDna: (dnaResults) => request('/dna/group', { method: 'POST', body: { dnaResults } }),
    extractLocalDna: (data) => request('/dna/local-dna', { method: 'POST', body: data }),
    getUnclassifiedCount: () => request('/dna/unclassified-count'),

    // Settings
    getSettings: () => request('/settings'),
    updateSettings: (data) => request('/settings', { method: 'PUT', body: data }),
    updateApiKey: (key, value) => request('/settings/apikey', { method: 'PUT', body: { key, value } }),
    getSettingsCategories: () => request('/settings/categories'),
    addSettingsCategory: (data) => request('/settings/categories', { method: 'POST', body: data }),
    deleteSettingsCategory: (id) => request(`/settings/categories/${id}`, { method: 'DELETE' }),
    loadPreset: (preset) => request('/settings/categories/preset', { method: 'POST', body: { preset } }),
    backupDB: () => `${API_BASE}/settings/backup`,

    getChannelSpikeCounts: () => request('/channels/spike-counts'),
    getInactiveChannels: (days = 30, groupTag) => request(`/channels/inactive?days=${days}&group_tag=${groupTag || 'all'}`),

    // v4: Trending search
    searchTrending: (data) => request('/youtube/search', { method: 'POST', body: data }),
    searchChannels: (data) => request('/youtube/search-channels', { method: 'POST', body: data }),
    getChannelDetails: (ids) => request(`/youtube/channel-details?ids=${encodeURIComponent(ids)}`).then(r => r.channels || []),

    // v4: Comments
    fetchVideoComments: (videoId, max) => request(`/youtube/comments/${videoId}`, { params: max ? { max } : {} }),
    getVideoComments: (dbId) => request(`/videos/${dbId}/comments`),
    analyzeVideoComments: (videoId, title) => request(`/analysis/comments/${videoId}`, { method: 'POST', body: { title } }),

    // v4: Benchmark
    getBenchmarkReport: (dbId, force) => request(`/analysis/benchmark/${dbId}`, { method: 'POST', body: { force } }),

    // v4: Transcript
    getTranscript: (dbId) => request(`/videos/${dbId}/transcript`),

    // v4: CSV export URL
    getCSVUrl: (params) => {
        const q = new URLSearchParams(params || {}).toString();
        return `${API_BASE}/videos/export/csv${q ? '?' + q : ''}`;
    },

    // v3: Economy High-Intensity Flow
    getEconomyRealtimeV3: (params) => request('/analysis/economy/realtime-v3', { params }),
    suggestEconomyTopicsV3: (data) => request('/analysis/economy/suggest-topics-v3', { method: 'POST', body: data }),
    getThumbnailTitlesV3: (data) => request('/analysis/economy/thumbnail-titles-v3', { method: 'POST', body: data }),

    // 떡상 영상 추출 (Gemini 없음)
    getSpikeVideos: (data) => request('/analysis/gaps/spike-videos', { method: 'POST', body: data }),
    extractDna: (data) => request('/analysis/gaps/extract-dna', { method: 'POST', body: data }),
    getDnaHistory: (groupTag, category) => {
        const p = new URLSearchParams();
        if (groupTag) p.set('groupTag', groupTag);
        if (category) p.set('category', category);
        const qs = p.toString();
        return request(`/analysis/gaps/dna-history${qs ? '?' + qs : ''}`);
    },
    getDnaDetail: (id) => request(`/analysis/gaps/dna-history/${id}`),
    getDnaByVideoId: (videoId) => request(`/analysis/gaps/dna-by-video/${videoId}`),
    batchExtractDna: (videoIds, category, groupTag) =>
        request('/analysis/gaps/batch-extract-dna', { method: 'POST', body: { videoIds, category, groupTag } }),
    batchDnaStatus: (jobId) =>
        request(`/analysis/gaps/batch-dna-status/${jobId}`),
    batchDnaCancel: (jobId) =>
        request(`/analysis/gaps/batch-dna-cancel/${jobId}`, { method: 'POST' }),

    // 소재 추천 / 등록
    suggestMaterials: (categoryName) => request('/settings/suggest-materials', { method: 'POST', body: { categoryName } }),
    suggestKeywords: (categoryName, materialName) => request('/settings/suggest-keywords', { method: 'POST', body: { categoryName, materialName } }),
    addMaterial: (groupName, name, keywords = []) => request('/settings/categories', { method: 'POST', body: { group_name: groupName, name, keywords: Array.isArray(keywords) ? keywords.join(',') : (keywords || '') } }),
    updateMaterialName: (id, name) => request(`/settings/categories/${id}`, { method: 'PUT', body: { name } }),
    deleteMaterial: (id) => request(`/settings/categories/${id}`, { method: 'DELETE' }),
    updateCategoryKeywords: (categoryId, keywords) => request(`/settings/categories/${categoryId}/keywords`, { method: 'PUT', body: { keywords } }),

    // AI 미분류 자동 분류 (SSE 스트리밍)
    async classifyUnclassified(groupTag, onProgress) {
        const response = await fetch(`${API_BASE}/videos/classify-unclassified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupTag })
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.type === 'progress' && onProgress) {
                        onProgress(data);
                    } else if (data.type === 'done') {
                        finalResult = data;
                    }
                } catch (e) {}
            }
        }
        return finalResult;
    },

    // 지침 관리 API
    getGuidelines: (category, type) => {
        const params = new URLSearchParams();
        if (category) params.append('category', category);
        if (type) params.append('type', type);
        const qs = params.toString();
        return request('/guidelines' + (qs ? '?' + qs : ''));
    },
    getGuideline: (id) => request('/guidelines/' + id),
    createGuideline: (data) => request('/guidelines', {
        method: 'POST',
        body: data
    }),
    uploadGuideline: (formData) => fetch('/api/guidelines/upload', {
        method: 'POST',
        body: formData
    }).then(r => r.json()),
    updateGuideline: (id, data) => request('/guidelines/' + id, {
        method: 'PUT',
        body: data
    }),
    deleteGuideline: (id) => request('/guidelines/' + id, {
        method: 'DELETE'
    }),
    activateGuideline: (id) => request('/guidelines/' + id + '/activate', {
        method: 'PUT'
    }),

    // 주제 추천 API
    getTop200Titles: (genre) => {
        const params = new URLSearchParams();
        if (genre) params.append('genre', genre);
        const qs = params.toString();
        return request('/topics/top200-titles' + (qs ? '?' + qs : ''));
    },
    saveRecommendation: (data) => request('/topics/save-recommendation', {
        method: 'POST',
        body: data
    }),
    getRecommendations: (category, limit) => {
        const params = new URLSearchParams();
        if (category) params.append('category', category);
        if (limit) params.append('limit', limit);
        const qs = params.toString();
        return request('/topics/recommendations' + (qs ? '?' + qs : ''));
    },
    getRecommendation: (id) => request('/topics/recommendations/' + id),
    getRecommendationsHistory: (groupTag, category, limit) => {
        const params = new URLSearchParams();
        if (groupTag) params.append('group_tag', groupTag);
        if (category) params.append('category', category);
        if (limit) params.append('limit', String(limit));
        return request('/topics/recommendations-history?' + params.toString());
    },
    deleteRecommendation: (recId) => request('/topics/recommendations/' + recId, { method: 'DELETE' }),

    // 5단계 스토리 설계 API
    getGuidelinesFiltered: (category, type, active) => {
        const params = new URLSearchParams();
        if (category) params.append('category', category);
        if (type) params.append('type', type);
        if (active) params.append('active', '1');
        const qs = params.toString();
        return request('/guidelines' + (qs ? '?' + qs : ''));
    },
    recommendMaterials: (data) => request('/topics/recommend-materials', { method: 'POST', body: data }),
    recommendDna: (data) => request('/topics/recommend-dna', { method: 'POST', body: data }),
    generateStoryPrompt: (data) => request('/topics/generate-story-prompt', { method: 'POST', body: data }),

    // 썸네일 제목 레퍼런스
    getThumbReferences: (search) => {
        const params = search ? { search } : undefined;
        return request('/thumb-references', { params });
    },
    addThumbReference: (title) => request('/thumb-references', { method: 'POST', body: { title } }),
    deleteThumbReference: (id) => request('/thumb-references/' + id, { method: 'DELETE' }),

    // TTS
    ttsConnectionTest: (url) => request(`/tts/connection-test?url=${encodeURIComponent(url)}`),
    ttsGetAudioFiles: () => request('/tts/audio-files'),
    ttsDeleteAudioFile: (filename) => request(`/tts/audio-files/${encodeURIComponent(filename)}`, { method: 'DELETE' }),
    ttsSearchAudioFiles: (query) => request(`/tts/audio-files/search?q=${encodeURIComponent(query)}`),
    ttsGenerateCustom: (data) => request('/tts/generate-custom', {
        method: 'POST',
        body: data
    }),
    ttsGenerateClone: (formData) => fetch('/api/tts/generate-clone', {
        method: 'POST',
        body: formData
    }).then(r => r.json()),

    ttsTranscribe: (formData) => fetch('/api/tts/transcribe', {
        method: 'POST',
        body: formData
    }).then(r => r.json()),

    ttsGenerateDesign: (data) => request('/tts/generate-design', {
        method: 'POST',
        body: data
    }),

    ttsGetGuideLink: () => request('/tts/guide-link'),
    ttsUpdateGuideLink: (link, password) => request('/tts/guide-link', {
        method: 'PUT',
        body: { link, password }
    }),
    ttsAnalyzeSpeakers: (data) => request('/tts/analyze-speakers', {
        method: 'POST',
        body: data
    }),
    ttsGetSeeds: () => request('/tts/seeds'),
    ttsSaveSeed: (data) => request('/tts/seeds', {
        method: 'POST',
        body: data
    }),
    ttsDeleteSeed: (id) => request(`/tts/seeds/${id}`, { method: 'DELETE' }),
    ttsGetHistory: (q = '', page = 1) => request(`/tts/history?q=${encodeURIComponent(q)}&page=${page}`),
    ttsDeleteHistory: (id) => request(`/tts/history/${id}`, { method: 'DELETE' }),
    ttsDeleteHistoryBulk: (ids) => request('/tts/history-bulk', {
        method: 'DELETE',
        body: { ids }
    }),
};
