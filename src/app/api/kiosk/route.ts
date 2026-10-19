import { apiError, assertLocalRequest, readStudio } from "@/lib/studio-store";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const { settings, backgrounds } = await readStudio();
    return Response.json(
      {
        settings: {
          ...settings,
          gmail: {
            email: "",
            senderName: "",
            subject: "",
            message: "",
            configured: settings.gmail.configured,
          },
        },
        backgrounds,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
