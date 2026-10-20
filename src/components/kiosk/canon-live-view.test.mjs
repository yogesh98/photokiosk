import test from "node:test";
import assert from "node:assert/strict";
import { createCanonLiveView } from "./canon-live-view.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function jpeg(value = "synthetic preview frame") {
  return new Response(value, { headers: { "Content-Type": "image/jpeg" } });
}

test("creating or stopping Canon live view performs no request", { timeout: 2000 }, async () => {
  const calls = [];
  const preview = createCanonLiveView({
    request: async (...args) => { calls.push(args); return jpeg(); },
    onFrame: () => assert.fail("An inactive preview cannot publish a frame."),
    onError: () => assert.fail("An inactive preview cannot report a camera error."),
    wait: waitForAbort,
  });
  await nextTurn();
  await preview.stop();
  await nextTurn();
  assert.deepEqual(calls, []);
});

test("one explicit start reads multiple cached frames and shares one active promise", { timeout: 2000 }, async () => {
  const id = "synthetic preview/A";
  const calls = [];
  const frames = [];
  const readSignals = [];
  const errors = [];
  const threeFrames = deferred();
  let sourceSignal;
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push({ url, method, options });
      if (method === "POST") {
        sourceSignal = options.signal;
        return Response.json({ id });
      }
      if (method === "GET") {
        assert.equal(url, `/api/camera/live?id=${encodeURIComponent(id)}`);
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.signal.aborted, false);
        readSignals.push(options.signal);
        return jpeg(`frame ${frames.length + 1}`);
      }
      assert.equal(method, "DELETE");
      assert.deepEqual(JSON.parse(options.body), { id });
      assert.notEqual(options.signal, sourceSignal);
      assert.equal(sourceSignal.aborted, true);
      assert.equal(options.signal.aborted, false);
      return Response.json({ stopped: true });
    },
    onFrame: async (blob, signal) => {
      assert.equal(signal, sourceSignal);
      assert.equal(signal.aborted, false);
      frames.push(await blob.text());
      if (frames.length === 3) threeFrames.resolve();
    },
    onError: (error) => errors.push(error),
    wait: (signal) => frames.length < 3 ? Promise.resolve() : waitForAbort(signal),
  });
  const running = preview.start();
  assert.equal(preview.start(), running);
  await threeFrames.promise;
  await preview.stop();
  await running;
  assert.deepEqual(frames, ["frame 1", "frame 2", "frame 3"]);
  assert.ok(readSignals.every((signal) => signal.aborted));
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "GET", "GET", "DELETE"]);
  assert.ok(calls.every(({ url }) => url === "/api/camera/live" || url.startsWith("/api/camera/live?id=")));
  assert.deepEqual(errors, []);
});

test("stop waits for an in-flight cached GET and discards its late frame before cleanup", { timeout: 2000 }, async () => {
  const getStarted = deferred();
  const lateResponse = deferred();
  const calls = [];
  const errors = [];
  let sourceSignal;
  let frames = 0;
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push(method);
      if (method === "POST") return Response.json({ id: "pending-get" });
      if (method === "GET") {
        sourceSignal = options.signal;
        getStarted.resolve();
        return lateResponse.promise;
      }
      assert.equal(sourceSignal.aborted, true);
      return Response.json({ stopped: true });
    },
    onFrame: () => { frames++; },
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const running = preview.start();
  await getStarted.promise;
  const stopping = preview.stop();
  await nextTurn();
  assert.equal(sourceSignal.aborted, true);
  assert.deepEqual(calls, ["POST", "GET"]);
  lateResponse.resolve(jpeg("discard this cancelled frame"));
  await stopping;
  await running;
  assert.equal(frames, 0);
  assert.deepEqual(calls, ["POST", "GET", "DELETE"]);
  assert.deepEqual(errors, []);
});

test("stop waits for frame processing to settle before deleting the live view", { timeout: 2000 }, async () => {
  const processing = deferred();
  const finishProcessing = deferred();
  const calls = [];
  const errors = [];
  let frameSignal;
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push(method);
      if (method === "POST") return Response.json({ id: "processing-frame" });
      return method === "GET" ? jpeg() : Response.json({ stopped: true });
    },
    onFrame: async (blob, signal) => {
      frameSignal = signal;
      processing.resolve();
      await finishProcessing.promise;
    },
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const running = preview.start();
  await processing.promise;
  const stopping = preview.stop();
  await nextTurn();
  assert.equal(frameSignal.aborted, true);
  assert.deepEqual(calls, ["POST", "GET"]);
  finishProcessing.resolve();
  await stopping;
  await running;
  assert.deepEqual(calls, ["POST", "GET", "DELETE"]);
  assert.deepEqual(errors, []);
});

test("cancelling before a late start JSON response still deletes the received live-view ID", { timeout: 2000 }, async () => {
  const jsonStarted = deferred();
  const lateJson = deferred();
  const calls = [];
  const errors = [];
  let sourceSignal;
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push(method);
      if (method === "POST") {
        sourceSignal = options.signal;
        return {
          ok: true,
          json: async () => { jsonStarted.resolve(); return lateJson.promise; },
        };
      }
      assert.equal(method, "DELETE");
      assert.deepEqual(JSON.parse(options.body), { id: "late-start-id" });
      assert.notEqual(options.signal, sourceSignal);
      assert.equal(options.signal.aborted, false);
      return Response.json({ stopped: true });
    },
    onFrame: () => assert.fail("A cancelled start cannot publish a frame."),
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const running = preview.start();
  await jsonStarted.promise;
  const stopping = preview.stop();
  await nextTurn();
  assert.equal(sourceSignal.aborted, true);
  assert.deepEqual(calls, ["POST"]);
  lateJson.resolve({ id: "late-start-id" });
  await stopping;
  await running;
  assert.deepEqual(calls, ["POST", "DELETE"]);
  assert.deepEqual(errors, []);
});

test("a start during pending cleanup cannot start another process or replace the old ID", { timeout: 2000 }, async () => {
  const frameReceived = deferred();
  const cleanupStarted = deferred();
  const finishCleanup = deferred();
  const calls = [];
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push(method);
      if (method === "POST") return Response.json({ id: "cleanup-still-pending" });
      if (method === "GET") return jpeg();
      assert.deepEqual(JSON.parse(options.body), { id: "cleanup-still-pending" });
      cleanupStarted.resolve();
      await finishCleanup.promise;
      return Response.json({ stopped: true });
    },
    onFrame: () => frameReceived.resolve(),
    onError: () => assert.fail("Stopping live view intentionally cannot report an error."),
    wait: waitForAbort,
  });
  const running = preview.start();
  await frameReceived.promise;
  const stopping = preview.stop();
  await cleanupStarted.promise;
  assert.equal(preview.start(), running);
  assert.deepEqual(calls, ["POST", "GET", "DELETE"]);
  finishCleanup.resolve();
  await stopping;
  await running;
});

for (const failure of ["start-network", "start-http", "frame-http", "frame-processing"]) {
  test(`${failure} failure reports once and makes no automatic restart`, { timeout: 2000 }, async () => {
    const calls = [];
    const errors = [];
    const message = `SYNTHETIC TEST ${failure} failure`;
    const preview = createCanonLiveView({
      request: async (url, options = {}) => {
        const method = options.method || "GET";
        calls.push(method);
        if (method === "POST") {
          if (failure === "start-network") throw new Error(message);
          if (failure === "start-http") return Response.json({ error: message }, { status: 503 });
          return Response.json({ id: "failed-preview" });
        }
        if (method === "GET") {
          if (failure === "frame-http") return Response.json({ error: message }, { status: 503 });
          return jpeg();
        }
        return Response.json({ stopped: true });
      },
      onFrame: () => { throw new Error(message); },
      onError: (error) => errors.push(error),
      wait: waitForAbort,
    });
    await preview.start();
    await nextTurn();
    await nextTurn();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, new RegExp(message));
    assert.deepEqual(calls, failure.startsWith("start-") ? ["POST"] : ["POST", "GET", "DELETE"]);
    await preview.stop();
    assert.equal(errors.length, 1);
  });
}

test("an explicit restart uses a new ID and never reuses a previous preview's cleanup", { timeout: 2000 }, async () => {
  const calls = [];
  const errors = [];
  const received = [deferred(), deferred()];
  let starts = 0;
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push({ url, method, body: options.body });
      if (method === "POST") return Response.json({ id: `preview-${++starts}` });
      if (method === "GET") return jpeg(url);
      return Response.json({ stopped: true });
    },
    onFrame: async (blob) => {
      assert.equal(await blob.text(), `/api/camera/live?id=preview-${starts}`);
      received[starts - 1].resolve();
    },
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const first = preview.start();
  await received[0].promise;
  await preview.stop();
  await first;
  const second = preview.start();
  assert.notEqual(first, second);
  await received[1].promise;
  await preview.stop();
  await second;
  assert.deepEqual(calls.filter(({ method }) => method === "GET").map(({ url }) => url), [
    "/api/camera/live?id=preview-1", "/api/camera/live?id=preview-2",
  ]);
  assert.deepEqual(calls.filter(({ method }) => method === "DELETE").map(({ body }) => JSON.parse(body)), [
    { id: "preview-1" }, { id: "preview-2" },
  ]);
  assert.equal(starts, 2);
  assert.deepEqual(errors, []);
});

test("readiness waits for the first frame to finish processing while start tracks stream lifetime", { timeout: 2000 }, async () => {
  const processing = deferred();
  const processed = deferred();
  const calls = [];
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push(method);
      if (method === "POST") return Response.json({ id: "first-frame-readiness" });
      return method === "GET" ? jpeg() : Response.json({ stopped: true });
    },
    onFrame: async () => { processing.resolve(); await processed.promise; },
    onError: () => assert.fail("This preview should not fail."),
    wait: waitForAbort,
  });
  let lifetimeEnded = false;
  let ready = false;
  const running = preview.start();
  void running.then(() => { lifetimeEnded = true; });
  const readiness = preview.whenReady();
  void readiness.then(() => { ready = true; });
  await processing.promise;
  await nextTurn();
  assert.equal(ready, false);
  assert.equal(lifetimeEnded, false);
  processed.resolve();
  await readiness;
  assert.equal(ready, true);
  assert.equal(lifetimeEnded, false);
  assert.deepEqual(calls, ["POST", "GET"]);
  await preview.stop();
  await running;
  assert.equal(lifetimeEnded, true);
  assert.deepEqual(calls, ["POST", "GET", "DELETE"]);
});

test("startup failure rejects readiness and reports once without retrying", { timeout: 2000 }, async () => {
  const calls = [];
  const errors = [];
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      calls.push(options.method || "GET");
      return Response.json({ error: "SYNTHETIC TEST USB is busy" }, { status: 503 });
    },
    onFrame: () => assert.fail("A failed start cannot deliver a frame."),
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const running = preview.start();
  await assert.rejects(preview.whenReady(), /USB is busy/);
  await running;
  await nextTurn();
  assert.deepEqual(calls, ["POST"]);
  assert.equal(errors.length, 1);
});

test("an external guest abort ends the running stream and cleans up its ID", { timeout: 2000 }, async () => {
  const guest = new AbortController();
  const calls = [];
  const errors = [];
  let sourceSignal;
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push(method);
      if (method === "POST") {
        sourceSignal = options.signal;
        return Response.json({ id: "externally-cancelled" });
      }
      if (method === "GET") return jpeg();
      assert.deepEqual(JSON.parse(options.body), { id: "externally-cancelled" });
      assert.equal(sourceSignal.aborted, true);
      assert.notEqual(options.signal, sourceSignal);
      assert.equal(options.signal.aborted, false);
      return Response.json({ stopped: true });
    },
    onFrame: () => {},
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const running = preview.start(guest.signal);
  await preview.whenReady();
  guest.abort();
  await running;
  assert.deepEqual(calls, ["POST", "GET", "DELETE"]);
  assert.deepEqual(errors, []);
});

test("an already-aborted guest rejects readiness before making any request", { timeout: 2000 }, async () => {
  const guest = new AbortController();
  guest.abort();
  const calls = [];
  const errors = [];
  const preview = createCanonLiveView({
    request: async (...args) => { calls.push(args); return jpeg(); },
    onFrame: () => assert.fail("An already-cancelled guest cannot receive a frame."),
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const running = preview.start(guest.signal);
  await assert.rejects(preview.whenReady(), { name: "AbortError" });
  await running;
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, []);
});

test("readiness resets on restart and cannot reuse the preceding stream's ready frame", { timeout: 2000 }, async () => {
  const processing = [deferred(), deferred()];
  const processed = [deferred(), deferred()];
  const errors = [];
  let starts = 0;
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      if (method === "POST") return Response.json({ id: `readiness-${++starts}` });
      return method === "GET" ? jpeg() : Response.json({ stopped: true });
    },
    onFrame: async () => {
      const index = starts - 1;
      processing[index].resolve();
      await processed[index].promise;
    },
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const first = preview.start();
  const firstReady = preview.whenReady();
  await processing[0].promise;
  processed[0].resolve();
  await firstReady;
  await preview.stop();
  await first;
  const second = preview.start();
  const secondReady = preview.whenReady();
  assert.notEqual(secondReady, firstReady);
  let becameReady = false;
  void secondReady.then(() => { becameReady = true; });
  await processing[1].promise;
  await nextTurn();
  assert.equal(becameReady, false);
  processed[1].resolve();
  await secondReady;
  assert.equal(becameReady, true);
  await preview.stop();
  await second;
  assert.equal(starts, 2);
  assert.deepEqual(errors, []);
});

test("external cancellation during first-frame processing rejects readiness and waits for cleanup", { timeout: 2000 }, async () => {
  const guest = new AbortController();
  const processing = deferred();
  const processed = deferred();
  const calls = [];
  const errors = [];
  const preview = createCanonLiveView({
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push(method);
      if (method === "POST") return Response.json({ id: "cancel-before-ready" });
      return method === "GET" ? jpeg() : Response.json({ stopped: true });
    },
    onFrame: async () => { processing.resolve(); await processed.promise; },
    onError: (error) => errors.push(error),
    wait: waitForAbort,
  });
  const running = preview.start(guest.signal);
  const readinessRejected = assert.rejects(preview.whenReady(), { name: "AbortError" });
  await processing.promise;
  guest.abort();
  await nextTurn();
  assert.deepEqual(calls, ["POST", "GET"]);
  processed.resolve();
  await readinessRejected;
  await running;
  assert.deepEqual(calls, ["POST", "GET", "DELETE"]);
  assert.deepEqual(errors, []);
});

test("asking for readiness before an explicit start cannot start camera transport", async () => {
  let requests = 0;
  const preview = createCanonLiveView({
    request: async () => { requests++; return jpeg(); },
    onFrame: () => assert.fail("No frame can arrive before explicit start."),
    onError: () => assert.fail("Waiting before start cannot report a hardware error."),
    wait: waitForAbort,
  });
  await assert.rejects(preview.whenReady(), /Start Canon live preview/);
  assert.equal(requests, 0);
});
