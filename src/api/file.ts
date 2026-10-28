import { ID } from './id';

export type FileDTO = {
  id: ID;
  /** Identifier for a file that persists after renaming/moving (retrieved from fs.Stats.ino) */
  ino: string;
  locationId: ID;
  /** Path relative to Location */
  relativePath: string;
  absolutePath: string;
  tags: ID[];
  /** When the file was imported into OneFolder */
  dateAdded: Date;
  /** When the file was modified in OneFolder, not related to OS modified date */
  dateModified: Date;
  /**
   * When the file was last indexed in OneFolder: concerning the metadata and thumbnail.
   * If the system's modified date of the file exceeds this date, those properties shoudld be re-initialized
   **/
  dateLastIndexed: Date;

  /** Duplicate data; also exists as part of the absolutePath. Used for DB queries */
  name: string;
  /** in lowercase, without the dot */
  extension: IMG_EXTENSIONS_TYPE;
  /** Size in bytes */
  size: number;
  width: number;
  height: number;
  /** Date when this file was created (from the OS, not related to OneFolder) */
  dateCreated: Date;

  /** file annotations in W3C WebAnnotation model. */
  annotations: string;
  /** ffprobe codec_name of the first video stream (v:0), e.g. 'h264', 'hevc'. null/undefined = not probed. */
  videoCodec?: string | null;
  /** ffprobe codec_name of the first audio stream (a:0), e.g. 'aac', 'mp3', 'opus', 'vorbis'. null/undefined = not probed or no audio stream. */
  audioCodec?: string | null;
  /** Probe stamp recorded alongside the codecs: `MOV_CODEC_VERSION:size:mtimeMs`
   *  captured at probe time; null/undefined = not probed. Stale when the version
   *  prefix differs from MOV_CODEC_VERSION or the size/mtime components differ
   *  from the live stat — the background pass re-probes only stale rows. */
  codecVersion?: string | null;
  /** ffprobe format format_name of the container, e.g. 'mov', 'matroska,webm', 'mpegts'. null = not probed. */
  formatName?: string | null;
};

export const IMG_EXTENSIONS = [
  'gif',
  'png',
  'apng',
  'jpg',
  'jpeg',
  'jfif',
  'webp',
  'tif',
  'tiff',
  'bmp',
  'ico',
  'svg',
  'psd',
  'kra',

  // 'xcf', // Gimp
  'exr', // OpenEXR
  // 'raw', there are many RAW file extensions :( https://fileinfo.com/filetypes/camera_raw
  // 'avif',
  'heic', // not supported by Sharp out of the box https://github.com/lovell/sharp/issues/2871
  // TODO: 'blend', raw, etc.?
  'mp4',
  'webm',
  'ogg',
  'mov',
  'mkv',
  'ts',
] as const;

/** Version of the codec table used for playability derivation; bumping it
 *  invalidates stored probe stamps (FileDTO.codecVersion). */
export const MOV_CODEC_VERSION = 1;

export type IMG_EXTENSIONS_TYPE = (typeof IMG_EXTENSIONS)[number];
