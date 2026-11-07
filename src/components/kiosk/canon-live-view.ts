import { abortableDelay } from "./capture-sequence";

type LiveViewOptions = {
  request?: typeof fetch;
  onFrame: (frame: Blob, signal: AbortSignal) => Promise<void> | void;
  /** `retrying` is true only when automatic recovery will start a new session. */
  onError: (error: unknown, state: { retrying: boolean }) => void;
  reconnect?: {
    allowed: () => boolean;
    wait?: (attempt: number, signal: AbortSignal) => Promise<void>;
  };
  /** How long the stream may go silent before it is treated as broken. */
  stallMs?: number;
};

class LiveViewRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

const RETRYABLE_STATUS = (status: number) => [408, 409, 410, 429].includes(status) || status >= 500;

async function fail(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  throw new LiveViewRequestError(
    body?.error || "The Canon live preview stopped. Check the camera, then start preview again when ready.",
    RETRYABLE_STATUS(response.status),
  );
}

/** The frame number the server puts on a stream's final JSON error chunk. */
export const LIVE_STREAM_ERROR_SEQ = 0xffffffff;

export interface LiveStreamFrame {
  seq: number;
  bytes: Uint8Array;
}

/**
 * Splits the live stream's chunks (4-byte length, 4-byte frame number, then
 * the JPEG) back into frames, whatever byte boundaries the network delivers.
 */
export function createLiveStreamParser() {
  let buffer: Uint8Array = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): LiveStreamFrame[] {
      if (buffer.byteLength === 0) buffer = chunk;
      else {
        const joined = new Uint8Array(buffer.byteLength + chunk.byteLength);
        joined.set(buffer, 0);
        joined.set(chunk, buffer.byteLength);
        buffer = joined;
      }
      const frames: LiveStreamFrame[] = [];
      let offset = 0;
      while (buffer.byteLength - offset >= 8) {
        const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
        const length = view.getUint32(0);
        const seq = view.getUint32(4);
        if (buffer.byteLength - offset - 8 < length) break;
        frames.push({ seq, bytes: buffer.slice(offset + 8, offset + 8 + length) });
        offset += 8 + length;
      }
      buffer = offset ? buffer.slice(offset) : buffer;
      return frames;
    },
  };
}

const NOT_YET = Symbol("not yet");
/** Lets reads of chunks the browser already holds resolve before giving up on them. */
const settleSoon = () => new Promise<typeof NOT_YET>((resolve) => setTimeout(() => resolve(NOT_YET), 0));

/** The caller starts hardware; optional kiosk recovery acquires a fresh session. */
export function createCanonLiveView({ request = fetch, onFrame, onError, reconnect, stallMs = 15000 }: LiveViewOptions) {
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
          let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
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
            const stream = await request(`/api/camera/live/stream?id=${encodeURIComponent(liveId)}`, {
              cache: "no-store",
              signal: current.signal,
            });
            if (!stream.ok) await fail(stream);
            if (!stream.body) throw new LiveViewRequestError("The Canon live preview stream could not be read.", true);
            reader = stream.body.getReader();
            const parser = createLiveStreamParser();
            const read = () => {
              const next = reader!.read();
              const stall = abortableDelay(stallMs, current.signal).then(() => {
                throw new LiveViewRequestError("The Canon live preview stopped delivering frames. Reconnecting…", true);
              });
              const result = Promise.race([next, stall]);
              // Whichever settles later, or a read orphaned by an error, must not
              // surface as an unhandled rejection; the race already reports it.
              for (const promise of [next, stall, result]) promise.catch(() => {});
              return result;
            };
            let reading = read();
            let frames: LiveStreamFrame[] = [];
            while (!current.signal.aborted) {
              let ended = false;
              const take = (chunk: ReadableStreamReadResult<Uint8Array>) => {
                if (chunk.done) { ended = true; return; }
                frames.push(...parser.push(chunk.value));
                reading = read();
              };
              let chunk = await Promise.race([reading, Promise.resolve(NOT_YET)]);
              if (chunk === NOT_YET) take(await reading);
              else {
                // The last frame took longer than a frame interval, so chunks
                // have queued up. Drain them all and show only the newest.
                while (chunk !== NOT_YET && !ended) {
                  take(chunk);
                  chunk = await Promise.race([reading, settleSoon()]);
                }
              }
              // A stream that closes right after its error chunk must report
              // that error, not the closing, so pending frames come first.
              if (!frames.length) {
                if (ended) throw new LiveViewRequestError("The Canon live preview stream ended. Reconnecting…", true);
                continue;
              }
              const frame = frames[frames.length - 1];
              frames = [];
              if (frame.seq === LIVE_STREAM_ERROR_SEQ) {
                let failure: { error?: string; status?: number } | null = null;
                try { failure = JSON.parse(new TextDecoder().decode(frame.bytes)); } catch { failure = null; }
                throw new LiveViewRequestError(
                  failure?.error || "The Canon live preview stopped. Check the camera, then start preview again when ready.",
                  RETRYABLE_STATUS(Number(failure?.status) || 503),
                );
              }
              current.signal.throwIfAborted();
              retryable = false;
              await onFrame(new Blob([frame.bytes as BlobPart], { type: "image/jpeg" }), current.signal);
              retryable = true;
              current.signal.throwIfAborted();
              attempt = 0;
              resolveReady();
            }
          } catch (error) {
            retry = !current.signal.aborted && retryable &&
              (!(error instanceof LiveViewRequestError) || error.retryable) && Boolean(reconnect?.allowed());
            if (!retry) rejectReady(error);
            if (!current.signal.aborted) onError(error, { retrying: retry });
          } finally {
            if (reader) await reader.cancel().catch(() => {});
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
