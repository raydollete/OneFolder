import {
  action,
  computed,
  makeObservable,
  observable,
  reaction,
  runInAction,
  transaction,
} from 'mobx';

import { getThumbnailPath, mediaTypeMatches } from 'common/fs';
import { IS_DEV } from 'common/process';
import { promiseAllLimit, yieldToEventLoop } from 'common/promise';
import { debounce } from 'common/timeout';
import { perf } from '../perf';
import {
  newSeed,
  orderBySeededRank,
  orderByTagCountSeeded,
  orderIdsBySeededRank,
} from './seededShuffle';
import { DataStorage } from '../../api/data-storage';
import { ConditionDTO, OrderBy, OrderDirection } from '../../api/data-storage-search';
import { FileDTO, IMG_EXTENSIONS_TYPE } from '../../api/file';
import { ID } from '../../api/id';
import { AppToaster } from '../components/Toaster';
import { ClientFile, mergeMovedFile } from '../entities/File';
import { ClientLocation } from '../entities/Location';
import { ClientStringSearchCriteria, ClientTagSearchCriteria } from '../entities/SearchCriteria';
import { ClientTag } from '../entities/Tag';
import RootStore from './RootStore';
import platform from 'src/frontend/platform';

/**
 * Dev-build regressions this file watches for:
 *
 * - [INV-007 regression] — refetch() caused a content-mode change. Indicates
 *   a self-clobber: some code path is fusing list-mutation with view-switching.
 *   See INV-007 Defect B, TASK-036.
 *
 * - [INV-009] dropped stale apply — a fetcher's result was discarded because
 *   a newer fetcher had dispatched in the meantime. Expected during the
 *   initial-scan window if the user filters early. Unexpected during steady-state.
 *   See INV-009, TASK-043/044.
 */
export const FILE_STORAGE_KEY = 'OneFolder_File';

/**
 * Returns the namespaced localStorage key for FileStore preferences.
 * When a libraryId is provided, the key is scoped to that library.
 */
export function getFileStorageKey(libraryId?: string): string {
  return libraryId ? `${libraryId}:OneFolder_File` : 'OneFolder_File';
}

/** These fields are stored and recovered when the application opens up */
type PersistentPreferenceFields = 'orderDirection' | 'orderBy';

const enum Content {
  All,
  Missing,
  Untagged,
  Query,
  Duplicates,
}

class FileStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

  readonly fileList = observable<ClientFile>([]);
  /**
   * The timestamp when the fileList was last modified.
   * Useful for in react component dependencies that need to trigger logic when the fileList changes
   */
  fileListLastModified = observable<Date>(new Date());
  /** A map of file ID to its index in the file list, for quick lookups by ID */
  private readonly index = new Map<ID, number>();

  private filesToSave: Map<ID, FileDTO> = new Map();

  /** The origin of the current files that are shown */
  @observable private content: Content = Content.All;
  @observable orderDirection: OrderDirection = OrderDirection.Desc;
  @observable orderBy: OrderBy<FileDTO> = 'random';
  @observable numTotalFiles = 0;
  @observable numUntaggedFiles = 0;
  @observable numMissingFiles = 0;

  debouncedRefetch: () => void;
  debouncedSaveFilesToSave: () => Promise<void>;

  /**
   * Monotonically-increasing generation counter for in-flight fetches.
   * Each fetcher increments this at dispatch and captures the value; the
   * apply functions (updateFromBackend and fetchMissingFiles's inline
   * apply) compare captured-vs-current and silently drop stale results.
   * See INV-009 for the race this protects against.
   *
   * Not @observable — no UI reads it, making it observable would trigger
   * reactions on every fetch.
   */
  private fetchGeneration = 0;

  /**
   * Dev-only counter of stale apply drops. Incremented each time
   * updateFromBackend or fetchMissingFiles discards a result due to
   * generation mismatch. Zero under normal operation.
   */
  @observable droppedApplyCount = 0;

  /** The library-scoped localStorage key prefix. Empty string = legacy global behaviour. */
  readonly storageKeyPrefix: string;

  /**
   * Session-stable seed for the "random" sort modes. The seeded per-file rank
   * (seededShuffle.ts) replaces SQL `ORDER BY RANDOM()`: refetches within a
   * session keep every file's position; a fresh shuffle happens only when the
   * user explicitly re-selects a random ordering (orderFilesBy reseeds) or on
   * a new session (construction).
   */
  private randomSeed = newSeed();

  /**
   * Ids of files known to be missing on disk. THE existence source for the
   * load path: fetches no longer stat every file (the per-load pathExists
   * sweep is gone). Populated by watcher reconciliation (LocationStore.
   * watchLocations → reconcileMissingFiles), runtime unlink events (hideFile),
   * the Missing-files audit view, and on-demand load-failure checks
   * (verifyFileExistence).
   */
  private readonly missingFileIds = new Set<ID>();

  /**
   * Files with unsaved observable changes (tags/annotations). Mutation methods
   * on ClientFile call markFileDirty(); one debounced flusher serializes only
   * dirty files — replacing the former one-reaction-per-file auto-save.
   */
  private readonly dirtyFiles = new Set<ClientFile>();
  private readonly debouncedFlushDirtyFiles: () => void;

  /**
   * Raw DTOs of the startup full fetch, retained once so watchLocations can
   * reconcile against them instead of re-fetching the entire library a second
   * time. Consumed (and cleared) by consumeStartupFetchDTOs().
   */
  private cachedStartupDTOs: FileDTO[] | undefined = undefined;
  private startupCacheArmed = true;

  constructor(backend: DataStorage, rootStore: RootStore, storageKeyPrefix = '') {
    this.backend = backend;
    this.rootStore = rootStore;
    this.storageKeyPrefix = storageKeyPrefix;
    makeObservable(this);

    this.debouncedRefetch = debounce(this.refetch, 200).bind(this);
    this.debouncedSaveFilesToSave = debounce(this.saveFilesToSave, 100).bind(this);
    // Same 500 ms envelope as the former per-file reaction's { delay: 500 }.
    this.debouncedFlushDirtyFiles = debounce(this.flushDirtyFiles, 500).bind(this);

    // Pending edits must never be lost on quit: flush the dirty set and the
    // save queue synchronously on unload (better-sqlite3 writes execute
    // synchronously under the async facade, so this completes on desktop).
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }
  }

  private handleBeforeUnload = (): void => {
    this.flushDirtyFiles();
    void this.saveFilesToSave();
  };

  /**
   * Wire up reactions that read OTHER stores on the root store.
   *
   * Must be called by RootStore after ALL stores are constructed — not from
   * this constructor: FileStore is built before UiStore, so a constructor
   * reaction's immediate first evaluation would throw on the undefined
   * uiStore. Because `rootStore.uiStore` is a plain (non-observable) field,
   * MobX would never re-evaluate after the throw, silently disabling the
   * reaction for the whole session. (This was a real bug: the hide-missing-
   * files toggle did not refetch from the moment INV-004 shipped.)
   */
  watchUiPreferences(): void {
    // When the "hide missing files" preference toggles, re-run the current fetch so
    // the gallery immediately reflects the new setting without requiring a restart.
    reaction(
      () => this.rootStore.uiStore.hideMissingFilesInBrowsing,
      () => this.refetch(),
    );
    // When the media-type filter changes, re-run the current fetch so the gallery
    // immediately reflects the new setting without requiring a restart.
    reaction(
      () => this.rootStore.uiStore.mediaTypeFilter,
      () => this.refetch(),
    );
  }

  /**
   * Finds all files that have a specific tag
   * @param tag The tag to search for
   * @returns Array of files that have this tag
   */
  @action getFilesWithTag(tag: ClientTag): ClientFile[] {
    return this.fileList.filter((file) => file.tags.has(tag));
  }

  /**
   * Updates metadata for all files that have a specific tag
   * This is used when a tag is renamed or moved in hierarchy
   * @param tag The tag that was modified
   */
  @action.bound async updateMetadataForTag(tag: ClientTag): Promise<void> {
    const affectedFiles = this.getFilesWithTag(tag);

    if (affectedFiles.length === 0) {
      return;
    }

    const toastKey = `update-metadata-${tag.id}`;

    try {
      AppToaster.show(
        {
          message: `Updating metadata for ${affectedFiles.length} files...`,
          timeout: 0,
        },
        toastKey,
      );

      // Process files efficiently
      const tasks = affectedFiles.map((file) => async () => {
        const allTags = Array.from(file.tags);
        const tagHierarchy = [];
        for (const tag of allTags) {
          tagHierarchy.push(tag.path);
        }

        try {
          await this.rootStore.exifTool.writeTags(file.absolutePath, tagHierarchy);
        } catch (error) {
          console.error(`Failed to update metadata for file ${file.filename}:`, error);
        }
      });

      await promiseAllLimit(tasks, 5);

      AppToaster.show(
        {
          message: `Successfully updated metadata for ${affectedFiles.length} files`,
          timeout: 3000,
        },
        toastKey,
      );
    } catch (error) {
      console.error('Error during metadata update:', error);
      AppToaster.show(
        {
          message: 'Failed to update metadata for some files',
          timeout: 5000,
        },
        toastKey,
      );
    }
  }

  @action.bound async readTagsFromFiles(): Promise<void> {
    const toastKey = 'read-tags-from-file';
    try {
      const numFiles = this.fileList.length;

      if (numFiles === 0) {
        AppToaster.show(
          {
            message: 'No files to read tags from.',
            timeout: 3000,
          },
          toastKey,
        );
        return;
      }

      let processedFiles = 0;
      const updateProgress = () => {
        processedFiles++;
        const percentage = ((100 * processedFiles) / numFiles).toFixed(0);

        // Format numbers with thousands separators for better readability
        const processedFormatted = processedFiles.toLocaleString();
        const totalFormatted = numFiles.toLocaleString();

        AppToaster.show(
          {
            message: `Reading tags ${percentage}% (${processedFormatted}/${totalFormatted} files)...`,
            timeout: 0,
          },
          toastKey,
        );
      };

      // Create tasks for parallel processing
      const tasks = this.fileList.map((file) => async () => {
        const absolutePath = file.absolutePath;

        try {
          const tagsNameHierarchies = await this.rootStore.exifTool.readTags(absolutePath);

          // CRITICAL FIX: Clear existing tags first to prevent re-adding deleted tags
          // This ensures the file's tags in OneFolder match exactly what's in the metadata

          // Temporarily disable immediate metadata sync for efficient bulk operations
          const reenableSync = file.disableImmediateSync();

          // Clear all existing tags WITHOUT affecting untagged count (this is import, not manual removal)
          file.tags.clear();

          // Now add the tags found in file metadata
          const { tagStore } = this.rootStore;
          for (const tagHierarchy of tagsNameHierarchies) {
            const match = tagStore.findByName(tagHierarchy[tagHierarchy.length - 1]);
            if (match) {
              // If there is a match to the leaf tag, add it directly without count side effects
              file.tags.add(match);
              match.incrementFileCount();
            } else {
              // If there is no direct match to the leaf, insert it in the tag hierarchy: first check if any of its parents exist
              let curTag = tagStore.root;
              for (const nodeName of tagHierarchy) {
                const nodeMatch = tagStore.findByName(nodeName);
                if (nodeMatch) {
                  curTag = nodeMatch;
                } else {
                  curTag = await tagStore.create(curTag, nodeName);
                }
              }
              // Add the tag directly without count side effects
              file.tags.add(curTag);
              curTag.incrementFileCount();
            }
          }

          // Re-enable sync and write final metadata once
          await reenableSync();

          // Update progress
          updateProgress();
        } catch (e) {
          console.error('Could not import tags for', absolutePath, e);
          updateProgress(); // Still update progress even on error
        }
      });

      // Process files in parallel with a concurrency limit to prevent overwhelming the system
      // Use a smaller limit for ExifTool operations since they're more resource-intensive
      const concurrencyLimit = 3;
      await promiseAllLimit(tasks, concurrencyLimit);

      AppToaster.show(
        {
          message: 'Reading tags from files... Done!',
          timeout: 5000,
        },
        toastKey,
      );
    } catch (e) {
      console.error('Could not read tags', e);
      AppToaster.show(
        {
          message: 'Reading tags from files failed. Check the dev console for more details',
          timeout: 5000,
        },
        toastKey,
      );
    }
  }

  // @action.bound async readFacesAnnotationsFromFiles(): Promise<void> {
  //   const toastKey = 'read-faces-annotations-from-file';
  //   try {
  //     const numFiles = this.fileList.length;
  //     for (let i = 0; i < numFiles; i++) {
  //       AppToaster.show(
  //         {
  //           message: `Reading faces annotations from files ${((100 * i) / numFiles).toFixed(
  //             0,
  //           )}%...`,
  //           timeout: 0,
  //         },
  //         toastKey,
  //       );
  //       const file = runInAction(() => this.fileList[i]);

  //       const absolutePath = file.absolutePath;

  //       try {
  //         const facesAnnotations = await this.rootStore.exifTool.readFacesAnnotations(absolutePath);
  //         if (facesAnnotations !== undefined) {
  //           console.log('👍 facesAnnotations', facesAnnotations);
  //           file.addFaceAnnotations(facesAnnotations);
  //         }
  //       } catch (e) {
  //         console.error('Could not import faces annotations for', absolutePath, e);
  //       }
  //     }
  //     AppToaster.show(
  //       {
  //         message: 'Reading faces annotations from files... Done!',
  //         timeout: 5000,
  //       },
  //       toastKey,
  //     );
  //   } catch (e) {
  //     console.error('Could not read faces annotations', e);
  //     AppToaster.show(
  //       {
  //         message:
  //           'Reading faces annotations from files failed. Check the dev console for more details',
  //         timeout: 5000,
  //       },
  //       toastKey,
  //     );
  //   }
  // }

  @action.bound async writeTagsToFiles(): Promise<void> {
    const toastKey = 'write-tags-to-file';
    try {
      const numFiles = this.fileList.length;
      for (let i = 0; i < numFiles; i++) {
        const percentage = ((100 * i) / numFiles).toFixed(0);

        // Format numbers with thousands separators for better readability
        const processedFormatted = i.toLocaleString();
        const totalFormatted = numFiles.toLocaleString();

        AppToaster.show(
          {
            message: `Writing tags ${percentage}% (${processedFormatted}/${totalFormatted} files)...`,
            timeout: 0,
          },
          toastKey,
        );
        const file = runInAction(() => this.fileList[i]);
        const tagHierarchy = Array.from(
          file.tags,
          action((t) => t.path),
        );

        try {
          await this.rootStore.exifTool.writeTags(file.absolutePath, tagHierarchy);
          await this.rootStore.exifTool.writeFacesAnnotations(
            file.absolutePath,
            JSON.parse(file.getAnnotations),
          );
        } catch (e) {
          console.error('Could not write tags to', file.absolutePath, tagHierarchy, e);
        }
      }
      AppToaster.show(
        {
          message: 'Writing tags to files... Done!',
          timeout: 5000,
        },
        toastKey,
      );
    } catch (e) {
      console.error('Could not write tags', e);
      AppToaster.show(
        {
          message: 'Writing tags to files failed. Check the dev console for more details',
          timeout: 5000,
        },
        toastKey,
      );
    }
  }

  @action.bound async reIndexAllFiles(importMetadata?: boolean): Promise<void> {
    const toastKey = 'reindex-all-files';
    let isCancelled = false;
    let completedLocations = 0;

    const handleCancelled = () => {
      console.debug('Aborting re-indexing process');
      isCancelled = true;
    };

    // Store original setting to restore later
    const originalMetadataImportSetting = this.rootStore.uiStore.importMetadataAtLocationLoading;

    try {
      const locations = this.rootStore.locationStore.locationList;
      const numLocations = locations.length;

      if (numLocations === 0) {
        AppToaster.show(
          {
            message: 'No locations to re-index. Add some locations first to use this feature.',
            timeout: 5000,
          },
          toastKey,
        );
        // Restore setting before early return
        this.rootStore.uiStore.setImportMetadataAtLocationLoading(originalMetadataImportSetting);
        return;
      }

      // Check if any locations exist on disk before starting
      const locationChecks = await Promise.allSettled(
        locations.map(async (location) => {
          const exists = await platform.fs.pathExists(location.path);
          return { location, exists };
        }),
      );

      const missingLocations = locationChecks
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<{ location: ClientLocation; exists: boolean }> =>
            result.status === 'fulfilled' && !result.value.exists,
        )
        .map((result) => result.value.location);

      if (missingLocations.length > 0) {
        const locationNames = missingLocations.map((l) => `"${l.name}"`).join(', ');
        AppToaster.show(
          {
            message: `Warning: ${missingLocations.length} location${
              missingLocations.length !== 1 ? 's' : ''
            } not found: ${locationNames}. Re-indexing will continue with available locations.`,
            timeout: 7000,
          },
          `${toastKey}-missing-locations`,
        );
      }

      // Set metadata import setting based on user choice (default to false if not provided)
      const shouldImportMetadata = importMetadata ?? false;
      this.rootStore.uiStore.setImportMetadataAtLocationLoading(shouldImportMetadata);

      const actionDescription = shouldImportMetadata
        ? 'Re-indexing with metadata import'
        : 'Re-indexing (files only)';

      AppToaster.show(
        {
          message: `Starting ${actionDescription.toLowerCase()} of all locations...`,
          timeout: 0,
          clickAction: { label: 'Cancel', onClick: handleCancelled },
        },
        toastKey,
      );

      // Re-index each location with error handling
      for (let i = 0; i < numLocations; i++) {
        if (isCancelled) {
          AppToaster.show(
            {
              message: `Re-indexing cancelled. ${completedLocations}/${numLocations} locations completed.`,
              timeout: 5000,
            },
            toastKey,
          );
          // Restore setting before cancellation return
          this.rootStore.uiStore.setImportMetadataAtLocationLoading(originalMetadataImportSetting);
          return;
        }

        const location = locations[i];
        const progress = `${i + 1}/${numLocations}`;

        const locationMessage = shouldImportMetadata
          ? `${actionDescription} ${progress}: ${location.name} (importing metadata)...`
          : `${actionDescription} ${progress}: ${location.name}...`;

        AppToaster.show(
          {
            message: locationMessage,
            timeout: 0,
            clickAction: { label: 'Cancel', onClick: handleCancelled },
          },
          toastKey,
        );

        try {
          await this.rootStore.locationStore.initLocation(location);
          completedLocations++;
        } catch (error) {
          console.error(`Failed to re-index location "${location.name}":`, error);

          const errorMessage =
            shouldImportMetadata && error instanceof Error && error.message.includes('metadata')
              ? `Warning: Failed to re-index "${location.name}" (metadata import error). Continuing with remaining locations...`
              : `Warning: Failed to re-index "${location.name}". Continuing with remaining locations...`;

          AppToaster.show({ message: errorMessage, timeout: 5000 }, `${toastKey}-error-${i}`);
        }

        // Check cancellation after each location
        if (isCancelled) {
          AppToaster.show(
            {
              message: `Re-indexing cancelled. ${completedLocations}/${numLocations} locations completed.`,
              timeout: 5000,
            },
            toastKey,
          );
          // Restore setting before cancellation return
          this.rootStore.uiStore.setImportMetadataAtLocationLoading(originalMetadataImportSetting);
          return;
        }
      }

      // Final refresh and update counts
      await this.refetch();
      await this.refetchFileCounts();
      this.fetchAllFiles(); // Switch to "All Files" view

      const metadataNote = shouldImportMetadata
        ? ' Tags from image metadata have been imported.'
        : ' Metadata was not imported - only file discovery performed.';

      const successMessage =
        completedLocations === numLocations
          ? `${actionDescription} complete! Found ${this.numTotalFiles} files across ${numLocations} locations.${metadataNote}`
          : `${actionDescription} completed with warnings. Found ${this.numTotalFiles} files. ${completedLocations}/${numLocations} locations processed successfully.${metadataNote}`;

      AppToaster.show({ message: successMessage, timeout: 7000 }, toastKey);
    } catch (e) {
      console.error('Could not re-index files', e);
      AppToaster.show(
        {
          message: `Failed to re-index files: ${e instanceof Error ? e.message : 'Unknown error'}`,
          timeout: 7000,
        },
        toastKey,
      );
    } finally {
      // Always restore the original metadata import setting
      this.rootStore.uiStore.setImportMetadataAtLocationLoading(originalMetadataImportSetting);
    }
  }

  @computed get showsAllContent(): boolean {
    return this.content === Content.All;
  }

  @computed get showsUntaggedContent(): boolean {
    return this.content === Content.Untagged;
  }

  @computed get showsMissingContent(): boolean {
    return this.content === Content.Missing;
  }

  @computed get showsQueryContent(): boolean {
    return this.content === Content.Query;
  }

  @computed get showsDuplicatesContent(): boolean {
    return this.content === Content.Duplicates;
  }

  @action.bound switchOrderDirection(): void {
    this.setOrderDirection(
      this.orderDirection === OrderDirection.Desc ? OrderDirection.Asc : OrderDirection.Desc,
    );
    this.refetch();
  }

  @action.bound orderFilesBy(prop: OrderBy<FileDTO> = 'random'): void {
    if (prop === 'random' || prop === 'tagCountRandom') {
      // Explicit (re-)selection of a random ordering is the one trigger for a
      // fresh shuffle; refetches keep the session-stable seed (see randomSeed).
      this.randomSeed = newSeed();
    }
    this.setOrderBy(prop);
    this.refetch();
  }

  // A view-mode setter only exits SlideMode when the mode ACTUALLY CHANGES (a genuine, user-driven
  // view switch). A same-mode call — which is what every background `refetch()` performs, including
  // the folder watcher's `debouncedRefetch()` fired when a re-encode/normalize/clip output appears
  // as a new file — must NOT disable SlideMode. Disabling it on a same-mode refetch was the primary
  // cause of the post-encode "dropped back to the index" bug (INV-021 redo): the output's add event
  // refetched the active view, which flipped `isSlideMode` to false and tore the viewer to the grid,
  // and it was never re-enabled, so the output "never opened". This also fixes the general latent
  // bug where any new file detected while browsing in SlideMode would kick the user out.
  @action.bound setContentQuery(): void {
    const changed = this.content !== Content.Query;
    this.content = Content.Query;
    if (changed && this.rootStore.uiStore.isSlideMode) {
      this.rootStore.uiStore.disableSlideMode();
    }
  }

  @action.bound setContentAll(): void {
    const changed = this.content !== Content.All;
    this.content = Content.All;
    if (changed && this.rootStore.uiStore.isSlideMode) {
      this.rootStore.uiStore.disableSlideMode();
    }
  }

  @action.bound setContentUntagged(): void {
    const changed = this.content !== Content.Untagged;
    this.content = Content.Untagged;
    if (changed && this.rootStore.uiStore.isSlideMode) {
      this.rootStore.uiStore.disableSlideMode();
    }
  }

  @action.bound setContentDuplicates(): void {
    const changed = this.content !== Content.Duplicates;
    this.content = Content.Duplicates;
    if (changed && this.rootStore.uiStore.isSlideMode) {
      this.rootStore.uiStore.disableSlideMode();
    }
  }

  /**
   * Marks file as missing
   *
   * Marking a file as missing will remove the file from the FileStore stats and
   * automatically 'freezes' the object. Freezing means that changes made to a
   * file will not be saved in the database.
   * @param file
   */
  @action.bound hideFile(file: ClientFile): void {
    file.setBroken(true);
    // Keep the existence source of truth current: the load path derives
    // isBroken from missingFileIds instead of statting the disk per load.
    this.missingFileIds.add(file.id);
    this.rootStore.uiStore.deselectFile(file);
    this.incrementNumMissingFiles();
    if (file.tags.size === 0) {
      this.decrementNumUntaggedFiles();
    }
  }

  /** Replaces a file's data when it is moved or renamed */
  @action.bound replaceMovedFile(file: ClientFile, newData: FileDTO): void {
    const index = this.index.get(file.id);
    if (index !== undefined) {
      file.dispose();

      const newIFile = mergeMovedFile(file.serialize(), newData);

      // Move thumbnail
      const { thumbnailDirectory } = this.rootStore.uiStore; // TODO: make a config store for this?
      const oldThumbnailPath = file.thumbnailPath.replace('?v=1', '');
      const newThumbPath = getThumbnailPath(newData.absolutePath, thumbnailDirectory);
      // Fire-and-forget, but fail loud: log a failed thumbnail move instead of
      // swallowing it (a stale thumbnail then quietly points at the old path).
      platform.fs.move(oldThumbnailPath, newThumbPath).catch((err) => {
        console.warn('[FileStore] thumbnail move failed', oldThumbnailPath, newThumbPath, err);
      });

      const newClientFile = new ClientFile(this, newIFile, this.rootStore.exifTool);
      newClientFile.thumbnailPath = newThumbPath;
      this.fileList[index] = newClientFile;
      this.save(newClientFile.serialize());
    }
  }

  /**
   * Splices the given files out of `fileList` in place, updates all derived
   * state, and reconciles `uiStore.firstItem` so SlideMode auto-advances to
   * the next surviving file (or the previous one if the deleted file was at
   * the tail). Never re-queries the backend — the in-memory fileList is the
   * source of truth for the current visible order.
   *
   * This is the destructive analogue of `replaceMovedFile`. Any code that
   * removes files from the visible list without changing the content mode
   * should call this instead of `refetch()`.
   *
   * Cross-store write: this method writes `uiStore.firstItem`, which is
   * idiomatic for this project (see `cleanFileSelection` reaching into
   * `uiStore.fileSelection`).
   */
  @action removeFilesFromListInPlace(files: ClientFile[]): void {
    if (files.length === 0) {
      return;
    }

    const ids = new Set<ID>(files.map((f) => f.id));
    const { uiStore } = this.rootStore;

    // Snapshot the currently-viewed file AND the old fileList order BEFORE
    // mutating fileList — both are needed for the auto-advance calculation.
    const oldFirstItem = uiStore.firstItem;
    // oldFileList is a shallow copy used for forward/backward scanning after the splice.
    // oldFirstItemId is the ID of the file the user was viewing (undefined if
    // firstItem was out of range, which shouldn't happen in practice).
    const oldFileList = this.fileList.slice();
    const oldFirstItemId: ID | undefined =
      oldFirstItem < oldFileList.length ? oldFileList[oldFirstItem].id : undefined;

    // Record the smallest removed index and the removed files' contributions
    // to the counters BEFORE mutating, for incremental derived-state updates.
    let minRemovedIndex = this.fileList.length;
    let removedMissing = 0;
    let removedUntagged = 0;
    const removedIds = new Set<ID>();
    for (const f of files) {
      const idx = this.index.get(f.id);
      if (idx !== undefined) {
        removedIds.add(f.id);
        minRemovedIndex = Math.min(minRemovedIndex, idx);
        if (f.isBroken) {
          removedMissing++;
        } else if (f.tags.size === 0) {
          removedUntagged++;
        }
      }
    }

    // Splice: for small batches use per-item remove (O(n*k)); for larger
    // batches rebuild via clear() + push(...survivors).
    // POLICY (unified with updateFromBackend): observableArray.replace() is
    // banned for large arrays until MobX #3189 is verified fixed on the pinned
    // MobX 6.x — clear+push is the one blessed large-list mutation everywhere
    // (this site previously used replace() while the load path banned it).
    let actualRemovals = 0;
    if (ids.size > 50) {
      const survivors = this.fileList.filter((f) => !ids.has(f.id));
      actualRemovals = this.fileList.length - survivors.length;
      this.fileList.clear();
      this.fileList.push(...survivors);
    } else {
      for (let i = this.fileList.length - 1; i >= 0; i--) {
        const f = this.fileList[i];
        if (ids.has(f.id)) {
          this.fileList.remove(f);
          actualRemovals++;
        }
      }
    }

    // Incremental derived-state update: index entries before the first removed
    // position are untouched; only the shifted tail is rewritten. A full
    // updateFileListState() pass over the entire list per delete is exactly
    // the O(N)-per-mutation cost this replaces. Counters move by the removed
    // files' contributions (note: unlike the former full recount, a delete no
    // longer zeroes the hidden-missing tally when hide-missing is active).
    for (const id of removedIds) {
      this.index.delete(id);
    }
    for (let i = minRemovedIndex; i < this.fileList.length; i++) {
      this.index.set(this.fileList[i].id, i);
    }
    this.numMissingFiles = Math.max(0, this.numMissingFiles - removedMissing);
    if (this.showsAllContent) {
      this.numUntaggedFiles = Math.max(0, this.numUntaggedFiles - removedUntagged);
    } else if (this.showsUntaggedContent) {
      this.numUntaggedFiles = this.fileList.length;
    }

    // Decrement the DB-total counter by the number of entries that were actually
    // present in fileList (the caller may pass files that were already hidden as
    // broken; only count entries that were genuinely spliced out). The former
    // updateFileListState() call first reset numTotalFiles to the post-splice
    // list length, making this a double subtraction in the All view — the
    // incremental path subtracts exactly once.
    this.numTotalFiles = Math.max(0, this.numTotalFiles - actualRemovals);

    // Signal that the list has changed so downstream effects re-trigger
    // (Preview window fade-in, MasonryRenderer scroll restore, etc.).
    this.fileListLastModified = new Date();

    // Drop any selection entries that referenced the now-removed files.
    // `updateFileListState()` rebuilt `index`, so cleanFileSelection() can
    // use `index.has(file.id)` to determine what is still present.
    this.cleanFileSelection();

    // Reconcile uiStore.firstItem for SlideMode auto-advance.
    if (this.fileList.length === 0) {
      // List is now empty — leave firstItem at 0 (LayoutSwitcher gate will
      // unmount SlideMode via firstFileInView returning undefined), and
      // explicitly disable SlideMode so re-adding files later does not
      // auto-open the viewer.
      uiStore.firstItem = 0;
      if (uiStore.isSlideMode) {
        uiStore.disableSlideMode();
      }
    } else if (oldFirstItemId !== undefined && ids.has(oldFirstItemId)) {
      // The currently-viewed file was deleted. Scan the old list forward from
      // oldFirstItem + 1 for the first surviving file, then scan backward from
      // oldFirstItem - 1 if no forward survivor is found.
      let targetFile: ClientFile | undefined;

      // Forward scan (prefer the file that was directly "after" the deleted one).
      for (let i = oldFirstItem + 1; i < oldFileList.length; i++) {
        if (!ids.has(oldFileList[i].id)) {
          targetFile = oldFileList[i];
          break;
        }
      }

      // Backward scan fallback (deleted file was at the tail or all forward
      // neighbors were also deleted).
      if (targetFile === undefined) {
        for (let i = oldFirstItem - 1; i >= 0; i--) {
          if (!ids.has(oldFileList[i].id)) {
            targetFile = oldFileList[i];
            break;
          }
        }
      }

      if (targetFile !== undefined) {
        // Look up its new index in the rebuilt index map.
        const newIndex = this.index.get(targetFile.id);
        uiStore.firstItem = newIndex !== undefined ? newIndex : 0;
        // INV-033: While in SlideMode the viewed file must also be the selected
        // file, because the delete command is selection-driven. The auto-advance
        // just moved firstItem to targetFile; re-select it so the next Delete
        // targets the file now on screen rather than an empty selection.
        if (uiStore.isSlideMode) {
          uiStore.fileSelection.replace([targetFile]);
          // The slide-mode viewer resolves its file by identity (slideFileId), not by
          // firstItem. A deliberate delete is intentional retargeting, so re-anchor the
          // viewer to the advanced-to file; otherwise slideFileId still points at the
          // deleted file and slideFile resolves to undefined (blank "no file" state).
          // Distinct from incidental list churn (re-sort/ingest/filter), which must NOT
          // re-anchor. See openspec/specs/viewer-file-anchoring/spec.md.
          uiStore.slideFileId = targetFile.id;
        }
      } else {
        // No survivors found at all (shouldn't reach here because fileList.length
        // > 0 guards this branch, but be defensive).
        uiStore.firstItem = 0;
      }
    } else if (oldFirstItemId !== undefined) {
      // The currently-viewed file survived. Update firstItem to its NEW index
      // (the splice may have shifted it left).
      const newIndex = this.index.get(oldFirstItemId);
      if (newIndex !== undefined) {
        uiStore.firstItem = newIndex;
        // INV-033: Same selection-sync invariant for the "viewed file survived"
        // branch — the splice may have shifted its index, but it is still
        // on screen and must remain the sole selection.
        if (uiStore.isSlideMode) {
          uiStore.fileSelection.replace([this.fileList[newIndex]]);
        }
      }
    }
  }

  /** Removes a file from the internal state of this store and the DB. Does not remove from disk. */
  @action async deleteFiles(files: ClientFile[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    try {
      // Remove from backend.
      // Deleting non-existing keys should not throw an error!
      await this.backend.removeFiles(files.map((f) => f.id));

      // Dispose ClientFile instances and remove their thumbnails.
      // deselectFile is intentionally omitted here: removeFilesFromListInPlace
      // calls cleanFileSelection() which performs the same cleanup in bulk.
      for (const file of files) {
        file.dispose();
        this.removeThumbnail(file.absolutePath);
      }

      // Splice deleted entries out of fileList in place, update all derived
      // state (index, counts, fileListLastModified), clean the selection, and
      // reconcile uiStore.firstItem for SlideMode auto-advance. No refetch —
      // the in-memory fileList is the source of truth for the visible order.
      this.removeFilesFromListInPlace(files);
    } catch (err) {
      console.error('Could not remove files', err);
    }
  }

  @action async deleteFilesByExtension(ext: IMG_EXTENSIONS_TYPE): Promise<void> {
    try {
      const crit = new ClientStringSearchCriteria('extension', ext, 'equals');
      const files = await this.backend.searchFiles(crit.toCondition(), 'id', OrderDirection.Asc);
      console.log('Files to delete', ext, files);
      await this.backend.removeFiles(files.map((f) => f.id));

      for (const file of files) {
        this.removeThumbnail(file.absolutePath);
      }
    } catch (e) {
      console.error('Could not delete files bye extension', ext);
    }
  }

  @action.bound async refetch(): Promise<void> {
    const contentBefore = this.content;

    // Dispatch to the fetcher matching the current content mode. Untagged has a
    // no-op guard on its public method to debounce user re-clicks, so go through
    // _fetchUntaggedFilesForced() to bypass it. The other fetchers have no guard
    // and can be called directly. See INV-007.
    let result: Promise<void> | undefined;
    if (this.showsAllContent) {
      result = this.fetchAllFiles();
    } else if (this.showsUntaggedContent) {
      result = this._fetchUntaggedFilesForced();
    } else if (this.showsQueryContent) {
      result = this.fetchFilesByQuery();
    } else if (this.showsMissingContent) {
      result = this.fetchMissingFiles();
    } else if (this.showsDuplicatesContent) {
      result = this.fetchDuplicatesFiles();
    }

    if (result !== undefined && IS_DEV) {
      result.then(() => {
        if (this.content !== contentBefore) {
          console.warn(
            '[INV-007 regression] refetch() changed content mode from',
            contentBefore,
            'to',
            this.content,
            '— some async side-effect is clobbering the user-visible filter.',
          );
        }
        // NOTE: The INV-009 stale-fileList-clobber shape does NOT change content —
        // only fileList is replaced. That race is caught by logStaleDrop() inside
        // updateFromBackend/fetchMissingFiles, not by this assertion. See TASK-044.
      });
    }

    return result;
  }

  /**
   * Refetches the active view while keeping SlideMode anchored to `pinFile`
   * by **identity** (file id), closing the asymmetry where
   * `removeFilesFromListInPlace` reconciles `firstItem` but the fetch path
   * (`updateFromBackend`) does not.
   *
   * After `refetch()` resolves (and `updateFromBackend` has already committed
   * its own `transaction` that clears/replaces `fileList`), this method runs a
   * second synchronous `transaction` to re-anchor `uiStore.firstItem` to the
   * pin file's new index and call `selectFile(pinFile, true)`.  Because MobX
   * `transaction` is synchronous, React/MobX reactions fire only once — after
   * BOTH the list replacement and the firstItem update are committed.  There is
   * no window in which `firstItem` is in range but pointing at the wrong file,
   * nor any window in which `firstFileInView` returns `undefined` within a
   * transaction (the list replacement's transaction ends before ours starts,
   * but the async continuation runs before any React batch can process the
   * prior transaction's effects in the Electron/React scheduler).
   *
   * Returns `true` when the pin file is still in the refetched list (SlideMode
   * stays anchored to it).  Returns `false` when the pin file is absent from
   * the new list (e.g. a tagless output under a tag filter) — `firstItem` is
   * left at whatever value `updateFromBackend` last wrote, and the caller
   * (TASK-089) is responsible for inserting/pinning the file instead of leaving
   * the viewer stale.
   *
   * Default `refetch()` behaviour for all other callers is completely unchanged:
   * this is an additive wrapper, not a modification of `updateFromBackend`.
   *
   * Cross-store write: this method writes `uiStore.firstItem` (same pattern as
   * `cleanFileSelection` writing `uiStore.fileSelection` and
   * `removeFilesFromListInPlace` writing `uiStore.firstItem`).
   *
   * See INV-021, TASK-090.  Any refetch performed while `isSlideMode` is true
   * must go through this primitive — see docs/TOOLS.md "SlideMode + refetch".
   */
  async pinViewedFileAcrossRefetch(pinFile: ClientFile): Promise<boolean> {
    // Run the normal refetch.  updateFromBackend's internal transaction commits
    // the clear()/push() + cleanFileSelection() + updateFileListState().
    await this.refetch();

    // After the await, look up the pin file's new index in the rebuilt index map.
    // this.index is always in sync with fileList after updateFileListState() runs.
    const newIndex = this.index.get(pinFile.id);

    if (newIndex === undefined) {
      // The pin file is not in the refetched list.  Do NOT silently leave
      // firstItem pointing at a wrong file — the caller must handle this.
      return false;
    }

    // Re-anchor firstItem and selection in a single synchronous transaction
    // so MobX/React never observes firstItem updated without fileList, or
    // fileList updated without firstItem.
    transaction(() => {
      this.rootStore.uiStore.firstItem = newIndex;
      this.rootStore.uiStore.selectFile(pinFile, true);
    });

    return true;
  }

  @action.bound async fetchAllFiles(): Promise<void> {
    try {
      this.rootStore.uiStore._resetSearchCriteriaListNoFetch();
      // Flip content mode synchronously BEFORE the async backend call. Any
      // concurrent refetch() that fires during the await will then see
      // Content.All and re-enter fetchAllFiles() (idempotent) instead of
      // racing a different fetcher that would clobber the result. See INV-007.
      this.setContentAll();
      // Capture generation AFTER the content flip, BEFORE the await, so that any
      // fetcher dispatched later gets a strictly larger generation. See INV-009.
      const gen = this.nextFetchGeneration();
      if (this.canFetchProgressively()) {
        return this.runProgressiveFetch(
          () =>
            // Existence of fetchFileIds is what canFetchProgressively() checked.
            this.backend.fetchFileIds!(this.orderBy, this.orderDirection),
          gen,
        );
      }
      perf.startPhase('fetch');
      const fetchedFiles = await this.backend.fetchFiles(this.orderBy, this.orderDirection);
      perf.endPhase('fetch');
      if (this.startupCacheArmed) {
        this.cachedStartupDTOs = fetchedFiles;
        this.startupCacheArmed = false;
      }
      return this.updateFromBackend(fetchedFiles, gen);
    } catch (err) {
      console.error('Could not load all files', err);
    }
  }

  @action.bound async fetchUntaggedFiles(): Promise<void> {
    // No-op guard: if already in Untagged mode, skip the fetch to prevent gallery
    // flicker on repeated clicks of the Untagged selector. Background refetch() calls
    // go through _fetchUntaggedFilesForced() to bypass this guard. See INV-007.
    if (this.showsUntaggedContent) {
      return;
    }
    return this._fetchUntaggedFilesForced();
  }

  private async _fetchUntaggedFilesForced(): Promise<void> {
    try {
      const { uiStore } = this.rootStore;
      uiStore._resetSearchCriteriaListNoFetch();
      const criteria = new ClientTagSearchCriteria('tags');
      uiStore.searchCriteriaList.push(criteria);
      // Flip content mode synchronously BEFORE the async backend call. Any
      // concurrent refetch() that fires during the await will then see
      // Content.Untagged and re-enter _fetchUntaggedFilesForced() (idempotent)
      // instead of dispatching to fetchAllFiles() and racing it. See INV-007.
      this.setContentUntagged();
      // Capture generation AFTER the content flip, BEFORE the await. See INV-009.
      const gen = this.nextFetchGeneration();
      if (this.canFetchProgressively() && typeof this.backend.searchFileIds === 'function') {
        return this.runProgressiveFetch(
          () =>
            this.backend.searchFileIds!(
              criteria.toCondition(this.rootStore),
              this.orderBy,
              this.orderDirection,
              uiStore.searchMatchAny,
            ),
          gen,
        );
      }
      const fetchedFiles = await this.backend.searchFiles(
        criteria.toCondition(this.rootStore),
        this.orderBy,
        this.orderDirection,
        uiStore.searchMatchAny,
      );
      return this.updateFromBackend(fetchedFiles, gen);
    } catch (err) {
      console.error('Could not load untagged files', err);
    }
  }

  @action.bound async fetchMissingFiles(): Promise<void> {
    try {
      const {
        orderBy,
        orderDirection,
        rootStore: { uiStore },
      } = this;

      uiStore.searchCriteriaList.clear();
      this.setContentMissing();
      // Capture generation AFTER the content flip, BEFORE the await. See INV-009.
      const gen = this.nextFetchGeneration();

      // Fetch all files, then check their existence and only show the missing ones.
      // This full existence sweep is deliberate here — the Missing view IS the
      // existence audit (an explicit user action), unlike the regular load
      // path which derives existence from missingFileIds without disk I/O.
      const backendFiles = this.applyClientOrder(
        await this.backend.fetchFiles(orderBy, orderDirection),
      );

      // For every new file coming in, either re-use the existing client file if it exists,
      // or construct a new client file
      const [newClientFiles, reusedStatus] = this.filesFromBackend(backendFiles);

      // Dispose of unused files
      runInAction(() => {
        for (const oldFile of this.fileList) {
          if (!reusedStatus.has(oldFile.id)) {
            oldFile.dispose();
          }
        }
      });

      // The audit stats every file, then refreshes the missingFileIds source
      // of truth so subsequent regular loads inherit the verified state.
      perf.startPhase('existence');
      const existenceCheckPromises = newClientFiles.map((clientFile) => async () => {
        const exists = await platform.fs.pathExists(clientFile.absolutePath);
        clientFile.setBroken(!exists);
        if (exists) {
          this.missingFileIds.delete(clientFile.id);
        } else {
          this.missingFileIds.add(clientFile.id);
        }
      });

      const N = 50;
      await promiseAllLimit(existenceCheckPromises, N);
      perf.endPhase('existence');

      runInAction(() => {
        // Guard: if a newer fetcher has dispatched during the existence-check batch,
        // discard this result to prevent overwriting the user's current view. See INV-009.
        if (gen !== this.fetchGeneration) {
          this.logStaleDrop('missing-inline', gen);
          return;
        }

        // Capture a live anchor BEFORE replacing fileList, mirroring the sync first-pass of
        // updateFromBackend. The Missing view is a small filtered subset; without this,
        // firstItem stays at its old full-list index and the layout-restore effect scrolls to
        // an arbitrary/stale position when fileListLastModified is bumped. See INV-028, blast-radius #6.
        const { uiStore } = this.rootStore;
        const curFirst = uiStore.firstItem;
        const missingAnchorId =
          curFirst >= 0 && curFirst < this.fileList.length ? this.fileList[curFirst].id : undefined;

        const missingClientFiles = newClientFiles.filter((file) => file.isBroken);
        // Unified large-list mutation policy (see removeFilesFromListInPlace).
        this.fileList.clear();
        this.fileList.push(...missingClientFiles);
        this.numMissingFiles = missingClientFiles.length;
        this.index.clear();
        for (let index = 0; index < this.fileList.length; index++) {
          const file = this.fileList[index];
          this.index.set(file.id, index);
        }
        // Re-anchor firstItem by identity into the (much smaller) missing-files list.
        // reconcileFirstItemTo clamps into range when the anchor file is absent from the
        // Missing subset (the common case), which is correct: scroll to the nearest position
        // rather than leaving firstItem stale at an arbitrary old index.
        this.reconcileFirstItemTo(missingAnchorId);
        this.fileListLastModified = new Date();
      });

      // Only show the toast if we are still the current fetch (generation not stale).
      if (gen !== this.fetchGeneration) {
        return;
      }
      this.cleanFileSelection();

      AppToaster.show(
        {
          message:
            'Some files can no longer be found. Either move them back to their location, or delete them from OneFolder',
          timeout: 12000,
        },
        'recovery-view',
      );
    } catch (err) {
      console.error('Could not load broken files', err);
    }
  }

  @action.bound async fetchFilesByQuery(): Promise<void> {
    const { uiStore } = this.rootStore;

    if (uiStore.searchCriteriaList.length === 0) {
      return this.fetchAllFiles();
    }

    const criterias = uiStore.searchCriteriaList.map((c) => c.toCondition(this.rootStore));
    try {
      // Flip content mode synchronously BEFORE the async backend call so a
      // concurrent refetch() cannot observe a stale content mode and dispatch
      // to a different fetcher. See INV-007.
      this.setContentQuery();
      // Capture generation AFTER the content flip, BEFORE the await. See INV-009.
      const gen = this.nextFetchGeneration();
      if (this.canFetchProgressively() && typeof this.backend.searchFileIds === 'function') {
        return this.runProgressiveFetch(
          () =>
            this.backend.searchFileIds!(
              criterias as [ConditionDTO<FileDTO>, ...ConditionDTO<FileDTO>[]],
              this.orderBy,
              this.orderDirection,
              uiStore.searchMatchAny,
            ),
          gen,
        );
      }
      const fetchedFiles = await this.backend.searchFiles(
        criterias as [ConditionDTO<FileDTO>, ...ConditionDTO<FileDTO>[]],
        this.orderBy,
        this.orderDirection,
        uiStore.searchMatchAny,
      );
      return this.updateFromBackend(fetchedFiles, gen);
    } catch (e) {
      console.log('Could not find files based on criteria', e);
    }
  }

  @action.bound async fetchDuplicatesFiles(): Promise<void> {
    try {
      // For now, just fetch all files - the duplicate detection logic is in the component
      // In a future enhancement, we could move this logic to the backend for better performance
      // Flip content mode synchronously BEFORE the async backend call. See INV-007.
      this.setContentDuplicates();
      // Capture generation AFTER the content flip, BEFORE the await. See INV-009.
      const gen = this.nextFetchGeneration();
      const fetchedFiles = await this.backend.fetchFiles(this.orderBy, this.orderDirection);
      return this.updateFromBackend(fetchedFiles, gen);
    } catch (err) {
      console.error('Could not load files for duplicate detection', err);
    }
  }

  @action.bound incrementNumUntaggedFiles(): void {
    this.numUntaggedFiles++;
  }

  @action.bound decrementNumUntaggedFiles(): void {
    if (this.numUntaggedFiles === 0) {
      // The counter is only (re)written by updateFileListState() when showing all/untagged
      // content (see its comment), so in filtered views it can be stale — e.g. tagging a
      // freshly-ingested untagged file while a search/filter is active. A stale badge is
      // recoverable (next all-content refetch rewrites it); throwing here aborts the
      // caller's whole operation, so clamp instead.
      console.warn(
        'numUntaggedFiles would go below 0; leaving at 0 (stale counter in filtered view)',
      );
      return;
    }
    this.numUntaggedFiles--;
  }

  // Removes all items from fileList
  @action.bound clearFileList(): void {
    this.fileList.clear();
    this.index.clear();
  }

  @action.bound resetFileCounts(): void {
    this.numTotalFiles = 0;
    this.numUntaggedFiles = 0;
    this.numMissingFiles = 0;
  }

  @action get(id: ID): ClientFile | undefined {
    const fileIndex = this.index.get(id);
    return fileIndex !== undefined ? this.fileList[fileIndex] : undefined;
  }

  /**
   * Ensures `file` is present in `fileList` and returns its index, injecting it at `preferredIndex`
   * (default: end of list) and patching `index` if it is currently absent. Used by MediaQueueStore
   * when focusing the viewer on a completed job's output: the output may be excluded by the active
   * filter, so this guarantees it is locatable. In the common case the file is already present and
   * its existing index is returned unchanged (no mutation). The transient "file in list but outside
   * the active query" state is reconciled by the next user-driven refetch (mirrors how
   * removeFilesFromListInPlace tolerates in-place edits).
   */
  @action.bound ensureFileInListAt(file: ClientFile, preferredIndex?: number): number {
    const existing = this.index.get(file.id);
    if (existing !== undefined) {
      return existing;
    }
    const idx = Math.min(preferredIndex ?? this.fileList.length, this.fileList.length);
    this.fileList.splice(idx, 0, file);
    for (let i = idx; i < this.fileList.length; i++) {
      this.index.set(this.fileList[i].id, i);
    }
    return idx;
  }

  getIndex(id: ID): number | undefined {
    return this.index.get(id);
  }

  getTags(ids: ID[]): Set<ClientTag> {
    const tags = new Set<ClientTag>();
    for (const id of ids) {
      const tag = this.rootStore.tagStore.get(id);
      if (tag !== undefined) {
        tags.add(tag);
      }
    }
    return tags;
  }

  getLocation(location: ID): ClientLocation {
    const loc = this.rootStore.locationStore.get(location);
    if (!loc) {
      throw new Error(
        `Location of file was not found! This should never happen! Location ${location}`,
      );
    }
    return loc;
  }

  save(file: FileDTO): void {
    file.dateModified = new Date();

    // Save files in bulk so saving many files at once is faster.
    // Each file will call this save() method individually after detecting a change on its observable fields,
    // these can be batched by collecting the changes and debouncing the save operation
    this.filesToSave.set(file.id, file);
    this.debouncedSaveFilesToSave();
  }

  private async saveFilesToSave() {
    await this.backend.saveFiles(Array.from(this.filesToSave.values()));
    this.filesToSave.clear();
  }

  // -------------------------------------------------------------------------
  // Centralized auto-save (replaces the per-ClientFile serialize() reaction)
  // -------------------------------------------------------------------------

  /** Called by ClientFile mutation methods; schedules the debounced flush. */
  markFileDirty(file: ClientFile): void {
    this.dirtyFiles.add(file);
    this.debouncedFlushDirtyFiles();
  }

  /**
   * Serializes and saves every dirty file (skipping files whose auto-save is
   * disabled — broken or disposed), then clears the dirty set. Runs debounced
   * (500 ms) after edits, and synchronously on beforeunload so pending edits
   * are never lost on quit.
   */
  flushDirtyFiles(): void {
    if (this.dirtyFiles.size === 0) {
      return;
    }
    for (const file of this.dirtyFiles) {
      if (file.isAutoSaveEnabled) {
        this.save(file.serialize());
      }
    }
    this.dirtyFiles.clear();
  }

  // -------------------------------------------------------------------------
  // File-existence state (replaces the per-load pathExists sweep)
  // -------------------------------------------------------------------------

  /**
   * Wholesale reconciliation from watchLocations' full disk-vs-DB pass: the
   * given set becomes the new missing-file truth. Materialized files flip
   * their isBroken flag accordingly, and derived counters refresh once.
   */
  @action reconcileMissingFiles(missingIds: ReadonlySet<ID>): void {
    for (const id of this.missingFileIds) {
      if (!missingIds.has(id)) {
        const file = this.get(id);
        if (file !== undefined && file.isBroken === true) {
          file.setBroken(false);
        }
      }
    }
    this.missingFileIds.clear();
    for (const id of missingIds) {
      this.missingFileIds.add(id);
      const file = this.get(id);
      if (file !== undefined && file.isBroken !== true) {
        file.setBroken(true);
      }
    }
    // One full derived-state pass at reconciliation end (not per file).
    this.updateFileListState();
    this.fileListLastModified = new Date();
  }

  /**
   * On-demand existence fallback: called when an image/thumbnail fails to
   * load. Stats just that one file and updates its missing state — the load
   * path itself never sweeps the disk (see missingFileIds).
   */
  async verifyFileExistence(file: ClientFile): Promise<void> {
    perf.startPhase('existence');
    const exists = await platform.fs.pathExists(file.absolutePath);
    perf.endPhase('existence');
    runInAction(() => {
      if (!exists) {
        if (!this.missingFileIds.has(file.id)) {
          this.missingFileIds.add(file.id);
          if (file.isBroken !== true) {
            file.setBroken(true);
            this.incrementNumMissingFiles();
          }
        }
      } else {
        this.missingFileIds.delete(file.id);
        if (file.isBroken === true) {
          file.setBroken(false);
        }
      }
    });
  }

  /**
   * Hands the raw startup fetch DTOs to watchLocations (once) so startup
   * reconciliation does not re-fetch the entire library. Returns undefined if
   * the cache was never armed/filled (e.g. session started on a search view).
   */
  consumeStartupFetchDTOs(): FileDTO[] | undefined {
    const dtos = this.cachedStartupDTOs;
    this.cachedStartupDTOs = undefined;
    return dtos;
  }

  // -------------------------------------------------------------------------
  // Client-side seeded ordering (replaces SQL ORDER BY RANDOM())
  // -------------------------------------------------------------------------

  /** Applies the session-stable seeded ordering for the random sort modes. */
  private applyClientOrder(files: FileDTO[]): FileDTO[] {
    if (this.orderBy === 'random') {
      return orderBySeededRank(files, this.randomSeed);
    }
    if (this.orderBy === 'tagCountRandom') {
      return orderByTagCountSeeded(files, this.randomSeed);
    }
    return files;
  }

  /**
   * Entry point for the preview-window's direct file apply.
   * The preview window does not go through any of the five named fetchers, so it
   * calls this wrapper which handles the generation increment for it.
   * See INV-009 and renderer.tsx for usage.
   */
  @action async applyPreviewFiles(files: FileDTO[]): Promise<void> {
    const gen = this.nextFetchGeneration();
    return this.updateFromBackend(files, gen);
  }

  /**
   * Increments the fetch generation and returns the new value.
   * Must be called synchronously at dispatch, AFTER the setContentX() flip
   * and BEFORE any await. This ensures that a concurrent fetcher dispatched
   * later always gets a strictly larger generation number. See INV-009.
   */
  private nextFetchGeneration(): number {
    this.fetchGeneration += 1;
    return this.fetchGeneration;
  }

  /**
   * Records a stale-apply drop and emits a structured dev-build log line.
   * The counter always increments so automated tests can assert on it.
   * The console.debug is dev-only to avoid noise in production builds.
   *
   * @param phase - Which guard site fired: 'sync' (updateFromBackend first pass),
   *   'async' (updateFromBackend existence-check .then()), or
   *   'missing-inline' (fetchMissingFiles inline runInAction).
   * @param dropped - The captured generation value that was found stale.
   */
  @action private logStaleDrop(phase: 'sync' | 'async' | 'missing-inline', dropped: number): void {
    // Counter always increments so unit tests can assert on it regardless of IS_DEV.
    this.droppedApplyCount += 1;
    if (IS_DEV) {
      console.debug('[INV-009] dropped stale apply', {
        phase,
        dropped,
        current: this.fetchGeneration,
        content: this.content,
        droppedTotal: this.droppedApplyCount,
      });
    }
  }

  @action recoverPersistentPreferences(): void {
    const key = getFileStorageKey(this.storageKeyPrefix || undefined);
    const prefsString = localStorage.getItem(key);
    if (prefsString) {
      try {
        const prefs = JSON.parse(prefsString);
        // BACKWARDS_COMPATIBILITY: orderDirection used to be called fileOrder
        this.setOrderDirection(prefs.orderDirection ?? prefs.fileOrder);
        this.setOrderBy(prefs.orderBy);
      } catch (e) {
        console.error('Cannot parse persistent preferences:', key, e);
      }
    }
  }

  /**
   * Waits for a file with the given absolute path to appear in fileList, i.e. to be ingested
   * by the chokidar folder watcher. Resolves with the ClientFile once it appears, or rejects
   * after timeoutMs milliseconds.
   *
   * Intended for use after a file-system operation that produces a new sibling file in a watched
   * folder (e.g. a re-encode). The caller should await this before accessing the ClientFile.
   *
   * The 200 ms debouncedRefetch delay is accounted for: the reaction polls the live observable
   * fileList and fires as soon as the new file is present.
   *
   * @param absolutePath  Full absolute path of the file to wait for.
   * @param timeoutMs     Upper bound on the wait. Default 10 000 ms.
   */
  waitForIngestedFile(absolutePath: string, timeoutMs = 10000): Promise<ClientFile> {
    // Separator-insensitive comparison: paths computed in the main process use win32
    // backslashes, while ingested ClientFile.absolutePath uses forward slashes (the folder
    // watcher normalizes its watch root for chokidar). Windows paths are case-insensitive,
    // so compare lowercased as well.
    const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const target = normalize(absolutePath);
    const matches = (f: ClientFile) => normalize(f.absolutePath) === target;

    return new Promise<ClientFile>((resolve, reject) => {
      // Check immediately in case the file is already in the list (e.g. extremely fast ingest).
      const existing = this.fileList.find(matches);
      if (existing) {
        resolve(existing);
        return;
      }

      // Set up a bounded MobX reaction that watches fileList for the target path.
      // The reaction is disposed on both success and timeout to avoid a leak.
      const disposer = reaction(
        () => this.fileList.find(matches),
        (file, _prev, r) => {
          if (file) {
            r.dispose();
            clearTimeout(timer);
            resolve(file);
          }
        },
      );

      const timer = setTimeout(() => {
        disposer();
        reject(
          new Error(
            `waitForIngestedFile: "${absolutePath}" was not detected in the current view within ` +
              `${timeoutMs} ms. It may not match the active filter, or it may be outside a watched location.`,
          ),
        );
      }, timeoutMs);
    });
  }

  /**
   * Copies all tags from the source ClientFile onto the target ClientFile.
   *
   * Two things happen in a single write:
   * 1. `target.disableImmediateSync()` is called so that the loop of addTag() calls does not
   *    trigger one ExifTool write per tag.
   * 2. After all tags are added, the reenable function is called, which schedules exactly one
   *    ExifTool writeTags() for the final tag set.
   *
   * This is the recommended single writer for the re-encode flow: metadata is written here in
   * the renderer after ffmpeg has finished and released the file handle, via the addTag + reenable
   * path. Do NOT also write tags in main-process code for the same file — that would double-write.
   *
   * @param source  The ClientFile whose tags should be copied.
   * @param target  The freshly-ingested ClientFile to copy tags onto.
   */
  async copyTagsToFile(source: ClientFile, target: ClientFile): Promise<void> {
    const hierarchy = Array.from(source.tags, (t) => t.path);

    // Nothing to copy — skip the write entirely (ExifIO.writeTags with empty array is a valid
    // "clear tags" call, but we have nothing to clear on a brand-new file).
    if (hierarchy.length === 0) {
      return;
    }

    // Disable immediate metadata sync so we batch all addTag() calls into one write.
    const reenable = target.disableImmediateSync();

    for (const tag of source.tags) {
      target.addTag(tag);
    }

    // Re-enable sync and flush: writes the full tag set to the target file's EXIF/XMP exactly once.
    await reenable();
  }

  /**
   * Write the source's tags (EXIF/XMP) to the temp file while it is still in the
   * staging directory (outside any watched location, before the atomic rename).
   *
   * Called by the corrected post-encode flow (INV-026) immediately after ffmpeg
   * finishes, before `commitMediaJob` moves the file into the watched folder.
   * Because the file is in the temp dir and not yet watched, there is no race with
   * the folder watcher — tagging is deterministic and cannot race ingestion.
   *
   * Skips the write entirely for zero-tag sources (writing an empty hierarchy would
   * clear metadata on a brand-new file and there is nothing to copy anyway).
   *
   * @param source   The ClientFile whose tags should be written.
   * @param tempPath Absolute path of the staged temp file (not yet in the watched dir).
   */
  async tagTempFile(source: ClientFile, tempPath: string): Promise<void> {
    const hierarchy = Array.from(source.tags, (t) => t.path);
    if (hierarchy.length === 0) {
      return; // Nothing to write — skip for zero-tag sources.
    }
    await this.rootStore.exifTool.writeTags(tempPath, hierarchy);
  }

  /**
   * Resolve a freshly-ingested output DTO to a ClientFile in the active view.
   *
   * Prefers the instance the grid already holds after refetch; if the active filter excludes it,
   * builds one from the DTO and injects it at the source's position so the grid stays visually
   * stable. Never routes through content-mode setters (which would disable SlideMode —
   * docs/TOOLS.md rule 6).
   *
   * The `fileList` injection / index rebuild is **unconditional** — the output always lands in the
   * active view at the source's position regardless of `focusViewer`.
   *
   * @param opts.focusViewer  When `true`, also sets `uiStore.firstItem` and calls
   *   `uiStore.selectFile` so the viewer anchors to the output. When `false` (the default used by
   *   `MediaQueueStore`), the viewer and selection are NOT touched — the output is silently present
   *   in `fileList` until the user explicitly opens it.
   */
  @action private resolveOutputClientFile(
    source: ClientFile,
    dto: FileDTO,
    opts: { focusViewer: boolean },
  ): ClientFile {
    const { uiStore } = this.rootStore;

    const existingIdx = this.index.get(dto.id);
    if (existingIdx !== undefined) {
      const outputFile = this.fileList[existingIdx];
      transaction(() => {
        if (opts.focusViewer) {
          uiStore.firstItem = existingIdx;
          uiStore.selectFile(outputFile, true);
        }
      });
      console.info('[media-job] finalize resolved (in list)', {
        id: outputFile.id,
        index: existingIdx,
      });
      return outputFile;
    }

    const outputFile = new ClientFile(this, dto, this.rootStore.exifTool);
    // In the web build there is no local thumbnail directory — use the file ID as the
    // thumbnail path so encodeFilePath routes it to /api/thumb/:id. On desktop, gate on
    // isWebBuild (NOT an empty thumbnailDirectory): thumbnailDirectory is set asynchronously
    // via IPC and is transiently '' at startup, and using dto.id then would blank every
    // thumbnail — including videos, which (needsThumbnail === false) must resolve to their
    // own absolutePath so the <video> element can render them.
    outputFile.thumbnailPath = platform.isWebBuild
      ? dto.id
      : this.rootStore.imageLoader.needsThumbnail(dto)
      ? getThumbnailPath(dto.absolutePath, uiStore.thumbnailDirectory)
      : dto.absolutePath;

    const sourceIdx = this.index.get(source.id) ?? this.fileList.length;
    const injectionIdx = Math.min(sourceIdx, this.fileList.length);
    transaction(() => {
      this.fileList.splice(injectionIdx, 0, outputFile);
      for (let i = injectionIdx; i < this.fileList.length; i++) {
        this.index.set(this.fileList[i].id, i);
      }
      if (opts.focusViewer) {
        uiStore.firstItem = injectionIdx;
        uiStore.selectFile(outputFile, true);
      }
    });
    console.info('[media-job] finalize resolved (injected)', {
      id: outputFile.id,
      index: injectionIdx,
    });
    return outputFile;
  }

  /**
   * Reusable post-media-job finalization, shared by Re-encode, Normalize Audio, Create Clip, and
   * `MediaQueueStore`.
   *
   * Flow (every step awaited; every failure throws LOUD — there are no silent fallbacks):
   *   A. Tag the staged temp file (EXIF/XMP) once via `tagTempFile`. Zero-tag sources skip it.
   *   B. SUPPRESS the folder watcher for `finalPath` so the renderer is the SOLE ingester (this is
   *      what eliminates the dual-write race between the watcher and our deterministic ingest), then
   *      ask main to place temp → final (`commitMediaJob`).
   *   C. Deterministically ingest the placed file via `locationStore.ingestFile` and set its tags.
   *   D. `refetch()` and resolve the output ClientFile, injecting it into `fileList` at the
   *      source's position. When `focusViewer` is `true`, also anchors the viewer to the output.
   *   E. Unsuppress (in `finally`) — by now our row exists, so any late watcher `add()` dedups.
   *
   * Does NOT toggle the media-processing lock/pin or open the delete prompt — those are the
   * caller's concern. Returns the output ClientFile, or THROWS (surfaced by the caller).
   *
   * @param source           The source ClientFile whose tags should be copied.
   * @param paths            The `{ jobId, tempPath, finalPath }` result from `startMediaJob`.
   * @param opts.focusViewer When `true`, sets `uiStore.firstItem` and calls `uiStore.selectFile`
   *   so the viewer anchors to the output (preserves the legacy in-viewer behaviour for
   *   `ImageTools.tsx`). When `false` (the default), the output is committed and injected into
   *   `fileList` but the viewer and selection are NOT touched — required by `MediaQueueStore` so
   *   jobs run without interrupting the user's current view.
   * @returns The output ClientFile (tags copied, present in or injected into `fileList`).
   * @throws  If the EXIF write, placement, or ingest fails.
   */
  @action.bound async finalizeEncodedOutput(
    source: ClientFile,
    paths: { jobId: string; tempPath: string; finalPath: string },
    opts: { focusViewer?: boolean } = {},
  ): Promise<ClientFile> {
    const focusViewer = opts.focusViewer ?? false;
    const { locationStore } = this.rootStore;
    const { jobId, tempPath, finalPath } = paths;
    console.info('[media-job] finalize start', { jobId, tempPath, finalPath });

    // A. Tag the temp file (EXIF/XMP) once. Throws loud on failure (caller shows a modal).
    //    Note: tagTempFile is called BEFORE suppressIngest, so a tag failure here exits
    //    without having suppressed anything — the finally's unsuppressIngest is a no-op
    //    against a path that was never suppressed (LocationStore.unsuppressIngest is
    //    idempotent). No suppression leak on tag failure.
    await this.tagTempFile(source, tempPath);
    console.info('[media-job] tagged temp file', { tempPath, tags: source.tags.size });

    // Suppress the watcher for finalPath across the whole place+ingest window so it never creates a
    // competing (untagged) row for the same file. Released in finally once our row exists.
    //
    // Containment note (INV-038 / TASK-155): if commitMediaJob or ingestFile hangs, the
    // renderer settle guard (TASK-154) still advances the queue for other items; and the
    // main-process FfmpegRunner inactivity backstop (TASK-155) prevents the encode from
    // hanging before we even reach this point. A per-step timeout on exiftool/move is
    // deferred to a future hardening pass (noted in INV-038 latent defects).
    locationStore.suppressIngest(finalPath);
    try {
      // B. Place temp → final (single move on the main side).
      let outputPath: string;
      try {
        const result = await platform.desktop.commitMediaJob(jobId);
        outputPath = result.outputPath;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to move the encoded file into place: ${reason}`);
      }
      console.info('[media-job] placed output', { jobId, outputPath });

      // C. Deterministically ingest the placed file and set tags — the SOLE ingestion path.
      const dto = await locationStore.ingestFile(
        outputPath,
        source.locationId,
        Array.from(source.tags, (t) => t.id),
      );
      console.info('[media-job] ingested output row', { id: dto.id, tags: dto.tags.length });

      // D. Bring the output into the active view and resolve its ClientFile.
      await this.refetch();
      return this.resolveOutputClientFile(source, dto, { focusViewer });
    } finally {
      // E. Release suppression — the row now exists, so a late watcher add() dedups harmlessly.
      locationStore.unsuppressIngest(finalPath);
    }
  }

  getPersistentPreferences(): Partial<Record<keyof FileStore, unknown>> {
    const preferences: Record<PersistentPreferenceFields, unknown> = {
      orderBy: this.orderBy,
      orderDirection: this.orderDirection,
    };
    return preferences;
  }

  clearPersistentPreferences(): void {
    localStorage.removeItem(getFileStorageKey(this.storageKeyPrefix || undefined));
  }

  @action private async removeThumbnail(path: string) {
    const thumbnailPath = getThumbnailPath(path, this.rootStore.uiStore.thumbnailDirectory);
    try {
      if (await platform.fs.pathExists(thumbnailPath)) {
        return platform.fs.remove(thumbnailPath);
      }
    } catch (error) {
      // TODO: Show a notification that not all thumbnails could be removed?
      console.error(error);
    }
  }

  @action async updateFromBackend(backendFiles: FileDTO[], generation: number): Promise<void> {
    // Guard (sync first-pass): if a newer fetcher has already dispatched, the
    // results we are about to apply are stale. Discard everything — no fileList
    // mutation, no count update, no selection mutation, no toast. See INV-009.
    if (generation !== this.fetchGeneration) {
      this.logStaleDrop('sync', generation);
      return;
    }

    if (backendFiles.length === 0) {
      this.rootStore.uiStore.clearFileSelection();
      this.fileListLastModified = new Date();
      return this.clearFileList();
    }

    // Session-stable seeded ordering for the random sort modes (the backend
    // returns deterministic id order; the shuffle is client-side, see
    // seededShuffle.ts).
    backendFiles = this.applyClientOrder(backendFiles);

    // Filter out images with hidden tags
    // TODO: could also do it in search query, this is simpler though (maybe also more performant)
    const hiddenTagIds = new Set(
      this.rootStore.tagStore.tagList.filter((t) => t.isHidden).map((t) => t.id),
    );
    backendFiles = backendFiles.filter((f) => !f.tags.some((t) => hiddenTagIds.has(t)));

    // Upstream media-type gate: trim the raw FileDTO[] to the active media-type filter BEFORE
    // any ClientFile is constructed, so excluded files never materialize, render, or trigger a
    // thumbnail (this replaces the old post-fetch splice, which flashed images in and out). Not
    // applied in the Missing-files view, which is always unfiltered — though that view uses a
    // separate inline path (fetchMissingFiles) and never reaches updateFromBackend, so the guard
    // is defensive parity with the former splice. Capture the post-hidden-tags count first so the
    // All-view "total" badge keeps reporting the pre-gate size (see numTotalFiles override below).
    const preGateFetchedCount = backendFiles.length;
    const mediaFilter = this.rootStore.uiStore.mediaTypeFilter;
    // Fail-safe: only the two real filtering values activate the gate. Any other value
    // ('all', or an unexpected/undefined value) shows all media rather than hiding
    // everything, so a bad preference can never blank the gallery.
    const mediaFilterActive =
      (mediaFilter === 'images' || mediaFilter === 'video') && !this.showsMissingContent;
    if (mediaFilterActive) {
      backendFiles = backendFiles.filter((f) => mediaTypeMatches(mediaFilter, f.extension));
    }

    // For every new file coming in, either re-use the existing client file if it exists,
    // or construct a new client file
    perf.startPhase('materialize');
    const [newClientFiles, reusedStatus] = this.filesFromBackend(backendFiles);

    // Dispose of Client files that are not re-used.
    // Capture the file the viewer is currently anchored to (firstItem) BEFORE fileList is replaced,
    // so we can re-point firstItem to it by IDENTITY after the rebuild. Without this, ANY refetch
    // leaves firstItem at a now-stale index so SlideMode jumps to an unrelated file. The delete path
    // (removeFilesFromListInPlace) already reconciles firstItem this way; the fetch path did not.
    const anchorFirstItem = this.rootStore.uiStore.firstItem;
    const anchorFileId =
      anchorFirstItem >= 0 && anchorFirstItem < this.fileList.length
        ? this.fileList[anchorFirstItem].id
        : undefined;

    for (const file of this.fileList) {
      if (!reusedStatus.has(file.id)) {
        file.dispose();
      }
    }

    // Existence derives from missingFileIds (watcher reconciliation + unlink
    // events + on-demand load-failure checks) — the former per-load
    // one-pathExists-per-file sweep is gone, which also removes the async
    // second-pass window it required (INV-028's splice race and INV-009's
    // 'async' drop phase for this path with it). Everything commits in ONE
    // synchronous transaction now.
    // Use transaction to batch all file list updates into a single reaction
    // This prevents MobX reaction storm when updating large file lists (57k+ files)
    transaction(() => {
      // Count broken files BEFORE the hide filter so the Outliner badge stays
      // accurate regardless of whether they are kept out of fileList.
      let brokenCount = 0;
      for (const clientFile of newClientFiles) {
        clientFile.setBroken(this.missingFileIds.has(clientFile.id));
        if (clientFile.isBroken === true) {
          brokenCount++;
        }
      }

      const shouldHide =
        this.rootStore.uiStore.hideMissingFilesInBrowsing && !this.showsMissingContent;
      const visibleFiles =
        shouldHide && brokenCount > 0
          ? newClientFiles.filter((f) => f.isBroken !== true)
          : newClientFiles;

      // Unified large-list mutation policy: clear() + push(...) — see the
      // fileList.replace() policy note on removeFilesFromListInPlace.
      this.fileList.clear();
      this.fileList.push(...visibleFiles);

      this.cleanFileSelection();
      this.updateFileListState(); // update index & untagged image counter
      // Re-anchor firstItem to the viewed file by identity so a refetch never jumps the viewer.
      this.reconcileFirstItemTo(anchorFileId);
      this.fileListLastModified = new Date();

      // updateFileListState derives numMissingFiles from fileList; when broken
      // files are hidden the count would be 0. Override with the pre-filter
      // tally so the Outliner warning badge remains accurate.
      this.numMissingFiles = brokenCount;

      // updateFileListState also sets numTotalFiles = fileList.length when showing
      // All content. After the broken-file hide or the upstream media-type gate,
      // fileList is smaller than the DB total, so the Outliner "All Images" badge would
      // show the visible count rather than the true library size. Override with the
      // pre-gate fetched count (post-hidden-tags, pre-media-filter) so the badge stays
      // accurate even when files are hidden by either display filter.
      if (this.showsAllContent && ((shouldHide && brokenCount > 0) || mediaFilterActive)) {
        this.numTotalFiles = preGateFetchedCount;
      }
    });
    perf.endPhase('materialize');
  }

  /**
   * Progressive view load (desktop backends implementing the id-projection
   * methods): fetches the cheap ordered id list first, then materializes full
   * rows in bounded batches that yield to the event loop between chunks — the
   * gallery is interactive after the first batch and no single UI-thread task
   * scales with library size. Backends without fetchFileIds (HttpBackend/web
   * sidecar, test mocks) use the one-shot updateFromBackend path unchanged.
   *
   * tagCountRandom is routed to the one-shot path (its ordering needs tag
   * counts, which the id projection does not carry).
   */
  private canFetchProgressively(): boolean {
    return typeof this.backend.fetchFileIds === 'function' && this.orderBy !== 'tagCountRandom';
  }

  private static readonly PROGRESSIVE_CHUNK_SIZE = 800;

  @action private async runProgressiveFetch(
    fetchIds: () => Promise<ID[]>,
    generation: number,
  ): Promise<void> {
    perf.startPhase('fetch');
    let ids = await fetchIds();
    perf.endPhase('fetch');
    if (generation !== this.fetchGeneration) {
      this.logStaleDrop('sync', generation);
      return;
    }
    if (this.orderBy === 'random') {
      ids = orderIdsBySeededRank(ids, this.randomSeed);
    }
    if (ids.length === 0) {
      runInAction(() => {
        this.rootStore.uiStore.clearFileSelection();
        this.fileListLastModified = new Date();
        this.clearFileList();
      });
      return;
    }

    // Anchor the viewer by identity across the rebuild (same as updateFromBackend).
    const anchorFirstItem = this.rootStore.uiStore.firstItem;
    const anchorFileId =
      anchorFirstItem >= 0 && anchorFirstItem < this.fileList.length
        ? this.fileList[anchorFirstItem].id
        : undefined;

    // Snapshot the old list for instance reuse (pooling) and later disposal —
    // the observable list itself is cleared when the first batch commits.
    const oldById = new Map<ID, ClientFile>(this.fileList.map((f) => [f.id, f]));
    const reusedIds = new Set<ID>();

    const hiddenTagIds = new Set(
      this.rootStore.tagStore.tagList.filter((t) => t.isHidden).map((t) => t.id),
    );
    const mediaFilter = this.rootStore.uiStore.mediaTypeFilter;
    const mediaFilterActive =
      (mediaFilter === 'images' || mediaFilter === 'video') && !this.showsMissingContent;
    const shouldHide =
      this.rootStore.uiStore.hideMissingFilesInBrowsing && !this.showsMissingContent;

    const startupCache: FileDTO[] | null = this.startupCacheArmed ? [] : null;
    let preGateFetchedCount = 0;
    let brokenCount = 0;
    let committedFirstBatch = false;

    for (let offset = 0; offset < ids.length; offset += FileStore.PROGRESSIVE_CHUNK_SIZE) {
      const chunkIds = ids.slice(offset, offset + FileStore.PROGRESSIVE_CHUNK_SIZE);
      perf.startPhase('fetch');
      const rows = await this.backend.fetchFilesByID(chunkIds);
      perf.endPhase('fetch');
      if (generation !== this.fetchGeneration) {
        this.logStaleDrop('async', generation);
        return;
      }

      // IN-clause results are unordered; restore the requested order.
      const rowById = new Map(rows.map((r) => [r.id, r]));
      const orderedRows: FileDTO[] = [];
      for (const id of chunkIds) {
        const row = rowById.get(id);
        if (row !== undefined) {
          orderedRows.push(row);
        }
      }
      startupCache?.push(...orderedRows);

      let dtos = orderedRows.filter((f) => !f.tags.some((t) => hiddenTagIds.has(t)));
      preGateFetchedCount += dtos.length;
      if (mediaFilterActive) {
        dtos = dtos.filter((f) => mediaTypeMatches(mediaFilter, f.extension));
      }

      perf.startPhase('materialize');
      const [chunkClientFiles, chunkReused] = this.filesFromBackend(dtos, (id) => oldById.get(id));
      for (const id of chunkReused) {
        reusedIds.add(id);
      }
      transaction(() => {
        if (!committedFirstBatch) {
          this.fileList.clear();
          this.index.clear();
          committedFirstBatch = true;
        }
        for (const clientFile of chunkClientFiles) {
          clientFile.setBroken(this.missingFileIds.has(clientFile.id));
          if (clientFile.isBroken === true) {
            brokenCount++;
            if (shouldHide) {
              continue;
            }
          }
          this.index.set(clientFile.id, this.fileList.length);
          this.fileList.push(clientFile);
        }
        // Bump per batch so the (debounced) layout picks up the growing list.
        this.fileListLastModified = new Date();
      });
      perf.endPhase('materialize');

      await yieldToEventLoop();
      if (generation !== this.fetchGeneration) {
        this.logStaleDrop('async', generation);
        return;
      }
    }

    // Completion: dispose replaced instances, run the derived-state passes ONCE.
    for (const [id, oldFile] of oldById) {
      if (!reusedIds.has(id)) {
        oldFile.dispose();
      }
    }
    transaction(() => {
      this.updateFileListState();
      this.cleanFileSelection();
      this.reconcileFirstItemTo(anchorFileId);
      this.numMissingFiles = brokenCount;
      if (this.showsAllContent && ((shouldHide && brokenCount > 0) || mediaFilterActive)) {
        this.numTotalFiles = preGateFetchedCount;
      }
      this.fileListLastModified = new Date();
    });
    if (startupCache !== null) {
      this.cachedStartupDTOs = startupCache;
      this.startupCacheArmed = false;
    }
  }

  /** Remove files from selection that are not in the file list anymore */
  @action private cleanFileSelection() {
    const { fileSelection } = this.rootStore.uiStore;
    for (const file of fileSelection) {
      if (!this.index.has(file.id)) {
        fileSelection.delete(file);
      }
    }
  }

  /**
   * Re-point `uiStore.firstItem` at the file identified by `anchorId` (its new index in the freshly
   * rebuilt `index`), so a `fileList` replacement never leaves the SlideMode viewer anchored to a
   * stale index pointing at an unrelated file. Call AFTER `updateFileListState()` has rebuilt `index`.
   *
   * If the anchor file is gone from the new list (or there was no anchor), firstItem is only clamped
   * back into range — never silently left pointing past the end (which would blank the viewer). This
   * mirrors the firstItem reconciliation `removeFilesFromListInPlace` performs for the delete path.
   * Cross-store write to `uiStore.firstItem` (same pattern as `cleanFileSelection`).
   *
   * NOTE: As of the viewer-file-anchoring change, the slide-mode viewer resolves its displayed file
   * by identity (`uiStore.slideFileId`), NOT by `firstItem`. This getter now only maintains the grid
   * viewport index — the clamp fallback below can therefore no longer swap the viewer to an unrelated
   * file (when the anchored file is gone, `slideFile` resolves to `undefined` and the viewer shows an
   * explicit empty state). Reconcile logic is intentionally left unchanged.
   */
  @action private reconcileFirstItemTo(anchorId: ID | undefined): void {
    const { uiStore } = this.rootStore;
    if (anchorId !== undefined) {
      const newIndex = this.index.get(anchorId);
      if (newIndex !== undefined) {
        uiStore.firstItem = newIndex;
        return;
      }
    }
    // Anchor file is absent from the new list (or none was captured): clamp into range so firstItem
    // never points past the end. Do not otherwise move it.
    if (this.fileList.length === 0) {
      uiStore.firstItem = 0;
    } else if (uiStore.firstItem > this.fileList.length - 1) {
      uiStore.firstItem = this.fileList.length - 1;
    }
  }

  /**
   * @param backendFiles
   * @param reuseFrom Optional instance lookup overriding the default
   *   fileList/index lookup — the progressive fetch path passes a snapshot of
   *   the pre-fetch list here, since the live list is cleared when the first
   *   batch commits (instance pooling across refetches).
   * @returns A list of Client files, and a set of keys that was reused from the existing fileList
   */
  @action private filesFromBackend(
    backendFiles: FileDTO[],
    reuseFrom?: (id: ID) => ClientFile | undefined,
  ): [ClientFile[], Set<ID>] {
    const reusedStatus = new Set<ID>();
    const lookup = reuseFrom ?? ((id: ID) => this.get(id));

    const clientFiles = backendFiles.map((f) => {
      // Might already exist!
      const existingFile = lookup(f.id);
      if (existingFile !== undefined) {
        reusedStatus.add(existingFile.id);
        // Update tags (might have changes, e.g. removed/merged)
        const newTags = f.tags
          .map((t) => this.rootStore.tagStore.get(t))
          .filter((t) => t !== undefined) as ClientTag[];
        if (
          existingFile.tags.size !== newTags.length ||
          Array.from(existingFile.tags).some((t, i) => t.id !== newTags[i].id)
        ) {
          existingFile.updateTagsFromBackend(newTags);
        }
        return existingFile;
      }

      // Otherwise, create new one.
      // TODO: Maybe better performance by always keeping the same pool of client files,
      // and just replacing their properties instead of creating new objects
      // But that's micro optimization...

      const file = new ClientFile(this, f, this.rootStore.exifTool);
      // Initialize the thumbnail path so the image can be loaded immediately when it mounts.
      // To ensure the thumbnail actually exists, the `ensureThumbnail` function should be called.
      // In the web build there is no local thumbnail directory — use the file ID as the thumbnail
      // path so encodeFilePath routes it to /api/thumb/:id on the sidecar server. On desktop, gate
      // on isWebBuild (NOT an empty thumbnailDirectory): thumbnailDirectory is set asynchronously
      // via IPC and is transiently '' during startup, and using f.id then would blank every
      // thumbnail — including videos, which (needsThumbnail === false) must resolve to their own
      // absolutePath so the <video> element can render them.
      const td = this.rootStore.uiStore.thumbnailDirectory;
      file.thumbnailPath = platform.isWebBuild
        ? f.id
        : this.rootStore.imageLoader.needsThumbnail(f)
        ? getThumbnailPath(f.absolutePath, td)
        : f.absolutePath;
      return file;
    });

    return [clientFiles, reusedStatus];
  }

  /** Derive fields from `fileList`
   * - `index`
   * - `numUntaggedFiles`
   * - `numMissingFiles`
   *
   * Invariant: this function is the SOLE writer of numUntaggedFiles.
   * When called from updateFromBackend's post-splice pass with
   * hideMissingFilesInBrowsing=true, fileList contains only non-broken
   * files, so the count reflects what the gallery will actually render.
   * refetchFileCounts() intentionally does NOT write numUntaggedFiles
   * to avoid overwriting this with the raw DB count. See INV-007.
   */
  @action updateFileListState(): void {
    let missingFiles = 0;
    let untaggedFiles = 0;
    this.index.clear();
    for (let index = 0; index < this.fileList.length; index++) {
      const file = this.fileList[index];
      if (file.isBroken) {
        missingFiles += 1;
      } else if (file.tags.size === 0) {
        untaggedFiles += 1;
      }
      this.index.set(file.id, index);
    }
    this.numMissingFiles = missingFiles;
    if (this.showsAllContent) {
      this.numTotalFiles = this.fileList.length;
      this.numUntaggedFiles = untaggedFiles;
    } else if (this.showsUntaggedContent) {
      this.numUntaggedFiles = this.fileList.length;
    }
    // Don't set numUntaggedFiles for other content types to avoid race conditions
  }

  /** Initializes the total file counter by querying the database with a count operation */
  async refetchFileCounts(): Promise<void> {
    // numTotalFiles = raw DB row count. This value intentionally disregards
    // the `hideMissingFilesInBrowsing` preference — it is the "All Images"
    // toolbar badge which always shows the DB total (see docs/missing-files.md).
    //
    // numUntaggedFiles is NOT written here. It is derived from fileList
    // by updateFileListState()'s post-splice pass in updateFromBackend(),
    // which is the only writer aware of `hideMissingFilesInBrowsing`.
    // Writing a raw DB count here would overwrite the post-splice value
    // and produce the sidebar/gallery count mismatch documented in INV-007.
    const [numTotalFiles, _rawDbUntagged] = await this.backend.countFiles();
    runInAction(() => {
      this.numTotalFiles = numTotalFiles;
    });
  }

  @action private setOrderDirection(order: OrderDirection) {
    this.orderDirection = order;
  }

  @action private setOrderBy(prop: OrderBy<FileDTO> = 'random') {
    this.orderBy = prop;
  }

  @action private setContentMissing() {
    this.content = Content.Missing;
  }

  @action private incrementNumMissingFiles() {
    this.numMissingFiles++;
  }

  // FACES
  // FACES
  // FACES
  @action.bound async addPeopleTag(peopleName: string, file: ClientFile): Promise<ClientTag> {
    const peopleTag = await this.rootStore.tagStore.addPeopleTag(peopleName);
    file.addTag(peopleTag);
    return peopleTag;
  }

  // DISMISSED DUPLICATE GROUPS
  // DISMISSED DUPLICATE GROUPS
  // DISMISSED DUPLICATE GROUPS

  /** Fetch all dismissed duplicate groups from the database */
  async fetchDismissedDuplicateGroups(): Promise<
    import('../../api/dismissed-duplicate-group').DismissedDuplicateGroupDTO[]
  > {
    try {
      return await this.backend.fetchDismissedDuplicateGroups();
    } catch (error) {
      console.error('Failed to fetch dismissed duplicate groups:', error);
      return [];
    }
  }

  /** Add a dismissed duplicate group to the database */
  async createDismissedDuplicateGroup(
    groupHash: string,
    algorithm: string,
    fileIds: string[],
  ): Promise<void> {
    try {
      // id is intentionally omitted; SQLite AUTOINCREMENT on the INTEGER PRIMARY KEY assigns it
      const dismissedGroup = {
        groupHash,
        algorithm,
        fileIds: JSON.stringify(fileIds), // Convert array to JSON string
        dismissedAt: new Date(),
      } as import('../../api/dismissed-duplicate-group').DismissedDuplicateGroupDTO;

      await this.backend.createDismissedDuplicateGroup(dismissedGroup);
      console.log('Successfully dismissed duplicate group:', {
        groupHash,
        algorithm,
        fileCount: fileIds.length,
      });
    } catch (error) {
      console.error('Failed to dismiss duplicate group:', error);
      throw error; // Re-throw so UI can handle it
    }
  }

  /** Remove a dismissed duplicate group from the database (undismiss) */
  async removeDismissedDuplicateGroup(groupHash: string): Promise<void> {
    try {
      await this.backend.removeDismissedDuplicateGroup(groupHash);
      console.log('Successfully undismissed duplicate group:', groupHash);
    } catch (error) {
      console.error('Failed to undismiss duplicate group:', error);
      throw error; // Re-throw so UI can handle it
    }
  }

  // VISUAL HASH CACHE
  // VISUAL HASH CACHE
  // VISUAL HASH CACHE

  /** Fetch cached visual hashes for the given file paths */
  async fetchVisualHashes(
    absolutePaths: string[],
  ): Promise<import('../../api/visual-hash').VisualHashDTO[]> {
    try {
      return await this.backend.fetchVisualHashes(absolutePaths);
    } catch (error) {
      console.error('Failed to fetch visual hashes:', error);
      return [];
    }
  }

  /** Save computed visual hashes to the database */
  async saveVisualHashes(hashes: import('../../api/visual-hash').VisualHashDTO[]): Promise<void> {
    try {
      await this.backend.saveVisualHashes(hashes);
      console.log('Successfully saved', hashes.length, 'visual hashes');
    } catch (error) {
      console.error('Failed to save visual hashes:', error);
      throw error;
    }
  }

  /** Remove visual hashes for deleted or moved files */
  async removeVisualHashes(absolutePaths: string[]): Promise<void> {
    try {
      await this.backend.removeVisualHashes(absolutePaths);
      console.log('Successfully removed visual hashes for', absolutePaths.length, 'files');
    } catch (error) {
      console.error('Failed to remove visual hashes:', error);
      throw error;
    }
  }

  /** Clear all cached visual hashes (useful for cache management) */
  async clearVisualHashCache(): Promise<void> {
    try {
      await this.backend.clearVisualHashCache();
      console.log('Successfully cleared visual hash cache');
    } catch (error) {
      console.error('Failed to clear visual hash cache:', error);
      throw error;
    }
  }
}

export default FileStore;
