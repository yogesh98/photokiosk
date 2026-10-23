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

/** Only apply exposure overrides in manual mode, before saving can remount the form. */
export async function saveCameraSetup(
  preferences: CameraPreferences,
  actions: CameraSetupActions,
): Promise<boolean> {
  let message = "Camera preferences saved.";
  if (preferences.mode === "canon" && preferences.exposureMode === "manual") {
    const status = await actions.getStatus();
    if (status.connected) {
      const { iso, aperture, shutterSpeed } = preferences;
      await actions.configure({ iso, aperture, shutterSpeed });
      message = "Camera preferences saved and exposure settings applied.";
    } else {
      message =
        "Camera preferences saved. Connect your Canon and save again to apply exposure.";
    }
  } else if (preferences.mode === "canon") {
    message = "Camera preferences saved. Set the camera to P and ISO Auto for automatic exposure.";
  }
  return actions.save(preferences, message);
}
