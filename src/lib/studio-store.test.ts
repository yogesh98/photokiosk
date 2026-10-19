import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import type { SendMailOptions } from "nodemailer";
import {
  addBackground, assertLocalRequest, beginSessionEmail, createSession, deleteBackground,
  getSettings, readMedia, readStudio, StudioError, updateSettings, validateEmail,
} from "./studio-store";
import { sendSessionEmail, sendTestEmail } from "./email";
import { GET as studioGET } from "../app/api/studio/route";
import { GET as kioskGET } from "../app/api/kiosk/route";
import { PATCH as settingsPATCH } from "../app/api/settings/route";
import { POST as sessionPOST } from "../app/api/sessions/route";
import { GET as mediaGET } from "../app/api/media/[...path]/route";

let suiteDirectory: string;
let photo: string;
let fixture: Buffer;
let fixtureNumber = 0;
const originalDirectory = process.env.PHOTO_KIOSK_DATA_DIR;
async function isolated() {
  const directory = path.join(suiteDirectory, String(++fixtureNumber));
  process.env.PHOTO_KIOSK_DATA_DIR = directory;
  await readStudio();
  return directory;
}
const request = (pathname: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:3000${pathname}`, init);
const json = (value: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
const sessionInput = () => ({ photos: [photo, photo, photo], backgroundName: "Italian coast" });
const configureGmail = () => updateSettings({ gmail: { email: "host@gmail.com", appPassword: "abcd efgh ijkl mnop" } });

describe("persistent booth data and Gmail delivery", { concurrency: false }, () => {
  before(async () => {
    suiteDirectory = await mkdtemp(path.join(tmpdir(), "photo-kiosk-tests-"));
    fixture = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#45a29e" } }).png().toBuffer();
    photo = `data:image/png;base64,${fixture.toString("base64")}`;
  });
  after(async () => {
    if (originalDirectory === undefined) delete process.env.PHOTO_KIOSK_DATA_DIR;
    else process.env.PHOTO_KIOSK_DATA_DIR = originalDirectory;
    await rm(suiteDirectory, { recursive: true, force: true });
  });

  test("starts with six real background references and no fabricated guest sessions", async () => {
    await isolated();
    const studio = await readStudio();
    assert.deepEqual(studio.backgrounds.map((item) => item.id), ["coast", "mountains", "desert", "palms", "lake", "studio"]);
    assert.equal(studio.sessions.length, 0);
    assert.equal(studio.settings.gmail.configured, false);
    studio.settings.eventName = "Changed in memory";
    assert.equal((await readStudio()).settings.eventName, "The good times");
  });

  test("merges settings, restricts file permissions, and never returns the app password", async () => {
    const directory = await isolated();
    await configureGmail();
    const updated = await updateSettings({ camera: { iso: "800" }, chroma: { spill: 0.6 }, gmail: { subject: "Your photos" } });
    assert.equal(updated.camera.iso, "800");
    assert.equal(updated.camera.aperture, "5.6");
    assert.equal(updated.chroma.spill, 0.6);
    assert.equal(updated.gmail.email, "host@gmail.com");
    assert.equal(updated.gmail.configured, true);
    const serialized = JSON.stringify(await readStudio());
    assert.ok(!serialized.includes("appPassword"));
    assert.ok(!serialized.includes("abcdefghijklmnop"));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "studio.json"))).mode & 0o777, 0o600);
    await updateSettings({ gmail: { appPassword: "" } });
    assert.equal((await getSettings()).gmail.configured, false);
  });

  test("rejects invalid settings without persisting partial changes", async () => {
    await isolated();
    await assert.rejects(updateSettings({ eventName: "Should not save", chroma: { similarity: 9 } }), /between 0 and 1/);
    assert.equal((await getSettings()).eventName, "The good times");
    await assert.rejects(updateSettings({ activeBackgroundId: "missing" }), /existing background/);
    await assert.rejects(updateSettings({ gmail: { appPassword: "normal-password" } }), /16-character/);
    await assert.rejects(updateSettings({ gmail: { senderName: "Sender\r\nBcc: attacker@example.com" } }), /single line/);
    assert.throws(() => validateEmail("a@example.com\r\nBcc:b@example.com"), /valid email/);
  });

  test("validates uploaded pixels, stores normalized images, and removes active uploads safely", async () => {
    await isolated();
    await assert.rejects(addBackground(new File(["pretend image"], "fake.png", { type: "image/png" }), "Fake"), /valid JPEG/);
    const background = await addBackground(new File([new Uint8Array(fixture)], "party.png", { type: "image/png" }), "Party wall");
    const mediaPath = background.url.replace("/api/media/", "").split("/");
    const metadata = await sharp(await readMedia(mediaPath)).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.equal(metadata.width, 24);
    await updateSettings({ activeBackgroundId: background.id });
    await deleteBackground(background.id);
    assert.equal((await getSettings()).activeBackgroundId, "coast");
    await assert.rejects(readMedia(mediaPath), /not found/);
    await assert.rejects(deleteBackground("coast"), /Built-in/);
    for (const parts of [["..", "studio.json"], ["credentials.json"], ["backgrounds", "../../studio.json"]]) await assert.rejects(readMedia(parts), /not found/);
  });

  test("requires exactly three decoded photos and serializes simultaneous writes without losing sessions", async () => {
    await isolated();
    await assert.rejects(createSession({ photos: [photo], backgroundName: "Coast" }), /exactly three/);
    await assert.rejects(createSession({ photos: ["data:image/png;base64,ZmFrZQ==", photo, photo], backgroundName: "Coast" }), /valid JPEG/);
    const sessions = await Promise.all(Array.from({ length: 5 }, () => createSession(sessionInput())));
    assert.equal(new Set(sessions.map((item) => item.id)).size, 5);
    assert.equal((await readStudio()).sessions.length, 5);
    const saved = sessions[0];
    assert.equal(saved.status, "captured");
    assert.equal(saved.email, null);
    assert.equal(saved.photos.length, 3);
    assert.ok(saved.photos.every((url) => url.startsWith(`/api/media/sessions/${saved.id}/`)));
    const bytes = await readMedia(saved.photos[0].replace("/api/media/", "").split("/"));
    assert.equal((await sharp(bytes).metadata()).format, "jpeg");
  });

  test("capture retries with one request ID persist one session, including concurrent retries", async () => {
    await isolated();
    const input = { ...sessionInput(), requestId: "capture-request-001" };
    const sessions = await Promise.all([createSession(input), createSession(input), createSession(input)]);
    assert.equal(new Set(sessions.map((item) => item.id)).size, 1);
    assert.equal((await readStudio()).sessions.length, 1);
    assert.equal((await createSession({ requestId: input.requestId })).id, sessions[0].id);
  });

  test("records sending before SMTP, prevents simultaneous sends, and sends three real attachments", async () => {
    await isolated();
    await configureGmail();
    const captured = await createSession(sessionInput());
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    let sentMail: SendMailOptions | undefined;
    let closes = 0;
    const delivery = sendSessionEmail(captured.id, "guest@example.com", () => ({
      verify: async () => true,
      sendMail: async (mail) => { sentMail = mail; notifyStarted(); await done; return { accepted: ["guest@example.com"], rejected: [] }; },
      close: () => { closes++; },
    }));
    await started;
    assert.equal((await readStudio()).sessions[0].status, "sending");
    await assert.rejects(beginSessionEmail(captured.id, "guest@example.com"), /already being sent/);
    finish();
    const sent = await delivery;
    assert.equal(sent.status, "sent");
    assert.equal(sent.email, "guest@example.com");
    assert.equal(sentMail?.attachments?.length, 3);
    assert.equal(sentMail?.to, "guest@example.com");
    assert.ok(Buffer.isBuffer(sentMail?.attachments?.[0].content));
    assert.equal(closes, 1);
    const repeated = await sendSessionEmail(captured.id, "guest@example.com", () => { throw new Error("must not resend"); });
    assert.equal(repeated.status, "sent");
  });

  test("keeps failed deliveries and recipient addresses with useful errors, without leaking SMTP secrets", async () => {
    await isolated();
    const captured = await createSession(sessionInput());
    await assert.rejects(sendSessionEmail(captured.id, "guest@example.com"), /not connected/);
    await configureGmail();
    await assert.rejects(sendSessionEmail(captured.id, "guest@example.com", () => ({
      verify: async () => true,
      sendMail: async () => { throw Object.assign(new Error("secret: abcdefghijklmnop"), { code: "EAUTH" }); },
      close: () => {},
    })), /Gmail sign-in failed/);
    const saved = (await readStudio()).sessions[0];
    assert.equal(saved.status, "failed");
    assert.equal(saved.email, "guest@example.com");
    assert.match(saved.error!, /app password/);
    assert.ok(!saved.error?.includes("abcdefghijklmnop"));
    assert.equal(saved.deliveries?.[0].email, "guest@example.com");
    assert.equal(saved.deliveries?.[0].status, "failed");
    assert.equal(saved.deliveries?.[0].error, saved.error);
    await assert.rejects(sendSessionEmail(captured.id, "guest@example.com", () => ({
      verify: async () => true, sendMail: async () => ({ accepted: [], rejected: ["guest@example.com"] }), close: () => {},
    })), /did not accept/);
    assert.equal((await readStudio()).sessions[0].status, "failed");
  });

  test("retains every recipient when photos are sent to another address and adds no row for an idempotent retry", async () => {
    await isolated();
    await configureGmail();
    const captured = await createSession(sessionInput());
    let sends = 0;
    const transport = () => ({
      verify: async () => true,
      sendMail: async (mail: SendMailOptions) => { sends++; return { accepted: [String(mail.to)], rejected: [] }; },
      close: () => {},
    });
    await sendSessionEmail(captured.id, "first@example.com", transport);
    await sendSessionEmail(captured.id, "first@example.com", transport);
    const second = await sendSessionEmail(captured.id, "second@example.com", transport);
    assert.equal(second.email, "second@example.com");
    assert.deepEqual(second.deliveries?.map(({ email, status }) => ({ email, status })), [
      { email: "first@example.com", status: "sent" }, { email: "second@example.com", status: "sent" },
    ]);
    await sendSessionEmail(captured.id, "second@example.com", transport);
    assert.equal(sends, 2);
    assert.equal((await readStudio()).sessions[0].deliveries?.length, 2);
    const third = await sendSessionEmail(captured.id, "first@example.com", transport);
    assert.equal(sends, 3);
    assert.deepEqual(third.deliveries?.map((delivery) => delivery.email), ["first@example.com", "second@example.com", "first@example.com"]);
    assert.ok(third.deliveries?.every((delivery) => !Number.isNaN(Date.parse(delivery.createdAt))));
  });

  test("preserves a successful recipient from legacy data before another recipient replaces the latest address", async () => {
    const directory = await isolated();
    await configureGmail();
    const captured = await createSession(sessionInput());
    const file = path.join(directory, "studio.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.sessions[0].email = "earlier@example.com";
    state.sessions[0].status = "sent";
    await writeFile(file, JSON.stringify(state));
    const sending = await beginSessionEmail(captured.id, "next@example.com");
    assert.equal(sending.email, "next@example.com");
    assert.deepEqual(sending.deliveries, [{ email: "earlier@example.com", status: "sent", createdAt: captured.createdAt }]);
    assert.equal((await readStudio()).sessions[0].deliveries?.[0].email, "earlier@example.com");
  });

  test("a test email verifies authentication and sends only when both steps succeed", async () => {
    await isolated();
    await configureGmail();
    const actions: string[] = [];
    const result = await sendTestEmail("host@example.com", () => ({
      verify: async () => { actions.push("verify"); },
      sendMail: async (mail) => { actions.push(`send:${mail.to}`); return { accepted: ["host@example.com"], rejected: [] }; },
      close: () => { actions.push("close"); },
    }));
    assert.equal(result.success, true);
    assert.deepEqual(actions, ["verify", "send:host@example.com", "close"]);
    await assert.rejects(sendTestEmail("host@example.com", () => ({
      verify: async () => { throw Object.assign(new Error("offline"), { code: "ECONNECTION" }); },
      sendMail: async () => { throw new Error("must not send after verify failure"); }, close: () => {},
    })), /could not be reached/);
  });

  test("a fresh process recovers interrupted sends as failed without automatically resending", async () => {
    const directory = await isolated();
    await configureGmail();
    const captured = await createSession(sessionInput());
    const transport = () => ({
      verify: async () => true,
      sendMail: async (mail: SendMailOptions) => ({ accepted: [String(mail.to)], rejected: [] }),
      close: () => {},
    });
    await sendSessionEmail(captured.id, "earlier@example.com", transport);
    await beginSessionEmail(captured.id, "guest@example.com");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", "import { readStudio } from './src/lib/studio-store.ts'; console.log(JSON.stringify(await readStudio()));"], {
      cwd: process.cwd(), env: { ...process.env, PHOTO_KIOSK_DATA_DIR: directory }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const recovered = JSON.parse(child.stdout);
    assert.equal(recovered.sessions[0].status, "failed");
    assert.match(recovered.sessions[0].error, /interrupted/);
    assert.deepEqual(recovered.sessions[0].deliveries.map((delivery: { email: string; status: string }) => ({ email: delivery.email, status: delivery.status })), [
      { email: "earlier@example.com", status: "sent" }, { email: "guest@example.com", status: "failed" },
    ]);
    assert.match(recovered.sessions[0].deliveries[1].error, /interrupted/);
    const next = await sendSessionEmail(captured.id, "next@example.com", transport);
    assert.deepEqual(next.deliveries?.map((delivery) => delivery.email), ["earlier@example.com", "guest@example.com", "next@example.com"]);
  });

  test("loopback and same-origin checks reject remote hosts, cross-origin posts, and DNS rebinding", async () => {
    assert.doesNotThrow(() => assertLocalRequest(request("/api/studio")));
    assert.doesNotThrow(() => assertLocalRequest(request("/api/settings", { headers: { origin: "http://127.0.0.1:3000" } })));
    assert.doesNotThrow(() => assertLocalRequest(new Request("http://localhost:3000/api/studio", { headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } })));
    assert.throws(() => assertLocalRequest(new Request("http://localhost:3000/api/studio", { headers: { host: "127.0.0.1:4000" } })), /local computer/);
    assert.throws(() => assertLocalRequest(new Request("http://booth.example.com/api/studio")), /local computer/);
    assert.throws(() => assertLocalRequest(request("/api/studio", { headers: { host: "evil.example.com" } })), /local computer/);
    assert.throws(() => assertLocalRequest(request("/api/settings", { headers: { origin: "https://evil.example.com" } })), /Cross-origin/);
    assert.throws(() => assertLocalRequest(request("/api/studio", { headers: { "sec-fetch-site": "cross-site" } })), /Cross-site/);
    const denied = await studioGET(request("/api/studio", { headers: { origin: "https://evil.example.com" } }));
    assert.equal(denied.status, 403);
    assert.equal(typeof (await denied.json()).error, "string");
  });

  test("HTTP handlers persist sessions, serve JPEGs, reject malformed bodies, and redact secrets", async () => {
    await isolated();
    await configureGmail();
    const settings = await settingsPATCH(request("/api/settings", { ...json({ camera: { iso: "1600" } }), method: "PATCH" }));
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).settings.camera.iso, "1600");
    const created = await sessionPOST(request("/api/sessions", json(sessionInput())));
    assert.equal(created.status, 201);
    const captured = (await created.json()).session;
    const media = await mediaGET(request(captured.photos[0]), { params: Promise.resolve({ path: captured.photos[0].replace("/api/media/", "").split("/") }) });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "image/jpeg");
    assert.ok((await media.arrayBuffer()).byteLength > 0);
    const studio = await studioGET(request("/api/studio"));
    assert.equal(studio.headers.get("cache-control"), "no-store");
    const body = await studio.text();
    assert.ok(!body.includes("appPassword"));
    assert.ok(!body.includes("abcdefghijklmnop"));
    const badJson = await sessionPOST(request("/api/sessions", { method: "POST", body: "{" }));
    assert.equal(badJson.status, 400);
    assert.equal(typeof (await badJson.json()).error, "string");
  });

  test("the guest kiosk API excludes all previous sessions, recipients, delivery history, and sender details", async () => {
    await isolated();
    await configureGmail();
    await updateSettings({ gmail: { senderName: "Private sender", subject: "Private subject", message: "Private message" } });
    const captured = await createSession(sessionInput());
    await sendSessionEmail(captured.id, "private-guest@example.com", () => ({
      verify: async () => true,
      sendMail: async () => ({ accepted: ["private-guest@example.com"], rejected: [] }),
      close: () => {},
    }));
    const admin = await readStudio();
    assert.equal(admin.sessions[0].deliveries?.[0].email, "private-guest@example.com");
    const guest = await kioskGET(request("/api/kiosk"));
    assert.equal(guest.status, 200);
    assert.equal(guest.headers.get("cache-control"), "no-store");
    const serialized = await guest.text();
    const payload = JSON.parse(serialized);
    assert.deepEqual(Object.keys(payload).sort(), ["backgrounds", "settings"]);
    assert.equal(payload.settings.gmail.configured, true);
    for (const key of ["email", "senderName", "subject", "message"]) assert.equal(payload.settings.gmail[key], "");
    assert.equal(payload.backgrounds.length, 6);
    for (const privateValue of [captured.id, "private-guest@example.com", "host@gmail.com", "Private sender", "Private subject", "Private message", "abcdefghijklmnop", "deliveries", "sessions"]) assert.ok(!serialized.includes(privateValue), `Guest payload leaked ${privateValue}`);
    const denied = await kioskGET(request("/api/kiosk", { headers: { origin: "https://evil.example.com" } }));
    assert.equal(denied.status, 403);
  });

  test("corrupt saved data is reported and preserved instead of replaced with an empty booth", async () => {
    const directory = await isolated();
    await writeFile(path.join(directory, "studio.json"), "{broken}");
    await assert.rejects(readStudio(), (error: unknown) => error instanceof StudioError && error.status === 500);
    assert.equal(await readFile(path.join(directory, "studio.json"), "utf8"), "{broken}");
  });
});
