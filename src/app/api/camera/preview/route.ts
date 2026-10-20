import {
  camera,
  cameraErrorResponse,
  cameraJpegResponse,
} from "@/lib/camera-server";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
  } catch (error) {
    return apiError(error);
  }
  // Stale browser bundles used to poll GET once a second. They must never
  // restart the camera while the current UI requires a deliberate snapshot.
  return Response.json(
    { error: "Use the Canon preview button to request one snapshot.", code: "preview_requires_post" },
    { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
  } catch (error) {
    return apiError(error);
  }
  try {
    return cameraJpegResponse(await camera.preview(request.signal, { retry: true }));
  } catch (error) {
    return cameraErrorResponse(error);
  }
}
