import { ID } from './id';

/**
 * DTO for storing computed visual hashes to avoid recomputation
 */
export interface VisualHashDTO {
  id?: ID; // Auto-incremented by Dexie
  /**
   * Portable, OS-independent cache key — `portableFileKey(locationId,
   * relativePath)` (see common/fs.ts), NOT the per-OS absolutePath. Unique per
   * file within a library, so a shared cache is reused across a dual-boot install
   * instead of recomputed.
   */
  fileKey: string;
  fileSize: number; // File size for change detection
  dateModified: Date; // File modification date for change detection
  hashType: 'aHash' | 'dctHash' | 'waveletHash'; // Algorithm used
  hash: string; // The computed hash (binary string)
  dateComputed: Date; // When this hash was computed
  thumbnailPath?: string; // Path to thumbnail used (for debugging)
}

/**
 * Simplified version for worker communication
 */
export interface VisualHashCache {
  /** Portable cache key — see VisualHashDTO.fileKey. */
  fileKey: string;
  hash: string;
  hashType: string;
  isValid: boolean; // Whether the cached hash is still valid
}
