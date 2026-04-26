/**
 * Unit tests for INV-009: generation-gate on FileStore fetchers.
 *
 * Exercises the `fetchGeneration` counter that prevents a stale in-flight
 * fetch from overwriting the user's fileList via updateFromBackend.
 *
 * The tests use a lightweight FileStore constructor with a mock backend whose
 * fetchFiles / searchFiles resolvers are controlled by the test, allowing
 * deterministic simulation of the "early fetch resolves late" race.
 */

import { configure, runInAction } from 'mobx';
import { OrderDirection } from '../src/api/data-storage-search';
import { FileDTO } from '../src/api/file';

// MobX configuration for test environment.
configure({ enforceActions: 'never' });

// ---------------------------------------------------------------------------
// Minimal mocks for FileStore's heavyweight dependencies
// ---------------------------------------------------------------------------

/**
 * Returns a minimal mock RootStore whose uiStore and tagStore surfaces
 * are just deep enough for FileStore's constructor and fetcher paths.
 */
function makeMockRootStore(): any {
  const uiStore: any = {
    hideMissingFilesInBrowsing: false,
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

  const tagStore: any = {
    tagList: [],
    get: jest.fn(() => undefined),
  };

  const imageLoader: any = {
    needsThumbnail: jest.fn(() => false),
  };

  const exifTool: any = {};

  // ClientFile constructor calls fileStore.getLocation(locationId) which
  // calls locationStore.get(). Return a minimal fake location.
  const mockLocation: any = {
    id: 'loc1',
    name: 'Test Location',
    path: '/photos',
  };

  return {
    uiStore,
    tagStore,
    imageLoader,
    exifTool,
    locationStore: { get: jest.fn(() => mockLocation) },
  };
}

/**
 * Creates a FileDTO record for use in test fixtures.
 */
function makeFileDTO(id: string): FileDTO {
  return {
    id,
    absolutePath: `/photos/${id}.jpg`,
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

// ---------------------------------------------------------------------------
// FileStore factory
// ---------------------------------------------------------------------------

async function makeFileStore(mockBackend: any): Promise<any> {
  // Dynamically import FileStore so MobX decorators are applied
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  const rootStore = makeMockRootStore();
  const store = new FileStore(mockBackend, rootStore);
  // Expose private members for test assertions
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileStore generation gate (INV-009)', () => {
  /**
   * Row 1: Two concurrent fetchAllFiles() dispatches where the EARLIER one
   * resolves AFTER the later one. The earlier one's results must be dropped.
   *
   * Timeline:
   *   t=0  fetchAllFiles() #1 dispatched — gen=1, backend call starts (slow)
   *   t=1  fetchAllFiles() #2 dispatched — gen=2, backend call starts (fast)
   *   t=2  #2 resolves → updateFromBackend(filesB, 2) → gen===2, applied ✓
   *   t=3  #1 resolves → updateFromBackend(filesA, 1) → gen≠1, dropped ✓
   *
   * Expected: fileList contains filesB, droppedApplyCount === 1.
   */
  it('drops earlier stale fetch when a newer fetch resolves first', async () => {
    const filesA = [makeFileDTO('slow-a1'), makeFileDTO('slow-a2')];
    const filesB = [makeFileDTO('fast-b1')];

    let resolveA!: (files: FileDTO[]) => void;
    const slowFetch = new Promise<FileDTO[]>((resolve) => {
      resolveA = resolve;
    });
    let fetchCount = 0;
    const mockBackend: any = {
      fetchFiles: jest.fn().mockImplementation(() => {
        fetchCount++;
        if (fetchCount === 1) {
          // First call — slow, will resolve after the second
          return slowFetch;
        }
        // Second call — resolves immediately
        return Promise.resolve(filesB);
      }),
      searchFiles: jest.fn(),
      countFiles: jest.fn().mockResolvedValue([0, 0]),
    };

    const store = await makeFileStore(mockBackend);

    // Disable the MobX reaction in constructor that watches hideMissingFilesInBrowsing
    // by running within a context that captures but doesn't error on observableRequiresReaction.

    // Dispatch #1 — slow fetch, does NOT await yet
    const promise1 = store.fetchAllFiles();

    // Dispatch #2 — fast fetch (resolves synchronously from mock)
    await store.fetchAllFiles();

    // At this point, fetch #2 has applied filesB to fileList.
    // fileList should have filesB's content.
    expect(store.fileList.length).toBe(filesB.length);
    expect(store.fileList[0].id).toBe('fast-b1');

    // Now resolve fetch #1's slow backend call. updateFromBackend should drop it.
    resolveA(filesA);
    await promise1;

    // fileList should still contain filesB, not filesA.
    expect(store.fileList.length).toBe(filesB.length);
    expect(store.fileList[0].id).toBe('fast-b1');

    // The drop counter should have incremented once (for the stale sync apply).
    expect(store.droppedApplyCount).toBe(1);
  });

  /**
   * Row 2: The legitimate back-to-back case — two sequential fetchAllFiles()
   * where neither races the other (each awaits before the next dispatches).
   * droppedApplyCount must remain zero.
   */
  it('does not drop legitimate sequential fetches', async () => {
    const filesFirst = [makeFileDTO('first-f1')];
    const filesSecond = [makeFileDTO('second-s1'), makeFileDTO('second-s2')];

    let callCount = 0;
    const mockBackend: any = {
      fetchFiles: jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? filesFirst : filesSecond);
      }),
      searchFiles: jest.fn(),
      countFiles: jest.fn().mockResolvedValue([0, 0]),
    };

    const store = await makeFileStore(mockBackend);

    await store.fetchAllFiles();
    expect(store.fileList.length).toBe(filesFirst.length);

    await store.fetchAllFiles();
    expect(store.fileList.length).toBe(filesSecond.length);

    // No drops — each fetch resolved before the next was dispatched.
    expect(store.droppedApplyCount).toBe(0);
  });
});
