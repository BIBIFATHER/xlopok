import type { MetadataRoute } from "next";

const siteUrl = "https://canvaslab.ru";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // /v1 и /v2 — дубли главной, закрываем от индексации.
      disallow: ["/v1", "/v2"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
