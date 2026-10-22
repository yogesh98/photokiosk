import { MAX_BACKGROUND_REFERENCE_BODY_BYTES } from "@/lib/background-reference";
import { apiError, assertLocalRequest, saveBackgroundReference, StudioError } from "@/lib/studio-store";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (Number(request.headers.get("content-length")) > MAX_BACKGROUND_REFERENCE_BODY_BYTES)
      throw new StudioError("Capture a reference image smaller than 3 MB.", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new StudioError("Capture an empty background image first.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BACKGROUND_REFERENCE_BODY_BYTES) {
          await reader.cancel();
          throw new StudioError("Capture a reference image smaller than 3 MB.", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let form: FormData;
    try {
      const body = Buffer.concat(chunks);
      form = await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData();
    } catch {
      throw new StudioError("The reference image could not be read. Capture the empty background again.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new StudioError("Capture an empty background image first.");
    return Response.json({ settings: await saveBackgroundReference(file, form.get("cameraKey")) }, {
      status: 201, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
