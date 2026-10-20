export interface CanonCaptureOptions<T> {
  signal: AbortSignal;
  hasNextPhoto: boolean;
  isCurrent: () => boolean;
  stopLiveView: () => Promise<void>;
  capture: (signal: AbortSignal) => Promise<T>;
  startLiveView: () => void;
  waitUntilReady: (signal: AbortSignal) => Promise<void>;
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      void operation.catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Callbacks belong to one transport and one guest; start does not await stream lifetime. */
export async function captureCanonWithLiveView<T>({
  signal,
  hasNextPhoto,
  isCurrent,
  stopLiveView,
  capture,
  startLiveView,
  waitUntilReady,
}: CanonCaptureOptions<T>): Promise<T> {
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException("The photo session is no longer active.", "AbortError");
  };

  assertCurrent();
  await waitForOperation(stopLiveView(), signal);
  assertCurrent();
  const photo = await waitForOperation(capture(signal), signal);
  assertCurrent();
  if (!hasNextPhoto) return photo;

  // A partly started stream must also stop if starting or readiness fails.
  try {
    startLiveView();
    assertCurrent();
    await waitForOperation(waitUntilReady(signal), signal);
    assertCurrent();
  } catch (error) {
    try {
      await stopLiveView();
    } catch {
      // Preserve the capture/readiness error while transport cleanup uses its own lease.
    }
    throw error;
  }
  return photo;
}
