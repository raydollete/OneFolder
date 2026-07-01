## 1. Implement fill-then-remove toggle

- [x] 1.1 In `src/frontend/containers/AppToolbar/FileTagEditor.tsx`, derive `allHaveTag` per tag by comparing the existing `counter` value to `uiStore.fileSelection.size` (treat a missing/undefined count as 0), replacing the current `counter.get(tag) !== undefined` boolean.
- [x] 1.2 Pass `allHaveTag` as the `selected` flag to `TagOption`/`Row` so the checked indicator means "every selected file has this tag" (partial shows unchecked).
- [x] 1.3 Update `toggleSelection` so the entered tag is removed from the whole selection only when `allHaveTag` is true, and otherwise `addTag` is applied across the whole selection (relying on `ClientFile.addTag`/`removeTag` idempotency — no per-file membership filtering needed).
- [x] 1.4 Confirm the summary "×" remove control (`removeTag`) and the single-file inspector editor (`FileTag.tsx`) are untouched and still behave as before.

## 2. Verify

- [x] 2.1 Run `yarn lint` and `yarn build` (or `yarn dev` type-check) to confirm no TypeScript/ESLint regressions from the edit. (ESLint clean; `yarn build` exit 0.)
- [x] 2.1a Add automated jsdom regression test (`tests/file-tag-editor-multiselect-dom.test.tsx`) that drives the REAL `FileTagEditor` decision logic through none/partial/all/single-file cases. All 4 pass — the partial case asserts the fill (f2 gains the tag, f1 keeps it).
- [x] 2.2 WAIVED by user (2026-06-30) — manual GUI QA not executed. Logic covered by automated test 2.1a (none → adds to all). No in-app evidence captured.
- [x] 2.3 WAIVED by user (2026-06-30) — manual GUI QA not executed. Logic covered by automated test 2.1a (some → fills the rest, none lost). No in-app evidence captured.
- [x] 2.4 WAIVED by user (2026-06-30) — manual GUI QA not executed. Logic covered by automated test 2.1a (all → removed from all). No in-app evidence captured.
- [x] 2.5 WAIVED by user (2026-06-30) — manual GUI QA not executed. Summary "×" path unchanged; single-asset toggle covered by automated test 2.1a. No in-app evidence captured.
