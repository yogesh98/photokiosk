import assert from "node:assert/strict";
import { test } from "node:test";
import { saveCameraSetup } from "./camera-setup";
import { DEFAULT_SETTINGS } from "./kiosk-types";

const canon = { ...DEFAULT_SETTINGS.camera, mode: "canon" as const, exposureMode: "manual" as const };

test("automatic Canon exposure saves without probing USB or applying fixed values", async () => {
  const automatic = { ...canon, exposureMode: "auto" as const };
  const saved = await saveCameraSetup(automatic, {
    getStatus: async () => {
      assert.fail("Automatic exposure must not probe the camera while saving preferences");
    },
    configure: async () => {
      assert.fail("Automatic exposure must leave ISO, aperture, and shutter speed to the camera");
    },
    save: async (preferences, message) => {
      assert.deepEqual(preferences, automatic);
      assert.match(message, /P and ISO Auto/);
      assert.doesNotMatch(message, /settings applied/);
      return true;
    },
  });
  assert.equal(saved, true);
});

test("camera exposure is applied before persistence can remount the settings form", async () => {
  const events: string[] = [];
  const saved = await saveCameraSetup(canon, {
    getStatus: async () => {
      events.push("status");
      return { connected: true };
    },
    configure: async (exposure) => {
      events.push("configure");
      assert.deepEqual(exposure, {
        iso: "400",
        aperture: "5.6",
        shutterSpeed: "1/125",
      });
    },
    save: async (preferences, message) => {
      events.push("save");
      assert.deepEqual(preferences, canon);
      assert.match(message, /exposure settings applied/);
      return true;
    },
  });
  assert.equal(saved, true);
  assert.deepEqual(events, ["status", "configure", "save"]);
});

test("a rejected camera exposure remains visible and never persists a success", async () => {
  const failure = new Error("The connected lens does not support f/2.8.");
  let saves = 0;
  await assert.rejects(
    saveCameraSetup(canon, {
      getStatus: async () => ({ connected: true }),
      configure: async () => {
        throw failure;
      },
      save: async () => {
        saves++;
        return true;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(saves, 0);
});

test("disconnected Canon preferences can be saved without claiming they were applied", async () => {
  let configured = false;
  assert.equal(
    await saveCameraSetup(canon, {
      getStatus: async () => ({ connected: false }),
      configure: async () => {
        configured = true;
      },
      save: async (_preferences, message) => {
        assert.match(message, /Connect your Canon and save again/);
        assert.doesNotMatch(message, /settings applied/);
        return true;
      },
    }),
    true,
  );
  assert.equal(configured, false);
});

test("webcam preferences never contact the tethered-camera service", async () => {
  const webcam = { ...canon, mode: "browser" as const };
  assert.equal(
    await saveCameraSetup(webcam, {
      getStatus: async () => {
        assert.fail("Unexpected Canon status request");
      },
      configure: async () => {
        assert.fail("Unexpected Canon configuration");
      },
      save: async (preferences) => {
        assert.deepEqual(preferences, webcam);
        return false;
      },
    }),
    false,
  );
});
