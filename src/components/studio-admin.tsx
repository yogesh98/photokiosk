"use client";
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Aperture,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  CloudUpload,
  Expand,
  ImagePlus,
  Images,
  LayoutDashboard,
  Loader2,
  Mail,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { LivePreview } from "@/components/kiosk/live-preview";
import { BackgroundSequenceSettings } from "@/components/background-sequence-settings";
import { BackblazeSettings } from "@/components/backblaze-settings";
import { resolveSessionBackgrounds } from "@/lib/background-sequence";
import {
  DEFAULT_SETTINGS,
  type Background,
  type PhotoSession,
  type StudioData,
} from "@/lib/kiosk-types";
import {
  api,
  json,
  dateLabel,
  Modal,
  PageHeading,
  type CameraState,
} from "./studio-shared";
import {
  CameraSettings,
  ChromaSettings,
  EmailSettings,
  SessionModal,
  UploadModal,
} from "./studio-forms";

type Tab = "overview" | "photos" | "backgrounds" | "camera" | "email" | "storage";
const navItems = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "photos", label: "Photo gallery", icon: Images },
  { id: "backgrounds", label: "Backgrounds", icon: ImagePlus },
  { id: "camera", label: "Camera setup", icon: Camera },
  { id: "email", label: "Email delivery", icon: Mail },
  { id: "storage", label: "Backblaze B2", icon: CloudUpload },
] as const;
export function StudioAdmin() {
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<StudioData>({
    settings: DEFAULT_SETTINGS,
    backgrounds: [],
    sessions: [],
  });
  const [today, setToday] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    type: "success" | "error";
  } | null>(null);
  const [camera, setCamera] = useState<CameraState>({
    connected: false,
    available: false,
    model: null,
  });
  const [cameraChecked, setCameraChecked] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [modal, setModal] = useState<
    "upload" | "preview" | "help" | "event" | null
  >(null);
  const [selectedSession, setSelectedSession] = useState<PhotoSession | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const settings = data.settings;
  const background = data.backgrounds.find(
    (b) => b.id === settings.activeBackgroundId,
  );
  // Keep a planned backdrop available when trying replacement before saving Off → AI.
  // LivePreview still honors the actual background mode.
  const previewBackground = resolveSessionBackgrounds(
    { ...settings, backgroundMode: "green-screen" },
    data.backgrounds,
  )[0];
  const cameraConnected =
    settings.camera.mode === "canon" ? camera.connected : browserReady;
  const sentSessions = data.sessions.filter(
    (s) =>
      s.status === "sent" || s.deliveries?.some((d) => d.status === "sent"),
  ).length;
  const sent = data.sessions.reduce(
    (count, s) =>
      count +
      (s.deliveries?.filter((d) => d.status === "sent").length ??
        (s.status === "sent" ? 1 : 0)),
    0,
  );
  const photoCount = data.sessions.reduce(
    (total, s) => total + s.photos.length,
    0,
  );
  const notify = useCallback(
    (text: string, type: "success" | "error" = "success") =>
      setNotice({ text, type }),
    [],
  );
  const reload = useCallback(async () => {
    try {
      setData(await api<StudioData>("/api/studio"));
      setLoaded(true);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  const checkCamera = useCallback(async () => {
    try {
      setCamera(await api<CameraState>("/api/camera"));
    } catch (e) {
      setCamera({
        connected: false,
        available: false,
        model: null,
        error: (e as Error).message,
      });
    } finally {
      setCameraChecked(true);
    }
  }, []);
  useEffect(() => {
    let current = true;
    api<StudioData>("/api/studio")
      .then((result) => {
        if (current) {
          setData(result);
          setLoaded(true);
          setToday(
            new Date().toLocaleDateString(undefined, {
              month: "long",
              day: "numeric",
              year: "numeric",
            }),
          );
        }
      })
      .catch((e) => {
        if (current) setLoadError(e.message);
      });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 5500);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    const onFocus = () => {
      void reload();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);
  async function saveSettings(
    patch: Record<string, unknown>,
    success = "Changes saved.",
  ) {
    setBusy(true);
    try {
      await api("/api/settings", json(patch, "PATCH"));
      await reload();
      notify(success);
      return true;
    } catch (e) {
      notify((e as Error).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function activate(id: string) {
    await saveSettings(
      { activeBackgroundId: id },
      "Background is ready for your next session.",
    );
  }
  async function removeBackground(item: Background) {
    setBusy(true);
    try {
      await api(`/api/backgrounds?id=${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      await reload();
      notify("Background removed.");
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  function exportSessions() {
    const cell = (v: string) =>
      `"${(/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""')}"`;
    const csv = [
      "Session,Date,Email,Status,Background,Photos",
      ...data.sessions.map((s) =>
        [
          s.id,
          s.createdAt,
          s.deliveries
            ?.filter((d) => d.status === "sent")
            .map((d) => d.email)
            .join("; ") ||
            s.email ||
            "",
          s.status,
          s.backgroundName,
          String(s.photos.length),
        ]
          .map(cell)
          .join(","),
      ),
    ].join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "still-photo-sessions.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  const visibleSessions = data.sessions.filter(
    (s) =>
      (!query ||
        `${s.email || ""} ${s.deliveries?.map((delivery) => delivery.email).join(" ") || ""} ${s.backgroundName} ${s.id}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (filter === "all" ||
        (filter === "sent" ? s.status === "sent" : s.status !== "sent")),
  );
  return (
    <div className="studio-app">
      <aside className="studio-sidebar">
        <Link href="/" className="studio-brand">
          <Aperture strokeWidth={1.7} />
          <span>
            still<span className="brand-period">.</span>
          </span>
        </Link>
        <button
          className="workspace-selector"
          onClick={() => setModal("event")}
        >
          <span className="workspace-avatar">
            <Sparkles size={18} />
          </span>
          <span>
            <small>YOUR WORKSPACE</small>
            <strong>{settings.eventName}</strong>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="nav-label">STUDIO</div>
        <nav aria-label="Studio navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? "active" : ""}`}
              onClick={() => {
                setTab(item.id);
                setQuery("");
                setFilter("all");
              }}
            >
              <item.icon size={19} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === "photos" && photoCount > 0 && (
                <span className="nav-count">{photoCount}</span>
              )}
              {tab === item.id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <div className="note-art">
              <Aperture size={29} strokeWidth={1.2} />
              <Sparkles size={14} />
            </div>
            <strong>
              Little moments.
              <br />
              Lasting memories.
            </strong>
            <p>
              Good things happen
              <br />
              in front of the camera.
            </p>
            <Link href="/kiosk" target="_blank">
              Open your booth <ArrowUpRight size={15} />
            </Link>
          </div>
          <button className="help-link" onClick={() => setModal("help")}>
            <CircleHelp size={18} />A little help
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-profile">
            <span>Y</span>
            <div>
              <strong>Your studio</strong>
              <small>LOCAL WORKSPACE</small>
            </div>
            <button
              className="icon-button"
              aria-label="Workspace settings"
              onClick={() => setModal("event")}
            >
              <Settings2 size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="studio-workspace">
        <header className="studio-topbar">
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={13} />
            <span>{navItems.find((n) => n.id === tab)?.label}</span>
          </div>
          <div className="topbar-actions">
            <span className="local-badge">
              <span />
              Local studio
            </span>
            <Link href="/kiosk" target="_blank" className="button dark small">
              <Expand size={15} />
              Launch kiosk
              <ArrowUpRight size={15} />
            </Link>
          </div>
        </header>
        <main className="studio-main">
          {loadError && (
            <div className="inline-error">
              {loadError}
              <button onClick={reload}>Try again</button>
            </div>
          )}
          {!loaded && !loadError && (
            <div className="loading-line">
              <Loader2 className="spin" size={16} />
              Opening your studio…
            </div>
          )}
          {tab === "overview" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">LET THE GOOD TIMES ROLL</div>
                  <h1>
                    Your booth. Your kind of magic<span>.</span>
                  </h1>
                  <p>
                    A little behind-the-scenes for a lot of unforgettable
                    moments.
                  </p>
                </div>
                <span className="date-tag">
                  <span />
                  {today}
                </span>
              </div>
              <div className="overview-hero">
                <div className="hero-copy">
                  <div className="hero-eyebrow">
                    <span />
                    MADE FOR THE MOMENT
                  </div>
                  <h2>
                    Big smiles.
                    <br />
                    Beautiful memories.
                  </h2>
                  <p>
                    Set the scene, bring your people,
                    <br />
                    and let the camera do its thing.
                  </p>
                  <Link href="/kiosk" target="_blank" className="button dark">
                    Let’s make memories
                    <ArrowUpRight size={17} />
                  </Link>
                  <div className="hero-footnote">
                    <Aperture size={14} />
                    Three photos. Endless possibilities.
                  </div>
                </div>
                <div className="hero-photo">
                  <img
                    src={background?.url || "/backgrounds/coast.jpg"}
                    alt={background?.name || "Golden light on the ocean"}
                  />
                  <span className="photo-corner corner-tl" />
                  <span className="photo-corner corner-tr" />
                  <span className="photo-corner corner-bl" />
                  <span className="photo-corner corner-br" />
                  <span className="scene-live">
                    <span />
                    YOUR CURRENT SCENE
                  </span>
                  <div className="scene-caption">
                    <div>
                      <span>A CHANGE OF SCENERY</span>
                      <strong>{background?.name || "Golden coast"}</strong>
                    </div>
                    <button
                      className="scene-change"
                      onClick={() => setTab("backgrounds")}
                      aria-label="Change background"
                    >
                      <ArrowUpRight size={22} />
                    </button>
                  </div>
                  <div className="hero-sticker">
                    <Sparkles size={18} />
                    <span>
                      Oh, the places
                      <br />
                      you’ll go.
                    </span>
                  </div>
                </div>
              </div>
              <div className="stats-grid">
                {[
                  {
                    label: "Photos captured",
                    count: photoCount,
                    unit: "little keepsakes",
                    note: "Every frame, a good memory",
                    icon: Camera,
                    color: "peach",
                  },
                  {
                    label: "Photo sessions",
                    count: data.sessions.length,
                    unit: "moments made",
                    note: "Three photos in every session",
                    icon: Images,
                    color: "lavender",
                  },
                  {
                    label: "Emails sent",
                    count: sent,
                    unit: "smiles sent",
                    note:
                      sent > 0
                        ? `${Math.round((sentSessions / data.sessions.length) * 100)}% of sessions sent`
                        : "A little joy, straight to their inbox",
                    icon: Mail,
                    color: "sage",
                  },
                ].map((s) => (
                  <div className="stat-card" key={s.label}>
                    <div>
                      <span>{s.label}</span>
                      <span className={`stat-icon ${s.color}`}>
                        <s.icon size={18} />
                      </span>
                    </div>
                    <strong>
                      {s.count.toString().padStart(2, "0")}
                      <small>{s.unit}</small>
                    </strong>
                    <p>
                      <span className={`tiny-dot ${s.color}`} />
                      {s.note}
                    </p>
                  </div>
                ))}
              </div>
              <div className="dashboard-bottom">
                <section className="panel recent-panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        Fresh from the booth
                        <span className="count-badge">{photoCount}</span>
                      </h2>
                      <p>The latest moments, all in one place.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setTab("photos")}
                    >
                      View gallery
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  {data.sessions.length ? (
                    <div className="recent-sessions">
                      {data.sessions.slice(0, 3).map((s) => (
                        <button
                          key={s.id}
                          className="recent-session"
                          onClick={() => setSelectedSession(s)}
                        >
                          <img
                            src={s.photos[0]}
                            alt="First photo from session"
                          />
                          <div>
                            <strong>{s.email || "Awaiting an email"}</strong>
                            <span>{dateLabel(s.createdAt)}</span>
                          </div>
                          <span
                            className={`delivery-badge ${s.status === "sent" ? "sent" : ""}`}
                          >
                            {s.status === "sent" ? (
                              <Check size={12} />
                            ) : (
                              <Clock3 size={12} />
                            )}
                            {s.status === "sent"
                              ? "Sent"
                              : s.status === "failed"
                                ? "Failed"
                                : "Not sent"}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="gallery-empty-mini">
                      <div className="empty-photos">
                        <img
                          src="/backgrounds/mountains.jpg"
                          alt="Mountain background"
                        />
                        <img
                          src="/backgrounds/coast.jpg"
                          alt="Coastal background"
                        />
                        <span>
                          <Camera size={21} strokeWidth={1.5} />
                        </span>
                      </div>
                      <h3>Your first memory is waiting.</h3>
                      <p>
                        Once the shutter clicks, your photos will appear here.
                      </p>
                      <Link
                        href="/kiosk"
                        target="_blank"
                        className="text-button"
                      >
                        Start a photo session
                        <ArrowUpRight size={14} />
                      </Link>
                    </div>
                  )}
                </section>
                <section className="panel booth-status">
                  <div className="section-heading">
                    <div>
                      <h2>A quick check-in</h2>
                      <p>A happy booth starts here.</p>
                    </div>
                    <SlidersHorizontal size={18} />
                  </div>
                  {[
                    {
                      tab: "camera" as Tab,
                      icon: Camera,
                      title:
                        settings.camera.mode === "canon"
                          ? "Canon EOS 5D Mark IV"
                          : "Your camera",
                      note: settings.camera.mode === "canon" && !cameraChecked
                        ? "Check connection when ready"
                        : cameraConnected
                          ? settings.camera.mode === "canon" ? "Last check: connected" : "Connected and ready"
                          : "Let’s get connected",
                      good: cameraConnected,
                    },
                    {
                      tab: "email" as Tab,
                      icon: Mail,
                      title: "Email delivery",
                      note: settings.gmail.configured
                        ? settings.gmail.email
                        : "Connect your Gmail account",
                      good: settings.gmail.configured,
                    },
                    {
                      tab: "storage" as Tab,
                      icon: CloudUpload,
                      title: "QR photo sharing",
                      note: settings.b2.configured ? settings.b2.bucketName : "Connect Backblaze B2",
                      good: settings.b2.configured,
                    },
                    {
                      tab: "backgrounds" as Tab,
                      icon: ImagePlus,
                      title: "Background replacement",
                      note:
                        settings.backgroundMode === "ai"
                          ? "AI people · runs on this device"
                          : settings.backgroundMode === "green-screen"
                            ? "Green screen removal is on"
                            : "Original camera background",
                      good: settings.backgroundMode !== "off",
                    },
                  ].map((row) => (
                    <button
                      className="status-row"
                      key={row.tab}
                      onClick={() => setTab(row.tab)}
                    >
                      <span className="row-icon">
                        <row.icon size={19} />
                      </span>
                      <span>
                        <strong>{row.title}</strong>
                        <small>{row.note}</small>
                      </span>
                      <span
                        className={`connection-dot ${row.good ? "connected" : ""}`}
                      />
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  <div className="timing-note">
                    <Clock3 size={15} />
                    <span>
                      <strong>5s</strong> to get ready
                      <i />
                      <strong>3</strong> photos
                      <i />
                      <strong>3s</strong> between
                    </span>
                  </div>
                </section>
              </div>
              <section className="background-strip">
                <div className="section-heading">
                  <div>
                    <h2>Somewhere a little different</h2>
                    <p>A new scene for every good memory.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setTab("backgrounds")}
                  >
                    Explore backgrounds
                    <ArrowRight size={15} />
                  </button>
                </div>
                <div className="background-mini-grid">
                  {data.backgrounds.slice(0, 4).map((b) => (
                    <button
                      className={`background-mini ${settings.activeBackgroundId === b.id ? "selected" : ""}`}
                      key={b.id}
                      onClick={() => activate(b.id)}
                      disabled={busy}
                    >
                      <img src={b.url} alt={b.name} />
                      <div>
                        <span>{b.name}</span>
                        {settings.activeBackgroundId === b.id ? (
                          <span className="mini-selected">
                            <Check size={11} />
                            Active
                          </span>
                        ) : (
                          <ArrowUpRight size={15} />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
          {tab === "photos" && (
            <>
              <PageHeading
                eyebrow="THE MOMENTS THAT MATTER"
                title="Good times, collected."
                description="Every photo, every guest, and every little keepsake."
                action={
                  <button
                    className="button light"
                    onClick={exportSessions}
                    disabled={!data.sessions.length}
                  >
                    <ArrowDownToLine size={16} />
                    Export guest list
                  </button>
                }
              />
              <div className="gallery-toolbar">
                <div className="segmented-control">
                  {[
                    ["all", "All sessions"],
                    ["sent", "Sent"],
                    ["unsent", "Not sent"],
                  ].map(([value, label]) => (
                    <button
                      className={filter === value ? "active" : ""}
                      key={value}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                      {value === "all" && <span>{data.sessions.length}</span>}
                    </button>
                  ))}
                </div>
                <div className="gallery-search">
                  <Search size={16} />
                  <input
                    aria-label="Search photos"
                    placeholder="Find an email or background…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <button
                  className="icon-button bordered"
                  onClick={reload}
                  aria-label="Refresh photos"
                >
                  <RefreshCw size={17} />
                </button>
              </div>
              {visibleSessions.length ? (
                <div className="session-grid">
                  {visibleSessions.map((s) => (
                    <button
                      className="session-card"
                      key={s.id}
                      onClick={() => setSelectedSession(s)}
                    >
                      <div className="session-photo">
                        <img
                          src={s.photos[0]}
                          alt={`Session on ${s.backgroundName}`}
                        />
                        <span>
                          <Images size={13} />
                          {s.photos.length} photos
                        </span>
                      </div>
                      <div className="session-card-info">
                        <strong>{s.email || "No email yet"}</strong>
                        <span>{dateLabel(s.createdAt)}</span>
                        <div>
                          <small>{s.backgroundName}</small>
                          <span
                            className={`delivery-badge ${s.status === "sent" ? "sent" : ""}`}
                          >
                            {s.status === "sent"
                              ? "Sent"
                              : s.status === "failed"
                                ? "Delivery failed"
                                : "Not sent"}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="panel full-empty">
                  <span className="empty-circle">
                    <Images size={31} strokeWidth={1.3} />
                  </span>
                  <h2>
                    {query || filter !== "all"
                      ? "No moments match just yet."
                      : "Every great gallery starts with a smile."}
                  </h2>
                  <p>
                    {query || filter !== "all"
                      ? "Try another search or view all sessions."
                      : "Your captured photos and delivery details will find a home here."}
                  </p>
                  <Link className="button dark" href="/kiosk" target="_blank">
                    Open your photo booth
                    <ArrowUpRight size={16} />
                  </Link>
                </div>
              )}
            </>
          )}
          {tab === "backgrounds" && (
            <>
              <PageHeading
                eyebrow="SET THE SCENE"
                title="A world behind every smile."
                description="Choose a backdrop or bring a little something of your own."
                action={
                  <button
                    className="button dark"
                    onClick={() => setModal("upload")}
                  >
                    <Plus size={17} />
                    Upload a background
                  </button>
                }
              />
              <div className="background-info">
                <Sparkles size={18} />
                <span>
                  Keep one scene for the whole session, rotate through your
                  backgrounds, or choose a scene for each photo.
                </span>
                <button onClick={() => setModal("preview")}>
                  Preview the magic
                  <ArrowUpRight size={14} />
                </button>
              </div>
              <BackgroundSequenceSettings
                key={JSON.stringify([settings.backgroundSequence, settings.activeBackgroundId, settings.backgroundMode, data.backgrounds.map((item) => item.id)])}
                settings={settings}
                backgrounds={data.backgrounds}
                busy={busy}
                onSave={saveSettings}
              />
              <div className="backgrounds-grid">
                {data.backgrounds.map((b) => (
                  <div
                    className={`background-card ${settings.activeBackgroundId === b.id ? "active" : ""}`}
                    key={b.id}
                  >
                    <button
                      className="background-image"
                      onClick={() => activate(b.id)}
                      disabled={busy}
                    >
                      <img src={b.url} alt={b.name} />
                      {settings.activeBackgroundId === b.id && (
                        <span className="active-background-badge">
                          <Check size={13} />
                          Active background
                        </span>
                      )}
                    </button>
                    <div className="background-card-bottom">
                      <div>
                        <strong>{b.name}</strong>
                        <small>{b.category}</small>
                      </div>
                      {![
                        "coast",
                        "mountains",
                        "desert",
                        "palms",
                        "lake",
                        "studio",
                      ].includes(b.id) ? (
                        <button
                          disabled={
                            busy || settings.activeBackgroundId === b.id
                          }
                          className="icon-button"
                          onClick={() => removeBackground(b)}
                          aria-label={`Delete ${b.name}`}
                          title={
                            settings.activeBackgroundId === b.id
                              ? "Select another background before deleting"
                              : "Delete background"
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      ) : (
                        <button
                          className={`select-background ${settings.activeBackgroundId === b.id ? "selected" : ""}`}
                          disabled={busy}
                          onClick={() => activate(b.id)}
                          aria-label={`Use ${b.name}`}
                        >
                          {settings.activeBackgroundId === b.id ? (
                            <Check size={15} />
                          ) : (
                            <Plus size={15} />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  className="upload-background-card"
                  onClick={() => setModal("upload")}
                >
                  <span>
                    <ImagePlus size={27} strokeWidth={1.4} />
                  </span>
                  <strong>Your scene. Your story.</strong>
                  <p>Add your own background</p>
                  <small>JPG, PNG, or WebP · up to 10 MB</small>
                </button>
              </div>
              <ChromaSettings
                key={JSON.stringify([settings.backgroundMode, settings.aiModel, settings.aiAcceleration, settings.chroma, settings.camera, settings.activeBackgroundId, settings.backgroundSequence])}
                settings={settings}
                background={previewBackground}
                busy={busy}
                onSave={saveSettings}
              />
            </>
          )}
          {tab === "camera" && (
            <>
              <PageHeading
                eyebrow="BEHIND THE LENS"
                title="Ready for your close-up."
                description="Connect your camera, frame the shot, and find your best light."
                action={
                  <button className="button light" onClick={checkCamera}>
                    <RefreshCw size={16} />
                    Check connection
                  </button>
                }
              />
              <CameraSettings
                key={JSON.stringify(settings.camera)}
                settings={settings}
                background={previewBackground}
                camera={camera}
                cameraChecked={cameraChecked}
                busy={busy}
                onSave={saveSettings}
                onConnect={setBrowserReady}
              />
              <ChromaSettings
                key={JSON.stringify([settings.backgroundMode, settings.aiModel, settings.aiAcceleration, settings.chroma, settings.camera, settings.activeBackgroundId, settings.backgroundSequence])}
                settings={settings}
                background={previewBackground}
                busy={busy}
                onSave={saveSettings}
              />
            </>
          )}
          {tab === "email" && (
            <>
              <PageHeading
                eyebrow="SEND A LITTLE JOY"
                title="From the booth to their inbox."
                description="Connect Gmail and give every guest a memory to take home."
              />
              <EmailSettings
                key={JSON.stringify(settings.gmail)}
                settings={settings}
                busy={busy}
                onSave={saveSettings}
                notify={notify}
              />
            </>
          )}
          {tab === "storage" && (
            <>
              <PageHeading
                eyebrow="A MEMORY TO TAKE HOME"
                title="All three photos. One QR code."
                description="Connect Backblaze B2 so guests can open and download their photos on their own phones."
              />
              <BackblazeSettings
                key={JSON.stringify(settings.b2)}
                settings={settings}
                busy={busy}
                onSave={saveSettings}
                notify={notify}
              />
            </>
          )}
          <footer className="studio-footer">
            <span>Made for the moments in between.</span>
            <Aperture size={14} />
            <span>Happiness, captured.</span>
          </footer>
        </main>
      </div>
      {notice && (
        <div role="status" className={`studio-notice ${notice.type}`}>
          {notice.type === "success" ? (
            <CheckCircle2 size={18} />
          ) : (
            <CircleHelp size={18} />
          )}
          <span>{notice.text}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "upload" && (
        <UploadModal
          onClose={() => setModal(null)}
          onSuccess={async () => {
            await reload();
            setModal(null);
            notify("A new scene, ready to make memories.");
          }}
        />
      )}
      {modal === "preview" && (
        <Modal
          title="A little preview of the magic"
          wide
          onClose={() => setModal(null)}
        >
          <div className="admin-preview">
            <LivePreview settings={settings} background={previewBackground} />
          </div>
          <div className="modal-footer">
            <span>
              {settings.backgroundMode === "off"
                ? "Original camera background"
                : `Photo 1: ${previewBackground?.name || "Selected scene"} · ${settings.backgroundMode === "ai" ? "AI people" : "Green screen"}`}
            </span>
            <Link className="button dark" target="_blank" href="/kiosk">
              Launch kiosk
              <ArrowUpRight size={15} />
            </Link>
          </div>
        </Modal>
      )}
      {modal === "help" && (
        <Modal
          title="Let’s make a little magic."
          onClose={() => setModal(null)}
        >
          <div className="help-content">
            <p>Three little steps to a happy photo booth.</p>
            <ol>
              {[
                [
                  "Bring your camera.",
                  "Connect a webcam, or tether your Canon EOS 5D Mark IV over USB. Choose it in Camera setup.",
                ],
                [
                  "Set your scene.",
                  "Choose a background, then select Green screen for a physical backdrop or AI people to replace the scene on this device. Choose Off to keep your original scene.",
                ],
                [
                  "Send the smiles.",
                  "Connect Gmail with an app password, then launch the kiosk. Guests get five seconds to pose and three photos to keep.",
                ],
              ].map(([title, text], i) => (
                <li key={title}>
                  <span>0{i + 1}</span>
                  <div>
                    <strong>{title}</strong>
                    <p>{text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="soft-note">
              <Monitor size={18} />
              <p>
                Keep this studio running on the computer connected to the
                camera. Photos and settings are stored locally.
              </p>
            </div>
          </div>
        </Modal>
      )}
      {modal === "event" && (
        <Modal title="Make this space yours." onClose={() => setModal(null)}>
          <form
            className="modal-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await saveSettings({
                  eventName: new FormData(e.currentTarget).get("eventName"),
                })
              )
                setModal(null);
            }}
          >
            <label className="field">
              Workspace / event name
              <input
                required
                name="eventName"
                maxLength={80}
                defaultValue={settings.eventName}
              />
            </label>
            <p className="field-hint">
              A little name for the good times you’re making.
            </p>
            <button className="button dark" disabled={busy}>
              Save workspace
              <Check size={16} />
            </button>
          </form>
        </Modal>
      )}
      {selectedSession && (
        <SessionModal
          session={selectedSession}
          sharingEnabled={settings.b2.configured}
          onClose={() => setSelectedSession(null)}
          onUpdate={async (s) => {
            setSelectedSession(s);
            await reload();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}
