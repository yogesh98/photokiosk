import { camera, cameraErrorResponse } from "@/lib/camera-server";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
  } catch (error) {
    return apiError(error);
  }
  try {
    return Response.json(await camera.getStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return cameraErrorResponse(error);
  }
}
