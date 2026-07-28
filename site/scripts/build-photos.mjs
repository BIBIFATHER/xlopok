#!/usr/bin/env node
/**
 * Сборка фото каталога для карточек товара.
 *
 * Вход:  site/photos-src/<slug>/*.{jpg,jpeg,png,tif,tiff,webp,heic}
 * Выход: site/public/media/catalog/<slug>/<name>-<w>.{avif,webp,jpg}
 *        site/src/data/catalog-photos.json  (манифест: размеры, srcset, blur)
 *
 * Порядок фото в карточке — по имени файла (01-..., 02-...).
 * Подписи (alt) берутся из site/photos-src/<slug>/alt.json: { "01-front.jpg": "текст" }.
 *
 * Запуск: npm run photos            (только новые/изменённые)
 *         npm run photos -- --force (пересобрать всё)
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadPipeline as loadSource } from "./photo-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(root, "photos-src");
const outRoot = path.join(root, "public", "media", "catalog");
const manifestPath = path.join(root, "src", "data", "catalog-photos.json");
const cachePath = path.join(root, "node_modules", ".cache", "hlopok-photos.json");

// Ширины под сетку карточек (1/3 от 1540px + retina) и лайтбокс (до 1040px + retina).
const WIDTHS = [480, 768, 1200, 2080];
const FORMATS = [
  { ext: "avif", options: { quality: 52, effort: 5, chromaSubsampling: "4:4:4" } },
  { ext: "webp", options: { quality: 80, effort: 5 } },
  { ext: "jpg", options: { quality: 82, progressive: true, mozjpeg: true } },
];
// Карточка кадрируется в 4:3, лайтбокс показывает кадр целиком (object-contain).
const CARD_ASPECT = 4 / 3;
// Фон страницы: им заливаем альфу, иначе JPEG получит чёрные прозрачные области.
const PAGE_BG = "#fbfaf6";
const SOURCE_EXT = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".heic", ".heif"]);

const force = process.argv.includes("--force");

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9а-я]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

async function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const heicCacheDir = path.join(root, "node_modules", ".cache");

function loadPipeline(file) {
  return loadSource(file, heicCacheDir);
}

/**
 * Средний цвет рамки кадра. Им заливаем поля при вписывании в 4:3, иначе
 * фиксированный фон даёт видимый стык с фоном самой фотографии.
 */
async function edgeColor(file) {
  const size = 24;
  const { data } = await (await loadPipeline(file))
    .rotate()
    .flatten({ background: PAGE_BG })
    .resize({ width: size, height: size, fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (x > 1 && x < size - 2 && y > 1 && y < size - 2) continue;
      const i = (y * size + x) * 3;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count += 1;
    }
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

async function fingerprint(file) {
  const info = await stat(file);
  return `${info.size}:${Math.round(info.mtimeMs)}:${WIDTHS.join()}:${FORMATS.map((f) => f.ext).join()}`;
}

async function buildPhoto({ slug, file, name, alt, index }) {
  const outDir = path.join(outRoot, slug);
  await mkdir(outDir, { recursive: true });

  const base = slugify(path.basename(name, path.extname(name))) || `photo-${index + 1}`;
  // .rotate() без аргументов = применить EXIF-ориентацию (иначе фото с телефона лежат боком).
  const source = (await loadPipeline(file)).rotate().toColorspace("srgb");
  const meta = await source.metadata();
  const srcWidth = meta.autoOrient?.width ?? meta.width;
  const srcHeight = meta.autoOrient?.height ?? meta.height;
  if (!srcWidth || !srcHeight) throw new Error(`нет размеров: ${file}`);

  const variants = {};
  const widths = WIDTHS.filter((w) => w <= srcWidth * 1.02);
  // Исходник между ступенями (например 1122 при ступенях 768 и 1200) — добавляем
  // его нативную ширину, иначе браузеру достаётся сильно уменьшенный вариант.
  if (widths.length === 0 || srcWidth > widths[widths.length - 1] * 1.1) widths.push(srcWidth);

  for (const format of FORMATS) {
    variants[format.ext] = [];
    for (const width of widths) {
      const outFile = path.join(outDir, `${base}-${width}.${format.ext}`);
      const pipeline = (await loadPipeline(file))
        .rotate()
        .flatten({ background: PAGE_BG })
        .toColorspace("srgb")
        .resize({ width, withoutEnlargement: true, fit: "inside" })
        .withMetadata({}); // EXIF/GPS вырезаем, оставляем sRGB-профиль
      await pipeline[format.ext === "jpg" ? "jpeg" : format.ext](format.options).toFile(outFile);
      const written = await sharp(outFile).metadata();
      variants[format.ext].push({
        src: `/media/catalog/${slug}/${path.basename(outFile)}`,
        width: written.width,
        height: written.height,
      });
    }
  }

  // Превью 4:3 — единая геометрия у всех товаров.
  // 160/320 нужны миниатюрам лайтбокса (80px CSS × DPR), иначе браузер тянет 480px.
  const cardWidths = [160, 320, 480, 768, 1200].filter((w) => w <= srcWidth * 1.02);
  if (cardWidths.length === 0) cardWidths.push(Math.min(srcWidth, 480));
  const card = {};
  const pad = await edgeColor(file);
  for (const format of FORMATS) {
    card[format.ext] = [];
    for (const width of cardWidths) {
      const height = Math.round(width / CARD_ASPECT);
      const outFile = path.join(outDir, `${base}-card-${width}.${format.ext}`);
      const pipeline = (await loadPipeline(file))
        .rotate()
        .flatten({ background: PAGE_BG })
        .toColorspace("srgb")
        // contain, не cover: у товарного кадра обрезка съедает край изделия.
        // Поля заливаем цветом края самого кадра — стык незаметен.
        .resize({ width, height, fit: "contain", background: pad })
        .withMetadata({});
      await pipeline[format.ext === "jpg" ? "jpeg" : format.ext](format.options).toFile(outFile);
      card[format.ext].push({ src: `/media/catalog/${slug}/${path.basename(outFile)}`, width, height });
    }
  }

  // LQIP: 20px WebP в base64 — мгновенная заглушка без запроса к сети.
  const blurBuffer = await (await loadPipeline(file))
    .rotate()
    .flatten({ background: PAGE_BG })
    .resize({ width: 20 })
    .webp({ quality: 45 })
    .toBuffer();

  return {
    id: `${slug}/${base}`,
    alt: alt || "",
    width: srcWidth,
    height: srcHeight,
    aspect: Number((srcWidth / srcHeight).toFixed(4)),
    blur: `data:image/webp;base64,${blurBuffer.toString("base64")}`,
    full: variants,
    card,
  };
}

async function main() {
  if (!existsSync(srcRoot)) {
    console.error(`Нет папки с исходниками: ${path.relative(root, srcRoot)}`);
    console.error("Создайте её и положите фото: photos-src/<slug-товара>/01-front.jpg");
    process.exit(1);
  }

  const cache = force ? {} : await readJsonIfExists(cachePath, {});
  const previous = await readJsonIfExists(manifestPath, { groups: {} });
  const nextCache = {};
  const groups = {};
  let built = 0;
  let reused = 0;

  const slugs = (await readdir(srcRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const slug of slugs) {
    const dir = path.join(srcRoot, slug);
    const altMap = await readJsonIfExists(path.join(dir, "alt.json"), {});
    const files = (await readdir(dir))
      .filter((name) => SOURCE_EXT.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));

    if (files.length === 0) continue;
    groups[slug] = [];

    for (const [index, name] of files.entries()) {
      const file = path.join(dir, name);
      const key = `${slug}/${name}`;
      const print = await fingerprint(file);
      const cachedPhoto = cache[key] === print ? previous.groups?.[slug]?.find((p) => p.source === name) : null;

      if (cachedPhoto) {
        groups[slug].push({ ...cachedPhoto, alt: altMap[name] || cachedPhoto.alt || "" });
        nextCache[key] = print;
        reused += 1;
        continue;
      }

      const photo = await buildPhoto({ slug, file, name, alt: altMap[name], index });
      groups[slug].push({ ...photo, source: name });
      nextCache[key] = print;
      built += 1;
      console.log(`✓ ${slug}/${name} → ${photo.width}×${photo.height}`);
    }
  }

  // Чистим папки товаров, которых больше нет в исходниках.
  if (existsSync(outRoot)) {
    for (const entry of await readdir(outRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !groups[entry.name]) {
        await rm(path.join(outRoot, entry.name), { recursive: true, force: true });
        console.log(`− удалено: media/catalog/${entry.name}`);
      }
    }
  }

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), widths: WIDTHS, cardAspect: CARD_ASPECT, groups }, null, 2)}\n`,
  );
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(nextCache));

  const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
  console.log(`\nГотово: ${total} фото в ${Object.keys(groups).length} группах (собрано ${built}, из кеша ${reused}).`);
  const missingAlt = Object.entries(groups).flatMap(([slug, list]) =>
    list.filter((photo) => !photo.alt).map((photo) => `${slug}/${photo.source}`),
  );
  if (missingAlt.length) {
    console.warn(`\n⚠ Нет alt-текста (${missingAlt.length}): ${missingAlt.join(", ")}`);
    console.warn("Добавьте photos-src/<slug>/alt.json — иначе SEO и доступность страдают.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
