import { randomUUID } from 'crypto';
import path from 'path';
import fse from 'fs-extra';
import { LibraryDTO } from '../src/api/library';
import { SQLITE_DB_FILENAME } from '../src/backend/sqlite-config';

// ---------------------------------------------------------------------------
// File-level storage paths (relative to basePath)
// ---------------------------------------------------------------------------

const LIBRARIES_FILE = 'libraries.json';
const ACTIVE_LIBRARY_FILE = 'active-library.json';

type ActiveLibraryFile = { activeLibraryId: string };

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------
// LibraryDTO uses Date objects, but JSON.parse produces plain strings.
// These helpers convert between the two representations.

function deserializeLibrary(raw: Record<string, unknown>): LibraryDTO {
  return {
    id: raw.id as string,
    name: raw.name as string,
    createdAt: new Date(raw.createdAt as string),
    lastOpenedAt: new Date(raw.lastOpenedAt as string),
  };
}

function serializeLibraries(libraries: LibraryDTO[]): unknown[] {
  return libraries.map((lib) => ({
    id: lib.id,
    name: lib.name,
    createdAt: lib.createdAt.toISOString(),
    lastOpenedAt: lib.lastOpenedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// LibraryRegistry
// ---------------------------------------------------------------------------

/**
 * Manages the list of known libraries, persisted to `{basePath}/libraries.json`.
 * The currently active library is tracked in `{basePath}/active-library.json`.
 *
 * All writes are synchronous so they complete before the caller proceeds —
 * this class is only used at startup/shutdown where async would complicate
 * Electron's `initialize()` flow.
 */
export class LibraryRegistry {
  private readonly basePath: string;
  private readonly librariesPath: string;
  private readonly activeLibraryPath: string;

  private libraries: LibraryDTO[];

  constructor(basePath: string) {
    this.basePath = basePath;
    this.librariesPath = path.join(basePath, LIBRARIES_FILE);
    this.activeLibraryPath = path.join(basePath, ACTIVE_LIBRARY_FILE);
    this.libraries = this.load();
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  getLibraries(): LibraryDTO[] {
    return this.libraries;
  }

  getActiveLibraryId(): string | null {
    try {
      const data = fse.readJSONSync(this.activeLibraryPath) as ActiveLibraryFile;
      return data.activeLibraryId ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  setActiveLibrary(id: string): void {
    fse.writeJSONSync(this.activeLibraryPath, { activeLibraryId: id } as ActiveLibraryFile);
  }

  createLibrary(name: string): LibraryDTO {
    const now = new Date();
    const library: LibraryDTO = {
      id: randomUUID(),
      name,
      createdAt: now,
      lastOpenedAt: now,
    };
    this.libraries.push(library);
    this.save();
    return library;
  }

  renameLibrary(id: string, name: string): void {
    const library = this.libraries.find((l) => l.id === id);
    if (library) {
      library.name = name;
      this.save();
    }
  }

  /**
   * Removes a library from the registry.
   * Does NOT delete the library's database, backups, or thumbnail cache —
   * that is the caller's responsibility.
   */
  deleteLibrary(id: string): void {
    this.libraries = this.libraries.filter((l) => l.id !== id);
    this.save();
  }

  updateLastOpened(id: string): void {
    const library = this.libraries.find((l) => l.id === id);
    if (library) {
      library.lastOpenedAt = new Date();
      this.save();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private load(): LibraryDTO[] {
    try {
      const raw = fse.readJSONSync(this.librariesPath) as Record<string, unknown>[];
      return raw.map(deserializeLibrary);
    } catch {
      // File does not exist yet (fresh install or first upgrade)
      return [];
    }
  }

  private save(): void {
    fse.writeJSONSync(this.librariesPath, serializeLibraries(this.libraries), { spaces: 2 });
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the set of per-library directory paths that live alongside the
 * library's SQLite database inside `{basePath}/libraries/{libraryId}/`.
 */
export function getLibraryPaths(basePath: string, libraryId: string) {
  return {
    backupDir: path.join(basePath, 'libraries', libraryId, 'backups'),
    // Thumbnail dir lives in temp (system or portable), handled separately by
    // RendererMessenger.getDefaultThumbnailDirectory(libraryId).
  };
}

/**
 * Returns the absolute path to the SQLite database file for a given library.
 * Layout: `{basePath}/libraries/{libraryId}/onefolder.db`
 */
export function getSqliteDbPath(basePath: string, libraryId: string): string {
  return path.join(basePath, 'libraries', libraryId, SQLITE_DB_FILENAME);
}
