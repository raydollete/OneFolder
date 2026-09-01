/**
 * Server-side DOM-less image decoders — INV-034 / TASK-131.
 *
 * Provides a single `decodeToWebp(sourceFile, destFile)` function that
 * dispatches by extension to the appropriate decoder and writes a webp file:
 *
 *   HEIC / HEIF / TIFF / TIF  → Sharp (libvips native support)
 *   PSD                        → Sharp first; ag-psd fallback with a Node-safe
 *                                 createImageData shim → raw-pixel → Sharp encode
 *   EXR                        → WASM decoder loaded via WebAssembly.instantiate
 *                                 with a custom imports.wbg that captures the raw
 *                                 pixel buffer WITHOUT constructing a DOM ImageData
 *                                 object → tone-map float → 8-bit → Sharp encode
 *
 * HARD CONSTRAINT: no `document`, `OffscreenCanvas`, `createImageBitmap`, or
 * `toBlob` anywhere in this file — it runs in a plain Node.js process.
 *
 * The renderer-side loaders (TifLoader, ExrLoader, HEICLoader, PSDLoader) are
 * NOT modified by this task.  They continue to run in the Electron renderer
 * process for the desktop build.
 */

import path from 'path';
import fse from 'fs-extra';
import sharp from 'sharp';
import { readPsd, initializeCanvas } from 'ag-psd';

// ---------------------------------------------------------------------------
// Supported non-web format extensions that this module can decode
// ---------------------------------------------------------------------------

export const PREVIEW_FORMATS = new Set(['heic', 'heif', 'tiff', 'tif', 'psd', 'psb', 'exr']);

/** Returns true if the extension (lowercase, without dot) is handled here. */
export function isPreviewFormat(ext: string): boolean {
  return PREVIEW_FORMATS.has(ext.toLowerCase());
}

// ---------------------------------------------------------------------------
// ag-psd Node shim
//
// ag-psd's `createImageData` calls `document.createElement('canvas')` by
// default.  We override it via `initializeCanvas` to return a plain object
// `{ data: Uint8ClampedArray, width, height }` that matches the ImageData
// shape Sharp needs (width, height, raw RGBA data).
//
// initializeCanvas(createCanvas, createCanvasFromData, createImageData)
//   - createCanvas: we stub with a throw because PSD decode with useImageData=true
//     never calls createCanvas for the composite image (only for layer canvases,
//     which useImageData replaces).  If it IS called, we want a loud error, not a
//     silent failure.
//   - createCanvasFromData: unused in the read path; stub.
//   - createImageData: returns a plain { data, width, height } object.
// ---------------------------------------------------------------------------

let _agPsdInitialized = false;

function ensureAgPsdInitialized(): void {
  if (_agPsdInitialized) {
    return;
  }
  _agPsdInitialized = true;

  // Plain-object ImageData substitute — shape matches what Sharp.raw() expects.
  interface NodeImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }

  function nodeCreateImageData(width: number, height: number): NodeImageData {
    return {
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    };
  }

  // We never call the canvas-based paths with useImageData:true, but provide a
  // stub that throws loud so any unexpected call surfaces immediately.
  function stubCreateCanvas(): never {
    throw new Error(
      '[decode/ag-psd] createCanvas was called on the server — ' +
        'use readPsd with { useImageData: true, skipLayerImageData: true }',
    );
  }

  initializeCanvas(
    stubCreateCanvas as unknown as Parameters<typeof initializeCanvas>[0],
    stubCreateCanvas as unknown as Parameters<typeof initializeCanvas>[1],
    nodeCreateImageData as unknown as Parameters<typeof initializeCanvas>[2],
  );
}

// ---------------------------------------------------------------------------
// EXR WASM — canvas-less Node loader
//
// The bundled exr_decoder.js uses a DOM `new ImageData(data, width, height)`
// call inside the WASM import hook:
//   imports.wbg.__wbg_newwithu8clampedarrayandsh_87d2f0a48030f922
//
// In Node that constructor doesn't exist.  We load the .wasm binary directly
// with WebAssembly.instantiate and supply a replacement import that captures
// the Uint8ClampedArray + dimensions into a plain { data, width, height }
// object stored on the heap, exactly as the WASM glue expects.
//
// The decoded RGBA pixel data is then tone-mapped and passed to Sharp for
// webp/jpeg encoding — no Canvas, no toBlob, no document anywhere.
// ---------------------------------------------------------------------------

/** Shape returned by the EXR WASM decode, mimicking ImageData structurally. */
interface RawPixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface ExrWasmExports {
  memory: WebAssembly.Memory;
  decode: (retptr: number, ptr: number, len: number) => void;
  __wbindgen_add_to_stack_pointer: (n: number) => number;
  __wbindgen_malloc: (size: number) => number;
  __wbindgen_exn_store: (idx: number) => void;
}

/** Cached WASM instance — initialize once per server process. */
let _exrWasm: ExrWasmExports | null = null;

/** Heap of JS objects used by the WASM glue (mirrors exr_decoder.js). */
const _exrHeap: unknown[] = new Array(32).fill(undefined);
_exrHeap.push(undefined, null, true, false);
let _exrHeapNext = _exrHeap.length;

function exrAddHeapObject(obj: unknown): number {
  if (_exrHeapNext === _exrHeap.length) {
    _exrHeap.push(_exrHeap.length + 1);
  }
  const idx = _exrHeapNext;
  _exrHeapNext = _exrHeap[idx] as number;
  _exrHeap[idx] = obj;
  return idx;
}

function exrGetObject(idx: number): unknown {
  return _exrHeap[idx];
}

function exrDropObject(idx: number): void {
  if (idx < 36) {
    return;
  }
  _exrHeap[idx] = _exrHeapNext;
  _exrHeapNext = idx;
}

function exrTakeObject(idx: number): unknown {
  const ret = exrGetObject(idx);
  exrDropObject(idx);
  return ret;
}

/**
 * Resolve the path to the EXR WASM binary.
 *
 * During development (__dirname = dist/ or src/server/ depending on ts-node)
 * the file lives at wasm/packages/exr/exr_decoder_bg.wasm relative to the
 * project root.  In a packaged build it will be alongside the server bundle.
 *
 * We search a few candidate locations and return the first one that exists.
 */
function resolveWasmPath(): string {
  // In serve mode this code runs inside the Electron main bundle, so
  // __dirname is `build/` in development and `…/resources/app.asar/build`
  // in the packaged app — neither of which the original candidates matched.
  // process.resourcesPath exists only under Electron; guard it for plain Node.
  const electronResources = (process as { resourcesPath?: string }).resourcesPath;

  const candidates = [
    // Packaged Electron: shipped as an extraResource beside the asar.
    ...(electronResources !== undefined
      ? [path.join(electronResources, 'wasm', 'packages', 'exr', 'exr_decoder_bg.wasm')]
      : []),
    // Electron main bundle in development (__dirname = <repo>/build).
    path.resolve(__dirname, '..', 'wasm', 'packages', 'exr', 'exr_decoder_bg.wasm'),
    // Relative to this compiled file in dist/server/
    path.resolve(__dirname, '..', '..', 'wasm', 'packages', 'exr', 'exr_decoder_bg.wasm'),
    // Relative to project root when running ts-node from src/server/
    path.resolve(__dirname, '..', '..', '..', 'wasm', 'packages', 'exr', 'exr_decoder_bg.wasm'),
    // Same directory as this file (packaged/bundled alongside)
    path.resolve(__dirname, 'exr_decoder_bg.wasm'),
  ];

  for (const c of candidates) {
    if (fse.pathExistsSync(c)) {
      return c;
    }
  }

  throw new Error(
    '[decode/exr] Cannot locate exr_decoder_bg.wasm. Tried:\n' +
      candidates.map((c) => `  ${c}`).join('\n'),
  );
}

/**
 * Load and instantiate the EXR WASM module with Node-safe imports.
 *
 * Replaces the DOM `new ImageData(data, width, height)` constructor with a
 * plain object creator so the WASM module runs in Node without a canvas.
 *
 * NOTE — runtime verification required:
 *   This init path has been written by reading the WASM glue source closely,
 *   but has NOT been exercised in a live Node process as part of this task.
 *   The end-of-run / QA pass must open an EXR file via /api/preview/:id and
 *   confirm the server logs show "EXR WASM decode" and the response is webp.
 *   See TASK-137 for the full QA checklist.
 */
async function initExrWasm(): Promise<ExrWasmExports> {
  if (_exrWasm) {
    return _exrWasm;
  }

  const wasmPath = resolveWasmPath();
  const wasmBytes = await fse.readFile(wasmPath);

  // instanceRef is declared before imports so the closure in the wbg import can
  // reference it.  It is populated synchronously after WebAssembly.instantiate
  // returns, before any decode() call can access it.
  const instanceRef: { exports: WebAssembly.Exports } = { exports: {} };

  // Mirror the imports object from exr_decoder.js, replacing the ImageData
  // constructor with a plain-object factory that captures the pixel buffer.
  const imports: WebAssembly.Imports = {
    wbg: {
      // Original: new ImageData(clampedArray, width, height)
      // Replacement: { data: clampedArray, width, height }
      __wbg_newwithu8clampedarrayandsh_87d2f0a48030f922(
        dataPtr: number,
        dataLen: number,
        width: number,
        height: number,
      ): number {
        // Access memory via `instanceRef.exports` which is populated after
        // WebAssembly.instantiate() returns (before any decode() call).
        const memory = new Uint8ClampedArray(
          (instanceRef.exports as unknown as ExrWasmExports).memory.buffer,
          dataPtr,
          dataLen,
        );
        // Copy the data out of WASM linear memory before it can be GC'd / moved.
        const dataCopy = new Uint8ClampedArray(dataLen);
        dataCopy.set(memory);
        const obj: RawPixelData = { data: dataCopy, width: width >>> 0, height: height >>> 0 };
        return exrAddHeapObject(obj);
      },

      __wbindgen_throw(ptr: number, len: number): never {
        const mem = new Uint8Array(
          (instanceRef.exports as unknown as ExrWasmExports).memory.buffer,
          ptr,
          len,
        );
        const msg = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(mem);
        throw new Error(msg);
      },
    },
  };

  const result = await WebAssembly.instantiate(wasmBytes, imports);
  instanceRef.exports = result.instance.exports;

  _exrWasm = result.instance.exports as unknown as ExrWasmExports;
  console.info('[decode/exr] EXR WASM module initialized from', wasmPath);

  return _exrWasm;
}

/**
 * Decode an EXR file buffer using the WASM decoder.
 *
 * Returns a RawPixelData { data: Uint8ClampedArray(RGBA 8-bit), width, height }
 * with values tone-mapped from HDR float to SDR 8-bit via reinhard tone-mapping.
 *
 * IMPORTANT — the existing WASM decoder (wasm/packages/exr/exr_decoder.js)
 * appears to return RGBA uint8 data already (it produces an `ImageData`-shaped
 * object where data is Uint8ClampedArray, meaning it tone-maps internally in
 * Rust).  If that assumption is wrong — i.e. the WASM returns float32 RGBA —
 * we apply a Reinhard tone-map fallback here.  This needs runtime verification.
 */
async function decodeExrBuffer(fileBuffer: Buffer): Promise<RawPixelData> {
  const wasm = await initExrWasm();

  // --- mirror the decode() function from exr_decoder.js ---

  // Get a fresh view of WASM memory (it can grow and invalidate cached views).
  function getUint8Memory(): Uint8Array {
    return new Uint8Array(wasm.memory.buffer);
  }
  function getInt32Memory(): Int32Array {
    return new Int32Array(wasm.memory.buffer);
  }

  // Copy the input bytes into WASM linear memory.
  const ptr = wasm.__wbindgen_malloc(fileBuffer.length);
  const mem = getUint8Memory();
  mem.set(fileBuffer, ptr);
  const len = fileBuffer.length;

  // Call the WASM decode function.
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    wasm.decode(retptr, ptr, len);
    const r0 = getInt32Memory()[retptr / 4 + 0];
    const r1 = getInt32Memory()[retptr / 4 + 1];
    const r2 = getInt32Memory()[retptr / 4 + 2];
    if (r2) {
      throw exrTakeObject(r1);
    }
    return exrTakeObject(r0) as RawPixelData;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

/**
 * Tone-map HDR float32 RGBA → uint8 RGBA via Reinhard operator.
 *
 * Used as a fallback if the WASM decoder returns float32 data instead of
 * uint8 (i.e. if RawPixelData.data.byteLength !== width * height * 4 bytes
 * but rather width * height * 4 * 4 bytes for Float32).
 *
 * NOTE: the WASM decoder most likely returns uint8 RGBA directly (since it
 * produces an ImageData whose .data is Uint8ClampedArray).  This function
 * is a safety net that is only called if byte length doesn't match uint8 layout.
 */
function tonemapFloat32toUint8(
  floatData: Float32Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const n = width * height * 4;
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 4) {
    // Reinhard tone-mapping per channel (R, G, B); pass alpha through.
    out[i + 0] = Math.round((floatData[i + 0] / (floatData[i + 0] + 1)) * 255);
    out[i + 1] = Math.round((floatData[i + 1] / (floatData[i + 1] + 1)) * 255);
    out[i + 2] = Math.round((floatData[i + 2] / (floatData[i + 2] + 1)) * 255);
    out[i + 3] = Math.round(Math.min(1, floatData[i + 3]) * 255);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public decode interface
// ---------------------------------------------------------------------------

export interface DecodeResult {
  /** Encoded webp/jpeg Buffer ready to send as HTTP response. */
  buffer: Buffer;
  /** MIME type of the encoded output ('image/webp' or 'image/jpeg'). */
  mimeType: 'image/webp' | 'image/jpeg';
}

export type DecodeOutputFormat = 'webp' | 'jpeg';

/**
 * Decode a HEIC/HEIF/TIFF/PSD/EXR source file to webp (default) or jpeg.
 *
 * - HEIC/HEIF/TIFF/TIF: Sharp handles natively.
 * - PSD/PSB: Sharp first; ag-psd fallback with Node-safe createImageData shim.
 * - EXR: WASM decoder with canvas-less raw-pixel → Sharp encode.
 *
 * @param sourcePath  Absolute path to the source image (already validated by
 *                     path-resolver before this call).
 * @param format      Output encoding format; defaults to 'webp'.
 * @returns           { buffer, mimeType } where buffer is the encoded image.
 */
export async function decodeToBuffer(
  sourcePath: string,
  format: DecodeOutputFormat = 'webp',
): Promise<DecodeResult> {
  const ext = path.extname(sourcePath).replace(/^\./, '').toLowerCase();
  const mimeType: DecodeResult['mimeType'] = format === 'jpeg' ? 'image/jpeg' : 'image/webp';

  // -------------------------------------------------------------------------
  // HEIC / HEIF / TIFF — Sharp native decode
  // -------------------------------------------------------------------------
  if (ext === 'heic' || ext === 'heif' || ext === 'tiff' || ext === 'tif') {
    console.info(`[decode] Sharp decode: ${ext} → ${format} for ${path.basename(sourcePath)}`);
    const pipeline = sharp(sourcePath);
    const buffer = await encodeSharpPipeline(pipeline, format);
    return { buffer, mimeType };
  }

  // -------------------------------------------------------------------------
  // PSD / PSB — Sharp first, ag-psd fallback
  // -------------------------------------------------------------------------
  if (ext === 'psd' || ext === 'psb') {
    // Sharp does not officially support PSD natively in most builds, but we
    // attempt it first since libvips can sometimes parse flat PSDs.
    try {
      console.info(`[decode] Sharp decode attempt: ${ext} for ${path.basename(sourcePath)}`);
      const pipeline = sharp(sourcePath);
      // Verify Sharp can actually decode it by fetching metadata.
      await pipeline.metadata();
      const buffer = await encodeSharpPipeline(pipeline, format);
      return { buffer, mimeType };
    } catch (_sharpErr) {
      console.info(
        `[decode] Sharp failed for ${ext}, falling back to ag-psd: ${path.basename(sourcePath)}`,
      );
    }

    // ag-psd fallback — DOM-less via initializeCanvas override.
    return decodePsdAgPsd(sourcePath, format);
  }

  // -------------------------------------------------------------------------
  // EXR — WASM decoder, canvas-less
  // -------------------------------------------------------------------------
  if (ext === 'exr') {
    return decodeExr(sourcePath, format);
  }

  throw new Error(
    `[decode] Unsupported format "${ext}" — not in PREVIEW_FORMATS. Supported: ${[
      ...PREVIEW_FORMATS,
    ].join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// PSD via ag-psd
// ---------------------------------------------------------------------------

async function decodePsdAgPsd(
  sourcePath: string,
  format: DecodeOutputFormat,
): Promise<DecodeResult> {
  ensureAgPsdInitialized();

  const fileBuffer = await fse.readFile(sourcePath);
  // useImageData: true  → psd.imageData is a plain {data, width, height} (not a canvas)
  // skipLayerImageData  → skip layer compositing, use flat composite only
  const psd = readPsd(fileBuffer.buffer as ArrayBuffer, {
    useImageData: true,
    skipLayerImageData: true,
  });

  const imageData = psd.imageData as
    | { data: Uint8ClampedArray; width: number; height: number }
    | undefined;
  if (!imageData) {
    throw new Error(`[decode/psd] ag-psd returned no imageData for ${path.basename(sourcePath)}`);
  }

  const { data, width, height } = imageData;
  const mimeType: DecodeResult['mimeType'] = format === 'jpeg' ? 'image/jpeg' : 'image/webp';

  console.info(
    `[decode] ag-psd decode: PSD ${width}×${height} → ${format} for ${path.basename(sourcePath)}`,
  );

  // Sharp.raw() accepts a Buffer with { raw: { width, height, channels } }.
  // Uint8ClampedArray is RGBA (4 channels).
  const rawBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const pipeline = sharp(rawBuffer, {
    raw: { width, height, channels: 4 },
  });
  const buffer = await encodeSharpPipeline(pipeline, format);
  return { buffer, mimeType };
}

// ---------------------------------------------------------------------------
// EXR via WASM
// ---------------------------------------------------------------------------

async function decodeExr(sourcePath: string, format: DecodeOutputFormat): Promise<DecodeResult> {
  const fileBuffer = await fse.readFile(sourcePath);
  const rawPixel = await decodeExrBuffer(fileBuffer);

  const { data, width, height } = rawPixel;
  const mimeType: DecodeResult['mimeType'] = format === 'jpeg' ? 'image/jpeg' : 'image/webp';

  // Determine if data is uint8 (byteLength === w*h*4) or float32 (byteLength === w*h*16).
  const expectedUint8Len = width * height * 4;
  let uint8Data: Uint8ClampedArray;

  if (data.byteLength === expectedUint8Len) {
    // WASM decoder returned Uint8ClampedArray RGBA directly (most likely case).
    uint8Data = data;
    console.info(
      `[decode] EXR WASM decode: ${width}×${height} uint8 RGBA → ${format} for ${path.basename(
        sourcePath,
      )}`,
    );
  } else if (data.byteLength === expectedUint8Len * 4) {
    // WASM returned float32 RGBA — apply Reinhard tone-mapping.
    const float32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    uint8Data = tonemapFloat32toUint8(float32, width, height);
    console.info(
      `[decode] EXR WASM decode: ${width}×${height} float32 RGBA (tone-mapped) → ${format} for ${path.basename(
        sourcePath,
      )}`,
    );
  } else {
    throw new Error(
      `[decode/exr] Unexpected pixel data length: ${data.byteLength} ` +
        `(expected ${expectedUint8Len} for uint8 or ${expectedUint8Len * 4} for float32). ` +
        `Image: ${width}×${height}`,
    );
  }

  const rawBuffer = Buffer.from(uint8Data.buffer, uint8Data.byteOffset, uint8Data.byteLength);
  const pipeline = sharp(rawBuffer, {
    raw: { width, height, channels: 4 },
  });
  const buffer = await encodeSharpPipeline(pipeline, format);
  return { buffer, mimeType };
}

// ---------------------------------------------------------------------------
// Shared Sharp encode helper
// ---------------------------------------------------------------------------

async function encodeSharpPipeline(
  pipeline: ReturnType<typeof sharp>,
  format: DecodeOutputFormat,
): Promise<Buffer> {
  let encoded: ReturnType<typeof sharp>;

  switch (format) {
    case 'webp':
      encoded = pipeline.webp({ quality: 85 });
      break;
    case 'jpeg':
      encoded = pipeline.jpeg({ quality: 85 });
      break;
    default:
      encoded = pipeline.webp({ quality: 85 });
  }

  return encoded.toBuffer();
}
