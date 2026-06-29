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
  openGraph: {
    title: "Хлопок - холсты, которые держат натяжение",
    description:
      "Холсты на подрамнике, материалы, профили, заказные позиции и проверка натяжения по звуку.",
    type: "website",
    images: ["/media/canvas-front-surface.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className={`${manrope.variable} ${cormorant.variable} h-full scroll-smooth antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
