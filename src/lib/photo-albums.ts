import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ALBUM_THUMB_SIZE, renderAlbumPage, renderRemovedAlbumPage } from "./album-page";
import { uploadFolderToB2 } from "./backblaze";
import type { AlbumPhoto, PhotoAlbum } from "./kiosk-types";
import { StudioError, withAlbums } from "./studio-store";

type Fetcher = typeof fetch;

export const MAX_ALBUM_PHOTO_BYTES = 50 * 1024 * 1024;
/** Longest side of the full-size photo guests view and download. */
export const ALBUM_PHOTO_SIZE = 4096;

const folder = (album: PhotoAlbum) => `photo-albums/${album.id}`;

function albumTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value))
    throw new StudioError("Give the album a name of up to 80 characters.");
  return value.trim();
}

function find(albums: PhotoAlbum[], id: string): PhotoAlbum {
  const album = albums.find((candidate) => candidate.id === id);
  if (!album) throw new StudioError("Album not found. It may have been deleted.", 404);
  return album;
}

function sameFolder(album: PhotoAlbum, baseUrl: string) {
  if (album.baseUrl && album.baseUrl !== baseUrl)
    throw new StudioError("This album was started in a different Backblaze bucket. Create a new album to use the current bucket.", 409);
}

/** Backblaze and store errors carry messages written for Admin; anything else does not. */
async function toB2<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError("The upload to Backblaze could not finish. Please retry.", 502);
  }
}

// Publishing and deleting each rewrite index.html. Run them one at a time per
// album, so an older page can never land on top of a newer one.
const albumQueues = new Map<string, Promise<unknown>>();
async function serially<T>(id: string, action: () => Promise<T>): Promise<T> {
  const run = (albumQueues.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
  albumQueues.set(id, run);
  try {
    return await run;
  } finally {
    if (albumQueues.get(id) === run) albumQueues.delete(id);
  }
}

function downloadName(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]*$/, "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "photo"}.jpg`;
}

// Up to 100 megapixels: beyond any camera a guest or photographer brings.
const PIXEL_LIMIT = 100_000_000;

// Admin lists each failed file by name, so messages don't repeat it.
async function preparePhoto(bytes: Uint8Array) {
  const unreadable = new StudioError("This photo could not be read. Use JPEG, PNG, WebP, AVIF, or TIFF.");
  const metadata = await sharp(bytes, { limitInputPixels: PIXEL_LIMIT }).metadata().catch(() => {
    throw unreadable;
  });
  // Sharp's bundled HEIF decoder reads AVIF only, not iPhone HEIC.
  if (metadata.format === "heif" && metadata.compression !== "av1")
    throw new StudioError("HEIC photos from iPhones can't be read here. Export them as JPEG first, then upload them again.");
  if (!["jpeg", "png", "webp", "heif", "tiff"].includes(metadata.format || "") || !metadata.width || !metadata.height)
    throw unreadable;
  try {
    // rotate() applies the camera's orientation. Sharp drops the rest of the
    // metadata, including GPS location, before anything goes public.
    const full = await sharp(bytes, { limitInputPixels: PIXEL_LIMIT })
      .rotate()
      .resize(ALBUM_PHOTO_SIZE, ALBUM_PHOTO_SIZE, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88, progressive: true })
      .toBuffer({ resolveWithObject: true });
    const thumb = await sharp(full.data)
      .resize(ALBUM_THUMB_SIZE, ALBUM_THUMB_SIZE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();
    return { full: full.data, thumb, width: full.info.width, height: full.info.height };
  } catch {
    throw unreadable;
  }
}

export async function listAlbums(): Promise<PhotoAlbum[]> {
  return withAlbums((albums) => [...albums].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

export async function createAlbum(input: unknown): Promise<PhotoAlbum> {
  const title = albumTitle(input);
  return withAlbums((albums) => {
    const album: PhotoAlbum = {
      id: randomUUID(),
      title,
      createdAt: new Date().toISOString(),
      photos: [],
      revision: 0,
    };
    albums.push(album);
    return album;
  }, true);
}

/** The name only appears in Admin, so renaming leaves the published page as it is. */
export async function renameAlbum(id: string, input: unknown): Promise<PhotoAlbum> {
  const title = albumTitle(input);
  return withAlbums((albums) => {
    const album = find(albums, id);
    album.title = title;
    return album;
  }, true);
}

/**
 * Prepares one photo and uploads it with its thumbnail. Admin sends photos one
 * per request, so an album can hold any number without a giant upload.
 */
export async function addAlbumPhoto(
  id: string,
  file: File,
  orderInput: unknown,
  fetcher: Fetcher = fetch,
): Promise<PhotoAlbum> {
  const album = await withAlbums((albums) => find(albums, id));
  if (!file.size) throw new StudioError("This file is empty.");
  if (file.size > MAX_ALBUM_PHOTO_BYTES)
    throw new StudioError("This photo is larger than 50 MB.", 413);
  const order = Number(orderInput);
  const prepared = await preparePhoto(new Uint8Array(await file.arrayBuffer()));
  const photoId = randomUUID();
  const photo: AlbumPhoto = {
    id: photoId,
    name: downloadName(file.name),
    width: prepared.width,
    height: prepared.height,
    file: `photos/${photoId}.jpg`,
    thumb: `thumbs/${photoId}.jpg`,
    order: Number.isSafeInteger(order) && order >= 0 ? order : Date.now() * 1000,
    uploadedAt: new Date().toISOString(),
  };
  const baseUrl = await toB2(() => uploadFolderToB2(folder(album), [
    { name: photo.thumb, bytes: prepared.thumb, contentType: "image/jpeg" },
    { name: photo.file, bytes: prepared.full, contentType: "image/jpeg" },
  ], fetcher));
  return withAlbums((albums) => {
    const current = find(albums, id);
    sameFolder(current, baseUrl);
    current.baseUrl = baseUrl;
    current.photos.push(photo);
    current.photos.sort((a, b) => a.order - b.order);
    current.revision++;
    return current;
  }, true);
}

/** Takes a photo off the album page. Its files stay in the bucket, unlinked. */
export async function removeAlbumPhoto(id: string, photoId: string): Promise<PhotoAlbum> {
  return withAlbums((albums) => {
    const album = find(albums, id);
    if (!album.photos.some((photo) => photo.id === photoId))
      throw new StudioError("Photo not found. It may already have been removed.", 404);
    album.photos = album.photos.filter((photo) => photo.id !== photoId);
    album.revision++;
    return album;
  }, true);
}

/** Builds the album page from its current photos and uploads it as index.html. */
export async function publishAlbum(id: string, fetcher: Fetcher = fetch): Promise<PhotoAlbum> {
  return serially(id, async () => {
    const album = await withAlbums((albums) => find(albums, id));
    if (!album.baseUrl)
      throw new StudioError("Add at least one photo before publishing this album.", 422);
    const html = Buffer.from(renderAlbumPage(album), "utf8");
    const baseUrl = await toB2(() => uploadFolderToB2(folder(album), [
      { name: "index.html", bytes: html, contentType: "text/html; charset=utf-8" },
    ], fetcher));
    return withAlbums((albums) => {
      const current = find(albums, id);
      sameFolder(current, baseUrl);
      current.galleryUrl = `${baseUrl}index.html`;
      current.publishedAt = new Date().toISOString();
      // Changes made while this page uploaded still count as unpublished.
      current.publishedRevision = album.revision;
      return current;
    }, true);
  });
}

/**
 * Removes the album from Admin. A published page is replaced with a notice
 * first, because the application key can write files but not delete them.
 */
export async function deleteAlbum(id: string, fetcher: Fetcher = fetch): Promise<{ success: true; warning?: string }> {
  return serially(id, async () => {
    const album = await withAlbums((albums) => find(albums, id));
    let warning: string | undefined;
    if (album.galleryUrl) {
      const baseUrl = await toB2(() => uploadFolderToB2(folder(album), [
        { name: "index.html", bytes: Buffer.from(renderRemovedAlbumPage(), "utf8"), contentType: "text/html; charset=utf-8" },
      ], fetcher));
      // Backblaze now points at another bucket, so the old page is out of reach.
      if (baseUrl !== album.baseUrl)
        warning = "Album removed from Admin, but its page is in a different Backblaze bucket and is still online. Delete its folder in Backblaze to take it down.";
    }
    await withAlbums((albums) => {
      find(albums, id);
      albums.splice(albums.findIndex((candidate) => candidate.id === id), 1);
    }, true);
    return warning ? { success: true, warning } : { success: true };
  });
}
