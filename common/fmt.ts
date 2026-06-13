///////////////////////////////
//// Text formatting utils ////
///////////////////////////////
export function formatTagCountText(numTags: number) {
  const extraTagsText = numTags > 1 ? `+${numTags} tag${numTags === 1 ? '' : 's'}` : '';
  return `${extraTagsText}`;
}

export function capitalize(value: string) {
  if (value.length === 0) {
    return '';
  }
  return `${value.charAt(0).toLocaleUpperCase()}${value.slice(1)}`;
}

export function camelCaseToSpaced(value: string) {
  if (!value) {
    return '';
  }
  return (
    value
      // insert a space before all caps
      .replace(/([A-Z])/g, ' $1')
      // uppercase the first character
      .replace(/^./, (str) => str.toUpperCase())
  );
}

export function ellipsize(
  value: string,
  maxLength = 80,
  type: 'start' | 'middle' | 'end' = 'start',
) {
  if (value.length <= maxLength) {
    return value;
  }
  switch (type) {
    case 'end':
      return value.slice(maxLength) + '…';
    case 'middle':
      return value.slice(0, maxLength / 2) + '…' + value.slice(value.length - maxLength / 2);
    case 'start':
    default:
      return '…' + value.slice(value.length - maxLength);
  }
}

/////////////////////////
//// Date/time utils ////
/////////////////////////
const DateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(d: Date) {
  return DateTimeFormat.formatToParts(d)
    .map(({ type, value }) => (type === 'literal' && value === ', ' ? ' ' : value))
    .reduce((str, part) => str + part);
}

const DateTimeFormatShort = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTimeShort(d: Date) {
  return DateTimeFormatShort.formatToParts(d)
    .map(({ type, value }) => (type === 'literal' && value === ', ' ? ' ' : value))
    .reduce((str, part) => str + part);
}

const DateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

export function formatDate(d: Date) {
  return DateFormat.formatToParts(d)
    .map(({ type, value }) => (type === 'literal' && value === ', ' ? ' ' : value))
    .reduce((str, part) => str + part);
}

export const jsDateFormatter = {
  formatDate: (date: Date) => date.toLocaleDateString(),
  parseDate: (str: string) => new Date(str),
  placeholder: 'Choose a date...',
};

/** Returns date in YYYYMMDDTHHMMSS format (ISO-string without symbols and milliseconds) */
export function getFilenameFriendlyFormattedDateTime(date: Date) {
  return date.toISOString().replaceAll(/-|:/g, '').slice(0, -5);
}

///////////////////////////////
//// HH:MM:SS time helpers ////
///////////////////////////////

/**
 * Parse an `HH:MM:SS` time string to total seconds.
 *
 * Accepts HH with 2 or more digits (e.g. `01:30:00`, `100:00:00`).
 * MM and SS must each be in the range 0–59.
 * Returns `null` for any malformed, empty, or out-of-range input.
 * Pure — no imports, usable in both main and renderer.
 */
export function parseHmsToSeconds(s: string): number | null {
  if (!s) {
    return null;
  }
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)$/.exec(s);
  if (match === null) {
    return null;
  }
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Format a duration in seconds to `HH:MM:SS` (zero-padded, always 2-digit MM and SS).
 *
 * Clamps negative values and NaN to `00:00:00`.
 * Floors fractional seconds (e.g. 3661.9 → `01:01:01`).
 * Pure — no imports, usable in both main and renderer.
 */
export function formatSecondsToHms(sec: number): string {
  const total = isNaN(sec) || sec < 0 ? 0 : Math.floor(sec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Format bytes as human-readable text.
 * From: https://stackoverflow.com/a/14919494/2350481
 * @param bytes Number of bytes.
 * @param si True to use metric (SI) units, aka powers of 1000. False to use
 *           binary (IEC), aka powers of 1024.
 * @param dp Number of decimal places to display.
 * @return Formatted string.
 */
export function humanFileSize(bytes: number, si = false, dp = 1) {
  const thresh = si ? 1000 : 1024;

  if (Math.abs(bytes) < thresh) {
    return bytes + ' B';
  }

  const units = si
    ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
    : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
  let u = -1;
  const r = 10 ** dp;

  do {
    bytes /= thresh;
    ++u;
  } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

  return bytes.toFixed(dp) + ' ' + units[u];
}
