"use client";

import { useEffect, useRef, useState } from "react";
import { PHOTO_FORMATS, largest, srcSet, type CatalogPhoto } from "@/lib/photos";

type Props = {
  photo: CatalogPhoto;
  /** "card" — кроп 4:3 для превью, "full" — исходная геометрия для лайтбокса. */
  variant: "card" | "full";
  sizes: string;
  className?: string;
  /** Первое фото первой карточки грузим сразу — остальные лениво. */
  priority?: boolean;
  alt?: string;
};

/**
 * Отдаёт готовый srcset из манифеста (npm run photos).
 * next/image здесь не используем: images.unoptimized = true на самохостинге,
 * поэтому он вернул бы один оригинальный файл без адаптивных размеров.
 */
export default function CatalogPhoto({ photo, variant, sizes, className = "", priority = false, alt }: Props) {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const set = variant === "card" ? photo.card : photo.full;

  // Картинка из кеша успевает загрузиться до гидрации, и onLoad уже не сработает —
  // заглушка висела бы поверх навсегда. Досматриваем состояние вручную.
  useEffect(() => {
    if (imgRef.current?.complete) setLoaded(true);
  }, [photo.id, variant]);

  const fallback = largest(set.jpg);
  if (!fallback) return null;

  return (
    <>
      {/* Блюр-заглушка из base64: перекрывает белый прямоугольник до загрузки. */}
      <span
        aria-hidden
        className={`absolute inset-0 bg-cover bg-center transition-opacity duration-500 ${loaded ? "opacity-0" : "opacity-100"}`}
        style={{ backgroundImage: `url(${photo.blur})`, filter: "blur(12px)", transform: "scale(1.06)" }}
      />
      <picture>
        {PHOTO_FORMATS.map((format) =>
          set[format.ext]?.length ? (
            <source key={format.ext} type={format.type} srcSet={srcSet(set[format.ext])} sizes={sizes} />
          ) : null,
        )}
        <img
          ref={imgRef}
          src={fallback.src}
          srcSet={srcSet(set.jpg)}
          sizes={sizes}
          width={fallback.width}
          height={fallback.height}
          alt={alt ?? photo.alt}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding={priority ? "sync" : "async"}
          onLoad={() => setLoaded(true)}
          className={`absolute inset-0 h-full w-full ${className}`}
        />
      </picture>
    </>
  );
}
