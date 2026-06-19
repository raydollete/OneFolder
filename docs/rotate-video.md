---
title: Rotate CW / Rotate CCW Feature
author: @rjdollete
last_updated: 2026-06-19
scope: feature
---

# Rotate CW / Rotate CCW Feature

The **Rotate CW** and **Rotate CCW** tools appear in the inspector **Tools**
section whenever a video file is open in SlideMode.  They are the first two
controls in the section, above Re-encode (x264).  Each runs an ffmpeg job that
re-encodes the video with a 90° rotation baked into the pixels, producing a
corrected MP4 beside the source.  Like all other video tools, they copy all
source tags to the output, auto-open the result, and offer to delete the
original.

---

## User-Facing Behavior

1. Open a video in SlideMode.  The inspector Tools section shows two enabled
   buttons at the top: **Rotate CW** and **Rotate CCW** (above Re-encode (x264)).
2. Click either button.  The UI lock engages — arrow keys, Space, Delete, and
   all view-method shortcuts are inert for the duration of the job.  A spinner
   with the label **"Rotating clockwise… N%"** or **"Rotating
   counterclockwise… N%"** (or without the percent when duration probing fails)
   replaces the button area.
3. The ffmpeg process starts.  A **Cancel** button is shown with the title
   "Cancel rotate"; clicking it kills ffmpeg, removes any partial output, and
   releases the lock.
4. On completion:
   - The output `.mp4` lands beside the source with an auto-incremented name
     (`video.mp4`, `video 1.mp4`, `video 2.mp4` …).
   - All source tags (DB + EXIF/XMP HierarchicalSubject / Subject / Keywords)
     are copied to the output before it is shown.
   - The output auto-opens in the viewer (it becomes the selected file in
     SlideMode).
   - A post-job **"Keep which version?"** modal appears with three choices:
     - **Keep Modified** (default) — moves the original to the Recycle Bin (or
       permanently deletes it if the volume has no Recycle Bin) and keeps the
       rotated file open.
     - **Keep Original** — moves the rotated file to the Recycle Bin and
       switches the viewer back to the original.
     - **Keep Both** — keeps both files; the rotated file stays open.
5. The UI lock releases when the job finishes (success, failure, or cancel).

**Tool scope:** the buttons are shown only for files where
`isFileExtensionVideo(file.extension)` is true — currently `mp4`, `webm`, and
`ogg` (the three formats the HTML5 `<video>` player can render in SlideMode).
For any other file type the Tools section shows the neutral caption "No tools
available for this file type."

Both buttons are disabled while `uiStore.isMediaProcessing` is true — they
cannot run concurrently with any other media job.

---

## ffmpeg Commands

### Rotate CW (90° clockwise)

```
ffmpeg -hide_banner -i "<input>" -vf transpose=1 -c:v h264_nvenc -preset p7 -tune hq -cq 21 <audio-args> -progress pipe:1 -nostats -y "<output>"
```

### Rotate CCW (90° counterclockwise)

```
ffmpeg -hide_banner -i "<input>" -vf transpose=2 -c:v h264_nvenc -preset p7 -tune hq -cq 21 <audio-args> -progress pipe:1 -nostats -y "<output>"
```

Where `<audio-args>` is determined at runtime by an up-front ffprobe of the source's first
audio stream (see Audio Handling below):

| Source audio | `<audio-args>` |
|---|---|
| MP4-legal codec (AAC, MP3, AC3, EAC3, ALAC) | `-c:a copy` (lossless, instant) |
| Non-MP4-legal codec (Vorbis, Opus, FLAC, PCM, …) | `-c:a aac -b:a 192k` (transparent re-encode) |
| No audio stream | `-an` (no audio in output) |

| Argument | Purpose |
|---|---|
| `-hide_banner` | Suppress the ffmpeg version/config banner on stderr |
| `-i <input>` | Source file |
| `-vf transpose=1` | **Rotate 90° clockwise** — video filter; cannot stream-copy |
| `-vf transpose=2` | **Rotate 90° counterclockwise** — video filter; cannot stream-copy |
| `-c:v h264_nvenc` | Re-encode the video stream with NVIDIA NVENC H.264; requires an NVIDIA GPU + NVENC-enabled ffmpeg; **no software fallback** — the job fails loudly if NVENC is unavailable |
| `-preset p7` | Slowest/best-quality NVENC preset (p1 = fastest, p7 = slowest) |
| `-tune hq` | High-quality NVENC tuning mode |
| `-cq 21` | Constant-quality target (lower = better; 21 is visually transparent) |
| `-c:a copy` | Stream-copy audio (used when the source codec is MP4-legal) |
| `-c:a aac -b:a 192k` | Re-encode audio to AAC 192k (used when the source codec is non-MP4-legal) |
| `-an` | No audio (used when the source has no audio stream) |
| `-progress pipe:1` | Emit machine-readable `key=value` progress lines to stdout |
| `-nostats` | Suppress the human-readable stat line (avoids duplicating progress) |
| `-y` | Overwrite output without prompting — safe because the output path is freshly computed to be collision-free |
| `<output>` | Always has a `.mp4` extension; computed by `getUniqueSiblingPath` |

### Audio Handling

Before encoding, the `onStartMediaJob` handler probes the source's first audio stream
via `FfmpegRunner.probeFirstAudioCodec` (ffprobe `-select_streams a:0 -show_entries
stream=codec_name`).  The probe result drives a deterministic decision:

1. **MP4-legal codec** (aac, mp3, ac3, eac3, alac) → `-c:a copy` (bit-for-bit lossless,
   instant; the common case for `.mp4` sources).
2. **Non-MP4-legal codec** (vorbis, opus, flac, pcm_s16le, …) → `-c:a aac -b:a 192k`
   (transparent re-encode; previously failed with a mux error).
3. **No audio stream** → `-an` (output has no audio; must NOT error).
4. **Probe failure on a file that should have audio** → the handler throws, the promise
   rejects, and the renderer shows `MediaJobErrorAlert` with the probe error.  No silent
   "assume compatible" fallback (consistent with the fork's fail-loud philosophy).

This decision is **deterministic and up-front** — probe once, decide, encode once.  It
is NOT a try-copy-then-retry-on-failure scheme.  The same logic is applied to
`reencode-x264` via the shared `decideAudioArgs` helper (`src/media/audioArgs.ts`).

`subtract-clip` and `normalize-audio` already re-encode audio unconditionally and are
intentionally NOT probed.

### `transpose` filter values

| Value | Effect |
|---|---|
| `transpose=1` | 90° clockwise |
| `transpose=2` | 90° counterclockwise |

The video-codec arguments are defined in the shared `NVENC_H264_VIDEO_ARGS` constant
(`src/media/audioArgs.ts`) and spread into `MEDIA_JOB_SPECS` in `src/main.ts`.  The
audio arguments are not static — they are determined at runtime by the `decideAudioArgs`
helper (also in `src/media/audioArgs.ts`) via an up-front ffprobe call in the
`onStartMediaJob` IPC handler.  Only transport and progress flags are added around them
by `FfmpegRunner`.  Because `spawn` runs without a shell, no shell quoting is needed
(the surrounding quotes above are only for the shell-form illustration).

The `-c:v h264_nvenc` encoder requires an NVIDIA GPU and an NVENC-enabled ffmpeg build.
No software fallback is provided — if NVENC is unavailable, ffmpeg exits non-zero and
the job surfaces a loud `MediaJobErrorAlert`.  No new binary is bundled; the existing
bundled ffmpeg (documented in [personal-fork-notes.md](personal-fork-notes.md)) is
reused.  The NVENC block is shared with `reencode-x264` and `subtract-clip` via the
`NVENC_H264_VIDEO_ARGS` constant (extracted in INV-032) so they cannot drift.

---

## Non-Destructive Contract

"Non-destructive" means **non-destructive to the original file**:

- `MediaJobService` writes ffmpeg output into an application-owned staging
  directory (a subfolder of the OS temp dir, outside any watched location) via
  `getUniqueSiblingPath`.  The watched folder never sees a partial file.
- After ffmpeg finishes, the renderer tags the staged temp file (EXIF/XMP),
  suppresses the folder watcher for the final path, and asks main to place the
  file with a single `fse.move(temp → final)` via `commitMediaJob`.
- The source is only removed if the user explicitly picks **Keep Modified** in
  the post-job prompt — and even then it goes through the Recycle-Bin trash
  flow, not a direct delete.

This is the same contract honored by Re-encode (x264), Compress & Normalize
Audio, Create Clip, and Subtract Clip.  Rotate is the fifth consumer of this
shared stack.

Note that `-c:v libx264` re-encodes the video (see Known Limitations below) —
"non-destructive" refers only to file safety, not losslessness.

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

The source extension is replaced unconditionally with `.mp4`.

---

## Reused Media-Job Stack

Rotate CW / Rotate CCW are the fifth and sixth consumers of the generalized
media-job stack.  After INV-032 they differ from their original INV-030 form:

- No `preInputArgs` (unlike Create Clip, which pushes `-ss`/`-to` before `-i`).
- No per-invocation validation of clip marks (unlike Create Clip and Subtract Clip).
- **Per-invocation audio args** — the `onStartMediaJob` handler now has a branch for
  `rotate-cw`, `rotate-ccw`, and `reencode-x264` that probes the source audio and
  appends the decided `-c:a copy` / `-c:a aac -b:a 192k` / `-an` args at runtime.
  This mirrors how `subtract-clip` builds its `-filter_complex` args dynamically.
- The `MEDIA_JOB_SPECS` entries contain video-only args
  (`-vf transpose=N -c:v h264_nvenc -preset p7 -tune hq -cq 21`); audio is NOT
  static in the spec.

The reused layers — `FfmpegRunner`, `MediaJobService`, the three IPC channels,
`UiStore.beginMediaProcessing`/`endMediaProcessing`,
`FileStore.finalizeEncodedOutput`, `getUniqueSiblingPath`, and
`DeleteOriginalAfterJob` — operate on the generic job and require no edits.

See [TOOLS.md](TOOLS.md) for the full layer-stack description and the
order-of-operations rules.

---

## Known Limitations

### Video is re-encoded (lossy, slower than a stream copy)

The `transpose` video filter produces new frames — the video stream **must** be
re-encoded.  `-c:v h264_nvenc -preset p7 -tune hq -cq 21` (the shared NVENC block,
same as `reencode-x264` and `subtract-clip`) provides constant-quality H.264.
This is inherent to pixel-level rotation; there is no lossless path via `transpose`.

This means:
- Quality loss (small but non-zero) each time you rotate.
- Encoding time proportional to video length and resolution.
- Requires an NVIDIA GPU with NVENC support.  On a machine without NVENC, ffmpeg exits
  non-zero and the job surfaces a loud `MediaJobErrorAlert` — there is **no software
  fallback**.  This matches the behavior of `reencode-x264` and `subtract-clip`.

If you only need the player to *display* the video rotated without re-encoding,
set the `Rotate` / `display:matrix` metadata tag in the source file with an
external tool — that is out of scope for this tool.

### Non-MP4-legal audio is re-encoded to AAC (previously failed)

Prior to INV-032, stream-copying audio into the forced `.mp4` container failed if the
source audio codec was not MP4-muxable (Vorbis from `.webm`/`.ogg`, FLAC, PCM, etc.).

This is now fixed: the handler probes the source audio up-front and chooses
transparently:

| Source audio codec | Behavior |
|---|---|
| AAC, MP3, AC3, EAC3, ALAC (MP4-legal) | `-c:a copy` — lossless, instant |
| Vorbis, Opus, FLAC, PCM, … (non-MP4-legal) | `-c:a aac -b:a 192k` — transparent re-encode |
| No audio stream | `-an` — no audio in output, no error |
| Probe failure on a file that should have audio | Job aborts with `MediaJobErrorAlert` |

The re-encode is applied only when `-c:a copy` would fail; the common MP4/AAC case
is unchanged (lossless, instant copy).

### Rotation baked into pixels, not a display-matrix flag

`transpose` physically reorders pixels into the rotated orientation and bakes
the result into each frame.  It does **not** set a `Rotate` / display-matrix
metadata flag (which would leave pixels unchanged and rely on player support).

The pixel-baked approach is the most compatible choice (every player renders it
correctly) and is exactly what the user's stated `ffmpeg -vf "transpose=1"`
example produces.  The tradeoff is that it is lossy and re-encoding takes time.

---

## Error Handling Summary

| Scenario | Behavior |
|---|---|
| ffmpeg exits non-zero (including codec/container mismatch) | Lock released; partial output deleted; blocking `MediaJobErrorAlert` modal with stderr tail; no delete prompt |
| User cancels | ffmpeg killed; partial output deleted; lock released; quiet cancel toast ("Rotate clockwise cancelled." / "Rotate counterclockwise cancelled.") |
| App quits mid-job | `before-quit` handler calls `mediaJobService.killAll()`; staged partial deleted (best-effort); quit proceeds |
| Output not visible after wait | Tags already copied (DB + EXIF/XMP) before the wait; honest error if still absent — source untouched |
| Source already deleted | Defensive guard in `DeleteOriginalAfterJob`; `handleConfirm` no-ops if `source === null` |
| ffprobe duration probe fails | Job proceeds; spinner runs in indeterminate mode (no percent shown) |

---

## Manual QA Matrix

The following matrix is to be completed in the running app (`yarn dev` + `yarn
start`).  Steps marked REQUIRES MANUAL EXECUTION cannot be exercised headlessly.

### Happy Path

- [ ] REQUIRES MANUAL EXECUTION — Open a portrait/landscape `.mp4` (H.264 video
      + AAC audio) in SlideMode.  Verify Rotate CW and Rotate CCW appear above
      Re-encode (x264) as the first two buttons.
- [ ] REQUIRES MANUAL EXECUTION — Click Rotate CW.  Verify the spinner reads
      "Rotating clockwise… N%" (or "Rotating clockwise…" indeterminate), then
      "Finalizing…".  Verify the output opens in SlideMode and the frame content
      is rotated 90° clockwise.  Capture before/after screenshot.
- [ ] REQUIRES MANUAL EXECUTION — Click Rotate CCW on a fresh source.  Verify
      the frame content is rotated 90° counterclockwise.  Capture before/after
      screenshot.
- [ ] REQUIRES MANUAL EXECUTION — Verify tags are copied: open the output's
      inspector and confirm tags match the source.
- [ ] REQUIRES MANUAL EXECUTION — Verify the Keep-which-version prompt works:
      test Keep Modified (source to Recycle Bin), Keep Original (output to Recycle
      Bin, viewer back to source), and Keep Both.
- [ ] REQUIRES MANUAL EXECUTION — Verify the source is untouched on disk until a
      choice is made.

### Edge Paths

- [ ] REQUIRES MANUAL EXECUTION — Filtered/fully-tagged view: run Rotate CW from
      a view filtered by a tag.  Verify the output is opened and the rotate
      completes without a false "outside watched folder" error.
- [ ] REQUIRES MANUAL EXECUTION — Output name collision: rename the source so its
      stem already matches the output convention (`video 1.mp4` when `video.mp4`
      is the source).  Verify `getUniqueSiblingPath` avoids the collision.
- [ ] REQUIRES MANUAL EXECUTION — Zero-tag source: rotate a video with no tags.
      Verify the output has no tags and no error is thrown during tag-copy.
- [ ] REQUIRES MANUAL EXECUTION — Cancel mid-job: click Cancel during encoding.
      Verify the partial output is removed, the lock releases, and a quiet cancel
      toast appears ("Rotate clockwise cancelled." or "Rotate counterclockwise
      cancelled.").
- [ ] REQUIRES MANUAL EXECUTION — Quit mid-job: close the app while rotating.
      Verify no partial file is left in the source directory.
- [ ] REQUIRES MANUAL EXECUTION — Lock enforcement: verify arrow keys, Space,
      Delete, and navigation shortcuts are inert during the job.
- [ ] REQUIRES MANUAL EXECUTION — Non-MP4-legal audio: rotate a `.webm`/`.ogg`
      with Vorbis (or any source with FLAC/PCM audio).  Verify the job now
      **SUCCEEDS** (previously failed), the output is a playable `.mp4`, and the
      output audio codec is `aac` (~192k) as reported by ffprobe.  Capture ffprobe
      output.  (Previously this would have shown a `MediaJobErrorAlert`; the new
      behavior is transparent AAC re-encode.)

---

## Related

- [Creating Inspector Tools](TOOLS.md) — media-job layer stack, order of
  operations, rules, and checklist for adding a new tool
- [Re-encode (x264)](reencode-x264.md) — the primary worked example for every
  layer; shares the manager, IPC channels, finalize helper, and delete-original
  prompt
- [Compress & Normalize Audio](normalize-audio.md) — second consumer confirming
  layers 3–6 are reusable
- [Create Clip](create-clip.md) — third consumer, introducing pre-input args
- INV-030 — investigation, behavioral spec, and design rejections
- TASK-113 — MediaJobType + MEDIA_JOB_SPECS entries
- TASK-114 — ImageTools.tsx buttons and label strings
