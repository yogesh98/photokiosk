import { publishAlbum } from "@/lib/photo-albums";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    return Response.json({ album: await publishAlbum(id) });
  } catch (error) {
    return apiError(error);
  }
}
