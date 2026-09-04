/**
 * Centralized path management for CLI and Electron modes.
 *
 * CLI mode (default): all paths relative to process.cwd().
 * Electron/packaged mode: paths set by setPaths() before backend imports.
 */

import { resolve } from "path";

interface PathConfig {
  rootDir: string;
  configDir: string;
  dataDir: string;
  binDir: string;
  publicDir: string;
  /** Whether this path set belongs to the Electron shell. */
  embedded?: boolean;
  /** Identifies the no-Node Lite distribution without affecting CLI mode. */
  distribution?: "lite";
}

let _paths: PathConfig | null = null;

/**
 * Set custom paths (called by Electron or a packaged CLI launcher).
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

/** Whether running inside the Electron shell. */
export function isEmbedded(): boolean {
  // Existing Electron callers do not pass `embedded`, so preserve their
  // historical behavior while allowing packaged CLI launchers to set paths
  // without being misclassified as Electron.
  return _paths?.embedded ?? (_paths !== null);
}

/** Whether the backend is running from the No-Node Lite distribution. */
export function isLite(): boolean {
  return _paths?.distribution === "lite";
}
