import { camera, cameraErrorResponse, cameraJpegResponse, CameraError } from "@/lib/camera-server";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function POST(request: Request) {
  try { assertLocalRequest(request); } catch (error) { return apiError(error); }
  try {
    return Response.json(await camera.startLive(request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return cameraErrorResponse(error); }
}

export async function GET(request: Request) {
  try { assertLocalRequest(request); } catch (error) { return apiError(error); }
  try {
    // Reading a stale or absent ID must never acquire USB or start a process.
    return cameraJpegResponse(camera.liveFrame(new URL(request.url).searchParams.get("id")));
  } catch (error) { return cameraErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try { assertLocalRequest(request); } catch (error) { return apiError(error); }
  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { throw new CameraError("A live preview session ID is required.", "invalid_configuration", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new CameraError("A live preview session ID is required.", "invalid_configuration", 400);
    await camera.stopLive((body as { id?: unknown }).id);
    return Response.json({ stopped: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return cameraErrorResponse(error); }
}
