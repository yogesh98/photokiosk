import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { JpegFrameParser, GphotoLiveView } from "./camera-live.ts";
import { CameraController, CameraError, camera, encodeLiveFrame, LIVE_STREAM_CONTENT_TYPE, LIVE_STREAM_ERROR_SEQ } from "./camera-server.ts";
import { POST, GET, DELETE } from "../app/api/camera/live/route.ts";
import { GET as STREAM } from "../app/api/camera/live/stream/route.ts";

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

test("USB I/O failure is reset before reconnecting at a newly detected port", async () => {
  const calls = [];
  let port = "usb:001,008";
  let resets = 0;
  const children = [];
  const controller = new CameraController(async (args) => {
    calls.push([...args]);
    if (args.includes("--reset")) { resets++; port = "usb:001,009"; }
    return { stdout: args.includes("--auto-detect") ? `Canon EOS 5D Mark IV  ${port}\n` : "", stderr: "" };
  }, {
    factory: (args) => {
      calls.push([...args]);
      assert.equal(args[3], port);
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => child.stdout.write(jpeg));
      return child;
    },
  });
  const old = await controller.startLive();
  children[0].stderr.write("PTP I/O Error\nError (-7: 'I/O problem')");
  children[0].close(1);
  await delay(0);
  assert.throws(() => controller.liveFrame(old.id), { code: "camera_io" });
  const current = await controller.startLive();
  try {
    assert.equal(resets, 1);
    assert.deepEqual(calls[2], ["--camera", "Canon EOS 5D Mark IV", "--port", "usb:001,008", "--reset"]);
    assert.deepEqual(calls[3], ["--auto-detect"]);
    assert.equal((await controller.getStatus()).connected, true);
    assert.notEqual(old.id, current.id);
    // Repeated transport failures cannot reset the USB port in a tight loop.
    children[1].stderr.write("PTP I/O Error");
    children[1].close(1);
    await delay(0);
    const again = await controller.startLive();
    assert.equal(resets, 1);
    await controller.stopLive(again.id);
    assert.ok(calls.every((args) => !args.includes("--capture-image-and-download")));
  } finally { await controller.stopLive(current.id).catch(() => {}); }
});

test("each new live session redetects USB even after a successful status probe", async () => {
  let detections = 0;
  const controller = new CameraController(async (args) => ({
    stdout: args.includes("--auto-detect") ? `Canon EOS 5D Mark IV  usb:001,${++detections}\n` : "", stderr: "",
  }), {
    factory: (args) => {
      assert.equal(args[3], "usb:001,2");
      const child = new FakeChild();
      queueMicrotask(() => child.stdout.write(jpeg));
      return child;
    },
  });
  assert.equal((await controller.getStatus()).connected, true);
  const session = await controller.startLive();
  await controller.stopLive(session.id);
});

test("USB recovery is skipped for another app's busy camera and cancellation never starts a stream", async () => {
  for (const failure of ["camera_in_use", "camera_io"]) {
    const calls = [];
    const cancellation = new AbortController();
    const controller = new CameraController(async (args) => {
      calls.push([...args]);
      if (args.includes("--auto-detect")) return { stdout: detection, stderr: "" };
      if (args.includes("--reset")) { cancellation.abort(); return { stdout: "", stderr: "" }; }
      throw new CameraError("Synthetic USB failure", failure);
    }, { factory: () => assert.fail("No live stream should start") });
    assert.equal((await controller.getStatus()).connected, false);
    if (failure === "camera_io") {
      await assert.rejects(controller.startLive(cancellation.signal), { code: "camera_cancelled" });
      assert.equal(calls.filter((args) => args.includes("--auto-detect")).length, 1);
    } else {
      cancellation.abort();
      await assert.rejects(controller.startLive(cancellation.signal), { code: "camera_cancelled" });
      assert.ok(calls.every((args) => !args.includes("--reset")));
    }
  }
});

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
    assert.deepEqual(fixture.commands[0], ["--camera", session.model, "--port", "usb:001,008", "--set-config", "continuousaf=On", "--quiet", "--capture-movie", "--stdout"]);
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

test("a reader that has the newest frame waits for the next one instead of repeating it", async () => {
  const fixture = fakeLive();
  const session = await fixture.controller.startLive();
  try {
    const first = await fixture.controller.nextLiveFrame(session.id, -1);
    assert.deepEqual(first.bytes, jpeg);
    assert.ok(first.seq >= 1);
    let settled = false;
    const waiting = fixture.controller.nextLiveFrame(session.id, first.seq).then((frame) => { settled = true; return frame; });
    await delay(30);
    assert.equal(settled, false, "No newer frame exists yet");
    const newer = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 3, 9, 0xff, 0xd9]);
    fixture.children[0].stdout.write(newer);
    const next = await waiting;
    assert.deepEqual(next.bytes, newer);
    assert.equal(next.seq, first.seq + 1);
    assert.deepEqual((await fixture.controller.nextLiveFrame(session.id, 0)).bytes, newer, "A reader that is behind gets the newest frame at once");
    assert.equal(fixture.commands.length, 1, "Waiting for frames never starts another camera process");
  } finally { await fixture.controller.stopLive(session.id); }
});

test("a reader waiting for a frame is released when its request aborts or live view stops", async () => {
  const fixture = fakeLive();
  const session = await fixture.controller.startLive();
  const { seq } = await fixture.controller.nextLiveFrame(session.id, -1);
  const request = new AbortController();
  const cancelled = fixture.controller.nextLiveFrame(session.id, seq, request.signal);
  request.abort();
  await assert.rejects(cancelled, { code: "camera_cancelled" });
  const waiting = fixture.controller.nextLiveFrame(session.id, seq);
  await fixture.controller.stopLive(session.id);
  await assert.rejects(waiting, { status: 410 });
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

test("a corrupt live stream is a retryable transport failure, not a bad request", async () => {
  const fixture = fakeLive();
  const session = await fixture.controller.startLive();
  // A second start-of-image inside a frame's headers is malformed framing.
  fixture.children[0].stdout.write(Buffer.from([0xff, 0xd8, 0xff, 0xd8]));
  await delay(0);
  assert.throws(() => fixture.controller.liveFrame(session.id), (error) => {
    assert.equal(error.code, "invalid_camera_image");
    assert.equal(error.status, 503, "Clients retry 5xx live-view failures automatically");
    return true;
  });
  assert.equal(fixture.children[0].ended, true);
  assert.throws(() => new JpegFrameParser(() => {}, 32).push(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), Buffer.alloc(40)])), { status: 503 });
});

test("live-stream USB timeouts use the still-command classifier and reset the port", async () => {
  const calls = [];
  const children = [];
  const controller = new CameraController(async (args) => {
    calls.push([...args]);
    return { stdout: args.includes("--auto-detect") ? detection : "", stderr: "" };
  }, {
    factory: () => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => child.stdout.write(jpeg));
      return child;
    },
  });
  const old = await controller.startLive();
  children[0].stderr.write("*** Error ***\nPTP request timed out\n");
  children[0].close(1);
  await delay(0);
  assert.throws(() => controller.liveFrame(old.id), { code: "camera_timeout", status: 504 });
  const current = await controller.startLive();
  try {
    assert.equal(calls.filter((args) => args.includes("--reset")).length, 1);
  } finally { await controller.stopLive(current.id); }
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
  const original = { startLive: camera.startLive, nextLiveFrame: camera.nextLiveFrame, stopLive: camera.stopLive };
  const id = randomUUID();
  const calls = [];
  camera.startLive = async (signal) => { calls.push(["start", signal]); return { id, model: "Canon EOS 5D Mark IV" }; };
  camera.nextLiveFrame = async (requested, after, signal) => {
    calls.push(["frame", requested, after, signal]);
    return { bytes: jpeg, seq: 4 };
  };
  camera.stopLive = async (requested) => { calls.push(["stop", requested]); };
  try {
    const request = new Request("http://localhost:3000/api/camera/live", { method: "POST" });
    assert.deepEqual(await (await POST(request)).json(), { id, model: "Canon EOS 5D Mark IV" });
    assert.equal(calls[0][1], request.signal);
    const imageRequest = new Request(`http://localhost:3000/api/camera/live?id=${id}`);
    const image = await GET(imageRequest);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    assert.equal(image.headers.get("Cache-Control"), "no-store, max-age=0");
    assert.equal(image.headers.get("X-Frame-Seq"), "4");
    assert.deepEqual(calls[1].slice(1), [id, -1, imageRequest.signal], "Older clients without after= get the newest frame at once");
    await GET(new Request(`http://localhost:3000/api/camera/live?id=${id}&after=3`));
    assert.equal(calls[2][2], 3);
    const stopped = await DELETE(new Request("http://localhost:3000/api/camera/live", { method: "DELETE", body: JSON.stringify({ id }) }));
    assert.equal(stopped.status, 200);
    assert.deepEqual(calls.map(([method]) => method), ["start", "frame", "frame", "stop"]);
    assert.equal((await DELETE(new Request("http://localhost:3000/api/camera/live", { method: "DELETE", body: "{" }))).status, 400);
  } finally { Object.assign(camera, original); }
});

function decodeStreamChunk(chunk) {
  const view = Buffer.from(chunk);
  const length = view.readUInt32BE(0);
  const seq = view.readUInt32BE(4);
  assert.equal(view.length, 8 + length, "one chunk carries exactly one frame");
  return { seq, bytes: view.subarray(8) };
}

test("the frame stream sends the newest frame, then only newer ones, and ends with the stop error", async () => {
  const fixture = fakeLive();
  const session = await fixture.controller.startLive();
  const reader = fixture.controller.liveFrameStream(session.id).getReader();
  const first = decodeStreamChunk((await reader.read()).value);
  assert.deepEqual(first.bytes, jpeg);
  assert.ok(first.seq >= 1);
  let settled = false;
  const waiting = reader.read().then((result) => { settled = true; return result; });
  await delay(30);
  assert.equal(settled, false, "an unchanged frame is never repeated");
  const newer = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 3, 9, 0xff, 0xd9]);
  fixture.children[0].stdout.write(newer);
  const second = decodeStreamChunk((await waiting).value);
  assert.deepEqual(second.bytes, newer);
  assert.equal(second.seq, first.seq + 1);
  const ending = reader.read();
  await fixture.controller.stopLive(session.id);
  const last = decodeStreamChunk((await ending).value);
  assert.equal(last.seq, LIVE_STREAM_ERROR_SEQ);
  assert.equal(JSON.parse(last.bytes.toString("utf8")).status, 410);
  assert.equal((await reader.read()).done, true);
  assert.equal(fixture.commands.length, 1, "streaming never starts another camera process");
});

test("a cancelled frame stream stops waiting and a stale ID is refused before any frame is sent", async () => {
  const fixture = fakeLive();
  const session = await fixture.controller.startLive();
  try {
    const request = new AbortController();
    const reader = fixture.controller.liveFrameStream(session.id, request.signal).getReader();
    await reader.read();
    const pending = reader.read();
    request.abort();
    assert.equal((await pending).done, true, "an aborted request ends the stream without an error chunk");
    assert.throws(() => fixture.controller.liveFrameStream(randomUUID()), { status: 410 });
    assert.throws(() => fixture.controller.liveFrameStream("nonsense"), { status: 400 });
  } finally { await fixture.controller.stopLive(session.id); }
});

test("the stream route protects locality, forwards the request signal, and streams frames", async () => {
  assert.equal((await STREAM(new Request("http://remote.example/api/camera/live/stream"))).status, 403);
  const originalStream = camera.liveFrameStream;
  const id = randomUUID();
  const calls = [];
  camera.liveFrameStream = (requested, signal) => {
    calls.push([requested, signal]);
    return new ReadableStream({
      start(controller) { controller.enqueue(encodeLiveFrame(jpeg, 4)); controller.close(); },
    });
  };
  try {
    const request = new Request(`http://localhost:3000/api/camera/live/stream?id=${id}`);
    const response = await STREAM(request);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), LIVE_STREAM_CONTENT_TYPE);
    assert.equal(response.headers.get("Cache-Control"), "no-store, max-age=0");
    const frame = decodeStreamChunk(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual([frame.seq, frame.bytes], [4, jpeg]);
    assert.deepEqual(calls, [[id, request.signal]]);
    camera.liveFrameStream = () => { throw new CameraError("gone", "camera_live_expired", 410); };
    assert.equal((await STREAM(new Request(`http://localhost:3000/api/camera/live/stream?id=${id}`))).status, 410);
  } finally { camera.liveFrameStream = originalStream; }
});

test("an open frame stream keeps the lease alive even while its reader is slow", async () => {
  const fixture = fakeLive({ leaseMs: 80 });
  const session = await fixture.controller.startLive();
  try {
    const reader = fixture.controller.liveFrameStream(session.id).getReader();
    await reader.read();
    // Nobody reads for several lease periods; the connection alone keeps the camera.
    await delay(300);
    assert.equal(fixture.children[0].signals.length, 0, "the stream was not stopped by the lease");
    fixture.children[0].stdout.write(Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 3, 5, 0xff, 0xd9]));
    const next = decodeStreamChunk((await reader.read()).value);
    assert.notEqual(next.seq, LIVE_STREAM_ERROR_SEQ);
    await reader.cancel();
    await delay(250);
    assert.deepEqual(fixture.children[0].signals, ["SIGINT"], "once the reader is gone, the lease stops the stream");
  } finally { await fixture.controller.stopLive(session.id).catch(() => {}); }
});

test("a camera that rejects continuous autofocus gets live view without it from then on", async () => {
  let starts = 0;
  const fixture = fakeLive({ emitFrame: false });
  const plainFactory = fixture.factory;
  const controller = new CameraController(async (args) => {
    if (args.includes("--auto-detect")) return { stdout: detection, stderr: "" };
    return { stdout: "", stderr: "" };
  }, {
    factory: (args) => {
      starts++;
      const child = plainFactory(args);
      if (args.includes("continuousaf=On")) {
        queueMicrotask(() => { child.stderr.write("*** Error ***\nThe property 'continuousaf' / 0xd1d3 was not set (0x2002: General Error).\n"); child.close(1); });
      } else queueMicrotask(() => child.stdout.write(jpeg));
      return child;
    },
    leaseMs: 5000, stream: { startupMs: 1000, frameTimeoutMs: 1000, stopGraceMs: 10, killGraceMs: 10 },
  });
  await assert.rejects(controller.startLive(), { status: 409 });
  const session = await controller.startLive();
  try {
    assert.equal(starts, 2);
    assert.ok(!fixture.commands[1].includes("continuousaf=On"), "the second start leaves the setting out");
    assert.deepEqual(controller.liveFrame(session.id), jpeg);
  } finally { await controller.stopLive(session.id); }
});
