## Context

The toolbar tag editor (`src/frontend/containers/AppToolbar/FileTagEditor.tsx`) is the only place that assigns a tag across the whole `uiStore.fileSelection`. It already builds a per-tag `counter` (a `Map<ClientTag, number>`) that, for each tag, counts how many selected files carry it (lines ~51–61). Today the add-vs-remove decision is a plain boolean: `selected = counter.get(tag) !== undefined`, i.e. "at least one file has it." That boolean is passed to `toggleSelection`, whose remove branch then strips the tag from every file. The result is the reported bug: entering a partially-applied tag removes it from everyone instead of completing the assignment.

`ClientFile.addTag` (File.ts ~134) is a no-op when the file already has the tag, and `removeTag` (~152) is a no-op when it doesn't — so operating over the full selection is safe and idempotent. The single-file inspector editor (`FileTag.tsx`) and the summary "×" button are separate, single-purpose paths and are out of scope.

## Goals / Non-Goals

**Goals:**
- Entering a tag fills it into the selected files that lack it, and only removes it when all selected files already have it.
- Keep the change localized to `FileTagEditor.tsx`; reuse the existing `counter` and idempotent `ClientFile` methods.
- Preserve existing single-file behavior and the explicit "×" remove control.

**Non-Goals:**
- No change to `ClientFile.addTag`/`removeTag`, DTOs, IPC, backend, or metadata writing.
- No new "remove tag from selection" affordance beyond the existing "×" (the entry box no longer removes partial tags, but the "×" still removes).
- No change to the per-tag count shown in the summary list.

## Decisions

**Decision: Derive the toggle from `count === fileSelection.size` instead of `count !== undefined`.**
The tri-state (none / partial / all) collapses to a single boolean for the entry action: remove only when `count === uiStore.fileSelection.size` (all have it); otherwise add. So the change is to compute `const allHaveTag = count === uiStore.fileSelection.size` and branch `removeTag` when `allHaveTag`, else `addTag`, applied across the full selection.
- *Alternative considered:* iterate and only `addTag` the files missing the tag in the partial case. Rejected as unnecessary — `addTag` is already idempotent, so applying it to the whole selection has the same effect with simpler code.
- *Alternative considered:* make "partial" a no-op or a third UI state. Rejected — the user's intent when re-entering a tag is to complete the assignment, which the fill behavior delivers directly.

**Decision: Keep the `selected` indicator semantics aligned with "all have it."**
The `selected` flag passed to `TagOption`/`Row` drives both the visual checked state and the click branch. Setting it to `count === size` makes the checkmark mean "every selected file has this tag," which matches the new toggle and reads correctly: a partially-applied tag shows unchecked, signaling that entering it will fill rather than clear.

**Decision: Leave the summary "×" remove button as-is.**
It is the deliberate "clear from all" affordance and should keep working unconditionally, so users retain a one-click way to strip a tag from the whole selection.

## Risks / Trade-offs

- **[Behavior change may surprise users who relied on re-entry to clear a partial tag]** → That path was the bug; the "×" remove control still clears a tag from the whole selection, so the capability isn't lost, just moved to the explicit control.
- **[`fileSelection.size` of 0]** → The editor is only reachable with a non-empty selection; with size 0 the `counter` is empty and no tag rows render, so the comparison is never exercised. No guard needed, but verify during QA.
- **[Renderer-only, GUI-driven]** → Not covered by existing unit tests; requires manual verification across the none/partial/all cases on Windows.

## Migration Plan

Single-commit renderer change; no data migration. Rollback is reverting the `FileTagEditor.tsx` edit.
