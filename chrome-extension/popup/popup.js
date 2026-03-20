// Popup script — shows server status
const SERVER_URL = 'http://localhost:3001';

async function init() {
    const content = document.getElementById('content');
    try {
        const healthRes = await fetch(`${SERVER_URL}/api/health`);
        if (!healthRes.ok) throw new Error('Server error');

        content.innerHTML = `
      <div class="status ok">✅ 서버 연결됨</div>
      <div style="margin-top:10px;font-size:12px;color:#888;text-align:center;">
        서버가 정상 실행 중입니다.
      </div>
    `;
    } catch (e) {
        content.innerHTML = `
      <div class="status err">❌ 서버 연결 실패</div>
      <div style="margin-top:10px;font-size:12px;color:#888;text-align:center;">
        서버를 먼저 실행해주세요:<br>
        <code style="background:#1a1a2e;padding:4px 8px;border-radius:4px;margin-top:6px;display:inline-block;">npm run server</code>
      </div>
    `;
    }
}

init();
