import Database from 'better-sqlite3';
import fse from 'fs-extra';
import path from 'path';

import { debounce } from '../../common/timeout';
import { DataBackup } from '../api/data-backup';
import { AUTO_BACKUP_TIMEOUT, NUM_AUTO_BACKUPS } from './config';

/** Returns the date at 00:00 today */
function getToday(): Date {
  const today = new Date();
  today.setHours(0);
  today.setMinutes(0);
  today.setSeconds(0, 0);
  return today;
}

/** Returns the date at the start of the current week (Sunday at 00:00) */
function getWeekStart(): Date {
  const date = getToday();
  const dayOfWeek = date.getDay();
  date.setDate(date.getDate() - dayOfWeek);
  return date;
}

/**
 * Implements the DataBackup interface for a better-sqlite3 database.
 *
 * Replaces the dexie-export-import JSON serialisation approach with SQLite's
 * native online backup API (db.backup()), which is faster, safer, and produces
 * a fully portable .db file rather than a JSON blob.
 *
 * The rotating auto-backup strategy (6 slots, daily, weekly) is preserved from
 * the original BackupScheduler so existing user-facing behaviour is unchanged.
 */
export default class SQLiteBackupScheduler implements DataBackup {
  // The path of the active database file, needed for restoreFromFile() to know
  // where to copy the backup over to.
  readonly #dbPath: string;
  #db: Database.Database;
  #backupDirectory: string;
  #lastBackupIndex: number = 0;
  #lastBackupDate: Date = new Date(0);

  constructor(db: Database.Database, dbPath: string, backupDirectory: string) {
    this.#db = db;
    this.#dbPath = dbPath;
    this.#backupDirectory = backupDirectory;
  }

  static async init(
    db: Database.Database,
    dbPath: string,
    backupDirectory: string,
  ): Promise<SQLiteBackupScheduler> {
    await fse.ensureDir(backupDirectory);
    return new SQLiteBackupScheduler(db, dbPath, backupDirectory);
  }

  // ---------------------------------------------------------------------------
  // DataBackup interface
  // ---------------------------------------------------------------------------

  /**
   * Triggers a debounced periodic backup.  Calls are ignored if a backup has
   * already been created within AUTO_BACKUP_TIMEOUT (10 minutes) to avoid
   * thrashing the filesystem during bulk imports.
   */
  schedule(): void {
    if (new Date().getTime() > this.#lastBackupDate.getTime() + AUTO_BACKUP_TIMEOUT) {
      this.#createPeriodicBackup();
    }
  }

  /**
   * Uses better-sqlite3's db.backup() to perform a safe online backup of the
   * active database to the given path.  The backup API handles WAL checkpointing
   * internally, so the destination file is always in a consistent state even if
   * the source database is being written to concurrently.
   */
  async backupToFile(destPath: string): Promise<void> {
    console.info('SQLite: Creating database backup...', destPath);
    await fse.ensureFile(destPath);
    await this.#db.backup(destPath);
  }

  /**
   * Restores the database from a backup file by closing the active connection,
   * overwriting the active .db file with the backup, and reopening the
   * connection.  The caller (renderer.tsx) is expected to trigger an app
   * relaunch after this returns so all in-memory state is re-initialised from
   * the restored database.
   */
  async restoreFromFile(backupPath: string): Promise<void> {
    console.info('SQLite: Restoring database from backup...', backupPath);

    // Close the active connection before replacing the file on disk. This
    // flushes any pending WAL frames and releases the file lock.
    this.#db.close();

    try {
      await fse.copyFile(backupPath, this.#dbPath);
      console.log('SQLite: Database restored from', backupPath);
    } catch (e) {
      console.error('SQLite: Failed to restore database from backup', backupPath, e);
      throw e;
    } finally {
      // Reopen the connection whether or not the copy succeeded.  If the copy
      // failed the caller will surface the error; either way we must not leave
      // the scheduler holding a closed database handle.
      this.#db = new Database(this.#dbPath);
    }
  }

  /**
   * Opens the backup file as a read-only SQLite database and returns the number
   * of tags and files it contains without loading all rows into memory.
   */
  async peekFile(backupPath: string): Promise<[numTags: number, numFiles: number]> {
    console.info('SQLite: Peeking database backup...', backupPath);

    const backupDb = new Database(backupPath, { readonly: true });
    try {
      const { tagCount } = backupDb.prepare('SELECT COUNT(*) AS tagCount FROM tags').get() as {
        tagCount: number;
      };
      const { fileCount } = backupDb.prepare('SELECT COUNT(*) AS fileCount FROM files').get() as {
        fileCount: number;
      };
      return [tagCount, fileCount];
    } finally {
      backupDb.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Periodic backup internals
  // ---------------------------------------------------------------------------

  /**
   * Copies srcPath to targetPath only if the target file was created before
   * dateToCheck (or does not yet exist).  Used to maintain daily and weekly
   * backup slots without overwriting them on every auto-backup run.
   */
  static async #copyFileIfCreatedBeforeDate(
    srcPath: string,
    targetPath: string,
    dateToCheck: Date,
  ): Promise<boolean> {
    let createBackup = false;
    try {
      // If file creation date is less than provided date, create a back-up
      const stats = await fse.stat(targetPath);
      createBackup = stats.ctime < dateToCheck;
    } catch (e) {
      // File not found
      createBackup = true;
    }
    if (createBackup) {
      try {
        await fse.copyFile(srcPath, targetPath);
        console.log('Created backup', targetPath);
        return true;
      } catch (e) {
        console.error('Could not create backup', targetPath, e);
      }
    }
    return false;
  }

  // Wait 10 seconds after a change for any other changes before creating a backup.
  #createPeriodicBackup = debounce(async (): Promise<void> => {
    const filePath = path.join(this.#backupDirectory, `auto-backup-${this.#lastBackupIndex}.db`);

    this.#lastBackupDate = new Date();
    this.#lastBackupIndex = (this.#lastBackupIndex + 1) % NUM_AUTO_BACKUPS;

    try {
      await this.backupToFile(filePath);

      console.log('Created automatic backup', filePath);

      // Check for daily backup
      await SQLiteBackupScheduler.#copyFileIfCreatedBeforeDate(
        filePath,
        path.join(this.#backupDirectory, 'daily.db'),
        getToday(),
      );

      // Check for weekly backup
      await SQLiteBackupScheduler.#copyFileIfCreatedBeforeDate(
        filePath,
        path.join(this.#backupDirectory, 'weekly.db'),
        getWeekStart(),
      );
    } catch (e) {
      console.error('Could not create periodic backup', filePath, e);
    }
  }, 10000);
}
