/**
 * Tests for `viewer-file-anchoring` (video-viewer-index-lock).
 *
 * The slide-mode viewer resolves its displayed file by a stable identity anchor
 * (`UiStore.slideFileId`) rather than by the numeric `firstItem` index. These
 * store-level tests exercise the invariant directly against a real UiStore:
 *
 *   4.1 A re-sort/replace of fileList (file moves index) does not change slideFile.
 *   4.2 Inserting a file ahead of the anchored file does not change slideFile.
 *   4.3 Removing the anchored file makes slideFile undefined (no silent swap).
 *   4.4 Prev/next re-anchors slideFileId + firstItem; navigation is bounded.
 *   4.5 setSlideFile deliberately re-anchors to an arbitrary target file.
 *
 * A real `UiStore` is used so `slideFile` (a @computed getter), `setSlideFile`,
 * `enableSlideMode`, and `slideFileId` are exercised as shipped. The FileStore is
 * a lightweight fake that faithfully implements the only surface the anchor logic
 * touches — `fileList`, `getIndex`, `get`, and an id→index map kept in lockstep —
 * mirroring the real FileStore's O(1) `index` map. This avoids constructing the
 * full FileStore + backend graph while covering the exact resolution path.
 *
 * The prev/next navigation handlers themselves live in the SlideMode component;
 * we replicate their small anchor-relative index math here (the same logic the
 * component runs) so the store contract they depend on is verified end-to-end.
 */

import { configure } from 'mobx';

configure({ enforceActions: 'never' });

// Neutralise the platform seam so importing UiStore does not pull the
// Electron/native import graph (same pattern as ui-store-video-spacebar.test.ts).
jest.mock('src/frontend/platform', () => ({ __esModule: true, default: {} }));

import UiStore from '../src/frontend/stores/UiStore';

// ---------------------------------------------------------------------------
// Fake file + fake FileStore
// ---------------------------------------------------------------------------

interface FakeFile {
  id: string;
  extension: string;
  absolutePath: string;
}

function makeFile(id: string, extension = 'mp4'): FakeFile {
  return { id, extension, absolutePath: `/photos/${id}.${extension}` };
}

/**
 * Minimal FileStore stand-in: maintains `fileList` plus an id→index Map rebuilt
 * on every mutation, exactly like the real FileStore keeps `index` in lockstep.
 */
function makeFakeFileStore(initial: FakeFile[]) {
  let fileList = initial.slice();
  let index = new Map<string, number>();
  const rebuild = () => {
    index = new Map(fileList.map((f, i) => [f.id, i]));
  };
  rebuild();
  return {
    get fileList() {
      return fileList as any[];
    },
    getIndex(id: string): number | undefined {
      return index.get(id);
    },
    get(id: string): any | undefined {
      const i = index.get(id);
      return i !== undefined ? fileList[i] : undefined;
    },
    /** Replace the whole list (simulates a re-sort/refetch). */
    _replaceList(next: FakeFile[]) {
      fileList = next.slice();
      rebuild();
    },
    /** Insert a file at a position (simulates media-job ingest). */
    _insertAt(file: FakeFile, at: number) {
      fileList = [...fileList.slice(0, at), file, ...fileList.slice(at)];
      rebuild();
    },
    /** Remove a file by id (simulates delete / filter-out). */
    _remove(id: string) {
      const i = index.get(id);
      if (i !== undefined) {
        fileList = [...fileList.slice(0, i), ...fileList.slice(i + 1)];
        rebuild();
      }
    },
  };
}

function makeUiStore(files: FakeFile[]): { uiStore: UiStore; fileStore: ReturnType<typeof makeFakeFileStore> } {
  const fileStore = makeFakeFileStore(files);
  const rootStore = { fileStore } as any;
  const uiStore = new UiStore(rootStore);
  return { uiStore, fileStore };
}

/**
 * Replicates the SlideMode component's prev/next index math (task 2.1): move
 * relative to the anchored file's current index (falling back to firstItem when
 * the anchor is gone), clamp to list bounds, then re-anchor via setSlideFile.
 */
function navigate(
  uiStore: UiStore,
  fileStore: ReturnType<typeof makeFakeFileStore>,
  dir: 1 | -1,
): void {
  const anchorIndex =
    uiStore.slideFileId !== undefined ? fileStore.getIndex(uiStore.slideFileId) : undefined;
  const current = anchorIndex ?? uiStore.firstItem;
  const target =
    dir === 1
      ? Math.min(current + 1, fileStore.fileList.length - 1)
      : Math.max(0, current - 1);
  const file = fileStore.fileList[target];
  if (file) {
    uiStore.setSlideFile(file as any);
  }
}

/** Enter slide mode anchored on the file at `index` (mirrors the preview flow). */
function openSlideOn(uiStore: UiStore, index: number): void {
  uiStore.setFirstItem(index);
  uiStore.enableSlideMode();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('viewer-file-anchoring: slideFile resolves by identity', () => {
  it('4.1 re-sort that moves the anchored file to a new index does not change slideFile', () => {
    const files = ['a', 'b', 'c', 'd'].map((id) => makeFile(id));
    const { uiStore, fileStore } = makeUiStore(files);

    openSlideOn(uiStore, 1); // anchor on 'b'
    expect(uiStore.slideFile?.id).toBe('b');

    // Reverse the list: 'b' moves from index 1 to index 2.
    fileStore._replaceList(['d', 'c', 'b', 'a'].map((id) => makeFile(id)));
    expect(fileStore.getIndex('b')).toBe(2);

    // Viewer still shows 'b' — the numeric index changed but identity did not.
    expect(uiStore.slideFile?.id).toBe('b');
  });

  it('4.2 inserting a file ahead of the anchored file does not change slideFile', () => {
    const files = ['a', 'b', 'c'].map((id) => makeFile(id));
    const { uiStore, fileStore } = makeUiStore(files);

    openSlideOn(uiStore, 1); // anchor on 'b' (index 1)
    expect(uiStore.slideFile?.id).toBe('b');

    // A media job completes: its output 'new' is ingested at the head.
    fileStore._insertAt(makeFile('new'), 0);
    expect(fileStore.getIndex('b')).toBe(2); // 'b' pushed to index 2

    // The user's open file is untouched.
    expect(uiStore.slideFile?.id).toBe('b');
  });

  it('4.3 removing the anchored file makes slideFile undefined (no silent swap)', () => {
    const files = ['a', 'b', 'c'].map((id) => makeFile(id));
    const { uiStore, fileStore } = makeUiStore(files);

    openSlideOn(uiStore, 1); // anchor on 'b'
    expect(uiStore.slideFile?.id).toBe('b');

    // Delete 'b'. The file now at the old index 1 is 'c' — the viewer must NOT
    // surface it; slideFile resolves to undefined (explicit empty state).
    fileStore._remove('b');
    expect(fileStore.fileList[1]?.id).toBe('c');
    expect(uiStore.slideFile).toBeUndefined();
  });

  it('4.4 prev/next re-anchors slideFileId + firstItem and is bounded at the ends', () => {
    const files = ['a', 'b', 'c'].map((id) => makeFile(id));
    const { uiStore, fileStore } = makeUiStore(files);

    openSlideOn(uiStore, 0); // anchor on 'a'
    expect(uiStore.slideFileId).toBe('a');
    expect(uiStore.firstItem).toBe(0);

    navigate(uiStore, fileStore, 1); // -> 'b'
    expect(uiStore.slideFileId).toBe('b');
    expect(uiStore.firstItem).toBe(1);
    expect(uiStore.slideFile?.id).toBe('b');

    navigate(uiStore, fileStore, 1); // -> 'c' (last)
    expect(uiStore.slideFileId).toBe('c');
    expect(uiStore.firstItem).toBe(2);

    // Next at the last item stays on the last item (bounded, no wrap/error).
    navigate(uiStore, fileStore, 1);
    expect(uiStore.slideFileId).toBe('c');
    expect(uiStore.firstItem).toBe(2);

    // Prev at the first item stays on the first item.
    openSlideOn(uiStore, 0); // re-anchor on 'a'
    navigate(uiStore, fileStore, -1);
    expect(uiStore.slideFileId).toBe('a');
    expect(uiStore.firstItem).toBe(0);
  });

  it('4.4b missing-anchor fallback: navigation steps relative to firstItem from the empty state', () => {
    const files = ['a', 'b', 'c'].map((id) => makeFile(id));
    const { uiStore, fileStore } = makeUiStore(files);

    openSlideOn(uiStore, 1); // anchor on 'b', firstItem = 1
    fileStore._remove('b'); // anchor gone -> empty state; firstItem retained at 1
    expect(uiStore.slideFile).toBeUndefined();

    // fileList is now ['a', 'c']; firstItem is 1 ('c'). Next falls back to
    // firstItem-relative stepping — from index 1, next clamps to the last item.
    navigate(uiStore, fileStore, 1);
    expect(uiStore.slideFile?.id).toBe('c');

    // From 'c' (index 1), prev steps to 'a' — the user escaped the empty state.
    navigate(uiStore, fileStore, -1);
    expect(uiStore.slideFile?.id).toBe('a');
  });

  it('4.5 setSlideFile deliberately re-anchors to an arbitrary target file', () => {
    const files = ['a', 'b', 'c', 'd'].map((id) => makeFile(id));
    const { uiStore, fileStore } = makeUiStore(files);

    openSlideOn(uiStore, 0); // anchor on 'a'
    expect(uiStore.slideFile?.id).toBe('a');

    // A deliberate "show in viewer" retarget to 'd' (not adjacent, not churn).
    uiStore.setSlideFile(fileStore.fileList[3] as any);
    expect(uiStore.slideFileId).toBe('d');
    expect(uiStore.firstItem).toBe(3);
    expect(uiStore.slideFile?.id).toBe('d');
  });

  it('disableSlideMode clears the anchor and slideFile falls back to firstFileInView', () => {
    const files = ['a', 'b', 'c'].map((id) => makeFile(id));
    const { uiStore } = makeUiStore(files);

    openSlideOn(uiStore, 2); // anchor on 'c'
    expect(uiStore.slideFileId).toBe('c');

    uiStore.disableSlideMode();
    expect(uiStore.slideFileId).toBeUndefined();
    // Outside slide mode slideFile tracks firstFileInView (grid behavior).
    expect(uiStore.slideFile?.id).toBe('c'); // firstItem still 2 -> 'c'
  });
});
