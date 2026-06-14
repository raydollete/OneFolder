---
id: TASK-096
title: 'Fix Mark Start/End to capture the real slide-video playback time, and relax Create Clip gating to require only one valid marker'
investigation: INV-024
status: done
priority: high
blocked_by: []
date_created: 2026-06-13
date_completed: 2026-06-13
files:
  - src/frontend/components/ImageTools.tsx
---

## What

In `src/frontend/components/ImageTools.tsx`, fix two things:

1. **Capture bug:** `captureCurrentTime` reads `document.querySelector('video')`,
   which resolves to a GALLERY THUMBNAIL `<video>` (reset to `currentTime = 0` when
   slide mode opens) instead of the slide `<video>` being watched, so Mark Start /
   Mark End always write `00:00:00`. Scope the query to the slide container so it
   reads the actual playing video.
2. **Single-marker gating:** Create Clip currently requires BOTH start and end. Relax
   it so AT LEAST ONE valid `HH:MM:SS` marker enables Create Clip, and send only the
   provided marker(s) in the IPC `clip` payload.

## Why

`document.querySelector('video')` returns the first `<video>` in document order. The
gallery grid stays mounted behind the slide overlay (`LayoutSwitcher.tsx:190-195`)
and renders `<video data-file-id=…>` thumbnails (`GalleryItem.tsx:286`) that are
paused/reset to `currentTime = 0` on slide-mode entry (`GalleryItem.tsx:252-263`), so
the bad selector always grabs a zero-valued gallery video. The slide `<video>`
(`SlideMode/index.tsx:540-551`) is rendered last inside `#zoomable-image`, has no
`data-file-id`, and is already read correctly elsewhere via the SCOPED query
`this.containerRef.current?.querySelector('video')` in `ZoomPan.tsx:165`. The
single-marker change lets a start-only or end-only trim run (ffmpeg defaults the
missing end/start).

See [INV-024](../investigations/INV-024_HIGH_FRONTEND_clip-tool-marktime-zero-and-single-marker.md).

## Implementation Steps

- [x] 1. **Fix `captureCurrentTime`** (`ImageTools.tsx:54-58`). Replaced
      `document.querySelector('video')` with a scoped read of the slide video:
      ```ts
      const v = document.querySelector(
        '#zoomable-image video:not([data-file-id])',
      ) as HTMLVideoElement | null;
      const sec = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
      return formatSecondsToHms(sec);
      ```
      The `#zoomable-image` scope excludes gallery videos (which live under
      `#gallery-content`'s overview subtree, not inside `#zoomable-image`); the
      `:not([data-file-id])` guard is defense in depth (the slide video has no
      `data-file-id`; every gallery thumbnail video does). The now-false comment on
      lines 50-53 was replaced with an accurate note about the gallery grid also
      mounting `<video>` elements, hence the scoped selector (mirroring
      `ZoomPan.tsx:165`).

- [x] 2. **Relax the Create-Clip validity derivation** (`ImageTools.tsx:180-192`).
      Replaced `clipValid` so it is true when AT LEAST ONE marker is a valid
      `HH:MM:SS`, with the start < end rule applied only when BOTH are present, and an
      end-only marker required to be > 0:
      ```ts
      const startSec = startTime === '' ? null : parseHmsToSeconds(startTime);
      const endSec = endTime === '' ? null : parseHmsToSeconds(endTime);
      const startValid = startTime !== '' && startSec !== null;
      const endValid = endTime !== '' && endSec !== null && endSec > 0;
      const bothValid = startValid && endValid;
      const clipValid =
        (bothValid && (startSec as number) < (endSec as number)) ||
        (startValid && endTime === '') ||
        (endValid && startTime === '');
      ```
      `showRangeHint` kept as-is (fires when both fields are non-empty and start ≥ end).

- [x] 3. **Build the marker-only `clip` payload on Create Clip click**
      (`ImageTools.tsx:291-297`). Replaced the unconditional
      `{ start: startTime, end: endTime }` with only the present marker(s):
      ```ts
      onClick={() => {
        const clip: { start?: string; end?: string } = {};
        if (startTime !== '') {
          clip.start = startTime;
        }
        if (endTime !== '') {
          clip.end = endTime;
        }
        runMediaJob('create-clip', clip);
      }}
      ```
      Also updated the `runMediaJob` callback's `clip` parameter type (line 61) to
      `clip?: { start?: string; end?: string }` to match the widened IPC contract
      from TASK-097.

- [x] 4. **Verify build + lint.** `npx tsc --noEmit` — only pre-existing node_modules
      dom+webworker lib conflicts; no errors in project files. `npx eslint` on changed
      files — clean. Full `npx jest` — 117/117 pass across 15 suites.

## Done When

- [x] `captureCurrentTime` reads the slide `<video>` via `#zoomable-image video`
      (hardened with `:not([data-file-id])`), not `document.querySelector('video')`,
      and the misleading comment is corrected.
- [x] Create Clip is enabled when exactly one valid marker is present (start-only, or
      end-only with end > 0), when both are present with start < end, and is disabled
      when both empty, the lone present marker is malformed, or both present with
      start ≥ end.
- [x] The Create Clip click sends a `clip` payload containing only the marker(s) the
      user actually filled in.
- [x] `yarn lint` and the renderer `yarn build` pass.
