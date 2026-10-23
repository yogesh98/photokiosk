// launchd runs this stable entry point; each release has its own dependencies.
import { createRequire } from "node:module";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const release = realpathSync(path.join(root, ".deploy/current"));
const require = createRequire(path.join(release, "server.js"));
process.env.NODE_ENV = "production";
require("@next/env").loadEnvConfig(root);
// Resolve relative overrides against the checkout, never an individual release.
process.env.PHOTO_KIOSK_DATA_DIR = path.resolve(root, process.env.PHOTO_KIOSK_DATA_DIR || ".data");
process.env.PHOTO_KIOSK_AI_PYTHON = path.resolve(root, process.env.PHOTO_KIOSK_AI_PYTHON || ".venv-ai/bin/python");
process.env.HOSTNAME = "0.0.0.0";
process.env.PORT = "3000";
require("./server.js");
