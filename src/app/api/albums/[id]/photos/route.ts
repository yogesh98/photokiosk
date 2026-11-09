import { addAlbumPhoto, MAX_ALBUM_PHOTO_BYTES, removeAlbumPhoto } from "@/lib/photo-albums";
import { apiError, assertLocalRequest, StudioError } from "@/lib/studio-store";

type Context = { params: Promise<{ id: string }> };

/** One photo per request: Admin sends an album's photos a few at a time. */
export async function POST(request: Request, context: Context) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    if (Number(request.headers.get("content-length")) > MAX_ALBUM_PHOTO_BYTES + 1024 * 1024)
      throw new StudioError("Choose photos smaller than 50 MB each.", 413);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new StudioError("The upload could not be read. Choose the photo and try again.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new StudioError("Choose a photo to upload.");
    return Response.json(
      { album: await addAlbumPhoto(id, file, form.get("order")) },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    const photo = new URL(request.url).searchParams.get("photo");
    if (!photo) throw new StudioError("A photo ID is required.");
    return Response.json({ album: await removeAlbumPhoto(id, photo) });
  } catch (error) {
    return apiError(error);
  }
}
