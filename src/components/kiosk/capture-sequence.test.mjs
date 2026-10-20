import test from "node:test";
import assert from "node:assert/strict";
import { runCaptureSequence, abortableDelay, waitForCaptureScene } from "./capture-sequence.ts";

test("takes exactly three photos after 5, 3, and 3 second countdowns", async () => {
  const calls = [];
  const captureTimes = [];
  let clock = 0;
  let number = 0;
  const previewResumes = [];
  const controller = new AbortController();
  const result = await runCaptureSequence({
    signal: controller.signal,
    capture: async (signal, options) => {
      assert.equal(signal, controller.signal);
      previewResumes.push(options.resumePreview);
      calls.push("capture");
      captureTimes.push(clock);
      return `photo${++number}`;
    },
    onCountdown: (seconds, photo) => calls.push([seconds, photo]),
    onPhoto: (photo) => calls.push(photo),
    wait: async (ms) => {
      assert.equal(ms, 1000);
      clock += ms;
      calls.push("wait");
    },
  });
  assert.deepEqual(result, ["photo1", "photo2", "photo3"]);
  assert.deepEqual(captureTimes, [5000, 8000, 11000]);
  assert.deepEqual(calls.filter(Array.isArray), [
    [5, 1],
    [4, 1],
    [3, 1],
    [2, 1],
    [1, 1],
    [0, 1],
    [3, 2],
    [2, 2],
    [1, 2],
    [0, 2],
    [3, 3],
    [2, 3],
    [1, 3],
    [0, 3],
  ]);
  assert.equal(calls.filter((call) => call === "wait").length, 11);
  assert.deepEqual(previewResumes, [true, true, false]);
});

test("a failed camera capture stops the sequence instead of inventing photos", async () => {
  let attempts = 0;
  const delivered = [];
  await assert.rejects(
    runCaptureSequence({
      signal: new AbortController().signal,
      capture: async () => {
        attempts++;
        if (attempts === 2) throw new Error("Disconnected");
        return "photo1";
      },
      onCountdown() {},
      onPhoto: (photo) => delivered.push(photo),
      wait: async () => {},
    }),
    /Disconnected/,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(delivered, ["photo1"]);
});

test("cancelling while the camera responds never publishes that photo", async () => {
  const controller = new AbortController();
  const delivered = [];
  await assert.rejects(
    runCaptureSequence({
      signal: controller.signal,
      capture: async () => {
        controller.abort();
        return "late photo";
      },
      onCountdown() {},
      onPhoto: (photo) => delivered.push(photo),
      wait: async () => {},
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(delivered, []);
});

test("cancel during a countdown prevents camera capture", async () => {
  const controller = new AbortController();
  let captured = false;
  await assert.rejects(
    runCaptureSequence({
      signal: controller.signal,
      capture: async () => {
        captured = true;
        return "photo";
      },
      onCountdown() {},
      onPhoto() {},
      wait: async () => controller.abort(),
    }),
    { name: "AbortError" },
  );
  assert.equal(captured, false);
});

test("real countdown delay stops promptly on cancellation", async () => {
  const controller = new AbortController();
  const delay = abortableDelay(10000, controller.signal);
  controller.abort();
  await assert.rejects(delay, { name: "AbortError" });
});

test("each scene finishes preparing before its countdown and photo", async () => {
  const events = [];
  let currentScene;
  const result = await runCaptureSequence({
    signal: new AbortController().signal,
    preparePhoto: async (number) => {
      events.push(`prepare ${number}`);
      await Promise.resolve();
      currentScene = `scene ${number}`;
    },
    capture: async () => currentScene,
    onCountdown: (seconds, number) => {
      assert.equal(currentScene, `scene ${number}`);
      events.push(`countdown ${number} ${seconds}`);
    },
    onPhoto: (photo) => events.push(photo),
    wait: async () => {},
  });
  assert.deepEqual(result, ["scene 1", "scene 2", "scene 3"]);
  for (let number = 1; number <= 3; number++) {
    const firstCountdown = events.indexOf(`countdown ${number} ${number === 1 ? 5 : 3}`);
    assert.equal(events[firstCountdown - 1], `prepare ${number}`);
  }
});

test("failed or cancelled scene preparation never starts its countdown or shutter", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let shots = 0;
    const countdownPhotos = [];
    await assert.rejects(runCaptureSequence({
      signal: controller.signal,
      preparePhoto: async (number) => {
        if (number !== 2) return;
        if (cancel) controller.abort();
        else throw new Error("Background missing");
      },
      capture: async () => `photo ${++shots}`,
      onCountdown: (_seconds, number) => countdownPhotos.push(number),
      onPhoto() {},
      wait: async () => {},
    }), cancel ? { name: "AbortError" } : /Background missing/);
    assert.equal(shots, 1);
    assert.ok(countdownPhotos.every((number) => number === 1));
  }
});

test("scene readiness ignores a ready capture with the previous background", async () => {
  const oldCapture = async () => "old";
  const newCapture = async () => "new";
  let ready = { capture: oldCapture, backgroundUrl: "/old.jpg" };
  let polls = 0;
  const capture = await waitForCaptureScene(() => ready, "/new.jpg", new AbortController().signal, async () => {
    polls++;
    ready = polls === 1 ? { capture: null, backgroundUrl: "/new.jpg" } : { capture: newCapture, backgroundUrl: "/new.jpg" };
  });
  assert.equal(polls, 2);
  assert.equal(capture, newCapture);
});

test("scene readiness propagates errors, cancellation, and bounded loading failures", async () => {
  await assert.rejects(waitForCaptureScene(() => ({ capture: null, error: "Image unavailable" }), "/a.jpg", new AbortController().signal), /Image unavailable/);
  const controller = new AbortController();
  await assert.rejects(waitForCaptureScene(() => ({ capture: null }), "/a.jpg", controller.signal, async () => controller.abort()), { name: "AbortError" });
  let polls = 0;
  await assert.rejects(waitForCaptureScene(() => ({ capture: null }), "/a.jpg", new AbortController().signal, async () => { polls++; }), /could not be prepared/);
  assert.equal(polls, 600);
});
