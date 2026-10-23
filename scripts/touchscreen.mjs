import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const state = path.join(root, ".deploy");
const bundle = path.join(state, "Still Touch.app");
const executable = path.join(bundle, "Contents/MacOS/Still Touch");
const label = "com.still.photokiosk.touch";
const domain = `gui/${process.getuid?.()}`;
const plist = path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
const xml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { stdio: allowFailure ? "pipe" : "inherit" });
  if ((result.error || result.status !== 0) && !allowFailure) {
    throw result.error || new Error(`${command} failed (${result.status}).`);
  }
  return !result.error && result.status === 0;
}

function stop() { run("/bin/launchctl", ["bootout", `${domain}/${label}`], true); }
async function start() {
  await readFile(plist);
  stop();
  // launchd can still be removing the old job after bootout returns.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (run("/bin/launchctl", ["bootstrap", domain, plist], true)) return;
    await delay(500);
  }
  run("/bin/launchctl", ["bootstrap", domain, plist]);
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Touch rotation uses macOS CoreGraphics and Accessibility.");
  const command = process.argv[2] || "status";
  if (command === "install") {
    stop();
    await mkdir(path.dirname(executable), { recursive: true });
    await mkdir(path.dirname(plist), { recursive: true });
    run("/usr/bin/swiftc", ["-O", path.join(root, "scripts/touchscreen.swift"), "-o", executable]);
    await writeFile(path.join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${label}</string>
<key>CFBundleName</key><string>Still Touch</string>
<key>CFBundleExecutable</key><string>Still Touch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
    run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", label, bundle]);
    run(executable, ["--self-test"]);
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>--request-permission</string></array>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(state, "touch.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(state, "touch.error.log"))}</string>
</dict></plist>
`, { mode: 0o600 });
    await start();
    console.log("Installed Still Touch. Enable it in System Settings → Privacy & Security → Accessibility.");
  } else if (command === "start") {
    await start();
  } else if (command === "stop") {
    stop();
  } else if (command === "calibrate") {
    run("/bin/launchctl", ["kill", "SIGUSR1", `${domain}/${label}`]);
    console.log("Tap the nine crosshairs on the touchscreen, lifting your finger between targets. Esc cancels.");
  } else if (command === "status") {
    run("/bin/launchctl", ["print", `${domain}/${label}`]);
    run(executable, ["--status"]);
  } else if (command === "uninstall") {
    stop();
    await rm(plist, { force: true });
    console.log("Touch rotation login service removed.");
  } else {
    throw new Error("Usage: node scripts/touchscreen.mjs install|start|stop|status|calibrate|uninstall");
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
