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

import { spawn, execFile, ChildProcess } from 'child_process';
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
   * this many milliseconds. Resets on every genuine `out_time_ms` increase. Default: 240000.
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

/**
 * Four-state result from FfmpegRunner.probeFirstVideoCodec (the fourth state, 'unprobed', is
 * the ABSENCE of a stored verdict at the persistence layer and is never produced here).
 *
 *   codec    — ffprobe selected stream v:0 and returned its codec name (audioCodec is the
 *              a:0 codec name when an audio stream exists, null when it does not; formatName
 *              is the container's ffprobe format format_name — 'mpegts', 'matroska,webm',
 *              'mov,mp4,m4a,3gp,3g2,mj2', … — or null when the format section carried none).
 *   no-video — ffprobe succeeded but found no v:0 stream (audio-only source).
 *   error    — ffprobe exited non-zero, timed out, could not be spawned, or printed
 *              unparseable output.
 *
 * The `error` kind must NOT be collapsed into `no-video` — doing so would introduce a silent
 * failure path (the fork's philosophy is fail-loud, no silent fallbacks; INV-032).
 */
export type VideoProbeResult =
  | { kind: 'codec'; videoCodec: string; audioCodec: string | null; formatName: string | null }
  | { kind: 'no-video' }
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

/** Default inactivity timeout: kill and reject if no out_time_ms advance for 240s (INV-038). */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 240_000;

const NVIDIA_SMI = 'nvidia-smi';

/**
 * Picks the NVENC encoder GPU from `nvidia-smi --query-gpu=uuid,name
 * --format=csv,noheader` output: the FIRST GeForce (consumer) card. Rationale
 * (owner, 2026-10-27): workstation GPUs — e.g. an RTX PRO 6000 — are usually
 * reserved for other workloads with their VRAM fully committed, and NVENC
 * jobs on the default device crawl behind that compute. Returns undefined
 * when no GeForce row exists (single-GPU or workstation-only machines keep
 * ffmpeg's default device) or the output is unparseable — absence means "do
 * not pin", never a silent guess (INV-032 discipline).
 */
export function pickPreferredGpuUuid(smiCsv: string): string | undefined {
  for (const line of smiCsv.split(/\r?\n/)) {
    const comma = line.indexOf(',');
    if (comma <= 0) {
      continue;
    }
    const uuid = line.slice(0, comma).trim();
    const name = line.slice(comma + 1);
    if (uuid.startsWith('GPU-') && /geforce/i.test(name)) {
      return uuid;
    }
  }
  return undefined;
}

export class FfmpegRunner {
  constructor(
    private readonly ffmpegPath: string = getFfmpegPath(),
    private readonly ffprobePath: string = getFfprobePath(),
  ) {}

  /** Cached NVENC device-probe promise: nvidia-smi runs once per runner. */
  private nvencDevicePromise: Promise<Record<string, string> | undefined> | undefined;

  /**
   * Env overlay pinning NVENC to the preferred GPU (see
   * pickPreferredGpuUuid). Precedence: explicit `ONEFOLDER_NVENC_GPU`
   * (a CUDA_VISIBLE_DEVICES value — GPU UUID or index) wins, un-cached;
   * otherwise the first GeForce card from nvidia-smi, cached per runner;
   * a failed/absent probe logs loudly and pins NOTHING (ffmpeg default).
   */
  private nvencDeviceEnv(): Promise<Record<string, string> | undefined> {
    const explicit = process.env.ONEFOLDER_NVENC_GPU;
    if (explicit !== undefined && explicit !== '') {
      return Promise.resolve({ CUDA_VISIBLE_DEVICES: explicit });
    }
    if (this.nvencDevicePromise === undefined) {
      this.nvencDevicePromise = new Promise((resolve) => {
        execFile(
          NVIDIA_SMI,
          ['--query-gpu=uuid,name', '--format=csv,noheader'],
          { timeout: 5000 },
          (err, stdout) => {
            if (err) {
              console.warn(
                '[NVENC] nvidia-smi probe failed; encoder uses the ffmpeg default GPU:',
                err.message,
              );
              resolve(undefined);
              return;
            }
            const uuid = pickPreferredGpuUuid(stdout);
            if (uuid === undefined) {
              resolve(undefined);
              return;
            }
            console.info(`[NVENC] encoder pinned to GeForce GPU ${uuid}`);
            resolve({ CUDA_VISIBLE_DEVICES: uuid });
          },
        );
      });
    }
    return this.nvencDevicePromise;
  }

  /**
   * Run one ffmpeg invocation. Resolves on exit 0; rejects with:
   *   - `FfmpegStallError` if no `out_time_ms` advance is seen for `inactivityTimeoutMs` (default 240s).
   *   - `FfmpegAbortError` if the signal aborts.
   *   - A stderr-tail `Error` on spawn failure or non-zero exit.
   *
   * The inactivity watchdog resets on every genuine `out_time_ms` increase and is armed
   * immediately after spawn so a child that never emits a single tick is also caught.
   * `progress=continue` lines that carry no new `out_time_ms` do NOT reset the watchdog
   * (a child spamming keep-alive lines without encoding is still detected).
   */
  async run(opts: FfmpegRunOptions): Promise<void> {
    if (opts.signal?.aborted) {
      throw new FfmpegAbortError();
    }
    // NVENC device pinning resolves BEFORE spawn (probed once per runner,
    // cached). Harmless for CPU-filter jobs: it only sets CUDA_VISIBLE_DEVICES.
    const deviceEnv = await this.nvencDeviceEnv();
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
        child = spawn(this.ffmpegPath, argv, {
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(deviceEnv !== undefined ? { env: { ...process.env, ...deviceEnv } } : {}),
        });
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

  /**
   * Probe the codec names of the first video stream and the first audio stream AND
   * the container identity of `input` with ONE ffprobe spawn — `-show_entries
   * format=format_name:stream=codec_type,codec_name -of json`, and deliberately NO
   * `-select_streams` (repeated selectors clobber on the bundled ffprobe n8.1.3; the
   * parser below picks the first video and first audio stream). JSON output (instead of
   * the wrapper-stripping default format) so the format section and the stream section
   * parse unambiguously from the same process; no extra spawn.
   * Returns a THREE-state result:
   *
   *   { kind: 'codec', videoCodec, audioCodec, formatName } — exit 0 + a video stream found
   *                                               (audioCodec is null when no audio stream was
   *                                               emitted; formatName is the container's
   *                                               format format_name, null when absent).
   *   { kind: 'no-video' }                      — exit 0 + no video stream (audio-only source).
   *   { kind: 'error', error }                  — non-zero exit, spawn failure, 'error'
   *                                               event, 10s timeout, or unparseable JSON.
   *
   * This method yields codec | no-video | error; the fourth state of the playability system,
   * 'unprobed', is the ABSENCE of a stored verdict at the persistence layer and is never
   * produced here. IMPORTANT: like probeFirstAudioCodec, this method does NOT collapse an
   * error into no-video — a probe failure must surface a loud error so playability is never
   * silently downgraded (fail-loud philosophy, INV-032).
   */
  probeFirstVideoCodec(input: string): Promise<VideoProbeResult> {
    return new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-show_entries',
        'format=format_name:stream=codec_type,codec_name',
        '-of',
        'json',
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
        const trimmed = stdout.trim();
        if (trimmed === '') {
          // Exit 0 with no output at all: nothing was reported, so no video stream exists.
          resolve({ kind: 'no-video' });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (err) {
          // Unparseable output is a probe failure, never a 'no-video' verdict (INV-032).
          resolve({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) });
          return;
        }
        const root = (parsed ?? {}) as {
          streams?: unknown;
          format?: { format_name?: unknown };
        };
        const streams = Array.isArray(root.streams) ? root.streams : [];
        let videoCodec: string | null = null;
        let audioCodec: string | null = null;
        for (const stream of streams) {
          if (typeof stream !== 'object' || stream === null) {
            continue;
          }
          const { codec_type: type, codec_name: name } = stream as {
            codec_type?: unknown;
            codec_name?: unknown;
          };
          if (typeof type !== 'string' || typeof name !== 'string') {
            continue;
          }
          if (type === 'video' && videoCodec === null) {
            videoCodec = name;
          } else if (type === 'audio' && audioCodec === null) {
            audioCodec = name;
          }
        }
        const rawFormatName = root.format?.format_name;
        const formatName =
          typeof rawFormatName === 'string' && rawFormatName !== '' ? rawFormatName : null;
        if (videoCodec === null) {
          resolve({ kind: 'no-video' });
        } else {
          resolve({ kind: 'codec', videoCodec, audioCodec, formatName });
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
