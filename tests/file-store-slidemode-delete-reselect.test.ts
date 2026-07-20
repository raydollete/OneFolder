/**
 * Regression tests for INV-033: SlideMode delete auto-advance re-selects the
 * advanced-to file so the next consecutive Delete is not a silent no-op.
 *
 * Root cause: `removeFilesFromListInPlace` reconciled `uiStore.firstItem` after
 * a delete but never updated `uiStore.fileSelection` to reflect the new viewed
 * file. The delete command is selection-driven, so the next delete targeted an
 * empty selection and deleted nothing.
 *
 * Fix (TASK-123): after the auto-advance assigns `uiStore.firstItem`, also call
 * `uiStore.fileSelection.replace([targetFile])` when `isSlideMode` is true.
 *
 * Test template mirrors `file-store-firstitem-scroll-during-fetch.test.ts` and
 * `file-store-generation-gate.test.ts`.
 */

import { configure, observable, runInAction } from 'mobx';
import { FileDTO } from '../src/api/file';

configure({ enforceActions: 'never' });

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('fs-extra', () => ({
  __esModule: true,
  default: {
    pathExists: jest.fn().mockResolvedValue(true),
    remove: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../src/frontend/components/Toaster', () => ({
  AppToaster: { show: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Mock RootStore
//
// Key difference from the generation-gate template: `fileSelection` is a real
// MobX ObservableSet so that `fileSelection.replace([...])` — the mechanism
// used by the TASK-123 fix — actually mutates the set and is observable by tests.
// ---------------------------------------------------------------------------

function makeMockRootStore(): any {
  const fileSelection = observable(new Set<any>());

  const uiStore: any = {
    firstItem: 0,
    isSlideMode: false,
    // Identity anchor for the slide-mode viewer (see UiStore.slideFileId). The
    // viewer resolves its file via this ID, so the delete auto-advance must keep
    // it in sync or the viewer drops to the empty "no file" state.
    slideFileId: undefined,
    hideMissingFilesInBrowsing: false,
    showVideosOnly: false,
    fileSelection,
    thumbnailDirectory: '/tmp/thumbs',
    disableSlideMode: jest.fn(),
    clearFileSelection: jest.fn(() => fileSelection.clear()),
    searchCriteriaList: {
      length: 0,
      clear: jest.fn(),
      push: jest.fn(),
      map: jest.fn(() => []),
    },
    searchMatchAny: false,
    _resetSearchCriteriaListNoFetch: jest.fn(),
  };

  return {
    uiStore,
    tagStore: { tagList: [], get: jest.fn(() => undefined) },
    imageLoader: { needsThumbnail: jest.fn(() => false) },
    exifTool: {},
    locationStore: {
      get: jest.fn(() => ({ id: 'loc1', name: 'Test Location', path: '/photos' })),
    },
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

async function makeFileStore(
  fileDTOs: FileDTO[],
  rootStore?: any,
): Promise<{ store: any; root: any }> {
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  const root = rootStore ?? makeMockRootStore();
  const backend: any = {
    fetchFiles: jest.fn().mockResolvedValue(fileDTOs),
    searchFiles: jest.fn().mockResolvedValue([]),
    countFiles: jest.fn().mockResolvedValue([fileDTOs.length, 0]),
    removeFiles: jest.fn().mockResolvedValue(undefined),
  };
  const store = new FileStore(backend, root);
  // Pin a deterministic sort: the default 'random' now applies a session-seeded
  // client-side shuffle in updateFromBackend, which would scramble the
  // insertion order these index-based assertions rely on.
  const { runInAction } = await import('mobx');
  runInAction(() => ((store as any).orderBy = 'name'));
  // Load the initial file list synchronously via updateFromBackend (gen=0).
  const gen = (store as any).fetchGeneration;
  await store.updateFromBackend(fileDTOs, gen);
  return { store, root };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the IDs currently in fileSelection as an array for easy assertion. */
function selectionIds(root: any): string[] {
  return Array.from(root.uiStore.fileSelection as Set<any>, (f: any) => f.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileStore SlideMode delete auto-advance re-selection (INV-033, TASK-123)', () => {
  /**
   * Forward advance: viewer is on file C (index 2) in [A, B, C, D, E].
   * After deleting C the auto-advance should land on D (new index 2) and
   * fileSelection must contain exactly D.
   */
  it('forward advance: fileSelection tracks the advanced-to file', async () => {
    const dtos = ['a', 'b', 'c', 'd', 'e'].map((id) => makeFileDTO(id));
    const { store, root } = await makeFileStore(dtos);

    const fileC = store.fileList[2]; // 'c'
    const fileD = store.fileList[3]; // 'd'

    runInAction(() => {
      root.uiStore.firstItem = 2;
      root.uiStore.isSlideMode = true;
      root.uiStore.slideFileId = fileC.id; // viewer anchored to 'c'
      root.uiStore.fileSelection.replace([fileC]);
    });

    expect(selectionIds(root)).toEqual(['c']);

    store.removeFilesFromListInPlace([fileC]);

    // fileList is now [a, b, d, e] — 'd' is at index 2.
    expect(store.fileList.length).toBe(4);
    expect(store.fileList[root.uiStore.firstItem].id).toBe('d');
    expect(root.uiStore.firstItem).toBe(2);
    // TASK-123 fix: selection must contain exactly 'd'.
    expect(root.uiStore.fileSelection.size).toBe(1);
    expect(selectionIds(root)).toEqual(['d']);
    // The advanced-to file is the same object as in fileList.
    expect(root.uiStore.fileSelection.has(fileD)).toBe(true);
    // Viewer re-anchor: slideFileId must move to 'd', not stay on the deleted 'c'.
    // (Without this the viewer resolves slideFile to undefined → blank empty state.)
    expect(root.uiStore.slideFileId).toBe('d');
  });

  /**
   * Tail advance: viewer is on file E (last) in [A, B, C, D, E].
   * After deleting E the auto-advance scans backward to D, which becomes the
   * new tail. fileSelection must contain exactly D.
   */
  it('tail (backward) advance: fileSelection tracks the new tail', async () => {
    const dtos = ['a', 'b', 'c', 'd', 'e'].map((id) => makeFileDTO(id));
    const { store, root } = await makeFileStore(dtos);

    const fileE = store.fileList[4]; // 'e'
    const fileD = store.fileList[3]; // 'd'

    runInAction(() => {
      root.uiStore.firstItem = 4;
      root.uiStore.isSlideMode = true;
      root.uiStore.slideFileId = fileE.id; // viewer anchored to 'e'
      root.uiStore.fileSelection.replace([fileE]);
    });

    store.removeFilesFromListInPlace([fileE]);

    // fileList is now [a, b, c, d] — 'd' is at index 3 (new tail).
    expect(store.fileList.length).toBe(4);
    expect(store.fileList[root.uiStore.firstItem].id).toBe('d');
    expect(root.uiStore.firstItem).toBe(3);
    expect(root.uiStore.fileSelection.size).toBe(1);
    expect(root.uiStore.fileSelection.has(fileD)).toBe(true);
    // Viewer re-anchor: backward advance to the new tail 'd'.
    expect(root.uiStore.slideFileId).toBe('d');
  });

  /**
   * Empty-list: single-element list [A], deleting A empties the list.
   * SlideMode is disabled; fileSelection ends empty.
   * This branch is UNCHANGED by TASK-123 — nothing to select when the list
   * is empty.
   */
  it('empty list: disableSlideMode called, fileSelection is empty', async () => {
    const dtos = [makeFileDTO('a')];
    const { store, root } = await makeFileStore(dtos);

    const fileA = store.fileList[0]; // 'a'

    runInAction(() => {
      root.uiStore.firstItem = 0;
      root.uiStore.isSlideMode = true;
      root.uiStore.fileSelection.replace([fileA]);
    });

    store.removeFilesFromListInPlace([fileA]);

    expect(store.fileList.length).toBe(0);
    expect(root.uiStore.disableSlideMode).toHaveBeenCalled();
    // Selection should be empty — nothing to re-select.
    expect(root.uiStore.fileSelection.size).toBe(0);
  });

  /**
   * Non-SlideMode delete: same setup as the forward-advance case, but
   * isSlideMode is false. The TASK-123 fix is gated on isSlideMode, so the
   * selection must end EMPTY — grid behavior is unchanged.
   */
  it('non-SlideMode delete: fileSelection ends empty (grid behavior unchanged)', async () => {
    const dtos = ['a', 'b', 'c', 'd', 'e'].map((id) => makeFileDTO(id));
    const { store, root } = await makeFileStore(dtos);

    const fileC = store.fileList[2]; // 'c'

    runInAction(() => {
      root.uiStore.firstItem = 2;
      root.uiStore.isSlideMode = false; // NOT in SlideMode
      root.uiStore.fileSelection.replace([fileC]);
    });

    store.removeFilesFromListInPlace([fileC]);

    // fileList is [a, b, d, e]. firstItem should be clamped in range.
    expect(store.fileList.length).toBe(4);
    expect(root.uiStore.firstItem).toBeLessThan(store.fileList.length);
    // Selection must be empty — the grid does not auto-arm after a delete.
    expect(root.uiStore.fileSelection.size).toBe(0);
  });

  /**
   * Viewed file survives a bulk delete of neighbors: files B and D are
   * deleted while the viewer is on C. C survives, its index shifts left
   * (B removed → C moves from index 2 to 1). fileSelection must contain
   * exactly C at its new index.
   */
  it('bulk delete of neighbors: viewed file survives and stays the sole selection', async () => {
    const dtos = ['a', 'b', 'c', 'd', 'e'].map((id) => makeFileDTO(id));
    const { store, root } = await makeFileStore(dtos);

    const fileB = store.fileList[1]; // 'b'
    const fileC = store.fileList[2]; // 'c' — the viewed file
    const fileD = store.fileList[3]; // 'd'

    runInAction(() => {
      root.uiStore.firstItem = 2; // viewing 'c'
      root.uiStore.isSlideMode = true;
      root.uiStore.slideFileId = fileC.id; // viewer anchored to 'c'
      root.uiStore.fileSelection.replace([fileC]);
    });

    // Delete B and D — C survives.
    store.removeFilesFromListInPlace([fileB, fileD]);

    // fileList is now [a, c, e]. C is at index 1.
    expect(store.fileList.length).toBe(3);
    expect(store.fileList[1].id).toBe('c');
    expect(root.uiStore.firstItem).toBe(1);
    // TASK-123 fix: selection must still contain exactly 'c'.
    expect(root.uiStore.fileSelection.size).toBe(1);
    expect(root.uiStore.fileSelection.has(fileC)).toBe(true);
    // The viewed file survived, so the anchor must remain on 'c' (non-interference:
    // the survived-file branch must not re-anchor to a different file).
    expect(root.uiStore.slideFileId).toBe('c');
  });
});
