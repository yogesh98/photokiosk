import { deleteAlbum, renameAlbum } from "@/lib/photo-albums";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    const body = await request.json();
    return Response.json({ album: await renameAlbum(id, body?.title) });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    return Response.json(await deleteAlbum(id));
  } catch (error) {
    return apiError(error);
  }
}
