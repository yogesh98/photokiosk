import { uploadSessionToB2 } from "@/lib/backblaze";
import { apiError, assertLocalRequest, StudioError } from "@/lib/studio-store";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    return Response.json({ session: await uploadSessionToB2(id) });
  } catch (error) {
    if (error instanceof StudioError && "session" in error)
      return Response.json(
        { error: error.message, session: error.session },
        { status: error.status },
      );
    return apiError(error);
  }
}
