/**
 * Unit tests for MediaQueueStore (INV-035 / TASK-144; stall/cancel INV-038 / TASK-156).
 *
 * Verifies FIFO single-at-a-time draining, drawer auto-open,
 * cancel / retry, the three Keep actions, and the failed-row path
 * — all with IPC and finalizeEncodedOutput mocked (no real ffmpeg).
 *
 * INV-038 / TASK-156 additions: stall watchdog, watchdog-reset-on-progress,
 * forcible-cancel-frees-queue, and idempotent-settle tests use jest fake timers.
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

/**
 * Fire a synthetic progress event to all currently-registered listeners.
 * `outTimeSec` is the primary liveness signal for the stall watchdog (INV-038);
 * `percent` is the fallback when `outTimeSec` is absent.
 */
function fireProgress(msg: { jobId: string; percent?: number; outTimeSec?: number }): void {
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
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve0 = r;
        }),
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve1 = r;
        }),
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve2 = r;
        }),
      );

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

  it('cancelling a running row splices it immediately and advances the queue (forcible cancel, INV-038)', async () => {
    // Previously: cancel waited for MEDIA_JOB_CANCELLED rejection.
    // Now: cancel splices immediately; late rejection is a harmless no-op.
    const { store, srcFile } = await makeStore();

    let rejectJob!: (err: Error) => void;
    startMediaJobMock
      .mockReturnValueOnce(
        new Promise((_res, rej) => {
          rejectJob = rej;
        }),
      )
      .mockReturnValue(new Promise(() => {})); // second job holds open

    store.enqueue(srcFile, 'reencode-x264'); // item0
    store.enqueue(srcFile, 'normalize-audio'); // item1
    await Promise.resolve();

    // item0 running, item1 pending.
    expect(store.items[0].status).toBe('running');
    expect(store.items[1].status).toBe('pending');

    // Stash jobId via a progress event.
    fireProgress({ jobId: 'job-xyz', percent: 10 });
    await Promise.resolve();

    const item0Id = store.items[0].id;
    store.cancel(item0Id);

    // Immediately after cancel (no rejection needed): item0 is gone, item1 is running.
    expect(store.items).toHaveLength(1);
    expect(store.items[0].status).toBe('running'); // item1 advanced
    expect(cancelMediaJobMock).toHaveBeenCalledWith('job-xyz');

    // Late MEDIA_JOB_CANCELLED rejection arrives — must be a harmless no-op.
    rejectJob(new Error('MEDIA_JOB_CANCELLED'));
    await flushAll();

    // List unchanged: still exactly 1 item, still running.
    expect(store.items).toHaveLength(1);
    expect(store.items[0].status).toBe('running');
    // startMediaJob called twice: once for item0, once for item1 (processNext fired).
    expect(startMediaJobMock).toHaveBeenCalledTimes(2);
  });

  // ---------- completion ----------

  it('sets status=completed and output, and finalizeEncodedOutput was called with focusViewer:false', async () => {
    const { store, srcFile, finalizeMock, outFile } = await makeStore();

    let resolveJob!: (v: any) => void;
    startMediaJobMock.mockReturnValue(
      new Promise((r) => {
        resolveJob = r;
      }),
    );

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
      .mockReturnValue(new Promise(() => {})); // retry holds open

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

  // ---------- seen-counts / unseen-badge (INV-037) ----------

  it('unseenCounts are all false and seenCounts all zero initially', async () => {
    const { store } = await makeStore();

    expect(store.seenCounts).toEqual({ queued: 0, processing: 0, done: 0, resolved: 0 });
    expect(store.unseenCounts).toEqual({
      queued: false,
      processing: false,
      done: false,
      resolved: false,
    });
    expect(store.hasUnseen).toBe(false);
  });

  it('unseenCounts stay all-false while the drawer is open even as counts change', async () => {
    const { store, srcFile } = await makeStore();
    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');

    // Open the drawer — seenCounts should track liveCounts via the reaction.
    store.isDrawerOpen = true;

    // Enqueue a pending item so pendingCount rises to 1.
    const item = new QueueItem(
      'seen1',
      srcFile,
      'reencode-x264',
      undefined,
      'Re-encode',
      Date.now(),
    );
    runInAction(() => {
      item.status = 'pending';
      store.items.push(item);
    });

    // While open the reaction fires synchronously on the next tick; call markSeen
    // explicitly (the drawer's toggle handler does this too — belt-and-suspenders).
    store.markSeen();

    // seenCounts must now reflect the live counts and unseenCounts must be all-false.
    expect(store.seenCounts.queued).toBe(store.liveCounts.queued);
    expect(store.unseenCounts).toEqual({
      queued: false,
      processing: false,
      done: false,
      resolved: false,
    });
    expect(store.hasUnseen).toBe(false);
  });

  it('unseenCounts.done becomes true after the drawer is closed and completedCount rises', async () => {
    const { store, srcFile } = await makeStore();
    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');

    // Open, sync the snapshot, then close.
    store.isDrawerOpen = true;
    store.markSeen();
    store.isDrawerOpen = false;

    // Add a completed item while collapsed → completedCount rises.
    const item = new QueueItem(
      'seen2',
      srcFile,
      'reencode-x264',
      undefined,
      'Re-encode',
      Date.now(),
    );
    runInAction(() => {
      item.status = 'completed';
      store.items.push(item);
    });

    expect(store.unseenCounts.done).toBe(true);
    expect(store.unseenCounts.queued).toBe(false);
    expect(store.unseenCounts.processing).toBe(false);
    expect(store.unseenCounts.resolved).toBe(false);
    expect(store.hasUnseen).toBe(true);
  });

  it('reopening the drawer (markSeen) clears all unseenCounts flags', async () => {
    const { store, srcFile } = await makeStore();
    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');

    // Close, cause an unseen change, then reopen.
    store.isDrawerOpen = false;
    const item = new QueueItem(
      'seen3',
      srcFile,
      'reencode-x264',
      undefined,
      'Re-encode',
      Date.now(),
    );
    runInAction(() => {
      item.status = 'completed';
      store.items.push(item);
    });

    expect(store.hasUnseen).toBe(true);

    // Simulate opening the drawer (calls markSeen as the toggle handler does).
    store.isDrawerOpen = true;
    store.markSeen();

    expect(store.unseenCounts).toEqual({
      queued: false,
      processing: false,
      done: false,
      resolved: false,
    });
    expect(store.hasUnseen).toBe(false);
  });

  it('clearResolved removes only resolved rows, leaving active ones', async () => {
    const { store, srcFile } = await makeStore();

    const { QueueItem } = await import('../src/frontend/stores/MediaQueueStore');
    const resolved = new QueueItem(
      'r1',
      srcFile,
      'reencode-x264',
      undefined,
      'Re-encode',
      Date.now(),
    );
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

// ---------------------------------------------------------------------------
// Stall watchdog + idempotent settle tests (INV-038 / TASK-156)
// These use jest fake timers — real timers are restored in afterEach.
// ---------------------------------------------------------------------------

describe('MediaQueueStore stall watchdog + forcible cancel (INV-038 / TASK-156)', () => {
  // Store and srcFile are built BEFORE fake timers are enabled so that makeStore()'s
  // async helper work (FileStore.fetchAllFiles, setTimeout(r,0) in flushAll) runs with
  // real timers and does not hang.  Each test then enables fake timers for the
  // timer-driven portion of the test and restores them in afterEach.
  let store: any;
  let srcFile: any;

  beforeEach(async () => {
    startMediaJobMock.mockReset();
    cancelMediaJobMock.mockReset();
    onMediaJobProgressMock.mockClear();
    progressCallbacks.length = 0;
    // Build the store with real timers so async module imports and FileStore.fetchAllFiles work.
    ({ store, srcFile } = await makeStore());
    // Enable fake timers AFTER the store is ready.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Flush helper that works under fake timers: only microtask-queue flushes (Promise.resolve),
  // no real setTimeout. Use after advancing timers to let runInAction settle.
  const flushMicrotasks = async () => {
    for (let i = 0; i < 15; i++) {
      await Promise.resolve();
    }
  };

  // ---------- stall watchdog fires after 60s of no outTimeSec progress ----------

  it('stall watchdog: auto-fails the item after 60s of no outTimeSec progress, calls cancelMediaJob, and starts next job (INV-038)', async () => {
    // item0 holds open; item1 is a second pending job.
    startMediaJobMock
      .mockReturnValueOnce(new Promise(() => {})) // item0 — never resolves
      .mockReturnValue(new Promise(() => {})); // item1

    store.enqueue(srcFile, 'reencode-x264'); // item0
    store.enqueue(srcFile, 'normalize-audio'); // item1
    await flushMicrotasks();

    expect(store.items[0].status).toBe('running');
    expect(store.items[1].status).toBe('pending');

    // Fire one progress event with an outTimeSec value to stash the jobId and re-arm the timer.
    fireProgress({ jobId: 'stall-job', percent: 10, outTimeSec: 1.0 });
    await flushMicrotasks();

    expect(store.items[0].jobId).toBe('stall-job');
    expect(store.items[0].percent).toBe(10);

    // Advance 60s without any further outTimeSec advance — watchdog fires.
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks(); // let the settle() runInAction flush

    // item0 must be failed with a stall message.
    expect(store.items[0].status).toBe('failed');
    expect(store.items[0].errorMessage).toMatch(/stalled/i);
    expect(store.items[0].errorMessage).toContain('10%');

    // cancelMediaJob was called for the wedged job.
    expect(cancelMediaJobMock).toHaveBeenCalledWith('stall-job');

    // processNext ran: item1 is now running.
    expect(store.items[1].status).toBe('running');
    expect(startMediaJobMock).toHaveBeenCalledTimes(2);
  });

  // ---------- watchdog resets on outTimeSec advance ----------

  it('watchdog does NOT fire while outTimeSec keeps advancing (a healthy long encode)', async () => {
    startMediaJobMock.mockReturnValue(new Promise(() => {}));

    store.enqueue(srcFile, 'reencode-x264');
    await flushMicrotasks();

    const item = store.items[0];
    expect(item.status).toBe('running');

    // Simulate steady forward progress: advance outTimeSec each time before 60s elapses.
    // Three iterations at 59s gaps = 177s total, far past a single 60s window.
    let outTime = 0.0;
    for (let i = 0; i < 3; i++) {
      outTime += 1.0;
      fireProgress({ jobId: 'healthy-job', percent: 10 + i, outTimeSec: outTime });
      await flushMicrotasks();
      jest.advanceTimersByTime(59_000); // 59s gap — watchdog re-armed before it fires
      await flushMicrotasks();
    }

    // Job must still be running — watchdog never fired.
    expect(item.status).toBe('running');

    // Now stop advancing and wait the full 60s — watchdog fires.
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();

    expect(item.status).toBe('failed');
    expect(item.errorMessage).toMatch(/stalled/i);
  });

  // ---------- percent-fallback liveness (no outTimeSec in message) ----------

  it('watchdog resets on integer percent change when outTimeSec is absent (fallback path)', async () => {
    startMediaJobMock.mockReturnValue(new Promise(() => {}));

    store.enqueue(srcFile, 'reencode-x264');
    await flushMicrotasks();

    const item = store.items[0];

    // Progress events with no outTimeSec field — watchdog should still re-arm on percent change.
    fireProgress({ jobId: 'pct-job', percent: 10 }); // no outTimeSec
    await flushMicrotasks();
    jest.advanceTimersByTime(59_000);
    await flushMicrotasks();

    expect(item.status).toBe('running'); // still alive

    fireProgress({ jobId: 'pct-job', percent: 11 }); // different percent, re-arms
    await flushMicrotasks();
    jest.advanceTimersByTime(59_000);
    await flushMicrotasks();

    expect(item.status).toBe('running'); // still alive

    // Same percent repeated — watchdog does NOT re-arm; expires after 60s.
    fireProgress({ jobId: 'pct-job', percent: 11 }); // same percent, no re-arm
    await flushMicrotasks();
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();

    expect(item.status).toBe('failed');
    expect(item.errorMessage).toMatch(/stalled/i);
  });

  // ---------- forcible cancel frees the queue immediately ----------

  it('forcible cancel: splices row and starts next job immediately, late rejection is no-op', async () => {
    let rejectJob!: (err: Error) => void;
    startMediaJobMock
      .mockReturnValueOnce(
        new Promise((_res, rej) => {
          rejectJob = rej;
        }),
      )
      .mockReturnValue(new Promise(() => {}));

    store.enqueue(srcFile, 'reencode-x264'); // item0
    store.enqueue(srcFile, 'normalize-audio'); // item1
    await flushMicrotasks();

    expect(store.items[0].status).toBe('running');
    expect(store.items[1].status).toBe('pending');

    fireProgress({ jobId: 'fc-job', percent: 10, outTimeSec: 2.0 });
    await flushMicrotasks();

    // Cancel item0 — must take effect immediately (no rejection needed).
    store.cancel(store.items[0].id);

    // Synchronously after cancel: item0 is gone, item1 is running.
    expect(store.items).toHaveLength(1);
    expect(store.items[0].status).toBe('running');
    expect(cancelMediaJobMock).toHaveBeenCalledWith('fc-job');

    // Fire late MEDIA_JOB_CANCELLED rejection — must be harmless.
    rejectJob(new Error('MEDIA_JOB_CANCELLED'));
    await flushMicrotasks();

    // Still 1 item, still running — no double-splice, no crash.
    expect(store.items).toHaveLength(1);
    expect(store.items[0].status).toBe('running');
    expect(startMediaJobMock).toHaveBeenCalledTimes(2);
  });

  // ---------- idempotent settle: completion races stall timer ----------

  it('idempotent settle: stall timer does not fire after successful completion (timer was cleared)', async () => {
    let resolveJob!: (v: any) => void;
    startMediaJobMock.mockReturnValue(
      new Promise((r) => {
        resolveJob = r;
      }),
    );

    store.enqueue(srcFile, 'reencode-x264');
    await flushMicrotasks();

    const item = store.items[0];

    // Advance some time but less than 60s, then complete successfully.
    jest.advanceTimersByTime(30_000);
    resolveJob({ jobId: 'idem-job', tempPath: '/tmp/j.mp4', finalPath: '/photos/out.mp4' });
    await flushMicrotasks();

    expect(item.status).toBe('completed');

    // Advance past the original 60s window — stall timer must NOT fire (already cleared).
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();

    // Status must still be completed, not overwritten by a phantom stall.
    expect(item.status).toBe('completed');
    expect(cancelMediaJobMock).not.toHaveBeenCalled();
  });

  it('idempotent settle: late completion after a stall is a harmless no-op', async () => {
    let resolveJob!: (v: any) => void;
    startMediaJobMock.mockReturnValue(
      new Promise((r) => {
        resolveJob = r;
      }),
    );

    store.enqueue(srcFile, 'reencode-x264');
    await flushMicrotasks();

    const item = store.items[0];

    // Let the watchdog fire — item transitions to failed.
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();

    expect(item.status).toBe('failed');

    // Now resolve the (already-stalled) startMediaJob — must be a no-op.
    resolveJob({ jobId: 'late-job', tempPath: '/tmp/j.mp4', finalPath: '/photos/out.mp4' });
    await flushMicrotasks();

    // Status must stay failed — settle idempotency latch blocked the late completion.
    expect(item.status).toBe('failed');
  });
});
