import { sendSessionEmail } from "@/lib/email";
import { apiError, assertLocalRequest, StudioError } from "@/lib/studio-store";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new StudioError("An email address is required.");
    return Response.json({ session: await sendSessionEmail(id, body.email) });
  } catch (error) {
    if (error instanceof StudioError && "session" in error)
      return Response.json(
        { error: error.message, session: error.session },
        { status: error.status },
      );
    return apiError(error);
  }
}
