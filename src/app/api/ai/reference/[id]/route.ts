import { apiError, assertLocalRequest, readBackgroundReference } from "@/lib/studio-store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    const bytes = await readBackgroundReference(id);
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": "image/png", "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'",
    } });
  } catch (error) {
    return apiError(error);
  }
}
