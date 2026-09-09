# Portable shared library — portable location roots and portable cache keys

## Stated Requirements

<!-- User's words VERBATIM, one quoted bullet each. -->
- "What about going back and forth? I'm on a dual boot system. I don't want to have to do location recovery each time."
- "The library that I manage has thousands of entries and I'd strongly like to not re-derive the thumbnails"
- "it needs to be a shared library. The 2 executables will sit in the same directory."
- "Is there a way I can remap the Windows path to the Linux equivalent path (it is relative to the executable) so that I don't have to build the same library twice?"

Tier: 3 — behavior fork (location-root resolution + cache key) with a DTO/schema migration, two cache families, and cross-OS semantics spanning api/frontend/server/backend/docs
Type: feature

## Why

A single OneFolder library cannot currently be shared across a dual-boot machine: a location stores one absolute root (`LocationDTO.path`), and the same folder mounts at different absolute paths per OS (`D:\Photos` vs `/mnt/shared/Photos`), so every OS switch marks the location broken and forces Location Recovery — which, because thumbnails are keyed on the absolute path, then re-derives the entire cache (thousands of files). This change makes one shared library — two portable executables plus a shared sibling `data/` in the same directory — usable from both OSes with no per-boot recovery and no thumbnail re-derivation.

- **BREAKING (internal identity):** re-base a file's durable identity from `absolutePath` to the portable `(locationId, relativePath)` pair across the persistence layer, so the same physical file has one stable identity regardless of OS, drive/mount prefix, or a location re-point. `absolutePath` becomes a per-OS *derived/cache* column recomputed from the resolved location root, never the identity. This is what prevents a cross-boot from inserting a duplicate library.
- Move the SQLite uniqueness and the reconciliation/dedup keys off `absolutePath` onto `(locationId, relativePath)`: the `files` `UNIQUE(absolutePath)` constraint, the FTS mirror, `createFilesFromPath`'s prefix dedup, and the created/missing/moved reconciliation sets.
- Add an optional **portable anchor** to `LocationDTO` (a portable-root-relative segment + flag). When anchored, a location's `path` is resolved at hydration as `join(portableRoot, segment)` per OS; unanchored locations keep their stored absolute path (external drives). At hydration, each location's file `absolutePath` values are recomputed from the resolved root so the DB's derived column is consistent before reconciliation runs.
- Resolve the portable root in the renderer from `RendererMessenger.getPath('userData')` (its parent), and inject resolution at the centralized `ClientLocation` construction sites so `watch`/sublocations/`absolutePath` transparently follow.
- Re-key **every path-hash-keyed derived cache** on the portable identity — thumbnails (`getThumbnailPath`), previews (`getPreviewPath`), **and the perceptual visual-hash cache** — via one shared `cacheKey(locationId, relativePath)` helper that all cache producers import, so a future cache is portable by construction.
- **Unify the hash:** the server re-implements `hashString` as `hashFilePath`; collapse to the single `common/fs.ts` implementation, imported by desktop and sidecar alike so both agree on the key.
- Route all reconciliation/store path comparisons through the platform path-identity seam (no raw `absolutePath` `Set.has`/`===`/`LIKE`), and choose the case-fold policy from the **library filesystem's** case-sensitivity, not the running OS, to prevent case-collision data loss on a shared case-sensitive tree.
- **Migrations (re-entrant, shared-`data/`-aware):** (a) auto-anchor existing locations under the portable root; (b) backfill `(locationId, relativePath)` identity + new uniqueness; (c) best-effort rename of existing thumbnail/preview/visual-hash caches from the legacy absolute-path key to the new key (destination-exists-safe; misses regenerate lazily). Markers carry an OS discriminator or live in the shared DB (`user_version` set to the true max applied version); `changeLocationPath` reconciles with the anchor. Broken resolved paths still fall back to the existing `LocationRecoveryDialog`.
- Document the shared-`data/` dual-boot setup (the thumbnail directory is user-configurable via `UiStore.setThumbnailDirectory`).

## Capabilities

### New Capabilities
- `portable-location-roots`: a location root may be stored relative to the portable directory and resolved per-OS at load, so one shared library works across a dual-boot install without re-pointing.
- `portable-thumbnail-cache`: the thumbnail and preview caches are keyed on a portable, OS-independent identity so a shared cache is reused rather than regenerated, with a one-time rename migration off the legacy absolute-path key.

### Modified Capabilities
<!-- None. location-watching (display names, watcher errors) is unchanged; this change adds new resolution/caching behavior rather than altering that spec. -->

## Impact

Affected code, schema, and systems are enumerated in Blast Radius below; user-facing docs (`docs/multi-library.md`, `docs/headless-web-build.md`, `README.md`) gain the dual-boot shared-`data/` setup.

## Blast Radius

<!-- Every affected site: a real <path:line> (checked to exist) or the search that found it. -->
1. `common/fs.ts:8` — `getThumbnailPath` keys the thumbnail filename on `hashString(absolutePath)`; the key to change.
2. `common/fs.ts:68` — `hashString`, the single hash implementation to export/share.
3. `src/server/thumbnails.ts:168` — `getPreviewPath` mirrors the thumbnail naming scheme (preview cache).
4. `src/server/thumbnails.ts:180` — `hashFilePath` duplicates `hashString`; to unify by import.
5. `src/server/routes/images.ts:181` — server route computes `getThumbnailPath(absolutePath, …)`.
6. `src/frontend/stores/FileStore.ts:754` — plus `:1771`, `:1889`, `:2266`: thumbnail-path callers passing `absolutePath`.
7. `src/frontend/stores/LocationStore.ts:318` — thumb path at load; `:97`,`:366`,`:395` `ClientLocation` construction; `:352` `changeLocationPath`; `:732` `relativePathFromLocation`.
8. `src/frontend/containers/Settings/Advanced.tsx:34` — recomputes thumbnail path when the thumbnail directory changes.
9. `src/frontend/entities/Location.ts:91` — `ClientLocation.path` is `readonly` (`:105`) and everything derives from it, so per-OS resolution at construction is transparent.
10. `src/api/location.ts:3` — `LocationDTO` gains the optional portable-anchor fields.
11. `src/ipc/renderer.ts:191` — `getPath('userData')` is the renderer's portable-root source.
12. `src/backend/config.ts:185` — Dexie `version().stores().upgrade()` hook for the schema/anchor migration (mirror in `src/backend/sqlite-config.ts`).
13. `src/backend/migration-indexeddb-to-sqlite.ts:36` — precedent flag-file idempotency pattern (`:67`,`:77`) reused for the one-time cache-rename migration.
14. grepped `getThumbnailPath|getPreviewPath|hashString|hashFilePath` across `src/` and `common/` — the sites above are the complete set outside `tests/`; no other cache-key call sites.
15. grepped `portable|data dir|thumbnail` across `docs/` and `README.md` — `docs/multi-library.md`, `docs/headless-web-build.md`, and `README.md` describe the portable `data/` model and need the dual-boot shared-`data/` setup note.
16. `src/backend/sqlite-config.ts:24` — `files.absolutePath TEXT NOT NULL UNIQUE`; `:119` FTS mirror on `absolutePath`; `:77` `visual_hashes.absolutePath UNIQUE`. Uniqueness/identity to move onto `(locationId, relativePath)`.
17. `src/backend/sqlite-backend.ts:625` — `createFilesFromPath` dedups via `WHERE absolutePath LIKE path||'%'`; `:961` visual-hash read/write keyed on `absolutePath`.
18. `src/frontend/stores/LocationStore.ts:132` — reconciliation `dbFilesPathSet`; `:205` `createdPaths`; `:213` `missingFiles`; `:304` update scan — all compare stored `absolutePath` and must key on portable identity through the seam.
19. `src/api/visual-hash.ts` — visual-hash DTO keyed on `absolutePath`; `src/frontend/workers/VisualSimilarityManager.ts:231` (+`:247`,`:345`) consumers; `src/frontend/stores/FileStore.ts:2433` removal. Same absolute-path-key defect class as the thumbnail cache.
20. `src/frontend/stores/LocationStore.ts:664` — `removeSublocationFiles` uses `searchFiles('absolutePath','startsWith', subLoc.path)`; silently no-ops cross-OS until keyed on `relativePath`.
21. `src/frontend/platform/index.ts:125` — `normalizePathIdentity` folds case by running-OS (wired at `src/frontend/platform/platform.electron.ts:77`); must fold by the library filesystem's case-sensitivity for a shared tree.
22. `src/frontend/stores/LocationStore.ts:352` — `changeLocationPath` rewrites `absolutePath`/`path` but predates the anchor; must update or clear the portable anchor so the next boot does not override a manual re-point.
