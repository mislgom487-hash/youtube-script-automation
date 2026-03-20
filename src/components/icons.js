// ─── 크기 기본값: 16x16 ───
const S = (size = 16) => `width="${size}" height="${size}"`;
const V = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export const icons = {

  // ── 상태 ──
  success: (size) => `<svg ${S(size)} ${V}><path d="M20 6L9 17l-5-5"/></svg>`,

  error: (size) => `<svg ${S(size)} ${V}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,

  warning: (size) => `<svg ${S(size)} ${V}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,

  info: (size) => `<svg ${S(size)} ${V}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,

  // ── 액션 ──
  close: (size) => `<svg ${S(size)} ${V}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,

  search: (size) => `<svg ${S(size)} ${V}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,

  plus: (size) => `<svg ${S(size)} ${V}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,

  delete: (size) => `<svg ${S(size)} ${V}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,

  edit: (size) => `<svg ${S(size)} ${V}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,

  refresh: (size) => `<svg ${S(size)} ${V}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>`,

  download: (size) => `<svg ${S(size)} ${V}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,

  // ── 콘텐츠 ──
  fire: (size) => `<svg ${S(size)} ${V}><path d="M12 2c.5 3.5-1.5 6-1.5 6s2.5 1 3 4c.5 3-2 5-2 5s3-1 4-3.5c1-2.5 0-5.5-1-7S12 2 12 2z"/><path d="M10 22c-2 0-3.5-1.5-3.5-3.5 0-2 1.5-3 2.5-4 1 1 2.5 2 2.5 4S12 22 10 22z"/></svg>`,

  video: (size) => `<svg ${S(size)} ${V}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,

  channel: (size) => `<svg ${S(size)} ${V}><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>`,

  idea: (size) => `<svg ${S(size)} ${V}><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1h-6a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/></svg>`,

  memo: (size) => `<svg ${S(size)} ${V}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,

  image: (size) => `<svg ${S(size)} ${V}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,

  settings: (size) => `<svg ${S(size)} ${V}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,

  dna: (size) => `<svg ${S(size)} ${V}><path d="M2 15c6.667-6 13.333 0 20-6"/><path d="M9 22c1.798-1.998 2.518-3.995 2.807-5.993"/><path d="M15 2c-1.798 1.998-2.518 3.995-2.807 5.993"/><path d="M17 6l-2.5-2.5"/><path d="M14 8l-1-1"/><path d="M7 18l2.5 2.5"/><path d="M10 16l1 1"/></svg>`,

  chart: (size) => `<svg ${S(size)} ${V}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,

  eye: (size) => `<svg ${S(size)} ${V}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,

  clock: (size) => `<svg ${S(size)} ${V}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,

  drag: (size) => `<svg ${S(size)} ${V}><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`,

  check: (size) => `<svg ${S(size)} ${V}><polyline points="20 6 9 17 4 12"/></svg>`,

  folder: (size) => `<svg ${S(size)} ${V}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`,

  folderFilled: (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.175em"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" fill="rgba(99,102,241,0.1)" stroke="#818cf8"/></svg>`,

  robot: (size) => `<svg ${S(size)} ${V}><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><line x1="8" y1="16" x2="8" y2="16.01"/><line x1="16" y1="16" x2="16" y2="16.01"/></svg>`,

  sun: (size) => `<svg ${S(size)} ${V}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,

  film: (size) => `<svg ${S(size)} ${V}><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`,

  trophy: (size) => `<svg ${S(size)} ${V}><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2z"/></svg>`,

  arrowUp: (size) => `<svg ${S(size)} ${V}><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,

  arrowDown: (size) => `<svg ${S(size)} ${V}><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,

  newBadge: (size) => `<svg ${S(size)} ${V}><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,

  minimize: (size) => `<svg ${S(size)} ${V}><line x1="5" y1="12" x2="19" y2="12"/></svg>`,

  zoom: (size) => `<svg ${S(size)} ${V}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,

  script: (size) => `<svg ${S(size)} ${V}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,

  heart: (size) => `<svg ${S(size)} ${V}><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>`,

  tag: (size) => `<svg ${S(size)} ${V}><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,

  bolt: (size) => `<svg ${S(size)} ${V}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,

  ruler: (size) => `<svg ${S(size)} ${V}><path d="M21 3H3v7l8.5 8.5L21 9V3z"/><line x1="6" y1="7" x2="6" y2="10"/><line x1="9" y1="4" x2="9" y2="10"/><line x1="12" y1="7" x2="12" y2="10"/></svg>`,

  trendUp: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.175em; margin-right:4px"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,

  chartBar: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.175em; margin-right:4px"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,

  comment: (size) => `<svg ${S(size)} ${V}><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`,

  thumbsUp: (size) => `<svg ${S(size)} ${V}><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>`,

  stopwatch: (size) => `<svg ${S(size)} ${V} stroke-width="2.5"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3L2 6"/><path d="M22 6l-3-3"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="10" y1="1" x2="14" y2="1"/></svg>`,

  // ── 경쟁도 (원형 도트) ──
  dotBlue: (size = 10) => `<svg width="${size}" height="${size}" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#3b82f6"/></svg>`,

  dotYellow: (size = 10) => `<svg width="${size}" height="${size}" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#eab308"/></svg>`,

  dotRed: (size = 10) => `<svg width="${size}" height="${size}" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#ef4444"/></svg>`,

  dotPurple: (size = 10) => `<svg width="${size}" height="${size}" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#a855f7"/></svg>`,

  dotGreen: (size = 10) => `<svg width="${size}" height="${size}" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#22c55e"/></svg>`,
};
