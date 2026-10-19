import test from "node:test";
import assert from "node:assert/strict";
import { requestCanonPhoto } from "./capture-camera.ts";

test("cancel while live view is pending never triggers the shutter", async () => {
  const controller = new AbortController();
  let requests = 0;
  const capture = requestCanonPhoto(
    controller.signal,
    new Promise(() => {}),
    async () => {
      requests++;
      return new Response("photo");
    },
  );
  controller.abort();
  await assert.rejects(capture, { name: "AbortError" });
  assert.equal(requests, 0);
});

test("the in-flight Canon request receives the guest's cancellation signal", async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const capture = requestCanonPhoto(
    controller.signal,
    null,
    async (url, options) => {
      assert.equal(url, "/api/camera/capture");
      assert.equal(options.method, "POST");
      assert.equal(options.signal, controller.signal);
      started();
      return new Promise((resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      );
    },
  );
  await ready;
  controller.abort();
  await assert.rejects(capture, { name: "AbortError" });
});

test("late capture and image-body responses cannot escape cancellation", async () => {
  for (const phase of ["response", "body"]) {
    const controller = new AbortController();
    const capture = requestCanonPhoto(controller.signal, null, async () => {
      if (phase === "response") controller.abort();
      return {
        ok: true,
        blob: async () => {
          controller.abort();
          return new Blob(["discarded photo"]);
        },
      };
    });
    await assert.rejects(capture, { name: "AbortError" });
  }
});

test("a failed preview can recover through a real high-resolution capture", async () => {
  const photo = await requestCanonPhoto(
    new AbortController().signal,
    Promise.reject(new Error("Preview failed")),
    async () =>
      new Response("real photo", { headers: { "Content-Type": "image/jpeg" } }),
  );
  assert.equal(await photo.text(), "real photo");
  assert.equal(photo.type, "image/jpeg");
});

test("camera errors reach the guest without a substituted photo", async () => {
  await assert.rejects(
    requestCanonPhoto(new AbortController().signal, null, async () =>
      Response.json({ error: "The camera was disconnected." }, { status: 503 }),
    ),
    /camera was disconnected/,
  );
});
