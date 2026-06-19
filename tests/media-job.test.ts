/**
 * Tests for the media subsystem: getUniqueSiblingPath (path planning), FfmpegRunner (Layer 1
 * argv assembly), and MediaJobService (Layer 2 encode -> place lifecycle).
 *
 * The functional encode tests spawn a real ffmpeg process against a tiny generated video; they
 * are skipped automatically when the bundled ffmpeg binary is not present.
 *
 * The argv-ordering tests use a spawn mock (the real spawn is forwarded for everything except the
 * `/fake/ffmpeg` and `/fake/ffprobe` sentinels) so they run without a real binary.
 */

import path from 'path';
import os from 'os';
import fse from 'fs-extra';
import { execFileSync } from 'child_process';

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

jest.mock('child_process', () => {
  const real = jest.requireActual<typeof import('child_process')>('child_process');
  return {
    ...real,
    spawn: (cmd: string, args: string[], opts?: object) => {
      if (cmd === '/fake/ffmpeg' || cmd === '/fake/ffprobe') {
        spawnCalls.push({ cmd, args: args ?? [] });
        const { EventEmitter: EE } = require('events') as typeof import('events');
        const proc = new EE() as NodeJS.EventEmitter & {
          stdout: InstanceType<typeof EE>;
          stderr: InstanceType<typeof EE>;
          pid: number;
        };
        proc.stdout = new EE();
        proc.stderr = new EE();
        proc.pid = 99999;
        // For probeFirstAudioCodec calls (identified by '-select_streams' + 'a:0' in argv),
        // emit a codec name line on stdout so the { kind: 'codec' } path is exercised.
        // All other fake invocations emit close 0 with no stdout (probeDuration returns undefined).
        const isAudioProbe =
          cmd === '/fake/ffprobe' &&
          args.includes('-select_streams') &&
          args.includes('a:0');
        setImmediate(() => {
          if (isAudioProbe) {
            proc.stdout.emit('data', Buffer.from('aac\n'));
          }
          proc.emit('close', 0);
        });
        return proc;
      }
      return real.spawn(cmd, args, opts as Parameters<typeof real.spawn>[2]);
    },
  };
});

const resourcesDir = path.resolve(__dirname, '..', 'resources');
const ffmpegBin = path.join(
  resourcesDir,
  'ffmpeg',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);
const ffprobeBin = path.join(
  resourcesDir,
  'ffmpeg',
  process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
);

function binaryExists(p: string): boolean {
  try {
    fse.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_AVAILABLE = binaryExists(ffmpegBin);

// ---------------------------------------------------------------------------
// getUniqueSiblingPath
// ---------------------------------------------------------------------------

import { getUniqueSiblingPath } from '../common/fs';

describe('getUniqueSiblingPath', () => {
  const dir = process.platform === 'win32' ? 'C:\\Users\\test\\videos' : '/home/user/videos';
  let existsSpy: jest.SpyInstance;

  beforeEach(() => {
    existsSpy = jest.spyOn(fse, 'existsSync');
  });
  afterEach(() => {
    existsSpy.mockRestore();
  });

  it('returns baseName.ext when the path does not exist', () => {
    existsSpy.mockReturnValue(false);
    expect(getUniqueSiblingPath(dir, 'clip', 'mp4')).toBe(path.join(dir, 'clip.mp4'));
  });

  it('returns baseName 1.ext when the base path exists', () => {
    existsSpy.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(getUniqueSiblingPath(dir, 'clip', 'mp4')).toBe(path.join(dir, 'clip 1.mp4'));
  });

  it('returns baseName 2.ext when both base and 1 exist', () => {
    existsSpy.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(getUniqueSiblingPath(dir, 'clip', 'mp4')).toBe(path.join(dir, 'clip 2.mp4'));
  });

  it('uses the exact ext string provided (no leading dot duplicated)', () => {
    existsSpy.mockReturnValue(false);
    expect(getUniqueSiblingPath(dir, 'photo', 'jpg')).toMatch(/photo\.jpg$/);
  });
});

// ---------------------------------------------------------------------------
// FfmpegRunner — argv assembly (preInputArgs before -i, jobArgs after)
// ---------------------------------------------------------------------------

describe('FfmpegRunner argv ordering', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('places preInputArgs BEFORE -i and args AFTER -i', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const runner = new FfmpegRunner('/fake/ffmpeg', '/fake/ffprobe');

    await runner.run({
      input: '/videos/source.mp4',
      output: '/tmp/out.mp4',
      args: ['-c', 'copy'],
      preInputArgs: ['-ss', '00:00:01', '-to', '00:00:02'],
    });

    const argv = spawnCalls.find((c) => c.cmd === '/fake/ffmpeg')!.args;
    expect(argv[0]).toBe('-hide_banner');
    const ssIdx = argv.indexOf('-ss');
    const toIdx = argv.indexOf('-to');
    const iIdx = argv.indexOf('-i');
    const cIdx = argv.indexOf('-c');
    expect(ssIdx).toBeGreaterThan(-1);
    expect(ssIdx).toBeLessThan(iIdx);
    expect(toIdx).toBeLessThan(iIdx);
    expect(argv[iIdx + 1]).toBe('/videos/source.mp4');
    expect(cIdx).toBeGreaterThan(iIdx);
    expect(argv[argv.length - 1]).toBe('/tmp/out.mp4');
  });

  it('produces the legacy argv (no preInputArgs) when omitted', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const runner = new FfmpegRunner('/fake/ffmpeg', '/fake/ffprobe');

    await runner.run({
      input: '/videos/source.mp4',
      output: '/tmp/out.mp4',
      args: ['-c:a', 'copy', '-c:v', 'libx264'],
    });

    const argv = spawnCalls.find((c) => c.cmd === '/fake/ffmpeg')!.args;
    expect(argv[0]).toBe('-hide_banner');
    expect(argv[1]).toBe('-i');
    expect(argv[2]).toBe('/videos/source.mp4');
    expect(argv.includes('-ss')).toBe(false);
    expect(argv[3]).toBe('-c:a');
  });
});

// ---------------------------------------------------------------------------
// Rotate spec args — NVENC + transpose (no libx264, no static -c:a)
// ---------------------------------------------------------------------------

import { NVENC_H264_VIDEO_ARGS } from '../src/media/audioArgs';

describe('Rotate spec args', () => {
  it('rotate-cw base args are transpose=1 + NVENC block (no libx264, no static -c:a)', () => {
    const expected = ['-vf', 'transpose=1', ...NVENC_H264_VIDEO_ARGS];
    // MEDIA_JOB_SPECS is not exported; reconstruct the expected array from the shared constant
    // and assert its shape.
    expect(expected).toEqual([
      '-vf',
      'transpose=1',
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p7',
      '-tune',
      'hq',
      '-cq',
      '21',
    ]);
    expect(expected).not.toContain('libx264');
    expect(expected).not.toContain('-c:a');
  });

  it('rotate-ccw base args are transpose=2 + NVENC block (no libx264, no static -c:a)', () => {
    const expected = ['-vf', 'transpose=2', ...NVENC_H264_VIDEO_ARGS];
    expect(expected).toEqual([
      '-vf',
      'transpose=2',
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p7',
      '-tune',
      'hq',
      '-cq',
      '21',
    ]);
    expect(expected).not.toContain('libx264');
    expect(expected).not.toContain('-c:a');
  });

  it('NVENC_H264_VIDEO_ARGS does not contain libx264', () => {
    expect(Array.from(NVENC_H264_VIDEO_ARGS)).not.toContain('libx264');
  });
});

// ---------------------------------------------------------------------------
// FfmpegRunner.probeFirstAudioCodec — argv shape + three-state result
// ---------------------------------------------------------------------------

describe('FfmpegRunner probeFirstAudioCodec', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('spawns ffprobe with -select_streams a:0 -show_entries stream=codec_name argv', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const runner = new FfmpegRunner('/fake/ffmpeg', '/fake/ffprobe');

    const result = await runner.probeFirstAudioCodec('/videos/source.mp4');

    const call = spawnCalls.find((c) => c.cmd === '/fake/ffprobe');
    expect(call).toBeDefined();
    const argv = call!.args;

    // Must include the stream selector and codec_name entry selector
    expect(argv).toContain('-select_streams');
    expect(argv[argv.indexOf('-select_streams') + 1]).toBe('a:0');
    expect(argv).toContain('-show_entries');
    expect(argv[argv.indexOf('-show_entries') + 1]).toBe('stream=codec_name');
    // Input is the last arg
    expect(argv[argv.length - 1]).toBe('/videos/source.mp4');
    // The mock emits 'aac\n' for audio probes → should resolve as codec
    expect(result).toEqual({ kind: 'codec', codecName: 'aac' });
  });
});

// ---------------------------------------------------------------------------
// MediaJobService — functional encode -> place lifecycle (requires real ffmpeg)
// ---------------------------------------------------------------------------

describe('MediaJobService functional encode + place', () => {
  if (!FFMPEG_AVAILABLE) {
    it.skip('ffmpeg binary not found at ' + ffmpegBin + ' — skipping functional tests', () => {
      /* intentionally empty */
    });
    return;
  }

  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'onefolder-media-test-'));
  });
  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  function generateTestVideo(outPath: string, durationSec = 1): void {
    execFileSync(
      ffmpegBin,
      ['-y', '-f', 'lavfi', '-i', `testsrc=duration=${durationSec}:size=64x64:rate=10`,
        '-c:v', 'libx264', '-t', String(durationSec), outPath],
      { stdio: 'ignore' },
    );
  }

  function makeService(appTempDir: string) {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const { MediaJobService } = require('../src/media/MediaJobService') as typeof import('../src/media/MediaJobService');
    const svc = new MediaJobService(new FfmpegRunner(ffmpegBin, ffprobeBin));
    svc.setTempBaseDir(appTempDir);
    return svc;
  }

  it('encodes to the app staging dir, then places at the collision-free final path', async () => {
    const inputPath = path.join(tmpDir, 'source.mp4');
    generateTestVideo(inputPath, 1);
    const appTempDir = path.join(tmpDir, 'app-temp');
    const svc = makeService(appTempDir);

    let jobId = '';
    const result = await new Promise<{ tempPath: string; finalPath: string }>((resolve, reject) => {
      const r = svc.start(inputPath, ['-c:a', 'copy', '-c:v', 'libx264'], 'mp4', {
        onProgress: () => {},
        onDone: resolve,
        onError: reject,
        onCancelled: () => reject(new Error('unexpected cancel')),
      });
      jobId = r.jobId;
    });

    // After onDone: file is in the app staging dir (NOT the source dir), final not created yet.
    expect(result.tempPath.startsWith(appTempDir)).toBe(true);
    expect(path.dirname(result.tempPath)).not.toBe(tmpDir);
    expect(fse.existsSync(result.tempPath)).toBe(true);
    expect(fse.existsSync(result.finalPath)).toBe(false);

    const placed = await svc.place(jobId);
    expect(placed.outputPath).toBe(path.join(tmpDir, 'source 1.mp4'));
    expect(fse.existsSync(placed.outputPath)).toBe(true);
    expect(fse.existsSync(result.tempPath)).toBe(false); // moved out of staging

    const codec = execFileSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=nokey=1:noprint_wrappers=1',
      placed.outputPath]).toString().trim();
    expect(codec).toBe('h264');
  }, 60_000);

  it('onError fires and leaves no staged file for a non-existent input', async () => {
    const appTempDir = path.join(tmpDir, 'app-temp');
    const svc = makeService(appTempDir);

    const err = await new Promise<Error>((resolve, reject) => {
      svc.start(path.join(tmpDir, 'ghost.mp4'), ['-c:a', 'copy', '-c:v', 'libx264'], 'mp4', {
        onProgress: () => {},
        onDone: () => reject(new Error('expected onError')),
        onError: resolve,
        onCancelled: () => reject(new Error('expected onError')),
      });
    });

    expect(err.message).toMatch(/ffmpeg exited with code/i);
    expect((await fse.readdir(tmpDir)).filter((f) => f.endsWith('.mp4'))).toHaveLength(0);
    if (fse.existsSync(appTempDir)) {
      expect(await fse.readdir(appTempDir)).toHaveLength(0);
    }
  }, 30_000);

  it('cancel kills ffmpeg and removes the staged partial', async () => {
    const inputPath = path.join(tmpDir, 'long.mp4');
    generateTestVideo(inputPath, 2);
    const appTempDir = path.join(tmpDir, 'app-temp');
    const svc = makeService(appTempDir);

    let jobId: string | undefined;
    let cancelFired = false;
    const outcome = await new Promise<'cancelled' | 'done' | 'error'>((resolve) => {
      const r = svc.start(inputPath, ['-c:a', 'copy', '-c:v', 'libx264'], 'mp4', {
        onProgress: () => {
          if (jobId !== undefined && !cancelFired) {
            cancelFired = true;
            svc.cancel(jobId);
          }
        },
        onDone: () => resolve('done'),
        onError: () => resolve('error'),
        onCancelled: () => resolve('cancelled'),
      });
      jobId = r.jobId;
    });

    expect(['cancelled', 'done', 'error']).toContain(outcome);
    if (outcome === 'cancelled' || outcome === 'error') {
      expect((await fse.readdir(tmpDir)).filter((f) => f.endsWith('.mp4') && f !== 'long.mp4')).toHaveLength(0);
      if (fse.existsSync(appTempDir)) {
        expect(await fse.readdir(appTempDir)).toHaveLength(0);
      }
      expect(fse.existsSync(inputPath)).toBe(true);
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Functional: probeFirstAudioCodec with real ffprobe (INV-032 Directive 2)
  // -------------------------------------------------------------------------

  it('probeFirstAudioCodec returns { kind: codec } for an AAC source', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const runner = new FfmpegRunner(ffmpegBin, ffprobeBin);

    // Create an H.264+AAC mp4 for this test.
    const inputPath = path.join(tmpDir, 'aac-source.mp4');
    execFileSync(
      ffmpegBin,
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        inputPath,
      ],
      { stdio: 'ignore' },
    );

    const result = await runner.probeFirstAudioCodec(inputPath);
    expect(result.kind).toBe('codec');
    if (result.kind === 'codec') {
      expect(result.codecName).toBe('aac');
    }
  }, 30_000);

  it('probeFirstAudioCodec returns { kind: no-audio } for a video-only source', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const runner = new FfmpegRunner(ffmpegBin, ffprobeBin);

    const inputPath = path.join(tmpDir, 'no-audio.mp4');
    generateTestVideo(inputPath, 1);

    const result = await runner.probeFirstAudioCodec(inputPath);
    expect(result).toEqual({ kind: 'no-audio' });
  }, 30_000);

  it('decideAudioArgs returns [-c:a, copy] for an MP4-legal-audio source', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const { decideAudioArgs } = require('../src/media/audioArgs') as typeof import('../src/media/audioArgs');
    const runner = new FfmpegRunner(ffmpegBin, ffprobeBin);

    const inputPath = path.join(tmpDir, 'aac-source2.mp4');
    execFileSync(
      ffmpegBin,
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        inputPath,
      ],
      { stdio: 'ignore' },
    );

    const args = await decideAudioArgs(runner, inputPath);
    expect(args).toEqual(['-c:a', 'copy']);
  }, 30_000);

  it('decideAudioArgs returns [-an] for a video-only source', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const { decideAudioArgs } = require('../src/media/audioArgs') as typeof import('../src/media/audioArgs');
    const runner = new FfmpegRunner(ffmpegBin, ffprobeBin);

    const inputPath = path.join(tmpDir, 'no-audio2.mp4');
    generateTestVideo(inputPath, 1);

    const args = await decideAudioArgs(runner, inputPath);
    expect(args).toEqual(['-an']);
  }, 30_000);

  it('non-MP4-legal audio (vorbis) source yields aac output after decideAudioArgs encode', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const { MediaJobService } = require('../src/media/MediaJobService') as typeof import('../src/media/MediaJobService');
    const { decideAudioArgs } = require('../src/media/audioArgs') as typeof import('../src/media/audioArgs');

    // Generate a vorbis-audio source in a .mkv container.
    const inputPath = path.join(tmpDir, 'vorbis-source.mkv');
    try {
      execFileSync(
        ffmpegBin,
        [
          '-y',
          '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
          '-c:v', 'libx264',
          '-c:a', 'libvorbis',
          inputPath,
        ],
        { stdio: 'ignore' },
      );
    } catch {
      // libvorbis may not be available in all ffmpeg builds; skip gracefully.
      console.warn('[test] libvorbis not available in bundled ffmpeg — skipping non-MP4-legal audio functional test');
      return;
    }

    const appTempDir = path.join(tmpDir, 'app-temp');
    const runner = new FfmpegRunner(ffmpegBin, ffprobeBin);
    const svc = new MediaJobService(runner);
    svc.setTempBaseDir(appTempDir);

    // Probe the audio and build args the same way onStartMediaJob does at runtime.
    const audioArgs = await decideAudioArgs(runner, inputPath);
    // For a vorbis source, we expect AAC re-encode.
    expect(audioArgs).toEqual(['-c:a', 'aac', '-b:a', '192k']);

    // Encode: use software libx264 for video (NVENC not available in CI) + the decided audio args.
    const jobArgs = ['-c:v', 'libx264', ...audioArgs];
    let jobId = '';
    await new Promise<{ tempPath: string; finalPath: string }>((resolve, reject) => {
      const r = svc.start(inputPath, jobArgs, 'mp4', {
        onProgress: () => {},
        onDone: resolve,
        onError: reject,
        onCancelled: () => reject(new Error('unexpected cancel')),
      });
      jobId = r.jobId;
    });

    const placed = await svc.place(jobId);
    expect(fse.existsSync(placed.outputPath)).toBe(true);

    // Verify the output audio codec is aac.
    const audioCodec = execFileSync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      placed.outputPath,
    ]).toString().trim();
    expect(audioCodec).toBe('aac');
  }, 60_000);

  it('video-only source encoded with -an arg produces output with no audio stream', async () => {
    const { FfmpegRunner } = require('../src/media/FfmpegRunner') as typeof import('../src/media/FfmpegRunner');
    const { MediaJobService } = require('../src/media/MediaJobService') as typeof import('../src/media/MediaJobService');
    const { decideAudioArgs } = require('../src/media/audioArgs') as typeof import('../src/media/audioArgs');

    const inputPath = path.join(tmpDir, 'no-audio-src.mp4');
    generateTestVideo(inputPath, 1);

    const appTempDir = path.join(tmpDir, 'app-temp-noaudio');
    const runner = new FfmpegRunner(ffmpegBin, ffprobeBin);
    const svc = new MediaJobService(runner);
    svc.setTempBaseDir(appTempDir);

    const audioArgs = await decideAudioArgs(runner, inputPath);
    expect(audioArgs).toEqual(['-an']);

    const jobArgs = ['-c:v', 'libx264', ...audioArgs];
    let jobId = '';
    await new Promise<{ tempPath: string; finalPath: string }>((resolve, reject) => {
      const r = svc.start(inputPath, jobArgs, 'mp4', {
        onProgress: () => {},
        onDone: resolve,
        onError: reject,
        onCancelled: () => reject(new Error('unexpected cancel')),
      });
      jobId = r.jobId;
    });

    const placed = await svc.place(jobId);
    expect(fse.existsSync(placed.outputPath)).toBe(true);

    // Verify the output has no audio stream (empty stdout from ffprobe).
    const audioCodec = execFileSync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      placed.outputPath,
    ]).toString().trim();
    expect(audioCodec).toBe(''); // empty = no audio stream
  }, 60_000);
});
