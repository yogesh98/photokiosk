import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createPersonSegmenter } from "./person-segmentation";
import { AI_MODELS, isAiModelId, type AiModelId, type AiAcceleration, type AiRuntimeInfo } from "./ai-models";

class FakeCanvas {
  width = 640;
  height = 480;
  frame = 1;
  getContext() {
    return { drawImage: (source: FakeCanvas) => { this.frame = source.frame; } };
  }
}

class FakeBitmap {
  closed = false;
  constructor(readonly frame: number, readonly width = 256, readonly height = 256) {}
  close() { this.closed = true; }
}

class FakeWorker {
  static latest: FakeWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminated = false;
  messages: { type: string; id?: number; bitmap?: FakeBitmap; model?: AiModelId; acceleration?: AiAcceleration }[] = [];
  constructor(readonly url: string, readonly options: WorkerOptions) { FakeWorker.latest = this; }
  postMessage(message: { type: string; id?: number; bitmap?: FakeBitmap; model?: AiModelId; acceleration?: AiAcceleration }) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data }); }
  runtime(): AiRuntimeInfo {
    return this.messages[0]?.model === "modnet"
      ? { backend: "onnx-wasm", label: "CPU (WebAssembly)" }
      : { backend: "mediapipe-cpu", label: "CPU (MediaPipe)" };
  }
  result(id: number, confidence = 0.75, width = 256, height = 256, kind = "confidence") {
    this.emit({
      type: "result", id, width, height, kind, runtime: this.runtime(),
      confidence: new Float32Array(width * height).fill(confidence).buffer,
    });
  }
}

function setup(t: TestContext) {
  const replacements = {
    Worker: FakeWorker,
    document: { createElement: () => new FakeCanvas() },
    createImageBitmap: async (source: FakeCanvas) => new FakeBitmap(source.frame, source.width, source.height),
  };
  for (const [key, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return async (model: AiModelId = "selfie") => {
    const initializing = createPersonSegmenter(model);
    const worker = FakeWorker.latest;
    worker.emit({ type: "ready", runtime: worker.runtime() });
    const segmenter = await initializing;
    t.after(() => segmenter.close());
    return { worker, segmenter };
  };
}

function canvas() { return new FakeCanvas() as unknown as HTMLCanvasElement; }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("segments a frozen canvas and returns the transferred person confidence", async (t) => {
  const { worker, segmenter } = await setup(t)();
  assert.equal(worker.url, "/workers/person-segmentation.worker.js");
  assert.equal(worker.options.type, "module");
  const source = canvas();
  const result = segmenter.segment(source);
  (source as unknown as FakeCanvas).frame = 9;
  await flush();
  assert.equal(worker.messages[1].bitmap?.frame, 1, "snapshot predates asynchronous bitmap creation");
  worker.result(1);
  const mask = await result;
  assert.deepEqual([mask.width, mask.height, mask.confidence.length], [256, 256, 65536]);
  assert.equal(mask.confidence[0], 0.75);
  assert.equal((source as unknown as FakeCanvas).frame, 9, "the input was not mutated");
});

test("aborted inference rejects promptly; the next frozen frame waits until the worker drains", async (t) => {
  const { worker, segmenter } = await setup(t)();
  const controller = new AbortController();
  const first = segmenter.segment(canvas(), controller.signal);
  await flush();
  const aborted = assert.rejects(first, { name: "AbortError" });
  controller.abort();
  await aborted;
  const secondSource = canvas();
  (secondSource as unknown as FakeCanvas).frame = 2;
  const second = segmenter.segment(secondSource);
  (secondSource as unknown as FakeCanvas).frame = 3;
  await flush();
  assert.equal(worker.messages.length, 2, "no simultaneous inference");
  worker.result(1);
  await flush();
  assert.equal(worker.messages[2].bitmap?.frame, 2, "queued source was frozen before waiting");
  worker.result(2, 0.5);
  assert.equal((await second).confidence[0], 0.5);
  assert.equal(worker.terminated, false);
});

test("cancelling a waiting frame does not send it to the worker", async (t) => {
  const { worker, segmenter } = await setup(t)();
  const first = segmenter.segment(canvas());
  const controller = new AbortController();
  const second = segmenter.segment(canvas(), controller.signal);
  const aborted = assert.rejects(second, { name: "AbortError" });
  controller.abort();
  await aborted;
  await flush();
  worker.result(1);
  await first;
  await flush();
  assert.equal(worker.messages.length, 2);
});

test("closing while a bitmap is pending rejects promptly and disposes its late result", async (t) => {
  const { worker, segmenter } = await setup(t)();
  let deliver!: (value: ImageBitmap) => void;
  globalThis.createImageBitmap = (() => new Promise<ImageBitmap>((resolve) => { deliver = resolve; })) as typeof createImageBitmap;
  const result = segmenter.segment(canvas());
  await flush();
  const rejected = assert.rejects(result, /has closed/);
  segmenter.close();
  await rejected;
  const bitmap = new FakeBitmap(1);
  deliver(bitmap as unknown as ImageBitmap);
  await flush();
  assert.equal(bitmap.closed, true);
  assert.equal(worker.terminated, true);
  assert.equal(worker.messages.length, 1);
  await assert.rejects(segmenter.segment(canvas()), /has closed/);
});

test("a worker crash rejects active and waiting calls without leaving a busy runtime", async (t) => {
  const { worker, segmenter } = await setup(t)();
  const active = assert.rejects(segmenter.segment(canvas()), /processing stopped/);
  const waiting = assert.rejects(segmenter.segment(canvas()), /processing stopped/);
  worker.onerror?.();
  await Promise.all([active, waiting]);
  assert.equal(worker.terminated, true);
});

test("initialization cancellation terminates the worker", async (t) => {
  setup(t);
  const controller = new AbortController();
  const initializing = assert.rejects(createPersonSegmenter("selfie", controller.signal), { name: "AbortError" });
  controller.abort();
  await initializing;
  assert.equal(FakeWorker.latest.terminated, true);
});

test("a model load timeout rejects and terminates the worker", async (t) => {
  setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const initializing = assert.rejects(createPersonSegmenter(), /too long to load/);
  t.mock.timers.tick(110_000);
  await initializing;
  assert.equal(FakeWorker.latest.terminated, true);
});

test("a stalled frame times out and releases waiting calls", async (t) => {
  const { worker, segmenter } = await setup(t)();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const active = assert.rejects(segmenter.segment(canvas()), /processing took too long/);
  const waiting = assert.rejects(segmenter.segment(canvas()), /processing took too long/);
  t.mock.timers.tick(45_000);
  await Promise.all([active, waiting]);
  assert.equal(worker.terminated, true);
});

test("invalid confidence masks fail instead of compositing corrupt data", async (t) => {
  const { worker, segmenter } = await setup(t)();
  const result = assert.rejects(segmenter.segment(canvas()), /invalid person mask/);
  worker.emit({ type: "result", id: 1, width: 256, height: 256, runtime: worker.runtime(), confidence: new ArrayBuffer(4) });
  await result;
  assert.equal(worker.terminated, true);
});

test("each supported model is selected explicitly during initialization", async (t) => {
  const start = setup(t);
  for (const model of AI_MODELS) {
    const { worker, segmenter } = await start(model.id);
    assert.deepEqual(worker.messages[0], { type: "initialize", model: model.id, acceleration: "auto" });
    segmenter.close();
  }
  assert.equal(isAiModelId("unknown"), false);
  assert.equal(isAiModelId(null), false);
  await assert.rejects(createPersonSegmenter("unknown" as AiModelId), /supported local AI/);
});

test("portrait inference preserves camera aspect ratio and returns soft alpha", async (t) => {
  const { worker, segmenter } = await setup(t)("modnet");
  const source = canvas();
  const result = segmenter.segment(source);
  await flush();
  const bitmap = worker.messages[1].bitmap!;
  assert.deepEqual([bitmap.width, bitmap.height], [512, 384]);
  worker.result(1, 0.125, 512, 384, "alpha");
  const mask = await result;
  assert.equal(mask.kind, "alpha");
  assert.equal(mask.confidence[0], 0.125);
  assert.deepEqual([mask.width, mask.height], [512, 384]);
});

test("portrait inference validates the dimensions expected for each frame", async (t) => {
  const { worker, segmenter } = await setup(t)("modnet");
  const source = canvas();
  source.width = 1080;
  source.height = 1920;
  const result = assert.rejects(segmenter.segment(source), /invalid person mask/);
  await flush();
  const bitmap = worker.messages[1].bitmap!;
  assert.deepEqual([bitmap.width, bitmap.height], [288, 512]);
  worker.result(1, 0.5, 512, 512, "alpha");
  await result;
});

test("confidence and alpha masks cannot be confused across model switches", async (t) => {
  const { worker, segmenter } = await setup(t)("selfie-multiclass");
  const result = assert.rejects(segmenter.segment(canvas()), /invalid person mask/);
  worker.result(1, 0.5, 256, 256, "alpha");
  await result;
});

test("non-finite mask data rejects instead of contaminating the final photo", async (t) => {
  const { worker, segmenter } = await setup(t)();
  const result = assert.rejects(segmenter.segment(canvas()), /invalid person mask/);
  worker.result(1, Number.NaN);
  await result;
});

test("a worker error during initialization rejects and releases its startup timer", async (t) => {
  setup(t);
  const result = assert.rejects(createPersonSegmenter("modnet"), /Failed model download/);
  FakeWorker.latest.emit({ type: "error", message: "Failed model download" });
  await result;
  assert.equal(FakeWorker.latest.terminated, true);
});

test("a synchronous initialization send failure rejects without an unhandled promise", async (t) => {
  setup(t);
  t.mock.method(FakeWorker.prototype, "postMessage", () => { throw new Error("Cannot start worker"); });
  await assert.rejects(createPersonSegmenter("modnet"), /Cannot start worker/);
  assert.equal(FakeWorker.latest.terminated, true);
  await flush();
});

test("a pre-aborted initialization does not construct a worker", async (t) => {
  setup(t);
  const previous = FakeWorker.latest;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createPersonSegmenter("modnet", controller.signal), { name: "AbortError" });
  assert.equal(FakeWorker.latest, previous);
});


test("the selected acceleration reaches the worker and readiness requires a matching backend", async (t) => {
  setup(t);
  const initializing = createPersonSegmenter("modnet", undefined, "gpu");
  const worker = FakeWorker.latest;
  assert.deepEqual(worker.messages[0], { type: "initialize", model: "modnet", acceleration: "gpu" });
  worker.emit({ type: "ready", runtime: { backend: "coreml", label: "Apple Core ML (GPU + CPU)" } });
  const segmenter = await initializing;
  assert.equal(segmenter.runtime.backend, "coreml");
  segmenter.close();
});

test("explicit GPU selection rejects silently substituted CPU readiness", async (t) => {
  setup(t);
  const initializing = assert.rejects(createPersonSegmenter("selfie", undefined, "gpu"), /invalid acceleration backend/);
  FakeWorker.latest.emit({ type: "ready", runtime: { backend: "mediapipe-cpu", label: "CPU" } });
  await initializing;
  assert.equal(FakeWorker.latest.terminated, true);
});

test("Auto runtime reports the actual backend after a frame fallback", async (t) => {
  setup(t);
  const initializing = createPersonSegmenter("selfie");
  const worker = FakeWorker.latest;
  worker.emit({ type: "ready", runtime: { backend: "mediapipe-gpu", label: "GPU" } });
  const segmenter = await initializing;
  t.after(() => segmenter.close());
  assert.equal(segmenter.runtime.backend, "mediapipe-gpu");
  const result = segmenter.segment(canvas());
  worker.emit({ type: "result", id: 1, width: 256, height: 256, kind: "confidence",
    confidence: new Float32Array(256 * 256).fill(0.5).buffer,
    runtime: { backend: "mediapipe-cpu", label: "CPU", fallbackReason: "GPU device lost" } });
  await result;
  assert.equal(segmenter.runtime.backend, "mediapipe-cpu");
  assert.equal(segmenter.runtime.fallbackReason, "GPU device lost");
  const copy = segmenter.runtime;
  copy.label = "mutated";
  assert.equal(segmenter.runtime.label, "CPU");
});

test("runtime reports cannot cross model families or omit their label", async (t) => {
  setup(t);
  for (const runtime of [{ backend: "coreml", label: "Apple GPU" }, { backend: "mediapipe-cpu" }]) {
    const initializing = assert.rejects(createPersonSegmenter("selfie"), /invalid acceleration backend/);
    FakeWorker.latest.emit({ type: "ready", runtime });
    await initializing;
  }
  await assert.rejects(createPersonSegmenter("selfie", undefined, "unknown" as AiAcceleration), /Auto, CPU, or GPU/);
});
