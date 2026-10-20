"use client";

/* Camera frames and local uploads must render directly without image proxying. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, RefreshCw, VideoOff } from "lucide-react";
import type { Background, KioskSettings } from "@/lib/kiosk-types";
import { createBackgroundCompositor } from "@/lib/background-compositor";
import { createPersonSegmenter, type PersonSegmenter } from "@/lib/person-segmentation";
import type { AiRuntimeInfo } from "@/lib/ai-models";
import { createPreviewPerformanceTracker, type PreviewPerformance } from "@/lib/preview-performance";
import { requestCanonPhoto, waitForPreview } from "./capture-camera";
import type { CapturePhoto } from "./capture-sequence";

export type { PreviewPerformance } from "@/lib/preview-performance";

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
  className?: string;
  onCaptureReady?: (capture: CapturePhoto | null, backgroundUrl?: string) => void;
  onStatusChange?: (status: PreviewStatus) => void;
  onPerformanceChange?: (performance: PreviewPerformance | null) => void;
  onRuntimeChange?: (runtime: AiRuntimeInfo | null) => void;
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

async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(body?.error || fallback);
}

export function LivePreview({
  settings,
  background,
  enabled = true,
  className = "",
  onCaptureReady,
  onStatusChange,
  onPerformanceChange,
  onRuntimeChange,
}: LivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<CanvasImageSource | null>(null);
  const sourceSizeRef = useRef({ width: 0, height: 0 });
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const backgroundUrlRef = useRef<string | undefined>(undefined);
  const loadedBackgroundUrlRef = useRef<string | undefined | null>(null);
  const settingsRef = useRef(settings);
  const segmenterRef = useRef<PersonSegmenter | null>(null);
  const renderFlightRef = useRef<Promise<void> | null>(null);
  const sourceAbortRef = useRef<AbortController | null>(null);
  const previewFlightRef = useRef<Promise<void> | null>(null);
  const capturingRef = useRef(false);
  const performanceCallbackRef = useRef(onPerformanceChange);
  const runtimeCallbackRef = useRef(onRuntimeChange);
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
    settings.aiModel,
    settings.aiAcceleration,
    retry,
  ]);
  const sourceReady = cameraReady && readySourceKey === sourceKey;

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    performanceCallbackRef.current = onPerformanceChange;
  }, [onPerformanceChange]);
  useEffect(() => {
    runtimeCallbackRef.current = onRuntimeChange;
  }, [onRuntimeChange]);

  useEffect(() => {
    let current = true;
    backgroundUrlRef.current = backgroundUrl;
    loadedBackgroundUrlRef.current = backgroundUrl ? null : undefined;
    backgroundRef.current = null;
    queueMicrotask(() => {
      if (current) {
        setBackgroundStatus({ url: backgroundUrl, loaded: false, error: null });
        performanceCallbackRef.current?.(null);
      }
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
    let frame: ImageBitmap | null = null;
    let animation = 0;
    let lastRenderTime = 0;
    let lastSource: CanvasImageSource | null = null;
    let lastSettingsKey = "";
    let lastBackground: HTMLImageElement | null = null;
    let renderFailed = false;
    let segmenter: PersonSegmenter | null = null;
    const composite = createBackgroundCompositor();
    let runtimeKey = "";
    let recordPerformance = createPreviewPerformanceTracker(settings.aiModel, settings.aiAcceleration);
    let lastPerformanceReport = 0;
    const clearPerformance = (stopRuntime = false) => {
      recordPerformance = createPreviewPerformanceTracker(settings.aiModel, settings.aiAcceleration, segmenter?.runtime);
      lastPerformanceReport = 0;
      performanceCallbackRef.current?.(null);
      if (stopRuntime) {
        runtimeKey = "";
        runtimeCallbackRef.current?.(null);
      }
    };
    const reportRuntime = () => {
      if (controller.signal.aborted || !segmenter) return;
      const nextKey = JSON.stringify(segmenter.runtime);
      if (nextKey === runtimeKey) return;
      runtimeKey = nextKey;
      clearPerformance();
      runtimeCallbackRef.current?.(segmenter.runtime);
    };
    let pollingTimeout: ReturnType<typeof setTimeout> | undefined;
    sourceRef.current = null;
    sourceSizeRef.current = { width: 0, height: 0 };
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setCameraReady(false);
        setCameraError(null);
        performanceCallbackRef.current?.(null);
        runtimeCallbackRef.current?.(null);
      }
    });
    if (!enabled) return () => controller.abort();

    const render = async (time = 0) => {
      if (controller.signal.aborted) return;
      const source = sourceRef.current;
      const { width, height } = sourceSizeRef.current;
      const currentSettings = settingsRef.current;
      // Parent benchmark updates must not trigger another Canon inference.
      const settingsKey = JSON.stringify([
        currentSettings.camera.mirror, currentSettings.backgroundMode,
        currentSettings.aiModel, currentSettings.aiAcceleration, currentSettings.chroma,
      ]);
      const backdrop = backgroundRef.current;
      const sceneUrl = loadedBackgroundUrlRef.current;
      const sceneLoaded = sceneUrl !== null && sceneUrl === backgroundUrlRef.current;
      const changed =
        settings.camera.mode === "browser" ||
        source !== lastSource ||
        settingsKey !== lastSettingsKey ||
        backdrop !== lastBackground;
      const fps = currentSettings.backgroundMode === "ai" ? 12 : 24;
      if (
        !capturingRef.current && !renderFailed && sceneLoaded && changed && source && width && height &&
        canvasRef.current && time - lastRenderTime >= 1000 / fps
      ) {
        lastRenderTime = time;
        if (backdrop !== lastBackground) clearPerformance();
        const processingStart = performance.now();
        const flight = composite({
          source, sourceWidth: width, sourceHeight: height,
          output: canvasRef.current, width: 960, settings: currentSettings,
          background: backdrop, segmenter, signal: controller.signal,
        });
        renderFlightRef.current = flight;
        try {
          await flight;
          if (controller.signal.aborted) return;
          lastSource = source;
          lastSettingsKey = settingsKey;
          lastBackground = backdrop;
          setCameraReady(true);
          setReadySourceKey(sourceKey);
          setRenderedBackgroundUrl(sceneUrl);
          reportRuntime();
          if (settings.backgroundMode === "ai" && performanceCallbackRef.current) {
            const completedAt = performance.now();
            const measurement = recordPerformance(completedAt - processingStart, completedAt);
            if (measurement && completedAt - lastPerformanceReport >= 1000) {
              lastPerformanceReport = completedAt;
              performanceCallbackRef.current(measurement);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            renderFailed = true;
            setCameraError(readableCameraError(error));
            setCameraReady(false);
            clearPerformance(true);
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
          clearPerformance(true);
          setCameraError(
            "The camera was disconnected. Reconnect it, then try again.",
          );
        }
      });
      void render();
    }

    async function pollCanon() {
      if (controller.signal.aborted) return;
      if (!capturingRef.current) {
        const flight = (async () => {
          const response = await fetch(`/api/camera/preview?t=${Date.now()}`, {
            cache: "no-store",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(20000),
            ]),
          });
          if (!response.ok)
            throw await responseError(
              response,
              "Canon live view is unavailable. Check the USB connection and camera power.",
            );
          const nextFrame = await createImageBitmap(await response.blob());
          if (controller.signal.aborted) {
            nextFrame.close();
            return;
          }
          const previousFrame = frame;
          frame = nextFrame;
          sourceRef.current = frame;
          sourceSizeRef.current = { width: frame.width, height: frame.height };
          previousFrame?.close();
          if (!renderFailed) setCameraError(null);
        })();
        previewFlightRef.current = flight;
        try {
          await flight;
        } catch (error) {
          if (!controller.signal.aborted) {
            sourceRef.current = null;
            setCameraReady(false);
            setCameraError(readableCameraError(error));
            clearPerformance(true);
          }
        } finally {
          if (previewFlightRef.current === flight)
            previewFlightRef.current = null;
        }
      }
      if (!controller.signal.aborted)
        pollingTimeout = setTimeout(pollCanon, 1000);
    }

    async function start() {
      if (settings.backgroundMode === "ai") {
        segmenter = await createPersonSegmenter(settings.aiModel, controller.signal, settings.aiAcceleration);
        if (controller.signal.aborted) {
          segmenter.close();
          return;
        }
        segmenterRef.current = segmenter;
        reportRuntime();
      }
      if (settings.camera.mode === "canon") {
        void render();
        void pollCanon();
      } else await startBrowser();
    }
    void start().catch((error) => {
      stream?.getTracks().forEach((track) => track.stop());
      if (!controller.signal.aborted) {
        setCameraError(readableCameraError(error));
        clearPerformance(true);
      }
    });

    return () => {
      controller.abort();
      cancelAnimationFrame(animation);
      clearTimeout(pollingTimeout);
      segmenter?.close();
      if (segmenterRef.current === segmenter) segmenterRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
      sourceRef.current = null;
      frame?.close();
    };
  }, [
    enabled,
    settings.camera.mode,
    settings.camera.deviceId,
    settings.backgroundMode,
    settings.aiModel,
    settings.aiAcceleration,
    retry,
    sourceKey,
  ]);

  const capture = useCallback(
    async (guestSignal?: AbortSignal) => {
      const sourceSignal = sourceAbortRef.current?.signal;
      const signal = AbortSignal.any([
        ...(sourceSignal ? [sourceSignal] : []),
        ...(guestSignal ? [guestSignal] : []),
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
      const currentSettings = settingsRef.current;
      const backdrop = backgroundRef.current;
      const segmenter = segmenterRef.current;
      let photo: ImageBitmap | null = null;
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
            background: backdrop, segmenter, signal,
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
            background: backdrop, segmenter, signal,
          });
        }
        signal.throwIfAborted();
        if (segmenter) runtimeCallbackRef.current?.(segmenter.runtime);
        return output.toDataURL("image/jpeg", 0.92);
      } finally {
        photo?.close();
        capturingRef.current = false;
      }
    },
    [sourceReady, backgroundLoading, backgroundError, renderedBackgroundUrl, backgroundUrl],
  );

  const error = cameraError || backgroundError;
  const ready = enabled && sourceReady && !backgroundLoading && !error && renderedBackgroundUrl === backgroundUrl;
  const loading = enabled && !error && !ready;
  const label =
    settings.camera.mode === "canon"
      ? "Canon tethered camera"
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
        aria-label="Live camera preview with your selected background"
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: sourceReady ? 1 : 0,
        }}
      />
      {(!enabled || loading || error) && (
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
                : loading
                  ? backgroundLoading && sourceReady
                    ? "Setting the scene…"
                    : settings.backgroundMode === "ai"
                      ? "Preparing AI and camera…"
                      : "Connecting your camera…"
                  : "Live preview is paused"}
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
                  onClick={() => setRetry((value) => value + 1)}
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
                  <RefreshCw size={14} /> Try again
                </button>
              </>
            )}
            {loading && (
              <p style={{ fontSize: 13, color: "#66685e", margin: 0 }}>
                {settings.camera.mode === "canon"
                  ? "Keep your camera switched on and connected by USB."
                  : "Your browser may ask for camera permission."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
