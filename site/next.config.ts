import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Самохостинг (РФ-хостинг / Docker): минимальный сервер без node_modules.
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
