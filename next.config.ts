import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

// Stamped into both the server and the kiosk page at build time, so an open
// kiosk can tell when the server has been redeployed and reload itself.
const buildId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_KIOSK_BUILD: buildId },
  output: process.env.PHOTO_KIOSK_STANDALONE === "1" ? "standalone" : undefined,
  allowedDevOrigins: ["127.0.0.1", "[::1]", ...Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).filter((address) => !address.internal && address.family === "IPv4").map((address) => address.address),
  )],
  cacheComponents: true,
  partialPrefetching: true,
  // Guest photos and Gmail credentials belong to this computer, never a build artifact.
  outputFileTracingExcludes: { "*": [".data/**/*", ".deploy/**/*", "**/*.test.*"] },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
