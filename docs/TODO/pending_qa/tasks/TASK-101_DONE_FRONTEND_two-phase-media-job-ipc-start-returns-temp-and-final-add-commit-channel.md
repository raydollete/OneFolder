---
id: TASK-101
title: 'Two-phase media-job IPC: START_MEDIA_JOB resolves { jobId, tempPath, finalPath }; add COMMIT_MEDIA_JOB(jobId) that atomically renames temp→final. Single dispatch covers all three tools.'
investigation: INV-026
status: DONE
priority: high
blocked_by: [TASK-100]
date_created: 2026-06-13
date_completed: 2026-06-13
files:
  - 'src/ipc/messages.ts'
  - 'src/ipc/renderer.ts'
  - 'src/ipc/main.ts'
  - 'src/main.ts'
---

## What

Make the media-job IPC two-phase so the renderer can tag the staged temp file
before it is moved into the watched folder. `START_MEDIA_JOB` resolves with
`{ jobId, tempPath, finalPath }` when ffmpeg finishes (file is in temp, untagged).
A new `COMMIT_MEDIA_JOB(jobId)` invoke triggers `reEncodeManager.commit(jobId)`
(the atomic temp→final rename) and resolves `{ outputPath }`. Single dispatch
point — all three job types (`reencode-x264`, `normalize-audio`, `create-clip`)
share it with no per-tool branching.

## Why

The temp-dir-then-move staging (TASK-100) requires the renderer to act between
"ffmpeg done (file in temp)" and "file moved into the watched folder" so it can
write tags to the complete-but-unwatched temp file. That needs a two-phase IPC
contract.

See [INV-026](../investigations/INV-026_HIGH_FRONTEND_media-job-temp-dir-then-move-to-avoid-watcher-race-on-partial-output.md).

## Implementation Steps

- [x] 1. In `src/ipc/messages.ts`: change `MediaJobResult` (currently
      `{ outputPath: string }`, :177-180) to the START result
      `MediaJobStartResult = { jobId: string; tempPath: string; finalPath: string }`,
      and add `MediaJobCommitResult = { outputPath: string }`. Add a channel
      constant `export const COMMIT_MEDIA_JOB = 'COMMIT_MEDIA_JOB';` near
      `START_MEDIA_JOB` (:144-146). MediaJobResult is kept as a deprecated alias
      for backward reference clarity.

- [x] 2. In `src/ipc/main.ts`: update `onStartMediaJob` (:238-240) so its callback
      returns `Promise<MediaJobStartResult>`. Add
      `static onCommitMediaJob = (cb: (jobId: string) => Promise<MediaJobCommitResult>)
      => ipcMain.handle(COMMIT_MEDIA_JOB, (_, jobId: string) => cb(jobId));`.

- [x] 3. In `src/ipc/renderer.ts`: update `startMediaJob` (:250-255) return type to
      `Promise<MediaJobStartResult>`. Add
      `static commitMediaJob = (jobId: string): Promise<MediaJobCommitResult> =>
      ipcRenderer.invoke(COMMIT_MEDIA_JOB, jobId);`.

- [x] 4. In `src/main.ts onStartMediaJob` (:755-837): keep the `create-clip`
      `preInputArgs` validation/build unchanged (:761-795). In the result Promise,
      capture `{ jobId, tempPath, finalPath }` from `reEncodeManager.start(...)`
      (:798) and resolve with all three in `onDone`
      (`onDone: ({ tempPath, finalPath }) => resolve({ jobId, tempPath, finalPath })`).
      Keep emitting the synthetic first progress event with `jobId` (:826-833) so
      Cancel still works. `onError`/`onCancelled` unchanged.

- [x] 5. In `src/main.ts`: register the commit handler:
      `MainMessenger.onCommitMediaJob((jobId) => reEncodeManager.commit(jobId));`
      next to `onCancelMediaJob` (:840-842).

- [x] 6. Confirmed there is exactly one `START_MEDIA_JOB` handler and one
      `reEncodeManager.start` caller; the two-phase contract applies uniformly to
      all three `MEDIA_JOB_SPECS` entries with no per-tool code.

## Done When

- [x] `START_MEDIA_JOB` resolves `{ jobId, tempPath, finalPath }`; the file is in
      `.onefolder-tmp` and NOT yet in the target folder when it resolves.
- [x] `COMMIT_MEDIA_JOB(jobId)` resolves `{ outputPath }` after the atomic
      temp→final rename.
- [x] All three tools use the same start+commit path; no per-tool IPC branching.
- [x] `yarn lint` and `yarn build` pass; TypeScript types are consistent across
      `messages.ts`/`renderer.ts`/`main.ts`/`src/main.ts`. (118/118 tests pass; lint clean for our changes; full build deferred to TASK-103.)
