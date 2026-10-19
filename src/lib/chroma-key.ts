import type { KioskSettings } from "./kiosk-types";

type ChromaSettings = KioskSettings["chroma"];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

/** Key in chroma space, so a shadow on a green screen is still transparent. */
export function applyChromaKey(
  pixels: Uint8ClampedArray,
  settings: ChromaSettings,
): void {
  if (!settings.enabled) return;
  const threshold = clamp(settings.similarity, 0.01, 0.8);
  const softness = clamp(settings.smoothness, 0.005, 0.5);
  const spill = clamp(settings.spill);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    // Leave neutral, skin, and non-green pixels untouched.
    if (g <= r || g <= b) continue;
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    const distance = Math.hypot(cb + 84.47232, cr + 106.76544) / 255;
    const edge = clamp((distance - threshold) / softness);
    const alpha = edge * edge * (3 - 2 * edge);
    pixels[i + 3] = Math.round(pixels[i + 3] * alpha);
    pixels[i + 1] = Math.round(
      g - (g - Math.max(r, b)) * spill * (1 - alpha * 0.5),
    );
  }
}

/** Draw with the same crop in preview and final output, regardless of camera aspect ratio. */
export function drawCover(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): void {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    source,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}
