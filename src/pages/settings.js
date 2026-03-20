// Settings page
import { icons } from '../components/icons.js';

export async function renderSettings(container, { api }) {
  container.innerHTML = `
    <div class="stg-page">
      <div class="stg-header">
        <h2>설정</h2>
      </div>

      <div class="stg-tabs">
        <button class="stg-tab active" data-tab="apikeys">API 키 관리</button>
        <button class="stg-tab" data-tab="general">일반 설정</button>
        <button class="stg-tab" data-tab="database">데이터베이스</button>
        <button class="stg-tab" data-tab="guidelines">지침 관리</button>
      </div>

      <div id="stg-content" class="stg-content"></div>
    </div>
  `;

  let currentTab = 'apikeys';

  container.querySelectorAll('.stg-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.stg-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      loadTab();
    });
  });

  function loadTab() {
    if (currentTab === 'apikeys') loadApiKeys();
    else if (currentTab === 'general') loadGeneral();
    else if (currentTab === 'database') loadDatabase();
    else if (currentTab === 'guidelines') loadGuidelines();
  }

  // ━━━━━ API 키 관리 ━━━━━
  async function loadApiKeys() {
    const content = container.querySelector('#stg-content');
    content.innerHTML = '<div class="stg-loading">불러오는 중...</div>';

    try {
      const data = await api.request('/settings/api-keys');
      const keys = data.keys || [];

      const keyTypes = [
        { type: 'youtube_api_key', label: 'YouTube API 키', icon: icons.dotRed() },
        { type: 'gemini_api_key', label: 'Gemini API 키', icon: icons.dotPurple() },
        { type: 'google_project_id', label: 'Google Cloud 프로젝트 ID', icon: icons.dotBlue() }
      ];

      content.innerHTML = `
        <div class="stg-apikeys">
          ${keyTypes.map(kt => {
            const typeKeys = keys.filter(k => k.key_type === kt.type);
            return `
              <div class="stg-key-section">
                <div class="stg-key-section-header">
                  <span class="stg-key-icon">${kt.icon}</span>
                  <h3>${kt.label}</h3>
                  <button class="stg-key-add-btn" data-type="${kt.type}">${icons.plus(14)} 추가</button>
                </div>
                <div class="stg-key-list" data-type="${kt.type}">
                  ${typeKeys.length === 0
                    ? '<div class="stg-key-empty">등록된 키가 없습니다</div>'
                    : typeKeys.map(k => renderKeyRow(k)).join('')
                  }
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;

      bindApiKeyEvents(content);
    } catch (err) {
      content.innerHTML = '<div class="stg-error">API 키 로드 실패</div>';
    }
  }

  function renderKeyRow(k) {
    const isActive = k.is_active === 1;
    return `
      <div class="stg-key-row ${isActive ? 'active' : ''}" data-id="${k.id}">
        <div class="stg-key-info">
          <div class="stg-key-name-row">
            <span class="stg-key-name">${k.key_name || ''}</span>
            ${isActive ? '<span class="stg-key-badge">사용중</span>' : ''}
          </div>
          <div class="stg-key-value">
            ${k.key_value_masked || ''}
            ${k.key_type === 'google_project_id' ?
              `<span style="font-size:12px;margin-left:8px;color:${k.hasServiceAccount ? '#4ade80' : '#f59e0b'};">
                ${k.hasServiceAccount ? 'JSON 등록됨' : 'JSON 미등록'}
              </span>` : ''
            }
          </div>
        </div>
        <div class="stg-key-actions">
          ${!isActive ? `<button class="stg-btn stg-btn-activate" data-id="${k.id}">사용</button>` : ''}
          <button class="stg-btn stg-btn-edit" data-id="${k.id}" data-key-type="${k.key_type}">수정</button>
          ${!isActive ? `<button class="stg-btn stg-btn-delete" data-id="${k.id}">삭제</button>` : ''}
        </div>
      </div>
    `;
  }

  function bindApiKeyEvents(content) {
    content.querySelectorAll('.stg-key-add-btn').forEach(btn => {
      btn.addEventListener('click', () => showKeyModal(btn.dataset.type, null));
    });

    content.querySelectorAll('.stg-btn-activate').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api.request(`/settings/api-keys/${btn.dataset.id}/activate`, { method: 'PUT' });
          loadApiKeys();
        } catch (err) { alert('활성화 실패: ' + err.message); }
      });
    });

    content.querySelectorAll('.stg-btn-edit').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const data = await api.request('/settings/api-keys');
          const key = (data.keys || []).find(k => k.id === Number(btn.dataset.id));
          if (key) showKeyModal(key.key_type, key);
        } catch (err) { alert('키 정보 로드 실패'); }
      });
    });

    content.querySelectorAll('.stg-btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('이 키를 삭제하시겠습니까?')) return;
        try {
          await api.request(`/settings/api-keys/${btn.dataset.id}`, { method: 'DELETE' });
          loadApiKeys();
        } catch (err) { alert('삭제 실패: ' + err.message); }
      });
    });
  }

  function showKeyModal(keyType, existing) {
    const isEdit = !!existing;
    const isGoogleProject = keyType === 'google_project_id';
    const overlay = document.createElement('div');
    overlay.className = 'stg-modal-overlay';
    overlay.innerHTML = `
      <div class="stg-modal">
        <div class="stg-modal-header">
          <h3>${isEdit ? 'API 키 수정' : 'API 키 추가'}</h3>
          <button class="stg-modal-close">${icons.close()}</button>
        </div>
        <div class="stg-modal-body">
          <label class="stg-label">키 이름</label>
          <input type="text" id="stg-key-name" class="stg-input"
                 value="${isEdit ? (existing.key_name || '') : ''}"
                 placeholder="예: 메인 계정">

          <label class="stg-label" style="margin-top:12px;">키 값</label>
          <input type="text" id="stg-key-value" class="stg-input"
                 value="${isEdit ? (existing.key_value_full || existing.key_value || '') : ''}"
                 placeholder="${isGoogleProject ? 'Google Cloud 프로젝트 ID' : 'API 키 입력'}">

          ${isGoogleProject ? `
            <label class="stg-label" style="margin-top:12px;">서비스 계정 JSON 파일</label>
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="file" id="stg-sa-file" accept=".json"
                     style="flex:1;padding:8px;background:#1a1a2e;border:1px solid #333;
                            border-radius:8px;color:#ccc;font-size:14px;">
              <button id="stg-sa-guide" style="padding:8px 12px;background:#3a2a5a;
                      color:#c48bff;border:none;border-radius:8px;cursor:pointer;
                      font-size:13px;white-space:nowrap;">방법보기</button>
            </div>
            ${isEdit && existing.hasServiceAccount ?
              '<div style="margin-top:6px;font-size:13px;color:#4ade80;">JSON 파일 등록됨 (변경 시 새 파일 선택)</div>' :
              '<div style="margin-top:6px;font-size:13px;color:#f59e0b;">Vertex AI 사용을 위해 JSON 파일이 필요합니다</div>'
            }
          ` : ''}
        </div>
        <div class="stg-modal-footer">
          <button class="stg-btn stg-btn-cancel">취소</button>
          <button class="stg-btn stg-btn-save">${isEdit ? '수정' : '추가'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.stg-modal-close').onclick = () => overlay.remove();
    overlay.querySelector('.stg-btn-cancel').onclick = () => overlay.remove();
    let mousedownOnOverlay = false;
    overlay.addEventListener('mousedown', (e) => { mousedownOnOverlay = e.target === overlay; });
    overlay.addEventListener('click', (e) => { if (e.target === overlay && mousedownOnOverlay) overlay.remove(); });

    if (isGoogleProject) {
      const guideBtn = overlay.querySelector('#stg-sa-guide');
      if (guideBtn) {
        guideBtn.onclick = async () => {
          try {
            const guide = await api.request('/settings/service-account-guide');
            const guideHtml = guide.steps.map(s => `<div style="padding:6px 0;font-size:14px;color:#ddd;">${s}</div>`).join('');
            const guideOverlay = document.createElement('div');
            guideOverlay.className = 'stg-modal-overlay';
            guideOverlay.style.zIndex = '100000';
            guideOverlay.innerHTML = `
              <div class="stg-modal" style="max-width:560px;">
                <div class="stg-modal-header">
                  <h3>${guide.title}</h3>
                  <button class="stg-modal-close">${icons.close()}</button>
                </div>
                <div class="stg-modal-body">${guideHtml}</div>
                <div class="stg-modal-footer">
                  <button class="stg-btn stg-btn-save">확인</button>
                </div>
              </div>
            `;
            document.body.appendChild(guideOverlay);
            guideOverlay.querySelector('.stg-modal-close').onclick = () => guideOverlay.remove();
            guideOverlay.querySelector('.stg-btn-save').onclick = () => guideOverlay.remove();
            guideOverlay.addEventListener('click', (e) => { if (e.target === guideOverlay) guideOverlay.remove(); });
          } catch (err) {
            alert('가이드를 불러올 수 없습니다.');
          }
        };
      }
    }

    overlay.querySelector('.stg-btn-save').onclick = async () => {
      const keyName = overlay.querySelector('#stg-key-name').value.trim();
      const keyValue = overlay.querySelector('#stg-key-value').value.trim();
      if (!keyValue) { alert('키 값을 입력해 주세요.'); return; }

      try {
        const formData = new FormData();
        formData.append('key_name', keyName);
        formData.append('key_value', keyValue);

        if (isGoogleProject) {
          const fileInput = overlay.querySelector('#stg-sa-file');
          if (fileInput?.files[0]) {
            formData.append('service_account_file', fileInput.files[0]);
          } else if (!isEdit) {
            if (!confirm('서비스 계정 JSON 파일 없이 추가하시겠습니까?\nVertex AI를 사용하려면 JSON 파일이 필요합니다.')) return;
          }
        }

        if (isEdit) {
          await fetch('/api/settings/api-keys/' + existing.id, {
            method: 'PUT',
            body: isGoogleProject ? formData : JSON.stringify({ key_name: keyName, key_value: keyValue }),
            headers: isGoogleProject ? {} : { 'Content-Type': 'application/json' }
          });
        } else {
          formData.append('key_type', keyType);
          if (isGoogleProject) {
            await fetch('/api/settings/api-keys', {
              method: 'POST',
              body: formData
            });
          } else {
            await api.request('/settings/api-keys', {
              method: 'POST',
              body: { key_type: keyType, key_name: keyName, key_value: keyValue }
            });
          }
        }

        overlay.remove();
        loadApiKeys();
      } catch (err) {
        alert('저장 실패: ' + err.message);
      }
    };
  }

  // ━━━━━ 일반 설정 ━━━━━
  async function loadGeneral() {
    const content = container.querySelector('#stg-content');
    content.innerHTML = '<div class="stg-loading">불러오는 중...</div>';

    try {
      const settings = await api.request('/settings');
      const currentTheme = settings.theme || 'dark';

      content.innerHTML = `
        <div class="stg-general">
          <div class="stg-section">
            <div class="stg-section-header">
              <h3>테마</h3>
            </div>
            <div class="stg-theme-group">
              <button class="stg-theme-btn ${currentTheme === 'dark' ? 'active' : ''}" data-theme="dark">
                <span class="stg-theme-icon">🌙</span>
                <span>다크 모드</span>
              </button>
              <button class="stg-theme-btn ${currentTheme === 'light' ? 'active' : ''}" data-theme="light">
                <span class="stg-theme-icon">${icons.sun(18)}</span>
                <span>라이트 모드</span>
              </button>
            </div>
          </div>
        </div>
      `;

      content.querySelectorAll('.stg-theme-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const theme = btn.dataset.theme;
          document.body.dataset.theme = theme;
          content.querySelectorAll('.stg-theme-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          try {
            await api.request('/settings', { method: 'PUT', body: { theme } });
          } catch (err) { console.error('테마 저장 실패:', err); }
        });
      });

    } catch (err) {
      content.innerHTML = '<div class="stg-error">설정 로드 실패</div>';
    }
  }

  // ━━━━━ 데이터베이스 ━━━━━
  function loadDatabase() {
    const content = container.querySelector('#stg-content');
    content.innerHTML = `
      <div class="stg-database">
        <div class="stg-section">
          <div class="stg-section-header">
            <h3>데이터 백업</h3>
            <p class="stg-section-desc">모든 데이터를 파일로 다운로드합니다</p>
          </div>
          <button class="stg-btn stg-btn-primary" id="stg-backup-btn">백업 다운로드</button>
        </div>

        <div class="stg-section">
          <div class="stg-section-header">
            <h3>데이터 복원</h3>
            <p class="stg-section-desc">백업 파일을 업로드하여 데이터를 복원합니다</p>
          </div>
          <div class="stg-restore-group">
            <div class="stg-restore-options">
              <label class="stg-radio-label">
                <input type="radio" name="restore-mode" value="replace" checked>
                <span>전체 교체 – 기존 데이터를 백업 데이터로 교체</span>
              </label>
              <label class="stg-radio-label">
                <input type="radio" name="restore-mode" value="merge">
                <span>병합 – 중복 제외, 없는 데이터만 추가</span>
              </label>
            </div>
            <div class="stg-upload-area" id="stg-upload-area">
              <p>백업 파일(.db)을 여기에 드래그하거나 클릭하여 선택</p>
              <input type="file" id="stg-restore-file" accept=".db" hidden>
            </div>
            <div class="stg-restore-status" id="stg-restore-status"></div>
          </div>
        </div>
      </div>
    `;

    content.querySelector('#stg-backup-btn').addEventListener('click', async () => {
      const btn = content.querySelector('#stg-backup-btn');
      btn.disabled = true;
      btn.textContent = '백업 준비 중...';
      try {
        const response = await fetch('/api/settings/backup', { method: 'POST' });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || '백업 실패');
        }

        const reader = response.body.getReader();
        const contentLength = +response.headers.get('Content-Length') || 0;
        let received = 0;
        const chunks = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (contentLength > 0) {
            const percent = Math.round(received / contentLength * 100);
            btn.textContent = `다운로드 중... ${percent}%`;
          }
        }

        const blob = new Blob(chunks);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `yadam_backup_${new Date().toISOString().slice(0, 10)}.db`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        btn.innerHTML = `${icons.check()} 백업 완료`;
        setTimeout(() => { btn.textContent = '백업 다운로드'; btn.disabled = false; }, 3000);
      } catch (err) {
        btn.textContent = '백업 다운로드';
        btn.disabled = false;
        alert('백업 실패: ' + err.message);
      }
    });

    const uploadArea = content.querySelector('#stg-upload-area');
    const fileInput = content.querySelector('#stg-restore-file');
    const statusEl = content.querySelector('#stg-restore-status');

    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      if (e.dataTransfer.files[0]) handleRestore(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) handleRestore(fileInput.files[0]);
    });

    async function handleRestore(file) {
      if (!file.name.endsWith('.db')) {
        statusEl.innerHTML = '<span class="stg-status-error">.db 파일만 업로드 가능합니다</span>';
        return;
      }
      const mode = content.querySelector('input[name="restore-mode"]:checked').value;
      if (!confirm(mode === 'replace'
        ? '기존 데이터가 모두 교체됩니다. 계속하시겠습니까?'
        : '중복을 제외한 새 데이터만 추가됩니다. 계속하시겠습니까?'
      )) return;

      statusEl.innerHTML = '<span class="stg-status-loading">복원 중...</span>';
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('mode', mode);
        const response = await fetch('/api/settings/restore', { method: 'POST', body: formData });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '복원 실패');
        statusEl.innerHTML = `<span class="stg-status-success">${icons.check()} 복원 완료${result.added ? ' – ' + result.added + '건 추가' : ''}</span>`;
        setTimeout(() => location.reload(), 2000);
      } catch (err) {
        statusEl.innerHTML = `<span class="stg-status-error">복원 실패: ${err.message}</span>`;
      }
    }
  }

  // ━━━━━ 지침 관리 ━━━━━
  async function loadGuidelines() {
    const content = container.querySelector('#stg-content');

    // 카테고리 목록 동적 조회
    let categories = [];
    try {
      const catRes = await api.getChannelCategories();
      categories = catRes.categories || catRes || [];
    } catch (e) {
      categories = [];
    }

    if (categories.length === 0) {
      content.innerHTML = `
        <div class="gl-empty">
          <div class="gl-empty-icon">${icons.info ? icons.info(48) : '📋'}</div>
          <div class="gl-empty-title">등록된 카테고리가 없습니다</div>
          <div class="gl-empty-desc">채널 관리에서 카테고리를 먼저 추가해주세요.</div>
        </div>`;
      return;
    }

    // 전체 지침 조회
    let allGuidelines = [];
    try {
      allGuidelines = await api.getGuidelines();
    } catch (e) {
      allGuidelines = [];
    }

    const firstCat = categories[0].name || categories[0];

    content.innerHTML = `
      <div class="gl-container">
        <div class="gl-header">
          <h3 class="gl-title">지침 관리</h3>
          <p class="gl-desc">카테고리별 스토리 설계 지침과 세계관 설계 지침을 관리합니다.</p>
        </div>
        <div class="gl-cat-tabs">
          ${categories.map((c, i) => {
            const name = c.name || c;
            return `<button class="gl-cat-tab ${i === 0 ? 'active' : ''}" data-cat="${name}">${name}</button>`;
          }).join('')}
        </div>
        <div class="gl-body" data-current-cat="${firstCat}">
          <div class="gl-type-tabs">
            <button class="gl-type-tab active" data-type="topic_prompt">주제 추천 지침</button>
            <button class="gl-type-tab" data-type="thumbnail_prompt">썸네일 제목 추천 지침</button>
            <button class="gl-type-tab" data-type="story_design_prompt">스토리 설계 지침</button>
          </div>
          <div class="gl-list-area"></div>
          <div class="gl-actions">
            <button class="gl-btn gl-btn-upload">파일 업로드 (.txt)</button>
            <button class="gl-btn gl-btn-write">직접 작성</button>
          </div>
        </div>
      </div>`;

    // 상태 관리
    let currentCat = firstCat;
    let currentType = 'topic_prompt';

    function renderList() {
      const area = content.querySelector('.gl-list-area');
      const filtered = allGuidelines.filter(
        g => g.category === currentCat && g.type === currentType
      );

      if (filtered.length === 0) {
        area.innerHTML = `
          <div class="gl-no-item">
            <span>등록된 지침이 없습니다.</span>
            <span class="gl-no-item-sub">파일 업로드 또는 직접 작성으로 지침을 추가하세요.</span>
          </div>`;
        return;
      }

      area.innerHTML = filtered.map(g => `
        <div class="gl-item ${g.is_active ? 'gl-item-active' : ''}" data-id="${g.id}">
          <div class="gl-item-left">
            <div class="gl-item-status">${g.is_active ? '활성' : '비활성'}</div>
            <div class="gl-item-title">${g.title}</div>
            <div class="gl-item-date">${g.updated_at ? g.updated_at.slice(0, 10) : g.created_at?.slice(0, 10) || ''}</div>
          </div>
          <div class="gl-item-right">
            ${!g.is_active ? `<button class="gl-item-btn gl-item-activate" data-id="${g.id}">활성화</button>` : ''}
            <button class="gl-item-btn gl-item-edit" data-id="${g.id}">편집</button>
            <button class="gl-item-btn gl-item-del" data-id="${g.id}">삭제</button>
          </div>
        </div>`
      ).join('');

      // 활성화 버튼
      area.querySelectorAll('.gl-item-activate').forEach(btn => {
        btn.addEventListener('click', async () => {
          await api.activateGuideline(btn.dataset.id);
          allGuidelines = await api.getGuidelines();
          renderList();
        });
      });

      // 편집 버튼
      area.querySelectorAll('.gl-item-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
          const detail = await api.getGuideline(btn.dataset.id);
          showGuidelineEditor(detail);
        });
      });

      // 삭제 버튼
      area.querySelectorAll('.gl-item-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('이 지침을 삭제하시겠습니까?')) return;
          await api.deleteGuideline(btn.dataset.id);
          allGuidelines = await api.getGuidelines();
          renderList();
        });
      });

    }

    function showThumbRefModal(parentOverlay) {
      const overlay = document.createElement('div');
      overlay.className = 'thumb-ref-overlay';
      overlay.innerHTML = `
        <div class="thumb-ref-modal">
          <div class="thumb-ref-header">
            <div class="thumb-ref-header-left">
              <h3 class="thumb-ref-title">제목 레퍼런스 관리</h3>
              <span class="thumb-ref-total-badge" id="thumb-ref-total">0개</span>
            </div>
            <button class="thumb-ref-close-btn" id="thumb-ref-close">&times;</button>
          </div>
          <div class="thumb-ref-search-area">
            <div class="thumb-ref-search-wrap">
              <svg class="thumb-ref-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" class="thumb-ref-search-input" id="thumb-ref-search" placeholder="제목 검색...">
              <button class="thumb-ref-search-clear" id="thumb-ref-search-clear" style="display:none;">&times;</button>
            </div>
          </div>
          <div class="thumb-ref-list-area" id="thumb-ref-list"></div>
          <div class="thumb-ref-add-area">
            <div class="thumb-ref-add-row">
              <input type="text" class="thumb-ref-add-input" id="thumb-ref-new-title" placeholder="새 제목을 입력하세요...">
              <button class="thumb-ref-add-btn" id="thumb-ref-add-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                추가
              </button>
            </div>
            <div class="thumb-ref-msg" id="thumb-ref-msg"></div>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const listEl = overlay.querySelector('#thumb-ref-list');
      const totalEl = overlay.querySelector('#thumb-ref-total');
      const searchInput = overlay.querySelector('#thumb-ref-search');
      const clearBtn = overlay.querySelector('#thumb-ref-search-clear');
      const msgEl = overlay.querySelector('#thumb-ref-msg');
      const newTitleInput = overlay.querySelector('#thumb-ref-new-title');
      let debounceTimer = null;
      let allRefs = [];

      function showMsg(text, type) {
        msgEl.textContent = text;
        msgEl.className = 'thumb-ref-msg ' + (type === 'error' ? 'msg-error' : 'msg-success');
        setTimeout(() => { msgEl.textContent = ''; msgEl.className = 'thumb-ref-msg'; }, 3000);
      }

      function renderList(refs) {
        totalEl.textContent = allRefs.length + '개';
        if (refs.length === 0) {
          const keyword = searchInput.value.trim();
          listEl.innerHTML = '<div class="thumb-ref-empty">' +
            (keyword ? '"' + keyword + '" 검색 결과가 없습니다.' : '등록된 제목이 없습니다.') + '</div>';
          return;
        }
        const keyword = searchInput.value.trim().toLowerCase();
        listEl.innerHTML = refs.map((r, i) => {
          let displayTitle = r.title;
          if (keyword) {
            const idx = displayTitle.toLowerCase().indexOf(keyword);
            if (idx !== -1) {
              displayTitle = displayTitle.substring(0, idx) +
                '<mark class="thumb-ref-highlight">' + displayTitle.substring(idx, idx + keyword.length) + '</mark>' +
                displayTitle.substring(idx + keyword.length);
            }
          }
          return `
            <div class="thumb-ref-row ${i % 2 === 0 ? 'even' : 'odd'}" data-ref-id="${r.id}">
              <span class="thumb-ref-num">${r.number}</span>
              <span class="thumb-ref-text">${displayTitle}</span>
              <button class="thumb-ref-del-btn" data-id="${r.id}" title="삭제">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>`;
        }).join('');
      }

      async function loadList() {
        listEl.innerHTML = '<div class="thumb-ref-loading">불러오는 중...</div>';
        try {
          const res = await api.getThumbReferences();
          allRefs = res.references || [];
          filterAndRender();
        } catch (err) {
          listEl.innerHTML = '<div class="thumb-ref-empty" style="color:#ff6b6b;">오류: ' + err.message + '</div>';
        }
      }

      function filterAndRender() {
        const keyword = searchInput.value.trim().toLowerCase();
        renderList(keyword ? allRefs.filter(r => r.title.toLowerCase().includes(keyword)) : allRefs);
      }

      loadList();

      overlay.querySelector('#thumb-ref-close').addEventListener('click', () => overlay.remove());
      let mouseDownTarget = null;
      overlay.addEventListener('mousedown', (e) => { mouseDownTarget = e.target; });
      overlay.addEventListener('mouseup', (e) => {
        if (mouseDownTarget === overlay && e.target === overlay) overlay.remove();
        mouseDownTarget = null;
      });

      searchInput.addEventListener('input', () => {
        clearBtn.style.display = searchInput.value ? 'flex' : 'none';
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => filterAndRender(), 300);
      });
      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        filterAndRender();
        searchInput.focus();
      });

      listEl.addEventListener('click', async (ev) => {
        const delBtn = ev.target.closest('.thumb-ref-del-btn');
        if (!delBtn) return;
        const refId = delBtn.dataset.id;
        const row = delBtn.closest('.thumb-ref-row');
        const origHTML = row.innerHTML;
        row.innerHTML = `
          <span class="thumb-ref-confirm-text">이 제목을 삭제하시겠습니까?</span>
          <div class="thumb-ref-confirm-btns">
            <button class="thumb-ref-confirm-yes">삭제</button>
            <button class="thumb-ref-confirm-no">취소</button>
          </div>`;
        row.classList.add('confirming');
        row.querySelector('.thumb-ref-confirm-no').addEventListener('click', () => {
          row.innerHTML = origHTML;
          row.classList.remove('confirming');
        });
        row.querySelector('.thumb-ref-confirm-yes').addEventListener('click', async () => {
          try {
            await api.deleteThumbReference(refId);
            row.style.transition = 'opacity 0.3s, transform 0.3s';
            row.style.opacity = '0';
            row.style.transform = 'translateX(20px)';
            setTimeout(async () => {
              const scrollTop = listEl.scrollTop;
              await loadList();
              listEl.scrollTop = scrollTop;
              showMsg('삭제되었습니다.', 'success');
              if (parentOverlay) {
                const badge = parentOverlay.querySelector('#thumb-ref-badge');
                if (badge) badge.textContent = (allRefs.length - 1);
              }
            }, 300);
          } catch (err) {
            row.innerHTML = origHTML;
            row.classList.remove('confirming');
            showMsg('삭제 실패: ' + err.message, 'error');
          }
        });
      });

      async function addTitle() {
        const title = newTitleInput.value.trim();
        if (!title) { showMsg('제목을 입력해 주세요.', 'error'); return; }
        try {
          const result = await api.addThumbReference(title);
          showMsg(result.number + '번으로 추가되었습니다.', 'success');
          newTitleInput.value = '';
          newTitleInput.focus();
          await loadList();
          setTimeout(() => {
            listEl.scrollTop = listEl.scrollHeight;
            const lastRow = listEl.querySelector('.thumb-ref-row:last-child');
            if (lastRow) {
              lastRow.classList.add('thumb-ref-new-item');
              setTimeout(() => lastRow.classList.remove('thumb-ref-new-item'), 2000);
            }
          }, 100);
          if (parentOverlay) {
            const badge = parentOverlay.querySelector('#thumb-ref-badge');
            if (badge) badge.textContent = allRefs.length;
          }
        } catch (err) {
          showMsg((err.message.includes('duplicate') || err.message.includes('이미')) ? '이미 존재하는 제목입니다.' : '추가 실패: ' + err.message, 'error');
        }
      }

      overlay.querySelector('#thumb-ref-add-btn').addEventListener('click', addTitle);
      newTitleInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addTitle(); });
      setTimeout(() => searchInput.focus(), 100);
    }

    // 카테고리 탭 클릭
    content.querySelectorAll('.gl-cat-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        content.querySelectorAll('.gl-cat-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentCat = tab.dataset.cat;
        renderList();
      });
    });

    // 유형 탭 클릭
    content.querySelectorAll('.gl-type-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        content.querySelectorAll('.gl-type-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        renderList();
      });
    });

    // 파일 업로드 버튼
    content.querySelector('.gl-btn-upload').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt';
      input.addEventListener('change', async () => {
        if (!input.files[0]) return;
        const fileName = input.files[0].name.replace('.txt', '');
        const title = prompt('지침 제목을 입력하세요:', fileName);
        if (!title) return;

        const formData = new FormData();
        formData.append('file', input.files[0]);
        formData.append('category', currentCat);
        formData.append('type', currentType);
        formData.append('title', title);

        try {
          await api.uploadGuideline(formData);
          allGuidelines = await api.getGuidelines();
          renderList();
        } catch (e) {
          alert('업로드 실패: ' + e.message);
        }
      });
      input.click();
    });

    // 직접 작성 버튼
    content.querySelector('.gl-btn-write').addEventListener('click', () => {
      showGuidelineEditor(null);
    });

    // 편집/작성 모달
    function showGuidelineEditor(existing) {
      const isEdit = !!existing;
      const isThumbType = (isEdit ? existing?.type : currentType) === 'thumbnail_prompt';
      const overlay = document.createElement('div');
      overlay.className = 'gl-editor-overlay';
      overlay.innerHTML = `
        <div class="gl-editor-modal">
          <div class="gl-editor-header">
            <h3>${isEdit ? '지침 편집' : '새 지침 작성'}</h3>
            <button class="gl-editor-close">&times;</button>
          </div>
          <div class="gl-editor-body">
            <div class="gl-editor-field">
              <label>카테고리</label>
              <span class="gl-editor-cat">${isEdit ? existing.category : currentCat}</span>
            </div>
            <div class="gl-editor-field">
              <label>유형</label>
              <span class="gl-editor-type">${isEdit ? ({'topic_prompt':'주제 추천 지침','thumbnail_prompt':'썸네일 제목 추천 지침','story_design_prompt':'스토리 설계 지침'}[existing.type] || existing.type) : ({'topic_prompt':'주제 추천 지침','thumbnail_prompt':'썸네일 제목 추천 지침','story_design_prompt':'스토리 설계 지침'}[currentType] || currentType)}</span>
            </div>
            <div class="gl-editor-field">
              <label>제목</label>
              <input type="text" class="gl-editor-title" value="${isEdit ? existing.title : ''}" placeholder="지침 제목을 입력하세요">
            </div>
            <div class="gl-editor-field gl-editor-field-full">
              <label>내용</label>
              ${(isEdit ? existing.type : currentType) === 'story_design_prompt' ? `<p class="gl-editor-hint">지침 본문에 <strong>[주제 데이터]</strong>와 <strong>[DNA 설계 가이드]</strong> 텍스트를 반드시 포함해야 합니다. 이 위치에 자동으로 데이터가 삽입됩니다.</p>` : ''}
              ${isThumbType ? `
              <div class="thumb-ref-btn-row">
                <span class="thumb-ref-label-sub">하단의 {{THUMB_TITLE_REFERENCES}}에 자동 삽입됩니다</span>
                <button type="button" class="thumb-ref-open-btn" id="open-thumb-ref-btn">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                  제목 레퍼런스 관리
                  <span class="thumb-ref-badge" id="thumb-ref-badge"></span>
                </button>
              </div>` : ''}
              <textarea class="gl-editor-content" placeholder="지침 내용을 입력하세요...">${isEdit ? existing.content : ''}</textarea>
            </div>
          </div>
          <div class="gl-editor-footer">
            <button class="gl-btn gl-btn-cancel">취소</button>
            <button class="gl-btn gl-btn-save">${isEdit ? '수정 저장' : '등록'}</button>
          </div>
        </div>`;

      document.body.appendChild(overlay);

      if (isThumbType) {
        (async () => {
          try {
            const res = await api.getThumbReferences();
            const badge = overlay.querySelector('#thumb-ref-badge');
            if (badge) badge.textContent = res.total || 0;
          } catch (e) {}
        })();
        const refBtn = overlay.querySelector('#open-thumb-ref-btn');
        if (refBtn) refBtn.addEventListener('click', () => showThumbRefModal(overlay));
      }

      overlay.querySelector('.gl-editor-close').addEventListener('click', () => overlay.remove());
      overlay.querySelector('.gl-btn-cancel').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });

      overlay.querySelector('.gl-btn-save').addEventListener('click', async () => {
        const title = overlay.querySelector('.gl-editor-title').value.trim();
        const contentText = overlay.querySelector('.gl-editor-content').value.trim();

        if (!title || !contentText) {
          alert('제목과 내용을 모두 입력하세요.');
          return;
        }

        try {
          if (isEdit) {
            await api.updateGuideline(existing.id, { title, content: contentText });
          } else {
            await api.createGuideline({
              category: currentCat,
              type: currentType,
              title,
              content: contentText
            });
          }
          allGuidelines = await api.getGuidelines();
          renderList();
          overlay.remove();
        } catch (e) {
          alert('저장 실패: ' + e.message);
        }
      });
    }

    // 초기 렌더
    renderList();
  }

  loadTab();
}
