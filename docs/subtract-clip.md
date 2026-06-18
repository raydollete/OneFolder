---
title: Subtract Clip Feature (Mark Start / Mark End / Subtract Clip)
author: @rjdollete
last_updated: 2026-06-18
scope: feature
---

# Subtract Clip Feature

**Subtract Clip** is the inverse of [Create Clip](create-clip.md). Where Create Clip *keeps* the
marked `[start, end]` range, Subtract Clip *removes* it and cross-fades the two surviving pieces back
together:

- **clip A** = `[0 → Mark Start]`
- **clip B** = `[Mark End → end of video]`
- A and B are joined with a short (1-second) video **and** audio cross-fade.

The button appears in the inspector **Tools** section, directly below **Create Clip**, for any video
open in SlideMode. It reuses the same **Mark Start** / **Mark End** fields, the same media-job stack,
and the same finalize → tag → place → ingest → viewer-pin flow as the other video tools.

---

## User-Facing Behavior

1. Open a video in SlideMode and set **both** Mark Start and Mark End (Subtract Clip needs both
   bounds — there is no "open-ended" subtraction).
2. **Subtract Clip** is enabled only when:
   - both fields hold a valid `HH:MM:SS` value, and
   - start < end, and
   - start ≥ 1s (the cross-fade is 1s and must fit inside clip A; `offset = start − 1` must be ≥ 0).
   Otherwise it stays disabled (the same "End must be after start." hint as Create Clip covers the
   backwards-range case).
3. Clicking it engages the shared UI lock, pins the viewer to the source, and shows the shared
   spinner with the label **"Subtracting clip… N%"** (or "Subtracting clip…" if duration probing
   fails). A **Cancel** button kills ffmpeg and releases the lock.
4. On success the output `.mp4` lands beside the source (auto-incremented name), carries all source
   tags, auto-opens in place, the Mark fields are cleared, and the **"Keep which version?"** prompt
   appears — identical to the other tools.

All controls are disabled while `uiStore.isMediaProcessing` is true and are shown only for files
where `isFileExtensionVideo(file.extension)` is true.

---

## ffmpeg Command (single pass)

Unlike Create Clip (a lossless `-c copy` stream trim driven by `-ss`/`-to` pre-input args), Subtract
Clip is a **single re-encoding pass** whose trimming and joining are done entirely in a
`-filter_complex` graph. `START`/`END` are the marks **in seconds** (not `HH:MM:SS`):

```
ffmpeg -hide_banner -i "<input>" \
  -filter_complex "\
[0:v]trim=0:START,setpts=PTS-STARTPTS[va];\
[0:v]trim=start=END,setpts=PTS-STARTPTS[vb];\
[va][vb]xfade=transition=fade:duration=1:offset=(START-1)[v];\
[0:a]atrim=0:START,asetpts=N/SR/TB[aa];\
[0:a]atrim=start=END,asetpts=N/SR/TB[ab];\
[aa][ab]acrossfade=d=1[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -c:a aac \
  -progress pipe:1 -nostats -y "<output>"
```

| Element | Purpose |
|---|---|
| `trim=0:START` / `atrim=0:START` | Clip A: the beginning up to Mark Start |
| `trim=start=END` / `atrim=start=END` | Clip B: Mark End to end-of-stream |
| `setpts=PTS-STARTPTS` / `asetpts=N/SR/TB` | Reset each segment to start at t=0 (required by xfade/acrossfade) |
| `xfade=...:offset=(START-1)` | Video cross-fade; `offset` = clip A duration − cross-fade = `START − 1` (**computed**, never hardcoded) |
| `acrossfade=d=1` | Audio cross-fade so the join is not silent |
| `-map [v] -map [a]` | Take the faded video and audio outputs |
| `-c:v libx264 -c:a aac` | Re-encode (a blended frame cannot be stream-copied) |

The whole graph is a **single argv element** — `spawn()` runs without a shell, so no quoting is
needed (same as the `normalize-audio` filtergraph). Because both segments come from the same source
they share dimensions/pixfmt/fps, satisfying `xfade`'s same-format requirement automatically.

The graph is built by the pure helper `buildSubtractClipArgs(startSec, endSec, crossfadeSec=1)` in
`src/media/subtractClip.ts` and unit-tested in `tests/subtract-clip.test.ts`. The IPC handler in
`src/main.ts` (`onStartMediaJob`) validates the marks (both present, valid `HH:MM:SS`, start < end,
start ≥ 1s) and then passes the built args as the job's post-`-i` args with **no** preInputArgs.

---

## Reused Media-Job Stack

Subtract Clip is the fourth consumer of the generalized media-job stack (after Re-encode, Normalize
Audio, and Create Clip) and needs **no** changes to `MediaJobService`, `FfmpegRunner`, or the
renderer-side finalize flow. It is an ordinary single-invocation job whose only novelty is a
per-invocation `-filter_complex` arg array (analogous to how Create Clip supplies per-invocation
`-ss`/`-to`). See [create-clip.md](create-clip.md) and [TOOLS.md](TOOLS.md) for the shared layers.

---

## Known Limitations

### Sources with no audio stream

The graph references `[0:a]`, so a video with no audio track makes ffmpeg exit non-zero. The
existing error path handles this honestly: the partial output is deleted, the lock is released, and a
blocking `MediaJobErrorAlert` modal shows the ffmpeg stderr tail. The source is left untouched.

### End within one cross-fade of the true end (clip B too short)

If Mark End is within ~1s of the real end-of-video, clip B is shorter than the cross-fade and ffmpeg
fails. This is **not** pre-validated in the UI/handler (it would require probing the source
duration); it surfaces as the same loud error modal. The clip-A side is guarded up front (start ≥ 1s
disables the button).

### Progress percent computed against source duration

`MediaJobService` probes the **source** duration for the progress percentage, but the output is
shorter (the middle was removed), so the bar approaches but does not reach 100% before flipping to
"Finalizing…". Cosmetic only.

---

## Related

- [Create Clip](create-clip.md) — the keep-the-range sibling; shares the Mark Start/End fields
- [Creating Inspector Tools](TOOLS.md) — the media-job layer stack and checklist
- [Re-encode (x264)](reencode-x264.md) / [Normalize Audio](normalize-audio.md) — earlier worked
  examples of the shared stack
