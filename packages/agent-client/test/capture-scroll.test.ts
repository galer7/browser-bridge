import assert from 'node:assert/strict';
import { test } from 'node:test';

test('capture-scroll module exports captureScrollingPage', async () => {
  const mod = await import('../src/capture-scroll.js');
  assert.equal(typeof mod.captureScrollingPage, 'function');
});

test('PNG encode/decode roundtrip produces identical pixels', async () => {
  const { _encodePng: encodePng, _decodePng: decodePng } = await import('../src/capture-scroll.js');
  const width = 4;
  const height = 3;
  const pixels = Buffer.alloc(width * height * 4);
  // Fill with a recognizable pattern: red, green, blue, white across first row
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      pixels[off] = (x * 85) & 0xff;      // R
      pixels[off + 1] = (y * 127) & 0xff;  // G
      pixels[off + 2] = ((x + y) * 60) & 0xff; // B
      pixels[off + 3] = 255;               // A
    }
  }

  const png = await encodePng(pixels, width, height);
  assert.ok(png.length > 8, 'PNG should have content');
  assert.ok(png.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])), 'PNG signature');

  const decoded = await decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.ok(decoded.pixels.equals(pixels), 'Decoded pixels should match original');
});

test('PNG stitch combines two frames vertically with crop', async () => {
  const { _encodePng: encodePng, _decodePng: decodePng, _stitchPngFrames: stitchPngFrames } =
    await import('../src/capture-scroll.js');

  const width = 2;
  const h1 = 4;
  const h2 = 4;
  const cropTop = 1;

  // Frame 1: all red
  const px1 = Buffer.alloc(width * h1 * 4);
  for (let i = 0; i < width * h1; i++) {
    px1[i * 4] = 255;
    px1[i * 4 + 3] = 255;
  }
  const png1 = await encodePng(px1, width, h1);

  // Frame 2: all blue
  const px2 = Buffer.alloc(width * h2 * 4);
  for (let i = 0; i < width * h2; i++) {
    px2[i * 4 + 2] = 255;
    px2[i * 4 + 3] = 255;
  }
  const png2 = await encodePng(px2, width, h2);

  const stitched = await stitchPngFrames([
    { bytes: png1, cropTop: 0 },
    { bytes: png2, cropTop: cropTop },
  ]);

  const result = await decodePng(stitched);
  assert.equal(result.width, width);
  assert.equal(result.height, h1 + h2 - cropTop); // 4 + 4 - 1 = 7

  // First h1 rows should be red
  for (let y = 0; y < h1; y++) {
    const off = (y * width) * 4;
    assert.equal(result.pixels[off], 255, `row ${y} should be red`);
    assert.equal(result.pixels[off + 2], 0, `row ${y} should have no blue`);
  }
  // Remaining rows should be blue (cropped first row of frame 2)
  for (let y = h1; y < h1 + h2 - cropTop; y++) {
    const off = (y * width) * 4;
    assert.equal(result.pixels[off], 0, `row ${y} should have no red`);
    assert.equal(result.pixels[off + 2], 255, `row ${y} should be blue`);
  }
});
