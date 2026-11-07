import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CameraError, classifyGphotoFailure, recognizedCameraError } from "./camera-errors";
import { GphotoLiveView, type LiveGphotoFactory, type LiveViewOptions } from "./camera-live";
export { CameraError } from "./camera-errors";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface CameraStatus {
  connected: boolean;
  model: string | null;
  available: boolean;
  error?: string;
  details?: string;
}

export interface CameraConfiguration {
  iso: string;
  aperture: string;
  shutterSpeed: string;
}


interface CommandOptions {
  timeoutMs: number;
  cwd?: string;
  signal?: AbortSignal;
  /** What exceeding timeoutMs means for this command; a USB timeout by default. */
  timeoutError?: () => CameraError;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type GphotoRunner = (
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

const INSTALL_HELP =
  "Install gphoto2 on the computer running this app (macOS: brew install gphoto2; Ubuntu/Debian: sudo apt install gphoto2), then restart the app. You can also set GPHOTO2_PATH to its executable.";
const CONNECT_HELP =
  "Connect the camera to this computer with a USB data cable and turn it on. Close EOS Utility, Photos, Image Capture, and any other camera app. Use still-photo mode and JPEG or RAW+JPEG quality. For automatic exposure, set the camera to P with ISO Auto; use M when applying manual exposure settings from the app.";
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const MAX_JPEG_BYTES = 50 * 1024 * 1024;
export const LIVE_STREAM_CONTENT_TYPE = "application/vnd.photokiosk.frames";
/** The frame number that marks a stream's final chunk as a JSON error instead of a JPEG. */
export const LIVE_STREAM_ERROR_SEQ = 0xffffffff;

/** One live-stream chunk: a 4-byte length, a 4-byte frame number, then the bytes. */
export function encodeLiveFrame(bytes: Uint8Array, seq: number): Uint8Array {
  const chunk = Buffer.alloc(8 + bytes.byteLength);
  chunk.writeUInt32BE(bytes.byteLength, 0);
  chunk.writeUInt32BE(seq >>> 0, 4);
  chunk.set(bytes, 8);
  return chunk;
}
// A healthy shot (live view entry, autofocus, shutter, download) takes 2-3 s.
// When live-view AF misses, the 5D Mark IV silently ignores the full press and
// libgphoto2 waits about 90 s for a photo that never arrives. Give up well
// before that, so the shot can be retried instead of stalling the guest.
const STILL_CAPTURE_TIMEOUT_MS = 12_000;
const STILL_CAPTURE_ATTEMPTS = 2;
const RELEASE_HELP =
  "Make sure guests are in front of the camera with enough light. A plain backdrop with nobody in front gives autofocus nothing to lock on. If this keeps happening, switch the camera off and on, or set the lens to MF and focus on where guests stand.";

function shutterNotReleased(details?: string): CameraError {
  return new CameraError(
    "The camera couldn't take the photo. It may not have been able to focus. Please try again.",
    "camera_release",
    503,
    details ? `${details}\n${RELEASE_HELP}` : RELEASE_HELP,
  );
}
// Live view keeps focusing on whoever is in front of the camera, so a saved
// live-view frame is sharp and a still's half-press starts close to focus.
const CONTINUOUS_AF_ARGS = ["--set-config", "continuousaf=On"] as const;
// The shutter's half-press autofocuses. In live view it uses the wide-area
// FlexiZone - Multi method; viewfinder AF points cannot be changed over USB.
const WIDE_AUTOFOCUS_ARGS = [
  "--set-config-value",
  "viewfinder=1",
  "--set-config-value",
  "afmethod=LiveMulti",
] as const;

/** gphoto2 stops at the first failed action, so these failures precede the shutter. */
function rejectedAutofocusSetup(error: unknown): boolean {
  const failure = recognizedCameraError(error);
  return (
    failure?.code === "camera_command" &&
    /\b(?:viewfinder|afmethod|LiveMulti)\b/i.test(failure.details ?? "")
  );
}

function cancelledCameraRequest(): CameraError {
  return new CameraError(
    "The camera request was cancelled.",
    "camera_cancelled",
    499,
  );
}

function assertCameraRequestActive(signal?: AbortSignal): void {
  // Next may abort with ResponseAborted rather than a DOMException. The
  // signal's state, not the type of its reason, determines cancellation.
  if (signal?.aborted) throw cancelledCameraRequest();
}

/** The executable and argument vector are passed directly to the OS, never a shell. */
export function runGphoto(
  args: readonly string[],
  options: CommandOptions,
  executable = process.env.GPHOTO2_PATH || "gphoto2",
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(cancelledCameraRequest());
      return;
    }
    const child = spawn(/* turbopackIgnore: true */ executable, [...args], {
      cwd: options.cwd,
      env: { ...process.env, LANG: "C", LANGUAGE: "C", LC_ALL: "C" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: CameraError | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const stopOwnedChild = () => {
      child.kill("SIGTERM");
      // Only terminate this request's child process. Never kill EOS Utility or
      // operating-system camera services to try to steal their USB connection.
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 750);
    };
    const abort = () => {
      failure ??= cancelledCameraRequest();
      stopOwnedChild();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      failure ??= options.timeoutError?.() ?? new CameraError(
        "The camera did not respond in time. Check its USB connection and wake it up, then try again.",
        "camera_timeout",
        504,
        CONNECT_HELP,
      );
      stopOwnedChild();
    }, options.timeoutMs);

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT) {
        failure ??= new CameraError(
          "The camera returned too much diagnostic output.",
        );
        stopOwnedChild();
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??=
        error.code === "ENOENT"
          ? new CameraError(
              "gphoto2 is not installed or could not be found.",
              "gphoto_unavailable",
              503,
              INSTALL_HELP,
            )
          : new CameraError(
              "The local camera process could not start.",
              "camera_process",
              503,
              error.message,
            );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      // Resolve/reject only after close, including cancellation, so temporary
      // files and USB ownership stay protected until our child is reaped.
      if (failure) return reject(failure);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        const diagnostic = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
        const detail = diagnostic.slice(0, 1500);
        const kind = classifyGphotoFailure(diagnostic);
        if (kind === "release") return reject(shutterNotReleased(detail));
        return reject(
          new CameraError(
            kind === "busy"
              ? "Another app or the macOS camera import helper may be using the camera. Close Photos, Preview, Image Capture, and EOS Utility, then reconnect the camera."
              : kind === "timeout"
                ? "The camera timed out while communicating over USB. Wake the camera, check its USB cable, then reconnect it and try again."
                : kind === "io"
                  ? "The camera's USB connection needs to be recovered. The kiosk will reset the connection and try again."
                : "The camera command failed. Check the camera and its settings, then try again.",
            kind === "busy" ? "camera_in_use" : kind === "timeout" ? "camera_timeout" : kind === "io" ? "camera_io" : "camera_command",
            kind === "timeout" ? 504 : 503,
            detail || CONNECT_HELP,
          ),
        );
      }
      resolve(result);
    });
  });
}

interface DetectedCamera {
  model: string;
  port: string;
}

interface PreviewRequest {
  promise: Promise<Buffer>;
  controller: AbortController;
  subscribers: number;
}

interface LiveSession {
  id: string;
  camera: DetectedCamera;
  stream: GphotoLiveView;
  lease?: ReturnType<typeof setTimeout>;
}

export interface CameraLiveOptions {
  factory?: LiveGphotoFactory;
  stream?: LiveViewOptions;
  leaseMs?: number;
}

export function parseDetectedCameras(output: string): DetectedCamera[] {
  // The C locale gives a stable table. Accept USB cameras only: this feature
  // controls hardware tethered to the kiosk host, not arbitrary network hosts.
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(.+?)\s+(usb:\d+(?:,\d+)?)\s*$/);
    return match ? [{ model: match[1].trim(), port: match[2] }] : [];
  });
}

export function validateCameraConfiguration(
  value: unknown,
): CameraConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CameraError(
      "Provide ISO, aperture, and shutter speed.",
      "invalid_configuration",
      400,
    );
  }
  const candidate = value as Record<string, unknown>;
  const { iso, aperture, shutterSpeed } = candidate;
  if (
    typeof iso !== "string" ||
    !/^(?:Auto|[1-9]\d{1,5})$/.test(iso) ||
    typeof aperture !== "string" ||
    !/^\d{1,2}(?:\.\d)?$/.test(aperture) ||
    Number(aperture) < 1 ||
    Number(aperture) > 99 ||
    typeof shutterSpeed !== "string" ||
    !/^(?:1\/[1-9]\d{0,4}|\d{1,2}(?:\.\d{1,3})?)$/.test(shutterSpeed)
  ) {
    throw new CameraError(
      "Choose valid ISO, aperture, and shutter speed values.",
      "invalid_configuration",
      400,
    );
  }
  const exposure = shutterSpeed.startsWith("1/")
    ? 1 / Number(shutterSpeed.slice(2))
    : Number(shutterSpeed);
  if (exposure <= 0 || exposure > 30) {
    throw new CameraError(
      "Choose a shutter speed between 1/99999 and 30 seconds.",
      "invalid_configuration",
      400,
    );
  }
  return { iso, aperture, shutterSpeed };
}

/** One controller is shared by all camera routes in a single local Node server. */
export class CameraController {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private selected: DetectedCamera | null = null;
  private statusCache: { value: CameraStatus; at: number } | null = null;
  private statusRequest: Promise<CameraStatus> | null = null;
  private previewCache: { bytes: Buffer; at: number } | null = null;
  private previewRequest: PreviewRequest | null = null;
  private previewFailure: CameraError | null = null;
  private live: LiveSession | null = null;
  private liveStarting = false;
  private lastLive: { id: string; failure: CameraError | null } | null = null;
  private recoveryCamera: DetectedCamera | null = null;
  private lastUsbResetAt: number | null = null;
  private autofocusRejected = new Set<string>();
  private continuousAfRejected = new Set<string>();

  constructor(private readonly run: GphotoRunner = runGphoto, private readonly liveOptions: CameraLiveOptions = {}) {}

  private async exclusive<T>(
    purpose: "preview" | "capture" | "configure" | "status" | "live",
    work: () => Promise<T>,
  ): Promise<T> {
    // Preview requests must never build a queue of obsolete frames in front of
    // the shutter. A capture waits only for the operation already in progress.
    if ((purpose === "preview" && this.pending > 0) || this.pending >= 4) {
      throw new CameraError(
        "The camera is busy. Please try again shortly.",
        "camera_busy",
        409,
      );
    }
    this.pending++;
    const previous = this.tail;
    const operation = previous.then(work).finally(() => {
      this.pending--;
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private rememberError(error: unknown): CameraError {
    const failure =
      recognizedCameraError(error) ??
      new CameraError("The camera could not complete this operation.");
    if (
      failure.status !== 400 &&
      failure.status !== 409 &&
      failure.code !== "camera_cancelled" &&
      // A refused shutter is a focus problem on a working USB connection.
      failure.code !== "camera_release"
    ) {
      if (this.selected && (failure.code === "camera_io" || failure.code === "camera_timeout"))
        this.recoveryCamera = this.selected;
      this.statusCache = {
        value: {
          connected: false,
          model: this.selected?.model ?? null,
          available: failure.code !== "gphoto_unavailable",
          error: failure.message,
          details: failure.details,
        },
        at: Date.now(),
      };
      this.selected = null;
      this.previewCache = null;
    }
    return failure;
  }

  private rememberConnected(camera: DetectedCamera) {
    this.recoveryCamera = null;
    this.statusCache = {
      value: {
        connected: true,
        available: true,
        model: camera.model,
        details:
          "USB tether ready on this computer. Start Canon live preview with the preview button.",
      },
      at: Date.now(),
    };
  }

  private async detect(signal?: AbortSignal): Promise<DetectedCamera> {
    assertCameraRequestActive(signal);
    const { stdout } = await this.run(["--auto-detect"], {
      timeoutMs: 10_000,
      signal,
    });
    assertCameraRequestActive(signal);
    const cameras = parseDetectedCameras(stdout);
    const preferred = cameras.filter((camera) =>
      /^Canon EOS 5D Mark IV$/i.test(camera.model),
    );
    const candidates = preferred.length ? preferred : cameras;
    if (!candidates.length) {
      throw new CameraError(
        "No USB camera was detected on the kiosk computer.",
        "camera_disconnected",
        503,
        CONNECT_HELP,
      );
    }
    if (candidates.length > 1) {
      throw new CameraError(
        "More than one USB camera was found. Connect only the camera you want to use.",
        "camera_ambiguous",
        503,
      );
    }
    this.selected = candidates[0];
    return this.selected;
  }

  private cameraArgs(camera: DetectedCamera): string[] {
    return ["--camera", camera.model, "--port", camera.port];
  }

  private async recoverUsb(signal?: AbortSignal): Promise<void> {
    const camera = this.recoveryCamera;
    this.recoveryCamera = null;
    if (!camera || (this.lastUsbResetAt !== null && Date.now() - this.lastUsbResetAt < 30_000)) return;
    assertCameraRequestActive(signal);
    this.lastUsbResetAt = Date.now();
    // Only recover the failed camera, inside the exclusive operation after its
    // process has closed. Never reset for a busy camera or retry a still shutter.
    try {
      await this.run([...this.cameraArgs(camera), "--reset"], { timeoutMs: 10_000, signal });
    } catch {
      // A disconnected device may already have a new address. Detect it below
      // even if the old port cannot be reset.
    }
    assertCameraRequestActive(signal);
    this.selected = null;
    this.statusCache = null;
  }

  async getStatus(): Promise<CameraStatus> {
    if (this.live) return this.liveStatus();
    if (this.statusCache && Date.now() - this.statusCache.at < 5000)
      return this.statusCache.value;
    if (this.statusRequest) return this.statusRequest;
    this.statusRequest = this.exclusive("status", async () => {
      try {
        if (this.live) return this.liveStatus();
        const camera = await this.detect();
        // Auto-detect alone does not prove the USB connection can be claimed.
        await this.run([...this.cameraArgs(camera), "--summary"], {
          timeoutMs: 10_000,
        });
        this.rememberConnected(camera);
        return this.statusCache!.value;
      } catch (error) {
        const failure = this.rememberError(error);
        return (
          this.statusCache?.value ?? {
            connected: false,
            model: null,
            available: true,
            error: failure.message,
          }
        );
      }
    }).finally(() => {
      this.statusRequest = null;
    });
    return this.statusRequest;
  }

  private liveStatus(): CameraStatus {
    const session = this.live!;
    return {
      connected: Boolean(session.stream.latest && !session.stream.stopping && !session.stream.ended),
      available: true,
      model: session.camera.model,
      details: session.stream.stopping ? "Canon live preview is stopping." : "Canon live preview holds one USB connection.",
    };
  }

  private renewLiveLease(session: LiveSession) {
    clearTimeout(session.lease);
    session.lease = setTimeout(() => { void session.stream.stop(); }, this.liveOptions.leaseMs ?? 5000);
    session.lease.unref();
  }

  private expiredLive(): CameraError {
    return new CameraError("Canon live preview has ended. Use Start live preview to begin a new session.", "camera_live_expired", 410);
  }

  private validateLiveId(id: unknown): asserts id is string {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      throw new CameraError("A valid Canon live preview session ID is required.", "invalid_configuration", 400);
  }

  async startLive(signal?: AbortSignal): Promise<{ id: string; model: string }> {
    assertCameraRequestActive(signal);
    if (this.live || this.liveStarting || this.pending > 0)
      throw new CameraError("The camera already has an active operation or live preview. Stop it before starting another preview.", "camera_busy", 409);
    this.liveStarting = true;
    try {
      return await this.exclusive("live", async () => {
        assertCameraRequestActive(signal);
        await this.recoverUsb(signal);
        // Reboots, USB reconnection, and --reset can all change the USB address.
        const detected = await this.detect(signal);
        assertCameraRequestActive(signal);
        const continuousAf = !this.continuousAfRejected.has(detected.model);
        let stream: GphotoLiveView;
        try {
          stream = new GphotoLiveView(
            [...this.cameraArgs(detected), ...(continuousAf ? CONTINUOUS_AF_ARGS : [])],
            this.liveOptions.factory,
            this.liveOptions.stream,
          );
        } catch (error) { throw this.rememberError(error); }
        const session: LiveSession = { id: randomUUID(), camera: detected, stream };
        this.live = session;
        void stream.closed.then(() => {
          clearTimeout(session.lease);
          this.lastLive = { id: session.id, failure: stream.failure };
          if (this.live === session) this.live = null;
          if (stream.failure && stream.failure.code !== "camera_cancelled") this.rememberError(stream.failure);
        });
        const abort = () => { void stream.stop(cancelledCameraRequest()); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        try {
          await stream.ready;
          assertCameraRequestActive(signal);
          if (stream.stopping || stream.ended) throw stream.failure ?? this.expiredLive();
          this.rememberConnected(detected);
          this.renewLiveLease(session);
          return { id: session.id, model: detected.model };
        } catch (error) {
          await stream.stop();
          // A camera without this setting fails before its first frame; live
          // view then starts without it, this time and from now on.
          if (continuousAf && /continuousaf/i.test(recognizedCameraError(error)?.details ?? "")) {
            this.continuousAfRejected.add(detected.model);
            this.live = null;
            throw new CameraError("Live view is restarting without continuous autofocus.", "camera_busy", 409, recognizedCameraError(error)?.details);
          }
          throw this.rememberError(error);
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      });
    } finally {
      this.liveStarting = false;
    }
  }

  liveFrame(id: unknown): Buffer {
    this.validateLiveId(id);
    const session = this.live;
    if (!session || session.id !== id) {
      if (this.lastLive?.id === id && this.lastLive.failure) throw this.lastLive.failure;
      throw this.expiredLive();
    }
    if (session.stream.ended || session.stream.stopping) throw session.stream.failure ?? this.expiredLive();
    if (!session.stream.latest) throw new CameraError("Canon live preview is still starting.", "camera_busy", 409);
    this.renewLiveLease(session);
    return session.stream.latest;
  }

  /**
   * The newest frame after `after`, waiting briefly for the camera to deliver
   * one. Readers then pace themselves on fresh frames instead of a fixed sleep
   * that either repeats frames or leaves the camera's 30 fps unused.
   */
  async nextLiveFrame(id: unknown, after: number, signal?: AbortSignal): Promise<{ bytes: Buffer; seq: number }> {
    let bytes = this.liveFrame(id);
    const stream = this.live!.stream;
    if (Number.isSafeInteger(after) && after >= stream.frameSeq) {
      await stream.waitForFrameAfter(after, 2000, signal);
      assertCameraRequestActive(signal);
      // The session may have ended or been replaced while this reader waited.
      bytes = this.liveFrame(id);
    }
    return { bytes, seq: this.live!.stream.frameSeq };
  }

  /**
   * Every new frame as it arrives, on one long-lived response, so the kiosk
   * shows the camera's full 30 fps without a request per frame. Each chunk is
   * a length-prefixed frame (see encodeLiveFrame); a final chunk carries the
   * error that ended the stream, since the HTTP status has already been sent.
   */
  liveFrameStream(id: unknown, signal?: AbortSignal): ReadableStream<Uint8Array> {
    // Fail with a real HTTP status now, before any frame bytes are committed.
    this.liveFrame(id);
    const reader = new AbortController();
    const abort = () => reader.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    // The open connection is proof the kiosk is alive, so the lease is renewed
    // on a timer rather than only when the page gets around to reading.
    const keepAlive = setInterval(() => {
      try { this.liveFrame(id); } catch { clearInterval(keepAlive); }
    }, Math.max(20, (this.liveOptions.leaseMs ?? 5000) / 4));
    keepAlive.unref();
    const release = () => {
      clearInterval(keepAlive);
      signal?.removeEventListener("abort", abort);
    };
    let seq = -1;
    return new ReadableStream<Uint8Array>({
      pull: async (stream) => {
        try {
          let frame = await this.nextLiveFrame(id, seq, reader.signal);
          // Waiting timed out without a newer frame: keep waiting rather than repeat it.
          while (frame.seq === seq) {
            assertCameraRequestActive(reader.signal);
            frame = await this.nextLiveFrame(id, seq, reader.signal);
          }
          seq = frame.seq;
          stream.enqueue(encodeLiveFrame(frame.bytes, frame.seq));
        } catch (error) {
          release();
          if (!reader.signal.aborted) {
            const failure = recognizedCameraError(error) ?? new CameraError("The camera operation failed.");
            stream.enqueue(encodeLiveFrame(
              Buffer.from(JSON.stringify({ error: failure.message, code: failure.code, status: failure.status })),
              LIVE_STREAM_ERROR_SEQ,
            ));
          }
          stream.close();
        }
      },
      cancel: () => {
        release();
        reader.abort();
      },
    });
  }

  async stopLive(id: unknown): Promise<void> {
    this.validateLiveId(id);
    if (!this.live || this.live.id !== id) {
      if (!this.live && this.lastLive?.id === id) return;
      throw this.expiredLive();
    }
    await this.stopLiveForOperation();
  }

  private async stopLiveForOperation(): Promise<void> {
    const session = this.live;
    if (!session) return;
    clearTimeout(session.lease);
    await session.stream.stop();
  }

  private async readJpeg(filename: string): Promise<Buffer> {
    const info = await stat(filename);
    if (!info.isFile() || info.size > MAX_JPEG_BYTES) {
      throw new CameraError(
        "The camera image is too large. Choose a smaller JPEG quality setting.",
        "invalid_camera_image",
        422,
      );
    }
    const bytes = await readFile(filename);
    if (
      bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    ) {
      throw new CameraError(
        "The camera did not return a JPEG. Set image quality to JPEG or RAW+JPEG on the camera.",
        "invalid_camera_image",
        422,
      );
    }
    return bytes;
  }

  private async captureFile(
    preview: boolean,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    assertCameraRequestActive(signal);
    const camera = this.selected ?? (await this.detect(signal));
    assertCameraRequestActive(signal);
    const directory = await mkdtemp(path.join(tmpdir(), "photokiosk-camera-"));
    // Each attempt writes its own names, so a retry never collides with (or
    // returns) anything an earlier attempt left behind.
    let attempt = 1;
    const runCapture = (autofocus: boolean) =>
      this.run(
        [
          ...this.cameraArgs(camera),
          "--filename",
          path.join(directory, preview ? "preview.jpg" : `capture-${attempt}-%n.%C`),
          "--force-overwrite",
          ...(preview
            ? ["--capture-preview"]
            : [
                ...(autofocus ? WIDE_AUTOFOCUS_ARGS : []),
                "--keep",
                "--capture-image-and-download",
              ]),
        ],
        preview
          ? { timeoutMs: 15_000, cwd: directory, signal }
          : {
              timeoutMs: STILL_CAPTURE_TIMEOUT_MS,
              cwd: directory,
              signal,
              // A downloaded photo arrives within a second of the shutter, so
              // a still that outlives this deadline was never taken. It is a
              // refused shutter to retry, not a USB fault to reset.
              timeoutError: () => shutterNotReleased(
                `No photo arrived within ${STILL_CAPTURE_TIMEOUT_MS / 1000} s of the shutter press.`,
              ),
            },
      );
    const shootStill = async () => {
      const autofocus = !this.autofocusRejected.has(camera.model);
      try {
        await runCapture(autofocus);
      } catch (error) {
        if (!autofocus || !rejectedAutofocusSetup(error)) throw error;
        // The shutter has not fired. Shoot with the camera's own AF settings
        // and skip the rejected live-view setup for later photos.
        this.autofocusRejected.add(camera.model);
        assertCameraRequestActive(signal);
        await runCapture(false);
      }
    };
    try {
      assertCameraRequestActive(signal);
      if (preview) await runCapture(false);
      else {
        for (;; attempt++) {
          try {
            await shootStill();
            break;
          } catch (error) {
            if (attempt >= STILL_CAPTURE_ATTEMPTS || recognizedCameraError(error)?.code !== "camera_release")
              throw error;
            // The camera ignored the press, so no photo exists and another
            // press cannot double-shoot. Autofocus often locks on the next try.
            assertCameraRequestActive(signal);
          }
        }
      }
      assertCameraRequestActive(signal);
      const filename = preview
        ? "preview.jpg"
        : (await readdir(directory)).find((name) =>
            new RegExp(`^capture-${attempt}-\\d+\\.jpe?g$`, "i").test(name),
          );
      if (!filename) {
        throw new CameraError(
          "No JPEG was downloaded. Set image quality to JPEG or RAW+JPEG on the camera, then try again.",
          "jpeg_required",
          422,
        );
      }
      const bytes = await this.readJpeg(path.join(directory, filename));
      assertCameraRequestActive(signal);
      this.rememberConnected(camera);
      return bytes;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private subscribePreview(request: PreviewRequest, signal?: AbortSignal): Promise<Buffer> {
    request.subscribers++;
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const abort = () => {
        if (cancelled) return;
        cancelled = true;
        request.subscribers--;
        if (request.subscribers === 0) request.controller.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      // A cancelled subscriber waits until the owned process has exited and its
      // temporary files are gone. Other active subscribers retain their frame.
      void request.promise.then(
        (bytes) => cancelled ? reject(cancelledCameraRequest()) : resolve(bytes),
        (error) => reject(cancelled ? cancelledCameraRequest() : error),
      ).finally(() => {
        signal?.removeEventListener("abort", abort);
        if (!cancelled) request.subscribers--;
      });
    });
  }

  async preview(signal?: AbortSignal, options: { retry?: boolean } = {}): Promise<Buffer> {
    assertCameraRequestActive(signal);
    if (this.live) {
      if (this.live.stream.stopping || !this.live.stream.latest)
        throw new CameraError("Canon live preview is starting or stopping. Wait before requesting a snapshot.", "camera_busy", 409);
      return this.live.stream.latest;
    }
    if (this.previewFailure && !options.retry) throw this.previewFailure;
    if (this.pending > 0 && !this.previewRequest) {
      throw new CameraError(
        "The camera is busy taking a photo or applying settings.",
        "camera_busy",
        409,
      );
    }
    if (this.previewRequest) {
      if (this.previewRequest.controller.signal.aborted)
        throw new CameraError("The preview is stopping. Wait a moment before requesting another snapshot.", "camera_busy", 409);
      return this.subscribePreview(this.previewRequest, signal);
    }
    if (options.retry) {
      this.previewFailure = null;
      this.previewCache = null;
    }
    if (this.previewCache && Date.now() - this.previewCache.at < 1000)
      return this.previewCache.bytes;
    const controller = new AbortController();
    const request: PreviewRequest = {
      controller,
      subscribers: 0,
      promise: this.exclusive("preview", async () => {
        try {
          const bytes = await this.captureFile(true, controller.signal);
          this.previewCache = { bytes, at: Date.now() };
          return bytes;
        } catch (error) {
          const failure = this.rememberError(error);
          if (failure.code !== "camera_cancelled" && failure.status !== 409)
            this.previewFailure = failure;
          throw failure;
        }
      }).finally(() => {
        if (this.previewRequest === request) this.previewRequest = null;
      }),
    };
    this.previewRequest = request;
    return this.subscribePreview(request, signal);
  }

  async capture(signal?: AbortSignal): Promise<Buffer> {
    assertCameraRequestActive(signal);
    return this.exclusive("capture", async () => {
      // Cancellation while waiting for a shared preview or another capture must
      // skip this shutter entirely. A shutter already fired cannot be undone.
      assertCameraRequestActive(signal);
      await this.stopLiveForOperation();
      assertCameraRequestActive(signal);
      this.previewCache = null;
      try {
        return await this.captureFile(false, signal);
      } catch (error) {
        throw this.rememberError(error);
      }
    });
  }

  async configure(value: unknown): Promise<void> {
    const settings = validateCameraConfiguration(value);
    return this.exclusive("configure", async () => {
      try {
        await this.stopLiveForOperation();
        const camera = this.selected ?? (await this.detect());
        await this.run(
          [
            ...this.cameraArgs(camera),
            "--set-config-value",
            `iso=${settings.iso}`,
            "--set-config-value",
            `aperture=${settings.aperture}`,
            "--set-config-value",
            `shutterspeed=${settings.shutterSpeed}`,
          ],
          { timeoutMs: 20_000 },
        );
        this.previewCache = null;
        this.rememberConnected(camera);
      } catch (error) {
        const failure = this.rememberError(error);
        if (failure.code === "camera_command") {
          // A rejected exposure value does not prove USB disconnected. Force
          // the next status read to probe instead of caching a false offline
          // state that could make an immediate retry skip applying settings.
          this.statusCache = null;
          throw new CameraError(
            "The camera could not apply those settings. Switch its mode dial to M and choose values supported by the camera and lens. Some settings may already have been applied.",
            "camera_configuration",
            422,
            failure.details,
          );
        }
        throw failure;
      }
    });
  }
}

const globalCamera = globalThis as typeof globalThis & {
  __photokioskCamera?: CameraController;
};
export const camera = (globalCamera.__photokioskCamera ??=
  new CameraController());

export function cameraErrorResponse(error: unknown): Response {
  const failure =
    recognizedCameraError(error) ??
    new CameraError("The camera operation failed.");
  return Response.json(
    { error: failure.message, code: failure.code, details: failure.details },
    {
      status: failure.status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function cameraJpegResponse(bytes: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
