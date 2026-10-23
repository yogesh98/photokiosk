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
  Download,
  LoaderCircle,
  Mail,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import type { PhotoSession, StudioData } from "@/lib/kiosk-types";
import { resolveSessionBackgrounds } from "@/lib/background-sequence";
import { isNativeForegroundModel } from "@/lib/ai-models";
import {
  LivePreview,
  type PreviewStatus,
} from "@/components/kiosk/live-preview";
import { PhotoSharing } from "@/components/kiosk/photo-sharing";
import { EmailKeyboard } from "@/components/kiosk/email-keyboard";
import { LocalIpOverlay } from "@/components/kiosk/local-ip-overlay";
import {
  runCaptureSequence,
  waitForCaptureScene,
  type CapturePhoto,
  type CaptureReadiness,
} from "@/components/kiosk/capture-sequence";
import "./kiosk.css";

type Stage = "idle" | "capturing" | "saving" | "review" | "sending" | "success";

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
  });
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
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStudio = useCallback(async (signal?: AbortSignal) => {
    settingsAbortRef.current?.abort();
    const controller = new AbortController();
    settingsAbortRef.current = controller;
    const requestSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const data = await api<Omit<StudioData, "sessions">>(
        "/api/kiosk",
        undefined,
        requestSignal,
      );
      if (requestSignal.aborted) return;
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
    };
  }, [loadStudio]);

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
    setStage("capturing");
    let preparedCapture: CapturePhoto | null = null;
    try {
      const capturedPhotos = await runCaptureSequence({
        signal: controller.signal,
        preparePhoto: async (number, signal) => {
          setPhotoNumber(number);
          setPreparingPhoto(true);
          preparedCapture = await waitForCaptureScene(
            () => ({ ...captureRef.current, error: cameraErrorRef.current }),
            plannedBackgrounds[number - 1]?.url,
            signal,
            undefined,
            studio?.settings.backgroundMode === "ai" && isNativeForegroundModel(studio.settings.aiModel) ? 210000 : 30000,
          );
          setPreparingPhoto(false);
        },
        capture: (signal, options) => {
          if (!preparedCapture) throw new Error("Please wait for the next scene to load.");
          return preparedCapture(signal, options);
        },
        onCountdown: (seconds, number) => {
          setCountdown(seconds);
          setPhotoNumber(number);
        },
        onPhoto: (photo) => {
          setPhotos((current) => [...current, photo]);
          setFlash(true);
          if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
          flashTimeoutRef.current = setTimeout(() => setFlash(false), 230);
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

  function downloadPhotos() {
    photos.forEach((photo, index) => {
      const link = document.createElement("a");
      link.href = photo;
      link.download = `still-memory-${index + 1}.jpg`;
      link.click();
    });
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
      <LocalIpOverlay />
      {studio && stage !== "idle" && (
        <header className="kiosk-header">
          <div className="kiosk-brand">
            <img
              src="/brand/kdc-logo.png"
              alt="Kids’ Diwali Celebration"
              width={1024}
              height={576}
            />
          </div>
        </header>
      )}

      {!studio ? (
        <section className="kiosk-loading">
          <div className="kiosk-loading-logo">
            <img
              src="/brand/kdc-logo.png"
              alt="Kids’ Diwali Celebration"
              width={1024}
              height={576}
            />
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
                  <img
                    src="/brand/kdc-logo.png"
                    alt="Kids’ Diwali Celebration"
                    width={1024}
                    height={576}
                  />
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
              <div className="kiosk-preview-frame">
                <LivePreview
                  settings={studio.settings}
                  background={background}
                  enabled={!reviewing && !settingsRefreshing}
                  allowCanonPreview={stage === "idle" && !settingsRefreshing}
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
                        countdown || <Camera size={170} strokeWidth={1.8} />
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
                    Your three photos are ready to download on this booth.
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
                    onClick={reset}
                    disabled={stage === "sending" || stage === "saving"}
                  >
                    <RefreshCw size={32} strokeWidth={2.4} />
                    Retake
                  </button>
                  <button type="button" onClick={downloadPhotos}>
                    <Download size={32} strokeWidth={2.4} />
                    Download
                  </button>
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
              <aside className="kiosk-photo-slots" aria-label="Your three photos">
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
                    Tap to start
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
                          : "Download them"}
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

/** Marquee lights around the sign: positions run clockwise from the top-left corner. */
const BULBS: CSSProperties[] = (() => {
  const across = 16;
  const down = 5;
  const edge = (fraction: number) =>
    `calc(15px + (100% - 30px) * ${fraction.toFixed(4)})`;
  const points: Array<[string, string]> = [];
  for (let i = 0; i < across; i++) points.push([edge(i / across), "15px"]);
  for (let i = 0; i < down; i++) points.push(["calc(100% - 15px)", edge(i / down)]);
  for (let i = 0; i < across; i++)
    points.push([edge(1 - i / across), "calc(100% - 15px)"]);
  for (let i = 0; i < down; i++) points.push(["15px", edge(1 - i / down)]);
  return points.map(([left, top], index) => ({
    left,
    top,
    animationDelay: `${-((index % 3) * 0.4)}s`,
  }));
})();

/** Fixed confetti layout so every send celebrates the same way. */
const CONFETTI: CSSProperties[] = (() => {
  let seed = 7;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const colors = ["#f4f6fa", "#ffffff", "#5a6473", "#a9bfef", "#2f55b0", "#dde6f7"];
  return Array.from({ length: 44 }, (_, index) => ({
    left: `${Math.round(random() * 96)}%`,
    width: `${Math.round(12 + random() * 10)}px`,
    height: `${Math.round(22 + random() * 14)}px`,
    background: colors[index % colors.length],
    animationDuration: `${(4.2 + random() * 3).toFixed(2)}s`,
    animationDelay: `${(2.3 + random() * 4).toFixed(2)}s`,
  }));
})();
