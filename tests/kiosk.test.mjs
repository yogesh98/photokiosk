import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { waitForKiosk } from "../scripts/kiosk.mjs";

async function until(predicate, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function fixture(t, { crash = false } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "photokiosk-display-"));
  const events = path.join(temporary, "events.jsonl");
  const browserPath = path.join(temporary, "Fake Chrome.mjs");
  const awakePath = path.join(temporary, "Fake caffeinate.mjs");
  let response = { status: 503, body: "starting" };
  let requests = 0;
  const server = createServer((request, res) => {
    requests++;
    res.writeHead(response.status, { "Content-Type": "application/json", "Connection": "close" });
    res.end(response.body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const healthUrl = `${origin}/api/kiosk`;
  const kioskUrl = `${origin}/kiosk`;
  const profileDir = path.join(temporary, "separate chrome profile");
  const program = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import path from "node:path";
const role = path.basename(process.argv[1]);
function record(event) {
  appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event, role, args: process.argv.slice(2) }) + "\\n");
}
record("start");
process.on("SIGTERM", () => { record("stop"); process.exit(0); });
${crash ? 'if (role === "Fake Chrome.mjs") setTimeout(() => process.exit(7), 30);' : ""}
setInterval(() => {}, 1000);
`;
  for (const executable of [browserPath, awakePath]) {
    await writeFile(executable, program);
    await chmod(executable, 0o755);
  }
  const runner = path.join(temporary, "runner.mjs");
  await writeFile(runner, `import { runKiosk } from ${JSON.stringify(new URL("../scripts/kiosk.mjs", import.meta.url).href)};
runKiosk(${JSON.stringify({ browserPath, awakePath, profileDir, healthUrl, kioskUrl, retryMs: 20 })}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
`);
  let runtime;
  let exited;
  let output = "";
  t.after(async () => {
    if (runtime && runtime.exitCode === null && runtime.signalCode === null) runtime.kill("SIGTERM");
    if (exited) await exited;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  async function records() {
    try { return (await readFile(events, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  return {
    healthUrl, kioskUrl, profileDir, records,
    get requests() { return requests; },
    get output() { return output; },
    respond(status, body) { response = { status, body }; },
    start() {
      runtime = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] });
      for (const stream of [runtime.stdout, runtime.stderr]) stream.on("data", (chunk) => { output += chunk; });
      exited = new Promise((resolve, reject) => {
        runtime.once("exit", (code, signal) => resolve({ code, signal }));
        runtime.once("error", reject);
      });
    },
    stop() { runtime.kill("SIGTERM"); return exited; },
    get exited() { return exited; },
  };
}

test("display waits for valid server data, opens an isolated kiosk, and cleans up on stop", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  f.start();
  await until(async () => (await f.records()).some((r) => r.role === "Fake caffeinate.mjs"), "sleep prevention");
  await until(() => f.requests >= 2, "startup retries");
  assert.equal((await f.records()).some((r) => r.role === "Fake Chrome.mjs"), false);

  for (const body of ["invalid JSON", '{"backgrounds":{}}']) {
    const before = f.requests;
    f.respond(200, body);
    await until(() => f.requests >= before + 2, "invalid health responses to be rejected");
    assert.equal((await f.records()).some((r) => r.role === "Fake Chrome.mjs"), false);
  }

  f.respond(200, '{"backgrounds":[]}');
  await until(async () => (await f.records()).some((r) => r.role === "Fake Chrome.mjs"), "kiosk browser");
  const records = await f.records();
  const args = records.find((r) => r.role === "Fake Chrome.mjs").args;
  assert.ok(args.includes("--kiosk"));
  assert.ok(args.includes(`--user-data-dir=${f.profileDir}`));
  assert.equal(args.at(-1), f.kioskUrl);
  assert.ok(records.find((r) => r.role === "Fake caffeinate.mjs").args.includes("-di"));
  assert.deepEqual(await f.stop(), { code: 0, signal: null }, f.output);
  const stopped = (await f.records()).filter((r) => r.event === "stop").map((r) => r.role).sort();
  assert.deepEqual(stopped, ["Fake Chrome.mjs", "Fake caffeinate.mjs"]);
});

test("browser failure exits unsuccessfully for launchd recovery and releases sleep prevention", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { crash: true });
  f.respond(200, '{"backgrounds":[]}');
  f.start();
  assert.deepEqual(await f.exited, { code: 1, signal: null }, f.output);
  assert.match(f.output, /exited \(7\)/);
  assert.ok((await f.records()).some((r) => r.event === "stop" && r.role === "Fake caffeinate.mjs"));
});

test("stopping while the server is unavailable cancels waiting without launching Chrome", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  f.start();
  await until(() => f.requests >= 2, "unavailable server retries");
  assert.deepEqual(await f.stop(), { code: 0, signal: null }, f.output);
  assert.equal((await f.records()).some((r) => r.role === "Fake Chrome.mjs"), false);
});

test("an already cancelled startup does not issue a health request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForKiosk({ healthUrl: pathToFileURL("/unreachable").href, signal: controller.signal }), { name: "AbortError" });
});
