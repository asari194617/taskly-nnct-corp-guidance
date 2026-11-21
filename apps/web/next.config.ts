import type { NextConfig } from "next";

const config: NextConfig = {
  allowedDevOrigins: ["local.nnct-corp-guidance-2026.taskly.iy0306.com"],
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  productionBrowserSourceMaps: process.env.E2E_COVERAGE === "1",
};
export default config;
