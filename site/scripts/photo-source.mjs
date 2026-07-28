/**
 * Чтение исходных фото с поддержкой HEIC.
 *
 * HEIC определяем по магическим байтам, а не по расширению: iPhone и выгрузки
 * из iCloud часто отдают HEIC-контейнер с именем .jpg. sharp здесь собран без
 * libheif, поэтому конвертируем через macOS sips один раз и кешируем PNG.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const HEIC_BRANDS = ["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1"];

export async function isHeic(file) {
  const handle = await open(file, "r");
  try {
    const { buffer } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    if (buffer.subarray(4, 8).toString("latin1") !== "ftyp") return false;
    return HEIC_BRANDS.includes(buffer.subarray(8, 12).toString("latin1"));
  } finally {
    await handle.close();
  }
}

export async function loadPipeline(file, cacheDir) {
  if (!(await isHeic(file))) return sharp(file, { failOn: "error" });

  const tmp = path.join(cacheDir, `heic-${createHash("sha1").update(file).digest("hex")}.png`);
  if (!existsSync(tmp)) {
    await mkdir(cacheDir, { recursive: true });
    await execFileAsync("sips", ["-s", "format", "png", file, "--out", tmp]);
  }
  return sharp(tmp, { failOn: "error" });
}
