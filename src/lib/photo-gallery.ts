import { getPhotoGalleryAssets } from "./photo-gallery-assets";

function escapeHTML(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function renderPhotoGallery(eventName: string): string {
  const title = escapeHTML(eventName);
  const assets = getPhotoGalleryAssets();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#4a78e0"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>${title} · Your photos</title>
<style>
@font-face{font-family:Shrikhand;src:url("${assets.shrikhand}") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:Figtree;src:url("${assets.figtreeRegular}") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:Figtree;src:url("${assets.figtreeBold}") format("woff2");font-weight:700;font-display:swap}
:root{color-scheme:light;--blue:#4a78e0;--deep:#2f55b0;--white:#f4f6fa}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--blue);color:var(--white);font:16px/1.5 Figtree,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent}
main{max-width:1080px;margin:auto;padding:40px 28px max(48px,env(safe-area-inset-bottom))}
header{text-align:center}
.sign{position:relative;max-width:600px;margin:auto;padding:16px;border-radius:32px;background:var(--deep);box-shadow:0 12px 32px #1c263e30,0 0 48px #f4f6fa35}
.sign::before{content:"";position:absolute;inset:5px;border-radius:28px;pointer-events:none;background:radial-gradient(circle,#fff 2px,transparent 3px) top left/22px 8px repeat-x,radial-gradient(circle,#fff 2px,transparent 3px) bottom left/22px 8px repeat-x,radial-gradient(circle,#fff 2px,transparent 3px) top left/8px 22px repeat-y,radial-gradient(circle,#fff 2px,transparent 3px) top right/8px 22px repeat-y}
.sign-panel{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:center;gap:10px 16px;padding:18px;border-radius:19px;background:var(--white);color:var(--deep)}
.brand{display:block;width:100%;height:auto}
h1{margin:0;font:400 clamp(30px,7.8vw,52px)/1 Shrikhand,Georgia,serif;text-align:left;color:var(--blue)}
h1 span{display:block}
.event-name{grid-column:1/-1;margin:0;font-size:15px;font-weight:700;line-height:1.35;overflow-wrap:anywhere}
.intro{margin:22px 0 0;font-size:20px;font-weight:700;line-height:1.4}
.actions{max-width:520px;margin:24px auto 34px;padding:22px;border-radius:26px;background:var(--white);color:var(--deep);box-shadow:0 7px 0 var(--deep)}
.button{display:flex;align-items:center;justify-content:center;min-height:56px;width:100%;padding:13px 18px;border:2px solid var(--deep);border-radius:999px;background:var(--deep);color:white;font:700 18px/1.3 Figtree,system-ui,sans-serif;text-decoration:none;cursor:pointer;touch-action:manipulation}
.button[hidden]{display:none}
.button:disabled{opacity:.6;cursor:wait}
.button.secondary{min-height:52px;background:transparent;color:var(--deep)}
.download-help{margin:12px 0 20px;font-size:14px;line-height:1.45;overflow-wrap:anywhere}
#download-help{margin-bottom:0}
:is(button,a):focus-visible{outline:3px solid #162e65;outline-offset:4px}
.photos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}
article{min-width:0;padding:10px;border-radius:23px;background:var(--white);outline:3px dotted var(--white);outline-offset:5px;box-shadow:0 8px 0 var(--deep)}
.photo-link{display:block;border-radius:15px;overflow:hidden}
.photo-link img{display:block;width:100%;height:auto}
nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:12px 2px 0;font-size:15px;font-weight:700}
nav a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 8px;border-radius:999px;color:var(--deep);text-underline-offset:4px;touch-action:manipulation}
nav a[data-photo-download]{padding-inline:17px;background:var(--deep);color:white;text-decoration:none}
footer{max-width:520px;margin:34px auto 0;padding:14px 20px;border:1px solid #ffffff70;border-radius:20px;background:var(--deep);text-align:center;font-size:14px;line-height:1.5}
footer p{margin:0}
@media(max-width:840px){main{padding:24px max(18px,env(safe-area-inset-left)) max(36px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-right))}.sign{padding:14px;border-radius:28px}.sign-panel{gap:10px 12px;padding:14px;border-radius:16px}.event-name{font-size:14px}.actions{padding:18px;margin-bottom:30px}.photos{grid-template-columns:1fr;max-width:480px;margin:auto;gap:28px}article{padding:10px}.intro{font-size:19px}footer{margin-top:30px}}
</style></head>
<body><main>
<header>
  <div class="sign"><div class="sign-panel">
    <img class="brand" src="${assets.logo}" alt="Kids’ Diwali Celebration" width="1024" height="576">
    <h1><span>Your</span><span>photos</span></h1>
    <p class="event-name">${title}</p>
  </div></div>
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
