import { apiError, assertLocalRequest, readMedia } from "@/lib/studio-store";

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    assertLocalRequest(request);
    const { path } = await context.params;
    const bytes = await readMedia(path);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
