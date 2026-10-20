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

export function recognizedCameraError(error: unknown): CameraError | null {
  if (error instanceof CameraError) return error;
  // Dev reloads can leave the global controller holding an older CameraError
  // constructor. Validate its fields rather than losing the useful USB error
  // merely because the route was compiled with a different class identity.
  if (!error || typeof error !== "object") return null;
  const candidate = error as Record<string, unknown>;
  if (
    candidate.name !== "CameraError" ||
    typeof candidate.message !== "string" || !candidate.message || candidate.message.length > 1000 ||
    typeof candidate.code !== "string" || ![
      "camera_error", "camera_cancelled", "camera_timeout", "gphoto_unavailable",
      "camera_process", "camera_in_use", "camera_command", "camera_busy",
      "camera_disconnected", "camera_ambiguous", "camera_configuration",
      "invalid_configuration", "invalid_camera_image", "jpeg_required", "camera_live_expired",
    ].includes(candidate.code) ||
    typeof candidate.status !== "number" || ![400, 409, 410, 422, 499, 503, 504].includes(candidate.status) ||
    (candidate.details !== undefined && (typeof candidate.details !== "string" || candidate.details.length > 2000))
  ) return null;
  return new CameraError(candidate.message, candidate.code, candidate.status, candidate.details as string | undefined);
}
