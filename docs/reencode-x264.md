---
title: Re-encode (x264) Feature
author: @rjdollete
last_updated: 2026-06-11
scope: feature
---

# Re-encode (x264) Feature

The "Re-encode (x264)" tool appears in the inspector **Tools** section whenever
a video file is open in SlideMode.  Clicking it transcodes the video to an H.264
MP4 file in place, copies all tags to the output, auto-opens the result, and
offers to delete the original.

---

## User-Facing Behavior

1. Open a video in SlideMode. The inspector Tools section shows an enabled
   **Re-encode (x264)** button.
2. Click the button. The UI lock engages — arrow keys, Space, Delete, and all
   view-method shortcuts are inert for the duration of the encode. A spinner
   with percent progress replaces the button.
3. The ffmpeg process starts. A **Cancel** button is shown; clicking it kills
   ffmpeg, removes any partial output, and releases the lock.
4. On completion:
   - The output `.mp4` lands beside the source with an auto-incremented name
     (`video.mp4`, `video 1.mp4`, `video 2.mp4` …).
   - All source tags (DB + EXIF/XMP HierarchicalSubject / Subject / Keywords)
     are copied to the output.
   - The output auto-opens in the viewer (it becomes the selected file in
     SlideMode).
   - A **"Delete original?"** modal appears with two choices:
     - **Delete Original** — moves the source to the Recycle Bin (or permanently
       deletes it if the volume has no Recycle Bin, per INV-014 handling).
     - **Keep Original** — closes the modal; the source is untouched.
5. The UI lock releases when the encode finishes (success, failure, or cancel).

**Tool scope:** the button is shown only for files where
`isFileExtensionVideo(file.extension)` is true — currently `mp4`, `webm`, and
`ogg` (the three formats the HTML5 `<video>` player can render in SlideMode).
For any other file type the Tools section shows the neutral caption "No tools
available for this file type."

---

## ffmpeg Command

The exact command the main process runs is:

```
ffmpeg -hide_banner -i "<input>" -c:a copy -c:v libx264 -progress pipe:1 -nostats -y "<output>"
```

| Argument | Purpose |
|---|---|
| `-hide_banner` | Suppress the ffmpeg version/config banner on stderr |
| `-i <input>` | Source file |
| `-c:a copy` | Copy the audio stream untouched |
| `-c:v libx264` | Re-encode video to H.264 |
| `-progress pipe:1` | Emit machine-readable `key=value` progress lines to stdout |
| `-nostats` | Suppress the human-readable stat line (avoids duplicating progress) |
| `-y` | Overwrite output without prompting — safe because the output path is freshly computed to be collision-free |
| `<output>` | Always has a `.mp4` extension; computed by `getUniqueSiblingPath` |

The codec arguments (`-c:a copy -c:v libx264`) are preserved verbatim from the
user's stated requirement (INV-018).  Only transport and progress flags are
added around them.

Duration probing for percent progress is done separately via:

```
ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "<input>"
```

If probing fails or times out (> 10 s), the spinner runs in indeterminate mode
(no percent shown).  The encode still proceeds.

---

## Output Path Computation

`getUniqueSiblingPath(dir, baseName, 'mp4')` in `common/fs.ts`:

```
video.mp4    (if free)
video 1.mp4  (if video.mp4 exists)
video 2.mp4  (if video 1.mp4 also exists)
…
```

The source extension is replaced unconditionally with `.mp4`.  A source that is
already named `clip.mp4` produces `clip 1.mp4` as its first candidate.

---

## ffmpeg Bundling and Path Resolution

ffmpeg and ffprobe are bundled under `resources/ffmpeg/`:

```
resources/
  ffmpeg/
    ffmpeg.exe
    ffprobe.exe
```

The binary paths are resolved by `getFfmpegPath()` and `getFfprobePath()` in
`common/fs.ts`, both of which delegate to `getExtraResourcePath()` — the same
helper used for ExifTool.  This resolves correctly in both dev mode
(`../resources/ffmpeg/`) and the packaged portable build
(`../../resources/ffmpeg/`) by inspecting `IS_DEV`.

`package.json`'s `build.win.extraResources` declares the `resources/ffmpeg/`
directory so electron-builder copies the binaries into the packaged artifact
alongside ExifTool.

---

## Main-Process Job Runner (ReEncodeManager)

`src/ReEncodeManager.ts` implements the job lifecycle:

- `reEncodeManager.start(inputPath, callbacks)` — computes the output path,
  spawns ffmpeg, and returns `{ jobId, outputPath }` synchronously. Progress,
  completion, and errors are delivered asynchronously via `callbacks`.
- `reEncodeManager.cancel(jobId)` — kills the ffmpeg process (`taskkill /F
  /PID` on Windows; `SIGKILL` elsewhere), removes any partial output, and calls
  `onCancelled`.
- `reEncodeManager.killAll()` — called from `app.on('before-quit')` in
  `src/main.ts`; kills all live jobs and removes their partial outputs
  synchronously (best-effort).

A job registry (`Map<string, JobEntry>`) is maintained so IPC handlers can look
up jobs by their UUID.  Progress events are throttled to a minimum of 200 ms
between emissions to avoid flooding the renderer.

---

## IPC Channels

Three channels are defined in `src/ipc/messages.ts`:

| Channel | Direction | Shape |
|---|---|---|
| `START_REENCODE` (invoke) | renderer → main | `{ inputPath }` → `{ outputPath }` on completion, or rejects with error message |
| `REENCODE_PROGRESS` (send) | main → renderer | `{ jobId, percent?, outTimeSec?, totalSec? }` — an immediate synthetic `percent: 0` event carries the `jobId` for the cancel button |
| `CANCEL_REENCODE` (send) | renderer → main | `jobId: string` |

`RendererMessenger` surface:

```typescript
RendererMessenger.startReencode(inputPath): Promise<{ outputPath: string }>
RendererMessenger.onReencodeProgress(cb): () => void  // returns unsubscribe fn
RendererMessenger.cancelReencode(jobId): void
```

`startReencode` rejects with `'REENCODE_CANCELLED'` on cancel and with the
ffmpeg error message (stderr tail) on failure.

---

## Media-Job Lock

`UiStore` exposes a media-processing lock used to freeze navigation and
destructive actions during an encode:

```typescript
uiStore.beginMediaProcessing(filePath)  // acquire
uiStore.endMediaProcessing()            // release (idempotent)
uiStore.isMediaProcessing               // computed boolean
```

When `isMediaProcessing` is true:

- `processGlobalShortCuts` swallows navigation (view-method switch, viewSlide)
  and delete shortcuts.
- `SlideMode/index.tsx`'s arrow-key and Space handlers are inert.
- `UiStore.openMoveFilesToTrash()` returns immediately without opening the
  dialog.

The orchestration in `ImageTools.tsx` always wraps the encode in `try/finally`
so `endMediaProcessing()` is called even on failure or cancel, preventing a
lock-leak.

---

## Watcher Ingestion of Encode Outputs

The folder watcher (`src/frontend/workers/folderWatcher.worker.ts`) uses
chokidar's `awaitWriteFinish` option:

```typescript
awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
```

This defers the `add` event until the file has not changed size for 2000 ms,
ensuring the encode output is ingested only once ffmpeg has fully written it.
Without this, the watcher fires `add` the moment ffmpeg creates the output
(while still writing), capturing a partial `stats.size` and `0×0` dimensions
that are never corrected (the `change` handler is intentionally commented out).
Chromium would then issue a byte-range request for a range beyond the partial
file's length, yielding `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE` (INV-019).

The 2000 ms threshold also applies to manually dropped/imported files, adding up
to ~2 s latency before a new drag-and-drop file appears in the library — an
acceptable tradeoff for correct size and dimensions on every ingested file.
Because the `finalizeEncodedOutput` helper (below) polls the DB for the output
row (bounded ~3 s), the extra stabilization delay is already within that budget.

---

## Post-Encode Finalization (Ingestion, Tag Copy, and Selection)

After a successful encode, the renderer calls
`fileStore.finalizeEncodedOutput(source, outputPath)`, which runs the corrected
post-encode order (INV-019):

1. **DB-level tag copy first** (`copyTagsToOutputPath`) — because
   `awaitWriteFinish` is active, chokidar `add` fires only after the file has
   stopped growing (i.e. after the encode finishes, plus up to 2 s stabilization).
   `copyTagsToOutputPath` polls the DB for up to ~3 s — covering the
   stabilization window — waiting for the row to be created.  Tags are then
   written onto the DTO via the backend by path, without requiring the output to
   be in the view-dependent `fileList`.  This is mandatory: in a tag-filtered
   view the tag-less output never matches the filter, so it could not enter
   `fileList` until tagged.  `fileList` is a view model (the result of the active
   search query), **not** a complete file index.  Tags are also written to
   EXIF/XMP exactly once here.  Zero-tag sources skip the EXIF/XMP write
   entirely.

2. **Immediate refetch** (`refetch()`) — re-runs the active query so the
   now-tagged output can enter `fileList` if it matches the current filter.

3. **Bounded wait** (`waitForIngestedFile(outputPath, 10000)`) — a MobX
   `reaction` on `fileList` that resolves when the output appears.  Because tags
   were already copied, a tag-filtered view now accepts it; the wait should
   succeed in the common case.

4. **Select and open** — `selectFile(newFile, true)` + `enableSlideMode()`.

5. **Graceful fallback** when the output is still not visible (e.g. a display
   filter other than tags excludes it, or ingestion is delayed): clear the active
   search (`clearSearchCriteriaList()`, which switches to all-content), then
   retry the wait with a 3-second timeout.  If the output appears, select and
   open; otherwise show an honest toast that states the observable fact and
   offers causes as possibilities (docs/TOOLS.md rule 4).  Because tags are
   copied in step 1 before the wait, the toast can also confirm that tagging
   succeeded:
   - *Tags copied:* "Re-encoded to &lt;path&gt; and copied your tags, but it is not
     visible in the current view. It may be excluded by the active filter, or
     outside a watched folder."
   - *Row not found:* "Re-encoded to &lt;path&gt;, but it is not visible in the
     current view. It may be excluded by the active filter, outside a watched
     folder, or ingestion may still be in progress."
   The toast never asserts "outside a watched folder" as the sole cause — that
   is unverified (rule 4).

---

## Delete-Original Prompt

`DeleteOriginalAfterJob` (in `src/frontend/components/RemovalAlert.tsx`) is
a modal driven by `uiStore.deleteOriginalAfterJobFile`.  It reuses the same
trash flow as `MoveFilesToTrashBin` and is shared by all tools that produce a
derived output (Re-encode, Normalize Audio, etc.) — INV-020 / TASK-086:

1. `mediaReleaseCoordinator.releasePaths([source.absolutePath])` — release any
   open `<video>` element handles (INV-008).
2. `RendererMessenger.checkRecyclable([source.absolutePath])` — determine
   whether the drive supports the Recycle Bin.
3. `RendererMessenger.trashFile` or `RendererMessenger.deleteFilePermanently`
   depending on recyclability.
4. `fileStore.deleteFiles([source])` — in-place splice, no refetch (INV-015).

The component is mounted in `ContentView/index.tsx` alongside
`MoveFilesToTrashBin` so it participates in the same modal layer.

---

## Error Handling Summary

| Scenario | Behavior |
|---|---|
| ffmpeg exits non-zero | Lock released; partial output deleted; error toast with stderr tail; no delete prompt |
| User cancels | ffmpeg killed; partial output deleted; lock released; quiet cancel toast |
| App quits mid-encode | `before-quit` handler calls `reEncodeManager.killAll()`; partial output deleted (best-effort); quit proceeds |
| Output not visible after wait | Tags already copied (DB + EXIF/XMP) before the wait; fallback clears filter and retries; if still absent: honest toast stating the observable fact and offering causes as possibilities — never asserts "outside a watched folder" as the sole cause (docs/TOOLS.md rule 4); lock released; source untouched |
| Source already deleted | `handleConfirm` no-ops if `source === null`; defensive guard in `DeleteOriginalAfterJob` |
| ffprobe duration probe fails | Encode proceeds; spinner runs in indeterminate mode |

---

## GPL / libx264 Licensing Caveat

The bundled ffmpeg binary is compiled with `--enable-gpl --enable-libx264`.
libx264 is licensed under the GPL v2+.  Distributing a GPL binary imposes
obligations: source offer, license notice, and binary linking attribution.

**This build is a private, single-user fork and is not distributed publicly.**
The GPL caveat is therefore acceptable under personal-use terms.  If this fork
is ever distributed more widely, the ffmpeg bundling and licensing situation
must be reviewed and the appropriate source-offer obligations satisfied before
distribution.  This mirrors the `brave.exe` rename caveat in
`docs/personal-fork-notes.md`.

---

## Related

- [Personal Fork Notes](personal-fork-notes.md) — second bundled binary
  (`resources/ffmpeg/`) and GPL licensing deviation
- INV-018 — investigation and full behavioral specification
- TASK-074 — ffmpeg bundling and `getFfmpegPath`/`getFfprobePath`
- TASK-075 — `ReEncodeManager` and `getUniqueSiblingPath`
- TASK-076 — IPC channels (`START_REENCODE`, `REENCODE_PROGRESS`, `CANCEL_REENCODE`)
- TASK-077 — UI lock, `waitForIngestedFile`, `copyTagsToFile`
- TASK-078 — `ImageTools.tsx` orchestration
- TASK-079 — `DeleteOriginalAfterJob` modal (originally `ReEncodeDeleteOriginal`; generalized by TASK-086)
