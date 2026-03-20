// 채널/영상 검색 페이지
import { showToast } from '../components/toast.js';
import { icons } from '../components/icons.js';

export function renderSearch(container, { navigate, api }) {

    // ── 상태 변수 ──
    let currentTab = 'video';
    let selectedCategory = '';
    let categories = [];
    let activeKeywords = new Set();
    let searchResults = [];
    let selectedVideos = new Set();
    let registeredChannels = new Set();
    let existingVideoIds = new Set();
    let currentRankings = [];
    let isSearching = false;
    let isManageMode = false;
    let lastChannelSearchResults = null;
    let lastChannelSearchMeta = null;

    // ── 초기화 ──
    async function init() {
        const t0 = Date.now();
        try {
            const t1 = Date.now();
            const [catRes, chIds] = await Promise.all([
                api.getChannelCategories(),
                api.getChannelIds()
            ]);
            console.log('[PERF-SEARCH] getChannelCategories + getChannelIds (병렬):', Date.now() - t1, 'ms');
            categories = catRes.categories || [];
            registeredChannels = new Set(chIds || []);
        } catch (e) {
            console.error('[search] init 실패:', e);
        }
        console.log('[PERF-SEARCH] init() 총 소요:', Date.now() - t0, 'ms');

        // sessionStorage에서 채널 검색 결과 복원
        try {
            const saved = sessionStorage.getItem('cs_results');
            const savedMeta = sessionStorage.getItem('cs_meta');
            if (saved && savedMeta) {
                lastChannelSearchResults = JSON.parse(saved);
                lastChannelSearchMeta = JSON.parse(savedMeta);
            }
        } catch (e) { /* 복원 실패 무시 */ }

        // 영상 검색 결과 복원
        try {
            const savedResults = sessionStorage.getItem('vs_results');
            const savedMeta = sessionStorage.getItem('vs_meta');
            if (savedResults && savedMeta) {
                const meta = JSON.parse(savedMeta);
                // 1시간 이내 데이터만 복원
                if (Date.now() - meta.timestamp < 3600000) {
                    searchResults = JSON.parse(savedResults);
                    if (meta.keywords) {
                        activeKeywords.clear();
                        meta.keywords.forEach(k => activeKeywords.add(k));
                    }
                    if (meta.category) {
                        selectedCategory = meta.category;
                    }
                } else {
                    sessionStorage.removeItem('vs_results');
                    sessionStorage.removeItem('vs_meta');
                }
            }
        } catch (e) {
            console.warn('[영상검색] 결과 복원 실패:', e);
        }

        render();
        bindEvents();

        // 채널 탭이 기본 탭이고 저장된 결과가 있으면 복원
        if (currentTab === 'channel' && lastChannelSearchResults) {
            renderChannelResults(lastChannelSearchResults, lastChannelSearchMeta?.registeredExcluded || 0);
            const resetBtn = container.querySelector('#cs-reset-btn');
            if (resetBtn) resetBtn.style.display = 'inline-flex';
        }

        // 영상 탭이고 복원된 결과가 있으면 표시
        if (currentTab === 'video' && searchResults.length > 0) {
            renderResults();
            const resetBtn = container.querySelector('#vs-reset-btn');
            if (resetBtn) resetBtn.style.display = '';
        }
    }

    // ── 메인 렌더링 ──
    function render() {
        container.innerHTML = `
      <div class="vs-container">
        <div class="vs-tab-header">
          <div class="vs-tab ${currentTab === 'video' ? 'active' : ''}" data-tab="video">
            ${icons.search()} 떡상 영상 검색
          </div>
          <div class="vs-tab ${currentTab === 'channel' ? 'active' : ''}" data-tab="channel">
            ${icons.video()} 떡상 채널 검색
          </div>
        </div>
        ${currentTab === 'video' ? renderVideoPanel() : renderChannelPanel()}
        <div id="vs-results-area"></div>
      </div>
    `;
    }

    // ── 카테고리 버튼 HTML ──
    // displayCats: 표시할 카테고리 배열 (없으면 전체), drag idx는 항상 원본 categories 기준
    function renderCatButtons(displayCats) {
        const cats = displayCats || categories;
        return `
      <div class="vs-panel-header">
        <div class="vs-panel-title">등록 카테고리 선택</div>
        <button class="vs-manage-btn${isManageMode ? ' active' : ''}" id="vs-manage-btn">${isManageMode ? `${icons.check()} 완료` : '카테고리/키워드 삭제 관리'}</button>
      </div>
      <div class="vs-cat-row">
        ${cats.map((cat) => {
            const idx = categories.findIndex(c => c.name === cat.name);
            return `
          <div class="vs-cat-btn${selectedCategory === cat.name ? ' active' : ''}"
               data-cat="${cat.name}" draggable="true" data-cat-idx="${idx}">
            <span class="vs-cat-drag-handle">${icons.drag()}</span>${cat.name}${isManageMode ? `<span class="cat-delete" data-cat="${cat.name}">${icons.close()}</span>` : ''}
          </div>
        `;}).join('')}
        <div class="vs-cat-btn add-new" id="vs-add-cat-btn">＋ 신규 등록</div>
      </div>
    `;
    }

    // ── 영상 검색 패널 ──
    function renderVideoPanel() {
        const videoCategories = categories.filter(c => c.sub_type_mode !== 'dual');
        return `
      <div class="vs-panel">
        ${renderCatButtons(videoCategories)}
        <div class="vs-panel-title">검색 키워드</div>
        <div class="vs-kw-tags" id="vs-kw-tags"></div>
        <div class="vs-kw-input-row">
          <input class="vs-kw-input" id="vs-kw-custom" placeholder="직접 키워드 입력 후 Enter">
        </div>
        <div class="vs-filter-row">
          <span class="vs-filter-label">📅 업로드 기간</span>
          <span class="vs-filter-fixed">최근 3개월</span>
          <button class="vs-reset-btn" id="vs-reset-btn" style="display:none">검색 초기화</button>
          <span class="vs-fixed-check">✔ 이미 수집된 영상 제외</span>
          <span class="vs-fixed-check">✔ 5분 이하(쇼츠) 제외</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <button class="vs-search-btn" id="vs-search-btn"${!selectedCategory ? ' disabled' : ''}>
            ${icons.search()} 떡상 영상 검색
          </button>
          <span class="vs-search-guide" style="display:inline-flex;flex-direction:column;gap:2px;">
            <span>${categories.filter(c => c.sub_type_mode === 'dual').map(c => c.name).join(' · ')}</span>
            <span>카테고리는 떡상 채널 검색 → 채널 검색 및 수집 → 채널관리 메뉴 → 채널별 영상 수집을 할 수 있습니다.</span>
          </span>
        </div>
      </div>
    `;
    }

    // ── 채널 검색 패널 ──
    function renderChannelPanel() {
        return `
      <div class="vs-panel">
        ${renderCatButtons()}
        <div class="vs-panel-title">검색 키워드</div>
        <div class="vs-kw-tags" id="vs-kw-tags"></div>
        <div class="vs-kw-input-row">
          <input class="vs-kw-input" id="vs-kw-custom" placeholder="채널명 또는 키워드 입력">
        </div>
        <div class="vs-channel-filters">
          <div class="vs-filter-group">
            <span class="vs-filter-label">📅 기간</span>
            <select class="vs-filter-select" id="vs-ch-period">
              <option value="all">전체</option>
              <option value="1month">1개월</option>
              <option value="2months">2개월</option>
              <option value="3months" selected>3개월</option>
              <option value="6months">6개월</option>
              <option value="1year">1년</option>
            </select>
          </div>
          <div class="vs-filter-group">
            <span class="vs-filter-label">👤 구독자</span>
            <select class="vs-filter-select" id="vs-ch-subs">
              <option value="0">전체</option>
              <option value="10000">1만 이상</option>
              <option value="20000">2만 이상</option>
              <option value="30000">3만 이상</option>
              <option value="40000">4만 이상</option>
              <option value="50000">5만 이상</option>
              <option value="custom">직접 입력</option>
            </select>
          </div>
          <div class="vs-filter-group" id="vs-ch-subs-custom-area" style="display:none">
            <input class="vs-kw-input" id="vs-ch-subs-custom" placeholder="구독자 수 입력" style="width:120px">
          </div>
          <span class="vs-fixed-check">✔ 이미 등록된 채널 제외</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <button class="vs-search-btn" id="vs-search-btn"${!selectedCategory ? ' disabled' : ''}>
            ${icons.video()} 떡상 채널 검색
          </button>
          <button class="cs-reset-btn" id="cs-reset-btn" style="display:none">
            검색 초기화
          </button>
        </div>
      </div>
    `;
    }

    // ── 카테고리별 키워드 프리셋 ──
    async function getCategoryKeywords(cat) {
        try {
            const res = await api.getCategoryKeywords(cat);
            const kws = (res.keywords || []).map(k => k.keyword);
            return kws.length > 0 ? kws : [cat];
        } catch (e) {
            console.error('키워드 로드 실패:', e);
            return [cat];
        }
    }

    async function loadKeywordTags(cat) {
        const tagsEl = container.querySelector('#vs-kw-tags');
        if (!tagsEl || !cat) return;
        let kwItems = [];
        try {
            const res = await api.getCategoryKeywords(cat, currentTab);
            kwItems = res.keywords || [];
        } catch (e) {
            kwItems = [{ id: null, keyword: cat }];
        }
        tagsEl.innerHTML = kwItems.map(k => `
          <div class="vs-kw-tag${activeKeywords.has(k.keyword) ? ' active' : ''}"
               data-kw="${k.keyword}" data-id="${k.id ?? ''}" draggable="true">
            <span class="vs-kw-drag-handle">${icons.drag()}</span>${k.keyword}${isManageMode ? `<span class="kw-delete" data-id="${k.id ?? ''}" data-kw="${k.keyword}">${icons.close()}</span>` : ''}
          </div>
        `).join('') + `<span class="vs-kw-tag add-kw" id="vs-add-kw-btn">＋ 키워드 추가</span>`;

        // 클릭 토글 (✕ 제외)
        tagsEl.querySelectorAll('.vs-kw-tag').forEach(tag => {
            tag.addEventListener('click', (e) => {
                if (e.target.classList.contains('kw-delete')) return;
                toggleKeyword(tag);
            });
        });

        // 키워드 ✕ 삭제
        tagsEl.querySelectorAll('.kw-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const kw = btn.dataset.kw;
                const id = btn.dataset.id;
                showConfirmModal({
                    title: `'${kw}' 키워드를 삭제하시겠습니까?`,
                    message: '',
                    onConfirm: async () => {
                        await api.deleteCategoryKeyword(cat, id);
                        activeKeywords.delete(kw);
                        await loadKeywordTags(cat);
                    }
                });
            });
        });

        // ＋ 키워드 추가 버튼
        const addKwBtn = tagsEl.querySelector('#vs-add-kw-btn');
        if (addKwBtn) {
            addKwBtn.addEventListener('click', () => {
                showInputModal({
                    title: '키워드 추가',
                    placeholder: '키워드 입력',
                    onConfirm: async (val) => {
                        if (!val) return;
                        try {
                            await api.addCategoryKeyword(cat, val, currentTab);
                            await loadKeywordTags(cat);
                        } catch (err) {
                            showToast('키워드 추가 실패: ' + (err.message || ''), 'error');
                        }
                    }
                });
            });
        }

        // 드래그 정렬
        let dragSrcTag = null;
        tagsEl.querySelectorAll('.vs-kw-tag').forEach(tag => {
            tag.addEventListener('dragstart', (e) => {
                dragSrcTag = tag;
                tag.classList.add('vs-kw-tag-dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            tag.addEventListener('dragend', () => {
                tag.classList.remove('vs-kw-tag-dragging');
                tagsEl.querySelectorAll('.vs-kw-tag').forEach(t => t.classList.remove('vs-kw-tag-drag-over'));
                dragSrcTag = null;
            });
            tag.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (dragSrcTag && dragSrcTag !== tag) tag.classList.add('vs-kw-tag-drag-over');
            });
            tag.addEventListener('dragleave', () => tag.classList.remove('vs-kw-tag-drag-over'));
            tag.addEventListener('drop', async (e) => {
                e.preventDefault();
                tag.classList.remove('vs-kw-tag-drag-over');
                if (!dragSrcTag || dragSrcTag === tag) return;
                const tags = [...tagsEl.querySelectorAll('.vs-kw-tag')];
                const srcIdx = tags.indexOf(dragSrcTag);
                const tgtIdx = tags.indexOf(tag);
                if (srcIdx < tgtIdx) tagsEl.insertBefore(dragSrcTag, tag.nextSibling);
                else tagsEl.insertBefore(dragSrcTag, tag);
                const orderedIds = [...tagsEl.querySelectorAll('.vs-kw-tag')].map(t => t.dataset.id).filter(id => id);
                if (orderedIds.length > 0) {
                    try { await api.reorderCategoryKeywords(cat, orderedIds.map(Number)); } catch {}
                }
            });
        });
    }

    // ── 영상 검색 실행 ──
    async function doVideoSearch() {
        // 입력창에 텍스트가 있으면 자동으로 키워드 추가
        const kwInputEl = container.querySelector('#vs-kw-custom');
        const pendingKw = kwInputEl?.value?.trim();
        if (pendingKw) {
            kwInputEl.value = '';
            if (!activeKeywords.has(pendingKw)) {
                activeKeywords.add(pendingKw);
                const tagsEl = container.querySelector('#vs-kw-tags');
                if (tagsEl && !tagsEl.querySelector(`[data-kw="${pendingKw}"]`)) {
                    const tag = document.createElement('div');
                    tag.className = 'vs-kw-tag active';
                    tag.dataset.kw = pendingKw;
                    tag.textContent = pendingKw;
                    tag.addEventListener('click', () => toggleKeyword(tag));
                    tagsEl.appendChild(tag);
                }
            }
        }
        if (activeKeywords.size === 0) {
            showToast('검색 키워드를 선택하거나 입력해주세요');
            return;
        }
        if (!selectedCategory) {
            showToast('카테고리를 선택해주세요');
            return;
        }
        if (isSearching) return;
        isSearching = true;
        renderLoading();

        const searchReport = {
            totalFromAPI: 0,
            shortsExcluded: 0,
            afterShortsFilter: 0,
            alreadyCollected: 0,
            afterCollectedFilter: 0,
            finalCount: 0,
            errors: [],
            keywords: [...activeKeywords]
        };
        let refreshResult = null;

        try {
            // 채널 등록 여부 최신 갱신 (경량 API 사용)
            try {
                const chIds = await api.getChannelIds();
                registeredChannels = new Set(chIds || []);
                console.log('[SEARCH] registeredChannels 갱신:', registeredChannels.size, '개');
            } catch (e) { /* 실패 시 기존 캐시 유지 */ }

            currentRankings = await loadCurrentRankings(selectedCategory);

            const allResults = [];
            let lastError = null;
            let errorCount = 0;
            const MAX_PAGES = 10; // 최대 10페이지 × 50건 = 500건/키워드
            for (const kw of activeKeywords) {
                try {
                    console.log(`[SEARCH] 키워드 검색 시작: "${kw}"`);
                    let pageToken = undefined;
                    let kwCount = 0;
                    for (let page = 0; page < MAX_PAGES; page++) {
                        const res = await api.searchTrending({
                            keyword: kw,
                            period: '3months',
                            videoType: 'any',
                            maxResults: 50,
                            minSubscribers: 0,
                            minViews: 0,
                            pageToken
                        });
                        const pageResults = res.results || [];
                        kwCount += pageResults.length;
                        allResults.push(...pageResults);
                        if (!res.nextPageToken || pageResults.length === 0) break;
                        pageToken = res.nextPageToken;
                    }
                    console.log(`[SEARCH] "${kw}" 결과: ${kwCount}건`);
                } catch (e) {
                    console.error(`[search] 키워드 검색 실패 [${kw}]:`, e);
                    lastError = e;
                    errorCount++;
                    searchReport.errors.push(e.message || 'YouTube API 오류');
                }
            }
            console.log('[SEARCH] YouTube API 원본 결과 (중복 포함):', allResults.length);
            searchReport.totalFromAPI = allResults.length;
            console.log('[영상검색] YouTube 원본:', allResults.length, '건');

            // 모든 키워드 검색 실패 시 오류 표시
            if (allResults.length === 0 && errorCount > 0 && errorCount === activeKeywords.size) {
                searchResults = [];
                sessionStorage.removeItem('vs_results');
                sessionStorage.removeItem('vs_meta');
                isSearching = false;
                renderResults();
                showSearchReportModal(searchReport);
                return;
            }

            // 중복 제거 (video_id 기준)
            const uniqueMap = new Map();
            allResults.forEach(v => {
                if (!uniqueMap.has(v.video_id)) uniqueMap.set(v.video_id, v);
            });
            console.log('[영상검색] 중복제거:', uniqueMap.size, '건');

            // 5분 이하 제외
            const afterShorts = [...uniqueMap.values()].filter(v => v.duration_seconds > 300);
            searchReport.shortsExcluded = uniqueMap.size - afterShorts.length;
            searchReport.afterShortsFilter = afterShorts.length;
            console.log('[SEARCH] 5분 이하 제외 후:', afterShorts.length);
            console.log('[영상검색] 숏츠필터후:', afterShorts.length, '건 (제거:', uniqueMap.size - afterShorts.length, '건)');

            // 이미 DB에 있는 영상 확인
            if (afterShorts.length > 0) {
                try {
                    const existRes = await api.checkExistingVideos(afterShorts.map(v => v.video_id));
                    existingVideoIds = new Set(existRes.existing || []);
                    console.log('[영상검색] DB기수집:', existingVideoIds.size, '건');
                } catch (e) {
                    existingVideoIds = new Set();
                }
            }

            // 기존 수집 영상 재검수
            if (existingVideoIds.size > 0) {
                try {
                    refreshResult = await api.refreshVideoStats([...existingVideoIds], selectedCategory);
                    console.log('[검색 재검수] 완료:', refreshResult);
                } catch (err) {
                    console.warn('[검색 재검수] 오류:', err.message);
                    refreshResult = null;
                }
            }

            // 이미 수집된 영상 제외 (옵션)
            const excludeExisting = container.querySelector('#vs-exclude-existing')?.checked !== false;
            let afterExclude = afterShorts;
            if (excludeExisting) {
                afterExclude = afterShorts.filter(v => !existingVideoIds.has(v.video_id));
            }
            searchReport.alreadyCollected = afterShorts.length - afterExclude.length;
            searchReport.afterCollectedFilter = afterExclude.length;
            console.log('[SEARCH] 기수집 제외 후:', afterExclude.length);
            console.log('[영상검색] 기수집제외후:', afterExclude.length, '건 → 최종표시 예정');

            // spike_ratio 기준 정렬 후 상위 50건
            afterExclude.sort((a, b) => (b.spike_ratio || 0) - (a.spike_ratio || 0));
            searchResults = afterExclude.slice(0, 50);
            searchReport.finalCount = searchResults.length;
            console.log('[SEARCH] 최종 결과:', searchResults.length);

            console.log('[DEBUG] registeredChannels 크기:', registeredChannels.size);
            console.log('[DEBUG] registeredChannels 샘플:', [...registeredChannels].slice(0, 3));
            console.log('[DEBUG] 검색결과 channel_id 샘플:',
                searchResults.slice(0, 3).map(v => ({
                    channel_id: v.channel_id,
                    channelId: v.channelId,
                    snippet_channelId: v.snippet?.channelId
                }))
            );
            searchResults.forEach(v => {
                v._estimatedRank = estimateRank(v.spike_ratio, currentRankings);
                v._isRegistered = registeredChannels.has(v.channel_id);
                v._isCollected = existingVideoIds.has(v.video_id);
            });

        } catch (e) {
            console.error('[search] doVideoSearch 오류:', e);
            searchReport.errors.push(e.message || '알 수 없는 오류');
            searchResults = [];
            sessionStorage.removeItem('vs_results');
            sessionStorage.removeItem('vs_meta');
        }

        isSearching = false;
        selectedVideos.clear();

        // 검색 결과 sessionStorage 저장
        try {
            sessionStorage.setItem('vs_results', JSON.stringify(searchResults));
            sessionStorage.setItem('vs_meta', JSON.stringify({
                keywords: [...activeKeywords],
                category: selectedCategory,
                timestamp: Date.now()
            }));
        } catch (e) {
            console.warn('[영상검색] 결과 저장 실패:', e);
        }

        const resetBtn = container.querySelector('#vs-reset-btn');
        if (resetBtn && searchResults.length > 0) resetBtn.style.display = '';

        renderResults();
        showSearchReportModal(searchReport, refreshResult);
    }

    // ── 채널 떡상 점수 계산 ──
    function calcSpikeScore(ch) {
        const subs = ch.subscriber_count || 0;
        const videos = ch.video_count || 0;
        const publishedAt = ch.publishedAt;

        if (!publishedAt || subs === 0) return 0;

        const now = new Date();
        const created = new Date(publishedAt);
        const days = Math.max((now - created) / (1000 * 60 * 60 * 24), 1);

        const growthRate = subs / days;
        const efficiency = videos > 0 ? subs / videos : 0;
        const uploadFreq = videos / days;

        const score = (growthRate * 0.4) + (efficiency * 0.4) + (uploadFreq * 20);
        return Math.round(score * 100) / 100;
    }

    // ── 채널 검색 실행 ──
    async function doChannelSearch() {
        // 기존 결과가 있으면 재검색 차단
        if (lastChannelSearchResults) {
            showToast('먼저 검색 초기화 버튼을 눌러주세요');
            return;
        }
        // 키워드 구성: activeKeywords + 직접입력 합산
        const kwCustom = container.querySelector('#vs-kw-custom')?.value?.trim();
        const kwSet = new Set([...activeKeywords]);
        if (kwCustom) kwSet.add(kwCustom);

        const periodEl = document.getElementById('vs-ch-period');
        const period = periodEl ? periodEl.value : 'all';
        const subsEl = document.getElementById('vs-ch-subs');
        let minSubs = subsEl ? parseInt(subsEl.value) || 0 : 0;
        if (subsEl && subsEl.value === 'custom') {
            const customVal = document.getElementById('vs-ch-subs-custom')?.value;
            minSubs = parseInt(customVal) || 0;
        }
        let publishedAfter = null;
        if (period !== 'all') {
            const now = new Date();
            const monthsMap = { '1month': 1, '2months': 2, '3months': 3, '6months': 6, '1year': 12 };
            const months = monthsMap[period] || 0;
            if (months > 0) {
                now.setMonth(now.getMonth() - months);
                publishedAfter = now.toISOString();
            }
        }

        if (kwSet.size === 0) {
            showToast('키워드를 선택하거나 채널명을 입력해주세요');
            return;
        }
        if (!selectedCategory) {
            showToast('카테고리를 선택해주세요');
            return;
        }
        if (isSearching) return;
        isSearching = true;
        renderLoading();

        try {
            // 등록 채널 최신화
            try {
                const chIds = await api.getChannelIds();
                registeredChannels = new Set(chIds || []);
            } catch (e) { /* 기존 캐시 유지 */ }

            // 키워드별 채널 검색 (type:channel)
            const allChannels = new Map();
            const maxPages = 5;
            for (const kw of kwSet) {
                let pageToken = null;
                for (let page = 0; page < maxPages; page++) {
                    const res = await api.searchChannels({ keyword: kw, maxResults: 50, pageToken: pageToken || undefined, publishedAfter });
                    if (!res.channels?.length) break;
                    res.channels.forEach(ch => {
                        if (!allChannels.has(ch.channel_id)) allChannels.set(ch.channel_id, ch);
                    });
                    pageToken = res.nextPageToken;
                    if (!pageToken) break;
                }
            }

            // 등록 채널 제외
            const allFound = [...allChannels.values()];
            const registeredCount = allFound.filter(ch => registeredChannels.has(ch.channel_id)).length;
            const unregistered = allFound.filter(ch => !registeredChannels.has(ch.channel_id));

            // 채널 상세 조회 (구독자, 영상수, 개설일)
            const channelIds = unregistered.map(ch => ch.channel_id);
            for (let i = 0; i < channelIds.length; i += 50) {
                const batch = channelIds.slice(i, i + 50);
                try {
                    const details = await api.getChannelDetails(batch.join(','));
                    details.forEach(info => {
                        const ch = allChannels.get(info.id);
                        if (ch) {
                            ch.subscriber_count = info.subscriberCount;
                            ch.video_count = info.videoCount;
                            ch.publishedAt = info.publishedAt;
                            if (info.description) ch.description = info.description;
                            if (info.thumbnail) ch.thumbnail_url = info.thumbnail;
                        }
                    });
                } catch (e) { /* 상세 조회 실패 시 기본값 사용 */ }
            }

            // 구독자 필터 적용 (클라이언트)
            const filtered = minSubs > 0
                ? unregistered.filter(ch => (ch.subscriber_count || 0) >= minSubs)
                : unregistered;

            // 떡상 점수 계산 후 정렬
            filtered.forEach(ch => {
                ch.spikeScore = calcSpikeScore(ch);
            });
            filtered.sort((a, b) => b.spikeScore - a.spikeScore);

            // 결과 저장 (탭 전환 후 복귀 + 새로고침 복원용)
            lastChannelSearchResults = filtered;
            lastChannelSearchMeta = {
                keyword: [...kwSet].join(', '),
                totalFound: allChannels.size,
                registeredExcluded: registeredCount,
                displayed: filtered.length,
                searchedAt: new Date().toISOString()
            };
            try {
                sessionStorage.setItem('cs_results', JSON.stringify(filtered));
                sessionStorage.setItem('cs_meta', JSON.stringify(lastChannelSearchMeta));
            } catch (e) { /* sessionStorage 저장 실패 무시 */ }

            renderChannelResults(filtered, registeredCount);

            // 초기화 버튼 표시
            const resetBtn = container.querySelector('#cs-reset-btn');
            if (resetBtn) resetBtn.style.display = 'inline-flex';

            // 검색 완료 리포트 모달
            showChannelSearchReport(lastChannelSearchMeta);
        } catch (e) {
            console.error('[search] doChannelSearch 오류:', e);
            showToast('채널 검색 중 오류가 발생했습니다');
            const area = container.querySelector('#vs-results-area');
            if (area) area.innerHTML = `<div class="vs-empty">검색 중 오류가 발생했습니다</div>`;
        }
        isSearching = false;
    }

    // ── 채널 검색 완료 리포트 모달 ──
    function showChannelSearchReport(meta) {
        const overlay = document.createElement('div');
        overlay.className = 'sr-modal-overlay';
        overlay.innerHTML = `
      <div class="sr-modal-box">
        <div class="sr-modal-title">떡상 채널 검색 완료</div>
        <div class="sr-modal-body">
          <div class="sr-row"><span>검색 키워드</span><span>${meta.keyword}</span></div>
          <div class="sr-divider"></div>
          <div class="sr-row"><span>발견된 채널</span><span>${meta.totalFound}개</span></div>
          <div class="sr-row"><span>등록 채널 제외</span><span>${meta.registeredExcluded}개</span></div>
          <div class="sr-row"><span>신규 채널</span><span class="sr-highlight">${meta.displayed}개</span></div>
        </div>
        <div class="sr-modal-footer">
          <button class="sr-confirm-btn">확인</button>
        </div>
      </div>
    `;
        overlay.querySelector('.sr-confirm-btn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }

    // ── 채널 등록 완료 리포트 모달 ──
    function showChannelRegisterReport(results) {
        const overlay = document.createElement('div');
        overlay.className = 'sr-modal-overlay';
        overlay.innerHTML = `
      <div class="sr-modal-box">
        <div class="sr-modal-title">채널 등록 완료</div>
        <div class="sr-modal-body">
          <div class="sr-row"><span>등록 성공</span><span class="sr-highlight">${results.success}개</span></div>
          ${results.fail > 0 ? `
          <div class="sr-row"><span>등록 실패</span><span style="color:#ff6b6b">${results.fail}개</span></div>
          <div class="sr-row"><span>실패 채널</span><span style="color:#ff6b6b;font-size:12px">${results.errors.join(', ')}</span></div>
          ` : ''}
        </div>
        <div class="sr-modal-footer">
          <button class="sr-confirm-btn">확인</button>
        </div>
      </div>
    `;
        overlay.querySelector('.sr-confirm-btn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }

    // ── TOP50 예상 순위 계산 ──
    function estimateRank(spikeRatio, rankings) {
        if (!rankings.length) return { rank: null, inTop50: false };
        if (!spikeRatio || spikeRatio < 3.0) return { rank: null, inTop50: false };

        let rank = 1;
        for (const r of rankings) {
            if (spikeRatio >= (r.spikeRatio || 0)) break;
            rank++;
        }
        return { rank, inTop50: rank <= 50 };
    }

    // ── 현재 rankings 로드 ──
    async function loadCurrentRankings(genre) {
        try {
            const res = await api.getRankings(genre);
            return res.rankings || [];
        } catch (e) {
            return [];
        }
    }

    // ── 영상 결과 렌더링 ──
    function renderResults() {
        const area = container.querySelector('#vs-results-area');
        if (!area) return;

        if (!searchResults.length) {
            area.innerHTML = `<div class="vs-empty">검색 결과가 없습니다.<br>키워드를 바꿔 다시 시도해보세요.</div>`;
            return;
        }

        area.innerHTML = `
      <div class="vs-info-bar">
        ${icons.info()} 검색 결과는 <strong>구독자 대비 조회수 배율(떡상지표)</strong> 순으로 정렬됩니다.
        선택한 영상은 <strong>${selectedCategory}</strong> 카테고리로 자동 등록됩니다.
      </div>
      <div class="vs-result-header">
        <div class="vs-result-count">
          떡상 영상 <strong>${searchResults.length}</strong>건 발견
        </div>
        <div class="vs-result-actions">
          <button class="vs-select-all-btn" id="vs-select-all">☑ 전체 선택</button>
          <button class="vs-collect-btn" id="vs-collect-btn" disabled>
            선택 영상 수집 (0건)
          </button>
        </div>
      </div>
      ${searchResults.map(v => renderVideoCard(v)).join('')}
    `;

        bindResultEvents();
    }

    // ── 영상 카드 ──
    function renderVideoCard(v) {
        const grade = getSpikeGrade(v.spike_ratio || 0);
        const est = v._estimatedRank;
        const isSelected = selectedVideos.has(v.video_id);
        const isCollected = v._isCollected;

        let rankHtml;
        if (isCollected) {
            rankHtml = `<div class="vs-rank-number" style="color:rgba(255,255,255,0.35)">수집됨</div>
                        <div class="vs-rank-label">이미 DB 등록</div>`;
        } else if (est && est.inTop50) {
            rankHtml = `<div class="vs-rank-number vs-rank-in">${est.rank}위</div>
                        <div class="vs-rank-label">TOP50 예상</div>`;
        } else if (est && est.rank) {
            rankHtml = `<div class="vs-rank-number vs-rank-out">권외</div>
                        <div class="vs-rank-label">TOP50 밖</div>
                        <div class="vs-rank-sub">DB 보관용</div>`;
        } else {
            rankHtml = `<div class="vs-rank-number vs-rank-out">—</div>
                        <div class="vs-rank-label">떡상 미달</div>`;
        }

        return `
      <div class="vs-card${isSelected ? ' selected' : ''}${isCollected ? ' already-collected' : ''}" data-vid="${v.video_id}">
        <input type="checkbox" class="vs-card-check"
               ${isSelected ? 'checked' : ''}
               ${isCollected ? 'disabled' : ''}
               data-vid="${v.video_id}">
        <div class="vs-card-thumb">
          <img src="${v.thumbnail_url || ''}" alt="" loading="lazy">
          <div class="vs-card-thumb-duration">${formatDuration(v.duration_seconds)}</div>
        </div>
        <div class="vs-card-info">
          <div class="vs-card-title">
            <a href="https://youtube.com/watch?v=${v.video_id}" target="_blank" rel="noopener">${v.title}</a>
          </div>
          <div class="vs-card-channel">
            ${v.channel_name} · 구독자 ${formatCount(v.subscriber_count)}
            ${v._isRegistered
            ? `<span class="vs-registered-tag">등록됨 ${icons.check()}</span>`
            : '<span class="vs-new-tag">신규 채널</span>'}
          </div>
          <div class="vs-card-metrics">
            <span class="vs-metric spike">
              🚀 ${(v.spike_ratio || 0).toFixed(1)}배
              ${grade.text ? `<span class="vs-grade-tag ${grade.cls}">${grade.text}</span>` : ''}
            </span>
            <span class="vs-metric views">👁 ${formatCount(v.view_count)}</span>
            <span class="vs-metric subs">👤 ${formatCount(v.subscriber_count)}</span>
            <span class="vs-metric date">📅 ${formatDate(v.published_at)}</span>
          </div>
        </div>
        <div class="vs-card-rank">${rankHtml}</div>
      </div>
    `;
    }

    // ── 채널 결과 렌더링 ──
    function renderChannelResults(channels, registeredCount = 0) {
        const area = container.querySelector('#vs-results-area');
        if (!area) return;

        if (!channels || !channels.length) {
            const msg = registeredCount > 0
                ? `신규 채널이 없습니다.<br>(등록됨 ${registeredCount}개 제외됨)`
                : '검색 결과가 없습니다.<br>키워드를 바꿔 다시 시도해보세요.';
            area.innerHTML = `<div class="vs-empty">${msg}</div>`;
            return;
        }

        const currentCatInfo = categories.find(c => c.name === selectedCategory);
        const useSubTypeBtns = currentCatInfo?.sub_type_mode === 'dual';

        area.innerHTML = `
      <div class="cs-results-header">
        <div class="cs-results-info">
          채널 <strong>${channels.length}</strong>개 발견
          ${registeredCount > 0 ? `<span class="cs-excluded" style="color:rgba(255,255,255,0.4);">(등록됨 ${registeredCount}개 제외)</span>` : ''}
        </div>
        ${!useSubTypeBtns ? `
        <div class="cs-results-actions">
          <button id="cs-select-all-btn" class="cs-select-all-btn">전체 선택</button>
          <button id="cs-register-all-btn" class="cs-register-btn" disabled>전체 등록하기</button>
        </div>` : ''}
      </div>
      <div class="cs-channel-list">
        ${channels.map((ch, i) => {
            const subCount = ch.subscriber_count || 0;
            const vidCount = ch.video_count ?? null;
            const openedYear = ch.publishedAt ? ch.publishedAt.slice(0, 7).replace('-', '.') : '';
            const thumb = ch.thumbnail_url || '';
            return `
          <div class="cs-channel-card" data-idx="${i}">
            <div class="cs-card-buttons">
              ${useSubTypeBtns ? `
                <button class="cs-reg-btn cs-reg-reallife" data-idx="${i}" data-subtype="실사">실사 등록</button>
                <button class="cs-reg-btn cs-reg-cartoon" data-idx="${i}" data-subtype="만화">만화 등록</button>
              ` : `
                <button class="cs-reg-btn cs-reg-single" data-idx="${i}" data-subtype="">등록</button>
              `}
            </div>
            <div class="cs-card-thumb">
              <img src="${thumb}" alt="" onerror="this.style.opacity='0'">
            </div>
            <div class="cs-card-info">
              <div class="cs-card-name-row">
                <a href="https://youtube.com/channel/${ch.channel_id}" target="_blank" class="cs-card-name">
                  ${ch.name}
                </a>
              </div>
              <div class="cs-card-meta">
                구독자 ${formatCount(subCount)}${vidCount != null ? ` · 총 영상 ${vidCount.toLocaleString()}개` : ''}${openedYear ? ` · 개설 ${openedYear}` : ''}
              </div>
              ${ch.spikeScore > 0 ? `<div class="cs-spike-score">🚀 떡상 점수 ${ch.spikeScore.toLocaleString()}점</div>` : ''}
              ${ch.description ? `<div class="cs-card-desc">${ch.description.slice(0, 100)}</div>` : ''}
            </div>
          </div>
        `;
        }).join('')}
      </div>
    `;

        function bindCancelEvent(btnsArea, ch, idx) {
            btnsArea.querySelector('.cs-cancel-btn')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await api.deleteChannelByYoutubeId(ch.channel_id);
                    showToast(`${ch.channel_name} 등록이 취소되었습니다`, 'success');
                    const card = e.target.closest('.cs-channel-card');
                    card.classList.remove('cs-registered');
                    btnsArea.innerHTML = `
                        <button class="cs-reg-btn cs-reg-reallife" data-idx="${idx}" data-subtype="실사">실사 등록</button>
                        <button class="cs-reg-btn cs-reg-cartoon" data-idx="${idx}" data-subtype="만화">만화 등록</button>
                    `;
                    btnsArea.querySelectorAll('.cs-reg-btn').forEach(b => handleRegisterClick(b, ch, idx, btnsArea));
                } catch (err) {
                    showToast('등록 취소 중 오류가 발생했습니다', 'error');
                }
            });
        }

        function handleRegisterClick(btn, ch, idx, btnsArea) {
            btn.addEventListener('click', async () => {
                const subType = btn.dataset.subtype;
                btn.disabled = true;
                btn.textContent = '등록 중...';
                try {
                    await api.addChannel({
                        channel_id: ch.channel_id,
                        name: ch.name,
                        thumbnail_url: ch.thumbnail_url || '',
                        subscriber_count: ch.subscriber_count || 0,
                        video_count: ch.video_count || 0,
                        group_tag: selectedCategory,
                        sub_type: subType
                    });
                    const card = btn.closest('.cs-channel-card');
                    card.classList.add('cs-registered');
                    btnsArea.innerHTML = `
                        <span class="cs-registered-label">${subType} 등록완료</span>
                        <button class="cs-cancel-btn" data-idx="${idx}" data-channel-id="${ch.channel_id}">등록 취소</button>
                    `;
                    bindCancelEvent(btnsArea, ch, idx);
                    showToast(`${ch.channel_name} → ${subType} 채널 등록 완료`, 'success');
                } catch (err) {
                    if (err.message?.includes('409') || err.message?.includes('already')) {
                        const card = btn.closest('.cs-channel-card');
                        card.classList.add('cs-registered');
                        btnsArea.innerHTML = `
                            <span class="cs-registered-label cs-duplicate-label">중복</span>
                            <button class="cs-cancel-btn" data-idx="${idx}" data-channel-id="${ch.channel_id}">등록 취소</button>
                        `;
                        bindCancelEvent(btnsArea, ch, idx);
                        showToast(`${ch.channel_name}은(는) 이미 등록된 채널입니다`);
                    } else {
                        showToast('등록 중 오류가 발생했습니다', 'error');
                        btn.disabled = false;
                        btn.textContent = subType === '실사' ? '실사 등록' : '만화 등록';
                    }
                }
            });
        }

        if (useSubTypeBtns) {
            area.querySelectorAll('.cs-reg-btn').forEach(btn => {
                const idx = parseInt(btn.dataset.idx);
                const ch = channels[idx];
                const btnsArea = btn.closest('.cs-card-buttons');
                handleRegisterClick(btn, ch, idx, btnsArea);
            });
        } else {
            // 야담: 등록 버튼 개별 바인딩
            area.querySelectorAll('.cs-reg-single').forEach(btn => {
                const idx = parseInt(btn.dataset.idx);
                const ch = channels[idx];
                const card = btn.closest('.cs-channel-card') || btn.closest('[data-idx]');

                btn.addEventListener('click', async () => {
                    if (btn.dataset.registered === 'true') {
                        // 해제 동작
                        btn.dataset.registered = 'false';
                        btn.textContent = '등록';
                        btn.classList.remove('cs-reg-selected');
                        card.classList.remove('cs-pre-registered');
                        updateRegisterAllBtn();
                        return;
                    }

                    // 개별 즉시 등록
                    btn.disabled = true;
                    btn.textContent = '등록 중...';
                    try {
                        await api.addChannel({
                            channel_id: ch.channel_id,
                            name: ch.name,
                            thumbnail_url: ch.thumbnail_url,
                            subscriber_count: ch.subscriber_count,
                            group_tag: selectedCategory,
                            sub_type: null
                        });
                        btn.textContent = '등록완료';
                        btn.disabled = true;
                        btn.classList.add('cs-reg-completed');
                        card.style.opacity = '0.5';
                        registeredChannels.add(ch.channel_id);
                    } catch (err) {
                        if (err.message?.includes('409') || err.message?.includes('이미')) {
                            btn.textContent = '등록됨';
                            btn.disabled = true;
                            btn.classList.add('cs-reg-completed');
                            card.style.opacity = '0.5';
                        } else {
                            console.error('[등록] 실패:', err);
                            btn.disabled = false;
                            btn.textContent = '등록';
                        }
                    }
                });
            });

            const selectAllBtn = area.querySelector('#cs-select-all-btn');
            const registerAllBtn = area.querySelector('#cs-register-all-btn');
            let allSelected = false;

            function updateRegisterAllBtn() {
                if (!registerAllBtn) return;
                const selected = area.querySelectorAll('.cs-reg-single[data-registered="true"]');
                registerAllBtn.disabled = selected.length === 0;
                registerAllBtn.textContent = selected.length > 0
                    ? `전체 등록하기 (${selected.length}개)`
                    : '전체 등록하기';
            }

            if (selectAllBtn) {
                selectAllBtn.addEventListener('click', () => {
                    allSelected = !allSelected;

                    area.querySelectorAll('.cs-reg-single').forEach(btn => {
                        if (btn.classList.contains('cs-reg-completed')) return;

                        if (allSelected) {
                            btn.dataset.registered = 'true';
                            btn.textContent = '해제';
                            btn.classList.add('cs-reg-selected');
                            const card = btn.closest('.cs-channel-card') || btn.closest('[data-idx]');
                            if (card) card.classList.add('cs-pre-registered');
                        } else {
                            btn.dataset.registered = 'false';
                            btn.textContent = '등록';
                            btn.classList.remove('cs-reg-selected');
                            const card = btn.closest('.cs-channel-card') || btn.closest('[data-idx]');
                            if (card) card.classList.remove('cs-pre-registered');
                        }
                    });

                    selectAllBtn.textContent = allSelected ? '전체 해제' : '전체 선택';
                    updateRegisterAllBtn();
                });
            }

            if (registerAllBtn) {
                registerAllBtn.addEventListener('click', async () => {
                    const selectedBtns = [...area.querySelectorAll('.cs-reg-single[data-registered="true"]')];
                    if (selectedBtns.length === 0) return;

                    registerAllBtn.disabled = true;
                    registerAllBtn.textContent = '등록 중...';

                    let successCount = 0;
                    let failCount = 0;

                    for (const btn of selectedBtns) {
                        const idx = parseInt(btn.dataset.idx);
                        const ch = channels[idx];
                        const card = btn.closest('.cs-channel-card') || btn.closest('[data-idx]');

                        btn.disabled = true;
                        btn.textContent = '등록 중...';

                        try {
                            await api.addChannel({
                                channel_id: ch.channel_id,
                                name: ch.name,
                                thumbnail_url: ch.thumbnail_url,
                                subscriber_count: ch.subscriber_count,
                                group_tag: selectedCategory,
                                sub_type: null
                            });
                            btn.textContent = '등록완료';
                            btn.classList.remove('cs-reg-selected');
                            btn.classList.add('cs-reg-completed');
                            btn.dataset.registered = 'false';
                            if (card) {
                                card.style.opacity = '0.5';
                                card.classList.remove('cs-pre-registered');
                            }
                            registeredChannels.add(ch.channel_id);
                            successCount++;
                        } catch (err) {
                            if (err.message?.includes('409') || err.message?.includes('이미')) {
                                btn.textContent = '등록됨';
                                btn.classList.add('cs-reg-completed');
                                btn.classList.remove('cs-reg-selected');
                                btn.dataset.registered = 'false';
                                if (card) card.classList.remove('cs-pre-registered');
                                successCount++;
                            } else {
                                console.error('[등록] 실패:', ch.channel_id, err);
                                btn.disabled = false;
                                btn.textContent = '등록';
                                btn.classList.remove('cs-reg-selected');
                                btn.dataset.registered = 'false';
                                if (card) card.classList.remove('cs-pre-registered');
                                failCount++;
                            }
                        }
                    }

                    allSelected = false;
                    if (selectAllBtn) selectAllBtn.textContent = '전체 선택';
                    registerAllBtn.textContent = '전체 등록하기';
                    registerAllBtn.disabled = true;
                    showToast(`등록 완료: 성공 ${successCount}건${failCount > 0 ? ', 실패 ' + failCount + '건' : ''}`, 'info');
                });
            }
        }
    }

    // ── 일괄 채널 등록 ──
    async function registerChannels(selected, subType, area, allChannels) {
        const results = { success: 0, fail: 0, errors: [] };
        for (const ch of selected) {
            try {
                await api.addChannel({
                    channel_id: ch.channel_id,
                    name: ch.name,
                    thumbnail_url: ch.thumbnail_url || '',
                    subscriber_count: ch.subscriber_count || 0,
                    video_count: ch.video_count || 0,
                    group_tag: selectedCategory,
                    description: ch.description || '',
                    sub_type: subType || null
                });
                results.success++;
                registeredChannels.add(ch.channel_id);
            } catch (e) {
                if (e.message?.includes('409') || e.message?.includes('already')) {
                    results.success++;
                    registeredChannels.add(ch.channel_id);
                } else {
                    results.fail++;
                    results.errors.push(ch.channel_name);
                }
            }
        }

        // 등록된 카드 체크박스 비활성화 + "등록됨" 표시
        if (area) {
            area.querySelectorAll('.cs-ch-check').forEach(cb => {
                const idx = parseInt(cb.dataset.idx);
                const ch = allChannels[idx];
                if (ch && registeredChannels.has(ch.channel_id)) {
                    cb.disabled = true;
                    cb.checked = false;
                    const card = cb.closest('.cs-channel-card');
                    if (card) {
                        card.style.opacity = '0.5';
                        const nameEl = card.querySelector('.cs-card-name');
                        if (nameEl) nameEl.insertAdjacentHTML('afterend', ` <span style="color:#34d399;font-size:12px">등록됨 ${icons.check()}</span>`);
                    }
                }
            });
            // 전체선택 체크박스 + 등록버튼 재계산
            const remaining = [...area.querySelectorAll('.cs-ch-check:not(:disabled)')];
            const regBtn = area.querySelector('#cs-register-btn');
            if (regBtn) { regBtn.disabled = true; regBtn.textContent = '선택 채널 등록 (0개)'; }
            const selAll = area.querySelector('#cs-select-all');
            if (selAll) selAll.checked = false;
        }

        showChannelRegisterReport(results);
    }

    // ── 경제 채널 만화/실사 선택 모달 ──
    function showSubTypeModal(label, onConfirm) {
        const existing = document.getElementById('subtype-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'subtype-modal-overlay';
        overlay.className = 'dr-modal-overlay';
        overlay.innerHTML = `
      <div class="dr-modal-box">
        <div class="dr-modal-title">${label} 채널 유형 선택</div>
        <div class="dr-modal-subtitle">경제 채널의 유형을 선택해주세요</div>
        <div class="cs-subtype-btns">
          <button class="cs-subtype-btn" data-type="만화">
            <div class="cs-subtype-icon">🎨</div>
            <div class="cs-subtype-label">만화 경제 채널</div>
            <div class="cs-subtype-desc">애니메이션/캐릭터 기반</div>
          </button>
          <button class="cs-subtype-btn" data-type="실사">
            <div class="cs-subtype-icon">📹</div>
            <div class="cs-subtype-label">실사 경제 채널</div>
            <div class="cs-subtype-desc">뉴스/강의/인터뷰 기반</div>
          </button>
        </div>
        <div class="dr-modal-btns">
          <button class="dr-cancel-btn">취소</button>
        </div>
      </div>
    `;
        document.body.appendChild(overlay);

        overlay.querySelectorAll('.cs-subtype-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.remove();
                onConfirm(btn.dataset.type);
            });
        });
        overlay.querySelector('.dr-cancel-btn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    // ── 수집 진행 모달 표시 ──
    function showCollectProgressModal(total) {
        hideCollectModal();
        const el = document.createElement('div');
        el.id = 'collect-modal-overlay';
        el.className = 'collect-modal-overlay';
        el.innerHTML = `
      <div class="collect-modal-box">
        <div class="collect-modal-spinner"></div>
        <div class="collect-modal-title">영상 수집 중...</div>
        <div class="collect-modal-progress-wrap">
          <div class="collect-modal-progress-bar" id="collect-progress-bar" style="width:0%"></div>
        </div>
        <div class="collect-modal-count" id="collect-progress-count">0 / ${total}</div>
        <div class="collect-modal-current" id="collect-progress-current">준비 중...</div>
      </div>
    `;
        document.body.appendChild(el);
    }

    function updateCollectProgress(current, total, title) {
        const bar = document.getElementById('collect-progress-bar');
        const count = document.getElementById('collect-progress-count');
        const curr = document.getElementById('collect-progress-current');
        if (bar) bar.style.width = `${Math.round((current / total) * 100)}%`;
        if (count) count.textContent = `${current} / ${total}`;
        if (curr) curr.textContent = title.length > 40 ? title.slice(0, 40) + '...' : title;
    }

    function hideCollectModal() {
        document.getElementById('collect-modal-overlay')?.remove();
    }

    function showCollectResultModal(summary, results) {
        // finally에서 처리됨
        const detailRows = results.map((r, i) => {
            const chLabel = r.channelResult === 'new' ? `신규등록 ${icons.success()}`
                : r.channelResult === 'existing' ? `기등록 ${icons.folder()}`
                : `등록실패 ${icons.error()}`;
            const vLabel = r.videoResult === 'saved' ? `저장 ${icons.success()}`
                : r.videoResult === 'duplicate' ? `중복 ${icons.warning()}`
                : `실패 ${icons.error()}`;
            const title = r.title.length > 35 ? r.title.slice(0, 35) + '...' : r.title;
            return `<div class="collect-result-row">
        <span class="collect-result-num">${i + 1}.</span>
        <div class="collect-result-info">
          <div class="collect-result-title">${title}</div>
          <div class="collect-result-meta">
            <span>${r.channel_name}</span>
            <span class="collect-result-tag">채널: ${chLabel}</span>
            <span class="collect-result-tag">영상: ${vLabel}</span>
          </div>
        </div>
      </div>`;
        }).join('');

        const el = document.createElement('div');
        el.id = 'collect-modal-overlay';
        el.className = 'collect-modal-overlay';
        el.innerHTML = `
      <div class="collect-modal-box collect-modal-result">
        <div class="collect-modal-title">영상 수집 완료</div>
        <div class="collect-summary">
          <div class="collect-summary-row"><span class="cs-ok">${icons.success()} 영상 저장 성공</span><strong>${summary.videoSaved}건</strong></div>
          <div class="collect-summary-row"><span class="cs-warn">${icons.warning()} 영상 이미 존재</span><strong>${summary.videoDuplicate}건</strong></div>
          <div class="collect-summary-row"><span class="cs-err">${icons.error()} 영상 저장 실패</span><strong>${summary.videoError}건</strong></div>
          <div class="collect-summary-divider"></div>
          <div class="collect-summary-row"><span class="cs-ok">${icons.folder()} 신규 채널 등록</span><strong>${summary.channelNew}건</strong></div>
          <div class="collect-summary-row"><span class="cs-muted">${icons.folder()} 기존 채널 (등록 생략)</span><strong>${summary.channelExisting}건</strong></div>
          <div class="collect-summary-row"><span class="cs-err">${icons.error()} 채널 등록 실패</span><strong>${summary.channelError}건</strong></div>
        </div>
        <details class="collect-detail-wrap">
          <summary class="collect-detail-toggle">상세 내역 ▼</summary>
          <div class="collect-detail-list">${detailRows}</div>
        </details>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;">
          ${summary.videoError > 0
            ? `<button class="collect-modal-confirm-btn" id="collect-retry-btn" style="background:rgba(255,107,107,0.15);border:1px solid rgba(255,107,107,0.4);color:#ff6b6b;">실패 영상 재시도 (${summary.videoError}건)</button>`
            : ''}
          <button class="collect-modal-confirm-btn" id="collect-confirm-btn">확인</button>
        </div>
      </div>
    `;
        document.body.appendChild(el);

        document.getElementById('collect-confirm-btn').addEventListener('click', async () => {
            hideCollectModal();
            // 검색 결과 자동 갱신
            selectedVideos.clear();
            if (searchResults.length > 0) {
                try {
                    const existRes = await api.checkExistingVideos(searchResults.map(v => v.video_id));
                    existingVideoIds = new Set(existRes.existing || []);
                    searchResults.forEach(v => {
                        v._isCollected = existingVideoIds.has(v.video_id);
                        v._isRegistered = registeredChannels.has(v.channel_id);
                    });
                } catch (e) { /* 무시 */ }
            }
            renderResults();
        });

        const retryBtn = document.getElementById('collect-retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                hideCollectModal();
                const failedVideoIds = new Set(
                    results.filter(r => r.videoResult === 'error').map(r => r.video_id)
                );
                const retryList = searchResults.filter(v => failedVideoIds.has(v.video_id));
                collectSelectedVideos(retryList);
            });
        }
    }

    // ── 타임아웃 래퍼 ──
    function fetchWithTimeout(promise, ms = 30000) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('타임아웃')), ms)
            )
        ]);
    }

    // ── 연속 실패 시 중단 여부 확인 모달 ──
    function showContinueModal() {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'sr-modal-overlay';
            overlay.innerHTML = `
        <div class="sr-modal-box">
          <div class="sr-modal-title">연속 실패 감지</div>
          <div class="sr-modal-body">
            <div class="sr-notice">연속 5건 실패했습니다.<br>계속 진행하시겠습니까?</div>
          </div>
          <div class="sr-modal-btns" style="display:flex;gap:10px;justify-content:center;">
            <button id="continue-stop-btn" style="padding:10px 24px;background:rgba(255,107,107,0.15);border:1px solid rgba(255,107,107,0.4);color:#ff6b6b;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">중단</button>
            <button id="continue-go-btn" style="padding:10px 24px;background:var(--accent-gold,#f0c674);color:#000;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">계속</button>
          </div>
        </div>`;
            document.body.appendChild(overlay);
            overlay.querySelector('#continue-stop-btn').addEventListener('click', () => {
                overlay.remove();
                resolve(false);
            });
            overlay.querySelector('#continue-go-btn').addEventListener('click', () => {
                overlay.remove();
                resolve(true);
            });
        });
    }

    // ── 선택 영상 수집 ──
    async function collectSelectedVideos(retryList = null) {
        const toCollect = retryList || searchResults.filter(v =>
            selectedVideos.has(v.video_id) && !v._isCollected
        );

        if (toCollect.length === 0) {
            showToast('수집할 영상이 없습니다 (이미 수집된 영상만 선택됨)');
            return;
        }

        const collectBtn = container.querySelector('#vs-collect-btn');
        if (collectBtn) { collectBtn.disabled = true; collectBtn.textContent = '수집 중...'; }

        showCollectProgressModal(toCollect.length);

        let results = [];
        let consecutiveErrors = 0;
        let aborted = false;

        try {
            for (const v of toCollect) {
                if (aborted) break;

                const result = {
                    video_id: v.video_id,
                    title: v.title,
                    channel_name: v.channel_name,
                    channelResult: 'existing',
                    videoResult: ''
                };

                // 채널 등록
                if (!v._isRegistered) {
                    try {
                        await fetchWithTimeout(api.addChannel({
                            channel_id: v.channel_id,
                            name: v.channel_name,
                            thumbnail_url: v.channel_thumbnail || '',
                            subscriber_count: v.subscriber_count,
                            group_tag: selectedCategory,
                            description: '',
                            initial_video_data: [{ title: v.title, description: v.description || '' }],
                            search_context: [...activeKeywords].join(' ')
                        }));
                        registeredChannels.add(v.channel_id);
                        result.channelResult = 'new';
                    } catch (chErr) {
                        if (chErr.message?.includes('409') || chErr.message?.includes('이미')) {
                            registeredChannels.add(v.channel_id);
                            result.channelResult = 'existing';
                        } else {
                            console.error('[수집] 채널 등록 실패:', chErr);
                            result.channelResult = 'error';
                        }
                    }
                }

                // 영상 저장
                try {
                    await fetchWithTimeout(api.addVideoManual({
                        video_id: v.video_id,
                        title: v.title,
                        description: v.description || '',
                        channel_id: v.channel_id,
                        channel_name: v.channel_name,
                        channel_thumbnail: v.channel_thumbnail || '',
                        subscriber_count: v.subscriber_count,
                        published_at: v.published_at,
                        view_count: v.view_count,
                        like_count: v.like_count,
                        comment_count: v.comment_count,
                        duration_seconds: v.duration_seconds,
                        thumbnail_url: v.thumbnail_url,
                        group_tag: selectedCategory,
                        skipRebuild: true
                    }));
                    existingVideoIds.add(v.video_id);
                    v._isCollected = true;
                    v._isRegistered = true;
                    result.videoResult = 'saved';
                    consecutiveErrors = 0;
                } catch (vErr) {
                    if (vErr.message?.includes('409') || vErr.message?.includes('이미')) {
                        existingVideoIds.add(v.video_id);
                        v._isCollected = true;
                        result.videoResult = 'duplicate';
                        consecutiveErrors = 0;
                    } else {
                        console.error('[수집] 영상 저장 실패:', vErr);
                        result.videoResult = 'error';
                        consecutiveErrors++;
                        if (consecutiveErrors >= 5) {
                            results.push(result);
                            updateCollectProgress(results.length, toCollect.length, v.title);
                            const shouldContinue = await showContinueModal();
                            if (!shouldContinue) { aborted = true; break; }
                            consecutiveErrors = 0;
                            continue;
                        }
                    }
                }

                results.push(result);
                updateCollectProgress(results.length, toCollect.length, v.title);
            }
        } catch (err) {
            console.error('[수집] 예외 발생:', err);
        } finally {
            hideCollectModal();

            // 수집 완료 후 랭킹 1회 재구축
            if (selectedCategory) {
                try {
                    await api.rebuildVideoRankings(selectedCategory);
                    console.log('[수집] 랭킹 재구축 완료:', selectedCategory);
                } catch (e) {
                    console.warn('[수집] 랭킹 재구축 실패:', e);
                }
            }

            const summary = {
                videoSaved: results.filter(r => r.videoResult === 'saved').length,
                videoDuplicate: results.filter(r => r.videoResult === 'duplicate').length,
                videoError: results.filter(r => r.videoResult === 'error').length,
                channelNew: results.filter(r => r.channelResult === 'new').length,
                channelExisting: results.filter(r => r.channelResult === 'existing').length,
                channelError: results.filter(r => r.channelResult === 'error').length,
            };

            if (results.length > 0) {
                showCollectResultModal(summary, results);
            }

            if (collectBtn) {
                collectBtn.disabled = false;
                collectBtn.textContent = '선택 영상 수집 (0건)';
            }
            selectedVideos.clear();
        }
    }

    // ── 이벤트 바인딩 ──
    function bindEvents() {
        // 탭 전환
        container.querySelectorAll('.vs-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                if (currentTab === tab.dataset.tab) return;
                currentTab = tab.dataset.tab;
                render();
                bindEvents();
                // 채널 탭으로 전환 시 저장된 결과 복원
                if (currentTab === 'channel' && lastChannelSearchResults) {
                    renderChannelResults(lastChannelSearchResults, lastChannelSearchMeta?.registeredExcluded || 0);
                    const resetBtn = container.querySelector('#cs-reset-btn');
                    if (resetBtn) resetBtn.style.display = 'inline-flex';
                }
                if (currentTab === 'video' && searchResults.length > 0) {
                    renderResults();
                    const resetBtn = container.querySelector('#vs-reset-btn');
                    if (resetBtn) resetBtn.style.display = '';
                }
            });
        });

        // 카테고리 선택
        container.querySelectorAll('.vs-cat-btn:not(.add-new)').forEach(btn => {
            btn.addEventListener('click', async () => {
                selectedCategory = btn.dataset.cat;
                updateCategoryUI();
                activeKeywords.clear();
                await loadKeywordTags(selectedCategory);
                updateSearchBtnState();
            });
        });

        // ── 카테고리 드래그 정렬 ──
        let dragSrcIdx = null;
        container.querySelectorAll('.vs-cat-btn[draggable]').forEach(btn => {
            btn.addEventListener('dragstart', (e) => {
                dragSrcIdx = parseInt(btn.dataset.catIdx);
                btn.classList.add('vs-cat-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(dragSrcIdx));
            });
            btn.addEventListener('dragend', () => {
                btn.classList.remove('vs-cat-dragging');
                container.querySelectorAll('.vs-cat-btn').forEach(b => b.classList.remove('vs-cat-drag-over'));
            });
            btn.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                btn.classList.add('vs-cat-drag-over');
            });
            btn.addEventListener('dragleave', () => {
                btn.classList.remove('vs-cat-drag-over');
            });
            btn.addEventListener('drop', async (e) => {
                e.preventDefault();
                btn.classList.remove('vs-cat-drag-over');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                const toIdx = parseInt(btn.dataset.catIdx);
                if (fromIdx === toIdx || isNaN(fromIdx) || isNaN(toIdx)) return;
                const moved = categories.splice(fromIdx, 1)[0];
                categories.splice(toIdx, 0, moved);
                try { await api.reorderCategories(categories.map(c => c.name)); } catch (err) { console.error('카테고리 순서 저장 실패:', err); }
                render();
                bindEvents();
            });
        });

        // ⚙ 관리 모드 토글
        const manageBtn = container.querySelector('#vs-manage-btn');
        if (manageBtn) {
            manageBtn.addEventListener('click', async () => {
                isManageMode = !isManageMode;
                // 카테고리 미선택 시 첫 번째 카테고리 자동 선택
                if (isManageMode && !selectedCategory && categories.length > 0) {
                    selectedCategory = categories[0].name;
                }
                render();
                bindEvents();
                if (isManageMode && selectedCategory) {
                    await loadKeywordTags(selectedCategory);
                }
            });
        }

        // ＋ 신규 카테고리 추가
        const addCatBtn = container.querySelector('#vs-add-cat-btn');
        if (addCatBtn) {
            addCatBtn.addEventListener('click', () => {
                showInputModal({
                    title: '신규 카테고리 추가',
                    placeholder: '카테고리명 입력',
                    onConfirm: (name) => {
                        if (!name) return;
                        if (categories.some(c => c.name === name)) { showToast('이미 존재하는 카테고리입니다.', 'warning'); return; }
                        showSubTypeModeModal(name, async (mode) => {
                            showMaterialRegistModal(name, mode, async (materials) => {
                                try {
                                    await api.addCategory(name, mode);
                                    const groupName = name.trim() + '소재';
                                    for (let i = 0; i < materials.length; i++) {
                                        await api.addMaterial(groupName, materials[i].name, materials[i].keywords);
                                    }

                                    const baseName = name.trim();
                                    if (mode === 'dual') {
                                        for (const m of materials) {
                                            if (!m.name) continue;
                                            try {
                                                await api.addCategoryKeyword(baseName, m.name, 'channel');
                                            } catch (e) {
                                                console.warn('[검색키워드 등록] 건너뜀:', m.name, e.message);
                                            }
                                        }
                                    } else {
                                        for (const m of materials) {
                                            if (!m.name) continue;
                                            try {
                                                await api.addCategoryKeyword(baseName, m.name, 'channel');
                                                await api.addCategoryKeyword(baseName, m.name, 'video');
                                            } catch (e) {
                                                console.warn('[검색키워드 등록] 건너뜀:', m.name, e.message);
                                            }
                                        }
                                    }
                                    console.log('[카테고리 등록] 검색 키워드 등록 완료:', materials.map(m => m.name));

                                    categories.push({ name: name.trim(), sub_type_mode: mode, material_group_name: groupName });
                                    selectedCategory = name.trim();
                                    render();
                                    bindEvents();
                                } catch (err) {
                                    showToast(err.message || '카테고리 추가 실패', 'error');
                                }
                            });
                        });
                    }
                });
            });
        }

        // 카테고리 ✕ 삭제
        container.querySelectorAll('.cat-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const cat = btn.dataset.cat;
                showConfirmModal({
                    title: `'${cat}' 카테고리를 삭제하시겠습니까?`,
                    message: '등록된 키워드도 함께 삭제됩니다.\n수집된 채널과 영상 데이터는 유지됩니다.',
                    onConfirm: async () => {
                        try {
                            await api.deleteCategory(cat);
                            categories = categories.filter(c => c.name !== cat);
                            if (selectedCategory === cat) {
                                selectedCategory = '';
                                activeKeywords.clear();
                            }
                            render();
                            bindEvents();
                        } catch (err) {
                            showToast(err.message || '카테고리 삭제 실패', 'error');
                        }
                    }
                });
            });
        });

        // 키워드 태그 토글
        container.querySelectorAll('.vs-kw-tag').forEach(tag => {
            tag.addEventListener('click', () => toggleKeyword(tag));
        });

        // 커스텀 키워드 Enter
        const kwInput = container.querySelector('#vs-kw-custom');
        if (kwInput) {
            kwInput.addEventListener('focus', () => {
                if (!selectedCategory) {
                    kwInput.blur();
                    showToast('카테고리를 먼저 선택해주세요');
                }
            });
            kwInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    if (!selectedCategory) {
                        showToast('카테고리를 먼저 선택해주세요');
                        return;
                    }
                    const val = kwInput.value.trim();
                    if (!val) return;
                    kwInput.value = '';

                    if (!activeKeywords.has(val)) {
                        activeKeywords.add(val);
                        const tagsEl = container.querySelector('#vs-kw-tags');
                        if (tagsEl && !tagsEl.querySelector('[data-kw="' + val + '"]')) {
                            const tag = document.createElement('div');
                            tag.className = 'vs-kw-tag active';
                            tag.dataset.kw = val;
                            tag.textContent = val;
                            tag.addEventListener('click', () => toggleKeyword(tag));
                            tagsEl.appendChild(tag);
                        }
                    }
                    updateSearchBtnState();
                    if (selectedCategory && !isSearching) {
                        doVideoSearch();
                    }
                }
            });
            kwInput.addEventListener('input', updateSearchBtnState);
        }

        // 검색 버튼
        const searchBtn = container.querySelector('#vs-search-btn');
        if (searchBtn) {
            searchBtn.addEventListener('click', () => {
                if (currentTab === 'video') doVideoSearch();
                else doChannelSearch();
            });
        }

        // 채널 검색 — 초기화 버튼
        const csResetBtn = container.querySelector('#cs-reset-btn');
        if (csResetBtn) {
            csResetBtn.addEventListener('click', () => {
                lastChannelSearchResults = null;
                lastChannelSearchMeta = null;
                try { sessionStorage.removeItem('cs_results'); sessionStorage.removeItem('cs_meta'); } catch (e) { /* ignore */ }
                const area = container.querySelector('#vs-results-area');
                if (area) area.innerHTML = '';
                activeKeywords.clear();
                const kwInput = container.querySelector('#vs-kw-custom');
                if (kwInput) kwInput.value = '';
                csResetBtn.style.display = 'none';
                updateSearchBtnState();
                if (selectedCategory) loadKeywordTags(selectedCategory);
            });
        }

        // 채널 검색 — 구독자 직접입력 토글
        const subsSelect = container.querySelector('#vs-ch-subs');
        if (subsSelect) {
            subsSelect.addEventListener('change', () => {
                const area = container.querySelector('#vs-ch-subs-custom-area');
                if (area) area.style.display = subsSelect.value === 'custom' ? 'flex' : 'none';
            });
        }

        // 선택된 카테고리가 있으면 현재 탭 키워드 태그 로드
        if (selectedCategory) {
            loadKeywordTags(selectedCategory);
        }
    }

    // ── 결과 영역 이벤트 ──
    function bindResultEvents() {
        container.querySelectorAll('.vs-card-check').forEach(cb => {
            cb.addEventListener('change', () => {
                const vid = cb.dataset.vid;
                if (cb.checked) selectedVideos.add(vid);
                else selectedVideos.delete(vid);
                cb.closest('.vs-card')?.classList.toggle('selected', cb.checked);
                updateCollectBtn();
            });
        });

        const selectAll = container.querySelector('#vs-select-all');
        if (selectAll) {
            selectAll.addEventListener('click', () => {
                const allChecks = [...container.querySelectorAll('.vs-card-check:not(:disabled)')];
                const allSelected = allChecks.every(cb => cb.checked);
                allChecks.forEach(cb => {
                    cb.checked = !allSelected;
                    const vid = cb.dataset.vid;
                    if (!allSelected) selectedVideos.add(vid);
                    else selectedVideos.delete(vid);
                    cb.closest('.vs-card')?.classList.toggle('selected', !allSelected);
                });
                updateCollectBtn();
            });
        }

        const collectBtn = container.querySelector('#vs-collect-btn');
        if (collectBtn) {
            collectBtn.addEventListener('click', () => collectSelectedVideos());
        }

        const resetBtn = container.querySelector('#vs-reset-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                searchResults = [];
                selectedVideos.clear();
                activeKeywords.clear();
                existingVideoIds = new Set();
                sessionStorage.removeItem('vs_results');
                sessionStorage.removeItem('vs_meta');
                renderResults();
                // 키워드 태그 초기화
                const tagsEl = container.querySelector('#vs-kw-tags');
                if (tagsEl) {
                    tagsEl.querySelectorAll('.vs-kw-tag').forEach(tag => {
                        tag.classList.remove('active');
                    });
                }
                // 수집 버튼 초기화
                const collectBtn = container.querySelector('#vs-collect-btn');
                if (collectBtn) collectBtn.textContent = '선택 영상 수집 (0건)';
                // 초기화 버튼 숨김
                resetBtn.style.display = 'none';
                showToast('검색이 초기화되었습니다.', 'info');
            });
        }

        updateCollectBtn();
    }

    // ── 키워드 토글 ──
    function toggleKeyword(tag) {
        const kw = tag.dataset.kw;
        if (activeKeywords.has(kw)) {
            activeKeywords.delete(kw);
            tag.classList.remove('active');
        } else {
            activeKeywords.add(kw);
            tag.classList.add('active');
        }
        updateSearchBtnState();
    }

    // ── UI 업데이트 헬퍼 ──
    function updateCollectBtn() {
        const btn = container.querySelector('#vs-collect-btn');
        if (!btn) return;
        btn.textContent = `선택 영상 수집 (${selectedVideos.size}건)`;
        btn.disabled = selectedVideos.size === 0;
        btn.classList.toggle('enabled', selectedVideos.size > 0);
    }

    function updateSearchBtnState() {
        const btn = container.querySelector('#vs-search-btn');
        if (!btn) return;
        const customVal = !!container.querySelector('#vs-kw-custom')?.value?.trim();
        const hasInput = activeKeywords.size > 0 || customVal;
        btn.disabled = !(selectedCategory && hasInput);
    }

    function updateCategoryUI() {
        container.querySelectorAll('.vs-cat-btn:not(.add-new)').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.cat === selectedCategory);
        });
    }

    // ── 로딩 표시 ──
    function showSearchReportModal(report, refreshResult = null) {
        const hasResults = report.finalCount > 0;
        const hasErrors = report.errors.length > 0;

        let title, bodyHTML;

        if (hasErrors && report.totalFromAPI === 0) {
            title = '검색 실패';
            bodyHTML = `
        <div class="sr-error">
          <p>${icons.warning()} YouTube API 오류:</p>
          <p class="sr-error-msg">"${report.errors[0]}"</p>
          <p>잠시 후 다시 시도해주세요.</p>
        </div>`;
        } else {
            title = '검색 완료';
            bodyHTML = `
        <div class="sr-keywords">검색 키워드: ${report.keywords.join(', ')}</div>
        <div class="sr-stats">
          <div class="sr-row">
            <span>YouTube 검색 결과</span>
            <span>${report.totalFromAPI}건</span>
          </div>
          <div class="sr-row">
            <span>쇼츠(5분 이하) 제외</span>
            <span>-${report.shortsExcluded}건</span>
          </div>
          <div class="sr-row">
            <span>이미 수집된 영상 제외</span>
            <span>-${report.alreadyCollected}건</span>
          </div>
          <div class="sr-divider"></div>
          <div class="sr-row sr-final">
            <span>새로운 영상</span>
            <span>${report.afterCollectedFilter}건</span>
          </div>
        </div>
        ${!hasResults ? `
        <div class="sr-notice">
          ${icons.warning()} 모든 영상이 이미 수집되어 있습니다.<br>
          다른 키워드를 추가하여 검색해보세요.
        </div>` : ''}
        ${hasErrors ? `
        <div class="sr-warning">일부 키워드 검색 중 오류 발생 (${report.errors.length}건)</div>` : ''}`;
        }

        const rc = refreshResult?.rankingChanges;
        const refreshHTML = refreshResult ? `
        <div class="sr-refresh-section">
          ${rc && rc.totalChanges > 0 ? `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span style="font-size:18px;">${icons.fire()}</span>
              <span style="font-size:15px;font-weight:700;color:#ff6b6b;">TOP50 순위 변동 발생!</span>
            </div>
            <div style="font-size:13px;color:rgba(255,255,255,0.6);margin-bottom:6px;">
              ${rc.newEntries > 0 ? `신규 진입 ${rc.newEntries}건` : ''}
              ${rc.rankUps > 0 ? ` · 순위 상승 ${rc.rankUps}건` : ''}
              ${rc.dropOuts > 0 ? ` · 탈락 ${rc.dropOuts}건` : ''}
            </div>
            <div style="font-size:13px;color:#60a5fa;font-weight:600;">TOP50에 자동 반영 완료</div>
          ` : `
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:14px;">📊</span>
              <span style="font-size:13px;color:rgba(255,255,255,0.4);">기존 영상 ${refreshResult.updated}건 재검수 – 순위 변동 없음</span>
            </div>
          `}
        </div>` : '';

        const overlay = document.createElement('div');
        overlay.className = 'sr-modal-overlay';
        overlay.innerHTML = `
      <div class="sr-modal-box">
        <div class="sr-modal-title">${title}</div>
        <div class="sr-modal-body">${bodyHTML}${refreshHTML}</div>
        <div class="sr-modal-btns">
          <button class="sr-modal-confirm">확인</button>
        </div>
      </div>`;

        overlay.querySelector('.sr-modal-confirm')
            .addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    }

    function renderLoading() {
        const area = container.querySelector('#vs-results-area');
        if (area) {
            area.innerHTML = `
        <div class="vs-loading">
          <div class="vs-loading-spinner"></div>
          ${currentTab === 'video' ? '떡상 영상을 검색하고 있습니다...' : '채널을 검색하고 있습니다...'}
        </div>
      `;
        }
    }

    // ── 포맷 헬퍼 ──
    function getSpikeGrade(ratio) {
        if (ratio >= 100) return { text: '초대박', cls: 'vs-grade-super' };
        if (ratio >= 50) return { text: '대박', cls: 'vs-grade-great' };
        if (ratio >= 10) return { text: '떡상', cls: 'vs-grade-good' };
        if (ratio >= 5) return { text: '선방', cls: 'vs-grade-ok' };
        return { text: '', cls: '' };
    }

    function formatCount(n) {
        if (!n) return '0';
        if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '만';
        if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + '천';
        return n.toLocaleString();
    }

    function formatDuration(sec) {
        if (!sec) return '0:00';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    }

    // ── 입력 모달 (공통) ──
    // ── 화풍 선택 모달 ──
    function showSubTypeModeModal(categoryName, onConfirm) {
        document.querySelector('.subtype-mode-modal-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'confirm-modal-overlay subtype-mode-modal-overlay';
        overlay.innerHTML = `
          <div class="confirm-modal-box" style="max-width:660px;width:660px;padding:40px;">
            <div class="confirm-modal-title" style="font-size:22px;font-weight:700;">채널 화풍 설정</div>
            <div style="color:#ccc;font-size:15px;margin-bottom:20px;">이 카테고리의 채널들은 어떤 화풍을 사용하나요?</div>
            <div style="display:flex;gap:16px;margin-bottom:24px;">
              <div class="subtype-card" data-mode="dual" style="flex:1;padding:24px;border:2px solid rgba(255,255,255,0.15);border-radius:12px;cursor:pointer;transition:all 0.2s;text-align:center;">
                <div style="font-weight:600;font-size:18px;color:#fff;margin-bottom:8px;">실사 또는 만화 모두 있음</div>
                <div style="font-size:15px;color:#aaa;margin-bottom:8px;">채널마다 실사 또는 만화로 구분하여 관리합니다</div>
                <div style="font-size:15px;color:#a78bfa;">예: 경제, 심리 등</div>
              </div>
              <div class="subtype-card" data-mode="none" style="flex:1;padding:24px;border:2px solid rgba(255,255,255,0.15);border-radius:12px;cursor:pointer;transition:all 0.2s;text-align:center;">
                <div style="font-weight:600;font-size:18px;color:#fff;margin-bottom:8px;">단일 화풍</div>
                <div style="font-size:15px;color:#aaa;margin-bottom:8px;">화풍 구분 없이 채널을 관리합니다</div>
                <div style="font-size:15px;color:#a78bfa;">예: 야담 등</div>
              </div>
            </div>
            <div class="confirm-modal-btns">
              <button class="confirm-modal-delete subtype-confirm-btn" style="background:var(--accent,#7c5cff);border:none;font-size:15px;" disabled>확인</button>
              <button class="confirm-modal-cancel" style="font-size:15px;">취소</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        let selectedMode = null;
        const cards = overlay.querySelectorAll('.subtype-card');
        const confirmBtn = overlay.querySelector('.subtype-confirm-btn');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                cards.forEach(c => { c.style.border = '2px solid rgba(255,255,255,0.15)'; });
                card.style.border = '2px solid #6c5ce7';
                selectedMode = card.dataset.mode;
                confirmBtn.disabled = false;
            });
        });
        confirmBtn.addEventListener('click', () => {
            if (!selectedMode) return;
            overlay.remove();
            onConfirm(selectedMode);
        });
        overlay.querySelector('.confirm-modal-cancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    function showInputModal({ title, placeholder, onConfirm }) {
        document.querySelector('.input-modal-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'confirm-modal-overlay input-modal-overlay';
        overlay.innerHTML = `
          <div class="confirm-modal-box">
            <div class="confirm-modal-title">${title}</div>
            <input class="input-modal-field" placeholder="${placeholder}"
              style="width:100%;padding:8px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#fff;font-size:14px;margin-bottom:16px;outline:none;box-sizing:border-box;">
            <div class="confirm-modal-btns">
              <button class="confirm-modal-delete" style="background:var(--accent,#7c5cff);border:none;">확인</button>
              <button class="confirm-modal-cancel">취소</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('.input-modal-field');
        input.focus();
        const confirm = async () => {
            const val = input.value.trim();
            overlay.remove();
            await onConfirm(val);
        };
        overlay.querySelector('.confirm-modal-delete').addEventListener('click', confirm);
        overlay.querySelector('.confirm-modal-cancel').addEventListener('click', () => overlay.remove());
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') await confirm();
            if (e.key === 'Escape') overlay.remove();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    // ── 확인 모달 (공통) ──
    function showConfirmModal({ title, message, onConfirm }) {
        document.querySelector('.confirm-modal-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'confirm-modal-overlay';
        overlay.innerHTML = `
          <div class="confirm-modal-box">
            <div class="confirm-modal-title">${title}</div>
            ${message ? `<div class="confirm-modal-msg">${message.replace(/\n/g, '<br>')}</div>` : ''}
            <div class="confirm-modal-btns">
              <button class="confirm-modal-delete">삭제</button>
              <button class="confirm-modal-cancel">취소</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.confirm-modal-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.confirm-modal-delete').addEventListener('click', async () => {
            overlay.remove();
            await onConfirm();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    function showMaterialRegistModal(categoryName, subTypeMode, onConfirm) {
        document.querySelector('.material-regist-modal-overlay')?.remove();

        const html = `
            <div class="material-regist-modal-overlay confirm-modal-overlay">
              <div class="material-regist-modal">
                <h3 class="material-regist-title">소재 등록</h3>
                <p class="material-regist-desc">${categoryName} 카테고리의 콘텐츠 소재 7개를 등록해주세요.</p>
                <button type="button" class="material-ai-btn" id="mr-ai-btn">🤖 AI 자동 추천</button>
                <div class="material-inputs-grid">
                  ${Array.from({length: 7}, (_, i) => `
                    <div class="material-grid-item">
                      <div class="material-grid-header">
                        <span class="material-grid-num">${i + 1}</span>
                        <input type="text" class="material-name-input" data-idx="${i}" placeholder="소재명">
                      </div>
                      <textarea class="material-keywords-input" data-idx="${i}" rows="3" placeholder="분류 키워드 (쉼표로 구분)"></textarea>
                    </div>
                  `).join('')}
                </div>
                <div class="material-regist-buttons">
                  <button class="material-confirm-btn" id="mr-confirm-btn">확인</button>
                  <button class="material-cancel-btn" id="mr-cancel-btn">취소</button>
                </div>
              </div>
            </div>`;

        document.body.insertAdjacentHTML('beforeend', html);
        const modal = document.querySelector('.material-regist-modal-overlay');
        const nameInputs = modal.querySelectorAll('.material-name-input');
        const kwInputs = modal.querySelectorAll('.material-keywords-input');
        const aiBtn = modal.querySelector('#mr-ai-btn');
        const confirmBtn = modal.querySelector('#mr-confirm-btn');
        const cancelBtn = modal.querySelector('#mr-cancel-btn');

        // AI 추천 버튼: 소재명만 받고 모달 닫은 뒤 백그라운드로 키워드 수집
        aiBtn.addEventListener('click', () => {
            modal.remove();
            startKeywordCollection(categoryName, null, subTypeMode, onConfirm);
        });

        confirmBtn.addEventListener('click', () => {
            const materials = [...nameInputs].map((inp, i) => ({
                name: inp.value.trim(),
                keywords: kwInputs[i].value.split(',').map(k => k.trim()).filter(k => k)
            }));
            if (materials.some(m => !m.name)) {
                alert('모든 소재명을 입력해주세요.');
                return;
            }
            modal.remove();
            onConfirm(materials);
        });

        cancelBtn.addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }

    function startKeywordCollection(categoryName, materialNames, subTypeMode, onConfirm) {
        console.log('[소재추천] startKeywordCollection 진입');
        document.querySelector('.kw-progress-float')?.remove();

        const floatHtml = `
            <div class="kw-progress-float">
              <div class="kw-progress-header">
                <span>🤖 AI 소재 추천 중</span>
                <span class="kw-progress-category">${categoryName}</span>
              </div>
              <div class="kw-progress-list">
                <div class="kw-progress-item active">
                  <span class="kw-progress-status">🔄</span>
                  <span class="kw-progress-name">소재명 추천 중...</span>
                </div>
              </div>
              <div class="kw-progress-summary"></div>
            </div>`;

        document.body.insertAdjacentHTML('beforeend', floatHtml);
        const floatEl = document.querySelector('.kw-progress-float');
        console.log('[소재추천] 진행 알림 생성됨');

        (async () => {
            const summaryEl = floatEl.querySelector('.kw-progress-summary');

            // 1단계: 소재명이 없으면 받기
            if (!materialNames) {
                try {
                    console.log('[소재추천] 소재명 API 호출 시작');
                    const res = await api.suggestMaterials(categoryName);
                    const materials = res.materials || res;
                    if (!materials || materials.length === 0) {
                        summaryEl.innerHTML = `<span style="color:#f87171">${icons.error()} 소재 추천 실패. 수동으로 등록해주세요.</span>`;
                        return;
                    }
                    materialNames = materials.map(m => typeof m === 'string' ? m : m.name || '');
                    console.log('[소재추천] 소재명 API 응답:', materialNames);
                } catch (e) {
                    summaryEl.innerHTML = `<span style="color:#f87171">${icons.error()} 소재 추천 실패: ${e.message || ''}</span>`;
                    return;
                }
            }

            // 소재명 받은 후 진행 알림 업데이트
            floatEl.querySelector('.kw-progress-header span:first-child').textContent = '🤖 키워드 수집 중';
            floatEl.querySelector('.kw-progress-list').innerHTML = materialNames.map((name, i) => `
              <div class="kw-progress-item" data-idx="${i}">
                <span class="kw-progress-status">⏳</span>
                <span class="kw-progress-name">${name}</span>
                <span class="kw-progress-count"></span>
              </div>
            `).join('');

            // 2단계: 키워드 수집
            console.log('[소재추천] 키워드 수집 시작, 소재 수:', materialNames.length);
            const items = floatEl.querySelectorAll('.kw-progress-item');
            const results = materialNames.map(name => ({ name, keywords: [] }));
            let successCount = 0;
            let failCount = 0;

            for (let i = 0; i < materialNames.length; i++) {
                const name = materialNames[i];
                if (!name) continue;

                const statusEl = items[i].querySelector('.kw-progress-status');
                const countEl = items[i].querySelector('.kw-progress-count');

                statusEl.textContent = '🔄';
                items[i].classList.add('active');

                if (i > 0) {
                    await new Promise(r => setTimeout(r, 5000));
                }

                let keywords = null;
                let retries = 0;
                const maxRetries = 2;

                while (retries <= maxRetries && !keywords) {
                    try {
                        if (retries > 0) {
                            statusEl.textContent = '🔁';
                            countEl.textContent = `재시도 ${retries}/${maxRetries}`;
                            await new Promise(r => setTimeout(r, 5000));
                        }
                        const kwRes = await api.suggestKeywords(categoryName, name);
                        const kw = kwRes.keywords || kwRes;
                        if (Array.isArray(kw) && kw.length > 0) {
                            keywords = kw;
                        } else {
                            throw new Error('빈 결과');
                        }
                    } catch (e) {
                        console.warn(`[키워드] ${name} 시도 ${retries + 1} 실패:`, e.message);
                        retries++;
                    }
                }

                if (keywords) {
                    results[i].keywords = keywords;
                    statusEl.innerHTML = icons.success();
                    countEl.textContent = `${keywords.length}개`;
                    items[i].classList.remove('active');
                    items[i].classList.add('done');
                    successCount++;
                } else {
                    statusEl.innerHTML = icons.error();
                    countEl.textContent = '실패';
                    items[i].classList.remove('active');
                    items[i].classList.add('fail');
                    failCount++;
                }

                summaryEl.textContent = `완료: ${successCount + failCount}/${materialNames.length} (성공 ${successCount}, 실패 ${failCount})`;
            }

            summaryEl.innerHTML = `
                <span>${icons.success()} 키워드 수집 완료! (성공 ${successCount}, 실패 ${failCount})</span>
                <button class="kw-progress-confirm-btn">소재 등록 확인</button>
            `;

            floatEl.querySelector('.kw-progress-confirm-btn').addEventListener('click', () => {
                floatEl.remove();
                showKeywordConfirmModal(categoryName, results, subTypeMode, onConfirm);
            });
        })();
    }

    function showKeywordConfirmModal(categoryName, results, subTypeMode, onConfirm) {
        document.querySelector('.material-regist-modal-overlay')?.remove();

        const html = `
            <div class="material-regist-modal-overlay confirm-modal-overlay">
              <div class="material-regist-modal">
                <h3 class="material-regist-title">소재 등록 확인</h3>
                <p class="material-regist-desc">${categoryName} - AI 추천 결과를 확인하고 수정할 수 있습니다.</p>
                <div class="material-inputs-grid">
                  ${results.map((m, i) => `
                    <div class="material-grid-item">
                      <div class="material-grid-header">
                        <span class="material-grid-num">${i + 1}</span>
                        <input type="text" class="material-name-input" data-idx="${i}" value="${m.name}" placeholder="소재명">
                        <span class="material-kw-count">${m.keywords.length}개</span>
                      </div>
                      <textarea class="material-keywords-input" data-idx="${i}" rows="3" placeholder="분류 키워드 (쉼표로 구분)">${m.keywords.join(', ')}</textarea>
                    </div>
                  `).join('')}
                </div>
                <div class="material-regist-buttons">
                  <button class="material-confirm-btn" id="mr-confirm-btn">확인 (등록)</button>
                  <button class="material-cancel-btn" id="mr-cancel-btn">취소</button>
                </div>
              </div>
            </div>`;

        document.body.insertAdjacentHTML('beforeend', html);
        const modal = document.querySelector('.material-regist-modal-overlay');
        const nameInputs = modal.querySelectorAll('.material-name-input');
        const kwInputs = modal.querySelectorAll('.material-keywords-input');

        modal.querySelector('#mr-confirm-btn').addEventListener('click', () => {
            const materials = [...nameInputs].map((inp, i) => ({
                name: inp.value.trim(),
                keywords: kwInputs[i].value.split(',').map(k => k.trim()).filter(k => k)
            }));
            if (materials.some(m => !m.name)) {
                alert('모든 소재명을 입력해주세요.');
                return;
            }
            modal.remove();
            onConfirm(materials);
        });

        modal.querySelector('#mr-cancel-btn').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }

    // ── 실행 ──
    init();
}
