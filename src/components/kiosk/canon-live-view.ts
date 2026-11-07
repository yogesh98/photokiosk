import { abortableDelay } from "./capture-sequence";

type LiveViewOptions = {
  request?: typeof fetch;
  onFrame: (frame: Blob, signal: AbortSignal) => Promise<void> | void;
  /** `retrying` is true only when automatic recovery will start a new session. */
  onError: (error: unknown, state: { retrying: boolean }) => void;
  wait?: (signal: AbortSignal) => Promise<void>;
  reconnect?: {
    allowed: () => boolean;
    wait?: (attempt: number, signal: AbortSignal) => Promise<void>;
  };
};

class LiveViewRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function fail(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  throw new LiveViewRequestError(
    body?.error || "The Canon live preview stopped. Check the camera, then start preview again when ready.",
    [408, 409, 410, 429].includes(response.status) || response.status >= 500,
  );
}

// The camera streams 30 fps. The server holds each request until a newer frame
// exists, so this only caps how much keying work the kiosk's CPU takes on.
const PREVIEW_FRAME_INTERVAL_MS = 1000 / 15;

function createFramePacer(intervalMs = PREVIEW_FRAME_INTERVAL_MS) {
  let last = 0;
  return (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const delay = Math.max(0, intervalMs - (performance.now() - last));
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      last = performance.now();
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The caller starts hardware; optional kiosk recovery acquires a fresh session. */
export function createCanonLiveView({ request = fetch, onFrame, onError, wait = createFramePacer(), reconnect }: LiveViewOptions) {
  let controller: AbortController | null = null;
  let flight: Promise<void> | null = null;
  let readiness: Promise<void> | null = null;

  function start(signal?: AbortSignal): Promise<void> {
    if (flight) return flight;
    const current = new AbortController();
    controller = current;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    readiness = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Explicit starts need not await readiness, but sequence resumes do.
    void readiness.catch(() => {});
    const abort = () => current.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    flight = (async () => {
      let attempt = 0;
      try {
        await Promise.resolve();
        while (!current.signal.aborted) {
          let id: string | undefined;
          let retryable = true;
          let retry = false;
          try {
            const response = await request("/api/camera/live", {
              method: "POST",
              signal: current.signal,
            });
            if (!response.ok) await fail(response);
            const body = await response.json();
            if (typeof body?.id !== "string" || !body.id) throw new LiveViewRequestError("The Canon live preview could not be started.", false);
            const liveId: string = body.id;
            id = liveId;
            current.signal.throwIfAborted();
            let seq = -1;
            while (!current.signal.aborted) {
              const frame = await request(`/api/camera/live?id=${encodeURIComponent(liveId)}&after=${seq}`, {
                cache: "no-store",
                signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]),
              });
              if (!frame.ok) await fail(frame);
              const frameSeq = Number(frame.headers.get("X-Frame-Seq"));
              if (Number.isSafeInteger(frameSeq)) seq = frameSeq;
              const blob = await frame.blob();
              current.signal.throwIfAborted();
              retryable = false;
              await onFrame(blob, current.signal);
              retryable = true;
              current.signal.throwIfAborted();
              attempt = 0;
              resolveReady();
              await wait(current.signal);
            }
          } catch (error) {
            retry = !current.signal.aborted && retryable &&
              (!(error instanceof LiveViewRequestError) || error.retryable) && Boolean(reconnect?.allowed());
            if (!retry) rejectReady(error);
            if (!current.signal.aborted) onError(error, { retrying: retry });
          } finally {
            if (id) {
              try {
                await request("/api/camera/live", {
                  method: "DELETE", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id }), signal: AbortSignal.timeout(5000),
                });
              } catch {
                // The server's short lease also releases a disconnected client.
              }
            }
          }
          if (!retry || current.signal.aborted) break;
          attempt++;
          if (reconnect?.wait) await reconnect.wait(attempt, current.signal);
          else await abortableDelay(Math.min(15000, 1000 * 2 ** Math.min(attempt - 1, 4)), current.signal);
          current.signal.throwIfAborted();
          if (!reconnect?.allowed()) break;
        }
      } catch (error) {
        rejectReady(error);
        if (!current.signal.aborted) onError(error, { retrying: false });
      } finally {
        rejectReady(current.signal.reason || new Error("Canon live preview ended before it was ready."));
        signal?.removeEventListener("abort", abort);
        if (controller === current) controller = null;
        flight = null;
      }
    })();
    return flight;
  }

  async function stop() {
    controller?.abort();
    await flight;
  }

  function whenReady(): Promise<void> {
    return readiness ?? Promise.reject(new Error("Start Canon live preview before waiting for a frame."));
  }

  return { start, stop, whenReady };
}
