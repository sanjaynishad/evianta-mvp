import type { NextConfig } from "next";

// Standalone tracing creates symlinks into the pnpm store, which Windows only permits with
// Developer Mode or elevation. Container images are built on Linux, where standalone is always on.
const standaloneSupported = process.platform !== "win32";

const nextConfig: NextConfig = {
  output: standaloneSupported ? "standalone" : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@evianta/core"],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
