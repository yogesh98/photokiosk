"use client";

import { useId } from "react";
import { diwaliLogoSVG } from "@/lib/diwali-logo";

/**
 * The gold Diwali 2026 logo. The gold art is one still SVG; the diya's glow
 * and flame are their own small SVGs layered on top, so their flicker is a
 * compositor animation of two tiny layers rather than a repaint of the
 * whole logo on every frame.
 */
export function DiwaliLogo({ className = "" }: { className?: string }) {
  const id = `dl${useId()}`;
  // Static markup generated from the brand PDF; nothing in it comes from users.
  return (
    <span className={`kiosk-logo ${className}`}>
      <span className="kiosk-logo-glow" dangerouslySetInnerHTML={{ __html: diwaliLogoSVG({ id: `${id}g`, parts: "glow" }) }} />
      <span className="kiosk-logo-art" dangerouslySetInnerHTML={{ __html: diwaliLogoSVG({ id: `${id}a`, parts: "art" }) }} />
      <span className="kiosk-logo-flame" dangerouslySetInnerHTML={{ __html: diwaliLogoSVG({ id: `${id}f`, parts: "flame" }) }} />
    </span>
  );
}
