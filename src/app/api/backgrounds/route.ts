import {
  addBackground,
  apiError,
  assertLocalRequest,
  deleteBackground,
  StudioError,
} from "@/lib/studio-store";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (Number(request.headers.get("content-length")) > 11 * 1024 * 1024)
      throw new StudioError("Choose an image smaller than 10 MB.", 413);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new StudioError(
        "The upload could not be read. Choose an image and try again.",
      );
    }
    const file = form.get("file");
    if (!(file instanceof File))
      throw new StudioError("Choose a background image to upload.");
    const name = form.get("name") || file.name.replace(/\.[^.]+$/, "");
    return Response.json(
      { background: await addBackground(file, name) },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new StudioError("A background ID is required.");
    return Response.json(await deleteBackground(id));
  } catch (error) {
    return apiError(error);
  }
}
