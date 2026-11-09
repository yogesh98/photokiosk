import { diwaliLogoSVG } from "./diwali-logo";
import type { PhotoAlbum } from "./kiosk-types";
import { getPhotoGalleryAssets } from "./photo-gallery-assets";
import { GALLERY_EVENT_NAME } from "./photo-gallery";

/** Longest side of the preview uploaded next to each photo. Sharp on a phone's single-column layout. */
export const ALBUM_THUMB_SIZE = 1080;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => ENTITIES[character]);
}

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

function thumbSize(width: number, height: number) {
  const scale = Math.min(1, ALBUM_THUMB_SIZE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The album's public page. It uses the booth gallery's design and wording
 * (renderPhotoGallery in photo-gallery.ts) for any number of photos, plus a
 * full-size viewer. The album's name is for Admin only. It is uploaded as
 * index.html next to the photos, so links are relative and fonts are inlined.
 */
export function renderAlbumPage(album: Pick<PhotoAlbum, "photos">): string {
  const title = GALLERY_EVENT_NAME;
  const assets = getPhotoGalleryAssets();
  const count = album.photos.length;
  const photos = `${count} photo${count === 1 ? "" : "s"}`;
  const jpegs = `${count} separate JPEG${count === 1 ? "" : "s"}`;
  const articles = album.photos.map((photo, index) => {
    const number = index + 1;
    const thumb = thumbSize(photo.width, photo.height);
    const file = escape(photo.file);
    return `
  <article>
    <a class="photo-link" href="${file}" target="_blank" rel="noopener" data-view="${index}"><img src="${escape(photo.thumb)}" alt="Photo ${number}" width="${thumb.width}" height="${thumb.height}" loading="${index < 6 ? "eager" : "lazy"}" decoding="async"></a>
    <nav aria-label="Photo ${number}"><a href="${file}" target="_blank" rel="noopener" data-view="${index}">View photo ${number}</a><a href="${file}" download="${escape(photo.name)}" data-photo-download>Download</a></nav>
  </article>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0c0a12"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>${title} · Your photos</title>
<style>
@font-face{font-family:Dehanna;src:url("${assets.dehanna}") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:Figtree;src:url("${assets.figtreeRegular}") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:Figtree;src:url("${assets.figtreeBold}") format("woff2");font-weight:700;font-display:swap}
:root{color-scheme:dark;--ink:#0c0a12;--panel:#15111c;--gold:#e8c879;--gold-hi:#fff1c4;--text:#f1e4c2;--muted:rgba(241,228,194,.7);--line:rgba(232,200,121,.42)}
*{box-sizing:border-box}
html:has(dialog[open]){overflow:hidden}
body{margin:0;min-height:100dvh;background:var(--ink);color:var(--text);font:16px/1.5 Figtree,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent}
main{max-width:1080px;margin:auto;padding:36px 28px max(48px,env(safe-area-inset-bottom))}
header{text-align:center}
.brand{display:block;width:min(100%,420px);height:auto;margin:0 auto}
.brand .dl-glow,.brand .dl-sheen{display:none}
h1{margin:22px 0 0;font:400 clamp(52px,14vw,92px)/1.02 Dehanna,Didot,Georgia,serif;color:var(--gold)}
.event-name{margin:10px 0 0;font-size:13px;font-weight:700;letter-spacing:.32em;text-transform:uppercase;color:var(--muted);overflow-wrap:anywhere}
.actions{max-width:520px;margin:26px auto 40px;padding:22px;border:1px solid var(--line);border-radius:26px;background:var(--panel)}
.button{display:flex;align-items:center;justify-content:center;min-height:56px;width:100%;padding:13px 18px;border:2px solid var(--gold);border-radius:999px;background:var(--gold);color:#1a1206;font:700 18px/1.3 Figtree,system-ui,sans-serif;text-decoration:none;cursor:pointer;touch-action:manipulation}
.button:disabled{opacity:.55;cursor:wait}
.button.secondary{min-height:52px;border-color:var(--line);background:transparent;color:var(--text)}
.download-help{margin:12px 0 20px;font-size:14px;line-height:1.45;color:var(--muted);overflow-wrap:anywhere}
#save-help{margin-top:0}
#download-help{margin-bottom:0}
:is(button,a):focus-visible{outline:3px solid var(--gold-hi);outline-offset:4px}
/* Every preview gets the same 3:2 frame so mixed portrait and landscape rows line up. */
.photos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}
article{min-width:0;padding:10px;border:1px solid var(--line);border-radius:22px;background:var(--panel)}
.photo-link{display:block;border-radius:14px;overflow:hidden;aspect-ratio:3/2;background:var(--ink)}
.photo-link img{display:block;width:100%;height:100%;object-fit:contain}
nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:12px 2px 0;font-size:15px;font-weight:700}
nav a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 8px;border-radius:999px;color:var(--gold);text-underline-offset:4px;touch-action:manipulation}
nav a[data-photo-download]{padding-inline:17px;background:var(--gold);color:#1a1206;text-decoration:none}
.empty{max-width:520px;margin:0 auto;text-align:center;color:var(--muted)}
footer{max-width:520px;margin:34px auto 0;padding:14px 20px;border:1px solid var(--line);border-radius:20px;text-align:center;font-size:14px;line-height:1.5;color:var(--muted)}
footer p{margin:0}
dialog{width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#08060c;color:var(--text);overflow:hidden}
dialog[open]{display:flex;flex-direction:column}
dialog::backdrop{background:#08060c}
.viewer-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:max(12px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) 12px max(16px,env(safe-area-inset-left))}
#viewer-count{margin:0;font-size:15px;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.viewer-actions{display:flex;align-items:center;gap:8px}
.chip{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--text);font:700 15px/1.2 Figtree,system-ui,sans-serif;text-decoration:none;white-space:nowrap;cursor:pointer;touch-action:manipulation}
.chip.solid{border-color:var(--gold);background:var(--gold);color:#1a1206}
.chip[hidden],.round[hidden]{display:none}
.chip:disabled{opacity:.55;cursor:wait}
.round{display:inline-grid;place-items:center;flex-shrink:0;width:46px;height:46px;padding:0;border:1px solid var(--line);border-radius:50%;background:rgba(21,17,28,.82);color:var(--text);cursor:pointer;touch-action:manipulation}
.round svg{width:22px;height:22px}
.viewer-stage{position:relative;flex:1 1 0;min-height:0;touch-action:pan-y pinch-zoom}
.viewer-frame{position:absolute;inset:0 76px max(16px,env(safe-area-inset-bottom))}
#viewer-image{display:block;width:100%;height:100%;object-fit:contain}
.nav{position:absolute;top:50%;transform:translateY(-50%)}
.nav.prev{left:max(16px,env(safe-area-inset-left))}
.nav.next{right:max(16px,env(safe-area-inset-right))}
@media(max-width:840px){main{padding:24px max(18px,env(safe-area-inset-left)) max(36px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-right))}.brand{width:min(100%,340px)}.actions{padding:18px;margin-bottom:30px}.photos{grid-template-columns:1fr;max-width:480px;margin:auto;gap:28px}.photo-link{aspect-ratio:auto}.photo-link img{height:auto}footer{margin-top:30px}}
@media(max-width:700px){.viewer-frame{inset:0 0 max(80px,calc(env(safe-area-inset-bottom) + 72px))}.nav{top:auto;bottom:max(16px,env(safe-area-inset-bottom));transform:none}.chip{padding:10px 14px;font-size:14px}}
</style></head>
<body><main>
<header>
  ${diwaliLogoSVG({ id: "gl", className: "brand" })}
  <h1>Your photos</h1>
  <p class="event-name">${title}</p>
  <div class="actions"${count ? "" : " hidden"}>
    <p class="download-help" id="save-help">Open a photo and press and hold it to see your phone's save options.</p>
    <button class="button secondary" id="download-all" type="button" aria-describedby="download-help" disabled>Download all ${photos}</button>
    <p class="download-help" id="download-help" role="status">Downloads ${jpegs}. Individual downloads are below.</p>
    <noscript><p>Use the Download link below each photo to save it.</p></noscript>
  </div>
</header>
${count
    ? `<section class="photos" aria-label="Your ${photos}">${articles}\n</section>`
    : `<p class="empty">There are no photos in this album right now.</p>`}
<footer><p>On a phone, you can also open a photo and press and hold it to see its save options.</p></footer>
</main>
<dialog id="viewer" aria-label="Photo viewer">
  <div class="viewer-bar">
    <p id="viewer-count" aria-live="polite"></p>
    <div class="viewer-actions">
      <button class="chip" id="viewer-share" type="button" hidden>Save to phone</button>
      <a class="chip solid" id="viewer-download" href="#" download>Download</a>
      <button class="round" id="viewer-close" type="button" aria-label="Close photo">${icon("M6 6l12 12M18 6L6 18")}</button>
    </div>
  </div>
  <div class="viewer-stage" id="viewer-stage">
    <div class="viewer-frame"><img id="viewer-image" alt=""></div>
    <button class="round nav prev" id="viewer-prev" type="button" aria-label="Previous photo"${count > 1 ? "" : " hidden"}>${icon("M15 5l-7 7 7 7")}</button>
    <button class="round nav next" id="viewer-next" type="button" aria-label="Next photo"${count > 1 ? "" : " hidden"}>${icon("M9 5l7 7-7 7")}</button>
  </div>
</dialog>
<script>
const downloads = Array.from(document.querySelectorAll("a[data-photo-download]"));
const thumbs = Array.from(document.querySelectorAll(".photo-link img"));

const button = document.getElementById("download-all");
const help = document.getElementById("download-help");
button.disabled = downloads.length === 0;
button.addEventListener("click", () => {
  button.disabled = true;
  downloads.forEach((photo, index) => setTimeout(() => photo.click(), index * 400));
  help.textContent = downloads.length + (downloads.length === 1 ? " JPEG download" : " JPEG downloads") + " requested. If your browser asks, allow multiple downloads. You can also use each photo's Download link below.";
  setTimeout(() => { button.disabled = false; }, downloads.length * 400);
});

// Full-size viewer, opened from a photo or its View photo link.
const viewer = document.getElementById("viewer");
const stage = document.getElementById("viewer-stage");
const image = document.getElementById("viewer-image");
const counter = document.getElementById("viewer-count");
const download = document.getElementById("viewer-download");
const shareButton = document.getElementById("viewer-share");
let current = 0;
let loading = 0;
let prepared = null;

function show(index) {
  current = (index + downloads.length) % downloads.length;
  const full = downloads[current].getAttribute("href");
  // Show the preview at once, then swap in the full photo when it arrives.
  image.src = thumbs[current].currentSrc || thumbs[current].src;
  image.alt = thumbs[current].alt;
  const token = ++loading;
  const loader = new Image();
  loader.onload = () => { if (token === loading) image.src = full; };
  loader.src = full;
  for (const offset of [1, -1]) {
    if (downloads.length > 1) new Image().src = downloads[(current + offset + downloads.length) % downloads.length].getAttribute("href");
  }
  download.href = full;
  download.download = downloads[current].download;
  counter.textContent = (current + 1) + " of " + downloads.length;
  prepared = null;
  shareButton.disabled = false;
  shareButton.textContent = "Save to phone";
}
document.querySelectorAll("[data-view]").forEach((link) => link.addEventListener("click", (event) => {
  if (typeof viewer.showModal !== "function" || event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
  event.preventDefault();
  show(Number(link.dataset.view));
  viewer.showModal();
}));
document.getElementById("viewer-close").addEventListener("click", () => viewer.close());
document.getElementById("viewer-prev").addEventListener("click", () => show(current - 1));
document.getElementById("viewer-next").addEventListener("click", () => show(current + 1));
stage.addEventListener("click", (event) => { if (event.target === stage) viewer.close(); });
viewer.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") show(current + 1);
  if (event.key === "ArrowLeft") show(current - 1);
});
let touch = null;
stage.addEventListener("touchstart", (event) => {
  touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
}, { passive: true });
stage.addEventListener("touchend", (event) => {
  if (!touch || downloads.length < 2) return;
  const dx = event.changedTouches[0].clientX - touch.x;
  const dy = event.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(current + (dx < 0 ? 1 : -1));
}, { passive: true });

// Save to phone opens the share menu for the photo being viewed.
if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
  shareButton.hidden = false;
  shareButton.addEventListener("click", async () => {
    const index = current;
    if (!prepared || prepared.index !== index) {
      shareButton.disabled = true;
      shareButton.textContent = "Preparing photo…";
      try {
        const photo = downloads[index];
        const response = await fetch(photo.href, { credentials: "omit", cache: "force-cache" });
        if (!response.ok) throw new Error("Photo unavailable");
        const file = new File([await response.blob()], photo.download, { type: "image/jpeg" });
        let supported = false;
        try { supported = navigator.canShare({ files: [file] }); } catch {}
        if (!supported) {
          shareButton.hidden = true;
          return;
        }
        if (index !== current) return;
        prepared = { index, file };
      } catch {
        if (index === current) {
          shareButton.disabled = false;
          shareButton.textContent = "Retry preparing photo";
        }
        return;
      }
      shareButton.disabled = false;
    }
    try {
      await navigator.share({ files: [prepared.file] });
      shareButton.textContent = "Save to phone";
    } catch (error) {
      // Preparing can outlast the tap's permission on a slow connection.
      // The photo is ready now, so the next tap opens the menu at once.
      shareButton.textContent = error && error.name === "NotAllowedError" ? "Tap again to save" : "Save to phone";
    }
  });
}
</script></body></html>`;
}

/** Replaces index.html when an album is deleted, so its link and QR code stop showing photos. */
export function renderRemovedAlbumPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0c0a12"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>${GALLERY_EVENT_NAME}</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#0c0a12;color:#f1e4c2;font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}h1{margin:0 0 8px;font:400 34px/1.2 Didot,Georgia,serif;color:#e8c879}p{margin:0;color:rgba(241,228,194,.7)}</style></head>
<body><main><h1>This album is no longer available.</h1><p>${GALLERY_EVENT_NAME}</p></main></body></html>`;
}
