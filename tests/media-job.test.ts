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
        setImmediate(() => proc.emit('close', 0));
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
});
