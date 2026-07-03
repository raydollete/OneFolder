/**
 * @jest-environment jsdom
 *
 * Component tests for <ImageInfo> frame-rate readout (change: fix-video-fps-display).
 *
 * Renders the REAL <ImageInfo> into jsdom with a minimal store whose
 * exifTool.readExifTags is hand-controlled, and asserts:
 *   (a) a video with a frame rate shows a "Frame Rate" row (`29.97 fps`) directly
 *       below "Dimensions", and Dimensions is just "W x H";
 *   (b) an image / a video with no VideoFrameRate shows no "Frame Rate" row;
 *   (c) STALE-RACE: switching files before the first read resolves never shows the
 *       first file's value;
 *   (d) a rejected read shows no row and does not throw an unhandled rejection.
 */

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { configure } from 'mobx';

configure({ enforceActions: 'never' });
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../src/ipc/renderer', () => ({
  RendererMessenger: { toggleDevTools: jest.fn() },
}));
jest.mock('../src/frontend/components/Toaster', () => ({
  AppToaster: { show: jest.fn() },
}));
jest.mock('widgets', () => ({ IconSet: new Proxy({}, { get: () => null }) }), { virtual: true });

const flushAll = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

// Per-test implementation for the VideoFrameRate read. Returns the raw ExifTool
// value (string) or undefined. Overridden inside each test.
let frameImpl: (path: string) => Promise<string | undefined> = async () => undefined;

function makeStore() {
  return {
    exifTool: {
      readAllExifTags: jest.fn().mockResolvedValue({}),
      // ImageInfo issues two kinds of readExifTags: the single-tag VideoFrameRate
      // read (routed through frameImpl) and the larger stats batch (undefineds).
      readExifTags: jest.fn((_path: string, tags: string[]) => {
        if (tags.length === 1 && tags[0] === 'VideoFrameRate') {
          // Real readExifTags resolves to a (string|undefined)[]; wrap the value.
          return Promise.resolve(frameImpl(_path)).then((v) => [v]);
        }
        return Promise.resolve(tags.map(() => undefined));
      }),
      writeData: jest.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function makeFile(absolutePath: string, extension: string) {
  const name = absolutePath.split('/').pop() as string;
  return {
    id: absolutePath,
    name,
    absolutePath,
    extension,
    width: 1920,
    height: 1080,
    size: 1000,
  } as any;
}

async function renderInfo(store: any, file: any) {
  const { default: StoreProvider } = await import('../src/frontend/contexts/StoreContext');
  const { default: ImageInfo } = await import('../src/frontend/components/ImageInfo');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const render = async (f: any) => {
    await act(async () => {
      root.render(
        React.createElement(
          StoreProvider,
          { value: store },
          React.createElement(ImageInfo, { file: f }),
        ),
      );
      await flushAll();
    });
  };

  await render(file);
  return { container, root, render };
}

/** Text of the <td> in the row whose <th> equals `label`, or null if no such row. */
function rowValue(container: HTMLElement, label: string): string | null {
  const th = Array.from(container.querySelectorAll('th')).find((t) => t.textContent === label);
  if (!th) {
    return null;
  }
  return th.parentElement?.querySelector('td')?.textContent ?? null;
}

afterEach(() => {
  document.body.innerHTML = '';
  frameImpl = async () => undefined;
  jest.restoreAllMocks();
});

test('(a) video with a frame rate shows a Frame Rate row below Dimensions', async () => {
  frameImpl = async () => '29.970030';
  const store = makeStore();
  const { container } = await renderInfo(store, makeFile('/videos/a.mp4', 'mp4'));

  expect(rowValue(container, 'Dimensions')).toBe('1920 x 1080');
  expect(rowValue(container, 'Frame Rate')).toBe('29.97 fps');

  // Frame Rate row must be directly below the Dimensions row.
  const labels = Array.from(container.querySelectorAll('th')).map((t) => t.textContent);
  expect(labels.indexOf('Frame Rate')).toBe(labels.indexOf('Dimensions') + 1);
});

test('(b) image and frame-rate-less video show no Frame Rate row', async () => {
  // Image: query returns undefined (not a video anyway).
  frameImpl = async () => undefined;
  const imgStore = makeStore();
  const img = await renderInfo(imgStore, makeFile('/photos/p.jpg', 'jpg'));
  expect(rowValue(img.container, 'Dimensions')).toBe('1920 x 1080');
  expect(rowValue(img.container, 'Frame Rate')).toBeNull();
  // A non-video must not even trigger the frame-rate read.
  const videoReads = imgStore.exifTool.readExifTags.mock.calls.filter(
    (c: any[]) => c[1].length === 1 && c[1][0] === 'VideoFrameRate',
  );
  expect(videoReads.length).toBe(0);

  // Video that reports no frame rate: read runs, returns undefined, no row.
  frameImpl = async () => undefined;
  const vidStore = makeStore();
  const vid = await renderInfo(vidStore, makeFile('/videos/silent.mp4', 'mp4'));
  expect(rowValue(vid.container, 'Frame Rate')).toBeNull();
});

test('(c) rapid file switch never shows the previous file stale frame rate', async () => {
  const resolvers: Record<string, (v: string | undefined) => void> = {};
  frameImpl = (path: string) => new Promise((resolve) => (resolvers[path] = resolve));

  const store = makeStore();
  const { container, render } = await renderInfo(store, makeFile('/videos/a.mp4', 'mp4'));
  // A's read is still pending — switch to B before it resolves.
  await render(makeFile('/videos/b.mp4', 'mp4'));

  // Resolve B first (60fps), then the stale A (24fps).
  await act(async () => {
    resolvers['/videos/b.mp4']('60');
    await flushAll();
  });
  await act(async () => {
    resolvers['/videos/a.mp4']('24');
    await flushAll();
  });

  // Must show B's value, never A's.
  expect(rowValue(container, 'Frame Rate')).toBe('60 fps');
  expect(rowValue(container, 'Frame Rate')).not.toBe('24 fps');
});

test('(d) a rejected read shows no row and is logged, not swallowed', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  frameImpl = async () => {
    throw new Error('exiftool is not open');
  };
  const store = makeStore();
  const { container } = await renderInfo(store, makeFile('/videos/broken.mp4', 'mp4'));

  expect(rowValue(container, 'Frame Rate')).toBeNull();
  expect(warn).toHaveBeenCalledWith(
    '[ImageInfo] frame-rate read failed',
    '/videos/broken.mp4',
    expect.any(Error),
  );
});
