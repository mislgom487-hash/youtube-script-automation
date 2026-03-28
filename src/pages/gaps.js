// Gap analysis page — cross-category heatmap + AI deep recommendations
import { showToast } from '../components/toast.js';
import { registerPageShowCallback } from '../page-events.js';
import { icons } from '../components/icons.js';

// --- [Persistence Logic] ---
const STORAGE_KEY = 'gaps_v2_persistence';
const getStoredState = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (e) {
    return {};
  }
};
const updateStoredState = (patch) => {
  const next = { ...getStoredState(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
};

// ── 소재 목록 (모듈 스코프 — showSpikeVideoModal 탭에서도 참조) ──
let _saturationMaterialsCache = [];

const _folderIcon = icons.folderFilled();
const MATERIAL_ICONS = {
  '풍속/일상': _folderIcon,
  '복수극': _folderIcon,
  '로맨스': _folderIcon,
  '괴담/미스터리': _folderIcon,
  '범죄/옥사': _folderIcon,
  '사기/기만': _folderIcon,
  '전쟁/영웅': _folderIcon
};

export async function renderGaps(container, { api }) {
  container.innerHTML = `
    <div class="material-page-header">
      <h1><span class="material-title-accent">소재별 포화도</span> 분석</h1>
      <p>데이터 기반으로 경쟁이 적고 성장 가능성이 높은 소재를 찾아보세요</p>
    </div>
    <div class="material-genre-tabs" id="gap-tabs"></div>

    <div id="yadam-analyze-btn-wrap" style="display:none;"><button id="yadam-analyze-btn"></button></div>

    <div id="gap-results">
      <div id="yadam-results-container" class="mode-container"></div>
      <div id="economy-results-container" class="mode-container hidden"></div>
      <div id="custom-results-container" class="mode-container hidden"></div>
    </div>
  `;


  const saved = getStoredState();
  window.__appState = window.__appState || {};
  // 마지막 선택 탭 복원 (groupTag 우선, mode는 하위 호환)
  let currentGroupTag = window.__appState.gapsGroupTag
    || saved.groupTag
    || saved.mode  // backwards compat
    || '야담';
  if (currentGroupTag === 'custom' || currentGroupTag === 'economy') currentGroupTag = '야담';

  const yadamCard = document.getElementById('yadam-info-card');
  const resultsEl = document.getElementById('gap-results');
  const tabs = document.querySelectorAll('#gap-tabs button');

  const yadamCont = document.getElementById('yadam-results-container');
  const economyCont = document.getElementById('economy-results-container');
  const customCont = document.getElementById('custom-results-container');

  const updateModeUI = (groupTag) => {
    currentGroupTag = groupTag;
    window.__appState.gapsGroupTag = groupTag;
    updateStoredState({ groupTag });

    // 탭 활성화 상태 변경
    document.querySelectorAll('#gap-tabs .material-genre-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.groupTag === groupTag);
    });

    // 모든 카테고리 동일 흐름 — 소재 분포도 렌더링
    yadamCont.classList.remove('hidden');
    renderMaterialCards(api, yadamCont, groupTag);
  };

  // --- [Restoration Engine] --- deep analysis 상태만 복원
  const restoreOrResume = () => {
    const s = getStoredState();

    // Deep Analysis 복원 (Gemini 자동 재실행 차단)
    if (s.deepStatus === 'LOADING' && s.deepParams) {
      updateStoredState({ deepStatus: 'IDLE' });
      setTimeout(() => {
        const area = document.getElementById('deep-analysis-area');
        if (area) {
          area.innerHTML = `<div style="padding:20px; color:var(--text-muted); font-size:0.85rem; text-align:center; border:1px dashed rgba(255,255,255,0.1); border-radius:10px;">${icons.warning()} 이전 분석이 중단되었습니다. 히트맵 셀을 다시 클릭하면 분석이 시작됩니다.</div>`;
        }
      }, 300);
    } else if (s.deepHtml) {
      setTimeout(() => {
        const area = document.getElementById('deep-analysis-area');
        if (area) {
          area.innerHTML = s.deepHtml;
          attachSuggestionEvents(area, api);
          if (s.deepParams) window.__lastDeepGapParams = { ...s.deepParams, api };
        }
      }, 300);
    }
  };

  // --- [Analysis Execution Functions] ---
  const runYadamAnalysis = async () => {
    updateStoredState({
      yadamStatus: 'LOADING',
      yadamData: null,
      deepStatus: 'IDLE',
      deepHtml: null,
      deepParams: null
    });
    const deepArea = document.getElementById('deep-analysis-area');
    if (deepArea) deepArea.innerHTML = '';

    try {
      await renderMaterialCards(api, yadamCont, currentGroupTag);
      updateStoredState({ yadamStatus: 'SUCCESS' });
      restoreDnaAnalysisState(api);
    } catch (err) {
      updateStoredState({ yadamStatus: 'IDLE' });
      yadamCont.innerHTML = `<div class="empty-state"><div class="icon">${icons.error()}</div><p>${err.message}</p></div>`;
    }
  };

  const runEconomyAnalysis = async () => {
    // 이미 결과가 있거나 로딩 중이면 중복 실행 방지 (필요 시)
    if (economyCont.querySelector('.v3-keyword-item')) return;

    await renderEconomyV3(api, economyCont);
  };


  // --- [Event Listeners] ---
  tabs.forEach(tab => tab.addEventListener('click', () => updateModeUI(tab.dataset.mode)));
  document.getElementById('yadam-analyze-btn')?.addEventListener('click', runYadamAnalysis);

  // Final boot — 동적 탭 생성 후 초기 렌더
  try {
    const catData = await api.getChannelCategories();
    const validCats = (catData.categories || []).filter(c => c.material_group_name);
    const settingsCats = await api.getSettingsCategories();
    const tabContainer = document.getElementById('gap-tabs');

    validCats.forEach((cat) => {
      const tab = document.createElement('div');
      tab.className = 'material-genre-tab';
      tab.dataset.groupTag = cat.name;
      tab.dataset.mgn = cat.material_group_name;
      tab.dataset.subTypeMode = cat.sub_type_mode || 'none';
      const count = (settingsCats[cat.material_group_name] || []).length;
      tab.innerHTML = `${cat.name} <span class="tab-count">${count}개 소재</span>`;
      tabContainer.appendChild(tab);
    });

    tabContainer.addEventListener('click', (e) => {
      const tab = e.target.closest('.material-genre-tab');
      if (!tab) return;
      updateModeUI(tab.dataset.groupTag);
    });

    // 저장된 groupTag가 유효한지 확인, 아니면 첫 번째 카테고리 사용
    if (!validCats.find(c => c.name === currentGroupTag)) {
      currentGroupTag = validCats[0]?.name || '야담';
    }
  } catch (e) {
    console.error('[동적 탭 생성 오류]', e);
  }

  updateModeUI(currentGroupTag);
  restoreOrResume();

  // 탭 복귀 시 떡상 화면 초기화
  registerPageShowCallback('/gaps', () => {
    if (window.__spikeCloseModal) {
      window.__spikeCloseModal();
    }
  });
}

async function renderMaterialCards(api, targetEl, groupTag = '야담') {
  const LEVEL_TEXT = {
    saturated: '포화',
    moderate: '보통',
    opportunity: '기회'
  };

  const ACTION_TEXT = {
    saturated: '인기 소재 — 틈새 주제 찾기',
    moderate: '보통 경쟁 — 떡상 DNA 분석하기',
    opportunity: '경쟁 적음 — 떡상 DNA 분석하기'
  };

  // 로딩
  targetEl.innerHTML = `
    <div class="material-container">
      <div class="material-loading">
        <div class="material-spinner"></div>
        <span>소재별 포화도 분석 중...</span>
      </div>
    </div>`;

  try {
    const data = await api.getMaterialSaturation(groupTag);
    if (!data || !data.materials || data.materials.length === 0) {
      targetEl.innerHTML = `
        <div class="material-container">
          <div class="material-empty">분석할 데이터가 없습니다.</div>
        </div>`;
      return;
    }

    // 통계
    const oppCount = data.materials.filter(m => m.saturationLevel === 'opportunity').length;
    const satCount = data.materials.filter(m => m.saturationLevel === 'saturated').length;

    // 숫자 포맷
    const fmt = (n) => {
      if (n >= 10000000) return (n / 10000000).toFixed(0) + '천만';
      if (n >= 10000) return (n / 10000).toFixed(0) + '만';
      return n.toLocaleString();
    };

    // DNA 이력 건수 미리 조회
    let dnaHistoryCount = 0;
    try {
      const historyData = await api.getDnaHistory(groupTag);
      if (historyData && historyData.history) {
        dnaHistoryCount = historyData.history.length;
      }
    } catch (e) {
      console.log('DNA history count fetch skipped:', e.message);
    }

    // 카드 HTML
    const cardsHtml = data.materials.map(item => {
      const levelText = LEVEL_TEXT[item.saturationLevel] || '보통';
      const icon = MATERIAL_ICONS[item.material] || _folderIcon;
      const spikePercent = item.spikeRatio
        ? (item.spikeRatio * 100).toFixed(0)
        : (item.spikeCount && item.videoCount
            ? (item.spikeCount / item.videoCount * 100).toFixed(0)
            : '0');

      return `
        <div class="material-card"
             data-category-id="${item.categoryId}"
             data-material="${item.material}">
          <div class="material-card-top">
            <div class="material-card-title-area">
              <div class="material-card-icon">${icon}</div>
              <div class="material-card-name">${item.material}</div>
            </div>
            <div class="material-sat-badge ${item.saturationLevel}">
              ${levelText} ${item.saturationScore}%
            </div>
          </div>
          <div class="material-sat-bar-wrap">
            <div class="material-sat-bar-bg">
              <div class="material-sat-bar-fill ${item.saturationLevel}"
                   style="width:${item.saturationScore}%"></div>
            </div>
          </div>
          <div class="material-card-stats">
            <div class="material-stat-box">
              <div class="val">${item.videoCount.toLocaleString()}</div>
              <div class="lbl">영상 수</div>
            </div>
            <div class="material-stat-box">
              <div class="val">${fmt(item.avgViews)}</div>
              <div class="lbl">평균 조회수</div>
            </div>
            <div class="material-stat-box">
              <div class="val">${spikePercent}%</div>
              <div class="lbl">떡상 비율</div>
            </div>
            <div class="material-stat-box">
              <div class="val">${fmt(item.maxViews)}</div>
              <div class="lbl">최고 조회수</div>
            </div>
          </div>
          <div class="material-card-cta">
            <span>${ACTION_TEXT[item.saturationLevel]}</span>
            <span class="arrow">→</span>
          </div>
        </div>`;
    }).join('');

    // 전체 조립
    targetEl.innerHTML = `
      <div class="material-container">
        <div class="material-summary-bar">
          <div class="material-summary-left">
            <div class="material-summary-stat">
              <div class="num accent">${data.totalVideos.toLocaleString()}</div>
              <div class="label">분석 영상</div>
            </div>
            <div class="material-summary-divider"></div>
            <div class="material-summary-stat">
              <div class="num">${data.materials.length}</div>
              <div class="label">소재</div>
            </div>
            <div class="material-summary-divider"></div>
            <div class="material-summary-stat">
              <div class="num">${oppCount}</div>
              <div class="label">기회 소재</div>
            </div>
            <div class="material-summary-divider"></div>
            <div class="material-summary-stat">
              <div class="num">${satCount}</div>
              <div class="label">포화 소재</div>
            </div>
          </div>
          <div class="material-action-buttons-unified">
            <div class="btn-group-data">
              <button id="unclassified-btn" class="unified-btn ub-red" style="display:none;">
                미분류 <span id="unclassified-count">0</span>
              </button>
              <button id="material-manage-btn" class="unified-btn ub-gray">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                소재 이름 관리
              </button>
              <button id="refresh-top50-btn" class="unified-btn ub-blue">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                TOP50 갱신
              </button>
            </div>
            <div class="btn-group-separator"></div>
            <div class="btn-group-ai">
              <button id="openDnaHistoryModal" class="unified-btn ub-purple">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                DNA 분석 이력 <span class="dna-history-count-badge" id="dnaHistoryCountBadge">${dnaHistoryCount}건</span>
              </button>
              <button id="topic-recommend-btn" class="unified-btn ub-indigo">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                주제 추천 받기
              </button>
              <button id="topic-history-btn" class="unified-btn ub-emerald">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                추천 이력
              </button>
            </div>
          </div>
        </div>

        <div class="material-grid">${cardsHtml}</div>
      </div>`;

    // DNA 이력 모달 열기 버튼 이벤트
    const openBtn = targetEl.querySelector('#openDnaHistoryModal');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        openDnaHistoryModal(api, groupTag);
      });
    }

    // 미분류 버튼 건수 로드
    try {
      const ucRes = await api.getUnclassifiedVideos(groupTag);
      const ucBtn = targetEl.querySelector('#unclassified-btn');
      if (ucBtn) {
        targetEl.querySelector('#unclassified-count').textContent = ucRes.total;
        ucBtn.style.display = 'inline-flex';
        ucBtn.addEventListener('click', () => showUnclassifiedModal(api, groupTag));
      }
    } catch (e) { console.error('[미분류 버튼]', e); }

    // 소재 관리 버튼
    const manageBtn = targetEl.querySelector('#material-manage-btn');
    if (manageBtn) {
      manageBtn.onclick = () => showMaterialManageModal(api, groupTag);
    }

    // TOP50 갱신 버튼
    const refreshBtn = targetEl.querySelector('#refresh-top50-btn');
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        const storageKey = `rf-last-${groupTag}`;
        const lastRefresh = localStorage.getItem(storageKey);
        if (lastRefresh) {
          const lastDate = new Date(parseInt(lastRefresh));
          const now = new Date();
          if (lastDate.toDateString() === now.toDateString()) {
            const timeStr = lastDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
            if (!confirm(`오늘 이미 갱신했습니다 (마지막: ${timeStr}).\n다시 갱신하시겠습니까?`)) return;
          }
        }

        refreshBtn.disabled = true;
        const origHtml = refreshBtn.innerHTML;
        refreshBtn.innerHTML = '갱신 중...';

        try {
          const result = await api.refreshTop50(groupTag);
          localStorage.setItem(storageKey, Date.now().toString());

          const rc = result.rankingChanges;
          const currentTop5 = rc.currentTop5 || {};
          const changes = rc.changes || [];
          const categories = Object.keys(currentTop5).sort();

          // 소재별 현재 TOP5 영상의 변동 매핑 (newRank 기준)
          const changeMap = {};
          for (const c of changes) {
            if (c.newRank && c.category) {
              if (!changeMap[c.category]) changeMap[c.category] = {};
              changeMap[c.category][c.newRank] = c;
            }
          }

          const fmtViews = n => {
            if (!n) return '0';
            return n >= 10000 ? Math.round(n / 10000).toLocaleString() + '만' : n.toLocaleString();
          };
          const calcDaily = (views, publishedAt) => {
            if (!publishedAt) return views;
            const days = Math.max(3, Math.round((Date.now() - new Date(publishedAt).getTime()) / 86400000));
            return Math.round(views / days);
          };

          let sectionsHtml = '';
          for (const cat of categories) {
            const items = currentTop5[cat] || [];
            const catChanges = changeMap[cat] || {};
            const hasChange = changes.some(c => c.category === cat);

            let itemsHtml = '';
            for (const item of items) {
              const change = catChanges[item.rank];
              let badgeHtml = '<span class="rf-badge rf-badge-same">—</span>';
              let viewDiffHtml = '';

              if (change) {
                if (change.type === 'new') {
                  badgeHtml = '<span class="rf-badge rf-badge-new">NEW</span>';
                } else if (change.type === 'up') {
                  const diff = change.oldRank - change.newRank;
                  badgeHtml = `<span class="rf-badge rf-badge-up">▲${diff}</span>`;
                  if (change.views > change.oldViews) {
                    viewDiffHtml = `<span class="rf-view-diff rf-view-up">+${fmtViews(change.views - change.oldViews)}</span>`;
                  }
                } else if (change.type === 'down') {
                  const diff = change.newRank - change.oldRank;
                  badgeHtml = `<span class="rf-badge rf-badge-down">▼${diff}</span>`;
                }
              }

              const ytLink = item.videoIdYoutube ? `https://youtube.com/watch?v=${item.videoIdYoutube}` : '#';

              itemsHtml += `
                <div class="rf-item">
                  <div class="rf-item-rank">
                    <span class="rf-rank-num">${item.rank}위</span>
                    ${badgeHtml}
                  </div>
                  <div class="rf-item-thumb">
                    <img src="${item.thumbnail || ''}" alt="" loading="lazy">
                  </div>
                  <div class="rf-item-info">
                    <a href="${ytLink}" target="_blank" class="rf-item-title">${item.title || '제목 없음'}</a>
                    <div class="rf-item-meta">${item.channel || ''} · 구독자 ${fmtViews(item.subscriberCount || 0)}</div>
                  </div>
                  <div class="rf-item-data">
                    <div class="rf-item-spike">일평균 ${fmtViews(calcDaily(item.views || 0, item.publishedAt))}회 ${getSpikeGrade(item.spikeRatio || 0)}</div>
                    <div class="rf-item-views">구독자 대비 ${item.subscriberCount > 0 ? (calcDaily(item.views || 0, item.publishedAt) / item.subscriberCount).toFixed(1) : '0'}배 ${viewDiffHtml}</div>
                  </div>
                </div>
              `;
            }

            sectionsHtml += `
              <div class="rf-section ${hasChange ? 'rf-section-open' : ''}">
                <div class="rf-section-header">
                  <span class="rf-section-name">${cat}</span>
                  <span class="rf-section-count">${items.length}개</span>
                  ${hasChange ? '<span class="rf-section-changed">변동있음</span>' : ''}
                  <span class="rf-section-arrow">${hasChange ? '▼' : '▶'}</span>
                </div>
                <div class="rf-section-body" style="display:${hasChange ? 'block' : 'none'}">
                  ${itemsHtml}
                </div>
              </div>
            `;
          }

          const noChangeHtml = changes.length === 0 ? `
            <div class="rf-no-change">
              <div class="rf-no-icon">✓</div>
              <div class="rf-no-text">순위 변동이 없습니다</div>
              <div class="rf-no-sub">모든 소재의 TOP5 순위가 동일합니다</div>
            </div>
          ` : '';

          const summaryParts = [];
          if (rc.newEntries > 0) summaryParts.push(`<span class="rf-sum-new">신규 ${rc.newEntries}</span>`);
          if (rc.rankUps > 0) summaryParts.push(`<span class="rf-sum-up">상승 ${rc.rankUps}</span>`);
          if (rc.rankDowns > 0) summaryParts.push(`<span class="rf-sum-down">하락 ${rc.rankDowns}</span>`);
          const summaryHtml = summaryParts.length > 0
            ? summaryParts.join(' · ')
            : '<span class="rf-sum-none">변동 없음</span>';

          const overlay = document.createElement('div');
          overlay.className = 'rf-overlay';
          overlay.innerHTML = `
            <div class="rf-modal">
              <div class="rf-header">
                <div class="rf-title">TOP50 갱신 완료</div>
                <div class="rf-subtitle">${new Date().toLocaleString('ko-KR')} · ${result.updated || 0}개 영상 조회수 갱신</div>
                <div class="rf-summary">${summaryHtml}</div>
              </div>
              <div class="rf-body">
                ${noChangeHtml}
                ${sectionsHtml}
              </div>
              <div class="rf-footer">
                <button class="rf-confirm" id="rf-confirm-btn">확인</button>
              </div>
            </div>
          `;

          overlay.querySelectorAll('.rf-section-header').forEach(header => {
            header.addEventListener('click', () => {
              const section = header.closest('.rf-section');
              const body = section.querySelector('.rf-section-body');
              const arrow = header.querySelector('.rf-section-arrow');
              const isOpen = body.style.display !== 'none';
              body.style.display = isOpen ? 'none' : 'block';
              arrow.textContent = isOpen ? '▶' : '▼';
              section.classList.toggle('rf-section-open', !isOpen);
            });
          });

          overlay.querySelector('#rf-confirm-btn').addEventListener('click', () => {
            overlay.remove();
            const existingContainer = document.querySelector('.chart-container.spike-modal-container');
            if (existingContainer) {
              existingContainer.remove();
              const materialGrid = targetEl.querySelector('.material-grid');
              if (materialGrid) materialGrid.style.display = '';
            }
            renderMaterialCards(api, targetEl, groupTag);
          });

          document.body.appendChild(overlay);

        } catch (err) {
          console.error('[TOP50 갱신] 오류:', err);
          alert('갱신 실패: ' + err.message);
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.innerHTML = origHtml;
        }
      };
    }

    // 주제 추천 버튼 (5단계에서 구현 완료)
    document.getElementById('topic-recommend-btn')?.addEventListener('click', () => {
      const currentTag = window.__appState?.gapsGroupTag || '야담';
      openTopicRecommendModal(api, currentTag);
    });

    // 추천 이력 버튼
    document.getElementById('topic-history-btn')?.addEventListener('click', () => {
      openTopicHistoryModal(api, groupTag);
    });

    // 카드 클릭 → showSpikeVideoModal (기존 로직 유지)
    targetEl.querySelectorAll('.material-card').forEach(card => {
      card.addEventListener('click', () => {
        const categoryId = card.dataset.categoryId;
        const material = card.dataset.material;
        const meta = { eventId: parseInt(categoryId) };
        // 카드와 동일한 데이터를 직접 전달 (포화도순 보장)
        const materialsForTabs = data.materials.map(m => ({
          name: m.material,
          eventId: m.categoryId
        }));
        showSpikeVideoModal(material, material, groupTag, meta, targetEl, api, materialsForTabs);
      });
    });

  } catch (err) {
    console.error('renderMaterialCards error:', err);
    targetEl.innerHTML = `
      <div class="material-container">
        <div class="material-empty">
          포화도 분석 중 오류가 발생했습니다: ${err.message}
        </div>
      </div>`;
  }
}

async function openDnaHistoryModal(api, groupTag) {
  // 기존 모달 제거
  const existing = document.querySelector('.dna-history-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'dna-history-modal-overlay';
  overlay.innerHTML = `
    <div class="dhm">
      <div class="dhm-header">
        <h2><span class="dhm-header-icon">${icons.dna()}</span> DNA 분석 이력</h2>
        <button class="dhm-close">${icons.close()}</button>
      </div>
      <div class="dhm-content">
        <aside class="dhm-sidebar">
          <div class="dhm-sidebar-title">소재 필터</div>
          <div class="dhm-filter-list" id="dhmFilterList">
            <div class="dhm-filter-item active" data-category="__all__">
              <span class="dhm-filter-name">전체</span>
              <span class="dhm-filter-count" id="dhmCountAll">-</span>
            </div>
          </div>
        </aside>
        <main class="dhm-main">
          <div class="dhm-main-header" id="dhmMainHeader">
            <span class="dhm-result-count"></span>
          </div>
          <div class="dhm-card-area" id="dhmCardArea">
            <div class="dhm-loading">
              <div class="material-spinner"></div>
              <span>이력을 불러오는 중...</span>
            </div>
          </div>
        </main>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add('visible'));
  });

  // 닫기
  const handleEsc = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  const closeModal = () => {
    document.removeEventListener('keydown', handleEsc);
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 250);
  };
  document.addEventListener('keydown', handleEsc);
  overlay.querySelector('.dhm-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // 데이터 로드
  let allHistory = [];
  try {
    const data = await api.getDnaHistory(groupTag);
    allHistory = data && data.history ? data.history : [];
  } catch (err) {
    console.error('DNA history load error:', err);
    document.getElementById('dhmCardArea').innerHTML = `
      <div class="dhm-empty">
        <span class="dhm-empty-icon">${icons.warning()}</span>
        <div class="dhm-empty-title">이력을 불러올 수 없습니다</div>
        <div class="dhm-empty-desc">${err.message}</div>
      </div>`;
    return;
  }

  if (allHistory.length === 0) {
    document.getElementById('dhmCardArea').innerHTML = `
      <div class="dhm-empty">
        <span class="dhm-empty-icon">${icons.dna()}</span>
        <div class="dhm-empty-title">분석 이력이 없습니다</div>
        <div class="dhm-empty-desc">소재 카드를 클릭하고 떡상 영상을 선택하여<br>DNA 분석을 진행해 보세요.</div>
      </div>`;
    document.getElementById('dhmCountAll').textContent = '0';
    return;
  }

  // 소재별 그룹핑
  const categoryMap = {};
  allHistory.forEach(item => {
    const cat = item.category || '분류 없음';
    if (!categoryMap[cat]) categoryMap[cat] = [];
    categoryMap[cat].push(item);
  });

  // 사이드바 필터 목록 생성
  const filterList = document.getElementById('dhmFilterList');
  document.getElementById('dhmCountAll').textContent = allHistory.length;

  const MATERIAL_ICONS = {
    '복수극': _folderIcon, '로맨스': _folderIcon, '괴담/미스터리': _folderIcon,
    '범죄/옥사': _folderIcon, '풍속/일상': _folderIcon, '사기/기만': _folderIcon, '전쟁/영웅': _folderIcon
  };

  Object.keys(categoryMap).forEach(cat => {
    const icon = MATERIAL_ICONS[cat] || _folderIcon;
    const filterItem = document.createElement('div');
    filterItem.className = 'dhm-filter-item';
    filterItem.dataset.category = cat;
    filterItem.innerHTML = `
      <span class="dhm-filter-icon">${icon}</span>
      <span class="dhm-filter-name">${cat}</span>
      <span class="dhm-filter-count">${categoryMap[cat].length}</span>`;
    filterList.appendChild(filterItem);
  });

  // 숫자 포맷
  const fmt = (n) => {
    if (!n) return '0';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '만';
    return n.toLocaleString();
  };

  const fmtDate = (str) => {
    if (!str) return '';
    const d = new Date(str);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  };

  // 카드 렌더 함수
  const renderCards = (items) => {
    const cardArea = document.getElementById('dhmCardArea');
    const mainHeader = document.getElementById('dhmMainHeader');

    if (items.length === 0) {
      mainHeader.innerHTML = '';
      cardArea.innerHTML = `
        <div class="dhm-empty">
          <span class="dhm-empty-icon">📭</span>
          <div class="dhm-empty-title">해당 소재의 분석 이력이 없습니다</div>
        </div>`;
      return;
    }

    mainHeader.innerHTML = `<span class="dhm-result-count">총 <strong>${items.length}</strong>건의 분석 이력</span>`;

    cardArea.innerHTML = items.map((item) => {
      const ds = item.dna_summary || {};
      const scores = ds.scores || {};
      const vds = item.video_details || [];
      const v = vds[0] || {};
      const icon = MATERIAL_ICONS[item.category] || _folderIcon;

      const thumbUrl = v.thumbnail_url
        || (v.youtube_id ? `https://i.ytimg.com/vi/${v.youtube_id}/mqdefault.jpg` : '');

      // 종합 점수 (overall 있으면 직접 사용, 없으면 5개 평균)
      const totalAvg = scores.overall
        ? Math.round(scores.overall)
        : (() => {
            const vals = ['hooking', 'structure', 'emotion', 'immersion', 'title']
              .map(k => scores[k] || 0);
            return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
          })();

      // 구독자 대비
      const spikeRatio = v.spike_ratio
        || (v.subscriber_count ? (v.view_count / v.subscriber_count) : 0);
      const gradeText = getSpikeGrade(parseFloat(spikeRatio));
      const gradeClass = gradeText === '초대박' ? 'grade-super' : gradeText === '대박' ? 'grade-great' : gradeText ? 'grade-good' : '';
      const dnaCardDaysSince = v.published_at ? Math.max(1, Math.round((Date.now() - new Date(v.published_at).getTime()) / 86400000)) : 1;
      const dnaCardDailyAvg = Math.round((v.view_count || 0) / Math.max(dnaCardDaysSince, 3));
      const dnaCardDailyRatio = v.subscriber_count > 0 ? (dnaCardDailyAvg / v.subscriber_count).toFixed(1) : null;

      const scoreBarsHtml = '';

      return `
        <div class="dhm-card" data-dna-id="${item.id}">
          <div class="dhm-card-top">
            <div class="dhm-card-category">
              <span class="dhm-card-category-icon">${icon}</span> ${item.category || '분류 없음'}
            </div>
            <div class="dhm-total-score-big">
              <div class="dhm-total-number ${getTotalGradeClass(totalAvg)}">${totalAvg}</div>
              <div class="dhm-total-text">점</div>
            </div>
          </div>

          <div class="dhm-card-body">
            <div class="dhm-thumb-wrap">
              ${thumbUrl ? `<img src="${thumbUrl}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
              ${v.duration_seconds ? `<div class="dhm-thumb-duration">${formatDuration(v.duration_seconds)}</div>` : ''}
            </div>

            <div class="dhm-video-info">
              <div class="dhm-video-title">${v.title || '제목 없음'}</div>
              <div class="dhm-video-channel">
                ${v.channel_name || ''}
                ${v.subscriber_count ? `<span>· 구독자 ${fmt(v.subscriber_count)}</span>` : ''}
              </div>
              <div class="dhm-video-metrics">
                <span class="dhm-metric spike">
                  ${icons.trendUp(14)} 일평균 ${dnaCardDailyAvg.toLocaleString()}회${dnaCardDailyRatio ? `｜(구독자 대비 ${dnaCardDailyRatio}배)` : ''}${gradeText ? `｜<span class="grade-tag ${gradeClass}">${gradeText}</span>` : ''}
                </span>
                <span class="dhm-metric views">${icons.chartBar(14)} ${fmt(v.view_count)}</span>
                <span class="dhm-metric comments">${icons.comment(14)} ${fmt(v.comment_count)}</span>
                <span class="dhm-metric likes">${icons.thumbsUp(14)} ${fmt(v.like_count)}</span>
              </div>
            </div>

          </div>

          <div class="dhm-card-footer">
            <span class="dhm-card-footer-date">
              ${icons.clock(14)} 게시일 ${fmtDate(v.published_at)} · 분석일 ${fmtDate(item.created_at)}
            </span>
            <div class="dhm-view-btn">
              DNA 전체 분석 결과 보기 <span class="arrow">→</span>
            </div>
          </div>
        </div>`;
    }).join('');

    // 카드 클릭 → showDnaResultModal 직접 호출
    cardArea.querySelectorAll('.dhm-card').forEach(card => {
      card.addEventListener('click', () => {
        const dnaId = parseInt(card.dataset.dnaId, 10);
        const historyItem = items.find(h => h.id === dnaId);

        if (!historyItem || !historyItem.dna_full) {
          openDnaDetailModal(api, dnaId);
          return;
        }

        const vid = historyItem.video_details[0] || {};
        const dnaResponse = {
          dna: historyItem.dna_full,
          sourceVideos: [{
            video_id: vid.youtube_id,
            title: vid.title,
            channelName: vid.channel_name,
            channelYoutubeId: vid.channel_youtube_id || vid.channelYoutubeId || '',
            channelHandle: vid.channel_handle || vid.channelHandle || '',
            viewCount: vid.view_count,
            subscriberCount: vid.subscriber_count,
            durationSeconds: vid.duration_seconds,
            likeCount: vid.like_count,
            publishedAt: vid.published_at,
            commentCount: vid.comment_count,
            spikeRatio: vid.spike_ratio || (vid.subscriber_count ? (vid.view_count / vid.subscriber_count).toFixed(2) : 0)
          }],
          skippedVideos: [],
          isNewExtraction: false
        };

        showDnaResultModal(
          dnaResponse,
          historyItem.category,
          '',
          false,
          {},
          null,
          api,
          []
        );
      });
    });
  };

  // 초기 렌더 (전체)
  renderCards(allHistory);

  // 필터 클릭 이벤트
  filterList.addEventListener('click', (e) => {
    const filterItem = e.target.closest('.dhm-filter-item');
    if (!filterItem) return;

    filterList.querySelectorAll('.dhm-filter-item').forEach(f => f.classList.remove('active'));
    filterItem.classList.add('active');

    const cat = filterItem.dataset.category;
    if (cat === '__all__') {
      renderCards(allHistory);
    } else {
      renderCards(allHistory.filter(h => h.category === cat));
    }
  });
}

async function openDnaDetailModal(api, dnaId) {
  // 기존 상세 모달 있으면 제거
  const existing = document.querySelector('.dna-detail-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'dna-detail-modal-overlay';
  overlay.innerHTML = `
    <div class="dna-detail-modal">
      <div class="dna-detail-modal-header">
        <h2><span class="header-icon">${icons.dna()}</span> DNA 분석 결과</h2>
        <button class="dna-detail-modal-close">${icons.close()}</button>
      </div>
      <div class="dna-detail-modal-body">
        <div class="dna-history-modal-loading">
          <div class="material-spinner"></div>
          <span>DNA 데이터를 불러오는 중...</span>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
    });
  });

  // 닫기 (상세 모달만 닫고, 이력 모달은 유지)
  const handleEsc = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  const closeModal = () => {
    document.removeEventListener('keydown', handleEsc);
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 250);
  };
  document.addEventListener('keydown', handleEsc);
  overlay.querySelector('.dna-detail-modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  const body = overlay.querySelector('.dna-detail-modal-body');

  try {
    const data = await api.getDnaDetail(dnaId);
    if (!data || !data.dna) {
      body.innerHTML = `
        <div class="dna-history-modal-empty">
          <span class="empty-icon">${icons.warning()}</span>
          <div class="empty-title">DNA 데이터를 찾을 수 없습니다</div>
        </div>`;
      return;
    }

    // renderDnaContent로 DNA 시각화 렌더링
    const dnaHtml = renderDnaContent(data.dna);
    body.innerHTML = `<div class="dna-viz-container">${dnaHtml}</div>`;

  } catch (err) {
    console.error('openDnaDetailModal error:', err);
    body.innerHTML = `
      <div class="dna-history-modal-empty">
        <span class="empty-icon">${icons.warning()}</span>
        <div class="empty-title">DNA 결과를 불러올 수 없습니다</div>
        <div class="empty-desc">${err.message}</div>
      </div>`;
  }
}

async function performDeepAnalysis(catX, catY, groupX, groupY, existingCount, api, groupTag = '야담', meta = null, targetArea = null) {
  const area = targetArea || document.getElementById('deep-analysis-area');
  if (!area) {
    console.error('[performDeepAnalysis] target area fail - targetArea:', targetArea, 'GlobalID:', !!document.getElementById('deep-analysis-area'));
    return;
  }

  const analysisKey = `${catX}-${catY}-${groupTag}`;
  const now = Date.now();
  const stored = getStoredState();

  // [안전장치] 빠른 재호출 방지: 마지막 호출 후 10초 이내 동일 분석 재실행 차단
  const lastCallKey = `__deepLastCall_${analysisKey}`;
  const lastCallTime = window[lastCallKey] || 0;
  if (now - lastCallTime < 10000 && lastCallTime > 0) {
    const remaining = Math.ceil((10000 - (now - lastCallTime)) / 1000);
    showToast(`쿼터 보호: ${remaining}초 후 재시도 가능합니다.`, 'warning');
    console.warn(`[performDeepAnalysis] Rapid re-call blocked (${remaining}s cooldown remaining)`);
    return;
  }
  window[lastCallKey] = now;

  // 1. Check for ongoing global promise OR stuck state (5min+)
  if (stored.deepStatus === 'LOADING' && stored.deepLastUpdate && (now - stored.deepLastUpdate > 300000)) {
    console.warn('[performDeepAnalysis] Stuck detected (5min+). Forcing reset.');
    window.__activeDeepAnalysis = null;
    updateStoredState({ deepStatus: 'IDLE', deepLastUpdate: now });
  }

  // 2. Check for ongoing global promise
  if (window.__activeDeepAnalysis === analysisKey) {
    console.log('[performDeepAnalysis] Analysis already in progress:', analysisKey);
    showToast('현재 해당 주제를 분석 중입니다.', 'warning');
    // Force show loading UI if stuck
    area.innerHTML = `
       <div class="chart-container mb-24 flex-center" style="padding:40px; border:2px solid var(--accent); flex-direction:column; gap:16px;">
         <div class="spinner"></div>
         <div style="color:var(--accent); font-weight:700;">분석이 진행 중입니다... (잠시만 기다려주세요)</div>
         <button class="btn btn-secondary btn-xs" onclick="if(window.__forceResetAnalysis) window.__forceResetAnalysis()">${icons.warning()} 분석 강제 초기화</button>
       </div>`;
    return;
  }

  window.__activeDeepAnalysis = analysisKey;

  // Store for redo and persistence
  const STORAGE_KEY = 'gaps_v2_persistence';
  const currentState = updateStoredState({
    deepStatus: 'LOADING',
    deepParams: { catX, catY, groupX, groupY, existingCount, groupTag, meta },
    deepLastUpdate: now
  });
  delete currentState.deepHtml;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));

  window.__lastDeepGapParams = { catX, catY, groupX, groupY, existingCount, api, meta, groupTag, targetArea: area };
  window.__gapApi = api;

  if (!window.redoDeepAnalysis) {
    window.redoDeepAnalysis = function () {
      const p = window.__lastDeepGapParams;
      if (p) performDeepAnalysis(p.catX, p.catY, p.groupX, p.groupY, p.existingCount, p.api, p.groupTag, p.meta, p.targetArea);
    };
  }

  area.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const opportunityLabel = existingCount === 0
    ? '<span class="tag safe">🟢 완전 미개척</span>'
    : existingCount <= 3
      ? '<span class="tag" style="background:rgba(59,130,246,0.2);color:#60a5fa;">🔵 저경쟁</span>'
      : '<span class="tag caution">🟡 틈새</span>';

  area.innerHTML = `
    <div class="chart-container mb-24 animation-fade-in" style="border:2px solid var(--accent); background:var(--accent-glow);">
      <div class="flex-between mb-16">
        <div>
          <h4 style="margin:0 0 6px 0; color:var(--accent);">🔎 [${catY} × ${catX}] 심층 기획 분석</h4>
          <div class="flex gap-8" style="align-items:center;">
            ${opportunityLabel}
            <span style="font-size:0.78rem;color:var(--text-muted);">기존 영상 ${existingCount}개 · AI 분석 중...</span>
          </div>
        </div>
        <div class="spinner-sm"></div>
      </div>
      <div style="background:rgba(var(--accent-rgb),0.05);border-radius:8px;padding:14px;">
        <div class="skeleton" style="height:16px;width:80%;margin-bottom:8px;border-radius:4px;"></div>
        <div class="skeleton" style="height:16px;width:60%;margin-bottom:8px;border-radius:4px;"></div>
        <div class="skeleton" style="height:16px;width:70%;border-radius:4px;"></div>
      </div>
      <div style="text-align:center; margin-top:12px;">
        <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:8px;">
          ✨ Gemini AI가 해당 틈새 시장을 분석하고 있습니다... (약 30~60초 소요)
        </p>
        <button class="btn btn-secondary btn-xs" style="opacity:0.6;" onclick="window.__forceResetAnalysis && window.__forceResetAnalysis()">${icons.warning()} 너무 오래 걸리면 클릭 (초기화)</button>
      </div>
    </div>
  `;

  // State: START LOADING
  // const STORAGE_KEY = 'gaps_v2_persistence'; // Already defined above
  // const currentState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); // Handled by updateStoredState
  // delete currentState.deepHtml; // Handled by updateStoredState
  // currentState.deepStatus = 'LOADING'; // Handled by updateStoredState
  // currentState.deepParams = { catX, catY, groupX, groupY, existingCount, isYadam, meta }; // Handled by updateStoredState
  // localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState)); // Handled by updateStoredState

  try {
    // === 신규 흐름: 떡상 영상 선별 → DNA 추출 → 주제 추천 ===
    await showSpikeVideoModal(catX, catY, groupTag, meta, area, api);
    return;
    // === 신규 흐름 끝 ===

    /* 기존 로직 시작 - 신규 흐름으로 교체됨
    // ── [주석 처리] 로컬 DNA 단독 경로 (이전 버전) ───────────────────
    // const localResult = await api.extractLocalDna({ category: catX });
    // const dna = localResult.dna;
    // if (curArea) renderLocalDnaInGaps(curArea, dna, catX, catY, existingCount, opportunityLabel, api);
    // updateStoredState({ deepStatus: 'SUCCESS', deepHtml: curArea?.innerHTML || '', deepParams: { ... } });
    // ─────────────────────────────────────────────────────────────────

    // ── 로컬 DNA 보조 통계 먼저 수집 (실패해도 계속 진행) ────────────
    let localDna = null;
    try {
      const localResult = await api.extractLocalDna({ category: catX });
      localDna = localResult.dna;
    } catch (e) {
      console.warn('[performDeepAnalysis] Local DNA 조회 실패 (무시):', e.message);
    }

    // ── 기존 Gemini 기반 심층 기획 분석 (복원) ───────────────────────
    const timeoutFunc = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI 분석 시간 초과 (95초).')), 95000)
    );

    const result = await Promise.race([
      api.deepGapAnalysis({ catX, catY, groupX, groupY, isYadam, meta }),
      timeoutFunc
    ]);
    const suggestions = result.suggestions || [];
    const returnedCount = result.existingCount ?? existingCount;

    if (suggestions.length === 0) {
      updateStoredState({ deepStatus: 'IDLE', deepLastUpdate: Date.now() });
      const curArea = area;
      if (curArea) {
        curArea.innerHTML = `
          <div class="chart-container mb-24 animation-fade-in" style="border:2px solid var(--warning);">
            <h4 style="color:var(--warning);">⚠️ AI 분석 결과 없음</h4>
            <p style="font-size:0.85rem;color:var(--text-secondary);">
              AI가 주제를 생성하지 못했습니다. (데이터 부족 또는 일시적 서비스 지연)<br>
              너무 자주 요청했거나 Gemini API 설정에 문제가 있을 수 있습니다.
            </p>
            <button class="btn btn-secondary btn-sm mt-16" onclick="this.closest('.chart-container').remove()">닫기</button>
          </div>
        `;
      }
      return;
    }

    // 로컬 DNA 보조 정보 섹션 (있을 때만 표시)
    const localDnaSection = localDna ? buildLocalDnaCompact(localDna, catX) : '';

    const html = `
      <div class="chart-container mb-24 animation-fade-in" style="border: 2px solid var(--accent); background: var(--card-bg);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:12px;">
          <div style="flex:1;">
            <h4 style="margin:0 0 6px 0; color:var(--accent); font-size:0.9rem; line-height:1.4;">
              ${icons.fire(14)} [${catY} × ${catX}] 시장 분석 & 떡상 전략 리포트
            </h4>
            <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px;">
              ${opportunityLabel}
              <span class="tag safe">시장 데이터 분석 완료</span>
              <span style="font-size:0.85rem;color:var(--text-muted);">기존 영상 ${returnedCount}개 분석 · 전략 기획안 실시간 생성</span>
            </div>
          </div>
          <div class="flex gap-8">
            <button class="btn btn-secondary" style="padding:5px 10px; font-size:0.75rem; white-space:nowrap; border-radius:8px;" onclick="window.redoDeepAnalysis()">${icons.refresh()} 다시 추천</button>
            <button class="btn btn-secondary" style="padding:5px 10px; font-size:0.75rem; white-space:nowrap; border-radius:8px;" onclick="this.closest('.chart-container').remove()">${icons.close()} 닫기</button>
          </div>
        </div>

        ${localDnaSection}

        <div style="margin-bottom:12px;">
          <div style="font-size:1rem; font-weight:700; color:var(--text-secondary); white-space:nowrap; margin-bottom:6px;">
            💡 [Step 1] 틈새 시장 테마 추천 (TOP 10)
          </div>
          <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:12px; line-height:1.4;">
            * 이 카테고리 조합에서 아직 다뤄지지 않은 **새로운 주제(Theme) 방향**을 추천합니다.
          </p>
        </div>


        <div id="deep-suggestion-list" style="display:flex; flex-direction:column; gap:12px;">
          ${suggestions.map((s, idx) => `
            <div class="suggestion-item card clickable-suggestion"
              data-title="${s.title}" data-keywords="${(s.keywords || []).join(',')}"
              data-catx="${catX}" data-caty="${catY}" data-groupx="${groupX}" data-groupy="${groupY}"
              style="padding:24px; background:var(--bg-secondary); border-left: 5px solid ${(parseInt(s.gap_rate) || 0) > 80 ? 'var(--success)' : 'var(--accent)'}; transition: all 0.2s; cursor:pointer;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
                <div style="flex:1; padding-right:20px;">
                  <div style="font-size:1rem; color:var(--text-muted); font-weight:700; margin-bottom:6px;">TOP ${idx + 1}</div>
                  <div class="suggestion-title" style="font-size:1.5rem; font-weight:900; color:var(--text-primary); line-height:1.4;">
                    ${s.title || '제목 없음'}
                  </div>
                </div>
                <div style="text-align:right; min-width:100px;">
                  <div style="font-size:1rem; color:var(--text-muted); font-weight:700; margin-bottom:6px;">차별화 지수</div>
                  <div style="font-size:1.6rem; font-weight:900; color:${s.gap_rate > 80 ? 'var(--success)' : 'var(--accent)'};">
                    ${s.gap_rate || 0}%
                  </div>
                </div>
              </div>

              <div style="height:10px; background:rgba(255,255,255,0.05); border-radius:5px; margin-bottom:16px; overflow:hidden;">
                <div style="height:100%; width:${parseInt(s.gap_rate) || 0}%; background: ${(parseInt(s.gap_rate) || 0) > 80 ? 'var(--success)' : 'var(--accent)'}; transition: width 1s ease-out;"></div>
              </div>

              ${s.keywords ? `
              <div class="flex-between mb-16">
                <div class="tag-list" style="gap:8px; flex:1;">
                  ${s.keywords.map(kw => `<span class="tag" style="background:rgba(var(--accent-rgb), 0.1); border:1px solid var(--accent-light); color:var(--accent); font-weight:700; font-size:1rem; padding:6px 14px;">#${kw}</span>`).join('')}
                </div>
              </div>
              ` : ''}

              <div style="font-size:1.15rem; line-height:1.6; color:var(--text-secondary); border-top:1px solid rgba(255,255,255,0.05); padding-top:16px;">
                <span style="color:var(--accent); font-weight:800; margin-right:6px;">Why?</span> ${s.reason || '-'}
              </div>

              <div class="script-plan-loading mt-20" style="display:none; text-align:center;">
                <div class="spinner mb-12" style="margin:0 auto;"></div>
                <div style="font-size:1.1rem; color:var(--accent); font-weight:700;">후킹 제목 및 상세 대본 뼈대 생성 중...</div>
              </div>

              <div class="script-plan-result mt-20" style="display:none; border-top:2px dashed var(--accent); padding-top:20px;"></div>
            </div>
          `).join('')}
        </div>
      </div >
    `;

    const curArea = area;
    if (curArea) {
      curArea.innerHTML = html;
      attachSuggestionEvents(curArea, api);
    }

    // State: SUCCESS
    updateStoredState({
      deepStatus: 'SUCCESS',
      deepHtml: html,
      deepParams: { catX, catY, groupX, groupY, existingCount, isYadam, meta }
    });
    기존 로직 끝 - 신규 흐름으로 교체됨 */

  } catch (err) {
    console.error('[performDeepAnalysis] Error:', err);
    updateStoredState({ deepStatus: 'IDLE' });
    const curArea = area;
    if (curArea) {
      if (err.message.includes('AUTH_ERROR') || err.message.includes('인증')) {
        curArea.innerHTML = `
          <div class="chart-container mb-24 animation-fade-in" style="border:1px dashed #f59e0b; background:rgba(245, 158, 11, 0.05); text-align:center; padding:30px;">
            <div style="font-size:2.5rem; margin-bottom:12px;">🔑</div>
            <h4 style="color:#f59e0b; margin-bottom:8px;">AI 인증 오류 (AUTH_ERROR)</h4>
            <p style="font-size:0.9rem; line-height:1.5; color:var(--text-secondary);">
              API 키 인증에 실패했습니다.<br>
              <strong>해결 방법:</strong> 설정 페이지에서 API 키와 Project ID를 확인하고,<br>
              Google Cloud 콘솔에서 <strong>'Generative Language API'</strong> 사용 설정 여부를 확인하세요.
            </p>
            <div class="flex-center gap-12 mt-16">
              <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" class="btn btn-warning btn-sm">API 설정하러 가기</a>
              <button class="btn btn-secondary btn-sm" onclick="this.closest('.chart-container').remove()">닫기</button>
            </div>
          </div>
        `;
      } else if (err.message.includes('QUOTA') || err.message.includes('429')) {
        curArea.innerHTML = `
          <div class="chart-container mb-24 animation-fade-in" style="border:1px dashed #f59e0b; background:rgba(245, 158, 11, 0.05); text-align:center; padding:30px;">
            <div style="font-size:2.5rem; margin-bottom:12px;">${icons.clock()}</div>
            <h4 style="color:#f59e0b; margin-bottom:8px;">AI API 쿼터 초과</h4>
            <p style="font-size:0.9rem; line-height:1.5; color:var(--text-secondary);">
              Gemini API 무료 할당량이 일시적으로 소진되었습니다.<br>
              <strong>해결 방법:</strong> 약 1분 후 다시 시도하시거나, 유료 플랜을 검토해 보세요.
            </p>
            <div class="flex-center gap-12 mt-16">
              <button class="btn btn-primary btn-sm" onclick="window.redoDeepAnalysis && window.redoDeepAnalysis()">${icons.refresh()} 다시 시도</button>
              <button class="btn btn-secondary btn-sm" onclick="this.closest('.chart-container').remove()">닫기</button>
            </div>
          </div>
        `;
      } else if (err.message.includes('ERR_CONNECTION_REFUSED') || err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        curArea.innerHTML = `
          <div class="chart-container mb-24 animation-fade-in" style="border:1px dashed #ef4444; background:rgba(239, 68, 68, 0.05); text-align:center; padding:30px;">
            <div style="font-size:2.5rem; margin-bottom:12px;">🔌</div>
            <h4 style="color:#ef4444; margin-bottom:8px;">서버에 연결할 수 없음</h4>
            <p style="font-size:0.9rem; line-height:1.5; color:var(--text-secondary);">
              백엔드 서버가 응답하지 않습니다.<br>
              터미널에서 <code>npm run dev</code>가 실행 중인지 확인해 주세요.
            </p>
            <div class="flex-center gap-12 mt-16">
              <button class="btn btn-primary btn-sm" onclick="window.redoDeepAnalysis && window.redoDeepAnalysis()">${icons.refresh()} 재시도</button>
              <button class="btn btn-secondary btn-sm" onclick="this.closest('.chart-container').remove()">닫기</button>
            </div>
          </div>
        `;
      } else if (err.message.includes('PARSE_ERROR')) {
        curArea.innerHTML = `
          <div class="chart-container mb-24 animation-fade-in" style="border:1px dashed var(--warning); background:rgba(var(--warning-rgb), 0.05); text-align:center; padding:30px;">
            <div style="font-size:2.5rem; margin-bottom:12px;">🧩</div>
            <h4 style="color:var(--warning); margin-bottom:8px;">응답 파싱 실패</h4>
            <p style="font-size:0.9rem; line-height:1.5; color:var(--text-secondary);">
              AI가 유효하지 않은 형식으로 응답했습니다.<br>
              일시적인 현상일 수 있으니 '다시 시도'를 눌러보세요.
            </p>
            <div class="flex-center gap-12 mt-16">
              <button class="btn btn-primary btn-sm" onclick="window.redoDeepAnalysis && window.redoDeepAnalysis()">${icons.refresh()} 다시 기획 요청</button>
              <button class="btn btn-secondary btn-sm" onclick="this.closest('.chart-container').remove()">닫기</button>
            </div>
          </div>
        `;
      } else {
        showToast('심층 분석 실패: ' + err.message, 'error');
        curArea.innerHTML = `
          <div class="chart-container mb-24 animation-fade-in" style="border:2px solid var(--danger); text-align:center; padding:30px;">
            <h4 style="color:var(--danger); margin-bottom:12px;">${icons.error()} 분석 중 오류 발생</h4>
            <p style="font-size:0.9rem; color:var(--text-secondary); margin-bottom:20px;">${err.message}</p>
            <div class="flex-center gap-12">
               <button class="btn btn-secondary btn-sm" onclick="window.redoDeepAnalysis && window.redoDeepAnalysis()">${icons.refresh()} 다시 시도</button>
               <button class="btn btn-secondary btn-sm" onclick="this.closest('.chart-container').remove()">닫기</button>
            </div>
          </div>
        `;
      }
    }
  } finally {
    window.__activeDeepAnalysis = null;
    // Ensure loading state in localStorage is also cleared if not success
    const s = getStoredState();
    if (s.deepStatus === 'LOADING') {
      updateStoredState({ deepStatus: 'IDLE' });
    }
  }
}

// ── 로컬 DNA 보조 통계 컴팩트 섹션 (Gemini 결과 위에 표시) ──────────
function buildLocalDnaCompact(dna, catX) {
  const ta = dna.title_analysis || {};
  const tim = dna.timing_analysis || {};
  const fallbackNote = dna._meta?.usedFallback ? ' (상위 10% 대체)' : '';
  const keywords = (ta.top_keywords || []).slice(0, 10);
  const bestDays = (tim.best_days || []).slice(0, 3);
  const bestHours = (tim.best_hours || []).slice(0, 3);

  return `
    <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px 14px; margin-bottom:14px;">
      <div style="font-size:0.75rem; font-weight:700; color:var(--text-muted); margin-bottom:10px; letter-spacing:0.05em;">
        📊 DB 기반 떡상 통계${fallbackNote} — ${catX}
      </div>
      <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:10px;">
        <div style="text-align:center;">
          <div style="font-size:1.2rem; font-weight:900; color:#2ecc40;">${dna.viral_count}<span style="font-size:0.7rem; color:var(--text-muted);">개</span></div>
          <div style="font-size:0.68rem; color:var(--text-muted);">떡상 영상</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:1.2rem; font-weight:900; color:#ff4136;">${dna.viral_rate}<span style="font-size:0.7rem; color:var(--text-muted);">%</span></div>
          <div style="font-size:0.68rem; color:var(--text-muted);">떡상 비율</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:1.2rem; font-weight:900; color:#ffd700;">${ta.avg_length || 0}<span style="font-size:0.7rem; color:var(--text-muted);">자</span></div>
          <div style="font-size:0.68rem; color:var(--text-muted);">평균 제목</div>
        </div>
        ${bestDays.length > 0 ? `
        <div style="text-align:center;">
          <div style="font-size:1.1rem; font-weight:900; color:var(--accent);">${bestDays[0]}요일</div>
          <div style="font-size:0.68rem; color:var(--text-muted);">최적 요일</div>
        </div>` : ''}
        ${bestHours.length > 0 ? `
        <div style="text-align:center;">
          <div style="font-size:1.1rem; font-weight:900; color:var(--accent);">${bestHours[0]}시</div>
          <div style="font-size:0.68rem; color:var(--text-muted);">최적 시간</div>
        </div>` : ''}
      </div>
      ${keywords.length > 0 ? `
      <div>
        <div style="font-size:0.68rem; color:var(--text-muted); margin-bottom:5px;">자주 등장하는 키워드</div>
        <div style="display:flex; flex-wrap:wrap; gap:4px;">
          ${keywords.map(w => `<span style="background:rgba(255,200,0,0.1); color:#ffd700; border:1px solid rgba(255,200,0,0.25); border-radius:16px; padding:2px 8px; font-size:0.72rem;">${w}</span>`).join('')}
        </div>
      </div>` : ''}
    </div>
  `;
}

// ── 로컬 DNA 결과를 심층 기획 분석 영역에 렌더링 ─────────────────────
function renderLocalDnaInGaps(area, dna, catX, catY, existingCount, opportunityLabel, api) {
  const ta = dna.title_analysis || {};
  const tim = dna.timing_analysis || {};
  const tag = dna.tag_analysis || {};
  const genre = dna.genre_distribution || {};
  const sp = ta.structure_pattern || {};

  // 장르 바 차트
  const genreEntries = Object.entries(genre).sort((a, b) => b[1] - a[1]);
  const genreHtml = genreEntries.length > 0
    ? genreEntries.map(([name, pct]) => `
        <div style="margin-bottom:6px;">
          <div style="display:flex; justify-content:space-between; font-size:0.78rem; margin-bottom:2px;">
            <span>${name}</span><span style="color:var(--accent);">${pct}%</span>
          </div>
          <div style="background:rgba(255,255,255,0.07); border-radius:4px; height:6px; overflow:hidden;">
            <div style="width:${pct}%; height:100%; background:var(--accent); border-radius:4px;"></div>
          </div>
        </div>`).join('')
    : '<span style="color:var(--text-muted); font-size:0.8rem;">카테고리 데이터 없음</span>';

  // 요일 분포 막대 차트
  const dayEntries = Object.entries(tim.day_distribution || {});
  const maxDay = Math.max(...dayEntries.map(([, v]) => v), 1);
  const dayHtml = dayEntries.map(([day, cnt]) => `
    <div style="text-align:center; flex:1;">
      <div style="font-size:0.65rem; color:var(--text-muted); margin-bottom:3px;">${day}</div>
      <div style="background:rgba(255,255,255,0.07); border-radius:3px; height:40px; position:relative; overflow:hidden;">
        <div style="position:absolute; bottom:0; width:100%; height:${Math.round(cnt/maxDay*100)}%; background:var(--accent); border-radius:3px 3px 0 0;"></div>
      </div>
      <div style="font-size:0.65rem; margin-top:2px;">${cnt}</div>
    </div>`).join('');

  // 구조 패턴 태그
  const structTags = [
    ['의문형', sp.question], ['감탄형', sp.exclamation],
    ['서술형', sp.narrative], ['말줄임', sp.ellipsis], ['인용형', sp.quote]
  ].filter(([, v]) => v > 0)
   .map(([name, pct]) => `<span style="background:rgba(120,80,255,0.15); color:var(--accent); border:1px solid rgba(120,80,255,0.3); border-radius:16px; padding:3px 10px; font-size:0.78rem;">${name} ${pct}%</span>`)
   .join('');

  const fallbackNote = dna._meta?.usedFallback
    ? `<div style="font-size:0.75rem; color:#fbbf24; margin-bottom:8px;">${icons.warning()} 떡상 기준(구독자 대비 50배) 미달 — 상위 10% 영상으로 대체 분석</div>` : '';

  const uid = 'gdna' + Date.now();

  area.innerHTML = `
    <div class="chart-container mb-24 animation-fade-in" style="border:2px solid var(--accent); background:var(--card-bg);">
      <!-- 헤더 -->
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:12px;">
        <div style="flex:1;">
          <h4 style="margin:0 0 6px 0; color:var(--accent); font-size:0.9rem; line-height:1.4;">
            📊 [${catY} × ${catX}] DB 기반 떡상 DNA 분석
          </h4>
          <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">
            ${opportunityLabel}
            <span class="tag safe">로컬 분석 완료 (Gemini 없음)</span>
            <span style="font-size:0.78rem; color:var(--text-muted);">기존 영상 ${existingCount}개</span>
          </div>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-secondary" style="padding:5px 10px; font-size:0.75rem; white-space:nowrap; border-radius:8px;" onclick="window.redoDeepAnalysis()">${icons.refresh()} 다시 분석</button>
          <button class="btn btn-secondary" style="padding:5px 10px; font-size:0.75rem; white-space:nowrap; border-radius:8px;" onclick="this.closest('.chart-container').remove()">${icons.close()} 닫기</button>
        </div>
      </div>

      ${fallbackNote}

      <!-- 통계 헤더 -->
      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
        <div style="flex:1; min-width:90px; text-align:center; background:rgba(46,204,64,0.08); border-radius:10px; padding:10px;">
          <div style="font-size:1.4rem; font-weight:900; color:#2ecc40;">${dna.viral_count}</div>
          <div style="font-size:0.7rem; color:var(--text-muted);">떡상 영상</div>
        </div>
        <div style="flex:1; min-width:90px; text-align:center; background:rgba(255,255,255,0.04); border-radius:10px; padding:10px;">
          <div style="font-size:1.4rem; font-weight:900;">${dna.total_count}</div>
          <div style="font-size:0.7rem; color:var(--text-muted);">전체 영상</div>
        </div>
        <div style="flex:1; min-width:90px; text-align:center; background:rgba(255,65,54,0.08); border-radius:10px; padding:10px;">
          <div style="font-size:1.4rem; font-weight:900; color:#ff4136;">${dna.viral_rate}%</div>
          <div style="font-size:0.7rem; color:var(--text-muted);">떡상 비율</div>
        </div>
        <div style="flex:1; min-width:90px; text-align:center; background:rgba(255,200,0,0.08); border-radius:10px; padding:10px;">
          <div style="font-size:1.4rem; font-weight:900; color:#ffd700;">${ta.avg_length || 0}자</div>
          <div style="font-size:0.7rem; color:var(--text-muted);">평균 제목 길이</div>
        </div>
      </div>

      <!-- 탭 -->
      <div class="flex gap-8 mb-16" id="${uid}-tabs" style="background:rgba(255,255,255,0.03); padding:6px; border-radius:12px;">
        <button class="btn btn-secondary active-tab gdna-tab-btn" data-uid="${uid}" data-tab="title" style="flex:1; font-weight:700; font-size:0.8rem;">📝 제목 패턴</button>
        <button class="btn btn-secondary gdna-tab-btn" data-uid="${uid}" data-tab="timing" style="flex:1; font-weight:700; font-size:0.8rem;">⏰ 타이밍</button>
        <button class="btn btn-secondary gdna-tab-btn" data-uid="${uid}" data-tab="tags" style="flex:1; font-weight:700; font-size:0.8rem;">🏷 태그</button>
        <button class="btn btn-secondary gdna-tab-btn" data-uid="${uid}" data-tab="genre" style="flex:1; font-weight:700; font-size:0.8rem;">🎭 장르</button>
      </div>

      <!-- 제목 패턴 탭 -->
      <div id="${uid}-tab-title" class="gdna-tab-content">
        <div style="margin-bottom:12px;">
          <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:8px;">자주 등장하는 단어 TOP20</div>
          <div style="display:flex; flex-wrap:wrap; gap:6px;">
            ${(ta.top_keywords || []).map(w => `<span style="background:rgba(255,200,0,0.12); color:#ffd700; border:1px solid rgba(255,200,0,0.3); border-radius:20px; padding:3px 10px; font-size:0.78rem;">${w}</span>`).join('')}
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:8px;">제목 구조 패턴</div>
          <div style="display:flex; flex-wrap:wrap; gap:6px;">${structTags || '<span style="color:var(--text-muted); font-size:0.8rem;">데이터 없음</span>'}</div>
        </div>
        <div>
          <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:8px;">특수문자 사용</div>
          <div style="display:flex; flex-wrap:wrap; gap:8px;">
            ${Object.entries(ta.special_chars || {}).filter(([,v])=>v>0).map(([ch, cnt]) =>
              `<span style="background:rgba(255,255,255,0.06); border-radius:8px; padding:4px 10px; font-size:0.82rem;">${ch} <strong>${cnt}</strong>회</span>`
            ).join('')}
          </div>
        </div>
      </div>

      <!-- 타이밍 탭 -->
      <div id="${uid}-tab-timing" class="gdna-tab-content hidden">
        <div style="margin-bottom:14px;">
          <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:8px;">최적 게시 요일 Top3</div>
          <div style="display:flex; gap:8px;">
            ${(tim.best_days || []).map((d, i) => `<span style="background:${i===0?'rgba(46,204,64,0.2)':'rgba(255,255,255,0.06)'}; color:${i===0?'#2ecc40':'inherit'}; border-radius:8px; padding:4px 14px; font-size:0.9rem; font-weight:700;">${d}요일</span>`).join('')}
          </div>
        </div>
        <div style="margin-bottom:14px;">
          <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:8px;">최적 게시 시간대 Top3</div>
          <div style="display:flex; gap:8px;">
            ${(tim.best_hours || []).map((h, i) => `<span style="background:${i===0?'rgba(46,204,64,0.2)':'rgba(255,255,255,0.06)'}; color:${i===0?'#2ecc40':'inherit'}; border-radius:8px; padding:4px 14px; font-size:0.9rem; font-weight:700;">${h}시</span>`).join('')}
          </div>
        </div>
        <div>
          <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:8px;">요일별 떡상 영상 수</div>
          <div style="display:flex; gap:4px; align-items:flex-end; height:70px;">${dayHtml}</div>
        </div>
      </div>

      <!-- 태그 탭 -->
      <div id="${uid}-tab-tags" class="gdna-tab-content hidden">
        <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:8px;">상위 태그 15개</div>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">
          ${(tag.top_tags || []).length > 0
            ? tag.top_tags.map(t => `<span style="background:rgba(120,80,255,0.15); color:var(--accent); border:1px solid rgba(120,80,255,0.3); border-radius:16px; padding:4px 12px; font-size:0.82rem;">#${t}</span>`).join('')
            : '<span style="color:var(--text-muted); font-size:0.8rem;">태그 데이터 없음</span>'}
        </div>
      </div>

      <!-- 장르 탭 -->
      <div id="${uid}-tab-genre" class="gdna-tab-content hidden">
        <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:12px;">카테고리별 분포</div>
        ${genreHtml}
      </div>
    </div>
  `;

  // 탭 전환 이벤트
  area.querySelectorAll(`.gdna-tab-btn[data-uid="${uid}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      area.querySelectorAll(`.gdna-tab-btn[data-uid="${uid}"]`).forEach(b => b.classList.remove('active-tab'));
      area.querySelectorAll('.gdna-tab-content').forEach(c => c.classList.add('hidden'));
      btn.classList.add('active-tab');
      area.querySelector(`#${uid}-tab-${btn.dataset.tab}`)?.classList.remove('hidden');
    });
  });
}

// Global helpers and event attachments
function attachSuggestionEvents(container, api) {
  // [안전장치] 중복 리스너 방지: 이미 리스너가 등록된 항목은 건너뜀
  if (container.dataset.listenersAttached === 'true') {
    console.log('[attachSuggestionEvents] Already attached, skipping duplicate bind.');
    return;
  }
  container.dataset.listenersAttached = 'true';

  container.querySelectorAll('.clickable-suggestion').forEach(item => {
    // Direct assignment to the DOM element property to ensure accessibility in global handlers
    item._api = api;

    item.addEventListener('click', async (e) => {
      if (e.target.closest('.script-plan-result') || e.target.closest('.redo-titles-btn')) return;

      const loading = item.querySelector('.script-plan-loading');
      const resultArea = item.querySelector('.script-plan-result');

      if (loading.style.display === 'block') return;
      if (resultArea.style.display === 'block') {
        resultArea.style.display = 'none';
        return;
      }
      if (resultArea.children.length > 0) {
        resultArea.style.display = 'block';
        return;
      }

      const title = item.dataset.title;
      const category = (item.dataset.yadam === 'true') ? '야담' : '일반';

      loading.style.display = 'block';
      item.style.cursor = 'wait';

      try {
        // 1. Analyze Theme DNA (Search + Extraction)
        const dnaRes = await api.analyzeThemeDna(title, category);
        const dna = dnaRes.dna;

        loading.style.display = 'none';
        item.style.cursor = 'pointer';
        resultArea.style.display = 'block';

        // 2. Render action UI (DNA 데이터는 내부 변수로 유지, UI는 표시 안 함)
        resultArea.innerHTML = `
          <div style="background:var(--bg-card); padding:20px; border-radius:12px; border:1px solid var(--accent-glow); margin-bottom:16px;">
            <div style="text-align:center;">
              <button class="btn btn-primary btn-sm theme-recommend-titles-btn" style="width:100%; font-weight:800;">
                🎯 이 DNA로 후킹 제목 10종 생성하기
              </button>
            </div>
            <div class="theme-titles-result hidden mt-16"></div>
          </div>
        `;

        // Event: Recommend Titles for this DNA
        const titleBtn = resultArea.querySelector('.theme-recommend-titles-btn');
        const titlesResult = resultArea.querySelector('.theme-titles-result');

        const doFetchTitles = async () => {
          const kwRes = await api.extractGoldenKeywords(dna);
          const tRes = await api.recommendDnaTitles(dna, kwRes, category, title);
          const titles = tRes.titles || [];
          titles.unshift({ title, ctr_score: 100, reason: '⭐ 선택하신 원본 주제' });

          titlesResult.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; gap:6px;">
              <div style="font-weight:800; color:var(--danger); font-size:0.85rem;">🔥 떡상 공식 추천 제목 ${titles.length}개 (원본 1개 포함)</div>
              <div style="display:flex; gap:6px; flex-shrink:0;">
                <button class="redo-titles-inner-btn" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-muted); cursor:pointer; font-size:0.72rem; font-weight:700; padding:2px 10px; border-radius:4px;">🔄 다시 추천</button>
                <button class="titles-section-toggle" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-muted); cursor:pointer; font-size:0.72rem; font-weight:700; padding:2px 10px; border-radius:4px;">▼ 접기</button>
              </div>
            </div>
            <div class="titles-collapsible-content" style="overflow:hidden; transition:max-height 0.3s ease;">
              <div data-title-list style="display:flex; flex-direction:column; gap:8px;">
                ${titles.map(t => `
                  <label class="theme-title-item"
                    data-title-val="${t.title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"
                    style="display:flex; align-items:flex-start; gap:12px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:10px 14px; border-radius:8px; cursor:pointer; font-size:0.95rem; font-weight:800; transition:all 0.2s;">
                    <input type="radio" name="theme-title-radio" value="${t.title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" style="width:18px; height:18px; accent-color:var(--accent); flex-shrink:0; margin-top:2px;">
                    <div style="flex:1;">
                      <span class="title-text">${t.title}</span>
                      <span style="font-size:0.65rem; color:var(--accent); font-weight:400; display:block; margin-top:4px;">${t.reason}</span>
                    </div>
                  </label>
                `).join('')}
              </div>
            </div><!-- /titles-collapsible-content -->
          `;

          // Toggle
          const titlesToggleBtn = titlesResult.querySelector('.titles-section-toggle');
          const titlesCollapsible = titlesResult.querySelector('.titles-collapsible-content');
          if (titlesToggleBtn && titlesCollapsible) {
            titlesCollapsible.style.maxHeight = titlesCollapsible.scrollHeight + 'px';
            titlesToggleBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              const isOpen = titlesCollapsible.style.maxHeight !== '0px';
              titlesCollapsible.style.maxHeight = isOpen ? '0px' : titlesCollapsible.scrollHeight + 'px';
              titlesToggleBtn.textContent = isOpen ? '▲ 펼치기' : '▼ 접기';
            });
          }

          // 라디오 선택 → 하이라이트
          titlesResult.querySelectorAll('input[name="theme-title-radio"]').forEach(radio => {
            radio.addEventListener('change', () => {
              // 하이라이트 초기화
              titlesResult.querySelectorAll('.theme-title-item').forEach(item => {
                item.style.background = 'rgba(255,255,255,0.03)';
                item.style.borderColor = 'rgba(255,255,255,0.08)';
              });
              // 선택된 항목 하이라이트
              const label = radio.closest('.theme-title-item');
              if (label) {
                label.style.background = 'rgba(99,102,241,0.1)';
                label.style.borderColor = 'rgba(99,102,241,0.5)';
              }
            });
          });

          // 다시 추천 버튼
          const redoInnerBtn = titlesResult.querySelector('.redo-titles-inner-btn');
          if (redoInnerBtn) {
            redoInnerBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              redoInnerBtn.disabled = true;
              redoInnerBtn.textContent = '추천 중...';
              titlesResult.innerHTML = '<div class="flex-center" style="padding:20px; flex-direction:column; gap:10px;"><div class="spinner-sm"></div><div style="font-size:0.75rem; color:var(--text-muted);">분석된 주제 최적화 DNA 기반으로 분석중...</div></div>';
              try { await doFetchTitles(); } catch (err) {
                titlesResult.innerHTML = `<div style="color:var(--danger); font-size:0.8rem;">❌ 실패: ${err.message}</div>`;
              }
            });
          }
        };

        titleBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          titleBtn.disabled = true;
          titleBtn.innerHTML = '<span class="spinner-sm"></span> 분석 중...';
          titlesResult.classList.remove('hidden');
          titlesResult.innerHTML = '<div class="flex-center" style="padding:20px; flex-direction:column; gap:10px;"><div class="spinner-sm"></div><div style="font-size:0.75rem; color:var(--text-muted);">분석된 주제 최적화 DNA 기반으로 분석중...</div></div>';
          try {
            await doFetchTitles();
            titleBtn.innerHTML = `${icons.success()} 제목 추천 완료`;
          } catch (err) {
            titlesResult.innerHTML = `<div style="color:var(--danger); font-size:0.8rem;">${icons.error()} 실패: ${err.message}</div>`;
            titleBtn.disabled = false;
            titleBtn.innerHTML = `${icons.refresh()} 다시 시도`;
          }
        });

      } catch (err) {
        loading.style.display = 'none';
        item.style.cursor = 'pointer';
        showToast('분석 실패: ' + err.message, 'error');
      }
    });
  });
}

if (!window.toggleListMagnify) {
  window.toggleListMagnify = function (btn) {
    const list = btn.closest('.chart-container').querySelector('[id$="-list"]');
    if (!list) return;
    const items = list.querySelectorAll('.suggestion-item');
    const isEnlarged = list.classList.toggle('font-large-list');

    items.forEach(item => {
      const title = item.querySelector('.suggestion-title');
      const reason = item.querySelector('div[style*="font-size:0.83rem"]');
      const tags = item.querySelectorAll('.tag');

      if (isEnlarged) {
        if (title) title.style.fontSize = '1.4rem';
        if (reason) reason.style.fontSize = '1.1rem';
        tags.forEach(t => t.style.fontSize = '0.95rem');
      } else {
        if (title) title.style.fontSize = '1.1rem';
        if (reason) reason.style.fontSize = '0.83rem';
        tags.forEach(t => t.style.fontSize = '0.75rem');
      }
    });
    btn.innerHTML = isEnlarged ? `${icons.search()} 축소하기` : `${icons.search()} 글씨 전체 크게`;
  };
}

if (!window.copyAllKeywords) {
  window.copyAllKeywords = function (btn) {
    const list = btn.closest('.chart-container').querySelector('[id$="-list"]');
    if (!list) return;
    const items = list.querySelectorAll('.suggestion-item');
    const allKeywordsSet = new Set();
    items.forEach(item => {
      const tags = item.querySelectorAll('.tag');
      tags.forEach(tag => {
        const kw = tag.innerText.replace('#', '').trim();
        if (kw) allKeywordsSet.add(kw);
      });
    });
    const textToCopy = Array.from(allKeywordsSet).join(', ');
    navigator.clipboard.writeText(textToCopy).then(() => {
      const originalText = btn.innerHTML;
      btn.innerHTML = `${icons.success()} 전체 복사됨!`;
      btn.style.color = 'var(--success)';
      setTimeout(() => { btn.innerHTML = originalText; btn.style.color = ''; }, 2000);
    });
  };
}

function renderEconomyTrends(data, api, targetEl) {
  renderEconomyV3(api, targetEl, data);
}

// --- 구형 경제 분석 로직 소거 완료 (Economy v3로 일원화) ---

/**
 * [Economy v3] 3단계 고도화 분석 메인 렌더러
 */
async function renderEconomyV3(api, targetEl, initialData = null) {
  const el = targetEl || document.getElementById('gap-results');
  el.innerHTML = `
    <div class="animation-fade-in" style="display:flex; flex-direction:column; gap:24px;">
      
      <!--상단 컨트롤 바-->
      <div class="chart-container" style="border:1px solid rgba(59,130,246,0.3); background:rgba(13,17,23,0.6); padding:16px 24px; border-radius:16px; backdrop-filter:blur(8px);">
        <div class="flex-between" style="align-items:center; flex-wrap:wrap; gap:20px;">
          <div>
            <h4 style="margin:0; color:#60a5fa; font-size:1.25rem; font-weight:800; letter-spacing:-0.02em;">🔬 경제 고도화 심층 분석 엔진 <span style="font-size:0.7rem; vertical-align:middle; background:#3b82f6; color:white; padding:2px 6px; border-radius:4px; margin-left:6px; opacity:0.8;">V3</span></h4>
            <p style="margin:6px 0 0 0; font-size:0.85rem; color:var(--text-muted); opacity:0.8;">등록 채널 떡상 데이터 분석 · AI 차별화 주제 제안 · 고성능 대본 뼈대 구성</p>
          </div>
          <div class="flex gap-12" style="align-items:center;">
             <select id="v3-period-select" class="btn btn-secondary" style="background:#161b22; border:1px solid rgba(255,255,255,0.1); height:42px; padding:0 12px; font-weight:600; font-size:0.9rem; border-radius:10px;">
               <option value="3" selected>최근 3일 분석</option>
               <option value="7">최근 7일 분석</option>
             </select>
             <button id="v3-analyze-btn" class="btn btn-primary" style="background:linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); border:none; height:42px; padding:0 20px; font-weight:700; font-size:0.95rem; border-radius:10px; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 4px 12px rgba(37,99,235,0.3); white-space:nowrap; min-width:fit-content;">
               <span>${icons.fire(14)}</span> 경제 분석 실행
             </button>
          </div>
        </div>
      </div>

      <!--2단 가로 레이아웃 (야담 스타일)-->
      <div style="display:grid; grid-template-columns: 350px 1fr; gap:24px; align-items: start; min-height:800px;">

        <!-- 좌측: 1단계 핫 이슈 키워드 랭킹 -->
        <div id="v3-ranking-column" class="chart-container" style="position:sticky; top:20px; padding:20px; background:rgba(13,17,23,0.4); border-radius:16px; border:1px solid rgba(255,255,255,0.05);">
          <h5 style="margin:0 0 14px 0; color:#818cf8; font-size:1rem; font-weight:800; display:flex; align-items:center; gap:8px;">
            <span style="font-size:1.2rem;">🔥</span> 핫 이슈 키워드 랭킹
          </h5>
          <div id="v3-keyword-list" style="display:flex; flex-direction:column; gap:12px;">
            ${initialData ? '<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:0.8rem;">데이터 복원 중...</div>' : `
            <div style="text-align:center; padding:30px 16px; color:var(--text-muted); font-size:0.85rem; border:1px dashed rgba(255,255,255,0.1); border-radius:12px;">
              분석 버튼을 누르면<br>키워드를 추출합니다.
            </div>
            `}
          </div>
        </div>

        <!-- 우측: 2단계 주제 추천 및 3단계 뼈대 (통합 구역) -->
        <div id="v3-topics-area" class="chart-container" style="padding:24px; background:rgba(13,17,23,0.4); border-radius:16px; border:1px solid rgba(129,140,248,0.1);">
          <h5 style="margin:0 0 16px 0; color:#a5b4fc; font-size:1.1rem; font-weight:800; display:flex; align-items:center; gap:8px;">
            <span style="font-size:1.3rem;">🎯</span> AI 차별화 주제 추천 & 대본 설계
          </h5>
          <div id="v3-topic-list" style="display:flex; flex-direction:column; gap:20px;">
            <div style="text-align:center; padding:50px 16px; color:var(--text-muted); font-size:1rem; border:1px dashed rgba(255,255,255,0.1); border-radius:16px;">
              좌측 키워드 랭킹에서 관심 있는 주제의 <b>'AI 추천 받기'</b> 버튼을 클릭하세요.
            </div>
          </div>
        </div>

      </div>
    </div>
    </div>
    `;

  // 이벤트 바인딩
  const analyzeBtn = el.querySelector('#v3-analyze-btn');
  const periodSel = el.querySelector('#v3-period-select');

  analyzeBtn.addEventListener('click', () => runEconomyAnalysisV3(api, periodSel.value));

  // 초기 데이터가 있으면 바로 렌더링
  if (initialData) {
    displayEconomyResultsV3(initialData, api);
  }
}

/**
 * 전용 유틸: 기존 데이터 UI 표시 전용
 */
function displayEconomyResultsV3(data, api) {
  const rankingList = document.getElementById('v3-keyword-list');
  if (!rankingList) return;

  let messageHtml = '';
  if (data.error) {
    messageHtml += `<div style="font-size:0.85rem; color:#ef4444; padding:12px 16px; background:rgba(239,68,68,0.1); border-radius:10px; border:1px solid rgba(239,68,68,0.2); margin-bottom:16px; line-height:1.5;">🛑 <b>분석 엔진 경고:</b><br>${data.error}</div>`;
  }
  if (data.message) {
    const msgColor = data.keywords?.length > 0 ? '#3b82f6' : '#f59e0b';
    messageHtml += `<div style="font-size:0.75rem; color:${msgColor}; padding:10px 14px; background:rgba(255,165,0,0.05); border-radius:8px; border:1px solid rgba(255,165,0,0.1); margin-bottom:12px; line-height:1.4;">💡 ${data.message}</div>`;
  }

  rankingList.innerHTML = messageHtml;

  // Persistence: Sub-step restoration (Nested UI 지원)
  if (data.subSteps) {
    if (data.subSteps.topics) {
      setTimeout(() => {
        const kw = data.keywords.find(k => k.keyword === data.subSteps.selectedKeyword) || data.keywords[0];
        renderEconomyTopicsV3(api, data.subSteps.topics, kw);

        if (data.subSteps.thumbnails) {
          // 저장된 인덱스 또는 제목으로 해당 토픽 아이템 찾기
          const topicItems = document.querySelectorAll('.v3-topic-item');
          let targetItem = null;
          topicItems.forEach(item => {
            if (item.innerText.includes(data.subSteps.thumbnails.topicTitle)) targetItem = item;
          });

          if (targetItem) {
            targetItem.querySelector('.v3-details-container').style.display = 'block';
            targetItem.style.background = 'rgba(99,102,241,0.05)';
            targetItem.style.borderColor = 'rgba(99,102,241,0.2)';
            renderEconomyThumbnailsV3(api, data.subSteps.thumbnails.titles, kw, data.subSteps.thumbnails.topicTitle, targetItem);

          }
        }
      }, 100);
    }
  }

  if (!data.keywords || data.keywords.length === 0) {
    rankingList.innerHTML += `<div class="empty-state">검사된 영상 중 분석 가능한 주제가 발견되지 않았습니다.</div>`;
    return;
  }

  const fmtNum = (n) => n >= 10000 ? (n / 10000).toFixed(1) + '만' : n.toLocaleString();
  const fmtDate = (d) => {
    if (!d) return '-';
    const date = new Date(d);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  };

  // 아코디언 스타일 주입
  if (!document.getElementById('v3-accordion-style')) {
    const style = document.createElement('style');
    style.id = 'v3-accordion-style';
    style.innerHTML = `
      .v3-keyword-item { margin-bottom: 12px; overflow: hidden; }
      .v3-keyword-header { padding: 16px; cursor: pointer; transition: background 0.2s; }
      .v3-keyword-header:hover { background: rgba(255,255,255,0.03); }
      .v3-keyword-details {
        max-height: 0;
        overflow: hidden;
        transition: max-height 0.3s ease-out, padding 0.3s ease;
        background: rgba(0,0,0,0.2);
        padding: 0 16px;
      }
      .v3-keyword-item.open .v3-keyword-details {
        max-height: 1000px;
        padding: 16px;
        border-top: 1px solid rgba(255,255,255,0.05);
      }
      .v3-video-link {
        display: block;
        padding: 8px 0;
        border-bottom: 1px solid rgba(255,255,255,0.03);
        text-decoration: none;
        transition: opacity 0.2s;
      }
      .v3-video-link:hover { opacity: 0.8; }
      .v3-video-link:last-child { border-bottom: none; }
      
      .v3-suggest-btn {
        width: 100%;
        margin-top: 12px;
        padding: 10px;
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 8px;
        font-weight: 800;
        font-size: 0.85rem;
        cursor: pointer;
        transition: background 0.2s;
      }
      .v3-suggest-btn:hover { background: #2563eb; }
    `;
    document.head.appendChild(style);
  }

  rankingList.innerHTML += data.keywords.map((kw, i) => `
    <div class="v3-keyword-item card" data-idx="${i}" style="background:rgba(22,27,34,0.6); border:1px solid rgba(255,255,255,0.05); border-radius:12px; transition:all 0.2s ease;">
          <div class="v3-keyword-header" style="padding:12px 14px;">
            <div class="flex-between" style="align-items:center; gap:8px; margin-bottom:6px;">
              <div style="display:flex; align-items:center; gap:8px; flex: 1; min-width: 0;">
                <span style="font-size:1rem; font-weight:900; color:#3b82f6; opacity:0.9; flex-shrink:0;">${i + 1}</span>
                <span title="${kw.keyword.replace(/"/g, '&quot;')}" style="font-size:1.05rem; font-weight:800; color:#e2e8f0; letter-spacing:-0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${kw.keyword}</span>
              </div>
              <div style="background:rgba(239,68,68,0.1); color:#ef4444; font-size:0.65rem; font-weight:800; padding:3px 8px; border-radius:100px; border:1px solid rgba(239,68,68,0.2); white-space:nowrap; flex-shrink:0;">떡상 ${kw.hit_count}</div>
            </div>
            <div class="flex gap-10" style="font-size:0.7rem; color:var(--text-muted); opacity:0.65; font-weight:600;">
              <span style="display:flex; align-items:center; gap:3px;">📊 평균 ${fmtNum(kw.avg_views)}</span>
              <span style="display:flex; align-items:center; gap:3px;">🔥 최대 ${fmtNum(kw.max_views)}</span>
            </div>
          </div>

          <div class="v3-keyword-details">
            <div style="font-size:0.7rem; color:#60a5fa; font-weight:800; margin-bottom:12px; text-transform:uppercase; letter-spacing:0.05em;">📈 모든 떡상 영상 (${kw.videos.length})</div>
            <div style="max-height: 300px; overflow-y: auto; padding-right: 4px;">
              ${kw.videos.map(v => `
                <a href="https://www.youtube.com/watch?v=${v.video_id}" target="_blank" class="v3-video-link">
                  <div style="font-size:0.82rem; color:#fff; font-weight:700; margin-bottom:4px; line-height:1.4;">${v.title}</div>
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.7rem; opacity:0.6;">
                    <span style="color:#22c55e;">${icons.chartBar(14)} ${fmtNum(v.view_count)}</span>
                    <span>${v.channel_name} · ${fmtDate(v.published_at)}</span>
                  </div>
                </a>
              `).join('')}
            </div>
            <button class="v3-suggest-btn" data-idx="${i}">💡 AI 차별화 주제 추천 받기</button>
          </div>
        </div>
  `).join('');

  // 이벤트 리스너: 아코디언 토글
  rankingList.querySelectorAll('.v3-keyword-header').forEach((header, idx) => {
    header.addEventListener('click', () => {
      const item = header.closest('.v3-keyword-item');
      const isOpen = item.classList.contains('open');

      // 다른 항목 닫기
      rankingList.querySelectorAll('.v3-keyword-item').forEach(el => {
        el.classList.remove('open');
        el.style.borderColor = 'rgba(255,255,255,0.05)';
      });

      if (!isOpen) {
        item.classList.add('open');
        item.style.borderColor = '#3b82f6';
      }
    });
  });

  // 이벤트 리스너: 주제 추천 버튼
  rankingList.querySelectorAll('.v3-suggest-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // 아코디언 토글 방지
      const idx = btn.dataset.idx;
      handleKeywordClickV3(api, data.keywords[idx]);
    });
  });
}

/**
 * 1단계: 분석 실행 및 랭킹 렌더링
 */
async function runEconomyAnalysisV3(api, period) {
  const rankingList = document.getElementById('v3-keyword-list');
  const analyzeBtn = document.getElementById('v3-analyze-btn');

  rankingList.innerHTML = `
  <div style="text-align:center; padding:30px 16px;">
      <div class="spinner-sm mb-16" style="margin:0 auto; border-top-color:#3b82f6; width:28px; height:28px; border-width:3px;"></div>
      <div style="font-size:0.9rem; color:#60a5fa; font-weight:700;">등록 채널 & 유튜브 실시간 트렌드 통합 분석 중...</div>
      <div style="font-size:0.75rem; color:var(--text-muted); margin-top:6px;">최신 떡상 데이터를 전수 조사하고 있습니다.</div>
    </div>
  `;
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<div class="spinner-sm" style="border-top-color:white;"></div> 분석 중...';

  try {
    const data = await api.getEconomyRealtimeV3({ period });
    displayEconomyResultsV3(data, api);
    updateStoredState({ economyStatus: 'SUCCESS', economyData: data });
  } catch (err) {
    updateStoredState({ economyStatus: 'IDLE' });
    rankingList.innerHTML = `<div class="empty-state">❌ 오류: ${err.message}</div> `;
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = `${icons.fire(14)} 경제 분석 실행`;
  }
}

/**
 * 2단계: 키워드 클릭 시 주제 추천
 */
async function handleKeywordClickV3(api, kwData) {
  const topicList = document.getElementById('v3-topic-list');

  topicList.innerHTML = `
    <div style="text-align:center; padding:60px 16px;">
      <div class="spinner-sm mb-16" style="margin:0 auto; border-top-color:#818cf8; width:40px; height:40px; border-width:4px;"></div>
      <div style="font-size:1.1rem; color:#a5b4fc; font-weight:800;">데이터 사각지대 및 새로운 관점 분석 중...</div>
    </div>
  `;

  try {
    const res = await api.suggestEconomyTopicsV3({
      keyword: kwData.keyword,
      existingVideos: kwData.videos.map(v => ({ title: v.title, view_count: v.view_count }))
    });

    if (!res || !res.suggestions || res.suggestions.length === 0) {
      topicList.innerHTML = `<div style="grid-column:1/-1;" class="empty-state">추천 결과가 없습니다.</div>`;
      return;
    }

    // Persistence: Save topic results
    const s = getStoredState();
    if (s.economyData) {
      s.economyData.subSteps = s.economyData.subSteps || {};
      s.economyData.subSteps.topics = res;
      s.economyData.subSteps.selectedKeyword = kwData.keyword;
      updateStoredState({ economyData: s.economyData });
    }

    renderEconomyTopicsV3(api, res, kwData);
  } catch (err) {
    topicList.innerHTML = `<div style="grid-column:1/-1;" class="empty-state">❌ 오류: ${err.message}</div>`;
  }
}

function renderEconomyTopicsV3(api, res, kwData) {
  const topicList = document.getElementById('v3-topic-list');
  if (!topicList) return;

  topicList.innerHTML = `
    <div style="font-size:0.9rem; color:#818cf8; background:rgba(129,140,248,0.1); padding:12px 16px; border-radius:12px; margin-bottom:16px; border:1px solid rgba(129,140,248,0.25); display:flex; align-items:center; justify-content:space-between; gap:10px; line-height:1.5;">
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:1.3rem;">📢</span> <span><b>시장 인사이트:</b> ${res.angle_analysis}</span>
      </div>
      <button id="v3-topics-refresh-btn" class="btn" style="padding:6px 12px; font-size:0.8rem; background:rgba(129,140,248,0.15); border:1px solid rgba(129,140,248,0.3); color:#a5b4fc; border-radius:8px; display:flex; align-items:center; gap:6px; font-weight:700; transition:all 0.2s;">
        🔄 주제 다시 추천받기
      </button>
    </div>
    ${res.suggestions.map((s, idx) => `
      <div class="v3-topic-item card clickable-v3-topic" 
           style="padding:20px; background:rgba(22,27,34,0.7); border-left:6px solid #6366f1; cursor:pointer; border-radius:16px; transition:all 0.25s ease; border:1px solid rgba(255,255,255,0.03); margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
          <div style="flex:1;">
            <div style="font-size:0.8rem; color:#818cf8; margin-bottom:6px; font-weight:800; text-transform:uppercase; letter-spacing:0.06em;">추천 주제 ${idx + 1} · ${s.target_audience}</div>
            <div title="${s.title.replace(/"/g, '&quot;')}" style="font-size:1.2rem; font-weight:900; color:#e2e8f0; line-height:1.4; letter-spacing:-0.02em;">${s.title}</div>
          </div>
          <div class="v3-click-arrow" style="font-size:0.9rem; color:#6366f1; font-weight:800; opacity:0.8; transition:all 0.2s;">CLICK ⌵</div>
        </div>
        <div style="font-size:0.85rem; color:var(--text-secondary); line-height:1.6; background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:10px; margin-bottom:0;">
          <span style="color:#a5b4fc; font-weight:800;">💡 차별화 전략:</span> ${s.differentiation_reason}
        </div>
        
        <!-- 하위 결과 출력용 컨테이너 (야담 스타일) -->
        <div class="v3-details-container" style="display:none; margin-top:20px; border-top:1px dashed rgba(99,102,241,0.3); padding-top:20px;">
          <div class="v3-internal-loader" style="text-align:center; padding:20px; display:none;">
            <div class="spinner-sm mb-8" style="margin:0 auto; border-top-color:#3b82f6;"></div>
            <div style="font-size:0.8rem; color:#60a5fa;">분석 중...</div>
          </div>
          <div class="v3-internal-content"></div>
        </div>
      </div>
    `).join('')}
  `;

  // [고도화] 주제 다시 추천받기 버튼 이벤트
  const topicRefreshBtn = topicList.querySelector('#v3-topics-refresh-btn');
  if (topicRefreshBtn) {
    topicRefreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleKeywordClickV3(api, kwData);
    });
  }

  // [고도화] 내부 클릭 시 아코디언이 접히지 않도록 방지 (Event Bubbling 차단)
  topicList.querySelectorAll('.v3-details-container').forEach(details => {
    details.addEventListener('click', (e) => e.stopPropagation());
  });

  topicList.querySelectorAll('.clickable-v3-topic').forEach((item, idx) => {
    item.addEventListener('click', (e) => {
      const details = item.querySelector('.v3-details-container');
      const arrow = item.querySelector('.v3-click-arrow');
      const isVisible = details.style.display === 'block';

      if (isVisible) {
        // 접기 (Collapse) - 상태는 유지됨 (HTML이 DOM에 존재)
        details.style.display = 'none';
        item.style.background = 'rgba(22,27,34,0.7)';
        item.style.borderColor = 'rgba(255,255,255,0.03)';
        if (arrow) arrow.innerText = 'CLICK ⌵';
      } else {
        // 펼치기 (Expand)
        // 강조 효과
        topicList.querySelectorAll('.v3-topic-item').forEach(el => {
          el.style.background = 'rgba(22,27,34,0.7)';
          el.style.borderColor = 'rgba(255,255,255,0.03)';
        });
        item.style.background = 'rgba(99,102,241,0.05)';
        item.style.borderColor = 'rgba(99,102,241,0.2)';
        details.style.display = 'block';
        if (arrow) arrow.innerText = 'CLOSE ▴';

        // 내용이 비어있고 + 로딩 중도 아닐 때만(진짜 최초 클릭 시) 분석 시작
        const content = item.querySelector('.v3-internal-content');
        const loader = item.querySelector('.v3-internal-loader');
        if (!content.innerHTML.trim() && loader.style.display !== 'block') {
          handleThumbnailClickV3(api, res.suggestions[idx], kwData, item);
        }
      }
    });
  });

  topicList.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * 2.5단계: 썸네일 제목 후보 추천 및 선택
 */
async function handleThumbnailClickV3(api, suggestion, kwData, parentItem) {
  const topicTitle = suggestion.title;
  const loader = parentItem.querySelector('.v3-internal-loader');
  const content = parentItem.querySelector('.v3-internal-content');

  loader.style.display = 'block';
  content.innerHTML = '';
  content.style.display = 'none';

  try {
    const res = await api.getThumbnailTitlesV3({
      topicTitle,
      keyword: kwData.keyword,
      existingTitles: kwData.videos.map(v => v.title)
    });

    const titles = [topicTitle, ...(res.candidates || []).filter(t => t !== topicTitle)].slice(0, 10);

    // Persistence: Save state
    const s = getStoredState();
    if (s.economyData) {
      s.economyData.subSteps = s.economyData.subSteps || {};
      s.economyData.subSteps.thumbnails = { titles, topicTitle };
      updateStoredState({ economyData: s.economyData });
    }

    renderEconomyThumbnailsV3(api, titles, kwData, suggestion, parentItem);
  } catch (err) {
    loader.style.display = 'none';
    content.style.display = 'block';
    content.innerHTML = `<div class="empty-state" style="padding:10px; font-size:0.8rem;">❌ 오류: ${err.message}</div>`;
  }
}

function renderEconomyThumbnailsV3(api, titles, kwData, suggestion, parentItem) {
  const topicTitle = suggestion.title;
  const loader = parentItem.querySelector('.v3-internal-loader');
  const content = parentItem.querySelector('.v3-internal-content');
  if (!content || !loader) return;

  // 로딩 숨기고 콘텐츠 표시
  loader.style.display = 'none';
  content.style.display = 'block';

  // 현재 선택된 제목 확인 (이미 체크된 게 있다면 유지)
  const currentChecked = content.querySelector('input[name="v3-selected-title"]:checked')?.value;

  content.innerHTML = `
    <div class="animation-fade-in" style="padding:10px 0;">
      <div style="margin-bottom:20px;">
        <h6 style="color:#60a5fa; font-weight:800; margin-bottom:12px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
          <span style="display:flex; align-items:center; gap:8px;">🎬 확정할 제목을 체크하세요 (체크 시 대본 생성)</span>
          <button id="v3-titles-refresh-btn" class="btn" style="padding:4px 10px; font-size:0.75rem; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:6px; color:#94a3b8; display:flex; align-items:center; gap:4px; transition:all 0.2s;">
            🔄 다시 추천받기
          </button>
        </h6>
        
        <div class="v3-thumbnail-selector" style="display:flex; flex-direction:column; gap:10px;">
          ${titles.map((t, i) => {
    const isChecked = currentChecked === t;
    const bg = isChecked ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.03)';
    const border = isChecked ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.05)';
    return `
              <label class="thumbnail-candidate-item" style="display:flex; align-items:center; gap:12px; padding:16px; background:${bg}; border:1px solid ${border}; border-radius:12px; cursor:pointer; transition:all 0.2s;">
                <input type="checkbox" name="v3-selected-title" value="${t.replace(/"/g, '&quot;')}" ${isChecked ? 'checked' : ''} style="width:20px; height:20px; accent-color:#3b82f6;">
                <span title="${t.replace(/"/g, '&quot;')}" style="font-size:1.05rem; font-weight:800; color:#e2e8f0; line-height:1.4;">${t}</span>
              </label>
            `;
  }).join('')}
        </div>
      </div>
      <div class="v3-final-skeleton-inner">
        <div style="text-align:center; padding:30px; color:var(--text-muted); font-size:0.9rem; border:1px dashed rgba(255,255,255,0.05); border-radius:12px;">
          위 제목 중 하나를 체크하시면 대본이 완성됩니다.
        </div>
      </div>
    </div>
  `;

  // 다시 추천받기 이벤트
  const refreshBtn = content.querySelector('#v3-titles-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleThumbnailClickV3(api, suggestion, kwData, parentItem);
    });
  }

  content.querySelectorAll('input[name="v3-selected-title"]').forEach(input => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      content.querySelectorAll('input[name="v3-selected-title"]').forEach(cb => { if (cb !== input) cb.checked = false; });
      content.querySelectorAll('.thumbnail-candidate-item').forEach(el => {
        el.style.background = 'rgba(255,255,255,0.03)';
        el.style.borderColor = 'rgba(255,255,255,0.05)';
      });
      const label = input.closest('.thumbnail-candidate-item');
      label.style.background = 'rgba(59,130,246,0.1)';
      label.style.borderColor = 'rgba(59,130,246,0.3)';
    });
  });
}

window.__forceResetAnalysis = function () {
  if (confirm('현재 진행 중인 분석 상태를 강제로 초기화할까요?\n(분석이 멈췄을 때만 사용하세요)')) {
    window.__activeDeepAnalysis = null;
    updateStoredState({ deepStatus: 'IDLE', deepParams: null, deepHtml: null });
    const area = document.getElementById('deep-analysis-area');
    if (area) area.innerHTML = '';
    showToast('분석 상태가 초기화되었습니다. 다시 시도해 주세요.', 'info');
  }
};


// ── 떡상 영상 선택 모달 (1차) ─────────────────────────────────────────────────
// ── DNA 콘텐츠 렌더링 헬퍼 ──────────────────────────────────────────────────
function restoreDnaAnalysisState(api) {
  try {
    const saved = localStorage.getItem('dnaAnalysisState');
    if (!saved) return;
    const state = JSON.parse(saved);
    if (Date.now() - state.timestamp > 86400000) {
      localStorage.removeItem('dnaAnalysisState');
      return;
    }
    const deepArea = document.querySelector('.deep-analysis-area-scoped');
    if (!deepArea) return;
    if (state.stage === 'topic' && state.suggestResponse && state.dnaResponse) {
      showTopicResultModal(
        state.suggestResponse, state.dnaResponse,
        state.catX, state.catY, state.groupTag || (state.isYadam ? '야담' : '경제'), state.meta,
        deepArea, api, state.spikeVideos
      );
    } else if (state.stage === 'dna' && state.dnaResponse) {
      showDnaResultModal(
        state.dnaResponse,
        state.catX, state.catY, state.groupTag || (state.isYadam ? '야담' : '경제'), state.meta,
        deepArea, api, state.spikeVideos
      );
    }
  } catch(e) {
    localStorage.removeItem('dnaAnalysisState');
  }
}

const DNA_LABELS = {
  hook_type: '훅 유형', opening_style: '오프닝 스타일', first_sentence: '첫 문장',
  first_sentence_pattern: '첫 문장 패턴', hook_technique: '훅 기법', attention_grabber: '주의 집중 요소',
  open_loop: '열린 루프', curiosity_trigger: '호기심 유발', question_type: '질문 유형',
  structure_type: '구조 유형', intro_ratio: '도입부 비중', development_ratio: '전개부 비중',
  crisis_ratio: '위기 비중', climax_ratio: '절정 비중', resolution_ratio: '결말 비중',
  twist_exists: '반전 유무', twist_position: '반전 위치', narrative_style: '서술 스타일',
  story_arc: '스토리 아크', emotion_flow: '감정 흐름', peak_emotion: '최고 감정',
  peak_position: '감정 최고점 위치', tension_curve: '긴장 곡선', emotional_range: '감정 범위',
  relief_point: '이완 지점', avg_sentence_length: '평균 문장 길이', question_frequency: '질문 빈도',
  repetition_keywords: '반복 키워드', repetition_pattern: '반복 패턴', pacing: '호흡 속도',
  pause_technique: '일시정지 기법', title_pattern: '제목 패턴', title_length: '제목 길이',
  cta_words: 'CTA 단어', click_trigger: '클릭 유발 요소', loss_aversion: '손실회피 표현',
  curiosity_gap: '호기심 갭', number_usage: '숫자 활용', type: '유형', pattern: '패턴',
  style: '스타일', technique: '기법', description: '설명', example: '예시', examples: '예시 목록',
  reason: '이유', effect: '효과', frequency: '빈도', ratio: '비율', position: '위치',
  length: '길이', count: '개수', score: '점수', level: '수준', summary: '요약',
  analysis: '분석', recommendation: '추천', keywords: '키워드', tags: '태그', notes: '비고',
  name: '이름', value: '값', title: '제목', content: '내용', text: '텍스트', items: '항목',
  list: '목록', details: '상세', characteristics: '특징', features: '특성', strengths: '강점',
  weaknesses: '약점', tips: '팁', common_pattern: '공통 패턴', unique_pattern: '고유 패턴',
  success_factor: '성공 요인', key_element: '핵심 요소', avg_length: '평균 길이',
  min_length: '최소 길이', max_length: '최대 길이', word_count: '단어 수', char_count: '글자 수'
};

// ────────────────────────────────────────────────
// DNA 시각화 전용 렌더러
// ────────────────────────────────────────────────

function renderDnaContent(dnaObj) {
  if (!dnaObj || typeof dnaObj !== 'object') {
    return '<p style="color:var(--text-muted)">DNA 데이터 없음</p>';
  }

  let html = '';

  if (dnaObj.hook_dna)      html += renderHookDna(dnaObj.hook_dna);
  if (dnaObj.structure_dna) html += renderStructureDna(dnaObj.structure_dna);
  if (dnaObj.emotion_dna)   html += renderEmotionDna(dnaObj.emotion_dna);
  if (dnaObj.pace_dna)      html += renderPaceDna(dnaObj.pace_dna);
  if (dnaObj.title_dna)     html += renderTitleDna(dnaObj.title_dna);

  return html;
}

// ─── 1. 훅 DNA ─────────────────────────────────
function renderHookDna(hook, scores) {
  const score = (scores && scores.hooking) || 0;
  const hookType = hook.hook_type || '미분류';

  const sentences = (hook.hook_sentences || []).map(function(s, i) {
    return '<div class="data-card' + (i === 0 ? ' highlight-card' : '') + ' full">' +
      '<div class="d-label"' + (i === 0 ? ' style="color:var(--gold-base)"' : '') + '>훅 문장 ' + (i + 1) + '</div>' +
      '<div class="d-value' + (i === 0 ? ' hl-text-gold' : '') + '">"' + s + '"</div>' +
    '</div>';
  }).join('');

  const loops = (hook.open_loop || []).map(function(l) {
    return '<div class="d-value" style="margin-bottom:8px;">• ' + l + '</div>';
  }).join('');

  return '' +
    '<div class="grid-2">' +
      '<div class="data-card">' +
        '<div class="d-label">훅 강도</div>' +
        '<div class="giant-number green">' + score + '<span class="unit">/ 100</span></div>' +
      '</div>' +
      '<div class="data-card">' +
        '<div class="d-label">훅 유형</div>' +
        '<div class="d-value"><span class="hl-text">' + hookType + '</span></div>' +
      '</div>' +
      sentences +
      '<div class="data-card full">' +
        '<div class="d-label">열린 루프 (Open Loop)</div>' +
        loops +
      '</div>' +
    '</div>';
}

// ─── 2. 구조 DNA ────────────────────────────────
function renderStructureDna(struct, scores) {
  const structType = struct.structure_type || '미분류';
  const climax = struct.climax_position || 0;
  const sections = struct.sections || [];
  const payoff = struct.payoff_type || '미분류';

  const timelineHtml = sections.map(function(s) {
    const isClimax = s.name.includes('반전') || s.name.includes('클라이맥스') || s.name.includes('절정') || s.name.includes('위기');
    const cls = isClimax ? ' highlight-step' : '';
    const titleCls = isClimax ? ' gold' : '';
    const pctStyle = isClimax ? ' style="background:var(--gold-base);color:#000;"' : '';
    return '' +
      '<div class="tl-item' + cls + '">' +
        '<div class="d-value">' +
          '<span class="tl-title' + titleCls + '">' + s.name + '</span> ' +
          (s.goal || '') +
          (s.key_question ? ' — ' + s.key_question : '') +
          ' <span class="tl-pct"' + pctStyle + '>' + s.duration_pct + '%</span>' +
        '</div>' +
      '</div>';
  }).join('');

  return '' +
    '<div class="grid-2">' +
      '<div class="data-card">' +
        '<div class="d-label">구조 유형</div>' +
        '<div class="d-value hl-title">' + structType + '</div>' +
      '</div>' +
      '<div class="data-card highlight-card">' +
        '<div class="d-label" style="color:var(--gold-base)">클라이맥스 위치</div>' +
        '<div class="giant-number gold">' + climax + '%<span class="unit">지점</span></div>' +
      '</div>' +
      '<div class="data-card full">' +
        '<div class="d-label">구조 흐름</div>' +
        '<div class="timeline">' + timelineHtml + '</div>' +
      '</div>' +
      '<div class="data-card full">' +
        '<div class="d-label">결말 유형</div>' +
        '<div class="tag-list"><span class="tag">' + payoff + '</span></div>' +
      '</div>' +
    '</div>';
}

// ─── 3. 감정 DNA ────────────────────────────────
function renderEmotionDna(emotion, scores) {
  const curve = emotion.emotion_curve || [];
  const nodes = buildEmotionNodes(curve);

  let flowHtml = '';
  nodes.forEach(function(n, i) {
    const nodeClass = n.type === 'highlight' ? 'node-highlight'
                    : n.type === 'positive'  ? 'node-positive'
                    : n.type === 'neutral'   ? 'node-neutral'
                    : 'node-negative';
    flowHtml += '<div class="e-node ' + nodeClass + '">' +
                  '<div class="e-dot"></div>' +
                  '<div class="e-label">' + n.label + '</div>' +
                '</div>';
    if (i < nodes.length - 1) {
      const nextType = nodes[i + 1].type;
      const lineClass = (nextType === 'highlight' || nextType === 'positive') ? 'e-line line-active' : 'e-line';
      flowHtml += '<div class="' + lineClass + '"></div>';
    }
  });

  const peakHtml = (emotion.peak_points || []).map(function(p) {
    return '<div class="d-value" style="margin-bottom:6px;">🔺 ' + p + '</div>';
  }).join('');

  const dropHtml = (emotion.drop_points || []).map(function(p) {
    return '<div class="d-value" style="margin-bottom:6px;">🔻 ' + p + '</div>';
  }).join('');

  return '' +
    '<div class="grid-2">' +
      '<div class="data-card full">' +
        '<div class="d-label">감정 흐름 플로우</div>' +
        '<div class="emotion-path">' + (flowHtml || '<span style="color:#9aa1b3">데이터 없음</span>') + '</div>' +
      '</div>' +
      '<div class="data-card highlight-card-blue">' +
        '<div class="d-label" style="color:#60a5fa">최고점 (Peak Points)</div>' +
        (peakHtml || '<div class="d-value" style="color:#9aa1b3">데이터 없음</div>') +
      '</div>' +
      '<div class="data-card">' +
        '<div class="d-label">최하점 (Drop Points)</div>' +
        (dropHtml || '<div class="d-value" style="color:#9aa1b3">데이터 없음</div>') +
      '</div>' +
    '</div>';
}

// ─── 4. 페이스 DNA ────────────────────────────────
function renderPaceDna(pace, scores) {
  const avg = pace.sentence_length_avg || 0;
  const ratio = Math.round((pace.short_sentence_ratio || 0) * 100);
  const qFreq = pace.question_frequency || 0;
  const pattern = buildBreathingPattern(pace);
  const patternParts = pattern.split('·');
  const speed = patternParts[0].trim();
  const style = (patternParts[1] || '').trim();

  const keywords = (pace.repetition_keywords || []);
  const keywordsHtml = keywords.map(function(k, i) {
    const isLast = (i === keywords.length - 1) && keywords.length > 1;
    return isLast
      ? '<span class="tag" style="background:var(--gold-base);color:#111;">' + k + '</span>'
      : '<span class="tag">' + k + '</span>';
  }).join('');

  const taboos = (pace.taboo_flags || []).map(function(t) {
    return '<span class="tag" style="border-color:#ef4444;color:#ef4444;background:rgba(239,68,68,0.08);">' + icons.warning() + ' ' + t + '</span>';
  }).join('');

  return '' +
    '<div class="grid-2">' +
      '<div class="data-card">' +
        '<div class="d-label">평균 문장 길이</div>' +
        '<div class="giant-number blue">' + avg + '<span class="unit">자</span></div>' +
      '</div>' +
      '<div class="data-card">' +
        '<div class="d-label">짧은 문장 비율</div>' +
        '<div class="giant-number blue">' + ratio + '<span class="unit">%</span></div>' +
      '</div>' +
      '<div class="data-card">' +
        '<div class="d-label">질문 빈도</div>' +
        '<div class="giant-number blue">' + qFreq + '<span class="unit">회 / 분</span></div>' +
      '</div>' +
      '<div class="data-card">' +
        '<div class="d-label">호흡 패턴</div>' +
        '<div class="d-value" style="font-size:19px;"><span class="hl-text">' + speed + '</span>' + (style ? ' · ' + style : '') + '</div>' +
      '</div>' +
      '<div class="data-card full highlight-card">' +
        '<div class="d-label" style="color:var(--gold-base)">핵심 반복 키워드</div>' +
        '<div class="tag-list">' + (keywordsHtml || '<span style="color:#9aa1b3">데이터 없음</span>') + '</div>' +
      '</div>' +
      (taboos ? '<div class="data-card full"><div class="d-label">금기 요소 (자극 포인트)</div><div class="tag-list">' + taboos + '</div></div>' : '') +
    '</div>';
}

// ─── 5. 제목 DNA ────────────────────────────────
function renderTitleDna(title, scores, videoTitle) {
  const pattern = title.title_pattern || '미분류';
  const thumbText = title.thumbnail_text_pattern || '없음';
  const titleLen = (videoTitle || '').length || 0;
  const lenColor = (titleLen >= 15 && titleLen <= 35) ? 'green' : 'blue';
  const lenNote = titleLen === 0 ? '' : titleLen > 35 ? ' (길음)' : titleLen < 15 ? ' (짧음)' : ' (적정)';

  const cta = (title.cta_words || []).map(function(w) {
    return '<span class="tag" style="border-color:#60a5fa;color:#60a5fa;background:transparent;">' + w + '</span>';
  }).join('');

  return '' +
    '<div class="grid-2">' +
      '<div class="data-card full">' +
        '<div class="d-label">분석 대상 제목</div>' +
        '<div class="d-value" style="font-size:20px;font-weight:800;color:#fff;">' + (videoTitle || '제목 없음') + '</div>' +
      '</div>' +
      '<div class="data-card">' +
        '<div class="d-label">제목 패턴</div>' +
        '<div class="d-value hl-title"><span style="color:#4ade80">' + pattern + '</span></div>' +
      '</div>' +
      '<div class="data-card">' +
        '<div class="d-label">제목 길이</div>' +
        '<div class="giant-number ' + lenColor + '">' + (titleLen || '—') + (titleLen ? '<span class="unit">자' + lenNote + '</span>' : '') + '</div>' +
      '</div>' +
      '<div class="data-card highlight-card full">' +
        '<div class="d-label" style="color:var(--gold-base)">썸네일 텍스트 추천</div>' +
        '<div class="d-value hl-text-gold" style="font-size:22px;">"' + thumbText + '"</div>' +
      '</div>' +
      '<div class="data-card full">' +
        '<div class="d-label">클릭 유도(CTA) 키워드</div>' +
        '<div class="tag-list">' + (cta || '<span style="color:#9aa1b3">데이터 없음</span>') + '</div>' +
      '</div>' +
    '</div>';
}

// ══════════════════════════════════════════════
// 6단계: DNA 리포트 모달 — Premium Dark Glass v2
// ══════════════════════════════════════════════

function getScoreColor(val) {
  if (val >= 80) return 'green';
  if (val >= 60) return 'yellow';
  return 'red';
}

function getSpikeGrade(ratio) {
  if (ratio >= 500) return '초대박';
  if (ratio >= 300) return '대박';
  if (ratio >= 150) return '떡상';
  if (ratio >= 80) return '선방';
  if (ratio >= 50) return '보통';
  return '';
}

function getSpikeGradeClass(ratio) {
  if (ratio >= 500) return 'spike-grade-super';
  if (ratio >= 300) return 'spike-grade-great';
  if (ratio >= 150) return 'spike-grade-good';
  return '';
}

function getScoreColorClass(score) {
  if (score >= 80) return 'score-green';
  if (score >= 60) return 'score-yellow';
  return 'score-red';
}

function getTotalGradeClass(avg) {
  if (avg >= 80) return 'total-high';
  if (avg >= 60) return 'total-mid';
  return 'total-low';
}

function formatRelativeDate(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const pub = new Date(dateStr);
  const diffMs = now - pub;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return '오늘';
  if (diffDays === 1) return '어제';
  if (diffDays < 30) return diffDays + '일 전';
  if (diffDays < 365) return Math.floor(diffDays / 30) + '개월 전';
  return Math.floor(diffDays / 365) + '년 전';
}

function buildBreathingPattern(pace) {
  const ratio = Math.round((pace.short_sentence_ratio || 0) * 100);
  const avg = pace.sentence_length_avg || 0;
  const qFreq = pace.question_frequency || 0;
  const speed = (ratio >= 50 || avg <= 15) ? '빠른 전개' : '느린 전개';
  const style = qFreq >= 4 ? '강한 질문형' : '서사형';
  return speed + ' · ' + style;
}

function buildEmotionNodes(curve) {
  const emotionMeta = {
    tension: { label: '긴장', type: 'negative' },
    anxiety: { label: '불안', type: 'negative' },
    hope:    { label: '희망', type: 'neutral' },
    anger:   { label: '분노', type: 'negative' },
    relief:  { label: '안도', type: 'positive' }
  };
  const emos = ['tension','anxiety','hope','anger','relief'];
  if (!curve || !curve.length) return [];

  const raw = curve.map(function(p) {
    const dominant = emos.reduce(function(a, b) { return (p[a]||0) > (p[b]||0) ? a : b; });
    const maxVal = p[dominant] || 0;
    const meta = emotionMeta[dominant];
    return { label: meta.label, type: meta.type, value: maxVal, key: dominant };
  });

  // 인접 중복 제거
  const nodes = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].key !== raw[i-1].key) nodes.push(raw[i]);
  }

  // 가장 높은 값을 가진 노드를 highlight
  let maxIdx = 0;
  nodes.forEach(function(n, i) { if (n.value > nodes[maxIdx].value) maxIdx = i; });
  nodes[maxIdx] = Object.assign({}, nodes[maxIdx], { type: 'highlight' });

  return nodes;
}

function getScoreHex(val) {
  if (val >= 80) return '#5ec4a0';
  if (val >= 60) return '#d4a84b';
  return '#d4716a';
}

function getGradeText(val) {
  if (val >= 90) return '최우수';
  if (val >= 80) return '우수';
  if (val >= 70) return '양호';
  if (val >= 60) return '보통';
  return '미흡';
}

function formatViewCount(count) {
  if (!count) return '0';
  const num = parseInt(count, 10);
  if (num >= 10000) return (num / 10000).toFixed(1) + '만';
  if (num >= 1000) return (num / 1000).toFixed(1) + '천';
  return num.toLocaleString();
}

function formatDuration(seconds) {
  if (!seconds) return '0초';
  const s = parseInt(seconds, 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + '시간 ' + m + '분 ' + sec + '초';
  if (m > 0) return m + '분 ' + sec + '초';
  return sec + '초';
}

function renderScoresSection(scores) {
  if (!scores) return '';
  const overall = scores.overall || 0;
  const grade = getGradeText(overall);

  const items = [
    { label: '후킹력', icon: icons.film(), key: 'hooking' },
    { label: '구조력', icon: icons.ruler(), key: 'structure' },
    { label: '감정력', icon: icons.heart(), key: 'emotion' },
    { label: '몰입도', icon: icons.bolt(), key: 'immersion' },
    { label: '제목력', icon: icons.tag(), key: 'title' }
  ];

  let maxVal = 0;
  items.forEach(item => {
    const v = scores[item.key] || 0;
    if (v > maxVal) maxVal = v;
  });

  const cardsHtml = items.map(item => {
    const v = scores[item.key] || 0;
    let cardClass = 'dna-cyber-card';
    if (v === maxVal && v >= 80) cardClass += ' highlight';
    else if (v < 70) cardClass += ' warn';
    else if (v < 80 && v >= 70) cardClass += ' caution';
    return `
      <div class="${cardClass}">
        <span class="dna-cyber-icon">${item.icon}</span>
        <div class="dna-cyber-label">${item.label}</div>
        <div class="dna-cyber-num">${v}</div>
        <div class="dna-cyber-bar">
          <div class="dna-cyber-bar-fill" style="width:${v}%"></div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="dna-section-divider">
      <div class="divider-icon" style="background:rgba(0,240,255,0.1)">${icons.chart()}</div>
      <h3>종합 점수</h3>
      <div class="divider-line"></div>
    </div>
    <div class="dna-cyber-box">
      <div class="dna-cyber-total">
        <div class="dna-cyber-total-label">종합 점수</div>
        <div class="dna-cyber-total-num">${overall}</div>
        <div class="dna-cyber-total-grade">${grade}</div>
      </div>
      <div class="dna-cyber-divider"></div>
      <div class="dna-cyber-grid">
        ${cardsHtml}
      </div>
    </div>
  `;
}

function renderSuccessSection(summary) {
  if (!summary) return '';
  return `
    <div class="dna-section-divider">
      <div class="divider-icon" style="background:rgba(155,126,216,0.1)">${icons.idea()}</div>
      <h3>이 영상이 떡상한 이유</h3>
      <div class="divider-line"></div>
    </div>
    <div class="dna-success-section">
      <div class="dna-success-text">${summary}</div>
    </div>
  `;
}

function renderCommentSection(commentAnalysis) {
  if (!commentAnalysis) return '';
  const { positive = [], negative = [], comment_summary = '' } = commentAnalysis;
  if (positive.length === 0 && negative.length === 0 && !comment_summary) return '';

  const summaryHtml = comment_summary
    ? `<div class="dna-comment-summary">${comment_summary}</div>`
    : '';

  const posHtml = positive.map(t => `<div class="dna-comment-item">${t}</div>`).join('');
  const negHtml = negative.map(t => `<div class="dna-comment-item">${t}</div>`).join('');

  return `
    <div class="dna-section-divider">
      <div class="divider-icon" style="background:rgba(107,163,214,0.1)">${icons.comment(18)}</div>
      <h3>댓글 분석</h3>
      <div class="divider-line"></div>
    </div>
    <div class="dna-comment-section">
      ${summaryHtml}
      <div class="dna-comment-grid">
        <div class="dna-comment-col positive">
          <div class="dna-comment-col-title">${icons.thumbsUp(14)} 긍정 반응</div>
          ${posHtml || '<div class="dna-comment-item">긍정 반응 데이터가 없습니다</div>'}
        </div>
        <div class="dna-comment-col negative">
          <div class="dna-comment-col-title">👎 부정 반응</div>
          ${negHtml || '<div class="dna-comment-item">부정 반응 데이터가 없습니다</div>'}
        </div>
      </div>
    </div>
  `;
}

function renderDnaTabs(scores, dna, videoTitle) {
  const tabItems = [
    { id: 'dna-tab-1', icon: icons.film(), label: '후킹 DNA',  scoreKey: 'hooking',
      panelHeader: icons.film() + ' 후킹 DNA 분석',
      render: function() { return renderHookDna(dna.hook_dna || {}, scores); } },
    { id: 'dna-tab-2', icon: icons.ruler(), label: '구조 DNA',  scoreKey: 'structure',
      panelHeader: icons.ruler() + ' 구조 DNA 분석',
      render: function() { return renderStructureDna(dna.structure_dna || {}, scores); } },
    { id: 'dna-tab-3', icon: icons.heart(), label: '감정 DNA',  scoreKey: 'emotion',
      panelHeader: icons.heart() + ' 감정 DNA 분석',
      render: function() { return renderEmotionDna(dna.emotion_dna || {}, scores); } },
    { id: 'dna-tab-4', icon: icons.bolt(), label: '페이스 DNA', scoreKey: 'immersion',
      panelHeader: icons.bolt() + ' 페이스 DNA 분석',
      render: function() { return renderPaceDna(dna.pace_dna || {}, scores); } },
    { id: 'dna-tab-5', icon: icons.tag(), label: '제목 DNA',  scoreKey: 'title',
      panelHeader: icons.tag() + ' 제목 DNA 분석',
      render: function() { return renderTitleDna(dna.title_dna || {}, scores, videoTitle); } }
  ];

  const sidebarButtons = tabItems.map(function(t, i) {
    const scoreVal = (scores && scores[t.scoreKey]) || 0;
    const scoreColor = getScoreColor(scoreVal);
    return '<button class="dna-tab-btn' + (i === 0 ? ' active' : '') + '" data-tab="' + t.id + '">' +
      '<div class="dna-tab-icon-wrap"><span>' + t.icon + '</span> ' + t.label + '</div>' +
      '<span class="dna-tab-score ' + scoreColor + '">' + scoreVal + '</span>' +
    '</button>';
  }).join('');

  const panels = tabItems.map(function(t, i) {
    return '<div id="' + t.id + '" class="dna-tab-panel' + (i === 0 ? ' active' : '') + '">' +
      '<div class="dna-panel-header"><span>' + t.panelHeader + '</span></div>' +
      t.render() +
    '</div>';
  }).join('');

  return '' +
    '<div class="dna-tabs-container">' +
      '<div class="dna-sidebar">' +
        '<div class="dna-sidebar-title">DNA 상세 분석</div>' +
        sidebarButtons +
      '</div>' +
      '<div class="dna-content-area">' +
        panels +
      '</div>' +
    '</div>';
}

function showDnaResultModal(dnaResponse, catX, catY, groupTag, meta, deepArea, api, spikeVideos) {
  const { dna, sourceVideos = [], skippedVideos = [], isNewExtraction } = dnaResponse;
  const scores = dna?.scores;
  const commentAnalysis = dna?.comment_analysis;
  const successSummary = dna?.success_summary;

  // --- 분석 대상 영상 정보 ---
  const firstVideo = sourceVideos[0] || {};
  // YouTube video ID 추출 — videoId(문자열)를 우선 사용
  // video_id가 숫자(DB PK)일 수 있으므로 문자열인 경우만 사용
  const rawVideoId = firstVideo.video_id;
  const isYoutubeId = typeof rawVideoId === 'string' && rawVideoId.length >= 8;
  const videoId = firstVideo.videoId || (isYoutubeId ? rawVideoId : '') || '';
  const rawTitle = firstVideo.title || '분석 영상';
  const parsedTitle = parseTitleAndTags(rawTitle);
  const videoTitle = parsedTitle.title || rawTitle;
  const channelName = firstVideo.channelName || firstVideo.channel_name || '';
  const channelInitial = channelName ? channelName.charAt(0) : '📺';
  const channelYoutubeId = firstVideo.channelYoutubeId || firstVideo.channel_youtube_id || '';
  const channelHandle = firstVideo.channelHandle || firstVideo.channel_handle || '';
  const channelUrl = channelHandle
    ? `https://www.youtube.com/${channelHandle}`
    : channelYoutubeId
      ? `https://www.youtube.com/channel/${channelYoutubeId}`
      : '';
  const subscriberCount = firstVideo.subscriberCount || firstVideo.subscriber_count || '';
  const viewCount = firstVideo.viewCount || firstVideo.view_count || '';
  const duration = firstVideo.durationSeconds || firstVideo.duration_seconds || '';
  const spikeRatio = firstVideo.spikeRatio || firstVideo.spike_ratio || '';
  const channelAvgMultiple = firstVideo.channelAvgMultiple || firstVideo.channel_avg_multiple || '';

  // --- spikeVideos에서 추가 정보 매칭 ---
  const matchedSpike = spikeVideos?.find(sv =>
    sv.id === firstVideo.id ||
    String(sv.id) === String(firstVideo.id) ||
    sv.videoId === videoId
  );

  // spikeVideos에서 YouTube ID 보완
  const finalVideoId = videoId || matchedSpike?.videoId || '';
  const finalViewCount = viewCount || matchedSpike?.viewCount || '';
  const finalSubscriber = subscriberCount || matchedSpike?.subscriberCount || '';
  const finalDuration = duration || matchedSpike?.durationSeconds || '';
  const finalSpikeRatio = spikeRatio || matchedSpike?.spikeRatio || '';
  const finalChannelAvg = channelAvgMultiple || matchedSpike?.channelAvgMultiple || '';
  const finalLikeCount = firstVideo.likeCount || matchedSpike?.likeCount || 0;
  const pubDateStr = firstVideo.publishedAt || matchedSpike?.publishedAt || '';
  const pubRelative = formatRelativeDate(pubDateStr);
  const pubAbsolute = pubDateStr ? new Date(pubDateStr).toLocaleDateString('ko-KR') : '';
  const pubHtml = pubAbsolute
    ? `<br><span style="color:rgba(240,240,245,0.45);">DNA 분석일 - ${pubAbsolute} (${pubRelative})</span>`
    : '';

  // --- 영상 섹션 HTML ---
  const videoSectionHtml = `
    <div class="dna-video-section">
      ${finalVideoId
          ? `<div class="dna-video-player" id="dna-video-container"
                 style="position:relative;width:100%;padding-top:56.25%;border-radius:12px;overflow:hidden;background:#000;">
               <a href="https://www.youtube.com/watch?v=${finalVideoId}" target="_blank"
                  rel="noopener noreferrer" id="dna-video-fallback"
                  style="display:block;position:absolute;top:0;left:0;width:100%;height:100%;">
                 <img src="https://img.youtube.com/vi/${finalVideoId}/hqdefault.jpg"
                      style="width:100%;height:100%;object-fit:cover;"
                      onerror="this.src='https://img.youtube.com/vi/${finalVideoId}/default.jpg'">
                 <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
                             width:68px;height:48px;background:rgba(255,0,0,0.85);border-radius:12px;
                             display:flex;align-items:center;justify-content:center;">
                   <div style="width:0;height:0;border-left:20px solid #fff;
                               border-top:12px solid transparent;
                               border-bottom:12px solid transparent;margin-left:4px;"></div>
                 </div>
               </a>
             </div>`
          : `<div style="padding:40px;text-align:center;color:#888;font-size:16px;">영상을 불러올 수 없습니다</div>`
        }
      <div class="dna-video-meta">
        <div class="dna-video-title">${videoTitle}</div>
        <div class="dna-video-channel">
          <div class="dna-video-ch-icon">${channelInitial}</div>
          ${channelUrl
            ? `<a href="${channelUrl}" target="_blank" rel="noopener noreferrer"
                 style="color:#4ecdc4;text-decoration:none;transition:opacity 0.2s;"
                 onmouseover="this.style.opacity='0.7';this.style.textDecoration='underline'"
                 onmouseout="this.style.opacity='1';this.style.textDecoration='none'"
               >${channelName}</a>`
            : `<span>${channelName}</span>`
          }${finalSubscriber ? ' · 구독자 <strong>' + formatViewCount(finalSubscriber) + '</strong>' : ''}
        </div>
        <div class="dna-stat-grid">
          ${(() => {
            const sr = parseFloat(finalSpikeRatio) || 0;
            const gradeText = getSpikeGrade(sr);
            const gradeClass = getSpikeGradeClass(sr);
            const gradeHtml = gradeText
              ? `<span class="stat-grade-tag ${gradeClass}">${gradeText}</span>`
              : '';
            const viewNum = parseInt(finalViewCount) || 0;
            const likeRate = viewNum > 0
              ? ((finalLikeCount / viewNum) * 100).toFixed(1)
              : '0.0';
            const commentCount = firstVideo.commentCount || matchedSpike?.commentCount || 0;
            const commentDisplay = commentCount >= 10000
              ? (commentCount / 10000).toFixed(1) + '만'
              : commentCount >= 1000
              ? (commentCount / 1000).toFixed(1) + '천'
              : commentCount.toString();
            return `
          <div class="dna-stat-pill pill-ratio">
            <span class="stat-icon">${icons.trendUp(18)}</span>
            <div class="stat-info">
              <span class="stat-label">구독자 대비 조회</span>
              <span class="stat-value highlight-fire">${sr.toFixed(1)}배 ${gradeHtml}</span>
            </div>
          </div>
          <div class="dna-stat-pill">
            <span class="stat-icon">${icons.stopwatch(18)}</span>
            <div class="stat-info">
              <span class="stat-label">영상 길이</span>
              <span class="stat-value">${formatDuration(finalDuration)}</span>
            </div>
          </div>
          <div class="dna-stat-pill pill-like">
            <span class="stat-icon">${icons.thumbsUp(18)}</span>
            <div class="stat-info">
              <span class="stat-label">좋아요</span>
              <span class="stat-value highlight-blue">${Number(finalLikeCount).toLocaleString()}개</span>
            </div>
          </div>
          <div class="dna-stat-pill pill-comment">
            <span class="stat-icon">${icons.comment(18)}</span>
            <div class="stat-info">
              <span class="stat-label">댓글 수</span>
              <span class="stat-value">${commentDisplay}개</span>
            </div>
          </div>`;
          })()}
        </div>
        ${pubAbsolute ? `<div class="dna-analysis-date">DNA 분석일 - ${pubAbsolute} (${pubRelative})</div>` : ''}
      </div>
    </div>
  `;

  // --- DNA 상세 분석 탭 ---
  const dnaDetailHtml = `
    <div class="dna-section-divider">
      <div class="divider-icon" style="background:linear-gradient(135deg,rgba(155,126,216,0.1),rgba(107,163,214,0.1))">${icons.dna()}</div>
      <h3>DNA 상세 분석</h3>
      <div class="divider-line"></div>
    </div>
    ${renderDnaTabs(scores, dna, videoTitle)}
  `;

  // --- 오버레이 생성 ---
  const overlay = document.createElement('div');
  overlay.className = 'dna-report-overlay';
  overlay.innerHTML = `
    <div class="dna-report-modal">
      <div class="dna-report-header">
        <div class="dna-report-header-left">
          <div class="dna-report-header-icon">${icons.dna(28)}</div>
          <h2><span>DNA 분석 리포트</span></h2>
        </div>
        <button class="dna-report-close" title="닫기">${icons.close()}</button>
      </div>
      <div class="dna-report-body">
        ${videoSectionHtml}
        ${renderScoresSection(scores)}
        ${renderSuccessSection(successSummary)}
        ${renderCommentSection(commentAnalysis)}
        ${dnaDetailHtml}
      </div>
      <div class="dna-report-footer">
        <button class="dna-save-idea-btn">아이디어로 저장</button>
        <button class="dna-save-thumb-btn">썸네일 저장</button>
        <button class="dna-close-btn">닫기</button>
      </div>
    </div>
  `;

  history.pushState({ gapsView: 'dnaModal' }, '', '#/gaps');
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => overlay.classList.add('visible'));

  // oEmbed로 임베드 가능 여부 확인 후 iframe으로 교체
  if (finalVideoId) {
    const videoContainer = document.getElementById('dna-video-container');
    if (videoContainer) {
      fetch('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + finalVideoId + '&format=json')
        .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function() {
          const c = document.getElementById('dna-video-container');
          if (c) {
            c.innerHTML = '<iframe src="https://www.youtube.com/embed/' + finalVideoId + '" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" allowfullscreen></iframe>';
          }
        })
        .catch(function() {});
    }
  }

  // --- 닫기 로직 ---
  function closeReportModal() {
    overlay.classList.remove('visible');
    document.removeEventListener('keydown', escHandler);
    setTimeout(() => {
      overlay.remove();
      document.body.style.overflow = '';

      // 카드 DOM 업데이트 (hasDna 반영)
      if (sourceVideos && sourceVideos.length > 0) {
        sourceVideos.forEach(sv => {
          const vid = sv.id || sv.video_id;
          if (!vid) return;

          // spikeVideos 배열 업데이트
          if (spikeVideos) {
            const found = spikeVideos.find(s => s.id === vid || s.videoId === vid || s.video_id === vid);
            if (found) found.hasDna = true;
          }

          // DOM 카드 업데이트
          const card = document.querySelector(`.spike-video-item[data-video-id="${vid}"]`);
          if (!card) return;
          card.classList.add('spike-video-dna-done');
          card.setAttribute('data-has-dna', 'true');

          // 체크박스 영역을 DNA 보기 버튼으로 교체 (spike-video-select-area → spike-dna-area)
          const selectArea = card.querySelector('.spike-video-select-area');
          if (selectArea) {
            const overallScore = dnaResponse?.dna?.scores?.overall;
            const scoreHtml = overallScore != null ? `<span class="spike-dna-score">${Math.round(overallScore)}점</span>` : '';
            selectArea.outerHTML = `<div class="spike-dna-area">${scoreHtml}<button class="spike-dna-view-btn" data-video-id="${vid}">${icons.dna()} DNA 보기</button></div>`;
          }

          // 배지 추가
          const titleRow = card.querySelector('.spike-video-title-row') || card.querySelector('.spike-video-title');
          if (titleRow && !card.querySelector('.spike-dna-badge')) {
            const badge = document.createElement('span');
            badge.className = 'spike-dna-badge';
            badge.innerHTML = `${icons.success()} DNA 추출 완료`;
            titleRow.appendChild(badge);
          }

          // DNA 보기 버튼 이벤트 바인딩
          const newBtn = card.querySelector('.spike-dna-view-btn');
          if (newBtn && !newBtn.getAttribute('data-bound')) {
            newBtn.setAttribute('data-bound', 'true');
            newBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const videoId = parseInt(newBtn.dataset.videoId, 10);
              newBtn.disabled = true;
              newBtn.textContent = '불러오는 중...';
              try {
                const dnaRes = await api.getDnaByVideoId(videoId);
                showDnaResultModal(dnaRes, catX, catY, groupTag, meta, deepArea, api, spikeVideos);
              } catch (err) {
                showToast('DNA 데이터를 불러올 수 없습니다');
              } finally {
                newBtn.disabled = false;
                newBtn.innerHTML = `${icons.dna()} DNA 보기`;
              }
            });
          }
        });
      }
    }, 350);
  }

  window.__gapsDnaClose = closeReportModal;

  // localStorage 저장
  try {
    localStorage.setItem('dnaAnalysisState', JSON.stringify({
      catX, catY, groupTag,
      timestamp: Date.now()
    }));
  } catch (e) { /* ignore */ }

  // 닫기 이벤트
  overlay.querySelector('.dna-report-close').addEventListener('click', closeReportModal);
  overlay.querySelector('.dna-close-btn').addEventListener('click', closeReportModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeReportModal();
  });

  // 저장 버튼 참조 + 기존 저장 상태 복원
  const ideaBtn = overlay.querySelector('.dna-save-idea-btn');
  const thumbBtn = overlay.querySelector('.dna-save-thumb-btn');
  if (videoId) {
    (async () => {
      try {
        const saved = await api.request(`/ideas/check/${encodeURIComponent(videoId)}`);
        if (saved.idea) {
          ideaBtn.textContent = '✓ 아이디어 저장됨';
          ideaBtn.classList.add('saved');
          ideaBtn.disabled = true;
        }
        if (saved.thumbnail) {
          thumbBtn.textContent = '✓ 썸네일 저장됨';
          thumbBtn.classList.add('saved');
          thumbBtn.disabled = true;
        }
      } catch (e) {}
    })();
  }

  // 아이디어로 저장 버튼
  overlay.querySelector('.dna-save-idea-btn')?.addEventListener('click', () => {
    const ideaBtn = overlay.querySelector('.dna-save-idea-btn');
    const sv = dnaResponse.sourceVideos || [];
    const firstVideo = sv[0] || {};
    const vTitle = firstVideo.title || '';
    const vChannel = firstVideo.channelName || firstVideo.channel_name || '';
    const vVideoId = firstVideo.videoId || firstVideo.video_id || '';
    const vThumb = firstVideo.thumbnailUrl
      || (vVideoId ? `https://i.ytimg.com/vi/${vVideoId}/mqdefault.jpg` : '');
    const dna = dnaResponse.dna || {};

    const memoOverlay = document.createElement('div');
    memoOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:100001;display:flex;align-items:center;justify-content:center;';
    memoOverlay.innerHTML = `
      <div style="background:#1e1e2e;border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:24px;width:480px;max-width:90vw;">
        <h3 style="color:#fff;margin:0 0 16px;font-size:16px;">💡 아이디어 메모</h3>
        <p style="color:#94a3b8;font-size:14px;margin:0 0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${vTitle}</p>
        <textarea id="dna-idea-memo" rows="4"
          style="width:100%;background:#12121e;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:12px;font-size:15px;resize:vertical;box-sizing:border-box;font-family:inherit;"
          placeholder="이 영상에 대한 메모를 입력하세요..."></textarea>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button id="dna-memo-cancel" style="padding:10px 20px;background:rgba(255,255,255,0.08);color:#94a3b8;border:1px solid rgba(255,255,255,0.15);border-radius:8px;cursor:pointer;font-size:14px;font-family:inherit;">취소</button>
          <button id="dna-memo-save" style="padding:10px 20px;background:rgba(59,130,246,0.2);color:#60a5fa;border:1px solid rgba(59,130,246,0.4);border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;font-family:inherit;">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(memoOverlay);

    memoOverlay.querySelector('#dna-memo-cancel').addEventListener('click', () => {
      memoOverlay.remove();
    });

    memoOverlay.querySelector('#dna-memo-save').addEventListener('click', async () => {
      const memo = memoOverlay.querySelector('#dna-idea-memo').value.trim();
      const saveBtn = memoOverlay.querySelector('#dna-memo-save');
      saveBtn.textContent = '저장 중...';
      saveBtn.disabled = true;
      try {
        const spikeInfo = (spikeVideos || []).find(
          sv => sv.id === vVideoId || sv.video_id === vVideoId || sv.videoId === vVideoId
        ) || {};
        await api.request('/ideas', {
          method: 'POST',
          body: {
            title: vTitle,
            description: memo,
            category: groupTag || '',
            idea_type: 'dna',
            source_video_id: vVideoId,
            source_video_title: vTitle,
            source_channel_name: vChannel,
            source_thumbnail_url: vThumb,
            dna_score: dna.scores?.overall || 0,
            dna_summary: dna.success_summary || '',
            save_type: 'idea',
            video_id: vVideoId,
            view_count: spikeInfo.viewCount || spikeInfo.view_count || 0,
            subscriber_count: spikeInfo.subscriberCount || spikeInfo.subscriber_count || 0,
            duration_seconds: spikeInfo.durationSeconds || spikeInfo.duration_seconds || 0,
            spike_ratio: spikeInfo.spikeRatio || spikeInfo.spike_ratio || 0,
            spike_grade: spikeInfo.spikeGrade || spikeInfo.spike_grade || ''
          }
        });
        memoOverlay.remove();
        ideaBtn.textContent = '✓ 아이디어 저장됨';
        ideaBtn.classList.add('saved');
        ideaBtn.disabled = true;
      } catch {
        saveBtn.textContent = '❌ 실패 - 다시 시도';
        saveBtn.disabled = false;
      }
    });
  });

  // 썸네일 저장 버튼
  overlay.querySelector('.dna-save-thumb-btn')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('.dna-save-thumb-btn');
    btn.disabled = true;
    btn.textContent = '저장 중...';
    try {
      const sv = dnaResponse.sourceVideos || [];
      const firstVideo = sv[0] || {};
      const vTitle = firstVideo.title || '';
      const vChannel = firstVideo.channelName || firstVideo.channel_name || '';
      const vVideoId = firstVideo.videoId || firstVideo.video_id || '';
      const vThumb = firstVideo.thumbnailUrl
        || (vVideoId ? `https://i.ytimg.com/vi/${vVideoId}/mqdefault.jpg` : '');
      const dna = dnaResponse.dna || {};

      const spikeInfo = (spikeVideos || []).find(
        sv => sv.id === vVideoId || sv.video_id === vVideoId || sv.videoId === vVideoId
      ) || {};
      await api.request('/ideas', {
        method: 'POST',
        body: {
          title: vTitle + ' - 썸네일',
          description: '',
          category: groupTag || '',
          idea_type: 'dna',
          source_video_id: vVideoId,
          source_video_title: vTitle,
          source_channel_name: vChannel,
          source_thumbnail_url: vThumb,
          dna_score: dna.scores?.overall || 0,
          dna_summary: '',
          save_type: 'thumbnail',
          video_id: vVideoId,
          view_count: spikeInfo.viewCount || spikeInfo.view_count || 0,
          subscriber_count: spikeInfo.subscriberCount || spikeInfo.subscriber_count || 0,
          duration_seconds: spikeInfo.durationSeconds || spikeInfo.duration_seconds || 0,
          spike_ratio: spikeInfo.spikeRatio || spikeInfo.spike_ratio || 0,
          spike_grade: spikeInfo.spikeGrade || spikeInfo.spike_grade || ''
        }
      });
      btn.textContent = '✓ 썸네일 저장됨';
      btn.classList.add('saved');
      btn.disabled = true;
    } catch(e) {
      btn.textContent = '저장 실패';
      setTimeout(() => { btn.textContent = '썸네일 저장'; btn.disabled = false; }, 2000);
    }
  });

  // ESC
  function escHandler(e) {
    if (e.key === 'Escape') closeReportModal();
  }
  document.addEventListener('keydown', escHandler);

  // DNA 탭 전환 이벤트
  overlay.querySelectorAll('.dna-tab-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const tabId = this.dataset.tab;
      overlay.querySelectorAll('.dna-tab-btn').forEach(b => b.classList.remove('active'));
      overlay.querySelectorAll('.dna-tab-panel').forEach(p => p.classList.remove('active'));
      this.classList.add('active');
      const targetPanel = overlay.querySelector('#' + tabId);
      if (targetPanel) targetPanel.classList.add('active');
      // 콘텐츠 스크롤 위치 초기화
      const contentArea = overlay.querySelector('.dna-content-area');
      if (contentArea) contentArea.scrollTop = 0;
    });
  });

}


// ── 3차 모달: 주제 추천 결과 ─────────────────────────────────────────────────
function showTopicResultModal(suggestResponse, dnaResponse, catX, catY, groupTag, meta, deepArea, api, spikeVideos) {
  const { suggestions = [], existingVideoCount = 0 } = suggestResponse;
  const container = deepArea.querySelector('.chart-container');
  if (!container) return;

  function fmtN(n) { return n ? Number(n).toLocaleString('ko-KR') : '0'; }

  const suggestionItemsHtml = suggestions.map((s, i) => `
    <div class="topic-suggestion-item" data-index="${i}" data-title="${(s.title || '').replace(/"/g, '&quot;')}"
         data-yadam="${groupTag === '야담' ? 'true' : 'false'}">
      <div class="topic-suggestion-rank">TOP ${i + 1}</div>
      <div class="topic-suggestion-body">
        <div class="topic-suggestion-title">${s.title || ''}</div>
        <div class="topic-suggestion-gap">
          <span class="topic-gap-label">차별화</span>
          <div class="topic-gap-bar">
            <div class="topic-gap-fill" style="width:${s.gap_rate || 0}%"></div>
          </div>
          <span class="topic-gap-value">${s.gap_rate || 0}%</span>
        </div>
        <div class="topic-suggestion-keywords">
          ${(s.keywords || []).map(kw => `<span class="topic-keyword-tag">#${kw}</span>`).join('')}
        </div>
        <div class="topic-suggestion-reason">${s.reason || ''}</div>
      </div>
      <div class="topic-suggestion-expand-icon">▶</div>
      <div class="topic-expand-area" style="display:none;"></div>
    </div>
  `).join('');

  const sourceVideosHtml = (dnaResponse.sourceVideos || []).map(v =>
    `<a href="https://www.youtube.com/watch?v=${v.videoId}" target="_blank" rel="noopener noreferrer" class="topic-evidence-link">${v.title}</a>`
  ).join('');

  const spikeEvidenceHtml = (spikeVideos || []).map(v =>
    `<span class="topic-evidence-spike">${v.title} (${fmtN(v.viewCount)}회)</span>`
  ).join('');

  container.innerHTML = `
    <div class="topic-result-container">
      <div class="dna-back-btn-area dna-back-btn-top">
        <button class="dna-back-btn" id="topic-back-top">
          ← 떡상 영상 TOP 10으로 돌아가기
        </button>
      </div>

      <div class="topic-result-header">
        <div class="topic-result-title-row">
          <h3>✨ 추천 주제 TOP ${suggestions.length}</h3>
          <button class="spike-btn-close topic-close-btn">닫기</button>
        </div>
        <p class="topic-result-subtitle">
          기존 ${fmtN(existingVideoCount)}개 영상과 겹치지 않는 틈새 주제 | DNA 기반 SEO 최적화 제목
        </p>
      </div>

      <div class="topic-suggestion-list" id="topic-suggestion-list">
        ${suggestionItemsHtml}
      </div>

      <div class="topic-evidence-section">
        <h4 class="dna-section-title">📌 분석 근거</h4>
        <div class="topic-evidence-group">
          <span class="topic-evidence-label">DNA 추출 영상:</span>
          ${sourceVideosHtml}
        </div>
        <div class="topic-evidence-group">
          <span class="topic-evidence-label">떡상 영상 벤치마크:</span>
          <div class="topic-evidence-spike-list">${spikeEvidenceHtml}</div>
        </div>
      </div>

      <div class="dna-back-btn-area dna-back-btn-bottom">
        <button class="dna-back-btn" id="topic-back-bottom">
          ← 떡상 영상 TOP 10으로 돌아가기
        </button>
      </div>
    </div>
  `;

  try {
    localStorage.setItem('dnaAnalysisState', JSON.stringify({
      stage: 'topic',
      suggestResponse,
      dnaResponse,
      catX, catY, groupTag, meta,
      spikeVideos,
      timestamp: Date.now()
    }));
  } catch(e) {}

  container.querySelector('.topic-close-btn').addEventListener('click', () => {
    window.__activeDeepAnalysis = null;
    localStorage.removeItem('dnaAnalysisState');
    deepArea.querySelector('.chart-container')?.remove();
  });

  // ── 뒤로가기 버튼 (상단 + 하단) ──
  const topicBackHandler = () => {
    showSpikeVideoModal(catX, catY, groupTag, meta, deepArea, api);
  };
  const topicBackTop = document.getElementById('topic-back-top');
  const topicBackBottom = document.getElementById('topic-back-bottom');
  if (topicBackTop) topicBackTop.addEventListener('click', topicBackHandler);
  if (topicBackBottom) {
    topicBackBottom.addEventListener('click', () => {
      topicBackHandler();
      requestAnimationFrame(() => {
        const modalTop = document.querySelector('.spike-modal-container')
                      || document.querySelector('.chart-container');
        if (modalTop) modalTop.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  attachNewSuggestionEvents(container, api, dnaResponse, catX, groupTag);
}

// ── 3차 모달 이벤트 바인딩 ────────────────────────────────────────────────────
function attachNewSuggestionEvents(container, api, dnaResponse, catX, groupTag) {
  const dna = dnaResponse.dna;
  const category = groupTag;

  container.querySelectorAll('.topic-suggestion-item').forEach(item => {
    // 카드 클릭 이벤트 (헤더 영역만 — expand-area 내부 클릭은 전파 차단)
    item.addEventListener('click', (e) => {
      if (e.target.closest('.topic-expand-area')) return;

      const expandArea = item.querySelector('.topic-expand-area');
      const expandIcon = item.querySelector('.topic-suggestion-expand-icon');
      const isOpen = expandArea.style.display !== 'none';

      // 다른 카드 접기
      container.querySelectorAll('.topic-suggestion-item').forEach(other => {
        if (other !== item) {
          other.querySelector('.topic-expand-area').style.display = 'none';
          other.querySelector('.topic-suggestion-expand-icon').textContent = '▶';
          other.classList.remove('expanded');
        }
      });

      if (isOpen) {
        expandArea.style.display = 'none';
        expandIcon.textContent = '▶';
        item.classList.remove('expanded');
        return;
      }

      expandArea.style.display = 'block';
      expandIcon.textContent = '▼';
      item.classList.add('expanded');

      // 이미 로드된 경우 토글만
      if (expandArea.dataset.loaded === 'true') return;

      const topicTitle = item.dataset.title;

      expandArea.innerHTML = `
        <div class="topic-expand-content">
          <div class="topic-dna-summary">
            🧬 저장된 DNA를 활용합니다 (추가 AI 호출 없음)
          </div>
          <button class="topic-title-gen-btn">🎯 후킹 제목 10종 생성하기</button>
          <div class="topic-title-result"></div>
        </div>
      `;

      const titleGenBtn = expandArea.querySelector('.topic-title-gen-btn');
      const titleResult = expandArea.querySelector('.topic-title-result');

      const doFetchTitles = async () => {
        titleGenBtn.disabled = true;
        titleGenBtn.textContent = '⏳ 제목 생성 중...';
        titleResult.innerHTML = `<div style="padding:16px; text-align:center;"><div class="spike-loading-spinner" style="width:24px;height:24px;"></div></div>`;

        try {
          const kwRes = await api.extractGoldenKeywords(dna);
          const tRes = await api.recommendDnaTitles(dna, kwRes, category, topicTitle);
          const titles = tRes.titles || [];

          const itemIdx = item.dataset.index;

          titleResult.innerHTML = `
            <div class="topic-titles-list">
              <p class="topic-titles-guide">제목을 선택하세요</p>
              ${titles.map(t => `
                <label class="topic-title-radio-item">
                  <input type="radio" name="topic-title-${itemIdx}" value="${(t.title || '').replace(/"/g, '&quot;')}">
                  <div class="topic-title-radio-content">
                    <span class="topic-title-text">${t.title || ''}</span>
                    <span class="topic-title-score">CTR ${t.ctr_score || 0}점</span>
                    <span class="topic-title-reason">${t.reason || ''}</span>
                  </div>
                </label>
              `).join('')}
              <div style="display:flex; gap:8px; margin-top:10px;">
                <button class="topic-titles-refresh-btn">🔄 다시 추천</button>
              </div>
            </div>
          `;

          const refreshBtn = titleResult.querySelector('.topic-titles-refresh-btn');

          // 라디오 선택 이벤트
          titleResult.querySelectorAll(`input[name="topic-title-${itemIdx}"]`).forEach(radio => {
            radio.addEventListener('change', () => {
              titleResult.querySelectorAll('.topic-title-radio-item').forEach(lbl => lbl.classList.remove('selected'));
              radio.closest('.topic-title-radio-item')?.classList.add('selected');
            });
          });

          // 다시 추천
          refreshBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            titleGenBtn.textContent = '🎯 후킹 제목 10종 생성하기';
            doFetchTitles();
          });

          titleGenBtn.innerHTML = `${icons.success(14)} 제목 추천 완료`;
          expandArea.dataset.loaded = 'true';

        } catch (err) {
          titleGenBtn.disabled = false;
          titleGenBtn.textContent = '🎯 후킹 제목 10종 생성하기';
          titleResult.innerHTML = `
            <div style="padding:12px; color:var(--danger); font-size:0.85rem;">
              ❌ 실패: ${err.message}
              <button class="topic-title-gen-btn" style="display:block; margin-top:8px;">다시 시도</button>
            </div>
          `;
          titleResult.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); doFetchTitles(); });
        }
      };

      titleGenBtn.addEventListener('click', (e) => { e.stopPropagation(); doFetchTitles(); });
    });
  });
}

// ── 제목/해시태그 파서 ────────────────────────────────────────────────────────
function parseTitleAndTags(fullTitle) {
  if (!fullTitle) return { title: '', tags: [] };

  const pipeIndex = fullTitle.indexOf('|');
  const hashIndex = fullTitle.indexOf('#');

  let titlePart = fullTitle;
  let tagsPart = '';

  if (pipeIndex > 0 && (hashIndex < 0 || pipeIndex < hashIndex)) {
    titlePart = fullTitle.substring(0, pipeIndex).trim();
    tagsPart = fullTitle.substring(pipeIndex + 1).trim();
  } else if (hashIndex > 0) {
    titlePart = fullTitle.substring(0, hashIndex).trim();
    tagsPart = fullTitle.substring(hashIndex).trim();
  }

  titlePart = titlePart.replace(/[\s|ㅣ]+$/, '').trim();

  const tags = [];
  const tagMatches = tagsPart.match(/#[^\s#]+/g);
  if (tagMatches) {
    tagMatches.forEach(t => {
      const clean = t.replace(/^#/, '').trim();
      if (clean) tags.push(clean);
    });
  }

  return { title: titlePart, tags };
}

// ── 1차 떡상 영상 선택 모달 ──────────────────────────────────────────────────
// ── 1차 떡상 영상 선택 모달 ──────────────────────────────────────────────────
export async function showSpikeVideoModal(catX, catY, groupTag, meta, deepArea, api, materialsForTabs) {
  if (Array.isArray(materialsForTabs) && materialsForTabs.length > 0) {
    _saturationMaterialsCache = materialsForTabs;
  }

  history.pushState({ gapsView: 'spikeModal' }, '', '#/gaps');

  // ── 유틸 함수 ──
  function fmt(n) {
    if (n == null) return '-';
    if (n >= 10000) return (n / 10000).toFixed(1) + '만';
    if (n >= 1000)  return (n / 1000).toFixed(1) + '천';
    return n.toLocaleString();
  }

  function parseTitleAndTags(title) {
    const TAIL_KEYWORDS = ['야담','민담','전설','설화','옛날이야기','오디오북','수면동화','사연','역사','조선야담'];

    let cleaned = title;

    // 1단계: #해시태그 제거
    cleaned = cleaned.replace(/#\S+/g, '');

    // 4단계: | 또는 ㅣ 뒤에 키워드만 있는 파트부터 끝까지 제거
    const parts = cleaned.split(/[|ㅣ]/);
    if (parts.length > 1) {
      let cutIndex = parts.length;
      for (let i = parts.length - 1; i >= 1; i--) {
        const partWords = parts[i].trim().split(/\s+/).filter(w => w.length > 0);
        if (partWords.length === 0) {
          cutIndex = i;
          continue;
        }
        const allKeywords = partWords.every(w => {
          const slashParts = w.split('/').filter(s => s.length > 0);
          return slashParts.every(sp =>
            TAIL_KEYWORDS.some(kw => sp.toLowerCase() === kw.toLowerCase())
          );
        });
        if (allKeywords) {
          cutIndex = i;
        } else {
          break;
        }
      }
      if (cutIndex < parts.length) {
        cleaned = parts.slice(0, cutIndex).join('|');
      }
    }

    // 5단계: 제목 끝 슬래시 구분 키워드 조합 제거 ("야담/민담/전설" 형태)
    const tailSlashRegex = new RegExp(
      '\\s+(' + TAIL_KEYWORDS.join('|') + ')(\\/(' + TAIL_KEYWORDS.join('|') + '))+\\s*$',
      'i'
    );
    cleaned = cleaned.replace(tailSlashRegex, '');

    // 6단계: 제목 끝 단독 키워드 하나 제거 (폴백 보호)
    const tailSingleRegex = new RegExp(
      '\\s+(' + TAIL_KEYWORDS.join('|') + ')\\s*$',
      'i'
    );
    const singleRemoved = cleaned.replace(tailSingleRegex, '').trim();
    if (singleRemoved.length > 0) {
      cleaned = singleRemoved;
    }

    // 7단계: 연속 공백 정리
    cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

    return { title: cleaned || title, tags: [] };
  }

  function showToast(msg) {
    let toast = document.querySelector('.spike-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'spike-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  // ── 닫기 함수 ──
  function closeModal() {
    window.__spikeCloseModal = null;
    window.__gapsCloseModal = null;
    window.__activeDeepAnalysis = null;
    localStorage.removeItem('dnaAnalysisState');
    document.removeEventListener('keydown', handleKeydown);
    const container = deepArea.querySelector('.chart-container');
    if (container) container.remove();

    // ── 소재 카드 그리드 복원 ──
    const materialGrid = deepArea.querySelector('.material-grid');
    if (materialGrid) {
      materialGrid.style.display = '';
    }
  }
  window.__gapsCloseModal = closeModal;

  // ── 뒤로가기 함수 ──
  function goBack() {
    history.back();
  }

  // ── 키보드 핸들러 ──
  function handleKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      goBack();
    }
    // Backspace는 브라우저 기본 뒤로가기(popstate)와 통일
  }

  // ── 소재 카드 그리드만 숨기기 (요약 바는 유지) ──
  const materialGrid = deepArea.querySelector('.material-grid');
  if (materialGrid) {
    materialGrid.style.display = 'none';
  }

  // ── 기존 떡상 모달 제거 ──
  const existing = deepArea.querySelector('.chart-container');
  if (existing) existing.remove();

  // ── 떡상 컨테이너 생성 및 삽입 ──
  const chartContainer = document.createElement('div');
  chartContainer.className = 'chart-container spike-modal-container';
  deepArea.appendChild(chartContainer);

  window.__activeDeepAnalysis = { catX, catY };
  window.__spikeCloseModal = closeModal;
  document.addEventListener('keydown', handleKeydown);

  // ── 로딩 UI ──
  chartContainer.innerHTML = `
    <div class="spike-loading-area">
      <div class="spike-loading-spinner"></div>
      <p>떡상 영상을 분석하고 있습니다...</p>
    </div>`;

  let spikeVideos = [];

  try {
    const result = await api.getSpikeVideos({ catX, catY, groupTag, meta });
    spikeVideos = result?.spikeVideos || result?.videos || result || [];

    if (!spikeVideos.length) {
      chartContainer.innerHTML = `
        <div class="spike-modal-header">
          <div class="spike-modal-header-left">
            <h3><span class="spike-header-material" data-material="${catX}">${catX}</span> 떡상 영상 TOP 50</h3>
          </div>
          <div class="spike-modal-header-right">
            <button class="spike-back-btn" title="뒤로가기">${icons.close()}</button>
          </div>
        </div>
        <div class="spike-empty-message">
          <p>이 소재에서 아직 떡상 영상이 발견되지 않았습니다.</p>
          <p style="margin-top:12px;font-size:14px;color:var(--text-muted,#666)">
            데이터가 더 쌓이면 자동으로 분석됩니다.
          </p>
          <button class="spike-btn-close" style="margin-top:24px">돌아가기</button>
        </div>`;
      chartContainer.querySelector('.spike-back-btn').addEventListener('click', goBack);
      chartContainer.querySelector('.spike-btn-close').addEventListener('click', closeModal);
      return;
    }

    // ── 영상 카드 렌더 함수 ──
    function renderVideoCards(videos, startIdx = 0) {
      return videos.map((v, idx) => {
        const parsed     = parseTitleAndTags(v.title);
        const thumbUrl   = v.thumbnail_url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`;
        const youtubeUrl = `https://www.youtube.com/watch?v=${v.videoId}`;
        const hasDna     = v.hasDna;

        return `
          <div class="spike-video-item ${hasDna ? 'spike-video-dna-done' : ''}"
               data-video-id="${v.id}"
               data-has-dna="${hasDna ? 'true' : 'false'}"
               data-dna-id="${v.dnaId || ''}">
            <div class="spike-video-thumb-area">
              <a href="${youtubeUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
                <div class="spike-video-thumb">
                  <img src="${thumbUrl}" alt="" loading="lazy"
                       onerror="this.src='https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg'">
                  <div class="spike-video-thumb-play"><span>▶</span></div>
                </div>
              </a>
              <div class="spike-video-rank-badge">${startIdx + idx + 1}위</div>
              ${hasDna
                ? `<div class="spike-dna-area">
                     ${v.dnaScore != null ? `<span class="spike-dna-score">${v.dnaScore}점</span>` : ''}
                     <button class="spike-dna-view-btn" data-video-id="${v.id}">${icons.dna()} DNA 보기</button>
                   </div>`
                : `<div class="spike-video-select-area">
                     <input type="checkbox" class="spike-video-checkbox" id="spike-cb-${v.id}">
                     <label class="spike-select-label" for="spike-cb-${v.id}">선택</label>
                   </div>`
              }
            </div>
            <div class="spike-video-info">
              <div class="spike-video-title-row">
                <a href="${youtubeUrl}" target="_blank" rel="noopener"
                   class="spike-video-title-link"
                   onclick="event.stopPropagation()">${parsed.title}</a>
                ${hasDna ? `<span class="spike-dna-badge">${icons.success(14)} DNA 추출 완료</span>` : ''}
              </div>
              <div class="spike-video-meta">
                <span class="spike-meta-channel">${v.channelName || '알 수 없음'}</span>
                <span class="spike-meta-divider">┃</span>
                <span>구독자 ${fmt(v.subscriberCount)}</span>
              </div>
              ${(() => {
                const spikeRatio = parseFloat(v.spikeRatio) || 0;
                const gradeText = getSpikeGrade(spikeRatio);
                const gradeClass = getSpikeGradeClass(spikeRatio);
                const gradeTag = gradeText ? `<span class="${gradeClass}">${gradeText}</span>` : '';
                const durationStr = v.durationSeconds ? `${Math.floor(v.durationSeconds/60)}분 ${v.durationSeconds%60}초` : '-';
                const pubFormatted = v.publishedAt
                  ? new Date(v.publishedAt).toLocaleDateString('ko-KR', {year:'numeric',month:'numeric',day:'numeric'})
                  : '';
                const daysSince = Math.max(1, Math.round((Date.now() - new Date(v.publishedAt).getTime()) / 86400000));
                const pubRelative = `${daysSince}일 전`;
                const dailyAvgViews = v.dailyAvgViews != null ? v.dailyAvgViews : Math.round((v.viewCount || 0) / Math.max(daysSince, 3));
                const dailyRatio = v.subscriberCount > 0 ? (dailyAvgViews / v.subscriberCount).toFixed(1) : '0';
                return `<div class="spike-video-stats">
                  <div class="spike-stats-row">
                    <span class="spike-stat spike-stat-ratio">${icons.trendUp(14)} 일평균 ${dailyAvgViews.toLocaleString()}회｜(구독자 대비 ${dailyRatio}배)｜${gradeTag}</span>
                  </div>
                  <div class="spike-stats-row">
                    <span class="spike-stat spike-stat-views">${icons.chartBar(14)} 조회수 ${fmt(v.viewCount)}</span>
                    <span class="spike-stat">⏱ ${durationStr}</span>
                  </div>
                </div>
                ${pubFormatted ? `<div class="spike-card-date">${icons.clock(14)} ${pubFormatted} (${pubRelative})</div>` : ''}`;
              })()}
            </div>
          </div>`;
      }).join('');
    }

    // ── 소재 탭 HTML (DB 기반 동적 생성) ──
    let materialList = [];
    if (_saturationMaterialsCache.length > 0) {
      // 카드와 동일한 포화도순 데이터 직접 사용 (API 호출 불필요)
      materialList = _saturationMaterialsCache.map(m => ({
        name: m.name,
        eventId: m.eventId
      }));
    } else {
      // 캐시 없을 때만 API 호출 (히트맵 등 다른 경로)
      try {
        const allCats = await api.getSettingsCategories();
        const mgn = groupTag + '소재';
        materialList = (allCats[mgn] || []).map(c => ({ name: c.name, eventId: c.id }));
      } catch (e) { console.error('[소재 탭 조회 오류]', e); }
    }

    const materialTabsHtml = materialList.map(m => {
      const icon     = MATERIAL_ICONS[m.name] || _folderIcon;
      const isActive = m.name === catX;
      return `<button class="spike-material-tab${isActive ? ' active' : ''}"
                      data-material="${m.name}"
                      data-event-id="${m.eventId}"
                      ${isActive ? 'disabled' : ''}>${icon} ${m.name}</button>`;
    }).join('');

    // ── 범위 탭 HTML ──
    const hotBtnHtml = groupTag === '경제' ? '<button class="spike-range-tab spike-hot-issue-btn" data-range="hot">🔥 핫 이슈</button>' : '';
    const maxCount     = spikeVideos.length;
    const rangeTabsHtml = [10, 20, 30, 40, 50].map(n => {
      const startRank = n - 9;
      const endRank = Math.min(n, maxCount);
      const hasVideos = startRank <= maxCount;
      const isDefault = n === 10;
      const countInRange = hasVideos ? (endRank - startRank + 1) : 0;
      const subLabel = !hasVideos ? ' (없음)' : (countInRange < 10 ? ` (${countInRange}개)` : '');
      return `<button class="spike-range-tab${isDefault ? ' active' : ''}${!hasVideos ? ' disabled-tab' : ''}"
                      data-range="${n}"
                      ${!hasVideos ? 'disabled' : ''}
                      >TOP ${n}${subLabel}</button>`;
    }).join('');

    // ── 전체 HTML 삽입 ──
    chartContainer.innerHTML = `
      <div class="spike-modal-header">
        <div class="spike-modal-header-left">
          <h3><span class="spike-header-material" data-material="${catX}">${catX}</span> 떡상 영상 TOP 50</h3>
        </div>
        <div class="spike-modal-header-right">
          <button class="spike-back-btn" title="뒤로가기 (Backspace)">${icons.close()}</button>
        </div>
      </div>

      <div class="spike-material-tabs" id="spike-material-tabs">
        ${materialTabsHtml}
      </div>

      <div class="spike-range-bar">
        <div class="spike-range-tabs" id="spike-range-tabs">
          ${hotBtnHtml}${rangeTabsHtml}
        </div>
        <div class="spike-modal-guide-inline">
          <span class="spike-guide-text">💡 DNA 분석할 영상을 <strong>최대 10개</strong> 선택하세요</span>
          <span class="spike-char-counter" id="spike-char-counter">선택된 영상: <span class="counter-num">0</span>개 / 최대 10개</span>
        </div>
      </div>

      <div class="spike-video-list" id="spike-video-list">
        ${renderVideoCards(spikeVideos.slice(0, 10), 0)}
      </div>

      <div class="spike-floating-bar" id="spike-floating-bar">
        <div class="spike-floating-left">
          <span class="spike-floating-count">
            <span class="num" id="spike-float-num">0</span>개 선택
          </span>
          <span class="spike-floating-divider">┃</span>
          <span class="spike-floating-hint">영상을 선택하면 DNA 분석이 가능합니다</span>
        </div>
        <div class="spike-floating-right">
          <button class="spike-btn-select-all" id="spike-select-all-btn">현재 탭 전체 선택</button>
          <button class="spike-btn-analyze" id="spike-analyze-btn" disabled>
            ${icons.dna()} DNA 분석 시작
          </button>
        </div>
      </div>`;

    // ── localStorage 상태 저장 ──
    try {
      localStorage.setItem('dnaAnalysisState', JSON.stringify({
        stage: 'spike', catX, catY, groupTag, meta, spikeVideos, timestamp: Date.now()
      }));
    } catch(e) {}

    // ── DOM 참조 ──
    const list         = chartContainer.querySelector('#spike-video-list');
    const charCounter  = chartContainer.querySelector('#spike-char-counter');
    const floatNum     = chartContainer.querySelector('#spike-float-num');
    const floatingBar  = chartContainer.querySelector('#spike-floating-bar');
    const floatingHint = chartContainer.querySelector('.spike-floating-hint');
    const analyzeBtn   = chartContainer.querySelector('#spike-analyze-btn');
    const backBtn      = chartContainer.querySelector('.spike-back-btn');
    const selectAllBtnEl = chartContainer.querySelector('#spike-select-all-btn');
    if (selectAllBtnEl) selectAllBtnEl.textContent = 'TOP10 전체 선택';

    // ── 이벤트: 뒤로가기 ──
    backBtn.addEventListener('click', goBack);

    // ── 이벤트: 카드 클릭 → 체크박스 토글 ──
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.spike-video-item');
      if (!item) return;
      if (e.target.closest('a') || e.target.closest('.spike-dna-view-btn')) return;

      const cb = item.querySelector('.spike-video-checkbox');
      if (!cb) return;

      // 체크박스 또는 라벨 직접 클릭 → 브라우저가 이미 토글했으므로 change만 발행
      if (e.target.type === 'checkbox' || e.target.tagName === 'LABEL') {
        if (cb.disabled && !cb.checked) {
          cb.checked = false;
          showToast('⚠️ 최대 10개까지 선택할 수 있습니다');
          return;
        }
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }

      // 카드 다른 영역 클릭 → 수동 토글
      if (cb.disabled && !cb.checked) {
        showToast('⚠️ 최대 10개까지 선택할 수 있습니다');
        return;
      }
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // ── 이벤트: 체크박스 변경 ──
    list.addEventListener('change', (e) => {
      if (!e.target.classList.contains('spike-video-checkbox')) return;

      const allCheckboxes = list.querySelectorAll('.spike-video-checkbox');
      const checkedCount  = list.querySelectorAll('.spike-video-checkbox:checked').length;

      list.querySelectorAll('.spike-video-item').forEach(item => {
        const cb = item.querySelector('.spike-video-checkbox');
        if (cb && cb.checked) item.classList.add('selected');
        else item.classList.remove('selected');
      });

      allCheckboxes.forEach(cb => {
        if (!cb.checked) {
          cb.disabled = checkedCount >= 10;
          cb.closest('.spike-video-item')?.classList.toggle('disabled-item', checkedCount >= 10);
        }
      });

      charCounter.querySelector('.counter-num').textContent = checkedCount;
      floatNum.textContent = checkedCount;

      floatingBar.classList.toggle('has-selection', checkedCount > 0);
      floatingHint.textContent = checkedCount === 0
        ? '영상을 선택하면 DNA 분석이 가능합니다'
        : '선택 완료! DNA 분석을 시작하세요';

      analyzeBtn.disabled = checkedCount === 0;
      analyzeBtn.innerHTML = checkedCount === 0
        ? `${icons.dna()} DNA 분석 시작`
        : `${icons.dna()} DNA 분석 시작 (${checkedCount}개)`;
    });

    // ── 이벤트: 현재 탭 전체 선택 ──
    const selectAllBtn = chartContainer.querySelector('#spike-select-all-btn');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        const visibleCheckboxes = chartContainer.querySelectorAll('.spike-video-checkbox:not(:disabled)');
        const allChecked = Array.from(visibleCheckboxes).every(cb => cb.checked);

        const activeRangeTab = chartContainer.querySelector('.spike-range-tab.active');
        const activeRangeLabel = activeRangeTab?.dataset?.range
          ? `TOP${activeRangeTab.dataset.range}`
          : 'TOP10';

        if (allChecked) {
          visibleCheckboxes.forEach(cb => {
            cb.checked = false;
            cb.closest('.spike-video-item')?.classList.remove('selected-item');
          });
          selectAllBtn.textContent = `${activeRangeLabel} 전체 선택`;
        } else {
          let count = 0;
          const alreadyChecked = chartContainer.querySelectorAll('.spike-video-checkbox:checked').length;
          visibleCheckboxes.forEach(cb => {
            if (count + alreadyChecked >= 10) return;
            if (!cb.checked) {
              cb.checked = true;
              cb.closest('.spike-video-item')?.classList.add('selected-item');
              count++;
            }
          });
          selectAllBtn.textContent = '선택 해제';
        }

        const totalChecked = chartContainer.querySelectorAll('.spike-video-checkbox:checked').length;
        const floatNumEl = chartContainer.querySelector('#spike-float-num');
        if (floatNumEl) floatNumEl.textContent = totalChecked;
        const counterNumEl = chartContainer.querySelector('.counter-num');
        if (counterNumEl) counterNumEl.textContent = totalChecked;

        const analyzeBtnEl = chartContainer.querySelector('#spike-analyze-btn');
        if (analyzeBtnEl) {
          analyzeBtnEl.disabled = totalChecked === 0;
          analyzeBtnEl.innerHTML = totalChecked === 0
            ? `${icons.dna()} DNA 분석 시작`
            : `${icons.dna()} DNA 분석 시작 (${totalChecked}개)`;
        }

        floatingBar.classList.toggle('has-selection', totalChecked > 0);

        chartContainer.querySelectorAll('.spike-video-checkbox').forEach(cb => {
          if (!cb.checked) {
            cb.disabled = totalChecked >= 10;
            cb.closest('.spike-video-item')?.classList.toggle('disabled-item', totalChecked >= 10);
          }
        });
      });
    }

    // ── 이벤트: DNA 보기 버튼 ──
    list.querySelectorAll('.spike-dna-view-btn').forEach(btn => {
      btn.setAttribute('data-bound', 'true');
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const videoId = parseInt(btn.dataset.videoId, 10);
        btn.disabled = true;
        btn.textContent = '불러오는 중...';
        try {
          const dnaResponse = await api.getDnaByVideoId(videoId);
          showDnaResultModal(dnaResponse, catX, catY, groupTag, meta, deepArea, api, spikeVideos);
        } catch(err) {
          showToast('DNA 데이터를 불러올 수 없습니다');
        } finally {
          btn.disabled = false;
          btn.innerHTML = `${icons.dna()} DNA 보기`;
        }
      });
    });

    // ── 이벤트: 범위 탭 전환 (서버 호출 없음, 화면만 교체) ──
    const rangeTabs = chartContainer.querySelector('#spike-range-tabs');
    let currentRange = 10;

    rangeTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.spike-range-tab');
      if (!tab || tab.disabled || tab.classList.contains('active')) return;

      rangeTabs.querySelectorAll('.spike-range-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const rangeVal = tab.dataset.range;

      if (rangeVal === 'hot') {
        // 기존 영상 리스트 숨김
        list.style.display = 'none';
        // 가이드 텍스트, 플로팅 바 숨김
        const guideEl = chartContainer.querySelector('.spike-modal-guide-inline');
        if (guideEl) guideEl.style.display = 'none';
        floatingBar.style.display = 'none';

        // 핫 이슈 컨테이너: 없으면 생성, 있으면 표시
        let hotContainer = chartContainer.querySelector('#spike-hot-issue-container');
        if (!hotContainer) {
          hotContainer = document.createElement('div');
          hotContainer.id = 'spike-hot-issue-container';
          hotContainer.className = 'spike-hot-issue-container';
          list.parentNode.insertBefore(hotContainer, list.nextSibling);
          renderHotIssueInSpike(api, hotContainer);
        }
        hotContainer.style.display = '';
        return;
      }

      // TOP 탭 복원: 핫 이슈 숨김, 영상 리스트 + 가이드 + 플로팅 바 표시
      const hotContainer = chartContainer.querySelector('#spike-hot-issue-container');
      if (hotContainer) hotContainer.style.display = 'none';
      list.style.display = '';
      const guideEl = chartContainer.querySelector('.spike-modal-guide-inline');
      if (guideEl) guideEl.style.display = '';
      floatingBar.style.display = '';

      const range = parseInt(rangeVal, 10);
      currentRange = range;

      // 화면 교체 — 구간 slice + 전환 효과
      const startIdx = range - 10;
      const endIdx = range;
      const sliced = spikeVideos.slice(startIdx, endIdx);

      list.classList.add('spike-fade-out');
      setTimeout(() => {
        list.innerHTML = renderVideoCards(sliced, startIdx);
        list.classList.remove('spike-fade-out');
        list.classList.add('spike-fade-in');
        setTimeout(() => list.classList.remove('spike-fade-in'), 300);

        // DNA 보기 버튼 재등록 (innerHTML 교체 후 재등록 필요)
        list.querySelectorAll('.spike-dna-view-btn').forEach(btn => {
          btn.setAttribute('data-bound', 'true');
          btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const videoId = parseInt(btn.dataset.videoId, 10);
            btn.disabled = true;
            btn.textContent = '불러오는 중...';
            try {
              const dnaResponse = await api.getDnaByVideoId(videoId);
              showDnaResultModal(dnaResponse, catX, catY, groupTag, meta, deepArea, api, spikeVideos);
            } catch(err) {
              showToast('DNA 데이터를 불러올 수 없습니다');
            } finally {
              btn.disabled = false;
              btn.innerHTML = `${icons.dna()} DNA 보기`;
            }
          });
        });
      }, 200);

      // 카운터/플로팅바 초기화
      charCounter.querySelector('.counter-num').textContent = '0';
      floatNum.textContent = '0';
      analyzeBtn.disabled = true;
      analyzeBtn.innerHTML = `${icons.dna()} DNA 분석 시작`;
      floatingBar.classList.remove('has-selection');
      floatingHint.textContent = '영상을 선택하면 DNA 분석이 가능합니다';
      const selectAllBtn2 = chartContainer.querySelector('#spike-select-all-btn');
      if (selectAllBtn2) selectAllBtn2.textContent = `TOP${range} 전체 선택`;
    });

    // ── 이벤트: 소재 탭 전환 (서버 호출, 새 소재 로드) ──
    const materialTabs = chartContainer.querySelector('#spike-material-tabs');

    materialTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.spike-material-tab');
      if (!tab || tab.disabled || tab.classList.contains('active')) return;

      const newMaterial = tab.dataset.material;
      const newEventId  = parseInt(tab.dataset.eventId, 10);
      const newMeta = { eraId: 0, eventId: newEventId, sourceId: 0, personId: 0, regionId: 0 };

      // remove 시 DOM 높이 붕괴로 인한 스크롤 점프 방지
      deepArea.style.minHeight = deepArea.offsetHeight + 'px';
      document.removeEventListener('keydown', handleKeydown);
      chartContainer.remove();

      // 소재 카드 그리드 복원 후 재호출 (closeModal 없이 직접 제거했으므로 grid는 이미 숨김 상태)
      showSpikeVideoModal(newMaterial, newMaterial, groupTag, newMeta, deepArea, api);
      setTimeout(() => { deepArea.style.minHeight = ''; }, 1500);
    });

    // ── DNA 배치 작업 복원 (새로고침 후 진행 중인 작업 이어받기) ──
    try {
      const savedJob = localStorage.getItem('dna-batch-job');
      if (savedJob) {
        const jobInfo = JSON.parse(savedJob);
        const statusCheck = await api.batchDnaStatus(jobInfo.jobId);
        if (statusCheck.status === 'processing') {
          showDnaBatchPanel(api, jobInfo.jobId, jobInfo.total, jobInfo.titles || [],
            jobInfo.category, jobInfo.groupTag, catX, catY, meta, deepArea, spikeVideos);
        } else if (statusCheck.status === 'complete' || statusCheck.status === 'cancelled') {
          updateCardsAfterBatchDna(statusCheck.results, spikeVideos);
          localStorage.removeItem('dna-batch-job');
        } else {
          localStorage.removeItem('dna-batch-job');
        }
      }
    } catch (e) {
      localStorage.removeItem('dna-batch-job');
    }

    // ── 이벤트: DNA 분석 시작 ──
    analyzeBtn.addEventListener('click', async () => {
      const checkedBoxes = list.querySelectorAll('.spike-video-checkbox:checked');
      if (checkedBoxes.length === 0) {
        showToast('⚠️ 분석할 영상을 선택해주세요');
        return;
      }

      const selectedIds = Array.from(checkedBoxes).map(cb =>
        parseInt(cb.closest('.spike-video-item').dataset.videoId, 10)
      );
      const selectedTitles = Array.from(checkedBoxes).map(cb => {
        const item = cb.closest('.spike-video-item');
        return item?.querySelector('.rf-item-title, .spike-video-title')?.textContent || '제목 없음';
      });

      const currentCategory = document.querySelector('.spike-material-tab.active')?.dataset?.category
        || document.querySelector('.material-tab-btn.active')?.dataset?.category
        || catX;

      if (selectedIds.length === 1) {
        // 단일 분석 (기존 로직)
        analyzeBtn.disabled = true;
        analyzeBtn.innerHTML = `${icons.dna()} 분석 중...`;

        const spinnerOverlay = document.createElement('div');
        spinnerOverlay.className = 'dna-spinner-overlay';
        spinnerOverlay.innerHTML = `
          <div class="dna-spinner-modal">
            <div class="dna-spinner-icon"></div>
            <h3 class="dna-spinner-title">DNA 분석 중</h3>
            <p class="dna-spinner-desc">
              Gemini 2.5 Flash가 대본과 댓글을 분석하여<br>
              영상의 DNA를 추출하고 있습니다
            </p>
            <div class="dna-spinner-progress">
              <div class="dna-spinner-bar"></div>
            </div>
            <p class="dna-spinner-time">약 30~60초 소요</p>
          </div>
        `;
        document.body.appendChild(spinnerOverlay);
        requestAnimationFrame(() => { spinnerOverlay.classList.add('visible'); });

        try {
          const dnaResponse = await api.extractDna({ videoIds: selectedIds, category: currentCategory, groupTag });

          spinnerOverlay.classList.remove('visible');
          setTimeout(() => spinnerOverlay.remove(), 300);

          analyzeBtn.disabled = true;
          analyzeBtn.innerHTML = `${icons.dna()} DNA 분석 시작`;

          list.querySelectorAll('.spike-video-checkbox:checked').forEach(cb => { cb.checked = false; });
          list.querySelectorAll('.spike-video-item').forEach(item => {
            item.classList.remove('selected', 'disabled-item');
          });
          list.querySelectorAll('.spike-video-checkbox').forEach(cb => { cb.disabled = false; });
          charCounter.querySelector('.counter-num').textContent = '0';
          floatNum.textContent = '0';
          floatingBar.classList.remove('has-selection');
          floatingHint.textContent = '영상을 선택하면 DNA 분석이 가능합니다';

          showDnaResultModal(dnaResponse, catX, catY, groupTag, meta, deepArea, api, spikeVideos);

          // 단일 분석 완료 후 카드 상태 업데이트
          const analyzedVideoId = selectedIds[0];
          const analyzedCard = list.querySelector(`.spike-video-item[data-video-id="${analyzedVideoId}"]`);
          if (analyzedCard) {
            analyzedCard.classList.add('spike-video-dna-done');
            analyzedCard.dataset.hasDna = 'true';
            analyzedCard.dataset.dnaId = String(dnaResponse.dnaId || '');
            const sv = spikeVideos?.find(v => v.id === analyzedVideoId);
            if (sv) sv.hasDna = true;
          }

        } catch(err) {
          spinnerOverlay.classList.remove('visible');
          setTimeout(() => spinnerOverlay.remove(), 300);
          showToast('❌ DNA 분석 중 오류가 발생했습니다: ' + (err.message || '알 수 없는 오류'));
          analyzeBtn.disabled = false;
          analyzeBtn.innerHTML = `${icons.dna()} DNA 분석 시작`;
        }
        return;
      }

      // 다중 분석 (2개 이상)
      if (!confirm(`${selectedIds.length}개 영상의 DNA 분석을 시작합니다.\n완료까지 약 ${selectedIds.length}~${selectedIds.length * 2}분 소요됩니다.\n\n진행하시겠습니까?`)) return;

      analyzeBtn.disabled = true;
      analyzeBtn.innerHTML = `${icons.dna()} DNA 배치 분석 중...`;

      // 선택 상태 초기화
      list.querySelectorAll('.spike-video-checkbox:checked').forEach(cb => { cb.checked = false; });
      list.querySelectorAll('.spike-video-item').forEach(item => {
        item.classList.remove('selected', 'disabled-item');
      });
      list.querySelectorAll('.spike-video-checkbox').forEach(cb => { cb.disabled = false; });
      charCounter.querySelector('.counter-num').textContent = '0';
      floatNum.textContent = '0';
      floatingBar.classList.remove('has-selection');
      floatingHint.textContent = '영상을 선택하면 DNA 분석이 가능합니다';

      try {
        const result = await api.batchExtractDna(selectedIds, currentCategory, groupTag);
        const jobId = result.jobId;

        localStorage.setItem('dna-batch-job', JSON.stringify({
          jobId,
          category: currentCategory,
          groupTag,
          total: selectedIds.length,
          titles: selectedTitles
        }));

        showDnaBatchPanel(api, jobId, selectedIds.length, selectedTitles, currentCategory, groupTag, catX, catY, meta, deepArea, spikeVideos);

      } catch (err) {
        analyzeBtn.disabled = false;
        analyzeBtn.innerHTML = `${icons.dna()} DNA 분석 시작`;
        showToast('❌ DNA 배치 분석 시작 실패: ' + (err.message || '알 수 없는 오류'));
      }
    });

  } catch(err) {
    chartContainer.innerHTML = `
      <div class="spike-modal-header">
        <div class="spike-modal-header-left">
          <h3>오류 발생</h3>
        </div>
        <div class="spike-modal-header-right">
          <button class="spike-back-btn" title="뒤로가기">${icons.close()}</button>
        </div>
      </div>
      <div class="spike-empty-message">
        <p style="font-size:18px;margin-bottom:12px">${icons.error()} 떡상 영상을 불러오는 중 오류가 발생했습니다</p>
        <p>${err.message || ''}</p>
        <button class="spike-btn-close" style="margin-top:24px">돌아가기</button>
      </div>`;
    chartContainer.querySelector('.spike-back-btn')?.addEventListener('click', goBack);
    chartContainer.querySelector('.spike-btn-close')?.addEventListener('click', closeModal);
  }
}

// ── 핫 이슈 렌더링 함수들 ────────────────────────────────────────────────────
async function renderHotIssueInSpike(api, container) {
  try {
    container.innerHTML = `
      <div class="hot-issue-header">
        <h4 class="hot-issue-title">🔥 경제 핫 이슈 키워드</h4>
        <div class="hot-issue-controls">
          <select id="hot-period-select" class="hot-period-select">
            <option value="3">최근 3일</option>
            <option value="7" selected>최근 7일</option>
          </select>
          <button id="hot-analyze-btn" class="hot-analyze-btn">분석 실행</button>
        </div>
      </div>
      <div class="hot-issue-body">
        <div class="hot-issue-left" id="hot-ranking-area">
          <div class="hot-issue-empty">분석 실행 버튼을 눌러주세요</div>
        </div>
        <div class="hot-issue-right" id="hot-topics-area">
          <div class="hot-issue-right-title">🎯 AI 차별화 주제 추천</div>
          <div class="hot-issue-empty">좌측 키워드를 선택하면 AI가 주제를 추천합니다</div>
        </div>
      </div>
    `;

    const analyzeBtn  = container.querySelector('#hot-analyze-btn');
    const periodSelect = container.querySelector('#hot-period-select');
    const rankingArea = container.querySelector('#hot-ranking-area');
    const topicsArea  = container.querySelector('#hot-topics-area');

    analyzeBtn.addEventListener('click', async () => {
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = '분석 중...';
      rankingArea.innerHTML = '<div class="hot-issue-loading">DB 분석 + AI 키워드 추출 중... (10~30초)</div>';

      try {
        const period = periodSelect.value;
        const data = await api.getEconomyRealtimeV3({ period });
        renderHotKeywordList(data, rankingArea, topicsArea, api);
      } catch (err) {
        rankingArea.innerHTML = '<div class="hot-issue-error">분석 실패: ' + err.message + '</div>';
      } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = '분석 실행';
      }
    });
  } catch (err) {
    container.innerHTML = '<div class="hot-issue-error">핫 이슈 로드 실패</div>';
    console.error('[핫이슈] 오류:', err);
  }
}

function renderHotKeywordList(data, rankingArea, topicsArea, api) {
  const keywords = data.keywords || [];

  if (keywords.length === 0) {
    rankingArea.innerHTML = '<div class="hot-issue-empty">분석 기간 내 핫 이슈가 없습니다</div>';
    return;
  }

  rankingArea.innerHTML = keywords.map((kw, idx) => `
    <div class="hot-keyword-item" data-keyword="${kw.keyword}" data-index="${idx}">
      <div class="hot-keyword-rank">${idx + 1}</div>
      <div class="hot-keyword-info">
        <div class="hot-keyword-name">${kw.keyword}</div>
        <div class="hot-keyword-meta">
          채널 ${kw.unique_channels}개 · 영상 ${kw.hit_count}개 · 최고 ${Number(kw.max_views || 0).toLocaleString()}회
        </div>
      </div>
      <div class="hot-keyword-score">${Number(kw.hot_score || 0).toLocaleString()}</div>
    </div>
  `).join('');

  rankingArea.querySelectorAll('.hot-keyword-item').forEach(item => {
    item.addEventListener('click', async () => {
      rankingArea.querySelectorAll('.hot-keyword-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      const keyword = item.dataset.keyword;
      const idx = parseInt(item.dataset.index);
      const kwData = keywords[idx];

      topicsArea.innerHTML = `
        <div class="hot-issue-right-title">🎯 "${keyword}" AI 주제 추천</div>
        <div class="hot-issue-loading">AI 분석 중... (10~20초)</div>
      `;

      try {
        const existingVideos = (kwData.videos || []).map(v => v.title);
        const result = await api.suggestEconomyTopicsV3({ keyword, existingVideos });
        renderHotTopics(result, keyword, topicsArea, api);
      } catch (err) {
        topicsArea.innerHTML = `
          <div class="hot-issue-right-title">🎯 "${keyword}" AI 주제 추천</div>
          <div class="hot-issue-error">AI 추천 실패: ${err.message}</div>
        `;
      }
    });
  });
}

function renderHotTopics(result, keyword, topicsArea, api) {
  const suggestions = result.suggestions || [];

  topicsArea.innerHTML = `
    <div class="hot-issue-right-title">🎯 "${keyword}" AI 주제 추천</div>
    ${result.angle_analysis ? `<div class="hot-angle-analysis">${result.angle_analysis}</div>` : ''}
    <div class="hot-topics-list">
      ${suggestions.map((s, idx) => `
        <div class="hot-topic-card" data-index="${idx}">
          <div class="hot-topic-title">${s.title}</div>
          ${s.target_audience ? `<div class="hot-topic-meta">타겟: ${s.target_audience}</div>` : ''}
          ${s.differentiation_reason ? `<div class="hot-topic-diff">${s.differentiation_reason}</div>` : ''}
          <button class="hot-thumbnail-btn" data-keyword="${keyword}" data-title="${s.title}">
            썸네일 제목 추천
          </button>
          <div class="hot-thumbnail-result" id="hot-thumb-${idx}"></div>
        </div>
      `).join('')}
    </div>
  `;

  topicsArea.querySelectorAll('.hot-thumbnail-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const title = btn.dataset.title;
      const kw = btn.dataset.keyword;
      const idx = btn.closest('.hot-topic-card').dataset.index;
      const resultEl = topicsArea.querySelector(`#hot-thumb-${idx}`);

      btn.disabled = true;
      btn.textContent = '생성 중...';
      resultEl.innerHTML = '<div class="hot-issue-loading">AI 생성 중...</div>';

      try {
        const thumbResult = await api.getThumbnailTitlesV3({
          keyword: kw,
          topicTitle: title,
          suggestions
        });
        const titles = thumbResult.titles || thumbResult.thumbnails || [];
        resultEl.innerHTML = titles.map(t =>
          `<div class="hot-thumb-item">📌 ${typeof t === 'string' ? t : t.title || t}</div>`
        ).join('');
      } catch (err) {
        resultEl.innerHTML = '<div class="hot-issue-error">생성 실패</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = '썸네일 제목 추천';
      }
    });
  });
}

// ── 소재 관리 모달 ────────────────────────────────────────────────────────────
async function showMaterialManageModal(api, groupTag) {
  const mgn = groupTag + '소재';
  const allCats = await api.getSettingsCategories();
  const materials = (allCats[mgn] || []).sort((a, b) => {
    return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
  });

  const overlay = document.createElement('div');
  overlay.className = 'confirm-modal-overlay mat-manage-overlay';
  overlay.innerHTML = `
    <div class="mat-manage-modal">
      <div class="mat-manage-header">
        <h3 class="mat-manage-title">소재 관리 — ${groupTag}</h3>
        <button class="mat-manage-close">&times;</button>
      </div>
      <div class="mat-manage-desc">
        소재명을 클릭하면 수정할 수 있습니다.<br>변경 시 관련된 모든 데이터에 자동 반영됩니다.
      </div>
      <div class="mat-manage-list" id="mat-manage-list">
        ${materials.map((m, idx) => `
          <div class="mat-manage-row" data-id="${m.id}" data-name="${m.name}">
            <span class="mat-manage-num">${idx + 1}</span>
            <span class="mat-manage-name">${m.name}</span>
            <div class="mat-manage-actions">
              <button class="mat-manage-edit-btn" data-id="${m.id}" data-name="${m.name}">수정</button>
              <button class="mat-manage-delete-btn" data-id="${m.id}" data-name="${m.name}">삭제</button>
            </div>
          </div>
        `).join('')}
        ${materials.length === 0 ? '<div class="mat-manage-empty">등록된 소재가 없습니다</div>' : ''}
      </div>
      <div class="mat-manage-footer">
        <button class="mat-manage-add-btn" id="mat-manage-add">+ 소재 추가</button>
        <button class="mat-manage-close-btn">닫기</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector('.mat-manage-close').onclick = closeModal;
  overlay.querySelector('.mat-manage-close-btn').onclick = closeModal;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  const refresh = () => {
    const contentArea = document.getElementById('yadam-results-container');
    if (contentArea) renderMaterialCards(api, contentArea, groupTag);
  };

  // 수정 버튼
  overlay.querySelectorAll('.mat-manage-edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const oldName = btn.dataset.name;
      const newName = prompt('새 소재명을 입력하세요:', oldName);
      if (!newName || newName.trim() === '' || newName.trim() === oldName) return;

      try {
        await api.updateMaterialName(id, newName.trim());
        alert(`"${oldName}" → "${newName.trim()}" 변경 완료`);
        closeModal();
        refresh();
      } catch (err) {
        alert('변경 실패: ' + (err.message || '알 수 없는 오류'));
      }
    });
  });

  // 삭제 버튼
  overlay.querySelectorAll('.mat-manage-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      const confirmed = confirm(
        `"${name}" 소재를 삭제하시겠습니까?\n\n` +
        `이 소재로 분류된 모든 영상의 분류가 해제됩니다.\n` +
        `떡상 랭킹 데이터도 삭제됩니다.\n\n이 작업은 되돌릴 수 없습니다.`
      );
      if (!confirmed) return;

      try {
        await api.deleteMaterial(id);
        alert(`"${name}" 소재가 삭제되었습니다`);
        closeModal();
        refresh();
      } catch (err) {
        alert('삭제 실패: ' + (err.message || '알 수 없는 오류'));
      }
    });
  });

  // 소재 추가 버튼
  overlay.querySelector('#mat-manage-add').addEventListener('click', async () => {
    const newName = prompt('추가할 소재명을 입력하세요:');
    if (!newName || newName.trim() === '') return;

    try {
      await api.addMaterial(mgn, newName.trim());
      alert(`"${newName.trim()}" 소재가 추가되었습니다`);
      closeModal();
      refresh();
    } catch (err) {
      alert('추가 실패: ' + (err.message || '알 수 없는 오류'));
    }
  });
}

// ── DNA 이력 섹션 ──────────────────────────────────────────────────────────────
function renderDnaHistorySection(container, api) {
  if (document.querySelector('.dna-history-section')) return;

  const section = document.createElement('div');
  section.className = 'dna-history-section';
  section.innerHTML = `
    <div class="dna-history-header"
         onclick="this.parentElement.classList.toggle('expanded')">
      <span class="dna-history-icon">🧬</span>
      <span class="dna-history-title">DNA 분석 이력</span>
      <span class="dna-history-count" id="dna-history-count">불러오는 중...</span>
      <span class="dna-history-arrow">▸</span>
    </div>
    <div class="dna-history-body" id="dna-history-body">
      <div class="dna-history-loading">
        <div class="spike-loading-spinner"></div>
        <span>이력을 불러오는 중...</span>
      </div>
    </div>
  `;

  container.appendChild(section);

  section.querySelector('.dna-history-header')
    .addEventListener('click', async function handler() {
      const body = document.getElementById('dna-history-body');
      if (body.dataset.loaded === 'true') return;

      try {
        const data = await api.getDnaHistory(currentGroupTag);
        const history = data.history || [];

        document.getElementById('dna-history-count').textContent = `${history.length}건`;

        if (history.length === 0) {
          body.innerHTML = `
            <div class="dna-history-empty">
              아직 저장된 DNA 분석 결과가 없습니다.<br>
              포화 카테고리에서 떡상 영상을 선택하여 DNA 분석을 실행하세요.
            </div>`;
        } else {
          body.innerHTML = history.map(h => {
            const titles = JSON.parse(h.video_titles || '[]');
            const channels = JSON.parse(h.channel_names || '[]');
            return `
              <div class="dna-history-card" data-dna-id="${h.id}">
                <div class="dna-history-card-top">
                  <span class="dna-history-card-category">${h.category}</span>
                  <span class="dna-history-card-date">${h.created_at || ''}</span>
                </div>
                <div class="dna-history-card-videos">
                  ${titles.map((t, i) => `
                    <div class="dna-history-card-video">
                      <span class="dna-history-card-channel">${channels[i] || ''}</span>
                      <span class="dna-history-card-title">${t}</span>
                    </div>
                  `).join('')}
                </div>
                <div class="dna-history-card-detail" id="dna-detail-${h.id}" style="display:none"></div>
              </div>
            `;
          }).join('');

          body.querySelectorAll('.dna-history-card').forEach(card => {
            card.addEventListener('click', async () => {
              const dnaId = card.dataset.dnaId;
              const detail = document.getElementById(`dna-detail-${dnaId}`);

              if (detail.style.display !== 'none') {
                detail.style.display = 'none';
                return;
              }
              if (detail.dataset.loaded === 'true') {
                detail.style.display = 'block';
                return;
              }

              detail.style.display = 'block';
              detail.innerHTML = `<div class="dna-history-loading"><div class="spike-loading-spinner"></div></div>`;

              try {
                const data = await api.getDnaDetail(dnaId);
                detail.innerHTML = `<div class="dna-viz-container">${renderDnaContent(data.dna)}</div>`;
                detail.dataset.loaded = 'true';
              } catch (err) {
                detail.innerHTML = `<div class="dna-history-error">DNA 상세 로드 실패: ${err.message}</div>`;
              }
            });
          });
        }

        body.dataset.loaded = 'true';
      } catch (err) {
        const body = document.getElementById('dna-history-body');
        body.innerHTML = `<div class="dna-history-error">이력 조회 실패: ${err.message}</div>`;
      }
    });
}

// ─── 미분류 영상 관리 모달 ───────────────────────────────────────────────────
async function showUnclassifiedModal(api, groupTag) {
  const res = await api.getUnclassifiedVideos(groupTag);
  const videos = res.videos || [];

  const groupName = groupTag.trim() + '소재';
  const allCats = await api.getSettingsCategories();
  const materialCats = (allCats[groupName] || []).map(c => ({ id: c.id, name: c.name }));

  const overlay = document.createElement('div');
  overlay.className = 'uc-modal-overlay';
  overlay.innerHTML = `
    <div class="uc-modal">
      <div class="uc-modal-header">
        <h3>미분류 영상 (<span class="uc-total">${videos.length}</span>개)</h3>
        <div class="uc-header-right">
          <button id="uc-ai-classify-btn" class="uc-ai-btn">${icons.robot()} AI 자동 분류</button>
          <button class="uc-modal-close">&times;</button>
        </div>
      </div>
      <div id="uc-progress-area" class="uc-progress-area" style="display:none;">
        <div class="uc-progress-info">
          <span id="uc-progress-text">준비 중...</span>
          <span id="uc-progress-count"></span>
        </div>
        <div class="uc-progress-bar-bg">
          <div id="uc-progress-bar" class="uc-progress-bar-fill"></div>
        </div>
        <div id="uc-progress-detail" class="uc-progress-detail"></div>
      </div>
      <div class="uc-modal-body">
        ${videos.length === 0
          ? '<div class="uc-empty">미분류 영상이 없습니다</div>'
          : videos.map(v => `
          <div class="uc-video-row" data-id="${v.id}" data-video-id="${v.video_id}">
            <div class="uc-video-thumb">
              <a href="https://www.youtube.com/watch?v=${v.video_id}" target="_blank">
                <img src="${v.thumbnail_url || ''}" alt="" loading="lazy" />
              </a>
            </div>
            <div class="uc-video-info">
              <div class="uc-video-title">
                <a href="https://www.youtube.com/watch?v=${v.video_id}" target="_blank">${v.title}</a>
              </div>
              <div class="uc-video-meta">
                ${v.channel_name} · 조회수 ${Number(v.view_count || 0).toLocaleString()}회 · ${v.published_at ? v.published_at.slice(0, 10) : ''}
              </div>
            </div>
            <div class="uc-video-actions">
              <select class="uc-category-select">
                <option value="">분류 선택</option>
                ${materialCats.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
              </select>
              <button class="uc-classify-btn" data-id="${v.id}">분류</button>
              <button class="uc-delete-btn" data-id="${v.id}">삭제</button>
            </div>
          </div>`).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const updateCount = () => {
    const remaining = overlay.querySelectorAll('.uc-video-row').length;
    overlay.querySelector('.uc-total').textContent = remaining;
    const ucBtn = document.getElementById('unclassified-btn');
    if (ucBtn) {
      document.getElementById('unclassified-count').textContent = remaining;
      if (remaining === 0) ucBtn.style.display = 'none';
    }
  };

  const refreshMainCount = async () => {
    try {
      const ucRes = await api.getUnclassifiedVideos(groupTag);
const ucBtnMain = document.querySelector('#unclassified-btn');
      const ucCountMain = document.querySelector('#unclassified-count');
      if (ucBtnMain && ucCountMain) {
        ucBtnMain.style.display = 'inline-flex';
        ucCountMain.textContent = ucRes.total;
      }
    } catch (e) {}
  };

  overlay.querySelector('.uc-modal-close').addEventListener('click', async () => {
    overlay.remove();
    await refreshMainCount();
  });
  overlay.addEventListener('click', async (e) => {
    if (e.target !== overlay) return;
    overlay.remove();
    await refreshMainCount();
  });

  const aiBtn = overlay.querySelector('#uc-ai-classify-btn');
  const progressArea = overlay.querySelector('#uc-progress-area');
  const progressText = overlay.querySelector('#uc-progress-text');
  const progressCount = overlay.querySelector('#uc-progress-count');
  const progressBar = overlay.querySelector('#uc-progress-bar');
  const progressDetail = overlay.querySelector('#uc-progress-detail');

  aiBtn?.addEventListener('click', async () => {
    aiBtn.disabled = true;
    aiBtn.innerHTML = `${icons.robot()} 분류 진행 중...`;
    aiBtn.style.opacity = '0.5';
    progressArea.style.display = 'block';
    progressText.textContent = '배치 준비 중...';
    progressCount.textContent = '';
    progressBar.style.width = '0%';
    progressDetail.textContent = '';

    try {
      const result = await api.classifyUnclassified(groupTag, (prog) => {
        const pct = Math.round((prog.processed / prog.total) * 100);
        progressText.textContent = `배치 ${prog.batch}/${prog.maxBatches} 처리 중`;
        progressCount.textContent = `${prog.processed}/${prog.total}건 (${pct}%)`;
        progressBar.style.width = pct + '%';
        progressDetail.textContent = `분류 ${prog.classified}건 · 삭제 ${prog.deleted}건 · 키워드 ${prog.keywordsAdded}개`;
      });

      if (!result) {
        progressText.innerHTML = `${icons.warning()} 응답을 받지 못했습니다.`;
        return;
      }

      progressArea.style.display = 'none';

      const classifiedByCategory = {};
      if (result.classifiedDetail) {
        for (const item of result.classifiedDetail) {
          if (!classifiedByCategory[item.category]) classifiedByCategory[item.category] = [];
          classifiedByCategory[item.category].push(item);
        }
      }

      const kwGrouped = {};
      if (result.keywordsDetail) {
        for (const item of result.keywordsDetail) {
          if (!kwGrouped[item.category]) kwGrouped[item.category] = [];
          kwGrouped[item.category].push(item.keyword);
        }
      }

      const resultHtml = `
        <div class="rf-modal-overlay" id="uc-result-overlay">
          <div class="ucr-modal">
            <div class="ucr-header">
              <h3>AI 자동 분류 완료</h3>
            </div>

            <div class="ucr-summary">
              <div class="ucr-stat ucr-stat-blue">
                <div class="ucr-stat-num">${result.classified}</div>
                <div class="ucr-stat-label">소재 분류</div>
              </div>
              <div class="ucr-stat ucr-stat-red">
                <div class="ucr-stat-num">${result.deleted}</div>
                <div class="ucr-stat-label">삭제</div>
              </div>
              <div class="ucr-stat ucr-stat-purple">
                <div class="ucr-stat-num">${result.keywordsAdded}</div>
                <div class="ucr-stat-label">키워드 추가</div>
              </div>
            </div>

            <div class="ucr-body">
              ${result.classified > 0 ? `
                <div class="ucr-section">
                  <div class="ucr-section-title">소재별 분류 결과</div>
                  ${Object.entries(classifiedByCategory).map(([cat, items]) => `
                    <div class="ucr-group">
                      <div class="ucr-group-name">${cat} <span class="ucr-group-count">${items.length}건</span></div>
                      <div class="ucr-group-list">
                        ${items.map(v => `
                          <div class="ucr-item">
                            <span class="ucr-item-title">${v.title}</span>
                            <span class="ucr-item-channel">${v.channel}</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}

              ${result.deleted > 0 ? `
                <div class="ucr-section">
                  <div class="ucr-section-title ucr-section-red">삭제된 영상</div>
                  <div class="ucr-group-list">
                    ${(result.deletedDetail || []).map(v => `
                      <div class="ucr-item">
                        <span class="ucr-item-title">${v.title}</span>
                        <span class="ucr-item-channel">${v.channel}</span>
                      </div>
                    `).join('')}
                  </div>
                </div>
              ` : ''}

              ${result.keywordsAdded > 0 ? `
                <div class="ucr-section">
                  <div class="ucr-section-title ucr-section-purple">추가된 분류 키워드</div>
                  ${Object.entries(kwGrouped).map(([cat, kws]) => `
                    <div class="ucr-kw-row">
                      <span class="ucr-kw-cat">${cat}</span>
                      <div class="ucr-kw-tags">
                        ${kws.map(kw => `<span class="ucr-kw-tag">${kw}</span>`).join('')}
                      </div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>

            ${result.remaining > 0 ? `
              <div class="ucr-remaining">
                남은 미분류: <strong>${result.remaining}건</strong>
                ${result.error ? '<div class="ucr-retry">버튼을 다시 눌러 나머지를 처리하세요</div>' : ''}
              </div>
            ` : `
              <div class="ucr-alldone">모든 미분류 영상 처리 완료</div>
            `}

            <div class="ucr-footer">
              <button class="ucr-confirm" id="uc-result-confirm">확인</button>
            </div>
          </div>
        </div>
      `;

      document.body.insertAdjacentHTML('beforeend', resultHtml);
      const resultOverlay = document.getElementById('uc-result-overlay');

      const closeAndRefresh = () => {
        resultOverlay.remove();
        overlay.remove();
        const ucBtnMain = document.querySelector('#unclassified-btn');
        const ucCountMain = document.querySelector('#unclassified-count');
        if (ucBtnMain && ucCountMain) {
          ucCountMain.textContent = result.remaining;
          if (result.remaining === 0) ucBtnMain.style.display = 'none';
        }
        if (result.remaining > 0) {
          showUnclassifiedModal(api, groupTag);
        }
      };

      resultOverlay.querySelector('#uc-result-confirm').addEventListener('click', closeAndRefresh);
      resultOverlay.addEventListener('click', e => { if (e.target === resultOverlay) closeAndRefresh(); });

    } catch (err) {
      console.error('[AI분류] 오류:', err);
      progressText.innerHTML = `${icons.error()} 오류 발생`;
      progressDetail.textContent = '다시 시도해주세요.';
      progressDetail.style.color = '#ff6b6b';
    } finally {
      aiBtn.disabled = false;
      aiBtn.innerHTML = `${icons.robot()} AI 자동 분류`;
      aiBtn.style.opacity = '1';
    }
  });

  overlay.querySelectorAll('.uc-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('이 영상을 삭제하시겠습니까?\n삭제 후 재수집되지 않습니다.')) return;
      try {
        await api.deleteVideo(id);
        btn.closest('.uc-video-row').remove();
        updateCount();
        showToast('영상이 삭제되었습니다');
      } catch (err) { showToast('삭제 실패: ' + err.message); }
    });
  });

  overlay.querySelectorAll('.uc-classify-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const row = btn.closest('.uc-video-row');
      const catId = parseInt(row.querySelector('.uc-category-select').value);
      if (!catId) { showToast('분류를 선택해주세요'); return; }
      try {
        await api.updateVideoCategories(id, [catId]);
        row.remove();
        updateCount();
        showToast('분류가 완료되었습니다');
      } catch (err) { showToast('분류 실패: ' + err.message); }
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 주제 추천 플로우 공통 유틸
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function downloadTxt(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function safeCopy(text, btn) {
  function onSuccess() {
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '복사 완료!';
      setTimeout(function() { btn.textContent = orig; }, 2000);
    }
  }
  if (navigator.clipboard && document.hasFocus()) {
    navigator.clipboard.writeText(text).then(onSuccess);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    onSuccess();
  }
}

function showTtsConfirm(message, onConfirm) {
  const dlg = document.createElement('div');
  dlg.style.cssText = 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';
  dlg.innerHTML =
    '<div style="background:#1e1e2e;border:1px solid rgba(124,92,255,0.35);border-radius:14px;padding:28px 32px;max-width:360px;width:90%;text-align:center;">' +
      '<p style="color:#fff;font-size:15px;line-height:1.7;margin:0 0 24px;">' + message + '</p>' +
      '<div style="display:flex;gap:10px;justify-content:center;">' +
        '<button id="tts-dlg-cancel" style="padding:10px 24px;border-radius:8px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.7);font-size:14px;cursor:pointer;">취소</button>' +
        '<button id="tts-dlg-ok" style="padding:10px 24px;border-radius:8px;background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.4);color:#ef4444;font-size:14px;font-weight:600;cursor:pointer;">삭제</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(dlg);
  dlg.querySelector('#tts-dlg-ok').addEventListener('click', function() { dlg.remove(); onConfirm(); });
  dlg.querySelector('#tts-dlg-cancel').addEventListener('click', function() { dlg.remove(); });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 주제 추천 8단계 모달
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── localStorage 헬퍼 (flat tr_ 키, 보완 1) ──
function trGet(key) {
  return localStorage.getItem(key);
}
function trSet(key, value) {
  localStorage.setItem(key, String(value));
}
function trGetJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch(e) { return null; }
}
function trSetJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function trClear() {
  Object.keys(localStorage).filter(k => k.startsWith('tr_')).forEach(k => localStorage.removeItem(k));
}

async function openTopicRecommendModal(api, groupTag) {
  const existing = document.querySelector('.trm-overlay');
  if (existing) existing.remove();

  // 보완 2: 48시간 만료 체크
  const createdTs = trGet('tr_created');
  if (createdTs) {
    const elapsed = Date.now() - Number(createdTs);
    if (elapsed > 48 * 3600 * 1000) {
      trClear();
      showToast('이전 작업이 만료되어 처음부터 시작합니다.');
    }
  }
  if (!trGet('tr_created')) {
    trSet('tr_created', Date.now());
  }

  const overlay = document.createElement('div');
  overlay.className = 'trm-overlay';
  overlay.setAttribute('autocomplete', 'off');
  overlay.innerHTML = `
    <div class="trm-modal">
      <div class="trm-header">
        <div class="trm-header-steps">
          <div class="chv-container">
            <div class="chv-item active" id="trm-chv-1"><span class="chv-num">01</span> 지침</div>
            <div class="chv-item" id="trm-chv-2"><span class="chv-num">02</span> 주제</div>
            <div class="chv-item" id="trm-chv-3"><span class="chv-num">03</span> 썸지침</div>
            <div class="chv-item" id="trm-chv-4"><span class="chv-num">04</span> 썸입력</div>
            <div class="chv-item" id="trm-chv-5"><span class="chv-num">05</span> 소재</div>
            <div class="chv-item" id="trm-chv-6"><span class="chv-num">06</span> DNA</div>
            <div class="chv-item" id="trm-chv-7"><span class="chv-num">07</span> 글쓰기</div>
            <div class="chv-item" id="trm-chv-8"><span class="chv-num">08</span> 대본</div>
          </div>
        </div>
        <button class="trm-close" id="trm-close-btn">&times;</button>
      </div>

      <!-- 1단계: 지침 + TOP200 -->
      <div class="trm-step-body" id="trm-body-1">
        <div class="trm-step-title">1단계 \u2014 주제 추천 지침 + TOP200 복사</div>
        <div class="trm-step-desc">아래 내용을 복사하여 AI에게 붙여넣으세요.</div>
        <div class="trm-loading" id="trm-1-loading">지침과 TOP200 데이터를 불러오는 중...</div>
        <textarea class="trm-content-area" id="trm-1-content" readonly spellcheck="false" style="display:none;"></textarea>
        <div class="trm-footer trm-footer-center">
          <button class="trm-btn trm-btn-copy" id="trm-1-copy-btn" disabled>복사하기</button>
          <button class="trm-btn trm-btn-next" id="trm-1-next-btn" disabled>다음 단계로 →</button>
        </div>
      </div>

      <!-- 2단계: 주제 입력 -->
      <div class="trm-step-body trm-hidden" id="trm-body-2">
        <div class="trm-step-title">2단계 \u2014 주제 입력</div>
        <div class="trm-step-desc">AI가 생성한 주제를 아래에 입력하세요.</div>
        <div class="trm-field">
          <label class="trm-label">주제명</label>
          <input type="text" class="trm-input" id="trm-topic-title" placeholder="예: 장터에서 매맞는 머슴 하나 사왔더니 복이 쏟아졌다" autocomplete="off">
        </div>
        <div class="trm-footer trm-footer-center">
          <button class="trm-btn trm-btn-back" id="trm-2-back-btn">← 이전</button>
          <button class="trm-btn trm-btn-next" id="trm-2-next-btn" disabled>저장하고 다음 단계로</button>
        </div>
      </div>

      <!-- 3단계: 썸네일 지침 복사 -->
      <div class="trm-step-body trm-hidden" id="trm-body-3">
        <div class="trm-step-title">3단계 \u2014 썸네일 제목 추천 지침 복사</div>
        <div class="trm-step-desc">아래 내용을 복사하여 AI에게 붙여넣으세요.</div>
        <div class="trm-loading" id="trm-3-loading">썸네일 지침을 불러오는 중...</div>
        <textarea class="trm-content-area" id="trm-3-content" readonly spellcheck="false" style="display:none;"></textarea>
        <div class="trm-footer trm-footer-center">
          <button class="trm-btn trm-btn-back" id="trm-3-back-btn">← 이전</button>
          <button class="trm-btn trm-btn-copy" id="trm-3-copy-btn" disabled>복사하기</button>
          <button class="trm-btn trm-btn-next" id="trm-3-next-btn" disabled>다음 단계로 →</button>
        </div>
      </div>

      <!-- 4단계: 썸네일 제목 입력 -->
      <div class="trm-step-body trm-hidden" id="trm-body-4">
        <div class="trm-step-title">4단계 \u2014 썸네일 제목 입력</div>
        <div class="trm-step-desc">AI가 생성한 썸네일 제목을 아래에 입력하세요.</div>
        <div class="trm-field">
          <label class="trm-label">썸네일 제목</label>
          <p class="trm-field-hint">썸네일 제목으로 스토리 설계 프롬프트에 반영됩니다.</p>
          <textarea class="trm-textarea" id="trm-thumb-titles" placeholder="AI가 생성한 썸네일 제목들을 입력하세요. 여러 개인 경우 줄바꿈으로 구분하세요." autocomplete="off"></textarea>
        </div>
        <div class="trm-footer trm-footer-center">
          <button class="trm-btn trm-btn-back" id="trm-4-back-btn">← 이전</button>
          <button class="trm-btn trm-btn-next" id="trm-4-next-btn" disabled>다음 단계로 →</button>
        </div>
      </div>

      <!-- 5단계: 소재 추천 + 스크립트 다운로드 -->
      <div class="trm-step-body trm-hidden" id="trm-body-5">
        <div class="trm-step-title">5단계 \u2014 소재 추천 + 스크립트 다운로드</div>
        <div class="trm-step-desc">TOP50 인기 영상에서 중복되지 않는 소재 3가지를 추천합니다.</div>
        <div class="trm-loading trm-hidden" id="trm-5-material-loading">소재를 분석하는 중...</div>
        <button class="trm-btn trm-btn-secondary trm-hidden" id="trm-5-retry-btn" style="margin-bottom:12px;">소재 재추천 받기</button>
        <div id="trm-5-cards-area" class="trm-hidden"></div>
        <div class="trm-footer trm-footer-center">
          <button class="trm-btn trm-btn-back" id="trm-5-back-btn">← 이전</button>
          <button class="trm-btn trm-btn-primary" id="trm-5-material-btn">소재 추천 받기</button>
          <button class="trm-btn trm-btn-copy trm-hidden" id="trm-5-dl-all-btn">전체 다운로드</button>
          <button class="trm-btn trm-btn-next trm-hidden" id="trm-5-next-btn" disabled>다음 단계로 →</button>
        </div>
      </div>

      <!-- 6단계: DNA 분석 지침/결과 -->
      <div class="trm-step-body trm-hidden" id="trm-body-6">
        <div class="trm-step-title">6단계 \u2014 DNA 분석</div>
        <div class="trm-step-desc">외부에서 DNA 분석을 진행하고 결과를 붙여넣으세요.</div>
        <div style="margin-bottom:12px;">
          <button class="trm-btn trm-btn-copy" id="trm-6-copy-guide-btn">DNA 분석 지침 복사</button>
        </div>
        <div class="trm-field" style="flex-grow:1;">
          <label class="trm-label">DNA 분석 결과</label>
          <textarea class="trm-content-area" id="trm-6-result" rows="12" placeholder="분석 결과를 붙여넣으세요..." spellcheck="false"></textarea>
        </div>
        <div class="trm-footer trm-footer-center">
          <button class="trm-btn trm-btn-back" id="trm-6-back-btn">← 이전</button>
          <button class="trm-btn trm-btn-next" id="trm-6-next-btn">저장 후 다음 단계</button>
        </div>
      </div>

      <!-- 7단계: 글쓰기 프롬프트 얻기/결과 -->
      <div class="trm-step-body trm-hidden" id="trm-body-7">
        <div class="trm-step-title">7단계 \u2014 글쓰기 프롬프트</div>
        <div class="trm-step-desc">글쓰기 프롬프트를 외부에서 생성하고 결과를 붙여넣으세요.</div>
        <div style="margin-bottom:12px;">
          <button class="trm-btn trm-btn-copy" id="trm-7-copy-guide-btn">글쓰기 프롬프트 얻기 지침 복사</button>
        </div>
        <div class="trm-field" style="flex-grow:1;">
          <label class="trm-label">글쓰기 프롬프트 결과</label>
          <textarea class="trm-content-area" id="trm-7-result" rows="12" placeholder="생성된 프롬프트를 붙여넣으세요..." spellcheck="false"></textarea>
        </div>
        <div class="trm-footer trm-footer-center">
          <button class="trm-btn trm-btn-back" id="trm-7-back-btn">← 이전</button>
          <button class="trm-btn trm-btn-next" id="trm-7-next-btn">저장 후 다음 단계</button>
        </div>
      </div>

      <!-- 8단계: 최종 대본 입력 -->
      <div class="trm-step-body trm-hidden" id="trm-body-8">
        <div class="trm-step-title">8단계 \u2014 최종 대본</div>
        <div class="trm-step-desc">최종 대본을 붙여넣고 저장하세요.</div>
        <div class="trm-field" style="flex-grow:1;">
          <label class="trm-label">최종 대본</label>
          <textarea class="trm-content-area" id="trm-8-script" rows="16" placeholder="완성된 대본을 붙여넣으세요..." spellcheck="false"></textarea>
        </div>
        <div class="trm-footer trm-footer-center">
          <button class="trm-btn trm-btn-back" id="trm-8-back-btn">← 이전</button>
          <button class="trm-btn trm-btn-copy" id="trm-8-dl-btn" disabled>대본 다운로드</button>
          <button class="trm-btn trm-btn-primary" id="trm-8-save-btn">저장하고 완료</button>
        </div>
      </div>
    </div>
  `

  document.body.appendChild(overlay);

  // ── 커스텀 confirm 다이얼로그 (native dialog 대체 — focus 손실 방지) ──
  function trConfirm(savedStep) {
    return new Promise(function(resolve) {
      const dlg = document.createElement('div');
      dlg.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';
      dlg.innerHTML =
        '<div style="background:#1e1e2e;border:1px solid rgba(124,92,255,0.35);border-radius:14px;padding:32px 36px;max-width:380px;width:90%;text-align:center;">' +
          '<p style="color:#fff;font-size:15px;line-height:1.7;margin:0 0 8px;font-weight:700;">이전 작업이 있습니다</p>' +
          '<p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 28px;">' + (savedStep && Number(savedStep) > 1 ? savedStep + '단계까지 진행한 내용이' : '이전에 진행한 내용이') + ' 저장되어 있습니다.</p>' +
          '<div style="display:flex;gap:12px;justify-content:center;">' +
            '<button id="tr-dlg-new" style="padding:10px 22px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.07);color:#ccc;font-size:14px;cursor:pointer;">새로 시작</button>' +
            '<button id="tr-dlg-resume" style="padding:10px 22px;border-radius:8px;border:none;background:linear-gradient(90deg,#5b21b6,#7c3aed);color:#fff;font-size:14px;cursor:pointer;font-weight:600;">이어서 진행 →</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(dlg);
      dlg.querySelector('#tr-dlg-resume').addEventListener('click', function() { dlg.remove(); resolve(true); });
      dlg.querySelector('#tr-dlg-new').addEventListener('click', function() { dlg.remove(); resolve(false); });
    });
  }

  // ── 유틸 ──
  function updateChevronSteps(activeIdx) {
    overlay.querySelectorAll('.chv-item').forEach((el, i) => {
      el.classList.remove('active', 'done');
      if (i < activeIdx) el.classList.add('done');
      if (i === activeIdx) el.classList.add('active');
    });
  }

  function showStep(n) {
    [1, 2, 3, 4, 5, 6, 7, 8].forEach(i => {
      const body = overlay.querySelector('#trm-body-' + i);
      if (body) body.classList.toggle('trm-hidden', i !== n);
    });
    updateChevronSteps(n - 1);
    trSet('tr_step', n);
  }

  function copyToClipboard(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) throw new Error('클립보드 복사 실패');
  }

  // ── 닫기 버튼 (X) — 데이터 보존하며 닫기 ──
  overlay.querySelector('#trm-close-btn').addEventListener('click', () => {
    overlay.remove();
  });

  // ── 1단계 초기화 ──
  async function initStep1() {
    const body = overlay.querySelector('#trm-body-1');
    if (body.dataset.bound) return;
    body.dataset.bound = 'true';
    const loadingEl = overlay.querySelector('#trm-1-loading');
    const contentEl = overlay.querySelector('#trm-1-content');
    const copyBtn = overlay.querySelector('#trm-1-copy-btn');
    const nextBtn = overlay.querySelector('#trm-1-next-btn');

    // 보완 1: 저장된 guideline 복원 (서버 재호출 없이)
    const saved = trGet('tr_guideline');
    if (saved) {
      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';
      contentEl.value = saved;
      copyBtn.disabled = false;
      nextBtn.disabled = false;
      return;
    }

    try {
      const [guidelineRes, top200Res] = await Promise.all([
        api.request(`/guidelines?type=topic_prompt&category=${encodeURIComponent(groupTag)}`),
        api.getTop200Titles(groupTag)
      ]);

      const guidelines = Array.isArray(guidelineRes) ? guidelineRes : [];
      const activeGuideline = guidelines.find(g => g.is_active) || guidelines[0];

      // 보완 3: 지침 미등록 처리
      if (!activeGuideline) {
        loadingEl.textContent = '설정 > 지침 관리에서 주제 추천 지침을 먼저 등록해주세요.';
        copyBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }

      const detail = await api.request('/guidelines/' + activeGuideline.id);
      const guidelineContent = detail.content || '';
      const titles = top200Res.titles || [];

      // 보완 1: TOP200 스냅샷 저장
      trSetJSON('tr_top200_snapshot', titles);

      // 보완 10: 번호 부여 형식
      const top200Text = '\n\n[TOP200 인기 영상 제목]\n' +
        titles.map((t, i) => (i + 1) + '. ' + t).join('\n');
      const fullContent = guidelineContent + top200Text;

      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';
      contentEl.value = fullContent;
      copyBtn.disabled = false;
      nextBtn.disabled = false;

      // 보완 1: guideline 전체 저장
      trSet('tr_guideline', fullContent);
    } catch (e) {
      loadingEl.textContent = '데이터 로드 실패: ' + e.message;
    }
  }

  // 복사하기 버튼 — 복사만, 자동 전환 없음
  overlay.querySelector('#trm-1-copy-btn').addEventListener('click', async () => {
    const content = overlay.querySelector('#trm-1-content').value;
    if (!content) return;
    const btn = overlay.querySelector('#trm-1-copy-btn');
    try {
      copyToClipboard(content);
      btn.textContent = '복사 완료!';
      btn.classList.add('trm-btn-copied');
      setTimeout(function() {
        btn.textContent = '복사하기';
        btn.classList.remove('trm-btn-copied');
      }, 2000);
    } catch (e) {
      alert('복사 실패: ' + e.message);
    }
  });

  // 다음 단계로 버튼
  overlay.querySelector('#trm-1-next-btn').addEventListener('click', () => {
    showStep(2);
    initStep2();
  });

  // ── 2단계 초기화 ──
  function initStep2() {
    const body = overlay.querySelector('#trm-body-2');
    const titleInput = overlay.querySelector('#trm-topic-title');
    const nextBtn = overlay.querySelector('#trm-2-next-btn');

    if (!body.dataset.bound) {
      body.dataset.bound = 'true';

      // 복원
      titleInput.value = trGet('tr_topic_title') || '';

      function checkInputs() {
        nextBtn.disabled = !titleInput.value.trim();
      }

      // 실시간 임시저장 (500ms 딜레이)
      let debTimer = null;
      function autoSave() {
        clearTimeout(debTimer);
        debTimer = setTimeout(function() {
          trSet('tr_topic_title', titleInput.value.trim());
        }, 500);
      }

      titleInput.addEventListener('input', function() { checkInputs(); autoSave(); });
      checkInputs();

      overlay.querySelector('#trm-2-back-btn').addEventListener('click', function() { showStep(1); initStep1(); });
      nextBtn.addEventListener('click', function() {
        trSet('tr_topic_title', titleInput.value.trim());
        showStep(3);
        initStep3();
      });
    }

    nextBtn.disabled = !titleInput.value.trim();
  }

  // ── 3단계 초기화 ──
  async function initStep3() {
    const body = overlay.querySelector('#trm-body-3');
    if (body.dataset.bound) return;
    body.dataset.bound = 'true';
    const loadingEl = overlay.querySelector('#trm-3-loading');
    const contentEl = overlay.querySelector('#trm-3-content');
    const copyBtn = overlay.querySelector('#trm-3-copy-btn');
    const nextBtn = overlay.querySelector('#trm-3-next-btn');

    loadingEl.style.display = 'block';
    contentEl.style.display = 'none';
    copyBtn.disabled = true;
    copyBtn.textContent = '복사하기';
    copyBtn.classList.remove('trm-btn-copied');
    nextBtn.disabled = true;

    const topicTitle = trGet('tr_topic_title') || '';

    // 보완 1: tr_thumb_guideline 원본 저장된 경우 복원 (주제명 재삽입)
    const savedRaw = trGet('tr_thumb_guideline');
    if (savedRaw) {
      const marker = '[고정된 이야기 주제]';
      let content = savedRaw;
      if (content.includes(marker) && topicTitle) {
        content = content.replace(marker, marker + '\n' + topicTitle);
      }
      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';
      contentEl.value = content;
      copyBtn.disabled = false;
      nextBtn.disabled = false;
      return;
    }

    try {
      const guidelineRes = await api.request(`/guidelines?type=thumbnail_prompt&category=${encodeURIComponent(groupTag)}`);
      const guidelines = Array.isArray(guidelineRes) ? guidelineRes : [];
      const activeGuideline = guidelines.find(g => g.is_active) || guidelines[0];

      if (!activeGuideline) {
        loadingEl.textContent = '설정 > 지침 관리에서 썸네일 제목 추천 지침을 먼저 등록해주세요.';
        copyBtn.disabled = true; nextBtn.disabled = true;
        return;
      }

      const detail = await api.request('/guidelines/' + activeGuideline.id);
      const rawContent = detail.content || '';

      trSet('tr_thumb_guideline', rawContent);

      // 제목 레퍼런스 DB에서 가져와서 플레이스홀더 치환
      let content = rawContent;
      const refRes = await api.getThumbReferences();
      const refList = refRes.references || [];
      if (refList.length > 0) {
        const refText = refList.map(r => r.number + '. ' + r.title).join('\n');
        if (content.includes('{{THUMB_TITLE_REFERENCES}}')) {
          content = content.replace('{{THUMB_TITLE_REFERENCES}}', refText);
        }
        // [썸네일 제목 참고 데이터] 없는 경우: 기존 content 그대로 사용
      }

      const marker = '[고정된 이야기 주제]';
      if (content.includes(marker) && topicTitle) {
        content = content.replace(marker, marker + '\n' + topicTitle);
      }

      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';
      contentEl.value = content;
      copyBtn.disabled = false;
      nextBtn.disabled = false;
    } catch (e) {
      loadingEl.textContent = '데이터 로드 실패: ' + e.message;
    }
  }

  overlay.querySelector('#trm-3-back-btn').addEventListener('click', function() {
    showStep(2);
    initStep2();
  });

  // 복사하기 버튼 — 복사만, 자동 전환 없음
  overlay.querySelector('#trm-3-copy-btn').addEventListener('click', async () => {
    const content = overlay.querySelector('#trm-3-content').value;
    if (!content) return;
    const btn = overlay.querySelector('#trm-3-copy-btn');
    try {
      copyToClipboard(content);
      btn.textContent = '복사 완료!';
      btn.classList.add('trm-btn-copied');
      setTimeout(function() {
        btn.textContent = '복사하기';
        btn.classList.remove('trm-btn-copied');
      }, 2000);
    } catch (e) {
      alert('복사 실패: ' + e.message);
    }
  });

  // 다음 단계로 버튼
  overlay.querySelector('#trm-3-next-btn').addEventListener('click', () => {
    showStep(4);
    initStep4();
  });

  // ── 4단계 초기화 ──
  function initStep4() {
    const body = overlay.querySelector('#trm-body-4');
    const thumbInput = overlay.querySelector('#trm-thumb-titles');
    const nextBtn = overlay.querySelector('#trm-4-next-btn');

    // 포커스는 매번 (Electron native dialog 후 focus 손실 방지)
    setTimeout(function() { thumbInput.focus(); }, 50);

    if (body.dataset.bound) {
      nextBtn.disabled = !thumbInput.value.trim();
      return;
    }
    body.dataset.bound = 'true';

    // 복원
    thumbInput.value = trGet('tr_thumb_titles') || '';

    function checkInput() { nextBtn.disabled = !thumbInput.value.trim(); }

    // 실시간 임시저장 (500ms 딜레이)
    let debTimer = null;
    function autoSave() {
      clearTimeout(debTimer);
      debTimer = setTimeout(function() {
        trSet('tr_thumb_titles', thumbInput.value);
        const firstLine = thumbInput.value.split('\n')[0].trim();
        trSet('tr_thumb_title_main', firstLine);
      }, 500);
    }

    thumbInput.addEventListener('input', function() { checkInput(); autoSave(); });
    checkInput();

    // 이전 단계 이동
    overlay.querySelector('#trm-4-back-btn').addEventListener('click', function() {
      showStep(3);
      initStep3();
    });

    // 다음 단계로
    nextBtn.addEventListener('click', function() {
      const thumbText = thumbInput.value.trim();
      if (!thumbText) return;
      trSet('tr_thumb_titles', thumbText);
      const firstLine = thumbText.split('\n')[0].trim();
      trSet('tr_thumb_title_main', firstLine);
      showStep(5);
      initStep5();
    });
  }

  // ── 5단계 초기화 (소재 추천) ──
  async function initStep5() {
    const materialBtn = overlay.querySelector('#trm-5-material-btn');
    const loadingEl   = overlay.querySelector('#trm-5-material-loading');
    const cardsArea   = overlay.querySelector('#trm-5-cards-area');
    const dlAllBtn    = overlay.querySelector('#trm-5-dl-all-btn');
    const nextBtn     = overlay.querySelector('#trm-5-next-btn');
    const backBtn     = overlay.querySelector('#trm-5-back-btn');
    const retryBtn    = overlay.querySelector('#trm-5-retry-btn');

    // ── 뒤로가기 ──
    if (!backBtn.dataset.bound) {
      backBtn.dataset.bound = 'true';
      backBtn.addEventListener('click', function() {
        showStep(4); initStep4();
      });
    }

    // ── 초기 상태 설정 ──
    var savedMaterials = trGet('tr_material_data');
    if (savedMaterials) {
      try {
        var mats = JSON.parse(savedMaterials);
        if (mats && mats.length > 0) {
          renderCards(mats);
        } else {
          resetUI();
          materialBtn.style.display = '';
          materialBtn.disabled = false;
          materialBtn.textContent = '소재 추천 받기';
        }
      } catch(e) {
        resetUI();
        materialBtn.style.display = '';
        materialBtn.disabled = false;
        materialBtn.textContent = '소재 추천 받기';
      }
    } else {
      resetUI();
      materialBtn.style.display = '';
      materialBtn.disabled = false;
      materialBtn.textContent = '소재 추천 받기';
    }

    // ── 소재 추천 버튼 (매번 API 호출) ──
    materialBtn.onclick = async function() {
      materialBtn.disabled = true;
      materialBtn.textContent = '소재 추천 중...';
      loadingEl.style.display = '';
      loadingEl.classList.remove('trm-hidden');
      try {
        let currentExclude = [];
        try {
          currentExclude = JSON.parse(
            trGet('tr_exclude_materials') || '[]'
          );
        } catch(e) {}
        const result = await api.recommendMaterials({
          limit: 50,
          genre: groupTag,
          exclude_ids: currentExclude
        });
        if (!result.success || !result.materials) {
          throw new Error(result.error || '소재 추천 실패');
        }
        trSet('tr_material_data', JSON.stringify(result.materials));
        if (result.materials.length === 0) {
          localStorage.removeItem('tr_exclude_materials');
          showToast('추천 가능한 소재를 모두 확인했습니다. 다시 추천합니다.', 'info');
          materialBtn.disabled = false;
          materialBtn.textContent = '소재 추천 받기';
          loadingEl.classList.add('trm-hidden');
          return;
        }
        if (result.materials.length < 3) {
          showToast(result.materials.length + '개의 소재만 추천 가능합니다.', 'info');
        }
        renderCards(result.materials);
      } catch(e) {
        showToast('소재 추천 실패: ' + e.message, 'error');
        materialBtn.disabled = false;
        materialBtn.textContent = '소재 추천 받기';
        loadingEl.classList.add('trm-hidden');
      }
    };

    // ── 재추천 버튼 ──
    retryBtn.onclick = function() {
      let excludeList = [];
      try {
        const prev = JSON.parse(trGet('tr_exclude_materials') || '[]');
        const current = JSON.parse(trGet('tr_material_data') || '[]');
        const currentIds = [];
        current.forEach(function(item) {
          if (item.video_id) currentIds.push(item.video_id);
        });
        excludeList = [...new Set([...prev, ...currentIds])];
      } catch(e) {}
      trSet('tr_exclude_materials', JSON.stringify(excludeList));
      localStorage.removeItem('tr_material_data');
      resetUI();
      materialBtn.style.display = '';
      materialBtn.disabled = false;
      materialBtn.textContent = '소재 추천 받기';
    };

    // ── 다음 단계 ──
    nextBtn.onclick = function() {
      showStep(6); initStep6();
    };

    // ── UI 초기화 함수 ──
    function resetUI() {
      cardsArea.innerHTML = '';
      cardsArea.classList.add('trm-hidden');
      dlAllBtn.classList.add('trm-hidden');
      nextBtn.classList.add('trm-hidden');
      nextBtn.disabled = true;
      retryBtn.classList.add('trm-hidden');
      loadingEl.style.display = '';
      loadingEl.classList.add('trm-hidden');
    }

    // ── 카드 렌더링 함수 ──
    function renderCards(materials) {
      materialBtn.style.display = 'none';
      loadingEl.classList.add('trm-hidden');
      cardsArea.classList.remove('trm-hidden');
      dlAllBtn.classList.remove('trm-hidden');
      nextBtn.classList.remove('trm-hidden');
      nextBtn.disabled = false;
      retryBtn.classList.remove('trm-hidden');

      function fmtNum(n) {
        if (!n) return '0';
        if (n >= 10000) return (n / 10000).toFixed(1) + '만';
        return Number(n).toLocaleString();
      }
      function fmtDur(sec) {
        if (!sec) return '';
        return Math.floor(sec / 60) + '분 ' + (sec % 60) + '초';
      }
      function fmtDate(dateStr) {
        if (!dateStr) return '';
        var d = new Date(dateStr);
        var days = Math.floor((Date.now() - d.getTime()) / 86400000);
        return d.getFullYear() + '. ' +
          String(d.getMonth() + 1).padStart(2, '0') + '. ' +
          String(d.getDate()).padStart(2, '0') + '. (' + days + '일 전)';
      }
      function gradeClass(ratio) {
        if (ratio >= 500) return 'spike-grade-super';
        if (ratio >= 300) return 'spike-grade-great';
        if (ratio >= 150) return 'spike-grade-great';
        if (ratio >= 80) return 'spike-grade-good';
        return '';
      }
      function gradeLabel(ratio) {
        if (ratio >= 500) return '초대박';
        if (ratio >= 300) return '대박';
        if (ratio >= 150) return '떡상';
        if (ratio >= 80) return '선방';
        return '보통';
      }
      var catColors = {
        REL: '#4a90d9', EVT: '#e67e22', EMO: '#9b59b6',
        TWIST: '#27ae60', OTHER: '#7f8c8d'
      };

      cardsArea.innerHTML = materials.map(function(m, idx) {
        var ytUrl = 'https://www.youtube.com/watch?v=' + m.video_id_youtube;
        var thumbSrc = m.thumbnail_url ||
          ('https://i.ytimg.com/vi/' + m.video_id_youtube + '/mqdefault.jpg');
        var ratio = parseFloat(m.spike_ratio) || 0;
        var gClass = gradeClass(ratio);
        var gLabel = gradeLabel(ratio);
        var catColor = catColors[m.category] || '#7f8c8d';
        var dlBtn = m.has_transcript
          ? '<button class="trm-btn trm-btn-copy trm-mat-dl-btn" data-idx="' + idx + '">스크립트 다운로드</button>'
          : '<span style="color:#888;font-size:12px;">자막 없음</span>';

        return '<div class="spike-video-item" data-idx="' + idx + '">' +
          '<div class="spike-video-thumb-area">' +
            '<a href="' + ytUrl + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
              '<div class="spike-video-thumb">' +
                '<img src="' + thumbSrc + '" alt="" loading="lazy" ' +
                  'onerror="this.src=\'https://i.ytimg.com/vi/' + m.video_id_youtube + '/mqdefault.jpg\'">' +
                '<div class="spike-video-thumb-play"><span>▶</span></div>' +
              '</div>' +
            '</a>' +
            '<div class="spike-video-rank-badge">' + (idx + 1) + '위</div>' +
          '</div>' +
          '<div class="spike-video-info">' +
            '<div class="spike-video-title-row">' +
              '<a class="spike-video-title-link" href="' + ytUrl + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + m.title + '</a>' +
              '<span style="background:' + catColor + ';color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:700;flex-shrink:0;">' + m.category_label + '</span>' +
            '</div>' +
            '<div class="spike-video-meta">' +
              '<span class="spike-meta-channel">' + (m.channel_name || '') + '</span>' +
              (m.subscriber_count ? '<span class="spike-meta-divider">\u2503</span><span>구독자 ' + fmtNum(m.subscriber_count) + '</span>' : '') +
            '</div>' +
            '<div class="spike-video-stats">' +
              '<div class="spike-stats-row">' +
                (m.daily_avg_views ? '<span class="spike-stat spike-stat-ratio">일평균 ' + fmtNum(m.daily_avg_views) + '회</span>' : '') +
                (ratio ? '<span class="spike-stat spike-stat-ratio">떡상 ' + ratio.toFixed(1) + '배</span>' : '') +
                (gLabel ? '<span class="spike-stat ' + gClass + '">' + gLabel + '</span>' : '') +
              '</div>' +
              '<div class="spike-stats-row">' +
                (m.view_count ? '<span class="spike-stat spike-stat-views">조회수 ' + fmtNum(m.view_count) + '</span>' : '') +
                (m.duration_seconds ? '<span class="spike-stat">\u23f1 ' + fmtDur(m.duration_seconds) + '</span>' : '') +
              '</div>' +
            '</div>' +
            (m.published_at ? '<div class="spike-card-date">' + fmtDate(m.published_at) + '</div>' : '') +
            '<div style="margin-top:8px;">' + dlBtn + '</div>' +
          '</div>' +
        '</div>';
      }).join('');

      // 개별 다운로드
      cardsArea.querySelectorAll('.trm-mat-dl-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var m = materials[Number(btn.dataset.idx)];
          if (m && m.transcript_raw) {
            downloadTxt(
              m.title.substring(0, 30) + '_스크립트.txt',
              m.transcript_raw
            );
          }
        });
      });

      // 전체 다운로드 (매번 새로 바인딩)
      dlAllBtn.onclick = function() {
        materials.forEach(function(m) {
          if (m.transcript_raw) {
            downloadTxt(
              m.title.substring(0, 30) + '_스크립트.txt',
              m.transcript_raw
            );
          }
        });
      };
    }
  }

  // ── 6단계 초기화 (DNA 분석) ──
  async function initStep6() {
    const body         = overlay.querySelector('#trm-body-6');
    const copyGuideBtn = overlay.querySelector('#trm-6-copy-guide-btn');
    const textarea     = overlay.querySelector('#trm-6-result');
    const nextBtn      = overlay.querySelector('#trm-6-next-btn');
    const backBtn      = overlay.querySelector('#trm-6-back-btn');

    textarea.value = trGet('tr_dna_analysis_result') || '';
    setTimeout(function() { textarea.focus(); }, 50);

    if (body.dataset.bound) return;
    body.dataset.bound = 'true';

    if (!backBtn.dataset.bound) {
      backBtn.dataset.bound = 'true';
      backBtn.addEventListener('click', function() { showStep(5); initStep5(); });
    }

    if (!copyGuideBtn.dataset.bound) {
      copyGuideBtn.dataset.bound = 'true';
      copyGuideBtn.addEventListener('click', async function() {
        try {
          const res = await api.request(`/guidelines?type=dna_analysis_guide&active=1&category=${encodeURIComponent(groupTag)}`);
          const guides = Array.isArray(res) ? res : [];
          const active = guides.find(function(g) { return g.is_active; }) || guides[0];
          if (!active) {
            showToast('설정에서 DNA 분석 지침을 먼저 등록해주세요.', 'warning');
            return;
          }
          const detail = await api.request('/guidelines/' + active.id);
          await navigator.clipboard.writeText(detail.content || '');
          const orig = copyGuideBtn.textContent;
          copyGuideBtn.textContent = '복사 완료!';
          setTimeout(function() { copyGuideBtn.textContent = orig; }, 2000);
        } catch(e) {
          showToast('DNA 분석 지침 복사 실패: ' + e.message, 'error');
        }
      });
    }

    if (!nextBtn.dataset.bound) {
      nextBtn.dataset.bound = 'true';
      nextBtn.addEventListener('click', function() {
        const val = textarea.value.trim();
        if (!val) { showToast('분석 결과를 입력해주세요.', 'warning'); return; }
        trSet('tr_dna_analysis_result', val);
        showStep(7);
        initStep7();
      });
    }
  }

  // ── 7단계 초기화 (글쓰기 프롬프트) ──
  async function initStep7() {
    const body         = overlay.querySelector('#trm-body-7');
    const copyGuideBtn = overlay.querySelector('#trm-7-copy-guide-btn');
    const textarea     = overlay.querySelector('#trm-7-result');
    const nextBtn      = overlay.querySelector('#trm-7-next-btn');
    const backBtn      = overlay.querySelector('#trm-7-back-btn');

    textarea.value = trGet('tr_writing_prompt_result') || '';
    setTimeout(function() { textarea.focus(); }, 50);

    if (body.dataset.bound) return;
    body.dataset.bound = 'true';

    if (!backBtn.dataset.bound) {
      backBtn.dataset.bound = 'true';
      backBtn.addEventListener('click', function() { showStep(6); initStep6(); });
    }

    if (!copyGuideBtn.dataset.bound) {
      copyGuideBtn.dataset.bound = 'true';
      copyGuideBtn.addEventListener('click', async function() {
        try {
          const res = await api.request(`/guidelines?type=writing_prompt_guide&active=1&category=${encodeURIComponent(groupTag)}`);
          const guides = Array.isArray(res) ? res : [];
          const active = guides.find(function(g) { return g.is_active; }) || guides[0];
          if (!active) {
            showToast('설정에서 글쓰기 프롬프트 얻기 지침을 먼저 등록해주세요.', 'warning');
            return;
          }
          const detail = await api.request('/guidelines/' + active.id);
          await navigator.clipboard.writeText(detail.content || '');
          const orig = copyGuideBtn.textContent;
          copyGuideBtn.textContent = '복사 완료!';
          setTimeout(function() { copyGuideBtn.textContent = orig; }, 2000);
        } catch(e) {
          showToast('글쓰기 프롬프트 지침 복사 실패: ' + e.message, 'error');
        }
      });
    }

    if (!nextBtn.dataset.bound) {
      nextBtn.dataset.bound = 'true';
      nextBtn.addEventListener('click', function() {
        const val = textarea.value.trim();
        if (!val) { showToast('프롬프트 결과를 입력해주세요.', 'warning'); return; }
        trSet('tr_writing_prompt_result', val);
        showStep(8);
        initStep8();
      });
    }
  }

  // ── 8단계 초기화 (최종 대본) ──
  function initStep8() {
    const body     = overlay.querySelector('#trm-body-8');
    const textarea = overlay.querySelector('#trm-8-script');
    const dlBtn    = overlay.querySelector('#trm-8-dl-btn');
    const saveBtn  = overlay.querySelector('#trm-8-save-btn');
    const backBtn  = overlay.querySelector('#trm-8-back-btn');

    textarea.value = trGet('tr_final_script') || '';
    dlBtn.disabled = !textarea.value.trim();
    setTimeout(function() { textarea.focus(); }, 50);

    if (body.dataset.bound) return;
    body.dataset.bound = 'true';

    backBtn.addEventListener('click', function() { showStep(7); initStep7(); });

    textarea.addEventListener('input', function() {
      dlBtn.disabled = !textarea.value.trim();
      trSet('tr_final_script', textarea.value);
    });

    dlBtn.addEventListener('click', function() {
      if (!textarea.value.trim()) return;
      const title = trGet('tr_topic_title') || '대본';
      downloadTxt(title + '_최종대본.txt', textarea.value);
    });

    saveBtn.addEventListener('click', async function() {
        const script = textarea.value.trim();
        if (!script) { showToast('대본을 입력해주세요.', 'warning'); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = '저장 중...';
        try {
          const thumbText = trGet('tr_thumb_titles') || '';
          const thumbLines = thumbText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
          await api.saveRecommendation({
            topic_title:           trGet('tr_topic_title') || '',
            topic_summary:         '',
            thumb_titles:          thumbLines,
            thumb_title_main:      trGet('tr_thumb_title_main') || '',
            group_tag:             groupTag,
            selected_dna_id:       null,
            story_prompt:          '',
            story_guideline_id:    null,
            material_data:         trGet('tr_material_data') || '',
            dna_analysis_result:   trGet('tr_dna_analysis_result') || '',
            writing_prompt_result: trGet('tr_writing_prompt_result') || '',
            final_script:          script
          });
          for (let i = 1; i <= 8; i++) {
            const body = overlay.querySelector('#trm-body-' + i);
            if (body) delete body.dataset.bound;
          }
          trClear();
          overlay.remove();
          showToast('주제가 저장되었습니다.', 'success');
        } catch(e) {
          saveBtn.disabled = false;
          saveBtn.textContent = '저장하고 완료';
          showToast('저장 실패: ' + e.message, 'error');
        }
      });
  }

  // ── 저장된 상태 복원 (이어서 / 새로 시작) ──
  const savedStep = trGet('tr_step');
  const hasTrData = Object.keys(localStorage).some(k => k.startsWith('tr_'));
  (async function() {
    if (hasTrData) {
      const resume = await trConfirm(savedStep);
      if (!resume) {
        trClear();
        for (let i = 1; i <= 8; i++) {
          const body = overlay.querySelector('#trm-body-' + i);
          if (body) delete body.dataset.bound;
        }
        const _materialBtn = overlay.querySelector('#trm-5-material-btn');
        if (_materialBtn) {
          _materialBtn.style.display = '';
          _materialBtn.disabled = false;
          _materialBtn.textContent = '소재 추천 받기';
          _materialBtn.onclick = null;
        }
        const _retryBtn = overlay.querySelector('#trm-5-retry-btn');
        if (_retryBtn) {
          _retryBtn.classList.add('trm-hidden');
          _retryBtn.onclick = null;
        }
        const _dlAllBtn = overlay.querySelector('#trm-5-dl-all-btn');
        if (_dlAllBtn) {
          _dlAllBtn.classList.add('trm-hidden');
          _dlAllBtn.onclick = null;
        }
        const _nextBtn = overlay.querySelector('#trm-5-next-btn');
        if (_nextBtn) {
          _nextBtn.classList.add('trm-hidden');
          _nextBtn.disabled = true;
          _nextBtn.onclick = null;
        }
        const _loadingEl = overlay.querySelector('#trm-5-material-loading');
        if (_loadingEl) {
          _loadingEl.style.display = '';
          _loadingEl.classList.add('trm-hidden');
        }
        const _cardsArea = overlay.querySelector('#trm-5-cards-area');
        if (_cardsArea) {
          _cardsArea.innerHTML = '';
          _cardsArea.classList.add('trm-hidden');
        }
      }
    }
    const resumeStep = Number(trGet('tr_step') || 1);
    showStep(resumeStep);
    if (resumeStep === 1) initStep1();
    else if (resumeStep === 2) initStep2();
    else if (resumeStep === 3) initStep3();
    else if (resumeStep === 4) initStep4();
    else if (resumeStep === 5) initStep5();
    else if (resumeStep === 6) initStep6();
    else if (resumeStep === 7) initStep7();
    else if (resumeStep === 8) initStep8();
  })();
}


function openTopicHistoryModal(api, groupTag) {
  const existingOverlay = document.querySelector('.th-overlay');
  if (existingOverlay) existingOverlay.remove();

  const overlay = document.createElement('div');
  overlay.className = 'th-overlay';

  overlay.innerHTML = `
    <div class="th-modal">
      <div class="th-header">
        <div class="th-header-left">
          <span class="th-header-title">추천 이력</span>
          <span class="th-header-count" id="th-count"></span>
        </div>
        <div class="th-header-right">
          <select class="th-genre-filter" id="th-genre-filter">
            <option value="">전체 장르</option>
          </select>
          <input type="text" class="th-search" id="th-search" placeholder="주제명으로 검색...">
          <button class="th-close-btn" id="th-close-btn">&times;</button>
        </div>
      </div>
      <div class="th-body" id="th-body">
        <div class="th-loading">이력을 불러오는 중...</div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const body = overlay.querySelector('#th-body');
  const genreFilter = overlay.querySelector('#th-genre-filter');
  const searchInput = overlay.querySelector('#th-search');
  const countEl = overlay.querySelector('#th-count');

  overlay.querySelector('#th-close-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  let allItems = [];

  async function initFilters() {
    try {
      const catData = await api.getChannelCategories();
      const validCats = (catData.categories || []).filter(c => c.material_group_name);
      const genres = [...new Set(validCats.map(c => c.genre || c.name).filter(Boolean))];
      genres.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        genreFilter.appendChild(opt);
      });
    } catch(e) {
      console.error('[이력필터초기화오류]', e);
    }
  }

  async function loadHistory() {
    const selectedGenre = genreFilter.value;
    body.innerHTML = '<div class="th-loading">이력을 불러오는 중...</div>';
    try {
      const params = new URLSearchParams();
      if (selectedGenre) params.append('group_tag', selectedGenre);
      params.append('limit', '200');
      const data = await api.request('/topics/recommendations-history?' + params.toString());
      allItems = data.outputs || [];
      renderList(allItems, searchInput.value.trim());
    } catch(err) {
      body.innerHTML = '<div class="th-empty">이력을 불러오는 중 오류가 발생했습니다.</div>';
      console.error('[이력로드오류]', err);
    }
  }

  function renderList(items, searchQuery) {
    const filtered = searchQuery
      ? items.filter(item => (item.topic_title || '').includes(searchQuery))
      : items;

    countEl.textContent = filtered.length + '건';

    if (filtered.length === 0) {
      body.innerHTML = '<div class="th-empty">' + (searchQuery ? '검색 결과가 없습니다.' : '추천 이력이 없습니다.') + '</div>';
      return;
    }

    const listEl = document.createElement('div');
    listEl.className = 'th-list';

    filtered.forEach((item) => {
      const recId = item.id;
      const date = new Date(item.created_at).toLocaleDateString('ko-KR', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });

      const genreName = item.group_tag || '';
      const topicTitle = item.topic_title || '주제명 없음';
      const hasDna = !!item.selected_dna_id;
      const hasPrompt = !!(item.story_prompt && item.story_prompt.trim());

      let thumbTitles = [];
      try {
        thumbTitles = typeof item.thumb_titles === 'string'
          ? JSON.parse(item.thumb_titles) : (item.thumb_titles || []);
      } catch(e) { thumbTitles = []; }

      let dnaVideoTitle = '';
      if (item.dna_video_titles) {
        try {
          const titles = typeof item.dna_video_titles === 'string'
            ? JSON.parse(item.dna_video_titles) : item.dna_video_titles;
          dnaVideoTitle = Array.isArray(titles) ? titles[0] : titles;
        } catch(e) { dnaVideoTitle = item.dna_video_titles; }
      }

      const thumbsHtml = thumbTitles.length > 0
        ? thumbTitles.map(t => `<div class="th-detail-thumb-item">${t}</div>`).join('')
        : '<div class="th-detail-thumb-item" style="color:rgba(255,255,255,0.3);">없음</div>';

      let materialsHtml = '';
      if (item.material_data) {
        try {
          const mats = JSON.parse(item.material_data);
          if (Array.isArray(mats) && mats.length > 0) {
            materialsHtml = mats.slice(0, 3).map(function(m) {
              return '<div class="th-mat-item"><span class="th-mat-cat">' + (m.category_label || m.category || '') + '</span> ' + (m.title || '') + '</div>';
            }).join('');
          }
        } catch(e) {}
      }
      const hasMaterials = !!materialsHtml;
      const hasDnaResult = !!(item.dna_analysis_result && item.dna_analysis_result.trim());
      const hasWritingPrompt = !!(item.writing_prompt_result && item.writing_prompt_result.trim());
      const hasFinalScript = !!(item.final_script && item.final_script.trim());

      const itemEl = document.createElement('div');
      itemEl.className = 'th-item';
      itemEl.dataset.id = recId;
      itemEl.innerHTML = `
        <div class="th-item-top">
          <div class="th-item-top-left">
            <span class="th-item-date">${date}</span>
            ${item.group_tag ? `<span class="th-item-genre">${item.group_tag}</span>` : ''}
          </div>
          <div class="th-item-top-right">
            <button class="th-toggle-btn">상세보기</button>
            <button class="th-delete-btn">삭제</button>
          </div>
        </div>

        <div class="th-item-preview-title">${topicTitle}</div>

        <div class="th-detail" style="display:none;">
          <div class="th-detail-section">
            <div class="th-item-thumb-box">
              <span class="th-item-thumb-label">썸네일</span>
              <span class="th-item-thumb-text">${item.thumb_title_main || (thumbTitles.length > 0 ? thumbTitles[0] : '') || '-'}</span>
            </div>
          </div>

          <div class="th-detail-section">
            <div class="th-detail-label">주제명</div>
            <div class="th-detail-content">${topicTitle}</div>
          </div>

          ${hasDna ? `
          <div class="th-detail-section">
            <div class="th-detail-label">참고 DNA</div>
            <div class="th-detail-content">${dnaVideoTitle || 'DNA #' + item.selected_dna_id}</div>
          </div>` : ''}

          ${hasPrompt ? `
          <div class="th-detail-section">
            <div class="th-detail-label">스토리 설계 프롬프트</div>
            <div class="th-prompt-box">
              <div class="th-prompt-content">${item.story_prompt}</div>
              <button class="th-prompt-copy-btn" data-prompt="${encodeURIComponent(item.story_prompt)}">프롬프트 복사</button>
            </div>
          </div>` : ''}

          ${hasMaterials ? `
          <div class="th-detail-section">
            <div class="th-detail-label">추천 소재</div>
            <div class="th-detail-content">${materialsHtml}</div>
          </div>` : ''}

          ${hasDnaResult ? `
          <div class="th-detail-section">
            <div class="th-detail-label">DNA 분석 결과</div>
            <div class="th-prompt-box">
              <div class="th-prompt-content">${item.dna_analysis_result}</div>
              <button class="th-text-copy-btn" data-text="${encodeURIComponent(item.dna_analysis_result)}">복사</button>
              <button class="th-text-dl-btn" data-text="${encodeURIComponent(item.dna_analysis_result)}" data-filename="${encodeURIComponent((item.topic_title || '').substring(0, 30) + '_DNA분석.txt')}">다운로드</button>
            </div>
          </div>` : ''}

          ${hasWritingPrompt ? `
          <div class="th-detail-section">
            <div class="th-detail-label">글쓰기 프롬프트</div>
            <div class="th-prompt-box">
              <div class="th-prompt-content">${item.writing_prompt_result}</div>
              <button class="th-text-copy-btn" data-text="${encodeURIComponent(item.writing_prompt_result)}">복사</button>
              <button class="th-text-dl-btn" data-text="${encodeURIComponent(item.writing_prompt_result)}" data-filename="${encodeURIComponent((item.topic_title || '').substring(0, 30) + '_글쓰기프롬프트.txt')}">다운로드</button>
            </div>
          </div>` : ''}

          ${hasFinalScript ? `
          <div class="th-detail-section">
            <div class="th-detail-label">최종 대본</div>
            <div class="th-prompt-box">
              <div class="th-prompt-content">${item.final_script}</div>
              <button class="th-text-copy-btn" data-text="${encodeURIComponent(item.final_script)}">복사</button>
              <button class="th-text-dl-btn" data-text="${encodeURIComponent(item.final_script)}" data-filename="${encodeURIComponent((item.topic_title || '').substring(0, 30) + '_최종대본.txt')}">다운로드</button>
            </div>
          </div>` : ''}
        </div>
      `;
      listEl.appendChild(itemEl);
    });

    body.innerHTML = '';
    body.appendChild(listEl);
  }

  body.addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('.th-toggle-btn');
    if (toggleBtn) {
      const itemEl = toggleBtn.closest('.th-item');
      const detail = itemEl.querySelector('.th-detail');
      const isOpen = detail.style.display !== 'none';
      detail.style.display = isOpen ? 'none' : 'block';
      toggleBtn.textContent = isOpen ? '상세보기' : '접기';
      return;
    }

    const deleteBtn = e.target.closest('.th-delete-btn');
    if (deleteBtn) {
      const recId = deleteBtn.closest('.th-item').dataset.id;
      const itemEl = deleteBtn.closest('.th-item');
      showTtsConfirm('이 추천 이력을 삭제하시겠습니까?', async function() {
        try {
          await api.deleteRecommendation(recId);
          if (itemEl) itemEl.remove();
          allItems = allItems.filter(it => String(it.id) !== String(recId));
          countEl.textContent = body.querySelectorAll('.th-item').length + '건';
          if (body.querySelectorAll('.th-item').length === 0) {
            body.innerHTML = '<div class="th-empty">추천 이력이 없습니다.</div>';
          }
        } catch(err) {
          showToast('삭제 중 오류가 발생했습니다.', 'error');
        }
      });
      return;
    }

    const copyBtn = e.target.closest('.th-prompt-copy-btn');
    if (copyBtn) {
      safeCopy(decodeURIComponent(copyBtn.dataset.prompt), copyBtn);
      return;
    }

    const textCopyBtn = e.target.closest('.th-text-copy-btn');
    if (textCopyBtn) {
      safeCopy(decodeURIComponent(textCopyBtn.dataset.text), textCopyBtn);
      return;
    }

    const textDlBtn = e.target.closest('.th-text-dl-btn');
    if (textDlBtn) {
      const text = decodeURIComponent(textDlBtn.dataset.text);
      const filename = decodeURIComponent(textDlBtn.dataset.filename);
      downloadTxt(filename, text);
      return;
    }
  });

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      renderList(allItems, searchInput.value.trim());
    }, 300);
  });

  genreFilter.addEventListener('change', loadHistory);

  initFilters().then(loadHistory);
}

// 설계 내용 보기 모달 (스토리/세계관 공용)
function openDesignViewModal(typeLabel, title, content) {
  const existingOverlay = document.querySelector('.dv-overlay');
  if (existingOverlay) existingOverlay.remove();

  const overlay = document.createElement('div');
  overlay.className = 'dv-overlay';

  overlay.innerHTML = `
    <div class="dv-modal">
      <div class="dv-header">
        <h2 class="dv-title">${typeLabel}</h2>
        <span class="dv-subtitle">${title || ''}</span>
        <button class="dv-close-btn">&times;</button>
      </div>
      <div class="dv-body">
        <pre class="dv-content">${(content || '(내용 없음)').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
      </div>
      <div class="dv-footer">
        <button class="dv-copy-btn">복사</button>
        <button class="dv-close-footer-btn">닫기</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('dv-visible'));

  const closeAll = () => {
    overlay.classList.remove('dv-visible');
    setTimeout(() => overlay.remove(), 200);
  };

  overlay.querySelector('.dv-close-btn').addEventListener('click', closeAll);
  overlay.querySelector('.dv-close-footer-btn').addEventListener('click', closeAll);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAll(); });

  overlay.querySelector('.dv-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(content || '').then(() => {
      const btn = overlay.querySelector('.dv-copy-btn');
      btn.textContent = '복사됨';
      setTimeout(() => btn.textContent = '복사', 1500);
    });
  });
}

// ── DNA 배치 분석 플로팅 패널 ─────────────────────────────────────────────────
function showDnaBatchPanel(api, jobId, total, titles, category, groupTag, catX, catY, meta, deepArea, spikeVideos) {
  document.querySelector('.dna-batch-panel')?.remove();

  const panel = document.createElement('div');
  panel.className = 'dna-batch-panel';
  panel.innerHTML = `
    <div class="dna-batch-header">
      <span class="dna-batch-title">DNA 배치 분석</span>
      <span class="dna-batch-minimize" id="dna-batch-min">─</span>
      <span class="dna-batch-close" id="dna-batch-close">✕</span>
    </div>
    <div class="dna-batch-body" id="dna-batch-body">
      <div class="dna-batch-status">준비 중...</div>
      <div class="dna-batch-progress-wrap">
        <div class="dna-batch-progress-bar">
          <div class="dna-batch-progress-fill" id="dna-batch-fill" style="width:0%"></div>
        </div>
        <div class="dna-batch-progress-text" id="dna-batch-text">0 / ${total}</div>
      </div>
      <div class="dna-batch-current" id="dna-batch-current"></div>
      <button class="dna-batch-cancel-btn" id="dna-batch-cancel">중단</button>
    </div>
    <div class="dna-batch-mini" id="dna-batch-mini" style="display:none">
      <span class="dna-batch-mini-text" id="dna-batch-mini-text">DNA 분석 0/${total}</span>
      <span class="dna-batch-expand" id="dna-batch-expand">▲</span>
    </div>
  `;

  document.body.appendChild(panel);

  const body = panel.querySelector('#dna-batch-body');
  const mini = panel.querySelector('#dna-batch-mini');
  const fill = panel.querySelector('#dna-batch-fill');
  const text = panel.querySelector('#dna-batch-text');
  const current = panel.querySelector('#dna-batch-current');
  const statusEl = panel.querySelector('.dna-batch-status');
  const miniText = panel.querySelector('#dna-batch-mini-text');

  panel.querySelector('#dna-batch-min').addEventListener('click', () => {
    body.style.display = 'none';
    mini.style.display = 'flex';
  });
  panel.querySelector('#dna-batch-expand').addEventListener('click', () => {
    body.style.display = 'block';
    mini.style.display = 'none';
  });

  panel.querySelector('#dna-batch-close').addEventListener('click', () => {
    const currentStatus = statusEl.textContent;
    if (currentStatus === '분석 중...' || currentStatus === '준비 중...') {
      if (!confirm('분석이 진행 중입니다. 패널을 닫아도 서버에서 계속 진행됩니다.\n닫으시겠습니까?')) return;
    }
    clearInterval(pollInterval);
    panel.remove();
  });

  panel.querySelector('#dna-batch-cancel').addEventListener('click', async () => {
    if (!confirm('분석을 중단하시겠습니까?\n이미 완료된 영상은 저장됩니다.')) return;
    try {
      await api.batchDnaCancel(jobId);
      statusEl.textContent = '중단됨';
    } catch (e) {
      alert('중단 실패: ' + e.message);
    }
  });

  const pollInterval = setInterval(async () => {
    try {
      const status = await api.batchDnaStatus(jobId);

      if (status.status === 'idle') {
        clearInterval(pollInterval);
        statusEl.textContent = '작업을 찾을 수 없습니다';
        localStorage.removeItem('dna-batch-job');
        return;
      }

      const pct = Math.round((status.progress / status.total) * 100);
      fill.style.width = pct + '%';
      text.textContent = `${status.progress} / ${status.total}`;
      miniText.textContent = `DNA 분석 ${status.progress}/${status.total}`;

      if (status.progress < status.total && titles[status.progress]) {
        current.textContent = `분석 중: ${titles[status.progress]}`;
      }

      const successCount = (status.results || []).filter(r => r.status === 'success').length;
      const errorCount = (status.results || []).filter(r => r.status === 'error' || r.status === 'skipped').length;

      if (status.status === 'processing') {
        statusEl.textContent = '분석 중...';
      } else if (status.status === 'complete') {
        clearInterval(pollInterval);
        statusEl.textContent = `완료 (성공 ${successCount}, 실패 ${errorCount})`;
        current.textContent = '';
        localStorage.removeItem('dna-batch-job');

        let cancelBtn = panel.querySelector('#dna-batch-cancel');
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        cancelBtn = newCancelBtn;
        cancelBtn.textContent = '결과 보기';
        cancelBtn.className = 'dna-batch-result-btn';
        cancelBtn.onclick = () => {
          clearInterval(pollInterval);
          panel.remove();
          showDnaBatchResultModal(api, status.results, category, groupTag, catX, catY, meta, deepArea, spikeVideos);
        };

        updateCardsAfterBatchDna(status.results, spikeVideos);
        const analyzeBtnComplete = document.querySelector('#spike-analyze-btn');
        if (analyzeBtnComplete) { analyzeBtnComplete.disabled = true; analyzeBtnComplete.innerHTML = `${icons.dna()} DNA 분석 시작`; }

      } else if (status.status === 'cancelled') {
        clearInterval(pollInterval);
        statusEl.textContent = `중단됨 (성공 ${successCount}, 실패 ${errorCount})`;
        current.textContent = '';
        localStorage.removeItem('dna-batch-job');

        if (successCount > 0) {
          let cancelBtn = panel.querySelector('#dna-batch-cancel');
          const newCancelBtn2 = cancelBtn.cloneNode(true);
          cancelBtn.parentNode.replaceChild(newCancelBtn2, cancelBtn);
          cancelBtn = newCancelBtn2;
          cancelBtn.textContent = '결과 보기';
          cancelBtn.className = 'dna-batch-result-btn';
          cancelBtn.onclick = () => {
            clearInterval(pollInterval);
            panel.remove();
            showDnaBatchResultModal(api, status.results, category, groupTag, catX, catY, meta, deepArea, spikeVideos);
          };
          updateCardsAfterBatchDna(status.results, spikeVideos);
          const analyzeBtnCancelled = document.querySelector('#spike-analyze-btn');
          if (analyzeBtnCancelled) {
            var remainingChecked = document.querySelectorAll('.spike-video-checkbox:checked').length;
            analyzeBtnCancelled.disabled = remainingChecked === 0;
            if (remainingChecked === 0) { analyzeBtnCancelled.innerHTML = `${icons.dna()} DNA 분析 시작`; }
          }
        }
      }
    } catch (err) {
      console.error('[dna-batch-poll] 폴링 오류:', err);
    }
  }, 2000);
}

// ── DNA 배치 완료 후 카드 업데이트 ─────────────────────────────────────────────
function updateCardsAfterBatchDna(results, spikeVideos) {
  const successResults = (results || []).filter(r => r.status === 'success' && r.video);
  for (const r of successResults) {
    const dbId = r.video.id;

    const found = spikeVideos?.find(sv => sv.id === dbId || sv.video_id === dbId);
    if (found) found.hasDna = true;

    const card = document.querySelector(`.spike-video-item[data-video-id="${dbId}"]`);
    if (!card) continue;

    card.classList.add('spike-video-dna-done');
    card.dataset.hasDna = 'true';
    const dnaId = r.dnaId || r.video?.dna_id || '';
    if (dnaId) {
      card.dataset.dnaId = String(dnaId);
    } else {
      console.error('[DNA] dnaId 없음 - videoId:', dbId);
    }

    const cbWrap = card.querySelector('.spike-video-select-area');
    if (r.dna?.scores?.overall !== undefined) {
      const scoreHtml = `<span class="spike-dna-score">${Math.round(r.dna.scores.overall)}점</span>`;
      const newHtml = `${scoreHtml}<button class="spike-dna-view-btn" data-video-id="${dbId}" data-dna-id="${r.dnaId || ''}">${icons.dna()} DNA 보기</button>`;
      if (cbWrap) {
        cbWrap.outerHTML = `<div class="spike-dna-area">${newHtml}</div>`;
      } else {
        const wrapper = document.createElement('div');
        wrapper.className = 'spike-dna-area';
        wrapper.innerHTML = newHtml;
        card.appendChild(wrapper);
      }
    }
    const newDnaBtn = card.querySelector('.spike-dna-view-btn');
    if (newDnaBtn && !newDnaBtn.dataset.bound) {
      newDnaBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const vid = newDnaBtn.dataset.videoId;
        try {
          const dnaData = await api.getDnaByVideoId(vid);
          if (dnaData) showDnaResultModal(dnaData);
        } catch (err) {
          console.error('[DNA보기 오류]', err);
        }
      });
      newDnaBtn.dataset.bound = 'true';
    }
    if (!card.querySelector('.spike-dna-badge')) {
      const metaArea = card.querySelector('.rf-item-info') || card.querySelector('.spike-video-meta');
      if (metaArea) {
        const badge = document.createElement('span');
        badge.className = 'spike-dna-badge';
        badge.textContent = 'DNA 추출 완료';
        metaArea.appendChild(badge);
      }
    }
  }
}

// ── DNA 배치 결과 모달 ──────────────────────────────────────────────────────────
function showDnaBatchResultModal(api, results, category, groupTag, catX, catY, meta, deepArea, spikeVideos) {
  const overlay = document.createElement('div');
  overlay.className = 'dna-result-overlay';

  const successResults = (results || []).filter(r => r.status === 'success');
  const failedResults = (results || []).filter(r => r.status === 'error' || r.status === 'skipped');

  let listHtml = '';
  for (let i = 0; i < successResults.length; i++) {
    const r = successResults[i];
    const v = r.video || {};
    const overall = r.dna?.scores?.overall || 0;
    const hooking = r.dna?.scores?.hooking || 0;
    const structure = r.dna?.scores?.structure || 0;
    const emotion = r.dna?.scores?.emotion || 0;

    listHtml += `
      <div class="dna-result-item" data-index="${i}" data-video-id="${v.id}">
        <div class="dna-result-thumb">
          <img src="${v.thumbnailUrl || ''}" alt="" loading="lazy">
        </div>
        <div class="dna-result-info">
          <div class="dna-result-title">${v.title || '제목 없음'}</div>
          <div class="dna-result-channel">${v.channelName || ''} · 조회수 ${(v.viewCount || 0).toLocaleString()}</div>
        </div>
        <div class="dna-result-scores">
          <div class="dna-result-overall">${Math.round(overall)}점</div>
          <div class="dna-result-detail">후킹 ${Math.round(hooking)} · 구조 ${Math.round(structure)} · 감정 ${Math.round(emotion)}</div>
        </div>
        <button class="dna-result-view-btn" data-index="${i}">상세보기</button>
      </div>
    `;
  }

  let failedHtml = '';
  if (failedResults.length > 0) {
    failedHtml = `
      <div class="dna-result-failed-section">
        <div class="dna-result-failed-title">분석 실패 (${failedResults.length}개)</div>
        ${failedResults.map(r => `
          <div class="dna-result-failed-item">
            <span class="dna-result-failed-name">${r.video?.title || '영상 ' + r.videoId}</span>
            <span class="dna-result-failed-reason">${r.error || '알 수 없는 오류'}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  overlay.innerHTML = `
    <div class="dna-result-modal">
      <div class="dna-result-header">
        <div class="dna-result-modal-title">DNA 배치 분석 결과</div>
        <div class="dna-result-modal-subtitle">${category} · 성공 ${successResults.length}개${failedResults.length > 0 ? ' · 실패 ' + failedResults.length + '개' : ''}</div>
      </div>
      <div class="dna-result-body">
        <div class="dna-result-list">
          ${listHtml}
        </div>
        ${failedHtml}
      </div>
      <div class="dna-result-footer">
        <button class="dna-result-confirm-btn" id="dna-result-confirm">확인</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.dna-result-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      const r = successResults[idx];
      if (!r) return;

      overlay.remove();

      const dnaResponse = {
        dna: r.dna,
        sourceVideos: [r.video],
        skippedVideos: [],
        isNewExtraction: !r.cached,
        category: category
      };
      showDnaResultModal(dnaResponse, catX, catY, groupTag, meta, deepArea, api, spikeVideos);
    });
  });

  overlay.querySelector('#dna-result-confirm').addEventListener('click', () => {
    overlay.remove();
  });

  document.body.appendChild(overlay);
}
