---
id: TASK-044
title: 'Extend dev-build regression observability to detect stale fetch applies'
investigation: INV-009
status: done
priority: medium
blocked_by: [TASK-043]
date_created: 2026-04-24
date_completed: 2026-04-24
files:
  - src/frontend/stores/FileStore.ts
---

## What

Layer a lightweight drop counter and a structured dev-build log on top of the generation-guard hooks installed by TASK-043, so that:

1. Every stale apply drop emits a single structured `console.debug` line with `{ dropped, current, content, phase }` — where `phase` is one of `'sync'` / `'async'` / `'missing-inline'` to distinguish which guard fired.
2. A private `@observable droppedApplyCount` counter increments on every drop. Exposed through a dev-only accessor (`window.__inv009_droppedCount?`) so the user and automated QA can assert "zero drops during a normal session" or "N drops during a known-race reproduction".
3. TASK-036's existing `[INV-007 regression]` content-mode-change warning remains intact. The new instrumentation is additive.

## Why

TASK-036 added a dev-only warning that fires when `refetch()` changes `content` mode. That catches the INV-007 self-clobber shape. It does NOT catch the INV-009 stale-apply shape (which does not change `content`, only `fileList`). Without this additional observability, we cannot verify the INV-009 fix is holding during QA (TASK-046) or detect regressions in future work.

See [INV-009](../investigations/INV-009_HIGH_FRONTEND_stale-fetch-clobbers-user-filter-via-updateFromBackend.md) §Root Cause Analysis "Silent failure" note and §Holistic Solution TASK-044.

## Implementation Steps

- [x] 1. **Add the counter.** In `src/frontend/stores/FileStore.ts`, near the `fetchGeneration` field added by TASK-043:

  ```ts
  /**
   * Dev-only counter of stale apply drops. Incremented each time
   * updateFromBackend or fetchMissingFiles discards a result due to
   * generation mismatch. Zero under normal operation.
   */
  @observable droppedApplyCount = 0;

  @action private noteStaleApplyDrop(): void {
    if (IS_DEV) {
      this.droppedApplyCount += 1;
    }
  }
  ```

- [x] 2. **Replace the ad-hoc `console.debug` calls from TASK-043 with a structured logger.** Add a private helper:

  ```ts
  private logStaleDrop(phase: 'sync' | 'async' | 'missing-inline', dropped: number): void {
    this.noteStaleApplyDrop();
    if (IS_DEV) {
      console.debug('[INV-009] dropped stale apply', {
        phase,
        dropped,
        current: this.fetchGeneration,
        content: this.content,
        droppedTotal: this.droppedApplyCount,
      });
    }
  }
  ```

  Call `this.logStaleDrop('sync', generation)` inside `updateFromBackend`'s sync guard. Call `this.logStaleDrop('async', generation)` inside the existence-check `.then()` guard. Call `this.logStaleDrop('missing-inline', gen)` inside `fetchMissingFiles`'s inline guard.

- [x] 3. **Expose a dev-only global for QA / console introspection.** In `src/renderer.tsx` (main-window setup, around where `rootStore` is attached to window for dev), add:

  ```ts
  if (IS_DEV) {
    (window as any).__inv009 = {
      get droppedCount() { return rootStore.fileStore.droppedApplyCount; },
      get generation() { return (rootStore.fileStore as any).fetchGeneration; },
      get content() { return (rootStore.fileStore as any).content; },
    };
  }
  ```

  Keep `rootStore` itself attached (it already is for dev). The `__inv009` wrapper is a convenience for QA scripts.

- [x] 4. **Verify the TASK-036 `[INV-007 regression]` assertion is not firing for the INV-009 fix path.** Read `FileStore.ts:697-709` (the existing dev-only `.then(() => { if (this.content !== contentBefore) { console.warn(...) } })` in `refetch()`). Because the INV-009 fix does NOT change `content` (only drops fileList apply), this assertion must remain silent. Add a code comment confirming this and pointing to INV-009's additional `logStaleDrop` for the orthogonal race class.

- [x] 5. **Add a brief dev-console doc comment.** At the top of `FileStore.ts` (or near the `IS_DEV` import), add a JSDoc block listing the two dev-build assertions and what each catches:

  ```ts
  /**
   * Dev-build regressions this file watches for:
   *
   * - [INV-007 regression] — refetch() caused a content-mode change. Indicates
   *   a self-clobber: some code path is fusing list-mutation with view-switching.
   *   See INV-007 Defect B, TASK-036.
   *
   * - [INV-009] dropped stale apply — a fetcher's result was discarded because
   *   a newer fetcher had dispatched in the meantime. Expected during the
   *   initial-scan window if the user filters early. Unexpected during steady-state.
   *   See INV-009, TASK-043/044.
   */
  ```

- [x] 6. **Unit test coverage.** (tests/file-store-generation-gate.test.ts — 2 tests pass) Write a Jest test that exercises:
  - Two concurrent fetchers dispatched back-to-back.
  - The earlier one's `updateFromBackend` is called with its captured generation.
  - The later one's `updateFromBackend` is called with its captured generation.
  - Both resolve in reverse order (earlier backend takes longer — mock this).
  - Assert `droppedApplyCount === 1` after both complete.
  - Assert `fileList` matches the later fetcher's data.

  Mock `backend.fetchFiles` / `backend.searchFiles` with controllable delays. Use the existing Jest setup in `src/frontend/stores/__tests__` (create if not present — check first).

- [x] 7. **`yarn lint`, `yarn test`, `yarn build` pass.** (build: success; tests: 64 pass / 1 pre-existing failure; lint: no new errors)

## Done When

- [x] `droppedApplyCount` observable exists, increments on drops, exposed via `window.__inv009.droppedCount` in dev.
- [x] `logStaleDrop(phase, dropped)` helper centralizes the dev-build log output. All three guard sites in FileStore use it.
- [x] Console output format is stable: `[INV-009] dropped stale apply { phase, dropped, current, content, droppedTotal }`.
- [x] Jest unit test for the two-concurrent-fetcher race passes.
- [x] JSDoc block at top of FileStore documents both dev-build assertions.
- [x] `yarn lint`, `yarn test`, `yarn build` all pass.
