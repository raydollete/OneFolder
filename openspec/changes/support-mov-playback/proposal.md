# Support .MOV media files in the player

Tier: 2
Type: feature

## Stated Requirements

- "How can we support .MOV media files in the player?"
- "so actually we need to move up to C"
- "There's already a re-encode feature which converts to MP4 isn't there?"
- "Button on the unplayable clip"

## Blast Radius

1. src/api/file.ts:37 — IMG_EXTENSIONS gates watcher, ingest, Settings picker, AdvancedSearch and DnD; 'mov' must join 'mp4'/'webm'/'ogg' or .MOV files never enter the library.
2. src/api/file.ts:24 — FileDTO gains a nullable codec verdict field persisted with the file row.
3. common/fs.ts:90 — isFileExtensionVideo is the declared single source of truth for "video" (gallery hover, filter, SlideMode, needsThumbnail); 'mov' must be recognized here.
4. common/fs.ts:101 — mediaTypeMatches reuses that predicate; .mov classification under Video Only/Images Only follows automatically.
5. src/frontend/image/ImageLoader.ts:25 — FormatHandlers is Record<IMG_EXTENSIONS_TYPE, …>; TypeScript forces the mov entry (web).
6. common/ExifIO.ts:117 — isVideoFile regex matches only mp4|webm|ogg; mov must be added for tag read/write paths.
7. src/frontend/stores/LocationStore.ts:963 — pathToIFileWithMetadata is the per-file metadata hook at location load; the codec probe rides this pass, not addFile/ingestFile (INV red lines in .planning/codebase/CONCERNS.md:55-65).
8. src/media/FfmpegRunner.ts:304 — probeFirstAudioCodec is the three-state ffprobe pattern to replicate for the first video stream.
9. src/backend/sqlite-config.ts:168 — versioned migration array applies ALTER TABLE ADD COLUMN in order with PRAGMA user_version; precedent at src/backend/sqlite-config.ts:241.
10. src/frontend/containers/ContentView/SlideMode/index.tsx:403 — probeVideo.onerror currently swallows playback failure into stored dimensions; the unplayable overlay attaches here.
11. src/frontend/containers/ContentView/GalleryItem.tsx:278 — gallery thumbnail branch; the unplayable badge mounts here.
12. src/main.ts:43 — reencode-x264 MEDIA_JOB_SPECS entry is reused verbatim as the conversion job; no encoder changes.
13. src/frontend/components/ImageTools.tsx:38 — existing tools-panel launch site for re-encode; the Create-playable-copy button enqueues the same job type.
14. grepped "isFileExtensionVideo" across src/ — consumers limited to GalleryItem, SlideMode, ImageInfo, ImageTools, ImageLoader; no backend-side consumers to update beyond the DTO column.
