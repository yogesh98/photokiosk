"use client";

import { useEffect, useRef, type RefObject } from "react";
import { createMagicFx, type MagicFx } from "./magic-fx";

/**
 * Two full-screen canvases for the gold light: one behind the booth (drifting
 * motes, the far side of the flame spirals) and one in front of it (sparks,
 * rings, fairy dust). Every touch leaves a little light behind.
 *
 * Add ?fx=low to the kiosk URL on a slow computer, or ?fx=off to turn it off.
 * It is also off when the system asks for reduced motion.
 */
export function MagicLayer({ fxRef, ambient }: { fxRef: RefObject<MagicFx | null>; ambient: number }) {
  const frontRef = useRef<HTMLCanvasElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const ambientRef = useRef(ambient);

  useEffect(() => {
    const mode = new URLSearchParams(window.location.search).get("fx");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (mode === "off" || reduce || !frontRef.current) return;
    const fx = createMagicFx(frontRef.current, backRef.current, { low: mode === "low" });
    fxRef.current = fx;
    fx.setAmbient(ambientRef.current);

    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-fx-quiet]")) return;
      fx.burst(event.clientX, event.clientY, { count: 16, speed: 260, glints: 3, flash: 30 });
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || event.buttons) fx.trail(event.clientX, event.clientY);
    };
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      fx.destroy();
      if (fxRef.current === fx) fxRef.current = null;
    };
  }, [fxRef]);

  useEffect(() => {
    ambientRef.current = ambient;
    fxRef.current?.setAmbient(ambient);
  }, [ambient, fxRef]);

  return (
    <>
      <canvas ref={backRef} className="kiosk-fx kiosk-fx-back" aria-hidden="true" />
      <canvas ref={frontRef} className="kiosk-fx kiosk-fx-front" aria-hidden="true" />
    </>
  );
}
