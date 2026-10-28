# Recognize .MKV and .TS video containers with container-aware playability verdicts

Tier: 2
Type: feature

## Stated Requirements

- "How can we extend the same functionality to .mkv and .ts files?"

## Assumptions

- Assumed: both `.mkv` and `.ts` become recognized video containers riding the exact existing lane (ingest → background probe → codec facts → badge → banner → Create playable copy).
- Assumed: playability gains a CONTAINER rule — `.ts` (ffprobe format_name `mpegts`) is never playable in-app (Chromium ships no MPEG-TS demuxer), `.mkv` (`matroska,webm`) stays codec-derived — but the container/codec rule applies only when a video stream was actually probed; `.ts` files that are really source code probe to error/no-stream and stay badge-free (peer + architecture review consensus: extension is never a playability key; the container is a stored ffprobe fact, not the filename).
- Assumed: a fourth nullable fact column `formatName` (ffprobe format format_name) is stored with the codecs (migration v3); the pure derivation reads stored facts only, so the sidecar still renders badges without probing.
- Assumed: `.ts` tiles render the existing placeholder — Chromium cannot paint MPEG-TS frames; frame-extraction thumbnailing is out of scope.
- Assumed: `.mov` behavior is carried byte-identically; the in-flight `support-mov-playback` change is not reopened and this delta lands after it.

## Blast Radius
1. src/api/file.ts:46 — IMG_EXTENSIONS gates watcher, ingest, Settings picker, AdvancedSearch and DnD; 'mkv' and 'ts' must join 'mp4'/'webm'/'ogg'/'mov' or these files never enter the library.
2. src/api/file.ts:76 — MOV_CODEC_VERSION (codec-table version) and the FileDTO at :25 gain a nullable formatName fact (ffprobe format format_name).
3. common/fs.ts:91 — isFileExtensionVideo is the single authoritative video predicate (gallery hover, mediaTypeMatches, needsThumbnail, probe-candidate filter); both extensions must be recognized here (discovery only — never a playability test).
4. src/media/FfmpegRunner.ts:398 — probeFirstVideoCodec currently selects stream codec_name only; it must also capture the container format_name (ffprobe -show_entries format=format_name) for the store.
5. src/ipc/videoProbePass.ts:81 — selectProbeCandidates filters on the predicate (unchanged) and :106 runVideoCodecProbePass writes the new formatName fact alongside the codecs.
6. src/backend/sqlite-config.ts:184 — MIGRATIONS gains a v3 ADD COLUMN formatName entry (versioned migration mechanism + PRAGMA user_version, applied via applyMigrations).
7. src/backend/sqlite-backend.ts:30 — FileRow + fileRowToDTO/fileDTOToRow + the FILE_SELECT/FILE_INSERT/FILE_UPSERT column lists carry formatName.
8. src/frontend/image/playability.ts:38 — derivePlayability consults codec strings only; it must add the container rule over the stored formatName, gated on a probed video stream being present (videoCodec non-null), so unprobed/errored/no-stream rows (incl. TypeScript-source .ts) stay unprobed, never unplayable.
9. src/frontend/image/ImageLoader.ts:47 — FormatHandlers is Record<IMG_EXTENSIONS_TYPE, …>; TypeScript forces mkv/ts entries ('web'; .ts → placeholder).
10. common/ExifIO.ts:117 — isVideoFile regex matches only mp4|webm|ogg|mov; mkv|ts must be added for the tag read/write paths.
11. src/frontend/components/ImageTools.tsx:44, src/frontend/containers/ContentView/GalleryItem.tsx:332, src/frontend/containers/ContentView/SlideMode/UnplayableBanner.tsx:49, src/frontend/containers/ContentView/SlideMode/index.tsx:581 — the four derivePlayability call sites pass file.formatName.
12. src/server/routes/images.ts:76 + files route — the sidecar /original and thumbnail MIME map must serve mkv/ts (video/x-matroska, video/mp2t) and web-loadable formats consistently.
13. src/main.ts:43 — reencode-x264 MEDIA_JOB_SPECS entry is reused verbatim as the conversion job (produces .mp4, the correct landing container for both); input is not extension-gated in MediaJobService (verified: no extension check there), so no encoder changes.
14. grepped 'derivePlayability(' across src/ — consumers are exactly the four call sites above plus tests/playability.test.ts, tests/gallery-badge.test.tsx, tests/slide-banner.test.tsx.
