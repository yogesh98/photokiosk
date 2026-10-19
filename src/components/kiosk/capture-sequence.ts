export type CapturePhoto = (signal?: AbortSignal) => Promise<string>;

export interface CaptureSequenceOptions {
  signal: AbortSignal;
  capture: CapturePhoto;
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
  onCountdown,
  onPhoto,
  wait = abortableDelay,
}: CaptureSequenceOptions): Promise<string[]> {
  const photos: string[] = [];
  for (let photoNumber = 1; photoNumber <= 3; photoNumber++) {
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
