import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { unstable_rethrow } from "next/navigation";
import {
  DEFAULT_SETTINGS,
  type Background,
  type KioskSettings,
  type PhotoSession,
  type StudioData,
} from "./kiosk-types";

export class StudioError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

type SavedState = StudioData & {
  version: 1;
  gmailAppPassword: string;
  requestIds?: Record<string, string>;
};
type StoreLock = { tail: Promise<void>; initialized: boolean };
const globalStore = globalThis as typeof globalThis & {
  photoKioskLocks?: Map<string, StoreLock>;
};
const locks = (globalStore.photoKioskLocks ??= new Map<string, StoreLock>());
const BUILTIN_DATE = "2026-01-01T00:00:00.000Z";
const BUILTINS: Background[] = [
  ["coast", "Italian coast", "Travel"],
  ["mountains", "Alpine escape", "Nature"],
  ["desert", "Desert glow", "Nature"],
  ["palms", "Palm springs", "Travel"],
  ["lake", "Lakeside calm", "Nature"],
  ["studio", "Studio cream", "Studio"],
].map(([id, name, category]) => ({
  id,
  name,
  category,
  url: `/backgrounds/${id}.jpg`,
  createdAt: BUILTIN_DATE,
}));

export function dataDirectory() {
  return path.resolve(
    /* turbopackIgnore: true */ process.env.PHOTO_KIOSK_DATA_DIR ||
      path.join(process.cwd(), ".data"),
  );
}

function publicSettings(state: SavedState): KioskSettings {
  return {
    ...state.settings,
    gmail: {
      ...state.settings.gmail,
      configured: Boolean(state.gmailAppPassword && state.settings.gmail.email),
    },
  };
}

async function persist(state: SavedState, root: string) {
  const temporary = path.join(root, `.studio-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, path.join(root, "studio.json"));
    await chmod(path.join(root, "studio.json"), 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withStore<T>(
  action: (state: SavedState, root: string) => Promise<T> | T,
  write = false,
): Promise<T> {
  const root = dataDirectory();
  let lock = locks.get(root);
  if (!lock) {
    lock = { tail: Promise.resolve(), initialized: false };
    locks.set(root, lock);
  }
  const previous = lock.tail;
  let release!: () => void;
  lock.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    let state: SavedState;
    let changed = false;
    try {
      state = JSON.parse(
        await readFile(path.join(root, "studio.json"), "utf8"),
      ) as SavedState;
      if (
        state.version !== 1 ||
        !state.settings ||
        !Array.isArray(state.backgrounds) ||
        !Array.isArray(state.sessions)
      ) {
        throw new Error("Invalid photo booth data format");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new StudioError(
          "Saved booth data could not be read. Restore .data/studio.json from a backup.",
          500,
        );
      state = {
        version: 1,
        settings: structuredClone(DEFAULT_SETTINGS),
        backgrounds: structuredClone(BUILTINS),
        sessions: [],
        gmailAppPassword: "",
      };
      changed = true;
    }
    if (!lock.initialized) {
      // A process restart cannot establish whether Gmail accepted an interrupted send.
      for (const session of state.sessions)
        if (session.status === "sending") {
          session.status = "failed";
          session.error =
            "Sending was interrupted. Check the sender's Sent folder before retrying.";
          if (session.email) {
            session.deliveries ??= [];
            session.deliveries.push({
              email: session.email,
              status: "failed",
              createdAt: new Date().toISOString(),
              error: session.error,
            });
          }
          changed = true;
        }
      lock.initialized = true;
    }
    if (changed) await persist(state, root);
    const result = await action(state, root);
    if (write) await persist(state, root);
    return structuredClone(result);
  } finally {
    release();
  }
}

export async function readStudio(): Promise<StudioData> {
  return withStore((state) => ({
    settings: publicSettings(state),
    backgrounds: state.backgrounds,
    sessions: state.sessions,
  }));
}
export async function getSettings(): Promise<KioskSettings> {
  return withStore(publicSettings);
}
export async function getGmailCredentials() {
  return withStore((state) => ({
    ...publicSettings(state).gmail,
    appPassword: state.gmailAppPassword,
  }));
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StudioError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, limit: number, allowEmpty = true) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!allowEmpty && !value.trim()) ||
    /[\u0000]/.test(value)
  )
    throw new StudioError(`${name} is invalid.`);
  return value.trim();
}
function bool(value: unknown, name: string) {
  if (typeof value !== "boolean")
    throw new StudioError(`${name} must be true or false.`);
  return value;
}
function unit(value: unknown, name: string) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new StudioError(`${name} must be between 0 and 1.`);
  return value;
}
export function validateEmail(value: unknown): string {
  const email = text(value, "Email address", 254, false);
  if (
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
      email,
    )
  )
    throw new StudioError("Enter a valid email address.");
  return email;
}

export async function updateSettings(input: unknown): Promise<KioskSettings> {
  const patch = record(input, "Settings");
  return withStore((state) => {
    const settings = state.settings;
    if ("eventName" in patch)
      settings.eventName = text(patch.eventName, "Event name", 100, false);
    if ("activeBackgroundId" in patch) {
      const id = text(patch.activeBackgroundId, "Background", 100, false);
      if (!state.backgrounds.some((background) => background.id === id))
        throw new StudioError("Choose an existing background.");
      settings.activeBackgroundId = id;
    }
    if ("camera" in patch) {
      const camera = record(patch.camera, "Camera");
      if ("mode" in camera) {
        if (camera.mode !== "browser" && camera.mode !== "canon")
          throw new StudioError("Choose browser or Canon camera mode.");
        settings.camera.mode = camera.mode;
      }
      for (const key of [
        "deviceId",
        "iso",
        "aperture",
        "shutterSpeed",
      ] as const)
        if (key in camera)
          settings.camera[key] = text(
            camera[key],
            key,
            key === "deviceId" ? 1024 : 50,
          );
      if ("mirror" in camera)
        settings.camera.mirror = bool(camera.mirror, "Mirror");
    }
    if ("chroma" in patch) {
      const chroma = record(patch.chroma, "Green screen");
      if ("enabled" in chroma)
        settings.chroma.enabled = bool(chroma.enabled, "Green screen");
      for (const key of ["similarity", "smoothness", "spill"] as const)
        if (key in chroma) settings.chroma[key] = unit(chroma[key], key);
    }
    if ("gmail" in patch) {
      const gmail = record(patch.gmail, "Gmail");
      if ("email" in gmail)
        settings.gmail.email =
          gmail.email === "" ? "" : validateEmail(gmail.email);
      for (const key of ["senderName", "subject", "message"] as const)
        if (key in gmail) {
          settings.gmail[key] = text(
            gmail[key],
            key,
            key === "message" ? 5000 : 200,
          );
          if (key !== "message" && /[\r\n]/.test(settings.gmail[key]))
            throw new StudioError(`${key} must be a single line.`);
        }
      if ("appPassword" in gmail) {
        const password = text(
          gmail.appPassword,
          "Gmail app password",
          100,
        ).replace(/\s/g, "");
        if (password && !/^[a-zA-Z0-9]{16}$/.test(password))
          throw new StudioError(
            "Use the 16-character Gmail app password from your Google Account.",
          );
        // An empty password clears saved credentials. Omitting the field preserves them.
        state.gmailAppPassword = password;
      }
    }
    return publicSettings(state);
  }, true);
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
async function normalizeImage(
  bytes: Uint8Array,
  maxDimension: number,
): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new StudioError("Choose an image smaller than 10 MB.", 413);
  try {
    const image = sharp(bytes, {
      limitInputPixels: 50_000_000,
      animated: false,
    });
    const metadata = await image.metadata();
    if (
      !["jpeg", "png", "webp"].includes(metadata.format || "") ||
      !metadata.width ||
      !metadata.height
    )
      throw new Error("format");
    return await image
      .rotate()
      .resize(maxDimension, maxDimension, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new StudioError(
      "The image could not be read. Choose a valid JPEG, PNG, or WebP image.",
    );
  }
}
async function writePrivateFile(
  root: string,
  parts: string[],
  bytes: Uint8Array,
) {
  const directory = path.join(root, ...parts.slice(0, -1));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path.join(root, ...parts), bytes, {
    flag: "wx",
    mode: 0o600,
  });
}

export async function addBackground(
  file: File,
  nameInput: unknown,
): Promise<Background> {
  const name = text(nameInput, "Background name", 80, false);
  if (file.size > MAX_IMAGE_BYTES)
    throw new StudioError("Choose an image smaller than 10 MB.", 413);
  const bytes = await normalizeImage(
    new Uint8Array(await file.arrayBuffer()),
    4096,
  );
  return withStore(async (state, root) => {
    const id = randomUUID();
    const background: Background = {
      id,
      name,
      category: "Uploaded",
      url: `/api/media/backgrounds/${id}.jpg`,
      createdAt: new Date().toISOString(),
    };
    await writePrivateFile(root, ["backgrounds", `${id}.jpg`], bytes);
    state.backgrounds.push(background);
    return background;
  }, true);
}
export async function deleteBackground(id: string) {
  const result = await withStore((state) => {
    const background = state.backgrounds.find((item) => item.id === id);
    if (!background) throw new StudioError("Background not found.", 404);
    if (!background.url.startsWith("/api/media/backgrounds/"))
      throw new StudioError("Built-in backgrounds cannot be deleted.");
    state.backgrounds = state.backgrounds.filter((item) => item.id !== id);
    if (state.settings.activeBackgroundId === id)
      state.settings.activeBackgroundId = "coast";
    return { success: true, settings: publicSettings(state) };
  }, true);
  // Commit the deletion before removing pixels so a failed state write keeps the old background usable.
  await rm(path.join(dataDirectory(), "backgrounds", `${id}.jpg`), {
    force: true,
  });
  return result;
}
function decodePhoto(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 100
  )
    throw new StudioError("Photo is missing or exceeds 10 MB.", 413);
  const match =
    /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0)
    throw new StudioError("Photos must be JPEG, PNG, or WebP images.");
  return Buffer.from(match[1], "base64");
}
export async function createSession(input: unknown): Promise<PhotoSession> {
  const body = record(input, "Photo session");
  const requestId =
    "requestId" in body
      ? text(body.requestId, "Capture request ID", 128, false)
      : undefined;
  if (requestId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(requestId))
    throw new StudioError("The capture request ID is invalid.");
  if (requestId) {
    const existing = await withStore((state) =>
      state.sessions.find(
        (session) => session.id === state.requestIds?.[requestId],
      ),
    );
    if (existing) return existing;
  }
  if (!Array.isArray(body.photos) || body.photos.length !== 3)
    throw new StudioError("A session must contain exactly three photos.");
  const backgroundName = text(
    body.backgroundName,
    "Background name",
    80,
    false,
  );
  const photos = await Promise.all(
    body.photos.map((photo) => normalizeImage(decodePhoto(photo), 3000)),
  );
  if (
    photos.reduce((total, photo) => total + photo.byteLength, 0) >
    17 * 1024 * 1024
  )
    throw new StudioError(
      "These photos are too large to email. Choose a lower camera resolution.",
      413,
    );
  return withStore(async (state, root) => {
    if (requestId) {
      const existing = state.sessions.find(
        (session) => session.id === state.requestIds?.[requestId],
      );
      if (existing) return existing;
    }
    const id = randomUUID();
    const session: PhotoSession = {
      id,
      createdAt: new Date().toISOString(),
      photos: photos.map(
        (_, index) => `/api/media/sessions/${id}/${index + 1}.jpg`,
      ),
      email: null,
      status: "captured",
      backgroundName,
    };
    try {
      for (let index = 0; index < photos.length; index++)
        await writePrivateFile(
          root,
          ["sessions", id, `${index + 1}.jpg`],
          photos[index],
        );
    } catch (error) {
      await rm(path.join(root, "sessions", id), {
        recursive: true,
        force: true,
      });
      throw error;
    }
    state.sessions.unshift(session);
    if (requestId) {
      state.requestIds ??= {};
      state.requestIds[requestId] = id;
    }
    return session;
  }, true);
}
export async function beginSessionEmail(
  id: string,
  emailInput: unknown,
): Promise<PhotoSession> {
  const email = validateEmail(emailInput);
  return withStore((state) => {
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new StudioError("Photo session not found.", 404);
    if (session.status === "sending")
      throw new StudioError("This session is already being sent.", 409);
    if (session.status === "sent" && session.email === email) return session;
    if (!state.gmailAppPassword || !state.settings.gmail.email)
      throw new StudioError(
        "Gmail is not connected yet. Ask the booth host to configure it in Admin.",
        422,
      );
    if (
      session.status === "sent" &&
      session.email &&
      !session.deliveries?.length
    ) {
      // Earlier booth versions stored only one recipient and the session creation time.
      session.deliveries = [
        { email: session.email, status: "sent", createdAt: session.createdAt },
      ];
    }
    session.email = email;
    session.status = "sending";
    delete session.error;
    return session;
  }, true);
}
export async function finishSessionEmail(
  id: string,
  error?: string,
): Promise<PhotoSession> {
  return withStore((state) => {
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new StudioError("Photo session not found.", 404);
    if (session.status !== "sending" || !session.email)
      throw new StudioError(
        "This photo session has no active email attempt.",
        409,
      );
    session.status = error ? "failed" : "sent";
    session.deliveries ??= [];
    session.deliveries.push({
      email: session.email,
      status: session.status,
      createdAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    });
    if (error) session.error = error;
    else delete session.error;
    return session;
  }, true);
}

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export async function readMedia(parts: string[]): Promise<Buffer> {
  const relative = parts.join("/");
  if (
    !new RegExp(
      `^(?:backgrounds/${UUID}\\.jpg|sessions/${UUID}/[123]\\.jpg)$`,
    ).test(relative)
  )
    throw new StudioError("Image not found.", 404);
  try {
    return await readFile(
      path.join(/* turbopackIgnore: true */ dataDirectory(), ...parts),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new StudioError("Image not found.", 404);
    throw error;
  }
}

/** This desktop booth deliberately accepts loopback requests only; do not expose it on a LAN. */
export function assertLocalRequest(request: Request) {
  const url = new URL(request.url);
  const local = (hostname: string) =>
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
  const host = request.headers.get("host");
  // Next can normalize request.url to localhost even when the browser uses 127.0.0.1.
  // Validate both authorities and the port, then compare Origin to the browser's actual Host.
  let browserURL = url;
  if (host) {
    try {
      browserURL = new URL(`${url.protocol}//${host}`);
    } catch {
      throw new StudioError(
        "This booth is only available on the local computer.",
        403,
      );
    }
    if (
      browserURL.host.toLowerCase() !== host.toLowerCase() ||
      browserURL.username ||
      browserURL.password ||
      browserURL.port !== url.port
    ) {
      throw new StudioError(
        "This booth is only available on the local computer.",
        403,
      );
    }
  }
  if (!local(url.hostname) || !local(browserURL.hostname))
    throw new StudioError(
      "This booth is only available on the local computer.",
      403,
    );
  const origin = request.headers.get("origin");
  if (origin && origin !== browserURL.origin)
    throw new StudioError("Cross-origin requests are not allowed.", 403);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site")
    throw new StudioError("Cross-site requests are not allowed.", 403);
}
export function apiError(error: unknown): Response {
  unstable_rethrow(error);
  if (error instanceof StudioError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError)
    return Response.json(
      { error: "The request body is invalid." },
      { status: 400 },
    );
  console.error(
    "Photo booth request failed:",
    error instanceof Error ? error.name : "Unknown error",
  );
  return Response.json(
    {
      error:
        "The booth could not save this change. Check local disk space and try again.",
    },
    { status: 500 },
  );
}
