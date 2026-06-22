import { MediaJobType } from '../../ipc/messages';

/**
 * Human-readable operation name for each media job type.
 * Used as the base label in toast messages and the queue drawer's Operation column.
 *
 * The `Record<MediaJobType, string>` type ensures this map is exhaustive: adding a new
 * MediaJobType to messages.ts will cause a compile error here until the map is updated.
 */
const JOB_LABEL: Record<MediaJobType, string> = {
  'reencode-x264': 'Re-encode',
  'normalize-audio': 'Compress & normalize audio',
  'create-clip': 'Create clip',
  'subtract-clip': 'Subtract clip',
  'rotate-cw': 'Rotate clockwise',
  'rotate-ccw': 'Rotate counterclockwise',
};

/**
 * Returns the base operation label for a media job type (e.g. "Re-encode",
 * "Compress & normalize audio"). Suitable for toast messages and the Operation
 * column in the queue drawer.
 */
export function mediaJobLabel(jobType: MediaJobType): string {
  return JOB_LABEL[jobType];
}

/**
 * Returns the in-progress spinner label for a media job type.
 * Pass the current ffmpeg `percent` (0–100) when available, or `null` for indeterminate.
 * Pass `isFinalizing: true` after ffmpeg exits but before the output is committed —
 * all job types show "Finalizing…" during that phase.
 */
export function mediaJobProgressLabel(
  jobType: MediaJobType,
  percent: number | null,
  isFinalizing: boolean,
): string {
  if (isFinalizing) {
    return 'Finalizing…';
  }
  const gerund = jobTypeGerund(jobType);
  return percent !== null ? `${gerund}… ${percent}%` : `${gerund}…`;
}

/**
 * Returns the cancel button tooltip for a media job type
 * (e.g. "Cancel re-encode", "Cancel audio compression & normalization").
 */
export function mediaJobCancelTitle(jobType: MediaJobType): string {
  switch (jobType) {
    case 'normalize-audio':
      return 'Cancel audio compression & normalization';
    case 'create-clip':
      return 'Cancel clip';
    case 'subtract-clip':
      return 'Cancel subtract clip';
    case 'rotate-cw':
    case 'rotate-ccw':
      return 'Cancel rotate';
    case 'reencode-x264':
      return 'Cancel re-encode';
    default: {
      // Exhaustiveness guard: TypeScript will error if a new MediaJobType is added
      // without a case above.
      const _exhaustive: never = jobType;
      return `Cancel ${_exhaustive}`;
    }
  }
}

/**
 * Returns a lowercase gerund phrase for the given job type, used to build
 * progress strings like "Re-encoding… 42%".
 */
function jobTypeGerund(jobType: MediaJobType): string {
  switch (jobType) {
    case 'reencode-x264':
      return 'Re-encoding';
    case 'normalize-audio':
      return 'Compressing & normalizing audio';
    case 'create-clip':
      return 'Creating clip';
    case 'subtract-clip':
      return 'Subtracting clip';
    case 'rotate-cw':
      return 'Rotating clockwise';
    case 'rotate-ccw':
      return 'Rotating counterclockwise';
    default: {
      const _exhaustive: never = jobType;
      return String(_exhaustive);
    }
  }
}
