/**
 * Codec-fact and container-fact persistence (changes: support-mov-playback and
 * support-mkv-ts-playback, task 1.3).
 *
 * Nullable videoCodec/audioCodec/codecVersion columns plus the formatName
 * (ffprobe container format_name) column on the files table,
 * added via the versioned MIGRATIONS array + PRAGMA user_version. The test
 * builds a pre-migration (v1) database by hand, runs it through the REAL
 * applyMigrations loop (extracted from sqliteInit for exactly this), and
 * asserts the columns exist, old rows are NULL (unprobed, never a verdict),
 * and user_version advances. The round-trip leg runs the real save-side
 * upsert (FILE_UPSERT + fileDTOToRow) and fetch-side select (FILE_SELECT +
 * fileRowToDTO) from sqlite-backend.
 *
 * Engine: node:sqlite, not better-sqlite3 — the latter's native binary is
 * built against the Electron ABI and cannot load under plain node/jest
 * ("invalid ELF header"). SQLite semantics (PRAGMA, ALTER TABLE ADD COLUMN,
 * GROUP_CONCAT, named @params) are identical.
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { applyMigrations } from '../src/backend/sqlite-config';
import {
  fileDTOToRow,
  fileRowToDTO,
  FILE_SELECT,
  FILE_UPSERT,
} from '../src/backend/sqlite-backend';
import type { FileDTO } from '../src/api/file';

/** The files table exactly as MIGRATIONS v1 created it — no codec or container
 *  columns. */
const LEGACY_FILES_DDL = `
  CREATE TABLE files (
    id             TEXT    PRIMARY KEY,
    ino            TEXT,
    locationId     TEXT    NOT NULL,
    relativePath   TEXT    NOT NULL,
    absolutePath   TEXT    NOT NULL,
    name           TEXT    NOT NULL,
    extension      TEXT    NOT NULL,
    size           INTEGER NOT NULL,
    width          INTEGER NOT NULL,
    height         INTEGER NOT NULL,
    dateAdded      TEXT    NOT NULL,
    dateModified   TEXT    NOT NULL,
    dateCreated    TEXT    NOT NULL,
    dateLastIndexed TEXT   NOT NULL,
    annotations    TEXT    NOT NULL DEFAULT '{}'
  );
`;

const LEGACY_FILE_TAGS_DDL = `
  CREATE TABLE file_tags (
    fileId  TEXT NOT NULL,
    tagId   TEXT NOT NULL,
    PRIMARY KEY (fileId, tagId)
  );
`;

/** node:sqlite rows are untyped (SQLite has no static row shape). */
function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

function fileDto(id: string, overrides: Partial<FileDTO> = {}): FileDTO {
  return {
    id,
    ino: '0',
    locationId: 'loc1',
    relativePath: `${id}.mov`,
    absolutePath: `/library/${id}.mov`,
    name: `${id}.mov`,
    extension: 'mov',
    size: 1024,
    width: 1920,
    height: 1080,
    dateAdded: new Date(0),
    dateModified: new Date(0),
    dateCreated: new Date(0),
    dateLastIndexed: new Date(0),
    annotations: '{}',
    tags: [],
    ...overrides,
  };
}

describe('codec- and container-fact columns: versioned migration (support-mov/mkv-ts 1.3)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'of-codec-mig-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  /** Creates a v1 database file with one pre-migration row, user_version = 1. */
  function makeLegacyDb(dbPath: string): void {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_FILES_DDL);
    legacy.exec(LEGACY_FILE_TAGS_DDL);
    legacy
      .prepare(
        `INSERT INTO files
           (id, ino, locationId, relativePath, absolutePath, name, extension, size,
            width, height, dateAdded, dateModified, dateCreated, dateLastIndexed, annotations)
         VALUES ('old1', '0', 'loc1', 'old.mov', '/library/old.mov', 'old.mov', 'mov',
                 2048, 0, 0,
                 '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
                 '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '{}')`,
      )
      .run();
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();
  }

  it('applies v2 and v3 on a pre-migration DB: columns exist, old rows are NULL, user_version advances', () => {
    const dbPath = path.join(dir, 'onefolder.db');
    makeLegacyDb(dbPath);

    const db = new DatabaseSync(dbPath);
    try {
      applyMigrations(db);

      const colRows = db
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all('files') as Array<{ name: string }>;
      const cols = colRows.map((r) => r.name);
      expect(cols).toEqual(
        expect.arrayContaining(['videoCodec', 'audioCodec', 'codecVersion', 'formatName']),
      );

      // Codec and container FACTS, not verdicts: an old row must be NULL (unprobed) — never a
      // pre-seeded codec or a defaulted verdict string.
      const oldRow = db
        .prepare(
          'SELECT videoCodec, audioCodec, codecVersion, formatName FROM files WHERE id = ?',
        )
        .get('old1') as {
        videoCodec: string | null;
        audioCodec: string | null;
        codecVersion: string | null;
        formatName: string | null;
      };
      expect(oldRow).toEqual({
        videoCodec: null,
        audioCodec: null,
        codecVersion: null,
        formatName: null,
      });

      expect(userVersion(db)).toBe(3);
    } finally {
      db.close();
    }
  });

  it('re-running on an already-migrated DB is a no-op (no duplicate-column failure)', () => {
    const dbPath = path.join(dir, 'onefolder.db');
    makeLegacyDb(dbPath);

    const first = new DatabaseSync(dbPath);
    applyMigrations(first);
    first.close();

    const db = new DatabaseSync(dbPath);
    try {
      expect(() => applyMigrations(db)).not.toThrow();
      expect(userVersion(db)).toBe(3);
      const dupes = db
        .prepare(
          "SELECT name FROM pragma_table_info('files') WHERE name IN ('videoCodec', 'formatName')",
        )
        .all() as Array<{ name: string }>;
      expect(dupes).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

describe('codec- and container-fact columns: saveFiles/fetchFiles SQL round-trip', () => {
  it('upsert + select preserve videoCodec/audioCodec/codecVersion/formatName and absent stays NULL (unprobed)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      // Current schema from the single-source DDL (files + file_tags + friends).
      db.exec('PRAGMA foreign_keys = OFF');
      applyMigrations(db);

      db.prepare(FILE_UPSERT).run(
        fileDTOToRow(
          fileDto('f1', {
            videoCodec: 'hevc',
            audioCodec: 'pcm_s16le',
            codecVersion: '1:12345:98765',
            formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
          }),
        ),
      );
      // Ingest-path rows carry no codec/container fields → persisted as NULL.
      db.prepare(FILE_UPSERT).run(fileDTOToRow(fileDto('f2')));
      // An explicit null container (probe reported no format_name) round-trips as NULL too.
      db.prepare(FILE_UPSERT).run(
        fileDTOToRow(
          fileDto('f3', {
            videoCodec: 'h264',
            audioCodec: 'aac',
            codecVersion: '1:12345:98765',
            formatName: null,
          }),
        ),
      );

      const rows = db.prepare(`${FILE_SELECT} GROUP BY f.id`).all() as never[];
      const byId = new Map(rows.map((r) => [fileRowToDTO(r).id, fileRowToDTO(r)]));

      const f1 = byId.get('f1')!;
      expect(f1.videoCodec).toBe('hevc');
      expect(f1.audioCodec).toBe('pcm_s16le');
      expect(f1.codecVersion).toBe('1:12345:98765');
      expect(f1.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');

      const f2 = byId.get('f2')!;
      expect(f2.videoCodec).toBeNull();
      expect(f2.audioCodec).toBeNull();
      expect(f2.codecVersion).toBeNull();
      expect(f2.formatName).toBeNull();

      const f3 = byId.get('f3')!;
      expect(f3.videoCodec).toBe('h264');
      expect(f3.codecVersion).toBe('1:12345:98765');
      expect(f3.formatName).toBeNull();
    } finally {
      db.close();
    }
  });
});
