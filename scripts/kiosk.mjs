import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const state = path.join(root, ".deploy");
const label = "com.still.photokiosk.display";
const domain = `gui/${process.getuid?.()}`;
const service = `${domain}/${label}`;
const plist = path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const origin = "http://127.0.0.1:3000";

function launchctl(args, { allowFailure = false, capture = true } = {}) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) {
    if (allowFailure) return false;
    throw new Error(`launchctl ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`, { cause: result.error });
  }
  return true;
}

export async function kioskInstalled() {
  try { await access(plist); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function installKiosk() {
  await access(chrome, constants.X_OK);
  const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root, "scripts/kiosk.mjs"))}</string><string>run</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Interactive</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(path.join(state, "display.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(state, "display.error.log"))}</string>
</dict></plist>
`, { mode: 0o600 });
  console.log("Installed the kiosk display login service.");
}

export function stopKiosk() {
  launchctl(["bootout", service], { allowFailure: true });
}

export async function startKiosk() {
  await readFile(plist); // Require installation before touching a running display.
  stopKiosk();
  // launchd may still be removing the old browser job after bootout returns.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (launchctl(["bootstrap", domain, plist], { allowFailure: true })) {
      console.log(`Kiosk display starting at ${origin}/kiosk. Logs: ${state}/display.error.log`);
      return;
    }
    await delay(500);
  }
  launchctl(["bootstrap", domain, plist]);
}

export async function waitForKiosk({ healthUrl = `${origin}/api/kiosk`, signal, retryMs = 1000 } = {}) {
  while (true) {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(2000);
      const response = await fetch(healthUrl, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (response.ok && Array.isArray((await response.json()).backgrounds)) return;
    } catch { /* Wait through startup, rebuilds, and temporary server failures. */ }
    await delay(retryMs, undefined, { signal });
  }
}

export async function runKiosk({
  browserPath = chrome,
  profileDir = path.join(state, "chrome-profile"),
  kioskUrl = `${origin}/kiosk`,
  healthUrl = `${origin}/api/kiosk`,
  awakePath = "/usr/bin/caffeinate",
  retryMs = 1000,
} = {}) {
  await access(browserPath, constants.X_OK);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  const children = [];
  const completions = [];
  let failure;
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  function start(command, args) {
    const child = spawn(command, args, { stdio: "inherit" });
    children.push(child);
    completions.push(new Promise((resolve) => {
      child.once("error", (error) => { failure ??= error; stop(); resolve(); });
      child.once("exit", (code, signal) => {
        if (!controller.signal.aborted && (command === awakePath || code !== 0)) {
          failure ??= new Error(`${command} exited (${signal || code}).`);
        }
        stop();
        resolve();
      });
    }));
  }

  try {
    start(awakePath, ["-di", "-w", String(process.pid)]);
    console.log(`Waiting for ${healthUrl} before opening the display…`);
    await waitForKiosk({ healthUrl, signal: controller.signal, retryMs });
    controller.signal.throwIfAborted();
    start(browserPath, [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--kiosk",
      kioskUrl,
    ]);
    console.log(`Opening ${kioskUrl} in Chrome kiosk mode.`);
    await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    stop();
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(completions);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  if (failure) throw failure;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("The automatic kiosk display uses macOS launchd and Google Chrome.");
  const command = process.argv[2] || "start";
  if (command === "run") {
    await runKiosk();
  } else if (command === "install") {
    await readFile(path.join(os.homedir(), "Library/LaunchAgents/com.still.photokiosk.plist"));
    await installKiosk();
    await startKiosk();
  } else if (command === "start") {
    await startKiosk();
  } else if (command === "stop") {
    stopKiosk();
    console.log("Kiosk display stopped until the next start, deploy, or login.");
  } else if (command === "status") {
    launchctl(["print", service], { capture: false });
  } else if (command === "uninstall") {
    stopKiosk();
    await rm(plist, { force: true });
    console.log("Kiosk display login service removed. The server and browser profile are preserved.");
  } else {
    throw new Error(`Unknown kiosk command: ${command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Kiosk display failed: ${error.message}`);
    process.exitCode = 1;
  });
}
