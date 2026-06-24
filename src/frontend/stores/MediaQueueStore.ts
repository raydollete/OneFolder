import { action, computed, makeObservable, observable, reaction, runInAction, toJS } from 'mobx';

import { MediaJobType } from '../../ipc/messages';
import { RendererMessenger } from '../../ipc/renderer';
import { ClientFile } from '../entities/File';
import { mediaJobLabel } from '../data/mediaJobLabels';
import RootStore from './RootStore';

/**
 * How the user settled a completed/failed job. Drives both the resolved-row
 * label and which files still exist (and are therefore link-able) in the drawer:
 *   - `kept-new`      → source trashed, output kept  (filename = text, status → new file)
 *   - `kept-original` → output trashed, source kept  (filename → source, status = text)
 *   - `kept-both`     → both kept                    (filename → source, status → new file)
 *   - `dismissed`     → failed job dismissed         (filename → source, status = text)
 */
export type ResolutionKind = 'kept-new' | 'kept-original' | 'kept-both' | 'dismissed';

/**
 * The four counts that appear in the media-queue drawer header, used for the
 * seen-vs-live comparison that drives the unseen badge (INV-037).
 */
export interface MediaQueueCounts {
  queued: number;
  processing: number;
  done: number;
  resolved: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * If a running job's `outTimeSec` (the primary liveness signal from ffmpeg)
 * does not advance for this many milliseconds, the job is auto-failed and the
 * queue drains the next pending job (INV-038 / TASK-154).
 *
 * The integer `percent` is used as a fallback liveness signal when a progress
 * message lacks `outTimeSec` (e.g. older/edge message shapes), so a healthy job
 * without that field is also never false-failed.
 */
const STALL_TIMEOUT_MS = 60_000;

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
 *
 * `resolution` is `null` until the user settles a completed/failed job with a
 * Keep / Dismiss choice; it then holds the {@link ResolutionKind} and the item's
 * status becomes `'resolved'` so it sinks to the bottom of the drawer as
 * history instead of being removed (INV-036).
 */
export class QueueItem {
  @observable id: string;
  @observable source: ClientFile;
  @observable jobType: MediaJobType;
  @observable clip: { start?: string; end?: string } | undefined;
  @observable label: string;
  @observable status: 'pending' | 'running' | 'completed' | 'failed' | 'resolved';
  @observable percent: number | null;
  @observable jobId: string | null;
  @observable output: ClientFile | null;
  @observable errorMessage: string | null;
  @observable resolution: ResolutionKind | null;
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
    this.resolution = null;
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

  /**
   * Snapshot of the four header counts as of the last time the drawer was open.
   * Initialized to all-zero (matching construction-time live counts for an empty
   * queue) so no badges appear on first load.  Updated continuously while the
   * drawer is open (via a reaction) so it equals exactly what the user last saw
   * when the drawer closes.  INV-037.
   */
  @observable seenCounts: MediaQueueCounts = { queued: 0, processing: 0, done: 0, resolved: 0 };

  /** Disposer for the open-clears-unseen reaction; stored for cleanliness. */
  private disposeSeenReaction: () => void;

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

  @computed get resolvedCount(): number {
    return this.items.filter((it) => it.status === 'resolved').length;
  }

  @computed get hasItems(): boolean {
    return this.items.length > 0;
  }

  /** The four live header counts, computed from the underlying observables (INV-037). */
  @computed get liveCounts(): MediaQueueCounts {
    return {
      queued: this.pendingCount,
      processing: this.runningItem !== undefined ? 1 : 0,
      done: this.completedCount,
      resolved: this.resolvedCount,
    };
  }

  /**
   * Per-count "has changed since the drawer was last open" flags.
   * Only meaningful to display while the drawer is collapsed; the view gates
   * badge rendering on `!isDrawerOpen` as well (INV-037).
   */
  @computed get unseenCounts(): {
    queued: boolean;
    processing: boolean;
    done: boolean;
    resolved: boolean;
  } {
    return {
      queued: this.liveCounts.queued !== this.seenCounts.queued,
      processing: this.liveCounts.processing !== this.seenCounts.processing,
      done: this.liveCounts.done !== this.seenCounts.done,
      resolved: this.liveCounts.resolved !== this.seenCounts.resolved,
    };
  }

  /** True if any of the four counts is unseen (convenience for conditional rendering). */
  @computed get hasUnseen(): boolean {
    const u = this.unseenCounts;
    return u.queued || u.processing || u.done || u.resolved;
  }

  // ----- constructor -----

  constructor(rootStore: RootStore) {
    this.rootStore = rootStore;
    makeObservable(this);

    // Keep seenCounts equal to liveCounts while the drawer is open so that when
    // the drawer later closes, the snapshot equals exactly what was last on screen.
    // Tracking liveCounts in the expression means every count change while open
    // re-runs the effect and re-syncs the snapshot.  fireImmediately handles the
    // case where the store is constructed with isDrawerOpen already true (INV-037).
    this.disposeSeenReaction = reaction(
      () => ({ open: this.isDrawerOpen, live: this.liveCounts }),
      ({ open }) => {
        if (open) {
          this.markSeen();
        }
      },
      { fireImmediately: true },
    );
  }

  // ----- actions -----

  /**
   * Copy the current live counts into the seen snapshot, clearing all unseen
   * flags.  Called by the open-reaction while the drawer is open, and also
   * directly by the toggle handler when opening, so the clear is immediate and
   * deterministic in tests (INV-037).
   */
  @action.bound markSeen(): void {
    this.seenCounts = { ...this.liveCounts };
  }

  /**
   * Enqueue a new media job.  The job is added to the end of the list
   * (FIFO) and the queue is drained if idle.  The drawer is NOT auto-opened —
   * it is always present (default collapsed) at the bottom of the window, and
   * the user controls its expanded state (INV-036).
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
   *   - uses a single idempotent `settle()` helper for ALL terminal paths so the
   *     progress subscription and stall watchdog are always torn down exactly once
   *     and `processNext()` is called exactly once (INV-038 / TASK-154).
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

      // Liveness tracking for the stall watchdog (outside runInAction — no observable mutation).
      // Primary signal: outTimeSec advance (ticks far more often than integer percent, so a
      // long encode where one 1% step exceeds 60s is never false-failed).
      if (msg.outTimeSec !== undefined && msg.outTimeSec > lastOutTimeSec) {
        lastOutTimeSec = msg.outTimeSec;
        armStallTimer();
      } else if (msg.outTimeSec === undefined && msg.percent !== undefined) {
        // Fallback: arm on integer percent change when outTimeSec is absent (older message shapes).
        const rounded = Math.round(msg.percent);
        if (rounded !== lastPercentForWatchdog) {
          lastPercentForWatchdog = rounded;
          armStallTimer();
        }
      }
    });

    // --- Stall-watchdog state (imperative, non-observable — timer handles, not UI state) ---

    // Latch that prevents any terminal path from firing more than once.
    // All terminal outcomes (success, failure, cancel, stall) route through settle(),
    // which sets this to true on first call and no-ops on all subsequent calls.
    let settled = false;

    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    // Primary liveness signal: the last outTimeSec value seen from a real progress message.
    // Reset to -1 so any non-negative value counts as forward progress.
    let lastOutTimeSec = -1;

    // Fallback liveness signal used only when outTimeSec is absent from a progress message.
    let lastPercentForWatchdog: number | null = null;

    /**
     * (Re)arm the stall watchdog. Called on every genuine forward-progress signal.
     * If no further progress arrives within STALL_TIMEOUT_MS, the item is auto-failed.
     */
    const armStallTimer = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
      }
      stallTimer = setTimeout(() => {
        stallTimer = null;
        // Kill the wedged child best-effort (main side will also time out independently).
        if (item.jobId !== null) {
          RendererMessenger.cancelMediaJob(item.jobId);
        }
        const frozenAt = item.percent !== null ? ` (stuck at ${item.percent}%)` : '';
        settle(() => {
          item.status = 'failed';
          item.errorMessage = `Stalled: no progress for 60s${frozenAt}.`;
        });
      }, STALL_TIMEOUT_MS);
    };

    /**
     * Idempotent settle helper. All terminal paths (success, failure, cancel, stall) call this.
     *
     * On first call:
     *   1. Sets the settled latch (all subsequent calls are no-ops).
     *   2. Tears down the MEDIA_JOB_PROGRESS subscription (fixes the listener-leak in INV-038 #7).
     *   3. Clears the stall watchdog timer.
     *   4. Runs `apply()` inside runInAction to apply the terminal mutation.
     *   5. Calls processNext() exactly once to drain the next pending job.
     *
     * The idempotency guarantee means: cancel-then-rejection, stall-then-late-completion,
     * and completion-then-stall-timer (already cleared by settle) are all safe no-ops after
     * the first settle fires.
     */
    const settle = (apply: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      runInAction(apply);
      this.processNext();
    };

    // Arm the stall watchdog immediately when the item enters `running`.
    // This covers the case where the synthetic percent:0 first event has not yet
    // been processed — the clock starts as soon as the job is dispatched.
    armStallTimer();

    // The actual async work is kicked off but NOT awaited in this synchronous
    // @action body.  All post-await mutations are wrapped via settle/runInAction.
    (async () => {
      try {
        // toJS() converts the @observable clip into a plain object — a MobX
        // proxy cannot be structured-cloned across the ipcRenderer.invoke
        // boundary ("An object could not be cloned"), which broke create-clip /
        // subtract-clip jobs (INV-036). undefined passes through unchanged.
        const { jobId, tempPath, finalPath } = await RendererMessenger.startMediaJob(
          item.jobType,
          item.source.absolutePath,
          toJS(item.clip),
        );

        // Commit the output into the library.  focusViewer: false means the
        // viewer/selection are never touched by this call (TASK-139).
        const output = await this.rootStore.fileStore.finalizeEncodedOutput(
          item.source,
          { jobId, tempPath, finalPath },
          { focusViewer: false },
        );

        settle(() => {
          item.output = output;
          item.status = 'completed';
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message === 'MEDIA_JOB_CANCELLED') {
          // User-initiated cancel: the row was already optimistically spliced by cancel()
          // (INV-038 / TASK-154). settle() here is a safe no-op if the row is already gone —
          // the splice in apply() is guarded by indexOf, and processNext() is idempotent.
          settle(() => {
            const idx = this.items.indexOf(item);
            if (idx !== -1) {
              this.items.splice(idx, 1);
            }
          });
        } else {
          // Hard ffmpeg failure: mark the row as failed with the error detail.
          settle(() => {
            item.status = 'failed';
            item.errorMessage = message;
          });
        }
      } finally {
        // Defensive no-op settle: if an unforeseen exception escaped every try/catch
        // branch above (e.g. a thrown non-Error), this guarantees the slot is still
        // freed and processNext() still runs. The idempotency latch makes this free.
        settle(() => {});
      }
    })();
  }

  /**
   * Cancel a queued or running job.
   *
   * Pending: the row is spliced immediately (ffmpeg never started).
   *
   * Running: sends a cancel IPC to main to kill the child, then immediately
   *   splices the row and advances the queue — without waiting for the
   *   `MEDIA_JOB_CANCELLED` round-trip (INV-038 / TASK-154).
   *
   *   The in-flight `runItem` async body will still receive the rejection (or a
   *   natural completion) eventually, but by then the item is already gone from
   *   `this.items`, so its `settle()` call's splice is a harmless indexOf no-op,
   *   and `processNext()` is idempotent (it only starts a job if none is running).
   *
   *   This makes Cancel work even during the finalize phase (Blast Radius #2): even
   *   if `cancelMediaJob` is a main-side no-op once ffmpeg has already finished, the
   *   row is removed and the queue advances locally; the orphaned `finalizeEncodedOutput`
   *   completes or fails harmlessly against the no-longer-listed item.
   *
   *   When `item.jobId` is null (cancel pressed before the first progress event), the
   *   row is still spliced locally; the kill is best-effort once jobId is known — the
   *   main-side FfmpegRunner inactivity backstop (TASK-155) handles the orphaned child.
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
    } else if (item.status === 'running') {
      // Fire the kill IPC best-effort (jobId may be null if cancel is pressed before
      // the first progress event; the main-side backstop handles that case).
      if (item.jobId !== null) {
        RendererMessenger.cancelMediaJob(item.jobId);
      }

      // Optimistically splice the row and advance the queue immediately.
      // The in-flight runItem settle() will fire later but is a harmless no-op:
      // - Its splice finds indexOf === -1 (item already removed) → skipped.
      // - Its processNext() is idempotent (early-returns if a job is already running).
      const idx = this.items.indexOf(item);
      if (idx !== -1) {
        this.items.splice(idx, 1);
      }
      this.processNext();
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
   * Mark an item resolved with a human-readable label.  Resolved items are NOT
   * removed — they stay in `items` (rendered at the bottom of the drawer as
   * history) until the user clicks "Clear resolved" (INV-036).
   */
  @action.bound private resolve(item: QueueItem, resolution: ResolutionKind): void {
    item.status = 'resolved';
    item.resolution = resolution;
  }

  /**
   * Keep the new output: trash the original source file, then resolve the row.
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
    runInAction(() => this.resolve(item, 'kept-new'));
  }

  /**
   * Keep the original source: trash the committed output file, then resolve the row.
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

    runInAction(() => this.resolve(item, 'kept-original'));
  }

  /**
   * Keep both files: resolve the row (both files stay on disk).
   */
  @action.bound keepBoth(item: QueueItem): void {
    this.resolve(item, 'kept-both');
  }

  /**
   * Dismiss a failed job: resolve the row as "Dismissed" (the row sinks to the
   * bottom as history rather than being removed).
   */
  @action.bound dismiss(item: QueueItem): void {
    this.resolve(item, 'dismissed');
  }

  /**
   * Remove all resolved rows from the queue at once.
   */
  @action.bound clearResolved(): void {
    this.items = this.items.filter((it) => it.status !== 'resolved');
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
