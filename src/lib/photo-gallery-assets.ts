import { readFileSync } from "node:fs";
import path from "node:path";

type PhotoGalleryAssets = Readonly<{
  logo: string;
  shrikhand: string;
  figtreeRegular: string;
  figtreeBold: string;
}>;

let assets: PhotoGalleryAssets | undefined;

// Uploaded galleries must keep their branding when viewed away from the kiosk.
export function getPhotoGalleryAssets(): PhotoGalleryAssets {
  if (!assets) {
    // Keep these paths explicit so Next can trace the existing source assets.
    assets = Object.freeze({
      logo: `data:image/png;base64,${readFileSync(path.join(process.cwd(), "public/brand/kdc-logo.png")).toString("base64")}`,
      shrikhand: `data:font/woff2;base64,${readFileSync(path.join(process.cwd(), "src/app/kiosk/fonts/Shrikhand-Regular.woff2")).toString("base64")}`,
      figtreeRegular: `data:font/woff2;base64,${readFileSync(path.join(process.cwd(), "src/app/kiosk/fonts/Figtree-400.woff2")).toString("base64")}`,
      figtreeBold: `data:font/woff2;base64,${readFileSync(path.join(process.cwd(), "src/app/kiosk/fonts/Figtree-700.woff2")).toString("base64")}`,
    });
  }
  return assets;
}
