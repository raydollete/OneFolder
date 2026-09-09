# Design — portable-shared-library-caches

## Approach

The change re-bases a file's durable identity from its absolute path onto the portable pair `(locationId, relativePath)`, then makes location roots and every path-derived cache follow that identity. File-level plan:

- **Identity helper (`common/fs.ts`)**: add `portableFileKey(locationId, relativePath)` and a single exported `hashString`; rewrite `getThumbnailPath` to take the portable key instead of `absolutePath`. `src/server/thumbnails.ts` `getPreviewPath` imports the same helper (delete the duplicated `hashFilePath`).
- **Location anchor (`src/api/location.ts`, `entities/Location.ts`)**: `LocationDTO` gains an optional `portableRoot?: string` relative segment. `ClientLocation` resolves its effective `path` at construction from the injected portable root when anchored, else uses the stored absolute path. A portable-root provider reads `dirname(RendererMessenger.getPath('userData'))` once and is threaded into the centralized construction sites (`LocationStore.ts:97,366,395`).
- **Persistence identity (`src/backend/sqlite-config.ts`, `sqlite-backend.ts`)**: uniqueness and dedup move to `(locationId, relativePath)`; `absolutePath` becomes a derived per-OS column recomputed at hydration. FTS and `createFilesFromPath` follow.
- **Reconciliation (`src/frontend/stores/LocationStore.ts`)**: created/missing/moved sets and `removeSublocationFiles` key on `relativePath` through the platform path-identity seam — no raw `absolutePath` `Set`/`LIKE`.
- **Derived caches**: thumbnails, previews, and the perceptual **visual-hash** cache (`src/api/visual-hash.ts`, `sqlite-backend.ts:961`, `VisualSimilarityManager.ts`) all key on the shared `portableFileKey`.
- **Case policy**: detect the library filesystem's case-sensitivity once and thread it into `normalizePathIdentity` (replacing the running-OS `foldCase` at `platform.electron.ts:77`).
- **Migrations (`sqlite-config.ts` migration list + a flag helper)**: auto-anchor locations under the portable root; backfill identity + new uniqueness; rename existing thumbnail/preview/visual-hash caches to the new key (destination-exists-safe, lazy on miss). Markers are shared-`data/`-safe.
- **Docs**: `docs/multi-library.md`, `docs/headless-web-build.md`, `README.md`.

## Context

See proposal.md — Why. Constraints that shape the approach: `ClientFile.absolutePath` is already reconstructed at runtime as `join(location.path, relativePath)` (`entities/File.ts:88`), so the runtime layer is *already* portable — only the persistence layer and the path-hash caches treat the absolute path as identity. The app runs one OS at a time against a shared `data/` (both executables in one directory); SQLite locking already forbids concurrent use. A prior IndexedDB→SQLite migration established the migration machinery (`sqlite-config.ts` version list; flag-file idempotency in `migration-indexeddb-to-sqlite.ts`).

## Goals / Non-Goals

**Goals:**
- One shared library loads on both OSes with no per-boot Location Recovery and no duplicated/orphaned rows.
- No path-derived cache (thumbnail, preview, visual-hash) regenerates on OS switch; existing caches are renamed, not rebuilt.
- One canonical identity `(locationId, relativePath)` and one shared cache-key helper, enforceably (no raw absolute-path comparisons reintroduced).

**Non-Goals:**
- Cross-*library* portability (two separate DBs). Identity is scoped within one shared library, where `locationId` is stable.
- Simultaneous multi-OS access to one library (SQLite lock; one OS at a time).
- Content-hash identity (bytes). `(locationId, relativePath)` is the identity; perceptual hashes remain a derived cache, not identity.
- Changing the on-disk photo layout or the EXIF/XMP metadata model.

## Decisions

- **Identity = `(locationId, relativePath)`, `absolutePath` demoted to a derived per-OS column.** Chosen over (a) keeping `absolutePath` as identity but bulk-rewriting it every boot — rejected: preserves the wrong abstraction, and each new cache/table re-learns the lesson (the visual-hash cache already did); and (b) content-hash identity — rejected: expensive at index time and overkill when position already identifies the file. Re-basing dissolves the duplication (Finding A), the dedup mismatch (Finding B), the visual-hash re-derivation (Finding E), and the sublocation no-op (Finding F) at one root.
- **Anchor stored as a relative segment + presence flag on the location; resolved at hydration.** Chosen over rewriting the stored absolute path in place (what `changeLocationPath` does today): rewriting per boot is O(n) writes and still leaves identity on the absolute path. Anchoring stores the portable intent once; unanchored locations (external drives) keep absolute paths.
- **Case-fold policy keyed on the library filesystem, not the running OS.** A shared tree is one physical filesystem; folding by `IS_WIN` lets a Windows boot merge `A.jpg`/`a.jpg` and transfer/drop tags (Finding C). Detect case-sensitivity once at library open and thread it into `normalizePathIdentity`. Alternative — always case-sensitive — rejected: breaks legitimate Windows libraries that rely on case-insensitive identity.
- **One `portableFileKey` helper imported by every cache producer; hash unified in `common/fs.ts`.** The server's `hashFilePath` is a byte-identical copy (Finding I); collapsing it keeps desktop and sidecar agreeing on the key (`images.ts:181,319`).
- **Migrations are re-entrant and shared-`data/`-aware.** `user_version` set to the true max applied migration (not a hand-maintained constant, `sqlite-config.ts:204`); the cache-rename destination-exists-safe; any per-OS marker carries an OS discriminator (or lives in the shared DB) so one OS's completion does not suppress the other's (Finding D).

## Risks / Trade-offs

- **Files-table schema migration on a real thousands-entry library** → stage behind a DB backup (existing backup scheduler), make each step idempotent, and gate the new `UNIQUE(locationId, relativePath)` creation on a pre-pass that resolves any legacy duplicate rows rather than failing the constraint.
- **Backfilling `relativePath` for legacy rows where it is empty/stale** → recompute via `relativePathFromLocation` from the resolved root before enforcing uniqueness; rows that cannot be reconciled fall back to the recovery UI, never silent deletion.
- **Case-sensitivity detection wrong on exotic mounts (exFAT, case-folded NTFS)** → probe empirically (create/stat a case-flipped temp name in `data/`) rather than infer from OS; document the limitation.
- **Cache rename partial completion / interrupted migration** → best-effort + lazy regeneration means an interrupted run self-heals on next access; no entry is deleted, only renamed or left.
- **`changeLocationPath` and anchoring interacting** → a manual re-point must update/clear the anchor (Finding H) or the next boot re-resolves and overrides it.

## Migration Plan

1. **Backup** the library DB (reuse the existing backup path) before schema changes.
2. **Schema**: add the location anchor column; add `(locationId, relativePath)` uniqueness to `files` and `visualHashes`; rebuild the FTS mirror off `relativePath`. Set `user_version` to the true max applied migration version.
3. **Backfill**: recompute `relativePath` where needed; resolve any legacy duplicate `absolutePath` rows before the unique index; auto-anchor locations whose absolute root is under the portable directory.
4. **Cache rename**: for each file, rename existing thumbnail/preview/visual-hash entries from the legacy absolute-path key to `portableFileKey`; skip when the destination already exists (written by the other OS); leave unmatched entries for lazy regeneration.
5. **Idempotency/rollback**: every step guarded so a re-run is a no-op; on failure the pre-migration backup is the rollback. Markers are shared-`data/`-safe (DB `user_version` or OS-discriminated).

## External Review

External Review: Unavailable — peer-review (mcp__peer-review__peer_review) missing

<!-- radflow-lint --doctor reports the peer-review MCP server not detected in this session; ToolSearch confirms no mcp__peer-review__peer_review tool is reachable. Recorded Unavailable per the missing-server rule; no quorum could be attempted. -->

## Bomb-squad findings

Tier-3 latent-defect hunt (root cause + failure scenario, file:line). Must-handle findings are folded into the scope above; adjacent pre-existing defects are noted.

- **A. Reconciliation/dedup keyed on stored (other-OS) `absolutePath` → cross-boot doubles the library** (`wrong-abstraction`): `LocationStore.ts:132,205,213,304`, `sqlite-backend.ts:625`. On first other-OS boot every row mismatches → all "created" + all "missing", and `createFilesFromPath`'s `LIKE path||'%'` inserts a full duplicate set. Handled by identity re-basing.
- **B. `files.absolutePath UNIQUE` + FTS contradict portable identity** (`wrong-abstraction`): `sqlite-config.ts:24,119`. Two OS paths are distinct strings; the real key `(locationId, relativePath)` has no uniqueness. Handled.
- **C. OS-dependent case folding on a single shared tree → collision/data loss** (`missing-edge-case`): `platform/index.ts:125`, wired `platform.electron.ts:77`; consumed by `LocationStore.ts:732`. `A.jpg`/`a.jpg` merge on a Windows boot over a case-sensitive share. Handled via filesystem-keyed case policy.
- **D. Migration idempotency + shared-`data/` dual writers** (`order-of-operations`): `sqlite-config.ts:204` sets `user_version` to a constant; the flag file (`migration-indexeddb-to-sqlite.ts:36`) lives in the now-shared `userData`. Handled via true-max `user_version`, destination-exists-safe rename, OS-discriminated markers.
- **E. Visual-hash cache has the same absolute-path key** (`wrong-abstraction`): `api/visual-hash.ts`, `sqlite-config.ts:77`, `sqlite-backend.ts:961`, `VisualSimilarityManager.ts:231,247,345`, `FileStore.ts:2433`. Cross-boot recomputes every perceptual hash and writes duplicate/orphan rows. Handled (re-keyed).
- **F. `removeSublocationFiles` silently no-ops cross-OS** (`silent-failure`): `LocationStore.ts:664` `searchFiles('absolutePath','startsWith', subLoc.path)`. Fixed by relativePath-keyed query.
- **G. Reconciliation existence checks bypass the path-identity seam** (adjacent): `LocationStore.ts:132,205,304` raw `Set.has`/`Map.get`. Route through the seam while reworking these keys.
- **H. `changeLocationPath` does not touch the portable anchor** (in-scope reconcile): `LocationStore.ts:352`. A manual re-point must update/clear the anchor.
- **I. Duplicated hash implementation** (in P2 scope): `common/fs.ts:68` vs `src/server/thumbnails.ts:180`. Unify; ensure server routes (`images.ts:181,319`) adopt the unified key.
- **J. Face-annotation `source` = absolutePath is transient today** (note only): `utils/transformMWGRegionInfoToW3CAnnotation.ts:18`. Rebuilt from EXIF, not persisted — keep it that way; do not persist an absolute path in any future annotation-cache work.
