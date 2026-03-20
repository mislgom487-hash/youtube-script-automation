// Toast notification component
import { icons as svgIcons } from './icons.js';

export function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const toastIcons = { success: svgIcons.success(16), error: svgIcons.error(16), info: svgIcons.info(16), warning: svgIcons.warning(16) };
    toast.innerHTML = `<span>${toastIcons[type] || ''}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Modal helper
export function showModal(title, contentHTML, actions = []) {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.remove('hidden');
    overlay.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      <div class="modal-body">${contentHTML}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary modal-close">취소</button>
        ${actions.map((a, i) => `<button class="btn ${a.class || 'btn-primary'}" data-action="${i}">${a.label}</button>`).join('')}
      </div>
    </div>
  `;
    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
    actions.forEach((a, i) => {
        overlay.querySelector(`[data-action="${i}"]`)?.addEventListener('click', () => {
            a.onClick(overlay);
            if (a.closeOnClick !== false) overlay.classList.add('hidden');
        });
    });
}
