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
import { AI_ACCELERATIONS, AI_MODELS, type AiRuntimeInfo } from "@/lib/ai-models";
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
  { value: "ai", label: "AI people", detail: "No green screen needed." },
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
  const [runtime, setRuntime] = useState<AiRuntimeInfo | null>(null);
  const [performance, setPerformance] = useState<PreviewPerformance | null>(null);
  const [measurements, setMeasurements] = useState<Record<string, PreviewPerformance>>({});
  const modeGroupId = useId();
  const modelGroupId = useId();
  const accelerationGroupId = useId();
  const draftChroma = { ...chroma, enabled: backgroundMode === "green-screen" };
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
        disabled={busy}
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
            ? "AI runs on this device and works best with people close to the camera in even light. Fine hair and props can have imperfect edges."
            : backgroundMode === "green-screen"
              ? "Keep your green screen smooth and evenly lit, then adjust the sliders for natural edges."
              : "Background replacement is off. Your photos will keep everything visible in the camera."}
        </p>
      </fieldset>
      {backgroundMode === "ai" && (
        <fieldset
          className="background-mode-field ai-model-field"
          aria-describedby={`${modelGroupId}-help`}
          disabled={busy}
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
                    setPerformance(null);
                    setRuntime(null);
                  }}
                />
                <span>
                  <strong>{model.label}</strong>
                  <small className="ai-model-name">
                    {model.name} · {model.id === "modnet"
                      ? `up to ${model.inputSize} px`
                      : `${model.inputSize} × ${model.inputSize}`}
                  </small>
                  <small>{model.description}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="background-mode-help" id={`${modelGroupId}-help`}>
            All models run locally. Try each in live preview on your booth computer;
            a larger model may handle edges differently but is not always better.
            Save adjustments to use your choice in the kiosk.
          </p>
        </fieldset>
      )}
      {backgroundMode === "ai" && (
        <fieldset
          className="background-mode-field ai-acceleration-field"
          aria-describedby={`${accelerationGroupId}-help`}
          disabled={busy}
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
                  <small>{acceleration.description}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="background-mode-help" id={`${accelerationGroupId}-help`}>
            Auto tries GPU first and falls back to CPU. GPU mode reports an error if
            acceleration is unavailable. The comparison shows which device actually ran.
          </p>
        </fieldset>
      )}
      {preview && (
        <div className="chroma-inline-preview">
          <LivePreview
            settings={{ ...settings, backgroundMode, aiModel, aiAcceleration, chroma: draftChroma }}
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
                ? "Open live preview to measure"
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
            Preview is capped at 12 FPS, and Canon supplies about one frame per second,
            so compare processing times as well as the picture.
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
            onClick={() => {
              setPreview(!preview);
              setPerformance(null);
              setRuntime(null);
            }}
          >
            {preview ? "Close live preview" : "Open live preview"}
            <Expand size={14} />
          </button>
          <button
            className="button dark small"
            disabled={busy}
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
  busy,
  onSave,
  onConnect,
  onCheck,
}: {
  settings: KioskSettings;
  background?: Background;
  camera: CameraState;
  busy: boolean;
  onSave: SaveSettings;
  onConnect: (value: boolean) => void;
  onCheck: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings.camera);
  const [preview, setPreview] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const previewStatus = useCallback(
    (status: { ready: boolean }) => {
      onConnect(status.ready);
      if (status.ready)
        navigator.mediaDevices
          ?.enumerateDevices()
          .then((items) =>
            setDevices(items.filter((d) => d.kind === "videoinput")),
          )
          .catch(() => {});
    },
    [onConnect],
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
      if (draft.mode === "canon") void onCheck();
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
                    {camera.connected ? "Connected" : "Not connected"}
                  </Status>
                </div>
                <div className="soft-note">
                  <Usb size={18} />
                  <p>
                    {camera.connected
                      ? "Your camera is connected. Close other camera apps before starting a session."
                      : camera.error ||
                        "Connect the camera by USB, turn it on, and close EOS Utility. Install gphoto2 on the studio computer to enable direct tethering."}
                  </p>
                </div>
                <div className="fields-three">
                  <label className="field">
                    ISO
                    <select
                      value={draft.iso}
                      onChange={(e) =>
                        setDraft({ ...draft, iso: e.target.value })
                      }
                    >
                      {["100", "200", "400", "800", "1600", "3200"].map((v) => (
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
                  Set your Canon to Manual (M) and JPEG capture. Preferences
                  apply to the connected camera when saved.
                </p>
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
            <p>The view your guests will see.</p>
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
                  Connect camera
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
            Close preview
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
  onClose,
  onUpdate,
  notify,
}: {
  session: PhotoSession;
  onClose: () => void;
  onUpdate: (session: PhotoSession) => Promise<void>;
  notify: Notify;
}) {
  const [email, setEmail] = useState(session.email || "");
  const [sending, setSending] = useState(false);
  async function send(e: FormEvent) {
    e.preventDefault();
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
          <button className="button dark" disabled={sending}>
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
