import { FileDTO } from '../../api/file';

/**
 * Pure matching helpers for LocationStore.watchLocations' startup
 * reconciliation (created/missing/moved/renamed detection).
 *
 * The former implementation matched with nested `.find()` scans —
 * O(missing × created) worst case, on the renderer thread, against 57k+ file
 * libraries. These helpers pre-index by ino and by identity characteristics so
 * each lookup is O(1), while preserving the original first-match-in-array-order
 * semantics of `createdFiles.find(...)`.
 */

/**
 * Same identity heuristic the reconciliation always used: identical ino, or
 * identical dimensions + creation time (size intentionally excluded — it
 * changes when tags are written into file metadata).
 */
export function areFilesIdenticalBesidesName(a: FileDTO, b: FileDTO): boolean {
  return (
    a.ino === b.ino ||
    (a.width === b.width &&
      a.height === b.height &&
      a.dateCreated.getTime() === b.dateCreated.getTime())
  );
}

function dimensionKey(f: FileDTO): string {
  return `${f.width}x${f.height}@${f.dateCreated.getTime()}`;
}

interface IndexedCandidate {
  file: FileDTO;
  index: number;
}

/** Groups all db files by creation time for bounded duplicate-candidate lookups. */
export function buildDbFilesByCreatedDate(dbFiles: readonly FileDTO[]): Map<number, FileDTO[]> {
  const byCreatedDate = new Map<number, FileDTO[]>();
  for (const file of dbFiles) {
    const time = file.dateCreated.getTime();
    const entry = byCreatedDate.get(time);
    if (entry !== undefined) {
      entry.push(file);
    } else {
      byCreatedDate.set(time, [file]);
    }
  }
  return byCreatedDate;
}

/**
 * For every missing (in DB, gone from disk) file, finds the first created
 * (on disk, not in DB) file that is identical besides name/path — a
 * rename/move detected as delete+create. Equivalent to
 * `missingFiles.map((mf) => createdFiles.find((cf) => areFilesIdenticalBesidesName(cf, mf)))`
 * but O(missing + created) via ino/dimension indexes.
 */
export function matchMissingToCreated(
  missingFiles: readonly FileDTO[],
  createdFiles: readonly FileDTO[],
): (FileDTO | undefined)[] {
  const byIno = new Map<string, IndexedCandidate[]>();
  const byDimensions = new Map<string, IndexedCandidate[]>();
  createdFiles.forEach((file, index) => {
    const candidate = { file, index };
    const inoList = byIno.get(file.ino);
    if (inoList !== undefined) {
      inoList.push(candidate);
    } else {
      byIno.set(file.ino, [candidate]);
    }
    const dimKey = dimensionKey(file);
    const dimList = byDimensions.get(dimKey);
    if (dimList !== undefined) {
      dimList.push(candidate);
    } else {
      byDimensions.set(dimKey, [candidate]);
    }
  });

  return missingFiles.map((missingFile) => {
    let best: IndexedCandidate | undefined;
    for (const candidate of byIno.get(missingFile.ino) ?? []) {
      if (best === undefined || candidate.index < best.index) {
        best = candidate;
      }
    }
    for (const candidate of byDimensions.get(dimensionKey(missingFile)) ?? []) {
      if (best === undefined || candidate.index < best.index) {
        best = candidate;
      }
    }
    return best?.file;
  });
}

/**
 * For missing files with no created-file match, looks for another EXISTING db
 * entry that is identical besides name — a rename/move that was already
 * re-ingested as a new row (the old row is a duplicate to merge+delete).
 * Candidate set is bounded by the created-date index (unchanged semantics from
 * the original implementation).
 */
export function matchMissingToDbDuplicates(
  missingFiles: readonly FileDTO[],
  createdMatches: readonly (FileDTO | undefined)[],
  dbFilesByCreatedDate: ReadonlyMap<number, FileDTO[]>,
): (FileDTO | undefined | false)[] {
  return missingFiles.map((missingDbFile, i) => {
    if (createdMatches[i]) {
      return false; // skip missing files that match with a newly created file
    }
    const candidates = dbFilesByCreatedDate.get(missingDbFile.dateCreated.getTime()) || [];

    // First look for a file with the same name + identity (file moved to a different path)
    const matchWithName = candidates.find(
      (otherDbFile) =>
        missingDbFile !== otherDbFile &&
        missingDbFile.name === otherDbFile.name &&
        areFilesIdenticalBesidesName(missingDbFile, otherDbFile),
    );

    // If no match, try without the filename in case the file was renamed
    // (prone to errors, but better than nothing)
    return (
      matchWithName ||
      candidates.find(
        (otherDbFile) =>
          missingDbFile !== otherDbFile && areFilesIdenticalBesidesName(missingDbFile, otherDbFile),
      )
    );
  });
}
