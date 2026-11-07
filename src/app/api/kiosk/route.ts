import { apiError, assertLocalRequest, readStudio } from "@/lib/studio-store";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const { settings, backgrounds, overlays } = await readStudio();
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
          b2: {
            enabled: settings.b2.enabled,
            keyId: "",
            bucketName: "",
            configured: settings.b2.configured,
          },
        },
        backgrounds,
        overlays,
        // Lets an open kiosk page notice a deploy and reload itself between guests.
        build: process.env.NEXT_PUBLIC_KIOSK_BUILD ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
