import { sendTestEmail } from "@/lib/email";
import { apiError, assertLocalRequest, StudioError } from "@/lib/studio-store";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new StudioError("A test recipient is required.");
    return Response.json(await sendTestEmail(body.email));
  } catch (error) {
    return apiError(error);
  }
}
