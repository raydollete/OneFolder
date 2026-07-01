## Why

When multiple assets are selected and the user types/clicks a tag in the toolbar tag editor, the editor treats "some selected files have this tag" identically to "all selected files have this tag" — both take the remove branch. So adding a tag that only some of the selection already carry strips it from everyone, instead of filling it in on the files that lack it. This is surprising and makes it impossible to "complete" a partial tag across a selection — the most common reason a user re-enters a tag.

## What Changes

- Change the multi-select tag toggle in the toolbar tag editor (`FileTagEditor.tsx`) from a binary present/absent toggle to a fill-then-remove model:
  - If **none** of the selected files have the tag → add it to all (unchanged).
  - If **some** (but not all) have it → **add** it to the files that don't, so all selected files end up tagged (previously: removed from all).
  - If **all** selected files already have it → remove it from all (unchanged).
- Drive this off a tri-state derived from the existing per-tag `counter` compared against the selection size (none / partial / all), rather than the current `count !== undefined` boolean.
- The single-file inspector tag editor and the explicit "×" remove button are unaffected (they are not "some vs all" toggles).

## Capabilities

### New Capabilities
- `multi-select-tagging`: How adding/removing a tag behaves when the action applies across a multi-asset selection in the toolbar tag editor — specifically the none/partial/all decision for whether an entered tag fills in or is removed.

### Modified Capabilities
<!-- None — openspec/specs/ has no existing spec for this behavior. -->

## Impact

- Code: `src/frontend/containers/AppToolbar/FileTagEditor.tsx` — the `toggleSelection` action and the per-tag `selected` derivation (the `MatchingTagsList` region). No DTO, IPC, backend, or metadata-schema changes.
- `ClientFile.addTag`/`removeTag` are already idempotent (add is a no-op when present, remove a no-op when absent), so the fill operation is safe to call across the whole selection without double-counting.
- Behavior change is renderer-only and requires manual GUI verification on Windows.
