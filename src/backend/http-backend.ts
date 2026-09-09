/**
 * HttpBackend — a fetch()-based implementation of DataStorage for the
 * read-only web SPA target (INV-034 / TASK-127).
 *
 * All read methods call the sidecar REST API (TASK-128).
 * All write/mutation methods reject loudly: the read-only web build must never
 * silently swallow a mutation — loud errors surface bugs early (fail-loud rule).
 *
 * REST contract (mirrored 1:1 by the sidecar server in TASK-128):
 *
 *   GET /api/tags                                → { tags: TagWire[] }
 *   GET /api/files?order=<key|random|tagCountRandom>&direction=<asc|desc>
 *                                                → { files: FileWire[] }
 *   POST /api/files/by-ids          body: { ids: string[] }
 *                                                → { files: FileWire[] }
 *   POST /api/files/by-key          body: { key: string, value: string|number }
 *                                                → { files: FileWire[] }
 *   GET /api/locations                           → { locations: LocationWire[] }
 *   GET /api/searches                            → { searches: FileSearchWire[] }
 *   POST /api/files/search          body: SearchRequest
 *                                                → { files: FileWire[] }
 *   GET /api/files/count                         → { fileCount: number, untaggedFileCount: number }
 *   GET /api/dismissed-duplicate-groups          → { groups: DismissedDuplicateGroupWire[] }
 *   POST /api/visual-hashes/by-paths body: { absolutePaths: string[] }
 *                                                → { hashes: VisualHashWire[] }
 *
 * Wire types: identical to DTO types except Date fields are ISO 8601 strings.
 * The deserializer functions below parse ISO strings back to Date objects,
 * matching the SQLiteBackend's deserialization semantics.
 */

import { DataStorage } from '../api/data-storage';
import { ConditionDTO, OrderBy, OrderDirection } from '../api/data-storage-search';
import { DismissedDuplicateGroupDTO } from '../api/dismissed-duplicate-group';
import { FileDTO } from '../api/file';
import { FileSearchDTO } from '../api/file-search';
import { ID } from '../api/id';
import { LocationDTO } from '../api/location';
import { TagDTO } from '../api/tag';
import { VisualHashDTO } from '../api/visual-hash';

// ---------------------------------------------------------------------------
// Wire types — same shape as the DTOs but with Date fields as ISO strings
// ---------------------------------------------------------------------------

interface FileWire
  extends Omit<FileDTO, 'dateAdded' | 'dateModified' | 'dateCreated' | 'dateLastIndexed'> {
  dateAdded: string;
  dateModified: string;
  dateCreated: string;
  dateLastIndexed: string;
}

interface TagWire extends Omit<TagDTO, 'dateAdded'> {
  dateAdded: string;
}

interface LocationWire extends Omit<LocationDTO, 'dateAdded'> {
  dateAdded: string;
}

// FileSearchDTO has no Date fields — used directly on the wire
type FileSearchWire = FileSearchDTO;

interface DismissedDuplicateGroupWire extends Omit<DismissedDuplicateGroupDTO, 'dismissedAt'> {
  dismissedAt: string;
}

interface VisualHashWire extends Omit<VisualHashDTO, 'dateModified' | 'dateComputed'> {
  dateModified: string;
  dateComputed: string;
}

// ---------------------------------------------------------------------------
// Deserializers — parse ISO date strings from the wire back to Date objects
// ---------------------------------------------------------------------------

function fileFromWire(w: FileWire): FileDTO {
  return {
    ...w,
    dateAdded: new Date(w.dateAdded),
    dateModified: new Date(w.dateModified),
    dateCreated: new Date(w.dateCreated),
    dateLastIndexed: new Date(w.dateLastIndexed),
  };
}

function tagFromWire(w: TagWire): TagDTO {
  return {
    ...w,
    dateAdded: new Date(w.dateAdded),
  };
}

function locationFromWire(w: LocationWire): LocationDTO {
  return {
    ...w,
    dateAdded: new Date(w.dateAdded),
  };
}

function dismissedGroupFromWire(w: DismissedDuplicateGroupWire): DismissedDuplicateGroupDTO {
  return {
    ...w,
    dismissedAt: new Date(w.dismissedAt),
  };
}

function visualHashFromWire(w: VisualHashWire): VisualHashDTO {
  return {
    ...w,
    dateModified: new Date(w.dateModified),
    dateComputed: new Date(w.dateComputed),
  };
}

// ---------------------------------------------------------------------------
// HttpBackend
// ---------------------------------------------------------------------------

function readOnlyReject(methodName: string): never {
  throw new Error(
    `[HttpBackend] "${methodName}" is not supported in the read-only web build. ` +
      'This backend is intentionally read-only — write operations must not be called ' +
      'from the web SPA (INV-034).',
  );
}

/**
 * Build a base64-encoded HTTP Basic auth header value from user + password.
 * Returns `undefined` when neither is provided (unauthenticated mode).
 */
function buildBasicAuthHeader(user: string, password: string): string {
  return 'Basic ' + btoa(`${user}:${password}`);
}

export class HttpBackend implements DataStorage {
  readonly #baseUrl: string;
  /** Pre-computed "Authorization: Basic ..." header value, or undefined. */
  readonly #authHeader: string | undefined;

  /**
   * @param baseUrl   Origin of the sidecar server, e.g. "http://localhost:8666".
   *                  May be empty string to use the current page's origin (same-origin).
   * @param user      HTTP Basic auth username (ONEFOLDER_AUTH_USER / ONEFOLDER_AUTH_SECRET).
   *                  Pass undefined to make unauthenticated requests (dev / no-auth mode).
   * @param password  HTTP Basic auth password.
   */
  constructor(baseUrl: string, user?: string, password?: string) {
    // Strip trailing slash for clean URL construction
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#authHeader =
      user !== undefined && password !== undefined
        ? buildBasicAuthHeader(user, password)
        : undefined;
  }

  // -------------------------------------------------------------------------
  // Internal fetch helper
  // -------------------------------------------------------------------------

  async #get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.#authHeader !== undefined) {
      headers['Authorization'] = this.#authHeader;
    }
    const res = await fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers,
      // Include cookies so the auth cookie is sent on same-origin requests
      // (the browser sends it automatically, but 'include' makes it explicit
      // for cross-origin sidecar deployments).
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error(`[HttpBackend] GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.#authHeader !== undefined) {
      headers['Authorization'] = this.#authHeader;
    }
    const res = await fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error(`[HttpBackend] POST ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Read methods (implement DataStorage)
  // -------------------------------------------------------------------------

  async fetchTags(): Promise<TagDTO[]> {
    const { tags } = await this.#get<{ tags: TagWire[] }>('/api/tags');
    return tags.map(tagFromWire);
  }

  async fetchFiles(order: OrderBy<FileDTO>, fileOrder: OrderDirection): Promise<FileDTO[]> {
    const direction = fileOrder === OrderDirection.Desc ? 'desc' : 'asc';
    const { files } = await this.#get<{ files: FileWire[] }>(
      `/api/files?order=${encodeURIComponent(String(order))}&direction=${direction}`,
    );
    return files.map(fileFromWire);
  }

  async fetchFilesByID(ids: ID[]): Promise<FileDTO[]> {
    if (ids.length === 0) {
      return [];
    }
    const { files } = await this.#post<{ files: FileWire[] }>('/api/files/by-ids', { ids });
    return files.map(fileFromWire);
  }

  async fetchFilesByKey(key: keyof FileDTO, value: string | number | Date): Promise<FileDTO[]> {
    // Dates must be serialized as ISO strings for the server to interpret
    const wireValue = value instanceof Date ? value.toISOString() : value;
    const { files } = await this.#post<{ files: FileWire[] }>('/api/files/by-key', {
      key,
      value: wireValue,
    });
    return files.map(fileFromWire);
  }

  async fetchLocations(): Promise<LocationDTO[]> {
    const { locations } = await this.#get<{ locations: LocationWire[] }>('/api/locations');
    return locations.map(locationFromWire);
  }

  async fetchSearches(): Promise<FileSearchDTO[]> {
    const { searches } = await this.#get<{ searches: FileSearchWire[] }>('/api/searches');
    // No date conversion needed for FileSearchDTO
    return searches;
  }

  async searchFiles(
    criteria: ConditionDTO<FileDTO> | [ConditionDTO<FileDTO>, ...ConditionDTO<FileDTO>[]],
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    matchAny?: boolean,
  ): Promise<FileDTO[]> {
    const direction = fileOrder === OrderDirection.Desc ? 'desc' : 'asc';
    const { files } = await this.#post<{ files: FileWire[] }>('/api/files/search', {
      criteria: Array.isArray(criteria) ? criteria : [criteria],
      order,
      direction,
      matchAny: matchAny ?? false,
    });
    return files.map(fileFromWire);
  }

  async countFiles(): Promise<[fileCount: number, untaggedFileCount: number]> {
    const { fileCount, untaggedFileCount } = await this.#get<{
      fileCount: number;
      untaggedFileCount: number;
    }>('/api/files/count');
    return [fileCount, untaggedFileCount];
  }

  async fetchDismissedDuplicateGroups(): Promise<DismissedDuplicateGroupDTO[]> {
    const { groups } = await this.#get<{ groups: DismissedDuplicateGroupWire[] }>(
      '/api/dismissed-duplicate-groups',
    );
    return groups.map(dismissedGroupFromWire);
  }

  async fetchVisualHashes(fileKeys: string[]): Promise<VisualHashDTO[]> {
    if (fileKeys.length === 0) {
      return [];
    }
    const { hashes } = await this.#post<{ hashes: VisualHashWire[] }>(
      '/api/visual-hashes/by-keys',
      { fileKeys },
    );
    return hashes.map(visualHashFromWire);
  }

  // -------------------------------------------------------------------------
  // Write / mutation methods — all reject loudly (read-only web build)
  //
  // Parameters are required by the DataStorage interface but unused because every
  // method throws immediately. The @typescript-eslint/no-unused-vars disable
  // covers this entire block rather than repeating it per-method.
  // -------------------------------------------------------------------------

  /* eslint-disable @typescript-eslint/no-unused-vars */

  async createTag(_tag: TagDTO): Promise<void> {
    readOnlyReject('createTag');
  }

  async createFilesFromPath(_path: string, _files: FileDTO[]): Promise<void> {
    readOnlyReject('createFilesFromPath');
  }

  async createLocation(_location: LocationDTO): Promise<void> {
    readOnlyReject('createLocation');
  }

  async createSearch(_search: FileSearchDTO): Promise<void> {
    readOnlyReject('createSearch');
  }

  async saveTag(_tag: TagDTO): Promise<void> {
    readOnlyReject('saveTag');
  }

  async saveFiles(_files: FileDTO[]): Promise<void> {
    readOnlyReject('saveFiles');
  }

  async saveLocation(_location: LocationDTO): Promise<void> {
    readOnlyReject('saveLocation');
  }

  async saveSearch(_search: FileSearchDTO): Promise<void> {
    readOnlyReject('saveSearch');
  }

  async removeTags(_tags: ID[]): Promise<void> {
    readOnlyReject('removeTags');
  }

  async mergeTags(_tagToBeRemoved: ID, _tagToMergeWith: ID): Promise<void> {
    readOnlyReject('mergeTags');
  }

  async removeFiles(_files: ID[]): Promise<void> {
    readOnlyReject('removeFiles');
  }

  async removeLocation(_location: ID): Promise<void> {
    readOnlyReject('removeLocation');
  }

  async removeSearch(_search: ID): Promise<void> {
    readOnlyReject('removeSearch');
  }

  async clear(): Promise<void> {
    readOnlyReject('clear');
  }

  async clearFilesOnly(): Promise<void> {
    readOnlyReject('clearFilesOnly');
  }

  async createDismissedDuplicateGroup(_dismissedGroup: DismissedDuplicateGroupDTO): Promise<void> {
    readOnlyReject('createDismissedDuplicateGroup');
  }

  async removeDismissedDuplicateGroup(_groupHash: string): Promise<void> {
    readOnlyReject('removeDismissedDuplicateGroup');
  }

  async saveVisualHashes(_hashes: VisualHashDTO[]): Promise<void> {
    readOnlyReject('saveVisualHashes');
  }

  async removeVisualHashes(_fileKeys: string[]): Promise<void> {
    readOnlyReject('removeVisualHashes');
  }

  async clearVisualHashCache(): Promise<void> {
    readOnlyReject('clearVisualHashCache');
  }

  /* eslint-enable @typescript-eslint/no-unused-vars */

  // close() is not implemented — no connection to close for an HTTP backend.
  // The optional DataStorage.close?() is intentionally omitted.
}
