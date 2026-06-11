/**
 * Tests for FileStore.watchUiPreferences — the cross-store reaction that
 * refetches when the "hide missing files" preference toggles.
 *
 * Regression context: this reaction originally lived in FileStore's
 * constructor. RootStore builds FileStore BEFORE UiStore, so the reaction's
 * immediate first evaluation threw on the undefined uiStore; MobX contained
 * the error, and because `rootStore.uiStore` is a plain (non-observable)
 * field the reaction never re-evaluated — leaving the hide-missing-files
 * toggle silently broken in every session. The fix moves the wiring to
 * watchUiPreferences(), called by RootStore after all stores exist.
 */

import { configure, observable, runInAction } from 'mobx';

configure({ enforceActions: 'never' });

/** Flush pending microtasks so the async refetch reaches the backend mock. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function makeFileStore(rootStore: any): Promise<{ store: any; mockBackend: any }> {
  // Dynamic import so MobX decorators are applied (matches the pattern in
  // file-store-generation-gate.test.ts).
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  const mockBackend: any = {
    fetchFiles: jest.fn().mockResolvedValue([]),
    searchFiles: jest.fn().mockResolvedValue([]),
    countFiles: jest.fn().mockResolvedValue([0, 0]),
  };
  return { store: new FileStore(mockBackend, rootStore), mockBackend };
}

describe('FileStore.watchUiPreferences', () => {
  it('constructs without throwing when uiStore does not exist yet', async () => {
    // RootStore builds FileStore before UiStore — the constructor must not
    // read rootStore.uiStore. This would have caught the original bug.
    await expect(makeFileStore({} as any)).resolves.toBeTruthy();
  });

  it('refetches when hideMissingFilesInBrowsing toggles after wiring', async () => {
    // The fetcher path reads several uiStore surfaces beyond the toggled flag —
    // mirror the mock shape used by file-store-generation-gate.test.ts.
    const uiStore: any = observable(
      {
        hideMissingFilesInBrowsing: true,
        isSlideMode: false,
        disableSlideMode: jest.fn(),
        searchCriteriaList: {
          length: 0,
          clear: jest.fn(),
          push: jest.fn(),
          map: jest.fn(() => []),
        },
        searchMatchAny: false,
        clearFileSelection: jest.fn(),
        fileSelection: new Set(),
        thumbnailDirectory: '/tmp/thumbs',
        _resetSearchCriteriaListNoFetch: jest.fn(),
      },
      // Keep functions/collections as plain references; only the boolean needs
      // to be observable for the reaction to track it.
      {
        disableSlideMode: false,
        searchCriteriaList: false,
        clearFileSelection: false,
        fileSelection: false,
        _resetSearchCriteriaListNoFetch: false,
      },
    );
    const { store, mockBackend } = await makeFileStore({
      uiStore,
      tagStore: { tagList: [], get: jest.fn(() => undefined) },
      imageLoader: { needsThumbnail: jest.fn(() => false) },
      exifTool: {},
      locationStore: { get: jest.fn(() => ({ id: 'loc1', name: 'Test', path: '/photos' })) },
    });

    store.watchUiPreferences();
    await flush();
    // Wiring alone must not trigger a fetch — only an actual toggle should.
    expect(mockBackend.fetchFiles).not.toHaveBeenCalled();

    runInAction(() => {
      uiStore.hideMissingFilesInBrowsing = false;
    });
    await flush();
    // The reaction dispatches refetch() → fetchAllFiles() → backend.fetchFiles.
    expect(mockBackend.fetchFiles).toHaveBeenCalledTimes(1);

    runInAction(() => {
      uiStore.hideMissingFilesInBrowsing = true;
    });
    await flush();
    expect(mockBackend.fetchFiles).toHaveBeenCalledTimes(2);
  });
});
