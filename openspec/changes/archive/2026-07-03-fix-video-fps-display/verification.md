# Verification — fix-video-fps-display

Date: 2026-07-02
Tier: 2 (Type: bug; Root Cause: silent-failure)

## Verdict: PASS-WITH-FINDINGS

Mechanical lint (`radflow-lint fix-video-fps-display --tier-check`): **clean, exit 0**.
No structural violations; tier envelope matches the diff (1 source file + 1 test).

## Dimensions

- **Implemented: PASS.** Every checked box's `evidence:` line points at code that
  actually exists (verified against `git diff`):
  - 1.1 — `usePromise` import at `ImageInfo.tsx:8`; guarded read at `:102-108`; the
    old `videoFps` `useState` and its `.catch(() => setVideoFps(''))` effect block
    are removed (diff hunk `@@ -115,17 +138,6`).
  - 1.2 — `ok`→`formatFps` / `err`→`console.warn('[ImageInfo] frame-rate read failed', …)`
    at `ImageInfo.tsx:111-119`.
  - 1.3 — stale-guard provided by `usePromise` `isEffectRunning` (`hooks/usePromise.ts:21-45`).
  - 2.1 — `dimensions` reverted to `` `${file.width || '?'} x ${file.height || '?'}` `` at `:125`.
  - 2.2 — `frameRate?: string` (`:16`), `frameRate: 'Frame Rate'` after `dimensions` (`:24`), populate at `:126`.
  - 2.3 — render loop skips the row when `field === 'frameRate' && !value` (`:203-216`).
  No fabricated evidence found.

- **Reachable: PASS.** `ImageInfo` is the default export of
  `src/frontend/components/ImageInfo.tsx`, imported and rendered by the Inspector at
  `src/frontend/containers/Inspector/index.tsx:10,93` (`<ImageInfo file={first} />`).
  The `usePromise` read runs at component top level on every render; `frameRate`
  flows into `fileStats.frameRate` and the common-metadata render loop. Not orphaned.

- **Tested: PASS (automated) / manual gate pending.** New jsdom rendered-component
  suite `tests/image-info-frame-rate-dom.test.tsx` mounts the REAL `<ImageInfo>` and
  covers (a) row placement + `29.97 fps` formatting, (b) hidden for image /
  frame-rate-less video, (c) the stale-race (A→B, resolve B then stale A → shows
  `60 fps`, never `24`), (d) rejected read → no row + logged. Fresh run:
  `yarn jest tests/image-info-frame-rate-dom.test.tsx` → **4 passed**. Full suite
  earlier this session → **26 suites / 232 tests passed**. The real-Electron
  reliability confirmation (task 4.2, REQUIRES MANUAL EXECUTION) is not yet
  performed — see Finding 2.

- **Optimal: advisory.** Uses the repo's established guarded-read pattern
  (`usePromise`) and fail-loud convention. One advisory nit — see Finding 1.

## Findings

1. **(Optimal, advisory — non-blocking)** `console.warn` is called in the component
   render body (`ImageInfo.tsx:118`), not inside an effect. While a video's
   frame-rate read is in the `err` state, any unrelated re-render (toggling
   `isEditing` / `viewAllExifTool`, a parent re-render) re-runs the derivation block
   and logs the warning again — minor log spam and a render-side-effect smell.
   Suggested: move the warn into a `useEffect` keyed on the poll result (or dedupe).
   Appended as follow-up task 4.3.

2. **(Tested, advisory — non-blocking)** Task 4.2 (manual Windows/Electron GUI
   reliability pass against the real exiftool process) is still unchecked. The
   jsdom suite exercises the changed component surface but cannot reproduce a real
   `-stay_open` exiftool wedge; the definitive "no longer stuck until restart"
   confirmation — and the diagnostic capture that would validate/refute the
   wedged-process theory — depend on that manual run. Already tracked as unchecked
   task 4.2; no new task added.

## Live UI pass

n/a via playwright-cli. This is an Electron **desktop** renderer, not a browser
dev-server surface — the FPS behavior depends on the real exiftool `-stay_open`
process and a real video file, which is exactly the manual gate in task 4.2. The
changed surface (row placement, formatting, stale-race, error path) is exercised
end-to-end against the real mounted component by the jsdom rendered-component suite
above; the live Electron GUI pass remains task 4.2.

## Conclusion

No blocking condition (no missing implementation, no fabricated evidence, no tier
misclassification, no lint exit 2). Both findings are advisory. Archive may proceed;
recommended to complete the manual reliability pass (4.2) first, since it is the only
check that can confirm the reported "stuck until restart" symptom is actually gone.
