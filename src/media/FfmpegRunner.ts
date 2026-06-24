/**
 * FfmpegRunner — Layer 1 of the media subsystem.
 *
 * The ONE place in the app that spawns the ffmpeg / ffprobe binaries. It knows nothing about
 * the library, the folder watcher, temp staging, or output placement — it just runs a single
 * ffmpeg invocation to completion and streams progress. Higher layers (MediaJobService) decide
 * WHERE the output goes and WHAT happens to it afterward.
 *
 * Responsibilities (and ONLY these):
 *   - Build the ffmpeg argv from a typed spec (preInputArgs before `-i`, jobArgs after).
 *   - Stream machine-readable progress (`-progress pipe:1`) as `out_time` ticks.
 *   - Resolve on exit 0, reject with a stderr-tail Error on non-zero exit or spawn failure.
 *   - Support cancellation via a standard `AbortSignal` (kills the child; rejects with FfmpegAbortError).
 *   - Probe a source's duration via ffprobe.
 */

import { spawn, ChildProcess } from 'child_process';
import { getFfmpegPath, getFfprobePath } from '../../common/fs';

/** A single progress tick from a running ffmpeg job. Percent is computed by the caller. */
export interface FfmpegTick {
  /** Encoded seconds so far (from ffmpeg `out_time_ms`). */
  outTimeSec: number;
}

export interface FfmpegRunOptions {
  /** Absolute path of the input media. */
  input: string;
  /** Absolute path ffmpeg writes to (`-y <output>`). */
  output: string;
  /** Codec/filter args, inserted AFTER `-i input` (provided verbatim by the caller). */
  args: string[];
  /** Args inserted BEFORE `-i input` (e.g. `-ss`/`-to` for stream-copy clip seeking). */
  preInputArgs?: string[];
  /** Called (throttled) as the encode progresses. */
  onProgress?: (tick: FfmpegTick) => void;
  /** Abort to cancel: the child is killed and the run promise rejects with FfmpegAbortError. */
  signal?: AbortSignal;
  /**
   * Kill the child and reject with FfmpegStallError if no `out_time_ms` advance is seen for
   * this many milliseconds. Resets on every genuine `out_time_ms` increase. Default: 60000.
   *
   * Mirror of the renderer-side STALL_TIMEOUT_MS in MediaQueueStore (TASK-154). This main-
   * process backstop fires independently of the renderer watchdog so a wedged ffmpeg child
   * cannot hang the pipeline even if the renderer-side guard is bypassed (INV-038 / TASK-155).
   */
  inactivityTimeoutMs?: number;
}

/**
 * Three-state result from FfmpegRunner.probeFirstAudioCodec.
 *
 *   codec    — ffprobe selected stream a:0 and returned a codec name.
 *   no-audio — ffprobe succeeded but found no a:0 stream (video-only source).
 *   error    — ffprobe exited non-zero, timed out, or could not be spawned.
 *
 * The `error` kind must NOT be collapsed into `no-audio` — doing so would introduce a silent
 * failure path (the fork's philosophy is fail-loud, no silent fallbacks).
 */
export type AudioProbeResult =
  | { kind: 'codec'; codecName: string }
  | { kind: 'no-audio' }
  | { kind: 'error'; error: Error };

/** Thrown by `run()` when the job was cancelled via its AbortSignal (distinct from a real failure). */
export class FfmpegAbortError extends Error {
  constructor() {
    super('FFMPEG_ABORTED');
    this.name = 'FfmpegAbortError';
  }
}

/**
 * Thrown by `run()` when the child produced no `out_time_ms` advance for the inactivity
 * window (distinct from a real failure or a user-initiated abort).
 *
 * The renderer-side stall watchdog (TASK-154) is the primary guard; this error is the
 * main-process backstop so a wedged encode cannot hang `MediaJobService._encode` →
 * `START_MEDIA_JOB` → the renderer `await` even if the renderer watchdog is bypassed.
 */
export class FfmpegStallError extends Error {
  constructor(public readonly idleMs: number) {
    super(`FFMPEG_STALLED: no progress for ${idleMs}ms`);
    this.name = 'FfmpegStallError';
  }
}

/** Max 5 progress emissions/sec. */
const PROGRESS_THROTTLE_MS = 200;

/** Default inactivity timeout: kill and reject if no out_time_ms advance for 60s (INV-038). */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;

export class FfmpegRunner {
  constructor(
    private readonly ffmpegPath: string = getFfmpegPath(),
    private readonly ffprobePath: string = getFfprobePath(),
  ) {}

  /**
   * Run one ffmpeg invocation. Resolves on exit 0; rejects with:
   *   - `FfmpegStallError` if no `out_time_ms` advance is seen for `inactivityTimeoutMs` (default 60s).
   *   - `FfmpegAbortError` if the signal aborts.
   *   - A stderr-tail `Error` on spawn failure or non-zero exit.
   *
   * The inactivity watchdog resets on every genuine `out_time_ms` increase and is armed
   * immediately after spawn so a child that never emits a single tick is also caught.
   * `progress=continue` lines that carry no new `out_time_ms` do NOT reset the watchdog
   * (a child spamming keep-alive lines without encoding is still detected).
   */
  run(opts: FfmpegRunOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new FfmpegAbortError());
        return;
      }

      const argv = [
        '-hide_banner',
        ...(opts.preInputArgs ?? []),
        '-i',
        opts.input,
        ...opts.args,
        '-progress',
        'pipe:1',
        '-nostats',
        '-y',
        opts.output,
      ];

      let child: ChildProcess;
      try {
        child = spawn(this.ffmpegPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const onAbort = () => this.kill(child);
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      // --- Inactivity watchdog ---
      const inactivityMs = opts.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      let stalled = false;
      let lastActivityOutTimeSec = -1;

      const armWatchdog = () => {
        if (stallTimer !== null) {
          clearTimeout(stallTimer);
        }
        stallTimer = setTimeout(() => {
          stallTimer = null;
          stalled = true;
          this.kill(child);
        }, inactivityMs);
      };

      const clearWatchdog = () => {
        if (stallTimer !== null) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };

      // Arm immediately after spawn: catches a child that never emits a single out_time_ms tick.
      armWatchdog();

      const cleanup = () => {
        opts.signal?.removeEventListener('abort', onAbort);
        // Clear the inactivity watchdog so it never fires after the child exits.
        clearWatchdog();
      };

      // --- progress parsing ---
      let stdoutBuf = '';
      let stderrBuf = '';
      let lastEmitAt = 0;
      let lastOutTimeSec = 0;

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('out_time_ms=')) {
            const us = parseInt(trimmed.slice('out_time_ms='.length), 10);
            if (!isNaN(us)) {
              lastOutTimeSec = us / 1_000_000;
              // Reset the inactivity watchdog on genuine forward progress only.
              // A stuck or non-monotonic timestamp does not re-arm (uses > not >=).
              if (lastOutTimeSec > lastActivityOutTimeSec) {
                lastActivityOutTimeSec = lastOutTimeSec;
                armWatchdog();
              }
            }
          } else if (trimmed === 'progress=continue' || trimmed === 'progress=end') {
            const now = Date.now();
            if (opts.onProgress && now - lastEmitAt >= PROGRESS_THROTTLE_MS) {
              lastEmitAt = now;
              opts.onProgress({ outTimeSec: lastOutTimeSec });
            }
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 4096) {
          stderrBuf = stderrBuf.slice(stderrBuf.length - 4096);
        }
      });

      child.on('error', (err) => {
        cleanup();
        reject(err);
      });

      child.on('close', (code) => {
        cleanup();
        // Check stall FIRST — a stall kill looks like a normal child exit (code null / non-zero),
        // so we must branch on the stalled flag before checking signal?.aborted or code === 0.
        if (stalled) {
          reject(new FfmpegStallError(inactivityMs));
        } else if (opts.signal?.aborted) {
          reject(new FfmpegAbortError());
        } else if (code === 0) {
          resolve();
        } else {
          const tail = stderrBuf.trim().split('\n').slice(-10).join('\n');
          reject(new Error(`ffmpeg exited with code ${code ?? 'null'}.\n${tail}`));
        }
      });
    });
  }

  /** Probe the duration of `input` in seconds, or undefined if it cannot be determined. */
  probeDuration(input: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nokey=1:noprint_wrappers=1',
        input,
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

      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve(undefined);
      }, 10_000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          resolve(undefined);
          return;
        }
        const val = parseFloat(stdout.trim());
        resolve(isNaN(val) ? undefined : val);
      });

      child.on('error', () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
    });
  }

  /**
   * Probe the codec name of the first audio stream (a:0) in `input`.
   *
   * Uses ffprobe with `-select_streams a:0 -show_entries stream=codec_name` to get a single
   * codec_name line on stdout. Returns a THREE-state result:
   *
   *   { kind: 'codec', codecName }  — exit 0 + non-empty stdout (a:0 stream found).
   *   { kind: 'no-audio' }          — exit 0 + empty stdout (no audio stream selected).
   *   { kind: 'error', error }      — non-zero exit, spawn failure, or timeout.
   *
   * IMPORTANT: unlike probeDuration, this method does NOT collapse an error into undefined.
   * A probe failure on a file that should have audio must surface a loud error so the job
   * aborts rather than silently assuming the audio is compatible (fail-loud philosophy).
   */
  probeFirstAudioCodec(input: string): Promise<AudioProbeResult> {
    return new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_name',
        '-of',
        'default=nokey=1:noprint_wrappers=1',
        input,
      ];

      let stdout = '';
      let child: ChildProcess;
      try {
        child = spawn(this.ffprobePath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (err) {
        resolve({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        return;
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve({ kind: 'error', error: new Error('ffprobe timed out after 10s') });
      }, 10_000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          resolve({
            kind: 'error',
            error: new Error(`ffprobe exited with code ${code ?? 'null'}`),
          });
          return;
        }
        const codecName = stdout.trim();
        if (codecName === '') {
          resolve({ kind: 'no-audio' });
        } else {
          resolve({ kind: 'codec', codecName });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ kind: 'error', error: err });
      });
    });
  }

  /** Hard-kill a child process (taskkill on Windows, SIGKILL elsewhere). */
  private kill(child: ChildProcess): void {
    try {
      if (process.platform === 'win32') {
        if (child.pid !== undefined) {
          spawn('taskkill', ['/F', '/PID', String(child.pid)], {
            stdio: 'ignore',
            detached: true,
          }).unref();
        }
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      /* process may have already exited */
    }
  }
}
