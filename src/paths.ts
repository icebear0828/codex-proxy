/**
 * Centralized path management for CLI and Electron modes.
 *
 * CLI mode (default): all paths relative to process.cwd().
 * Electron mode: paths set by setPaths() before backend imports.
 */

import { resolve } from "path";

interface PathConfig {
  rootDir: string;
  configDir: string;
  dataDir: string;
  binDir: string;
  publicDir: string;
}

let _paths: PathConfig | null = null;

/**
 * Set custom paths (called by Electron main process before importing backend).
 * Must be called before any getXxxDir() calls.
 */
export function setPaths(config: PathConfig): void {
  _paths = config;
}

/** App root directory (where package.json lives). */
export function getRootDir(): string {
  return _paths?.rootDir ?? process.cwd();
}

/** Directory containing YAML config files. */
export function getConfigDir(): string {
  return _paths?.configDir ?? resolve(process.cwd(), "config");
}

/** Directory for runtime data (accounts.json, cookies.json, etc.). */
export function getDataDir(): string {
  return _paths?.dataDir ?? resolve(process.cwd(), "data");
}

/** Directory for curl-impersonate binaries. */
export function getBinDir(): string {
  return _paths?.binDir ?? resolve(process.cwd(), "bin");
}

/** Directory for static web assets (Vite build output). */
export function getPublicDir(): string {
  return _paths?.publicDir ?? resolve(process.cwd(), "public");
}

/** Whether running in embedded mode (Electron). */
export function isEmbedded(): boolean {
  return _paths !== null;
}
