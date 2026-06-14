---
id: TASK-102
title: 'Shared finalize: tag the staged TEMP file (EXIF/XMP) before it is visible, commit (atomic rename) into the target, then ingest the deterministically-known final path. Removes the watcher race for all three tools.'
investigation: INV-026
status: planned
priority: high
blocked_by: [TASK-100, TASK-101]
date_created: 2026-06-13
date_completed:
files:
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/components/ImageTools.tsx'
  - 'docs/TOOLS.md'
  - 'docs/reencode-x264.md'
  - 'docs/normalize-audio.md'
  - 'docs/create-clip.md'
---

## What

Rework the shared post-encode finalize so it (a) writes the source's tags to the
COMPLETE temp file via the renderer exiftool — on a deterministic path, with no
DB row and no watcher involved, so tagging cannot race ingestion; (b) commits the
atomic temp→final rename; (c) ingests the deterministically-known final path,
copies tags at the DB level onto the now-present row, selects/opens it, and swaps
the pinned viewer. The long DB-poll-for-the-watcher-row in `copyTagsToOutputPath`
collapses to a short, expected wait on a known-complete file. Shared by all three
tools.

## Why

Today `finalizeEncodedOutput` → `copyTagsToOutputPath` depends on the watcher
ingesting the in-place output, then polls the DB for that row and tags it AFTER
the fact (`FileStore.ts:1432-1490`). That race is the bug. With TASK-100/101 the
file is finished in a temp dir before anyone tags it; tag it there, then move it
in atomically so the watcher's only observation is a complete, tagged file.

See [INV-026](../investigations/INV-026_HIGH_FRONTEND_media-job-temp-dir-then-move-to-avoid-watcher-race-on-partial-output.md).

## Implementation Steps

- [ ] 1. In `src/frontend/stores/FileStore.ts`, add
      `async tagTempFile(source: ClientFile, tempPath: string): Promise<void>`:
      build `hierarchy = Array.from(source.tags, t => t.path)`; if empty, return
      (skip the write for a zero-tag source). Otherwise write EXACTLY once:
      `await this.rootStore.exifTool.writeTags(tempPath, hierarchy)`. No DB work
      here (the row does not exist yet — the file is still in temp).

- [ ] 2. Change `finalizeEncodedOutput` (:1531-1594) signature to
      `finalizeEncodedOutput(source: ClientFile, paths: { jobId: string; tempPath: string; finalPath: string }): Promise<ClientFile | null>`.
      New body:
      (a) `await this.tagTempFile(source, paths.tempPath)` — tag while in temp;
      (b) `const { outputPath } = await RendererMessenger.commitMediaJob(paths.jobId)`
      — atomic rename temp→final (the watcher now sees a complete, tagged file);
      (c) `await this.refetch()` then resolve the output ClientFile for `outputPath`
      (the FINAL path) — reuse the existing index/refetch/inject logic at
      :1559-1593, but the row now reliably appears because the file is complete;
      keep the DB-level tag copy via `copyTagsToOutputPath(source, outputPath)` so
      the DB row carries the tags too (idempotent with the EXIF write — it sets the
      same tag ids and, since the EXIF was already written in temp, gate its
      `exifTool.writeTags` so it does NOT double-write: see step 3).

- [ ] 3. Prevent a double EXIF write: `copyTagsToOutputPath` (:1415-1493) currently
      writes EXIF/XMP at :1486-1489. Since `tagTempFile` already wrote the EXIF to
      the same bytes (pre-rename), add a parameter
      `copyTagsToOutputPath(source, outputPath, { skipExifWrite = false })` and pass
      `skipExifWrite: true` from the new finalize flow — the DB tag-set is still
      written (:1476-1478), but the redundant `exifTool.writeTags` (:1486-1489) is
      skipped. Keep `copyTagsToOutputPath`'s existing callers (if any) on the
      default behavior. Document that exactly one EXIF write happens (in temp).

- [ ] 4. Keep the null path honest: if `commitMediaJob` rejects or the final row
      never appears, show an honest toast (NOT "outside a watched folder" as a sole
      fact — docs/TOOLS.md rule 4), keep the source pinned, return null. Note that
      a commit failure means the temp file may remain — TASK-103 sweeps it.

- [ ] 5. In `src/frontend/components/ImageTools.tsx runMediaJob` (:67-177): the
      `await RendererMessenger.startMediaJob(...)` (:97-101) now yields
      `{ jobId, tempPath, finalPath }`. Capture all three and pass them (plus the
      `jobId`, which is also in `jobIdRef.current`) into
      `fileStore.finalizeEncodedOutput(file, { jobId, tempPath, finalPath })`
      (:118). Leave the pin swap (:127), create-clip field reset (:131-134), and
      `openDeleteOriginalPrompt` (:138) unchanged — they run only when
      `outputFile !== null`.

- [ ] 6. Update docs: `docs/TOOLS.md` "correct order of operations" (stage in a
      same-volume temp dir → tag temp → atomic rename → ingest the known final
      path; the watcher never sees partial/untagged output), and add a one-line
      "shared temp-dir-then-move staging" note to `docs/reencode-x264.md`,
      `docs/normalize-audio.md`, and `docs/create-clip.md`.

## Done When

- [ ] The source's tags are written to the temp file (EXIF/XMP) BEFORE the file is
      moved into the watched folder; exactly one EXIF write occurs per output.
- [ ] After commit, the output is ingested from the known final path, carries tags
      at the DB level, auto-opens, swaps the pin, and prompts to delete the
      original — identically for Re-encode, Compress & Normalize Audio, and Create
      Clip.
- [ ] No "outside a watched folder" toast occurs on the happy path; the null/edge
      path shows an honest message and keeps the source on screen.
- [ ] `yarn lint`, `yarn build`, and `yarn test` pass.
