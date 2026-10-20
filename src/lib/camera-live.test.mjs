import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { JpegFrameParser, GphotoLiveView } from "./camera-live.ts";
import { CameraController, camera } from "./camera-server.ts";
import { POST, GET, DELETE } from "../app/api/camera/live/route.ts";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const detection = "Canon EOS 5D Mark IV     usb:001,008\n";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals = [];
  ended = false;
  constructor(autoClose = true) { super(); this.autoClose = autoClose; }
  kill(signal) {
    this.signals.push(signal);
    if (this.autoClose) queueMicrotask(() => this.close());
    return true;
  }
  close(code = 0) {
    if (this.ended) return;
    this.ended = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
}

function fakeLive(options = {}) {
  const children = [];
  const commands = [];
  const factory = (args) => {
    commands.push([...args]);
    const child = new FakeChild(options.autoClose ?? true);
    children.push(child);
    if (options.emitFrame !== false) queueMicrotask(() => child.stdout.write(jpeg));
    return child;
  };
  const runnerCalls = [];
  const runner = async (args) => {
    runnerCalls.push([...args]);
    if (args.includes("--auto-detect")) return { stdout: detection, stderr: "" };
    if (options.beforeCommand) await options.beforeCommand(args, children);
    const filenameIndex = args.indexOf("--filename");
    if (filenameIndex >= 0)
      await writeFile(args[filenameIndex + 1].replace("%n", "1").replace("%C", "JPG"), jpeg);
    return { stdout: "", stderr: "" };
  };
  const controller = new CameraController(runner, {
    factory, leaseMs: options.leaseMs ?? 5000,
    stream: { startupMs: options.startupMs ?? 1000, frameTimeoutMs: options.frameTimeoutMs ?? 1000, stopGraceMs: 10, killGraceMs: 10 },
  });
  return { children, commands, runnerCalls, controller, factory };
}

test("JPEG framing handles every split marker and ignores embedded thumbnail terminators", () => {
  const app = Buffer.from([0xff, 0xe1, 0, 10, 0x45, 0x58, 0xff, 0xd8, 0xff, 0xd9, 0x41, 0x42]);
  const scan = Buffer.from([0xff, 0xda, 0, 2, 0x12, 0xff, 0, 0x34, 0xff, 0xd0, 0x56]);
  const frame = Buffer.concat([Buffer.from([0xff, 0xd8]), app, scan, Buffer.from([0xff, 0xd9])]);
  for (let split = 1; split < frame.length; split++) {
    const frames = [];
    const parser = new JpegFrameParser((bytes) => frames.push(bytes));
    parser.push(Buffer.concat([Buffer.from("gphoto diagnostic noise"), frame.subarray(0, split)]));
    parser.push(Buffer.concat([frame.subarray(split), jpeg]));
    assert.deepEqual(frames, [frame, jpeg]);
  }
});

test("JPEG framing accepts progressive scans and rejects unbounded partial or malformed frames", () => {
  const frames = [];
  const parser = new JpegFrameParser((frame) => frames.push(frame));
  const progressive = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 0xff, 0xc4, 0, 2, 0xff, 0xda, 0, 2, 2, 0xff, 0xd9]);
  for (const byte of progressive) parser.push(Buffer.from([byte]));
  assert.deepEqual(frames, [progressive]);
  assert.throws(() => new JpegFrameParser(() => {}, 32).push(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), Buffer.alloc(40)])), { code: "invalid_camera_image" });
  assert.throws(() => new JpegFrameParser(() => {}).push(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1])), { code: "invalid_camera_image" });
});

test("one native movie process serves many cached frames without still or snapshot commands", async () => {
  const fixture = fakeLive();
  const session = await fixture.controller.startLive();
  try {
    assert.equal(session.model, "Canon EOS 5D Mark IV");
    assert.equal(fixture.commands.length, 1);
    assert.deepEqual(fixture.commands[0], ["--camera", session.model, "--port", "usb:001,008", "--quiet", "--capture-movie", "--stdout"]);
    for (let frame = 0; frame < 20; frame++) assert.deepEqual(fixture.controller.liveFrame(session.id), jpeg);
    assert.deepEqual(await fixture.controller.preview(undefined, { retry: true }), jpeg);
    assert.equal((await fixture.controller.getStatus()).connected, true);
    assert.equal(fixture.runnerCalls.length, 1, "Status and cached snapshots must never probe a live USB connection");
    assert.equal(fixture.commands.length, 1);
    await assert.rejects(fixture.controller.startLive(), { code: "camera_busy", status: 409 });
    assert.equal(fixture.commands.length, 1);
    const newer = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 3, 7, 0xff, 0xd9]);
    fixture.children[0].stdout.write(Buffer.concat([jpeg, newer]));
    assert.deepEqual(fixture.controller.liveFrame(session.id), newer, "Only the latest frame is retained");
  } finally { await fixture.controller.stopLive(session.id); }
  assert.deepEqual(fixture.children[0].signals, ["SIGINT"]);
});

test("stale IDs cannot start, renew, read, or stop a different live session", async () => {
  const fixture = fakeLive();
  const old = await fixture.controller.startLive();
  await fixture.controller.stopLive(old.id);
  const current = await fixture.controller.startLive();
  try {
    assert.throws(() => fixture.controller.liveFrame(old.id), { code: "camera_live_expired", status: 410 });
    await assert.rejects(fixture.controller.stopLive(old.id), { code: "camera_live_expired", status: 410 });
    assert.throws(() => fixture.controller.liveFrame(randomUUID()), { status: 410 });
    assert.throws(() => fixture.controller.liveFrame(null), { status: 400 });
    assert.deepEqual(fixture.controller.liveFrame(current.id), jpeg);
    assert.equal(fixture.commands.length, 2);
    assert.deepEqual(fixture.children[1].signals, []);
  } finally { await fixture.controller.stopLive(current.id); }
  await fixture.controller.stopLive(current.id);
});

test("abort before the first frame closes the owned process and never automatically retries", async () => {
  const fixture = fakeLive({ emitFrame: false });
  const cancellation = new AbortController();
  const starting = fixture.controller.startLive(cancellation.signal);
  const rejected = assert.rejects(starting, { code: "camera_cancelled", status: 499 });
  await delay(0);
  assert.equal(fixture.commands.length, 1);
  cancellation.abort();
  await rejected;
  assert.equal(fixture.children[0].ended, true);
  assert.deepEqual(fixture.children[0].signals, ["SIGINT"]);
  await delay(20);
  assert.equal(fixture.commands.length, 1);
});

test("the startup deadline and expired client lease stop their owned process", async () => {
  const startup = fakeLive({ emitFrame: false, startupMs: 20 });
  await assert.rejects(startup.controller.startLive(), { code: "camera_timeout", status: 504 });
  assert.equal(startup.children[0].ended, true);
  const fixture = fakeLive({ leaseMs: 20 });
  const session = await fixture.controller.startLive();
  await delay(40);
  assert.equal(fixture.children[0].ended, true);
  assert.throws(() => fixture.controller.liveFrame(session.id), { status: 410 });
  assert.equal(fixture.commands.length, 1);
});

test("cached GET lease renewal cannot keep a stream with no new frames alive", async () => {
  const fixture = fakeLive({ leaseMs: 50, frameTimeoutMs: 25 });
  const session = await fixture.controller.startLive();
  let stopped = false;
  for (let read = 0; read < 12; read++) {
    await delay(5);
    try { fixture.controller.liveFrame(session.id); }
    catch (error) { assert.equal(error.code, "camera_timeout"); stopped = true; break; }
  }
  assert.equal(stopped, true);
  assert.equal(fixture.children[0].ended, true);
  assert.equal(fixture.commands.length, 1);
});

test("capture and configuration wait for live process close without resuming preview", async () => {
  for (const operation of ["capture", "configure"]) {
    const fixture = fakeLive({ autoClose: false, beforeCommand: async (_args, children) => {
      assert.equal(children[0].ended, true, "The USB stream must be reaped before a still or settings command");
    } });
    const session = await fixture.controller.startLive();
    const request = operation === "capture" ? fixture.controller.capture() : fixture.controller.configure({ iso: "400", aperture: "5.6", shutterSpeed: "1/125" });
    await delay(0);
    assert.equal(fixture.runnerCalls.length, 1);
    assert.deepEqual(fixture.children[0].signals, ["SIGINT"]);
    fixture.children[0].close();
    await request;
    assert.equal(fixture.commands.length, 1);
    assert.throws(() => fixture.controller.liveFrame(session.id), { status: 410 });
  }
});

test("cancelling a capture while live view is stopping skips the still shutter", async () => {
  const fixture = fakeLive({ autoClose: false });
  await fixture.controller.startLive();
  const cancellation = new AbortController();
  const rejected = assert.rejects(fixture.controller.capture(cancellation.signal), { code: "camera_cancelled" });
  await delay(0);
  cancellation.abort();
  fixture.children[0].close();
  await rejected;
  assert.equal(fixture.runnerCalls.filter((args) => args.includes("--capture-image-and-download")).length, 0);
});

test("stream exit preserves bounded useful errors and requires an explicit new start", async () => {
  const fixture = fakeLive();
  const session = await fixture.controller.startLive();
  fixture.children[0].stderr.write(Buffer.from("x".repeat(20_000) + "\nCould not detach kernel driver\nPTP Timeout"));
  fixture.children[0].close(1);
  await delay(0);
  assert.throws(() => fixture.controller.liveFrame(session.id), (error) => {
    assert.equal(error.code, "camera_in_use");
    assert.ok(error.details.length <= 1500);
    return true;
  });
  await delay(10);
  assert.equal(fixture.commands.length, 1);
});

test("owned stream shutdown escalates only after graceful signals fail", async () => {
  const child = new FakeChild(false);
  const stream = new GphotoLiveView([], () => child, { stopGraceMs: 10, killGraceMs: 10 });
  const ready = assert.rejects(stream.ready, { code: "camera_cancelled" });
  const closing = stream.stop();
  assert.deepEqual(child.signals, ["SIGINT"]);
  await delay(30);
  assert.deepEqual(child.signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
  child.close();
  await Promise.all([ready, closing]);
});

test("live HTTP handlers protect locality, forward start cancellation, and GET reads cached data only", async () => {
  for (const [handler, method] of [[POST, "POST"], [GET, "GET"], [DELETE, "DELETE"]]) {
    assert.equal((await handler(new Request("http://remote.example/api/camera/live", { method }))).status, 403);
    assert.equal((await handler(new Request("http://localhost:3000/api/camera/live", { method, headers: { origin: "https://evil.example" } }))).status, 403);
  }
  const original = { startLive: camera.startLive, liveFrame: camera.liveFrame, stopLive: camera.stopLive };
  const id = randomUUID();
  const calls = [];
  camera.startLive = async (signal) => { calls.push(["start", signal]); return { id, model: "Canon EOS 5D Mark IV" }; };
  camera.liveFrame = (requested) => { calls.push(["frame", requested]); return jpeg; };
  camera.stopLive = async (requested) => { calls.push(["stop", requested]); };
  try {
    const request = new Request("http://localhost:3000/api/camera/live", { method: "POST" });
    assert.deepEqual(await (await POST(request)).json(), { id, model: "Canon EOS 5D Mark IV" });
    assert.equal(calls[0][1], request.signal);
    const image = await GET(new Request(`http://localhost:3000/api/camera/live?id=${id}`));
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    assert.equal(image.headers.get("Cache-Control"), "no-store, max-age=0");
    const stopped = await DELETE(new Request("http://localhost:3000/api/camera/live", { method: "DELETE", body: JSON.stringify({ id }) }));
    assert.equal(stopped.status, 200);
    assert.deepEqual(calls.map(([method]) => method), ["start", "frame", "stop"]);
    assert.equal((await DELETE(new Request("http://localhost:3000/api/camera/live", { method: "DELETE", body: "{" }))).status, 400);
  } finally { Object.assign(camera, original); }
});
