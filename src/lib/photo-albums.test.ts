import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Script } from "node:vm";
import sharp from "sharp";
import {
  addAlbumPhoto,
  createAlbum,
  deleteAlbum,
  listAlbums,
  publishAlbum,
  removeAlbumPhoto,
  renameAlbum,
} from "./photo-albums";
import { renderAlbumPage } from "./album-page";
import { renderPhotoGallery } from "./photo-gallery";
import { readStudio, StudioError, updateSettings } from "./studio-store";
import { GET as listGET, POST as createPOST } from "../app/api/albums/route";

const KEY = "K001-a-private-application-key";
const ACCOUNT_TOKEN = "private-account-authorization-token";
const BUCKET = "photo-booth-tests";
const DOWNLOAD = "https://f001.backblazeb2.com";
const UPLOAD = "https://pod-000-1007-13.backblaze.com/b2api/v4/b2_upload_file/bucket/upload";
type Upload = { fileName: string; headers: Headers; bytes: Buffer };

function backblazeMock(options: { prefix?: string; expireFirstUploadUrl?: boolean } = {}) {
  const uploads: Upload[] = [];
  let authorizations = 0;
  let uploadUrls = 0;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/b2_authorize_account")) {
      authorizations++;
      return Response.json({
        accountId: "account-001",
        authorizationToken: ACCOUNT_TOKEN,
        apiInfo: { storageApi: {
          apiUrl: "https://api001.backblazeb2.com",
          downloadUrl: DOWNLOAD,
          allowed: { capabilities: ["listBuckets", "writeFiles"], namePrefix: options.prefix ?? null },
        } },
      });
    }
    if (url.endsWith("/b2_list_buckets"))
      return Response.json({ buckets: [{ bucketId: "bucket-001", bucketName: BUCKET, bucketType: "allPublic" }] });
    if (url.endsWith("/b2_get_upload_url")) {
      // A cached account token that has expired is refused with a 401.
      if (options.expireFirstUploadUrl && uploadUrls++ === 0) return new Response("{}", { status: 401 });
      return Response.json({ uploadUrl: UPLOAD, authorizationToken: "private-upload-token" });
    }
    assert.equal(url, UPLOAD);
    const headers = new Headers(init.headers);
    const bytes = Buffer.from(init.body as Uint8Array);
    uploads.push({ fileName: decodeURIComponent(headers.get("X-Bz-File-Name")!), headers, bytes });
    return Response.json({
      fileName: decodeURIComponent(headers.get("X-Bz-File-Name")!),
      contentLength: bytes.length,
      contentSha1: createHash("sha1").update(bytes).digest("hex"),
    });
  };
  return { fetcher, uploads, get authorizations() { return authorizations; } };
}

let suiteDirectory: string;
let fixture = 0;
const originalDirectory = process.env.PHOTO_KIOSK_DATA_DIR;
async function isolated() {
  process.env.PHOTO_KIOSK_DATA_DIR = path.join(suiteDirectory, String(++fixture));
  await readStudio();
  await updateSettings({ b2: { enabled: true, keyId: "001keyid001", applicationKey: KEY, bucketName: BUCKET } });
}
async function photo(name: string, width = 64, height = 40, format: "png" | "jpeg" = "jpeg") {
  const image = sharp({ create: { width, height, channels: 3, background: "#c98b3a" } });
  const bytes = format === "png" ? await image.png().toBuffer() : await image.jpeg().toBuffer();
  return new File([new Uint8Array(bytes)], name, { type: `image/${format}` });
}

describe("Photo albums", { concurrency: false }, () => {
  before(async () => {
    suiteDirectory = await mkdtemp(path.join(tmpdir(), "photo-kiosk-album-tests-"));
  });
  after(async () => {
    if (originalDirectory === undefined) delete process.env.PHOTO_KIOSK_DATA_DIR;
    else process.env.PHOTO_KIOSK_DATA_DIR = originalDirectory;
    await rm(suiteDirectory, { recursive: true, force: true });
  });

  test("uploads each photo with a thumbnail into the album's folder, signing in once", async () => {
    await isolated();
    const mock = backblazeMock({ prefix: "booth" });
    const album = await createAlbum("  Diwali night  ");
    assert.equal(album.title, "Diwali night");
    await addAlbumPhoto(album.id, await photo("IMG_0002.jpg", 5000, 2500), 2, mock.fetcher);
    await addAlbumPhoto(album.id, await photo("IMG_0001.png", 30, 20, "png"), 1, mock.fetcher);
    const updated = await addAlbumPhoto(album.id, await photo("IMG_0003.JPG"), 3, mock.fetcher);

    assert.equal(mock.authorizations, 1, "Photos should reuse one Backblaze sign-in");
    const folder = `booth/photo-albums/${album.id}/`;
    assert.equal(updated.baseUrl, `${DOWNLOAD}/file/${BUCKET}/${folder}`);
    assert.equal(mock.uploads.length, 6);
    for (const upload of mock.uploads) {
      assert.ok(upload.fileName.startsWith(folder));
      assert.equal(upload.headers.get("Content-Type"), "image/jpeg");
    }
    // Photos keep the order they were chosen in, whatever order they arrive.
    assert.deepEqual(updated.photos.map((item) => item.name), ["IMG_0001.jpg", "IMG_0002.jpg", "IMG_0003.jpg"]);
    assert.equal(updated.revision, 3);
    // Big photos are capped at 4096 px; their previews at 1080 px.
    const big = updated.photos[1];
    assert.deepEqual([big.width, big.height], [4096, 2048]);
    const bigFull = mock.uploads.find((upload) => upload.fileName === folder + big.file)!;
    const bigThumb = mock.uploads.find((upload) => upload.fileName === folder + big.thumb)!;
    assert.deepEqual(await sharp(bigFull.bytes).metadata().then(({ width, height, format }) => [width, height, format]), [4096, 2048, "jpeg"]);
    assert.deepEqual(await sharp(bigThumb.bytes).metadata().then(({ width, height }) => [width, height]), [1080, 540]);
    // Small photos are never enlarged.
    assert.deepEqual([updated.photos[0].width, updated.photos[0].height], [30, 20]);
  });

  test("publishes a self-contained album page with relative links and escaped file names", async () => {
    await isolated();
    const mock = backblazeMock();
    const album = await createAlbum('<img src=x onerror="alert(1)"> & friends');
    await assert.rejects(publishAlbum(album.id, mock.fetcher), /Add at least one photo/);
    await addAlbumPhoto(album.id, await photo('a"><script>bad()</script>.jpg'), 1, mock.fetcher);
    const withPhotos = await addAlbumPhoto(album.id, await photo("b.jpg"), 2, mock.fetcher);
    const published = await publishAlbum(album.id, mock.fetcher);

    const page = mock.uploads.at(-1)!;
    assert.equal(page.fileName, `photo-albums/${album.id}/index.html`);
    assert.equal(page.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(published.galleryUrl, `${withPhotos.baseUrl}index.html`);
    assert.equal(published.publishedRevision, published.revision);
    const html = page.bytes.toString("utf8");
    // The album's name is for Admin only.
    assert.ok(!html.includes("onerror") && !html.includes("friends"));
    assert.ok(!html.includes("<script>bad()"));
    assert.ok(html.includes('download="a script bad() script.jpg"'));
    for (const [index, item] of withPhotos.photos.entries()) {
      assert.ok(html.includes(`<a href="${item.file}" target="_blank" rel="noopener" data-view="${index}">View photo ${index + 1}</a>`));
      assert.ok(html.includes(`src="${item.thumb}"`));
    }
    for (const value of [KEY, ACCOUNT_TOKEN, "private-upload-token", "localhost", "/api/"])
      assert.ok(!html.includes(value), `Album page leaked ${value}`);
  });

  test("album pages use the booth gallery's wording", async () => {
    const photos = [1, 2, 3].map((number) => ({
      id: String(number), name: `IMG_${number}.jpg`, width: 3000, height: 2000,
      file: `photos/${number}.jpg`, thumb: `thumbs/${number}.jpg`, order: number, uploadedAt: "",
    }));
    const album = renderAlbumPage({ photos });
    const booth = renderPhotoGallery();
    for (const text of [
      "<title>BAPS Edison Diwali 2026 · Your photos</title>",
      "<h1>Your photos</h1>",
      '<p class="event-name">BAPS Edison Diwali 2026</p>',
      ">Open a photo and press and hold it to see your phone's save options.</p>",
      ">Download all 3 photos</button>",
      ">Downloads 3 separate JPEGs. Individual downloads are below.</p>",
      "<noscript><p>Use the Download link below each photo to save it.</p></noscript>",
      'aria-label="Your 3 photos"',
      ">View photo 2</a>",
      ">Download</a>",
      "<footer><p>On a phone, you can also open a photo and press and hold it to see its save options.</p></footer>",
      ">Save to phone</button>",
      " requested. If your browser asks, allow multiple downloads. You can also use each photo's Download link below.",
    ]) {
      assert.ok(booth.includes(text.replace('"Your 3 photos"', '"Your three photos"')), `Booth gallery no longer says ${text}`);
      assert.ok(album.includes(text), `Album page is missing ${text}`);
    }
    assert.match(renderAlbumPage({ photos: photos.slice(0, 1) }), />Download all 1 photo<\/button>[\s\S]*Downloads 1 separate JPEG\. /);
  });

  test("Download all requests every photo and the viewer steps through them", () => {
    const photos = Array.from({ length: 5 }, (_, index) => ({
      id: String(index), name: `IMG_${index}.jpg`, width: 3000, height: 2000,
      file: `photos/${index}.jpg`, thumb: `thumbs/${index}.jpg`, order: index, uploadedAt: "",
    }));
    const html = renderAlbumPage({ photos });
    const listeners = new Map<string, Array<(event?: unknown) => void>>();
    const element = (id: string, extra: Record<string, unknown> = {}) => ({
      id, textContent: "", disabled: true, hidden: false, href: "", download: "", src: "", alt: "",
      addEventListener: (event: string, listener: (event?: unknown) => void) =>
        listeners.set(`${id}:${event}`, [...(listeners.get(`${id}:${event}`) ?? []), listener]),
      ...extra,
    });
    const clicked: string[] = [];
    const downloads = photos.map((item) => ({
      href: item.file, download: item.name, getAttribute: () => item.file, click: () => clicked.push(item.name),
    }));
    const thumbs = photos.map((item, index) => ({ src: item.thumb, currentSrc: "", alt: `Photo ${index + 1}` }));
    const openers = photos.map((_, index) => element(`view-${index}`, { dataset: { view: String(index) } }));
    const elements = Object.fromEntries(["download-all", "download-help", "viewer-stage", "viewer-image", "viewer-count",
      "viewer-download", "viewer-share", "viewer-close", "viewer-prev", "viewer-next"].map((id) => [id, element(id)]));
    let opened = 0;
    elements.viewer = element("viewer", { showModal: () => opened++, close: () => {} });
    const timers: Array<{ callback: () => void; delay: number }> = [];
    new Script(/<script>([\s\S]+)<\/script>/.exec(html)![1]).runInNewContext({
      navigator: {},
      Image: class { onload?: () => void; src = ""; },
      Number,
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: (selector: string) => ({
          "a[data-photo-download]": downloads,
          ".photo-link img": thumbs,
          "[data-view]": openers,
        })[selector],
      },
      setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }),
    });
    const fire = (key: string, event?: unknown) => listeners.get(key)!.forEach((listener) => listener(event));

    assert.equal(elements["download-all"].disabled, false);
    fire("download-all:click");
    assert.equal(elements["download-all"].disabled, true);
    assert.equal(elements["download-help"].textContent,
      "5 JPEG downloads requested. If your browser asks, allow multiple downloads. You can also use each photo's Download link below.");
    for (const timer of timers.splice(0)) timer.callback();
    assert.deepEqual(clicked, photos.map((item) => item.name));
    assert.equal(elements["download-all"].disabled, false);

    fire("view-3:click", { preventDefault() {}, button: 0 });
    assert.equal(opened, 1);
    assert.equal(elements["viewer-count"].textContent, "4 of 5");
    assert.equal(elements["viewer-download"].download, "IMG_3.jpg");
    fire("viewer-next:click");
    fire("viewer-next:click");
    assert.equal(elements["viewer-count"].textContent, "1 of 5");
    fire("viewer-prev:click");
    assert.equal(elements["viewer-count"].textContent, "5 of 5");
    // Without a share sheet, Save to phone stays hidden.
    assert.equal(elements["viewer-share"].hidden, false);
    assert.equal(listeners.has("viewer-share:click"), false);
  });

  test("tracks unpublished changes, and republishing reflects removals", async () => {
    await isolated();
    const mock = backblazeMock();
    const album = await createAlbum("Rangoli");
    await addAlbumPhoto(album.id, await photo("one.jpg"), 1, mock.fetcher);
    const two = await addAlbumPhoto(album.id, await photo("two.jpg"), 2, mock.fetcher);
    const first = await publishAlbum(album.id, mock.fetcher);
    // The name isn't on the page, so renaming leaves it up to date.
    const renamed = await renameAlbum(album.id, "Rangoli contest");
    assert.equal(renamed.title, "Rangoli contest");
    assert.equal(renamed.revision, first.publishedRevision);
    const removed = await removeAlbumPhoto(album.id, two.photos[0].id);
    assert.ok(removed.revision > (removed.publishedRevision ?? 0));
    assert.equal(removed.photos.length, 1);
    await assert.rejects(removeAlbumPhoto(album.id, two.photos[0].id), (error: unknown) => error instanceof StudioError && error.status === 404);
    const republished = await publishAlbum(album.id, mock.fetcher);
    assert.equal(republished.publishedRevision, republished.revision);
    const html = mock.uploads.at(-1)!.bytes.toString("utf8");
    assert.ok(!html.includes(two.photos[0].file));
    assert.match(html, />Download all 1 photo</);
  });

  test("signs in again when a reused authorization has expired", async () => {
    await isolated();
    const mock = backblazeMock({ expireFirstUploadUrl: true });
    const album = await createAlbum("Retry");
    const updated = await addAlbumPhoto(album.id, await photo("retry.jpg"), 1, mock.fetcher);
    assert.equal(updated.photos.length, 1);
    assert.equal(mock.authorizations, 2);
  });

  test("rejects unreadable files before anything is uploaded", async () => {
    await isolated();
    const mock = backblazeMock();
    const album = await createAlbum("Bad files");
    const junk = new File([new Uint8Array([1, 2, 3, 4])], "notes.jpg", { type: "image/jpeg" });
    await assert.rejects(addAlbumPhoto(album.id, junk, 1, mock.fetcher), /could not be read/);
    const empty = new File([], "empty.jpg", { type: "image/jpeg" });
    await assert.rejects(addAlbumPhoto(album.id, empty, 1, mock.fetcher), /is empty/);
    await assert.rejects(addAlbumPhoto("missing", await photo("x.jpg"), 1, mock.fetcher), /Album not found/);
    await assert.rejects(createAlbum(" "), /up to 80 characters/);
    assert.equal(mock.uploads.length, 0);
  });

  test("deleting a published album replaces its page before removing it", async () => {
    await isolated();
    const mock = backblazeMock();
    const draft = await createAlbum("Draft");
    const album = await createAlbum("Published");
    await addAlbumPhoto(album.id, await photo("p.jpg"), 1, mock.fetcher);
    await publishAlbum(album.id, mock.fetcher);
    const before = mock.uploads.length;
    assert.deepEqual(await deleteAlbum(album.id, mock.fetcher), { success: true });
    assert.equal(mock.uploads.length, before + 1);
    const notice = mock.uploads.at(-1)!;
    assert.equal(notice.fileName, `photo-albums/${album.id}/index.html`);
    assert.match(notice.bytes.toString("utf8"), /no longer available/);
    // An unpublished album has no page to take down.
    assert.deepEqual(await deleteAlbum(draft.id, mock.fetcher), { success: true });
    assert.equal(mock.uploads.length, before + 1);
    assert.deepEqual(await listAlbums(), []);
  });

  test("album routes are local-only", async () => {
    await isolated();
    const created = await createPOST(new Request("http://127.0.0.1:3000/api/albums", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "From Admin" }),
    }));
    assert.equal(created.status, 201);
    const listed = await listGET(new Request("http://127.0.0.1:3000/api/albums"));
    assert.deepEqual((await listed.json()).albums.map((album: { title: string }) => album.title), ["From Admin"]);
    const foreign = await createPOST(new Request("http://127.0.0.1:3000/api/albums", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ title: "Nope" }),
    }));
    assert.equal(foreign.status, 403);
  });
});
