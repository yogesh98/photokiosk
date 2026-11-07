"use client";

/* Camera frames and local uploads must render directly without image proxying. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, RefreshCw, VideoOff } from "lucide-react";
import type { Background, KioskSettings, Overlay } from "@/lib/kiosk-types";
import { compositorKind, createBackgroundCompositor } from "@/lib/background-compositor";
import { requestCanonPhoto, waitForPreview } from "./capture-camera";
import { createCanonLiveView } from "./canon-live-view";
import { captureCanonWithLiveView } from "./canon-capture";
import { abortableDelay, type CapturePhoto } from "./capture-sequence";

export interface PreviewStatus {
  ready: boolean;
  loading: boolean;
  error: string | null;
  label: string;
  /** Composited frames per second over the last second, once the preview is running. */
  fps: number;
  /** Whether frames are keyed on the GPU (webgl) or the CPU (canvas2d). */
  renderer: "webgl" | "canvas2d" | null;
}

/** Final photos are composited at this width; the Canon's 6720 px stills are decoded straight to it. */
const CAPTURE_WIDTH = 2400;
/** A live-view frame is 960 x 640; it is saved at 1.5x so it does not look tiny on a phone. */
const LIVE_CAPTURE_WIDTH = 1440;

interface LivePreviewProps {
  settings: KioskSettings;
  background?: Background;
  overlay?: Overlay;
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

interface SceneLayer {
  image: HTMLImageElement | null;
  url: string | undefined;
  /** null while loading; undefined when there is nothing to draw. */
  loadedUrl: string | undefined | null;
}

const layerReady = (layer: SceneLayer) =>
  layer.loadedUrl !== null && layer.loadedUrl === layer.url;

/** Load one image layer so rendering and capture can wait for exactly this URL. */
function useSceneImage(url: string | undefined, retry: number, failure: string) {
  const layerRef = useRef<SceneLayer>({ image: null, url: undefined, loadedUrl: null });
  const [status, setStatus] = useState<{
    url?: string;
    loaded: boolean;
    error: string | null;
  }>({ loaded: false, error: null });
  useEffect(() => {
    let current = true;
    layerRef.current = { image: null, url, loadedUrl: url ? null : undefined };
    queueMicrotask(() => {
      if (current) setStatus({ url, loaded: false, error: null });
    });
    if (!url) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (current) {
        layerRef.current = { image, url, loadedUrl: url };
        setStatus({ url, loaded: true, error: null });
      }
    };
    image.onerror = () => {
      if (current) setStatus({ url, loaded: false, error: failure });
    };
    image.src = url;
    return () => {
      current = false;
    };
  }, [url, retry, failure]);
  const error = status.url === url ? status.error : null;
  const loading = Boolean(url && (status.url !== url || (!status.loaded && !error)));
  return { layerRef, error, loading };
}

export function LivePreview({
  settings,
  background,
  overlay,
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
  const settingsRef = useRef(settings);
  const renderFlightRef = useRef<Promise<void> | null>(null);
  const sourceAbortRef = useRef<AbortController | null>(null);
  const previewFlightRef = useRef<Promise<void> | null>(null);
  const canonFrameRef = useRef<ImageBitmap | null>(null);
  // A frame being saved as a photo; new frames must not close it underneath the compositor.
  const heldFrameRef = useRef<ImageBitmap | null>(null);
  const canonLiveRef = useRef<ReturnType<typeof createCanonLiveView> | null>(null);
  const canonMayResumeRef = useRef(false);
  const canonAutoPausedRef = useRef(false);
  const canonAutoConnectRef = useRef(false);
  const canonFrameVersionRef = useRef(0);
  const renderedCanonFrameRef = useRef(0);
  const capturingRef = useRef(false);
  // One scratch canvas and compositor for every still, so each photo does not
  // create (and later leak) a fresh GPU context.
  const captureCanvasRef = useRef<{ canvas: HTMLCanvasElement; composite: ReturnType<typeof createBackgroundCompositor> } | null>(null);
  const frameStampsRef = useRef<number[]>([]);
  const [fps, setFps] = useState(0);
  const [renderer, setRenderer] = useState<"webgl" | "canvas2d" | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  // Mirrors cameraReady for the render loop, which republishes readiness only
  // after something (a shutter, a restart, an error) has taken it away.
  const cameraReadyRef = useRef(false);
  const markNotReady = useCallback(() => {
    cameraReadyRef.current = false;
    setCameraReady(false);
  }, []);
  const [readySourceKey, setReadySourceKey] = useState("");
  const [renderedBackgroundUrl, setRenderedBackgroundUrl] = useState<string | undefined | null>(null);
  const [renderedOverlayUrl, setRenderedOverlayUrl] = useState<string | undefined | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [canonStarting, setCanonStarting] = useState(false);
  const [hasCanonFrame, setHasCanonFrame] = useState(false);
  const [processingFailed, setProcessingFailed] = useState(false);
  const [canonLiveActive, setCanonLiveActive] = useState(false);
  const [canonTakingPhoto, setCanonTakingPhoto] = useState(false);
  // The reason for an interruption that automatic recovery is retrying.
  const [canonReconnecting, setCanonReconnecting] = useState<string | null>(null);
  const backgroundUrl = settings.backgroundMode === "off" ? undefined : background?.url;
  // Overlays apply whether or not the background is replaced.
  const overlayUrl = overlay?.url;
  const {
    layerRef: backgroundLayer,
    error: backgroundError,
    loading: backgroundLoading,
  } = useSceneImage(
    backgroundUrl,
    retry,
    "The selected background could not be loaded. Please choose another in the studio.",
  );
  const {
    layerRef: overlayLayer,
    error: overlayError,
    loading: overlayLoading,
  } = useSceneImage(
    overlayUrl,
    retry,
    "The selected overlay could not be loaded. Please choose another in the studio.",
  );
  const sceneError = backgroundError || overlayError;
  const sceneLoading = backgroundLoading || overlayLoading;
  const sceneRendered = renderedBackgroundUrl === backgroundUrl && renderedOverlayUrl === overlayUrl;
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
      !processingFailed && !sceneError;
  }, [autoConnectCanon, enabled, isCanon, processingFailed, sceneError]);

  const beginCanonLiveView = useCallback((live: ReturnType<typeof createCanonLiveView>, signal?: AbortSignal) => {
    setCanonStarting(true);
    setCanonLiveActive(true);
    setCanonReconnecting(null);
    setCameraError(null);
    markNotReady();
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
  }, [markNotReady]);

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
    markNotReady();
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
        // Camera JPEGs have no alpha and are already sRGB; skipping those passes keeps decode cheap.
        const next = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        if (!current || signal.aborted) { next.close(); return; }
        const previous = canonFrameRef.current;
        canonFrameRef.current = next;
        canonFrameVersionRef.current++;
        sourceRef.current = next;
        sourceSizeRef.current = { width: next.width, height: next.height };
        // At 30 fps, React state only changes on the first frame after a (re)start.
        if (!previous) {
          setHasCanonFrame(true);
          setCanonStarting(false);
          setCanonReconnecting(null);
          setCameraError(null);
        }
        if (previous && previous !== heldFrameRef.current) previous.close();
      },
      onError: (error, { retrying }) => {
        if (!current) return;
        canonMayResumeRef.current = mayAutoConnect();
        sourceRef.current = null;
        markNotReady();
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
  }, [enabled, isCanon, beginCanonLiveView, markNotReady]);

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
  }, [autoConnectCanon, enabled, isCanon, allowCanonPreview, processingFailed, sceneError, beginCanonLiveView]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

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
    let lastOverlay: HTMLImageElement | null = null;
    let renderFailed = false;
    // Scene and readiness state are published once per source/scene, not per frame.
    let published = false;
    const composite = createBackgroundCompositor();
    frameStampsRef.current = [];
    const fpsTimer = setInterval(() => {
      if (controller.signal.aborted) return;
      const stamps = frameStampsRef.current;
      const now = performance.now();
      while (stamps.length && now - stamps[0] > 1000) stamps.shift();
      setFps(stamps.length);
    }, 1000);
    const retained = settings.camera.mode === "canon" ? canonFrameRef.current : null;
    sourceRef.current = retained;
    sourceSizeRef.current = retained ? { width: retained.width, height: retained.height } : { width: 0, height: 0 };
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        // Canon transport state belongs to the live-view effect. Resetting it
        // here ran after the kiosk's automatic start and hid "Starting…".
        markNotReady();
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
      const scene = backgroundLayer.current;
      const topLayer = overlayLayer.current;
      const backdrop = scene.image;
      const overlayImage = topLayer.image;
      const sceneLoaded = layerReady(scene) && layerReady(topLayer);
      const changed =
        settings.camera.mode === "browser" ||
        source !== lastSource ||
        settingsKey !== lastSettingsKey ||
        backdrop !== lastBackground ||
        overlayImage !== lastOverlay;
      if (settingsKey !== lastSettingsKey || backdrop !== lastBackground || overlayImage !== lastOverlay) published = false;
      // A webcam is sampled at up to 24 fps; Canon frames are drawn as they arrive (30 fps).
      const due = settings.camera.mode !== "browser" || time - lastRenderTime >= 1000 / 24;
      if (
        !capturingRef.current && !renderFailed && sceneLoaded && changed && source && width && height &&
        canvasRef.current && due
      ) {
        lastRenderTime = time;
        const flight = composite({
          source, sourceWidth: width, sourceHeight: height,
          output: canvasRef.current, width: 960, settings: currentSettings,
          background: backdrop, overlay: overlayImage, signal: controller.signal,
        });
        renderFlightRef.current = flight;
        try {
          await flight;
          if (controller.signal.aborted) return;
          lastSource = source;
          lastSettingsKey = settingsKey;
          lastBackground = backdrop;
          lastOverlay = overlayImage;
          renderedCanonFrameRef.current = frameVersion;
          const stamps = frameStampsRef.current;
          stamps.push(time);
          while (stamps.length && time - stamps[0] > 1000) stamps.shift();
          if (!published || !cameraReadyRef.current) {
            published = true;
            cameraReadyRef.current = true;
            setCameraReady(true);
            setReadySourceKey(sourceKey);
            setRenderedBackgroundUrl(scene.loadedUrl);
            setRenderedOverlayUrl(topLayer.loadedUrl);
            setRenderer(compositorKind(canvasRef.current));
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            renderFailed = true;
            setCameraError(readableCameraError(error));
            setProcessingFailed(true);
            markNotReady();
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
          markNotReady();
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
      clearInterval(fpsTimer);
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
    backgroundLayer,
    overlayLayer,
    markNotReady,
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
      if (!sourceReady || sceneLoading || sceneError || !sceneRendered)
        throw new Error(
          "Please wait until the camera and background are ready.",
        );
      if (capturingRef.current)
        throw new Error(
          "The camera is already taking a photo. Please wait a moment.",
        );
      capturingRef.current = true;
      captureCanvasRef.current ??= { canvas: document.createElement("canvas"), composite: createBackgroundCompositor() };
      const { canvas: output, composite } = captureCanvasRef.current;
      const backdrop = backgroundLayer.current.image;
      const overlayImage = overlayLayer.current.image;
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
            // Decode the 30-megapixel still straight to the photo's size instead
            // of holding a 120 MB bitmap and shrinking it afterwards.
            photo = await createImageBitmap(bytes, { resizeWidth: CAPTURE_WIDTH, resizeQuality: "high" });
            signal.throwIfAborted();
            await composite({
              source: photo, sourceWidth: photo.width, sourceHeight: photo.height,
              output, width: Math.min(CAPTURE_WIDTH, photo.width), settings: currentSettings,
              background: backdrop, overlay: overlayImage, signal,
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
              output, width: Math.min(CAPTURE_WIDTH, size.width), settings: currentSettings,
              background: backdrop, overlay: overlayImage, signal,
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

      if (currentSettings.camera.captureMode !== "still") {
        // The photo is the frame the guest is looking at. Live view keeps
        // running, so nothing is stopped, refocused, or restarted.
        const frame = canonFrameRef.current;
        if (!frame) {
          capturingRef.current = false;
          throw new Error("The camera preview has no frame yet. Please try again.");
        }
        heldFrameRef.current = frame;
        try {
          signal.throwIfAborted();
          await composite({
            source: frame, sourceWidth: frame.width, sourceHeight: frame.height,
            output, width: LIVE_CAPTURE_WIDTH, settings: currentSettings,
            background: backdrop, overlay: overlayImage, signal,
          });
          signal.throwIfAborted();
          return output.toDataURL("image/jpeg", 0.92);
        } finally {
          heldFrameRef.current = null;
          if (canonFrameRef.current !== frame) frame.close();
          capturingRef.current = false;
        }
      }

      const live = canonLiveRef.current;
      const isCurrent = () => Boolean(
        live && canonLiveRef.current === live && canonMayResumeRef.current &&
        sourceAbortRef.current?.signal === sourceSignal &&
        document.visibilityState === "visible",
      );
      let minimumFrameVersion = 0;
      setCanonTakingPhoto(true);
      markNotReady();
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
    [sourceReady, sceneLoading, sceneError, sceneRendered, backgroundLayer, overlayLayer, beginCanonLiveView, markNotReady],
  );

  const error = cameraError || sceneError;
  useEffect(() => {
    if (isCanon && error && (!autoConnectCanon || processingFailed || sceneError)) {
      canonMayResumeRef.current = false;
      void canonLiveRef.current?.stop();
    }
  }, [isCanon, error, autoConnectCanon, processingFailed, sceneError]);
  const ready = enabled && sourceReady && !sceneLoading && !error && sceneRendered &&
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
    onStatusChange?.({ ready, loading, error, label, fps: ready ? fps : 0, renderer });
  }, [onStatusChange, ready, loading, error, label, fps, renderer]);

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
                    : sceneLoading && sourceReady
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
                    // A background or overlay that failed to load needs reloading, not a new camera session.
                    if (isCanon && !processingFailed && !sceneError) startCanonLiveView();
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
                  <RefreshCw size={14} /> {isCanon && !sceneError ? processingFailed ? "Restart preview processing" : "Start live preview again" : "Try again"}
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
