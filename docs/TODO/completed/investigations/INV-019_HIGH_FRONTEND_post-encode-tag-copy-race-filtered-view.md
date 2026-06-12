---
id: INV-019
title: 'Post-encode tag-copy race: in a filtered view the re-encode output never enters fileList, so waitForIngestedFile times out and the app falsely claims the file is "outside a watched folder". Fix the order of operations so tags are copied at the DB level BEFORE attempting to show the file, and stop ingesting partial outputs.'
reported_bug: 'Intermittently, after a successful re-encode, the app claims the destination file is outside the watched folders (it is not — it lands beside the source in a watched location) and the console shows net::ERR_REQUEST_RANGE_NOT_SATISFIABLE. A path-separator/case mismatch in FileStore.waitForIngestedFile was fixed on 2026-06-11, but the 10-second timeout still fires intermittently — specifically when the re-encode is triggered from a tag-filtered or query view.'
date: 2026-06-11
status: resolved
superseded_by:
tasks_spawned: [TASK-081, TASK-082, TASK-083, TASK-084]
root_cause_category: order-of-operations
affects:
  - 'Post-encode orchestration (src/frontend/components/ImageTools.tsx handleReencode:36-113) — the current order is waitForIngestedFile (needs the file in fileList) -> copyTagsToFile (needs the ClientFile from fileList) -> select/show. In a tag-filtered view the tag-less output never matches the filter, never enters fileList, and the wait times out even though the DB row exists.'
  - 'FileStore.waitForIngestedFile (src/frontend/stores/FileStore.ts:1215-1255) — polls the VIEW-DEPENDENT fileList via a MobX reaction. fileList is a projection of the active search/filter (updateFromBackend wholesale-replaces it at :1363-1372, then a "videos only" display filter trims it at :1403-1419), not a repository index. A file that does not match the active query is provably absent from fileList.'
  - 'FileStore.copyTagsToFile (src/frontend/stores/FileStore.ts:1273-1291) — requires a ClientFile (from fileList) as its target. It cannot run until the file is in the list, which is the very thing that cannot happen for a tag-less output under a tag filter. Chicken-and-egg.'
  - 'Folder watcher ingestion timing (src/frontend/workers/folderWatcher.worker.ts:37-118) — no awaitWriteFinish in the chokidar config; the "add" event fires when ffmpeg CREATES the output (encode start, while the file is 0-byte/growing). stats.size (:109) and dimensions are captured from the PARTIAL file and persisted on the FileDTO, and nothing re-reads them after the file finishes growing (the "change" handler is commented out at :120). This is the source of net::ERR_REQUEST_RANGE_NOT_SATISFIABLE and stale size/dimensions.'
  - 'Timeout toast message (ImageTools.tsx:74-77) — asserts "outside a watched folder" as fact, which is wrong (the file is inside a watched folder); violates docs/TOOLS.md rule 4 (report the observable fact, offer causes as possibilities).'
  - 'Other fileList-by-path/ino lookups that share the same "fileList is a complete index" fallacy: LocationStore.addFile move-detection (:511), LocationStore.hideFile (:538), useFileDnD.ts:96, dnd.ts:42 — noted as latent, see Blast Radius.'
---

## Bug Report

### Observed Behavior

Intermittently, after a successful re-encode (INV-018 "Re-encode (x264)" tool),
the app shows the toast *"Encoded to &lt;path&gt; but it is outside a watched
folder; tags not attached."* even though the output `.mp4` landed beside the
source in a folder that IS watched. The DevTools console also logs
`net::ERR_REQUEST_RANGE_NOT_SATISFIABLE`.

A path-separator/case mismatch in `FileStore.waitForIngestedFile` was fixed on
2026-06-11 (it now normalizes both sides — `FileStore.ts:1220-1222`). That fix
was necessary but not sufficient: the 10-second `waitForIngestedFile` timeout
still fires intermittently.

The user observed that the failure correlates with the **active view**: it
reproduces when the re-encode is triggered from a tag-filtered or search view,
and does not reproduce from an unfiltered ("all content") view.

### Expected Behavior

After a successful encode, the output's tags must be copied (DB + EXIF/XMP) and
the output must auto-open in the viewer, regardless of the active search/filter.
The user's stated requirement: **the tags should be transferred to the new file
BEFORE attempting to show it.** Copying tags first makes a tag-filtered output
match the active filter, so it can then legitimately enter `fileList` and be
selected. If the output still cannot be shown in the active view for some other
reason (e.g. an extension filter excludes it), the flow must degrade gracefully
— not claim the file was never ingested.

### Reproduction Context

Deterministic given the right state:

1. Apply a tag filter or a search query so `fileStore.fileList` only holds files
   matching that criterion (`fetchFilesByQuery` -> `backend.searchFiles`,
   `FileStore.ts:1024-1049`). The "videos only" checkbox (`updateFromBackend`
   :1403-1419) is an additional in-memory trim that can also exclude the output.
2. Open a tagged video and run **Re-encode (x264)**.
3. The fresh output has **no tags** (ffmpeg `-c:v libx264` drops metadata, and
   tags have not been copied yet), so it cannot match the tag query. It is
   inserted into the DB by the watcher's early `add` (`LocationStore.addFile`
   :504-531 -> `createFilesFromPath` :525) but never enters the filtered
   `fileList`.
4. `waitForIngestedFile(outputPath, 10000)` polls `fileList`, never sees the
   file, and rejects after 10 s. The orchestration shows the "outside a watched
   folder" toast and skips tag copy + select.

Note: from the **Untagged** view the output (being untagged) DOES match the
query, so the bug does not reproduce there — it is specific to tag/query
filtered views (and any view where the "videos only" or other display filter
would exclude the not-yet-matching output).

---

## Root Cause Analysis

**Category:** order-of-operations (with a wrong-abstraction substrate and a
missing-edge-case secondary defect)

### Diagnosis

**Primary — wrong order of operations built on a wrong abstraction.**

`waitForIngestedFile` was built on the implicit contract *"ingested into the DB"
⟺ "present in fileList."* That equivalence only holds in an unfiltered view.
`fileStore.fileList` is a **view model** — the result of the current
search/filter query plus in-memory display filters — not a **repository index**:

- `refetch()` (`FileStore.ts:855-893`) dispatches to a fetcher by content mode;
  the tag/search path is `fetchFilesByQuery()` (`:1024-1049`) which calls
  `backend.searchFiles(...)` (`:1039`). A `tags: []` file cannot satisfy a tag
  criterion, so it is absent from the result.
- `updateFromBackend()` then **wholesale-replaces** the list:
  `this.fileList.clear(); this.fileList.push(...newClientFiles)`
  (`:1363-1372`). Anything not returned by the query is gone.
- The "videos only" preference applies a second in-memory `filter` and another
  `clear()/push()` (`:1403-1419`).

The post-encode orchestration in `ImageTools.tsx` (`handleReencode`, `:36-113`)
ordered the steps so that **showing the file is a prerequisite for tagging it**:

1. `waitForIngestedFile(outputPath)` — requires the file in `fileList`.
2. `copyTagsToFile(source, newFile)` — requires the ClientFile from `fileList`.
3. `selectFile` + `enableSlideMode`.

This is a chicken-and-egg: in a tag-filtered view, the file cannot enter
`fileList` until it has tags, but the code cannot give it tags until it is in
`fileList`. The correct order is the inverse: **copy tags at the DB level first
(no ClientFile required), THEN wait for the now-matching file to appear, THEN
select it.**

Crucially, the DB row already exists by the time the encode finishes: the
chokidar `add` fires when ffmpeg *creates* the output (encode start), driving
`LocationStore.addFile` -> `backend.createFilesFromPath` (`:525`). So the fix can
operate on the FileDTO directly via the backend
(`backend.fetchFilesByKey('absolutePath', ...)` + `saveFiles`) without needing a
ClientFile from the filtered `fileList`.

**Secondary — partial-output ingestion (missing edge case).**

The chokidar config (`folderWatcher.worker.ts:37-76`) has **no
`awaitWriteFinish`**, so `add` fires on the still-growing output. `stats.size`
(`:109`) — and the dimensions probed during `pathToIFile` — are captured from a
partial/0-byte file and persisted on the FileDTO. Nothing corrects them
afterward: the `change` handler is commented out (`:120`), and the only
re-index path (`LocationStore.ts:285-309`) runs on location load / manual
refresh, not after a re-encode. The native `<video>` element then issues a
byte-range request for a range beyond the partial file's current length, which
Chromium answers with `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE`. The log line is
cosmetic and self-heals on a later render, but the **wrong size / 0×0
dimensions** persist on the row (affecting `is_lowres` at `GalleryItem.tsx:271`
and the "changed on disk" size comparison at `LocationStore.ts:290`) until a
manual location reload.

### Diagnostic Questions Considered

- **Wrong mental model?** Yes (substrate). The orchestration treated `fileList`
  as a complete index of known files; it is a projection of the active filter.
- **Architectural shortcoming?** Partly: there is no DB-backed "find/tag a file
  by path" primitive in the renderer that is independent of the active view —
  the fix introduces one.
- **Incorrect order of operations?** **Yes — primary.** Tagging was ordered
  after showing; it must be ordered before, and done at the DB level.
- **Missing edge case?** **Yes — secondary.** Ingestion of a still-being-written
  file (no `awaitWriteFinish`, no `change` re-index) caches a partial size and
  0×0 dimensions and triggers the range error.
- **Wrong abstraction?** Yes: `waitForIngestedFile` coupled a correctness-
  critical post-encode step to the user's incidental filter state.
- **Silent failure?** The timeout is surfaced, but with a **wrong diagnosis**
  ("outside a watched folder"), which previously misdirected debugging
  (docs/TOOLS.md rule 4).

---

## Blast Radius

1. **`ImageTools.tsx` `handleReencode` (:36-113)** — the orchestration order is
   wrong. Must be re-sequenced: copy tags at the DB level first, then wait, then
   select. The Normalize Audio tool (INV-020) will reuse this corrected flow, so
   the fix should land first and be factored into a reusable helper.

2. **`FileStore.waitForIngestedFile` (:1215-1255)** — still polls the
   view-dependent `fileList`. After tags are copied it CAN appear (it now matches
   a tag filter), but the "videos only" filter or an extension/other criterion
   can still legitimately exclude it. Needs a graceful fallback rather than a
   misleading rejection.

3. **`FileStore.copyTagsToFile` (:1273-1291)** — ClientFile-only. A new
   DB-level sibling (e.g. `copyTagsToFileByPath` / `copyTagsToOutput`) is needed
   that resolves the FileDTO via the backend, sets tag ids, saves, and performs
   exactly one EXIF/XMP write — without requiring the file to be in `fileList`.
   Must NOT double-write metadata (the existing `disableImmediateSync` pattern
   wrote via the ClientFile path).

4. **Folder watcher (`folderWatcher.worker.ts:37-118`)** — ingests partial
   outputs (no `awaitWriteFinish`), caching wrong size/dimensions and triggering
   the range error. Mitigation options weighed in the Holistic Solution.

5. **Timeout toast (`ImageTools.tsx:74-77`)** — asserts a false cause. Must
   report the observable fact and offer causes as possibilities (docs/TOOLS.md
   rule 4).

6. **Latent `fileList`-as-index lookups (same fallacy, out of scope but
   recorded):** `LocationStore.addFile` move-detection (`:511`,
   mitigated by a DB fallback at `:512-514`), `LocationStore.hideFile` (`:538`,
   also uses a raw `===` path compare without normalization), `useFileDnD.ts:96`,
   `dnd.ts:42`. These silently fail to find files that exist in the DB but are
   outside the active filter. Flagged for a future "centralize find-by-path"
   follow-up; NOT fixed here to keep scope tight.

---

## UX / Requirements Specification

### Purpose

Make the re-encode post-processing correct from any view: the freshly-encoded
output always receives the source's tags (DB + EXIF/XMP) and auto-opens in the
viewer, and the user is never told the file is "outside a watched folder" when
it is not.

### User-Stated Design Decisions

1. **Copy tags BEFORE showing the file.** — Tagging the output first makes it
   match a tag filter, resolving the chicken-and-egg; it also means the EXIF/XMP
   write happens once, on a finished file, before selection.
2. **Operate at the DB level, not via the filtered fileList.** — The FileDTO
   already exists (ingested at encode start); resolve it via
   `backend.fetchFilesByKey('absolutePath', ...)` so the active filter is
   irrelevant to tag copy. Mind path normalization (docs/TOOLS.md rule 1): the
   DB stores forward-slash, lower-comparable paths; the main-computed
   `outputPath` is win32 backslash form.
3. **Write EXIF/XMP exactly once.** — Do not double-write (the source of the
   "double metadata write" risk noted in INV-018). One `exifTool.writeTags`
   (or the single `disableImmediateSync` flush) for the output.
4. **Degrade gracefully when the output still does not match the active view**
   (e.g. an extension filter or "videos only" still excludes it). — Do NOT claim
   "not ingested." Honestly inform the user, and/or clear the
   search/switch to all-content before selecting, so the auto-open still works.
5. **The timeout/edge toast must not assert "outside a watched folder" as a
   fact** (docs/TOOLS.md rule 4) — state the observable fact and offer possible
   causes as possibilities.

### Behavioral Specifications

**Corrected happy path (source `vacation.mp4`, tags `[Travel/Italy, 2025]`,
active TAG filter `Travel`):**

1. ffmpeg finishes; `startReencode` resolves with `outputPath` (win32
   backslashes), the output beside the source.
2. The DB already contains a row for `outputPath` (chokidar `add` at encode
   start). The renderer copies tags at the DB level:
   - Resolve the FileDTO: `backend.fetchFilesByKey('absolutePath', normalized)`
     — normalizing the path to the DB's stored form (forward slash); if the
     row is not yet present, poll briefly (bounded, e.g. up to ~3 s) since
     `createFilesFromPath` is synchronous-ish but the worker round-trip is not.
   - Set the source's tag ids on the DTO and `backend.saveFiles([dto])`.
   - Write EXIF/XMP once: `exifTool.writeTags(outputPath, hierarchy)` (skip
     entirely when the source has zero tags).
3. The renderer triggers a refetch (`fileStore.refetch()` / `debouncedRefetch`)
   and then `waitForIngestedFile(outputPath, 10000)`. The output now carries the
   `Travel` tag, so it matches the active filter and appears in `fileList`.
4. `selectFile(newFile, true)` + `enableSlideMode()` show it.
5. `openReEncodeDeleteOriginal(source)` prompts to delete the original.

**Output still excluded after tag copy (e.g. "videos only" off but source was an
image — not applicable here — or an extension/other criterion):** after the
bounded wait, instead of the false "outside a watched folder" toast: clear the
active search (or switch to all-content) and re-resolve, OR show an honest toast
("Re-encoded to &lt;path&gt; and tagged it, but it is not visible in the current
filter; clear the filter to see it."). Tags are already copied (step 2 ran
regardless), so no work is lost. The lock still releases in `finally`.

**Zero-tag source:** DB tag set is empty; skip the EXIF/XMP write; the output
appears in an all-content / untagged view; in a tag-filtered view it legitimately
does not match — fall through to the graceful path above.

### Explicit Rejections

- **Do not keep ordering "show before tag."** Tagging is a prerequisite for
  visibility under a tag filter; it must come first.
- **Do not resolve the output via the filtered `fileList` for tag copy.** Use the
  backend by absolute path. `fileList` is a view, not an index.
- **Do not strict-compare the main-computed path against DB/renderer paths.**
  Normalize separators and case (docs/TOOLS.md rule 1) — the DB stores
  forward-slash lowercased-comparable paths; `getUniqueSiblingPath`
  (`common/fs.ts:78-92`) returns win32 backslashes via `path.join`.
- **Do not double-write EXIF/XMP.** Exactly one write for the output.
- **Do not assert "outside a watched folder" as a fact** in any toast.
- **Do not widen the partial-ingestion fix into a watcher rearchitecture.** Pick
  the minimal correct mitigation (see Risks).

---

## Holistic Solution

### Approach

Re-sequence the post-encode flow into a single reusable renderer helper, fix the
two error messages, and apply the minimal correct mitigation for partial-output
ingestion. Four tasks (TASK-081..084); the bugfix tasks land before the INV-020
Normalize Audio feature, which reuses the corrected flow.

1. **TASK-081 — DB-level tag copy by path (`FileStore.copyTagsToOutputPath`).**
   New method that: normalizes `outputPath` to the DB stored form; resolves the
   FileDTO via `backend.fetchFilesByKey('absolutePath', ...)` (bounded poll for
   the row, ~3 s, since ingestion is async); sets `Array.from(source.tags, t =>
   t.id)` (+ source's tag set) onto the DTO and `backend.saveFiles([dto])`;
   writes EXIF/XMP exactly once via `exifTool.writeTags(outputPath, hierarchy)`
   (skipped for zero-tag sources). Returns success/whether the row was found.
   No ClientFile required.

2. **TASK-082 — Re-sequence the post-encode orchestration into a reusable
   helper (`FileStore.finalizeEncodedOutput` or a small orchestration module).**
   New order: (a) `copyTagsToOutputPath(source, outputPath)`; (b)
   `refetch()`/`debouncedRefetch()`; (c) `waitForIngestedFile(outputPath)`; (d)
   on success `selectFile + enableSlideMode`; (e) on
   still-not-visible, the graceful fallback (clear search / switch to
   all-content, re-resolve, or honest toast — never "not ingested"). Wire
   `ImageTools.tsx handleReencode` to call this helper. Keep the lock release in
   `finally`. This helper is what INV-020's Normalize Audio tool will reuse.

3. **TASK-083 — Honest error/edge messaging.** Replace the
   `ImageTools.tsx:74-77` toast and the `waitForIngestedFile` rejection text so
   neither asserts "outside a watched folder" as fact. State the observable fact
   ("the encoded file was not detected in the current view within 10 s") and
   offer possible causes as possibilities (docs/TOOLS.md rule 4). Since tags are
   now copied before the wait, the message can also note that tagging already
   succeeded.

4. **TASK-084 — Partial-output ingestion mitigation + QA (REQUIRES MANUAL
   EXECUTION ON WINDOWS).** Add `awaitWriteFinish` to the chokidar config in
   `folderWatcher.worker.ts` (stabilityThreshold + pollInterval) so `add` fires
   only after the output stops growing — this fixes both the wrong cached
   size/dimensions and the `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE` at its
   source, with no new code paths. Verify it does not regress normal
   drop-in/import ingestion latency unacceptably (it adds the stability delay to
   every add; weigh the threshold). QA the full matrix: re-encode from a
   tag-filtered view (the primary repro), from "videos only", from all-content,
   zero-tag source, name collision, and confirm no range error and correct
   size/dimensions on the output row.

### Expected Outcomes

- Re-encoding from any view copies the source's tags (DB + EXIF/XMP) to the
  output and auto-opens it; the "outside a watched folder" false claim is gone.
- A reusable `finalizeEncodedOutput` helper that INV-020 (Normalize Audio) and
  any future sibling-producing tool builds on, with the correct order baked in.
- No `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE`; the output row carries the correct
  size and dimensions.
- Honest messaging that never asserts an unverified cause.

### Risks and Tradeoffs

- **`awaitWriteFinish` adds latency to every ingest.** It delays the `add` event
  by `stabilityThreshold` for ALL files (drops, imports, encodes), not just
  encodes. Mitigation: keep the threshold modest (e.g. 1–2 s) and document the
  tradeoff. Alternative considered and rejected as larger scope: re-enable the
  `change` handler to re-read size/dimensions and invalidate the thumbnail —
  more code, more events, more risk than the one-line config option.
- **DB-row-not-yet-present race.** `createFilesFromPath` runs via the watcher
  worker round-trip; the row may lag the ffmpeg completion slightly. The bounded
  poll in `copyTagsToOutputPath` covers this; if the row never appears (output
  genuinely outside any watched location — defensive on this single-user fork)
  the helper reports it honestly and the lock still releases.
- **Refetch after tag-save.** Saving the DTO does not by itself put the file in
  `fileList`; an explicit `refetch()` is needed so the now-matching file is
  fetched. This re-runs the active query (cheap) — acceptable.
- **Tag-id vs ClientTag at the DB level.** `copyTagsToOutputPath` writes raw tag
  ids onto the DTO; it must use the same id set the ClientFile path would
  (`Array.from(source.tags, t => t.id)`) and must NOT touch derived counters
  (`numUntaggedFiles`) directly — the subsequent refetch reconciles the view
  (docs/TOOLS.md rule 2: treat derived counters as stale, never abort on them).

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-082/083 update `docs/TOOLS.md` "correct order of operations"
      section (copy tags at the DB level BEFORE waiting/showing; the
      view-dependence of `fileList`; the graceful-fallback rule) and
      `docs/reencode-x264.md` (corrected ingestion/tag-copy/await sequence and
      the `awaitWriteFinish` note). TASK-084 notes the watcher `awaitWriteFinish`
      change.
