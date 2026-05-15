---
id: TASK-065
title: 'Document FileStore mutation model: destructive splices in place, re-queries refetch'
investigation: INV-015
status: planned
priority: low
blocked_by: [TASK-063]
date_created: 2026-05-15
date_completed:
files:
  - docs/personal-fork-notes.md
---

## What

Add a short subsection to `docs/personal-fork-notes.md` (or another
suitable docs file if the maintainer prefers — `docs/README.md` and
`docs/index.md` are candidates) documenting the architectural rule that
INV-015 introduced:

- Destructive file mutations (delete, sub-location removal) splice
  `FileStore.fileList` in place; they do NOT call `refetch()`.
- User-initiated or semantically-meaningful changes (search criteria
  changed, tag added/deleted/merged, location added, content mode
  switched, sort flipped, app launch, location-watcher new-file
  discovery) call `refetch()` and intentionally produce a fresh
  shuffle when `orderBy === 'random'`.
- The two behaviors are intentional and complementary: deletes preserve
  the user's browsing context; semantic changes re-sample.

Cross-reference INV-011 (the random-sort-default investigation that
accepted "reshuffle on every fetch by design") so a future contributor
can see why these two decisions are consistent rather than
contradictory.

## Why

The fix in TASK-063 introduces a new primitive
(`FileStore.removeFilesFromListInPlace`) and a new convention ("don't
refetch on destructive mutation"). Without documentation, a future
contributor reading `deleteFiles` and seeing that it doesn't call
`refetch()` could "helpfully" add one back, re-introducing the bug.

The personal-fork-notes file is the right home because INV-011 (random
as the new default) is the upstream decision that made the reshuffle
visible — without random as the default, this convention would be
invisible and uninteresting. Pinning the note to the same doc as the
random-default decision keeps the rationale together.

See [INV-015](../investigations/INV-015_MEDIUM_FRONTEND_video-delete-exits-slidemode-and-reshuffles-random-sort.md).

## Implementation Steps

- [ ] 1. Read `docs/personal-fork-notes.md` to understand the existing
      tone and section structure. Identify where the new subsection
      best fits — likely near any existing UX/behavior notes,
      probably toward the end of the file.

- [ ] 2. Add a new subsection (heading level matching neighbors).
      Suggested title: "FileStore mutation model: in-place splice on
      destructive ops, refetch on semantic changes". Draft contents:
  - One paragraph stating the rule.
  - A short bulleted list:
    - "In-place splice (no refetch): `FileStore.deleteFiles`,
      `LocationStore.removeSublocationFiles` (and any future caller
      that removes specific known files)."
    - "Refetch (re-sample, may reshuffle under random):
      `FileStore.fetchAllFiles` / `fetchUntaggedFiles` /
      `fetchFilesByQuery` / `fetchDuplicatesFiles` /
      `fetchMissingFiles`, called by content-mode switches, tag
      operations, search criteria changes, location additions, sort
      flips, and chokidar's post-startup new-files discovery."
  - One sentence cross-referencing INV-011: "Random reshuffles on
    every refetch by design (INV-011); destructive splices preserve
    the visible order so the user's browsing context survives
    deletes."
  - One sentence cross-referencing INV-015: "The mutation primitive
    is `FileStore.removeFilesFromListInPlace` — model new destructive
    code paths on it, not on `refetch()`."

- [ ] 3. If `docs/personal-fork-notes.md` does not exist (the
      investigation referenced it as the docs site for the INV-011
      decision; verify), create the section heading and a brief
      preamble before adding the subsection. Defer to maintainer
      preference if a different docs file is more appropriate.

- [ ] 4. Submit alongside TASK-063 so the docs land in the same
      change as the code that motivates them.

## Done When

- [ ] `docs/personal-fork-notes.md` (or chosen alternative) has a
      new subsection documenting the FileStore mutation model.
- [ ] The subsection cross-references INV-011 and INV-015 by ID.
- [ ] The subsection names the new helper
      (`removeFilesFromListInPlace`) so a developer searching the
      docs can find it.
- [ ] The change is committed alongside TASK-063 (or merged into
      master in a separate doc commit referencing INV-015).
