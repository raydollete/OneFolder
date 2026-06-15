---
id: INV-026
title: 'Media-job ffmpeg tools write output DIRECTLY into the watched target folder, so the chokidar watcher races to ingest the still-being-written / not-yet-tagged file. Fix: write to a hidden SAME-VOLUME temp dir outside the watch, tag it there, then atomically rename into the target folder as the final step — uniformly for ALL media jobs (Re-encode x264, Compress & Normalize Audio, Create Clip) via the shared runner + finalize.'
reported_bug: 'When an ffmpeg media-job tool produces a new output file beside the source inside a tracked/watched location, the app intermittently (1) errors out claiming the new file fell OUTSIDE the watched folders (false — it is in the same in-location directory as the source) and (2) imports the new file UNTAGGED because tag-replication never completes. The application is reacting to the partially-complete file that ffmpeg is still writing: chokidar fires `add` on the half-written file and the renderer races to ingest it before ffmpeg finishes and before tags are copied.'
date: 2026-06-13
status: tasks-created
superseded_by:
tasks_spawned: [TASK-100, TASK-101, TASK-102, TASK-103]
root_cause_category: architectural-shortcoming
affects:
  - 'Shared ffmpeg runner output placement (src/ReEncodeManager.ts start():123-136, _runJob():181-299) — output is computed as a sibling of the source via getUniqueSiblingPath(path.dirname(inputPath), …) and ffmpeg writes -y directly into that WATCHED directory (argv built at :197-208, spawn at :210). The watcher therefore sees the file from the moment ffmpeg creates it. This is the single shared output-placement site for ALL THREE media jobs.'
  - 'Shared renderer finalize (src/frontend/stores/FileStore.ts finalizeEncodedOutput:1531-1594 and copyTagsToOutputPath:1415-1493) — depends on the watcher creating the DB row, then polls the backend for it (FileStore.ts:1446-1464) and copies tags AFTER ingestion. This couples correctness to the watcher race and to the awaitWriteFinish timing, which is the intermittency.'
  - 'Chokidar location watcher (src/frontend/workers/folderWatcher.worker.ts:37-128) — awaitWriteFinish { stabilityThreshold: 2000 } (INV-019/TASK-084) only PARTIALLY mitigates: it defers `add` until the file stops growing for 2 s, but (a) the renderer poll can still time out against a slow watcher round-trip, and (b) any tool whose write pauses/stutters can still surface a premature/partial add. The watcher ingesting derived output AT ALL is the architectural flaw the temp-dir approach removes.'
  - 'main.ts onStartMediaJob IPC handler (src/main.ts:755-837) and MEDIA_JOB_SPECS (src/main.ts:34-60) — the single dispatch point that returns { outputPath } to the renderer; must become a two-phase commit (ffmpeg→temp, then tag, then atomic rename→final) and the result/IPC contract must carry both tempPath and finalPath.'
  - 'ffmpeg partial-output cleanup on cancel / error / before-quit (src/ReEncodeManager.ts cancel:142-153, killAll:160-168, _killAndClean:361-390, child.on(error):267-278, child.on(close) non-zero:280-298) — currently removes the single outputPath; with a temp dir these must clean the TEMP partial, and a new leak window exists if quit/cancel lands during/after the temp→final rename.'
  - 'Path-separator/case mismatch in raw absolutePath comparisons (SECONDARY, mostly latent): src/frontend/containers/Outliner/LocationsPanel/dnd.ts:42 (webUtils.getPathForFile returns win32 backslashes compared raw against forward-slash ClientFile.absolutePath), useFileDnD.ts:96 (dst built renderer-side). The post-encode flow itself already normalizes (FileStore.ts:1318-1320, 1426-1430); the "outside a watched folder" misjudgment is NOT primarily a normalization bug here — it is the watcher-race + DB-poll timeout. Recorded for completeness, not the primary fix.'
---

## Bug Report

### Observed Behavior

Running an ffmpeg media-job tool (Re-encode x264, Compress & Normalize Audio,
or Create Clip) on a video inside a tracked/watched location intermittently
fails two ways:

1. **False "outside a watched folder" / "could not be confirmed in your library"
   toast** (`FileStore.finalizeEncodedOutput:1546-1551`) even though the output
   `.mp4` landed beside the source in a directory that IS watched.
2. **The new file is imported UNTAGGED** — the source's tags were never copied
   to it, because the tag-replication step (`copyTagsToOutputPath`) never
   resolved the DB row in time and bailed (`FileStore.ts:1466-1470` returns
   `null`).

Both symptoms are intermittent. INV-019 previously added
`awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }` to the
watcher (`folderWatcher.worker.ts:49`) and a path-normalization fix; that
reduced but did not eliminate the race.

### Expected Behavior

After any media job, the watcher must only ever see a **complete, already-tagged**
output file. The new file must reliably (a) be recognized as inside the watched
location, (b) carry the source's tags (DB + EXIF/XMP), and (c) auto-open and
offer to delete the original — identically for all three tools.

### Reproduction Context

Conditional / timing-dependent. Most reproducible with larger or slower writes
(big re-encode, slow disk) where ffmpeg's output file is observably "growing"
for long enough that the watcher's `add` (or the renderer's DB poll against the
watcher round-trip) lands inside the write window. The user's chosen, root-cause
fix removes the timing dependence entirely rather than tuning thresholds.

---

## Root Cause Analysis

**Category:** architectural-shortcoming (the derived output is produced INSIDE
the watched filesystem, so an incomplete/untagged artifact is exposed to the
ingestion pipeline; the renderer finalize is then forced to race the watcher).

### Diagnosis

The media-job stack was built on the implicit contract *"produce the output
beside the source and let the existing folder watcher ingest it, then tag the
ingested row."* That contract structurally requires exposing a **not-yet-finished,
not-yet-tagged** file to the watcher, then racing to repair it after the fact.

Concretely:

- **Output is written into the watched directory.** `ReEncodeManager.start`
  computes `outputPath = getUniqueSiblingPath(path.dirname(inputPath), baseName,
  outputExt)` (`src/ReEncodeManager.ts:123-125`) — `path.dirname(inputPath)` is
  the source's folder, which is a watched location. `_runJob` spawns ffmpeg with
  `… '-y', outputPath` (`:197-208`, `:210`), so ffmpeg creates and grows the file
  in place, under the watcher.
- **The watcher ingests that file.** `folderWatcher.worker.ts` watches the
  location (`:37-85`); on `add` it posts `{ type:'add', value: fileStats }`
  (`:95-128`) → `LocationStore.addFile` (`:504-531`) → `backend.createFilesFromPath`
  (`:525`). `awaitWriteFinish` (`:49`) defers `add` until the file is stable for
  2 s, which is a *partial* mitigation, not a guarantee.
- **The renderer finalize races the watcher.** `finalizeEncodedOutput` (`:1531`)
  → `copyTagsToOutputPath` (`:1415`) **polls the backend** for the
  watcher-created row (`:1446-1464`, 50 × 200 ms) and only then copies tags.
  When the watcher round-trip + 2 s stability window exceeds the poll budget, the
  poll returns no row, `copyTagsToOutputPath` returns `null` (`:1466-1470`), and
  `finalizeEncodedOutput` shows the false "outside a watched folder / could not be
  confirmed" toast (`:1542-1552`) and skips tag copy and auto-open. That is both
  symptoms at once.

The mitigation INV-019 chose (await-write-finish + DB poll) treats the symptom
(racing a partial file) instead of the cause (the partial file is in the watch
at all). The correct fix is to **never let the watcher see the file until it is
finished AND tagged**: stage the ffmpeg output in a temp directory OUTSIDE any
watch, tag it there, and move it into the target folder atomically as the last
step. Then ingestion of the final file is deterministic and the renderer no
longer races anyone.

### Diagnostic Questions Considered

- **Wrong mental model?** Yes — the design assumed "watcher ingest of the
  in-place output" was a safe primitive; it exposes incomplete/untagged
  artifacts to the pipeline.
- **Architectural shortcoming?** **Yes — primary.** There is no staging boundary
  between "ffmpeg is producing the file" and "the library may see the file." The
  fix introduces that boundary (temp dir → tag → atomic rename).
- **Incorrect order of operations?** Secondary: tagging happens after ingestion;
  the fix moves tagging BEFORE the file is ever visible to the watcher.
- **Missing edge case?** The `awaitWriteFinish` threshold is a tuned timing
  guess; relying on it is the edge case that intermittently fails.
- **Wrong abstraction?** `copyTagsToOutputPath` is forced to discover the output
  by polling a view/DB the watcher populates asynchronously, instead of operating
  on a path it deterministically controls.
- **Silent failure?** The failure is surfaced, but with a wrong cause ("outside a
  watched folder"); the file IS inside the watch (docs/TOOLS.md rule 4).

---

## Blast Radius

1. **`src/ReEncodeManager.ts` — shared output placement (`start`/`_runJob`).**
   Single site where the ffmpeg output path is computed and written. Must compute
   a TEMP path (same-volume, outside the watch) for ffmpeg's `-y` target, keep
   the FINAL collision-free sibling path, and add the atomic temp→final rename as
   an explicit last step. All three job types inherit this automatically — there
   is exactly one such site (bomb-squad confirmed: the only `getUniqueSiblingPath`
   caller in `src/`).

2. **`src/frontend/stores/FileStore.ts` — shared finalize
   (`finalizeEncodedOutput`, `copyTagsToOutputPath`).** Must stop racing the
   watcher. Under the fix the tag write happens on the TEMP file (deterministic
   path, no DB row needed yet), and only the final renamed file is ingested; the
   renderer then resolves the deterministically-known final path rather than
   discovering it by polling. The DB-poll-for-the-row logic
   (`copyTagsToOutputPath:1432-1470`) collapses to a fast, predictable ingest of
   a known-complete file. Shared by all three tools — fixed once here.

3. **`src/main.ts onStartMediaJob` (`:755-837`) + `MEDIA_JOB_SPECS` (`:34-60`).**
   The single dispatch + result contract. Must become two-phase: ffmpeg → temp,
   return both `tempPath` and `finalPath`; after the renderer tags the temp file,
   commit (atomic rename) into the target. Enumerated all three specs
   (`reencode-x264`, `normalize-audio`, `create-clip`) — `create-clip` differs
   ONLY in per-invocation `preInputArgs` (`-ss`/`-to`, `:761-795`); its output
   placement is identical, so it inherits the temp-dir path with no special case.

4. **Chokidar watcher (`folderWatcher.worker.ts:37-128`).** Once output is staged
   outside the watch, the watcher no longer sees partial/untagged files. The
   hidden temp subdir must be guaranteed-ignored by the watcher (dot-prefixed
   basenames and dot-directories are already ignored at `:60-62`, `:79-83`). The
   `awaitWriteFinish` setting can REMAIN as belt-and-suspenders (it still helps
   genuine drag-drop imports), but media jobs no longer depend on it.

5. **Cleanup on cancel / error / before-quit (`ReEncodeManager.ts` `cancel:142`,
   `killAll:160`, `_killAndClean:361`, `child.on('error'):267`,
   `child.on('close')` non-zero `:280-298`).** Must remove the TEMP partial
   (the encode target is now the temp path). A NEW leak window appears if
   cancel/quit lands during or after the temp→final rename — the `JobEntry` must
   track both paths and a phase so cleanup removes whichever exists. Same-volume
   rename is atomic, which makes "half-moved final file" effectively impossible on
   the happy path; the temp dir itself must also be swept.

6. **(SECONDARY, latent) Raw path comparisons without separator/case
   normalization.** `dnd.ts:42` (`webUtils.getPathForFile` → win32 backslashes vs
   forward-slash `ClientFile.absolutePath`) and `useFileDnD.ts:96` (`dst`). These
   are NOT the cause of the media-job "outside a watched folder" toast (that path
   already normalizes — `FileStore.ts:1318-1320`, `:1426-1430`), but they are the
   same fork-wide forward-slash hazard. Recorded; out of scope for the primary fix.

7. **(SECONDARY, latent, out of scope) Other watcher-ingest-dependent writers.**
   `dnd.ts:107` and `useClipboardImporter.ts:47` write new files into watched
   locations and rely on the watcher to ingest them (and appear non-functional
   because `onStoreFile` is never registered — `STORE_FILE` has no main handler).
   `useFileDnD.ts:109` `fse.move` into a watched location. Same family as this
   bug; flagged, not fixed here.

---

## UX / Requirements Specification

### Purpose

Make every ffmpeg media job produce its output so that the watcher only ever
sees a complete, already-tagged file inside the target folder — eliminating the
intermittent "outside a watched folder" error and the untagged-import, uniformly
for all three tools and any future ffmpeg tool.

### User-Stated Design Decisions

1. **Stage ffmpeg output in a TEMP folder OUTSIDE any watched location.** —
   ffmpeg must not write into the target folder directly; the watcher must never
   observe a partial file.
2. **Apply/copy the tags to the file WHILE it is still in the temp folder** —
   fully complete and not being watched, so tagging cannot race ingestion.
3. **THEN move/copy the finished, fully-tagged file into the target folder as the
   final step** — so the watcher's first and only observation is a complete,
   tagged file.
4. **Uniformity across ALL ffmpeg tools.** — Re-encode (x264), Compress &
   Normalize Audio, and Create Clip MUST use the identical temp-dir-then-move
   logic, implemented ONCE in the shared runner (`ReEncodeManager`) and shared
   finalize (`finalizeEncodedOutput`). No tool may be special-cased. Every entry
   in `MEDIA_JOB_SPECS` flows through the unified path; any divergent
   output/finalize path must be converged (none found — all three already share
   the path).
5. **Auto-open/select and the delete-original prompt must remain intact for every
   tool** — unchanged user-visible flow; only the file-staging mechanics change.
6. **No leaked temp files and no moved partial file** on ffmpeg failure, cancel,
   or quit-mid-job — uniformly for every tool.

### Behavioral Specifications

**Corrected happy path (any of the three tools):**

1. UI lock acquired; source pinned in the viewer
   (`ImageTools.tsx runMediaJob:94`, unchanged).
2. Main computes the FINAL collision-free sibling path in the target dir
   (`getUniqueSiblingPath(dir, …)`) AND a TEMP path on the SAME VOLUME, outside
   the watch (a hidden dot-subdir of the target dir — see Design Decision
   "Temp location" below). ffmpeg writes `-y <tempPath>`.
3. On ffmpeg success, main reports `{ tempPath, finalPath }` to the renderer
   (does NOT move yet).
4. The renderer writes the source's tags (EXIF/XMP) to the **temp** file via the
   existing renderer exiftool, on the deterministic temp path — no DB row, no
   watcher, no race. (Skip the write for a zero-tag source.)
5. The renderer asks main to COMMIT: atomic `rename(tempPath, finalPath)` (same
   volume). The watcher now fires `add` exactly once, on the complete, tagged
   final file.
6. The renderer ingests/refetches the deterministically-known `finalPath`, sets
   the output's tags at the DB level, selects it, swaps the pin from source to
   output, and opens the delete-original prompt — exactly as today, but the file
   it resolves is guaranteed complete and present.

**Failure / cancel / quit:** the temp file (and the temp dir) are removed; the
final path is never created (or, if commit had started, the atomic rename either
fully succeeded or left only the temp file). The source stays on screen; no
delete-original prompt.

### Explicit Rejections

- **Do not keep writing ffmpeg output into the watched target folder.** That is
  the root cause.
- **Do not special-case any single tool.** The temp-dir-then-move logic lives in
  the shared runner + finalize; all three tools inherit it.
- **Do not rely on tuning `awaitWriteFinish` to "win" the race.** It may remain
  as defense for drag-drop imports, but media jobs must not depend on it.
- **Do not place the temp dir on a different volume from the target** unless
  unavoidable — a cross-volume move is copy+delete (NOT atomic) on Windows and
  reintroduces a partial-file window at the destination.
- **Do not double-write EXIF/XMP.** Exactly one tag write per output, on the temp
  file before commit.
- **Do not assert "outside a watched folder" as a fact** in any toast
  (docs/TOOLS.md rule 4).

---

## Holistic Solution

### Approach

Introduce a staging boundary in the **shared** runner and finalize so every media
job: ffmpeg → temp (same-volume, outside watch) → tag temp → atomic rename →
final. Four tasks, ordered shared-runner/main first, then shared finalize, then
cleanup hardening, then a Windows portable QA pass across all three tools.

**TASK-100 — Shared runner: stage ffmpeg output in a same-volume hidden temp dir
and add a commit (atomic rename) step.** In `src/ReEncodeManager.ts`: compute
`finalPath` (as today, via `getUniqueSiblingPath` in the target dir) AND a
`tempPath` inside a hidden, same-volume staging dir (`<targetDir>/.onefolder-tmp/`
created with `fse.ensureDir`; a dot-dir the watcher ignores). Spawn ffmpeg with
`-y <tempPath>`. On `close(0)` do NOT auto-move; report `{ tempPath, finalPath }`
via `onDone`. Add a `commit(jobId)` method that performs `fse.move(tempPath,
finalPath, { overwrite: false })` (same volume → atomic rename) and resolves with
`{ outputPath: finalPath }`. Extend `JobEntry` with `tempPath`, `finalPath`, and a
`phase` ('encoding' | 'encoded' | 'committing' | 'done'). Same-volume guarantees
the move is a rename; if `path.parse(tempDir).root !== path.parse(finalPath).root`
(should never happen since temp is a child of the target dir), fall back to
copy+fsync+unlink and document the weaker guarantee.

**TASK-101 — Two-phase IPC + main dispatch.** In `src/ipc/{messages,renderer,main}.ts`
and `src/main.ts`: `START_MEDIA_JOB` now resolves `{ jobId, tempPath, finalPath }`
when ffmpeg finishes (the file is in temp, untagged). Add `COMMIT_MEDIA_JOB(jobId)`
(invoke) that calls `reEncodeManager.commit(jobId)` and resolves `{ outputPath }`.
`onStartMediaJob` (`src/main.ts:755-837`) builds `preInputArgs` for `create-clip`
exactly as today and is otherwise unchanged in dispatch — the temp/final split is
entirely inside `ReEncodeManager`, so all three `MEDIA_JOB_SPECS` entries are
covered with no per-tool branching. Update the `MediaJobResult` type and the
renderer messenger accordingly.

**TASK-102 — Shared finalize: tag the temp file, commit, then ingest the known
final path.** In `src/frontend/stores/FileStore.ts` and
`src/frontend/components/ImageTools.tsx`: rework `finalizeEncodedOutput(source,
{ tempPath, finalPath })` so it (a) writes the source's tags (EXIF/XMP) to
`tempPath` via the renderer exiftool (skip for zero-tag source), (b) calls
`RendererMessenger.commitMediaJob(jobId)` to atomically rename temp→final, (c)
ingests/refetches the deterministically-known `finalPath`, copies tags at the DB
level onto the now-present row, selects it, and returns the output ClientFile.
`copyTagsToOutputPath`'s long DB poll becomes a short, expected wait on a
known-complete file (the row appears once, deterministically). Preserve the pin
swap (`ImageTools.tsx:127`), the create-clip field reset (`:131-134`), and the
delete-original prompt (`:138`). Keep all messaging honest (docs/TOOLS.md rule 4).
Update `ImageTools.tsx runMediaJob` to thread `tempPath`/`finalPath` and the
`jobId` (already captured via the first progress event) into commit.

**TASK-103 — Cleanup hardening + Windows portable QA (REQUIRES MANUAL EXECUTION).**
Harden `ReEncodeManager` cleanup: `child.on('error')`/`child.on('close')` non-zero
and `_killAndClean` remove `tempPath` (not `finalPath`); `commit` failures remove
the temp file; on cancel/quit, sweep the `.onefolder-tmp` staging dir for the
job. Ensure no partial ever lands at `finalPath` (atomic rename guarantees this on
the happy path; a failed/aborted commit leaves only the temp file). Then QA on a
Windows portable build, exercising ALL THREE tools (Re-encode, Compress &
Normalize Audio, Create Clip) through the identical temp-dir path: verify (1) no
"outside a watched folder" toast, (2) the output is tagged (DB + EXIF/XMP), (3)
auto-open + delete-original prompt work, (4) cancel mid-encode leaves no temp file
and no final file, (5) force-quit mid-encode leaves no leak, (6) name-collision
increments correctly, (7) zero-tag source skips the EXIF write and still opens,
(8) the `.onefolder-tmp` dir is never ingested by the watcher.

### Expected Outcomes

- The watcher only ever observes complete, already-tagged output files; the
  intermittent "outside a watched folder" error and untagged imports are gone for
  all three tools.
- One shared code path (runner + finalize) governs staging/tagging/move for every
  current and future ffmpeg tool — no per-tool divergence.
- No leaked temp files or moved partials on failure/cancel/quit.

### Risks and Tradeoffs

- **Same-volume requirement.** The temp dir is a child of the target dir, so it is
  always on the same volume → the move is an atomic rename. The only way to break
  this is a target dir that is itself a volume mount boundary mid-path (not a
  realistic case for a single-user photo folder); the copy+fsync+unlink fallback
  covers it with a documented weaker guarantee.
- **Hidden temp dir visibility.** `.onefolder-tmp` is a dot-dir; confirm it is
  ignored by the watcher (it is — `folderWatcher.worker.ts:60-62`, `:79-83`) and
  acceptable to leave a (swept-empty) hidden dir in the user's folder. Sweep it on
  job completion and on app start.
- **Two-phase IPC adds a round-trip.** START → (tag temp) → COMMIT is one extra
  IPC hop versus today's single resolve. Negligible vs. the multi-second encode,
  and it is what makes tagging-before-visibility possible.
- **`awaitWriteFinish` retained.** Keeping the 2 s stability window means the
  final file's `add` is still deferred ~2 s after the rename; the renderer's
  ingest of the known `finalPath` must tolerate that (bounded wait on a row that
  is now guaranteed to appear), which is strictly more reliable than today's
  race because the file is complete and tagged before the window even starts.
- **Path normalization (secondary).** The media-job flow already normalizes; the
  `dnd.ts:42` / `useFileDnD.ts:96` raw comparisons are recorded as latent fork-wide
  hazards but are deliberately out of scope to keep this fix tight.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-102/103 update `docs/TOOLS.md` "correct order of operations"
      (stage in a same-volume temp dir → tag → atomic rename → ingest the known
      final path; the watcher never sees partial/untagged output) and
      `docs/reencode-x264.md`, `docs/normalize-audio.md`, `docs/create-clip.md`
      (note the shared temp-dir-then-move staging and that all three tools share it).
