import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "../db.js";
import { cvAssetDir, writeStoredFile } from "./fileStore.js";

const run = promisify(execFile);
const PHOTO_KEY = "profilePhotoPath";

export async function savePhoto(buffer: Buffer, ext: string) {
  const safeExt = /^(jpg|jpeg|png|webp|heic|gif)$/i.test(ext) ? ext.toLowerCase() : "jpg";
  const filePath = path.join(cvAssetDir(), `profile-photo.${safeExt}`);
  await writeStoredFile(filePath, buffer);
  await prisma.appSetting.upsert({
    where: { key: PHOTO_KEY },
    update: { value: filePath },
    create: { key: PHOTO_KEY, value: filePath }
  });
  return filePath;
}

export async function getPhotoPath(): Promise<string | null> {
  const setting = await prisma.appSetting.findUnique({ where: { key: PHOTO_KEY } });
  if (setting?.value && existsSync(setting.value)) return setting.value;
  return null;
}

// Produce a centered square JPEG of the given pixel size from the stored photo,
// using macOS `sips`. Returns null if no photo or sips is unavailable.
export async function makeSquareJpeg(size: number): Promise<Buffer | null> {
  const source = await getPhotoPath();
  if (!source) return null;

  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(path.join(os.tmpdir(), "cvphoto-"));
    const out = path.join(workDir, "photo.jpg");
    // First convert to jpeg copy.
    await run("sips", ["-s", "format", "jpeg", source, "--out", out]);
    // Measure, crop to a centered square, then resize to the target size.
    const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    const side = Math.min(width || size, height || size);
    if (side > 0) {
      await run("sips", ["-c", String(side), String(side), out]);
    }
    await run("sips", ["-z", String(size), String(size), out]);
    return await readFile(out);
  } catch {
    return null;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
