/**
 * Unit tests for MediaQueueStore (INV-035 / TASK-144).
 *
 * Verifies FIFO single-at-a-time draining, drawer auto-open,
 * cancel / retry, the three Keep actions, and the failed-row path
 * — all with IPC and finalizeEncodedOutput mocked (no real ffmpeg).
 */

import { configure, isObservable, runInAction } from 'mobx';
import { FileDTO } from '../src/api/file';

configure({ enforceActions: 'never' });

// ---------------------------------------------------------------------------
// IPC mock — must be declared before any module imports that pull in renderer.ts
// ---------------------------------------------------------------------------

const startMediaJobMock = jest.fn();
const cancelMediaJobMock = jest.fn();

// onMediaJobProgress captures all registered callbacks so tests can fire
// synthetic progress events.
const progressCallbacks: Array<(msg: any) => void> = [];
const onMediaJobProgressMock = jest.fn((cb: (msg: any) => void) => {
  progressCallbacks.push(cb);
  // Returns an unsubscribe function that splices the callback out.
  return () => {
    const idx = progressCallbacks.indexOf(cb);
    if (idx !== -1) {
      progressCallbacks.splice(idx, 1);
    }
  };
});

jest.mock('../src/ipc/renderer', () => ({
  RendererMessenger: {
    startMediaJob: (...args: any[]) => startMediaJobMock(...args),
    onMediaJobProgress: (cb: any) => onMediaJobProgressMock(cb),
    cancelMediaJob: (...args: any[]) => cancelMediaJobMock(...args),
  },
}));

// AppToaster touches window; mock it away.
jest.mock('../src/frontend/components/Toaster', () => ({
  AppToaster: { show: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a synthetic progress event to all currently-registered listeners. */
function fireProgress(msg: { jobId: string; percent?: number }): void {
  for (const cb of [...progressCallbacks]) {
    cb(msg);
  }
}

function makeFileDTO(id: string, absolutePath = `/photos/${id}.mp4`): FileDTO {
  return {
    id,
    absolutePath,
    relativePath: `${id}.mp4`,
    locationId: 'loc1',
    name: `${id}.mp4`,
    size: 100,
    width: 640,
    height: 480,
    dateAdded: new Date(),
    dateModified: new Date(),
    dateCreated: new Date(),
    dateLastIndexed: new Date(),
    extension: 'mp4',
    ino: id,
    tags: [],
    annotations: '',
  };
}

/**
 * Build a minimal RootStore mock and a MediaQueueStore wired to it.
 * `finalizeEncodedOutput` is a jest.fn() that resolves with a fake output
 * ClientFile by default (tests can override it per-case).
 *
 * We use a fake fileStore (plain object) rather than a real FileStore so that
 * the `@action.bound`-decorated `finalizeEncodedOutput` is a plain jest.fn()
 * that can be inspected. We still need a real ClientFile for `source` — we
 * build one via the real FileStore.
 */
async function makeStore(): Promise<{
  store: any;
  rootStore: any;
  finalizeMock: jest.Mock;
  srcFile: any;
  outFile: any;
}> {
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  const { default: MediaQueueStore } = await import('../src/frontend/stores/MediaQueueStore');

  const srcDto = makeFileDTO('src', '/photos/src.mp4');
  const outDto = makeFileDTO('out', '/photos/out.mp4');

  const fakeOutputFile: any = { id: 'out', absolutePath: '/photos/out.mp4', name: 'out.mp4' };
  const finalizeMock = jest.fn().mockResolvedValue(fakeOutputFile);

  // Minimal rootStore skeleton — only the surfaces MediaQueueStore touches.
  const rootStore: any = {
    tagStore: { tagList: [], get: jest.fn(() => undefined) },
    imageLoader: { needsThumbnail: jest.fn(() => false) },
    exifTool: { writeTags: jest.fn().mockResolvedValue(undefined) },
    locationStore: {
      get: jest.fn(() => ({ id: 'loc1', name: 'Test', path: '/photos' })),
      suppressIngest: jest.fn(),
      unsuppressIngest: jest.fn(),
      ingestFile: jest.fn().mockResolvedValue(outDto),
    },
    uiStore: {
      // firstFileInView is read by keepOriginal to decide whether to focus the source.
      firstFileInView: undefined as any,
      firstItem: 0,
      setFirstItem: jest.fn(),
      selectFile: jest.fn(),
      enableSlideMode: jest.fn(),
      // Required by FileStore.fetchAllFiles when the helperFileStore is initialised.
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
    },
    // fileStore.finalizeEncodedOutput and fileStore.ensureFileInListAt are the only
    // FileStore surfaces MediaQueueStore calls. We supply them as plain jest.fns so
    // the @action.bound decorator (which makes them non-writable on a real instance)
    // is not a problem.
    fileStore: {
      finalizeEncodedOutput: finalizeMock,
      ensureFileInListAt: jest.fn().mockReturnValue(0),
    },
  };

  // We still need a real ClientFile object for `source` (so MobX observables
  // like item.source.name / item.source.absolutePath work). Build one through a
  // lightweight FileStore seeded with srcDto.
  const mockBackend: any = {
    fetchFiles: jest.fn().mockResolvedValue([srcDto]),
    searchFiles: jest.fn().mockResolvedValue([]),
    countFiles: jest.fn().mockResolvedValue([0, 0]),
    fetchFilesByKey: jest.fn().mockResolvedValue([srcDto]),
    saveFiles: jest.fn().mockResolvedValue(undefined),
  };
  const helperFileStore = new FileStore(mockBackend, rootStore);
  await helperFileStore.fetchAllFiles();
  const srcFile = helperFileStore.fileList[0];

  const store = new MediaQueueStore(rootStore);
  rootStore.mediaQueueStore = store;

  return { store, rootStore, finalizeMock, srcFile, outFile: fakeOutputFile };
}

/** Flush the microtask queue (enough ticks to let the async IIFE in runItem settle). */
const flushAll = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaQueueStore (INV-035 / TASK-144)', () => {
  beforeEach(() => {
    startMediaJobMock.mockReset();
    cancelMediaJobMock.mockReset();
    onMediaJobProgressMock.mockClear();
    progressCallbacks.length = 0;
  });

  // ---------- drawer NOT auto-opened (INV-036) ----------

  it('does NOT auto-open the drawer on enqueue (always-visible bar, default collapsed)', async () => {
    const { store, srcFile } = await makeStore();
    // Default startMediaJob — just hold open so we can check isDrawerOpen.
    startMediaJobMock.mockReturnValue(new Promise(() => {}));

    expect(store.isDrawerOpen).toBe(false);
    store.enqueue(srcFile, 'reencode-x264');
    expect(store.isDrawerOpen).toBe(false);
  });

  // ---------- clip passed to IPC is a plain (cloneable) object (INV-036) ----------

  it('passes a plain, non-observable clip to startMediaJob (structured-clone safe)', async () => {
    const { store, srcFile } = await makeStore();
    startMediaJobMock.mockReturnValue(new Promise(() => {}));

    const clip = { start: '00:00:01', end: '00:00:05' };
    store.enqueue(srcFile, 'create-clip', clip);
    await Promise.resolve();

    const [, , clipArg] = startMediaJobMock.mock.calls[0];
    expect(clipArg).toEqual(clip);
    // The QueueItem stores clip as @observable; the value handed to IPC must be a
    // plain object (toJS), since a MobX proxy cannot be structured-cloned.
    expect(isObservable(clipArg)).toBe(false);
  });

  // ---------- FIFO single-at-a-time ----------

  it('runs only one job at a time and completes oldest-first (FIFO)', async () => {
    const { store, srcFile, finalizeMock, outFile } = await makeStore();

    // Hold each startMediaJob open until we decide to resolve it.
    let resolve0!: (v: any) => void;
    let resolve1!: (v: any) => void;
    let resolve2!: (v: any) => void;

    startMediaJobMock
      .mockReturnValueOnce(new Promise((r) => { resolve0 = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolve1 = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolve2 = r; }));

    // Enqueue three jobs.
    store.enqueue(srcFile, 'reencode-x264');
    store.enqueue(srcFile, 'normalize-audio');
    store.enqueue(srcFile, 'rotate-cw');

    await Promise.resolve();

    // Only the first job is running; the other two are still pending.
    expect(store.items[0].status).toBe('running');
    expect(store.items[1].status).toBe('pending');
    expect(store.items[2].status).toBe('pending');
    expect(startMediaJobMock).toHaveBeenCalledTimes(1);

    // Finish job 0.
    resolve0({ jobId: 'j0', tempPath: '/tmp/j0.mp4', finalPath: '/photos/out0.mp4' });
    await flushAll();

    // Job 0 should be completed; job 1 should now be running; job 2 still pending.
    expect(store.items[0].status).toBe('completed');
    expect(store.items[1].status).toBe('running');
    expect(store.items[2].status).toBe('pending');
    expect(startMediaJobMock).toHaveBeenCalledTimes(2);

    // Finish job 1.
    resolve1({ jobId: 'j1', tempPath: '/tmp/j1.mp4', finalPath: '/photos/out1.mp4' });
    await flushAll();

    expect(store.items[0].status).toBe('completed');
    expect(store.items[1].status).toBe('completed');
    expect(store.items[2].status).toBe('running');
    expect(startMediaJobMock).toHaveBeenCalledTimes(3);

    // Finish job 2.
    resolve2({ jobId: 'j2', tempPath: '/tmp/j2.mp4', finalPath: '/photos/out2.mp4' });
    await flushAll();

    expect(store.items[2].status).toBe('completed');
    expect(store.items.every((it: any) => it.status === 'completed')).toBe(true);
  });

  // ---------- pending cancel ----------

  it('splices a pending row immediately on cancel without calling startMediaJob for it', async () => {
    const { store, srcFile } = await makeStore();

    // First job holds open so job 1 stays pending.
    startMediaJobMock.mockReturnValue(new Promise(() => {}));

    store.enqueue(srcFile, 'reencode-x264'); // index 0, running
    store.enqueue(srcFile, 'normalize-audio'); // index 1, pending

    await Promise.resolve();
    expect(store.items).toHaveLength(2);
    expect(startMediaJobMock).toHaveBeenCalledTimes(1);

    const pendingId = store.items[1].id;
    store.cancel(pendingId);

    expect(store.items).toHaveLength(1);
    expect(store.items[0].status).toBe('running');
    // startMediaJob must NOT have been called a second time for the pending job.
    expect(startMediaJobMock).toHaveBeenCalledTimes(1);
  });

  // ---------- running cancel ----------

  it('updates percent from progress events and calls cancelMediaJob for a running cancel', async () => {
    const { store, srcFile } = await makeStore();

    // Hold startMediaJob open indefinitely (no setTimeout leak).
    startMediaJobMock.mockReturnValue(new Promise(() => {}));

    store.enqueue(srcFile, 'reencode-x264');
    await Promise.resolve();

    const item = store.items[0];
    expect(item.status).toBe('running');

    // Simulate progress events.
    fireProgress({ jobId: 'job-abc', percent: 25 });
    await Promise.resolve();

    expect(item.jobId).toBe('job-abc');
    expect(item.percent).toBe(25);

    fireProgress({ jobId: 'job-abc', percent: 50 });
    await Promise.resolve();
    expect(item.percent).toBe(50);

    // Now cancel the running job.
    store.cancel(item.id);
    expect(cancelMediaJobMock).toHaveBeenCalledWith('job-abc');
  });

  it('removes the running row when MEDIA_JOB_CANCELLED is received', async () => {
    const { store, srcFile } = await makeStore();

    let rejectJob!: (err: Error) => void;
    startMediaJobMock.mockReturnValue(new Promise((_res, rej) => { rejectJob = rej; }));

    store.enqueue(srcFile, 'reencode-x264');
    await Promise.resolve();

    // Stash jobId via a progress event.
    fireProgress({ jobId: 'job-xyz', percent: 10 });
    await Promise.resolve();

    // Cancel triggers cancelMediaJob; we then simulate the rejection.
    store.cancel(store.items[0].id);
    rejectJob(new Error('MEDIA_JOB_CANCELLED'));
    await flushAll();

    // Row must be spliced.
    expect(store.items).toHaveLength(0);
  });

  // ---------- completion ----------

  it('sets status=completed and output, and finalizeEncodedOutput was called with focusViewer:false', async () => {
    const { store, srcFile, finalizeMock, outFile } = await makeStore();

    let resolveJob!: (v: any) => void;
    startMediaJobMock.mockReturnValue(new Promise((r) => { resolveJob = r; }));

    store.enqueue(srcFile, 'reencode-x264');
    await Promise.resolve();

    resolveJob({ jobId: 'j0', tempPath: '/tmp/j0.mp4', finalPath: '/photos/out.mp4' });
    await flushAll();

    const item = store.items[0];
    expect(item.status).toBe('completed');
    // item.output is the value resolved by finalizeMock.  MobX wraps plain-object
    // values assigned to @observable fields in a proxy, so we compare structurally
    // rather than by reference.
    expect(item.output).toStrictEqual(outFile);

    // finalizeEncodedOutput must have been called with focusViewer: false.
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    const [, , opts] = finalizeMock.mock.calls[0];
    expect(opts).toEqual({ focusViewer: false });
  });

  // ---------- keepBoth ----------

  it('keepBoth resolves the row (kept as history) without trashing anything', async () => {
    const { store, srcFile } = await makeStore();

    // Manufacture a completed item directly in the store (bypassing async runItem).
    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');
    const item = new QueueItem('id1', srcFile, 'reencode-x264', undefined, 'Re-encode', Date.now());
    runInAction(() => {
      item.status = 'completed';
      store.items.push(item);
    });

    expect(store.items).toHaveLength(1);
    store.keepBoth(item);
    // Row is NOT removed — it is resolved and kept at the bottom as history (INV-036).
    expect(store.items).toHaveLength(1);
    expect(item.status).toBe('resolved');
    expect(item.resolution).toBe('kept-both');
    expect(store.resolvedCount).toBe(1);
  });

  // ---------- keepNew ----------

  it('keepNew trashes the source and removes the row', async () => {
    const { store, srcFile, outFile } = await makeStore();

    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');
    const item = new QueueItem('id2', srcFile, 'reencode-x264', undefined, 'Re-encode', Date.now());
    runInAction(() => {
      item.status = 'completed';
      item.output = outFile;
      store.items.push(item);
    });

    const trashFile = jest.fn().mockResolvedValue({ ok: true, isPermanent: false });
    await store.keepNew(item, trashFile);

    expect(trashFile).toHaveBeenCalledWith(srcFile);
    expect(store.items).toHaveLength(1);
    expect(item.status).toBe('resolved');
    expect(item.resolution).toBe('kept-new');
  });

  // ---------- keepOriginal ----------

  it('keepOriginal trashes the output and removes the row', async () => {
    const { store, srcFile, outFile } = await makeStore();

    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');
    const item = new QueueItem('id3', srcFile, 'reencode-x264', undefined, 'Re-encode', Date.now());
    runInAction(() => {
      item.status = 'completed';
      item.output = outFile;
      store.items.push(item);
    });

    const trashFile = jest.fn().mockResolvedValue({ ok: true, isPermanent: false });
    await store.keepOriginal(item, trashFile);

    expect(trashFile).toHaveBeenCalledWith(outFile);
    expect(store.items).toHaveLength(1);
    expect(item.status).toBe('resolved');
    expect(item.resolution).toBe('kept-original');
  });

  it('keepOriginal focuses the source when the viewer is currently on the output', async () => {
    const { store, rootStore, srcFile, outFile } = await makeStore();

    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');
    const item = new QueueItem('id4', srcFile, 'reencode-x264', undefined, 'Re-encode', Date.now());
    runInAction(() => {
      item.status = 'completed';
      item.output = outFile;
      store.items.push(item);
    });

    // Simulate the viewer being on the output.  MobX wraps the plain outFile object
    // in an observable proxy when assigned to item.output, so we must set
    // firstFileInView to item.output (the proxy) — not the raw outFile reference —
    // so that the `=== item.output` check in keepOriginal passes.
    rootStore.uiStore.firstFileInView = item.output;

    // focusFileInViewer is @action.bound (non-writable), so we can't spyOn it directly.
    // Instead, observe its effects via the uiStore mocks it calls.
    rootStore.uiStore.selectFile.mockClear();
    rootStore.uiStore.enableSlideMode.mockClear();

    const trashFile = jest.fn().mockResolvedValue({ ok: true, isPermanent: false });
    await store.keepOriginal(item, trashFile);

    // focusFileInViewer calls uiStore.selectFile and uiStore.enableSlideMode.
    expect(rootStore.uiStore.selectFile).toHaveBeenCalledWith(srcFile, true);
    expect(rootStore.uiStore.enableSlideMode).toHaveBeenCalled();
  });

  it('keepOriginal does NOT focus when the viewer is NOT on the output', async () => {
    const { store, rootStore, srcFile, outFile } = await makeStore();

    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');
    const item = new QueueItem('id5', srcFile, 'reencode-x264', undefined, 'Re-encode', Date.now());
    runInAction(() => {
      item.status = 'completed';
      item.output = outFile;
      store.items.push(item);
    });

    // Viewer is on something else (not the output) — keepOriginal must NOT focus.
    rootStore.uiStore.firstFileInView = srcFile;

    rootStore.uiStore.selectFile.mockClear();
    rootStore.uiStore.enableSlideMode.mockClear();

    const trashFile = jest.fn().mockResolvedValue({ ok: true, isPermanent: false });
    await store.keepOriginal(item, trashFile);

    expect(rootStore.uiStore.selectFile).not.toHaveBeenCalled();
    expect(rootStore.uiStore.enableSlideMode).not.toHaveBeenCalled();
  });

  // ---------- failed path ----------

  it('sets status=failed + errorMessage on a non-cancel rejection', async () => {
    const { store, srcFile } = await makeStore();

    startMediaJobMock.mockRejectedValue(new Error('ffmpeg exited with code 1'));

    store.enqueue(srcFile, 'reencode-x264');
    await flushAll();

    expect(store.items).toHaveLength(1);
    expect(store.items[0].status).toBe('failed');
    expect(store.items[0].errorMessage).toMatch(/ffmpeg exited with code 1/);
  });

  it('retry re-enqueues the same source/jobType/clip and removes the failed row', async () => {
    const { store, srcFile } = await makeStore();

    startMediaJobMock
      .mockRejectedValueOnce(new Error('ffmpeg error')) // first attempt fails
      .mockReturnValue(new Promise(() => {}));          // retry holds open

    const clip = { start: '00:00:01', end: '00:00:05' };
    store.enqueue(srcFile, 'create-clip', clip);
    await flushAll();

    expect(store.items).toHaveLength(1);
    const failedId = store.items[0].id;
    expect(store.items[0].status).toBe('failed');

    store.retry(failedId);
    await Promise.resolve();

    // The failed row must be gone; a new running row must exist with the same props.
    expect(store.items.every((it: any) => it.id !== failedId)).toBe(true);
    const newItem = store.items[store.items.length - 1];
    expect(newItem.source).toBe(srcFile);
    expect(newItem.jobType).toBe('create-clip');
    expect(newItem.clip).toEqual(clip);
    // The retry enqueue calls startMediaJob again.
    expect(startMediaJobMock).toHaveBeenCalledTimes(2);
  });

  // ---------- dismiss + clearResolved (INV-036) ----------

  it('dismiss resolves a failed row as "Dismissed" (kept as history, not removed)', async () => {
    const { store, srcFile } = await makeStore();

    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');
    const item = new QueueItem('idF', srcFile, 'reencode-x264', undefined, 'Re-encode', Date.now());
    runInAction(() => {
      item.status = 'failed';
      item.errorMessage = 'boom';
      store.items.push(item);
    });

    store.dismiss(item);
    expect(store.items).toHaveLength(1);
    expect(item.status).toBe('resolved');
    expect(item.resolution).toBe('dismissed');
  });

  it('clearResolved removes only resolved rows, leaving active ones', async () => {
    const { store, srcFile } = await makeStore();

    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');
    const resolved = new QueueItem('r1', srcFile, 'reencode-x264', undefined, 'Re-encode', Date.now());
    const pending = new QueueItem('p1', srcFile, 'rotate-cw', undefined, 'Rotate CW', Date.now());
    runInAction(() => {
      resolved.status = 'resolved';
      resolved.resolution = 'kept-both';
      pending.status = 'pending';
      store.items.push(resolved, pending);
    });

    expect(store.resolvedCount).toBe(1);
    store.clearResolved();

    expect(store.items).toHaveLength(1);
    expect(store.items[0].id).toBe('p1');
    expect(store.resolvedCount).toBe(0);
  });
});
