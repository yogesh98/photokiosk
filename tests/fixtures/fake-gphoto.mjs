#!/usr/bin/env node
// Synthetic USB camera for isolated UI tests. Never select this for a real booth.
import { appendFile, copyFile, readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testData = process.env.PHOTO_KIOSK_DATA_DIR;
if (
  process.env.STILL_TEST_ONLY !== "1" ||
  !testData ||
  path.resolve(testData) === path.resolve(process.cwd(), ".data")
) {
  console.error(
    "Synthetic camera refused: STILL_TEST_ONLY=1 and an isolated PHOTO_KIOSK_DATA_DIR are required.",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
if (process.env.STILL_TEST_COMMAND_LOG) {
  await appendFile(process.env.STILL_TEST_COMMAND_LOG, `${JSON.stringify(args)}\n`);
}
if ((args.includes("--capture-preview") || args.includes("--capture-movie")) && process.env.STILL_TEST_PREVIEW_ERROR === "1") {
  console.error("SYNTHETIC TEST: preview unavailable; manual retry required.");
  process.exit(1);
}
if (args.includes("--auto-detect")) {
  console.log("Model                          Port");
  console.log("----------------------------------------------------------");
  console.log("Canon EOS 5D Mark IV            usb:099,001");
} else if (args.includes("--summary")) {
  console.log(
    "SYNTHETIC TEST CAMERA: Canon EOS 5D Mark IV fixture; no USB hardware is accessed.",
  );
} else if (args.includes("--capture-movie")) {
  if (!args.includes("--stdout")) {
    console.error("Synthetic movie preview requires --stdout.");
    process.exit(2);
  }
  const frame = await readFile(new URL("./synthetic-green-screen.jpg", import.meta.url));
  console.error("SYNTHETIC TEST LIVE VIEW: fixture JPEGs only; no USB hardware is accessed.");
  const logLive = (event) => {
    if (process.env.STILL_TEST_LIVE_LOG) {
      appendFileSync(process.env.STILL_TEST_LIVE_LOG, `${JSON.stringify({
        event, timestamp: Date.now(), pid: process.pid, synthetic: true,
      })}\n`);
    }
  };
  let lastFrameLog = 0;
  let stopped = false;
  logLive("started");
  const emitFrame = () => {
    if (!process.stdout.writableNeedDrain) {
      process.stdout.write(frame);
      if (Date.now() - lastFrameLog >= 1000) {
        lastFrameLog = Date.now();
        logLive("frame");
      }
    }
  };
  const interval = setInterval(emitFrame, 100);
  const finish = (code) => {
    logLive("stopped");
    process.exit(code);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    process.stdout.end(() => finish(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.once("error", (error) => {
    clearInterval(interval);
    if (error.code === "EPIPE") finish(0);
    console.error(error.message);
    finish(1);
  });
  emitFrame();
} else if (
  args.includes("--capture-preview") ||
  args.includes("--capture-image-and-download")
) {
  const filenameIndex = args.indexOf("--filename");
  if (filenameIndex < 0 || !args[filenameIndex + 1]) {
    console.error("Synthetic camera requires an explicit --filename.");
    process.exit(2);
  }
  const filename = args[filenameIndex + 1]
    .replaceAll("%n", "1")
    .replaceAll("%C", "jpg");
  const fixture = fileURLToPath(
    new URL("./synthetic-green-screen.jpg", import.meta.url),
  );
  await copyFile(fixture, filename);
  if (
    args.includes("--capture-image-and-download") &&
    process.env.STILL_TEST_CAPTURE_LOG
  ) {
    await appendFile(
      process.env.STILL_TEST_CAPTURE_LOG,
      `${JSON.stringify({ event: "shutter", timestamp: Date.now(), synthetic: true })}\n`,
    );
  }
  console.log(`Synthetic test image saved to ${filename}`);
} else if (args.includes("--set-config-value")) {
  if (process.env.STILL_TEST_CONFIG_ERROR === "1") {
    console.error(
      "SYNTHETIC TEST: camera rejected the requested exposure setting.",
    );
    process.exit(1);
  }
  console.log("Synthetic test exposure settings applied.");
} else if (args.includes("--version")) {
  console.log("SYNTHETIC TEST gphoto2 driver (no physical camera)");
} else {
  console.error("Unsupported synthetic camera command.");
  process.exit(2);
}
