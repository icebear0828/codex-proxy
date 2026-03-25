/**
 * Application context container — holds config + fingerprint.
 *
 * Provides an alternative to getConfig()/getFingerprint() singletons.
 * Modules can accept AppContext as a parameter instead of importing
 * global getters, making dependencies explicit and tests simpler.
 *
 * During migration, getConfig()/getFingerprint() continue to work.
 */

import type { AppConfig, FingerprintConfig } from "./config.js";

export interface AppContext {
  readonly config: AppConfig;
  readonly fingerprint: FingerprintConfig;
}

let _context: AppContext | null = null;

export function initContext(config: AppConfig, fingerprint: FingerprintConfig): AppContext {
  _context = { config, fingerprint };
  return _context;
}

export function getContext(): AppContext {
  if (!_context) throw new Error("Context not initialized. Call initContext() first.");
  return _context;
}

/** Test-only: replace the context. */
export function setContextForTesting(ctx: AppContext): void {
  _context = ctx;
}

/** Test-only: reset context. */
export function resetContextForTesting(): void {
  _context = null;
}
