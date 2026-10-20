export type AiModelId = "selfie" | "selfie-multiclass" | "modnet";
export type AiAcceleration = "auto" | "cpu" | "gpu";

export interface AiRuntimeInfo {
  backend: "mediapipe-cpu" | "mediapipe-gpu" | "onnx-wasm" | "onnx-webgpu" | "openvino-gpu" | "coreml";
  label: string;
  fallbackReason?: string;
}

export const DEFAULT_AI_MODEL: AiModelId = "selfie";
export const DEFAULT_AI_ACCELERATION: AiAcceleration = "auto";

export const AI_ACCELERATIONS: ReadonlyArray<{
  id: AiAcceleration;
  label: string;
  description: string;
}> = [
  { id: "auto", label: "Auto", description: "Try GPU, then use CPU if needed." },
  { id: "cpu", label: "CPU", description: "Use the processor for a baseline." },
  { id: "gpu", label: "GPU", description: "Use graphics acceleration when available." },
];

export const AI_MODELS: ReadonlyArray<{
  id: AiModelId;
  label: string;
  name: string;
  description: string;
  inputSize: number;
}> = [
  {
    id: "selfie",
    label: "Fast",
    name: "MediaPipe Selfie",
    description: "Lightweight person segmentation. Start here on a mini PC.",
    inputSize: 256,
  },
  {
    id: "selfie-multiclass",
    label: "Detailed",
    name: "MediaPipe Selfie Multiclass",
    description: "Separates hair, skin, clothing, and accessories. Uses more processing power.",
    inputSize: 256,
  },
  {
    id: "modnet",
    label: "Portrait",
    name: "MODNet",
    description: "Portrait matting up to 512 px with soft hair edges. A heavier option.",
    inputSize: 512,
  },
];

export function isAiModelId(value: unknown): value is AiModelId {
  return AI_MODELS.some((model) => model.id === value);
}

export function isAiAcceleration(value: unknown): value is AiAcceleration {
  return AI_ACCELERATIONS.some((acceleration) => acceleration.id === value);
}
