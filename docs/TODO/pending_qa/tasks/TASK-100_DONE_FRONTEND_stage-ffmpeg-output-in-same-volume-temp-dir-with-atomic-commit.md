---
id: TASK-100
title: 'ReEncodeManager: stage ffmpeg output in a hidden SAME-VOLUME temp dir outside the watch, and add a commit() step that atomically renames temp→final. Shared by all three media jobs.'
investigation: INV-026
status: DONE
priority: high
blocked_by: []
date_created: 2026-06-13
date_completed: 2026-06-13
files:
  - 'src/ReEncodeManager.ts'
  - 'common/fs.ts'
---

## What

Change the shared ffmpeg runner so ffmpeg writes its output into a hidden,
same-volume staging directory (`<targetDir>/.onefolder-tmp/`) that lives OUTSIDE
any watched-location ingestion, instead of writing directly into the watched
target folder. Add a `commit(jobId)` method that atomically renames the finished
temp file into its final collision-free sibling path. This is the single shared
output-placement change that all three media jobs (Re-encode x264, Compress &
Normalize Audio, Create Clip) inherit with no per-tool branching.

## Why

ffmpeg currently writes `-y outputPath` directly into the source's WATCHED
folder (`src/ReEncodeManager.ts:123-125`, `:197-210`), so the chokidar watcher
races to ingest the still-being-written, not-yet-tagged file — producing the
intermittent "outside a watched folder" error and untagged imports. Staging in a
temp dir removes the race at its root.

See [INV-026](../investigations/INV-026_HIGH_FRONTEND_media-job-temp-dir-then-move-to-avoid-watcher-race-on-partial-output.md).

## Implementation Steps

- [x] 1. In `common/fs.ts`, add a helper `getMediaJobTempPath(targetDir: string,
      ext: string): { tempDir: string; tempPath: string }` that returns
      `tempDir = path.join(targetDir, '.onefolder-tmp')` and
      `tempPath = path.join(tempDir, \`${randomUUID()}.${ext}\`)`. The dot-prefixed
      dir is on the SAME VOLUME as the target (it is a child of it), so the later
      move is an atomic rename. Do NOT create the dir here (the runner does, via
      `fse.ensureDir`, right before spawn). Export it.

- [x] 2. In `src/ReEncodeManager.ts` `start()` (:116-136): keep computing the
      FINAL path `finalPath = getUniqueSiblingPath(dir, baseName, outputExt)`
      (this reserves the collision-free target name as today). Also compute
      `{ tempDir, tempPath } = getMediaJobTempPath(dir, outputExt)`. Pass BOTH
      `tempPath` and `finalPath` into `_runJob`. Change `StartResult` to
      `{ jobId, tempPath, finalPath }` and return that synchronously.

- [x] 3. In `_runJob` (:181-299): `await fse.ensureDir(tempDir)` before spawn.
      Spawn ffmpeg with `… '-y', tempPath` (NOT finalPath). Register the job with
      `JobEntry` extended to carry `tempPath`, `finalPath`, and
      `phase: 'encoding' | 'encoded' | 'committing' | 'done'` (init 'encoding').

- [x] 4. In `child.on('close')` code===0 (:288-289): do NOT move the file here.
      Set `phase = 'encoded'`, keep the job registered, and call
      `callbacks.onDone({ tempPath, finalPath })`. (The renderer will tag the temp
      file, then call commit.) Update `ReencodeResult` to
      `{ tempPath: string; finalPath: string }`.

- [x] 5. Add `async commit(jobId: string): Promise<{ outputPath: string }>`:
      look up the job; if missing or not in `phase === 'encoded'`, reject.
      Set `phase = 'committing'`. Guard same-volume:
      `if (path.parse(job.tempPath).root.toLowerCase() !==
      path.parse(job.finalPath).root.toLowerCase())` use copy+fsync+unlink
      (document the weaker, non-atomic guarantee); otherwise
      `await fse.move(job.tempPath, job.finalPath, { overwrite: false })`
      (same-volume atomic rename). On success set `phase = 'done'`, delete the job
      from the registry, best-effort `fse.remove(tempDir)` if empty, and resolve
      `{ outputPath: job.finalPath }`. On failure, remove the temp file and reject.

- [x] 6. Verify all three `MEDIA_JOB_SPECS` entries (`src/main.ts:34-60`) still
      flow through `start()` unchanged — `create-clip`'s `preInputArgs` are
      orthogonal to output placement, so no per-tool code is added. Confirmed:
      the only `getUniqueSiblingPath` caller in `src/` is `ReEncodeManager.start`,
      and the only `reEncodeManager.start` caller is `onStartMediaJob` (`src/main.ts`).

## Done When

- [x] ffmpeg writes into `<targetDir>/.onefolder-tmp/<uuid>.<ext>`, never directly
      into the watched target folder, for all three job types.
- [x] `start()` returns `{ jobId, tempPath, finalPath }`; `onDone` reports
      `{ tempPath, finalPath }`; the file is NOT moved until `commit(jobId)` runs.
- [x] `commit(jobId)` performs a same-volume atomic rename to `finalPath` and
      resolves `{ outputPath }`.
- [x] `yarn lint` and `yarn build` pass. (Batch: 118/118 tests pass; lint introduced no new errors — one pre-existing `no-var-requires` in ReEncodeManager.ts was fixed to a top-level import; full `yarn build` deferred to TASK-103 manual QA step.)
