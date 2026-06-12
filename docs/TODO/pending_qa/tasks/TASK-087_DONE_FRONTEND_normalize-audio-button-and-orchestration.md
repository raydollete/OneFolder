---
id: TASK-087
title: 'Add the "Normalize Audio" video-gated button and orchestration to ImageTools.tsx, reusing the parameterized media-job IPC, the corrected post-encode finalize helper (INV-019), and the generalized delete-original prompt'
investigation: INV-020
status: done
priority: medium
blocked_by: [TASK-082, TASK-085, TASK-086]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/frontend/components/ImageTools.tsx'
  - 'resources/style/inspector.scss'
---

## What

Add a second video-gated tool button, **Normalize Audio**, to the inspector
Tools section, with its own spinner/percent/cancel. On click it runs the
`normalize-audio` media job (TASK-085), then the corrected post-encode finalize
helper `fileStore.finalizeEncodedOutput(source, outputPath)` (TASK-082), then the
generalized delete-original prompt (TASK-086). Both tool buttons coexist and are
disabled while `isMediaProcessing`; the active spinner and Cancel target the
correct job.

## Why

Normalize Audio is "almost identical" to Re-encode (x264): same UI lock, same
post-encode flow, same delete-original prompt — only the ffmpeg args and the
button label differ. With the runner/IPC/prompt generalized and the post-encode
flow corrected, the only new code is the button + orchestration.

See [INV-020](../investigations/INV-020_MEDIUM_FRONTEND_normalize-audio-video-tool.md).

## Implementation Steps

- [x] 1. Generalize the local job state in `ImageTools.tsx`. The current state
      (`isEncoding`, `encodePercent`, `jobIdRef`, `unsubscribeRef`) assumes a
      single job. Introduce a notion of "which tool is running," e.g.
      `const [activeJob, setActiveJob] = useState<'reencode-x264' |
      'normalize-audio' | null>(null)` plus the shared `percent`/`jobId`/
      `unsubscribe` refs. Only one job runs at a time (gated by
      `uiStore.isMediaProcessing`).
- [x] 2. Factor the shared orchestration into one function
      `runMediaJob(jobType: 'reencode-x264' | 'normalize-audio')` that mirrors
      the existing `handleReencode` but: subscribes via
      `RendererMessenger.onMediaJobProgress`, calls
      `RendererMessenger.startMediaJob(jobType, file.absolutePath)`, on success
      `await fileStore.finalizeEncodedOutput(file, outputPath)` then
      `uiStore.openDeleteOriginalPrompt(file)`, handles
      `'MEDIA_JOB_CANCELLED'`/error toasts (note: task text said 'REENCODE_CANCELLED'
      but actual code already uses 'MEDIA_JOB_CANCELLED' per TASK-085), and releases
      the lock + resets state in `finally`. Cancel calls
      `RendererMessenger.cancelMediaJob(jobId)`. (handleReencode removed; both
      buttons call runMediaJob directly.)
- [x] 3. Render TWO buttons for video files (when not running): the existing
      "Re-encode (x264)" (`runMediaJob('reencode-x264')`) using `IconSet.PLAY`,
      and a new "Normalize Audio" (`runMediaJob('normalize-audio')`) using
      `IconSet.MEDIA`, each disabled while `uiStore.isMediaProcessing`.
- [x] 4. While a job runs, show the spinner sub-view with a label that reflects
      the active tool ("Re-encoding… N%" vs "Normalizing audio… N%") and a
      Cancel button targeting the active job. `.reencode-progress` markup/classes
      reused without renaming (non-rename reuse); `resources/style/inspector.scss`
      unchanged.
- [x] 5. Keep the non-video caption ("No tools available for this file type.")
      unchanged.
- [x] 6. `yarn build` and quick smoke run — DEFERRED to TASK-088 (orchestrator
      batches builds at end per multi-task run policy). TypeScript-level
      verification: `MediaJobType` import from `src/ipc/messages.ts` confirmed
      exported; `IconSet.MEDIA` confirmed present in `widgets/icons.tsx`.

## Done When

- [x] The inspector Tools section shows both "Re-encode (x264)" and
      "Normalize Audio" for video files; both are disabled while
      `isMediaProcessing`; neither appears for non-video files.
- [x] Clicking Normalize Audio runs the `normalize-audio` job, then the corrected
      `finalizeEncodedOutput` flow (tags copied before show), then the
      delete-original prompt.
- [x] The spinner label and Cancel button correctly reflect whichever tool is
      running; the lock releases in `finally` on success/cancel/error.
- [ ] `yarn build` passes. (Full functional QA is TASK-088.) — DEFERRED to TASK-088.
