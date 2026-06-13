import { ipcRenderer } from 'electron';
import path from 'path';
import {
  CLEAR_DATABASE,
  CLOSED_PREVIEW_WINDOW,
  DRAG_EXPORT,
  FULL_SCREEN_CHANGED,
  GET_PATH,
  GET_TAGS,
  GET_VERSION,
  GET_ZOOM_FACTOR,
  ClipServerEnabledMessage,
  DragExportMessage,
  INITIALIZED,
  PreviewFilesMessage,
  RunInBackgroundMessage,
  StoreFileMessage,
  StoreFileReplyMessage,
  IS_CLIP_SERVER_RUNNING,
  IS_FULL_SCREEN,
  IS_MAXIMIZED,
  IS_PORTABLE_MODE,
  IS_RUNNING_IN_BACKGROUND,
  TagsMessage,
  ThemeMessage,
  MESSAGE_BOX,
  MESSAGE_BOX_SYNC,
  OPEN_DIALOG,
  RECEIEVE_PREVIEW_FILES,
  RECEIVE_TAGS,
  RELOAD,
  SEND_PREVIEW_FILES,
  SET_CLIP_SERVER_ENABLED,
  SET_CLIP_SERVER_IMPORT_LOCATION,
  SET_FULL_SCREEN,
  SET_RUN_IN_BACKGROUND,
  SET_THEME,
  SET_ZOOM_FACTOR,
  STORE_FILE,
  STORE_FILE_REPLY,
  SYSTEM_PATHS,
  TOGGLE_DEV_TOOLS,
  TRASH_FILE,
  DELETE_FILE_PERMANENTLY,
  CHECK_RECYCLABLE,
  WindowSystemButtonPress,
  WINDOW_BLUR,
  WINDOW_FOCUS,
  WINDOW_MAXIMIZE,
  WINDOW_SYSTEM_BUTTON_PRESS,
  WINDOW_UNMAXIMIZE,
  GET_LIBRARIES,
  GET_ACTIVE_LIBRARY_ID,
  SET_ACTIVE_LIBRARY,
  CREATE_LIBRARY,
  DELETE_LIBRARY,
  RENAME_LIBRARY,
  SWITCH_LIBRARY,
  GET_LIBRARY_DISK_PATHS,
  DELETE_LIBRARY_AND_FILES,
  LibraryDiskPaths,
  DeleteLibraryAndFilesResult,
  START_MEDIA_JOB,
  MEDIA_JOB_PROGRESS,
  CANCEL_MEDIA_JOB,
  MediaJobType,
  StartMediaJobMessage,
  MediaJobProgressMessage,
  MediaJobResult,
} from './messages';
import { LibraryDTO } from '../api/library';

export class RendererMessenger {
  static initialized = () => ipcRenderer.send(INITIALIZED);

  static clearDatabase = () => ipcRenderer.send(CLEAR_DATABASE);

  static toggleDevTools = () => ipcRenderer.send(TOGGLE_DEV_TOOLS);

  static reload = (frontEndOnly?: boolean) => ipcRenderer.send(RELOAD, frontEndOnly);

  static showOpenDialog = (
    options: Electron.OpenDialogOptions,
  ): Promise<Electron.OpenDialogReturnValue> => ipcRenderer.invoke(OPEN_DIALOG, options);

  static showMessageBox = (
    options: Electron.MessageBoxOptions,
  ): Promise<Electron.MessageBoxReturnValue> => ipcRenderer.invoke(MESSAGE_BOX, options);

  static showMessageBoxSync = (options: Electron.MessageBoxSyncOptions): Promise<number> =>
    ipcRenderer.invoke(MESSAGE_BOX_SYNC, options);

  static getPath = (name: SYSTEM_PATHS): Promise<string> => ipcRenderer.invoke(GET_PATH, name);

  static trashFile = (absolutePath: string): Promise<Error | undefined> =>
    ipcRenderer.invoke(TRASH_FILE, absolutePath);

  static deleteFilePermanently = (absolutePath: string): Promise<Error | undefined> =>
    ipcRenderer.invoke(DELETE_FILE_PERMANENTLY, absolutePath);

  /** Returns the subset of `paths` whose drive has no usable Recycle Bin. */
  static checkRecyclable = (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke(CHECK_RECYCLABLE, paths);

  static setFullScreen = (isFullScreen: boolean) =>
    ipcRenderer.invoke(SET_FULL_SCREEN, isFullScreen);

  static isFullScreen = (): boolean => ipcRenderer.sendSync(IS_FULL_SCREEN);

  static onFullScreenChanged = (cb: (val: boolean) => void) =>
    ipcRenderer.on(FULL_SCREEN_CHANGED, (_, val: boolean) => cb(val));

  static setZoomFactor = (level: number) => ipcRenderer.invoke(SET_ZOOM_FACTOR, level);

  static getZoomFactor = (): number => ipcRenderer.sendSync(GET_ZOOM_FACTOR);

  static onGetTags = (fetchTags: () => Promise<TagsMessage>) =>
    ipcRenderer.on(GET_TAGS, async () => {
      const msg = await fetchTags();
      ipcRenderer.send(RECEIVE_TAGS, msg);
    });

  static isClipServerEnabled = (): boolean => ipcRenderer.sendSync(IS_CLIP_SERVER_RUNNING);

  static setClipServerImportLocation = (dir: string): Promise<void> =>
    ipcRenderer.invoke(SET_CLIP_SERVER_IMPORT_LOCATION, dir);

  static isRunningInBackground = (): boolean => ipcRenderer.sendSync(IS_RUNNING_IN_BACKGROUND);

  static setClipServerEnabled = (msg: ClipServerEnabledMessage) =>
    ipcRenderer.send(SET_CLIP_SERVER_ENABLED, msg);

  static setTheme = (msg: ThemeMessage) => ipcRenderer.send(SET_THEME, msg);

  static setRunInBackground = (msg: RunInBackgroundMessage) =>
    ipcRenderer.send(SET_RUN_IN_BACKGROUND, msg);

  static storeFile = (msg: StoreFileMessage): Promise<StoreFileReplyMessage> => {
    ipcRenderer.send(STORE_FILE, msg);
    return new Promise<StoreFileReplyMessage>((resolve) =>
      ipcRenderer.once(STORE_FILE_REPLY, (_, msg: StoreFileReplyMessage) => resolve(msg)),
    );
  };

  static startDragExport = (msg: DragExportMessage) => ipcRenderer.send(DRAG_EXPORT, msg);

  static sendPreviewFiles = (msg: PreviewFilesMessage) => {
    ipcRenderer.send(SEND_PREVIEW_FILES, msg);
  };

  static onReceivePreviewFiles = (cb: (msg: PreviewFilesMessage) => void) =>
    ipcRenderer.on(RECEIEVE_PREVIEW_FILES, (_, msg: PreviewFilesMessage) => cb(msg));

  static onClosedPreviewWindow = (cb: () => void) => ipcRenderer.on(CLOSED_PREVIEW_WINDOW, cb);

  static onMaximize = (cb: () => void) => {
    ipcRenderer.on(WINDOW_MAXIMIZE, cb);
    return () => ipcRenderer.removeListener(WINDOW_MAXIMIZE, cb);
  };

  static onUnmaximize = (cb: () => void) => {
    ipcRenderer.on(WINDOW_UNMAXIMIZE, cb);
    return () => ipcRenderer.removeListener(WINDOW_UNMAXIMIZE, cb);
  };

  static onFocus = (cb: () => void) => {
    ipcRenderer.on(WINDOW_FOCUS, cb);
    return () => ipcRenderer.removeListener(WINDOW_FOCUS, cb);
  };

  static onBlur = (cb: () => void) => {
    ipcRenderer.on(WINDOW_BLUR, cb);
    return () => ipcRenderer.removeListener(WINDOW_BLUR, cb);
  };

  static pressWindowSystemButton = (button: WindowSystemButtonPress) =>
    ipcRenderer.send(WINDOW_SYSTEM_BUTTON_PRESS, button);

  static isMaximized = (): boolean => ipcRenderer.sendSync(IS_MAXIMIZED);

  static getVersion = (): string => ipcRenderer.sendSync(GET_VERSION);

  static isPortableMode = (): boolean => ipcRenderer.sendSync(IS_PORTABLE_MODE);

  static getDefaultThumbnailDirectory = async (libraryId?: string) => {
    // In portable mode, store thumbnails inside the portable data dir rather than
    // the system temp directory so they travel with the app.
    if (RendererMessenger.isPortableMode()) {
      const userDataPath = await RendererMessenger.getPath('userData');
      // Per-library subdir when a library ID is provided; legacy flat path otherwise.
      const subdir = libraryId ? `thumbnails/${libraryId}` : 'thumbnails';
      return path.join(userDataPath, subdir);
    }
    const tempPath = await RendererMessenger.getPath('temp');
    const subdir = libraryId ? `OneFolder/${libraryId}/thumbnails` : 'OneFolder/thumbnails';
    return path.join(tempPath, subdir);
  };

  static getDefaultBackupDirectory = async (libraryId?: string) => {
    const userDataPath = await RendererMessenger.getPath('userData');
    // Per-library subdir when a library ID is provided; legacy flat path otherwise.
    const subdir = libraryId ? `libraries/${libraryId}/backups` : 'backups';
    return path.join(userDataPath, subdir);
  };

  static getThemesDirectory = async () => {
    const userDataPath = await RendererMessenger.getPath('userData');
    return path.join(userDataPath, 'themes');
  };

  // Library management
  static getLibraries = (): Promise<LibraryDTO[]> => ipcRenderer.invoke(GET_LIBRARIES);

  static getActiveLibraryId = (): Promise<string | null> =>
    ipcRenderer.invoke(GET_ACTIVE_LIBRARY_ID);

  static setActiveLibrary = (id: string): Promise<void> =>
    ipcRenderer.invoke(SET_ACTIVE_LIBRARY, id);

  static createLibrary = (name: string): Promise<LibraryDTO> =>
    ipcRenderer.invoke(CREATE_LIBRARY, name);

  static deleteLibrary = (id: string): Promise<void> => ipcRenderer.invoke(DELETE_LIBRARY, id);

  static renameLibrary = (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke(RENAME_LIBRARY, id, name);

  static switchLibrary = (newLibraryId: string): Promise<void> =>
    ipcRenderer.invoke(SWITCH_LIBRARY, newLibraryId);

  static getLibraryDiskPaths = (id: string): Promise<LibraryDiskPaths> =>
    ipcRenderer.invoke(GET_LIBRARY_DISK_PATHS, id);

  static deleteLibraryAndFiles = (id: string): Promise<DeleteLibraryAndFilesResult> =>
    ipcRenderer.invoke(DELETE_LIBRARY_AND_FILES, id);

  // Media job channels (re-encode x264, normalize audio, …) ----------------------

  /**
   * Ask main to start a media job of the given `jobType` on `inputPath`.
   * Resolves with `{ outputPath }` on success; rejects on ffmpeg failure or cancel.
   *
   * The `jobId` is delivered to the renderer via the FIRST MEDIA_JOB_PROGRESS event
   * (see `onMediaJobProgress`) so that `cancelMediaJob(jobId)` can be called during
   * the job.  Callers must subscribe to `onMediaJobProgress` before calling
   * `startMediaJob` and stash the first `msg.jobId` they receive.
   *
   * `clip` is required when `jobType === 'create-clip'`; omit for all other job types.
   */
  static startMediaJob = (
    jobType: MediaJobType,
    inputPath: string,
    clip?: { start: string; end: string },
  ): Promise<MediaJobResult> =>
    ipcRenderer.invoke(START_MEDIA_JOB, { inputPath, jobType, clip } as StartMediaJobMessage);

  /**
   * Subscribe to live progress events from the running media job.
   * Returns an unsubscribe function — call it to stop receiving events
   * (matches the `onMaximize` pattern in this file).
   */
  static onMediaJobProgress = (cb: (msg: MediaJobProgressMessage) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, msg: MediaJobProgressMessage) => cb(msg);
    ipcRenderer.on(MEDIA_JOB_PROGRESS, h);
    return () => ipcRenderer.removeListener(MEDIA_JOB_PROGRESS, h);
  };

  /** Send a cancel request for the given jobId. */
  static cancelMediaJob = (jobId: string): void => ipcRenderer.send(CANCEL_MEDIA_JOB, jobId);
}
