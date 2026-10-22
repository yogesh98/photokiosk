import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DEFAULT_SETTINGS } from "./kiosk-types";
import {
  BACKGROUND_REFERENCE_HEIGHT, BACKGROUND_REFERENCE_WIDTH,
  getBackgroundReferenceCameraKey, isBackgroundReference, isBackgroundReferenceCompatible,
} from "./background-reference-camera";
import { MAX_BACKGROUND_REFERENCE_BODY_BYTES, MAX_BACKGROUND_REFERENCE_BYTES, normalizeBackgroundReference } from "./background-reference";
import { getSettings, readBackgroundReference, readStudio, saveBackgroundReference, updateSettings } from "./studio-store";
import { POST as referencePOST } from "../app/api/ai/reference/route";
import { GET as referenceGET } from "../app/api/ai/reference/[id]/route";
import { GET as kioskGET } from "../app/api/kiosk/route";

test("reference camera identity covers every camera setting and rendering geometry", () => {
  const camera = structuredClone(DEFAULT_SETTINGS.camera);
  const key = getBackgroundReferenceCameraKey(camera);
  assert.equal(key, getBackgroundReferenceCameraKey({ ...camera }));
  for (const patch of [{ mode: "canon" as const }, { deviceId: "another-camera" }, { iso: "800" },
    { aperture: "8" }, { shutterSpeed: "1/60" }, { mirror: !camera.mirror }]) {
    assert.notEqual(getBackgroundReferenceCameraKey({ ...camera, ...patch }), key);
  }
  assert.ok(key.includes(String(BACKGROUND_REFERENCE_WIDTH)) && key.includes(String(BACKGROUND_REFERENCE_HEIGHT)));
  assert.equal(isBackgroundReferenceCompatible(null, camera), false);
});

describe("private captured background references", { concurrency: false }, () => {
  let suite: string;
  let directory: string;
  let png: Buffer;
  let count = 0;
  const originalDirectory = process.env.PHOTO_KIOSK_DATA_DIR;
  const request = (url: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:3000${url}`, init);
  const file = () => new File([new Uint8Array(png)], "empty-background.png", { type: "image/png" });
  const form = (cameraKey = getBackgroundReferenceCameraKey(DEFAULT_SETTINGS.camera), upload = file()) => {
    const body = new FormData();
    body.set("file", upload);
    body.set("cameraKey", cameraKey);
    return body;
  };
  before(async () => {
    suite = await mkdtemp(path.join(tmpdir(), "photo-kiosk-reference-tests-"));
    png = await sharp({ create: { width: 768, height: 512, channels: 4, background: "#376b9f" } }).png().toBuffer();
  });
  beforeEach(async () => {
    directory = path.join(suite, String(++count));
    process.env.PHOTO_KIOSK_DATA_DIR = directory;
    await readStudio();
  });
  after(async () => {
    if (originalDirectory === undefined) delete process.env.PHOTO_KIOSK_DATA_DIR;
    else process.env.PHOTO_KIOSK_DATA_DIR = originalDirectory;
    await rm(suite, { recursive: true, force: true });
  });

  test("migrates earlier booths to no reference without changing their camera or model", async () => {
    const filename = path.join(directory, "studio.json");
    const legacy = JSON.parse(await readFile(filename, "utf8"));
    delete legacy.settings.backgroundReference;
    legacy.settings.camera.iso = "800";
    await writeFile(filename, JSON.stringify(legacy));
    const settings = await getSettings();
    assert.equal(settings.backgroundReference, null);
    assert.equal(settings.camera.iso, "800");
    assert.equal(settings.aiModel, legacy.settings.aiModel);
    assert.equal(JSON.parse(await readFile(filename, "utf8")).settings.backgroundReference, null);
  });

  test("captures normalized RGB with private permissions and round-trips metadata to the kiosk", async () => {
    const response = await referencePOST(request("/api/ai/reference", { method: "POST", body: form() }));
    assert.equal(response.status, 201);
    const { settings } = await response.json();
    const reference = settings.backgroundReference;
    assert.equal(isBackgroundReference(reference), true);
    assert.equal(isBackgroundReferenceCompatible(reference, settings.camera), true);
    assert.equal(reference.width, 768);
    assert.equal(reference.height, 512);
    const saved = (await getSettings()).backgroundReference;
    assert.deepEqual(saved, reference);
    const guest = await kioskGET(request("/api/kiosk"));
    assert.deepEqual((await guest.json()).settings.backgroundReference, reference);
    const imagePath = path.join(directory, "reference-backgrounds", `${reference.id}.png`);
    assert.equal((await stat(imagePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(imagePath))).mode & 0o777, 0o700);
    const metadata = await sharp(await readFile(imagePath)).metadata();
    assert.equal(metadata.width, 768);
    assert.equal(metadata.height, 512);
    assert.equal(metadata.channels, 3);
    assert.equal(metadata.hasProfile, false);
    const image = await referenceGET(request(reference.url), { params: Promise.resolve({ id: reference.id }) });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), await readBackgroundReference(reference.id));
  });

  test("recapture versions references and preserves old files for in-flight captures", async () => {
    const key = getBackgroundReferenceCameraKey((await getSettings()).camera);
    const first = (await saveBackgroundReference(file(), key)).backgroundReference!;
    const second = (await saveBackgroundReference(file(), key)).backgroundReference!;
    assert.notEqual(first.id, second.id);
    assert.deepEqual((await getSettings()).backgroundReference, second);
    assert.ok((await readBackgroundReference(first.id)).length > 0);
    assert.deepEqual((await readdir(path.join(directory, "reference-backgrounds"))).sort(), [`${first.id}.png`, `${second.id}.png`].sort());
    await updateSettings({ camera: { mirror: !DEFAULT_SETTINGS.camera.mirror } });
    const settings = await getSettings();
    assert.deepEqual(settings.backgroundReference, second);
    assert.equal(isBackgroundReferenceCompatible(second, settings.camera), false);
  });

  test("serializes concurrent reference writes and keeps both immutable images readable", async () => {
    const key = getBackgroundReferenceCameraKey((await getSettings()).camera);
    const results = await Promise.all([saveBackgroundReference(file(), key), saveBackgroundReference(file(), key)]);
    assert.notEqual(results[0].backgroundReference!.id, results[1].backgroundReference!.id);
    const finalId = (await getSettings()).backgroundReference!.id;
    assert.ok(results.some((settings) => settings.backgroundReference!.id === finalId));
    for (const settings of results) assert.ok((await readBackgroundReference(settings.backgroundReference!.id)).length > 0);
  });

  test("rejects stale camera settings and arbitrary reference metadata without changing saved settings", async () => {
    const before = await getSettings();
    const stale = getBackgroundReferenceCameraKey({ ...before.camera, deviceId: "different-camera" });
    const response = await referencePOST(request("/api/ai/reference", { method: "POST", body: form(stale) }));
    assert.equal(response.status, 409);
    await assert.rejects(updateSettings({ eventName: "Should not save", backgroundReference: { id: "spoofed" } }), /Capture a new empty background/);
    await assert.rejects(updateSettings({ backgroundReference: null }), /Capture a new empty background/);
    assert.deepEqual(await getSettings(), before);
    await assert.rejects(stat(path.join(directory, "reference-backgrounds")), { code: "ENOENT" });
  });

  test("rejects wrong dimensions, spoofed formats, corrupt images, and oversized files", async () => {
    const wrongSize = await sharp({ create: { width: 1024, height: 512, channels: 3, background: "white" } }).png().toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    for (const bytes of [wrongSize, jpeg, Buffer.from("not a PNG")]) {
      const response = await referencePOST(request("/api/ai/reference", { method: "POST", body: form(undefined, new File([new Uint8Array(bytes)], "ref.png", { type: "image/png" })) }));
      assert.equal(response.status, 400);
    }
    await assert.rejects(normalizeBackgroundReference(new File([new Uint8Array(MAX_BACKGROUND_REFERENCE_BYTES + 1)], "big.png")), /smaller than 3 MB/);
    assert.equal((await getSettings()).backgroundReference, null);
  });

  test("enforces upload limits even without content-length and protects both endpoints from cross-origin requests", async () => {
    const body = new Uint8Array(MAX_BACKGROUND_REFERENCE_BODY_BYTES + 1);
    const large = await referencePOST(request("/api/ai/reference", { method: "POST", body }));
    assert.equal(large.status, 413);
    const declaredLarge = await referencePOST(request("/api/ai/reference", { method: "POST", headers: { "content-length": String(MAX_BACKGROUND_REFERENCE_BODY_BYTES + 1) }, body: "x" }));
    assert.equal(declaredLarge.status, 413);
    const denied = await referencePOST(request("/api/ai/reference", { method: "POST", headers: { origin: "https://elsewhere.test" }, body: form() }));
    assert.equal(denied.status, 403);
    const id = "12345678-1234-4234-8234-123456789012";
    const getDenied = await referenceGET(request(`/api/ai/reference/${id}`, { headers: { "sec-fetch-site": "cross-site" } }), { params: Promise.resolve({ id }) });
    assert.equal(getDenied.status, 403);
    for (const invalid of ["../studio.json", "not-an-id", id]) {
      const missing = await referenceGET(request("/api/ai/reference/missing"), { params: Promise.resolve({ id: invalid }) });
      assert.equal(missing.status, 404);
    }
  });

  test("invalid persisted metadata fails closed without overwriting recoverable data", async () => {
    const filename = path.join(directory, "studio.json");
    const state = JSON.parse(await readFile(filename, "utf8"));
    state.settings.backgroundReference = { id: "../../studio.json", url: "/api/ai/reference/x", width: 768, height: 512 };
    const serialized = JSON.stringify(state);
    await writeFile(filename, serialized);
    await assert.rejects(getSettings(), /Saved booth data could not be read/);
    assert.equal(await readFile(filename, "utf8"), serialized);
  });
});
