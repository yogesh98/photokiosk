import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export const NATIVE_AI_SIZE = 512;
export const GENERAL_NATIVE_AI_SIZE = 1024;
export const MAX_NATIVE_REQUEST_BYTES = 5_650_000;
const SETUP_HELP = "Run python3 scripts/native-ai/setup.py on the computer running the booth, or choose a people model that runs in the browser.";

export type NativeAiModel = "modnet" | "birefnet-lite" | "birefnet-general" | "birefnet-matting" | "background-matting-mobilenet";
export type NativeAiAcceleration = "auto" | "cpu" | "gpu";
const MODELS: readonly NativeAiModel[] = ["modnet", "birefnet-lite", "birefnet-general", "birefnet-matting", "background-matting-mobilenet"];
const REFERENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface NativeAiConfiguration { model?: NativeAiModel; acceleration?: NativeAiAcceleration; referenceId?: string }
function configuration(request: NativeAiConfiguration) {
  const model = request.model ?? "modnet";
  const acceleration = request.acceleration ?? (request.model ? "auto" : "gpu");
  const reference = model === "background-matting-mobilenet";
  const width = reference ? 768 : model === "modnet" ? NATIVE_AI_SIZE : GENERAL_NATIVE_AI_SIZE;
  const height = reference ? 512 : width;
  return { model, acceleration, width, height, referenceId: request.referenceId };
}
function configurationKey(request: NativeAiConfiguration) {
  const { model, acceleration, referenceId } = configuration(request);
  return `${model}:${acceleration}:${referenceId ?? ""}`;
}

export class NativeAiError extends Error {
  constructor(message: string, public readonly code = "native_unavailable", public readonly status = 503) {
    super(message);
    this.name = "NativeAiError";
  }
}

export type NativeAiRequest = ({ type: "initialize" } | {
  type: "segment";
  width: number;
  height: number;
  rgba: string;
}) & NativeAiConfiguration;

export interface NativeAiResult {
  provider: "coreml" | "openvino" | "onnx-cpu";
  model?: NativeAiModel;
  referenceId?: string;
  device: string;
  width: number;
  height: number;
  kind: "alpha";
  alpha?: string;
  fallbackReason?: string;
}

function isFrameBase64(value: unknown, width: number, height: number): value is string {
  const bytes = width * height * 4;
  return typeof value === "string" && value.length === Math.ceil(bytes / 3) * 4 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === bytes;
}

export function validateNativeAiRequest(value: unknown): NativeAiRequest {
  if (!value || typeof value !== "object") throw new NativeAiError("Invalid native inference request.", "native_invalid", 400);
  const request = value as Record<string, unknown>;
  if ((request.model !== undefined && !MODELS.includes(request.model as NativeAiModel)) ||
    (request.acceleration !== undefined && !["auto", "cpu", "gpu"].includes(request.acceleration as string))) {
    throw new NativeAiError("Choose a supported native AI model and acceleration.", "native_invalid", 400);
  }
  const reference = request.model === "background-matting-mobilenet";
  if (reference ? (typeof request.referenceId !== "string" || !REFERENCE_ID.test(request.referenceId)) : request.referenceId !== undefined) {
    throw new NativeAiError("Capture a valid empty background for the reference model.", "native_invalid", 400);
  }
  const selected: NativeAiConfiguration = {
    ...(request.model !== undefined ? { model: request.model as NativeAiModel } : {}),
    ...(request.acceleration !== undefined ? { acceleration: request.acceleration as NativeAiAcceleration } : {}),
    ...(reference ? { referenceId: request.referenceId as string } : {}),
  };
  if (request.type === "initialize") return { type: "initialize", ...selected };
  const { width, height } = configuration(selected);
  if (request.type !== "segment" || request.width !== width || request.height !== height || !isFrameBase64(request.rgba, width, height)) {
    throw new NativeAiError(`Native AI requires a valid ${width} × ${height} RGBA frame.`, "native_invalid", 400);
  }
  return { type: "segment", width, height, rgba: request.rgba, ...selected };
}

export async function readNativeAiRequest(request: Request): Promise<NativeAiRequest> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new NativeAiError("Native inference expects JSON.", "native_invalid", 415);
  }
  if (Number(request.headers.get("content-length")) > MAX_NATIVE_REQUEST_BYTES) {
    throw new NativeAiError("The native frame is too large.", "native_invalid", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new NativeAiError("Missing native inference request.", "native_invalid", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_NATIVE_REQUEST_BYTES) {
        await reader.cancel();
        throw new NativeAiError("The native frame is too large.", "native_invalid", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return validateNativeAiRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

function validateResult(value: Record<string, unknown>, request: NativeAiRequest): NativeAiResult {
  if (value.error) {
    throw new NativeAiError(typeof value.error === "string" ? value.error.slice(0, 600) : "Native AI is unavailable.");
  }
  const { model, acceleration, width, height, referenceId } = configuration(request);
  const explicitConfiguration = request.model !== undefined || request.acceleration !== undefined;
  if ((value.provider !== "coreml" && value.provider !== "openvino" && value.provider !== "onnx-cpu") ||
    (acceleration === "gpu" && value.provider === "onnx-cpu") ||
    (acceleration === "cpu" && value.provider !== "onnx-cpu") ||
    (explicitConfiguration && value.model !== model) || (value.model !== undefined && value.model !== model) ||
    (referenceId !== undefined && value.referenceId !== referenceId) ||
    typeof value.device !== "string" || !value.device.trim() || value.device.length > 180 ||
    (value.fallbackReason !== undefined && (typeof value.fallbackReason !== "string" || value.fallbackReason.length > 1000)) ||
    value.width !== width || value.height !== height || value.kind !== "alpha") {
    throw new NativeAiError("Native AI returned invalid device information.");
  }
  if (request.type === "segment") {
    if (!isFrameBase64(value.alpha, width, height)) throw new NativeAiError("Native AI returned an invalid alpha mask.");
    const mask = Buffer.from(value.alpha, "base64");
    for (let offset = 0; offset < mask.length; offset += 4) {
      const alpha = mask.readFloatLE(offset);
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new NativeAiError("Native AI returned an invalid alpha mask.");
    }
  }
  return {
    provider: value.provider, device: value.device, width, height, kind: "alpha",
    ...(value.model !== undefined ? { model } : {}),
    ...(referenceId !== undefined ? { referenceId } : {}),
    ...(value.fallbackReason ? { fallbackReason: value.fallbackReason as string } : {}),
    ...(request.type === "segment" ? { alpha: value.alpha as string } : {}),
  };
}

interface NativeAiOptions {
  executable?: string;
  args?: string[];
  root?: string;
  initializeTimeoutMs?: number;
  frameTimeoutMs?: number;
  generalInitializeTimeoutMs?: number;
  generalFrameTimeoutMs?: number;
  idleTimeoutMs?: number;
}

interface PendingRequest {
  id: number;
  request: NativeAiRequest;
  resolve: (value: NativeAiResult) => void;
  reject: (error: NativeAiError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort: () => void;
}

/** One owned, persistent worker. Busy frames are rejected instead of queued. */
export class NativeAiController {
  private child?: ChildProcessWithoutNullStreams;
  private childClosed?: Promise<void>;
  private pending?: PendingRequest;
  private output = "";
  private sequence = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private initialized = false;
  private currentConfiguration?: string;
  private retirement: Promise<void> = Promise.resolve();

  constructor(private readonly options: NativeAiOptions = {}) {}

  private stop(error?: NativeAiError): void {
    const child = this.child;
    const closed = this.childClosed;
    this.child = undefined;
    this.childClosed = undefined;
    this.initialized = false;
    this.currentConfiguration = undefined;
    this.output = "";
    clearTimeout(this.idle);
    this.idle = undefined;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(error ?? new NativeAiError("Native AI was closed.", "native_cancelled", 499));
    }
    if (child) {
      this.retirement = Promise.all([this.retirement, closed]).then(() => {});
      child.stdin.destroy();
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 750);
      forceKill.unref();
      child.once("close", () => clearTimeout(forceKill));
    }
  }

  close(): void { this.stop(); }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const root = this.options.root ?? process.cwd();
    // These are runtime installation paths. Next also uses this annotation on
    // path.join itself to avoid tracing optional files and external symlinks.
    const executable = this.options.executable ?? process.env.PHOTO_KIOSK_AI_PYTHON ?? path.join(/* turbopackIgnore: true */ root, ".venv-ai/bin/python");
    const args = this.options.args ?? [path.join(/* turbopackIgnore: true */ root, "scripts/native-ai/worker.py")];
    const child = spawn(/* turbopackIgnore: true */ executable, args, {
      cwd: root, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    this.child = child;
    // Register before the close handler can call stop(). Adding a new once()
    // listener while close is already being emitted would wait forever.
    this.childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdout.setEncoding("utf8");
    // Runtime diagnostics may be verbose; drain them without retaining image
    // data or unbounded logs. Structured worker errors carry useful guidance.
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (this.child === child) this.stop(new NativeAiError("Native AI stopped accepting frames. Reopen the preview to retry."));
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (this.child === child) this.stop(new NativeAiError(error.code === "ENOENT" ? `Native AI is not installed. ${SETUP_HELP}` : `Native AI could not start. ${SETUP_HELP}`));
    });
    child.on("close", () => {
      if (this.child === child) this.stop(new NativeAiError("Native AI stopped unexpectedly. Reopen the preview to retry."));
    });
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.output += chunk;
      if (this.output.length > MAX_NATIVE_REQUEST_BYTES) {
        this.stop(new NativeAiError("Native AI returned too much data."));
        return;
      }
      const newline = this.output.indexOf("\n");
      if (newline < 0) return;
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      const pending = this.pending;
      try {
        const result = JSON.parse(line) as Record<string, unknown>;
        if (!pending || !result || result.id !== pending.id || this.output.length) throw new NativeAiError("Native AI returned an unexpected response.");
        const validated = validateResult(result, pending.request);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener("abort", pending.abort);
        this.pending = undefined;
        this.initialized = true;
        this.idle = setTimeout(() => this.stop(), this.options.idleTimeoutMs ?? 5 * 60_000);
        this.idle.unref();
        pending.resolve(validated);
      } catch (error) {
        this.stop(error instanceof NativeAiError ? error : new NativeAiError("Native AI returned an invalid response."));
      }
    });
    return child;
  }

  request(input: NativeAiRequest, signal?: AbortSignal): Promise<NativeAiResult> {
    if (signal?.aborted) return Promise.reject(new NativeAiError("Native AI request cancelled.", "native_cancelled", 499));
    if (this.pending) return Promise.reject(new NativeAiError("Native AI is processing another frame. Try again shortly.", "native_busy", 429));
    const request = validateNativeAiRequest(input);
    const key = configurationKey(request);
    if (this.currentConfiguration && this.currentConfiguration !== key) {
      if (request.type !== "initialize") {
        return Promise.reject(new NativeAiError("The native model changed. Initialize the selected model before sending another frame.", "native_model_changed", 409));
      }
      // A separate process releases the former model and native allocator before
      // loading a potentially large replacement. Never keep two sessions alive.
      this.stop();
    }
    clearTimeout(this.idle);
    this.idle = undefined;
    this.currentConfiguration = key;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => this.stop(new NativeAiError("Native AI request cancelled.", "native_cancelled", 499));
      const general = configuration(request).model !== "modnet";
      const timeoutMs = !this.initialized || request.type === "initialize"
        ? (general ? (this.options.generalInitializeTimeoutMs ?? this.options.initializeTimeoutMs ?? 180_000) : (this.options.initializeTimeoutMs ?? 40_000))
        : (general ? (this.options.generalFrameTimeoutMs ?? this.options.frameTimeoutMs ?? 90_000) : (this.options.frameTimeoutMs ?? 12_000));
      const timer = setTimeout(() => this.stop(new NativeAiError("Native AI timed out. Reopen the preview to retry or select CPU.", "native_timeout", 504)), timeoutMs);
      const pending: PendingRequest = { id, request, resolve, reject, timer, signal, abort };
      this.pending = pending;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void this.retirement.then(() => {
        if (this.pending !== pending) return;
        const child = this.start();
        child.stdin.write(JSON.stringify({ id, ...request }) + "\n");
      }).catch(() => this.stop(new NativeAiError("Native AI could not start. Reopen the preview to retry.")));
    });
  }
}

const nativeGlobal = globalThis as typeof globalThis & {
  photoKioskNativeAi?: NativeAiController;
  nativeAiExitRegistered?: boolean;
};
export const nativeAi = nativeGlobal.photoKioskNativeAi ??= new NativeAiController();
// The singleton survives development module reloads; register cleanup once.
if (!nativeGlobal.nativeAiExitRegistered) {
  nativeGlobal.nativeAiExitRegistered = true;
  process.once("exit", () => nativeAi.close());
}
