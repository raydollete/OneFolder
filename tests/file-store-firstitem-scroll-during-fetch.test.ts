/**
 * Originally the INV-028 (TASK-106) tests: firstItem surviving a user scroll
 * during updateFromBackend's ASYNC existence-check window.
 *
 * That window no longer exists. The large-library-performance change removed
 * the per-load pathExists sweep: existence now derives from the store's
 * missingFileIds set (watcher reconciliation + unlink events + on-demand
 * checks), so updateFromBackend commits fileList, hide-missing filtering,
 * counts, and the firstItem anchor in ONE synchronous transaction. The
 * scroll-during-window race INV-028 guarded against is structurally
 * impossible now — these tests verify the replacement invariants:
 *
 *  1. A load performs ZERO disk existence checks (spec: "File existence is
 *     not re-verified by a full per-load disk sweep").
 *  2. Files in missingFileIds are marked broken and (with hide-missing on)
 *     kept out of fileList synchronously, with accurate counts.
 *  3. firstItem is re-anchored by identity in the same transaction; a user
 *     scroll after the load resolves is never clobbered by a late async pass.
 */

import { configure, runInAction } from 'mobx';
import { FileDTO } from '../src/api/file';

configure({ enforceActions: 'never' });

jest.mock('fs-extra', () => ({
  __esModule: true,
  default: {
    pathExists: jest.fn().mockResolvedValue(true),
    remove: jest.fn().mockResolvedValue(undefined),
  },
}));

// AppToaster is not available in node test env.
jest.mock('../src/frontend/components/Toaster', () => ({
  AppToaster: { show: jest.fn() },
}));

function makeMockRootStore(): any {
  const uiStore: any = {
    firstItem: 0,
    hideMissingFilesInBrowsing: false,
    showVideosOnly: false,
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
  };

  return {
    uiStore,
    tagStore: { tagList: [], get: jest.fn(() => undefined) },
    imageLoader: { needsThumbnail: jest.fn(() => false) },
    exifTool: {},
    locationStore: { get: jest.fn(() => ({ id: 'loc1', name: 'Test Location', path: '/photos' })) },
  };
}

function makeFileDTO(id: string, absolutePath = `/photos/${id}.jpg`): FileDTO {
  return {
    id,
    absolutePath,
    relativePath: `${id}.jpg`,
    locationId: 'loc1',
    name: `${id}.jpg`,
    size: 100,
    width: 640,
    height: 480,
    dateAdded: new Date(),
    dateModified: new Date(),
    dateCreated: new Date(),
    dateLastIndexed: new Date(),
    extension: 'jpg',
    ino: id,
    tags: [],
    annotations: '',
  };
}

async function makeFileStore(mockBackend: any, rootStore?: any): Promise<any> {
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  const rs = rootStore ?? makeMockRootStore();
  const store: any = new FileStore(mockBackend, rs);
  // Deterministic order for index-based assertions (default 'random' would
  // apply the session-seeded shuffle).
  runInAction(() => (store.orderBy = 'name'));
  return store;
}

function baseBackend(fetchResult: FileDTO[]): any {
  return {
    fetchFiles: jest.fn().mockResolvedValue(fetchResult),
    searchFiles: jest.fn().mockResolvedValue([]),
    countFiles: jest.fn().mockResolvedValue([0, 0]),
  };
}

describe('FileStore synchronous load commit (existence-sweep removal)', () => {
  beforeEach(async () => {
    const fse = await import('fs-extra');
    (fse.default.pathExists as jest.Mock).mockClear();
  });

  it('performs zero disk existence checks during a load or refetch', async () => {
    const filesA = [makeFileDTO('f0'), makeFileDTO('f1'), makeFileDTO('f2')];
    const store = await makeFileStore(baseBackend(filesA));
    const fse = await import('fs-extra');

    const gen = (store as any).fetchGeneration;
    await store.updateFromBackend(filesA, gen);
    expect(store.fileList.length).toBe(3);
    // Refetch with the same data (sort change / watcher-triggered refetch shape).
    await store.updateFromBackend(filesA, (store as any).fetchGeneration);

    // The former per-load sweep called pathExists once per file per load.
    expect(fse.default.pathExists).not.toHaveBeenCalled();
  });

  it('hides missingFileIds members synchronously with accurate counts and anchor', async () => {
    const filesA = [makeFileDTO('f0'), makeFileDTO('f1'), makeFileDTO('f2')];
    const root = makeMockRootStore();
    root.uiStore.hideMissingFilesInBrowsing = true;
    const store = await makeFileStore(baseBackend(filesA), root);

    // f0 is known-missing (watcher reconciliation / unlink event / audit).
    (store as any).missingFileIds.add('f0');

    const gen = (store as any).fetchGeneration;
    await store.updateFromBackend(filesA, gen);

    // Committed synchronously: broken file kept out of the list, counted in the badge.
    expect(store.fileList.map((f: any) => f.id)).toEqual(['f1', 'f2']);
    expect(store.numMissingFiles).toBe(1);
    // Anchor: firstItem=0 pointed at f0 which is hidden → clamped into range.
    expect(root.uiStore.firstItem).toBeLessThan(store.fileList.length);
  });

  it('re-anchors firstItem by identity across a refetch, in the same transaction', async () => {
    const filesA = [makeFileDTO('f0'), makeFileDTO('f1'), makeFileDTO('f2')];
    const root = makeMockRootStore();
    const store = await makeFileStore(baseBackend(filesA), root);

    await store.updateFromBackend(filesA, (store as any).fetchGeneration);
    // User views f2.
    runInAction(() => (root.uiStore.firstItem = 2));

    // Refetch returns the same files in a different order → f2's index changes.
    const reordered = [filesA[2], filesA[0], filesA[1]];
    await store.updateFromBackend(reordered, (store as any).fetchGeneration);

    expect(store.fileList[root.uiStore.firstItem].id).toBe('f2');
    expect(root.uiStore.firstItem).toBe(0);
  });

  it('a user scroll after the load resolves is never clobbered (no async second pass)', async () => {
    const filesA = [makeFileDTO('f0'), makeFileDTO('f1'), makeFileDTO('f2')];
    const root = makeMockRootStore();
    const store = await makeFileStore(baseBackend(filesA), root);

    await store.updateFromBackend(filesA, (store as any).fetchGeneration);

    // Scroll after the promise resolved. The former implementation could still
    // run a late existence-splice transaction here; nothing may move firstItem now.
    runInAction(() => (root.uiStore.firstItem = 2));
    await new Promise<void>((res) => setTimeout(res, 20));

    expect(root.uiStore.firstItem).toBe(2);
  });
});
