import { api } from '../api.js';
import { registerPageShowCallback } from '../page-events.js';
import { icons } from '../components/icons.js';

export function renderIdeas(container) {
  let currentTab = 'memo';
  let currentCategory = '';

  container.innerHTML = `
    <div class="idea-page">
      <div class="idea-header">
        <div class="idea-header-left">
          <h2>${icons.idea(32)} 아이디어 관리</h2>
          <p class="idea-subtitle">주제 아이디어와 썸네일 레퍼런스를 관리하세요</p>
        </div>
      </div>

      <div class="idea-tabs">
        <button class="idea-tab active" data-tab="memo">${icons.memo()} 메모 / 아이디어</button>
        <button class="idea-tab" data-tab="thumbnail">${icons.image()} 썸네일 갤러리</button>
      </div>

      <div class="idea-toolbar">
        <div class="idea-toolbar-top">
          <select class="idea-filter idea-cat-filter">
            <option value="">전체 카테고리</option>
          </select>
          <select class="idea-filter idea-sort-filter">
            <option value="newest">최신순</option>
            <option value="oldest">오래된순</option>
            <option value="score">점수순</option>
          </select>
          <input type="text" class="idea-search"
            placeholder="검색어 입력...">
          <button class="idea-new-btn">+ 새 아이디어</button>
        </div>
        <div class="idea-toolbar-bottom">
          <div class="idea-period-group">
            <button class="idea-period-btn active" data-period="all">전체</button>
            <button class="idea-period-btn" data-period="7">1주일</button>
            <button class="idea-period-btn" data-period="30">1개월</button>
            <button class="idea-period-btn" data-period="90">3개월</button>
          </div>
          <input type="text" class="idea-date idea-date-start"
            placeholder="시작일" maxlength="10">
          <span class="idea-date-sep">~</span>
          <input type="text" class="idea-date idea-date-end"
            placeholder="종료일" maxlength="10">
        </div>
      </div>

      <div id="idea-content" class="idea-content"></div>
    </div>
  `;

  const contentEl = container.querySelector('#idea-content');
  const categoryFilter = container.querySelector('.idea-cat-filter');
  const sortSelect = container.querySelector('.idea-sort-filter');
  const searchInput = container.querySelector('.idea-search');
  const newBtn = container.querySelector('.idea-new-btn');

  async function loadCategories() {
    try {
      const cats = await api.getSettingsCategories();
      const names = Object.keys(cats);
      categoryFilter.innerHTML = '<option value="">전체 카테고리</option>';
      for (const name of names) {
        const tag = name.replace('소재', '');
        categoryFilter.innerHTML += `<option value="${tag}">${tag}</option>`;
      }
    } catch(e) {}
  }

  container.querySelectorAll('.idea-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.idea-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      newBtn.style.display = currentTab === 'memo' ? '' : 'none';
      loadContent();
    });
  });

  categoryFilter.addEventListener('change', () => {
    currentCategory = categoryFilter.value;
    loadContent();
  });

  sortSelect.addEventListener('change', () => loadContent());

  container.querySelectorAll('.idea-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.idea-period-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const period = btn.dataset.period;
      const startInput = container.querySelector('.idea-date-start');
      const endInput = container.querySelector('.idea-date-end');

      if (period === 'all') {
        startInput.value = '';
        endInput.value = '';
      } else {
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - parseInt(period));
        startInput.value = start.toISOString().slice(0, 10);
        endInput.value = end.toISOString().slice(0, 10);
      }
      loadContent();
    });
  });

  container.querySelectorAll('.idea-date').forEach(input => {
    input.addEventListener('input', () => {
      let v = input.value.replace(/[^0-9]/g, '');
      if (v.length > 8) v = v.slice(0, 8);
      if (v.length >= 5) v = v.slice(0, 4) + '-' + v.slice(4);
      if (v.length >= 8) v = v.slice(0, 7) + '-' + v.slice(7);
      input.value = v;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        const pos = input.selectionStart;
        const val = input.value;
        if (pos > 0 && val[pos - 1] === '-') {
          e.preventDefault();
          input.value = val.slice(0, pos - 2) + val.slice(pos);
          input.setSelectionRange(pos - 2, pos - 2);
        }
      }
    });
    input.addEventListener('change', () => { loadContent(); });
    input.addEventListener('blur', () => { loadContent(); });
  });

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadContent(), 300);
  });

  newBtn.addEventListener('click', () => showEditModal());

  async function loadContent() {
    if (currentTab === 'memo') await loadMemos();
    else await loadThumbnails();
  }

  function showVideoModal(videoId) {
    const overlay = document.createElement('div');
    overlay.className = 'idea-video-overlay';
    overlay.innerHTML = `
      <div class="idea-video-modal">
        <button class="idea-video-close">${icons.close()}</button>
        <div class="idea-video-player">
          <iframe src="https://www.youtube.com/embed/${videoId}?autoplay=1"
            allow="autoplay; encrypted-media"
            allowfullscreen frameborder="0"></iframe>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.idea-video-close')
      .addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  async function loadMemos() {
    contentEl.innerHTML = '<div class="idea-loading">불러오는 중...</div>';
    try {
      const params = new URLSearchParams();
      if (currentCategory) params.set('category', currentCategory);
      params.set('idea_type', 'memo,dna');
      params.set('save_type', 'idea,');
      const data = await api.request(`/ideas?${params.toString()}`);
      let items = data.ideas || [];

      const keyword = searchInput.value.trim().toLowerCase();
      if (keyword) {
        items = items.filter(i =>
          (i.title || '').toLowerCase().includes(keyword) ||
          (i.description || '').toLowerCase().includes(keyword) ||
          (i.source_video_title || '').toLowerCase().includes(keyword)
        );
      }

      const startVal = container.querySelector('.idea-date-start')?.value;
      const endVal = container.querySelector('.idea-date-end')?.value;
      if (startVal && startVal.length === 10) {
        const startDate = new Date(startVal);
        if (!isNaN(startDate)) {
          startDate.setHours(0, 0, 0, 0);
          items = items.filter(item => new Date(item.created_at) >= startDate);
        }
      }
      if (endVal && endVal.length === 10) {
        const endDate = new Date(endVal);
        if (!isNaN(endDate)) {
          endDate.setHours(23, 59, 59, 999);
          items = items.filter(item => new Date(item.created_at) <= endDate);
        }
      }

      const sortBy = sortSelect.value;
      if (sortBy === 'oldest') {
        items.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      } else if (sortBy === 'score') {
        items.sort((a, b) => (b.dna_score || 0) - (a.dna_score || 0));
      } else {
        items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      }

      if (items.length === 0) {
        contentEl.innerHTML = `
          <div class="idea-empty">
            <div class="idea-empty-icon">${icons.idea(40)}</div>
            <div class="idea-empty-text">아이디어가 없습니다</div>
            <div class="idea-empty-sub">새 아이디어를 추가하거나 DNA 분석에서 저장해보세요</div>
          </div>`;
        return;
      }

      contentEl.innerHTML = `
        <div class="idea-list">
          ${items.map(item => renderMemoCard(item)).join('')}
        </div>`;

      contentEl.querySelectorAll('.idea-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = Number(btn.dataset.id);
          const item = items.find(i => i.id === id);
          if (item) showViewModal(item);
        });
      });

      contentEl.querySelectorAll('.idea-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = Number(btn.dataset.id);
          const item = items.find(i => i.id === id);
          if (item) showEditModal(item);
        });
      });

      contentEl.querySelectorAll('.idea-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('삭제하시겠습니까?')) return;
          await api.request(`/ideas/${btn.dataset.id}`, { method: 'DELETE' });
          loadContent();
        });
      });

      contentEl.querySelectorAll('.idea-card-thumb-link').forEach(el => {
        el.addEventListener('click', () => {
          const vid = el.dataset.videoId;
          if (!vid) return;
          showVideoModal(vid);
        });
      });
    } catch(e) {
      contentEl.innerHTML = '<div class="idea-empty">로드 실패</div>';
    }
  }

  function renderMemoCard(item) {
    const hasDna = item.idea_type === 'dna';
    const thumb = item.source_thumbnail_url || '';
    const score = item.dna_score || 0;
    const memo = item.description || '';
    const dateStr = item.created_at ? new Date(item.created_at).toLocaleDateString('ko-KR') : '';
    const videoUrl = item.video_id
      ? `https://www.youtube.com/watch?v=${item.video_id}`
      : '';
    const viewFmt = (n) => {
      if (!n) return '';
      if (n >= 10000) return (n / 10000).toFixed(1) + '만';
      return n.toLocaleString();
    };
    const durFmt = (s) => {
      if (!s) return '';
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m + ':' + String(sec).padStart(2, '0');
    };

    return `
      <div class="idea-card" data-id="${item.id}">
        <div class="idea-card-left">
          ${thumb
            ? `<div class="idea-card-thumb-link"
                   data-video-id="${item.video_id || item.source_video_id || ''}"
                   style="cursor:pointer;">
                <img class="idea-card-thumb" src="${thumb}" alt="">
                ${(item.video_id || item.source_video_id) ? '<span class="idea-card-play">▶</span>' : ''}
               </div>`
            : ''}
        </div>
        <div class="idea-card-right">
          <div class="idea-card-top">
            ${item.category ? `<span class="idea-card-cat">${item.category}</span>` : ''}
            ${hasDna && score ? `<span class="idea-card-score">${score}점</span>` : ''}
            ${item.spike_ratio ? `<span class="idea-card-spike">구독자대비 ${Number(item.spike_ratio).toFixed(1)}배${item.spike_grade ? ' ' + item.spike_grade : ''}</span>` : ''}
            <span class="idea-card-date">${dateStr}</span>
          </div>
          <div class="idea-card-title">${item.source_video_title || item.title || '(제목 없음)'}</div>
          <div class="idea-card-stats">
            ${item.source_channel_name ? `<span class="idea-stat">${icons.video(14)} ${item.source_channel_name}</span>` : ''}
            ${item.subscriber_count ? `<span class="idea-stat">구독자 ${viewFmt(item.subscriber_count)}</span>` : ''}
            ${item.view_count ? `<span class="idea-stat">조회수 ${viewFmt(item.view_count)}</span>` : ''}
            ${item.duration_seconds ? `<span class="idea-stat">⏱ ${durFmt(item.duration_seconds)}</span>` : ''}
          </div>
          ${memo ? `<div class="idea-card-memo">메모 : ${memo}</div>` : ''}
          <div class="idea-card-actions">
            <button class="idea-view-btn" data-id="${item.id}">보기</button>
            <button class="idea-edit-btn" data-id="${item.id}">수정</button>
            <button class="idea-delete-btn" data-id="${item.id}">삭제</button>
          </div>
        </div>
      </div>`;
  }

  function showViewModal(item) {
    const viewOverlay = document.createElement('div');
    viewOverlay.className = 'idea-view-overlay';
    const vId = item.video_id || item.source_video_id || '';
    const videoUrl = vId ? `https://www.youtube.com/watch?v=${vId}` : '';
    const viewFmt = (n) => {
      if (!n) return '';
      if (n >= 10000) return (n / 10000).toFixed(1) + '만';
      return n.toLocaleString();
    };
    const durFmt = (s) => {
      if (!s) return '';
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m + ':' + String(sec).padStart(2, '0');
    };
    viewOverlay.innerHTML = `
      <div class="idea-view-modal">
        <div class="idea-view-header">
          <h2>아이디어 상세</h2>
          <button class="idea-view-close">${icons.close()}</button>
        </div>
        <div class="idea-view-body">
          <div class="idea-view-top-row">
            <div class="idea-view-player-wrap">
              ${vId
                ? `<div class="idea-view-player">
                     <iframe src="https://www.youtube.com/embed/${vId}"
                       allowfullscreen frameborder="0"></iframe>
                   </div>`
                : (item.source_thumbnail_url
                    ? `<img class="idea-view-thumb" src="${item.source_thumbnail_url}" alt="">`
                    : '')
              }
            </div>
            <div class="idea-view-info">
              <h3 class="idea-view-title">
                ${videoUrl
                  ? `<a href="${videoUrl}" target="_blank" rel="noopener">${item.source_video_title || item.title || ''}</a>`
                  : (item.source_video_title || item.title || '')}
              </h3>
              <div class="idea-view-meta">
                ${item.category ? `<span class="idea-card-cat">${item.category}</span>` : ''}
                ${item.dna_score ? `<span class="idea-card-score">${item.dna_score}점</span>` : ''}
                ${item.spike_ratio ? `<span class="idea-card-spike">구독자대비 ${Number(item.spike_ratio).toFixed(1)}배${item.spike_grade ? ' ' + item.spike_grade : ''}</span>` : ''}
              </div>
              <div class="idea-view-stats">
                ${item.source_channel_name ? `<span class="idea-stat">${icons.video(14)} ${item.source_channel_name}</span>` : ''}
                ${item.subscriber_count ? `<span class="idea-stat">구독자 ${viewFmt(item.subscriber_count)}</span>` : ''}
                ${item.view_count ? `<span class="idea-stat">조회수 ${viewFmt(item.view_count)}</span>` : ''}
                ${item.duration_seconds ? `<span class="idea-stat">⏱ ${durFmt(item.duration_seconds)}</span>` : ''}
              </div>
              <div class="idea-card-date">${item.created_at ? new Date(item.created_at).toLocaleDateString('ko-KR') : ''}</div>
            </div>
          </div>
          ${item.description ? `<div class="idea-view-section"><strong>메모</strong><p>${item.description}</p></div>` : ''}
          ${item.dna_summary ? `<div class="idea-view-section"><strong>DNA 분석 요약</strong><p>${item.dna_summary}</p></div>` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(viewOverlay);
    viewOverlay.querySelector('.idea-view-close').addEventListener('click', () => viewOverlay.remove());
    viewOverlay.addEventListener('click', (e) => { if (e.target === viewOverlay) viewOverlay.remove(); });
  }

  async function loadThumbnails() {
    contentEl.innerHTML = '<div class="idea-loading">불러오는 중...</div>';
    try {
      const params = new URLSearchParams();
      if (currentCategory) params.set('category', currentCategory);
      const data = await api.request(`/ideas/thumbnails?${params.toString()}`);
      let items = data.thumbnails || [];

      const startVal = container.querySelector('.idea-date-start')?.value;
      const endVal = container.querySelector('.idea-date-end')?.value;
      if (startVal && startVal.length === 10) {
        const startDate = new Date(startVal);
        if (!isNaN(startDate)) {
          startDate.setHours(0, 0, 0, 0);
          items = items.filter(item => new Date(item.created_at) >= startDate);
        }
      }
      if (endVal && endVal.length === 10) {
        const endDate = new Date(endVal);
        if (!isNaN(endDate)) {
          endDate.setHours(23, 59, 59, 999);
          items = items.filter(item => new Date(item.created_at) <= endDate);
        }
      }

      const sortBy = sortSelect.value;
      if (sortBy === 'oldest') {
        items.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      } else if (sortBy === 'score') {
        items.sort((a, b) => (b.dna_score || 0) - (a.dna_score || 0));
      } else {
        items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      }

      if (items.length === 0) {
        contentEl.innerHTML = `
          <div class="idea-empty">
            <div class="idea-empty-icon">${icons.image(40)}</div>
            <div class="idea-empty-text">저장된 썸네일이 없습니다</div>
            <div class="idea-empty-sub">DNA 분석 화면에서 썸네일을 저장해보세요</div>
          </div>`;
        return;
      }

      contentEl.innerHTML = `
        <div class="thumb-gallery">
          ${items.map(item => `
            <div class="thumb-card">
              <div class="thumb-img-wrap">
                <img src="${item.source_thumbnail_url}" alt="${item.title || ''}" />
              </div>
              <div class="thumb-info">
                <div class="thumb-title">${item.source_video_title || item.title || ''}</div>
                <div class="thumb-meta">
                  ${item.source_channel_name ? `<span>${item.source_channel_name}</span>` : ''}
                  ${item.dna_score ? `<span class="thumb-score">${item.dna_score}점</span>` : ''}
                  ${item.category ? `<span class="thumb-cat">${item.category}</span>` : ''}
                  ${item.created_at ? `<span>${item.created_at.slice(0, 10)}</span>` : ''}
                </div>
              </div>
              <div class="thumb-actions">
                <button class="thumb-download"
                  data-url="${item.source_thumbnail_url}"
                  data-name="${item.source_video_id || 'thumbnail'}.jpg"
                >다운로드</button>
                <button class="thumb-del-btn" data-id="${item.id}">삭제</button>
              </div>
            </div>
          `).join('')}
        </div>`;

      contentEl.querySelectorAll('.thumb-download').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          const url = btn.dataset.url;
          const name = btn.dataset.name;
          try {
            btn.textContent = '다운로드 중...';
            btn.disabled = true;
            const resp = await fetch(url);
            const blob = await resp.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
            btn.innerHTML = `${icons.success()} 완료`;
            setTimeout(() => { btn.innerHTML = `${icons.download()} 다운로드`; btn.disabled = false; }, 1500);
          } catch {
            btn.innerHTML = `${icons.error()} 실패`;
            setTimeout(() => { btn.innerHTML = `${icons.download()} 다운로드`; btn.disabled = false; }, 1500);
          }
        });
      });

      contentEl.querySelectorAll('.thumb-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('삭제하시겠습니까?')) return;
          await api.request(`/ideas/${btn.dataset.id}`, { method: 'DELETE' });
          loadContent();
        });
      });
    } catch(e) {
      contentEl.innerHTML = '<div class="idea-empty">로드 실패</div>';
    }
  }

  function showEditModal(item = null) {
    const isEdit = !!item;
    const overlay = document.createElement('div');
    overlay.className = 'idea-modal-overlay';
    overlay.innerHTML = `
      <div class="idea-modal">
        <div class="idea-modal-header">
          <h3>${isEdit ? '아이디어 수정' : '새 아이디어'}</h3>
          <button class="idea-modal-close">${icons.close()}</button>
        </div>
        <div class="idea-modal-body">
          <label class="idea-modal-label">카테고리</label>
          <select id="idea-modal-cat" class="idea-select" style="width:100%; margin-bottom:14px;">
            <option value="">선택 안함</option>
            ${categoryFilter.innerHTML}
          </select>
          <label class="idea-modal-label">제목</label>
          <input type="text" id="idea-modal-title" class="idea-modal-input"
                 value="${isEdit ? (item.title || '').replace(/"/g, '&quot;') : ''}"
                 placeholder="아이디어 제목" />
          <label class="idea-modal-label">내용</label>
          <textarea id="idea-modal-desc" class="idea-modal-textarea"
                    placeholder="아이디어 내용을 자유롭게 작성하세요"
          >${isEdit ? (item.description || '') : ''}</textarea>
        </div>
        <div class="idea-modal-footer">
          <button id="idea-modal-save" class="idea-modal-save">
            ${isEdit ? '수정' : '저장'}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    if (isEdit && item.category) {
      overlay.querySelector('#idea-modal-cat').value = item.category;
    }

    overlay.querySelector('.idea-modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#idea-modal-save').addEventListener('click', async () => {
      const title = overlay.querySelector('#idea-modal-title').value.trim();
      if (!title) { alert('제목을 입력하세요'); return; }
      const body = {
        title,
        description: overlay.querySelector('#idea-modal-desc').value.trim(),
        category: overlay.querySelector('#idea-modal-cat').value
      };
      if (isEdit) {
        await api.request(`/ideas/${item.id}`, { method: 'PUT', body });
      } else {
        await api.request('/ideas', { method: 'POST', body: { ...body, idea_type: 'memo' } });
      }
      overlay.remove();
      loadContent();
    });
  }

  loadCategories();
  loadContent();

  // 탭 재진입 시 데이터 자동 갱신
  registerPageShowCallback('/ideas', () => loadContent());
}
