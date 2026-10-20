import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import sharp from "sharp";
import { testB2Connection, uploadSessionToB2 } from "./backblaze";
import { createSession, getSession, readMedia, readStudio, StudioError, updateSettings } from "./studio-store";
import { POST as testPOST } from "../app/api/storage/test/route";
import { POST as sharePOST } from "../app/api/sessions/[id]/share/route";

const KEY = "K001-a-private-application-key";
const ACCOUNT_TOKEN = "private-account-authorization-token";
const BUCKET = "photo-booth-tests";
const API = "https://api001.backblazeb2.com";
const DOWNLOAD = "https://f001.backblazeb2.com";
const UPLOAD = "https://pod-000-1007-13.backblaze.com/b2api/v4/b2_upload_file/bucket/upload";
type Upload = { fileName: string; headers: Headers; bytes: Buffer };
type MockOptions = {
  capabilities?: string[];
  prefix?: string | null;
  bucketType?: string;
  apiUrl?: string;
  uploadUrl?: string;
  failUpload?: (file: Upload, attempt: number) => Response | undefined;
  beforeUpload?: (file: Upload) => Promise<void>;
};

function backblazeMock(options: MockOptions = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const uploads: Upload[] = [];
  let uploadTargets = 0;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    if (url.endsWith("/b2_authorize_account")) {
      assert.equal(init.method, "GET");
      assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`001keyid001:${KEY}`).toString("base64")}`);
      return Response.json({
        accountId: "account-001",
        authorizationToken: ACCOUNT_TOKEN,
        apiInfo: { storageApi: {
          apiUrl: options.apiUrl || API,
          downloadUrl: DOWNLOAD,
          allowed: {
            capabilities: options.capabilities || ["listBuckets", "writeFiles"],
            namePrefix: options.prefix ?? null,
            buckets: [{ id: "bucket-001", name: BUCKET }],
          },
        } },
      });
    }
    if (url.endsWith("/b2_list_buckets")) {
      assert.equal(new Headers(init.headers).get("Authorization"), ACCOUNT_TOKEN);
      assert.deepEqual(JSON.parse(String(init.body)), { accountId: "account-001", bucketName: BUCKET });
      return Response.json({ buckets: [{ bucketId: "bucket-001", bucketName: BUCKET, bucketType: options.bucketType || "allPublic" }] });
    }
    if (url.endsWith("/b2_get_upload_url")) {
      assert.deepEqual(JSON.parse(String(init.body)), { bucketId: "bucket-001" });
      uploadTargets++;
      return Response.json({ uploadUrl: options.uploadUrl || UPLOAD, authorizationToken: `private-upload-token-${uploadTargets}` });
    }
    assert.equal(url, UPLOAD);
    const headers = new Headers(init.headers);
    const bytes = Buffer.from(init.body as Uint8Array);
    const file = { fileName: decodeURIComponent(headers.get("X-Bz-File-Name")!), headers, bytes };
    assert.equal(headers.get("Content-Length"), String(bytes.length));
    assert.equal(headers.get("X-Bz-Content-Sha1"), createHash("sha1").update(bytes).digest("hex"));
    uploads.push(file);
    await options.beforeUpload?.(file);
    const failure = options.failUpload?.(file, uploads.filter((upload) => upload.fileName === file.fileName).length);
    if (failure) return failure;
    return Response.json({ fileName: file.fileName, contentLength: bytes.length, contentSha1: headers.get("X-Bz-Content-Sha1") });
  };
  return { fetcher, calls, uploads, get uploadTargets() { return uploadTargets; } };
}

let suiteDirectory: string;
let photo: string;
let fixtureNumber = 0;
const originalDirectory = process.env.PHOTO_KIOSK_DATA_DIR;
async function isolated(configured = true) {
  process.env.PHOTO_KIOSK_DATA_DIR = path.join(suiteDirectory, String(++fixtureNumber));
  await readStudio();
  if (configured)
    await updateSettings({ b2: { enabled: true, keyId: "001keyid001", applicationKey: KEY, bucketName: BUCKET } });
}
const sessionInput = () => ({ photos: [photo, photo, photo], backgroundName: "Italian coast" });
const localRequest = (route: string, headers?: HeadersInit) => new Request(`http://127.0.0.1:3000${route}`, { method: "POST", headers });

describe("Backblaze galleries", { concurrency: false }, () => {
  before(async () => {
    suiteDirectory = await mkdtemp(path.join(tmpdir(), "photo-kiosk-b2-tests-"));
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#bbd2ad" } }).png().toBuffer();
    photo = `data:image/png;base64,${bytes.toString("base64")}`;
  });
  after(async () => {
    if (originalDirectory === undefined) delete process.env.PHOTO_KIOSK_DATA_DIR;
    else process.env.PHOTO_KIOSK_DATA_DIR = originalDirectory;
    await rm(suiteDirectory, { recursive: true, force: true });
  });

  test("tests a public bucket with a bucket-restricted write key and uploads no objects", async () => {
    await isolated();
    const mock = backblazeMock();
    const result = await testB2Connection(mock.fetcher);
    assert.equal(result.success, true);
    assert.match(result.message, /public bucket/);
    assert.equal(mock.calls.length, 3);
    assert.equal(mock.uploads.length, 0);
    assert.ok(mock.calls.every((call) => call.url.includes("/b2api/v4/")));
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.ok(!JSON.stringify(result).includes(ACCOUNT_TOKEN));
  });

  test("requires configuration, public access, and permissions before getting an upload URL", async () => {
    await isolated(false);
    const unconfigured = backblazeMock();
    await assert.rejects(testB2Connection(unconfigured.fetcher), (error: unknown) => error instanceof StudioError && error.status === 422);
    assert.equal(unconfigured.calls.length, 0);
    await isolated();
    for (const options of [{ bucketType: "allPrivate" }, { capabilities: ["writeFiles"] }, { capabilities: ["listBuckets", "readFiles"] }]) {
      const mock = backblazeMock(options);
      await assert.rejects(testB2Connection(mock.fetcher), /public Backblaze bucket|listBuckets and writeFiles/);
      assert.equal(mock.uploadTargets, 0);
    }
  });

  test("never sends credentials to untrusted or insecure returned endpoints", async () => {
    await isolated();
    for (const options of [
      { apiUrl: "https://api001.backblazeb2.com.evil.example" },
      { apiUrl: "http://api001.backblazeb2.com" },
      { apiUrl: "https://secret@api001.backblazeb2.com" },
      { apiUrl: "https://api001.backblazeb2.com:444" },
      { uploadUrl: "https://evil.example/upload" },
      { uploadUrl: "https://www.backblaze.com/upload" },
    ]) {
      const mock = backblazeMock(options);
      await assert.rejects(testB2Connection(mock.fetcher), /invalid service address/);
      assert.ok(mock.calls.every((call) => !call.url.includes("evil.example") && !call.url.includes("secret@")));
      assert.equal(mock.uploads.length, 0);
    }
  });

  test("uploads three real JPEGs then a mobile gallery with separate downloads and no local URLs or secrets", async () => {
    await isolated();
    await updateSettings({ eventName: '<script>alert("test")</script> & Friends' });
    const captured = await createSession(sessionInput());
    const mock = backblazeMock();
    const shared = await uploadSessionToB2(captured.id, mock.fetcher);
    const directory = `photo-booth/${captured.id}/`;
    assert.deepEqual(mock.uploads.map((upload) => upload.fileName), ["1.jpg", "2.jpg", "3.jpg", "index.html"].map((name) => directory + name));
    assert.equal(shared.status, "captured");
    assert.equal(shared.sharing?.status, "uploaded");
    assert.equal(shared.sharing?.galleryUrl, `${DOWNLOAD}/file/${BUCKET}/${directory}index.html`);
    assert.equal(shared.sharing?.photoUrls?.length, 3);
    assert.ok(!("zipUrl" in shared.sharing!));
    for (const [index, upload] of mock.uploads.slice(0, 3).entries()) {
      assert.deepEqual(upload.bytes, await readMedia(captured.photos[index].replace("/api/media/", "").split("/")));
      assert.equal(upload.headers.get("Content-Type"), "image/jpeg");
    }
    const gallery = mock.uploads[3];
    assert.equal(gallery.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(gallery.headers.get("X-Bz-Info-b2-content-disposition"), "inline");
    const html = gallery.bytes.toString("utf8");
    assert.match(html, /&lt;script&gt;alert\(&quot;test&quot;\)&lt;\/script&gt; &amp; Friends/);
    for (const value of [KEY, ACCOUNT_TOKEN, "private-upload-token", "localhost", "/api/media/", '<script>alert("test")</script>', ".zip"])
      assert.ok(!html.includes(value), `Gallery leaked ${value}`);
    for (const file of ["1.jpg", "2.jpg", "3.jpg"]) assert.ok(html.includes(`href="${file}"`));
    assert.match(html, /name="viewport"/);
    const downloads: Array<{ url: string; filename: string }> = [];
    const links = Array.from(html.matchAll(/<a href="([123]\.jpg)" download="([^"]+)" data-photo-download>/g),
      ([, url, filename]) => ({ click: () => downloads.push({ url, filename }) }));
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let downloadAll!: () => void;
    const button = { disabled: true, addEventListener: (event: string, callback: () => void) => {
      assert.equal(event, "click");
      downloadAll = callback;
    } };
    const help = { textContent: "" };
    runInNewContext(/<script>([\s\S]+)<\/script>/.exec(html)![1], {
      navigator: {},
      document: {
        getElementById: (id: string) => id === "download-all" ? button : help,
        querySelectorAll: (selector: string) => { assert.equal(selector, "a[data-photo-download]"); return links; },
      },
      setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }),
    });
    assert.equal(button.disabled, false);
    downloadAll();
    assert.equal(button.disabled, true);
    for (const { callback } of timers.sort((a, b) => a.delay - b.delay)) callback();
    assert.deepEqual(downloads, [1, 2, 3].map((number) => ({ url: `${number}.jpg`, filename: `photo-booth-${number}.jpg` })));
    assert.equal(button.disabled, false);
    assert.match(help.textContent, /allow multiple downloads/);
    assert.deepEqual((await getSession(captured.id)).sharing, shared.sharing);
    const repeated = await uploadSessionToB2(captured.id, async () => { throw new Error("An uploaded session must not be uploaded again"); });
    assert.deepEqual(repeated.sharing, shared.sharing);
  });

  test("honors the application's allowed folder prefix and encodes public URLs", async () => {
    await isolated();
    const captured = await createSession(sessionInput());
    const mock = backblazeMock({ prefix: "Event photos/" });
    const shared = await uploadSessionToB2(captured.id, mock.fetcher);
    assert.ok(mock.uploads.every((upload) => upload.fileName.startsWith("Event photos/photo-booth/")));
    assert.match(shared.sharing!.galleryUrl!, /\/Event%20photos\/photo-booth\//);
    for (const prefix of ["/private", "../private", "event/../private", "event\\private"]) {
      await assert.rejects(testB2Connection(backblazeMock({ prefix }).fetcher), /prefix cannot be used/);
    }
    assert.equal((await testB2Connection(backblazeMock({ prefix: "" }).fetcher)).success, true);
  });

  test("retries an unavailable upload pod once using a new upload token", async () => {
    await isolated();
    const captured = await createSession(sessionInput());
    const mock = backblazeMock({ failUpload: (upload, attempt) => upload.fileName.endsWith("1.jpg") && attempt === 1 ? Response.json({ message: KEY }, { status: 503 }) : undefined });
    const shared = await uploadSessionToB2(captured.id, mock.fetcher);
    assert.equal(shared.sharing?.status, "uploaded");
    assert.equal(mock.uploadTargets, 2);
    assert.equal(mock.uploads.length, 5);
    assert.equal(mock.uploads[0].headers.get("Authorization"), "private-upload-token-1");
    assert.equal(mock.uploads[1].headers.get("Authorization"), "private-upload-token-2");
  });

  test("persists upload failure without publishing a gallery and permits a successful retry", async () => {
    await isolated();
    const captured = await createSession(sessionInput());
    const mock = backblazeMock({ failUpload: (upload) => upload.fileName.endsWith("2.jpg") ? Response.json({ message: `credentials ${KEY} ${ACCOUNT_TOKEN}` }, { status: 403 }) : undefined });
    await assert.rejects(uploadSessionToB2(captured.id, mock.fetcher), (error: unknown) => {
      assert.ok(error instanceof StudioError);
      assert.equal(error.status, 502);
      assert.match(error.message, /denied access/);
      assert.ok("session" in error);
      assert.ok(!JSON.stringify(error).includes(KEY));
      return true;
    });
    assert.equal(mock.uploads.length, 2);
    const failed = await getSession(captured.id);
    assert.equal(failed.status, "captured");
    assert.equal(failed.sharing?.status, "failed");
    assert.equal(failed.sharing?.galleryUrl, undefined);
    assert.ok(!JSON.stringify(failed).includes(KEY));
    assert.equal((await uploadSessionToB2(captured.id, backblazeMock().fetcher)).sharing?.status, "uploaded");
  });

  test("records uploading before transfer and rejects simultaneous attempts", async () => {
    await isolated();
    const captured = await createSession(sessionInput());
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mock = backblazeMock({ beforeUpload: async (upload) => { if (upload.fileName.endsWith("1.jpg")) { start(); await done; } } });
    const sharing = uploadSessionToB2(captured.id, mock.fetcher);
    await started;
    try {
      assert.equal((await getSession(captured.id)).sharing?.status, "uploading");
      await assert.rejects(uploadSessionToB2(captured.id, mock.fetcher), (error: unknown) => error instanceof StudioError && error.status === 409);
    } finally {
      finish();
    }
    assert.equal((await sharing).sharing?.status, "uploaded");
  });

  test("authentication and network failures return safe errors", async () => {
    await isolated();
    await assert.rejects(testB2Connection(async () => Response.json({ message: KEY }, { status: 401 })), /sign-in failed/);
    await assert.rejects(testB2Connection(async () => { throw new Error(`secret: ${KEY}`); }), /could not be reached/);
  });

  test("API handlers require local same-origin requests and include failed share state without secrets", async () => {
    await isolated(false);
    const denied = await testPOST(localRequest("/api/storage/test", { origin: "https://evil.example" }));
    assert.equal(denied.status, 403);
    assert.equal((await testPOST(localRequest("/api/storage/test"))).status, 422);
    const missing = await sharePOST(localRequest("/api/sessions/missing/share"), { params: Promise.resolve({ id: "missing" }) });
    assert.equal(missing.status, 404);
    await isolated();
    const captured = await createSession(sessionInput());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ message: KEY }, { status: 401 });
    try {
      const response = await sharePOST(localRequest(`/api/sessions/${captured.id}/share`), { params: Promise.resolve({ id: captured.id }) });
      assert.equal(response.status, 502);
      const result = await response.json();
      assert.match(result.error, /sign-in failed/);
      assert.equal(result.session.sharing.status, "failed");
      assert.ok(!JSON.stringify(result).includes(KEY));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
