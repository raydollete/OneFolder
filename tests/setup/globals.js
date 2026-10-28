// Define the webpack DefinePlugin globals that renderer code references at
// module/render time (src/renderer.tsx uses IS_WEB_BUILD for the platform
// branch; support-mov-playback surfaces read it too). Individual tests may
// overwrite global.IS_WEB_BUILD to exercise the web-build branch.
global.IS_WEB_BUILD = false;
