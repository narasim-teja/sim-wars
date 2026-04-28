import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist's "fake worker" loader uses dynamic ESM imports that Turbopack
  // rewrites into chunked paths it then can't resolve at runtime. Marking it
  // external keeps it as a normal Node import resolved from node_modules.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
