import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeModnetPixels, personFromBackground } from "../../public/workers/person-model-processing.mjs";

test("MODNet receives RGB channel planes normalized to [-1, 1] without alpha", () => {
  const rgba = new Uint8ClampedArray([255, 0, 127, 0, 0, 255, 128, 255]);
  const input = normalizeModnetPixels(rgba, 2, 1);
  assert.deepEqual(Array.from(input.slice(0, 4)), [1, -1, -1, 1]);
  assert.ok(Math.abs(input[4] + 1 / 255) < 1e-7);
  assert.ok(Math.abs(input[5] - 1 / 255) < 1e-7);
  assert.throws(() => normalizeModnetPixels(rgba, 3, 1), /Invalid portrait input/);
});

test("multiclass foreground includes every non-background class", () => {
  const background = new Float32Array([1, 0.8, 0.5, 0.2, 0]);
  const person = personFromBackground(background);
  [0, 0.2, 0.5, 0.8, 1].forEach((value, i) => assert.ok(Math.abs(person[i] - value) < 1e-6));
  assert.equal(background[0], 1, "the callback-owned input is never mutated");
});
