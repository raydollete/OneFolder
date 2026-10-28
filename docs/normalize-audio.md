---
title: Compress & Normalize Audio Feature
author: @rjdollete
last_updated: 2026-10-27
scope: feature
---

# Compress & Normalize Audio Feature

The "Compress & Normalize Audio" tool appears in the inspector **Tools** section
whenever a video file is open in SlideMode.  Clicking it enqueues a job that
passes the video stream through untouched and re-encodes only the audio with an
ffmpeg filtergraph that first dynamic-range-compresses the audio (`acompressor`)
and then loudness-normalizes it to EBU R128 targets (`loudnorm`), producing a
corrected MP4 beside the source.  Like Re-encode (x264), it copies all source
tags to the output and adds a row to the media queue drawer where the user can
review and keep the result.

---

## User-Facing Behavior

1. Open a video in SlideMode. The inspector Tools section shows an enabled
   **Compress & Normalize Audio** button (alongside the **Re-encode (x264)**
   button).
2. Click the button. The job is enqueued and the button returns immediately.
   The media queue drawer at the bottom of the window auto-opens (if not already
   open) with the new row showing status `Queued`.  Navigation, tagging, and all
   other input remain fully available.
3. When the queue is idle the job starts: the drawer row updates to
   **"Compressing & normalizing audio… N%"** (or "Compressing & normalizing
   audio…" when duration probing fails).  A **Cancel** button is shown in the
   row; clicking it kills ffmpeg, removes any partial output, and removes the row.
4. On completion:
   - The output `.mp4` lands beside the source with an auto-incremented name
     (`video.mp4`, `video 1.mp4`, `video 2.mp4` …).
   - All source tags (DB + EXIF/XMP HierarchicalSubject / Subject / Keywords)
     are copied to the output.
   - The drawer row transitions to `Completed`: the status becomes a
     **`View Completed`** control (clicking it opens the new file in the viewer);
     actions become three Keep buttons:
     - **Keep New** — moves the original to the Recycle Bin (or permanently
       deletes it if the volume has no Recycle Bin) and removes the row.
     - **Keep Original** — moves the new file to the Recycle Bin and removes
       the row.
     - **Keep Both** — keeps both files and removes the row.
   - The viewer is not moved by the job; the user chooses when (and whether)
     to open the result via `View Completed`.
5. If the job fails, the drawer row shows `Failed` (clicking the status reveals
   the ffmpeg stderr tail); actions become `[Retry] [Dismiss]`.

**Tool scope:** the button is shown only for files where
`isFileExtensionVideo(file.extension)` is true — currently `mp4`, `webm`, `ogg`,
`mov`, `mkv`, and `ts` (the recognized video containers; the player renders those
whose container and codecs Chromium can handle in SlideMode).
For any other file type the Tools section shows the neutral caption "No tools
available for this file type."

---

## ffmpeg Command

The exact command the main process runs is:

```
ffmpeg -hide_banner -i "<input>" -c:v copy -af "acompressor=threshold=-18dB:ratio=2:attack=20:release=250:knee=6,loudnorm=I=-16:TP=-1.5:LRA=11" -progress pipe:1 -nostats -y "<output>"
```

| Argument | Purpose |
|---|---|
| `-hide_banner` | Suppress the ffmpeg version/config banner on stderr |
| `-i <input>` | Source file |
| `-c:v copy` | **Pass the video stream through untouched** — only the audio is re-encoded |
| `-af "acompressor=…,loudnorm=…"` | Audio filtergraph: dynamic-range compress, then loudness-normalize (see below) |
| `-progress pipe:1` | Emit machine-readable `key=value` progress lines to stdout |
| `-nostats` | Suppress the human-readable stat line (avoids duplicating progress) |
| `-y` | Overwrite output without prompting — safe because the output path is freshly computed to be collision-free |
| `<output>` | Always has a `.mp4` extension; computed by `getUniqueSiblingPath` |

### Audio filtergraph (`-af`)

The two filters run in series (comma-chained), so the compressor's output feeds
the loudness normalizer:

| Filter / param | Purpose |
|---|---|
| `acompressor=threshold=-18dB` | Start compressing once the signal exceeds −18 dB |
| `ratio=2` | 2:1 compression above the threshold |
| `attack=20` / `release=250` | 20 ms attack, 250 ms release envelope (ms) |
| `knee=6` | 6 dB soft knee for a gradual onset around the threshold |
| `loudnorm=I=-16` | Target integrated loudness −16 LUFS (EBU R128) |
| `TP=-1.5` | Maximum true peak −1.5 dBTP |
| `LRA=11` | Target loudness range 11 LU |

The codec/filter arguments (`-c:v copy -af "acompressor=…,loudnorm=…"`) are
preserved verbatim from the user's stated requirement (2026-06-13 amendment).
Only transport and progress flags are added around them.  The whole filtergraph
is passed as a single ffmpeg argument; because `spawn` runs without a shell, no
shell quoting is needed (the surrounding quotes above are only for the shell-
form illustration).

---

## Output Extension Decision

The output extension is forced to `.mp4` — the same decision as Re-encode
(x264) — for uniformity across tool outputs.

**Important:** with `-c:v copy`, the forced `.mp4` container has a correctness
implication: the pass-through video codec must be muxable into MP4.  For the
common case (`mp4` source, H.264 video) this is fine.  See the Known
Limitations section below.

The reversible alternative would be to preserve the source extension so the
stream-copied video codec always lands in its own container.  This is option
(b) in INV-020 open question 2 and would make the VP8/Theora failure mode
disappear, at the cost of heterogeneous output filenames across tools.  The
current decision defers this until QA confirms whether webm/ogg sources matter
in practice (TASK-088).

---

## Known Limitation: VP8 and Theora Sources

Stream-copying (`-c:v copy`) into the forced `.mp4` container **fails for
sources whose video codec cannot be muxed into MP4**:

| Source format | Video codec | Muxable into `.mp4`? |
|---|---|---|
| `.mp4` | H.264 | Yes (common case) |
| `.webm` | VP8 or VP9 | **No for VP8; VP9 may work** |
| `.ogg` | Theora | **No** |

When the codec is not muxable, ffmpeg exits non-zero.  The existing error path
surfaces this honestly: partial output is deleted, and the queue drawer row
shows `Failed` with the ffmpeg stderr tail (which will include the
container/codec mismatch message).  The source file is always left untouched.

This is tracked as INV-020 open question 1.  If webm or ogg sources prove
relevant in practice, the output-extension decision should be revisited in
favor of preserving the source extension (INV-020 option b).

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

`getUniqueSiblingPath(dir, baseName, 'mp4')` in `common/fs.ts` — identical
logic to Re-encode (x264):

```
video.mp4    (if free)
video 1.mp4  (if video.mp4 exists)
video 2.mp4  (if video 1.mp4 also exists)
…
```

The source extension is replaced unconditionally with `.mp4`.  A source that is
already named `clip.mp4` produces `clip 1.mp4` as its first candidate.

---

## Reused Media-Job Stack

Compress & Normalize Audio is the second consumer of the generalized media-job
stack built by INV-018 and parameterized by TASK-085.  The reused layers are:

### Main-Process Job Runner (FfmpegRunner + MediaJobService)

`src/media/MediaJobService.ts` (which runs ffmpeg via `src/media/FfmpegRunner.ts`)
is shared by all tools via the parameterized signature:

```typescript
mediaJobService.start(inputPath, jobArgs, outputExt, callbacks)
```

The `normalize-audio` job's args and output extension are defined in the
`MEDIA_JOB_SPECS` map in `src/main.ts`:

```typescript
'normalize-audio': {
  args: [
    '-c:v',
    'copy',
    '-af',
    'acompressor=threshold=-18dB:ratio=2:attack=20:release=250:knee=6,loudnorm=I=-16:TP=-1.5:LRA=11',
  ],
  outputExt: 'mp4',
},
```

(The internal job-type key remains `'normalize-audio'`; only the user-facing
tool name and the ffmpeg args changed.)

The manager adds only the transport flags (`-hide_banner`, `-i`, `-progress
pipe:1`, `-nostats`, `-y`) around these args.  The full lifecycle — duration
probe, progress throttling, job registry, cancel via `taskkill /F /PID` on
Windows, partial-output cleanup, and `before-quit` `killAll()` — is shared.

### IPC Channels

Three generalized channels are defined in `src/ipc/messages.ts`:

| Channel | Direction | Shape |
|---|---|---|
| `START_MEDIA_JOB` (invoke) | renderer → main | `{ inputPath, jobType }` → `{ outputPath }` on success; rejects on failure or cancel |
| `MEDIA_JOB_PROGRESS` (send) | main → renderer | `{ jobId, percent?, outTimeSec?, totalSec? }` — first event carries `jobId` for cancel |
| `CANCEL_MEDIA_JOB` (send) | renderer → main | `jobId: string` |

`RendererMessenger` surface:

```typescript
RendererMessenger.startMediaJob(jobType, inputPath): Promise<{ outputPath: string }>
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
The `focusViewer: false` option means the viewer is not moved on completion; the
`View Completed` control in the drawer row opens the output on demand.

### Queue Store and Keep Actions

`ImageTools.tsx` calls `mediaQueueStore.enqueue(file, 'normalize-audio')` and
returns immediately.  `MediaQueueStore` handles the full lifecycle: enqueue →
processNext → runItem → Completed / Failed row.  Keep actions in the drawer
(Keep New / Keep Original / Keep Both) invoke the shared recyclable-check trash
helper as needed.

---

## Error Handling Summary

| Scenario | Behavior |
|---|---|
| ffmpeg exits non-zero (including codec/container mismatch) | Partial output deleted; queue row shows `Failed` with stderr tail |
| User cancels (Queued) | Row removed immediately; no ffmpeg started |
| User cancels (Running) | ffmpeg killed; partial output deleted; row removed; quiet cancel toast ("Compress & normalize audio cancelled.") |
| App quits mid-job | `before-quit` handler calls `mediaJobService.killAll()`; staged partial deleted (best-effort); quit proceeds |
| Output not visible after wait | Tags already copied (DB + EXIF/XMP) before the wait; honest error row if still absent — source untouched |
| Source already deleted before Keep action | Defensive guard in the Keep handler; no-ops if `source` is null |
| ffprobe duration probe fails | Job proceeds; drawer row runs in indeterminate mode (no percent shown) |

---

## Related

- [Creating Inspector Tools](TOOLS.md) — media-job layer stack, order of
  operations, rules, and checklist for adding a new tool
- [Re-encode (x264)](reencode-x264.md) — the companion tool; shares the
  manager, IPC channels, finalize helper, and queue drawer
- INV-020 — investigation, behavioral spec, open questions (container
  compatibility), and design rejections
- INV-035 — non-blocking queue drawer; removal of the in-viewer pin + blocking modals
- TASK-085 — parameterized `ReEncodeManager.start` + `MEDIA_JOB_SPECS` + generalized IPC channels
- TASK-086 — generalized delete-original prompt (now replaced by queue drawer Keep actions)
- TASK-087 — Normalize Audio button and `runMediaJob` orchestration in `ImageTools.tsx`
- TASK-088 — this feature doc and the manual QA matrix
