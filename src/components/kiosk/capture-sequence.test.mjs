import test from "node:test";
import assert from "node:assert/strict";
import { runCaptureSequence, abortableDelay } from "./capture-sequence.ts";

test("takes exactly three photos after 5, 3, and 3 second countdowns", async () => {
  const calls = [];
  const captureTimes = [];
  let clock = 0;
  let number = 0;
  const controller = new AbortController();
  const result = await runCaptureSequence({
    signal: controller.signal,
    capture: async (signal) => {
      assert.equal(signal, controller.signal);
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
