---
id: INV-015
title: 'Deleting a video from SlideMode exits to the index and re-randomizes the gallery; should auto-advance to the next file without reshuffling'
reported_bug: 'After deleting a video from the video viewer, the user is taken back to the thumbnail index. If the sort order was random, the index re-randomizes. The video player should auto-advance to the next video if possible, remove the deleted video from the index, and not re-randomize. If the deleted video is the last one in the index, then return the user to the index — but again, preserve the existing order rather than reshuffling.'
date: 2026-05-15
status: active
superseded_by:
tasks_spawned: [TASK-063, TASK-064, TASK-065]
root_cause_category: architectural-shortcoming
affects:
  - 'FileStore.deleteFiles → refetch() (src/frontend/stores/FileStore.ts:670-691) — issues a full backend re-query after every delete; under random sort the backend issues a fresh ORDER BY RANDOM() and shuffles the entire gallery'
  - 'setContentAll / setContentUntagged / setContentQuery / setContentDuplicates (src/frontend/stores/FileStore.ts:603-629) — every fetcher calls one of these via refetch(), and each one unconditionally disableSlideMode() — which is what kicks the user back to the thumbnail index after a delete'
  - 'SlideMode current-item bookkeeping (src/frontend/stores/UiStore.ts:331-335, 641-647) — firstItem is left pointing at the index the deleted file used to occupy. After the post-refetch reshuffle that index now points at an arbitrary unrelated file, masking the slot-bookkeeping bug behind the reshuffle bug'
  - 'SlideMode rendering gate (src/frontend/containers/ContentView/LayoutSwitcher.tsx:193) — renders SlideMode only when uiStore.firstFileInView is truthy; once disableSlideMode() fires from inside refetch, the user is dumped to the thumbnail index even before firstItem is reconciled'
  - 'Random-sort backend semantics (src/backend/sqlite-backend.ts:466-470, 532-540 — ORDER BY RANDOM(); src/backend/backend.ts:144-145, 190-191 — shuffleArray) — every fetch reshuffles by design. Decision in INV-011 explicitly kept this behavior for app launch / location-watcher / content-mode-switch. INV-015 is about extending the same in-place editing pattern as replaceMovedFile() to destructive deletes so the user-visible order survives a delete'
  - 'Other refetch-after-destructive callers (FileStore.deleteFilesByExtension, LocationStore.removeSublocationFiles, LocationStore.removeFile via hideFile, useFileDnD.handleMove → fileStore.deleteFiles for overwrite-replace) — same reshuffle-on-destructive-action pattern'
  - 'Bulk delete from gallery (multiple files selected, Delete pressed) — same root cause, same reshuffle, plus an additional "scroll position lost" symptom since firstItem may now point at unrelated files'
  - 'Preview window (src/frontend/Preview.tsx) — secondary window, also navigates via firstItem and renders the same SlideMode. Same auto-advance gap applies if delete is ever wired through there'
---

## Bug Report

### Observed Behavior

The user is viewing a video in the OneFolder video viewer (SlideMode — the
full-screen one-file-at-a-time view opened by double-clicking a thumbnail).
While the video is on screen they press Delete (or right-click → Delete file).
The trash confirmation dialog opens. They confirm.

Two things happen that the user does not want:

1. **SlideMode immediately closes** and the user is returned to the thumbnail
   grid. There is no "advance to the next video" behavior — the video viewer
   just disappears.

2. **If the gallery sort is set to `random` (the new default, per INV-011),
   the thumbnail grid reshuffles** into a fresh order. The user loses the
   visual context of "which files were nearby the one I just deleted," and
   the prior position they were browsing through is gone.

In smaller observation: the deleted file is correctly removed from the DB and
from disk (the trash/recycle bin flow itself works — INV-014 closed that).
But the surrounding UX is broken.

### Expected Behavior

After confirming the delete:

1. **Auto-advance** within SlideMode to the next file at the same logical
   position in the current list. If the user was on file at index `i` (in
   the current, possibly-randomized list), the deleted file is spliced out
   in place and the SlideMode now shows what was previously at index `i+1`
   (which, after the in-place splice, has slid up to index `i`). If the
   deleted file was at the tail (`i === fileList.length - 1`), advance to
   the new tail (`i - 1`).

2. **Do not re-issue any backend fetch** in response to the delete. The
   in-memory `fileList` is the source of truth for the visible order; the
   backend never needs to be re-queried just to learn that one file was
   removed. The order the user has been browsing — including the random
   shuffle picked at app launch or at the last user-initiated sort change —
   must survive the delete unchanged.

3. **If the deleted video was the last file in the list** (after splice,
   `fileList.length === 0`), close SlideMode and return to the thumbnail
   index, but DO NOT re-randomize the (now-empty) gallery. (And if it's
   the last file selected in a bulk delete that empties the list entirely,
   same outcome: empty grid, no reshuffle of nothing.)

4. **Same rules apply for image deletes** — not just videos. The user
   phrased the report around the video viewer because that is where they
   noticed it, but the underlying refetch-and-reshuffle is delete-only,
   not video-specific. Image deletes from SlideMode have the same bug.

### Reproduction Context

**Deterministic.** Triggers (each independently reproduces all three
symptoms above):

1. Set gallery sort to Random in the Sort menu.
2. Open any video in SlideMode (double-click a video thumbnail, or select
   it and press Enter / Space).
3. Press the Delete hotkey (or right-click → Delete file).
4. Confirm the trash dialog.

Observed: SlideMode closes, thumbnail grid reshuffles, the file is gone.
Expected: SlideMode stays open on the next file, thumbnail grid order
unchanged, the file is gone.

Same behavior reproduces with images instead of videos. Same behavior
reproduces with any sort mode (date-added, name, etc.) — but with
non-random sorts the reshuffle is invisible because re-issuing the same
sorted query produces the same order. The "exit SlideMode" half is
visible regardless of sort mode.

---

## Root Cause Analysis

**Category:** architectural-shortcoming

The destructive-mutation code path is missing an "edit in place" mode. It
unconditionally refetches the entire gallery from the backend after any
delete, which (a) re-queries `ORDER BY RANDOM()` and reshuffles, and (b)
calls a content-mode setter that unconditionally disables SlideMode. The
problem is structural, not a single off-by-one bug.

### Diagnosis

There are two cooperating defects that together produce the user-visible
bug. Both live in `FileStore.deleteFiles` and the helpers it calls.

#### Defect 1 — `deleteFiles` refetches the entire gallery

`src/frontend/stores/FileStore.ts:670-691`:

```ts
@action async deleteFiles(files: ClientFile[]): Promise<void> {
  if (files.length === 0) {
    return;
  }

  try {
    // Remove from backend
    await this.backend.removeFiles(files.map((f) => f.id));

    // Remove files from stores
    for (const file of files) {
      file.dispose();
      this.rootStore.uiStore.deselectFile(file);
      this.removeThumbnail(file.absolutePath);
    }
    this.fileListLastModified = new Date();
    return this.refetch();          // <-- HERE
  } catch (err) {
    console.error('Could not remove files', err);
  }
}
```

Note line 687: `return this.refetch()`. The fileList is NOT actually
mutated in this function — the loop disposes the `ClientFile` instances
and deselects them from `uiStore.fileSelection`, but it does NOT splice
the entries out of `this.fileList`. The post-delete fileList state is
"contains stale disposed entries." The author then leans on `refetch()`
to fix it by re-querying the backend and replacing the entire list.

`refetch()` (line 708-746) dispatches to whichever fetcher matches the
current `content` mode (`fetchAllFiles`, `fetchFilesByQuery`, etc.). Each
of those fetchers (e.g. `fetchAllFiles` at 748-764) calls
`backend.fetchFiles(this.orderBy, this.orderDirection)`. When
`this.orderBy === 'random'` (the new default per INV-011), the SQLite
backend (`sqlite-backend.ts:466-470`) issues:

```sql
SELECT ... ORDER BY RANDOM()
```

and the Dexie backend (`backend.ts:144-145`) calls `shuffleArray(...)`.
Both produce a freshly-shuffled list. `updateFromBackend` then clears
`fileList` and replaces it with the new list (line 1121-1122):

```ts
this.fileList.clear();
this.fileList.push(...newClientFiles);
```

So every delete re-shuffles the gallery from scratch. This is **not** a
bug in `ORDER BY RANDOM()` or `shuffleArray` — those are correct under
INV-011's "random reshuffles on every fetch by design" decision. The
mistake is using a full refetch as the way to handle a single-row
deletion, when an in-place splice would be both faster AND would
preserve the order the user is browsing.

The reason the author wrote it this way is plausibly that an in-place
splice would have required additional bookkeeping (rebuild `index`, fix
`firstItem`, update counts) and `refetch()` was the convenient
sledgehammer. Pre-INV-011, when the default sort was `dateAdded` desc,
the sledgehammer was invisible: re-running the same sorted query
produced the same order minus the deleted row, so the user never noticed
the round-trip. Random as the new default surfaces what was always a
latent reshuffle.

#### Defect 2 — every fetcher unconditionally disables SlideMode

`src/frontend/stores/FileStore.ts:603-629`:

```ts
@action.bound setContentAll(): void {
  this.content = Content.All;
  if (this.rootStore.uiStore.isSlideMode) {
    this.rootStore.uiStore.disableSlideMode();
  }
}
```

Identical pattern in `setContentUntagged`, `setContentQuery`,
`setContentDuplicates`. Each fetcher's first synchronous step (after
INV-007's content-flip-before-await sequencing) calls one of these
setters. The intent is documented at `RootStore.ts:136-140`:

```ts
// If slide mode was recovered from previous session, it's disabled by setContentQuery :/
// hacky workaround
if (isSlideMode) {
  rootStore.uiStore.enableSlideMode();
}
```

The comment "hacky workaround" identifies this as a known smell. The
intent of the `disableSlideMode()` calls is to handle the case where the
user clicks an Outliner item (e.g. switches from "All Images" to
"Untagged"); switching content modes mid-SlideMode would leave the
slide pane open on a file that may not exist in the new list, which is
nonsensical. So the setter clears SlideMode as a defensive close.

The problem is that `refetch()` from inside `deleteFiles` also routes
through `setContentAll` (when called from "All Images" mode) — re-flipping
content from All → All. The synchronous body of `setContentAll` doesn't
care that the content mode didn't actually change; it just sees
`isSlideMode === true` and calls `disableSlideMode()`. That is the line
that kicks the user out of the video viewer.

The two defects compound:

1. Defect 2 closes SlideMode synchronously.
2. The user is now in the thumbnail grid.
3. Defect 1's async fetch returns with a freshly-shuffled list.
4. `updateFromBackend` replaces fileList → the grid reshuffles before
   the user's eyes.

Both visible symptoms come from a single architectural mistake: the
delete path treats the in-memory `fileList` as derivable cache and
re-derives it from the backend on every mutation, instead of treating
`fileList` as the source of truth and mutating it in place.

The same store DOES have an in-place mutation pattern that proves it
can be done correctly: `replaceMovedFile` at line 649-667 splices a
single entry, updates the index, and never refetches. That is the
template `deleteFiles` should follow.

### Diagnostic Questions Considered

- **Wrong mental model?** Partial. The author of `deleteFiles` assumed
  refetch-after-mutate was a safe convention because, under the
  historical `dateAdded` default sort, it was invisible. They did not
  consider what a random-default would do to the user's visible order.
  But the deeper issue is architectural, not a single misunderstanding.

- **Architectural shortcoming?** **Yes — primary cause.** The store
  lacks a "remove these rows in place, update derived state" primitive
  for destructive mutations. `replaceMovedFile` shows how to do it for
  moves; the analogous code for deletes was never written. As a
  consequence every delete site (gallery selection, hover-then-delete,
  SlideMode delete, DnD overwrite, sublocation removal, broken-file
  cleanup) goes through the same refetch sledgehammer.

- **Incorrect order of operations?** Yes, as a consequence of the
  above. The correct order for a destructive mutation is (1) splice
  fileList in place, (2) reconcile firstItem to point at a sensible
  neighbor (auto-advance), (3) close SlideMode only if the list is now
  empty. The current order is (1) async refetch (which is itself a
  composite of "flip content, await, replace list"), (2) close
  SlideMode as a side-effect of flipping content, (3) replace list
  with a re-shuffled copy.

- **Missing edge case?** No — every delete path hits this; it is the
  default behavior, not an edge.

- **Wrong abstraction?** Mild. `refetch()` legitimately exists because
  some mutations DO require a re-query (tag added that the search
  criteria intersects, location added, location's path changed,
  search query changed, content mode switched). The abstraction
  problem is that `deleteFiles` was wired to the wrong primitive —
  it should call a new in-place splice helper, not `refetch()`.

- **Silent failure?** No. The reshuffle is visible. The
  exit-from-SlideMode is visible. The user reported both.

---

## Blast Radius

Numbered by source of the same root-cause refetch:

1. **`FileStore.deleteFiles` (the reported scenario).** Called from
   `RemovalAlert.MoveFilesToTrashBin.handleConfirm` (delete dialog
   from gallery and from SlideMode), from
   `RemovalAlert.FileRemoval.handleConfirm` (missing-file bulk
   cleanup), from `useFileDnD.handleMove` (overwrite-replace path —
   `deleteFiles([dstFile])` before the move), and from `Tag.delete`
   indirectly. All inherit the reshuffle and the SlideMode exit. The
   user's reported video-viewer scenario is the most visible
   manifestation but the bug also applies to: bulk delete from the
   gallery while in SlideMode on a randomly-sorted view, deleting an
   image in SlideMode, deleting from the gallery without SlideMode
   (the reshuffle still happens — the user just doesn't notice the
   SlideMode part).

2. **`FileStore.deleteFilesByExtension` (Settings → Image Formats →
   uncheck extension).** Does NOT call `refetch()` itself (line
   693-706), but the calling site might. Need to verify. If the
   calling Settings flow refetches, same reshuffle. Lower priority
   because the trigger is deliberate user action in Settings, not
   the everyday delete flow.

3. **`LocationStore.removeSublocationFiles` (line 554-563).**
   Removes all files under a sub-location from backend, then calls
   `fileStore.refetch()`. Same reshuffle.

4. **`LocationStore.removeFile` (line 537-543).** Marks a file as
   broken (`hideFile`) then `debouncedRefetch()` 200 ms later. With
   the new debouncedRefetch debounce, multiple file-watcher
   removal events coalesce into a single refetch — still a reshuffle.

5. **`useFileDnD.handleMove` setTimeout refetch (line 167:
   `setTimeout(() => fileStore.refetch(), 500)`).** After a drag-and-
   drop move, a delayed refetch picks up the file watcher's
   detection of the new path. Same reshuffle on random.

6. **Chokidar location-watcher new-files refetch
   (`RootStore.ts:144-148`).** When `watchLocations()` reports
   foundNewFiles after startup, `refetch()` is called. This is the
   one INV-011 explicitly accepted as "reshuffles by design on
   startup." Not addressed here — but worth flagging that any
   subsequent file-watcher events (a folder gets a new file
   dropped in mid-session) also call `debouncedRefetch()` via
   `LocationStore.fileCreated` and produce the same reshuffle.
   **This is a separate UX decision** — out of scope unless the
   user wants to address it too.

7. **`TagStore` refetch sites (`tagStore.ts:125, 184, 208, 231`).**
   On tag operations that may change which files match the current
   query (delete a tag, merge tags), `fileStore.refetch()` is
   called. These are legitimate — the visible set may genuinely
   need to change. Not addressed by this investigation.

8. **`Searchbar` refetch (line 109, 149) and `Settings/Appearance.tsx`
   line 78.** User-triggered re-query — legitimate refetch. Not
   addressed.

9. **SlideMode exit gate (`LayoutSwitcher.tsx:193`).** Renders
   `<SlideMode>` only when `uiStore.firstFileInView` is truthy.
   Once the deleted file is removed from fileList and `firstItem`
   is left at an out-of-range index, `firstFileInView` returns
   `undefined`, and SlideMode unmounts via this gate — independent
   of the `disableSlideMode()` call from `setContentAll`. So even
   if we fix Defect 2 in isolation, we still need to update
   `firstItem` to a valid index after the splice or SlideMode will
   self-close.

10. **Preview window (`src/frontend/Preview.tsx`).** Secondary
    window — Toolbar Next/Prev buttons drive `firstItem`. Same
    SlideMode is rendered. Delete in the preview window goes
    through the same path. Same root cause; same fix applies
    transparently because the fix is in the store, not in the
    component.

Items 1, 9, 10 are addressed by this investigation. Item 3, 4, 5 are
addressed as side benefits since the fix is in `deleteFiles` (a
shared helper) and in a new in-place splice primitive that
`removeSublocationFiles` will adopt as well. Items 2, 6, 7, 8 are
flagged for awareness but kept out of scope — they are either
legitimate refetches (7, 8) or separate UX decisions previously
accepted (6) or low-priority (2).

---

## UX / Requirements Specification

### Purpose

Preserve the user's browsing context (current SlideMode position AND
the visible order of the gallery) across destructive file operations.
The user should be able to delete a file from the video viewer without
losing their place in the gallery and without re-randomizing the
visible order.

### User-Stated Design Decisions

1. **"Auto-advance to the next video if possible."** — The video
   viewer must continue showing the next file at the same logical
   position after the delete, not close. Verified against the code:
   `firstItem` already drives which file SlideMode shows, and
   adjusting `firstItem` to the next index after an in-place splice
   is a one-line change in the store. SlideMode's existing
   `incrImgIndex`/`decrImgIndex` handlers prove the pattern is
   already supported by the surrounding components.

2. **"Remove the deleted video from the index, but not re-randomize."**
   — The fix is "splice in place, do not refetch from backend." This
   is the architectural change. The in-memory `fileList` becomes the
   source of truth for the visible order; backend re-queries on
   destructive actions are eliminated.

3. **"If the deleted video is the last one in the index, return the
   user back to the index — but again, do not re-randomize."** —
   Means: when splicing leaves `fileList.length === 0`, close
   SlideMode (so the user sees the now-empty thumbnail grid). When
   splicing leaves the list non-empty but the deleted file was at
   the tail (`firstItem >= fileList.length` after splice), move
   `firstItem` to the new tail (`fileList.length - 1`) so the user
   sees the previous file in SlideMode. Only close SlideMode when
   the list is genuinely empty.

4. **Reshuffle-on-other-events behavior is unchanged.** — The
   INV-011 acceptance "random reshuffles on every fetch by design"
   stays for app launch, location-watcher post-startup, user-
   initiated sort flip / order direction toggle, content mode
   switch, tag-edit refetch, search criteria change. The fix is
   narrow: destructive single/bulk file mutation does not refetch.

5. **Behavior is the same for images and videos.** — User reported
   the symptom from the video viewer but it applies to all file
   types. No video-specific code paths needed; the fix lives in the
   store, which is content-type-agnostic.

### Behavioral Specifications

**Single-file delete from SlideMode (the reported scenario):**

- Before: `fileList = [A, B, C, D, E]`, `firstItem = 2`, file at
  `firstItem` is `C`, SlideMode shows `C`, `orderBy = 'random'`.
- User confirms delete of `C`.
- After: `fileList = [A, B, D, E]`, `firstItem = 2`, file at
  `firstItem` is `D`, SlideMode shows `D`, order of `A, B, D, E` is
  unchanged from before (preserved random shuffle).

**Delete of the tail file from SlideMode:**

- Before: `fileList = [A, B, C, D, E]`, `firstItem = 4`, file at
  `firstItem` is `E`, SlideMode shows `E`.
- User confirms delete of `E`.
- After: `fileList = [A, B, C, D]`, `firstItem = 3` (was 4, clamped
  to new last index), file at `firstItem` is `D`, SlideMode shows
  `D`. SlideMode stays open. Order preserved.

**Delete that empties the list (or deletes the only file):**

- Before: `fileList = [A]`, `firstItem = 0`, SlideMode shows `A`.
- User confirms delete of `A`.
- After: `fileList = []`, `firstItem = 0` (but no file at index 0).
  `uiStore.firstFileInView` returns `undefined`. SlideMode unmounts
  via `LayoutSwitcher.tsx:193` gate. The user sees the empty
  thumbnail grid. No reshuffle (there is nothing to shuffle).
- Optionally also set `uiStore.isSlideMode = false` so re-adding a
  file later does not auto-open SlideMode. (Existing
  `disableSlideMode()` is the right call here.)

**Bulk delete from SlideMode (multi-selection):**

- Before: `fileList = [A, B, C, D, E]`, `firstItem = 2`, file at
  `firstItem` is `C`, SlideMode shows `C`, selection = `{B, C, D}`.
- User confirms delete of all three.
- After: `fileList = [A, E]`, `firstItem` chosen as follows:
  * The "currently-viewed file" (`C`) is in the deleted set. Find
    the smallest index `i` in the OLD list such that
    `oldList[i] >= firstItem AND oldList[i] not in deletedSet`. In
    this example, no such file exists at or after index 2, so fall
    back to the largest index `i' < firstItem` such that
    `oldList[i'] not in deletedSet`. That is `A` (old index 0). New
    `firstItem = 0` in the new list. SlideMode shows `A`.
  * If neither rule finds a survivor, fileList is empty — same as
    the "empty list" case above.

**Bulk delete from the thumbnail grid (no SlideMode):**

- Splice happens identically. `firstItem` reconciliation is
  unnecessary (the grid does not key off `firstItem` for content
  rendering, only for scroll). VirtualizedRenderer's scroll-to-
  firstItem effect (line 137) will keep scroll near the same
  region. No reshuffle. Selection becomes empty (deletes always
  consume the selection).

**Delete from gallery while in SlideMode (bulk selection includes
the currently-viewed file):**

- Same as "Bulk delete from SlideMode" above.

**Delete from gallery while in SlideMode (bulk selection does NOT
include the currently-viewed file):**

- Splice happens. `firstItem` is reconciled to the new index of the
  same currently-viewed file. SlideMode continues showing the same
  file.

**Non-random sort modes:**

- Same in-place splice. No visible difference from "the old refetch
  produced the same order minus the deleted row," but now the
  splice is also faster (no backend round-trip).

### Explicit Rejections

- **Do not re-shuffle on delete under random sort.** This is the
  whole point of the request.

- **Do not introduce a per-session stable-shuffle ("seeded random")
  feature.** INV-011 explicitly rejected this as out of scope. The
  fix here is independent: it preserves whatever shuffle is
  currently in `fileList`, without taking a position on whether
  app-launch reshuffles should also be stabilized. (Those remain
  per INV-011's accepted UX.)

- **Do not change `setContentAll` / `setContentUntagged` /
  `setContentQuery` / `setContentDuplicates` to stop calling
  `disableSlideMode()` unconditionally.** Those setters are also
  called when the user genuinely switches content mode (clicks
  Outliner → Untagged) and the SlideMode-close is correct there.
  Instead, the fix is to make `deleteFiles` not call `refetch()`
  at all, so it never routes through those setters. (A future
  refactor could split "set content mode" from "fetch under
  current content mode" but that is a larger change out of
  scope.)

- **Do not modify the backend's `ORDER BY RANDOM()` behavior.**
  The backend is correct. The fix is entirely renderer-side.

- **Do not block on a video-specific code path.** The fix lives in
  the store and is content-type-agnostic.

- **Do not introduce a "soft undo" / "trash queue" feature.** Out
  of scope. The trash IPC + system Recycle Bin is the existing
  undo path. The fix is purely about preserving browsing context.

---

## Holistic Solution

### Approach

Three focused tasks. The architectural shift is one new helper on
`FileStore` and one rewrite of `deleteFiles`; the rest is a small
QA-with-evidence sweep.

1. **Add `FileStore.removeFilesFromListInPlace(files: ClientFile[])`
   helper (TASK-063).** A new `@action` that splices the provided
   files out of `this.fileList` (using `fileList.remove(file)` or a
   bulk filter for performance with large selections), updates the
   `index` map, decrements `numTotalFiles` / `numUntaggedFiles` /
   `numMissingFiles` based on the removed entries, calls
   `cleanFileSelection()`, and reconciles `uiStore.firstItem` per
   the auto-advance rules in the Behavioral Specifications above.
   This is the destructive analogue of `replaceMovedFile`.

2. **Rewrite `FileStore.deleteFiles` to call the new helper instead
   of `refetch()` (TASK-063 — same task, single coherent change).**
   After awaiting `backend.removeFiles(...)`, dispose each file,
   remove its thumbnail, call `removeFilesFromListInPlace(files)`.
   No `refetch()`. Also wire `LocationStore.removeSublocationFiles`
   to use the same helper for consistency.

3. **Add explicit auto-advance logic for SlideMode (TASK-063,
   inside `removeFilesFromListInPlace`).** Reconcile `firstItem`
   under these rules:
   * Compute the deleted-id set up front.
   * If `uiStore.isSlideMode` is true and the file currently at
     `firstItem` in the OLD list is in the deleted set:
     - Scan forward from `firstItem + 1` in the OLD list for the
       first non-deleted file. If found, set `firstItem` to that
       file's NEW index (via `getIndex` after the splice).
     - If not found, scan backward from `firstItem - 1` in the OLD
       list for the first non-deleted file. If found, set
       `firstItem` to that file's NEW index.
     - If neither is found, fileList is now empty; leave
       `firstItem` at 0 (the LayoutSwitcher gate will unmount
       SlideMode, and `disableSlideMode()` should be called).
   * If `uiStore.isSlideMode` is true and the file currently at
     `firstItem` was NOT deleted, recompute `firstItem` to the
     NEW index of that same file (since the splice may have
     shifted it).
   * If `uiStore.isSlideMode` is false, no `firstItem`
     reconciliation needed beyond clamping to valid range (the
     grid's scroll restore handles it).

4. **Do not change `setContentAll` / `setContentUntagged` etc.**
   Their `disableSlideMode()` call remains correct for genuine
   content-mode switches. Since `deleteFiles` will no longer call
   `refetch()`, the path that incorrectly closes SlideMode on
   delete is severed at the source.

5. **Manual QA matrix (TASK-064).** Verify the auto-advance and
   no-reshuffle behavior across: SlideMode video delete, SlideMode
   image delete, SlideMode tail delete, SlideMode single-file
   delete (empty result), bulk delete from gallery without
   SlideMode, bulk delete from gallery WITH SlideMode (deleted set
   includes vs. excludes the currently-viewed file). All under
   `orderBy = 'random'`. Plus regression: same matrix under
   `orderBy = 'dateAdded'` to confirm no behavioral regression for
   deterministic sorts.

6. **Update docs (TASK-065).** Add a short note to a relevant
   docs file (likely `docs/personal-fork-notes.md` or a new
   `docs/file-store-mutation-model.md`) documenting the
   "destructive mutations splice in place; user-initiated and
   semantically-relevant changes refetch" rule, so future
   contributors know which primitive to reach for. Cross-
   reference INV-011's "reshuffle on every fetch is intentional"
   so the two decisions are linked.

### Expected Outcomes

- Reported scenario fixed: deleting a video from SlideMode under
  random sort advances to the next file and preserves the gallery
  order.
- Same behavior for image deletes, multi-file deletes, and any
  caller of `fileStore.deleteFiles`.
- `LocationStore.removeSublocationFiles` (and any other site that
  switches to the new helper) also stops reshuffling on
  destructive action.
- Performance side-benefit: a delete is now O(n) splice in
  renderer state instead of "await backend round-trip + clear +
  push n entries + re-dispose all entries". Imperceptible for
  small libraries, noticeable for large ones (the user's 57k-
  file library mentioned in `FileStore.ts:1119` comment).
- INV-011's other reshuffle triggers (app launch, location-
  watcher new files, sort change, content switch) continue to
  reshuffle. They are decoupled from delete.
- No regression in image delete, in deterministic sorts, in
  selection cleanup, in counts, or in SlideMode keyboard
  navigation.

### Risks and Tradeoffs

- **Counts may drift if `removeFilesFromListInPlace` doesn't
  fully replicate what `updateFileListState` does.** Mitigation:
  reuse `updateFileListState()` as the final step of the splice,
  since it already rebuilds `index`, `numUntaggedFiles`, and
  `numMissingFiles` from the current `fileList`. The only
  manual step is reconciling `firstItem` BEFORE calling
  `updateFileListState`. `numTotalFiles` in "All" mode needs a
  specific decrement; mirror what `deleteFiles` would have seen
  after refetch (`numTotalFiles -= files.length`).

- **`hideMissingFilesInBrowsing` interaction.** If a deleted file
  was hidden (broken), the existing refetch path would have just
  shown a smaller fileList. The new splice path needs to handle
  "the deleted file might already not be in fileList because it
  was filtered out as broken." Mitigation: in the splice helper,
  filter the `files` argument down to those actually present in
  `fileList` before splicing; the others affect only
  `numMissingFiles` (decrement directly).

- **`fileSelection` cleanup.** `deleteFiles` currently calls
  `uiStore.deselectFile(file)` per file in the loop AND
  `cleanFileSelection()` is called inside `updateFromBackend`
  after the refetch. The new path must call
  `cleanFileSelection()` (or its inline equivalent) explicitly,
  since there is no refetch to do it.

- **`fileListLastModified` consumers.** Several places re-trigger
  effects when this Date changes (e.g. `Preview.tsx:35`'s
  fade-in disable, `MasonryRenderer`'s thumbnail re-layout
  trigger). The splice path must set `fileListLastModified = new
  Date()` so those effects still fire.

- **Backend `removeFiles` may fail mid-batch.** Currently
  `deleteFiles` awaits then runs cleanup unconditionally; if
  `removeFiles` rejects, the `catch` logs and the fileList
  remains untouched (a happy accident given the inconsistency
  between disk-trash success and store-removal). The new path
  preserves the same contract: only splice if
  `backend.removeFiles` resolves. The disk-trash partial-failure
  case (some files trashed, some not) is handled upstream in
  `RemovalAlert.MoveFilesToTrashBin.handleConfirm` which already
  passes only the trash-succeeded files to `deleteFiles`.

- **Coupling between `FileStore` and `uiStore.firstItem`.** The
  splice helper mutates `firstItem` on `uiStore` — a write into a
  different store. The codebase already does this in several
  places (e.g. `replaceMovedFile` does NOT touch firstItem, but
  `cleanFileSelection` reaches into `uiStore.fileSelection`).
  The cross-store write is idiomatic for this project. Worth a
  comment noting the cross-store boundary.

- **Possible alternative: pass a "reshuffle: false" option to
  `refetch()`.** Considered and rejected. It would require
  threading the option through the fetcher → backend layer or
  caching the last-fetched list, both of which are bigger
  changes than the in-place splice. It would also not address
  the SlideMode-exit half of the bug (which comes from
  `setContentAll`'s `disableSlideMode()`, not from the
  reshuffle).

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-065 will add a short subsection — likely to
      `docs/personal-fork-notes.md` (which already discusses the
      INV-011 default-flip and is the natural place for "behavior
      notes specific to this fork's UX direction") — documenting
      the "destructive mutations splice in place; user-initiated
      re-queries refetch" rule. Cross-references INV-011's
      reshuffle-on-fetch acceptance so the two decisions are
      consistent.
