import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { CameraError } from "./camera-errors";

type LiveChild = Pick<ChildProcess, "kill" | "once"> & { stdout: Readable; stderr: Readable };
export type LiveGphotoFactory = (args: readonly string[]) => LiveChild;

export const spawnLiveGphoto: LiveGphotoFactory = (args) => spawn(
  /* turbopackIgnore: true */ process.env.GPHOTO2_PATH || "gphoto2", [...args], {
    env: { ...process.env, LANG: "C", LANGUAGE: "C", LC_ALL: "C" },
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  },
);

const shutdownState = globalThis as typeof globalThis & { __photokioskLiveChildren?: Set<LiveChild> };
const ownedChildren = shutdownState.__photokioskLiveChildren ??= new Set<LiveChild>();
if (!shutdownState.__photokioskLiveChildren.size) {
  // One handler across module reloads. Only our own child handles are signalled.
  const marker = Symbol.for("photokiosk.live.exit-handler");
  const state = globalThis as typeof globalThis & { [marker]?: boolean };
  if (!state[marker]) {
    state[marker] = true;
    process.once("exit", () => { for (const child of ownedChildren) child.kill("SIGINT"); });
  }
}

/** Parse JPEG segments, including embedded thumbnails and progressive scans. */
export class JpegFrameParser {
  private buffer = Buffer.alloc(0);
  private cursor = 0;
  private started = false;
  private entropy = false;

  constructor(private readonly onFrame: (frame: Buffer) => void, private readonly maxBytes = 12 * 1024 * 1024) {}

  push(bytes: Buffer) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (true) {
      if (!this.started) {
        const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) {
          this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
          return;
        }
        this.buffer = this.buffer.subarray(start);
        this.started = true;
        this.cursor = 2;
        this.entropy = false;
      }
      if (this.entropy) {
        const marker = this.buffer.indexOf(0xff, this.cursor);
        if (marker < 0) { this.cursor = this.buffer.length; break; }
        if (marker + 1 >= this.buffer.length) { this.cursor = marker; break; }
        const code = this.buffer[marker + 1];
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) { this.cursor = marker + 2; continue; }
        if (code === 0xff) { this.cursor = marker + 1; continue; }
        this.cursor = marker;
        this.entropy = false;
      }
      if (this.cursor >= this.buffer.length) break;
      if (this.buffer[this.cursor] !== 0xff) throw this.invalid();
      let marker = this.cursor + 1;
      while (marker < this.buffer.length && this.buffer[marker] === 0xff) marker++;
      if (marker >= this.buffer.length) break;
      const code = this.buffer[marker];
      if (code === 0xd9) {
        const end = marker + 1;
        if (end > this.maxBytes) throw this.tooLarge();
        this.onFrame(Buffer.from(this.buffer.subarray(0, end)));
        this.buffer = this.buffer.subarray(end);
        this.started = false;
        continue;
      }
      if (code === 0xd8 || code === 0x00) throw this.invalid();
      if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) { this.cursor = marker + 1; continue; }
      if (marker + 2 >= this.buffer.length) break;
      const length = this.buffer.readUInt16BE(marker + 1);
      if (length < 2) throw this.invalid();
      const end = marker + 1 + length;
      if (end > this.maxBytes) throw this.tooLarge();
      if (end > this.buffer.length) break;
      this.cursor = end;
      this.entropy = code === 0xda;
    }
    if (this.buffer.length > this.maxBytes) throw this.tooLarge();
  }

  clear() { this.buffer = Buffer.alloc(0); }
  private invalid() { return new CameraError("The camera returned a malformed live preview frame. Stop and start live preview to retry.", "invalid_camera_image", 422); }
  private tooLarge() { return new CameraError("The camera live preview frame exceeded the size limit.", "invalid_camera_image", 422); }
}

export interface LiveViewOptions {
  startupMs?: number;
  frameTimeoutMs?: number;
  stopGraceMs?: number;
  killGraceMs?: number;
  maxFrameBytes?: number;
}

/** One native process holds the USB session; HTTP readers only inspect latest. */
export class GphotoLiveView {
  readonly ready: Promise<Buffer>;
  readonly closed: Promise<void>;
  latest: Buffer | null = null;
  failure: CameraError | null = null;
  stopping = false;
  ended = false;
  private child: LiveChild;
  private stderr = Buffer.alloc(0);
  private firstFrame = false;
  private startupTimer: ReturnType<typeof setTimeout>;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private termTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private resolveReady!: (frame: Buffer) => void;
  private rejectReady!: (error: CameraError) => void;
  private resolveClosed!: () => void;

  constructor(args: readonly string[], factory: LiveGphotoFactory = spawnLiveGphoto, options: LiveViewOptions = {}) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.child = factory([...args, "--quiet", "--capture-movie", "--stdout"]);
    ownedChildren.add(this.child);
    const grace = options.stopGraceMs ?? 3500;
    this.stopGraceMs = grace;
    this.killGraceMs = options.killGraceMs ?? 1000;
    const parser = new JpegFrameParser((frame) => {
      if (this.stopping || this.ended) return;
      this.latest = frame; // Drop every older frame instead of building a queue.
      clearTimeout(this.frameTimer);
      this.frameTimer = setTimeout(() => {
        void this.stop(new CameraError("Canon live preview stopped delivering frames. Stop and start preview to retry.", "camera_timeout", 504));
      }, options.frameTimeoutMs ?? 10_000);
      this.frameTimer.unref();
      if (!this.firstFrame) {
        this.firstFrame = true;
        clearTimeout(this.startupTimer);
        this.resolveReady(frame);
      }
    }, options.maxFrameBytes);
    this.startupTimer = setTimeout(() => {
      void this.stop(new CameraError("Canon live preview did not deliver a frame in time. Wake the camera and check its USB connection.", "camera_timeout", 504));
    }, options.startupMs ?? 20_000);
    this.startupTimer.unref();
    this.child.stdout.on("data", (bytes: Buffer) => {
      if (this.stopping || this.ended) return;
      try { parser.push(bytes); }
      catch (error) { void this.stop(error instanceof CameraError ? error : new CameraError("The live preview could not be decoded.", "invalid_camera_image", 422)); }
    });
    this.child.stderr.on("data", (bytes: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, bytes]).subarray(-8192);
    });
    this.child.stdout.on("error", () => { void this.stop(new CameraError("The live preview stream could not be read.", "camera_process", 503)); });
    this.child.stderr.on("error", () => { void this.stop(new CameraError("The camera diagnostic stream could not be read.", "camera_process", 503)); });
    this.child.once("error", (error: NodeJS.ErrnoException) => {
      void this.stop(new CameraError(error.code === "ENOENT" ? "gphoto2 could not be found. Install it or set GPHOTO2_PATH, then restart the app." : "The live camera process could not start.", error.code === "ENOENT" ? "gphoto_unavailable" : "camera_process", 503));
    });
    this.child.once("close", () => {
      this.ended = true;
      if (!this.stopping && !this.failure) {
        const detail = this.stderr.toString("utf8").trim().slice(-1500);
        const busy = /claim[^\r\n]*(?:USB|device|interface)|detach[^\r\n]*kernel|(?:camera|device)[^\r\n]*busy/i.test(detail);
        const timedOut = /PTP[^\r\n]*timeout|timeout[^\r\n]*(?:reading|writing|port)/i.test(detail);
        const ioFailure = /PTP[^\r\n]*I\/O|I\/O problem|Error (?:reading|writing) from the port/i.test(detail);
        this.failure = new CameraError(busy ? "Another app or the macOS camera import helper may be using the camera. Close Photos, Preview, Image Capture, and EOS Utility, then reconnect it." : timedOut ? "Canon live preview timed out over USB. Wake the camera and check its cable." : ioFailure ? "The camera's USB connection needs to be recovered. The kiosk will reset the connection and try again." : "Canon live preview ended. Start preview again to retry.", busy ? "camera_in_use" : timedOut ? "camera_timeout" : ioFailure ? "camera_io" : "camera_command", timedOut && !busy ? 504 : 503, detail || undefined);
      }
      clearTimeout(this.startupTimer);
      clearTimeout(this.frameTimer);
      clearTimeout(this.termTimer);
      clearTimeout(this.killTimer);
      parser.clear();
      ownedChildren.delete(this.child);
      if (!this.firstFrame) this.rejectReady(this.failure ?? new CameraError("Live preview was stopped.", "camera_cancelled", 499));
      this.resolveClosed();
    });
  }

  private stopGraceMs: number;
  private killGraceMs: number;

  stop(error?: CameraError): Promise<void> {
    if (this.ended || this.stopping) return this.closed;
    this.stopping = true;
    this.failure = error ?? null;
    clearTimeout(this.startupTimer);
    clearTimeout(this.frameTimer);
    this.child.kill("SIGINT");
    if (this.ended) return this.closed;
    this.termTimer = setTimeout(() => {
      this.child.kill("SIGTERM");
      this.killTimer = setTimeout(() => { this.child.kill("SIGKILL"); }, this.killGraceMs);
      this.killTimer.unref();
    }, this.stopGraceMs);
    this.termTimer.unref();
    return this.closed;
  }
}
