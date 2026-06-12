---
title: Normalize Audio Feature
author: @rjdollete
last_updated: 2026-06-11
scope: feature
---

# Normalize Audio Feature

The "Normalize Audio" tool appears in the inspector **Tools** section whenever a
video file is open in SlideMode.  Clicking it passes the video stream through
untouched and re-encodes only the audio with ffmpeg's dynamic audio normalizer
(`dynaudnorm`), producing a loudness-corrected MP4 beside the source.  Like
Re-encode (x264), it copies all source tags to the output, auto-opens the
result, and offers to delete the original.

---

## User-Facing Behavior

1. Open a video in SlideMode. The inspector Tools section shows an enabled
   **Normalize Audio** button (alongside the **Re-encode (x264)** button).
2. Click the button. The UI lock engages — arrow keys, Space, Delete, and all
   view-method shortcuts are inert for the duration of the job. A spinner with
   the label **"Normalizing audio… N%"** (or just "Normalizing audio…" when
   duration probing fails) replaces the button.
3. The ffmpeg process starts. A **Cancel** button is shown; clicking it kills
   ffmpeg, removes any partial output, and releases the lock.
4. On completion:
   - The output `.mp4` lands beside the source with an auto-incremented name
     (`video.mp4`, `video 1.mp4`, `video 2.mp4` …).
   - All source tags (DB + EXIF/XMP HierarchicalSubject / Subject / Keywords)
     are copied to the output before it is shown.
   - The output auto-opens in the viewer (it becomes the selected file in
     SlideMode).
   - A **"Delete original?"** modal appears with two choices:
     - **Delete Original** — moves the source to the Recycle Bin (or
       permanently deletes it if the volume has no Recycle Bin).
     - **Keep Original** — closes the modal; the source is untouched.
5. The UI lock releases when the job finishes (success, failure, or cancel).

**Tool scope:** the button is shown only for files where
`isFileExtensionVideo(file.extension)` is true — currently `mp4`, `webm`, and
`ogg` (the three formats the HTML5 `<video>` player can render in SlideMode).
For any other file type the Tools section shows the neutral caption "No tools
available for this file type."

Both the Normalize Audio and Re-encode (x264) buttons are disabled while
`uiStore.isMediaProcessing` is true — they cannot run concurrently.

---

## ffmpeg Command

The exact command the main process runs is:

```
ffmpeg -hide_banner -i "<input>" -c:v copy -filter:a dynaudnorm=p=0.9:s=5 -progress pipe:1 -nostats -y "<output>"
```

| Argument | Purpose |
|---|---|
| `-hide_banner` | Suppress the ffmpeg version/config banner on stderr |
| `-i <input>` | Source file |
| `-c:v copy` | **Pass the video stream through untouched** (user's 2026-06-11 amendment — only the audio is re-encoded) |
| `-filter:a dynaudnorm=p=0.9:s=5` | Apply dynamic audio normalization to the audio stream (peak 0.9, smoothing 5) |
| `-progress pipe:1` | Emit machine-readable `key=value` progress lines to stdout |
| `-nostats` | Suppress the human-readable stat line (avoids duplicating progress) |
| `-y` | Overwrite output without prompting — safe because the output path is freshly computed to be collision-free |
| `<output>` | Always has a `.mp4` extension; computed by `getUniqueSiblingPath` |

The codec/filter arguments (`-c:v copy -filter:a dynaudnorm=p=0.9:s=5`) are
preserved verbatim from the user's stated requirement (INV-020).  Only
transport and progress flags are added around them.  The filter string is
passed as a single ffmpeg argument (`dynaudnorm=p=0.9:s=5`); because `spawn`
runs without a shell, no shell quoting is needed.

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
surfaces this honestly: partial output is deleted, the UI lock is released, and
an error toast appears containing the tail of ffmpeg's stderr (which will
include the container/codec mismatch message).  The source file is always left
untouched.

This is tracked as INV-020 open question 1.  If webm or ogg sources prove
relevant in practice, the output-extension decision should be revisited in
favor of preserving the source extension (INV-020 option b).

---

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

Normalize Audio is the second consumer of the generalized media-job stack built
by INV-018 and parameterized by TASK-085.  The reused layers are:

### Main-Process Job Runner (ReEncodeManager)

`src/ReEncodeManager.ts` is shared by both tools via the parameterized
signature:

```typescript
reEncodeManager.start(inputPath, jobArgs, outputExt, callbacks)
```

The `normalize-audio` job's args and output extension are defined in the
`MEDIA_JOB_SPECS` map in `src/main.ts`:

```typescript
'normalize-audio': {
  args: ['-c:v', 'copy', '-filter:a', 'dynaudnorm=p=0.9:s=5'],
  outputExt: 'mp4',
},
```

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

After a successful job, the renderer calls
`fileStore.finalizeEncodedOutput(source, outputPath)`, which runs the corrected
INV-019 post-encode order (see [reencode-x264.md](reencode-x264.md) for the
detailed description of each step).  Both tools share this helper exactly.

### Delete-Original Prompt

`DeleteOriginalAfterJob` (in `src/frontend/components/RemovalAlert.tsx`) is a
modal driven by `uiStore.deleteOriginalAfterJobFile`.  It is shared by both
tools:

```typescript
uiStore.openDeleteOriginalPrompt(file)   // opens the modal for `file`
uiStore.closeDeleteOriginalPrompt()      // closes it
```

The prompt reuses the same Recycle-Bin trash flow as the regular delete:
release media handles → `checkRecyclable` → `trashFile` /
`deleteFilePermanently` → `fileStore.deleteFiles`.

### Button and Orchestration

`ImageTools.tsx` renders both video-gated buttons and tracks which job is
active via a `activeJob: MediaJobType | null` state variable.  Both buttons are
disabled while `uiStore.isMediaProcessing` is true.  The shared `runMediaJob`
helper accepts a `MediaJobType` and runs the full orchestrated flow for either
tool.

---

## Error Handling Summary

| Scenario | Behavior |
|---|---|
| ffmpeg exits non-zero (including codec/container mismatch) | Lock released; partial output deleted; error toast with stderr tail; no delete prompt |
| User cancels | ffmpeg killed; partial output deleted; lock released; quiet cancel toast ("Normalize audio cancelled.") |
| App quits mid-job | `before-quit` handler calls `reEncodeManager.killAll()`; partial output deleted (best-effort); quit proceeds |
| Output not visible after wait | Tags already copied (DB + EXIF/XMP) before the wait; fallback clears filter and retries; honest toast if still absent — never asserts "outside a watched folder" as the sole cause |
| Source already deleted | Defensive guard in `DeleteOriginalAfterJob`; `handleConfirm` no-ops if `source === null` |
| ffprobe duration probe fails | Job proceeds; spinner runs in indeterminate mode (no percent shown) |

---

## Related

- [Creating Inspector Tools](TOOLS.md) — media-job layer stack, order of
  operations, rules, and checklist for adding a new tool
- [Re-encode (x264)](reencode-x264.md) — the companion tool; shares the
  manager, IPC channels, finalize helper, and delete-original prompt
- INV-020 — investigation, behavioral spec, open questions (container
  compatibility), and design rejections
- TASK-085 — parameterized `ReEncodeManager.start` + `MEDIA_JOB_SPECS` + generalized IPC channels
- TASK-086 — generalized `DeleteOriginalAfterJob` delete-original prompt
- TASK-087 — Normalize Audio button and `runMediaJob` orchestration in `ImageTools.tsx`
- TASK-088 — this feature doc and the manual QA matrix
