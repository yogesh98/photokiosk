"use client";
/* Local uploads and object URLs must render directly without image proxying. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Layers, Loader2, Plus, Trash2, TriangleAlert, Upload } from "lucide-react";
import type { Background, KioskSettings, Overlay } from "@/lib/kiosk-types";
import { api, Modal } from "./studio-shared";

/** Photos are always 3:2, so overlays are stretched to fill that frame. */
const PHOTO_RATIO = 3 / 2;

/** How an overlay sits on a photo: the scene below, the overlay stretched over it. */
function OverlayStack({ background, overlay, alt }: { background?: Background; overlay?: { url: string }; alt: string }) {
  return (
    <span className="overlay-stack" role="img" aria-label={alt}>
      {background ? <img src={background.url} alt="" /> : <span className="overlay-checker" />}
      {overlay && <img className="overlay-layer" src={overlay.url} alt="" />}
    </span>
  );
}

export function OverlayLibrary({
  settings,
  overlays,
  background,
  busy,
  onSelect,
  onDelete,
  onUpload,
}: {
  settings: KioskSettings;
  overlays: Overlay[];
  background?: Background;
  busy: boolean;
  onSelect: (id: string) => void;
  onDelete: (overlay: Overlay) => void;
  onUpload: () => void;
}) {
  const active = settings.activeOverlayId;
  return (
    <div className="backgrounds-grid overlays-grid">
      <div className={`background-card ${active === "" ? "active" : ""}`}>
        <button
          className="background-image overlay-image"
          onClick={() => onSelect("")}
          disabled={busy}
          aria-pressed={active === ""}
        >
          <OverlayStack background={background} alt="Photos without an overlay" />
          {active === "" && (
            <span className="active-background-badge">
              <Check size={13} />
              Active
            </span>
          )}
        </button>
        <div className="background-card-bottom">
          <div>
            <strong>No overlay</strong>
            <small>Just the photo</small>
          </div>
          <button
            className={`select-background ${active === "" ? "selected" : ""}`}
            disabled={busy}
            onClick={() => onSelect("")}
            aria-label="Use no overlay"
          >
            {active === "" ? <Check size={15} /> : <Plus size={15} />}
          </button>
        </div>
      </div>
      {overlays.map((overlay) => (
        <div className={`background-card ${active === overlay.id ? "active" : ""}`} key={overlay.id}>
          <button
            className="background-image overlay-image"
            onClick={() => onSelect(overlay.id)}
            disabled={busy}
            aria-pressed={active === overlay.id}
          >
            <OverlayStack background={background} overlay={overlay} alt={`${overlay.name} over a sample photo`} />
            {active === overlay.id && (
              <span className="active-background-badge">
                <Check size={13} />
                Active overlay
              </span>
            )}
          </button>
          <div className="background-card-bottom">
            <div>
              <strong>{overlay.name}</strong>
              <small>On every photo</small>
            </div>
            <button
              disabled={busy}
              className="icon-button"
              onClick={() => onDelete(overlay)}
              aria-label={`Delete ${overlay.name}`}
              title={active === overlay.id ? "Delete and turn off the overlay" : "Delete overlay"}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      ))}
      <button className="upload-background-card" onClick={onUpload}>
        <span>
          <Layers size={27} strokeWidth={1.4} />
        </span>
        <strong>Add the finishing touch.</strong>
        <p>Upload a transparent frame or logo</p>
        <small>PNG or WebP · 3:2 · up to 10 MB</small>
      </button>
    </div>
  );
}

export function OverlayUploadModal({
  background,
  onClose,
  onSuccess,
}: {
  background?: Background;
  onClose: () => void;
  onSuccess: (overlay: Overlay) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState("");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);
  const ratioOff = size !== null && Math.abs(size.width / size.height - PHOTO_RATIO) > 0.03;
  function choose(f?: File) {
    if (!f) return;
    if (!["image/png", "image/webp"].includes(f.type)) {
      setError("Overlays need a transparent background, so choose a PNG or WebP image.");
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setError("Choose an image smaller than 10 MB.");
      return;
    }
    setFile(f);
    setSize(null);
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
      const { overlay } = await api<{ overlay: Overlay }>("/api/overlays", { method: "POST", body: form });
      await onSuccess(overlay);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add the finishing touch." onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <input
          type="file"
          ref={input}
          hidden
          accept="image/png,image/webp"
          onChange={(e) => choose(e.target.files?.[0])}
        />
        <button
          className={`upload-dropzone ${preview ? "has-overlay" : ""}`}
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            choose(e.dataTransfer.files[0]);
          }}
        >
          {preview ? (
            <>
              <OverlayStack background={background} overlay={{ url: preview }} alt="Overlay to upload over a sample photo" />
              {/* Measure the real pixels to warn about a frame that will be stretched. */}
              <img
                src={preview}
                alt=""
                hidden
                onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              />
            </>
          ) : (
            <>
              <span>
                <Upload size={27} />
              </span>
              <strong>Drop a frame or logo here</strong>
              <p>or click to choose an image</p>
              <small>PNG or WebP with transparency · up to 10 MB</small>
            </>
          )}
        </button>
        {ratioOff && size && (
          <div className="overlay-ratio-warning" role="status">
            <TriangleAlert size={15} />
            <span>
              This image is {size.width} × {size.height}. Overlays stretch to fill each 3:2 photo, so it may look
              squashed. For a perfect fit, export it at 3000 × 2000 pixels.
            </span>
          </div>
        )}
        <label className="field">
          Give your overlay a name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Party frame"
          />
        </label>
        <p className="field-hint">
          The transparent areas show the photo underneath. The overlay is drawn over all three photos, with or without
          the green screen.
        </p>
        {error && <div className="inline-error">{error}</div>}
        <button type="submit" className="button dark" disabled={!file || busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          Add to your overlays
        </button>
      </form>
    </Modal>
  );
}
