Tier: 2 — Standard behavior change with a bounded blast radius: one component's async read + a small info-panel layout change; root cause is a systemic silent-failure class, so it also gets a latent-defect hunt.

Type: bug

## Why

The frame-rate (FPS) readout recently added to the video info panel is
unreliable: it intermittently stops rendering and does not recover until the app
is restarted. The value is also crammed onto the same line as the resolution,
which reads poorly. A metadata readout that silently disappears with no signal is
worse than none — users can't tell whether the video has no frame rate or the app
failed to read it.

## Root Cause

Category: **silent-failure**.

Diagnosed from code actually read:

- `src/frontend/components/ImageInfo.tsx:123-126` reads the frame rate with
  `exifTool.readExifTags(path, ['VideoFrameRate']).then(setVideoFps).catch(() => setVideoFps(''))`.
  The `.catch(() => setVideoFps(''))` swallows **every** read rejection with no
  log and no recovery, collapsing "read failed" and "no frame rate" into the same
  blank output. When the read fails there is no surfaced cause and no retry.
- The underlying read does not guarantee the exiftool worker is available:
  `common/ExifIO.ts:252` (`readExifTags`) calls `this._ep.readMetadata(...)`
  directly, and `_executeCommand` rejects with `'exiftool is not open'` when the
  process is not open (`@logion/node-exiftool` `index.js:125`; `_open` is cleared
  on process exit, `index.js:112`). Any transient unavailability therefore lands
  in the swallowing catch above and vanishes silently.
- The read is also unguarded against file switches: the effect is keyed on
  `[file.absolutePath]` (`ImageInfo.tsx:142`) and stores the result via a bare
  `.then`, so a late- or out-of-order resolution from a previously selected file
  can overwrite or blank the current file's value.

The exact persistence-until-restart trigger must be confirmed at runtime (add a
warning log — see design), but the swallowed catch is the concrete defect that
both produces the blank and prevents diagnosis.

## What Changes

- Make the FPS readout **reliable by construction**: replace the silent
  `.catch(() => setVideoFps(''))` with a path that logs the failure (fail-loud)
  and never leaves the field wedged blank across selections.
- Guard the async frame-rate read against stale/out-of-order resolution when the
  user switches files, so a read for a previous file can no longer wipe or freeze
  the current file's value.
- **Move the FPS onto its own line below the Dimensions row**, labeled
  `Frame Rate`, instead of appending `· NN fps` to the Dimensions value. Revert
  the Dimensions value to `W x H`. The Frame Rate row renders only for videos
  that report a frame rate (hidden otherwise).

## Capabilities

### New Capabilities
- `video-metadata-display`: Behavior of the file info/inspector panel when
  showing video-specific metadata — currently the frame-rate (FPS) readout: when
  the row appears, how it is laid out, and its reliability guarantees across file
  selections.

### Modified Capabilities
<!-- None: no existing spec covers the info-panel metadata readout. `video-playback`
     is scoped to keyboard playback control — a separate concern. -->

## Blast Radius

1. `src/frontend/components/ImageInfo.tsx:118-127` — the frame-rate read effect,
   the silent catch, and the missing stale-guard (primary fix site).
2. `src/frontend/components/ImageInfo.tsx:11-23, 97-105, 193-198` — `CommonMetadata`
   type, `commonMetadataLabels`, `dimensions` string, and the common-metadata
   table rendering that must gain the separate `Frame Rate` row.
3. `src/frontend/components/ImageDates.tsx:68` and
   `src/frontend/components/ImageMap.tsx:139` — **same latent class**: `readExifTags(...).then(setState)`
   inside a file-keyed effect with no stale-guard on file switch. Not the reported
   bug, but the same order-of-stale-resolution hazard; flagged for the design's
   latent-defect review to decide whether to harden now or file a follow-up.
4. Searches proving the blast radius bounded: `grep -rn VideoFrameRate src common`
   → only `ImageInfo.tsx` reads it. `grep -rn "readExifTags|readAllExifTags" src/frontend`
   → the three components above plus the platform seam. No other site couples a
   swallowed exif-read catch to UI state.

## Impact

- `src/frontend/components/ImageInfo.tsx` — read effect, stale-guard, error
  logging, and the Dimensions/Frame Rate row layout.
- Reads `VideoFrameRate` via the platform `ExifIO` seam (`readExifTags`); no
  changes to `common/ExifIO.ts` or the exiftool process are required.
- UI-only, non-breaking. No data, DTO, or persistence changes.
