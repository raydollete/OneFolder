---
title: Dual-Boot Shared-Library Acceptance Runbook
author: @system
last_updated: 2026-09-08
scope: qa
aliases: ["dual-boot-qa", "portable-shared-library-acceptance", "task-7.1"]
---

# Dual-Boot Shared-Library Acceptance Runbook

Manual acceptance for the **portable-shared-library-caches** change (task 7.1,
`REQUIRES MANUAL EXECUTION`). It proves, on real hardware, that one shared
OneFolder library opens from both OSes of a dual-boot install with **no per-boot
Location Recovery, no duplicated/orphaned rows, and no thumbnail / preview /
visual-hash regeneration**.

Automated tests cannot cover this: `better-sqlite3` and the Electron entities do
not load under jest, and the real proof spans two operating systems, a shared
filesystem, and a reboot. This runbook is the gate.

## Evidence-gate rules (from `docs/TODO/QA-DISCIPLINE.md`)

- **Only the human executor may mark this passed.** An agent may prepare and
  propose; it may not record completion.
- **Every assertion below needs concrete captured evidence** — a saved terminal
  transcript, a query result pasted into the results table, a directory listing,
  or a screenshot. "It looked fine" is not evidence.
- Record all evidence in the **Results log** at the bottom (copy it into the
  task/PR, or save the files next to this runbook and link them).
- If any assertion fails, **stop**, capture the failure, and treat the feature as
  not accepted until re-run from the first failing step.

## What "not regenerated" means for each cache

| Cache | Lives in | "Reused, not regenerated" is shown by |
|-------|----------|----------------------------------------|
| Thumbnails | `…/thumbnails/*.webp` (files) | file **count unchanged** and **mtimes unchanged** after the OS switch |
| Previews | `…/previews/*.webp` (files) | same: count + mtimes unchanged |
| Visual hashes | `visualHashes` table in `onefolder.db` | row **count unchanged** and `dateComputed` values unchanged |
| File rows | `files` table in `onefolder.db` | row **count unchanged**, **zero** duplicate `(locationId, relativePath)` |

A regeneration shows up as new/changed mtimes (thumbnails/previews) or a rising
row count / fresh `dateComputed` (visual hashes).

## Prerequisites

1. A machine that dual-boots **Windows and Linux**, both able to mount the **same
   filesystem** where the portable directory lives (an internal partition or a
   drive both OSes can read/write). Note the filesystem type — NTFS, exFAT, or a
   Linux-native fs — and whether it is case-sensitive.
2. Both portable builds from the **same source revision** in one portable
   directory, with the photos in a subfolder beside them:

   ```
   <portable dir>/
   ├── OneFolder-<version>-x64.exe           # Windows portable (yarn package:portable)
   ├── OneFolder-<version>-x86_64.AppImage   # Linux portable (yarn package:appimage)
   ├── data/                                 # ONE shared data dir — created on first launch
   └── Photos/                               # a location UNDER the portable dir
   ```

3. `sqlite3` CLI available on both OSes (or DB Browser for SQLite) to read
   `onefolder.db`. The app must be **fully closed** before querying the DB
   (SQLite holds a single-writer lock).
4. In the library, prepare at least a few dozen photos so counts and cache reuse
   are meaningful, and include **two case-distinct siblings** in the same folder
   (e.g. `Holiday.jpg` and `holiday.jpg`) **only if the shared filesystem is
   case-sensitive** — create them from Linux.

## Locating the artifacts

Paths are under the shared `data/` dir. The library id is a UUID; if there is
only one library there is one subdirectory.

- **Database:** `<portable dir>/data/libraries/<libraryId>/onefolder.db`
- **Thumbnails / previews:** the thumbnail directory is shown in the app at
  **Settings → Advanced**. Default layout is
  `<portable dir>/data/OneFolder/<libraryId>/thumbnails/` with a sibling
  `…/previews/`. Use whatever that screen reports — it is user-configurable.
- **Pre-migration backup (created on first upgrade):**
  `onefolder.db.pre-portable-<timestamp>.bak` beside the DB.

Set shell variables to the real paths before running the command blocks:

```bash
# Linux
DB="/mnt/shared/OneFolder/data/libraries/<libraryId>/onefolder.db"
THUMBS="/mnt/shared/OneFolder/data/OneFolder/<libraryId>/thumbnails"
PREVIEWS="$(dirname "$THUMBS")/previews"
```

```powershell
# Windows (PowerShell)
$Db="D:\OneFolder\data\libraries\<libraryId>\onefolder.db"
$Thumbs="D:\OneFolder\data\OneFolder\<libraryId>\thumbnails"
$Previews="Join-Path (Split-Path $Thumbs) previews"
```

## Snapshot commands (run with the app CLOSED)

Take a snapshot **before** and **after** each boot. Save each snapshot's output.

**DB counts + duplicate check + visual-hash freshness (both OSes):**

```bash
sqlite3 "$DB" "
  SELECT 'files', COUNT(*) FROM files
  UNION ALL SELECT 'locations', COUNT(*) FROM locations
  UNION ALL SELECT 'visualHashes', COUNT(*) FROM visualHashes;
  -- duplicate identity rows (MUST be empty):
  SELECT locationId, relativePath, COUNT(*) c
    FROM files GROUP BY locationId, relativePath HAVING c > 1;
  -- newest visual hash timestamp (MUST NOT advance across a boot):
  SELECT COALESCE(MAX(dateComputed),'none') FROM visualHashes;
  -- anchored locations (portableRoot NOT NULL) after migration:
  SELECT id, portableRoot, path FROM locations;
"
```

**Cache count + mtime fingerprint — Linux:**

```bash
find "$THUMBS" "$PREVIEWS" -type f -printf '%T@ %p\n' 2>/dev/null | sort | sha256sum
find "$THUMBS" -type f | wc -l
```

**Cache count + mtime fingerprint — Windows (PowerShell):**

```powershell
Get-ChildItem -Recurse -File $Thumbs, $Previews -ErrorAction SilentlyContinue |
  Sort-Object FullName |
  ForEach-Object { "$($_.LastWriteTimeUtc.Ticks) $($_.FullName)" } |
  Out-String | % { [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
      [System.Text.Encoding]::UTF8.GetBytes($_))) }
(Get-ChildItem -Recurse -File $Thumbs -ErrorAction SilentlyContinue).Count
```

The SHA of the `(mtime, path)` listing is the key signal: **identical SHA before
and after a boot = caches were reused, not regenerated.**

## Procedure

### Phase 0 — Build the library on OS A (Windows)

1. Launch `OneFolder-<version>-x64.exe`. Add the `Photos/` folder (under the portable dir) as a
   location. Let indexing and thumbnail generation finish.
2. Open a handful of photos so thumbnails (and, for HEIC/TIFF/PSD/etc. via serve
   mode if used, previews) and visual hashes are generated and cached.
3. Fully **close** the app.
4. **Capture SNAPSHOT-A0** (DB counts, duplicate check, visual-hash max, cache
   SHA + count) using the Windows commands. Also confirm the
   `onefolder.db.pre-portable-*.bak` backup exists (proves the migration ran and
   backed up first).

### Phase 1 — First boot on OS B (Linux)

5. Reboot into Linux. Mount the shared filesystem at the SAME portable directory.
6. Launch the AppImage. **Watch the location:** it must resolve and **not** be
   marked broken, and there must be **no Location Recovery prompt**.
   → **Screenshot** the library with the location healthy (SCREENSHOT-B1).
7. Let the initial scan complete. Fully **close** the app.
8. **Capture SNAPSHOT-B1** (Linux commands).

**Assertions (A0 → B1):**
- `files` count **unchanged**; duplicate-identity query **empty**.
- `visualHashes` count and MAX(`dateComputed`) **unchanged** (no recompute).
- Cache SHA **unchanged** and thumbnail count **unchanged** (no regeneration).
  (Note: the SHA is comparable across OSes only if both list the same shared
  files; if mtimes are represented differently per OS, instead assert the **file
  count is unchanged AND no file has an mtime newer than SNAPSHOT-A0** — the
  cache-rename preserves mtimes, regeneration does not.)
- `locations.portableRoot` is populated (the location auto-anchored).

### Phase 2 — Back to OS A (Windows)

9. Reboot into Windows. Launch `OneFolder-<version>-x64.exe`.
10. Location healthy, no recovery prompt. → **Screenshot** (SCREENSHOT-A2).
11. Close the app. **Capture SNAPSHOT-A2** (Windows commands).

**Assertions (B1 → A2):** same four as Phase 1, in the return direction — nothing
duplicated, nothing regenerated, location healthy.

### Phase 3 — Case-distinct siblings (only on a case-sensitive shared tree)

12. If the shared filesystem is case-sensitive: with the two siblings
    `Holiday.jpg` and `holiday.jpg` present in one location, open the library on
    **each** OS and confirm **both** appear as **distinct** files with
    independent tags — neither shadows the other, and tagging one does not tag the
    other. → **Screenshot** from each OS (SCREENSHOT-CASE-A, SCREENSHOT-CASE-B).
13. If the shared filesystem is case-insensitive (e.g. exFAT/NTFS default), record
    that Phase 3 is N/A for this filesystem and why.

## Pass criteria

All of the following, with evidence recorded:

- [ ] Location resolves on **both** OSes with **no** Location Recovery prompt.
- [ ] `files` row count identical across A0 → B1 → A2; **zero** duplicate
      `(locationId, relativePath)` rows at every snapshot.
- [ ] `visualHashes` count and MAX(`dateComputed`) unchanged across the switches.
- [ ] Thumbnail/preview cache: unchanged fingerprint (or unchanged count with no
      newer-than-baseline mtimes) across the switches.
- [ ] `locations.portableRoot` populated for the location under the portable dir.
- [ ] (case-sensitive fs only) case-distinct siblings stay distinct on both OSes.

Only after every box is checked with attached evidence may task 7.1 be marked
done.

## If something fails

- **Location marked broken / recovery prompt on the *second* OS's first boot:**
  expected **only** if that OS ran the new build *before* the first OS had ever
  anchored the location (the stored root is still the first OS's absolute path,
  which is not under the second OS's portable directory). Re-point once via
  Location Recovery; `changeLocationPath` re-anchors it, and subsequent boots
  resolve automatically. If it recurs on an already-anchored location, that is a
  real failure — capture `SELECT id, portableRoot, path FROM locations;` and the
  screenshot.
- **Rows duplicated / caches regenerated:** capture the before/after snapshots
  showing the change and stop. The pre-migration `*.pre-portable-*.bak` beside
  the DB is the rollback: close the app, restore it over `onefolder.db`, and
  report.

## Results log

Paste snapshot outputs and link screenshots here.

| Snapshot | files | locations | visualHashes | MAX(dateComputed) | dup rows | cache SHA / count | captured by / when |
|----------|------:|----------:|-------------:|-------------------|---------:|-------------------|--------------------|
| A0 (Windows build) | | | | | | | |
| B1 (Linux 1st boot) | | | | | | | |
| A2 (Windows return) | | | | | | | |

Screenshots: SCREENSHOT-B1 ____ · SCREENSHOT-A2 ____ · SCREENSHOT-CASE-A/B ____
Backup present (`*.pre-portable-*.bak`): ____
Filesystem type + case-sensitivity: ____
Result: ☐ PASS ☐ FAIL — notes: ____
