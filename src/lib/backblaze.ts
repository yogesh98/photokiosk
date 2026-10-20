import { renderPhotoGallery } from "./photo-gallery";
import { createHash } from "node:crypto";
import {
  beginSessionShare,
  finishSessionShare,
  getB2Credentials,
  getSettings,
  readMedia,
  StudioError,
} from "./studio-store";

type Fetcher = typeof fetch;
type Connection = {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  bucketId: string;
  bucketName: string;
  namePrefix: string;
};
type UploadTarget = { uploadUrl: string; authorizationToken: string };

// Errors returned by B2 can echo request details. Only these locally written
// messages are ever persisted or returned to the browser.
class B2Error extends StudioError {
  constructor(message: string, public readonly retryable = false) {
    super(message, 502);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new B2Error("Backblaze returned an unexpected response. Please retry.");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value))
    throw new B2Error("Backblaze returned an unexpected response. Please retry.");
  return value;
}

function backblazeURL(value: unknown, upload = false): string {
  try {
    const url = new URL(string(value));
    // Current upload pods use backblaze.com; account and download endpoints
    // use backblazeb2.com. Never send a token to an arbitrary returned host.
    if (
      url.protocol !== "https:" || url.username || url.password || url.port ||
      url.hash || !(
        url.hostname.endsWith(".backblazeb2.com") ||
        (upload && /^pod-[a-z0-9-]+\.backblaze\.com$/.test(url.hostname))
      ) || (!upload && (url.pathname !== "/" || url.search))
    ) throw new Error("Untrusted endpoint");
    return upload ? url.href : url.origin;
  } catch {
    throw new B2Error("Backblaze returned an invalid service address. Check the connection and retry.");
  }
}

async function request(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeout = 20_000,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new B2Error("Backblaze could not be reached. Check the internet connection, then retry.", true);
  }
}

function responseError(response: Response): B2Error {
  if (response.status === 401)
    return new B2Error("Backblaze sign-in failed. Check the application key ID and application key in Admin.", true);
  if (response.status === 403)
    return new B2Error("Backblaze denied access. Use a key with listBuckets and writeFiles permissions for the selected bucket.");
  if (response.status === 429 || response.status === 408 || response.status >= 500)
    return new B2Error("Backblaze is temporarily unavailable. Please retry the upload.", true);
  return new B2Error("Backblaze did not accept the request. Check the bucket name and application key permissions in Admin.");
}

async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw responseError(response);
  try {
    return object(await response.json());
  } catch (error) {
    if (error instanceof B2Error) throw error;
    throw new B2Error("Backblaze returned an unexpected response. Please retry.");
  }
}

async function api(
  connection: Pick<Connection, "apiUrl" | "authorizationToken">,
  operation: string,
  body: Record<string, unknown>,
  fetcher: Fetcher,
) {
  return json(await request(fetcher, `${connection.apiUrl}/b2api/v4/${operation}`, {
    method: "POST",
    headers: { Authorization: connection.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function connect(fetcher: Fetcher): Promise<Connection> {
  const credentials = await getB2Credentials();
  if (!credentials.configured)
    throw new StudioError("Save a Backblaze bucket name, application key ID, and application key in Admin first.", 422);
  const authorization = await json(await request(fetcher,
    "https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
      method: "GET",
      headers: { Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.applicationKey}`).toString("base64")}` },
    }));
  const storage = object(object(authorization.apiInfo).storageApi);
  const allowed = object(storage.allowed);
  const capabilities = allowed.capabilities;
  if (!Array.isArray(capabilities) || !["listBuckets", "writeFiles"].every((capability) => capabilities.includes(capability)))
    throw new B2Error("Use a Backblaze application key with listBuckets and writeFiles permissions for the selected bucket.");
  const connection = {
    accountId: string(authorization.accountId),
    authorizationToken: string(authorization.authorizationToken),
    apiUrl: backblazeURL(storage.apiUrl),
    downloadUrl: backblazeURL(storage.downloadUrl),
  };
  // Passing the name is required for keys restricted to one or more buckets.
  const result = await api(connection, "b2_list_buckets", {
    accountId: connection.accountId,
    bucketName: credentials.bucketName,
  }, fetcher);
  const buckets = result.buckets;
  const bucket = Array.isArray(buckets)
    ? buckets.map(object).find((candidate) => candidate.bucketName === credentials.bucketName)
    : undefined;
  if (!bucket)
    throw new B2Error("The Backblaze bucket was not found. Check its exact name and that the application key can access it.");
  if (bucket.bucketType !== "allPublic")
    throw new B2Error("QR galleries require a public Backblaze bucket. Choose a public bucket so guests can open their photos without this local computer.");
  const namePrefix = allowed.namePrefix == null || allowed.namePrefix === "" ? "" : string(allowed.namePrefix);
  if (
    namePrefix.startsWith("/") || namePrefix.includes("\\") ||
    namePrefix.split("/").some((part) => part === "." || part === "..") ||
    Buffer.byteLength(namePrefix, "utf8") > 800
  )
    throw new B2Error("This application key's file-name prefix cannot be used for photo galleries. Choose a simple folder prefix, such as photo-booth/.");
  return {
    ...connection,
    bucketId: string(bucket.bucketId),
    bucketName: credentials.bucketName,
    namePrefix,
  };
}

async function uploadTarget(connection: Connection, fetcher: Fetcher): Promise<UploadTarget> {
  const target = await api(connection, "b2_get_upload_url", { bucketId: connection.bucketId }, fetcher);
  return {
    uploadUrl: backblazeURL(target.uploadUrl, true),
    authorizationToken: string(target.authorizationToken),
  };
}

async function upload(
  connection: Connection,
  target: UploadTarget,
  fileName: string,
  bytes: Uint8Array,
  contentType: string,
  disposition: string,
  fetcher: Fetcher,
): Promise<UploadTarget> {
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await json(await request(fetcher, target.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: target.authorizationToken,
          "Content-Type": contentType,
          "Content-Length": String(bytes.byteLength),
          "X-Bz-File-Name": encodeURIComponent(fileName),
          "X-Bz-Content-Sha1": sha1,
          "X-Bz-Info-b2-content-disposition": encodeURIComponent(disposition),
          "X-Bz-Info-b2-cache-control": encodeURIComponent("private, max-age=0, no-cache"),
        },
        body: new Uint8Array(bytes),
      }, 90_000));
      if (result.fileName !== fileName || result.contentSha1 !== sha1 || Number(result.contentLength) !== bytes.byteLength)
        throw new B2Error("Backblaze did not confirm the uploaded file correctly. Please retry the upload.");
      return target;
    } catch (error) {
      if (!(error instanceof B2Error) || !error.retryable || attempt > 0) throw error;
      // Upload URLs/tokens can expire or point at a temporarily unavailable pod.
      target = await uploadTarget(connection, fetcher);
    }
  }
  throw new B2Error("Backblaze did not confirm uploading. Please retry.");
}

function publicURL(connection: Connection, fileName: string): string {
  return `${connection.downloadUrl}/file/${encodeURIComponent(connection.bucketName)}/${fileName.split("/").map(encodeURIComponent).join("/")}`;
}

export async function testB2Connection(fetcher: Fetcher = fetch) {
  const connection = await connect(fetcher);
  await uploadTarget(connection, fetcher);
  return { success: true, message: "Backblaze is connected. The public bucket is ready for photo galleries." };
}

export async function uploadSessionToB2(id: string, fetcher: Fetcher = fetch) {
  const session = await beginSessionShare(id);
  if (session.sharing?.status === "uploaded") return session;
  try {
    const connection = await connect(fetcher);
    const settings = await getSettings();
    const prefix = connection.namePrefix;
    const directory = `${prefix}${prefix && !prefix.endsWith("/") ? "/" : ""}photo-booth/${session.id}/`;
    const photos = await Promise.all(session.photos.map((url) =>
      readMedia(url.replace("/api/media/", "").split("/")),
    ));
    let target = await uploadTarget(connection, fetcher);
    for (let index = 0; index < photos.length; index++)
      target = await upload(connection, target, `${directory}${index + 1}.jpg`, photos[index], "image/jpeg", "inline", fetcher);
    // A gallery is published only once all three photos are ready.
    await upload(connection, target, `${directory}index.html`, Buffer.from(renderPhotoGallery(settings.eventName), "utf8"), "text/html; charset=utf-8", "inline", fetcher);
    return await finishSessionShare(id, {
      galleryUrl: publicURL(connection, `${directory}index.html`),
      photoUrls: photos.map((_, index) => publicURL(connection, `${directory}${index + 1}.jpg`)),
    });
  } catch (error) {
    const message = error instanceof B2Error || error instanceof StudioError
      ? error.message
      : "The photo gallery could not be uploaded to Backblaze. Please retry.";
    const failed = await finishSessionShare(id, { error: message });
    throw Object.assign(new StudioError(message, 502), { session: failed });
  }
}
