---
id: TASK-045
title: 'Document the fetchGeneration invariant in missing-files.md and docs/index.md'
investigation: INV-009
status: done
priority: low
blocked_by: [TASK-043]
date_created: 2026-04-24
date_completed: 2026-04-24
files:
  - docs/missing-files.md
  - docs/index.md
---

## What

Add a new section to `docs/missing-files.md` documenting the two-pass + generation invariant that `updateFromBackend` now enforces (post-TASK-043). Add a one-line pointer in `docs/index.md` under the FileStore section. The goal: anyone modifying `updateFromBackend` or adding a new fetcher learns immediately that fetch results are generation-gated.

## Why

INV-009's root cause was a missing abstraction — the apply stage had no way to know whether a result was stale. After TASK-043, the abstraction exists but is undocumented, and a future contributor could add a new fetcher that bypasses the generation guard (the same way `fetchMissingFiles` bypassed `updateFromBackend` with its own inline apply). Docs make the invariant discoverable.

See [INV-009](../investigations/INV-009_HIGH_FRONTEND_stale-fetch-clobbers-user-filter-via-updateFromBackend.md) §Holistic Solution TASK-045 and §Risks and Tradeoffs.

## Implementation Steps

- [x] 1. **Read the current `docs/missing-files.md` to find the right insertion point.** The existing doc covers `hideMissingFilesInBrowsing`, the two-pass existence-check splice, and the `numTotalFiles` post-splice override. The new section belongs as a sibling of "Two-pass existence check" — something like "Fetch generation invariant" placed right after it.

- [x] 2. **Draft the new section.** Recommended structure:

  ```markdown
  ## Fetch Generation Invariant

  Every fetcher on `FileStore` (`fetchAllFiles`, `fetchUntaggedFiles`,
  `fetchMissingFiles`, `fetchFilesByQuery`, `fetchDuplicatesFiles`) must
  increment `FileStore.fetchGeneration` synchronously at dispatch — AFTER
  the `setContentX()` flip, BEFORE the `await backend.*`. The captured
  value is passed through to `updateFromBackend(results, generation)`,
  which discards the apply if the captured generation is no longer equal
  to the current `fetchGeneration`. The existence-check `.then()`
  second-pass also carries the same captured generation and guards a
  second time.

  This prevents a stale in-flight fetch from overwriting the user's
  `fileList` if they have since dispatched a newer fetcher. The primary
  trigger is the initial `fetchAllFiles` from `RootStore.main` on
  launch — it can take 5-30 seconds on a large library, during which
  the user may click into any Content mode. Without the generation
  guard, the stale result wins on resolution and the user's filter
  silently reverts to All.

  **Rule:** any new writer that mutates `fileList` from an async
  context must participate in the generation guard. Bypassing
  `updateFromBackend` (as `fetchMissingFiles` does with its inline
  `runInAction` apply) is permitted only if the new code path includes
  the same `if (gen !== this.fetchGeneration) return;` check.

  See INV-009 for the full analysis.
  ```

- [x] 3. **Update `docs/index.md`.** Add a one-line pointer in whatever section lists FileStore / architectural rules. Something like:

  ```markdown
  - **FileStore fetches are generation-gated** — stale results are
    silently dropped. See `missing-files.md` §Fetch Generation Invariant.
  ```

- [x] 4. **Cross-reference INV-007 and INV-009 in the doc.** In `missing-files.md`, both investigation IDs should appear inline in the new section (INV-009 for the race itself, INV-007 for the related criteria-list work).

- [x] 5. **Verify nothing else in `docs/` needs updating.** (metadata-refactoring.md mention is historical changelog, not stale) Grep `docs/` for "updateFromBackend" or "fetchAllFiles" mentions that would now be out of date. If any are found, update in the same change.

- [x] 6. **Verify the new section renders cleanly.** (markdown structure checked — heading levels consistent, no broken fences, INV links use relative paths matching the existing pattern) Open `docs/missing-files.md` in a Markdown preview (VS Code has one built in). Check table-of-contents headings, code-block fences, and link targets.

## Done When

- [x] `docs/missing-files.md` has a "Fetch generation invariant" section describing the rule and pointing to INV-009.
- [x] `docs/index.md` has a one-line pointer to the new section.
- [x] Any other doc references to `updateFromBackend` that would be misleading are updated.
- [x] Markdown preview renders without broken links or fence errors.
