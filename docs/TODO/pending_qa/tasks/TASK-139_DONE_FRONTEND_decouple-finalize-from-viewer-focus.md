---
id: TASK-139
title: 'FileStore.finalizeEncodedOutput / resolveOutputClientFile: add a { focusViewer } option (default false) so committing an output no longer anchors the viewer'
investigation: INV-035
status: done
priority: high
blocked_by: []
date_created: 2026-06-22
date_completed: 2026-06-22
files:
  - 'src/frontend/stores/FileStore.ts'
---

## What

Decouple the post-media-job commit/ingest from viewer anchoring. Add an options arg
`{ focusViewer?: boolean }` (default `false`) to `finalizeEncodedOutput`, thread it
into `resolveOutputClientFile`, and only set `uiStore.firstItem` / call
`uiStore.selectFile` when `focusViewer` is `true`. The `fileList` injection stays
unconditional so the output always lands in the active view at the source's position.

## Why

The new `MediaQueueStore` (TASK-140) must commit a finished ffmpeg output into the
watched folder WITHOUT moving the user's viewer or selection (jobs no longer run in
the viewer). `finalizeEncodedOutput` / `resolveOutputClientFile` currently always
anchor the viewer (`FileStore.ts:1459-1460, 1485-1486`). The queue passes
`focusViewer: false`; any remaining in-viewer callers (if kept transitionally) can
pass `true`.

See [INV-035](../investigations/INV-035_HIGH_FRONTEND_media-job-bottom-queue-drawer-non-blocking.md).

## Implementation Steps

- [x] 1. In `FileStore.ts`, change `resolveOutputClientFile(source, dto)` to
      `resolveOutputClientFile(source, dto, opts: { focusViewer: boolean })`. In BOTH
      branches (in-list at `:1458-1461`, injected at `:1480-1487`), keep the `fileList`
      injection / index rebuild unconditional, but wrap the
      `uiStore.firstItem = …; uiStore.selectFile(outputFile, true);` lines in
      `if (opts.focusViewer) { … }`. Keep the existing `transaction(...)` wrapping.
- [x] 2. Change `finalizeEncodedOutput(source, paths)` to
      `finalizeEncodedOutput(source, paths, opts: { focusViewer?: boolean } = {})`,
      compute `const focusViewer = opts.focusViewer ?? false;`, and pass
      `{ focusViewer }` through to `resolveOutputClientFile`. Default = `false`.
- [x] 3. Update existing callers of `finalizeEncodedOutput` so behavior is preserved:
      any current in-viewer caller that relied on the old anchoring must now pass
      `{ focusViewer: true }`. (Note: `ImageTools.tsx`'s caller is removed in TASK-142;
      if TASK-142 lands after this, leave that caller passing `{ focusViewer: true }`
      in the interim so the old in-viewer flow is unchanged until it is replaced.)
- [x] 4. Update the JSDoc on both methods to document the new option and that the
      default does NOT touch the viewer.

## Done When

- [x] `finalizeEncodedOutput(source, paths, { focusViewer: false })` commits + ingests
      + injects the output into `fileList` WITHOUT setting `firstItem` or selection.
- [x] With `{ focusViewer: true }` (or any current in-viewer caller) the prior anchoring
      behavior is byte-for-byte preserved.
- [ ] `yarn lint` / `yarn build` pass (compiles; batch test at end of investigation).
