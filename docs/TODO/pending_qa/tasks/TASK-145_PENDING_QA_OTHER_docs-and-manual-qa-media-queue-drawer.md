---
id: TASK-145
title: 'Docs + manual QA: rewrite TOOLS.md and the five per-tool docs to the queue/drawer flow (removal of the in-viewer pin and blocking Keep modal), and run the manual QA matrix'
investigation: INV-035
status: pending_qa
priority: medium
blocked_by: [TASK-140, TASK-141, TASK-142, TASK-143, TASK-144]
date_created: 2026-06-22
date_completed:
files:
  - 'docs/TOOLS.md'
  - 'docs/reencode-x264.md'
  - 'docs/rotate-video.md'
  - 'docs/normalize-audio.md'
  - 'docs/create-clip.md'
  - 'docs/subtract-clip.md'
---

## What

Update the tool documentation to describe the new bottom queue drawer flow and the
removal of the in-viewer pin/lock and the blocking Keep-which-version / error modals,
then run the manual QA matrix on a real build.

## Why

The docs currently describe the in-viewer pin/lock, the seamless in-viewer swap, and
the blocking `DeleteOriginalAfterJob` / `MediaJobErrorAlert` modals — all removed by
this investigation. They must reflect the queue/drawer model. Manual GUI QA is the only
way to confirm the non-blocking UX end-to-end.

See [INV-035](../investigations/INV-035_HIGH_FRONTEND_media-job-bottom-queue-drawer-non-blocking.md).

## Implementation Steps

- [x] 1. `docs/TOOLS.md`: replace the in-viewer pin/lock + blocking Keep-modal
      description with the queue/drawer flow — enqueue returns immediately; FIFO,
      oldest-on-top, one job at a time, auto-draining; completed rows wait with
      `View Completed` + Keep New / Keep Original / Keep Both; failures are inline
      `Failed` rows with Retry / Dismiss; commit-on-completion via `finalizeEncodedOutput`;
      session-only in-memory queue cancelled on quit. Note the intentional reversal of
      the INV-021 / INV-023 viewer-pin invariant.
- [x] 2. Update each per-tool doc (`reencode-x264.md`, `rotate-video.md`,
      `normalize-audio.md`, `create-clip.md`, `subtract-clip.md`) to point at the
      shared queue/drawer flow instead of the in-viewer pin + blocking Keep modal;
      remove references to `DeleteOriginalAfterJob` / `MediaJobErrorAlert` / the
      `isMediaProcessing` lock.
- [ ] 3. REQUIRES MANUAL EXECUTION — run `yarn dev` + `yarn start` and, on a video,
      verify: enqueue several operations; the drawer auto-expands, oldest on top, only
      one `Processing` at a time; browse/tag other files while a job runs (no freeze, no
      pin); `View Completed` opens the new file; clicking a filename opens the original;
      exercise all three Keep actions (New trashes source, Original trashes output,
      Both keeps both); force a failure (e.g. an audio-incompatible source for a forced
      `.mp4`) and confirm an inline `Failed` row with error detail on click and a working
      `Retry`; collapse the drawer and confirm the summary bar counts; cancel a pending
      and a running job. Capture evidence (screenshot / clip / log line) and attach or
      link it here.
- [ ] 4. End-of-investigation batch: run `yarn lint`, `yarn test`, `yarn build`; debug
      any failures. (Deferred to parent investigation batch — not run per-task.)

## Done When

- [x] `docs/TOOLS.md` and all five per-tool docs describe the queue/drawer flow and the
      removal of the in-viewer pin + blocking modals; no doc still references the
      removed lock/modals.
- [ ] REQUIRES MANUAL EXECUTION — the manual QA matrix in step 3 passes with attached
      evidence.
- [ ] `yarn lint`, `yarn test`, `yarn build` all pass.
