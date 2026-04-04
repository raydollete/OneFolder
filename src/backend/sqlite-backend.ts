import Database from 'better-sqlite3';

import { DataStorage } from '../api/data-storage';
import {
  ArrayConditionDTO,
  ConditionDTO,
  DateConditionDTO,
  NumberConditionDTO,
  OrderBy,
  OrderDirection,
  StringConditionDTO,
} from '../api/data-storage-search';
import { DismissedDuplicateGroupDTO } from '../api/dismissed-duplicate-group';
import { FileDTO } from '../api/file';
import { FileSearchDTO } from '../api/file-search';
import { ID } from '../api/id';
import { LocationDTO } from '../api/location';
import { ROOT_TAG_ID, TagDTO } from '../api/tag';
import { VisualHashDTO } from '../api/visual-hash';

// ---------------------------------------------------------------------------
// Row types — what better-sqlite3 returns from each table
// ---------------------------------------------------------------------------

interface FileRow {
  id: string;
  ino: string;
  locationId: string;
  relativePath: string;
  absolutePath: string;
  name: string;
  extension: string;
  size: number;
  width: number;
  height: number;
  dateAdded: string;
  dateModified: string;
  dateCreated: string;
  dateLastIndexed: string;
  annotations: string;
  // populated by GROUP_CONCAT in queries that join file_tags
  tagIds?: string | null;
}

interface TagRow {
  id: string;
  name: string;
  dateAdded: string;
  color: string;
  subTags: string;
  isHidden: number;
}

interface LocationRow {
  id: string;
  path: string;
  dateAdded: string;
  subLocations: string;
  index: number;
}

interface SearchRow {
  id: string;
  name: string;
  criteria: string;
  matchAny: number;
  index: number;
}

interface DismissedGroupRow {
  id: string;
  groupHash: string;
  algorithm: string;
  fileIds: string;
  dismissedAt: string;
  userNote?: string;
}

interface VisualHashRow {
  id?: number;
  absolutePath: string;
  fileSize: number;
  dateModified: string;
  hashType: string;
  hash: string;
  dateComputed: string;
  thumbnailPath?: string;
}

// ---------------------------------------------------------------------------
// DTO serialization helpers
// ---------------------------------------------------------------------------

/**
 * Converts a SQLite file row (ISO date strings, comma-separated tagIds) to
 * the FileDTO that the rest of the application expects.
 */
function fileRowToDTO(row: FileRow): FileDTO {
  return {
    id: row.id,
    ino: row.ino,
    locationId: row.locationId,
    relativePath: row.relativePath,
    absolutePath: row.absolutePath,
    name: row.name,
    extension: row.extension as FileDTO['extension'],
    size: row.size,
    width: row.width,
    height: row.height,
    dateAdded: new Date(row.dateAdded),
    dateModified: new Date(row.dateModified),
    dateCreated: new Date(row.dateCreated),
    dateLastIndexed: new Date(row.dateLastIndexed),
    annotations: row.annotations,
    tags: row.tagIds ? row.tagIds.split(',') : [],
  };
}

/**
 * Converts a FileDTO into the column values used when writing to the files
 * table. Tags are excluded — they live in file_tags and are handled separately.
 */
function fileDTOToRow(dto: FileDTO): Omit<FileRow, 'tagIds'> {
  return {
    id: dto.id,
    ino: dto.ino,
    locationId: dto.locationId,
    relativePath: dto.relativePath,
    absolutePath: dto.absolutePath,
    name: dto.name,
    extension: dto.extension,
    size: dto.size,
    width: dto.width,
    height: dto.height,
    dateAdded: dto.dateAdded.toISOString(),
    dateModified: dto.dateModified.toISOString(),
    dateCreated: dto.dateCreated.toISOString(),
    dateLastIndexed: dto.dateLastIndexed.toISOString(),
    annotations: dto.annotations,
  };
}

/** Converts a SQLite tag row to TagDTO. */
function tagRowToDTO(row: TagRow): TagDTO {
  return {
    id: row.id,
    name: row.name,
    dateAdded: new Date(row.dateAdded),
    color: row.color,
    subTags: JSON.parse(row.subTags) as ID[],
    isHidden: row.isHidden !== 0,
  };
}

/** Converts a SQLite location row to LocationDTO. */
function locationRowToDTO(row: LocationRow): LocationDTO {
  return {
    id: row.id,
    path: row.path,
    dateAdded: new Date(row.dateAdded),
    subLocations: JSON.parse(row.subLocations),
    index: row.index,
  };
}

/** Converts a SQLite search row to FileSearchDTO. */
function searchRowToDTO(row: SearchRow): FileSearchDTO {
  return {
    id: row.id,
    name: row.name,
    criteria: JSON.parse(row.criteria),
    matchAny: row.matchAny !== 0,
    index: row.index,
  };
}

/** Converts a SQLite dismissed-group row to DismissedDuplicateGroupDTO. */
function dismissedGroupRowToDTO(row: DismissedGroupRow): DismissedDuplicateGroupDTO {
  return {
    id: row.id,
    groupHash: row.groupHash,
    algorithm: row.algorithm,
    fileIds: row.fileIds,
    dismissedAt: new Date(row.dismissedAt),
    userNote: row.userNote,
  };
}

/** Converts a SQLite visual hash row to VisualHashDTO. */
function visualHashRowToDTO(row: VisualHashRow): VisualHashDTO {
  return {
    id: row.id !== undefined ? String(row.id) : undefined,
    absolutePath: row.absolutePath,
    fileSize: row.fileSize,
    dateModified: new Date(row.dateModified),
    hashType: row.hashType as VisualHashDTO['hashType'],
    hash: row.hash,
    dateComputed: new Date(row.dateComputed),
    thumbnailPath: row.thumbnailPath,
  };
}

// ---------------------------------------------------------------------------
// SQL query fragments shared across multiple methods
// ---------------------------------------------------------------------------

/**
 * The SELECT list used whenever we fetch files. The GROUP_CONCAT aggregates
 * all tag IDs from the file_tags junction table into a comma-separated string
 * that fileRowToDTO() splits back into an array.
 */
const FILE_SELECT = `
  SELECT
    f.id, f.ino, f.locationId, f.relativePath, f.absolutePath,
    f.name, f.extension, f.size, f.width, f.height,
    f.dateAdded, f.dateModified, f.dateCreated, f.dateLastIndexed,
    f.annotations,
    GROUP_CONCAT(ft.tagId) AS tagIds
  FROM files f
  LEFT JOIN file_tags ft ON f.id = ft.fileId
`;

const FILE_GROUP_BY = 'GROUP BY f.id';

// ---------------------------------------------------------------------------
// searchFiles helpers
// ---------------------------------------------------------------------------

interface SqlClause {
  sql: string;
  params: unknown[];
}

/**
 * Translates a single ConditionDTO into a SQL WHERE fragment and a list of
 * bound parameters.  The fragment references `f` as the alias for the files
 * table (consistent with FILE_SELECT above).
 */
function buildConditionClause(crit: ConditionDTO<FileDTO>): SqlClause {
  switch (crit.valueType) {
    case 'array':
      return buildArrayClause(crit as ArrayConditionDTO<FileDTO, ID>);
    case 'string':
      return buildStringClause(crit as StringConditionDTO<FileDTO>);
    case 'number':
      return buildNumberClause(crit as NumberConditionDTO<FileDTO>);
    case 'date':
      return buildDateClause(crit as DateConditionDTO<FileDTO>);
  }
}

function buildArrayClause(crit: ArrayConditionDTO<FileDTO, ID>): SqlClause {
  if (crit.value.length === 0) {
    // "contains nothing" means no tags at all on the file
    if (crit.operator === 'contains') {
      return {
        sql: 'NOT EXISTS (SELECT 1 FROM file_tags WHERE fileId = f.id)',
        params: [],
      };
    } else {
      // notContains [] → file has at least one tag
      return {
        sql: 'EXISTS (SELECT 1 FROM file_tags WHERE fileId = f.id)',
        params: [],
      };
    }
  }

  const placeholders = crit.value.map(() => '?').join(', ');
  if (crit.operator === 'contains') {
    return {
      sql: `EXISTS (SELECT 1 FROM file_tags WHERE fileId = f.id AND tagId IN (${placeholders}))`,
      params: crit.value,
    };
  } else {
    // notContains — file must not have ANY of the listed tags
    return {
      sql: `NOT EXISTS (SELECT 1 FROM file_tags WHERE fileId = f.id AND tagId IN (${placeholders}))`,
      params: crit.value,
    };
  }
}

function buildStringClause(crit: StringConditionDTO<FileDTO>): SqlClause {
  const col = `f.${crit.key}`;
  switch (crit.operator) {
    case 'equals':
      return { sql: `${col} = ?`, params: [crit.value] };
    case 'equalsIgnoreCase':
      return { sql: `${col} = ? COLLATE NOCASE`, params: [crit.value] };
    case 'notEqual':
      return { sql: `${col} != ?`, params: [crit.value] };
    case 'startsWith':
      return { sql: `${col} LIKE ? || '%'`, params: [crit.value] };
    case 'startsWithIgnoreCase':
      return { sql: `${col} LIKE ? || '%' COLLATE NOCASE`, params: [crit.value] };
    case 'notStartsWith':
      return { sql: `${col} NOT LIKE ? || '%' COLLATE NOCASE`, params: [crit.value] };
    case 'contains':
      return { sql: `${col} LIKE '%' || ? || '%' COLLATE NOCASE`, params: [crit.value] };
    case 'notContains':
      return { sql: `${col} NOT LIKE '%' || ? || '%' COLLATE NOCASE`, params: [crit.value] };
    default: {
      const _exhaustiveCheck: never = crit.operator;
      return _exhaustiveCheck;
    }
  }
}

function buildNumberClause(crit: NumberConditionDTO<FileDTO>): SqlClause {
  const col = `f.${crit.key}`;
  switch (crit.operator) {
    case 'equals':
      return { sql: `${col} = ?`, params: [crit.value] };
    case 'notEqual':
      return { sql: `${col} != ?`, params: [crit.value] };
    case 'smallerThan':
      return { sql: `${col} < ?`, params: [crit.value] };
    case 'smallerThanOrEquals':
      return { sql: `${col} <= ?`, params: [crit.value] };
    case 'greaterThan':
      return { sql: `${col} > ?`, params: [crit.value] };
    case 'greaterThanOrEquals':
      return { sql: `${col} >= ?`, params: [crit.value] };
    default: {
      const _exhaustiveCheck: never = crit.operator;
      return _exhaustiveCheck;
    }
  }
}

function buildDateClause(crit: DateConditionDTO<FileDTO>): SqlClause {
  const col = `f.${crit.key}`;
  // Build ISO strings for the start and end of the target day. SQLite stores
  // dates as ISO 8601 strings so lexicographic comparison works correctly.
  const dateStart = new Date(crit.value);
  dateStart.setHours(0, 0, 0, 0);
  const dateEnd = new Date(crit.value);
  dateEnd.setHours(23, 59, 59, 999);
  const startIso = dateStart.toISOString();
  const endIso = dateEnd.toISOString();

  switch (crit.operator) {
    case 'equals':
      return { sql: `(${col} >= ? AND ${col} <= ?)`, params: [startIso, endIso] };
    case 'notEqual':
      return { sql: `(${col} < ? OR ${col} > ?)`, params: [startIso, endIso] };
    case 'smallerThan':
      return { sql: `${col} < ?`, params: [startIso] };
    case 'smallerThanOrEquals':
      return { sql: `${col} <= ?`, params: [endIso] };
    case 'greaterThan':
      return { sql: `${col} > ?`, params: [endIso] };
    case 'greaterThanOrEquals':
      return { sql: `${col} >= ?`, params: [startIso] };
    default: {
      const _exhaustiveCheck: never = crit.operator;
      return _exhaustiveCheck;
    }
  }
}

// ---------------------------------------------------------------------------
// SQLiteBackend
// ---------------------------------------------------------------------------

/**
 * Implements the DataStorage interface using better-sqlite3.
 *
 * All queries are synchronous (better-sqlite3's model), but the public API
 * returns Promises so it is a drop-in replacement for the Dexie-based Backend.
 * Hot-path statements are prepared once at construction time.
 */
export default class SQLiteBackend implements DataStorage {
  readonly #db: Database.Database;
  readonly #notifyChange: () => void;

  // Prepared statements for the most frequently executed operations
  readonly #stmtInsertFile: Database.Statement;
  readonly #stmtDeleteFileTagsByFileId: Database.Statement;
  readonly #stmtInsertFileTag: Database.Statement;
  readonly #stmtInsertTag: Database.Statement;
  readonly #stmtUpsertTag: Database.Statement;
  readonly #stmtDeleteTag: Database.Statement;
  readonly #stmtDeleteFileTagsByTagId: Database.Statement;

  constructor(db: Database.Database, notifyChange: () => void) {
    console.info('SQLite: Initializing backend...');
    this.#db = db;
    this.#notifyChange = notifyChange;

    // Prepare hot-path statements at construction time so that SQLite compiles
    // each query plan only once rather than on every call.
    this.#stmtInsertFile = db.prepare(`
      INSERT INTO files
        (id, ino, locationId, relativePath, absolutePath, name, extension, size,
         width, height, dateAdded, dateModified, dateCreated, dateLastIndexed, annotations)
      VALUES
        (@id, @ino, @locationId, @relativePath, @absolutePath, @name, @extension, @size,
         @width, @height, @dateAdded, @dateModified, @dateCreated, @dateLastIndexed, @annotations)
    `);

    this.#stmtDeleteFileTagsByFileId = db.prepare('DELETE FROM file_tags WHERE fileId = ?');

    this.#stmtInsertFileTag = db.prepare(
      'INSERT OR IGNORE INTO file_tags (fileId, tagId) VALUES (?, ?)',
    );

    this.#stmtInsertTag = db.prepare(`
      INSERT INTO tags (id, name, dateAdded, color, subTags, isHidden)
      VALUES (@id, @name, @dateAdded, @color, @subTags, @isHidden)
    `);

    this.#stmtUpsertTag = db.prepare(`
      INSERT OR REPLACE INTO tags (id, name, dateAdded, color, subTags, isHidden)
      VALUES (@id, @name, @dateAdded, @color, @subTags, @isHidden)
    `);

    this.#stmtDeleteTag = db.prepare('DELETE FROM tags WHERE id = ?');

    this.#stmtDeleteFileTagsByTagId = db.prepare('DELETE FROM file_tags WHERE tagId = ?');
  }

  /**
   * Opens a SQLiteBackend on the given already-initialised Database and
   * creates the root tag if the tags table is empty. Mirrors Backend.init().
   */
  static async init(db: Database.Database, notifyChange: () => void): Promise<SQLiteBackend> {
    const backend = new SQLiteBackend(db, notifyChange);
    const tagCount = (db.prepare('SELECT COUNT(*) AS cnt FROM tags').get() as { cnt: number }).cnt;
    if (tagCount === 0) {
      db.prepare(
        `INSERT INTO tags (id, name, dateAdded, color, subTags, isHidden)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(ROOT_TAG_ID, 'Root', new Date().toISOString(), '', '[]', 0);
    }
    return backend;
  }

  // -------------------------------------------------------------------------
  // Read methods
  // -------------------------------------------------------------------------

  async fetchTags(): Promise<TagDTO[]> {
    console.info('SQLite: Fetching tags...');
    const rows = this.#db.prepare('SELECT * FROM tags').all() as TagRow[];
    return rows.map(tagRowToDTO);
  }

  async fetchFiles(order: OrderBy<FileDTO>, fileOrder: OrderDirection): Promise<FileDTO[]> {
    console.info('SQLite: Fetching files...');
    if (order === 'random') {
      const rows = this.#db
        .prepare(`${FILE_SELECT} ${FILE_GROUP_BY} ORDER BY RANDOM()`)
        .all() as FileRow[];
      return rows.map(fileRowToDTO);
    }

    const direction = fileOrder === OrderDirection.Desc ? 'DESC' : 'ASC';
    const rows = this.#db
      .prepare(`${FILE_SELECT} ${FILE_GROUP_BY} ORDER BY f.${order} ${direction}`)
      .all() as FileRow[];
    return rows.map(fileRowToDTO);
  }

  async fetchFilesByID(ids: ID[]): Promise<FileDTO[]> {
    console.info('SQLite: Fetching files by ID...');
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(`${FILE_SELECT} WHERE f.id IN (${placeholders}) ${FILE_GROUP_BY}`)
      .all(...ids) as FileRow[];
    return rows.map(fileRowToDTO);
  }

  async fetchFilesByKey(key: keyof FileDTO, value: string | number | Date): Promise<FileDTO[]> {
    console.info('SQLite: Fetching files by key/value...', { key, value });
    // Date values must be compared as ISO strings, matching the storage format.
    const sqlValue = value instanceof Date ? value.toISOString() : value;
    const rows = this.#db
      .prepare(`${FILE_SELECT} WHERE f.${key} = ? ${FILE_GROUP_BY}`)
      .all(sqlValue) as FileRow[];
    return rows.map(fileRowToDTO);
  }

  async fetchLocations(): Promise<LocationDTO[]> {
    console.info('SQLite: Fetching locations...');
    const rows = this.#db
      .prepare('SELECT * FROM locations ORDER BY dateAdded')
      .all() as LocationRow[];
    return rows.map(locationRowToDTO);
  }

  async fetchSearches(): Promise<FileSearchDTO[]> {
    console.info('SQLite: Fetching searches...');
    const rows = this.#db.prepare('SELECT * FROM searches').all() as SearchRow[];
    return rows.map(searchRowToDTO);
  }

  async searchFiles(
    criteria: ConditionDTO<FileDTO> | [ConditionDTO<FileDTO>, ...ConditionDTO<FileDTO>[]],
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    matchAny?: boolean,
  ): Promise<FileDTO[]> {
    console.info('SQLite: Searching files...', { criteria, matchAny });
    const criteriaArray = Array.isArray(criteria) ? criteria : [criteria];

    // Build WHERE clause fragments from each condition
    const clauses = criteriaArray.map(buildConditionClause);
    const conjunction = matchAny ? ' OR ' : ' AND ';
    const whereFragment = clauses.map((c) => c.sql).join(conjunction);
    const allParams = clauses.flatMap((c) => c.params);

    let sql: string;
    if (order === 'random') {
      sql = `${FILE_SELECT} WHERE ${whereFragment} ${FILE_GROUP_BY} ORDER BY RANDOM()`;
    } else {
      const direction = fileOrder === OrderDirection.Desc ? 'DESC' : 'ASC';
      sql = `${FILE_SELECT} WHERE ${whereFragment} ${FILE_GROUP_BY} ORDER BY f.${order} ${direction}`;
    }

    const rows = this.#db.prepare(sql).all(...allParams) as FileRow[];
    return rows.map(fileRowToDTO);
  }

  // -------------------------------------------------------------------------
  // Create methods
  // -------------------------------------------------------------------------

  async createTag(tag: TagDTO): Promise<void> {
    console.info('SQLite: Creating tag...', tag);
    this.#stmtInsertTag.run({
      id: tag.id,
      name: tag.name,
      dateAdded: tag.dateAdded.toISOString(),
      color: tag.color,
      subTags: JSON.stringify(tag.subTags),
      isHidden: tag.isHidden ? 1 : 0,
    });
    this.#notifyChange();
  }

  async createFilesFromPath(path: string, files: FileDTO[]): Promise<void> {
    console.info('SQLite: Creating files from path...', path, files.length);

    const insertFiles = this.#db.transaction((newFiles: FileDTO[]) => {
      // Fetch existing absolute paths under this location directory in one shot
      const existingRows = this.#db
        .prepare('SELECT absolutePath FROM files WHERE absolutePath LIKE ?')
        .all(path + '%') as { absolutePath: string }[];
      const existingPaths = new Set(existingRows.map((r) => r.absolutePath));

      for (const file of newFiles) {
        if (existingPaths.has(file.absolutePath)) {
          continue;
        }

        this.#stmtInsertFile.run(fileDTOToRow(file));

        for (const tagId of file.tags) {
          this.#stmtInsertFileTag.run(file.id, tagId);
        }
      }
    });

    insertFiles(files);
    this.#notifyChange();
  }

  async createLocation(location: LocationDTO): Promise<void> {
    console.info('SQLite: Creating location...', location);
    this.#db
      .prepare(
        `
      INSERT INTO locations (id, path, dateAdded, subLocations, "index")
      VALUES (@id, @path, @dateAdded, @subLocations, @index)
    `,
      )
      .run({
        id: location.id,
        path: location.path,
        dateAdded: location.dateAdded.toISOString(),
        subLocations: JSON.stringify(location.subLocations),
        index: location.index,
      });
    this.#notifyChange();
  }

  async createSearch(search: FileSearchDTO): Promise<void> {
    console.info('SQLite: Creating search...', search);
    this.#db
      .prepare(
        `
      INSERT INTO searches (id, name, criteria, matchAny, "index")
      VALUES (@id, @name, @criteria, @matchAny, @index)
    `,
      )
      .run({
        id: search.id,
        name: search.name,
        criteria: JSON.stringify(search.criteria),
        matchAny: search.matchAny ? 1 : 0,
        index: search.index,
      });
    this.#notifyChange();
  }

  // -------------------------------------------------------------------------
  // Save (upsert) methods
  // -------------------------------------------------------------------------

  async saveTag(tag: TagDTO): Promise<void> {
    console.info('SQLite: Saving tag...', tag);
    this.#stmtUpsertTag.run({
      id: tag.id,
      name: tag.name,
      dateAdded: tag.dateAdded.toISOString(),
      color: tag.color,
      subTags: JSON.stringify(tag.subTags),
      isHidden: tag.isHidden ? 1 : 0,
    });
    this.#notifyChange();
  }

  async saveFiles(files: FileDTO[]): Promise<void> {
    console.info('SQLite: Saving files...', files.length);

    const upsertStmt = this.#db.prepare(`
      INSERT OR REPLACE INTO files
        (id, ino, locationId, relativePath, absolutePath, name, extension, size,
         width, height, dateAdded, dateModified, dateCreated, dateLastIndexed, annotations)
      VALUES
        (@id, @ino, @locationId, @relativePath, @absolutePath, @name, @extension, @size,
         @width, @height, @dateAdded, @dateModified, @dateCreated, @dateLastIndexed, @annotations)
    `);

    const saveAll = this.#db.transaction((filesToSave: FileDTO[]) => {
      for (const file of filesToSave) {
        upsertStmt.run(fileDTOToRow(file));
        // Replace all tag associations for this file
        this.#stmtDeleteFileTagsByFileId.run(file.id);
        for (const tagId of file.tags) {
          this.#stmtInsertFileTag.run(file.id, tagId);
        }
      }
    });

    saveAll(files);
    this.#notifyChange();
  }

  async saveLocation(location: LocationDTO): Promise<void> {
    console.info('SQLite: Saving location...', location);
    this.#db
      .prepare(
        `
      INSERT OR REPLACE INTO locations (id, path, dateAdded, subLocations, "index")
      VALUES (@id, @path, @dateAdded, @subLocations, @index)
    `,
      )
      .run({
        id: location.id,
        path: location.path,
        dateAdded: location.dateAdded.toISOString(),
        subLocations: JSON.stringify(location.subLocations),
        index: location.index,
      });
    this.#notifyChange();
  }

  async saveSearch(search: FileSearchDTO): Promise<void> {
    console.info('SQLite: Saving search...', search);
    this.#db
      .prepare(
        `
      INSERT OR REPLACE INTO searches (id, name, criteria, matchAny, "index")
      VALUES (@id, @name, @criteria, @matchAny, @index)
    `,
      )
      .run({
        id: search.id,
        name: search.name,
        criteria: JSON.stringify(search.criteria),
        matchAny: search.matchAny ? 1 : 0,
        index: search.index,
      });
    this.#notifyChange();
  }

  // -------------------------------------------------------------------------
  // Remove methods
  // -------------------------------------------------------------------------

  async removeTags(tags: ID[]): Promise<void> {
    console.info('SQLite: Removing tags...', tags);
    if (tags.length === 0) {
      return;
    }

    const placeholders = tags.map(() => '?').join(', ');
    const removeAll = this.#db.transaction(() => {
      // Remove junction rows first (cascades would handle files, but not tags)
      this.#db.prepare(`DELETE FROM file_tags WHERE tagId IN (${placeholders})`).run(...tags);
      this.#db.prepare(`DELETE FROM tags WHERE id IN (${placeholders})`).run(...tags);
    });
    removeAll();
    this.#notifyChange();
  }

  async mergeTags(tagToBeRemoved: ID, tagToMergeWith: ID): Promise<void> {
    console.info('SQLite: Merging tags...', tagToBeRemoved, tagToMergeWith);

    const merge = this.#db.transaction(() => {
      // For files that already have BOTH tags, simply delete the duplicate row;
      // for files that only have the removed tag, remap it to the merge target.
      this.#db
        .prepare(
          `
        DELETE FROM file_tags
        WHERE tagId = ?
          AND fileId IN (SELECT fileId FROM file_tags WHERE tagId = ?)
      `,
        )
        .run(tagToBeRemoved, tagToMergeWith);

      this.#db
        .prepare(
          `
        UPDATE file_tags SET tagId = ? WHERE tagId = ?
      `,
        )
        .run(tagToMergeWith, tagToBeRemoved);

      this.#stmtDeleteTag.run(tagToBeRemoved);
    });

    merge();
    this.#notifyChange();
  }

  async removeFiles(files: ID[]): Promise<void> {
    console.info('SQLite: Removing files...', files);
    if (files.length === 0) {
      return;
    }
    const placeholders = files.map(() => '?').join(', ');
    // ON DELETE CASCADE on file_tags handles junction-table cleanup automatically.
    this.#db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...files);
    this.#notifyChange();
  }

  async removeLocation(location: ID): Promise<void> {
    console.info('SQLite: Removing location...', location);
    const remove = this.#db.transaction(() => {
      // Deleting files triggers the CASCADE on file_tags automatically.
      this.#db.prepare('DELETE FROM files WHERE locationId = ?').run(location);
      this.#db.prepare('DELETE FROM locations WHERE id = ?').run(location);
    });
    remove();
    this.#notifyChange();
  }

  async removeSearch(search: ID): Promise<void> {
    console.info('SQLite: Removing search...', search);
    this.#db.prepare('DELETE FROM searches WHERE id = ?').run(search);
    this.#notifyChange();
  }

  // -------------------------------------------------------------------------
  // Aggregate methods
  // -------------------------------------------------------------------------

  async countFiles(): Promise<[fileCount: number, untaggedFileCount: number]> {
    console.info('SQLite: Getting file count stats...');
    const { total } = this.#db.prepare('SELECT COUNT(*) AS total FROM files').get() as {
      total: number;
    };

    const { untagged } = this.#db
      .prepare(
        `SELECT COUNT(*) AS untagged
         FROM files f
         WHERE NOT EXISTS (SELECT 1 FROM file_tags WHERE fileId = f.id)`,
      )
      .get() as { untagged: number };

    return [total, untagged];
  }

  // -------------------------------------------------------------------------
  // Lifecycle methods
  // -------------------------------------------------------------------------

  async clear(): Promise<void> {
    console.info('SQLite: Clearing database (dropping all tables)...');
    // Drop every user table. SQLite does not support DROP TABLE IF EXISTS in a
    // single exec() call with multiple statements on all versions, so we issue
    // them individually.
    const tables = [
      'files_fts',
      'file_tags',
      'files',
      'tags',
      'locations',
      'searches',
      'dismissedDuplicateGroups',
      'visualHashes',
    ];
    const dropAll = this.#db.transaction(() => {
      for (const table of tables) {
        this.#db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
      }
    });
    dropAll();
  }

  async clearFilesOnly(): Promise<void> {
    console.info('SQLite: Clearing files only (preserving locations, tags, searches)...');
    const clearFiles = this.#db.transaction(() => {
      // Deleting from files cascades to file_tags automatically.
      this.#db.prepare('DELETE FROM files').run();
      this.#db.prepare('DELETE FROM visualHashes').run();
      this.#db.prepare('DELETE FROM dismissedDuplicateGroups').run();
    });
    clearFiles();
    this.#notifyChange();
  }

  // -------------------------------------------------------------------------
  // Dismissed duplicate group methods
  // -------------------------------------------------------------------------

  async fetchDismissedDuplicateGroups(): Promise<DismissedDuplicateGroupDTO[]> {
    console.info('SQLite: Fetching dismissed duplicate groups...');
    const rows = this.#db
      .prepare('SELECT * FROM dismissedDuplicateGroups ORDER BY dismissedAt DESC')
      .all() as DismissedGroupRow[];
    return rows.map(dismissedGroupRowToDTO);
  }

  async createDismissedDuplicateGroup(dismissedGroup: DismissedDuplicateGroupDTO): Promise<void> {
    console.info('SQLite: Creating dismissed duplicate group...', dismissedGroup);
    // Upsert semantics: replace any pre-existing record with the same groupHash.
    this.#db
      .prepare(
        `
      INSERT OR REPLACE INTO dismissedDuplicateGroups
        (id, groupHash, algorithm, fileIds, dismissedAt, userNote)
      VALUES (@id, @groupHash, @algorithm, @fileIds, @dismissedAt, @userNote)
    `,
      )
      .run({
        id: dismissedGroup.id,
        groupHash: dismissedGroup.groupHash,
        algorithm: dismissedGroup.algorithm,
        fileIds: dismissedGroup.fileIds,
        dismissedAt: dismissedGroup.dismissedAt.toISOString(),
        userNote: dismissedGroup.userNote ?? null,
      });
    this.#notifyChange();
  }

  async removeDismissedDuplicateGroup(groupHash: string): Promise<void> {
    console.info('SQLite: Removing dismissed duplicate group...', groupHash);
    this.#db.prepare('DELETE FROM dismissedDuplicateGroups WHERE groupHash = ?').run(groupHash);
    this.#notifyChange();
  }

  // -------------------------------------------------------------------------
  // Visual hash cache methods
  // -------------------------------------------------------------------------

  async fetchVisualHashes(absolutePaths: string[]): Promise<VisualHashDTO[]> {
    console.info('SQLite: Fetching visual hashes for', absolutePaths.length, 'files...');
    if (absolutePaths.length === 0) {
      return [];
    }
    const placeholders = absolutePaths.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(`SELECT * FROM visualHashes WHERE absolutePath IN (${placeholders})`)
      .all(...absolutePaths) as VisualHashRow[];
    return rows.map(visualHashRowToDTO);
  }

  async saveVisualHashes(hashes: VisualHashDTO[]): Promise<void> {
    console.info('SQLite: Saving', hashes.length, 'visual hashes...');
    const upsert = this.#db.prepare(`
      INSERT OR REPLACE INTO visualHashes
        (absolutePath, fileSize, dateModified, hashType, hash, dateComputed, thumbnailPath)
      VALUES (@absolutePath, @fileSize, @dateModified, @hashType, @hash, @dateComputed, @thumbnailPath)
    `);

    const saveAll = this.#db.transaction((hashList: VisualHashDTO[]) => {
      for (const h of hashList) {
        upsert.run({
          absolutePath: h.absolutePath,
          fileSize: h.fileSize,
          dateModified: h.dateModified.toISOString(),
          hashType: h.hashType,
          hash: h.hash,
          dateComputed: h.dateComputed.toISOString(),
          thumbnailPath: h.thumbnailPath ?? null,
        });
      }
    });

    saveAll(hashes);
    this.#notifyChange();
  }

  async removeVisualHashes(absolutePaths: string[]): Promise<void> {
    console.info('SQLite: Removing visual hashes for', absolutePaths.length, 'files...');
    if (absolutePaths.length === 0) {
      return;
    }
    const placeholders = absolutePaths.map(() => '?').join(', ');
    this.#db
      .prepare(`DELETE FROM visualHashes WHERE absolutePath IN (${placeholders})`)
      .run(...absolutePaths);
    this.#notifyChange();
  }

  async clearVisualHashCache(): Promise<void> {
    console.info('SQLite: Clearing all visual hash cache...');
    this.#db.prepare('DELETE FROM visualHashes').run();
    this.#notifyChange();
  }
}
