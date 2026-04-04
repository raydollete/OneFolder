/**
 * One-time migration tool: IndexedDB/Dexie → SQLite
 *
 * Exports all data from the existing Dexie database and imports it into the new
 * SQLite database.  The migration is idempotent — a flag file written after a
 * successful run prevents it from running again on subsequent launches.
 *
 * The IndexedDB data is intentionally preserved after migration so that users
 * have a safety net.  They can remove it manually via DevTools or a future
 * cleanup option.
 */

import Database from 'better-sqlite3';
import fse from 'fs-extra';
import path from 'path';

import { DismissedDuplicateGroupDTO } from '../api/dismissed-duplicate-group';
import { FileDTO } from '../api/file';
import { FileSearchDTO } from '../api/file-search';
import { LocationDTO } from '../api/location';
import { TagDTO } from '../api/tag';
import { VisualHashDTO } from '../api/visual-hash';
import { DB_NAME, dbInit } from './config';
import { sqliteInit } from './sqlite-config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Name of the flag file written into the userData directory after a successful
 * migration.  Its presence is the primary idempotency check — it is faster
 * than opening the SQLite DB and counting rows, and it survives a later
 * `clear()` of the SQLite database.
 */
const MIGRATION_FLAG_FILENAME = 'migration-complete.flag';

// ---------------------------------------------------------------------------
// Date serialization helpers
// ---------------------------------------------------------------------------

/**
 * Converts a value that Dexie may store as a JS Date object, an ISO string,
 * a numeric timestamp, or null/undefined into a reliable ISO 8601 string.
 *
 * Dexie stores Date objects natively.  In practice some records may already
 * contain strings (e.g. after a JSON round-trip through an old backup), so we
 * handle all cases defensively.
 */
function toIso(value: Date | string | number | null | undefined): string {
  if (value == null) {
    return new Date().toISOString();
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }
  // String or number — try to parse
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the migration flag file exists in the userData directory
 * alongside the SQLite database path.
 */
async function isMigrationComplete(sqliteDbPath: string): Promise<boolean> {
  const userDataDir = path.dirname(sqliteDbPath);
  const flagPath = path.join(userDataDir, MIGRATION_FLAG_FILENAME);
  return fse.pathExists(flagPath);
}

/**
 * Writes the migration-complete flag file.  Called only after a fully
 * committed SQLite transaction so that a crash before this point causes a
 * clean retry on the next launch.
 */
async function writeMigrationFlag(sqliteDbPath: string): Promise<void> {
  const userDataDir = path.dirname(sqliteDbPath);
  const flagPath = path.join(userDataDir, MIGRATION_FLAG_FILENAME);
  await fse.outputFile(
    flagPath,
    `migrated_from_indexeddb=true\ntimestamp=${new Date().toISOString()}\n`,
  );
}

// ---------------------------------------------------------------------------
// IndexedDB extraction
// ---------------------------------------------------------------------------

/**
 * Checks whether the Dexie database contains any data worth migrating.
 * Returns false if the database does not exist or is empty across all tables.
 */
async function dexieHasData(db: ReturnType<typeof dbInit>): Promise<boolean> {
  try {
    // If the database hasn't been opened yet this triggers a version check.
    // Querying the smallest table (tags) is cheap enough to use as a proxy.
    const tagCount = await db.table('tags').count();
    const fileCount = await db.table('files').count();
    return tagCount > 0 || fileCount > 0;
  } catch (_e) {
    // Database does not exist or schema is unrecognised — nothing to migrate.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the IndexedDB → SQLite migration if it has not already been completed.
 *
 * @param sqliteDbPath  Absolute path to the SQLite `.db` file that the new
 *                      SQLiteBackend will use.
 * @returns             `true` if a migration was performed, `false` if it was
 *                      skipped (already done or no source data found).
 */
export async function migrateIfNeeded(sqliteDbPath: string): Promise<boolean> {
  // --- Step 2: Check the idempotency flag first (cheap path) ---------------
  if (await isMigrationComplete(sqliteDbPath)) {
    console.info('Migration: already complete, skipping.');
    return false;
  }

  // --- Step 3a: Open the Dexie database ------------------------------------
  const dexieDb = dbInit(DB_NAME);

  // If Dexie has no data there is nothing to migrate.
  const hasData = await dexieHasData(dexieDb);
  if (!hasData) {
    console.info('Migration: no IndexedDB data found, marking complete and skipping.');
    // Write the flag so we never check again.
    await writeMigrationFlag(sqliteDbPath);
    return false;
  }

  console.info('Migration: IndexedDB data detected — starting migration to SQLite.');

  // --- Step 3b: Read all data from each Dexie table ------------------------
  const [files, tags, locations, searches, dismissedGroups, visualHashes] = await Promise.all([
    dexieDb.table('files').toArray() as Promise<FileDTO[]>,
    dexieDb.table('tags').toArray() as Promise<TagDTO[]>,
    dexieDb.table('locations').toArray() as Promise<LocationDTO[]>,
    dexieDb.table('searches').toArray() as Promise<FileSearchDTO[]>,
    dexieDb.table('dismissedDuplicateGroups').toArray() as Promise<DismissedDuplicateGroupDTO[]>,
    dexieDb.table('visualHashes').toArray() as Promise<VisualHashDTO[]>,
  ]);

  console.info(
    `Migration: read from IndexedDB — ${files.length} files, ${tags.length} tags, ` +
      `${locations.length} locations, ${searches.length} searches, ` +
      `${dismissedGroups.length} dismissed duplicate groups, ${visualHashes.length} visual hashes.`,
  );

  // --- Step 3c: Open the SQLite database -----------------------------------
  // sqliteInit creates the file and applies schema migrations if needed.
  const sqliteDb: Database.Database = sqliteInit(sqliteDbPath);

  // --- Step 3d: Insert all data in a single transaction --------------------
  // The transaction ensures that a partial failure leaves the SQLite database
  // in its pre-migration state (all rows rolled back).  The flag file is
  // written only after the transaction commits successfully.
  try {
    const migrate = sqliteDb.transaction(() => {
      // ---- files + file_tags ----
      const insertFile = sqliteDb.prepare(`
        INSERT OR IGNORE INTO files
          (id, ino, locationId, relativePath, absolutePath, name, extension, size,
           width, height, dateAdded, dateModified, dateCreated, dateLastIndexed, annotations)
        VALUES
          (@id, @ino, @locationId, @relativePath, @absolutePath, @name, @extension, @size,
           @width, @height, @dateAdded, @dateModified, @dateCreated, @dateLastIndexed, @annotations)
      `);

      const insertFileTag = sqliteDb.prepare(
        'INSERT OR IGNORE INTO file_tags (fileId, tagId) VALUES (?, ?)',
      );

      for (const file of files) {
        // Treat the raw Dexie record as `any` to safely access fields that may
        // be absent on records written by older schema versions.
        const rawFile = file as any;
        insertFile.run({
          id: file.id,
          ino: rawFile.ino || '',
          locationId: file.locationId,
          relativePath: file.relativePath,
          absolutePath: file.absolutePath,
          name: file.name,
          extension: file.extension,
          size: file.size,
          width: file.width,
          height: file.height,
          dateAdded: toIso(file.dateAdded),
          dateModified: toIso(file.dateModified),
          dateCreated: toIso(file.dateCreated),
          // dateLastIndexed was added in Dexie schema v6; fall back to dateAdded
          // if the field is absent on older records.
          dateLastIndexed: toIso(rawFile.dateLastIndexed || file.dateAdded),
          annotations: rawFile.annotations || '{}',
        });

        // Populate the file_tags junction table from the embedded tags array.
        const tagIds: string[] = Array.isArray(file.tags) ? file.tags : [];
        for (const tagId of tagIds) {
          insertFileTag.run(file.id, tagId);
        }
      }

      // ---- tags ----
      const insertTag = sqliteDb.prepare(`
        INSERT OR IGNORE INTO tags (id, name, dateAdded, color, subTags, isHidden)
        VALUES (@id, @name, @dateAdded, @color, @subTags, @isHidden)
      `);

      for (const tag of tags) {
        const rawTag = tag as any;
        insertTag.run({
          id: tag.id,
          name: tag.name,
          dateAdded: toIso(tag.dateAdded),
          color: rawTag.color || '',
          subTags: JSON.stringify(Array.isArray(tag.subTags) ? tag.subTags : []),
          isHidden: tag.isHidden ? 1 : 0,
        });
      }

      // ---- locations ----
      const insertLocation = sqliteDb.prepare(`
        INSERT OR IGNORE INTO locations (id, path, dateAdded, subLocations, "index")
        VALUES (@id, @path, @dateAdded, @subLocations, @index)
      `);

      for (const location of locations) {
        const rawLoc = location as any;
        insertLocation.run({
          id: location.id,
          path: location.path,
          dateAdded: toIso(location.dateAdded),
          subLocations: JSON.stringify(
            Array.isArray(location.subLocations) ? location.subLocations : [],
          ),
          index: rawLoc.index || 0,
        });
      }

      // ---- searches ----
      const insertSearch = sqliteDb.prepare(`
        INSERT OR IGNORE INTO searches (id, name, criteria, matchAny, "index")
        VALUES (@id, @name, @criteria, @matchAny, @index)
      `);

      for (const search of searches) {
        const rawSearch = search as any;
        insertSearch.run({
          id: search.id,
          name: search.name,
          criteria: JSON.stringify(Array.isArray(search.criteria) ? search.criteria : []),
          matchAny: search.matchAny ? 1 : 0,
          index: rawSearch.index || 0,
        });
      }

      // ---- dismissedDuplicateGroups ----
      const insertDismissed = sqliteDb.prepare(`
        INSERT OR IGNORE INTO dismissedDuplicateGroups
          (id, groupHash, algorithm, fileIds, dismissedAt, userNote)
        VALUES (@id, @groupHash, @algorithm, @fileIds, @dismissedAt, @userNote)
      `);

      for (const group of dismissedGroups) {
        insertDismissed.run({
          id: group.id,
          groupHash: group.groupHash,
          algorithm: group.algorithm,
          fileIds: group.fileIds,
          dismissedAt: toIso(group.dismissedAt),
          userNote: group.userNote ?? null,
        });
      }

      // ---- visualHashes ----
      // The Dexie auto-increment id is intentionally not carried over.
      // SQLite's AUTOINCREMENT on the INTEGER PRIMARY KEY will assign new ids.
      const insertVisualHash = sqliteDb.prepare(`
        INSERT OR IGNORE INTO visualHashes
          (absolutePath, fileSize, dateModified, hashType, hash, dateComputed, thumbnailPath)
        VALUES
          (@absolutePath, @fileSize, @dateModified, @hashType, @hash, @dateComputed, @thumbnailPath)
      `);

      for (const vh of visualHashes) {
        insertVisualHash.run({
          absolutePath: vh.absolutePath,
          fileSize: vh.fileSize,
          dateModified: toIso(vh.dateModified),
          hashType: vh.hashType,
          hash: vh.hash,
          dateComputed: toIso(vh.dateComputed),
          thumbnailPath: vh.thumbnailPath ?? null,
        });
      }
    });

    migrate();

    // --- Step 3e: Write the migration-complete marker ----------------------
    // This is done AFTER the transaction commits so that a crash during the
    // transaction leaves the flag unwritten and the migration retries cleanly.
    await writeMigrationFlag(sqliteDbPath);

    // --- Step 3f: Log the migration result ---------------------------------
    console.info(
      `Migration: complete. Migrated ${files.length} files, ${tags.length} tags, ` +
        `${locations.length} locations, ${searches.length} searches, ` +
        `${dismissedGroups.length} dismissed duplicate groups, ` +
        `${visualHashes.length} visual hashes.`,
    );

    return true;
  } catch (err) {
    // --- Step 4: Error handling --------------------------------------------
    // The SQLite transaction rolls back automatically when the function throws.
    // The migration-complete flag is not written, so the migration will be
    // retried on the next launch.
    console.error(
      'Migration: failed — SQLite transaction rolled back. Will retry on next launch.',
      err,
    );
    throw err;
  } finally {
    // Close the SQLite database opened for migration. The caller (renderer.tsx)
    // will open a fresh connection via sqliteInit() after this function returns.
    sqliteDb.close();
  }
}
