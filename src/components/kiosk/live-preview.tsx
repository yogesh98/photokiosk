"use client";

/* Camera frames and local uploads must render directly without image proxying. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, RefreshCw, VideoOff } from "lucide-react";
import type { Background, KioskSettings } from "@/lib/kiosk-types";
import { createBackgroundCompositor } from "@/lib/background-compositor";
import { requestCanonPhoto, waitForPreview } from "./capture-camera";
import { createCanonLiveView } from "./canon-live-view";
import { captureCanonWithLiveView } from "./canon-capture";
import { abortableDelay, type CapturePhoto } from "./capture-sequence";

export interface PreviewStatus {
  ready: boolean;
  loading: boolean;
  error: string | null;
  label: string;
}

interface LivePreviewProps {
  settings: KioskSettings;
  background?: Background;
  enabled?: boolean;
  allowCanonPreview?: boolean;
  autoConnectCanon?: boolean;
  className?: string;
  onCaptureReady?: (capture: CapturePhoto | null, backgroundUrl?: string) => void;
  onStatusChange?: (status: PreviewStatus) => void;
}

function readableCameraError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return "Camera access is blocked. Allow camera access in your browser, then try again.";
    if (error.name === "NotFoundError")
      return "No camera was found. Connect a camera, or choose another in the studio.";
    if (error.name === "OverconstrainedError")
      return "The selected camera is unavailable. Choose a connected camera in the studio.";
    if (error.name === "NotReadableError")
      return "This camera is being used by another app. Close that app and try again.";
  }
  return error instanceof Error
    ? error.message
    : "The camera could not be started. Please try again.";
}

export function LivePreview({
  settings,
  background,
  enabled = true,
  allowCanonPreview = true,
  autoConnectCanon = false,
  className = "",
  onCaptureReady,
  onStatusChange,
}: LivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<CanvasImageSource | null>(null);
  const sourceSizeRef = useRef({ width: 0, height: 0 });
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const backgroundUrlRef = useRef<string | undefined>(undefined);
  const loadedBackgroundUrlRef = useRef<string | undefined | null>(null);
  const settingsRef = useRef(settings);
  const renderFlightRef = useRef<Promise<void> | null>(null);
  const sourceAbortRef = useRef<AbortController | null>(null);
  const previewFlightRef = useRef<Promise<void> | null>(null);
  const canonFrameRef = useRef<ImageBitmap | null>(null);
  const canonLiveRef = useRef<ReturnType<typeof createCanonLiveView> | null>(null);
  const canonMayResumeRef = useRef(false);
  const canonAutoPausedRef = useRef(false);
  const canonAutoConnectRef = useRef(false);
  const canonFrameVersionRef = useRef(0);
  const renderedCanonFrameRef = useRef(0);
  const capturingRef = useRef(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [readySourceKey, setReadySourceKey] = useState("");
  const [renderedBackgroundUrl, setRenderedBackgroundUrl] = useState<string | undefined | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [backgroundStatus, setBackgroundStatus] = useState<{
    url?: string;
    loaded: boolean;
    error: string | null;
  }>({ loaded: false, error: null });
  const [retry, setRetry] = useState(0);
  const [canonStarting, setCanonStarting] = useState(false);
  const [hasCanonFrame, setHasCanonFrame] = useState(false);
  const [processingFailed, setProcessingFailed] = useState(false);
  const [canonLiveActive, setCanonLiveActive] = useState(false);
  const [canonTakingPhoto, setCanonTakingPhoto] = useState(false);
  // The reason for an interruption that automatic recovery is retrying.
  const [canonReconnecting, setCanonReconnecting] = useState<string | null>(null);
  const backgroundUrl = settings.backgroundMode === "off" ? undefined : background?.url;
  const backgroundError =
    backgroundStatus.url === backgroundUrl ? backgroundStatus.error : null;
  const backgroundLoading = Boolean(
    backgroundUrl &&
    (backgroundStatus.url !== backgroundUrl ||
      (!backgroundStatus.loaded && !backgroundError)),
  );
  const sourceKey = JSON.stringify([
    enabled,
    settings.camera.mode,
    settings.camera.deviceId,
    settings.backgroundMode,
    retry,
  ]);
  const sourceReady = cameraReady && readySourceKey === sourceKey;
  const isCanon = settings.camera.mode === "canon";

  useEffect(() => {
    // allowCanonPreview only locks the guest-facing buttons. A guest's photo
    // session still recovers a dropped stream during its countdowns; the
    // shutter itself is protected by capturingRef.
    canonAutoConnectRef.current = autoConnectCanon && enabled && isCanon &&
      !processingFailed && !backgroundError;
  }, [autoConnectCanon, enabled, isCanon, processingFailed, backgroundError]);

  const beginCanonLiveView = useCallback((live: ReturnType<typeof createCanonLiveView>, signal?: AbortSignal) => {
    setCanonStarting(true);
    setCanonLiveActive(true);
    setCanonReconnecting(null);
    setCameraError(null);
    setCameraReady(false);
    const flight = live.start(signal);
    previewFlightRef.current = flight;
    void flight.finally(() => {
      if (previewFlightRef.current === flight) {
        previewFlightRef.current = null;
        setCanonStarting(false);
        setCanonLiveActive(false);
        setCanonReconnecting(null);
      }
    });
    return flight;
  }, []);

  function startCanonLiveView() {
    if (!enabled || !isCanon || !allowCanonPreview || !canonLiveRef.current ||
      capturingRef.current || previewFlightRef.current || document.visibilityState !== "visible") return;
    canonMayResumeRef.current = true;
    canonAutoPausedRef.current = false;
    beginCanonLiveView(canonLiveRef.current);
  }

  async function stopCanonLiveView() {
    canonAutoPausedRef.current = true;
    canonMayResumeRef.current = false;
    await canonLiveRef.current?.stop();
    sourceRef.current = null;
    canonFrameRef.current?.close();
    canonFrameRef.current = null;
    setHasCanonFrame(false);
    setCameraReady(false);
    setCanonLiveActive(false);
    setCanonReconnecting(null);
  }

  // The kiosk connects on startup and recovers while idle and during guest
  // countdowns. Admin previews keep their explicit start button, and photo
  // sequences own their shutter pauses.
  useEffect(() => {
    let current = true;
    canonMayResumeRef.current = false;
    canonAutoPausedRef.current = false;
    queueMicrotask(() => {
      if (current) {
        setHasCanonFrame(false);
        setCanonStarting(false);
        setCanonLiveActive(false);
        setCanonReconnecting(null);
      }
    });
    if (!enabled || !isCanon) return () => { current = false; };
    const mayAutoConnect = () => current && canonAutoConnectRef.current && !canonAutoPausedRef.current &&
      !capturingRef.current && document.visibilityState === "visible";
    const live = createCanonLiveView({
      reconnect: { allowed: mayAutoConnect },
      onFrame: async (blob, signal) => {
        const next = await createImageBitmap(blob);
        if (!current || signal.aborted) { next.close(); return; }
        const previous = canonFrameRef.current;
        canonFrameRef.current = next;
        canonFrameVersionRef.current++;
        sourceRef.current = next;
        sourceSizeRef.current = { width: next.width, height: next.height };
        previous?.close();
        setHasCanonFrame(true);
        setCanonStarting(false);
        setCanonReconnecting(null);
        setCameraError(null);
      },
      onError: (error, { retrying }) => {
        if (!current) return;
        canonMayResumeRef.current = mayAutoConnect();
        sourceRef.current = null;
        setCameraReady(false);
        setCanonStarting(false);
        if (retrying) {
          // A recoverable USB or server interruption is a loading state. As an
          // error it would end a guest's session before recovery could finish.
          setCanonReconnecting(readableCameraError(error));
        } else {
          setCanonReconnecting(null);
          setCameraError(readableCameraError(error));
        }
      },
    });
    canonLiveRef.current = live;
    const autoStart = () => {
      if (!mayAutoConnect()) return;
      canonMayResumeRef.current = true;
      beginCanonLiveView(live);
    };
    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        canonMayResumeRef.current = false;
        void live.stop();
      } else {
        // Await cleanup of a hidden tab's old USB session before reconnecting.
        void live.stop().then(() => { if (current) autoStart(); });
      }
    };
    const stopOnPageHide = () => {
      canonMayResumeRef.current = false;
      void live.stop();
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    window.addEventListener("pagehide", stopOnPageHide);
    return () => {
      current = false;
      canonMayResumeRef.current = false;
      document.removeEventListener("visibilitychange", stopWhenHidden);
      window.removeEventListener("pagehide", stopOnPageHide);
      void live.stop();
      if (canonLiveRef.current === live) {
        canonLiveRef.current = null;
        // A reopened preview owns a new transport. The old cleanup must not
        // block its automatic start or clear the new transport's UI state.
        previewFlightRef.current = null;
      }
      canonFrameRef.current?.close();
      canonFrameRef.current = null;
    };
  }, [enabled, isCanon, beginCanonLiveView]);

  useEffect(() => {
    let current = true;
    queueMicrotask(() => {
      const live = canonLiveRef.current;
      if (!current || !live || !canonAutoConnectRef.current || canonAutoPausedRef.current ||
        capturingRef.current || previewFlightRef.current || document.visibilityState !== "visible") return;
      canonMayResumeRef.current = true;
      beginCanonLiveView(live);
    });
    return () => { current = false; };
  }, [autoConnectCanon, enabled, isCanon, allowCanonPreview, processingFailed, backgroundError, beginCanonLiveView]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let current = true;
    backgroundUrlRef.current = backgroundUrl;
    loadedBackgroundUrlRef.current = backgroundUrl ? null : undefined;
    backgroundRef.current = null;
    queueMicrotask(() => {
      if (current) setBackgroundStatus({ url: backgroundUrl, loaded: false, error: null });
    });
    if (!backgroundUrl) return;
    const backdrop = new Image();
    backdrop.crossOrigin = "anonymous";
    backdrop.onload = () => {
      if (current) {
        backgroundRef.current = backdrop;
        loadedBackgroundUrlRef.current = backgroundUrl;
        setBackgroundStatus({ url: backgroundUrl, loaded: true, error: null });
      }
    };
    backdrop.onerror = () => {
      if (current) {
        setBackgroundStatus({
          url: backgroundUrl,
          loaded: false,
          error:
            "The selected background could not be loaded. Please choose another in the studio.",
        });
      }
    };
    backdrop.src = backgroundUrl;
    return () => {
      current = false;
    };
  }, [backgroundUrl, retry]);

  useEffect(() => {
    const controller = new AbortController();
    const video = videoRef.current;
    sourceAbortRef.current = controller;
    let stream: MediaStream | null = null;
    let animation = 0;
    let lastRenderTime = 0;
    let lastSource: CanvasImageSource | null = null;
    let lastSettingsKey = "";
    let lastBackground: HTMLImageElement | null = null;
    let renderFailed = false;
    const composite = createBackgroundCompositor();
    const retained = settings.camera.mode === "canon" ? canonFrameRef.current : null;
    sourceRef.current = retained;
    sourceSizeRef.current = retained ? { width: retained.width, height: retained.height } : { width: 0, height: 0 };
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        // Canon transport state belongs to the live-view effect. Resetting it
        // here ran after the kiosk's automatic start and hid "Starting…".
        setCameraReady(false);
        setCameraError(null);
        setProcessingFailed(false);
      }
    });
    if (!enabled) return () => controller.abort();

    const render = async (time = 0) => {
      if (controller.signal.aborted) return;
      const source = sourceRef.current;
      const frameVersion = canonFrameVersionRef.current;
      const { width, height } = sourceSizeRef.current;
      const currentSettings = settingsRef.current;
      // Unrelated parent updates must not re-render an unchanged Canon frame.
      const settingsKey = JSON.stringify([
        currentSettings.camera.mirror, currentSettings.backgroundMode, currentSettings.chroma,
      ]);
      const backdrop = backgroundRef.current;
      const sceneUrl = loadedBackgroundUrlRef.current;
      const sceneLoaded = sceneUrl !== null && sceneUrl === backgroundUrlRef.current;
      const changed =
        settings.camera.mode === "browser" ||
        source !== lastSource ||
        settingsKey !== lastSettingsKey ||
        backdrop !== lastBackground;
      if (
        !capturingRef.current && !renderFailed && sceneLoaded && changed && source && width && height &&
        canvasRef.current && time - lastRenderTime >= 1000 / 24
      ) {
        lastRenderTime = time;
        const flight = composite({
          source, sourceWidth: width, sourceHeight: height,
          output: canvasRef.current, width: 960, settings: currentSettings,
          background: backdrop, signal: controller.signal,
        });
        renderFlightRef.current = flight;
        try {
          await flight;
          if (controller.signal.aborted) return;
          lastSource = source;
          lastSettingsKey = settingsKey;
          lastBackground = backdrop;
          renderedCanonFrameRef.current = frameVersion;
          setCameraReady(true);
          setReadySourceKey(sourceKey);
          setRenderedBackgroundUrl(sceneUrl);
        } catch (error) {
          if (!controller.signal.aborted) {
            renderFailed = true;
            setCameraError(readableCameraError(error));
            setProcessingFailed(true);
            setCameraReady(false);
          }
        } finally {
          if (renderFlightRef.current === flight) renderFlightRef.current = null;
        }
      }
      if (!controller.signal.aborted)
        animation = requestAnimationFrame((nextTime) => void render(nextTime));
    };

    async function startBrowser() {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Camera access needs a secure connection. Open this kiosk on localhost or HTTPS.",
        );
      const deviceId = settings.camera.deviceId;
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId
            ? { deviceId: { exact: deviceId } }
            : { facingMode: "user" }),
          width: { ideal: 1920 },
          height: { ideal: 1280 },
        },
        audio: false,
      });
      if (controller.signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      if (controller.signal.aborted) return;
      sourceRef.current = video;
      sourceSizeRef.current = {
        width: video.videoWidth,
        height: video.videoHeight,
      };
      const track = stream.getVideoTracks()[0];
      track.addEventListener("ended", () => {
        if (!controller.signal.aborted) {
          sourceRef.current = null;
          setCameraReady(false);
          setCameraError(
            "The camera was disconnected. Reconnect it, then try again.",
          );
        }
      });
      void render();
    }

    if (settings.camera.mode === "canon") void render();
    else void startBrowser().catch((error) => {
      stream?.getTracks().forEach((track) => track.stop());
      if (!controller.signal.aborted) {
        setCameraError(readableCameraError(error));
        setProcessingFailed(true);
      }
    });

    return () => {
      controller.abort();
      cancelAnimationFrame(animation);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
      sourceRef.current = null;
    };
  }, [
    enabled,
    settings.camera.mode,
    settings.camera.deviceId,
    settings.backgroundMode,
    retry,
    sourceKey,
  ]);

  const capture = useCallback(
    async (guestSignal?: AbortSignal, options?: { resumePreview: boolean }) => {
      const currentSettings = settingsRef.current;
      const sourceSignal = sourceAbortRef.current?.signal;
      const signal = AbortSignal.any([
        ...(sourceSignal ? [sourceSignal] : []),
        ...(guestSignal ? [guestSignal] : []),
        // The shutter, download, and keying share one bounded operation.
        AbortSignal.timeout(100000),
      ]);
      signal.throwIfAborted();
      if (!sourceReady || backgroundLoading || backgroundError || renderedBackgroundUrl !== backgroundUrl)
        throw new Error(
          "Please wait until the camera and background are ready.",
        );
      if (capturingRef.current)
        throw new Error(
          "The camera is already taking a photo. Please wait a moment.",
        );
      capturingRef.current = true;
      const output = document.createElement("canvas");
      const composite = createBackgroundCompositor();
      const backdrop = backgroundRef.current;
      let photo: ImageBitmap | null = null;
      const takePhoto = async () => {
        try {
          await waitForPreview(renderFlightRef.current, signal);
          signal.throwIfAborted();
          if (currentSettings.camera.mode === "canon") {
            const bytes = await requestCanonPhoto(
              signal,
              previewFlightRef.current,
            );
            photo = await createImageBitmap(bytes);
            signal.throwIfAborted();
            await composite({
              source: photo, sourceWidth: photo.width, sourceHeight: photo.height,
              output, width: Math.min(2400, photo.width), settings: currentSettings,
              background: backdrop, signal,
            });
          } else {
            const source = sourceRef.current;
            const size = sourceSizeRef.current;
            const stream = videoRef.current?.srcObject as MediaStream | null;
            if (
              !source ||
              !size.width ||
              !size.height ||
              !stream
                ?.getVideoTracks()
                .some((track) => track.readyState === "live") ||
              (videoRef.current?.readyState ?? 0) < 2
            )
              throw new Error(
                "The camera is no longer available. Please reconnect and try again.",
              );
            await composite({
              source, sourceWidth: size.width, sourceHeight: size.height,
              output, width: Math.min(2400, size.width), settings: currentSettings,
              background: backdrop, signal,
            });
          }
          signal.throwIfAborted();
          return output.toDataURL("image/jpeg", 0.92);
        } finally {
          photo?.close();
          capturingRef.current = false;
        }
      };
      if (currentSettings.camera.mode !== "canon") return takePhoto();

      const live = canonLiveRef.current;
      const isCurrent = () => Boolean(
        live && canonLiveRef.current === live && canonMayResumeRef.current &&
        sourceAbortRef.current?.signal === sourceSignal &&
        document.visibilityState === "visible",
      );
      let minimumFrameVersion = 0;
      setCanonTakingPhoto(true);
      setCameraReady(false);
      try {
        if (!live) throw new Error("Start Canon live preview before taking a photo.");
        return await captureCanonWithLiveView({
          signal,
          hasNextPhoto: options?.resumePreview === true,
          isCurrent,
          stopLiveView: () => live.stop(),
          capture: takePhoto,
          startLiveView: () => {
            minimumFrameVersion = canonFrameVersionRef.current + 1;
            beginCanonLiveView(live, signal);
          },
          waitUntilReady: async (signal) => {
            // Readiness stays pending while automatic recovery reconnects, so
            // one deadline covers the whole resume rather than each attempt.
            let failed = false;
            let failure: unknown;
            void live.whenReady().catch((error) => { failed = true; failure = error; });
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
              signal.throwIfAborted();
              if (failed) throw failure;
              if (!isCurrent()) throw new DOMException("The photo session is no longer active.", "AbortError");
              if (renderedCanonFrameRef.current >= minimumFrameVersion) return;
              await abortableDelay(25, signal);
            }
            throw new Error("The Canon live preview could not resume. Start preview again to retry.");
          },
        });
      } finally {
        capturingRef.current = false;
        setCanonTakingPhoto(false);
      }
    },
    [sourceReady, backgroundLoading, backgroundError, renderedBackgroundUrl, backgroundUrl, beginCanonLiveView],
  );

  const error = cameraError || backgroundError;
  useEffect(() => {
    if (isCanon && error && (!autoConnectCanon || processingFailed || backgroundError)) {
      canonMayResumeRef.current = false;
      void canonLiveRef.current?.stop();
    }
  }, [isCanon, error, autoConnectCanon, processingFailed, backgroundError]);
  const ready = enabled && sourceReady && !backgroundLoading && !error && renderedBackgroundUrl === backgroundUrl &&
    (!isCanon || (canonLiveActive && !canonTakingPhoto));
  const waitingForCanonPreview = enabled && isCanon && !canonLiveActive && !canonStarting && !error &&
    !canonTakingPhoto;
  const loading = enabled && !error && !ready && !waitingForCanonPreview;
  const label =
    settings.camera.mode === "canon"
      ? "Canon live preview"
      : "Browser camera";

  useEffect(() => {
    onCaptureReady?.(ready ? capture : null, backgroundUrl);
    return () => onCaptureReady?.(null, backgroundUrl);
  }, [onCaptureReady, ready, capture, backgroundUrl]);
  useEffect(() => {
    onStatusChange?.({ ready, loading, error, label });
  }, [onStatusChange, ready, loading, error, label]);

  return (
    <div
      className={`still-live-preview ${className}`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 180,
        overflow: "hidden",
        background: "#e7e7de",
        isolation: "isolate",
      }}
    >
      {/* A hidden video is the camera source; guests see only the composited canvas. */}
      <video
        ref={videoRef}
        muted
        playsInline
        aria-hidden="true"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
      />
      {background && settings.backgroundMode !== "off" && (
        <img
          src={background.url}
          alt=""
          aria-hidden="true"
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: sourceReady ? 0 : 0.6,
          }}
        />
      )}
      <canvas
        ref={canvasRef}
        width={960}
        height={640}
        aria-label={isCanon ? "Canon live preview with your selected background" : "Live camera preview with your selected background"}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: sourceReady || (isCanon && hasCanonFrame) ? 1 : 0,
        }}
      />
      {(!enabled || error || (!canonTakingPhoto && (loading || waitingForCanonPreview))) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 28,
            background: "rgba(248,247,244,.35)",
            backdropFilter: "blur(3px)",
          }}
        >
          <div
            style={{
              textAlign: "center",
              maxWidth: 360,
              padding: "25px 28px",
              borderRadius: 18,
              background: "rgba(248,247,244,.95)",
              color: "#23251f",
              boxShadow: "0 8px 35px #23251f0c",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: 12,
              }}
            >
              {error ? (
                <VideoOff size={28} strokeWidth={1.4} />
              ) : loading ? (
                <LoaderCircle size={28} className="still-camera-spinner" />
              ) : (
                <Camera size={28} strokeWidth={1.4} />
              )}
            </div>
            <p style={{ fontSize: 16, fontWeight: 600, margin: "0 0 7px" }}>
              {error
                ? "Let’s get the preview ready"
                : waitingForCanonPreview
                  ? "Canon live preview is paused"
                : loading
                  ? isCanon && canonReconnecting
                    ? "Reconnecting the camera…"
                    : backgroundLoading && sourceReady
                    ? "Setting the scene…"
                    : "Connecting your camera…"
                  : "Preview is paused"}
            </p>
            {error && (
              <>
                <p
                  role="alert"
                  style={{
                    fontSize: 13,
                    lineHeight: 1.65,
                    margin: "0 0 15px",
                    color: "#66685e",
                  }}
                >
                  {error}
                </p>
                <button
                  type="button"
                  disabled={isCanon && (!allowCanonPreview || canonStarting)}
                  onClick={() => {
                    if (isCanon && !processingFailed) startCanonLiveView();
                    else setRetry((value) => value + 1);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    border: 0,
                    borderRadius: 8,
                    background: "#58684b",
                    color: "white",
                    padding: "10px 16px",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <RefreshCw size={14} /> {isCanon ? processingFailed ? "Restart preview processing" : "Start live preview again" : "Try again"}
                </button>
              </>
            )}
            {waitingForCanonPreview && (
              <>
                <p style={{ fontSize: 13, lineHeight: 1.65, color: "#66685e", margin: "0 0 15px" }}>
                  {autoConnectCanon
                    ? "Live preview is paused. Start it again to resume automatic connection. Keep the camera powered on and connected by USB."
                    : "Start a continuous live-view connection when you’re ready. The mirror may move once on entry; preview does not take still photos. It stops on error and waits for you to start it again."}
                </p>
                <button type="button" disabled={!allowCanonPreview} onClick={() => startCanonLiveView()} style={{ border: 0, borderRadius: 8, padding: "10px 16px", background: "#58684b", color: "white", cursor: "pointer" }}>
                  Start live preview
                </button>
              </>
            )}
            {loading && (
              <p style={{ fontSize: 13, color: "#66685e", margin: 0 }}>
                {settings.camera.mode === "canon"
                  ? canonReconnecting
                    ? `${canonReconnecting} Reconnecting automatically…`
                    : canonStarting ? "Starting Canon live view…" : "Processing your live preview…"
                  : "Your browser may ask for camera permission."}
              </p>
            )}
          </div>
        </div>
      )}
      {isCanon && enabled && canonLiveActive && (
        <button type="button" disabled={!allowCanonPreview} onClick={() => void stopCanonLiveView()} style={{ position: "absolute", bottom: 12, right: 12, zIndex: 2, border: "1px solid #d9dbd3", borderRadius: 8, padding: "9px 12px", background: "#f8f7f4", color: "#353a30", cursor: allowCanonPreview ? "pointer" : "default", opacity: allowCanonPreview ? 1 : 0.55 }}>
          <RefreshCw size={13} style={{ display: "inline", marginRight: 7 }} /> Stop live preview
        </button>
      )}
    </div>
  );
}
