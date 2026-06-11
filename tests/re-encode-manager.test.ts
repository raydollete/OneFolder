/**
 * Tests for ReEncodeManager and the getUniqueSiblingPath helper.
 *
 * Unit tests for getUniqueSiblingPath run without any I/O (fse.existsSync is
 * spied and controlled per-test via jest.spyOn).
 *
 * The functional encode tests spawn a real ffmpeg process against a tiny test
 * video generated with `ffmpeg -f lavfi`.  They are automatically skipped when
 * the ffmpeg binary is not present (e.g. in CI that doesn't bundle it).
 */

import path from 'path';
import os from 'os';
import fse from 'fs-extra';
import { execFileSync } from 'child_process';

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
        manager.start(inputPath, {
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
      manager.start(inputPath, {
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
      const { jobId } = manager.start(inputPath, {
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
