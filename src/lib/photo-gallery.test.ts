import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import { renderPhotoGallery } from "./photo-gallery";

const GALLERY_URL = "https://f001.backblazeb2.com/file/photo-booth-tests/photo-booth/guest-session/index.html";
const PHOTO_BYTES = [1, 2, 3].map((number) => new Uint8Array([0xff, 0xd8, number, 0xff, 0xd9]));
type NativeSupport = "both" | "neither" | "share-only" | "can-share-only";
type HarnessOptions = {
  support?: NativeSupport;
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
  fetch?: typeof fetch;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jpegResponse(index: number) {
  return new Response(PHOTO_BYTES[index], { headers: { "Content-Type": "image/jpeg" } });
}

class MockControl {
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  private listeners: Array<() => unknown> = [];
  readonly pendingEvents: Promise<unknown>[] = [];

  constructor(html: string, id: string) {
    const tag = new RegExp(`<([a-z]+)\\b([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)<\\/\\1>`).exec(html);
    assert.ok(tag, `Missing gallery control ${id}`);
    this.disabled = /(?:^|\s)disabled(?:\s|$|=)/.test(tag[2]);
    this.hidden = /(?:^|\s)hidden(?:\s|$|=)/.test(tag[2]);
    this.textContent = tag[3];
  }

  addEventListener(event: string, listener: () => unknown) {
    assert.equal(event, "click");
    this.listeners.push(listener);
  }

  click() {
    if (this.disabled || this.hidden) return;
    for (const listener of this.listeners) {
      const result = listener();
      if (result instanceof Promise || (result && typeof (result as Promise<unknown>).then === "function"))
        this.pendingEvents.push(Promise.resolve(result));
    }
  }
}

function galleryHarness(options: HarnessOptions = {}) {
  const html = renderPhotoGallery("A day together");
  const controls = Object.fromEntries(["download-all", "download-help", "save-phone", "save-help"].map((id) => [id, new MockControl(html, id)]));
  const downloads: string[] = [];
  const links = Array.from(html.matchAll(/<a\b([^>]*\bdata-photo-download[^>]*)>/g), (match) => {
    const href = /\bhref="([^"]+)"/.exec(match[1])?.[1];
    const download = /\bdownload="([^"]+)"/.exec(match[1])?.[1];
    assert.ok(href && download);
    return {
      href: new URL(href, GALLERY_URL).href,
      download,
      click: () => { downloads.push(download); },
    };
  });
  assert.equal(links.length, 3);

  let timerNumber = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const canShareCalls: ShareData[] = [];
  const shareCalls: ShareData[] = [];
  const navigator: { share?: (data: ShareData) => Promise<void>; canShare?: (data: ShareData) => boolean } = {};
  const support = options.support || "both";
  if (support === "both" || support === "share-only")
    navigator.share = (data) => {
      shareCalls.push(data);
      return options.share ? options.share(data) : Promise.resolve();
    };
  if (support === "both" || support === "can-share-only")
    navigator.canShare = (data) => {
      canShareCalls.push(data);
      return options.canShare ? options.canShare(data) : true;
    };

  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "Gallery must include its progressive enhancement script");
  runInNewContext(script[1], {
    document: {
      getElementById: (id: string) => {
        assert.ok(controls[id], `Unknown gallery control ${id}`);
        return controls[id];
      },
      querySelectorAll: (selector: string) => {
        assert.equal(selector, "a[data-photo-download]");
        return links;
      },
    },
    navigator,
    File,
    Blob,
    AbortController,
    fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      assert.equal(new URL(url).origin, new URL(GALLERY_URL).origin);
      assert.ok(links.some((link) => link.href === url), `Unexpected photo request ${url}`);
      if (options.fetch) return options.fetch(input, init);
      return Promise.resolve(jpegResponse(links.findIndex((link) => link.href === url)));
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerNumber;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  });

  return {
    controls, links, downloads, timers, fetchCalls, canShareCalls, shareCalls,
    runDownloadTimers() {
      for (const [id, timer] of [...timers].sort((left, right) => left[1].delay - right[1].delay)) {
        if (timer.delay >= 20_000) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

async function settle() {
  // Flush the actual Response.blob/File and VM async continuations without
  // running gallery timers or depending on elapsed wall-clock delays.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function assertPhotoFiles(data: ShareData) {
  assert.deepEqual(Object.keys(data), ["files"]);
  assert.equal(data.files?.length, 3);
  for (let index = 0; index < 3; index++) {
    const file: File = data.files![index];
    assert.ok(file instanceof File);
    assert.equal(file.name, `photo-booth-${index + 1}.jpg`);
    assert.equal(file.type, "image/jpeg");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PHOTO_BYTES[index]);
  }
}

describe("gallery phone saving", () => {
  test("prepares all three JPEG files before enabling Save and invokes native sharing synchronously on the next tap", async () => {
    const responses = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    const sharing = deferred<void>();
    let nextPhoto = 0;
    const harness = galleryHarness({ fetch: async () => responses[nextPhoto++].promise, share: () => sharing.promise });
    const save = harness.controls["save-phone"];
    assert.equal(harness.fetchCalls.length, 3);
    assert.equal(save.hidden, false);
    assert.equal(save.disabled, true);
    assert.match(save.textContent, /Preparing 3 photos/);
    assert.equal(harness.canShareCalls.length, 0);
    assert.equal(harness.shareCalls.length, 0);

    responses[0].resolve(jpegResponse(0));
    responses[1].resolve(jpegResponse(1));
    await settle();
    assert.equal(save.disabled, true);
    assert.equal(harness.canShareCalls.length, 0);
    assert.equal(harness.shareCalls.length, 0);
    responses[2].resolve(jpegResponse(2));
    await settle();

    assert.equal(save.disabled, false);
    assert.equal(save.textContent, "Save to phone");
    assert.equal(harness.canShareCalls.length, 1);
    await assertPhotoFiles(harness.canShareCalls[0]);
    assert.equal(harness.shareCalls.length, 0);
    assert.equal(harness.timers.size, 0, "Preparation must clear its network timeout");
    save.click();
    assert.equal(harness.shareCalls.length, 1, "Native sharing must be called inside the click before any asynchronous work");
    assert.equal(save.disabled, true);
    await assertPhotoFiles(harness.shareCalls[0]);
    sharing.resolve();
    await settle();
    assert.equal(save.disabled, false);
    assert.match(harness.controls["save-help"].textContent, /Check your chosen app/);
    assert.doesNotMatch(harness.controls["save-help"].textContent, /saved|success/i);
    assert.deepEqual(harness.downloads, []);
  });

  test("leaves individual and staggered downloads available without fetching when file sharing is unsupported", async () => {
    for (const support of ["neither", "share-only", "can-share-only"] as const) {
      const harness = galleryHarness({ support });
      await settle();
      assert.equal(harness.controls["save-phone"].hidden, true);
      assert.equal(harness.fetchCalls.length, 0);
      assert.equal(harness.canShareCalls.length, 0);
      assert.equal(harness.shareCalls.length, 0);
      assert.equal(harness.controls["download-all"].disabled, false);
      harness.controls["download-all"].click();
      assert.equal(harness.controls["download-all"].disabled, true);
      assert.deepEqual(harness.downloads, []);
      assert.deepEqual([...harness.timers.values()].map((timer) => timer.delay), [0, 400, 800, 1200]);
      harness.runDownloadTimers();
      assert.deepEqual(harness.downloads, ["photo-booth-1.jpg", "photo-booth-2.jpg", "photo-booth-3.jpg"]);
      assert.equal(harness.controls["download-all"].disabled, false);
    }
  });

  test("hides native saving when the browser rejects the complete file set, keeping download fallback", async () => {
    for (const canShare of [() => false, () => { throw new Error("File sharing unsupported"); }]) {
      const harness = galleryHarness({ canShare });
      await settle();
      assert.equal(harness.fetchCalls.length, 3);
      assert.equal(harness.canShareCalls.length, 1);
      await assertPhotoFiles(harness.canShareCalls[0]);
      assert.equal(harness.controls["save-phone"].hidden, true);
      assert.match(harness.controls["save-help"].textContent, /cannot save all three together/);
      assert.equal(harness.shareCalls.length, 0);
      harness.controls["download-all"].click();
      harness.runDownloadTimers();
      assert.equal(harness.downloads.length, 3);
    }
  });

  test("a cancelled share sheet never downloads files or claims they were saved", async () => {
    const harness = galleryHarness({ share: async () => { throw new DOMException("Cancelled", "AbortError"); } });
    await settle();
    harness.controls["save-phone"].click();
    assert.equal(harness.shareCalls.length, 1);
    await settle();
    harness.runDownloadTimers();
    assert.deepEqual(harness.downloads, []);
    assert.equal(harness.controls["save-phone"].disabled, false);
    assert.match(harness.controls["save-help"].textContent, /save menu was closed/);
    assert.doesNotMatch(harness.controls["save-help"].textContent, /saved|success/i);
  });

  test("a failed fetch retries the complete set and requires a fresh tap after preparation before sharing", async () => {
    let requests = 0;
    const retryResponses = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    const harness = galleryHarness({ fetch: async () => {
      const request = requests++;
      if (request === 1) throw new Error("Network offline");
      if (request < 3) return jpegResponse(request);
      return retryResponses[request - 3].promise;
    } });
    await settle();
    const save = harness.controls["save-phone"];
    assert.equal(harness.fetchCalls.length, 3);
    assert.equal(save.disabled, false);
    assert.equal(save.textContent, "Retry preparing photos");
    assert.equal(harness.canShareCalls.length, 0);
    assert.equal(harness.shareCalls.length, 0);

    save.click();
    assert.equal(harness.fetchCalls.length, 6, "Retry must fetch all three, never share a partial set");
    assert.equal(save.disabled, true);
    assert.equal(harness.shareCalls.length, 0);
    retryResponses.forEach((response, index) => response.resolve(jpegResponse(index)));
    await settle();
    assert.equal(save.disabled, false);
    assert.equal(save.textContent, "Save to phone");
    assert.equal(harness.shareCalls.length, 0, "Finishing preparation must not consume the earlier tap to share");
    await assertPhotoFiles(harness.canShareCalls[0]);
    save.click();
    assert.equal(harness.shareCalls.length, 1);
    await assertPhotoFiles(harness.shareCalls[0]);
    await settle();
    assert.deepEqual(harness.downloads, []);
  });

  test("empty, non-JPEG, and unsuccessful responses cannot become native photo files", async () => {
    for (const response of [
      () => new Response(new Uint8Array(), { headers: { "Content-Type": "image/jpeg" } }),
      () => new Response("An HTML error", { headers: { "Content-Type": "text/html" } }),
      () => new Response("Not found", { status: 404, headers: { "Content-Type": "image/jpeg" } }),
    ]) {
      const harness = galleryHarness({ fetch: async () => response() });
      await settle();
      assert.equal(harness.controls["save-phone"].textContent, "Retry preparing photos");
      assert.equal(harness.controls["save-phone"].disabled, false);
      assert.equal(harness.canShareCalls.length, 0);
      assert.equal(harness.shareCalls.length, 0);
      assert.equal(harness.controls["download-all"].disabled, false);
    }
  });

  test("a native permission error gives recovery guidance without claiming the photos were saved", async () => {
    const harness = galleryHarness({ share: async () => { throw new DOMException("User activation required", "NotAllowedError"); } });
    await settle();
    harness.controls["save-phone"].click();
    assert.equal(harness.shareCalls.length, 1);
    await settle();
    harness.runDownloadTimers();
    assert.equal(harness.controls["save-phone"].disabled, false);
    assert.match(harness.controls["save-help"].textContent, /couldn't open the save menu/);
    assert.match(harness.controls["save-help"].textContent, /press and hold/);
    assert.doesNotMatch(harness.controls["save-help"].textContent, /saved|success/i);
    assert.deepEqual(harness.downloads, []);
  });
});
