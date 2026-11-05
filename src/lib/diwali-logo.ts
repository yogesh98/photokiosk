import { DIYA, FLAME, RAYS, TAGLINE, TEMPLE, WORD, YEAR } from "./diwali-logo-paths";

export const DIWALI_LOGO_LABEL = "Diwali 2026, Light Beyond Lamps";
export const DIWALI_LOGO_WIDTH = 490;
export const DIWALI_LOGO_HEIGHT = 334;

type LogoOptions = {
  /** Prefix for the SVG's internal ids. Must be unique on the page. */
  id: string;
  className?: string;
};

/**
 * The Diwali 2026 logo in gold, as SVG markup, so the kiosk and the uploaded
 * download page share one copy. The diya flame is drawn on its own (fire
 * colours, a soft glow) and a glint sweeps across the gold, like the shimmer
 * on Atma Mirror. Classes for animation: dl-rays, dl-glow, dl-flame, dl-sheen.
 */
export function diwaliLogoSVG({ id, className = "diwali-logo" }: LogoOptions): string {
  const p = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return `<svg class="${className}" viewBox="9 6 ${DIWALI_LOGO_WIDTH} ${DIWALI_LOGO_HEIGHT}" width="${DIWALI_LOGO_WIDTH}" height="${DIWALI_LOGO_HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${DIWALI_LOGO_LABEL}"><defs><linearGradient id="${p}-gold" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="500" y2="330"><stop offset="0" stop-color="#c9a04a"/><stop offset=".2" stop-color="#f7e7b4"/><stop offset=".38" stop-color="#d4a94f"/><stop offset=".54" stop-color="#fff3cf"/><stop offset=".72" stop-color="#c79a3e"/><stop offset=".88" stop-color="#f2d98f"/><stop offset="1" stop-color="#b8892e"/></linearGradient><linearGradient id="${p}-sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fffbe8" stop-opacity="0"/><stop offset=".5" stop-color="#fffbe8" stop-opacity=".95"/><stop offset="1" stop-color="#fffbe8" stop-opacity="0"/></linearGradient><linearGradient id="${p}-fire" gradientUnits="userSpaceOnUse" x1="0" y1="232" x2="0" y2="160"><stop offset="0" stop-color="#ff8a1e"/><stop offset=".45" stop-color="#ffd86b"/><stop offset="1" stop-color="#fffbe8"/></linearGradient><radialGradient id="${p}-halo"><stop offset="0" stop-color="#ffd27a" stop-opacity=".75"/><stop offset=".45" stop-color="#ffb04a" stop-opacity=".28"/><stop offset="1" stop-color="#ff9d2e" stop-opacity="0"/></radialGradient><mask id="${p}-mask" style="mask-type:alpha"><use href="#${p}-art"/></mask></defs><ellipse class="dl-glow" cx="373" cy="200" rx="58" ry="62" fill="url(#${p}-halo)"/><g id="${p}-art" fill="url(#${p}-gold)"><g class="dl-rays">${RAYS}</g>${TEMPLE}${DIYA}${WORD}${YEAR}${TAGLINE}</g><g class="dl-flame" fill="url(#${p}-fire)">${FLAME}</g><g mask="url(#${p}-mask)"><rect class="dl-sheen" x="-140" y="0" width="120" height="360" fill="url(#${p}-sheen)"/></g></svg>`;
}
