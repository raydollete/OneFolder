/**
 * @jest-environment jsdom
 *
 * INV-028 Defect C — selection-scroll effect identity gate.
 *
 * Tests that the VirtualizedRenderer selection-scroll useLayoutEffect fires on a
 * REAL selection change (different file identity) but NOT on a count-only refetch
 * where the selected file's id is unchanged.
 *
 * Exercises the TASK-107 fix: the effect is keyed on `lastSelId` (identity) rather
 * than on `lastSelIndex` (a clamped value that changes whenever numImages changes).
 *
 * The component's scrollToIndex calls scrollAnchor.scrollIntoView; we spy on
 * HTMLElement.prototype.scrollIntoView to detect when a scroll was issued.
 */

import React, { createRef, MutableRefObject } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { configure, observable, runInAction } from 'mobx';

configure({ enforceActions: 'never' });
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// RendererMessenger / Toaster / widgets — same mocks as sub-process-imagetools-dom.test.tsx
jest.mock('../src/ipc/renderer', () => ({
  RendererMessenger: {
    startMediaJob: jest.fn(),
    commitMediaJob: jest.fn(),
    onMediaJobProgress: jest.fn(() => jest.fn()),
    cancelMediaJob: jest.fn(),
    toggleDevTools: jest.fn(),
  },
}));
jest.mock('../src/frontend/components/Toaster', () => ({ AppToaster: { show: jest.fn() } }));
jest.mock('widgets', () => ({ IconSet: new Proxy({}, { get: () => null }) }), { virtual: true });
// VirtualizedRenderer imports MasonryCell/GalleryItem which pulls in thumbnails and workers;
// those are expensive and not needed here. Mock the GalleryItem module to render nothing.
jest.mock('../src/frontend/containers/ContentView/GalleryItem', () => ({
  MasonryCell: () => null,
}));
// useMountState is a lightweight hook — let it run. layout-helpers is pure math — let it run.

// ---------------------------------------------------------------------------
// Minimal ClientFile-like objects with stable observable ids
// ---------------------------------------------------------------------------

function makeImage(id: string): any {
  return observable({
    id,
    absolutePath: `/photos/${id}.jpg`,
    extension: 'jpg',
    name: `${id}.jpg`,
    isBroken: false,
    tags: new Set(),
  });
}

// ---------------------------------------------------------------------------
// Minimal Layouter — maps index → [width, height, top, left] transform
// ---------------------------------------------------------------------------

const flatLayout = {
  getTransform: (i: number) => [100, 100, i * 110, 0] as [number, number, number, number],
};

// ---------------------------------------------------------------------------
// Minimal store factory — only exposes the surfaces VirtualizedRenderer reads
// ---------------------------------------------------------------------------

function makeMinimalStore(images: any[]): any {
  // fileSelection is a MobX observable Set so the component can observe .size
  const fileSelection = observable.set<any>([]);

  const uiStore: any = observable({
    firstItem: 0,
    isSlideMode: false,
    fileSelection,
    get fileSelectionSize() {
      return fileSelection.size;
    },
    setFirstItem(i: number = 0) {
      this.firstItem = i;
    },
  });

  const fileStore: any = observable({
    fileList: observable.array(images),
  });

  return {
    uiStore,
    fileStore,
    // other stores VirtualizedRenderer does not read directly
    tagStore: { tagList: [] },
    imageLoader: { needsThumbnail: () => false },
  };
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

async function renderVirtualized(
  store: any,
  images: any[],
  lastSelectionIndex: MutableRefObject<number | undefined>,
  layoutUpdateDate: Date,
): Promise<Root> {
  const StoreProvider = (await import('../src/frontend/contexts/StoreContext')).default;
  const { default: VirtualizedRenderer } = await import(
    '../src/frontend/containers/ContentView/Masonry/VirtualizedRenderer'
  );

  let root!: Root;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(
      React.createElement(
        StoreProvider,
        { value: store },
        React.createElement(VirtualizedRenderer, {
          containerHeight: 600,
          containerWidth: 800,
          images,
          layout: flatLayout as any,
          layoutUpdateDate,
          lastSelectionIndex,
          padding: 0,
          overscan: 0,
        }),
      ),
    );
  });

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VirtualizedRenderer selection-scroll effect identity gate (INV-028 Defect C, TASK-107)', () => {
  // scrollIntoView is not defined in jsdom; we define a mock on the prototype so we can
  // spy on and count calls from scrollToIndex inside VirtualizedRenderer.
  let scrollIntoViewMock: jest.Mock;

  beforeAll(() => {
    scrollIntoViewMock = jest.fn();
    // Define the method on the prototype so jest.spyOn can find it.
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  });

  beforeEach(() => {
    scrollIntoViewMock.mockClear();
  });

  afterEach(() => {
    // Clean up all roots rendered into the body
    document.body.innerHTML = '';
  });

  /**
   * 2a — Count-only refetch does NOT re-scroll the selection.
   *
   * Establish a selection, let the initial effects settle, clear the spy, then
   * re-render with MORE images but the SAME selected file's identity.
   * The selection-scroll effect must NOT fire again.
   */
  it('does NOT re-scroll when numImages changes but selected file identity is unchanged', async () => {
    // Start with 3 images; file at index 1 is selected.
    const f0 = makeImage('f0');
    const f1 = makeImage('f1');
    const f2 = makeImage('f2');
    const images = [f0, f1, f2];

    const lastSelectionIndex: MutableRefObject<number | undefined> = createRef() as any;
    lastSelectionIndex.current = 1; // f1 is the "last selected"

    const store = makeMinimalStore(images);

    // Add f1 to the selection so fileSelectionSize > 0
    runInAction(() => {
      store.uiStore.fileSelection.add(f1);
    });

    const layoutUpdateDate = new Date(1000);
    const root = await renderVirtualized(store, images, lastSelectionIndex, layoutUpdateDate);

    // Let initial effects settle (layout-restore + selection-scroll both fire on mount).
    await act(async () => {
      await Promise.resolve();
    });

    // Clear the spy — we only care about re-fires AFTER mount.
    scrollIntoViewMock.mockClear();

    // COUNT-ONLY refetch: add a 4th image to the list. The selected file (f1, index 1)
    // is still present and still selected — only numImages changed.
    const f3 = makeImage('f3');
    const newImages = [f0, f1, f2, f3]; // f1 still at index 1

    // Re-render with the new images array (simulating what MasonryRenderer passes down
    // after fileListLastModified bumps and the layout recomputes).
    const StoreProvider = (await import('../src/frontend/contexts/StoreContext')).default;
    const { default: VirtualizedRenderer } = await import(
      '../src/frontend/containers/ContentView/Masonry/VirtualizedRenderer'
    );
    await act(async () => {
      root.render(
        React.createElement(
          StoreProvider,
          { value: store },
          React.createElement(VirtualizedRenderer, {
            containerHeight: 600,
            containerWidth: 800,
            images: newImages,
            layout: flatLayout as any,
            layoutUpdateDate, // same layout date — no layout-restore scroll
            lastSelectionIndex,
            padding: 0,
            overscan: 0,
          }),
        ),
      );
      await Promise.resolve();
    });

    // The selection-scroll effect must NOT have fired:
    // f1's id ('f1') is the same as before → prevSelKeyRef.current === lastSelId → skip scrollToIndex.
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    // Cleanup
    act(() => root.unmount());
  });

  /**
   * 2b — A REAL selection change DOES scroll.
   *
   * After establishing a selection at f1, simulate a cursor-key navigation event:
   * lastSelectionIndex moves from 1 (f1) to 2 (f2), which is a different file identity.
   * The selection-scroll effect must fire for the new index.
   */
  it('DOES scroll when the selection moves to a different file (real navigation)', async () => {
    const f0 = makeImage('f0');
    const f1 = makeImage('f1');
    const f2 = makeImage('f2');
    const images = [f0, f1, f2];

    const lastSelectionIndex: MutableRefObject<number | undefined> = createRef() as any;
    lastSelectionIndex.current = 1; // f1 selected initially

    const store = makeMinimalStore(images);
    runInAction(() => {
      store.uiStore.fileSelection.add(f1);
    });

    const layoutUpdateDate = new Date(2000);
    const root = await renderVirtualized(store, images, lastSelectionIndex, layoutUpdateDate);

    await act(async () => {
      await Promise.resolve();
    });

    // Clear spy after mount effects settle.
    scrollIntoViewMock.mockClear();

    // Navigate: update selection to f2 (different identity).
    lastSelectionIndex.current = 2; // now pointing at f2
    await act(async () => {
      runInAction(() => {
        store.uiStore.fileSelection.clear();
        store.uiStore.fileSelection.add(f2);
      });
    });

    // Re-render with the same images array but the store's fileSelection changed.
    const StoreProvider = (await import('../src/frontend/contexts/StoreContext')).default;
    const { default: VirtualizedRenderer } = await import(
      '../src/frontend/containers/ContentView/Masonry/VirtualizedRenderer'
    );
    await act(async () => {
      root.render(
        React.createElement(
          StoreProvider,
          { value: store },
          React.createElement(VirtualizedRenderer, {
            containerHeight: 600,
            containerWidth: 800,
            images,
            layout: flatLayout as any,
            layoutUpdateDate,
            lastSelectionIndex,
            padding: 0,
            overscan: 0,
          }),
        ),
      );
      await Promise.resolve();
    });

    // The selection moved to a different file (f1→f2): scrollToIndex should have fired.
    expect(scrollIntoViewMock).toHaveBeenCalled();

    act(() => root.unmount());
  });
});
