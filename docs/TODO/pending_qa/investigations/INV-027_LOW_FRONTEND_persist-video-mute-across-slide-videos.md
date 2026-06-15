---
id: INV-027
title: 'Video mute/volume state resets on every slide-mode video switch (not persisted)'
reported_bug: 'In slide-mode / preview, muting a video via the native controls is forgotten the moment you switch to the next video — every new video starts unmuted at the browser default. The mute preference is never remembered, even within a session, let alone across app relaunches.'
date: 2026-06-15
status: active
superseded_by:
tasks_spawned: [TASK-104, TASK-105]
root_cause_category: architectural-shortcoming
affects:
  - SlideMode video player (src/frontend/containers/ContentView/SlideMode/index.tsx)
  - UiStore persisted-preference layer (src/frontend/stores/UiStore.ts)
  - Preview Quick-View window (shares ContentView -> SlideMode; src/frontend/Preview.tsx)
---

## Bug Report

### Observed Behavior

In OneFolder's slide-mode / preview video player, the main `<video>` element is rendered with native browser `controls` (`src/frontend/containers/ContentView/SlideMode/index.tsx`, lines ~541-558). When the user mutes a video using the native control:

- The mute state is **discarded the instant they switch to another video**. Every newly displayed video starts at the browser default (unmuted).
- The state is not persisted across app relaunches either.

There is no `muted`/`volume` binding on the element at all — neither declarative nor imperative — so the player has no memory of the user's audio choice.

### Expected Behavior

The user's mute choice should persist:

1. **Within a session, across video switches** — mute video A, switch to video B, B is still muted.
2. **Across the unmute direction too** — unmute, switch, still unmuted.
3. **Across app relaunches** — relaunch the app, the last mute state is restored (read from per-library localStorage, exactly like every other UiStore preference).

This mirrors how OS-level and app-level media players universally treat the mute toggle as sticky state, not per-clip state.

### Reproduction Context

Deterministic. Any two videos visible in slide mode (or the Preview Quick-View window) reproduce it. The root cause is structural, not format- or codec-specific. Gallery hover-preview thumbnails are out of scope (they are intentionally always muted).

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

The slide `<video>` is **keyed by `key={file.absolutePath}`** (line ~550). This is deliberate (see the comment at lines ~543-549): keying forces React to fully **remount a fresh `<video>` element** every time the displayed file changes, guaranteeing a clean reload after media-job output swaps (e.g. Compress & Normalize Audio produces a file with identical video frames via `-c:v copy`, so reusing a buffered element would keep presenting the stale file). The remount is correct and must stay.

The side effect of remount-per-file is that **all element-local DOM state is destroyed on every switch** — including the `muted`/`volume` properties the user set via the native controls. Because there is *no* React state, MobX observable, or persisted preference backing the audio state, there is nothing to re-apply to the freshly-mounted element. Each new `<video>` boots at the Chromium default (unmuted).

The deeper architectural gap: **audio playback state was never modeled as persistent application state.** It lived implicitly inside a deliberately-ephemeral DOM element. Volume/mute is conceptually a *viewer preference* (like `upscaleMode` or `galleryVideoPlaybackMode`), but it was never lifted into the `UiStore` persisted-preference layer that already exists for exactly this class of setting.

The fix is to model `videoMuted` as a persisted UiStore boolean and bind it both ways to the slide `<video>`:
- **Capture:** the native control fires a `volumechange` event → `onVolumeChange={(e) => uiStore.setVideoMuted(e.currentTarget.muted)}`.
- **Apply:** set `el.muted = uiStore.videoMuted` imperatively inside the existing `setSlideVideoRef` callback ref (lines ~472-489), which already owns the freshly-attached element for MediaReleaseCoordinator + freeze-recovery registration. React has a well-known quirk where the `muted` JSX prop is not reliably reflected to the DOM, so the imperative ref assignment is the robust path; pass `muted={uiStore.videoMuted}` declaratively as a backup.

Because `SlideView` (and `SlideMode`) are `observer`-wrapped (verified — `index.tsx` lines 22 and 52), the `uiStore.videoMuted` read is reactive and the ref callback re-runs on the remount.

### Diagnostic Questions Considered

- **Wrong mental model?** Yes — partially. Audio state was implicitly modeled as per-clip/per-element DOM state when it is conceptually a sticky viewer preference.
- **Architectural shortcoming?** Yes — primary cause. There is no binding between the (deliberately remounted) `<video>` element and any persistent state, so the element has amnesia by construction.
- **Incorrect order of operations?** No.
- **Missing edge case?** No — this is the default path, not an edge.
- **Wrong abstraction?** Adjacent — the deliberate `key`-driven remount (correct for reload-freshness) was never paired with a state re-hydration step for element-local user settings.
- **Silent failure?** No error; behavior is silent loss of state.

---

## Blast Radius

1. **Preview Quick-View window (`src/frontend/Preview.tsx` + `RootStore.preview`)** — The separate Electron preview window renders the *same* `ContentView` → `SlideMode` → same slide `<video>` (line 541). It therefore has the identical bug today, and it gets the identical fix automatically with zero extra component changes. It also calls `rootStore.uiStore.recoverPersistentPreferences()` (`RootStore.ts` line ~192) against the same per-library localStorage key, so `videoMuted` is restored there too. NOTE: the preview window is a distinct renderer with its own `UiStore` instance and its own auto-persist reaction; mute state does not *live*-sync between the two open windows — each persists independently, last-writer-wins on next launch. This matches how every other UiStore preference already behaves across these two windows and is acceptable; documented here so it is not mistaken for a regression.

2. **UiStore persisted-preference layer (`src/frontend/stores/UiStore.ts`)** — The fix extends this layer with one new boolean field following the exact `upscaleMode` / `galleryVideoPlaybackMode` pattern: `PersistentPreferenceFields` union (~line 129-130), `@observable` declaration (~line 213), an `@action.bound setVideoMuted`, restore in `recoverPersistentPreferences()` (~line 1201), serialize in `getPersistentPreferences()` (~line 1290). No `renderer.tsx` change needed — the existing `reaction(() => uiStore.getPersistentPreferences(), …)` (lines ~159-165) auto-persists any returned field, debounced 200ms, per-library via `getPreferencesStorageKey`.

3. **Gallery hover-preview thumbnails (`src/frontend/containers/ContentView/GalleryItem.tsx`, line ~278)** — EXPLICITLY OUT OF SCOPE / MUST REMAIN UNCHANGED. These `<video>` elements are hard-muted (`muted: true`) on purpose so that scrolling/hovering the gallery never produces sound. They must NOT read `uiStore.videoMuted`. Listed here so the implementer consciously leaves them alone.

4. **Off-DOM probe / preload `<video>` elements (`SlideMode/index.tsx` lines ~168, ~186, ~366)** — Created via `document.createElement('video')` for next/prev preloading and metadata/dimension probing. They are never appended to the DOM and never play audible audio. OUT OF SCOPE — no mute binding required.

---

## UX / Requirements Specification

### Purpose

Make the slide/preview video player remember the user's mute choice the way every mainstream media player does: mute is a sticky viewer preference, not a per-clip setting that resets on each new video.

### User-Stated Design Decisions

1. **Reuse the existing UiStore persisted-preference pattern — do not invent new infrastructure.** A new boolean `videoMuted` must mirror `galleryVideoPlaybackMode` / `upscaleMode` exactly (union field, observable default `false`, `@action.bound` setter, restore line, serialize line). Rationale: the persistence plumbing (per-library localStorage, debounced reaction in `renderer.tsx`) already exists and is proven; adding a field is the minimal, idiomatic change.
2. **Capture the user's toggle via the native `volumechange` event** — `onVolumeChange={(e) => uiStore.setVideoMuted(e.currentTarget.muted)}` on the slide `<video>`. Rationale: the player uses native `controls`; `volumechange` is the canonical signal the mute/unmute button fires.
3. **Apply the state imperatively in `setSlideVideoRef`** via `el.muted = uiStore.videoMuted`, and ALSO pass `muted={uiStore.videoMuted}` declaratively as a backup. Rationale: React's `muted` JSX prop is famously not reliably reflected to the DOM; the imperative assignment on the already-held element ref is the robust path.
4. **No `renderer.tsx` change.** The existing auto-persist reaction handles serialization. Rationale: avoid touching working persistence wiring.
5. **Restore with a safe default** — `this.videoMuted = Boolean(prefs.videoMuted ?? false);` so a missing key yields `false` (unmuted), matching today's effective default.

### Behavioral Specifications

- Mute video A → switch to B → B is muted. Unmute → switch → next is unmuted.
- Relaunch app → last mute state restored from per-library localStorage.
- Same behavior inside the Preview Quick-View window (shares the player).

### Explicit Rejections

- Do NOT change gallery hover-preview thumbnails (`GalleryItem.tsx` line ~278); they stay hard-muted.
- Do NOT add mute binding to the off-DOM preload/probe `<video>` elements.
- Do NOT remove or alter the `key={file.absolutePath}` remount; the fix must work *with* the remount, not by eliminating it.
- Do NOT add new persistence infrastructure or modify the `renderer.tsx` reaction.
- Persisting full volume *level* (not just the boolean mute) is NOT requested; keep scope to the `videoMuted` boolean.

---

## Holistic Solution

### Approach

1. **UiStore (`src/frontend/stores/UiStore.ts`):** add `videoMuted` to `PersistentPreferenceFields`, add `@observable videoMuted: boolean = false;`, add `@action.bound setVideoMuted(muted: boolean)`, restore it in `recoverPersistentPreferences()` (`this.videoMuted = Boolean(prefs.videoMuted ?? false);`), serialize it in `getPersistentPreferences()` (`videoMuted: this.videoMuted,`). Mirror the `upscaleMode` lines exactly.

2. **SlideMode (`src/frontend/containers/ContentView/SlideMode/index.tsx`):** on the slide `<video>` (line ~541) add `onVolumeChange={(e) => uiStore.setVideoMuted(e.currentTarget.muted)}` and `muted={uiStore.videoMuted}`; in `setSlideVideoRef` (line ~483, inside the `if (el && isFileExtensionVideo(...))` block) add `el.muted = uiStore.videoMuted;` so the freshly-remounted element is correctly initialized before play. `SlideView` is already `observer`-wrapped, so the reactive read is valid.

3. The Preview Quick-View window inherits the fix with no edits (it renders the same component tree and restores the same preferences key).

### Expected Outcomes

- Mute is sticky across video switches in both directions, within a session.
- Mute is restored on app relaunch from per-library localStorage.
- Preview Quick-View window behaves identically.
- Gallery hover previews remain silent (unchanged).

### Risks and Tradeoffs

- **Cross-window live sync:** main window and preview window each hold a separate `UiStore`; a mute change in one does not live-update the other while both are open. Last-writer-wins on next launch. Consistent with all existing preferences; accepted, not a regression.
- **`autoPlay` + browser autoplay policy:** unmuted autoplay is already the current behavior inside Electron (autoplay is permitted), so applying `videoMuted=false` does not introduce a new autoplay-block risk; if `videoMuted` is `true`, autoplay is even more permissible. No regression expected.
- **`volumechange` also fires on volume-slider drags:** acceptable — we only read `.muted`, ignoring level; dragging volume without toggling mute leaves `videoMuted` unchanged.

---

## Game Documentation Updates

- [x] No updates needed
