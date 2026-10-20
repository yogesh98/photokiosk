import { DEFAULT_AI_ACCELERATION, DEFAULT_AI_MODEL, type AiAcceleration, type AiModelId } from "./ai-models";

export type CameraMode = "browser" | "canon";
export type BackgroundMode = "green-screen" | "ai" | "off";
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
  aiModel: AiModelId;
  aiAcceleration: AiAcceleration;
  camera: {
    mode: CameraMode;
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
  aiModel: DEFAULT_AI_MODEL,
  aiAcceleration: DEFAULT_AI_ACCELERATION,
  camera: {
    mode: "browser",
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
};
