import manifest from "@/data/catalog-photos.json";

export type PhotoVariant = { src: string; width: number; height: number };

export type CatalogPhoto = {
  id: string;
  source?: string;
  alt: string;
  width: number;
  height: number;
  aspect: number;
  blur: string;
  full: Record<string, PhotoVariant[]>;
  card: Record<string, PhotoVariant[]>;
};

type Manifest = {
  generatedAt?: string;
  widths?: number[];
  cardAspect?: number;
  groups: Record<string, CatalogPhoto[]>;
};

const data = manifest as Manifest;

/** Порядок важен: браузер берёт первый поддерживаемый формат. */
export const PHOTO_FORMATS = [
  { ext: "avif", type: "image/avif" },
  { ext: "webp", type: "image/webp" },
] as const;

export function photosFor(slug: string): CatalogPhoto[] {
  return data.groups?.[slug] ?? [];
}

export function srcSet(variants: PhotoVariant[] | undefined): string {
  return (variants ?? []).map((variant) => `${variant.src} ${variant.width}w`).join(", ");
}

/** Самый большой JPEG — фолбэк для <img src> и для og:image / JSON-LD. */
export function largest(variants: PhotoVariant[] | undefined): PhotoVariant | undefined {
  return (variants ?? []).reduce<PhotoVariant | undefined>(
    (best, variant) => (!best || variant.width > best.width ? variant : best),
    undefined,
  );
}

export function absoluteUrl(pathname: string, origin = "https://canvaslab.ru"): string {
  return pathname.startsWith("http") ? pathname : `${origin}${pathname}`;
}
