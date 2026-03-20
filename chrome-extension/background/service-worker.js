// Service worker — handles background tasks
// Minimal for now, can be extended for notifications
chrome.runtime.onInstalled.addListener(() => {
    console.log('YouTube 주제 분석기 확장 프로그램 설치됨');
});
