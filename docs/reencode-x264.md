---
title: Re-encode (x264) Feature
author: @rjdollete
last_updated: 2026-10-27
scope: feature
---

# Re-encode (x264) Feature

The "Re-encode (x264)" tool appears in the inspector **Tools** section whenever
a video file is open in SlideMode.  Clicking it enqueues a job that transcodes
the video to an H.264 MP4 file in place, copies all tags to the output, and
adds a row to the media queue drawer where the user can review and keep the result.

---

## User-Facing Behavior

1. Open a video in SlideMode. The inspector Tools section shows an enabled
   **Re-encode (x264)** button.
2. Click the button. The job is enqueued and the button returns immediately.
   The media queue drawer at the bottom of the window auto-opens (if not already
   open) with the new row showing status `Queued`. Navigation, tagging, and all
   other input remain fully available.
3. When the queue is idle the job starts: the drawer row updates to
   `Processing… N%`. A **Cancel** button is shown in the row; clicking it kills
   ffmpeg, removes any partial output, and removes the row.
4. On completion:
   - The output `.mp4` lands beside the source with an auto-incremented name
     (`video.mp4`, `video 1.mp4`, `video 2.mp4` …).
   - All source tags (DB + EXIF/XMP HierarchicalSubject / Subject / Keywords)
     are copied to the output.
   - The drawer row transitions to `Completed`: the status becomes a
     **`View Completed`** control (clicking it opens the new file in the viewer);
     actions become three Keep buttons:
     - **Keep New** — moves the original to the Recycle Bin (or permanently
       deletes it if the volume has no Recycle Bin, per INV-014 handling) and
       removes the row.
     - **Keep Original** — moves the new file to the Recycle Bin and removes
       the row.
     - **Keep Both** — keeps both files and removes the row.
   - The viewer is not moved by the encode; the user chooses when (and whether)
     to open the result via `View Completed`.
5. If the encode fails, the drawer row shows `Failed` (clicking the status
   reveals the ffmpeg stderr tail); actions become `[Retry] [Dismiss]`.

**Tool scope:** the video tools are shown only for files where
`isFileExtensionVideo(file.extension)` is true — currently `mp4`, `webm`, `ogg`,
`mov`, `mkv`, and `ts` (the recognized video containers; the HTML5 `<video>`
player renders those whose container Chromium can demux *and* whose codecs it can
decode — see the codec table below). Every recognized video file gets the same
Tools section, `Re-encode (x264)` included: playability never gates a button.
For any other file type the Tools section shows the neutral caption "No tools
available for this file type."

---

## MOV, MKV and TS files, the probed-codec badge, and the unplayable banner

`.MOV` (Apple QuickTime container) is ingested as a recognized video file:
`mov` sits in `IMG_EXTENSIONS` (`src/api/file.ts`) and in the single
authoritative predicate `isFileExtensionVideo` (`common/fs.ts`). Extension
recognition is a **file-discovery trigger only — never a playability test**:
a QuickTime file may carry H.264 (plays fine) or HEVC/ProRes/PCM audio (the
`<video>` element cannot decode them).

`.MKV` (Matroska) and `.TS` (MPEG-TS) ride the identical lane: `mkv` and `ts`
joined `IMG_EXTENSIONS` (`src/api/file.ts`) and `isFileExtensionVideo`
(`common/fs.ts`), so they are watched, ingested, listed, media-type filtered,
hovered, and opened exactly like `mp4`/`webm`/`ogg`/`mov`. The same rule holds —
extension is a discovery trigger, never a playability test — but the two
containers differ in what the probe may conclude: Matroska is demuxable by
Chromium, so an `.mkv` verdict comes from its codecs (`h264`, `vp8`, `vp9`,
`av1` play; HEVC/ProRes do not); MPEG-TS is not demuxable by Chromium at all,
so a `.ts` **with a probed video stream** is never playable no matter how
healthy its codec strings look — a perfectly healthy `vp9` inside an MPEG-TS
container is still not playable.

**Codec triage (facts, not verdicts).** After a location load, the desktop
main process runs a low-priority background pass
(`src/ipc/videoProbePass.ts`, `PROBE_VIDEO_CODECS` IPC) that ffprobes each
recognized-video file's first video stream, first audio stream, **and
container** from ONE spawn (`FfmpegRunner.probeFirstVideoCodec`: `-show_entries
format=format_name:stream=codec_type,codec_name -of json`) and stores the raw
facts in the nullable `videoCodec`/`audioCodec`/`formatName` columns plus a
`codecVersion` probe stamp (`MOV_CODEC_VERSION:size:mtimeMs`; schema migrations
v2 and v3, `src/backend/sqlite-config.ts`). `MOV_CODEC_VERSION` stayed at 1 for
the container fact: no existing row's verdict depends on it, so a bump would
re-probe healthy rows for zero verdict change. A file whose stamp still matches
its live size+mtime spawns nothing; an ffprobe failure is logged loudly and the
row stays NULL — **a probe error is never presented as "not playable"**. The
read-only web sidecar never probes or writes; it renders badges from the
columns the desktop app persisted.

**Playability derivation** (`src/frontend/image/playability.ts`, evaluated at
render time so a codec-table change re-derives without re-probing; the three
stored facts are passed together —
`derivePlayability(videoCodec, audioCodec, formatName)`):

| Stored facts (`videoCodec`, `audioCodec`, `formatName`) | Derived verdict |
|---|---|
| No probed video stream — NULL/blank `videoCodec`: pass pending, probe errored, or ffprobe reported no video stream (**includes a TypeScript source named `.ts`**) | unprobed — **no badge, no banner, ever** |
| `formatName` containing `mpegts` (`.ts`) **and** a probed video stream | **Not playable** — regardless of codec names (Chromium ships no MPEG-TS demuxer), `vp9` included: the container rule wins |
| `matroska,webm` (`.mkv`) — or any other container — with video `h264`, `vp8`, `vp9`, or `av1` + audio absent, `aac`, `mp3`, `opus`, or `vorbis` | playable |
| Video `hevc` (the modern iPhone MOV/MKV default), `prores`, or any other codec | **Not playable** |
| Any video + audio `pcm_s16le`, `ac-3`, `flac`, or any other codec | **Not playable** |

VP8/VP9/AV1 join H.264 as the playable video codecs: they are WebM's native
codecs and Chromium decodes all three natively, so a `vp9` clip is badge-free.
They were missing from the first cut of this table, which badged a playing VP9
clip `VP9 — not playable here` (operator observation, 2026-10-27).

Evaluation order is fixed and is the reason a folder of TypeScript sources
survives `.ts` becoming a recognized video extension: the **unprobed gate is
evaluated first**, so the container rule can only ever badge a file whose video
stream ffprobe actually confirmed. The derivation is pure and reads stored facts
only — never the extension or filename — so the desktop renderer and the
read-only sidecar render identical badges.

**Surfaces** (one vocabulary everywhere):

- Gallery tile: amber **`Not playable`** lozenge over the thumbnail corner, with
  a tooltip naming the reason — `<CODEC> is not decodable in this app — use
  "Re-encode (x264)" in the Tools panel` for a codec-driven verdict, or the
  reason-only `MPEG-TS is not demuxable in this app` for the container-driven
  verdict. A `.ts` tile renders the app's existing
  **placeholder**: tiles for recognized video are `<video>` elements and video
  files never request a thumbnail (`ImageLoader.needsThumbnail` is false for
  them), so nothing extracts an MPEG-TS frame — the element fails and the tile
  falls to its placeholder path. Hover-playback, selection, and the media-type
  filter are unchanged.
- SlideMode: an **inline banner** (the `<video>` element stays mounted) titled
  `<Reason> — not playable here`, where Reason is the probed codec (`HEVC`,
  `ProRes`, …) or `MPEG-TS` for the container-driven verdict — there the banner
  names the container and never a codec. The banner is **text-only**: the body
  names the remedy rather than duplicating it — `<Cause>. Use "Re-encode
  (x264)" in the Tools panel to create a playable H.264 .mp4 copy next to the
  original — the original is never modified.`, where Cause is `<Codec> is not
  decodable in this app` or `MPEG-TS is not demuxable in this app`. It offers
  no button of its own.
- Inspector **Tools** section: one remediation affordance, the pre-existing
  **`Re-encode (x264)`** button — the gallery badge's and the banner's shared
  path to action. The Tools section is identical for playable and unplayable
  clips: no button appears or disappears with the verdict.
- Read-only web build: the banner states `Not playable in this browser` — the
  explanation only, with **no button and no remedy line**, because the sidecar
  never offers a write affordance it cannot perform and never converts. The
  sidecar does stream video: `/original` and `/preview` resolve `Content-Type` from
  `VIDEO_FORMAT_MIME` (`src/server/routes/images.ts`) once the raster-only
  `webMimeType` misses — `mkv` → `video/x-matroska`, `ts` → `video/mp2t`,
  `mov` → `video/quicktime`, `mp4` → `video/mp4`, `webm` → `video/webm`,
  `ogg` → `video/ogg`. `webMimeType` itself stays raster-only, so the image
  endpoints never hand out a video and `/thumb` has no video path at all. A
  `.ts` original therefore reaches the browser with the correct type; painting
  it is Chromium's limitation, which is why the tile shows the placeholder
  rather than a still.

**The remedy is this tool.** `Re-encode (x264)` enqueues the EXISTING
`reencode-x264` job through the same media-job IPC the Tools section already
uses — auto-incremented `.mp4` sibling, ffprobe-driven audio decision, tag
copy to DB + XMP, drawer progress with Cancel, auto-open of the output, and
the Keep New / Keep Original / Keep Both prompt, all unchanged. The job has no
input-extension gate, so `.MOV`, `.MKV`, and `.TS` sources enqueue identically,
and the output is always `.mp4` — the container Chromium accepts. It inherits
this feature's **NVENC-only contract verbatim**: no NVIDIA GPU means the
drawer shows a `Failed` row with the ffmpeg stderr tail — there is **no
software-encode fallback** (INV-032). There is **no auto-conversion**
anywhere: the original `.MOV`/`.MKV`/`.TS` is never modified or deleted by this
feature; conversion is opt-in per clip and the Keep prompt is the
storage-growth control.

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
| `-c:v h264_nvenc` | Re-encode video with NVIDIA NVENC H.264; requires an NVIDIA GPU; **no software fallback** — fails loudly if NVENC is unavailable. On multi-GPU machines the encoder is pinned to the first **GeForce** card (workstation GPUs such as an RTX PRO are typically reserved for other workloads with their VRAM committed — encoding there crawls); no GeForce found → ffmpeg's default device; override with `ONEFOLDER_NVENC_GPU` (a CUDA_VISIBLE_DEVICES value: GPU UUID or index) (`FfmpegRunner.nvencDeviceEnv`) |
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
   rejects, and the queue row shows a `Failed` status with the probe error.  No silent
   "assume compatible" fallback.

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
uniformly by all media tools.

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
  - `killAll()` — called from `app.on('before-quit')`; cancels every live job and
    removes their staged partials.

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

## Media Queue Store

`MediaQueueStore` (in `src/frontend/stores/MediaQueueStore.ts`) owns the queue
and serializes execution.  When a tool button is clicked, `ImageTools.tsx` calls:

```typescript
mediaQueueStore.enqueue(file, 'reencode-x264')
```

This adds a `QueueItem` to the FIFO list and returns immediately.  The store's
`processNext` method runs one job at a time — when the running slot is free it
picks the oldest `Queued` item and calls the appropriate IPC channel.  Progress
updates flow back to the item via a subscription and are shown as `Processing… N%`
in the drawer row.

On success `runItem` calls `finalizeEncodedOutput(..., { focusViewer: false })`
and then marks the item `Completed` — the viewer is not moved.  On failure the
item is marked `Failed` with the error detail stored for on-click reveal.

The queue is **session-only** (in-memory).  On quit, `MediaJobService.killAll`
(called from `before-quit`) cancels all pending/running jobs; committed outputs
that were already placed on disk remain there unchanged.

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

## Post-Media-Job Finalization (Placement and Ingestion)

After ffmpeg finishes, `MediaQueueStore.runItem` calls
`fileStore.finalizeEncodedOutput(source, { jobId, tempPath, finalPath }, { focusViewer: false })`.
Every step is awaited and every failure throws a LOUD error that the store records
as a `Failed` row — there are no silent fallbacks:

1. **Tag the temp file** (`tagTempFile`) — write the source's tags to the staged
   temp file (EXIF/XMP) exactly once. Zero-tag sources skip the write.
2. **Suppress + place** — `LocationStore.suppressIngest(finalPath)` tells the watcher
   to ignore the output path, then `commitMediaJob` (→ `MediaJobService.place`) moves
   the temp file to its final path with a single `fse.move(temp → final)`.
3. **Deterministic ingest** (`LocationStore.ingestFile`) — the renderer creates the
   library row itself and sets the source's tag ids on it. Because the watcher is
   suppressed for this path, the renderer is the **sole ingester**: exactly one row,
   already tagged, no race.
4. **Refetch** — `refetch()` updates the view. Because `focusViewer` is `false`, the
   output `ClientFile` is resolved but the viewer is not moved. The `View Completed`
   control in the drawer row lets the user open the output on demand.
5. **Release suppression** in a `finally` — by now the row exists, so a late watcher
   `add()` for the path dedups by inode in `addFile`.

---

## Keep Actions (Queue Drawer)

After completion, the drawer row offers three Keep actions that route deletions
through the shared recyclable-check trash flow (extracted from the old
`DeleteOriginalAfterJob` component, now a shared helper):

1. `mediaReleaseCoordinator.releasePaths([path])` — release any open `<video>`
   element handles (INV-008).
2. `RendererMessenger.checkRecyclable([path])` — determine whether the drive
   supports the Recycle Bin.
3. `RendererMessenger.trashFile` or `RendererMessenger.deleteFilePermanently`
   depending on recyclability.
4. `fileStore.deleteFiles([file])` — in-place splice, no refetch (INV-015).

The row is removed from the queue regardless of which Keep action is chosen.

---

## Stall & Cancellation (INV-038)

Two self-healing mechanisms prevent a stuck job from permanently blocking the queue.

### 60-second Stall Watchdog

`MediaQueueStore.runItem` arms a 60-second timer the moment a job enters `running`.
The primary liveness signal is ffmpeg's **`outTimeSec`** (encoded output timestamp):
whenever `outTimeSec` advances the timer re-arms, so a long encode that makes steady
encode-time progress is never killed — even if the rounded integer `percent` does not
change for over a minute. The timer fires only when the process is genuinely frozen
(no `out_time_ms` advance for 60s). On fire:

1. `cancelMediaJob(jobId)` is sent to kill the wedged child.
2. The queue row transitions to `Failed` with the message
   `"Stalled: no progress for 60s (stuck at N%)."` — the frozen percent is shown
   so the user can see where the encode stopped.
3. `processNext()` runs and the next queued job starts.

A separate inactivity timeout inside `FfmpegRunner.run()` (default 60s, resets on each
`out_time_ms` advance) serves as a **main-process backstop**: even if the renderer-side
watchdog is somehow bypassed, the main process kills the ffmpeg child and rejects the
encode promise with a `FfmpegStallError`, which surfaces as a `Failed` row via the
existing `onError` path.

### Forcible Cancel

Clicking Cancel on a `Running` row:

1. Sends `cancelMediaJob(jobId)` to kill the ffmpeg child.
2. **Immediately** splices the row from the queue and calls `processNext()` — without
   waiting for the `MEDIA_JOB_CANCELLED` round-trip.

Cancel works in every phase of a running job:

- **Encoding** — ffmpeg child is killed; any partial output in the staging dir is
  removed by the main-process catch block.
- **Finalize** — once ffmpeg finishes, the renderer awaits `finalizeEncodedOutput`
  (tag → commit/move → ingest). Cancel removes the row locally even though
  `cancelMediaJob` may be a main-side no-op at this point; the orphaned finalize
  work completes or fails harmlessly without affecting the queue.

A late-arriving `MEDIA_JOB_CANCELLED` rejection (or natural completion) for a row
that was already cancelled is a harmless no-op — the idempotent `settle()` latch in
`runItem` ensures the row cannot be double-spliced and `processNext()` cannot be
double-called.

### Manual QA Checklist

The following scenarios require a real ffmpeg encode and cannot be automated:

- [ ] REQUIRES MANUAL EXECUTION: Start a long encode, then suspend the ffmpeg PID
  (Task Manager → right-click → Suspend, or `SuspendThread` via Process Hacker) so
  progress freezes. Confirm the queue row auto-fails after ~60s with a "Stalled" message
  and the next queued job starts. Capture a screenshot or log.
- [ ] REQUIRES MANUAL EXECUTION: With a job running, click Cancel. Confirm the ffmpeg
  process is gone (Task Manager / `tasklist`) and the next queued job starts immediately.
  Capture evidence.
- [ ] REQUIRES MANUAL EXECUTION: Click Cancel during the brief finalize phase (after
  progress hits ~100% but before the row resolves). Confirm the row is removed and the
  queue advances. Capture evidence.

---

## Error Handling Summary

| Scenario | Behavior |
|---|---|
| ffmpeg exits non-zero | Staged partial deleted; queue row shows `Failed` with stderr tail; no Keep actions |
| ffmpeg stalls (no `out_time_ms` advance for 60s) | Renderer watchdog fails the row with "Stalled: no progress for 60s (stuck at N%)" and advances queue; main-process FfmpegStallError backstop kills child independently |
| User cancels (Queued) | Row removed immediately; no ffmpeg started |
| User cancels (Running) | ffmpeg aborted; row spliced immediately; queue advanced without waiting for confirmation; late confirmation is a harmless no-op |
| User cancels (Finalizing) | Row spliced immediately; orphaned finalize completes or fails harmlessly |
| App quits mid-encode | `before-quit` handler calls `mediaJobService.killAll()`; staged partial deleted (best-effort); quit proceeds |
| Place or ingest fails | `finalizeEncodedOutput` throws; watcher suppression released in `finally`; queue row shows `Failed`; source left on disk untouched |
| Source already deleted before Keep action | Defensive guard in the Keep handler; no-ops if `source` is null |
| ffprobe duration probe fails | Encode proceeds; drawer row runs in indeterminate mode (no percent shown) |

---

## GPL / Licensing Caveat

The bundled ffmpeg binary is an unmodified gyan.dev FFmpeg 8.1.1 build compiled
with `--enable-gpl --enable-version3 --enable-libx264` and NVENC support
(`--enable-nvenc`, via the MIT-licensed ffnvcodec headers; no `--enable-nonfree`).
The binary as a whole is licensed GPLv3.  Because this repository is public,
the committed binary is distributed with it.

The license notice and Corresponding Source pointers live in
[`resources/THIRD_PARTY.md`](../resources/THIRD_PARTY.md).  Replacing the
binaries requires updating that record in the same commit.  See also the
licensing section of `docs/personal-fork-notes.md`.

---

## Related

- [Personal Fork Notes](personal-fork-notes.md) — second bundled binary
  (`resources/ffmpeg/`) and GPL licensing deviation
- INV-018 — investigation and full behavioral specification
- INV-035 — non-blocking queue drawer; removal of the in-viewer pin + blocking modals
- TASK-074 — ffmpeg bundling and `getFfmpegPath`/`getFfprobePath`
- TASK-075 — `ReEncodeManager` and `getUniqueSiblingPath`
- TASK-076 — IPC channels (`START_REENCODE`, `REENCODE_PROGRESS`, `CANCEL_REENCODE`)
- TASK-077 — UI lock, `waitForIngestedFile`, `copyTagsToFile`
- TASK-078 — `ImageTools.tsx` orchestration
- TASK-079 — delete-original prompt (originally `ReEncodeDeleteOriginal`; generalized by TASK-086; replaced by queue drawer Keep actions in INV-035)
