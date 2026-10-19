import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  CameraController,
  CameraError,
  parseDetectedCameras,
  runGphoto,
  validateCameraConfiguration,
} from "./camera-server.ts";
import { GET as getCameraStatus } from "../app/api/camera/route.ts";
import { GET as getCameraPreview } from "../app/api/camera/preview/route.ts";
import { POST as captureCamera } from "../app/api/camera/capture/route.ts";
import { POST as configureCamera } from "../app/api/camera/configure/route.ts";

const detection = "Model                          Port\n----------------------------------------------------------\nCanon EOS 5D Mark IV            usb:001,008\n";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

function fakeCamera(options = {}) {
  const calls = [];
  const directories = [];
  const runner = async (args, commandOptions) => {
    calls.push({ args, ...commandOptions });
    if (args.includes("--auto-detect")) return { stdout: detection, stderr: "" };
    if (options.beforeCommand) await options.beforeCommand(args);
    const filenameIndex = args.indexOf("--filename");
    if (filenameIndex >= 0) {
      const filename = args[filenameIndex + 1].replace("%n", "1").replace("%C", options.rawOnly ? "CR2" : "JPG");
      directories.push(path.dirname(filename));
      await writeFile(filename, options.invalidJpeg ? "not a JPEG" : jpeg);
    }
    return { stdout: "", stderr: "" };
  };
  return { controller: new CameraController(runner), calls, directories };
}

test("detects only USB camera rows and keeps model names intact", () => {
  assert.deepEqual(parseDetectedCameras(detection + "Network camera  ptpip:192.168.1.10\n"), [
    { model: "Canon EOS 5D Mark IV", port: "usb:001,008" },
  ]);
});

test("reports missing gphoto2 truthfully with local installation steps", async () => {
  const controller = new CameraController(async () => {
    throw new CameraError("gphoto2 is not installed", "gphoto_unavailable", 503, "brew install gphoto2");
  });
  const status = await controller.getStatus();
  assert.equal(status.available, false);
  assert.equal(status.connected, false);
  assert.equal(status.model, null);
  assert.match(status.details, /brew install/);
});

test("auto-detection is followed by an actual connection probe", async () => {
  const { controller, calls } = fakeCamera();
  assert.deepEqual((await controller.getStatus()).connected, true);
  assert.deepEqual(calls[1].args, ["--camera", "Canon EOS 5D Mark IV", "--port", "usb:001,008", "--summary"]);
  await controller.getStatus();
  assert.equal(calls.length, 2, "status reads are briefly cached rather than taking USB ownership repeatedly");
});

test("a detected camera claimed by another app is not reported connected", async () => {
  const { controller } = fakeCamera({ beforeCommand: async () => {
    throw new CameraError("Another app is using the camera", "camera_in_use");
  } });
  const status = await controller.getStatus();
  assert.equal(status.available, true);
  assert.equal(status.connected, false);
  assert.equal(status.model, "Canon EOS 5D Mark IV");
});

test("high-resolution capture preserves camera files, returns JPEG, and removes its temporary directory", async () => {
  const { controller, calls, directories } = fakeCamera();
  assert.deepEqual(await controller.capture(), jpeg);
  const command = calls.find(({ args }) => args.includes("--capture-image-and-download"));
  assert.ok(command.args.includes("--keep"));
  assert.ok(!command.args.includes("--no-keep"));
  assert.equal(command.timeoutMs, 60_000);
  assert.equal(directories.length, 1);
  await assert.rejects(access(directories[0]), { code: "ENOENT" });
});

test("preview requests share one operation and do not fire the shutter", async () => {
  const { controller, calls } = fakeCamera();
  const [first, second] = await Promise.all([controller.preview(), controller.preview()]);
  assert.deepEqual(first, jpeg);
  assert.deepEqual(second, jpeg);
  await controller.preview();
  assert.equal(calls.filter(({ args }) => args.includes("--capture-preview")).length, 1);
  assert.equal(calls.filter(({ args }) => args.includes("--capture-image-and-download")).length, 0);
});

test("capture is exclusive and new previews cannot queue in front of it", async () => {
  let releasePreview;
  let previewStarted;
  const started = new Promise((resolve) => { previewStarted = resolve; });
  const held = new Promise((resolve) => { releasePreview = resolve; });
  let active = 0;
  let maximumActive = 0;
  const { controller, calls } = fakeCamera({ beforeCommand: async (args) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (args.includes("--capture-preview")) {
      previewStarted();
      await held;
    }
    active--;
  } });
  const preview = controller.preview();
  await started;
  const capture = controller.capture();
  // While the first preview is already running, concurrent preview requests
  // share it. They never add another operation before the waiting shutter.
  const duplicatePreview = controller.preview();
  releasePreview();
  await Promise.all([preview, duplicatePreview, capture]);
  assert.equal(maximumActive, 1);
  assert.equal(calls.filter(({ args }) => args.includes("--capture-preview")).length, 1);
  assert.equal(calls.filter(({ args }) => args.includes("--capture-image-and-download")).length, 1);
});

test("pre-aborted captures do not detect a camera or start a shutter", async () => {
  const { controller, calls } = fakeCamera();
  const cancellation = new AbortController();
  cancellation.abort(new Error("ResponseAborted"));
  await assert.rejects(controller.capture(cancellation.signal), {
    code: "camera_cancelled", status: 499,
  });
  assert.equal(calls.length, 0);
});

test("a cancelled queued capture skips its shutter without aborting a shared preview", async () => {
  let releasePreview;
  let previewStarted;
  const started = new Promise((resolve) => { previewStarted = resolve; });
  const held = new Promise((resolve) => { releasePreview = resolve; });
  const { controller, calls } = fakeCamera({ beforeCommand: async (args) => {
    if (args.includes("--capture-preview")) { previewStarted(); await held; }
  } });
  const firstPreview = controller.preview();
  const sharedPreview = controller.preview();
  await started;
  const cancellation = new AbortController();
  const cancelled = assert.rejects(controller.capture(cancellation.signal), { code: "camera_cancelled" });
  cancellation.abort(new Error("ResponseAborted"));
  releasePreview();
  const previews = await Promise.all([firstPreview, sharedPreview]);
  await cancelled;
  assert.ok(previews.every((bytes) => bytes.equals(jpeg)));
  assert.equal(calls.filter(({ args }) => args.includes("--capture-image-and-download")).length, 0);
  assert.equal(calls.find(({ args }) => args.includes("--capture-preview")).signal, undefined);
  assert.deepEqual(await controller.capture(), jpeg);
  assert.equal(calls.filter(({ args }) => args.includes("--auto-detect")).length, 1, "cancelled queued work preserves the selected USB connection");
});

test("cancellation during detection prevents a following shutter", async () => {
  const cancellation = new AbortController();
  let calls = 0;
  const controller = new CameraController(async (args, options) => {
    calls++;
    assert.deepEqual(args, ["--auto-detect"]);
    assert.equal(options.signal, cancellation.signal);
    cancellation.abort(new Error("ResponseAborted"));
    return { stdout: detection, stderr: "" };
  });
  await assert.rejects(controller.capture(cancellation.signal), { code: "camera_cancelled" });
  assert.equal(calls, 1);
});

test("active cancellation reaps the owned child before cleanup and the next capture", async () => {
  let commandStarted;
  const started = new Promise((resolve) => { commandStarted = resolve; });
  let firstDirectory;
  let readyPath;
  let stoppingPath;
  let childPid;
  let captures = 0;
  const cancellation = new AbortController();
  const controller = new CameraController(async (args, options) => {
    if (args.includes("--auto-detect")) return { stdout: detection, stderr: "" };
    const filename = args[args.indexOf("--filename") + 1].replace("%n", "1").replace("%C", "JPG");
    captures++;
    if (captures === 1) {
      firstDirectory = path.dirname(filename);
      readyPath = path.join(firstDirectory, "ready.json");
      stoppingPath = path.join(firstDirectory, "stopping.txt");
      commandStarted();
      return runGphoto(["-e", `
        const fs = require("node:fs");
        const [image, ready, stopping] = process.argv.slice(1);
        fs.writeFileSync(image, Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]));
        process.on("SIGTERM", () => {
          fs.writeFileSync(stopping, "owned child is shutting down");
          setTimeout(() => process.exit(0), 150);
        });
        fs.writeFileSync(ready, JSON.stringify({ pid: process.pid }));
        setInterval(() => {}, 1000);
      `, filename, readyPath, stoppingPath], options, process.execPath);
    }
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    await assert.rejects(access(firstDirectory), { code: "ENOENT" });
    await writeFile(filename, jpeg);
    return { stdout: "", stderr: "" };
  });
  const cancelled = assert.rejects(controller.capture(cancellation.signal), {
    code: "camera_cancelled", status: 499,
  });
  const waitForFile = async (filename) => {
    const deadline = Date.now() + 3000;
    while (true) {
      try { return await readFile(filename, "utf8"); }
      catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
        await delay(10);
      }
    }
  };
  try {
    await started;
    childPid = JSON.parse(await waitForFile(readyPath)).pid;
    cancellation.abort(new Error("ResponseAborted"));
    await waitForFile(stoppingPath);
    await access(firstDirectory);
    assert.doesNotThrow(() => process.kill(childPid, 0));
    const nextCapture = controller.capture();
    assert.equal(captures, 1, "the exclusive lock remains held while the child exits");
    await cancelled;
    assert.deepEqual(await nextCapture, jpeg);
    assert.equal(captures, 2);
  } finally {
    cancellation.abort();
    await cancelled;
  }
});

test("RAW-only captures give a useful error and clean up downloaded files", async () => {
  const { controller, directories } = fakeCamera({ rawOnly: true });
  await assert.rejects(controller.capture(), { code: "jpeg_required", status: 422 });
  await assert.rejects(access(directories[0]), { code: "ENOENT" });
});

test("a mislabeled non-JPEG image is rejected", async () => {
  const { controller, directories } = fakeCamera({ invalidJpeg: true });
  await assert.rejects(controller.capture(), { code: "invalid_camera_image" });
  await assert.rejects(access(directories[0]), { code: "ENOENT" });
});

test("configures explicit values as individual arguments and rejects commands disguised as values", async () => {
  const { controller, calls } = fakeCamera();
  await controller.configure({ iso: "400", aperture: "5.6", shutterSpeed: "1/125" });
  assert.deepEqual(calls.at(-1).args, [
    "--camera", "Canon EOS 5D Mark IV", "--port", "usb:001,008",
    "--set-config-value", "iso=400", "--set-config-value", "aperture=5.6",
    "--set-config-value", "shutterspeed=1/125",
  ]);
  for (const invalid of ["400; touch /tmp/unwanted", "--hook-script=/tmp/unwanted", "$(whoami)"]) {
    assert.throws(() => validateCameraConfiguration({ iso: invalid, aperture: "5.6", shutterSpeed: "1/125" }), { status: 400 });
  }
  assert.throws(() => validateCameraConfiguration({ iso: "400", aperture: "5.6", shutterSpeed: "31" }), { status: 400 });
});

test("a rejected exposure forces the next status read to probe before a retry", async () => {
  const { controller, calls } = fakeCamera({ beforeCommand: async (args) => {
    if (args.includes("--set-config-value")) {
      throw new CameraError("Camera rejected exposure", "camera_command", 503);
    }
  } });
  assert.equal((await controller.getStatus()).connected, true);
  const configuration = { iso: "800", aperture: "5.6", shutterSpeed: "1/125" };
  await assert.rejects(controller.configure(configuration), { code: "camera_configuration", status: 422 });
  assert.equal((await controller.getStatus()).connected, true);
  assert.equal(calls.filter(({ args }) => args.includes("--auto-detect")).length, 2);
  assert.equal(calls.filter(({ args }) => args.includes("--summary")).length, 2);
  await assert.rejects(controller.configure(configuration), { code: "camera_configuration", status: 422 });
  assert.equal(calls.filter(({ args }) => args.includes("--set-config-value")).length, 2);
});

test("a camera can be rediscovered after an operation fails", async () => {
  let first = true;
  const { controller, calls } = fakeCamera({ beforeCommand: async () => {
    if (first) {
      first = false;
      throw new CameraError("Cable unplugged", "camera_command");
    }
  } });
  await assert.rejects(controller.capture());
  assert.deepEqual(await controller.capture(), jpeg);
  assert.equal(calls.filter(({ args }) => args.includes("--auto-detect")).length, 2);
});

test("all camera routes reject nonlocal hosts and cross-origin requests before touching hardware", async () => {
  for (const [handler, method] of [[getCameraStatus, "GET"], [getCameraPreview, "GET"], [captureCamera, "POST"], [configureCamera, "POST"]]) {
    const remote = await handler(new Request("http://remote.example/api/camera", { method }));
    assert.equal(remote.status, 403);
    assert.match((await remote.json()).error, /local computer/);
    const crossOrigin = await handler(new Request("http://localhost:3000/api/camera", {
      method, headers: { origin: "https://other.example" },
    }));
    assert.equal(crossOrigin.status, 403);
    assert.match((await crossOrigin.json()).error, /Cross-origin/);
    const crossSite = await handler(new Request("http://localhost:3000/api/camera", {
      method, headers: { "sec-fetch-site": "cross-site" },
    }));
    assert.equal(crossSite.status, 403);
  }
});

test("local configure endpoint reports invalid JSON and values as request errors", async () => {
  const invalidJson = await configureCamera(new Request("http://localhost:3000/api/camera/configure", {
    method: "POST", body: "{",
  }));
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).code, "invalid_configuration");
  const invalidValue = await configureCamera(new Request("http://localhost:3000/api/camera/configure", {
    method: "POST", body: JSON.stringify({ iso: "--help", aperture: "5.6", shutterSpeed: "1/125" }),
  }));
  assert.equal(invalidValue.status, 400);
});

test("capture route forwards an already-aborted request without touching hardware", async () => {
  const cancellation = new AbortController();
  cancellation.abort(new Error("ResponseAborted"));
  const response = await captureCamera(new Request("http://localhost:3000/api/camera/capture", {
    method: "POST", signal: cancellation.signal,
  }));
  assert.equal(response.status, 499);
  assert.equal((await response.json()).code, "camera_cancelled");
});

test("real process runner reports an absent executable without invoking a shell", async () => {
  await assert.rejects(runGphoto(["--version"], { timeoutMs: 500 }, "/tmp/photokiosk-nonexistent-gphoto2"), {
    code: "gphoto_unavailable", status: 503,
  });
});

test("real process runner times out and reaps only the child it started", async () => {
  await assert.rejects(runGphoto(["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }, process.execPath), {
    code: "camera_timeout", status: 504,
  });
});
