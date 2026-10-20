import { testB2Connection } from "@/lib/backblaze";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    return Response.json(await testB2Connection());
  } catch (error) {
    return apiError(error);
  }
}
