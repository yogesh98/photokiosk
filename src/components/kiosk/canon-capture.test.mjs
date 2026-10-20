import test from "node:test";
import assert from "node:assert/strict";
import { captureCanonWithLiveView } from "./canon-capture.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function options(overrides = {}) {
  const events = [];
  const controller = new AbortController();
  return {
    events,
    controller,
    input: {
      signal: controller.signal,
      hasNextPhoto: true,
      isCurrent: () => true,
      stopLiveView: async () => { events.push("stop"); },
      capture: async (signal) => {
        assert.equal(signal, controller.signal);
        events.push("shutter");
        return "captured photo";
      },
      startLiveView: () => { events.push("start"); },
      waitUntilReady: async (signal) => {
        assert.equal(signal, controller.signal);
        events.push("ready");
      },
      ...overrides,
    },
  };
}

test("Canon capture waits for live view to stop, then one shutter, then resumed readiness", { timeout: 2000 }, async () => {
  const stopped = deferred();
  const shutterStarted = deferred();
  const photoReceived = deferred();
  const readinessStarted = deferred();
  const ready = deferred();
  const state = options();
  state.input.stopLiveView = async () => { state.events.push("stop"); await stopped.promise; };
  state.input.capture = async (signal) => {
    assert.equal(signal, state.controller.signal);
    state.events.push("shutter");
    shutterStarted.resolve();
    return photoReceived.promise;
  };
  state.input.waitUntilReady = async (signal) => {
    assert.equal(signal, state.controller.signal);
    state.events.push("ready");
    readinessStarted.resolve();
    await ready.promise;
  };
  let completed = false;
  const capture = captureCanonWithLiveView(state.input).then((photo) => { completed = true; return photo; });
  assert.deepEqual(state.events, ["stop"]);
  stopped.resolve();
  await shutterStarted.promise;
  assert.deepEqual(state.events, ["stop", "shutter"]);
  photoReceived.resolve("full-resolution JPEG");
  await readinessStarted.promise;
  assert.deepEqual(state.events, ["stop", "shutter", "start", "ready"]);
  assert.equal(completed, false);
  ready.resolve();
  assert.equal(await capture, "full-resolution JPEG");
});

test("three photos resume live view between shots and never resume after photo three", async () => {
  const state = options();
  const photos = [];
  for (let photo = 1; photo <= 3; photo++) {
    photos.push(await captureCanonWithLiveView({ ...state.input, hasNextPhoto: photo < 3 }));
  }
  assert.equal(photos.length, 3);
  assert.deepEqual(state.events, [
    "stop", "shutter", "start", "ready",
    "stop", "shutter", "start", "ready",
    "stop", "shutter",
  ]);
});

test("a stop failure never fires the shutter or restarts live view", async () => {
  const state = options();
  state.input.stopLiveView = async () => { state.events.push("stop"); throw new Error("Camera is still busy"); };
  await assert.rejects(captureCanonWithLiveView(state.input), /Camera is still busy/);
  assert.deepEqual(state.events, ["stop"]);
});

test("a failed capture never resumes live view or retries the shutter", async () => {
  const state = options();
  state.input.capture = async () => { state.events.push("shutter"); throw new Error("Shutter failed"); };
  await assert.rejects(captureCanonWithLiveView(state.input), /Shutter failed/);
  assert.deepEqual(state.events, ["stop", "shutter"]);
});

test("an already-cancelled or stale guest starts no camera operation", async () => {
  for (const cancellation of ["aborted", "stale"]) {
    const state = options();
    if (cancellation === "aborted") state.controller.abort();
    else state.input.isCurrent = () => false;
    await assert.rejects(captureCanonWithLiveView(state.input), { name: "AbortError" });
    assert.deepEqual(state.events, []);
  }
});

test("cancellation while stopping live view never fires a late shutter", { timeout: 2000 }, async () => {
  const stopped = deferred();
  const state = options();
  state.input.stopLiveView = async () => { state.events.push("stop"); await stopped.promise; };
  const capture = captureCanonWithLiveView(state.input);
  state.controller.abort();
  await assert.rejects(capture, { name: "AbortError" });
  stopped.resolve();
  await nextTurn();
  assert.deepEqual(state.events, ["stop"]);
});

test("cancellation exactly when capture completes prevents any live-view restart", async () => {
  const state = options();
  state.input.capture = async () => {
    state.events.push("shutter");
    state.controller.abort();
    return "late cancelled photo";
  };
  await assert.rejects(captureCanonWithLiveView(state.input), { name: "AbortError" });
  assert.deepEqual(state.events, ["stop", "shutter"]);
});

test("a late capture response cannot resume a cancelled guest", { timeout: 2000 }, async () => {
  const shutterStarted = deferred();
  const response = deferred();
  const state = options();
  state.input.capture = async () => {
    state.events.push("shutter");
    shutterStarted.resolve();
    return response.promise;
  };
  const capture = captureCanonWithLiveView(state.input);
  await shutterStarted.promise;
  state.controller.abort();
  await assert.rejects(capture, { name: "AbortError" });
  response.resolve("discard cancelled photo");
  await nextTurn();
  assert.deepEqual(state.events, ["stop", "shutter"]);
});

test("a transport replaced during capture cannot resume the new guest's preview", async () => {
  let current = true;
  const state = options({ isCurrent: () => current });
  state.input.capture = async () => {
    state.events.push("shutter");
    current = false;
    return "old transport photo";
  };
  await assert.rejects(captureCanonWithLiveView(state.input), { name: "AbortError" });
  assert.deepEqual(state.events, ["stop", "shutter"]);
});

test("a partly started live view is stopped if start itself fails", async () => {
  const state = options();
  state.input.startLiveView = () => { state.events.push("start"); throw new Error("Live view could not start"); };
  await assert.rejects(captureCanonWithLiveView(state.input), /Live view could not start/);
  assert.deepEqual(state.events, ["stop", "shutter", "start", "stop"]);
});

test("readiness failure stops the resumed preview without another capture or start", async () => {
  const state = options();
  state.input.waitUntilReady = async () => { state.events.push("ready"); throw new Error("No live frames arrived"); };
  await assert.rejects(captureCanonWithLiveView(state.input), /No live frames arrived/);
  assert.deepEqual(state.events, ["stop", "shutter", "start", "ready", "stop"]);
});

test("cancellation while awaiting resumed readiness stops the stream", { timeout: 2000 }, async () => {
  const readinessStarted = deferred();
  const ready = deferred();
  const state = options();
  state.input.waitUntilReady = async () => { state.events.push("ready"); readinessStarted.resolve(); await ready.promise; };
  const capture = captureCanonWithLiveView(state.input);
  await readinessStarted.promise;
  state.controller.abort();
  await assert.rejects(capture, { name: "AbortError" });
  ready.resolve();
  await nextTurn();
  assert.deepEqual(state.events, ["stop", "shutter", "start", "ready", "stop"]);
});

test("becoming stale at readiness stops the old transport instead of advancing countdown", async () => {
  let current = true;
  const state = options({ isCurrent: () => current });
  state.input.waitUntilReady = async () => { state.events.push("ready"); current = false; };
  await assert.rejects(captureCanonWithLiveView(state.input), { name: "AbortError" });
  assert.deepEqual(state.events, ["stop", "shutter", "start", "ready", "stop"]);
});

test("cancellation at the restart boundary stops the partly started transport", async () => {
  const state = options();
  state.input.startLiveView = () => { state.events.push("start"); state.controller.abort(); };
  await assert.rejects(captureCanonWithLiveView(state.input), { name: "AbortError" });
  assert.deepEqual(state.events, ["stop", "shutter", "start", "stop"]);
});

test("readiness failure is preserved if stopping the resumed transport also fails", async () => {
  const state = options();
  let stops = 0;
  state.input.stopLiveView = async () => {
    state.events.push("stop");
    if (++stops > 1) throw new Error("Cleanup also failed");
  };
  state.input.waitUntilReady = async () => { state.events.push("ready"); throw new Error("Original readiness failure"); };
  await assert.rejects(captureCanonWithLiveView(state.input), /Original readiness failure/);
  assert.deepEqual(state.events, ["stop", "shutter", "start", "ready", "stop"]);
});
