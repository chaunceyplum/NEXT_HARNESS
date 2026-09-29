import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone (a minimal server.js plus only the node_modules
  // files the app actually uses), which the Dockerfile's runtime stage
  // copies instead of a full `npm ci`. See
  // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md.
  output: "standalone",
};

export default nextConfig;
