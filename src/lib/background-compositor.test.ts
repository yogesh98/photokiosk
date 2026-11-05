import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackgroundCompositor } from "./background-compositor";
import { DEFAULT_SETTINGS } from "./kiosk-types";

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

test("green screen keys the mirrored 3:2 crop and draws it over the backdrop", async () => {
  const fixture = canvasFixture();
  try {
    const composite = createBackgroundCompositor();
    const output = fixture.makeCanvas();
    const source = { frame: 1 } as unknown as CanvasImageSource;
    const backdrop = { naturalWidth: 3000, naturalHeight: 2000 } as HTMLImageElement;
    await composite({
      source, sourceWidth: 1920, sourceHeight: 1080, width: 2400, output,
      settings: { ...DEFAULT_SETTINGS, backgroundMode: "green-screen" }, background: backdrop,
      signal: new AbortController().signal,
    });
    assert.deepEqual(fixture.operations.find((item) => item.action === "scale")?.args, [-1, 1]);
    const crop = fixture.operations.find((item) => item.action === "drawImage");
    assert.equal(crop?.args[0], source);
    assert.equal(crop?.args[2], 0);
    assert.ok(Number(crop?.args[1]) < 0, "wide camera is cropped horizontally to 3:2");
    const keyed = fixture.operations.find((item) => item.action === "putImageData");
    assert.equal(keyed?.canvas, 0);
    assert.equal((keyed?.args[0] as ImageData).data[3], 0, "pure green becomes transparent");
    assert.equal(output.width, 2400);
    assert.equal(output.height, 1600);
    const draws = fixture.operations.filter((item) => item.action === "drawImage");
    assert.deepEqual(draws.map((item) => item.canvas), [0, 1, 1]);
    assert.equal(draws[1].args[0], backdrop, "the backdrop is drawn before the keyed foreground");
  } finally { fixture.restore(); }
});

test("a cancelled frame never publishes a partially processed photo", async () => {
  const fixture = canvasFixture();
  try {
    const composite = createBackgroundCompositor();
    const output = fixture.makeCanvas();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(composite({
      source: {} as CanvasImageSource, sourceWidth: 600, sourceHeight: 400, width: 600, output,
      settings: { ...DEFAULT_SETTINGS, backgroundMode: "green-screen" }, background: null, signal: controller.signal,
    }), { name: "AbortError" });
    assert.equal(output.width, 0);
    assert.ok(!fixture.operations.some((item) => item.canvas === 1));
  } finally { fixture.restore(); }
});

test("Off keeps the original image and never keys or draws the replacement background", async () => {
  const fixture = canvasFixture();
  try {
    const composite = createBackgroundCompositor();
    const output = fixture.makeCanvas();
    const backdrop = {} as HTMLImageElement;
    await composite({
      source: {} as CanvasImageSource, sourceWidth: 600, sourceHeight: 400, width: 600, output,
      settings: { ...DEFAULT_SETTINGS, backgroundMode: "off" }, background: backdrop,
      signal: new AbortController().signal,
    });
    assert.ok(!fixture.operations.some((item) => item.action === "putImageData" || item.args[0] === backdrop));
    assert.equal(output.width, 600);
  } finally { fixture.restore(); }
});
