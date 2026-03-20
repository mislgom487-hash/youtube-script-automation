// Content script — injected into YouTube pages
// Handles YouTube SPA navigation via yt-navigate-finish event

const SERVER_URL = 'http://localhost:3001';
let currentUrl = '';

function init() {
    // YouTube is an SPA — regular page load only fires once
    // Use yt-navigate-finish for subsequent navigations
    document.addEventListener('yt-navigate-finish', onNavigate);
    // Also run on initial load
    setTimeout(onNavigate, 1500);
}

function onNavigate() {
    const url = window.location.href;
    if (url === currentUrl) return;
    currentUrl = url;

    // Remove previous buttons
    document.querySelectorAll('.yta-ext-btn').forEach(el => el.remove());

    if (url.includes('/watch')) {
        injectVideoPageButtons();
    } else if (url.includes('/@') || url.includes('/channel/') || url.includes('/c/')) {
        injectChannelPageButton();
    }
}

async function injectVideoPageButtons() {
    // Wait for the title element
    const titleEl = await waitForElement('#above-the-fold #title h1, #title h1');
    if (!titleEl) return;

    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) return;

    // Check if already collected
    let isCollected = false;
    try {
        const res = await fetch(`${SERVER_URL}/api/health`);
        if (res.ok) {
            // Server is running, could check if video exists
        }
    } catch (e) {
        // Server not running
        return;
    }

    // Create button container
    const container = document.createElement('div');
    container.className = 'yta-ext-btn';
    container.innerHTML = `
    <button class="yta-btn yta-add-btn" title="이 영상을 DB에 추가">🎬 수집</button>
  `;

    // Insert after title
    titleEl.parentElement.appendChild(container);

    // Add video button
    container.querySelector('.yta-add-btn').addEventListener('click', async () => {
        const btn = container.querySelector('.yta-add-btn');
        btn.textContent = '⏳';
        btn.disabled = true;
        try {
            const title = titleEl.textContent.trim();
            const descEl = document.querySelector('#description-inline-expander, #description');
            const description = descEl?.textContent?.trim().substring(0, 500) || '';

            const res = await fetch(`${SERVER_URL}/api/videos/manual`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, description, video_id: videoId })
            });
            if (res.ok) {
                btn.textContent = '✅ 수집됨';
                btn.style.background = '#059669';
            } else {
                const err = await res.json();
                btn.textContent = '❌';
                alert(err.error || '수집 실패');
            }
        } catch (e) {
            btn.textContent = '❌ 서버 오류';
        }
    });

}

function injectChannelPageButton() {
    const headerEl = document.querySelector('#channel-header, #channel-name, #inner-header-container');
    if (!headerEl) return;

    const btn = document.createElement('button');
    btn.className = 'yta-ext-btn yta-btn yta-channel-btn';
    btn.textContent = '📺 이 채널 등록';
    btn.title = '주제 분석기에 이 채널을 등록합니다';

    btn.addEventListener('click', async () => {
        btn.textContent = '⏳';
        btn.disabled = true;
        try {
            // Get channel URL
            const channelUrl = window.location.href.split('?')[0];
            const res = await fetch(`${SERVER_URL}/api/channels/preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: channelUrl })
            });
            if (res.ok) {
                const info = await res.json();
                const addRes = await fetch(`${SERVER_URL}/api/channels`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(info)
                });
                if (addRes.ok) {
                    btn.textContent = '✅ 등록됨';
                    btn.style.background = '#059669';
                } else {
                    const err = await addRes.json();
                    btn.textContent = err.error?.includes('이미') ? '✅ 이미 등록됨' : '❌ 실패';
                }
            }
        } catch (e) {
            btn.textContent = '❌ 서버 오류';
        }
    });

    headerEl.appendChild(btn);
}

function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);

        const observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) { observer.disconnect(); resolve(el); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    });
}

init();
