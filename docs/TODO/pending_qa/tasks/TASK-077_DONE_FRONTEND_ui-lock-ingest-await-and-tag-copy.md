---
id: TASK-077
title: 'Add a media-processing UI lock, an ingestion-await helper, and a tag-copy helper (DB + EXIF/XMP) for the re-encode flow'
investigation: INV-018
status: DONE
priority: medium
blocked_by: []
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/frontend/stores/UiStore.ts (mediaProcessing flag; gate processGlobalShortCuts)'
  - 'src/frontend/containers/ContentView/SlideMode/index.tsx (gate arrow/Delete handlers)'
  - 'src/frontend/components/RemovalAlert.tsx (block delete while processing) and/or delete entry points'
  - 'src/frontend/entities/File.ts (disableImmediateSync usage; reference only)'
  - 'src/frontend/stores/FileStore.ts or a new helper module (waitForIngestedFile, copyTagsToFile)'
---

## What

Three renderer building blocks for the re-encode orchestration, independent of
ffmpeg so they can be built and unit-checked first:
1. A `UiStore.mediaProcessing` observable lock that freezes navigation, edit,
   and delete of the current file while set.
2. `waitForIngestedFile(absolutePath, timeoutMs)` — resolves with the
   `ClientFile` once the chokidar watcher has ingested a given path, or rejects
   on timeout.
3. `copyTagsToFile(source, targetPath /or targetFile)` — copies the source's
   tag hierarchy into the target's EXIF/XMP via `exifTool.writeTags` AND adds
   the source's `ClientTag`s to the target `ClientFile` without double-writing
   metadata.

## Why

The re-encode flow must (a) lock the UI during the encode, (b) deterministically
wait for the auto-generated output to be ingested before selecting it, and (c)
carry tags across — ffmpeg does not preserve metadata and the new file gets a
fresh empty tag set on ingestion (`pathToIFile` sets `tags: []`).

See [INV-018](../investigations/INV-018_MEDIUM_FRONTEND_reencode-x264-video-tool.md)
(root cause items 4, 5, 6; blast radius items 6, 7, 9).

## Implementation Steps

- [x] 1. In `UiStore`, add `@observable mediaProcessing: { active: boolean; path:
      string | null } = { active: false, path: null }` with
      `@action.bound beginMediaProcessing(path: string)` and
      `@action.bound endMediaProcessing()`. Add a `@computed get
      isMediaProcessing()` for convenience.
- [x] 2. Gate `UiStore.processGlobalShortCuts`: when `mediaProcessing.active`,
      early-return for navigation and destructive combos — specifically
      `deleteSelection` and any view/slide navigation hotkeys (`viewSlide`,
      arrow-equivalent combos). Allow harmless combos (e.g. toggling panels) at
      your discretion, but at minimum block delete + file navigation.
- [x] 3. Gate the SlideMode key handler
      (`src/frontend/containers/ContentView/SlideMode/index.tsx`): when
      `uiStore.isMediaProcessing`, make the ArrowLeft/ArrowRight
      (`incrImgIndex`/`decrImgIndex`) and Delete/Backspace handlers no-op (do
      not change firstItem, do not open trash, do not disable slide mode).
- [x] 4. Block the delete entry points while processing: in `RemovalAlert`
      open paths / `ContentView/menu-items.tsx` Delete item / `Main.tsx` Delete
      hotkey path, guard with `uiStore.isMediaProcessing` so the trash modal
      cannot open for the source mid-encode. (The cleanest single choke point is
      `UiStore.openMoveFilesToTrash` — early-return when processing.)
- [x] 5. Add `waitForIngestedFile(absolutePath, timeoutMs = 10000):
      Promise<ClientFile>` (e.g. on `FileStore` or a small helper). Implement
      with a MobX `reaction(() => fileStore.fileList.find(f => f.absolutePath
      === absolutePath), (file, _, r) => { if (file) { r.dispose();
      resolve(file); } })` plus a `setTimeout` that disposes the reaction and
      rejects. Account for the 200 ms `debouncedRefetch` (the file may take a
      few hundred ms to appear).
- [x] 6. Add `copyTagsToFile(source: ClientFile, target: ClientFile):
      Promise<void>`:
      - `const hierarchy = Array.from(source.tags, t => t.path);`
      - If `hierarchy.length === 0`, return (nothing to copy).
      - `const reenable = target.disableImmediateSync();` then `for (const tag
        of source.tags) target.addTag(tag);` then `await reenable();` — this
        writes the metadata exactly once. (If TASK-078 already wrote the
        metadata in main before ingestion, prefer adding ClientTags under
        `disableImmediateSync` WITHOUT re-writing; pick one writer and document
        it. Recommended single writer: write metadata here in the renderer,
        after the ffmpeg handle is closed, via the `addTag` + reenable path.)
- [x] 7. Ensure `endMediaProcessing()` is safe to call multiple times and that
      callers can put it in a `finally` (TASK-078 relies on this for lock-leak
      safety).

## Done When

- [ ] Setting `uiStore.beginMediaProcessing(path)` makes arrow keys, Space, and
      Delete inert in SlideMode and prevents the trash modal from opening for
      the source; `endMediaProcessing()` restores all of them.
- [ ] `waitForIngestedFile` resolves with the correct `ClientFile` shortly
      after a new file is dropped into a watched folder, and rejects after the
      timeout for a path that never appears.
- [ ] `copyTagsToFile` results in the target `ClientFile.tags` matching the
      source's tag set AND the target file's EXIF/XMP containing the same
      HierarchicalSubject/Subject/Keywords (verified with ExifTool), with no
      change to the source's tags or counts, and metadata written exactly once.
- [ ] No regression to normal navigation/delete when `mediaProcessing.active`
      is false.
