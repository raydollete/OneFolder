---
id: TASK-142
title: 'ImageTools.tsx: switch the media-tool buttons from running a job in the viewer to enqueuing into MediaQueueStore and returning immediately'
investigation: INV-035
status: done
priority: high
blocked_by: [TASK-140]
date_created: 2026-06-22
date_completed: 2026-06-22
files:
  - 'src/frontend/components/ImageTools.tsx'
---

## What

Replace the in-inspector job execution in `ImageTools.tsx` with calls to
`mediaQueueStore.enqueue(file, jobType, clip?)` that return immediately. Remove the
in-component run/cancel/progress machinery and the in-inspector progress UI, but keep
all the trigger buttons, the Mark Start / Mark End + Create / Subtract Clip fields, and
`captureCurrentTime`.

## Why

The buttons must fire-and-forget into the queue instead of taking over the viewer. The
queue store (TASK-140) now owns lifecycle, progress, finalize, and the keep/error
surfaces, so the component's local job state and progress block are obsolete.

See [INV-035](../investigations/INV-035_HIGH_FRONTEND_media-job-bottom-queue-drawer-non-blocking.md).

## Implementation Steps

- [x] 1. Add `mediaQueueStore` to the `useStore()` destructure.
- [x] 2. Remove `runMediaJob` / `handleCancel` / the `onMediaJobProgress` subscription
      / the `activeJob` / `jobPercent` / `isFinalizing` state and the `jobIdRef` /
      `unsubscribeRef` plumbing, and the entire in-inspector progress UI block
      (`ImageTools.tsx:67-185, 224-283`). Also remove the now-unused
      `RendererMessenger` import if nothing else in the file uses it.
- [x] 3. Point every tool button's `onClick` at
      `mediaQueueStore.enqueue(file, jobType, clip?)`:
      Rotate CW (`'rotate-cw'`), Rotate CCW (`'rotate-ccw'`), Re-encode (x264)
      (`'reencode-x264'`), Compress & Normalize Audio (`'normalize-audio'`), Create
      Clip (`'create-clip'`, with the `{ start, end }` clip from the fields), Subtract
      Clip (`'subtract-clip'`, with its clip). Pass NO clip for the no-clip tools.
      Keep the exact button order and labels.
- [x] 4. Keep the Mark Start / Mark End fields, the Create Clip / Subtract Clip inputs,
      `captureCurrentTime`, and the `startTime` / `endTime` state — they still build the
      `clip` payload passed to `enqueue`.
- [x] 5. Remove `disabled={uiStore.isMediaProcessing}` from the buttons (the lock is
      gone — TASK-143). KEEP the clip-validity `disabled` logic on Create/Subtract Clip.
- [x] 6. Remove the unmount-cleanup `useEffect` that only unsubscribed the progress
      handler (the store owns the subscription now), and any other code that only
      existed to drive the removed progress UI.

## Done When

- [x] Clicking any media-tool button calls `mediaQueueStore.enqueue(...)` and returns
      immediately; the inspector no longer shows an in-progress spinner or cancel button.
- [x] All buttons, the Mark/clip fields, and `captureCurrentTime` remain and still
      build the correct `clip` payload; clip-validity disabling is intact; the
      `isMediaProcessing` disable is gone.
- [x] `ImageTools.tsx` no longer references `RendererMessenger.startMediaJob` /
      `onMediaJobProgress` / `cancelMediaJob`, `finalizeEncodedOutput`, or the removed
      local state.
- [x] `yarn lint` / `yarn build` pass (compiles; batch test at end of investigation).
