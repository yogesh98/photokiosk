"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight, Check, CloudUpload, Loader2, QrCode } from "lucide-react";
import type { KioskSettings } from "@/lib/kiosk-types";
import { api, json, Status, Toggle, type Notify, type SaveSettings } from "./studio-shared";

export function BackblazeSettings({ settings, busy, onSave, notify }: {
  settings: KioskSettings;
  busy: boolean;
  onSave: SaveSettings;
  notify: Notify;
}) {
  const [draft, setDraft] = useState(settings.b2);
  const [applicationKey, setApplicationKey] = useState("");
  const [testing, setTesting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSave({
      b2: {
        enabled: draft.enabled,
        keyId: draft.keyId.trim(),
        bucketName: draft.bucketName.trim(),
        ...(applicationKey ? { applicationKey } : {}),
      },
    }, "Backblaze B2 settings saved. Test the connection before opening the kiosk.")) {
      setApplicationKey("");
    }
  }

  async function test() {
    setTesting(true);
    try {
      await api("/api/storage/test", json({}));
      notify("Backblaze B2 is ready for photo sharing.");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setTesting(false);
    }
  }

  async function removeKey() {
    if (await onSave({ b2: { enabled: false, applicationKey: "" } }, "Backblaze B2 disabled and its saved key removed.")) {
      setApplicationKey("");
    }
  }

  return (
    <div className="email-layout b2-layout">
      <section className="panel email-form">
        <div className="section-heading">
          <div className="email-heading">
            <span className="gmail-icon"><CloudUpload size={24} /></span>
            <div>
              <h2>Your Backblaze B2 connection</h2>
              <p>Three photos. One easy scan.</p>
            </div>
          </div>
          <Status good={settings.b2.configured}>
            {settings.b2.configured ? "Configured" : "Not connected"}
          </Status>
        </div>
        <form onSubmit={submit}>
          <div className="setting-toggle-row">
            <div>
              <strong>Share photos with a QR code</strong>
              <p>Upload each completed session to Backblaze B2.</p>
            </div>
            <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="Enable Backblaze B2 sharing" />
          </div>
          <label className="field">
            Bucket name
            <input
              required={draft.enabled}
              maxLength={63}
              placeholder="my-photo-booth"
              value={draft.bucketName}
              onChange={(event) => setDraft({ ...draft, bucketName: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            Application key ID
            <input
              required={draft.enabled}
              maxLength={100}
              value={draft.keyId}
              onChange={(event) => setDraft({ ...draft, keyId: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            Application key
            <input
              type="password"
              value={applicationKey}
              onChange={(event) => setApplicationKey(event.target.value)}
              autoComplete="new-password"
              placeholder="Leave blank to keep a saved key"
            />
          </label>
          <p className="field-hint">
            Use a key restricted to this bucket with <code>listBuckets</code> and <code>writeFiles</code> capabilities. An optional file name prefix on the key is supported.
          </p>
          <div className="soft-note">
            <QrCode size={19} />
            <p>Use a public-read bucket. Anyone with a session link can view its photos. Each QR code opens a unique gallery to view and download all three images.</p>
          </div>
          <div className="form-actions">
            <button className="button dark" disabled={busy || testing}>
              {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              Save B2 settings
            </button>
            <button type="button" className="button light" disabled={busy || testing} onClick={() => void removeKey()}>
              Remove saved key
            </button>
          </div>
        </form>
      </section>
      <div>
        <section className="panel b2-explanation">
          <div className="eyebrow">FROM THE BOOTH TO THEIR PHONE</div>
          <QrCode size={42} strokeWidth={1.4} />
          <h3>A gallery that travels with them.</h3>
          <p>The booth runs locally. After all three photos upload, guests scan a QR code to open their gallery directly on Backblaze B2, using their own phone and internet connection.</p>
          <p>When Gmail is connected too, guests can also enter their email to receive all three photos.</p>
        </section>
        <section className="panel test-email">
          <h3>Check your connection.</h3>
          <p>Save your settings first. The test checks your key, upload access, and public bucket access.</p>
          <button type="button" className="button light" disabled={busy || testing || !settings.b2.configured} onClick={() => void test()}>
            {testing ? <Loader2 size={15} className="spin" /> : <CloudUpload size={15} />}
            {testing ? "Checking connection…" : "Test saved connection"}
            <ArrowUpRight size={14} />
          </button>
        </section>
      </div>
    </div>
  );
}
