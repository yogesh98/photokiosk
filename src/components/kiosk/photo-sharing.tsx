"use client";
/* QR codes are generated locally as data URLs. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
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
        if (current) setQrError("The QR code could not be displayed. Please ask your host for help.");
      });
    return () => { current = false; };
  }, [galleryUrl]);

  if (galleryUrl) {
    return (
      <div className="kiosk-share-card">
        <div className="kiosk-share-code">
          {qr?.url === galleryUrl ? (
            <>
              <img className="kiosk-share-qr" src={qr.image} alt="QR code to view and download your three photos" width={320} height={320} />
              <span className="kiosk-share-scan" aria-hidden="true" />
            </>
          ) : qrError ? (
            <p role="alert">{qrError}</p>
          ) : (
            <p className="kiosk-share-loading" role="status"><LoaderCircle size={40} className="still-camera-spinner" /> Preparing your QR code…</p>
          )}
        </div>
        <div className="kiosk-share-text">
          <h3>Scan to save</h3>
          <p>Point your phone’s camera here to see and download all three photos.</p>
        </div>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="kiosk-share-card kiosk-share-pending" role="status">
        <LoaderCircle size={56} className="still-camera-spinner" />
        <div className="kiosk-share-text">
          <h3>Getting your QR code ready…</h3>
          <p>It appears as soon as all three photos finish uploading.</p>
        </div>
      </div>
    );
  }

  if (error || sharing?.status === "failed") {
    return (
      <div className="kiosk-share-card kiosk-share-failed">
        <p role="alert">{error || sharing?.error || "We couldn’t upload your photos. They are still saved on this booth."}</p>
        <button type="button" className="kiosk-secondary" onClick={onRetry}><RefreshCw size={30} strokeWidth={2.4} /> Retry photo upload</button>
      </div>
    );
  }

  return null;
}
