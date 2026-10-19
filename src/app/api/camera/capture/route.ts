import {
  camera,
  cameraErrorResponse,
  cameraJpegResponse,
} from "@/lib/camera-server";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
  } catch (error) {
    return apiError(error);
  }
  try {
    return cameraJpegResponse(await camera.capture(request.signal));
  } catch (error) {
    return cameraErrorResponse(error);
  }
}
