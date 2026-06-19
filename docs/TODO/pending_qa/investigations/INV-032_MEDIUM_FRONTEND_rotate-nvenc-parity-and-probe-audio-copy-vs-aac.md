---
id: INV-032
title: 'Rotate tools must use NVENC like the other tools; add an ffprobe-driven copy-vs-AAC audio decision shared by rotate + reencode-x264'
reported_bug: "Two related improvements to the video media-job tools (follow-up to INV-030). (1) The new rotate-cw/rotate-ccw specs encode video with software libx264 instead of the project-standard NVENC settings (-c:v h264_nvenc -preset p7 -tune hq -cq 21) used by reencode-x264 and subtract-clip; this fork has NO software fallback, so NVENC-unavailable must fail loudly. (2) Jobs that -c:a copy (rotate-cw, rotate-ccw, reencode-x264) silently break when the source's audio codec is not MP4-legal (Vorbis, Opus from old muxers, FLAC, PCM, etc.). Add a deterministic up-front ffprobe step: probe the first audio stream's codec_name; if MP4-legal keep -c:a copy, otherwise re-encode with -c:a aac -b:a 192k; a source with no audio must not error; a probe FAILURE on a file that should have audio must surface a loud error (no silent retry-on-failure). Factor the copy-vs-AAC decision into ONE shared helper applied to rotate AND reencode-x264. subtract-clip and normalize-audio already re-encode audio and are out of scope."
date: 2026-06-19
status: active
superseded_by:
tasks_spawned: [TASK-119, TASK-120, TASK-121, TASK-122]
root_cause_category: wrong-abstraction
affects:
  - 'Media-job spec map + onStartMediaJob handler (src/main.ts)'
  - 'Subtract-clip encoder args (src/media/subtractClip.ts) — shared NVENC block'
  - 'FfmpegRunner ffprobe surface (src/media/FfmpegRunner.ts)'
  - 'MediaJobService start path / argument flow (src/media/MediaJobService.ts)'
  - 'Tool documentation (docs/rotate-video.md, docs/reencode-x264.md, docs/TOOLS.md)'
  - 'Media-job tests (tests/media-job.test.ts, tests/subtract-clip.test.ts)'
---

## Bug Report

This is a follow-up to **INV-030** (Rotate CW / Rotate CCW video tools), now at
`docs/TODO/pending_qa/investigations/INV-030_MEDIUM_FRONTEND_rotate-cw-ccw-video-tools.md`.
INV-030 shipped two working rotate tools but baked in two encoder decisions that
need correcting. Both are main-process / spec-layer concerns — the renderer UI
(`ImageTools.tsx`) is already fully wired and needs **no change** (it calls
`runMediaJob('rotate-cw' | 'rotate-ccw')` with no clip payload; all args are built
in `src/main.ts`).

### Observed Behavior

**Directive 1 — Rotations use software libx264 instead of NVENC.**
The `rotate-cw` / `rotate-ccw` entries in `MEDIA_JOB_SPECS` (`src/main.ts:73–83`)
currently encode video with software `libx264`:

```
src/main.ts:76  rotate-cw : ['-vf', 'transpose=1', '-c:v', 'libx264', '-c:a', 'copy']
src/main.ts:81  rotate-ccw: ['-vf', 'transpose=2', '-c:v', 'libx264', '-c:a', 'copy']
```

Every other video-encoding job in the fork uses NVENC with identical settings:

```
src/main.ts:41          reencode-x264 : -c:v h264_nvenc -preset p7 -tune hq -cq 21
src/media/subtractClip.ts:60–67  subtract-clip: -c:v h264_nvenc -preset p7 -tune hq -cq 21
```

So rotate diverges: it is slower (CPU encode), produces a different quality/size
profile, and silently keeps working on a machine without NVENC where every other
tool would fail loudly — violating the fork's no-software-fallback contract
(stated in the `reencode-x264` spec comment, `src/main.ts:37–40`).

**Directive 2 — `-c:a copy` into a forced `.mp4` silently breaks for non-MP4-legal audio.**
`rotate-cw`, `rotate-ccw`, and `reencode-x264` all stream-copy audio with
`-c:a copy` while forcing `outputExt: 'mp4'` (`src/media/MediaJobService.ts:101–102`).
When the source's audio codec cannot be muxed into MP4 (Vorbis, Opus from older
muxers, FLAC, PCM, …), ffmpeg exits non-zero and the whole job fails. The user
must currently fall back to Re-encode-then-rotate or external tooling. The failure
is loud (the existing `MediaJobErrorAlert` modal), but it is avoidable: nearly all
such content can be transparently re-encoded to AAC.

### Expected Behavior

**Directive 1:** Rotate CW and Rotate CCW must encode video with the project-standard
NVENC block, identical to `reencode-x264` and `subtract-clip`, while keeping the
`-vf transpose=1` (CW) / `-vf transpose=2` (CCW) video filter:

```
rotate-cw : -vf transpose=1 -c:v h264_nvenc -preset p7 -tune hq -cq 21 <audio args>
rotate-ccw: -vf transpose=2 -c:v h264_nvenc -preset p7 -tune hq -cq 21 <audio args>
```

There is intentionally **no software fallback** — if NVENC is unavailable the job
fails loudly, exactly like `reencode-x264` today.

**Directive 2:** Replace the unconditional `-c:a copy` on the three copy-audio jobs
(rotate-cw, rotate-ccw, reencode-x264) with a **deterministic up-front decision**
driven by a single shared helper:

1. ffprobe the source's **first audio stream** `codec_name`.
2. **No audio stream at all** → emit no audio (`-an`, or simply omit any `-c:a`
   mapping). This must **not** error.
3. Audio codec is **MP4-legal** (aac, mp3, ac3, eac3, alac, …) → keep
   `-c:a copy` (lossless, instant — unchanged behavior).
4. Audio codec is present but **not MP4-legal** → re-encode with
   `-c:a aac -b:a 192k` (transparent for nearly all content).
5. A **probe FAILURE on a file that should have audio** (probe error / unparseable
   output, as opposed to a clean "no audio stream" result) must surface a **loud
   error** and abort the job — no silent retry-on-failure, no "assume compatible"
   fallback. This is consistent with the fork's "fail loud, no silent fallbacks"
   philosophy.

This decision is up-front (probe → decide → build args → encode once), **not** a
retry-on-failure. It applies only to jobs that currently `-c:a copy`. `subtract-clip`
(forces `-c:a aac` via `acrossfade`) and `normalize-audio` (re-encodes via an `-af`
filter) already re-encode audio and are **out of scope** — confirmed below.

### Reproduction Context

Deterministic, given the right source:

- **Directive 1:** any rotate job on any source uses libx264 today (observable in
  `src/main.ts:76,81` and via ffprobe of the output's encoder); on a non-NVENC
  machine rotate would succeed where reencode fails — the inconsistency itself is
  the bug.
- **Directive 2:** a `.webm` with Vorbis/Opus audio, or any source with FLAC/PCM
  audio, fed to Rotate CW / Rotate CCW / Re-encode (x264) fails the MP4 mux today.

---

## Root Cause Analysis

**Category:** wrong-abstraction (with a copy-paste-inheritance trigger for D1 and an
implicit-contract trigger for D2)

### Diagnosis

**Directive 1 — copy-paste inheritance of a stale encoder choice.**
INV-030 chose `-c:v libx264` for rotate because, at the time the rotate copy was
written, the documentation described the rotate encoder as "matching Re-encode
(x264)'s encoder choice" (see `INV-030` lines 113–116 and `docs/rotate-video.md:98,173`).
But `reencode-x264` had already migrated from libx264 to NVENC (`src/main.ts:37–41`
comment: "Despite the legacy 'x264' name, this re-encodes with NVIDIA NVENC…").
The rotate spec cloned the *documented intent* ("same as reencode") but pasted the
*pre-migration encoder string*, so the two drifted. The deeper issue is that the
NVENC argument block is now **triplicated** — `src/main.ts:41` (reencode),
`src/media/subtractClip.ts:60–67` (subtract), and the two rotate sites — with no
shared source of truth, so any future encoder change can again leave one consumer
behind. (Confirmed by bomb-squad: these are the only two ffmpeg video-encoder arg
builders in the codebase; there is no other software-encoder divergence anywhere.)

**Directive 2 — an implicit, unchecked contract that source audio is always MP4-muxable.**
The media-job stack centralizes the output container at a single chokepoint:
`outputExt: 'mp4'` per spec, applied in `MediaJobService.start`
(`src/media/MediaJobService.ts:95–102`). The copy-audio jobs pair that forced
container with `-c:a copy`, which silently assumes the source audio codec is
MP4-legal. That assumption is never verified, so the failure mode is "works for
my test files, breaks for the user's Vorbis `.webm`." The right abstraction is to
make the audio-codec decision **explicit and per-source**, probed once before the
encode — turning an unstated invariant into a checked one. The fix belongs in a
single shared helper because all three copy-audio jobs share the identical latent
bug; fixing it per-spec would re-introduce drift.

A subtle but important sub-point (flagged by bomb-squad): the existing
`FfmpegRunner.probeDuration` swallows **all** probe failures to `undefined`
(acceptable for an optional progress percentage). The new codec probe must **not**
inherit that swallow-to-undefined behavior for the "should-have-audio but probe
failed" case — silently treating an indeterminate result as "compatible" would
just relocate the silent failure earlier. The probe must distinguish three
outcomes: (a) a parsed codec name, (b) a clean "no audio stream" result, and
(c) a probe error → loud abort.

### Diagnostic Questions Considered

- **Wrong mental model?** Partly (D1): the rotate author's model was "rotate ==
  reencode's encoder," which was true of the *name* but stale relative to the
  *value* after the NVENC migration.
- **Architectural shortcoming?** Yes, mildly: there is no single NVENC-args
  constant, which permitted the drift. Fixing D1 well means extracting one.
- **Incorrect order of operations?** No — the shared finalize/place/ingest order is
  reused verbatim and is correct. (D2 adds one *earlier* step — probe before
  building args — but does not reorder the existing flow.)
- **Missing edge case?** Yes (D2): the non-MP4-legal-audio and no-audio cases were
  never handled; only the happy MP4/AAC path was exercised (tests only ever feed
  H.264/AAC `.mp4`, `tests/media-job.test.ts:177–184`).
- **Wrong abstraction?** Yes — this is the primary category. The container is forced
  but the audio-codec compatibility it implies is left as an unchecked contract,
  and the encoder args are duplicated rather than shared.
- **Silent failure?** Two flavors. D1: rotate would *silently succeed* on a
  non-NVENC machine where the contract says it should fail loudly. D2: the fix must
  avoid *introducing* a silent failure (indeterminate probe → assume compatible);
  the should-have-audio probe failure must be loud.

---

## Blast Radius

These are the areas touched by the single underlying flaw "per-job ffmpeg arg
tables encode duplicated/stale codec decisions and an unchecked audio-container
contract." Each is addressed in the Holistic Solution.

1. **`MEDIA_JOB_SPECS` — rotate entries (`src/main.ts:73–83`).** Must switch video
   to NVENC and must stop hardcoding `-c:a copy`. Because the audio args are now
   runtime-built from the probe, the rotate entries can no longer be fully static.
   The video portion (`-vf transpose=N -c:v h264_nvenc -preset p7 -tune hq -cq 21`)
   stays in the spec; the audio portion is appended per-invocation in the handler.

2. **`onStartMediaJob` handler (`src/main.ts:785–907`).** Today it special-cases
   `create-clip` (preInputArgs) and `subtract-clip` (dynamic jobArgs) and falls
   through to `jobArgs = spec.args` for everything else. It must gain an
   **async probe-then-build** step for the copy-audio jobs (rotate-cw, rotate-ccw,
   reencode-x264): probe the source, decide copy vs aac vs none, and append the
   resulting audio args to the (video-only) base args. The handler already returns
   a `Promise`, so awaiting the probe fits its existing shape.

3. **`reencode-x264` spec (`src/main.ts:36–43`).** Shares the identical latent
   audio-copy bug. Its `-c:a copy` must move from the static spec into the same
   runtime audio-decision path. Its video/NVENC args are already correct.

4. **NVENC argument duplication (`src/main.ts:41`, `src/media/subtractClip.ts:60–67`,
   rotate sites).** The encoder block is triplicated. Extract a single
   `NVENC_H264_VIDEO_ARGS` constant (e.g. in `src/media/` or `common/`) and reference
   it from reencode, subtract-clip, and the two rotate specs so the drift that caused
   D1 cannot recur. (Refactor, behavior-preserving for reencode/subtract.)

5. **Shared audio-decision helper (new).** A single pure-ish helper — e.g.
   `buildAudioArgsForCopyJob(probeResult)` or an async
   `decideAudioArgs(ffmpegRunner, inputPath)` — that returns one of `['-c:a','copy']`,
   `['-c:a','aac','-b:a','192k']`, or `['-an']` (and throws on a should-have-audio
   probe failure). Applied to BOTH rotate jobs AND reencode-x264 so they cannot drift.
   Likely lives in `src/media/` (e.g. a new `audioArgs.ts`) alongside `subtractClip.ts`.

6. **`FfmpegRunner` ffprobe surface (`src/media/FfmpegRunner.ts:147–197`).** ffprobe
   is already bundled (`getFfprobePath()` → `resources/ffmpeg/ffprobe.exe`,
   `common/fs.ts:149–152`) and already spawned by `probeDuration`. A **new** method
   is needed — e.g. `probeFirstAudioCodec(input): Promise<{ codecName: string } |
   { noAudio: true } | { error: Error }>` — modeled on `probeDuration` but using
   `-select_streams a:0 -show_entries stream=codec_name` (the exact argv shape the
   test at `tests/media-job.test.ts:222–223` already demonstrates for the video
   stream). Crucially it must NOT collapse a probe error into the "no audio"/"assume
   compatible" path. No new binary is bundled.

7. **`MediaJobService` argument flow (`src/media/MediaJobService.ts`).** No structural
   change required: it already accepts `jobArgs: string[]` verbatim from the handler.
   The runtime-built audio args flow through unchanged. (Confirm: `start()` does not
   inspect or mutate `jobArgs`; it passes them to `FfmpegRunner.run`.) The probe is
   best done in the handler (which already awaits and builds args) so the service
   stays codec-agnostic, OR inside `start`/`_encode`; the cleanest integration is
   investigated in TASK-120 — the recommendation is the handler, keeping
   `MediaJobService` ignorant of codecs (matching how create-clip/subtract-clip build
   args in the handler).

8. **Tests (`tests/media-job.test.ts`, `tests/subtract-clip.test.ts`).** The suite
   only ever feeds H.264/AAC `.mp4` sources, so neither flaw is caught at build time.
   Add: (a) an args-assertion test for the rotate specs mirroring
   `tests/subtract-clip.test.ts` (lock in NVENC + transpose); (b) unit tests for the
   shared audio-decision helper (copy / aac / none / loud-error branches) using the
   spawn-mock or a pure decision function; and, where the real bundled ffmpeg is
   present, a functional test feeding a non-MP4-legal-audio source.

9. **`create-clip` sibling defect (note, out of scope).** `create-clip` uses
   `-c copy` (`src/main.ts:62`), copying BOTH streams into a forced `.mp4`, so it has
   a strictly broader version of D2 (it can fail on incompatible *video* too —
   VP8/VP9/Theora). The directive explicitly scopes create-clip OUT of the probe
   change (it does not `-c:a copy`; it `-c copy`s). Document it as a known sibling
   for a future investigation; do not change it here.

10. **Documentation (`docs/`).** `docs/rotate-video.md` (ffmpeg command table,
    Known Limitations, QA matrix), `docs/reencode-x264.md` (ffmpeg command + audio
    section), `docs/TOOLS.md` (Worked Example 5 still says libx264; the encoder/audio
    rules), and the one-line summary in `docs/index.md:49` all currently describe
    `-c:v libx264 -c:a copy` for rotate and `-c:a copy` for reencode and must be
    updated.

---

## UX / Requirements Specification

### Purpose

Make the rotate tools behave identically to the other NVENC video tools, and make
all three copy-audio jobs robust to non-MP4-legal source audio without sacrificing
the lossless/instant `-c:a copy` fast path when it is valid — all while preserving
the fork's fail-loud, no-silent-fallback contract.

### User-Stated Design Decisions

1. **Rotate must use the project-standard NVENC settings** — `-c:v h264_nvenc
   -preset p7 -tune hq -cq 21`, identical to `reencode-x264` and `subtract-clip`,
   keeping `-vf transpose=1` (CW) / `-vf transpose=2` (CCW). (Verbatim.)
2. **No software fallback** — NVENC-unavailable must fail loudly, matching the
   existing `reencode-x264` contract. (Verbatim.)
3. **Deterministic up-front audio probe-then-decide, NOT silent retry-on-failure** —
   probe the first audio stream's `codec_name`; MP4-legal → `-c:a copy`; otherwise
   `-c:a aac -b:a 192k`. (Verbatim.)
4. **A source with no audio stream must not error** — omit audio (`-an` or skip the
   `-c:a` arg). (Verbatim.)
5. **A probe FAILURE on a file that should have audio must surface a loud error** —
   consistent with "fail loud, no silent fallbacks." (Verbatim.)
6. **ONE shared helper applied to BOTH rotate jobs AND `reencode-x264`** — they share
   the identical latent bug; do not duplicate the decision. (Verbatim.)
7. **"Where applicable" = jobs that currently `-c:a copy`** — rotate-cw, rotate-ccw,
   reencode-x264 only. Do **not** add probing to jobs that don't copy audio. (Verbatim.)
8. **`subtract-clip` and `normalize-audio` are already safe and out of scope** —
   confirm and note. (Verbatim; confirmed below.)

### Behavioral Specifications

- Rotate CW → `-vf transpose=1` + NVENC block + runtime audio args.
- Rotate CCW → `-vf transpose=2` + NVENC block + runtime audio args.
- Re-encode (x264) → NVENC block (unchanged) + runtime audio args (was `-c:a copy`).
- Audio decision (shared helper), evaluated once per invocation before encode:
  - first audio stream codec ∈ MP4-legal set (aac, mp3, ac3, eac3, alac, and any
    others confirmed muxable) → `['-c:a', 'copy']`.
  - first audio stream codec present but not MP4-legal → `['-c:a', 'aac', '-b:a', '192k']`.
  - no audio stream → `['-an']` (or omit audio mapping); no error.
  - probe error / unparseable output for a file expected to have audio → throw,
    job aborts with a loud `MediaJobErrorAlert`.
- All other media-job behavior (staging, tag-copy, finalize, delete-original prompt,
  lock, cancel, quit-mid-job) is unchanged and reused.

### Explicit Rejections

- Do **not** add a software-encoder fallback for rotate (no libx264 fallback).
- Do **not** implement audio compatibility as a try-copy-then-retry-with-aac scheme —
  the decision is made up-front from the probe.
- Do **not** silently assume "compatible" when the probe fails on a should-have-audio
  file — fail loud.
- Do **not** add probing to `subtract-clip`, `normalize-audio`, or any job that does
  not `-c:a copy`.
- Do **not** change `create-clip` (`-c copy`) in this investigation — note it as a
  separate, broader sibling defect.
- Do **not** change the renderer (`ImageTools.tsx`) — it is already wired and
  codec-agnostic; this is a main-process/spec/probe change only.

---

## Holistic Solution

### Approach

Fix the root cause in two coordinated moves, then re-point the three copy-audio
jobs at the new shared logic:

1. **Single NVENC source of truth + rotate parity (TASK-119).** Extract a
   `NVENC_H264_VIDEO_ARGS` constant (`['-c:v','h264_nvenc','-preset','p7','-tune','hq',
   '-cq','21']`) and reference it from `reencode-x264` (`src/main.ts:41`),
   `subtract-clip` (`src/media/subtractClip.ts`), and the two rotate specs. Change the
   rotate specs to `['-vf','transpose=1', ...NVENC_H264_VIDEO_ARGS]` /
   `transpose=2` — video only, no static `-c:a copy`. Behavior-preserving for
   reencode/subtract; rotate gains NVENC.

2. **ffprobe first-audio-codec probe (TASK-120, part A).** Add
   `FfmpegRunner.probeFirstAudioCodec(input)` returning a three-state result
   (codec name / no-audio / error), modeled on `probeDuration` but with
   `-select_streams a:0 -show_entries stream=codec_name -of default=nokey=1:noprint_wrappers=1`
   and WITHOUT swallowing a real error into "no audio."

3. **Shared audio-decision helper + handler wiring (TASK-120, part B).** Add a shared
   helper (new `src/media/audioArgs.ts`) exposing the MP4-legal codec set and an
   async `decideAudioArgs(runner, inputPath)` (or a pure
   `audioArgsForProbe(result)` plus a thin async caller) that returns the audio arg
   array or throws on a should-have-audio probe failure. In `onStartMediaJob`
   (`src/main.ts`), for `jobType ∈ {rotate-cw, rotate-ccw, reencode-x264}`, await the
   helper and append its result to the spec's video-only base args before calling
   `mediaJobService.start`. Leave create-clip / subtract-clip / normalize-audio paths
   untouched. Keep `MediaJobService` codec-agnostic (the cleanest integration —
   matches how create-clip/subtract-clip already build args in the handler).

4. **Tests (TASK-121).** Args-assertion test for the rotate specs (NVENC + transpose),
   unit tests for the audio-decision helper (copy / aac / none / loud-error), and —
   guarded on the bundled ffmpeg being present — a functional test that rotates/
   reencodes a source with non-MP4-legal audio and asserts a successful AAC output
   (and that a no-audio source produces a valid output with no audio).

5. **Docs (TASK-122).** Update `docs/rotate-video.md`, `docs/reencode-x264.md`,
   `docs/TOOLS.md` (Worked Example 5 + encoder/audio rules), and `docs/index.md:49`
   to describe NVENC for rotate and the probe-driven copy-vs-AAC audio behavior for
   all three copy-audio jobs; note the `create-clip` sibling defect and that
   subtract-clip/normalize-audio are already safe.

### Expected Outcomes

- Rotate CW/CCW produce NVENC-encoded H.264 with the same preset/tune/cq as the
  other tools; on a non-NVENC machine rotate fails loudly like reencode.
- All three copy-audio jobs keep audio losslessly (`-c:a copy`) when it is MP4-legal,
  transparently re-encode to AAC 192k when it is not, omit audio cleanly when there
  is none, and fail loudly when a should-have-audio source cannot be probed.
- The NVENC args exist in exactly one place; future encoder changes can't drift.
- `yarn build` and `yarn test` pass; new tests lock in both fixes.

### Risks and Tradeoffs

- **Extra ffprobe spawn per copy-audio job.** One short-lived probe before encode;
  negligible vs the encode itself and bounded by a timeout (reuse `probeDuration`'s
  10 s pattern). The probe-failure-on-should-have-audio path is loud by design.
- **MP4-legal codec set is an allowlist.** It must be reasonably complete (aac, mp3,
  ac3, eac3, alac at minimum). An unknown-but-actually-muxable codec would be
  re-encoded to AAC unnecessarily (transparent, slightly lossy) rather than copied —
  a safe, conservative default. Document the set so it can be extended.
- **AAC re-encode is lossy.** Only applied when copy is impossible; 192k is
  transparent for nearly all content. The lossless fast path is preserved whenever
  valid, so the common MP4/AAC case is unchanged (instant copy).
- **`create-clip` remains exposed** to its broader both-streams variant of D2. Out
  of scope per the directive; documented as a known sibling for follow-up.

### User-requirement verification

- D1 "rotate uses `-c:v h264_nvenc -preset p7 -tune hq -cq 21`, keep transpose" →
  TASK-119. ✓
- D1 "no software fallback, fail loud" → NVENC-only spec; inherits reencode contract;
  documented in TASK-122. ✓
- D2 "ffprobe first audio stream codec_name; MP4-legal → copy; else aac 192k" →
  TASK-120 (probe + helper). ✓
- D2 "no audio stream → don't error (`-an`/omit)" → helper no-audio branch, TASK-120. ✓
- D2 "probe failure on should-have-audio → loud error, no silent fallback" → helper
  throws; handler rejects → `MediaJobErrorAlert`; TASK-120. ✓
- "ONE shared helper for BOTH rotate AND reencode-x264" → single `decideAudioArgs`
  applied to all three jobs, TASK-120. ✓
- "where applicable = jobs that `-c:a copy`; don't touch others" → only rotate-cw,
  rotate-ccw, reencode-x264 wired; subtract/normalize untouched, TASK-120. ✓
- "rotate moves from static spec to per-invocation arg building like
  create-clip/subtract-clip" → handler builds audio args at runtime, TASK-120. ✓
- "investigate the ffprobe binary path / sibling binary availability" → confirmed:
  `getFfprobePath()` already resolves the bundled `resources/ffmpeg/ffprobe.exe`
  and `FfmpegRunner.probeDuration` already spawns it; only a new `codec_name` probe
  method is needed (NOT `ffmpeg -i` parsing). TASK-120. ✓
- "confirm subtract-clip and normalize-audio already safe / out of scope" →
  subtract-clip forces `-c:a aac` (`subtractClip.ts:68–69`, acrossfade re-encodes);
  normalize-audio uses `-af …,loudnorm` with no `-c:a copy` (`src/main.ts:53–54`).
  Both re-encode audio → safe; TASK-122 documents this. ✓

---

## Documentation Updates

- [ ] Updated: `docs/rotate-video.md` — ffmpeg command table → NVENC; audio section →
      probe-driven copy/aac/none; Known Limitations and QA matrix.
- [ ] Updated: `docs/reencode-x264.md` — ffmpeg command + a new audio-decision section.
- [ ] Updated: `docs/TOOLS.md` — Worked Example 5 (currently says libx264) and the
      encoder/audio rules; note create-clip sibling defect.
- [ ] Updated: `docs/index.md` — line 49 rotate summary (libx264 → NVENC + audio note).
