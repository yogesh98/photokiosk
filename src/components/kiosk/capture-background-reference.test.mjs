import test from "node:test";
import assert from "node:assert/strict";
import { captureBackgroundReference } from "./capture-background-reference.ts";

test("reference capture freezes the raw frame with the photo crop and mirror before PNG encoding", async (t) => {
  const operations = [];
  let encode;
  const reference = new Blob(["reference"], { type: "image/png" });
  const context = Object.fromEntries(["save", "translate", "scale", "drawImage", "restore"]
    .map((name) => [name, (...args) => operations.push([name, ...args])]));
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    toBlob: (callback, type) => {
      operations.push(["encode", type]);
      encode = () => callback(reference);
    },
  };
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => { assert.equal(tag, "canvas"); return canvas; } };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const source = { cameraFrame: true };
  const capture = captureBackgroundReference(source, 1920, 1080, true);
  assert.equal(canvas.width, 768);
  assert.equal(canvas.height, 512);
  assert.deepEqual(operations.slice(0, 3), [["save"], ["translate", 768, 0], ["scale", -1, 1]]);
  const [draw, frame, ...coordinates] = operations[3];
  assert.equal(draw, "drawImage");
  assert.equal(frame, source);
  [-71.111111, 0, 910.222222, 512].forEach((expected, index) => {
    assert.ok(Math.abs(coordinates[index] - expected) < 0.000001);
  });
  assert.deepEqual(operations.slice(4), [["restore"], ["encode", "image/png"]]);
  encode();
  assert.equal(await capture, reference);
});

test("reference capture rejects missing camera frames and PNG encoding failures", async (t) => {
  assert.throws(() => captureBackgroundReference({}, 0, 1080, false), /camera frame/);
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({
    getContext: () => ({ save() {}, drawImage() {}, restore() {} }),
    toBlob: (callback) => callback(null),
  }) };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  await assert.rejects(captureBackgroundReference({}, 768, 512, false), /could not encode/);
});
