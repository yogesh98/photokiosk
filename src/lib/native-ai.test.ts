import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NativeAiController, MAX_NATIVE_REQUEST_BYTES, readNativeAiRequest, validateNativeAiRequest } from "./native-ai";
import { POST } from "../app/api/ai/native/route";

const info = { provider: "coreml", device: "Apple Core ML (GPU + CPU)", width: 512, height: 512, kind: "alpha" };
const rgba = Buffer.alloc(512 * 512 * 4, 255).toString("base64");
const frame = { type: "segment" as const, width: 512, height: 512, rgba };
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
