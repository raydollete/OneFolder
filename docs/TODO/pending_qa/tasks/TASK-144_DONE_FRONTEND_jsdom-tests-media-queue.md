---
id: TASK-144
title: 'jsdom tests for the media queue: FIFO single-at-a-time draining, auto-open, cancel/retry, completed Keep actions, and inline Failed rows'
investigation: INV-035
status: done
priority: high
blocked_by: [TASK-140, TASK-141, TASK-142, TASK-143]
date_created: 2026-06-22
date_completed: 2026-06-22
files:
  - 'src/frontend/stores/__tests__/MediaQueueStore.test.ts'
  - 'src/frontend/containers/MediaQueue/__tests__/MediaQueue.test.tsx'
---

## What

Add jsdom-level tests (store + rendered component with real clicks, per the repo's
jsdom rendered-component capability) that verify the queue's FIFO/serial behavior,
drawer auto-open, cancel/retry, the three Keep actions, viewer-focus on filename and
View Completed, and inline failure handling — all with the IPC and `finalizeEncodedOutput`
mocked.

## Why

Locks in the behavioral spec from INV-035 so future changes can't silently regress the
non-blocking queue. These are the agent-reachable verifications; the manual GUI matrix
lives in TASK-145.

See [INV-035](../investigations/INV-035_HIGH_FRONTEND_media-job-bottom-queue-drawer-non-blocking.md).

## Implementation Steps

- [x] 1. Mock `RendererMessenger.startMediaJob` / `onMediaJobProgress` /
      `cancelMediaJob` and `fileStore.finalizeEncodedOutput` (resolve a fake output
      `ClientFile`). Use the repo's existing store/test harness patterns (mirror prior
      store/component tests).
- [x] 2. Store tests (`MediaQueueStore.test.ts`):
      - FIFO single-at-a-time: enqueue three jobs; assert only one is `running` at a
        time and they complete oldest-first; `startMediaJob` is not called for job N+1
        until job N resolves.
      - Enqueue auto-opens the drawer (`isDrawerOpen === true` after first `enqueue`).
      - Pending `Cancel` removes the row and NO `startMediaJob` is invoked for it.
      - Running shows `percent` updating from progress events; `cancelMediaJob` is
        called for a running cancel and the row is removed on `MEDIA_JOB_CANCELLED`.
      - Completion sets `status==='completed'` and `output`; `finalizeEncodedOutput`
        was called with `{ focusViewer: false }`.
      - `keepBoth` removes the row and trashes nothing; `keepNew` trashes the source;
        `keepOriginal` trashes the output (and focuses the source when the viewer is on
        the output).
      - `failed` path: a rejected `startMediaJob` (non-cancel) sets `status==='failed'`
        + `errorMessage`; `retry` re-enqueues the same source/jobType/clip and removes
        the failed row.
- [x] 3. Component tests (`MediaQueue.test.tsx`): render the drawer with a seeded store;
      assert rows render oldest-on-top with the four columns; a `running` row shows
      `Processing… N%`; a `completed` row shows `View Completed` + the three Keep
      buttons; clicking the filename calls `focusFileInViewer(source)` and
      `View Completed` calls it with `output`; a `failed` row reveals `errorMessage` on
      click and shows `Retry` / `Dismiss`.
- [x] 4. Run `yarn test` for these files and fix until green.

## Done When

- [x] All the assertions in steps 2–3 pass under `yarn test`.
- [x] Tests use mocked IPC + `finalizeEncodedOutput`; no real ffmpeg is spawned.
- [ ] The suite is green as part of the end-of-investigation batch (`yarn lint`,
      `yarn test`, `yarn build`).
