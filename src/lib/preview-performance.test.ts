import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreviewPerformanceTracker, previewPerformanceKey } from "./preview-performance";
import type { AiRuntimeInfo } from "./ai-models";

test("excludes warmup and reports processing latency separately from actual preview FPS", () => {
  const record = createPreviewPerformanceTracker("modnet");
  for (let index = 0; index < 3; index++) assert.equal(record(999, index * 1000), null);
  for (let index = 0; index < 4; index++) assert.equal(record(10 + index * 10, 3000 + index * 1000), null);
  const result = record(100, 7000);
  assert.deepEqual(result, {
    model: "modnet", acceleration: "auto", runtime: { backend: "onnx-wasm", label: "CPU · WebAssembly" },
    averageMs: 40, p95Ms: 100, fps: 1, samples: 5,
  });
});

test("keeps a rolling window, so a faster recent workload replaces older timings", () => {
  const record = createPreviewPerformanceTracker("selfie");
  for (let index = 0; index < 33; index++) record(200, index * 100);
  let result;
  for (let index = 33; index < 63; index++) result = record(8, index * 100);
  assert.deepEqual(result, {
    model: "selfie", acceleration: "auto", runtime: { backend: "mediapipe-cpu", label: "CPU · MediaPipe" },
    averageMs: 8, p95Ms: 8, fps: 10, samples: 30,
  });
});

test("a new model warms up independently and invalid timings cannot pollute the result", () => {
  const record = createPreviewPerformanceTracker("selfie-multiclass");
  for (const value of [NaN, Infinity, -1]) assert.equal(record(value, 100), null);
  for (let index = 0; index < 7; index++) assert.equal(record(20, index * 100), null);
  assert.equal(record(20, 600), null);
  assert.equal(record(20, 700)?.samples, 5);
});

test("reports the requested preference and actual runtime, including CPU fallback", () => {
  const runtime: AiRuntimeInfo = {
    backend: "onnx-wasm", label: "CPU · WebAssembly", fallbackReason: "WebGPU is unavailable.",
  };
  const record = createPreviewPerformanceTracker("modnet", "auto", runtime);
  let result;
  for (let index = 0; index < 8; index++) result = record(12, index * 100);
  assert.equal(result?.acceleration, "auto");
  assert.deepEqual(result?.runtime, runtime);
});

test("comparison keys keep requested modes and actual devices separate", () => {
  const cpu = { model: "modnet", acceleration: "cpu", runtime: { backend: "onnx-wasm", label: "CPU · WebAssembly" } } as const;
  const gpu = { ...cpu, acceleration: "gpu", runtime: { backend: "onnx-webgpu", label: "GPU · WebGPU" } } as const;
  const auto = { ...gpu, acceleration: "auto" } as const;
  const fallback = { ...cpu, acceleration: "auto" } as const;
  const native = { ...gpu, runtime: { backend: "coreml", label: "GPU · Apple Core ML" } } as const;
  assert.equal(new Set([cpu, gpu, auto, fallback, native].map(previewPerformanceKey)).size, 5);
});
