---
id: INV-008
title: 'Video gallery element holds OS file handle, blocking trash/delete with EBUSY'
reported_bug: 'I am unable to delete videos. I get an error: "EBUSY: resource busy or locked, scandir <filepath>" — the video is correctly previewing on hover, but there needs to be a way to unload the video when a delete is triggered.'
date: 2026-04-23
status: superseded
superseded_by: INV-014
tasks_spawned: [TASK-038, TASK-039, TASK-040, TASK-041, TASK-042]
root_cause_category: 'architectural-shortcoming'
affects:
  - Video preview/playback in gallery (MasonryCell/Thumbnail)
  - Video preview/playback in SlideMode (ZoomableImage)
  - Preload pipeline in SlideMode (document.createElement('video') + .src)
  - Trash/delete flow (MoveFilesToTrashBin, FileRemoval, DuplicateGallery)
  - Drag-and-drop move flow (useFileDnD.handleMove — fse.move + fse.remove)
  - Folder watcher rescans (chokidar via @nodelib/fs.scandir)
  - Thumbnail lifecycle for videos (currently uses original file path as thumbnail)
postmortem_summary: |
  Diagnosis was correct (Chromium <video> holds an OS file handle without
  FILE_SHARE_DELETE on Windows). Architectural approach (a MediaReleaseCoordinator
  that components register video refs with, and that destructive ops await before
  IPC) was correct. However the implementation that shipped in commit 6b81a51
  has three concrete defects that prevent it from actually releasing handles in
  the common case (gallery hover-then-delete):

    1. The component-side registration useEffects in
       src/frontend/containers/ContentView/GalleryItem.tsx (Thumbnail) and
       src/frontend/containers/ContentView/SlideMode/index.tsx (ZoomableImage,
       slideVideoRef) have dependency lists that omit the imageSource/image
       promise state. The <video> element only renders after the async
       thumbnail/decode promise resolves, so on first render thumbnailRef.current
       is null. The effect runs once on mount, bails on the null check, and is
       never re-run because none of its deps change when the promise resolves.
       Result: the gallery video and the slide-mode main video are NEVER
       registered with the coordinator.

    2. The DOM-fallback sweep in
       src/frontend/image/MediaReleaseCoordinator.ts releasePaths() decodes
       the Chromium-resolved <video>.src (which is the URL-parsed form
       file:///C:/Users/foo/bar.mp4 even when encodeFilePath produced
       file://C:\Users\foo\bar.mp4) and runs it through path.normalize on
       Windows. path.normalize('/C:/Users/foo/bar.mp4') returns
       \C:\Users\foo\bar.mp4 (leading backslash) — which never matches
       registry keys derived from f.absolutePath (C:\Users\foo\bar.mp4). The
       fallback that was meant to cover the registration miss does not match
       on Windows.

    3. SlideMode/index.tsx:328 creates an additional orphan
       document.createElement('video') for video-dimension probing. It is
       never registered with the coordinator. Its OS file handle persists
       until V8 GC finalizes the wrapper.

  Together (1) and (2) mean the gallery delete flow performs no <video>
  release at all on the path that the user is reporting. The main-process
  150ms retry is unable to compensate because the renderer never frees the
  handle. (3) is an additional latent handle-holder that the original
  investigation missed.

  Procedural finding: TASK-042 was marked DONE in commit 6b81a51 without any
  of its 9 manual-Windows verification steps actually being executed. Only
  the docs step (#10) was completed. The user's recent QA is the first
  real-world verification of the fix.

  See INV-014 for the full re-investigation and the corrected fix plan.
---

## Bug Report

### Observed Behavior

Users cannot delete video files from OneFolder when the video has been previewed. The failure path:

1. User has `galleryVideoPlaybackMode = 'hover'` (the default) or `'auto'`.
2. User hovers over a video thumbnail in the gallery (or opens it in SlideMode). OneFolder renders a native `<video>` element whose `src` attribute points at the video's absolute path via a `file://` URL (`encodeFilePath` in `common/fs.ts`).
3. Chromium's media pipeline opens the underlying file and begins streaming it for playback.
4. User selects the video and presses Delete / right-clicks → Delete file, confirming the Trash dialog.
5. The trash operation fails. The toast "Some files could not be deleted." appears and the dev console logs:
   `EBUSY: resource busy or locked, scandir <filepath>`
6. The file remains on disk and the DB record is also retained (`fileStore.deleteFiles` is only invoked for files where `RendererMessenger.trashFile` returned no error — see `src/frontend/components/RemovalAlert.tsx` lines 131-138).

The error text "scandir" is produced by `@nodelib/fs.scandir` (used internally by `readdirp`, which is used by chokidar's NodeFS handler — see `node_modules/chokidar/lib/nodefs-handler.js` `_handleRead` → `_readdirp`). When chokidar re-reads the parent directory after the attempted trash move and tries to stat the still-present-but-locked video file, scandir surfaces the Windows `ERROR_SHARING_VIOLATION` / `ERROR_LOCK_VIOLATION` as the Node `EBUSY` error. The underlying cause is the same whether the first failure is `shell.trashItem` or the post-trash rescan: **Chromium's `<video>` element has an open file handle on the video without `FILE_SHARE_DELETE`, so the Windows shell cannot relocate the file into `$Recycle.Bin` and any enumeration/stat of the locked file bubbles up as EBUSY.**

### Expected Behavior

When the user confirms deletion of one or more video files, OneFolder should:

1. Detect that any currently-visible or recently-previewed videos correspond to files being deleted.
2. Force those `<video>` elements to release their OS file handles BEFORE the trash IPC is invoked. The canonical way to do this in Chromium is:
   - `video.pause()` (not sufficient on its own)
   - `video.removeAttribute('src')` (clear the source)
   - `video.load()` (forces the media pipeline to tear down the active resource)
   - Optionally unmount the element from the DOM.
3. Invoke `shell.trashItem` only AFTER the renderer has been given a chance to tear down the video pipeline. A microtask/animation-frame flush is insufficient; the main process round-trip already provides enough delay, but we must still verify the handle has been released. A defensive retry-with-backoff in `main.ts` around `shell.trashItem` gives the media pipeline time to finish its teardown on slow machines.
4. On confirmed deletion, the FileStore should reflect the removal and chokidar should see the file disappear cleanly — no EBUSY rescan, no phantom "broken file" state.

This matches Windows Explorer's behavior: it closes its preview panel handle before invoking trash.

### Reproduction Context

**Deterministic.** On Windows (all versions), with:

- OS: Windows (confirmed per bug report; macOS/Linux use `FILE_SHARE_DELETE` more liberally so they typically do not exhibit this)
- `uiStore.galleryVideoPlaybackMode` set to `'hover'` (default) or `'auto'`
- Any video extension OneFolder supports (`webm`, `mp4`, `ogg` — see `common/fs.ts:isFileExtensionVideo`)
- Video thumbnail recently hovered OR currently in the viewport with `'auto'` mode OR currently displayed in SlideMode OR preloaded as next/previous in SlideMode (`src/frontend/containers/ContentView/SlideMode/index.tsx` lines 131-153)

Additional trigger surfaces (same root cause, same EBUSY):

- Duplicate Gallery per-row Delete button (`DuplicateGallery.tsx` lines 312, 446)
- Toolbar delete shortcut / Delete hotkey (`Main.tsx` line 61)
- Context menu "Delete file(s)" (`menu-items.tsx` line 231)
- Drag-and-drop moving a video between Locations (`useFileDnD.ts` line 98 `fse.move` — same handle-lock failure mode)

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

OneFolder's video preview path, introduced alongside hover/auto playback, wires the real filesystem path directly into a `<video>` element's `src`:

```tsx
// src/frontend/containers/ContentView/GalleryItem.tsx:234-246
const videoProps = {
  src: encodeFilePath(imageSource.value.ok), // file://<absolute path>
  ...
};
return <video ref={thumbnailRef} {...videoProps} />;
```

Chromium's media pipeline, when given a `file://` URL, opens the file via the platform file API with `GENERIC_READ` + `FILE_SHARE_READ` (on Windows). It notably does NOT include `FILE_SHARE_DELETE`. The handle persists as long as the element has an active media resource, which survives `.pause()`, survives `autoplay={false}`, and survives re-renders as long as the `src` attribute is unchanged and the element is mounted. The only reliable ways to release it in Chromium are:

1. Set `src = ''` (or `removeAttribute('src')`) AND call `video.load()` to kick off the state transition to `NETWORK_EMPTY`. A bare `.pause()` is NOT enough — the MediaResource stays loaded.
2. Remove the element from the DOM (React unmount). But React may not unmount immediately when the file is removed from `fileList` — there are frames of overlap.

The existing code has **no pathway that triggers either of these release actions at delete time.** `FileRemoval` / `MoveFilesToTrashBin` call `RendererMessenger.trashFile` immediately on confirm (`RemovalAlert.tsx:131`). There is no "quiesce media elements first" step and no observable signal the gallery components can subscribe to in order to proactively unload their video `<video>` refs.

Moreover, `SlideMode` has a preload path (`SlideMode/index.tsx:131-153`) that creates orphan `document.createElement('video')` elements and sets their `src` to the next/previous file. These orphan elements are **never explicitly released** — they're GC'd eventually, but before GC runs their file handles remain open. If the user advances past a video, the just-preloaded-but-not-mounted `<video>` still holds the handle for an indeterminate duration.

Additional contributing facts found during investigation:

- `ImageLoader.needsThumbnail()` returns `false` for videos (`ImageLoader.ts:81`), and `filesFromBackend()` accordingly sets `file.thumbnailPath = f.absolutePath` for videos (`FileStore.ts:1122-1124`). So the gallery's "thumbnail" for a video IS the original video file — meaning the gallery `<video>` element is always pointed at the actual file the user wants to delete, not a lighter-weight preview.
- `galleryVideoPlaybackMode === 'disabled'` would avoid opening the handle for hover-triggered playback, but the `<video>` element is still rendered with its `src` set (see line 242 — `autoPlay` is only gated, not the `src`), so Chromium still lazily opens the resource when the element enters the viewport. "Disabled" does not actually guarantee the file is unopened.
- The `<video>` `preload` attribute is not set in gallery contexts, so Chromium's default (`metadata` or `auto` depending on spec interpretation) will probe the file for its header as soon as the element mounts — independent of whether playback starts.

In short: **the architecture lacks a "release-media-handles-for-these-paths" hook**. There is nowhere to register an intent-to-delete that gallery/slide components can observe in order to free their `<video>` refs before the OS-level trash call. This is an architectural shortcoming, not a local bug in any single function.

### Diagnostic Questions Considered

- **Wrong mental model?** Partially. The code appears to assume that `pause()` and clearing `autoPlay` would free the media resource. That is the HTML mental model but NOT the Chromium-on-Windows reality. However, the primary defect is the missing quiesce hook, not a single wrong assumption.
- **Architectural shortcoming?** **Yes — primary cause.** There is no coordination layer between "a destructive file operation is about to run" and "components that hold OS handles on that file." The trash flow and the preview flow operate in isolation.
- **Incorrect order of operations?** Yes, as a consequence of the shortcoming above. The correct order is (1) quiesce media elements, (2) await the DOM/media pipeline teardown, (3) invoke trash. Current order is (1) invoke trash, (2) discover failure.
- **Missing edge case?** This touches it (the Windows file-share-delete case wasn't accounted for), but calling it merely an "edge case" understates the severity — it is the default Windows behavior for every video in the library.
- **Wrong abstraction?** The `<video>` being pointed at the real file (not a generated thumbnail) is defensible given transcoding cost, but it couples playback lifetime to file lifetime in a way that needs explicit management. A video-thumbnail-generation system would mitigate at the cost of disk space and CPU (tracked as future work in `docs/thumbnail-generation.md`).
- **Silent failure?** No — the failure is loud (toast + console). However, the retained DB record after a failed trash is a silent half-step that compounds the UX problem.

---

## Blast Radius

All of the following share the root cause "renderer holds OS file handle on file that the main process is trying to mutate":

1. **Gallery hover/auto video preview → Trash (main path from the bug report)** — `GalleryItem.tsx` `<video ref={thumbnailRef}>` keeps the handle open; `RemovalAlert.MoveFilesToTrashBin` calls `RendererMessenger.trashFile` without asking the gallery to release its ref. This is the reported scenario.

2. **SlideMode `<video>` → Trash** — `SlideMode/index.tsx:376-402` renders a `<video controls autoPlay loop src={encodeFilePath(src)}>` in the slide pane. If the user presses Delete while a video is in slide mode, the same EBUSY occurs. `uiStore.disableSlideMode()` is not called on delete, so the slide pane and its `<video>` may still be mounted during the trash IPC.

3. **SlideMode preload (`.next` / `.prev`) → Trash** — `SlideMode/index.tsx:131-153` creates orphan `document.createElement('video')` nodes and sets `.src`. These are held only by the closure and the effect's `isEffectRunning` guard. They are never proactively released; they linger until GC. If the file being deleted matches the preloaded src, EBUSY.

4. **Duplicate Gallery per-row delete** — `DuplicateGallery.tsx:312, 446` opens the same `MoveFilesToTrashBin` dialog. If any of the duplicate rows represent video files and are rendered via the shared `Thumbnail` component (same `<video>` codepath), delete fails identically.

5. **Keyboard shortcut / context menu delete** — `Main.tsx:61` and `menu-items.tsx:231` dispatch through `openMoveFilesToTrash`. Same dialog, same codepath, same failure. Notable because the shortcut makes the failure especially easy to trip: hover a video, hit Delete.

6. **FileRemoval (missing-file bulk delete)** — `RemovalAlert.tsx:85-118` deletes only files where `file.isBroken === true`, so in practice the file is already gone from disk and no handle could be held. Low exposure but the unified "quiesce-before-destructive" hook should still cover it for consistency.

7. **Drag-and-drop move between locations** — `useFileDnD.ts:98` uses `fse.move(src, dst, { overwrite: true })`. If `src` is a video currently being previewed, `fse.move` (which performs `rename` on Windows with `MOVEFILE_REPLACE_EXISTING`) will fail with EBUSY because the handle lacks `FILE_SHARE_DELETE`. The target file removal at line 81 (`fse.remove(dst)`) could also hit EBUSY if `dst` happens to be a previewed video. Same root cause.

8. **Drag-and-drop overwrite path** — Line 81 `fse.remove(dst)` when replacing an existing file. Same failure mode if the target is a previewed video.

9. **Chokidar folder watcher rescan after file ops** — When any of the above operations completes (or attempts to), chokidar's NodeFS handler will re-read the parent directory. `@nodelib/fs.scandir` with `stats: true` (default path) will `lstat` each entry. A video file whose handle is held by Chromium with `FILE_SHARE_READ` does NOT block lstat on most Windows configurations, but there is a known narrow window where Windows returns sharing violations for `FindNextFile` when the shell is mid-operation on the recycle bin move. This is likely the proximate source of the exact "scandir" error text.

10. **Post-failure database inconsistency** — `RemovalAlert.MoveFilesToTrashBin` only adds files to `files[]` for `fileStore.deleteFiles` when `trashFile` returns no error (line 132-134). When EBUSY fires, the file remains on disk AND remains in the DB. But the fleeting chokidar rescan error MAY have marked the file as broken in some races, producing a "phantom missing file" UI state. This is a secondary symptom of the same root cause.

11. **Thumbnail for videos IS the video file** — `ImageLoader.needsThumbnail()` returns `false` for video extensions, so `file.thumbnailPath = absolutePath` (FileStore.ts:1122-1124). The consequence: any code that touches `thumbnailPath` for a video touches the real file. This widens the blast radius of handle holding beyond the `<video>` element. Long-term fix: implement proper video frame-grab thumbnails (already noted as future work in `docs/thumbnail-generation.md`).

---

## UX / Requirements Specification

### Purpose

Ensure every destructive file operation (trash, move, delete, rename) that targets a video releases any Chromium media-pipeline handle on that file BEFORE the operation is attempted, so Windows does not return EBUSY. The user should never see a "video is busy" error; preview and delete should compose cleanly.

### User-Stated Design Decisions

1. **"There needs to be a way to unload the video when a delete is triggered."** — Rationale (explicit from bug report): the held handle is the root cause. The fix lives in the renderer and must release the handle before IPC.

2. **Hover-preview must remain functional.** — Rationale (implicit): preview is an existing feature that works. The fix must not disable hover preview; it must only unload at destructive-op time (or when the previewing element is no longer visible/in-focus).

3. **`scandir` hint from the user: investigate carefully — the error may surface from the post-op rescan, not the op itself.** — Rationale (explicit from bug report): user correctly anticipates that the fix must quiesce the handle not just past `shell.trashItem` but also past chokidar's rescan. Our plan must ensure the handle is released before the IPC fires so both paths succeed.

### Behavioral Specifications

- **Release trigger:** when the user confirms any destructive operation, the renderer must enumerate the set of affected absolute paths, find all live `<video>` elements in the document whose resolved `src` matches one of those paths, and for each:
  1. `video.pause()`
  2. `video.removeAttribute('src')`
  3. `video.load()` (triggers the media pipeline release)
- **Orphan preload videos:** the SlideMode preload path must track its created `<video>` nodes in a list and release them via the same sequence whenever the preloaded file's path appears in a destructive set. Simplest: keep the preloaded elements on the effect's ref and clear them on unmount AND on an event bus signal (see below).
- **Event bus / hook:** introduce a small pub/sub inside the renderer (e.g., `MediaReleaseCoordinator`) with `requestRelease(paths: string[]): Promise<void>` that:
  - Notifies all subscribed video-rendering components.
  - Awaits a microtask and a `requestAnimationFrame` tick so the DOM and Chromium's media pipeline can process the src clear.
  - Optionally waits for `emptied` events fired by the affected `<video>` elements (up to a short timeout, say 200 ms) for a tighter guarantee.
- **Integration point in trash flow:** `RemovalAlert.MoveFilesToTrashBin.handleConfirm` must `await mediaRelease.requestRelease(selectedPaths)` BEFORE iterating with `RendererMessenger.trashFile(file.absolutePath)`. The FileStore `deleteFiles` path stays the same.
- **Integration point in DnD flow:** `useFileDnD.handleMove` must `await mediaRelease.requestRelease([src, dst])` before the `fse.remove(dst)` and `fse.move(src, dst)` calls.
- **SlideMode delete integration:** if the user triggers delete while in SlideMode, the slide pane's `<video>` must be released first. Easiest implementation: register the slide `<video>` ref with the `MediaReleaseCoordinator` keyed by `file.absolutePath`; the delete flow will find and release it.
- **Defense in depth in main process:** `shell.trashItem` in `src/main.ts:688` should be wrapped with a single retry-with-brief-delay (e.g., 150 ms) on EBUSY/EPERM to handle the race window where the renderer claims release but Chromium's async pipeline hasn't finalized. This is belt-and-suspenders, not the primary fix. The retry must NOT mask persistent failures (log after exhausted retries; return the last error as today).
- **No behavior change for images.** The release coordinator only matters for `<video>` elements; images (via `<img>`) do not hold persistent file handles in the same way on Windows (Chromium reads the image bytes then closes the handle).

### Explicit Rejections

- **Don't disable hover preview to avoid the bug.** This degrades an existing feature.
- **Don't work around with a hard retry loop in main.ts alone.** Retries cannot succeed while the renderer keeps the handle open; masking with retries means the file eventually trashes only when React unmounts, which is racy and user-visible. The renderer-side release is mandatory.
- **Don't introduce a full video-thumbnail-generation system as part of this fix.** It's valuable future work (see `docs/thumbnail-generation.md`) but out of scope here — we need a targeted, shippable fix for the reported EBUSY.
- **Don't remove the IS_DEV warn or otherwise suppress the EBUSY toast.** The toast is correct signaling; we fix the cause.

---

## Holistic Solution

### Approach

Introduce a small renderer-side coordinator, `MediaReleaseCoordinator` (new file, e.g., `src/frontend/image/MediaReleaseCoordinator.ts`), that mediates between destructive-file-op code paths and the components that render `<video>` elements. Integrate it everywhere a file mutation can be issued from the renderer.

**Stages:**

1. **Add the coordinator (TASK-038).** New module exposing:
   - `register(absolutePath: string, videoEl: HTMLVideoElement): () => void` — components call this when they mount a video and get an unregister callback for unmount.
   - `releasePaths(paths: Iterable<string>, options?: { timeoutMs?: number }): Promise<void>` — destructive callers await this before IPC. Internally: pause, removeAttribute('src'), load() for each matching element; then wait for `emptied` events or a short timeout; also kick the main thread with a rAF.
   - Consider also a DOM sweep fallback: `document.querySelectorAll('video[src]')` and match decoded URLs against the path set, to cover orphan/pre-coordinator-era videos.

2. **Wire gallery Thumbnail videos (TASK-039).** In `GalleryItem.tsx` `Thumbnail`, inside the existing `useEffect`s that manipulate `thumbnailRef`, add a `register` call and return its unregister as the effect cleanup. Key the registration on `file.absolutePath`.

3. **Wire SlideMode videos, including preload (TASK-039).** In `SlideMode/index.tsx`:
   - Wrap the main `<video>` (lines 392-402) with a ref + register.
   - In the preload effect (lines 125-158), track every `document.createElement('video')` in a local ref-backed set, register them, and on effect teardown explicitly call the release sequence for each and clear the set.

4. **Integrate into trash flow (TASK-040).** In `RemovalAlert.tsx` `MoveFilesToTrashBin.handleConfirm`, before the `for` loop over `selection`, collect video paths and `await MediaReleaseCoordinator.releasePaths(...)`. Same treatment in `FileRemoval.handleConfirm` for completeness (even though missing files don't have live handles).

5. **Integrate into DnD move flow (TASK-040).** In `useFileDnD.ts` `handleMove`, before `fse.remove(dst)` and `fse.move(src, dst)`, call `MediaReleaseCoordinator.releasePaths([src, dst])`.

6. **Main-process defensive retry (TASK-041).** In `src/main.ts:688`, wrap `shell.trashItem(absolutePath)` with a single retry after ~150 ms when the rejection error code matches `EBUSY` / `EPERM`. Surface the final error unchanged. This catches races where the renderer claims release but the media pipeline is still winding down.

7. **QA (TASK-042).** Manual repro matrix: hover preview + delete, hover preview + DnD move, auto mode + delete, SlideMode + delete, SlideMode preload + delete-next-file, Delete hotkey + delete, Duplicate Gallery delete button. Each on Windows. Verify no EBUSY toast and no retained DB record. Sanity-check images still delete without regression.

### Expected Outcomes

- Reported bug (deleting previewed videos) is fixed on Windows for all entry points listed in Blast Radius items 1-5.
- DnD move of a previewed video between locations succeeds (Blast Radius item 7-8).
- DB stays consistent: no orphan records left behind when trash succeeds; nothing changes when trash legitimately fails for an unrelated reason.
- macOS/Linux behavior unchanged (the coordinator is a no-op fast path when no handle was actually held; `releasePaths` still pauses and resets `<video>` elements but that's harmless).
- Hover/auto preview UX fully preserved.

### Risks and Tradeoffs

- **Coordinator adds coupling.** A small pub/sub is the right weight; the alternative (a global `AbortSignal`-style bus) is heavier. Acceptable.
- **Release adds latency before trash IPC.** A few ms at most in the typical case; ~200 ms cap in the worst case. Users already wait on the confirmation dialog; this is invisible.
- **DOM `querySelectorAll('video[src]')` fallback in the coordinator scans the whole doc.** Fine at our scale (~tens of videos in view at once). If it ever becomes hot, keep only the explicit registry path.
- **Main-process retry might mask a different EBUSY cause** (e.g., AV software scanning). Mitigation: single retry only, return the original error otherwise. Document in the main.ts comment.
- **Orphan preload videos were never explicitly released before.** Adding explicit release is a de-facto memory/handle-leak fix. Low regression risk.
- **We do not generate proper video thumbnails here.** That's a separate, bigger project (see `docs/thumbnail-generation.md` future work). The EBUSY bug doesn't require it.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: `docs/thumbnail-generation.md` will get a short cross-reference once TASK-042 QA confirms the fix — noting the existing "Videos: Currently use original (future enhancement planned)" line now has an EBUSY-mitigation consequence. Added as part of TASK-042.
