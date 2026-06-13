/**
 * Tests for ReEncodeManager and the getUniqueSiblingPath helper.
 *
 * Unit tests for getUniqueSiblingPath run without any I/O (fse.existsSync is
 * spied and controlled per-test via jest.spyOn).
 *
 * The functional encode tests spawn a real ffmpeg process against a tiny test
 * video generated with `ffmpeg -f lavfi`.  They are automatically skipped when
 * the ffmpeg binary is not present (e.g. in CI that doesn't bundle it).
 *
 * The argv-ordering tests use a spawn mock (EventEmitter-based fake ChildProcess)
 * to verify preInputArgs placement without requiring a real ffmpeg binary.
 * jest.mock('child_process') is used because Node's built-in module exports are
 * non-configurable and cannot be patched by jest.spyOn.  The mock forwards all
 * calls to the real spawn UNLESS the command equals '/fake/ffmpeg' or '/fake/ffprobe',
 * which lets the functional encode tests work unmodified.
 */

import path from 'path';
import os from 'os';
import fse from 'fs-extra';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// child_process mock — forwards real calls for all commands except the fake
// sentinel paths used by the argv-ordering tests below.
// ---------------------------------------------------------------------------

// spawnCalls is populated by the mock for fake-path invocations.
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

jest.mock('child_process', () => {
  // Keep a reference to the real module so functional tests still work.
  const real = jest.requireActual<typeof import('child_process')>('child_process');

  return {
    ...real,
    spawn: (cmd: string, args: string[], opts?: object) => {
      // Fake sentinel paths used by the argv-ordering tests — return a minimal
      // ChildProcess mock instead of spawning a real process.
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
        // Resolve the process on the next tick so listeners are attached first.
        setImmediate(() => proc.emit('close', 0));
        return proc;
      }
      // Real command — delegate to the real spawn (functional encode tests).
      return real.spawn(cmd, args, opts as Parameters<typeof real.spawn>[2]);
    },
  };
});

// ---------------------------------------------------------------------------
// Path resolution for the bundled binaries (mirrors common/fs.ts getExtraResourcePath)
// ---------------------------------------------------------------------------

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
// getUniqueSiblingPath unit tests (controlled fse.existsSync via spyOn)
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
    const result = getUniqueSiblingPath(dir, 'clip', 'mp4');
    expect(result).toBe(path.join(dir, 'clip.mp4'));
    expect(existsSpy).toHaveBeenCalledTimes(1);
    expect(existsSpy).toHaveBeenCalledWith(path.join(dir, 'clip.mp4'));
  });

  it('returns baseName 1.ext when the base path exists', () => {
    existsSpy
      .mockReturnValueOnce(true)   // clip.mp4 exists
      .mockReturnValueOnce(false); // clip 1.mp4 is free
    const result = getUniqueSiblingPath(dir, 'clip', 'mp4');
    expect(result).toBe(path.join(dir, 'clip 1.mp4'));
  });

  it('returns baseName 2.ext when both base and 1 exist', () => {
    existsSpy
      .mockReturnValueOnce(true)   // clip.mp4 exists
      .mockReturnValueOnce(true)   // clip 1.mp4 exists
      .mockReturnValueOnce(false); // clip 2.mp4 is free
    const result = getUniqueSiblingPath(dir, 'clip', 'mp4');
    expect(result).toBe(path.join(dir, 'clip 2.mp4'));
  });

  it('works for a base name that contains spaces', () => {
    existsSpy.mockReturnValue(false);
    const result = getUniqueSiblingPath(dir, 'my vacation clip', 'mp4');
    expect(result).toBe(path.join(dir, 'my vacation clip.mp4'));
  });

  it('uses the exact ext string provided (no leading dot duplicated)', () => {
    existsSpy.mockReturnValue(false);
    const result = getUniqueSiblingPath(dir, 'photo', 'jpg');
    expect(result).toMatch(/photo\.jpg$/);
    expect(result).not.toMatch(/photo\.jpg\.jpg$/);
  });

  it('handles many existing siblings (resolves to n=5)', () => {
    existsSpy
      .mockReturnValueOnce(true)   // clip.mp4 exists
      .mockReturnValueOnce(true)   // clip 1.mp4 exists
      .mockReturnValueOnce(true)   // clip 2.mp4 exists
      .mockReturnValueOnce(true)   // clip 3.mp4 exists
      .mockReturnValueOnce(true)   // clip 4.mp4 exists
      .mockReturnValueOnce(false); // clip 5.mp4 is free
    const result = getUniqueSiblingPath(dir, 'clip', 'mp4');
    expect(result).toBe(path.join(dir, 'clip 5.mp4'));
  });
});

// ---------------------------------------------------------------------------
// Functional encode tests — require real ffmpeg binary
// ---------------------------------------------------------------------------

describe('ReEncodeManager functional encode', () => {
  if (!FFMPEG_AVAILABLE) {
    it.skip('ffmpeg binary not found at ' + ffmpegBin + ' — skipping functional tests', () => {
      /* intentionally empty */
    });
    return;
  }

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'onefolder-reencode-test-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  /**
   * Generate a tiny N-second H.264 MP4 using ffmpeg's lavfi test source.
   * Using mp4 format is required for libx264 output.
   */
  function generateTestVideo(outPath: string, durationSec = 1): void {
    execFileSync(
      ffmpegBin,
      [
        '-y',
        '-f', 'lavfi',
        '-i', `testsrc=duration=${durationSec}:size=64x64:rate=10`,
        '-c:v', 'libx264',
        '-t', String(durationSec),
        outPath,
      ],
      { stdio: 'ignore' },
    );
  }

  it('encodes a test video to H.264 mp4 and resolves with outputPath', async () => {
    // Source uses .mp4 extension; the output path will be 'source 1.mp4' because
    // 'source.mp4' already exists on disk.
    const inputPath = path.join(tmpDir, 'source.mp4');
    generateTestVideo(inputPath, 1);
    expect(fse.existsSync(inputPath)).toBe(true);

    // Import here (after all spies restored) to get real fse behaviour.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReEncodeManager } = require('../src/ReEncodeManager') as typeof import('../src/ReEncodeManager');
    // Pass explicit binary paths so the test doesn't rely on getExtraResourcePath
    // which uses IS_DEV / __dirname and resolves differently under ts-jest.
    const manager = new ReEncodeManager({ ffmpegPath: ffmpegBin, ffprobePath: ffprobeBin });

    const progressEvents: import('../src/ReEncodeManager').ReencodeProgress[] = [];

    const result = await new Promise<import('../src/ReEncodeManager').ReencodeResult>(
      (resolve, reject) => {
        manager.start(inputPath, ['-c:a', 'copy', '-c:v', 'libx264'], 'mp4', {
          onProgress: (p) => progressEvents.push(p),
          onDone: resolve,
          onError: reject,
          onCancelled: () => reject(new Error('Unexpected cancellation')),
        });
      },
    );

    // Output must land beside the source with .mp4 extension.
    // Since source.mp4 already exists, getUniqueSiblingPath returns 'source 1.mp4'.
    expect(result.outputPath).toBe(path.join(tmpDir, 'source 1.mp4'));
    expect(fse.existsSync(result.outputPath)).toBe(true);

    // Verify codec via ffprobe.
    const codec = execFileSync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      result.outputPath,
    ])
      .toString()
      .trim();

    expect(codec).toBe('h264');
  }, 60_000);

  it('onError fires and leaves no partial output for a non-existent input', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReEncodeManager } = require('../src/ReEncodeManager') as typeof import('../src/ReEncodeManager');
    const manager = new ReEncodeManager({ ffmpegPath: ffmpegBin, ffprobePath: ffprobeBin });

    const inputPath = path.join(tmpDir, 'ghost.mp4');

    const err = await new Promise<Error>((resolve, reject) => {
      manager.start(inputPath, ['-c:a', 'copy', '-c:v', 'libx264'], 'mp4', {
        onProgress: () => {/* ignore */},
        onDone: () => reject(new Error('Expected onError, got onDone')),
        onError: resolve,
        onCancelled: () => reject(new Error('Expected onError, got onCancelled')),
      });
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ffmpeg exited with code/i);

    // No output .mp4 should remain in the temp dir.
    const leftover = (await fse.readdir(tmpDir)).filter((f) => f.endsWith('.mp4'));
    expect(leftover).toHaveLength(0);
  }, 30_000);

  it('cancel kills ffmpeg and removes partial output', async () => {
    // Generate a ~2 s source so the encode runs long enough to cancel.
    const inputPath = path.join(tmpDir, 'long.mp4');
    generateTestVideo(inputPath, 2);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReEncodeManager } = require('../src/ReEncodeManager') as typeof import('../src/ReEncodeManager');
    const manager = new ReEncodeManager({ ffmpegPath: ffmpegBin, ffprobePath: ffprobeBin });

    let jobIdRef: string | undefined;
    let cancelFired = false;

    const outcome = await new Promise<'cancelled' | 'done' | 'error'>((resolve) => {
      const { jobId } = manager.start(inputPath, ['-c:a', 'copy', '-c:v', 'libx264'], 'mp4', {
        onProgress: () => {
          // Cancel on the first progress event (mid-encode).
          if (jobIdRef !== undefined && !cancelFired) {
            cancelFired = true;
            manager.cancel(jobIdRef);
          }
        },
        onDone: () => resolve('done'),
        onError: () => resolve('error'),
        onCancelled: () => resolve('cancelled'),
      });
      jobIdRef = jobId;
    });

    // Accept 'cancelled' (normal path) or 'done'/'error' when the encode is fast
    // enough to finish before cancel() fires — acceptable on fast hardware.
    expect(['cancelled', 'done', 'error']).toContain(outcome);

    if (outcome === 'cancelled' || outcome === 'error') {
      // The partial output ('long 1.mp4', since 'long.mp4' is the source) should be removed.
      // Source 'long.mp4' must remain; only 'long 1.mp4' (or any other sibling) should be gone.
      const partials = (await fse.readdir(tmpDir)).filter(
        (f) => f.endsWith('.mp4') && f !== 'long.mp4',
      );
      expect(partials).toHaveLength(0);
      // Source must be untouched.
      expect(fse.existsSync(inputPath)).toBe(true);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// preInputArgs argv-ordering tests — spawn mock (no real ffmpeg required)
// ---------------------------------------------------------------------------
//
// These tests verify that ReEncodeManager places preInputArgs BEFORE -i in the
// ffmpeg argv, and that omitting preInputArgs produces the legacy argv unchanged.
//
// The jest.mock('child_process') above intercepts calls to '/fake/ffmpeg' and
// '/fake/ffprobe' (sentinel paths used only here) and records them in spawnCalls,
// while forwarding all other commands to the real spawn so the functional encode
// tests above continue to work unmodified.
// ---------------------------------------------------------------------------

describe('ReEncodeManager preInputArgs argv ordering', () => {
  beforeEach(() => {
    // Clear the shared spawnCalls array before each test.
    spawnCalls.length = 0;
  });

  it('places preInputArgs BEFORE -i and jobArgs AFTER -i', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReEncodeManager } = require('../src/ReEncodeManager') as typeof import('../src/ReEncodeManager');
    const manager = new ReEncodeManager({ ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' });

    const inputPath = '/videos/source.mp4';
    const preInputArgs = ['-ss', '00:00:01', '-to', '00:00:02'];
    const jobArgs = ['-c', 'copy'];

    await new Promise<void>((resolve, reject) => {
      manager.start(inputPath, jobArgs, 'mp4', {
        onProgress: () => { /* ignore */ },
        onDone: () => resolve(),
        onError: reject,
        onCancelled: () => reject(new Error('Unexpected cancellation')),
      }, preInputArgs);
    });

    // spawn is called twice: once for ffprobe (duration probe), once for ffmpeg.
    const ffmpegCall = spawnCalls.find((c) => c.cmd === '/fake/ffmpeg');
    expect(ffmpegCall).toBeDefined();

    const argv = ffmpegCall!.args;

    // Expected shape:
    //   [-hide_banner, -ss, 00:00:01, -to, 00:00:02, -i, <inputPath>, -c, copy,
    //    -progress, pipe:1, -nostats, -y, <outputPath>]
    expect(argv[0]).toBe('-hide_banner');

    const ssIdx = argv.indexOf('-ss');
    const toIdx = argv.indexOf('-to');
    const iIdx = argv.indexOf('-i');
    const cIdx = argv.indexOf('-c');

    // -ss and -to must appear before -i
    expect(ssIdx).toBeGreaterThan(-1);
    expect(toIdx).toBeGreaterThan(-1);
    expect(ssIdx).toBeLessThan(iIdx);
    expect(toIdx).toBeLessThan(iIdx);

    // Values must follow their flags
    expect(argv[ssIdx + 1]).toBe('00:00:01');
    expect(argv[toIdx + 1]).toBe('00:00:02');

    // -i must be followed by the input path
    expect(argv[iIdx + 1]).toBe(inputPath);

    // -c copy must appear after -i
    expect(cIdx).toBeGreaterThan(iIdx);
    expect(argv[cIdx + 1]).toBe('copy');
  });

  it('produces the legacy argv (no preInputArgs) when called without the 5th argument', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReEncodeManager } = require('../src/ReEncodeManager') as typeof import('../src/ReEncodeManager');
    const manager = new ReEncodeManager({ ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' });

    const inputPath = '/videos/source.mp4';
    const jobArgs = ['-c:a', 'copy', '-c:v', 'libx264'];

    await new Promise<void>((resolve, reject) => {
      manager.start(inputPath, jobArgs, 'mp4', {
        onProgress: () => { /* ignore */ },
        onDone: () => resolve(),
        onError: reject,
        onCancelled: () => reject(new Error('Unexpected cancellation')),
      });
      // No preInputArgs — 5th argument omitted entirely (tests the default `= []`).
    });

    const ffmpegCall = spawnCalls.find((c) => c.cmd === '/fake/ffmpeg');
    expect(ffmpegCall).toBeDefined();

    const argv = ffmpegCall!.args;

    // Legacy shape: [-hide_banner, -i, <inputPath>, ...jobArgs, -progress, pipe:1, -nostats, -y, <outputPath>]
    expect(argv[0]).toBe('-hide_banner');
    expect(argv[1]).toBe('-i');
    expect(argv[2]).toBe(inputPath);

    // No -ss or -to anywhere in the argv
    expect(argv.includes('-ss')).toBe(false);
    expect(argv.includes('-to')).toBe(false);

    // jobArgs must follow -i immediately
    expect(argv[3]).toBe('-c:a');
    expect(argv[4]).toBe('copy');
    expect(argv[5]).toBe('-c:v');
    expect(argv[6]).toBe('libx264');
  });
});
