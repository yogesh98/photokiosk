import { AI_MODELS, DEFAULT_AI_MODEL, isAiModelId, isAiAcceleration, isNativeForegroundModel, isBackgroundReferenceModel, type AiAcceleration, type AiModelId, type AiRuntimeInfo } from "./ai-models";
import { isBackgroundReference, isBackgroundReferenceCompatible } from "./background-reference-camera";
import type { BackgroundReference, KioskSettings } from "./kiosk-types";
export type { AiRuntimeInfo } from "./ai-models";

export interface PersonMask {
  width: number;
  height: number;
  confidence: Float32Array;
  /** Alpha mattes already describe opacity and must not be thresholded. */
  kind?: "confidence" | "alpha";
}

export interface PersonSegmenter {
  /** The backend that actually processed the latest frame (including fallback). */
  readonly runtime: AiRuntimeInfo;
  /** Takes a synchronous snapshot; never changes the caller's canvas. */
  segment(source: HTMLCanvasElement, signal?: AbortSignal): Promise<PersonMask>;
  close(): void;
}

// Include the bounded browser GPU -> native -> CPU attempts, and give an Auto
// frame enough time to initialize CPU once after a device failure.
const STARTUP_TIMEOUT_MS = 110_000;
const FRAME_TIMEOUT_MS = 45_000;

function abortError() {
  return new DOMException("Background processing was cancelled.", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

interface Inference {
  id: number;
  width: number;
  height: number;
  resolve: (mask: PersonMask) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  drained: Promise<void>;
  drain: () => void;
}

/** All model, JavaScript, and Wasm assets are served by this app. */
export async function createPersonSegmenter(
  model: AiModelId = DEFAULT_AI_MODEL,
  signal?: AbortSignal,
  acceleration: AiAcceleration = "auto",
  options?: { reference?: BackgroundReference | null; camera?: KioskSettings["camera"] },
): Promise<PersonSegmenter> {
  if (signal?.aborted) throw abortError();
  if (!isAiModelId(model)) throw new Error("Choose a supported local AI background model.");
  if (!isAiAcceleration(acceleration)) throw new Error("Choose Auto, CPU, or GPU acceleration.");
  const referenceModel = isBackgroundReferenceModel(model);
  if (referenceModel && (!isBackgroundReference(options?.reference) || !options?.camera ||
    !isBackgroundReferenceCompatible(options.reference, options.camera))) {
    throw new Error("Capture an empty background with the current camera settings before using the reference model.");
  }
  const referenceId = referenceModel ? options!.reference!.id : undefined;
  if (typeof Worker === "undefined" || typeof createImageBitmap === "undefined") {
    throw new Error("Local AI backgrounds need a current Chrome or Edge browser with web worker support.");
  }

  const selectedModel = AI_MODELS.find((item) => item.id === model)!;
  const inputSize = selectedModel.inputSize;
  const inputHeight = selectedModel.inputHeight ?? inputSize;
  const general = isNativeForegroundModel(model);
  const kind = model === "modnet" || general ? "alpha" : "confidence";
  // Native module workers load the selected runtime from public/vendor. Keeping
  // them outside the app bundle preserves their dynamic Wasm imports.
  const worker = new Worker("/workers/person-segmentation.worker.js", { type: "module" });
  let stopped: Error | null = null;
  let active: Inference | null = null;
  let nextId = 0;
  let runtime!: AiRuntimeInfo;
  function readRuntime(value: unknown): AiRuntimeInfo | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as AiRuntimeInfo;
    const backends = general
      ? ["onnx-cpu", "openvino-gpu", "coreml"]
      : model === "modnet"
      ? ["onnx-wasm", "onnx-webgpu", "openvino-gpu", "coreml"]
      : ["mediapipe-cpu", "mediapipe-gpu"];
    if (!backends.includes(candidate.backend) || typeof candidate.label !== "string" || !candidate.label.trim() ||
      candidate.label.length > 200 || (candidate.fallbackReason !== undefined &&
        (typeof candidate.fallbackReason !== "string" || candidate.fallbackReason.length > 1000))) return null;
    const cpu = candidate.backend === "onnx-wasm" || candidate.backend === "mediapipe-cpu" || candidate.backend === "onnx-cpu";
    if ((acceleration === "gpu" && cpu) || (acceleration === "cpu" && !cpu)) return null;
    return { backend: candidate.backend, label: candidate.label, ...(candidate.fallbackReason ? { fallbackReason: candidate.fallbackReason } : {}) };
  }
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function drain(request: Inference) {
    clearTimeout(request.timer);
    if (active === request) active = null;
    request.drain();
  }

  function stop(error: Error) {
    if (stopped) return;
    stopped = error;
    clearTimeout(startupTimer);
    worker.terminate();
    readyReject(error);
    if (active) {
      const request = active;
      request.reject(error);
      drain(request);
    }
  }

  const startupTimer = setTimeout(() => {
    stop(new Error("The local AI model took too long to load. Retry AI or switch to green screen."));
  }, general ? 200_000 : STARTUP_TIMEOUT_MS);

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data;
    if (stopped) return;
    if (message?.type === "ready") {
      const nextRuntime = readRuntime(message.runtime);
      if (!nextRuntime || (referenceModel && message.referenceId !== referenceId)) {
        stop(new Error("The local AI model reported an invalid acceleration backend."));
        return;
      }
      runtime = nextRuntime;
      clearTimeout(startupTimer);
      readyResolve();
      return;
    }
    if (message?.type === "error") {
      stop(new Error(message.message || "Local AI background processing failed."));
      return;
    }
    if (message?.type !== "result" || !active || message.id !== active.id) return;
    const request = active;
    const nextRuntime = readRuntime(message.runtime);
    if (!nextRuntime) {
      stop(new Error("The local AI model reported an invalid acceleration backend."));
      return;
    }
    if (
      message.width !== request.width || message.height !== request.height ||
      (referenceModel && message.referenceId !== referenceId) ||
      message.kind !== kind ||
      !(message.confidence instanceof ArrayBuffer) ||
      message.confidence.byteLength !== request.width * request.height * Float32Array.BYTES_PER_ELEMENT
    ) {
      stop(new Error("The local AI model returned an invalid person mask."));
      return;
    }
    const confidence = new Float32Array(message.confidence);
    if (confidence.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
      stop(new Error("The local AI model returned an invalid person mask."));
      return;
    }
    drain(request);
    runtime = nextRuntime;
    request.resolve({
      width: message.width,
      height: message.height,
      confidence,
      kind,
    });
  };
  worker.onerror = () => stop(new Error("Local AI background processing stopped. Retry AI or switch to green screen."));
  worker.onmessageerror = () => stop(new Error("Could not read the local AI person mask. Retry AI."));

  const initialization = abortable(ready, signal);
  try {
    worker.postMessage({ type: "initialize", model, acceleration, ...(referenceId ? { referenceId } : {}) });
  } catch (error) {
    stop(error instanceof Error ? error : new Error("Could not start the local AI model."));
  }
  try {
    await initialization;
  } catch (error) {
    stop(error instanceof Error ? error : new Error("Could not start the local AI model."));
    throw error;
  }

  return {
    get runtime() { return { ...runtime }; },
    async segment(source, frameSignal) {
      if (stopped) throw stopped;
      if (frameSignal?.aborted) throw abortError();

      // Capture before any await, including waiting for an aborted frame to drain.
      // MODNet accepts dynamic shapes divisible by 32. Bound its longest edge
      // to 512 for mini PCs while preserving the camera aspect ratio closely.
      // Each mask maps back to the same complete camera frame, without a crop.
      if (source.width <= 0 || source.height <= 0) throw new Error("The camera photo is empty.");
      const scale = inputSize / Math.max(source.width, source.height);
      const snapshot = document.createElement("canvas");
      snapshot.width = model === "modnet" ? Math.max(32, Math.round(source.width * scale / 32) * 32) : inputSize;
      snapshot.height = model === "modnet" ? Math.max(32, Math.round(source.height * scale / 32) * 32) : inputHeight;
      const context = snapshot.getContext("2d");
      if (!context) throw new Error("Could not prepare the photo for local AI processing.");
      context.drawImage(source, 0, 0, snapshot.width, snapshot.height);

      // Cancelled callers return immediately, but synchronous worker inference
      // must drain before another frame is posted. No simultaneous model calls.
      while (active) await abortable(active.drained, frameSignal);
      if (stopped) throw stopped;
      if (frameSignal?.aborted) throw abortError();

      let request!: Inference;
      const result = new Promise<PersonMask>((resolve, reject) => {
        let drainResolve!: () => void;
        const drained = new Promise<void>((done) => { drainResolve = done; });
        request = {
          id: ++nextId,
          width: snapshot.width,
          height: snapshot.height,
          resolve,
          reject,
          drained,
          drain: drainResolve,
          timer: setTimeout(() => {
            stop(new Error("Local AI processing took too long. Retry AI or switch to green screen."));
          }, general ? 100_000 : FRAME_TIMEOUT_MS),
        };
        active = request;
      });

      void Promise.resolve().then(() => createImageBitmap(snapshot)).then((bitmap) => {
        if (stopped || active !== request) {
          bitmap.close();
          return;
        }
        if (frameSignal?.aborted) {
          bitmap.close();
          drain(request);
          request.reject(abortError());
          return;
        }
        try {
          worker.postMessage({ type: "segment", id: request.id, bitmap }, [bitmap]);
        } catch (error) {
          bitmap.close();
          stop(error instanceof Error ? error : new Error("Could not send the photo to local AI."));
        }
      }).catch((error) => {
        if (active !== request) return;
        drain(request);
        request.reject(error instanceof Error ? error : new Error("Could not read the photo for local AI."));
      });
      return abortable(result, frameSignal);
    },
    close() {
      stop(new Error("Local AI background processing has closed."));
    },
  };
}
