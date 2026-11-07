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

export type GphotoFailureKind = "release" | "busy" | "timeout" | "io" | "other";

/**
 * Classify gphoto2 diagnostics for still commands and the live stream alike.
 * USB ownership problems take priority over the timeouts they often cause:
 * another app's claim must never trigger a USB reset.
 */
export function classifyGphotoFailure(diagnostic: string): GphotoFailureKind {
  // The camera refused the shutter (One-Shot AF found no focus, or the body
  // could not release yet), so no photo was taken. Canon reports some of these
  // as "PTP Device Busy", which must not be mistaken for another app's claim.
  if (/Perhaps no focus|failed to release|(?:Half|Full)-Press failed/i.test(diagnostic))
    return "release";
  if (
    /could not\s+(?:claim\b|detach\s+(?:the\s+)?kernel\s+driver)|claim[^\r\n]*(?:USB|device|interface)|detach[^\r\n]*kernel|(?:camera|device)[^\r\n]*busy|PTP[^\r\n]*busy/i.test(
      diagnostic,
    )
  )
    return "busy";
  if (/PTP[^\r\n]*(?:timeout|timed out)|(?:timeout|timed out)[^\r\n]*(?:reading|writing|port)/i.test(diagnostic))
    return "timeout";
  if (/PTP[^\r\n]*I\/O|I\/O problem|Error (?:reading|writing) from the port/i.test(diagnostic))
    return "io";
  return "other";
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
      "camera_process", "camera_in_use", "camera_command", "camera_busy", "camera_io",
      "camera_disconnected", "camera_ambiguous", "camera_configuration", "camera_release",
      "invalid_configuration", "invalid_camera_image", "jpeg_required", "camera_live_expired",
    ].includes(candidate.code) ||
    typeof candidate.status !== "number" || ![400, 409, 410, 422, 499, 503, 504].includes(candidate.status) ||
    (candidate.details !== undefined && (typeof candidate.details !== "string" || candidate.details.length > 2000))
  ) return null;
  return new CameraError(candidate.message, candidate.code, candidate.status, candidate.details as string | undefined);
}
