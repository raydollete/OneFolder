/**
 * INV-023 — Sub-process viewer-pin behaviour.
 *
 * These tests exercise the store-level mechanisms behind the three controlling
 * requirements for a long-running per-file sub-process (re-encode / normalize /
 * create clip):
 *
 *   1. The user cannot navigate away from the current video.
 *   2. The viewer switches seamlessly source -> destination.
 *   3. The destination already carries all of the source's tags.
 *
 * GUI integration on Windows is verified separately (TASK-096); this file proves
 * the underlying logic headlessly.
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
    mediaProcessingFile: null,
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

describe('INV-023 updateFromBackend dispose guard', () => {
  it('does not dispose the pinned media-processing file on a refetch that drops it', async () => {
    const backend = baseBackend({
      fetchFiles: jest
        .fn()
        .mockResolvedValueOnce([makeFileDTO('a')])
        .mockResolvedValueOnce([makeFileDTO('b')]),
    });
    const root = makeMockRootStore();
    const store = await makeFileStore(backend, root);

    await store.fetchAllFiles(); // fileList = [a]
    const a = store.fileList[0];
    const disposeSpy = jest.spyOn(a, 'dispose');

    // Pin 'a' as the file the viewer is watching, then refetch a list WITHOUT 'a'.
    root.uiStore.mediaProcessingFile = a;
    await store.fetchAllFiles(); // fileList = [b]; 'a' dropped from the list

    expect(store.getIndex('a')).toBeUndefined(); // no longer in the list
    expect(disposeSpy).not.toHaveBeenCalled(); // ...but NOT disposed: viewer still shows it
  });

  it('DOES dispose a dropped file when it is not the pinned file (control)', async () => {
    const backend = baseBackend({
      fetchFiles: jest
        .fn()
        .mockResolvedValueOnce([makeFileDTO('a')])
        .mockResolvedValueOnce([makeFileDTO('b')]),
    });
    const root = makeMockRootStore();
    const store = await makeFileStore(backend, root);

    await store.fetchAllFiles();
    const a = store.fileList[0];
    const disposeSpy = jest.spyOn(a, 'dispose');

    root.uiStore.mediaProcessingFile = null; // nothing pinned
    await store.fetchAllFiles();

    expect(disposeSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// UiStore — the identity pin, the seamless swap, and the navigation lock.
// ===========================================================================

// Use a class instance (like the real ClientFile) rather than a plain object: MobX's
// @observable deep-converts plain objects into proxies (breaking reference identity), but
// leaves non-plain class instances stored by reference — which is what the pin relies on.
class FakeFile {
  constructor(public id: string, public absolutePath: string) {}
}

async function makeUiStore(fileList: any[]): Promise<any> {
  const fileStore: any = {
    fileList,
    getIndex: (id: string) => {
      const i = fileList.findIndex((f) => f.id === id);
      return i === -1 ? undefined : i;
    },
    ensureFileInListAt: (file: any, preferredIndex?: number) => {
      const i = fileList.findIndex((f) => f.id === file.id);
      if (i !== -1) {
        return i;
      }
      const idx = Math.min(preferredIndex ?? fileList.length, fileList.length);
      fileList.splice(idx, 0, file);
      return idx;
    },
  };
  const { default: UiStore } = await import('../src/frontend/stores/UiStore');
  return new UiStore({ fileStore } as any);
}

describe('INV-023 UiStore media-processing pin + nav lock', () => {
  it('slideFile falls back to firstFileInView, but is the pin while a job runs', async () => {
    const a = new FakeFile('a', 'C:/p/a.mp4');
    const b = new FakeFile('b', 'C:/p/b.mp4');
    const ui = await makeUiStore([a, b]);

    ui.firstItem = 1;
    expect(ui.slideFile).toBe(b); // no pin -> firstFileInView

    ui.beginMediaProcessing(a);
    expect(ui.isMediaProcessing).toBe(true);
    expect(ui.mediaProcessing.path).toBe('C:/p/a.mp4');
    // Even though firstItem still points at b, the viewer is pinned to the source a.
    expect(ui.slideFile).toBe(a);
  });

  it('setMediaProcessingFile performs the seamless source -> output swap', async () => {
    const src = new FakeFile('src', 'C:/p/src.mp4');
    const out = new FakeFile('out', 'C:/p/out.mp4');
    const list = [src, out];
    const ui = await makeUiStore(list);

    ui.beginMediaProcessing(src);
    expect(ui.slideFile).toBe(src);
    ui.setMediaProcessingFile(out);
    expect(ui.slideFile).toBe(out); // swapped in place, no fallback to firstItem
  });

  it('disableSlideMode is a no-op while a job is active, then works after it ends', async () => {
    const src = new FakeFile('src', 'C:/p/src.mp4');
    const ui = await makeUiStore([src]);
    ui.isSlideMode = true;

    ui.beginMediaProcessing(src);
    ui.disableSlideMode(); // Back button / Escape / popstate all funnel here
    expect(ui.isSlideMode).toBe(true); // blocked — cannot leave the video mid-job

    ui.endMediaProcessing();
    ui.disableSlideMode();
    expect(ui.isSlideMode).toBe(false); // released after the job
  });

  it('endMediaProcessing reconciles firstItem to the pinned file and unpins (no blank frame)', async () => {
    const a = new FakeFile('a', 'C:/p/a.mp4');
    const out = new FakeFile('out', 'C:/p/out.mp4'); // not in the list yet
    const list = [a];
    const ui = await makeUiStore(list);

    ui.beginMediaProcessing(a);
    ui.setMediaProcessingFile(out); // output verified, swap the pin
    expect(ui.slideFile).toBe(out);

    ui.endMediaProcessing();

    expect(ui.isMediaProcessing).toBe(false);
    expect(ui.mediaProcessingFile).toBeNull(); // pin released
    // The output was injected and firstItem re-anchored to it, so after unpinning the
    // viewer still shows the output via firstFileInView — no flash of the grid.
    expect(list).toContain(out);
    expect(ui.firstItem).toBe(list.indexOf(out));
    expect(ui.slideFile).toBe(out);
  });

  it('showMediaJobError / closeMediaJobError drive the failure modal state', async () => {
    const ui = await makeUiStore([new FakeFile('a', 'C:/p/a.mp4')]);
    expect(ui.mediaJobError).toBeNull();
    ui.showMediaJobError('Re-encode', 'ffmpeg exited with code 1');
    expect(ui.mediaJobError).toEqual({ tool: 'Re-encode', message: 'ffmpeg exited with code 1' });
    ui.closeMediaJobError();
    expect(ui.mediaJobError).toBeNull();
  });
});

// ===========================================================================
// INTEGRATION — real FileStore + real UiStore wired into one rootStore, driving a
// REAL refetch() (real content-mode setter + real updateFromBackend that actually
// orphans firstItem) mid-job. This proves the two real stores interoperate so the
// viewer invariants the renderer depends on — `isSlideMode` stays true and
// `slideFile` stays the right ClientFile (never undefined) — hold through the exact
// folder-watcher churn that broke INV-021. The renderer (LayoutSwitcher gate +
// SlideView) is a thin observer over these two values, so if they hold, the rendered
// viewer provably stays mounted on the correct file.
// ===========================================================================

async function makeWiredStores(backend: any): Promise<{ fileStore: any; uiStore: any }> {
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  const { default: UiStore } = await import('../src/frontend/stores/UiStore');
  const rootStore: any = {
    tagStore: { tagList: [], get: jest.fn(() => undefined) },
    imageLoader: { needsThumbnail: jest.fn(() => false) },
    exifTool: { writeTags: jest.fn().mockResolvedValue(undefined) },
    locationStore: {
      get: jest.fn(() => ({ id: 'loc1', name: 'Test', path: '/photos' })),
      suppressIngest: jest.fn(),
      unsuppressIngest: jest.fn(),
      // Mimic the real LocationStore.ingestFile existing-row branch using the test backend:
      // find the row by path, set the source's tags, persist, return it.
      ingestFile: jest.fn(async (absolutePath: string, _locationId: string, tagIds: string[]) => {
        const fwd = absolutePath.replace(/\\/g, '/').toLowerCase();
        const rows = await backend.fetchFilesByKey('absolutePath', absolutePath.replace(/\\/g, '/'));
        const dto =
          rows.find((f: any) => f.absolutePath.replace(/\\/g, '/').toLowerCase() === fwd) ?? rows[0];
        if (!dto) {
          throw new Error(`ingestFile(test): no row for ${absolutePath}`);
        }
        dto.tags = tagIds;
        await backend.saveFiles([dto]);
        return dto;
      }),
    },
  };
  // FileStore must construct before UiStore exists (matches RootStore order); it must
  // not read rootStore.uiStore in its constructor.
  const fileStore = new FileStore(backend, rootStore);
  const uiStore = new UiStore(rootStore);
  uiStore.hideMissingFilesInBrowsing = false;
  rootStore.fileStore = fileStore;
  rootStore.uiStore = uiStore;
  return { fileStore, uiStore };
}

describe('INV-023 integration: real FileStore + real UiStore through a live refetch', () => {
  it('keeps the viewer pinned through a watcher refetch, then swaps source->output', async () => {
    const srcDto = makeFileDTO('src', 'C:/photos/src.mp4', 'mp4');
    const otherDto = makeFileDTO('other', 'C:/photos/other.mp4', 'mp4');
    const outDto = makeFileDTO('out', 'C:/photos/out.mp4', 'mp4');

    // `currentFiles` models what the backend returns at each phase. refetch() reads it live.
    let currentFiles: FileDTO[] = [srcDto, otherDto];
    const backend = baseBackend({
      fetchFiles: jest.fn().mockImplementation(() => Promise.resolve(currentFiles)),
      fetchFilesByKey: jest.fn().mockResolvedValue([outDto]),
    });

    const { fileStore, uiStore } = await makeWiredStores(backend);

    // Load the library and open the source in SlideMode.
    await fileStore.fetchAllFiles(); // fileList = [src, other], content = All
    uiStore.isSlideMode = true;
    uiStore.setFirstItem(0); // viewing src
    const pinnedSrc = fileStore.fileList[0];
    expect(pinnedSrc.id).toBe('src');

    // Start the sub-process: pin the source by identity.
    uiStore.beginMediaProcessing(pinnedSrc);
    expect(uiStore.slideFile.id).toBe('src');

    // --- The folder watcher detects the new output file and fires a refetch ---
    // Simulate it: the output appears AND the list reorders so the old firstItem (0) would point at
    // a DIFFERENT file ('out'). This is a REAL refetch: real setContentAll (same mode) + real
    // updateFromBackend, which now (a) does NOT disable SlideMode on a same-mode refetch and
    // (b) reconciles firstItem to the anchored file by identity.
    currentFiles = [outDto, otherDto, srcDto];
    await fileStore.refetch();

    // Both mechanisms hold the line: firstItem is re-anchored to the pinned source (now index 2),
    // and the pin shows the source regardless of list churn.
    expect(fileStore.fileList[0].id).toBe('out'); // list really did reorder
    expect(uiStore.firstItem).toBe(fileStore.getIndex('src')); // firstItem followed src by identity
    expect(uiStore.isSlideMode).toBe(true); // same-mode refetch did NOT disable SlideMode
    expect(uiStore.slideFile).toBe(pinnedSrc); // viewer still on the SOURCE by identity
    expect(uiStore.slideFile).not.toBeUndefined(); // never a blank/undefined frame

    // --- Finalize and swap to the output ---
    const output = await fileStore.finalizeEncodedOutput(pinnedSrc, {
      jobId: 'job',
      tempPath: 'C:\\tmp\\onefolder-media-jobs\\uuid.mp4',
      finalPath: 'C:\\photos\\out.mp4',
    });
    expect(output).not.toBeNull();
    expect(output.id).toBe('out');
    expect(uiStore.isSlideMode).toBe(true); // still in SlideMode throughout finalize

    uiStore.setMediaProcessingFile(output); // seamless swap
    expect(uiStore.slideFile.id).toBe('out');
    expect(uiStore.isSlideMode).toBe(true);

    // --- Release the lock: hand the pin back to firstItem cleanly ---
    uiStore.endMediaProcessing();
    expect(uiStore.isMediaProcessing).toBe(false);
    expect(uiStore.mediaProcessingFile).toBeNull();
    expect(uiStore.isSlideMode).toBe(true); // viewer stays open on the output
    expect(uiStore.slideFile.id).toBe('out'); // now via firstFileInView, no grid flash
    expect(fileStore.getIndex('out')).toBe(uiStore.firstItem);
  });

  it('keeps the SOURCE pinned and in SlideMode when a refetch would otherwise blank the viewer', async () => {
    const srcDto = makeFileDTO('src', 'C:/photos/src.mp4', 'mp4');

    let currentFiles: FileDTO[] = [srcDto, makeFileDTO('b'), makeFileDTO('c')];
    const backend = baseBackend({
      fetchFiles: jest.fn().mockImplementation(() => Promise.resolve(currentFiles)),
    });
    const { fileStore, uiStore } = await makeWiredStores(backend);

    await fileStore.fetchAllFiles();
    uiStore.isSlideMode = true;
    uiStore.setFirstItem(2); // viewing the last item
    const pinned = fileStore.fileList[2];
    uiStore.beginMediaProcessing(pinned);

    // Watcher refetch shrinks the list so the old firstItem (2) would be OUT OF RANGE — the
    // condition that made firstFileInView return undefined and unmounted SlideMode (INV-021).
    currentFiles = [srcDto];
    await fileStore.refetch();

    // The pinned file ('c') is gone from the new list, so firstItem is CLAMPED back into range
    // (never left pointing past the end), and the pin keeps the viewer on the correct file.
    expect(uiStore.firstItem).toBe(0); // clamped into range (was 2, list now length 1)
    expect(uiStore.firstFileInView?.id).toBe('src'); // raw anchor now points at an UNRELATED file...
    expect(uiStore.isSlideMode).toBe(true); // ...SlideMode stays up...
    expect(uiStore.slideFile).toBe(pinned); // ...and the pin still shows the correct file.
  });

  it('does NOT jump to an unrelated video on a trailing refetch AFTER the job ends (the reported bug)', async () => {
    // Reproduces the production report: after a re-encode, intermittently the viewer jumps to an
    // unrelated video while the "Delete original?" prompt is up. Cause: the folder watcher fires a
    // TRAILING refetch (the post-encode EXIF-write change event, ~2 s later) AFTER endMediaProcessing
    // has released the pin, and updateFromBackend used to leave firstItem at a now-stale index.
    const srcDto = makeFileDTO('src', 'C:/photos/src.mp4', 'mp4');
    const aDto = makeFileDTO('a', 'C:/photos/a.mp4', 'mp4');
    const outDto = makeFileDTO('out', 'C:/photos/out.mp4', 'mp4');

    let currentFiles: FileDTO[] = [srcDto, aDto];
    const backend = baseBackend({
      fetchFiles: jest.fn().mockImplementation(() => Promise.resolve(currentFiles)),
      fetchFilesByKey: jest.fn().mockResolvedValue([outDto]),
    });
    const { fileStore, uiStore } = await makeWiredStores(backend);

    await fileStore.fetchAllFiles(); // [src, a]
    uiStore.isSlideMode = true;
    uiStore.setFirstItem(0); // viewing src
    const src = fileStore.fileList[0];

    // Run the job to completion: pin source, finalize to output, swap, open prompt, release pin.
    uiStore.beginMediaProcessing(src);
    currentFiles = [outDto, srcDto, aDto]; // output ingested, now in the list
    const output = await fileStore.finalizeEncodedOutput(src, {
      jobId: 'job',
      tempPath: 'C:\\tmp\\onefolder-media-jobs\\uuid.mp4',
      finalPath: 'C:\\photos\\out.mp4',
    });
    uiStore.setMediaProcessingFile(output);
    uiStore.openDeleteOriginalPrompt(src, output);
    uiStore.endMediaProcessing(); // pin released; firstItem anchored to the output

    expect(uiStore.mediaProcessingFile).toBeNull(); // NOT pinned anymore — back on the raw anchor
    expect(uiStore.slideFile?.id).toBe('out');
    expect(uiStore.firstItem).toBe(fileStore.getIndex('out'));

    // --- The TRAILING watcher refetch (post-encode EXIF-write change event), pin already released ---
    // The list re-sorts (the output's dateModified changed), moving the output to a different index
    // and putting an UNRELATED file ('a') at the output's OLD index.
    currentFiles = [aDto, srcDto, outDto]; // 'out' moves 0 -> 2; 'a' now sits at the old index 0
    await fileStore.refetch();

    // Without the firstItem-by-identity reconciliation, firstItem would still be 0 and the viewer
    // would show 'a' (the reported bug). With it, firstItem follows the output.
    expect(uiStore.slideFile?.id).toBe('out'); // STILL on the output, NOT the unrelated 'a'
    expect(uiStore.firstItem).toBe(fileStore.getIndex('out'));
    expect(uiStore.isSlideMode).toBe(true);
    expect(uiStore.deleteOriginalAfterJobFile).toBe(src); // delete prompt still for the source
  });
});
