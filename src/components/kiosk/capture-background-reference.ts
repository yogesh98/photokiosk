import { drawCover } from "@/lib/chroma-key";
import { BACKGROUND_REFERENCE_HEIGHT, BACKGROUND_REFERENCE_WIDTH } from "@/lib/background-reference-camera";

/** Freeze the raw camera frame before asynchronous PNG encoding can advance it. */
export function captureBackgroundReference(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  mirror: boolean,
): Promise<Blob> {
  if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error("Wait for the camera frame before capturing an empty background.");
  const canvas = document.createElement("canvas");
  canvas.width = BACKGROUND_REFERENCE_WIDTH;
  canvas.height = BACKGROUND_REFERENCE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not prepare the empty background.");
  context.save();
  if (mirror) {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  drawCover(context, source, sourceWidth, sourceHeight, canvas.width, canvas.height);
  context.restore();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Your browser could not encode the empty background. Try capturing it again."));
    }, "image/png");
  });
}
