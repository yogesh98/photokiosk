function escapeHTML(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function renderPhotoGallery(eventName: string): string {
  const title = escapeHTML(eventName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>${title} · Your photos</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f8f7f3;color:#24231f;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1040px;margin:auto;padding:44px 20px 60px}header{text-align:center;margin-bottom:32px}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#78756d}h1{font-size:clamp(30px,6vw,48px);letter-spacing:-.04em;margin:12px 0}p{color:#78756d;line-height:1.6}.button{display:inline-block;background:#343b32;color:white;text-decoration:none;border:0;border-radius:999px;padding:14px 24px;margin:10px 0;font:inherit;cursor:pointer}.button:disabled{opacity:.6;cursor:wait}.button[hidden]{display:none}.button.secondary{background:transparent;color:#343b32;border:1px solid #d6d8d0}.download-help{font-size:13px;max-width:480px;margin:8px auto}.photos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}article{background:white;padding:10px 10px 18px;border-radius:16px;box-shadow:0 4px 24px #24231f08}img{display:block;width:100%;height:auto;border-radius:8px}nav{display:flex;justify-content:space-between;gap:12px;padding:16px 6px 0;font-size:14px}nav a{color:#343b32;text-underline-offset:4px}footer{text-align:center;font-size:13px;margin-top:32px}@media(max-width:680px){main{padding-top:28px}.photos{grid-template-columns:1fr;max-width:480px;margin:auto}}</style></head>
<body><main><header><div class="eyebrow">Your photo booth memories</div><h1>${title}</h1><p>All three photos, ready to keep.</p><button class="button" id="save-phone" type="button" aria-describedby="save-help" hidden disabled>Save to phone</button><p class="download-help" id="save-help" role="status">Open a photo and press and hold it to see your phone's save options.</p><button class="button secondary" id="download-all" type="button" aria-describedby="download-help" disabled>Download all 3 photos</button><p class="download-help" id="download-help" role="status">Three separate JPEG files. You can also download each photo below.</p><noscript><p>Use the Download link below each photo to save it.</p></noscript></header><section class="photos" aria-label="Your three photos">${[1, 2, 3].map((number) => `<article><a href="${number}.jpg" target="_blank" rel="noopener"><img src="${number}.jpg" alt="Photo booth photo ${number}" loading="${number === 1 ? "eager" : "lazy"}"></a><nav aria-label="Photo ${number}"><a href="${number}.jpg" target="_blank" rel="noopener">View photo ${number}</a><a href="${number}.jpg" download="photo-booth-${number}.jpg" data-photo-download>Download</a></nav></article>`).join("")}</section><footer><p>On a phone, you can also open a photo and press and hold it to see its save options.</p></footer></main>
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
    saveHelp.textContent = "Opens your phone's share menu with all 3 photos. Choose Save Images or a photo app if your phone offers it.";
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
