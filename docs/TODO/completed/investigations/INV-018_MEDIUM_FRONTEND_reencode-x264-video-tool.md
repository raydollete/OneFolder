---
id: INV-018
title: 'Add a "Re-encode (x264)" video tool to the inspector that shells out to ffmpeg, copies tags to the output, auto-opens the result, prompts to delete the original, and locks the UI while running'
reported_bug: 'Feature request: When viewing a video, the right-side inspector "Tools" section should offer a "Re-encode (x264)" tool. Clicking it runs `ffmpeg -i [input] -c:a copy -c:v libx264 [output]`, writes a .mp4 next to the source with an auto-incremented name, copies the source file''s tags (DB + EXIF/XMP) onto the output, auto-opens the new file in the player, then pops a modal asking whether to delete the original. While ffmpeg runs, an animated indicator must show progress and the user must not be able to navigate away, edit, or delete the source.'
date: 2026-06-11
status: resolved
superseded_by:
tasks_spawned: [TASK-074, TASK-075, TASK-076, TASK-077, TASK-078, TASK-079, TASK-080]
root_cause_category: architectural-shortcoming
affects:
  - 'Inspector Tools section (src/frontend/components/ImageTools.tsx) — currently a static list of FOUR permanently-disabled placeholder buttons (dormant tools that do nothing) plus a canny.io feedback link; has no mechanism to run an action against the current file or to gate a button on file type. Per the added requirement, the dormant placeholders are REMOVED so the list contains only functional tools.'
  - 'External-binary invocation (common/ExifIO.ts:51-57, common/fs.ts:72-75 getExtraResourcePath) — only ExifTool is bundled today; no ffmpeg binary, no ffmpeg path resolution, no generic "run a long subprocess with progress" pathway'
  - 'IPC layer (src/ipc/messages.ts, src/ipc/renderer.ts, src/ipc/main.ts) — no channel exists for starting/cancelling a long-running subprocess or streaming progress/completion events back to the renderer'
  - 'electron-builder packaging (package.json build.win.extraResources) — only exiftool is shipped as an extra resource; ffmpeg would need to be bundled the same way for the portable-only fork'
  - 'File ingestion (src/frontend/stores/LocationStore.ts:504-531 addFile, folderWatcher.worker.ts) — the output .mp4 lands in a watched folder and is ingested asynchronously (chokidar add -> addFile -> createFilesFromPath -> debouncedRefetch, ~200-300ms); there is no "wait for this specific path to be ingested" primitive needed to then select it'
  - 'Tag copy (src/frontend/entities/File.ts addTag/disableImmediateSync, common/ExifIO.ts:480-535 writeTags) — copying tags onto a brand-new sibling file requires both the DB tag set and an EXIF/XMP writeback, because ffmpeg with -c:v libx264 does not carry over HierarchicalSubject/Subject/Keywords'
  - 'Programmatic select/open (src/frontend/stores/UiStore.ts selectFile/setFirstItem/enableSlideMode) — needed to make the freshly-ingested output the viewed file'
  - 'Delete-original prompt (src/frontend/components/RemovalAlert.tsx, widgets/popovers/Alert.tsx, RendererMessenger.trashFile) — the existing Recycle-Bin trash flow must be reused for the "delete original?" prompt'
  - 'Global navigation / hotkeys / delete (src/frontend/stores/UiStore.ts processGlobalShortCuts, SlideMode/index.tsx arrow-key handler, RemovalAlert MoveFilesToTrashBin) — there is no global "busy" flag; navigation, edit, and delete must be blocked for the duration of the encode'
  - 'App lifecycle (src/main.ts — no before-quit handler) — an in-flight ffmpeg child and its partial output file must be cleaned up if the app quits or the encode fails mid-stream'
---

## Bug Report

### Observed Behavior

OneFolder has no video re-encoding capability. The inspector "Tools" section
(`src/frontend/components/ImageTools.tsx`) renders four permanently-disabled
placeholder buttons ("HEIC to JPEG", "Optimize JPEG", "Fix red eyes",
"Colorize black and white image") and a "Let us know" feedback link. None of
them do anything; the component receives the current file as a prop but never
acts on it, and there is no file-type gating. (Implementation note: the
component's internal function/props are misnamed `ImageDuplicates` /
`ImageDuplicatesProps` from a copy-paste; it is nonetheless the Tools component
mounted at `Inspector/index.tsx:83`. It is distinct from the separate
`src/frontend/components/ImageDuplicates.tsx`, whose own inspector section is
commented out and is NOT part of this work.)

Separately, the user has asked that the dormant/placeholder tools be removed
entirely: after this work the Tools list must contain only functional tools.
Today every entry in the list is a permanently-disabled stub, so the list is
pure dead UI.

Separately, the app ships no ffmpeg binary and has no code path for running a
long external subprocess with progress reporting — the only bundled binary is
ExifTool (`common/ExifIO.ts:51-57`), invoked through `@logion/node-exiftool`.

### Expected Behavior

This is a feature request, not a defect. When the currently-viewed file is a
video, the inspector "Tools" section must show a new, enabled tool labelled
**"Re-encode (x264)"**. Clicking it must:

1. Run `ffmpeg -i [input_video] -c:a copy -c:v libx264 [output_video]` as a
   subprocess in the Electron main process.
2. Produce an output file that:
   a. Always has a `.mp4` extension, regardless of the source extension.
   b. Lands in the same folder as the source, with an auto-incremented name on
      collision (e.g. `clip.mp4` -> `clip 1.mp4`), using whatever
      collision/increment convention the codebase already uses if one exists.
   c. Carries over all of the source file's tags — both the OneFolder DB tag
      set and the EXIF/XMP metadata (HierarchicalSubject / Subject / Keywords).
3. On completion:
   a. Auto-open the new file in the player (it becomes the selected/viewed
      file in SlideMode).
   b. Pop a modal asking whether to delete the original; "yes" routes through
      the existing Recycle-Bin trash flow.
4. While ffmpeg runs:
   a. Show an animated indicator (spinner/progress).
   b. Block the user from navigating away from the file, editing it, or
      deleting the source.

Error handling: ffmpeg failure, app quit mid-encode, and partial-output
cleanup must all be handled.

### Reproduction Context

Not applicable (new feature). Scope: the tool is only offered for files where
`isFileExtensionVideo(file.extension)` is true. Note that
`common/fs.ts:46-48` currently recognizes only `webm`, `mp4`, `ogg` as video
extensions — these are exactly the formats the HTML5 `<video>` player can show
in SlideMode, so the tool is naturally scoped to playable videos. If the user
later wants to re-encode non-playable source formats (e.g. `mkv`, `avi`,
`mov`), `isFileExtensionVideo` would need to be widened — flagged as a future
consideration, out of scope here.

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

The feature does not exist, and the reason it is non-trivial is that OneFolder
lacks the architectural scaffolding for **"a user-initiated, long-running,
cancellable subprocess that reports progress, mutates the watched filesystem,
and then re-selects its own output."** Each of the seven sub-capabilities the
request needs maps to a gap in the current architecture:

1. **No actionable, type-gated inspector tool.** `ImageTools.tsx` is a static
   stub. It already receives `file: ClientFile` (wired from
   `Inspector/index.tsx:28` as `fileStore.fileList[uiStore.firstItem]`), but
   every button is `disabled={true}` and there is no `onClick` that runs an
   operation, and no `isFileExtensionVideo(file.extension)` gate. There is no
   existing "active tool" to copy; the closest precedent is the inline
   `shell.openExternal` button in the same file.

2. **No second bundled binary and no long-subprocess pathway.** Only ExifTool
   is bundled (`package.json` win.extraResources) and located via
   `getExtraResourcePath` (`common/fs.ts:72-75`). ExifTool is driven through a
   third-party wrapper that keeps a `-stay_open` daemon; there is no generic
   `child_process` helper in the main process for "spawn this binary, stream
   its progress, resolve on exit, allow cancellation." The only
   `child_process.spawn` in the codebase is `forceRelaunch` in
   `src/main.ts:1074-1097`, which relaunches the app itself.

3. **No progress/streaming IPC.** The IPC layer
   (`src/ipc/{messages,renderer,main}.ts`) supports fire-and-forget `send`,
   request/response `invoke`, and a few main->renderer push events
   (`fullscreenChanged`, `sendPreviewFiles`), but nothing for a *stream* of
   progress events tied to a job id, nor a cancel channel.

4. **Ingestion is fire-and-forget.** When a file appears in a watched folder,
   `folderWatcher.worker.ts` posts an `add`, `ClientLocation` forwards it to
   `LocationStore.addFile` (`:504-531`), which inserts via
   `createFilesFromPath` and calls `fileStore.debouncedRefetch()` (200 ms
   debounce). There is no promise that resolves "file X is now a ClientFile in
   fileList," so the tool can't deterministically wait to select the output.

5. **Tag copy onto a new file is not a primitive.** Tags live in two places:
   the DB tag-id set on the FileDTO/ClientFile, and the EXIF/XMP metadata that
   `ExifIO.writeTags` (`common/ExifIO.ts:480-535`) writes as
   HierarchicalSubject/Subject/Keywords. `ffmpeg -c:v libx264` does NOT carry
   metadata across, so both halves must be set explicitly on the output.
   `pathToIFileWithMetadata` (`LocationStore.ts:635-697`) can read tags from a
   file's metadata during ingestion, which means: if we write the source's
   tags into the output's metadata *before* it is ingested, the watcher can
   pick them up — but ingestion uses plain `pathToIFile` (no tag read), so we
   must instead attach tags after ingestion, on the renderer side, and also
   write them to the output's metadata.

6. **No global "busy"/lock.** `UiStore` has only per-dialog open/close flags
   (`isMoveFilesToTrashOpen`, etc.). `processGlobalShortCuts`
   (`UiStore.ts`) and the SlideMode arrow-key handler
   (`SlideMode/index.tsx`) navigate freely; the Delete hotkey opens the trash
   modal unconditionally. Nothing today can say "an operation owns this file,
   freeze navigation/edit/delete."

7. **No mid-operation lifecycle cleanup.** `src/main.ts` has no `before-quit`
   / `will-quit` handler. An ffmpeg child and its half-written output would be
   orphaned on quit, and a failed/cancelled encode would leave a partial
   `.mp4` next to the source.

The unifying root cause is architectural: the app is built around quick,
synchronous-feeling mutations (tag edits, deletes, moves) and has no concept
of a **tracked background job** with progress, a UI lock, output re-ingestion,
and lifecycle cleanup. Building the feature well means introducing a small,
reusable "media job" capability rather than bolting an ad-hoc spawn onto a
button.

### Diagnostic Questions Considered

- **Wrong mental model?** No prior code to be wrong; this is greenfield.
- **Architectural shortcoming?** **Yes — primary.** No background-job
  abstraction, no second-binary pathway, no progress IPC, no UI lock, no
  ingestion-await, no lifecycle cleanup.
- **Incorrect order of operations?** Relevant to the design: the correct order
  is (1) lock UI, (2) compute collision-free output path, (3) spawn ffmpeg
  with progress, (4) on success write tags to output metadata, (5) wait for
  the watcher to ingest the output, (6) copy DB tags onto the ingested
  ClientFile, (7) select+open it, (8) unlock UI, (9) prompt to delete original.
  Getting this order wrong (e.g. selecting before ingestion, or writing DB
  tags before the ClientFile exists) is the main implementation hazard.
- **Missing edge case?** Many, by nature: output collision, ffmpeg missing,
  ffmpeg non-zero exit, app quit mid-encode, source already `.mp4`, zero-tag
  source, very large files (long encodes), source on a non-recyclable drive.
- **Wrong abstraction?** The temptation is to spawn ffmpeg directly from the
  renderer. Rejected: subprocess management belongs in main (matches ExifTool;
  survives renderer reloads; needed for before-quit cleanup).
- **Silent failure?** A risk to design against: ffmpeg writes to stderr, exits
  non-zero on failure; we must surface that as a toast/modal, not swallow it.

---

## Blast Radius

Because this is additive, the "blast radius" is the set of subsystems the
feature must touch and the existing behaviors it must not break.

1. **Inspector Tools (`ImageTools.tsx`, `Inspector/index.tsx:28`,
   `resources/style/inspector.scss:217-230`).** REMOVE the four dormant
   placeholder buttons (`disabled` HEIC->JPEG / Optimize JPEG / Fix red eyes /
   Colorize) so the list holds only functional tools; add the new enabled,
   video-gated "Re-encode (x264)" button plus a spinner/progress sub-view. For
   non-video files the list is then empty — show a neutral caption (see UX
   consideration below). Dead-code check: the icons
   `IconSet.CARROT` / `EYE_LOW_VISION` / `PALETTE` were referenced ONLY by these
   buttons, but they are shared entries in `widgets/icons.tsx`'s `IconSet`;
   leave the definitions (harmless unused library entries, consistent with the
   codebase). `IconSet.INTELLIGENCE` is still used by `DuplicateGallery.tsx`.
   Keep the `IconSet` import (the new button uses an icon); REMOVE the now-unused
   `import { shell } from 'electron'` once the canny "Let us know" block goes
   (that block's removal is shared with TASK-030 / INV-006 — reconcile, do not
   double-remove). The `.tools` SCSS block is generic (flex column + button
   radius) and needs no change. No i18n strings, tests, or snapshots reference
   the placeholder labels (verified), so removal leaves no dangling refs.

2. **Binary bundling (`package.json` build config; `resources/`).** Add an
   ffmpeg binary as an extra resource for the portable Windows target,
   resolved via `getExtraResourcePath('ffmpeg/ffmpeg.exe')`. Risk: portable
   artifact size grows (~80-100 MB). Must keep `asarUnpack`/`extraResources`
   semantics intact so ExifTool still resolves.

3. **Main-process subprocess runner (new module under `src/` or `common/`,
   wired in `src/main.ts`).** `child_process.spawn` of ffmpeg with `-progress`
   parsing, a job registry keyed by id, kill-on-cancel, and kill+cleanup on
   `before-quit`. Must not interfere with the existing `forceRelaunch` spawn or
   ExitTool daemon.

4. **IPC (`src/ipc/messages.ts`, `renderer.ts`, `main.ts`).** New channels:
   start-reencode (invoke -> returns job id / final result), progress (main ->
   renderer stream), cancel (send). Follow the existing static-method pattern;
   do not change existing channels.

5. **Output path computation (new helper; consider co-locating with
   `common/fs.ts`).** ".mp4 extension + same dir + auto-increment on
   collision." Investigate for an existing increment helper before writing a
   new one; none was found in `common/fs.ts` (which has thumbnail-path and
   encode helpers but no "unique sibling name" function), so a new helper is
   expected. Must use the `name (n).ext` convention the request cites.

6. **Tag copy (`src/frontend/entities/File.ts` addTag/disableImmediateSync;
   `common/ExifIO.ts:480-535` writeTags).** After encode: write the source's
   `Array.from(sourceFile.tags, t => t.path)` hierarchy to the output via
   `exifTool.writeTags(outputPath, hierarchy)`; after ingestion, add the same
   `ClientTag`s to the output `ClientFile` with `disableImmediateSync()`
   wrapping the loop (so we don't double-write metadata). Must not corrupt the
   source's metadata or counts.

7. **Ingestion-await + select/open (`LocationStore.addFile`,
   `UiStore.selectFile/setFirstItem/enableSlideMode`,
   `FileStore.fileList`).** Need a bounded wait (MobX `reaction` on
   `fileList.find(f => f.absolutePath === outputPath)` with a timeout) then
   `selectFile(file, true)` + `enableSlideMode()`. Must not race the 200 ms
   `debouncedRefetch`. Risk: if the output folder is not inside any watched
   location, it will never be ingested — must detect and surface this.

8. **Delete-original prompt (`RemovalAlert.tsx` MoveFilesToTrashBin pattern,
   `widgets/popovers/Alert.tsx`, `RendererMessenger.trashFile` /
   `checkRecyclable` / `deleteFilePermanently`,
   `MediaReleaseCoordinator.releasePaths`).** Reuse the Alert widget and the
   exact trash flow, including the `mediaReleaseCoordinator.releasePaths`
   call before trashing (INV-008) and the recyclable check (INV-014). Must not
   delete the source until the user confirms.

9. **UI lock (`UiStore` new `isMediaProcessing`/job flag,
   `processGlobalShortCuts`, `SlideMode/index.tsx` key handler, delete
   triggers in `RemovalAlert`/menu-items/Main.tsx).** A new observable that,
   when set, makes `processGlobalShortCuts` early-return for nav/delete combos,
   disables SlideMode arrow handlers, and disables the delete entry points.
   Must fully release on success, failure, AND cancel.

10. **App lifecycle (`src/main.ts` before-quit; partial-output cleanup in the
    runner).** Kill the ffmpeg child and `fse.remove` the partial output on
    quit/cancel/failure. Must not block a normal quit indefinitely.

11. **`isFileExtensionVideo` (`common/fs.ts:46-48`).** Read-only dependency for
    gating; widening it is out of scope but noted (see Reproduction Context).

---

## UX / Requirements Specification

### Purpose

Give the single user of this fork a one-click way to transcode any playable
video to a broadly-compatible H.264 MP4 in place, preserving their tagging
work, without leaving the viewer or hand-managing files, and without the risk
of fiddling with the file while the encode is in flight.

### User-Stated Design Decisions

1. **Tool name is exactly "Re-encode (x264)"** and it lives in the inspector
   right-panel "Tools" section. Rationale: that is where the user expects
   per-file tools.
2. **Exact ffmpeg command:** `ffmpeg -i [input_video] -c:a copy -c:v libx264
   [output_video]`. Rationale: copy audio untouched, re-encode video to H.264.
   (Implementation note: the runner will append `-progress pipe:1` /
   `-nostats` for machine-readable progress and `-y`/explicit no-overwrite as
   appropriate, and `-hide_banner` — these are transport flags around the
   user's stated codec args, not a change to them.)
3. **Output is always `.mp4`,** regardless of source extension. Rationale:
   libx264 in an MP4 container is the compatibility target.
4. **Output sits beside the source with an auto-incremented name on
   collision,** matching the existing convention (`video.mp4` ->
   `video 1.mp4`). Rationale: keep the new file discoverable next to the old.
5. **All source tags copy to the output — DB and metadata.** Rationale: the
   re-encode is conceptually the "same" asset; tagging work must not be lost.
6. **The output auto-opens in the player** after encoding. Rationale: immediate
   confirmation and continued viewing.
7. **A modal then asks whether to delete the original,** reusing the
   Recycle-Bin delete flow. Rationale: re-encoding usually supersedes the
   original, but the user decides per-file; deletion must be recoverable
   (Recycle Bin), consistent with this fork's delete philosophy.
8. **An animated indicator shows during the encode.** Rationale: encodes are
   slow; the user needs to see it is working.
9. **Navigation, edit, and delete of the source are blocked during the
   encode.** Rationale: prevent the user from moving/deleting/retagging the
   file ffmpeg is actively reading, and prevent racing the auto-open.
10. **Remove all dormant/placeholder tools from the Tools list (added
    requirement).** After implementation the Tools section must contain only
    functional tools — i.e. the new "Re-encode (x264)" button and nothing that
    is permanently disabled. Rationale: the four existing buttons ("HEIC to
    JPEG", "Optimize JPEG", "Fix red eyes", "Colorize black and white image")
    are dead UI that do nothing; a list of disabled stubs is misleading. They
    are deleted, not hidden.

### UX Consideration — empty Tools section for non-video files

Once the dormant placeholders are removed, "Re-encode (x264)" is the only tool
and it is video-only (`isFileExtensionVideo`). For image (non-video) files the
Tools list therefore renders empty. Two options were weighed:

- **(A, chosen)** Render a neutral one-line caption ("No tools available for
  this file type.") inside the Tools body for non-video files. Locally contained
  in `ImageTools.tsx`; no cross-component change; the collapsible Tools section
  still appears (consistent with the other always-present inspector sections).
  No canny.io / "Let us know" CTA (this fork strips those — INV-006/TASK-030).
- **(B, deferred)** Hide the entire collapsible Tools <section> header for
  non-video files. This is owned by `Inspector/index.tsx`'s static
  `InspectorToggleSection` list (the Tools section is mounted unconditionally at
  `:78-84`); making it file-type-aware would require threading
  `isFileExtensionVideo(first.extension)` into that list and is a broader change
  touching how inspector sections are composed. Flagged as a possible future
  follow-up, OUT OF SCOPE for INV-018.

### Behavioral Specifications

**Happy path (source `vacation.mov` with tags `[Travel/Italy, 2025]`):**

1. User is viewing `vacation.mov` in SlideMode; inspector Tools shows
   "Re-encode (x264)" (enabled because the file is a video).
2. User clicks it. UI lock engages: arrow keys, Space, Delete, and the tool
   buttons stop responding; the SlideMode nav and inspector edit controls are
   disabled. A spinner with progress (percent or elapsed/ETA derived from
   ffmpeg `-progress`) appears in the Tools section.
3. Main process computes output path: same dir as source, base name
   `vacation`, extension forced to `.mp4`; if `vacation.mp4` exists, use
   `vacation 1.mp4`, then `vacation 2.mp4`, etc.
4. Main spawns `ffmpeg -hide_banner -i "vacation.mov" -c:a copy -c:v libx264
   -progress pipe:1 -nostats "vacation 1.mp4"`, streaming progress to the
   renderer.
5. On exit code 0: main writes the source's tag hierarchy into the output's
   EXIF/XMP via `ExifIO.writeTags` (or the renderer does, after the file
   handle is free). The watcher ingests `vacation 1.mp4` into fileList.
6. Renderer waits (bounded, e.g. 10 s) for the output ClientFile to appear,
   then copies the source's `ClientTag`s onto it (with immediate-sync disabled
   so metadata isn't re-written redundantly), selects it, and ensures
   SlideMode shows it.
7. UI lock releases.
8. A modal appears: "Re-encode complete. Delete the original `vacation.mov`?"
   with "Delete Original" / "Keep Original". "Delete Original" runs the
   existing trash flow (release media handles -> recyclable check -> trashFile
   -> fileStore.deleteFiles).

**Source is already `.mp4` (`clip.mp4`):** Output base name collides
immediately; result is `clip 1.mp4`. Everything else identical.

**Zero-tag source:** Steps 5-6 are no-ops for tags; output simply has no tags.
`ExifIO.writeTags` with an empty hierarchy is a valid "clear tags" call and is
safe to skip entirely when the source has no tags.

**ffmpeg fails (non-zero exit / stderr error):** UI lock releases; the partial
output (if any) is deleted; an error toast/modal shows a short message plus the
tail of ffmpeg stderr; the source is untouched; no delete prompt.

**User cancels (if a Cancel affordance is offered on the spinner):** ffmpeg
child is killed, partial output removed, UI lock released, source untouched.

**App quits mid-encode:** `before-quit` kills the child and removes the partial
output; quit proceeds.

**Output folder is not inside a watched location** (edge): ingestion never
fires. After the bounded wait times out, surface a toast ("Encoded to <path>
but it is outside a watched folder; tags not attached") and release the lock.
Source untouched. (For this single-user fork the source's own folder is by
definition watched, so this is a defensive path, not the norm.)

### Explicit Rejections

- **Do not spawn ffmpeg from the renderer.** Subprocess lifecycle lives in
  main (consistent with ExifTool; required for before-quit cleanup and to
  survive renderer reloads).
- **Do not rely on ffmpeg to preserve tags.** `-c:v libx264` drops metadata;
  tags must be written explicitly to the output.
- **Do not overwrite an existing sibling file.** Always auto-increment; never
  pass a path that would clobber.
- **Do not auto-delete the original.** Deletion is always user-confirmed and
  always via the Recycle-Bin flow (never a hard delete unless the drive lacks a
  Recycle Bin, matching INV-014 handling).
- **Do not change the user's stated codec arguments** (`-c:a copy -c:v
  libx264`). Only transport/progress flags may be added around them.
- **Do not introduce a global modal "blocker" overlay if a scoped lock
  suffices.** Prefer disabling the specific nav/edit/delete affordances + an
  observable flag over a full-screen blocking overlay, to keep the UI honest
  about what is frozen.
- **Do not widen `isFileExtensionVideo`** as part of this work (would expose
  the tool — and the player — to formats SlideMode can't render). Out of scope.
- **Do not keep the dormant placeholder tools** (HEIC->JPEG, Optimize JPEG, Fix
  red eyes, Colorize). They are deleted, not merely hidden. The Tools list must
  show only functional tools.
- **Do not delete the shared `IconSet` icon definitions** (`CARROT`,
  `EYE_LOW_VISION`, `PALETTE`) when removing the buttons — they live in the
  `widgets` library; unused library entries are left as-is.
- **Do not hide the whole Tools <section> for non-video files** as part of this
  work — use a neutral in-body caption (Option A above). Section-level
  conditional rendering in `Inspector/index.tsx` is a deferred follow-up.
- **Do not re-introduce a canny.io / "Let us know" CTA** in the Tools section
  (this fork strips feedback links — INV-006/TASK-030).

---

## Holistic Solution

### Approach

Introduce a small **media-job** capability and wire the tool on top of it,
split into seven ordered tasks (TASK-074 .. TASK-080). Build the plumbing
bottom-up (binary -> runner -> IPC -> helpers) before the UI, then QA + docs.

1. **TASK-074 — Bundle ffmpeg + path resolver.** Add the ffmpeg binary under
   `resources/ffmpeg/` and declare it in `package.json` build config
   (`win.extraResources`), mirroring exiftool. Add `getFfmpegPath()` (next to
   or reusing `getExtraResourcePath`) and a dev fallback. Verify the path
   resolves in both `yarn dev` and the portable package.

2. **TASK-075 — Main-process ffmpeg job runner.** New module (e.g.
   `src/ReEncodeManager.ts` or `common/ffmpeg.ts`) that: computes a
   collision-free `.mp4` output path beside the source (new
   `getUniqueSiblingPath(dir, base, ext)` helper — `name`, `name 1`,
   `name 2`...); spawns ffmpeg with `-hide_banner -progress pipe:1 -nostats`;
   parses `out_time_ms`/`progress=end` for percent (probe source duration via a
   first `ffmpeg -i` stderr parse or `ffprobe` if bundled); maintains a job
   registry keyed by id; supports `cancel(id)` (SIGKILL + remove partial
   output); on failure removes partial output; registers a `before-quit`
   handler that kills all live jobs and cleans their partials. Returns
   `{ outputPath }` on success.

3. **TASK-076 — IPC channels for the job.** Add to `src/ipc/messages.ts`,
   `renderer.ts`, `main.ts`: `START_REENCODE` (invoke: `{inputPath}` ->
   `{jobId}` then final `{outputPath}` or error), `REENCODE_PROGRESS`
   (main->renderer stream: `{jobId, percent, ...}`), `CANCEL_REENCODE` (send:
   `{jobId}`). Provide `RendererMessenger.startReencode`,
   `onReencodeProgress(cb): unsubscribe`, `cancelReencode`. Wire the main
   handlers to the runner from TASK-075 in `src/main.ts` init.

4. **TASK-075 — UI lock + ingestion-await + tag-copy + select.** In `UiStore`
   add `@observable mediaProcessing` (e.g. `{ active: boolean; path: string |
   null }`) with `beginMediaProcessing(path)` / `endMediaProcessing()`
   actions; gate `processGlobalShortCuts` (nav + delete combos early-return
   when active) and the SlideMode arrow/Delete handlers; disable the delete
   entry points (RemovalAlert open paths / menu-items / Main.tsx Delete) while
   active. Add a renderer helper `waitForIngestedFile(absolutePath, timeoutMs)`
   using a MobX `reaction` over `fileStore.fileList`. Add a `copyTagsToFile`
   helper that writes the source hierarchy to the output metadata
   (`exifTool.writeTags`) and adds the source `ClientTag`s to the output
   `ClientFile` under `disableImmediateSync()`. After ingest: `selectFile` +
   `enableSlideMode`.

5. **TASK-078 — Remove dormant placeholders + inspector tool + spinner +
   orchestration.** In `ImageTools.tsx`, delete the four disabled placeholder
   buttons (and reconcile the canny "Let us know" block / `shell` import with
   TASK-030) so the Tools list holds only functional tools, then add an enabled
   "Re-encode (x264)" button gated by `isFileExtensionVideo(file.extension)`,
   with a neutral "no tools for this file type" caption for non-video files.
   On click, orchestrate: `beginMediaProcessing(file.absolutePath)` ->
   `RendererMessenger.startReencode` -> render the existing CSS spinner
   (`.loading-spinner`, see `resources/style/duplicate-gallery.scss`) with live
   progress from `onReencodeProgress` -> on success run the TASK-077 tag-copy +
   select chain -> `endMediaProcessing()` -> open the delete-original Alert.

6. **TASK-079 — Delete-original prompt reusing the trash flow.** Add a
   `ReEncodeDeleteOriginal` Alert (mirroring `RemovalAlert.MoveFilesToTrashBin`
   confirm logic: `mediaReleaseCoordinator.releasePaths` ->
   `checkRecyclable` -> `trashFile`/`deleteFilePermanently` ->
   `fileStore.deleteFiles([source])`). Driven by a `UiStore` open/close flag
   set after a successful encode. "Keep Original" just closes.

7. **TASK-080 — QA (REQUIRES MANUAL EXECUTION ON WINDOWS) + docs.** Manual
   matrix in the portable build: video tool visibility (video vs image),
   happy-path encode with tags, `.mp4` source increment, zero-tag source,
   ffmpeg-failure path, cancel, quit-mid-encode partial cleanup, UI-lock
   enforcement (keys/delete inert during encode), delete-original via Recycle
   Bin, output auto-opens. Capture evidence per QA-DISCIPLINE.md. Add a
   `docs/reencode-x264.md` describing the feature, the ffmpeg bundling, and the
   media-job lock model; link it from `docs/index.md` and the personal-fork
   notes.

### Expected Outcomes

- A working, video-only "Re-encode (x264)" tool that transcodes in place,
  preserves tags (DB + EXIF/XMP), auto-opens the result, and offers a
  Recycle-Bin delete of the original.
- A reusable main-process media-job runner (spawn + progress + cancel +
  before-quit cleanup) that future video tools (the existing "Video filter" /
  "freeze recovery" themes suggest more will come) can build on.
- A reusable `UiStore.mediaProcessing` lock that any future long operation can
  use to freeze nav/edit/delete.
- A Tools section that contains only functional tools: the dormant placeholder
  buttons are gone, "Re-encode (x264)" is the sole entry (video-only), and
  non-video files get a neutral caption instead of an empty body.
- No regression to ExifTool resolution, existing IPC, or the delete flow.

### Risks and Tradeoffs

- **Portable artifact size.** Bundling ffmpeg adds ~80-100 MB. Acceptable for a
  single-user fork; documented in TASK-074. Alternative (download-on-first-use)
  rejected as over-engineering for one machine.
- **Progress accuracy.** ffmpeg progress needs a known total duration; probing
  it adds a step. If duration probing fails, fall back to an indeterminate
  spinner (elapsed time only) rather than blocking the feature.
- **Ingestion race / outside-watched-folder.** The renderer must not assume the
  output appears instantly; the bounded `reaction` wait + timeout handles both
  the 200 ms debounce and the defensive "not watched" case.
- **Double metadata write.** Writing tags to the output metadata in main AND
  via `addTag` immediate-sync would write twice and could race the ffmpeg file
  handle. Mitigation: write metadata once (after ffmpeg's handle is closed) and
  add the ClientTags under `disableImmediateSync()`.
- **Lock leak.** If an exception escapes the orchestration, the UI could stay
  frozen. Mitigation: wrap the whole renderer orchestration in try/finally that
  always calls `endMediaProcessing()`.
- **Cross-store writes.** The lock and select logic touch `UiStore`,
  `FileStore`, `TagStore`, and `ExifIO` together; idiomatic for this codebase
  (e.g. `RemovalAlert` already coordinates several stores) but warrants
  comments at the boundaries.
- **ffmpeg licensing.** Shipping an ffmpeg build with libx264 implies GPL
  obligations. Acceptable for a private, non-distributed fork; flagged in
  TASK-074/TASK-080 docs as a must-revisit-if-ever-distributed item, mirroring
  the brave.exe-rename caveat in `docs/personal-fork-notes.md`.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-078 adds `docs/reencode-x264.md` (feature behavior, ffmpeg
      bundling + path resolution, the media-job lock model, GPL/licensing
      caveat) and links it from `docs/index.md`; a short cross-reference is
      added to `docs/personal-fork-notes.md` since bundling a second binary and
      the licensing caveat are fork-specific deviations.
