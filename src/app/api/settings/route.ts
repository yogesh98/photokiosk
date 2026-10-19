import {
  apiError,
  assertLocalRequest,
  updateSettings,
} from "@/lib/studio-store";

export async function PATCH(request: Request) {
  try {
    assertLocalRequest(request);
    if (Number(request.headers.get("content-length")) > 32_000)
      return Response.json(
        { error: "Settings are too large." },
        { status: 413 },
      );
    return Response.json({
      settings: await updateSettings(await request.json()),
    });
  } catch (error) {
    return apiError(error);
  }
}
