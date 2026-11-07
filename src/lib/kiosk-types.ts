export type CameraMode = "browser" | "canon";
export type CameraExposureMode = "auto" | "manual";
/**
 * How a Canon photo is taken. "live" keeps the frame the guest is looking at:
 * no shutter, no mirror, no autofocus gamble, and live view never stops.
 * "still" fires the shutter for a full-resolution photo, which the camera
 * refuses whenever its autofocus cannot lock.
 */
export type CameraCaptureMode = "live" | "still";
export type BackgroundMode = "green-screen" | "off";
export type BackgroundSequenceMode = "single" | "rotate" | "custom";
export interface BackgroundSequence {
  mode: BackgroundSequenceMode;
  photoIds: [string, string, string];
}
export interface KioskSettings {
  eventName: string;
  activeBackgroundId: string;
  /** The overlay drawn on top of every photo, or "" for none. */
  activeOverlayId: string;
  backgroundMode: BackgroundMode;
  backgroundSequence: BackgroundSequence;
  camera: {
    mode: CameraMode;
    exposureMode: CameraExposureMode;
    captureMode: CameraCaptureMode;
    deviceId: string;
    iso: string;
    aperture: string;
    shutterSpeed: string;
    mirror: boolean;
  };
  chroma: {
    enabled: boolean;
    similarity: number;
    smoothness: number;
    spill: number;
  };
  gmail: {
    email: string;
    senderName: string;
    subject: string;
    message: string;
    configured: boolean;
  };
  b2: {
    enabled: boolean;
    keyId: string;
    bucketName: string;
    configured: boolean;
  };
}
export interface Background {
  id: string;
  name: string;
  url: string;
  category: string;
  createdAt: string;
}
/** A transparent PNG drawn over the whole photo, stretched to its 3:2 frame. */
export interface Overlay {
  id: string;
  name: string;
  url: string;
  createdAt: string;
}
export interface PhotoSession {
  id: string;
  createdAt: string;
  photos: string[];
  email: string | null;
  status: "captured" | "sending" | "sent" | "failed";
  backgroundName: string;
  backgroundNames?: [string, string, string];
  error?: string;
  sharing?: {
    status: "uploading" | "uploaded" | "failed";
    galleryUrl?: string;
    photoUrls?: string[];
    error?: string;
  };
  deliveries?: Array<{
    email: string;
    status: "sent" | "failed";
    createdAt: string;
    error?: string;
  }>;
}
export interface StudioData {
  settings: KioskSettings;
  backgrounds: Background[];
  overlays: Overlay[];
  sessions: PhotoSession[];
}
export const DEFAULT_SETTINGS: KioskSettings = {
  eventName: "The good times",
  activeBackgroundId: "coast",
  activeOverlayId: "",
  backgroundMode: "green-screen",
  backgroundSequence: { mode: "single", photoIds: ["coast", "coast", "coast"] },
  camera: {
    mode: "browser",
    exposureMode: "auto",
    captureMode: "live",
    deviceId: "",
    iso: "400",
    aperture: "5.6",
    shutterSpeed: "1/125",
    mirror: true,
  },
  chroma: { enabled: true, similarity: 0.36, smoothness: 0.12, spill: 0.35 },
  gmail: {
    email: "",
    senderName: "Still Photo Booth",
    subject: "A little something to remember ✨",
    message:
      "Your good times, captured. Here are your photos from our photo booth. Thanks for being part of it!",
    configured: false,
  },
  b2: { enabled: false, keyId: "", bucketName: "", configured: false },
};
