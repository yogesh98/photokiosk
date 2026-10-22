export type GeneralForegroundModelId = "birefnet-lite" | "birefnet-general" | "birefnet-matting";
export type AiModelId = "selfie" | "selfie-multiclass" | "modnet" | "background-matting-mobilenet" | GeneralForegroundModelId;
export type AiAcceleration = "auto" | "cpu" | "gpu";

export interface AiRuntimeInfo {
  backend: "mediapipe-cpu" | "mediapipe-gpu" | "onnx-wasm" | "onnx-webgpu" | "onnx-cpu" | "openvino-gpu" | "coreml";
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
  inputHeight?: number;
  scope: "people" | "general" | "reference";
  modelSize: string;
}> = [
  {
    id: "selfie",
    label: "Fast",
    name: "MediaPipe Selfie",
    description: "Lightweight person segmentation. Start here on a mini PC.",
    inputSize: 256,
    scope: "people",
    modelSize: "244 KiB",
  },
  {
    id: "selfie-multiclass",
    label: "Detailed",
    name: "MediaPipe Selfie Multiclass",
    description: "Separates hair, skin, clothing, and accessories. Uses more processing power.",
    inputSize: 256,
    scope: "people",
    modelSize: "15.6 MiB",
  },
  {
    id: "modnet",
    label: "Portrait",
    name: "MODNet",
    description: "Portrait matting up to 512 px with soft hair edges. A heavier option.",
    inputSize: 512,
    scope: "people",
    modelSize: "24.7 MiB",
  },
  {
    id: "birefnet-lite",
    label: "General foreground · Lite",
    name: "BiRefNet Lite",
    description: "Keeps principal subjects and props. The smallest general foreground option.",
    inputSize: 1024,
    scope: "general",
    modelSize: "214 MiB",
  },
  {
    id: "birefnet-general",
    label: "General foreground · Large",
    name: "BiRefNet General",
    description: "Larger model for people and other objects. Live preview can be much slower.",
    inputSize: 1024,
    scope: "general",
    modelSize: "928 MiB",
  },
  {
    id: "birefnet-matting",
    label: "General foreground · Matting",
    name: "BiRefNet Matting",
    description: "Larger model tuned for fine edges and transparency. Compare hair and props in preview.",
    inputSize: 1024,
    scope: "general",
    modelSize: "897 MiB",
  },
  {
    id: "background-matting-mobilenet",
    label: "Reference background · MobileNet",
    name: "BackgroundMattingV2 MobileNetV2",
    description: "Uses a captured empty scene to separate people from a fixed background. Capture a reference before previewing.",
    inputSize: 768,
    inputHeight: 512,
    scope: "reference",
    modelSize: "19.1 MiB",
  },
];

export function isAiModelId(value: unknown): value is AiModelId {
  return AI_MODELS.some((model) => model.id === value);
}

export function isGeneralForegroundModel(value: unknown): value is GeneralForegroundModelId {
  return AI_MODELS.some((model) => model.id === value && model.scope === "general");
}

export function isBackgroundReferenceModel(value: unknown): value is "background-matting-mobilenet" {
  return value === "background-matting-mobilenet";
}

export function isNativeForegroundModel(value: unknown): value is GeneralForegroundModelId | "background-matting-mobilenet" {
  return isGeneralForegroundModel(value) || isBackgroundReferenceModel(value);
}

export function isAiAcceleration(value: unknown): value is AiAcceleration {
  return AI_ACCELERATIONS.some((acceleration) => acceleration.id === value);
}
