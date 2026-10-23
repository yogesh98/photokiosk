import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installKiosk, kioskInstalled, startKiosk, stopKiosk } from "./kiosk.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const state = path.join(root, ".deploy");
const releases = path.join(state, "releases");
const current = path.join(state, "current");
const label = "com.still.photokiosk";
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const plist = path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
const url = "http://127.0.0.1:3000";
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}` };

function run(command, args, { capture = false, allowFailure = false, extraEnv = {} } = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) {
    if (allowFailure) return undefined;
    throw new Error(`${command} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`, { cause: result.error });
  }
  return capture ? result.stdout?.trim() : result.status;
}

async function target() {
  try { return await readlink(current); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function select(release) {
  const temporary = path.join(state, `current-${process.pid}`);
  await symlink(release, temporary);
  await rename(temporary, current);
}

async function restart() {
  run("launchctl", ["bootout", service], { capture: true, allowFailure: true });
  // bootout returns before launchd finishes removing a terminating job.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (run("launchctl", ["bootstrap", domain, plist], { capture: true, allowFailure: true }) !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  run("launchctl", ["bootstrap", domain, plist]);
}

async function healthy() {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch(`${url}/api/kiosk`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && Array.isArray((await response.json()).backgrounds)) return;
    } catch { /* The server may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not become healthy. See ${state}/server.error.log`);
}

async function install() {
  const hooks = run("git", ["config", "--get", "core.hooksPath"], { capture: true, allowFailure: true });
  if (hooks && hooks !== ".githooks") throw new Error(`Existing core.hooksPath is ${hooks}; integrate those hooks before installing.`);
  await installKiosk();
  const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root, "scripts/serve.mjs"))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(env.PATH)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(state, "server.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(state, "server.error.log"))}</string>
</dict></plist>
`, { mode: 0o600 });
  await writeFile(path.join(state, "node"), `${process.execPath}\n`, { mode: 0o600 });
  run("git", ["config", "--local", "core.hooksPath", ".githooks"]);
  console.log("Installed pull hooks and the login service.");
}

async function deploy() {
  const lock = path.join(state, "lock");
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another deployment is running (${lock}). If it was interrupted, remove that lock directory and retry.`);
    throw error;
  }
  const previous = await target();
  const release = path.join(releases, `${Date.now()}-${process.pid}`);
  let activated = false;
  try {
    // The running standalone release is independent of node_modules and .next.
    run("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"]);
    run("npm", ["run", "build"], { extraEnv: { PHOTO_KIOSK_STANDALONE: "1" } });
    await mkdir(releases, { recursive: true });
    await cp(path.join(root, ".next/standalone"), release, { recursive: true, verbatimSymlinks: true });
    await cp(path.join(root, ".next/static"), path.join(release, ".next/static"), { recursive: true });
    // Large model weights and event data stay in the checkout across releases.
    for (const name of ["public", ".venv-ai"]) {
      await rm(path.join(release, name), { recursive: true, force: true });
      await symlink(path.join(root, name), path.join(release, name));
    }
    await cp(path.join(root, "scripts/native-ai"), path.join(release, "scripts/native-ai"), { recursive: true });
    await select(release);
    activated = true;
    await restart();
    await healthy();
    // Keep the current and previous builds for recovery, without touching data.
    for (const name of await readdir(releases)) {
      const candidate = path.join(releases, name);
      if (candidate !== release && candidate !== previous) await rm(candidate, { recursive: true, force: true });
    }
    console.log(`Photo kiosk is running at ${url}/admin (kiosk: ${url}/kiosk).`);
  } catch (error) {
    if (activated && previous) {
      console.error("New release failed; restoring the previous build.");
      await select(previous);
      await restart();
      await healthy();
    } else if (activated) {
      run("launchctl", ["bootout", service], { capture: true, allowFailure: true });
      await rm(current, { force: true });
    }
    await rm(release, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
  // Display startup is separate from release rollback: a browser problem must
  // never remove a healthy server release. Refresh only after a healthy deploy.
  if (await kioskInstalled()) await startKiosk();
}

try {
  if (process.platform !== "darwin") throw new Error("This deployment service uses macOS launchd. Use npm run build and npm start on other systems.");
  const command = process.argv[2] || "deploy";
  if (command === "status") {
    run("launchctl", ["print", service]);
  } else if (command === "stop") {
    stopKiosk();
    run("launchctl", ["bootout", service]);
  } else if (command === "install" || command === "deploy") {
    await mkdir(state, { recursive: true, mode: 0o700 });
    if (command === "install") await install();
    else await readFile(plist); // Require the one-time installation first.
    await deploy();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
}
