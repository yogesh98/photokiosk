import { getPhotoGalleryAssets } from "./photo-gallery-assets";
import { diwaliLogoSVG } from "./diwali-logo";

// Every guest's download page carries this name, whatever the booth's workspace is called in Admin.
export const GALLERY_EVENT_NAME = "BAPS Edison Diwali 2026";

export function renderPhotoGallery(): string {
  const title = GALLERY_EVENT_NAME;
  const assets = getPhotoGalleryAssets();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0c0a12"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>${title} · Your photos</title>
<style>
@font-face{font-family:Dehanna;src:url("${assets.dehanna}") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:Figtree;src:url("${assets.figtreeRegular}") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:Figtree;src:url("${assets.figtreeBold}") format("woff2");font-weight:700;font-display:swap}
:root{color-scheme:dark;--ink:#0c0a12;--panel:#15111c;--gold:#e8c879;--gold-hi:#fff1c4;--text:#f1e4c2;--muted:rgba(241,228,194,.7);--line:rgba(232,200,121,.42)}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--ink);color:var(--text);font:16px/1.5 Figtree,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent}
main{max-width:1080px;margin:auto;padding:36px 28px max(48px,env(safe-area-inset-bottom))}
header{text-align:center}
.brand{display:block;width:min(100%,420px);height:auto;margin:0 auto}
.brand .dl-glow,.brand .dl-sheen{display:none}
h1{margin:22px 0 0;font:400 clamp(52px,14vw,92px)/1.02 Dehanna,Didot,Georgia,serif;color:var(--gold)}
.event-name{margin:10px 0 0;font-size:13px;font-weight:700;letter-spacing:.32em;text-transform:uppercase;color:var(--muted);overflow-wrap:anywhere}
.intro{margin:18px 0 0;font-size:20px;font-weight:700;line-height:1.4}
.actions{max-width:520px;margin:26px auto 40px;padding:22px;border:1px solid var(--line);border-radius:26px;background:var(--panel)}
.button{display:flex;align-items:center;justify-content:center;min-height:56px;width:100%;padding:13px 18px;border:2px solid var(--gold);border-radius:999px;background:var(--gold);color:#1a1206;font:700 18px/1.3 Figtree,system-ui,sans-serif;text-decoration:none;cursor:pointer;touch-action:manipulation}
.button[hidden]{display:none}
.button:disabled{opacity:.55;cursor:wait}
.button.secondary{min-height:52px;border-color:var(--line);background:transparent;color:var(--text)}
.download-help{margin:12px 0 20px;font-size:14px;line-height:1.45;color:var(--muted);overflow-wrap:anywhere}
#download-help{margin-bottom:0}
:is(button,a):focus-visible{outline:3px solid var(--gold-hi);outline-offset:4px}
.photos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}
article{min-width:0;padding:10px;border:1px solid var(--line);border-radius:22px;background:var(--panel)}
.photo-link{display:block;border-radius:14px;overflow:hidden}
.photo-link img{display:block;width:100%;height:auto}
nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:12px 2px 0;font-size:15px;font-weight:700}
nav a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 8px;border-radius:999px;color:var(--gold);text-underline-offset:4px;touch-action:manipulation}
nav a[data-photo-download]{padding-inline:17px;background:var(--gold);color:#1a1206;text-decoration:none}
footer{max-width:520px;margin:34px auto 0;padding:14px 20px;border:1px solid var(--line);border-radius:20px;text-align:center;font-size:14px;line-height:1.5;color:var(--muted)}
footer p{margin:0}
@media(max-width:840px){main{padding:24px max(18px,env(safe-area-inset-left)) max(36px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-right))}.brand{width:min(100%,340px)}.actions{padding:18px;margin-bottom:30px}.photos{grid-template-columns:1fr;max-width:480px;margin:auto;gap:28px}.intro{font-size:19px}footer{margin-top:30px}}
</style></head>
<body><main>
<header>
  ${diwaliLogoSVG({ id: "gl", className: "brand" })}
  <h1>Your photos</h1>
  <p class="event-name">${title}</p>
  <p class="intro">All three photos, ready to keep.</p>
  <div class="actions">
    <button class="button" id="save-phone" type="button" aria-describedby="save-help" hidden disabled>Save to phone</button>
    <p class="download-help" id="save-help" role="status">Open a photo and press and hold it to see your phone's save options.</p>
    <button class="button secondary" id="download-all" type="button" aria-describedby="download-help" disabled>Download all 3 photos</button>
    <p class="download-help" id="download-help" role="status">Downloads 3 separate JPEGs. Individual downloads are below.</p>
    <noscript><p>Use the Download link below each photo to save it.</p></noscript>
  </div>
</header>
<section class="photos" aria-label="Your three photos">${[1, 2, 3].map((number) => `
  <article>
    <a class="photo-link" href="${number}.jpg" target="_blank" rel="noopener"><img src="${number}.jpg" alt="Photo booth photo ${number}" loading="${number === 1 ? "eager" : "lazy"}"></a>
    <nav aria-label="Photo ${number}"><a href="${number}.jpg" target="_blank" rel="noopener">View photo ${number}</a><a href="${number}.jpg" download="photo-booth-${number}.jpg" data-photo-download>Download</a></nav>
  </article>`).join("")}
</section>
<footer><p>On a phone, you can also open a photo and press and hold it to see its save options.</p></footer>
</main>
<script>
const button = document.getElementById("download-all");
const help = document.getElementById("download-help");
button.disabled = false;
button.addEventListener("click", () => {
  button.disabled = true;
  const photos = Array.from(document.querySelectorAll("a[data-photo-download]"));
  photos.forEach((photo, index) => setTimeout(() => photo.click(), index * 400));
  help.textContent = "Three JPEG downloads requested. If your browser asks, allow multiple downloads. You can also use each photo's Download link below.";
  setTimeout(() => { button.disabled = false; }, photos.length * 400);
});

const saveButton = document.getElementById("save-phone");
const saveHelp = document.getElementById("save-help");
let phoneFiles = null;

async function preparePhoneSave() {
  saveButton.disabled = true;
  saveButton.textContent = "Preparing 3 photos…";
  saveHelp.textContent = "Getting all three photos ready for your phone. Downloads remain available below.";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const photos = Array.from(document.querySelectorAll("a[data-photo-download]"));
    const files = await Promise.all(photos.map(async (photo) => {
      const response = await fetch(photo.href, { signal: controller.signal, credentials: "omit", cache: "force-cache" });
      if (!response.ok) throw new Error("Photo unavailable");
      const blob = await response.blob();
      if (!blob.size || blob.type.split(";")[0] !== "image/jpeg") throw new Error("Photo unavailable");
      return new File([blob], photo.download, { type: "image/jpeg" });
    }));
    let supported = false;
    try { supported = navigator.canShare({ files }); } catch {}
    if (!supported) {
      saveButton.hidden = true;
      saveHelp.textContent = "Your browser cannot save all three together. Open a photo and press and hold it for save options, or use Download below.";
      return;
    }
    phoneFiles = files;
    saveButton.textContent = "Save to phone";
    saveHelp.textContent = "In your phone's share menu, choose Save Images or a photo app if available.";
  } catch {
    controller.abort();
    phoneFiles = null;
    saveButton.textContent = "Retry preparing photos";
    saveHelp.textContent = "We couldn't prepare all three photos. Tap Retry preparing photos, or save each photo below.";
  } finally {
    clearTimeout(timeout);
    saveButton.disabled = false;
  }
}

if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
  saveButton.hidden = false;
  saveButton.addEventListener("click", async () => {
    if (!phoneFiles) {
      await preparePhoneSave();
      return;
    }
    saveButton.disabled = true;
    try {
      // All files are already loaded. Invoke sharing directly in this click
      // so even slow mobile connections cannot consume user activation.
      await navigator.share({ files: phoneFiles });
      saveHelp.textContent = "Check your chosen app to finish saving. You can open the menu again if needed.";
    } catch (error) {
      saveHelp.textContent = error && error.name === "AbortError"
        ? "The save menu was closed. Tap Save to phone to try again, or save each photo below."
        : "Your phone couldn't open the save menu. Try again, or open each photo and press and hold it to save.";
    } finally {
      saveButton.disabled = false;
    }
  });
  // Fetch before the tap: navigator.share requires a fresh user gesture.
  void preparePhoneSave();
}
</script></body></html>`;
}
