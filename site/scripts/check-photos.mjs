#!/usr/bin/env node
/**
 * Проверка исходных фото до сборки: разрешение, резкость, экспозиция, alt-тексты.
 * Ничего не пишет — только отчёт. Запуск: npm run photos:check
 *
 * Пороги подобраны под карточку 4:3 в сетке 1540px (нужно ≥1200px на retina)
 * и под лайтбокс до 2080px.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "./photo-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const heicCacheDir = path.join(root, "node_modules", ".cache");
const source = (file) => loadPipeline(file, heicCacheDir);
const srcRoot = path.join(root, "photos-src");
const SOURCE_EXT = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".heic", ".heif"]);

const IDEAL_LONG_SIDE = 2080; // столько нужно лайтбоксу на retina
const MIN_LONG_SIDE = 1200; // ниже — мылит уже в превью карточки
const MIN_SHORT_SIDE = 900; // 1200 / (4/3) — минимум для кропа превью
// Калибровка на реальных фото проекта: размытый контроль = 0.9, нормальные кадры = 2.2…6.2.
const MIN_SHARPNESS = 1.5; // ниже — брак
const SOFT_SHARPNESS = 2.6; // ниже — мягко, стоит перещёлкнуть
const EXPOSURE_RANGE = [58, 208]; // средняя яркость: ниже — темно, выше — выбитые света
const MAX_BYTES = 25 * 1024 * 1024;

const problems = [];
const warnings = [];

async function tileEnergy(file, left, top, side) {
  // Лапласиан в нативном разрешении: ресайз убивает высокие частоты и любое
  // фото выглядит смазанным.
  const { data, info } = await (await source(file))
    .rotate()
    // Альфу нужно убрать до свёртки: по прозрачному каналу лапласиан даёт ноль
    // и любое PNG с альфой выглядит смазанным.
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .extract({ left, top, width: side, height: side })
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  return sum / (info.width * info.height);
}

async function sharpness(file) {
  // Максимум по сетке 3×3, а не центр: у товарного кадра центр — ровное полотно
  // без деталей, и одиночный центральный замер даёт ложный «смаз».
  const meta = await (await source(file)).metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  const side = Math.min(500, width, height);
  if (side < 32) return 0;

  let best = 0;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const left = Math.round(((width - side) / 2) * col);
      const top = Math.round(((height - side) / 2) * row);
      best = Math.max(best, await tileEnergy(file, left, top, side));
    }
  }
  return best;
}

async function main() {
  if (!existsSync(srcRoot)) {
    console.error(`Нет папки ${path.relative(root, srcRoot)} — положите фото в photos-src/<slug>/`);
    process.exit(1);
  }

  const slugs = (await readdir(srcRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let checked = 0;

  for (const slug of slugs) {
    const dir = path.join(srcRoot, slug);
    let altMap = {};
    try {
      altMap = JSON.parse(await readFile(path.join(dir, "alt.json"), "utf8"));
    } catch {
      warnings.push(`${slug}: нет alt.json`);
    }

    const files = (await readdir(dir))
      .filter((name) => SOURCE_EXT.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));

    if (files.length === 0) {
      // Пустая папка = фото ещё не сняты. Карточка покажет легаси-картинку, это не брак.
      warnings.push(`${slug}: фото не загружены`);
      continue;
    }
    if (files.length < 3) warnings.push(`${slug}: ${files.length} фото (нужно ≥3: лицо, угол/торец, изнутри)`);

    for (const name of files) {
      const file = path.join(dir, name);
      const label = `${slug}/${name}`;
      checked += 1;

      let meta;
      try {
        meta = await (await source(file)).metadata();
      } catch (error) {
        problems.push(`${label}: не читается (${error.message})`);
        continue;
      }

      const width = meta.autoOrient?.width ?? meta.width ?? 0;
      const height = meta.autoOrient?.height ?? meta.height ?? 0;
      const longSide = Math.max(width, height);
      const shortSide = Math.min(width, height);

      if (longSide < MIN_LONG_SIDE || shortSide < MIN_SHORT_SIDE) {
        problems.push(`${label}: ${width}×${height} — мало даже для превью, нужно от ${MIN_LONG_SIDE}×${MIN_SHORT_SIDE}`);
      } else if (longSide < IDEAL_LONG_SIDE) {
        warnings.push(`${label}: ${width}×${height} — превью ок, но лайтбоксу нужно ${IDEAL_LONG_SIDE}px по длинной стороне`);
      }
      if (meta.size && meta.size > MAX_BYTES) warnings.push(`${label}: ${(meta.size / 1e6).toFixed(1)} МБ — тяжело`);
      if (meta.space && meta.space !== "srgb" && meta.space !== "rgb") {
        warnings.push(`${label}: цветовое пространство ${meta.space} — конвертируется в sRGB при сборке`);
      }
      if (!altMap[name]) warnings.push(`${label}: нет alt-текста в alt.json`);

      try {
        const value = await sharpness(file);
        if (value < MIN_SHARPNESS) problems.push(`${label}: смазано или не в фокусе (резкость ${value.toFixed(1)})`);
        else if (value < SOFT_SHARPNESS) warnings.push(`${label}: мягкая резкость (${value.toFixed(1)}) — проверьте зерно`);
      } catch {
        warnings.push(`${label}: резкость не измерена`);
      }

      try {
        const stats = await (await source(file)).rotate().stats();
        const mean = stats.channels.slice(0, 3).reduce((sum, ch) => sum + ch.mean, 0) / 3;
        if (mean < EXPOSURE_RANGE[0]) warnings.push(`${label}: темновато (яркость ${mean.toFixed(0)})`);
        if (mean > EXPOSURE_RANGE[1]) warnings.push(`${label}: пересвет (яркость ${mean.toFixed(0)})`);
      } catch {
        /* статистика не критична */
      }
    }
  }

  console.log(`Проверено фото: ${checked} в ${slugs.length} группах.\n`);
  for (const item of warnings) console.warn(`⚠ ${item}`);
  for (const item of problems) console.error(`✗ ${item}`);
  if (problems.length === 0 && warnings.length === 0) console.log("Всё чисто.");
  if (problems.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
