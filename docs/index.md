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
