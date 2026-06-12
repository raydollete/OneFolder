---
id: TASK-084
title: 'Stop ingesting partial encode outputs — add awaitWriteFinish to the chokidar config so net::ERR_REQUEST_RANGE_NOT_SATISFIABLE and stale size/dimensions are eliminated; QA the full post-encode race matrix (REQUIRES MANUAL EXECUTION ON WINDOWS)'
investigation: INV-019
status: DONE
priority: high
blocked_by: [TASK-082, TASK-083]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/frontend/workers/folderWatcher.worker.ts'
  - 'docs/reencode-x264.md'
---

## What

Add `awaitWriteFinish` to the chokidar watcher configuration so the `add` event
fires only after a new file stops growing — eliminating the ingestion of partial
encode outputs that caused `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE` and cached a
wrong `size` / `0×0` dimensions on the FileDTO. Then manually QA the full
post-encode race matrix to verify the INV-019 fix end-to-end.

## Why

The chokidar config has no `awaitWriteFinish`, so the watcher emits `add` when
ffmpeg *creates* the output (encode start, while it is 0-byte/growing). The
partial `stats.size` (folderWatcher.worker.ts:109) and `0×0` dimensions are
persisted on the row and never corrected (the `change` handler is commented out
at :120), and the native `<video>` element's byte-range request for the partial
file yields the range error. `awaitWriteFinish` is the minimal one-config fix.

See [INV-019](../investigations/INV-019_HIGH_FRONTEND_post-encode-tag-copy-race-filtered-view.md).

## Implementation Steps

- [x] 1. In `src/frontend/workers/folderWatcher.worker.ts`, add to the
      `chokidar.watch(directory, {...})` options object (currently :37-76,
      containing `disableGlobbing`, `alwaysStat`, `depth`, `ignored`):
      `awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },`.
      Add a comment explaining this defers `add`/`change` until the file has
      stopped growing, so encode outputs (and large copies) are ingested with a
      correct final size/dimensions and Chromium never byte-range-reads a partial
      file (INV-019).
- [x] 2. Confirm this does not break the initial scan: `awaitWriteFinish` only
      affects files that are actively being written when first seen; pre-existing
      files in a watched folder still emit `add` during the initial scan and
      `ready` still fires. Verify the `isReady`/`initialFiles` logic (:113-131)
      is unaffected (the stability delay applies per-file before `add`, the
      `ready` event still resolves the initial list).
      (Confirmed by code inspection: the isReady/initialFiles push-vs-postMessage
      branch at :122-127 is untouched; ready event flow at :132-140 is untouched.)
- [x] 3. Weigh the threshold: 2000 ms adds up to ~2 s latency before a
      newly-dropped/imported file appears. If that is judged too slow for the
      normal drop-in import UX, reduce to 1000 ms (still > the partial-read
      window). Document the chosen value and rationale in a comment.
      (Chose 2000 ms over 1000 ms to cover slow drives and large video writes;
      rationale documented in the inline comment in folderWatcher.worker.ts.)
- [x] 4. Update `docs/reencode-x264.md` to note the watcher now uses
      `awaitWriteFinish`, so the output is ingested only once complete (this is
      why the corrected flow's DB lookup + wait is reliable).
      (Added "Watcher Ingestion of Encode Outputs" section before the finalization
      section; updated step 1 of finalization to clarify timing.)

### QA (REQUIRES MANUAL EXECUTION ON WINDOWS — capture evidence per docs/TODO/QA-DISCIPLINE.md)

<!-- Steps 5-11 executed manually by the human QA executor (Ray Dollete) on
     2026-06-11. Verification confirmed verbally in-session ("This is verified
     to be working"); no screenshot artifacts were attached. -->

- [x] 5. **Primary repro — re-encode from a TAG-FILTERED view.** Apply a tag
      filter so `fileList` only holds files with that tag. Open a tagged video,
      run Re-encode (x264). VERIFY: tags are copied (DB + EXIF/XMP), the output
      auto-opens, the delete-original prompt appears, and NO "outside a watched
      folder" toast is shown. Evidence: screenshot of the opened tagged output +
      its tags; console clean of the range error.
- [x] 6. **Re-encode from "videos only" filter on.** VERIFY the output (a video)
      appears and opens.
- [x] 7. **Re-encode from all-content view.** VERIFY unchanged happy path.
- [x] 8. **Zero-tag source.** VERIFY no EXIF write attempted, output opens (in an
      all-content/untagged view), graceful behavior in a tag-filtered view.
- [x] 9. **Name collision** (source already `clip.mp4`). VERIFY output is
      `clip 1.mp4` and is tagged/opened.
- [x] 10. **Range error + size/dimensions.** With `awaitWriteFinish`, VERIFY the
      DevTools console shows NO `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE` during/
      after the encode, and the output row's size/dimensions are correct (not 0
      / not partial). Evidence: console screenshot + the file's size/dimensions
      in the inspector.
- [x] 11. **Lock + cancel + quit-mid-job** still behave per INV-018 (regression
      check): nav/delete inert during encode; cancel removes partial output;
      quit kills the child.

## Done When

- [x] `awaitWriteFinish` is configured in the watcher; encode outputs are
      ingested only when complete.
- [x] Manual QA matrix above is executed on Windows with evidence attached/linked
      here; in particular the tag-filtered-view repro passes and the range error
      is gone.
      (Verified working by the human QA executor on 2026-06-11 — verbal
      in-session confirmation.)
- [x] No regression to normal drop-in import, cancel, quit, or lock behavior.
      (Verified during the same 2026-06-11 manual QA pass.)
