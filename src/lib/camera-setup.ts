import type { KioskSettings } from "./kiosk-types";

type CameraPreferences = KioskSettings["camera"];
type ExposureSettings = Pick<
  CameraPreferences,
  "iso" | "aperture" | "shutterSpeed"
>;

interface CameraSetupActions {
  getStatus: () => Promise<{ connected: boolean }>;
  configure: (exposure: ExposureSettings) => Promise<unknown>;
  save: (preferences: CameraPreferences, message: string) => Promise<boolean>;
}

/** Apply exposure before saving: saving can remount the form that displays errors. */
export async function saveCameraSetup(
  preferences: CameraPreferences,
  actions: CameraSetupActions,
): Promise<boolean> {
  let message = "Camera preferences saved.";
  if (preferences.mode === "canon") {
    const status = await actions.getStatus();
    if (status.connected) {
      const { iso, aperture, shutterSpeed } = preferences;
      await actions.configure({ iso, aperture, shutterSpeed });
      message = "Camera preferences saved and exposure settings applied.";
    } else {
      message =
        "Camera preferences saved. Connect your Canon and save again to apply exposure.";
    }
  }
  return actions.save(preferences, message);
}
