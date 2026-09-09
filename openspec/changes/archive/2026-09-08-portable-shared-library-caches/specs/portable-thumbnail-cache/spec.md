## Purpose

Defines how OneFolder keys its path-derived caches (thumbnails, full-size previews, and perceptual visual-hash entries) so that the key is portable and OS-independent, letting a shared cache be reused across a dual-boot install or a relocated library instead of being regenerated, with a one-time migration off the legacy absolute-path key.

## ADDED Requirements

### Requirement: Path-derived cache entries are keyed on a portable identity

The key of any cache entry derived from a source file — a thumbnail, a full-size preview, or a perceptual visual-hash — SHALL be derived from a portable, OS-independent identity of that file within its library, identical for the same file regardless of the operating system, the drive/mount prefix, or a later change to the location root. The key SHALL be unique per file within a library, so two distinct files never resolve to the same cache entry. All cache producers SHALL derive the key from a single shared helper, so no producer re-implements it and a new cache is portable by construction.

#### Scenario: Visual-hash entry is reused across OSes, not recomputed

- **WHEN** a file's perceptual visual-hash was computed on one OS and the shared library is later opened on the other OS
- **THEN** the existing visual-hash entry is found and reused, no second entry is written for the same file, and the hash is not recomputed

#### Scenario: Same photo yields the same cache filename on both OSes

- **WHEN** the same photo in one shared library is served on Windows (absolute path `D:\OneFolder\Photos\a.jpg`) and on Linux (absolute path `/mnt/shared/OneFolder/Photos/a.jpg`)
- **THEN** its thumbnail cache entry has the same filename on both OSes, so a shared cache directory is reused and the thumbnail is not regenerated

#### Scenario: Re-pointing a location root does not change the cache key

- **WHEN** a location's root path is changed (via recovery, migration, or anchoring) while the file's position within the location is unchanged
- **THEN** the file's thumbnail and preview cache entries keep the same names and are not regenerated

#### Scenario: Distinct files never collide

- **WHEN** two different files exist in the library, including two with the same basename in different folders
- **THEN** they resolve to different cache entry names

### Requirement: Thumbnail and preview caches share one key derivation

The thumbnail cache and the full-size preview cache SHALL derive their entry names from the same identity and the same hashing rule, so the two families stay consistent and there is a single source of truth for the cache key (no divergent re-implementation).

#### Scenario: Preview key matches thumbnail key scheme

- **WHEN** a thumbnail and a preview are computed for the same source file
- **THEN** both are named from the same portable identity using the same hash, differing only by their cache directory and any format suffix

### Requirement: Existing caches are migrated off the legacy absolute-path key

On upgrade, existing thumbnail and preview cache entries that were named under the legacy absolute-path key SHALL be migrated to the new portable key by renaming in place, so an existing library of thousands of entries is not forced to regenerate. The migration SHALL be best-effort and idempotent: an entry whose legacy name cannot be matched is left for lazy regeneration on next access rather than duplicated, and re-running the migration makes no further change.

#### Scenario: Existing thumbnail is renamed, not rebuilt

- **WHEN** an upgraded library has an existing thumbnail named under the legacy absolute-path key for a file that is still present
- **THEN** the entry is renamed to its new portable-key name and the thumbnail is not regenerated

#### Scenario: Unmatched legacy entry regenerates lazily without duplication

- **WHEN** a legacy cache entry cannot be matched to a current file during migration
- **THEN** it is not renamed, and the corresponding thumbnail is regenerated on next access without creating a duplicate cache entry
