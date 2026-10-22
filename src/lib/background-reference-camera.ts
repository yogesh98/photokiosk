import type { BackgroundReference, KioskSettings } from "./kiosk-types";

export const BACKGROUND_REFERENCE_WIDTH = 768;
export const BACKGROUND_REFERENCE_HEIGHT = 512;
export const BACKGROUND_REFERENCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Version the geometry alongside camera settings so a changed crop invalidates a plate. */
export function getBackgroundReferenceCameraKey(camera: KioskSettings["camera"]): string {
  return JSON.stringify([
    "background-reference-v1", BACKGROUND_REFERENCE_WIDTH, BACKGROUND_REFERENCE_HEIGHT,
    camera.mode, camera.deviceId, camera.iso, camera.aperture, camera.shutterSpeed, camera.mirror,
  ]);
}

export function isBackgroundReferenceCompatible(
  reference: BackgroundReference | null | undefined,
  camera: KioskSettings["camera"],
): boolean {
  return Boolean(reference && reference.width === BACKGROUND_REFERENCE_WIDTH &&
    reference.height === BACKGROUND_REFERENCE_HEIGHT && reference.cameraKey === getBackgroundReferenceCameraKey(camera));
}

export function isBackgroundReference(value: unknown): value is BackgroundReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return typeof reference.id === "string" && BACKGROUND_REFERENCE_ID_PATTERN.test(reference.id) &&
    reference.url === `/api/ai/reference/${reference.id}` &&
    reference.width === BACKGROUND_REFERENCE_WIDTH && reference.height === BACKGROUND_REFERENCE_HEIGHT &&
    typeof reference.capturedAt === "string" && Number.isFinite(Date.parse(reference.capturedAt)) &&
    new Date(reference.capturedAt).toISOString() === reference.capturedAt &&
    typeof reference.cameraKey === "string" && reference.cameraKey.length > 0 && reference.cameraKey.length <= 2048 &&
    !reference.cameraKey.includes("\0");
}
