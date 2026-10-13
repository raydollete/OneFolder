# Add GPL fork and ffmpeg notices so the repo can be made public

Tier: 2
Type: feature
Mode: hotfix
External Review: None — hotfix

## Stated Requirements

- "Is there any reason that I can't make this repo public?"
- (accepted recommendation) "ffmpeg GPL notice" and "'Modified version' notice" — items 1 and 2 of the publish-readiness review, run as `/rad-hotfix`.

## Why

Publishing the repo distributes the bundled ffmpeg/ffprobe binaries (gyan.dev 8.1.1 essentials build, `--enable-gpl --enable-version3`) with no license notice or source pointer next to them, and the README presents itself as upstream OneFolder with no statement that this is a modified version (GPL-3.0 §5a). Two docs also assert the fork is "never distributed", which stops being true the moment the repo is public.

## What Changes

Add a fork notice to the README, add a license/source notice beside the ffmpeg binaries, and rewrite the "never distributed" caveats to describe the obligations as satisfied.

## Blast Radius

1. README.md:1 — top of README carries no modified-version notice; upstream links (`README.md:6`-`:7`, help form at `README.md:61`) read as this repo's own.
2. resources/ffmpeg/ffmpeg.exe — tracked GPLv3 binary (with `resources/ffmpeg/ffprobe.exe`); `git ls-files | grep -iE 'ffmpeg.*(license|readme|copying|notice)'` returned empty, so no notice exists yet. New file `resources/ffmpeg/NOTICE.md`.
3. docs/personal-fork-notes.md:11 — "not intended for public distribution"; docs/personal-fork-notes.md:116 — "never distributed".
4. docs/reencode-x264.md:397 — "not distributed publicly".
