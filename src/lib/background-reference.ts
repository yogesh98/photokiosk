import sharp from "sharp";
import { BACKGROUND_REFERENCE_HEIGHT, BACKGROUND_REFERENCE_WIDTH } from "./background-reference-camera";

export const MAX_BACKGROUND_REFERENCE_BYTES = 3 * 1024 * 1024;
export const MAX_BACKGROUND_REFERENCE_BODY_BYTES = MAX_BACKGROUND_REFERENCE_BYTES + 64 * 1024;

export class BackgroundReferenceImageError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

/** A reference must already have the same crop and mirroring as model frames. */
export async function normalizeBackgroundReference(file: File): Promise<Buffer> {
  if (!file.size || file.size > MAX_BACKGROUND_REFERENCE_BYTES) {
    throw new BackgroundReferenceImageError("Capture a reference image smaller than 3 MB.", file.size ? 413 : 400);
  }
  try {
    const image = sharp(new Uint8Array(await file.arrayBuffer()), {
      limitInputPixels: BACKGROUND_REFERENCE_WIDTH * BACKGROUND_REFERENCE_HEIGHT,
      animated: false,
    });
    const metadata = await image.metadata();
    if (metadata.format !== "png" || metadata.width !== BACKGROUND_REFERENCE_WIDTH ||
      metadata.height !== BACKGROUND_REFERENCE_HEIGHT || (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation !== undefined && metadata.orientation !== 1)) throw new Error("format");
    // Re-encode raw RGB and strip metadata. Never resize, crop, or mirror a
    // plate here: its pixels must align with the frozen camera frame.
    return await image.removeAlpha().toColorspace("srgb").png().toBuffer();
  } catch {
    throw new BackgroundReferenceImageError(`Capture a valid ${BACKGROUND_REFERENCE_WIDTH} × ${BACKGROUND_REFERENCE_HEIGHT} PNG reference image.`);
  }
}
