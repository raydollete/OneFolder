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
   - The viewer swaps to the output **in place** (INV-021): the source stays on
     screen in SlideMode through finalization — with a "Finalizing…" indicator
     covering the stabilization/ingest gap — then the output becomes the selected
     file without ever returning to the thumbnail grid.
   - A post-job **"Keep which version?"** modal appears with three choices:
     - **Keep Modified** (default) — moves the original to the Recycle Bin (or
       permanently deletes it if the volume has no Recycle Bin, per INV-014
       handling) and keeps the new file open.
     - **Keep Original** — moves the NEW file to the Recycle Bin and switches the
       viewer back to the original.
     - **Keep Both** — keeps both files; the new file stays open.
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
ffmpeg -hide_banner -i "<input>" -c:v h264_nvenc -preset p7 -tune hq -cq 21 <audio-args> -progress pipe:1 -nostats -y "<output>"
```

Where `<audio-args>` is determined at runtime by an up-front ffprobe of the source's
first audio stream (see Audio Handling below):

| Source audio | `<audio-args>` |
|---|---|
| MP4-legal codec (AAC, MP3, AC3, EAC3, ALAC) | `-c:a copy` (lossless, instant) |
| Non-MP4-legal codec (Vorbis, Opus, FLAC, PCM, …) | `-c:a aac -b:a 192k` (transparent re-encode) |
| No audio stream | `-an` (no audio in output) |

| Argument | Purpose |
|---|---|
| `-hide_banner` | Suppress the ffmpeg version/config banner on stderr |
| `-i <input>` | Source file |
| `-c:v h264_nvenc` | Re-encode video with NVIDIA NVENC H.264; requires an NVIDIA GPU; **no software fallback** — fails loudly if NVENC is unavailable |
| `-preset p7` | Slowest/best-quality NVENC preset |
| `-tune hq` | High-quality NVENC tuning mode |
| `-cq 21` | Constant-quality target (lower = better; 21 is visually transparent) |
| `-c:a copy` | Stream-copy audio (MP4-legal source codecs only; decided up-front via ffprobe) |
| `-c:a aac -b:a 192k` | Re-encode audio to AAC 192k (non-MP4-legal source codecs; transparent) |
| `-an` | No audio in output (when source has no audio stream) |
| `-progress pipe:1` | Emit machine-readable `key=value` progress lines to stdout |
| `-nostats` | Suppress the human-readable stat line (avoids duplicating progress) |
| `-y` | Overwrite output without prompting — safe because the output path is freshly computed to be collision-free |
| `<output>` | Always has a `.mp4` extension; computed by `getUniqueSiblingPath` |

The video-codec arguments use the shared `NVENC_H264_VIDEO_ARGS` constant
(`src/media/audioArgs.ts`), identical to `subtract-clip` and the two rotate tools
(INV-032).  Only transport and progress flags are added around them.

## Audio Handling

Before encoding, the `onStartMediaJob` handler probes the source's first audio stream
via `FfmpegRunner.probeFirstAudioCodec` (ffprobe `-select_streams a:0 -show_entries
stream=codec_name`).  The probe result drives a deterministic decision:

1. **MP4-legal codec** (aac, mp3, ac3, eac3, alac) → `-c:a copy` (bit-for-bit lossless,
   instant; the common case for `.mp4` sources).
2. **Non-MP4-legal codec** (vorbis, opus, flac, pcm_s16le, …) → `-c:a aac -b:a 192k`
   (transparent re-encode; previously caused a silent mux failure).
3. **No audio stream** → `-an` (output has no audio; must NOT error).
4. **Probe failure on a file that should have audio** → the handler throws, the promise
   rejects, and `MediaJobErrorAlert` is shown.  No silent "assume compatible" fallback.

This decision is **deterministic and up-front** (probe once, decide, encode once) and is
shared with `rotate-cw` and `rotate-ccw` via the `decideAudioArgs` helper in
`src/media/audioArgs.ts`.  `subtract-clip` and `normalize-audio` already re-encode audio
unconditionally and are intentionally NOT probed.

Duration probing for percent progress is done separately via:

```
ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "<input>"
```

If probing fails or times out (> 10 s), the spinner runs in indeterminate mode
(no percent shown).  The encode still proceeds.

---

## Output Staging (INV-026)

ffmpeg does NOT write into the watched target folder. Instead, `MediaJobService`
runs ffmpeg (via `FfmpegRunner`) into an application-owned staging directory (a
subfolder of the OS temp dir, OUTSIDE any watched location), so the chokidar folder
watcher never sees a partial file. After ffmpeg finishes, the renderer tags the
staged temp file (EXIF/XMP), **suppresses** the folder watcher for the final path
(`LocationStore.suppressIngest`), and asks main to place the file with a single
`fse.move(temp → final)`. Because the watcher is suppressed for that path, the
renderer is the **sole ingester**: it creates the library row deterministically with
the source's tags (`LocationStore.ingestFile`), then releases the suppression. There
is no watcher race and no untagged-row window — eliminating the intermittent
"outside a watched folder" error and untagged imports. This staging logic is shared
uniformly by Re-encode (x264), Compress & Normalize Audio, and Create Clip.

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

## Main-Process Job Runner (FfmpegRunner + MediaJobService)

The runner is split into two single-responsibility layers:

- **`src/media/FfmpegRunner.ts`** — the ONLY code that spawns ffmpeg/ffprobe.
  `run({ input, output, args, preInputArgs, onProgress, signal })` runs one ffmpeg
  invocation (resolves on exit 0; rejects with the stderr tail on failure, or
  `FfmpegAbortError` when its `AbortSignal` aborts); `probeDuration()` reads the
  source duration for percent progress. It knows nothing about paths, the library,
  or the watcher.
- **`src/media/MediaJobService.ts`** (singleton `mediaJobService`) — orchestration
  and the job registry:
  - `start(inputPath, jobArgs, outputExt, callbacks, preInputArgs?)` — computes the
    collision-free final path AND a temp path in the app staging dir, runs ffmpeg
    into the temp file, and returns `{ jobId, tempPath, finalPath }` synchronously.
    Progress/completion/errors arrive via `callbacks`.
  - `place(jobId)` — moves the (renderer-tagged) temp file to its final path with a
    single `fse.move`.
  - `cancel(jobId)` — aborts the ffmpeg child (`taskkill /F /PID` on Windows,
    `SIGKILL` elsewhere) and removes the staged partial.
  - `killAll()` — called from `app.on('before-quit')`; cancels every live job.

A job registry (`Map<jobId, …>`) lets the IPC handlers reference jobs.  Progress
events are throttled to a minimum of 200 ms between emissions.

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

## Watcher Ingestion vs. Media-Job Outputs

The folder watcher (`src/frontend/workers/folderWatcher.worker.ts`) uses chokidar's
`awaitWriteFinish` (`{ stabilityThreshold: 2000, pollInterval: 100 }`) so a
manually dropped/imported file is ingested only after it stops growing — preventing
partial `stats.size` / `0×0` dimensions on drag-and-drop imports (INV-019).

Media-job outputs do NOT rely on this. `finalizeEncodedOutput` **suppresses** the
watcher for the output path (`LocationStore.suppressIngest`) and ingests the file
deterministically itself, so the watcher never ingests a derived output at all —
there is no race and no partial/untagged-row window.

---

## Post-Media-Job Finalization (Placement, Ingestion, Seamless Swap)

After ffmpeg finishes, the renderer calls
`fileStore.finalizeEncodedOutput(source, { jobId, tempPath, finalPath })`. Every
step is awaited and every failure throws a LOUD error that the caller surfaces as a
blocking modal (`showMediaJobError`) while keeping the source on screen — there are
no silent fallbacks:

1. **Tag the temp file** (`tagTempFile`) — write the source's tags to the staged
   temp file (EXIF/XMP) exactly once. Zero-tag sources skip the write.
2. **Suppress + place** — `LocationStore.suppressIngest(finalPath)` tells the watcher
   to ignore the output path, then `commitMediaJob` (→ `MediaJobService.place`) moves
   the temp file to its final path with a single `fse.move(temp → final)`.
3. **Deterministic ingest** (`LocationStore.ingestFile`) — the renderer creates the
   library row itself and sets the source's tag ids on it. Because the watcher is
   suppressed for this path, the renderer is the **sole ingester**: exactly one row,
   already tagged, no race.
4. **Refetch + resolve** — `refetch()` then `resolveOutputClientFile` anchors
   `uiStore.firstItem` to the output by identity (preferring the grid's instance, or
   injecting it if the active filter excludes it), so the viewer swaps source →
   output **in place** without ever returning to the grid. SlideMode stays mounted
   throughout (the source is pinned by identity until the swap).
5. **Release suppression** in a `finally` — by now the row exists, so a late watcher
   `add()` for the path dedups by inode in `addFile`.

### "Finalizing…" Inspector Phase

ffmpeg exit (`startMediaJob` resolving) is followed by a short gap — tag temp →
place → ingest → refetch — before the output opens. `runMediaJob` sets an
`isFinalizing` flag the instant `startMediaJob` resolves (and the progress
subscription is torn down) and clears it after `finalizeEncodedOutput` returns (and
defensively in the `finally`). While `isFinalizing` is true the `reencode-progress`
spinner shows an indeterminate **"Finalizing…"** label (parameterized so every tool
reuses it) and the **Cancel** button is hidden (ffmpeg is already done). The
media-processing lock is held throughout and released exactly once in the
`runMediaJob` `finally`.

---

## Delete-Original Prompt

`DeleteOriginalAfterJob` (in `src/frontend/components/RemovalAlert.tsx`) is
a modal driven by `uiStore.deleteOriginalAfterJobFile`.  It reuses the same
trash flow as `MoveFilesToTrashBin` and is shared by all tools that produce a
derived output (Re-encode, Compress & Normalize Audio, etc.) — INV-020 / TASK-086:

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
| ffmpeg exits non-zero | Lock released; staged partial deleted; blocking error modal with stderr tail; no delete prompt |
| User cancels | ffmpeg aborted (`AbortSignal`); staged partial deleted; lock released; quiet cancel toast |
| App quits mid-encode | `before-quit` handler calls `mediaJobService.killAll()`; staged partial deleted (best-effort); quit proceeds |
| Place or ingest fails | `finalizeEncodedOutput` throws; watcher suppression released in `finally`; source kept on screen behind a blocking error modal (`showMediaJobError`); no delete prompt; lock released |
| Source already deleted | `handleConfirm` no-ops if `source === null`; defensive guard in `DeleteOriginalAfterJob` |
| ffprobe duration probe fails | Encode proceeds; spinner runs in indeterminate mode |

---

## GPL / Licensing Caveat

The bundled ffmpeg binary is compiled with `--enable-gpl --enable-libx264` and
NVENC support.  libx264 is licensed under the GPL v2+; NVENC is a proprietary NVIDIA
encoder and requires the NVENC SDK license (free for bundled use).  Distributing a
GPL binary imposes obligations: source offer, license notice, and binary linking
attribution.

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
