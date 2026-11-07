import { camera, cameraErrorResponse, LIVE_STREAM_CONTENT_TYPE } from "@/lib/camera-server";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

/** Streams every new live-view frame on one response; see CameraController.liveFrameStream. */
export async function GET(request: Request) {
  try { assertLocalRequest(request); } catch (error) { return apiError(error); }
  try {
    // Reading a stale or absent ID must never acquire USB or start a process.
    const stream = camera.liveFrameStream(new URL(request.url).searchParams.get("id"), request.signal);
    return new Response(stream, {
      headers: {
        "Content-Type": LIVE_STREAM_CONTENT_TYPE,
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        // Proxies must pass frames through as they arrive.
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) { return cameraErrorResponse(error); }
}
