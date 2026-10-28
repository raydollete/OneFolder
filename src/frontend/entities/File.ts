import { action, makeObservable, observable, ObservableSet, computed, runInAction } from 'mobx';
import platform from 'src/frontend/platform';

import { FileDTO, IMG_EXTENSIONS_TYPE } from '../../api/file';
import { ID } from '../../api/id';
import ImageLoader from '../image/ImageLoader';
import { detectFaces } from '../image/aiModels';
import FileStore from '../stores/FileStore';
import { FileStats } from '../stores/LocationStore';
import { ClientTag } from './Tag';
import ExifIO from 'common/ExifIO';

/** Retrieved file meta data information */
interface IMetaData {
  /** Duplicate data; also exists as part of the absolutePath. Used for DB queries */
  name: string;
  /** in lowercase, without the dot */
  extension: IMG_EXTENSIONS_TYPE;
  /** Size in bytes */
  size: number;
  width: number;
  height: number;
  /** Date when this file was created (from the OS, not related to OneFolder) */
  dateCreated: Date;
}

/** Extended metadata that includes optional tag information */
interface IExtendedMetaData extends IMetaData {
  /** Tag hierarchies extracted from image metadata (HierarchicalSubject, Subject, Keywords) */
  tagHierarchies?: string[][];
}

/**
 * A File as it is stored in the Client.
 * It is stored in a MobX store, which can observe changed made to it and subsequently
 * update the entity in the backend.
 */
export class ClientFile {
  private store: FileStore;
  private autoSave: boolean = true;
  private immediateMetadataSync: boolean = true;
  private exifTool: ExifIO;
  private metadataWriteTimeout: NodeJS.Timeout | null = null;
  private pendingMetadataWrite: boolean = false;

  readonly ino: string;
  readonly id: ID;
  readonly locationId: ID;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly tags: ObservableSet<ClientTag>;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly dateAdded: Date;
  readonly dateCreated: Date;
  readonly dateModified: Date;
  readonly dateLastIndexed: Date;
  readonly name: string;
  readonly extension: IMG_EXTENSIONS_TYPE;
  /** Same as "name", but without extension */
  readonly filename: string;

  @observable annotations: string;
  @observable thumbnailPath: string = '';
  // Is undefined until existence check has been completed
  @observable isBroken?: boolean;

  // Probed codec facts (change: support-mov-playback). null/undefined = not probed
  // yet — the gallery/player must never render an absent verdict as unplayable.
  @observable videoCodec?: string | null;
  @observable audioCodec?: string | null;
  @observable codecVersion?: string | null;
  // Probed container fact (change: support-mkv-ts-playback): ffprobe
  // format_name, e.g. 'matroska,webm', 'mpegts'. null/undefined = not probed
  // yet — same never-a-verdict discipline as the codec facts above.
  @observable formatName?: string | null;

  constructor(store: FileStore, fileProps: FileDTO, exifTool: ExifIO) {
    this.store = store;
    this.exifTool = exifTool;

    this.ino = fileProps.ino;
    this.id = fileProps.id;
    this.locationId = fileProps.locationId;
    this.relativePath = fileProps.relativePath;
    this.size = fileProps.size;
    this.width = fileProps.width;
    this.height = fileProps.height;
    this.dateAdded = fileProps.dateAdded;
    this.dateCreated = fileProps.dateCreated;
    this.dateModified = fileProps.dateModified;
    this.dateLastIndexed = fileProps.dateLastIndexed;
    this.name = fileProps.name;
    this.extension = fileProps.extension;
    this.videoCodec = fileProps.videoCodec ?? null;
    this.audioCodec = fileProps.audioCodec ?? null;
    this.codecVersion = fileProps.codecVersion ?? null;
    this.formatName = fileProps.formatName ?? null;

    const location = store.getLocation(this.locationId);
    this.absolutePath = platform.path.join(location.path, this.relativePath);

    const base = platform.path.basename(this.relativePath);
    this.filename = base.slice(0, base.lastIndexOf('.'));

    this.tags = observable(this.store.getTags(fileProps.tags));

    // string to object
    this.annotations = fileProps.annotations;

    // Auto-save is centralized: mutation methods call markDirty(), which
    // registers this file in FileStore's dirty set; one debounced flusher
    // serializes only dirty files. This replaces the former per-file MobX
    // reaction on serialize() — N files no longer means N live reactions
    // (see openspec/changes/optimize-large-library-performance).

    makeObservable(this);
  }

  /** Whether centralized auto-save may persist this file (disabled for broken/disposed files). */
  get isAutoSaveEnabled(): boolean {
    return this.autoSave;
  }

  /** Registers this file with the store's central debounced auto-save flusher. */
  private markDirty(): void {
    this.store.markFileDirty(this);
  }

  @computed get getAnnotations(): string {
    return this.annotations;
  }

  @action.bound setThumbnailPath(thumbnailPath: string): void {
    this.thumbnailPath = thumbnailPath;
  }

  @action.bound addTag(tag: ClientTag): void {
    const hasTag = this.tags.has(tag);
    if (!hasTag) {
      this.tags.add(tag);
      this.markDirty();

      // Write tags to file metadata with debouncing (unless disabled for bulk operations)
      if (this.immediateMetadataSync) {
        this.scheduleMetadataWrite();
      }

      tag.incrementFileCount();

      if (this.tags.size === 1) {
        this.store.decrementNumUntaggedFiles();
      }
    }
  }

  @action.bound removeTag(tag: ClientTag): void {
    const hadTag = this.tags.delete(tag);
    if (hadTag) {
      this.markDirty();
      // Write updated tags to file metadata with debouncing (unless disabled for bulk operations)
      if (this.immediateMetadataSync) {
        this.scheduleMetadataWrite();
      }

      tag.decrementFileCount();

      if (this.tags.size === 0) {
        this.store.incrementNumUntaggedFiles();
      }
    }
  }

  /**
   * Temporarily disables immediate metadata sync for bulk operations
   * Returns a function to re-enable sync and write the final metadata
   */
  @action.bound disableImmediateSync(): () => Promise<void> {
    const wasEnabled = this.immediateMetadataSync;
    this.immediateMetadataSync = false;

    // Cancel any pending write
    if (this.metadataWriteTimeout) {
      clearTimeout(this.metadataWriteTimeout);
      this.metadataWriteTimeout = null;
      this.pendingMetadataWrite = false;
    }

    return async () => {
      this.immediateMetadataSync = wasEnabled;
      // Write current tags to metadata once at the end
      if (wasEnabled) {
        const tagHierarchy = runInAction(() => Array.from(this.tags, (t) => t.path));
        await this.writeTagsToFile(tagHierarchy);
      }
    };
  }

  /**
   * Schedules a debounced metadata write to prevent excessive ExifTool processes
   * Multiple rapid tag changes will be batched into a single write operation
   */
  private scheduleMetadataWrite(): void {
    // Cancel any pending write
    if (this.metadataWriteTimeout) {
      clearTimeout(this.metadataWriteTimeout);
    }

    // Mark that we have a pending write
    this.pendingMetadataWrite = true;

    // Schedule a new write after a short delay (300ms)
    // This allows multiple rapid tag changes to be batched together
    this.metadataWriteTimeout = setTimeout(async () => {
      if (this.pendingMetadataWrite && this.immediateMetadataSync) {
        const tagHierarchy = runInAction(() => Array.from(this.tags, (t) => t.path));
        await this.writeTagsToFile(tagHierarchy);
      }
      this.metadataWriteTimeout = null;
      this.pendingMetadataWrite = false;
    }, 300);
  }

  /**
   * Writes the current tags to the file's metadata
   * Logs errors silently without interrupting the user experience
   */
  private async writeTagsToFile(tagHierarchy: string[][]): Promise<void> {
    try {
      await this.exifTool.writeTags(this.absolutePath, tagHierarchy);
      // Silent success - no notification needed
    } catch (error) {
      // Silent logging - metadata sync failures are not critical
      // Tags are still saved in OneFolder's database and can be exported later
      console.warn('Metadata sync failed for', this.filename, ':', error);
    }
  }

  @action.bound clearTags(): void {
    if (this.tags.size > 0) {
      this.store.incrementNumUntaggedFiles();
      this.tags.forEach((tag) => tag.decrementFileCount());
      this.tags.clear();
      this.markDirty();
    }
  }

  // @action.bound addFaceAnnotations(annotation: object): void {
  //   this.annotations = JSON.stringify(annotation);
  // }

  @action.bound setBroken(isBroken: boolean): void {
    this.isBroken = isBroken;
    this.autoSave = !isBroken;
  }

  @action.bound updateTagsFromBackend(tags: ClientTag[]): void {
    this.tags.replace(tags);
    // Parity with the former serialize()-reaction, which also fired on
    // backend-sourced tag updates: keep persisting them.
    this.markDirty();
  }

  /**
   * Record a fresh probe result from the background codec pass (desktop main
   * process) and schedule persistence. Facts only — playability is derived at
   * render time (src/frontend/image/playability.ts), never stored.
   */
  @action.bound setCodecFacts(
    videoCodec: string | null,
    audioCodec: string | null,
    codecVersion: string,
    formatName?: string | null,
  ): void {
    this.videoCodec = videoCodec;
    this.audioCodec = audioCodec;
    this.codecVersion = codecVersion;
    // Optional trailing parameter so pre-container callers keep working; an
    // absent argument leaves a stored container fact intact, never erases it.
    if (formatName !== undefined) this.formatName = formatName;
    this.markDirty();
  }

  serialize(): FileDTO {
    return {
      id: this.id,
      ino: this.ino,
      locationId: this.locationId,
      relativePath: this.relativePath,
      absolutePath: this.absolutePath,
      tags: Array.from(this.tags, (t) => t.id), // removes observable properties from observable array
      size: this.size,
      width: this.width,
      height: this.height,
      dateAdded: this.dateAdded,
      dateCreated: this.dateCreated,
      dateModified: this.dateModified,
      dateLastIndexed: this.dateLastIndexed,
      name: this.name,
      extension: this.extension,
      annotations: this.annotations, // serialize annotations object to string
      videoCodec: this.videoCodec ?? null,
      audioCodec: this.audioCodec ?? null,
      codecVersion: this.codecVersion ?? null,
      formatName: this.formatName ?? null,
    };
  }

  dispose(): void {
    // No per-file reaction to dispose anymore; disabling autoSave makes the
    // central flusher skip this instance if it is still in the dirty set.
    this.autoSave = false;
  }

  // FACES
  // FACES
  // FACES
  @action.bound detectFaces(img: HTMLImageElement): void {
    detectFaces(img);
  }

  @action.bound async addPeopleTag(peopleName: string): Promise<ClientTag> {
    return await this.store.addPeopleTag(peopleName, this);
  }
}

/** Should be called when after constructing a file before sending it to the backend. */
export async function getMetaData(stats: FileStats, imageLoader: ImageLoader): Promise<IMetaData> {
  const path = stats.absolutePath;
  const dimensions = await imageLoader.getImageResolution(stats.absolutePath);

  return {
    name: platform.path.basename(path),
    extension: platform.path.extname(path).slice(1).toLowerCase() as IMG_EXTENSIONS_TYPE,
    size: stats.size,
    width: dimensions.width,
    height: dimensions.height,
    dateCreated: stats.dateCreated,
  };
}

/**
 * Enhanced version that can optionally read tags alongside basic metadata in a single ExifTool call.
 * This eliminates redundant ExifTool calls during location loading.
 */
export async function getMetaDataWithTags(
  stats: FileStats,
  imageLoader: ImageLoader,
  readTags: boolean = false,
): Promise<IExtendedMetaData> {
  const path = stats.absolutePath;

  if (!readTags) {
    // Use existing method for backwards compatibility
    const basicMetadata = await getMetaData(stats, imageLoader);
    return basicMetadata;
  }

  // Use the new combined ExifTool call for optimal performance
  const { dimensions, tags } = await imageLoader.getImageResolutionAndTags(stats.absolutePath);

  return {
    name: platform.path.basename(path),
    extension: platform.path.extname(path).slice(1).toLowerCase() as IMG_EXTENSIONS_TYPE,
    size: stats.size,
    width: dimensions.width,
    height: dimensions.height,
    dateCreated: stats.dateCreated,
    tagHierarchies: tags,
  };
}

/** Merges an existing IFile file with a newly detected IFile: only the paths of the oldFile will be updated  */
export function mergeMovedFile(oldFile: FileDTO, newFile: FileDTO): FileDTO {
  return {
    ...oldFile,
    ino: newFile.ino,
    name: newFile.name,
    extension: newFile.extension,
    absolutePath: newFile.absolutePath,
    relativePath: newFile.relativePath,
    locationId: newFile.locationId,
    dateModified: new Date(),
  };
}
