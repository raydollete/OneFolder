import { action, computed, makeObservable, observable, runInAction } from 'mobx';

import { MediaJobType } from '../../ipc/messages';
import { RendererMessenger } from '../../ipc/renderer';
import { ClientFile } from '../entities/File';
import { mediaJobLabel } from '../data/mediaJobLabels';
import RootStore from './RootStore';

// ---------------------------------------------------------------------------
// QueueItem
// ---------------------------------------------------------------------------

/**
 * A single entry in the media-job queue. Each field is observable so the
 * drawer can react to transitions (pending → running → completed/failed).
 *
 * `jobId` is stashed from the first MEDIA_JOB_PROGRESS event so the running
 * job can be cancelled.  It is `null` until that event arrives (and cleared
 * after the job settles).
 *
 * `output` is `null` until the job completes and `finalizeEncodedOutput`
 * returns the committed `ClientFile`.
 */
export class QueueItem {
  @observable id: string;
  @observable source: ClientFile;
  @observable jobType: MediaJobType;
  @observable clip: { start?: string; end?: string } | undefined;
  @observable label: string;
  @observable status: 'pending' | 'running' | 'completed' | 'failed';
  @observable percent: number | null;
  @observable jobId: string | null;
  @observable output: ClientFile | null;
  @observable errorMessage: string | null;
  @observable requestedAt: number;

  constructor(
    id: string,
    source: ClientFile,
    jobType: MediaJobType,
    clip: { start?: string; end?: string } | undefined,
    label: string,
    requestedAt: number,
  ) {
    this.id = id;
    this.source = source;
    this.jobType = jobType;
    this.clip = clip;
    this.label = label;
    this.status = 'pending';
    this.percent = null;
    this.jobId = null;
    this.output = null;
    this.errorMessage = null;
    this.requestedAt = requestedAt;
    makeObservable(this);
  }
}

// ---------------------------------------------------------------------------
// MediaQueueStore
// ---------------------------------------------------------------------------

/**
 * Session-scoped FIFO queue for all ffmpeg media jobs (re-encode, normalize-
 * audio, create-clip, subtract-clip, rotate-cw/ccw).
 *
 * Serialization: at most ONE job is `running` at any time.  When a job
 * settles (completes, fails, or is cancelled), `processNext` drains the next
 * `pending` item automatically.
 *
 * Viewer invariant: execution, finalization, and completion never move the
 * viewer or change the selection.  `focusFileInViewer` is an explicit
 * user-driven action for the filename-click and "View Completed" controls in
 * the drawer.
 *
 * Keep / trash wiring: because `useTrashFile` is a React hook it cannot be
 * called from inside the store.  Instead `keepNew` and `keepOriginal` accept
 * a `trashFile` parameter — the drawer component calls `useTrashFile()` at
 * its own hook level and passes the returned function down.  This keeps the
 * store free of React and is the idiomatic solution matching the repo's
 * hook-vs-store separation (see TASK-141 for the matching drawer implementation).
 */
class MediaQueueStore {
  private readonly rootStore: RootStore;

  // ----- observables -----

  @observable items: QueueItem[] = [];
  @observable isDrawerOpen: boolean = false;

  // ----- computeds -----

  @computed get runningItem(): QueueItem | undefined {
    return this.items.find((it) => it.status === 'running');
  }

  @computed get pendingCount(): number {
    return this.items.filter((it) => it.status === 'pending').length;
  }

  @computed get completedCount(): number {
    return this.items.filter((it) => it.status === 'completed').length;
  }

  @computed get hasItems(): boolean {
    return this.items.length > 0;
  }

  // ----- constructor -----

  constructor(rootStore: RootStore) {
    this.rootStore = rootStore;
    makeObservable(this);
  }

  // ----- actions -----

  /**
   * Enqueue a new media job.  The job is added to the end of the list
   * (FIFO), the drawer is opened, and the queue is drained if idle.
   */
  @action.bound enqueue(
    source: ClientFile,
    jobType: MediaJobType,
    clip?: { start?: string; end?: string },
  ): void {
    const item = new QueueItem(
      crypto.randomUUID(),
      source,
      jobType,
      clip,
      mediaJobLabel(jobType),
      Date.now(),
    );
    this.items.push(item);
    this.isDrawerOpen = true;
    this.processNext();
  }

  /**
   * Start the next pending job if no job is already running.
   * This is the serialization guard: only one `startMediaJob` is ever
   * in flight at a time.
   */
  @action.bound processNext(): void {
    if (this.runningItem !== undefined) {
      return;
    }
    const next = this.items.find((it) => it.status === 'pending');
    if (next !== undefined) {
      this.runItem(next);
    }
  }

  /**
   * Execute a single queue item.
   *
   * Mirrors `ImageTools.runMediaJob` but:
   *   - writes progress/state into the `QueueItem` observable, not local React state
   *   - never touches the viewer (focusViewer: false)
   *   - on MEDIA_JOB_CANCELLED splices the row (the user already cancelled it)
   *   - on any other error marks the row as failed with the error message
   *   - always calls processNext() in finally to drain the next pending job
   *
   * All state mutations that occur after the first await are wrapped in
   * runInAction as required by MobX strict mode.
   */
  @action.bound runItem(item: QueueItem): void {
    // Mark running synchronously (inside this @action call, before any await).
    item.status = 'running';

    // Subscribe to progress events BEFORE invoking startMediaJob so we never
    // miss the synthetic percent:0 / jobId event (per IPC contract).
    const unsubscribe = RendererMessenger.onMediaJobProgress((msg) => {
      runInAction(() => {
        // Stash the jobId from the first event so cancel() can use it.
        if (item.jobId === null && msg.jobId) {
          item.jobId = msg.jobId;
        }
        if (msg.percent !== undefined) {
          // Round to whole percent — avoids a re-render per fractional tick.
          item.percent = Math.round(msg.percent);
        }
      });
    });

    // The actual async work is kicked off but NOT awaited in this synchronous
    // @action body.  All post-await mutations are wrapped in runInAction.
    (async () => {
      try {
        const { jobId, tempPath, finalPath } = await RendererMessenger.startMediaJob(
          item.jobType,
          item.source.absolutePath,
          item.clip,
        );

        // Tear down the progress subscription — ffmpeg is done.
        unsubscribe();

        // Commit the output into the library.  focusViewer: false means the
        // viewer/selection are never touched by this call (TASK-139).
        const output = await this.rootStore.fileStore.finalizeEncodedOutput(
          item.source,
          { jobId, tempPath, finalPath },
          { focusViewer: false },
        );

        runInAction(() => {
          item.output = output;
          item.status = 'completed';
        });
      } catch (err: unknown) {
        // Tear down the subscription on any failure too.
        unsubscribe();

        const message = err instanceof Error ? err.message : String(err);

        if (message === 'MEDIA_JOB_CANCELLED') {
          // User-initiated cancel: splice the row.  The Cancel action already
          // sent cancelMediaJob to main; this rejection is the confirmation.
          runInAction(() => {
            const idx = this.items.indexOf(item);
            if (idx !== -1) {
              this.items.splice(idx, 1);
            }
          });
        } else {
          // Hard ffmpeg failure: mark the row as failed with the error detail.
          runInAction(() => {
            item.status = 'failed';
            item.errorMessage = message;
          });
        }
      } finally {
        // Always drain the next pending job, whether success, failure, or cancel.
        this.processNext();
      }
    })();
  }

  /**
   * Cancel a queued or running job.
   *
   * Pending: the row is spliced immediately (ffmpeg never started).
   * Running: sends a cancel IPC to main; the in-flight `runItem` then rejects
   *   with `MEDIA_JOB_CANCELLED` and removes the row from its catch block.
   */
  @action.bound cancel(itemId: string): void {
    const item = this.items.find((it) => it.id === itemId);
    if (item === undefined) {
      return;
    }

    if (item.status === 'pending') {
      const idx = this.items.indexOf(item);
      if (idx !== -1) {
        this.items.splice(idx, 1);
      }
    } else if (item.status === 'running' && item.jobId !== null) {
      RendererMessenger.cancelMediaJob(item.jobId);
      // Row removal is handled in runItem's catch block when the rejection arrives.
    }
  }

  /**
   * Re-enqueue a failed job with the same source / jobType / clip, then remove
   * the failed row.
   */
  @action.bound retry(itemId: string): void {
    const item = this.items.find((it) => it.id === itemId);
    if (item === undefined || item.status !== 'failed') {
      return;
    }

    this.enqueue(item.source, item.jobType, item.clip);

    const idx = this.items.findIndex((it) => it.id === itemId);
    if (idx !== -1) {
      this.items.splice(idx, 1);
    }
  }

  /**
   * Keep the new output: trash the original source file, then remove the row.
   *
   * @param item - A completed queue item (item.output must be non-null).
   * @param trashFile - The function returned by `useTrashFile()` (hook).
   *   The drawer component calls `useTrashFile()` at its own hook level and
   *   passes it here so the store stays free of React.
   */
  @action.bound async keepNew(
    item: QueueItem,
    trashFile: (file: ClientFile) => Promise<{ ok: boolean; isPermanent: boolean }>,
  ): Promise<void> {
    await trashFile(item.source);
    runInAction(() => {
      const idx = this.items.indexOf(item);
      if (idx !== -1) {
        this.items.splice(idx, 1);
      }
    });
  }

  /**
   * Keep the original source: trash the committed output file, then remove the row.
   *
   * If the viewer is currently showing the output, focus the source first so
   * the user does not see a blank/missing file in SlideMode after the output
   * is trashed.
   *
   * @param item - A completed queue item (item.output must be non-null).
   * @param trashFile - The function returned by `useTrashFile()` (hook).
   */
  @action.bound async keepOriginal(
    item: QueueItem,
    trashFile: (file: ClientFile) => Promise<{ ok: boolean; isPermanent: boolean }>,
  ): Promise<void> {
    if (item.output === null) {
      return;
    }

    // If the viewer is currently on the output, navigate to the source first.
    if (this.rootStore.uiStore.firstFileInView === item.output) {
      this.focusFileInViewer(item.source);
    }

    await trashFile(item.output);

    runInAction(() => {
      const idx = this.items.indexOf(item);
      if (idx !== -1) {
        this.items.splice(idx, 1);
      }
    });
  }

  /**
   * Keep both files: just remove the row (both files stay on disk).
   */
  @action.bound keepBoth(item: QueueItem): void {
    const idx = this.items.indexOf(item);
    if (idx !== -1) {
      this.items.splice(idx, 1);
    }
  }

  /**
   * Navigate the viewer to `file` in SlideMode.
   *
   * Ensures the file is in the visible `fileList` (injecting it at the end if
   * the active filter excludes it), then sets `firstItem`, selects the file,
   * and enables SlideMode.
   *
   * Used by the filename-click control (opens the original) and the
   * "View Completed" control (opens the output) in the drawer.
   */
  @action.bound focusFileInViewer(file: ClientFile): void {
    const { fileStore, uiStore } = this.rootStore;
    const idx = fileStore.ensureFileInListAt(file);
    uiStore.setFirstItem(idx);
    uiStore.selectFile(file, true);
    uiStore.enableSlideMode();
  }
}

export default MediaQueueStore;
