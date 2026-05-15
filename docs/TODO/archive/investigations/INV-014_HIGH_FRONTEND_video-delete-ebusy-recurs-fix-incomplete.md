---
id: INV-014
title: 'Video delete EBUSY persists: prior fix wired the coordinator but never actually releases handles on Windows'
reported_bug: 'QA testing of the INV-008 fix: "The program is unable to delete a video, likely because some instance of it is still open in the video player." EBUSY behavior persists despite TASK-038..TASK-042 being marked DONE.'
date: 2026-05-04
status: active
prior_investigation: INV-008
supersedes: INV-008
tasks_spawned: [TASK-058, TASK-059, TASK-060, TASK-061, TASK-062]
root_cause_category: 'silent-failure'
affects:
  - Gallery <video> handle release (GalleryItem.Thumbnail)
  - SlideMode main <video> handle release (ZoomableImage)
  - SlideMode dimension-probe orphan <video> (newly identified)
  - DOM-fallback path matching on Windows (MediaReleaseCoordinator)
  - Trash/delete flow (MoveFilesToTrashBin, FileRemoval) — release is awaited correctly but releases nothing
  - Drag-and-drop move flow (useFileDnD.handleMove) — same: release awaited but releases nothing
  - QA process for high-priority bugs (TASK-042 was marked DONE without manual Windows verification)
---

## Bug Report

### Observed Behavior

After commit `6b81a515` ("Fix video delete") shipped the MediaReleaseCoordinator
and integrated it into RemovalAlert, useFileDnD, GalleryItem, and SlideMode, QA
on Windows still reproduces the original EBUSY behavior:

> "The program is unable to delete a video, likely because some instance of it
> is still open in the video player."

The user's report indicates the file handle remains held at the moment of
trash, exactly as before the fix. The toast and `EBUSY: resource busy or
locked, scandir <filepath>` console error are still produced.

The integration is visible in source — the `await mediaReleaseCoordinator.releasePaths(...)`
call exists in both `RemovalAlert.MoveFilesToTrashBin` (line 134) and
`useFileDnD.handleMove` (line 86), and `MediaReleaseCoordinator` has a working
`register` / `releasePaths` implementation with passing unit tests. But the
release is a no-op for the actual `<video>` element the user is hovering at
delete time.

### Expected Behavior

When the user confirms deletion of a previewed video on Windows, the
`<video>` element must release its OS file handle before
`shell.trashItem` is invoked, so that Windows does not return
`ERROR_SHARING_VIOLATION` (`EBUSY`). This is the same expected behavior as
INV-008 — the architectural approach is correct, only the implementation
needs the fixes documented below.

### Reproduction Context

**Deterministic on Windows.** Same conditions as INV-008:

- OS: Windows (any version; macOS/Linux open with `FILE_SHARE_DELETE` and
  do not exhibit this).
- `uiStore.galleryVideoPlaybackMode` set to `hover` (default) or `auto`.
- Any video extension OneFolder supports (`mp4`, `webm`, `ogg`).
- Trigger: hover a video thumbnail (or open it in SlideMode), then press
  Delete and confirm.

What is NEW relative to INV-008: the bug reproduces even though the
coordinator is fully wired and `await mediaReleaseCoordinator.releasePaths(paths)`
is called immediately before the trash IPC. This rules out the original
hypothesis ("there is no quiesce hook") — the hook is now there, but it is
silently a no-op for the most common case.

---

## Verification of Prior Assumptions

### What Held vs. What Failed (vs. INV-008)

**Held:**

- The diagnosis that Chromium opens video files without `FILE_SHARE_DELETE`
  on Windows is correct and remains the underlying OS behavior.
- The release sequence `pause(); removeAttribute('src'); load();` is the
  correct way to free the Chromium media-pipeline handle. The unit tests
  in `tests/media-release-coordinator.test.ts` verify this works on
  registered mock elements.
- The integration points were correctly chosen. `MoveFilesToTrashBin`,
  `FileRemoval`, and `useFileDnD.handleMove` all `await` the coordinator
  before the destructive operation. The `await` is real — not
  fire-and-forget.
- The main-process retry around `shell.trashItem` (TASK-041) is
  correctly implemented in `src/main.ts:697-728` and would help if the
  renderer DID release the handle but the media pipeline was still
  winding down. It does not help if the renderer never released anything.

**Failed:**

- The assumption that the explicit `register` calls in `GalleryItem.Thumbnail`
  and `SlideMode.ZoomableImage` would actually run when the `<video>`
  element mounts. They do not — see Root Cause #1 below.
- The assumption that the `document.querySelectorAll('video[src]')`
  DOM-fallback sweep in `MediaReleaseCoordinator.releasePaths` would catch
  the gallery `<video>` if explicit registration was missed. It does not
  on Windows — see Root Cause #2.
- The blast-radius enumeration of orphan `<video>` elements in SlideMode
  was incomplete. The dimension-probe `document.createElement('video')` at
  `SlideMode/index.tsx:328` was missed entirely — see Root Cause #3.
- The QA verification that the fix worked end-to-end. TASK-042 was
  marked DONE in the same commit that shipped the fix, without any of its
  manual Windows steps actually executed. The "Done When" boxes in
  `TASK-042` are predominantly unchecked in the source file. See
  Root Cause #4.

---

## Root Cause Analysis

**Category:** silent-failure (with three distinct silent-failure modes that
compound to fully nullify the prior fix)

### Diagnosis — Three Concrete Defects in the Shipped Implementation

#### Root Cause #1: Component-side registration `useEffect` dependency list misses the async-mount transition

`src/frontend/containers/ContentView/GalleryItem.tsx:193-199` (Thumbnail):

```ts
const thumbnailRef = useRef<HTMLVideoElement>(null);
const { mediaReleaseCoordinator } = useStore();
useEffect(() => {
  if (thumbnailRef.current === null || !isFileExtensionVideo(file.extension)) {
    return;
  }
  const unregister = mediaReleaseCoordinator.register(file.absolutePath, thumbnailRef.current);
  return unregister;
}, [thumbnailRef, file.absolutePath, file.extension, mediaReleaseCoordinator]);
```

The `<video ref={thumbnailRef}>` is rendered conditionally (line 246-259):

```ts
} else if (imageSource.tag === 'ready') {
  if ('ok' in imageSource.value) {
    ...
    if (isFileExtensionVideo(file.extension)) {
      ...
      return <video ref={thumbnailRef} {...videoProps} />;
    }
    ...
```

`imageSource` is the result of `usePromise(...)`. On first render its
`.tag === 'pending'` and the component returns a placeholder `<span>`.
`thumbnailRef.current` remains `null`. React commits this render and runs
effects. The registration effect runs, sees `thumbnailRef.current === null`,
and bails.

Eventually `imageSource` resolves to `'ready'`. Component re-renders. The
`<video>` element is created and React assigns `thumbnailRef.current = videoEl`.
**But the registration effect's dependency list contains only stable
values** (`thumbnailRef` is a stable ref object; `file.absolutePath`,
`file.extension`, and `mediaReleaseCoordinator` haven't changed since
mount). React's `Object.is`-based dep comparison concludes nothing
changed. The effect does NOT re-run. The video element is never registered.

The same defect exists in `src/frontend/containers/ContentView/SlideMode/index.tsx:387-394`
for `slideVideoRef`. Same conditional rendering (`image.tag === 'ready'`),
same dep list omission, same outcome: the SlideMode main `<video>` is
never registered.

This is silent-failure: no error is thrown, no warning is logged, the
unit tests don't exercise React, and the registration body is reachable
code that simply never executes for video elements that mount asynchronously.

#### Root Cause #2: DOM-fallback path comparison fails on Windows due to `path.normalize` adding a leading separator

`src/frontend/image/MediaReleaseCoordinator.ts` releasePaths step 2 (DOM
fallback) is the safety net the prior investigation relied on to catch
unregistered videos. On Windows it does not work:

When `<video src="file://C:\Users\foo\bar.mp4">` mounts, Chromium's URL
parser normalizes the URL during attribute resolution. The `el.src` IDL
attribute returns the **resolved URL**, which is
`file:///C:/Users/foo/bar.mp4` (triple slash, forward slashes). This is the
HTML/URL standard behavior — verified empirically against Node's URL
parser, which uses the same WHATWG URL algorithm Chromium uses:

```
> new URL('file://C:\\Users\\foo\\bar.mp4').href
'file:///C:/Users/foo/bar.mp4'
```

`decodeVideoSrcToPath` strips the `file://` prefix, leaving
`/C:/Users/foo/bar.mp4`. Then `normalizePath` calls
`path.normalize(...).toLowerCase()`. On Windows native node:

```
> require('path').normalize('/C:/Users/foo/bar.mp4')
'\\C:\\Users\\foo\\bar.mp4'   // i.e. "\C:\Users\foo\bar.mp4"
```

After `.toLowerCase()`: `\c:\users\foo\bar.mp4`.

The registry key derived from `f.absolutePath` (which is what the trash
flow passes in) is:

```
> require('path').normalize('C:\\Users\\foo\\bar.mp4')
'C:\\Users\\foo\\bar.mp4'   // i.e. "C:\Users\foo\bar.mp4"
```

After `.toLowerCase()`: `c:\users\foo\bar.mp4`.

`\c:\users\foo\bar.mp4` !== `c:\users\foo\bar.mp4`. The DOM-fallback
sweep iterates all `<video[src]>` elements, decodes them, normalizes them,
fails the `targetKeys.has(key)` check for every one of them, and
releases nothing.

The unit test `'matches paths case-insensitively'` registers `'C:\\Videos\\Clip.mp4'`
and queries `'C:/videos/clip.mp4'`. Both go through `normalizePath`
without the leading-separator pollution because neither has the leading
slash that comes from the file:// URL's host-empty form. The test does
NOT exercise the DOM-fallback codepath at all. So this defect was
invisible at unit-test time.

This is silent-failure (path comparison silently mismatches), and it
also overlaps with wrong-mental-model: the prior implementation assumed
`<video>.src` would round-trip cleanly through the same `encodeFilePath`/`decodeVideoSrcToPath`
pair the unit test exercised. In reality the browser performs an
intermediate URL normalization that the test never simulates.

#### Root Cause #3: SlideMode dimension-probe orphan `<video>` is never registered

`src/frontend/containers/ContentView/SlideMode/index.tsx:325-348` (inside
the `usePromise` that produces `image` for ZoomableImage):

```ts
let img;
if (isFileExtensionVideo(fileExtension)) {
  img = document.createElement('video');
  img.onloadedmetadata = function (this: any) {
    ...
    resolve({ src, dimension: createDimension(...) });
  };
  img.onerror = (error) => { ... resolve(...); };
  img.preload = 'metadata';
} else {
  img = new Image();
  ...
}
img.src = encodeFilePath(src);
```

This is an **orphan** `<video>` element (never attached to the DOM, never
passed to React) used purely to read intrinsic video dimensions before
the actual SlideMode `<video>` is rendered. Even with `preload =
'metadata'`, Chromium opens the file, reads the moov box / WebM cues /
Ogg headers, and holds an OS file handle for the duration. The element
is captured by the closure inside the Promise, and even after `resolve`
fires the element is referenced from V8's executor microtask scope until
GC runs. There is **no explicit teardown** (no `pause/removeAttribute('src')/load()`),
and there is **no registration with `mediaReleaseCoordinator`**.

The DOM-fallback sweep cannot find this element because it is never
attached to `document`. Even if it were, Root Cause #2 would prevent the
match.

The prior investigation (INV-008) called out the preload orphan
`<video>` elements (lines 132-189 in the autorun) but did not enumerate
this dimension-probe orphan as a separate handle-holder. The
implementation diligently fixed the preload orphans (track in
`preloadVideosRef`, register, explicit teardown on cleanup) but left the
dimension-probe orphans untouched.

This is missing-edge-case: the blast-radius scan was incomplete.

#### Root Cause #4: TASK-042 was marked DONE without manual Windows verification

`docs/TODO/pending_qa/tasks/TASK-042_DONE_FRONTEND_qa-video-delete-move-across-surfaces.md`:

- Steps 1-9 are all annotated `REQUIRES MANUAL EXECUTION ON WINDOWS` and
  the unicode-checkbox is `[ ]` (unchecked).
- Step 10 (the docs cross-reference) is the only checked item: `[x]`.
- Top-of-file `status: DONE`, `date_completed: 2026-05-03`.

The task was prematurely promoted to `pending_qa/` and the investigation
INV-008 was likewise promoted. The user's QA on 2026-05-04 is the first
real Windows verification, and it surfaced the regression.

This is a process failure that allowed Root Causes #1–#3 to ship. The
remediation is captured in TASK-062 (post-fix QA discipline).

### Diagnostic Questions Considered

- **Wrong mental model?** Partially — for Root Cause #2, the assumption
  that `<video>.src` would be the same string we set into the attribute
  is incorrect on Windows due to URL parsing. For Root Cause #1, the
  assumption that a `useEffect` with `[ref, ...]` deps fires when the ref
  changes target is incorrect — refs are mutable boxes, not React state.
- **Architectural shortcoming?** No — the architecture (coordinator +
  register/release + integration before IPC) is sound. The defects are
  all in the implementation, not the design.
- **Incorrect order of operations?** No — the `await` ordering in the
  callers is correct. The defects are upstream of that.
- **Missing edge case?** Yes — Root Cause #3 (the dimension-probe
  orphan) is a missed handle-holder.
- **Wrong abstraction?** No.
- **Silent failure?** **Yes — primary cause.** All three implementation
  defects fail silently: registration body never runs, fallback finds no
  matches, orphan video never released. No errors, no warnings, no
  failed assertions. This is exactly the kind of bug that requires
  end-to-end QA on the target OS to catch — which is precisely the QA
  step that was skipped (Root Cause #4).

---

## Blast Radius

The shipped fix has the same blast radius INV-008 enumerated, but in
nearly every entry the release is a no-op rather than an effective
release:

1. **Gallery hover-then-trash (the user-reported scenario)** — Root
   Causes #1 and #2 combined: the gallery `<video>` is never registered,
   and the DOM-fallback path-mismatches on Windows. Release does
   nothing. EBUSY persists.

2. **SlideMode main video → trash** — Root Cause #1 for `slideVideoRef`,
   plus Root Cause #2 for the DOM fallback. Same outcome: release does
   nothing.

3. **SlideMode preload orphans → trash** — These ARE correctly
   registered (the preload effect at lines 132-189 calls `register`
   immediately on creation). Path comparison goes through the registry,
   not the DOM fallback, so Root Cause #2 does not affect them. **This
   path actually works.** A user who previews a video as the
   next-after-current preload, but never displays it, then deletes it,
   should see the release succeed via this path. This is consistent
   with reports if any users see partial mitigation.

4. **SlideMode dimension-probe orphan → trash** — Root Cause #3:
   never registered, never released. If the user opens a video in
   SlideMode and immediately deletes it before the dimension-probe
   element has GC'd, EBUSY can occur even if Root Causes #1 and #2 are
   fixed.

5. **DnD move of a previewed video** — Same as #1 and #2. The
   `await mediaReleaseCoordinator.releasePaths([src, dst])` call in
   `useFileDnD.handleMove:86` releases nothing for gallery-rendered
   sources on Windows.

6. **Duplicate Gallery delete** — Uses the shared `Thumbnail` component,
   so Root Cause #1 applies. Plus Root Cause #2 on the fallback. Release
   does nothing.

7. **FileRemoval (broken/missing files)** — Less impactful in practice
   (the files are missing from disk), but the same release call
   (`RemovalAlert.tsx:100`) is also a no-op for the same two reasons.

8. **Main-process retry-after-EBUSY** — Operating exactly as designed
   (single 150ms retry). It cannot help when the renderer never freed
   the handle. It is now serving as a test instrument: each EBUSY the
   user sees corresponds to TWO failed `shell.trashItem` attempts on the
   main side. This is correct behavior given the upstream bug; no
   change needed in main.ts.

9. **Process / QA workflow** — TASK-042 demonstrates that "DONE" can be
   recorded without the verification it asserts. Any other `pending_qa/`
   investigation may have the same risk if its QA tasks contain
   `REQUIRES MANUAL EXECUTION` steps that were never executed. Out of
   scope for this investigation to audit, but called out in TASK-062 as
   a remediation task.

---

## UX / Requirements Specification

### Purpose

Restore the intent of INV-008: ensure that for every destructive file
operation against a video on Windows, the renderer reliably releases
every Chromium-held file handle on the target paths before the IPC
fires. The user must never see EBUSY for a previously-previewed video.

### User-Stated Design Decisions (from this conversation)

1. **"The prior diagnosis was right but a critical implementation step
   is missing."** — Rationale (explicit from the prompt): treat the
   prior diagnosis as a hypothesis falsified by QA, but be willing to
   conclude the architecture is correct and only the wiring is broken.
   This investigation takes that conclusion as primary: the
   architecture stays, the wiring is fixed.

2. **Address every newly-identified handle-holder, not just the
   originally-reported gallery one.** — Rationale (explicit from the
   prompt): the SlideMode main video, the dimension-probe orphan, and
   the path-comparison defect all need fixing in the same change so
   that QA verifies a coherent end-state.

3. **Do not introduce process-level workarounds (more aggressive
   main.ts retry, longer timeout).** — Rationale (implicit, consistent
   with INV-008's "Don't work around with a hard retry loop in main.ts
   alone" rejection): retries cannot succeed while the renderer keeps
   the handle. Fix the renderer.

4. **Preserve hover/auto preview UX.** — Rationale (carried forward
   from INV-008): the fix must not regress preview functionality.

5. **Add a real Windows-verifiable QA step that gates promotion to
   `pending_qa/`.** — Rationale (implicit from the procedural finding):
   TASK-042 demonstrated that an unverified DONE allowed the bug to
   persist into user QA. The remediated QA task must require evidence
   (screenshot/log) before being marked DONE.

### Behavioral Specifications

**Per-defect behavior:**

- **Registration timing (Root Cause #1):** the gallery and SlideMode
  registration must fire when the `<video>` element actually mounts in
  the DOM, not on initial component mount. Two acceptable approaches:
  (a) include the imageSource/image promise state (specifically `.tag`
  or a derived boolean) in the `useEffect` deps, so the effect re-runs
  when the video element is created; or (b) replace `useRef + useEffect`
  with a callback ref `(el) => { if (el) register(path, el); ... }` so
  the registration fires synchronously when React assigns the ref. Both
  approaches must also handle unregistration: option (a) returns the
  unregister from the effect's cleanup; option (b) stores the unregister
  function in a ref and calls it when the callback ref is next called
  with `null`.

- **Path normalization (Root Cause #2):** the DOM-fallback decoding
  pipeline must convert browser-resolved file URLs back to the same
  path form `f.absolutePath` uses. On Windows this means stripping a
  leading `/` before `path.normalize`, OR detecting `file:///<DRIVE>:/...`
  patterns and converting directly. The simplest correct fix:
  `decodeVideoSrcToPath` on Windows should strip exactly one leading
  `/` if the next character is a drive letter (regex
  `/^\/[A-Za-z]:/`). Add a unit test that registers a path under
  `C:\Videos\Foo.mp4`, simulates a real `<video>` element by creating
  one in jsdom, asserts that the DOM-fallback codepath finds and
  releases it. (The current test mocks the video element and never
  exercises `el.src` round-tripping through a real URL parser.)

- **Dimension-probe orphan (Root Cause #3):** the `usePromise` body in
  `SlideMode/index.tsx:325-348` must explicitly tear down the orphan
  `<video>` after dimensions are read OR registered with the coordinator.
  Cleanest: track the element on a ref captured in an outer
  `useEffect`, and on cleanup (or after `resolve`) call
  `pause(); removeAttribute('src'); load();`. Acceptable alternative:
  switch the dimension probe to `imageLoader.exifIO.getDimensions(src)`
  via ExifTool, which closes its handle synchronously after read. This
  is a larger refactor but eliminates the orphan entirely.

- **QA verification (Root Cause #4):** the repro-matrix QA task for the
  new fix must require evidence (a screenshot or a captured log line
  showing the release coordinator's registry size > 0 at delete time)
  before being marked DONE. The task title and acceptance criteria must
  make this explicit.

**Coordinator API (no behavior change required):**

- `register(absolutePath, el)` and `releasePaths(paths, options)` keep
  their existing signatures. The fix is in the callers (component
  registrations) and one decode function (Root Cause #2), not in the
  coordinator's contract.

### Explicit Rejections

- **Don't add a longer retry / heavier sleep in main.ts.** Same
  rationale as INV-008: it cannot help while the renderer never
  releases.
- **Don't disable hover preview, even temporarily.** Existing UX must
  be preserved.
- **Don't extend the coordinator API to "release everything that looks
  like a video."** Stay surgical: fix the registration, fix the path
  decode, fix the dimension-probe orphan. Each fix is small and
  testable.
- **Don't ship a fix that doesn't include a way to verify the
  registration actually fires at runtime** (e.g. a dev-only assertion
  or counter). The original fix shipped without runtime evidence and
  that is what allowed Root Causes #1 and #2 to go undetected.

---

## Holistic Solution

### Approach

Five focused tasks, ordered by dependency:

1. **Fix component registration timing (TASK-058).** Modify
   `GalleryItem.Thumbnail` and `SlideMode.ZoomableImage` so the
   `register` call actually fires when the `<video>` element mounts.
   Use a callback-ref pattern for both (cleanest, race-free): the ref
   callback registers on attach and unregisters on detach. Add a
   dev-only assertion (behind `IS_DEV`) that logs registry size > 0
   after a delete-flow `releasePaths` call so we have visible evidence
   of correct wiring.

2. **Fix DOM-fallback path decoding on Windows (TASK-059).** Update
   `MediaReleaseCoordinator.decodeVideoSrcToPath` (or
   `normalizePath`, depending on where the fix is cleanest) to strip
   the leading `/` that file:// URL parsing inserts on Windows. Add a
   unit test that uses jsdom (or a manual `URL` parse + jsdom setup)
   to verify the round-trip from `encodeFilePath` → real DOM
   `<video>.src` → `decodeVideoSrcToPath` → matched registry key works
   for a Windows path.

3. **Tear down the SlideMode dimension-probe orphan (TASK-060).**
   Modify the `usePromise` body in `SlideMode/index.tsx:325-348` to
   explicitly call `pause(); removeAttribute('src'); load();` on the
   orphan `<video>` after `resolve` fires (in both
   `onloadedmetadata` and `onerror` branches), AND register it with
   the coordinator at creation time so a delete that races the
   metadata read still wins. This is belt-and-suspenders for the
   probe element.

4. **Add a runtime-visible registration-count signal (part of TASK-058).**
   In dev builds, log when `releasePaths` is called: how many
   registry entries matched, how many DOM-fallback elements matched,
   and how many `emptied` events fired within the timeout. This is
   the "evidence" the original fix lacked. Strictly dev-only; do not
   ship this to users.

5. **Re-run the full Windows QA matrix with evidence requirements
   (TASK-061).** The repro matrix from TASK-042 is the right matrix.
   Re-execute every step on Windows. Record dev-console output of the
   new logging from step 4 as evidence. Only mark steps DONE when
   evidence is captured.

6. **Document the QA-discipline lesson (TASK-062).** Add a short note
   to `docs/TODO/_TEMPLATE.md` (or wherever QA-task conventions live)
   that "REQUIRES MANUAL EXECUTION" steps may not be marked
   `[x]` complete by anyone other than the human QA executor, and
   that promoting an investigation to `pending_qa/` requires at least
   one verification step to have produced concrete evidence.

### Expected Outcomes

- The user's reported scenario (hover a video, press Delete, confirm)
  trashes cleanly on Windows. No EBUSY toast.
- All seven entry points in the INV-008 blast radius (gallery delete,
  SlideMode delete, preload, DnD move, DnD overwrite, Duplicate
  Gallery, FileRemoval) succeed for video files.
- `mediaReleaseCoordinator.releasePaths` returns having actually
  released elements (verifiable in dev console).
- No regression to hover/auto preview, SlideMode playback, or image
  delete.
- The procedural fix prevents "marked DONE without verification"
  recurring on subsequent investigations.

### Risks and Tradeoffs

- **Callback-ref refactor in two components.** Low risk — the existing
  ref-and-effect pattern is being replaced with a more robust pattern.
  Existing pause/play effects continue to use `thumbnailRef` /
  `slideVideoRef` exactly as before; only the registration moves to
  the callback ref. Need to ensure both refs (callback + ref-object)
  point at the same element. Standard composed-ref pattern handles
  this — small helper function or `useCallback`-wrapped ref.

- **Path-decode fix is Windows-conditional.** The leading-slash strip
  must only apply on Windows. macOS/Linux file URLs decode to absolute
  paths starting with `/`, and `path.normalize('/Users/foo/bar.mp4')`
  on those platforms returns `/Users/foo/bar.mp4` (correct).
  Implementation must check `process.platform === 'win32'` or use a
  drive-letter regex (`/^\/[A-Za-z]:/`) which is naturally
  Windows-only.

- **Dimension-probe teardown must not break dimension reading.** The
  `pause/removeAttribute/load` sequence after `resolve` should be
  fine — the resolved value already contains the dimension. Need a
  guard to ensure `pause` etc. don't fire before `resolve` (use a
  flag or call them in a microtask after `resolve`).

- **Switching dimension probe to ExifTool is bigger work.** Out of
  scope for this fix; mention as future improvement.

- **Dev-only logging may leak to production builds if `IS_DEV` is
  misused.** Mitigation: use the existing `IS_DEV` constant from
  `common/process.ts` exactly as elsewhere in the codebase.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: `docs/TODO/_TEMPLATE.md` (or task template — TASK-062
      will determine the exact location) gets a short note about
      manual-QA-execution discipline. The post-fix `docs/thumbnail-generation.md`
      cross-reference from TASK-042 #10 already exists and remains
      correct.
