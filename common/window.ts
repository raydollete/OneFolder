const params = new URLSearchParams(window.location.search.slice(1));
export const IS_PREVIEW_WINDOW = params.get('preview') === 'true';

// Window State
// Intentionally kept GLOBAL (not per-library): window position and fullscreen
// state are system-level concerns that apply regardless of which library is open.
export const WINDOW_STORAGE_KEY = 'OneFolder_Window';
