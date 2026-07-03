/**
 * @jest-environment jsdom
 *
 * Component stale-race tests for the four corruption-risk inspector panels
 * (openspec change: harden-inspector-async-reads):
 *   ImageMap, ImageInfo, ImageDates, ImageDescription.
 *
 * Each panel reads metadata asynchronously into local/editable state inside a
 * `useEffect` keyed on `file.absolutePath`. ExifTool serializes reads, so a read
 * for a previously selected file can resolve AFTER the user switches files. The
 * fix adds a `let cancelled` stale-guard so a late resolution never seeds the
 * current file's fields (which back the write-back path → silent corruption).
 *
 * For each panel we assert:
 *   (a) NORMAL — a read for the selected file seeds the field/inputs.
 *   (b) STALE-RACE — render file A (read pending), switch to file B, resolve B,
 *       then resolve the stale A; the panel shows B's values, NEVER A's.
 *   (c) REJECT — a rejected read is logged and does not throw an unhandled
 *       rejection (and does not seed the field).
 */

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { configure } from 'mobx';

configure({ enforceActions: 'never' });
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Module stubs (hoisted; apply file-wide but only the importing panel is hit).
// ---------------------------------------------------------------------------
jest.mock('../src/ipc/renderer', () => ({
  RendererMessenger: { toggleDevTools: jest.fn() },
}));
jest.mock('../src/frontend/components/Toaster', () => ({
  AppToaster: { show: jest.fn() },
}));
jest.mock('widgets', () => ({ IconSet: new Proxy({}, { get: () => null }) }), { virtual: true });
jest.mock('widgets/icons', () => ({ IconSet: new Proxy({}, { get: () => null }) }), {
  virtual: true,
});
jest.mock('widgets/toolbar', () => ({ Toolbar: () => null, ToolbarButton: () => null }), {
  virtual: true,
});

// ImageMap creates a real Mapbox GL map on mount — impossible in jsdom. Stub the
// Map/Marker constructors with the chained methods the component calls.
jest.mock('mapbox-gl', () => {
  const marker = () => {
    const self: any = {};
    self.setLngLat = () => self;
    self.addTo = () => self;
    self.remove = () => self;
    return self;
  };
  const map = () => {
    const self: any = {};
    self.flyTo = () => self;
    self.remove = () => self;
    return self;
  };
  return {
    __esModule: true,
    default: { Map: jest.fn(map), Marker: jest.fn(marker), accessToken: '' },
  };
});

// ImageDates reads the file's ctime via the platform seam's fs.stat.
jest.mock('../src/frontend/platform', () => ({
  __esModule: true,
  default: {
    fs: { stat: jest.fn().mockResolvedValue({ ctime: new Date(0) }) },
    desktop: { toggleDevTools: jest.fn() },
  },
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const flushAll = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

/** Text of the <td> in the row whose <th> equals `label`, or null if no such row. */
function rowValue(container: HTMLElement, label: string): string | null {
  const th = Array.from(container.querySelectorAll('th')).find((t) => t.textContent === label);
  if (!th) {
    return null;
  }
  return th.parentElement?.querySelector('td')?.textContent ?? null;
}

function makeFile(absolutePath: string, extension = 'jpg') {
  const name = absolutePath.split('/').pop() as string;
  return {
    id: absolutePath,
    name,
    absolutePath,
    extension,
    width: 1920,
    height: 1080,
    size: 1000,
    dateAdded: new Date(0),
    dateCreated: new Date(0),
    thumbnailPath: '',
    dispose: () => undefined,
  } as any;
}

/** Mount a panel component (by module path) into jsdom with the given store. */
async function mountPanel(modulePath: string, store: any, file: any) {
  const { default: StoreProvider } = await import('../src/frontend/contexts/StoreContext');
  const { default: Panel } = await import(modulePath);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const render = async (f: any) => {
    await act(async () => {
      root.render(
        React.createElement(
          StoreProvider,
          { value: store },
          React.createElement(Panel, { file: f }),
        ),
      );
      await flushAll();
    });
  };

  await render(file);
  return { container, root, render };
}

afterEach(() => {
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A batch-read store: readExifTags(path, tags) resolves when the test calls the
// resolver stored under `path`, with a values array in tag order. VideoFrameRate
// single-tag reads (ImageInfo) resolve immediately to undefined.
// ---------------------------------------------------------------------------
function makeBatchStore(withUiStore = false) {
  const resolvers: Record<string, (values: (string | undefined)[]) => void> = {};
  const rejecters: Record<string, (err: any) => void> = {};
  const store: any = {
    exifTool: {
      readAllExifTags: jest.fn().mockResolvedValue({}),
      readExifTags: jest.fn((path: string, tags: string[]) => {
        if (tags.length === 1 && tags[0] === 'VideoFrameRate') {
          return Promise.resolve([undefined]);
        }
        return new Promise<(string | undefined)[]>((resolve, reject) => {
          resolvers[path] = resolve;
          rejecters[path] = reject;
        });
      }),
      writeData: jest.fn().mockResolvedValue(undefined),
    },
  };
  if (withUiStore) {
    store.uiStore = { theme: 'light' };
  }
  return { store, resolvers, rejecters };
}

// ===========================================================================
// ImageMap — GPS fields feed editable inputs + write-back (HIGH corruption risk)
// ExifMap tag order: GPSLatitude is index 0 (row label "Latitude").
// ===========================================================================
describe('ImageMap stale-race', () => {
  const latValues = (lat: string) => [lat]; // only GPSLatitude (index 0) matters here

  test('(a) normal read seeds the Latitude row for the selected file', async () => {
    const { store, resolvers } = makeBatchStore(true);
    const { container } = await mountPanel(
      '../src/frontend/components/ImageMap',
      store,
      makeFile('/photos/a.jpg'),
    );
    await act(async () => {
      resolvers['/photos/a.jpg'](latValues('11.11'));
      await flushAll();
    });
    expect(rowValue(container, 'Latitude')).toBe('11.11');
  });

  test('(b) fast switch never seeds the previous file GPS', async () => {
    const { store, resolvers } = makeBatchStore(true);
    const { container, render } = await mountPanel(
      '../src/frontend/components/ImageMap',
      store,
      makeFile('/photos/a.jpg'),
    );
    // A pending — switch to B before A resolves.
    await render(makeFile('/photos/b.jpg'));
    await act(async () => {
      resolvers['/photos/b.jpg'](latValues('22.22'));
      await flushAll();
    });
    await act(async () => {
      resolvers['/photos/a.jpg'](latValues('11.11')); // stale
      await flushAll();
    });
    expect(rowValue(container, 'Latitude')).toBe('22.22');
    expect(rowValue(container, 'Latitude')).not.toBe('11.11');
  });

  test('(c) a rejected read is logged, not swallowed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, rejecters } = makeBatchStore(true);
    await mountPanel('../src/frontend/components/ImageMap', store, makeFile('/photos/broken.jpg'));
    await act(async () => {
      rejecters['/photos/broken.jpg'](new Error('exiftool is not open'));
      await flushAll();
    });
    expect(warn).toHaveBeenCalledWith(
      '[ImageMap] exif read failed',
      '/photos/broken.jpg',
      expect.any(Error),
    );
  });
});

// ===========================================================================
// ImageInfo — exifStats feed editable inputs + write-back. exifTags order:
// Software is index 0 (row label "Creation Software").
// ===========================================================================
describe('ImageInfo stale-race', () => {
  const softwareValues = (sw: string) => [sw]; // only Software (index 0) matters here

  test('(a) normal read seeds the Creation Software row', async () => {
    const { store, resolvers } = makeBatchStore();
    const { container } = await mountPanel(
      '../src/frontend/components/ImageInfo',
      store,
      makeFile('/photos/a.jpg'),
    );
    await act(async () => {
      resolvers['/photos/a.jpg'](softwareValues('Photoshop-A'));
      await flushAll();
    });
    expect(rowValue(container, 'Creation Software')).toBe('Photoshop-A');
  });

  test('(b) fast switch never seeds the previous file exif', async () => {
    const { store, resolvers } = makeBatchStore();
    const { container, render } = await mountPanel(
      '../src/frontend/components/ImageInfo',
      store,
      makeFile('/photos/a.jpg'),
    );
    await render(makeFile('/photos/b.jpg'));
    await act(async () => {
      resolvers['/photos/b.jpg'](softwareValues('Photoshop-B'));
      await flushAll();
    });
    await act(async () => {
      resolvers['/photos/a.jpg'](softwareValues('Photoshop-A')); // stale
      await flushAll();
    });
    expect(rowValue(container, 'Creation Software')).toBe('Photoshop-B');
    expect(rowValue(container, 'Creation Software')).not.toBe('Photoshop-A');
  });

  test('(c) a rejected read is logged, not swallowed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, rejecters } = makeBatchStore();
    await mountPanel('../src/frontend/components/ImageInfo', store, makeFile('/photos/broken.jpg'));
    await act(async () => {
      rejecters['/photos/broken.jpg'](new Error('exiftool is not open'));
      await flushAll();
    });
    expect(warn).toHaveBeenCalledWith(
      '[ImageInfo] exif read failed',
      '/photos/broken.jpg',
      expect.any(Error),
    );
  });
});

// ===========================================================================
// ImageDates — date fields feed editable inputs + write-back. exifTags order:
// DateCreated is index 0 (row label "DateCreated").
// ===========================================================================
describe('ImageDates stale-race', () => {
  const dateValues = (d: string) => [d]; // only DateCreated (index 0) matters here

  test('(a) normal read seeds the DateCreated row', async () => {
    const { store, resolvers } = makeBatchStore();
    const { container } = await mountPanel(
      '../src/frontend/components/ImageDates',
      store,
      makeFile('/photos/a.jpg'),
    );
    await act(async () => {
      resolvers['/photos/a.jpg'](dateValues('2020:01:01'));
      await flushAll();
    });
    expect(rowValue(container, 'DateCreated')).toBe('2020:01:01');
  });

  test('(b) fast switch never seeds the previous file dates', async () => {
    const { store, resolvers } = makeBatchStore();
    const { container, render } = await mountPanel(
      '../src/frontend/components/ImageDates',
      store,
      makeFile('/photos/a.jpg'),
    );
    await render(makeFile('/photos/b.jpg'));
    await act(async () => {
      resolvers['/photos/b.jpg'](dateValues('2021:02:02'));
      await flushAll();
    });
    await act(async () => {
      resolvers['/photos/a.jpg'](dateValues('2020:01:01')); // stale
      await flushAll();
    });
    expect(rowValue(container, 'DateCreated')).toBe('2021:02:02');
    expect(rowValue(container, 'DateCreated')).not.toBe('2020:01:01');
  });

  test('(c) a rejected read is logged, not swallowed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, rejecters } = makeBatchStore();
    await mountPanel(
      '../src/frontend/components/ImageDates',
      store,
      makeFile('/photos/broken.jpg'),
    );
    await act(async () => {
      rejecters['/photos/broken.jpg'](new Error('exiftool is not open'));
      await flushAll();
    });
    expect(warn).toHaveBeenCalledWith(
      '[ImageDates] exif read failed',
      '/photos/broken.jpg',
      expect.any(Error),
    );
  });
});

// ===========================================================================
// ImageDescription — descriptionValue backs an editable <textarea> + write-back.
// Uses readDescription; keeps its existing toast + console.error on failure.
// ===========================================================================
describe('ImageDescription stale-race', () => {
  function makeDescStore() {
    const resolvers: Record<string, (v: string) => void> = {};
    const rejecters: Record<string, (err: any) => void> = {};
    const store: any = {
      exifTool: {
        readDescription: jest.fn(
          (path: string) =>
            new Promise<string>((resolve, reject) => {
              resolvers[path] = resolve;
              rejecters[path] = reject;
            }),
        ),
        writeData: jest.fn().mockResolvedValue(undefined),
      },
    };
    return { store, resolvers, rejecters };
  }

  const textareaValue = (container: HTMLElement) =>
    (container.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? null;

  test('(a) normal read seeds the textarea', async () => {
    const { store, resolvers } = makeDescStore();
    const { container } = await mountPanel(
      '../src/frontend/components/ImageDescription',
      store,
      makeFile('/photos/a.jpg'),
    );
    await act(async () => {
      resolvers['/photos/a.jpg']('desc A');
      await flushAll();
    });
    expect(textareaValue(container)).toBe('desc A');
  });

  test('(b) fast switch never seeds the previous file description', async () => {
    const { store, resolvers } = makeDescStore();
    const { container, render } = await mountPanel(
      '../src/frontend/components/ImageDescription',
      store,
      makeFile('/photos/a.jpg'),
    );
    await render(makeFile('/photos/b.jpg'));
    await act(async () => {
      resolvers['/photos/b.jpg']('desc B');
      await flushAll();
    });
    await act(async () => {
      resolvers['/photos/a.jpg']('desc A'); // stale
      await flushAll();
    });
    expect(textareaValue(container)).toBe('desc B');
    expect(textareaValue(container)).not.toBe('desc A');
  });

  test('(c) a rejected read is logged, not swallowed', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store, rejecters } = makeDescStore();
    const { container } = await mountPanel(
      '../src/frontend/components/ImageDescription',
      store,
      makeFile('/photos/broken.jpg'),
    );
    await act(async () => {
      rejecters['/photos/broken.jpg'](new Error('exiftool is not open'));
      await flushAll();
    });
    expect(error).toHaveBeenCalledWith(expect.any(Error));
    expect(textareaValue(container)).toBe('');
  });
});
