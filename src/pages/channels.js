// Channels management page
import { showToast, showModal } from '../components/toast.js';
import { registerPageShowCallback } from '../page-events.js';
import { icons } from '../components/icons.js';

let currentFolder = '';

// ─── State ─────────────────────────────────────────────────────────────────
let activeJobs = new Map();  // channelId -> pollInterval
let currentSort = 'subscribers';   // subscribers | spike | recent
let spikeCountMap = {};            // channel 내부id -> spike_count
let inactiveFilter = null;         // null | 30 | 60 | 90
let inactiveChannelMap = new Map();  // id -> last_upload
let searchKeyword = '';
let menubarRendered = false;
let categoriesCache = [];          // 동적 카테고리 캐시
let currentSubType = '실사';       // 서브탭: 실사 | 만화
let moveMode = false;              // 채널 이동 모드
let selectedForMove = new Set();   // 이동 대상 채널 id (db id)
let allChannelsCache = [];         // 전체 채널 캐시 (서브탭 전환용)
let channelsApiRef = null;         // api 참조 (이동 바 이벤트용)

function updateChannelCount(channelId) {
  fetch('/api/channels/' + channelId)
    .then(r => r.json())
    .then(ch => {
      if (ch?.collected_count !== undefined) {
        const cardEl = document.querySelector(`.channel-card[data-id="${channelId}"]`);
        if (cardEl) {
          const countEl = cardEl.querySelector('.collected-count');
          if (countEl) countEl.textContent = ch.collected_count + '개';
        }
      }
    })
    .catch(() => {});
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function fetchWithTimeout(promise, ms = 30000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

function showConfirmModal({ title, message }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'cm-modal-overlay';
    overlay.innerHTML = `
      <div class="cm-modal-box">
        <div class="cm-modal-title">${title}</div>
        <div style="color:rgba(255,255,255,0.7); font-size:14px; margin-bottom:20px; white-space:pre-line;">${message}</div>
        <div class="cm-report-btns">
          <button class="cm-filter-clear-btn" id="cm-confirm-cancel">취소</button>
          <button class="cm-confirm-btn" id="cm-confirm-ok">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#cm-confirm-ok').addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.querySelector('#cm-confirm-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
  });
}

// ─── Single channel collection ─────────────────────────────────────────────
function startSingleCollection(api, channelId, isRestore, onDone, onFail, afterDate = null) {
  const progressArea = document.getElementById(`progress-${channelId}`);
  if (progressArea) {
    progressArea.style.display = 'block';
    const fillEl = document.getElementById('prog-bar-' + channelId);
    if (fillEl) fillEl.style.background = 'linear-gradient(90deg, #4f46e5, #a855f7)';
  }

  // 응답 대기 없이 즉시 요청 발사
  if (!isRestore) {
    fetch(`/api/youtube/fetch/${channelId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ afterDate })
    }).catch(e => console.log('수집 시작 오류 (무시):', channelId, e.message));
  }

  const poll = setInterval(async () => {
    try {
      const status = await api.getFetchStatus(channelId);
      if (!status?.status) return;

      const areaEl = document.getElementById('progress-' + channelId);
      if (!areaEl) return;
      const fill = document.getElementById('prog-bar-' + channelId);
      const text = document.getElementById('prog-text-' + channelId);
      areaEl.style.display = 'block';

      const finishPoll = (success = true, rResult = null) => {
        clearInterval(poll);
        activeJobs.delete(channelId);
        updateChannelCount(channelId);
        loadChannels(api);
        if (success && onDone) onDone(rResult);
        if (!success && onFail) onFail(new Error('수집 실패'));
      };

      if (status.status === 'complete') {
        if (fill) fill.style.width = '100%';
        if (text) text.innerHTML = `${icons.success()} 수집 완료 (` + (status.completedCount || status.total) + '개)';
        let toastMsg = `${status.completedCount || status.total}개 영상 수집 완료!`;

        showToast(toastMsg, 'success');
        finishPoll(true, status.refreshResult);
        return;
      }

      if (status.status === 'error') {
        if (fill) { fill.style.width = '100%'; fill.style.background = '#ef4444'; }
        if (text) text.innerHTML = `${icons.error()} 오류 발생`;
        showToast('수집 중 오류 발생', 'error');
        finishPoll(false);
        return;
      }

      if (status.status === 'cancelled') {
        if (fill) { fill.style.width = '100%'; fill.style.background = '#f59e0b'; }
        if (text) text.textContent = '⏹ 중단됨 (' + (status.completedCount || status.progress) + '개 수집 완료)';
        finishPoll(true);
        return;
      }

      if (status.status === 'idle') {
        if (fill) fill.style.width = '100%';
        if (text) text.innerHTML = `${icons.success()} 수집 완료`;
        finishPoll(true);
        return;
      }

      // 진행 중
      if (status.total > 0) {
        const pct = Math.round((status.progress / status.total) * 100);
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = status.progress + '/' + status.total + '개 처리 중 (' + pct + '%)';
      } else {
        if (text) text.textContent = '영상 목록 가져오는 중...';
      }
    } catch (e) {
      console.error('폴링 오류:', e);
    }
  }, 2000);

  activeJobs.set(channelId, poll);
}

// ─── Page render ───────────────────────────────────────────────────────────
export async function renderChannels(container, { api, navigate }) {
  container.innerHTML = `
    <div class="page-header flex-between" style="margin-bottom:10px;">
      <div><h2>${icons.video(32)} 채널 관리</h2><p>분석할 YouTube 채널을 장르별로 분류하고 관리하세요</p></div>
    </div>

    <!-- Folder Tabs -->
    <div id="folder-filters" class="flex gap-12 mb-24 overflow-x-auto" style="padding-bottom:10px; border-bottom:1px solid var(--border);">
      <div class="spinner"></div>
    </div>

    <div id="channel-menubar"></div>

    <div id="channel-list"><div class="skeleton" style="height:200px"></div></div>
  `;

  await loadChannels(api);
  registerPageShowCallback('/channels', () => loadChannels(api));
}

// ─── Channel list ──────────────────────────────────────────────────────────
async function loadChannels(api) {
  const listEl = document.getElementById('channel-list');
  const folderEl = document.getElementById('folder-filters');
  const menubarEl = document.getElementById('channel-menubar');
  const container = listEl?.closest('[data-page]') || document.getElementById('app');
  if (menubarEl && menubarEl.children.length === 0) {
    menubarRendered = false;
  }

  try {
    const t0 = Date.now();
    const [channels, catRes] = await Promise.all([api.getChannels(), api.getChannelCategories()]);
    const categories = catRes.categories || [];
    categoriesCache = categories;
    allChannelsCache = channels;
    channelsApiRef = api;
    console.log('[PERF-CHANNEL] getChannels:', Date.now() - t0, 'ms, rows:', channels.length);

    if (channels.length === 0) {
      folderEl.innerHTML = '';
      if (menubarEl) menubarEl.innerHTML = '';
      listEl.innerHTML = `<div class="empty-state"><div class="icon">${icons.video()}</div><h3>등록된 채널이 없습니다</h3></div>`;
      return;
    }

    // 떡상 데이터 로드 (최초 1회)
    if (Object.keys(spikeCountMap).length === 0) {
      try {
        const spikeRes = await api.getChannelSpikeCounts();
        (spikeRes.spikeCounts || []).forEach(r => {
          spikeCountMap[r.channel_id] = r.spike_count;
        });
      } catch (e) { console.error('spike load error:', e); }
    }

    // 정렬
    if (currentSort === 'subscribers') {
      channels.sort((a, b) => (b.subscriber_count || 0) - (a.subscriber_count || 0));
    } else if (currentSort === 'spike') {
      channels.sort((a, b) => (spikeCountMap[b.id] || 0) - (spikeCountMap[a.id] || 0));
    } else if (currentSort === 'recent') {
      channels.sort((a, b) => {
        const da = a.last_fetched || '1970-01-01';
        const db = b.last_fetched || '1970-01-01';
        return db.localeCompare(da); // 최근 수집순 (최신 먼저)
      });
    }

    const countByTag = {};
    categories.forEach(cat => {
      countByTag[cat.name] = channels.filter(ch => ch.group_tag === cat.name).length;
    });

    if (!currentFolder && categories.length > 0) currentFolder = categories[0].name;

    folderEl.innerHTML = `
      ${categories.map(t => `
        <div class="tab ${currentFolder === t.name ? 'active' : ''}" data-tag="${t.name}" style="cursor:pointer; padding:6px 18px; border-radius:20px; font-weight:800; font-size:1.1rem;">
          ${t.name} (${countByTag[t.name] || 0})
        </div>
      `).join('')}
    `;

    folderEl.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentFolder = tab.dataset.tag;
        if (moveMode) closeMoveBar();
        loadChannels(api);
      });
    });

    // 카테고리 필터
    let filtered = channels.filter(ch => ch.group_tag === currentFolder);

    // 서브탭 필터 (dual 화풍 카테고리, 장기미업로드 필터 미적용 시에만)
    const currentCatInfo = categories.find(c => c.name === currentFolder);
    const useSubTab = !inactiveFilter && currentCatInfo?.sub_type_mode === 'dual';
    if (useSubTab) {
      filtered = filtered.filter(ch =>
        currentSubType === '실사'
          ? (ch.sub_type === '실사' || ch.sub_type == null)
          : ch.sub_type === currentSubType
      );
    }

    // 장기 미업로드 필터
    if (inactiveFilter) {
      filtered = filtered.filter(ch => inactiveChannelMap.has(ch.id));
      // 최근 업로드 순 정렬 (업로드 날짜 없는 채널은 맨 뒤)
      filtered.sort((a, b) => {
        const da = inactiveChannelMap.get(a.id) || '1970-01-01';
        const db = inactiveChannelMap.get(b.id) || '1970-01-01';
        return db.localeCompare(da);
      });
    }

    // 채널명 검색 필터
    if (searchKeyword) {
      const kw = searchKeyword.toLowerCase();
      filtered = filtered.filter(ch => ch.name.toLowerCase().includes(kw));
    }

    const totalVideos = filtered.reduce((sum, ch) => sum + (ch.collected_count || 0), 0);

    // 장기 미업로드 수 (필터 미적용 상태에서만 조회)
    let inactiveCount = inactiveFilter ? inactiveChannelMap.size : 0;
    if (!inactiveFilter) {
      try {
        const inRes = await api.getInactiveChannels(30, currentFolder);
        inactiveCount = inRes.count || 0;
      } catch (e) {}
    }

    // 탭 전환 시 장기 미업로드 숫자 동적 갱신
    if (menubarRendered && menubarEl) {
      const inactiveBtn = menubarEl.querySelector('#cm-inactive-btn');
      if (inactiveBtn) {
        inactiveBtn.textContent = `장기 미업로드: ${inactiveFilter ? inactiveChannelMap.size : inactiveCount}개 ▾`;
      }
    }

    // 메뉴바 렌더링 (최초 1회만)
    if (menubarEl && !menubarRendered) {
      menubarEl.innerHTML = `
        <div class="cm-bar-wrapper">
          <div id="cm-subtab-row" class="cm-subtab-row"></div>
          <div class="cm-bar">
            <div class="cm-bar-left">
              <div class="cm-stat-cards">
                <div class="cm-stat-card">
                  <div class="cm-stat-number">${filtered.length}</div>
                  <div class="cm-stat-label">채널</div>
                </div>
                <div class="cm-stat-card">
                  <div class="cm-stat-number">${totalVideos.toLocaleString()}</div>
                  <div class="cm-stat-label">수집 영상</div>
                </div>
              </div>
            </div>
            <div class="cm-bar-center">
              <button class="cm-sort-btn ${!inactiveFilter && currentSort === 'subscribers' ? 'active' : ''}" data-sort="subscribers">구독자순</button>
              <button class="cm-sort-btn ${!inactiveFilter && currentSort === 'spike' ? 'active' : ''}" data-sort="spike">떡상채널순</button>
              <button class="cm-sort-btn ${!inactiveFilter && currentSort === 'recent' ? 'active' : ''}" data-sort="recent">최근수집순</button>
              <div class="cm-divider"></div>
              <button class="cm-collect-all-btn" id="cm-collect-all">전체 영상 수집</button>
              <button class="cm-refresh-subs-btn" id="cm-refresh-subs">구독자 갱신</button>
              <div class="cm-bar-spacer"></div>
              <div class="cm-inactive-wrap">
                <button class="cm-inactive-btn" id="cm-inactive-btn">
                  장기 미업로드: ${inactiveFilter ? inactiveChannelMap.size : inactiveCount}개 ▾
                </button>
                <div class="cm-inactive-dropdown" id="cm-inactive-dropdown" style="display:none;">
                  <div class="cm-inactive-option" data-days="30">30일</div>
                  <div class="cm-inactive-option" data-days="60">60일</div>
                  <div class="cm-inactive-option" data-days="90">90일</div>
                  ${inactiveFilter ? '<div class="cm-inactive-option cm-inactive-clear" data-days="0">필터 해제</div>' : ''}
                </div>
              </div>
              <button id="cm-deleted-btn" class="cm-deleted-btn">${icons.delete()} 삭제 채널</button>
            </div>
            <div class="cm-bar-right">
              <input type="text" class="cm-search-input" id="cm-search" placeholder="채널명 검색" value="${searchKeyword}" style="width:200px;">
            </div>
          </div>
          ${inactiveFilter ? `
            <div class="cm-inactive-actions">
              <span class="cm-inactive-label">${inactiveFilter}일 이상 미업로드 채널</span>
              <button class="cm-select-all-btn" id="cm-select-all">전체 선택</button>
              <button class="cm-delete-selected-btn" id="cm-delete-selected" disabled>선택 삭제</button>
              <button class="cm-filter-clear-btn" id="cm-filter-clear">필터 해제</button>
            </div>
          ` : ''}
        </div>
      `;

      // 정렬 버튼
      menubarEl.querySelectorAll('.cm-sort-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          currentSort = btn.dataset.sort;
          inactiveFilter = null;
          inactiveChannelMap = new Map();

          // 정렬 버튼 active 클래스 직접 갱신
          menubarEl.querySelectorAll('.cm-sort-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          loadChannels(api);
        });
      });

      // 전체 영상 수집
      menubarEl.querySelector('#cm-collect-all')?.addEventListener('click', async () => {
        if (document.getElementById('cm-float-panel')) {
          showToast('이미 수집이 진행 중입니다');
          return;
        }

        const folder = currentFolder;
        const subType = currentSubType;
        const isDual = categoriesCache.find(c => c.name === folder)?.sub_type_mode === 'dual';

        const todayStr = new Date().toISOString().slice(0, 10);
        let allActive = (allChannelsCache || []).filter(ch => ch.group_tag === folder && ch.is_active !== 0);
        if (isDual && subType) {
          allActive = allActive.filter(ch =>
            subType === '실사' ? (ch.sub_type === '실사' || ch.sub_type == null) : ch.sub_type === subType
          );
        }
        const todayDone = allActive.filter(ch => ch.last_fetched && ch.last_fetched.slice(0, 10) === todayStr);
        let targets = allActive.filter(ch => !ch.last_fetched || ch.last_fetched.slice(0, 10) !== todayStr);

        if (!targets.length) {
          alert(`오늘 이미 모든 채널(${todayDone.length}개)의 수집이 완료되었습니다.`);
          return;
        }

        const existing = targets.filter(c => c.last_fetched);
        const newChs = targets.filter(c => !c.last_fetched);

        const result = await showCollectPeriodModal(folder, isDual ? subType : null, existing, newChs, todayDone.length);
        if (!result) return;

        const btn = document.getElementById('cm-collect-all');
        btn.disabled = true;
        btn.textContent = '수집 중...';

        try {
          await collectAllChannels(api, targets, result.newChannelAfterDate);
        } finally {
          btn.disabled = false;
          btn.textContent = '전체 영상 수집';
        }
      });

      // 구독자 갱신
      document.getElementById('cm-refresh-subs')?.addEventListener('click', async () => {
        const btn = document.getElementById('cm-refresh-subs');
        const folder = currentFolder;
        const subType = currentSubType;

        let targets = allChannelsCache.filter(c => c.group_tag === folder && c.is_active !== 0);
        const isDual = folder !== '야담';
        if (isDual && subType) {
          targets = targets.filter(c => c.sub_type === subType);
        }

        if (targets.length === 0) {
          alert('갱신할 채널이 없습니다.');
          return;
        }

        const confirmMsg = `${folder}${isDual ? ' - ' + subType : ''} 카테고리의 ${targets.length}개 채널 구독자수를 갱신하시겠습니까?`;
        if (!confirm(confirmMsg)) return;

        btn.disabled = true;
        btn.textContent = `갱신 중... (0/${targets.length})`;

        const channelIds = targets.map(c => c.id);
        const allChanges = [];
        let totalChecked = 0;
        let totalUnchanged = 0;

        try {
          for (let i = 0; i < channelIds.length; i += 50) {
            const batch = channelIds.slice(i, i + 50);
            const result = await api.refreshSubscribers(batch);
            totalChecked += result.total || 0;
            totalUnchanged += result.unchangedCount || 0;
            if (result.changes) allChanges.push(...result.changes);
            btn.textContent = `갱신 중... (${Math.min(i + 50, channelIds.length)}/${channelIds.length})`;
          }

          btn.textContent = '구독자 갱신';
          btn.disabled = false;

          const fmtNum = (n) => n.toLocaleString();

          const fmtDiff = (n) => {
            const sign = n > 0 ? '+' : '';
            return sign + n.toLocaleString();
          };

          const overlay = document.createElement('div');
          overlay.className = 'rs-overlay';

          let contentHtml = '';

          if (allChanges.length > 0) {
            const increased = allChanges.filter(c => c.diff > 0);
            const decreased = allChanges.filter(c => c.diff < 0);

            contentHtml = `
              <div class="rs-stats-row">
                <div class="rs-stat-box">
                  <div class="rs-stat-num">${totalChecked}</div>
                  <div class="rs-stat-label">전체 확인</div>
                </div>
                <div class="rs-stat-box rs-stat-up">
                  <div class="rs-stat-num">${increased.length}</div>
                  <div class="rs-stat-label">구독자 증가</div>
                </div>
                <div class="rs-stat-box rs-stat-down">
                  <div class="rs-stat-num">${decreased.length}</div>
                  <div class="rs-stat-label">구독자 감소</div>
                </div>
                <div class="rs-stat-box">
                  <div class="rs-stat-num">${totalUnchanged}</div>
                  <div class="rs-stat-label">변동 없음</div>
                </div>
              </div>
              <div class="rs-list-header">변동 채널 목록 (${allChanges.length}개)</div>
              <div class="rs-list">
                ${allChanges.map((c, i) => {
                  const isUp = c.diff > 0;
                  const diffClass = isUp ? 'rs-up' : 'rs-down';
                  const arrow = isUp ? '▲' : '▼';
                  return `
                    <div class="rs-item">
                      <div class="rs-item-rank">${i + 1}</div>
                      <div class="rs-item-name">${c.name}</div>
                      <div class="rs-item-before">${fmtNum(c.oldCount)}</div>
                      <div class="rs-item-arrow">→</div>
                      <div class="rs-item-after">${fmtNum(c.newCount)}</div>
                      <div class="rs-item-diff ${diffClass}">${arrow} ${fmtDiff(c.diff)}</div>
                    </div>`;
                }).join('')}
              </div>`;
          } else {
            contentHtml = `
              <div class="rs-stats-row">
                <div class="rs-stat-box">
                  <div class="rs-stat-num">${totalChecked}</div>
                  <div class="rs-stat-label">전체 확인</div>
                </div>
                <div class="rs-stat-box">
                  <div class="rs-stat-num">0</div>
                  <div class="rs-stat-label">변동 채널</div>
                </div>
              </div>
              <div class="rs-no-change">
                <div class="rs-no-change-icon">✓</div>
                <div class="rs-no-change-text">모든 채널의 구독자수가 동일합니다</div>
                <div class="rs-no-change-sub">마지막 갱신 이후 변동 사항이 없습니다</div>
              </div>`;
          }

          overlay.innerHTML = `
            <div class="rs-modal">
              <div class="rs-header">
                <div class="rs-title">구독자 갱신 완료</div>
                <div class="rs-subtitle">${folder}${isDual ? ' · ' + subType : ''} 카테고리</div>
              </div>
              ${contentHtml}
              <div class="rs-footer">
                <button class="rs-confirm-btn" id="rs-confirm">확인</button>
              </div>
            </div>
          `;

          document.body.appendChild(overlay);
          document.getElementById('rs-confirm').addEventListener('click', () => {
            overlay.remove();
          });

          await loadChannels(api);
        } catch (err) {
          btn.textContent = '구독자 갱신';
          btn.disabled = false;
          alert('구독자 갱신 실패: ' + err.message);
        }
      });

      // 장기 미업로드 드롭다운 토글
      menubarEl.querySelector('#cm-inactive-btn')?.addEventListener('click', () => {
        const dropdown = menubarEl.querySelector('#cm-inactive-dropdown');
        if (dropdown) dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      });

      menubarEl.querySelectorAll('.cm-inactive-option').forEach(opt => {
        opt.addEventListener('click', async () => {
          const days = parseInt(opt.dataset.days);
          if (days === 0) {
            inactiveFilter = null;
            inactiveChannelMap = new Map();
          } else {
            inactiveFilter = days;
            try {
              const res = await api.getInactiveChannels(days, currentFolder);
              inactiveChannelMap = new Map();
              (res.channels || []).forEach(c => inactiveChannelMap.set(c.id, c.last_upload));
            } catch (e) { console.error(e); }
          }
          loadChannels(api);
        });
      });

      // 삭제 채널 관리
      menubarEl.querySelector('#cm-deleted-btn')?.addEventListener('click', () => {
        showDeletedChannelsModal(currentFolder, currentSubType);
      });

      // 채널명 검색
      let searchTimer;
      menubarEl.querySelector('#cm-search')?.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchKeyword = e.target.value.trim();
          loadChannels(api);
        }, 300);
      });

      // 필터 해제
      menubarEl.querySelector('#cm-filter-clear')?.addEventListener('click', () => {
        inactiveFilter = null;
        inactiveChannelMap = new Map();
        loadChannels(api);
      });

      // 전체 선택 / 선택 삭제
      let selectedForDelete = new Set();
      menubarEl.querySelector('#cm-select-all')?.addEventListener('click', () => {
        listEl.querySelectorAll('.channel-card').forEach(card => {
          const id = parseInt(card.dataset.id);
          if (inactiveChannelMap.has(id)) {
            selectedForDelete.add(id);
            card.classList.add('cm-selected');
          }
        });
        const delBtn = menubarEl.querySelector('#cm-delete-selected');
        if (delBtn) { delBtn.disabled = false; delBtn.textContent = `선택 삭제 (${selectedForDelete.size}개)`; }
      });

      menubarEl.querySelector('#cm-delete-selected')?.addEventListener('click', () => {
        if (selectedForDelete.size === 0) return;
        showDeleteReasonModal(`${selectedForDelete.size}개 채널`, async (reason, detail) => {
          for (const id of selectedForDelete) {
            try { await api.deleteChannel(id, reason, detail); } catch (e) {}
          }
          selectedForDelete.clear();
          inactiveFilter = null;
          inactiveChannelMap = new Map();
          menubarRendered = false;
          loadChannels(api);
        });
      });

      menubarRendered = true;
    }

    // 탭 전환 시 실사/만화 버튼 동적 갱신
    if (menubarEl) {
      const subtabRow = menubarEl.querySelector('#cm-subtab-row');
      if (subtabRow) {
        const catInfo = categories.find(c => c.name === currentFolder);
        const showSubTab = !inactiveFilter && catInfo?.sub_type_mode === 'dual';
        if (showSubTab) {
          const realCount = channels.filter(ch =>
            ch.group_tag === currentFolder && (ch.sub_type === '실사' || ch.sub_type == null)
          ).length;
          const animCount = channels.filter(ch =>
            ch.group_tag === currentFolder && ch.sub_type === '만화'
          ).length;
          subtabRow.innerHTML = `
            <button class="cm-subtab ${currentSubType === '실사' ? 'active' : ''}" data-subtype="실사">
              실사 채널 (${realCount})
            </button>
            <button class="cm-subtab ${currentSubType === '만화' ? 'active' : ''}" data-subtype="만화">
              만화 채널 (${animCount})
            </button>
            <button id="cm-move-btn" class="cm-move-btn">채널 이동</button>
          `;
          subtabRow.style.display = '';
          subtabRow.querySelectorAll('.cm-subtab').forEach(btn => {
            btn.addEventListener('click', () => {
              currentSubType = btn.dataset.subtype;
              loadChannels(api);
            });
          });
          subtabRow.querySelector('#cm-move-btn')?.addEventListener('click', () => {
            if (moveMode) return;
            moveMode = true;
            selectedForMove.clear();
            showMoveBar();
            enableCardSelection();
          });
        } else {
          subtabRow.innerHTML = '';
          subtabRow.style.display = 'none';
        }
      }
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty-state">해당 카테고리에 등록된 채널이 없습니다.</div>`;
    } else {
      listEl.innerHTML = `<div class="dashboard-grid">${filtered.map(ch => renderChannelCard(ch)).join('')}</div>`;
    }

    // 이동 모드 복원 (카드 삭제/재렌더링 후에도 유지)
    if (restoreMoveState() || moveMode) {
      showMoveBar();
      enableCardSelection();
      selectedForMove.forEach(id => {
        const card = document.querySelector(`.channel-card[data-channel-id="${id}"]`);
        if (card) card.classList.add('cm-move-selected');
      });
      updateMoveCount();
    }

    listEl.querySelectorAll('.cc-btn-collect').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id);
        const lastFetched = btn.dataset.lastFetched || '';
        const progressEl = document.getElementById(`progress-${id}`);
        const buttonsEl = document.getElementById(`buttons-${id}`);

        let afterDate = null;
        if (!lastFetched) {
          const result = await showSingleCollectPeriodModal();
          if (!result) return;
          afterDate = result.afterDate;
        }

        if (progressEl) progressEl.style.display = 'block';
        if (buttonsEl) buttonsEl.style.display = 'none';
        startSingleCollection(api, id, false,
          () => {
            if (progressEl) progressEl.style.display = 'none';
            if (buttonsEl) buttonsEl.style.display = 'flex';
          },
          () => {
            if (progressEl) progressEl.style.display = 'none';
            if (buttonsEl) buttonsEl.style.display = 'flex';
          },
          afterDate
        );
      });
    });

    listEl.querySelectorAll('.cc-stop-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const channelId = btn.dataset.channelId;
        if (activeJobs.has(channelId)) {
          const interval = activeJobs.get(channelId);
          if (interval) clearInterval(interval);
          activeJobs.delete(channelId);
        }
        try {
          await fetch(`/api/youtube/cancel/${channelId}`, { method: 'POST' });
          const progressText = document.getElementById(`prog-text-${channelId}`);
          const progressBar = document.getElementById(`prog-bar-${channelId}`);
          if (progressText) progressText.textContent = '⏸ 중단 요청됨...';
          if (progressBar) progressBar.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
        } catch (e) {
          console.error('수집 취소 실패:', e);
        }
      });
    });

    listEl.querySelectorAll('.cc-btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id);
        const ch = channels.find(c => c.id === id);
        showDeleteReasonModal(ch?.name || '', async (reason, detail) => {
          try {
            await api.deleteChannel(id, reason, detail);
            loadChannels(api);
          } catch (e) {
            showToast('삭제 실패', 'error');
          }
        });
      });
    });

    listEl.querySelectorAll('.cc-category').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id);
        showCategorySelectionModal(api, id, el.textContent.trim(), (newTag) => {
          api.updateChannelGroup(id, newTag)
            .then(() => { showToast('카테고리 변경 완료!', 'success'); loadChannels(api); })
            .catch(err => showToast(err.message, 'error'));
        });
      });
    });

    listEl.querySelectorAll('.cc-spike-box').forEach(box => {
      box.addEventListener('click', async () => {
        const id = parseInt(box.dataset.id);
        const ch = channels.find(c => c.id === id);
        if (!ch) return;
        if ((spikeCountMap[ch.id] || 0) === 0) {
          showToast('이 채널의 떡상 TOP50 등록 영상이 없습니다');
          return;
        }
        await showChannelSpikeVideos(ch);
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state"><div class="icon">${icons.error()}</div><h3>로드 실패</h3><p>${err.message}</p></div> `;
  }
}

function renderChannelCard(ch) {
  const spikeCount = spikeCountMap[ch.id] || 0;
  const lastUpload = (inactiveFilter && inactiveChannelMap.has(ch.id))
    ? inactiveChannelMap.get(ch.id) : null;
  const ytUrl = ch.handle
    ? `https://www.youtube.com/@${ch.handle.replace('@', '')}`
    : `https://www.youtube.com/channel/${ch.channel_id}`;

  return `
    <div class="channel-card" data-id="${ch.id}" data-channel-id="${ch.id}">
      <div class="cc-profile">
        <a href="${ytUrl}" target="_blank" rel="noopener" style="display:contents;">
          <img class="cc-profile-img"
               src="${ch.thumbnail_url || ''}"
               onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><rect fill=%22%23333%22 width=%2240%22 height=%2240%22/></svg>'"
               alt="${ch.name}">
        </a>
        <div class="cc-profile-info">
          <a class="cc-name" href="${ytUrl}" target="_blank" rel="noopener">${ch.name}</a>
          <div class="cc-subscribers">구독 ${(ch.subscriber_count || 0).toLocaleString()}명</div>
        </div>
      </div>

      <div class="cc-stats">
        <div class="cc-stat-box">
          <div class="cc-stat-label">카테고리</div>
          <div class="cc-stat-value cc-category" data-id="${ch.id}">${ch.group_tag || '미분류'}</div>
        </div>
        <div class="cc-stat-box">
          <div class="cc-stat-label">수집 영상</div>
          <div class="cc-stat-value collected-count">${(ch.collected_count || 0).toLocaleString()}개</div>
        </div>
        <div class="cc-stat-box cc-spike-box" data-id="${ch.id}">
          <div class="cc-spike-click-hint">▼클릭▼</div>
          <div class="cc-stat-label">TOP 50 떡상</div>
          <div class="cc-stat-value cc-spike-value">${spikeCount}개</div>
        </div>
      </div>

      <div class="cc-dates">
        <span>채널등록: ${ch.created_at ? ch.created_at.slice(0, 10) : '알 수 없음'}</span>
        <span>최근수집일: ${ch.last_fetched ? ch.last_fetched.slice(0, 10) : '미수집'}</span>
        ${lastUpload ? `<span class="cc-last-upload">업로드: ${lastUpload.slice(0, 10)}</span>` : ''}
      </div>

      <div class="cc-progress" id="progress-${ch.id}" style="display:none;">
        <div class="cc-progress-bar-wrap">
          <div class="cc-progress-bar" id="prog-bar-${ch.id}" style="width:0%"></div>
        </div>
        <div class="cc-progress-text" id="prog-text-${ch.id}">준비 중...</div>
        <button class="cc-stop-btn" data-channel-id="${ch.id}">중지</button>
      </div>

      <div class="cc-buttons" id="buttons-${ch.id}">
        <button class="cc-btn cc-btn-collect" data-id="${ch.id}" data-last-fetched="${ch.last_fetched || ''}">영상 수집</button>
        <button class="cc-btn cc-btn-delete" data-id="${ch.id}">삭제</button>
      </div>
    </div>
  `;
}

// ─── 채널 이동 바 ──────────────────────────────────────────────────────────
function saveMoveState() {
  sessionStorage.setItem('moveMode', moveMode ? 'true' : 'false');
  sessionStorage.setItem('selectedForMove', JSON.stringify([...selectedForMove]));
}

function restoreMoveState() {
  const saved = sessionStorage.getItem('moveMode');
  const savedIds = sessionStorage.getItem('selectedForMove');
  if (saved === 'true') {
    moveMode = true;
    selectedForMove = new Set(JSON.parse(savedIds || '[]'));
    return true;
  }
  return false;
}

function clearMoveState() {
  moveMode = false;
  selectedForMove.clear();
  sessionStorage.removeItem('moveMode');
  sessionStorage.removeItem('selectedForMove');
}

function showMoveBar() {
  if (document.getElementById('cm-move-bar')) return;
  const targetType = currentSubType === '실사' ? '만화' : '실사';
  const bar = document.createElement('div');
  bar.id = 'cm-move-bar';
  bar.className = 'cm-move-bar';
  bar.innerHTML = `
    <div class="cm-move-bar-inner">
      <div class="cm-move-bar-left">
        <button id="cm-move-select-all" class="cm-move-action-btn">전체 선택</button>
        <button id="cm-move-cancel" class="cm-move-action-btn cm-move-cancel-btn">선택 취소</button>
        <span id="cm-move-count" class="cm-move-count">0개 선택</span>
      </div>
      <div class="cm-move-bar-right">
        <button id="cm-move-execute" class="cm-move-execute-btn" disabled>
          ${targetType} 채널로 이동하기
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(bar);

  document.getElementById('cm-move-select-all').addEventListener('click', () => {
    document.querySelectorAll('.channel-card').forEach(card => {
      const id = parseInt(card.dataset.channelId);
      selectedForMove.add(id);
      card.classList.add('cm-move-selected');
    });
    updateMoveCount();
    saveMoveState();
  });

  document.getElementById('cm-move-cancel').addEventListener('click', () => {
    closeMoveBar();
  });

  document.getElementById('cm-move-execute').addEventListener('click', async () => {
    if (selectedForMove.size === 0) return;
    const ids = [...selectedForMove];
    try {
      await channelsApiRef.bulkUpdateSubType(ids, targetType);
      clearMoveState();
      document.getElementById('cm-move-bar')?.remove();
      document.querySelectorAll('.channel-card').forEach(card => {
        card.classList.remove('cm-move-selected');
      });
      disableCardSelection();
      // 로컬 캐시 업데이트
      allChannelsCache.forEach(ch => {
        if (ids.includes(ch.id)) ch.sub_type = targetType;
      });
      showToast(`${ids.length}개 채널이 ${targetType} 채널로 이동되었습니다.`, 'success');
      loadChannels(channelsApiRef);
    } catch (err) {
      showToast('채널 이동 중 오류가 발생했습니다.', 'error');
    }
  });
}

function closeMoveBar() {
  clearMoveState();
  document.getElementById('cm-move-bar')?.remove();
  document.querySelectorAll('.channel-card').forEach(card => {
    card.classList.remove('cm-move-selected');
  });
  disableCardSelection();
}

function enableCardSelection() {
  document.querySelectorAll('.channel-card').forEach(card => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', handleCardSelectForMove);
  });
}

function disableCardSelection() {
  document.querySelectorAll('.channel-card').forEach(card => {
    card.style.cursor = '';
    card.removeEventListener('click', handleCardSelectForMove);
  });
}

function handleCardSelectForMove(e) {
  if (e.target.closest('button')) return;
  if (e.target.closest('a')) return;
  const card = e.currentTarget;
  const id = parseInt(card.dataset.channelId);
  if (selectedForMove.has(id)) {
    selectedForMove.delete(id);
    card.classList.remove('cm-move-selected');
  } else {
    selectedForMove.add(id);
    card.classList.add('cm-move-selected');
  }
  updateMoveCount();
  saveMoveState();
}

function updateMoveCount() {
  const countEl = document.getElementById('cm-move-count');
  const executeBtn = document.getElementById('cm-move-execute');
  if (countEl) countEl.textContent = `${selectedForMove.size}개 선택`;
  if (executeBtn) executeBtn.disabled = selectedForMove.size === 0;
}

async function showChannelSpikeVideos(ch) {
  let spikeVideos = [];
  try {
    const res = await fetch(`/api/channels/${ch.id}/spike-videos`);
    const data = await res.json();
    spikeVideos = data.videos || [];
  } catch (e) {
    showToast('떡상 영상 로드 실패', 'error');
    return;
  }

  const _fmt = n => {
    if (n == null) return '0';
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '억';
    if (n >= 10000) return Math.floor(n / 10000) + '만';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return n.toLocaleString();
  };
  const _dur = sec => {
    if (!sec) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
  };
  const _grade = ratio => {
    if (ratio >= 100) return ['초대박', 'spike-grade-super'];
    if (ratio >= 50)  return ['대박',   'spike-grade-great'];
    if (ratio >= 10)  return ['떡상',   'spike-grade-good'];
    if (ratio >= 5)   return ['선방',   ''];
    return ['', ''];
  };
  const _relDate = str => {
    if (!str) return '';
    const diff = Math.floor((Date.now() - new Date(str)) / 86400000);
    if (diff < 1) return '오늘';
    if (diff < 7) return `${diff}일 전`;
    if (diff < 30) return `${Math.floor(diff/7)}주 전`;
    if (diff < 365) return `${Math.floor(diff/30)}개월 전`;
    return `${Math.floor(diff/365)}년 전`;
  };

  const cardsHtml = spikeVideos.length === 0
    ? '<div class="cm-result-empty">떡상 TOP50에 등록된 영상이 없습니다.</div>'
    : spikeVideos.map((v, i) => {
        const rn = v.rank || i + 1;
        const ytUrl = `https://youtube.com/watch?v=${v.video_id}`;
        const ratio = parseFloat(v.spike_ratio) || 0;
        const [gradeText, gradeCls] = _grade(ratio);
        const gradeTag = gradeText ? `<span class="stat-grade-tag ${gradeCls}">${gradeText}</span>` : '';
        const durStr = _dur(v.duration_seconds);
        const pubDate = v.published_at ? new Date(v.published_at).toLocaleDateString('ko-KR', {year:'numeric',month:'numeric',day:'numeric'}) : '';
        const pubRel = _relDate(v.published_at);
        const subCount = v.subscriber_count || ch.subscriber_count || 0;
        return `
        <div class="spike-video-item">
          <div class="spike-video-thumb-area">
            <a href="${ytUrl}" target="_blank" rel="noopener">
              <div class="spike-video-thumb">
                <img src="${v.thumbnail_url || ''}" alt="" loading="lazy"
                     onerror="this.src='https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg'">
                <div class="spike-video-thumb-play"><span>▶</span></div>
              </div>
            </a>
            <div class="spike-video-rank-badge">
              <span class="spike-rank-cat-label">${v.category_name || ''}</span>
              <span class="spike-rank-number">${rn}위</span>
            </div>
          </div>
          <div class="spike-video-info">
            <div class="spike-video-title-row">
              <a href="${ytUrl}" target="_blank" rel="noopener" class="spike-video-title-link">${v.title || ''}</a>
            </div>
            <div class="spike-video-meta">
              <span class="spike-meta-channel">${ch.name}</span>
              <span class="spike-meta-divider">┃</span>
              <span>구독자 ${_fmt(subCount)}</span>
            </div>
            <div class="spike-video-stats">
              <div class="spike-stats-row">
                <span class="spike-stat spike-stat-ratio">🚀 구독자 대비 ${ratio.toFixed(1)}배 ${gradeTag}</span>
              </div>
              <div class="spike-stats-row">
                <span class="spike-stat spike-stat-views">👁 조회수 ${_fmt(v.view_count)}</span>
                ${durStr ? `<span class="spike-stat">⏱ ${durStr}</span>` : ''}
                ${v.comment_count ? `<span class="spike-stat">💬 ${_fmt(v.comment_count)}</span>` : ''}
              </div>
            </div>
            ${pubDate ? `<div class="spike-card-date">📅 ${pubDate} (${pubRel})</div>` : ''}
          </div>
        </div>`;
      }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'cm-result-overlay';
  overlay.innerHTML = `
    <div class="cm-result-modal cm-result-modal--wide">
      <div class="cm-result-header">
        <h2 class="cm-result-title">${ch.name} — TOP 50 떡상 영상</h2>
        <button class="cm-result-close" id="spike-modal-close">${icons.close()}</button>
      </div>
      <div class="cm-result-video-header">총 ${spikeVideos.length}건</div>
      <div style="padding: 0 24px 8px; font-size:12px; color:rgba(255,255,255,0.4);">같은 영상이 여러 소재 카테고리에 포함될 수 있습니다</div>
      <div class="cm-result-video-list" style="padding: 0 24px 24px;">
        ${cardsHtml}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#spike-modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function showCategorySelectionModal(api, id, currentTag, onSelect) {
  const presets = categoriesCache;

  showModal('이동할 카테고리(장르) 선택', `
    <div style="margin-bottom:20px; font-size:1.1rem; color:var(--text-secondary); font-weight:700;">해당 채널을 분류할 카테고리를 선택해 주세요.</div>
    <div class="flex gap-12 mb-20" style="flex-wrap:wrap;">
      ${presets.map(p => `
        <button class="btn ${currentTag === p.name ? 'btn-primary' : 'btn-outline'} preset-tag-btn" data-val="${p.name}" style="padding:12px 24px; font-size:1.1rem; font-weight:800; border-radius:12px;">${p.name}</button>
      `).join('')}
      <button class="btn btn-danger btn-outline preset-tag-btn" data-val="" style="padding:12px 24px; font-size:1.1rem; font-weight:800; border-radius:12px;">선택 해제 (미분류)</button>
    </div>
    <div class="input-group">
      <label style="font-weight:800;">기타 직접 입력</label>
      <div class="input-with-btn">
        <input type="text" id="custom-tag-input" value="${currentTag}" placeholder="새 카테고리 이름..." style="font-weight:700;">
        <button class="btn btn-primary" id="custom-tag-save-btn">이동</button>
      </div>
    </div>
  `, []);

  document.querySelectorAll('.preset-tag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      onSelect(btn.dataset.val);
      const overlay = document.querySelector('.modal-overlay');
      if (overlay) overlay.remove();
    });
  });

  document.getElementById('custom-tag-save-btn').addEventListener('click', () => {
    const val = document.getElementById('custom-tag-input').value.trim();
    onSelect(val);
    const overlay = document.querySelector('.modal-overlay');
    if (overlay) overlay.remove();
  });
}

// ─── Collect all channels ───────────────────────────────────────────────────
async function collectAllChannels(api, channels, newChannelAfterDate = null) {
  let aborted = false;
  let consecutiveErrors = 0;
  const results = [];
  const collectedVideos = [];
  const refreshResults = [];

  // 플로팅 패널 생성
  const panel = document.createElement('div');
  panel.className = 'cm-float-panel';
  panel.id = 'cm-float-panel';
  panel.innerHTML = `
    <div class="cm-float-header">
      <span class="cm-float-title">전체 영상 수집 중</span>
      <div class="cm-float-header-btns">
        <button class="cm-float-minimize" id="cm-float-min">${icons.minimize()}</button>
        <button class="cm-float-abort" id="cm-float-abort">${icons.close()}</button>
      </div>
    </div>
    <div class="cm-float-body" id="cm-float-body">
      <div class="cm-float-channel" id="cm-float-channel">준비 중...</div>
      <div class="cm-float-count" id="cm-float-count">0 / ${channels.length}</div>
      <div class="cm-float-bar-wrap">
        <div class="cm-float-bar" id="cm-float-bar" style="width:0%"></div>
      </div>
      <button class="cm-float-stop" id="cm-float-stop">중단</button>
    </div>
    <div class="cm-float-mini" id="cm-float-mini" style="display:none;">
      <span id="cm-float-mini-text">수집 중... 0/${channels.length}</span>
      <button class="cm-float-expand" id="cm-float-expand">▲</button>
    </div>
  `;
  document.body.appendChild(panel);

  panel.querySelector('#cm-float-min').addEventListener('click', () => {
    panel.querySelector('#cm-float-body').style.display = 'none';
    panel.querySelector('#cm-float-mini').style.display = 'flex';
  });
  panel.querySelector('#cm-float-expand').addEventListener('click', () => {
    panel.querySelector('#cm-float-body').style.display = 'block';
    panel.querySelector('#cm-float-mini').style.display = 'none';
  });

  const confirmAbort = async () => {
    const confirmed = await showConfirmModal({
      title: '수집 중단',
      message: '수집을 중단하시겠습니까?\n현재까지 수집된 내용은 저장됩니다.'
    });
    if (confirmed) aborted = true;
  };
  panel.querySelector('#cm-float-abort').addEventListener('click', confirmAbort);
  panel.querySelector('#cm-float-stop').addEventListener('click', confirmAbort);

  for (let i = 0; i < channels.length; i++) {
    if (aborted) break;

    const ch = channels[i];
    const pct = ((i + 1) / channels.length * 100).toFixed(1);
    panel.querySelector('#cm-float-channel').textContent = ch.name;
    panel.querySelector('#cm-float-count').textContent = `${i + 1} / ${channels.length}`;
    panel.querySelector('#cm-float-bar').style.width = `${pct}%`;
    panel.querySelector('#cm-float-mini-text').textContent = `수집 중... ${i + 1}/${channels.length}`;

    // 수집 전 영상 수 기록
    let beforeCount = 0;
    try {
      const beforeRes = await api.getVideos({ channel_id: ch.id, limit: 1 });
      beforeCount = beforeRes.total || 0;
    } catch (e) {}

    try {
      const afterDate = ch.last_fetched ? null : newChannelAfterDate;
      const chRefresh = await fetchWithTimeout(
        new Promise((resolve, reject) => {
          startSingleCollection(api, ch.id, false, resolve, reject, afterDate);
        }),
        120000
      );
      if (chRefresh) refreshResults.push(chRefresh);

      // 수집 후 새 영상 가져오기
      try {
        const afterRes = await api.getVideos({ channel_id: ch.id, sort: 'fetched_at', order: 'desc', limit: 50 });
        const newCount = Math.max(0, (afterRes.total || 0) - beforeCount);
        (afterRes.videos || []).slice(0, newCount).forEach(v => {
          collectedVideos.push({ ...v, _channelName: ch.name });
        });
      } catch (e) {}

      results.push({ channel: ch.name, result: 'success' });
      consecutiveErrors = 0;
    } catch (e) {
      results.push({
        channel: ch.name,
        channelId: ch.channel_id,
        handle: ch.handle,
        dbId: ch.id,
        result: 'error',
        error: e.message
      });
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        const cont = await showConfirmModal({
          title: '연속 실패',
          message: '5건 연속 실패했습니다. 계속 진행하시겠습니까?'
        });
        if (!cont) { aborted = true; break; }
        consecutiveErrors = 0;
      }
    }

    if (i < channels.length - 1 && !aborted) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  panel.remove();

  const success = results.filter(r => r.result === 'success').length;
  const failed = results.filter(r => r.result === 'error');
  const rawChanges = refreshResults.flatMap(r => r?.rankingChanges?.changes || []);
  const changeMap = new Map();
  for (const c of rawChanges) {
    const key = `${c.title}_${c.category}_${c.type}`;
    changeMap.set(key, c);
  }
  const allRankingChanges = [...changeMap.values()];
  const refreshSummary = refreshResults.length > 0 ? {
    updated: refreshResults.reduce((s, r) => s + (r?.updated || 0), 0),
    rankingChanges: allRankingChanges.length > 0 ? {
      totalChanges: allRankingChanges.length,
      newEntries: allRankingChanges.filter(c => c.type === 'new').length,
      rankUps: allRankingChanges.filter(c => c.type === 'up').length,
      dropOuts: allRankingChanges.filter(c => c.type === 'out').length,
      changes: allRankingChanges
    } : null
  } : null;
  showCollectResultModal(api, channels, results, collectedVideos, success, failed, aborted, refreshSummary);
  return { failed, results, allRankingChanges };
}

function showCollectResultModal(api, channels, results, collectedVideos, success, failed, aborted, refreshSummary = null) {
  const overlay = document.createElement('div');
  overlay.className = 'cm-result-overlay';
  overlay.innerHTML = `
    <div class="cm-result-modal">
      <div class="cm-result-header">
        <h2 class="cm-result-title">${aborted ? '수집 중단' : '수집 완료'}</h2>
        <button class="cm-result-close" id="cm-result-close">${icons.close()}</button>
      </div>
      <div class="cm-result-summary">
        <div class="cm-result-stat">
          <div class="cm-result-stat-num">${channels.length}</div>
          <div class="cm-result-stat-label">전체 채널</div>
        </div>
        <div class="cm-result-stat cm-result-success">
          <div class="cm-result-stat-num">${success}</div>
          <div class="cm-result-stat-label">수집 성공 채널</div>
        </div>
        <div class="cm-result-stat cm-result-fail">
          <div class="cm-result-stat-num">${failed.length}</div>
          <div class="cm-result-stat-label">수집 실패 채널</div>
        </div>
        <div class="cm-result-stat cm-result-videos">
          <div class="cm-result-stat-num">${collectedVideos.length}</div>
          <div class="cm-result-stat-label">새로 수집된 영상</div>
        </div>
      </div>
      ${aborted ? '<div class="cm-result-notice">사용자 중단으로 일부 채널이 처리되지 않았습니다.</div>' : ''}
      <div class="cm-result-body">
        <div class="cm-result-video-header">수집된 영상 목록 (${collectedVideos.length}건)</div>
        <div class="cm-result-video-list">
          ${collectedVideos.length === 0
            ? '<div class="cm-result-empty">새로 수집된 영상이 없습니다.</div>'
            : collectedVideos.map(v => `
              <div class="cm-result-video-card">
                <img class="cm-result-thumb" src="${v.thumbnail_url || ''}" onerror="this.style.display='none'">
                <div class="cm-result-video-info">
                  <div class="cm-result-video-title">${v.title || ''}</div>
                  <div class="cm-result-video-meta">
                    <span class="cm-result-video-channel">${v._channelName || ''}</span>
                    <span>조회수 ${(v.view_count || 0).toLocaleString()}</span>
                    <span>${v.published_at ? v.published_at.slice(0, 10) : ''}</span>
                  </div>
                </div>
              </div>
            `).join('')
          }
        </div>
        ${refreshSummary && refreshSummary.rankingChanges ? `
        <div class="cm-refresh-section">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
            <span style="font-size:17px;font-weight:700;color:#ff6b6b;">TOP50 순위 변동!</span>
          </div>
          <div style="display:flex;gap:12px;margin-bottom:14px;">
            <div style="flex:1;text-align:center;padding:10px;background:rgba(255,107,107,0.08);border-radius:8px;">
              <div style="font-size:22px;font-weight:700;color:#ff6b6b;">${refreshSummary.rankingChanges.newEntries}</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.5);">신규 진입</div>
            </div>
            <div style="flex:1;text-align:center;padding:10px;background:rgba(96,165,250,0.08);border-radius:8px;">
              <div style="font-size:22px;font-weight:700;color:#60a5fa;">${refreshSummary.rankingChanges.rankUps}</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.5);">순위 상승</div>
            </div>
            <div style="flex:1;text-align:center;padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;">
              <div style="font-size:22px;font-weight:700;color:rgba(255,255,255,0.4);">${refreshSummary.rankingChanges.dropOuts}</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.5);">탈락</div>
            </div>
          </div>
          <div style="max-height:220px;overflow-y:auto;">
            ${refreshSummary.rankingChanges.changes.map(c => `
              <div style="padding:10px 12px;background:rgba(255,255,255,0.02);border-radius:8px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">
                <div style="flex-shrink:0;width:28px;text-align:center;font-size:16px;">
                  ${c.type === 'new' ? icons.newBadge() : c.type === 'up' ? icons.arrowUp() : icons.arrowDown()}
                </div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:14px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.title}</div>
                  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:2px;">${c.channel} · ${c.category}</div>
                </div>
                <div style="flex-shrink:0;font-size:13px;font-weight:700;color:${c.type === 'new' ? '#ff6b6b' : c.type === 'up' ? '#60a5fa' : 'rgba(255,255,255,0.3)'};">
                  ${c.label}
                </div>
              </div>
            `).join('')}
          </div>
          <div style="margin-top:10px;font-size:14px;font-weight:600;color:#60a5fa;text-align:center;">TOP50에 자동 반영 완료</div>
        </div>
        ` : refreshSummary ? `
        <div class="cm-refresh-section">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:16px;">📊</span>
            <span style="font-size:15px;color:rgba(255,255,255,0.5);">기존 영상 재검수 완료 – 순위 변동 없음</span>
          </div>
        </div>` : ''}
        ${failed.length > 0 ? `
        <div class="cm-fail-list">
          <div class="cm-fail-list-title">수집 실패 채널 (${failed.length}건)</div>
          ${failed.map(f => {
            const ytUrl = f.handle
              ? 'https://www.youtube.com/@' + f.handle.replace('@', '')
              : 'https://www.youtube.com/channel/' + f.channelId;
            return '<div class="cm-fail-item">'
              + '<a href="' + ytUrl + '" target="_blank" class="cm-fail-name">' + f.channel + '</a>'
              + '<span class="cm-fail-error">' + f.error + '</span>'
              + '</div>';
          }).join('')}
        </div>` : ''}
      </div>
      <div class="cm-result-footer">
        ${failed.length > 0 ? `<button class="cm-result-retry-btn" id="cm-result-retry">실패 채널 재시도 (${failed.length}건)</button>` : ''}
        <button class="cm-result-confirm-btn" id="cm-result-ok">확인</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); loadChannels(api); };
  overlay.querySelector('#cm-result-close').addEventListener('click', close);
  overlay.querySelector('#cm-result-ok').addEventListener('click', close);
  overlay.querySelector('#cm-result-retry')?.addEventListener('click', async () => {
    overlay.remove();
    const retryChannels = channels.filter(ch => failed.some(f => f.channel === ch.name));
    const retryResults = await collectAllChannels(api, retryChannels);

    // 재시도 후에도 실패한 채널 카드에 표시
    if (retryResults && retryResults.failed) {
      retryResults.failed.forEach(f => {
        const card = document.querySelector(`.channel-card[data-id="${f.dbId}"]`);
        if (card) {
          card.classList.add('cm-collect-failed');
          const nameEl = card.querySelector('.cc-name');
          if (nameEl && !nameEl.querySelector('.cm-fail-badge')) {
            nameEl.insertAdjacentHTML('afterend',
              '<span class="cm-fail-badge">수집 실패</span>');
          }
        }
      });
    }
  });
}

// ─── 삭제 이유 선택 모달 ───────────────────────────────────────────────────
function showDeleteReasonModal(channelName, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'dr-modal-overlay';
  overlay.innerHTML = `
    <div class="dr-modal-box">
      <div class="dr-modal-title">'${channelName}' 채널 삭제</div>
      <div class="dr-modal-subtitle">삭제 이유를 선택해주세요</div>
      <div class="dr-modal-options">
        <label class="dr-option"><input type="radio" name="dr-reason" value="장기 미업로드" checked><span>장기 미업로드</span></label>
        <label class="dr-option"><input type="radio" name="dr-reason" value="채널 삭제"><span>채널 삭제</span></label>
        <label class="dr-option"><input type="radio" name="dr-reason" value="기타"><span>기타 (직접 입력)</span></label>
      </div>
      <input type="text" class="dr-detail-input" placeholder="삭제 이유를 입력해주세요" style="display:none;">
      <div class="dr-modal-btns">
        <button class="dr-cancel-btn">취소</button>
        <button class="dr-delete-btn">삭제</button>
      </div>
    </div>
  `;
  overlay.querySelectorAll('input[name="dr-reason"]').forEach(radio => {
    radio.addEventListener('change', () => {
      overlay.querySelector('.dr-detail-input').style.display =
        radio.value === '기타' ? 'block' : 'none';
    });
  });
  overlay.querySelector('.dr-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.dr-delete-btn').addEventListener('click', () => {
    const reason = overlay.querySelector('input[name="dr-reason"]:checked').value;
    const detail = reason === '기타' ? overlay.querySelector('.dr-detail-input').value : null;
    overlay.remove();
    onConfirm(reason, detail);
  });
  document.body.appendChild(overlay);
}

// ─── 삭제 이유 변경 모달 ──────────────────────────────────────────────────
function showReasonChangeModal(deletedId, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'dr-modal-overlay';
  overlay.innerHTML = `
    <div class="dr-modal-box">
      <div class="dr-modal-title">삭제 이유 변경</div>
      <div class="dr-modal-options">
        <label class="dr-option"><input type="radio" name="dc-reason-change" value="장기 미업로드"><span>장기 미업로드</span></label>
        <label class="dr-option"><input type="radio" name="dc-reason-change" value="채널 삭제"><span>채널 삭제</span></label>
        <label class="dr-option"><input type="radio" name="dc-reason-change" value="기타"><span>기타 (직접 입력)</span></label>
      </div>
      <input type="text" class="dr-detail-input" placeholder="상세 이유 입력" style="display:none;">
      <div class="dr-modal-btns">
        <button class="dr-cancel-btn">취소</button>
        <button class="dr-delete-btn">변경</button>
      </div>
    </div>
  `;
  overlay.querySelectorAll('input[name="dc-reason-change"]').forEach(radio => {
    radio.addEventListener('change', () => {
      overlay.querySelector('.dr-detail-input').style.display = radio.value === '기타' ? 'block' : 'none';
    });
  });
  overlay.querySelector('.dr-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.dr-delete-btn').addEventListener('click', async () => {
    const selected = overlay.querySelector('input[name="dc-reason-change"]:checked');
    if (!selected) { showToast('이유를 선택해주세요'); return; }
    const reason = selected.value;
    const detail = reason === '기타' ? overlay.querySelector('.dr-detail-input').value.trim() : null;
    try {
      await channelsApiRef.updateDeleteReason(deletedId, reason, detail || null);
      overlay.remove();
      showToast('삭제 이유가 변경되었습니다', 'success');
      if (onDone) onDone();
    } catch (err) {
      showToast('변경 중 오류가 발생했습니다', 'error');
    }
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ─── 삭제 채널 관리 모달 ───────────────────────────────────────────────────
function showDeletedChannelsModal(currentTag, subType) {
  const overlay = document.createElement('div');
  overlay.className = 'dc-modal-overlay';
  overlay.innerHTML = `
    <div class="dc-modal-box">
      <div class="dc-modal-header">
        <h2>${icons.delete()} 삭제 채널 관리</h2>
        <button class="dc-close-btn">${icons.close()}</button>
      </div>
      <div class="dc-stats-bar"></div>
      <div class="dc-modal-controls">
        <div class="dc-controls-left">
          <div class="dc-filter-btns">
            <button class="dc-filter-btn active" data-reason="all">전체</button>
            <button class="dc-filter-btn" data-reason="장기 미업로드">장기 미업로드</button>
            <button class="dc-filter-btn" data-reason="채널 삭제">채널 삭제</button>
            <button class="dc-filter-btn" data-reason="기타">기타</button>
          </div>
          <div class="dc-sort-btns">
            <button class="dc-sort-btn active" data-sort="date">삭제일순</button>
            <button class="dc-sort-btn" data-sort="subscriber">구독자순</button>
          </div>
        </div>
        <div class="dc-controls-right">
          <input type="text" class="dc-search-input" placeholder="채널명 검색">
          <div class="dc-total">총 0개</div>
        </div>
      </div>
      <div class="dc-modal-body"></div>
    </div>
  `;

  let currentSort = 'date';
  let currentReason = 'all';
  let currentKeyword = '';

  const reasonColor = {
    '장기 미업로드': '#ffb74d',
    '채널 삭제': '#ff6b6b',
    '기타': '#b39ddb',
    '이유없음': 'rgba(255,255,255,0.4)'
  };

  async function loadList() {
    try {
      const res = await channelsApiRef.getDeletedChannels(currentTag, subType, currentSort, currentReason, currentKeyword);
      const body = overlay.querySelector('.dc-modal-body');
      overlay.querySelector('.dc-total').textContent = `총 ${res.total}개`;

      const statsBar = overlay.querySelector('.dc-stats-bar');
      if (res.stats) {
        const rm = {};
        (res.stats.reasons || []).forEach(r => { rm[r.delete_reason] = r.cnt; });
        statsBar.innerHTML = `
          <div class="dc-stat-item"><span class="dc-stat-num">${res.stats.total}</span><span class="dc-stat-label">총 삭제</span></div>
          <div class="dc-stat-divider"></div>
          <div class="dc-stat-item"><span class="dc-stat-num" style="color:#ffb74d">${rm['장기 미업로드']||0}</span><span class="dc-stat-label">장기 미업로드</span></div>
          <div class="dc-stat-item"><span class="dc-stat-num" style="color:#ff6b6b">${rm['채널 삭제']||0}</span><span class="dc-stat-label">채널 삭제</span></div>
          <div class="dc-stat-item"><span class="dc-stat-num" style="color:#b39ddb">${rm['기타']||0}</span><span class="dc-stat-label">기타</span></div>
          <div class="dc-stat-item"><span class="dc-stat-num" style="color:rgba(255,255,255,0.4)">${rm['이유없음']||0}</span><span class="dc-stat-label">이유없음</span></div>
        `;
      }

      if (!res.channels || res.channels.length === 0) {
        body.innerHTML = '<div class="dc-empty"><div style="font-size:40px;margin-bottom:12px;">📭</div>삭제된 채널이 없습니다.</div>';
        return;
      }

      body.innerHTML = res.channels.map(ch => `
        <div class="dc-channel-row">
          <img src="${ch.thumbnail_url || ''}" class="dc-thumb" onerror="this.style.display='none'">
          <div class="dc-info">
            <a href="https://www.youtube.com/channel/${ch.channel_id}" target="_blank" rel="noopener" class="dc-name">${ch.name}</a>
            <div class="dc-meta">구독 ${(ch.subscriber_count||0).toLocaleString()}명 · 수집 영상 ${ch.collected_count||0}개 · ${ch.group_tag||'미분류'}</div>
            <div class="dc-reason" style="color:${reasonColor[ch.delete_reason]||'#fff'}">${ch.delete_reason}${ch.delete_reason_detail ? ' (' + ch.delete_reason_detail + ')' : ''}</div>
            <div class="dc-date">삭제일: ${ch.deleted_at?.slice(0,16).replace('T',' ')||'-'}</div>
          </div>
          <div class="dc-actions">
            <button class="dc-reason-btn" data-id="${ch.id}">이유 변경</button>
            <button class="dc-restore-btn" data-id="${ch.id}">채널 복구</button>
          </div>
        </div>
      `).join('');

      body.querySelectorAll('.dc-reason-btn').forEach(btn => {
        btn.addEventListener('click', () => showReasonChangeModal(btn.dataset.id, loadList));
      });

      body.querySelectorAll('.dc-restore-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('이 채널을 복구하시겠습니까?')) return;
          try {
            await channelsApiRef.restoreChannel(btn.dataset.id);
            showToast('채널이 복구되었습니다', 'success');
            loadList();
          } catch (err) {
            showToast(err.message?.includes('409') || err.message?.includes('존재') ? '이미 등록된 채널입니다' : '복구 중 오류가 발생했습니다', 'error');
          }
        });
      });
    } catch (e) {
      overlay.querySelector('.dc-modal-body').innerHTML = '<div class="dc-empty">로드 실패</div>';
    }
  }

  overlay.querySelectorAll('.dc-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.dc-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentReason = btn.dataset.reason;
      loadList();
    });
  });

  overlay.querySelectorAll('.dc-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.dc-sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      loadList();
    });
  });

  let searchTimer;
  overlay.querySelector('.dc-search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { currentKeyword = e.target.value.trim(); loadList(); }, 300);
  });

  overlay.querySelector('.dc-close-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  document.body.appendChild(overlay);
  loadList();
}

// ─── 수집 기간 선택 모달 (전체 수집용) ───────────────────────────────────────
function showCollectPeriodModal(folder, subType, existing, newChannels, todayDoneCount = 0) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'cp-overlay';

    const subLabel = subType ? ` - ${subType}` : '';
    const hasNew = newChannels.length > 0;

    overlay.innerHTML = `
      <div class="cp-modal">
        <div class="cp-header">
          <div class="cp-title">영상 수집 설정</div>
          <div class="cp-subtitle">${folder}${subLabel} 카테고리</div>
          ${todayDoneCount > 0 ? `
            <div class="cp-today-info">오늘 수집 완료: ${todayDoneCount}개 · 남은 채널: ${existing.length + newChannels.length}개</div>
          ` : `
            <div class="cp-today-info">전체 ${existing.length + newChannels.length}개 채널</div>
          `}
        </div>

        <div class="cp-section">
          <div class="cp-section-title">기존 채널 (${existing.length}개)</div>
          <div class="cp-section-desc">마지막 수집일 이후의 새 영상만 수집합니다.</div>
        </div>

        ${hasNew ? `
        <div class="cp-divider"></div>
        <div class="cp-section">
          <div class="cp-section-title">신규 채널 (${newChannels.length}개)</div>
          <div class="cp-section-desc">아직 수집한 적이 없는 채널입니다. 수집 기간을 선택해주세요.</div>
          <div class="cp-period-buttons">
            <button class="cp-period-btn" data-months="1">1개월</button>
            <button class="cp-period-btn active" data-months="3">3개월</button>
            <button class="cp-period-btn" data-months="6">6개월</button>
            <button class="cp-period-btn" data-months="all">전체</button>
          </div>
        </div>
        ` : ''}

        <div class="cp-footer">
          <button class="cp-cancel-btn">취소</button>
          <button class="cp-start-btn">수집 시작</button>
        </div>
      </div>
    `;

    overlay.querySelectorAll('.cp-period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.cp-period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    overlay.querySelector('.cp-cancel-btn').addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });

    overlay.querySelector('.cp-start-btn').addEventListener('click', () => {
      let newChannelAfterDate = null;
      if (hasNew) {
        const activeBtn = overlay.querySelector('.cp-period-btn.active');
        const months = activeBtn?.dataset.months;
        if (months && months !== 'all') {
          const d = new Date();
          d.setMonth(d.getMonth() - parseInt(months));
          newChannelAfterDate = d.toISOString();
        }
      }
      overlay.remove();
      resolve({ newChannelAfterDate });
    });

    document.body.appendChild(overlay);
  });
}

// ─── 수집 기간 선택 모달 (개별 채널 신규 수집용) ────────────────────────────
function showSingleCollectPeriodModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'cp-overlay';
    overlay.innerHTML = `
      <div class="cp-modal cp-modal-single">
        <div class="cp-header">
          <div class="cp-title">수집 기간 선택</div>
          <div class="cp-subtitle">처음 수집하는 채널입니다</div>
        </div>
        <div class="cp-section">
          <div class="cp-section-desc">어느 기간의 영상을 수집할까요?</div>
          <div class="cp-period-buttons">
            <button class="cp-period-btn" data-months="1">1개월</button>
            <button class="cp-period-btn active" data-months="3">3개월</button>
            <button class="cp-period-btn" data-months="6">6개월</button>
            <button class="cp-period-btn" data-months="all">전체</button>
          </div>
        </div>
        <div class="cp-footer">
          <button class="cp-cancel-btn">취소</button>
          <button class="cp-start-btn">수집 시작</button>
        </div>
      </div>
    `;

    overlay.querySelectorAll('.cp-period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.cp-period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    overlay.querySelector('.cp-cancel-btn').addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });

    overlay.querySelector('.cp-start-btn').addEventListener('click', () => {
      const activeBtn = overlay.querySelector('.cp-period-btn.active');
      const months = activeBtn?.dataset.months;
      let afterDate = null;
      if (months && months !== 'all') {
        const d = new Date();
        d.setMonth(d.getMonth() - parseInt(months));
        afterDate = d.toISOString();
      }
      overlay.remove();
      resolve({ afterDate });
    });

    document.body.appendChild(overlay);
  });
}
