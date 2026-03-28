import { registerPageShowCallback } from '../page-events.js';

const TTS_SERVER_KEY = 'tts_server_url';
const TTS_PANEL_RATIO_KEY = 'tts_panel_ratio';
const DEFAULT_SERVER = 'http://127.0.0.1:7860';
const DEFAULT_RATIO = 0.6;

const SPEAKERS_FEMALE = [
  { id: 'Sohee',    name: 'Sohee',    lang: 'Korean',   langLabel: '한국어',         desc: '따뜻하고 감정 풍부한' },
  { id: 'Vivian',   name: 'Vivian',   lang: 'Chinese',  langLabel: '중국어',         desc: '밝고 경쾌한' },
  { id: 'Serena',   name: 'Serena',   lang: 'Chinese',  langLabel: '중국어',         desc: '따뜻하고 부드러운' },
  { id: 'Ono_anna', name: 'Ono Anna', lang: 'Japanese', langLabel: '일본어',         desc: '발랄하고 경쾌한' },
];

const SPEAKERS_MALE = [
  { id: 'Uncle_fu', name: 'Uncle Fu', lang: 'Chinese',  langLabel: '중국어',         desc: '낮고 중후한' },
  { id: 'Dylan',    name: 'Dylan',    lang: 'Chinese',  langLabel: '중국어(베이징)', desc: '깔끔하고 명료한' },
  { id: 'Eric',     name: 'Eric',     lang: 'Chinese',  langLabel: '중국어(쓰촨)',   desc: '활기차고 허스키한' },
  { id: 'Ryan',     name: 'Ryan',     lang: 'English',  langLabel: '영어',           desc: '역동적이고 리듬감 있는' },
  { id: 'Aiden',    name: 'Aiden',    lang: 'English',  langLabel: '영어',           desc: '밝고 명료한' },
];

// 기존 코드 호환용 (다중 화자 매핑 L1617에서 사용)
const SPEAKERS = [...SPEAKERS_FEMALE, ...SPEAKERS_MALE].map(s => ({
  id: s.id,
  label: `${s.name} (${s.langLabel})`,
  lang: s.lang
}));

// 시드 "사용" 시 화자 설명 업데이트에 필요
window.SPEAKERS_FEMALE = SPEAKERS_FEMALE;
window.SPEAKERS_MALE = SPEAKERS_MALE;

const LANGUAGES = [
  'Auto', 'Korean', 'English', 'Japanese', 'Chinese',
  'French', 'German', 'Spanish', 'Portuguese', 'Russian', 'Italian'
];

function getSavedServer() {
  return localStorage.getItem(TTS_SERVER_KEY) || DEFAULT_SERVER;
}
function saveServer(url) {
  localStorage.setItem(TTS_SERVER_KEY, url);
}
function getSavedRatio() {
  const val = parseFloat(localStorage.getItem(TTS_PANEL_RATIO_KEY));
  return (val >= 0.3 && val <= 0.8) ? val : DEFAULT_RATIO;
}
function saveRatio(ratio) {
  localStorage.setItem(TTS_PANEL_RATIO_KEY, String(ratio));
}

async function checkConnection(api, url) {
  try {
    const res = await api.ttsConnectionTest(url);
    return { connected: res.success === true, message: res.message || '' };
  } catch (e) {
    return { connected: false, message: '서버에 연결할 수 없습니다.' };
  }
}

function updateBanner(container, connected, message) {
  const banner = container.querySelector('.tts-connection-banner');
  const statusDot = banner.querySelector('.tts-status-dot');
  const statusText = banner.querySelector('.tts-status-text');
  const input = banner.querySelector('.tts-server-input');
  if (connected) {
    banner.className = 'tts-connection-banner tts-connected';
    statusDot.className = 'tts-status-dot tts-dot-connected';
    statusText.textContent = 'Qwen3-TTS 연결됨';
  } else {
    banner.className = 'tts-connection-banner tts-disconnected';
    statusDot.className = 'tts-status-dot tts-dot-disconnected';
    statusText.textContent = message || 'Pinokio에서 Qwen3-TTS를 실행한 후 연결 테스트를 눌러주세요';
  }
  input.value = getSavedServer();
}

function stripChapterHeaders(text, enabled) {
  if (!enabled) return text;
  return text.replace(/^(INTRO|[0-9]+장)\s*[—\-].+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function countChars(text) {
  return text.replace(/\s/g, '').length;
}

function estimateTime(charCount) {
  if (charCount === 0) return '';
  const chunks = Math.ceil(charCount / 400);
  const minSec = chunks * 5;
  const maxSec = chunks * 10;
  if (maxSec < 60) return `약 ${minSec}~${maxSec}초`;
  const minMin = Math.ceil(minSec / 60);
  const maxMin = Math.ceil(maxSec / 60);
  if (minMin === maxMin) return `약 ${minMin}분`;
  return `약 ${minMin}~${maxMin}분`;
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.name.toLowerCase().endsWith('.txt')) {
      reject(new Error('txt 파일만 지원합니다.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('파일을 읽을 수 없습니다.'));
    reader.readAsText(file, 'UTF-8');
  });
}

export async function renderTts(container, { api, navigate, showToast }) {
  const savedUrl = getSavedServer();
  const savedRatio = getSavedRatio();
  let originalText = '';
  let stripEnabled = true;
  let isConnected = false;
  let guideLink = '';
  let isGenerating = false;
  const CHUNK_THRESHOLD = 400;
  let wavesurferInstance = null;

  container.innerHTML = `
    <div class="tts-studio-page">

      <!-- 연결 상태 배너 -->
      <div class="tts-connection-banner tts-checking">
        <div class="tts-banner-left">
          <span class="tts-status-dot tts-dot-checking"></span>
          <span class="tts-status-text">연결 확인 중...</span>
        </div>
        <div class="tts-banner-right">
          <button class="tts-guide-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            설치 가이드
          </button>
          <button class="tts-guide-edit-btn" title="가이드 링크 수정">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <input type="text" class="tts-server-input" value="${savedUrl}"
                 placeholder="http://127.0.0.1:7860" spellcheck="false" />
          <button class="tts-test-btn">연결 테스트</button>
        </div>
      </div>

      <!-- 메인 좌우 분할 -->
      <div class="tts-split-container">

        <!-- 좌측: 대본 입력 -->
        <div class="tts-panel-left" style="flex:${savedRatio}">
          <div class="tts-panel-header">
            <h3 class="tts-panel-title">대본 입력<span class="tts-char-count-header"></span></h3>
            <div class="tts-input-actions">
              <label class="tts-file-label">
                <input type="file" class="tts-file-input" accept=".txt" />
                <span class="tts-file-btn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                  파일 열기
                </span>
              </label>
            </div>
          </div>

          <div class="tts-textarea-wrap">
            <textarea class="tts-textarea"
                      placeholder="텍스트를 입력하거나 .txt 파일을 드래그하여 놓으세요..."
                      spellcheck="false"></textarea>
            <div class="tts-drop-overlay">
              <div class="tts-drop-overlay-content">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
                     stroke="var(--accent)" stroke-width="1.5"
                     stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span>.txt 파일을 여기에 놓으세요</span>
              </div>
            </div>
          </div>

          <div class="tts-input-footer">
            <div class="tts-toggles">
              <label class="tts-toggle">
                <input type="checkbox" class="tts-toggle-checkbox tts-strip-toggle" checked />
                <span class="tts-toggle-switch"></span>
                <span class="tts-toggle-label">챕터 헤더 제거</span>
              </label>
              <span class="tts-info-icon" data-tooltip="대본 내 챕터 제목(Chapter 1, 제1장 등)을 자동으로 제거하여 본문만 음성으로 생성합니다">ⓘ</span>
              <label class="tts-toggle">
                <input type="checkbox" class="tts-toggle-checkbox tts-multi-speaker-toggle" />
                <span class="tts-toggle-switch"></span>
                <span class="tts-toggle-label">다중 화자</span>
              </label>
              <span class="tts-info-icon" data-tooltip="대본의 역할별 화자를 AI가 자동 분석하고, 각 역할에 원하는 목소리를 매핑하여 생성합니다">ⓘ</span>
            </div>
          <div class="tts-multi-speaker-panel" style="display:none">
            <div class="tts-ms-api-select">
              <label class="tts-ms-radio">
                <input type="radio" name="tts-ms-api" value="ai_studio" checked />
                Google Studio API
              </label>
              <label class="tts-ms-radio">
                <input type="radio" name="tts-ms-api" value="vertex_ai" />
                Google Cloud API
              </label>
            </div>
            <button class="tts-ms-analyze-btn" disabled>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              화자 분석 (Gemini)
            </button>
            <div class="tts-ms-result" style="display:none">
              <div class="tts-ms-result-header">
                <span class="tts-ms-result-count"></span>
                <button class="tts-ms-reset-btn">초기화</button>
              </div>
              <div class="tts-ms-mapping-list"></div>
              <button class="tts-ms-reopen-btn">📋 매핑 수정</button>
            </div>
          </div>
          </div>
        </div>

        <!-- 리사이즈 핸들 -->
        <div class="tts-resize-handle">
          <div class="tts-resize-line"></div>
        </div>

        <!-- 우측: 음성 설정 -->
        <div class="tts-panel-right" style="flex:${1 - savedRatio}">

          <!-- 탭 헤더 -->
          <div class="tts-tabs">
            <button class="tts-tab active" data-tab="custom" data-tooltip="스타일 지시에 목소리 스타일(감정 등)을 영문으로 입력하여 테스트 해보세요">Custom Voice<span class="tts-tab-sub">맞춤 음성</span></button>
            <button class="tts-tab" data-tab="clone" data-tooltip="본인의 목소리 녹음 파일을 업로드하여 음성을 복제해보세요">Voice Clone<span class="tts-tab-sub">음성 복제</span></button>
            <button class="tts-tab" data-tab="design" data-tooltip="원하는 목소리톤을 영문으로 입력하여 원하는 음성을 디자인 해보세요">Voice Design<span class="tts-tab-sub">음성 디자인</span></button>
          </div>

          <!-- Custom Voice 탭 -->
          <div class="tts-tab-content tts-tab-custom active">
            <div class="tts-form-scroll">

              <div class="tts-form-group tts-speaker-group">
                <label class="tts-form-label">화자</label>
                <div class="tts-speaker-row">
                  <div class="tts-speaker-col">
                    <label class="tts-speaker-gender-label">♀ 여성</label>
                    <select class="tts-select tts-speaker-female-select">
                      ${SPEAKERS_FEMALE.map(s => `<option value="${s.id}" ${s.id === 'Sohee' ? 'selected' : ''}>${s.name} · ${s.langLabel}</option>`).join('')}
                    </select>
                  </div>
                  <div class="tts-speaker-col">
                    <label class="tts-speaker-gender-label">♂ 남성</label>
                    <select class="tts-select tts-speaker-male-select">
                      ${SPEAKERS_MALE.map(s => `<option value="${s.id}">${s.name} · ${s.langLabel}</option>`).join('')}
                    </select>
                  </div>
                </div>
                <div class="tts-speaker-desc">
                  <span class="tts-speaker-desc-name">Sohee</span> · 따뜻하고 감정 풍부한
                </div>
                <input type="hidden" class="tts-speaker-select" value="Sohee" />
                <button type="button" class="tts-speaker-seed-btn">시드 목소리 선택하기</button>
              </div>

              <div class="tts-form-group">
                <label class="tts-form-label">언어</label>
                <select class="tts-select tts-language-select">
                  ${LANGUAGES.map(l => `<option value="${l}" ${l === 'Korean' ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </div>

              <div class="tts-form-group">
                <label class="tts-form-label">스타일 지시 <span class="tts-form-hint">(선택) 영문으로 입력해주세요.</span></label>
                <textarea class="tts-instruct-input" rows="2"
                          placeholder="예: Speak in a calm and warm tone"
                          spellcheck="false"></textarea>
              </div>

              <div class="tts-form-group">
                <label class="tts-form-label">시드</label>
                <div class="tts-seed-row">
                  <input type="number" class="tts-seed-input" value="-1" min="-1" step="1" />
                  <span class="tts-seed-hint">-1은 랜덤으로 목소리 재현<br>시드번호 입력 시 동일한 목소리 재현</span>
                </div>
              </div>

              <div class="tts-form-group">
                <label class="tts-form-label">파트 간 간격 <span class="tts-info-icon" data-tooltip="긴 대본 분할 시 각 파트 사이에 삽입되는 무음 시간입니다">ⓘ</span></label>
                <div class="tts-silence-row">
                  <input type="range" class="tts-silence-slider" min="0" max="2" step="0.1" value="0.5" />
                  <span class="tts-silence-value">0.5초</span>
                </div>
              </div>

              <div class="tts-form-divider"></div>

              <button class="tts-generate-btn" disabled>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                음성 생성
              </button>

              <!-- 진행 표시 -->
              <div class="tts-progress-area" style="display:none">
                <div class="tts-progress-bar-wrap">
                  <div class="tts-progress-bar"></div>
                </div>
                <div class="tts-progress-info">
                  <span class="tts-progress-step">준비 중...</span>
                  <span class="tts-progress-percent">0%</span>
                </div>
              </div>

              <div class="tts-voice-list-btn-wrap">
                <button type="button" class="tts-voice-list-btn">
                  📋 저장된 음성 리스트 보기
                </button>
              </div>

            </div>
          </div>

          <!-- Voice Clone 탭 -->
          <div class="tts-tab-content tts-tab-clone">
            <div class="tts-form-scroll">

              <div class="tts-form-group">
                <label class="tts-form-label">참조 음성 파일</label>
                <div class="tts-clone-upload-area">
                  <input type="file" class="tts-clone-file-input"
                         accept=".wav,.mp3,.ogg,.flac,.m4a,.webm" />
                  <div class="tts-clone-upload-placeholder">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                         stroke="var(--text-secondary)" stroke-width="1.5"
                         stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="17 8 12 3 7 8"/>
                      <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <span>음성 파일을 드래그하거나 클릭하여 선택</span>
                    <span class="tts-clone-upload-hint">WAV, MP3, OGG, FLAC, M4A 지원</span>
                  </div>
                  <div class="tts-clone-file-info" style="display:none">
                    <span class="tts-clone-file-name"></span>
                    <button class="tts-clone-file-remove" title="파일 제거">&times;</button>
                  </div>
                </div>
              </div>

              <div class="tts-form-group">
                <label class="tts-form-label">
                  참조 텍스트
                  <span class="tts-info-icon" data-tooltip="참조 오디오의 내용을 AI가 자동으로 텍스트로 변환합니다. 직접 입력도 가능합니다">ⓘ</span>
                  <button class="tts-whisper-btn" title="Whisper 자동 전사">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    </svg>
                    자동 전사
                  </button>
                </label>
                <textarea class="tts-clone-ref-text" rows="2"
                          placeholder="참조 음성의 내용을 입력하거나 자동 전사 버튼을 클릭하세요"
                          spellcheck="false"></textarea>
              </div>

              <div class="tts-form-group">
                <label class="tts-form-label">언어</label>
                <select class="tts-select tts-clone-language">
                  ${LANGUAGES.map(l => `<option value="${l}" ${l === 'Korean' ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </div>

              <div class="tts-form-row">
                <div class="tts-form-group tts-form-half">
                  <label class="tts-form-label">모델 크기</label>
                  <select class="tts-select tts-clone-model-size">
                    <option value="1.7B" selected>1.7B</option>
                    <option value="0.6B">0.6B</option>
                  </select>
                </div>
                <div class="tts-form-group tts-form-half">
                  <label class="tts-form-label">시드</label>
                  <input type="number" class="tts-seed-input tts-clone-seed" value="-1" min="-1" step="1" />
                </div>
              </div>

              <div class="tts-advanced-section">
                <button type="button" class="tts-advanced-toggle">
                  <span class="tts-advanced-arrow">▶</span>
                  고급 설정 (첨부한 목소리로 왼쪽의 대본을 읽는 설정)
                </button>
                <div class="tts-advanced-content">
                  <div class="tts-form-row">
                    <div class="tts-form-group tts-form-half">
                      <label class="tts-form-label">청크 크기 <span class="tts-info-icon" data-tooltip="왼쪽에 입력된 긴 대본을 나누어 목소리가 생성되는 단위입니다. 기본값 200자를 권장합니다">ⓘ</span></label>
                      <input type="number" class="tts-seed-input tts-clone-chunk-chars" value="200" min="50" max="500" step="10" />
                    </div>
                    <div class="tts-form-group tts-form-half">
                      <label class="tts-form-label">청크 간격 <span class="tts-info-icon" data-tooltip="분할된 구간 사이의 쉬는 시간입니다. 0초면 바로 이어지고, 0.5초면 살짝 쉽니다">ⓘ</span></label>
                      <input type="number" class="tts-seed-input tts-clone-chunk-gap" value="0" min="0" max="3" step="0.1" />
                    </div>
                  </div>

                  <label class="tts-toggle" style="margin-bottom:14px">
                    <input type="checkbox" class="tts-toggle-checkbox tts-clone-xvector" />
                    <span class="tts-toggle-switch"></span>
                    <span class="tts-toggle-label">xvector만 사용 (빠르지만 품질 낮음)</span>
                  </label>
                  <span class="tts-info-icon" data-tooltip="참조 텍스트 없이 음색만으로 복제합니다. 녹음 내용을 모를 때 사용하세요. 품질이 약간 낮습니다">ⓘ</span>
                </div>
              </div>

              <div class="tts-form-divider"></div>

              <button class="tts-generate-clone-btn" disabled>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                음성 클론 생성
              </button>

              <div class="tts-clone-progress-area" style="display:none">
                <div class="tts-progress-bar-wrap">
                  <div class="tts-progress-bar tts-clone-progress-bar"></div>
                </div>
                <div class="tts-progress-info">
                  <span class="tts-progress-step tts-clone-progress-step">준비 중...</span>
                  <span class="tts-progress-percent tts-clone-progress-percent">0%</span>
                </div>
              </div>

              <div class="tts-voice-list-btn-wrap">
                <button type="button" class="tts-voice-list-btn">
                  📋 저장된 음성 리스트 보기
                </button>
              </div>

            </div>
          </div>

          <!-- Voice Design 탭 -->
          <div class="tts-tab-content tts-tab-design">
            <div class="tts-form-scroll">

              <div class="tts-form-group">
                <label class="tts-form-label">음성 설명 <span class="tts-form-hint">(영문으로 입력해주세요)</span></label>
                <textarea class="tts-design-description" rows="4"
                          placeholder="예: A Korean woman in her 40s with a calm, warm, and storytelling tone. She speaks slowly and softly, like narrating a traditional Korean folk tale late at night."
                          spellcheck="false"></textarea>
                <p class="tts-design-desc-hint">영어로 작성하면 더 정확한 결과를 얻을 수 있습니다.</p>
              </div>

              <div class="tts-form-group">
                <label class="tts-form-label">언어</label>
                <select class="tts-select tts-design-language">
                  ${LANGUAGES.map(l => `<option value="${l}" ${l === 'Korean' ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </div>

              <div class="tts-form-group">
                <label class="tts-form-label">시드</label>
                <div class="tts-seed-row">
                  <input type="number" class="tts-seed-input tts-design-seed" value="-1" min="-1" step="1" />
                  <span class="tts-seed-hint">-1은 랜덤으로 목소리 재현<br>시드번호 입력 시 동일한 목소리 재현</span>
                </div>
              </div>

              <div class="tts-form-divider"></div>

              <button class="tts-generate-design-btn" disabled>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                음성 디자인 생성
              </button>

              <div class="tts-design-progress-area" style="display:none">
                <div class="tts-progress-bar-wrap">
                  <div class="tts-progress-bar tts-design-progress-bar"></div>
                </div>
                <div class="tts-progress-info">
                  <span class="tts-progress-step tts-design-progress-step">준비 중...</span>
                  <span class="tts-progress-percent tts-design-progress-percent">0%</span>
                </div>
              </div>

              <div class="tts-voice-list-btn-wrap">
                <button type="button" class="tts-voice-list-btn">
                  📋 저장된 음성 리스트 보기
                </button>
              </div>

            </div>
          </div>

        </div>
      </div>

      <!-- 하단: 오디오 결과 -->
      <div class="tts-result-area" style="display:none">
        <div class="tts-result-header">
          <h3 class="tts-panel-title">생성 결과</h3>
          <div class="tts-result-meta">
            <span class="tts-result-duration"></span>
            <span class="tts-result-seed"></span>
          </div>
        </div>
        <div class="tts-waveform-container">
          <div class="tts-waveform" id="tts-waveform"></div>
        </div>
        <div class="tts-result-controls">
          <button class="tts-play-btn">
            <svg class="tts-play-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <svg class="tts-pause-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="display:none">
              <rect x="6" y="4" width="4" height="16"/>
              <rect x="14" y="4" width="4" height="16"/>
            </svg>
            재생
          </button>
          <button class="tts-download-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            다운로드
          </button>
          <button class="tts-save-seed-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
            시드 저장
          </button>
        </div>
      </div>

      <!-- 오디오 히스토리 -->
      <div class="tts-history-area" style="display:none"></div>

      <!-- 음성 리스트 모달 -->
      <div class="tts-voice-list-overlay" style="display:none">
        <div class="tts-voice-list-modal">
          <div class="tts-voice-list-header">
            <span class="tts-voice-list-title">저장된 음성 리스트</span>
            <button class="tts-voice-list-close">✕</button>
          </div>
          <div class="tts-voice-list-filters">
            <div class="tts-voice-list-main-filters">
              <button class="tts-vl-main-filter active" data-filter="all">전체</button>
              <button class="tts-vl-main-filter" data-filter="history">생성 기록</button>
              <button class="tts-vl-main-filter" data-filter="seed">시드 목소리</button>
            </div>
            <div class="tts-voice-list-search-wrap">
              <span class="tts-voice-list-search-icon">🔍</span>
              <input type="text" class="tts-voice-list-search" placeholder="파일명, 텍스트, 화자로 검색..." />
            </div>
            <div class="tts-voice-list-sub-filters">
              <button class="tts-vl-sub-filter active" data-sub="all">전체</button>
              <button class="tts-vl-sub-filter" data-sub="custom">Custom Voice</button>
              <button class="tts-vl-sub-filter" data-sub="clone">Voice Clone</button>
              <button class="tts-vl-sub-filter" data-sub="design">Voice Design</button>
            </div>
          </div>
          <div class="tts-voice-list-content"></div>
          <div class="tts-voice-list-pagination"></div>
        </div>
      </div>

      <!-- 시드 저장 모달 -->
      <div class="tts-seed-modal-overlay" style="display:none">
        <div class="tts-guide-modal">
          <div class="tts-guide-modal-header">
            <h3>시드 저장</h3>
            <button class="tts-seed-modal-close">&times;</button>
          </div>
          <div class="tts-guide-modal-body">
            <div class="tts-form-group">
              <label class="tts-form-label">이름</label>
              <input type="text" class="tts-seed-name-input" placeholder="예: 차분한 여성 목소리" spellcheck="false" />
            </div>
            <div class="tts-form-group">
              <label class="tts-form-label">시드 값</label>
              <input type="number" class="tts-seed-value-display" readonly />
            </div>
            <button class="tts-seed-save-confirm-btn">저장</button>
          </div>
        </div>
      </div>

      <!-- 다중 화자 매핑 모달 -->
      <div class="tts-ms-modal-overlay" style="display:none">
        <div class="tts-ms-modal">
          <div class="tts-ms-modal-header">
            <div class="tts-ms-header-left">
              <span class="tts-ms-title">다중 화자 매핑</span>
              <span class="tts-ms-title-hint">(대사 1개의 경우 나레이션으로 기본 셋팅 되어 있습니다. 필요 시 변경해주세요)</span>
            </div>
            <div class="tts-ms-header-right">
              <span class="tts-ms-summary"></span>
              <button class="tts-ms-close-btn">✕</button>
            </div>
          </div>
          <div class="tts-ms-body">
            <div class="tts-ms-speaker-list"></div>
            <div class="tts-ms-mapping-panel"></div>
          </div>
          <div class="tts-ms-modal-footer">
            <button class="tts-ms-reset-btn">초기화</button>
            <div class="tts-ms-footer-actions">
              <button class="tts-ms-cancel-btn">취소</button>
              <button class="tts-ms-confirm-btn">매핑 확인 ✓</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 가이드 링크 편집 모달 -->
      <div class="tts-guide-modal-overlay" style="display:none">
        <div class="tts-guide-modal">
          <div class="tts-guide-modal-header">
            <h3>설치 가이드 링크 수정</h3>
            <button class="tts-guide-modal-close">&times;</button>
          </div>
          <div class="tts-guide-modal-body">
            <div class="tts-guide-modal-step tts-guide-step-pw">
              <label class="tts-form-label">비밀번호</label>
              <input type="password" class="tts-guide-pw-input" placeholder="비밀번호를 입력하세요" />
              <button class="tts-guide-pw-btn">확인</button>
              <p class="tts-guide-pw-error" style="display:none">비밀번호가 틀렸습니다.</p>
            </div>
            <div class="tts-guide-modal-step tts-guide-step-edit" style="display:none">
              <label class="tts-form-label">블로그 링크 URL</label>
              <input type="text" class="tts-guide-link-input" placeholder="https://blog.naver.com/..." spellcheck="false" />
              <button class="tts-guide-save-btn">저장</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  `;

  // === DOM 참조 ===
  const testBtn = container.querySelector('.tts-test-btn');
  const serverInput = container.querySelector('.tts-server-input');
  const textarea = container.querySelector('.tts-textarea');
  const fileInput = container.querySelector('.tts-file-input');
  const dropOverlay = container.querySelector('.tts-drop-overlay');
  const textareaWrap = container.querySelector('.tts-textarea-wrap');
  const stripToggle = container.querySelector('.tts-strip-toggle');
  const resizeHandle = container.querySelector('.tts-resize-handle');
  const panelLeft = container.querySelector('.tts-panel-left');
  const panelRight = container.querySelector('.tts-panel-right');
  const splitContainer = container.querySelector('.tts-split-container');
  const generateBtn = container.querySelector('.tts-generate-btn');
  const speakerSelect = container.querySelector('.tts-speaker-select');
  const languageSelect = container.querySelector('.tts-language-select');
  const instructInput = container.querySelector('.tts-instruct-input');
  const seedInput = container.querySelector('.tts-seed-input');
  const silenceSlider = container.querySelector('.tts-silence-slider');
  const silenceValue = container.querySelector('.tts-silence-value');
  const progressArea = container.querySelector('.tts-progress-area');
  const progressBar = container.querySelector('.tts-progress-bar');
  const progressStep = container.querySelector('.tts-progress-step');
  const progressPercent = container.querySelector('.tts-progress-percent');
  const resultArea = container.querySelector('.tts-result-area');
  const resultDuration = container.querySelector('.tts-result-duration');
  const resultSeed = container.querySelector('.tts-result-seed');
  const playBtn = container.querySelector('.tts-play-btn');
  const downloadBtn = container.querySelector('.tts-download-btn');

  // History & Seeds DOM
  const saveSeedBtn = container.querySelector('.tts-save-seed-btn');
  const seedModalOverlay = container.querySelector('.tts-seed-modal-overlay');
  const seedModalClose = container.querySelector('.tts-seed-modal-close');
  const seedNameInput = container.querySelector('.tts-seed-name-input');
  const seedValueDisplay = container.querySelector('.tts-seed-value-display');
  const seedSaveConfirmBtn = container.querySelector('.tts-seed-save-confirm-btn');
  const historyList = container.querySelector('.tts-history-list');
  const historySearch = container.querySelector('.tts-history-search');
  const historyPagination = container.querySelector('.tts-history-pagination');
  const historyBulkDeleteBtn = container.querySelector('.tts-history-bulk-delete-btn');
  const savedSeedsBtn = container.querySelector('.tts-saved-seeds-btn');
  const seedsListOverlay = container.querySelector('.tts-seeds-list-overlay');
  const seedsListClose = container.querySelector('.tts-seeds-list-close');
  const seedsListContent = container.querySelector('.tts-seeds-list-content');

  let historyPage = 1;
  let historyQuery = '';
  let selectedHistoryIds = new Set();
  let lastGeneratedSeed = null;
  let lastGeneratedVoiceType = 'custom';
  let lastGeneratedSpeaker = null;
  let lastGeneratedDescription = null;

  const guideBtn = container.querySelector('.tts-guide-btn');
  const guideEditBtn = container.querySelector('.tts-guide-edit-btn');
  const guideModalOverlay = container.querySelector('.tts-guide-modal-overlay');
  const guideModalClose = container.querySelector('.tts-guide-modal-close');
  const guidePwInput = container.querySelector('.tts-guide-pw-input');
  const guidePwBtn = container.querySelector('.tts-guide-pw-btn');
  const guidePwError = container.querySelector('.tts-guide-pw-error');
  const guideLinkInput = container.querySelector('.tts-guide-link-input');
  const guideSaveBtn = container.querySelector('.tts-guide-save-btn');
  const guideStepPw = container.querySelector('.tts-guide-step-pw');
  const guideStepEdit = container.querySelector('.tts-guide-step-edit');

  // Voice Clone DOM
  const cloneFileInput = container.querySelector('.tts-clone-file-input');
  const cloneUploadArea = container.querySelector('.tts-clone-upload-area');
  const cloneUploadPlaceholder = container.querySelector('.tts-clone-upload-placeholder');
  const cloneFileInfo = container.querySelector('.tts-clone-file-info');
  const cloneFileName = container.querySelector('.tts-clone-file-name');
  const cloneFileRemove = container.querySelector('.tts-clone-file-remove');
  const cloneRefText = container.querySelector('.tts-clone-ref-text');
  const whisperBtn = container.querySelector('.tts-whisper-btn');
  const cloneLanguage = container.querySelector('.tts-clone-language');
  const cloneModelSize = container.querySelector('.tts-clone-model-size');
  const cloneSeed = container.querySelector('.tts-clone-seed');
  const cloneChunkChars = container.querySelector('.tts-clone-chunk-chars');
  const cloneChunkGap = container.querySelector('.tts-clone-chunk-gap');
  const cloneXvector = container.querySelector('.tts-clone-xvector');
  const generateCloneBtn = container.querySelector('.tts-generate-clone-btn');
  const cloneProgressArea = container.querySelector('.tts-clone-progress-area');
  const cloneProgressBar = container.querySelector('.tts-clone-progress-bar');
  const cloneProgressStep = container.querySelector('.tts-clone-progress-step');
  const cloneProgressPercent = container.querySelector('.tts-clone-progress-percent');

  let cloneFile = null;

  // Voice Design DOM
  const designDescription = container.querySelector('.tts-design-description');
  const designLanguage = container.querySelector('.tts-design-language');
  const designSeed = container.querySelector('.tts-design-seed');
  const generateDesignBtn = container.querySelector('.tts-generate-design-btn');
  const designProgressArea = container.querySelector('.tts-design-progress-area');
  const designProgressBar = container.querySelector('.tts-design-progress-bar');
  const designProgressStep = container.querySelector('.tts-design-progress-step');
  const designProgressPercent = container.querySelector('.tts-design-progress-percent');

  const waveformEl = container.querySelector('#tts-waveform');
  const tabs = container.querySelectorAll('.tts-tab');
  const tabContents = container.querySelectorAll('.tts-tab-content');

  let currentAudioUrl = '';
  let currentFilename = '';

  // Multi-speaker DOM
  const multiSpeakerToggle = container.querySelector('.tts-multi-speaker-toggle');
  const msPanel = container.querySelector('.tts-multi-speaker-panel');
  const msAnalyzeBtn = container.querySelector('.tts-ms-analyze-btn');
  const msResult = container.querySelector('.tts-ms-result');
  const msResultCount = container.querySelector('.tts-ms-result-count');
  const msResetBtn = container.querySelector('.tts-ms-reset-btn');
  const msMappingList = container.querySelector('.tts-ms-mapping-list');

  // 다중 화자 매핑 모달용
  let msModalOverlay = null;
  let msModalSpeakerList = null;
  let msMappingPanel = null;
  let msActiveIndex = 0;
  let msSpeakerData = [];
  let msCurrentAudio = null;

  msModalOverlay = container.querySelector('.tts-ms-modal-overlay');
  msModalSpeakerList = container.querySelector('.tts-ms-speaker-list');
  msMappingPanel = container.querySelector('.tts-ms-mapping-panel');

  let multiSpeakerEnabled = false;
  let analyzedSegments = [];
  let speakerMap = {};

  // === 연결 상태 업데이트 후 버튼 활성화 ===
  function updateConnectionState(connected) {
    isConnected = connected;
    updateGenerateBtn();
    updateGuideBtn(connected);
    updateCloneBtn();
    updateDesignBtn();
  }

  function updateGenerateBtn() {
    const hasText = textarea.value.trim().length > 0;
    generateBtn.disabled = !isConnected || !hasText || isGenerating;
  }

  // === 연결 테스트 ===
  async function runConnectionTest() {
    const url = serverInput.value.trim();
    if (!url) { showToast('서버 주소를 입력해주세요.', 'warning'); return; }
    testBtn.disabled = true;
    testBtn.textContent = '확인 중...';
    const banner = container.querySelector('.tts-connection-banner');
    banner.className = 'tts-connection-banner tts-checking';
    banner.querySelector('.tts-status-dot').className = 'tts-status-dot tts-dot-checking';
    banner.querySelector('.tts-status-text').textContent = '연결 확인 중...';
    const result = await checkConnection(api, url);
    if (result.connected) { saveServer(url); showToast('TTS 서버에 연결되었습니다.', 'success'); }
    updateBanner(container, result.connected, result.message);
    updateConnectionState(result.connected);
    testBtn.disabled = false;
    testBtn.textContent = '연결 테스트';
  }

  testBtn.addEventListener('click', runConnectionTest);
  serverInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runConnectionTest(); } });

  // === 무음 간격 슬라이더 ===
  silenceSlider.addEventListener('input', () => {
    silenceValue.textContent = parseFloat(silenceSlider.value).toFixed(1) + '초';
  });

  // === 텍스트 통계 ===
  const headerCountEl = container.querySelector('.tts-char-count-header');
  function updateStats() {
    const text = textarea.value;
    const count = countChars(text);
    if (headerCountEl) {
      const totalCount = text.length;
      const noSpaceCount = countChars(text);
      headerCountEl.textContent = '｜공백포함 ' + totalCount.toLocaleString() + '자 / 공백제외 ' + noSpaceCount.toLocaleString() + '자';
    }
    updateGenerateBtn();
  }

  function applyText(rawText) {
    originalText = rawText;
    textarea.value = stripChapterHeaders(rawText, stripEnabled);
    updateStats();
  }

  textarea.addEventListener('input', () => {
    originalText = textarea.value;
    updateStats();
  });

  // === 챕터 헤더 제거 토글 ===
  stripToggle.addEventListener('change', () => {
    stripEnabled = stripToggle.checked;
    textarea.value = stripEnabled ? stripChapterHeaders(originalText, true) : originalText;
    updateStats();
  });

  // === 파일 선택 ===
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try { const text = await readTextFile(file); applyText(text); showToast(`"${file.name}" 파일을 불러왔습니다.`, 'success'); }
    catch (err) { showToast(err.message, 'warning'); }
    fileInput.value = '';
  });

  // === 드래그 앤 드롭 ===
  let dragCounter = 0;
  textareaWrap.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropOverlay.classList.add('tts-drop-active'); });
  textareaWrap.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('tts-drop-active'); } });
  textareaWrap.addEventListener('dragover', (e) => { e.preventDefault(); });
  textareaWrap.addEventListener('drop', async (e) => {
    e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('tts-drop-active');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    try { const text = await readTextFile(file); applyText(text); showToast(`"${file.name}" 파일을 불러왔습니다.`, 'success'); }
    catch (err) { showToast(err.message, 'warning'); }
  });

  // === 리사이즈 핸들 ===
  let isResizing = false;
  resizeHandle.addEventListener('mousedown', (e) => { e.preventDefault(); isResizing = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const rect = splitContainer.getBoundingClientRect();
    let ratio = (e.clientX - rect.left) / rect.width;
    ratio = Math.max(0.3, Math.min(0.8, ratio));
    panelLeft.style.flex = ratio; panelRight.style.flex = 1 - ratio;
    saveRatio(ratio);
  });
  document.addEventListener('mouseup', () => { if (!isResizing) return; isResizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; });

  // === 탭 전환 ===
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      container.querySelector(`.tts-tab-${target}`).classList.add('active');
    });
  });

  // ─── 고급 설정 토글 ───
  (function initAdvancedToggle() {
    const toggle = container.querySelector('.tts-advanced-toggle');
    const content = container.querySelector('.tts-advanced-content');
    if (!toggle || !content) return;

    let open = false;
    toggle.addEventListener('click', () => {
      open = !open;
      content.style.display = open ? 'block' : 'none';
      toggle.querySelector('.tts-advanced-arrow')
        .style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
    });
  })();

  // ─── 프리미엄 툴팁 시스템 ───
  (function initPremiumTooltip() {
    let tooltipEl = null;
    let hideTimer = null;

    function showTooltip(e) {
      const target = e.currentTarget;
      const text = target.getAttribute('data-tooltip');
      if (!text) return;

      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

      if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'premium-tooltip';
        document.body.appendChild(tooltipEl);
      }

      tooltipEl.textContent = text;
      tooltipEl.style.display = 'block';
      tooltipEl.style.opacity = '0';

      const rect = target.getBoundingClientRect();
      const tipW = tooltipEl.offsetWidth;
      const tipH = tooltipEl.offsetHeight;

      let left = rect.left + rect.width / 2 - tipW / 2;
      let top = rect.top - tipH - 14;

      if (left < 12) left = 12;
      if (left + tipW > window.innerWidth - 12) {
        left = window.innerWidth - tipW - 12;
      }
      if (top < 12) {
        top = rect.bottom + 14;
      }

      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';

      requestAnimationFrame(() => {
        tooltipEl.style.opacity = '1';
      });
    }

    function hideTooltip() {
      hideTimer = setTimeout(() => {
        if (tooltipEl) {
          tooltipEl.style.opacity = '0';
          setTimeout(() => {
            if (tooltipEl) tooltipEl.style.display = 'none';
          }, 300);
        }
      }, 800);
    }

    container.querySelectorAll('[data-tooltip]').forEach(el => {
      el.addEventListener('mouseenter', showTooltip);
      el.addEventListener('mouseleave', hideTooltip);
    });
  })();

  // ─── 화자 선택 UI ───
  (function initSpeakerSelect() {
    const selF = container.querySelector('.tts-speaker-female-select');
    const selM = container.querySelector('.tts-speaker-male-select');
    const hidden = container.querySelector('input.tts-speaker-select');
    const descEl = container.querySelector('.tts-speaker-desc');
    const seedBtn = container.querySelector('.tts-speaker-seed-btn');

    if (!selF || !selM || !hidden) return;

    const allSpeakers = {};
    SPEAKERS_FEMALE.forEach(s => allSpeakers[s.id] = s);
    SPEAKERS_MALE.forEach(s => allSpeakers[s.id] = s);

    function updateDesc(id) {
      const s = allSpeakers[id];
      if (s && descEl) {
        descEl.innerHTML =
          '선택한 음성 - <span class="tts-speaker-desc-name">' + s.name + '</span> · ' + s.desc +
          ' <button class="tts-speaker-preview-btn" data-speaker="' + s.id + '" title="미리듣기">🔊</button>';
        const previewBtn = descEl.querySelector('.tts-speaker-preview-btn');
        if (previewBtn) {
          previewBtn.addEventListener('click', () => {
            const spkId = previewBtn.dataset.speaker;
            const audio = new Audio('/speaker-samples/' + spkId + '.wav');
            audio.play().catch(() => showToast('샘플 음성을 재생할 수 없습니다', 'error'));
          });
        }
      }
    }

    selF.addEventListener('focus', () => {
      hidden.value = selF.value;
      updateDesc(selF.value);
    });
    selF.addEventListener('change', () => {
      hidden.value = selF.value;
      updateDesc(selF.value);
    });

    selM.addEventListener('focus', () => {
      hidden.value = selM.value;
      updateDesc(selM.value);
    });
    selM.addEventListener('change', () => {
      hidden.value = selM.value;
      updateDesc(selM.value);
    });

  })();

  // ─── ⓘ 아이콘 툴팁 등록 (새로 추가된 요소) ───
  let infoHideTimer = null;
  container.querySelectorAll('.tts-info-icon[data-tooltip]').forEach(el => {
    el.addEventListener('mouseenter', function() {
      if (infoHideTimer) { clearTimeout(infoHideTimer); infoHideTimer = null; }
      let tip = document.querySelector('.premium-tooltip');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'premium-tooltip';
        document.body.appendChild(tip);
      }
      const text = this.getAttribute('data-tooltip');
      if (!text) return;
      tip.textContent = text;
      tip.style.display = 'block';
      tip.style.opacity = '0';
      const rect = this.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      let left = rect.left + rect.width / 2 - tipW / 2;
      let top = rect.top - tipH - 14;
      if (left < 12) left = 12;
      if (left + tipW > window.innerWidth - 12)
        left = window.innerWidth - tipW - 12;
      if (top < 12) top = rect.bottom + 14;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
      requestAnimationFrame(() => { tip.style.opacity = '1'; });
    });
    el.addEventListener('mouseleave', function() {
      infoHideTimer = setTimeout(() => {
        const tip = document.querySelector('.premium-tooltip');
        if (tip) {
          tip.style.opacity = '0';
          setTimeout(() => { tip.style.display = 'none'; }, 300);
        }
        infoHideTimer = null;
      }, 800);
    });
  });

  // ─── 고급 설정 / Clone 탭 ⓘ 아이콘 툴팁 등록 ───
  let advInfoTimer = null;
  container.querySelectorAll(
    '.tts-advanced-section .tts-info-icon[data-tooltip], .tts-tab-clone .tts-info-icon[data-tooltip]'
  ).forEach(el => {
    el.addEventListener('mouseenter', function() {
      if (advInfoTimer) { clearTimeout(advInfoTimer); advInfoTimer = null; }
      let tip = document.querySelector('.premium-tooltip');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'premium-tooltip';
        document.body.appendChild(tip);
      }
      tip.textContent = this.getAttribute('data-tooltip');
      tip.style.display = 'block';
      tip.style.opacity = '0';
      const rect = this.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      let left = rect.left + rect.width / 2 - tipW / 2;
      let top = rect.top - tipH - 14;
      if (left < 12) left = 12;
      if (left + tipW > window.innerWidth - 12)
        left = window.innerWidth - tipW - 12;
      if (top < 12) top = rect.bottom + 14;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
      requestAnimationFrame(() => { tip.style.opacity = '1'; });
    });
    el.addEventListener('mouseleave', function() {
      advInfoTimer = setTimeout(() => {
        const tip = document.querySelector('.premium-tooltip');
        if (tip) {
          tip.style.opacity = '0';
          setTimeout(() => { if (tip) tip.style.display = 'none'; }, 300);
        }
        advInfoTimer = null;
      }, 800);
    });
  });

  // === 음성 생성 ===
  generateBtn.addEventListener('click', async () => {
    if (isGenerating || !isConnected) return;
    const text = textarea.value.trim();
    if (!text) { showToast('텍스트를 입력해주세요.', 'warning'); return; }

    isGenerating = true;
    generateBtn.disabled = true;
    resultArea.style.display = 'none';

    const charCount = text.replace(/\s/g, '').length;

    if (charCount <= CHUNK_THRESHOLD) {
      // === 짧은 텍스트: 기존 단일 요청 (페이지 내 진행 바) ===
      generateBtn.innerHTML = `<svg class="tts-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/></svg> 생성 중...`;
      progressArea.style.display = 'block';
      progressBar.style.width = '0%';
      progressPercent.textContent = '';
      progressStep.textContent = 'Qwen3-TTS에 요청 중...';

      let fakeProgress = 0;
      const progressTimer = setInterval(() => {
        if (fakeProgress < 90) {
          fakeProgress += Math.random() * 8;
          if (fakeProgress > 90) fakeProgress = 90;
          progressBar.style.width = fakeProgress + '%';
          progressPercent.textContent = Math.round(fakeProgress) + '%';
          if (fakeProgress > 30) progressStep.textContent = '음성 생성 중...';
          if (fakeProgress > 70) progressStep.textContent = '오디오 저장 중...';
        }
      }, 500);

      try {
        const result = await api.ttsGenerateCustom({
          text,
          language: languageSelect.value,
          speaker: speakerSelect.value,
          instruct: instructInput.value.trim(),
          modelSize: '1.7B',
          seed: parseInt(seedInput.value, 10) || -1,
          serverUrl: getSavedServer()
        });

        clearInterval(progressTimer);

        if (result.success) {
          progressBar.style.width = '100%';
          progressPercent.textContent = '100%';
          progressStep.textContent = '완료!';
          setTimeout(async () => {
            progressArea.style.display = 'none';
            await showResult(result);
            showToast('음성이 생성되었습니다.', 'success');
          }, 600);
        } else {
          progressArea.style.display = 'none';
          showToast(result.message || '음성 생성에 실패했습니다.', 'error');
        }
      } catch (err) {
        clearInterval(progressTimer);
        progressArea.style.display = 'none';
        showToast('음성 생성 중 오류: ' + err.message, 'error');
      }

    } else {
      // === 긴 텍스트: Floating Panel + SSE (이어서 생성 지원) ===
      generateBtn.innerHTML = `<svg class="tts-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/></svg> 분할 생성 중...`;

      let longForceNew = false;
      let shouldRestart = false;

      do {
        shouldRestart = false;
        const longAbort = new AbortController();

        const panel = createFloatingPanel();
        document.body.appendChild(panel);
        const pBar = panel.querySelector('.tts-fp-bar');
        const pStep = panel.querySelector('.tts-fp-step');
        const pPercent = panel.querySelector('.tts-fp-percent');
        const pTitle = panel.querySelector('.tts-fp-title');
        const pMinimize = panel.querySelector('.tts-fp-minimize');
        const pBody = panel.querySelector('.tts-fp-body');
        const pNewBtn = panel.querySelector('.tts-fp-new-btn');

        let minimized = false;
        pMinimize.addEventListener('click', () => {
          minimized = !minimized;
          pBody.style.display = minimized ? 'none' : '';
          pMinimize.textContent = minimized ? '+' : '−';
        });

        pNewBtn.addEventListener('click', () => {
          shouldRestart = true;
          longForceNew = true;
          longAbort.abort();
          panel.remove();
        });

        try {
          const response = await fetch('/api/tts/generate-long', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: longAbort.signal,
            body: JSON.stringify({
              text,
              language: languageSelect.value,
              mode: 'custom',
              speaker: speakerSelect.value,
              instruct: instructInput.value.trim(),
              modelSize: '1.7B',
              seed: parseInt(seedInput.value, 10) || -1,
              silenceDuration: parseFloat(silenceSlider.value) || 0.5,
              serverUrl: getSavedServer(),
              multiSpeaker: multiSpeakerEnabled && analyzedSegments.length > 0,
              segments: multiSpeakerEnabled ? analyzedSegments.map(seg => ({
                type: seg.type, speaker: seg.speaker,
                text: seg.text, instruct: seg.instruct || ''
              })) : [],
              speakerMap: multiSpeakerEnabled ? speakerMap : {},
              forceNew: longForceNew
            })
          });
          longForceNew = false;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const event = JSON.parse(line.substring(6));
                  if (event.type === 'resume') {
                    pTitle.textContent = `TTS 이어서 생성 (${event.totalChunks}파트)`;
                    pStep.textContent = event.message;
                    pBar.style.width = event.percent + '%';
                    pPercent.textContent = event.percent + '%';
                    pNewBtn.style.display = '';
                  } else if (event.type === 'start') {
                    pStep.textContent = event.message;
                    pTitle.textContent = `TTS 생성 (${event.totalChunks}파트)`;
                  } else if (event.type === 'progress') {
                    pBar.style.width = event.percent + '%';
                    pPercent.textContent = event.percent + '%';
                    pStep.textContent = event.message;
                  } else if (event.type === 'complete') {
                    pBar.style.width = '100%';
                    pPercent.textContent = '100%';
                    pStep.textContent = event.message;
                    pTitle.textContent = 'TTS 생성 완료';
                    setTimeout(async () => {
                      panel.remove();
                      await showResult(event);
                      showToast(`음성이 생성되었습니다. (${event.totalChunks}개 파트 병합)`, 'success');
                    }, 1500);
                  } else if (event.type === 'error') {
                    pStep.textContent = event.message;
                    pBar.style.background = 'var(--danger)';
                    if (event.savedMessage) {
                      const savedEl = document.createElement('div');
                      savedEl.style.cssText = 'margin-top:6px;font-size:12px;color:#f59e0b;';
                      savedEl.textContent = event.savedMessage;
                      pBody.appendChild(savedEl);
                      pNewBtn.style.display = '';
                    }
                    setTimeout(() => { if (panel.parentNode) panel.remove(); }, 5000);
                    showToast(event.message || '생성 중 오류가 발생했습니다.', 'error');
                  }
                } catch (pe) {}
              }
            }
          }
        } catch (err) {
          if (err.name === 'AbortError' && shouldRestart) {
            // "새로 생성" 버튼으로 abort — panel은 이미 제거됨, 루프 재시작
          } else {
            if (panel.parentNode) panel.remove();
            showToast('생성 중 오류: ' + err.message, 'error');
          }
        }
      } while (shouldRestart);
    }

    isGenerating = false;
    generateBtn.disabled = false;
    generateBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> 음성 생성`;
    updateGenerateBtn();
  });

  // === Floating Progress Panel ===
  function createFloatingPanel() {
    const panel = document.createElement('div');
    panel.className = 'tts-fp';
    panel.innerHTML = `
      <div class="tts-fp-header">
        <span class="tts-fp-title">TTS 생성 중...</span>
        <button class="tts-fp-minimize">−</button>
      </div>
      <div class="tts-fp-body">
        <div class="tts-fp-bar-wrap">
          <div class="tts-fp-bar"></div>
        </div>
        <div class="tts-fp-info">
          <span class="tts-fp-step">준비 중...</span>
          <span class="tts-fp-percent">0%</span>
        </div>
        <button class="tts-fp-new-btn" style="display:none;margin-top:8px;padding:4px 12px;border-radius:6px;border:1px solid #e74c3c;background:transparent;color:#e74c3c;cursor:pointer;font-size:12px;">새로 생성</button>
      </div>
    `;
    return panel;
  }

  // === 결과 표시 공통 함수 ===
  async function showResult(result) {
    lastGeneratedSeed = result.seed || null;
    currentFilename = result.filename;
    currentAudioUrl = `/tts-audio/${result.filename}`;
    resultDuration.textContent = result.duration ? `${result.duration.toFixed(1)}초` : '';
    resultSeed.textContent = result.seed ? `Seed: ${result.seed}` : '';
    resultArea.style.display = 'block';

    try {
      if (wavesurferInstance) { wavesurferInstance.destroy(); wavesurferInstance = null; }
      const WaveSurfer = (await import('wavesurfer.js')).default;
      wavesurferInstance = WaveSurfer.create({
        container: waveformEl,
        waveColor: 'rgba(124, 92, 255, 0.4)',
        progressColor: '#7c5cff',
        cursorColor: '#7c5cff',
        barWidth: 2, barGap: 1, barRadius: 2,
        height: 80, normalize: true, backend: 'WebAudio'
      });
      wavesurferInstance.load(currentAudioUrl);
      wavesurferInstance.on('finish', () => {
        playBtn.querySelector('.tts-play-icon').style.display = '';
        playBtn.querySelector('.tts-pause-icon').style.display = 'none';
        playBtn.childNodes[playBtn.childNodes.length - 1].textContent = ' 재생';
      });
    } catch (wsErr) {
      console.error('WaveSurfer init error:', wsErr);
      waveformEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:20px;">파형을 표시할 수 없습니다</p>';
    }

    playBtn.querySelector('.tts-play-icon').style.display = '';
    playBtn.querySelector('.tts-pause-icon').style.display = 'none';
    playBtn.childNodes[playBtn.childNodes.length - 1].textContent = ' 재생';
  }

  // === 재생/일시정지 ===
  playBtn.addEventListener('click', () => {
    if (!wavesurferInstance) return;
    wavesurferInstance.playPause();
    const isPlaying = wavesurferInstance.isPlaying();
    playBtn.querySelector('.tts-play-icon').style.display = isPlaying ? 'none' : '';
    playBtn.querySelector('.tts-pause-icon').style.display = isPlaying ? '' : 'none';
    playBtn.childNodes[playBtn.childNodes.length - 1].textContent = isPlaying ? ' 일시정지' : ' 재생';
  });

  // === 다운로드 ===
  downloadBtn.addEventListener('click', () => {
    if (!currentAudioUrl) return;
    const a = document.createElement('a');
    a.href = currentAudioUrl;
    a.download = currentFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  // === 설치 가이드 ===
  async function loadGuideLink() {
    try {
      const res = await api.ttsGetGuideLink();
      if (res.success) guideLink = res.link || '';
    } catch (e) { guideLink = ''; }
  }

  function updateGuideBtn(connected) {
    if (!connected && guideLink) {
      guideBtn.classList.add('tts-guide-pulse');
    } else {
      guideBtn.classList.remove('tts-guide-pulse');
    }
  }

  guideBtn.addEventListener('click', () => {
    if (guideLink) {
      window.open(guideLink, '_blank');
    } else {
      showToast('설치 가이드 링크가 설정되지 않았습니다.', 'warning');
    }
  });

  guideEditBtn.addEventListener('click', () => {
    guideModalOverlay.style.display = 'flex';
    guideStepPw.style.display = '';
    guideStepEdit.style.display = 'none';
    guidePwInput.value = '';
    guidePwError.style.display = 'none';
    guidePwInput.focus();
  });

  guideModalClose.addEventListener('click', () => {
    guideModalOverlay.style.display = 'none';
  });

  guideModalOverlay.addEventListener('click', (e) => {
    if (e.target === guideModalOverlay) guideModalOverlay.style.display = 'none';
  });

  guidePwBtn.addEventListener('click', () => {
    if (guidePwInput.value === '1212') {
      guideStepPw.style.display = 'none';
      guideStepEdit.style.display = '';
      guideLinkInput.value = guideLink;
      guideLinkInput.focus();
    } else {
      guidePwError.style.display = '';
    }
  });

  guidePwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); guidePwBtn.click(); }
  });

  guideSaveBtn.addEventListener('click', async () => {
    const newLink = guideLinkInput.value.trim();
    guideSaveBtn.disabled = true;
    guideSaveBtn.textContent = '저장 중...';
    try {
      const res = await api.ttsUpdateGuideLink(newLink, '1212');
      if (res.success) {
        guideLink = newLink;
        guideModalOverlay.style.display = 'none';
        showToast('가이드 링크가 저장되었습니다.', 'success');
        updateGuideBtn(isConnected);
      } else {
        showToast(res.message || '저장에 실패했습니다.', 'error');
      }
    } catch (err) {
      showToast('저장 중 오류가 발생했습니다.', 'error');
    }
    guideSaveBtn.disabled = false;
    guideSaveBtn.textContent = '저장';
  });

  guideLinkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); guideSaveBtn.click(); }
  });

  // === Voice Clone ===
  function updateCloneBtn() {
    const hasFile = cloneFile !== null;
    const hasText = textarea.value.trim().length > 0;
    generateCloneBtn.disabled = !isConnected || !hasFile || !hasText || isGenerating;
  }

  // textarea 변경 시 clone 버튼도 업데이트
  textarea.addEventListener('input', updateCloneBtn);

  cloneUploadArea.addEventListener('click', (e) => {
    if (e.target === cloneFileRemove || e.target.closest('.tts-clone-file-remove')) return;
    cloneFileInput.click();
  });

  cloneFileInput.addEventListener('change', () => {
    const file = cloneFileInput.files[0];
    if (!file) return;
    cloneFile = file;
    cloneFileName.textContent = file.name;
    cloneUploadPlaceholder.style.display = 'none';
    cloneFileInfo.style.display = 'flex';
    updateCloneBtn();
  });

  cloneFileRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    cloneFile = null;
    cloneFileInput.value = '';
    cloneUploadPlaceholder.style.display = '';
    cloneFileInfo.style.display = 'none';
    updateCloneBtn();
  });

  // 드래그 앤 드롭
  let cloneDragCounter = 0;
  cloneUploadArea.addEventListener('dragenter', (e) => {
    e.preventDefault(); cloneDragCounter++;
    cloneUploadArea.classList.add('tts-clone-drag-active');
  });
  cloneUploadArea.addEventListener('dragleave', (e) => {
    e.preventDefault(); cloneDragCounter--;
    if (cloneDragCounter <= 0) { cloneDragCounter = 0; cloneUploadArea.classList.remove('tts-clone-drag-active'); }
  });
  cloneUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); });
  cloneUploadArea.addEventListener('drop', (e) => {
    e.preventDefault(); cloneDragCounter = 0;
    cloneUploadArea.classList.remove('tts-clone-drag-active');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['wav','mp3','ogg','flac','m4a','webm'].includes(ext)) {
      showToast('지원하지 않는 오디오 형식입니다.', 'warning');
      return;
    }
    cloneFile = file;
    cloneFileName.textContent = file.name;
    cloneUploadPlaceholder.style.display = 'none';
    cloneFileInfo.style.display = 'flex';
    updateCloneBtn();
  });

  // Whisper 자동 전사
  whisperBtn.addEventListener('click', async () => {
    if (!cloneFile) {
      showToast('참조 음성 파일을 먼저 업로드해 주세요', 'error');
      return;
    }
    if (!isConnected) {
      showToast('TTS 서버에 먼저 연결해 주세요', 'error');
      return;
    }

    // 진행 모달 표시
    const overlay = document.createElement('div');
    overlay.className = 'tts-modal-overlay';
    overlay.innerHTML = `
      <div class="tts-modal">
        <div class="tts-modal-spinner"></div>
        <div class="tts-modal-title">자동 전사 진행 중</div>
        <div class="tts-modal-desc">
          자동으로 목소리를 텍스트로 추출 중입니다...
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    try {
      const fd = new FormData();
      fd.append('audio', cloneFile);
      fd.append('serverUrl', getSavedServer());
      const res = await api.ttsTranscribe(fd);

      // 진행 모달 → 완료 모달로 전환
      if (res.success && res.text) {
        cloneRefText.value = res.text;
        overlay.querySelector('.tts-modal').innerHTML = `
          <div class="tts-modal-check">✅</div>
          <div class="tts-modal-title">전사 완료</div>
          <div class="tts-modal-desc">
            AI로 추출된 텍스트에 오타가 있을 수 있으니
            <br>검토 및 수정이 필요할 수 있습니다.
          </div>
          <button class="tts-modal-confirm-btn">확인</button>
        `;
        overlay.querySelector('.tts-modal-confirm-btn')
          .addEventListener('click', () => overlay.remove());
      } else {
        overlay.remove();
        showToast(res.error || '전사에 실패했습니다', 'error');
      }
    } catch (err) {
      overlay.remove();
      showToast('전사 중 오류가 발생했습니다: ' + err.message, 'error');
    }
  });

  // Voice Clone 생성
  generateCloneBtn.addEventListener('click', async () => {
    if (isGenerating || !isConnected || !cloneFile) return;
    const targetText = textarea.value.trim();
    if (!targetText) { showToast('대본 텍스트를 입력해주세요.', 'warning'); return; }

    isGenerating = true;
    generateCloneBtn.disabled = true;
    generateCloneBtn.innerHTML = `<svg class="tts-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/></svg> 생성 중...`;
    resultArea.style.display = 'none';
    cloneProgressArea.style.display = 'block';
    cloneProgressBar.style.width = '0%';
    cloneProgressStep.textContent = 'Qwen3-TTS에 요청 중...';
    cloneProgressPercent.textContent = '';

    let fakeProgress = 0;
    const progressTimer = setInterval(() => {
      if (fakeProgress < 90) {
        fakeProgress += Math.random() * 5;
        if (fakeProgress > 90) fakeProgress = 90;
        cloneProgressBar.style.width = fakeProgress + '%';
        cloneProgressPercent.textContent = Math.round(fakeProgress) + '%';
        if (fakeProgress > 20) cloneProgressStep.textContent = '음성 클론 생성 중...';
        if (fakeProgress > 60) cloneProgressStep.textContent = '오디오 처리 중...';
        if (fakeProgress > 80) cloneProgressStep.textContent = '오디오 저장 중...';
      }
    }, 800);

    try {
      const fd = new FormData();
      fd.append('refAudio', cloneFile);
      fd.append('refText', cloneRefText.value.trim());
      fd.append('targetText', targetText);
      fd.append('language', cloneLanguage.value);
      fd.append('useXvectorOnly', String(cloneXvector.checked));
      fd.append('modelSize', cloneModelSize.value);
      fd.append('maxChunkChars', cloneChunkChars.value);
      fd.append('chunkGap', cloneChunkGap.value);
      fd.append('seed', cloneSeed.value);
      fd.append('serverUrl', getSavedServer());

      const result = await api.ttsGenerateClone(fd);

      clearInterval(progressTimer);

      if (result.success) {
        cloneProgressBar.style.width = '100%';
        cloneProgressPercent.textContent = '100%';
        cloneProgressStep.textContent = '완료!';

        setTimeout(async () => {
          cloneProgressArea.style.display = 'none';
          await showResult(result);
          showToast('음성 클론이 생성되었습니다.', 'success');
        }, 600);
      } else {
        cloneProgressArea.style.display = 'none';
        showToast(result.message || '음성 클론 생성에 실패했습니다.', 'error');
      }
    } catch (err) {
      clearInterval(progressTimer);
      cloneProgressArea.style.display = 'none';
      showToast('음성 클론 생성 중 오류: ' + err.message, 'error');
    }

    isGenerating = false;
    generateCloneBtn.disabled = false;
    generateCloneBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> 음성 클론 생성`;
    updateCloneBtn();
  });

  // === Voice Design ===
  function updateDesignBtn() {
    const hasText = textarea.value.trim().length > 0;
    const hasDesc = designDescription.value.trim().length > 0;
    generateDesignBtn.disabled = !isConnected || !hasText || !hasDesc || isGenerating;
  }

  textarea.addEventListener('input', updateDesignBtn);
  designDescription.addEventListener('input', updateDesignBtn);

  generateDesignBtn.addEventListener('click', async () => {
    if (isGenerating || !isConnected) return;
    const text = textarea.value.trim();
    const desc = designDescription.value.trim();
    if (!text) { showToast('대본 텍스트를 입력해주세요.', 'warning'); return; }
    if (!desc) { showToast('음성 설명을 입력해주세요.', 'warning'); return; }

    isGenerating = true;
    generateDesignBtn.disabled = true;
    resultArea.style.display = 'none';

    const charCount = text.replace(/\s/g, '').length;

    if (charCount <= CHUNK_THRESHOLD) {
      // === 짧은 텍스트 ===
      generateDesignBtn.innerHTML = `<svg class="tts-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/></svg> 생성 중...`;
      designProgressArea.style.display = 'block';
      designProgressBar.style.width = '0%';
      designProgressPercent.textContent = '';
      designProgressStep.textContent = 'Qwen3-TTS에 요청 중...';

      let fakeProgress = 0;
      const progressTimer = setInterval(() => {
        if (fakeProgress < 90) {
          fakeProgress += Math.random() * 8;
          if (fakeProgress > 90) fakeProgress = 90;
          designProgressBar.style.width = fakeProgress + '%';
          designProgressPercent.textContent = Math.round(fakeProgress) + '%';
          if (fakeProgress > 30) designProgressStep.textContent = '음성 디자인 생성 중...';
          if (fakeProgress > 70) designProgressStep.textContent = '오디오 저장 중...';
        }
      }, 500);

      try {
        const result = await api.ttsGenerateDesign({
          text,
          language: designLanguage.value,
          voiceDescription: desc,
          seed: parseInt(designSeed.value, 10) || -1,
          serverUrl: getSavedServer()
        });

        clearInterval(progressTimer);

        if (result.success) {
          designProgressBar.style.width = '100%';
          designProgressPercent.textContent = '100%';
          designProgressStep.textContent = '완료!';
          setTimeout(async () => {
            designProgressArea.style.display = 'none';
            await showResult(result);
            showToast('음성 디자인이 생성되었습니다.', 'success');
          }, 600);
        } else {
          designProgressArea.style.display = 'none';
          showToast(result.message || '음성 디자인 생성에 실패했습니다.', 'error');
        }
      } catch (err) {
        clearInterval(progressTimer);
        designProgressArea.style.display = 'none';
        showToast('생성 중 오류: ' + err.message, 'error');
      }

    } else {
      // === 긴 텍스트: Floating Panel + SSE ===
      generateDesignBtn.innerHTML = `<svg class="tts-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/></svg> 분할 생성 중...`;

      const panel = createFloatingPanel();
      document.body.appendChild(panel);
      const pBar = panel.querySelector('.tts-fp-bar');
      const pStep = panel.querySelector('.tts-fp-step');
      const pPercent = panel.querySelector('.tts-fp-percent');
      const pTitle = panel.querySelector('.tts-fp-title');
      const pMinimize = panel.querySelector('.tts-fp-minimize');
      const pBody = panel.querySelector('.tts-fp-body');

      let minimized = false;
      pMinimize.addEventListener('click', () => {
        minimized = !minimized;
        pBody.style.display = minimized ? 'none' : '';
        pMinimize.textContent = minimized ? '+' : '−';
      });

      try {
        const response = await fetch('/api/tts/generate-long', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            language: designLanguage.value,
            mode: 'design',
            voiceDescription: desc,
            seed: parseInt(designSeed.value, 10) || -1,
            silenceDuration: parseFloat(silenceSlider.value) || 0.5,
            serverUrl: getSavedServer()
          })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.substring(6));
                if (event.type === 'start') {
                  pStep.textContent = event.message;
                  pTitle.textContent = `TTS 디자인 생성 (${event.totalChunks}파트)`;
                } else if (event.type === 'progress') {
                  pBar.style.width = event.percent + '%';
                  pPercent.textContent = event.percent + '%';
                  pStep.textContent = event.message;
                } else if (event.type === 'complete') {
                  pBar.style.width = '100%';
                  pPercent.textContent = '100%';
                  pStep.textContent = event.message;
                  pTitle.textContent = 'TTS 디자인 생성 완료';
                  setTimeout(async () => {
                    panel.remove();
                    await showResult(event);
                    showToast(`음성 디자인이 생성되었습니다. (${event.totalChunks}개 파트 병합)`, 'success');
                  }, 1500);
                } else if (event.type === 'error') {
                  pStep.textContent = event.message;
                  pBar.style.background = 'var(--danger)';
                  setTimeout(() => { panel.remove(); }, 3000);
                  showToast(event.message || '생성 중 오류가 발생했습니다.', 'error');
                }
              } catch (pe) {}
            }
          }
        }
      } catch (err) {
        panel.remove();
        showToast('생성 중 오류: ' + err.message, 'error');
      }
    }

    isGenerating = false;
    generateDesignBtn.disabled = false;
    generateDesignBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> 음성 디자인 생성`;
    updateDesignBtn();
  });

  // === 다중 화자 ===
  multiSpeakerToggle.addEventListener('change', () => {
    multiSpeakerEnabled = multiSpeakerToggle.checked;
    msPanel.style.display = multiSpeakerEnabled ? '' : 'none';
    if (!multiSpeakerEnabled) {
      analyzedSegments = [];
      speakerMap = {};
      msResult.style.display = 'none';
      msMappingList.innerHTML = '';
    }
    updateMsAnalyzeBtn();
  });

  function updateMsAnalyzeBtn() {
    const hasText = textarea.value.trim().length > 0;
    msAnalyzeBtn.disabled = !hasText || !multiSpeakerEnabled;
  }

  textarea.addEventListener('input', updateMsAnalyzeBtn);

  msAnalyzeBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) { showToast('대본을 먼저 입력해주세요.', 'warning'); return; }

    msAnalyzeBtn.disabled = true;
    const origHtml = msAnalyzeBtn.innerHTML;
    msAnalyzeBtn.innerHTML = `<svg class="tts-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/></svg> 분석 중...`;

    try {
      const apiType = container.querySelector('input[name="tts-ms-api"]:checked')?.value || 'ai_studio';
      const result = await api.ttsAnalyzeSpeakers({ text, apiType });

      if (result.success) {
        analyzedSegments = result.segments;
        const speakers = result.speakers.filter(s => s !== '나레이터');

        msResultCount.textContent = `${result.speakers.length}명 화자, ${result.totalSegments}개 세그먼트`;

        // 기본 매핑: 나레이터 → 현재 선택된 화자, 나머지 → Sohee
        speakerMap = {};
        speakerMap['나레이터'] = speakerSelect.value;
        speakers.forEach(s => { speakerMap[s] = 'Sohee'; });

        renderMappingList(result.speakers, result.segments);
        msResult.style.display = '';
        showToast(`화자 분석 완료: ${result.speakers.length}명 감지`, 'success');
      } else {
        showToast(result.message || '화자 분석에 실패했습니다.', 'error');
      }
    } catch (err) {
      showToast('화자 분석 중 오류: ' + err.message, 'error');
    }

    msAnalyzeBtn.disabled = false;
    msAnalyzeBtn.innerHTML = origHtml;
    updateMsAnalyzeBtn();
  });

  function renderMappingList(speakers, segments) {
    segments.forEach(seg => {
      if (!seg.instruct) seg.instruct = '';
    });
    window.__analyzedSegments = segments;
    msSpeakerData = [];
    msActiveIndex = 0;

    const narratorSegs = segments.filter(s => s.speaker === '나레이터');
    const currentSpeaker = speakerSelect ? speakerSelect.value : 'Sohee';
    msSpeakerData.push({
      name: '나레이션',
      segCount: narratorSegs.length,
      type: 'narration',
      voice: currentSpeaker,
      useNarrator: false,
      locked: true,
      defaultInstruct: '',
      sample: narratorSegs.length > 0 ? narratorSegs[0].text.substring(0, 60) : ''
    });

    speakers.filter(s => s !== '나레이터').forEach(spName => {
      const spSegs = segments.filter(s => s.speaker === spName);
      const segCount = spSegs.length;
      msSpeakerData.push({
        name: spName,
        segCount: segCount,
        type: 'dialogue',
        voice: segCount <= 1 ? '__narrator__' : 'Sohee',
        useNarrator: segCount <= 1,
        locked: false,
        defaultInstruct: '',
        sample: spSegs.length > 0 ? spSegs[0].text.substring(0, 60) : ''
      });
    });

    speakerMap = {};
    msSpeakerData.forEach(sp => {
      if (sp.locked) {
        speakerMap[sp.name] = sp.voice;
      } else if (sp.useNarrator) {
        speakerMap[sp.name] = msSpeakerData[0].voice;
      } else {
        speakerMap[sp.name] = sp.voice;
      }
    });

    openMsModal();
  }

  function openMsModal() {
    if (!msModalOverlay) return;
    msActiveIndex = 0;
    msModalOverlay.style.display = 'flex';
    renderMsSpeakerList();
    renderMsMappingPanel();
  }

  function closeMsModal() {
    if (!msModalOverlay) return;
    msModalOverlay.style.display = 'none';
    if (msCurrentAudio) { msCurrentAudio.pause(); msCurrentAudio = null; }
  }

  function showMsDeleteConfirm(speakerName, index) {
    const existing = msModalOverlay.querySelector('.tts-ms-delete-confirm');
    if (existing) existing.remove();

    const confirm = document.createElement('div');
    confirm.className = 'tts-ms-delete-confirm';
    confirm.innerHTML =
      '<div class="tts-ms-delete-confirm-box">' +
        '<div class="tts-ms-delete-confirm-title">' + speakerName + ' 삭제</div>' +
        '<p class="tts-ms-delete-confirm-msg">"' + speakerName + '" 역할을 삭제하고 나레이션 음성으로 연출하시겠습니까?</p>' +
        '<div class="tts-ms-delete-confirm-actions">' +
          '<button class="tts-ms-delete-cancel">취소</button>' +
          '<button class="tts-ms-delete-ok">확인</button>' +
        '</div>' +
      '</div>';

    confirm.querySelector('.tts-ms-delete-cancel').addEventListener('click', () => {
      confirm.remove();
    });

    confirm.querySelector('.tts-ms-delete-ok').addEventListener('click', () => {
      const targetSpeaker = msSpeakerData[index].name;
      msSpeakerData[0].segCount += msSpeakerData[index].segCount;
      speakerMap[targetSpeaker] = msSpeakerData[0].voice;
      msSpeakerData.splice(index, 1);
      if (msActiveIndex >= msSpeakerData.length) {
        msActiveIndex = 0;
      }
      confirm.remove();
      renderMsSpeakerList();
      renderMsMappingPanel();
      showToast('"' + targetSpeaker + '" 역할이 나레이션으로 병합되었습니다', 'success');
    });

    msModalOverlay.querySelector('.tts-ms-modal').appendChild(confirm);
  }

  function showSpeakerLines(speakerName) {
    const existing = msModalOverlay.querySelector('.tts-ms-lines-modal');
    if (existing) existing.remove();

    const segments = window.__analyzedSegments || [];
    const lines = segments.filter(seg => seg.speaker === speakerName);
    const spData = msSpeakerData.find(s => s.name === speakerName);

    const emotions = [
      {ko:'화남', en:'angry tone'},
      {ko:'슬픔', en:'sad and sorrowful tone'},
      {ko:'기쁨', en:'happy and cheerful tone'},
      {ko:'긴박', en:'urgent and tense tone'},
      {ko:'속삭임', en:'soft whisper'},
      {ko:'냉정', en:'cold and calm tone'},
      {ko:'다정', en:'warm and kind tone'},
      {ko:'공포', en:'fearful and trembling tone'},
      {ko:'흥분', en:'excited and energetic tone'},
      {ko:'비꼼', en:'sarcastic tone'},
    ];

    const linesModal = document.createElement('div');
    linesModal.className = 'tts-ms-lines-modal';

    let linesHTML = '';
    if (lines.length === 0) {
      linesHTML = '<div class="tts-ms-lines-empty">대사가 없습니다</div>';
    } else {
      lines.forEach((line, i) => {
        const segIndex = segments.indexOf(line);
        linesHTML +=
          '<div class="tts-ms-line-item" data-seg-index="' + segIndex + '">' +
            '<div class="tts-ms-line-text-row">' +
              '<span class="tts-ms-line-num">대사 ' + (i + 1) + '.</span>' +
              '<span class="tts-ms-line-text">' + line.text + '</span>' +
            '</div>' +
            '<div class="tts-ms-line-style-row">' +
              '<span class="tts-ms-line-style-label">스타일</span>' +
              '<input type="text" class="tts-ms-line-style-input" data-seg-index="' + segIndex + '" value="' + (line.instruct || '') + '" placeholder="직접 입력 또는 아래 감정 선택" />' +
              '<button class="tts-ms-line-gen-btn" data-seg-index="' + segIndex + '">생성</button>' +
              '<button class="tts-ms-line-play-btn" data-seg-index="' + segIndex + '" disabled>▶</button>' +
            '</div>' +
            '<div class="tts-ms-line-emotions">' +
              emotions.map(e => '<button class="tts-ms-line-emotion" data-en="' + e.en + '">' + e.ko + '</button>').join('') +
            '</div>' +
          '</div>';
      });
    }

    linesModal.innerHTML =
      '<div class="tts-ms-lines-box">' +
        '<div class="tts-ms-lines-header">' +
          '<div class="tts-ms-lines-header-top">' +
            '<div class="tts-ms-lines-title-wrap">' +
              '<span class="tts-ms-lines-title">' + speakerName + '의 대사 목록</span>' +
              '<span class="tts-ms-lines-count">' + lines.length + '개 대사</span>' +
            '</div>' +
            '<button class="tts-ms-lines-close">✕</button>' +
          '</div>' +
          '<div class="tts-ms-lines-default-style">' +
            '<span class="tts-ms-lines-default-label">화자 기본 스타일:</span>' +
            '<input type="text" class="tts-ms-lines-default-input" value="' + (spData ? spData.defaultInstruct || '' : '') + '" placeholder="예: calm and gentle voice" />' +
            '<span class="tts-ms-lines-default-hint">개별 스타일 미입력 시 적용</span>' +
          '</div>' +
        '</div>' +
        '<div class="tts-ms-lines-list">' + linesHTML + '</div>' +
        '<div class="tts-ms-lines-footer">' +
          '<span class="tts-ms-lines-footer-hint">스타일 미입력 대사는 화자 기본 스타일 또는 스타일 없이 생성됩니다.</span>' +
          '<div class="tts-ms-lines-footer-actions">' +
            '<button class="tts-ms-lines-cancel">닫기</button>' +
            '<button class="tts-ms-lines-apply">스타일 적용 ✓</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    // 기본 스타일 값에 따라 개별 대사 입력 차단/해제
    const defaultInput = linesModal.querySelector('.tts-ms-lines-default-input');
    const LOCK_WARNING = '화자 기본 스타일이 설정되어 있습니다. 개별 스타일을 입력하려면 기본 스타일을 비워주세요.';

    function applyLockState(locked) {
      linesModal.querySelectorAll('.tts-ms-line-item').forEach(item => {
        const styleInput = item.querySelector('.tts-ms-line-style-input');
        const genBtn = item.querySelector('.tts-ms-line-gen-btn');
        const emotionBtns = item.querySelectorAll('.tts-ms-line-emotion');
        let warning = item.querySelector('.tts-ms-line-lock-warning');

        if (locked) {
          styleInput.readOnly = true;
          genBtn.disabled = true;
          emotionBtns.forEach(b => { b.disabled = true; });
          if (!warning) {
            warning = document.createElement('div');
            warning.className = 'tts-ms-line-lock-warning';
            warning.style.cssText = 'font-size:15px;color:#f59e0b;margin-top:6px;';
            warning.textContent = LOCK_WARNING;
            item.querySelector('.tts-ms-line-style-row').after(warning);
          }
        } else {
          styleInput.readOnly = false;
          genBtn.disabled = false;
          emotionBtns.forEach(b => { b.disabled = false; });
          if (warning) warning.remove();
        }
      });
    }

    // 초기 상태 적용
    applyLockState(!!(defaultInput && defaultInput.value.trim()));

    // 기본 스타일 입력 변경 시 실시간 반영
    if (defaultInput) {
      defaultInput.addEventListener('input', () => {
        applyLockState(!!defaultInput.value.trim());
      });
    }

    // 감정 프리셋 클릭 이벤트 (차단 상태가 아닐 때만 동작)
    linesModal.querySelectorAll('.tts-ms-line-item').forEach(item => {
      const input = item.querySelector('.tts-ms-line-style-input');
      item.querySelectorAll('.tts-ms-line-emotion').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          input.value = btn.dataset.en;
          input.style.borderColor = 'rgba(124,92,255,0.4)';
          setTimeout(() => { input.style.borderColor = ''; }, 500);
          item.querySelectorAll('.tts-ms-line-emotion').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
    });

    // 생성 버튼 이벤트 (대사 1개 미리듣기 생성)
    linesModal.querySelectorAll('.tts-ms-line-gen-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const segIndex = parseInt(btn.dataset.segIndex);
        const seg = segments[segIndex];
        const item = btn.closest('.tts-ms-line-item');
        const styleInput = item.querySelector('.tts-ms-line-style-input');
        const playBtn = item.querySelector('.tts-ms-line-play-btn');
        const instruct = styleInput.value.trim() || (spData ? spData.defaultInstruct : '') || '';
        const targetSpeaker = speakerMap[seg.speaker] || (speakerSelect ? speakerSelect.value : 'Sohee');

        btn.textContent = '생성 중...';
        btn.disabled = true;
        btn.style.background = '#555';

        try {
          const response = await fetch('/api/tts/generate-short', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: seg.text,
              language: languageSelect ? languageSelect.value : 'Korean',
              mode: 'custom',
              speaker: targetSpeaker,
              instruct: instruct,
              modelSize: '1.7B',
              seed: parseInt(seedInput.value, 10) || -1,
              serverUrl: getSavedServer()
            })
          });
          const result = await response.json();
          if (result.success && result.filename) {
            playBtn.disabled = false;
            playBtn.classList.add('ready');
            playBtn.dataset.audioFile = result.filename;
            btn.textContent = '✓ 완료';
            btn.style.background = '#22c55e';
            setTimeout(() => {
              btn.textContent = '생성';
              btn.style.background = '';
              btn.disabled = false;
            }, 1500);
          } else {
            throw new Error(result.error || result.message || '생성 실패');
          }
        } catch (err) {
          console.error('대사 미리듣기 생성 실패:', err);
          showToast('대사 생성에 실패했습니다: ' + err.message, 'error');
          btn.textContent = '생성';
          btn.style.background = '';
          btn.disabled = false;
        }
      });
    });

    // 재생 버튼 이벤트
    let lineAudio = null;
    linesModal.querySelectorAll('.tts-ms-line-play-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (lineAudio) { lineAudio.pause(); lineAudio = null; }
        const audioFile = btn.dataset.audioFile;
        if (!audioFile) return;
        lineAudio = new Audio('/tts-audio/' + audioFile);
        lineAudio.play().catch(err => {
          console.error('재생 실패:', err);
          showToast('음성을 재생할 수 없습니다', 'error');
        });
      });
    });

    // 스타일 적용 버튼
    linesModal.querySelector('.tts-ms-lines-apply').addEventListener('click', () => {
      if (spData && defaultInput) {
        spData.defaultInstruct = defaultInput.value.trim();
      }
      linesModal.querySelectorAll('.tts-ms-line-style-input').forEach(input => {
        const segIndex = parseInt(input.dataset.segIndex);
        if (segments[segIndex]) {
          segments[segIndex].instruct = input.value.trim();
        }
      });
      showToast('스타일이 적용되었습니다', 'success');
      linesModal.remove();
    });

    // 닫기
    const closeModal = () => {
      if (lineAudio) { lineAudio.pause(); lineAudio = null; }
      linesModal.remove();
    };
    linesModal.querySelector('.tts-ms-lines-close').addEventListener('click', closeModal);
    linesModal.querySelector('.tts-ms-lines-cancel').addEventListener('click', closeModal);
    linesModal.addEventListener('click', (e) => {
      if (e.target === linesModal) closeModal();
    });

    msModalOverlay.querySelector('.tts-ms-modal').appendChild(linesModal);
  }

  function renderMsSpeakerList() {
    if (!msModalSpeakerList) return;
    msModalSpeakerList.innerHTML = '';

    const summaryEl = msModalOverlay.querySelector('.tts-ms-summary');
    if (summaryEl) {
      summaryEl.textContent = msSpeakerData.length + '명 화자 · ' +
        msSpeakerData.reduce((sum, s) => sum + s.segCount, 0) + '개 대사';
    }

    msSpeakerData.forEach((sp, i) => {
      const isActive = i === msActiveIndex;
      const item = document.createElement('div');
      item.className = 'tts-ms-speaker-item' + (isActive ? ' active' : '');

      const voiceDisplay = sp.locked ? sp.voice : (sp.useNarrator ? '나레이션 목소리' : sp.voice);
      const voiceClass = sp.useNarrator && !sp.locked ? 'muted' : '';

      item.innerHTML =
        '<div class="tts-ms-speaker-row">' +
          '<div class="tts-ms-speaker-info">' +
            '<span class="tts-ms-speaker-name">' + sp.name + '</span>' +
          '</div>' +
          '<div class="tts-ms-speaker-meta">' +
            '<span class="tts-ms-speaker-voice ' + voiceClass + '">' + voiceDisplay + '</span>' +
            '<span class="tts-ms-speaker-count">' + sp.segCount + '개</span>' +
            (sp.locked ? '' : '<button class="tts-ms-speaker-delete" data-index="' + i + '" title="삭제">✕</button>') +
          '</div>' +
        '</div>' +
        '<p class="tts-ms-speaker-sample">' + sp.sample + '</p>';

      item.addEventListener('click', () => {
        msActiveIndex = i;
        renderMsSpeakerList();
        renderMsMappingPanel();
      });

      const deleteBtn = item.querySelector('.tts-ms-speaker-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(deleteBtn.dataset.index);
          const targetName = msSpeakerData[idx].name;
          showMsDeleteConfirm(targetName, idx);
        });
      }

      msModalSpeakerList.appendChild(item);
    });
  }

  function renderMsMappingPanel() {
    if (!msMappingPanel) return;
    const sp = msSpeakerData[msActiveIndex];
    msMappingPanel.innerHTML = '';

    // 상단 정보
    const topInfo = document.createElement('div');
    topInfo.className = 'tts-ms-panel-top';

    let toggleHTML = '';
    if (!sp.locked) {
      toggleHTML =
        '<div class="tts-ms-narrator-toggle-wrap">' +
          '<label class="tts-ms-toggle-label">' +
            '<input type="checkbox" class="tts-ms-narrator-toggle" ' + (sp.useNarrator ? 'checked' : '') + '>' +
            '<span class="tts-ms-toggle-track"></span>' +
            '<span class="tts-ms-toggle-thumb"></span>' +
          '</label>' +
          '<span class="tts-ms-toggle-text">나레이션 목소리 사용</span>' +
          '<span class="tts-ms-toggle-hint">별도 목소리 배정이 필요 없는 단역에 추천</span>' +
        '</div>';
    }

    topInfo.innerHTML =
      '<div class="tts-ms-panel-title-row">' +
        '<span class="tts-ms-panel-name">' + sp.name + '</span>' +
        '<span class="tts-ms-panel-seg-count">' + sp.segCount + '개 대사</span>' +
        '<button class="tts-ms-view-lines-btn">대사 보기</button>' +
      '</div>' +
      '<p class="tts-ms-panel-sample">"' + sp.sample.replace(/["""]/g, '') + '"</p>' +
      toggleHTML;

    msMappingPanel.appendChild(topInfo);

    const viewLinesBtn = topInfo.querySelector('.tts-ms-view-lines-btn');
    if (viewLinesBtn) {
      viewLinesBtn.addEventListener('click', () => {
        showSpeakerLines(sp.name);
      });
    }

    const toggle = topInfo.querySelector('.tts-ms-narrator-toggle');
    if (toggle) {
      toggle.addEventListener('change', () => {
        sp.useNarrator = toggle.checked;
        if (toggle.checked) {
          sp.voice = '__narrator__';
          speakerMap[sp.name] = msSpeakerData[0].voice;
        } else {
          sp.voice = 'Sohee';
          speakerMap[sp.name] = 'Sohee';
        }
        renderMsSpeakerList();
        renderMsMappingPanel();
      });
    }

    if (sp.useNarrator && !sp.locked) {
      const narInfo = document.createElement('div');
      narInfo.className = 'tts-ms-narrator-info';
      narInfo.innerHTML =
        '<div class="tts-ms-narrator-icon">🎙️</div>' +
        '<div class="tts-ms-narrator-label">나레이션 목소리를 사용합니다</div>' +
        '<div class="tts-ms-narrator-current">현재 나레이션: <strong>' + msSpeakerData[0].voice + '</strong></div>' +
        '<div class="tts-ms-narrator-note">나레이션의 목소리를 변경하면 이 화자도 함께 변경됩니다</div>';
      msMappingPanel.appendChild(narInfo);
      return;
    }

    // 프리셋/시드 탭
    const tabWrap = document.createElement('div');
    tabWrap.className = 'tts-ms-voice-tabs';
    tabWrap.innerHTML =
      '<button class="tts-ms-voice-tab active" data-tab="preset">프리셋 화자</button>' +
      '<button class="tts-ms-voice-tab" data-tab="seed">시드 목소리</button>';
    msMappingPanel.appendChild(tabWrap);

    tabWrap.querySelectorAll('.tts-ms-voice-tab').forEach(btn => {
      btn.addEventListener('click', function() {
        tabWrap.querySelectorAll('.tts-ms-voice-tab').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const tab = this.dataset.tab;
        const presetArea = msMappingPanel.querySelector('.tts-ms-preset-area');
        const seedArea = msMappingPanel.querySelector('.tts-ms-seed-area');
        if (presetArea) presetArea.style.display = tab === 'preset' ? 'block' : 'none';
        if (seedArea) seedArea.style.display = tab === 'seed' ? 'block' : 'none';
      });
    });

    // 프리셋 영역
    const presetArea = document.createElement('div');
    presetArea.className = 'tts-ms-preset-area';

    function createSpeakerGrid(speakers, gender) {
      const section = document.createElement('div');
      section.className = 'tts-ms-gender-section';
      section.innerHTML = '<div class="tts-ms-gender-label ' + gender + '">' +
        (gender === 'female' ? '👩 여성' : '👨 남성') + '</div>';

      const grid = document.createElement('div');
      grid.className = 'tts-ms-voice-grid';

      speakers.forEach(spk => {
        const spkId = spk.id || spk.name;
        const selected = sp.voice === spkId || sp.voice === spk.name;
        const card = document.createElement('div');
        card.className = 'tts-ms-voice-card' + (selected ? ' selected' : '');
        card.innerHTML =
          '<div class="tts-ms-voice-card-info">' +
            '<div class="tts-ms-voice-card-name">' + (spk.name || spkId) + '</div>' +
            '<div class="tts-ms-voice-card-lang">' + (spk.langLabel || spk.lang || '한국어') + '</div>' +
          '</div>' +
          '<button class="tts-ms-preview-btn" title="미리듣기">🔊</button>';

        card.addEventListener('click', (e) => {
          if (e.target.closest('.tts-ms-preview-btn')) return;
          sp.voice = spkId;
          sp.useNarrator = false;
          speakerMap[sp.name] = spkId;
          if (sp.locked) {
            msSpeakerData.forEach(s => { if (s.useNarrator) speakerMap[s.name] = spkId; });
          }
          renderMsSpeakerList();
          renderMsMappingPanel();
        });

        card.querySelector('.tts-ms-preview-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          if (msCurrentAudio) { msCurrentAudio.pause(); msCurrentAudio = null; }
          msCurrentAudio = new Audio('/speaker-samples/' + spkId + '.wav');
          msCurrentAudio.play().catch(() => showToast('샘플 음성을 재생할 수 없습니다', 'error'));
        });

        grid.appendChild(card);
      });

      section.appendChild(grid);
      return section;
    }

    presetArea.appendChild(createSpeakerGrid(SPEAKERS_FEMALE, 'female'));
    presetArea.appendChild(createSpeakerGrid(SPEAKERS_MALE, 'male'));
    msMappingPanel.appendChild(presetArea);

    // 시드 목소리 영역
    const seedArea = document.createElement('div');
    seedArea.className = 'tts-ms-seed-area';
    seedArea.style.display = 'none';
    seedArea.innerHTML = '<div class="tts-ms-seed-loading">시드 목소리 불러오는 중...</div>';
    msMappingPanel.appendChild(seedArea);

    api.ttsGetSeeds().then(res => {
      if (!res.success || !res.seeds || res.seeds.length === 0) {
        seedArea.innerHTML =
          '<div class="tts-ms-seed-empty">' +
            '<div style="font-size:36px;margin-bottom:12px;">🌱</div>' +
            '<div style="font-size:17px;font-weight:600;color:#8888a8;">저장된 시드 목소리가 없습니다</div>' +
            '<div style="font-size:15px;color:#6b6b88;margin-top:6px;">음성 생성 후 시드를 저장하면 여기에 표시됩니다</div>' +
          '</div>';
        return;
      }
      seedArea.innerHTML = '';
      const seedGrid = document.createElement('div');
      seedGrid.className = 'tts-ms-voice-grid';

      res.seeds.forEach(seed => {
        const seedId = 'seed_' + seed.id;
        const selected = sp.voice === seed.name;
        const card = document.createElement('div');
        card.className = 'tts-ms-voice-card seed' + (selected ? ' selected' : '');
        card.innerHTML =
          '<div class="tts-ms-voice-card-info">' +
            '<div class="tts-ms-voice-card-name">' + seed.name + '</div>' +
            '<div class="tts-ms-voice-card-lang">' +
              '<span class="tts-ms-seed-badge">시드 ' + seed.seed + '</span>' +
              (seed.speaker ? ' · ' + seed.speaker : '') +
            '</div>' +
          '</div>' +
          '<button class="tts-ms-preview-btn" title="미리듣기">🔊</button>';

        card.addEventListener('click', (e) => {
          if (e.target.closest('.tts-ms-preview-btn')) return;
          sp.voice = seed.name;
          sp.seedValue = seed.seed;
          sp.seedSpeaker = seed.speaker || 'Sohee';
          sp.useNarrator = false;
          speakerMap[sp.name] = sp.seedSpeaker;
          if (!window.__msSeedMap) window.__msSeedMap = {};
          window.__msSeedMap[sp.name] = seed.seed;
          renderMsSpeakerList();
          renderMsMappingPanel();
        });

        card.querySelector('.tts-ms-preview-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          if (msCurrentAudio) { msCurrentAudio.pause(); msCurrentAudio = null; }
          if (!seed.audio_filename) { showToast('이 시드에는 샘플 음성이 없습니다', 'error'); return; }
          msCurrentAudio = new Audio('/tts-seeds-audio/' + seed.audio_filename);
          msCurrentAudio.play().catch(() => showToast('시드 음성을 재생할 수 없습니다', 'error'));
        });

        seedGrid.appendChild(card);
      });
      seedArea.appendChild(seedGrid);
    }).catch(() => {
      seedArea.innerHTML = '<div class="tts-ms-seed-empty">시드 목록을 불러올 수 없습니다</div>';
    });

    // 현재 선택 표시
    const currentInfo = document.createElement('div');
    currentInfo.className = 'tts-ms-current-selection';
    currentInfo.innerHTML =
      '<div class="tts-ms-current-label">현재 선택: <strong>' + sp.voice + '</strong></div>' +
      '<div class="tts-ms-current-hint">변경하려면 위에서 다른 화자를 클릭하세요</div>';
    msMappingPanel.appendChild(currentInfo);
  }

  msResetBtn.addEventListener('click', () => {
    analyzedSegments = [];
    speakerMap = {};
    msResult.style.display = 'none';
    msMappingList.innerHTML = '';
    showToast('화자 분석이 초기화되었습니다.', 'success');
  });

  // === 다중 화자 매핑 모달 이벤트 ===
  if (msModalOverlay) {
    msModalOverlay.querySelector('.tts-ms-close-btn').addEventListener('click', closeMsModal);
    msModalOverlay.querySelector('.tts-ms-cancel-btn').addEventListener('click', closeMsModal);
    msModalOverlay.addEventListener('click', (e) => {
      if (e.target === msModalOverlay) closeMsModal();
    });

    msModalOverlay.querySelector('.tts-ms-confirm-btn').addEventListener('click', () => {
      msSpeakerData.forEach(sp => {
        if (sp.useNarrator) speakerMap[sp.name] = msSpeakerData[0].voice;
      });
      // 화자 기본 스타일을 개별 스타일 미입력 세그먼트에 적용
      const segs = window.__analyzedSegments || [];
      msSpeakerData.forEach(sp => {
        if (sp.defaultInstruct) {
          segs.forEach(seg => {
            if (seg.speaker === sp.name && !seg.instruct) {
              seg.instruct = sp.defaultInstruct;
            }
          });
        }
      });
      showToast('화자 매핑이 적용되었습니다', 'success');
      closeMsModal();
      msResult.style.display = '';
    });

    msModalOverlay.querySelector('.tts-ms-reset-btn').addEventListener('click', () => {
      const currentSpeaker = speakerSelect ? speakerSelect.value : 'Sohee';
      msSpeakerData.forEach((sp, i) => {
        if (i === 0) {
          sp.voice = currentSpeaker;
        } else {
          sp.useNarrator = sp.segCount <= 1;
          sp.voice = sp.useNarrator ? '__narrator__' : 'Sohee';
        }
        speakerMap[sp.name] = sp.locked ? sp.voice : (sp.useNarrator ? currentSpeaker : sp.voice);
      });
      msActiveIndex = 0;
      renderMsSpeakerList();
      renderMsMappingPanel();
      showToast('매핑이 초기화되었습니다', 'info');
    });

    container.querySelector('.tts-ms-reopen-btn').addEventListener('click', () => {
      openMsModal();
    });
  }

  // === 시드 저장 ===
  saveSeedBtn.addEventListener('click', () => {
    if (!lastGeneratedSeed || lastGeneratedSeed <= 0) {
      showToast('저장할 시드가 없습니다. 먼저 음성을 생성해주세요.', 'warning');
      return;
    }
    seedValueDisplay.value = lastGeneratedSeed;
    seedNameInput.value = '';
    seedModalOverlay.style.display = 'flex';
    seedNameInput.focus();
  });

  seedModalClose.addEventListener('click', () => {
    seedModalOverlay.style.display = 'none';
  });
  seedModalOverlay.addEventListener('click', (e) => {
    if (e.target === seedModalOverlay) seedModalOverlay.style.display = 'none';
  });

  seedSaveConfirmBtn.addEventListener('click', async () => {
    const name = seedNameInput.value.trim();
    if (!name) { showToast('이름을 입력해주세요.', 'warning'); return; }

    seedSaveConfirmBtn.disabled = true;
    seedSaveConfirmBtn.textContent = '저장 중...';

    try {
      const activeTab = container.querySelector('.tts-tab.active')?.dataset.tab || 'custom';
      let voiceType = activeTab;
      let speaker = null;
      let voiceDesc = null;

      if (activeTab === 'custom') {
        speaker = speakerSelect.value;
      } else if (activeTab === 'design') {
        voiceDesc = designDescription.value.trim();
      }

      const res = await api.ttsSaveSeed({
        name,
        seed: lastGeneratedSeed,
        voiceType,
        speaker,
        voiceDescription: voiceDesc,
        audioFilename: currentFilename || null
      });

      if (res.success) {
        seedModalOverlay.style.display = 'none';
        showToast(`시드 "${name}"이(가) 저장되었습니다.`, 'success');
      } else {
        showToast(res.message || '시드 저장에 실패했습니다.', 'error');
      }
    } catch (err) {
      showToast('시드 저장 중 오류: ' + err.message, 'error');
    }

    seedSaveConfirmBtn.disabled = false;
    seedSaveConfirmBtn.textContent = '저장';
  });

  seedNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); seedSaveConfirmBtn.click(); }
  });

  // === 음성 리스트 모달 ===
  const voiceListOverlay = container.querySelector('.tts-voice-list-overlay');
  const voiceListContent = container.querySelector('.tts-voice-list-content');
  const voiceListPagination = container.querySelector('.tts-voice-list-pagination');
  const voiceListSearch = container.querySelector('.tts-voice-list-search');
  const voiceListClose = container.querySelector('.tts-voice-list-close');

  let vlMainFilter = 'all';
  let vlSubFilter = 'all';
  let vlSearchQuery = '';
  let vlPage = 1;
  let vlModalAudio = null;

  // 리스트 버튼 클릭 → 모달 열기
  container.querySelectorAll('.tts-voice-list-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const activeTab = container.querySelector('.tts-tab.active')?.dataset?.tab || 'custom';
      vlSubFilter = activeTab;
      vlMainFilter = 'all';
      vlSearchQuery = '';
      vlPage = 1;
      voiceListSearch.value = '';
      openVoiceListModal();
    });
  });

  // "시드 목소리 선택하기" 버튼 → 시드 필터로 모달 열기
  const seedSelectBtn = container.querySelector('.tts-speaker-seed-btn');
  if (seedSelectBtn) {
    const newSeedBtn = seedSelectBtn.cloneNode(true);
    seedSelectBtn.parentNode.replaceChild(newSeedBtn, seedSelectBtn);
    newSeedBtn.addEventListener('click', () => {
      vlMainFilter = 'seed';
      vlSubFilter = 'all';
      vlSearchQuery = '';
      vlPage = 1;
      voiceListSearch.value = '';
      openVoiceListModal();
    });
  }

  // "저장된 시드" 버튼 → 시드 필터로 모달 열기
  const savedSeedsBtn2 = container.querySelector('.tts-saved-seeds-btn');
  if (savedSeedsBtn2) {
    const newSavedBtn = savedSeedsBtn2.cloneNode(true);
    savedSeedsBtn2.parentNode.replaceChild(newSavedBtn, savedSeedsBtn2);
    newSavedBtn.addEventListener('click', () => {
      vlMainFilter = 'seed';
      vlSubFilter = 'all';
      vlSearchQuery = '';
      vlPage = 1;
      voiceListSearch.value = '';
      openVoiceListModal();
    });
  }

  // 모달 닫기
  voiceListClose.addEventListener('click', closeVoiceListModal);
  voiceListOverlay.addEventListener('click', (e) => {
    if (e.target === voiceListOverlay) closeVoiceListModal();
  });

  function showTtsConfirm(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;' +
        'background:rgba(0,0,0,0.5);display:flex;align-items:center;' +
        'justify-content:center;z-index:1000000;';

      const box = document.createElement('div');
      box.style.cssText =
        'background:#1e1e2e;border:1px solid #333;border-radius:12px;' +
        'padding:24px;min-width:320px;max-width:420px;text-align:center;';

      const msg = document.createElement('p');
      msg.textContent = message;
      msg.style.cssText =
        'color:#e0e0e0;font-size:15px;margin:0 0 20px 0;line-height:1.5;';

      const btnWrap = document.createElement('div');
      btnWrap.style.cssText = 'display:flex;gap:12px;justify-content:center;';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '취소';
      cancelBtn.style.cssText =
        'padding:8px 24px;border-radius:8px;border:1px solid #555;' +
        'background:transparent;color:#ccc;cursor:pointer;font-size:14px;';

      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = '삭제';
      confirmBtn.style.cssText =
        'padding:8px 24px;border-radius:8px;border:none;' +
        'background:#e74c3c;color:#fff;cursor:pointer;font-size:14px;';

      cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });
      confirmBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });

      btnWrap.appendChild(cancelBtn);
      btnWrap.appendChild(confirmBtn);
      box.appendChild(msg);
      box.appendChild(btnWrap);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  function closeVoiceListModal() {
    if (vlModalAudio) { vlModalAudio.pause(); vlModalAudio = null; }
    voiceListOverlay.style.display = 'none';
  }

  function openVoiceListModal() {
    voiceListOverlay.style.display = 'flex';
    updateMainFilterUI();
    updateSubFilterUI();
    loadVoiceList();
  }

  // 메인 필터 클릭
  container.querySelectorAll('.tts-vl-main-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      vlMainFilter = btn.dataset.filter;
      vlPage = 1;
      updateMainFilterUI();
      loadVoiceList();
    });
  });

  // 서브 필터 클릭
  container.querySelectorAll('.tts-vl-sub-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      vlSubFilter = btn.dataset.sub;
      vlPage = 1;
      updateSubFilterUI();
      loadVoiceList();
    });
  });

  // 검색 (400ms 디바운스)
  let vlSearchTimer = null;
  voiceListSearch.addEventListener('input', () => {
    clearTimeout(vlSearchTimer);
    vlSearchTimer = setTimeout(() => {
      vlSearchQuery = voiceListSearch.value.trim();
      vlPage = 1;
      loadVoiceList();
    }, 400);
  });

  function updateMainFilterUI() {
    container.querySelectorAll('.tts-vl-main-filter').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === vlMainFilter);
    });
  }

  function updateSubFilterUI() {
    container.querySelectorAll('.tts-vl-sub-filter').forEach(b => {
      b.classList.toggle('active', b.dataset.sub === vlSubFilter);
    });
  }

  // ─── 데이터 로드 및 렌더링 ───
  async function loadVoiceList() {
    try {
      const [historyRes, seedsRes] = await Promise.all([
        api.ttsGetHistory(vlSearchQuery, vlPage),
        api.ttsGetSeeds()
      ]);

      const historyItems = (historyRes.history || []).map(h => ({
        id: h.id,
        source: 'history',
        name: h.filename,
        type: h.voice_type,
        speaker: h.speaker || '',
        text: h.original_text || '',
        date: h.created_at,
        duration: h.duration_seconds,
        seed: h.seed,
        fileSize: h.file_size,
        audioUrl: '/tts-audio/' + h.filename
      }));

      const seedItems = (seedsRes.seeds || []).map(s => ({
        id: s.id,
        source: 'seed',
        name: s.name,
        type: s.voice_type,
        speaker: s.speaker || '',
        text: s.voice_description || '',
        date: s.created_at,
        duration: null,
        seed: s.seed,
        fileSize: null,
        audioUrl: s.audio_filename
          ? '/tts-seeds-audio/' + s.audio_filename
          : null
      }));

      let allItems = [];
      if (vlMainFilter === 'all') allItems = [...historyItems, ...seedItems];
      else if (vlMainFilter === 'history') allItems = historyItems;
      else if (vlMainFilter === 'seed') allItems = seedItems;

      if (vlSubFilter !== 'all') {
        allItems = allItems.filter(item => item.type === vlSubFilter);
      }

      if (vlSearchQuery && vlMainFilter !== 'history') {
        const q = vlSearchQuery.toLowerCase();
        allItems = allItems.filter(item =>
          (item.name || '').toLowerCase().includes(q) ||
          (item.speaker || '').toLowerCase().includes(q) ||
          (item.text || '').toLowerCase().includes(q)
        );
      }

      allItems.sort((a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime()
      );

      renderVoiceList(allItems, historyRes.total || 0);
    } catch (err) {
      voiceListContent.innerHTML =
        '<div class="tts-vl-empty">목록을 불러오는데 실패했습니다</div>';
    }
  }

  function renderVoiceList(items, historyTotal) {
    voiceListContent.innerHTML = '';
    if (vlModalAudio) { vlModalAudio.pause(); vlModalAudio = null; }

    if (items.length === 0) {
      voiceListContent.innerHTML =
        '<div class="tts-vl-empty">항목이 없습니다</div>';
      voiceListPagination.innerHTML = '';
      return;
    }

    const typeLabels = { custom: 'Custom Voice', clone: 'Voice Clone', design: 'Voice Design' };
    const typeColors = { custom: '#7c5cff', clone: '#4ade80', design: '#60a5fa' };

    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'tts-vl-card';

      const isSeed = item.source === 'seed';
      const badgeLabel = isSeed ? '시드' : (typeLabels[item.type] || item.type);
      const badgeColor = isSeed ? '#d4af37' : (typeColors[item.type] || '#7c5cff');

      const dateStr = item.date
        ? new Date(item.date).toLocaleString('ko-KR', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
          })
        : '';

      const durationStr = item.duration
        ? (item.duration >= 60
            ? Math.floor(item.duration / 60) + ':' +
              String(Math.round(item.duration % 60)).padStart(2, '0')
            : item.duration.toFixed(1) + '초')
        : '';

      const displayText = (item.text || '').length > 80
        ? item.text.substring(0, 80) + '...'
        : (item.text || '');

      let actionsHtml = '';
      if (item.audioUrl) {
        actionsHtml += '<button class="tts-vl-play-btn" title="재생">▶</button>';
      }
      if (isSeed) {
        actionsHtml += '<button class="tts-vl-use-btn">사용</button>';
      }
      if (!isSeed && item.audioUrl) {
        actionsHtml += '<button class="tts-vl-dl-btn" title="다운로드">⬇</button>';
      }
      actionsHtml += '<button class="tts-vl-del-btn" title="삭제">🗑</button>';

      card.innerHTML = `
        <div class="tts-vl-card-top">
          <div class="tts-vl-card-info">
            <div class="tts-vl-card-name-row">
              <span class="tts-vl-card-name">${item.name}</span>
              <span class="tts-vl-card-badge" style="background:${badgeColor}">${badgeLabel}</span>
            </div>
            <div class="tts-vl-card-text">${displayText}</div>
          </div>
          <div class="tts-vl-card-actions">${actionsHtml}</div>
        </div>
        <div class="tts-vl-card-meta">
          ${item.speaker ? '<span>🔊 ' + item.speaker + '</span>' : ''}
          ${durationStr ? '<span>⏱ ' + durationStr + '</span>' : ''}
          <span>📅 ${dateStr}</span>
          ${isSeed ? '<span class="tts-vl-seed-value">🌱 시드: ' + item.seed + '</span>' : ''}
        </div>
      `;

      // 재생 버튼
      const playBtn = card.querySelector('.tts-vl-play-btn');
      if (playBtn) {
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (vlModalAudio) {
            if (vlModalAudio._src === item.audioUrl && !vlModalAudio.paused) {
              vlModalAudio.pause();
              playBtn.textContent = '▶';
              return;
            }
            vlModalAudio.pause();
            const prevBtn = voiceListContent.querySelector('.tts-vl-playing');
            if (prevBtn) { prevBtn.textContent = '▶'; prevBtn.classList.remove('tts-vl-playing'); }
          }
          vlModalAudio = new Audio(item.audioUrl);
          vlModalAudio._src = item.audioUrl;
          vlModalAudio.play();
          playBtn.textContent = '⏸';
          playBtn.classList.add('tts-vl-playing');
          vlModalAudio.onended = () => {
            playBtn.textContent = '▶';
            playBtn.classList.remove('tts-vl-playing');
          };
        });
      }

      // 시드 사용 버튼
      const useBtn = card.querySelector('.tts-vl-use-btn');
      if (useBtn) {
        useBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const seedVal = item.seed;
          const voiceType = item.type;
          const sp = item.speaker;

          if (voiceType === 'custom') {
            container.querySelector('.tts-tab[data-tab="custom"]').click();
            seedInput.value = seedVal;
            if (sp) {
              speakerSelect.value = sp;
              const selF = container.querySelector('.tts-speaker-female-select');
              const selM = container.querySelector('.tts-speaker-male-select');
              const descEl = container.querySelector('.tts-speaker-desc');
              const allF = window.SPEAKERS_FEMALE || [];
              const allM = window.SPEAKERS_MALE || [];
              const foundF = allF.find(s => s.id === sp);
              const foundM = allM.find(s => s.id === sp);
              if (foundF && selF) {
                selF.value = sp;
                if (selM) selM.selectedIndex = -1;
                if (descEl) descEl.innerHTML = '<span class="tts-speaker-desc-name">' + foundF.name + '</span> · ' + foundF.desc;
              } else if (foundM && selM) {
                selM.value = sp;
                if (selF) selF.selectedIndex = -1;
                if (descEl) descEl.innerHTML = '<span class="tts-speaker-desc-name">' + foundM.name + '</span> · ' + foundM.desc;
              }
            }
          } else if (voiceType === 'design') {
            container.querySelector('.tts-tab[data-tab="design"]').click();
            designSeed.value = seedVal;
          } else if (voiceType === 'clone') {
            container.querySelector('.tts-tab[data-tab="clone"]').click();
            cloneSeed.value = seedVal;
          }

          closeVoiceListModal();
          showToast('시드 ' + seedVal + '이(가) 적용되었습니다.', 'success');
        });
      }

      // 다운로드 버튼
      const dlBtn = card.querySelector('.tts-vl-dl-btn');
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const a = document.createElement('a');
          a.href = item.audioUrl;
          a.download = item.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        });
      }

      // 삭제 버튼
      const delBtn = card.querySelector('.tts-vl-del-btn');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const confirmMsg = isSeed
            ? '"' + item.name + '" 시드를 삭제하시겠습니까?'
            : '"' + item.name + '" 을(를) 삭제하시겠습니까?';
          const confirmed = await showTtsConfirm(confirmMsg);
          if (!confirmed) return;
          try {
            const res = isSeed
              ? await api.ttsDeleteSeed(item.id)
              : await api.ttsDeleteHistory(item.id);
            if (res.success) {
              card.remove();
              showToast('삭제되었습니다.', 'success');
            }
          } catch (err) {
            showToast('삭제에 실패했습니다.', 'error');
          }
        });
      }

      voiceListContent.appendChild(card);
    });

    // 페이지네이션 (히스토리 전용)
    voiceListPagination.innerHTML = '';
    if (vlMainFilter !== 'seed' && historyTotal > 20) {
      const totalPages = Math.ceil(historyTotal / 20);

      if (vlPage > 1) {
        const prevBtn = document.createElement('button');
        prevBtn.className = 'tts-vl-page-btn';
        prevBtn.textContent = '◀';
        prevBtn.addEventListener('click', () => { vlPage--; loadVoiceList(); });
        voiceListPagination.appendChild(prevBtn);
      }

      for (let i = 1; i <= totalPages && i <= 5; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.className = 'tts-vl-page-btn' + (i === vlPage ? ' active' : '');
        pageBtn.textContent = i;
        pageBtn.addEventListener('click', () => { vlPage = i; loadVoiceList(); });
        voiceListPagination.appendChild(pageBtn);
      }

      if (vlPage < totalPages) {
        const nextBtn = document.createElement('button');
        nextBtn.className = 'tts-vl-page-btn';
        nextBtn.textContent = '▶';
        nextBtn.addEventListener('click', () => { vlPage++; loadVoiceList(); });
        voiceListPagination.appendChild(nextBtn);
      }
    }
  }

  // === 페이지 재진입 ===
  registerPageShowCallback('/tts', async () => {
    await loadGuideLink();
    const url = getSavedServer();
    serverInput.value = url;
    const result = await checkConnection(api, url);
    updateBanner(container, result.connected, result.message);
    updateConnectionState(result.connected);
  });

  // === 최초 연결 확인 ===
  await loadGuideLink();
  const initialResult = await checkConnection(api, savedUrl);
  updateBanner(container, initialResult.connected, initialResult.message);
  updateConnectionState(initialResult.connected);
}
