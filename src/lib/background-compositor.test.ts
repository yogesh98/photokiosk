import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackgroundCompositor, personMaskPixels } from "./background-compositor";
import { DEFAULT_SETTINGS } from "./kiosk-types";

test("person confidence preserves foreground, removes background and softens uncertain edges", () => {
  const pixels = personMaskPixels(new Float32Array([0, 0.1, 0.5, 0.9, 1, NaN, -2, 2]));
  assert.deepEqual(Array.from(pixels).filter((_, index) => index % 4 === 3), [0, 0, 128, 255, 255, 0, 0, 255]);
});

test("portrait matting preserves continuous alpha for hair instead of thresholding it", () => {
  const pixels = personMaskPixels(new Float32Array([0, 0.2, 0.5, 0.8, 1]), "alpha");
  assert.deepEqual(Array.from(pixels).filter((_, index) => index % 4 === 3), [0, 51, 128, 204, 255]);
});

function canvasFixture() {
  const operations: Array<{ canvas: number; action: string; args: unknown[] }> = [];
  let nextId = 0;
  const makeCanvas = () => {
    const id = nextId++;
    const context: Record<string, unknown> = {};
    for (const action of ["clearRect", "save", "restore", "translate", "scale", "drawImage", "putImageData", "fillRect"])
      context[action] = (...args: unknown[]) => operations.push({ canvas: id, action, args });
    context.createImageData = (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) });
    context.getImageData = () => ({ data: new Uint8ClampedArray([0, 255, 0, 255]) });
    return { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: makeCanvas } });
  return {
    operations, makeCanvas,
    restore() {
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

test("AI freezes the mirrored crop before inference and publishes only the completed frame", async () => {
  const fixture = canvasFixture();
  try {
    const composite = createBackgroundCompositor();
    const output = fixture.makeCanvas();
    const source = { frame: 1 } as unknown as CanvasImageSource;
    let finish!: (mask: { width: number; height: number; confidence: Float32Array }) => void;
    const mask = new Promise<{ width: number; height: number; confidence: Float32Array }>((resolve) => { finish = resolve; });
    const flight = composite({
      source, sourceWidth: 1920, sourceHeight: 1080, width: 2400, output,
      settings: { ...DEFAULT_SETTINGS, backgroundMode: "ai" }, background: null,
      signal: new AbortController().signal,
      segmenter: { runtime: { backend: "mediapipe-cpu", label: "CPU" }, close() {}, segment: async (snapshot) => { assert.notEqual(snapshot, source); return mask; } },
    });
    assert.deepEqual(fixture.operations.find((item) => item.action === "scale")?.args, [-1, 1]);
    const crop = fixture.operations.find((item) => item.action === "drawImage");
    assert.equal(crop?.args[0], source);
    assert.equal(crop?.args[2], 0);
    assert.ok(Number(crop?.args[1]) < 0, "wide camera is cropped horizontally to 3:2");
    assert.equal(output.width, 0, "output stays untouched during inference");
    finish({ width: 2, height: 1, confidence: new Float32Array([0, 1]) });
    await flight;
    assert.equal(output.width, 2400);
    assert.equal(output.height, 1600);
    assert.deepEqual(fixture.operations.filter((item) => item.action === "drawImage").map((item) => item.canvas), [0, 0, 2]);
  } finally { fixture.restore(); }
});

test("cancelling inference never publishes a partially processed photo", async () => {
  const fixture = canvasFixture();
  try {
    const composite = createBackgroundCompositor();
    const output = fixture.makeCanvas();
    const controller = new AbortController();
    await assert.rejects(composite({
      source: {} as CanvasImageSource, sourceWidth: 600, sourceHeight: 400, width: 600, output,
      settings: { ...DEFAULT_SETTINGS, backgroundMode: "ai" }, background: null, signal: controller.signal,
      segmenter: { runtime: { backend: "mediapipe-cpu", label: "CPU" }, close() {}, segment: async () => {
        controller.abort();
        return { width: 1, height: 1, confidence: new Float32Array([1]) };
      } },
    }), { name: "AbortError" });
    assert.equal(output.width, 0);
    assert.ok(!fixture.operations.some((item) => item.canvas === 2));
  } finally { fixture.restore(); }
});

test("Off keeps the original image and never invokes AI or draws the replacement background", async () => {
  const fixture = canvasFixture();
  try {
    const composite = createBackgroundCompositor();
    const output = fixture.makeCanvas();
    const backdrop = {} as HTMLImageElement;
    await composite({
      source: {} as CanvasImageSource, sourceWidth: 600, sourceHeight: 400, width: 600, output,
      settings: { ...DEFAULT_SETTINGS, backgroundMode: "off" }, background: backdrop,
      signal: new AbortController().signal,
      segmenter: { runtime: { backend: "mediapipe-cpu", label: "CPU" }, close() {}, segment: async () => { throw new Error("Must not load AI"); } },
    });
    assert.ok(!fixture.operations.some((item) => item.action === "getImageData" || item.args[0] === backdrop));
    assert.equal(output.width, 600);
  } finally { fixture.restore(); }
});
