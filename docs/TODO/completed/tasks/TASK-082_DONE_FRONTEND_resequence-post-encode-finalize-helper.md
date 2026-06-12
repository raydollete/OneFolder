---
id: TASK-082
title: 'Re-sequence the post-encode flow into a reusable FileStore.finalizeEncodedOutput helper (copy tags at the DB level BEFORE waiting/showing) and wire ImageTools.tsx to it; add a graceful fallback when the output is not visible in the active view'
investigation: INV-019
status: done
priority: high
blocked_by: [TASK-081]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/components/ImageTools.tsx'
---

## What

Introduce `FileStore.finalizeEncodedOutput(source: ClientFile, outputPath:
string): Promise<void>` that runs the corrected post-encode order: (1) copy
tags at the DB level via `copyTagsToOutputPath` (TASK-081); (2) refetch the
active view; (3) wait (bounded) for the now-tagged output to appear in
`fileList`; (4) select + enable slide mode; (5) on still-not-visible, degrade
gracefully (clear search / switch to all-content, re-resolve, or show an honest
toast) instead of claiming "not ingested." Replace the inline ordering in
`ImageTools.tsx handleReencode` with a call to this helper. This helper is the
single reusable post-encode entry point that INV-020 (Normalize Audio) will
also call.

## Why

The current order in `ImageTools.tsx` (`waitForIngestedFile` -> `copyTagsToFile`
-> select) requires the output to be in `fileList` *before* it is tagged, which
is impossible in a tag-filtered view (chicken-and-egg). The user's requirement:
tags must be transferred BEFORE attempting to show the file.

See [INV-019](../investigations/INV-019_HIGH_FRONTEND_post-encode-tag-copy-race-filtered-view.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/FileStore.ts`, add `@action.bound async
      finalizeEncodedOutput(source: ClientFile, outputPath: string):
      Promise<void>` near `copyTagsToOutputPath`.
- [x] 2. Step A — copy tags at the DB level:
      `const tagged = await this.copyTagsToOutputPath(source, outputPath);`
      (TASK-081). This runs regardless of the active view, so no tagging work is
      lost even if the file is never shown.
- [x] 3. Step B — make the now-tagged file appear in the active view: call
      `this.refetch()` (or `await` it via the public `refetch` at :855) so the
      active query re-runs and picks up the newly-tagged output. (Prefer the
      immediate `refetch()` over `debouncedRefetch()` here so the subsequent
      wait is not racing the 200 ms debounce unnecessarily.)
- [x] 4. Step C — wait for the output ClientFile:
      `let newFile: ClientFile | null = null; try { newFile = await
      this.waitForIngestedFile(outputPath, 10000); } catch { newFile = null; }`.
      Because tags are now copied, a tag filter will match it; the wait should
      succeed in the common case.
- [x] 5. Step D — on success: `this.rootStore.uiStore.selectFile(newFile, true);
      this.rootStore.uiStore.enableSlideMode();` Return.
- [x] 6. Step E — graceful fallback when `newFile === null` (output still not
      visible — e.g. "videos only" off and an extension/other criterion excludes
      it, or the row genuinely never ingested). Do NOT claim "outside a watched
      folder." Instead: attempt to clear the active search and switch to
      all-content (use the existing UiStore/FileStore API the rest of the app
      uses — e.g. `uiStore.clearSearchCriteriaList()` + `fileStore.fetchAllFiles`
      / whatever `refetch` resolves to for all-content; verify the actual method
      names), refetch, and retry `waitForIngestedFile` once more with a short
      timeout (~3 s). If it now appears, select + slide mode. If it still does
      not appear, show the honest toast from TASK-083 and return (lock release is
      the caller's `finally`). Keep this fallback behind a clear comment.
- [x] 7. In `src/frontend/components/ImageTools.tsx handleReencode`
      (:68-89), DELETE the inline `waitForIngestedFile` -> `copyTagsToFile` ->
      `selectFile`/`enableSlideMode` block and replace it with:
      `await fileStore.finalizeEncodedOutput(file, outputPath);` followed by
      `uiStore.openReEncodeDeleteOriginal(file);` (the delete-original prompt
      remains in the orchestration, AFTER finalize). Keep the existing
      `try/finally` that releases the lock and resets local state.
- [x] 8. Remove the now-dead `try/catch` toast at ImageTools.tsx:70-79 (the
      finalize helper owns that messaging now). Ensure no unused imports remain
      (`copyTagsToFile` may still be used elsewhere — verify before removing any
      shared symbol). `ClientFile` and `AppToaster` remain used; no imports removed.
- [x] 9. Verify `copyTagsToFile` (the old ClientFile-based method) is still
      referenced elsewhere; if `ImageTools.tsx` was its only caller, leave the
      method (it is a valid public API) but note it is no longer on the
      re-encode path. `ImageTools.tsx` was its only caller; method retained as public API.

## Done When

- [x] `FileStore.finalizeEncodedOutput(source, outputPath)` exists and runs the
      order: DB tag copy -> refetch -> wait -> select/slide -> graceful fallback.
- [x] `ImageTools.tsx handleReencode` calls `finalizeEncodedOutput` instead of
      the old inline ordering; the lock is still released in `finally`.
- [x] Re-encoding from a tag-filtered view tags the output and opens it (no
      "outside a watched folder" toast). (Functional verification deferred to
      TASK-084 QA.)
- [x] The fallback path never asserts the file was not ingested; it copies tags
      first and degrades to an honest message (TASK-083).
