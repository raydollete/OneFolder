/**
 * @jest-environment jsdom
 *
 * Gallery badge (change: support-mov-playback, task 1.6): the "Not playable"
 * lozenge renders over the gallery thumbnail ONLY when the stored codec facts
 * derive an `unplayable` verdict — never for playable or unprobed rows.
 * Conventions follow tests/image-info-frame-rate-dom.test.tsx.
 */

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { configure } from 'mobx';

configure({ enforceActions: 'never' });
// React 18 act() harness flag — must be set before any render; the global is
// not declared in this repo's typings, hence the one-off unchecked cast.
const reactActGlobal = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../src/ipc/renderer', () => ({
  RendererMessenger: { toggleDevTools: jest.fn() },
}));
jest.mock('../src/frontend/components/Toaster', () => ({
  AppToaster: { show: jest.fn() },
}));
// Raw .svg imports inside the icon barrel cannot run under jest.
jest.mock(
  'widgets/icons',
  () => ({
    IconSet: new Proxy({}, { get: () => null }),
    SVG: () => null,
  }),
  { virtual: true },
);
// The bare `widgets` barrel is not resolvable under jest's module map
// (only `widgets/*` is aliased). Serve the REAL Tag so the test asserts the
// actual widgets markup; stub the icon-dependent remainder.
jest.mock(
  'widgets',
  () => {
    const { Tag } = jest.requireActual('../widgets/tag');
    return {
      Tag,
      IconButton: () => null,
      IconSet: new Proxy({}, { get: () => null }),
    };
  },
  { virtual: true },
);
// Commands → menu-items → LocationsPanel pulls in LocationStore/entities/Location
// (webpack-only `import.meta` worker URLs that ts-jest cannot compile). The
// badge renders none of these menu components, so stub the whole module.
jest.mock(
  '../src/frontend/containers/ContentView/menu-items',
  () => new Proxy({}, { get: () => () => null }),
);

import { UnplayableBadge } from '../src/frontend/containers/ContentView/GalleryItem';
import { ClientFile } from '../src/frontend/entities/File';

/** Minimal plain object — only the codec/container facts the badge reads. */
function makeFile(
  videoCodec: string | null,
  audioCodec: string | null,
  formatName: string | null = null,
): ClientFile {
  return { videoCodec, audioCodec, formatName, codecVersion: null } as unknown as ClientFile;
}

async function renderBadge(file: ClientFile): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(UnplayableBadge, { file }));
  });
  return container;
}

afterEach(() => {
  document.body.innerHTML = '';
});

test('unplayable (hevc) row renders the "Not playable" lozenge naming the codec', async () => {
  const container = await renderBadge(makeFile('hevc', 'aac'));

  const badge = container.querySelector('.unplayable-badge');
  expect(badge).not.toBeNull();
  expect(badge!.textContent).toBe('Not playable');
  // widgets Tag styling is reused: span.tag > span.label markup is present.
  expect(badge!.querySelector('.tag .label')?.textContent).toBe('Not playable');

  const tooltip = [
    badge!.getAttribute('title'),
    badge!.querySelector('.tag')?.getAttribute('data-tooltip'),
  ].join(' / ');
  expect(tooltip).toContain(
    'HEVC is not decodable in this app — use "Re-encode (x264)" in the Tools panel',
  );
});

test('playable (h264 + aac) row renders no lozenge', async () => {
  const container = await renderBadge(makeFile('h264', 'aac'));
  expect(container.querySelector('.unplayable-badge')).toBeNull();
  expect(container.querySelector('.tag')).toBeNull();
  expect(container.textContent).toBe('');
});

test('unprobed (null codecs) row renders no lozenge', async () => {
  const container = await renderBadge(makeFile(null, null));
  expect(container.querySelector('.unplayable-badge')).toBeNull();
  expect(container.querySelector('.tag')).toBeNull();
  expect(container.textContent).toBe('');
});

test('probed MPEG-TS row (h264 + aac) renders the lozenge with a reason-only container tooltip', async () => {
  const container = await renderBadge(makeFile('h264', 'aac', 'mpegts'));

  const badge = container.querySelector('.unplayable-badge');
  expect(badge).not.toBeNull();
  expect(badge!.textContent).toBe('Not playable');
  // Container-driven verdict names the container, never a codec, and states
  // the reason only — remediation belongs to the banner.
  expect(badge!.getAttribute('title')).toBe('MPEG-TS is not demuxable in this app');
  expect(badge!.querySelector('.tag')?.getAttribute('data-tooltip')).toBe(
    'MPEG-TS is not demuxable in this app',
  );
  const tooltip = badge!.getAttribute('title') ?? '';
  expect(tooltip).not.toMatch(/re-encode/i);
  expect(tooltip).not.toMatch(/h\.?264/i);
});

test('unprobed .ts row renders no lozenge — not even when the container fact says mpegts', async () => {
  for (const formatName of ['mpegts', null] as const) {
    const container = await renderBadge(makeFile(null, null, formatName));
    expect(container.querySelector('.unplayable-badge')).toBeNull();
    expect(container.querySelector('.tag')).toBeNull();
    expect(container.textContent).toBe('');
    document.body.innerHTML = '';
  }
});

test('Matroska (mkv) row with playable codecs renders no lozenge', async () => {
  const container = await renderBadge(makeFile('h264', 'aac', 'matroska,webm'));
  expect(container.querySelector('.unplayable-badge')).toBeNull();
  expect(container.querySelector('.tag')).toBeNull();
  expect(container.textContent).toBe('');
});

test('Matroska (mkv) row with HEVC is badged by codec with the carried codec tooltip', async () => {
  const container = await renderBadge(makeFile('hevc', 'aac', 'matroska,webm'));

  const badge = container.querySelector('.unplayable-badge');
  expect(badge).not.toBeNull();
  expect(badge!.textContent).toBe('Not playable');
  const tooltip = [
    badge!.getAttribute('title'),
    badge!.querySelector('.tag')?.getAttribute('data-tooltip'),
  ].join(' / ');
  expect(tooltip).toContain(
    'HEVC is not decodable in this app — use "Re-encode (x264)" in the Tools panel',
  );
  expect(tooltip).not.toContain('MPEG-TS');
});
