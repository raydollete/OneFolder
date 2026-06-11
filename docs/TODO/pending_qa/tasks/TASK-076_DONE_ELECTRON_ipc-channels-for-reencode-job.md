---
id: TASK-076
title: 'Add type-safe IPC channels for the re-encode job: start (invoke), progress (stream), cancel (send)'
investigation: INV-018
status: DONE
priority: medium
blocked_by: [TASK-075]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/ipc/messages.ts'
  - 'src/ipc/renderer.ts'
  - 'src/ipc/main.ts'
  - 'src/main.ts (wire handlers to ReEncodeManager)'
---

## What

Add three IPC channels following the existing static-method pattern in
`src/ipc/`: `START_REENCODE` (renderer `invoke` -> main, resolves with the
final result or rejects with an error), `REENCODE_PROGRESS` (main -> renderer
push stream keyed by job id), and `CANCEL_REENCODE` (renderer `send` -> main).
Wire the main-side handlers to the `ReEncodeManager` from TASK-075.

## Why

The inspector tool (renderer) must start the encode, receive live progress, and
optionally cancel — but the subprocess lives in main (TASK-075). The IPC layer
has no streaming-progress or job-cancel channel today.

See [INV-018](../investigations/INV-018_MEDIUM_FRONTEND_reencode-x264-video-tool.md)
(root cause item 3; blast radius item 4).

## Implementation Steps

- [x] 1. In `src/ipc/messages.ts`, add channel constants and types:
      `START_REENCODE`, `REENCODE_PROGRESS`, `CANCEL_REENCODE`; and types
      `ReencodeProgressMessage = { jobId: string; percent?: number; outTimeSec?:
      number; totalSec?: number }` and `ReencodeResult = { outputPath: string }`.
- [x] 2. In `src/ipc/renderer.ts` (`RendererMessenger`), add:
      - `static startReencode = (inputPath: string): Promise<ReencodeResult> =>
        ipcRenderer.invoke(START_REENCODE, inputPath);` (the main handler
        resolves on success / rejects on ffmpeg failure or cancel).
      - `static onReencodeProgress = (cb: (msg: ReencodeProgressMessage) =>
        void) => { const h = (_:any, msg:any) => cb(msg);
        ipcRenderer.on(REENCODE_PROGRESS, h); return () =>
        ipcRenderer.removeListener(REENCODE_PROGRESS, h); };` (returns an
        unsubscribe, matching the `onMaximize` pattern in renderer.ts).
      - `static cancelReencode = (jobId: string) =>
        ipcRenderer.send(CANCEL_REENCODE, jobId);`
- [x] 3. In `src/ipc/main.ts` (`MainMessenger`), add:
      - `static onStartReencode = (cb: (wc: WebContents, inputPath: string) =>
        Promise<ReencodeResult>) => ipcMain.handle(START_REENCODE, (e,
        inputPath) => cb(e.sender, inputPath));`
      - `static sendReencodeProgress = (wc: WebContents, msg:
        ReencodeProgressMessage) => wc.send(REENCODE_PROGRESS, msg);`
      - `static onCancelReencode = (cb: (jobId: string) => void) =>
        ipcMain.on(CANCEL_REENCODE, (_, jobId) => cb(jobId));`
- [x] 4. In `src/main.ts` initialization, wire the handlers to TASK-075's
      runner: `onStartReencode` calls `reEncodeManager.start(inputPath, p =>
      MainMessenger.sendReencodeProgress(wc, p))` and returns a promise that
      resolves with `{ outputPath }` on done / rejects on error/cancel;
      `onCancelReencode` calls `reEncodeManager.cancel(jobId)`. Ensure progress
      is sent only to the originating `WebContents`.
- [x] 5. Decide jobId delivery: since `startReencode` is a single
      invoke/await, return the jobId to the renderer via the FIRST progress
      message (so the renderer can call `cancelReencode(jobId)`), or include it
      in a tiny synchronous pre-resolve. Document the chosen mechanism in a code
      comment so TASK-078's cancel button has a jobId to use.

## Done When

- [ ] From the renderer devtools console, `RendererMessenger.startReencode(<a
      real video path>)` resolves with `{ outputPath }` and the file exists.
      (Requires TASK-080 manual QA — not testable in Jest)
- [ ] `RendererMessenger.onReencodeProgress(console.log)` logs increasing
      progress during an encode and the returned unsubscribe stops the logs.
      (Requires TASK-080 manual QA)
- [ ] `RendererMessenger.cancelReencode(jobId)` aborts the encode (the
      `startReencode` promise rejects with a cancellation error and no partial
      output remains). (Requires TASK-080 manual QA)
- [ ] A failing encode rejects the `startReencode` promise with an error
      message containing ffmpeg stderr context. (Requires TASK-080 manual QA)
- [x] No existing IPC channel signatures were changed. (Verified: `yarn build`
      and `yarn test` both pass; lint errors are all pre-existing in unrelated files)
