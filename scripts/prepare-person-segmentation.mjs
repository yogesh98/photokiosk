import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const models = [
  ["selfie_segmenter/float16/1/selfie_segmenter.tflite", "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b"],
  ["selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite", "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0"],
  ["modnet/model.onnx", "07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9"],
];
await Promise.all(models.map(async ([filename, expectedDigest]) => {
  const model = await readFile(path.join(root, "public/models", filename));
  const digest = createHash("sha256").update(model).digest("hex");
  if (digest !== expectedDigest) throw new Error(`The bundled AI model ${filename} failed its SHA-256 check.`);
}));

const foregroundManifests = await Promise.all(["general-foreground-models.json", "background-matting-models.json"].map(async (name) =>
  JSON.parse(await readFile(path.join(root, "public/models", name), "utf8"))));
const foregroundModels = foregroundManifests.flatMap((manifest) => manifest.models);
const missingForeground = [];
for (const model of foregroundModels) {
  const filename = path.join(root, "public/models", model.localPath);
  try {
    const info = await stat(filename);
    if (info.size !== model.bytes) throw new Error(`The optional AI model ${model.name} failed its size check. Run npm run setup:foreground -- ${model.id}.`);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(filename)) digest.update(chunk);
    if (digest.digest("hex") !== model.sha256) throw new Error(`The optional AI model ${model.name} failed its SHA-256 check. Run npm run setup:foreground -- ${model.id}.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    missingForeground.push(model.name);
  }
}
if (missingForeground.length > 0) {
  console.log(`Optional foreground weights not installed: ${missingForeground.join(", ")}. Run npm run setup:foreground to add them.`);
} else {
  console.log("Optional foreground weights passed size and SHA-256 checks.");
}

const mediaSource = path.dirname(require.resolve("@mediapipe/tasks-vision"));
const mediaDestination = path.join(root, "public/vendor/mediapipe");
const onnxSource = path.dirname(require.resolve("onnxruntime-web"));
const onnxDestination = path.join(root, "public/vendor/onnxruntime");
await Promise.all([
  mkdir(path.join(mediaDestination, "wasm"), { recursive: true }),
  mkdir(onnxDestination, { recursive: true }),
]);
await Promise.all([
  copyFile(path.join(mediaSource, "vision_bundle.mjs"), path.join(mediaDestination, "vision_bundle.mjs")),
  ...["vision_wasm_module_internal.js", "vision_wasm_module_internal.wasm"].map((name) =>
    copyFile(path.join(mediaSource, "wasm", name), path.join(mediaDestination, "wasm", name)),
  ),
  ...["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
    "ort.webgpu.min.mjs", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.jspi.mjs", "ort-wasm-simd-threaded.jspi.wasm"].map((name) =>
    copyFile(path.join(onnxSource, name), path.join(onnxDestination, name)),
  ),
]);
console.log("Local AI background assets are ready (Selfie, Selfie Multiclass, MODNet).");
