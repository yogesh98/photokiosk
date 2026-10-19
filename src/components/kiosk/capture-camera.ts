/** Wait for live view to release the camera, while allowing the guest to cancel. */
async function waitForPreview(
  preview: Promise<unknown> | null,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!preview) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    // A failed preview must not prevent a fresh high-resolution capture attempt.
    void preview
      .catch(() => {})
      .then(() => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve();
      });
  });
}

export async function requestCanonPhoto(
  signal: AbortSignal,
  preview: Promise<unknown> | null,
  request: typeof fetch = fetch,
): Promise<Blob> {
  await waitForPreview(preview, signal);
  signal.throwIfAborted();
  const response = await request("/api/camera/capture", {
    method: "POST",
    signal,
  });
  signal.throwIfAborted();
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      body?.error ||
        "The Canon could not take a photo. Please check the camera and try again.",
    );
  }
  const photo = await response.blob();
  signal.throwIfAborted();
  return photo;
}
