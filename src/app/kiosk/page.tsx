"use client";

/* Captured data URLs and local upload URLs already contain their original image data. */
/* eslint-disable @next/next/no-img-element */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  LoaderCircle,
  Mail,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import type { PhotoSession, StudioData } from "@/lib/kiosk-types";
import { resolveSessionBackgrounds } from "@/lib/background-sequence";
import {
  LivePreview,
  type PreviewStatus,
} from "@/components/kiosk/live-preview";
import { PhotoSharing } from "@/components/kiosk/photo-sharing";
import { EmailKeyboard } from "@/components/kiosk/email-keyboard";
import { LocalIpOverlay } from "@/components/kiosk/local-ip-overlay";
import { DiwaliLogo } from "@/components/kiosk/diwali-logo";
import { MagicLayer } from "@/components/kiosk/magic-layer";
import type { FxRect, MagicFx } from "@/components/kiosk/magic-fx";
import {
  runCaptureSequence,
  waitForCaptureScene,
  type CapturePhoto,
  type CaptureReadiness,
} from "@/components/kiosk/capture-sequence";
import "./kiosk.css";

type Stage = "idle" | "capturing" | "saving" | "review" | "sending" | "success";

/** The build this page was compiled from; the server reports its own in /api/kiosk. */
const PAGE_BUILD = process.env.NEXT_PUBLIC_KIOSK_BUILD ?? null;

/**
 * After a deploy the server runs new code while the kiosk still shows the old
 * page. Reload once, between guests, so the booth picks the new build up on
 * its own. Returns true when a reload has been requested.
 */
function reloadForNewBuild(serverBuild: string | null | undefined, stage: Stage): boolean {
  if (!serverBuild || !PAGE_BUILD || serverBuild === PAGE_BUILD || stage !== "idle") return false;
  try {
    // A page that keeps mismatching (a stale cache, say) must not reload forever.
    if (window.sessionStorage.getItem("kiosk-reloaded-for") === serverBuild) return false;
    window.sessionStorage.setItem("kiosk-reloaded-for", serverBuild);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** How much drifting gold light floats behind each screen. */
const AMBIENT: Record<Stage, number> = { idle: 1, capturing: 0.55, saving: 0.7, review: 0.8, sending: 0.8, success: 1 };

const rectOf = (element: Element | null | undefined): FxRect | null => {
  const box = element?.getBoundingClientRect();
  return box && box.width > 0 ? { left: box.left, top: box.top, width: box.width, height: box.height } : null;
};
const centerOf = (rect: FxRect): [number, number] => [rect.left + rect.width / 2, rect.top + rect.height / 2];

async function api<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(data?.error || "Something went wrong. Please try again.");
  return data as T;
}

export default function KioskPage() {
  const [studio, setStudio] = useState<Omit<StudioData, "sessions"> | null>(
    null,
  );
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [settingsRefreshing, setSettingsRefreshing] = useState(true);
  const [stage, setStage] = useState<Stage>("idle");
  const [cameraStatus, setCameraStatus] = useState<PreviewStatus>({
    ready: false,
    loading: true,
    error: null,
    label: "Camera",
    fps: 0,
    renderer: null,
  });
  // ?stats shows the preview's frame rate and renderer in the Live badge.
  // The badge only renders after the booth has loaded on the client, so the
  // server-rendered markup never shows the difference.
  const [showStats] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("stats"),
  );
  const [countdown, setCountdown] = useState(5);
  const [photoNumber, setPhotoNumber] = useState(1);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState(0);
  const [session, setSession] = useState<PhotoSession | null>(null);
  const [email, setEmail] = useState("");
  const [sentAddress, setSentAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sharingError, setSharingError] = useState<string | null>(null);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [resetIn, setResetIn] = useState(20);
  // Screen-only state: whether the touch keyboard sheet for email is showing.
  const [emailOpen, setEmailOpen] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<CaptureReadiness>({ capture: null });
  const cameraErrorRef = useRef<string | null>(null);
  const sessionBackgroundNamesRef = useRef<[string, string, string]>(["Original background", "Original background", "Original background"]);
  const flowAbortRef = useRef<AbortController | null>(null);
  const shareRequestRef = useRef<{ sessionId: string; controller: AbortController } | null>(null);
  const settingsAbortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef("");
  const stageRef = useRef<Stage>("idle");
  useEffect(() => { stageRef.current = stage; }, [stage]);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fxRef = useRef<MagicFx | null>(null);
  const fxTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const previewRef = useRef<HTMLDivElement>(null);
  const slotsRef = useRef<HTMLElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);

  const loadStudio = useCallback(async (signal?: AbortSignal) => {
    settingsAbortRef.current?.abort();
    const controller = new AbortController();
    settingsAbortRef.current = controller;
    const requestSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const data = await api<Omit<StudioData, "sessions"> & { build?: string | null }>(
        "/api/kiosk",
        undefined,
        requestSignal,
      );
      if (requestSignal.aborted) return;
      if (reloadForNewBuild(data.build, stageRef.current)) return;
      setStudio(data);
      setLoadingError(null);
      setSettingsRefreshing(false);
    } catch (error) {
      if (!requestSignal.aborted)
        setLoadingError(
          error instanceof Error
            ? error.message
            : "We could not load this photo booth.",
        );
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return loadStudio(controller.signal);
    });
    return () => {
      controller.abort();
      settingsAbortRef.current?.abort();
      flowAbortRef.current?.abort();
      shareRequestRef.current?.controller.abort();
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      fxTimersRef.current.forEach(clearTimeout);
    };
  }, [loadStudio]);

  /** Runs a light effect later, unless the guest has moved on by then. */
  const fxLater = useCallback((ms: number, run: (fx: MagicFx) => void) => {
    const timer = setTimeout(() => {
      fxTimersRef.current = fxTimersRef.current.filter((item) => item !== timer);
      if (fxRef.current) run(fxRef.current);
    }, ms);
    fxTimersRef.current.push(timer);
  }, []);

  // Pick up the host's camera and background changes between guests.
  useEffect(() => {
    if (stage !== "idle") return;
    const controller = new AbortController();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible")
        void loadStudio(controller.signal);
    }, 15000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [stage, loadStudio]);

  const reset = useCallback(() => {
    fxTimersRef.current.forEach(clearTimeout);
    fxTimersRef.current = [];
    fxRef.current?.clear();
    flowAbortRef.current?.abort();
    flowAbortRef.current = null;
    shareRequestRef.current?.controller.abort();
    shareRequestRef.current = null;
    captureRef.current = { capture: null };
    setSettingsRefreshing(true);
    setLoadingError(null);
    setStage("idle");
    setPhotos([]);
    setSession(null);
    setSelectedPhoto(0);
    setPhotoNumber(1);
    setPreparingPhoto(false);
    setCountdown(5);
    setEmail("");
    setEmailOpen(false);
    setSentAddress("");
    setError(null);
    setSharingError(null);
    setSharingBusy(false);
    setFlash(false);
    void loadStudio();
  }, [loadStudio]);

  useEffect(() => {
    if (stage !== "success" || sharingBusy) return;
    const interval = setInterval(
      () => setResetIn((value) => Math.max(0, value - 1)),
      1000,
    );
    const timeout = setTimeout(reset, 20000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [stage, sharingBusy, reset]);

  const plannedBackgrounds = studio
    ? resolveSessionBackgrounds(studio.settings, studio.backgrounds)
    : [undefined, undefined, undefined];
  const background = plannedBackgrounds[photoNumber - 1];
  const overlay = studio?.overlays.find((item) => item.id === studio.settings.activeOverlayId);
  const onCaptureReady = useCallback((capture: CapturePhoto | null, backgroundUrl?: string) => {
    captureRef.current = { capture, backgroundUrl };
  }, []);
  const onCameraStatus = useCallback((status: PreviewStatus) => {
    cameraErrorRef.current = status.error;
    setCameraStatus(status);
  }, []);
  const needsBackground = Boolean(
    studio && studio.settings.backgroundMode !== "off" && plannedBackgrounds.some((item) => !item),
  );

  async function sharePhotos(savedSession: PhotoSession) {
    if (shareRequestRef.current?.sessionId === savedSession.id || savedSession.sharing?.status === "uploaded") return;
    const controller = new AbortController();
    shareRequestRef.current?.controller.abort();
    shareRequestRef.current = { sessionId: savedSession.id, controller };
    setSharingBusy(true);
    setSharingError(null);
    setResetIn(20);
    try {
      const result = await api<{ session: PhotoSession }>(
        `/api/sessions/${encodeURIComponent(savedSession.id)}/share`,
        {},
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.session.sharing?.status !== "uploaded" || !result.session.sharing.galleryUrl) {
        throw new Error(result.session.sharing?.error || "Your photo upload has not finished. Please try again.");
      }
      // Email may complete while the upload is running. Preserve its delivery state.
      setSession((current) => current?.id === savedSession.id ? { ...current, sharing: result.session.sharing } : current);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSharingError(`We couldn’t prepare your QR code. Your photos are still saved on this booth. ${error instanceof Error ? error.message : "Please try again."}`);
    } finally {
      if (shareRequestRef.current?.controller === controller) {
        shareRequestRef.current = null;
        if (!controller.signal.aborted) setSharingBusy(false);
      }
    }
  }

  async function savePhotos(capturedPhotos: string[], signal?: AbortSignal) {
    if (!signal) {
      flowAbortRef.current?.abort();
      const controller = new AbortController();
      flowAbortRef.current = controller;
      signal = controller.signal;
    }
    if (signal.aborted) return;
    setStage("saving");
    setError(null);
    try {
      const result = await api<{ session: PhotoSession }>(
        "/api/sessions",
        {
          photos: capturedPhotos,
          backgroundName: new Set(sessionBackgroundNamesRef.current).size === 1
            ? sessionBackgroundNamesRef.current[0] : "Mixed backgrounds",
          backgroundNames: sessionBackgroundNamesRef.current,
          requestId: requestIdRef.current,
        },
        signal,
      );
      if (signal?.aborted) return;
      setSession(result.session);
      setStage("review");
      if (studio?.settings.b2.configured) void sharePhotos(result.session);
    } catch (error) {
      if (signal?.aborted) return;
      setStage("review");
      setError(
        `Your photos are still here, but we couldn’t save them. ${error instanceof Error ? error.message : "Please try again."}`,
      );
    }
  }

  async function startCapture() {
    if (!captureRef.current.capture || needsBackground || settingsRefreshing || stage !== "idle")
      return;
    // Freeze the selected camera and scene until this guest finishes.
    settingsAbortRef.current?.abort();
    const controller = new AbortController();
    flowAbortRef.current?.abort();
    flowAbortRef.current = controller;
    requestIdRef.current = crypto.randomUUID();
    sessionBackgroundNamesRef.current = plannedBackgrounds.map((item) => item?.name || "Original background") as [string, string, string];
    setPhotos([]);
    setSession(null);
    setError(null);
    // A failed session can leave a later number behind; the first frame must show the 5.
    setCountdown(5);
    setStage("capturing");
    const button = rectOf(startButtonRef.current);
    const preview = rectOf(previewRef.current);
    if (button) {
      const [x, y] = centerOf(button);
      fxRef.current?.ring(x, y, { count: 160, speed: 620 });
      fxRef.current?.burst(x, y, { count: 110, speed: 760, glints: 24, flash: 110 });
    }
    // Flames spiral up around the camera, like stepping into Atma Mirror.
    if (preview) fxRef.current?.vortex(preview, { strands: 3, duration: 1.6, radius: 0.5, turns: 1.1, width: 0.2, tilt: 0.16 });
    let preparedCapture: CapturePhoto | null = null;
    let taken = 0;
    try {
      const capturedPhotos = await runCaptureSequence({
        signal: controller.signal,
        preparePhoto: async (number, signal) => {
          setPhotoNumber(number);
          const sceneUrl = plannedBackgrounds[number - 1]?.url;
          const readScene = () => ({ ...captureRef.current, error: cameraErrorRef.current });
          const live = readScene();
          // Photo 1's scene is already live from the idle preview. Showing the
          // "preparing" spinner then would only flash it for a frame right where
          // the 5 pops in, so the spinner is kept for scenes that must load.
          if (live.capture && live.backgroundUrl === sceneUrl && !live.error) {
            preparedCapture = live.capture;
            return;
          }
          setPreparingPhoto(true);
          preparedCapture = await waitForCaptureScene(readScene, sceneUrl, signal);
          setPreparingPhoto(false);
        },
        capture: (signal, options) => {
          if (!preparedCapture) throw new Error("Please wait for the next scene to load.");
          return preparedCapture(signal, options);
        },
        onCountdown: (seconds, number) => {
          setCountdown(seconds);
          setPhotoNumber(number);
          const frame = rectOf(previewRef.current);
          if (frame && seconds > 0) {
            const [x, y] = centerOf(frame);
            fxRef.current?.ring(x, y, { count: 70, speed: 300, life: 0.8 });
          }
        },
        onPhoto: (photo) => {
          const index = taken++;
          setPhotos((current) => [...current, photo]);
          setFlash(true);
          if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
          flashTimeoutRef.current = setTimeout(() => setFlash(false), 230);
          // A burst of light at the camera, then sparkles carry the photo to its slot.
          const frame = rectOf(previewRef.current);
          const slot = rectOf(slotsRef.current?.children[index]);
          const fx = fxRef.current;
          if (!frame || !fx) return;
          const from = centerOf(frame);
          fx.burst(from[0], from[1], { count: 90, speed: 680, glints: 18, flash: 140 });
          if (!slot) return;
          const arrive = fx.flight(from, centerOf(slot), { count: 150 });
          fxLater(arrive * 1000 - 80, (later) => {
            const landed = rectOf(slotsRef.current?.children[index]) ?? slot;
            const [x, y] = centerOf(landed);
            later.burst(x, y, { count: 50, speed: 420, glints: 10, flash: 70 });
            later.twinkle(landed, { count: 14, duration: 0.7, size: 11 });
          });
        },
      });
      await savePhotos(capturedPhotos, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setStage("idle");
      setPhotoNumber(1);
      setPreparingPhoto(false);
      setPhotos([]);
      setError(
        error instanceof Error
          ? error.message
          : "The camera could not take the photos. Please try again.",
      );
    }
  }

  async function sendPhotos(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || stage !== "review" || !studio?.settings.gmail.configured) return;
    const address = email.trim();
    setError(null);
    setStage("sending");
    const controller = new AbortController();
    flowAbortRef.current = controller;
    try {
      const result = await api<{ session: PhotoSession }>(
        `/api/sessions/${encodeURIComponent(session.id)}/email`,
        { email: address },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.session.status !== "sent")
        throw new Error(
          result.session.error ||
            "Your email has not been sent yet. Please try again.",
        );
      setSession((current) => current?.id === result.session.id
        ? { ...result.session, sharing: current.sharing ?? result.session.sharing }
        : current);
      setSentAddress(address);
      setEmail("");
      setResetIn(20);
      setStage("success");
    } catch (error) {
      if (controller.signal.aborted) return;
      setStage("review");
      setError(
        error instanceof Error
          ? error.message
          : "We couldn’t send your photos. Please check your email and try again.",
      );
    }
  }

  const reviewing =
    stage === "review" || stage === "sending" || stage === "saving";
  const isCapturing = stage === "capturing";
  const canShare = Boolean(studio?.settings.b2.configured);
  const canEmail = Boolean(studio?.settings.gmail.configured);
  const showEmailSheet =
    emailOpen && canEmail && (stage === "review" || stage === "sending");

  useEffect(() => {
    if (showEmailSheet) emailInputRef.current?.focus();
  }, [showEmailSheet]);

  // Light for the photos once they're ready, and fireworks when they're sent.
  useEffect(() => {
    if (stage === "review") {
      fxLater(250, (fx) => {
        const frame = rectOf(previewRef.current);
        if (frame) fx.twinkle(frame, { count: 26, duration: 1.2 });
      });
    } else if (stage === "success") {
      fxLater(2500, (fx) => {
        fx.fireworks({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight * 0.55 }, { count: 7, duration: 6 });
      });
    }
  }, [stage, fxLater]);

  const capturePrompt = preparingPhoto
    ? "Getting your next background ready…"
    : countdown === 0
      ? "Hold that pose…"
      : photoNumber === 1
        ? "Look at the camera and smile!"
        : photoNumber === 2
          ? "New pose. Go!"
          : "Last one. Make it silly!";

  return (
    <main className={`kiosk-shell is-${stage}`}>
      <MagicLayer fxRef={fxRef} ambient={studio ? AMBIENT[stage] : 1} />
      <LocalIpOverlay />
      {studio && stage !== "idle" && (
        <header className="kiosk-header">
          <div className="kiosk-brand">
            <DiwaliLogo />
          </div>
        </header>
      )}

      {!studio ? (
        <section className="kiosk-loading">
          <div className="kiosk-loading-logo">
            <DiwaliLogo />
          </div>
          <h1>{loadingError ? "One moment…" : "Setting up the booth…"}</h1>
          <p>
            {loadingError || "The camera and backgrounds are almost ready."}
          </p>
          {loadingError ? (
            <button
              className="kiosk-primary"
              type="button"
              onClick={() => void loadStudio()}
            >
              <RefreshCw size={36} strokeWidth={2.4} />
              Try again
            </button>
          ) : (
            <LoaderCircle
              size={64}
              className="still-camera-spinner kiosk-loading-spinner"
            />
          )}
        </section>
      ) : stage === "success" ? (
        <section className="kiosk-success">
          <div className="kiosk-confetti" aria-hidden="true">
            {CONFETTI.map((piece, index) => (
              <span key={index} style={piece} />
            ))}
          </div>
          <div className="kiosk-send-stage" aria-hidden="true">
            <div className="kiosk-envelope">
              <div className="kiosk-envelope-back" />
              <div className="kiosk-envelope-photos">
                {photos.map((photo, index) => (
                  <img key={index} src={photo} alt="" />
                ))}
              </div>
              <div className="kiosk-envelope-front" />
              <div className="kiosk-envelope-flap" />
            </div>
            <div className="kiosk-success-check">
              <Check size={96} strokeWidth={2.6} />
            </div>
          </div>
          <h1>On its way!</h1>
          <p>
            Your three photos are heading to
            <br />
            <strong>{sentAddress}</strong>
          </p>
          <p className="kiosk-success-hint">
            Not there in a few minutes? Check your spam folder.
          </p>
          {canShare && session && (
            <PhotoSharing
              sharing={session.sharing}
              busy={sharingBusy}
              error={sharingError}
              onRetry={() => void sharePhotos(session)}
            />
          )}
          <div className="kiosk-success-footer">
            {!sharingBusy && (
              <>
                <p className="kiosk-reset-note">
                  Back to the start in {resetIn} seconds
                </p>
                <div className="kiosk-reset-bar" aria-hidden="true">
                  <span style={{ width: `${(resetIn / 20) * 100}%` }} />
                </div>
              </>
            )}
            <button className="kiosk-primary" type="button" onClick={reset}>
              Next guest <ArrowRight size={44} strokeWidth={2.6} />
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="kiosk-heading">
            {reviewing ? (
              <>
                <h1>Your photos</h1>
                <p>Tap a photo to see it big.</p>
              </>
            ) : isCapturing ? (
              <>
                <h1 key={photoNumber}>Photo {photoNumber} of 3</h1>
                <p>{capturePrompt}</p>
              </>
            ) : (
              <div className="kiosk-sign">
                {BULBS.map((bulb, index) => (
                  <span
                    key={index}
                    className="kiosk-bulb"
                    style={bulb}
                    aria-hidden="true"
                  />
                ))}
                <div className="kiosk-sign-panel">
                  <DiwaliLogo />
                  <h1>
                    <span>Photo</span>
                    <span>booth</span>
                  </h1>
                </div>
              </div>
            )}
          </section>

          <section
            className={`kiosk-experience ${reviewing ? "is-reviewing" : ""}`}
          >
            <div className="kiosk-camera-area">
              <div className="kiosk-preview-frame" ref={previewRef}>
                <LivePreview
                  settings={studio.settings}
                  background={background}
                  overlay={overlay}
                  enabled={!reviewing && !settingsRefreshing}
                  allowCanonPreview={stage === "idle" && !settingsRefreshing}
                  autoConnectCanon
                  onCaptureReady={onCaptureReady}
                  onStatusChange={onCameraStatus}
                />
                {reviewing && photos[selectedPhoto] && (
                  <img
                    key={selectedPhoto}
                    className="kiosk-review-main"
                    src={photos[selectedPhoto]}
                    alt={`Captured photo ${selectedPhoto + 1}`}
                  />
                )}
                {!reviewing && (
                  <div className="kiosk-live-badge">
                    <span className={cameraStatus.ready ? "is-ready" : ""} />
                    {cameraStatus.ready ? "Live" : "Camera starting"}
                    {showStats && cameraStatus.ready && ` · ${cameraStatus.fps} fps · ${cameraStatus.renderer === "webgl" ? "GPU" : "CPU"}`}
                  </div>
                )}
                {isCapturing && (
                  <div
                    className="kiosk-countdown-overlay"
                    aria-live="assertive"
                  >
                    <span className="kiosk-sr-only">
                      Photo {photoNumber} of 3.
                    </span>
                    <strong key={`${photoNumber}-${countdown}-${preparingPhoto}`}>
                      {preparingPhoto ? (
                        <LoaderCircle
                          size={140}
                          strokeWidth={2}
                          className="still-camera-spinner"
                        />
                      ) : (
                        countdown ? (
                          <span className="kiosk-count-number">{countdown}</span>
                        ) : (
                          <Camera size={170} strokeWidth={1.8} />
                        )
                      )}
                    </strong>
                  </div>
                )}
                {flash && <div className="kiosk-flash" />}
                {stage === "saving" && (
                  <div className="kiosk-saving-overlay">
                    <LoaderCircle size={64} className="still-camera-spinner" />
                    <span>Saving your photos…</span>
                  </div>
                )}
              </div>
              {reviewing && (
                <div
                  className="kiosk-review-thumbnails"
                  role="group"
                  aria-label="Choose a photo to view"
                >
                  {photos.map((photo, index) => (
                    <button
                      key={index}
                      type="button"
                      className={selectedPhoto === index ? "is-selected" : ""}
                      onClick={() => setSelectedPhoto(index)}
                      aria-label={`View photo ${index + 1}`}
                      aria-pressed={selectedPhoto === index}
                    >
                      <img src={photo} alt="" />
                      <span>{index + 1}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {reviewing ? (
              <aside className="kiosk-share-panel">
                {canShare && session && (
                  <PhotoSharing
                    sharing={session.sharing}
                    busy={sharingBusy}
                    error={sharingError}
                    onRetry={() => void sharePhotos(session)}
                  />
                )}
                {!canShare && !canEmail && (
                  <p className="kiosk-share-note">
                    Ask your host for a copy of your photos.
                  </p>
                )}
                {error && !showEmailSheet && (
                  <div className="kiosk-inline-error" role="alert">
                    {error}
                  </div>
                )}
                {!session && stage === "review" && (
                  <button
                    type="button"
                    className="kiosk-primary kiosk-save-retry"
                    onClick={() => void savePhotos(photos)}
                  >
                    <RefreshCw size={36} strokeWidth={2.4} /> Retry saving
                    photos
                  </button>
                )}
                {canEmail && (
                  <button
                    type="button"
                    className={`kiosk-email-open ${canShare ? "kiosk-secondary" : "kiosk-primary"}`}
                    onClick={() => setEmailOpen(true)}
                    disabled={stage !== "review" || !session}
                  >
                    <Mail size={40} strokeWidth={2.2} />
                    {canShare ? "Or email them to me" : "Email my photos"}
                  </button>
                )}
                <div className="kiosk-review-actions">
                  <button
                    type="button"
                    className="is-done"
                    onClick={reset}
                    disabled={stage === "sending" || stage === "saving"}
                  >
                    I’m done
                    <ArrowRight size={32} strokeWidth={2.4} />
                  </button>
                </div>
              </aside>
            ) : (
              <aside className="kiosk-photo-slots" aria-label="Your three photos" ref={slotsRef}>
                {[0, 1, 2].map((index) => (
                  <div
                    className={`kiosk-slot ${photos[index] ? "is-filled" : ""} ${isCapturing && !photos[index] && photoNumber === index + 1 ? "is-next" : ""}`}
                    key={index}
                  >
                    {photos[index] ? (
                      <>
                        <img
                          src={photos[index]}
                          alt={`Photo ${index + 1}, taken`}
                        />
                        <span className="kiosk-slot-check" aria-hidden="true">
                          <Check size={30} strokeWidth={3} />
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="kiosk-slot-number">{index + 1}</span>
                        <span>
                          {index === 0
                            ? "Big smiles"
                            : index === 1
                              ? "New pose"
                              : "Go silly"}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </aside>
            )}
          </section>

          {!reviewing && (
            <section className="kiosk-controls">
              {settingsRefreshing && (
                <div
                  className="kiosk-config-note"
                  role={loadingError ? "alert" : "status"}
                >
                  {loadingError ? (
                    <>
                      <span>
                        We couldn’t refresh the booth settings. {loadingError}
                      </span>
                      <button
                        type="button"
                        className="kiosk-secondary"
                        onClick={() => void loadStudio()}
                      >
                        <RefreshCw size={28} strokeWidth={2.4} />
                        Try again
                      </button>
                    </>
                  ) : (
                    <span>Getting the booth ready…</span>
                  )}
                </div>
              )}
              {error && (
                <p className="kiosk-main-error" role="alert">
                  {error}
                </p>
              )}
              {needsBackground && (
                <p className="kiosk-main-error" role="alert">
                  Ask your host to choose a background in the studio before you
                  start.
                </p>
              )}
              {isCapturing ? (
                <button
                  className="kiosk-secondary kiosk-cancel"
                  type="button"
                  onClick={reset}
                >
                  <X size={36} strokeWidth={2.4} />
                  Cancel
                </button>
              ) : (
                <>
                  <button
                    ref={startButtonRef}
                    className="kiosk-primary kiosk-start-button"
                    type="button"
                    onClick={() => void startCapture()}
                    disabled={
                      !cameraStatus.ready ||
                      needsBackground ||
                      settingsRefreshing
                    }
                  >
                    <Camera size={60} strokeWidth={2.2} />
                    <span className="kiosk-start-label">Tap to start</span>
                  </button>
                  <ol className="kiosk-instructions">
                    <li>
                      <span>1</span>Strike a pose
                    </li>
                    <li>
                      <span>2</span>Three photos
                    </li>
                    <li>
                      <span>3</span>
                      {canShare
                        ? "Scan to keep them"
                        : canEmail
                          ? "Get them by email"
                          : "See your photos"}
                    </li>
                  </ol>
                </>
              )}
            </section>
          )}
        </>
      )}

      {showEmailSheet && (
        <div
          className="kiosk-email-sheet"
          data-ip-shortcut-ignore
          role="dialog"
          aria-modal="true"
          aria-labelledby="kiosk-email-title"
        >
          <form className="kiosk-email-form" onSubmit={sendPhotos}>
            <h2 id="kiosk-email-title">Your email</h2>
            <label htmlFor="guest-email">
              We’ll send all three photos here.
            </label>
            <input
              ref={emailInputRef}
              id="guest-email"
              type="email"
              name="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="none"
              placeholder="name@example.com"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={stage !== "review"}
            />
            {error && (
              <div className="kiosk-inline-error" role="alert">
                {error}
              </div>
            )}
            <div className="kiosk-email-photos" aria-hidden="true">
              {photos.map((photo, index) => (
                <img key={index} src={photo} alt="" />
              ))}
            </div>
            <EmailKeyboard
              value={email}
              onChange={setEmail}
              disabled={stage !== "review"}
            />
            <div className="kiosk-email-actions">
              <button
                type="button"
                className="kiosk-secondary"
                onClick={() => setEmailOpen(false)}
                disabled={stage === "sending"}
              >
                <ArrowLeft size={36} strokeWidth={2.4} />
                Back
              </button>
              <button
                className="kiosk-primary"
                type="submit"
                disabled={stage !== "review" || !session}
              >
                {stage === "sending" ? (
                  <>
                    <LoaderCircle size={40} className="still-camera-spinner" />
                    Sending…
                  </>
                ) : (
                  <>
                    Send <Send size={40} strokeWidth={2.4} />
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

/**
 * Marquee lights around the sign, clockwise from the top-left corner. They run
 * 15px in from the edge, so on the sign's 52px rounded corners they follow a
 * 37px curve: one bulb sits at the middle of each corner, and the rest are
 * spaced evenly along the straight sides between the curves.
 */
const BULBS: CSSProperties[] = (() => {
  const inset = 15;
  const radius = 52; // .kiosk-sign border-radius
  const across = 15;
  const down = 6;
  const corner = `${(radius - (radius - inset) * Math.SQRT1_2).toFixed(2)}px`;
  const far = `calc(100% - ${corner})`;
  const side = (fraction: number) =>
    `calc(${radius}px + (100% - ${radius * 2}px) * ${fraction.toFixed(4)})`;
  const step = (count: number, i: number) => (i + 0.5) / count;
  const points: Array<[string, string]> = [[corner, corner]];
  for (let i = 0; i < across; i++) points.push([side(step(across, i)), `${inset}px`]);
  points.push([far, corner]);
  for (let i = 0; i < down; i++) points.push([`calc(100% - ${inset}px)`, side(step(down, i))]);
  points.push([far, far]);
  for (let i = 0; i < across; i++) points.push([side(1 - step(across, i)), `calc(100% - ${inset}px)`]);
  points.push([corner, far]);
  for (let i = 0; i < down; i++) points.push([`${inset}px`, side(1 - step(down, i))]);
  return points.map(([left, top], index) => ({
    left,
    top,
    // Read by the bulb's ::after, whose opacity carries the chase.
    ["--k-delay" as string]: `${-((index % 3) * 0.4)}s`,
  }));
})();

/** Fixed confetti layout so every send celebrates the same way. */
const CONFETTI: CSSProperties[] = (() => {
  let seed = 7;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const colors = ["#ffe2a0", "#fff1c4", "#e8c879", "#ffb877", "#b8892e", "#bff3ff"];
  return Array.from({ length: 44 }, (_, index) => ({
    left: `${Math.round(random() * 96)}%`,
    width: `${Math.round(12 + random() * 10)}px`,
    height: `${Math.round(22 + random() * 14)}px`,
    background: colors[index % colors.length],
    animationDuration: `${(4.2 + random() * 3).toFixed(2)}s`,
    animationDelay: `${(2.3 + random() * 4).toFixed(2)}s`,
  }));
})();
