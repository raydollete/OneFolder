import { action, makeObservable, observable, runInAction } from 'mobx';

import { getThumbnailPath } from 'common/fs';
import { promiseAllLimit } from 'common/promise';
import { DataStorage } from '../../api/data-storage';
import { OrderDirection } from '../../api/data-storage-search';
import { FileDTO, IMG_EXTENSIONS, IMG_EXTENSIONS_TYPE } from '../../api/file';
import { ID, generateId } from '../../api/id';
import { LocationDTO } from '../../api/location';
import { AppToaster } from '../components/Toaster';
import platform from 'src/frontend/platform';
import { getMetaData, getMetaDataWithTags, mergeMovedFile } from '../entities/File';
import { ClientLocation, ClientSubLocation } from '../entities/Location';
import { ClientStringSearchCriteria } from '../entities/SearchCriteria';
import ImageLoader from '../image/ImageLoader';
import RootStore from './RootStore';
import TagStore from './TagStore';

type Preferences = { extensions: IMG_EXTENSIONS_TYPE[] };

function getLocationPrefsKey(prefix?: string): string {
  return prefix ? `${prefix}:location-store-preferences` : 'location-store-preferences';
}

/**
 * Compares metadata of two files to determine whether the files are (likely to be) identical
 * Note: note comparing size, since it can change, e.g. when writing tags to file metadata.
 *   Could still include it, but just to check whether it's in the same ballpark
 */
function areFilesIdenticalBesidesName(a: FileDTO, b: FileDTO): boolean {
  return (
    a.ino === b.ino ||
    (a.width === b.width &&
      a.height === b.height &&
      a.dateCreated.getTime() === b.dateCreated.getTime())
  );
}

class LocationStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

  readonly locationList = observable<ClientLocation>([]);

  // Allow users to disable certain file types. Global option for now, needs restart
  // TODO: Maybe per location/sub-location?
  readonly enabledFileExtensions = observable(new Set<IMG_EXTENSIONS_TYPE>());

  /** The library-scoped localStorage key prefix. Empty string = legacy global behaviour. */
  readonly storageKeyPrefix: string;

  /**
   * Absolute paths (normalized forward-slash, lower-case) the folder watcher must NOT auto-ingest
   * because the renderer is ingesting them deterministically itself (media-job outputs). This is
   * the single mechanism that prevents the watcher and `ingestFile()` from both creating a row for
   * the same derived file — the dual-write race that broke media jobs. Populated by
   * `suppressIngest()` before a media-job output is placed, cleared by `unsuppressIngest()` after
   * `ingestFile()` has created the row.
   */
  private readonly suppressedIngestPaths = new Set<string>();

  constructor(backend: DataStorage, rootStore: RootStore, storageKeyPrefix = '') {
    this.backend = backend;
    this.rootStore = rootStore;
    this.storageKeyPrefix = storageKeyPrefix;

    makeObservable(this);
  }

  @action async init(): Promise<void> {
    // Restore preferences
    try {
      const prefs = JSON.parse(
        localStorage.getItem(getLocationPrefsKey(this.storageKeyPrefix || undefined)) || '',
      ) as Preferences;
      (prefs.extensions || IMG_EXTENSIONS).forEach((ext) => this.enabledFileExtensions.add(ext));
    } catch (e) {
      // If no preferences found, use defaults
      IMG_EXTENSIONS.forEach((ext) => this.enabledFileExtensions.add(ext));
      // By default, disable EXR for now (experimental)
      this.enabledFileExtensions.delete('exr');
    }

    // Get dirs from backend
    const dirs = (await this.backend.fetchLocations()).filter((dir) => {
      // Defensively skip malformed rows with an empty path (from a bad import or
      // a hand-edited DB): they would otherwise become permanent unnamed ghosts.
      if (dir.path.trim() === '') {
        console.warn('Skipping malformed location row with empty path', dir.id);
        return false;
      }
      return true;
    });

    // backwards compatibility
    dirs.sort((a, b) =>
      a.index === b.index ? a.dateAdded.getTime() - b.dateAdded.getTime() : a.index - b.index,
    );

    const locations = dirs.map(
      (dir, i) =>
        new ClientLocation(
          this,
          dir.id,
          dir.path,
          dir.dateAdded,
          dir.subLocations,
          runInAction(() => Array.from(this.enabledFileExtensions)),
          dir.index ?? i,
        ),
    );
    runInAction(() => this.locationList.replace(locations));
  }

  save(loc: LocationDTO): void {
    this.backend.saveLocation(loc);
  }

  // E.g. in preview window, it's not needed to watch the locations
  // Returns whether files have been added, changed or removed
  @action async watchLocations(): Promise<boolean> {
    const progressToastKey = 'progress';
    let foundNewFiles = false;
    const len = this.locationList.length;
    const getLocation = action((index: number) => this.locationList[index]);

    // Get all files in the DB, set up data structures for quick lookups
    // Doing it for all locations, so files moved to another Location on disk, it's properly re-assigned in OneFolder too
    // TODO: Could be optimized, at startup we already fetch all files, don't need to fetch them again here
    const dbFiles: FileDTO[] = await this.backend.fetchFiles('id', OrderDirection.Asc);
    const dbFilesPathSet = new Set(dbFiles.map((f) => f.absolutePath));
    const dbFilesByCreatedDate = new Map<number, FileDTO[]>();
    for (const file of dbFiles) {
      const time = file.dateCreated.getTime();
      const entry = dbFilesByCreatedDate.get(time);
      if (entry) {
        entry.push(file);
      } else {
        dbFilesByCreatedDate.set(time, [file]);
      }
    }

    // For every location, find created/moved/deleted files, and update the database accordingly.
    // TODO: Do this in a web worker, not in the renderer thread!
    for (let i = 0; i < len; i++) {
      const location = getLocation(i);

      AppToaster.show(
        {
          message: `Looking for new images... [${i + 1} / ${len}]`,
          timeout: 0,
        },
        progressToastKey,
      );

      // Initial scans of large/slow locations can legitimately take a while. After a
      // generous threshold, show a calm progress note — NOT a "something is wrong"
      // warning, and deliberately with no "Retry?" action (reloading would just
      // restart the same scan and strictly worsen the wait).
      const progressNoteKey = `retry-init-${location.id}`;
      const readyTimeout = setTimeout(() => {
        AppToaster.show(
          {
            message: `Scanning location "${location.name}"… this can take a while for large folders.`,
            timeout: 0,
          },
          progressNoteKey,
        );
      }, 60000);

      console.groupCollapsed(`Initializing location ${location.name}`);
      const diskFiles = await location.init();
      const diskFileMap = new Map<string, FileStats>(
        diskFiles?.map((f) => [f.absolutePath, f]) ?? [],
      );

      clearTimeout(readyTimeout);
      AppToaster.dismiss(progressNoteKey);

      if (diskFiles === undefined) {
        AppToaster.show(
          {
            message: `Cannot find Location "${location.name}"`,
            timeout: 0,
          },
          // a key such that the toast can be dismissed automatically on recovery
          `missing-loc-${location.id}`,
        );
        continue;
      }

      console.log('Finding created files...');
      // Find all files that have been created (those on disk but not in DB)
      const createdPaths = diskFiles.filter((f) => !dbFilesPathSet.has(f.absolutePath));
      const createdFiles = await Promise.all(
        createdPaths.map((path) => pathToIFile(path, location, this.rootStore.imageLoader)),
      );

      // Find all files of this location that have been removed (those in DB but not on disk anymore)
      const missingFiles = dbFiles.filter(
        (file) => file.locationId === location.id && !diskFileMap.has(file.absolutePath),
      );

      // Find matches between removed and created images (different name/path but same characteristics)
      // TODO: use the ino field on files for this
      const createdMatches = missingFiles.map((mf) =>
        createdFiles.find((cf) => areFilesIdenticalBesidesName(cf, mf)),
      );
      // Also look for duplicate files: when a files is renamed/moved it will become a new entry, should be de-duplicated
      const dbMatches = missingFiles.map((missingDbFile, i) => {
        if (createdMatches[i]) {
          return false;
        } // skip missing files that match with a newly created file
        // Quick lookup for files with same created date,
        const candidates = dbFilesByCreatedDate.get(missingDbFile.dateCreated.getTime()) || [];

        // then first look for a file with the same name + resolution (for when file is moved to different path)
        const matchWithName = candidates.find(
          (otherDbFile) =>
            missingDbFile !== otherDbFile &&
            missingDbFile.name === otherDbFile.name &&
            areFilesIdenticalBesidesName(missingDbFile, otherDbFile),
        );

        // If no match, try looking without filename in case the file was renamed (prone to errors, but better than nothing)
        return (
          matchWithName ||
          candidates.find(
            (otherDbFile) =>
              missingDbFile !== otherDbFile &&
              areFilesIdenticalBesidesName(missingDbFile, otherDbFile),
          )
        );
      });

      console.debug({ missingFiles, createdFiles, createdMatches, dbMatches });

      // Update renamed files in backend
      const foundCreatedMatches = createdMatches.filter((m) => m !== undefined) as FileDTO[];
      if (foundCreatedMatches.length > 0) {
        console.debug(
          `Found ${foundCreatedMatches.length} renamed/moved files in location ${location.name}. These are detected as new files, but will instead replace their original entry in the DB of OneFolder`,
          foundCreatedMatches,
        );
        // TODO: remove thumbnail as well (clean-up needed, since the path changed)
        const renamedFilesToUpdate: FileDTO[] = [];
        for (let i = 0; i < createdMatches.length; i++) {
          const match = createdMatches[i];
          if (match) {
            renamedFilesToUpdate.push({
              ...missingFiles[i],
              absolutePath: match.absolutePath,
              relativePath: match.relativePath,
            });
          }
        }
        // There might be duplicates, so convert to set
        await this.backend.saveFiles(Array.from(new Set(renamedFilesToUpdate)));
      }

      const numDbMatches = dbMatches.filter((f) => Boolean(f));
      if (numDbMatches.length > 0) {
        // Renaming/moving files will be created as new files while the old one sticks around
        // In here we transfer the tag data over from the old entry to the new one, and delete the old entry
        console.debug(
          `Found ${numDbMatches.length} renamed/moved files in location ${location.name} that were already present in the database. Removing duplicates`,
          numDbMatches,
        );
        const files: FileDTO[] = [];
        for (let i = 0; i < dbMatches.length; i++) {
          const match = dbMatches[i];
          if (match) {
            files.push({
              ...match,
              tags: Array.from(new Set([...missingFiles[i].tags, ...match.tags])),
            });
          }
        }
        // Transfer over tag data on the matched files
        await this.backend.saveFiles(Array.from(new Set(files)));
        // Remove missing files that have a match in the database
        await this.backend.removeFiles(
          missingFiles.filter((_, i) => Boolean(dbMatches[i])).map((f) => f.id),
        );
        foundNewFiles = true; // Set a flag to trigger a refetch
      }

      // For createdFiles without a match, insert them in the DB as new files
      const newFiles = createdFiles.filter((cf) => !foundCreatedMatches.includes(cf));
      if (newFiles.length) {
        await this.backend.createFilesFromPath(location.path, newFiles);
      }

      // Also update files that have changed, e.g. when overwriting a file (with same filename)
      // --> update metadata (resolution, size) and recreate thumbnail
      // This can be accomplished by comparing the dateLastIndexed of the file in DB to dateModified of the file on disk
      const updatedFiles: FileDTO[] = [];
      const thumbnailDirectory = runInAction(() => this.rootStore.uiStore.thumbnailDirectory);
      for (const dbFile of dbFiles) {
        const diskFile = diskFileMap.get(dbFile.absolutePath);
        if (
          diskFile &&
          dbFile.dateLastIndexed.getTime() < diskFile.dateModified.getTime() &&
          diskFile.size !== dbFile.size
        ) {
          const newFile: FileDTO = {
            ...dbFile,
            // Recreate metadata which checks the resolution of the image
            ...(await getMetaData(diskFile, this.rootStore.imageLoader)),
            dateLastIndexed: new Date(),
          };

          // Delete thumbnail if size has changed, will be re-created automatically when needed
          const thumbPath = getThumbnailPath(dbFile.absolutePath, thumbnailDirectory);
          platform.fs.remove(thumbPath).catch(console.error);

          updatedFiles.push(newFile);
        }
      }
      if (updatedFiles.length > 0) {
        console.debug('Re-indexed files changed on disk', updatedFiles);
        await this.backend.saveFiles(updatedFiles);
      }

      console.groupEnd();

      foundNewFiles = foundNewFiles || newFiles.length > 0;
    }

    if (foundNewFiles) {
      AppToaster.show({ message: 'New images detected.', timeout: 5000 }, progressToastKey);
    } else {
      AppToaster.dismiss(progressToastKey);
    }
    return foundNewFiles;
  }

  @action get(locationId: ID): ClientLocation | undefined {
    return this.locationList.find((loc) => loc.id === locationId);
  }

  @action async changeLocationPath(location: ClientLocation, newPath: string): Promise<void> {
    const index = this.locationList.findIndex((l) => l.id === location.id);
    if (index === -1) {
      throw new Error(`The location ${location.name} has already been removed.`);
    }
    console.log('changing location path', location, newPath);
    // First, update the absolute path of all files from this location
    const locFiles = await this.findLocationFiles(location.id);
    const files: FileDTO[] = locFiles.map((f) => ({
      ...f,
      absolutePath: platform.path.join(newPath, f.relativePath),
    }));
    await this.backend.saveFiles(files);

    const newLocation = new ClientLocation(
      this,
      location.id,
      newPath,
      location.dateAdded,
      location.subLocations,
      runInAction(() => Array.from(this.enabledFileExtensions)),
      this.locationList.length,
    );
    runInAction(() => (this.locationList[index] = newLocation));
    await this.initLocation(newLocation);
    await this.backend.saveLocation(newLocation.serialize());
    // Refetch files in case some were from this location and could not be found before
    this.rootStore.fileStore.refetch();

    // Dismiss the 'Cannot find location' toast if it is still open
    AppToaster.dismiss(`missing-loc-${newLocation.id}`);
  }

  @action exists(predicate: (location: ClientLocation) => boolean): boolean {
    return this.locationList.some(predicate);
  }

  @action.bound async create(path: string): Promise<ClientLocation> {
    // Fail loud: an empty/whitespace path would persist as an unnamed ghost row
    // that silently becomes a broken link on load. Refuse it at the boundary.
    if (path.trim() === '') {
      throw new Error('Cannot create a location with an empty path');
    }
    const location = new ClientLocation(
      this,
      generateId(),
      path,
      new Date(),
      [],
      runInAction(() => Array.from(this.enabledFileExtensions)),
      this.locationList.length,
    );
    await this.backend.createLocation(location.serialize());
    runInAction(() => this.locationList.push(location));
    return location;
  }

  /** Imports all files from a location into the FileStore */
  @action.bound async initLocation(location: ClientLocation): Promise<void> {
    const toastKey = `initialize-${location.id}`;

    let isCancelled = false;
    const handleCancelled = () => {
      console.debug('Aborting location initialization', location.name);
      isCancelled = true;
      location.delete();
    };

    AppToaster.show(
      {
        message: 'Finding all images...',
        timeout: 0,
        clickAction: {
          label: 'Cancel',
          onClick: handleCancelled,
        },
      },
      toastKey,
    );

    const filePaths = await location.init();

    if (isCancelled || filePaths === undefined) {
      return;
    }

    const totalFiles = filePaths.length;
    const showProgressToaster = (progress: number) => {
      if (isCancelled) {
        return;
      }

      const completedFiles = Math.trunc(progress * totalFiles);
      const percentage = Math.trunc(progress * 100);

      // Format numbers with thousands separators for better readability
      const completedFormatted = completedFiles.toLocaleString();
      const totalFormatted = totalFiles.toLocaleString();

      AppToaster.show(
        {
          message: `Loading ${percentage}% \n ${completedFormatted}/${totalFormatted}`,
          timeout: 0,
        },
        toastKey,
      );
    };

    showProgressToaster(0);

    // Load file meta info, with only N jobs in parallel and a progress + cancel callback
    // TODO: Should make N configurable, or determine based on the system/disk performance
    const N = 50;

    // Use the enhanced single-pass approach that reads both dimensions and tags in one ExifTool call
    const shouldReadTags = this.rootStore.uiStore.importMetadataAtLocationLoading;
    const files = await promiseAllLimit(
      filePaths.map(
        (path) => () =>
          pathToIFileWithMetadata(
            path,
            location,
            this.rootStore.imageLoader,
            this.rootStore.tagStore,
            shouldReadTags,
          ),
      ),
      N,
      showProgressToaster,
      () => isCancelled,
    );

    AppToaster.show({ message: 'Updating database...', timeout: 0 }, toastKey);
    await this.backend.createFilesFromPath(location.path, files);

    AppToaster.show({ message: `Location "${location.name}" is ready!`, timeout: 5000 }, toastKey);
    await this.rootStore.fileStore.refetch();
    await this.rootStore.fileStore.refetchFileCounts();

    // No need for separate readTagsFromFiles() call - tags are already processed during file creation!
    // This eliminates the redundant ExifTool reads that were making location loading slow
  }

  @action.bound async delete(location: ClientLocation): Promise<void> {
    // Remove location from DB through backend
    await this.backend.removeLocation(location.id);
    runInAction(() => {
      // Remove deleted files from selection
      for (const file of this.rootStore.uiStore.fileSelection) {
        if (file.locationId === location.id) {
          this.rootStore.uiStore.deselectFile(file);
        }
      }
      // Remove location locally
      this.locationList.remove(location);
    });
    this.rootStore.fileStore.refetch();
    this.rootStore.fileStore.refetchFileCounts();
  }

  /**
   * Stops all active Chokidar file-watcher workers across every location.
   * Called during library teardown before switching to a different library so
   * that watchers from the old library do not fire events into the new one.
   */
  async closeAllWatchers(): Promise<void> {
    await Promise.all(this.locationList.map((loc) => loc.drop()));
  }

  @action.bound setSupportedImageExtensions(extensions: Set<IMG_EXTENSIONS_TYPE>): void {
    this.enabledFileExtensions.replace(extensions);
    localStorage.setItem(
      getLocationPrefsKey(this.storageKeyPrefix || undefined),
      JSON.stringify(
        { extensions: Array.from(this.enabledFileExtensions) } as Preferences,
        null,
        2,
      ),
    );
  }

  /** Normalize an absolute path to the form used for suppression/DB lookups. */
  private static normalizePath(absolutePath: string): string {
    return absolutePath.replace(/\\/g, '/').toLowerCase();
  }

  /**
   * Tell the folder watcher NOT to auto-ingest `absolutePath` — the renderer is ingesting it
   * deterministically itself (a media-job output). Call this BEFORE the file appears at that path.
   */
  suppressIngest(absolutePath: string): void {
    this.suppressedIngestPaths.add(LocationStore.normalizePath(absolutePath));
  }

  /** Release a path previously passed to {@link suppressIngest}. */
  unsuppressIngest(absolutePath: string): void {
    this.suppressedIngestPaths.delete(LocationStore.normalizePath(absolutePath));
  }

  /**
   * Deterministically ingest a known file into the library and set its tags — the SINGLE
   * row-creation path for derived media-job outputs (re-encode / normalize / clip). It does NOT
   * depend on the folder watcher (which is suppressed for this path), so there is no race and no
   * untagged-row window.
   *
   * Creates the DB row if absent (reusing an existing row if one is already present), sets `tagIds`
   * on it, and returns the canonical FileDTO. Throws LOUD if the file is missing on disk or the row
   * cannot be created — the caller surfaces this as a blocking modal.
   *
   * @param absolutePath Absolute path of the committed output (any separator form).
   * @param locationId   The owning location (the output is a sibling of the source).
   * @param tagIds       Tag ids to set on the row (from the source file).
   */
  @action async ingestFile(absolutePath: string, locationId: ID, tagIds: ID[]): Promise<FileDTO> {
    const fwd = absolutePath.replace(/\\/g, '/');
    const normalized = fwd.toLowerCase();
    const findRow = (rows: FileDTO[]): FileDTO | undefined =>
      rows.find((f) => f.absolutePath.replace(/\\/g, '/').toLowerCase() === normalized);

    let dto = findRow(await this.backend.fetchFilesByKey('absolutePath', fwd));

    if (dto === undefined) {
      const location = this.get(locationId);
      if (location === undefined) {
        throw new Error(`ingestFile: location ${locationId} not found for "${absolutePath}"`);
      }
      const stat = await platform.fs.stat(absolutePath).catch((e: unknown) => {
        throw new Error(`ingestFile: "${absolutePath}" is missing on disk — ${String(e)}`);
      });
      const newDto = await pathToIFile(
        {
          absolutePath: fwd,
          dateCreated: stat.birthtime,
          dateModified: stat.mtime,
          size: Number(stat.size),
          ino: stat.ino.toString(),
        },
        location,
        this.rootStore.imageLoader,
      );
      // createFilesFromPath dedups by path in a serialized transaction; re-fetch the canonical row.
      await this.backend.createFilesFromPath(fwd, [newDto]);
      dto = findRow(await this.backend.fetchFilesByKey('absolutePath', fwd));
      if (dto === undefined) {
        throw new Error(`ingestFile: failed to create a library row for "${absolutePath}"`);
      }
    }

    dto.tags = tagIds;
    await this.backend.saveFiles([dto]);
    return dto;
  }

  @action async addFile(fileStats: FileStats, location: ClientLocation): Promise<void> {
    const fileStore = this.rootStore.fileStore;

    // Skip files the renderer is ingesting deterministically (media-job outputs). Without this the
    // watcher would create a SECOND, untagged row for the same path and race the renderer's ingest.
    if (this.suppressedIngestPaths.has(LocationStore.normalizePath(fileStats.absolutePath))) {
      return;
    }

    // Gather file data
    const file = await pathToIFile(fileStats, location, this.rootStore.imageLoader);

    // Check if file is being moved/renamed (which is detected as a "add" event followed by "remove" event)
    const match = runInAction(() => fileStore.fileList.find((f) => f.ino === fileStats.ino));
    const dbMatch = match
      ? undefined
      : (await this.backend.fetchFilesByKey('ino', fileStats.ino))[0];

    if (match) {
      if (fileStats.absolutePath === match.absolutePath) {
        return;
      }
      fileStore.replaceMovedFile(match, file);
    } else if (dbMatch) {
      const newIFile = mergeMovedFile(dbMatch, file);
      this.rootStore.fileStore.save(newIFile);
    } else {
      await this.backend.createFilesFromPath(fileStats.absolutePath, [file]);

      AppToaster.show({ message: 'New images have been detected.', timeout: 5000 }, 'new-images');
      // might be called a lot when moving many images into a folder, so debounce it
      fileStore.debouncedRefetch();
    }
  }

  @action hideFile(path: string): void {
    // This is called when an image is removed from the filesystem.
    // Could also mean that a file was renamed or moved, in which case addFile was called already:
    // its path will have changed, so we won't find it here, which is fine, it'll be detected as missing later.
    const fileStore = this.rootStore.fileStore;
    const clientFile = fileStore.fileList.find((f) => f.absolutePath === path);

    if (clientFile) {
      fileStore.hideFile(clientFile);
      fileStore.debouncedRefetch();
    }
  }

  /**
   * Fetches the files belonging to a location
   */
  @action async findLocationFiles(locationId: ID): Promise<FileDTO[]> {
    const crit = new ClientStringSearchCriteria('locationId', locationId, 'equals').toCondition();
    return this.backend.searchFiles(crit, 'id', OrderDirection.Asc);
  }

  @action async removeSublocationFiles(subLoc: ClientSubLocation): Promise<void> {
    const crit = new ClientStringSearchCriteria(
      'absolutePath',
      subLoc.path,
      'startsWith',
    ).toCondition();
    const files = await this.backend.searchFiles(crit, 'id', OrderDirection.Asc);
    await this.backend.removeFiles(files.map((f) => f.id));

    // Splice the removed files out of the in-memory fileList in place rather
    // than refetching, so the visible gallery order is preserved (no reshuffle
    // under random sort). Resolve backend FileDTO rows to ClientFile instances
    // via the fileStore index; files not present in fileList (e.g. already
    // hidden as broken) are safely skipped.
    const { fileStore } = this.rootStore;
    const removedIds = new Set(files.map((f) => f.id));
    const clientFilesToRemove = fileStore.fileList.filter((cf) => removedIds.has(cf.id));
    if (clientFilesToRemove.length > 0) {
      for (const cf of clientFilesToRemove) {
        cf.dispose();
      }
      fileStore.removeFilesFromListInPlace(clientFilesToRemove);
    }
  }

  /** Source is moved to where Target currently is */
  @action.bound reorder(source: ClientLocation, target: ClientLocation): void {
    const sourceIndex = this.locationList.indexOf(source);
    const targetIndex = this.locationList.indexOf(target);

    // Remove the source element and insert it at the target index
    this.locationList.remove(source);
    this.locationList.splice(targetIndex, 0, source);

    // Update the index for all changed items: all items between source and target have been moved
    const startIndex = Math.min(sourceIndex, targetIndex);
    const endIndex = Math.max(sourceIndex, targetIndex);
    for (let i = startIndex; i <= endIndex; i++) {
      this.locationList[i].setIndex(i);
      this.save(this.locationList[i].serialize());
    }
  }
}

export type FileStats = {
  absolutePath: string;
  /** When file was last modified on disk */
  dateModified: Date;
  /** When file was created on disk */
  dateCreated: Date;
  /** Current size of the file in bytes */
  size: number;
  /** A unique identifier of the file created by the OS, stays identical even when renaming/moving files */
  ino: string;
};

/**
 * Compute a file's path relative to its location ROBUSTLY.
 *
 * `ClientFile` reconstructs its `absolutePath` as `Path.join(location.path, relativePath)`
 * (entities/File.ts), so `relativePath` MUST strip the location prefix correctly — otherwise the
 * rejoin DOUBLES the drive (e.g. `X:/X:/live stream/clip.mp4`, the reported media-job-output bug).
 * The naive `absolutePath.replace(loc.path, '')` silently fails when the two differ in path
 * separator (`/` vs `\`), drive-letter case, or a trailing slash — leaving `relativePath` equal to
 * the full path. This normalizes both sides (forward slashes, lower-case) before stripping, then
 * slices the ORIGINAL string so the returned segment keeps its real case. If the location is
 * genuinely not a prefix, it falls back to the basename so the rejoin can never double the drive.
 */
function relativePathFromLocation(absolutePath: string, locationPath: string): string {
  const absFwd = absolutePath.replace(/\\/g, '/');
  const locFwd = locationPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (absFwd.toLowerCase() === locFwd.toLowerCase()) {
    return '';
  }
  if (absFwd.toLowerCase().startsWith(locFwd.toLowerCase() + '/')) {
    return absFwd.slice(locFwd.length); // keeps the leading '/'
  }
  // Not a prefix (unreconcilable separator/case/drive mismatch): use the basename so
  // Path.join(location.path, relativePath) stays inside the location and never doubles the drive.
  return '/' + platform.path.basename(absFwd);
}

export async function pathToIFile(
  stats: FileStats,
  loc: ClientLocation,
  imageLoader: ImageLoader,
): Promise<FileDTO> {
  const now = new Date();
  return {
    absolutePath: stats.absolutePath,
    relativePath: relativePathFromLocation(stats.absolutePath, loc.path),
    ino: stats.ino,
    id: generateId(),
    locationId: loc.id,
    tags: [],
    dateAdded: now,
    dateModified: now,
    dateLastIndexed: now,
    annotations: '{}',
    ...(await getMetaData(stats, imageLoader)),
  };
}

/**
 * Enhanced version of pathToIFile that can optionally read and process tags during file creation.
 * This eliminates the need for a separate readTagsFromFiles() call during location loading.
 */
export async function pathToIFileWithMetadata(
  stats: FileStats,
  loc: ClientLocation,
  imageLoader: ImageLoader,
  tagStore?: TagStore,
  readTags: boolean = false,
): Promise<FileDTO> {
  const now = new Date();

  if (!readTags || !tagStore) {
    // Use existing method for backwards compatibility
    return pathToIFile(stats, loc, imageLoader);
  }

  // Use the enhanced metadata reading that gets both dimensions and tags in one call
  const extendedMetadata = await getMetaDataWithTags(stats, imageLoader, true);

  // Process tags and convert them to tag IDs for the database
  const tagIds: string[] = [];

  if (extendedMetadata.tagHierarchies && extendedMetadata.tagHierarchies.length > 0) {
    for (const tagHierarchy of extendedMetadata.tagHierarchies) {
      const match = tagStore.findByName(tagHierarchy[tagHierarchy.length - 1]);
      if (match) {
        // If there is a match to the leaf tag, add it directly
        tagIds.push(match.id);
        match.incrementFileCount();
      } else {
        // If there is no direct match to the leaf, insert it in the tag hierarchy
        let curTag = tagStore.root;
        for (const nodeName of tagHierarchy) {
          const nodeMatch = tagStore.findByName(nodeName);
          if (nodeMatch) {
            curTag = nodeMatch;
          } else {
            curTag = await tagStore.create(curTag, nodeName);
          }
        }
        tagIds.push(curTag.id);
        curTag.incrementFileCount();
      }
    }
  }

  return {
    absolutePath: stats.absolutePath,
    relativePath: relativePathFromLocation(stats.absolutePath, loc.path),
    ino: stats.ino,
    id: generateId(),
    locationId: loc.id,
    tags: tagIds,
    dateAdded: now,
    dateModified: now,
    dateLastIndexed: now,
    annotations: '{}',
    name: extendedMetadata.name,
    extension: extendedMetadata.extension,
    size: extendedMetadata.size,
    width: extendedMetadata.width,
    height: extendedMetadata.height,
    dateCreated: extendedMetadata.dateCreated,
  };
}

export default LocationStore;
