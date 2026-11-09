import { createAlbum, listAlbums } from "@/lib/photo-albums";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    return Response.json({ albums: await listAlbums() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = await request.json();
    return Response.json({ album: await createAlbum(body?.title) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
