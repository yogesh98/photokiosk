import { isNativeForegroundModel, type AiAcceleration, type AiModelId, type AiRuntimeInfo } from "./ai-models";

export interface PreviewPerformance {
  model: AiModelId;
  acceleration: AiAcceleration;
  runtime: AiRuntimeInfo;
  averageMs: number;
  p95Ms: number;
  fps: number;
  samples: number;
}

/** Keep separate comparisons for requested settings and the device that actually ran. */
export function previewPerformanceKey(value: Pick<PreviewPerformance, "model" | "acceleration" | "runtime">) {
  return JSON.stringify([value.model, value.acceleration, value.runtime.backend, value.runtime.label]);
}

/** Measure completed preview work, separately from the camera/preview rate limit. */
export function createPreviewPerformanceTracker(
  model: AiModelId,
  acceleration: AiAcceleration = "auto",
  runtime: AiRuntimeInfo = {
    backend: isNativeForegroundModel(model) ? "onnx-cpu" : model === "modnet" ? "onnx-wasm" : "mediapipe-cpu",
    label: isNativeForegroundModel(model) ? "CPU · ONNX Runtime" : model === "modnet" ? "CPU · WebAssembly" : "CPU · MediaPipe",
  },
) {
  let warmupFrames = 0;
  const samples: Array<{ milliseconds: number; completedAt: number }> = [];
  return (milliseconds: number, completedAt: number): PreviewPerformance | null => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || !Number.isFinite(completedAt))
      return null;
    // Initialization and the first few inferences are unrepresentative of steady use.
    if (warmupFrames++ < 3) return null;
    if (samples.length && completedAt <= samples[samples.length - 1].completedAt) return null;
    samples.push({ milliseconds, completedAt });
    if (samples.length > 30) samples.shift();
    if (samples.length < 5) return null;
    const sorted = samples.map((sample) => sample.milliseconds).sort((a, b) => a - b);
    return {
      model,
      acceleration,
      runtime,
      averageMs: samples.reduce((total, sample) => total + sample.milliseconds, 0) / samples.length,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      fps: (samples.length - 1) * 1000 / (completedAt - samples[0].completedAt),
      samples: samples.length,
    };
  };
}
