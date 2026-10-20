import { applyChromaKey, drawCover } from "./chroma-key";
import type { KioskSettings } from "./kiosk-types";
import type { PersonSegmenter } from "./person-segmentation";

/** Soft confidence edges preserve hair without making the whole person translucent. */
export function personMaskPixels(
  confidence: Float32Array,
  kind: "confidence" | "alpha" = "confidence",
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(confidence.length * 4);
  for (let index = 0; index < confidence.length; index++) {
    const value = confidence[index];
    const edge = Number.isFinite(value)
      ? Math.min(1, Math.max(0, kind === "alpha" ? value : (value - 0.1) / 0.8))
      : 0;
    // Matting models predict opacity directly; thresholding would destroy fine hair.
    const alpha = kind === "alpha" ? edge : edge * edge * (3 - 2 * edge);
    pixels[index * 4 + 3] = Math.round(alpha * 255);
  }
  return pixels;
}

interface CompositeOptions {
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  output: HTMLCanvasElement;
  width: number;
  settings: KioskSettings;
  background: HTMLImageElement | null;
  segmenter: PersonSegmenter | null;
  signal: AbortSignal;
}

/** One compositor per serial render loop; captures use their own scratch canvases. */
export function createBackgroundCompositor() {
  const foreground = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  return async function composite({
    source, sourceWidth, sourceHeight, output, width, settings,
    background, segmenter, signal,
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
    // Freeze the precise frame, crop and mirror before any asynchronous inference.
    drawCover(foregroundContext, source, sourceWidth, sourceHeight, width, height);
    foregroundContext.restore();
    if (settings.backgroundMode === "green-screen") {
      const pixels = foregroundContext.getImageData(0, 0, width, height);
      applyChromaKey(pixels.data, { ...settings.chroma, enabled: true });
      foregroundContext.putImageData(pixels, 0, 0);
    } else if (settings.backgroundMode === "ai") {
      if (!segmenter) throw new Error("AI background removal is still loading. Please wait.");
      const mask = await segmenter.segment(foreground, signal);
      signal.throwIfAborted();
      if (!mask.width || !mask.height || mask.confidence.length !== mask.width * mask.height)
        throw new Error("AI background removal returned an invalid mask. Try the preview again.");
      maskCanvas.width = mask.width;
      maskCanvas.height = mask.height;
      const maskContext = maskCanvas.getContext("2d");
      if (!maskContext) throw new Error("Your browser could not prepare the AI mask.");
      const maskImage = maskContext.createImageData(mask.width, mask.height);
      maskImage.data.set(personMaskPixels(mask.confidence, mask.kind));
      maskContext.putImageData(maskImage, 0, 0);
      foregroundContext.save();
      foregroundContext.globalCompositeOperation = "destination-in";
      foregroundContext.imageSmoothingEnabled = true;
      foregroundContext.imageSmoothingQuality = "high";
      foregroundContext.drawImage(maskCanvas, 0, 0, width, height);
      foregroundContext.restore();
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
