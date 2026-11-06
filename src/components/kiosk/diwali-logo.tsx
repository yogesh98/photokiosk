"use client";

import { useId } from "react";
import { diwaliLogoSVG } from "@/lib/diwali-logo";

/** The gold Diwali 2026 logo, with its flickering diya flame and moving glint. */
export function DiwaliLogo({ className = "" }: { className?: string }) {
  const id = `dl${useId()}`;
  return (
    <span
      className={`kiosk-logo ${className}`}
      // Static markup generated from the brand PDF; nothing in it comes from users.
      dangerouslySetInnerHTML={{ __html: diwaliLogoSVG({ id }) }}
    />
  );
}
