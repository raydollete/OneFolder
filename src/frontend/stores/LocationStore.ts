import { action, makeObservable, observable, runInAction } from 'mobx';

import { getThumbnailPath, getPreviewPath, portableFileKey } from 'common/fs';
import { promiseAllLimit, yieldToEventLoop } from 'common/promise';
import { perf } from '../perf';
import {
  buildDbFilesByCreatedDate,
  matchMissingToCreated,
  matchMissingToDbDuplicates,
  recomputeAbsolutePaths,
  computeAnchorSegment,
  resolveAnchoredPath,
  fileIdentityKey,
} from './locationReconciliation';
import { planCacheRenames } from './portableCacheMigration';
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
import {
  applyProbeUpdatesToRows,
  buildProbeCandidatesFromRows,
} from 'src/ipc/videoProbePass';
import RootStore from './RootStore';
import TagStore from './TagStore';

type Preferences = { extensions: IMG_EXTENSIONS_TYPE[] };

function getLocationPrefsKey(prefix?: string): string {
  return prefix ? `${prefix}:location-store-preferences` : 'location-store-preferences';
}

// File-identity matching for reconciliation lives in locationReconciliation.ts
// (Map-indexed, O(missing + created) instead of nested .find scans).

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

  /**
   * The portable application directory — `dirname(userData)`. In portable mode
   * userData is `<portableDir>/data`, so this is `<portableDir>`, the root that
   * portable-anchored locations are resolved against (and auto-anchored under).
   * Resolved once in init(); undefined until then, and in non-portable/web
   * contexts where the probe fails (locations then stay absolute).
   */
  private portableDirectory: string | undefined;

  /**
   * The shared library data directory (`userData`) — where the one-time
   * portable-cache-migration marker lives. Shared by both OSes of a dual-boot
   * install, so the marker is OS-discriminated. Undefined on web/probe failure.
   */
  private dataDirectory: string | undefined;

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
    // Resolve the portable directory once (dirname of userData). Portable-anchored
    // locations resolve their per-OS root against it. Non-fatal: if it can't be
    // determined (web build / probe failure) anchored resolution is skipped and
    // locations keep their stored absolute path.
    try {
      const userData = await platform.desktop.getPath('userData');
      this.dataDirectory = userData;
      this.portableDirectory = platform.path.dirname(userData);
    } catch (e) {
      console.warn('[LocationStore] could not resolve portable directory; anchors inactive', e);
      this.dataDirectory = undefined;
      this.portableDirectory = undefined;
    }

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
          // Portable-anchored locations resolve their root per-OS against the
          // portable directory; unanchored ones keep their stored absolute path.
          resolveAnchoredPath(this.portableDirectory, dir.path, dir.portableRoot, platform.path.join),
          dir.dateAdded,
          dir.subLocations,
          runInAction(() => Array.from(this.enabledFileExtensions)),
          dir.index ?? i,
          dir.portableRoot,
        ),
    );
    runInAction(() => this.locationList.replace(locations));

    await this.autoAnchorLocations();
  }

  /**
   * One-time migration (idempotent): anchor any not-yet-anchored location whose
   * current root lies within the portable directory, so the next boot resolves it
   * per-OS. Persists the anchor for later boots; the in-memory location keeps its
   * (already valid) resolved path this session. Locations outside the portable
   * directory (external drives) and already-anchored ones are left untouched.
   */
  @action private async autoAnchorLocations(): Promise<void> {
    const portableDir = this.portableDirectory;
    if (portableDir === undefined) {
      return;
    }
    for (const loc of this.locationList) {
      if (loc.portableRoot !== undefined) {
        continue;
      }
      const segment = computeAnchorSegment(portableDir, loc.path, platform.path.normalizePathIdentity);
      if (segment === undefined) {
        continue;
      }
      await this.backend.saveLocation({ ...loc.serialize(), portableRoot: segment });
    }
  }

  /**
   * One-time (per-OS) rename of existing thumbnail/preview cache files from the
   * legacy absolute-path key to the portable key, so an upgraded or shared
   * library reuses its caches instead of regenerating them. Guarded by an
   * OS-discriminated marker in the shared data directory (two OSes of a dual-boot
   * install share `data/`, so the marker must not let one suppress the other).
   * Best-effort: failures are logged, never thrown.
   */
  @action private async migratePortableCaches(rawDbFiles: FileDTO[]): Promise<void> {
    if (platform.isWebBuild || this.dataDirectory === undefined) {
      return;
    }
    const thumbnailDir = runInAction(() => this.rootStore.uiStore.thumbnailDirectory);
    // thumbnailDirectory is set asynchronously; if it is not ready yet, skip
    // WITHOUT writing the marker so the migration retries on a later launch.
    if (!thumbnailDir) {
      return;
    }
    // Windows uses a backslash separator; POSIX a forward slash. Enough to keep
    // the two OSes' markers distinct in the shared data directory.
    const osTag = platform.path.sep === '\\' ? 'win' : 'posix';
    const marker = platform.path.join(this.dataDirectory, `.portable-cache-migrated-${osTag}`);
    if (platform.fs.existsSync(marker)) {
      return;
    }

    const renames = planCacheRenames(
      rawDbFiles,
      thumbnailDir,
      [getThumbnailPath, getPreviewPath],
      portableFileKey,
      (p) => platform.fs.existsSync(p),
    );
    let renamed = 0;
    for (const { from, to } of renames) {
      try {
        await platform.fs.ensureDir(platform.path.dirname(to));
        await platform.fs.move(from, to);
        renamed++;
      } catch (e) {
        console.warn('[LocationStore] cache rename failed', from, '->', to, e);
      }
    }
    try {
      await platform.fs.writeFile(marker, new ArrayBuffer(0));
    } catch (e) {
      console.warn('[LocationStore] could not write cache-migration marker', marker, e);
    }
    console.info(
      `[LocationStore] portable cache migration: renamed ${renamed}/${renames.length} entries (${osTag})`,
    );
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

    perf.startPhase('reconcile');

    // Get all files in the DB, set up data structures for quick lookups.
    // Doing it for all locations, so files moved to another Location on disk, it's properly re-assigned in OneFolder too.
    // The startup fetch already loaded every row — reuse those DTOs instead of
    // re-fetching the entire library a second time (falls back to a fetch when
    // the session started on a search view and the cache was never filled).
    // Recompute each stored file's absolutePath from its location's resolved,
    // current-OS root before reconciling. On a shared library booted from the
    // other OS the stored absolutePath values are foreign; normalizing them here
    // (in memory, no DB sweep) is what keeps the created/missing comparisons
    // below from flagging the entire library as new+gone. The durable identity
    // is (locationId, relativePath); this only refreshes the derived column.
    const rawDbFiles: FileDTO[] =
      this.rootStore.fileStore.consumeStartupFetchDTOs() ??
      (await this.backend.fetchFiles('id', OrderDirection.Asc));

    // One-time (per-OS) rename of existing thumbnail/preview caches onto the
    // portable key, using each row's LEGACY stored absolutePath — so an upgraded
    // library reuses its caches instead of regenerating them. Uses rawDbFiles
    // (pre-recompute), which still hold the absolute path the caches were named
    // from. Best-effort and destination-exists-safe (see planCacheRenames).
    await this.migratePortableCaches(rawDbFiles);

    const dbFiles: FileDTO[] = recomputeAbsolutePaths(rawDbFiles, (locationId, relativePath) => {
      const loc = this.get(locationId);
      return loc ? platform.path.join(loc.path, relativePath) : undefined;
    });
    // Key created/missing detection on the durable identity (locationId,
    // relativePath) through the path-identity seam, NOT the per-OS absolutePath:
    // on a cross-OS boot the stored and on-disk absolute paths differ, but the
    // identity is stable, so nothing is falsely flagged created or missing.
    const identityKey = (locationId: ID, relativePath: string): string =>
      fileIdentityKey(locationId, relativePath, platform.path.normalizePathIdentity);
    const dbFilesKeySet = new Set(dbFiles.map((f) => identityKey(f.locationId, f.relativePath)));
    const dbFilesByCreatedDate = buildDbFilesByCreatedDate(dbFiles);
    // Per-location grouping so the per-location passes below don't rescan the
    // entire library once per location.
    const dbFilesByLocation = new Map<ID, FileDTO[]>();
    for (const file of dbFiles) {
      const entry = dbFilesByLocation.get(file.locationId);
      if (entry !== undefined) {
        entry.push(file);
      } else {
        dbFilesByLocation.set(file.locationId, [file]);
      }
    }

    // Files confirmed gone from disk (not renamed/moved/deduped) — becomes the
    // new missingFileIds truth in FileStore at the end of reconciliation.
    const stillMissingIds = new Set<ID>();

    // For every location, find created/moved/deleted files, and update the database accordingly.
    // The matching passes are Map-indexed (locationReconciliation.ts) and the
    // loops yield to the event loop in bounded slices, so reconciliation never
    // parks a long task on the renderer thread while the gallery is interactive.
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
      // Index disk files by the same portable identity key. Each disk file's
      // relativePath is derived from the location's resolved root, so the key
      // matches the DB rows' key regardless of which OS wrote them.
      const diskFilesWithKey =
        diskFiles?.map((f) => ({
          file: f,
          key: identityKey(location.id, relativePathFromLocation(f.absolutePath, location.path)),
        })) ?? [];
      const diskFileMap = new Map<string, FileStats>(
        diskFilesWithKey.map(({ file, key }) => [key, file]),
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
      // Find all files that have been created (those on disk but not in DB).
      // Metadata extraction per created file is I/O-heavy — bounded to 50
      // concurrent (formerly an unbounded Promise.all).
      const createdPaths = diskFilesWithKey
        .filter(({ key }) => !dbFilesKeySet.has(key))
        .map(({ file }) => file);
      const createdFiles = await promiseAllLimit(
        createdPaths.map((path) => () => pathToIFile(path, location, this.rootStore.imageLoader)),
        50,
      );

      // Find all files of this location that have been removed (those in DB but not on disk anymore)
      const locationDbFiles = dbFilesByLocation.get(location.id) ?? [];
      const missingFiles = locationDbFiles.filter(
        (file) => !diskFileMap.has(identityKey(file.locationId, file.relativePath)),
      );
      await yieldToEventLoop();

      // Find matches between removed and created images (different name/path
      // but same characteristics) — Map-indexed by ino and identity key.
      const createdMatches = matchMissingToCreated(missingFiles, createdFiles);
      // Also look for duplicate files: when a file is renamed/moved it will become a new entry, should be de-duplicated
      const dbMatches = matchMissingToDbDuplicates(
        missingFiles,
        createdMatches,
        dbFilesByCreatedDate,
      );
      await yieldToEventLoop();

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

      // Record which missing files were NOT explained as renames/moves — they
      // are genuinely gone from disk and feed FileStore's missingFileIds.
      for (let mi = 0; mi < missingFiles.length; mi++) {
        if (!createdMatches[mi] && !dbMatches[mi]) {
          stillMissingIds.add(missingFiles[mi].id);
        }
      }

      // Also update files that have changed, e.g. when overwriting a file (with same filename)
      // --> update metadata (resolution, size) and recreate thumbnail
      // This can be accomplished by comparing the dateLastIndexed of the file in DB to dateModified of the file on disk
      // (scans only THIS location's rows, in yielded slices — not the whole library per location)
      const updatedFiles: FileDTO[] = [];
      const thumbnailDirectory = runInAction(() => this.rootStore.uiStore.thumbnailDirectory);
      let scanned = 0;
      for (const dbFile of locationDbFiles) {
        if (++scanned % 2000 === 0) {
          await yieldToEventLoop();
        }
        const diskFile = diskFileMap.get(identityKey(dbFile.locationId, dbFile.relativePath));
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
          const thumbPath = getThumbnailPath(
            portableFileKey(dbFile.locationId, dbFile.relativePath),
            thumbnailDirectory,
          );
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

    // Publish the reconciled existence truth: materialized files flip their
    // isBroken flag here, and subsequent fetches derive existence from this
    // set instead of statting the disk per load.
    this.rootStore.fileStore.reconcileMissingFiles(stillMissingIds);
    perf.endPhase('reconcile');

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

    // A manual re-point must update (or clear) the portable anchor so the next
    // boot's per-OS resolution does not override the user's new root (Finding H):
    // if newPath is under the portable directory, re-anchor to its segment;
    // otherwise drop the anchor and keep newPath as a fixed absolute path.
    const newSegment = this.portableDirectory
      ? computeAnchorSegment(this.portableDirectory, newPath, platform.path.normalizePathIdentity)
      : undefined;
    const newLocation = new ClientLocation(
      this,
      location.id,
      newPath,
      location.dateAdded,
      location.subLocations,
      runInAction(() => Array.from(this.enabledFileExtensions)),
      this.locationList.length,
      newSegment,
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
    // Auto-anchor a newly added folder that lives under the portable directory so
    // it is portable from creation (resolves per-OS on the next boot); folders
    // outside it stay unanchored (fixed absolute path, e.g. an external drive).
    const segment = this.portableDirectory
      ? computeAnchorSegment(this.portableDirectory, path, platform.path.normalizePathIdentity)
      : undefined;
    const location = new ClientLocation(
      this,
      generateId(),
      path,
      new Date(),
      [],
      runInAction(() => Array.from(this.enabledFileExtensions)),
      this.locationList.length,
      segment,
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

    // Background codec triage for the freshly loaded files (support-mov-playback).
    this.startCodecProbePass();

    // No need for separate readTagsFromFiles() call - tags are already processed during file creation!
    // This eliminates the redundant ExifTool reads that were making location loading slow
  }

  /** In-flight guard so overlapping triggers (init + watch) run one pass. */
  private codecProbeInFlight = false;

  /**
   * Kick off the background video codec probe pass (support-mov-playback).
   *
   * Desktop build only — the read-only sidecar never probes and never writes
   * (platform seam contract: platform.web rejects this call outright). The
   * renderer only offers recognized-video files; the main process stats each
   * file and spawns ffprobe only when the (path, size, mtime) cache key or the
   * MOV_CODEC_VERSION stamp is stale, so a fresh verdict costs zero spawns.
   * Probe failures are logged loudly in main and leave the row NULL — an
   * absent verdict NEVER renders as unplayable.
   *
   * Deliberately not called from addFile/ingestFile or media-job placement:
   * probing there races the folder watcher (.planning/codebase/CONCERNS.md:55-65).
   */
  @action.bound startCodecProbePass(): void {
    if (IS_WEB_BUILD || this.codecProbeInFlight) {
      return;
    }
    this.codecProbeInFlight = true;
    (async () => {
      // Candidates come from the DB's canonical rows, NOT from
      // fileStore.fileList: the gallery materializes progressively and the
      // old trigger fired BEFORE this startup's ingest, so fresh clips were
      // (observed) never probed — every fact stayed NULL.
      const rows = await this.backend.fetchFiles('id', OrderDirection.Asc);
      const candidates = buildProbeCandidatesFromRows(rows, (row) => {
        const loc = this.get(row.locationId);
        return loc ? platform.path.join(loc.path, row.relativePath) : undefined;
      });
      if (candidates.length === 0) {
        return;
      }
      const updates = await platform.desktop.probeVideoCodecs(candidates);
      if (updates.length === 0) {
        return;
      }
      const byId = new Map(updates.map((u) => [u.id, u]));
      const materialized = new Set<string>();
      runInAction(() => {
        for (const file of this.rootStore.fileStore.fileList) {
          const update = byId.get(file.id);
          if (update !== undefined) {
            materialized.add(file.id);
            // Observable write → the gallery badge/banner re-derive; the
            // markDirty inside persists videoCodec/audioCodec/formatName/
            // codecVersion. formatName is passed explicitly (its parameter is
            // optional: omitting it would preserve a stale container fact).
            file.setCodecFacts(
              update.videoCodec,
              update.audioCodec,
              update.codecVersion,
              update.formatName,
            );
          }
        }
      });
      // Rows not yet materialized as ClientFiles: persist the facts directly,
      // or this probe is silently wasted for the progressive-load tail.
      const unmaterialized = rows.filter((row) => !materialized.has(row.id));
      const toPersist = applyProbeUpdatesToRows(unmaterialized, updates);
      if (toPersist.length > 0) {
        await this.backend.saveFiles(toPersist);
      }
    })()
      .catch((err) => console.error('Video codec probe pass failed', err))
      .finally(() => {
        this.codecProbeInFlight = false;
      });
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
    // Shared path-identity seam: separators folded to '/', case folded only on
    // Windows so Linux/macOS paths remain case-sensitive.
    return platform.path.normalizePathIdentity(absolutePath);
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
    // Path-identity key via the shared seam (separators + Windows-only case fold).
    const normalized = platform.path.normalizePathIdentity(absolutePath);
    const findRow = (rows: FileDTO[]): FileDTO | undefined =>
      rows.find((f) => platform.path.normalizePathIdentity(f.absolutePath) === normalized);

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
      if (
        platform.path.normalizePathIdentity(fileStats.absolutePath) ===
        platform.path.normalizePathIdentity(match.absolutePath)
      ) {
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
    const target = platform.path.normalizePathIdentity(path);
    const clientFile = fileStore.fileList.find(
      (f) => platform.path.normalizePathIdentity(f.absolutePath) === target,
    );

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
    // Key on the portable identity: the sublocation's path RELATIVE to its
    // location, scoped by locationId — not the per-OS absolutePath prefix, which
    // silently matched nothing on a cross-OS boot (Finding F). Append the
    // separator so a sibling like `/sub/dir2` is not swept when excluding
    // `/sub/dir`.
    const location = subLoc.location;
    const subRelative = relativePathFromLocation(subLoc.path, location.path);
    const subRelativePrefix = subRelative.endsWith('/') ? subRelative : `${subRelative}/`;
    const files = await this.backend.searchFiles(
      [
        new ClientStringSearchCriteria('locationId', location.id, 'equals').toCondition(),
        new ClientStringSearchCriteria('relativePath', subRelativePrefix, 'startsWith').toCondition(),
      ],
      'id',
      OrderDirection.Asc,
    );
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
  // Compare via the shared path-identity seam (Windows-only case fold). The seam
  // only folds case (and separators, already folded above), so lengths are
  // preserved — slicing absFwd / using locFwd.length below stays index-correct.
  const absId = platform.path.normalizePathIdentity(absFwd);
  const locId = platform.path.normalizePathIdentity(locFwd);
  if (absId === locId) {
    return '';
  }
  if (absId.startsWith(locId + '/')) {
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
