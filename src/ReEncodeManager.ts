/**
 * ReEncodeManager — main-process ffmpeg job runner for media tools (Re-encode x264, Compress & Normalize Audio, …).
 *
 * Responsibilities:
 *   - Compute a collision-free output path beside the source (via getUniqueSiblingPath).
 *   - Spawn ffmpeg with `-hide_banner -progress pipe:1 -nostats` for machine-readable progress.
 *   - Probe source duration via ffprobe for percent progress; fall back to indeterminate.
 *   - Maintain a job registry keyed by jobId so IPC handlers can reference jobs.
 *   - Support `cancel(jobId)`: kill ffmpeg, remove any partial output, report cancellation.
 *   - On failure: remove partial output, surface stderr tail via onError.
 *   - On app quit: kill all live jobs and remove their partial outputs (best-effort).
 *
 * API shape:
 *   - `start(inputPath, jobArgs, outputExt, callbacks, preInputArgs?)` returns `{ jobId, outputPath }`
 *     synchronously (after path computation) and calls `onProgress` / `onDone` / `onError` /
 *     `onCancelled` asynchronously.
 *   - The caller (main.ts IPC handler) provides the ffmpeg codec/filter args, the output
 *     extension, and (optionally) pre-input args (inserted before `-i`); this manager only adds
 *     transport flags around them.
 *   - `preInputArgs` defaults to `[]` so the two existing call sites (reencode-x264,
 *     normalize-audio) are completely unaffected.
 *
 * Codec/filter args are passed in by the caller (defined in the job-spec map in src/main.ts)
 * and are preserved verbatim per INV-018/INV-020. Only transport/progress flags are added
 * around them by this manager.
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { randomUUID } from 'crypto';
import fse from 'fs-extra';
import { getFfmpegPath, getFfprobePath, getUniqueSiblingPath } from '../common/fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReencodeProgress {
  jobId: string;
  /** Encode progress 0–100, or undefined when total duration is unknown. */
  percent: number | undefined;
  /** Encoded seconds so far (from ffmpeg out_time_ms). */
  outTimeSec: number;
  /** Total source duration in seconds, or undefined when probing failed. */
  totalSec: number | undefined;
}

export interface ReencodeResult {
  outputPath: string;
}

export interface ReencodeCallbacks {
  onProgress: (progress: ReencodeProgress) => void;
  onDone: (result: ReencodeResult) => void;
  onError: (err: Error) => void;
  onCancelled: () => void;
}

export interface StartResult {
  jobId: string;
  outputPath: string;
}

// ---------------------------------------------------------------------------
// Internal job registry entry
// ---------------------------------------------------------------------------

interface JobEntry {
  child: ChildProcess;
  outputPath: string;
  /** True once the job has been cancelled — prevents double-cleanup. */
  cancelled: boolean;
  /** Called when cancel() is invoked so the caller gets an outcome event. */
  onCancelled: () => void;
}

// ---------------------------------------------------------------------------
// Progress throttle (max 5 emissions/sec = 200 ms minimum gap)
// ---------------------------------------------------------------------------

const PROGRESS_THROTTLE_MS = 200;

// ---------------------------------------------------------------------------
// ReEncodeManager
// ---------------------------------------------------------------------------

/** Optional path overrides — useful for testing without bundled binaries. */
export interface ReEncodeManagerOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
}

export class ReEncodeManager {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;

  constructor(options?: ReEncodeManagerOptions) {
    this.ffmpegPath = options?.ffmpegPath ?? getFfmpegPath();
    this.ffprobePath = options?.ffprobePath ?? getFfprobePath();
  }

  /**
   * Start a media job (re-encode, normalize audio, clip, etc.).
   *
   * `jobArgs`      — ffmpeg codec/filter args (provided verbatim by the caller; only transport
   *                  flags are added around them by this manager).
   * `outputExt`    — file extension for the output (without leading dot, e.g. `'mp4'`).
   * `preInputArgs` — optional ffmpeg args inserted BEFORE `-i inputPath` in the argv (e.g.
   *                  `['-ss', '00:01:00', '-to', '00:02:00']` for stream-copy clip jobs).
   *                  Defaults to `[]`; omitting it produces the identical argv as before.
   *
   * Returns `{ jobId, outputPath }` immediately after computing the output path.
   * Progress and completion are delivered asynchronously via `callbacks`.
   */
  start(
    inputPath: string,
    jobArgs: string[],
    outputExt: string,
    callbacks: ReencodeCallbacks,
    preInputArgs: string[] = [],
  ): StartResult {
    const dir = path.dirname(inputPath);
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = getUniqueSiblingPath(dir, baseName, outputExt);
    const jobId = randomUUID();

    // Fire-and-forget: probe duration then spawn. We don't await here so that
    // `start()` returns the jobId/outputPath synchronously to the caller.
    this._runJob(jobId, inputPath, outputPath, jobArgs, callbacks, preInputArgs).catch((err) => {
      // If _runJob itself throws before registering the child (unlikely), forward to onError.
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    });

    return { jobId, outputPath };
  }

  /**
   * Cancel a running job: kill the ffmpeg process, remove any partial output,
   * and invoke `onCancelled`.
   */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.cancelled) {
      return;
    }
    job.cancelled = true;
    const { onCancelled } = job;
    this._killAndClean(job);
    this.jobs.delete(jobId);
    // Notify the caller after cleanup so it can release the UI lock.
    onCancelled();
  }

  /**
   * Kill all live jobs and remove their partial outputs.
   * Called from `app.on('before-quit')` in src/main.ts — must be synchronous
   * enough not to block the quit event loop.  We use fse.removeSync (best-effort).
   */
  killAll(): void {
    for (const [jobId, job] of this.jobs.entries()) {
      if (!job.cancelled) {
        job.cancelled = true;
        this._killAndClean(job);
      }
      this.jobs.delete(jobId);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Internal job runner.
   *
   * `preInputArgs` — args inserted BEFORE `-i` in the ffmpeg argv (e.g. `-ss`/`-to` for clip
   *                  jobs). Empty array (the default) produces the identical argv as before
   *                  this parameter was added.
   */
  private async _runJob(
    jobId: string,
    inputPath: string,
    outputPath: string,
    jobArgs: string[],
    callbacks: ReencodeCallbacks,
    preInputArgs: string[] = [],
  ): Promise<void> {
    // Step 1: probe source duration (best-effort; indeterminate on failure).
    const totalSec = await this._probeDuration(inputPath);

    // Step 2: spawn ffmpeg.
    // preInputArgs (e.g. -ss/-to) must come BEFORE -i for correct stream-copy seeking.
    // jobArgs (codec/filter args) are provided verbatim by the caller (job-spec map in main.ts).
    // Only transport/progress flags are added around them here.
    // -y is safe because outputPath was freshly computed to be collision-free.
    const ffmpegArgs = [
      '-hide_banner',
      ...preInputArgs,
      '-i',
      inputPath,
      ...jobArgs,
      '-progress',
      'pipe:1',
      '-nostats',
      '-y',
      outputPath,
    ];

    const child = spawn(this.ffmpegPath, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    const entry: JobEntry = {
      child,
      outputPath,
      cancelled: false,
      onCancelled: callbacks.onCancelled,
    };
    this.jobs.set(jobId, entry);

    // Buffers for progress parsing and stderr capture.
    let stdoutBuf = '';
    let stderrBuf = '';
    let lastProgressEmitAt = 0;
    let lastOutTimeSec = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      // ffmpeg -progress pipe:1 emits key=value lines; each "frame" ends with
      // a `progress=continue` or `progress=end` line.
      const lines = stdoutBuf.split('\n');
      // Keep any incomplete line buffered.
      stdoutBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('out_time_ms=')) {
          const us = parseInt(trimmed.slice('out_time_ms='.length), 10);
          if (!isNaN(us)) {
            lastOutTimeSec = us / 1_000_000;
          }
        }
        if (trimmed === 'progress=continue' || trimmed === 'progress=end') {
          const now = Date.now();
          if (now - lastProgressEmitAt >= PROGRESS_THROTTLE_MS) {
            lastProgressEmitAt = now;
            const percent =
              totalSec !== undefined && totalSec > 0
                ? Math.min(100, (lastOutTimeSec / totalSec) * 100)
                : undefined;
            const job = this.jobs.get(jobId);
            if (job !== undefined && !job.cancelled) {
              callbacks.onProgress({ jobId, percent, outTimeSec: lastOutTimeSec, totalSec });
            }
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      // Keep only the tail (last ~4 KB) to avoid unbounded accumulation.
      if (stderrBuf.length > 4096) {
        stderrBuf = stderrBuf.slice(stderrBuf.length - 4096);
      }
    });

    child.on('error', (spawnErr) => {
      // Emitted when the process could not be spawned (e.g. binary not found).
      const job = this.jobs.get(jobId);
      if (job === undefined || job.cancelled) {
        return;
      }
      this.jobs.delete(jobId);
      fse.remove(outputPath).catch(() => {
        /* best-effort */
      });
      callbacks.onError(spawnErr);
    });

    child.on('close', (code) => {
      const job = this.jobs.get(jobId);
      if (job === undefined || job.cancelled) {
        // Already handled by cancel() or killAll().
        return;
      }
      this.jobs.delete(jobId);

      if (code === 0) {
        callbacks.onDone({ outputPath });
      } else {
        // Remove partial output on failure.
        fse.remove(outputPath).catch(() => {
          /* best-effort */
        });
        const tail = stderrBuf.trim().split('\n').slice(-10).join('\n');
        callbacks.onError(new Error(`ffmpeg exited with code ${code ?? 'null'}.\n${tail}`));
      }
    });
  }

  /**
   * Probe the duration of `inputPath` using ffprobe.
   * Returns seconds, or undefined if probing fails.
   */
  private _probeDuration(inputPath: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nokey=1:noprint_wrappers=1',
        inputPath,
      ];

      let stdout = '';
      let child: ChildProcess;
      try {
        child = spawn(this.ffprobePath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve(undefined);
        return;
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      child.on('close', (code) => {
        if (code !== 0) {
          resolve(undefined);
          return;
        }
        const val = parseFloat(stdout.trim());
        resolve(isNaN(val) ? undefined : val);
      });

      child.on('error', () => {
        resolve(undefined);
      });

      // Timeout: if probing takes more than 10 s, proceed without duration.
      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve(undefined);
      }, 10_000);

      child.on('close', () => clearTimeout(timeout));
    });
  }

  /**
   * Kill a job's child process and synchronously remove its partial output.
   * Safe to call whether or not the child has already exited.
   */
  private _killAndClean(job: JobEntry): void {
    try {
      if (process.platform === 'win32') {
        // On Windows, SIGKILL is not reliable for subprocesses created via
        // `spawn` without `shell: true`. Use taskkill /F /PID for a hard kill.
        if (job.child.pid !== undefined) {
          spawn('taskkill', ['/F', '/PID', String(job.child.pid)], {
            stdio: 'ignore',
            detached: true,
          }).unref();
        }
      } else {
        job.child.kill('SIGKILL');
      }
    } catch {
      // Process may have already exited; ignore.
    }

    // Best-effort synchronous removal of the partial output.
    try {
      if (fse.existsSync(job.outputPath)) {
        fse.removeSync(job.outputPath);
      }
    } catch {
      // Not fatal — the file may still be locked by the dying ffmpeg process.
      // The async cleanup in onDone/onError will not run (job was cancelled),
      // so if this fails the partial file may remain on disk. Acceptable for
      // a before-quit scenario where we're racing process exit anyway.
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance — imported by src/main.ts and (in TASK-076) by IPC handlers.
// ---------------------------------------------------------------------------

export const reEncodeManager = new ReEncodeManager();
