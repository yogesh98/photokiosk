import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const modelRoot = fileURLToPath(new URL("../public/models/", import.meta.url));
const manifests = await Promise.all(["general-foreground-models.json", "background-matting-models.json"].map(async (name) =>
  JSON.parse(await readFile(path.join(modelRoot, name), "utf8"))));
const manifest = { models: manifests.flatMap((item) => item.models) };
const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("--"));
const ids = args.filter((arg) => !arg.startsWith("--"));
const knownIds = new Set(manifest.models.map((model) => model.id));

if (flags.some((flag) => !["--verify", "--list", "--help"].includes(flag)) || ids.some((id) => !knownIds.has(id))) {
  console.error("Unknown argument. Run node scripts/setup-general-foreground.mjs --help for usage.");
  process.exitCode = 1;
} else if (flags.includes("--help")) {
  console.log("Usage: node scripts/setup-general-foreground.mjs [model-id ...] [--verify | --list]");
  console.log("Downloads all four pinned MIT-licensed ONNX weights (about 2.16 GB) unless model IDs are supplied.");
  console.log("--verify checks local size and SHA-256 without downloading; --list shows available models.");
} else {
  const selected = manifest.models.filter((model) => ids.length === 0 || ids.includes(model.id));
  if (flags.includes("--list")) {
    selected.forEach((model) => console.log(`${model.id}: ${model.name}, ${(model.bytes / 1_000_000).toFixed(1)} MB, MIT`));
  } else {
    for (const model of selected) {
      const destination = path.join(modelRoot, model.localPath);
      if (await verified(destination, model)) {
        console.log(`${model.name}: local weights verified.`);
        continue;
      }
      if (flags.includes("--verify")) {
        throw new Error(`${model.name}: weights are missing or failed verification. Run npm run setup:foreground -- ${model.id}.`);
      }
      await download(model, destination);
    }
    console.log("Foreground weights are ready. Native inference also requires npm run setup:ai.");
  }
}

async function verified(filename, model) {
  try {
    if ((await stat(filename)).size !== model.bytes) return false;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(filename)) digest.update(chunk);
    return digest.digest("hex") === model.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function download(model, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.download-${process.pid}`;
  const url = model.url ?? `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.file}`;
  console.log(`${model.name}: downloading ${(model.bytes / 1_000_000).toFixed(1)} MB from pinned revision ${model.revision}.`);
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}.`);
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: "wx" }));
    if (bytes !== model.bytes || digest.digest("hex") !== model.sha256) {
      throw new Error(`${model.name}: downloaded weights failed size or SHA-256 verification.`);
    }
    await rename(temporary, destination);
    console.log(`${model.name}: downloaded and verified.`);
  } finally {
    await rm(temporary, { force: true });
  }
}
