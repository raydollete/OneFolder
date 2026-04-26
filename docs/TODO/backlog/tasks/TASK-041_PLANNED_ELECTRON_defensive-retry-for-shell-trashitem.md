---
id: TASK-041
title: 'Add defensive retry around shell.trashItem in main process for EBUSY/EPERM'
investigation: INV-008
status: planned
priority: medium
blocked_by: [TASK-038, TASK-039, TASK-040]
date_created: 2026-04-23
date_completed:
files:
  - src/main.ts
---

## What

Wrap the `shell.trashItem(absolutePath)` call in `src/main.ts` (line 688) with a single retry-after-delay when the OS returns `EBUSY` or `EPERM`. The renderer-side release (TASK-038/039/040) is the primary fix; this retry is belt-and-suspenders for race windows where Chromium's media pipeline teardown completes slightly after the renderer's `releasePaths` resolves.

## Why

Even after `video.load()` is called and the coordinator awaits a rAF tick, Chromium's media resource teardown is asynchronous and can finish a few milliseconds later on slower or contended systems. A single 150 ms retry bridges that gap without masking legitimate persistent failures (antivirus, permission issues, file actually in use by another process).

See [INV-008](../investigations/INV-008_HIGH_FRONTEND_video-file-handle-blocks-delete-with-ebusy.md).

## Implementation Steps

- [ ] 1. In `src/main.ts`, locate the line `MainMessenger.onTrashFile((absolutePath) => shell.trashItem(absolutePath));` (currently line 688).
- [ ] 2. Replace the inline arrow with a helper function (e.g., `trashWithRetry`) defined nearby that:
  - Accepts `absolutePath: string`.
  - Calls `await shell.trashItem(absolutePath)`.
  - On rejection, inspects the error. If the error's `code` is `EBUSY` or `EPERM`, OR the error's `message` contains `resource busy or locked` or `scandir`, await a 150 ms delay (`new Promise(r => setTimeout(r, 150))`) and retry `shell.trashItem` ONCE.
  - On any other rejection, or if the retry also fails, rethrow / return the original error so the renderer's `if (!error)` branch still signals failure correctly (`RemovalAlert.tsx:132`).
  - Do NOT loop more than twice total (original + one retry).
- [ ] 3. Add a code comment that references INV-008 and explains: "The renderer's MediaReleaseCoordinator releases <video> handles before this IPC fires, but Chromium's media-pipeline teardown is async. A single short retry covers the rare race window. Persistent failures are returned unchanged."
- [ ] 4. Log the first failure (original attempt) at `console.warn` with the path and error.code/message so QA and users can see the retry in devtools. Log success-after-retry at `console.info`. Do not spam.
- [ ] 5. Rebuild and manually verify: deliberately introduce a brief artificial delay (temporarily comment out the rAF await in `MediaReleaseCoordinator.releasePaths` so the main process hits the race) and confirm the retry succeeds. Restore the rAF when done.

## Done When

- [ ] `shell.trashItem` in main.ts is wrapped with exactly one conditional retry on EBUSY/EPERM after a ~150 ms delay.
- [ ] Non-matching errors propagate unchanged.
- [ ] Retry is observable via console logs for diagnosis.
- [ ] Manual test: even if the renderer release is artificially slowed, the retry path recovers and the file trashes successfully.
- [ ] Comment at the site references INV-008.
