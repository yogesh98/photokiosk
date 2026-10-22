import { normalizeModnetPixels, personFromBackground } from "./person-model-processing.mjs";

const MEDIAPIPE_MODELS = {
  selfie: "/models/selfie_segmenter/float16/1/selfie_segmenter.tflite",
  "selfie-multiclass": "/models/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
};
const GENERAL_MODELS = new Set(["birefnet-lite", "birefnet-general", "birefnet-matting"]);
const REFERENCE_MODEL = "background-matting-mobilenet";
const usesNativeForeground = (id) => GENERAL_MODELS.has(id) || id === REFERENCE_MODEL;
const nativeDimensions = (id) => id === REFERENCE_MODEL ? [768, 512] : GENERAL_MODELS.has(id) ? [1024, 1024] : [512, 512];
let model;
let referenceId;
let acceleration;
let runtime;
let segmenter;
let session;
let ort;
let canvas;
let context;
let gpuDevice;
let gpuLost;
let gpuLostReason;
let initialized = false;
let busy = false;

function message(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function bounded(promise, milliseconds, label, disposeLate) {
  let expired = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(`${label} timed out.`));
    }, milliseconds);
  });
  void promise.then((value) => { if (expired) disposeLate?.(value); }, () => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanup() {
  try { segmenter?.close(); } catch { /* Preserve the original error. */ }
  segmenter = undefined;
  if (session) void session.release().catch(() => {});
  session = undefined;
  gpuDevice?.destroy();
  gpuDevice = undefined;
  gpuLost = undefined;
  gpuLostReason = undefined;
}

function validateAlpha(alpha, width, height) {
  if (!(alpha instanceof Float32Array) || alpha.length !== width * height ||
      alpha.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("The portrait model returned an invalid alpha matte.");
  }
  return alpha;
}

async function nativeRequest(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/api/ai/native", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || "Native GPU acceleration is unavailable.");
    const general = usesNativeForeground(body.model);
    const [width, height] = nativeDimensions(body.model);
    if ((result.provider !== "openvino" && result.provider !== "coreml" && !(general && result.provider === "onnx-cpu")) ||
      typeof result.device !== "string" || !result.device.trim() || result.device.length > 200 ||
      result.width !== width || result.height !== height || result.kind !== "alpha" ||
      (general && result.model !== body.model) ||
      (body.model === REFERENCE_MODEL && result.referenceId !== body.referenceId) ||
      (body.acceleration === "gpu" && result.provider === "onnx-cpu") ||
      (body.acceleration === "cpu" && result.provider !== "onnx-cpu") ||
      (result.fallbackReason !== undefined && (typeof result.fallbackReason !== "string" || result.fallbackReason.length > 1000))) {
      throw new Error("The native GPU service returned an invalid runtime.");
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function nativeRuntime(result) {
  return {
    backend: result.provider === "openvino" ? "openvino-gpu" : result.provider === "onnx-cpu" ? "onnx-cpu" : "coreml",
    label: result.device,
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
  };
}

async function initializeNative() {
  const result = await nativeRequest({ type: "initialize" }, 40_000);
  runtime = nativeRuntime(result);
}

async function initializeGeneral(selectedAcceleration = acceleration) {
  // Full BiRefNet graphs can exceed a browser's Wasm memory limit. Keep the
  // selected model in one local, owned Python process, alongside the booth.
  const result = await nativeRequest({ type: "initialize", model, acceleration: selectedAcceleration,
    ...(model === REFERENCE_MODEL ? { referenceId } : {}) }, 185_000);
  runtime = nativeRuntime(result);
}

async function initializeOnnx(gpu) {
  if (gpu) {
    if (!navigator.gpu) throw new Error("This browser does not expose WebGPU.");
    const adapter = await bounded(navigator.gpu.requestAdapter({ powerPreference: "high-performance" }), 5000, "WebGPU adapter detection");
    if (!adapter || adapter.isFallbackAdapter) throw new Error("A hardware WebGPU adapter is unavailable.");
    gpuDevice = await bounded(adapter.requestDevice(), 5000, "WebGPU device creation", (device) => device.destroy());
    const ownedDevice = gpuDevice;
    gpuLost = ownedDevice.lost.then((info) => {
      const reason = new Error(`WebGPU device was lost: ${info.message || info.reason}.`);
      if (gpuDevice === ownedDevice) gpuLostReason = reason;
      return reason;
    });
  }
  // Keep CPU fallback in its own runtime. A failed WebGPU Wasm initialization
  // poisons that module's singleton and must not poison the CPU backend too.
  ort = await import(gpu ? "/vendor/onnxruntime/ort.webgpu.min.mjs" : "/vendor/onnxruntime/ort.wasm.min.mjs");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = "/vendor/onnxruntime/";
  session = await bounded(ort.InferenceSession.create("/models/modnet/model.onnx", {
    // ORT 1.30's native WebGPU provider defaults to NHWC. Its layout conversion
    // produces incorrect MODNet mattes on tested hardware; retain the model's
    // NCHW layout. Pass the watched device here (env.webgpu.device is not used
    // by this provider), so device-loss recovery watches the inference device.
    executionProviders: gpu ? [{ name: "webgpu", device: gpuDevice, preferredLayout: "NCHW" }, "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
  }), 15_000, gpu ? "WebGPU model loading" : "CPU model loading", (late) => { void late.release().catch(() => {}); });
  if (session.inputNames[0] !== "input" || session.outputNames[0] !== "output") {
    throw new Error("The bundled portrait model has unexpected input or output names.");
  }
  runtime = { backend: gpu ? "onnx-webgpu" : "onnx-wasm", label: gpu ? "WebGPU (GPU + CPU)" : "CPU (WebAssembly)" };
  // Running a real input catches unsupported operators and shader compilation
  // errors before the camera can report readiness.
  await inferOnnx(new Uint8ClampedArray(64 * 64 * 4), 64, 64);
}

async function initializeMediaPipe(gpu) {
  const { FilesetResolver, ImageSegmenter } = await import("/vendor/mediapipe/vision_bundle.mjs");
  const files = await FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm", true);
  segmenter = await bounded(ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: MEDIAPIPE_MODELS[model], delegate: gpu ? "GPU" : "CPU" },
    canvas: new OffscreenCanvas(256, 256),
    runningMode: "IMAGE", outputCategoryMask: false, outputConfidenceMasks: true,
  }), 15_000, gpu ? "GPU model loading" : "CPU model loading", (late) => late.close());
  runtime = { backend: gpu ? "mediapipe-gpu" : "mediapipe-cpu", label: gpu ? "GPU (MediaPipe / WebGL)" : "CPU (MediaPipe)" };
  inferPeople(new OffscreenCanvas(256, 256));
}

async function initializeCpu(reason) {
  cleanup();
  if (usesNativeForeground(model)) await initializeGeneral("cpu");
  else if (model === "modnet") await initializeOnnx(false);
  else await initializeMediaPipe(false);
  if (reason) runtime.fallbackReason = reason.slice(0, 1000);
}

async function initialize(modelId, selectedAcceleration, selectedReferenceId) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("Local AI backgrounds need a browser with OffscreenCanvas support. Try current Chrome or Edge.");
  }
  if (!["auto", "cpu", "gpu"].includes(selectedAcceleration)) throw new Error("Choose Auto, CPU, or GPU acceleration.");
  model = modelId;
  acceleration = selectedAcceleration;
  if (model !== "modnet" && !usesNativeForeground(model) && !Object.hasOwn(MEDIAPIPE_MODELS, model)) throw new Error("Unsupported local AI model.");
  if (model === REFERENCE_MODEL && (typeof selectedReferenceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(selectedReferenceId))) {
    throw new Error("Capture an empty background before using the reference model.");
  }
  referenceId = model === REFERENCE_MODEL ? selectedReferenceId : undefined;
  canvas = new OffscreenCanvas(512, 512);
  context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not prepare the local AI canvas.");
  if (usesNativeForeground(model)) {
    await initializeGeneral();
    return;
  }
  if (acceleration === "cpu") {
    await initializeCpu();
    return;
  }
  const errors = [];
  try {
    if (model === "modnet") await initializeOnnx(true);
    else await initializeMediaPipe(true);
    return;
  } catch (error) {
    errors.push(`Browser GPU: ${message(error)}`);
  }
  // Browser WebGPU is fastest on supported Apple Silicon browsers. Native
  // OpenVINO/Core ML remains available when the browser GPU path cannot run.
  cleanup();
  if (model === "modnet") {
    try {
      await initializeNative();
      runtime.fallbackReason = errors.join(" ").slice(0, 1000);
      return;
    } catch (error) { errors.push(`Native GPU: ${message(error)}`); }
  }
  if (acceleration === "gpu") throw new Error(`GPU acceleration is unavailable. ${errors.join(" ")} Choose Auto or CPU, or configure the native GPU runtime.`);
  await initializeCpu(errors.join(" "));
}

async function inferOnnx(rgba, width, height) {
  if (gpuLostReason) throw gpuLostReason;
  const input = new ort.Tensor("float32", normalizeModnetPixels(rgba, width, height), [1, 3, height, width]);
  const currentSession = session;
  // The model owns its tensors until its actual run settles, even if a timeout
  // or lost device lets the caller move on to CPU in the meantime.
  const running = (async () => {
    let outputs;
    try {
      outputs = await currentSession.run({ input });
      const output = outputs.output;
      if (!output || output.type !== "float32" || output.dims.length !== 4 ||
        output.dims[0] !== 1 || output.dims[1] !== 1 || output.dims[2] !== height || output.dims[3] !== width) {
        throw new Error("The portrait model returned an invalid alpha matte.");
      }
      return validateAlpha(new Float32Array(output.data), width, height);
    } finally {
      input.dispose();
      if (outputs) for (const output of Object.values(outputs)) output.dispose();
    }
  })();
  const inference = gpuLost ? Promise.race([running, gpuLost.then((error) => { throw error; })]) : running;
  return bounded(inference, 6000, "AI frame processing");
}

function inferPeople(bitmap) {
  if (!segmenter) throw new Error("The local AI model has not finished loading.");
  let confidence;
  segmenter.segment(bitmap, (result) => {
    const masks = result.confidenceMasks;
    if (model === "selfie-multiclass") {
      if (masks?.length !== 6) throw new Error("The detailed model did not return all six categories.");
      const background = masks[0];
      if (background.width !== bitmap.width || background.height !== bitmap.height) throw new Error("Invalid person mask dimensions.");
      confidence = personFromBackground(background.getAsFloat32Array());
    } else {
      const mask = masks?.length === 1 ? masks[0] : masks?.length === 2 ? masks[1] : undefined;
      if (!mask || mask.width !== bitmap.width || mask.height !== bitmap.height) throw new Error("The local AI model did not return a person mask.");
      confidence = new Float32Array(mask.getAsFloat32Array());
    }
  });
  return validateAlpha(confidence, bitmap.width, bitmap.height);
}

function base64(bytes) {
  let result = "";
  for (let start = 0; start < bytes.length; start += 8192) result += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(result);
}

function decodeAlpha(value, width = 512, height = width) {
  const bytesLength = width * height * 4;
  if (typeof value !== "string" || value.length !== Math.ceil(bytesLength / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("The native GPU service returned an invalid alpha matte.");
  }
  const decoded = atob(value);
  if (decoded.length !== bytesLength) throw new Error("The native AI service returned an invalid alpha matte.");
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const alpha = new Float32Array(width * height);
  for (let index = 0; index < alpha.length; index++) alpha[index] = view.getFloat32(index * 4, true);
  return validateAlpha(alpha, width, height);
}

function resizeAlpha(alpha, width, height) {
  if (width === 512 && height === 512) return alpha;
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(511, (y + 0.5) * 512 / height - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(511, y0 + 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(511, (x + 0.5) * 512 / width - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(511, x0 + 1), fx = sx - x0;
      const top = alpha[y0 * 512 + x0] * (1 - fx) + alpha[y0 * 512 + x1] * fx;
      const bottom = alpha[y1 * 512 + x0] * (1 - fx) + alpha[y1 * 512 + x1] * fx;
      output[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return output;
}

async function infer(bitmap) {
  if (usesNativeForeground(model)) {
    const [width, height] = nativeDimensions(model);
    if (bitmap.width !== width || bitmap.height !== height) throw new Error(`This foreground model requires a ${width} × ${height} frame.`);
    canvas.width = width;
    canvas.height = height;
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const result = await nativeRequest({ type: "segment", model, acceleration,
      width, height, rgba: base64(pixels.data), ...(referenceId ? { referenceId } : {}) }, 95_000);
    const nextRuntime = nativeRuntime(result);
    if (nextRuntime.backend !== runtime.backend || nextRuntime.label !== runtime.label) {
      throw new Error("The native AI runtime changed unexpectedly. Reopen the preview.");
    }
    return decodeAlpha(result.alpha, width, height);
  }
  if (model !== "modnet") return inferPeople(bitmap);
  const { width, height } = bitmap;
  if (width < 32 || height < 32 || width > 512 || height > 512 || width % 32 || height % 32) {
    throw new Error("Invalid portrait model input dimensions.");
  }
  const native = runtime.backend === "openvino-gpu" || runtime.backend === "coreml";
  canvas.width = native ? 512 : width;
  canvas.height = native ? 512 : height;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  if (!native) return inferOnnx(pixels.data, width, height);
  const result = await nativeRequest({ type: "segment", width: 512, height: 512, rgba: base64(pixels.data) }, 7000);
  const nextRuntime = nativeRuntime(result);
  if (nextRuntime.backend !== runtime.backend || nextRuntime.label !== runtime.label) {
    throw new Error("The native GPU runtime changed unexpectedly.");
  }
  return resizeAlpha(decodeAlpha(result.alpha), width, height);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "initialize") {
      if (initialized || busy) throw new Error("The local AI model is already initialized.");
      busy = true;
      await initialize(data.model, data.acceleration, data.referenceId);
      initialized = true;
      busy = false;
      self.postMessage({ type: "ready", runtime, ...(referenceId ? { referenceId } : {}) });
      return;
    }
    if (data.type !== "segment") return;
    if (!initialized || busy) { data.bitmap?.close(); throw new Error("The local AI model is not ready for a new frame."); }
    busy = true;
    try {
      let confidence;
      try { confidence = await infer(data.bitmap); }
      catch (error) {
        const cpu = runtime.backend === "mediapipe-cpu" || runtime.backend === "onnx-wasm" || runtime.backend === "onnx-cpu";
        if (acceleration !== "auto" || cpu) throw error;
        await initializeCpu(`GPU processing stopped: ${message(error)}`);
        confidence = await infer(data.bitmap);
      }
      self.postMessage({ type: "result", id: data.id, width: data.bitmap.width, height: data.bitmap.height,
        confidence: confidence.buffer, kind: model === "modnet" || usesNativeForeground(model) ? "alpha" : "confidence", runtime,
        ...(referenceId ? { referenceId } : {}) }, [confidence.buffer]);
    } finally {
      busy = false;
      data.bitmap.close();
    }
  } catch (error) {
    cleanup();
    self.postMessage({ type: "error", message: message(error) });
  }
};
