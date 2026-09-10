import path from "node:path";
import { fileURLToPath } from "node:url";

/** Paths are anchored to this checkout, never to the shell's current directory. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const DATA_DIR = path.resolve(REPO_ROOT, process.env.FORGE_DATA_DIR || ".");

export function dataPath(...parts: string[]): string {
  return path.join(DATA_DIR, ...parts);
}
