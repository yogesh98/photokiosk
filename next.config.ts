import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

const nextConfig: NextConfig = {
  /* config options here */
  output: process.env.PHOTO_KIOSK_STANDALONE === "1" ? "standalone" : undefined,
  allowedDevOrigins: ["127.0.0.1", "[::1]", ...Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).filter((address) => !address.internal && address.family === "IPv4").map((address) => address.address),
  )],
  cacheComponents: true,
  partialPrefetching: true,
  // Guest photos and Gmail credentials belong to this computer, never a build artifact.
  outputFileTracingExcludes: { "*": [".data/**/*", ".deploy/**/*", ".venv-ai/**/*", "**/*.test.*"] },
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
