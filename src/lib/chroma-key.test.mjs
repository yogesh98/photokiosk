import test from "node:test";
import assert from "node:assert/strict";
import { applyChromaKey, drawCover } from "./chroma-key.ts";

const settings = {
  enabled: true,
  similarity: 0.36,
  smoothness: 0.12,
  spill: 0.35,
};

test("removes lit and shadowed green screen while retaining skin and neutral colors", () => {
  const pixels = new Uint8ClampedArray([
    0, 255, 0, 255, 25, 125, 20, 255, 190, 140, 105, 255, 240, 240, 240, 255,
    25, 30, 190, 255,
  ]);
  applyChromaKey(pixels, settings);
  assert.equal(pixels[3], 0);
  assert.equal(pixels[7], 0);
  assert.deepEqual(
    Array.from(pixels.slice(8)),
    [190, 140, 105, 255, 240, 240, 240, 255, 25, 30, 190, 255],
  );
});

test("soft edge yields partial alpha and spill correction", () => {
  const pixels = new Uint8ClampedArray([105, 165, 100, 255]);
  applyChromaKey(pixels, settings);
  assert.ok(pixels[3] > 0 && pixels[3] < 255);
  assert.ok(pixels[1] < 165);
});

test("disabled keying preserves all pixels and original alpha", () => {
  const pixels = new Uint8ClampedArray([0, 255, 0, 100]);
  applyChromaKey(pixels, { ...settings, enabled: false });
  assert.deepEqual(Array.from(pixels), [0, 255, 0, 100]);
});

test("preview and final photos retain the same centered crop for wide and tall inputs", () => {
  for (const [sourceWidth, sourceHeight] of [
    [1920, 1080],
    [1600, 1200],
    [1000, 1600],
  ]) {
    const crops = [];
    const source = {};
    for (const width of [960, 2400]) {
      const height = (width * 2) / 3;
      const context = {
        drawImage: (image, x, y, w, h) => {
          assert.equal(image, source);
          assert.ok(w >= width && h >= height);
          assert.ok(Math.abs(x * 2 + w - width) < 1e-8);
          assert.ok(Math.abs(y * 2 + h - height) < 1e-8);
          crops.push([x / width, y / height, w / width, h / height]);
        },
      };
      drawCover(context, source, sourceWidth, sourceHeight, width, height);
    }
    crops[0].forEach((value, index) =>
      assert.ok(Math.abs(value - crops[1][index]) < 1e-8),
    );
  }
});
