---
id: TASK-138
title: 'Extract a shared mediaJobLabel(jobType) helper and a reusable trash helper/hook from DeleteOriginalAfterJob (pure refactor, no behavior change)'
investigation: INV-035
status: done
priority: high
blocked_by: []
date_created: 2026-06-22
date_completed: 2026-06-22
files:
  - 'src/frontend/data/mediaJobLabels.ts'
  - 'src/frontend/components/ImageTools.tsx'
  - 'src/frontend/components/RemovalAlert.tsx'
---

## What

Two pure extractions that the new `MediaQueueStore` (TASK-140) and drawer (TASK-141)
will reuse, done first so they introduce no behavior change on their own:

1. Extract the media-job label map currently inlined in `ImageTools.tsx`
   (`progressLabel` / `toastLabel` / `cancelTitle`) into a shared
   `mediaJobLabel(jobType: MediaJobType)` helper in a new
   `src/frontend/data/mediaJobLabels.ts`, and have `ImageTools.tsx` consume it.
2. Extract the `trash(file)` + recyclable-check logic from `DeleteOriginalAfterJob`
   (`RemovalAlert.tsx:281-333`) into a reusable helper/hook so the queue's Keep
   actions later reuse the exact MoveFilesToTrashBin-consistent flow (release handles
   → `checkRecyclable` → `trashFile` / `deleteFilePermanently` → `fileStore.deleteFiles`)
   instead of duplicating it. `DeleteOriginalAfterJob` keeps working by calling the
   extracted helper (it is deleted later in TASK-143).

## Why

The queue store and drawer must label rows and trash files using the SAME logic the
current tools already use, but those are inlined in a React component and a modal.
Extracting them first keeps TASK-140/141 free of copy-paste and keeps this step a
safe, independently-verifiable refactor.

See [INV-035](../investigations/INV-035_HIGH_FRONTEND_media-job-bottom-queue-drawer-non-blocking.md).

## Implementation Steps

- [x] 1. Create `src/frontend/data/mediaJobLabels.ts`. Export
      `mediaJobLabel(jobType: MediaJobType): string` (e.g. operation label per type:
      Re-encode (x264), Compress & Normalize Audio, Create Clip, Subtract Clip,
      Rotate CW, Rotate CCW). Source the exact strings from the label map currently
      inlined in `ImageTools.tsx` (`progressLabel`/`toastLabel`/`cancelTitle`). Cover
      EVERY `MediaJobType` member (use an exhaustive `Record<MediaJobType, string>` or
      a switch with a `never` default so a missing type fails to compile). If running
      vs error vs cancel need distinct phrasings, export small helpers
      (e.g. `mediaJobProgressLabel`, `mediaJobErrorLabel`) all backed by the one map.
- [x] 2. In `ImageTools.tsx`, replace the inlined label map(s) in `progressLabel` /
      `toastLabel` / `cancelTitle` with calls to the new helper(s). No visible change.
- [x] 3. In `RemovalAlert.tsx`, extract the trash-one-file flow from
      `DeleteOriginalAfterJob` (`:281-333`) into a reusable export — prefer a hook
      `useTrashFile()` returning an `async (file: ClientFile) => Promise<void>` (or a
      plain helper that takes the deps it needs) that performs: release video handles
      → `checkRecyclable` → `trashFile` / `deleteFilePermanently` → `fileStore.deleteFiles`,
      identical to the current `DeleteOriginalAfterJob` path and consistent with
      `MoveFilesToTrashBin`. Keep `DeleteOriginalAfterJob` rendering by having it call
      the extracted helper (it is removed in TASK-143).
- [x] 4. Confirm no other call sites of the inlined label map or the inlined trash
      logic exist (grep for the moved strings / the recyclable-check call).

## Done When

- [x] `src/frontend/data/mediaJobLabels.ts` exists and exhaustively covers
      `MediaJobType`; `ImageTools.tsx` consumes it with no visible label change.
- [x] The recyclable-aware trash flow is exported once from `RemovalAlert.tsx` and
      `DeleteOriginalAfterJob` uses the extracted version; behavior is unchanged.
- [ ] `yarn lint` and `yarn build` pass (batch build deferred to the end of the
      investigation per project convention; at minimum this compiles).
