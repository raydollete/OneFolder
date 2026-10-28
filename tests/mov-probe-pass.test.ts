/**
 * Background video codec probe pass (change: support-mov-playback, task 1.5).
 *
 * Done-when: with a mocked runner, ONE spawn per changed file, ZERO spawns for
 * fresh (path, size, mtime) keys or for images; an `error` probe result leaves
 * the row NULL (no update emitted) and logs via console.error — an ffprobe
 * failure must never surface as "unplayable" (fail-loud, INV-032 mirror).
 * Fresh probes also carry the container fact: an update pushes formatName —
 * explicitly null when the probe ran but reported no container string.
 */

import {
  buildProbeStamp,
  buildProbeCandidatesFromRows,
  isProbeStale,
  runVideoCodecProbePass,
  VideoCodecProbeRunner,
} from '../src/ipc/videoProbePass';
import type { VideoProbeCandidate } from '../src/ipc/messages';
import type { VideoProbeResult } from '../src/media/FfmpegRunner';
import { MOV_CODEC_VERSION } from '../src/api/file';

function candidate(
  id: string,
  codecVersion: string | null = null,
  absolutePath = `/library/${id}.mov`,
): VideoProbeCandidate {
  return { id, absolutePath, codecVersion };
}

function makeRunner(results: Record<string, VideoProbeResult>) {
  const spawnPaths: string[] = [];
  const runner: VideoCodecProbeRunner = {
    probeFirstVideoCodec: jest.fn(async (input: string) => {
      spawnPaths.push(input);
      const result = results[input];
      if (result === undefined) {
        throw new Error(`unexpected probe of ${input}`);
      }
      return result;
    }),
  };
  return { runner, spawnPaths };
}

function makeStat(sizes: Record<string, { size: number; mtimeMs: number }>) {
  return jest.fn(async (p: string) => {
    const s = sizes[p];
    if (s === undefined) {
      throw new Error(`ENOENT: ${p}`);
    }
    return s;
  });
}

const noYield = { yieldToEventLoop: () => Promise.resolve() };

describe('isProbeStale', () => {
  it('fresh stamp matching size+mtime is fresh; anything else is stale', () => {
    const fresh = buildProbeStamp(1000, 5000);
    expect(isProbeStale(null, 1000, 5000)).toBe(true); // never probed
    expect(isProbeStale('', 1000, 5000)).toBe(true);
    expect(isProbeStale(fresh, 1000, 5000)).toBe(false);
    expect(isProbeStale(fresh, 1001, 5000)).toBe(true); // externally edited size
    expect(isProbeStale(fresh, 1000, 5001)).toBe(true); // externally edited mtime
    expect(
      isProbeStale(`${MOV_CODEC_VERSION + 1}:1000:5000`, 1000, 5000),
    ).toBe(true); // future stamp never matches
    expect(isProbeStale('0:1000:5000', 1000, 5000)).toBe(true); // stale codec table
  });
});

describe('runVideoCodecProbePass', () => {
  it('spawns once per stale file, zero spawns for fresh keys, and writes stamp + codecs + container', async () => {
    const a = candidate('a', null); // never probed
    const b = candidate('b', buildProbeStamp(2048, 7000)); // fresh
    const c = candidate('c', '0:9:9'); // stale codec table
    const stat = makeStat({
      '/library/a.mov': { size: 111, mtimeMs: 222 },
      '/library/b.mov': { size: 2048, mtimeMs: 7000 },
      '/library/c.mov': { size: 333, mtimeMs: 444 },
    });
    const { runner, spawnPaths } = makeRunner({
      '/library/a.mov': {
        kind: 'codec',
        videoCodec: 'hevc',
        audioCodec: 'pcm_s16le',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
      '/library/c.mov': {
        kind: 'codec',
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
    });

    const updates = await runVideoCodecProbePass([a, b, c], { runner, stat, ...noYield });

    expect(spawnPaths).toEqual(['/library/a.mov', '/library/c.mov']); // one per changed file
    expect(runner.probeFirstVideoCodec).toHaveBeenCalledTimes(2); // zero for the fresh key
    expect(updates).toEqual([
      {
        id: 'a',
        videoCodec: 'hevc',
        audioCodec: 'pcm_s16le',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        codecVersion: `${MOV_CODEC_VERSION}:111:222`,
      },
      {
        id: 'c',
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        codecVersion: `${MOV_CODEC_VERSION}:333:444`,
      },
    ]);
  });

  it('re-probes when size or mtime changed since the stored stamp', async () => {
    const edited = candidate('e', buildProbeStamp(1000, 5000));
    const stat = makeStat({ '/library/e.mov': { size: 1000, mtimeMs: 5001 } });
    const { runner, spawnPaths } = makeRunner({
      '/library/e.mov': {
        kind: 'codec',
        videoCodec: 'h264',
        audioCodec: null,
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
    });

    const updates = await runVideoCodecProbePass([edited], { runner, stat, ...noYield });

    expect(spawnPaths).toEqual(['/library/e.mov']);
    expect(updates[0].videoCodec).toBe('h264');
    expect(updates[0].formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(updates[0].codecVersion).toBe(`${MOV_CODEC_VERSION}:1000:5001`);
  });

  it('carries the container fact on fresh probes: mpegts and matroska rows', async () => {
    const ts = candidate('t', null, '/library/clip.ts');
    const mkv = candidate('m', null, '/library/clip.mkv');
    const stat = makeStat({
      '/library/clip.ts': { size: 4096, mtimeMs: 9000 },
      '/library/clip.mkv': { size: 8192, mtimeMs: 9500 },
    });
    const { runner, spawnPaths } = makeRunner({
      '/library/clip.ts': {
        kind: 'codec',
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'mpegts',
      },
      '/library/clip.mkv': {
        kind: 'codec',
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'matroska,webm',
      },
    });

    const updates = await runVideoCodecProbePass([ts, mkv], { runner, stat, ...noYield });

    expect(spawnPaths).toEqual(['/library/clip.ts', '/library/clip.mkv']); // one spawn each
    expect(updates).toEqual([
      {
        id: 't',
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'mpegts',
        codecVersion: `${MOV_CODEC_VERSION}:4096:9000`,
      },
      {
        id: 'm',
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'matroska,webm',
        codecVersion: `${MOV_CODEC_VERSION}:8192:9500`,
      },
    ]);
  });

  it('pushes formatName as an explicit null when the probe reported no container', async () => {
    const stat = makeStat({ '/library/nf.mov': { size: 10, mtimeMs: 10 } });
    const { runner } = makeRunner({
      '/library/nf.mov': {
        kind: 'codec',
        videoCodec: 'h264',
        audioCodec: null,
        formatName: null,
      },
    });

    const updates = await runVideoCodecProbePass([candidate('nf')], {
      runner,
      stat,
      ...noYield,
    });

    expect(updates).toHaveLength(1);
    // null, never an omitted key: an absent argument would leave a stored
    // container fact in place instead of clearing it.
    expect('formatName' in updates[0]).toBe(true);
    expect(updates[0]).toHaveProperty('formatName', null);
  });

  it('images never reach the runner', async () => {
    const stat = makeStat({});
    const { runner, spawnPaths } = makeRunner({});
    const candidates = buildProbeCandidatesFromRows(
      [{ id: 'img', extension: 'jpeg', locationId: 'l', relativePath: 'x.jpg' }],
      (row) => `/library/${row.relativePath}`,
    );
    const updates = await runVideoCodecProbePass(candidates, { runner, stat, ...noYield });
    expect(candidates).toEqual([]);
    expect(spawnPaths).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('probe error leaves the row NULL (no update) and logs via console.error — never a verdict', async () => {
    const logError = jest.fn();
    const logInfo = jest.fn();
    const stat = makeStat({ '/library/f.mov': { size: 1, mtimeMs: 1 } });
    const { runner } = makeRunner({
      '/library/f.mov': { kind: 'error', error: new Error('ffprobe missing') },
    });

    const updates = await runVideoCodecProbePass([candidate('f')], {
      runner,
      stat,
      logError,
      logInfo,
      ...noYield,
    });

    expect(updates).toEqual([]); // row untouched → NULL → derived 'unprobed'
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0][0])).toContain('/library/f.mov');
    expect((logError.mock.calls[0][1] as Error).message).toBe('ffprobe missing');
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('no-video result is not an error: no update, no console.error', async () => {
    const logError = jest.fn();
    const logInfo = jest.fn();
    const stat = makeStat({ '/library/g.mov': { size: 5, mtimeMs: 5 } });
    const { runner } = makeRunner({ '/library/g.mov': { kind: 'no-video' } });

    const updates = await runVideoCodecProbePass([candidate('g')], {
      runner,
      stat,
      logError,
      logInfo,
      ...noYield,
    });

    expect(updates).toEqual([]);
    expect(logError).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it('a missing file fails that candidate loudly and does not abort the pass', async () => {
    const logError = jest.fn();
    const gone = candidate('gone');
    const ok = candidate('ok');
    const stat = makeStat({ '/library/ok.mov': { size: 7, mtimeMs: 7 } }); // gone → throws
    const { runner, spawnPaths } = makeRunner({
      '/library/ok.mov': {
        kind: 'codec',
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
    });

    const updates = await runVideoCodecProbePass([gone, ok], {
      runner,
      stat,
      logError,
      ...noYield,
    });

    expect(spawnPaths).toEqual(['/library/ok.mov']);
    expect(updates).toHaveLength(1);
    expect(logError).toHaveBeenCalledTimes(1); // stat failure logged, pass continued
  });

  it('yields the event loop between files (low-priority contract)', async () => {
    let yields = 0;
    const stat = makeStat({
      '/library/y1.mov': { size: 1, mtimeMs: 1 },
      '/library/y2.mov': { size: 2, mtimeMs: 2 },
    });
    const { runner } = makeRunner({
      '/library/y1.mov': {
        kind: 'codec',
        videoCodec: 'h264',
        audioCodec: null,
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
      '/library/y2.mov': {
        kind: 'codec',
        videoCodec: 'h264',
        audioCodec: null,
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
    });

    await runVideoCodecProbePass([candidate('y1'), candidate('y2')], {
      runner,
      stat,
      yieldToEventLoop: async () => {
        yields += 1;
      },
    });

    expect(yields).toBe(2); // one yield per candidate considered
  });
});
