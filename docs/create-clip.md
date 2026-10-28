---
title: Create Clip Feature (Mark Start / Mark End / Create Clip)
author: @rjdollete
last_updated: 2026-10-27
scope: feature
---

# Create Clip Feature

The **Mark Start**, **Mark End**, and **Create Clip** tools appear in the
inspector **Tools** section whenever a video file is open in SlideMode, alongside
Re-encode (x264) and Normalize Audio.  Clicking Mark Start or Mark End captures
the live playback position into an editable `HH:MM:SS` field; clicking Create
Clip enqueues a lossless stream-copy trim (`-c copy`, no re-encode) that produces
an `.mp4` clip beside the source.  Like the other video tools, it copies all source
tags to the output and adds a row to the media queue drawer where the user can
review and keep the result.

---

## User-Facing Behavior

1. Open a video in SlideMode.  The inspector Tools section shows **Re-encode
   (x264)**, **Normalize Audio**, then two button-and-field rows:
   - **Mark Start** — button next to an editable `HH:MM:SS` field (placeholder
     `00:00:00`).
   - **Mark End** — button next to an editable `HH:MM:SS` field (placeholder
     `00:00:00`).
   Below those rows: **Create Clip** (enabled when at least one field holds a
   valid `HH:MM:SS` value; disabled when both are empty, the lone filled field is
   malformed, or both are present with start ≥ end), and an inline hint "End must
   be after start." that appears when both fields are filled but the range is
   backwards or equal.

2. **Mark Start / Mark End capture.** Clicking the button reads the current
   playback time from the slide `<video>` element inside the `#zoomable-image`
   container (see `SlideMode/index.tsx`), formats it as `HH:MM:SS`, and writes it
   into the corresponding field.  The gallery grid stays mounted behind the slide
   overlay and its thumbnail `<video data-file-id=…>` elements would resolve first
   in document order if queried globally — the scoped selector
   `#zoomable-image video:not([data-file-id])` avoids them and reaches the correct
   element, mirroring the `ZoomPan.tsx` wheel-seek pattern.  If no slide `<video>`
   is mounted, the field receives `00:00:00`.  Fields are also freely editable by
   hand.

3. **Validation.** A field is valid when it matches `HH:MM:SS` with HH ≥ 0
   (two or more digits), and MM and SS each in 0–59.  Create Clip is enabled when
   **at least one** field holds a valid value.  The precise rules:
   - Start-only (end empty): Create Clip **enabled** (clip runs to end of video).
   - End-only (start empty): Create Clip **enabled** when end > `00:00:00` (a
     zero-second end would be a zero-length clip — kept disabled).
   - Both filled, start < end: **enabled** (existing behavior).
   - Both filled, start ≥ end: **disabled**; hint "End must be after start."
   - Either present field malformed (`1:2:3`, `99:99:99`, `aa:bb:cc`): **disabled**.
   - Both empty: **disabled**.

4. **Create Clip clicked.** The job is enqueued and the button returns immediately.
   The media queue drawer — always present at the bottom of the window and
   default-collapsed (it does **not** auto-open) — gains a new row showing status
   `Queued`; expand the drawer to watch progress.  Navigation, tagging, and all
   other input remain fully available.

5. The main process re-validates the `HH:MM:SS` strings and the start < end
   constraint (defense in depth), then spawns ffmpeg when the queue picks up the
   job.  A **Cancel** button is shown in the Running row; clicking it kills ffmpeg,
   removes any partial output, and removes the row.  The drawer row shows
   **"Creating clip… N%"** (or just "Creating clip…" if duration probing fails).

6. On completion:
   - The output `.mp4` lands beside the source with an auto-incremented name
     (`video.mp4`, `video 1.mp4`, `video 2.mp4` …).
   - All source tags (DB + EXIF/XMP HierarchicalSubject / Subject / Keywords)
     are copied to the output.
   - The **Start** and **End** fields are cleared, ready for the next clip.
   - The drawer row transitions to `Completed`: the status becomes a
     **`View Completed`** control (clicking it opens the clip in the viewer);
     actions become three Keep buttons:
     - **Keep New** — moves the original to the Recycle Bin (or permanently
       deletes it if the volume has no Recycle Bin) and removes the row.
     - **Keep Original** — moves the new clip to the Recycle Bin and removes
       the row.
     - **Keep Both** — keeps both files and removes the row.
   - The viewer is not moved by the job; the user chooses when (and whether)
     to open the result via `View Completed`.
7. If the job fails, the drawer row shows `Failed` (clicking the status reveals
   the ffmpeg stderr tail); actions become `[Retry] [Dismiss]`.

**Tool scope:** all three controls are shown only for files where
`isFileExtensionVideo(file.extension)` is true — currently `mp4`, `webm`, `ogg`,
`mov`, `mkv`, and `ts` (the recognized video containers; the player only renders
those whose container Chromium can demux and whose codecs it can decode). The
output stays `.mp4` regardless of the source container, so the stream-copy
caveats below apply to any source whose streams MP4 cannot carry.

---

## ffmpeg Command

The command the main process runs depends on which markers are provided:

```
# start-only
ffmpeg -hide_banner -ss <start> -i "<input>" -c copy -progress pipe:1 -nostats -y "<output>"

# end-only
ffmpeg -hide_banner -to <end> -i "<input>" -c copy -progress pipe:1 -nostats -y "<output>"

# both
ffmpeg -hide_banner -ss <start> -to <end> -i "<input>" -c copy -progress pipe:1 -nostats -y "<output>"
```

| Argument | Purpose |
|---|---|
| `-hide_banner` | Suppress the ffmpeg version/config banner on stderr |
| `-ss <start>` | *(start-only or both)* Seek to the start time — placed **before** `-i` for fast, accurate input seeking |
| `-to <end>` | *(end-only or both)* Stop at the end time — also before `-i` for the same reason |
| `-i <input>` | Source file |
| `-c copy` | **Stream-copy all streams without re-encoding** (instant, lossless trim) |
| `-progress pipe:1` | Emit machine-readable `key=value` progress lines to stdout |
| `-nostats` | Suppress the human-readable stat line (avoids duplicating progress) |
| `-y` | Overwrite output without prompting — safe because the output path is freshly computed to be collision-free |
| `<output>` | Always has a `.mp4` extension; computed by `getUniqueSiblingPath` |

When only `-ss` is supplied, ffmpeg runs to the end of the video.  When only
`-to` is supplied, ffmpeg starts from the beginning.  Omitting a flag is
correct — never pass a placeholder like `-ss 00:00:00` or `-to <huge>` for a
missing marker.

The `-ss`/`-to` arguments are user-supplied `HH:MM:SS` strings, validated in
both the renderer (gates the button) and the main process (defense in depth)
using the shared `parseHmsToSeconds` helper from `common/fmt.ts`.  They are
passed verbatim to ffmpeg — no additional conversion is performed.

The `-c copy` codec argument comes from the `MEDIA_JOB_SPECS['create-clip']`
entry in `src/main.ts`.  The `-ss`/`-to` args are per-invocation and are passed
to the runner as `preInputArgs` (inserted before `-i`) rather than as part of the
static spec — see the Reused Media-Job Stack section below.

---

## Output Extension Decision

The output extension is forced to `.mp4`, consistent with Re-encode (x264) and
Normalize Audio.

**Important:** with `-c copy`, stream-copying into `.mp4` requires that the
source codecs be muxable into the MP4 container.  For the common case (`.mp4`
source with H.264/AAC) this is always fine.  See the Known Limitations section.

---

## Known Limitations

### Keyframe snap at the start (inherent to stream copy)

`-ss` before `-i` seeks to the nearest preceding keyframe before the requested
time, so the actual cut point may be slightly earlier than the value entered in
the Start field.  This is inherent to lossless stream-copy trimming; achieving
frame-accurate cuts would require re-encoding (which violates the no-re-encode
requirement).  The clip is still correctly bounded at the end by `-to`.

### Progress percent computed against source duration

The runner probes the **source** duration to compute the progress percentage.
A clip that ends at 00:03:00 of a 10:00 video will therefore report ~30% when
complete and then jump to done.  This is accepted: stream copies finish
near-instantly, so the progress bar barely renders before the job is over.

### webm / ogg sources: container/codec incompatibility

Stream-copying (`-c copy`) into the forced `.mp4` container fails when the
source codec cannot be muxed into MP4:

| Source format | Typical video codec | Muxable into `.mp4`? |
|---|---|---|
| `.mp4` | H.264 | Yes (common case) |
| `.webm` | VP8 or VP9 | No for VP8; VP9 may work |
| `.ogg` | Theora | No |

When the codec is not muxable, ffmpeg exits non-zero.  The existing error path
handles this honestly: the partial output is deleted, and the queue drawer row
shows `Failed` with the ffmpeg stderr tail (which will include the
container/codec mismatch message).  **The source file is always left
untouched.**  This is expected behavior, not a bug.

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
uniformly by all media tools; the `-ss`/`-to` pre-input args for Create Clip are
orthogonal to output placement and are unaffected by this change.

## Output Path Computation

`getUniqueSiblingPath(dir, baseName, 'mp4')` in `common/fs.ts` — identical logic
to Re-encode (x264) and Normalize Audio:

```
video.mp4    (if free)
video 1.mp4  (if video.mp4 exists)
video 2.mp4  (if video 1.mp4 also exists)
…
```

The source extension is replaced unconditionally with `.mp4`.  A source already
named `clip.mp4` produces `clip 1.mp4` as its first candidate.

---

## HH:MM:SS Time Helpers

`common/fmt.ts` provides two pure helpers, usable in both the renderer and main:

```typescript
parseHmsToSeconds(s: string): number | null
```
Returns total seconds for a valid `HH:MM:SS` string (HH ≥ 0 with 2+ digits; MM
and SS each 0–59), or `null` for any malformed, empty, or out-of-range input.

```typescript
formatSecondsToHms(sec: number): string
```
Formats a duration in seconds to zero-padded `HH:MM:SS`.  Clamps negative values
and NaN to `00:00:00`; floors fractional seconds.

Both the renderer's field validation and the main-process defense-in-depth
validation use `parseHmsToSeconds` from this shared module — no forked logic.

---

## Reused Media-Job Stack

Create Clip is the third consumer of the generalized media-job stack built by
INV-018 and parameterized by TASK-085.  It introduces one targeted widening: the
runner now accepts `preInputArgs` for arguments that must precede `-i`.

### Main-Process Job Runner (FfmpegRunner + MediaJobService)

`src/media/MediaJobService.ts` (which runs ffmpeg via `src/media/FfmpegRunner.ts`)
is shared by all tools via the parameterized signature:

```typescript
mediaJobService.start(inputPath, jobArgs, outputExt, callbacks, preInputArgs?)
```

The `create-clip` job's codec args and output extension come from the static
spec in `src/main.ts`:

```typescript
'create-clip': {
  args: ['-c', 'copy'],
  outputExt: 'mp4',
},
```

The per-invocation `-ss`/`-to` args are passed as `preInputArgs` by the IPC
handler — they arrive via the extended `StartMediaJobMessage.clip` payload and
are placed before `-i` in the final ffmpeg argv.  The two existing job types
(`reencode-x264`, `normalize-audio`) pass no `preInputArgs` and are completely
unaffected.

The full lifecycle — duration probe (against the source, not the intended clip
length), 200 ms progress throttle, job registry, cancel via `taskkill /F /PID`
on Windows, partial-output cleanup, and `before-quit` `killAll()` — is shared
unchanged.

### IPC Channels

The three generalized channels from `src/ipc/messages.ts` are shared:

| Channel | Direction | Shape |
|---|---|---|
| `START_MEDIA_JOB` (invoke) | renderer → main | `{ inputPath, jobType: 'create-clip', clip: { start?, end? } }` (at least one of start/end required) → `{ outputPath }` on success; rejects on failure or cancel |
| `MEDIA_JOB_PROGRESS` (send) | main → renderer | `{ jobId, percent?, outTimeSec?, totalSec? }` — first event carries `jobId` for cancel |
| `CANCEL_MEDIA_JOB` (send) | renderer → main | `jobId: string` |

`RendererMessenger` surface (renderer side):

```typescript
RendererMessenger.startMediaJob('create-clip', inputPath, { start?, end? }): Promise<{ outputPath: string }>
RendererMessenger.onMediaJobProgress(cb): () => void  // returns unsubscribe fn
RendererMessenger.cancelMediaJob(jobId): void
```

`startMediaJob` rejects with `'MEDIA_JOB_CANCELLED'` on cancel and with the
ffmpeg error message (stderr tail) on ffmpeg failure.

### Post-Encode Finalization

After a successful job, `MediaQueueStore.runItem` calls
`fileStore.finalizeEncodedOutput(source, { jobId, tempPath, finalPath }, { focusViewer: false })`,
which runs the corrected INV-019 post-encode order (see [reencode-x264.md](reencode-x264.md)
for the detailed description of each step).  All tools share this helper exactly.
The `focusViewer: false` option means the viewer is not moved on completion.

### Queue Store and Orchestration

`ImageTools.tsx` calls `mediaQueueStore.enqueue(file, 'create-clip', { start?, end? })`
with only the filled fields and returns immediately.  The Start and End fields are
cleared after the job completes (on success) or left unchanged (on failure or cancel)
so the user can retry with the same values.  `MediaQueueStore` handles the full
lifecycle: enqueue → processNext → runItem → Completed / Failed row.  Keep actions
in the drawer invoke the shared recyclable-check trash helper as needed.

---

## Error Handling Summary

| Scenario | Behavior |
|---|---|
| ffmpeg exits non-zero (including codec/container mismatch) | Partial output deleted; queue row shows `Failed` with stderr tail; Start/End fields unchanged |
| User cancels (Queued) | Row removed immediately; no ffmpeg started; Start/End fields unchanged |
| User cancels (Running) | ffmpeg killed; partial output deleted; row removed; neutral toast ("Create clip cancelled."); Start/End fields unchanged |
| App quits mid-job | `before-quit` handler calls `mediaJobService.killAll()`; staged partial deleted (best-effort); quit proceeds |
| Output not visible after wait | Tags already copied (DB + EXIF/XMP) before the wait; SlideMode-safe fallback resolves the output by absolute path; if DB row genuinely absent: honest error row (never asserts "outside a watched folder" as the sole cause — docs/TOOLS.md rule 4) |
| Source already deleted before Keep action | Defensive guard in the Keep handler; no-ops if `source` is null |
| ffprobe duration probe fails | Job proceeds; drawer row runs in indeterminate mode ("Creating clip…", no percent shown) |
| Invalid time strings reach main | Main re-validates and rejects with a clear error row; source untouched |
| start ≥ end reaches main | Main rejects with a clear error row; source untouched |

---

## Related

- [Creating Inspector Tools](TOOLS.md) — media-job layer stack, order of
  operations, rules, and checklist for adding a new tool
- [Re-encode (x264)](reencode-x264.md) — the primary worked example; shares the
  manager, IPC channels, finalize helper, and queue drawer
- [Normalize Audio](normalize-audio.md) — the second worked example; confirms
  layers 3–6 are reusable without modification
- INV-022 — investigation, behavioral spec, explicit rejections, and risks
- INV-035 — non-blocking queue drawer; removal of the in-viewer pin + blocking modals
- TASK-093 — backend: `preInputArgs` widening + `create-clip` job type + validated IPC
- TASK-094 — frontend: Mark Start / Mark End / Create Clip UI + orchestration in `ImageTools.tsx`
- TASK-095 — this feature doc and the manual QA matrix
