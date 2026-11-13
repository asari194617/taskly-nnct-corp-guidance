import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  productionBrowserSourceMaps: process.env.E2E_COVERAGE === "1",
};
export default config;
