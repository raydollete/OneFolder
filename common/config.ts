// Randomly chosen, hopefully no conflicts with other apps/services
export const SERVER_PORT = 5454;

export const chromeExtensionUrl = 'https://chrome.google.com/webstore/';

export const firefoxExtensionUrl = 'https://addons.mozilla.org/nl/firefox/addon/';

export const RECURSIVE_DIR_WATCH_DEPTH = 16;

/** No technical limitation, just for preventing infinite loops due to bugs */
export const MAX_TAG_DEPTH = 32;

export const thumbnailFormat = 'webp';

const isRenderer = process.type === 'renderer';

// Use higher thumbnail resolution for HiDPI screens
// A value of 1 indicates a classic 96 DPI (76 DPI on some platforms) display, while a value of 2 is expected for HiDPI/Retina displays.
// The values 600 : 400 needed to be flipped in order to get 600 on OSX Retina
export const thumbnailMaxSize = isRenderer && globalThis.devicePixelRatio >= 1.5 ? 400 : 600;

export const maxNumberOfExternalFilesBeforeWarning = 9;
