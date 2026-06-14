/**
 * @jest-environment jsdom
 *
 * INV-023 — GUI-level test of the sub-process flow.
 *
 * This renders the REAL <ImageTools> inspector component (the one that owns the
 * "Re-encode (x264)" button) into jsdom, wires it to a REAL UiStore + REAL
 * FileStore, and dispatches a REAL click on the Re-encode button. It then drives
 * the (IPC-mocked) ffmpeg completion and asserts the user-visible result:
 *
 *   - while the job runs, the inspector shows the progress / "Finalizing…" UI and
 *     navigation is blocked (isMediaProcessing true; disableSlideMode is a no-op);
 *   - when ffmpeg finishes, the viewer's file (slideFile) swaps from the source to
 *     the output, SlideMode stays open the whole time (never the grid), and the
 *     delete-original prompt opens for the source afterwards.
 *
 * It executes the literal user action (clicking the button) and checks the
 * rendered DOM + the observable state the renderer binds to. ffmpeg itself is
 * mocked (no binary in CI); the per-tool tag-copy (req 3) is covered exhaustively
 * by tests/sub-process-viewer-pin.test.ts.
 */

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { configure } from 'mobx';
import { FileDTO } from '../src/api/file';

configure({ enforceActions: 'never' });
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// --- Mock the IPC layer (imports electron) and the Toaster (touches window) ---
const startMediaJobMock = jest.fn();
jest.mock('../src/ipc/renderer', () => ({
  RendererMessenger: {
    startMediaJob: (...args: any[]) => startMediaJobMock(...args),
    onMediaJobProgress: jest.fn(() => jest.fn()), // returns an unsubscribe fn
    cancelMediaJob: jest.fn(),
    toggleDevTools: jest.fn(),
  },
}));
jest.mock('../src/frontend/components/Toaster', () => ({ AppToaster: { show: jest.fn() } }));
// `import { IconSet } from 'widgets'` is a bare specifier (the jest alias only maps `widgets/*`)
// and the real IconSet pulls in SVG assets; ImageTools only needs IconSet, so virtual-mock it.
jest.mock('widgets', () => ({ IconSet: new Proxy({}, { get: () => null }) }), { virtual: true });

function makeFileDTO(id: string, absolutePath: string, extension: FileDTO['extension']): FileDTO {
  return {
    id,
    absolutePath,
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
  };
}

const flushAll = async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

async function setup() {
  const srcDto = makeFileDTO('src', 'C:/photos/src.mp4', 'mp4');
  const outDto = makeFileDTO('out', 'C:/photos/out.mp4', 'mp4');

  // refetch() reads this live; we add the output to it just before ffmpeg "finishes".
  let currentFiles: FileDTO[] = [srcDto];
  const backend: any = {
    fetchFiles: jest.fn().mockImplementation(() => Promise.resolve(currentFiles)),
    searchFiles: jest.fn().mockResolvedValue([]),
    countFiles: jest.fn().mockResolvedValue([0, 0]),
    fetchFilesByKey: jest.fn().mockResolvedValue([outDto]),
    saveFiles: jest.fn().mockResolvedValue(undefined),
  };

  const { default: FileStore } = await import('../src/frontend/stores/FileStore');
  const { default: UiStore } = await import('../src/frontend/stores/UiStore');
  const rootStore: any = {
    tagStore: { tagList: [], get: jest.fn(() => undefined) },
    imageLoader: { needsThumbnail: jest.fn(() => false) },
    exifTool: { writeTags: jest.fn().mockResolvedValue(undefined) },
    locationStore: { get: jest.fn(() => ({ id: 'loc1', name: 'Test', path: '/photos' })) },
  };
  const fileStore = new FileStore(backend, rootStore);
  const uiStore = new UiStore(rootStore);
  uiStore.hideMissingFilesInBrowsing = false;
  rootStore.fileStore = fileStore;
  rootStore.uiStore = uiStore;

  await fileStore.fetchAllFiles(); // fileList = [src]
  uiStore.isSlideMode = true;
  uiStore.setFirstItem(0); // viewing the source in SlideMode
  const src = fileStore.fileList[0];

  return {
    rootStore,
    fileStore,
    uiStore,
    src,
    revealOutput: () => {
      currentFiles = [outDto, srcDto];
    },
  };
}

describe('INV-023 GUI: clicking Re-encode keeps the viewer pinned and swaps to the output', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const queryButton = (re: RegExp): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((b) =>
      re.test(b.textContent || ''),
    ) as HTMLButtonElement | undefined;

  it('executes the click, blocks navigation during the job, then swaps source -> output', async () => {
    const StoreProvider = (await import('../src/frontend/contexts/StoreContext')).default;
    const { default: ImageTools } = await import('../src/frontend/components/ImageTools');
    const { rootStore, uiStore, src, revealOutput } = await setup();

    // Hold ffmpeg open so we can observe the in-flight state.
    let finishFfmpeg!: (v: { outputPath: string }) => void;
    startMediaJobMock.mockReturnValue(
      new Promise<{ outputPath: string }>((resolve) => {
        finishFfmpeg = resolve;
      }),
    );

    act(() => {
      root.render(
        React.createElement(StoreProvider, { value: rootStore }, React.createElement(ImageTools, { file: src })),
      );
    });

    // Idle: the Re-encode button is present and the source is the viewed file.
    expect(queryButton(/Re-encode \(x264\)/)).toBeTruthy();
    expect(uiStore.slideFile?.id).toBe('src');

    // --- The literal user action: click "Re-encode (x264)" ---
    await act(async () => {
      queryButton(/Re-encode \(x264\)/)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Job running: progress UI shown, the action buttons are gone, navigation is locked.
    expect(uiStore.isMediaProcessing).toBe(true); // req 1: lock held
    expect(container.textContent).toMatch(/Re-encoding|Finalizing/);
    expect(queryButton(/Re-encode \(x264\)/)).toBeFalsy(); // can't re-trigger / leave
    uiStore.disableSlideMode(); // Back / Esc / popstate all funnel here...
    expect(uiStore.isSlideMode).toBe(true); // ...and are no-ops mid-job
    expect(uiStore.slideFile?.id).toBe('src'); // still showing the source

    // --- ffmpeg finishes; the watcher's output becomes visible; finalize runs ---
    revealOutput();
    await act(async () => {
      finishFfmpeg({ outputPath: 'C:\\photos\\out.mp4' });
      await flushAll();
    });

    // Seamless swap: the viewer's file is now the OUTPUT, SlideMode never closed,
    // the lock is released, and the delete-original prompt is open for the SOURCE.
    expect(uiStore.slideFile?.id).toBe('out'); // req 2: switched source -> destination
    expect(uiStore.isSlideMode).toBe(true); // never dropped to the grid
    expect(uiStore.isMediaProcessing).toBe(false); // lock released in finally
    expect(uiStore.mediaProcessingFile).toBeNull(); // pin handed back cleanly
    expect(uiStore.deleteOriginalAfterJobFile).toBe(src); // prompt after the swap
    // Inspector is back to its tools view for the now-open output.
    expect(queryButton(/Re-encode \(x264\)/)).toBeTruthy();
  });

  it('shows the failure modal state and keeps the source when ffmpeg errors', async () => {
    const StoreProvider = (await import('../src/frontend/contexts/StoreContext')).default;
    const { default: ImageTools } = await import('../src/frontend/components/ImageTools');
    const { rootStore, uiStore, src } = await setup();

    startMediaJobMock.mockRejectedValue(new Error('ffmpeg exited with code 1.\nInvalid data found'));

    act(() => {
      root.render(
        React.createElement(StoreProvider, { value: rootStore }, React.createElement(ImageTools, { file: src })),
      );
    });

    await act(async () => {
      queryButton(/Re-encode \(x264\)/)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushAll();
    });

    // req 4: a modal is requested (mediaJobError set), the source is kept on screen,
    // the lock is released, and NO delete prompt is shown.
    expect(uiStore.mediaJobError).toEqual({
      tool: 'Re-encode',
      message: expect.stringContaining('ffmpeg exited with code 1'),
    });
    expect(uiStore.slideFile?.id).toBe('src');
    expect(uiStore.isSlideMode).toBe(true);
    expect(uiStore.isMediaProcessing).toBe(false);
    expect(uiStore.deleteOriginalAfterJobFile).toBeNull();
  });
});
