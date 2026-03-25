/**
 * Copy root-level runtime resources into packages/electron/ before
 * electron-builder runs, so all paths resolve relative to projectDir.
 *
 * Usage:
 *   node electron/prepare-pack.mjs          # copy
 *   node electron/prepare-pack.mjs --clean  # remove copies
 */

import { cpSync, rmSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PKG = resolve(import.meta.dirname, "..");

const DIRS = ["config", "public", "bin"];
const isClean = process.argv.includes("--clean");

for (const dir of DIRS) {
  const src = resolve(ROOT, dir);
  const dest = resolve(PKG, dir);

  if (isClean) {
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true });
      console.log(`[prepare-pack] removed ${dir}/`);
    }
  } else {
    if (!existsSync(src)) {
      console.warn(`[prepare-pack] skipping ${dir}/ (not found at ${src})`);
      continue;
    }
    cpSync(src, dest, { recursive: true });
    console.log(`[prepare-pack] copied ${dir}/ → packages/electron/${dir}/`);
  }
}
