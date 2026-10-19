import { spawn } from "node:child_process";
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

export class CameraError extends Error {
  constructor(
    message: string,
    public readonly code = "camera_error",
    public readonly status = 503,
    public readonly details?: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

interface CommandOptions {
  timeoutMs: number;
  cwd?: string;
  signal?: AbortSignal;
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
  "Connect the camera to this computer with a USB data cable and turn it on. Close EOS Utility, Photos, Image Capture, and any other camera app. Use still-photo mode, JPEG or RAW+JPEG quality, and Manual exposure for ISO, aperture, and shutter control.";
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const MAX_JPEG_BYTES = 50 * 1024 * 1024;

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
      failure ??= new CameraError(
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
        const detail = (result.stderr || result.stdout).trim().slice(0, 1500);
        const busy =
          /claim.*(?:USB|device)|(?:camera|device).*busy|PTP.*busy/i.test(
            detail,
          );
        return reject(
          new CameraError(
            busy
              ? "Another app is using the camera. Close other camera apps and reconnect it."
              : "The camera command failed. Check the camera and its settings, then try again.",
            busy ? "camera_in_use" : "camera_command",
            503,
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
  private previewRequest: Promise<Buffer> | null = null;

  constructor(private readonly run: GphotoRunner = runGphoto) {}

  private async exclusive<T>(
    purpose: "preview" | "capture" | "configure" | "status",
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
      error instanceof CameraError
        ? error
        : new CameraError("The camera could not complete this operation.");
    if (
      failure.status !== 400 &&
      failure.status !== 409 &&
      failure.code !== "camera_cancelled"
    ) {
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
    this.statusCache = {
      value: {
        connected: true,
        available: true,
        model: camera.model,
        details:
          "USB tether ready on this computer. Live preview refreshes up to once per second.",
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

  async getStatus(): Promise<CameraStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < 5000)
      return this.statusCache.value;
    if (this.statusRequest) return this.statusRequest;
    this.statusRequest = this.exclusive("status", async () => {
      try {
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
    try {
      assertCameraRequestActive(signal);
      await this.run(
        [
          ...this.cameraArgs(camera),
          "--filename",
          path.join(directory, preview ? "preview.jpg" : "capture-%n.%C"),
          "--force-overwrite",
          ...(preview
            ? ["--capture-preview"]
            : ["--keep", "--capture-image-and-download"]),
        ],
        { timeoutMs: preview ? 15_000 : 60_000, cwd: directory, signal },
      );
      assertCameraRequestActive(signal);
      const filename = preview
        ? "preview.jpg"
        : (await readdir(directory)).find((name) =>
            /^capture-\d+\.jpe?g$/i.test(name),
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

  async preview(): Promise<Buffer> {
    if (this.pending > 0 && !this.previewRequest) {
      throw new CameraError(
        "The camera is busy taking a photo or applying settings.",
        "camera_busy",
        409,
      );
    }
    if (this.previewRequest) return this.previewRequest;
    if (this.previewCache && Date.now() - this.previewCache.at < 1000)
      return this.previewCache.bytes;
    this.previewRequest = this.exclusive("preview", async () => {
      try {
        const bytes = await this.captureFile(true);
        this.previewCache = { bytes, at: Date.now() };
        return bytes;
      } catch (error) {
        throw this.rememberError(error);
      }
    }).finally(() => {
      this.previewRequest = null;
    });
    return this.previewRequest;
  }

  async capture(signal?: AbortSignal): Promise<Buffer> {
    assertCameraRequestActive(signal);
    return this.exclusive("capture", async () => {
      // Cancellation while waiting for a shared preview or another capture must
      // skip this shutter entirely. A shutter already fired cannot be undone.
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
    error instanceof CameraError
      ? error
      : new CameraError("The camera operation failed.");
  return Response.json(
    { error: failure.message, code: failure.code, details: failure.details },
    {
      status: failure.status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function cameraJpegResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
