import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Самохостинг (РФ-хостинг / Docker): минимальный сервер без node_modules.
  output: "standalone",
  // На самохостинге нет CDN/sharp-оптимизатора → next/image тормозил и мигал пустым.
  // Картинки уже веб-размера, отдаём оригиналы из public напрямую.
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
