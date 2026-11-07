import { applyChromaKey, drawCover } from "./chroma-key";
import type { KioskSettings } from "./kiosk-types";
import { createWebGLCompositor, type WebGLCompositor } from "./webgl-compositor";

interface CompositeOptions {
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  output: HTMLCanvasElement;
  width: number;
  settings: KioskSettings;
  background: HTMLImageElement | null;
  /** Drawn over the finished photo, stretched to fill its 3:2 frame. */
  overlay?: HTMLImageElement | null;
  signal: AbortSignal;
}

export type BackgroundCompositor = (options: CompositeOptions) => Promise<void>;

/** Which renderer an output canvas ended up with, for diagnostics. */
export type CompositorKind = "webgl" | "canvas2d";

// A canvas keeps the first kind of context it hands out, so the choice is
// remembered per output canvas and never retried against it.
const renderers = new WeakMap<HTMLCanvasElement, WebGLCompositor | null>();

export function compositorKind(output: HTMLCanvasElement): CompositorKind {
  return renderers.get(output) ? "webgl" : "canvas2d";
}

function webglFor(output: HTMLCanvasElement): WebGLCompositor | null {
  if (!renderers.has(output)) renderers.set(output, createWebGLCompositor(output));
  return renderers.get(output) ?? null;
}

/**
 * One compositor per serial render loop; captures use their own scratch
 * canvases. Keying runs on the GPU when WebGL is available and falls back to
 * the 2D canvas otherwise, with identical output.
 */
export function createBackgroundCompositor(): BackgroundCompositor {
  // The 2D fallback's scratch canvas; unused while WebGL draws.
  const foreground = document.createElement("canvas");
  return async function composite(options: CompositeOptions): Promise<void> {
    const { signal, output, width } = options;
    signal.throwIfAborted();
    const height = Math.round(width * 2 / 3);
    const gpu = webglFor(output);
    if (gpu) {
      const drawn = gpu.draw({
        source: options.source as TexImageSource,
        sourceWidth: options.sourceWidth,
        sourceHeight: options.sourceHeight,
        width,
        height,
        settings: options.settings,
        background: options.background,
        overlay: options.overlay,
      });
      if (drawn) return;
      // The GPU context is lost for the moment; the browser restores it later.
      throw new DOMException("The preview renderer is restarting.", "AbortError");
    }
    composite2d(foreground, height, options);
  };
}

function composite2d(
  foreground: HTMLCanvasElement,
  height: number,
  { source, sourceWidth, sourceHeight, output, width, settings, background, overlay, signal }: CompositeOptions,
): void {
  if (foreground.width !== width || foreground.height !== height) {
    foreground.width = width;
    foreground.height = height;
  }
  const foregroundContext = foreground.getContext("2d", { willReadFrequently: true });
  if (!foregroundContext) throw new Error("Your browser could not process the photo.");
  foregroundContext.clearRect(0, 0, width, height);
  foregroundContext.save();
  if (settings.camera.mirror) {
    foregroundContext.translate(width, 0);
    foregroundContext.scale(-1, 1);
  }
  // Freeze the precise frame, crop and mirror before keying.
  drawCover(foregroundContext, source, sourceWidth, sourceHeight, width, height);
  foregroundContext.restore();
  if (settings.backgroundMode === "green-screen") {
    const pixels = foregroundContext.getImageData(0, 0, width, height);
    applyChromaKey(pixels.data, { ...settings.chroma, enabled: true });
    foregroundContext.putImageData(pixels, 0, 0);
  }
  signal.throwIfAborted();
  // Publish only complete frames. Cancellation never puts an unfinished photo on screen.
  if (output.width !== width || output.height !== height) {
    output.width = width;
    output.height = height;
  }
  const context = output.getContext("2d");
  if (!context) throw new Error("Your browser could not prepare the photo canvas.");
  context.fillStyle = "#e9e5dc";
  context.fillRect(0, 0, width, height);
  if (background && settings.backgroundMode !== "off")
    drawCover(context, background, background.naturalWidth, background.naturalHeight, width, height);
  context.drawImage(foreground, 0, 0);
  // Never mirrored, so the overlay's text and logos read correctly.
  if (overlay) context.drawImage(overlay, 0, 0, width, height);
}
