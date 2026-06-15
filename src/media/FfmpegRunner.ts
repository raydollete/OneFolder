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
}

/** Thrown by `run()` when the job was cancelled via its AbortSignal (distinct from a real failure). */
export class FfmpegAbortError extends Error {
  constructor() {
    super('FFMPEG_ABORTED');
    this.name = 'FfmpegAbortError';
  }
}

/** Max 5 progress emissions/sec. */
const PROGRESS_THROTTLE_MS = 200;

export class FfmpegRunner {
  constructor(
    private readonly ffmpegPath: string = getFfmpegPath(),
    private readonly ffprobePath: string = getFfprobePath(),
  ) {}

  /**
   * Run one ffmpeg invocation. Resolves on exit 0; rejects with FfmpegAbortError if the signal
   * aborts, or a stderr-tail Error on spawn failure / non-zero exit.
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
      const cleanup = () => opts.signal?.removeEventListener('abort', onAbort);

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
        if (opts.signal?.aborted) {
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
