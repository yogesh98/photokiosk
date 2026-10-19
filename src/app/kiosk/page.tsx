"use client";

/* Captured data URLs and local upload URLs already contain their original image data. */
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Aperture,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCheck,
  ChevronRight,
  Download,
  Expand,
  Heart,
  Image as ImageIcon,
  LoaderCircle,
  Mail,
  RefreshCw,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import type { PhotoSession, StudioData } from "@/lib/kiosk-types";
import {
  LivePreview,
  type PreviewStatus,
} from "@/components/kiosk/live-preview";
import {
  runCaptureSequence,
  type CapturePhoto,
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
  const [photos, setPhotos] = useState<string[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState(0);
  const [session, setSession] = useState<PhotoSession | null>(null);
  const [email, setEmail] = useState("");
  const [sentAddress, setSentAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [resetIn, setResetIn] = useState(20);
  const captureRef = useRef<CapturePhoto | null>(null);
  const flowAbortRef = useRef<AbortController | null>(null);
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
    captureRef.current = null;
    setSettingsRefreshing(true);
    setLoadingError(null);
    setStage("idle");
    setPhotos([]);
    setSession(null);
    setSelectedPhoto(0);
    setPhotoNumber(1);
    setCountdown(5);
    setEmail("");
    setSentAddress("");
    setError(null);
    setFlash(false);
    void loadStudio();
  }, [loadStudio]);

  useEffect(() => {
    if (stage !== "success") return;
    const interval = setInterval(
      () => setResetIn((value) => Math.max(0, value - 1)),
      1000,
    );
    const timeout = setTimeout(reset, 20000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [stage, reset]);

  const onCaptureReady = useCallback((capture: CapturePhoto | null) => {
    captureRef.current = capture;
  }, []);
  const background = studio?.backgrounds.find(
    (item) => item.id === studio.settings.activeBackgroundId,
  );
  const needsBackground = Boolean(
    studio?.settings.chroma.enabled && !background,
  );

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
          backgroundName: background?.name || "Original background",
          requestId: requestIdRef.current,
        },
        signal,
      );
      if (signal?.aborted) return;
      setSession(result.session);
      setStage("review");
    } catch (error) {
      if (signal?.aborted) return;
      setStage("review");
      setError(
        `Your photos are still here, but we couldn’t save them. ${error instanceof Error ? error.message : "Please try again."}`,
      );
    }
  }

  async function startCapture() {
    const capture = captureRef.current;
    if (!capture || needsBackground || settingsRefreshing || stage !== "idle")
      return;
    // Freeze the selected camera and scene until this guest finishes.
    settingsAbortRef.current?.abort();
    const controller = new AbortController();
    flowAbortRef.current?.abort();
    flowAbortRef.current = controller;
    requestIdRef.current = crypto.randomUUID();
    setPhotos([]);
    setSession(null);
    setError(null);
    setStage("capturing");
    try {
      const capturedPhotos = await runCaptureSequence({
        signal: controller.signal,
        capture,
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
    if (!session || stage !== "review") return;
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
      setSession(result.session);
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

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError(
        "Fullscreen is unavailable in this browser. You can keep using the photo booth here.",
      );
    }
  }

  const reviewing =
    stage === "review" || stage === "sending" || stage === "saving";
  const isCapturing = stage === "capturing";

  return (
    <main className="kiosk-shell">
      <header className="kiosk-header">
        <Link href="/" className="kiosk-brand" aria-label="Still photo studio">
          <Aperture size={30} strokeWidth={1.7} />
          <span>
            still<span className="kiosk-brand-dot">.</span>
          </span>
        </Link>
        <div className="kiosk-event">
          <span className="kiosk-small-dot" />
          {studio?.settings.eventName || "A little moment. A lasting memory."}
        </div>
        <button
          type="button"
          className="kiosk-icon-button"
          aria-label="Toggle fullscreen"
          onClick={toggleFullscreen}
        >
          <Expand size={19} strokeWidth={1.6} />
        </button>
      </header>

      {!studio ? (
        <section className="kiosk-loading">
          <Aperture size={45} strokeWidth={1} />
          <h1>{loadingError ? "A little pause." : "Setting the scene…"}</h1>
          <p>{loadingError || "Your next good memory is almost ready."}</p>
          {loadingError && (
            <button className="kiosk-primary" onClick={() => void loadStudio()}>
              <RefreshCw size={17} />
              Try again
            </button>
          )}
        </section>
      ) : stage === "success" ? (
        <section className="kiosk-success">
          <div className="kiosk-success-icon">
            <CheckCheck size={36} strokeWidth={1.5} />
            <span>
              <Sparkles size={21} />
            </span>
          </div>
          <p className="kiosk-eyebrow">GOOD TIMES, DELIVERED</p>
          <h1>
            A little memory.
            <br />
            <em>All yours.</em>
          </h1>
          <p>
            Your three photos are on their way to
            <br />
            <strong>{sentAddress}</strong>
          </p>
          <div className="kiosk-success-strip">
            {photos.map((photo, index) => (
              <img
                key={index}
                src={photo}
                alt={`Your memory, photo ${index + 1}`}
              />
            ))}
          </div>
          <button className="kiosk-primary" type="button" onClick={reset}>
            Next happy people <ArrowRight size={19} />
          </button>
          <p className="kiosk-reset-note">
            Ready for the next guest in {resetIn} seconds
          </p>
        </section>
      ) : (
        <>
          <section className="kiosk-heading">
            <p className="kiosk-eyebrow">
              <Sparkles size={13} /> A MOMENT WORTH KEEPING
            </p>
            <h1>
              {reviewing ? (
                <>
                  Looking <em>good.</em>
                </>
              ) : isCapturing ? (
                <>
                  Your moment <em>is here.</em>
                </>
              ) : (
                <>
                  Make a little <em>memory.</em>
                </>
              )}
            </h1>
            <p>
              {reviewing
                ? "Three little moments. One very good memory."
                : isCapturing
                  ? countdown === 0
                    ? "Perfect. Hold that thought…"
                    : "Get comfortable, look into the camera, and be yourself."
                  : "Step into the frame. Be yourself. We’ll do the rest."}
            </p>
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
                  onCaptureReady={onCaptureReady}
                  onStatusChange={setCameraStatus}
                />
                {reviewing && photos[selectedPhoto] && (
                  <img
                    className="kiosk-review-main"
                    src={photos[selectedPhoto]}
                    alt={`Captured photo ${selectedPhoto + 1}`}
                  />
                )}
                {!reviewing && (
                  <>
                    <div className="kiosk-live-badge">
                      <span className={cameraStatus.ready ? "is-ready" : ""} />
                      {cameraStatus.ready ? "LIVE PREVIEW" : "CAMERA PREVIEW"}
                    </div>
                    <div className="kiosk-scene-label">
                      <ImageIcon size={14} />
                      {background?.name || "Your original scene"}
                    </div>
                    <div className="kiosk-frame-corner top-left" />
                    <div className="kiosk-frame-corner top-right" />
                    <div className="kiosk-frame-corner bottom-left" />
                    <div className="kiosk-frame-corner bottom-right" />
                  </>
                )}
                {isCapturing && (
                  <div
                    className="kiosk-countdown-overlay"
                    aria-live="assertive"
                  >
                    <span className="kiosk-countdown-label">
                      PHOTO {photoNumber} OF 3
                    </span>
                    <strong key={`${photoNumber}-${countdown}`}>
                      {countdown || <Camera size={63} strokeWidth={1.2} />}
                    </strong>
                    <span>
                      {countdown
                        ? photoNumber === 1
                          ? "Find your good side"
                          : "A fresh pose, a new memory"
                        : "Looking lovely"}
                    </span>
                  </div>
                )}
                {flash && <div className="kiosk-flash" />}
                {stage === "saving" && (
                  <div className="kiosk-saving-overlay">
                    <LoaderCircle size={28} className="still-camera-spinner" />
                    <span>Saving your memories…</span>
                  </div>
                )}
              </div>
              {!reviewing && (
                <div className="kiosk-camera-caption">
                  <span>
                    <span
                      className={`kiosk-small-dot ${cameraStatus.ready ? "" : "is-muted"}`}
                    />
                    {cameraStatus.ready
                      ? "You’re in the right place"
                      : cameraStatus.loading
                        ? "Getting everything ready"
                        : "Waiting for your camera"}
                  </span>
                  <span>
                    {studio.settings.camera.mode === "canon"
                      ? "Canon · USB tethered"
                      : "Browser camera"}
                    <span className="kiosk-caption-divider">/</span>3 photos,
                    all you
                  </span>
                </div>
              )}
              {reviewing && (
                <div className="kiosk-review-thumbnails">
                  {photos.map((photo, index) => (
                    <button
                      key={index}
                      type="button"
                      className={selectedPhoto === index ? "is-selected" : ""}
                      onClick={() => setSelectedPhoto(index)}
                      aria-label={`View photo ${index + 1}`}
                      aria-pressed={selectedPhoto === index}
                    >
                      <img src={photo} alt={`Photo ${index + 1}`} />
                      <span>
                        0{index + 1}
                        {selectedPhoto === index && <Check size={13} />}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {reviewing ? (
              <aside className="kiosk-email-card">
                <div className="kiosk-email-icon">
                  <Mail size={23} strokeWidth={1.4} />
                </div>
                <h2>Keep the good times.</h2>
                <p>
                  Leave your email and we’ll send all three photos straight to
                  your inbox.
                </p>
                <form onSubmit={sendPhotos}>
                  <label htmlFor="guest-email">Your email address</label>
                  <input
                    id="guest-email"
                    type="email"
                    name="email"
                    autoComplete="email"
                    inputMode="email"
                    placeholder="you@example.com"
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
                  {!studio.settings.gmail.configured && (
                    <p className="kiosk-email-unconfigured">
                      The host hasn’t connected email yet.{" "}
                      {session
                        ? "Your photos are saved, and you can download them below."
                        : "You can download your photos below while the host connects email."}
                    </p>
                  )}
                  {!session && stage === "review" ? (
                    <button
                      type="button"
                      className="kiosk-primary"
                      onClick={() => void savePhotos(photos)}
                    >
                      <RefreshCw size={16} />
                      Retry saving photos
                    </button>
                  ) : (
                    <button
                      className="kiosk-primary"
                      type="submit"
                      disabled={
                        stage !== "review" ||
                        !studio.settings.gmail.configured ||
                        !session
                      }
                    >
                      {stage === "sending" ? (
                        <>
                          <LoaderCircle
                            size={17}
                            className="still-camera-spinner"
                          />
                          Sending your photos…
                        </>
                      ) : stage === "saving" ? (
                        <>
                          <LoaderCircle
                            size={17}
                            className="still-camera-spinner"
                          />
                          Saving photos…
                        </>
                      ) : (
                        <>
                          Send my photos <ArrowRight size={17} />
                        </>
                      )}
                    </button>
                  )}
                </form>
                <p className="kiosk-privacy">
                  <Heart size={12} />
                  Just your photos. A little happiness for your inbox.
                </p>
                <div className="kiosk-review-actions">
                  <button
                    type="button"
                    onClick={reset}
                    disabled={stage === "sending" || stage === "saving"}
                  >
                    <RefreshCw size={14} />
                    Retake
                  </button>
                  <button type="button" onClick={downloadPhotos}>
                    <Download size={14} />
                    Download
                  </button>
                </div>
                <button
                  className="kiosk-done-link"
                  type="button"
                  onClick={reset}
                  disabled={stage === "sending" || stage === "saving"}
                >
                  Finish without email <ChevronRight size={14} />
                </button>
              </aside>
            ) : (
              <aside className="kiosk-photo-strip">
                <div className="kiosk-strip-top">
                  <Aperture size={19} strokeWidth={1.2} />
                  <span>THE GOOD STUFF</span>
                </div>
                {[0, 1, 2].map((index) => (
                  <div
                    className={`kiosk-strip-photo ${photos[index] ? "is-filled" : ""} ${isCapturing && photoNumber === index + 1 ? "is-next" : ""}`}
                    key={index}
                  >
                    {photos[index] ? (
                      <img
                        src={photos[index]}
                        alt={`Captured photo ${index + 1}`}
                      />
                    ) : (
                      <>
                        <span className="kiosk-strip-number">0{index + 1}</span>
                        <Camera size={21} strokeWidth={1.2} />
                        <span>
                          {index === 0
                            ? "A little smile"
                            : index === 1
                              ? "A new pose"
                              : "One for the memories"}
                        </span>
                      </>
                    )}
                  </div>
                ))}
                <div className="kiosk-strip-footer">
                  <span>made of good moments</span>
                  <Heart size={12} strokeWidth={1.4} />
                </div>
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
                        className="kiosk-cancel"
                        onClick={() => void loadStudio()}
                      >
                        <RefreshCw size={13} />
                        Try again
                      </button>
                    </>
                  ) : (
                    <span>Getting the booth ready for you…</span>
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
                <>
                  <div className="kiosk-progress">
                    {[1, 2, 3].map((number) => (
                      <span
                        key={number}
                        className={
                          photos.length >= number
                            ? "is-complete"
                            : photoNumber === number
                              ? "is-current"
                              : ""
                        }
                      >
                        {photos.length >= number ? <Check size={12} /> : number}
                      </span>
                    ))}
                  </div>
                  <button
                    className="kiosk-cancel"
                    type="button"
                    onClick={reset}
                  >
                    <X size={13} />
                    Cancel session
                  </button>
                </>
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
                    <Camera size={20} strokeWidth={1.6} />
                    Let’s make a memory
                    <ArrowRight size={18} />
                  </button>
                  <div className="kiosk-instructions">
                    <span>
                      <span>1</span>Strike a pose
                    </span>
                    <i />
                    <span>
                      <span>2</span>Three photos, just for you
                    </span>
                    <i />
                    <span>
                      <span>3</span>Straight to your inbox
                    </span>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}

      <footer className="kiosk-footer">
        <span>A little pause. A lot to remember.</span>
        <div>
          <span>
            POWERED BY <b>still.</b>
          </span>
          <Link href="/" aria-label="Back to studio">
            <Settings2 size={14} /> Studio <ArrowLeft size={12} />
          </Link>
        </div>
      </footer>
    </main>
  );
}
