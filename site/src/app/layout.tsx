import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin", "cyrillic"],
});

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://canvaslab.ru"),
  title: "Хлопок - холсты на подрамнике",
  description:
    "Производство холстов на подрамнике для студий, художников и оптовых клиентов по России и СНГ.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Хлопок - холсты, которые держат натяжение",
    description:
      "Холсты на подрамнике, материалы, профили, заказные позиции и проверка натяжения по звуку.",
    type: "website",
    url: "https://canvaslab.ru",
    siteName: "Хлопок",
    locale: "ru_RU",
    images: ["/media/canvas-front-surface.jpg"],
  },
};

// Schema.org — Яндекс/Google подтягивают название, контакты, логотип в карточку.
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Хлопок",
  alternateName: "CanvasLab",
  url: "https://canvaslab.ru",
  logo: "https://canvaslab.ru/apple-icon.png",
  description:
    "Производство холстов на подрамнике для студий, художников и оптовых клиентов по России и СНГ.",
  email: "sales@canvaslab.ru",
  telephone: "+79167948587",
  areaServed: "Россия и СНГ",
  sameAs: ["https://t.me/canvas_lab"],
  contactPoint: {
    "@type": "ContactPoint",
    telephone: "+79167948587",
    email: "sales@canvaslab.ru",
    contactType: "sales",
    availableLanguage: "Russian",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className={`${manrope.variable} ${cormorant.variable} h-full scroll-smooth antialiased`}>
      <body className="min-h-full">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
