---
id: TASK-140
title: 'New MediaQueueStore: session-scoped FIFO media-job queue that serializes execution, commits outputs without moving the viewer, and exposes enqueue/cancel/retry/keep actions (+ RootStore wiring)'
investigation: INV-035
status: done
priority: high
blocked_by: [TASK-138, TASK-139]
date_created: 2026-06-22
date_completed: 2026-06-22
files:
  - 'src/frontend/stores/MediaQueueStore.ts'
  - 'src/frontend/stores/RootStore.ts'
---

## What

Add a new renderer-side MobX store `MediaQueueStore` that owns the media-job queue,
runs one ffmpeg job at a time (FIFO, auto-draining), commits each finished output into
the watched folder WITHOUT moving the viewer, and exposes the row actions the drawer
needs (cancel / retry / keep-new / keep-original / keep-both / view-in-viewer). Wire it
into `RootStore`. This store replaces the in-`ImageTools.tsx` execution and the
`UiStore` media-processing lock as the single owner of job lifecycle.

## Why

The user wants media jobs to run outside the viewer in a persistent queue while they
keep browsing. The store is the viewer-independent home for job state and execution
that the old in-component / `UiStore`-lock model lacked. It reuses the unchanged IPC
+ main-process stack and the helpers extracted in TASK-138/139.

See [INV-035](../investigations/INV-035_HIGH_FRONTEND_media-job-bottom-queue-drawer-non-blocking.md).

## Implementation Steps

- [x] 1. Create `src/frontend/stores/MediaQueueStore.ts`. Construct it with the
      `RootStore` (mirror the other stores). Define `QueueItem` as an observable object:
      `id: string` (`crypto.randomUUID()` in the renderer), `source: ClientFile`,
      `jobType: MediaJobType`, `clip?: { start?: string; end?: string }`,
      `label: string`, `status: 'pending' | 'running' | 'completed' | 'failed'`,
      `percent: number | null`, `jobId: string | null`, `output: ClientFile | null`,
      `errorMessage: string | null`, `requestedAt: number`.
- [x] 2. Observables: `items: QueueItem[]` (enqueue order) and `isDrawerOpen: boolean`.
      Computeds: `runningItem` (first item with `status==='running'`), `pendingCount`,
      `completedCount`, `hasItems`. Decorate with `makeObservable` per the repo's store
      style.
- [x] 3. `enqueue(source, jobType, clip?)`: derive `label = mediaJobLabel(jobType)`
      (from `src/frontend/data/mediaJobLabels.ts`, TASK-138); push a `pending` item
      with `requestedAt: Date.now()`; set `isDrawerOpen = true`; call `processNext()`.
- [x] 4. `processNext()`: no-op if any item has `status==='running'`; otherwise pick
      the FIRST `pending` item (oldest) and `runItem(it)`. This single-running guard is
      what serializes execution (replacing the old `isMediaProcessing` gate).
- [x] 5. `runItem(item)` — mirror today's `ImageTools.runMediaJob` but write into the
      item and NEVER touch the viewer:
      (a) `item.status='running'`; subscribe `RendererMessenger.onMediaJobProgress`,
      stashing `item.jobId` from the first event and updating `item.percent`
      (round to whole percent);
      (b) `const { jobId, tempPath, finalPath } = await RendererMessenger.startMediaJob(jobType, source.absolutePath, clip)`;
      unsubscribe;
      (c) `const output = await this.rootStore.fileStore.finalizeEncodedOutput(source, { jobId, tempPath, finalPath }, { focusViewer: false })`
      (TASK-139 — commits + ingests + injects into `fileList` without moving the viewer);
      (d) on success `item.output = output; item.status='completed'`. On a
      `MEDIA_JOB_CANCELLED` rejection: splice the item out (drop the row). On any other
      error: `item.status='failed'; item.errorMessage = message`;
      (e) `finally { this.processNext(); }` to drain the next pending job.
      Wrap state writes in `runInAction`/`@action` as the store style requires.
- [x] 6. `cancel(itemId)`: pending → splice the row (no ffmpeg ever starts); running →
      `RendererMessenger.cancelMediaJob(item.jobId)` (the in-flight `runItem` then
      rejects with `MEDIA_JOB_CANCELLED` and removes the row).
- [x] 7. `retry(itemId)`: re-`enqueue` the same `source/jobType/clip`, then remove the
      failed row.
- [x] 8. Keep actions, each reusing the extracted trash helper (TASK-138) and removing
      the row when done:
      `keepNew(item)` → trash `item.source`;
      `keepOriginal(item)` → trash `item.output`, and if the viewer is currently on the
      output (`uiStore.firstFileInView === item.output` or equivalent identity check),
      `focusFileInViewer(item.source)` first;
      `keepBoth(item)` → just remove the row (leave both files on disk).
- [x] 9. `focusFileInViewer(file)`: `const idx = fileStore.ensureFileInListAt(file)`
      (existing, `FileStore.ts:1216`); `uiStore.setFirstItem(idx)`;
      `uiStore.selectFile(file, true)`; `uiStore.enableSlideMode()`. Used by both the
      filename click (source) and `View Completed` (output) in the drawer.
- [x] 10. Wire `RootStore.ts`: add `readonly mediaQueueStore: MediaQueueStore;` and
      instantiate it AFTER `uiStore` (`RootStore.ts:59`):
      `this.mediaQueueStore = new MediaQueueStore(this);`. Import the class.

## Done When

- [x] `mediaQueueStore.enqueue(file, jobType, clip?)` pushes a `pending` row, opens the
      drawer, and starts draining; only ONE item is `running` at any time, oldest first.
- [x] A completed job's output is committed/ingested into `fileList` via
      `finalizeEncodedOutput(..., { focusViewer: false })` with NO change to the viewer
      or selection; `item.output` holds the new `ClientFile`.
- [x] `cancel` removes a pending row without starting ffmpeg and cancels a running job;
      `retry` re-enqueues a failed job; `keepNew/keepOriginal/keepBoth` trash the
      correct file (or neither) and remove the row; `focusFileInViewer` opens a file in
      SlideMode.
- [x] `mediaQueueStore` is reachable via `useStore().mediaQueueStore`.
- [ ] `yarn lint` / `yarn build` pass (compiles; batch test at end of investigation). [deferred to consolidated build/test pass at end of investigation per task instructions]
