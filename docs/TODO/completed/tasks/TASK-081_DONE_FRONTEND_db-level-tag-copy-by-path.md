---
id: TASK-081
title: 'Add FileStore.copyTagsToOutputPath — copy a source ClientFile''s tags onto a freshly-encoded output resolved at the DB level by absolute path, independent of the view-dependent fileList'
investigation: INV-019
status: DONE
priority: high
blocked_by: []
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/frontend/stores/FileStore.ts'
  - 'src/api/data-storage.ts'
---

## What

Add a new `FileStore.copyTagsToOutputPath(source: ClientFile, outputPath:
string)` method that copies the source's tags onto the freshly-encoded output
**without requiring the output to be present in the view-dependent `fileList`**.
It resolves the output's FileDTO directly from the backend by absolute path,
sets the source's tag ids on the DTO, saves it, and writes the EXIF/XMP metadata
exactly once. This is the DB-level half of the corrected post-encode flow.

## Why

`fileStore.fileList` is a projection of the active search/filter, not a
repository index. The current `copyTagsToFile(source, target)` requires a
`ClientFile` target pulled from `fileList`, but a tag-less encode output under a
tag filter never enters `fileList` — a chicken-and-egg that makes the whole
post-encode flow time out. Copying tags at the DB level breaks the cycle:
once the output is tagged, it can legitimately match the active filter.

See [INV-019](../investigations/INV-019_HIGH_FRONTEND_post-encode-tag-copy-race-filtered-view.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/FileStore.ts`, add `async
      copyTagsToOutputPath(source: ClientFile, outputPath: string):
      Promise<boolean>`. Return `true` if the DB row was found and tagged,
      `false` if the row never appeared (output likely outside a watched
      location). Place it next to `copyTagsToFile` (~:1273).
- [x] 2. Normalize the path for the DB lookup. The DB stores forward-slash,
      Windows-case-insensitive paths (folderWatcher.worker.ts normalizes the
      watch root to `/`; `getUniqueSiblingPath` in `common/fs.ts:78-92` returns
      win32 backslashes via `path.join`). Reuse the same normalization
      `waitForIngestedFile` uses (`p.replace(/\\/g, '/').toLowerCase()`,
      FileStore.ts:1220). NOTE: `fetchFilesByKey` does an exact-match DB query,
      so you must query with the path **form the DB actually stored**. The DB
      stored `stats.absolutePath` from the watcher (forward-slash, original
      case). Query with the forward-slash form of `outputPath`
      (`outputPath.replace(/\\/g, '/')`); if that returns nothing, also try the
      raw `outputPath` as a fallback, and compare case-insensitively in JS over a
      small candidate set if needed. Document the chosen approach in a comment.
- [x] 3. Resolve the FileDTO with a bounded poll (ingestion via the watcher
      worker round-trip can lag ffmpeg completion): loop up to ~3 s (e.g. 15 x
      200 ms) calling `await this.backend.fetchFilesByKey('absolutePath',
      candidate)` until a row is returned. If none after the budget, return
      `false` (do NOT throw).
- [x] 4. Build the tag id set from the source: `const tagIds =
      Array.from(source.tags, (t) => t.id);`. Set them on the DTO (`dto.tags =
      tagIds;` — match the FileDTO `tags` field shape) and persist via
      `await this.backend.saveFiles([dto])`. Do NOT mutate `numUntaggedFiles`
      or any derived counter here (docs/TOOLS.md rule 2 — the later refetch
      reconciles the view).
- [x] 5. Write the EXIF/XMP metadata exactly once. Build the hierarchy
      `const hierarchy = Array.from(source.tags, (t) => t.path);`. If
      `hierarchy.length === 0`, skip the write entirely (zero-tag source).
      Otherwise `await this.rootStore.exifTool.writeTags(outputPath, hierarchy)`
      (use the win32 `outputPath` for the filesystem write — ExifTool takes the
      real OS path). Verify the exifTool handle/path on `rootStore` matches how
      `copyTagsToFile`/the import flow call it (see FileStore.ts:251
      `this.rootStore.exifTool.readTags`).
- [x] 6. Add a concise doc comment explaining: this is the DB-level tag copy used
      by the corrected post-encode flow (INV-019); it does NOT require the file
      in `fileList`; it writes EXIF/XMP exactly once and must not be paired with
      another metadata write for the same file (no double-write).
- [x] 7. Confirm `fetchFilesByKey('absolutePath', value)` is a valid call:
      `src/api/data-storage.ts:28` declares `fetchFilesByKey(key: keyof FileDTO,
      value: IndexableValue)`; `absolutePath` is a `keyof FileDTO`. Verify the
      Dexie/SQLite backend has an index on `absolutePath` (it is used elsewhere,
      e.g. LocationStore.ts:556); if not indexed, note it but proceed (small
      table scan acceptable for a single lookup). CONFIRMED: `absolutePath` has
      a dedicated index `idx_files_absolutePath` in SQLite (sqlite-config.ts:96)
      and `&absolutePath` unique index in Dexie (backend/config.ts:29).

## Done When

- [x] `FileStore.copyTagsToOutputPath(source, outputPath)` exists, compiles
      under strict mode, and returns a boolean.
- [x] It resolves the output FileDTO via the backend by normalized absolute
      path (with bounded poll), sets the source's tag ids, saves, and writes
      EXIF/XMP exactly once (skipped for zero-tag sources).
- [x] It never reads from or depends on `fileList`, and never throws on a
      missing row (returns `false`).
- [x] No direct mutation of `numUntaggedFiles` / derived counters.
