/**
 * MediaJobService — Layer 2 of the media subsystem.
 *
 * Orchestrates a media job end-to-end on the MAIN process side, with NO knowledge of the
 * renderer, MobX, or the folder watcher:
 *
 *   1. start()  — plan the collision-free final path beside the source AND a temp path in the
 *                 application staging dir; run ffmpeg (Layer 1) into the temp file; report
 *                 `{ tempPath, finalPath }` when it finishes. The file is NOT placed yet.
 *   2. place()  — move the (now renderer-tagged) temp file to its final path. A single move:
 *                 a same-volume rename, or a cross-volume copy+unlink. The renderer suppresses
 *                 the folder watcher for `finalPath` across this window (see LocationStore), so a
 *                 cross-volume copy that briefly grows the destination is never ingested as a
 *                 partial. There is no two-step hidden-staging dance and no atomic-rename trick.
 *   3. cancel() — abort the ffmpeg child (Layer 1) and remove the temp file.
 *
 * Crash safety: the encode-time partial lives ONLY in the application staging dir (swept on app
 * start via sweepTempDir), never in a watched photo folder. A crash during the brief place() copy
 * could leave a partial at finalPath; that is the single, small residual window and is acceptable.
 *
 * This service owns the job registry (jobId -> AbortController + paths + phase). It does NOT
 * decide ffmpeg args — the caller (main.ts MEDIA_JOB_SPECS) provides them verbatim.
 */

import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fse from 'fs-extra';
import { getUniqueSiblingPath, getMediaJobTempPath } from '../../common/fs';
import { FfmpegRunner, FfmpegAbortError } from './FfmpegRunner';

export interface MediaJobProgress {
  jobId: string;
  /** 0–100, or undefined when total duration is unknown. */
  percent: number | undefined;
  outTimeSec: number;
  totalSec: number | undefined;
}

export interface MediaJobStartResult {
  jobId: string;
  tempPath: string;
  finalPath: string;
}

export interface MediaJobCallbacks {
  onProgress: (p: MediaJobProgress) => void;
  /** ffmpeg finished; the file is complete in the staging dir, NOT yet placed. */
  onDone: (result: { tempPath: string; finalPath: string }) => void;
  onError: (err: Error) => void;
  onCancelled: () => void;
}

type Phase = 'encoding' | 'encoded' | 'placing' | 'done';

interface Job {
  abort: AbortController;
  tempPath: string;
  finalPath: string;
  phase: Phase;
  onCancelled: () => void;
}

/** Default application-owned staging dir; overridden by main.ts with app.getPath('temp'). */
const DEFAULT_TEMP_BASE_DIR = path.join(os.tmpdir(), 'onefolder-media-jobs');

export class MediaJobService {
  private readonly jobs = new Map<string, Job>();
  private tempBaseDir = DEFAULT_TEMP_BASE_DIR;

  constructor(private readonly runner: FfmpegRunner = new FfmpegRunner()) {}

  /** Anchor the staging dir to the running application (called once during app init). */
  setTempBaseDir(dir: string): void {
    this.tempBaseDir = dir;
  }

  /** Best-effort sweep of the staging dir on app start; removes files left by a crashed run. */
  async sweepTempDir(): Promise<void> {
    try {
      await fse.emptyDir(this.tempBaseDir);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Start a media job. Returns `{ jobId, tempPath, finalPath }` synchronously; progress and the
   * terminal outcome arrive via `callbacks`. ffmpeg writes into the staging dir, never the
   * watched target folder.
   */
  start(
    inputPath: string,
    jobArgs: string[],
    outputExt: string,
    callbacks: MediaJobCallbacks,
    preInputArgs: string[] = [],
  ): MediaJobStartResult {
    const dir = path.dirname(inputPath);
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const finalPath = getUniqueSiblingPath(dir, baseName, outputExt);
    const { tempPath } = getMediaJobTempPath(this.tempBaseDir, outputExt);
    const jobId = randomUUID();

    this.jobs.set(jobId, {
      abort: new AbortController(),
      tempPath,
      finalPath,
      phase: 'encoding',
      onCancelled: callbacks.onCancelled,
    });

    void this._encode(jobId, inputPath, jobArgs, preInputArgs, callbacks);

    return { jobId, tempPath, finalPath };
  }

  /**
   * Place the finished, renderer-tagged temp file at its final path with a single move.
   * Resolves `{ outputPath }`; on failure removes the temp file and rejects (loud, never silent).
   * The caller must have suppressed the watcher for `finalPath` before calling this.
   */
  async place(jobId: string): Promise<{ outputPath: string }> {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error(`place: job ${jobId} not found`);
    }
    if (job.phase !== 'encoded') {
      throw new Error(`place: job ${jobId} is in phase '${job.phase}', expected 'encoded'`);
    }

    job.phase = 'placing';
    console.info('[media-job] place', { jobId, tempPath: job.tempPath, finalPath: job.finalPath });

    try {
      // Single move: same-volume rename, or cross-volume copy+unlink. overwrite:false never
      // clobbers (finalPath was reserved collision-free at start()).
      await fse.move(job.tempPath, job.finalPath, { overwrite: false });
      if (!(await fse.pathExists(job.finalPath))) {
        throw new Error(`place: move reported success but no file exists at ${job.finalPath}`);
      }
      job.phase = 'done';
      this.jobs.delete(jobId);
      return { outputPath: job.finalPath };
    } catch (err) {
      this.jobs.delete(jobId);
      await fse
        .remove(job.tempPath)
        .catch((e) => console.error('[media-job] place cleanup failed', job.tempPath, e));
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Cancel a job: abort the ffmpeg child (if running) and remove its temp file. */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return;
    }
    if (job.phase === 'encoding') {
      // Abort the live ffmpeg child; _encode's catch removes the temp file and fires onCancelled.
      job.abort.abort();
      return;
    }
    // No live process (encoded/placing): clean up the temp file directly and notify.
    this.jobs.delete(jobId);
    fse
      .remove(job.tempPath)
      .catch((e) => console.error('[media-job] cancel cleanup failed', job.tempPath, e));
    job.onCancelled();
  }

  /** Cancel every live job — called from app `before-quit`. */
  killAll(): void {
    for (const jobId of [...this.jobs.keys()]) {
      this.cancel(jobId);
    }
  }

  // -------------------------------------------------------------------------

  private async _encode(
    jobId: string,
    inputPath: string,
    jobArgs: string[],
    preInputArgs: string[],
    callbacks: MediaJobCallbacks,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return;
    }
    try {
      await fse.ensureDir(this.tempBaseDir);
      const totalSec = await this.runner.probeDuration(inputPath);

      console.info('[media-job] encode start', {
        jobId,
        tempPath: job.tempPath,
        finalPath: job.finalPath,
      });
      await this.runner.run({
        input: inputPath,
        output: job.tempPath,
        args: jobArgs,
        preInputArgs,
        signal: job.abort.signal,
        onProgress: ({ outTimeSec }) => {
          const percent =
            totalSec !== undefined && totalSec > 0
              ? Math.min(100, (outTimeSec / totalSec) * 100)
              : undefined;
          callbacks.onProgress({ jobId, percent, outTimeSec, totalSec });
        },
      });

      // ffmpeg exited 0 — verify it actually produced the file (loud if not).
      if (!(await fse.pathExists(job.tempPath))) {
        throw new Error(`ffmpeg exited 0 but produced no output file at ${job.tempPath}`);
      }

      // The file is complete in staging. The renderer will tag it, then call place().
      if (this.jobs.get(jobId) !== job) {
        return; // cancelled and removed while we were finishing
      }
      job.phase = 'encoded';
      console.info('[media-job] encode done', { jobId, tempPath: job.tempPath });
      callbacks.onDone({ tempPath: job.tempPath, finalPath: job.finalPath });
    } catch (err) {
      this.jobs.delete(jobId);
      await fse
        .remove(job.tempPath)
        .catch((e) => console.error('[media-job] encode cleanup failed', job.tempPath, e));
      if (err instanceof FfmpegAbortError) {
        callbacks.onCancelled();
      } else {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}

/** Singleton — imported by src/main.ts. */
export const mediaJobService = new MediaJobService();
