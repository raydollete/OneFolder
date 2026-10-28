/**
 * @jest-environment jsdom
 *
 * Inline banner tests for support-mov-playback (task 1.7).
 *
 * Renders the REAL <UnplayableBanner> into jsdom and asserts the display
 * strings and the build split:
 *   (a) unplayable (hevc) → title `HEVC — not playable here`, body points at
 *       the Tools panel's existing `Re-encode (x264)` tool — NO
 *       `Create playable copy` button (removed by owner decision 2026-10-27);
 *   (b) playable (h264+aac) and unprobed (null codecs) → renders nothing —
 *       a probe error / absent verdict must never surface as unplayable;
 *   (c) web build → `Not playable in this browser`, no write affordance.
 */

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { UnplayableBanner } from 'src/frontend/containers/ContentView/SlideMode/UnplayableBanner';
import type { ClientFile } from 'src/frontend/entities/File';

function fileWith(
  videoCodec: string | null,
  audioCodec: string | null,
  formatName: string | null = null,
): ClientFile {
  // The banner reads only the stored codec/container facts — a plain object suffices.
  return { videoCodec, audioCodec, formatName, codecVersion: null } as unknown as ClientFile;
}

/** Flip the webpack DefinePlugin global between desktop/web branches. */
function setWebBuild(isWeb: boolean): void {
  const g = globalThis as unknown as { IS_WEB_BUILD: boolean };
  g.IS_WEB_BUILD = isWeb;
}

describe('UnplayableBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    setWebBuild(false);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    setWebBuild(false);
  });

  function render(file: ClientFile): void {
    act(() => {
      root.render(<UnplayableBanner file={file} />);
    });
  }

  it('shows the codec title and the Re-encode remedy, without a Create-playable-copy button', () => {
    render(fileWith('hevc', 'aac'));

    expect(container.textContent).toContain('HEVC — not playable here');
    expect(container.textContent).toContain(
      'Use "Re-encode (x264)" in the Tools panel to create a playable H.264 .mp4 copy next to the original',
    );
    expect(container.textContent).not.toContain('Create playable copy');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders nothing for a playable clip (h264 + aac)', () => {
    render(fileWith('h264', 'aac'));
    expect(container.textContent).toBe('');
  });

  it('renders nothing for an unprobed clip (null codecs — probe error or pending)', () => {
    render(fileWith(null, null));
    expect(container.textContent).toBe('');
  });

  it('web build: explains without any button', () => {
    setWebBuild(true);
    render(fileWith('hevc', 'aac'));

    expect(container.textContent).toContain('Not playable in this browser');
    expect(container.textContent).not.toContain('Re-encode');
    expect(container.querySelector('button')).toBeNull();
  });

  it('names the container for an MPEG-TS clip, remedy is the Tools-panel tool', () => {
    render(fileWith('h264', 'aac', 'mpegts'));

    // Reason token is the container; the codec strings never surface there.
    const title = container.querySelector('.unplayable-banner__title')?.textContent ?? '';
    expect(title).toBe('MPEG-TS — not playable here');
    expect(title).not.toMatch(/h\.?264/i);
    expect(container.textContent).toContain('MPEG-TS is not demuxable in this app');
    expect(container.textContent).toContain('Use "Re-encode (x264)" in the Tools panel');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders nothing for an unprobed .ts clip (no video codec — container mpegts or absent)', () => {
    render(fileWith(null, null, 'mpegts'));
    expect(container.textContent).toBe('');
    render(fileWith(null, null, null));
    expect(container.textContent).toBe('');
  });

  it('renders nothing for a Matroska clip with playable codecs (h264 + aac)', () => {
    render(fileWith('h264', 'aac', 'matroska,webm'));
    expect(container.textContent).toBe('');
  });

  it('names the codec for a Matroska HEVC clip, carrying the mov-lane strings verbatim', () => {
    render(fileWith('hevc', 'aac', 'matroska,webm'));

    const title = container.querySelector('.unplayable-banner__title')?.textContent ?? '';
    expect(title).toBe('HEVC — not playable here');
    expect(container.textContent).toContain(
      'HEVC is not decodable in this app. Use "Re-encode (x264)" in the Tools panel to create a playable H.264 .mp4 copy next to the original — the original is never modified.',
    );
    expect(container.textContent).not.toContain('MPEG-TS');
  });

  it('web build: MPEG-TS is explained without any button', () => {
    setWebBuild(true);
    render(fileWith('h264', 'aac', 'mpegts'));

    const title = container.querySelector('.unplayable-banner__title')?.textContent ?? '';
    expect(title).toBe('MPEG-TS — not playable here');
    expect(container.textContent).toContain('Not playable in this browser');
    expect(container.textContent).not.toContain('Re-encode');
    expect(container.querySelector('button')).toBeNull();
  });
});
