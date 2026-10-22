import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NativeAiController, MAX_NATIVE_REQUEST_BYTES, readNativeAiRequest, validateNativeAiRequest } from "./native-ai";
import { POST } from "../app/api/ai/native/route";

const info = { provider: "coreml", device: "Apple Core ML (GPU + CPU)", width: 512, height: 512, kind: "alpha" };
const rgba = Buffer.alloc(512 * 512 * 4, 255).toString("base64");
const frame = { type: "segment" as const, width: 512, height: 512, rgba };
const referenceId = "12345678-1234-4123-8123-123456789abc";
function controller(body: string, extra: object = {}) {
  return new NativeAiController({
    executable: process.execPath,
    args: ["-e", `const readline = require('node:readline'); const info=${JSON.stringify(info)}; let calls=0; readline.createInterface({input:process.stdin}).on('line', line=>{const request=JSON.parse(line); calls++; ${body}});`],
    initializeTimeoutMs: 1000, frameTimeoutMs: 1000, idleTimeoutMs: 100,
    ...extra,
  });
}
const success = `console.log(JSON.stringify({id:request.id,...info,...(request.type==='segment'?{alpha:Buffer.alloc(512*512*4).toString('base64')}:{})}));`;

test("native payload validates exact dimensions and RGBA bytes before starting a process", () => {
  assert.deepEqual(validateNativeAiRequest({ type: "initialize", ignored: true }), { type: "initialize" });
  assert.deepEqual(validateNativeAiRequest(frame), frame);
  for (const input of [null, {}, { ...frame, width: 4096 }, { ...frame, rgba: "a" }, { ...frame, rgba: "!".repeat(rgba.length) }]) {
    assert.throws(() => validateNativeAiRequest(input), { code: "native_invalid", status: 400 });
  }
});

test("reference requests require an immutable reference ID and exact rectangular bytes", () => {
  const init = { type: "initialize", model: "background-matting-mobilenet", acceleration: "cpu", referenceId } as const;
  const referenceFrame = { ...init, type: "segment", width: 768, height: 512, rgba: Buffer.alloc(768 * 512 * 4).toString("base64") } as const;
  assert.deepEqual(validateNativeAiRequest(init), init);
  assert.deepEqual(validateNativeAiRequest(referenceFrame), referenceFrame);
  for (const invalid of [{ ...init, referenceId: undefined }, { ...init, referenceId: "../private" },
    { ...referenceFrame, width: 512 }, { ...referenceFrame, rgba: rgba }, { type: "initialize", model: "modnet", referenceId }]) {
    assert.throws(() => validateNativeAiRequest(invalid), { code: "native_invalid" });
  }
});

test("native reference inference pins the plate and recapture replaces the previous session", async () => {
  const init = { type: "initialize", model: "background-matting-mobilenet", acceleration: "cpu", referenceId } as const;
  const referenceFrame = { ...init, type: "segment", width: 768, height: 512, rgba: Buffer.alloc(768 * 512 * 4).toString("base64") } as const;
  const native = controller(`console.log(JSON.stringify({id:request.id,...info,provider:'onnx-cpu',model:request.model,referenceId:request.referenceId,width:768,height:512,...(request.type==='segment'?{alpha:Buffer.alloc(768*512*4).toString('base64')}:{})}));`);
  try {
    assert.equal((await native.request(init)).referenceId, referenceId);
    assert.equal((await native.request(referenceFrame)).alpha?.length, referenceFrame.rgba.length);
    const next = { ...init, referenceId: "87654321-4321-4321-8321-123456789abc" };
    assert.equal((await native.request(next)).referenceId, next.referenceId);
    await assert.rejects(native.request(referenceFrame), { code: "native_model_changed" });
  } finally { native.close(); }
});

test("native endpoint rejects cross-origin and non-local requests before inference", async () => {
  for (const [url, headers] of [
    ["http://127.0.0.1:3000/api/ai/native", { origin: "https://untrusted.example" }],
    ["http://example.com/api/ai/native", {}],
  ] as const) {
    const response = await POST(new Request(url, { method: "POST", headers }));
    assert.equal(response.status, 403);
  }
});

test("native request reader bounds streamed bodies even without content-length", async () => {
  const request = new Request("http://localhost/api/ai/native", {
    method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(MAX_NATIVE_REQUEST_BYTES + 1),
  });
  await assert.rejects(readNativeAiRequest(request), { status: 413 });
  await assert.rejects(readNativeAiRequest(new Request(request.url, { method: "POST", body: "{}" })), { status: 415 });
});

test("native worker stays alive across initialization and frames and returns validated masks", async () => {
  const native = controller(success);
  try {
    assert.deepEqual(await native.request({ type: "initialize" }), info);
    const output = await native.request(frame);
    assert.equal(output.alpha?.length, rgba.length);
    assert.equal(output.provider, "coreml");
  } finally { native.close(); }
});

test("native worker rejects queued frames and cancellation frees the next operation", async () => {
  const native = controller(`if(calls>1){${success}}`);
  const abort = new AbortController();
  const first = native.request({ type: "initialize" }, abort.signal);
  await assert.rejects(native.request(frame), { code: "native_busy", status: 429 });
  abort.abort();
  await assert.rejects(first, { code: "native_cancelled", status: 499 });
  const secondAbort = new AbortController();
  const next = native.request({ type: "initialize" }, secondAbort.signal);
  secondAbort.abort();
  await assert.rejects(next, { code: "native_cancelled" });
  native.close();
});

test("native worker timeouts terminate the process and allow retry", async () => {
  const native = controller("", { initializeTimeoutMs: 30 });
  try {
    await assert.rejects(native.request({ type: "initialize" }), { code: "native_timeout", status: 504 });
    await assert.rejects(native.request({ type: "initialize" }), { code: "native_timeout", status: 504 });
  } finally { native.close(); }
});

test("missing optional Python runtime reports setup guidance", async () => {
  const native = new NativeAiController({ executable: "/not-installed/photokiosk-python" });
  try {
    await assert.rejects(native.request({ type: "initialize" }), (error: unknown) => error instanceof Error && /setup.py/.test(error.message));
  } finally { native.close(); }
});

test("native worker rejects invalid provider identity and nonfinite masks", async () => {
  for (const body of [
    "console.log(JSON.stringify({id:request.id,...info,provider:'cpu'}))",
    "const alpha=Buffer.alloc(512*512*4);alpha.writeFloatLE(NaN,0);console.log(JSON.stringify({id:request.id,...info,alpha:alpha.toString('base64')}))",
  ]) {
    const native = controller(body);
    try { await assert.rejects(native.request(frame), /invalid/); }
    finally { native.close(); }
  }
});

test("native idle shutdown starts a fresh worker on the next request", async () => {
  const native = controller(`if(calls>1) process.exit(1); else {${success}}`, { idleTimeoutMs: 10 });
  try {
    assert.deepEqual(await native.request({ type: "initialize" }), info);
    await delay(40);
    assert.deepEqual(await native.request({ type: "initialize" }), info);
  } finally { native.close(); }
});

test("native process crash and oversized protocol output are bounded failures", async () => {
  for (const body of ["process.exit(1)", `process.stdout.write('x'.repeat(${MAX_NATIVE_REQUEST_BYTES + 1}))`]) {
    const native = controller(body);
    try { await assert.rejects(native.request({ type: "initialize" }), { code: "native_unavailable" }); }
    finally { native.close(); }
  }
});

test("a crashed native worker fully retires before a successful retry", async () => {
  const native = controller(`if(request.id===1) process.exit(1); else {${success}}`);
  try {
    await assert.rejects(native.request({ type: "initialize" }), { code: "native_unavailable" });
    assert.deepEqual(await native.request({ type: "initialize" }), info);
  } finally { native.close(); }
});

test("a missing executable fully retires before retrying with an installed runtime", async () => {
  const options = {
    executable: "/not-installed/photokiosk-python",
    args: ["-e", `const readline=require('node:readline');const info=${JSON.stringify(info)};readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);${success}});`],
    initializeTimeoutMs: 1000,
  };
  const native = new NativeAiController(options);
  try {
    await assert.rejects(native.request({ type: "initialize" }), { code: "native_unavailable" });
    options.executable = process.execPath;
    assert.deepEqual(await native.request({ type: "initialize" }), info);
  } finally { native.close(); }
});

const generalInfo = { provider: "onnx-cpu", device: "Native CPU (ONNX Runtime)", model: "birefnet-lite", width: 1024, height: 1024, kind: "alpha" };
const generalFrame = {
  type: "segment" as const, model: "birefnet-lite" as const, acceleration: "cpu" as const,
  width: 1024, height: 1024, rgba: Buffer.alloc(1024 * 1024 * 4, 255).toString("base64"),
};
const generalSuccess = `console.log(JSON.stringify({id:request.id,...${JSON.stringify(generalInfo)},model:request.model,...(request.type==='segment'?{alpha:Buffer.alloc(1024*1024*4).toString('base64')}:{})}));`;

test("general native frames validate the selected model, acceleration, and 1024 pixel size", () => {
  assert.deepEqual(validateNativeAiRequest(generalFrame), generalFrame);
  for (const patch of [{ model: "other" }, { acceleration: "other" }, { width: 512 }, { rgba }]) {
    assert.throws(() => validateNativeAiRequest({ ...generalFrame, ...patch }), { code: "native_invalid", status: 400 });
  }
});

test("general native inference returns validated model identity and full-size alpha", async () => {
  const native = controller(generalSuccess);
  try {
    assert.deepEqual(await native.request({ type: "initialize", model: "birefnet-lite", acceleration: "cpu" }), generalInfo);
    const output = await native.request(generalFrame);
    assert.equal(output.model, generalFrame.model);
    assert.equal(output.alpha?.length, generalFrame.rgba.length);
  } finally { native.close(); }
});

test("switching native models replaces the process and rejects stale frames", async () => {
  const native = controller(`if(calls>1)process.exit(1);else{${generalSuccess}}`);
  try {
    await native.request({ type: "initialize", model: "birefnet-lite", acceleration: "cpu" });
    await assert.rejects(native.request({ ...generalFrame, model: "birefnet-general" }), { code: "native_model_changed", status: 409 });
    const next = await native.request({ type: "initialize", model: "birefnet-general", acceleration: "cpu" });
    assert.equal(next.model, "birefnet-general");
    await assert.rejects(native.request(generalFrame), { code: "native_model_changed", status: 409 });
    const changedAcceleration = await native.request({ type: "initialize", model: "birefnet-general", acceleration: "auto" });
    assert.equal(changedAcceleration.provider, "onnx-cpu");
  } finally { native.close(); }
});

test("general native inference rejects another model, false GPU labels, and wrong mask dimensions", async () => {
  for (const [patch, acceleration] of [
    [{ model: "birefnet-general" }, "cpu"],
    [{ provider: "coreml" }, "cpu"],
    [{ provider: "onnx-cpu" }, "gpu"],
    [{ width: 512, height: 512 }, "cpu"],
  ] as const) {
    const native = controller(`console.log(JSON.stringify({id:request.id,...${JSON.stringify(generalInfo)},...${JSON.stringify(patch)}}));`);
    try {
      await assert.rejects(native.request({ type: "initialize", model: "birefnet-lite", acceleration }), /invalid/);
    } finally { native.close(); }
  }
});

test("general initialization cancellation leaves no session running and allows another model", async () => {
  const native = controller(`if(request.model==='birefnet-general'){${generalSuccess}}`);
  const abort = new AbortController();
  try {
    const first = native.request({ type: "initialize", model: "birefnet-lite", acceleration: "cpu" }, abort.signal);
    abort.abort();
    await assert.rejects(first, { code: "native_cancelled" });
    assert.equal((await native.request({ type: "initialize", model: "birefnet-general", acceleration: "cpu" })).model, "birefnet-general");
  } finally { native.close(); }
});
