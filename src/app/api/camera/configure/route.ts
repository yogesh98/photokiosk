import { camera, cameraErrorResponse, CameraError } from "@/lib/camera-server";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
  } catch (error) {
    return apiError(error);
  }
  try {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      throw new CameraError(
        "Provide camera settings as JSON.",
        "invalid_configuration",
        400,
      );
    }
    await camera.configure(value);
    return Response.json(
      { success: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return cameraErrorResponse(error);
  }
}
