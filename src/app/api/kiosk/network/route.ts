import { getKioskNetworkAddresses } from "@/lib/kiosk-network.server";
import { apiError, assertLocalRequest } from "@/lib/studio-store";

// Cache Components uses the default Node.js runtime and disallows a runtime export.
export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    return Response.json(
      { addresses: getKioskNetworkAddresses() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
