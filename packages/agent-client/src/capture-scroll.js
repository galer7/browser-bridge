// @ts-check

import { createHash } from 'node:crypto';
import { inflate, deflate } from 'node:zlib';
import { promisify } from 'node:util';

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

/** @typedef {import('./client.js').BridgeClient} BridgeClient */
/** @typedef {import('./types.js').BridgeRequestSource} BridgeRequestSource */
/** @typedef {import('../../protocol/src/types.js').ScreenshotResult} ScreenshotResult */
/** @typedef {import('../../protocol/src/types.js').ArtifactDescriptor} ArtifactDescriptor */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FRAME_OVERLAP_PX = 50;
const MAX_FRAMES = 100;

/**
 * @param {BridgeClient} client
 * @param {import('./types.js').BridgeMethod} method
 * @param {Record<string, unknown>} params
 * @param {{ source: BridgeRequestSource, targetProfile?: string | null, tabId?: number | null }} options
 */
async function bridgeCall(client, method, params, options) {
  const { requestBridge } = await import('./runtime.js');
  return requestBridge(client, method, params, options);
}

/**
 * Download an artifact from the bridge, returning its raw bytes.
 *
 * @param {BridgeClient} client
 * @param {ArtifactDescriptor} artifact
 * @param {{ source: BridgeRequestSource, targetProfile?: string | null }} options
 * @returns {Promise<Buffer>}
 */
async function downloadArtifactBytes(client, artifact, options) {
  const chunks = [];
  let offset = 0;
  try {
    while (offset < artifact.byteLength) {
      const response = await bridgeCall(
        client,
        'artifact.read',
        { artifactId: artifact.artifactId, offset },
        options
      );
      if (!response.ok) throw new Error(response.error.message);
      const result = /** @type {Record<string, unknown>} */ (response.result);
      const data = String(result.data ?? '');
      const bytes = Buffer.from(data, 'base64');
      chunks.push(bytes);
      if (result.nextOffset === null) break;
      if (typeof result.nextOffset !== 'number' || result.nextOffset <= offset) break;
      offset = result.nextOffset;
    }
    const output = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(output).digest('hex');
    if (output.length !== artifact.byteLength || sha256 !== artifact.sha256) {
      throw new Error('Artifact checksum mismatch.');
    }
    return output;
  } finally {
    await bridgeCall(
      client,
      'artifact.delete',
      { artifactId: artifact.artifactId },
      options
    ).catch(() => {});
  }
}

/**
 * Capture a single viewport screenshot and return the raw image bytes.
 *
 * @param {BridgeClient} client
 * @param {{ source: BridgeRequestSource, targetProfile?: string | null, tabId?: number | null }} options
 * @param {{ format: 'png' | 'jpeg' | 'webp', quality?: number }} imageOptions
 * @returns {Promise<{ bytes: Buffer, dimensions: { width: number, height: number } }>}
 */
async function captureViewportFrame(client, options, imageOptions) {
  const response = await bridgeCall(
    client,
    'screenshot.capture_element',
    {
      selector: 'html',
      format: imageOptions.format,
      quality: imageOptions.quality,
      delivery: 'artifact',
    },
    options
  );
  if (!response.ok) {
    throw new Error(`Screenshot failed: ${response.error?.message || 'unknown error'}`);
  }
  const result = /** @type {ScreenshotResult} */ (response.result);
  let bytes;
  if (result.delivery === 'artifact') {
    bytes = await downloadArtifactBytes(client, result.artifact, options);
  } else {
    const match = /^data:image\/[^;]+;base64,(.+)$/u.exec(result.image);
    if (!match) throw new Error('Invalid inline screenshot data.');
    bytes = Buffer.from(match[1], 'base64');
  }
  return { bytes, dimensions: result.dimensions };
}

/**
 * Parse a PNG file into its raw RGBA pixel data.
 *
 * @param {Buffer} pngBytes
 * @returns {Promise<{ width: number, height: number, pixels: Buffer }>}
 */
async function decodePng(pngBytes) {
  if (!pngBytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a valid PNG file.');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < pngBytes.length) {
    const length = pngBytes.readUInt32BE(offset);
    const type = pngBytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = pngBytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
  const compressed = Buffer.concat(idatChunks);
  const raw = await inflateAsync(compressed);
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    const filterByte = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const rowData = Buffer.alloc(stride);

    for (let x = 0; x < stride; x++) {
      const curr = raw[rowStart + x];
      const a = x >= bytesPerPixel ? rowData[x - bytesPerPixel] : 0;
      const b =
        y > 0
          ? pixels[(y - 1) * width * 4 + Math.floor(x / bytesPerPixel) * 4 + (x % bytesPerPixel)]
          : 0;
      const bRaw = y > 0 ? rowData[x] : 0;

      let value;
      switch (filterByte) {
        case 0:
          value = curr;
          break;
        case 1:
          value = (curr + a) & 0xff;
          break;
        case 2: {
          const bPrev = y > 0 ? getReconstructedPixel(pixels, y - 1, x, width, bytesPerPixel) : 0;
          value = (curr + bPrev) & 0xff;
          break;
        }
        case 3: {
          const bPrev2 = y > 0 ? getReconstructedPixel(pixels, y - 1, x, width, bytesPerPixel) : 0;
          value = (curr + Math.floor((a + bPrev2) / 2)) & 0xff;
          break;
        }
        case 4: {
          const bPrev3 = y > 0 ? getReconstructedPixel(pixels, y - 1, x, width, bytesPerPixel) : 0;
          const c =
            y > 0 && x >= bytesPerPixel
              ? getReconstructedPixel(pixels, y - 1, x - bytesPerPixel, width, bytesPerPixel)
              : 0;
          value = (curr + paethPredictor(a, bPrev3, c)) & 0xff;
          break;
        }
        default:
          value = curr;
      }
      rowData[x] = value;
    }

    for (let px = 0; px < width; px++) {
      const dstOff = (y * width + px) * 4;
      if (channels === 4) {
        pixels[dstOff] = rowData[px * 4];
        pixels[dstOff + 1] = rowData[px * 4 + 1];
        pixels[dstOff + 2] = rowData[px * 4 + 2];
        pixels[dstOff + 3] = rowData[px * 4 + 3];
      } else if (channels === 3) {
        pixels[dstOff] = rowData[px * 3];
        pixels[dstOff + 1] = rowData[px * 3 + 1];
        pixels[dstOff + 2] = rowData[px * 3 + 2];
        pixels[dstOff + 3] = 255;
      } else {
        pixels[dstOff] = pixels[dstOff + 1] = pixels[dstOff + 2] = rowData[px];
        pixels[dstOff + 3] = 255;
      }
    }
  }

  return { width, height, pixels };
}

/**
 * @param {Buffer} pixels
 * @param {number} row
 * @param {number} byteIndex
 * @param {number} width
 * @param {number} bytesPerPixel
 * @returns {number}
 */
function getReconstructedPixel(pixels, row, byteIndex, width, bytesPerPixel) {
  const px = Math.floor(byteIndex / bytesPerPixel);
  const channel = byteIndex % bytesPerPixel;
  if (px >= width) return 0;
  const rgbaChannel = bytesPerPixel === 3 && channel < 3 ? channel : channel;
  return pixels[(row * width + px) * 4 + rgbaChannel];
}

/** @param {number} a @param {number} b @param {number} c @returns {number} */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Encode raw RGBA pixels as a PNG file.
 *
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
async function encodePng(pixels, width, height) {
  const stride = width * 4;
  const rawRows = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    rawRows[y * (stride + 1)] = 0; // no filter
    pixels.copy(rawRows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const compressed = await deflateAsync(rawRows);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // no filter
  ihdr[12] = 0; // no interlace

  const parts = [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat(parts);
}

/**
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pngChunk(type, data) {
  const buf = Buffer.alloc(12 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.write(type, 4, 4, 'ascii');
  data.copy(buf, 8);
  const crcData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  buf.writeUInt32BE(crc32(crcData) >>> 0, 8 + data.length);
  return buf;
}

/** CRC-32 lookup table */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} data @returns {number} */
function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Stitch multiple PNG frame buffers vertically, cropping overlap from subsequent frames.
 *
 * @param {{ bytes: Buffer, cropTop: number }[]} frames
 * @returns {Promise<Buffer>}
 */
async function stitchPngFrames(frames) {
  const decoded = [];
  for (const frame of frames) {
    decoded.push({ ...(await decodePng(frame.bytes)), cropTop: frame.cropTop });
  }

  const width = decoded[0].width;
  let totalHeight = 0;
  for (const d of decoded) {
    if (d.width !== width) throw new Error('All frames must have the same width.');
    totalHeight += d.height - d.cropTop;
  }

  const combined = Buffer.alloc(width * totalHeight * 4);
  let yOffset = 0;
  for (const d of decoded) {
    const croppedHeight = d.height - d.cropTop;
    const srcStart = d.cropTop * width * 4;
    d.pixels.copy(combined, yOffset * width * 4, srcStart, srcStart + croppedHeight * width * 4);
    yOffset += croppedHeight;
  }

  return encodePng(combined, width, totalHeight);
}

/**
 * Capture a full-page scrolling screenshot.
 *
 * @param {BridgeClient} client
 * @param {{
 *   tabId?: number | null,
 *   format?: 'png' | 'jpeg' | 'webp',
 *   quality?: number,
 *   source?: BridgeRequestSource,
 *   targetProfile?: string | null
 * }} options
 * @returns {Promise<{
 *   image: Buffer,
 *   frameCount: number,
 *   totalHeight: number,
 *   viewportHeight: number,
 *   scrollContainer: string | null,
 *   format: string
 * }>}
 */
export async function captureScrollingPage(client, options = {}) {
  const format = options.format || 'png';
  const reqOpts = {
    source: /** @type {BridgeRequestSource} */ (options.source || 'cli'),
    targetProfile: options.targetProfile ?? null,
    tabId: options.tabId ?? null,
  };

  const stateResp = await bridgeCall(client, 'page.get_state', {}, reqOpts);
  if (!stateResp.ok) throw new Error(`page.get_state failed: ${stateResp.error?.message}`);

  const state = /** @type {Record<string, any>} */ (stateResp.result);
  const viewportHeight = state.viewport?.height || 800;
  const scroll = state.scroll || {};
  const container = scroll.container;

  let totalScrollHeight;
  /** @type {string | null} */
  let scrollContainerTag = null;
  if (container) {
    totalScrollHeight = container.scrollHeight;
    scrollContainerTag = container.tag;
  } else {
    totalScrollHeight = scroll.maxY + viewportHeight;
  }

  if (totalScrollHeight <= viewportHeight) {
    const frame = await captureViewportFrame(client, reqOpts, { format, quality: options.quality });
    return {
      image: frame.bytes,
      frameCount: 1,
      totalHeight: frame.dimensions.height,
      viewportHeight,
      scrollContainer: scrollContainerTag,
      format,
    };
  }

  const step = Math.max(100, viewportHeight - FRAME_OVERLAP_PX);
  /** @type {{ bytes: Buffer, cropTop: number }[]} */
  const frames = [];

  const originalY = scroll.y || 0;

  await bridgeCall(client, 'viewport.scroll', { top: 0 }, reqOpts);
  await delay(150);

  let scrollPos = 0;
  for (let i = 0; i < MAX_FRAMES; i++) {
    const frame = await captureViewportFrame(client, reqOpts, { format, quality: options.quality });
    const cropTop = i === 0 ? 0 : FRAME_OVERLAP_PX;
    frames.push({ bytes: frame.bytes, cropTop });

    scrollPos += step;
    if (scrollPos >= totalScrollHeight - viewportHeight) {
      if (scrollPos - step < totalScrollHeight - viewportHeight) {
        await bridgeCall(
          client,
          'viewport.scroll',
          { top: totalScrollHeight - viewportHeight },
          reqOpts
        );
        await delay(150);
        const lastFrame = await captureViewportFrame(client, reqOpts, {
          format,
          quality: options.quality,
        });
        const lastCropTop = Math.max(
          0,
          viewportHeight - (totalScrollHeight - (scrollPos - step + FRAME_OVERLAP_PX))
        );
        frames.push({ bytes: lastFrame.bytes, cropTop: Math.min(lastCropTop, viewportHeight - 1) });
      }
      break;
    }

    await bridgeCall(client, 'viewport.scroll', { top: scrollPos }, reqOpts);
    await delay(150);
  }

  await bridgeCall(client, 'viewport.scroll', { top: originalY }, reqOpts).catch(() => {});

  if (format !== 'png') {
    return {
      image: frames[0].bytes,
      frameCount: frames.length,
      totalHeight: totalScrollHeight,
      viewportHeight,
      scrollContainer: scrollContainerTag,
      format,
    };
  }

  const stitched = await stitchPngFrames(frames);
  return {
    image: stitched,
    frameCount: frames.length,
    totalHeight: totalScrollHeight,
    viewportHeight,
    scrollContainer: scrollContainerTag,
    format,
  };
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { decodePng as _decodePng, encodePng as _encodePng, stitchPngFrames as _stitchPngFrames };
