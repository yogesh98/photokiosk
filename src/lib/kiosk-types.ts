export type CameraMode = "browser" | "canon";
export type CameraExposureMode = "auto" | "manual";
export type BackgroundMode = "green-screen" | "off";
export type BackgroundSequenceMode = "single" | "rotate" | "custom";
export interface BackgroundSequence {
  mode: BackgroundSequenceMode;
  photoIds: [string, string, string];
}
export interface KioskSettings {
  eventName: string;
  activeBackgroundId: string;
  backgroundMode: BackgroundMode;
  backgroundSequence: BackgroundSequence;
  camera: {
    mode: CameraMode;
    exposureMode: CameraExposureMode;
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
  sessions: PhotoSession[];
}
export const DEFAULT_SETTINGS: KioskSettings = {
  eventName: "The good times",
  activeBackgroundId: "coast",
  backgroundMode: "green-screen",
  backgroundSequence: { mode: "single", photoIds: ["coast", "coast", "coast"] },
  camera: {
    mode: "browser",
    exposureMode: "auto",
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
