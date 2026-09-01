import {
  app,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Rectangle,
} from 'electron';
import path from 'path';
import { spawn } from 'child_process';
import fse from 'fs-extra';
import TrayIcon from '../resources/logo/png/full-color/onefolder-logomark-fc-256x256.png';
import AppIcon from '../resources/logo/png/full-color/onefolder-logomark-fc-512x512.png';
import { IS_DEV, setPortableMode } from '../common/process';
import {
  LibraryRegistry,
  getDefaultThumbnailDir,
  getSqliteDbPath,
} from '../common/library-registry';
import { parseHmsToSeconds } from '../common/fmt';
import { parseServeArgs } from './serve-args';
import { startServeMode } from './serve-mode';
import type { ServerHandle } from './server/index';
import { MainMessenger } from './ipc/main';
import { WindowSystemButtonPress, MediaJobType, MediaJobStartResult } from './ipc/messages';
import { mediaJobService } from './media/MediaJobService';
import { FfmpegRunner } from './media/FfmpegRunner';
import { buildSubtractClipArgs, SUBTRACT_CLIP_CROSSFADE_SEC } from './media/subtractClip';
import { NVENC_H264_VIDEO_ARGS, decideAudioArgs } from './media/audioArgs';

// ---------------------------------------------------------------------------
// Media job specs — map each job type to its ffmpeg codec/filter args and the
// output file extension.  Only transport flags (-hide_banner, -progress, etc.)
// are added by FfmpegRunner; these args are passed verbatim per INV-018/INV-020.
// ---------------------------------------------------------------------------
const MEDIA_JOB_SPECS: Record<MediaJobType, { args: string[]; outputExt: string }> = {
  'reencode-x264': {
    // Despite the legacy "x264" name, this re-encodes video with NVIDIA NVENC (H.264) via the
    // shared NVENC_H264_VIDEO_ARGS constant: -preset p7 (slowest/best), -tune hq, -cq 21.
    // Requires an NVIDIA GPU + NVENC-enabled ffmpeg; there is no software fallback — the job
    // fails loudly if NVENC is unavailable. Audio args are appended per-invocation by the
    // onStartMediaJob handler via decideAudioArgs (ffprobe-driven copy-vs-AAC decision).
    args: [...NVENC_H264_VIDEO_ARGS],
    outputExt: 'mp4',
  },
  'normalize-audio': {
    // "Compress & Normalize Audio" tool.
    // -c:v copy: pass the video stream through untouched (only the audio is re-encoded).
    // -af acompressor,...,loudnorm: dynamic-range compress, then EBU R128 loudness-normalize
    //   (I=-16 LUFS, TP=-1.5 dBTP, LRA=11) the audio stream (user's 2026-06-13 amendment).
    // The whole filtergraph is a single argument — spawn() runs without a shell, no quoting needed.
    args: [
      '-c:v',
      'copy',
      '-af',
      'acompressor=threshold=-18dB:ratio=2:attack=20:release=250:knee=6,loudnorm=I=-16:TP=-1.5:LRA=11',
    ],
    outputExt: 'mp4',
  },
  'create-clip': {
    // Stream-copy: no re-encode, instant lossless trim.
    // The -ss/-to pre-input args are NOT here — they are per-invocation and come from the
    // clip payload in the IPC message; see the onStartMediaJob handler below.
    args: ['-c', 'copy'],
    outputExt: 'mp4',
  },
  'subtract-clip': {
    // "Subtract Clip": remove the marked [start, end] section and cross-fade the two surviving
    // pieces. The real args are a per-invocation -filter_complex graph built from the marks
    // (buildSubtractClipArgs); the static entry below is only a placeholder — see the
    // onStartMediaJob handler, which replaces jobArgs for this type.
    args: [],
    outputExt: 'mp4',
  },
  'rotate-cw': {
    // 90° clockwise. transpose is a video filter so the video stream MUST be re-encoded
    // (a rotated frame is a new frame). Video uses the shared NVENC_H264_VIDEO_ARGS block —
    // identical settings to reencode-x264 and subtract-clip; no software fallback (fails
    // loudly if NVENC is unavailable). Audio args are appended per-invocation by the
    // onStartMediaJob handler via decideAudioArgs (ffprobe-driven copy-vs-AAC decision).
    args: ['-vf', 'transpose=1', ...NVENC_H264_VIDEO_ARGS],
    outputExt: 'mp4',
  },
  'rotate-ccw': {
    // 90° counterclockwise (transpose=2). Same NVENC settings and per-invocation audio
    // decision as rotate-cw; see that entry's comment.
    args: ['-vf', 'transpose=2', ...NVENC_H264_VIDEO_ARGS],
    outputExt: 'mp4',
  },
};

// Portable mode detection — must run before any app.getPath() calls so that
// app.setPath('userData') takes effect for all subsequent consumers.
// electron-builder's Windows `portable` target sets PORTABLE_EXECUTABLE_DIR to the
// directory that holds the running .exe (not the extracted temp dir), so we prefer
// that when present. This lets shipped portable builds auto-enter portable mode
// without needing a bundled sentinel file.
const _portableAppDir =
  process.env.PORTABLE_EXECUTABLE_DIR ??
  (app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..'));

const IS_PORTABLE_MODE =
  process.env.PORTABLE_EXECUTABLE_DIR !== undefined ||
  fse.pathExistsSync(path.join(_portableAppDir, 'portable.txt')) ||
  fse.pathExistsSync(path.join(_portableAppDir, 'data'));

if (IS_PORTABLE_MODE) {
  const portableDataDir = path.join(_portableAppDir, 'data');
  // Ensure the data directory and its expected subdirectories exist on first launch.
  fse.ensureDirSync(portableDataDir);
  fse.ensureDirSync(path.join(portableDataDir, 'backups'));
  fse.ensureDirSync(path.join(portableDataDir, 'thumbnails'));
  fse.ensureDirSync(path.join(portableDataDir, 'themes'));
  app.setPath('userData', portableDataDir);
  // Redirect temp as well so thumbnail directory falls inside the portable data dir.
  app.setPath('temp', portableDataDir);
}

// Inform the common/process module so other main-process code can read IS_PORTABLE.
setPortableMode(IS_PORTABLE_MODE);

// ---------------------------------------------------------------------------
// Serve mode detection — `brave.exe --serve` starts the read-only web sidecar
// instead of the desktop GUI, in this same portable context.
//
// Parsed HERE, at module scope, because the single-instance lock further down
// also runs at module scope and serve mode must bypass it: the lock is keyed on
// the userData directory that the GUI and the server share, so taking it would
// make the two mutually exclusive. A second server is stopped by the port bind
// failing (EADDRINUSE), which is a self-explaining error.
// ---------------------------------------------------------------------------
const SERVE_ARGS = parseServeArgs(process.argv);
const IS_SERVE_MODE = SERVE_ARGS.serve;

// Enable SharedArrayBuffer WITHOUT cross-origin isolation.
//
// The masonry layout WASM uses shared memory (`shared:true` in
// wasm/packages/masonry — its WebAssembly.Memory is posted to a worker), which
// normally requires crossOriginIsolated, i.e. COOP/COEP response headers. But
// under Chromium ~144, COEP: require-corp on the opaque file:// origin blocks
// the webpack-bundled psd/heic worker scripts (no CORP header on file://
// responses), hanging startup at the splash screen. This feature flag grants
// SAB without the COOP/COEP headers, satisfying both: workers load normally
// and masonry's shared memory keeps working. See the Electron 41 upgrade notes.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

const basePath = app.getPath('userData');

const windowStateFilePath = path.join(basePath, 'windowState.json');

// Library registry — manages the list of known libraries and the active
// library ID. Instantiated at module scope so IPC handlers below can close
// over it without needing to thread it through function parameters.
const registry = new LibraryRegistry(basePath);

// TASK-006: First-launch migration — if no libraries exist yet (fresh install or
// first launch after upgrading to the multi-library version), create the default
// library and record it as active. The renderer will then perform the filesystem
// migration (SQLite file + localStorage keys + backups) on its own startup path.
if (registry.getLibraries().length === 0) {
  const defaultLibrary = registry.createLibrary('My Library');
  registry.setActiveLibrary(defaultLibrary.id);
}

// if (IS_DEV) {
//   Object.defineProperty(app, 'isPackaged', {
//     get() {
//       return true;
//     },
//   });
// }

let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;

function initialize() {
  // NOTE: a COOP/COEP header injection (added in the Electron 15 era, commit
  // f29339ff) used to live here. It was removed during the Electron 41 upgrade:
  // under Chromium ~144, COEP: require-corp on the opaque file:// origin blocks
  // the webpack-bundled Web Worker scripts (psdReader/heicReader) from loading,
  // which silently hangs ImageLoader.init() and leaves the app stuck on the
  // splash screen. Nothing in the codebase uses SharedArrayBuffer or
  // crossOriginIsolated, so cross-origin isolation is not needed.

  // Anchor the media-job staging dir to the running APPLICATION (not the user's photo folder):
  // ffmpeg writes its output here, outside any watched location, so the folder watcher never sees
  // a partial/untagged file. Sweep any files left by a previous run that crashed mid-job. (INV-026)
  mediaJobService.setTempBaseDir(path.join(app.getPath('temp'), 'onefolder-media-jobs'));
  mediaJobService.sweepTempDir();

  createWindow();
  createPreviewWindow();
}

function createWindow() {
  // Remember window size and position
  const previousWindowState = getPreviousWindowState();

  const mainOptions: BrowserWindowConstructorOptions = {
    titleBarStyle: 'hidden',
    // Disable native frame: we use a custom titlebar for all platforms: a unique one for MacOS, and one for windows/linux
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
    },
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: `${__dirname}/${AppIcon}`,
    // Should be same as body background: Only for split second before css is loaded
    backgroundColor: '#1c1e23',
    title: 'OneFolder',
    show: false, // only show once initial loading is finished
    ...previousWindowState,
  };

  // Create the browser window.
  mainWindow = new BrowserWindow(mainOptions);
  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // Customize new window opening
  // https://www.electronjs.org/docs/api/window-open
  mainWindow.webContents.setWindowOpenHandler(({ frameName }) => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      return { action: 'deny' };
    }

    const WINDOW_TITLES: { [key: string]: string } = {
      settings: 'Settings',
      'help-center': 'Help Center',
      about: 'About',
    };

    if (!(frameName in WINDOW_TITLES)) {
      return { action: 'deny' };
    }

    // Open window on same display as main window
    const targetDisplay = getMainWindowDisplay();
    const bounds: Rectangle = { width: 680, height: 480, x: 0, y: 0 };
    bounds.x = targetDisplay.bounds.x + bounds.width / 2;
    bounds.y = targetDisplay.bounds.y + bounds.height / 2;

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...bounds,
        icon: `${__dirname}/${AppIcon}`,
        // Should be same as body background: Only for split second before css is loaded
        backgroundColor: '#1c1e23',
        parent: mainWindow,
        title: `${WINDOW_TITLES[frameName]} • OneFolder`,
        frame: true,
        titleBarStyle: 'default',
      },
    };
  });

  mainWindow.webContents.on('did-create-window', (childWindow) => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      return;
    }

    childWindow.center(); // "center" in additionalOptions doesn't work :/
    childWindow.setMenu(null); // no toolbar needed

    if (IS_DEV) {
      // childWindow.webContents.openDevTools({ mode: 'detach' });
    }

    mainWindow.webContents.once('will-navigate', () => {
      if (!childWindow.isDestroyed()) {
        childWindow.close(); // close when main window is reloaded
      }
    });
  });

  mainWindow.addListener('enter-full-screen', () => {
    if (mainWindow !== null) {
      MainMessenger.fullscreenChanged(mainWindow.webContents, true);
    }
  });

  mainWindow.addListener('leave-full-screen', () => {
    if (mainWindow !== null) {
      MainMessenger.fullscreenChanged(mainWindow.webContents, false);
    }
  });

  mainWindow.addListener('resize', saveWindowState);
  mainWindow.addListener('move', saveWindowState);
  mainWindow.addListener('unmaximize', saveWindowState);
  mainWindow.addListener('maximize', saveWindowState);

  let menu = null;

  // Mac App menu - used for styling so shortcuts work
  // https://livebook.manning.com/book/cross-platform-desktop-applications/chapter-9/78

  // Create our menu entries so that we can use MAC shortcuts
  const menuBar: Electron.MenuItemConstructorOptions[] = [];

  menuBar.push({
    label: 'OneFolder',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services', submenu: [] },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      {
        label: 'Quit',
        accelerator: 'Command+Q',
        click: () => app.quit(),
      },
    ],
  });

  menuBar.push({
    label: 'Edit',
    submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
  });

  menuBar.push({
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CommandOrControl+R',
        click: forceRelaunch,
      },
      {
        label: 'Refresh',
        accelerator: 'F5',
        // Menu click handlers receive a BaseWindow since Electron's BaseWindow
        // split; narrow to BrowserWindow before touching webContents.
        click: (_, win) => {
          if (win instanceof BrowserWindow) {
            win.webContents.reload();
          }
        },
      },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      {
        label: 'Actual Size',
        accelerator: 'CommandOrControl+0',
        click: (_, browserWindow) => {
          if (browserWindow instanceof BrowserWindow) {
            browserWindow.webContents.zoomFactor = 1;
          }
        },
      },
      {
        label: 'Zoom In',
        // TODO: Fix by using custom solution...
        accelerator: 'CommandOrControl+=',
        click: (_, browserWindow) => {
          if (browserWindow instanceof BrowserWindow) {
            browserWindow.webContents.setZoomFactor(
              Math.min(browserWindow.webContents.zoomFactor + 0.1, MAX_ZOOM_FACTOR),
            );
          }
        },
      },
      {
        label: 'Zoom Out',
        accelerator: 'CommandOrControl+-',
        click: (_, browserWindow) => {
          if (browserWindow instanceof BrowserWindow) {
            browserWindow.webContents.setZoomFactor(
              Math.max(browserWindow.webContents.zoomFactor - 0.1, MIN_ZOOM_FACTOR),
            );
          }
        },
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  menu = Menu.buildFromTemplate(menuBar);

  Menu.setApplicationMenu(menu);

  // and load the index.html of the app, passing the active library ID so
  // the renderer can open the correct SQLite database and namespace its storage.
  const activeLibId = registry.getActiveLibraryId();
  const libraryParam = activeLibId ? `?libraryId=${encodeURIComponent(activeLibId)}` : '';
  mainWindow.loadURL(`file://${__dirname}/index.html${libraryParam}`);

  // then maximize the window if it was previously
  if (previousWindowState.isMaximized) {
    mainWindow.maximize();
  }

  // Open the DevTools if in dev mode.
  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
    if (previewWindow !== null && !previewWindow.isDestroyed()) {
      previewWindow.close();
    }
  });

  mainWindow.on('maximize', () => {
    if (mainWindow !== null) {
      MainMessenger.maximize(mainWindow.webContents);
    }
  });

  mainWindow.on('unmaximize', () => {
    if (mainWindow !== null) {
      MainMessenger.unmaximize(mainWindow.webContents);
    }
  });

  mainWindow.addListener(
    'focus',
    () => mainWindow !== null && MainMessenger.focus(mainWindow.webContents),
  );

  mainWindow.addListener(
    'blur',
    () => mainWindow !== null && MainMessenger.blur(mainWindow.webContents),
  );
}

function createPreviewWindow() {
  // Get display where main window is located
  const display = getMainWindowDisplay();

  // preview window is is sized relative to screen resolution by default
  const bounds: Rectangle = {
    width: (display.size.width * 3) / 4,
    height: (display.size.height * 3) / 4,
    x: display.bounds.x + display.bounds.width / 8,
    y: display.bounds.y + display.bounds.height / 8,
  };

  previewWindow = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
    },
    minWidth: 224,
    minHeight: 224,
    ...bounds,
    icon: `${__dirname}/${AppIcon}`,
    // Should be same as body background: Only for split second before css is loaded
    backgroundColor: '#14181a',
    title: 'OneFolder Quick View',
    show: false, // invis by default
  });
  previewWindow.setMenuBarVisibility(false);
  const previewLibId = registry.getActiveLibraryId();
  const previewLibParam = previewLibId ? `&libraryId=${encodeURIComponent(previewLibId)}` : '';
  previewWindow.loadURL(`file://${__dirname}/index.html?preview=true${previewLibParam}`);
  previewWindow.on('close', (e) => {
    // Prevent close, hide the window instead, for faster launch next time
    if (mainWindow !== null) {
      e.preventDefault();
      MainMessenger.sendClosedPreviewWindow(mainWindow.webContents);
      mainWindow.focus();
    }
    if (previewWindow !== null) {
      previewWindow.hide();
    }
  });
  return previewWindow;
}

if (IS_SERVE_MODE) {
  // -------------------------------------------------------------------------
  // Serve mode: no windows, no single-instance lock, no ffmpeg staging.
  //
  // The server is started immediately rather than from app.whenReady(), so the
  // window layer is never initialized. Every path it needs was already
  // resolved above (userData/temp remapped for portable mode); serve-mode.ts
  // and the server library derive nothing themselves.
  // -------------------------------------------------------------------------
  const exiftoolRunnable = process.platform === 'win32' ? 'exiftool.exe' : 'exiftool.pl';

  // Resource paths key off app.isPackaged, NOT the NODE_ENV-based guess in
  // getExtraResourcePath (`(IS_DEV ? '../' : '../../') + 'resources'`). That
  // heuristic assumes production bundle === packaged app, so running the
  // production main bundle straight from the repo resolved one directory too
  // high — `D:\Dev\resources\exiftool\exiftool.exe` instead of
  // `D:\Dev\OneFolder\resources\...`. __dirname is the build output directory
  // in both cases, so one level up is the repo root.
  //
  // Never resolve from process.execPath either: on the Windows portable target
  // that is the NSIS temp extraction directory, which is wiped on exit.
  const resourcesRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'resources')
    : path.resolve(__dirname, '..', 'resources');
  const spaDir = app.isPackaged
    ? path.join(process.resourcesPath, 'dist-web')
    : path.resolve(__dirname, '..', 'dist-web');

  // Shutdown wiring is installed BEFORE the server finishes starting, not on
  // the success path only. Startup is not instantaneous (exiftool spawn, TLS
  // material, the bind itself), and a signal that lands inside that window must
  // still close the database and the exiftool child rather than be ignored.
  //
  // Nothing here can help against a force kill (taskkill /F, TerminateProcess):
  // Windows delivers no signal at all for those, so the child is only
  // reclaimable on the paths that do get a chance to run.
  let serverHandle: ServerHandle | null = null;
  let shutdownRequested = false;

  function closeAndExit(handle: ServerHandle): void {
    handle
      .close()
      .catch(() => undefined)
      .finally(() => app.exit(0));
  }

  function shutdown(): void {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    if (serverHandle !== null) {
      closeAndExit(serverHandle);
    }
    // Otherwise the server is still starting: the `then` below closes it as
    // soon as the handle exists, and startServeMode's own failure path already
    // releases whatever it opened.
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // Windows Ctrl+Break — delivered as SIGBREAK, never as SIGINT.
  process.once('SIGBREAK', shutdown);

  startServeMode({
    userData: basePath,
    tempPath: app.getPath('temp'),
    isPortable: IS_PORTABLE_MODE,
    registry,
    exiftoolPath: path.join(resourcesRoot, 'exiftool', exiftoolRunnable),
    spaDir,
    rawPort: SERVE_ARGS.rawPort,
  })
    .then((handle) => {
      serverHandle = handle;
      if (shutdownRequested) {
        closeAndExit(handle);
      }
    })
    .catch(() => {
      // startServeMode already wrote the operator-facing message to server.log
      // and stdout, and startServer closed the database and exiftool child it
      // had opened before the failure. Exit non-zero without a dialog — nobody
      // is watching a screen in serve mode.
      app.exit(1);
    });
} else {
  // Ensure only a single instance of OneFolder can be open
  // https://www.electronjs.org/docs/api/app#apprequestsingleinstancelock
  const HAS_INSTANCE_LOCK = app.requestSingleInstanceLock();
  if (!HAS_INSTANCE_LOCK) {
    console.log('Another instance of OneFolder is already running');
    app.quit();
  } else {
    app.on('second-instance', () => {
      // Someone tried to run a second instance, we should focus our window.
      if (mainWindow === null || mainWindow.isDestroyed()) {
        // In case there is no main window (could be running in background): re-initialize
        initialize();
      } else {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
    });

    // Only initialize window if no other instance is already running:
    // This method will be called when Electron has finished
    // initialization and is ready to create browser windows.
    // Some APIs can only be used after this event occurs.
    app.whenReady().then(initialize);
  }
}

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  // Never in serve mode: a headless server must not sprout a window.
  if (mainWindow === null && !IS_SERVE_MODE) {
    createWindow();
  }
});

// Kill any in-flight ffmpeg jobs and remove their partial outputs when the app
// is about to quit (normal close, Ctrl+C, OS shutdown).  `killAll()` is
// synchronous/best-effort and does not block the quit.  This handler must not
// interfere with `forceRelaunch` (which calls `app.exit(0)` directly and
// therefore bypasses the `before-quit` event — no double-cleanup risk).
app.on('before-quit', () => {
  mediaJobService.killAll();
});

// Handling uncaught exceptions:
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception', error);

  const errorMessage = `An unexpected error occurred.\n${
    error.stack?.includes(error.message) ? '' : `${error.name}: ${error.message.slice(0, 200)}\n`
  }\n${error.stack?.slice(0, 300)}`;

  // Serve mode is headless: a modal error box would block the server forever
  // waiting for a click nobody is there to make. Log and keep serving.
  if (IS_SERVE_MODE) {
    console.error(errorMessage);
    return;
  }

  try {
    if (mainWindow != null && !mainWindow.isDestroyed()) {
      // Show a dialog prompting the user to either restart, continue on or quit
      const dialogResult = await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Unexpected error',
        message: errorMessage,
        buttons: ['Try to keep running', 'Restart OneFolder', 'Quit OneFolder'],
      });
      if (dialogResult.response === 0) {
        // Keep running
      } else if (dialogResult.response === 1) {
        forceRelaunch(); // Restart
      } else if (dialogResult.response === 2) {
        app.exit(0); // Quit
      }
    } else {
      // No main window, show a fallback dialog
      dialog.showErrorBox('Unexpected error', errorMessage);
      app.exit(1);
    }
  } catch (e) {
    console.error('Could not show error dialog', e);
    app.exit(1);
  }
});

//---------------------------------------------------------------------------------//
// Messaging: Sending and receiving messages between the main and renderer process //
//---------------------------------------------------------------------------------//

// Forward files from the main window to the preview window
MainMessenger.onSendPreviewFiles((msg) => {
  // Create preview window if needed, and send the files selected in the primary window
  if (previewWindow === null || previewWindow.isDestroyed()) {
    // The Window object might've been destroyed if it was hidden for too long -> Recreate it
    if (previewWindow?.isDestroyed()) {
      console.warn('Preview window was destroyed! Attemping to recreate...');
    }

    previewWindow = createPreviewWindow();
    MainMessenger.onceInitialized().then(() => {
      if (previewWindow) {
        MainMessenger.sendPreviewFiles(previewWindow.webContents, msg);
      }
    });
  } else {
    MainMessenger.sendPreviewFiles(previewWindow.webContents, msg);
    if (!previewWindow.isVisible()) {
      previewWindow.show();
    }
    previewWindow.focus();
  }
});

// Set native window theme (frame, menu bar)
MainMessenger.onSetTheme((msg) => (nativeTheme.themeSource = msg.theme));

MainMessenger.onDragExport(async (absolutePaths) => {
  if (mainWindow === null || absolutePaths.length === 0) {
    return;
  }

  let previewIcon = nativeImage.createEmpty();
  try {
    // nativeImage.createThumbnailFromPath isn't supported on Linux by the latest Electron release as of 2024-06-28
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (nativeImage.createThumbnailFromPath) {
      previewIcon = await nativeImage.createThumbnailFromPath(absolutePaths[0], {
        width: 200,
        height: 200,
      });
    } else {
      console.log('Falling back to manual resize for drag icon');
      previewIcon = nativeImage.createFromPath(absolutePaths[0]).resize({
        width: 200,
        height: 200,
      });
    }
  } catch (e) {
    console.error('Could not create drag icon', absolutePaths[0], e);
    try {
      const fallbackIconPath = path.join(__dirname, TrayIcon);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (nativeImage.createThumbnailFromPath) {
        previewIcon = await nativeImage.createThumbnailFromPath(fallbackIconPath, {
          width: 200,
          height: 200,
        });
      } else {
        console.log('Falling back to manual resize for fallback drag icon');
        previewIcon = nativeImage.createFromPath(fallbackIconPath).resize({
          width: 200,
          height: 200,
        });
      }
    } catch (e) {
      console.error('Could not create fallback drag icon', TrayIcon, e);
    }
  }

  mainWindow.webContents.startDrag({
    file: absolutePaths[0],
    files: absolutePaths,
    // Just show the first image as a thumbnail for now
    // TODO: Show some indication that multiple images are dragged, would be cool to show a stack of the first few of them
    // TODO: The icon doesn't seem to work at all since we upgraded Electron a while back
    icon: previewIcon,
  });
});

MainMessenger.onClearDatabase(forceRelaunch);

MainMessenger.onToggleDevTools(() => mainWindow?.webContents.toggleDevTools());

MainMessenger.onReload((frontEndOnly) =>
  frontEndOnly ? mainWindow?.webContents.reload() : forceRelaunch(),
);

MainMessenger.onOpenDialog(dialog);

MainMessenger.onMessageBox(dialog);

MainMessenger.onMessageBoxSync(dialog);

MainMessenger.onGetPath((path) => app.getPath(path));

/**
 * Trash a file with a single EBUSY/EPERM retry after 150 ms.
 *
 * A short retry bridges a transient-lock race window (antivirus mid-scan,
 * etc.) without masking legitimate persistent failures. Note: the long-running
 * "can't delete a video" reports were NOT transient locks — INV-014 traced
 * them to drives without a Recycle Bin; see `driveSupportsRecycleBin`.
 */
async function trashWithRetry(absolutePath: string): Promise<void> {
  try {
    await shell.trashItem(absolutePath);
  } catch (err: any) {
    const code: string | undefined = err?.code;
    const message: string = err?.message ?? '';
    const isTransientLock =
      code === 'EBUSY' ||
      code === 'EPERM' ||
      message.includes('resource busy or locked') ||
      message.includes('scandir');

    if (!isTransientLock) {
      throw err;
    }

    console.warn(
      `[trashWithRetry] First attempt failed for "${absolutePath}" (${
        code ?? message
      }). Retrying after 150 ms…`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    try {
      await shell.trashItem(absolutePath);
      console.info(`[trashWithRetry] Retry succeeded for "${absolutePath}".`);
    } catch (retryErr) {
      // Retry also failed — surface the original error unchanged so the
      // renderer's error-handling path (RemovalAlert.tsx) sees a failure.
      throw err;
    }
  }
}

/**
 * Best-effort check: does the volume containing `absolutePath` have a usable
 * Recycle Bin?
 *
 * `shell.trashItem` fails with a generic "Failed to perform delete operation"
 * (no error code) on volumes that lack a `$Recycle.Bin` — e.g. some archive
 * drives, network shares, and removable media. INV-014 confirmed this is the
 * actual cause of the long-standing "can't delete" reports, NOT a held video
 * file handle. When this returns false, the renderer routes the delete to
 * `deleteFilePermanently` instead, after warning the user up-front.
 *
 * Cached per drive root — Recycle Bin availability does not change mid-session.
 */
const recycleBinSupportCache = new Map<string, boolean>();
function driveSupportsRecycleBin(absolutePath: string): boolean {
  const root = path.parse(absolutePath).root;
  if (root === '') {
    return true; // can't determine the volume — let shell.trashItem try
  }
  const cached = recycleBinSupportCache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  let supported: boolean;
  try {
    supported = fse.pathExistsSync(path.join(root, '$Recycle.Bin'));
  } catch {
    supported = true; // probe failed — don't block, let shell.trashItem try
  }
  recycleBinSupportCache.set(root, supported);
  return supported;
}

/**
 * Permanently delete a file (no Recycle Bin). Used when the target volume has
 * no Recycle Bin — the renderer has already warned the user that this is
 * unrecoverable. See INV-014.
 */
async function deleteFilePermanently(absolutePath: string): Promise<void> {
  await fse.remove(absolutePath);
}

MainMessenger.onTrashFile((absolutePath) => trashWithRetry(absolutePath));

MainMessenger.onDeleteFilePermanently((absolutePath) => deleteFilePermanently(absolutePath));

MainMessenger.onCheckRecyclable((paths) => paths.filter((p) => !driveSupportsRecycleBin(p)));

MainMessenger.onIsFullScreen(() => mainWindow?.isFullScreen() ?? false);

MainMessenger.onSetFullScreen((isFullScreen) => mainWindow?.setFullScreen(isFullScreen));

MainMessenger.onGetZoomFactor(() => mainWindow?.webContents.zoomFactor ?? 1);

MainMessenger.onSetZoomFactor((factor) => {
  if (mainWindow !== null) {
    const zoom = Math.max(MIN_ZOOM_FACTOR, Math.min(factor, MAX_ZOOM_FACTOR));
    mainWindow.webContents.setZoomFactor(zoom);
  }
});

MainMessenger.onWindowSystemButtonPressed((button: WindowSystemButtonPress) => {
  if (mainWindow !== null) {
    switch (button) {
      case WindowSystemButtonPress.Close:
        mainWindow.close();
        break;

      case WindowSystemButtonPress.Maximize:
        mainWindow.maximize();
        break;

      case WindowSystemButtonPress.Minimize:
        mainWindow.minimize();
        break;

      case WindowSystemButtonPress.Restore:
        mainWindow.restore();
        break;

      default:
        break;
    }
  }
});

MainMessenger.onIsMaximized(() => mainWindow?.isMaximized() ?? false);

MainMessenger.onGetVersion(getVersion);

MainMessenger.onIsPortableMode(() => IS_PORTABLE_MODE);

// Media job IPC handlers — wired to MediaJobService (parameterized by job type, INV-020).
//
// START_MEDIA_JOB: the renderer invokes this and awaits a promise that resolves
// with { outputPath } when the job finishes, or rejects on failure/cancel.
// The first MEDIA_JOB_PROGRESS event carries the jobId so the renderer can call
// CANCEL_MEDIA_JOB if the user clicks cancel.

// Shared FfmpegRunner instance used by the media-job handler for the pre-encode audio probe.
// MediaJobService has its own internal runner for encoding; this is a lightweight probe-only
// runner that shares the same bundled binaries. Instantiated once at module load.
const _probeRunner = new FfmpegRunner();

MainMessenger.onStartMediaJob(async (wc, { inputPath, jobType, clip }) => {
  const spec = MEDIA_JOB_SPECS[jobType];

  // Post-`-i` args. Defaults to the static spec; subtract-clip replaces it with a
  // per-invocation -filter_complex graph built from the marks (see below).
  let jobArgs = spec.args;

  // Build preInputArgs for create-clip: -ss and/or -to must come before -i.
  // At least one marker (start or end) is required; both are optional individually.
  // For all other job types preInputArgs stays empty, preserving existing behavior.
  const preInputArgs: string[] = [];
  if (jobType === 'create-clip') {
    if (clip === undefined || (clip.start === undefined && clip.end === undefined)) {
      throw new Error('create-clip job requires at least one of start/end');
    }
    let startSec: number | null = null;
    let endSec: number | null = null;
    if (clip.start !== undefined) {
      startSec = parseHmsToSeconds(clip.start);
      if (startSec === null) {
        throw new Error(`create-clip: invalid start time "${clip.start}" — expected HH:MM:SS`);
      }
    }
    if (clip.end !== undefined) {
      endSec = parseHmsToSeconds(clip.end);
      if (endSec === null) {
        throw new Error(`create-clip: invalid end time "${clip.end}" — expected HH:MM:SS`);
      }
    }
    if (startSec !== null && endSec !== null && startSec >= endSec) {
      throw new Error(
        `create-clip: start time (${clip.start}) must be before end time (${clip.end})`,
      );
    }
    if (clip.start !== undefined) {
      preInputArgs.push('-ss', clip.start);
    }
    if (clip.end !== undefined) {
      preInputArgs.push('-to', clip.end);
    }
  } else if (jobType === 'subtract-clip') {
    // Subtract-clip removes the marked [start, end] section and cross-fades the survivors.
    // BOTH marks are required (you can't remove a middle without both bounds). Trimming is done
    // by the filtergraph, so there are NO preInputArgs — the dynamic args go after -i.
    if (clip === undefined || clip.start === undefined || clip.end === undefined) {
      throw new Error('subtract-clip job requires both start and end');
    }
    const startSec = parseHmsToSeconds(clip.start);
    if (startSec === null) {
      throw new Error(`subtract-clip: invalid start time "${clip.start}" — expected HH:MM:SS`);
    }
    const endSec = parseHmsToSeconds(clip.end);
    if (endSec === null) {
      throw new Error(`subtract-clip: invalid end time "${clip.end}" — expected HH:MM:SS`);
    }
    if (startSec >= endSec) {
      throw new Error(
        `subtract-clip: start time (${clip.start}) must be before end time (${clip.end})`,
      );
    }
    // offset = startSec − crossfade must be ≥ 0, so start must be at least one cross-fade in.
    if (startSec < SUBTRACT_CLIP_CROSSFADE_SEC) {
      throw new Error(
        `subtract-clip: start time (${clip.start}) must be at least ${SUBTRACT_CLIP_CROSSFADE_SEC}s ` +
          'into the video to fit the cross-fade',
      );
    }
    jobArgs = buildSubtractClipArgs(startSec, endSec);
  } else if (jobType === 'rotate-cw' || jobType === 'rotate-ccw' || jobType === 'reencode-x264') {
    // These three jobs copy audio into a forced .mp4, so we probe the source's first audio stream
    // up-front and decide: MP4-legal codec → -c:a copy; non-legal → -c:a aac -b:a 192k; no audio
    // stream → -an. A probe FAILURE on a file that should have audio throws here, which rejects the
    // handler promise and surfaces a Failed row in the media queue drawer. This is deterministic
    // (probe once, decide, encode once) — NOT a retry-on-failure scheme. (INV-032, Directive 2.)
    //
    // subtract-clip and normalize-audio already re-encode audio and are intentionally not probed.
    const audioArgs = await decideAudioArgs(_probeRunner, inputPath);
    jobArgs = [...spec.args, ...audioArgs];
  }

  return new Promise<MediaJobStartResult>((resolve, reject) => {
    const { jobId } = mediaJobService.start(
      inputPath,
      jobArgs,
      spec.outputExt,
      {
        onProgress: (progress) => {
          // Guard against a destroyed WebContents (e.g. window closed mid-job).
          if (!wc.isDestroyed()) {
            MainMessenger.sendMediaJobProgress(wc, {
              jobId: progress.jobId,
              percent: progress.percent,
              outTimeSec: progress.outTimeSec,
              totalSec: progress.totalSec,
            });
          }
        },
        // ffmpeg finished: file is in tempPath, untagged, NOT yet in the watched folder.
        // Resolve with both paths so the renderer can tag the temp file and then commit.
        onDone: ({ tempPath, finalPath }) => resolve({ jobId, tempPath, finalPath }),
        onError: (err) => reject(err),
        // Rejection with a distinguishable message lets the renderer treat cancel
        // differently from a hard failure (no toast, just unlock the UI).
        onCancelled: () => reject(new Error('MEDIA_JOB_CANCELLED')),
      },
      preInputArgs,
    );

    // Emit the very first progress event immediately so the renderer receives
    // the jobId before any real encode progress arrives.  This allows the
    // cancel button to stash the jobId without waiting for the first encode frame.
    if (!wc.isDestroyed()) {
      MainMessenger.sendMediaJobProgress(wc, {
        jobId,
        percent: 0,
        outTimeSec: 0,
        totalSec: undefined,
      });
    }
  });
});

// CANCEL_MEDIA_JOB: renderer sends the jobId it received from the first progress event.
MainMessenger.onCancelMediaJob((jobId) => {
  mediaJobService.cancel(jobId);
});

// COMMIT_MEDIA_JOB: renderer calls this after tagging the temp file with EXIF/XMP, having
// suppressed the watcher for finalPath. Moves tempPath → finalPath (single move); the renderer
// is the sole ingester of the result.
MainMessenger.onCommitMediaJob((jobId) => mediaJobService.place(jobId));

// Library management IPC handlers
MainMessenger.onGetLibraries(() => registry.getLibraries());
MainMessenger.onGetActiveLibraryId(() => registry.getActiveLibraryId());
MainMessenger.onSetActiveLibrary((id) => {
  registry.setActiveLibrary(id);
  registry.updateLastOpened(id);
});
MainMessenger.onCreateLibrary((name) => registry.createLibrary(name));
MainMessenger.onDeleteLibrary((id) => registry.deleteLibrary(id));
MainMessenger.onRenameLibrary((id, name) => registry.renameLibrary(id, name));

// Returns the absolute paths that would be deleted by DELETE_LIBRARY_AND_FILES,
// so the renderer can display them in the confirmation dialog before the user commits.
MainMessenger.onGetLibraryDiskPaths((id) => {
  const tempPath = app.getPath('temp');
  const libraryDir = path.join(basePath, 'libraries', id);
  return {
    libraryDir,
    dbPath: getSqliteDbPath(basePath, id),
    thumbnailDir: getDefaultThumbnailDir(basePath, tempPath, IS_PORTABLE_MODE, id),
  };
});

// Destructive deletion: removes the library's on-disk data (DB + WAL/SHM sidecars +
// backups/ + thumbnail cache) and then unregisters it.  Several safety gates apply:
//   1. Refuse if this is the currently active library.
//   2. Refuse if it is the last library (registry would be left empty).
//   3. Resolve all paths and validate that each stays inside its expected root.
//   4. Attempt fse.remove for each path; collect per-path errors instead of aborting.
//   5. Only call registry.deleteLibrary when ALL removals succeeded (or paths were absent).
MainMessenger.onDeleteLibraryAndFiles(async (id) => {
  const removedPaths: string[] = [];
  const failedPaths: { path: string; error: string }[] = [];

  // Safety gate 1: never delete the currently active library.
  if (id === registry.getActiveLibraryId()) {
    return {
      removedPaths: [],
      failedPaths: [{ path: id, error: 'Cannot delete the active library.' }],
    };
  }

  // Safety gate 2: refuse if this is the last library.
  if (registry.getLibraries().length <= 1) {
    return {
      removedPaths: [],
      failedPaths: [{ path: id, error: 'Cannot delete the last remaining library.' }],
    };
  }

  const tempPath = app.getPath('temp');
  const libraryDir = path.join(basePath, 'libraries', id);
  const thumbnailDir = getDefaultThumbnailDir(basePath, tempPath, IS_PORTABLE_MODE, id);

  // Safety gate 3: path-sanity assertions — prevent a crafted library ID containing
  // ".." from escaping the expected root directories.
  const resolvedLibraryDir = path.resolve(libraryDir);
  const resolvedThumbnailDir = path.resolve(thumbnailDir);
  const resolvedBasePath = path.resolve(basePath);
  // Thumbnail root differs by mode: portable uses basePath, installed uses tempPath.
  const resolvedThumbnailRoot = path.resolve(IS_PORTABLE_MODE ? basePath : tempPath);

  if (
    !resolvedLibraryDir.startsWith(resolvedBasePath + path.sep) &&
    resolvedLibraryDir !== resolvedBasePath
  ) {
    return {
      removedPaths: [],
      failedPaths: [
        {
          path: libraryDir,
          error: `Path sanity check failed: resolved path does not start with basePath. libraryDir=${resolvedLibraryDir}, basePath=${resolvedBasePath}`,
        },
      ],
    };
  }
  if (
    !resolvedThumbnailDir.startsWith(resolvedThumbnailRoot + path.sep) &&
    resolvedThumbnailDir !== resolvedThumbnailRoot
  ) {
    return {
      removedPaths: [],
      failedPaths: [
        {
          path: thumbnailDir,
          error: `Path sanity check failed: resolved thumbnail path does not start with expected root. thumbnailDir=${resolvedThumbnailDir}, root=${resolvedThumbnailRoot}`,
        },
      ],
    };
  }

  // Attempt removal of each path, collecting errors.  Order: thumbnail dir first,
  // then the library dir (which includes onefolder.db, -wal, -shm, and backups/).
  for (const p of [thumbnailDir, libraryDir]) {
    try {
      await fse.remove(p); // idempotent — does not throw for absent paths
      removedPaths.push(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failedPaths.push({ path: p, error: msg });
    }
  }

  // Only update the registry when every removal succeeded (ENOENT counts as success
  // because fse.remove is idempotent, but a real access error does not).
  if (failedPaths.length === 0) {
    registry.deleteLibrary(id);
  }

  return { removedPaths, failedPaths };
});

// Switch library: update the active library in the registry, then reload the
// main window (and close any open preview window) so the renderer reinitialises
// with the new library's database and preferences.
MainMessenger.onSwitchLibrary((newLibraryId) => {
  registry.setActiveLibrary(newLibraryId);
  registry.updateLastOpened(newLibraryId);
  if (previewWindow !== null && !previewWindow.isDestroyed()) {
    previewWindow.destroy();
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(
      `file://${__dirname}/index.html?libraryId=${encodeURIComponent(newLibraryId)}`,
    );
  }
});

// Helper functions and variables/constants

const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;
const MIN_WINDOW_WIDTH = 240;
const MIN_WINDOW_HEIGHT = 64;

function getMainWindowDisplay() {
  if (mainWindow !== null) {
    const winBounds = mainWindow.getBounds();
    return screen.getDisplayNearestPoint({
      x: winBounds.x + winBounds.width / 2,
      y: winBounds.y + winBounds.height / 2,
    });
  }
  return screen.getPrimaryDisplay();
}

// Based on https://github.com/electron/electron/issues/526
function getPreviousWindowState(): Electron.Rectangle & { isMaximized?: boolean } {
  const options: Electron.Rectangle & { isMaximized?: boolean } = {
    x: 0,
    y: 0,
    width: MIN_WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT,
  };
  try {
    const state = fse.readJSONSync(windowStateFilePath);
    state.x = Number(state.x);
    state.y = Number(state.y);
    state.width = Number(state.width);
    state.height = Number(state.height);
    state.isMaximized = Boolean(state.isMaximized);

    const area = screen.getDisplayMatching(state).workArea;
    // If the saved position still valid (the window is entirely inside the display area), use it.
    if (
      state.x >= area.x &&
      state.y >= area.y &&
      state.x + state.width <= area.x + area.width &&
      state.y + state.height <= area.y + area.height
    ) {
      options.x = state.x;
      options.y = state.y;
    }
    // If the saved size is still valid, use it.
    if (state.width <= area.width || state.height <= area.height) {
      options.width = state.width;
      options.height = state.height;
    }
    options.isMaximized = state.isMaximized;
  } catch (e) {
    // ENOENT is expected on first launch (file hasn't been written yet);
    // anything else — malformed JSON, permission error — is worth surfacing.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Could not read window state file, falling back to defaults.', e);
    }
    // Fallback to primary display screen size
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    options.width = width;
    options.height = height;
  }
  return options;
}

// Save window position and bounds: https://github.com/electron/electron/issues/526
let saveBoundsTimeout: ReturnType<typeof setTimeout> | null = null;
function saveWindowState() {
  if (saveBoundsTimeout) {
    clearTimeout(saveBoundsTimeout);
  }
  saveBoundsTimeout = setTimeout(() => {
    saveBoundsTimeout = null;
    if (mainWindow !== null) {
      const state = Object.assign(
        { isMaximized: mainWindow.isMaximized() },
        mainWindow.getNormalBounds(),
      );
      fse.writeFileSync(windowStateFilePath, JSON.stringify(state, null, 2));
    }
  }, 1000);
}

function forceRelaunch() {
  // We deliberately avoid app.relaunch(): its internal child-process handoff races
  // against Electron's exit cleanup in several packaging formats (notably the
  // Windows portable target, where process.execPath is inside an NSIS temp dir
  // that gets wiped on exit). Spawning a detached child ourselves before calling
  // app.exit() gives the new process an independent OS-level lifetime, so exit
  // ordering stops mattering.
  //
  // For the Windows portable target, PORTABLE_EXECUTABLE_FILE points to the outer
  // .exe that lives on disk permanently; re-executing it re-enters the normal
  // portable boot path (including the env-var injection that triggers portable
  // mode detection). In dev and all other packaged builds, process.execPath is
  // the right target.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath;
  // In dev, argv[1] is the app bundle path that electron.exe must be told to
  // load. Packaged/portable binaries know how to launch themselves.
  //
  // The user's own flags MUST be forwarded. Dropping them silently converts a
  // `--serve` process into a GUI process with no listener the first time any
  // relaunch path fires (tray menu, the uncaught-exception restart dialog,
  // onClearDatabase, reload) — the sidecar would simply disappear.
  const userFlags = process.argv.slice(app.isPackaged ? 1 : 2);
  const args = app.isPackaged ? [...userFlags] : [process.argv[1], ...userFlags];
  spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  }).unref();
  app.exit(0);
}

function getVersion(): string {
  if (IS_DEV) {
    // Weird quirk: it returns the Electron version in dev mode
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version;
  } else {
    return app.getVersion();
  }
}
