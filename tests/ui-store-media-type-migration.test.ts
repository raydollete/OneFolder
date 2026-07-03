/**
 * Tests for the media-type-filter persistence migration in
 * UiStore.recoverPersistentPreferences (change: media-type-filter-dropdown).
 *
 * The tri-state `mediaTypeFilter` replaced the legacy boolean `showVideosOnly`.
 * On load: a persisted `mediaTypeFilter` of one of the three known values wins;
 * otherwise a legacy `showVideosOnly: true` maps to 'video'; everything else
 * (missing, false, null, malformed) coerces to 'all' — never undefined.
 */

import { configure } from 'mobx';

configure({ enforceActions: 'never' });

// Neutralise the platform seam (fs-extra/ExifIO/electron graph) but provide the
// surfaces recoverPersistentPreferences touches.
jest.mock('src/frontend/platform', () => ({
  __esModule: true,
  default: {
    desktop: {
      setTheme: jest.fn(),
      getDefaultThumbnailDirectory: jest.fn().mockResolvedValue('/tmp/thumbs'),
    },
    fs: { ensureDirSync: jest.fn() },
  },
}));

import UiStore from '../src/frontend/stores/UiStore';

/** In-memory localStorage stub whose getItem always returns the given prefs JSON. */
function installLocalStorage(prefs: Record<string, unknown>): void {
  const value = JSON.stringify({ hotkeyMap: {}, ...prefs });
  (global as any).localStorage = {
    getItem: jest.fn(() => value),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  };
}

function makeUiStore(): UiStore {
  const mockRootStore = {
    fileStore: { fileList: [] },
  } as any;
  return new UiStore(mockRootStore);
}

function recoverWith(prefs: Record<string, unknown>): UiStore {
  installLocalStorage(prefs);
  const store = makeUiStore();
  store.recoverPersistentPreferences();
  return store;
}

describe('UiStore mediaTypeFilter migration', () => {
  it('maps legacy showVideosOnly true to video', () => {
    expect(recoverWith({ showVideosOnly: true }).mediaTypeFilter).toBe('video');
  });

  it('maps legacy showVideosOnly false to all', () => {
    expect(recoverWith({ showVideosOnly: false }).mediaTypeFilter).toBe('all');
  });

  it('defaults to all when no media preference is present', () => {
    expect(recoverWith({}).mediaTypeFilter).toBe('all');
  });

  it('honours a persisted tri-state value', () => {
    expect(recoverWith({ mediaTypeFilter: 'images' }).mediaTypeFilter).toBe('images');
    expect(recoverWith({ mediaTypeFilter: 'video' }).mediaTypeFilter).toBe('video');
    expect(recoverWith({ mediaTypeFilter: 'all' }).mediaTypeFilter).toBe('all');
  });

  it('coerces an unrecognized mediaTypeFilter to all', () => {
    expect(recoverWith({ mediaTypeFilter: 'bogus' }).mediaTypeFilter).toBe('all');
    expect(recoverWith({ mediaTypeFilter: null }).mediaTypeFilter).toBe('all');
  });

  it('prefers a valid mediaTypeFilter over a conflicting legacy boolean', () => {
    // New value present and valid → legacy boolean is ignored.
    expect(recoverWith({ mediaTypeFilter: 'images', showVideosOnly: true }).mediaTypeFilter).toBe(
      'images',
    );
  });
});
