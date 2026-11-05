import { applyChromaKey, drawCover } from "./chroma-key";
import type { KioskSettings } from "./kiosk-types";

interface CompositeOptions {
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  output: HTMLCanvasElement;
  width: number;
  settings: KioskSettings;
  background: HTMLImageElement | null;
  signal: AbortSignal;
}

/** One compositor per serial render loop; captures use their own scratch canvases. */
export function createBackgroundCompositor() {
  const foreground = document.createElement("canvas");
  return async function composite({
    source, sourceWidth, sourceHeight, output, width, settings,
    background, signal,
  }: CompositeOptions): Promise<void> {
    signal.throwIfAborted();
    const height = Math.round(width * 2 / 3);
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
  };
}
