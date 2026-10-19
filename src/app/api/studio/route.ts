import { apiError, assertLocalRequest, readStudio } from "@/lib/studio-store";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    return Response.json(await readStudio(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
