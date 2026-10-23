"use client";
/* eslint-disable @next/next/no-img-element */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Aperture,
  ArrowDownToLine,
  ArrowUpRight,
  Camera,
  Check,
  CheckCircle2,
  CloudUpload,
  Expand,
  Images,
  Loader2,
  Mail,
  Monitor,
  Plus,
  Sparkles,
  Upload,
  Usb,
  X,
} from "lucide-react";
import { LivePreview, type PreviewPerformance } from "@/components/kiosk/live-preview";
import { AI_ACCELERATIONS, AI_MODELS, isBackgroundReferenceModel, isNativeForegroundModel, type AiRuntimeInfo } from "@/lib/ai-models";
import { getBackgroundReferenceCameraKey, isBackgroundReferenceCompatible } from "@/lib/background-reference-camera";
import { previewPerformanceKey } from "@/lib/preview-performance";
import { saveCameraSetup } from "@/lib/camera-setup";
import type {
  Background,
  BackgroundMode,
  KioskSettings,
  PhotoSession,
} from "@/lib/kiosk-types";
import {
  api,
  json,
  dateLabel,
  Modal,
  StudioApiError,
  Status,
  Toggle,
  type SaveSettings,
  type Notify,
  type CameraState,
} from "./studio-shared";

const BACKGROUND_OPTIONS: Array<{
  value: BackgroundMode;
  label: string;
  detail: string;
}> = [
  {
    value: "green-screen",
    label: "Green screen",
    detail: "Use a physical green backdrop.",
  },
  { value: "ai", label: "AI background", detail: "Keep people or general foreground subjects." },
  { value: "off", label: "Off", detail: "Keep the camera’s original scene." },
];

export function ChromaSettings({
  settings,
  background,
  busy,
  onSave,
}: {
  settings: KioskSettings;
  background?: Background;
  busy: boolean;
  onSave: SaveSettings;
}) {
  const [chroma, setChroma] = useState(settings.chroma);
  const [backgroundMode, setBackgroundMode] = useState(settings.backgroundMode);
  const [aiModel, setAiModel] = useState(settings.aiModel);
  const [aiAcceleration, setAiAcceleration] = useState(settings.aiAcceleration);
  const [preview, setPreview] = useState(false);
  const [referencePreview, setReferencePreview] = useState(false);
  const [capturedReference, setCapturedReference] = useState<KioskSettings["backgroundReference"]>(null);
  const [referenceCameraReady, setReferenceCameraReady] = useState(false);
  const [referenceSaving, setReferenceSaving] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const referenceCaptureRef = useRef<(() => Promise<Blob>) | null>(null);
  const referenceRequestRef = useRef<AbortController | null>(null);
  const [runtime, setRuntime] = useState<AiRuntimeInfo | null>(null);
  const [performance, setPerformance] = useState<PreviewPerformance | null>(null);
  const [measurements, setMeasurements] = useState<Record<string, PreviewPerformance>>({});
  const modeGroupId = useId();
  const modelGroupId = useId();
  const accelerationGroupId = useId();
  const draftChroma = { ...chroma, enabled: backgroundMode === "green-screen" };
  const nativeForeground = isNativeForegroundModel(aiModel);
  const referenceModel = isBackgroundReferenceModel(aiModel);
  const backgroundReference = capturedReference && (!settings.backgroundReference ||
    capturedReference.capturedAt >= settings.backgroundReference.capturedAt)
    ? capturedReference : settings.backgroundReference;
  const referenceCompatible = isBackgroundReferenceCompatible(backgroundReference, settings.camera);
  const canonPreview = settings.camera.mode === "canon";
  const recordReferenceCapture = useCallback((capture: (() => Promise<Blob>) | null) => {
    referenceCaptureRef.current = capture;
    setReferenceCameraReady(Boolean(capture));
  }, []);
  useEffect(() => () => referenceRequestRef.current?.abort(), []);
  async function saveReference() {
    const capture = referenceCaptureRef.current;
    if (!capture || referenceRequestRef.current) return;
    const controller = new AbortController();
    referenceRequestRef.current = controller;
    setReferenceSaving(true);
    setReferenceError("");
    try {
      const cameraKey = getBackgroundReferenceCameraKey(settings.camera);
      const file = await capture();
      controller.signal.throwIfAborted();
      const body = new FormData();
      body.set("file", file, "empty-background.png");
      body.set("cameraKey", cameraKey);
      const result = await api<{ settings: KioskSettings }>("/api/ai/reference", {
        method: "POST", body, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setCapturedReference(result.settings.backgroundReference);
      setReferencePreview(false);
      setReferenceCameraReady(false);
      setPerformance(null);
      setRuntime(null);
    } catch (error) {
      if (!controller.signal.aborted)
        setReferenceError(error instanceof Error ? error.message : "The empty background could not be saved. Try again.");
    } finally {
      if (referenceRequestRef.current === controller) {
        referenceRequestRef.current = null;
        if (!controller.signal.aborted) setReferenceSaving(false);
      }
    }
  }
  const recordPerformance = useCallback((value: PreviewPerformance | null) => {
    if (!preview || backgroundMode !== "ai" ||
      (value && (value.model !== aiModel || value.acceleration !== aiAcceleration))) return;
    setPerformance(value);
    if (value && value.samples >= 5)
      setMeasurements((previous) => ({ ...previous, [previewPerformanceKey(value)]: value }));
  }, [preview, backgroundMode, aiModel, aiAcceleration]);
  const recordRuntime = useCallback((value: AiRuntimeInfo | null) => {
    if (!preview || backgroundMode !== "ai") return;
    setRuntime(value);
    setPerformance(null);
  }, [preview, backgroundMode]);
  const comparisonRows = Object.entries(measurements);
  const activeKey = runtime ? previewPerformanceKey({ model: aiModel, acceleration: aiAcceleration, runtime }) : null;
  const hasActiveMeasurement = activeKey !== null && activeKey in measurements;
  const hasSelectedMeasurement = comparisonRows.some(([, value]) =>
    value.model === aiModel && value.acceleration === aiAcceleration);
  return (
    <section className="panel chroma-panel">
      <div className="section-heading">
        <div>
          <h2>
            <Sparkles size={19} />Background replacement
          </h2>
          <p>Choose a green screen, use AI, or keep the original scene.</p>
        </div>
      </div>
      <fieldset
        className="background-mode-field"
        aria-describedby={`${modeGroupId}-help`}
        disabled={busy || referenceSaving}
      >
        <legend>Background mode</legend>
        <div className="background-mode-options">
          {BACKGROUND_OPTIONS.map((mode) => (
            <label className="background-mode-option" key={mode.value}>
              <input
                type="radio"
                name={modeGroupId}
                value={mode.value}
                checked={backgroundMode === mode.value}
                onChange={() => {
                  setBackgroundMode(mode.value);
                  setReferencePreview(false);
                  setPerformance(null);
                  setRuntime(null);
                }}
              />
              <span>
                <strong>{mode.label}</strong>
                <small>{mode.detail}</small>
              </span>
            </label>
          ))}
        </div>
        <p
          className="background-mode-help"
          id={`${modeGroupId}-help`}
          aria-live="polite"
        >
          {backgroundMode === "ai"
            ? "AI runs on this device without a green screen. Choose a people model or a general foreground model for people, props, and other subjects."
            : backgroundMode === "green-screen"
              ? "Keep your green screen smooth and evenly lit, then adjust the sliders for natural edges."
              : "Background replacement is off. Your photos will keep everything visible in the camera."}
        </p>
      </fieldset>
      {backgroundMode === "ai" && (
        <fieldset
          className="background-mode-field ai-model-field"
          aria-describedby={`${modelGroupId}-help`}
          disabled={busy || referenceSaving}
        >
          <legend>AI model</legend>
          <div className="background-mode-options">
            {AI_MODELS.map((model) => (
              <label className="background-mode-option" key={model.id}>
                <input
                  type="radio"
                  name={modelGroupId}
                  value={model.id}
                  checked={aiModel === model.id}
                  onChange={() => {
                    setAiModel(model.id);
                    setReferencePreview(false);
                    if (isBackgroundReferenceModel(model.id) && !referenceCompatible) setPreview(false);
                    setPerformance(null);
                    setRuntime(null);
                  }}
                />
                <span>
                  <strong>{model.label}</strong>
                  <small className="ai-model-name">
                    {model.name} · {model.scope === "people" ? "People" : model.scope === "reference" ? "Empty background reference" : "General foreground"}
                  </small>
                  <small>
                    {model.id === "modnet"
                      ? `up to ${model.inputSize} px`
                      : `${model.inputSize} × ${model.inputHeight ?? model.inputSize}`} · {model.modelSize}
                  </small>
                  <small>{model.description}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="background-mode-help" id={`${modelGroupId}-help`}>
            All models run locally. General foreground models can retain props and
            other principal subjects, including unwanted objects. Large models may
            take several seconds per frame. Compare edges and speed in live preview
            on your booth computer; a larger model is not always better.
            Save adjustments to use your choice in the kiosk.
          </p>
        </fieldset>
      )}
      {backgroundMode === "ai" && referenceModel && (
        <fieldset className="background-mode-field" disabled={busy || referenceSaving}>
          <legend>Empty background reference</legend>
          <p className="background-mode-help">
            Clear everyone from the scene, keep the camera fixed, lock focus and
            exposure, and keep lighting steady. Capture the empty scene before trying this model.
            Recapture whenever the camera moves, focus or settings change, or the light changes.
          </p>
          <p className="background-mode-help" role="status">
            {backgroundReference
              ? referenceCompatible
                ? `Reference saved ${dateLabel(backgroundReference.capturedAt)}. Ready for this camera.`
                : "This reference was captured with different camera settings. Capture a new empty background."
              : "No empty background has been captured for this booth."}
          </p>
          {backgroundReference && (
            <img
              src={backgroundReference.url}
              alt="Saved empty camera scene used by the reference background model"
              width={240}
              height={160}
              style={{ maxWidth: "100%", height: "auto", borderRadius: 6 }}
            />
          )}
          <div className="panel-footer">
            <button
              className="button light small"
              onClick={() => {
                setPreview(false);
                setReferencePreview(!referencePreview);
                setReferenceError("");
                setPerformance(null);
                setRuntime(null);
              }}
            >
              {referencePreview ? "Close empty-scene camera" : "Open empty-scene camera"}
              <Camera size={14} />
            </button>
            <button
              className="button dark small"
              disabled={!referenceCameraReady || !referencePreview || referenceSaving}
              onClick={() => { void saveReference(); }}
            >
              {referenceSaving ? "Saving empty background…" : "Capture empty background"}
              {referenceSaving ? <Loader2 size={14} /> : <Check size={14} />}
            </button>
          </div>
          {referencePreview && (
            <div className="chroma-inline-preview">
              <LivePreview
                settings={{ ...settings, backgroundMode: "off" }}
                onReferenceCaptureReady={recordReferenceCapture}
              />
              <p>{canonPreview
                ? "Press Start live preview, then leave the scene empty and capture the reference."
                : "Leave the scene empty, then capture the reference."}</p>
            </div>
          )}
          {referenceError && <div className="inline-error" role="alert">{referenceError}</div>}
          <p className="background-mode-help">
            The reference is saved immediately. Open the processed preview to test it,
            then save adjustments to use this model in the kiosk.
          </p>
        </fieldset>
      )}
      {backgroundMode === "ai" && (
        <fieldset
          className="background-mode-field ai-acceleration-field"
          aria-describedby={`${accelerationGroupId}-help`}
          disabled={busy || referenceSaving}
        >
          <legend>AI acceleration</legend>
          <div className="background-mode-options">
            {AI_ACCELERATIONS.map((acceleration) => (
              <label className="background-mode-option" key={acceleration.id}>
                <input
                  type="radio"
                  name={accelerationGroupId}
                  value={acceleration.id}
                  checked={aiAcceleration === acceleration.id}
                  onChange={() => {
                    setAiAcceleration(acceleration.id);
                    setPerformance(null);
                    setRuntime(null);
                  }}
                />
                <span>
                  <strong>{acceleration.label}</strong>
                  <small>{nativeForeground && acceleration.id === "auto"
                    ? "Use local CPU for predictable memory use."
                    : acceleration.description}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="background-mode-help" id={`${accelerationGroupId}-help`}>
            {nativeForeground
              ? "Auto uses local CPU for predictable memory use. GPU requests native acceleration and reports an error if the model cannot run on it."
              : "Auto tries GPU first and falls back to CPU. GPU mode reports an error if acceleration is unavailable."}
            {" "}The comparison shows which device actually ran.
          </p>
        </fieldset>
      )}
      {preview && !(backgroundMode === "ai" && referenceModel && !referenceCompatible) && (
        <div className="chroma-inline-preview">
          <LivePreview
            settings={{ ...settings, backgroundMode, aiModel, aiAcceleration, backgroundReference, chroma: draftChroma }}
            background={backgroundMode === "off" ? undefined : background}
            onPerformanceChange={recordPerformance}
            onRuntimeChange={recordRuntime}
          />
          <p>Preview your changes, then save when the scene looks right.</p>
        </div>
      )}
      {backgroundMode === "ai" && (
        <section className="ai-benchmark" aria-labelledby={`${modelGroupId}-benchmark`}>
          <div className="ai-benchmark-heading">
            <h3 id={`${modelGroupId}-benchmark`}>Compare on this computer</h3>
            <span aria-live="polite">
              {!preview
                ? canonPreview ? "Open preview controls, then start live preview" : "Open live preview to measure"
                : !performance || performance.samples < 5
                  ? "Waiting for camera and warm-up frames…"
                  : "Measuring live preview"}
            </span>
          </div>
          {preview && runtime && (
            <div className="ai-runtime-status" role="status">
              <strong>Running on {runtime.label}</strong>
              {runtime.fallbackReason && <span>{runtime.fallbackReason}</span>}
            </div>
          )}
          <div className="ai-benchmark-table-wrap">
            <table className="ai-benchmark-table">
              <caption className="sr-only">Most recent preview measurements by model, requested acceleration, and actual device</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Selected</th>
                  <th scope="col">Actual device</th>
                  <th scope="col">Average frame</th>
                  <th scope="col">95th percentile</th>
                  <th scope="col">Preview FPS</th>
                  <th scope="col">Frames</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map(([key, measured]) => {
                  const model = AI_MODELS.find((item) => item.id === measured.model)!;
                  const current = preview && performance !== null &&
                    previewPerformanceKey(performance) === key && performance.samples >= 5;
                  return (
                    <tr key={key} className={current ? "measuring" : ""}>
                      <th scope="row">
                        {model.label}
                        {current && <small>Live</small>}
                      </th>
                      <td>{AI_ACCELERATIONS.find((item) => item.id === measured.acceleration)!.label}</td>
                      <td>{measured.runtime.label}</td>
                      <td>{`${measured.averageMs.toFixed(1)} ms`}</td>
                      <td>{`${measured.p95Ms.toFixed(1)} ms`}</td>
                      <td>{measured.fps.toFixed(1)}</td>
                      <td>{measured.samples}</td>
                    </tr>
                  );
                })}
                {!hasActiveMeasurement && (preview || !hasSelectedMeasurement) && (
                  <tr>
                    <th scope="row">{AI_MODELS.find((item) => item.id === aiModel)!.label}</th>
                    <td>{AI_ACCELERATIONS.find((item) => item.id === aiAcceleration)!.label}</td>
                    <td>{runtime?.label ?? "Waiting for preview"}</td>
                    <td>—</td><td>—</td><td>—</td><td>—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p>
            Frame times include AI and background compositing; lower is faster.
            {canonPreview
              ? "Start Canon live preview explicitly in the preview controls. Use the measured preview FPS, frame times, and picture to compare settings."
              : "Preview is capped at 12 FPS, so compare processing times as well as the picture."}
            Keep the same camera, lighting, and pose for each model and acceleration setting.
            Compare before saving; these measurements aren’t saved.
          </p>
        </section>
      )}
      {backgroundMode === "green-screen" && (
        <div className="chroma-sliders">
          {[
            {
              key: "similarity" as const,
              label: "Color similarity",
              hint: "How much green to remove",
              min: 0.1,
              max: 0.8,
            },
            {
              key: "smoothness" as const,
              label: "Edge softness",
              hint: "A softer, more natural outline",
              min: 0.01,
              max: 0.4,
            },
            {
              key: "spill" as const,
              label: "Spill reduction",
              hint: "Remove green from the edges",
              min: 0,
              max: 1,
            },
          ].map((item) => (
            <label className="slider-field" key={item.key}>
              <span>
                {item.label}
                <strong>{Math.round(chroma[item.key] * 100)}%</strong>
              </span>
              <input
                type="range"
                min={item.min}
                max={item.max}
                step="0.01"
                value={chroma[item.key]}
                onChange={(e) =>
                  setChroma({ ...chroma, [item.key]: Number(e.target.value) })
                }
              />
              <small>{item.hint}</small>
            </label>
          ))}
        </div>
      )}
      <div className="panel-footer">
        <span className="field-hint">
          {backgroundMode === "off"
            ? "Your scene, just as it is."
            : "Even lighting makes all the difference."}
        </span>
        <div>
          <button
            className="button light small"
            disabled={referenceSaving || (!preview && backgroundMode === "ai" && referenceModel && !referenceCompatible)}
            onClick={() => {
              setReferencePreview(false);
              setPreview(!preview);
              setPerformance(null);
              setRuntime(null);
            }}
          >
            {canonPreview ? preview ? "Close preview controls" : "Open preview controls" : preview ? "Close live preview" : "Open live preview"}
            <Expand size={14} />
          </button>
          <button
            className="button dark small"
            disabled={busy || referenceSaving || (backgroundMode === "ai" && referenceModel && !referenceCompatible)}
            onClick={() => onSave({ backgroundMode, aiModel, aiAcceleration, chroma: draftChroma })}
          >
            Save adjustments
            <Check size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}

export function CameraSettings({
  settings,
  background,
  camera,
  cameraChecked,
  busy,
  onSave,
  onConnect,
}: {
  settings: KioskSettings;
  background?: Background;
  camera: CameraState;
  cameraChecked: boolean;
  busy: boolean;
  onSave: SaveSettings;
  onConnect: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState(settings.camera);
  const [preview, setPreview] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const canonPreview = draft.mode === "canon";
  const previewStatus = useCallback(
    (status: { ready: boolean }) => {
      onConnect(draft.mode === "browser" && status.ready);
      if (draft.mode === "browser" && status.ready)
        navigator.mediaDevices
          ?.enumerateDevices()
          .then((items) =>
            setDevices(items.filter((d) => d.kind === "videoinput")),
          )
          .catch(() => {});
    },
    [draft.mode, onConnect],
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setApplying(true);
    setPreview(false);
    try {
      await saveCameraSetup(draft, {
        getStatus: () => api<CameraState>("/api/camera"),
        configure: (exposure) => api("/api/camera/configure", json(exposure)),
        save: (preferences, message) =>
          onSave({ camera: preferences }, message),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }
  return (
    <div className="camera-layout">
      <section className="panel camera-form">
        <div className="section-heading">
          <div>
            <h2>Choose your camera</h2>
            <p>A great photo starts with a good connection.</p>
          </div>
          <Camera size={21} />
        </div>
        <form onSubmit={submit}>
          <fieldset disabled={busy || applying} style={{ minInlineSize: 0 }}>
            <div className="camera-mode-options">
              <button
                type="button"
                className={draft.mode === "browser" ? "selected" : ""}
                onClick={() => {
                  setDraft({ ...draft, mode: "browser" });
                  setPreview(false);
                }}
              >
                <Monitor size={23} />
                <strong>Webcam</strong>
                <span>Built-in or USB camera</span>
                {draft.mode === "browser" && <CheckCircle2 size={16} />}
              </button>
              <button
                type="button"
                className={draft.mode === "canon" ? "selected" : ""}
                onClick={() => {
                  setDraft({ ...draft, mode: "canon" });
                  setPreview(false);
                }}
              >
                <Usb size={23} />
                <strong>Canon tethering</strong>
                <span>Direct USB connection</span>
                {draft.mode === "canon" && <CheckCircle2 size={16} />}
              </button>
            </div>
            {draft.mode === "canon" ? (
              <>
                <div className="camera-device">
                  <span className="device-camera">
                    <Camera size={30} strokeWidth={1.4} />
                  </span>
                  <div>
                    <strong>Canon EOS 5D Mark IV</strong>
                    <small>Full-frame DSLR · USB tethered</small>
                  </div>
                  <Status good={camera.connected}>
                    {!cameraChecked ? "Not checked" : camera.connected ? "Last check: connected" : "Not connected"}
                  </Status>
                </div>
                <div className="soft-note">
                  <Usb size={18} />
                  <p>
                    {!cameraChecked
                      ? "Connect the camera by USB, turn it on, and close EOS Utility. Use Check connection when you are ready. Live view starts only when you choose Start live preview."
                      : camera.connected
                        ? "The camera was connected at the last check. Choose Start live preview to begin live view, and Stop live preview when you are finished."
                        : camera.error || "Connect the camera by USB, then use Check connection. Install gphoto2 on the studio computer to enable direct tethering."}
                  </p>
                </div>
                <label className="field">
                  Exposure control
                  <select
                    value={draft.exposureMode}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        exposureMode: e.target.value as KioskSettings["camera"]["exposureMode"],
                      })
                    }
                  >
                    <option value="auto">Camera automatic (P)</option>
                    <option value="manual">Manual settings (M)</option>
                  </select>
                </label>
                {draft.exposureMode === "manual" ? (
                  <>
                    <div className="fields-three">
                      <label className="field">
                        ISO
                        <select
                          value={draft.iso}
                          onChange={(e) =>
                            setDraft({ ...draft, iso: e.target.value })
                          }
                        >
                          {["Auto", "100", "200", "400", "800", "1600", "3200"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        Aperture
                        <select
                          value={draft.aperture}
                          onChange={(e) =>
                            setDraft({ ...draft, aperture: e.target.value })
                          }
                        >
                          {["2.8", "4", "5.6", "8", "11", "16"].map((v) => (
                            <option key={v} value={v}>
                              f/{v}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        Shutter speed
                        <select
                          value={draft.shutterSpeed}
                          onChange={(e) =>
                            setDraft({ ...draft, shutterSpeed: e.target.value })
                          }
                        >
                          {["1/30", "1/60", "1/125", "1/160", "1/250", "1/500"].map(
                            (v) => (
                              <option key={v}>{v}</option>
                            ),
                          )}
                        </select>
                      </label>
                    </div>
                    <p className="field-hint">
                      Set your Canon to Manual (M) and JPEG or RAW+JPEG capture.
                      Preferences apply to the connected camera when saved.
                    </p>
                  </>
                ) : (
                  <p className="field-hint">
                    Set the camera’s mode dial to P and ISO to Auto. The camera
                    chooses exposure; the booth leaves ISO, aperture, and shutter
                    speed unchanged. Choose JPEG or RAW+JPEG capture.
                  </p>
                )}
              </>
            ) : (
              <>
                <label className="field">
                  Camera device
                  <select
                    value={draft.deviceId}
                    onChange={(e) =>
                      setDraft({ ...draft, deviceId: e.target.value })
                    }
                  >
                    <option value="">System default camera</option>
                    {devices.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-hint">
                  Open the live preview and allow camera access to see available
                  devices.
                </p>
              </>
            )}
            <div className="setting-toggle-row">
              <div>
                <strong>Mirror the preview</strong>
                <p>Make posing feel natural, just like a mirror.</p>
              </div>
              <Toggle
                checked={draft.mirror}
                label="Mirror camera preview"
                onChange={(mirror) => setDraft({ ...draft, mirror })}
              />
            </div>
            {error && <div className="inline-error">{error}</div>}
            <div className="form-actions">
              <button
                type="submit"
                className="button dark"
                disabled={busy || applying}
              >
                {(busy || applying) && <Loader2 size={15} className="spin" />}
                Save camera settings
                <Check size={15} />
              </button>
            </div>
          </fieldset>
        </form>
      </section>
      <section className="panel camera-preview-panel">
        <div className="section-heading">
          <div>
            <h2>Find your frame</h2>
            <p>{canonPreview ? "Start live preview when you are ready to frame the shot." : "The view your guests will see."}</p>
          </div>
          <span className="live-label">
            <span />
            LIVE PREVIEW
          </span>
        </div>
        <div className="camera-preview-frame">
          {preview ? (
            <LivePreview
              key={JSON.stringify(draft)}
              settings={{ ...settings, camera: draft }}
              background={background}
              onStatusChange={previewStatus}
            />
          ) : (
            <>
              <img
                src={background?.url || "/backgrounds/coast.jpg"}
                alt="Selected photo booth background"
              />
              <div>
                <Camera size={37} strokeWidth={1.3} />
                <p>Your next great shot starts here.</p>
                <button
                  className="button light"
                  onClick={() => setPreview(true)}
                >
                  {canonPreview ? "Open preview controls" : "Connect camera"}
                  <ArrowUpRight size={16} />
                </button>
              </div>
            </>
          )}
        </div>
        <div className="preview-tip">
          <Sparkles size={17} />
          <p>
            {settings.backgroundMode === "green-screen"
              ? "Give your guests a little room to move. Keep your green screen smooth and evenly lit."
              : settings.backgroundMode === "ai"
                ? "Keep guests close to the camera in even light so AI can find their outline."
                : "Give your guests a little room to move and check the scene behind them."}
          </p>
        </div>
        {preview && (
          <button
            className="text-button stop-preview"
            onClick={() => {
              setPreview(false);
              onConnect(false);
            }}
          >
            {canonPreview ? "Close preview controls" : "Close preview"}
            <X size={13} />
          </button>
        )}
      </section>
    </div>
  );
}

export function EmailSettings({
  settings,
  busy,
  onSave,
  notify,
}: {
  settings: KioskSettings;
  busy: boolean;
  onSave: SaveSettings;
  notify: Notify;
}) {
  const [draft, setDraft] = useState(settings.gmail);
  const [password, setPassword] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testing, setTesting] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      await onSave(
        { gmail: { ...draft, ...(password ? { appPassword: password } : {}) } },
        "Gmail settings saved. Send a test to check delivery.",
      )
    )
      setPassword("");
  }
  async function test(e: FormEvent) {
    e.preventDefault();
    setTesting(true);
    try {
      await api("/api/email/test", json({ email: testEmail }));
      notify("Test email sent. A little joy is on its way.");
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setTesting(false);
    }
  }
  return (
    <div className="email-layout">
      <section className="panel email-form">
        <div className="section-heading">
          <div className="email-heading">
            <span className="gmail-icon">
              <Mail size={24} />
            </span>
            <div>
              <h2>Your Gmail connection</h2>
              <p>A familiar inbox. A personal touch.</p>
            </div>
          </div>
          <Status good={settings.gmail.configured}>
            {settings.gmail.configured ? "Configured" : "Set up Gmail"}
          </Status>
        </div>
        <form onSubmit={submit}>
          <div className="fields-two">
            <label className="field">
              Gmail address
              <input
                required
                type="email"
                placeholder="hello@gmail.com"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </label>
            <label className="field">
              Sender name
              <input
                required
                maxLength={100}
                placeholder="Still Photo Booth"
                value={draft.senderName}
                onChange={(e) =>
                  setDraft({ ...draft, senderName: e.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            Google app password
            <input
              type="password"
              autoComplete="new-password"
              placeholder={
                settings.gmail.configured
                  ? "Saved securely · enter to replace"
                  : "Your 16-character app password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={!settings.gmail.configured}
            />
          </label>
          <p className="field-hint">
            Use an app password from your Google account, with 2-Step
            Verification enabled.{" "}
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noreferrer"
            >
              Create an app password
              <ArrowUpRight size={11} />
            </a>
          </p>
          <div className="form-divider" />
          <h3 className="form-subtitle">Make the message yours.</h3>
          <label className="field">
            Email subject
            <input
              required
              maxLength={180}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </label>
          <label className="field">
            A note to your guests
            <textarea
              required
              rows={4}
              maxLength={4000}
              value={draft.message}
              onChange={(e) => setDraft({ ...draft, message: e.target.value })}
            />
          </label>
          <div className="soft-note">
            <Images size={18} />
            <p>
              All three photos are attached to each email. Guests enter their
              email after their photos are captured.
            </p>
          </div>
          <div className="form-actions">
            <button className="button dark" disabled={busy}>
              {busy && <Loader2 size={15} className="spin" />}Save email
              settings
              <Check size={15} />
            </button>
          </div>
        </form>
      </section>
      <div>
        <section className="panel email-preview">
          <div className="eyebrow">A LITTLE SNEAK PEEK</div>
          <div className="email-preview-window">
            <div className="mail-window-bar">
              <span />
              <span />
              <span />
              <Mail size={14} />
            </div>
            <div className="mail-preview-content">
              <Aperture size={25} />
              <span className="mail-from">
                {draft.senderName || "Still Photo Booth"}
              </span>
              <h3>{draft.subject}</h3>
              <p>{draft.message}</p>
              <div className="mail-photo-strip">
                {["coast", "mountains", "desert"].map((b) => (
                  <img
                    key={b}
                    src={`/backgrounds/${b}.jpg`}
                    alt="Example attachment layout"
                  />
                ))}
              </div>
              <span className="email-preview-caption">
                Your guest’s three photos will appear here.
              </span>
              <div className="mail-signoff">
                A little moment. A lasting memory.
              </div>
            </div>
          </div>
        </section>
        <section className="panel test-email">
          <h3>A little delivery check.</h3>
          <p>
            Send yourself a test before the good times begin. Save your settings
            first.
          </p>
          <form onSubmit={test}>
            <label className="field">
              Test recipient
              <input
                type="email"
                required
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <button
              className="button light"
              disabled={testing || !settings.gmail.configured}
            >
              {testing ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Mail size={15} />
              )}
              Send a test email
              <ArrowUpRight size={14} />
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

export function UploadModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);
  function choose(f?: File) {
    if (!f) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) {
      setError("Choose a JPG, PNG, or WebP image.");
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setError("Choose an image smaller than 10 MB.");
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setName(f.name.replace(/\.[^.]+$/, "").replaceAll(/[-_]/g, " "));
    setError("");
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.set("file", file);
    form.set("name", name);
    try {
      await api("/api/backgrounds", { method: "POST", body: form });
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Bring your own kind of beautiful." onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <input
          type="file"
          ref={input}
          hidden
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => choose(e.target.files?.[0])}
        />
        <button
          className="upload-dropzone"
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            choose(e.dataTransfer.files[0]);
          }}
        >
          {preview ? (
            <img src={preview} alt="Background to upload" />
          ) : (
            <>
              <span>
                <Upload size={27} />
              </span>
              <strong>Drop a little scenery here</strong>
              <p>or click to choose an image</p>
              <small>JPG, PNG, or WebP · up to 10 MB</small>
            </>
          )}
        </button>
        <label className="field">
          Give your background a name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Somewhere wonderful"
          />
        </label>
        <p className="field-hint">
          Landscape images work best. We recommend at least 1920 × 1080 pixels.
        </p>
        {error && <div className="inline-error">{error}</div>}
        <button type="submit" className="button dark" disabled={!file || busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          Add to your backgrounds
        </button>
      </form>
    </Modal>
  );
}

export function SessionModal({
  session,
  sharingEnabled,
  onClose,
  onUpdate,
  notify,
}: {
  session: PhotoSession;
  sharingEnabled: boolean;
  onClose: () => void;
  onUpdate: (session: PhotoSession) => Promise<void>;
  notify: Notify;
}) {
  const [email, setEmail] = useState(session.email || "");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  async function share() {
    if (uploading || sending) return;
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploading(true);
    try {
      const result = await api<{ session: PhotoSession }>(
        `/api/sessions/${encodeURIComponent(session.id)}/share`,
        { ...json({}), signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      await onUpdate(result.session);
      notify("The photo gallery is ready to share.");
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof StudioApiError && error.session) await onUpdate(error.session);
      notify((error as Error).message, "error");
    } finally {
      if (!controller.signal.aborted) setUploading(false);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (sending || uploading) return;
    setSending(true);
    try {
      const result = await api<{ session: PhotoSession }>(
        `/api/sessions/${session.id}/email`,
        json({ email }),
      );
      await onUpdate(result.session);
      notify("All three memories are on their way.");
    } catch (e) {
      if (e instanceof StudioApiError && e.session) await onUpdate(e.session);
      notify((e as Error).message, "error");
    } finally {
      setSending(false);
    }
  }
  return (
    <Modal title="A moment worth keeping." wide onClose={onClose}>
      <div className="session-detail">
        <div className="detail-photos">
          {session.photos.map((photo, i) => (
            <div key={photo}>
              <img src={photo} alt={`Photo ${i + 1} of 3`} />
              {session.backgroundNames?.[i] && (
                <p className="detail-photo-background">{session.backgroundNames[i]}</p>
              )}
              <a
                className="button light small"
                href={photo}
                download={`still-${session.id}-${i + 1}.jpg`}
              >
                <ArrowDownToLine size={14} />
                Photo {i + 1}
              </a>
            </div>
          ))}
        </div>
        <div className="session-detail-meta">
          <div>
            <small>CAPTURED</small>
            <strong>{dateLabel(session.createdAt)}</strong>
          </div>
          <div>
            <small>BACKGROUND</small>
            <strong>{session.backgroundName}</strong>
          </div>
          <div>
            <small>DELIVERY</small>
            <strong>
              {session.status === "sent"
                ? "Accepted by Gmail"
                : session.status === "failed"
                  ? "Delivery failed"
                  : "Not sent"}
            </strong>
          </div>
        </div>
        {(sharingEnabled || session.sharing) && (
          <section className="session-cloud-sharing">
            <h3>QR photo sharing</h3>
            {session.sharing?.status === "uploaded" && session.sharing.galleryUrl ? (
              <div className="session-cloud-actions">
                <a className="button light small" href={session.sharing.galleryUrl} target="_blank" rel="noreferrer">
                  <ArrowUpRight size={14} /> Open cloud gallery
                </a>
              </div>
            ) : (
              <>
                {session.sharing?.error && <p className="inline-error">{session.sharing.error}</p>}
                {sharingEnabled ? (
                  <button type="button" className="button light" disabled={uploading || sending} onClick={() => void share()}>
                    {uploading ? <Loader2 size={15} className="spin" /> : <CloudUpload size={15} />}
                    {uploading ? "Uploading photos…" : session.sharing ? "Retry photo upload" : "Upload photo gallery"}
                  </button>
                ) : <p>Connect Backblaze B2 to retry uploading this session.</p>}
              </>
            )}
          </section>
        )}
        {session.deliveries?.length ? (
          <section className="delivery-history">
            <h3>Where the memories went</h3>
            {session.deliveries.map((delivery, i) => (
              <div key={i}>
                <Mail size={14} />
                <span>
                  <strong>{delivery.email}</strong>
                  <small>{dateLabel(delivery.createdAt)}</small>
                  {delivery.error && (
                    <small className="delivery-error">{delivery.error}</small>
                  )}
                </span>
                <span
                  className={`delivery-badge ${delivery.status === "sent" ? "sent" : ""}`}
                >
                  {delivery.status === "sent" ? "Accepted by Gmail" : "Failed"}
                </span>
              </div>
            ))}
          </section>
        ) : null}
        {session.error && <div className="inline-error">{session.error}</div>}
        <form className="session-send-form" onSubmit={send}>
          <label className="field">
            {session.status === "sent"
              ? "Send these smiles to another inbox"
              : "Send these smiles to an inbox"}
            <input
              type="email"
              required
              value={email}
              placeholder="guest@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button className="button dark" disabled={sending || uploading}>
            {sending ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Mail size={16} />
            )}
            {sending ? "Sending…" : "Send photos"}
          </button>
        </form>
      </div>
    </Modal>
  );
}
