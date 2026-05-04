---
id: TASK-050
title: 'Always send theme IPC on startup so fresh installs sync the native window chrome'
investigation: INV-011
status: DONE
priority: low
blocked_by: [TASK-049]
date_created: 2026-05-03
date_completed: 2026-05-04
files:
  - 'src/frontend/stores/UiStore.ts'
---

## What

Move the `RendererMessenger.setTheme({ theme: this.theme === 'dark' ? 'dark' : 'light' })` call in `UiStore.recoverPersistentPreferences` (`src/frontend/stores/UiStore.ts:1090`) out of the `if (prefsString)` branch and place it after the if/else block so it fires unconditionally on every recovery. This ensures that on a fresh install — where `prefsString` is `null` and the entire recovery `if` block is skipped — the main process is still told what theme the renderer is using, and the native Windows titlebar / frame matches the React UI from the very first frame.

This is Defect A from INV-011. It is benign today (the field default is `'light'` and Electron's `nativeTheme.themeSource` default also tends to produce a light titlebar) but becomes a visible regression once TASK-049 flips the field default to `'dark'`.

## Why

Without this fix, a fresh install on a Windows machine whose OS theme is light would render a dark React app inside a light Windows titlebar / frame for the entire first session, until the user manually toggles theme in Settings (which DOES go through `setTheme(...)` → `RendererMessenger.setTheme(...)`).

Sending the IPC unconditionally is safe: the handler at `src/main.ts:617` (`MainMessenger.onSetTheme((msg) => (nativeTheme.themeSource = msg.theme))`) is idempotent, and the IPC payload is a tiny object, so emitting it on every startup adds no meaningful overhead.

See [INV-011](../investigations/INV-011_LOW_FRONTEND_default-theme-dark-and-default-sort-random.md) Defect A for the full analysis.

## Implementation Steps

- [x] 1. **Open `src/frontend/stores/UiStore.ts`** and locate `recoverPersistentPreferences` (lines 1011-1103).

- [x] 2. **Identify the current location of the IPC call** at line 1090 inside the `if (prefsString) { ... }` branch:
  ```
        // Set the native window theme based on the application theme
        RendererMessenger.setTheme({ theme: this.theme === 'dark' ? 'dark' : 'light' });
      }
  ```

- [x] 3. **Move the line out of the `if (prefsString)` branch** so it runs unconditionally. Place it between the closing brace of the `if (prefsString)` block (currently line 1091) and the start of the thumbnail-directory `if (this.thumbnailDirectory.length === 0)` block (currently line 1095). The result should look like:
  ```
        console.info('recovered', prefs);
      } catch (e) {
        console.error('Cannot parse persistent preferences', e);
      }
    }

    // Set the native window theme based on the application theme.
    // This must run on EVERY recovery, not just when persisted prefs exist:
    // on a fresh install (no prefsString) the main process still needs to be
    // told the theme so the native window chrome matches the React UI.
    // See INV-011 Defect A.
    RendererMessenger.setTheme({ theme: this.theme === 'dark' ? 'dark' : 'light' });

    // Set default thumbnail directory in case none was specified.
    // Pass the library ID so each library gets its own thumbnail subdirectory.
    if (this.thumbnailDirectory.length === 0) {
      ...
  ```
  Update the inline comment as shown to document the rationale for the unconditional call.

- [x] 4. **Verify no other call site relies on the old conditional behavior**. Grep for `recoverPersistentPreferences` in the repo to confirm it is only invoked from `RootStore.main` (line 109) and `RootStore.preview` (line 189). Both invoke it once during init, after store construction, before fileStore.fetchAllFiles. The IPC fires once per renderer load — exactly what we want.

- [x] 5. **Build verification**: run `yarn lint` to confirm no TypeScript or lint errors. (`UiStore.ts` passes lint cleanly; pre-existing errors in other files are unrelated to this change.)

## Done When

- [x] The `RendererMessenger.setTheme(...)` call is outside the `if (prefsString)` block in `UiStore.recoverPersistentPreferences` and runs on every recovery.
- [x] An explanatory comment referencing INV-011 Defect A is present at the new call site.
- [x] `yarn lint` passes with no new errors (UiStore.ts clean; pre-existing errors elsewhere are unrelated).
- [x] No other functional changes — this task is scoped to relocating one line and adding a comment.
