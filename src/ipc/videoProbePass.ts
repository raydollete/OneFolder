/**
 * Background video codec probe pass (change: support-mov-playback).
 *
 * Pure orchestration around `FfmpegRunner.probeFirstVideoCodec`, extracted so
 * it is unit-testable with a mocked runner (tests/mov-probe-pass.test.ts) and
 * so the main-process handler stays a one-liner.
 *
 * Discipline (mirrors the fork's fail-loud probe rules, INV-032):
 *   - Low priority: one file at a time, yielding the event loop between spawns.
 *   - The cache key is (path, size, mtime) plus the MOV_CODEC_VERSION stamp:
 *     a file whose stored stamp still matches its live stat spawns NOTHING.
 *   - A probe `error` (ffprobe missing, timeout, non-zero exit) is logged
 *     LOUDLY and the row stays NULL — an unknown verdict is never persisted
 *     and never presented as unplayable.
 *   - `no-video` (audio-only source) also leaves the row NULL; it is not an
 *     error and must not spam the log at error level.
 *
 * Deliberately NOT wired into addFile/ingestFile or MediaJobService.place:
 * probing from those paths races the folder watcher (red lines in
 * .planning/codebase/CONCERNS.md:55-65). It runs after location load only,
 * and only in the desktop build — the read-only sidecar never probes.
 */

import { isFileExtensionVideo } from '../../common/fs';
import { MOV_CODEC_VERSION } from '../api/file';
import type { VideoProbeResult } from '../media/FfmpegRunner';
import type { VideoProbeCandidate, VideoProbeUpdate } from './messages';

/** Structural view of the probe method — keeps the pass testable without spawning. */
export interface VideoCodecProbeRunner {
  probeFirstVideoCodec(input: string): Promise<VideoProbeResult>;
}

export interface ProbePassDeps {
  runner: VideoCodecProbeRunner;
  /** Stat for the staleness check; rejects for missing/unreadable files. */
  stat: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  /** Yields between spawns so the pass stays low-priority (setImmediate in prod). */
  yieldToEventLoop?: () => Promise<void>;
  /** Injectable logging seams (tests); default to console. */
  logError?: (message: string, err: unknown) => void;
  logInfo?: (message: string) => void;
}

/** The probe stamp recorded with a fresh verdict: "MOV_CODEC_VERSION:size:mtimeMs". */
export function buildProbeStamp(size: number, mtimeMs: number): string {
  return `${MOV_CODEC_VERSION}:${size}:${mtimeMs}`;
}

/**
 * True when `stored` cannot be trusted against the live (size, mtime): absent,
 * stamped by an older codec table, or the file changed on disk since the probe.
 */
export function isProbeStale(stored: string | null, size: number, mtimeMs: number): boolean {
  if (stored === null || stored === '') {
    return true;
  }
  const [version, sizeStr, mtimeStr] = stored.split(':');
  return (
    version !== String(MOV_CODEC_VERSION) ||
    Number(sizeStr) !== size ||
    Number(mtimeStr) !== mtimeMs
  );
}

/** Minimal DB-row shape the renderer trigger reads (structurally FileDTO-compatible). */
export interface ProbeRowSource {
  id: string;
  extension: string;
  locationId: string;
  relativePath: string;
  codecVersion?: string | null;
}

/**
 * Build probe candidates from the DB's canonical rows, NOT from the renderer's
 * materialized file list: the gallery materializes progressively and at
 * startup the list is empty until after ingest — a fileList-based trigger
 * silently probes nothing (the exact defect this replaces). `resolvePath`
 * supplies the absolutePath recomputed from the current-OS location root
 * (same normalization reconcile does); rows whose location is unknown are
 * skipped — they cannot be stat'ed.
 */
export function buildProbeCandidatesFromRows<T extends ProbeRowSource>(
  rows: readonly T[],
  resolvePath: (row: T) => string | undefined,
): VideoProbeCandidate[] {
  const candidates: VideoProbeCandidate[] = [];
  for (const row of rows) {
    if (!isFileExtensionVideo(row.extension)) {
      continue;
    }
    const absolutePath = resolvePath(row);
    if (absolutePath === undefined) {
      continue;
    }
    candidates.push({ id: row.id, absolutePath, codecVersion: row.codecVersion ?? null });
  }
  return candidates;
}

/**
 * Patched copies of `rows` reflecting `updates`, for persisting rows that are
 * not yet materialized as ClientFiles (the dirty-flusher cannot persist what
 * is not in memory). Rows with no update are left out entirely — untouched
 * rows are never rewritten; update ids for deleted rows are ignored.
 */
export function applyProbeUpdatesToRows<T extends ProbeRowSource>(
  rows: readonly T[],
  updates: readonly VideoProbeUpdate[],
): T[] {
  if (updates.length === 0) {
    return [];
  }
  const byId = new Map(updates.map((u) => [u.id, u]));
  const patched: T[] = [];
  for (const row of rows) {
    const update = byId.get(row.id);
    if (update === undefined) {
      continue;
    }
    patched.push({
      ...row,
      videoCodec: update.videoCodec,
      audioCodec: update.audioCodec,
      formatName: update.formatName,
      codecVersion: update.codecVersion,
    });
  }
  return patched;
}

/**
 * Run the pass over `candidates`, sequentially, yielding between files.
 * Returns only the rows that need writing; everything skipped or failed stays
 * untouched in the DB (NULL ⇄ unprobed).
 */
export async function runVideoCodecProbePass(
  candidates: readonly VideoProbeCandidate[],
  deps: ProbePassDeps,
): Promise<VideoProbeUpdate[]> {
  const logError = deps.logError ?? ((message, err) => console.error(message, err));
  const logInfo = deps.logInfo ?? ((message) => console.info(message));
  const yieldToEventLoop =
    deps.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));

  const updates: VideoProbeUpdate[] = [];

  for (const candidate of candidates) {
    await yieldToEventLoop();

    let stats: { size: number; mtimeMs: number };
    try {
      stats = await deps.stat(candidate.absolutePath);
    } catch (err) {
      // File vanished (or is unreadable) mid-pass: loud log, row stays as-is —
      // the watcher/reconciliation owns that lifecycle, the probe pass does not.
      logError(`Video codec probe: stat failed for ${candidate.absolutePath}`, err);
      continue;
    }

    if (!isProbeStale(candidate.codecVersion, stats.size, stats.mtimeMs)) {
      continue; // fresh verdict — zero spawns for unchanged, version-current files
    }

    const result = await deps.runner.probeFirstVideoCodec(candidate.absolutePath);
    if (result.kind === 'codec') {
      updates.push({
        id: candidate.id,
        videoCodec: result.videoCodec,
        audioCodec: result.audioCodec,
        // Explicit null when the probe ran but its format section carried no
        // container string — never omitted, so the store never keeps a stale
        // container fact for a re-probed file.
        formatName: result.formatName,
        codecVersion: buildProbeStamp(stats.size, stats.mtimeMs),
      });
    } else if (result.kind === 'no-video') {
      // Not an error; the row stays NULL (unprobed) — never a verdict.
      logInfo(`Video codec probe: no video stream in ${candidate.absolutePath}, leaving unprobed`);
    } else {
      // Fail LOUD, persist nothing: an ffprobe failure must never surface as
      // "Not playable" (INV-032 mirror — error is never folded into a verdict).
      logError(
        `Video codec probe FAILED for ${candidate.absolutePath}; row stays unprobed (NULL)`,
        result.error,
      );
    }
  }

  return updates;
}
