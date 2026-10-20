import { NativeAiError, nativeAi, readNativeAiRequest } from "@/lib/native-ai";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const input = await readNativeAiRequest(request);
    const result = await nativeAi.request(input, request.signal);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof NativeAiError) {
      return Response.json({ error: error.message, code: error.code }, {
        status: error.status, headers: { "Cache-Control": "no-store" },
      });
    }
    return apiError(error);
  }
}
