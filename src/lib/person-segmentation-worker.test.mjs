import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeModnetPixels, personFromBackground } from "../../public/workers/person-model-processing.mjs";

const workerSource = (await readFile(new URL("../../public/workers/person-segmentation.worker.js", import.meta.url), "utf8"))
  .replace(/^import[^\n]+\n/, "")
  .replaceAll("await import(", "await loadModule(");

function workerHarness(options = {}) {
  const sent = [], delegates = [], providers = [], sessionConfigs = [], requests = [], closed = [], loaded = [];
  let loseGpu;
  const device = { lost: new Promise((resolve) => { loseGpu = resolve; }), destroy() { closed.push("device"); loseGpu({ reason: "destroyed", message: "Intentional teardown" }); } };
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return { drawImage() {}, getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }) };
    }
  }
  const media = {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    ImageSegmenter: { createFromOptions: async (_files, config) => {
      const delegate = config.baseOptions.delegate;
      delegates.push(delegate);
      if (delegate === "GPU" && options.mediaGpuUnavailable) throw new Error("WebGL unavailable");
      let calls = 0;
      return { close() { closed.push(delegate); }, segment(bitmap, callback) {
        calls++;
        if (delegate === "GPU" && options.mediaGpuFrameFails && calls > 1) throw new Error("WebGL context lost");
        const mask = { width: bitmap.width, height: bitmap.height, getAsFloat32Array: () => new Float32Array(bitmap.width * bitmap.height).fill(0.5) };
        callback({ confidenceMasks: config.baseOptions.modelAssetPath.includes("multiclass") ? Array(6).fill(mask) : [mask] });
      } };
    } },
  };
  const ort = {
    env: { wasm: {}, webgpu: {} },
    Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } dispose() {} },
    InferenceSession: { create: async (_model, config) => {
      sessionConfigs.push(config);
      const firstProvider = config.executionProviders[0];
      const provider = typeof firstProvider === "string" ? firstProvider : firstProvider.name;
      providers.push(provider);
      if (provider === "webgpu" && options.onnxGpuUnavailable) throw new Error("Unsupported GPU operator");
      return { inputNames: ["input"], outputNames: ["output"], release: async () => { closed.push(provider); },
        run: async ({ input }) => ({ output: { type: "float32", dims: [1, 1, input.dims[2], input.dims[3]],
          data: new Float32Array(input.dims[2] * input.dims[3]).fill(0.5), dispose() {} } }) };
    } },
  };
  const nativeRuntime = { provider: "coreml", device: "Apple Core ML (GPU + CPU)", width: 512, height: 512, kind: "alpha" };
  const context = vm.createContext({
    normalizeModnetPixels, personFromBackground, OffscreenCanvas: Canvas,
    Uint8ClampedArray, Float32Array, Uint8Array, ArrayBuffer, DataView, Error, Object,
    setTimeout, clearTimeout, AbortController, atob, btoa,
    navigator: options.webgpu ? { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } } : {},
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (!options.native) return { ok: false, json: async () => ({ error: "Native runtime not configured" }) };
      if (body.type === "initialize") return { ok: true, json: async () => options.nativeRuntime || nativeRuntime };
      if (options.nativeFrameFails) return { ok: false, json: async () => ({ error: "Native GPU unavailable" }) };
      const alpha = options.invalidNativeAlpha ? "invalid" : Buffer.from(new Float32Array(512 * 512).fill(0.25).buffer).toString("base64");
      return { ok: true, json: async () => ({ ...nativeRuntime, alpha }) };
    },
    loadModule: async (name) => { loaded.push(name); return name.includes("mediapipe") ? media : ort; },
    self: { postMessage(value) { sent.push(value); } },
  });
  vm.runInContext(workerSource, context);
  return {
    sent, delegates, providers, sessionConfigs, requests, closed, loaded, device,
    loseGpu: () => loseGpu({ reason: "unknown", message: "Test device lost" }),
    initialize: (model = "selfie", acceleration = "auto") => context.self.onmessage({ data: { type: "initialize", model, acceleration } }),
    frame: (width = 256, height = 256) => context.self.onmessage({ data: {
      type: "segment", id: 1, bitmap: { width, height, close() { closed.push("bitmap"); } },
    } }),
  };
}

test("MediaPipe Auto probes GPU and reports the GPU backend", async () => {
  const worker = workerHarness();
  await worker.initialize();
  assert.deepEqual(worker.delegates, ["GPU"]);
  assert.equal(worker.sent[0].type, "ready");
  assert.equal(worker.sent[0].runtime.backend, "mediapipe-gpu");
});

test("MediaPipe Auto falls back to CPU when GPU initialization fails", async () => {
  const worker = workerHarness({ mediaGpuUnavailable: true });
  await worker.initialize();
  assert.deepEqual(worker.delegates, ["GPU", "CPU"]);
  assert.equal(worker.sent[0].runtime.backend, "mediapipe-cpu");
  assert.match(worker.sent[0].runtime.fallbackReason, /WebGL unavailable/);
});

test("explicit GPU reports failure instead of loading a CPU backend", async () => {
  const worker = workerHarness({ mediaGpuUnavailable: true });
  await worker.initialize("selfie", "gpu");
  assert.deepEqual(worker.delegates, ["GPU"]);
  assert.equal(worker.sent[0].type, "error");
  assert.match(worker.sent[0].message, /GPU acceleration is unavailable/);
});

test("Auto retries a failed GPU frame once on CPU and includes the new runtime", async () => {
  const worker = workerHarness({ mediaGpuFrameFails: true });
  await worker.initialize();
  await worker.frame();
  assert.deepEqual(worker.delegates, ["GPU", "CPU"]);
  assert.equal(worker.sent[1].type, "result");
  assert.equal(worker.sent[1].runtime.backend, "mediapipe-cpu");
  assert.match(worker.sent[1].runtime.fallbackReason, /context lost/);
  assert.ok(worker.closed.includes("GPU"));
  assert.ok(worker.closed.includes("bitmap"));
});

test("CPU selection avoids both native and browser GPU detection", async () => {
  const worker = workerHarness({ native: true, webgpu: true });
  await worker.initialize("modnet", "cpu");
  assert.deepEqual(worker.requests, []);
  assert.deepEqual(worker.providers, ["wasm"]);
  assert.equal(worker.sent[0].runtime.backend, "onnx-wasm");
});

test("portrait uses native GPU after WebGPU failure and restores rectangular mask dimensions", async () => {
  const worker = workerHarness({ native: true, webgpu: true, onnxGpuUnavailable: true });
  await worker.initialize("modnet");
  await worker.frame(512, 384);
  assert.equal(worker.sent[0].runtime.backend, "coreml");
  assert.deepEqual(worker.providers, ["webgpu"]);
  assert.match(worker.sent[0].runtime.fallbackReason, /Unsupported GPU operator/);
  assert.ok(worker.closed.includes("device"));
  assert.equal(worker.requests[1].width, 512);
  assert.equal(worker.requests[1].height, 512);
  assert.equal(Buffer.from(worker.requests[1].rgba, "base64").length, 512 * 512 * 4);
  const result = worker.sent[1];
  assert.equal(result.kind, "alpha");
  assert.deepEqual([result.width, result.height], [512, 384]);
  assert.equal(new Float32Array(result.confidence).length, 512 * 384);
  assert.ok(new Float32Array(result.confidence).every((value) => value === 0.25));
});

test("portrait prefers WebGPU even when native GPU is available", async () => {
  const worker = workerHarness({ webgpu: true, native: true });
  await worker.initialize("modnet");
  assert.deepEqual(worker.providers, ["webgpu"]);
  assert.equal(worker.sent[0].runtime.backend, "onnx-webgpu");
  assert.equal(worker.sent[0].runtime.label, "WebGPU (GPU + CPU)");
  assert.deepEqual(worker.requests, [], "native runtime is not started when browser GPU works");
});

test("portrait WebGPU preserves the model's NCHW layout and uses the monitored GPU device", async () => {
  const worker = workerHarness({ webgpu: true });
  await worker.initialize("modnet", "gpu");
  assert.equal(worker.sent[0].type, "ready");
  const [gpu, fallback] = worker.sessionConfigs[0].executionProviders;
  assert.equal(gpu.name, "webgpu");
  // The default NHWC optimization produced fragmented but otherwise valid
  // MODNet alpha masks; numeric/range validation alone cannot detect that bug.
  assert.equal(gpu.preferredLayout, "NCHW");
  assert.equal(gpu.device, worker.device, "inference must use the same device whose loss is monitored");
  assert.equal(fallback, "wasm");
});

test("portrait Auto explains CPU fallback when neither native nor WebGPU works", async () => {
  const worker = workerHarness({ webgpu: true, onnxGpuUnavailable: true });
  await worker.initialize("modnet");
  assert.deepEqual(worker.providers, ["webgpu", "wasm"]);
  assert.equal(worker.sent[0].runtime.backend, "onnx-wasm");
  assert.match(worker.sent[0].runtime.fallbackReason, /Native runtime not configured/);
  assert.match(worker.sent[0].runtime.fallbackReason, /Unsupported GPU operator/);
  assert.ok(worker.closed.includes("device"));
  assert.deepEqual(worker.loaded, ["/vendor/onnxruntime/ort.webgpu.min.mjs", "/vendor/onnxruntime/ort.wasm.min.mjs"]);
  worker.loseGpu();
  await new Promise((resolve) => setImmediate(resolve));
  await worker.frame(512, 384);
  assert.equal(worker.sent[1].type, "result", "a late loss event from the destroyed GPU must not poison CPU fallback");
});

test("a lost WebGPU device switches Auto to CPU on the next frame", async () => {
  const worker = workerHarness({ webgpu: true });
  await worker.initialize("modnet");
  worker.loseGpu();
  await new Promise((resolve) => setImmediate(resolve));
  await worker.frame(512, 384);
  assert.deepEqual(worker.providers, ["webgpu", "wasm"]);
  assert.equal(worker.sent[1].type, "result");
  assert.equal(worker.sent[1].runtime.backend, "onnx-wasm");
  assert.match(worker.sent[1].runtime.fallbackReason, /device was lost/);
});

test("native malformed alpha fails explicit GPU rather than producing a photo", async () => {
  const worker = workerHarness({ native: true, invalidNativeAlpha: true });
  await worker.initialize("modnet", "gpu");
  await worker.frame(512, 384);
  assert.equal(worker.sent[1].type, "error");
  assert.match(worker.sent[1].message, /invalid alpha matte/);
  assert.deepEqual(worker.providers, []);
});

test("native frame failure retries once on CPU in Auto", async () => {
  const worker = workerHarness({ native: true, nativeFrameFails: true });
  await worker.initialize("modnet");
  await worker.frame(512, 384);
  assert.equal(worker.sent[1].type, "result");
  assert.equal(worker.sent[1].runtime.backend, "onnx-wasm");
  assert.match(worker.sent[1].runtime.fallbackReason, /Native GPU unavailable/);
});

test("an invalid native CPU provider cannot be labeled as GPU", async () => {
  const worker = workerHarness({ native: true, nativeRuntime: { provider: "cpu", device: "CPU", width: 512, height: 512, kind: "alpha" } });
  await worker.initialize("modnet", "gpu");
  assert.equal(worker.sent[0].type, "error");
  assert.match(worker.sent[0].message, /invalid runtime/);
  assert.deepEqual(worker.providers, []);
});


test("explicit portrait GPU tries native after unavailable WebGPU", async () => {
  const worker = workerHarness({ native: true });
  await worker.initialize("modnet", "gpu");
  assert.equal(worker.sent[0].type, "ready");
  assert.equal(worker.sent[0].runtime.backend, "coreml");
  assert.deepEqual(worker.providers, []);
});
