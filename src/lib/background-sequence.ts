import type { Background, BackgroundSequence, KioskSettings } from "./kiosk-types";

export type SessionBackgrounds = [Background | undefined, Background | undefined, Background | undefined];

export function isBackgroundSequence(value: unknown): value is BackgroundSequence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sequence = value as Record<string, unknown>;
  return (
    (sequence.mode === "single" || sequence.mode === "rotate" || sequence.mode === "custom") &&
    Array.isArray(sequence.photoIds) &&
    sequence.photoIds.length === 3 &&
    sequence.photoIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100 && !/[\u0000]/.test(id))
  );
}

/** Resolve once at the start of a session so all three shots keep the same plan. */
export function resolveSessionBackgrounds(
  settings: KioskSettings,
  backgrounds: readonly Background[],
): SessionBackgrounds {
  if (settings.backgroundMode === "off" || backgrounds.length === 0)
    return [undefined, undefined, undefined];

  const activeIndex = Math.max(0, backgrounds.findIndex(({ id }) => id === settings.activeBackgroundId));
  const active = backgrounds[activeIndex];
  const sequence = settings.backgroundSequence;
  if (sequence?.mode === "rotate") {
    return [0, 1, 2].map((offset) => backgrounds[(activeIndex + offset) % backgrounds.length]) as SessionBackgrounds;
  }
  if (sequence?.mode === "custom") {
    return sequence.photoIds.map((id) => backgrounds.find((background) => background.id === id) ?? active) as SessionBackgrounds;
  }
  return [active, active, active];
}
