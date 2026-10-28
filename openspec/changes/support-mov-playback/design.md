# Design — support-mov-playback

## Approach

Two lists, one background probe, codec facts in the DB, one button — all encoding machinery is reused as-is.

1. **Ingest**: add `'mov'` to `IMG_EXTENSIONS` (src/api/file.ts:37) and to `isFileExtensionVideo` (common/fs.ts:90); add `mov: 'web'` to `FormatHandlers` (src/frontend/image/ImageLoader.ts:25) and `mov` to the `isVideoFile` regex (common/ExifIO.ts:117). Gallery hover, media-type filter, SlideMode playback/preload/freeze-recovery, and `needsThumbnail` (no thumbnail; `<video>` renders the file directly) follow automatically — the propagation is the declared contract of the single source of truth (common/fs.ts:98-100).
2. **Triage**: new `FfmpegRunner.probeFirstVideoCodec` modeled on `probeFirstAudioCodec` (src/media/FfmpegRunner.ts:304): ffprobe first-stream `codec_name` for video and audio, four-state result `codec | no-video | error | unprobed`. Runs on a **low-priority background pass** after location load, never synchronously on the load path: for recognized-video files the persisted verdict is refreshed only when the cache key (path + size + mtime) changed, and ffprobe being missing or failing yields `error`/`unprobed` — which NEVER renders as unplayable (fail-loud, logged; the native `<video>` gets its chance). Extension recognition is a file-discovery trigger, not a playability test; playability is a separate derivation from stored codec facts.
3. **Persistence**: store codec FACTS, not a verdict — nullable `videoCodec`/`audioCodec` columns (ffprobe names) stamped with a `MOV_CODEC_VERSION` constant, via the existing versioned migration array + `PRAGMA user_version` (src/backend/sqlite-config.ts:168, ADD COLUMN precedent :241). Mirrored on `FileDTO` (src/api/file.ts:24), `ClientFile`, and the http-backend DTO mapping so the read-only sidecar gallery renders from the DB (the web build cannot probe locally). Playability = table lookup `codec ∈ {h264} × audio ∈ {aac, mp3, opus, vorbis, none}` evaluated at render time against the current `MOV_CODEC_VERSION`, so a future codec-table change re-derives without re-probing.
4. **Surfaces**: gallery tile badge (`Not playable` lozenge, tooltip = codec explanation) when the derived verdict is unplayable (mount point src/frontend/containers/ContentView/GalleryItem.tsx:278). SlideMode: an inline banner (not a blocking full-frame overlay) over the letterboxed video area carries the codec explanation; the action button "Create playable copy" — the operator's button on the unplayable clip — sits in the banner AND in the inspector Tools section whenever an unplayable file is selected (the gallery's path to action), enqueuing the EXISTING `reencode-x264` job (src/main.ts:43): temp staging, `-c:a aac` via `decideAudioArgs`, tag copy to DB + XMP, auto-open of the output, Keep/Delete-original prompt, media-queue drawer progress and cancellation — all inherited, zero new encode code. Web build: explanation only, never a write affordance (sidecar is read-only).
5. **No auto-conversion.** The original `.MOV` is never modified or deleted by this feature; conversion is the pre-existing opt-in job, and the Keep/Delete-original prompt is the storage-growth control.

## UX / Requirements

### Pattern

- Task: "I shot video on my iPhone; I want to watch it in OneFolder, and when it can't play I want one obvious way to make it playable."
Archetype: detail-view
Anchor: Atlassian design system — status lozenges label item state on cards/tiles without blocking interaction; recovery affordances live inline next to the failed content, not in a modal — what it prescribes for this surface
Rejected pattern: modal dialog on open — rejected because it interrupts browsing every unplayable clip and hides the state from the gallery where triage happens

### Controls & States

- "Not playable" lozenge (gallery tile) — governs: visibility of unplayable clips before opening
  ON:  (derived verdict = unplayable) amber lozenge over the thumbnail corner with tooltip explaining the codec; hover-playback and selection otherwise unchanged
  OFF: (playable / unprobed / error) no lozenge; tile renders exactly as mp4/webm/ogg do today
- "Create playable copy" button (SlideMode banner + inspector Tools section) — governs: enqueueing the re-encode job
  ON:  (verdict = unplayable, desktop build) inline banner with codec explanation + button; click enqueues reencode-x264, drawer shows progress with cancel, output auto-opens
  OFF: (playable, or web build) no banner, no button — sidecar is read-only and NEVER offers a write affordance it cannot perform

### Display strings

- Gallery lozenge: `Not playable` (tooltip: `HEVC is not decodable in this app — create a playable copy from the player`)
- SlideMode banner title: `HEVC — not playable here` (codec name from the probe: HEVC, ProRes, PCM audio, …)
- Action button (banner and Tools section, identical label): `Create playable copy`
- Web build (verdict unplayable, no action): `Not playable in this browser`

### Information Hierarchy

Gallery tile
|- thumbnail (`<video>` preview)
\- Not playable lozenge
SlideMode video area
|- video element
\- inline banner (when unplayable)
   \- codec explanation line
Inspector Tools section (when unplayable file selected)
\- Create playable copy button

### Conventions consulted

- none — no openspec/conventions.md exists in this repo; nearest precedents are the in-app media-queue drawer (job affordance, progress + cancel) and the widgets Tag/lozenge styling, both reused as-is.

### Explicit Rejections

- Auto-convert at ingest — rejected because it silently spends disk and encode time on clips the user may never watch; operator chose the button on the unplayable clip.
- ExifTool CodecID as probe — rejected because fragmented MOVs (the modern iPhone default) are ExifTool's documented weak spot; ffprobe reliability wins for a background pass.
- Remux HEVC into MP4 — rejected because Chromium still cannot decode HEVC; only re-encode changes playability.
- Native HEVC decoding (custom Chromium build / WASM decoder) — rejected because it forks the Electron binary; operator's C is the convert-to-playable route.

## Architecture / Requirements

### Reference architecture

Archetype: media transcode pipeline (probe → decide → encode → place → ingest) with capability gating at the read path
Anchor: ffmpeg/ffprobe three-state probe discipline already established in this repo (src/media/FfmpegRunner.ts:292-348) and its INV-032 fail-loud rule — prescribes probe-before-act, no silent fallback, loud Failed rows on unavailable encoders
Invariants: (1) one authoritative video-extension PREDICATE (common/fs.ts:90) for file discovery — new formats enter exactly there; playability is a separate derivation from stored codec facts, never from the extension; (2) probe `error`/`unprobed` never renders as unplayable and never folds into a silent fallback — mirrors the copy-vs-AAC branch tests in tests/media-job.test.ts; (3) outputs are always new sibling files, watcher-injected, never in-place — inherited from `reencode-x264` (INV-018); (4) web build performs no writes — seam contract (CLAUDE.md Platform Seam); (5) the probe cache key is path+size+mtime and the verdict is stamped with MOV_CODEC_VERSION — external edits or encoder/codec-table changes invalidate cleanly. Each maps to a test in tasks.md.
Rejected approach: server-side transcode in the sidecar — rejected because the sidecar is read-only by spec (INV-034 out-of-scope list: no FFmpeg/NVENC media jobs) and would widen the access model.
Deviations: probe runs off the load path on a background queue rather than inline at location load — justified by large/network library latency (peer review); conversion stays NVENC-only failing loudly — justified by INV-032 Directive 1 (a software path for one job recreates the drift that investigation filed).

## External Review

### Peer Review Verdict

Quorum: achieved (weight 2/2, escalated to tier 1)
Certainty: 0.825
Caller Agreement: 0.7
Arbiter: ok
Sources:
- anthropic-claude-haiku-5-5 (claude-haiku-5-5) — ok, agreement 0.85
- local-ai-qllm (qLLM) — ok, agreement 0.8
- google-gemini-rpa-models-gemini-flash-lite-latest (models/gemini-flash-lite-latest) — ok, agreement 0.4

### Review Feedback

Consensus feedback recorded verbatim:
- "Do not probe every clip synchronously at location load. Probe lazily or in a low-priority background queue, and cache the verdict keyed by path, size, and mtime with invalidation on change." — ACCEPTED: background pass, cache key path+size+mtime, refreshed only on change; never synchronous on the location-load path.
- "Keep a tri-state result (not probed, playable, unplayable, plus error) and badge only unplayable clips, so probe failures never show as unplayable." — ACCEPTED: four-state probe result; badge renders only on derived `unplayable`; error/unprobed logs loudly and stays badge-free.
- "Playability should also check the audio codec, not just H.264 video." — ACCEPTED: audio codec probed and part of the derivation (PCM/Vorbis-in-MOV etc.).
- "Commonly missed sites: the read-only web sidecar (extension list and schema), file-watcher and import paths that use the video predicate, thumbnail generation, export and share handlers, MIME/custom-protocol types, sibling naming (.mov vs .mp4 with tag copy and Keep/Delete), and migration rollback." — ACCEPTED: tasks cover sidecar DTO/schema parity, watcher/DnD paths through the two lists, needsThumbnail, and migration tests; no export/share/MIME surface exists in this repo (grepped, see tasks).
- "Top risks: location-load latency on large or network libraries, stale badges after external edits or re-encodes, ffprobe missing being misread as unplayable, NVENC fallback on non-NVIDIA machines, and storage growth from duplicate .mp4 siblings." — ACCEPTED: background probing, mtime cache key, error≠unplayable, and the inherited Keep/Delete-original prompt address all five; NVENC stays contract-bound.
- "the codec is stored as facts rather than a hardcoded verdict" — ACCEPTED: store codec names + MOV_CODEC_VERSION; playability derived at render time.
- NVENC-only conversion fails on non-NVIDIA machines (proposed software fallback) — REJECTED: contract preserved — every video-encoding job in this fork already fails loudly without NVENC (INV-032 Directive 1); a software path for exactly one job recreates the drift that investigation was filed to fix.

## UI Review

### UI Review Verdict

Quorum: achieved (weight 2/2, escalated to tier 1)
Certainty: 0.8
Caller Agreement: n/a
Arbiter: ok
Sources:
- anthropic-claude-haiku-5-5 (claude-haiku-5-5) — ok, agreement 0.3
- local-ai-qllm (qLLM) — ok, agreement 0.9
- google-gemini-rpa-models-gemini-flash-lite-latest (models/gemini-flash-lite-latest) — ok, agreement 0.7

### UI Review Feedback

Consensus feedback recorded verbatim:
- "The proposed design violates the requirement \"Button on the unplayable clip\": the only action (\"Create playable copy\") sits in the SlideMode overlay, while the gallery tile shows only a passive \"Not playable\" lozenge." — ACCEPTED: action also surfaced in the inspector Tools section whenever an unplayable file is selected (including from the gallery), keeping the operator's button on the opened clip plus a gallery path to action.
- "the recovery affordance should be an inline notice or banner next to the player rather than a full overlay replacing the video" — ACCEPTED: inline banner over the letterboxed area; the video element stays mounted and the banner never captures input outside its bounds.
- "Naming should stay consistent across surfaces (\"Not playable\", \"HEVC — not playable here\", \"Create playable copy\")." — ACCEPTED: one vocabulary in Display strings; identical button label in banner and Tools section.
Violated requirement: none — the button-on-the-clip requirement is kept (banner button) and the review's gallery-path-to-action gap is closed by the Tools-section button.

## Architecture Review

### Architecture Review Verdict

Quorum: achieved (weight 2/2, escalated to tier 1)
Certainty: 0.75
Caller Agreement: n/a
Arbiter: ok
Sources:
- anthropic-claude-haiku-5-5 (claude-haiku-5-5) — cancelled (quorum met before response), agreement n/a
- local-ai-qllm (qLLM) — ok, agreement 0.8
- google-gemini-rpa-models-gemini-flash-lite-latest (models/gemini-flash-lite-latest) — ok, agreement 0.7

### Architecture Review Feedback

Consensus feedback recorded verbatim:
- "\"Deviations: none\" is inaccurate because the design has unacknowledged gaps, notably the NVENC-only conversion constraint and the missing playback-capability check." — ACCEPTED: Deviations line now names the background-probe placement and the NVENC-only contract; the capability check is the codec-facts derivation, recorded as invariant (1).
- "Invariant (1), the single extension predicate, is valid as a file-discovery trigger but is not a playability test." — ACCEPTED: invariants rewritten — predicate gates discovery; playability derives from stored codec facts, never from extension.
- "no path for native .MOV playback" against "so actually we need to move up to C" — REJECTED as requirement violation: C was operator-selected as the convert-to-playable route ("Button on the unplayable clip"); native HEVC decode in Electron would require a custom Chromium build or WASM decoder, which the Explicit Rejections record.
Violated requirement: none — "so actually we need to move up to C" — C defined in this conversation as convert-to-playable via the existing re-encode job; conversion is the delivered path.
