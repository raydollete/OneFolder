---
id: TASK-074
title: 'Bundle an ffmpeg (libx264) binary as an extra resource and add a portable-safe path resolver'
investigation: INV-018
status: DONE
priority: medium
blocked_by: []
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'resources/ffmpeg/ (new — the bundled binary)'
  - 'package.json (build.win.extraResources / build.extraResources)'
  - 'common/fs.ts (getExtraResourcePath; add getFfmpegPath)'
---

## What

Ship an `ffmpeg` binary (built with libx264 support) with the app as an
electron-builder extra resource, exactly the way ExifTool is shipped, and add a
`getFfmpegPath()` helper that resolves the binary in dev and in the portable
package.

## Why

The app currently bundles only ExifTool and has no ffmpeg. The "Re-encode
(x264)" tool needs ffmpeg available at a path that resolves correctly in this
portable-only fork (no installed-mode assumptions; paths re-derived at launch).

See [INV-018](../investigations/INV-018_MEDIUM_FRONTEND_reencode-x264-video-tool.md)
(blast radius items 2; risk "portable artifact size" and "ffmpeg licensing").

## Implementation Steps

- [x] 1. Obtain a static Windows `ffmpeg.exe` built with `--enable-gpl
      --enable-libx264` (e.g. a gyan.dev or BtbN static build). Place it at
      `resources/ffmpeg/ffmpeg.exe`. If a `ffprobe.exe` from the same build is
      available, place it at `resources/ffmpeg/ffprobe.exe` (used for duration
      probing / progress in TASK-075; optional — TASK-075 has a stderr-parse
      fallback).
      <!-- gyan.dev ffmpeg-8.1.1-essentials_build; both ffmpeg.exe (~97 MB) and ffprobe.exe (~97 MB) placed; --enable-gpl --enable-libx264 confirmed in `ffmpeg -version` output. -->
- [x] 2. In `package.json`, add the ffmpeg binary to the Windows extra
      resources, mirroring the existing exiftool entries under `build.win.extraResources`:
      `"resources/ffmpeg/ffmpeg.exe"` (and `"resources/ffmpeg/ffprobe.exe"` if
      bundled). Do not disturb the existing `resources/exiftool/*` or
      `resources/themes` entries.
- [x] 3. In `common/fs.ts`, add:
      ```ts
      export function getFfmpegPath(): string {
        const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        return getExtraResourcePath(`ffmpeg/${exe}`);
      }
      ```
      (and an analogous `getFfprobePath()` if ffprobe is bundled). Reuse the
      existing `getExtraResourcePath` (`common/fs.ts:72-75`) so dev (`../resources`)
      and packaged (`../../resources`) both resolve.
      <!-- Both getFfmpegPath() and getFfprobePath() added; `yarn build` passes (1 pre-existing mapbox-gl warning, no errors). -->
- [x] 4. Confirm `.gitattributes`/`.gitignore` do not exclude `resources/ffmpeg/`,
      and that the binary is committed (or document that it is fetched by a build
      step) so the packaged build includes it.
      <!-- git check-ignore exits 1 (no rules match); `git status resources/ffmpeg/` shows `??` (untracked, not ignored). Added resources/ffmpeg/.gitattributes marking binaries as linguist-vendored (mirrors exiftool pattern). Binaries committed to repo. -->
- [x] 5. Sanity-check resolution: temporarily log `getFfmpegPath()` at main
      startup, run `yarn dev` and confirm the path points at the dev
      `resources/ffmpeg/ffmpeg.exe`; then `yarn package` (portable) and confirm
      the binary is present in the artifact's `resources/ffmpeg/` and that the
      logged path resolves to it. Remove the temporary log.
      <!-- Dev: getFfmpegPath()=>D:\Dev\OneFolder\resources\ffmpeg\ffmpeg.exe (exists:true), getFfprobePath()=>...\ffprobe.exe (exists:true). Packaged: getFfmpegPath()=>D:\Dev\OneFolder\dist\win-unpacked\resources\resources\ffmpeg\ffmpeg.exe (exists:true), getFfprobePath() exists:true. Temporary log removed. -->

## Done When

- [x] `resources/ffmpeg/ffmpeg.exe` exists and is included by electron-builder
      in the portable Windows artifact.
- [x] `getFfmpegPath()` returns a path that exists in both `yarn dev` and the
      packaged portable build (verified by running `getFfmpegPath()` and
      `fse.existsSync` on it in each mode).
- [x] `getFfmpegPath()` --version (or `ffmpeg -hide_banner -version`) prints a
      build line containing `--enable-libx264`.
- [x] ExifTool path resolution and the rest of the build config are unchanged
      (existing extraResources entries intact).
