import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  beginSessionEmail, beginSessionShare, createSession, finishSessionEmail,
  finishSessionShare, getB2Credentials, getSession, getSettings, readStudio,
  updateSettings,
} from "./studio-store";
import { GET as kioskGET } from "../app/api/kiosk/route";
import { GET as studioGET } from "../app/api/studio/route";

const originalDirectory = process.env.PHOTO_KIOSK_DATA_DIR;
let root: string;
let photo: string;
let index = 0;
const b2 = { enabled: true, keyId: "key123", bucketName: "booth-photos", applicationKey: "K123Secret+/=" };
async function isolated() {
  const directory = path.join(root, String(++index));
  process.env.PHOTO_KIOSK_DATA_DIR = directory;
  await readStudio();
  return directory;
}
const capture = () => createSession({ photos: [photo, photo, photo], backgroundName: "Coast" });
const uploaded = {
  galleryUrl: "https://f001.backblazeb2.com/file/booth-photos/session/index.html",
  photoUrls: [1, 2, 3].map((n) => `https://f001.backblazeb2.com/file/booth-photos/session/${n}.jpg`),
};

describe("Backblaze settings and persisted sharing state", { concurrency: false }, () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kiosk-b2-store-"));
    const fixture = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
    photo = `data:image/jpeg;base64,${fixture.toString("base64")}`;
  });
  after(async () => {
    if (originalDirectory === undefined) delete process.env.PHOTO_KIOSK_DATA_DIR;
    else process.env.PHOTO_KIOSK_DATA_DIR = originalDirectory;
    await rm(root, { recursive: true, force: true });
  });

  test("migrates existing booths with sharing disabled and preserves photos and email", async () => {
    const directory = await isolated();
    const session = await capture();
    const file = path.join(directory, "studio.json");
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.settings.b2;
    delete legacy.b2ApplicationKey;
    await writeFile(file, JSON.stringify(legacy));
    const studio = await readStudio();
    assert.deepEqual(studio.settings.b2, { enabled: false, keyId: "", bucketName: "", configured: false });
    assert.equal(studio.sessions[0].id, session.id);
    assert.equal(studio.settings.gmail.configured, false);
    assert.equal((await getB2Credentials()).applicationKey, "");
  });

  test("keeps keys server-side, preserves omitted secrets, and supports disabling and clearing", async () => {
    await isolated();
    assert.equal((await updateSettings({ b2 })).b2.configured, true);
    for (const result of [await readStudio(), await getSettings()]) {
      assert.ok(!JSON.stringify(result).includes(b2.applicationKey));
      assert.ok(!JSON.stringify(result).includes("applicationKey"));
    }
    await updateSettings({ b2: { enabled: false } });
    assert.equal((await getSettings()).b2.configured, false);
    assert.equal((await getB2Credentials()).applicationKey, b2.applicationKey);
    assert.equal((await updateSettings({ b2: { enabled: true } })).b2.configured, true);
    await updateSettings({ b2: { enabled: false, applicationKey: "" } });
    assert.equal((await getB2Credentials()).applicationKey, "");
  });

  test("validates settings atomically before enabling sharing", async () => {
    const directory = await isolated();
    const file = path.join(directory, "studio.json");
    const before = await readFile(file, "utf8");
    for (const patch of [
      { enabled: true }, { enabled: "yes" }, { keyId: "bad\r\nID" },
      { bucketName: "https://example.com" }, { bucketName: "b2-reserved" },
      { applicationKey: "secret\nheader" },
    ]) {
      await assert.rejects(updateSettings({ eventName: "Should not change", b2: patch }));
      assert.equal(await readFile(file, "utf8"), before);
    }
  });

  test("redacts B2 settings from guest configuration and all secrets from admin responses", async () => {
    await isolated();
    await updateSettings({ b2 });
    const guest = await kioskGET(new Request("http://127.0.0.1:3000/api/kiosk"));
    const data = await guest.json();
    assert.deepEqual(data.settings.b2, { enabled: true, configured: true, keyId: "", bucketName: "" });
    const admin = await studioGET(new Request("http://127.0.0.1:3000/api/studio"));
    const serialized = await admin.text();
    assert.ok(!serialized.includes(b2.applicationKey));
    assert.ok(!serialized.includes("applicationKey"));
    assert.ok(serialized.includes(b2.bucketName));
  });

  test("serializes concurrent uploads, persists failures and retries, and returns successful uploads idempotently", async () => {
    await isolated();
    const session = await capture();
    await assert.rejects(beginSessionShare(session.id), /not connected/);
    await updateSettings({ b2 });
    const attempts = await Promise.allSettled([beginSessionShare(session.id), beginSessionShare(session.id)]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await getSession(session.id)).sharing?.status, "uploading");
    await finishSessionShare(session.id, { error: "Connection lost" });
    assert.deepEqual((await getSession(session.id)).sharing, { status: "failed", error: "Connection lost" });
    await beginSessionShare(session.id);
    const completed = await finishSessionShare(session.id, uploaded);
    assert.deepEqual(completed.sharing, { status: "uploaded", ...uploaded });
    assert.deepEqual((await beginSessionShare(session.id)).sharing, completed.sharing);
    await assert.rejects(finishSessionShare(session.id, uploaded), /no active upload/);
    await assert.rejects(getSession("missing"), /not found/);
  });

  test("email and cloud upload complete independently without replacing each other's state", async () => {
    await isolated();
    await updateSettings({ b2, gmail: { email: "host@gmail.com", appPassword: "abcdefghijklmnop" } });
    const session = await capture();
    await beginSessionShare(session.id);
    await beginSessionEmail(session.id, "guest@example.com");
    await finishSessionShare(session.id, uploaded);
    const sent = await finishSessionEmail(session.id);
    assert.equal(sent.status, "sent");
    assert.equal(sent.sharing?.galleryUrl, uploaded.galleryUrl);
    assert.equal(sent.deliveries?.length, 1);
  });

  test("recovers interrupted uploads after a restart with photos retained for a retry", async () => {
    const directory = await isolated();
    await updateSettings({ b2 });
    const session = await capture();
    await beginSessionShare(session.id);
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      "import { readStudio } from './src/lib/studio-store.ts'; console.log(JSON.stringify(await readStudio()));"],
    { cwd: process.cwd(), env: { ...process.env, PHOTO_KIOSK_DATA_DIR: directory }, encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    const recovered = JSON.parse(child.stdout).sessions[0];
    assert.equal(recovered.sharing.status, "failed");
    assert.match(recovered.sharing.error, /interrupted/);
    assert.equal(recovered.sharing.galleryUrl, undefined);
    assert.equal(recovered.photos.length, 3);
    assert.equal((await beginSessionShare(session.id)).sharing?.status, "uploading");
  });
});
