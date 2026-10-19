import {
  apiError,
  assertLocalRequest,
  createSession,
  StudioError,
} from "@/lib/studio-store";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (Number(request.headers.get("content-length")) > 62 * 1024 * 1024)
      throw new StudioError("The photo session is too large.", 413);
    return Response.json(
      { session: await createSession(await request.json()) },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}
