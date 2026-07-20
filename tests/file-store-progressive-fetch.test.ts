/**
 * Progressive materialization, centralized auto-save, instance pooling, and
 * incremental index maintenance (tasks 3.2 / 4.1 / 4.2 / 6.2,
 * optimize-large-library-performance).
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

jest.mock('../src/frontend/components/Toaster', () => ({
  AppToaster: { show: jest.fn(), dismiss: jest.fn() },
}));

function makeMockRootStore(): any {
  const uiStore: any = {
    firstItem: 0,
    hideMissingFilesInBrowsing: false,
    showVideosOnly: false,
    isSlideMode: false,
    disableSlideMode: jest.fn(),
    searchCriteriaList: { length: 0, clear: jest.fn(), push: jest.fn(), map: jest.fn(() => []) },
    searchMatchAny: false,
    clearFileSelection: jest.fn(),
    fileSelection: new Set(),
    thumbnailDirectory: '/tmp/thumbs',
    _resetSearchCriteriaListNoFetch: jest.fn(),
    mediaTypeFilter: 'all',
  };
  return {
    uiStore,
    tagStore: { tagList: [], get: jest.fn(() => undefined) },
    imageLoader: { needsThumbnail: jest.fn(() => false) },
    exifTool: { writeTags: jest.fn().mockResolvedValue(undefined) },
    locationStore: { get: jest.fn(() => ({ id: 'loc1', name: 'Test Location', path: '/photos' })) },
  };
}

function makeFileDTO(id: string, tags: string[] = []): FileDTO {
  return {
    id,
    absolutePath: `/photos/${id}.jpg`,
    relativePath: `${id}.jpg`,
    locationId: 'loc1',
    name: `${id}.jpg`,
    size: 100,
    width: 640,
    height: 480,
    dateAdded: new Date(1),
    dateModified: new Date(1),
    dateCreated: new Date(1),
    dateLastIndexed: new Date(1),
    extension: 'jpg',
    ino: id,
    tags,
    annotations: '',
  };
}

/** Backend WITH the id-projection methods → FileStore takes the progressive path. */
function progressiveBackend(dtos: FileDTO[]): any {
  const byId = new Map(dtos.map((d) => [d.id, d]));
  return {
    fetchFiles: jest.fn().mockResolvedValue(dtos),
    fetchFileIds: jest.fn().mockResolvedValue(dtos.map((d) => d.id)),
    fetchFilesByID: jest.fn((ids: string[]) =>
      // Deliberately return rows in REVERSED order: the store must restore
      // the requested order itself (IN-clause results are unordered).
      Promise.resolve(ids.map((id) => byId.get(id)!).reverse()),
    ),
    searchFiles: jest.fn().mockResolvedValue([]),
    countFiles: jest.fn().mockResolvedValue([dtos.length, 0]),
    saveFiles: jest.fn().mockResolvedValue(undefined),
    removeFiles: jest.fn().mockResolvedValue(undefined),
  };
}

/** Backend WITHOUT id projection → one-shot updateFromBackend path (fallback / web). */
function oneShotBackend(dtos: FileDTO[]): any {
  const b = progressiveBackend(dtos);
  delete b.fetchFileIds;
  return b;
}

async function makeStore(backend: any, root?: any, orderBy = 'name'): Promise<{ store: any; root: any }> {
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  const rs = root ?? makeMockRootStore();
  const store: any = new FileStore(backend, rs);
  runInAction(() => (store.orderBy = orderBy));
  return { store, root: rs };
}

// Enough files for several progressive chunks (chunk size 800).
const MANY = Array.from({ length: 2500 }, (_, i) =>
  makeFileDTO(`f${String(i).padStart(4, '0')}`),
);

describe('progressive fetch (task 3.2)', () => {
  it('final list equals the one-shot load: same ids, same order (batch equivalence)', async () => {
    const prog = await makeStore(progressiveBackend(MANY));
    await prog.store.fetchAllFiles();

    const oneShot = await makeStore(oneShotBackend(MANY));
    await oneShot.store.fetchAllFiles();

    expect(prog.store.fileList.length).toBe(MANY.length);
    expect(prog.store.fileList.map((f: any) => f.id)).toEqual(
      oneShot.store.fileList.map((f: any) => f.id),
    );
  });

  it('actually used the chunked id-projection path (multiple bounded by-id fetches)', async () => {
    const backend = progressiveBackend(MANY);
    const { store } = await makeStore(backend);
    await store.fetchAllFiles();

    expect(backend.fetchFileIds).toHaveBeenCalledTimes(1);
    // 2500 files at chunk size 800 → 4 bounded fetches; the one-shot fetch is unused.
    expect(backend.fetchFilesByID.mock.calls.length).toBe(4);
    for (const call of backend.fetchFilesByID.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(800);
    }
    expect(backend.fetchFiles).not.toHaveBeenCalled();
  });

  it('under seeded random order both paths agree as well', async () => {
    const prog = await makeStore(progressiveBackend(MANY), undefined, 'random');
    (prog.store as any).randomSeed = 424242;
    await prog.store.fetchAllFiles();

    const oneShot = await makeStore(oneShotBackend(MANY), undefined, 'random');
    (oneShot.store as any).randomSeed = 424242;
    await oneShot.store.fetchAllFiles();

    expect(prog.store.fileList.map((f: any) => f.id)).toEqual(
      oneShot.store.fileList.map((f: any) => f.id),
    );
  });

  it('drops stale batches when a newer fetch dispatches mid-load', async () => {
    const backend = progressiveBackend(MANY);
    const { store } = await makeStore(backend);

    const firstLoad = store.fetchAllFiles();
    // Let the id fetch + first chunk land, then dispatch a newer fetch.
    await new Promise((res) => setTimeout(res, 0));
    const secondLoad = store.fetchAllFiles();
    await Promise.all([firstLoad, secondLoad]);

    // The stale first load must have been dropped at a generation guard...
    expect(store.droppedApplyCount).toBeGreaterThanOrEqual(1);
    // ...and the final list is complete and consistent (from the second load).
    expect(store.fileList.length).toBe(MANY.length);
    const index = (store as any).index as Map<string, number>;
    expect(index.size).toBe(MANY.length);
    expect(index.get(store.fileList[100].id)).toBe(100);
  });

  it('derived state runs once at completion: counts and index are correct', async () => {
    const withTags = MANY.map((d, i) => (i % 2 === 0 ? { ...d, tags: [] } : d));
    const { store } = await makeStore(progressiveBackend(withTags));
    await store.fetchAllFiles();

    expect(store.numTotalFiles).toBe(withTags.length);
    // tagStore.get returns undefined in this harness → every file untagged.
    expect(store.numUntaggedFiles).toBe(withTags.length);
    const index = (store as any).index as Map<string, number>;
    for (const probe of [0, 799, 800, 1599, 2499]) {
      expect(index.get(store.fileList[probe].id)).toBe(probe);
    }
  });
});

describe('instance pooling across refetches (task 4.2)', () => {
  it('a refetch of an unchanged view allocates zero new ClientFiles', async () => {
    const few = MANY.slice(0, 1000);
    const { store } = await makeStore(progressiveBackend(few));
    await store.fetchAllFiles();

    const firstInstances = store.fileList.slice();
    await store.fetchAllFiles();

    expect(store.fileList.length).toBe(few.length);
    for (let i = 0; i < few.length; i++) {
      expect(store.fileList[i]).toBe(firstInstances[i]); // identity preserved
    }
  });
});

describe('centralized auto-save (task 4.1)', () => {
  function makeTag(id: string): any {
    return {
      id,
      path: [id],
      incrementFileCount: jest.fn(),
      decrementFileCount: jest.fn(),
    };
  }

  it('a tag edit persists via the debounced dirty-set flush (500 ms envelope)', async () => {
    const few = MANY.slice(0, 10);
    const backend = oneShotBackend(few);
    const { store } = await makeStore(backend);
    await store.fetchAllFiles();

    jest.useFakeTimers();
    try {
      const file = store.fileList[3];
      file.addTag(makeTag('tag-1'));
      expect(backend.saveFiles).not.toHaveBeenCalled(); // debounced, not immediate

      jest.advanceTimersByTime(500); // dirty-set flush → store.save()
      jest.advanceTimersByTime(100); // filesToSave debounce → backend.saveFiles
      await Promise.resolve();

      expect(backend.saveFiles).toHaveBeenCalledTimes(1);
      const saved: FileDTO[] = backend.saveFiles.mock.calls[0][0];
      expect(saved).toHaveLength(1);
      expect(saved[0].id).toBe(file.id);
      expect(saved[0].tags).toContain('tag-1');
    } finally {
      jest.useRealTimers();
    }
  });

  it('bulk edit: every affected file is persisted, in one batched backend call', async () => {
    const few = MANY.slice(0, 60);
    const backend = oneShotBackend(few);
    const { store } = await makeStore(backend);
    await store.fetchAllFiles();

    jest.useFakeTimers();
    try {
      const tag = makeTag('bulk-tag');
      for (const file of store.fileList) {
        file.addTag(tag);
      }
      jest.advanceTimersByTime(600);
      await Promise.resolve();

      expect(backend.saveFiles).toHaveBeenCalledTimes(1);
      const saved: FileDTO[] = backend.saveFiles.mock.calls[0][0];
      expect(saved).toHaveLength(few.length);
      expect(saved.every((d) => d.tags.includes('bulk-tag'))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('flushDirtyFiles persists immediately (quit-flush) and skips disposed files', async () => {
    const few = MANY.slice(0, 5);
    const backend = oneShotBackend(few);
    const { store } = await makeStore(backend);
    await store.fetchAllFiles();

    jest.useFakeTimers();
    try {
      store.fileList[0].addTag(makeTag('t'));
      store.fileList[1].addTag(makeTag('t'));
      store.fileList[1].dispose(); // e.g. removed from view before the flush

      store.flushDirtyFiles(); // beforeunload path — no debounce wait
      jest.advanceTimersByTime(100);
      await Promise.resolve();

      const saved: FileDTO[] = backend.saveFiles.mock.calls[0][0];
      expect(saved.map((d) => d.id)).toEqual([store.fileList[0].id]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('no per-file MobX autosave reaction is constructed anymore', async () => {
    const { ClientFile } = await import('../src/frontend/entities/File');
    // The former implementation stored an IReactionDisposer in `saveHandler`;
    // its absence (plus the tests above proving persistence still works) is
    // the structural evidence that N files ≠ N reactions.
    const few = MANY.slice(0, 1);
    const backend = oneShotBackend(few);
    const { store } = await makeStore(backend);
    await store.fetchAllFiles();
    const file = store.fileList[0];
    expect(file).toBeInstanceOf(ClientFile);
    expect((file as any).saveHandler).toBeUndefined();
  });
});

describe('incremental index maintenance (task 6.2)', () => {
  it('index stays correct after a single delete, a bulk delete, and a reload', async () => {
    const few = MANY.slice(0, 300);
    const backend = progressiveBackend(few);
    const { store } = await makeStore(backend);
    await store.fetchAllFiles();
    const index = (store as any).index as Map<string, number>;

    // Single delete in the middle.
    store.removeFilesFromListInPlace([store.fileList[150]]);
    expect(store.fileList.length).toBe(299);
    expect(index.size).toBe(299);
    expect(index.get(store.fileList[150].id)).toBe(150);
    expect(index.get(store.fileList[298].id)).toBe(298);

    // Bulk delete (>50 → clear+push branch).
    const bulk = store.fileList.slice(10, 80);
    store.removeFilesFromListInPlace(bulk);
    expect(store.fileList.length).toBe(299 - 70);
    expect(index.size).toBe(store.fileList.length);
    for (const probe of [0, 9, 10, 100, store.fileList.length - 1]) {
      expect(index.get(store.fileList[probe].id)).toBe(probe);
    }

    // Full reload rebuilds cleanly.
    await store.fetchAllFiles();
    expect(index.size).toBe(few.length);
  });

  it('deleting the tail file does not iterate the whole list (shift range only)', async () => {
    const few = MANY.slice(0, 200);
    const { store } = await makeStore(progressiveBackend(few));
    await store.fetchAllFiles();
    const index = (store as any).index as Map<string, number>;

    const setSpy = jest.spyOn(index, 'set');
    store.removeFilesFromListInPlace([store.fileList[store.fileList.length - 1]]);
    // Tail delete: no indices shift → zero index rewrites (a full
    // updateFileListState pass would have rewritten all ~200).
    expect(setSpy.mock.calls.length).toBe(0);
    setSpy.mockRestore();

    expect(store.fileList.length).toBe(199);
    expect(index.size).toBe(199);
  });
});
