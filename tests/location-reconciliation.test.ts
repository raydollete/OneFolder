/**
 * Map-indexed reconciliation matchers (task 2.1,
 * optimize-large-library-performance): created/missing/moved/renamed cases,
 * with semantics equivalent to the former nested-.find() implementation.
 */
import { FileDTO } from '../src/api/file';
import {
  areFilesIdenticalBesidesName,
  buildDbFilesByCreatedDate,
  matchMissingToCreated,
  matchMissingToDbDuplicates,
} from '../src/frontend/stores/locationReconciliation';

let inoCounter = 0;
function makeDTO(overrides: Partial<FileDTO> = {}): FileDTO {
  const id = overrides.id ?? `f${++inoCounter}`;
  return {
    id,
    ino: `ino-${id}`,
    locationId: 'loc1',
    relativePath: `${id}.jpg`,
    absolutePath: `/photos/${id}.jpg`,
    name: `${id}.jpg`,
    extension: 'jpg',
    size: 1000,
    width: 640,
    height: 480,
    dateAdded: new Date(1000),
    dateModified: new Date(1000),
    dateCreated: new Date(1000),
    dateLastIndexed: new Date(1000),
    tags: [],
    annotations: '',
    ...overrides,
  } as FileDTO;
}

describe('locationReconciliation matchers', () => {
  it('matches a moved file by ino', () => {
    const missing = [makeDTO({ id: 'old', ino: 'shared-ino' })];
    const created = [
      makeDTO({ id: 'other', ino: 'x', width: 1, height: 1 }),
      makeDTO({ id: 'moved', ino: 'shared-ino', width: 999, height: 999, dateCreated: new Date(5) }),
    ];
    const matches = matchMissingToCreated(missing, created);
    expect(matches[0]?.id).toBe('moved');
  });

  it('matches a renamed file by dimensions + creation date when ino differs', () => {
    const t = new Date(123456);
    const missing = [makeDTO({ id: 'old', ino: 'a', width: 800, height: 600, dateCreated: t })];
    const created = [
      makeDTO({ id: 'unrelated', ino: 'b', width: 100, height: 100, dateCreated: t }),
      makeDTO({ id: 'renamed', ino: 'c', width: 800, height: 600, dateCreated: t }),
    ];
    const matches = matchMissingToCreated(missing, created);
    expect(matches[0]?.id).toBe('renamed');
  });

  it('returns undefined for a genuinely deleted file', () => {
    const missing = [makeDTO({ id: 'gone', ino: 'z', width: 10, height: 10 })];
    const created = [makeDTO({ id: 'new', ino: 'y', width: 20, height: 20 })];
    expect(matchMissingToCreated(missing, created)[0]).toBeUndefined();
  });

  it('preserves first-in-created-order semantics when multiple candidates match', () => {
    const t = new Date(9);
    const missing = [makeDTO({ id: 'old', ino: 'nope', width: 5, height: 5, dateCreated: t })];
    // Both created files are identical besides name; the FIRST in array order wins,
    // exactly like the former createdFiles.find(...).
    const created = [
      makeDTO({ id: 'first', ino: 'c1', width: 5, height: 5, dateCreated: t }),
      makeDTO({ id: 'second', ino: 'c2', width: 5, height: 5, dateCreated: t }),
    ];
    expect(matchMissingToCreated(missing, created)[0]?.id).toBe('first');
  });

  it('equivalence with the brute-force nested .find on a randomized workload', () => {
    const dates = [new Date(1), new Date(2), new Date(3)];
    const rand = (n: number) => Math.floor(Math.random() * n);
    const missing = Array.from({ length: 60 }, (_, i) =>
      makeDTO({
        id: `m${i}`,
        ino: `mi${rand(20)}`,
        width: rand(4),
        height: rand(4),
        dateCreated: dates[rand(3)],
      }),
    );
    const created = Array.from({ length: 60 }, (_, i) =>
      makeDTO({
        id: `c${i}`,
        ino: `mi${rand(20)}`,
        width: rand(4),
        height: rand(4),
        dateCreated: dates[rand(3)],
      }),
    );
    const expected = missing.map((mf) =>
      created.find((cf) => areFilesIdenticalBesidesName(cf, mf)),
    );
    expect(matchMissingToCreated(missing, created)).toEqual(expected);
  });

  it('finds a db duplicate (renamed file already re-ingested) and skips created-matched files', () => {
    const t = new Date(55);
    const missingMatched = makeDTO({ id: 'matched', width: 1, height: 1, dateCreated: t });
    const missingDup = makeDTO({ id: 'dup-old', ino: 'q', width: 7, height: 7, dateCreated: t });
    const dbTwin = makeDTO({ id: 'dup-new', ino: 'r', width: 7, height: 7, dateCreated: t });

    const dbIndex = buildDbFilesByCreatedDate([missingMatched, missingDup, dbTwin]);
    const result = matchMissingToDbDuplicates(
      [missingMatched, missingDup],
      [makeDTO({ id: 'created-match' }), undefined],
      dbIndex,
    );
    expect(result[0]).toBe(false); // created-matched → skipped
    expect((result[1] as FileDTO)?.id).toBe('dup-new');
  });

  it('prefers the same-name db duplicate over a name-changed one', () => {
    const t = new Date(77);
    const missing = makeDTO({ id: 'old', name: 'holiday.jpg', width: 3, height: 3, dateCreated: t });
    const otherName = makeDTO({ id: 'twin-a', name: 'other.jpg', width: 3, height: 3, dateCreated: t });
    const sameName = makeDTO({ id: 'twin-b', name: 'holiday.jpg', width: 3, height: 3, dateCreated: t });

    const dbIndex = buildDbFilesByCreatedDate([missing, otherName, sameName]);
    const result = matchMissingToDbDuplicates([missing], [undefined], dbIndex);
    expect((result[0] as FileDTO)?.id).toBe('twin-b');
  });
});
