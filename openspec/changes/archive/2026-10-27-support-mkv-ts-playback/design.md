# Design — support-mkv-ts-playback

## Approach

1. `src/api/file.ts:46` IMG_EXTENSIONS += 'mkv','ts' (IMG_EXTENSIONS_TYPE derives automatically); FileDTO gains the nullable `formatName` fact (src/api/file.ts:25).
2. `common/fs.ts:91` isFileExtensionVideo gains both — the single authoritative video predicate; mediaTypeMatches, needsThumbnail, hover-playback and the probe-candidate filter (src/ipc/videoProbePass.ts:81) all follow it unchanged. Discovery only — never a playability test.
3. `src/media/FfmpegRunner.ts:398` probeFirstVideoCodec additionally captures the container identity from the SAME single ffprobe spawn (`-show_entries format=format_name` alongside the stream entries; output switched to `-of json` so the format and stream sections parse unambiguously); VideoProbeResult's `codec` branch gains `formatName: string | null` (`mpegts`, `matroska,webm`, `mov,mp4,m4a,3gp,3g2,mj2`, …). Four-state discipline unchanged; error/no-video stay non-verdicts.
4. Store the container as a fact: MIGRATIONS v3 `ALTER TABLE files ADD COLUMN formatName TEXT` (src/backend/sqlite-config.ts, via applyMigrations + PRAGMA user_version); FileRow/fileRowToDTO/fileDTOToRow/FILE_SELECT/FILE_INSERT/FILE_UPSERT carry it; ClientFile gains the observable, serialize entry and setCodecFacts parameter; the probe pass (src/ipc/videoProbePass.ts:106) stamps it beside the codecs. MOV_CODEC_VERSION stays 1 — no existing row's verdict depends on container facts, so a stamp bump would mass-re-probe healthy rows for nothing (review point rejected, see External Review).
5. `src/frontend/image/playability.ts` — `derivePlayability(videoCodec, audioCodec, formatName?)`: no probed video stream (videoCodec null/empty) → 'unprobed' FIRST, regardless of container — a never-probed, errored, or no-stream file, including a TypeScript source named `.ts`, is never badged; formatName containing 'mpegts' → 'unplayable' (Chromium ships no MPEG-TS demuxer; static capability fact, not a probe verdict); everything else keeps the codec table verbatim (mkv `matroska,webm` with h264 + allowed audio → playable), so `.mov` behavior is carried byte-identically. The derivation reads stored facts ONLY — never the extension; pure module, zero imports; the new parameter is optional so existing callers compile.
6. The four verdict call sites pass `file.formatName`: src/frontend/components/ImageTools.tsx:44, src/frontend/containers/ContentView/GalleryItem.tsx:332, src/frontend/containers/ContentView/SlideMode/UnplayableBanner.tsx:49, src/frontend/containers/ContentView/SlideMode/index.tsx:581.
7. Sidecar: the /original and thumbnail routes serve mkv/ts with correct Content-Type (video/x-matroska, video/mp2t); the web build stays read-only — badges render from persisted facts, no write affordance. `.ts` tiles show the existing placeholder (Chromium cannot paint MPEG-TS frames; no frame-extraction pipeline is added).
8. Docs: the codec table in docs/reencode-x264.md gains the mkv/ts rows (container rule + probe gate), docs/TOOLS.md Example 6 and docs/index.md name the extended lane.

## UX / Requirements

### Pattern

- Task: "I have downloaded or camcorder/phone-exported videos in .mkv or .ts; I want to watch them in OneFolder, and when one can't play I want the same one obvious way to make it playable that .mov files have."
Archetype: detail-view
Anchor: Atlassian design system — status lozenges label item state on cards/tiles without blocking interaction; recovery affordances live inline next to the failed content, not in a modal — what it prescribes for this surface (identical to the mov lane's accepted pattern)
Rejected pattern: per-container bespoke UI (e.g. a separate "container not supported" badge) — rejected because the vocabulary is already one label, `Not playable`, for every reason a clip will not play in this app; splitting it forces users to learn why Chromium fails.

### Controls & States

- "Not playable" lozenge (gallery tile) — governs: visibility of unplayable clips before opening
  ON:  (derived verdict = unplayable — a probed file whose container fact is `mpegts`, or whose codecs are outside the Chromium-decodable table incl. `.mkv` with HEVC) amber lozenge with tooltip stating the reason (codec name, or `MPEG-TS` for the container case); hover-playback and selection otherwise unchanged
  OFF: (playable / unprobed / error / no probed video stream — incl. every not-yet-probed `.ts` and TypeScript-source `.ts`) no lozenge; tile renders exactly as today
- Remediation affordance: the pre-existing inspector Tools **`Re-encode (x264)`** button — governs: enqueueing the re-encode job (owner decision 2026-10-27, recorded on tasks 1.6/1.9: the separate `Create playable copy` button was removed as a duplicate of it; the banner is text-only and names this tool). The Tools section is identical for playable and unplayable clips — surfaces are verdict-gated, no button is.
  ON:  (verdict = unplayable, desktop build) inline text-only banner with explanation pointing at `Re-encode (x264)` in the Tools panel; using that tool enqueues reencode-x264 (same job, produces the .mp4 sibling), drawer progress with cancel, output auto-opens, Keep prompt unchanged
  OFF: (playable, or web build) no banner; the web sidecar has no write affordance — sidecar is read-only

### Display strings

- Gallery lozenge: `Not playable` (codec-driven tooltip names the codec and points at the Tools panel's `Re-encode (x264)` — retargeted from the mov lane's 'create a playable copy from the player' wording by the owner decision 2026-10-27: `<CODEC> is not decodable in this app — use "Re-encode (x264)" in the Tools panel`; container-driven `.ts` tooltip states the reason only, per UI review: `MPEG-TS is not demuxable in this app`)
- SlideMode banner title: `<Reason> — not playable here` where Reason is the probed codec (HEVC, ProRes, …) or `MPEG-TS` for `.ts`
- Remedy label (banner body text and the Tools button, matching wording): `Re-encode (x264)` — the banner itself carries no button (owner decision 2026-10-27)
- Web build (verdict unplayable, no action): `Not playable in this browser`

### Information Hierarchy

Gallery tile
|- thumbnail (`<video>` preview; placeholder for `.ts`)
\- Not playable lozenge
SlideMode video area
|- video element
\- inline banner (when unplayable)
   \- codec/container explanation line
Inspector Tools section (shown for every recognized video file, not verdict-gated)
\- Re-encode (x264) button (the sole remediation affordance; owner decision 2026-10-27)

### Conventions consulted

- none — no openspec/conventions.md exists in this repo; the binding precedent is the mov lane itself (docs/reencode-x264.md §MOV files) whose vocabulary, lozenge and button this change reuses unchanged.

### Explicit Rejections

- Second badge vocabulary for container failures — rejected because `Not playable` already covers every reason a clip will not play here; the tooltip carries the why.
- ffprobe-gated INGESTION for `.ts` (refusing to create rows until a video stream is confirmed) — rejected: it needs a probe on the ingest path, which the watcher red lines forbid (.planning/codebase/CONCERNS.md:55-65); the review's requirement is met on the read side instead — the badge requires a probed video-stream fact, so unprobed/no-stream `.ts` rows are indistinguishable from today's unprobed files.
- Frame-extraction thumbnails for `.ts` — rejected as scope: needs a thumbnail-generation pipeline the mov lane deliberately does not have; placeholder is the carried behavior for undecodable media.
- Remux `.ts`/`.mkv` to `.mp4` on Create playable copy — rejected: reencode-x264 already lands `.mp4` and re-encodes video, which is the only thing that changes Chromium's playability; remux would still fail for HEVC.

## Architecture / Requirements

### Reference architecture

Archetype: capability-gated media pipeline (probe → store facts → derive verdict at read → transcode on demand), the exact form the mov lane established
Anchor: the mov lane's own implementation (src/ipc/videoProbePass.ts, src/frontend/image/playability.ts) plus the repo's ffprobe three-state discipline (src/media/FfmpegRunner.ts) — prescribes: new containers enter ONLY through IMG_EXTENSIONS/isFileExtensionVideo; codec facts are stored, never verdicts; a capability Chromium lacks at the container level is a static fact encoded in the derivation, not a probe result.
Invariants: (1) one authoritative video-extension predicate for DISCOVERY only; playability NEVER reads the extension (restored — the draft's extension-key deviation was rejected by architecture review); (2) playability is a pure derivation from stored facts — codec names + formatName — never a stored verdict column — maps to tests/playability.test.ts; (3) probe error/unprobed/no-probed-video-stream never renders unplayable and is never badged, incl. every not-yet-probed `.ts` and TypeScript-source `.ts` — maps to playability table + gallery-badge tests; (4) web build performs no writes — unchanged platform seam; (5) conversion stays the single reencode-x264 NVENC-only job failing loudly (INV-032).
Rejected approach: sniffing container demuxability at runtime (trial-load the `<video>` and badge on error) — rejected because it replays the swallowed probeVideo.onerror defect the mov change removed (architecture review concurred); keying the container rule on the file extension — rejected by review: extension is a weak key, the container is a stored ffprobe fact.
Deviations: the single probe spawn gains one ffprobe section (format format_name) + JSON output parsing — one extra field from the same process, no extra spawn; justified by the peer+architecture review consensus that container capability must be a stored fact.

## External Review

### Peer Review Verdict

Quorum: achieved (weight 3/3, escalated to tier 1)
Certainty: 0.75
Caller Agreement: 0.3
Arbiter: ok
Sources:
- anthropic-claude-haiku-5-5 (claude-haiku-5-5) — ok, agreement 0.85
- local-ai-qllm (qLLM) — ok, agreement 0.7
- google-gemini-rpa-models-gemini-flash-lite-latest (models/gemini-flash-lite-latest) — ok, agreement 0.7

### Review Feedback

Consensus feedback recorded verbatim:
- "Admit .mkv as a normal video." — ACCEPTED: mkv enters the same lane, codec-derived.
- "Gate .ts so TypeScript sources are never ingested as media: require a probe-reported video stream, optionally with a 0x47 sync-byte pre-check." — ACCEPTED on the read side: the badge/banner require a probed video-stream fact (videoCodec stored); ingest-time probing is forbidden by the watcher red lines, so recognition stays extension-based and no-stream/errored `.ts` rows stay badge-free.
- "Have the probe store container format_name alongside codecs" — ACCEPTED: formatName column (migration v3) captured from the same single ffprobe spawn.
- "and bump the probe stamp so existing rows re-derive." — REJECTED: no existing row's verdict depends on container facts (only mp4/webm/ogg/mov exist), so a stamp bump would force a mass re-probe of healthy rows for zero verdict change; MOV_CODEC_VERSION bumps stay reserved for real codec-table changes.
- "Keep playability a pure render-time derivation over stored facts … with no stored playable boolean." — ACCEPTED: derivation reads codec names + formatName at render time; no verdict column.
- "Treat .ts as unplayable by container, with copy that says container, never codec." — ACCEPTED: Reason token `MPEG-TS`; tooltips/banner never name a codec for the container case.
- "Probe error, unprobed, or null container must never render as unplayable. Non-video .ts files stay ignored." — ACCEPTED: unprobed/error/no-video-stream gate returns unprobed before any container/codec rule.
- "Update the reencode-x264 input allowlist, thumbnail extraction (degrade to placeholder, no error state), and the MIME mapping for mkv/ts." — ACCEPTED: MediaJobService has no input-extension gate (verified by reading — no-op), `.ts` thumbnails degrade to the existing placeholder, and the sidecar MIME routes gain mkv/ts types.
- "The web sidecar stays read-only with no 'Create playable copy' action." — ACCEPTED: already the platform-seam contract; carried unchanged.

## UI Review

### UI Review Verdict

Quorum: achieved (weight 2/2, escalated to tier 1)
Certainty: 0.725
Caller Agreement: n/a
Arbiter: ok
Sources:
- anthropic-claude-haiku-5-5 (claude-haiku-5-5) — ok, agreement n/a (null returned)
- local-ai-qllm (qLLM) — ok, agreement 0.75
- google-gemini-rpa-models-gemini-flash-lite-latest (models/gemini-flash-lite-latest) — ok, agreement 0.7

### UI Review Feedback

Consensus feedback recorded verbatim:
- "No stated requirement is violated: the .mkv and .ts lanes extend the .mov lozenge, inline banner, and action chain, and the .ts differences are justified by the technical constraints. The lozenge → banner → action → read-only web pattern is the right graceful-degradation approach, and the single 'Create playable copy' label works because the banner scopes it to 'here'." — ACCEPTED: pattern carried unchanged.
- "the .ts tooltip mixes an explanation with an imperative call-to-action, so it should state only the reason and leave remediation to the banner and button." — ACCEPTED: the container-driven `.ts` tooltip is reason-only (`MPEG-TS is not demuxable in this app`); the mov lane's codec tooltip is carried verbatim (already tested and under operator QA in the sibling change).
Violated requirement: none — the reviewer found none: "No stated requirement is violated".

## Architecture Review

### Architecture Review Verdict

Quorum: achieved (weight 2/2, escalated to tier 1)
Certainty: 0.775
Caller Agreement: n/a
Arbiter: ok
Sources:
- anthropic-claude-haiku-5-5 (claude-haiku-5-5) — ok, agreement 0.75
- local-ai-qllm (qLLM) — ok, agreement 0.15
- google-gemini-rpa-models-gemini-flash-lite-latest (models/gemini-flash-lite-latest) — ok, agreement 0.8

### Architecture Review Feedback

Consensus feedback recorded verbatim:
- "The design violates the stated invariant that probe-error and unprobed rows never render unplayable: a static .ts rule keyed on extension fires before any probe runs, and the TypeScript-source case fails the same way. The fix is to return unknown unless the probe state is ok and a video stream is present, then apply the container or codec rule." — ACCEPTED: the derivation returns unprobed unless a probed video-stream fact exists, then applies the container/codec rules; the draft's extension key was removed.
- "The standard probe, store, derive-at-read, transcode-on-demand form is right, and runtime trial-loading of the <video> element should be rejected." — ACCEPTED: form carried; trial-loading stays rejected.
- "Extension is a weak key for container capability, so storing ffprobe format_name with a probe stamp bump is preferable to keying on the filename." — ACCEPTED for formatName-as-stored-fact; the stamp-bump half REJECTED (no existing row's verdict depends on container facts; a bump mass-re-probes healthy rows for zero change).
Violated requirement: none — the violated invariant the reviewer found (unprobed-never-unplayable) was removed from the design by the accepted fix above.
