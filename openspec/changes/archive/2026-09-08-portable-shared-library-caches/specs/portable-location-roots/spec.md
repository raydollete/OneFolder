## Purpose

Defines how a OneFolder location root may be stored relative to the portable application directory and resolved per operating system at load time, so a single shared library works from a dual-boot install (or any relocated portable unit) without the user re-pointing the location on each switch.

## ADDED Requirements

### Requirement: A location root may be anchored to the portable directory

A location MAY be stored as **portable-anchored**: instead of (or in addition to) a fixed absolute root, it retains a root-relative segment that is resolved against the current portable directory each time the library loads. When a location is portable-anchored, its effective root path SHALL be computed at load as the current portable directory joined with the stored relative segment. When a location is not anchored (for example, one on an external drive outside the portable directory), its effective root path SHALL remain the stored absolute path unchanged.

#### Scenario: Anchored location resolves under the current portable root on each OS

- **WHEN** a portable-anchored location with segment `Photos` is loaded from a shared library whose portable directory is `D:\OneFolder` on Windows and `/mnt/shared/OneFolder` on Linux
- **THEN** the location's effective root resolves to `D:\OneFolder\Photos` on Windows and `/mnt/shared/OneFolder/Photos` on Linux, and the location is not marked broken on either OS

#### Scenario: Unanchored external location keeps its absolute path

- **WHEN** a location whose root lies outside the portable directory (for example, an external drive) is loaded
- **THEN** its effective root is the stored absolute path, unchanged, on every OS

#### Scenario: Anchored location whose resolved path is missing falls back to recovery

- **WHEN** a portable-anchored location resolves to a path that does not exist on the current system
- **THEN** the location is marked broken and the existing Location Recovery flow is offered, exactly as for a missing absolute location

### Requirement: Existing locations under the portable directory are migrated to anchored automatically

On upgrade, any existing location whose absolute root lies within the current portable directory SHALL be converted to portable-anchored form by recording its root-relative segment, so previously-created libraries gain portability without manual action. Locations whose root lies outside the portable directory SHALL be left as absolute. The migration SHALL be idempotent: running it again makes no further change.

#### Scenario: Existing location inside the portable directory becomes anchored

- **WHEN** a library created before this change contains a location at `D:\OneFolder\Photos` and the portable directory is `D:\OneFolder`
- **THEN** after migration the location is portable-anchored with segment `Photos`, and re-running the migration leaves it unchanged

#### Scenario: Existing location outside the portable directory stays absolute

- **WHEN** a library contains a location at `E:\Archive` that is not within the portable directory
- **THEN** the migration leaves it as an unanchored absolute location

### Requirement: Loading a shared library on a different OS neither duplicates nor orphans files

A file's durable identity SHALL be its position within its location — the `(locationId, relativePath)` pair — not its absolute path. Loading the same shared library from a different operating system, where the location root resolves to a different absolute path, SHALL match each stored file to the same file on disk: no stored file is re-inserted as a new entry, and no stored file is falsely reported missing. Any absolute path retained per file SHALL be a derived value recomputed from the resolved location root, never the durable identity.

#### Scenario: Cross-boot load reuses existing entries

- **WHEN** a shared library first created on Windows (files stored under `D:\OneFolder\Photos\…`) is opened on Linux, where the same location resolves to `/mnt/shared/OneFolder/Photos`
- **THEN** every existing file entry is matched to its file on disk by `(locationId, relativePath)`, and no duplicate entries are created and no entries are marked missing

#### Scenario: Case-distinct siblings stay distinct on a case-sensitive shared tree

- **WHEN** the shared library's filesystem is case-sensitive and a location contains two sibling files `A.jpg` and `a.jpg`
- **THEN** they are treated as two distinct files with independent identities and metadata, and neither shadows the other nor has its tags transferred to the other

### Requirement: Anchored segments preserve real on-disk case

A portable-anchored location's stored relative segment SHALL preserve the real on-disk case of each path component, so that resolution succeeds on a case-sensitive filesystem. Resolution and identity comparison SHALL treat the segment through the shared path-identity rules (case-insensitive only where the platform is), so the same shared library behaves correctly whether opened on a case-insensitive (Windows) or case-sensitive (Linux) filesystem.

#### Scenario: Segment case is preserved for a case-sensitive filesystem

- **WHEN** a location under the portable directory is anchored from a folder named `Photos`
- **THEN** the stored segment is `Photos` (not folded to `photos`), so the location resolves on a case-sensitive Linux filesystem
