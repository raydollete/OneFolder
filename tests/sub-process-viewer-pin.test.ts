/**
 * FileStore media-job finalize plumbing (originally INV-023/INV-026).
 *
 * These tests exercise the store-level mechanisms the media-job output commit
 * still relies on, independent of how the job is surfaced in the UI:
 *
 *   1. A same-mode background refetch must NOT exit SlideMode (only a real mode change does).
 *   2. finalizeEncodedOutput tags the temp file, ingests via the single deterministic
 *      LocationStore path, injects the output into fileList, and never disables SlideMode.
 *   3. ensureFileInListAt returns the existing index or injects + re-indexes.
 *
 * NOTE: INV-035 retired the in-viewer pin/lock model (the `mediaProcessingFile`
 * pin, the seamless source->output swap, and the blocking error/keep modals).
 * Those tests were removed with it; media jobs now run in MediaQueueStore and the
 * bottom drawer (see tests/media-queue-store.test.ts and tests/media-queue-drawer-dom.test.tsx).
 *
 * Mock pattern mirrors file-store-generation-gate.test.ts / file-store-ui-preferences.test.ts.
 */

import { configure } from 'mobx';
import { FileDTO } from '../src/api/file';

configure({ enforceActions: 'never' });

// AppToaster touches `window` (not present in the node test env); the finalize fallback uses it.
jest.mock('../src/frontend/components/Toaster', () => ({ AppToaster: { show: jest.fn() } }));

// RendererMessenger uses ipcRenderer (not present in the node test env). Mock the module so
// finalizeEncodedOutput can call commitMediaJob without hitting real Electron IPC.
const commitMediaJobMock = jest.fn();
jest.mock('../src/ipc/renderer', () => ({
  RendererMessenger: {
    commitMediaJob: (...args: any[]) => commitMediaJobMock(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockRootStore(): any {
  const uiStore: any = {
    hideMissingFilesInBrowsing: false,
    isSlideMode: false,
    disableSlideMode: jest.fn(),
    selectFile: jest.fn(),
    firstItem: 0,
    thumbnailDirectory: '/tmp/thumbs',
    searchCriteriaList: { length: 0, clear: jest.fn(), push: jest.fn(), map: jest.fn(() => []) },
    searchMatchAny: false,
    clearFileSelection: jest.fn(),
    fileSelection: new Set(),
    _resetSearchCriteriaListNoFetch: jest.fn(),
  };
  return {
    uiStore,
    tagStore: { tagList: [], get: jest.fn(() => undefined) },
    imageLoader: { needsThumbnail: jest.fn(() => false) },
    exifTool: { writeTags: jest.fn().mockResolvedValue(undefined) },
    locationStore: {
      get: jest.fn(() => ({ id: 'loc1', name: 'Test', path: '/photos' })),
      suppressIngest: jest.fn(),
      unsuppressIngest: jest.fn(),
      // Default: resolve to undefined; finalize tests override this per-case.
      ingestFile: jest.fn(),
    },
  };
}

function makeFileDTO(
  id: string,
  absolutePath = `/photos/${id}.jpg`,
  extension: FileDTO['extension'] = 'jpg',
): FileDTO {
  return {
    id,
    absolutePath,
    relativePath: `${id}.${extension}`,
    locationId: 'loc1',
    name: `${id}.${extension}`,
    size: 100,
    width: 640,
    height: 480,
    dateAdded: new Date(),
    dateModified: new Date(),
    dateCreated: new Date(),
    dateLastIndexed: new Date(),
    extension,
    ino: id,
    tags: [],
    annotations: '',
  };
}

async function makeFileStore(mockBackend: any, rootStore: any = makeMockRootStore()): Promise<any> {
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  return new FileStore(mockBackend, rootStore);
}

function baseBackend(overrides: any = {}): any {
  return {
    fetchFiles: jest.fn().mockResolvedValue([]),
    searchFiles: jest.fn().mockResolvedValue([]),
    countFiles: jest.fn().mockResolvedValue([0, 0]),
    fetchFilesByKey: jest.fn().mockResolvedValue([]),
    saveFiles: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ===========================================================================
// Requirement 1 (primary cause) — a same-mode background refetch must NOT exit
// SlideMode. Only a genuine view-mode CHANGE does.
// ===========================================================================

describe('INV-023 FileStore content-mode setters: disableSlideMode only on mode change', () => {
  it('does not disable SlideMode on a same-mode refetch, but does on a real mode change', async () => {
    const root = makeMockRootStore();
    root.uiStore.isSlideMode = true;
    const store = await makeFileStore(baseBackend(), root);

    // Default content is Content.All. Re-setting the SAME mode (what every background
    // refetch — including the folder watcher's debouncedRefetch when the output file
    // appears — does) must NOT tear the user out of SlideMode.
    store.setContentAll();
    expect(root.uiStore.disableSlideMode).not.toHaveBeenCalled();

    // A genuine mode change (All -> Query) is a user-driven view switch: it still exits.
    store.setContentQuery();
    expect(root.uiStore.disableSlideMode).toHaveBeenCalledTimes(1);

    // Re-fetching within Query mode (same mode) must NOT exit again.
    root.uiStore.disableSlideMode.mockClear();
    store.setContentQuery();
    expect(root.uiStore.disableSlideMode).not.toHaveBeenCalled();

    // Untagged and Duplicates follow the same rule.
    store.setContentUntagged();
    expect(root.uiStore.disableSlideMode).toHaveBeenCalledTimes(1);
    root.uiStore.disableSlideMode.mockClear();
    store.setContentUntagged();
    expect(root.uiStore.disableSlideMode).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Requirement 3 — the destination row carries the source's tags before it is shown.
// ===========================================================================

// ===========================================================================
// Requirement 2 — finalize tags the temp file, places it, ingests via the SINGLE deterministic
// path (locationStore.ingestFile), resolves the output ClientFile, and never disables SlideMode.
// The deterministic ingestion + watcher-suppression logic itself lives in LocationStore.ingestFile.
// ===========================================================================

describe('INV-026 FileStore.finalizeEncodedOutput', () => {
  beforeEach(() => {
    commitMediaJobMock.mockReset();
    commitMediaJobMock.mockResolvedValue({ outputPath: 'C:\\photos\\out.mp4' });
  });

  it('tags the temp file, suppresses+ingests via locationStore, and resolves the output', async () => {
    const outputDto = makeFileDTO('out', 'C:/photos/out.mp4', 'mp4');
    const backend = baseBackend({
      // refetch() in the default All mode calls fetchFiles; return the output so it lands in
      // fileList and finalize can resolve the grid instance.
      fetchFiles: jest.fn().mockResolvedValue([outputDto]),
    });
    const root = makeMockRootStore();
    root.uiStore.isSlideMode = true;
    root.locationStore.ingestFile.mockResolvedValue(outputDto);
    const store = await makeFileStore(backend, root);

    const source: any = {
      id: 'src',
      locationId: 'loc1',
      absolutePath: 'C:/photos/src.mp4',
      tags: new Set([{ id: 't1', path: ['Travel'] }]),
    };

    const result = await store.finalizeEncodedOutput(source, {
      jobId: 'test-job-id',
      tempPath: 'C:\\app-temp\\uuid.mp4',
      finalPath: 'C:\\photos\\out.mp4',
    });

    expect(result.id).toBe('out');
    expect(store.getIndex('out')).toBe(0);
    // The temp file was tagged once (EXIF) before placement.
    expect(root.exifTool.writeTags).toHaveBeenCalledWith('C:\\app-temp\\uuid.mp4', [['Travel']]);
    // The watcher was suppressed for finalPath across the place+ingest window, then released.
    expect(root.locationStore.suppressIngest).toHaveBeenCalledWith('C:\\photos\\out.mp4');
    expect(root.locationStore.unsuppressIngest).toHaveBeenCalledWith('C:\\photos\\out.mp4');
    // Ingestion went through the single deterministic path with the source's tag ids.
    expect(root.locationStore.ingestFile).toHaveBeenCalledWith('C:\\photos\\out.mp4', 'loc1', ['t1']);
    // Finalization never tears the viewer out of SlideMode.
    expect(root.uiStore.disableSlideMode).not.toHaveBeenCalled();
  });

  it('throws (loud), releases suppression, and keeps SlideMode when ingest fails', async () => {
    const backend = baseBackend();
    const root = makeMockRootStore();
    root.uiStore.isSlideMode = true;
    root.locationStore.ingestFile.mockRejectedValue(new Error('ingestFile: missing on disk'));
    const store = await makeFileStore(backend, root);
    const source: any = {
      id: 'src',
      locationId: 'loc1',
      absolutePath: 'C:/photos/src.mp4',
      tags: new Set(),
    };

    await expect(
      store.finalizeEncodedOutput(source, {
        jobId: 'test-job-id',
        tempPath: 'C:\\app-temp\\uuid.mp4',
        finalPath: 'C:\\photos\\out.mp4',
      }),
    ).rejects.toThrow(/ingest/i);
    // Even on failure the suppression is released (finally) and SlideMode is untouched.
    expect(root.locationStore.unsuppressIngest).toHaveBeenCalledWith('C:\\photos\\out.mp4');
    expect(root.uiStore.disableSlideMode).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ensureFileInListAt + dispose guard — the seamless-handoff plumbing.
// ===========================================================================

describe('INV-023 FileStore.ensureFileInListAt', () => {
  it('returns the existing index when present, and injects + indexes when absent', async () => {
    const backend = baseBackend({ fetchFiles: jest.fn().mockResolvedValue([makeFileDTO('a')]) });
    const store = await makeFileStore(backend);
    await store.fetchAllFiles(); // fileList = [a]

    const a = store.fileList[0];
    expect(store.ensureFileInListAt(a)).toBe(0); // already present -> existing index, no mutation
    expect(store.fileList.length).toBe(1);

    // A file not in the list is injected and indexed so the viewer can locate it.
    const outside: any = { id: 'out', absolutePath: 'C:/photos/out.mp4' };
    const idx = store.ensureFileInListAt(outside, 0);
    expect(idx).toBe(0);
    expect(store.fileList[0].id).toBe('out'); // injected at the requested position
    expect(store.getIndex('out')).toBe(0);
    expect(store.getIndex('a')).toBe(1); // index rebuilt for shifted entries
  });
});
