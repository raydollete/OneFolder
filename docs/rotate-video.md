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
ffmpeg -hide_banner -i "<input>" -vf transpose=1 -c:v libx264 -c:a copy -progress pipe:1 -nostats -y "<output>"
```

### Rotate CCW (90° counterclockwise)

```
ffmpeg -hide_banner -i "<input>" -vf transpose=2 -c:v libx264 -c:a copy -progress pipe:1 -nostats -y "<output>"
```

| Argument | Purpose |
|---|---|
| `-hide_banner` | Suppress the ffmpeg version/config banner on stderr |
| `-i <input>` | Source file |
| `-vf transpose=1` | **Rotate 90° clockwise** — video filter; cannot stream-copy |
| `-vf transpose=2` | **Rotate 90° counterclockwise** — video filter; cannot stream-copy |
| `-c:v libx264` | Re-encode the video stream with H.264 (libx264); required because `transpose` produces new frames |
| `-c:a copy` | **Stream-copy the audio** — no audio re-encode (bit-for-bit identical to source audio) |
| `-progress pipe:1` | Emit machine-readable `key=value` progress lines to stdout |
| `-nostats` | Suppress the human-readable stat line (avoids duplicating progress) |
| `-y` | Overwrite output without prompting — safe because the output path is freshly computed to be collision-free |
| `<output>` | Always has a `.mp4` extension; computed by `getUniqueSiblingPath` |

### `transpose` filter values

| Value | Effect |
|---|---|
| `transpose=1` | 90° clockwise |
| `transpose=2` | 90° counterclockwise |

The codec/filter arguments are defined as static entries in the `MEDIA_JOB_SPECS`
map in `src/main.ts`.  Only transport and progress flags are added around them by
`FfmpegRunner`.  Because `spawn` runs without a shell, no shell quoting is needed
(the surrounding quotes above are only for the shell-form illustration).

The `-c:v libx264` encoder relies on the existing `--enable-gpl --enable-libx264`
ffmpeg build.  No new binary is bundled; the existing bundled ffmpeg (documented in
[personal-fork-notes.md](personal-fork-notes.md)) is reused.  No new licensing
obligation arises.

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
media-job stack.  They are the **simplest** consumers to date:

- No `preInputArgs` (unlike Create Clip, which pushes `-ss`/`-to` before `-i`).
- No per-invocation validation (unlike Create Clip and Subtract Clip, which
  validate `clip.start`/`clip.end` in the `onStartMediaJob` IPC handler).
- No per-invocation dynamic args (unlike Subtract Clip, which builds a
  `-filter_complex` graph from the clip marks).
- The args are fully static entries in `MEDIA_JOB_SPECS`; the existing handler
  falls through to `jobArgs = spec.args` with empty `preInputArgs` with no new
  branch required.

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
re-encoded.  `-c:v libx264` matches the Re-encode (x264) tool's encoder choice
for consistency and quality.  This is inherent to pixel-level rotation; there is
no lossless path via `transpose`.

This means:
- Quality loss (small but non-zero) each time you rotate.
- Encoding time proportional to video length and resolution.

If you only need the player to *display* the video rotated without re-encoding,
set the `Rotate` / `display:matrix` metadata tag in the source file with an
external tool — that is out of scope for this tool.

### `-c:a copy` into forced `.mp4` can fail for non-MP4-muxable audio

Stream-copying audio into the forced `.mp4` container **fails if the source
audio codec cannot be muxed into MP4** — for example, Vorbis audio from a
`.webm` or `.ogg` source.

| Source format | Audio codec | Muxable into `.mp4`? |
|---|---|---|
| `.mp4` | AAC / MP3 | Yes (common case) |
| `.webm` | Vorbis / Opus | **Vorbis: No; Opus: may work** |
| `.ogg` | Vorbis | **No** |

When the codec is not muxable, ffmpeg exits non-zero.  The existing error path
surfaces this honestly: partial output is deleted, the UI lock is released, and a
blocking `MediaJobErrorAlert` modal appears containing the tail of ffmpeg's
stderr (which will include the container/codec mismatch message).  The source
file is always left untouched.

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
- [ ] REQUIRES MANUAL EXECUTION — Audio-incompatible source: rotate a `.webm`
      with Vorbis audio.  Verify ffmpeg fails, a blocking `MediaJobErrorAlert`
      modal appears with a meaningful error message, and the source is left
      untouched.

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
