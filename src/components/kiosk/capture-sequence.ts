export type CapturePhoto = (signal?: AbortSignal) => Promise<string>;

export interface CaptureSequenceOptions {
  signal: AbortSignal;
  capture: CapturePhoto;
  preparePhoto?: (photoNumber: number, signal: AbortSignal) => Promise<void>;
  onCountdown: (seconds: number, photoNumber: number) => void;
  onPhoto: (photo: string, photoNumber: number) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException("Capture cancelled", "AbortError"));
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Capture cancelled", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function runCaptureSequence({
  signal,
  capture,
  preparePhoto,
  onCountdown,
  onPhoto,
  wait = abortableDelay,
}: CaptureSequenceOptions): Promise<string[]> {
  const photos: string[] = [];
  for (let photoNumber = 1; photoNumber <= 3; photoNumber++) {
    signal.throwIfAborted();
    await preparePhoto?.(photoNumber, signal);
    signal.throwIfAborted();
    for (let seconds = photoNumber === 1 ? 5 : 3; seconds > 0; seconds--) {
      signal.throwIfAborted();
      onCountdown(seconds, photoNumber);
      await wait(1000, signal);
    }
    signal.throwIfAborted();
    onCountdown(0, photoNumber);
    const photo = await capture(signal);
    signal.throwIfAborted();
    photos.push(photo);
    onPhoto(photo, photoNumber);
  }
  return photos;
}

export interface CaptureReadiness {
  capture: CapturePhoto | null;
  backgroundUrl?: string;
  error?: string | null;
}

/** Wait for the requested scene's first complete preview, not the previous scene. */
export async function waitForCaptureScene(
  read: () => CaptureReadiness,
  backgroundUrl: string | undefined,
  signal: AbortSignal,
  wait = abortableDelay,
): Promise<CapturePhoto> {
  for (let elapsed = 0; elapsed < 30_000; elapsed += 50) {
    signal.throwIfAborted();
    const current = read();
    if (current.error) throw new Error(current.error);
    if (current.capture && current.backgroundUrl === backgroundUrl) return current.capture;
    await wait(50, signal);
  }
  throw new Error("The next photo's background could not be prepared. Please retry the preview.");
}
