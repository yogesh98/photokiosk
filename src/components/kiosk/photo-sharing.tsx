"use client";
/* QR codes are generated locally as data URLs. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import { ArrowUpRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { PhotoSession } from "@/lib/kiosk-types";

export function PhotoSharing({ sharing, busy, error, onRetry }: {
  sharing?: PhotoSession["sharing"];
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const galleryUrl = sharing?.status === "uploaded" ? sharing.galleryUrl : undefined;
  const [qr, setQr] = useState<{ url: string; image: string } | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  useEffect(() => {
    if (!galleryUrl) return;
    let current = true;
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(galleryUrl, { width: 320, margin: 4, errorCorrectionLevel: "M" }))
      .then((image) => {
        if (current) {
          setQr({ url: galleryUrl, image });
          setQrError(null);
        }
      })
      .catch(() => {
        if (current) setQrError("The QR code could not be displayed. Open the gallery link below.");
      });
    return () => { current = false; };
  }, [galleryUrl]);

  if (galleryUrl) {
    return (
      <div className="kiosk-share-card">
        <h3>Scan for all three photos</h3>
        {qr?.url === galleryUrl ? (
          <img className="kiosk-share-qr" src={qr.image} alt="QR code to view and download your three photos" width={320} height={320} />
        ) : qrError ? (
          <p role="alert">{qrError}</p>
        ) : (
          <p className="kiosk-share-loading" role="status"><LoaderCircle size={19} className="still-camera-spinner" /> Preparing your QR code…</p>
        )}
        <p>View your gallery and download all three images to your phone.</p>
        <a href={galleryUrl} target="_blank" rel="noreferrer">Open photo gallery <ArrowUpRight size={13} /></a>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="kiosk-share-card kiosk-share-pending" role="status">
        <LoaderCircle size={24} className="still-camera-spinner" />
        <h3>Getting your photos ready…</h3>
        <p>Your QR code will appear once all three photos finish uploading.</p>
      </div>
    );
  }

  if (error || sharing?.status === "failed") {
    return (
      <div className="kiosk-share-card kiosk-share-failed">
        <p role="alert">{error || sharing?.error || "We couldn’t upload your photos. They are still saved on this booth."}</p>
        <button type="button" className="kiosk-cancel" onClick={onRetry}><RefreshCw size={14} /> Retry photo upload</button>
      </div>
    );
  }

  return null;
}
