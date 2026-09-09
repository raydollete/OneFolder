/**
 * Generate electron-builder's conventional Linux icon set into `build/icons/`.
 *
 * electron-builder's Linux target wants an icon *directory* whose filenames encode
 * the pixel size (e.g. `256x256.png`). We produce the standard freedesktop sizes by
 * resizing the highest-resolution brand PNG with `sharp` (already a project dependency),
 * falling back to an exact source PNG when one exists at that size.
 *
 * This is Linux-only. The mac/win icon pipeline (`.icns`/`.ico`) is handled by the
 * separate `logo` npm script and is intentionally left untouched here.
 *
 * Run: `node scripts/prepare-icons.js`
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'resources', 'logo', 'png', 'full-color');
const OUT_DIR = path.join(ROOT, 'build', 'icons');

// Conventional freedesktop / electron-builder icon sizes.
const SIZES = [16, 32, 48, 64, 128, 256, 512];

// The master image we resize from — the largest brand PNG available.
const MASTER = path.join(SRC_DIR, 'onefolder-logomark-fc-512x512.png');

function exactSource(size) {
  const candidate = path.join(SRC_DIR, `onefolder-logomark-fc-${size}x${size}.png`);
  return fs.existsSync(candidate) ? candidate : null;
}

async function main() {
  if (!fs.existsSync(MASTER)) {
    throw new Error(`prepare-icons: master icon not found at ${MASTER}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const size of SIZES) {
    const dest = path.join(OUT_DIR, `${size}x${size}.png`);
    const exact = exactSource(size);
    if (exact) {
      // Prefer the hand-authored asset at this exact size when one exists.
      await sharp(exact).resize(size, size, { fit: 'contain' }).png().toFile(dest);
    } else {
      await sharp(MASTER).resize(size, size, { fit: 'contain' }).png().toFile(dest);
    }
    // eslint-disable-next-line no-console
    console.log(`prepare-icons: wrote ${path.relative(ROOT, dest)}`);
  }

  // eslint-disable-next-line no-console
  console.log(`prepare-icons: ${SIZES.length} icons ready in ${path.relative(ROOT, OUT_DIR)}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`prepare-icons: FAILED — ${err && err.message ? err.message : err}`);
  process.exit(1);
});
