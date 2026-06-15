import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const STORAGE_ROOT = path.resolve(process.cwd(), "storage");

export function cvAssetDir() {
  return path.join(STORAGE_ROOT, "cv-assets");
}

export function docSetDir(docSetId: string) {
  return path.join(STORAGE_ROOT, "doc-sets", docSetId);
}

export async function writeStoredFile(filePath: string, data: Buffer) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
  return filePath;
}

// Guard against path traversal: a stored path must live under STORAGE_ROOT.
export function isInsideStorage(filePath: string) {
  const resolved = path.resolve(filePath);
  return resolved === STORAGE_ROOT || resolved.startsWith(STORAGE_ROOT + path.sep);
}
