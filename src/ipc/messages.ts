import { ID } from '../api/id';
import { TagDTO } from '../api/tag';
import { ViewMethod } from '../frontend/stores/UiStore';

/**
 * All types of messages between the main and renderer process in one place, with type safety.
 */
export type SYSTEM_PATHS =
  | 'home'
  | 'appData'
  | 'userData'
  | 'temp'
  | 'exe'
  | 'module'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | 'logs';

/////////////////// General ////////////////////
export const INITIALIZED = 'INITIALIZED';
export const CLEAR_DATABASE = 'CLEAR_DATABASE';
export const TOGGLE_DEV_TOOLS = 'TOGGLE_DEV_TOOLS';
export const RELOAD = 'RELOAD';
export const OPEN_DIALOG = 'OPEN_DIALOG';
export const MESSAGE_BOX = 'MESSAGE_BOX';
export const MESSAGE_BOX_SYNC = 'MESSAGE_BOX_SYNC';
export const GET_PATH = 'GET_PATH';
export const TRASH_FILE = 'TRASH_FILE';
export const DELETE_FILE_PERMANENTLY = 'DELETE_FILE_PERMANENTLY';
export const CHECK_RECYCLABLE = 'CHECK_RECYCLABLE';
export const SET_FULL_SCREEN = 'SET_FULL_SCREEN';
export const IS_FULL_SCREEN = 'IS_FULL_SCREEN';
export const FULL_SCREEN_CHANGED = 'FULL_SCREEN_CHANGED';
export const SET_ZOOM_FACTOR = 'SET_ZOOM_FACTOR';
export const GET_ZOOM_FACTOR = 'GET_ZOOM_FACTOR';
export const WINDOW_MAXIMIZE = 'WINDOW_MAXIMIZE';
export const WINDOW_UNMAXIMIZE = 'WINDOW_UNMAXIMIZE';
export const WINDOW_FOCUS = 'WINDOW_FOCUS';
export const WINDOW_BLUR = 'WINDOW_BLUR';
export const IS_MAXIMIZED = 'IS_MAXIMIZED';

/////////////////// Window system buttons ////////////////////
export const WINDOW_SYSTEM_BUTTON_PRESS = 'WINDOW_SYSTEM_BUTTON_PRESS';
export const enum WindowSystemButtonPress {
  Minimize,
  Restore,
  Maximize,
  Close,
}

//////// Main proces (browser extension) ////////
export const GET_TAGS = 'GET_TAGS';
export const RECEIVE_TAGS = 'RECEIVE_TAGS';
export type TagsMessage = {
  tags: TagDTO[];
};

export const STORE_FILE = 'STORE_FILE';
export type StoreFileMessage = {
  directory: string;
  filenameWithExt: string;
  imgBase64: string;
};

export const STORE_FILE_REPLY = 'STORE_FILE_REPLY';
export type StoreFileReplyMessage = {
  downloadPath: string;
};

export const IMPORT_EXTERNAL_IMAGE = 'IMPORT_EXTERNAL_IMAGE';

export const ADD_TAGS_TO_FILE = 'ADD_TAGS_TO_FILE';

//////////////// Preview window ////////////////
export const CLOSED_PREVIEW_WINDOW = 'CLOSED_PREVIEW_WINDOW';

export const SEND_PREVIEW_FILES = 'SEND_PREVIEW_FILES_MESSAGE';
export const RECEIEVE_PREVIEW_FILES = 'RECEIEVE_PREVIEW_FILES_MESSAGE';
export type PreviewFilesMessage = {
  ids: ID[];
  activeImgId?: ID;
  thumbnailDirectory: string;
  viewMethod: ViewMethod;
};

/////////////// Drag n drop export ///////////////
export const DRAG_EXPORT = 'DRAG_EXPORT';
export type DragExportMessage = string[];

//////////////////// Settings ////////////////////
export const IS_CLIP_SERVER_RUNNING = 'IS_CLIP_SERVER_RUNNING';
export const SET_CLIP_SERVER_ENABLED = 'SET_CLIP_SERVER_ENABLED';
export const SET_CLIP_SERVER_IMPORT_LOCATION = 'SET_CLIP_SERVER_IMPORT_LOCATION';
export type ClipServerEnabledMessage = {
  isClipServerRunning: boolean;
};

export const SET_THEME = 'SET_THEME';
export type ThemeMessage = {
  theme: 'light' | 'dark';
};

export const IS_RUNNING_IN_BACKGROUND = 'IS_RUN_IN_BACKGROUND';
export const SET_RUN_IN_BACKGROUND = 'SET_RUN_IN_BACKGROUND';
export type RunInBackgroundMessage = {
  isRunInBackground: boolean;
};

export const GET_VERSION = 'GET_VERSION';
export const CHECK_FOR_UPDATES = 'CHECK_FOR_UPDATES';
export const TOGGLE_CHECK_UPDATES_ON_STARTUP = 'TOGGLE_CHECK_UPDATES_ON_STARTUP';
export const IS_CHECK_UPDATES_ON_STARTUP_ENABLED = 'IS_CHECK_UPDATES_ON_STARTUP_ENABLED';
export const IS_PORTABLE_MODE = 'IS_PORTABLE_MODE';

//////////////// Library management ////////////////
export const GET_LIBRARIES = 'GET_LIBRARIES';
export const GET_ACTIVE_LIBRARY_ID = 'GET_ACTIVE_LIBRARY_ID';
export const SET_ACTIVE_LIBRARY = 'SET_ACTIVE_LIBRARY';
export const CREATE_LIBRARY = 'CREATE_LIBRARY';
export const DELETE_LIBRARY = 'DELETE_LIBRARY';
export const RENAME_LIBRARY = 'RENAME_LIBRARY';
export const SWITCH_LIBRARY = 'SWITCH_LIBRARY';
export const GET_LIBRARY_DISK_PATHS = 'GET_LIBRARY_DISK_PATHS';
export const DELETE_LIBRARY_AND_FILES = 'DELETE_LIBRARY_AND_FILES';

export type LibraryDiskPaths = {
  /** The per-library directory containing onefolder.db, WAL/SHM sidecars, and backups/ */
  libraryDir: string;
  /** Absolute path to the SQLite database file (informational; lives inside libraryDir) */
  dbPath: string;
  /** The default per-library thumbnail cache directory */
  thumbnailDir: string;
};

export type DeleteLibraryAndFilesResult = {
  /** Paths that were successfully removed (or were already absent) */
  removedPaths: string[];
  /** Paths where removal failed with a non-ENOENT error */
  failedPaths: { path: string; error: string }[];
};

//////////////// Re-encode (x264) job ////////////////
export const START_REENCODE = 'START_REENCODE';
export const REENCODE_PROGRESS = 'REENCODE_PROGRESS';
export const CANCEL_REENCODE = 'CANCEL_REENCODE';

/** Live progress event pushed from main to renderer during an ffmpeg encode. */
export type ReencodeProgressMessage = {
  jobId: string;
  /** Encode progress 0–100, or undefined when total duration is unknown. */
  percent?: number;
  /** Encoded seconds so far (from ffmpeg out_time_ms). */
  outTimeSec?: number;
  /** Total source duration in seconds, or undefined when probing failed. */
  totalSec?: number;
};

/** Returned by the START_REENCODE invoke when the encode completes successfully. */
export type ReencodeResult = {
  outputPath: string;
};
