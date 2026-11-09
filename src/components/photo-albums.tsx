"use client";
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  BookImage,
  Check,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  ImageUp,
  Images,
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { KioskSettings, PhotoAlbum } from "@/lib/kiosk-types";
import { api, dateLabel, json, Modal, PageHeading, Status, type Notify } from "./studio-shared";

// Keep in step with preparePhoto() in src/lib/photo-albums.ts.
const EXTENSIONS = ["jpg", "jpeg", "png", "webp", "avif", "tif", "tiff"];
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/tiff"];
const ACCEPT = [...EXTENSIONS.map((extension) => `.${extension}`), ...TYPES].join(",");
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
// Each photo is resized on this computer, then sent on to Backblaze. A few at
// a time keeps both busy without holding many large files in memory.
const PARALLEL_UPLOADS = 3;

type Job = {
  key: string;
  file: File;
  order: number;
  status: "waiting" | "uploading" | "done" | "failed";
  error?: string;
};

function fileProblem(file: File): string | undefined {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (extension === "heic" || extension === "heif" || /hei[cf]/.test(file.type))
    return "HEIC photos can't be read here. Export them as JPEG first.";
  if (!TYPES.includes(file.type) && !EXTENSIONS.includes(extension))
    return "Not a JPEG, PNG, WebP, AVIF, or TIFF photo.";
  if (file.size > MAX_PHOTO_BYTES) return "Larger than 50 MB.";
  if (!file.size) return "The file is empty.";
}

/** Responses can arrive out of order. Keep the newest photos and the newest page. */
function newest(current: PhotoAlbum, incoming: PhotoAlbum): PhotoAlbum {
  const content = current.revision > incoming.revision ? current : incoming;
  const page = (current.publishedAt ?? "") > (incoming.publishedAt ?? "") ? current : incoming;
  return {
    ...content,
    baseUrl: content.baseUrl ?? page.baseUrl,
    galleryUrl: page.galleryUrl,
    publishedAt: page.publishedAt,
    publishedRevision: page.publishedRevision,
  };
}

const isBehind = (album: PhotoAlbum) =>
  Boolean(album.galleryUrl) && (album.publishedRevision ?? -1) < album.revision;
const isActive = (job: Job) => job.status === "waiting" || job.status === "uploading";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The clipboard API needs HTTPS or localhost; Admin is often opened by network IP. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("Copy failed");
  }
}

export function PhotoAlbums({
  settings,
  notify,
  onConnectStorage,
}: {
  settings: KioskSettings;
  notify: Notify;
  onConnectStorage: () => void;
}) {
  const [albums, setAlbums] = useState<PhotoAlbum[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job[]>>({});
  const [publishing, setPublishing] = useState<Record<string, boolean>>({});
  const ready = settings.b2.configured;
  const uploading = Object.values(jobs).some((list) => list.some(isActive));

  const load = useCallback(async () => {
    try {
      const result = await api<{ albums: PhotoAlbum[] }>("/api/albums");
      setAlbums((current) => result.albums.map((album) => {
        const known = current.find((candidate) => candidate.id === album.id);
        return known ? newest(known, album) : album;
      }));
      setLoaded(true);
      setLoadError("");
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    let current = true;
    api<{ albums: PhotoAlbum[] }>("/api/albums")
      .then((result) => {
        if (!current) return;
        setAlbums(result.albums);
        setLoaded(true);
      })
      .catch((error) => {
        if (current) setLoadError((error as Error).message);
      });
    return () => {
      current = false;
    };
  }, []);

  // Closing the tab mid-upload would stop the remaining photos.
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const merge = useCallback((album: PhotoAlbum) => {
    setAlbums((list) => {
      const index = list.findIndex((candidate) => candidate.id === album.id);
      if (index < 0) return [album, ...list];
      const next = [...list];
      next[index] = newest(list[index], album);
      return next;
    });
  }, []);

  const updateJob = useCallback((albumId: string, key: string, patch: Partial<Job>) => {
    setJobs((all) => ({
      ...all,
      [albumId]: (all[albumId] ?? []).map((job) => (job.key === key ? { ...job, ...patch } : job)),
    }));
  }, []);

  async function publish(albumId: string, message?: string) {
    setPublishing((all) => ({ ...all, [albumId]: true }));
    try {
      const { album } = await api<{ album: PhotoAlbum }>(`/api/albums/${albumId}/publish`, json({}));
      merge(album);
      notify(message ?? "Album page updated.");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setPublishing((all) => ({ ...all, [albumId]: false }));
    }
  }

  async function upload(albumId: string, queue: Job[]) {
    let next = 0;
    let uploaded = 0;
    const worker = async () => {
      while (next < queue.length) {
        const job = queue[next++];
        updateJob(albumId, job.key, { status: "uploading", error: undefined });
        const form = new FormData();
        form.set("file", job.file);
        form.set("order", String(job.order));
        try {
          const { album } = await api<{ album: PhotoAlbum }>(`/api/albums/${albumId}/photos`, {
            method: "POST",
            body: form,
          });
          merge(album);
          uploaded++;
          updateJob(albumId, job.key, { status: "done" });
        } catch (error) {
          updateJob(albumId, job.key, { status: "failed", error: (error as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, worker));
    // Keep failures listed for a retry; finished photos now show in the grid.
    setJobs((all) => ({ ...all, [albumId]: (all[albumId] ?? []).filter((job) => job.status !== "done") }));
    if (uploaded)
      await publish(albumId, `${plural(uploaded, "photo")} added. The album page is up to date.`);
    else
      notify("No photos were uploaded. Open the album to see why, then retry.", "error");
  }

  function addFiles(albumId: string, files: File[]) {
    if (!files.length) return;
    // Cameras number their files, so name order is usually shooting order.
    const sorted = [...files].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
    const start = Date.now() * 1000;
    const created: Job[] = sorted.map((file, index) => {
      const error = fileProblem(file);
      return { key: String(start + index), file, order: start + index, status: error ? "failed" : "waiting", error };
    });
    setJobs((all) => ({ ...all, [albumId]: [...(all[albumId] ?? []), ...created] }));
    const queue = created.filter((job) => job.status === "waiting");
    if (queue.length) void upload(albumId, queue);
    else notify("None of those files can be added. Choose JPEG, PNG, WebP, AVIF, or TIFF photos.", "error");
  }

  function retryFailed(albumId: string) {
    const retry = (jobs[albumId] ?? []).filter((job) => job.status === "failed" && !fileProblem(job.file));
    if (!retry.length) return;
    const keys = new Set(retry.map((job) => job.key));
    setJobs((all) => ({
      ...all,
      [albumId]: (all[albumId] ?? []).map((job) => (keys.has(job.key) ? { ...job, status: "waiting", error: undefined } : job)),
    }));
    void upload(albumId, retry);
  }

  function dismissFailed(albumId: string) {
    setJobs((all) => ({ ...all, [albumId]: (all[albumId] ?? []).filter((job) => job.status !== "failed") }));
  }

  async function removePhoto(album: PhotoAlbum, photoId: string) {
    if (!window.confirm("Remove this photo from the album page?")) return;
    try {
      const result = await api<{ album: PhotoAlbum }>(
        `/api/albums/${album.id}/photos?photo=${encodeURIComponent(photoId)}`,
        { method: "DELETE" },
      );
      merge(result.album);
      if (result.album.galleryUrl) await publish(album.id, "Photo removed from the album page.");
      else notify("Photo removed.");
    } catch (error) {
      notify((error as Error).message, "error");
    }
  }

  async function rename(album: PhotoAlbum, title: string) {
    try {
      const result = await api<{ album: PhotoAlbum }>(`/api/albums/${album.id}`, json({ title }, "PATCH"));
      merge(result.album);
      notify("Album renamed.");
      return true;
    } catch (error) {
      notify((error as Error).message, "error");
      return false;
    }
  }

  async function remove(album: PhotoAlbum) {
    if (jobs[album.id]?.some(isActive)) {
      notify("Wait for this album's uploads to finish before deleting it.", "error");
      return;
    }
    if (!window.confirm(
      album.galleryUrl
        ? `Delete “${album.title}”? Its link and QR code will say the album is no longer available.`
        : `Delete “${album.title}”?`,
    )) return;
    try {
      const result = await api<{ success: true; warning?: string }>(`/api/albums/${album.id}`, { method: "DELETE" });
      setAlbums((list) => list.filter((candidate) => candidate.id !== album.id));
      setOpenId(null);
      if (result.warning) notify(result.warning, "error");
      else notify(album.galleryUrl ? "Album deleted. Its link now says it's no longer available." : "Album deleted.");
    } catch (error) {
      notify((error as Error).message, "error");
    }
  }

  const open = albums.find((album) => album.id === openId);

  return (
    <>
      <PageHeading
        eyebrow="SHARE THE WHOLE EVENT"
        title="Every photo, one link."
        description="Upload as many photos as you like. Still builds the album page and publishes it to Backblaze B2."
        action={
          <button className="button dark" onClick={() => setCreating(true)} disabled={!ready}>
            <Plus size={17} />
            New album
          </button>
        }
      />
      {!ready ? (
        <div className="background-info">
          <CloudUpload size={18} />
          <span>Albums are published to your public Backblaze B2 bucket. Connect Backblaze to start one.</span>
          <button onClick={onConnectStorage}>
            Connect Backblaze
            <ArrowUpRight size={14} />
          </button>
        </div>
      ) : (
        <div className="background-info">
          <QrCode size={18} />
          <span>
            Each album gets its own page with a link and QR code. Guests can view every photo full size and download it.
          </span>
          <button onClick={() => void load()}>
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
      )}
      {loadError && (
        <div className="inline-error">
          {loadError}
          <button onClick={() => void load()}>Try again</button>
        </div>
      )}
      {!loaded && !loadError ? (
        <div className="loading-line">
          <Loader2 className="spin" size={16} />
          Finding your albums…
        </div>
      ) : albums.length ? (
        <div className="session-grid">
          {albums.map((album) => {
            const cover = album.photos[0] && album.baseUrl ? album.baseUrl + album.photos[0].thumb : "";
            const remaining = (jobs[album.id] ?? []).filter(isActive).length;
            return (
              <button className="session-card album-card" key={album.id} onClick={() => setOpenId(album.id)}>
                <div className="session-photo">
                  {cover ? (
                    <img src={cover} alt="" loading="lazy" />
                  ) : (
                    <div className="album-cover-empty">
                      <BookImage size={30} strokeWidth={1.3} />
                    </div>
                  )}
                  <span>
                    <Images size={13} />
                    {plural(album.photos.length, "photo")}
                  </span>
                </div>
                <div className="session-card-info">
                  <strong>{album.title}</strong>
                  <span>Created {dateLabel(album.createdAt)}</span>
                  <div>
                    <small>
                      {remaining
                        ? `Uploading ${remaining} more…`
                        : album.publishedAt
                          ? `Page updated ${dateLabel(album.publishedAt)}`
                          : "Not published yet"}
                    </small>
                    <span className={`delivery-badge ${album.galleryUrl && !isBehind(album) ? "sent" : ""}`}>
                      {!album.galleryUrl ? "Draft" : isBehind(album) ? "Changes pending" : "Live"}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="panel full-empty">
          <span className="empty-circle">
            <BookImage size={31} strokeWidth={1.3} />
          </span>
          <h2>Your first album is a few photos away.</h2>
          <p>Name it, drop in your photos, and share one link with everyone.</p>
          <button className="button dark" onClick={() => setCreating(true)} disabled={!ready}>
            <Plus size={16} />
            Start an album
          </button>
        </div>
      )}
      {creating && (
        <CreateAlbumModal
          onClose={() => setCreating(false)}
          onCreated={(album) => {
            merge(album);
            setCreating(false);
            setOpenId(album.id);
          }}
        />
      )}
      {open && (
        <AlbumEditor
          key={open.id}
          album={open}
          jobs={jobs[open.id] ?? []}
          publishing={Boolean(publishing[open.id])}
          ready={ready}
          notify={notify}
          onClose={() => setOpenId(null)}
          onFiles={(files) => addFiles(open.id, files)}
          onRetry={() => retryFailed(open.id)}
          onDismiss={() => dismissFailed(open.id)}
          onPublish={() => void publish(open.id)}
          onRemovePhoto={(photoId) => void removePhoto(open, photoId)}
          onRename={(title) => rename(open, title)}
          onDelete={() => void remove(open)}
        />
      )}
    </>
  );
}

function CreateAlbumModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (album: PhotoAlbum) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { album } = await api<{ album: PhotoAlbum }>("/api/albums", json({ title }));
      onCreated(album);
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Start a new album." onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label className="field">
          Album name
          <input
            required
            autoFocus
            maxLength={80}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Diwali night highlights"
          />
        </label>
        <p className="field-hint">
          Only you see this name, here in Admin. Guests see the same “Your photos” page as the booth&apos;s QR galleries.
        </p>
        {error && <div className="inline-error">{error}</div>}
        <button className="button dark" disabled={busy || !title.trim()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          Create album and add photos
        </button>
      </form>
    </Modal>
  );
}

function AlbumEditor({
  album,
  jobs,
  publishing,
  ready,
  notify,
  onClose,
  onFiles,
  onRetry,
  onDismiss,
  onPublish,
  onRemovePhoto,
  onRename,
  onDelete,
}: {
  album: PhotoAlbum;
  jobs: Job[];
  publishing: boolean;
  ready: boolean;
  notify: Notify;
  onClose: () => void;
  onFiles: (files: File[]) => void;
  onRetry: () => void;
  onDismiss: () => void;
  onPublish: () => void;
  onRemovePhoto: (photoId: string) => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState(album.title);
  const [renaming, setRenaming] = useState(false);
  const active = jobs.filter(isActive).length;
  const failed = jobs.filter((job) => job.status === "failed");
  const done = jobs.filter((job) => job.status === "done").length;
  const behind = isBehind(album);

  async function submitTitle(event: FormEvent) {
    event.preventDefault();
    setRenaming(true);
    await onRename(title.trim());
    setRenaming(false);
  }

  return (
    <Modal title={album.title} wide onClose={onClose}>
      <div className="album-editor">
        {album.galleryUrl && <AlbumShare album={album} behind={behind} notify={notify} />}
        {behind && !active && (
          <div className="album-banner">
            <TriangleAlert size={16} />
            <span>The live album page doesn&apos;t show your latest changes yet.</span>
            <button className="button dark small" disabled={publishing} onClick={onPublish}>
              {publishing ? <Loader2 size={14} className="spin" /> : <CloudUpload size={14} />}
              {publishing ? "Publishing…" : "Publish changes"}
            </button>
          </div>
        )}
        {!album.galleryUrl && album.photos.length > 0 && !active && !publishing && (
          <div className="album-banner">
            <TriangleAlert size={16} />
            <span>This album&apos;s page hasn&apos;t been published yet.</span>
            <button className="button dark small" onClick={onPublish}>
              <CloudUpload size={14} />
              Publish album
            </button>
          </div>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className={`upload-dropzone album-dropzone ${dragging ? "dragging" : ""}`}
          disabled={!ready}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            onFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <span>
            <ImageUp size={27} />
          </span>
          <strong>{album.photos.length ? "Drop more photos here" : "Drop your photos here"}</strong>
          <p>or click to choose as many as you like</p>
          <small>JPG, PNG, WebP, AVIF, or TIFF · up to 50 MB each</small>
        </button>
        {(jobs.length > 0 || publishing) && (
          <div className="album-progress" role="status">
            <div className="album-progress-head">
              <strong>
                {active
                  ? `Uploading photos… ${done + failed.length} of ${jobs.length} done`
                  : publishing
                    ? "Publishing the album page…"
                    : failed.length
                      ? `${plural(failed.length, "photo")} didn't upload`
                      : "Upload finished"}
              </strong>
              {jobs.length > 0 && (
                <span>
                  {done} uploaded{failed.length ? ` · ${failed.length} failed` : ""}
                </span>
              )}
            </div>
            {jobs.length > 0 && (
              <div className="album-progress-bar">
                <span style={{ width: `${((done + failed.length) / jobs.length) * 100}%` }} />
              </div>
            )}
            {failed.length > 0 && (
              <>
                <ul className="album-failures">
                  {failed.slice(0, 50).map((job) => (
                    <li key={job.key}>
                      <strong>{job.file.name}</strong>
                      <span>{job.error}</span>
                    </li>
                  ))}
                  {failed.length > 50 && <li>…and {failed.length - 50} more</li>}
                </ul>
                {!active && (
                  <div className="album-failure-actions">
                    {failed.some((job) => !fileProblem(job.file)) && (
                      <button className="button light small" onClick={onRetry}>
                        <RotateCcw size={14} />
                        Retry failed photos
                      </button>
                    )}
                    <button className="text-button" onClick={onDismiss}>
                      Dismiss
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <div className="album-photos-head">
          <h3>{plural(album.photos.length, "photo")}</h3>
          {album.publishedAt && <small>Page updated {dateLabel(album.publishedAt)}</small>}
        </div>
        {album.photos.length && album.baseUrl ? (
          <div className="album-photo-grid">
            {album.photos.map((photo, index) => (
              <figure className="album-photo" key={photo.id}>
                <img src={album.baseUrl + photo.thumb} alt={`Photo ${index + 1}: ${photo.name}`} loading="lazy" />
                <button
                  className="album-photo-remove"
                  aria-label={`Remove ${photo.name}`}
                  title="Remove from album"
                  onClick={() => onRemovePhoto(photo.id)}
                >
                  <Trash2 size={14} />
                </button>
              </figure>
            ))}
          </div>
        ) : (
          <p className="album-empty-note">
            No photos yet. Add some above and the album page publishes itself when they finish uploading.
          </p>
        )}
        <div className="album-settings">
          <form onSubmit={submitTitle}>
            <label className="field">
              Album name
              <input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <button
              className="button light"
              disabled={renaming || !title.trim() || title.trim() === album.title}
            >
              {renaming ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              Save name
            </button>
          </form>
          <div className="album-danger">
            <div>
              <strong>Delete album</strong>
              <p>
                Its link will say the album is no longer available. The photo files stay in your bucket; delete the
                folder <code>photo-albums/{album.id}</code> in Backblaze to remove them completely.
              </p>
            </div>
            <button className="button light" onClick={onDelete} disabled={active > 0}>
              <Trash2 size={15} />
              Delete album
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function AlbumShare({ album, behind, notify }: { album: PhotoAlbum; behind: boolean; notify: Notify }) {
  const url = album.galleryUrl!;
  const [qr, setQr] = useState({ url: "", image: "" });
  useEffect(() => {
    let current = true;
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(url, { width: 480, margin: 2, errorCorrectionLevel: "M" }))
      .then((image) => {
        if (current) setQr({ url, image });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [url]);
  const image = qr.url === url ? qr.image : "";
  const fileName = `${album.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "album"}-qr.png`;

  return (
    <section className="album-share">
      <div className="album-qr">
        {image ? <img src={image} alt="QR code that opens the album page" /> : <QrCode size={40} strokeWidth={1.2} />}
      </div>
      <div className="album-share-copy">
        <Status good={!behind}>{behind ? "Live · changes pending" : "Live"}</Status>
        <h3>Your album is online.</h3>
        <p>Anyone with this link or QR code can view and download the photos.</p>
        <input
          className="album-link"
          readOnly
          value={url}
          aria-label="Album link"
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="album-share-actions">
          <a className="button dark small" href={url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            Open album
          </a>
          <button
            className="button light small"
            onClick={() =>
              copyText(url).then(
                () => notify("Album link copied."),
                () => notify("Select the link and copy it.", "error"),
              )
            }
          >
            <Copy size={14} />
            Copy link
          </button>
          {image && (
            <a className="button light small" href={image} download={fileName}>
              <Download size={14} />
              Download QR code
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
