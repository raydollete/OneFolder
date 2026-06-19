# OneFolder

OneFolder is a desktop app for viewing and organizing your photos locally while respecting open metadata standards. Unlike cloud-based solutions, your pictures remain as ordinary image files in a single folder you control, with organization data stored directly in EXIF/XMP metadata. This ensures your photo collection stays portable, future-proof, and accessible with any modern viewer—today and decades from now.

---

## Project File Structure (top-level)

```
OneFolder/
├── src/
│   ├── frontend/        # React components and UI logic
│   ├── backend/         # Electron main process and file system operations
│   ├── api/            # Data storage, search, and external API interfaces
│   ├── ipc/            # Inter-process communication between main/renderer
│   └── main.ts         # Electron main process entry point
├── common/             # Shared utilities and configuration
├── widgets/            # Reusable UI components
├── resources/          # Static assets (icons, styles, themes)
├── wasm/              # WebAssembly modules for image processing
└── tests/             # Test files and configurations
```

## Tech Stack

- **Desktop Framework**: Electron with TypeScript
- **Frontend**: React with MobX for state management
- **Image Processing**: ExifTool, WebAssembly decoders
- **Database**: IndexedDB via Dexie
- **Build**: Webpack with custom configuration

---

## Documentation Index

| Document                                                        | Description                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| [README.md](README.md)                                          | Documentation guidelines and writing standards                       |
| [Location Loading Process](location-loading.md)                 | Complete workflow from folder selection to indexed files             |
| [Thumbnail Generation System](thumbnail-generation.md)          | Image processing, caching, and format-specific handling              |
| [Metadata Sync Implementation](metadata-sync-implementation.md) | Plan for immediate tag synchronization between app and file metadata |
| [Multi-Library Support](multi-library.md)                       | Multi-library registry, per-library on-disk layout, startup and switch flows |
| [Missing Files](missing-files.md)                               | Detection, per-library hide preference, and recovery via the Outliner badge; also documents the **FileStore fetch-generation invariant** — stale fetcher results are silently dropped (see §Fetch generation invariant). |
| [Video Only Filter](video-only-filter.md)                       | Persistent per-library display filter that restricts the gallery to video files; follows the same post-fetch splice pattern as Missing Files. |
| [Personal Fork Notes](personal-fork-notes.md)                   | Fork-specific deviations: Windows binary renamed to `brave.exe` (for NVIDIA VSR), portable-only; second bundled binary (ffmpeg + GPL caveat) |
| [Re-encode (x264)](reencode-x264.md)                             | Inspector "Re-encode (x264)" tool: ffmpeg command, path resolution, media-job lock model, ingestion-await + tag-copy, delete-original prompt, GPL caveat |
| [Compress & Normalize Audio](normalize-audio.md)                 | Inspector "Compress & Normalize Audio" tool: `acompressor` + `loudnorm` command, `-c:v copy` container-compatibility limitation, shared media-job stack (FfmpegRunner + MediaJobService, IPC, finalize, delete-original prompt) |
| [Create Clip](create-clip.md)                                    | Inspector "Mark Start / Mark End / Create Clip" tools: capture-from-playback, HH:MM:SS validation, `-ss`/`-to`-before-`-i` stream-copy trim, keyframe-snap + progress-percent + webm/ogg container caveats, shared media-job stack |
| [Rotate CW / Rotate CCW](rotate-video.md)                        | Inspector "Rotate CW" / "Rotate CCW" tools: `transpose=1`/`transpose=2` pixel-baked rotation, `-c:v h264_nvenc -preset p7 -tune hq -cq 21` (shared NVENC block), ffprobe-driven copy-vs-AAC audio decision (shared with reencode-x264), non-destructive sibling-file output, shared media-job stack (fifth + sixth consumers) |
| [Creating Inspector Tools](TOOLS.md)                             | How to build a new per-file tool: the media-job layer stack, order of operations, cross-process path/counter pitfalls, and a pre-flight checklist |
