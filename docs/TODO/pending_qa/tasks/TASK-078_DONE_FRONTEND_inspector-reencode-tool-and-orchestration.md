---
id: TASK-078
title: 'Remove the dormant placeholder tools and add the video-gated "Re-encode (x264)" inspector tool with a progress spinner and the full encode -> tag-copy -> select orchestration'
investigation: INV-018
status: done
priority: medium
blocked_by: [TASK-076, TASK-077]
date_created: 2026-06-11
date_completed: 2026-06-11

files:
  - 'src/frontend/components/ImageTools.tsx (remove 4 dormant placeholder buttons + canny block; add the tool + spinner sub-view + non-video caption)'
  - 'resources/style/inspector.scss (spinner/progress styling if needed)'
  - 'src/frontend/containers/Inspector/index.tsx (reference — passes current file; section show/hide owner, out of scope)'
related: [TASK-030] # both edit ImageTools.tsx; TASK-030 removes the canny "Let us know" block — see step 3b for reconciliation
---

## What

Remove the four permanently-disabled placeholder tool buttons ("HEIC to JPEG",
"Optimize JPEG", "Fix red eyes", "Colorize black and white image") from the
inspector Tools section so it contains only functional tools, and add an
enabled **"Re-encode (x264)"** button, shown only when the current file is a
video. On click, run the full client-side orchestration: lock the UI, start the
main-process encode, show an animated progress indicator, then on success copy
tags to the output, wait for ingestion, select+open it, unlock, and trigger the
delete-original prompt (TASK-079).

The component being edited is `src/frontend/components/ImageTools.tsx` (note:
its internal function/interface are misnamed `ImageDuplicates` /
`ImageDuplicatesProps` due to a copy-paste — this is the Tools component
rendered by `Inspector/index.tsx:83`, NOT the separate
`ImageDuplicates.tsx` file whose section is commented out). Do not confuse the
two files; only `ImageTools.tsx` is in scope here.

## Why

This is the user-facing tool. It ties together the binary/runner (TASK-074/075),
the IPC (TASK-076), and the lock/await/tag-copy helpers (TASK-077).

See [INV-018](../investigations/INV-018_MEDIUM_FRONTEND_reencode-x264-video-tool.md)
(root cause item 1; blast radius items 1, 6, 7; behavioral spec "Happy path").

## Implementation Steps

- [x] 1. In `ImageTools.tsx`, REMOVE the four permanently-disabled placeholder
      tool buttons inside the `.tools` container (lines 15-18 in the current
      file): "HEIC to JPEG" (`IconSet.INTELLIGENCE`), "Optimize JPEG"
      (`IconSet.CARROT`), "Fix red eyes" (`IconSet.EYE_LOW_VISION`), and
      "Colorize black and white image" (`IconSet.PALETTE`). These are dormant
      tools that do nothing (`disabled={true}`, no `onClick`); after this work
      the Tools list must contain only functional tools. Note:
      `CARROT`/`EYE_LOW_VISION`/`PALETTE` were referenced ONLY by these buttons,
      but they are entries in the shared `widgets` `IconSet` library
      (`widgets/icons.tsx`), so do NOT delete the icon definitions — leaving
      unused library entries is harmless and matches how the codebase treats the
      icon set. `INTELLIGENCE` is still used elsewhere (`DuplicateGallery.tsx`).
      Keep the `IconSet` import in `ImageTools.tsx` — the new button uses an icon.
- [x] 2. In `ImageTools.tsx`, import `isFileExtensionVideo` from `common/fs` and
      `RendererMessenger`. The component already receives `file: ClientFile`
      (wired from `Inspector/index.tsx:28` as
      `fileStore.fileList[uiStore.firstItem]`). Get stores via the existing
      `useStore`/context pattern used elsewhere in the renderer. (Optional
      cleanup while here: the function and props interface are misnamed
      `ImageDuplicates`/`ImageDuplicatesProps`; rename to `ImageTools`/
      `ImageToolsProps` for clarity. Low-risk, no external references depend on
      the internal name.)
- [x] 3. Render an enabled `<button>` labelled "Re-encode (x264)" (with an
      `IconSet` icon) ONLY when `isFileExtensionVideo(file.extension)` is true.
      Disable the button while `uiStore.isMediaProcessing`.
- [x] 3a. NON-VIDEO / EMPTY-TOOLS UX (see INV-018 UX consideration): once the
      placeholders are gone, "Re-encode (x264)" is the only tool and it is
      video-only, so for image (non-video) files the Tools list renders empty.
      Render a neutral single-line caption in that case (e.g. "No tools
      available for this file type.") inside the `.tools`/`inspector-section`
      body so the section is not confusingly blank. Do NOT add a canny.io / "Let
      us know" CTA (the personal fork removes those — see INV-006/TASK-030).
      Hiding the entire collapsible Tools <section> header for non-video files
      was considered and is OUT OF SCOPE here: section show/hide is owned by
      `Inspector/index.tsx`'s `InspectorToggleSection` list and would require a
      file-type-aware change there; the neutral caption is the lighter, locally
      contained choice. Flagged in INV-018 for a possible future follow-up.
- [x] 3b. CANNY/FEEDBACK BLOCK RECONCILIATION: the current `ImageTools.tsx` also
      contains the "Ideas on what we should add? ... Let us know" canny.io block
      (lines 20-30) and a `shell` import. That block is already slated for
      removal by TASK-030 (INV-006). Whichever of TASK-030 / TASK-078 lands
      first should remove it; since TASK-078 rewrites this component wholesale,
      remove the canny block and the now-unused `import { shell } from 'electron'`
      here too (the empty `<p className="text-center"></p>` can go as well). If
      TASK-030 already ran, this is a no-op. End state: no canny.io link, no
      `shell` import in `ImageTools.tsx`.
- [x] 4. Add local progress state (`useState`) and subscribe via
      `RendererMessenger.onReencodeProgress` while a job is active; unsubscribe
      on completion/unmount. Capture the jobId from the progress stream (per
      TASK-076 step 5) so a Cancel button can call
      `RendererMessenger.cancelReencode(jobId)`.
- [x] 5. Render the animated indicator while processing: reuse the existing CSS
      spinner (`.loading-spinner` + `@keyframes spin`, currently in
      `resources/style/duplicate-gallery.scss`) — either reference that class or
      add an equivalent `.reencode-progress` block in `inspector.scss`. Show
      percent when available, else an indeterminate spinner. Optionally show a
      Cancel button.
- [x] 6. On click, run an `async` orchestration wrapped in `try/finally`:
      1. `uiStore.beginMediaProcessing(file.absolutePath)`.
      2. `const { outputPath } = await RendererMessenger.startReencode(file.absolutePath);`
      3. `const newFile = await waitForIngestedFile(outputPath, 10000);`
         (TASK-077). If it times out, toast "Encoded to <path> but it is outside
         a watched folder; tags not attached" and skip tag-copy/select.
      4. `await copyTagsToFile(file, newFile);` (TASK-077).
      5. `uiStore.selectFile(newFile, true); uiStore.enableSlideMode();`
      6. Trigger the delete-original prompt for `file` (TASK-077) — e.g.
         `uiStore.openReEncodeDeleteOriginal(file)`.
      - `finally { uiStore.endMediaProcessing(); }` — guarantees lock release
        even on error (prevents the lock-leak risk in INV-018).
- [x] 7. On `startReencode` rejection (ffmpeg failure or cancel): show an error
      toast (`AppToaster`) with a short message + stderr tail; do NOT open the
      delete prompt; the `finally` releases the lock. The source file is
      untouched.
- [x] 8. Verify the placeholder tools are gone, the tool does not appear for
      image files (neutral caption shown instead), and the inspector layout is
      not broken for non-video files. Run `yarn lint` on `ImageTools.tsx` to
      confirm no unused imports remain (`shell` removed; `IconSet` still used).

## Done When

- [x] The four dormant placeholder buttons (HEIC to JPEG, Optimize JPEG, Fix
      red eyes, Colorize black and white image) no longer appear in the Tools
      section; the only tool ever shown is "Re-encode (x264)".
- [x] The canny.io "Let us know" block and the `shell` import are gone from
      `ImageTools.tsx` (consistent with TASK-030).
- [x] For a non-video (image) file the Tools section shows a neutral "no tools
      for this file type" caption and no broken/empty layout.
- [x] Opening a video shows the enabled "Re-encode (x264)" tool; opening an
      image does not.
- [x] Clicking it shows an animated progress indicator and, on success, the new
      `.mp4` is auto-selected and shown in SlideMode with the source's tags.
- [x] During the encode the tool buttons and navigation are disabled (UI lock),
      and the lock is released on success, failure, and cancel.
- [x] An ffmpeg failure surfaces an error toast and leaves the source intact
      with no delete prompt.
- [x] After a successful encode the delete-original prompt (TASK-079) appears.
      (Implemented: uiStore.openReEncodeDeleteOriginal(file) called on success;
      TASK-079 provides the ReEncodeDeleteOriginal component.)
