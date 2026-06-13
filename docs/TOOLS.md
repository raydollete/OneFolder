---
title: Creating Inspector Tools
author: @rjdollete
last_updated: 2026-06-11
scope: architecture
---

# Creating Inspector Tools

A "tool" is a per-file action offered in the inspector **Tools** section
(`src/frontend/components/ImageTools.tsx`). This guide captures the
architecture and the hard-won lessons from building the first real tool,
**Re-encode (x264)** ([reencode-x264.md](reencode-x264.md), INV-018) — use that
feature as the worked example for everything described here.

The Tools section must contain **only functional tools**. Do not add disabled
placeholder buttons for future ideas; a list of dead stubs is misleading UI
(the four original placeholders were deleted for exactly this reason). When no
tool applies to the current file type, render the neutral caption
"No tools available for this file type." instead of an empty body.

---

## The Anatomy of a Tool

A simple tool (one that synchronously transforms in-memory state) only needs a
gated button with an `onClick`. But any tool that runs an external binary,
takes more than ~1 second, or mutates the watched filesystem needs the full
**media-job** stack, built in this order:

| Layer | Where | What it provides |
|---|---|---|
| 1. Binary bundling | `package.json` `build.win.extraResources`, `resources/<binary>/` | Ship the executable with the portable build |
| 2. Path resolution | `common/fs.ts` (`getExtraResourcePath` delegate) | Same path logic in dev and packaged modes |
| 3. Main-process job runner | `src/<Name>Manager.ts` (see `ReEncodeManager.ts`) | Spawn, progress parsing, job registry, cancel, cleanup |
| 4. IPC channels | `src/ipc/{messages,renderer,main}.ts` | invoke (start) + push stream (progress) + send (cancel) |
| 5. UI lock | `UiStore.beginMediaProcessing` / `endMediaProcessing` | Freeze nav/edit/delete while the job owns the file |
| 6. Post-encode finalization | `FileStore.finalizeEncodedOutput` | DB-level tag copy → refetch → wait → select/slide → graceful fallback |
| 7. Button + orchestration | `ImageTools.tsx` | Gating, spinner, cancel, the ordered happy path |
| 8. Follow-up prompt | `RemovalAlert.tsx` pattern | e.g. delete-original via the existing trash flow |

Layers 3–6 are **reusable** — a new tool that produces a sibling file should
need only layers 7–8 plus a new manager method (or a new manager if the binary
differs). Call `finalizeEncodedOutput` rather than re-implementing the post-encode
ordering inline; getting that order wrong is the main implementation hazard (see
rule 6 below and INV-019).

### The correct order of operations

Getting this order wrong is the main implementation hazard (INV-019):

1. Acquire the UI lock (`beginMediaProcessing`).
2. Compute a collision-free output path **in the main process**
   (`getUniqueSiblingPath` — never clobber an existing file).
3. Spawn the subprocess with progress streaming; show the spinner.
4. On success, call `FileStore.finalizeEncodedOutput(source, outputPath)`:
   - **a.** Copy DB tags onto the output at the backend level
     (`copyTagsToOutputPath`) — **before** waiting for `fileList`.
     This is mandatory: in a tag-filtered view the tag-less output never
     matches the filter and never enters `fileList`, so tagging MUST come first.
     `fileList` is a view model (the result of the active search query),
     NOT a complete index of known files.
   - **b.** Immediately refetch the active view so the now-tagged output can
     match the active filter and enter `fileList`.
   - **c.** Wait (bounded) for the output to appear in `fileList`
     (`waitForIngestedFile`). Now that it carries the source's tags, a
     tag-filtered view will accept it.
   - **d.** Select and open the output (`selectFile` + `enableSlideMode`).
   - **e.** Graceful fallback when the output is still not visible after the
     wait: clear the active search/filter (all-content) and retry once. Show
     an honest toast if still absent — never assert "outside a watched folder"
     (that is unverified; docs/TOOLS.md rule 4).
5. Show any follow-up prompt (e.g. delete original) — AFTER finalize returns.
6. Release the lock (`endMediaProcessing`) — in a `finally`, so it also
   releases on failure and cancel.

---

## Rules Learned the Hard Way

The first build of Re-encode (x264) compiled cleanly and passed the full test
suite while shipping **three runtime bugs**. Each one generalizes to a rule.

### 1. Never strict-compare paths across the main/renderer boundary

The folder watcher normalizes its chokidar watch root to forward slashes
(`folderWatcher.worker.ts`), so every ingested `ClientFile.absolutePath` is
forward-slash form even on Windows (`D:/Videos/clip.mp4`). The main process
uses Node's win32 `path.join`/`path.dirname`, which emit backslashes
(`D:\Videos\clip.mp4`).

A path computed in main will therefore **never** `===` a renderer
`absolutePath`. In the first build this made `waitForIngestedFile` time out on
every single encode and falsely report "outside a watched folder".

**Rule:** any comparison between a main-process-computed path and renderer
state must normalize separators *and* casing (Windows is case-insensitive) on
both sides first:

```typescript
const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
```

`waitForIngestedFile` does this internally now — go through it rather than
matching against `fileList` yourself.

### 2. Treat derived counters as stale; never let them abort an operation

`FileStore.numUntaggedFiles` is only rewritten by `updateFileListState()` when
the view shows *all* or *untagged* content — in any filtered view (search,
video filter, tag view) it is stale **by design**. The first build's tag-copy
step crashed with "Invalid Database State: Cannot have less than 0 untagged
files" because adding the first tag to the freshly-ingested output decremented
a counter that was legitimately sitting at a stale 0.

**Rule:** tools run from filtered views too. Code a tool touches must not
`throw` on derived-counter invariants that are only guaranteed in some views —
clamp and `console.warn` instead (`decrementNumUntaggedFiles` now does this).
More generally: a stale badge is recoverable; an aborted half-finished
operation is not.

### 3. Round and throttle progress at the edges

Raw progress math produces values like `37.43829…%`. Round to a whole percent
when storing it in React state (`Math.round`) — this is both what the user
expects and a free render optimization (state only changes when the integer
changes). On the main side, throttle progress emissions (the runner uses a
200 ms minimum gap) so the IPC channel isn't flooded.

### 4. Error messages must state what is known, not a guessed cause

The original timeout toast said "outside a watched folder" when the actual
cause was the path-comparison bug in rule 1 — the message asserted a diagnosis
the code had not verified, which sent debugging in the wrong direction. Prefer
wording that reports the observable fact and offers *possible* causes as
possibilities, not verdicts.

**Corrected example** (post-INV-019, as of TASK-083): since tags are now
copied at the DB level *before* the wait (TASK-082), the toast can also
confirm that tagging succeeded:

- Tagged path: *"Re-encoded to &lt;path&gt; and copied your tags, but it is not
  visible in the current view. It may be excluded by the active filter, or
  outside a watched folder."*
- Untagged / row-not-found path: *"Re-encoded to &lt;path&gt;, but it is not
  visible in the current view. It may be excluded by the active filter, outside
  a watched folder, or ingestion may still be in progress."*

The `waitForIngestedFile` rejection also follows this rule: *"&lt;path&gt; was not
detected in the current view within &lt;N&gt; ms. It may not match the active
filter, or it may be outside a watched location."*

### 5. Compile + unit tests are not verification for a tool

All three bugs above survived `yarn build` and 98 passing tests, because they
live in cross-process integration (path forms, watcher timing, MobX counter
state under a filtered view). A tool is only verified by running the real app
and exercising the full chain — including from a **filtered view**, with a
**fully-tagged library**, and with a source whose name already collides with
the output convention.

### 6. SlideMode + refetch: pin the viewed file by identity, never by index

**The fetch path (`updateFromBackend`) does NOT reconcile `uiStore.firstItem`.**

`updateFromBackend` wholesale-replaces `fileList` (clear + push) and calls
`cleanFileSelection`, but it does NOT update `firstItem`.  After the replace,
`firstItem` points at whatever index it had before the fetch — which is now
either a completely different file (if the list changed length/order) or out of
range.  `firstFileInView = fileList[firstItem]` then returns `undefined`, and
SlideMode unmounts (the mount gate in `LayoutSwitcher.tsx:193` requires
`firstFileInView` to be defined).

Contrast `removeFilesFromListInPlace` (FileStore.ts:703–809), which snapshots
`oldFirstItemId` and re-points `firstItem` to the survivor's new index after
every splice.  **The fetch path has no such logic** — this is the structural
asymmetry (INV-021) that drops the viewer whenever a refetch fires in SlideMode.

**Rule:** any refetch performed while `isSlideMode` is true MUST pin the
currently-viewed file by identity (not by index) so that after the list
settles, `firstItem` is set to the file's new position.  Use the dedicated
primitive:

```typescript
// TASK-089 / INV-021 usage pattern:
const pinned = await this.pinViewedFileAcrossRefetch(sourceFile);
if (!pinned) {
  // sourceFile is no longer in the refetched list — insert/pin it manually.
}
```

`FileStore.pinViewedFileAcrossRefetch(pinFile)` (FileStore.ts, added by
TASK-090) calls `refetch()`, then in a single synchronous MobX `transaction`
sets `uiStore.firstItem` to the pin file's new index and calls
`selectFile(pinFile, true)`.  Returns `true` when the file survived the
refetch; `false` when it is absent (caller must decide what to show).

Do NOT route a SlideMode swap through `clearSearchCriteriaList()` or any
content-mode setter (`setContentAll`, `setContentQuery`, etc.) without first
securing the pin — those methods call `disableSlideMode()` unconditionally and
will tear the viewer down.

---

## Established Rules (from the INV-018 design)

These were decided up front and remain binding for new tools:

- **Spawn subprocesses in the main process, never the renderer.** Main
  survives renderer reloads and is the only place a `before-quit` handler can
  kill children and remove partial outputs.
- **Clean up partial outputs** on failure, cancel, *and* app quit. Register
  every long-lived child with a manager that `killAll()`s on `before-quit`.
- **Never auto-delete or overwrite user files.** Output paths are always
  collision-free (`getUniqueSiblingPath`); deletions are always user-confirmed
  and routed through the existing Recycle-Bin trash flow
  (release media handles → `checkRecyclable` → `trashFile`/
  `deleteFilePermanently` → `fileStore.deleteFiles`).
- **Don't rely on the external binary to preserve metadata.** Re-encoders drop
  EXIF/XMP; copy tags explicitly via `FileStore.finalizeEncodedOutput`, which
  uses `copyTagsToOutputPath` to perform exactly one ExifTool write at the DB
  level — no `ClientFile` from `fileList` required.
  Never also write tags from the main process for the same file — that
  double-writes and can race the encoder's file handle.
- **Preserve user-specified command arguments verbatim.** Only add transport
  flags (progress, banner suppression, overwrite behavior) around them.
- **Scope tools by file type** with the existing predicates
  (`isFileExtensionVideo` etc.); widening a predicate is a separate decision
  with player implications, not a side effect of adding a tool.
- **Prefer the scoped `mediaProcessing` lock over a global blocking overlay.**
  Gate the specific affordances (global shortcuts, SlideMode keys,
  `openMoveFilesToTrash` as the single delete choke point) so the UI stays
  honest about what is frozen. Always release in `finally`.
- **Bundling a new binary has a licensing footprint.** Check the build flags
  (the bundled ffmpeg is `--enable-gpl --enable-libx264`) and document the
  obligation in [personal-fork-notes.md](personal-fork-notes.md) — acceptable
  for this private fork, must be revisited before any distribution.

---

## Checklist for a New Tool

1. [ ] Binary (if any) under `resources/<name>/`, declared in
       `build.win.extraResources`, resolved via a `common/fs.ts` helper;
       verified in dev **and** the packaged portable layout.
2. [ ] Manager in main with: job registry, progress callbacks, `cancel`,
       partial-output cleanup, `before-quit` registration.
3. [ ] IPC trio (invoke start / push progress / send cancel) following the
       existing static-method pattern; first progress event carries the jobId.
4. [ ] Button in `ImageTools.tsx`: type-gated, disabled while
       `isMediaProcessing`, spinner + whole-percent progress + Cancel.
5. [ ] Orchestration wrapped in `try/finally` around `endMediaProcessing()`;
       distinct handling for cancel vs failure vs ingestion timeout.
6. [ ] Post-encode finalization via `fileStore.finalizeEncodedOutput(source,
       outputPath)` — this handles DB-level tag copy, refetch, bounded wait,
       select/slide, and graceful fallback in the correct order.
7. [ ] Any destructive follow-up reuses the `RemovalAlert` trash-flow pattern.
8. [ ] Manual QA in the running app: happy path, filtered view + fully-tagged
       library, name collision, zero-tag source, failure, cancel,
       quit-mid-job, lock enforcement.
9. [ ] Feature doc in `docs/`, linked from [index.md](index.md); licensing
       caveat in [personal-fork-notes.md](personal-fork-notes.md) if a new
       binary is bundled.

---

## Worked Examples

### Example 1 — Re-encode (x264) (INV-018)

The first tool.  It uses all eight layers: binary bundling, path resolution, the
full `ReEncodeManager` job runner, three IPC channels, the UI lock,
`finalizeEncodedOutput`, the `ImageTools.tsx` button + orchestration, and the
`DeleteOriginalAfterJob` prompt.  See [reencode-x264.md](reencode-x264.md) for
the complete feature doc.

### Example 2 — Normalize Audio (INV-020)

The second tool confirms the rule stated in layer 3–6's description above: **a
new sibling-file tool needs only the button/orchestration layer (layer 7) plus
a parameterized manager entry point — the reusable layers 3–6 are unchanged.**

Specifically, Normalize Audio added:

- **One entry in `MEDIA_JOB_SPECS`** (in `src/main.ts`) — the ffmpeg args
  `['-c:v', 'copy', '-filter:a', 'dynaudnorm=p=0.9:s=5']` and output
  extension `'mp4'`.  The manager (`ReEncodeManager.start(inputPath, jobArgs,
  outputExt, callbacks)`), IPC channels (`START_MEDIA_JOB` /
  `MEDIA_JOB_PROGRESS` / `CANCEL_MEDIA_JOB`), UI lock, and
  `finalizeEncodedOutput` helper were all reused without modification.
- **A second button in `ImageTools.tsx`** — video-gated, disabled while
  `isMediaProcessing`, wired to the shared `runMediaJob('normalize-audio')`
  helper.  The spinner label reads "Normalizing audio… N%".
- **No new binary, no new IPC channels, no new manager class.**  The
  delete-original prompt (`DeleteOriginalAfterJob`) was already generalized by
  TASK-086 and is shared verbatim.

See [normalize-audio.md](normalize-audio.md) and INV-020 for the full feature
doc and the `-c:v copy` container-compatibility caveat (VP8/Theora sources
fail with an honest error when stream-copying into the forced `.mp4` container).

### Example 3 — Create Clip / Mark Start / Mark End (INV-022)

The third tool introduces the **one** dimension the parameterized stack had not
yet generalized: **pre-input ffmpeg arguments** (`-ss`/`-to` must precede `-i`
for correct stream-copy seeking).  Everything else is reused unchanged.

Specifically, Create Clip added:

- **One targeted widening to `ReEncodeManager.start()`** — an optional
  `preInputArgs: string[] = []` parameter, inserted before `-i` in the ffmpeg
  argv.  The two existing call sites pass nothing and are completely unaffected.
- **One entry in `MEDIA_JOB_SPECS`** — `{ args: ['-c', 'copy'], outputExt: 'mp4' }`.
  The per-invocation `-ss`/`-to` values are not in the static spec; they come
  from the `StartMediaJobMessage.clip` payload and are forwarded as `preInputArgs`
  by the IPC handler in `src/main.ts`.
- **Two HH:MM:SS helpers in `common/fmt.ts`** — `parseHmsToSeconds` and
  `formatSecondsToHms`, shared by the renderer's field validation and the
  main-process defense-in-depth re-validation.
- **Mark Start / Mark End / Create Clip UI in `ImageTools.tsx`** — two
  button-and-field rows and a gated Create Clip button.  Mark buttons read
  `document.querySelector('video')?.currentTime ?? 0` (the established
  `ZoomPan.tsx` pattern) and write `formatSecondsToHms(...)` into the field.
  Create Clip calls `runMediaJob('create-clip', { start, end })`.  The spinner,
  cancel, lock, finalize, and delete-original flows are all shared.
- **No new binary, no new IPC channels, no new manager class.**

Key caveats documented in [create-clip.md](create-clip.md): stream-copy start
snaps to the preceding keyframe (inherent to lossless copy); progress percent is
computed against the source duration (the clip appears to finish "early");
webm/VP8 and ogg/Theora sources fail with an honest error toast when
stream-copied into the forced `.mp4` container — the source is always left
intact.

See [create-clip.md](create-clip.md) and INV-022 for the full feature doc.

---

## Related

- [Re-encode (x264)](reencode-x264.md) — the primary worked example for every layer
- [Normalize Audio](normalize-audio.md) — the second worked example confirming layers 3–6 are reusable
- [Create Clip](create-clip.md) — the third worked example, introducing pre-input args and per-invocation parameters
- [Personal Fork Notes](personal-fork-notes.md) — bundled binaries and licensing
- INV-018 — original investigation, behavioral spec, and design rejections
- INV-020 — Normalize Audio investigation and the parameterized media-job stack
- INV-022 — Create Clip investigation, `-ss`/`-to` pre-input ordering, stream-copy caveats
