import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSessionBackgrounds } from "./background-sequence";
import { DEFAULT_SETTINGS, type Background, type KioskSettings } from "./kiosk-types";

const backgrounds: Background[] = ["coast", "mountains", "desert"].map((id) => ({
  id, name: id, url: `/backgrounds/${id}.jpg`, category: "Test", createdAt: "2026-01-01",
}));
const settings = (overrides: Partial<KioskSettings> = {}): KioskSettings => ({
  ...structuredClone(DEFAULT_SETTINGS), ...overrides,
});
const ids = (value: ReturnType<typeof resolveSessionBackgrounds>) => value.map((background) => background?.id);

test("single background repeats the active scene and supports settings from an older client", () => {
  assert.deepEqual(ids(resolveSessionBackgrounds(settings({ activeBackgroundId: "mountains" }), backgrounds)), ["mountains", "mountains", "mountains"]);
  const legacy = settings();
  delete (legacy as Partial<KioskSettings>).backgroundSequence;
  assert.deepEqual(ids(resolveSessionBackgrounds(legacy, backgrounds)), ["coast", "coast", "coast"]);
});

test("rotate starts at the active scene and wraps through the available library", () => {
  const rotate = settings({ activeBackgroundId: "desert", backgroundSequence: { mode: "rotate", photoIds: ["coast", "coast", "coast"] } });
  assert.deepEqual(ids(resolveSessionBackgrounds(rotate, backgrounds)), ["desert", "coast", "mountains"]);
  assert.deepEqual(ids(resolveSessionBackgrounds(rotate, backgrounds.slice(0, 2))), ["coast", "mountains", "coast"]);
  assert.deepEqual(ids(resolveSessionBackgrounds(rotate, backgrounds.slice(0, 1))), ["coast", "coast", "coast"]);
});

test("custom preserves explicit shot order and permits repeated scenes", () => {
  const custom = settings({ backgroundSequence: { mode: "custom", photoIds: ["desert", "coast", "desert"] } });
  assert.deepEqual(ids(resolveSessionBackgrounds(custom, backgrounds)), ["desert", "coast", "desert"]);
  assert.deepEqual(ids(resolveSessionBackgrounds(custom, backgrounds.slice(0, 2))), ["coast", "coast", "coast"]);
});

test("off and empty libraries have no replacement scene regardless of the sequence", () => {
  for (const mode of ["single", "rotate", "custom"] as const) {
    const configured = settings({ backgroundSequence: { mode, photoIds: ["coast", "mountains", "desert"] } });
    assert.deepEqual(resolveSessionBackgrounds({ ...configured, backgroundMode: "off" }, backgrounds), [undefined, undefined, undefined]);
    assert.deepEqual(resolveSessionBackgrounds(configured, []), [undefined, undefined, undefined]);
  }
});

test("resolving a session does not mutate settings or library ordering", () => {
  const configured = settings({ activeBackgroundId: "desert", backgroundSequence: { mode: "rotate", photoIds: ["coast", "coast", "coast"] } });
  const before = structuredClone({ configured, backgrounds });
  resolveSessionBackgrounds(configured, backgrounds);
  assert.deepEqual({ configured, backgrounds }, before);
});
