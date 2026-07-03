/**
 * Tests for the media-type display filter (change: media-type-filter-dropdown).
 *
 * Two concerns:
 *  1. `mediaTypeMatches` — the pure classifier in common/fs.ts.
 *  2. The upstream gate in FileStore.updateFromBackend: when a media-type filter
 *     is active, non-matching files are trimmed from the raw FileDTO[] BEFORE any
 *     ClientFile is constructed, so they never enter fileList, while the All-view
 *     `numTotalFiles` badge keeps reporting the pre-gate fetched count.
 *
 * The FileStore mock shape mirrors file-store-generation-gate.test.ts.
 */

import { configure } from 'mobx';
import { FileDTO } from '../src/api/file';
import { mediaTypeMatches } from '../common/fs';

configure({ enforceActions: 'never' });

// ---------------------------------------------------------------------------
// 1. Pure classifier
// ---------------------------------------------------------------------------

describe('mediaTypeMatches', () => {
  const videoExts = ['mp4', 'webm', 'ogg'];
  const imageExts = ['jpg', 'png', 'heic', 'gif', 'tif'];

  it('all matches every extension', () => {
    for (const ext of [...videoExts, ...imageExts]) {
      expect(mediaTypeMatches('all', ext)).toBe(true);
    }
  });

  it('video matches only recognized video extensions', () => {
    for (const ext of videoExts) {
      expect(mediaTypeMatches('video', ext)).toBe(true);
    }
    for (const ext of imageExts) {
      expect(mediaTypeMatches('video', ext)).toBe(false);
    }
  });

  it('images matches everything that is not a recognized video', () => {
    for (const ext of imageExts) {
      expect(mediaTypeMatches('images', ext)).toBe(true);
    }
    for (const ext of videoExts) {
      expect(mediaTypeMatches('images', ext)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Upstream gate in FileStore.updateFromBackend
// ---------------------------------------------------------------------------

function makeMockRootStore(mediaTypeFilter: 'all' | 'images' | 'video'): any {
  const uiStore: any = {
    hideMissingFilesInBrowsing: false, // keep the broken-file splice out of the way
    mediaTypeFilter,
    isSlideMode: false,
    disableSlideMode: jest.fn(),
    searchCriteriaList: { length: 0, clear: jest.fn(), push: jest.fn(), map: jest.fn(() => []) },
    searchMatchAny: false,
    clearFileSelection: jest.fn(),
    fileSelection: new Set(),
    thumbnailDirectory: '/tmp/thumbs',
    _resetSearchCriteriaListNoFetch: jest.fn(),
  };
  return {
    uiStore,
    tagStore: { tagList: [], get: jest.fn(() => undefined) },
    imageLoader: { needsThumbnail: jest.fn(() => false) },
    exifTool: {},
    locationStore: { get: jest.fn(() => ({ id: 'loc1', name: 'Test', path: '/photos' })) },
  };
}

function makeFileDTO(id: string, extension: string): FileDTO {
  return {
    id,
    absolutePath: `/photos/${id}.${extension}`,
    relativePath: `${id}.${extension}`,
    locationId: 'loc1',
    name: `${id}.${extension}`,
    size: 100,
    width: 640,
    height: 480,
    dateAdded: new Date(),
    dateModified: new Date(),
    dateCreated: new Date(),
    dateLastIndexed: new Date(),
    extension,
    ino: id,
    tags: [],
    annotations: '',
  } as FileDTO;
}

async function makeFileStore(mockBackend: any, rootStore: any): Promise<any> {
  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  return new FileStore(mockBackend, rootStore);
}

describe('FileStore media-type upstream gate', () => {
  // A mixed fetch: 2 videos, 2 images (order interleaved).
  const mixed = [
    makeFileDTO('v1', 'mp4'),
    makeFileDTO('i1', 'jpg'),
    makeFileDTO('v2', 'webm'),
    makeFileDTO('i2', 'png'),
  ];

  function makeBackend() {
    return {
      fetchFiles: jest.fn().mockResolvedValue(mixed),
      searchFiles: jest.fn(),
      countFiles: jest.fn().mockResolvedValue([0, 0]),
    };
  }

  it('video shows only videos and keeps numTotalFiles at the pre-gate count', async () => {
    const store = await makeFileStore(makeBackend(), makeMockRootStore('video'));
    await store.fetchAllFiles();

    expect(store.fileList.map((f: any) => f.id)).toEqual(['v1', 'v2']);
    // Images were gated out BEFORE filesFromBackend, so no image ClientFile exists.
    expect(store.fileList.some((f: any) => f.extension === 'jpg' || f.extension === 'png')).toBe(
      false,
    );
    // Badge reflects the full pre-gate fetched library size, not the visible 2.
    expect(store.numTotalFiles).toBe(4);
  });

  it('images shows only images and keeps numTotalFiles at the pre-gate count', async () => {
    const store = await makeFileStore(makeBackend(), makeMockRootStore('images'));
    await store.fetchAllFiles();

    expect(store.fileList.map((f: any) => f.id)).toEqual(['i1', 'i2']);
    expect(store.fileList.some((f: any) => f.extension === 'mp4' || f.extension === 'webm')).toBe(
      false,
    );
    expect(store.numTotalFiles).toBe(4);
  });

  it('all shows everything', async () => {
    const store = await makeFileStore(makeBackend(), makeMockRootStore('all'));
    await store.fetchAllFiles();

    expect(store.fileList.map((f: any) => f.id)).toEqual(['v1', 'i1', 'v2', 'i2']);
    expect(store.numTotalFiles).toBe(4);
  });
});
